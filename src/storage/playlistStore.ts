// Local-first playlists in the catalog database (`playlists` table). Track ids only:
// audio bytes belong to trackCache. Playlists saved before the catalog existed (the
// `flac_player_playlists` database, #222) are moved in by migrateLegacyStorage.

import { getCatalogDb, type CatalogDb } from '../catalog/db';
import { isLocalPlaylist, migrateLegacyStorage } from '../catalog/legacy';
import type { LocalPlaylist, LocalPlaylistPatch, NewLocalPlaylist } from '../types/playlist';

export { isLocalPlaylist };

const DEFAULT_TITLE = 'Untitled playlist';

function newId(): string {
  const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `local-${uuid}`;
}

const normalizeTitle = (title: string): string => title.trim() || DEFAULT_TITLE;

export interface PlaylistStore {
  isAvailable(): boolean;
  list(): Promise<LocalPlaylist[]>;
  get(id: string): Promise<LocalPlaylist | null>;
  create(input: NewLocalPlaylist): Promise<LocalPlaylist>;
  update(id: string, patch: LocalPlaylistPatch): Promise<LocalPlaylist | null>;
  remove(id: string): Promise<void>;
}

/** `getDb` is injectable so tests can pass a catalog on a fresh `IDBFactory`. */
export function createPlaylistStore(getDb: () => CatalogDb = getCatalogDb): PlaylistStore {
  const ready = async (): Promise<CatalogDb> => {
    const db = getDb();
    await migrateLegacyStorage(db);
    return db;
  };

  return {
    isAvailable: () => !!getDb().factory,

    async list() {
      const db = await ready();
      const rows = await db.playlists.orderBy('updatedAt').reverse().toArray();
      return rows.filter(isLocalPlaylist);
    },

    async get(id) {
      const row = await (await ready()).playlists.get(id);
      return isLocalPlaylist(row) ? row : null;
    },

    async create(input) {
      const playlist: LocalPlaylist = {
        id: newId(),
        title: normalizeTitle(input.title),
        description: input.description?.trim() ?? '',
        trackIds: [...input.trackIds],
        updatedAt: Date.now(),
        origin: input.origin ?? 'local',
      };
      await (await ready()).playlists.add(playlist);
      return playlist;
    },

    async update(id, patch) {
      const db = await ready();
      // Read-modify-write in one transaction so concurrent edits can't interleave.
      return db.transaction('rw', db.playlists, async () => {
        const existing = await db.playlists.get(id);
        if (!isLocalPlaylist(existing)) return null;
        const next: LocalPlaylist = {
          ...existing,
          title: patch.title !== undefined ? normalizeTitle(patch.title) : existing.title,
          description: patch.description !== undefined ? patch.description.trim() : existing.description,
          trackIds: patch.trackIds !== undefined ? [...patch.trackIds] : existing.trackIds,
          updatedAt: Date.now(),
        };
        await db.playlists.put(next);
        return next;
      });
    },

    async remove(id) {
      await (await ready()).playlists.delete(id);
    },
  };
}

/** App-wide store (lazy: nothing touches IndexedDB until the first call). */
export const playlistStore: PlaylistStore = createPlaylistStore();
