// Remote → catalog sync for the library host. Neither the production host nor
// server/ supports `updated_since` (both ignore unknown query params), so this walks
// every page and diffs locally: unchanged rows are not rewritten, and rows the host
// no longer lists are deleted once the walk completes.

import type { PlaylistTrack } from '../types/library';
import { getCatalogDb, sourceRange, type CatalogDb, type CatalogTrack } from './db';
import { rebuildAggregates } from './aggregates';
import { requestPersistentStorageOnce } from './storagePersistence';

export const SYNC_PAGE_SIZE = 1000; // the hosts' maximum `limit`
const MAX_PAGES = 500;
export const LIBRARY_SOURCE_ID = 'library';

export type FetchSongPage = (offset: number, limit: number, signal?: AbortSignal) => Promise<PlaylistTrack[]>;

export interface RemoteSyncResult {
  /** Every row the host listed, in page order (served directly if IndexedDB is unusable). */
  tracks: PlaylistTrack[];
  added: number;
  updated: number;
  removed: number;
  /** False when IndexedDB failed and nothing was written. */
  stored: boolean;
}

interface StoredRow extends CatalogTrack {
  /** Hash of the host's row as last written, to skip unchanged rows. */
  remoteSig?: string;
}

/** FNV-1a over JSON with sorted keys: equal rows hash equally whatever the key order. */
export function rowSignature(track: PlaylistTrack): string {
  const json = JSON.stringify(track, Object.keys(track).sort());
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) h = Math.imul(h ^ json.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36) + json.length.toString(36);
}

export function toCatalogTrack(track: PlaylistTrack, previous?: Pick<CatalogTrack, 'addedAt'>, now = Date.now()): StoredRow {
  const { file: _file, ...row } = track;
  void _file;
  const created = track.created_at ? Date.parse(track.created_at) : NaN;
  return {
    ...row,
    source: 'library',
    sourceId: track.id,
    addedAt: Number.isFinite(created) ? created : previous?.addedAt ?? now,
    remoteSig: rowSignature(track),
  };
}

export async function syncRemoteLibrary(
  fetchPage: FetchSongPage,
  { db = getCatalogDb(), signal }: { db?: CatalogDb; signal?: AbortSignal } = {},
): Promise<RemoteSyncResult> {
  let stored = true;
  const known = new Map<string, { sig?: string; addedAt: number }>();
  try {
    await sourceRange(db, 'library').each((row: StoredRow) => {
      known.set(row.sourceId, { sig: row.remoteSig, addedAt: row.addedAt });
    });
  } catch {
    stored = false;
  }
  const wasEmpty = known.size === 0;

  const tracks: PlaylistTrack[] = [];
  const seen = new Set<string>();
  let added = 0;
  let updated = 0;
  let complete = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await fetchPage(page * SYNC_PAGE_SIZE, SYNC_PAGE_SIZE, signal);
    const fresh = rows.filter((t) => !seen.has(t.id));
    // A host that ignores `offset` repeats page 0; stop instead of looping.
    if (fresh.length === 0) { complete = true; break; }

    const writes: StoredRow[] = [];
    for (const track of fresh) {
      seen.add(track.id);
      tracks.push(track);
      const previous = known.get(track.id);
      const row = toCatalogTrack(track, previous);
      if (!previous) added++;
      else if (previous.sig !== row.remoteSig) updated++;
      else continue;
      writes.push(row);
    }
    if (stored && writes.length > 0) {
      try { await db.tracks.bulkPut(writes); } catch { stored = false; }
    }
    if (rows.length < SYNC_PAGE_SIZE) { complete = true; break; }
  }

  // Only a finished walk proves a row is gone.
  const gone = complete ? [...known.keys()].filter((id) => !seen.has(id)) : [];
  if (stored) {
    try {
      await db.transaction('rw', db.tracks, db.sources, async () => {
        await db.tracks.bulkDelete(gone.map((id): [string, string] => ['library', id]));
        await db.sources.put({
          id: LIBRARY_SOURCE_ID, kind: 'remote', label: 'Cloud library', trackCount: seen.size, lastSyncAt: Date.now(),
        });
      });
      await rebuildAggregates(db);
      if (wasEmpty && seen.size > 0) void requestPersistentStorageOnce(db);
    } catch {
      stored = false;
    }
  }

  return { tracks, added, updated, removed: stored ? gone.length : 0, stored };
}
