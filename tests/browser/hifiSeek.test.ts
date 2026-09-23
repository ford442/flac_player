// Hi-fi streaming (worklet ring + SDL3 play ring): seek accuracy, seek while the
// ring is full (backpressure parked), and gapless splice of the next queue item.
// Fixtures are index-coded (scripts/make-seek-fixtures.mjs): every frame carries
// its absolute sample index, so positions are checked exactly, not by ear.
// Served by the vitest dev server with HTTP Range support → the real Range path.
import { describe, expect, it } from 'vitest';
import { AudioContextManager } from '../../src/audio/AudioContextManager';
import { createAudioBackend } from '../../src/audio/createAudioBackend';
import type { ConfigurableAudioBackend } from '../../src/types/audio';
import type { AudioOutputMode } from '../../src/hooks/usePlayerState';
import { sampleIndexAt } from '../helpers/indexCodedPcm';

const RATE = 44100;
const seekUrl = new URL('/tests/fixtures/seek-index-40s.flac', window.location.origin).href;
const gaplessA = new URL('/tests/fixtures/gapless-a.flac', window.location.origin).href;
const gaplessB = new URL('/tests/fixtures/gapless-b.flac', window.location.origin).href;
const gapless48k = new URL('/tests/fixtures/gapless-48k.flac', window.location.origin).href;
/** Acceptance bound (docs/AUDIO_BACKENDS.md). */
const UI_TOLERANCE_S = 0.1;
const GAPLESS_MAX_GAP_FRAMES = Math.round(0.02 * RATE);

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

async function waitFor<T>(probe: () => T | null | undefined | false, timeoutMs = 8000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const v = probe();
    if (v) return v;
    if (performance.now() > deadline) throw new Error('waitFor timed out');
    await sleep(20);
  }
}

async function withBackend(
  mode: AudioOutputMode,
  run: (backend: ConfigurableAudioBackend, manager: AudioContextManager) => Promise<void>
): Promise<void> {
  const manager = new AudioContextManager();
  const backend = await createAudioBackend(mode, manager);
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
function indicesOf(pcm: Float32Array, channels: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + channels <= pcm.length; i += channels) {
    if (pcm[i] === 0 && pcm[i + 1] === 0) out.push(-1);
    else out.push(sampleIndexAt(pcm[i], pcm[i + 1]));
  }
  return out;
}

/** Worklet: record every projectM tap block (the exact samples sent to the speakers). */
function recordWorkletTap(backend: ConfigurableAudioBackend) {
  const frames: number[] = [];
  let rate = 0;
  backend.setPCMCallback!((buffer, channels, sampleRate) => {
    rate = sampleRate;
    for (const n of indicesOf(buffer, channels)) frames.push(n);
  });
  return { frames, get rate() { return rate; }, clear() { frames.length = 0; } };
}

/** First frame after a seek that lands in [target − 50 ms, target + 1 s] (older frames are pre-seek). */
function firstFrameNear(frames: number[], targetSample: number): number | null {
  for (const n of frames) {
    if (n >= 0 && n >= targetSample - RATE * 0.05 && n <= targetSample + RATE) return n;
  }
  return null;
}

interface SdlInternals {
  module: {
    _get_pcm_ring_state(): number;
    _get_pcm_ring_data(): number;
    _get_play_ring_fill(): number;
    _get_play_ring_capacity(): number;
    HEAPF32?: Float32Array;
    wasmMemory?: WebAssembly.Memory;
  };
}

/** SDL: newest `frames` frames of the viz ring (post-DSP samples handed to SDL). */
function sdlRecentIndices(backend: ConfigurableAudioBackend, frames: number): number[] {
  const m = (backend as unknown as SdlInternals).module;
  const buffer = (m.HEAPF32 ?? new Float32Array(m.wasmMemory!.buffer)).buffer;
  const state = m._get_pcm_ring_state();
  const u32 = new Uint32Array(buffer, state, 3);
  const writePos = Atomics.load(u32, 0);
  const cap = u32[2];
  const data = new Float32Array(buffer, m._get_pcm_ring_data(), cap);
  const count = Math.min(frames * 2, cap, writePos);
  const pcm = new Float32Array(count);
  for (let i = 0; i < count; i++) pcm[i] = data[(writePos - count + i) % cap];
  return indicesOf(pcm, 2);
}

describe('hi-fi stream seek', () => {
  it('worklet: seeks sample-accurately and the UI clock tracks audible output', async () => {
    await withBackend('worklet', async (backend) => {
      const tap = recordWorkletTap(backend);
      // Deliberately wrong hint: 40 s must come from STREAMINFO (proves the Range/seek path).
      await backend.loadFromURLStreaming!(seekUrl, { expectedDuration: 39 });
      expect(backend.getCapabilities().seek).toBe(true);
      expect(backend.getDuration()).toBeCloseTo(40, 6);
      await waitFor(() => tap.frames.some((n) => n >= 0));
      expect(tap.rate).toBe(RATE);

      for (const target of [30, 39.5, 0, 12.345]) {
        tap.clear();
        backend.seek(target);
        expect(backend.getCurrentTime()).toBeCloseTo(target, 6);
        const targetSample = Math.round(target * RATE);
        const first = await waitFor(() => { const f = firstFrameNear(tap.frames, targetSample); return f === null ? false : { f }; }).then((r) => r.f).catch(() => {
          throw new Error(`target ${target}: frames ${JSON.stringify(tap.frames.filter((n) => n >= 0).slice(0, 5))} … ${tap.frames.length} state ${JSON.stringify(backend.getState())}`);
        });
        expect(first).toBe(targetSample); // sample-accurate restart

        await waitFor(() => backend.getCurrentTime() > target + 0.15); // settle
        const last = tap.frames.filter((n) => n >= 0).at(-1)!;
        expect(Math.abs(last / RATE - backend.getCurrentTime())).toBeLessThan(UI_TOLERANCE_S);
      }
    });
  });

  it('SDL3: seeks via _seek_stream and the UI clock tracks audible output', async () => {
    await withBackend('sdl', async (backend) => {
      await backend.loadFromURLStreaming!(seekUrl, { expectedDuration: 39 });
      expect(backend.getCapabilities().seek).toBe(true);
      expect(backend.getDuration()).toBeCloseTo(40, 6); // STREAMINFO, not the hint

      for (const target of [30, 39.5, 0, 12.345]) {
        backend.seek(target);
        expect(backend.getCurrentTime()).toBeCloseTo(target, 3);
        // Settled = audio flowing again at the new position.
        await waitFor(() => backend.getCurrentTime() > target + 0.15);
        const recent = sdlRecentIndices(backend, 512).filter((n) => n >= 0);
        expect(recent.length, `target ${target} state ${JSON.stringify(backend.getState())}`).toBeGreaterThan(0);
        const audible = recent.at(-1)! / RATE;
        expect(audible).toBeGreaterThanOrEqual(target);
        expect(Math.abs(audible - backend.getCurrentTime())).toBeLessThan(UI_TOLERANCE_S);
      }
    });
  });

  it('SDL3: seek while the push loop is parked on a full ring does not deadlock', async () => {
    await withBackend('sdl', async (backend) => {
      await backend.loadFromURLStreaming!(seekUrl, { expectedDuration: 40 });
      backend.pause();
      const m = (backend as unknown as SdlInternals).module;
      // Paused: the ring fills to the 75 % high-water mark and the decoder parks.
      await waitFor(() => m._get_play_ring_fill() > m._get_play_ring_capacity() * 0.7);

      backend.seek(20);
      backend.seek(25); // back-to-back: the first restart is aborted mid-flight
      backend.play();
      await waitFor(() => backend.getCurrentTime() > 25.2);
      const recent = sdlRecentIndices(backend, 512).filter((n) => n >= 0);
      const audible = recent.at(-1)! / RATE;
      expect(audible).toBeGreaterThanOrEqual(25);
      expect(audible).toBeLessThan(26);
      expect(Math.abs(audible - backend.getCurrentTime())).toBeLessThan(UI_TOLERANCE_S);
    });
  });

  it('worklet: seek while paused and during underrun keeps the clock honest', async () => {
    await withBackend('worklet', async (backend) => {
      const tap = recordWorkletTap(backend);
      await backend.loadFromURLStreaming!(seekUrl, { expectedDuration: 40 });
      backend.pause();
      backend.seek(10);
      backend.seek(20); // underrun: ring empty, first restart still fetching
      expect(backend.getState().isPlaying).toBe(false);
      tap.clear();
      backend.play();
      const first = await waitFor(() => { const f = firstFrameNear(tap.frames, 20 * RATE); return f === null ? false : { f }; }).then((r) => r.f);
      expect(first).toBe(20 * RATE);
    });
  });
});

describe('hi-fi gapless splice', () => {
  function assertGapless(indices: number[]) {
    const boundary = 3 * RATE; // B's first index
    const at = indices.indexOf(boundary);
    expect(at).toBeGreaterThan(0);
    // Everything from A's last sample to B's first: silence/garbage frames between them = the gap.
    const lastA = indices.lastIndexOf(boundary - 1, at);
    expect(lastA).toBeGreaterThanOrEqual(0);
    expect(at - lastA - 1).toBeLessThanOrEqual(GAPLESS_MAX_GAP_FRAMES);
    // In practice the splice is sample-contiguous.
    expect(at - lastA - 1).toBe(0);
  }

  it('worklet: next same-format track follows with no gap and the clock restarts', async () => {
    await withBackend('worklet', async (backend) => {
      const events: Array<{ alreadyPlayingNext?: boolean }> = [];
      backend.setOnEndedCallback((e) => events.push({ alreadyPlayingNext: e?.alreadyPlayingNext }));
      backend.setGaplessSettings!({ mode: 'gapless', crossfadeMs: 0 });
      const tap = recordWorkletTap(backend);
      await backend.loadFromURLStreaming!(gaplessA, { expectedDuration: 3 });
      backend.preloadNext!({ url: gaplessB, duration: 3 });
      backend.seek(2); // shorten the test; splice still happens at A's end

      await waitFor(() => events.length > 0, 10_000);
      expect(events[0].alreadyPlayingNext).toBe(true);
      expect(backend.getDuration()).toBeCloseTo(3, 6);
      expect(backend.getCurrentTime()).toBeLessThan(0.3);
      await sleep(300);
      assertGapless(tap.frames);
    });
  });

  it('SDL3: next same-format track follows with no gap and the clock restarts', async () => {
    await withBackend('sdl', async (backend) => {
      const events: Array<{ alreadyPlayingNext?: boolean }> = [];
      backend.setOnEndedCallback((e) => events.push({ alreadyPlayingNext: e?.alreadyPlayingNext }));
      backend.setGaplessSettings!({ mode: 'gapless', crossfadeMs: 0 });
      await backend.loadFromURLStreaming!(gaplessA, { expectedDuration: 3 });
      backend.preloadNext!({ url: gaplessB, duration: 3 });
      backend.seek(2.5);

      // The viz ring holds ~0.7 s; snapshot it while the boundary passes.
      let spliceWindow: number[] | null = null;
      await waitFor(() => {
        const recent = sdlRecentIndices(backend, 16384);
        if (recent.includes(3 * RATE) && recent.includes(3 * RATE - 1)) spliceWindow = recent;
        return spliceWindow !== null && events.length > 0;
      }, 10_000);
      expect(events[0].alreadyPlayingNext).toBe(true);
      expect(backend.getDuration()).toBeCloseTo(3, 6);
      expect(backend.getCurrentTime()).toBeLessThan(0.5);
      assertGapless(spliceWindow!);
    });
  });

  it.each(['worklet', 'sdl'] as const)('%s: a rate change is not spliced (plain end → reload)', async (mode) => {
    await withBackend(mode, async (backend) => {
      const events: Array<{ alreadyPlayingNext?: boolean }> = [];
      backend.setOnEndedCallback((e) => events.push({ alreadyPlayingNext: e?.alreadyPlayingNext }));
      backend.setGaplessSettings!({ mode: 'gapless', crossfadeMs: 0 });
      await backend.loadFromURLStreaming!(gaplessA, { expectedDuration: 3 });
      backend.preloadNext!({ url: gapless48k, duration: 1 });
      backend.seek(2.5);
      await waitFor(() => events.length > 0, 10_000);
      expect(events[0].alreadyPlayingNext).toBeUndefined();
      expect(backend.getState().isPlaying).toBe(false);
    });
  });
});
