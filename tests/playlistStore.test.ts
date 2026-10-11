import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createPlaylistStore, isLocalPlaylist, PLAYLIST_DB_NAME, type PlaylistStore } from '../src/storage/playlistStore';
import { moveItem, resolveTracksById } from '../src/utils/playlistUtils';
import type { PlaylistTrack } from '../src/types/library';

describe('playlistStore (IndexedDB)', () => {
  let factory: IDBFactory;
  let store: PlaylistStore;

  beforeEach(() => {
    factory = new IDBFactory();
    store = createPlaylistStore(factory);
  });

  it('persists a playlist with the same track ids across store instances (reload)', async () => {
    const created = await store.create({ title: 'Night drive', trackIds: ['a', 'b', 'c'] });
    expect(created.origin).toBe('local');

    const reopened = createPlaylistStore(factory); // new connection, same database
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

    // Inject a record that doesn't match the schema.
    await new Promise<void>((resolve, reject) => {
      const open = factory.open(PLAYLIST_DB_NAME, 1);
      open.onsuccess = () => {
        const tx = open.result.transaction('playlists', 'readwrite');
        tx.objectStore('playlists').put({ id: 'bad', title: 42 });
        tx.oncomplete = () => { open.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });

    expect((await store.list()).map(p => p.id)).toEqual([b.id, a.id]);
  });

  it('reports unavailable when IndexedDB is missing', async () => {
    const none = createPlaylistStore(undefined);
    expect(none.isAvailable()).toBe(false);
    await expect(none.list()).rejects.toThrow(/not available/);
  });

  it('isLocalPlaylist guards unknown input', () => {
    expect(isLocalPlaylist(null)).toBe(false);
    expect(isLocalPlaylist({ id: 'x', title: 't', description: '', trackIds: [1], updatedAt: 1, origin: 'local' })).toBe(false);
    expect(isLocalPlaylist({ id: 'x', title: 't', description: '', trackIds: ['a'], updatedAt: 1, origin: 'local' })).toBe(true);
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
