// src/components/MetadataPanel.tsx
// Displays rich metadata with dark/light theme toggle.
import { useEffect, useState } from 'react';
import { parseBlob } from 'music-metadata-browser';
import './MetadataPanel.css';

interface TrackInfo {
  title?: string;
  artist?: string;
  album?: string;
  duration?: number;
  coverUrl?: string;
  cacheKey?: string;
}

interface MetadataPanelProps {
  file?: File;
  audioUrl?: string;
  sampleRate?: number;
  bitDepth?: number;
  channels?: number;
  trackInfo?: TrackInfo;
}

function uint8ArrayToBase64(data: Uint8Array): string {
  let binary = '';
  const len = data.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}

interface AudioFormatSpecs {
  sampleRate?: number;
  bitsPerSample?: number;
  numberOfChannels?: number;
  container?: string;
  codec?: string;
  bitrate?: number;
  duration?: number;
}

interface MetadataCacheEntry {
  metadata: Record<string, unknown> | null;
  formatSpecs: AudioFormatSpecs | null;
  albumArt: string | null;
  cachedAt: number;
}

const metadataCache = new Map<string, MetadataCacheEntry>();
const METADATA_CACHE_TTL_MS = 5 * 60 * 1000;

interface TrackMetadata {
  no?: number;
}

function formatChannelCount(channels: number): string {
  if (channels === 1) return 'Mono';
  if (channels === 2) return 'Stereo';
  return `${channels}ch`;
}

function formatDuration(seconds?: number): string | undefined {
  if (!seconds || !isFinite(seconds) || seconds <= 0) return undefined;
  const rounded = Math.floor(seconds);
  const mins = Math.floor(rounded / 60);
  const secs = rounded % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export const MetadataPanel: React.FC<MetadataPanelProps> = ({
  file,
  audioUrl,
  sampleRate: sampleRateProp,
  bitDepth: bitDepthProp = 16,
  channels: channelsProp = 2,
  trackInfo,
}) => {
  const [metadata, setMetadata] = useState<Record<string, unknown> | null>(null);
  const [formatSpecs, setFormatSpecs] = useState<AudioFormatSpecs | null>(null);
  const [albumArt, setAlbumArt] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const cacheKey = trackInfo?.cacheKey || (file ? `file:${file.name}:${file.size}:${file.lastModified}` : audioUrl ? `url:${audioUrl}` : undefined);

  useEffect(() => {
    let cancelled = false;

    const loadMetadata = async () => {
      if (cacheKey) {
        const cached = metadataCache.get(cacheKey);
        if (cached) {
          if ((Date.now() - cached.cachedAt) > METADATA_CACHE_TTL_MS) {
            metadataCache.delete(cacheKey);
          } else {
          setMetadata(cached.metadata);
          setFormatSpecs(cached.formatSpecs);
          setAlbumArt(cached.albumArt);
          setIsLoading(false);
          return;
          }
        }
      }

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
        setMetadata(null);
        setFormatSpecs(null);
        const fallbackArt = trackInfo?.coverUrl || null;
        setAlbumArt(fallbackArt);
        if (cacheKey) {
          metadataCache.set(cacheKey, { metadata: null, formatSpecs: null, albumArt: fallbackArt, cachedAt: Date.now() });
        }
        setIsLoading(false);
        return;
      }

      try {
        const meta = await parseBlob(blob);
        if (cancelled) return;
        const parsedMetadata = meta.common as unknown as Record<string, unknown>;
        const parsedFormat: AudioFormatSpecs = {
          sampleRate: meta.format.sampleRate,
          bitsPerSample: meta.format.bitsPerSample,
          numberOfChannels: meta.format.numberOfChannels,
          container: meta.format.container,
          codec: meta.format.codec,
          bitrate: meta.format.bitrate,
          duration: meta.format.duration,
        };
        setMetadata(parsedMetadata);
        setFormatSpecs(parsedFormat);

        const pictures = parsedMetadata.picture as Array<{ format: string; data: Uint8Array }> | undefined;
        if (pictures?.[0]) {
          const pic = pictures[0];
          const base64 = `data:${pic.format};base64,${uint8ArrayToBase64(pic.data)}`;
          setAlbumArt(base64);
          if (cacheKey) {
            metadataCache.set(cacheKey, {
              metadata: parsedMetadata,
              formatSpecs: parsedFormat,
              albumArt: base64,
              cachedAt: Date.now(),
            });
          }
        } else {
          const fallbackArt = trackInfo?.coverUrl || null;
          setAlbumArt(fallbackArt);
          if (cacheKey) {
            metadataCache.set(cacheKey, {
              metadata: parsedMetadata,
              formatSpecs: parsedFormat,
              albumArt: fallbackArt,
              cachedAt: Date.now(),
            });
          }
        }
      } catch (e) {
        console.warn('Metadata parsing failed', e);
        setMetadata(null);
        setFormatSpecs(null);
        const fallbackArt = trackInfo?.coverUrl || null;
        setAlbumArt(fallbackArt);
        if (cacheKey) {
          metadataCache.set(cacheKey, { metadata: null, formatSpecs: null, albumArt: fallbackArt, cachedAt: Date.now() });
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    loadMetadata();

    return () => { cancelled = true; };
  }, [file, audioUrl, cacheKey]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  const isDark = theme === 'dark';
  const fallbackUrlTitle = audioUrl ? decodeURIComponent(audioUrl.split('/').pop() || '').replace(/\.[^/.]+$/, '') : '';
  const displayTitle = (metadata?.title as string) || trackInfo?.title || file?.name?.replace(/\.[^/.]+$/, '') || fallbackUrlTitle || 'Unknown Track';
  const displayArtist = (metadata?.artist as string) || trackInfo?.artist || 'Unknown Artist';
  const displayAlbum = (metadata?.album as string) || trackInfo?.album || '';
  const displayTrackNumber = ((metadata?.track as TrackMetadata | undefined)?.no) || undefined;

  // Prefer values from parsed format, fall back to props
  const displaySampleRate = formatSpecs?.sampleRate ?? sampleRateProp;
  const displayBitDepth = formatSpecs?.bitsPerSample ?? bitDepthProp;
  const displayChannels = formatSpecs?.numberOfChannels ?? channelsProp;
  const displayFormat = formatSpecs?.container ?? formatSpecs?.codec;
  const displayBitrate = formatSpecs?.bitrate ? Math.round(formatSpecs.bitrate / 1000) : undefined;
  const displayDuration = formatDuration(formatSpecs?.duration ?? trackInfo?.duration);

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
            {displayFormat && <span className="spec-badge">{displayFormat}</span>}
            {displaySampleRate && <span>{(displaySampleRate / 1000).toFixed(1)} kHz</span>}
            {displayBitDepth && <span>{displayBitDepth}-bit</span>}
            {displayChannels && <span>{formatChannelCount(displayChannels)}</span>}
            {displayBitrate && <span>{displayBitrate} kbps</span>}
            {displayTrackNumber && <span>Track {displayTrackNumber}</span>}
            {displayDuration && <span>{displayDuration}</span>}
            {metadata?.year && <span>{String(metadata.year)}</span>}
          </div>
        </div>
      </div>
    </div>
  );
};

export default MetadataPanel;
