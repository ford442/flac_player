// Utility functions for audio and playlist management

import { PlaylistTrack } from '../audioLoader';

// =============================================================================
// Track Filtering & Sorting
// =============================================================================

export function filterAudioFiles(items: PlaylistTrack[]): PlaylistTrack[] {
  return items.filter((item) => {
    const lowerName = (item.name || '').toLowerCase();
    return lowerName.endsWith('.flac') || lowerName.endsWith('.wav');
  });
}

export function buildTrackUrl(item: any, apiBaseUrl: string): string {
  if (item.url) {
    return item.url.startsWith('http') ? item.url : `${apiBaseUrl}${item.url}`;
  }
  return `${apiBaseUrl}/api/music/${item.id}`;
}

export const FAST_STORAGE_HOST = 'storage.1ink.us';
export const PRIMARY_STORAGE_HOST = 'storage.noahcohn.com';

export function isFastStorageUrl(url?: string): boolean {
  if (!url) return false;
  try {
    return new URL(url).hostname === FAST_STORAGE_HOST;
  } catch {
    return false;
  }
}

export function getPreferredStorageUrls(url?: string): string[] {
  if (!url) return [];

  try {
    const parsed = new URL(url);
    if (parsed.hostname === FAST_STORAGE_HOST) {
      return [url];
    }
    if (parsed.hostname === PRIMARY_STORAGE_HOST) {
      const preferred = new URL(url);
      preferred.hostname = FAST_STORAGE_HOST;
      return [preferred.toString(), url];
    }
    return [url];
  } catch {
    return [url];
  }
}

// =============================================================================
// Playlist Management
// =============================================================================

export function normalizeTrackData(item: any, apiBaseUrl: string): PlaylistTrack {
  return {
    id: item.id,
    name: item.name || item.filename,
    url: buildTrackUrl(item, apiBaseUrl),
    rating: item.rating,
    description: item.description,
    author: item.author,
    genre: item.genre,
    last_played: item.last_played,
    title: item.title,
    artist: item.artist,
    cover_url: item.cover_url,
    type: item.type,
    duration: item.duration,
    play_count: item.play_count,
    tags: item.tags,
    created_at: item.created_at,
    generation_model: item.generation_model,
    version: item.version,
    prompt: item.prompt,
    replaygain_track_db: item.replaygain_track_db,
    replaygain_album_db: item.replaygain_album_db,
    replaygain_track_peak: item.replaygain_track_peak,
    replaygain_album_peak: item.replaygain_album_peak,
  };
}

// =============================================================================
// Cloud Playlists
// =============================================================================

export function buildCloudPlaylistUrl(): string {
  return process.env.REACT_APP_PLAYLIST_API_URL || 'https://storage.noahcohn.com';
}

export function normalizeDebugObject(error: any): {
  message: string;
  type: string;
  stack?: string[];
} {
  return {
    message: error instanceof Error ? error.message : String(error),
    type: error instanceof TypeError ? 'TypeError (network-level)' : error instanceof Error ? error.constructor.name : 'unknown',
    stack: error instanceof Error ? error.stack?.split('\n').slice(0, 3) : undefined
  };
}

// =============================================================================
// Playback Utilities
// =============================================================================

/** Format seconds as mm:ss string */
export function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/** Fisher-Yates shuffle — uniform random permutation */
export function shuffleArray<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
