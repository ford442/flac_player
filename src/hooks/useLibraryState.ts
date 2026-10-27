// Library browsing state: filters, the TanStack-backed catalog and track edits
// (#258). Replaces the library half of usePlayerData; the queue and volume now
// live in the player store.

import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PlaylistTrack, SortBy, LibraryStats, TagInfo } from '../types/library';
import {
  libraryKeys, patchLibraryTrack, removeLibraryTrack, useLibraryCatalog, type LibraryFilters,
} from '../api/library';
import { trashTrack as trashTrackRequest, triggerMusicResync, updateSampleMetadata } from '../api/songApi';
import { clearMetadataCache } from '../storage/metadataCache';
import { isFastMirrorEligible } from '../utils/audioUtils';
import type { PlaybackEngine } from '../player/PlaybackEngine';

/** Typing in the search box refetches once it pauses for this long. */
const SEARCH_DEBOUNCE_MS = 250;

type Notify = (message: string, type: 'success' | 'error' | 'info') => void;

export interface LibraryState {
  /** Rows of the current filters (with the cached copy while offline). */
  library: PlaylistTrack[];
  /** `library` narrowed by the storage-source filter. */
  displayedLibrary: PlaylistTrack[];
  fastMirrorCount: number;
  allTags: TagInfo[];
  stats: LibraryStats;
  isLoadingLibrary: boolean;
  hasMoreLibrary: boolean;
  loadMoreLibrary: () => void;
  backendStatus: 'checking' | 'up' | 'down';
  /** Refetch songs, tags and stats. */
  refresh: () => Promise<void>;

  searchQuery: string;
  setSearchQuery: (query: string) => void;
  minRating: number;
  setMinRating: (rating: number) => void;
  selectedTags: string[];
  setSelectedTags: Dispatch<SetStateAction<string[]>>;
  untaggedOnly: boolean;
  setUntaggedOnly: (value: boolean) => void;
  sortBy: SortBy;
  setSortBy: (sort: SortBy) => void;
  storageSourceFilter: 'all' | 'fast';
  setStorageSourceFilter: (filter: 'all' | 'fast') => void;

  isResyncingLibrary: boolean;
  triggerLibraryResync: () => Promise<void>;
  updateTrack: (id: string, updates: Partial<PlaylistTrack>) => Promise<void>;
  trashTrack: (id: string) => Promise<void>;
  /** Re-read stats (play counts change when a library track starts). */
  refreshStats: () => void;
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

export function useLibraryState(
  { enabled, notify, engine }: { enabled: boolean; notify: Notify; engine: PlaybackEngine },
): LibraryState {
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState('');
  const [minRating, setMinRating] = useState(0);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [untaggedOnly, setUntaggedOnly] = useState(false);
  const [sortBy, setSortBy] = useState<SortBy>('date');
  const [storageSourceFilter, setStorageSourceFilter] = useState<'all' | 'fast'>('all');
  const [isResyncingLibrary, setIsResyncingLibrary] = useState(false);

  const search = useDebounced(searchQuery.trim(), SEARCH_DEBOUNCE_MS);
  // The query key: a filter change refetches page 0 and resets paging (#258 bug 10).
  const filters = useMemo<LibraryFilters>(
    () => ({ search, minRating, tags: selectedTags, untaggedOnly, sortBy }),
    [search, minRating, selectedTags, untaggedOnly, sortBy],
  );
  const catalog = useLibraryCatalog(filters, {
    enabled,
    onCacheFallback: () => notify('Showing cached library (server unavailable)', 'info'),
  });

  const fastMirrorCount = useMemo(
    () => catalog.tracks.filter(track => isFastMirrorEligible(track.url)).length,
    [catalog.tracks],
  );
  const displayedLibrary = useMemo(
    () => storageSourceFilter === 'fast' ? catalog.tracks.filter(track => isFastMirrorEligible(track.url)) : catalog.tracks,
    [catalog.tracks, storageSourceFilter],
  );

  const { refresh } = catalog;
  const refreshTagsAndStats = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: libraryKeys.tags });
    void queryClient.invalidateQueries({ queryKey: libraryKeys.stats });
  }, [queryClient]);
  const refreshStats = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: libraryKeys.stats });
  }, [queryClient]);

  const triggerLibraryResync = useCallback(async () => {
    if (isResyncingLibrary) return;
    setIsResyncingLibrary(true);
    try {
      const result = await triggerMusicResync();
      notify(
        result.isAcceptedOrRunning
          ? 'Library rescan accepted. Refreshing catalog...'
          : 'Library rescan completed. Refreshing catalog...',
        'success'
      );
      void clearMetadataCache(); // files may have been retagged; re-read tags on next play
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Failed to trigger library rescan', 'error');
    } finally {
      setIsResyncingLibrary(false);
    }
  }, [isResyncingLibrary, notify, refresh]);

  const updateTrack = useCallback(async (id: string, updates: Partial<PlaylistTrack>) => {
    try {
      await updateSampleMetadata(id, updates);
    } catch {
      notify('Failed to save changes', 'error');
      throw new Error('Failed to save changes');
    }
    patchLibraryTrack(queryClient, id, updates);
    engine.patchTrack(id, updates);
    refreshTagsAndStats();
    notify('Changes saved', 'success');
  }, [queryClient, engine, refreshTagsAndStats, notify]);

  const trashTrack = useCallback(async (id: string) => {
    try {
      await trashTrackRequest(id);
    } catch {
      notify('Failed to trash track', 'error');
      return;
    }
    removeLibraryTrack(queryClient, id);
    refreshStats();
    notify('Moved to trash', 'success');
  }, [queryClient, refreshStats, notify]);

  return {
    library: catalog.tracks,
    displayedLibrary,
    fastMirrorCount,
    allTags: catalog.tags,
    stats: catalog.stats,
    isLoadingLibrary: catalog.isLoading,
    hasMoreLibrary: catalog.hasMore,
    loadMoreLibrary: catalog.loadMore,
    backendStatus: catalog.backendStatus,
    refresh,
    searchQuery, setSearchQuery,
    minRating, setMinRating,
    selectedTags, setSelectedTags,
    untaggedOnly, setUntaggedOnly,
    sortBy, setSortBy,
    storageSourceFilter, setStorageSourceFilter,
    isResyncingLibrary,
    triggerLibraryResync,
    updateTrack,
    trashTrack,
    refreshStats,
  };
}
