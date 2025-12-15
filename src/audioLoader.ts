// Audio loader for Google Cloud Storage and FTP sources
export interface AudioSource {
  url: string;
  type: 'google-bucket' | 'ftp' | 'http' | 'https';
  name?: string;
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
}
