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
import { useLocalFileLoader } from '../hooks/useLocalFileLoader';
import { usePlaylistActions } from '../hooks/usePlaylistActions';
import { PlayerShell } from './PlayerShell';
import { PlayerProvider, type PlayerContextValue } from '../contexts/PlayerContext';
import { PlayerFallbackView } from './PlayerFallbackView';
import { ShaderGuiLayout } from './ShaderGuiLayout';
import { EmbedPlayerView } from './EmbedPlayerView';
import { isFastStorageUrl } from '../utils/audioUtils';
import { IS_PROJECTM_EMBED } from '../utils/embedMode';
import {
  getInitialVisualizerAesthetic,
  VisualizerAesthetic,
} from '../utils/visualizerMode';
import { clearTrackCache } from '../storage/trackCache';
import { sharedAudioContextManager } from '../audio/AudioContextManager';
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
  const { eqGains, setEQBandGain, resetEQ, playbackRate, setPlaybackRate, crossfadeEnabled, setCrossfadeEnabled, latencyMode, setLatencyMode, replayGainEnabled, setReplayGainEnabled, replayGainDb, setReplayGainDb } = useAudioSettings();

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
  const [showHelp, setShowHelp] = useState(false);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [visualizerAesthetic, setVisualizerAesthetic] = useState<VisualizerAesthetic>(
    () => getInitialVisualizerAesthetic()
  );
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Assigned by the hooks below; held here to break the cycle between the audio
  // backend (which invokes them) and the hooks that need the backend ref.
  const handleAutoAdvanceRef = useRef<() => void>(() => {});
  const flushPendingFilesRef = useRef<() => void>(() => {});

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

  const [contextSampleRate, setContextSampleRate] = useState(0);
  useEffect(() => {
    const update = () => setContextSampleRate(sharedAudioContextManager.getSampleRate());
    update();
    return sharedAudioContextManager.onContextChange(update);
  }, []);

  const { playerRef, contextGeneration } = useAudioBackendLifecycle({
    outputMode,
    latencyMode,
    replayGainEnabled,
    replayGainDb,
    initialSettings: { volume, muted, eqGains, playbackRate, crossfadeEnabled },
    eqGains, playbackRate, crossfadeEnabled,
    onTrackEndedRef: handleAutoAdvanceRef,
    onInitializedRef: flushPendingFilesRef,
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

  // An AudioContext rebuild (sample-rate or latency-hint change) tears down the
  // backend mid-flight, so whatever was loaded is gone. Reload it once the new
  // backend exists; without this the track silently never plays.
  const reloadedForGeneration = useRef(0);
  useEffect(() => {
    if (contextGeneration === 0) return;
    if (reloadedForGeneration.current === contextGeneration) return;
    reloadedForGeneration.current = contextGeneration;
    if (currentTrack) void playTrack(currentTrack, queueCurrentIndex);
  }, [contextGeneration, currentTrack, queueCurrentIndex, playTrack]);

  const { currentFile, handleLocalFiles } = useLocalFileLoader({
    playerRef, outputMode, setOutputMode,
    onInitializedRef: flushPendingFilesRef,
    setPlayerState, setError, setCurrentTrack, addToast,
  });

  const { playAll, playNow, loadCloudPlaylist, handleSmartMix, generateShareLink } = usePlaylistActions({
    loader, library, queue, setQueue, setQueueCurrentIndex,
    playTrack, currentTrack, addToast,
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

  // Chrome shared by every layout below.
  const shellProps = {
    toasts,
    onRemoveToast: removeToast,
    showHelp,
    onCloseHelp: () => setShowHelp(false),
    isDraggingFile,
  };

  const contextValue: PlayerContextValue = {
    data: {
      library, displayedLibrary, allTags, stats, isLoadingLibrary, fastMirrorCount,
      playlists, isLoadingPlaylists, onLoadPlaylists: loadPlaylists,
      isResyncingLibrary, onTriggerResync: triggerLibraryResync,
      onUpdateTrack: updateTrack, onTrashTrack: trashTrack,
      onLoadCloudPlaylist: loadCloudPlaylist,
    },
    filters: {
      searchQuery, setSearchQuery, searchInputRef,
      minRating, setMinRating, selectedTags, setSelectedTags,
      untaggedOnly, setUntaggedOnly, sortBy, setSortBy,
      storageSourceFilter, setStorageSourceFilter,
    },
    queueState: {
      queue, queueCurrentIndex, showQueue, setShowQueue,
      shuffle, setShuffle, repeatMode, setRepeatMode,
      onAddToQueue: addToQueue, onAddAllToQueue: addAllToQueue, onPlayNext: enqueueNext,
      onRemoveFromQueue: removeFromQueue, onClearQueue: clearQueue,
      onReorderQueue: reorderQueue, onSmartMix: handleSmartMix,
      onShareQueue: generateShareLink,
    },
    playback: {
      currentTrack, currentFile, loadingTrackId,
      isPlaying: playerState.isPlaying, isLoading: playerState.isLoading,
      currentTime: playerState.currentTime, duration: playerState.duration,
      volume, muted,
      analyser: playerRef.current?.getAnalyser() || null,
      playbackPath,
      onPlay: togglePlayback,
      onStop: () => playerRef.current?.stop(),
      onSeek: (t) => playerRef.current?.seek(t),
      onNext: playNextInQueue, onPrevious: playPreviousInQueue,
      onVolumeChange: handleVolumeChange, onMute: toggleMute,
      onFileSelect: handleLocalFiles,
      onTrackClick: (track) => { addToQueue(track); playTrack(track, queue.length); },
      onTrackDoubleClick: playNow,
      onQueueTrackClick: (index) => playTrack(queue[index], index),
      onPlayNow: playNow, onPlayAll: playAll,
    },
    settings: {
      outputMode, setOutputMode,
      eqGains, setEQBandGain, resetEQ,
      playbackRate, setPlaybackRate,
      crossfadeEnabled, setCrossfadeEnabled,
      latencyMode, setLatencyMode,
      contextSampleRate,
      replayGainEnabled, setReplayGainEnabled,
      replayGainDb, setReplayGainDb,
      onClearCache: () => clearTrackCache().then(() => addToast('Offline cache cleared', 'success')),
    },
    session: {
      backendStatus,
      onRetry: () => checkBackend().then(h => { setBackendStatus(h ? 'up' : 'down'); if (h) loadLibrary(); }),
      isSharedPlaylist, sharedPlaylistTitle,
    },
    ui: {
      activeTab, setActiveTab, libraryViewMode, setLibraryViewMode,
      onSetShowHtmlFallback: setShowHtmlFallback,
      visualizerAesthetic, setVisualizerAesthetic,
      onShowHelp: () => setShowHelp(true),
      onGenerationCompleted: handleGenerationCompleted,
    },
  };

  // =============================================================================
  // Render
  // =============================================================================
  // Every layout reads from PlayerContext; only the layout component differs.
  //
  // The projectM embed (?projectm=1 / window.name) deliberately renders neither
  // ShaderGuiLayout nor PlayerFallbackView, so the WebGPU visualizer never
  // initializes. The audio engine and PCM bridge are wired in the hooks above,
  // which run regardless of which branch renders, so audio keeps flowing.
  const layout = IS_PROJECTM_EMBED
    ? (
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
    )
    : showHtmlFallback
      ? <PlayerFallbackView />
      : <ShaderGuiLayout />;

  return (
    <PlayerShell {...shellProps}>
      <PlayerProvider value={contextValue}>
        {layout}
      </PlayerProvider>
    </PlayerShell>
  );
};
