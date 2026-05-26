import React, { useState, useEffect, useCallback } from 'react';
import {
  isTrackCached,
  downloadForOffline,
  evictTrack,
  getCacheSizeBytes,
} from '../storage/trackCache';
import { PlaylistTrack } from '../audioLoader';

interface OfflineBadgeProps {
  track: PlaylistTrack;
  /** If provided, a download button is shown that will cache the track. */
  onDownload?: (url: string) => void;
  /** If provided, an evict button is shown. */
  onEvict?: (url: string) => void;
}

/**
 * Small indicator/button that shows offline availability for a single track.
 */
export const OfflineBadge: React.FC<OfflineBadgeProps> = ({ track, onDownload, onEvict }) => {
  const [cached, setCached] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    isTrackCached(track.url).then(c => { if (!cancelled) setCached(c); });
    return () => { cancelled = true; };
  }, [track.url]);

  const handleDownload = useCallback(async () => {
    setProgress(0);
    try {
      await downloadForOffline(track.url, p => setProgress(p));
      setCached(true);
      onDownload?.(track.url);
    } catch {
      // silently fail
    } finally {
      setProgress(null);
    }
  }, [track.url, onDownload]);

  const handleEvict = useCallback(async () => {
    await evictTrack(track.url);
    setCached(false);
    onEvict?.(track.url);
  }, [track.url, onEvict]);

  if (progress !== null) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-blue-300" title="Downloading…">
        <span className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
        {Math.round(progress * 100)}%
      </span>
    );
  }

  if (cached) {
    return (
      <button
        onClick={handleEvict}
        className="inline-flex items-center gap-1 text-xs text-green-400 hover:text-red-400 transition-colors"
        title="Available offline – click to remove"
        aria-label="Remove offline cache"
      >
        ✓ Offline
      </button>
    );
  }

  return (
    <button
      onClick={handleDownload}
      className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-blue-300 transition-colors"
      title="Download for offline"
      aria-label="Download for offline"
    >
      ↓ Offline
    </button>
  );
};

// ─── Cache stats panel ───────────────────────────────────────────────────────

interface CacheStatsPanelProps {
  onClearAll: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export const CacheStatsPanel: React.FC<CacheStatsPanelProps> = ({ onClearAll }) => {
  const [sizeBytes, setSizeBytes] = useState(0);

  const refresh = useCallback(() => setSizeBytes(getCacheSizeBytes()), []);

  // Read on mount and refresh every 10 seconds to catch changes from other components
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <div className="flex items-center justify-between text-xs text-gray-400">
      <span>Offline cache: {formatBytes(sizeBytes)} / 500 MB</span>
      {sizeBytes > 0 && (
        <button
          onClick={() => { onClearAll(); setSizeBytes(0); }}
          className="text-red-400 hover:text-red-300 transition-colors"
        >
          Clear all
        </button>
      )}
    </div>
  );
};
