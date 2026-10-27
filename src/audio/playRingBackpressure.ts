/** Matches C++ PLAY_RING_CAPACITY (play_ring.h): 2^19 floats, ~2.7 s of 96 kHz stereo. */
export const PLAY_RING_CAPACITY_FLOATS = 1 << 19;

/** Pause the JS decoder when the C++ play ring is above this fraction full. */
export const PLAY_RING_HIGH_WATER = 0.75;

export function playRingShouldPause(
  fill: number,
  capacity: number,
  highWater = PLAY_RING_HIGH_WATER
): boolean {
  if (capacity <= 0) return false;
  return fill > capacity * highWater;
}

/**
 * Two-segment wrap copy used by pcm_ring_write / play_ring_push.
 * If `samples.length >= dest.length`, only the newest `cap` samples are kept.
 */
export function wrapWriteFloats(
  dest: Float32Array,
  writePos: number,
  samples: Float32Array
): number {
  const cap = dest.length;
  if (cap === 0 || samples.length === 0) return writePos;

  let srcOffset = 0;
  let count = samples.length;
  if (count >= cap) {
    srcOffset = count - cap;
    count = cap;
  }

  const idx = writePos % cap;
  const first = Math.min(count, cap - idx);
  dest.set(samples.subarray(srcOffset, srcOffset + first), idx);
  if (count > first) {
    dest.set(samples.subarray(srcOffset + first, srcOffset + count), 0);
  }
  return writePos + count;
}
