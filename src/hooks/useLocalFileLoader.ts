import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConfigurableAudioBackend } from '../types/audio';
import type { AudioOutputMode } from './usePlayerState';
import type { PlayerUIState } from '../types/player';
import { PlaylistTrack } from '../audioLoader';

interface UseLocalFileLoaderParams {
  playerRef: React.MutableRefObject<ConfigurableAudioBackend | null>;
  outputMode: AudioOutputMode;
  setOutputMode: (mode: AudioOutputMode) => void;
  /** Assigned here; the backend lifecycle calls it once initialize() resolves. */
  onInitializedRef: React.MutableRefObject<() => void>;
  setPlayerState: (state: PlayerUIState | ((prev: PlayerUIState) => PlayerUIState)) => void;
  setError: (error: string) => void;
  setCurrentTrack: React.Dispatch<React.SetStateAction<PlaylistTrack | null>>;
  addToast: (msg: string, type: 'success' | 'error' | 'info') => void;
}

const makeLocalTrackId = () =>
  `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Playback of files dropped or picked from disk.
 *
 * Streaming mode cannot play local files, so a drop while streaming switches to
 * the worklet backend and parks the files until the new backend is ready.
 */
export function useLocalFileLoader({
  playerRef,
  outputMode,
  setOutputMode,
  onInitializedRef,
  setPlayerState,
  setError,
  setCurrentTrack,
  addToast,
}: UseLocalFileLoaderParams) {
  const [currentFile, setCurrentFile] = useState<File | undefined>(undefined);
  const pendingFilesRef = useRef<File[]>([]);

  const loadLocalFile = useCallback(async (file: File) => {
    if (!playerRef.current) return;
    setPlayerState(prev => ({ ...prev, isLoading: true }));
    setError('');
    setCurrentFile(file);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const fallbackTitle = file.name.replace(/\.[^/.]+$/, '');
      let track: PlaylistTrack;
      try {
        const { parseBlob } = await import('music-metadata-browser');
        const meta = await parseBlob(file);
        track = {
          id: makeLocalTrackId(),
          name: file.name,
          title: (meta.common.title as string) || fallbackTitle,
          author: (meta.common.artist as string) || 'Unknown Artist',
          url: URL.createObjectURL(file),
          duration: (meta.format.duration as number) || 0,
        };
      } catch {
        track = {
          id: makeLocalTrackId(),
          name: file.name,
          title: fallbackTitle,
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
      playerRef.current.play();
      addToast(`Playing: ${track.title || track.name}`, 'info');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load file';
      setError(message);
      addToast(`Failed to load file: ${message}`, 'error');
    } finally {
      setPlayerState(prev => ({ ...prev, isLoading: false }));
    }
  }, [playerRef, addToast, outputMode, setCurrentTrack, setError, setPlayerState]);

  /** Stagger loads so several dropped files don't contend for the decoder at once. */
  const loadStaggered = useCallback((files: File[]) => {
    files.forEach((file, i) => setTimeout(() => loadLocalFile(file), i * 100));
  }, [loadLocalFile]);

  const handleLocalFiles = useCallback((files: File[]) => {
    if (outputMode === 'streaming') {
      pendingFilesRef.current = files;
      setOutputMode('worklet');
      addToast('Switched to buffered mode for local files', 'info');
      return;
    }
    loadStaggered(files);
  }, [outputMode, loadStaggered, addToast, setOutputMode]);

  // Flush files parked while the backend was being swapped.
  useEffect(() => {
    onInitializedRef.current = () => {
      if (pendingFilesRef.current.length === 0) return;
      const files = pendingFilesRef.current;
      pendingFilesRef.current = [];
      setTimeout(() => loadStaggered(files), 0);
    };
  }, [onInitializedRef, loadStaggered]);

  return { currentFile, loadLocalFile, handleLocalFiles };
}
