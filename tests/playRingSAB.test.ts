import { describe, expect, it } from 'vitest';
import {
  PLAY_RING_READ_POS,
  PLAY_RING_WRITE_POS,
  attachPlayRing,
  createPlayRing,
  pcmTapWrite,
  playRingFill,
  playRingPush,
  playRingReadFrames,
  playRingReadInterleaved,
  playRingSkipTo,
  ringAdvance,
  ringDistance,
  type PlayRing,
} from '../src/audio/worklets/playRingSAB';

const seq = (from: number, n: number) => Float32Array.from({ length: n }, (_, i) => from + i);

/** A ring whose positions wrap after 3 laps, parked `offset` floats before the wrap. */
function nearWrap(capacity: number, offset: number): PlayRing {
  const base = createPlayRing(capacity, false);
  const ring = { ...base, wrap: capacity * 3 };
  ring.header[PLAY_RING_WRITE_POS] = ring.wrap - offset;
  ring.header[PLAY_RING_READ_POS] = ring.wrap - offset;
  return ring;
}

describe('playRingSAB', () => {
  it('shares one SharedArrayBuffer between writer and reader views', () => {
    const writer = createPlayRing(64, true);
    expect(writer.buffer).toBeInstanceOf(SharedArrayBuffer);
    const reader = attachPlayRing(writer.buffer);
    expect(reader.capacity).toBe(64);
    playRingPush(writer, seq(1, 10));
    expect(playRingFill(reader)).toBe(10);
  });

  it('push never overwrites unread samples', () => {
    const ring = createPlayRing(8, false);
    expect(playRingPush(ring, seq(0, 6))).toBe(6);
    expect(playRingPush(ring, seq(6, 6))).toBe(2);
    expect(playRingFill(ring)).toBe(8);
  });

  it('reads deinterleaved frames across the data wrap', () => {
    const ring = createPlayRing(8, false);
    playRingPush(ring, seq(0, 6));
    const l = new Float32Array(4);
    const r = new Float32Array(4);
    expect(playRingReadFrames(ring, [l, r], 0, 2, 2)).toBe(2);
    playRingPush(ring, seq(6, 4)); // wraps in the data array
    expect(playRingReadFrames(ring, [l, r], 0, 4, 2)).toBe(3); // 6 floats queued = 3 frames
    expect(Array.from(l)).toEqual([4, 6, 8, 0]);
    expect(Array.from(r)).toEqual([5, 7, 9, 0]);
  });

  it('keeps samples continuous across the position wrap', () => {
    const ring = nearWrap(8, 4);
    playRingPush(ring, seq(0, 6));
    expect(ring.header[PLAY_RING_WRITE_POS]).toBe(2);
    expect(playRingFill(ring)).toBe(6);
    const dest = new Float32Array(6);
    expect(playRingReadInterleaved(ring, dest, 0, 3, 2)).toBe(3);
    expect(Array.from(dest)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(ringDistance(ring, ring.wrap - 4, 2)).toBe(6);
    expect(ringAdvance(ring, ring.wrap - 4, 6)).toBe(2);
  });

  it('skipTo drops samples before the fence, or reports overshoot past it', () => {
    const ring = createPlayRing(16, false);
    playRingPush(ring, seq(0, 8));
    expect(playRingSkipTo(ring, 6)).toBe(0);
    expect(ring.header[PLAY_RING_READ_POS]).toBe(6);
    const dest = new Float32Array(2);
    playRingReadInterleaved(ring, dest, 0, 1, 2);
    expect(playRingSkipTo(ring, 6)).toBe(2); // already read 2 floats past the fence
    expect(ring.header[PLAY_RING_READ_POS]).toBe(8);
  });

  it('tap writer overwrites on full', () => {
    const ring = createPlayRing(4, false);
    pcmTapWrite(ring, [seq(0, 3), seq(10, 3)], 3, 2);
    expect(Array.from(ring.data)).toEqual([2, 12, 1, 11]);
    expect(ring.header[PLAY_RING_WRITE_POS]).toBe(6);
  });
});
