import { describe, expect, it } from 'vitest';
import {
  ANALYSER_AMPLITUDE_SCALE,
  amplitudesToAnalyserBytes,
  GoldenTrust,
  GPU_SPECTRUM_DEFAULT,
  GPU_SPECTRUM_TRUST_CHECKS,
  GPU_SPECTRUM_TRUST_EPSILON,
  resolveSpectrumSource,
} from '../src/visuals/spectrumSource';
import { spectrumBands } from '../src/hooks/useBeatDetection';

describe('spectrum source selection', () => {
  it('kill switch and rollback flag win over ?gpu_fft', () => {
    expect(resolveSpectrumSource('?gpu_fft=1&no_gpu_compute')).toEqual({ source: 'analyser', reason: 'kill-switch' });
    expect(resolveSpectrumSource('?gpu_fft=1&analyser_fft=1')).toEqual({ source: 'analyser', reason: 'analyser_fft' });
    expect(resolveSpectrumSource('?gpu_fft=1')).toEqual({ source: 'gpu', reason: 'gpu_fft' });
    expect(resolveSpectrumSource('')).toEqual({ source: GPU_SPECTRUM_DEFAULT, reason: 'default' });
  });
});

describe('GoldenTrust', () => {
  it('needs consecutive passing checks and demotes on one failure', () => {
    const trust = new GoldenTrust();
    for (let i = 0; i < GPU_SPECTRUM_TRUST_CHECKS - 1; i++) {
      expect(trust.record(GPU_SPECTRUM_TRUST_EPSILON / 2)).toBe(false);
    }
    expect(trust.record(0)).toBe(true);
    expect(trust.record(GPU_SPECTRUM_TRUST_EPSILON * 10)).toBe(false);
    expect(trust.record(Number.NaN)).toBe(false);
  });
});

describe('amplitudesToAnalyserBytes', () => {
  const scale = { minDecibels: -100, maxDecibels: -30, smoothingTimeConstant: 0 };

  it('maps amplitudes onto the analyser dB byte scale', () => {
    // Amplitude whose analyser magnitude is exactly -30 dBFS → 255; -100 dBFS → 0.
    const top = 10 ** (-30 / 20) / ANALYSER_AMPLITUDE_SCALE;
    const bottom = 10 ** (-100 / 20) / ANALYSER_AMPLITUDE_SCALE;
    const mid = 10 ** (-65 / 20) / ANALYSER_AMPLITUDE_SCALE;
    const bytes = amplitudesToAnalyserBytes(
      new Float32Array([0, bottom, mid, top, 1]), scale, new Float32Array(5),
    );
    expect(bytes[0]).toBe(0);
    expect(bytes[1]).toBeLessThanOrEqual(1);
    expect(bytes[2]).toBeGreaterThanOrEqual(126);
    expect(bytes[2]).toBeLessThanOrEqual(128);
    expect(bytes[3]).toBeGreaterThanOrEqual(254);
    expect(bytes[4]).toBe(255);
  });

  it('applies analyser-style temporal smoothing across calls', () => {
    const smoothed = new Float32Array(1);
    const s = { ...scale, smoothingTimeConstant: 0.5 };
    amplitudesToAnalyserBytes(new Float32Array([1]), s, smoothed);
    expect(smoothed[0]).toBeCloseTo(0.5 * ANALYSER_AMPLITUDE_SCALE, 6);
    amplitudesToAnalyserBytes(new Float32Array([0]), s, smoothed);
    expect(smoothed[0]).toBeCloseTo(0.25 * ANALYSER_AMPLITUDE_SCALE, 6);
  });

  it('feeds the same 5-band split the analyser path uses', () => {
    const bytes = new Uint8Array(1024).fill(255);
    expect(spectrumBands(bytes)).toEqual([1, 1, 1, 1, 1]);
  });
});
