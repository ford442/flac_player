import { useState, useEffect, useRef, useCallback } from 'react';
import { createAudioBackend } from '../audio/createAudioBackend';
import type { ConfigurableAudioBackend, AudioPlaybackState, DecodedPcmView } from '../types/audio';
import type { AudioOutputMode } from './usePlayerState';
import {
  AudioLoader,
  PlaylistTrack,
  selectDecodeStrategy,
  type PlaybackPathInfo,
} from '../audioLoader';
import { useReplayGainApplication } from './useReplayGainApplication';
import { parseReplayGainFromCommon, replayGainTagsToTrackFields } from '../utils/replayGain';
import type { ReplayGainSettings } from '../utils/replayGain';
import { handleQueueAutoAdvance, getNextQueueIndex, getPreviousQueueIndex, getNextQueueTrack } from '../utils/queueUtils';
import { isGaplessActive, type GaplessSettings } from '../types/gapless';
import { getPreferredStorageUrls } from '../utils/audioUtils';
import { createProjectMPCMFeed, notifyInAppProjectMTrackChange } from '../utils/projectMBridge';
import { getOrFetchTrack } from '../storage/trackCache';
import type { RepeatMode } from '../storage/queueStorage';

export interface PlaybackControllerOptions {
  loader: AudioLoader;
  outputMode: AudioOutputMode;
  setOutputMode: (mode: AudioOutputMode) => void;
  playerState: AudioPlaybackState;
  setPlayerState: React.Dispatch<React.SetStateAction<AudioPlaybackState>>;
  setError: (error: string) => void;
  currentTrack: PlaylistTrack | null;
  setCurrentTrack: (track: PlaylistTrack | null) => void;
  setLoadingTrackId: (id: string | undefined) => void;
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
  crossfadeEnabled: boolean;
  replayGainSettings: ReplayGainSettings;
  addToast: (message: string, type: 'success' | 'error' | 'info') => void;
  loadStats: () => void;
  isSharedPlaylist: boolean;
}

export function usePlaybackController({
  loader,
  outputMode,
  setOutputMode,
  playerState,
  setPlayerState,
  setError,
  currentTrack,
  setCurrentTrack,
  setLoadingTrackId,
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
  crossfadeEnabled,
  replayGainSettings,
  addToast,
  loadStats,
  isSharedPlaylist,
}: PlaybackControllerOptions) {
  const { applyReplayGain } = useReplayGainApplication();

  const [currentFile, setCurrentFile] = useState<File | undefined>(undefined);
  const [playbackPath, setPlaybackPath] = useState<PlaybackPathInfo | null>(null);
  const [prebufferingNext, setPrebufferingNext] = useState(false);

  const playerRef = useRef<ConfigurableAudioBackend | null>(null);
  const pendingFilesRef = useRef<File[]>([]);
  const handleAutoAdvanceRef = useRef<() => void>(() => {});

  const preloadNextInQueue = useCallback((fromIndex: number) => {
    if (!isGaplessActive(gaplessSettings)) {
      playerRef.current?.clearPreload?.();
      return;
    }
    const next = getNextQueueTrack(queue, fromIndex, shuffle, repeatMode);
    if (!next) {
      playerRef.current?.clearPreload?.();
      return;
    }
    playerRef.current?.preloadNext?.({
      url: next.track.url,
      duration: next.track.duration,
    });
  }, [gaplessSettings, queue, shuffle, repeatMode]);

  const advanceQueueIndexOnly = useCallback(() => {
    const next = getNextQueueTrack(queue, queueCurrentIndex, shuffle, repeatMode);
    if (!next) return;
    setQueueCurrentIndex(next.index);
    setCurrentTrack(next.track);
    void applyReplayGain(playerRef.current, next.track, queue, replayGainSettings);
    notifyInAppProjectMTrackChange();
    preloadNextInQueue(next.index);
    setTimeout(loadStats, 500);
  }, [
    queue, queueCurrentIndex, shuffle, repeatMode, preloadNextInQueue,
    setQueueCurrentIndex, setCurrentTrack, loadStats, applyReplayGain, replayGainSettings,
  ]);

  const loadLocalFile = useCallback(async (file: File) => {
    if (!playerRef.current) return;
    setPlayerState(prev => ({ ...prev, isLoading: true }));
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
          id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          title: (meta.common.title as string) || file.name.replace(/\.[^/.]+$/, ''),
          author: (meta.common.artist as string) || 'Unknown Artist',
          url: URL.createObjectURL(file),
          duration: (meta.format.duration as number) || 0,
          ...rgFields,
        };
      } catch {
        track = {
          id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          title: file.name.replace(/\.[^/.]+$/, ''),
          author: 'Unknown Artist',
          url: URL.createObjectURL(file),
          duration: 0,
        };
      }

      setCurrentTrack(track);

      if (outputMode === 'streaming') {
        setError('Streaming mode does not support local files. Switch to a buffered audio mode.');
        return;
      }

      await playerRef.current.loadFromArrayBuffer(arrayBuffer, file.name);
      const enriched = await applyReplayGain(playerRef.current, track, queue, replayGainSettings);
      setCurrentTrack(enriched);
      playerRef.current.play();
      addToast(`Playing: ${track.title || track.name}`, 'info');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load file';
      setError(message);
      addToast(`Failed to load file: ${message}`, 'error');
    } finally {
      setPlayerState(prev => ({ ...prev, isLoading: false }));
    }
  }, [
    addToast, outputMode, setCurrentTrack, setError, setPlayerState,
    applyReplayGain, queue, replayGainSettings,
  ]);

  const handleLocalFiles = useCallback((files: File[]) => {
    if (outputMode === 'streaming') {
      pendingFilesRef.current = files;
      setOutputMode('worklet');
      addToast('Switched to buffered mode for local files', 'info');
      return;
    }
    files.forEach((file, i) => setTimeout(() => loadLocalFile(file), i * 100));
  }, [outputMode, loadLocalFile, addToast, setOutputMode]);

  const loadAudioFromUrl = useCallback(async (url: string, track?: PlaylistTrack) => {
    if (!url.trim() || !playerRef.current) return;
    setPlayerState(prev => ({ ...prev, isLoading: true }));
    setError('');
    const expectedDuration = track?.duration && track.duration > 0 ? track.duration : undefined;

    try {
      const candidateUrls = getPreferredStorageUrls(url);
      let loaded = false;
      let lastError: unknown;
      for (const candidateUrl of candidateUrls) {
        try {
          const player = playerRef.current;

          if (outputMode === 'streaming' && player.loadFromURL) {
            await player.loadFromURL(candidateUrl, { expectedDuration });
            setPlaybackPath(player.getPlaybackPath?.() ?? null);
          } else if (outputMode === 'worklet') {
            const probe = await loader.probeAudioUrl(candidateUrl);
            const strategy = selectDecodeStrategy(probe.contentLength, {
              outputMode: 'worklet',
              url: candidateUrl,
            });
            if (strategy === 'hifi-stream' && player.loadFromURLStreaming) {
              await player.loadFromURLStreaming(candidateUrl, { expectedDuration });
              setPlaybackPath(player.getPlaybackPath?.() ?? null);
            } else {
              let arrayBuffer: ArrayBuffer;
              try {
                const response = await getOrFetchTrack(candidateUrl);
                arrayBuffer = await response.arrayBuffer();
              } catch (cacheErr) {
                console.warn('Offline cache miss or error, falling back to network fetch:', cacheErr);
                arrayBuffer = await loader.loadFromURL(candidateUrl);
              }
              await player.loadFromArrayBuffer(arrayBuffer);
              setPlaybackPath(player.getPlaybackPath?.() ?? null);
            }
          } else {
            let arrayBuffer: ArrayBuffer;
            try {
              const response = await getOrFetchTrack(candidateUrl);
              arrayBuffer = await response.arrayBuffer();
            } catch (cacheErr) {
              console.warn('Offline cache miss or error, falling back to network fetch:', cacheErr);
              arrayBuffer = await loader.loadFromURL(candidateUrl);
            }
            await player.loadFromArrayBuffer(arrayBuffer);
            setPlaybackPath(null);
          }
          loaded = true;
          break;
        } catch (err) { lastError = err; }
      }
      if (!loaded) {
        const msg = `Failed to load audio from any source: ${candidateUrls.join(', ')}`;
        throw new Error(lastError instanceof Error && lastError.message ? `${msg} (${lastError.message})` : msg);
      }
      if (track) {
        setCurrentTrack(track);
        if (track.id) {
          await loader.recordPlay(track.id);
          addToast('Playing: ' + (track.title || track.name), 'info');
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audio');
      throw err;
    } finally {
      setPlayerState(prev => ({ ...prev, isLoading: false }));
    }
  }, [loader, outputMode, setCurrentTrack, setError, setPlayerState, addToast]);

  const playTrack = useCallback(async (track: PlaylistTrack, index?: number) => {
    setCurrentTrack(track);
    setLoadingTrackId(track.id);
    if (index !== undefined) setQueueCurrentIndex(index);
    setError('');
    notifyInAppProjectMTrackChange();
    try {
      const enriched = await applyReplayGain(playerRef.current, track, queue, replayGainSettings);
      if (enriched !== track) setCurrentTrack(enriched);
      await loadAudioFromUrl(enriched.url, enriched);
      const maybePromise = playerRef.current?.play();
      if (maybePromise instanceof Promise) await maybePromise;
      try {
        const saved = JSON.parse(localStorage.getItem('flac_position') || 'null');
        if (saved && saved.trackId === track.id && saved.time > 0) playerRef.current?.seek(saved.time);
      } catch { /* no-op */ }
      setTimeout(loadStats, 500);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to play track';
      setError(message);
      addToast(`Playback failed: ${message}`, 'error');
      console.error('Failed to play track:', err);
    } finally {
      setLoadingTrackId(undefined);
    }
  }, [
    setCurrentTrack, setLoadingTrackId, setQueueCurrentIndex, setError,
    applyReplayGain, queue, replayGainSettings, loadAudioFromUrl, loadStats, addToast,
  ]);

  handleAutoAdvanceRef.current = () =>
    handleQueueAutoAdvance(
      queue, queueCurrentIndex, shuffle, repeatMode,
      (track, index) => { void playTrack(track, index); },
      () => playerRef.current?.play()
    );

  // Backend lifecycle
  useEffect(() => {
    let cancelled = false;
    let stopProjectMBridge: (() => void) | null = null;
    let activePlayer: ConfigurableAudioBackend | null = null;

    void createAudioBackend(outputMode).then((player) => {
      if (cancelled) {
        player.destroy();
        return;
      }

      activePlayer = player;
      player.setStateChangeCallback((state) => {
        setPlayerState(state);
        setPrebufferingNext(Boolean(state.prebufferingNext));
      });
      player.setOnEndedCallback((event) => {
        if (event?.alreadyPlayingNext) {
          advanceQueueIndexOnly();
          return;
        }
        handleAutoAdvanceRef.current();
      });
      playerRef.current = player;
      player.setVolume(muted ? 0 : volume);
      player.setEQGains(eqGains);
      player.setPlaybackRate(playbackRate);
      player.setGaplessSettings?.(gaplessSettings);
      player.setCrossfadeEnabled?.(crossfadeEnabled);

      stopProjectMBridge = createProjectMPCMFeed(player);

      void player.initialize().then(() => {
        if (cancelled || pendingFilesRef.current.length === 0) return;
        const files = pendingFilesRef.current;
        pendingFilesRef.current = [];
        setTimeout(() => files.forEach((file, i) => setTimeout(() => loadLocalFile(file), i * 100)), 0);
      }).catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : `${outputMode} initialization failed`);
      });
    }).catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : `${outputMode} initialization failed`);
    });

    return () => {
      cancelled = true;
      stopProjectMBridge?.();
      activePlayer?.setOnEndedCallback(undefined);
      activePlayer?.destroy();
      if (playerRef.current === activePlayer) {
        playerRef.current = null;
      }
    };
  }, [outputMode, loadLocalFile, advanceQueueIndexOnly]);

  useEffect(() => {
    playerRef.current?.setEQGains(eqGains);
  }, [eqGains]);

  useEffect(() => {
    playerRef.current?.setPlaybackRate(playbackRate);
  }, [playbackRate]);

  useEffect(() => {
    playerRef.current?.setGaplessSettings?.(gaplessSettings);
    playerRef.current?.setCrossfadeEnabled?.(crossfadeEnabled);
  }, [gaplessSettings, crossfadeEnabled]);

  useEffect(() => {
    if (!currentTrack) return;
    void applyReplayGain(playerRef.current, currentTrack, queue, replayGainSettings);
  }, [replayGainSettings, currentTrack, queue, applyReplayGain]);

  useEffect(() => {
    preloadNextInQueue(queueCurrentIndex);
  }, [gaplessSettings, outputMode, queue, queueCurrentIndex, shuffle, repeatMode, preloadNextInQueue]);

  useEffect(() => {
    if (isSharedPlaylist) return;
    const interval = setInterval(() => {
      if (currentTrack && playerState.currentTime > 0 && playerState.duration > 0) {
        try {
          localStorage.setItem('flac_position', JSON.stringify({ trackId: currentTrack.id, time: playerState.currentTime }));
        } catch { /* no-op */ }
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [isSharedPlaylist, currentTrack, playerState.currentTime, playerState.duration]);

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
    if (playerState.isPlaying) { playerRef.current?.pause(); return; }
    if (queue.length === 0) { playerRef.current?.play(); return; }
    const initialIndex = queueCurrentIndex >= 0 ? queueCurrentIndex : 0;
    const initialTrack = queue[initialIndex];
    if (playerState.duration === 0 && initialTrack) { void playTrack(initialTrack, initialIndex); return; }
    playerRef.current?.play();
  }, [playerState.isPlaying, playerState.duration, queue, queueCurrentIndex, playTrack]);

  const toggleMute = useCallback(() => {
    setMuted(prev => {
      if (!prev) {
        prevVolumeRef.current = volume;
        playerRef.current?.setVolume(0);
      } else {
        const restoredVol = prevVolumeRef.current;
        playerRef.current?.setVolume(restoredVol);
        setVolume(restoredVol);
      }
      return !prev;
    });
  }, [volume, setMuted, setVolume, prevVolumeRef]);

  const handleVolumeChange = useCallback((vol: number) => {
    if (vol > 0) prevVolumeRef.current = vol;
    setMuted(false);
    setVolume(vol);
    playerRef.current?.setVolume(vol);
  }, [setMuted, setVolume, prevVolumeRef]);

  const getAnalyser = useCallback(() => playerRef.current?.getAnalyser() ?? null, []);
  const getDecodedPcm = useCallback((): DecodedPcmView | null => {
    return playerRef.current?.getDecodedPcm?.() ?? null;
  }, []);

  const stop = useCallback(() => playerRef.current?.stop(), []);
  const seek = useCallback((time: number) => playerRef.current?.seek(time), []);

  return {
    playerRef,
    currentFile,
    playbackPath,
    prebufferingNext,
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
  };
}
