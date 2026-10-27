// Local writes that mirror a successful library-host change, so the catalog (and
// every live query over it) reflects edits before the next sync.

import type { PlaylistTrack } from '../types/library';
import { getCatalogDb, type CatalogDb } from './db';

const key = (id: string): [string, string] => ['library', id];

export async function patchLibraryRow(id: string, updates: Partial<PlaylistTrack>, db: CatalogDb = getCatalogDb()): Promise<void> {
  const { file: _file, id: _id, source: _source, ...fields } = updates;
  void _file; void _id; void _source;
  await db.tracks.update(key(id), fields);
}

/** The host keeps trashed rows (`trashed: true`); the library view hides them. */
export async function markLibraryRowTrashed(id: string, db: CatalogDb = getCatalogDb()): Promise<void> {
  await db.tracks.update(key(id), { trashed: true });
}

/** Mirrors `POST /api/songs/{id}/play`, which bumps the host's play count. */
export async function recordLibraryPlay(id: string, at = new Date(), db: CatalogDb = getCatalogDb()): Promise<void> {
  await db.tracks.where('[source+sourceId]').equals(key(id)).modify((row) => {
    row.play_count = (row.play_count ?? 0) + 1;
    row.last_played = at.toISOString();
  });
}
