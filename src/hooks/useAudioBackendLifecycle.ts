import { useEffect, useRef, useState } from 'react';
import { createAudioBackend } from '../audio/createAudioBackend';
import type { ConfigurableAudioBackend } from '../types/audio';
import type { AudioOutputMode } from './usePlayerState';
import type { PlayerUIState } from '../types/player';
import type { PlaylistTrack, RepeatMode } from '../audioLoader';
import { getNextQueueIndex } from '../utils/queueUtils';
import { createProjectMPCMFeed } from '../utils/projectMBridge';
import { sharedAudioContextManager } from '../audio/AudioContextManager';
import { resolveLatencyHint, type LatencyMode } from '../audio/audioContextPolicy';

interface UseAudioBackendLifecycleParams {
  outputMode: AudioOutputMode;
  latencyMode: LatencyMode;
  replayGainEnabled: boolean;
  replayGainDb: number;
  /** Applied once to a freshly created backend. Read through a ref, so changes here do not rebuild it. */
  initialSettings: {
    volume: number;
    muted: boolean;
    eqGains: number[];
    playbackRate: number;
    crossfadeEnabled: boolean;
  };
  /** Live settings, re-applied to the existing backend whenever they change. */
  eqGains: number[];
  playbackRate: number;
  crossfadeEnabled: boolean;
  /** Called when a track ends. Held in a ref so the backend is not rebuilt per render. */
  onTrackEndedRef: React.MutableRefObject<() => void>;
  /** Runs after initialize() resolves — used to flush files dropped before the backend existed. */
  onInitializedRef: React.MutableRefObject<() => void>;
  setPlayerState: (state: PlayerUIState | ((prev: PlayerUIState) => PlayerUIState)) => void;
  setError: (error: string) => void;
  // Crossfade pre-buffering needs to know what plays next.
  queue: PlaylistTrack[];
  queueCurrentIndex: number;
  shuffle: boolean;
  repeatMode: RepeatMode;
}

/**
 * Owns the audio backend instance: creation on output-mode change, teardown,
 * the projectM PCM feed, live settings propagation, and crossfade pre-buffering.
 *
 * Returns the ref the rest of the player uses to drive playback.
 */
export function useAudioBackendLifecycle({
  outputMode,
  latencyMode,
  replayGainEnabled,
  replayGainDb,
  initialSettings,
  eqGains,
  playbackRate,
  crossfadeEnabled,
  onTrackEndedRef,
  onInitializedRef,
  setPlayerState,
  setError,
  queue,
  queueCurrentIndex,
  shuffle,
  repeatMode,
}: UseAudioBackendLifecycleParams) {
  const playerRef = useRef<ConfigurableAudioBackend | null>(null);
  // Bumped when the AudioContext is rebuilt (sample-rate or latencyHint change),
  // forcing the backend to be recreated: its nodes belonged to the closed context.
  const [contextGeneration, setContextGeneration] = useState(0);

  useEffect(() => {
    return sharedAudioContextManager.onContextChange(() => {
      setContextGeneration(generation => generation + 1);
    });
  }, []);

  useEffect(() => {
    sharedAudioContextManager.setReplayGainDb(replayGainEnabled ? replayGainDb : 0);
  }, [replayGainEnabled, replayGainDb]);

  // Read at creation time only — these must not retrigger backend construction.
  const initialSettingsRef = useRef(initialSettings);
  initialSettingsRef.current = initialSettings;

  useEffect(() => {
    let cancelled = false;
    let stopProjectMBridge: (() => void) | null = null;
    let activePlayer: ConfigurableAudioBackend | null = null;

    sharedAudioContextManager.configure({ latencyHint: resolveLatencyHint(latencyMode) });

    void createAudioBackend(outputMode).then((player) => {
      if (cancelled) {
        player.destroy();
        return;
      }

      const settings = initialSettingsRef.current;
      activePlayer = player;
      player.setStateChangeCallback(setPlayerState);
      player.setOnEndedCallback(() => onTrackEndedRef.current());
      playerRef.current = player;
      player.setVolume(settings.muted ? 0 : settings.volume);
      player.setEQGains(settings.eqGains);
      player.setPlaybackRate(settings.playbackRate);
      player.setCrossfadeEnabled?.(settings.crossfadeEnabled);

      stopProjectMBridge = createProjectMPCMFeed(player);

      void player.initialize().then(() => {
        if (cancelled) return;
        onInitializedRef.current();
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
  }, [outputMode, latencyMode, contextGeneration, onTrackEndedRef, onInitializedRef, setPlayerState, setError]);

  // Apply live settings to the existing backend.
  useEffect(() => {
    playerRef.current?.setEQGains(eqGains);
  }, [eqGains]);

  useEffect(() => {
    playerRef.current?.setPlaybackRate(playbackRate);
  }, [playbackRate]);

  useEffect(() => {
    playerRef.current?.setCrossfadeEnabled?.(crossfadeEnabled);
  }, [crossfadeEnabled]);

  // Pre-buffer the next track so the streaming backend can crossfade into it.
  useEffect(() => {
    if (!crossfadeEnabled || outputMode !== 'streaming') return;
    const nextIndex = getNextQueueIndex(queue.length, queueCurrentIndex, shuffle, repeatMode);
    if (nextIndex === -1) return;
    const nextTrack = queue[nextIndex];
    if (nextTrack) playerRef.current?.preloadNext?.(nextTrack.url);
  }, [crossfadeEnabled, outputMode, queue, queueCurrentIndex, shuffle, repeatMode]);

  // contextGeneration lets callers reload the current track: a rebuild destroys
  // whatever was loaded, since it belonged to the closed context.
  return { playerRef, contextGeneration };
}
