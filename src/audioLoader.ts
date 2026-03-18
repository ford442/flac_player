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
const API_BASE_URL = process.env.REACT_APP_API_URL || 'https://ford442-storage-manager.hf.space';

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
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch library: ${response.status} ${response.statusText}`);
      }
      
      const tracks = await response.json();
      
      // Map to add URLs
      const tracksWithUrls = tracks.map((item: any) => ({
        ...item,
        url: item.url || `${API_BASE_URL}/api/music/${item.id}`
      }));
      
      return { tracks: tracksWithUrls, total: tracks.length };
    } catch (error) {
      console.error('Error fetching library:', error);
      throw error;
    }
  }

  async fetchTags(): Promise<TagInfo[]> {
    try {
      const response = await fetch(`${API_BASE_URL}/api/songs/tags`);
      if (!response.ok) {
        throw new Error(`Failed to fetch tags: ${response.status}`);
      }
      const data = await response.json();
      return data.tags || [];
    } catch (error) {
      console.error('Error fetching tags:', error);
      return [];
    }
  }

  async fetchStats(): Promise<LibraryStats> {
    try {
      const response = await fetch(`${API_BASE_URL}/api/songs/stats`);
      if (!response.ok) {
        throw new Error(`Failed to fetch stats: ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      console.error('Error fetching stats:', error);
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
      await fetch(`${API_BASE_URL}/api/songs/${musicId}/play`, {
        method: 'POST'
      });
    } catch (error) {
      console.warn('Failed to record play:', error);
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
      const response = await fetch(`${API_BASE_URL}/api/songs/${musicId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      
      if (!response.ok) {
        throw new Error(`Failed to update metadata: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      console.error('Error updating metadata:', error);
      throw error;
    }
  }

  async trashTrack(musicId: string): Promise<void> {
    try {
      const response = await fetch(`${API_BASE_URL}/api/songs/${musicId}/trash`, {
        method: 'POST'
      });
      
      if (!response.ok) {
        throw new Error(`Failed to trash track: ${response.status}`);
      }
    } catch (error) {
      console.error('Error trashing track:', error);
      throw error;
    }
  }

  async suggestTags(musicId: string): Promise<{ suggestions: string[]; source: string }> {
    try {
      const response = await fetch(`${API_BASE_URL}/api/songs/${musicId}/suggest-tags`);
      if (!response.ok) {
        throw new Error(`Failed to get suggestions: ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      console.error('Error getting tag suggestions:', error);
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

      const url = `https://ford442-storage-manager.hf.space/api/songs?${params}`;
      const response = await fetch(url);
      
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
          url: `https://ford442-storage-manager.hf.space/api/music/${item.id}`,
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
