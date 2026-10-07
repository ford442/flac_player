// Listening rooms — drift detection and correction (pure functions).
//
// Guests compare their <audio> clock with the host reference extrapolated to
// "now" on the server clock, then either do nothing, nudge playbackRate
// (preservesPitch keeps this inaudible), or hard-seek.

import type { PlaybackReference } from './types';

/** Below this, leave playback alone. */
export const DRIFT_THRESHOLD_MS = 250;
/** Above this, seek immediately (also the "out of sync" badge threshold). */
export const HARD_SYNC_THRESHOLD_MS = 500;
/** A nudge that started keeps running until drift falls under this (hysteresis). */
export const SETTLED_DRIFT_MS = 60;
/** Fractional tempo change while nudging (±4%). */
export const NUDGE_RATE_DELTA = 0.04;
/** After a seek, let the element buffer before judging drift again. */
export const SEEK_COOLDOWN_MS = 1500;
/** Upper bound for the adaptive seek lead (compensates seek → playing latency). */
export const MAX_SEEK_LEAD_MS = 1000;
/** Paused guests re-seek only when off by more than this. */
export const PAUSED_POSITION_TOLERANCE_S = 0.25;

/** Host position (seconds) at `serverNowMs`, extrapolated while playing. */
export function expectedPosition(reference: PlaybackReference, serverNowMs: number): number {
  if (!reference.playing) return reference.position;
  const elapsedS = Math.max(0, serverNowMs - reference.positionUpdatedAt) / 1000;
  return reference.position + elapsedS * reference.rate;
}

/** Positive = guest ahead of the host. */
export function computeDriftMs(localPosition: number, expected: number): number {
  return (localPosition - expected) * 1000;
}

export type SyncCorrection =
  | { kind: 'none'; rate: number }
  | { kind: 'nudge'; rate: number }
  | { kind: 'seek'; position: number };

export interface CorrectionInput {
  driftMs: number;
  expectedPosition: number;
  /** Host playback rate; nudges are relative to it. */
  baseRate: number;
  /** True while a previous nudge is still converging. */
  nudging: boolean;
  /** Extra lead added to seek targets so the guest lands on time once buffered. */
  seekLeadMs: number;
}

export function decideCorrection({
  driftMs, expectedPosition: expected, baseRate, nudging, seekLeadMs,
}: CorrectionInput): SyncCorrection {
  const abs = Math.abs(driftMs);
  if (abs > HARD_SYNC_THRESHOLD_MS) {
    return { kind: 'seek', position: Math.max(0, expected + (seekLeadMs * baseRate) / 1000) };
  }
  if (abs > DRIFT_THRESHOLD_MS || (nudging && abs > SETTLED_DRIFT_MS)) {
    // Ahead → slow down; behind → speed up.
    const factor = driftMs > 0 ? 1 - NUDGE_RATE_DELTA : 1 + NUDGE_RATE_DELTA;
    return { kind: 'nudge', rate: baseRate * factor };
  }
  return { kind: 'none', rate: baseRate };
}

/**
 * Learn how long a seek takes to become audible. Measured after the cooldown:
 * a guest still behind (negative residual) needs more lead next time.
 */
export function updateSeekLead(previousLeadMs: number, residualDriftMs: number): number {
  const next = previousLeadMs - residualDriftMs * 0.5;
  return Math.min(MAX_SEEK_LEAD_MS, Math.max(0, next));
}

export function isOutOfSync(driftMs: number | null): boolean {
  return driftMs !== null && Math.abs(driftMs) > HARD_SYNC_THRESHOLD_MS;
}
