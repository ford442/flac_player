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
        throw new Error(`Failed to load audio: ${response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      return arrayBuffer;
    } catch (error) {
      console.error('Error loading audio:', error);
      throw new Error(`Failed to load audio from ${source.url}`);
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
    const type = url.startsWith('https') ? 'https' : 'http';
    return this.loadAudio({ url, type });
  }
}
