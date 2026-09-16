import React from 'react';
import { PlaylistTrack, RepeatMode } from '../../audioLoader';
import type { GpuChoreBackend } from '../../gpu-chores';

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
