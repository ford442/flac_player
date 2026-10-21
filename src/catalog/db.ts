// The library catalog in IndexedDB (Dexie): every source's tracks, derived albums and
// artists, playlists and small app state. The offline source of truth for the library;
// audio bytes stay in trackCache (Cache API).

import Dexie, { type Table } from 'dexie';
import type { PlaylistTrack } from '../types/library';
import type { LocalPlaylist } from '../types/playlist';
import type { TrackSource } from '../types/track';

export const CATALOG_DB_NAME = 'flac_player';

/** A track row. `[source+sourceId]` is the key; library rows use the API id as `sourceId`. */
export interface CatalogTrack extends Omit<PlaylistTrack, 'file' | 'source'> {
  source: TrackSource;
  sourceId: string;
  /** When the track entered the library (created_at, else first seen), epoch ms. */
  addedAt: number;
  album?: string;
  year?: number;
  sampleRate?: number;
  bitsPerSample?: number;
  channels?: number;
  codec?: string;
  /** Hidden from the library; the host keeps trashed rows. */
  trashed?: boolean;
}

export interface CatalogAlbum {
  /** Normalized `artist|album`. */
  id: string;
  title: string;
  artist: string;
  year?: number;
  trackCount: number;
  sources: TrackSource[];
}

export interface CatalogArtist {
  /** Normalized name. */
  id: string;
  name: string;
  trackCount: number;
  albumCount: number;
}

/** Cover art, keyed by a content hash so identical art is stored once (filled from Phase 2). */
export interface CatalogArtwork {
  hash: string;
  blob: Blob;
  mime: string;
  size: number;
}

export interface CatalogSource {
  /** `library` for the remote host; local folders get their own ids (Phase 2). */
  id: string;
  kind: 'remote' | 'folder' | 'files';
  label: string;
  trackCount: number;
  lastSyncAt?: number;
}

/** Resumable scanner progress per source (Phase 2). */
export interface CatalogScanState {
  sourceId: string;
  cursor?: string;
  scanned: number;
  total?: number;
  updatedAt: number;
}

export interface CatalogStateRow {
  key: string;
  value: unknown;
}

export class CatalogDb extends Dexie {
  tracks!: Table<CatalogTrack, [string, string]>;
  albums!: Table<CatalogAlbum, string>;
  artists!: Table<CatalogArtist, string>;
  artwork!: Table<CatalogArtwork, string>;
  sources!: Table<CatalogSource, string>;
  scanState!: Table<CatalogScanState, string>;
  playlists!: Table<LocalPlaylist, string>;
  state!: Table<CatalogStateRow, string>;

  /** The IndexedDB factory this catalog opens on (legacy imports read other databases from it). */
  readonly factory: IDBFactory | undefined;

  constructor(name = CATALOG_DB_NAME, deps?: { indexedDB: IDBFactory; IDBKeyRange: typeof IDBKeyRange }) {
    super(name, deps);
    this.factory = deps ? deps.indexedDB : globalThis.indexedDB;
    // Add a new version() for schema changes; never edit a shipped one.
    this.version(1).stores({
      tracks: '[source+sourceId], album, artist, year, sampleRate, bitsPerSample, channels, rating, *tags, addedAt',
      albums: 'id, artist, year',
      artists: 'id',
      artwork: 'hash',
      sources: 'id',
      scanState: 'sourceId',
      playlists: 'id, updatedAt',
      state: 'key',
    });
  }
}

let shared: CatalogDb | null = null;

/** The app's catalog, opened on first use against the current global IndexedDB. */
export function getCatalogDb(): CatalogDb {
  if (!shared) {
    shared = new CatalogDb(CATALOG_DB_NAME, { indexedDB: globalThis.indexedDB, IDBKeyRange: globalThis.IDBKeyRange });
  }
  return shared;
}

/** Close and forget the shared catalog (tests swap the IndexedDB factory between cases). */
export function closeCatalogDb(): void {
  shared?.close();
  shared = null;
}

export async function readState<T>(db: CatalogDb, key: string): Promise<T | undefined> {
  return (await db.state.get(key))?.value as T | undefined;
}

export async function writeState(db: CatalogDb, key: string, value: unknown): Promise<void> {
  await db.state.put({ key, value });
}

/** Library-source rows: the `[source+sourceId]` range for one source. */
export function sourceRange(db: CatalogDb, source: TrackSource) {
  return db.tracks.where('[source+sourceId]').between([source, Dexie.minKey], [source, Dexie.maxKey]);
}
