import type React from 'react';
import type { PlaylistTrack } from '../../types/library';

export interface TrackItemActions {
  onClick: (track: PlaylistTrack) => void;
  onDoubleClick: (track: PlaylistTrack) => void;
  onEdit: (track: PlaylistTrack) => void;
  onTrash: (track: PlaylistTrack) => void;
  onPlayNow?: (track: PlaylistTrack) => void;
  onPlayNext?: (track: PlaylistTrack) => void;
  onAddToQueue?: (track: PlaylistTrack) => void;
  onRegenerate?: (track: PlaylistTrack) => void;
}

export interface OfflineBadgeCallbacks {
  onError: (message: string) => void;
  onDownload: () => void;
  onEvict: () => void;
}

/** Shared by TrackCard (grid) and TrackRow (list). */
export interface TrackItemProps {
  track: PlaylistTrack;
  isCurrent: boolean;
  /** This track is loading for playback. */
  isLoading: boolean;
  isPlaying: boolean;
  /** The TrackEditor while this track is being edited, else null. */
  editor: React.ReactNode;
  actions: TrackItemActions;
  offline: OfflineBadgeCallbacks;
  onKeyDown: (e: React.KeyboardEvent) => void;
}
