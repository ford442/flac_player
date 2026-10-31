import React, { useMemo, useState } from 'react';
import type { PlaylistTrack } from '../types/library';
import { GenerationPanel } from './GenerationPanel';
import { ConvertPanel } from './ConvertPanel';
import type { PlaylistsController } from '../types/playlist';
import type { AudioSettingsHook } from '../hooks/useAudioSettings';
import type { LibraryState } from '../hooks/useLibraryState';
import type { AudioOutputControls } from './EQPanel';
import { PlayerFallbackHeader } from './player-fallback/PlayerFallbackHeader';
import { PlayerFallbackSidebar } from './player-fallback/PlayerFallbackSidebar';
import { PlayerFallbackLibraryTab } from './player-fallback/PlayerFallbackLibraryTab';
import { PlayerFallbackNowPlayingTab } from './player-fallback/PlayerFallbackNowPlayingTab';
import { PlayerFallbackPlaylistsTab } from './player-fallback/PlayerFallbackPlaylistsTab';
import { PlayerFallbackSettingsTab } from './player-fallback/PlayerFallbackSettingsTab';
import { PlayerFallbackTransportBar } from './player-fallback/PlayerFallbackTransportBar';
import { PlayerQueuePanel } from './player-fallback/PlayerQueuePanel';
import { RoomBadge, ViewTab, LibraryViewMode } from './player-fallback/types';

/**
 * The library/advanced view. Transport, queue and playback state are read by the
 * children from the player store and actions context (#258), so the props are
 * view state, library data and settings only.
 */
export interface PlayerFallbackViewProps {
  /** Rendered by Player from the wired shortcut map; `false` when closed. */
  helpModal: React.ReactNode;
  setShowHelp: (v: boolean) => void;
  showQueue: boolean;
  setShowQueue: (v: boolean) => void;
  library: LibraryState;
  playlists: PlaylistsController;
  activeTab: ViewTab;
  setActiveTab: (t: ViewTab) => void;
  libraryViewMode: LibraryViewMode;
  setLibraryViewMode: (m: LibraryViewMode) => void;
  searchInputRef: React.RefObject<HTMLInputElement>;
  audio: AudioSettingsHook;
  audioOutput: AudioOutputControls;
  isSharedPlaylist: boolean;
  sharedPlaylistTitle: string;
  onSetShowHtmlFallback: (v: boolean) => void;
  onClearCache: () => void;
  onGenerationCompleted: (songId: string) => Promise<void>;
  room?: RoomBadge;
}

export const PlayerFallbackView: React.FC<PlayerFallbackViewProps> = ({
  helpModal, setShowHelp, showQueue, setShowQueue,
  library, playlists,
  activeTab, setActiveTab, libraryViewMode, setLibraryViewMode, searchInputRef,
  audio, audioOutput,
  isSharedPlaylist, sharedPlaylistTitle,
  onSetShowHtmlFallback, onClearCache, onGenerationCompleted, room,
}) => {
  const {
    library: libraryTracks, displayedLibrary, allTags, stats, isLoadingLibrary, fastMirrorCount,
    backendStatus, refresh, isResyncingLibrary, triggerLibraryResync,
    searchQuery, setSearchQuery, minRating, setMinRating, selectedTags, setSelectedTags,
    untaggedOnly, setUntaggedOnly, sortBy, setSortBy, storageSourceFilter, setStorageSourceFilter,
    hasMoreLibrary, loadMoreLibrary, updateTrack, trashTrack,
  } = library;

  const [generationModelFilter, setGenerationModelFilter] = useState('all');
  const [variationTrack, setVariationTrack] = useState<PlaylistTrack | null>(null);
  const generationModels = useMemo(
    () => Array.from(new Set(libraryTracks.map(track => track.generation_model).filter(Boolean) as string[])).sort(),
    [libraryTracks]
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
    <div className="min-h-screen bg-surface text-white flex flex-col">
      {helpModal}

      {backendStatus === 'down' && (
        <div className="bg-red-500/20 border-b border-red-500/30 px-6 py-3 text-center">
          <p className="text-red-300 text-sm">
            Music library server is temporarily unavailable.
            <button onClick={() => { void refresh(); }} className="ml-2 underline hover:text-red-200">Retry</button>
          </p>
        </div>
      )}

      <PlayerQueuePanel isOpen={showQueue} onClose={() => setShowQueue(false)} />

      <PlayerFallbackHeader
        isSharedPlaylist={isSharedPlaylist} sharedPlaylistTitle={sharedPlaylistTitle} stats={stats}
        searchQuery={searchQuery} setSearchQuery={setSearchQuery} searchInputRef={searchInputRef}
        isResyncingLibrary={isResyncingLibrary} onTriggerResync={() => { void triggerLibraryResync(); }}
        onSetShowHtmlFallback={onSetShowHtmlFallback}
        setShowHelp={setShowHelp} setShowQueue={setShowQueue}
        room={room}
      />

      <div className="flex-1 flex overflow-hidden">
        <PlayerFallbackSidebar
          activeTab={activeTab} setActiveTab={setActiveTab}
          libraryCount={libraryTracks.length} playlistCount={playlists.local.length + playlists.cloud.length}
          minRating={minRating} setMinRating={setMinRating}
          untaggedOnly={untaggedOnly} setUntaggedOnly={setUntaggedOnly}
          sortBy={sortBy} setSortBy={setSortBy}
          storageSourceFilter={storageSourceFilter} setStorageSourceFilter={setStorageSourceFilter}
          fastMirrorCount={fastMirrorCount}
          generationModelFilter={generationModelFilter} setGenerationModelFilter={setGenerationModelFilter}
          generationModels={generationModels}
          allTags={allTags} selectedTags={selectedTags} setSelectedTags={setSelectedTags}
        />

        <main className="flex-1 flex flex-col overflow-hidden">
          {activeTab === 'library' && (
            <PlayerFallbackLibraryTab
              tracks={filteredDisplayedLibrary} allTags={allTags} stats={stats}
              isLoadingLibrary={isLoadingLibrary}
              libraryViewMode={libraryViewMode} setLibraryViewMode={setLibraryViewMode}
              selectedTags={selectedTags} setSelectedTags={setSelectedTags}
              onUpdateTrack={updateTrack} onTrashTrack={trashTrack}
              onRegenerate={regenerateTrack}
              hasMore={hasMoreLibrary} onLoadMore={loadMoreLibrary}
            />
          )}

          {activeTab === 'now-playing' && <PlayerFallbackNowPlayingTab />}

          {activeTab === 'queue' && (
            <div className="flex-1 overflow-auto p-6">
              <PlayerQueuePanel isOpen={true} onClose={() => {}} />
            </div>
          )}

          {activeTab === 'playlists' && (
            <PlayerFallbackPlaylistsTab playlists={playlists} />
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
              eqGains={audio.eqGains} setEQBandGain={audio.setEQBandGain} resetEQ={audio.resetEQ}
              playbackRate={audio.playbackRate} setPlaybackRate={audio.setPlaybackRate}
              gaplessMode={audio.gaplessMode} setGaplessMode={audio.setGaplessMode}
              crossfadeMs={audio.crossfadeMs} setCrossfadeMs={audio.setCrossfadeMs}
              replayGainMode={audio.replayGainMode} setReplayGainMode={audio.setReplayGainMode}
              replayGainLimiter={audio.replayGainLimiter} setReplayGainLimiter={audio.setReplayGainLimiter}
              latencyMode={audio.latencyMode} setLatencyMode={audio.setLatencyMode}
              audioOutput={audioOutput}
              onClearCache={onClearCache}
            />
          )}
        </main>
      </div>

      <PlayerFallbackTransportBar />
    </div>
  );
};
