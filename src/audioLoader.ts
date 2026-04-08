// Audio loader for Google Cloud Storage and FTP sources
// Enhanced with AI track support and library management

export interface AudioSource {
  url: string;
  type: 'google-bucket' | 'ftp' | 'http' | 'https';
  name?: string;
}

export interface PlaylistTrack {
  id: string;
  name: string;
  title?: string;
  url: string;
  rating?: number;
  description?: string;
  author?: string;
  genre?: string;
  last_played?: string;
  type?: string;
  // New fields for library management
  duration?: number;
  play_count?: number;
  tags?: string[];
  created_at?: string;
  // AI-generated track fields
  generation_model?: string;
  version?: string;
  prompt?: string;
}

export interface LibraryStats {
  total_tracks: number;
  rated_4plus: number;
  total_duration_hours: number;
  total_play_count: number;
  untagged_count: number;
  trash_count: number;
  unique_tags: number;
  top_tags: { name: string; count: number }[];
}

export interface TagInfo {
  name: string;
  count: number;
}

export type SortBy = 'date' | 'rating' | 'name' | 'last_played' | 'genre' | 'play_count' | 'random';
export type RepeatMode = 'off' | 'one' | 'all';
export type ViewMode = 'library' | 'now-playing' | 'queue' | 'pile';

// API Configuration
// Default to the storage manager API if no env var is set
const API_BASE_URL = process.env.REACT_APP_API_URL || 'https://storage.noahcohn.com';

// Debug mode - set to true to enable detailed logging
const DEBUG_MODE = true;

const debug = {
  log: (label: string, data: any) => {
    if (DEBUG_MODE) console.log(`[FLAC:${label}]`, data);
  },
  error: (label: string, data: any) => {
    if (DEBUG_MODE) console.error(`[FLAC:${label}]`, data);
  },
  warn: (label: string, data: any) => {
    if (DEBUG_MODE) console.warn(`[FLAC:${label}]`, data);
  }
};

export class AudioLoader {
  async loadAudio(source: AudioSource): Promise<ArrayBuffer> {
    try {
      const response = await fetch(source.url, {
        mode: 'cors',
        credentials: 'omit'
      });

      if (!response.ok) {
        if (response.status === 404) {
             const isDirectory = source.url.endsWith('/') || !source.url.split('/').pop()?.includes('.');
             if (isDirectory) {
                 throw new Error(`File not found (404). The URL "${source.url}" appears to be a directory or incomplete path. Please specify a full file path (e.g., ending in .flac or .wav).`);
             }
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
    try {
      const params = new URLSearchParams();

      if (options.limit) params.append('limit', options.limit.toString());
      if (options.offset) params.append('offset', options.offset.toString());
      if (options.ratingGte !== undefined) params.append('rating_gte', options.ratingGte.toString());
      if (options.ratingLt !== undefined) params.append('rating_lt', options.ratingLt.toString());
      if (options.tags?.length) params.append('tags', options.tags.join(','));
      if (options.tagsMatch) params.append('tags_match', options.tagsMatch.toString());
      if (options.untagged) params.append('untagged', 'true');
      if (options.search) params.append('search', options.search);
      if (options.sortBy) params.append('sort_by', options.sortBy);
      if (options.sortDesc !== undefined) params.append('sort_desc', options.sortDesc.toString());
      if (options.excludeId) params.append('exclude_id', options.excludeId);
      if (options.generationModel) params.append('generation_model', options.generationModel);

      const url = `${API_BASE_URL}/api/songs?${params}`;
      debug.log('FETCH_LIBRARY_REQUEST', { url, apiBase: API_BASE_URL, params: Object.fromEntries(params) });

      const startTime = performance.now();
      const response = await fetch(url, {
        mode: 'cors',
        credentials: 'omit'
      });
      const endTime = performance.now();

      debug.log('FETCH_LIBRARY_RESPONSE', {
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        contentType: response.headers.get('content-type'),
        corsOrigin: response.headers.get('access-control-allow-origin'),
        responseUrl: response.url,
        duration: `${(endTime - startTime).toFixed(2)}ms`
      });

      if (!response.ok) {
        const text = await response.text();
        debug.error('FETCH_LIBRARY_ERROR_BODY', { text, status: response.status });
        throw new Error(`Failed to fetch library: ${response.status} ${response.statusText}`);
      }

      const tracks = await response.json();
      debug.log('FETCH_LIBRARY_PARSED', { trackCount: tracks.length });

      // Map to add URLs - use the song's URL or construct from base URL
      const tracksWithUrls = tracks.map((item: any) => ({
        ...item,
        url: item.url ? (item.url.startsWith('http') ? item.url : `${API_BASE_URL}${item.url}`) : `${API_BASE_URL}/api/music/${item.id}`
      });

      return { tracks: tracksWithUrls, total: tracks.length };
    } catch (error) {
      debug.error('FETCH_LIBRARY_FAILED', {
        message: error instanceof Error ? error.message : String(error),
        type: error instanceof TypeError ? 'TypeError (network-level)' : error instanceof Error ? error.constructor.name : 'unknown',
        apiBase: API_BASE_URL,
        stack: error instanceof Error ? error.stack?.split('\n').slice(0, 3) : undefined
      });
      throw error;
    }
  }

  async fetchTags(): Promise<TagInfo[]> {
    try {
      const url = `${API_BASE_URL}/api/songs/tags`;
      debug.log('FETCH_TAGS_REQUEST', { url, apiBase: API_BASE_URL });

      const startTime = performance.now();
      const response = await fetch(url, {
        mode: 'cors',
        credentials: 'omit'
      });
      const endTime = performance.now();

      debug.log('FETCH_TAGS_RESPONSE', {
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        contentType: response.headers.get('content-type'),
        corsOrigin: response.headers.get('access-control-allow-origin'),
        corsAllowMethods: response.headers.get('access-control-allow-methods'),
        responseUrl: response.url,
        duration: `${(endTime - startTime).toFixed(2)}ms`
      });

      if (!response.ok) {
        const text = await response.text();
        debug.error('FETCH_TAGS_ERROR_BODY', { text, status: response.status, statusText: response.statusText });
        throw new Error(`Failed to fetch tags: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      debug.log('FETCH_TAGS_PARSED', { tagCount: data.tags?.length || 0 });
      return data.tags || [];
    } catch (error) {
      debug.error('FETCH_TAGS_FAILED', {
        message: error instanceof Error ? error.message : String(error),
        type: error instanceof TypeError ? 'TypeError (network-level)' : error instanceof Error ? error.constructor.name : 'unknown',
        apiBase: API_BASE_URL,
        url: `${API_BASE_URL}/api/songs/tags`,
        stack: error instanceof Error ? error.stack?.split('\n').slice(0, 3) : undefined
      });
      return [];
    }
  }

  async fetchStats(): Promise<LibraryStats> {
    try {
      const url = `${API_BASE_URL}/api/songs/stats`;
      debug.log('FETCH_STATS_REQUEST', { url, apiBase: API_BASE_URL });

      const startTime = performance.now();
      const response = await fetch(url, {
        mode: 'cors',
        credentials: 'omit'
      });
      const endTime = performance.now();

      debug.log('FETCH_STATS_RESPONSE', {
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        contentType: response.headers.get('content-type'),
        corsOrigin: response.headers.get('access-control-allow-origin'),
        responseUrl: response.url,
        duration: `${(endTime - startTime).toFixed(2)}ms`
      });

      if (!response.ok) {
        const text = await response.text();
        debug.error('FETCH_STATS_ERROR_BODY', { text, status: response.status });
        throw new Error(`Failed to fetch stats: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      debug.log('FETCH_STATS_PARSED', { totalTracks: data.total_tracks });
      return data;
    } catch (error) {
      debug.error('FETCH_STATS_FAILED', {
        message: error instanceof Error ? error.message : String(error),
        type: error instanceof TypeError ? 'TypeError (network-level)' : error instanceof Error ? error.constructor.name : 'unknown',
        apiBase: API_BASE_URL
      });
      // Return default stats on error
      return {
        total_tracks: 0,
        rated_4plus: 0,
        total_duration_hours: 0,
        total_play_count: 0,
        untagged_count: 0,
        trash_count: 0,
        unique_tags: 0,
        top_tags: []
      };
    }
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
    try {
      const url = `${API_BASE_URL}/api/songs/${musicId}/play`;
      debug.log('RECORD_PLAY_REQUEST', { url, musicId });

      const response = await fetch(url, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit'
      });

      debug.log('RECORD_PLAY_RESPONSE', { status: response.status, ok: response.ok });

      if (!response.ok) {
        debug.warn('RECORD_PLAY_ERROR', { status: response.status, musicId });
      }
    } catch (error) {
      debug.warn('RECORD_PLAY_FAILED', {
        message: error instanceof Error ? error.message : String(error),
        musicId
      });
    }
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
    try {
      const url = `${API_BASE_URL}/api/songs/${musicId}`;
      debug.log('UPDATE_METADATA_REQUEST', { url, musicId, updatesKeys: Object.keys(updates) });

      const response = await fetch(url, {
        method: 'PATCH',
        mode: 'cors',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });

      debug.log('UPDATE_METADATA_RESPONSE', { status: response.status, ok: response.ok, musicId });

      if (!response.ok) {
        const text = await response.text();
        debug.error('UPDATE_METADATA_ERROR_BODY', { text, status: response.status });
        throw new Error(`Failed to update metadata: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      debug.error('UPDATE_METADATA_FAILED', {
        message: error instanceof Error ? error.message : String(error),
        musicId
      });
      throw error;
    }
  }

  async trashTrack(musicId: string): Promise<void> {
    try {
      const url = `${API_BASE_URL}/api/songs/${musicId}/trash`;
      debug.log('TRASH_TRACK_REQUEST', { url, musicId });

      const response = await fetch(url, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit'
      });

      debug.log('TRASH_TRACK_RESPONSE', { status: response.status, ok: response.ok, musicId });

      if (!response.ok) {
        throw new Error(`Failed to trash track: ${response.status}`);
      }
    } catch (error) {
      debug.error('TRASH_TRACK_FAILED', {
        message: error instanceof Error ? error.message : String(error),
        musicId
      });
      throw error;
    }
  }

  async suggestTags(musicId: string): Promise<{ suggestions: string[]; source: string }> {
    try {
      const url = `${API_BASE_URL}/api/songs/${musicId}/suggest-tags`;
      debug.log('SUGGEST_TAGS_REQUEST', { url, musicId });

      const response = await fetch(url, {
        mode: 'cors',
        credentials: 'omit'
      });

      debug.log('SUGGEST_TAGS_RESPONSE', { status: response.status, ok: response.ok, musicId });

      if (!response.ok) {
        throw new Error(`Failed to get suggestions: ${response.status}`);
      }
      const data = await response.json();
      debug.log('SUGGEST_TAGS_PARSED', { suggestionCount: data.suggestions?.length });
      return data;
    } catch (error) {
      debug.error('SUGGEST_TAGS_FAILED', {
        message: error instanceof Error ? error.message : String(error),
        musicId
      });
      return { suggestions: [], source: 'error' };
    }
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
    debug.log('HEALTH_CHECK_START', { apiBase: API_BASE_URL });

    const results: Record<string, any> = {};
    const endpoints = [
      { name: 'songs', method: 'GET', path: '/api/songs' },
      { name: 'tags', method: 'GET', path: '/api/songs/tags' },
      { name: 'stats', method: 'GET', path: '/api/songs/stats' }
    ];

    for (const endpoint of endpoints) {
      try {
        const url = `${API_BASE_URL}${endpoint.path}`;
        const startTime = performance.now();

        const response = await fetch(url, {
          method: endpoint.method,
          mode: 'cors',
          credentials: 'omit'
        });

        const endTime = performance.now();
        const duration = endTime - startTime;

        results[endpoint.name] = {
          status: response.status,
          ok: response.ok,
          duration: `${duration.toFixed(2)}ms`,
          contentType: response.headers.get('content-type'),
          corsOrigin: response.headers.get('access-control-allow-origin')
        };

        debug.log(`HEALTH_CHECK_${endpoint.name.toUpperCase()}`, results[endpoint.name]);

        if (!response.ok) {
          const text = await response.text();
          results[endpoint.name].errorBody = text.substring(0, 200); // First 200 chars
        }
      } catch (error) {
        results[endpoint.name] = {
          error: error instanceof Error ? error.message : String(error),
          type: error instanceof TypeError ? 'TypeError (network-level)' : 'Other'
        };
        debug.error(`HEALTH_CHECK_${endpoint.name.toUpperCase()}_ERROR`, results[endpoint.name]);
      }
    }

    const isHealthy = Object.values(results).every((r: any) => !r.error && r.ok);
    debug.log('HEALTH_CHECK_RESULT', { isHealthy, apiBase: API_BASE_URL });

    return {
      isHealthy,
      apiBase: API_BASE_URL,
      results
    };
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
    // Fallback to external storage manager if configured
    try {
      const params = new URLSearchParams({ type: 'music', sort_by: sortBy });
      if (sortDesc) params.append('sort_desc', 'true');
      if (genre) params.append('genre', genre);
      if (minRating) params.append('min_rating', minRating.toString());

      const url = `https://storage.noahcohn.com/api/songs?${params}`;
      const response = await fetch(url, {
        mode: 'cors',
        credentials: 'omit'
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch playlist: ${response.status}`);
      }
      
      const data = await response.json();
      
      return data
        .filter((item: any) => {
          const lowerName = (item.name || item.filename || '').toLowerCase();
          return lowerName.endsWith('.flac') || lowerName.endsWith('.wav');
        })
        .map((item: any) => ({
          id: item.id,
          name: item.name || item.filename,
          url: `${API_BASE_URL}/api/music/${item.id}`,
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
}

// =============================================================================
// Queue Management Utilities
// =============================================================================

const QUEUE_STORAGE_KEY = 'flac_player_queue';

export interface QueueState {
  tracks: PlaylistTrack[];
  currentIndex: number;
  shuffle: boolean;
  repeat: RepeatMode;
}

export function saveQueueToStorage(state: QueueState): void {
  try {
    localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('Failed to save queue:', e);
  }
}

export function loadQueueFromStorage(): QueueState | null {
  try {
    const data = localStorage.getItem(QUEUE_STORAGE_KEY);
    if (data) {
      return JSON.parse(data);
    }
  } catch (e) {
    console.warn('Failed to load queue:', e);
  }
  return null;
}

export function clearQueueStorage(): void {
  localStorage.removeItem(QUEUE_STORAGE_KEY);
}
