// Drives the flac-processor AudioWorkletProcessor directly (stubbed worklet
// globals): shared play ring reads, the seek fence, splice clock, end-of-stream,
// varispeed and the projectM tap.
import { beforeAll, describe, expect, it } from 'vitest';
import type { FlacProcessorOutbound } from '../src/audio/worklets/flacProcessorMessages';
import {
  createPlayRing,
  playRingPush,
  playRingReadPos,
  playRingSetEnded,
  playRingWritePos,
  type PlayRing,
} from '../src/audio/worklets/playRingSAB';

const RATE = 1000; // 100 frames per position tick
const Q = 128;

type Processor = {
  onMessage(msg: unknown): void;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
};
let FlacProcessor: new (options: AudioWorkletNodeOptions) => Processor;

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.sampleRate = RATE;
  g.AudioWorkletProcessor = class {
    readonly sent: FlacProcessorOutbound[] = [];
    readonly port = {
      onmessage: null as unknown,
      postMessage: (msg: FlacProcessorOutbound) => { this.sent.push(msg); },
    };
  };
  g.registerProcessor = () => {};
  ({ FlacProcessor } = await import('../src/audio/worklets/flacProcessor') as unknown as { FlacProcessor: typeof FlacProcessor });
});

/** Stereo frames whose left channel is the frame index (right = −index). */
function ramp(from: number, frames: number): Float32Array {
  const pcm = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    pcm[i * 2] = from + i;
    pcm[i * 2 + 1] = -(from + i);
  }
  return pcm;
}

function setup(opts: { tap?: PlayRing; ringFrames?: number } = {}) {
  const ring = createPlayRing((opts.ringFrames ?? 4000) * 2, true);
  const proc = new FlacProcessor({
    processorOptions: { sampleRate: RATE, channels: 2, tapRing: opts.tap?.buffer },
  } as AudioWorkletNodeOptions);
  const sent = (proc as unknown as { sent: FlacProcessorOutbound[] }).sent;
  proc.onMessage({ type: 'startStreaming', channels: 2, sampleRate: RATE, ring: ring.buffer });
  const heard: number[] = [];
  const render = (quanta = 1) => {
    for (let q = 0; q < quanta; q++) {
      const out = [new Float32Array(Q), new Float32Array(Q)];
      proc.process([], [out]);
      for (let i = 0; i < Q; i++) heard.push(out[0][i]);
    }
  };
  const last = <T extends FlacProcessorOutbound['type']>(type: T) =>
    sent.filter((m) => m.type === type).at(-1) as Extract<FlacProcessorOutbound, { type: T }> | undefined;
  return { ring, proc, sent, heard, render, last };
}

describe('flac-processor shared play ring', () => {
  it('plays ring samples bit-exactly and reports media-time positions', () => {
    const { ring, heard, render, last } = setup();
    playRingPush(ring, ramp(0, 1000));
    render(4);
    expect(heard).toEqual(Array.from({ length: 4 * Q }, (_, i) => i));
    expect(last('position')).toMatchObject({ position: 4 * Q / RATE, consumed: 4 * Q * 2, epoch: 0 });
    expect(playRingReadPos(ring)).toBe(4 * Q * 2);
  });

  it('underruns into silence without losing its place', () => {
    const { ring, heard, render } = setup();
    playRingPush(ring, ramp(1, 100));
    render(2);
    expect(heard.slice(0, 100)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(heard.slice(100).every((v) => v === 0)).toBe(true);
    playRingPush(ring, ramp(101, 10));
    heard.length = 0;
    render();
    expect(heard.slice(0, 10)).toEqual(Array.from({ length: 10 }, (_, i) => 101 + i));
  });

  it('seekStream skips to the writer position at the seek, keeping samples written after it', () => {
    const { ring, proc, heard, render, last } = setup();
    playRingPush(ring, ramp(0, 2000));
    render();
    const readFrom = playRingWritePos(ring);
    playRingPush(ring, ramp(50_000, 500)); // restarted decoder, before the message lands
    proc.onMessage({ type: 'seekStream', position: 50, epoch: 3, readFrom });
    heard.length = 0;
    render(2);
    expect(heard[0]).toBe(50_000);
    expect(last('position')).toMatchObject({ epoch: 3, consumed: 2 * Q * 2 });
    expect(last('position')!.position).toBeCloseTo(50 + 2 * Q / RATE, 9);
  });

  it('keeps the clock exact when it already read past the seek fence', () => {
    const { ring, proc, render, last } = setup();
    const readFrom = playRingWritePos(ring);
    playRingPush(ring, ramp(7000, 1000));
    render(); // consumed 128 post-seek frames under the old clock
    proc.onMessage({ type: 'seekStream', position: 7, epoch: 1, readFrom });
    render();
    expect(last('position')!.position).toBeCloseTo(7 + 2 * Q / RATE, 9);
  });

  it('restarts the clock when the audible position crosses a splice', () => {
    const { ring, proc, render, sent, last } = setup();
    playRingPush(ring, ramp(0, 300));
    proc.onMessage({ type: 'markSegment', at: playRingWritePos(ring) });
    playRingPush(ring, ramp(0, 1000));
    render(2);
    expect(sent.filter((m) => m.type === 'segmentEnded')).toHaveLength(0);
    render();
    expect(last('segmentEnded')).toEqual({ type: 'segmentEnded', epoch: 0 });
    expect(last('position')!.position).toBeCloseTo((3 * Q - 300) / RATE, 9);
  });

  it('reports ended once, after the ring drains, tagged with the epoch', () => {
    const { ring, proc, render, sent } = setup();
    proc.onMessage({ type: 'seekStream', position: 0, epoch: 5, readFrom: playRingWritePos(ring) });
    playRingPush(ring, ramp(1, 200));
    playRingSetEnded(ring, true);
    render();
    expect(sent.some((m) => m.type === 'ended')).toBe(false);
    render(3);
    expect(sent.filter((m) => m.type === 'ended')).toEqual([{ type: 'ended', epoch: 5 }]);
  });

  it('chunk fallback feeds a processor-local ring', () => {
    const proc = new FlacProcessor({ processorOptions: { sampleRate: RATE, channels: 2 } } as AudioWorkletNodeOptions);
    proc.onMessage({ type: 'startStreaming', channels: 2, sampleRate: RATE });
    proc.onMessage({ type: 'chunk', buffer: ramp(0, 200) });
    proc.onMessage({ type: 'seekStream', position: 9, epoch: 1 });
    proc.onMessage({ type: 'chunk', buffer: ramp(9000, 200) });
    const out = [new Float32Array(Q), new Float32Array(Q)];
    proc.process([], [out]);
    expect(out[0][0]).toBe(9000);
    expect(out[1][Q - 1]).toBe(-(9000 + Q - 1));
  });
});

describe('flac-processor varispeed', () => {
  it('consumes the ring at the playback rate; the clock stays in media seconds', () => {
    const { ring, proc, heard, render, last } = setup();
    playRingPush(ring, ramp(0, 3000));
    proc.onMessage({ type: 'setPlaybackRate', rate: 1.5 }); // from the first frame (history = that frame)
    render(8);
    // Hermite interpolation of a ramp is the ramp: output i = source frame 1.5·i.
    for (let i = 0; i < 8 * Q; i++) expect(heard[i]).toBeCloseTo(1.5 * i, 3);
    expect(last('position')!.position).toBeCloseTo(1.5 * 8 * Q / RATE, 2);
  });

  it('slows down at 0.5× and returns to bit-exact samples at 1×', () => {
    const { ring, proc, heard, render } = setup();
    playRingPush(ring, ramp(0, 3000));
    render(); // 1×: the last frame played becomes the interpolator's history
    proc.onMessage({ type: 'setPlaybackRate', rate: 0.5 });
    heard.length = 0;
    render(2);
    for (let i = 0; i < 2 * Q; i++) expect(heard[i]).toBeCloseTo(Q + 0.5 * i, 4);
    proc.onMessage({ type: 'setPlaybackRate', rate: 1 });
    heard.length = 0;
    render(3);
    const start = heard[0];
    expect(Number.isInteger(start)).toBe(true);
    expect(heard).toEqual(Array.from({ length: 3 * Q }, (_, i) => start + i));
  });

  it('clamps the rate to 0.25–4', () => {
    const { ring, proc, heard, render } = setup();
    playRingPush(ring, ramp(0, 3000));
    proc.onMessage({ type: 'setPlaybackRate', rate: 10 });
    render();
    expect(heard[Q - 1]).toBeCloseTo(4 * (Q - 1), 3);
  });

  it('holds position while paused at any rate', () => {
    const { ring, proc, render, heard } = setup();
    playRingPush(ring, ramp(0, 3000));
    proc.onMessage({ type: 'setPlaybackRate', rate: 2 });
    render();
    proc.onMessage({ type: 'pause' });
    const readBefore = playRingReadPos(ring);
    render(4);
    expect(playRingReadPos(ring)).toBe(readBefore);
    proc.onMessage({ type: 'resume' });
    heard.length = 0;
    render();
    expect(heard[0]).toBeCloseTo(2 * Q, 3);
  });
});

describe('flac-processor projectM tap', () => {
  it('writes output frames to the shared tap ring and notifies per 512-frame block', () => {
    const tap = createPlayRing(512 * 2 * 4, true);
    const { ring, proc, render, sent } = setup({ tap });
    playRingPush(ring, ramp(0, 2000));
    render(4);
    expect(sent.some((m) => m.type === 'pcmTap')).toBe(false); // tap off by default
    proc.onMessage({ type: 'setTap', enabled: true });
    render(4);
    expect(sent.filter((m) => m.type === 'pcmTap')).toHaveLength(1);
    expect(sent.some((m) => m.type === 'projectm-pcm')).toBe(false);
    expect(playRingWritePos(tap)).toBe(512 * 2);
    expect(tap.data[0]).toBe(4 * Q);
    expect(tap.data[1]).toBe(-4 * Q);
  });

  it('falls back to transferred blocks without a shared tap', () => {
    const { ring, proc, render, sent } = setup();
    playRingPush(ring, ramp(0, 2000));
    proc.onMessage({ type: 'setTap', enabled: true });
    render(4);
    const blocks = sent.filter((m) => m.type === 'projectm-pcm');
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { buffer: Float32Array }).buffer.length).toBe(1024);
  });
});
