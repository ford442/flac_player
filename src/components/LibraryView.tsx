import React, { useState, useMemo } from 'react';
import { PlaylistTrack, TagInfo, LibraryStats } from '../audioLoader';
import { StarRating } from './StarRating';
import { TagInput } from './TagInput';

interface LibraryViewProps {
  tracks: PlaylistTrack[];
  allTags: TagInfo[];
  stats: LibraryStats;
  currentTrackId?: string;
  isPlaying: boolean;
  viewMode: 'grid' | 'list';
  onTrackClick: (track: PlaylistTrack) => void;
  onTrackDoubleClick: (track: PlaylistTrack) => void;
  onUpdateTrack: (id: string, updates: Partial<PlaylistTrack>) => Promise<void>;
  onTrashTrack: (id: string) => Promise<void>;
  onPlayNow?: (track: PlaylistTrack) => void;
  onPlayNext?: (track: PlaylistTrack) => void;
  onAddToQueue?: (track: PlaylistTrack) => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  isLoading?: boolean;
}

interface EditingState {
  trackId: string | null;
  rating: number | undefined;
  tags: string[];
  isSaving: boolean;
}

export const LibraryView: React.FC<LibraryViewProps> = ({
  tracks,
  allTags,
  currentTrackId,
  isPlaying,
  viewMode,
  onTrackClick,
  onTrackDoubleClick,
  onUpdateTrack,
  onTrashTrack,
  onPlayNow,
  onPlayNext,
  onAddToQueue,
  onLoadMore,
  hasMore,
  isLoading
}) => {
  const [editing, setEditing] = useState<EditingState>({
    trackId: null,
    rating: undefined,
    tags: [],
    isSaving: false
  });

  const tagNames = useMemo(() => allTags.map(t => t.name), [allTags]);

  const startEditing = (track: PlaylistTrack) => {
    setEditing({
      trackId: track.id,
      rating: track.rating,
      tags: [...(track.tags || [])],
      isSaving: false
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
      setEditing({ trackId: null, rating: undefined, tags: [], isSaving: false });
    }
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

  // Grid View
  if (viewMode === 'grid') {
    return (
      <div className="library-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 p-4 flex-1 overflow-y-auto">
        {tracks.map((track) => {
          const isCurrent = track.id === currentTrackId;
          const isEditing = editing.trackId === track.id;

          return (
            <div
              key={track.id}
              onClick={() => onTrackClick(track)}
              onDoubleClick={() => onTrackDoubleClick(track)}
              className={`library-card group relative bg-white/5 rounded-lg overflow-hidden cursor-pointer transition-all hover:bg-white/10 ${
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
                {isCurrent && isPlaying && (
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
                <span className="text-3xl opacity-50">🎵</span>

                {/* Play Actions Overlay */}
                {(onPlayNow || onPlayNext || onAddToQueue) && (
                  <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/90 via-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex gap-2 justify-center">
                    {onPlayNow && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onPlayNow(track);
                        }}
                        className="px-2 py-1 bg-purple-500 text-white rounded text-xs font-medium hover:bg-purple-600 transition-colors"
                        title="Play Now"
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
                  <StarRating rating={track.rating} maxRating={5} size="sm" readonly />
                  <span className="text-xs text-gray-500">
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
              <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    startEditing(track);
                  }}
                  className="p-1.5 bg-black/50 rounded text-white hover:bg-purple-500 transition-colors"
                  title="Edit"
                >
                  ✏️
                </button>
                <button
                  onClick={(e) => handleTrash(track.id, e)}
                  className="p-1.5 bg-black/50 rounded text-white hover:bg-red-500 transition-colors"
                  title="Trash"
                >
                  🗑️
                </button>
              </div>

              {/* Inline Edit Modal */}
              {isEditing && (
                <div
                  className="absolute inset-0 bg-[#1a1a2e]/95 p-3 flex flex-col gap-3"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div>
                    <label className="text-xs text-gray-400">Rating</label>
                    <StarRating
                      rating={editing.rating}
                      maxRating={5}
                      onRate={(r) => setEditing(prev => ({ ...prev, rating: r }))}
                      showTrash
                    />
                  </div>
                  <div className="flex-1">
                    <label className="text-xs text-gray-400">Tags</label>
                    <TagInput
                      tags={editing.tags}
                      availableTags={tagNames}
                      onChange={(tags) => setEditing(prev => ({ ...prev, tags }))}
                      maxTags={8}
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={saveEdit}
                      disabled={editing.isSaving}
                      className="flex-1 px-3 py-1.5 bg-purple-500 text-white rounded text-sm hover:bg-purple-600 disabled:opacity-50"
                    >
                      {editing.isSaving ? '...' : 'Save'}
                    </button>
                    <button
                      onClick={() => setEditing({ trackId: null, rating: undefined, tags: [], isSaving: false })}
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
            {isLoading ? 'Loading...' : 'Load More'}
          </button>
        )}
      </div>
    );
  }

  // List View
  return (
    <div className="library-list flex-1 overflow-y-auto">
      <table className="w-full text-left">
        <thead className="sticky top-0 bg-[#0f0f1e] z-10">
          <tr className="border-b border-white/10 text-gray-400 text-sm">
            <th className="p-3">Title</th>
            <th className="p-3">Author</th>
            <th className="p-3">Rating</th>
            <th className="p-3">Tags</th>
            <th className="p-3">Duration</th>
            <th className="p-3">Plays</th>
            <th className="p-3">Added</th>
            <th className="p-3 w-40"></th>
          </tr>
        </thead>
        <tbody>
          {tracks.map((track) => {
            const isCurrent = track.id === currentTrackId;
            const isEditing = editing.trackId === track.id;

            return (
              <tr
                key={track.id}
                onClick={() => onTrackClick(track)}
                onDoubleClick={() => onTrackDoubleClick(track)}
                className={`group border-b border-white/5 hover:bg-white/5 cursor-pointer ${
                  isCurrent ? 'bg-purple-500/10' : ''
                }`}
              >
                <td className="p-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-gradient-to-br from-purple-900 to-blue-900 rounded flex items-center justify-center text-lg">
                      {isCurrent && isPlaying ? '▶' : '🎵'}
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
                <td className="p-3 text-gray-400">{formatDuration(track.duration)}</td>
                <td className="p-3 text-gray-400">{track.play_count || 0}</td>
                <td className="p-3 text-gray-400 text-sm">{formatDate(track.created_at)}</td>
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
                      >
                        ✓
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditing({ trackId: null, rating: undefined, tags: [], isSaving: false });
                        }}
                        className="px-2 py-1 bg-white/10 text-white rounded text-xs hover:bg-white/20"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      {onPlayNow && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onPlayNow(track);
                          }}
                          className="p-1 text-gray-400 hover:text-purple-400"
                          title="Play Now"
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
                      >
                        ✏️
                      </button>
                      <button
                        onClick={(e) => handleTrash(track.id, e)}
                        className="p-1 text-gray-400 hover:text-red-500"
                        title="Trash"
                      >
                        🗑️
                      </button>
                    </div>
                  )}
                </td>
              </tr>
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
            {isLoading ? 'Loading...' : 'Load More'}
          </button>
        </div>
      )}
    </div>
  );
};
