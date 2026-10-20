// Library data as TanStack Query hooks (#258). Filters are part of the query key,
// so changing a filter refetches page 0 and loadMore always continues the
// current filter's pages. Requests are deduped and cancelled through the
// query's AbortSignal.

import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  QueryClient, keepPreviousData, useInfiniteQuery, useQuery, useQueryClient, type InfiniteData,
} from '@tanstack/react-query';
import type { LibraryStats, PlaylistTrack, SortBy, TagInfo } from '../types/library';
import { getCachedLibrary, setCachedLibrary, type CachedLibrary } from '../storage/libraryCache';
import { fetchSongs, fetchStats, fetchTags, type SongQuery } from './songApi';

/** Songs fetched per library page; more pages exist while pages come back full. */
export const LIBRARY_PAGE_SIZE = 200;

export interface LibraryFilters {
  search: string;
  minRating: number;
  tags: string[];
  untaggedOnly: boolean;
  sortBy: SortBy;
}

export const DEFAULT_LIBRARY_FILTERS: LibraryFilters = {
  search: '', minRating: 0, tags: [], untaggedOnly: false, sortBy: 'date',
};

export const EMPTY_STATS: LibraryStats = {
  total_tracks: 0, rated_4plus: 0, total_duration_hours: 0,
  total_play_count: 0, untagged_count: 0, trash_count: 0, unique_tags: 0, top_tags: [],
};

export const libraryKeys = {
  all: ['library'] as const,
  songs: (filters: LibraryFilters) => ['library', 'songs', filters] as const,
  tags: ['library', 'tags'] as const,
  stats: ['library', 'stats'] as const,
};

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 60_000, retry: 1, refetchOnWindowFocus: false },
    },
  });
}

export function songQuery(filters: LibraryFilters, offset: number): SongQuery {
  return {
    ratingGte: filters.minRating,
    tags: filters.tags.length > 0 ? filters.tags : undefined,
    untagged: filters.untaggedOnly,
    search: filters.search || undefined,
    sortBy: filters.sortBy,
    sortDesc: true,
    limit: LIBRARY_PAGE_SIZE,
    offset,
  };
}

type SongPages = InfiniteData<PlaylistTrack[], number>;

function useSongPages(filters: LibraryFilters, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: libraryKeys.songs(filters),
    queryFn: async ({ pageParam, signal }) => (await fetchSongs(songQuery(filters, pageParam), signal)).tracks,
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) => (
      lastPage.length === LIBRARY_PAGE_SIZE ? pages.reduce((n, page) => n + page.length, 0) : undefined
    ),
    // Keep the old list on screen while a new filter's first page loads.
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useTags(enabled = true) {
  return useQuery({ queryKey: libraryKeys.tags, queryFn: ({ signal }) => fetchTags(signal), enabled });
}

export function useStats(enabled = true) {
  return useQuery({ queryKey: libraryKeys.stats, queryFn: ({ signal }) => fetchStats(signal), enabled });
}

export interface LibraryCatalog {
  tracks: PlaylistTrack[];
  tags: TagInfo[];
  stats: LibraryStats;
  isLoading: boolean;
  hasMore: boolean;
  loadMore(): void;
  /** 'checking' until the first page answers; 'down' when it failed (cached rows may still show). */
  backendStatus: 'checking' | 'up' | 'down';
  /** True while showing the localStorage copy because the host is unreachable. */
  fromCache: boolean;
  /** Refetch songs, tags and stats. */
  refresh(): Promise<void>;
}

/**
 * Library rows, tags and stats for `filters`. When the host is unreachable it
 * serves the last cached copy (written only from real responses, so tags and
 * stats are never cached as empty placeholders).
 */
export function useLibraryCatalog(
  filters: LibraryFilters,
  { enabled = true, onCacheFallback }: { enabled?: boolean; onCacheFallback?: () => void } = {},
): LibraryCatalog {
  const queryClient = useQueryClient();
  const songs = useSongPages(filters, enabled);
  const tags = useTags(enabled);
  const stats = useStats(enabled);

  // Pages can overlap when the catalog shifts between requests; keep the first copy.
  const tracks = useMemo(() => {
    const byId = new Map<string, PlaylistTrack>();
    for (const track of (songs.data?.pages ?? []).flat()) {
      if (!byId.has(track.id)) byId.set(track.id, track);
    }
    return [...byId.values()];
  }, [songs.data]);

  // Cache only answers from the server, merged with what the cache already holds.
  useEffect(() => {
    if (!songs.isSuccess || songs.isPlaceholderData) return;
    const previous = getCachedLibrary();
    setCachedLibrary(tracks, tags.data ?? previous?.tags ?? [], stats.data ?? previous?.stats ?? EMPTY_STATS);
  }, [songs.isSuccess, songs.isPlaceholderData, tracks, tags.data, stats.data]);

  const failed = songs.isError && !songs.data;
  const cached = useMemo<CachedLibrary | null>(() => (failed ? getCachedLibrary() : null), [failed]);
  const fromCache = !!cached && cached.tracks.length > 0;

  const onFallbackRef = useRef(onCacheFallback);
  onFallbackRef.current = onCacheFallback;
  useEffect(() => {
    if (fromCache) onFallbackRef.current?.();
  }, [fromCache]);

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = songs;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: libraryKeys.all });
  }, [queryClient]);

  return {
    tracks: fromCache ? cached.tracks : tracks,
    tags: tags.data ?? (fromCache ? cached.tags : []),
    stats: stats.data ?? (fromCache ? cached.stats : EMPTY_STATS),
    isLoading: songs.isFetching && (!songs.data || songs.isPlaceholderData || isFetchingNextPage),
    hasMore: !fromCache && !!hasNextPage,
    loadMore,
    backendStatus: songs.isSuccess ? 'up' : songs.isError ? 'down' : 'checking',
    fromCache,
    refresh,
  };
}

/** Apply `updates` to a track in every cached library page. */
export function patchLibraryTrack(queryClient: QueryClient, id: string, updates: Partial<PlaylistTrack>): void {
  queryClient.setQueriesData<SongPages>({ queryKey: ['library', 'songs'] }, (data) => data && {
    ...data,
    pages: data.pages.map((page) => page.map((t) => (t.id === id ? { ...t, ...updates } : t))),
  });
}

/** Drop a track from every cached library page. */
export function removeLibraryTrack(queryClient: QueryClient, id: string): void {
  queryClient.setQueriesData<SongPages>({ queryKey: ['library', 'songs'] }, (data) => data && {
    ...data,
    pages: data.pages.map((page) => page.filter((t) => t.id !== id)),
  });
}
