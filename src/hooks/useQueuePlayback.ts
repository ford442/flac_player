import { useCallback, useEffect } from 'react';
import type { ConfigurableAudioBackend } from '../types/audio';
import type { PlayerUIState } from '../types/player';
import type { PlaylistTrack, RepeatMode } from '../audioLoader';
import {
  handleQueueAutoAdvance,
  getNextQueueIndex,
  getPreviousQueueIndex,
} from '../utils/queueUtils';
import { notifyInAppProjectMTrackChange } from '../utils/projectMBridge';

interface UseQueuePlaybackParams {
  playerRef: React.MutableRefObject<ConfigurableAudioBackend | null>;
  /** Assigned by this hook; the backend lifecycle calls it when a track ends. */
  onTrackEndedRef: React.MutableRefObject<() => void>;
  loadAudioFromUrl: (url: string, track?: PlaylistTrack) => Promise<void>;
  queue: PlaylistTrack[];
  queueCurrentIndex: number;
  setQueueCurrentIndex: React.Dispatch<React.SetStateAction<number>>;
  shuffle: boolean;
  repeatMode: RepeatMode;
  playerState: PlayerUIState;
  setCurrentTrack: React.Dispatch<React.SetStateAction<PlaylistTrack | null>>;
  setLoadingTrackId: (id: string | undefined) => void;
  setError: (error: string) => void;
  addToast: (msg: string, type: 'success' | 'error' | 'info') => void;
  onPlayRecorded: () => void;
}

/**
 * Queue-driven playback: playing a track, next/previous navigation honouring
 * shuffle and repeat, play/pause toggling, and auto-advance at track end.
 */
export function useQueuePlayback({
  playerRef,
  onTrackEndedRef,
  loadAudioFromUrl,
  queue,
  queueCurrentIndex,
  setQueueCurrentIndex,
  shuffle,
  repeatMode,
  playerState,
  setCurrentTrack,
  setLoadingTrackId,
  setError,
  addToast,
  onPlayRecorded,
}: UseQueuePlaybackParams) {
  const playTrack = useCallback(async (track: PlaylistTrack, index?: number) => {
    setCurrentTrack(track);
    setLoadingTrackId(track.id);
    if (index !== undefined) setQueueCurrentIndex(index);
    setError('');
    notifyInAppProjectMTrackChange();
    try {
      await loadAudioFromUrl(track.url, track);
      const maybePromise = playerRef.current?.play();
      if (maybePromise instanceof Promise) await maybePromise;
      // Resume where this track was last left off, if it is the same one.
      try {
        const saved = JSON.parse(localStorage.getItem('flac_position') || 'null');
        if (saved && saved.trackId === track.id && saved.time > 0) playerRef.current?.seek(saved.time);
      } catch { /* no-op */ }
      setTimeout(onPlayRecorded, 500);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to play track';
      setError(message);
      addToast(`Playback failed: ${message}`, 'error');
      console.error('Failed to play track:', err);
    } finally {
      setLoadingTrackId(undefined);
    }
  }, [
    playerRef, loadAudioFromUrl, setCurrentTrack, setLoadingTrackId,
    setQueueCurrentIndex, setError, addToast, onPlayRecorded,
  ]);

  const playNextInQueue = useCallback(() => {
    const nextIndex = getNextQueueIndex(queue.length, queueCurrentIndex, shuffle, repeatMode);
    if (nextIndex === -1) return;
    const nextTrack = queue[nextIndex];
    if (nextTrack) playTrack(nextTrack, nextIndex);
  }, [queue, queueCurrentIndex, shuffle, repeatMode, playTrack]);

  const playPreviousInQueue = useCallback(() => {
    const previousIndex = getPreviousQueueIndex(queue.length, queueCurrentIndex, repeatMode);
    if (previousIndex === -1) return;
    const previousTrack = queue[previousIndex];
    if (previousTrack) playTrack(previousTrack, previousIndex);
  }, [queue, queueCurrentIndex, repeatMode, playTrack]);

  const togglePlayback = useCallback(() => {
    if (playerState.isPlaying) { playerRef.current?.pause(); return; }
    if (queue.length === 0) { playerRef.current?.play(); return; }
    const initialIndex = queueCurrentIndex >= 0 ? queueCurrentIndex : 0;
    const initialTrack = queue[initialIndex];
    if (playerState.duration === 0 && initialTrack) { playTrack(initialTrack, initialIndex); return; }
    playerRef.current?.play();
  }, [playerRef, playerState.isPlaying, playerState.duration, queue, queueCurrentIndex, playTrack]);

  // Keep the end-of-track handler current without rebuilding the audio backend.
  useEffect(() => {
    onTrackEndedRef.current = () =>
      handleQueueAutoAdvance(
        queue, queueCurrentIndex, shuffle, repeatMode,
        (track, index) => playTrack(track, index),
        () => playerRef.current?.play()
      );
  }, [onTrackEndedRef, queue, queueCurrentIndex, shuffle, repeatMode, playTrack, playerRef]);

  return { playTrack, playNextInQueue, playPreviousInQueue, togglePlayback };
}
