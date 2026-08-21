/**
 * CPU goldens for display chores. These are the source of truth for unit tests
 * and the Worker / main-thread fallbacks. Not used on the audio render thread.
 */

import { DEFAULT_SCRUBBER_BINS, DEFAULT_SPECTRUM_BINS } from './constants';
import { clampBinCount } from './breakEven';

export interface RmsPeek {
  rms: number;
  peak: number;
}

export function frameCount(sampleCount: number, channels: number): number {
  const ch = Math.max(1, channels | 0);
  return Math.floor(sampleCount / ch);
}

function sampleAt(pcm: Float32Array, frame: number, channel: number, channels: number): number {
  return pcm[frame * channels + channel] ?? 0;
}

/**
 * Min/max overview: `binCount` pairs packed as [min0, max0, min1, max1, ...].
 * Each bin covers a contiguous frame range; all channels in the frame are included.
 */
export function reduceMinMax(
  pcm: Float32Array,
  binCount = DEFAULT_SCRUBBER_BINS,
  channels = 1,
): Float32Array {
  const bins = clampBinCount(binCount, DEFAULT_SCRUBBER_BINS);
  const ch = Math.max(1, channels | 0);
  const frames = frameCount(pcm.length, ch);
  const out = new Float32Array(bins * 2);

  if (frames <= 0) {
    for (let i = 0; i < bins; i++) {
      out[i * 2] = 0;
      out[i * 2 + 1] = 0;
    }
    return out;
  }

  for (let bin = 0; bin < bins; bin++) {
    const start = Math.floor((bin * frames) / bins);
    const end = Math.floor(((bin + 1) * frames) / bins);
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    if (end <= start) {
      const frame = Math.min(start, frames - 1);
      for (let c = 0; c < ch; c++) {
        const s = sampleAt(pcm, frame, c, ch);
        if (s < min) min = s;
        if (s > max) max = s;
      }
    } else {
      for (let frame = start; frame < end; frame++) {
        for (let c = 0; c < ch; c++) {
          const s = sampleAt(pcm, frame, c, ch);
          if (s < min) min = s;
          if (s > max) max = s;
        }
      }
    }
    if (!Number.isFinite(min)) min = 0;
    if (!Number.isFinite(max)) max = 0;
    out[bin * 2] = min;
    out[bin * 2 + 1] = max;
  }
  return out;
}

export function reduceRms(pcm: Float32Array): RmsPeek {
  const n = pcm.length;
  if (n === 0) return { rms: 0, peak: 0 };
  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm[i];
    sumSq += s * s;
    const abs = s < 0 ? -s : s;
    if (abs > peak) peak = abs;
  }
  return { rms: Math.sqrt(sumSq / n), peak };
}

/** Halve an interleaved min/max strip: each pair is min-of-mins / max-of-maxes. */
export function downsampleMinMaxPairs(minmax: Float32Array): Float32Array {
  const bins = Math.floor(minmax.length / 2);
  if (bins <= 1) return minmax.slice();
  const nextBins = Math.max(1, Math.floor(bins / 2));
  const out = new Float32Array(nextBins * 2);
  for (let i = 0; i < nextBins; i++) {
    const left = i * 2;
    const right = Math.min(i * 2 + 1, bins - 1);
    const minL = minmax[left * 2];
    const maxL = minmax[left * 2 + 1];
    const minR = minmax[right * 2];
    const maxR = minmax[right * 2 + 1];
    out[i * 2] = minL < minR ? minL : minR;
    out[i * 2 + 1] = maxL > maxR ? maxL : maxR;
  }
  return out;
}

/**
 * Peak pyramid: level 0 is `reduceMinMax` at `binCount`; further levels halve
 * until 4 bins remain. Scrubbers typically draw level 0.
 */
export function peakPyramid(
  pcm: Float32Array,
  binCount = DEFAULT_SCRUBBER_BINS,
  channels = 1,
): Float32Array[] {
  const levels: Float32Array[] = [reduceMinMax(pcm, binCount, channels)];
  while (levels[levels.length - 1].length / 2 > 4) {
    levels.push(downsampleMinMaxPairs(levels[levels.length - 1]));
  }
  return levels;
}

export interface OverviewAccumulator {
  mins: Float32Array;
  maxs: Float32Array;
  sumSq: number;
  peak: number;
  samplesSeen: number;
  binCount: number;
  channels: number;
  totalSamples: number;
}

export function createOverviewAccumulator(
  totalSamples: number,
  binCount: number,
  channels: number,
): OverviewAccumulator {
  const bins = clampBinCount(binCount, DEFAULT_SCRUBBER_BINS);
  const mins = new Float32Array(bins);
  const maxs = new Float32Array(bins);
  mins.fill(Number.POSITIVE_INFINITY);
  maxs.fill(Number.NEGATIVE_INFINITY);
  return {
    mins,
    maxs,
    sumSq: 0,
    peak: 0,
    samplesSeen: 0,
    binCount: bins,
    channels: Math.max(1, channels | 0),
    totalSamples,
  };
}

/**
 * Fold a PCM chunk into a running overview. `sampleOffset` is the interleaved
 * index of `pcm[0]` in the full buffer.
 */
export function accumulateOverviewChunk(
  acc: OverviewAccumulator,
  pcm: Float32Array,
  sampleOffset: number,
): void {
  const ch = acc.channels;
  const frames = frameCount(acc.totalSamples, ch);
  const chunkFrames = frameCount(pcm.length, ch);
  const frameOffset = Math.floor(sampleOffset / ch);
  if (frames <= 0 || chunkFrames <= 0) return;

  for (let i = 0; i < pcm.length; i++) {
    const s = pcm[i];
    acc.sumSq += s * s;
    const abs = s < 0 ? -s : s;
    if (abs > acc.peak) acc.peak = abs;
  }
  acc.samplesSeen += pcm.length;

  for (let localFrame = 0; localFrame < chunkFrames; localFrame++) {
    const globalFrame = frameOffset + localFrame;
    if (globalFrame < 0 || globalFrame >= frames) continue;
    const bin = Math.min(
      acc.binCount - 1,
      Math.floor((globalFrame * acc.binCount) / frames),
    );
    for (let c = 0; c < ch; c++) {
      const s = sampleAt(pcm, localFrame, c, ch);
      if (s < acc.mins[bin]) acc.mins[bin] = s;
      if (s > acc.maxs[bin]) acc.maxs[bin] = s;
    }
  }
}

export function finalizeOverview(acc: OverviewAccumulator): {
  minmax: Float32Array;
  rms: number;
  peak: number;
} {
  const minmax = new Float32Array(acc.binCount * 2);
  for (let i = 0; i < acc.binCount; i++) {
    const min = Number.isFinite(acc.mins[i]) ? acc.mins[i] : 0;
    const max = Number.isFinite(acc.maxs[i]) ? acc.maxs[i] : 0;
    minmax[i * 2] = min;
    minmax[i * 2 + 1] = max;
  }
  const n = acc.samplesSeen;
  return {
    minmax,
    rms: n > 0 ? Math.sqrt(acc.sumSq / n) : 0,
    peak: acc.peak,
  };
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** In-place radix-2 real FFT → packed complex (re, im) pairs of length n. */
function fftRadix2(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
    let m = n >> 1;
    while (m >= 1 && j >= m) {
      j -= m;
      m >>= 1;
    }
    j += m;
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = (2 * Math.PI) / size;
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < half; k++) {
        const angle = step * k;
        const wr = Math.cos(angle);
        const wi = -Math.sin(angle);
        const even = i + k;
        const odd = even + half;
        const tr = wr * re[odd] - wi * im[odd];
        const ti = wr * im[odd] + wi * re[odd];
        re[odd] = re[even] - tr;
        im[odd] = im[even] - ti;
        re[even] += tr;
        im[even] += ti;
      }
    }
  }
}

/**
 * Magnitude spectrum of a (possibly interleaved) window, collapsed to `binCount`
 * HUD bins. CPU-only golden; live HUD still uses AnalyserNode by default.
 */
export function reduceSpectrum(
  pcm: Float32Array,
  binCount = DEFAULT_SPECTRUM_BINS,
  channels = 1,
): Float32Array {
  const bins = clampBinCount(binCount, DEFAULT_SPECTRUM_BINS);
  const ch = Math.max(1, channels | 0);
  const frames = frameCount(pcm.length, ch);
  const out = new Float32Array(bins);
  if (frames <= 0) return out;

  const n = nextPow2(Math.min(frames, 2048));
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  const take = Math.min(frames, n);
  const scale = 1 / ch;
  for (let i = 0; i < take; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++) s += sampleAt(pcm, i, c, ch);
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / Math.max(1, take - 1)));
    re[i] = (s * scale) * w;
  }
  fftRadix2(re, im);

  const nyquist = n / 2;
  const mags = new Float32Array(nyquist);
  let maxMag = 0;
  for (let i = 0; i < nyquist; i++) {
    const mag = Math.hypot(re[i], im[i]);
    mags[i] = mag;
    if (mag > maxMag) maxMag = mag;
  }
  const norm = maxMag > 0 ? 1 / maxMag : 0;
  for (let b = 0; b < bins; b++) {
    const start = Math.floor((b * nyquist) / bins);
    const end = Math.floor(((b + 1) * nyquist) / bins);
    let sum = 0;
    const span = Math.max(1, end - start);
    for (let i = start; i < end; i++) sum += mags[i];
    out[b] = (sum / span) * norm;
  }
  return out;
}

export function pyramidFromMinMax(minmax: Float32Array): Float32Array[] {
  const levels: Float32Array[] = [minmax];
  while (levels[levels.length - 1].length / 2 > 4) {
    levels.push(downsampleMinMaxPairs(levels[levels.length - 1]));
  }
  return levels;
}
