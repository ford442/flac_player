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
import { WebGPUVisualizer, VisualizerMode } from '../webgpuVisualizer';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { LibraryView } from './LibraryView';
import { QueuePanel } from './QueuePanel';
import { PileMode } from './PileMode';
import { StarRating } from './StarRating';
import './Player.css';

// =============================================================================
// Types & Constants
// =============================================================================

type AudioOutputMode = 'web-audio' | 'worklet' | 'sdl' | 'sdl2';
type ViewTab = 'library' | 'now-playing' | 'queue';
type LibraryViewMode = 'grid' | 'list';

const API_BASE_URL = process.env.REACT_APP_API_URL || '';

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
  // Player state
  const [playerState, setPlayerState] = useState<PlayerState>({
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    isLoading: false
  });
  const [audioUrl, setAudioUrl] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [webGPUSupported, setWebGPUSupported] = useState<boolean>(true);
  const [visualizerMode, setVisualizerMode] = useState<VisualizerMode>('flat');
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
  const [sortDesc, setSortDesc] = useState(true);
  
  // Queue state
  const [queue, setQueue] = useState<PlaylistTrack[]>([]);
  const [queueCurrentIndex, setQueueCurrentIndex] = useState<number>(-1);
  const [showQueue, setShowQueue] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [repeatMode, setRepeatMode] = useState<RepeatMode>('off');
  
  // Pile mode
  const [showPileMode, setShowPileMode] = useState(false);
  
  // Current track
  const [currentTrack, setCurrentTrack] = useState<PlaylistTrack | null>(null);
  
  // Toasts
  const [toasts, setToasts] = useState<Toast[]>([]);
  
  // Refs
  const playerRef = useRef<AudioPlayer | AudioWorkletPlayer | SdlAudioPlayer | Sdl2AudioPlayer | null>(null);
  const visualizerRef = useRef<WebGPUVisualizer | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  
  const loader = useMemo(() => new AudioLoader(), []);
  
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
        sortDesc,
        limit: 200
      });
      setLibrary(tracks);
    } catch (err) {
      setError('Failed to load library');
      console.error(err);
    } finally {
      setIsLoadingLibrary(false);
    }
  }, [loader, minRating, selectedTags, untaggedOnly, searchQuery, sortBy, sortDesc]);
  
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
    loadLibrary();
  }, [loadLibrary]);
  
  useEffect(() => {
    loadTags();
    loadStats();
  }, [loadTags, loadStats]);
  
  // Load queue from storage
  useEffect(() => {
    const saved = loadQueueFromStorage();
    if (saved) {
      setQueue(saved.tracks);
      setQueueCurrentIndex(saved.currentIndex);
      setShuffle(saved.shuffle);
      setRepeatMode(saved.repeat);
    }
  }, []);
  
  // Save queue to storage
  useEffect(() => {
    saveQueueToStorage({ tracks: queue, currentIndex: queueCurrentIndex, shuffle, repeat });
  }, [queue, queueCurrentIndex, shuffle, repeat]);
  
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
    
    (player as any).setOnEndedCallback?.(() => {
      handleAutoAdvance();
    });

    playerRef.current = player;

    return () => {
      (player as any).setOnEndedCallback?.(undefined);
      player.destroy();
    };
  }, [outputMode]);
  
  useEffect(() => {
    const initVisualizer = async () => {
      if (!canvasRef.current || !playerRef.current) return;

      if (!visualizerRef.current) {
        const visualizer = new WebGPUVisualizer(canvasRef.current);
        visualizerRef.current = visualizer;
      }

      const analyser = playerRef.current.getAnalyser();
      const success = await visualizerRef.current.initialize(analyser);
      if (success) {
        visualizerRef.current.startAnimation();
        visualizerRef.current.setMode(visualizerMode);
        visualizerRef.current.setTogglePlayCallback(() => {
          if (playerRef.current) {
            const state = playerRef.current.getState();
            if (state.isPlaying) playerRef.current.pause();
            else if (state.duration > 0) playerRef.current.play();
          }
        });
      } else {
        setWebGPUSupported(false);
      }
    };

    initVisualizer();
  }, [outputMode, visualizerMode]);
  
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
  
  const removeFromQueue = (index: number) => {
    setQueue(prev => prev.filter((_, i) => i !== index));
    if (index < queueCurrentIndex) {
      setQueueCurrentIndex(prev => prev - 1);
    }
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
    onPlayPause: () => {
      if (playerState.isPlaying) playerRef.current?.pause();
      else playerRef.current?.play();
    },
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
    onToggleQueue: () => setShowQueue(prev => !prev),
    onTogglePile: () => setShowPileMode(true),
    isEnabled: !showPileMode
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
  
  return (
    <div className="player min-h-screen bg-[#0f0f1e] text-white flex flex-col">
      <ToastContainer toasts={toasts} onRemove={removeToast} />
      
      {/* Pile Mode Overlay */}
      <PileMode
        isActive={showPileMode}
        onClose={() => setShowPileMode(false)}
        onTrackRated={() => {
          loadLibrary();
          loadStats();
        }}
        stats={stats}
      />
      
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
        shuffle={shuffle}
        repeatMode={repeatMode}
        onToggleRepeat={() => setRepeatMode(m => m === 'off' ? 'all' : m === 'all' ? 'one' : 'off')}
      />
      
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-white/10 bg-[#0f0f1e]/95 backdrop-blur">
        <div className="flex items-center gap-4">
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
            onClick={() => setShowPileMode(true)}
            className="px-4 py-2 bg-gradient-to-r from-purple-500 to-blue-500 text-white rounded-lg hover:opacity-90 transition-opacity text-sm font-medium"
          >
            📦 Sort Pile ({stats.untagged_count})
          </button>
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
            <>
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
                onTrackClick={(track, index) => {
                  addToQueue(track);
                  playTrack(track, queue.length);
                }}
                onTrackDoubleClick={(track) => {
                  addToQueue(track);
                  playTrack(track, queue.length);
                }}
                onUpdateTrack={updateTrack}
                onTrashTrack={trashTrack}
                isLoading={isLoadingLibrary}
              />
            </>
          )}
          
          {activeTab === 'now-playing' && (
            <div className="flex-1 flex items-center justify-center">
              {currentTrack ? (
                <div className="text-center">
                  <div className="w-64 h-64 mx-auto mb-6 bg-gradient-to-br from-purple-600 to-blue-600 rounded-2xl flex items-center justify-center text-6xl shadow-2xl">
                    🎵
                  </div>
                  <h2 className="text-2xl font-bold text-white mb-2">
                    {currentTrack.title || currentTrack.name}
                  </h2>
                  <p className="text-gray-400 mb-4">{currentTrack.author || 'Unknown'}</p>
                  
                  {currentTrack.tags && (
                    <div className="flex justify-center gap-2 mb-6">
                      {currentTrack.tags.map(tag => (
                        <span key={tag} className="px-3 py-1 bg-white/10 rounded-full text-sm">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                  
                  <div className="flex items-center justify-center gap-4">
                    <StarRating
                      rating={currentTrack.rating}
                      maxRating={5}
                      size="lg"
                      onRate={(r) => updateTrack(currentTrack.id, { rating: r })}
                    />
                  </div>
                </div>
              ) : (
                <div className="text-center text-gray-500">
                  <div className="text-6xl mb-4">🎵</div>
                  <p>No track playing</p>
                  <p className="text-sm">Select a track from the library</p>
                </div>
              )}
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
                shuffle={shuffle}
                repeatMode={repeatMode}
                onToggleRepeat={() => setRepeatMode(m => m === 'off' ? 'all' : m === 'all' ? 'one' : 'off')}
              />
            </div>
          )}
        </main>
        
        {/* Visualizer Sidebar (Now Playing) */}
        {activeTab === 'now-playing' && (
          <aside className="w-80 border-l border-white/10 bg-[#0a0a18] p-4">
            <canvas
              ref={canvasRef}
              width={300}
              height={400}
              className="w-full rounded-lg"
            />
            {!webGPUSupported && (
              <p className="text-xs text-yellow-500 mt-2">WebGPU not supported</p>
            )}
            
            <div className="mt-4 space-y-2">
              <button
                onClick={() => setVisualizerMode('flat')}
                className={`w-full px-4 py-2 rounded text-left ${visualizerMode === 'flat' ? 'bg-purple-500' : 'bg-white/10'}`}
              >
                Flat Waveform
              </button>
              <button
                onClick={() => setVisualizerMode('3D')}
                className={`w-full px-4 py-2 rounded text-left ${visualizerMode === '3D' ? 'bg-purple-500' : 'bg-white/10'}`}
              >
                3D Device
              </button>
            </div>
          </aside>
        )}
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
                onClick={() => {
                  if (playerState.isPlaying) playerRef.current?.pause();
                  else playerRef.current?.play();
                }}
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
          </div>
        </div>
        
        {error && (
          <div className="mt-2 text-center text-red-400 text-sm">{error}</div>
        )}
      </footer>
    </div>
  );
};
