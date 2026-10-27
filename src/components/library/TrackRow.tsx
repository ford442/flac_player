import React from 'react';
import { StarRating } from '../StarRating';
import { OfflineBadge } from '../OfflineCache';
import { formatDate, formatDuration, formatReplayGainBadge, trackItemLabel } from './trackFormat';
import type { TrackItemProps } from './trackItem';

export const TRACK_ROW_COLUMNS = ['Title', 'Author', 'Rating', 'Tags', 'RG', 'Duration', 'Plays', 'Added', 'Offline'] as const;

/** List row. `editor` (a TrackEditor) opens in a full-width row underneath. */
export const TrackRow: React.FC<TrackItemProps> = ({
  track, isCurrent, isLoading, isPlaying, editor, actions, offline, onKeyDown,
}) => {
  const { onPlayNow, onPlayNext, onAddToQueue, onRegenerate } = actions;

  return (
    <>
      <tr
        onClick={() => actions.onClick(track)}
        onDoubleClick={() => actions.onDoubleClick(track)}
        onKeyDown={onKeyDown}
        tabIndex={0}
        aria-label={trackItemLabel(track)}
        aria-current={isCurrent ? 'true' : undefined}
        aria-expanded={editor ? true : undefined}
        data-testid="library-track"
        className={`group focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-purple-400 border-b border-white/5 hover:bg-white/5 cursor-pointer ${
          isCurrent ? 'bg-purple-500/10' : ''
        } ${isLoading ? 'opacity-60' : ''}`}
      >
        <td className="p-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gradient-to-br from-purple-900 to-blue-900 rounded flex items-center justify-center text-lg" aria-hidden="true">
              {isLoading ? <div className="spinner" /> : isCurrent && isPlaying ? '▶' : '🎵'}
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
          <StarRating rating={track.rating} maxRating={5} size="sm" readonly />
        </td>
        <td className="p-3">
          <div className="flex flex-wrap gap-1">
            {track.tags?.slice(0, 3).map(tag => (
              <span key={tag} className="text-xs px-2 py-0.5 bg-white/10 rounded-full text-gray-300">
                {tag}
              </span>
            ))}
            {(track.tags?.length || 0) > 3 && (
              <span className="text-xs text-gray-400">+{(track.tags?.length || 0) - 3}</span>
            )}
          </div>
        </td>
        <td className="p-3 text-gray-400 font-mono text-xs">
          {formatReplayGainBadge(track) ?? '—'}
        </td>
        <td className="p-3 text-gray-400">{formatDuration(track.duration)}</td>
        <td className="p-3 text-gray-400">{track.play_count || 0}</td>
        <td className="p-3 text-gray-400 text-sm">{formatDate(track.created_at)}</td>
        <td className="p-3">
          <OfflineBadge track={track} {...offline} />
        </td>
        <td className="p-3">
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
                onClick={(e) => { e.stopPropagation(); onPlayNow(track); }}
                className="p-1 text-gray-400 hover:text-purple-400"
                title="Play Now"
                aria-label="Play Now"
              >
                ▶
              </button>
            )}
            {onPlayNext && (
              <button
                onClick={(e) => { e.stopPropagation(); onPlayNext(track); }}
                className="p-1 text-gray-400 hover:text-blue-400"
                title="Play Next"
                aria-label="Play Next"
              >
                ⏭
              </button>
            )}
            {onAddToQueue && (
              <button
                onClick={(e) => { e.stopPropagation(); onAddToQueue(track); }}
                className="p-1 text-gray-400 hover:text-green-400"
                title="Add to Queue"
                aria-label="Add to Queue"
              >
                ＋
              </button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); actions.onEdit(track); }}
              className="p-1 text-gray-400 hover:text-white"
              title="Edit"
              aria-label="Edit"
            >
              ✏️
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); actions.onTrash(track); }}
              className="p-1 text-gray-400 hover:text-red-500"
              title="Trash"
              aria-label="Trash"
            >
              🗑️
            </button>
          </div>
        </td>
      </tr>
      {editor && (
        <tr className="border-b border-white/5 bg-white/5">
          <td colSpan={TRACK_ROW_COLUMNS.length + 1} className="p-3">
            <div className="max-w-xl">{editor}</div>
          </td>
        </tr>
      )}
    </>
  );
};
