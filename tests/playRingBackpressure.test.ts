import { describe, it, expect } from 'vitest';
import {
  PLAY_RING_CAPACITY_FLOATS,
  PLAY_RING_HIGH_WATER,
  playRingShouldPause,
  wrapWriteFloats,
} from '../src/audio/playRingBackpressure';

describe('playRingBackpressure', () => {
  it('documents the C++ play ring capacity', () => {
    expect(PLAY_RING_CAPACITY_FLOATS).toBe(384000);
  });

  it('pauses the decoder above 75% fill', () => {
    const cap = PLAY_RING_CAPACITY_FLOATS;
    expect(playRingShouldPause(cap * PLAY_RING_HIGH_WATER, cap)).toBe(false);
    expect(playRingShouldPause(cap * PLAY_RING_HIGH_WATER + 1, cap)).toBe(true);
    expect(playRingShouldPause(0, cap)).toBe(false);
    expect(playRingShouldPause(10, 0)).toBe(false);
  });

  it('wraps with two contiguous copies', () => {
    const dest = new Float32Array(8);
    const samples = new Float32Array([1, 2, 3, 4, 5]);
    const next = wrapWriteFloats(dest, 6, samples);
    expect(next).toBe(11);
    expect(Array.from(dest)).toEqual([3, 4, 5, 0, 0, 0, 1, 2]);
  });

  it('keeps the newest cap samples when the block is larger than the ring', () => {
    const dest = new Float32Array(4);
    const samples = new Float32Array([1, 2, 3, 4, 5, 6, 7]);
    wrapWriteFloats(dest, 0, samples);
    expect(Array.from(dest)).toEqual([4, 5, 6, 7]);
  });
});
