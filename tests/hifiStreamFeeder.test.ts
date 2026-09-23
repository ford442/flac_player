import { describe, it, expect } from 'vitest';
import { HifiStreamFeeder, HIFI_RING_HIGH_WATER } from '../src/audio/backends/worklet/hifiStreamFeeder';

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
