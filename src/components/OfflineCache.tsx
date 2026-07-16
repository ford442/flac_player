import React, { useState, useEffect, useCallback } from 'react';
import {
  isTrackCached,
  downloadForOffline,
  evictTrack,
  getCacheSizeBytes,
  onCacheEviction,
  MAX_CACHE_BYTES,
  type EvictionEvent,
} from '../storage/trackCache';
import {
  canUseBackgroundDownloads,
  downloadTrackViaSW,
  cancelBackgroundDownload,
} from '../sw/serviceWorkerClient';
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
  const [requestId, setRequestId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    isTrackCached(track.url).then(c => { if (!cancelled) setCached(c); });
    return () => { cancelled = true; };
  }, [track.url]);

  const handleDownload = useCallback(async () => {
    setProgress(0);
    try {
      if (canUseBackgroundDownloads()) {
        const { requestId: id, promise } = downloadTrackViaSW(track.url, p => setProgress(p));
        setRequestId(id);
        await promise;
      } else {
        await downloadForOffline(track.url, p => setProgress(p));
      }
      setCached(true);
      onDownload?.(track.url);
    } catch {
      // silently fail
    } finally {
      setRequestId(null);
      setProgress(null);
    }
  }, [track.url, onDownload]);

  const handleCancel = useCallback(() => {
    if (requestId) cancelBackgroundDownload(requestId);
    setRequestId(null);
    setProgress(null);
  }, [requestId]);

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
        {requestId && (
          <button
            type="button"
            onClick={handleCancel}
            className="text-gray-500 hover:text-red-400 ml-1"
            title="Cancel download"
            aria-label="Cancel download"
          >
            ✕
          </button>
        )}
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
  /** Optional toast when LRU eviction frees space. */
  onEviction?: (event: EvictionEvent) => void;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export const CacheStatsPanel: React.FC<CacheStatsPanelProps> = ({ onClearAll, onEviction }) => {
  const [sizeBytes, setSizeBytes] = useState(0);
  const [evictionNote, setEvictionNote] = useState<string | null>(null);

  const refresh = useCallback(() => setSizeBytes(getCacheSizeBytes()), []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    return onCacheEviction((event) => {
      refresh();
      onEviction?.(event);
      const count = event.evictedUrls.length;
      setEvictionNote(
        `Freed ${formatBytes(event.freedBytes)} — removed ${count} oldest track${count === 1 ? '' : 's'} to stay under ${formatBytes(MAX_CACHE_BYTES)}`
      );
    });
  }, [refresh, onEviction]);

  const usagePct = Math.min(100, Math.round((sizeBytes / MAX_CACHE_BYTES) * 100));

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-gray-400">
        <span>Offline cache: {formatBytes(sizeBytes)} / {formatBytes(MAX_CACHE_BYTES)}</span>
        {sizeBytes > 0 && (
          <button
            onClick={() => { onClearAll(); setSizeBytes(0); setEvictionNote(null); }}
            className="text-red-400 hover:text-red-300 transition-colors"
          >
            Clear all
          </button>
        )}
      </div>
      <div
        className="h-1 rounded-full bg-white/10 overflow-hidden"
        role="progressbar"
        aria-valuenow={usagePct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Offline cache usage"
      >
        <div
          className={`h-full transition-all ${usagePct >= 90 ? 'bg-amber-400' : 'bg-cyan-400'}`}
          style={{ width: `${usagePct}%` }}
        />
      </div>
      {evictionNote && (
        <p className="text-xs text-amber-300/90" role="status">
          {evictionNote}
        </p>
      )}
      {canUseBackgroundDownloads() && (
        <p className="text-xs text-gray-500">Background downloads enabled via service worker</p>
      )}
    </div>
  );
};
