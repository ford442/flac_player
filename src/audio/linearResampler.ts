/**
 * Documented fallback when the AudioContext cannot open the file's native rate.
 * Not a studio-quality converter — a later issue should use soxr/SpeexDSP WASM.
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
