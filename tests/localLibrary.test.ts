// Local folders (#284): ids, the fallback folder, incremental scans, access loss and
// recovery, folder handles, and the paths that must keep local ids private.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { CatalogDb } from '../src/catalog/db';
import { scanLocalFolder, toLocalCatalogTrack, type FolderWalker } from '../src/catalog/localScan';
import { scanFolderEntries, type TagReader } from '../src/catalog/folderScanCore';
import {
  addFolderFromFiles, clearSessionFolders, findFolderTrack, folderAccess, folderRows, listLocalFolders,
  removeFolder, resolveLocalFile, sessionFolderEntries, LocalFileUnavailableError, type LocalFolderSource,
} from '../src/storage/localLibrary';
import { walkDirectory, type DirectoryHandle } from '../src/storage/folderWalk';
import {
  isLibraryTrack, isResolvableTrack, localTrackId, localTrackUrl, parseLocalTrackId, trackSource,
} from '../src/types/track';
import { isShareableTrackId } from '../src/listening/useListeningRoomBridge';
import { persistableQueue } from '../src/player/persistence';
import type { PlaylistTrack } from '../src/types/library';

let db: CatalogDb;
beforeEach(() => {
  db = new CatalogDb('local-library-test', { indexedDB: new IDBFactory(), IDBKeyRange });
  clearSessionFolders();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** A file as `<input webkitdirectory>` hands it over: `webkitRelativePath` = `Root/…`. */
function picked(relative: string, bytes = 8, lastModified = 1000): File {
  const file = new File([new Uint8Array(bytes)], relative.slice(relative.lastIndexOf('/') + 1), { lastModified });
  Object.defineProperty(file, 'webkitRelativePath', { value: relative });
  return file;
}

const fakeTags: TagReader = async (file) => ({ title: `T:${file.name}`, artist: 'Artist', album: 'Album', duration: 60, sampleRate: 44100 });
const read = vi.fn(fakeTags);
/** The inline walk with stub tags (music-metadata needs real audio). */
const walk: FolderWalker = (source, known, callbacks, signal) =>
  scanFolderEntries(sessionFolderEntries(source.id) ?? [], known, callbacks, { readTags: read, signal });

describe('folder track ids', () => {
  it('are stable per folder and path, local, and never library ids', () => {
    const id = localTrackId('fab12', 'Album/01 Song.flac');
    expect(id).toBe('local-fab12:Album/01 Song.flac');
    expect(parseLocalTrackId(id)).toEqual({ folderId: 'fab12', path: 'Album/01 Song.flac' });
    expect(parseLocalTrackId('local-1700000000-abc')).toBeNull(); // a dropped file
    expect(trackSource({ id })).toBe('local');
    expect(isLibraryTrack({ id })).toBe(false);
    expect(isResolvableTrack({ id })).toBe(true);
    expect(isResolvableTrack({ id: 'local-1700000000-abc' })).toBe(false);
    expect(isResolvableTrack({ id: 'url:https://x.test/a.mp3' })).toBe(false);
    expect(isResolvableTrack({ id: '7f3c' })).toBe(true);
    expect(localTrackUrl('fab12', 'a.flac')).toBe('local:fab12/a.flac');
  });

  it('stay out of listening rooms and share payloads', () => {
    expect(isShareableTrackId(localTrackId('fab12', 'a.flac'))).toBe(false);
    const queue = ['7f3c', localTrackId('fab12', 'a.flac'), 'b9'];
    expect(queue.filter(isShareableTrackId)).toEqual(['7f3c', 'b9']);
  });

  it('survive in the saved queue; dropped files do not', () => {
    const folderTrack: PlaylistTrack = {
      id: localTrackId('fab12', 'a.flac'), source: 'local', name: 'a.flac', url: localTrackUrl('fab12', 'a.flac'),
      local: { folderId: 'fab12', path: 'a.flac', size: 8, mtime: 1 },
    };
    const dropped: PlaylistTrack = { id: 'local-1-x', source: 'local', name: 'x.flac', url: 'blob:x', file: new File([], 'x.flac') };
    const remote: PlaylistTrack = { id: 'r1', source: 'library', name: 'r1', url: 'https://storage.test/r1.flac' };
    const saved = persistableQueue({ tracks: [remote, dropped, folderTrack], currentIndex: 2, shuffle: false, repeatMode: 'off' });
    expect(saved.tracks.map((t) => t.id)).toEqual(['r1', folderTrack.id]);
    expect(saved.currentIndex).toBe(1);
  });
});

describe('fallback folder (webkitdirectory) scan', () => {
  const files = () => [
    picked('Music/a.flac'),
    picked('Music/Disc 2/b.wav'),
    picked('Music/notes.txt'),
    picked('Music/.hidden.flac'),
  ];

  it('lists FLAC/WAV files with tags, ids and refs; no audio bytes in the catalog', async () => {
    const source = (await addFolderFromFiles(files(), db))!;
    expect(source).toMatchObject({ kind: 'files', label: 'Music' });

    const result = await scanLocalFolder(source, { db, walk });
    expect(result).toEqual({ scanned: 2, changed: 2, removed: 0 });

    const rows = await folderRows(db, source.id).toArray();
    expect(rows.map((r) => r.local?.path).sort()).toEqual(['Disc 2/b.wav', 'a.flac']);
    const a = rows.find((r) => r.local?.path === 'a.flac')!;
    expect(a).toMatchObject({
      id: localTrackId(source.id, 'a.flac'), source: 'local', url: localTrackUrl(source.id, 'a.flac'),
      title: 'T:a.flac', artist: 'Artist', album: 'Album', duration: 60,
      local: { folderId: source.id, path: 'a.flac', size: 8, mtime: 1000 },
    });
    expect(Object.values(a).some((v) => v instanceof Blob)).toBe(false);
    expect(await db.sources.get(source.id)).toMatchObject({ trackCount: 2 });
    expect(await db.albums.count()).toBe(1);
  });

  it('is incremental by (path, size, mtime) and deletes rows for files that went away', async () => {
    const source = (await addFolderFromFiles(files(), db))!;
    await scanLocalFolder(source, { db, walk });
    const firstAdded = (await db.tracks.get(['local', `${source.id}:a.flac`]))!.addedAt;
    read.mockClear();

    expect(await scanLocalFolder(source, { db, walk })).toEqual({ scanned: 2, changed: 0, removed: 0 });
    expect(read).not.toHaveBeenCalled();

    // a.flac re-encoded (new size + mtime), b.wav deleted: re-picking the same folder re-attaches.
    await addFolderFromFiles([picked('Music/a.flac', 16, 2000)], db);
    expect(await scanLocalFolder(source, { db, walk })).toEqual({ scanned: 1, changed: 1, removed: 1 });
    expect(read).toHaveBeenCalledTimes(1);
    const a = (await db.tracks.get(['local', `${source.id}:a.flac`]))!;
    expect(a.local).toMatchObject({ size: 16, mtime: 2000 });
    expect(a.addedAt).toBe(firstAdded);
    expect(await folderRows(db, source.id).count()).toBe(1);
    expect(await listLocalFolders(db)).toHaveLength(1);
  });

  it('after a reload: rows stay, access is "unavailable", play and scan fail with a recover message', async () => {
    const source = (await addFolderFromFiles(files(), db))!;
    await scanLocalFolder(source, { db, walk });
    expect(await resolveLocalFile({ id: localTrackId(source.id, 'a.flac'), name: 'a.flac' }, db)).toBeInstanceOf(File);

    clearSessionFolders(); // what a reload does to the fallback's files
    expect(await folderAccess(source)).toBe('unavailable');
    expect(await folderRows(db, source.id).count()).toBe(2); // not an empty library
    await expect(scanLocalFolder(source, { db, walk })).rejects.toThrow(/Pick the folder "Music" again/);
    const error = await resolveLocalFile({ id: localTrackId(source.id, 'a.flac'), name: 'a.flac' }, db).catch((e) => e);
    expect(error).toBeInstanceOf(LocalFileUnavailableError);
    expect(error).toMatchObject({ problem: 'access', folderLabel: 'Music' });

    // Picking it again keeps the folder id, so playlist and queue ids still resolve.
    expect((await addFolderFromFiles(files(), db))!.id).toBe(source.id);
    expect(await folderAccess(source)).toBe('granted');
  });

  it('resolves folder tracks for playlists, and removes a folder with its rows', async () => {
    const source = (await addFolderFromFiles(files(), db))!;
    await scanLocalFolder(source, { db, walk });
    const track = await findFolderTrack(localTrackId(source.id, 'Disc 2/b.wav'), db);
    expect(track).toMatchObject({ source: 'local', local: { path: 'Disc 2/b.wav' } });
    expect(track).not.toHaveProperty('sourceId');
    await expect(findFolderTrack(localTrackId(source.id, 'nope.flac'), db)).rejects.toThrow();

    await removeFolder(source.id, db);
    expect(await db.sources.get(source.id)).toBeUndefined();
    expect(await folderRows(db, source.id).count()).toBe(0);
    const gone = await resolveLocalFile({ id: track.id, name: track.name }, db).catch((e) => e);
    expect(gone).toMatchObject({ problem: 'unknown-folder' });
  });
});

/** A File System Access directory double. */
function fakeDir(name: string, tree: Record<string, File | Record<string, unknown>>, permission: { state: PermissionState }) {
  const entries = Object.entries(tree).map(([key, value]): [string, FileSystemHandle] => [
    key,
    value instanceof File
      ? ({ kind: 'file', name: key, getFile: async () => value } as unknown as FileSystemHandle)
      : (fakeDir(key, value as Record<string, File>, permission) as unknown as FileSystemHandle),
  ]);
  const dir = {
    kind: 'directory',
    name,
    async *entries() { yield* entries; },
    async getDirectoryHandle(child: string) {
      const hit = entries.find(([n, h]) => n === child && h.kind === 'directory');
      if (!hit) throw new DOMException('missing', 'NotFoundError');
      return hit[1];
    },
    async getFileHandle(child: string) {
      if (permission.state !== 'granted') throw new DOMException('revoked', 'NotAllowedError');
      const hit = entries.find(([n, h]) => n === child && h.kind === 'file');
      if (!hit) throw new DOMException('missing', 'NotFoundError');
      return hit[1];
    },
    queryPermission: vi.fn(async () => permission.state),
    requestPermission: vi.fn(async () => permission.state),
    isSameEntry: async () => false,
  };
  return dir as unknown as DirectoryHandle & { requestPermission: ReturnType<typeof vi.fn> };
}

describe('picker folders (File System Access)', () => {
  const song = new File([new Uint8Array(4)], '01.flac', { lastModified: 5 });
  const tree = { 'Album': { '01.flac': song, 'cover.jpg': new File([], 'cover.jpg') }, '.cache': { 'x.flac': song }, 'b.WAV': song };

  it('walks nested audio files depth first, skipping dot-folders and other types', async () => {
    const paths: string[] = [];
    for await (const entry of walkDirectory(fakeDir('root', tree, { state: 'granted' }))) paths.push(entry.path);
    expect(paths).toEqual(['Album/01.flac', 'b.WAV']);
  });

  function withHandle(permission: { state: PermissionState }) {
    const handle = fakeDir('Music', tree, permission);
    const source: LocalFolderSource = { id: 'fpick', kind: 'folder', label: 'Music', trackCount: 1, handle };
    // fake-indexeddb cannot structured-clone the double's functions; real handles clone.
    vi.spyOn(db.sources, 'get').mockResolvedValue(source);
    return { source, handle };
  }
  const track = { id: localTrackId('fpick', 'Album/01.flac'), name: '01.flac' };

  it('reopens the file from the handle while access is granted', async () => {
    withHandle({ state: 'granted' });
    expect(await resolveLocalFile(track, db)).toBe(song);
  });

  it('a lapsed grant (reload) is a recover action, not an exception from the walk', async () => {
    const { source, handle } = withHandle({ state: 'prompt' });
    expect(await folderAccess(source)).toBe('prompt');
    const error = await resolveLocalFile(track, db).catch((e) => e);
    expect(error).toMatchObject({ name: 'LocalFileUnavailableError', problem: 'access' });
    expect(error.message).toMatch(/Reconnect/);
    expect(handle.requestPermission).not.toHaveBeenCalled(); // no user activation: never prompt

    await expect(scanLocalFolder(source, { db })).rejects.toThrow(/granted again/);
  });

  it('asks again while the click that started playback is still active', async () => {
    const permission = { state: 'prompt' as PermissionState };
    const { handle } = withHandle(permission);
    handle.requestPermission.mockImplementation(async () => { permission.state = 'granted'; return 'granted'; });
    vi.stubGlobal('navigator', { ...navigator, userActivation: { isActive: true, hasBeenActive: true } });
    expect(await resolveLocalFile(track, db)).toBe(song);
    expect(handle.requestPermission).toHaveBeenCalledWith({ mode: 'read' });
  });

  it('a grant revoked mid-session surfaces as an access problem', async () => {
    const permission = { state: 'granted' as PermissionState };
    const { handle } = withHandle(permission);
    handle.queryPermission = vi.fn(async () => 'granted' as PermissionState); // stale answer
    permission.state = 'denied';
    const error = await resolveLocalFile(track, db).catch((e) => e);
    expect(error).toMatchObject({ problem: 'access' });
  });
});

describe('toLocalCatalogTrack', () => {
  it('falls back to the file name for the title', () => {
    const row = toLocalCatalogTrack('fab12', { path: 'x/02 - Song.flac', size: 1, mtime: 2 }, undefined, 99);
    expect(row).toMatchObject({ name: '02 - Song.flac', title: '02 - Song', addedAt: 99, sourceId: 'fab12:x/02 - Song.flac' });
  });
});
