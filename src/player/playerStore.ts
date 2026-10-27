// Player state outside React (#258). The PlaybackEngine writes it; components read
// slices through the selector hooks in `selectors.ts`, so a clock tick re-renders
// only what reads the clock.

import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Toast } from '../components/Toast';
import type { PlaylistTrack } from '../types/library';
import type { RepeatMode } from '../storage/queueStorage';
import {
  DEFAULT_AUDIO_BACKEND_CAPABILITIES,
  type AudioBackendCapabilities,
  type AudioOutputMode,
} from '../types/audio';
import type { PlaybackPathInfo } from '../utils/playbackPath';
import type { TransportStatus } from './transport';

export interface TransportState {
  status: TransportStatus;
  currentTrack: PlaylistTrack | null;
  /** Track whose load is in flight. */
  loadingTrackId: string | undefined;
  duration: number;
  playbackPath: PlaybackPathInfo | null;
  capabilities: AudioBackendCapabilities;
  prebufferingNext: boolean;
  /** Bumped when the backend or the audio graph is replaced: re-read the analyser. */
  graphGeneration: number;
  /** Bumped on every seek (listening-room hosts publish on it). */
  seekCount: number;
}

/** Throttled (4 Hz) copy of the engine clock; rAF readers use `engine.clock.now()`. */
export interface ClockState {
  position: number;
  duration: number;
}

export interface QueueState {
  tracks: PlaylistTrack[];
  /** -1 when nothing in the queue is current. */
  currentIndex: number;
  shuffle: boolean;
  repeatMode: RepeatMode;
}

export interface SettingsState {
  outputMode: AudioOutputMode;
  volume: number;
  muted: boolean;
}

export interface ErrorsState {
  lastError: string | null;
  toasts: Toast[];
}

export interface PlayerState {
  transport: TransportState;
  clock: ClockState;
  queue: QueueState;
  settings: SettingsState;
  errors: ErrorsState;
}

export type PlayerStore = StoreApi<PlayerState>;

export const INITIAL_TRANSPORT: TransportState = {
  status: 'idle',
  currentTrack: null,
  loadingTrackId: undefined,
  duration: 0,
  playbackPath: null,
  capabilities: DEFAULT_AUDIO_BACKEND_CAPABILITIES,
  prebufferingNext: false,
  graphGeneration: 0,
  seekCount: 0,
};

export const EMPTY_QUEUE: QueueState = { tracks: [], currentIndex: -1, shuffle: false, repeatMode: 'off' };

export function createPlayerStore(settings: Partial<SettingsState> = {}): PlayerStore {
  return createStore<PlayerState>()(() => ({
    transport: INITIAL_TRANSPORT,
    clock: { position: 0, duration: 0 },
    queue: EMPTY_QUEUE,
    settings: { outputMode: 'streaming', volume: 1, muted: false, ...settings },
    errors: { lastError: null, toasts: [] },
  }));
}

type SliceKey = keyof PlayerState;

/** Shallow-merge `patch` into one slice; a no-op patch keeps the slice identity (no re-render). */
function patchSlice<K extends SliceKey>(store: PlayerStore, key: K, patch: Partial<PlayerState[K]>): void {
  const slice = store.getState()[key];
  const changed = (Object.keys(patch) as Array<keyof PlayerState[K]>).some((k) => !Object.is(patch[k], slice[k]));
  if (!changed) return;
  store.setState({ [key]: { ...slice, ...patch } } as unknown as Partial<PlayerState>);
}

export const patchTransport = (store: PlayerStore, patch: Partial<TransportState>) => patchSlice(store, 'transport', patch);
export const patchClock = (store: PlayerStore, patch: Partial<ClockState>) => patchSlice(store, 'clock', patch);
export const patchQueue = (store: PlayerStore, patch: Partial<QueueState>) => patchSlice(store, 'queue', patch);
export const patchSettings = (store: PlayerStore, patch: Partial<SettingsState>) => patchSlice(store, 'settings', patch);

let toastSeq = 0;

export function notify(store: PlayerStore, message: string, type: Toast['type'] = 'info'): void {
  const { errors } = store.getState();
  const id = `t${++toastSeq}`;
  patchSlice(store, 'errors', { toasts: [...errors.toasts, { id, message, type }] });
}

export function dismissToast(store: PlayerStore, id: string): void {
  const { errors } = store.getState();
  if (!errors.toasts.some((t) => t.id === id)) return;
  patchSlice(store, 'errors', { toasts: errors.toasts.filter((t) => t.id !== id) });
}

/** Record a user-visible failure and show it as an error toast. */
export function reportError(store: PlayerStore, message: string): void {
  patchSlice(store, 'errors', { lastError: message });
  notify(store, message, 'error');
}
