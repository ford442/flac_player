import React, { useMemo } from 'react';
import type { PlaylistTrack, TagInfo, LibraryStats } from '../types/library';
import { TrackCard } from './library/TrackCard';
import { TrackRow, TRACK_ROW_COLUMNS } from './library/TrackRow';
import { TrackEditor } from './library/TrackEditor';
import { useTrackEditing } from './library/useTrackEditing';
import type { OfflineBadgeCallbacks, TrackItemActions } from './library/trackItem';

interface LibraryViewProps {
  tracks: PlaylistTrack[];
  allTags: TagInfo[];
  stats: LibraryStats;
  currentTrackId?: string;
  loadingTrackId?: string;
  isPlaying: boolean;
  viewMode: 'grid' | 'list';
  onTrackClick: (track: PlaylistTrack) => void;
  onTrackDoubleClick: (track: PlaylistTrack) => void;
  onUpdateTrack: (id: string, updates: Partial<PlaylistTrack>) => Promise<void>;
  onTrashTrack: (id: string) => Promise<void>;
  onPlayNow?: (track: PlaylistTrack) => void;
  onPlayNext?: (track: PlaylistTrack) => void;
  onAddToQueue?: (track: PlaylistTrack) => void;
  onRegenerate?: (track: PlaylistTrack) => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  isLoading?: boolean;
  onNotify?: (message: string, type: 'success' | 'error' | 'info') => void;
}

export const LibraryView: React.FC<LibraryViewProps> = ({
  tracks,
  allTags,
  currentTrackId,
  loadingTrackId,
  isPlaying,
  viewMode,
  onTrackClick,
  onTrackDoubleClick,
  onUpdateTrack,
  onTrashTrack,
  onPlayNow,
  onPlayNext,
  onAddToQueue,
  onRegenerate,
  onLoadMore,
  hasMore,
  isLoading,
  onNotify
}) => {
  const editing = useTrackEditing(tracks, onUpdateTrack);
  const tagNames = useMemo(() => allTags.map(t => t.name), [allTags]);

  const offline: OfflineBadgeCallbacks = {
    onError: (message) => onNotify?.(message, 'error'),
    onDownload: () => onNotify?.('Saved for offline', 'success'),
    onEvict: () => onNotify?.('Removed from offline cache', 'info'),
  };

  const actions: TrackItemActions = {
    onClick: onTrackClick,
    onDoubleClick: onTrackDoubleClick,
    onEdit: editing.start,
    onTrash: (track) => {
      if (window.confirm('Mark this track as trash?')) void onTrashTrack(track.id);
    },
    onPlayNow, onPlayNext, onAddToQueue, onRegenerate,
  };

  const handleItemKeyDown = (track: PlaylistTrack, e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter') onTrackDoubleClick(track);
    else if (e.key === ' ') onTrackClick(track);
    else if (e.key === 'e' || e.key === 'E') editing.start(track);
    else return;
    // Keep global shortcuts (Space = play/pause) from also firing.
    e.preventDefault();
    e.stopPropagation();
  };

  const itemProps = (track: PlaylistTrack) => ({
    track,
    isCurrent: track.id === currentTrackId,
    isLoading: track.id === loadingTrackId,
    isPlaying,
    editor: editing.state.trackId === track.id
      ? <TrackEditor track={track} editing={editing} tagNames={tagNames} onNotify={onNotify} />
      : null,
    actions,
    offline,
    onKeyDown: (e: React.KeyboardEvent) => handleItemKeyDown(track, e),
  });

  const loadMoreLabel = isLoading ? 'Loading...' : `Load more (${tracks.length} shown)`;

  if (tracks.length === 0 && !isLoading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-gray-400" role="status">
        <p className="text-4xl mb-2" aria-hidden="true">🎵</p>
        <p>No tracks match the current filters.</p>
      </div>
    );
  }

  if (viewMode === 'grid') {
    return (
      <div role="list" aria-label="Library" aria-busy={isLoading} className="library-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 p-4 flex-1 overflow-y-auto content-start">
        {tracks.map((track) => <TrackCard key={track.id} {...itemProps(track)} />)}

        {hasMore && (
          <button
            onClick={onLoadMore}
            disabled={isLoading}
            className="aspect-square flex items-center justify-center bg-white/5 rounded-lg hover:bg-white/10 transition-colors text-gray-400"
          >
            {loadMoreLabel}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="library-list flex-1 overflow-y-auto">
      <table className="w-full text-left" aria-label="Library" aria-busy={isLoading}>
        <thead className="sticky top-0 bg-surface z-10">
          <tr className="border-b border-white/10 text-gray-400 text-sm">
            {TRACK_ROW_COLUMNS.map(column => <th key={column} className="p-3">{column}</th>)}
            <th className="p-3 w-40"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {tracks.map((track) => <TrackRow key={track.id} {...itemProps(track)} />)}
        </tbody>
      </table>

      {hasMore && (
        <div className="p-4 text-center">
          <button
            onClick={onLoadMore}
            disabled={isLoading}
            className="px-4 py-2 bg-white/10 text-white rounded hover:bg-white/20 disabled:opacity-50"
          >
            {loadMoreLabel}
          </button>
        </div>
      )}
    </div>
  );
};
