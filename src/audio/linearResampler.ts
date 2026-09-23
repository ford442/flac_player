/**
 * Linear-interpolation fallback for `resampler.ts`, used only when the SpeexDSP
 * WASM module fails to load. Not a studio-quality converter (see the SNR table
 * in docs/AUDIO_BACKENDS.md).
 */
export function resampleInterleavedLinear(
  input: Float32Array,
  channels: number,
  fromRate: number,
  toRate: number
): Float32Array {
  if (channels < 1 || fromRate <= 0 || toRate <= 0 || input.length < channels) {
    return input;
  }
  if (fromRate === toRate) return input;

  const inFrames = Math.floor(input.length / channels);
  const outFrames = Math.max(1, Math.round((inFrames * toRate) / fromRate));
  const output = new Float32Array(outFrames * channels);
  if (inFrames === 1) {
    for (let i = 0; i < outFrames; i++) {
      for (let ch = 0; ch < channels; ch++) {
        output[i * channels + ch] = input[ch];
      }
    }
    return output;
  }

  const ratio = (inFrames - 1) / Math.max(1, outFrames - 1);
  for (let i = 0; i < outFrames; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(inFrames - 1, i0 + 1);
    const frac = src - i0;
    for (let ch = 0; ch < channels; ch++) {
      const a = input[i0 * channels + ch];
      const b = input[i1 * channels + ch];
      output[i * channels + ch] = a + (b - a) * frac;
    }
  }
  return output;
}

/**
 * Stateful linear resampler for chunked streams: interpolation continues across
 * chunk boundaries (the stateless helper above restarts at every chunk).
 */
export class LinearStreamResampler {
  private readonly step: number;
  /** Read position in input frames; -1 addresses `prev` (last frame of the previous chunk). */
  private pos = 0;
  private prev: Float32Array;

  constructor(
    private readonly channels: number,
    fromRate: number,
    toRate: number
  ) {
    this.step = fromRate / toRate;
    this.prev = new Float32Array(channels);
  }

  process(input: Float32Array): Float32Array {
    const ch = this.channels;
    const frames = Math.floor(input.length / ch);
    if (frames === 0) return new Float32Array(0);
    const out = new Float32Array((Math.ceil((frames + 1) / this.step) + 1) * ch);
    let n = 0;
    let pos = this.pos;
    while (pos < frames - 1) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      for (let c = 0; c < ch; c++) {
        const a = i0 < 0 ? this.prev[c] : input[i0 * ch + c];
        const b = input[(i0 + 1) * ch + c];
        out[n * ch + c] = a + (b - a) * frac;
      }
      n++;
      pos += this.step;
    }
    this.pos = pos - frames;
    this.prev.set(input.subarray((frames - 1) * ch, frames * ch));
    return out.subarray(0, n * ch);
  }

  /** Linear holds at most one frame; nothing to drain. */
  flush(): Float32Array {
    return new Float32Array(0);
  }

  reset(): void {
    this.pos = 0;
    this.prev.fill(0);
  }
}
