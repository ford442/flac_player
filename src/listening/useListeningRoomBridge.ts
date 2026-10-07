// Listening rooms — glue between usePlaybackController and useListeningRoom.
//
// Builds the stable player adapter the room drives, resolves room track ids
// to catalog tracks, and keeps the backend on the streaming/native clock
// while a room is active (MVP: streaming backend only).

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { AudioLoader, PlaylistTrack } from '../audioLoader';
import type { RepeatMode } from '../storage/queueStorage';
import type { AudioOutputMode } from '../hooks/usePlayerState';
import type { PlayTrackOptions } from '../hooks/usePlaybackController';
import type { ConfigurableAudioBackend, SyncClock } from '../types/audio';
import { sharedAudioContextManager } from '../audio/AudioContextManager';
import { useListeningRoom, type ListeningRoomPlayer, type UseListeningRoomResult } from './useListeningRoom';
import type { HostSample } from './hostPublisher';
import type { RoomQueueState, RoomRole } from './types';

/** Above this many unknown ids, one library page beats per-track lookups. */
const BULK_RESOLVE_THRESHOLD = 8;
const MAX_SINGLE_LOOKUPS = 25;
const LIBRARY_RESOLVE_LIMIT = 1000;
/** How long to wait for AudioContext.resume() before asking for a click. */
const RESUME_TIMEOUT_MS = 500;

/** Local files (`local-…`) have no catalog id and cannot be shared. */
export function isShareableTrackId(id: string | undefined | null): id is string {
  return !!id && !id.startsWith('local-');
}

export interface ListeningRoomBridgeOptions {
  initialRoomId: string | null;
  loader: AudioLoader;
  playback: {
    playerRef: React.MutableRefObject<ConfigurableAudioBackend | null>;
    playTrack: (track: PlaylistTrack, index?: number, options?: PlayTrackOptions) => Promise<boolean>;
    getSyncClock: () => SyncClock | null;
    setListeningSyncMode: (mode: 'off' | RoomRole) => void;
    /** Changes when the backend instance is replaced. */
    capabilities: unknown;
  };
  currentTrack: PlaylistTrack | null;
  loadingTrackId: string | undefined;
  isPlaying: boolean;
  isLoading: boolean;
  currentTime: number;
  queue: PlaylistTrack[];
  queueCurrentIndex: number;
  shuffle: boolean;
  repeatMode: RepeatMode;
  library: PlaylistTrack[];
  setQueue: (tracks: PlaylistTrack[]) => void;
  setQueueCurrentIndex: (index: number) => void;
  setShuffle: (shuffle: boolean) => void;
  setRepeatMode: (mode: RepeatMode) => void;
  outputMode: AudioOutputMode;
  setOutputMode: (mode: AudioOutputMode) => void;
  addToast: (message: string, type: 'success' | 'error' | 'info') => void;
  onLeft?: (role: RoomRole) => void;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function useListeningRoomBridge(options: ListeningRoomBridgeOptions): UseListeningRoomResult {
  const latest = useRef(options);
  latest.current = options;

  const trackCacheRef = useRef(new Map<string, PlaylistTrack>());
  const libraryFetchRef = useRef<Promise<void> | null>(null);
  const loadedRef = useRef<{ player: ConfigurableAudioBackend; trackId: string } | null>(null);
  const queueApplySeqRef = useRef(0);
  const suppressHostSampleRef = useRef(false);
  const resumeAfterSwitchRef = useRef<{ trackId: string; position: number; playing: boolean } | null>(null);
  const reloadedForRef = useRef<string | null>(null);

  const remember = (tracks: PlaylistTrack[]) => {
    for (const track of tracks) trackCacheRef.current.set(track.id, track);
  };

  const resolveTracks = useCallback(async (ids: string[]): Promise<Map<string, PlaylistTrack>> => {
    const { library, queue, loader } = latest.current;
    remember(library);
    remember(queue);
    const cache = trackCacheRef.current;
    let missing = ids.filter((id) => isShareableTrackId(id) && !cache.has(id));
    if (missing.length > BULK_RESOLVE_THRESHOLD) {
      libraryFetchRef.current ??= loader.fetchLibrary({ limit: LIBRARY_RESOLVE_LIMIT })
        .then(({ tracks }) => remember(tracks))
        .catch(() => { libraryFetchRef.current = null; });
      await libraryFetchRef.current;
      missing = missing.filter((id) => !cache.has(id));
    }
    await Promise.all(missing.slice(0, MAX_SINGLE_LOOKUPS).map(async (id) => {
      try {
        remember([await loader.fetchSong(id)]);
      } catch { /* unresolvable; the guest shows "track unavailable" */ }
    }));
    return cache;
  }, []);

  const player = useMemo<ListeningRoomPlayer>(() => ({
    getClock: () => latest.current.playback.getSyncClock(),

    getLoadedTrackId: () => {
      const { playback } = latest.current;
      const loaded = loadedRef.current;
      if (!loaded || loaded.player !== playback.playerRef.current || !playback.getSyncClock()) return null;
      return loaded.trackId;
    },

    loadTrack: async (trackId) => {
      const track = (await resolveTracks([trackId])).get(trackId);
      if (!track) return false;
      const { playback, queue } = latest.current;
      loadedRef.current = null;
      const queueIndex = queue.findIndex((t) => t.id === trackId);
      const ok = await playback.playTrack(track, queueIndex >= 0 ? queueIndex : undefined, {
        autoplay: false,
        restorePosition: false,
      });
      const backend = latest.current.playback.playerRef.current;
      if (!ok || !backend || !latest.current.playback.getSyncClock()) return false;
      loadedRef.current = { player: backend, trackId };
      return true;
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
      await latest.current.playback.playerRef.current?.play();
    },

    pause: () => latest.current.playback.playerRef.current?.pause(),
    seek: (seconds) => latest.current.playback.playerRef.current?.seek(seconds),
    setRate: (rate) => latest.current.playback.playerRef.current?.setPlaybackRate(rate),

    getHostSample: (): HostSample | null => {
      const { currentTrack, loadingTrackId, isLoading, queueCurrentIndex, playback } = latest.current;
      if (suppressHostSampleRef.current || !currentTrack || !isShareableTrackId(currentTrack.id)) return null;
      if (loadingTrackId || isLoading) {
        return { trackId: currentTrack.id, trackIndex: queueCurrentIndex, position: 0, playing: false, rate: 1, loading: true };
      }
      const clock = playback.getSyncClock();
      if (!clock) return null;
      return {
        trackId: currentTrack.id,
        trackIndex: queueCurrentIndex,
        position: clock.getSyncPosition(),
        playing: clock.isSyncPlaying(),
        rate: clock.getSyncRate(),
      };
    },

    applyQueue: (roomQueue: RoomQueueState, currentTrackId: string | null) => {
      const seq = ++queueApplySeqRef.current;
      void resolveTracks(roomQueue.trackIds).then((cache) => {
        if (seq !== queueApplySeqRef.current) return;
        const { setQueue, setQueueCurrentIndex, setShuffle, setRepeatMode } = latest.current;
        const tracks = roomQueue.trackIds.map((id) => cache.get(id)).filter((t): t is PlaylistTrack => !!t);
        setQueue(tracks);
        setQueueCurrentIndex(currentTrackId ? tracks.findIndex((t) => t.id === currentTrackId) : -1);
        setShuffle(roomQueue.shuffle);
        setRepeatMode(roomQueue.repeat);
      });
    },
  }), [resolveTracks]);

  const { currentTrack, queue, queueCurrentIndex, shuffle, repeatMode } = options;
  const roomQueue = useMemo<RoomQueueState>(() => ({
    trackIds: queue.map((t) => t.id).filter(isShareableTrackId),
    currentIndex: queueCurrentIndex,
    shuffle,
    repeat: repeatMode,
  }), [queue, queueCurrentIndex, shuffle, repeatMode]);

  const room = useListeningRoom({
    initialRoomId: options.initialRoomId,
    player,
    playbackKey: `${currentTrack?.id ?? ''}|${options.loadingTrackId ?? ''}|${options.isLoading}|${options.isPlaying}|${options.currentTime}`,
    queue: roomQueue,
    onNotify: options.addToast,
    onLeft: options.onLeft,
  });
  const role = room.endedReason ? null : room.role;

  // Room clock = native <audio>; guests also stop advancing their own queue.
  useEffect(() => {
    options.playback.setListeningSyncMode(role ?? 'off');
  }, [role, options.playback.setListeningSyncMode, options.playback.capabilities]);

  // MVP rooms run on the streaming backend only.
  useEffect(() => {
    if (!role || options.outputMode === 'streaming') return;
    const state = options.playback.playerRef.current?.getState();
    if (role === 'host' && currentTrack && state && state.duration > 0) {
      resumeAfterSwitchRef.current = { trackId: currentTrack.id, position: state.currentTime, playing: state.isPlaying };
    }
    options.setOutputMode('streaming');
    options.addToast('Listening rooms use the streaming backend', 'info');
  }, [role, options.outputMode]);

  // Host: a track playing on the hi-fi/worklet path has no room clock — reload it natively in place.
  useEffect(() => {
    const { playback, loadingTrackId, isLoading } = options;
    if (role !== 'host' || !currentTrack || !isShareableTrackId(currentTrack.id)) return;
    if (loadingTrackId || isLoading || options.outputMode !== 'streaming') return;
    const backend = playback.playerRef.current;
    if (!backend || playback.getSyncClock() || reloadedForRef.current === currentTrack.id) return;

    const resume = resumeAfterSwitchRef.current?.trackId === currentTrack.id ? resumeAfterSwitchRef.current : null;
    const state = backend.getState();
    if (!resume && state.duration <= 0) return;
    reloadedForRef.current = currentTrack.id;
    resumeAfterSwitchRef.current = null;
    suppressHostSampleRef.current = true;
    void playback.playTrack(currentTrack, queueCurrentIndex, {
      autoplay: resume ? resume.playing : state.isPlaying,
      restorePosition: false,
      startAt: resume ? resume.position : state.currentTime,
    }).finally(() => { suppressHostSampleRef.current = false; });
  }, [role, currentTrack, options.loadingTrackId, options.isLoading, options.outputMode, options.playback.capabilities]);

  useEffect(() => {
    if (!role) reloadedForRef.current = null;
  }, [role]);

  return room;
}
