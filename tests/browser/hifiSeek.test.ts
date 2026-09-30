// Hi-fi streaming (worklet ring + SDL3 play ring): seek accuracy, seek while the
// ring is full (backpressure parked), and gapless splice of the next queue item.
// Fixtures are index-coded (scripts/make-seek-fixtures.mjs): every frame carries
// its absolute sample index, so positions are checked exactly, not by ear.
// Served by the vitest dev server with HTTP Range support → the real Range path.
import { describe, expect, it } from 'vitest';
import type { ConfigurableAudioBackend } from '../../src/types/audio';
import {
  RATE,
  UI_TOLERANCE_S,
  firstFrameNear,
  fixtureUrl,
  indicesOf,
  recordWorkletTap,
  sleep,
  waitFor,
  withBackend,
} from '../helpers/hifiHarness';

const seekUrl = fixtureUrl('seek-index-40s.flac');
const gaplessA = fixtureUrl('gapless-a.flac');
const gaplessB = fixtureUrl('gapless-b.flac');
const gapless48k = fixtureUrl('gapless-48k.flac');
const GAPLESS_MAX_GAP_FRAMES = Math.round(0.02 * RATE);

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
