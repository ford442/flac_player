// First queue of the session (#258 phase 4, moved out of Player): a shared
// playlist link, a legacy `?tracks=` link, or the queue saved by the last visit.
// Runs once per mount; the saved queue is read here, not on every render (bug 12).

import { useEffect, useRef } from 'react';
import { fetchSharedPlaylist, fetchSongs } from '../api/songApi';
import { loadQueueFromStorage } from '../storage/queueStorage';
import type { PlaylistTrack } from '../types/library';
import { isAbortError, type PlaybackEngine } from '../player/PlaybackEngine';

interface BootstrapOptions {
  engine: PlaybackEngine;
  sharedPlaylistId: string | null;
  /** Room guests get their queue from the host's snapshot. */
  isRoomGuestRoute: boolean;
  notify: (message: string, type: 'success' | 'error' | 'info') => void;
  /** A shared or `?tracks=` playlist replaced the queue (`title` only for shared links). */
  onPlaylistOpened: (title?: string) => void;
}

/** Legacy `?tracks=` links resolve against this many library rows. */
const TRACKS_PARAM_LIBRARY_LIMIT = 500;

export function useAppBootstrap(options: BootstrapOptions): void {
  const latest = useRef(options);
  latest.current = options;
  const { engine, sharedPlaylistId, isRoomGuestRoute } = options;

  useEffect(() => {
    if (isRoomGuestRoute) return;
    const controller = new AbortController();
    const { signal } = controller;
    const { notify, onPlaylistOpened } = latest.current;

    const openPlaylist = (tracks: PlaylistTrack[], title?: string) => {
      engine.setQueue(tracks, { currentIndex: 0 });
      onPlaylistOpened(title);
    };

    void (async () => {
      if (sharedPlaylistId) {
        try {
          const shared = await fetchSharedPlaylist(sharedPlaylistId, signal);
          if (shared.tracks.length > 0) {
            openPlaylist(shared.tracks, shared.title);
            notify(`Loaded shared playlist: ${shared.title}`, 'success');
            return;
          }
        } catch (error) {
          if (isAbortError(error)) return;
          notify('Failed to load shared playlist', 'error');
        }
      }

      const tracksParam = new URLSearchParams(window.location.search).get('tracks');
      if (tracksParam) {
        try {
          const { tracks: library } = await fetchSongs({ limit: TRACKS_PARAM_LIBRARY_LIMIT }, signal);
          const byId = new Map(library.map((t) => [t.id, t]));
          const tracks = tracksParam.split(',').map((id) => byId.get(id)).filter((t): t is PlaylistTrack => !!t);
          if (tracks.length > 0) {
            openPlaylist(tracks);
            notify('Loaded custom playlist!', 'success');
            window.history.replaceState({}, '', window.location.pathname);
            return;
          }
        } catch (error) {
          if (isAbortError(error)) return;
        }
      }

      if (signal.aborted) return;
      const saved = loadQueueFromStorage();
      if (saved && saved.tracks.length > 0) {
        engine.setQueue(saved.tracks, {
          currentIndex: saved.currentIndex,
          shuffle: saved.shuffle,
          repeatMode: saved.repeat,
        });
      }
    })();

    return () => controller.abort();
  }, [engine, sharedPlaylistId, isRoomGuestRoute]);
}
