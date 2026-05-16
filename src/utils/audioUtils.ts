// Utility functions for audio and playlist management

import { PlaylistTrack, SortBy } from '../audioLoader';

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
    prompt: item.prompt
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
