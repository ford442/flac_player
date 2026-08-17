/**
 * Client-side MP3 ↔ FLAC convert & download tool (ffmpeg.wasm).
 * Files never leave the browser.
 */
import React, { useCallback, useRef, useState } from 'react';
import {
  detectConvertDirection,
  directionLabel,
  formatBytes,
  triggerDownload,
  type ConvertDirection,
  type Mp3Bitrate,
} from '../utils/convertFileNames';

type ItemStatus = 'queued' | 'loading' | 'converting' | 'done' | 'error' | 'skipped';

interface ConvertItem {
  id: string;
  file: File;
  direction: ConvertDirection | null;
  status: ItemStatus;
  progress: number;
  error?: string;
  outputName?: string;
}

const MAX_FILE_BYTES = 100 * 1024 * 1024; // soft warning threshold

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export const ConvertPanel: React.FC = () => {
  const [items, setItems] = useState<ConvertItem[]>([]);
  const [mp3Bitrate, setMp3Bitrate] = useState<Mp3Bitrate>('320k');
  const [isBusy, setIsBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const updateItem = useCallback((id: string, patch: Partial<ConvertItem>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }, []);

  const addFiles = useCallback((files: File[]) => {
    const next: ConvertItem[] = [];
    for (const file of files) {
      const direction = detectConvertDirection(file);
      if (!direction) {
        next.push({
          id: makeId(),
          file,
          direction: null,
          status: 'skipped',
          progress: 0,
          error: 'Only .mp3 and .flac files are supported',
        });
        continue;
      }
      next.push({
        id: makeId(),
        file,
        direction,
        status: 'queued',
        progress: 0,
      });
    }
    if (next.length > 0) {
      setItems((prev) => [...prev, ...next]);
      setLoadError(null);
    }
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length) addFiles(files);
    },
    [addFiles]
  );

  const onFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      if (files.length) addFiles(files);
      e.target.value = '';
    },
    [addFiles]
  );

  const clearDone = useCallback(() => {
    setItems((prev) => prev.filter((it) => it.status !== 'done' && it.status !== 'skipped'));
  }, []);

  const clearAll = useCallback(() => {
    if (isBusy) return;
    setItems([]);
    setStatusMessage(null);
    setLoadError(null);
  }, [isBusy]);

  const convertAll = useCallback(async () => {
    const pending = items.filter((it) => it.status === 'queued' || it.status === 'error');
    if (pending.length === 0 || isBusy) return;

    setIsBusy(true);
    setLoadError(null);

    try {
      const { convertAudioFile, ensureFfmpegLoaded } = await import('../audio/convert/ffmpegConverter');

      try {
        await ensureFfmpegLoaded((msg) => setStatusMessage(msg));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setLoadError(`Failed to load converter: ${message}`);
        setStatusMessage(null);
        setIsBusy(false);
        return;
      }

      for (const item of pending) {
        if (!item.direction) {
          updateItem(item.id, { status: 'skipped', error: 'Unsupported format' });
          continue;
        }

        if (item.file.size > MAX_FILE_BYTES) {
          // Still attempt, but surface a soft note in status.
          setStatusMessage(
            `Converting large file (${formatBytes(item.file.size)}) — this may use a lot of memory…`
          );
        }

        updateItem(item.id, { status: 'converting', progress: 0, error: undefined });
        setStatusMessage(`Converting ${item.file.name}…`);

        try {
          const result = await convertAudioFile(item.file, item.file.name, {
            direction: item.direction,
            mp3Bitrate,
            onProgress: (ratio) => updateItem(item.id, { progress: ratio }),
          });
          triggerDownload(result.data, result.outputName, result.mimeType);
          updateItem(item.id, {
            status: 'done',
            progress: 1,
            outputName: result.outputName,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          updateItem(item.id, { status: 'error', error: message, progress: 0 });
        }
      }

      setStatusMessage('Done');
    } finally {
      setIsBusy(false);
    }
  }, [items, isBusy, mp3Bitrate, updateItem]);

  const queuedCount = items.filter((it) => it.status === 'queued' || it.status === 'error').length;
  const hasFlacToMp3 = items.some((it) => it.direction === 'flac-to-mp3');

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white">Convert audio</h2>
        <p className="text-sm text-gray-400 mt-1">
          Convert local MP3 ↔ FLAC in your browser, then download the result. Files never leave your device.
        </p>
      </div>

      <div className="bg-cyan-950/30 border border-cyan-500/20 rounded-xl px-4 py-3 text-sm text-cyan-100/90 space-y-1">
        <p>
          The converter loads once in the browser (~25MB). After that, conversions stay offline for this session.
        </p>
        <p className="text-xs text-gray-400">
          MP3 → FLAC stores the same audio without further loss; it does not restore quality already lost in MP3.
        </p>
      </div>

      {loadError && (
        <div className="bg-red-950/40 border border-red-500/30 rounded-xl px-4 py-3 text-sm text-red-200" role="alert">
          {loadError}
        </div>
      )}

      <div
        onDrop={onDrop}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setIsDragging(false);
        }}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
        }}
        role="button"
        tabIndex={0}
        aria-label="Drop MP3 or FLAC files, or click to browse"
        className={`p-6 border-2 border-dashed rounded-xl transition-colors cursor-pointer text-center ${
          isDragging
            ? 'border-purple-400 bg-purple-500/10'
            : 'border-white/20 bg-white/5 hover:border-white/40 hover:bg-white/10'
        }`}
      >
        <p className="text-sm text-gray-300">Drop MP3 or FLAC files here</p>
        <p className="text-xs text-gray-500 mt-1">or click to browse — multiple files supported</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".mp3,.flac,audio/mpeg,audio/mp3,audio/flac,audio/x-flac"
          onChange={onFileInput}
          className="hidden"
          aria-hidden="true"
        />
      </div>

      {hasFlacToMp3 && (
        <div className="bg-white/5 rounded-xl p-4 border border-white/10 flex flex-wrap items-center gap-4">
          <label className="text-xs text-gray-500 uppercase tracking-wider" htmlFor="mp3-bitrate">
            MP3 bitrate
          </label>
          <select
            id="mp3-bitrate"
            value={mp3Bitrate}
            onChange={(e) => setMp3Bitrate(e.target.value as Mp3Bitrate)}
            disabled={isBusy}
            className="px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-sm text-white"
          >
            <option value="128k">128 kbps</option>
            <option value="192k">192 kbps</option>
            <option value="256k">256 kbps</option>
            <option value="320k">320 kbps (default)</option>
          </select>
        </div>
      )}

      {items.length > 0 && (
        <div className="bg-white/5 rounded-xl border border-white/10 overflow-hidden">
          <ul className="divide-y divide-white/10">
            {items.map((item) => (
              <li key={item.id} className="px-4 py-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-white truncate" title={item.file.name}>
                    {item.file.name}
                  </div>
                  <div className="text-xs text-gray-500 flex flex-wrap gap-x-2">
                    <span>{formatBytes(item.file.size)}</span>
                    {item.direction && <span>{directionLabel(item.direction)}</span>}
                    {item.outputName && item.status === 'done' && (
                      <span className="text-green-400">→ {item.outputName}</span>
                    )}
                    {item.error && <span className="text-red-400">{item.error}</span>}
                  </div>
                  {(item.status === 'converting' || item.status === 'loading') && (
                    <div className="mt-2 h-1.5 bg-white/10 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-purple-500 transition-all duration-150"
                        style={{ width: `${Math.round(item.progress * 100)}%` }}
                      />
                    </div>
                  )}
                </div>
                <div className="text-xs shrink-0 mt-1 sm:mt-0">
                  <StatusBadge status={item.status} progress={item.progress} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void convertAll()}
          disabled={isBusy || queuedCount === 0}
          className="px-4 py-2 bg-purple-500/30 text-purple-100 rounded-lg hover:bg-purple-500/40 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium transition-colors"
        >
          {isBusy ? 'Converting…' : `Convert & download${queuedCount ? ` (${queuedCount})` : ''}`}
        </button>
        <button
          type="button"
          onClick={clearDone}
          disabled={isBusy || !items.some((it) => it.status === 'done' || it.status === 'skipped')}
          className="px-3 py-2 bg-white/10 text-gray-300 rounded-lg hover:bg-white/20 disabled:opacity-40 text-sm transition-colors"
        >
          Clear finished
        </button>
        <button
          type="button"
          onClick={clearAll}
          disabled={isBusy || items.length === 0}
          className="px-3 py-2 bg-white/10 text-gray-300 rounded-lg hover:bg-white/20 disabled:opacity-40 text-sm transition-colors"
        >
          Clear all
        </button>
      </div>

      {statusMessage && (
        <p className="text-xs text-gray-400" role="status" aria-live="polite">
          {statusMessage}
        </p>
      )}
    </div>
  );
};

const StatusBadge: React.FC<{ status: ItemStatus; progress: number }> = ({ status, progress }) => {
  const map: Record<ItemStatus, { label: string; className: string }> = {
    queued: { label: 'Queued', className: 'text-gray-400' },
    loading: { label: 'Loading…', className: 'text-cyan-300' },
    converting: {
      label: `${Math.round(progress * 100)}%`,
      className: 'text-purple-300',
    },
    done: { label: 'Downloaded', className: 'text-green-400' },
    error: { label: 'Error', className: 'text-red-400' },
    skipped: { label: 'Skipped', className: 'text-yellow-500' },
  };
  const { label, className } = map[status];
  return <span className={`font-medium ${className}`}>{label}</span>;
};

export default ConvertPanel;
