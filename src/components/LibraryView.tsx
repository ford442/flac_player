import React, { useState, useMemo, useEffect, useRef } from 'react';
import { PlaylistTrack, TagInfo, LibraryStats } from '../audioLoader';
import { hasReplayGainMetadata } from '../utils/replayGain';
import { StarRating } from './StarRating';
import { TagInput } from './TagInput';
import { OfflineBadge } from './OfflineCache';
import { MusicBrainzPanel } from './MusicBrainzPanel';
import { suggestTags } from '../api/songApi';

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

interface EditingState {
  trackId: string | null;
  rating: number | undefined;
  tags: string[];
  isSaving: boolean;
  suggestedTags: string[];
  suggestionsLoading: boolean;
  showMusicBrainz: boolean;
}

const EMPTY_EDIT: EditingState = {
  trackId: null, rating: undefined, tags: [], isSaving: false,
  suggestedTags: [], suggestionsLoading: false, showMusicBrainz: false,
};

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
  const [editing, setEditing] = useState<EditingState>(EMPTY_EDIT);
  const editingIdRef = useRef<string | null>(null);
  editingIdRef.current = editing.trackId;

  // Escape closes the inline editor from anywhere.
  useEffect(() => {
    if (!editing.trackId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setEditing(EMPTY_EDIT); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing.trackId]);

  const notifyOfflineError = (message: string) => onNotify?.(message, 'error');
  const notifyOfflineSaved = () => onNotify?.('Saved for offline', 'success');
  const notifyOfflineRemoved = () => onNotify?.('Removed from offline cache', 'info');

  const tagNames = useMemo(() => allTags.map(t => t.name), [allTags]);

  const startEditing = (track: PlaylistTrack) => {
    setEditing({
      ...EMPTY_EDIT,
      trackId: track.id,
      rating: track.rating,
      tags: [...(track.tags || [])],
      suggestionsLoading: true,
    });
    suggestTags(track.id).then(({ suggestions }) => {
      if (editingIdRef.current !== track.id) return;
      setEditing(prev => ({ ...prev, suggestedTags: suggestions || [], suggestionsLoading: false }));
    });
  };

  const saveEdit = async () => {
    if (!editing.trackId) return;

    setEditing(prev => ({ ...prev, isSaving: true }));

    try {
      const track = tracks.find(t => t.id === editing.trackId);
      if (track) {
        const updates: Partial<PlaylistTrack> = {};
        if (editing.rating !== track.rating) updates.rating = editing.rating;
        if (JSON.stringify(editing.tags) !== JSON.stringify(track.tags || [])) {
          updates.tags = editing.tags;
        }

        if (Object.keys(updates).length > 0) {
          await onUpdateTrack(track.id, updates);
        }
      }
    } finally {
      setEditing(EMPTY_EDIT);
    }
  };

  const handleRowKeyDown = (track: PlaylistTrack, e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter') onTrackDoubleClick(track);
    else if (e.key === ' ') onTrackClick(track);
    else if (e.key === 'e' || e.key === 'E') startEditing(track);
    else return;
    // Keep global shortcuts (Space = play/pause) from also firing.
    e.preventDefault();
    e.stopPropagation();
  };

  const rowLabel = (track: PlaylistTrack) =>
    `${track.title || track.name} by ${track.author || 'Unknown'}. Space to queue and play, Enter to play now, E to edit`;

  const toggleMusicBrainz = () => setEditing(prev => ({ ...prev, showMusicBrainz: !prev.showMusicBrainz }));

  const applyMetadata = async (track: PlaylistTrack, updates: Partial<PlaylistTrack>) => {
    await onUpdateTrack(track.id, updates);
    if (updates.tags) setEditing(prev => ({ ...prev, tags: [...updates.tags!] }));
  };

  const handleTrash = async (trackId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm('Mark this track as trash?')) {
      await onTrashTrack(trackId);
    }
  };

  const formatDuration = (seconds?: number) => {
    if (!seconds) return '--:--';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '--';
    return new Date(dateStr).toLocaleDateString();
  };

  const formatReplayGainBadge = (track: PlaylistTrack) => {
    const db = track.replaygain_track_db ?? track.replaygain_album_db;
    if (db === undefined) return null;
    const sign = db >= 0 ? '+' : '';
    return `${sign}${db.toFixed(1)} dB`;
  };

  if (tracks.length === 0 && !isLoading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-gray-500" role="status">
        <p className="text-4xl mb-2" aria-hidden="true">🎵</p>
        <p>No tracks match the current filters.</p>
      </div>
    );
  }

  // Grid View
  if (viewMode === 'grid') {
    return (
      <div role="list" aria-label="Library" aria-busy={isLoading} className="library-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 p-4 flex-1 overflow-y-auto">
        {tracks.map((track) => {
          const isCurrent = track.id === currentTrackId;
          const isLoadingTrack = track.id === loadingTrackId;
          const isEditing = editing.trackId === track.id;

          return (
            <div
              key={track.id}
              onClick={() => onTrackClick(track)}
              onDoubleClick={() => onTrackDoubleClick(track)}
              onKeyDown={(e) => handleRowKeyDown(track, e)}
              tabIndex={0}
              role="listitem"
              aria-label={rowLabel(track)}
              aria-current={isCurrent ? 'true' : undefined}
              data-testid="library-track"
              className={`library-card group relative focus-visible:outline focus-visible:outline-2 focus-visible:outline-purple-400 bg-white/5 rounded-lg overflow-hidden cursor-pointer transition-all hover:bg-white/10 ${
                isCurrent ? 'ring-2 ring-purple-500' : ''
              }`}
            >
              {/* Waveform Placeholder */}
              <div className="aspect-square bg-gradient-to-br from-purple-900/50 to-blue-900/50 flex items-center justify-center relative overflow-hidden">
                <div className="absolute inset-0 opacity-30">
                  {Array.from({ length: 20 }).map((_, i) => (
                    <div
                      key={i}
                      className="absolute bottom-0 w-1 bg-white/30 rounded-t"
                      style={{
                        left: `${i * 5}%`,
                        height: `${30 + Math.random() * 60}%`
                      }}
                    />
                  ))}
                </div>
                {isCurrent && isPlaying && !isLoadingTrack && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="flex gap-1">
                      {Array.from({ length: 4 }).map((_, i) => (
                        <div
                          key={i}
                          className="w-1 bg-purple-400 animate-pulse"
                          style={{
                            height: '20px',
                            animationDelay: `${i * 0.1}s`
                          }}
                        />
                      ))}
                    </div>
                  </div>
                )}
                {isLoadingTrack ? (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/40 z-10">
                    <div className="flex flex-col items-center gap-2">
                      <div className="spinner spinner-lg" />
                      <span className="text-xs text-white font-medium">Loading…</span>
                    </div>
                  </div>
                ) : (
                  <span className="text-3xl opacity-50">🎵</span>
                )}

                {/* Play Actions Overlay */}
                {(onPlayNow || onPlayNext || onAddToQueue) && (
                  <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/90 via-black/60 to-transparent opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity flex gap-2 justify-center">
                    {onPlayNow && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onPlayNow(track);
                        }}
                        className="px-2 py-1 bg-purple-500 text-white rounded text-xs font-medium hover:bg-purple-600 transition-colors"
                        title="Play Now"
                        aria-label="Play Now"
                      >
                        ▶ Play
                      </button>
                    )}
                    {onPlayNext && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onPlayNext(track);
                        }}
                        className="px-2 py-1 bg-blue-500 text-white rounded text-xs font-medium hover:bg-blue-600 transition-colors"
                        title="Play Next"
                        aria-label="Play Next"
                      >
                        ⏭ Next
                      </button>
                    )}
                    {onAddToQueue && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onAddToQueue(track);
                        }}
                        className="px-2 py-1 bg-white/20 text-white rounded text-xs font-medium hover:bg-white/30 transition-colors"
                        title="Add to Queue"
                        aria-label="Add to Queue"
                      >
                        ＋ Queue
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Info */}
              <div className="p-3">
                <h4 className="font-medium text-white truncate" title={track.title || track.name}>
                  {track.title || track.name}
                </h4>
                <p className="text-sm text-gray-400 truncate">{track.author || 'Unknown'}</p>

                <div className="mt-2 flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    <StarRating rating={track.rating} maxRating={5} size="sm" readonly />
                    {hasReplayGainMetadata(track) && (
                      <span
                        className="text-[10px] px-1 py-0.5 rounded bg-emerald-900/50 text-emerald-300 font-mono"
                        title={`ReplayGain: ${formatReplayGainBadge(track)}`}
                      >
                        RG
                      </span>
                    )}
                  </div>
                  <span className="flex items-center gap-2 text-xs text-gray-500">
                    <OfflineBadge track={track} onError={notifyOfflineError} onDownload={notifyOfflineSaved} onEvict={notifyOfflineRemoved} />
                    {formatDuration(track.duration)}
                  </span>
                </div>

                {track.tags && track.tags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {track.tags.slice(0, 3).map(tag => (
                      <span key={tag} className="text-xs px-1.5 py-0.5 bg-white/10 rounded text-gray-300">
                        {tag}
                      </span>
                    ))}
                    {track.tags.length > 3 && (
                      <span className="text-xs text-gray-500">+{track.tags.length - 3}</span>
                    )}
                  </div>
                )}
              </div>

              {/* Quick Actions */}
              <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity flex gap-1">
                {track.generation_model && onRegenerate && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onRegenerate(track); }}
                    className="p-1.5 bg-black/50 rounded text-white hover:bg-fuchsia-500 transition-colors"
                    title="Regenerate with variations"
                    aria-label="Regenerate with variations"
                  >
                    ✨
                  </button>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    startEditing(track);
                  }}
                  className="p-1.5 bg-black/50 rounded text-white hover:bg-purple-500 transition-colors"
                  title="Edit"
                  aria-label="Edit"
                >
                  ✏️
                </button>
                <button
                  onClick={(e) => handleTrash(track.id, e)}
                  className="p-1.5 bg-black/50 rounded text-white hover:bg-red-500 transition-colors"
                  title="Trash"
                  aria-label="Trash"
                >
                  🗑️
                </button>
              </div>

              {/* Inline Edit Modal */}
              {isEditing && (
                <div
                  className="absolute inset-0 bg-[#1a1a2e]/95 p-3 flex flex-col gap-3 overflow-y-auto z-20"
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                  role="group"
                  aria-label={`Edit ${track.title || track.name}`}
                >
                  <div>
                    <span className="text-xs text-gray-400">Rating</span>
                    <StarRating
                      rating={editing.rating}
                      maxRating={5}
                      onRate={(r) => setEditing(prev => ({ ...prev, rating: r }))}
                      showTrash
                    />
                  </div>
                  <div className="flex-1">
                    <span className="text-xs text-gray-400">Tags</span>
                    <TagInput
                      tags={editing.tags}
                      availableTags={tagNames}
                      onChange={(tags) => setEditing(prev => ({ ...prev, tags }))}
                      maxTags={8}
                      suggestedTags={editing.suggestedTags}
                      suggestionsLoading={editing.suggestionsLoading}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={toggleMusicBrainz}
                    aria-expanded={editing.showMusicBrainz}
                    className="self-start text-xs text-purple-300 hover:text-purple-200 underline"
                  >
                    {editing.showMusicBrainz ? 'Hide MusicBrainz' : 'Look up on MusicBrainz'}
                  </button>
                  {editing.showMusicBrainz && (
                    <MusicBrainzPanel
                      track={track}
                      onApply={(u) => applyMetadata(track, u)}
                      onNotify={onNotify}
                      onClose={toggleMusicBrainz}
                    />
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={saveEdit}
                      disabled={editing.isSaving}
                      className="flex-1 px-3 py-1.5 bg-purple-500 text-white rounded text-sm hover:bg-purple-600 disabled:opacity-50"
                    >
                      {editing.isSaving ? '...' : 'Save'}
                    </button>
                    <button
                      onClick={() => setEditing(EMPTY_EDIT)}
                      className="px-3 py-1.5 bg-white/10 text-white rounded text-sm hover:bg-white/20"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {hasMore && (
          <button
            onClick={onLoadMore}
            disabled={isLoading}
            className="aspect-square flex items-center justify-center bg-white/5 rounded-lg hover:bg-white/10 transition-colors text-gray-400"
          >
            {isLoading ? 'Loading...' : `Load more (${tracks.length} shown)`}
          </button>
        )}
      </div>
    );
  }

  // List View
  return (
    <div className="library-list flex-1 overflow-y-auto">
      <table className="w-full text-left" aria-label="Library" aria-busy={isLoading}>
        <thead className="sticky top-0 bg-[#0f0f1e] z-10">
          <tr className="border-b border-white/10 text-gray-400 text-sm">
            <th className="p-3">Title</th>
            <th className="p-3">Author</th>
            <th className="p-3">Rating</th>
            <th className="p-3">Tags</th>
            <th className="p-3">RG</th>
            <th className="p-3">Duration</th>
            <th className="p-3">Plays</th>
            <th className="p-3">Added</th>
            <th className="p-3">Offline</th>
            <th className="p-3 w-40"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {tracks.map((track) => {
            const isCurrent = track.id === currentTrackId;
            const isLoadingTrack = track.id === loadingTrackId;
            const isEditing = editing.trackId === track.id;

            return (
              <React.Fragment key={track.id}>
              <tr
                onClick={() => onTrackClick(track)}
                onDoubleClick={() => onTrackDoubleClick(track)}
                onKeyDown={(e) => handleRowKeyDown(track, e)}
                tabIndex={0}
                aria-label={rowLabel(track)}
                aria-current={isCurrent ? 'true' : undefined}
                data-testid="library-track"
                className={`group focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-purple-400 border-b border-white/5 hover:bg-white/5 cursor-pointer ${
                  isCurrent ? 'bg-purple-500/10' : ''
                } ${isLoadingTrack ? 'opacity-60' : ''}`}
              >
                <td className="p-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-gradient-to-br from-purple-900 to-blue-900 rounded flex items-center justify-center text-lg">
                      {isLoadingTrack ? (
                        <div className="spinner" />
                      ) : isCurrent && isPlaying ? (
                        '▶'
                      ) : (
                        '🎵'
                      )}
                    </div>
                    <div>
                      <div className="font-medium text-white">{track.title || track.name}</div>
                      {track.generation_model && (
                        <div className="text-xs text-purple-400">{track.generation_model}</div>
                      )}
                    </div>
                  </div>
                </td>
                <td className="p-3 text-gray-300">{track.author || 'Unknown'}</td>
                <td className="p-3">
                  {isEditing ? (
                    <StarRating
                      rating={editing.rating}
                      maxRating={5}
                      onRate={(r) => setEditing(prev => ({ ...prev, rating: r }))}
                      showTrash
                    />
                  ) : (
                    <StarRating rating={track.rating} maxRating={5} size="sm" readonly />
                  )}
                </td>
                <td className="p-3">
                  {isEditing ? (
                    <TagInput
                      tags={editing.tags}
                      availableTags={tagNames}
                      onChange={(tags) => setEditing(prev => ({ ...prev, tags }))}
                      maxTags={5}
                      suggestedTags={editing.suggestedTags}
                      suggestionsLoading={editing.suggestionsLoading}
                    />
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {track.tags?.slice(0, 3).map(tag => (
                        <span key={tag} className="text-xs px-2 py-0.5 bg-white/10 rounded-full text-gray-300">
                          {tag}
                        </span>
                      ))}
                      {(track.tags?.length || 0) > 3 && (
                        <span className="text-xs text-gray-500">+{(track.tags?.length || 0) - 3}</span>
                      )}
                    </div>
                  )}
                </td>
                <td className="p-3 text-gray-400 font-mono text-xs">
                  {formatReplayGainBadge(track) ?? '—'}
                </td>
                <td className="p-3 text-gray-400">{formatDuration(track.duration)}</td>
                <td className="p-3 text-gray-400">{track.play_count || 0}</td>
                <td className="p-3 text-gray-400 text-sm">{formatDate(track.created_at)}</td>
                <td className="p-3">
                  <OfflineBadge track={track} onError={notifyOfflineError} onDownload={notifyOfflineSaved} onEvict={notifyOfflineRemoved} />
                </td>
                <td className="p-3">
                  {isEditing ? (
                    <div className="flex gap-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          saveEdit();
                        }}
                        disabled={editing.isSaving}
                        className="px-2 py-1 bg-purple-500 text-white rounded text-xs hover:bg-purple-600"
                        aria-label="Save changes"
                      >
                        ✓
                      </button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); toggleMusicBrainz(); }}
                        aria-expanded={editing.showMusicBrainz}
                        className="px-2 py-1 bg-white/10 text-white rounded text-xs hover:bg-white/20"
                        title="Look up on MusicBrainz"
                        aria-label="Look up on MusicBrainz"
                      >
                        MB
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditing(EMPTY_EDIT);
                        }}
                        className="px-2 py-1 bg-white/10 text-white rounded text-xs hover:bg-white/20"
                        aria-label="Cancel editing"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                      {track.generation_model && onRegenerate && (
                        <button
                          onClick={(e) => { e.stopPropagation(); onRegenerate(track); }}
                          className="p-1 text-gray-400 hover:text-fuchsia-400"
                          title="Regenerate with variations"
                          aria-label="Regenerate with variations"
                        >
                          ✨
                        </button>
                      )}
                      {onPlayNow && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onPlayNow(track);
                          }}
                          className="p-1 text-gray-400 hover:text-purple-400"
                          title="Play Now"
                          aria-label="Play Now"
                        >
                          ▶
                        </button>
                      )}
                      {onPlayNext && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onPlayNext(track);
                          }}
                          className="p-1 text-gray-400 hover:text-blue-400"
                          title="Play Next"
                          aria-label="Play Next"
                        >
                          ⏭
                        </button>
                      )}
                      {onAddToQueue && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onAddToQueue(track);
                          }}
                          className="p-1 text-gray-400 hover:text-green-400"
                          title="Add to Queue"
                          aria-label="Add to Queue"
                        >
                          ＋
                        </button>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          startEditing(track);
                        }}
                        className="p-1 text-gray-400 hover:text-white"
                        title="Edit"
                        aria-label="Edit"
                      >
                        ✏️
                      </button>
                      <button
                        onClick={(e) => handleTrash(track.id, e)}
                        className="p-1 text-gray-400 hover:text-red-500"
                        title="Trash"
                        aria-label="Trash"
                      >
                        🗑️
                      </button>
                    </div>
                  )}
                </td>
              </tr>
              {isEditing && editing.showMusicBrainz && (
                <tr className="border-b border-white/5 bg-white/5">
                  <td colSpan={10} className="p-3">
                    <MusicBrainzPanel
                      track={track}
                      onApply={(u) => applyMetadata(track, u)}
                      onNotify={onNotify}
                      onClose={toggleMusicBrainz}
                    />
                  </td>
                </tr>
              )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>

      {hasMore && (
        <div className="p-4 text-center">
          <button
            onClick={onLoadMore}
            disabled={isLoading}
            className="px-4 py-2 bg-white/10 text-white rounded hover:bg-white/20 disabled:opacity-50"
          >
            {isLoading ? 'Loading...' : `Load more (${tracks.length} shown)`}
          </button>
        </div>
      )}
    </div>
  );
};
