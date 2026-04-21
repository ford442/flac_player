import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { AudioPlayer, PlayerState } from '../audioPlayer';
import { SdlAudioPlayer } from '../sdlAudioPlayer';
import { Sdl2AudioPlayer } from '../sdl2AudioPlayer';
import { AudioWorkletPlayer } from '../audioWorkletPlayer';
import { 
  AudioLoader, 
  PlaylistTrack, 
  SortBy, 
  RepeatMode, 
  LibraryStats, 
  TagInfo,
  saveQueueToStorage,
  loadQueueFromStorage,
  clearQueueStorage
} from '../audioLoader';

import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { LibraryView } from './LibraryView';
import { QueuePanel } from './QueuePanel';
import { ShaderGUI } from './ShaderGUI/ShaderGUI';
import './Player.css';

// =============================================================================
// Types & Constants
// =============================================================================

type AudioOutputMode = 'web-audio' | 'worklet' | 'sdl' | 'sdl2';
type ViewTab = 'library' | 'now-playing' | 'queue';
type LibraryViewMode = 'grid' | 'list';

const getSharedPlaylistId = (): string | null => {
  const params = new URLSearchParams(window.location.search);
  const queryShareId = params.get('share');

  if (queryShareId) {
    return queryShareId;
  }

  const pathMatch = window.location.pathname.match(/^\/playlist\/([^/]+)$/);
  return pathMatch ? decodeURIComponent(pathMatch[1]) : null;
};

// =============================================================================
// Toast Notification Component (Simple inline version)
// =============================================================================

interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
}

const ToastContainer: React.FC<{ toasts: Toast[]; onRemove: (id: string) => void }> = ({ toasts, onRemove }) => {
  useEffect(() => {
    toasts.forEach(toast => {
      setTimeout(() => onRemove(toast.id), 3000);
    });
  }, [toasts, onRemove]);
  
  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map(toast => (
        <div
          key={toast.id}
          className={`px-4 py-2 rounded-lg shadow-lg text-white text-sm animate-slide-in ${
            toast.type === 'success' ? 'bg-green-500' :
            toast.type === 'error' ? 'bg-red-500' : 'bg-blue-500'
          }`}
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
};

// =============================================================================
// Main Player Component
// =============================================================================

export const Player: React.FC = () => {
  const sharedPlaylistId = useMemo(() => getSharedPlaylistId(), []);
  const isSharedPlaylist = sharedPlaylistId !== null;

  // Player state
  const [playerState, setPlayerState] = useState<PlayerState>({
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    isLoading: false
  });
  const [error, setError] = useState<string>('');

  const [outputMode, setOutputMode] = useState<AudioOutputMode>('web-audio');
  
  // View state
  const [activeTab, setActiveTab] = useState<ViewTab>('library');
  const [libraryViewMode, setLibraryViewMode] = useState<LibraryViewMode>('grid');
  
  // Library state
  const [library, setLibrary] = useState<PlaylistTrack[]>([]);
  const [allTags, setAllTags] = useState<TagInfo[]>([]);
  const [stats, setStats] = useState<LibraryStats>({
    total_tracks: 0,
    rated_4plus: 0,
    total_duration_hours: 0,
    total_play_count: 0,
    untagged_count: 0,
    trash_count: 0,
    unique_tags: 0,
    top_tags: []
  });
  const [isLoadingLibrary, setIsLoadingLibrary] = useState(false);
  
  // Filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [minRating, setMinRating] = useState<number>(1);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [untaggedOnly, setUntaggedOnly] = useState(false);
  const [sortBy, setSortBy] = useState<SortBy>('date');
  const [volume, setVolume] = useState(1);
  
  // Queue state
  const [queue, setQueue] = useState<PlaylistTrack[]>([]);
  const [queueCurrentIndex, setQueueCurrentIndex] = useState<number>(-1);
  const [showQueue, setShowQueue] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [repeatMode, setRepeatMode] = useState<RepeatMode>('off');
  
  // Current track
  const [currentTrack, setCurrentTrack] = useState<PlaylistTrack | null>(null);
  
  // Toasts
  const [toasts, setToasts] = useState<Toast[]>([]);
  
  // View mode toggle
  const [showHtmlFallback, setShowHtmlFallback] = useState(false);
  
  // Refs
  const playerRef = useRef<AudioPlayer | AudioWorkletPlayer | SdlAudioPlayer | Sdl2AudioPlayer | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  
  const loader = useMemo(() => new AudioLoader(), []);
  type EndCallbackPlayer = {
    setOnEndedCallback?: (callback?: () => void) => void;
  };
  
  // =============================================================================
  // Toast Helpers
  // =============================================================================
  
  const addToast = useCallback((message: string, type: Toast['type'] = 'info') => {
    const id = Math.random().toString(36).substring(7);
    setToasts(prev => [...prev, { id, message, type }]);
  }, []);
  
  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);
  
  // =============================================================================
  // Data Loading
  // =============================================================================
  
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
    } catch (err) {
      setError('Failed to load library');
      console.error(err);
    } finally {
      setIsLoadingLibrary(false);
    }
  }, [loader, minRating, selectedTags, untaggedOnly, searchQuery, sortBy]);
  
  const loadTags = useCallback(async () => {
    try {
      const tags = await loader.fetchTags();
      setAllTags(tags);
    } catch (err) {
      console.error('Failed to load tags:', err);
    }
  }, [loader]);
  
  const loadStats = useCallback(async () => {
    try {
      const s = await loader.fetchStats();
      setStats(s);
    } catch (err) {
      console.error('Failed to load stats:', err);
    }
  }, [loader]);
  
  useEffect(() => {
    if (isSharedPlaylist) {
      return;
    }

    loadLibrary();
  }, [isSharedPlaylist, loadLibrary]);
  
  useEffect(() => {
    if (isSharedPlaylist) {
      return;
    }

    loadTags();
    loadStats();
  }, [isSharedPlaylist, loadTags, loadStats]);
  
  // Load queue from storage or shared playlist
  useEffect(() => {
    const initializeApp = async () => {
      // 1. Check for URL-based playlist (Bypasses backend completely)
      const params = new URLSearchParams(window.location.search);
      const tracksParam = params.get('tracks');

      if (tracksParam) {
        try {
          const trackIds = tracksParam.split(',');
          // Fetch the library to match the IDs
          const { tracks: allTracks } = await loader.fetchLibrary({ limit: 500 });

          // Map the IDs from the URL to actual track objects
          const playlistTracks = trackIds
            .map(id => allTracks.find(t => t.id === id))
            .filter(Boolean) as PlaylistTrack[];

          if (playlistTracks.length > 0) {
            setQueue(playlistTracks);
            setQueueCurrentIndex(0);
            setActiveTab('now-playing');
            addToast('Loaded custom playlist!', 'success');

            // Clean up the URL so refreshing doesn't loop
            window.history.replaceState({}, '', window.location.pathname);
            return; // Exit so we don't load local storage
          }
        } catch (err) {
          console.error('Failed to load URL playlist', err);
        }
      }

      // 2. Fallback to Local Storage Queue
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
  
  // Save queue to storage
  useEffect(() => {
    if (isSharedPlaylist) {
      return;
    }

    saveQueueToStorage({ tracks: queue, currentIndex: queueCurrentIndex, shuffle, repeat: repeatMode });
  }, [isSharedPlaylist, queue, queueCurrentIndex, shuffle, repeatMode]);
  
  // =============================================================================
  // Player Initialization
  // =============================================================================
  
  useEffect(() => {
    let player: AudioPlayer | AudioWorkletPlayer | SdlAudioPlayer | Sdl2AudioPlayer;
    if (outputMode === 'worklet') {
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
    
    (player as EndCallbackPlayer).setOnEndedCallback?.(() => {
      handleAutoAdvance();
    });

    playerRef.current = player;

    return () => {
      (player as EndCallbackPlayer).setOnEndedCallback?.(undefined);
      player.destroy();
    };
  }, [outputMode]);
  
  // =============================================================================
  // Playback Controls
  // =============================================================================
  
  const loadAudioFromUrl = async (url: string, track?: PlaylistTrack) => {
    if (!url.trim() || !playerRef.current) return;

    setPlayerState(prev => ({ ...prev, isLoading: true }));
    setError('');

    try {
      const arrayBuffer = await loader.loadFromURL(url);
      await playerRef.current.loadAudio(arrayBuffer);
      
      if (track) {
        setCurrentTrack(track);
        // Record play
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
    try {
      await loadAudioFromUrl(track.url, track);
      playerRef.current?.play();
      
      if (index !== undefined) {
        setQueueCurrentIndex(index);
      }
      
      // Update stats after a short delay
      setTimeout(loadStats, 500);
    } catch (err) {
      console.error('Failed to play track:', err);
    }
  };

  const togglePlayback = useCallback(() => {
    if (playerState.isPlaying) {
      playerRef.current?.pause();
      return;
    }

    if (queue.length === 0) {
      playerRef.current?.play();
      return;
    }

    const initialIndex = queueCurrentIndex >= 0 ? queueCurrentIndex : 0;
    const initialTrack = queue[initialIndex];

    if (playerState.duration === 0 && initialTrack) {
      playTrack(initialTrack, initialIndex);
      return;
    }

    playerRef.current?.play();
  }, [playerState.isPlaying, playerState.duration, playTrack, queue, queueCurrentIndex]);
  
  const handleAutoAdvance = () => {
    if (queue.length === 0) return;
    
    if (repeatMode === 'one') {
      playerRef.current?.play();
      return;
    }
    
    let nextIndex: number;
    
    if (shuffle) {
      if (queue.length === 1) {
        nextIndex = 0;
      } else {
        do {
          nextIndex = Math.floor(Math.random() * queue.length);
        } while (nextIndex === queueCurrentIndex && queue.length > 1);
      }
    } else {
      nextIndex = queueCurrentIndex + 1;
      if (nextIndex >= queue.length) {
        if (repeatMode === 'all') {
          nextIndex = 0;
        } else {
          return; // Stop at end
        }
      }
    }
    
    const nextTrack = queue[nextIndex];
    if (nextTrack) {
      playTrack(nextTrack, nextIndex);
    }
  };
  
  // =============================================================================
  // Queue Management
  // =============================================================================
  
  const addToQueue = (track: PlaylistTrack) => {
    setQueue(prev => {
      if (prev.some(t => t.id === track.id)) return prev;
      return [...prev, track];
    });
    addToast('Added to queue', 'success');
  };

  const playNow = (track: PlaylistTrack) => {
    setQueue([track]);
    setQueueCurrentIndex(0);
    playTrack(track, 0);
    addToast('Playing now: ' + (track.title || track.name), 'info');
  };

  const playNext = (track: PlaylistTrack) => {
    setQueue(prev => {
      if (prev.some(t => t.id === track.id)) return prev;
      const insertAt = queueCurrentIndex >= 0 ? queueCurrentIndex + 1 : prev.length;
      const next = [...prev];
      next.splice(insertAt, 0, track);
      return next;
    });
    addToast('Playing next: ' + (track.title || track.name), 'success');
  };

  const removeFromQueue = (index: number) => {
    setQueue(prev => prev.filter((_, i) => i !== index));
    if (index < queueCurrentIndex) {
      setQueueCurrentIndex(prev => prev - 1);
    }
  };

  const reorderQueue = (startIndex: number, endIndex: number) => {
    if (startIndex === endIndex) return;
    setQueue(prev => {
      const next = [...prev];
      const [removed] = next.splice(startIndex, 1);
      next.splice(endIndex, 0, removed);
      return next;
    });
    setQueueCurrentIndex(prev => {
      if (prev === -1) return -1;
      if (prev === startIndex) return endIndex;
      if (startIndex < endIndex) {
        if (prev > startIndex && prev <= endIndex) return prev - 1;
      } else {
        if (prev >= endIndex && prev < startIndex) return prev + 1;
      }
      return prev;
    });
  };
  
  const clearQueue = () => {
    setQueue([]);
    setQueueCurrentIndex(-1);
    clearQueueStorage();
  };
  
  const handleSmartMix = async () => {
    if (!currentTrack || !currentTrack.tags) {
      addToast('No tags to base mix on', 'error');
      return;
    }
    
    try {
      const similar = await loader.findSimilarTracks(
        currentTrack.id,
        currentTrack.tags,
        4,
        20
      );
      
      if (similar.length > 0) {
        setQueue(prev => {
          const newTracks = similar.filter(t => !prev.some(p => p.id === t.id));
          return [...prev, ...newTracks];
        });
        addToast(`Added ${similar.length} tracks to queue`, 'success');
      } else {
        addToast('No similar tracks found', 'info');
      }
    } catch (err) {
      addToast('Failed to create smart mix', 'error');
    }
  };
  
  // =============================================================================
  // Track Updates
  // =============================================================================
  
  const updateTrack = async (id: string, updates: Partial<PlaylistTrack>) => {
    try {
      await loader.updateSampleMetadata(id, updates);
      
      // Update local state
      setLibrary(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t));
      if (currentTrack?.id === id) {
        setCurrentTrack(prev => prev ? { ...prev, ...updates } : null);
      }
      
      // Refresh tags and stats
      loadTags();
      loadStats();
      
      addToast('Changes saved', 'success');
    } catch (err) {
      addToast('Failed to save changes', 'error');
      throw err;
    }
  };
  
  const generateShareLink = async () => {
    if (queue.length === 0) {
      addToast('Add tracks to the queue first.', 'info');
      return;
    }

    // Get all IDs and join them with commas
    const trackIds = queue.map(t => t.id).filter(Boolean).join(',');

    // Build the frontend-only URL
    const frontendUrl = `${window.location.origin}${window.location.pathname}?tracks=${trackIds}`;

    try {
      await navigator.clipboard.writeText(frontendUrl);
      addToast('Playlist link copied to clipboard!', 'success');
    } catch (err) {
      console.error('Error copying playlist link to clipboard', err);
      addToast('Error copying link.', 'error');
    }
  };

  const trashTrack = async (id: string) => {
    try {
      await loader.trashTrack(id);
      setLibrary(prev => prev.filter(t => t.id !== id));
      loadStats();
      addToast('Moved to trash', 'success');
    } catch (err) {
      addToast('Failed to trash track', 'error');
    }
  };
  
  // =============================================================================
  // Keyboard Shortcuts
  // =============================================================================
  
  useKeyboardShortcuts({
    onPlayPause: togglePlayback,
    onSeekForward: () => {
      if (playerRef.current) {
        const newTime = Math.min(playerState.currentTime + 10, playerState.duration);
        playerRef.current.seek(newTime);
      }
    },
    onSeekBackward: () => {
      if (playerRef.current) {
        const newTime = Math.max(playerState.currentTime - 10, 0);
        playerRef.current.seek(newTime);
      }
    },
    onNext: () => {
      if (queue.length > 0 && queueCurrentIndex < queue.length - 1) {
        playTrack(queue[queueCurrentIndex + 1], queueCurrentIndex + 1);
      }
    },
    onPrevious: () => {
      if (queue.length > 0 && queueCurrentIndex > 0) {
        playTrack(queue[queueCurrentIndex - 1], queueCurrentIndex - 1);
      }
    },
    onSearchFocus: () => searchInputRef.current?.focus(),
    onVolumeUp: () => {
      setVolume(prev => {
        const next = Math.min(1, prev + 0.1);
        playerRef.current?.setVolume(next);
        return next;
      });
    },
    onVolumeDown: () => {
      setVolume(prev => {
        const next = Math.max(0, prev - 0.1);
        playerRef.current?.setVolume(next);
        return next;
      });
    },
    onToggleQueue: () => setShowQueue(prev => !prev),
    isEnabled: true
  });
  
  // =============================================================================
  // Render Helpers
  // =============================================================================
  
  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };
  
  // =============================================================================
  // Render
  // =============================================================================
  
  // Default GUI mode
  if (!showHtmlFallback) {
    return (
      <>
        <ToastContainer toasts={toasts} onRemove={removeToast} />
        <ShaderGUI
          analyser={playerRef.current?.getAnalyser() || null}
          currentTrack={currentTrack}
          queue={queue}
          queueCurrentIndex={queueCurrentIndex}
          isPlaying={playerState.isPlaying}
          currentTime={playerState.currentTime}
          duration={playerState.duration}
          volume={volume}
          onPlay={togglePlayback}
          onStop={() => {
            playerRef.current?.stop();
          }}
          onTrackClick={(index) => playTrack(queue[index], index)}
          onVolumeChange={(vol) => {
            setVolume(vol);
            playerRef.current?.setVolume(vol);
          }}
          onNext={() => {
            if (queue.length > 0 && queueCurrentIndex < queue.length - 1) {
              playTrack(queue[queueCurrentIndex + 1], queueCurrentIndex + 1);
            }
          }}
          onPrevious={() => {
            if (queue.length > 0 && queueCurrentIndex > 0) {
              playTrack(queue[queueCurrentIndex - 1], queueCurrentIndex - 1);
            }
          }}
          onToggleFallback={() => setShowHtmlFallback(true)}
          showFallbackToggle={!isSharedPlaylist}
        />
      </>
    );
  }
  
  // HTML Fallback mode
  return (
    <div className="player min-h-screen bg-[#0f0f1e] text-white flex flex-col">
      <ToastContainer toasts={toasts} onRemove={removeToast} />
      
      {/* Queue Panel */}
      <QueuePanel
        queue={queue}
        currentIndex={queueCurrentIndex}
        isOpen={showQueue}
        onClose={() => setShowQueue(false)}
        onTrackClick={(index) => playTrack(queue[index], index)}
        onRemoveTrack={removeFromQueue}
        onClearQueue={clearQueue}
        onShuffle={() => setShuffle(s => !s)}
        onSmartMix={handleSmartMix}
        onShareQueue={generateShareLink}
        onReorderQueue={reorderQueue}
        shuffle={shuffle}
        repeatMode={repeatMode}
        onToggleRepeat={() => setRepeatMode(m => m === 'off' ? 'all' : m === 'all' ? 'one' : 'off')}
      />
      
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-white/10 bg-[#0f0f1e]/95 backdrop-blur">
        <div className="flex items-center gap-4">
          <button
            onClick={() => setShowHtmlFallback(false)}
            className="px-4 py-2 bg-purple-500 text-white rounded hover:bg-purple-600 transition-colors text-sm font-bold tracking-wider"
          >
            ← Back to GUI Player
          </button>
          <h1 className="text-xl font-bold bg-gradient-to-r from-purple-400 to-blue-400 bg-clip-text text-transparent">
            🎵 FLAC Player
          </h1>
          
          {/* Stats */}
          <div className="hidden md:flex items-center gap-4 text-sm text-gray-400">
            <span>{stats.total_tracks} tracks</span>
            <span className="text-purple-400">{stats.rated_4plus} rated 4+</span>
            <span>{stats.total_duration_hours}h total</span>
          </div>
        </div>
        
        {/* Search */}
        <div className="flex-1 max-w-md mx-4">
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search tracks... (Ctrl+K)"
            className="w-full px-4 py-2 bg-white/10 border border-white/20 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-purple-500"
          />
        </div>
        
        {/* Actions */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowQueue(true)}
            className="relative px-4 py-2 bg-white/10 text-white rounded-lg hover:bg-white/20 transition-colors text-sm"
          >
            📋 Queue
            {queue.length > 0 && (
              <span className="absolute -top-1 -right-1 w-5 h-5 bg-purple-500 rounded-full text-xs flex items-center justify-center">
                {queue.length}
              </span>
            )}
          </button>
        </div>
      </header>
      
      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <aside className="w-64 border-r border-white/10 bg-[#0a0a18] flex flex-col">
          {/* Tabs */}
          <nav className="p-4 space-y-1">
            {[
              { id: 'library', label: '📚 Library', count: library.length },
              { id: 'now-playing', label: '▶️ Now Playing' },
              { id: 'queue', label: '📋 Queue', count: queue.length }
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as ViewTab)}
                className={`w-full flex items-center justify-between px-4 py-2 rounded-lg text-left transition-colors ${
                  activeTab === tab.id
                    ? 'bg-purple-500/20 text-purple-300'
                    : 'text-gray-400 hover:bg-white/5 hover:text-white'
                }`}
              >
                <span>{tab.label}</span>
                {tab.count !== undefined && (
                  <span className="text-xs bg-white/10 px-2 py-0.5 rounded-full">
                    {tab.count}
                  </span>
                )}
              </button>
            ))}
          </nav>
          
          {/* Filters */}
          <div className="p-4 border-t border-white/10 space-y-4">
            <div>
              <label className="text-xs text-gray-500 uppercase">Min Rating</label>
              <input
                type="range"
                min="0"
                max="5"
                step="1"
                value={minRating}
                onChange={(e) => setMinRating(parseInt(e.target.value))}
                className="w-full mt-1"
              />
              <div className="flex justify-between text-xs text-gray-400 mt-1">
                <span>Any</span>
                <span>{minRating}+ stars</span>
              </div>
            </div>
            
            <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
              <input
                type="checkbox"
                checked={untaggedOnly}
                onChange={(e) => setUntaggedOnly(e.target.checked)}
                className="rounded border-white/20 bg-white/10"
              />
              Untagged only
            </label>
            
            <div>
              <label className="text-xs text-gray-500 uppercase">Sort By</label>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortBy)}
                className="w-full mt-1 px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-sm"
              >
                <option value="date">Date Added</option>
                <option value="rating">Rating</option>
                <option value="name">Name</option>
                <option value="play_count">Play Count</option>
                <option value="last_played">Last Played</option>
                <option value="random">Random</option>
              </select>
            </div>
          </div>
          
          {/* Top Tags */}
          <div className="flex-1 p-4 border-t border-white/10 overflow-auto">
            <label className="text-xs text-gray-500 uppercase">Filter Tags</label>
            <div className="flex flex-wrap gap-1 mt-2">
              {allTags.slice(0, 15).map(tag => (
                <button
                  key={tag.name}
                  onClick={() => {
                    setSelectedTags(prev => 
                      prev.includes(tag.name)
                        ? prev.filter(t => t !== tag.name)
                        : [...prev, tag.name]
                    );
                  }}
                  className={`px-2 py-1 text-xs rounded-full transition-colors ${
                    selectedTags.includes(tag.name)
                      ? 'bg-purple-500 text-white'
                      : 'bg-white/10 text-gray-400 hover:bg-white/20'
                  }`}
                >
                  {tag.name} ({tag.count})
                </button>
              ))}
            </div>
          </div>
        </aside>
        
        {/* Main Area */}
        <main className="flex-1 flex flex-col overflow-hidden">
          {activeTab === 'library' && (
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* Library Toolbar */}
              <div className="flex items-center justify-between px-6 py-3 border-b border-white/10">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setLibraryViewMode('grid')}
                    className={`p-2 rounded ${libraryViewMode === 'grid' ? 'bg-white/20' : 'hover:bg-white/10'}`}
                  >
                    ⊞ Grid
                  </button>
                  <button
                    onClick={() => setLibraryViewMode('list')}
                    className={`p-2 rounded ${libraryViewMode === 'list' ? 'bg-white/20' : 'hover:bg-white/10'}`}
                  >
                    ☰ List
                  </button>
                </div>

                {selectedTags.length > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-gray-400">Filtered by:</span>
                    {selectedTags.map(tag => (
                      <button
                        key={tag}
                        onClick={() => setSelectedTags(prev => prev.filter(t => t !== tag))}
                        className="px-2 py-1 text-xs bg-purple-500/30 text-purple-200 rounded-full hover:bg-purple-500/50"
                      >
                        {tag} ×
                      </button>
                    ))}
                    <button
                      onClick={() => setSelectedTags([])}
                      className="text-xs text-gray-500 hover:text-white"
                    >
                      Clear
                    </button>
                  </div>
                )}
              </div>

              {/* Library View */}
              <LibraryView
                tracks={library}
                allTags={allTags}
                stats={stats}
                currentTrackId={currentTrack?.id}
                isPlaying={playerState.isPlaying}
                viewMode={libraryViewMode}
                onTrackClick={(track) => {
                  addToQueue(track);
                  playTrack(track, queue.length);
                }}
                onTrackDoubleClick={playNow}
                onUpdateTrack={updateTrack}
                onTrashTrack={trashTrack}
                onPlayNow={playNow}
                onPlayNext={playNext}
                onAddToQueue={addToQueue}
                isLoading={isLoadingLibrary}
              />
            </div>
          )}
          
          {activeTab === 'now-playing' && (
            <div className="flex-1 flex items-center justify-center p-6 overflow-auto">
              <ShaderGUI
                analyser={playerRef.current?.getAnalyser() || null}
                currentTrack={currentTrack}
                queue={queue}
                queueCurrentIndex={queueCurrentIndex}
                isPlaying={playerState.isPlaying}
                currentTime={playerState.currentTime}
                duration={playerState.duration}
                volume={volume}
                onPlay={togglePlayback}
                onStop={() => {
                  playerRef.current?.stop();
                }}
                onTrackClick={(index) => playTrack(queue[index], index)}
                onVolumeChange={(vol) => {
                  setVolume(vol);
                  playerRef.current?.setVolume(vol);
                }}
              />
            </div>
          )}
          
          {activeTab === 'queue' && (
            <div className="flex-1 overflow-auto p-6">
              <QueuePanel
                queue={queue}
                currentIndex={queueCurrentIndex}
                isOpen={true}
                onClose={() => {}}
                onTrackClick={(index) => playTrack(queue[index], index)}
                onRemoveTrack={removeFromQueue}
                onClearQueue={clearQueue}
                onShuffle={() => setShuffle(s => !s)}
                onSmartMix={handleSmartMix}
                onShareQueue={generateShareLink}
                onReorderQueue={reorderQueue}
                shuffle={shuffle}
                repeatMode={repeatMode}
                onToggleRepeat={() => setRepeatMode(m => m === 'off' ? 'all' : m === 'all' ? 'one' : 'off')}
              />
            </div>
          )}
        </main>
        
        {/* Visualizer sidebar removed — ShaderGUI handles its own WebGPU canvas */}
      </div>
      
      {/* Player Bar */}
      <footer className="border-t border-white/10 bg-[#0a0a18] px-6 py-4">
        <div className="flex items-center justify-between">
          {/* Track Info */}
          <div className="w-1/3 flex items-center gap-3">
            {currentTrack && (
              <>
                <div className="w-12 h-12 bg-gradient-to-br from-purple-600 to-blue-600 rounded flex items-center justify-center">
                  🎵
                </div>
                <div className="min-w-0">
                  <div className="font-medium truncate">{currentTrack.title || currentTrack.name}</div>
                  <div className="text-sm text-gray-400 truncate">{currentTrack.author}</div>
                </div>
              </>
            )}
          </div>
          
          {/* Controls */}
          <div className="w-1/3 flex flex-col items-center">
            <div className="flex items-center gap-4 mb-2">
              <button
                onClick={() => {
                  if (queue.length > 0 && queueCurrentIndex > 0) {
                    playTrack(queue[queueCurrentIndex - 1], queueCurrentIndex - 1);
                  }
                }}
                className="text-gray-400 hover:text-white"
                disabled={queueCurrentIndex <= 0}
              >
                ⏮
              </button>
              <button
                onClick={togglePlayback}
                className="w-12 h-12 bg-white text-black rounded-full flex items-center justify-center text-xl hover:scale-105 transition-transform"
              >
                {playerState.isPlaying ? '⏸' : '▶'}
              </button>
              <button
                onClick={() => {
                  if (queue.length > 0 && queueCurrentIndex < queue.length - 1) {
                    playTrack(queue[queueCurrentIndex + 1], queueCurrentIndex + 1);
                  }
                }}
                className="text-gray-400 hover:text-white"
                disabled={queueCurrentIndex >= queue.length - 1}
              >
                ⏭
              </button>
            </div>
            
            <div className="w-full max-w-md flex items-center gap-3">
              <span className="text-xs text-gray-400 w-10 text-right">
                {formatTime(playerState.currentTime)}
              </span>
              <input
                type="range"
                min={0}
                max={playerState.duration || 0}
                value={playerState.currentTime}
                onChange={(e) => playerRef.current?.seek(parseFloat(e.target.value))}
                className="flex-1 h-1 bg-white/20 rounded-lg appearance-none cursor-pointer"
              />
              <span className="text-xs text-gray-400 w-10">
                {formatTime(playerState.duration)}
              </span>
            </div>
          </div>
          
          {/* Extra Controls */}
          <div className="w-1/3 flex items-center justify-end gap-4">
            <button
              onClick={() => setShuffle(s => !s)}
              className={`text-sm ${shuffle ? 'text-purple-400' : 'text-gray-400'}`}
              title="Shuffle"
            >
              🔀
            </button>
            <button
              onClick={() => setRepeatMode(m => m === 'off' ? 'all' : m === 'all' ? 'one' : 'off')}
              className={`text-sm ${repeatMode !== 'off' ? 'text-purple-400' : 'text-gray-400'}`}
              title={`Repeat: ${repeatMode}`}
            >
              {repeatMode === 'one' ? '🔂' : '🔁'}
            </button>
            
            {/* Audio Output Select */}
              <select
                value={outputMode}
                onChange={(e) => setOutputMode(e.target.value as AudioOutputMode)}
                className="px-3 py-1 bg-white/10 rounded text-sm"
              >
              <option value="web-audio">Web Audio</option>
              <option value="worklet">AudioWorklet</option>
              <option value="sdl">SDL3</option>
              <option value="sdl2">SDL2</option>
              </select>
              <span className="text-xs text-gray-400 w-12 text-right">{Math.round(volume * 100)}%</span>
            </div>
          </div>
        
        {error && (
          <div className="mt-2 text-center text-red-400 text-sm">{error}</div>
        )}
      </footer>
    </div>
  );
};
