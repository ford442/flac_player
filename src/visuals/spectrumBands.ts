/**
 * Frequency-band mapping for the visualizer bars and beat bands (#259 A6).
 *
 * A byte / float spectrum of length L spans 0..Nyquist linearly, so bin i sits at
 * i · (sampleRate / 2) / L Hz. Bands are cut in Hz, not by bin index, so a 96 or
 * 192 kHz context (the graph runs at the file's native rate) does not push the
 * bars into the ultrasonic range or widen "bass" to 2 kHz.
 */

export const MIN_BAND_HZ = 20;
export const MAX_BAND_HZ = 20_000;
/** Rate assumed when the caller cannot say (the pre-#259 44.1 kHz layout). */
export const DEFAULT_SPECTRUM_RATE = 44_100;

/**
 * Beat-band edges in Hz: bass / low-mid / mid / high-mid / treble. These are the
 * bin-index bands the beat detector used at 44.1 kHz with fftSize 2048
 * (2 % / 5 % / 15 % / 30 % / rest of 1024 bins), pinned to Hz.
 */
export const BEAT_BAND_EDGES_HZ: readonly number[] = [MIN_BAND_HZ, 440, 1530, 4820, 11_400, MAX_BAND_HZ];

/** `count + 1` log-spaced edges from minHz to min(maxHz, Nyquist). */
export function logBandEdgesHz(
  count: number,
  sampleRate: number,
  minHz = MIN_BAND_HZ,
  maxHz = MAX_BAND_HZ,
): Float64Array {
  const top = Math.max(minHz * 1.01, Math.min(maxHz, sampleRate / 2));
  const edges = new Float64Array(count + 1);
  const ratio = Math.log(top / minHz);
  for (let i = 0; i <= count; i++) edges[i] = minHz * Math.exp((ratio * i) / count);
  return edges;
}

/**
 * Half-open bin ranges [start, end) per band, two Int32 per band. A band starts at
 * the first bin at or above its low edge and ends after the last bin at or below its
 * high edge. A band narrower than one bin (low bars at a coarse resolution) still
 * reads its starting bin rather than 0. The DC bin is never read.
 */
export function bandBinRanges(
  edgesHz: ArrayLike<number>,
  sampleRate: number,
  binCount: number,
): Int32Array {
  const bands = edgesHz.length - 1;
  const out = new Int32Array(Math.max(0, bands) * 2);
  if (binCount <= 0 || bands <= 0) return out;
  const binHz = sampleRate / 2 / binCount;
  const lastBin = binCount - 1;
  for (let b = 0; b < bands; b++) {
    const start = Math.min(lastBin, Math.max(1, Math.ceil(edgesHz[b]! / binHz)));
    const end = Math.min(binCount, Math.floor(edgesHz[b + 1]! / binHz) + 1);
    out[b * 2] = start;
    out[b * 2 + 1] = Math.max(start + 1, end);
  }
  return out;
}

/** Average a spectrum over precomputed ranges into `out`, normalized by `scale`. */
export function averageBands(
  data: ArrayLike<number>,
  ranges: Int32Array,
  out: Float32Array,
  scale = 255,
): Float32Array {
  const bands = ranges.length >> 1;
  for (let b = 0; b < bands; b++) {
    const start = ranges[b * 2]!;
    const end = Math.min(ranges[b * 2 + 1]!, data.length);
    let sum = 0;
    for (let i = start; i < end; i++) sum += data[i]!;
    out[b] = end > start ? sum / ((end - start) * scale) : 0;
  }
  return out;
}

/**
 * Maps spectra to `count` bands, caching the bin ranges per (sampleRate, binCount)
 * so the render loop does no per-frame allocation or log math.
 */
export class BandMapper {
  private key = '';
  private ranges: Int32Array = new Int32Array(0);
  readonly out: Float32Array;

  constructor(
    private readonly edgesFor: (sampleRate: number) => ArrayLike<number>,
    count: number,
  ) {
    this.out = new Float32Array(count);
  }

  /** Log-spaced bars (the 64-bar ShaderGUI layout). */
  static logBars(count: number): BandMapper {
    return new BandMapper((rate) => logBandEdgesHz(count, rate), count);
  }

  rangesFor(sampleRate: number, binCount: number): Int32Array {
    const key = `${sampleRate}:${binCount}`;
    if (key !== this.key) {
      this.key = key;
      this.ranges = bandBinRanges(this.edgesFor(sampleRate), sampleRate, binCount);
    }
    return this.ranges;
  }

  /** Bands of `data` (0..scale per bin) as 0..1 values in {@link out}. */
  map(data: ArrayLike<number>, sampleRate = DEFAULT_SPECTRUM_RATE, scale = 255): Float32Array {
    return averageBands(data, this.rangesFor(sampleRate, data.length), this.out, scale);
  }
}
