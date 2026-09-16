import React, { useState, useCallback } from 'react';
import { PlaylistTrack, RepeatMode } from '../audioLoader';

interface QueuePanelProps {
  queue: PlaylistTrack[];
  currentIndex: number;
  loadingTrackId?: string;
  prebufferingNext?: boolean;
  isOpen: boolean;
  onClose: () => void;
  onTrackClick: (index: number) => void;
  onRemoveTrack: (index: number) => void;
  onClearQueue: () => void;
  onShuffle: () => void;
  onSmartMix: () => void;
  onShareQueue?: () => void;
  onDownloadQueue?: () => void;
  onReorderQueue?: (startIndex: number, endIndex: number) => void;
  shuffle: boolean;
  repeatMode: RepeatMode;
  onToggleRepeat: () => void;
}

export const QueuePanel: React.FC<QueuePanelProps> = ({
  queue,
  currentIndex,
  loadingTrackId,
  prebufferingNext = false,
  isOpen,
  onClose,
  onTrackClick,
  onRemoveTrack,
  onClearQueue,
  onShuffle,
  onSmartMix,
  onShareQueue,
  onDownloadQueue,
  onReorderQueue,
  shuffle,
  repeatMode,
  onToggleRepeat
}) => {
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const formatDuration = (seconds?: number) => {
    if (!seconds) return '--:--';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const totalDuration = queue.reduce((acc, track) => acc + (track.duration || 0), 0);
  const totalMinutes = Math.floor(totalDuration / 60);

  const handleDragStart = useCallback((index: number, e: React.DragEvent) => {
    if (!onReorderQueue) return;
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
    // Slight delay to keep the element visible while dragging
    const el = e.currentTarget as HTMLElement;
    el.classList.add('opacity-50');
  }, [onReorderQueue]);

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.classList.remove('opacity-50');
    setDraggedIndex(null);
    setDragOverIndex(null);
  }, []);

  const handleDragOver = useCallback((index: number, e: React.DragEvent) => {
    if (!onReorderQueue) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  }, [onReorderQueue]);

  const handleDragLeave = useCallback(() => {
    setDragOverIndex(null);
  }, []);

  const handleDrop = useCallback((targetIndex: number, e: React.DragEvent) => {
    if (!onReorderQueue) return;
    e.preventDefault();
    const sourceIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (!isNaN(sourceIndex) && sourceIndex !== targetIndex) {
      onReorderQueue(sourceIndex, targetIndex);
    }
    setDragOverIndex(null);
    setDraggedIndex(null);
  }, [onReorderQueue]);

  if (!isOpen) return null;

  return (
    <div role="complementary" aria-label="Play queue" className="queue-panel fixed right-0 top-0 bottom-0 w-80 bg-[#0f0f1e]/95 border-l border-white/10 shadow-2xl flex flex-col z-40">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-white/10">
        <div>
          <h3 className="font-semibold text-white">Queue</h3>
          <p className="text-xs text-gray-400">
            {queue.length} tracks • {totalMinutes} min
            {prebufferingNext && (
              <span className="ml-2 text-purple-300" title="Pre-buffering next track for gapless playback">
                • pre-buffering next
              </span>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close queue"
          className="p-2 text-gray-400 hover:text-white transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-purple-400 rounded"
        >
          ✕
        </button>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-2 p-3 border-b border-white/10">
        <button
          type="button"
          onClick={onShuffle}
          aria-pressed={shuffle}
          className={`flex-1 px-3 py-1.5 text-sm rounded transition-colors ${
            shuffle
              ? 'bg-purple-500 text-white'
              : 'bg-white/10 text-gray-300 hover:bg-white/20'
          }`}
        >
          🔀 Shuffle
        </button>
        <button
          onClick={onToggleRepeat}
          className={`px-3 py-1.5 text-sm rounded transition-colors ${
            repeatMode !== 'off'
              ? 'bg-purple-500 text-white'
              : 'bg-white/10 text-gray-300 hover:bg-white/20'
          }`}
          title={`Repeat: ${repeatMode}`}
          aria-label={`Repeat: ${repeatMode}`}
          aria-pressed={repeatMode !== 'off'}
        >
          {repeatMode === 'one' ? '🔂' : '🔁'}
        </button>
        <button
          onClick={onSmartMix}
          className="flex-1 px-3 py-1.5 text-sm bg-gradient-to-r from-purple-500 to-blue-500 text-white rounded hover:opacity-90 transition-opacity"
        >
          ✨ Smart Mix
        </button>
        {onShareQueue && (
          <button
            type="button"
            onClick={onShareQueue}
            aria-label="Share queue"
            className="px-3 py-1.5 text-sm bg-white/10 text-gray-300 rounded hover:bg-white/20 transition-colors"
            title="Share Queue"
          >
            🔗
          </button>
        )}
        {onDownloadQueue && (
          <button
            type="button"
            onClick={onDownloadQueue}
            disabled={queue.length === 0}
            className="px-3 py-1.5 text-sm bg-white/10 text-gray-300 rounded hover:bg-white/20 disabled:opacity-40 transition-colors"
            title="Download queue for offline"
            aria-label="Download queue for offline"
          >
            ↓
          </button>
        )}
      </div>

      {/* Track List */}
      <div className="flex-1 overflow-y-auto">
        {queue.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <p className="text-4xl mb-2">🎵</p>
            <p>Queue is empty</p>
            <p className="text-sm mt-2">Add tracks from the library</p>
          </div>
        ) : (
          <ol className="divide-y divide-white/5" aria-label="Queued tracks">
            {queue.map((track, index) => {
              const isCurrent = index === currentIndex;
              const isLoadingTrack = track.id === loadingTrackId;
              const isNextPrebuffering = prebufferingNext && index === currentIndex + 1 && currentIndex >= 0;
              const isDragOver = dragOverIndex === index && draggedIndex !== index;

              return (
                <li key={`${track.id}-${index}`}>
                  {/* Drop indicator above item */}
                  {isDragOver && draggedIndex !== null && draggedIndex > index && (
                    <div className="h-0.5 bg-purple-500 mx-2 rounded-full" />
                  )}

                  <div
                    draggable={!!onReorderQueue}
                    onDragStart={(e) => handleDragStart(index, e)}
                    onDragEnd={handleDragEnd}
                    onDragOver={(e) => handleDragOver(index, e)}
                    onDragLeave={handleDragLeave}
                    onDrop={(e) => handleDrop(index, e)}
                    onClick={() => onTrackClick(index)}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === 'Enter' || e.key === ' ') onTrackClick(index);
                      else if (e.key === 'Delete' || e.key === 'Backspace') onRemoveTrack(index);
                      else if (onReorderQueue && e.altKey && e.key === 'ArrowUp' && index > 0) onReorderQueue(index, index - 1);
                      else if (onReorderQueue && e.altKey && e.key === 'ArrowDown' && index < queue.length - 1) onReorderQueue(index, index + 1);
                      else return;
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    tabIndex={0}
                    role="button"
                    aria-current={isCurrent ? 'true' : undefined}
                    aria-label={`${index + 1}. ${track.title || track.name}${isCurrent ? ' (playing)' : ''}. Enter to play, Delete to remove${onReorderQueue ? ', Alt+Arrow to move' : ''}`}
                    className={`group flex focus-visible:outline focus-visible:outline-2 focus-visible:outline-purple-400 items-center gap-3 p-3 cursor-pointer transition-colors ${
                      isCurrent
                        ? 'bg-purple-500/20 border-l-2 border-purple-500'
                        : 'hover:bg-white/5 border-l-2 border-transparent'
                    } ${onReorderQueue ? 'cursor-move' : ''} ${isLoadingTrack ? 'opacity-60' : ''}`}
                  >
                    <div className="w-8 text-center text-sm text-gray-500">
                      {isLoadingTrack ? (
                        <div className="spinner mx-auto" style={{ width: '14px', height: '14px', borderWidth: '2px' }} />
                      ) : isCurrent ? (
                        <span className="text-purple-400">▶</span>
                      ) : isNextPrebuffering ? (
                        <span className="text-purple-300" title="Pre-buffering">⏳</span>
                      ) : (
                        index + 1
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className={`truncate font-medium ${isCurrent ? 'text-purple-200' : 'text-white'}`}>
                        {track.title || track.name}
                      </div>
                      <div className="text-xs text-gray-400 truncate">
                        {track.author || 'Unknown'} • {formatDuration(track.duration)}
                      </div>
                    </div>

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemoveTrack(index);
                      }}
                      type="button"
                      tabIndex={-1}
                      aria-label={`Remove ${track.title || track.name} from queue`}
                      className="opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 p-1 text-gray-500 hover:text-red-400 transition-all"
                    >
                      ✕
                    </button>
                  </div>

                  {/* Drop indicator below item */}
                  {isDragOver && draggedIndex !== null && draggedIndex < index && (
                    <div className="h-0.5 bg-purple-500 mx-2 rounded-full" />
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {/* Footer */}
      {queue.length > 0 && (
        <div className="p-3 border-t border-white/10">
          <button
            onClick={onClearQueue}
            className="w-full px-4 py-2 text-sm text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded transition-colors"
          >
            Clear Queue
          </button>
        </div>
      )}
    </div>
  );
};
