import React, { useState, useCallback } from 'react';
import { PlaylistTrack, RepeatMode } from '../audioLoader';

interface QueuePanelProps {
  queue: PlaylistTrack[];
  currentIndex: number;
  isOpen: boolean;
  onClose: () => void;
  onTrackClick: (index: number) => void;
  onRemoveTrack: (index: number) => void;
  onClearQueue: () => void;
  onShuffle: () => void;
  onSmartMix: () => void;
  onShareQueue?: () => void;
  onReorderQueue?: (startIndex: number, endIndex: number) => void;
  shuffle: boolean;
  repeatMode: RepeatMode;
  onToggleRepeat: () => void;
}

export const QueuePanel: React.FC<QueuePanelProps> = ({
  queue,
  currentIndex,
  isOpen,
  onClose,
  onTrackClick,
  onRemoveTrack,
  onClearQueue,
  onShuffle,
  onSmartMix,
  onShareQueue,
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
    <div className="queue-panel fixed right-0 top-0 bottom-0 w-80 bg-[#0f0f1e]/95 border-l border-white/10 shadow-2xl flex flex-col z-40">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-white/10">
        <div>
          <h3 className="font-semibold text-white">Queue</h3>
          <p className="text-xs text-gray-400">
            {queue.length} tracks • {totalMinutes} min
          </p>
        </div>
        <button
          onClick={onClose}
          className="p-2 text-gray-400 hover:text-white transition-colors"
        >
          ✕
        </button>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-2 p-3 border-b border-white/10">
        <button
          onClick={onShuffle}
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
            onClick={onShareQueue}
            className="px-3 py-1.5 text-sm bg-white/10 text-gray-300 rounded hover:bg-white/20 transition-colors"
            title="Share Queue"
          >
            🔗
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
          <div className="divide-y divide-white/5">
            {queue.map((track, index) => {
              const isCurrent = index === currentIndex;
              const isDragOver = dragOverIndex === index && draggedIndex !== index;

              return (
                <div key={`${track.id}-${index}`}>
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
                    className={`group flex items-center gap-3 p-3 cursor-pointer transition-colors ${
                      isCurrent
                        ? 'bg-purple-500/20 border-l-2 border-purple-500'
                        : 'hover:bg-white/5 border-l-2 border-transparent'
                    } ${onReorderQueue ? 'cursor-move' : ''}`}
                  >
                    <div className="w-8 text-center text-sm text-gray-500">
                      {isCurrent ? (
                        <span className="text-purple-400">▶</span>
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
                      className="opacity-0 group-hover:opacity-100 p-1 text-gray-500 hover:text-red-400 transition-all"
                    >
                      ✕
                    </button>
                  </div>

                  {/* Drop indicator below item */}
                  {isDragOver && draggedIndex !== null && draggedIndex < index && (
                    <div className="h-0.5 bg-purple-500 mx-2 rounded-full" />
                  )}
                </div>
              );
            })}
          </div>
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
