import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  AudioLoader,
  PlaylistTrack,
  loadQueueFromStorage,
} from '../audioLoader';

import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { usePlayerState } from '../hooks/usePlayerState';
import { useToastNotifications } from '../hooks/useToastNotifications';
import { useAudioSettings } from '../hooks/useAudioSettings';
import { usePlayerData } from '../hooks/usePlayerData';
import { useAudioBackendLifecycle } from '../hooks/useAudioBackendLifecycle';
import { useTrackLoader } from '../hooks/useTrackLoader';
import { useQueuePlayback } from '../hooks/useQueuePlayback';
import { VisualizerShell } from './VisualizerShell';
import { ToastContainer } from './Toast';
import { KeyboardHelpModal } from './KeyboardHelpModal';
import { PlayerFallbackView } from './PlayerFallbackView';
import { EmbedPlayerView } from './EmbedPlayerView';
import { shuffleArray, isFastStorageUrl } from '../utils/audioUtils';
import { IS_PROJECTM_EMBED } from '../utils/embedMode';
import {
  getInitialVisualizerAesthetic,
  VisualizerAesthetic,
} from '../utils/visualizerMode';
import { clearTrackCache } from '../storage/trackCache';
import './Player.css';

const getSharedPlaylistId = (): string | null => {
  const params = new URLSearchParams(window.location.search);
  const queryShareId = params.get('share');
  if (queryShareId) return queryShareId;
  const pathMatch = window.location.pathname.match(/^\/playlist\/([^/]+)$/);
  return pathMatch ? decodeURIComponent(pathMatch[1]) : null;
};

export const Player: React.FC = () => {
  const sharedPlaylistId = useMemo(() => getSharedPlaylistId(), []);
  const isSharedPlaylist = sharedPlaylistId !== null;

  const { playerState, setPlayerState, outputMode, setOutputMode, setError, currentTrack, setCurrentTrack, loadingTrackId, setLoadingTrackId, backendStatus, setBackendStatus } = usePlayerState();
  const { toasts, addToast, removeToast } = useToastNotifications();
  const { eqGains, setEQBandGain, resetEQ, playbackRate, setPlaybackRate, crossfadeEnabled, setCrossfadeEnabled } = useAudioSettings();

  const loader = useMemo(() => new AudioLoader(), []);
  const data = usePlayerData({ loader, addToast, setError, setCurrentTrack, isSharedPlaylist });
  const {
    library, allTags, stats, isLoadingLibrary, isResyncingLibrary,
    playlists, isLoadingPlaylists,
    sharedPlaylistTitle, setSharedPlaylistTitle,
    searchQuery, setSearchQuery, minRating, setMinRating,
    selectedTags, setSelectedTags, untaggedOnly, setUntaggedOnly,
    sortBy, setSortBy, storageSourceFilter, setStorageSourceFilter,
    queue, setQueue, queueCurrentIndex, setQueueCurrentIndex,
    showQueue, setShowQueue, shuffle, setShuffle, repeatMode, setRepeatMode,
    volume, setVolume, muted, setMuted, prevVolumeRef,
    checkBackend, loadPlaylists, loadLibrary, loadStats, triggerLibraryResync,
    addToQueue, addAllToQueue, removeFromQueue, reorderQueue, clearQueue, enqueueNext,
    updateTrack, trashTrack,
  } = data;

  const [activeTab, setActiveTab] = useState<'library' | 'now-playing' | 'queue' | 'playlists' | 'generate' | 'settings'>('library');
  const [libraryViewMode, setLibraryViewMode] = useState<'grid' | 'list'>('grid');
  const [showHtmlFallback, setShowHtmlFallback] = useState(false);
  const [currentFile, setCurrentFile] = useState<File | undefined>(undefined);
  const [showHelp, setShowHelp] = useState(false);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [visualizerAesthetic, setVisualizerAesthetic] = useState<VisualizerAesthetic>(
    () => getInitialVisualizerAesthetic()
  );
  const searchInputRef = useRef<HTMLInputElement>(null);
  const pendingFilesRef = useRef<File[]>([]);
  const handleAutoAdvanceRef = useRef<() => void>(() => {});

  // =============================================================================
  // Initialization: shared playlist / URL params / saved queue
  // =============================================================================

  useEffect(() => {
    const initializeApp = async () => {
      const params = new URLSearchParams(window.location.search);
      const tracksParam = params.get('tracks');

      if (sharedPlaylistId) {
        try {
          const shared = await loader.fetchSharedPlaylist(sharedPlaylistId);
          if (shared.tracks.length > 0) {
            setQueue(shared.tracks);
            setQueueCurrentIndex(0);
            setActiveTab('now-playing');
            setSharedPlaylistTitle(shared.title);
            document.title = shared.title;
            addToast(`Loaded shared playlist: ${shared.title}`, 'success');
            return;
          }
        } catch {
          addToast('Failed to load shared playlist', 'error');
        }
      }

      if (tracksParam) {
        try {
          const trackIds = tracksParam.split(',');
          const { tracks: allTracks } = await loader.fetchLibrary({ limit: 500 });
          const playlistTracks = trackIds
            .map(id => allTracks.find(t => t.id === id))
            .filter(Boolean) as PlaylistTrack[];
          if (playlistTracks.length > 0) {
            setQueue(playlistTracks);
            setQueueCurrentIndex(0);
            setActiveTab('now-playing');
            addToast('Loaded custom playlist!', 'success');
            window.history.replaceState({}, '', window.location.pathname);
            return;
          }
        } catch { /* no-op */ }
      }

      const saved = loadQueueFromStorage();
      if (saved && saved.tracks.length > 0) {
        setQueue(saved.tracks);
        setQueueCurrentIndex(saved.currentIndex);
        setShuffle(saved.shuffle);
        setRepeatMode(saved.repeat);
      }
    };
    initializeApp();
  }, [loader, addToast]);

  // =============================================================================
  // Local file loading
  // =============================================================================

  const loadLocalFile = useCallback(async (file: File) => {
    if (!playerRef.current) return;
    setPlayerState(prev => ({ ...prev, isLoading: true }));
    setError('');
    setCurrentFile(file);

    try {
      const arrayBuffer = await file.arrayBuffer();
      let track: PlaylistTrack;
      try {
        const { parseBlob } = await import('music-metadata-browser');
        const meta = await parseBlob(file);
        track = {
          id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          title: (meta.common.title as string) || file.name.replace(/\.[^/.]+$/, ''),
          author: (meta.common.artist as string) || 'Unknown Artist',
          url: URL.createObjectURL(file),
          duration: (meta.format.duration as number) || 0,
        };
      } catch {
        track = {
          id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          title: file.name.replace(/\.[^/.]+$/, ''),
          author: 'Unknown Artist',
          url: URL.createObjectURL(file),
          duration: 0,
        };
      }

      setCurrentTrack(track);

      if (outputMode === 'streaming') {
        setError('Streaming mode does not support local files. Switch to a buffered audio mode.');
        return;
      }

      await playerRef.current.loadFromArrayBuffer(arrayBuffer, file.name);
      playerRef.current.play();
      addToast(`Playing: ${track.title || track.name}`, 'info');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load file';
      setError(message);
      addToast(`Failed to load file: ${message}`, 'error');
    } finally {
      setPlayerState(prev => ({ ...prev, isLoading: false }));
    }
  }, [addToast, outputMode, setCurrentTrack, setError, setPlayerState]);

  const handleLocalFiles = useCallback((files: File[]) => {
    if (outputMode === 'streaming') {
      pendingFilesRef.current = files;
      setOutputMode('worklet');
      addToast('Switched to buffered mode for local files', 'info');
      return;
    }
    files.forEach((file, i) => setTimeout(() => loadLocalFile(file), i * 100));
  }, [outputMode, loadLocalFile, addToast, setOutputMode]);

  // Flush any files dropped before the backend finished initializing.
  const flushPendingFiles = useCallback(() => {
    if (pendingFilesRef.current.length === 0) return;
    const files = pendingFilesRef.current;
    pendingFilesRef.current = [];
    setTimeout(() => files.forEach((file, i) => setTimeout(() => loadLocalFile(file), i * 100)), 0);
  }, [loadLocalFile]);

  const playerRef = useAudioBackendLifecycle({
    outputMode,
    initialSettings: { volume, muted, eqGains, playbackRate, crossfadeEnabled },
    eqGains, playbackRate, crossfadeEnabled,
    onTrackEndedRef: handleAutoAdvanceRef,
    onInitialized: flushPendingFiles,
    setPlayerState, setError,
    queue, queueCurrentIndex, shuffle, repeatMode,
  });

  const { loadAudioFromUrl, playbackPath } = useTrackLoader({
    playerRef, loader, outputMode,
    setPlayerState, setError, setCurrentTrack, addToast,
  });

  const { playTrack, playNextInQueue, playPreviousInQueue, togglePlayback } = useQueuePlayback({
    playerRef,
    onTrackEndedRef: handleAutoAdvanceRef,
    loadAudioFromUrl,
    queue, queueCurrentIndex, setQueueCurrentIndex, shuffle, repeatMode,
    playerState, setCurrentTrack, setLoadingTrackId, setError, addToast,
    onPlayRecorded: loadStats,
  });

  useEffect(() => {
    if (isSharedPlaylist) return;
    const interval = setInterval(() => {
      if (currentTrack && playerState.currentTime > 0 && playerState.duration > 0) {
        try {
          localStorage.setItem('flac_position', JSON.stringify({ trackId: currentTrack.id, time: playerState.currentTime }));
        } catch { /* no-op */ }
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [isSharedPlaylist, currentTrack, playerState.currentTime, playerState.duration]);

  // =============================================================================
  // Playback controls
  // =============================================================================

  const loadCloudPlaylist = useCallback(async (playlistId: string) => {
    try {
      const trackIds = await loader.fetchPlaylistTracks(playlistId);
      if (trackIds.length === 0) { addToast('Playlist is empty or unavailable', 'info'); return; }
      const matchedTracks = trackIds.map(id => library.find(t => t.id === id)).filter(Boolean) as PlaylistTrack[];
      if (matchedTracks.length === 0) { addToast('No matching tracks found in local library', 'error'); return; }
      setQueue(matchedTracks);
      setQueueCurrentIndex(0);
      playTrack(matchedTracks[0], 0);
      addToast(`Loaded ${matchedTracks.length}/${trackIds.length} tracks from playlist`, 'success');
    } catch {
      addToast('Failed to load playlist tracks', 'error');
    }
  }, [loader, library, addToast]);

  const playAll = (tracks: PlaylistTrack[], shuffled = false) => {
    if (tracks.length === 0) return;
    const ordered = shuffled ? shuffleArray(tracks) : tracks;
    setQueue(ordered);
    setQueueCurrentIndex(0);
    playTrack(ordered[0], 0);
    addToast(shuffled ? `Shuffling ${ordered.length} tracks` : `Playing ${ordered.length} tracks`, 'success');
  };

  const playNow = (track: PlaylistTrack) => {
    setQueue([track]); setQueueCurrentIndex(0); playTrack(track, 0);
    addToast('Playing now: ' + (track.title || track.name), 'info');
  };

  const handleSmartMix = async () => {
    if (!currentTrack?.tags) { addToast('No tags to base mix on', 'error'); return; }
    try {
      const similar = await loader.findSimilarTracks(currentTrack.id, currentTrack.tags, 4, 20);
      if (similar.length > 0) {
        setQueue(prev => [...prev, ...similar.filter(t => !prev.some(p => p.id === t.id))]);
        addToast(`Added ${similar.length} tracks to queue`, 'success');
      } else {
        addToast('No similar tracks found', 'info');
      }
    } catch {
      addToast('Failed to create smart mix', 'error');
    }
  };

  const generateShareLink = async () => {
    if (queue.length === 0) { addToast('Add tracks to the queue first.', 'info'); return; }
    const trackIds = queue.map(t => t.id).filter(Boolean);
    if (trackIds.length === 0) { addToast('No valid tracks to share.', 'info'); return; }
    try {
      const shareResponse = await loader.createShare(trackIds, 'Shared Playlist', 30);
      await navigator.clipboard.writeText(shareResponse.short_url || shareResponse.full_url);
      addToast('Shareable playlist link copied to clipboard!', 'success');
      return;
    } catch {
      addToast('Could not create shared playlist. Falling back to URL playlist.', 'error');
    }
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}?tracks=${trackIds.join(',')}`);
      addToast('Legacy playlist link copied to clipboard.', 'success');
    } catch {
      addToast('Error copying link.', 'error');
    }
  };

  const toggleMute = useCallback(() => {
    setMuted(prev => {
      if (!prev) {
        prevVolumeRef.current = volume;
        playerRef.current?.setVolume(0);
      } else {
        const restoredVol = prevVolumeRef.current;
        playerRef.current?.setVolume(restoredVol);
        setVolume(restoredVol);
      }
      return !prev;
    });
  }, [volume, setMuted, setVolume]);

  const handleVolumeChange = useCallback((vol: number) => {
    if (vol > 0) prevVolumeRef.current = vol;
    setMuted(false);
    setVolume(vol);
    playerRef.current?.setVolume(vol);
  }, [setMuted, setVolume]);

  // =============================================================================
  // Keyboard shortcuts & drag-and-drop
  // =============================================================================

  useKeyboardShortcuts({
    onPlayPause: togglePlayback,
    onSeekForward:  () => { if (playerRef.current) playerRef.current.seek(Math.min(playerState.currentTime + 10, playerState.duration)); },
    onSeekBackward: () => { if (playerRef.current) playerRef.current.seek(Math.max(playerState.currentTime - 10, 0)); },
    onNext: playNextInQueue,
    onPrevious: playPreviousInQueue,
    onSearchFocus: () => searchInputRef.current?.focus(),
    onVolumeUp:   () => handleVolumeChange(Math.min(1, volume + 0.1)),
    onVolumeDown: () => handleVolumeChange(Math.max(0, volume - 0.1)),
    onToggleQueue: () => setShowQueue(prev => !prev),
    onMute: toggleMute,
    onShowHelp: () => setShowHelp(prev => !prev),
    isEnabled: true
  });

  useEffect(() => {
    const onDragOver = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); setIsDraggingFile(true); } };
    const onDragLeave = (e: DragEvent) => { if (e.relatedTarget === null) setIsDraggingFile(false); };
    const onDrop = (e: DragEvent) => {
      setIsDraggingFile(false);
      if (!e.dataTransfer) return;
      const files = Array.from(e.dataTransfer.files).filter(
        f => f.name.endsWith('.flac') || f.name.endsWith('.wav') || f.name.endsWith('.mp3') || f.type.includes('audio')
      );
      if (files.length > 0) { e.preventDefault(); handleLocalFiles(files); }
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [handleLocalFiles]);

  const fastMirrorCount = useMemo(() => library.filter(track => isFastStorageUrl(track.url)).length, [library]);
  const displayedLibrary = useMemo(
    () => storageSourceFilter === 'fast' ? library.filter(track => isFastStorageUrl(track.url)) : library,
    [library, storageSourceFilter]
  );

  const handleGenerationCompleted = async (songId: string) => {
    const generatedTrack = await loader.fetchSong(songId);
    await loadLibrary();
    playNow(generatedTrack);
    setActiveTab('now-playing');
    addToast(`Generated track ready: ${generatedTrack.title || generatedTrack.name}`, 'success');
  };

  // =============================================================================
  // Render — Project-M embed / audio-only mode
  // =============================================================================
  // When opened as a Project-M PCM feeder (?projectm=1 / window.name), skip
  // ShaderGUI and PlayerFallbackView entirely so the WebGPU visualizer never
  // initializes. The audio engine + PCM bridge are wired in the effects above
  // (which run regardless of this branch), so audio keeps flowing to the host.
  if (IS_PROJECTM_EMBED) {
    return (
      <>
        <ToastContainer toasts={toasts} onRemove={removeToast} />
        <EmbedPlayerView
          currentTrack={currentTrack}
          isPlaying={playerState.isPlaying}
          isLoading={playerState.isLoading}
          currentTime={playerState.currentTime}
          duration={playerState.duration}
          onPlay={togglePlayback}
          onStop={() => playerRef.current?.stop()}
          onSeek={(t) => playerRef.current?.seek(t)}
          onNext={playNextInQueue}
          onPrevious={playPreviousInQueue}
          onFileSelect={handleLocalFiles}
        />
      </>
    );
  }

  // =============================================================================
  // Render — ShaderGUI mode
  // =============================================================================

  if (!showHtmlFallback) {
    return (
      <>
        <ToastContainer toasts={toasts} onRemove={removeToast} />
        {!isSharedPlaylist && (
          <div className="fixed top-4 right-4 z-40 flex gap-2">
            <button onClick={() => { setActiveTab('generate'); setShowHtmlFallback(true); }}
              className="px-4 py-2 rounded-lg bg-fuchsia-600/90 text-white text-sm font-semibold hover:bg-fuchsia-500 transition-colors shadow-lg">
              ✨ Generate
            </button>
            <button onClick={triggerLibraryResync} disabled={isResyncingLibrary}
              className="px-4 py-2 rounded-lg bg-blue-600/90 text-white text-sm font-semibold hover:bg-blue-500 transition-colors shadow-lg disabled:opacity-60">
              {isResyncingLibrary ? '⏳ Rescanning...' : '🔄 Rescan Library'}
            </button>
            <a href="https://storage.noahcohn.com/admin" target="_blank" rel="noopener noreferrer"
              className="px-4 py-2 rounded-lg bg-purple-600/90 text-white text-sm font-semibold hover:bg-purple-500 transition-colors shadow-lg">
              ⬆️ Add Music
            </a>
          </div>
        )}
        {showHelp && <KeyboardHelpModal onClose={() => setShowHelp(false)} />}
        {isSharedPlaylist && sharedPlaylistTitle && (
          <div className="fixed top-0 left-0 right-0 z-40 flex items-center justify-center pt-4 pointer-events-none">
            <h1 className="text-xl md:text-2xl font-bold text-white/90 bg-black/50 backdrop-blur px-6 py-2 rounded-full border border-white/10 pointer-events-auto">
              {sharedPlaylistTitle}
            </h1>
          </div>
        )}
        {isDraggingFile && (
          <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center pointer-events-none">
            <div className="border-4 border-dashed border-purple-400 rounded-2xl p-12 text-center">
              <p className="text-2xl text-purple-300 font-bold">Drop FLAC/WAV files to play</p>
            </div>
          </div>
        )}
        <VisualizerShell
          aesthetic={visualizerAesthetic}
          onAestheticChange={setVisualizerAesthetic}
          analyser={playerRef.current?.getAnalyser() || null}
          currentTrack={currentTrack} queue={queue} queueCurrentIndex={queueCurrentIndex}
          isPlaying={playerState.isPlaying} isLoading={playerState.isLoading}
          currentTime={playerState.currentTime} duration={playerState.duration}
          volume={volume} muted={muted}
          onPlay={togglePlayback} onStop={() => playerRef.current?.stop()}
          onSeek={(t) => playerRef.current?.seek(t)}
          onTrackClick={(index) => playTrack(queue[index], index)}
          onVolumeChange={handleVolumeChange} onMute={toggleMute}
          onNext={playNextInQueue} onPrevious={playPreviousInQueue}
          onToggleFallback={() => setShowHtmlFallback(true)}
          showFallbackToggle={!isSharedPlaylist}
          onFileSelect={handleLocalFiles}
        />
      </>
    );
  }

  // =============================================================================
  // Render — HTML fallback mode
  // =============================================================================

  return (
    <PlayerFallbackView
      toasts={toasts} removeToast={removeToast}
      showHelp={showHelp} setShowHelp={setShowHelp}
      backendStatus={backendStatus}
      onRetry={() => checkBackend().then(h => { setBackendStatus(h ? 'up' : 'down'); if (h) loadLibrary(); })}
      queue={queue} queueCurrentIndex={queueCurrentIndex}
      showQueue={showQueue} setShowQueue={setShowQueue}
      shuffle={shuffle} setShuffle={setShuffle}
      repeatMode={repeatMode} setRepeatMode={setRepeatMode}
      isResyncingLibrary={isResyncingLibrary} onTriggerResync={triggerLibraryResync}
      currentTrack={currentTrack} currentFile={currentFile} loadingTrackId={loadingTrackId}
      isPlaying={playerState.isPlaying} isLoading={playerState.isLoading}
      currentTime={playerState.currentTime} duration={playerState.duration}
      library={library} displayedLibrary={displayedLibrary}
      allTags={allTags} stats={stats} isLoadingLibrary={isLoadingLibrary}
      fastMirrorCount={fastMirrorCount}
      playlists={playlists} isLoadingPlaylists={isLoadingPlaylists} onLoadPlaylists={loadPlaylists}
      activeTab={activeTab} setActiveTab={setActiveTab}
      libraryViewMode={libraryViewMode} setLibraryViewMode={setLibraryViewMode}
      searchQuery={searchQuery} setSearchQuery={setSearchQuery} searchInputRef={searchInputRef}
      minRating={minRating} setMinRating={setMinRating}
      selectedTags={selectedTags} setSelectedTags={setSelectedTags}
      untaggedOnly={untaggedOnly} setUntaggedOnly={setUntaggedOnly}
      sortBy={sortBy} setSortBy={setSortBy}
      storageSourceFilter={storageSourceFilter} setStorageSourceFilter={setStorageSourceFilter}
      volume={volume} muted={muted} outputMode={outputMode} setOutputMode={setOutputMode}
      eqGains={eqGains} setEQBandGain={setEQBandGain} resetEQ={resetEQ}
      playbackRate={playbackRate} setPlaybackRate={setPlaybackRate}
      crossfadeEnabled={crossfadeEnabled} setCrossfadeEnabled={setCrossfadeEnabled}
      playbackPath={playbackPath}
      isSharedPlaylist={isSharedPlaylist} sharedPlaylistTitle={sharedPlaylistTitle}
      analyser={playerRef.current?.getAnalyser() || null}
      onTrackClick={(track) => { addToQueue(track); playTrack(track, queue.length); }}
      onTrackDoubleClick={playNow}
      onQueueTrackClick={(index) => playTrack(queue[index], index)}
      onPlay={togglePlayback} onStop={() => playerRef.current?.stop()}
      onSeek={(t) => playerRef.current?.seek(t)}
      onVolumeChange={handleVolumeChange} onMute={toggleMute}
      onNext={playNextInQueue} onPrevious={playPreviousInQueue}
      onFileSelect={handleLocalFiles}
      onPlayAll={playAll} onAddAllToQueue={addAllToQueue}
      onPlayNow={playNow} onPlayNext={enqueueNext} onAddToQueue={addToQueue}
      onRemoveFromQueue={removeFromQueue} onClearQueue={clearQueue}
      onReorderQueue={reorderQueue} onSmartMix={handleSmartMix}
      onShareQueue={generateShareLink}
      onUpdateTrack={updateTrack} onTrashTrack={trashTrack}
      onLoadCloudPlaylist={loadCloudPlaylist}
      onSetShowHtmlFallback={setShowHtmlFallback}
      onClearCache={() => clearTrackCache().then(() => addToast('Offline cache cleared', 'success'))}
      onGenerationCompleted={handleGenerationCompleted}
    />
  );
};
