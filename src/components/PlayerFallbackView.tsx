import React, { useMemo, useState } from 'react';
import { PlaylistTrack, SortBy, RepeatMode, LibraryStats, TagInfo, CloudPlaylist, type PlaybackPathInfo } from '../audioLoader';
import { AudioOutputMode } from '../hooks/usePlayerState';
import { LibraryView } from './LibraryView';
import { QueuePanel } from './QueuePanel';
import { ShaderGUI } from './ShaderGUI/ShaderGUI';
import { MetadataPanel } from './MetadataPanel';
import { FileDropZone } from './FileDropZone';
import { ToastContainer, Toast } from './Toast';
import { KeyboardHelpModal } from './KeyboardHelpModal';
import { EQPanel } from './EQPanel';
import { CacheStatsPanel } from './OfflineCache';
import { GenerationPanel } from './GenerationPanel';
import { formatTime, FAST_STORAGE_HOST } from '../utils/audioUtils';
import { getNextQueueIndex, getPreviousQueueIndex } from '../utils/queueUtils';

type ViewTab = 'library' | 'now-playing' | 'queue' | 'playlists' | 'generate' | 'settings';
type LibraryViewMode = 'grid' | 'list';

export interface PlayerFallbackViewProps {
  toasts: Toast[];
  removeToast: (id: string) => void;
  showHelp: boolean;
  setShowHelp: (v: boolean) => void;
  backendStatus: 'checking' | 'up' | 'down';
  onRetry: () => void;
  queue: PlaylistTrack[];
  queueCurrentIndex: number;
  showQueue: boolean;
  setShowQueue: (v: boolean) => void;
  shuffle: boolean;
  setShuffle: React.Dispatch<React.SetStateAction<boolean>>;
  repeatMode: RepeatMode;
  setRepeatMode: React.Dispatch<React.SetStateAction<RepeatMode>>;
  isResyncingLibrary: boolean;
  onTriggerResync: () => void;
  currentTrack: PlaylistTrack | null;
  currentFile: File | undefined;
  loadingTrackId: string | undefined;
  isPlaying: boolean;
  isLoading: boolean;
  currentTime: number;
  duration: number;
  library: PlaylistTrack[];
  displayedLibrary: PlaylistTrack[];
  allTags: TagInfo[];
  stats: LibraryStats;
  isLoadingLibrary: boolean;
  fastMirrorCount: number;
  playlists: CloudPlaylist[];
  isLoadingPlaylists: boolean;
  onLoadPlaylists: () => void;
  activeTab: ViewTab;
  setActiveTab: (t: ViewTab) => void;
  libraryViewMode: LibraryViewMode;
  setLibraryViewMode: (m: LibraryViewMode) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement>;
  minRating: number;
  setMinRating: (r: number) => void;
  selectedTags: string[];
  setSelectedTags: React.Dispatch<React.SetStateAction<string[]>>;
  untaggedOnly: boolean;
  setUntaggedOnly: (v: boolean) => void;
  sortBy: SortBy;
  setSortBy: (s: SortBy) => void;
  storageSourceFilter: 'all' | 'fast';
  setStorageSourceFilter: (f: 'all' | 'fast') => void;
  volume: number;
  muted: boolean;
  outputMode: AudioOutputMode;
  setOutputMode: (m: AudioOutputMode) => void;
  eqGains: number[];
  setEQBandGain: (i: number, g: number) => void;
  resetEQ: () => void;
  playbackRate: number;
  setPlaybackRate: (r: number) => void;
  crossfadeEnabled: boolean;
  setCrossfadeEnabled: (e: boolean) => void;
  playbackPath: PlaybackPathInfo | null;
  isSharedPlaylist: boolean;
  sharedPlaylistTitle: string;
  analyser: AnalyserNode | null;
  onTrackClick: (track: PlaylistTrack, queueIndex: number) => void;
  onTrackDoubleClick: (track: PlaylistTrack) => void;
  onQueueTrackClick: (index: number) => void;
  onPlay: () => void;
  onStop: () => void;
  onSeek: (t: number) => void;
  onVolumeChange: (v: number) => void;
  onMute: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onFileSelect: (files: File[]) => void;
  onPlayAll: (tracks: PlaylistTrack[], shuffled?: boolean) => void;
  onAddAllToQueue: (tracks: PlaylistTrack[]) => void;
  onPlayNow: (track: PlaylistTrack) => void;
  onPlayNext: (track: PlaylistTrack) => void;
  onAddToQueue: (track: PlaylistTrack) => void;
  onRemoveFromQueue: (index: number) => void;
  onClearQueue: () => void;
  onReorderQueue: (start: number, end: number) => void;
  onSmartMix: () => void;
  onShareQueue: () => void;
  onUpdateTrack: (id: string, updates: Partial<PlaylistTrack>) => Promise<void>;
  onTrashTrack: (id: string) => Promise<void>;
  onLoadCloudPlaylist: (id: string) => void;
  onSetShowHtmlFallback: (v: boolean) => void;
  onClearCache: () => void;
  onGenerationCompleted: (songId: string) => Promise<void>;
}

export const PlayerFallbackView: React.FC<PlayerFallbackViewProps> = (props) => {
  const {
    toasts, removeToast, showHelp, setShowHelp, backendStatus, onRetry,
    queue, queueCurrentIndex, showQueue, setShowQueue, shuffle, setShuffle, repeatMode, setRepeatMode,
    isResyncingLibrary, onTriggerResync, currentTrack, currentFile, loadingTrackId,
    isPlaying, isLoading, currentTime, duration,
    library, displayedLibrary, allTags, stats, isLoadingLibrary, fastMirrorCount,
    playlists, isLoadingPlaylists, onLoadPlaylists,
    activeTab, setActiveTab, libraryViewMode, setLibraryViewMode,
    searchQuery, setSearchQuery, searchInputRef,
    minRating, setMinRating, selectedTags, setSelectedTags, untaggedOnly, setUntaggedOnly,
    sortBy, setSortBy, storageSourceFilter, setStorageSourceFilter,
    volume, muted, outputMode, setOutputMode,
    eqGains, setEQBandGain, resetEQ, playbackRate, setPlaybackRate, crossfadeEnabled, setCrossfadeEnabled,
    playbackPath,
    isSharedPlaylist, sharedPlaylistTitle, analyser,
    onTrackClick, onTrackDoubleClick, onQueueTrackClick,
    onPlay, onStop, onSeek, onVolumeChange, onMute, onNext, onPrevious, onFileSelect,
    onPlayAll, onAddAllToQueue, onPlayNow, onPlayNext, onAddToQueue,
    onRemoveFromQueue, onClearQueue, onReorderQueue, onSmartMix, onShareQueue,
    onUpdateTrack, onTrashTrack, onLoadCloudPlaylist, onSetShowHtmlFallback, onClearCache,
    onGenerationCompleted,
  } = props;

  const [generationModelFilter, setGenerationModelFilter] = useState('all');
  const [variationTrack, setVariationTrack] = useState<PlaylistTrack | null>(null);
  const generationModels = useMemo(
    () => Array.from(new Set(library.map(track => track.generation_model).filter(Boolean) as string[])).sort(),
    [library]
  );
  const filteredDisplayedLibrary = useMemo(
    () => generationModelFilter === 'all'
      ? displayedLibrary
      : displayedLibrary.filter(track => track.generation_model === generationModelFilter),
    [displayedLibrary, generationModelFilter]
  );

  const regenerateTrack = (track: PlaylistTrack) => {
    setVariationTrack(track);
    setActiveTab('generate');
  };

  return (
    <div className="player min-h-screen bg-[#0f0f1e] text-white flex flex-col">
      <ToastContainer toasts={toasts} onRemove={removeToast} />
      {showHelp && <KeyboardHelpModal onClose={() => setShowHelp(false)} />}

      {backendStatus === 'down' && (
        <div className="bg-red-500/20 border-b border-red-500/30 px-6 py-3 text-center">
          <p className="text-red-300 text-sm">
            Music library server is temporarily unavailable.
            <button onClick={onRetry} className="ml-2 underline hover:text-red-200">Retry</button>
          </p>
        </div>
      )}

      <QueuePanel
        queue={queue} currentIndex={queueCurrentIndex} isOpen={showQueue}
        onClose={() => setShowQueue(false)}
        onTrackClick={onQueueTrackClick}
        onRemoveTrack={onRemoveFromQueue} onClearQueue={onClearQueue}
        onShuffle={() => setShuffle(s => !s)} onSmartMix={onSmartMix}
        onShareQueue={onShareQueue} onReorderQueue={onReorderQueue}
        shuffle={shuffle} repeatMode={repeatMode}
        onToggleRepeat={() => setRepeatMode(m => m === 'off' ? 'all' : m === 'all' ? 'one' : 'off')}
      />

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
            {queue.length > 0 && <span className="absolute -top-1 -right-1 w-5 h-5 bg-purple-500 rounded-full text-xs flex items-center justify-center">{queue.length}</span>}
          </button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        <aside className="w-64 border-r border-white/10 bg-[#0a0a18] flex flex-col">
          <nav className="p-4 space-y-1">
            {[
              { id: 'library',     label: '📚 Library',    count: library.length },
              { id: 'now-playing', label: '▶️ Now Playing' },
              { id: 'queue',       label: '📋 Queue',      count: queue.length },
              { id: 'playlists',   label: '☁️ Playlists',  count: playlists.length },
              { id: 'generate',    label: '✨ Generate' },
              { id: 'settings',    label: '⚙️ Settings' },
            ].map(tab => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id as ViewTab)}
                className={`w-full flex items-center justify-between px-4 py-2 rounded-lg text-left transition-colors ${
                  activeTab === tab.id ? 'bg-purple-500/20 text-purple-300' : 'text-gray-400 hover:bg-white/5 hover:text-white'
                }`}>
                <span>{tab.label}</span>
                {tab.count !== undefined && <span className="text-xs bg-white/10 px-2 py-0.5 rounded-full">{tab.count}</span>}
              </button>
            ))}
          </nav>

          <div className="p-4 border-t border-white/10 space-y-4">
            <div>
              <label className="text-xs text-gray-500 uppercase">Min Rating</label>
              <input type="range" min="0" max="5" step="1" value={minRating}
                onChange={(e) => setMinRating(parseInt(e.target.value))} className="w-full mt-1" />
              <div className="flex justify-between text-xs text-gray-400 mt-1"><span>Any</span><span>{minRating}+ stars</span></div>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
              <input type="checkbox" checked={untaggedOnly} onChange={(e) => setUntaggedOnly(e.target.checked)} className="rounded border-white/20 bg-white/10" />
              Untagged only
            </label>
            <div>
              <label className="text-xs text-gray-500 uppercase">Sort By</label>
              <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)}
                className="w-full mt-1 px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-sm">
                <option value="date">Date Added</option>
                <option value="rating">Rating</option>
                <option value="name">Name</option>
                <option value="play_count">Play Count</option>
                <option value="last_played">Last Played</option>
                <option value="random">Random</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-500 uppercase">Storage Source</label>
              <select value={storageSourceFilter} onChange={(e) => setStorageSourceFilter(e.target.value as 'all' | 'fast')}
                className="w-full mt-1 px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-sm">
                <option value="all">All tracks</option>
                <option value="fast">Fast mirror only</option>
              </select>
              <p className="text-xs text-gray-500 mt-2">{fastMirrorCount}/{library.length} tracks available on fast mirror ({FAST_STORAGE_HOST})</p>
            </div>
            <div>
              <label className="text-xs text-gray-500 uppercase">Generation Model</label>
              <select value={generationModelFilter} onChange={(event) => setGenerationModelFilter(event.target.value)}
                className="w-full mt-1 px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-sm" aria-label="Generation model filter">
                <option value="all">All models</option>
                {generationModels.map(model => <option key={model} value={model}>{model}</option>)}
              </select>
            </div>
          </div>

          <div className="flex-1 p-4 border-t border-white/10 overflow-auto">
            <label className="text-xs text-gray-500 uppercase">Filter Tags</label>
            <div className="flex flex-wrap gap-1 mt-2">
              {allTags.slice(0, 15).map(tag => (
                <button key={tag.name}
                  onClick={() => setSelectedTags(prev => prev.includes(tag.name) ? prev.filter(t => t !== tag.name) : [...prev, tag.name])}
                  className={`px-2 py-1 text-xs rounded-full transition-colors ${
                    selectedTags.includes(tag.name) ? 'bg-purple-500 text-white' : 'bg-white/10 text-gray-400 hover:bg-white/20'
                  }`}>{tag.name} ({tag.count})</button>
              ))}
            </div>
          </div>

          <div className="p-4 border-t border-white/10">
            <label className="text-xs text-gray-500 uppercase block mb-2">Local Files</label>
            <FileDropZone onFiles={onFileSelect} />
          </div>
        </aside>

        <main className="flex-1 flex flex-col overflow-hidden">
          {activeTab === 'library' && (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="flex items-center justify-between px-6 py-3 border-b border-white/10">
                <div className="flex items-center gap-2">
                  <button onClick={() => setLibraryViewMode('grid')} className={`p-2 rounded ${libraryViewMode === 'grid' ? 'bg-white/20' : 'hover:bg-white/10'}`}>⊞ Grid</button>
                  <button onClick={() => setLibraryViewMode('list')} className={`p-2 rounded ${libraryViewMode === 'list' ? 'bg-white/20' : 'hover:bg-white/10'}`}>☰ List</button>
                  <div className="w-px h-5 bg-white/20 mx-1" />
                  <button onClick={() => onPlayAll(filteredDisplayedLibrary)} disabled={filteredDisplayedLibrary.length === 0}
                    className="px-3 py-1.5 text-xs bg-purple-500/20 text-purple-300 rounded hover:bg-purple-500/30 disabled:opacity-40 transition-colors"
                    title="Clear queue and play all visible tracks">⏵ Play All ({filteredDisplayedLibrary.length})</button>
                  <button onClick={() => onPlayAll(filteredDisplayedLibrary, true)} disabled={filteredDisplayedLibrary.length === 0}
                    className="px-3 py-1.5 text-xs bg-purple-500/20 text-purple-300 rounded hover:bg-purple-500/30 disabled:opacity-40 transition-colors"
                    title="Clear queue and shuffle all visible tracks">🔀 Shuffle All</button>
                  <button onClick={() => onAddAllToQueue(filteredDisplayedLibrary)} disabled={filteredDisplayedLibrary.length === 0}
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
                tracks={filteredDisplayedLibrary} allTags={allTags} stats={stats}
                currentTrackId={currentTrack?.id} loadingTrackId={loadingTrackId}
                isPlaying={isPlaying} viewMode={libraryViewMode}
                onTrackClick={(track) => onTrackClick(track, queue.length)}
                onTrackDoubleClick={onTrackDoubleClick} onUpdateTrack={onUpdateTrack} onTrashTrack={onTrashTrack}
                onPlayNow={onPlayNow} onPlayNext={onPlayNext} onAddToQueue={onAddToQueue}
                onRegenerate={regenerateTrack}
                isLoading={isLoadingLibrary}
              />
            </div>
          )}

          {activeTab === 'now-playing' && (
            <div className="flex-1 flex items-center justify-center p-6 overflow-auto">
              <ShaderGUI
                analyser={analyser} currentTrack={currentTrack} queue={queue} queueCurrentIndex={queueCurrentIndex}
                isPlaying={isPlaying} isLoading={isLoading} currentTime={currentTime} duration={duration} volume={volume}
                muted={muted} onPlay={onPlay} onStop={onStop} onSeek={onSeek}
                onTrackClick={(index) => onQueueTrackClick(index)}
                onVolumeChange={onVolumeChange} onMute={onMute} onNext={onNext} onPrevious={onPrevious}
                onFileSelect={onFileSelect}
              />
            </div>
          )}

          {activeTab === 'queue' && (
            <div className="flex-1 overflow-auto p-6">
              <QueuePanel
                queue={queue} currentIndex={queueCurrentIndex} loadingTrackId={loadingTrackId}
                isOpen={true} onClose={() => {}}
                onTrackClick={onQueueTrackClick}
                onRemoveTrack={onRemoveFromQueue} onClearQueue={onClearQueue}
                onShuffle={() => setShuffle(s => !s)} onSmartMix={onSmartMix}
                onShareQueue={onShareQueue} onReorderQueue={onReorderQueue}
                shuffle={shuffle} repeatMode={repeatMode}
                onToggleRepeat={() => setRepeatMode(m => m === 'off' ? 'all' : m === 'all' ? 'one' : 'off')}
              />
            </div>
          )}

          {activeTab === 'playlists' && (
            <div className="flex-1 overflow-auto p-6">
              <div className="max-w-2xl mx-auto">
                <div className="flex items-center justify-between mb-6">
                  <h2 className="text-xl font-semibold">Cloud Playlists</h2>
                  <button onClick={onLoadPlaylists} disabled={isLoadingPlaylists}
                    className="px-4 py-2 bg-purple-500/20 text-purple-300 rounded-lg hover:bg-purple-500/30 disabled:opacity-50">
                    {isLoadingPlaylists ? 'Loading...' : '🔄 Refresh'}
                  </button>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
                  <a href="https://storage.noahcohn.com/admin" target="_blank" rel="noopener noreferrer"
                    className="p-4 bg-purple-500/10 border border-purple-500/30 rounded-lg hover:bg-purple-500/20 transition-colors">
                    <div className="font-medium text-purple-200">Open Storage Admin</div>
                    <div className="text-sm text-gray-400 mt-1">Upload and organize tracks in a new tab.</div>
                  </a>
                  <a href="https://github.com/ford442/contabo_storage_manager" target="_blank" rel="noopener noreferrer"
                    className="p-4 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10 transition-colors">
                    <div className="font-medium text-white">contabo_storage_manager</div>
                    <div className="text-sm text-gray-400 mt-1">Backend management workflows used by this playlist sync.</div>
                  </a>
                </div>
                {playlists.length === 0 && !isLoadingPlaylists && (
                  <div className="text-gray-400 text-center py-12">
                    <p>No playlists found.</p>
                    <p className="text-sm mt-2">Create playlists in cloud_notes to see them here.</p>
                  </div>
                )}
                <div className="space-y-2">
                  {playlists.map(playlist => (
                    <div key={playlist.id} onClick={() => onLoadCloudPlaylist(playlist.id)}
                      className="p-4 bg-white/5 rounded-lg hover:bg-white/10 cursor-pointer transition-colors">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="font-medium text-white">{playlist.title}</div>
                          {playlist.description && <div className="text-sm text-gray-400 mt-1">{playlist.description}</div>}
                        </div>
                        <div className="text-sm text-gray-400">{playlist.track_ids?.length || 0} tracks</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'generate' && (
            <div className="flex-1 overflow-auto p-6">
              <GenerationPanel
                variationTrack={variationTrack}
                onVariationConsumed={() => setVariationTrack(null)}
                onCompleted={onGenerationCompleted}
              />
            </div>
          )}

          {activeTab === 'settings' && (
            <div className="flex-1 overflow-auto p-6">
              <div className="max-w-lg mx-auto space-y-8">
                <h2 className="text-xl font-semibold">Audio Settings</h2>
                <div className="bg-white/5 rounded-xl p-5 border border-white/10">
                  <EQPanel eqGains={eqGains} onBandChange={setEQBandGain} onReset={resetEQ}
                    playbackRate={playbackRate} onPlaybackRateChange={setPlaybackRate}
                    crossfadeEnabled={crossfadeEnabled} onCrossfadeChange={setCrossfadeEnabled} />
                </div>
                <div className="bg-white/5 rounded-xl p-5 border border-white/10 space-y-3">
                  <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">Audio Engine</span>
                  <select value={outputMode} onChange={(e) => setOutputMode(e.target.value as AudioOutputMode)}
                    className="w-full px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-sm text-white">
                    <option value="streaming">Streaming (recommended)</option>
                    <option value="worklet">AudioWorklet (buffered)</option>
                    <option value="web-audio">Web Audio (buffered)</option>
                  </select>
                  {playbackPath && (
                    <div className="text-xs text-cyan-300/90 bg-cyan-950/30 border border-cyan-500/20 rounded-lg px-3 py-2" role="status">
                      <span className="font-semibold">{playbackPath.label}</span>
                      <span className="text-gray-400"> — {playbackPath.detail}</span>
                    </div>
                  )}
                  <p className="text-xs text-gray-500">
                    FLAC files ≥32 MB auto-stream via WASM decoder (bounded memory).
                    Smaller FLAC uses buffered decode. Non-FLAC URLs use native browser streaming.
                    Crossfade works in native streaming only.
                  </p>
                </div>
                <div className="bg-white/5 rounded-xl p-5 border border-white/10 space-y-3">
                  <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">Offline Cache</span>
                  <p className="text-xs text-gray-500">
                    Recently played tracks are cached automatically (up to 500 MB, LRU eviction).
                    You can also download individual tracks from the library for offline use.
                  </p>
                  <CacheStatsPanel onClearAll={onClearCache} />
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      <footer className="border-t border-white/10 bg-[#0a0a18] px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="w-1/3 flex items-center gap-3">
            {currentTrack && (
              <MetadataPanel
                file={currentFile}
                audioUrl={currentTrack.url}
                trackInfo={{
                  title: currentTrack.title || currentTrack.name,
                  artist: currentTrack.artist || currentTrack.author,
                  duration: currentTrack.duration || duration,
                  coverUrl: currentTrack.cover_url,
                  cacheKey: currentTrack.id || currentTrack.url,
                  generationModel: currentTrack.generation_model,
                  version: currentTrack.version,
                  prompt: currentTrack.prompt,
                }}
              />
            )}
          </div>

          <div className="w-1/3 flex flex-col items-center">
            <div className="flex items-center gap-4 mb-2">
              <button onClick={onPrevious}
                className="text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                disabled={getPreviousQueueIndex(queue.length, queueCurrentIndex, repeatMode) === -1 || isLoading}
                aria-label="Previous track">⏮</button>
              <button onClick={onPlay} disabled={isLoading}
                className="w-12 h-12 bg-white text-black rounded-full flex items-center justify-center text-xl hover:scale-105 transition-transform disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label={isPlaying ? 'Pause' : 'Play'}>
                {isLoading ? <div className="spinner" style={{ borderTopColor: '#000' }} /> : isPlaying ? '⏸' : '▶'}
              </button>
              <button onClick={onNext}
                className="text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                disabled={getNextQueueIndex(queue.length, queueCurrentIndex, shuffle, repeatMode) === -1 && !isLoading}
                aria-label="Next track">⏭</button>
            </div>
            <div className="w-full max-w-md flex items-center gap-3">
              <span className="text-xs text-gray-400 w-10 text-right" aria-label="Elapsed time">{formatTime(currentTime)}</span>
              <input type="range" min={0} max={duration || 0} value={currentTime}
                onChange={(e) => onSeek(parseFloat(e.target.value))}
                className="flex-1 h-1 bg-white/20 rounded-lg appearance-none cursor-pointer"
                aria-label="Seek position" />
              <span className="text-xs text-gray-400 w-10" aria-label="Remaining time">-{formatTime(Math.max(0, duration - currentTime))}</span>
            </div>
          </div>

          <div className="w-1/3 flex items-center justify-end gap-4">
            <button onClick={() => setShuffle(s => !s)} className={`text-sm ${shuffle ? 'text-purple-400' : 'text-gray-400'}`} title="Shuffle" aria-label="Toggle shuffle" aria-pressed={shuffle}>🔀</button>
            <button onClick={() => setRepeatMode(m => m === 'off' ? 'all' : m === 'all' ? 'one' : 'off')}
              className={`text-sm ${repeatMode !== 'off' ? 'text-purple-400' : 'text-gray-400'}`} title={`Repeat: ${repeatMode}`}
              aria-label={`Repeat mode: ${repeatMode}`} aria-pressed={repeatMode !== 'off'}>
              {repeatMode === 'one' ? '🔂' : '🔁'}
            </button>
            <button onClick={onMute}
              className={`text-sm ${muted ? 'text-yellow-400' : 'text-gray-400'} hover:text-white transition-colors`}
              title={muted ? 'Unmute (M)' : 'Mute (M)'} aria-label={muted ? 'Unmute' : 'Mute'} aria-pressed={muted}>
              {muted ? '🔇' : '🔊'}
            </button>
            <select value={outputMode} onChange={(e) => setOutputMode(e.target.value as AudioOutputMode)}
              className="px-3 py-1 bg-white/10 rounded text-sm" aria-label="Audio output mode">
              <option value="streaming">Streaming (default)</option>
              <option value="web-audio">Web Audio (buffered)</option>
              <option value="worklet">AudioWorklet</option>
              <option value="sdl">SDL3</option>
              <option value="sdl2">SDL2</option>
            </select>
            <span className="text-xs text-gray-400 w-12 text-right">{muted ? '🔇 0%' : `${Math.round(volume * 100)}%`}</span>
          </div>
        </div>
      </footer>
    </div>
  );
};
