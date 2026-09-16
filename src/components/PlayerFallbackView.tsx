import React, { useMemo, useState } from 'react';
import { PlaylistTrack, SortBy, RepeatMode, LibraryStats, TagInfo, CloudPlaylist, type PlaybackPathInfo } from '../audioLoader';
import { AudioOutputMode } from '../hooks/usePlayerState';
import { QueuePanel } from './QueuePanel';
import { ToastContainer, Toast } from './Toast';
import { KeyboardHelpModal } from './KeyboardHelpModal';
import { GenerationPanel } from './GenerationPanel';
import { ConvertPanel } from './ConvertPanel';
import type { GaplessMode } from '../types/gapless';
import type { ReplayGainMode } from '../utils/replayGain';
import type { LatencyMode } from '../audio/sampleRatePolicy';
import type { AudioOutputControls } from './EQPanel';
import type { GpuChoreBackend } from '../gpu-chores';
import { PlayerFallbackHeader } from './player-fallback/PlayerFallbackHeader';
import { PlayerFallbackSidebar } from './player-fallback/PlayerFallbackSidebar';
import { PlayerFallbackLibraryTab } from './player-fallback/PlayerFallbackLibraryTab';
import { PlayerFallbackNowPlayingTab } from './player-fallback/PlayerFallbackNowPlayingTab';
import { PlayerFallbackPlaylistsTab } from './player-fallback/PlayerFallbackPlaylistsTab';
import { PlayerFallbackSettingsTab } from './player-fallback/PlayerFallbackSettingsTab';
import { PlayerFallbackTransportBar } from './player-fallback/PlayerFallbackTransportBar';
import { QueuePanelSharedProps, ViewTab, LibraryViewMode } from './player-fallback/types';

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
  gaplessMode: GaplessMode;
  setGaplessMode: (mode: GaplessMode) => void;
  crossfadeMs: number;
  setCrossfadeMs: (ms: number) => void;
  replayGainMode: ReplayGainMode;
  setReplayGainMode: (mode: ReplayGainMode) => void;
  replayGainLimiter: boolean;
  setReplayGainLimiter: (enabled: boolean) => void;
  latencyMode: LatencyMode;
  setLatencyMode: (mode: LatencyMode) => void;
  audioOutput: AudioOutputControls;
  prebufferingNext: boolean;
  playbackPath: PlaybackPathInfo | null;
  isSharedPlaylist: boolean;
  sharedPlaylistTitle: string;
  analyser: AnalyserNode | null;
  overviewMinmax?: Float32Array | null;
  overviewRms?: number | null;
  overviewPeak?: number | null;
  overviewBackend?: GpuChoreBackend | null;
  overviewReason?: string | null;
  onTrackClick: (track: PlaylistTrack, queueIndex: number) => void;
  onTrackDoubleClick: (track: PlaylistTrack) => void;
  onQueueTrackClick: (index: number) => void;
  onPlay: () => void;
  onStop: () => void;
  onSeek?: (t: number) => void;
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
  onDownloadQueue: () => void;
  hasMoreLibrary: boolean;
  onLoadMoreLibrary: () => void;
  onNotify: (message: string, type: 'success' | 'error' | 'info') => void;
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
    eqGains, setEQBandGain, resetEQ, playbackRate, setPlaybackRate,
    gaplessMode, setGaplessMode, crossfadeMs, setCrossfadeMs,
    replayGainMode, setReplayGainMode, replayGainLimiter, setReplayGainLimiter,
    latencyMode, setLatencyMode, audioOutput,
    prebufferingNext,
    playbackPath,
    isSharedPlaylist, sharedPlaylistTitle, analyser,
    overviewMinmax, overviewRms, overviewPeak, overviewBackend, overviewReason,
    onTrackClick, onTrackDoubleClick, onQueueTrackClick,
    onPlay, onStop, onSeek, onVolumeChange, onMute, onNext, onPrevious, onFileSelect,
    onPlayAll, onAddAllToQueue, onPlayNow, onPlayNext, onAddToQueue,
    onRemoveFromQueue, onClearQueue, onReorderQueue, onSmartMix, onShareQueue, onDownloadQueue,
    hasMoreLibrary, onLoadMoreLibrary, onNotify,
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

  const transportState = { isPlaying, isLoading, currentTime, duration, volume, muted };
  const transportControls = { onPlay, onStop, onSeek, onVolumeChange, onMute, onNext, onPrevious };
  const overview = { minmax: overviewMinmax, rms: overviewRms, peak: overviewPeak, backend: overviewBackend, reason: overviewReason };
  const playbackMode = { shuffle, setShuffle, repeatMode, setRepeatMode };
  const queuePanelProps: QueuePanelSharedProps = {
    queue, currentIndex: queueCurrentIndex, prebufferingNext,
    onTrackClick: onQueueTrackClick, onRemoveTrack: onRemoveFromQueue, onClearQueue,
    onShuffle: () => setShuffle(s => !s), onSmartMix, onShareQueue, onDownloadQueue, onReorderQueue,
    shuffle, repeatMode,
    onToggleRepeat: () => setRepeatMode(m => m === 'off' ? 'all' : m === 'all' ? 'one' : 'off'),
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

      <QueuePanel {...queuePanelProps} isOpen={showQueue} onClose={() => setShowQueue(false)} />

      <PlayerFallbackHeader
        isSharedPlaylist={isSharedPlaylist} sharedPlaylistTitle={sharedPlaylistTitle} stats={stats}
        searchQuery={searchQuery} setSearchQuery={setSearchQuery} searchInputRef={searchInputRef}
        isResyncingLibrary={isResyncingLibrary} onTriggerResync={onTriggerResync}
        onSetShowHtmlFallback={onSetShowHtmlFallback}
        setShowHelp={setShowHelp} setShowQueue={setShowQueue} queueCount={queue.length}
      />

      <div className="flex-1 flex overflow-hidden">
        <PlayerFallbackSidebar
          activeTab={activeTab} setActiveTab={setActiveTab}
          libraryCount={library.length} queueCount={queue.length} playlistCount={playlists.length}
          minRating={minRating} setMinRating={setMinRating}
          untaggedOnly={untaggedOnly} setUntaggedOnly={setUntaggedOnly}
          sortBy={sortBy} setSortBy={setSortBy}
          storageSourceFilter={storageSourceFilter} setStorageSourceFilter={setStorageSourceFilter}
          fastMirrorCount={fastMirrorCount}
          generationModelFilter={generationModelFilter} setGenerationModelFilter={setGenerationModelFilter}
          generationModels={generationModels}
          allTags={allTags} selectedTags={selectedTags} setSelectedTags={setSelectedTags}
          onFileSelect={onFileSelect}
        />

        <main className="flex-1 flex flex-col overflow-hidden">
          {activeTab === 'library' && (
            <PlayerFallbackLibraryTab
              tracks={filteredDisplayedLibrary} allTags={allTags} stats={stats}
              currentTrackId={currentTrack?.id} loadingTrackId={loadingTrackId}
              isPlaying={isPlaying} isLoadingLibrary={isLoadingLibrary}
              libraryViewMode={libraryViewMode} setLibraryViewMode={setLibraryViewMode}
              queueLength={queue.length}
              selectedTags={selectedTags} setSelectedTags={setSelectedTags}
              onTrackClick={onTrackClick} onTrackDoubleClick={onTrackDoubleClick}
              onPlayAll={onPlayAll} onAddAllToQueue={onAddAllToQueue}
              onPlayNow={onPlayNow} onPlayNext={onPlayNext} onAddToQueue={onAddToQueue}
              onUpdateTrack={onUpdateTrack} onTrashTrack={onTrashTrack}
              onRegenerate={regenerateTrack}
              hasMore={hasMoreLibrary} onLoadMore={onLoadMoreLibrary} onNotify={onNotify}
            />
          )}

          {activeTab === 'now-playing' && (
            <PlayerFallbackNowPlayingTab
              analyser={analyser} currentTrack={currentTrack} queue={queue} queueCurrentIndex={queueCurrentIndex}
              transportState={transportState} transportControls={transportControls} overview={overview}
              onQueueTrackClick={onQueueTrackClick} onFileSelect={onFileSelect}
            />
          )}

          {activeTab === 'queue' && (
            <div className="flex-1 overflow-auto p-6">
              <QueuePanel {...queuePanelProps} loadingTrackId={loadingTrackId} isOpen={true} onClose={() => {}} />
            </div>
          )}

          {activeTab === 'playlists' && (
            <PlayerFallbackPlaylistsTab
              playlists={playlists} isLoadingPlaylists={isLoadingPlaylists}
              onLoadPlaylists={onLoadPlaylists} onLoadCloudPlaylist={onLoadCloudPlaylist}
            />
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

          {activeTab === 'convert' && (
            <div className="flex-1 overflow-auto p-6">
              <ConvertPanel />
            </div>
          )}

          {activeTab === 'settings' && (
            <PlayerFallbackSettingsTab
              eqGains={eqGains} setEQBandGain={setEQBandGain} resetEQ={resetEQ}
              playbackRate={playbackRate} setPlaybackRate={setPlaybackRate}
              gaplessMode={gaplessMode} setGaplessMode={setGaplessMode}
              crossfadeMs={crossfadeMs} setCrossfadeMs={setCrossfadeMs}
              replayGainMode={replayGainMode} setReplayGainMode={setReplayGainMode}
              replayGainLimiter={replayGainLimiter} setReplayGainLimiter={setReplayGainLimiter}
              latencyMode={latencyMode} setLatencyMode={setLatencyMode}
              audioOutput={audioOutput}
              outputMode={outputMode} setOutputMode={setOutputMode}
              playbackPath={playbackPath} onClearCache={onClearCache}
            />
          )}
        </main>
      </div>

      <PlayerFallbackTransportBar
        currentTrack={currentTrack} currentFile={currentFile} analyser={analyser}
        transportState={transportState} transportControls={transportControls} overview={overview}
        playbackMode={playbackMode} queueLength={queue.length} queueCurrentIndex={queueCurrentIndex}
        outputMode={outputMode} setOutputMode={setOutputMode}
      />
    </div>
  );
};
