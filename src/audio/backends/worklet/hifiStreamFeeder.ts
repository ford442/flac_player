/**
 * Main-thread writer and flow control for the hi-fi streaming ring in `flac-processor`.
 *
 * Shared transport (SharedArrayBuffer, COOP/COEP): {@link HifiStreamFeeder.push}
 * copies PCM straight into the play ring the processor reads (playRingSAB.ts);
 * fill is read from the ring's own counters. Chunk fallback: the caller posts
 * `chunk` messages and fill is estimated from `written` − the processor's
 * `consumed`.
 *
 * The decode pipeline awaits {@link HifiStreamFeeder.waitForSpace} before each
 * chunk, so it stops pushing while playback is paused or the ring is near full
 * (instead of overflowing the ring and silently dropping samples). The main
 * thread cannot `Atomics.wait`, so waiters re-check on the processor's ~100 ms
 * `position` message ({@link HifiStreamFeeder.noteConsumed}) — the ring holds
 * seconds of audio, far more than that tick.
 */
import {
  playRingPush,
  playRingReadPos,
  playRingSetEnded,
  playRingWritePos,
  ringDistance,
  type PlayRing,
} from '../../worklets/playRingSAB';

/** Pause the decoder when the worklet ring is above this fraction full. */
export const HIFI_RING_HIGH_WATER = 0.75;

export class HifiStreamFeeder {
  private written = 0;
  private consumed = 0;
  /** Shared ring: write position at the last seek, until the reader has skipped to it. */
  private seekFloor: number | null = null;
  private paused = false;
  private waiters: Array<() => void> = [];

  /**
   * @param capacity ring size in floats
   * @param ring shared play ring (writer side); null → chunk-message fallback
   */
  constructor(private readonly capacity: number, readonly ring: PlayRing | null = null) {}

  /** Interleaved samples queued in the ring but not yet played. */
  get buffered(): number {
    const ring = this.ring;
    if (!ring) return Math.max(0, this.written - this.consumed);
    const write = playRingWritePos(ring);
    let read = playRingReadPos(ring);
    if (this.seekFloor !== null) {
      // Until the processor applies seekStream, samples before the floor are dead.
      if (ringDistance(ring, read, this.seekFloor) <= ringDistance(ring, read, write)) read = this.seekFloor;
      else this.seekFloor = null;
    }
    return ringDistance(ring, read, write);
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Shared ring write position (tags `markSegment` / `seekStream`); undefined on the chunk fallback. */
  get writePos(): number | undefined {
    return this.ring ? playRingWritePos(this.ring) : undefined;
  }

  canAccept(samples: number): boolean {
    if (this.paused) return false;
    const buffered = this.buffered;
    // Always admit into an empty ring so an oversized chunk cannot deadlock.
    if (buffered === 0) return true;
    return buffered + samples <= this.capacity * HIFI_RING_HIGH_WATER;
  }

  /** Resolves when the chunk may be written, or when `signal` aborts. */
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

  /** Shared ring: copy `pcm` in. Returns floats stored (short only if the ring is full). */
  push(pcm: Float32Array): number {
    if (!this.ring) throw new Error('HifiStreamFeeder.push needs a shared ring');
    return playRingPush(this.ring, pcm);
  }

  /** Chunk fallback: `samples` were posted to the processor. */
  noteWritten(samples: number): void {
    this.written += samples;
  }

  /** Shared ring: the decoder has written its last sample. Returns false on the chunk fallback. */
  markEnded(): boolean {
    if (!this.ring) return false;
    playRingSetEnded(this.ring, true);
    return true;
  }

  /** Processor `position` message (`consumed` since the last seek); wakes waiters. */
  noteConsumed(total: number): void {
    this.consumed = total;
    this.wake();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.wake();
  }

  /**
   * Ring emptied by a seek; pause state is kept. Returns the shared ring position
   * the processor must skip to (`seekStream.readFrom`), undefined on the fallback.
   */
  reset(): number | undefined {
    this.written = 0;
    this.consumed = 0;
    let readFrom: number | undefined;
    if (this.ring) {
      playRingSetEnded(this.ring, false);
      readFrom = playRingWritePos(this.ring);
      this.seekFloor = readFrom;
    }
    this.wake();
    return readFrom;
  }

  /** Release every waiter (stream cancelled / torn down). */
  release(): void {
    this.paused = false;
    this.written = 0;
    this.consumed = 0;
    this.seekFloor = null;
    this.wake();
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }
}
