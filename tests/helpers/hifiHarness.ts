// Shared harness for the hi-fi browser tests (tests/browser/hifi*.test.ts).
// Fixtures are index-coded (scripts/make-seek-fixtures.mjs): every frame carries
// its absolute sample index, so positions are checked exactly, not by ear.
import { AudioContextManager } from '../../src/audio/AudioContextManager';
import { createAudioBackend } from '../../src/audio/createAudioBackend';
import type { ConfigurableAudioBackend } from '../../src/types/audio';
import type { AudioOutputMode } from '../../src/hooks/usePlayerState';
import { sampleIndexAt } from './indexCodedPcm';

export const RATE = 44100;
/** Acceptance bound (docs/AUDIO_BACKENDS.md). */
export const UI_TOLERANCE_S = 0.1;

export const fixtureUrl = (name: string) => new URL(`/tests/fixtures/${name}`, window.location.origin).href;

export const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

export async function waitFor<T>(probe: () => T | null | undefined | false, timeoutMs = 8000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const v = probe();
    if (v) return v;
    if (performance.now() > deadline) throw new Error('waitFor timed out');
    await sleep(20);
  }
}

export async function withBackend(
  mode: AudioOutputMode | ((manager: AudioContextManager) => ConfigurableAudioBackend),
  run: (backend: ConfigurableAudioBackend, manager: AudioContextManager) => Promise<void>
): Promise<void> {
  const manager = new AudioContextManager();
  const backend = typeof mode === 'function' ? mode(manager) : await createAudioBackend(mode, manager);
  try {
    await backend.initialize();
    await run(backend, manager);
  } finally {
    backend.destroy();
    if (manager.hasContext()) {
      const context = manager.getContext();
      if (context.state !== 'closed') await context.close();
    }
  }
}

/** Absolute indices of non-silent frames (index-coded silence would be (0, 0)). */
export function indicesOf(pcm: Float32Array, channels: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + channels <= pcm.length; i += channels) {
    if (pcm[i] === 0 && pcm[i + 1] === 0) out.push(-1);
    else out.push(sampleIndexAt(pcm[i], pcm[i + 1]));
  }
  return out;
}

/** Worklet: record every projectM tap block (the exact samples sent to the speakers). */
export function recordWorkletTap(backend: ConfigurableAudioBackend) {
  const frames: number[] = [];
  const blockLengths: number[] = [];
  let rate = 0;
  backend.setPCMCallback!((buffer, channels, sampleRate) => {
    rate = sampleRate;
    blockLengths.push(buffer.length / channels);
    for (const n of indicesOf(buffer, channels)) frames.push(n);
  });
  return {
    frames,
    blockLengths,
    get rate() { return rate; },
    clear() { frames.length = 0; blockLengths.length = 0; },
  };
}

/** First frame after a seek that lands in [target − 50 ms, target + 1 s] (older frames are pre-seek). */
export function firstFrameNear(frames: number[], targetSample: number): number | null {
  for (const n of frames) {
    if (n >= 0 && n >= targetSample - RATE * 0.05 && n <= targetSample + RATE) return n;
  }
  return null;
}

/** Wait for the first tapped frame near `targetSample` (sample-accurate seek check). */
export async function waitForFrameNear(frames: number[], targetSample: number): Promise<number> {
  const found = await waitFor(() => {
    const f = firstFrameNear(frames, targetSample);
    return f === null ? false : { f };
  });
  return found.f;
}
