import { useCallback, useRef, useState } from 'react';
import type { ConfigurableAudioBackend } from '../types/audio';
import type { AudioOutputMode } from './usePlayerState';
import {
  AudioLoader,
  PlaylistTrack,
  selectDecodeStrategy,
  type PlaybackPathInfo,
} from '../audioLoader';
import type { PlayerUIState } from '../types/player';
import { getPreferredStorageUrls } from '../utils/audioUtils';
import { getOrFetchTrack } from '../storage/trackCache';

interface UseTrackLoaderParams {
  playerRef: React.MutableRefObject<ConfigurableAudioBackend | null>;
  loader: AudioLoader;
  outputMode: AudioOutputMode;
  setPlayerState: (state: PlayerUIState | ((prev: PlayerUIState) => PlayerUIState)) => void;
  setError: (error: string) => void;
  setCurrentTrack: React.Dispatch<React.SetStateAction<PlaylistTrack | null>>;
  addToast: (msg: string, type: 'success' | 'error' | 'info') => void;
}

/**
 * URL resolution and decode-strategy selection for a single track.
 *
 * Walks the preferred storage mirrors in order and, per output mode, picks
 * between native streaming, the hi-fi WASM stream, and a buffered decode
 * (which prefers the offline cache and falls back to the network).
 */
export function useTrackLoader({
  playerRef,
  loader,
  outputMode,
  setPlayerState,
  setError,
  setCurrentTrack,
  addToast,
}: UseTrackLoaderParams) {
  const [playbackPath, setPlaybackPath] = useState<PlaybackPathInfo | null>(null);

  // Keeps loadAudioFromUrl stable while still reading the current output mode.
  const outputModeRef = useRef(outputMode);
  outputModeRef.current = outputMode;

  /** Buffered decode: try the offline cache, fall back to a network fetch. */
  const fetchArrayBuffer = useCallback(async (url: string): Promise<ArrayBuffer> => {
    try {
      const response = await getOrFetchTrack(url);
      return await response.arrayBuffer();
    } catch (cacheErr) {
      console.warn('Offline cache miss or error, falling back to network fetch:', cacheErr);
      return loader.loadFromURL(url);
    }
  }, [loader]);

  const loadAudioFromUrl = useCallback(async (url: string, track?: PlaylistTrack) => {
    if (!url.trim() || !playerRef.current) return;
    setPlayerState(prev => ({ ...prev, isLoading: true }));
    setError('');
    const expectedDuration = track?.duration && track.duration > 0 ? track.duration : undefined;
    const mode = outputModeRef.current;

    try {
      const candidateUrls = getPreferredStorageUrls(url);
      let loaded = false;
      let lastError: unknown;
      for (const candidateUrl of candidateUrls) {
        try {
          const player = playerRef.current;
          if (!player) break;

          if (mode === 'streaming' && player.loadFromURL) {
            await player.loadFromURL(candidateUrl, { expectedDuration });
            setPlaybackPath(player.getPlaybackPath?.() ?? null);
          } else if (mode === 'worklet') {
            const probe = await loader.probeAudioUrl(candidateUrl);
            const strategy = selectDecodeStrategy(probe.contentLength, {
              outputMode: 'worklet',
              url: candidateUrl,
            });
            if (strategy === 'hifi-stream' && player.loadFromURLStreaming) {
              await player.loadFromURLStreaming(candidateUrl, { expectedDuration });
            } else {
              await player.loadFromArrayBuffer(await fetchArrayBuffer(candidateUrl));
            }
            setPlaybackPath(player.getPlaybackPath?.() ?? null);
          } else {
            await player.loadFromArrayBuffer(await fetchArrayBuffer(candidateUrl));
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
  }, [playerRef, loader, fetchArrayBuffer, setPlayerState, setError, setCurrentTrack, addToast]);

  return { loadAudioFromUrl, playbackPath };
}
