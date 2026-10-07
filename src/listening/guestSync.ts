// Listening rooms — guest side: make local playback follow the host reference.
//
// `reconcile()` is idempotent: call it whenever a new reference arrives and on
// a ~1 s tick. It loads the host's track, matches play/pause, and corrects
// drift via syncEngine (nudge playbackRate or seek). No React, no sockets.

import type { SyncClock } from '../types/audio';
import { localNow } from './clockSync';
import {
  DRIFT_THRESHOLD_MS,
  PAUSED_POSITION_TOLERANCE_S,
  SEEK_COOLDOWN_MS,
  computeDriftMs,
  decideCorrection,
  expectedPosition,
  isOutOfSync,
  updateSeekLead,
} from './syncEngine';
import type { PlaybackReference } from './types';

export interface GuestPlayerAdapter {
  /** Clock of the loaded native track, or null while nothing usable is loaded. */
  getClock(): SyncClock | null;
  /** Track id currently loaded in the backend (not merely selected in the UI). */
  getLoadedTrackId(): string | null;
  /** Load without starting playback; resolves false when the track cannot be resolved. */
  loadTrack(trackId: string, trackIndex: number): Promise<boolean>;
  /** Rejects with a NotAllowedError when the browser blocks autoplay. */
  play(): Promise<void> | void;
  pause(): void;
  seek(seconds: number): void;
  setRate(rate: number): void;
}

export interface GuestSyncStatus {
  /** Positive = ahead of the host; null when not comparable (paused / loading). */
  driftMs: number | null;
  outOfSync: boolean;
  /** Autoplay blocked: the user must click once to start audio. */
  needsUserGesture: boolean;
  /** The host's track could not be resolved from the catalog. */
  trackUnavailable: boolean;
  loading: boolean;
}

export const INITIAL_GUEST_STATUS: GuestSyncStatus = {
  driftMs: null,
  outOfSync: false,
  needsUserGesture: false,
  trackUnavailable: false,
  loading: false,
};

/** Initial seek lead before any measurement (typical range-request buffering). */
const INITIAL_SEEK_LEAD_MS = 150;
/** A play() promise that never settles (suspended context) stops blocking retries after this. */
const PLAY_PENDING_TIMEOUT_MS = 5000;

export function isAutoplayBlocked(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'NotAllowedError';
}

export class GuestSync {
  private reference: PlaybackReference | null = null;
  private loadingTrackId: string | null = null;
  private failedTrackId: string | null = null;
  private lastSeekAt = -Infinity;
  private measureResidual = false;
  private seekLeadMs = INITIAL_SEEK_LEAD_MS;
  private nudging = false;
  private appliedRate: number | null = null;
  private playRequestedAt: number | null = null;
  private needsUserGesture = false;
  private driftMs: number | null = null;
  private status: GuestSyncStatus = INITIAL_GUEST_STATUS;
  private disposed = false;

  constructor(
    private readonly adapter: GuestPlayerAdapter,
    private readonly serverNow: () => number,
    private readonly onStatus: (status: GuestSyncStatus) => void = () => {},
    private readonly now: () => number = localNow,
  ) {}

  getReference(): PlaybackReference | null {
    return this.reference;
  }

  getSeekLeadMs(): number {
    return this.seekLeadMs;
  }

  setReference(reference: PlaybackReference): void {
    if (reference.trackId !== this.reference?.trackId) this.failedTrackId = null;
    this.reference = reference;
    this.reconcile();
  }

  /** Call from a click handler: clears autoplay/track failures and retries now. */
  unlock(): void {
    this.needsUserGesture = false;
    this.failedTrackId = null;
    this.playRequestedAt = null;
    this.reconcile();
  }

  dispose(): void {
    this.disposed = true;
  }

  reconcile(): void {
    if (this.disposed) return;
    const ref = this.reference;
    if (!ref) return;

    if (ref.trackId === null) {
      if (this.adapter.getClock()?.isSyncPlaying()) this.adapter.pause();
      this.driftMs = null;
      this.emit();
      return;
    }

    if (this.adapter.getLoadedTrackId() !== ref.trackId) {
      this.startLoad(ref.trackId, ref.trackIndex);
      return;
    }

    const clock = this.adapter.getClock();
    if (!clock) {
      this.driftMs = null;
      this.emit();
      return;
    }

    const local = clock.getSyncPosition();
    const expected = expectedPosition(ref, this.serverNow());

    if (!ref.playing) {
      this.resetRate(ref.rate);
      if (clock.isSyncPlaying()) this.adapter.pause();
      if (Math.abs(local - ref.position) > PAUSED_POSITION_TOLERANCE_S && !clock.isSyncSeeking()) {
        this.adapter.seek(ref.position);
      }
      this.driftMs = null;
      this.emit();
      return;
    }

    if (!clock.isSyncPlaying()) {
      // Ended locally before the host's TRACK_CHANGE arrived: wait, do not restart.
      if (clock.isSyncEnded() || this.needsUserGesture || this.isPlayPending()) {
        this.emit();
        return;
      }
      this.driftMs = computeDriftMs(local, expected);
      if (Math.abs(this.driftMs) > DRIFT_THRESHOLD_MS) {
        this.seekTo(expected + (this.seekLeadMs * ref.rate) / 1000);
      }
      this.resetRate(ref.rate);
      this.startPlayback();
      this.emit();
      return;
    }

    if (clock.isSyncSeeking() || this.now() - this.lastSeekAt < SEEK_COOLDOWN_MS) {
      this.emit();
      return;
    }

    const driftMs = computeDriftMs(local, expected);
    this.driftMs = driftMs;
    if (this.measureResidual) {
      this.seekLeadMs = updateSeekLead(this.seekLeadMs, driftMs);
      this.measureResidual = false;
    }

    const correction = decideCorrection({
      driftMs,
      expectedPosition: expected,
      baseRate: ref.rate,
      nudging: this.nudging,
      seekLeadMs: this.seekLeadMs,
    });
    if (correction.kind === 'seek') {
      this.resetRate(ref.rate);
      this.seekTo(correction.position);
    } else {
      this.nudging = correction.kind === 'nudge';
      this.applyRate(correction.rate);
    }
    this.emit();
  }

  private startLoad(trackId: string, trackIndex: number): void {
    if (this.loadingTrackId === trackId || this.failedTrackId === trackId) {
      this.emit();
      return;
    }
    this.loadingTrackId = trackId;
    // A fresh src resets the element's playbackRate.
    this.appliedRate = null;
    this.nudging = false;
    this.driftMs = null;
    this.playRequestedAt = null;
    this.emit();

    const settle = (ok: boolean) => {
      if (this.disposed || this.loadingTrackId !== trackId) return;
      this.loadingTrackId = null;
      if (!ok) this.failedTrackId = trackId;
      this.reconcile();
    };
    this.adapter.loadTrack(trackId, trackIndex).then(settle, () => settle(false));
  }

  private isPlayPending(): boolean {
    return this.playRequestedAt !== null && this.now() - this.playRequestedAt < PLAY_PENDING_TIMEOUT_MS;
  }

  private startPlayback(): void {
    const requestedAt = this.now();
    this.playRequestedAt = requestedAt;
    const done = () => {
      if (this.playRequestedAt === requestedAt) this.playRequestedAt = null;
    };
    const fail = (err: unknown) => {
      done();
      if (isAutoplayBlocked(err)) {
        this.needsUserGesture = true;
        this.emit();
      }
    };
    try {
      Promise.resolve(this.adapter.play()).then(done, fail);
    } catch (err) {
      fail(err);
    }
  }

  private seekTo(position: number): void {
    this.adapter.seek(Math.max(0, position));
    this.lastSeekAt = this.now();
    this.measureResidual = true;
    this.nudging = false;
  }

  private applyRate(rate: number): void {
    if (this.appliedRate === rate) return;
    this.adapter.setRate(rate);
    this.appliedRate = rate;
  }

  private resetRate(baseRate: number): void {
    this.nudging = false;
    this.applyRate(baseRate);
  }

  private emit(): void {
    const ref = this.reference;
    const next: GuestSyncStatus = {
      driftMs: this.driftMs,
      outOfSync: isOutOfSync(this.driftMs),
      needsUserGesture: this.needsUserGesture,
      trackUnavailable: ref?.trackId != null && this.failedTrackId === ref.trackId,
      loading: this.loadingTrackId !== null,
    };
    const prev = this.status;
    const driftChanged = prev.driftMs === null || next.driftMs === null
      ? prev.driftMs !== next.driftMs
      : Math.abs(prev.driftMs - next.driftMs) >= 20;
    if (
      driftChanged
      || prev.outOfSync !== next.outOfSync
      || prev.needsUserGesture !== next.needsUserGesture
      || prev.trackUnavailable !== next.trackUnavailable
      || prev.loading !== next.loading
    ) {
      this.status = next;
      this.onStatus(next);
    }
  }
}
