// Local folder → catalog scan (#284). Incremental by (path, size, mtime): unchanged files
// are only stat'ed, changed and new ones are tag-read with music-metadata (no audio
// decode, no copy), and rows for files that are gone are deleted once the walk completes.
//
// `scanFolderEntries` (folderScanCore.ts) is the walk itself; it runs in
// `workers/libraryScanWorker.ts` and, where workers are unavailable (tests), on the main
// thread. `scanLocalFolder` applies its output to IndexedDB.

import { getCatalogDb, type CatalogDb, type CatalogTrack } from './db';
import { rebuildAggregates } from './aggregates';
import { folderAccess, folderRows, sessionFolderEntries, type LocalFolderSource } from '../storage/localLibrary';
import { walkDirectory } from '../storage/folderWalk';
import { localTrackId, localTrackUrl } from '../types/track';
import { scanFolderEntries, type KnownFile, type ScanCallbacks, type ScannedFile, type ScanSummary } from './folderScanCore';

export type { KnownFile, ScanCallbacks, ScannedFile, ScanSummary } from './folderScanCore';

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const stripExtension = (name: string) => name.replace(/\.[^/.]+$/, '');

export function toLocalCatalogTrack(folderId: string, file: ScannedFile, previous?: Pick<CatalogTrack, 'addedAt'>, now = Date.now()): CatalogTrack {
  const { path, size, mtime, ...tags } = file;
  const name = basename(path);
  return {
    ...tags,
    id: localTrackId(folderId, path),
    source: 'local',
    sourceId: `${folderId}:${path}`,
    name,
    title: tags.title || stripExtension(name),
    author: tags.artist,
    url: localTrackUrl(folderId, path),
    local: { folderId, path, size, mtime },
    addedAt: previous?.addedAt ?? now,
  };
}

export interface FolderScanResult {
  scanned: number;
  changed: number;
  removed: number;
}

/** Runs the walk (worker or inline) and reports what it found; the caller writes the catalog. */
export type FolderWalker = (
  source: LocalFolderSource,
  known: ReadonlyMap<string, KnownFile>,
  callbacks: ScanCallbacks,
  signal?: AbortSignal,
) => Promise<ScanSummary>;

/** The walk on this thread: the folder handle, else this page's fallback files. */
export const walkInline: FolderWalker = (source, known, callbacks, signal) => {
  const entries = source.handle ? walkDirectory(source.handle) : sessionFolderEntries(source.id);
  if (!entries) throw new Error(`Pick the folder "${source.label}" again to scan it.`);
  return scanFolderEntries(entries, known, callbacks, { signal });
};

/**
 * Scan one folder into the catalog. Throws when the folder is not readable right now
 * (permission not granted, fallback files gone): the UI shows Reconnect instead.
 */
export async function scanLocalFolder(
  source: LocalFolderSource,
  {
    db = getCatalogDb(),
    walk = walkInline,
    signal,
    onProgress,
  }: { db?: CatalogDb; walk?: FolderWalker; signal?: AbortSignal; onProgress?: (scanned: number) => void } = {},
): Promise<FolderScanResult> {
  const access = await folderAccess(source);
  if (access !== 'granted') {
    throw new Error(access === 'unavailable'
      ? `Pick the folder "${source.label}" again to scan it.`
      : `Access to "${source.label}" needs to be granted again.`);
  }

  const known = new Map<string, KnownFile>();
  const addedAt = new Map<string, number>();
  await folderRows(db, source.id).each((row) => {
    if (!row.local) return;
    known.set(row.local.path, { size: row.local.size, mtime: row.local.mtime });
    addedAt.set(row.local.path, row.addedAt);
  });

  const startedAt = Date.now();
  const summary = await walk(source, known, {
    onFiles: async (files) => {
      await db.tracks.bulkPut(files.map((f) => {
        const at = addedAt.get(f.path);
        return toLocalCatalogTrack(source.id, f, at === undefined ? undefined : { addedAt: at });
      }));
    },
    onProgress: (scanned) => {
      onProgress?.(scanned);
      void db.scanState.put({ sourceId: source.id, scanned, updatedAt: Date.now() }).catch(() => {});
    },
  }, signal);

  const seen = new Set(summary.seen);
  const gone = [...known.keys()].filter((path) => !seen.has(path));
  await db.transaction('rw', db.tracks, db.sources, db.scanState, async () => {
    await db.tracks.bulkDelete(gone.map((path): [string, string] => ['local', `${source.id}:${path}`]));
    // Re-read: the handle on the row may have been refreshed by a re-pick during the scan.
    const current = await db.sources.get(source.id);
    if (current) await db.sources.put({ ...current, trackCount: seen.size, lastSyncAt: startedAt });
    await db.scanState.put({ sourceId: source.id, scanned: seen.size, total: seen.size, updatedAt: Date.now() });
  });
  await rebuildAggregates(db);
  return { scanned: seen.size, changed: summary.changed, removed: gone.length };
}
