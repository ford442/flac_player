// The saved queue, in the catalog database (`state.queue`). Queues saved to
// localStorage before the catalog existed are moved in by migrateLegacyStorage.

import type { PlaylistTrack } from '../types/library';
import { getCatalogDb, readState, writeState, type CatalogDb } from '../catalog/db';
import { migrateLegacyStorage, QUEUE_STATE_KEY } from '../catalog/legacy';

export type RepeatMode = 'off' | 'one' | 'all';

export interface QueueState {
  tracks: PlaylistTrack[];
  currentIndex: number;
  shuffle: boolean;
  repeat: RepeatMode;
}

/** Validates a stored queue; null when it is missing or unusable. */
export function normalizeQueue(value: unknown): QueueState | null {
  const parsed = value as Partial<QueueState> | null | undefined;
  if (!parsed || !Array.isArray(parsed.tracks)) return null;
  const repeat: RepeatMode = parsed.repeat === 'all' || parsed.repeat === 'one' ? parsed.repeat : 'off';
  const currentIndexRaw = typeof parsed.currentIndex === 'number' ? parsed.currentIndex : -1;
  const currentIndex = parsed.tracks.length === 0
    ? -1
    : Math.min(Math.max(Math.floor(currentIndexRaw), 0), parsed.tracks.length - 1);
  return { tracks: parsed.tracks, currentIndex, shuffle: !!parsed.shuffle, repeat };
}

export async function loadQueue(db: CatalogDb = getCatalogDb()): Promise<QueueState | null> {
  try {
    await migrateLegacyStorage(db);
    return normalizeQueue(await readState(db, QUEUE_STATE_KEY));
  } catch (e) {
    console.warn('Failed to load queue:', e);
    return null;
  }
}

/** Fire-and-forget: IndexedDB runs readwrite transactions on one store in order, so the last save wins. */
export function saveQueue(state: QueueState, db: CatalogDb = getCatalogDb()): Promise<void> {
  return writeState(db, QUEUE_STATE_KEY, state).catch((e) => console.warn('Failed to save queue:', e));
}

export async function clearQueue(db: CatalogDb = getCatalogDb()): Promise<void> {
  await db.state.delete(QUEUE_STATE_KEY);
}
