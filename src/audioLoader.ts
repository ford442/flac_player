// Audio loader for Google Cloud Storage and FTP sources
export interface AudioSource {
  url: string;
  type: 'google-bucket' | 'ftp' | 'http' | 'https';
  name?: string;
}

export interface PlaylistTrack {
  id: string;
  name: string;
  url: string;
  rating?: number;
  description?: string;
  author?: string;
  genre?: string;
  last_played?: string;
  type?: string;  // For debugging
}

export type SortBy = 'date' | 'rating' | 'name' | 'last_played' | 'genre';
export type RepeatMode = 'off' | 'one' | 'all';

interface ApiFile {
  filename: string;
  size: number;
  updated: string;
  url: string;
}

interface ApiResponse {
  folder: string;
  count: number;
  files: ApiFile[];
}

export class AudioLoader {
  async loadAudio(source: AudioSource): Promise<ArrayBuffer> {
    try {
      // For browser-based loading, we'll use fetch for all sources
      // CORS must be properly configured on the source server
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
      // Re-throw if it's already our custom error
      if (error instanceof Error && error.message.includes('File not found')) {
        throw error;
      }
      throw new Error(`Failed to load audio from ${source.url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async loadFromGoogleBucket(bucketUrl: string, filename: string): Promise<ArrayBuffer> {
    // Google Cloud Storage URLs typically follow this pattern:
    // https://storage.googleapis.com/bucket-name/file-path
    const url = `${bucketUrl}/${filename}`;
    return this.loadAudio({ url, type: 'google-bucket', name: filename });
  }

  async loadFromFTP(ftpUrl: string): Promise<ArrayBuffer> {
    // FTP URLs need to be proxied through HTTP/HTTPS for browser access
    // The URL should already be in a browser-accessible format
    return this.loadAudio({ url: ftpUrl, type: 'ftp' });
  }

  async loadFromURL(url: string): Promise<ArrayBuffer> {
    let finalUrl = url;
    let type: 'google-bucket' | 'ftp' | 'http' | 'https' = 'http';

    if (url.startsWith('gs://')) {
        // Convert gs://bucket/path to https://storage.googleapis.com/bucket/path
        finalUrl = url.replace('gs://', 'https://storage.googleapis.com/');
        type = 'google-bucket';
    } else if (url.startsWith('https')) {
        type = 'https';
    }

    return this.loadAudio({ url: finalUrl, type });
  }

  async fetchPlaylist(
    sortBy: SortBy = 'date',
    sortDesc: boolean = true,
    genre?: string,
    minRating?: number
  ): Promise<PlaylistTrack[]> {
    try {
      // First check health
      const healthRes = await fetch('https://ford442-storage-manager.hf.space/api/health');
      if (healthRes.ok) {
        const health = await healthRes.json();
        console.log('Storage manager health:', health);
      }

      // Build query params
      const params = new URLSearchParams({ type: 'music', sort_by: sortBy });
      if (sortDesc) params.append('sort_desc', 'true');
      if (genre) params.append('genre', genre);
      if (minRating) params.append('min_rating', minRating.toString());

      const url = `https://ford442-storage-manager.hf.space/api/songs?${params}`;
      console.log('Fetching playlist from:', url);

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch playlist: ${response.status} ${response.statusText}`);
      }
      const data = await response.json();
      console.log('Raw API response:', data);
      console.log('Number of items:', data.length);

      // Map API response to PlaylistTrack format
      const tracks: PlaylistTrack[] = data
        .filter((item: any) => {
          const lowerName = (item.name || item.filename || '').toLowerCase();
          const isAudio = lowerName.endsWith('.flac') || lowerName.endsWith('.wav');
          if (!isAudio) {
            console.log('Filtering out (not audio):', item.name || item.filename);
          }
          return isAudio;
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

      console.log('Filtered tracks:', tracks.length);
      return tracks;
    } catch (error) {
      console.error('Error fetching playlist:', error);
      throw error;
    }
  }

  async recordPlay(musicId: string): Promise<void> {
    try {
      // Use the update endpoint to set last_played
      await fetch(`https://ford442-storage-manager.hf.space/api/music/${musicId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ last_played: new Date().toISOString() })
      });
    } catch (error) {
      // Silently fail - play recording is not critical
      console.warn('Failed to record play:', error);
    }
  }

  async updateSampleMetadata(musicId: string, updates: { name?: string; rating?: number; description?: string; genre?: string; last_played?: string }): Promise<void> {
    try {
      const response = await fetch(`https://ford442-storage-manager.hf.space/api/music/${musicId}`, {
        method: 'PUT',
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
}
