// Audio loader for Google Cloud Storage and FTP sources
// Enhanced with AI track support and library management

import * as songApi from './api/songApi';
import type {
  CloudPlaylist, LibraryStats, PlaylistTrack, ShareResponse, SortBy, TagInfo
} from './types/library';

export type {
  CloudPlaylist, LibraryStats, PlaylistTrack, ShareResponse, SortBy, TagInfo
} from './types/library';

// Re-export types and storage utilities
export type { RepeatMode } from './storage/queueStorage';
export { QUEUE_STORAGE_KEY, saveQueueToStorage, loadQueueFromStorage, clearQueueStorage } from './storage/queueStorage';
export type { QueueState } from './storage/queueStorage';
export { LIBRARY_CACHE_KEY, LIBRARY_CACHE_TTL_MS, getCachedLibrary, setCachedLibrary, clearLibraryCache } from './storage/libraryCache';
export type { CachedLibrary } from './storage/libraryCache';

// Debug mode - set to true to enable detailed logging
const DEBUG_MODE = true;

const debug = {
  log: (label: string, data: unknown) => {
    if (DEBUG_MODE) console.log(`[FLAC:${label}]`, data);
  },
  error: (label: string, data: unknown) => {
    if (DEBUG_MODE) console.error(`[FLAC:${label}]`, data);
  },
  warn: (label: string, data: unknown) => {
    if (DEBUG_MODE) console.warn(`[FLAC:${label}]`, data);
  }
};

interface LegacySongFields {
  id: string;
  name?: string;
  filename?: string;
  rating?: number;
  description?: string;
  author?: string;
  genre?: string;
  last_played?: string;
}

type LegacySongRecord = LegacySongFields & ({ name: string } | { filename: string });

function isLegacySongRecord(value: unknown): value is LegacySongRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string'
    && (typeof candidate.name === 'string' || typeof candidate.filename === 'string');
}

export interface AudioSource {
  url: string;
  type: 'google-bucket' | 'ftp' | 'http' | 'https';
  name?: string;
}

export type ViewMode = 'library' | 'now-playing' | 'queue' | 'pile';

export class AudioLoader {
  async loadAudio(source: AudioSource): Promise<ArrayBuffer> {
    try {
      const response = await fetch(source.url, {
        mode: 'cors',
        credentials: 'omit'
      });

      if (!response.ok) {
        if (response.status === 404) {
             const lastSegment = source.url.split('/').pop() || '';
             const isDirectory = source.url.endsWith('/') || lastSegment === '';
             if (isDirectory) {
                 throw new Error(`File not found (404). The URL "${source.url}" appears to be a directory. Please specify a full file path (e.g., ending in .flac or .wav).`);
             }
             throw new Error(`File not found (404). The server could not locate the audio file at "${source.url}".`);
        }
        throw new Error(`Failed to load audio: ${response.status} ${response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      return arrayBuffer;
    } catch (error) {
      console.error('Error loading audio:', error);
      if (error instanceof Error && error.message.includes('File not found')) {
        throw error;
      }
      throw new Error(`Failed to load audio from ${source.url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async loadFromGoogleBucket(bucketUrl: string, filename: string): Promise<ArrayBuffer> {
    const url = `${bucketUrl}/${filename}`;
    return this.loadAudio({ url, type: 'google-bucket', name: filename });
  }

  async loadFromFTP(ftpUrl: string): Promise<ArrayBuffer> {
    return this.loadAudio({ url: ftpUrl, type: 'ftp' });
  }

  async loadFromURL(url: string): Promise<ArrayBuffer> {
    let finalUrl = url;
    let type: 'google-bucket' | 'ftp' | 'http' | 'https' = 'http';

    if (url.startsWith('gs://')) {
        finalUrl = url.replace('gs://', 'https://storage.googleapis.com/');
        type = 'google-bucket';
    } else if (url.startsWith('https')) {
        type = 'https';
    }

    return this.loadAudio({ url: finalUrl, type });
  }

  // =============================================================================
  // Library API Methods
  // =============================================================================

  async fetchLibrary(
    options: {
      limit?: number;
      offset?: number;
      ratingGte?: number;
      ratingLt?: number;
      tags?: string[];
      tagsMatch?: number;
      untagged?: boolean;
      search?: string;
      sortBy?: SortBy;
      sortDesc?: boolean;
      excludeId?: string;
      generationModel?: string;
    } = {}
  ): Promise<{ tracks: PlaylistTrack[]; total: number }> {
    return songApi.fetchSongs(options);
  }

  async fetchSong(songId: string): Promise<PlaylistTrack> {
    return songApi.fetchSong(songId);
  }

  async fetchTags(): Promise<TagInfo[]> {
    return songApi.fetchTags();
  }

  async fetchStats(): Promise<LibraryStats> {
    return songApi.fetchStats();
  }

  async triggerLibraryResync(): Promise<songApi.MusicResyncResult> {
    return songApi.triggerMusicResync();
  }

  async fetchPlaylist(
    sortBy: SortBy = 'date',
    sortDesc: boolean = true,
    genre?: string,
    minRating?: number
  ): Promise<PlaylistTrack[]> {
    try {
      const { tracks } = await this.fetchLibrary({
        sortBy,
        sortDesc,
        ratingGte: minRating,
        limit: 200
      });
      return tracks;
    } catch (error) {
      console.error('Error fetching playlist:', error);
      throw error;
    }
  }

  // =============================================================================
  // Track CRUD
  // =============================================================================

  async recordPlay(musicId: string): Promise<void> {
    return songApi.recordPlay(musicId);
  }

  async updateSampleMetadata(
    musicId: string,
    updates: {
      name?: string;
      title?: string;
      rating?: number;
      description?: string;
      genre?: string;
      tags?: string[];
      last_played?: string;
      generation_model?: string;
      version?: string;
      prompt?: string;
    }
  ): Promise<void> {
    return songApi.updateSampleMetadata(musicId, updates);
  }

  async trashTrack(musicId: string): Promise<void> {
    return songApi.trashTrack(musicId);
  }

  async suggestTags(musicId: string): Promise<{ suggestions: string[]; source: string }> {
    return songApi.suggestTags(musicId);
  }

  // =============================================================================
  // Smart Mix - Find similar tracks
  // =============================================================================

  async findSimilarTracks(
    trackId: string,
    trackTags: string[],
    minRating: number = 4,
    limit: number = 20
  ): Promise<PlaylistTrack[]> {
    try {
      const { tracks } = await this.fetchLibrary({
        tags: trackTags.slice(0, 3), // Use top 3 tags
        tagsMatch: 2, // At least 2 matching tags
        ratingGte: minRating,
        excludeId: trackId,
        limit,
        sortBy: 'random'
      });
      return tracks;
    } catch (error) {
      console.error('Error finding similar tracks:', error);
      return [];
    }
  }

  // =============================================================================
  // Health Check & Diagnostics
  // =============================================================================

  async healthCheck(): Promise<{
    isHealthy: boolean;
    apiBase: string;
    results: Record<string, { status?: number; ok?: boolean; error?: string; duration?: string }>;
  }> {
    return songApi.healthCheck();
  }

  // =============================================================================
  // Legacy Methods (Backward Compatibility)
  // =============================================================================

  async fetchLegacyPlaylist(
    sortBy: SortBy = 'date',
    sortDesc: boolean = true,
    genre?: string,
    minRating?: number
  ): Promise<PlaylistTrack[]> {
    try {
      const apiBase = songApi.getApiBaseUrl();
      const params = new URLSearchParams({ type: 'music', sort_by: sortBy });
      if (sortDesc) params.append('sort_desc', 'true');
      if (genre) params.append('genre', genre);
      if (minRating) params.append('min_rating', minRating.toString());

      const url = `${apiBase}/api/songs?${params}`;
      const response = await fetch(url, {
        mode: 'cors',
        credentials: 'omit'
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch playlist: ${response.status}`);
      }
      
      const data: unknown = await response.json();
      if (!Array.isArray(data)) throw new Error('Legacy playlist response is not an array');
      
      return data
        .filter(isLegacySongRecord)
        .filter((item) => {
          const lowerName = (item.name || item.filename || '').toLowerCase();
          return lowerName.endsWith('.flac') || lowerName.endsWith('.wav');
        })
        .map((item) => ({
          id: item.id,
          name: item.name || item.filename || 'Unknown track',
          url: `${apiBase}/api/music/${item.id}`,
          rating: item.rating,
          description: item.description,
          author: item.author,
          genre: item.genre,
          last_played: item.last_played
        }));
    } catch (error) {
      console.error('Error fetching legacy playlist:', error);
      throw error;
    }
  }

  async fetchSharedPlaylist(shareId: string): Promise<{ title: string; tracks: PlaylistTrack[] }> {
    return songApi.fetchSharedPlaylist(shareId);
  }

  async createShare(
    trackIds: string[],
    title: string = 'Shared Playlist',
    expiresInDays: number = 30
  ): Promise<ShareResponse> {
    return songApi.createShare(trackIds, title, expiresInDays);
  }

  // =============================================================================
  // Cloud Playlists (from contabo_storage_manager)
  // =============================================================================

  private PLAYLIST_API_URL = process.env.REACT_APP_PLAYLIST_API_URL || 'https://storage.noahcohn.com';

  async fetchPlaylists(): Promise<CloudPlaylist[]> {
    try {
      const url = `${this.PLAYLIST_API_URL}/api/playlists`;
      debug.log('FETCH_PLAYLISTS_REQUEST', { url });

      const startTime = performance.now();
      const response = await fetch(url, {
        mode: 'cors',
        credentials: 'omit'
      });
      const endTime = performance.now();

      debug.log('FETCH_PLAYLISTS_RESPONSE', {
        status: response.status,
        ok: response.ok,
        duration: `${(endTime - startTime).toFixed(2)}ms`
      });

      if (!response.ok) {
        debug.warn('FETCH_PLAYLISTS_ERROR', { status: response.status });
        return [];
      }

      const data = await response.json();
      debug.log('FETCH_PLAYLISTS_PARSED', { count: data.length });
      return data;
    } catch (error) {
      debug.error('FETCH_PLAYLISTS_FAILED', {
        message: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  async fetchPlaylistTracks(playlistId: string): Promise<string[]> {
    try {
      const url = `${this.PLAYLIST_API_URL}/api/playlists/${playlistId}`;

      const response = await fetch(url, {
        mode: 'cors',
        credentials: 'omit'
      });

      if (!response.ok) {
        return [];
      }

      const data = await response.json();
      return data.track_ids || [];
    } catch (error) {
      return [];
    }
  }
}
