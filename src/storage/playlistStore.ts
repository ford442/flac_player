// Local-first playlist storage in IndexedDB (database `flac_player_playlists`).
// Stores track ids only: audio bytes belong to trackCache / the Cache API, and
// localStorage is avoided because large id arrays would hit its quota.

import type { LocalPlaylist, LocalPlaylistPatch, NewLocalPlaylist } from '../types/playlist';

export const PLAYLIST_DB_NAME = 'flac_player_playlists';
export const PLAYLIST_STORE_NAME = 'playlists';
const DB_VERSION = 1;
const DEFAULT_TITLE = 'Untitled playlist';

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

function newId(): string {
  const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `local-${uuid}`;
}

const normalizeTitle = (title: string): string => title.trim() || DEFAULT_TITLE;

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export interface PlaylistStore {
  isAvailable(): boolean;
  list(): Promise<LocalPlaylist[]>;
  get(id: string): Promise<LocalPlaylist | null>;
  create(input: NewLocalPlaylist): Promise<LocalPlaylist>;
  update(id: string, patch: LocalPlaylistPatch): Promise<LocalPlaylist | null>;
  remove(id: string): Promise<void>;
}

/** `factory` is injectable so tests can pass a fresh `IDBFactory`. */
export function createPlaylistStore(factory: IDBFactory | undefined = globalThis.indexedDB): PlaylistStore {
  let dbPromise: Promise<IDBDatabase> | null = null;

  const open = (): Promise<IDBDatabase> => {
    if (!factory) return Promise.reject(new Error('IndexedDB is not available'));
    if (!dbPromise) {
      dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = factory.open(PLAYLIST_DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(PLAYLIST_STORE_NAME)) {
            db.createObjectStore(PLAYLIST_STORE_NAME, { keyPath: 'id' });
          }
        };
        request.onsuccess = () => {
          const db = request.result;
          // Let another tab upgrade/delete the database; reopen lazily next time.
          db.onversionchange = () => { db.close(); dbPromise = null; };
          resolve(db);
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('IndexedDB open blocked'));
      }).catch(err => { dbPromise = null; throw err; });
    }
    return dbPromise;
  };

  const readOne = async (id: string): Promise<LocalPlaylist | null> => {
    const db = await open();
    const value: unknown = await promisify(
      db.transaction(PLAYLIST_STORE_NAME, 'readonly').objectStore(PLAYLIST_STORE_NAME).get(id)
    );
    return isLocalPlaylist(value) ? value : null;
  };

  const write = async (playlist: LocalPlaylist): Promise<void> => {
    const db = await open();
    const tx = db.transaction(PLAYLIST_STORE_NAME, 'readwrite');
    tx.objectStore(PLAYLIST_STORE_NAME).put(playlist);
    await transactionDone(tx);
  };

  return {
    isAvailable: () => !!factory,

    async list() {
      const db = await open();
      const values: unknown[] = await promisify(
        db.transaction(PLAYLIST_STORE_NAME, 'readonly').objectStore(PLAYLIST_STORE_NAME).getAll()
      );
      return values.filter(isLocalPlaylist).sort((a, b) => b.updatedAt - a.updatedAt);
    },

    get: readOne,

    async create(input) {
      const playlist: LocalPlaylist = {
        id: newId(),
        title: normalizeTitle(input.title),
        description: input.description?.trim() ?? '',
        trackIds: [...input.trackIds],
        updatedAt: Date.now(),
        origin: input.origin ?? 'local',
      };
      await write(playlist);
      return playlist;
    },

    async update(id, patch) {
      const db = await open();
      // Read-modify-write in a single transaction so concurrent edits can't interleave.
      const tx = db.transaction(PLAYLIST_STORE_NAME, 'readwrite');
      const objectStore = tx.objectStore(PLAYLIST_STORE_NAME);
      const existing: unknown = await promisify(objectStore.get(id));
      if (!isLocalPlaylist(existing)) {
        await transactionDone(tx);
        return null;
      }
      const next: LocalPlaylist = {
        ...existing,
        title: patch.title !== undefined ? normalizeTitle(patch.title) : existing.title,
        description: patch.description !== undefined ? patch.description.trim() : existing.description,
        trackIds: patch.trackIds !== undefined ? [...patch.trackIds] : existing.trackIds,
        updatedAt: Date.now(),
      };
      objectStore.put(next);
      await transactionDone(tx);
      return next;
    },

    async remove(id) {
      const db = await open();
      const tx = db.transaction(PLAYLIST_STORE_NAME, 'readwrite');
      tx.objectStore(PLAYLIST_STORE_NAME).delete(id);
      await transactionDone(tx);
    },
  };
}

/** App-wide store (lazy: nothing touches IndexedDB until the first call). */
export const playlistStore: PlaylistStore = createPlaylistStore();
