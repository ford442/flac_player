import React, { useMemo } from 'react';
import { hasReplayGainMetadata } from '../../utils/replayGain';
import { StarRating } from '../StarRating';
import { OfflineBadge } from '../OfflineCache';
import { formatDuration, formatReplayGainBadge, placeholderBars, trackItemLabel } from './trackFormat';
import type { TrackItemProps } from './trackItem';

/** Grid tile. `editor` (a TrackEditor) covers the tile while this track is being edited. */
export const TrackCard: React.FC<TrackItemProps> = ({
  track, isCurrent, isLoading, isPlaying, editor, actions, offline, onKeyDown,
}) => {
  const bars = useMemo(() => placeholderBars(track.id), [track.id]);
  const { onPlayNow, onPlayNext, onAddToQueue, onRegenerate } = actions;

  return (
    // A keyboard-operable tile (Space / Enter / E in onKeyDown) inside role="list"; Phase 3 revisits
    // the grid semantics together with virtualization.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      onClick={() => actions.onClick(track)}
      onDoubleClick={() => actions.onDoubleClick(track)}
      onKeyDown={onKeyDown}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      role="listitem"
      aria-label={trackItemLabel(track)}
      aria-current={isCurrent ? 'true' : undefined}
      data-testid="library-track"
      className={`library-card group relative focus-visible:outline focus-visible:outline-2 focus-visible:outline-purple-400 bg-white/5 rounded-lg overflow-hidden cursor-pointer transition-all hover:bg-white/10 ${
        isCurrent ? 'ring-2 ring-purple-500' : ''
      }`}
    >
      {/* Waveform placeholder */}
      <div className="aspect-square bg-gradient-to-br from-purple-900/50 to-blue-900/50 flex items-center justify-center relative overflow-hidden">
        <div className="absolute inset-0 opacity-30" aria-hidden="true">
          {bars.map((height, i) => (
            <div
              key={i}
              className="absolute bottom-0 w-1 bg-white/30 rounded-t"
              style={{ left: `${i * 5}%`, height: `${height}%` }}
            />
          ))}
        </div>
        {isCurrent && isPlaying && !isLoading && (
          <div className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
            <div className="flex gap-1">
              {Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className="w-1 bg-purple-400 animate-pulse"
                  style={{ height: '20px', animationDelay: `${i * 0.1}s` }}
                />
              ))}
            </div>
          </div>
        )}
        {isLoading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 z-10">
            <div className="flex flex-col items-center gap-2">
              <div className="spinner spinner-lg" />
              <span className="text-xs text-white font-medium">Loading…</span>
            </div>
          </div>
        ) : (
          <span className="text-3xl opacity-50" aria-hidden="true">🎵</span>
        )}

        {/* Play actions overlay */}
        {(onPlayNow || onPlayNext || onAddToQueue) && (
          <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/90 via-black/60 to-transparent opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity flex gap-2 justify-center">
            {onPlayNow && (
              <button
                onClick={(e) => { e.stopPropagation(); onPlayNow(track); }}
                className="px-2 py-1 bg-purple-600 text-white rounded text-xs font-medium hover:bg-purple-700 transition-colors"
                title="Play Now"
                aria-label="Play Now"
              >
                ▶ Play
              </button>
            )}
            {onPlayNext && (
              <button
                onClick={(e) => { e.stopPropagation(); onPlayNext(track); }}
                className="px-2 py-1 bg-blue-600 text-white rounded text-xs font-medium hover:bg-blue-700 transition-colors"
                title="Play Next"
                aria-label="Play Next"
              >
                ⏭ Next
              </button>
            )}
            {onAddToQueue && (
              <button
                onClick={(e) => { e.stopPropagation(); onAddToQueue(track); }}
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
          <span className="flex items-center gap-2 text-xs text-gray-400">
            <OfflineBadge track={track} {...offline} />
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
              <span className="text-xs text-gray-400">+{track.tags.length - 3}</span>
            )}
          </div>
        )}
      </div>

      {/* Quick actions */}
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
          onClick={(e) => { e.stopPropagation(); actions.onEdit(track); }}
          className="p-1.5 bg-black/50 rounded text-white hover:bg-purple-600 transition-colors"
          title="Edit"
          aria-label="Edit"
        >
          ✏️
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); actions.onTrash(track); }}
          className="p-1.5 bg-black/50 rounded text-white hover:bg-red-500 transition-colors"
          title="Trash"
          aria-label="Trash"
        >
          🗑️
        </button>
      </div>

      {editor && (
        <div className="absolute inset-0 bg-surface-raised p-3 overflow-y-auto z-20">
          {editor}
        </div>
      )}
    </div>
  );
};
