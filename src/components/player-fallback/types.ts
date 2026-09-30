import React from 'react';
import { PlaylistTrack, RepeatMode } from '../../api/audioLoader';
import type { GpuChoreBackend } from '../../gpu-chores';
import type { AudioOutputMode } from '../../hooks/usePlayerState';

/**
 * Audio engine choices. The transport bar and the Settings tab both render this
 * list, so every AudioOutputMode is offered in both places (Record keeps it
 * exhaustive at compile time).
 */
export const OUTPUT_MODE_LABELS: Readonly<Record<AudioOutputMode, string>> = {
  streaming: 'Streaming (recommended)',
  worklet: 'AudioWorklet (buffered)',
  'web-audio': 'Web Audio (buffered)',
  sdl: 'SDL3',
};

export type ViewTab = 'library' | 'now-playing' | 'queue' | 'playlists' | 'generate' | 'convert' | 'settings';
export type LibraryViewMode = 'grid' | 'list';

export interface TransportState {
  isPlaying: boolean;
  isLoading: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
}

export interface TransportControls {
  onPlay: () => void;
  onStop: () => void;
  onSeek?: (t: number) => void;
  onVolumeChange: (v: number) => void;
  onMute: () => void;
  onNext: () => void;
  onPrevious: () => void;
}

export interface OverviewData {
  minmax?: Float32Array | null;
  rms?: number | null;
  peak?: number | null;
  backend?: GpuChoreBackend | null;
  reason?: string | null;
}

export interface PlaybackModeState {
  shuffle: boolean;
  setShuffle: React.Dispatch<React.SetStateAction<boolean>>;
  repeatMode: RepeatMode;
  setRepeatMode: React.Dispatch<React.SetStateAction<RepeatMode>>;
}

/** Shared subset of QueuePanel's props, common to both the drawer and the queue tab. */
export interface QueuePanelSharedProps {
  queue: PlaylistTrack[];
  currentIndex: number;
  prebufferingNext: boolean;
  onTrackClick: (index: number) => void;
  onRemoveTrack: (index: number) => void;
  onClearQueue: () => void;
  onShuffle: () => void;
  onSmartMix: () => void;
  onShareQueue: () => void;
  onDownloadQueue: () => void;
  onReorderQueue: (start: number, end: number) => void;
  shuffle: boolean;
  repeatMode: RepeatMode;
  onToggleRepeat: () => void;
}
