// Listening rooms — glue between the PlaybackEngine and useListeningRoom.
//
// Builds the stable player adapter the room drives, resolves room track ids
// to catalog tracks, and keeps the engine on the streaming/native clock while
// a room is active (MVP: streaming backend only).

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { PlaylistTrack } from '../types/library';
import { fetchSong, fetchSongs } from '../api/songApi';
import { sharedAudioContextManager } from '../audio/AudioContextManager';
import type { PlaybackEngine } from '../player/PlaybackEngine';
import type { PlayerStore } from '../player/playerStore';
import { hasLoadedTrack } from '../player/transport';
import { useQueue, useSettings, useTransport } from '../player/selectors';
import { trackSource } from '../types/track';
import { useListeningRoom, type ListeningRoomPlayer, type UseListeningRoomResult } from './useListeningRoom';
import type { HostSample } from './hostPublisher';
import type { RoomQueueState, RoomRole } from './types';

/** Above this many unknown ids, one library page beats per-track lookups. */
const BULK_RESOLVE_THRESHOLD = 8;
const MAX_SINGLE_LOOKUPS = 25;
const LIBRARY_RESOLVE_LIMIT = 1000;
/** How long to wait for AudioContext.resume() before asking for a click. */
const RESUME_TIMEOUT_MS = 500;

/** Only library tracks have a catalog id a guest can resolve; local files and URL tracks do not. */
export function isShareableTrackId(id: string | undefined | null): id is string {
  return !!id && trackSource({ id }) === 'library';
}

export interface ListeningRoomBridgeOptions {
  initialRoomId: string | null;
  engine: PlaybackEngine;
  store: PlayerStore;
  /** Library rows already in memory (resolve room ids without a request). */
  library: PlaylistTrack[];
  addToast: (message: string, type: 'success' | 'error' | 'info') => void;
  onLeft?: (role: RoomRole) => void;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function useListeningRoomBridge(options: ListeningRoomBridgeOptions): UseListeningRoomResult {
  const { engine, store } = options;
  const latest = useRef(options);
  latest.current = options;

  const trackCacheRef = useRef(new Map<string, PlaylistTrack>());
  const libraryFetchRef = useRef<Promise<void> | null>(null);
  const queueApplySeqRef = useRef(0);
  const suppressHostSampleRef = useRef(false);
  const reloadedForRef = useRef<string | null>(null);

  const resolveTracks = useCallback(async (ids: string[]): Promise<Map<string, PlaylistTrack>> => {
    const cache = trackCacheRef.current;
    const remember = (tracks: PlaylistTrack[]) => {
      for (const track of tracks) cache.set(track.id, track);
    };
    remember(latest.current.library);
    remember(store.getState().queue.tracks);
    let missing = ids.filter((id) => isShareableTrackId(id) && !cache.has(id));
    if (missing.length > BULK_RESOLVE_THRESHOLD) {
      libraryFetchRef.current ??= fetchSongs({ limit: LIBRARY_RESOLVE_LIMIT })
        .then(({ tracks }) => remember(tracks))
        .catch(() => { libraryFetchRef.current = null; });
      await libraryFetchRef.current;
      missing = missing.filter((id) => !cache.has(id));
    }
    await Promise.all(missing.slice(0, MAX_SINGLE_LOOKUPS).map(async (id) => {
      try {
        remember([await fetchSong(id)]);
      } catch { /* unresolvable; the guest shows "track unavailable" */ }
    }));
    return cache;
  }, [store]);

  const player = useMemo<ListeningRoomPlayer>(() => ({
    getClock: () => engine.getSyncClock(),

    getLoadedTrackId: () => {
      const { currentTrack, status } = store.getState().transport;
      if (!currentTrack || !hasLoadedTrack(status) || !engine.getSyncClock()) return null;
      return currentTrack.id;
    },

    loadTrack: async (trackId) => {
      const track = (await resolveTracks([trackId])).get(trackId);
      if (!track) return false;
      const queueIndex = store.getState().queue.tracks.findIndex((t) => t.id === trackId);
      const ok = await engine.load(track, {
        index: queueIndex >= 0 ? queueIndex : undefined,
        autoplay: false,
        restorePosition: false,
      });
      return ok && engine.getSyncClock() !== null;
    },

    play: async () => {
      // resume() must start inside the click that unlocks audio, before any await.
      if (sharedAudioContextManager.hasContext()) {
        const ctx = sharedAudioContextManager.getContext();
        if (ctx.state !== 'running') {
          const resumed = await Promise.race([
            ctx.resume().then(() => true, () => false),
            wait(RESUME_TIMEOUT_MS).then(() => false),
          ]);
          if (!resumed || (ctx.state as AudioContextState) !== 'running') {
            throw new DOMException('Click to start listening', 'NotAllowedError');
          }
        }
      }
      if (await engine.play() === 'blocked') throw new DOMException('Click to start listening', 'NotAllowedError');
    },

    pause: () => engine.pause(),
    seek: (seconds) => engine.seek(seconds),
    setRate: (rate) => engine.nudgeRate(rate),

    getHostSample: (): HostSample | null => {
      const { transport, queue } = store.getState();
      const { currentTrack, status } = transport;
      if (suppressHostSampleRef.current || !currentTrack || !isShareableTrackId(currentTrack.id)) return null;
      if (status === 'loading') {
        return { trackId: currentTrack.id, trackIndex: queue.currentIndex, position: 0, playing: false, rate: 1, loading: true };
      }
      const clock = engine.getSyncClock();
      if (!clock) return null;
      return {
        trackId: currentTrack.id,
        trackIndex: queue.currentIndex,
        position: clock.getSyncPosition(),
        playing: clock.isSyncPlaying(),
        rate: clock.getSyncRate(),
      };
    },

    applyQueue: (roomQueue: RoomQueueState, currentTrackId: string | null) => {
      const seq = ++queueApplySeqRef.current;
      void resolveTracks(roomQueue.trackIds).then((cache) => {
        if (seq !== queueApplySeqRef.current) return;
        const tracks = roomQueue.trackIds.map((id) => cache.get(id)).filter((t): t is PlaylistTrack => !!t);
        engine.setQueue(tracks, {
          currentIndex: currentTrackId ? tracks.findIndex((t) => t.id === currentTrackId) : -1,
          shuffle: roomQueue.shuffle,
          repeatMode: roomQueue.repeat,
        });
      });
    },
  }), [engine, store, resolveTracks]);

  const queueTracks = useQueue((q) => q.tracks);
  const queueCurrentIndex = useQueue((q) => q.currentIndex);
  const shuffle = useQueue((q) => q.shuffle);
  const repeatMode = useQueue((q) => q.repeatMode);
  const roomQueue = useMemo<RoomQueueState>(() => ({
    trackIds: queueTracks.map((t) => t.id).filter(isShareableTrackId),
    currentIndex: queueCurrentIndex,
    shuffle,
    repeat: repeatMode,
  }), [queueTracks, queueCurrentIndex, shuffle, repeatMode]);

  // Discrete playback events only (track, load, play/pause, seek): the room's 1 s tick covers drift.
  const playbackKey = useTransport((t) => `${t.currentTrack?.id ?? ''}|${t.loadingTrackId ?? ''}|${t.status}|${t.seekCount}`);

  const room = useListeningRoom({
    initialRoomId: options.initialRoomId,
    player,
    playbackKey,
    queue: roomQueue,
    onNotify: options.addToast,
    onLeft: options.onLeft,
  });
  const role = room.endedReason ? null : room.role;

  // Room clock = native <audio>; guests also stop advancing their own queue.
  useEffect(() => {
    engine.setSyncMode(role ?? 'off');
  }, [engine, role]);

  // MVP rooms run on the streaming backend only; the engine resumes the loaded track there.
  const outputMode = useSettings((s) => s.outputMode);
  useEffect(() => {
    if (!role || outputMode === 'streaming') return;
    engine.setOutputMode('streaming');
    latest.current.addToast('Listening rooms use the streaming backend', 'info');
  }, [engine, role, outputMode]);

  // Host: a track playing on the hi-fi/worklet path has no room clock — reload it natively in place.
  const currentTrack = useTransport((t) => t.currentTrack);
  const status = useTransport((t) => t.status);
  const graphGeneration = useTransport((t) => t.graphGeneration);
  useEffect(() => {
    if (role !== 'host' || !currentTrack || !isShareableTrackId(currentTrack.id)) return;
    if (!hasLoadedTrack(status) || outputMode !== 'streaming') return;
    if (engine.getSyncClock() || reloadedForRef.current === currentTrack.id) return;
    reloadedForRef.current = currentTrack.id;
    suppressHostSampleRef.current = true;
    const { queue } = store.getState();
    void engine.load(currentTrack, {
      index: queue.tracks[queue.currentIndex]?.id === currentTrack.id ? queue.currentIndex : undefined,
      autoplay: status === 'playing',
      restorePosition: false,
      startAt: engine.clock.now(),
      silent: true,
    }).finally(() => { suppressHostSampleRef.current = false; });
    // graphGeneration: a replaced backend may have lost the native path.
  }, [engine, store, role, currentTrack, status, outputMode, graphGeneration]);

  useEffect(() => {
    if (!role) reloadedForRef.current = null;
  }, [role]);

  return room;
}
