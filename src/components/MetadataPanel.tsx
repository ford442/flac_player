// src/components/MetadataPanel.tsx
// Displays rich metadata with dark/light theme toggle.
import { useEffect, useState } from 'react';
import { parseBlob } from 'music-metadata-browser';
import './MetadataPanel.css';

interface MetadataPanelProps {
  file?: File;
  audioUrl?: string;
  sampleRate?: number;
  bitDepth?: number;
  channels?: number;
}

function uint8ArrayToBase64(data: Uint8Array): string {
  let binary = '';
  const len = data.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}

export const MetadataPanel: React.FC<MetadataPanelProps> = ({
  file,
  audioUrl,
  sampleRate,
  bitDepth = 16,
  channels = 2,
}) => {
  const [metadata, setMetadata] = useState<Record<string, unknown> | null>(null);
  const [albumArt, setAlbumArt] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  useEffect(() => {
    let cancelled = false;

    const loadMetadata = async () => {
      setIsLoading(true);
      let blob: Blob | undefined;

      if (file) {
        blob = file;
      } else if (audioUrl) {
        try {
          const res = await fetch(audioUrl);
          blob = await res.blob();
        } catch {
          console.warn('Failed to fetch for metadata');
        }
      }

      if (!blob) {
        setIsLoading(false);
        return;
      }

      try {
        const meta = await parseBlob(blob);
        if (cancelled) return;
        setMetadata(meta.common as unknown as Record<string, unknown>);

        const pictures = (meta.common as unknown as Record<string, unknown>).picture as Array<{ format: string; data: Uint8Array }> | undefined;
        if (pictures?.[0]) {
          const pic = pictures[0];
          const base64 = `data:${pic.format};base64,${uint8ArrayToBase64(pic.data)}`;
          setAlbumArt(base64);
        } else {
          setAlbumArt(null);
        }
      } catch (e) {
        console.warn('Metadata parsing failed', e);
        setMetadata(null);
        setAlbumArt(null);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    loadMetadata();

    return () => { cancelled = true; };
  }, [file, audioUrl]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  const isDark = theme === 'dark';
  const displayTitle = (metadata?.title as string) || file?.name?.replace(/\.[^/.]+$/, '') || 'Unknown Track';
  const displayArtist = (metadata?.artist as string) || 'Unknown Artist';
  const displayAlbum = (metadata?.album as string) || '';

  return (
    <div
      className={`metadata-panel ${isDark ? 'dark' : 'light'}`}
      role="region"
      aria-label="Now Playing - Track Information"
    >
      <div className="panel-header">
        <span className="now-playing-label">NOW PLAYING</span>
        <button
          onClick={toggleTheme}
          className="theme-toggle"
          aria-label={`Switch to ${isDark ? 'light' : 'dark'} mode`}
          title={`Switch to ${isDark ? 'light' : 'dark'} mode`}
        >
          {isDark ? '☀︎' : '☾'}
        </button>
      </div>

      <div className="content">
        <div className="album-art-container">
          {isLoading ? (
            <div className="album-art-placeholder loading">
              <span>Loading cover...</span>
            </div>
          ) : albumArt ? (
            <img
              src={albumArt}
              alt={`${displayTitle} - ${displayArtist} album cover`}
              className="album-art"
            />
          ) : (
            <div className="album-art-placeholder">
              <span>♪</span>
              <p>No Cover</p>
            </div>
          )}
        </div>

        <div className="track-info">
          <h3 className="track-title">{displayTitle}</h3>
          <p className="track-artist">{displayArtist}</p>
          {displayAlbum && <p className="track-album">{displayAlbum}</p>}

          <div className="audio-specs">
            {sampleRate && <span>{(sampleRate / 1000).toFixed(1)} kHz</span>}
            <span>{bitDepth} bit</span>
            <span>{channels} ch</span>
            {metadata?.year && <span>{String(metadata.year)}</span>}
          </div>
        </div>
      </div>
    </div>
  );
};

export default MetadataPanel;
