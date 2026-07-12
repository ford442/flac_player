import { useState, useCallback, useEffect, useRef } from 'react';
import {
  loadQueueFromStorage,
  AudioLoader, PlaylistTrack, SortBy, RepeatMode, LibraryStats, TagInfo, CloudPlaylist,
  saveQueueToStorage, clearQueueStorage, getCachedLibrary, setCachedLibrary
} from '../audioLoader';
import { checkBackendHealth } from '../utils/healthCheck';
import {
  addTrackToQueue, playNextTrack, removeFromQueue as removeFromQueueUtil, reorderQueueIndex
} from '../utils/queueUtils';

interface UsePlayerDataParams {
  loader: AudioLoader;
  addToast: (msg: string, type: 'success' | 'error' | 'info') => void;
  setError: (e: string) => void;
  setCurrentTrack: React.Dispatch<React.SetStateAction<PlaylistTrack | null>>;
  isSharedPlaylist: boolean;
}

export function usePlayerData({ loader, addToast, setError, setCurrentTrack, isSharedPlaylist }: UsePlayerDataParams) {
  const [library, setLibrary] = useState<PlaylistTrack[]>([]);
  const [allTags, setAllTags] = useState<TagInfo[]>([]);
  const [stats, setStats] = useState<LibraryStats>({
    total_tracks: 0, rated_4plus: 0, total_duration_hours: 0,
    total_play_count: 0, untagged_count: 0, trash_count: 0, unique_tags: 0, top_tags: []
  });
  const [isLoadingLibrary, setIsLoadingLibrary] = useState(false);
  const [isResyncingLibrary, setIsResyncingLibrary] = useState(false);
  const [playlists, setPlaylists] = useState<CloudPlaylist[]>([]);
  const [isLoadingPlaylists, setIsLoadingPlaylists] = useState(false);
  const [sharedPlaylistTitle, setSharedPlaylistTitle] = useState('');

  const [searchQuery, setSearchQuery] = useState('');
  const [minRating, setMinRating] = useState(0);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [untaggedOnly, setUntaggedOnly] = useState(false);
  const [sortBy, setSortBy] = useState<SortBy>('date');
  const [storageSourceFilter, setStorageSourceFilter] = useState<'all' | 'fast'>('all');

  const initialQueueData = loadQueueFromStorage() || { tracks: [], currentIndex: -1, shuffle: false, repeat: 'off' };
  const [queue, setQueue] = useState<PlaylistTrack[]>(initialQueueData.tracks);
  const [queueCurrentIndex, setQueueCurrentIndex] = useState(initialQueueData.currentIndex);
  const [showQueue, setShowQueue] = useState(false);
  const [shuffle, setShuffle] = useState(initialQueueData.shuffle);
  const [repeatMode, setRepeatMode] = useState<RepeatMode>(initialQueueData.repeat);

  const [volume, setVolume] = useState(() => {
    try { const v = parseFloat(localStorage.getItem('flac_volume') || '1'); return isNaN(v) ? 1 : Math.max(0, Math.min(1, v)); } catch { return 1; }
  });
  const [muted, setMuted] = useState(false);
  const prevVolumeRef = useRef(1);

  const checkBackend = useCallback(async () => {
    return checkBackendHealth(loader);
  }, [loader]);

  const loadTags = useCallback(async () => {
    try { setAllTags(await loader.fetchTags()); } catch { /* no-op */ }
  }, [loader]);

  const loadStats = useCallback(async () => {
    try { setStats(await loader.fetchStats()); } catch { /* no-op */ }
  }, [loader]);

  const loadLibrary = useCallback(async () => {
    setIsLoadingLibrary(true);
    try {
      const { tracks } = await loader.fetchLibrary({
        ratingGte: minRating,
        tags: selectedTags.length > 0 ? selectedTags : undefined,
        untagged: untaggedOnly,
        search: searchQuery || undefined,
        sortBy, sortDesc: true, limit: 1000
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
  }, [loader, minRating, selectedTags, untaggedOnly, searchQuery, sortBy, allTags, stats, addToast, setError]);

  const loadPlaylists = useCallback(async () => {
    setIsLoadingPlaylists(true);
    try { setPlaylists(await loader.fetchPlaylists()); }
    catch { addToast('Failed to load playlists', 'error'); }
    finally { setIsLoadingPlaylists(false); }
  }, [loader, addToast]);

  const triggerLibraryResync = useCallback(async () => {
    if (isResyncingLibrary) return;
    setIsResyncingLibrary(true);
    try {
      const result = await loader.triggerLibraryResync();
      addToast(
        result.isAcceptedOrRunning
          ? 'Library rescan accepted. Refreshing catalog...'
          : 'Library rescan completed. Refreshing catalog...',
        'success'
      );
      const healthy = await checkBackend();
      if (healthy) await Promise.all([loadLibrary(), loadTags(), loadStats()]);
      else addToast('Rescan initiated, but catalog refresh failed - backend is currently unreachable', 'info');
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Failed to trigger library rescan', 'error');
    } finally {
      setIsResyncingLibrary(false);
    }
  }, [isResyncingLibrary, loader, addToast, checkBackend, loadLibrary, loadTags, loadStats]);

  useEffect(() => {
    if (isSharedPlaylist) return;
    checkBackend().then(healthy => { if (healthy) loadLibrary(); });
  }, []);

  useEffect(() => {
    if (isSharedPlaylist) return;
    loadTags(); loadStats();
  }, []);

  useEffect(() => {
    if (isSharedPlaylist) return;
    saveQueueToStorage({ tracks: queue, currentIndex: queueCurrentIndex, shuffle, repeat: repeatMode });
  }, [isSharedPlaylist, queue, queueCurrentIndex, shuffle, repeatMode]);

  useEffect(() => {
    try { localStorage.setItem('flac_volume', String(volume)); } catch { /* no-op */ }
  }, [volume]);

  const addToQueue = useCallback((track: PlaylistTrack) => {
    setQueue(prev => addTrackToQueue(prev, track));
    addToast('Added to queue', 'success');
  }, [addToast]);

  const addAllToQueue = useCallback((tracks: PlaylistTrack[]) => {
    if (tracks.length === 0) return;
    setQueue(prev => {
      const existingIds = new Set(prev.map(t => t.id));
      return [...prev, ...tracks.filter(t => !existingIds.has(t.id))];
    });
    addToast(`Added ${tracks.length} tracks to queue`, 'success');
  }, [addToast]);

  const removeFromQueue = useCallback((index: number) => {
    setQueue(prev => {
      const newQueue = removeFromQueueUtil(prev, index);
      setQueueCurrentIndex(prevIndex => {
        if (prevIndex === -1) return -1;
        if (index < prevIndex) return prevIndex - 1;
        if (index === prevIndex) return newQueue.length > 0 ? Math.min(prevIndex, newQueue.length - 1) : -1;
        return prevIndex;
      });
      return newQueue;
    });
  }, []);

  const reorderQueue = useCallback((startIndex: number, endIndex: number) => {
    if (startIndex === endIndex) return;
    setQueue(prev => {
      const next = [...prev];
      const [removed] = next.splice(startIndex, 1);
      next.splice(endIndex, 0, removed);
      return next;
    });
    setQueueCurrentIndex(prev => reorderQueueIndex(prev, startIndex, endIndex));
  }, []);

  const clearQueue = useCallback(() => {
    setQueue([]); setQueueCurrentIndex(-1); clearQueueStorage();
  }, []);

  const enqueueNext = useCallback((track: PlaylistTrack) => {
    setQueue(prev => {
      const { queue: newQueue } = playNextTrack(prev, track, queueCurrentIndex);
      return newQueue;
    });
    addToast('Playing next: ' + (track.title || track.name), 'success');
  }, [queueCurrentIndex, addToast]);

  const updateTrack = useCallback(async (id: string, updates: Partial<PlaylistTrack>) => {
    try {
      await loader.updateSampleMetadata(id, updates);
      setLibrary(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t));
      setCurrentTrack(prev => prev?.id === id ? { ...prev, ...updates } : prev);
      loadTags(); loadStats();
      addToast('Changes saved', 'success');
    } catch {
      addToast('Failed to save changes', 'error');
      throw new Error('Failed to save changes');
    }
  }, [loader, setCurrentTrack, loadTags, loadStats, addToast]);

  const trashTrack = useCallback(async (id: string) => {
    try {
      await loader.trashTrack(id);
      setLibrary(prev => prev.filter(t => t.id !== id));
      loadStats();
      addToast('Moved to trash', 'success');
    } catch {
      addToast('Failed to trash track', 'error');
    }
  }, [loader, loadStats, addToast]);

  return {
    library, setLibrary, allTags, setAllTags, stats, setStats,
    isLoadingLibrary, isResyncingLibrary,
    playlists, isLoadingPlaylists,
    sharedPlaylistTitle, setSharedPlaylistTitle,
    searchQuery, setSearchQuery, minRating, setMinRating,
    selectedTags, setSelectedTags, untaggedOnly, setUntaggedOnly,
    sortBy, setSortBy, storageSourceFilter, setStorageSourceFilter,
    queue, setQueue, queueCurrentIndex, setQueueCurrentIndex,
    showQueue, setShowQueue, shuffle, setShuffle, repeatMode, setRepeatMode,
    volume, setVolume, muted, setMuted, prevVolumeRef,
    checkBackend, loadPlaylists, loadLibrary, loadTags, loadStats, triggerLibraryResync,
    addToQueue, addAllToQueue, removeFromQueue, reorderQueue, clearQueue, enqueueNext,
    updateTrack, trashTrack,
  };
}
