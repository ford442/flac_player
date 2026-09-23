/**
 * Decode the sample index embedded by scripts/make-seek-fixtures.mjs:
 *   ch0 = (n mod 4096) × 16 − 32768     ch1 = (floor(n / 4096) mod 1024) × 64 − 32768
 * (16-bit PCM, decoded to float as int / 32768).
 */
export function sampleIndexAt(left: number, right: number): number {
  const lo = Math.round((left * 32768 + 32768) / 16);
  const hi = Math.round((right * 32768 + 32768) / 64);
  return (hi * 4096 + lo) | 0;
}

/** Index of interleaved stereo frame `frame` in `pcm`. */
export function frameIndex(pcm: Float32Array, frame = 0): number {
  return sampleIndexAt(pcm[frame * 2], pcm[frame * 2 + 1]);
}

/** First frame (≥ `from`) whose index is not previous + 1, or -1 when contiguous. */
export function firstDiscontinuity(indices: ArrayLike<number>, from = 1): number {
  for (let i = Math.max(1, from); i < indices.length; i++) {
    if (indices[i] !== indices[i - 1] + 1) return i;
  }
  return -1;
}
