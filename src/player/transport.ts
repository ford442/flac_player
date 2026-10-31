/**
 * Transport state machine (#258).
 *
 *   idle → loading(token) → ready → playing ⇄ paused → ended
 *              └──────────────→ error(reason) ←──────┘
 *
 * Every state can start a new load or stop back to idle. `ready` is loaded but
 * not started (autoplay off, e.g. a listening-room guest waiting for the host).
 */
export type TransportStatus = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'ended' | 'error';

const NEXT: Record<TransportStatus, readonly TransportStatus[]> = {
  idle: ['loading'],
  loading: ['loading', 'ready', 'playing', 'error', 'idle'],
  ready: ['loading', 'playing', 'paused', 'ended', 'error', 'idle'],
  playing: ['loading', 'paused', 'ended', 'error', 'idle'],
  paused: ['loading', 'playing', 'ended', 'error', 'idle'],
  ended: ['loading', 'playing', 'paused', 'error', 'idle'],
  error: ['loading', 'idle'],
};

export function canTransition(from: TransportStatus, to: TransportStatus): boolean {
  return from === to || NEXT[from].includes(to);
}

/** A track is loaded into the backend (it can play, pause or seek). */
export function hasLoadedTrack(status: TransportStatus): boolean {
  return status === 'ready' || status === 'playing' || status === 'paused' || status === 'ended';
}
