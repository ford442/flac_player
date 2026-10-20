// localStorage persistence for the player store (#258): resume position, queue, volume.

import { saveQueueToStorage } from '../storage/queueStorage';
import { trackSource } from '../types/track';
import type { PlaylistTrack } from '../types/library';
import type { PlayerStore, QueueState } from './playerStore';

/** `{ trackId, time }` of the last saved playback position. */
export const POSITION_STORAGE_KEY = 'flac_position';
export const VOLUME_STORAGE_KEY = 'flac_volume';
export const POSITION_SAVE_INTERVAL_MS = 5000;

export function readSavedPosition(trackId: string, storage: Storage | null = safeLocalStorage()): number | null {
  try {
    const saved = JSON.parse(storage?.getItem(POSITION_STORAGE_KEY) ?? 'null') as { trackId?: unknown; time?: unknown } | null;
    if (saved?.trackId !== trackId || typeof saved.time !== 'number' || !(saved.time > 0)) return null;
    return saved.time;
  } catch {
    return null;
  }
}

export function readStoredVolume(storage: Storage | null = safeLocalStorage()): number {
  try {
    const v = parseFloat(storage?.getItem(VOLUME_STORAGE_KEY) ?? '1');
    return Number.isNaN(v) ? 1 : Math.max(0, Math.min(1, v));
  } catch {
    return 1;
  }
}

/** Local files cannot survive a reload (their `File` and blob URL die with the page). */
export function persistableQueue(queue: QueueState): QueueState {
  if (!queue.tracks.some((t) => trackSource(t) === 'local')) return queue;
  const current = queue.tracks[queue.currentIndex];
  const tracks = queue.tracks.filter((t) => trackSource(t) !== 'local');
  return { ...queue, tracks, currentIndex: current ? tracks.indexOf(current) : -1 };
}

export interface PersistOptions {
  /** Save the resume position (off for shared playlists and room guests). */
  position: boolean;
  /** Save the queue (off for shared playlists and room guests). */
  queue: boolean;
  storage?: Storage | null;
}

/**
 * Write the store to localStorage as it changes. The position comes from the
 * engine clock every 5 s and on pagehide, never from a React render (#258 bug 4).
 */
export function persistPlayerState(
  clock: { now(): number },
  store: PlayerStore,
  { position, queue, storage = safeLocalStorage() }: PersistOptions,
): () => void {
  if (!storage) return () => {};
  const cleanups: Array<() => void> = [];

  if (position) {
    const savePosition = () => {
      const { currentTrack, duration } = store.getState().transport;
      const time = clock.now();
      if (!currentTrack || !(time > 0) || !(duration > 0)) return;
      write(storage, POSITION_STORAGE_KEY, JSON.stringify({ trackId: currentTrack.id, time }));
    };
    const timer = setInterval(savePosition, POSITION_SAVE_INTERVAL_MS);
    window.addEventListener('pagehide', savePosition);
    cleanups.push(() => {
      clearInterval(timer);
      window.removeEventListener('pagehide', savePosition);
    });
  }

  cleanups.push(store.subscribe((state, prev) => {
    if (queue && state.queue !== prev.queue) {
      const { tracks, currentIndex, shuffle, repeatMode } = persistableQueue(state.queue);
      saveQueueToStorage({ tracks: tracks.map(withoutFile), currentIndex, shuffle, repeat: repeatMode });
    }
    if (state.settings.volume !== prev.settings.volume) {
      write(storage, VOLUME_STORAGE_KEY, String(state.settings.volume));
    }
  }));

  return () => cleanups.forEach((fn) => fn());
}

function withoutFile(track: PlaylistTrack): PlaylistTrack {
  if (!track.file) return track;
  const { file: _file, ...rest } = track;
  void _file;
  return rest;
}

function write(storage: Storage, key: string, value: string): void {
  try { storage.setItem(key, value); } catch { /* quota or private mode */ }
}

function safeLocalStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}
