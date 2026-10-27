import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { CatalogDb } from '../src/catalog/db';
import {
  LEGACY_LIBRARY_CACHE_KEY, LEGACY_PLAYLIST_DB_NAME, LEGACY_QUEUE_KEY, migrateLegacyStorage,
} from '../src/catalog/legacy';
import { createPlaylistStore, isLocalPlaylist, type PlaylistStore } from '../src/storage/playlistStore';
import { loadQueue } from '../src/storage/queueStorage';
import { moveItem, resolveTracksById } from '../src/utils/playlistUtils';
import type { PlaylistTrack } from '../src/types/library';
import type { LocalPlaylist } from '../src/types/playlist';

const catalogOn = (factory: IDBFactory) => new CatalogDb('flac_player', { indexedDB: factory, IDBKeyRange });

describe('playlistStore (catalog database)', () => {
  let factory: IDBFactory;
  let db: CatalogDb;
  let store: PlaylistStore;

  beforeEach(() => {
    factory = new IDBFactory();
    db = catalogOn(factory);
    store = createPlaylistStore(() => db);
  });

  it('persists a playlist with the same track ids across connections (reload)', async () => {
    const created = await store.create({ title: 'Night drive', trackIds: ['a', 'b', 'c'] });
    expect(created.origin).toBe('local');
    db.close();

    const reopened = createPlaylistStore(() => catalogOn(factory));
    const list = await reopened.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: created.id, title: 'Night drive', trackIds: ['a', 'b', 'c'] });
  });

  it('renames, reorders and bumps updatedAt', async () => {
    const created = await store.create({ title: 'One', trackIds: ['a', 'b'] });
    await new Promise(r => setTimeout(r, 2));
    const updated = await store.update(created.id, { title: '  Two  ', trackIds: ['b', 'a'] });
    expect(updated).toMatchObject({ title: 'Two', trackIds: ['b', 'a'] });
    expect(updated!.updatedAt).toBeGreaterThan(created.updatedAt);
    expect((await store.get(created.id))!.trackIds).toEqual(['b', 'a']);
  });

  it('falls back to a default title for blank names and returns null updating a missing id', async () => {
    const created = await store.create({ title: '   ', trackIds: [] });
    expect(created.title).toBe('Untitled playlist');
    expect(await store.update('nope', { title: 'x' })).toBeNull();
  });

  it('deletes without touching the network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const created = await store.create({ title: 'Temp', trackIds: ['a'] });
      await store.remove(created.id);
      expect(await store.list()).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('lists newest first and skips malformed records', async () => {
    const a = await store.create({ title: 'A', trackIds: [] });
    await new Promise(r => setTimeout(r, 2));
    const b = await store.create({ title: 'B', trackIds: [] });
    // A record that doesn't match the schema.
    await db.playlists.put({ id: 'bad', title: 42, updatedAt: 5 } as unknown as LocalPlaylist);

    expect((await store.list()).map(p => p.id)).toEqual([b.id, a.id]);
  });

  it('reports unavailable when IndexedDB is missing', async () => {
    const none = createPlaylistStore(() => new CatalogDb('x', {
      indexedDB: undefined as unknown as IDBFactory, IDBKeyRange,
    }));
    expect(none.isAvailable()).toBe(false);
    await expect(none.list()).rejects.toThrow();
  });

  it('isLocalPlaylist guards unknown input', () => {
    expect(isLocalPlaylist(null)).toBe(false);
    expect(isLocalPlaylist({ id: 'x', title: 't', description: '', trackIds: [1], updatedAt: 1, origin: 'local' })).toBe(false);
    expect(isLocalPlaylist({ id: 'x', title: 't', description: '', trackIds: ['a'], updatedAt: 1, origin: 'local' })).toBe(true);
  });
});

describe('legacy storage migration', () => {
  const legacyPlaylist: LocalPlaylist = {
    id: 'local-old', title: 'From #222', description: '', trackIds: ['a'], updatedAt: 10, origin: 'local',
  };

  function seedLegacyDb(factory: IDBFactory, rows: unknown[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const open = factory.open(LEGACY_PLAYLIST_DB_NAME, 1);
      open.onupgradeneeded = () => open.result.createObjectStore('playlists', { keyPath: 'id' });
      open.onsuccess = () => {
        const tx = open.result.transaction('playlists', 'readwrite');
        rows.forEach((row) => tx.objectStore('playlists').put(row));
        tx.oncomplete = () => { open.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
  }

  const databaseNames = async (factory: IDBFactory) => (await factory.databases()).map((d) => d.name);

  it('moves legacy playlists and the localStorage queue in, then drops the old stores', async () => {
    const factory = new IDBFactory();
    await seedLegacyDb(factory, [legacyPlaylist, { id: 'junk' }]);
    const queue = { tracks: [{ id: 's1', name: 'S1', url: 'https://x/s1' }], currentIndex: 0, shuffle: false, repeat: 'all' };
    localStorage.setItem(LEGACY_QUEUE_KEY, JSON.stringify(queue));
    localStorage.setItem(LEGACY_LIBRARY_CACHE_KEY, '{"tracks":[]}');

    const db = catalogOn(factory);
    expect((await createPlaylistStore(() => db).list()).map((p) => p.id)).toEqual(['local-old']);
    expect(await loadQueue(db)).toEqual(queue);
    expect(localStorage.getItem(LEGACY_QUEUE_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_LIBRARY_CACHE_KEY)).toBeNull();
    expect(await databaseNames(factory)).not.toContain(LEGACY_PLAYLIST_DB_NAME);
  });

  it('runs once and never creates the legacy database', async () => {
    const factory = new IDBFactory();
    const db = catalogOn(factory);
    await migrateLegacyStorage(db);
    expect(await databaseNames(factory)).not.toContain(LEGACY_PLAYLIST_DB_NAME);

    // A queue written by an old tab after the move is not picked up again.
    localStorage.setItem(LEGACY_QUEUE_KEY, JSON.stringify({ tracks: [], currentIndex: -1 }));
    db.close();
    const reopened = catalogOn(factory);
    await migrateLegacyStorage(reopened);
    expect(localStorage.getItem(LEGACY_QUEUE_KEY)).not.toBeNull();
  });
});

describe('playlistUtils', () => {
  it('moveItem matches queue reorder semantics and ignores out-of-range moves', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
    expect(moveItem(['a', 'b'], 0, 5)).toEqual(['a', 'b']);
  });

  it('resolveTracksById keeps order, fetches only unknown ids once, and drops failures', async () => {
    const t = (id: string) => ({ id, name: id, url: `https://x/${id}` }) as PlaylistTrack;
    const calls: string[] = [];
    const out = await resolveTracksById(
      ['a', 'b', 'c', 'b', 'gone'],
      new Map([['a', t('a')]]),
      async id => { calls.push(id); if (id === 'gone') throw new Error('404'); return t(id); },
    );
    expect(out.map(x => x.id)).toEqual(['a', 'b', 'c', 'b']);
    expect(calls.sort()).toEqual(['b', 'c', 'gone']);
  });
});
