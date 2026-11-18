// The folder walk + tag read of a local scan (#284), shared by the scan worker and the
// main-thread fallback. Plain data in and out; no catalog access.

import type { FolderEntry } from '../storage/folderWalk';
import { parseReplayGainFromCommon, replayGainTagsToTrackFields } from '../utils/replayGain';

/** What a scan learns about one file. Plain data: it crosses the worker boundary. */
export interface ScannedFile {
  path: string;
  size: number;
  mtime: number;
  title?: string;
  artist?: string;
  album?: string;
  year?: number;
  genre?: string;
  duration?: number;
  sampleRate?: number;
  bitsPerSample?: number;
  channels?: number;
  codec?: string;
  replaygain_track_db?: number;
  replaygain_album_db?: number;
  replaygain_track_peak?: number;
  replaygain_album_peak?: number;
}

export interface KnownFile { size: number; mtime: number }

export interface ScanCallbacks {
  /** New or changed files, in batches. */
  onFiles(files: ScannedFile[]): void | Promise<void>;
  onProgress?(scanned: number): void;
}

export interface ScanSummary {
  /** Every audio path the walk saw (unchanged ones included). */
  seen: string[];
  changed: number;
}

export type TagReader = (file: File) => Promise<Omit<ScannedFile, 'path' | 'size' | 'mtime'>>;

const BATCH = 50;

/** Tags and stream info from music-metadata; a file it cannot parse still gets a row. */
export const readTags: TagReader = async (file) => {
  try {
    const { parseBlob } = await import('music-metadata');
    const meta = await parseBlob(file, { skipCovers: true });
    const { common, format } = meta;
    return {
      title: common.title || undefined,
      artist: common.artist || common.albumartist || undefined,
      album: common.album || undefined,
      year: common.year || undefined,
      genre: common.genre?.[0] || undefined,
      duration: format.duration || undefined,
      sampleRate: format.sampleRate || undefined,
      bitsPerSample: format.bitsPerSample || undefined,
      channels: format.numberOfChannels || undefined,
      codec: format.codec || format.container || undefined,
      ...replayGainTagsToTrackFields(parseReplayGainFromCommon(common)),
    };
  } catch {
    return {};
  }
};

export async function scanFolderEntries(
  entries: AsyncIterable<FolderEntry> | Iterable<FolderEntry>,
  known: ReadonlyMap<string, KnownFile>,
  callbacks: ScanCallbacks,
  { readTags: read = readTags, signal }: { readTags?: TagReader; signal?: AbortSignal } = {},
): Promise<ScanSummary> {
  const seen: string[] = [];
  let batch: ScannedFile[] = [];
  let changed = 0;
  for await (const entry of entries) {
    if (signal?.aborted) throw new DOMException('Scan aborted', 'AbortError');
    const file = await entry.getFile();
    seen.push(entry.path);
    const previous = known.get(entry.path);
    if (!previous || previous.size !== file.size || previous.mtime !== file.lastModified) {
      batch.push({ path: entry.path, size: file.size, mtime: file.lastModified, ...await read(file) });
      changed++;
      if (batch.length >= BATCH) {
        await callbacks.onFiles(batch);
        batch = [];
      }
    }
    if (seen.length % 25 === 0) callbacks.onProgress?.(seen.length);
  }
  if (batch.length > 0) await callbacks.onFiles(batch);
  callbacks.onProgress?.(seen.length);
  return { seen, changed };
}
