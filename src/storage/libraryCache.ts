// Library caching with localStorage persistence and TTL

import { PlaylistTrack, LibraryStats, TagInfo } from '../audioLoader';

export const LIBRARY_CACHE_KEY = 'flac_player_library_cache';
export const LIBRARY_CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours

export interface CachedLibrary {
  tracks: PlaylistTrack[];
  tags: TagInfo[];
  stats: LibraryStats;
  timestamp: number;
}

export function getCachedLibrary(): CachedLibrary | null {
  try {
    const cached = localStorage.getItem(LIBRARY_CACHE_KEY);
    if (!cached) return null;
    const data = JSON.parse(cached) as CachedLibrary;
    if (Date.now() - data.timestamp > LIBRARY_CACHE_TTL_MS) {
      localStorage.removeItem(LIBRARY_CACHE_KEY);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

export function setCachedLibrary(tracks: PlaylistTrack[], tags: TagInfo[], stats: LibraryStats): void {
  try {
    const data: CachedLibrary = { tracks, tags, stats, timestamp: Date.now() };
    localStorage.setItem(LIBRARY_CACHE_KEY, JSON.stringify(data));
  } catch {
    // Quota exceeded — silently fail
  }
}

export function clearLibraryCache(): void {
  localStorage.removeItem(LIBRARY_CACHE_KEY);
}
