/**
 * Main-thread flow control for the hi-fi streaming ring in `flac-processor`.
 *
 * The decode pipeline awaits {@link HifiStreamFeeder.waitForSpace} before each
 * chunk, so it stops pushing while playback is paused or the ring is near full
 * (instead of overflowing the ring and silently dropping samples).
 */

/** Pause the decoder when the worklet ring is above this fraction full. */
export const HIFI_RING_HIGH_WATER = 0.75;

export class HifiStreamFeeder {
  private written = 0;
  private consumed = 0;
  private paused = false;
  private waiters: Array<() => void> = [];

  constructor(private readonly capacity: number) {}

  /** Interleaved samples queued in the ring but not yet played (estimate). */
  get buffered(): number {
    return Math.max(0, this.written - this.consumed);
  }

  get isPaused(): boolean {
    return this.paused;
  }

  canAccept(samples: number): boolean {
    if (this.paused) return false;
    // Always admit into an empty ring so an oversized chunk cannot deadlock.
    if (this.buffered === 0) return true;
    return this.buffered + samples <= this.capacity * HIFI_RING_HIGH_WATER;
  }

  /** Resolves when the chunk may be posted, or when `signal` aborts. */
  async waitForSpace(samples: number, signal?: AbortSignal): Promise<void> {
    while (!this.canAccept(samples) && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        const done = () => {
          signal?.removeEventListener('abort', done);
          resolve();
        };
        this.waiters.push(done);
        signal?.addEventListener('abort', done, { once: true });
      });
    }
  }

  noteWritten(samples: number): void {
    this.written += samples;
  }

  /** Called from the processor's `position` message (`consumed` total). */
  noteConsumed(total: number): void {
    this.consumed = total;
    this.wake();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.wake();
  }

  /** Release every waiter (stream cancelled / torn down). */
  release(): void {
    this.paused = false;
    this.written = 0;
    this.consumed = 0;
    this.wake();
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }
}
