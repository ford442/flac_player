// The library view over the IndexedDB catalog. The host is synced into the catalog
// (a TanStack query, so refresh/rescan just refetch it); rows, filters, tags and stats
// are read locally with a live query, so the library works the same offline.

import { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import { QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import type { LibraryStats, PlaylistTrack, TagInfo } from '../types/library';
import { getCatalogDb, type CatalogTrack } from '../catalog/db';
import { syncRemoteLibrary, toCatalogTrack } from '../catalog/remoteSync';
import {
  computeStats, computeTags, EMPTY_STATS, filterTracks, fromCatalogTrack, sortTracks, type LibraryFilters,
} from '../catalog/libraryQuery';
import { fetchSongPage } from './songApi';

export { DEFAULT_LIBRARY_FILTERS, EMPTY_STATS, type LibraryFilters } from '../catalog/libraryQuery';

/** Rows shown per "Load more" until the list is virtualized. */
export const LIBRARY_PAGE_SIZE = 200;

export const libraryKeys = {
  all: ['library'] as const,
  sync: ['library', 'sync'] as const,
};

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 60_000, retry: 1, refetchOnWindowFocus: false },
    },
  });
}

/** Pull the host's catalog into IndexedDB. */
export function useLibrarySync(enabled = true) {
  return useQuery({
    queryKey: libraryKeys.sync,
    queryFn: ({ signal }) => syncRemoteLibrary(fetchSongPage, { signal }),
    enabled,
  });
}

type LiveRows = { rows: CatalogTrack[] } | { failed: true };

/** Every catalog row, live; `failed` when IndexedDB is unusable (private mode, blocked storage). */
function useCatalogRows(enabled: boolean): LiveRows | undefined {
  return useLiveQuery<LiveRows>(async () => {
    if (!enabled) return { rows: [] };
    try {
      return { rows: await getCatalogDb().tracks.toArray() };
    } catch {
      return { failed: true };
    }
  }, [enabled]);
}

export interface LibraryCatalog {
  tracks: PlaylistTrack[];
  tags: TagInfo[];
  stats: LibraryStats;
  isLoading: boolean;
  hasMore: boolean;
  loadMore(): void;
  /** 'checking' until the first sync answers; 'down' when the last sync failed. */
  backendStatus: 'checking' | 'up' | 'down';
  /** The host is unreachable and the view shows the synced catalog. */
  offline: boolean;
  /** Re-sync from the host. */
  refresh(): Promise<void>;
}

/** Library rows, tags and stats for `filters`, from the catalog. */
export function useLibraryCatalog(
  filters: LibraryFilters,
  { enabled = true, onOffline }: { enabled?: boolean; onOffline?: () => void } = {},
): LibraryCatalog {
  const queryClient = useQueryClient();
  const sync = useLibrarySync(enabled);
  const live = useCatalogRows(enabled);

  // Without IndexedDB, serve the last sync's rows straight from memory.
  const syncRows = sync.data?.tracks;
  const rows = useMemo<CatalogTrack[] | undefined>(() => {
    if (!live) return undefined;
    if ('rows' in live) return live.rows;
    return syncRows?.map((t) => toCatalogTrack(t));
  }, [live, syncRows]);

  // Filters by value, so callers needn't memoize the object.
  const filterKey = JSON.stringify(filters);
  // A fresh shuffle per filter change, stable while paging.
  const { stableFilters, seed } = useMemo(
    () => ({ stableFilters: filters, seed: (Math.random() * 2 ** 32) >>> 0 }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- filterKey is filters by value
    [filterKey],
  );
  const matching = useMemo(
    () => (rows ? sortTracks(filterTracks(rows, stableFilters), stableFilters.sortBy, seed) : []),
    [rows, stableFilters, seed],
  );
  const tags = useMemo(() => (rows ? computeTags(rows) : []), [rows]);
  const stats = useMemo(() => (rows ? computeStats(rows, tags) : EMPTY_STATS), [rows, tags]);

  // Paging resets whenever the filters change.
  const [paging, setPaging] = useState({ filterKey, limit: LIBRARY_PAGE_SIZE });
  const limit = paging.filterKey === filterKey ? paging.limit : LIBRARY_PAGE_SIZE;
  const tracks = useMemo(() => matching.slice(0, limit).map(fromCatalogTrack), [matching, limit]);
  const hasMore = matching.length > limit;
  const loadMore = useCallback(() => {
    if (hasMore) setPaging({ filterKey, limit: limit + LIBRARY_PAGE_SIZE });
  }, [hasMore, filterKey, limit]);

  const offline = sync.isError && !!rows && rows.length > 0;
  const onOfflineRef = useRef(onOffline);
  onOfflineRef.current = onOffline;
  useEffect(() => {
    if (offline) onOfflineRef.current?.();
  }, [offline]);

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: libraryKeys.all });
  }, [queryClient]);

  return {
    tracks,
    tags,
    stats,
    isLoading: enabled && (!rows || (sync.isFetching && rows.length === 0)),
    hasMore,
    loadMore,
    backendStatus: sync.isError ? 'down' : sync.isSuccess ? 'up' : 'checking',
    offline,
    refresh,
  };
}
