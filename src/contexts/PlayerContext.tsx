import React, { createContext, useContext } from 'react';
import type {
  PlaylistTrack, SortBy, RepeatMode, LibraryStats, TagInfo, CloudPlaylist,
  PlaybackPathInfo,
} from '../audioLoader';
import type { AudioOutputMode } from '../hooks/usePlayerState';
import type { LatencyMode } from '../audio/audioContextPolicy';
import type { VisualizerAesthetic } from '../utils/visualizerMode';

export type ViewTab = 'library' | 'now-playing' | 'queue' | 'playlists' | 'generate' | 'settings';
export type LibraryViewMode = 'grid' | 'list';

/**
 * Everything the full HTML player UI needs, grouped by concern.
 *
 * This replaces a ~70-prop interface that had to be edited in three places
 * (interface, destructure, call site) for every new feature. Layout components
 * pull what they need via usePlayerContext(); Player.tsx assembles the value
 * once from its hooks.
 */
export interface PlayerContextValue {
  /** Library contents and the operations that mutate them. */
  data: {
    library: PlaylistTrack[];
    displayedLibrary: PlaylistTrack[];
    allTags: TagInfo[];
    stats: LibraryStats;
    isLoadingLibrary: boolean;
    fastMirrorCount: number;
    playlists: CloudPlaylist[];
    isLoadingPlaylists: boolean;
    onLoadPlaylists: () => void;
    isResyncingLibrary: boolean;
    onTriggerResync: () => void;
    onUpdateTrack: (id: string, updates: Partial<PlaylistTrack>) => Promise<void>;
    onTrashTrack: (id: string) => Promise<void>;
    onLoadCloudPlaylist: (id: string) => void;
  };

  /** Library search, filtering and sorting. */
  filters: {
    searchQuery: string;
    setSearchQuery: (q: string) => void;
    searchInputRef: React.RefObject<HTMLInputElement>;
    minRating: number;
    setMinRating: (r: number) => void;
    selectedTags: string[];
    setSelectedTags: React.Dispatch<React.SetStateAction<string[]>>;
    untaggedOnly: boolean;
    setUntaggedOnly: (v: boolean) => void;
    sortBy: SortBy;
    setSortBy: (s: SortBy) => void;
    storageSourceFilter: 'all' | 'fast';
    setStorageSourceFilter: (f: 'all' | 'fast') => void;
  };

  /** Queue contents, ordering modes, and queue mutations. */
  queueState: {
    queue: PlaylistTrack[];
    queueCurrentIndex: number;
    showQueue: boolean;
    setShowQueue: (v: boolean) => void;
    shuffle: boolean;
    setShuffle: React.Dispatch<React.SetStateAction<boolean>>;
    repeatMode: RepeatMode;
    setRepeatMode: React.Dispatch<React.SetStateAction<RepeatMode>>;
    onAddToQueue: (track: PlaylistTrack) => void;
    onAddAllToQueue: (tracks: PlaylistTrack[]) => void;
    onPlayNext: (track: PlaylistTrack) => void;
    onRemoveFromQueue: (index: number) => void;
    onClearQueue: () => void;
    onReorderQueue: (start: number, end: number) => void;
    onSmartMix: () => void;
    onShareQueue: () => void;
  };

  /** Transport state and controls. */
  playback: {
    currentTrack: PlaylistTrack | null;
    currentFile: File | undefined;
    loadingTrackId: string | undefined;
    isPlaying: boolean;
    isLoading: boolean;
    currentTime: number;
    duration: number;
    volume: number;
    muted: boolean;
    analyser: AnalyserNode | null;
    playbackPath: PlaybackPathInfo | null;
    onPlay: () => void;
    onStop: () => void;
    onSeek: (t: number) => void;
    onNext: () => void;
    onPrevious: () => void;
    onVolumeChange: (v: number) => void;
    onMute: () => void;
    onFileSelect: (files: File[]) => void;
    onTrackClick: (track: PlaylistTrack, queueIndex: number) => void;
    onTrackDoubleClick: (track: PlaylistTrack) => void;
    onQueueTrackClick: (index: number) => void;
    onPlayNow: (track: PlaylistTrack) => void;
    onPlayAll: (tracks: PlaylistTrack[], shuffled?: boolean) => void;
  };

  /** Audio engine and DSP settings. */
  settings: {
    outputMode: AudioOutputMode;
    setOutputMode: (m: AudioOutputMode) => void;
    eqGains: number[];
    setEQBandGain: (i: number, g: number) => void;
    resetEQ: () => void;
    playbackRate: number;
    setPlaybackRate: (r: number) => void;
    crossfadeEnabled: boolean;
    setCrossfadeEnabled: (e: boolean) => void;
    latencyMode: LatencyMode;
    setLatencyMode: (m: LatencyMode) => void;
    contextSampleRate: number;
    replayGainEnabled: boolean;
    setReplayGainEnabled: (e: boolean) => void;
    replayGainDb: number;
    setReplayGainDb: (db: number) => void;
    onClearCache: () => void;
  };

  /** Backend health and shared-playlist framing. */
  session: {
    backendStatus: 'checking' | 'up' | 'down';
    onRetry: () => void;
    isSharedPlaylist: boolean;
    sharedPlaylistTitle: string;
  };

  /** Layout-level view state. */
  ui: {
    activeTab: ViewTab;
    setActiveTab: (t: ViewTab) => void;
    libraryViewMode: LibraryViewMode;
    setLibraryViewMode: (m: LibraryViewMode) => void;
    onSetShowHtmlFallback: (v: boolean) => void;
    visualizerAesthetic: VisualizerAesthetic;
    setVisualizerAesthetic: (a: VisualizerAesthetic) => void;
    onShowHelp: () => void;
    onGenerationCompleted: (songId: string) => Promise<void>;
  };
}

const PlayerContext = createContext<PlayerContextValue | null>(null);

export const PlayerProvider = PlayerContext.Provider;

export function usePlayerContext(): PlayerContextValue {
  const value = useContext(PlayerContext);
  if (!value) {
    throw new Error('usePlayerContext must be used inside a PlayerProvider');
  }
  return value;
}
