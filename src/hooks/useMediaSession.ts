import { useEffect, useRef } from 'react';
import type { PlaylistTrack } from '../audioLoader';
import { publicUrl } from '../utils/publicUrl';

/**
 * Thin adapter from the playback controller to `navigator.mediaSession`
 * (lock screen, hardware media keys, Bluetooth headsets).
 *
 * It owns no playback logic: every OS action calls the same controller
 * methods the in-page keyboard shortcuts use. Position state follows the
 * PlaybackEngine clock through a subscription, throttled to ~1 Hz — no
 * re-render per tick, no extra rAF loop. Firefox support is partial
 * (metadata + play/pause; no artwork on some platforms, seekto support varies).
 */
export interface MediaSessionClock {
  subscribe(listener: () => void): () => void;
  getTime(): number;
}

export interface MediaSessionOptions {
  currentTrack: PlaylistTrack | null;
  isPlaying: boolean;
  /** Transport clock (the PlaybackEngine). */
  clock: MediaSessionClock;
  duration: number;
  playbackRate: number;
  onPlay: () => void;
  onPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
  /** Undefined when the active backend cannot seek. */
  onSeek?: (time: number) => void;
}

const FALLBACK_ARTWORK: MediaImage[] = [
  { src: publicUrl('icons/icon-192.png'), sizes: '192x192', type: 'image/png' },
  { src: publicUrl('icons/icon-512.png'), sizes: '512x512', type: 'image/png' },
];
const DEFAULT_SEEK_OFFSET = 10;
const POSITION_UPDATE_INTERVAL_MS = 1000;

type HandlerAction = 'play' | 'pause' | 'previoustrack' | 'nexttrack' | 'seekto' | 'seekbackward' | 'seekforward';
const ACTIONS: HandlerAction[] = ['play', 'pause', 'previoustrack', 'nexttrack', 'seekto', 'seekbackward', 'seekforward'];

function getMediaSession(): MediaSession | null {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return null;
  return navigator.mediaSession;
}

function guessImageType(url: string): string | undefined {
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  return undefined;
}

export function buildMediaMetadataInit(track: PlaylistTrack): MediaMetadataInit {
  const artwork: MediaImage[] = track.cover_url
    ? [{ src: track.cover_url, sizes: '512x512', ...(guessImageType(track.cover_url) ? { type: guessImageType(track.cover_url) } : {}) }]
    : FALLBACK_ARTWORK;
  return {
    title: track.title || track.name,
    artist: track.artist || track.author || '',
    album: track.genre || '',
    artwork,
  };
}

export function useMediaSession(options: MediaSessionOptions): void {
  const { currentTrack, isPlaying, clock, duration, playbackRate, onSeek } = options;

  // Latest options in a ref so handlers register once and never go stale.
  const optsRef = useRef(options);
  optsRef.current = options;
  const lastPositionUpdateRef = useRef(0);

  // Action handlers. Seek actions are only registered when the backend can
  // seek, so the OS hides its scrubber otherwise.
  const canSeek = Boolean(onSeek);
  useEffect(() => {
    const session = getMediaSession();
    if (!session) return;
    const seekRelative = (delta: number) => {
      const o = optsRef.current;
      if (!o.onSeek) return;
      const max = o.duration > 0 ? o.duration : Infinity;
      o.onSeek(Math.min(Math.max(o.clock.getTime() + delta, 0), max));
    };
    const handlers: Record<HandlerAction, MediaSessionActionHandler | null> = {
      play: () => optsRef.current.onPlay(),
      pause: () => optsRef.current.onPause(),
      previoustrack: () => optsRef.current.onPrevious(),
      nexttrack: () => optsRef.current.onNext(),
      seekto: canSeek
        ? (d) => { if (typeof d.seekTime === 'number') optsRef.current.onSeek?.(d.seekTime); }
        : null,
      seekbackward: canSeek ? (d) => seekRelative(-(d.seekOffset ?? DEFAULT_SEEK_OFFSET)) : null,
      seekforward: canSeek ? (d) => seekRelative(d.seekOffset ?? DEFAULT_SEEK_OFFSET) : null,
    };
    for (const action of ACTIONS) {
      try { session.setActionHandler(action, handlers[action]); } catch { /* unsupported action */ }
    }
    return () => {
      for (const action of ACTIONS) {
        try { session.setActionHandler(action, null); } catch { /* unsupported action */ }
      }
    };
  }, [canSeek]);

  // Leave no stale lock-screen entry after unmount.
  useEffect(() => () => {
    const session = getMediaSession();
    if (!session) return;
    session.metadata = null;
    session.playbackState = 'none';
  }, []);

  // Metadata follows the current track.
  useEffect(() => {
    const session = getMediaSession();
    if (!session) return;
    if (!currentTrack || typeof MediaMetadata === 'undefined') {
      session.metadata = null;
      return;
    }
    session.metadata = new MediaMetadata(buildMediaMetadataInit(currentTrack));
    lastPositionUpdateRef.current = 0;
  }, [currentTrack]);

  // Playback state. Muted still counts as "playing".
  useEffect(() => {
    const session = getMediaSession();
    if (!session) return;
    session.playbackState = currentTrack ? (isPlaying ? 'playing' : 'paused') : 'none';
    lastPositionUpdateRef.current = 0;
  }, [isPlaying, currentTrack]);

  // Position state follows the clock, throttled to ~1 Hz; duration / rate /
  // play-state changes push at once (the effect re-runs with a reset throttle).
  useEffect(() => {
    const session = getMediaSession();
    if (!session || typeof session.setPositionState !== 'function') return;
    if (!(duration > 0) || !Number.isFinite(duration)) return;
    const push = () => {
      const now = Date.now();
      if (now - lastPositionUpdateRef.current < POSITION_UPDATE_INTERVAL_MS) return;
      lastPositionUpdateRef.current = now;
      try {
        session.setPositionState({
          duration,
          playbackRate: playbackRate > 0 ? playbackRate : 1,
          position: Math.min(Math.max(clock.getTime(), 0), duration),
        });
      } catch { /* invalid state during track switch */ }
    };
    lastPositionUpdateRef.current = 0;
    push();
    return clock.subscribe(push);
  }, [clock, duration, playbackRate, isPlaying]);
}

export default useMediaSession;
