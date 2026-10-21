import { describe, expect, it } from 'vitest';
import {
  BEAT_BAND_EDGES_HZ,
  BandMapper,
  MAX_BAND_HZ,
  MIN_BAND_HZ,
  bandBinRanges,
  logBandEdgesHz,
} from '../src/visuals/spectrumBands';
import { analyserFftSizeForRate, applyAnalyserPolicy } from '../src/audio/analyserPolicy';
import { downsampleAudioData } from '../src/visuals/visualSync';
import { spectrumBands } from '../src/hooks/useBeatDetection';

/** Frequencies of every bin a band range reads. */
function binHz(ranges: Int32Array, sampleRate: number, binCount: number): number[][] {
  const width = sampleRate / 2 / binCount;
  const out: number[][] = [];
  for (let b = 0; b < ranges.length / 2; b++) {
    const hz: number[] = [];
    for (let i = ranges[b * 2]!; i < ranges[b * 2 + 1]!; i++) hz.push(i * width);
    out.push(hz);
  }
  return out;
}

describe('Hz-aware analyser bands (#259 A6)', () => {
  it.each([
    [44_100, 2048],
    [48_000, 2048],
    [96_000, 4096],
    [192_000, 8192],
  ])('keeps all 64 bars within 20 Hz–20 kHz at %i Hz', (rate, fftSize) => {
    expect(analyserFftSizeForRate(rate)).toBe(fftSize);
    const binCount = fftSize / 2;
    const ranges = bandBinRanges(logBandEdgesHz(64, rate), rate, binCount);
    const bars = binHz(ranges, rate, binCount);
    expect(bars).toHaveLength(64);
    for (const hz of bars) {
      expect(hz.length).toBeGreaterThan(0);
      for (const f of hz) {
        expect(f).toBeGreaterThanOrEqual(MIN_BAND_HZ);
        expect(f).toBeLessThanOrEqual(MAX_BAND_HZ);
      }
    }
    // Bars are monotonic and the top bar reaches the top of the audible band.
    expect(bars[63]!.at(-1)!).toBeGreaterThan(18_000);
    for (let b = 1; b < 64; b++) expect(bars[b]![0]!).toBeGreaterThanOrEqual(bars[b - 1]![0]!);
  });

  it('keeps bass at ~20–440 Hz regardless of the context rate', () => {
    for (const [rate, fftSize] of [[44_100, 2048], [96_000, 4096], [192_000, 8192]] as const) {
      const bass = binHz(bandBinRanges(BEAT_BAND_EDGES_HZ, rate, fftSize / 2), rate, fftSize / 2)[0]!;
      expect(bass[0]!).toBeGreaterThanOrEqual(20);
      expect(bass.at(-1)!).toBeLessThanOrEqual(440);
    }
  });

  it('reads only ultrasonic-free energy at 96 kHz', () => {
    // Full-scale energy above 20 kHz only: every bar and beat band stays at 0.
    const rate = 96_000;
    const bins = new Uint8Array(2048);
    const width = rate / 2 / bins.length;
    for (let i = 0; i < bins.length; i++) if (i * width > 20_000) bins[i] = 255;
    expect(Math.max(...downsampleAudioData(bins, 64, rate))).toBe(0);
    expect(spectrumBands(bins, rate)).toEqual([0, 0, 0, 0, 0]);
  });

  it('caches ranges per (rate, binCount) and maps without allocating', () => {
    const mapper = BandMapper.logBars(64);
    const a = mapper.rangesFor(96_000, 2048);
    expect(mapper.rangesFor(96_000, 2048)).toBe(a);
    expect(mapper.map(new Uint8Array(2048).fill(255), 96_000)).toBe(mapper.out);
    expect(Array.from(mapper.out).every((v) => v === 1)).toBe(true);
    expect(mapper.rangesFor(44_100, 1024)).not.toBe(a);
  });

  it('applyAnalyserPolicy scales fftSize from the analyser context rate', () => {
    const node = {
      context: { sampleRate: 96_000 },
      fftSize: 0, smoothingTimeConstant: 0, minDecibels: 0, maxDecibels: 0,
    };
    applyAnalyserPolicy(node as unknown as AnalyserNode);
    expect(node.fftSize).toBe(4096);
  });
});
