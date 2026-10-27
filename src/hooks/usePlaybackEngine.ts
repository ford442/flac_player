import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from 'react';
import type { PlaybackEngine, PlaybackStatus } from '../audio/PlaybackEngine';

/**
 * React side of the PlaybackEngine external store.
 *
 * - `usePlaybackStatus` re-renders only on discrete transport changes
 *   (play/pause, load, duration, capabilities) — never on `timeupdate`.
 * - `usePlaybackTime` re-renders on every clock tick; use it only in leaf
 *   components that print or draw the position (seek bars, time labels).
 * - `usePlaybackTimeRef` follows the clock without rendering (rAF loops).
 */
export const PlaybackEngineContext = createContext<PlaybackEngine | null>(null);

const noopSubscribe = () => () => {};
const zero = () => 0;

export function usePlaybackEngine(): PlaybackEngine | null {
  return useContext(PlaybackEngineContext);
}

export function usePlaybackStatus(engine: PlaybackEngine): PlaybackStatus {
  return useSyncExternalStore(engine.subscribe, engine.getStatus);
}

/** Current position (seconds); 0 outside a PlaybackEngineContext provider. */
export function usePlaybackTime(): number {
  const engine = usePlaybackEngine();
  return useSyncExternalStore(engine?.subscribe ?? noopSubscribe, engine?.getTime ?? zero);
}

export function usePlaybackTimeRef(): React.MutableRefObject<number> {
  const engine = usePlaybackEngine();
  const ref = useRef(engine?.getTime() ?? 0);
  useEffect(() => {
    if (!engine) return;
    ref.current = engine.getTime();
    return engine.subscribe(() => { ref.current = engine.getTime(); });
  }, [engine]);
  return ref;
}
