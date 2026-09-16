import React from 'react';
import { PlaylistTrack, LibraryStats, TagInfo } from '../../audioLoader';
import { LibraryView } from '../LibraryView';
import { LibraryViewMode } from './types';

export interface PlayerFallbackLibraryTabProps {
  tracks: PlaylistTrack[];
  allTags: TagInfo[];
  stats: LibraryStats;
  currentTrackId?: string;
  loadingTrackId?: string;
  isPlaying: boolean;
  isLoadingLibrary: boolean;
  libraryViewMode: LibraryViewMode;
  setLibraryViewMode: (m: LibraryViewMode) => void;
  queueLength: number;
  selectedTags: string[];
  setSelectedTags: React.Dispatch<React.SetStateAction<string[]>>;
  onTrackClick: (track: PlaylistTrack, queueIndex: number) => void;
  onTrackDoubleClick: (track: PlaylistTrack) => void;
  onPlayAll: (tracks: PlaylistTrack[], shuffled?: boolean) => void;
  onAddAllToQueue: (tracks: PlaylistTrack[]) => void;
  onPlayNow: (track: PlaylistTrack) => void;
  onPlayNext: (track: PlaylistTrack) => void;
  onAddToQueue: (track: PlaylistTrack) => void;
  onUpdateTrack: (id: string, updates: Partial<PlaylistTrack>) => Promise<void>;
  onTrashTrack: (id: string) => Promise<void>;
  onRegenerate: (track: PlaylistTrack) => void;
  hasMore: boolean;
  onLoadMore: () => void;
  onNotify: (message: string, type: 'success' | 'error' | 'info') => void;
}

export const PlayerFallbackLibraryTab: React.FC<PlayerFallbackLibraryTabProps> = ({
  tracks, allTags, stats, currentTrackId, loadingTrackId, isPlaying, isLoadingLibrary,
  libraryViewMode, setLibraryViewMode, queueLength,
  selectedTags, setSelectedTags,
  onTrackClick, onTrackDoubleClick, onPlayAll, onAddAllToQueue,
  onPlayNow, onPlayNext, onAddToQueue, onUpdateTrack, onTrashTrack, onRegenerate,
  hasMore, onLoadMore, onNotify,
}) => (
  <div className="flex-1 flex flex-col overflow-hidden">
    <div className="flex items-center justify-between px-6 py-3 border-b border-white/10">
      <div className="flex items-center gap-2">
        <button onClick={() => setLibraryViewMode('grid')} className={`p-2 rounded ${libraryViewMode === 'grid' ? 'bg-white/20' : 'hover:bg-white/10'}`}>⊞ Grid</button>
        <button onClick={() => setLibraryViewMode('list')} className={`p-2 rounded ${libraryViewMode === 'list' ? 'bg-white/20' : 'hover:bg-white/10'}`}>☰ List</button>
        <div className="w-px h-5 bg-white/20 mx-1" />
        <button onClick={() => onPlayAll(tracks)} disabled={tracks.length === 0}
          className="px-3 py-1.5 text-xs bg-purple-500/20 text-purple-300 rounded hover:bg-purple-500/30 disabled:opacity-40 transition-colors"
          title="Clear queue and play all visible tracks">⏵ Play All ({tracks.length})</button>
        <button onClick={() => onPlayAll(tracks, true)} disabled={tracks.length === 0}
          className="px-3 py-1.5 text-xs bg-purple-500/20 text-purple-300 rounded hover:bg-purple-500/30 disabled:opacity-40 transition-colors"
          title="Clear queue and shuffle all visible tracks">🔀 Shuffle All</button>
        <button onClick={() => onAddAllToQueue(tracks)} disabled={tracks.length === 0}
          className="px-3 py-1.5 text-xs bg-white/10 text-gray-300 rounded hover:bg-white/20 disabled:opacity-40 transition-colors"
          title="Add all visible tracks to queue (skip duplicates)">➕ Add All</button>
      </div>
      {selectedTags.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-400">Filtered by:</span>
          {selectedTags.map(tag => (
            <button key={tag} onClick={() => setSelectedTags(prev => prev.filter(t => t !== tag))}
              className="px-2 py-1 text-xs bg-purple-500/30 text-purple-200 rounded-full hover:bg-purple-500/50">{tag} ×</button>
          ))}
          <button onClick={() => setSelectedTags([])} className="text-xs text-gray-500 hover:text-white">Clear</button>
        </div>
      )}
    </div>
    <LibraryView
      tracks={tracks} allTags={allTags} stats={stats}
      currentTrackId={currentTrackId} loadingTrackId={loadingTrackId}
      isPlaying={isPlaying} viewMode={libraryViewMode}
      onTrackClick={(track) => onTrackClick(track, queueLength)}
      onTrackDoubleClick={onTrackDoubleClick} onUpdateTrack={onUpdateTrack} onTrashTrack={onTrashTrack}
      onPlayNow={onPlayNow} onPlayNext={onPlayNext} onAddToQueue={onAddToQueue}
      onRegenerate={onRegenerate}
      isLoading={isLoadingLibrary}
      hasMore={hasMore} onLoadMore={onLoadMore} onNotify={onNotify}
    />
  </div>
);
