// The `sdl-engine` AudioWorkletProcessor (sdlEngineProcessor.js) loaded into a
// minimal AudioWorkletGlobalScope and driven against a shared
// WebAssembly.Memory laid out like the C++ engine's (engine_state.h,
// play_ring.h). FakeEngine below performs the same word writes as the
// audio_engine.cpp exports; tests/browser/sdlEngine.test.ts runs the real module.
import { readFileSync } from 'fs';
import path from 'path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ENGINE_MODE,
  ENGINE_STATE_WORDS,
  ENGINE_STATE_WORD_COUNT,
  PLAY_RING_WORDS,
  type SdlEngineOptions,
} from '../src/audio/worklets/sdlEngineMessages';

const CONTEXT_RATE = 48000;
const QUANTUM = 128;

interface ProcessorInstance {
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
type ProcessorCtor = new (options: { processorOptions: SdlEngineOptions }) => ProcessorInstance;

let SdlEngineProcessor: ProcessorCtor;
let registeredName = '';

beforeAll(async () => {
  class FakeProcessor {
    port = { onmessage: null, postMessage: () => {} };
  }
  vi.stubGlobal('AudioWorkletProcessor', FakeProcessor);
  vi.stubGlobal('sampleRate', CONTEXT_RATE);
  vi.stubGlobal('registerProcessor', (name: string, ctor: ProcessorCtor) => {
    registeredName = name;
    SdlEngineProcessor = ctor;
  });
  await import('../src/audio/worklets/sdlEngineProcessor.js');
});

const W = ENGINE_STATE_WORDS;
const R = PLAY_RING_WORDS;
const STATE_PTR = 0;
const RING_STATE_PTR = 64;
const RING_DATA_PTR = 128;
const PAGE = 65536;

/** The audio_engine.cpp exports, as word writes into shared memory. */
class FakeEngine {
  readonly memory: WebAssembly.Memory;
  readonly state: Uint32Array;
  readonly ring: Uint32Array;
  readonly capacity: number;

  constructor(capacity = 1024, pages = 2) {
    this.memory = new WebAssembly.Memory({ initial: pages, maximum: 64, shared: true });
    this.state = new Uint32Array(this.memory.buffer, STATE_PTR, ENGINE_STATE_WORD_COUNT);
    this.ring = new Uint32Array(this.memory.buffer, RING_STATE_PTR, 4);
    this.capacity = capacity;
    this.ring[R.capacity] = capacity;
    this.setRate(1);
  }

  get heap(): Float32Array {
    return new Float32Array(this.memory.buffer);
  }

  set(word: keyof typeof W, value: number): void {
    Atomics.store(this.state, W[word], value >>> 0);
  }

  get(word: keyof typeof W): number {
    return Atomics.load(this.state, W[word]);
  }

  bump(): void {
    Atomics.add(this.state, W.epoch, 1);
  }

  setPositions(pos: number): void {
    this.ring[R.writePos] = pos >>> 0;
    this.ring[R.readPos] = pos >>> 0;
  }

  setBuffered(pcm: Float32Array, channels: number, rate: number, ptr: number): void {
    this.heap.set(pcm, ptr / 4);
    this.set('playing', 0);
    this.set('mode', ENGINE_MODE.buffered);
    this.set('channels', channels);
    this.set('sampleRate', rate);
    this.set('bufferPtr', ptr);
    this.set('bufferFloats', pcm.length);
    this.set('startFrame', 0);
    this.bump();
  }

  setStream(channels: number, rate: number): void {
    Atomics.store(this.ring, R.ended, 0);
    this.set('mode', ENGINE_MODE.stream);
    this.set('channels', channels);
    this.set('sampleRate', rate);
    this.set('startFrame', 0);
    this.set('ringStart', Atomics.load(this.ring, R.writePos));
    this.bump();
  }

  /** play_ring_push: whatever fits, partial frames included. */
  push(samples: Float32Array): number {
    const wp = Atomics.load(this.ring, R.writePos);
    const rp = Atomics.load(this.ring, R.readPos);
    const n = Math.min(samples.length, this.capacity - ((wp - rp) >>> 0));
    const heap = this.heap;
    for (let i = 0; i < n; i++) heap[RING_DATA_PTR / 4 + ((wp + i) & (this.capacity - 1))] = samples[i];
    Atomics.store(this.ring, R.writePos, (wp + n) >>> 0);
    return n;
  }

  seek(frame: number): void {
    this.set('startFrame', frame);
    this.bump();
  }

  seekStream(frame: number): void {
    Atomics.store(this.ring, R.ended, 0);
    this.set('startFrame', frame);
    this.set('ringStart', Atomics.load(this.ring, R.writePos));
    this.bump();
  }

  setEnded(): void {
    Atomics.store(this.ring, R.ended, 1);
  }

  setRate(rate: number): void {
    this.set('rateBits', new Uint32Array(new Float32Array([rate]).buffer)[0]);
  }

  /** engine_position_frames. */
  position(): number {
    const start = this.get('startFrame');
    return this.get('ackEpoch') === this.get('epoch') ? start + this.get('framesPlayed') : start;
  }

  processor(owner = 7): ProcessorInstance {
    this.set('owner', owner);
    return new SdlEngineProcessor({
      processorOptions: {
        memory: this.memory,
        statePtr: STATE_PTR,
        ringStatePtr: RING_STATE_PTR,
        ringDataPtr: RING_DATA_PTR,
        owner,
      },
    });
  }
}

function quantum(p: ProcessorInstance, channels: number): { out: Float32Array[]; alive: boolean } {
  const out = Array.from({ length: channels }, () => new Float32Array(QUANTUM).fill(NaN));
  const alive = p.process([], [out]);
  return { out, alive };
}

/** Interleave a quantum's planar output back into frames. */
function frames(out: Float32Array[]): number[][] {
  return Array.from({ length: out[0].length }, (_, i) => out.map((ch) => ch[i]));
}

/** Frame f of a counter stream: channel c carries f * channels + c. */
function counter(fromFloat: number, count: number): Float32Array {
  return Float32Array.from({ length: count }, (_, i) => fromFloat + i);
}

describe('sdl-engine processor contract', () => {
  it('registers as sdl-engine', () => {
    expect(registeredName).toBe('sdl-engine');
  });

  it('reads the words engine_state.h and play_ring.h lay out', () => {
    const root = path.resolve(__dirname, '..');
    const engineState = readFileSync(path.join(root, 'src/sdl/engine_state.h'), 'utf8');
    const playRing = readFileSync(path.join(root, 'src/sdl/play_ring.h'), 'utf8');
    const processor = readFileSync(path.join(root, 'src/audio/worklets/sdlEngineProcessor.js'), 'utf8');

    const offsets = (src: string, struct: string) =>
      Object.fromEntries([...src.matchAll(new RegExp(`offsetof\\(${struct}, (\\w+)\\) == (\\d+)(?: \\* 4)?`, 'g'))]
        .map((m) => [m[1], m[0].includes('* 4') ? Number(m[2]) : Number(m[2]) / 4]));
    expect(offsets(engineState, 'EngineState')).toEqual(ENGINE_STATE_WORDS);
    expect(engineState).toMatch(new RegExp(`sizeof\\(EngineState\\) == ${ENGINE_STATE_WORD_COUNT * 4}`));
    // writePos has no assert (it is the first member at 0).
    expect({ writePos: 0, ...offsets(playRing, 'PlayRingState') }).toEqual(PLAY_RING_WORDS);
    expect(engineState).toMatch(/ENGINE_IDLE = 0, ENGINE_BUFFERED = 1, ENGINE_STREAM = 2/);
    expect(ENGINE_MODE).toEqual({ idle: 0, buffered: 1, stream: 2 });

    // The classic script repeats the indices; every one must agree.
    const constant = (name: string) => Number(new RegExp(`const ${name} = (\\d+);`).exec(processor)?.[1]);
    const snake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();
    for (const [name, word] of Object.entries(ENGINE_STATE_WORDS)) {
      expect(constant(`S_${snake(name)}`), name).toBe(word);
    }
    for (const [name, word] of Object.entries(PLAY_RING_WORDS)) {
      expect(constant(`R_${snake(name)}`), name).toBe(word);
    }
    for (const [name, value] of Object.entries(ENGINE_MODE)) {
      expect(constant(`MODE_${snake(name)}`), name).toBe(value);
    }
    expect(constant('STATE_WORDS')).toBe(ENGINE_STATE_WORD_COUNT);
  });
});

describe('sdl-engine processor: stream', () => {
  it.each([2, 6, 8])('plays whole %i-channel frames in order across the ring seam and the 2^32 wrap', (channels) => {
    const engine = new FakeEngine(1024);
    // About to wrap: positions pass 2^32 a few hundred floats in.
    engine.setPositions(0xffffff00);
    engine.setStream(channels, CONTEXT_RATE);
    const p = engine.processor();
    engine.set('playing', 1);

    const totalFrames = 6000;
    const source = counter(0, totalFrames * channels);
    let pushed = 0;
    const heard: number[][] = [];
    // Pushes of 7 floats leave partial frames at the tail every time. Bounded:
    // a processor that stops consuming fails here instead of hanging.
    for (let q = 0; heard.length < totalFrames; q++) {
      expect(q, `stalled after ${heard.length} frames`).toBeLessThan(2000);
      for (let k = 0; k < 40 && pushed < source.length; k++) {
        pushed += engine.push(source.subarray(pushed, Math.min(source.length, pushed + 7)));
      }
      const { out } = quantum(p, channels);
      for (const f of frames(out)) if (!f.every((v) => v === 0)) heard.push(f);
      // Never more than whole frames consumed: readPos stays frame-aligned.
      const consumed = (Atomics.load(engine.ring, R.readPos) - 0xffffff00) >>> 0;
      expect(consumed % channels).toBe(0);
    }
    for (let f = 0; f < totalFrames; f++) {
      expect(heard[f]).toEqual(Array.from({ length: channels }, (_, c) => f * channels + c));
    }
    expect(Atomics.load(engine.ring, R.readPos)).toBeLessThan(0xffffff00); // wrapped
    expect(engine.position()).toBe(engine.get('framesPlayed'));
  });

  it('outputs what it has on underrun, then silence, and the clock counts only what played', () => {
    const engine = new FakeEngine();
    engine.setStream(2, CONTEXT_RATE);
    const p = engine.processor();
    engine.set('playing', 1);
    engine.push(counter(0, 50 * 2 + 1)); // 50 frames and half of the next
    const { out } = quantum(p, 2);
    expect(frames(out).slice(0, 50).map((f) => f[0])).toEqual(Array.from({ length: 50 }, (_, i) => i * 2));
    expect(frames(out).slice(50).every((f) => f[0] === 0 && f[1] === 0)).toBe(true);
    expect(engine.get('framesPlayed')).toBe(50);
    expect(Atomics.load(engine.ring, R.readPos)).toBe(100); // the half frame waits
    expect(engine.get('drained')).toBe(0); // not ended: just late
  });

  it('drains once the producer ended and the ring is empty (a partial tail is dropped)', () => {
    const engine = new FakeEngine();
    engine.setStream(6, CONTEXT_RATE);
    const p = engine.processor();
    engine.set('playing', 1);
    engine.push(counter(0, 10 * 6 + 3));
    quantum(p, 6);
    expect(engine.get('drained')).toBe(0);
    engine.setEnded();
    quantum(p, 6);
    expect(engine.get('drained')).toBe(1);
    expect(engine.get('framesPlayed')).toBe(10);
  });

  it('seek: skips to ringStart, holds the clock at the target until it applies, then counts from it', () => {
    const engine = new FakeEngine();
    engine.setStream(2, CONTEXT_RATE);
    const p = engine.processor();
    engine.set('playing', 1);
    engine.push(counter(0, 400));
    quantum(p, 2);
    expect(engine.position()).toBe(128);

    engine.seekStream(48000);
    expect(engine.position()).toBe(48000); // before the processor applies it
    engine.push(counter(10_000, 256)); // post-seek PCM, behind 144 stale frames
    const { out } = quantum(p, 2);
    expect(out[0][0]).toBe(10_000);
    expect(engine.get('ackEpoch')).toBe(engine.get('epoch'));
    expect(engine.position()).toBe(48000 + 128);
  });

  it('pause holds position; play resumes where it stopped', () => {
    const engine = new FakeEngine();
    engine.setStream(2, CONTEXT_RATE);
    const p = engine.processor();
    engine.set('playing', 1);
    engine.push(counter(0, 1000));
    quantum(p, 2);
    engine.set('playing', 0);
    const paused = quantum(p, 2);
    expect(paused.out.every((ch) => ch.every((v) => v === 0))).toBe(true);
    expect(engine.get('framesPlayed')).toBe(128);
    engine.set('playing', 1);
    expect(quantum(p, 2).out[0][0]).toBe(256);
  });
});

describe('sdl-engine processor: buffered', () => {
  it('starts at startFrame, plays to the end and drains', () => {
    const engine = new FakeEngine();
    const pcm = counter(0, 300 * 2);
    engine.setBuffered(pcm, 2, CONTEXT_RATE, 8192);
    const p = engine.processor();
    engine.seek(100);
    engine.set('playing', 1);
    const first = quantum(p, 2);
    expect(first.out[0][0]).toBe(200);
    expect(first.out[1][0]).toBe(201);
    expect(engine.position()).toBe(228);
    quantum(p, 2);
    expect(engine.get('drained')).toBe(1);
    expect(engine.position()).toBe(300);
  });

  it('maps a track the memory grew to hold after the processor started', () => {
    const engine = new FakeEngine(1024, 1);
    const p = engine.processor();
    quantum(p, 2); // views built on the one-page buffer
    engine.memory.grow(2);
    const ptr = 2 * PAGE; // only exists after the grow
    engine.setBuffered(counter(0, 256 * 2), 2, CONTEXT_RATE, ptr);
    engine.set('playing', 1);
    expect(quantum(p, 2).out[0][5]).toBe(10);
  });

  it('refuses a track outside the memory instead of reading past it', () => {
    const engine = new FakeEngine(1024, 1);
    const p = engine.processor();
    engine.set('mode', ENGINE_MODE.buffered);
    engine.set('channels', 2);
    engine.set('sampleRate', CONTEXT_RATE);
    engine.set('bufferPtr', PAGE - 64);
    engine.set('bufferFloats', 1024);
    engine.bump();
    engine.set('playing', 1);
    const { out, alive } = quantum(p, 2);
    expect(alive).toBe(true);
    expect(out.every((ch) => ch.every((v) => v === 0))).toBe(true);
  });
});

describe('sdl-engine processor: rate', () => {
  it('rate 2 consumes two frames per output frame; the clock stays in media frames', () => {
    const engine = new FakeEngine();
    engine.setBuffered(counter(0, 1000 * 2), 2, CONTEXT_RATE, 8192);
    const p = engine.processor();
    engine.setRate(2);
    engine.set('playing', 1);
    const { out } = quantum(p, 2);
    expect(Array.from(out[0].subarray(0, 4))).toEqual([0, 4, 8, 12]);
    expect(engine.get('framesPlayed')).toBe(256);
  });

  it('rate 0.5 interpolates between neighbouring frames, channel by channel', () => {
    const engine = new FakeEngine();
    engine.setBuffered(counter(0, 1000 * 6), 6, CONTEXT_RATE, 8192);
    const p = engine.processor();
    engine.setRate(0.5);
    engine.set('playing', 1);
    const { out } = quantum(p, 6);
    expect(Array.from(out[0].subarray(0, 4))).toEqual([0, 3, 6, 9]);
    expect(Array.from(out[5].subarray(0, 4))).toEqual([5, 8, 11, 14]);
    expect(engine.get('framesPlayed')).toBe(64);
  });

  it('PCM at another rate than the context (a recreate it was not told about) keeps pitch and clock', () => {
    const engine = new FakeEngine();
    engine.setBuffered(counter(0, 1000 * 2), 2, CONTEXT_RATE / 2, 8192);
    const p = engine.processor();
    engine.set('playing', 1);
    quantum(p, 2);
    expect(engine.get('framesPlayed')).toBe(64); // 128 output frames at 48 kHz = 64 at 24 kHz
  });

  it('plays the last frame of a buffered track at a fractional rate and drains', () => {
    const engine = new FakeEngine();
    engine.setBuffered(counter(0, 101 * 2), 2, CONTEXT_RATE, 8192);
    const p = engine.processor();
    engine.setRate(1.5);
    engine.set('playing', 1);
    quantum(p, 2);
    expect(engine.get('drained')).toBe(1);
    expect(engine.position()).toBe(101);
  });
});

describe('sdl-engine processor: ownership', () => {
  it('retires when another processor takes the engine, without touching it again', () => {
    const engine = new FakeEngine();
    engine.setStream(2, CONTEXT_RATE);
    const old = engine.processor(1);
    engine.set('playing', 1);
    engine.push(counter(0, 1000));
    quantum(old, 2);
    const next = engine.processor(2);
    const readPos = Atomics.load(engine.ring, R.readPos);
    const retired = quantum(old, 2);
    expect(retired.alive).toBe(false);
    expect(retired.out.every((ch) => ch.every((v) => v === 0))).toBe(true);
    expect(Atomics.load(engine.ring, R.readPos)).toBe(readPos);
    expect(quantum(next, 2).out[0][0]).toBe(256);
  });
});
