// Worklet hi-fi transport (#225): SharedArrayBuffer play ring vs the `chunk`
// message fallback, feeder backpressure across seek / pause / underrun, and
// varispeed playback rate. Runs in Chromium under COOP/COEP (vitest.browser.config.ts).
import { describe, expect, it } from 'vitest';
import { WorkletAudioPlayer } from '../../src/audio/backends/WorkletAudioPlayer';
import type { HifiStreamFeeder } from '../../src/audio/backends/worklet/hifiStreamFeeder';
import { HIFI_RING_HIGH_WATER } from '../../src/audio/backends/worklet/hifiStreamFeeder';
import type { AudioContextManager } from '../../src/audio/AudioContextManager';
import type { ConfigurableAudioBackend } from '../../src/types/audio';
import {
  RATE,
  UI_TOLERANCE_S,
  fixtureUrl,
  recordWorkletTap,
  sleep,
  waitFor,
  waitForFrameNear,
  withBackend,
} from '../helpers/hifiHarness';

const seekUrl = fixtureUrl('seek-index-40s.flac');
const gaplessA = fixtureUrl('gapless-a.flac');
const gaplessB = fixtureUrl('gapless-b.flac');

interface WorkletInternals {
  workletNode: AudioWorkletNode | null;
  streamFeeder: HifiStreamFeeder | null;
}
const internals = (b: ConfigurableAudioBackend) => b as unknown as WorkletInternals;

const player = (sharedRing: boolean) => (manager: AudioContextManager) =>
  new WorkletAudioPlayer(manager, { sharedRing }) as unknown as ConfigurableAudioBackend;

const TRANSPORTS = [
  { name: 'shared ring', sharedRing: true },
  { name: 'chunk fallback', sharedRing: false },
] as const;

/** Record every MessagePort.postMessage from the main thread while `run` executes. */
async function recordPosts(run: () => Promise<void>): Promise<unknown[]> {
  const posted: unknown[] = [];
  const original = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (this: MessagePort, ...args: unknown[]) {
    posted.push(args[0]);
    return (original as (...a: unknown[]) => void).apply(this, args);
  } as typeof original;
  try {
    await run();
  } finally {
    MessagePort.prototype.postMessage = original;
  }
  return posted;
}

/** Record message types the processor sends to the main thread. */
function recordInbound(backend: ConfigurableAudioBackend): string[] {
  const port = internals(backend).workletNode!.port;
  const types: string[] = [];
  const handler = port.onmessage!;
  port.onmessage = (e) => {
    types.push((e.data as { type: string }).type);
    handler.call(port, e);
  };
  return types;
}

const carriesSamples = (msg: unknown) =>
  typeof msg === 'object' && msg !== null
  && Object.values(msg).some((v) => ArrayBuffer.isView(v) && !(v instanceof DataView));

/** Median source frames advanced per output frame (1 at 1×; robust to interpolated frames). */
function indexSlope(frames: number[], stride = 64): number {
  const slopes: number[] = [];
  for (let i = 0; i + stride < frames.length; i++) {
    if (frames[i] >= 0 && frames[i + stride] >= 0) slopes.push((frames[i + stride] - frames[i]) / stride);
  }
  slopes.sort((a, b) => a - b);
  return slopes[Math.floor(slopes.length / 2)];
}

/** Median |audible − UI clock| over a few samples (both clocks tick in ~100 ms / 512-frame steps). */
async function clockSkew(backend: ConfigurableAudioBackend, frames: number[]): Promise<number> {
  const skews: number[] = [];
  for (let k = 0; k < 9; k++) {
    await sleep(45);
    const recent = frames.slice(-256).filter((n) => n >= 0).sort((a, b) => a - b);
    const audible = recent[Math.floor(recent.length / 2)] / RATE;
    skews.push(Math.abs(audible - backend.getCurrentTime()));
  }
  skews.sort((a, b) => a - b);
  return skews[4];
}

describe('worklet hi-fi transport', () => {
  it('shared ring: PCM never crosses postMessage (control messages only)', async () => {
    expect(crossOriginIsolated).toBe(true);
    let inbound: string[] = [];
    let blockLengths: number[] = [];
    const posted = await recordPosts(() => withBackend(player(true), async (backend) => {
      const tap = recordWorkletTap(backend);
      await backend.loadFromURLStreaming!(seekUrl, { expectedDuration: 40 });
      inbound = recordInbound(backend);
      await waitFor(() => tap.frames.some((n) => n >= 0));
      backend.seek(12.345);
      expect(await waitForFrameNear(tap.frames, Math.round(12.345 * RATE))).toBe(Math.round(12.345 * RATE));
      await sleep(300);
      blockLengths = tap.blockLengths;
    }));

    const types = posted.map((m) => (m as { type?: string } | null)?.type);
    expect(types).toContain('startStreaming');
    expect(types).toContain('seekStream');
    expect(types).not.toContain('chunk');
    expect(posted.filter(carriesSamples)).toEqual([]);
    expect(inbound).toContain('pcmTap');
    expect(inbound).not.toContain('projectm-pcm');
    expect(new Set(blockLengths)).toEqual(new Set([512]));
  });

  it('chunk fallback: plays, seeks and taps without SharedArrayBuffer', async () => {
    let inbound: string[] = [];
    const posted = await recordPosts(() => withBackend(player(false), async (backend) => {
      const tap = recordWorkletTap(backend);
      await backend.loadFromURLStreaming!(seekUrl, { expectedDuration: 40 });
      inbound = recordInbound(backend);
      await waitFor(() => tap.frames.some((n) => n >= 0));
      backend.seek(30);
      expect(await waitForFrameNear(tap.frames, 30 * RATE)).toBe(30 * RATE);
      await waitFor(() => backend.getCurrentTime() > 30.15);
      expect(await clockSkew(backend, tap.frames)).toBeLessThan(UI_TOLERANCE_S);
      expect(new Set(tap.blockLengths)).toEqual(new Set([512]));
    }));
    expect(posted.map((m) => (m as { type?: string } | null)?.type)).toContain('chunk');
    expect(inbound).toContain('projectm-pcm');
  });

  it.each(TRANSPORTS)('$name: gapless splice stays sample-contiguous', async ({ sharedRing }) => {
    await withBackend(player(sharedRing), async (backend) => {
      const events: Array<{ alreadyPlayingNext?: boolean }> = [];
      backend.setOnEndedCallback((e) => events.push({ alreadyPlayingNext: e?.alreadyPlayingNext }));
      backend.setGaplessSettings!({ mode: 'gapless', crossfadeMs: 0 });
      const tap = recordWorkletTap(backend);
      await backend.loadFromURLStreaming!(gaplessA, { expectedDuration: 3 });
      backend.preloadNext!({ url: gaplessB, duration: 3 });
      backend.seek(2);
      await waitFor(() => events.length > 0, 10_000);
      expect(events[0].alreadyPlayingNext).toBe(true);
      expect(backend.getCurrentTime()).toBeLessThan(0.3);
      await sleep(200);
      const at = tap.frames.indexOf(3 * RATE);
      expect(at).toBeGreaterThan(0);
      expect(tap.frames[at - 1]).toBe(3 * RATE - 1);
    });
  });

  it.each(TRANSPORTS)('$name: seek + pause + underrun do not deadlock the feeder', async ({ sharedRing }) => {
    await withBackend(player(sharedRing), async (backend) => {
      const tap = recordWorkletTap(backend);
      await backend.loadFromURLStreaming!(seekUrl, { expectedDuration: 40 });
      const feeder = () => internals(backend).streamFeeder!;
      const capacity = Math.floor(30 * RATE) * 2;
      // The decoder fills the ring to the high-water mark and parks; pause holds it there.
      await waitFor(() => feeder().buffered > capacity * (HIFI_RING_HIGH_WATER - 0.1), 15_000);
      backend.pause();

      backend.seek(20);
      expect(feeder().buffered).toBe(0); // ring fill drops at once
      backend.seek(25); // back-to-back: the first restart is aborted mid-flight
      expect(backend.getState().isPlaying).toBe(false);
      tap.clear();
      backend.play();
      expect(await waitForFrameNear(tap.frames, 25 * RATE)).toBe(25 * RATE);
      await waitFor(() => backend.getCurrentTime() > 25.2);
      expect(await clockSkew(backend, tap.frames)).toBeLessThan(UI_TOLERANCE_S);
      // The decoder is running again (not parked on a stale fill).
      await waitFor(() => feeder().buffered > RATE * 2);
    });
  });
});

describe('worklet hi-fi playback rate', () => {
  it('reports the capability and changes audible tempo; the clock stays in media seconds', async () => {
    await withBackend(player(true), async (backend, manager) => {
      expect(backend.getCapabilities().playbackRate).toBe(true);
      const tap = recordWorkletTap(backend);
      await backend.loadFromURLStreaming!(seekUrl, { expectedDuration: 40 });
      await waitFor(() => tap.frames.some((n) => n >= 0));

      for (const rate of [1.5, 0.5, 1]) {
        backend.setPlaybackRate(rate);
        await sleep(250); // settle
        tap.clear();
        const ctx = manager.getContext();
        const t0 = ctx.currentTime;
        const m0 = backend.getCurrentTime();
        await sleep(1200);
        const mediaPerSecond = (backend.getCurrentTime() - m0) / (ctx.currentTime - t0);
        expect(mediaPerSecond, `rate ${rate}`).toBeGreaterThan(rate - 0.12);
        expect(mediaPerSecond, `rate ${rate}`).toBeLessThan(rate + 0.12);
        expect(indexSlope(tap.frames), `rate ${rate}`).toBeCloseTo(rate, 2);
        expect(await clockSkew(backend, tap.frames), `rate ${rate}`).toBeLessThan(UI_TOLERANCE_S);
      }
      // Back at 1×: samples are bit-exact and contiguous again.
      const run = tap.frames.slice(-2048);
      expect(run.every((n, i) => i === 0 || n === run[i - 1] + 1)).toBe(true);
    });
  });

  it('a rate change while paused neither leaks the ring nor deadlocks the feeder', async () => {
    await withBackend(player(true), async (backend) => {
      const tap = recordWorkletTap(backend);
      await backend.loadFromURLStreaming!(seekUrl, { expectedDuration: 40 });
      const feeder = internals(backend).streamFeeder!;
      const capacity = Math.floor(30 * RATE) * 2;
      await waitFor(() => feeder.buffered > capacity * (HIFI_RING_HIGH_WATER - 0.1), 15_000);
      backend.pause();
      const parked = feeder.buffered;
      backend.setPlaybackRate(2);
      await sleep(200);
      // Paused at any rate: nothing is consumed and the decoder stays parked at high water.
      expect(feeder.buffered).toBe(parked);
      expect(feeder.buffered).toBeLessThanOrEqual(capacity * HIFI_RING_HIGH_WATER);
      backend.setPlaybackRate(0.5);
      backend.seek(10);
      tap.clear();
      backend.play();
      // Varispeed restarts on the exact target sample.
      expect(await waitForFrameNear(tap.frames, 10 * RATE)).toBe(10 * RATE);
      await waitFor(() => backend.getCurrentTime() > 10.1);
      expect(await clockSkew(backend, tap.frames)).toBeLessThan(UI_TOLERANCE_S);
      await waitFor(() => feeder.buffered > RATE * 2);
    });
  });
});
