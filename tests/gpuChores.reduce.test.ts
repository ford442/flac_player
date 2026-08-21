import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  reduceMinMax,
  reduceRms,
  peakPyramid,
  reduceSpectrum,
  downsampleMinMaxPairs,
  accumulateOverviewChunk,
  createOverviewAccumulator,
  finalizeOverview,
} from '../src/gpu-chores/reduce';

describe('reduceMinMax golden', () => {
  it('packs min/max pairs for equal-sized bins', () => {
    const pcm = new Float32Array([0, 1, -1, 0.5, -0.5, 0, 0.25, -0.25]);
    const out = reduceMinMax(pcm, 4, 1);
    expect(Array.from(out)).toEqual([
      0, 1,
      -1, 0.5,
      -0.5, 0,
      -0.25, 0.25,
    ]);
  });

  it('includes every channel in an interleaved frame', () => {
    const pcm = new Float32Array([1, -2, 0.5, 0.25]);
    const out = reduceMinMax(pcm, 1, 2);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(-2);
    expect(out[1]).toBe(1);
  });

  it('returns zeros for empty PCM', () => {
    const out = reduceMinMax(new Float32Array(0), 4, 1);
    expect(out).toHaveLength(8);
    expect(Array.from(out).every((v) => v === 0)).toBe(true);
  });
});

describe('reduceRms golden', () => {
  it('is 1 for a full-scale square wave', () => {
    const peek = reduceRms(new Float32Array([1, -1, 1, -1]));
    expect(peek.rms).toBeCloseTo(1, 10);
    expect(peek.peak).toBe(1);
  });

  it('is 0.5 for a constant 0.5 signal', () => {
    const peek = reduceRms(new Float32Array([0.5, 0.5, 0.5, 0.5]));
    expect(peek.rms).toBeCloseTo(0.5, 10);
    expect(peek.peak).toBeCloseTo(0.5, 10);
  });

  it('is 0 for silence', () => {
    expect(reduceRms(new Float32Array(0))).toEqual({ rms: 0, peak: 0 });
    expect(reduceRms(new Float32Array([0, 0, 0]))).toEqual({ rms: 0, peak: 0 });
  });
});

describe('peakPyramid golden', () => {
  it('level 0 matches reduceMinMax and coarser levels merge pairs', () => {
    const pcm = new Float32Array([0, 1, -1, 0.5, -0.5, 0, 0.25, -0.25]);
    const levels = peakPyramid(pcm, 4, 1);
    expect(Array.from(levels[0])).toEqual(Array.from(reduceMinMax(pcm, 4, 1)));
    expect(levels.length).toBeGreaterThanOrEqual(1);
    const halved = downsampleMinMaxPairs(levels[0]);
    expect(halved[0]).toBe(-1);
    expect(halved[1]).toBe(1);
  });
});

describe('chunked overview accumulator', () => {
  it('matches a one-shot min/max + RMS reduce', () => {
    const pcm = new Float32Array([0.1, -0.8, 0.4, 0.2, -0.3, 0.9, -1, 0.05]);
    const acc = createOverviewAccumulator(pcm.length, 4, 1);
    accumulateOverviewChunk(acc, pcm.subarray(0, 3), 0);
    accumulateOverviewChunk(acc, pcm.subarray(3), 3);
    const overview = finalizeOverview(acc);
    expect(Array.from(overview.minmax)).toEqual(Array.from(reduceMinMax(pcm, 4, 1)));
    const peek = reduceRms(pcm);
    expect(overview.rms).toBeCloseTo(peek.rms, 10);
    expect(overview.peak).toBeCloseTo(peek.peak, 10);
  });
});

describe('reduceSpectrum', () => {
  it('returns normalized bins with DC energy in the first bin', () => {
    const pcm = new Float32Array(64).fill(1);
    const bins = reduceSpectrum(pcm, 8, 1);
    expect(bins).toHaveLength(8);
    expect(bins[0]).toBeGreaterThan(bins[4]);
    expect(Math.max(...bins)).toBeLessThanOrEqual(1);
  });
});
