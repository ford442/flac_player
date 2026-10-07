// Listening rooms — host side: turn observed local playback into room events.
//
// The host does not instrument every UI handler. It observes its own clock
// (state changes + a ~1 s tick) and publishes when what guests would
// extrapolate from the last event stops matching reality:
//   track changed → TRACK_CHANGE, play/pause edge → PLAY/PAUSE,
//   position jump (seek, stall, rate change) → SEEK, otherwise HEARTBEAT every 5 s.

import { localNow } from './clockSync';
import type { ClientMessageMap, HostPlaybackPayload, RoomQueueState } from './types';

export const HEARTBEAT_INTERVAL_MS = 5000;
/** Deviation from the host's own extrapolation that counts as a seek. */
export const SEEK_DETECT_THRESHOLD_S = 0.5;
/** Coalesce scrubbing: at most one SEEK per window (the next tick sends the latest). */
export const SEEK_THROTTLE_MS = 300;

export interface HostSample {
  trackId: string | null;
  trackIndex: number;
  position: number;
  playing: boolean;
  rate: number;
  /** The host is still loading `trackId`; position/playing are placeholders. */
  loading?: boolean;
}

type PlaybackType = 'PLAY' | 'PAUSE' | 'SEEK' | 'TRACK_CHANGE' | 'HEARTBEAT';

export type HostSend = <T extends PlaybackType | 'QUEUE_UPDATE'>(type: T, payload: ClientMessageMap[T]) => boolean;

interface Published extends HostSample {
  /** Local ms when sampled. */
  at: number;
}

export class HostPublisher {
  private last: Published | null = null;
  private lastSentAt = -Infinity;
  private lastSeekSentAt = -Infinity;
  private lastQueueKey: string | null = null;

  constructor(
    private readonly send: HostSend,
    private readonly serverNow: () => number,
    private readonly now: () => number = localNow,
  ) {}

  /** Forget what guests have seen (after a reconnect) so the next observe re-publishes. */
  reset(): void {
    this.last = null;
    this.lastSentAt = -Infinity;
    this.lastSeekSentAt = -Infinity;
    this.lastQueueKey = null;
  }

  /** Returns the event type published, if any (for tests and debug logging). */
  observe(sample: HostSample | null): PlaybackType | null {
    // Nothing loaded (or a local file with no catalog id): guests keep extrapolating.
    if (!sample || sample.trackId === null) return null;
    const now = this.now();
    const last = this.last;

    if (sample.loading) {
      // Announce a *different* track right away so guests load in parallel.
      // Same track (restart / reload) or unknown guest state: wait for the real clock.
      return last && last.trackId !== sample.trackId
        ? this.publish('TRACK_CHANGE', { ...sample, position: 0, playing: false }, now)
        : null;
    }
    if (!last || last.trackId !== sample.trackId) return this.publish('TRACK_CHANGE', sample, now);
    if (last.playing !== sample.playing) return this.publish(sample.playing ? 'PLAY' : 'PAUSE', sample, now);

    const predicted = last.playing
      ? last.position + ((now - last.at) / 1000) * last.rate
      : last.position;
    const jumped = Math.abs(sample.position - predicted) > SEEK_DETECT_THRESHOLD_S;
    if (jumped || Math.abs(sample.rate - last.rate) > 1e-3) {
      if (now - this.lastSeekSentAt < SEEK_THROTTLE_MS) return null;
      this.lastSeekSentAt = now;
      return this.publish('SEEK', sample, now);
    }

    if (now - this.lastSentAt >= HEARTBEAT_INTERVAL_MS) return this.publish('HEARTBEAT', sample, now);
    return null;
  }

  /** Publish the queue when it differs from what guests last received. */
  publishQueue(queue: RoomQueueState): boolean {
    const key = JSON.stringify(queue);
    if (key === this.lastQueueKey) return false;
    if (!this.send('QUEUE_UPDATE', queue)) return false;
    this.lastQueueKey = key;
    return true;
  }

  private publish(type: PlaybackType, sample: HostSample, now: number): PlaybackType | null {
    const payload: HostPlaybackPayload = {
      trackId: sample.trackId as string,
      trackIndex: sample.trackIndex,
      position: Math.max(0, sample.position),
      playing: sample.playing,
      rate: sample.rate,
      sampledAt: Math.round(this.serverNow()),
    };
    if (!this.send(type, payload)) return null;
    this.last = { ...sample, loading: false, at: now };
    this.lastSentAt = now;
    return type;
  }
}
