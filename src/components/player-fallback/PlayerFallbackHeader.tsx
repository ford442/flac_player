import React from 'react';
import { LibraryStats } from '../../audioLoader';

export interface PlayerFallbackHeaderProps {
  isSharedPlaylist: boolean;
  sharedPlaylistTitle: string;
  stats: LibraryStats;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement>;
  isResyncingLibrary: boolean;
  onTriggerResync: () => void;
  onSetShowHtmlFallback: (v: boolean) => void;
  setShowHelp: (v: boolean) => void;
  setShowQueue: (v: boolean) => void;
  queueCount: number;
}

export const PlayerFallbackHeader: React.FC<PlayerFallbackHeaderProps> = ({
  isSharedPlaylist, sharedPlaylistTitle, stats,
  searchQuery, setSearchQuery, searchInputRef,
  isResyncingLibrary, onTriggerResync, onSetShowHtmlFallback,
  setShowHelp, setShowQueue, queueCount,
}) => (
  <header className="flex items-center justify-between px-6 py-4 border-b border-white/10 bg-[#0f0f1e]/95 backdrop-blur">
    <div className="flex items-center gap-4">
      <button onClick={() => onSetShowHtmlFallback(false)} className="px-4 py-2 bg-purple-500 text-white rounded hover:bg-purple-600 transition-colors text-sm font-bold tracking-wider">
        ← Back to GUI Player
      </button>
      <h1 className="text-xl font-bold bg-gradient-to-r from-purple-400 to-blue-400 bg-clip-text text-transparent">
        {isSharedPlaylist && sharedPlaylistTitle ? sharedPlaylistTitle : '🎵 FLAC Player'}
      </h1>
      <div className="hidden md:flex items-center gap-4 text-sm text-gray-400">
        <span>{stats.total_tracks} tracks</span>
        <span className="text-purple-400">{stats.rated_4plus} rated 4+</span>
        <span>{stats.total_duration_hours}h total</span>
      </div>
    </div>
    <div className="flex-1 max-w-md mx-4">
      <input ref={searchInputRef} type="text" value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder="Search tracks... (Ctrl+K)"
        className="w-full px-4 py-2 bg-white/10 border border-white/20 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
      />
    </div>
    <div className="flex items-center gap-2">
      {!isSharedPlaylist && (
        <>
          <button onClick={onTriggerResync} disabled={isResyncingLibrary}
            className="px-3 py-2 bg-blue-500/20 text-blue-200 rounded-lg hover:bg-blue-500/30 transition-colors text-sm font-medium disabled:opacity-60">
            {isResyncingLibrary ? '⏳ Rescanning...' : '🔄 Rescan Library'}
          </button>
          <a href="https://storage.noahcohn.com/admin" target="_blank" rel="noopener noreferrer"
            className="px-3 py-2 bg-purple-500/20 text-purple-200 rounded-lg hover:bg-purple-500/30 transition-colors text-sm font-medium">
            ⬆️ Add Music
          </a>
        </>
      )}
      <button onClick={() => setShowHelp(true)} className="px-3 py-2 bg-white/10 text-white rounded-lg hover:bg-white/20 transition-colors text-sm" title="Keyboard shortcuts (?)">⌨️ ?</button>
      <button onClick={() => setShowQueue(true)} className="relative px-4 py-2 bg-white/10 text-white rounded-lg hover:bg-white/20 transition-colors text-sm">
        📋 Queue
        {queueCount > 0 && <span className="absolute -top-1 -right-1 w-5 h-5 bg-purple-500 rounded-full text-xs flex items-center justify-center">{queueCount}</span>}
      </button>
    </div>
  </header>
);
