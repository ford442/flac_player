import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { CatalogDb, type CatalogTrack } from '../src/catalog/db';
import { SYNC_PAGE_SIZE, syncRemoteLibrary, toCatalogTrack, type FetchSongPage } from '../src/catalog/remoteSync';
import { buildAggregates } from '../src/catalog/aggregates';
import {
  computeStats, computeTags, DEFAULT_LIBRARY_FILTERS, filterTracks, fromCatalogTrack, sortTracks,
} from '../src/catalog/libraryQuery';
import { markLibraryRowTrashed, patchLibraryRow, recordLibraryPlay } from '../src/catalog/libraryRows';
import type { PlaylistTrack } from '../src/types/library';

const song = (id: string, extra: Partial<PlaylistTrack> = {}): PlaylistTrack => ({
  id, source: 'library', name: id, url: `https://storage.test/${id}.flac`, ...extra,
});
const songs = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => song(`${prefix}${i}`));

/** A host serving `library` in pages, honouring offset/limit. */
const hostOf = (library: PlaylistTrack[]) => vi.fn<FetchSongPage>(
  async (offset, limit) => library.slice(offset, offset + limit),
);

let db: CatalogDb;
beforeEach(() => {
  db = new CatalogDb('catalog-test', { indexedDB: new IDBFactory(), IDBKeyRange });
});

describe('syncRemoteLibrary', () => {
  it('walks every page into the catalog and records the source', async () => {
    const library = songs('s', SYNC_PAGE_SIZE + 5);
    const host = hostOf(library);
    const result = await syncRemoteLibrary(host, { db });

    expect(host.mock.calls.map(([offset]) => offset)).toEqual([0, SYNC_PAGE_SIZE]);
    expect(result).toMatchObject({ added: library.length, updated: 0, removed: 0, stored: true });
    expect(await db.tracks.count()).toBe(library.length);
    expect(await db.tracks.get(['library', 's3'])).toMatchObject({ source: 'library', sourceId: 's3', name: 's3' });
    expect(await db.sources.get('library')).toMatchObject({ kind: 'remote', trackCount: library.length });
  });

  it('rewrites only changed rows and deletes rows the host dropped', async () => {
    await syncRemoteLibrary(hostOf([song('a'), song('b'), song('c')]), { db });
    const before = await db.tracks.get(['library', 'a']);
    const put = vi.spyOn(db.tracks, 'bulkPut');

    const result = await syncRemoteLibrary(hostOf([song('a'), song('b', { rating: 5 }), song('d')]), { db });
    expect(result).toMatchObject({ added: 1, updated: 1, removed: 1 });
    expect(put.mock.calls.flatMap(([rows]) => rows.map((r) => r.sourceId)).sort()).toEqual(['b', 'd']);
    expect((await db.tracks.toCollection().primaryKeys()).map(([, id]) => id).sort()).toEqual(['a', 'b', 'd']);
    expect((await db.tracks.get(['library', 'b']))?.rating).toBe(5);
    expect((await db.tracks.get(['library', 'a']))?.addedAt).toBe(before?.addedAt);
  });

  it('stops when a host ignores offset instead of looping', async () => {
    const full = songs('s', SYNC_PAGE_SIZE);
    const host = vi.fn<FetchSongPage>(async () => full);
    const result = await syncRemoteLibrary(host, { db });
    expect(host).toHaveBeenCalledTimes(2);
    expect(result.tracks).toHaveLength(SYNC_PAGE_SIZE);
  });

  it('keeps the catalog when the walk fails part-way', async () => {
    await syncRemoteLibrary(hostOf([song('a'), song('b')]), { db });
    const failing = vi.fn<FetchSongPage>().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(syncRemoteLibrary(failing, { db })).rejects.toThrow('Failed to fetch');
    expect(await db.tracks.count()).toBe(2);
  });

  it('leaves other sources alone', async () => {
    await db.tracks.put({ ...toCatalogTrack(song('x')), source: 'local', sourceId: 'folder/x.flac' });
    await syncRemoteLibrary(hostOf([song('a')]), { db });
    expect(await db.tracks.get(['local', 'folder/x.flac'])).toBeDefined();
  });

  it('still returns the host rows when IndexedDB is unusable', async () => {
    const broken = new CatalogDb('x', { indexedDB: undefined as unknown as IDBFactory, IDBKeyRange });
    const result = await syncRemoteLibrary(hostOf([song('a'), song('b')]), { db: broken });
    expect(result.stored).toBe(false);
    expect(result.tracks.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('builds albums and artists from the synced rows', async () => {
    await syncRemoteLibrary(hostOf([
      song('a', { artist: 'Boards of Canada', album: 'Geogaddi', year: 2002 }),
      song('b', { artist: 'boards  of canada', album: 'geogaddi' }),
      song('c', { author: 'Solo', tags: [] }),
    ]), { db });
    expect(await db.albums.toArray()).toEqual([expect.objectContaining({
      id: 'boards of canada|geogaddi', title: 'Geogaddi', trackCount: 2, year: 2002, sources: ['library'],
    })]);
    expect((await db.artists.toArray()).map((a) => [a.id, a.trackCount, a.albumCount]).sort()).toEqual([
      ['boards of canada', 2, 1], ['solo', 1, 0],
    ]);
  });
});

describe('library rows', () => {
  beforeEach(async () => {
    await syncRemoteLibrary(hostOf([song('a', { play_count: 2 })]), { db });
  });

  it('patches, trashes and counts plays locally', async () => {
    await patchLibraryRow('a', { rating: 3, tags: ['dub'] }, db);
    await recordLibraryPlay('a', new Date('2026-10-01T00:00:00Z'), db);
    await markLibraryRowTrashed('a', db);
    expect(await db.tracks.get(['library', 'a'])).toMatchObject({
      rating: 3, tags: ['dub'], play_count: 3, last_played: '2026-10-01T00:00:00.000Z', trashed: true,
    });
  });

  it('ignores ids the catalog does not have', async () => {
    await patchLibraryRow('missing', { rating: 1 }, db);
    await recordLibraryPlay('missing', new Date(), db);
    expect(await db.tracks.count()).toBe(1);
  });
});

describe('library query', () => {
  const row = (id: string, extra: Partial<CatalogTrack> = {}): CatalogTrack =>
    ({ ...toCatalogTrack(song(id)), ...extra });
  const rows = [
    row('a', { name: 'Alpha', rating: 5, tags: ['ambient'], addedAt: 3, duration: 1800 }),
    row('b', { name: 'bravo', rating: 2, tags: ['dub', 'ambient'], addedAt: 1, play_count: 4, duration: 1800 }),
    row('c', { name: 'Charlie', addedAt: 2, artist: 'Ambient Works' }),
    row('t', { name: 'Trashed', tags: ['ambient'], trashed: true }),
  ];
  const ids = (list: CatalogTrack[]) => list.map((t) => t.id);
  const f = (extra: Partial<typeof DEFAULT_LIBRARY_FILTERS>) => ({ ...DEFAULT_LIBRARY_FILTERS, ...extra });

  it('filters like the host: rating, any-of tags, untagged, search; never trashed', () => {
    expect(ids(filterTracks(rows, f({})))).toEqual(['a', 'b', 'c']);
    expect(ids(filterTracks(rows, f({ minRating: 4 })))).toEqual(['a']);
    expect(ids(filterTracks(rows, f({ tags: ['dub', 'nope'] })))).toEqual(['b']);
    expect(ids(filterTracks(rows, f({ untaggedOnly: true })))).toEqual(['c']);
    expect(ids(filterTracks(rows, f({ search: ' AMBIENT ' })))).toEqual(['a', 'b', 'c']);
  });

  it('sorts newest first by default, and by name A→Z', () => {
    expect(ids(sortTracks(rows.slice(0, 3), 'date'))).toEqual(['a', 'c', 'b']);
    expect(ids(sortTracks(rows.slice(0, 3), 'name'))).toEqual(['a', 'b', 'c']);
    expect(ids(sortTracks(rows.slice(0, 3), 'play_count'))[0]).toBe('b');
  });

  it('shuffles stably per seed', () => {
    const many = Array.from({ length: 30 }, (_, i) => row(`r${i}`));
    expect(ids(sortTracks(many, 'random', 7))).toEqual(ids(sortTracks(many, 'random', 7)));
    expect(ids(sortTracks(many, 'random', 7))).not.toEqual(ids(sortTracks(many, 'random', 8)));
  });

  it('computes tags and stats without trashed rows', () => {
    expect(computeTags(rows)).toEqual([{ name: 'ambient', count: 2 }, { name: 'dub', count: 1 }]);
    expect(computeStats(rows)).toEqual({
      total_tracks: 3, rated_4plus: 1, total_duration_hours: 1, total_play_count: 4,
      untagged_count: 1, trash_count: 1, unique_tags: 2,
      top_tags: [{ name: 'ambient', count: 2 }, { name: 'dub', count: 1 }],
    });
  });

  it('hands the app plain tracks', () => {
    const track = fromCatalogTrack(rows[0]);
    expect(track).not.toHaveProperty('sourceId');
    expect(track).not.toHaveProperty('remoteSig');
    expect(track).toMatchObject({ id: 'a', source: 'library', url: 'https://storage.test/a.flac' });
  });

  it('aggregates skip trashed rows and rows without an album', () => {
    expect(buildAggregates(rows).albums).toEqual([]);
    expect(buildAggregates(rows).artists.map((a) => a.id)).toEqual(['ambient works']);
  });
});
