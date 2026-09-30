import { describe, it, expect } from 'vitest';
import { HifiStreamFeeder, HIFI_RING_HIGH_WATER } from '../src/audio/backends/worklet/hifiStreamFeeder';
import { PLAY_RING_READ_POS, createPlayRing, playRingEnded, playRingSkipTo } from '../src/audio/worklets/playRingSAB';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('HifiStreamFeeder', () => {
  it('admits chunks below the high-water mark', () => {
    const f = new HifiStreamFeeder(1000);
    f.noteWritten(500);
    expect(f.canAccept(1000 * HIFI_RING_HIGH_WATER - 500)).toBe(true);
    expect(f.canAccept(1000 * HIFI_RING_HIGH_WATER - 499)).toBe(false);
  });

  it('always admits into an empty ring (no deadlock on oversized chunks)', () => {
    expect(new HifiStreamFeeder(100).canAccept(10_000)).toBe(true);
  });

  it('blocks while paused and releases on resume', async () => {
    const f = new HifiStreamFeeder(1000);
    f.setPaused(true);
    let done = false;
    void f.waitForSpace(10).then(() => { done = true; });
    await tick();
    expect(done).toBe(false);
    f.setPaused(false);
    await tick();
    expect(done).toBe(true);
  });

  it('blocks when full and releases as the processor consumes', async () => {
    const f = new HifiStreamFeeder(1000);
    f.noteWritten(700);
    let done = false;
    void f.waitForSpace(100).then(() => { done = true; });
    await tick();
    expect(done).toBe(false);
    f.noteConsumed(200);
    await tick();
    expect(done).toBe(true);
  });

  it('releases waiters on abort', async () => {
    const f = new HifiStreamFeeder(1000);
    f.setPaused(true);
    const ac = new AbortController();
    let done = false;
    void f.waitForSpace(10, ac.signal).then(() => { done = true; });
    await tick();
    ac.abort();
    await tick();
    expect(done).toBe(true);
  });
});

describe('HifiStreamFeeder (shared play ring)', () => {
  it('measures fill from the ring counters', () => {
    const ring = createPlayRing(1000, true);
    const f = new HifiStreamFeeder(1000, ring);
    expect(f.push(new Float32Array(600))).toBe(600);
    expect(f.buffered).toBe(600);
    expect(f.canAccept(200)).toBe(false);
    ring.header[PLAY_RING_READ_POS] = 400; // the processor consumed 400
    expect(f.buffered).toBe(200);
    expect(f.canAccept(200)).toBe(true);
  });

  it('seek: fill drops at once, before the processor skips to the fence', () => {
    const ring = createPlayRing(1000, true);
    const f = new HifiStreamFeeder(1000, ring);
    f.push(new Float32Array(700));
    f.markEnded();
    const readFrom = f.reset();
    expect(readFrom).toBe(700);
    expect(playRingEnded(ring)).toBe(false);
    expect(f.buffered).toBe(0);
    f.push(new Float32Array(100)); // restarted decoder
    expect(f.buffered).toBe(100);
    playRingSkipTo(ring, readFrom!); // processor applies seekStream
    expect(f.buffered).toBe(100);
    ring.header[PLAY_RING_READ_POS] = 750;
    expect(f.buffered).toBe(50);
  });

  it('a paused, full feeder still releases on seek + resume (no deadlock)', async () => {
    const ring = createPlayRing(1000, true);
    const f = new HifiStreamFeeder(1000, ring);
    f.push(new Float32Array(750));
    f.setPaused(true);
    let done = false;
    void f.waitForSpace(100).then(() => { done = true; });
    await tick();
    f.reset();
    await tick();
    expect(done).toBe(false); // still paused
    f.setPaused(false);
    await tick();
    expect(done).toBe(true);
  });
});
