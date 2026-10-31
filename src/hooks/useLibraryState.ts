// Library browsing state: filters over the IndexedDB catalog and track edits (#258).
// Edits go to the host first, then into the catalog, so every live view updates.

import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { PlaylistTrack, SortBy, LibraryStats, TagInfo } from '../types/library';
import { useLibraryCatalog, type LibraryFilters } from '../api/library';
import { markLibraryRowTrashed, patchLibraryRow } from '../catalog/libraryRows';
import { trashTrack as trashTrackRequest, triggerMusicResync, updateSampleMetadata } from '../api/songApi';
import { clearMetadataCache } from '../storage/metadataCache';
import { isFastMirrorEligible } from '../utils/audioUtils';
import type { PlaybackEngine } from '../player/PlaybackEngine';

/** Typing in the search box filters once it pauses for this long. */
const SEARCH_DEBOUNCE_MS = 250;

type Notify = (message: string, type: 'success' | 'error' | 'info') => void;

export interface LibraryState {
  /** Rows of the current filters, from the catalog (so also offline). */
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
  /** Re-sync the catalog from the host. */
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
  const [searchQuery, setSearchQuery] = useState('');
  const [minRating, setMinRating] = useState(0);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [untaggedOnly, setUntaggedOnly] = useState(false);
  const [sortBy, setSortBy] = useState<SortBy>('date');
  const [storageSourceFilter, setStorageSourceFilter] = useState<'all' | 'fast'>('all');
  const [isResyncingLibrary, setIsResyncingLibrary] = useState(false);

  const search = useDebounced(searchQuery.trim(), SEARCH_DEBOUNCE_MS);
  // A filter change resets paging (#258 bug 10).
  const filters = useMemo<LibraryFilters>(
    () => ({ search, minRating, tags: selectedTags, untaggedOnly, sortBy }),
    [search, minRating, selectedTags, untaggedOnly, sortBy],
  );
  const catalog = useLibraryCatalog(filters, {
    enabled,
    onOffline: () => notify('Library host unreachable — showing your synced library', 'info'),
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
    await patchLibraryRow(id, updates).catch(() => { /* the next sync brings it in */ });
    engine.patchTrack(id, updates);
    notify('Changes saved', 'success');
  }, [engine, notify]);

  const trashTrack = useCallback(async (id: string) => {
    try {
      await trashTrackRequest(id);
    } catch {
      notify('Failed to trash track', 'error');
      return;
    }
    await markLibraryRowTrashed(id).catch(() => { /* the next sync brings it in */ });
    notify('Moved to trash', 'success');
  }, [notify]);

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
  };
}
