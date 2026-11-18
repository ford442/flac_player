import React, { useMemo, useRef } from 'react';
import type { PlaylistTrack, TagInfo, LibraryStats } from '../types/library';
import { TrackCard } from './library/TrackCard';
import { TrackRow, TRACK_ROW_COLUMNS } from './library/TrackRow';
import { TrackEditor } from './library/TrackEditor';
import { useTrackEditing } from './library/useTrackEditing';
import type { OfflineBadgeCallbacks, TrackItemActions } from './library/trackItem';
import { useGridColumns, useWindowedRows } from './library/useWindowedRows';
import { isLibraryTrack } from '../types/track';

/** Grid gap (`gap-4`) and list header height, px; rows are measured once rendered. */
const GRID_GAP_PX = 16;
const GRID_ROW_ESTIMATE_PX = 300;
const LIST_ROW_ESTIMATE_PX = 53;
const LIST_HEADER_PX = 45;

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
    else if ((e.key === 'e' || e.key === 'E') && isLibraryTrack(track)) editing.start(track);
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

  // Both layouts are windowed (#284): only the rows near the viewport mount.
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridColumns = useGridColumns();
  const columns = viewMode === 'grid' ? gridColumns : 1;
  const windowed = useWindowedRows({
    count: tracks.length,
    columns,
    estimateRowHeight: viewMode === 'grid' ? GRID_ROW_ESTIMATE_PX : LIST_ROW_ESTIMATE_PX,
    rowGap: viewMode === 'grid' ? GRID_GAP_PX : 0,
    offsetTop: viewMode === 'grid' ? GRID_GAP_PX : LIST_HEADER_PX,
    scrollRef,
  });
  const visible = tracks.slice(windowed.start, windowed.end);

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
      <div ref={scrollRef} className="library-grid-scroll flex-1 overflow-y-auto">
        <div
          role="list"
          aria-label="Library"
          aria-busy={isLoading}
          className="library-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 px-4 content-start"
          style={{ paddingTop: GRID_GAP_PX + windowed.padTop, paddingBottom: GRID_GAP_PX + windowed.padBottom }}
        >
          {visible.map((track, i) => (
            <TrackCard
              key={track.id}
              {...itemProps(track)}
              position={windowed.start + i + 1}
              setSize={tracks.length}
              itemRef={i === 0 ? windowed.measureRef : undefined}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="library-list flex-1 overflow-y-auto">
      <table className="w-full text-left" aria-label="Library" aria-busy={isLoading} aria-rowcount={tracks.length + 1}>
        <thead className="sticky top-0 bg-surface z-10">
          <tr className="border-b border-white/10 text-gray-400 text-sm" aria-rowindex={1}>
            {TRACK_ROW_COLUMNS.map(column => <th key={column} className="p-3">{column}</th>)}
            <th className="p-3 w-40"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {windowed.padTop > 0 && <tr aria-hidden="true" style={{ height: windowed.padTop }} />}
          {visible.map((track, i) => (
            <TrackRow
              key={track.id}
              {...itemProps(track)}
              position={windowed.start + i + 2}
              itemRef={i === 0 ? windowed.measureRef : undefined}
            />
          ))}
          {windowed.padBottom > 0 && <tr aria-hidden="true" style={{ height: windowed.padBottom }} />}
        </tbody>
      </table>
    </div>
  );
};
