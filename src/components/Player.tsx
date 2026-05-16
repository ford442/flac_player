import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { AudioPlayer } from '../audioPlayer';
import { SdlAudioPlayer } from '../sdlAudioPlayer';
import { Sdl2AudioPlayer } from '../sdl2AudioPlayer';
import { AudioWorkletPlayer } from '../audioWorkletPlayer';
import { StreamingAudioPlayer } from '../streamingAudioPlayer';
import {
  AudioLoader,
  PlaylistTrack,
  SortBy,
  RepeatMode,
  LibraryStats,
  TagInfo,
  CloudPlaylist,
  saveQueueToStorage,
  loadQueueFromStorage,
  clearQueueStorage,
  getCachedLibrary,
  setCachedLibrary
} from '../audioLoader';

import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { usePlayerState, AudioOutputMode } from '../hooks/usePlayerState';
import { useToastNotifications } from '../hooks/useToastNotifications';
import { LibraryView } from './LibraryView';
import { QueuePanel } from './QueuePanel';
import { ShaderGUI } from './ShaderGUI/ShaderGUI';
import { MetadataPanel } from './MetadataPanel';
import { FileDropZone } from './FileDropZone';
import { ToastContainer } from './Toast';
import { KeyboardHelpModal } from './KeyboardHelpModal';
import { checkBackendHealth } from '../utils/healthCheck';
import { handleQueueAutoAdvance, reorderQueueIndex, addTrackToQueue, playNextTrack, removeFromQueue as removeFromQueueUtil } from '../utils/queueUtils';
import './Player.css';

// =============================================================================
// Types & Constants
// =============================================================================

type ViewTab = 'library' | 'now-playing' | 'queue' | 'playlists';
type LibraryViewMode = 'grid' | 'list';

type AnyPlayer = AudioPlayer | AudioWorkletPlayer | SdlAudioPlayer | Sdl2AudioPlayer | StreamingAudioPlayer;

const getSharedPlaylistId = (): string | null => {
  const params = new URLSearchParams(window.location.search);
  const queryShareId = params.get('share');
  if (queryShareId) return queryShareId;
  const pathMatch = window.location.pathname.match(/^\/playlist\/([^/]+)$/);
  return pathMatch ? decodeURIComponent(pathMatch[1]) : null;
};

// =============================================================================
// Main Player Component
// =============================================================================

export const Player: React.FC = () => {
  const sharedPlaylistId = useMemo(() => getSharedPlaylistId(), []);
  const isSharedPlaylist = sharedPlaylistId !== null;

  // State management
  const { playerState, setPlayerState, outputMode, setOutputMode, error, setError, currentTrack, setCurrentTrack, loadingTrackId, setLoadingTrackId, backendStatus, setBackendStatus } = usePlayerState();
  const { toasts, addToast, removeToast } = useToastNotifications();

  const [activeTab, setActiveTab] = useState<ViewTab>('library');
  const [libraryViewMode, setLibraryViewMode] = useState<LibraryViewMode>('grid');

  const [library, setLibrary] = useState<PlaylistTrack[]>([]);
  const [allTags, setAllTags] = useState<TagInfo[]>([]);
  const [stats, setStats] = useState<LibraryStats>({
    total_tracks: 0, rated_4plus: 0, total_duration_hours: 0,
    total_play_count: 0, untagged_count: 0, trash_count: 0,
    unique_tags: 0, top_tags: []
  });
  const [isLoadingLibrary, setIsLoadingLibrary] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [minRating, setMinRating] = useState<number>(0);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [untaggedOnly, setUntaggedOnly] = useState(false);
  const [sortBy, setSortBy] = useState<SortBy>('date');
  const [volume, setVolume] = useState(() => {
    try { const v = parseFloat(localStorage.getItem('flac_volume') || '1'); return isNaN(v) ? 1 : Math.max(0, Math.min(1, v)); } catch { return 1; }
  });
  const [muted, setMuted] = useState(false);
  const prevVolumeRef = useRef(1);

  const [queue, setQueue] = useState<PlaylistTrack[]>([]);
  const [queueCurrentIndex, setQueueCurrentIndex] = useState<number>(-1);
  const [showQueue, setShowQueue] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [repeatMode, setRepeatMode] = useState<RepeatMode>('off');

  const [sharedPlaylistTitle, setSharedPlaylistTitle] = useState<string>('');
  const [showHtmlFallback, setShowHtmlFallback] = useState(false);
  const [playlists, setPlaylists] = useState<CloudPlaylist[]>([]);
  const [isLoadingPlaylists, setIsLoadingPlaylists] = useState(false);
  const [currentFile, setCurrentFile] = useState<File | undefined>(undefined);
  const [showHelp, setShowHelp] = useState(false);

  const playerRef = useRef<AnyPlayer | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const pendingFilesRef = useRef<File[]>([]);
  const loader = useMemo(() => new AudioLoader(), []);

  type EndCallbackPlayer = { setOnEndedCallback?: (cb?: () => void) => void };

  // =============================================================================
  // Data Loading
  // =============================================================================

  const checkBackend = useCallback(async () => {
    const isUp = await checkBackendHealth(loader);
    setBackendStatus(isUp ? 'up' : 'down');
    return isUp;
  }, [loader]);

  const loadPlaylists = useCallback(async () => {
    setIsLoadingPlaylists(true);
    try {
      setPlaylists(await loader.fetchPlaylists());
    } catch {
      addToast('Failed to load playlists', 'error');
    } finally {
      setIsLoadingPlaylists(false);
    }
  }, [loader, addToast]);

  const loadLibrary = useCallback(async () => {
    setIsLoadingLibrary(true);
    try {
      const { tracks } = await loader.fetchLibrary({
        ratingGte: minRating,
        tags: selectedTags.length > 0 ? selectedTags : undefined,
        untagged: untaggedOnly,
        search: searchQuery || undefined,
        sortBy,
        sortDesc: true,
        limit: 1000
      });
      setLibrary(tracks);
      setCachedLibrary(tracks, allTags, stats);
    } catch {
      const cached = getCachedLibrary();
      if (cached && cached.tracks.length > 0) {
        setLibrary(cached.tracks);
        setAllTags(cached.tags);
        setStats(cached.stats);
        addToast('Showing cached library (server unavailable)', 'info');
      } else {
        setError('Failed to load library');
      }
    } finally {
      setIsLoadingLibrary(false);
    }
  }, [loader, minRating, selectedTags, untaggedOnly, searchQuery, sortBy, allTags, stats, addToast]);

  const loadTags = useCallback(async () => {
    try { setAllTags(await loader.fetchTags()); } catch { /* no-op */ }
  }, [loader]);

  const loadStats = useCallback(async () => {
    try { setStats(await loader.fetchStats()); } catch { /* no-op */ }
  }, [loader]);

  useEffect(() => {
    if (isSharedPlaylist) return;
    checkBackend().then(healthy => { if (healthy) loadLibrary(); });
  }, [isSharedPlaylist, checkBackend, loadLibrary]);

  useEffect(() => {
    if (isSharedPlaylist) return;
    loadTags();
    loadStats();
  }, [isSharedPlaylist, loadTags, loadStats]);

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

  useEffect(() => {
    if (isSharedPlaylist) return;
    saveQueueToStorage({ tracks: queue, currentIndex: queueCurrentIndex, shuffle, repeat: repeatMode });
  }, [isSharedPlaylist, queue, queueCurrentIndex, shuffle, repeatMode]);

  // Persist volume to localStorage
  useEffect(() => {
    try { localStorage.setItem('flac_volume', String(volume)); } catch { /* no-op */ }
  }, [volume]);

  // Persist playback position periodically
  useEffect(() => {
    if (isSharedPlaylist) return;
    const interval = setInterval(() => {
      if (currentTrack && playerState.currentTime > 0 && playerState.duration > 0) {
        try {
          localStorage.setItem('flac_position', JSON.stringify({
            trackId: currentTrack.id,
            time: playerState.currentTime,
          }));
        } catch { /* no-op */ }
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [isSharedPlaylist, currentTrack, playerState.currentTime, playerState.duration]);

  // =============================================================================
  // Local File Loading
  // =============================================================================

  const loadLocalFile = useCallback(async (file: File) => {
    if (!playerRef.current) return;
    setPlayerState(prev => ({ ...prev, isLoading: true }));
    setError('');
    setCurrentFile(file);

    try {
      const arrayBuffer = await file.arrayBuffer();

      // Extract metadata
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

      if (playerRef.current instanceof StreamingAudioPlayer) {
        setError('Streaming mode does not support local files. Switch to a buffered audio mode.');
        return;
      }

      await (playerRef.current as AudioPlayer).loadAudio(arrayBuffer);
      playerRef.current.play();
      addToast(`Playing: ${track.title || track.name}`, 'info');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load file';
      setError(message);
      addToast(`Failed to load file: ${message}`, 'error');
    } finally {
      setPlayerState(prev => ({ ...prev, isLoading: false }));
    }
  }, [addToast]);

  const handleLocalFiles = useCallback((files: File[]) => {
    if (outputMode === 'streaming') {
      pendingFilesRef.current = files;
      setOutputMode('worklet');
      addToast('Switched to buffered mode for local files', 'info');
      return;
    }
    files.forEach((file, i) => {
      setTimeout(() => loadLocalFile(file), i * 100);
    });
  }, [outputMode, loadLocalFile, addToast]);

  // =============================================================================
  // Player Initialization
  // =============================================================================

  useEffect(() => {
    let player: AnyPlayer;

    if (outputMode === 'streaming') {
      player = new StreamingAudioPlayer();
    } else if (outputMode === 'worklet') {
      player = new AudioWorkletPlayer();
    } else if (outputMode === 'sdl') {
      player = new SdlAudioPlayer();
    } else if (outputMode === 'sdl2') {
      player = new Sdl2AudioPlayer();
    } else {
      player = new AudioPlayer();
    }

    if (outputMode === 'worklet') {
      (player as AudioWorkletPlayer).initialize().then(ok => {
        if (!ok) setError('AudioWorklet initialization failed');
      });
    }

    player.setStateChangeCallback(setPlayerState);
    (player as EndCallbackPlayer).setOnEndedCallback?.(() => handleAutoAdvance());
    playerRef.current = player;

    // Apply persisted volume immediately
    player.setVolume(muted ? 0 : volume);

    // Load pending local files after mode switch
    if (pendingFilesRef.current.length > 0) {
      const files = pendingFilesRef.current;
      pendingFilesRef.current = [];
      setTimeout(() => {
        files.forEach((file, i) => {
          setTimeout(() => loadLocalFile(file), i * 100);
        });
      }, 0);
    }

    return () => {
      (player as EndCallbackPlayer).setOnEndedCallback?.(undefined);
      player.destroy();
    };
  }, [outputMode, loadLocalFile]);

  // =============================================================================
  // Playback Controls
  // =============================================================================

  const loadAudioFromUrl = async (url: string, track?: PlaylistTrack) => {
    if (!url.trim() || !playerRef.current) return;

    setPlayerState(prev => ({ ...prev, isLoading: true }));
    setError('');

    try {
      if (playerRef.current instanceof StreamingAudioPlayer) {
        // Streaming: set src and wait for canplay — no full download
        await playerRef.current.loadURL(url);
      } else {
        // Buffer mode: fetch entire file then decode
        const arrayBuffer = await loader.loadFromURL(url);
        await (playerRef.current as AudioPlayer).loadAudio(arrayBuffer);
      }

      if (track) {
        setCurrentTrack(track);
        if (track.id) {
          await loader.recordPlay(track.id);
          addToast('Playing: ' + (track.title || track.name), 'info');
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audio');
      throw err;
    } finally {
      setPlayerState(prev => ({ ...prev, isLoading: false }));
    }
  };

  const playTrack = async (track: PlaylistTrack, index?: number) => {
    setCurrentTrack(track);
    setLoadingTrackId(track.id);
    if (index !== undefined) setQueueCurrentIndex(index);
    setError('');
    try {
      await loadAudioFromUrl(track.url, track);
      // StreamingAudioPlayer.play() returns Promise<void>; others return void.
      const maybePromise = playerRef.current?.play();
      if (maybePromise instanceof Promise) await maybePromise;

      // Restore saved playback position for the same track
      try {
        const saved = JSON.parse(localStorage.getItem('flac_position') || 'null');
        if (saved && saved.trackId === track.id && saved.time > 0) {
          playerRef.current?.seek(saved.time);
        }
      } catch { /* no-op */ }

      setTimeout(loadStats, 500);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to play track';
      setError(message);
      addToast(`Playback failed: ${message}`, 'error');
      console.error('Failed to play track:', err);
    } finally {
      setLoadingTrackId(undefined);
    }
  };

  const loadCloudPlaylist = useCallback(async (playlistId: string) => {
    setIsLoadingPlaylists(true);
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
    } finally {
      setIsLoadingPlaylists(false);
    }
  }, [loader, library, addToast, playTrack]);

  const togglePlayback = useCallback(() => {
    if (playerState.isPlaying) { playerRef.current?.pause(); return; }
    if (queue.length === 0) { playerRef.current?.play(); return; }
    const initialIndex = queueCurrentIndex >= 0 ? queueCurrentIndex : 0;
    const initialTrack = queue[initialIndex];
    if (playerState.duration === 0 && initialTrack) { playTrack(initialTrack, initialIndex); return; }
    playerRef.current?.play();
  }, [playerState.isPlaying, playerState.duration, playTrack, queue, queueCurrentIndex]);

  const handleAutoAdvance = () => {
    handleQueueAutoAdvance(
      queue,
      queueCurrentIndex,
      shuffle,
      repeatMode,
      (track, index) => playTrack(track, index),
      () => playerRef.current?.play()
    );
  };

  // =============================================================================
  // Queue Management
  // =============================================================================

  const addToQueueFn = (track: PlaylistTrack) => {
    setQueue(prev => addTrackToQueue(prev, track));
    addToast('Added to queue', 'success');
  };

  const playAll = (tracks: PlaylistTrack[], shuffled = false) => {
    if (tracks.length === 0) return;
    const ordered = shuffled ? [...tracks].sort(() => Math.random() - 0.5) : tracks;
    setQueue(ordered);
    setQueueCurrentIndex(0);
    playTrack(ordered[0], 0);
    addToast(shuffled ? `Shuffling ${ordered.length} tracks` : `Playing ${ordered.length} tracks`, 'success');
  };

  const addAllToQueue = (tracks: PlaylistTrack[]) => {
    if (tracks.length === 0) return;
    setQueue(prev => {
      const existingIds = new Set(prev.map(t => t.id));
      const newTracks = tracks.filter(t => !existingIds.has(t.id));
      return [...prev, ...newTracks];
    });
    addToast(`Added ${tracks.length} tracks to queue`, 'success');
  };

  const toggleMute = useCallback(() => {
    setMuted(prev => {
      if (!prev) {
        prevVolumeRef.current = volume;
        playerRef.current?.setVolume(0);
      } else {
        playerRef.current?.setVolume(prevVolumeRef.current);
      }
      return !prev;
    });
  }, [volume]);

  const playNow = (track: PlaylistTrack) => {
    setQueue([track]); setQueueCurrentIndex(0); playTrack(track, 0);
    addToast('Playing now: ' + (track.title || track.name), 'info');
  };

  const playNext = (track: PlaylistTrack) => {
    const { queue: newQueue } = playNextTrack(queue, track, queueCurrentIndex);
    setQueue(newQueue);
    addToast('Playing next: ' + (track.title || track.name), 'success');
  };

  const removeFromQueueFn = (index: number) => {
    setQueue(prev => {
      const newQueue = removeFromQueueUtil(prev, index);
      if (index < queueCurrentIndex) setQueueCurrentIndex(prev => prev - 1);
      return newQueue;
    });
  };

  const reorderQueue = (startIndex: number, endIndex: number) => {
    if (startIndex === endIndex) return;
    setQueue(prev => {
      const next = [...prev];
      const [removed] = next.splice(startIndex, 1);
      next.splice(endIndex, 0, removed);
      return next;
    });
    setQueueCurrentIndex(prev => reorderQueueIndex(prev, startIndex, endIndex));
  };

  const clearQueueFn = () => {
    setQueue([]);
    setQueueCurrentIndex(-1);
    clearQueueStorage();
  };

  const handleSmartMix = async () => {
    if (!currentTrack?.tags) {
      addToast('No tags to base mix on', 'error');
      return;
    }
    try {
      const similar = await loader.findSimilarTracks(currentTrack.id, currentTrack.tags, 4, 20);
      if (similar.length > 0) {
        setQueue(prev => {
          const newTracks = similar.filter(t => !prev.some(p => p.id === t.id));
          return [...prev, ...newTracks];
        });
        addToast(`Added ${similar.length} tracks to queue`, 'success');
      } else {
        addToast('No similar tracks found', 'info');
      }
    } catch {
      addToast('Failed to create smart mix', 'error');
    }
  };

  // =============================================================================
  // Track Updates
  // =============================================================================

  const updateTrack = async (id: string, updates: Partial<PlaylistTrack>) => {
    try {
      await loader.updateSampleMetadata(id, updates);
      setLibrary(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t));
      if (currentTrack?.id === id) setCurrentTrack(prev => prev ? { ...prev, ...updates } : null);
      loadTags(); loadStats();
      addToast('Changes saved', 'success');
    } catch {
      addToast('Failed to save changes', 'error');
      throw new Error('Failed to save changes');
    }
  };

  const generateShareLink = async () => {
    if (queue.length === 0) {
      addToast('Add tracks to the queue first.', 'info');
      return;
    }
    const trackIds = queue.map(t => t.id).filter(Boolean);
    if (trackIds.length === 0) {
      addToast('No valid tracks to share.', 'info');
      return;
    }
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

  const trashTrack = async (id: string) => {
    try {
      await loader.trashTrack(id);
      setLibrary(prev => prev.filter(t => t.id !== id));
      loadStats();
      addToast('Moved to trash', 'success');
    } catch {
      addToast('Failed to trash track', 'error');
    }
  };

  // =============================================================================
  // Keyboard Shortcuts
  // =============================================================================

  useKeyboardShortcuts({
    onPlayPause: togglePlayback,
    onSeekForward:  () => { if (playerRef.current) playerRef.current.seek(Math.min(playerState.currentTime + 10, playerState.duration)); },
    onSeekBackward: () => { if (playerRef.current) playerRef.current.seek(Math.max(playerState.currentTime - 10, 0)); },
    onNext:     () => { if (queue.length > 0 && queueCurrentIndex < queue.length - 1) playTrack(queue[queueCurrentIndex + 1], queueCurrentIndex + 1); },
    onPrevious: () => { if (queue.length > 0 && queueCurrentIndex > 0) playTrack(queue[queueCurrentIndex - 1], queueCurrentIndex - 1); },
    onSearchFocus: () => searchInputRef.current?.focus(),
    onVolumeUp:   () => { if (!muted) { setVolume(prev => { const next = Math.min(1, prev + 0.1); playerRef.current?.setVolume(next); return next; }); } },
    onVolumeDown: () => { if (!muted) { setVolume(prev => { const next = Math.max(0, prev - 0.1); playerRef.current?.setVolume(next); return next; }); } },
    onToggleQueue: () => setShowQueue(prev => !prev),
    onMute: toggleMute,
    onShowHelp: () => setShowHelp(prev => !prev),
    isEnabled: true
  });

  // Window-level drag-and-drop for ShaderGUI mode
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        setIsDraggingFile(true);
      }
    };
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setIsDraggingFile(false);
    };
    const onDrop = (e: DragEvent) => {
      setIsDraggingFile(false);
      if (!e.dataTransfer) return;
      const files = Array.from(e.dataTransfer.files).filter(
        f => f.name.endsWith('.flac') || f.name.endsWith('.wav') || f.type.includes('audio')
      );
      if (files.length > 0) {
        e.preventDefault();
        handleLocalFiles(files);
      }
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

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // =============================================================================
  // Render — default ShaderGUI mode
  // =============================================================================

  if (!showHtmlFallback) {
    return (
      <>
        <ToastContainer toasts={toasts} onRemove={removeToast} />
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
        <ShaderGUI
          analyser={playerRef.current?.getAnalyser() || null}
          currentTrack={currentTrack}
          queue={queue}
          queueCurrentIndex={queueCurrentIndex}
          isPlaying={playerState.isPlaying}
          isLoading={playerState.isLoading}
          currentTime={playerState.currentTime}
          duration={playerState.duration}
          volume={volume}
          muted={muted}
          onPlay={togglePlayback}
          onStop={() => playerRef.current?.stop()}
          onSeek={(t) => playerRef.current?.seek(t)}
          onTrackClick={(index) => playTrack(queue[index], index)}
          onVolumeChange={(vol) => { setMuted(false); setVolume(vol); playerRef.current?.setVolume(vol); }}
          onMute={toggleMute}
          onNext={() => { if (queue.length > 0 && queueCurrentIndex < queue.length - 1) playTrack(queue[queueCurrentIndex + 1], queueCurrentIndex + 1); }}
          onPrevious={() => { if (queue.length > 0 && queueCurrentIndex > 0) playTrack(queue[queueCurrentIndex - 1], queueCurrentIndex - 1); }}
          onToggleFallback={() => setShowHtmlFallback(true)}
          showFallbackToggle={!isSharedPlaylist}
        />
      </>
    );
  }

  // =============================================================================
  // Render — HTML fallback mode
  // =============================================================================

  return (
    <div className="player min-h-screen bg-[#0f0f1e] text-white flex flex-col">
      <ToastContainer toasts={toasts} onRemove={removeToast} />
      {showHelp && <KeyboardHelpModal onClose={() => setShowHelp(false)} />}

      {backendStatus === 'down' && (
        <div className="bg-red-500/20 border-b border-red-500/30 px-6 py-3 text-center">
          <p className="text-red-300 text-sm">
            Music library server is temporarily unavailable.
            <button onClick={() => checkBackend().then(h => h && loadLibrary())} className="ml-2 underline hover:text-red-200">Retry</button>
          </p>
        </div>
      )}

      <QueuePanel
        queue={queue} currentIndex={queueCurrentIndex} isOpen={showQueue}
        onClose={() => setShowQueue(false)}
        onTrackClick={(index) => playTrack(queue[index], index)}
        onRemoveTrack={removeFromQueueFn} onClearQueue={clearQueueFn}
        onShuffle={() => setShuffle(s => !s)} onSmartMix={handleSmartMix}
        onShareQueue={generateShareLink} onReorderQueue={reorderQueue}
        shuffle={shuffle} repeatMode={repeatMode}
        onToggleRepeat={() => setRepeatMode(m => m === 'off' ? 'all' : m === 'all' ? 'one' : 'off')}
      />

      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-white/10 bg-[#0f0f1e]/95 backdrop-blur">
        <div className="flex items-center gap-4">
          <button onClick={() => setShowHtmlFallback(false)} className="px-4 py-2 bg-purple-500 text-white rounded hover:bg-purple-600 transition-colors text-sm font-bold tracking-wider">
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
          <button onClick={() => setShowHelp(true)} className="px-3 py-2 bg-white/10 text-white rounded-lg hover:bg-white/20 transition-colors text-sm" title="Keyboard shortcuts (?)">⌨️ ?</button>
          <button onClick={() => setShowQueue(true)} className="relative px-4 py-2 bg-white/10 text-white rounded-lg hover:bg-white/20 transition-colors text-sm">
            📋 Queue
            {queue.length > 0 && <span className="absolute -top-1 -right-1 w-5 h-5 bg-purple-500 rounded-full text-xs flex items-center justify-center">{queue.length}</span>}
          </button>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <aside className="w-64 border-r border-white/10 bg-[#0a0a18] flex flex-col">
          <nav className="p-4 space-y-1">
            {[
              { id: 'library',     label: '📚 Library',    count: library.length },
              { id: 'now-playing', label: '▶️ Now Playing' },
              { id: 'queue',       label: '📋 Queue',      count: queue.length },
              { id: 'playlists',   label: '☁️ Playlists',  count: playlists.length }
            ].map(tab => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id as ViewTab)}
                className={`w-full flex items-center justify-between px-4 py-2 rounded-lg text-left transition-colors ${
                  activeTab === tab.id ? 'bg-purple-500/20 text-purple-300' : 'text-gray-400 hover:bg-white/5 hover:text-white'
                }`}
              >
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
            <FileDropZone onFiles={handleLocalFiles} />
          </div>
        </aside>

        {/* Main Area */}
        <main className="flex-1 flex flex-col overflow-hidden">
          {activeTab === 'library' && (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="flex items-center justify-between px-6 py-3 border-b border-white/10">
                <div className="flex items-center gap-2">
                  <button onClick={() => setLibraryViewMode('grid')} className={`p-2 rounded ${libraryViewMode === 'grid' ? 'bg-white/20' : 'hover:bg-white/10'}`}>⊞ Grid</button>
                  <button onClick={() => setLibraryViewMode('list')} className={`p-2 rounded ${libraryViewMode === 'list' ? 'bg-white/20' : 'hover:bg-white/10'}`}>☰ List</button>
                  <div className="w-px h-5 bg-white/20 mx-1" />
                  <button
                    onClick={() => playAll(library)}
                    disabled={library.length === 0}
                    className="px-3 py-1.5 text-xs bg-purple-500/20 text-purple-300 rounded hover:bg-purple-500/30 disabled:opacity-40 transition-colors"
                    title="Clear queue and play all visible tracks"
                  >⏵ Play All ({library.length})</button>
                  <button
                    onClick={() => playAll(library, true)}
                    disabled={library.length === 0}
                    className="px-3 py-1.5 text-xs bg-purple-500/20 text-purple-300 rounded hover:bg-purple-500/30 disabled:opacity-40 transition-colors"
                    title="Clear queue and shuffle all visible tracks"
                  >🔀 Shuffle All</button>
                  <button
                    onClick={() => addAllToQueue(library)}
                    disabled={library.length === 0}
                    className="px-3 py-1.5 text-xs bg-white/10 text-gray-300 rounded hover:bg-white/20 disabled:opacity-40 transition-colors"
                    title="Add all visible tracks to queue (skip duplicates)"
                  >➕ Add All</button>
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
                tracks={library} allTags={allTags} stats={stats}
                currentTrackId={currentTrack?.id} loadingTrackId={loadingTrackId}
                isPlaying={playerState.isPlaying} viewMode={libraryViewMode}
                onTrackClick={(track) => { addToQueueFn(track); playTrack(track, queue.length); }}
                onTrackDoubleClick={playNow} onUpdateTrack={updateTrack} onTrashTrack={trashTrack}
                onPlayNow={playNow} onPlayNext={playNext} onAddToQueue={addToQueueFn}
                isLoading={isLoadingLibrary}
              />
            </div>
          )}

          {activeTab === 'now-playing' && (
            <div className="flex-1 flex items-center justify-center p-6 overflow-auto">
              <ShaderGUI
                analyser={playerRef.current?.getAnalyser() || null}
                currentTrack={currentTrack} queue={queue} queueCurrentIndex={queueCurrentIndex}
                isPlaying={playerState.isPlaying} isLoading={playerState.isLoading}
                currentTime={playerState.currentTime} duration={playerState.duration} volume={volume}
                muted={muted}
                onPlay={togglePlayback} onStop={() => playerRef.current?.stop()}
                onSeek={(t) => playerRef.current?.seek(t)}
                onTrackClick={(index) => playTrack(queue[index], index)}
                onVolumeChange={(vol) => { setMuted(false); setVolume(vol); playerRef.current?.setVolume(vol); }}
                onMute={toggleMute}
                onNext={() => { if (queue.length > 0 && queueCurrentIndex < queue.length - 1) playTrack(queue[queueCurrentIndex + 1], queueCurrentIndex + 1); }}
                onPrevious={() => { if (queue.length > 0 && queueCurrentIndex > 0) playTrack(queue[queueCurrentIndex - 1], queueCurrentIndex - 1); }}
              />
            </div>
          )}

          {activeTab === 'queue' && (
            <div className="flex-1 overflow-auto p-6">
              <QueuePanel
                queue={queue} currentIndex={queueCurrentIndex} loadingTrackId={loadingTrackId}
                isOpen={true} onClose={() => {}}
                onTrackClick={(index) => playTrack(queue[index], index)}
                onRemoveTrack={removeFromQueueFn} onClearQueue={clearQueueFn}
                onShuffle={() => setShuffle(s => !s)} onSmartMix={handleSmartMix}
                onShareQueue={generateShareLink} onReorderQueue={reorderQueue}
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
                  <button onClick={loadPlaylists} disabled={isLoadingPlaylists}
                    className="px-4 py-2 bg-purple-500/20 text-purple-300 rounded-lg hover:bg-purple-500/30 disabled:opacity-50">
                    {isLoadingPlaylists ? 'Loading...' : '🔄 Refresh'}
                  </button>
                </div>
                {playlists.length === 0 && !isLoadingPlaylists && (
                  <div className="text-gray-400 text-center py-12">
                    <p>No playlists found.</p>
                    <p className="text-sm mt-2">Create playlists in cloud_notes to see them here.</p>
                  </div>
                )}
                <div className="space-y-2">
                  {playlists.map(playlist => (
                    <div key={playlist.id} onClick={() => loadCloudPlaylist(playlist.id)}
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
        </main>
      </div>

      {/* Player Bar */}
      <footer className="border-t border-white/10 bg-[#0a0a18] px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="w-1/3 flex items-center gap-3">
            {currentTrack && (
              <MetadataPanel
                file={currentFile}
                audioUrl={currentTrack.url}
              />
            )}
          </div>

          <div className="w-1/3 flex flex-col items-center">
            <div className="flex items-center gap-4 mb-2">
              <button onClick={() => { if (queue.length > 0 && queueCurrentIndex > 0) playTrack(queue[queueCurrentIndex - 1], queueCurrentIndex - 1); }}
                className="text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                disabled={queueCurrentIndex <= 0 || playerState.isLoading}
                aria-label="Previous track">⏮</button>
              <button onClick={togglePlayback} disabled={playerState.isLoading}
                className="w-12 h-12 bg-white text-black rounded-full flex items-center justify-center text-xl hover:scale-105 transition-transform disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label={playerState.isPlaying ? 'Pause' : 'Play'}>
                {playerState.isLoading ? <div className="spinner" style={{ borderTopColor: '#000' }} /> : playerState.isPlaying ? '⏸' : '▶'}
              </button>
              <button onClick={() => { if (queue.length > 0 && queueCurrentIndex < queue.length - 1) playTrack(queue[queueCurrentIndex + 1], queueCurrentIndex + 1); }}
                className="text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                disabled={queueCurrentIndex >= queue.length - 1 || playerState.isLoading}
                aria-label="Next track">⏭</button>
            </div>
            <div className="w-full max-w-md flex items-center gap-3">
              <span className="text-xs text-gray-400 w-10 text-right" aria-label="Elapsed time">{formatTime(playerState.currentTime)}</span>
              <input type="range" min={0} max={playerState.duration || 0} value={playerState.currentTime}
                onChange={(e) => playerRef.current?.seek(parseFloat(e.target.value))}
                className="flex-1 h-1 bg-white/20 rounded-lg appearance-none cursor-pointer"
                aria-label="Seek position" />
              <span className="text-xs text-gray-400 w-10" aria-label="Remaining time">-{formatTime(Math.max(0, playerState.duration - playerState.currentTime))}</span>
            </div>
          </div>

          <div className="w-1/3 flex items-center justify-end gap-4">
            <button onClick={() => setShuffle(s => !s)} className={`text-sm ${shuffle ? 'text-purple-400' : 'text-gray-400'}`} title="Shuffle" aria-label="Toggle shuffle" aria-pressed={shuffle}>🔀</button>
            <button onClick={() => setRepeatMode(m => m === 'off' ? 'all' : m === 'all' ? 'one' : 'off')}
              className={`text-sm ${repeatMode !== 'off' ? 'text-purple-400' : 'text-gray-400'}`} title={`Repeat: ${repeatMode}`}
              aria-label={`Repeat mode: ${repeatMode}`} aria-pressed={repeatMode !== 'off'}>
              {repeatMode === 'one' ? '🔂' : '🔁'}
            </button>
            <button
              onClick={toggleMute}
              className={`text-sm ${muted ? 'text-yellow-400' : 'text-gray-400'} hover:text-white transition-colors`}
              title={muted ? 'Unmute (M)' : 'Mute (M)'}
              aria-label={muted ? 'Unmute' : 'Mute'}
              aria-pressed={muted}
            >
              {muted ? '🔇' : '🔊'}
            </button>
            <select value={outputMode} onChange={(e) => setOutputMode(e.target.value as AudioOutputMode)}
              className="px-3 py-1 bg-white/10 rounded text-sm"
              aria-label="Audio output mode">
              <option value="streaming">Streaming (default)</option>
              <option value="web-audio">Web Audio (buffered)</option>
              <option value="worklet">AudioWorklet</option>
              <option value="sdl">SDL3</option>
              <option value="sdl2">SDL2</option>
            </select>
            <span className="text-xs text-gray-400 w-12 text-right">{muted ? '🔇 0%' : `${Math.round(volume * 100)}%`}</span>
          </div>
        </div>
        {error && <div className="mt-2 text-center text-red-400 text-sm">{error}</div>}
      </footer>
    </div>
  );
};
