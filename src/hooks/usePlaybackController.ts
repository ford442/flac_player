import { useState, useEffect, useRef, useCallback } from 'react';
import { PlaybackEngine, type PlaybackStatus } from '../audio/PlaybackEngine';
import { positionKeyForTrack, readSavedPosition } from '../audio/playbackPosition';
import type { DecodedPcmView, SyncClock } from '../types/audio';
import type { AudioOutputMode } from './usePlayerState';
import { AudioLoader, PlaylistTrack } from '../audioLoader';
import { usePlaybackStatus } from './usePlaybackEngine';
import { applyReplayGainToPlayer, enrichTrackReplayGain } from './useReplayGainApplication';
import { parseReplayGainFromCommon, replayGainTagsToTrackFields } from '../utils/replayGain';
import type { ReplayGainSettings } from '../utils/replayGain';
import { getNextQueueIndex, getPreviousQueueIndex, getNextQueueTrack } from '../utils/queueUtils';
import type { GaplessSettings } from '../types/gapless';
import { notifyInAppProjectMTrackChange } from '../utils/projectMBridge';
import type { RepeatMode } from '../storage/queueStorage';

/**
 * Listening-room role (#209). Any role forces the native streaming path (the
 * room clock); a guest additionally follows the host instead of advancing
 * its own queue.
 */
export type ListeningSyncMode = 'off' | 'host' | 'guest';

export interface PlayTrackOptions {
  /** Start playback once loaded (default true). */
  autoplay?: boolean;
  /** Resume the position saved in localStorage for this track (default true). */
  restorePosition?: boolean;
  /** Seek here after loading (seconds); wins over restorePosition. */
  startAt?: number;
}

export interface PlaybackControllerOptions {
  loader: AudioLoader;
  outputMode: AudioOutputMode;
  setOutputMode: (mode: AudioOutputMode) => void;
  setError: (error: string) => void;
  setCurrentTrack: (track: PlaylistTrack | null) => void;
  setLoadingTrackId: (id: string | undefined | ((prev: string | undefined) => string | undefined)) => void;
  currentTrack: PlaylistTrack | null;
  queue: PlaylistTrack[];
  queueCurrentIndex: number;
  setQueueCurrentIndex: (index: number) => void;
  shuffle: boolean;
  repeatMode: RepeatMode;
  volume: number;
  muted: boolean;
  setVolume: (volume: number) => void;
  setMuted: React.Dispatch<React.SetStateAction<boolean>>;
  prevVolumeRef: React.MutableRefObject<number>;
  eqGains: number[];
  playbackRate: number;
  gaplessSettings: GaplessSettings;
  replayGainSettings: ReplayGainSettings;
  addToast: (message: string, type: 'success' | 'error' | 'info') => void;
  loadStats: () => void;
  isSharedPlaylist: boolean;
}

interface PlannedNext {
  track: PlaylistTrack;
  index: number;
}

function newLocalTrackId(): string {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Queue-aware adapter over {@link PlaybackEngine}. The engine owns the
 * backend, the clock and the load path; this hook maps React state (queue,
 * settings, room role) onto engine commands. Host components read
 * {@link PlaybackStatus} here, which does not change on `timeupdate`.
 */
export function usePlaybackController({
  loader,
  outputMode,
  setOutputMode,
  setError,
  setCurrentTrack,
  setLoadingTrackId,
  currentTrack,
  queue,
  queueCurrentIndex,
  setQueueCurrentIndex,
  shuffle,
  repeatMode,
  volume,
  muted,
  setVolume,
  setMuted,
  prevVolumeRef,
  eqGains,
  playbackRate,
  gaplessSettings,
  replayGainSettings,
  addToast,
  loadStats,
  isSharedPlaylist,
}: PlaybackControllerOptions) {
  const [engine] = useState(() => new PlaybackEngine({ loader }));
  const status: PlaybackStatus = usePlaybackStatus(engine);
  const [currentFile, setCurrentFile] = useState<File | undefined>(undefined);

  const syncModeRef = useRef<ListeningSyncMode>('off');
  const pendingFilesRef = useRef<File[]>([]);
  const playSeqRef = useRef(0);
  /** The successor handed to the engine; gapless handoffs and auto-advance use it. */
  const plannedNextRef = useRef<PlannedNext | null>(null);

  const latest = useRef({ queue, queueCurrentIndex, shuffle, repeatMode, replayGainSettings, setError });
  latest.current = { queue, queueCurrentIndex, shuffle, repeatMode, replayGainSettings, setError };

  const updatePlannedNext = useCallback(() => {
    const { queue: q, queueCurrentIndex: index, shuffle: shuf, repeatMode: repeat } = latest.current;
    // Guests never transition on their own; the host's TRACK_CHANGE drives them.
    // Repeat-one replays on `ended` instead of handing off to the next track.
    const next = syncModeRef.current === 'guest' || repeat === 'one'
      ? null
      : getNextQueueTrack(q, index, shuf, repeat);
    plannedNextRef.current = next;
    engine.setNext(next ? {
      url: next.track.url,
      duration: next.track.duration,
      positionKey: positionKeyForTrack(next.track),
    } : null);
  }, [engine]);

  const loadLocalFile = useCallback(async (file: File) => {
    setError('');
    setCurrentFile(file);

    try {
      const arrayBuffer = await file.arrayBuffer();
      let track: PlaylistTrack;
      try {
        const { parseBlob } = await import('music-metadata');
        const meta = await parseBlob(file);
        const rgFields = replayGainTagsToTrackFields(parseReplayGainFromCommon(meta.common));
        track = {
          id: newLocalTrackId(),
          name: file.name,
          title: (meta.common.title as string) || file.name.replace(/\.[^/.]+$/, ''),
          author: (meta.common.artist as string) || 'Unknown Artist',
          url: URL.createObjectURL(file),
          duration: (meta.format.duration as number) || 0,
          ...rgFields,
        };
      } catch {
        track = {
          id: newLocalTrackId(),
          name: file.name,
          title: file.name.replace(/\.[^/.]+$/, ''),
          author: 'Unknown Artist',
          url: URL.createObjectURL(file),
          duration: 0,
        };
      }

      setCurrentTrack(track);

      if (engine.getOutputMode() === 'streaming') {
        setError('Streaming mode does not support local files. Switch to a buffered audio mode.');
        return;
      }

      const { queue: q, replayGainSettings: rg } = latest.current;
      applyReplayGainToPlayer({ player: engine, track, queue: q, settings: rg });
      const outcome = await engine.loadFile(arrayBuffer, file.name, {
        url: track.url,
        duration: track.duration,
        positionKey: positionKeyForTrack(track),
      });
      if (outcome === 'loaded') addToast(`Playing: ${track.title || track.name}`, 'info');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load file';
      setError(message);
      addToast(`Failed to load file: ${message}`, 'error');
    }
  }, [engine, addToast, setCurrentTrack, setError]);

  const handleLocalFiles = useCallback((files: File[]) => {
    if (outputMode === 'streaming') {
      pendingFilesRef.current = files;
      setOutputMode('worklet');
      addToast('Switched to buffered mode for local files', 'info');
      return;
    }
    files.forEach((file, i) => setTimeout(() => loadLocalFile(file), i * 100));
  }, [outputMode, loadLocalFile, addToast, setOutputMode]);

  /** Resolves true once the track is loaded (and playing, unless autoplay is false). */
  const playTrack = useCallback(async (
    track: PlaylistTrack,
    index?: number,
    { autoplay = true, restorePosition = true, startAt }: PlayTrackOptions = {},
  ): Promise<boolean> => {
    const seq = ++playSeqRef.current;
    setCurrentTrack(track);
    setLoadingTrackId(track.id);
    if (index !== undefined) setQueueCurrentIndex(index);
    setError('');
    notifyInAppProjectMTrackChange();
    try {
      const enriched = await enrichTrackReplayGain(track);
      if (seq !== playSeqRef.current) return false;
      if (enriched !== track) setCurrentTrack(enriched);
      const { queue: q, replayGainSettings: rg } = latest.current;
      applyReplayGainToPlayer({ player: engine, track: enriched, queue: q, settings: rg });

      const positionKey = positionKeyForTrack(enriched);
      const resumeAt = startAt ?? (restorePosition ? readSavedPosition(positionKey) ?? undefined : undefined);
      const outcome = await engine.load(
        { url: enriched.url, duration: enriched.duration, positionKey },
        { autoplay, startAt: resumeAt },
      );
      if (outcome === 'superseded') return false;
      if (enriched.id) {
        void loader.recordPlay(enriched.id);
        addToast('Playing: ' + (enriched.title || enriched.name), 'info');
      }
      setTimeout(loadStats, 500);
      return true;
    } catch (err) {
      if (seq !== playSeqRef.current) return false;
      const message = err instanceof Error ? err.message : 'Failed to play track';
      setError(message);
      addToast(`Playback failed: ${message}`, 'error');
      console.error('Failed to play track:', err);
      return false;
    } finally {
      if (seq === playSeqRef.current) setLoadingTrackId(undefined);
    }
  }, [engine, loader, setCurrentTrack, setLoadingTrackId, setQueueCurrentIndex, setError, loadStats, addToast]);

  const playTrackRef = useRef(playTrack);
  playTrackRef.current = playTrack;

  // Engine callbacks: queue advance on `ended`, errors from backend init.
  useEffect(() => {
    engine.setOnError((message) => latest.current.setError(message));
    engine.setOnEnded((event) => {
      if (syncModeRef.current === 'guest') return;
      const planned = plannedNextRef.current;
      if (event?.alreadyPlayingNext) {
        // The engine already plays the preloaded successor; follow it in the UI.
        if (!planned) return;
        setQueueCurrentIndex(planned.index);
        setCurrentTrack(planned.track);
        const { queue: q, replayGainSettings: rg } = latest.current;
        void enrichTrackReplayGain(planned.track).then((enriched) =>
          applyReplayGainToPlayer({ player: engine, track: enriched, queue: q, settings: rg }));
        notifyInAppProjectMTrackChange();
        setTimeout(loadStats, 500);
        return;
      }
      if (latest.current.repeatMode === 'one') {
        void engine.play();
        return;
      }
      if (planned) void playTrackRef.current(planned.track, planned.index);
    });
    return () => {
      engine.setOnEnded(undefined);
      engine.setOnError(undefined);
    };
  }, [engine, setQueueCurrentIndex, setCurrentTrack, loadStats]);

  // Backend lifecycle follows outputMode; release() on unmount (StrictMode-safe).
  useEffect(() => {
    let cancelled = false;
    void engine.setOutputMode(outputMode).then((backend) => {
      if (cancelled || !backend || pendingFilesRef.current.length === 0) return;
      const files = pendingFilesRef.current;
      pendingFilesRef.current = [];
      files.forEach((file, i) => setTimeout(() => { void loadLocalFile(file); }, i * 100));
    });
    return () => { cancelled = true; };
  }, [engine, outputMode, loadLocalFile]);
  useEffect(() => () => engine.release(), [engine]);

  useEffect(() => { engine.setVolume(muted ? 0 : volume); }, [engine, volume, muted]);
  useEffect(() => { engine.setEQGains(eqGains); }, [engine, eqGains]);
  useEffect(() => { engine.setPlaybackRate(playbackRate); }, [engine, playbackRate]);
  useEffect(() => { engine.setGaplessSettings(gaplessSettings); }, [engine, gaplessSettings.mode, gaplessSettings.crossfadeMs]);
  useEffect(() => { engine.setPositionPersistence(!isSharedPlaylist); }, [engine, isSharedPlaylist]);

  useEffect(() => {
    if (!currentTrack) return;
    let cancelled = false;
    void enrichTrackReplayGain(currentTrack).then((enriched) => {
      if (!cancelled) applyReplayGainToPlayer({ player: engine, track: enriched, queue, settings: replayGainSettings });
    });
    return () => { cancelled = true; };
  }, [engine, replayGainSettings.mode, replayGainSettings.limiterEnabled, currentTrack, queue]);

  useEffect(() => {
    updatePlannedNext();
  }, [updatePlannedNext, queue, queueCurrentIndex, shuffle, repeatMode]);

  const playNextInQueue = useCallback(() => {
    const nextIndex = getNextQueueIndex(queue.length, queueCurrentIndex, shuffle, repeatMode);
    if (nextIndex === -1) return;
    const nextTrack = queue[nextIndex];
    if (nextTrack) void playTrack(nextTrack, nextIndex);
  }, [queue, queueCurrentIndex, shuffle, repeatMode, playTrack]);

  const playPreviousInQueue = useCallback(() => {
    const previousIndex = getPreviousQueueIndex(queue.length, queueCurrentIndex, repeatMode);
    if (previousIndex === -1) return;
    const previousTrack = queue[previousIndex];
    if (previousTrack) void playTrack(previousTrack, previousIndex);
  }, [queue, queueCurrentIndex, repeatMode, playTrack]);

  const togglePlayback = useCallback(() => {
    const { isPlaying, duration, isLoading } = engine.getStatus();
    if (isPlaying) { engine.pause(); return; }
    if (queue.length === 0 || isLoading) { void engine.play(); return; }
    const initialIndex = queueCurrentIndex >= 0 ? queueCurrentIndex : 0;
    const initialTrack = queue[initialIndex];
    if (duration === 0 && initialTrack) { void playTrack(initialTrack, initialIndex); return; }
    void engine.play();
  }, [engine, queue, queueCurrentIndex, playTrack]);

  const toggleMute = useCallback(() => {
    setMuted(prev => {
      if (!prev) {
        prevVolumeRef.current = volume;
      } else {
        setVolume(prevVolumeRef.current);
      }
      return !prev;
    });
  }, [volume, setMuted, setVolume, prevVolumeRef]);

  const handleVolumeChange = useCallback((vol: number) => {
    if (vol > 0) prevVolumeRef.current = vol;
    setMuted(false);
    setVolume(vol);
  }, [setMuted, setVolume, prevVolumeRef]);

  const getAnalyser = useCallback(() => engine.getAnalyser(), [engine]);
  const getDecodedPcm = useCallback((): DecodedPcmView | null => engine.getDecodedPcm(), [engine]);

  const stop = useCallback(() => engine.stop(), [engine]);
  const seek = useCallback((time: number) => engine.seek(time), [engine]);
  const pause = useCallback(() => engine.pause(), [engine]);

  const setListeningSyncMode = useCallback((mode: ListeningSyncMode) => {
    syncModeRef.current = mode;
    engine.setNativeOnly(mode !== 'off');
    updatePlannedNext();
  }, [engine, updatePlannedNext]);
  const getSyncClock = useCallback((): SyncClock | null => engine.getSyncClock(), [engine]);

  return {
    engine,
    status,
    currentFile,
    playbackPath: status.playbackPath,
    capabilities: status.capabilities,
    prebufferingNext: status.prebufferingNext,
    playTrack,
    playNextInQueue,
    playPreviousInQueue,
    togglePlayback,
    handleLocalFiles,
    handleVolumeChange,
    toggleMute,
    getAnalyser,
    getDecodedPcm,
    stop,
    seek,
    pause,
    setListeningSyncMode,
    getSyncClock,
  };
}
