// Local folders as library sources (#284).
//
// Chromium: `showDirectoryPicker({ mode: 'read' })`; the handle is kept on the folder's
// `sources` row in the catalog (IndexedDB stores handles by structured clone), and
// read permission is re-checked after every reload (`queryPermission`, then
// `requestPermission` from a click). Firefox / Safari: an `<input webkitdirectory>`
// fallback whose `File`s live for this page only; after a reload the folder's rows stay
// in the catalog and the UI asks for the folder again.
//
// Audio bytes never leave the disk: the catalog holds tags and a `LocalFileRef`, and
// `resolveLocalFile` reopens the file when it plays. Nothing here copies into OPFS or
// Cache Storage.

import { getCatalogDb, type CatalogDb, type CatalogSource } from '../catalog/db';
import { rebuildAggregates } from '../catalog/aggregates';
import { fromCatalogTrack } from '../catalog/libraryQuery';
import type { PlaylistTrack } from '../types/library';
import { parseLocalTrackId, type LocalFileRef } from '../types/track';
import { isLocalAudioName, type DirectoryHandle, type FolderEntry } from './folderWalk';

export { isLocalAudioName, LOCAL_AUDIO_EXTENSIONS, walkDirectory, type DirectoryHandle, type FolderEntry } from './folderWalk';

type DirectoryPicker = (options?: { mode?: 'read' | 'readwrite'; id?: string }) => Promise<FileSystemDirectoryHandle>;

function directoryPicker(): DirectoryPicker | null {
  const picker = (globalThis as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
  return typeof picker === 'function' ? picker : null;
}

/** True where a granted folder survives a reload (Chromium's File System Access). */
export function supportsPersistentFolders(): boolean {
  return directoryPicker() !== null;
}

/** A folder source row; `handle` is set for picker folders, absent for `webkitdirectory` ones. */
export interface LocalFolderSource extends CatalogSource {
  kind: 'folder' | 'files';
  handle?: DirectoryHandle;
}

export function isLocalFolderSource(source: CatalogSource): source is LocalFolderSource {
  return source.kind === 'folder' || source.kind === 'files';
}

export async function listLocalFolders(db: CatalogDb = getCatalogDb()): Promise<LocalFolderSource[]> {
  return (await db.sources.toArray()).filter(isLocalFolderSource);
}

// --- Access -------------------------------------------------------------------------

/**
 * `granted`: playable and scannable. `prompt`: the browser forgot the grant (reload,
 * revoked in site settings); a click on Reconnect asks again. `denied`: the user said no.
 * `unavailable`: a fallback folder after a reload; it has to be picked again.
 */
export type FolderAccess = 'granted' | 'prompt' | 'denied' | 'unavailable';

/** Files from `webkitdirectory` picks, by folder id; gone on reload. */
const sessionFiles = new Map<string, Map<string, File>>();

export async function folderAccess(source: LocalFolderSource): Promise<FolderAccess> {
  if (!source.handle) return sessionFiles.has(source.id) ? 'granted' : 'unavailable';
  if (!source.handle.queryPermission) return 'granted';
  try {
    return toAccess(await source.handle.queryPermission({ mode: 'read' }));
  } catch {
    return 'prompt';
  }
}

/** Ask again for read access; needs a user gesture (Chromium shows its permission bar). */
export async function requestFolderAccess(source: LocalFolderSource): Promise<FolderAccess> {
  const handle = source.handle;
  if (!handle) return folderAccess(source);
  if (!handle.requestPermission) return folderAccess(source);
  try {
    return toAccess(await handle.requestPermission({ mode: 'read' }));
  } catch {
    return 'prompt';
  }
}

function toAccess(state: PermissionState): FolderAccess {
  return state === 'granted' ? 'granted' : state === 'denied' ? 'denied' : 'prompt';
}

// --- Adding and removing folders -----------------------------------------------------

function newFolderId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return `f${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Show the directory picker and store the folder. Picking a folder that is already in the
 * library returns its existing row (ids, and so playlists, stay stable). Null when the
 * user cancels or the browser has no picker.
 */
export async function pickFolder(db: CatalogDb = getCatalogDb()): Promise<LocalFolderSource | null> {
  const picker = directoryPicker();
  if (!picker) return null;
  let handle: DirectoryHandle;
  try {
    handle = await picker({ mode: 'read', id: 'flac-player-library' }) as DirectoryHandle;
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'AbortError' || err.name === 'NotAllowedError')) return null;
    throw err;
  }
  for (const existing of await listLocalFolders(db)) {
    if (existing.handle && await existing.handle.isSameEntry(handle).catch(() => false)) {
      const refreshed: LocalFolderSource = { ...existing, handle, label: handle.name };
      await db.sources.put(refreshed);
      return refreshed;
    }
  }
  const source: LocalFolderSource = { id: newFolderId(), kind: 'folder', label: handle.name, trackCount: 0, handle };
  await db.sources.put(source);
  return source;
}

/** Path below the picked folder for a `webkitdirectory` file (`Root/a/b.flac` → `a/b.flac`). */
function relativePath(file: File): string {
  const full = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
  const slash = full.indexOf('/');
  return slash >= 0 ? full.slice(slash + 1) : full;
}

function rootLabel(files: readonly File[]): string {
  const first = files[0] as (File & { webkitRelativePath?: string }) | undefined;
  const full = first?.webkitRelativePath ?? '';
  return full.includes('/') ? full.slice(0, full.indexOf('/')) : 'Local files';
}

/**
 * Fallback for browsers without the picker: files from `<input webkitdirectory>`. They play
 * until the page reloads. Picking a folder with the same name again re-attaches its rows.
 */
export async function addFolderFromFiles(
  fileList: ArrayLike<File>,
  db: CatalogDb = getCatalogDb(),
): Promise<LocalFolderSource | null> {
  const files = Array.from(fileList);
  if (files.length === 0) return null;
  const label = rootLabel(files);
  const existing = (await listLocalFolders(db)).find((s) => s.kind === 'files' && s.label === label);
  const source: LocalFolderSource = existing ?? { id: newFolderId(), kind: 'files', label, trackCount: 0 };
  if (!existing) await db.sources.put(source);
  const byPath = new Map<string, File>();
  for (const file of files) if (isLocalAudioName(file.name)) byPath.set(relativePath(file), file);
  sessionFiles.set(source.id, byPath);
  return source;
}

/** Drop a folder: its source row, scan state and catalog rows (the files on disk are untouched). */
export async function removeFolder(id: string, db: CatalogDb = getCatalogDb()): Promise<void> {
  sessionFiles.delete(id);
  await db.transaction('rw', db.sources, db.scanState, db.tracks, async () => {
    await db.sources.delete(id);
    await db.scanState.delete(id);
    await folderRows(db, id).delete();
  });
  await rebuildAggregates(db);
}

/** Catalog rows of one folder: `[local, "<folderId>:<path>"]`. */
export function folderRows(db: CatalogDb, folderId: string) {
  return db.tracks.where('[source+sourceId]').between(['local', `${folderId}:`], ['local', `${folderId}:￿`]);
}

// --- Opening files -------------------------------------------------------------------

/** The fallback folder's files, if this page still has them. */
export function sessionFolderEntries(folderId: string): FolderEntry[] | null {
  const files = sessionFiles.get(folderId);
  if (!files) return null;
  return [...files].map(([path, file]) => ({ path, getFile: async () => file }));
}

export type LocalFileProblem = 'access' | 'missing' | 'unknown-folder';

/** A folder track could not be opened; `problem` picks the recover action. */
export class LocalFileUnavailableError extends Error {
  constructor(readonly problem: LocalFileProblem, readonly folderLabel: string | undefined, message: string) {
    super(message);
    this.name = 'LocalFileUnavailableError';
  }
}

async function fileAt(dir: DirectoryHandle, path: string): Promise<File> {
  const parts = path.split('/');
  let current: FileSystemDirectoryHandle = dir;
  for (const part of parts.slice(0, -1)) current = await current.getDirectoryHandle(part);
  return (await current.getFileHandle(parts[parts.length - 1]!)).getFile();
}

function userActivationActive(): boolean {
  const activation = (globalThis.navigator as Navigator & { userActivation?: { isActive: boolean } } | undefined)?.userActivation;
  return activation?.isActive === true;
}

/** The `LocalFileRef` of a folder track, from the track or (for saved ids) its id. */
export function localRefOf(track: Pick<PlaylistTrack, 'id' | 'local'>): Pick<LocalFileRef, 'folderId' | 'path'> | null {
  return track.local ?? parseLocalTrackId(track.id);
}

/**
 * The `File` behind a local track: a dropped file as-is, a folder track reopened from its
 * handle (asking for permission again while the click that started playback is still
 * active) or from this page's fallback pick.
 */
export async function resolveLocalFile(
  track: Pick<PlaylistTrack, 'id' | 'local' | 'file' | 'name'>,
  db: CatalogDb = getCatalogDb(),
): Promise<File> {
  if (track.file) return track.file;
  const ref = localRefOf(track);
  if (!ref) throw new LocalFileUnavailableError('missing', undefined, 'This local file is no longer available; add it again.');

  const source = await db.sources.get(ref.folderId);
  if (!source || !isLocalFolderSource(source)) {
    throw new LocalFileUnavailableError('unknown-folder', undefined, `"${track.name}" belongs to a folder that was removed from the library.`);
  }
  const folder = source as LocalFolderSource;
  if (!folder.handle) {
    const file = sessionFiles.get(folder.id)?.get(ref.path);
    if (file) return file;
    throw new LocalFileUnavailableError(
      sessionFiles.has(folder.id) ? 'missing' : 'access',
      folder.label,
      sessionFiles.has(folder.id)
        ? `"${ref.path}" is not in "${folder.label}" any more.`
        : `Pick the folder "${folder.label}" again to play its tracks (this browser forgets folders on reload).`,
    );
  }

  let access = await folderAccess(folder);
  if (access === 'prompt' && userActivationActive()) access = await requestFolderAccess(folder);
  if (access !== 'granted') {
    throw new LocalFileUnavailableError('access', folder.label, `Access to the folder "${folder.label}" needs to be granted again: use Reconnect under Local Folders.`);
  }
  try {
    return await fileAt(folder.handle, ref.path);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotAllowedError') {
      throw new LocalFileUnavailableError('access', folder.label, `Access to the folder "${folder.label}" was revoked: use Reconnect under Local Folders.`);
    }
    throw new LocalFileUnavailableError('missing', folder.label, `"${ref.path}" is not in "${folder.label}" any more; rescan the folder.`);
  }
}

/** A folder track from the catalog by id (playlists and saved queues hold ids). */
export async function findFolderTrack(id: string, db: CatalogDb = getCatalogDb()): Promise<PlaylistTrack> {
  const ref = parseLocalTrackId(id);
  const row = ref ? await db.tracks.get(['local', `${ref.folderId}:${ref.path}`]) : undefined;
  if (!row) throw new Error(`Not in a local folder: ${id}`);
  return fromCatalogTrack(row);
}

/** Test hook: forget the fallback picks, as a reload would. */
export function clearSessionFolders(): void {
  sessionFiles.clear();
}
