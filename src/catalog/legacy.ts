// One-time moves into the catalog from pre-catalog storage:
//   - playlists from the `flac_player_playlists` database (#222) → `playlists`
//   - the localStorage queue → `state.queue`
//   - the localStorage library cache → dropped (the catalog replaces it)

import { readState, writeState, type CatalogDb } from './db';
import type { LocalPlaylist } from '../types/playlist';

export const LEGACY_PLAYLIST_DB_NAME = 'flac_player_playlists';
export const LEGACY_QUEUE_KEY = 'flac_player_queue';
export const LEGACY_LIBRARY_CACHE_KEY = 'flac_player_library_cache';
const MIGRATED_KEY = 'legacyMigrated';
export const QUEUE_STATE_KEY = 'queue';

export function isLocalPlaylist(value: unknown): value is LocalPlaylist {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return typeof p.id === 'string'
    && typeof p.title === 'string'
    && typeof p.description === 'string'
    && Array.isArray(p.trackIds) && p.trackIds.every(id => typeof id === 'string')
    && typeof p.updatedAt === 'number'
    && (p.origin === 'local' || p.origin === 'cloud');
}

/** Rows of the legacy playlist database; [] when it never existed, null when it could not be read. */
function readLegacyPlaylists(factory: IDBFactory): Promise<unknown[] | null> {
  return new Promise((resolve) => {
    let existed = true;
    const request = factory.open(LEGACY_PLAYLIST_DB_NAME);
    request.onupgradeneeded = (event) => {
      // Opening without a version creates a missing database; abort so it isn't left behind.
      if (event.oldVersion === 0) { existed = false; request.transaction?.abort(); }
    };
    request.onerror = (event) => { event.preventDefault(); resolve(existed ? null : []); };
    request.onblocked = () => resolve(null);
    request.onsuccess = () => {
      const legacy = request.result;
      if (!legacy.objectStoreNames.contains('playlists')) { legacy.close(); resolve([]); return; }
      const read = legacy.transaction('playlists', 'readonly').objectStore('playlists').getAll();
      read.onsuccess = () => { legacy.close(); resolve(read.result as unknown[]); };
      read.onerror = () => { legacy.close(); resolve(null); };
    };
  });
}

function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = factory.deleteDatabase(name);
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
}

function takeLocalStorage(key: string): string | null {
  try {
    const value = localStorage.getItem(key);
    localStorage.removeItem(key);
    return value;
  } catch {
    return null;
  }
}

async function migrate(db: CatalogDb): Promise<void> {
  if (await readState<boolean>(db, MIGRATED_KEY)) return;

  const legacyRows = db.factory ? await readLegacyPlaylists(db.factory) : [];
  if (legacyRows === null) return; // unreadable right now (blocked by another tab): retry next load
  const playlists = legacyRows.filter(isLocalPlaylist);
  await db.transaction('rw', db.playlists, async () => {
    const present = new Set(await db.playlists.toCollection().primaryKeys());
    await db.playlists.bulkPut(playlists.filter((p) => !present.has(p.id)));
  });
  if (db.factory && legacyRows.length > 0) await deleteDatabase(db.factory, LEGACY_PLAYLIST_DB_NAME);

  const queue = takeLocalStorage(LEGACY_QUEUE_KEY);
  if (queue !== null && (await readState(db, QUEUE_STATE_KEY)) === undefined) {
    try { await writeState(db, QUEUE_STATE_KEY, JSON.parse(queue)); } catch { /* corrupt: drop it */ }
  }
  takeLocalStorage(LEGACY_LIBRARY_CACHE_KEY);

  await writeState(db, MIGRATED_KEY, true);
}

const runs = new WeakMap<CatalogDb, Promise<void>>();

/** Runs the legacy moves once per catalog connection; later callers share the same promise. */
export function migrateLegacyStorage(db: CatalogDb): Promise<void> {
  let run = runs.get(db);
  if (!run) {
    run = migrate(db).catch((error) => { console.warn('Legacy storage migration failed:', error); });
    runs.set(db, run);
  }
  return run;
}
