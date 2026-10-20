// src/components/MetadataPanel.tsx
// Displays rich metadata with dark/light theme toggle.
// Tags/specs/cover art come from useTrackMetadata (ranged header reads, persisted cache).
import { useState } from 'react';
import { ownsFile, useTrackMetadata } from '../hooks/useTrackMetadata';
import { formatChannelCount, formatDuration } from '../utils/trackMetadata';
import './MetadataPanel.css';

interface TrackInfo {
  title?: string;
  artist?: string;
  album?: string;
  duration?: number;
  coverUrl?: string;
  cacheKey?: string;
  generationModel?: string;
  version?: string;
  prompt?: string;
}

interface MetadataPanelProps {
  file?: File;
  audioUrl?: string;
  sampleRate?: number;
  bitDepth?: number;
  channels?: number;
  trackInfo?: TrackInfo;
}

export const MetadataPanel: React.FC<MetadataPanelProps> = ({
  file,
  audioUrl,
  sampleRate: sampleRateProp,
  bitDepth: bitDepthProp = 16,
  channels: channelsProp = 2,
  trackInfo,
}) => {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  // The controller's currentFile outlives the local track it belongs to; only trust it for blob: URLs.
  const localFile = ownsFile(audioUrl, file) ? file : undefined;
  const cacheKey = trackInfo?.cacheKey || (localFile ? `file:${localFile.name}:${localFile.size}:${localFile.lastModified}` : audioUrl ? `url:${audioUrl}` : undefined);
  const { metadata: parsed, artworkUrl, isLoading } = useTrackMetadata(
    cacheKey ? { cacheKey, url: audioUrl, file: localFile } : null
  );
  const tags = parsed?.tags;
  const formatSpecs = parsed?.specs;
  const albumArt = artworkUrl ?? trackInfo?.coverUrl ?? null;

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  const isDark = theme === 'dark';
  const fallbackUrlTitle = audioUrl ? decodeURIComponent(audioUrl.split('/').pop() || '').replace(/\.[^/.]+$/, '') : '';
  const displayTitle = tags?.title || trackInfo?.title || localFile?.name?.replace(/\.[^/.]+$/, '') || fallbackUrlTitle || 'Unknown Track';
  const displayArtist = tags?.artist || trackInfo?.artist || 'Unknown Artist';
  const displayAlbum = tags?.album || trackInfo?.album || '';
  const displayTrackNumber = tags?.trackNo || undefined;

  // Prefer values from parsed format, fall back to props
  const displaySampleRate = formatSpecs?.sampleRate ?? sampleRateProp;
  const displayBitDepth = formatSpecs?.bitsPerSample ?? bitDepthProp;
  const displayChannels = formatSpecs?.channels ?? channelsProp;
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
            {typeof tags?.year === 'number' && <span>{tags.year}</span>}
            {trackInfo?.generationModel && <span className="ai-model-badge">{trackInfo.generationModel}{trackInfo.version ? ` · ${trackInfo.version}` : ''}</span>}
          </div>
          {trackInfo?.prompt && (
            <details className="generation-prompt">
              <summary>Generation prompt</summary>
              <p>{trackInfo.prompt}</p>
            </details>
          )}
        </div>
      </div>
    </div>
  );
};

export default MetadataPanel;
