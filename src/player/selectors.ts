// Selector hooks over the player store (#258). Select the smallest value you
// render: a component re-renders only when its selection changes.

import { useCallback, useMemo } from 'react';
import { useStore } from 'zustand';
import type { Toast } from '../components/Toast';
import type { PlaybackEngine } from './PlaybackEngine';
import { notify, type ClockState, type ErrorsState, type QueueState, type SettingsState, type TransportState } from './playerStore';
import { usePlayer } from './PlayerContext';

export function usePlaybackEngine(): PlaybackEngine {
  return usePlayer().engine;
}

export function useTransport<T>(selector: (transport: TransportState) => T): T {
  return useStore(usePlayer().store, (s) => selector(s.transport));
}

export function useQueue<T>(selector: (queue: QueueState) => T): T {
  return useStore(usePlayer().store, (s) => selector(s.queue));
}

export function useSettings<T>(selector: (settings: SettingsState) => T): T {
  return useStore(usePlayer().store, (s) => selector(s.settings));
}

/** Position and duration, updated at most 4×/s. Only time readouts and scrubbers should read it. */
export function useClock(): ClockState {
  return useStore(usePlayer().store, (s) => s.clock);
}

export function useErrors<T>(selector: (errors: ErrorsState) => T): T {
  return useStore(usePlayer().store, (s) => selector(s.errors));
}

export const selectIsPlaying = (t: TransportState) => t.status === 'playing';
export const selectIsLoading = (t: TransportState) => t.status === 'loading';

/** The live AnalyserNode; changes when the backend or the audio graph is replaced. */
export function useAnalyser(): AnalyserNode | null {
  const { engine } = usePlayer();
  const generation = useTransport((t) => t.graphGeneration);
  return useMemo(() => {
    void generation;
    return engine.getAnalyser();
  }, [engine, generation]);
}

/** Stable toast function bound to the player store. */
export function useNotify(): (message: string, type?: Toast['type']) => void {
  const { store } = usePlayer();
  return useCallback((message: string, type: Toast['type'] = 'info') => notify(store, message, type), [store]);
}
