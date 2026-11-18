import type { PlaylistTrack } from './library';

/**
 * Where a track came from. Only `library` tracks have a catalog row, so only
 * they may reach `/api/songs/{id}/…`, share links or listening rooms (#258).
 */
export type TrackSource = 'library' | 'url' | 'local';

/** Id prefix of tracks built from a user-supplied URL (`remoteTracks.ts`). */
export const URL_TRACK_ID_PREFIX = 'url:';
/** Id prefix of tracks built from a local File (dropped files and granted folders). */
export const LOCAL_TRACK_ID_PREFIX = 'local-';
/** `url` of a folder track: an identity key for preload/gapless, never fetched (#284). */
export const LOCAL_URL_SCHEME = 'local:';

/**
 * A file inside a granted local folder (#284). The catalog keeps this, not the bytes:
 * `storage/localLibrary.ts` turns it back into a `File` when the track plays.
 */
export interface LocalFileRef {
  /** `CatalogSource.id` of the folder. */
  folderId: string;
  /** Slash-separated path below the folder root. */
  path: string;
  size: number;
  /** `File.lastModified`, epoch ms. */
  mtime: number;
}

/** Stable per (folder, path), so playlists and the saved queue can hold folder tracks. */
export function localTrackId(folderId: string, path: string): string {
  return `${LOCAL_TRACK_ID_PREFIX}${folderId}:${path}`;
}

export function localTrackUrl(folderId: string, path: string): string {
  return `${LOCAL_URL_SCHEME}${folderId}/${path}`;
}

/** The folder and path behind a folder-track id; null for dropped files and other ids. */
export function parseLocalTrackId(id: string): { folderId: string; path: string } | null {
  if (!id.startsWith(LOCAL_TRACK_ID_PREFIX)) return null;
  const rest = id.slice(LOCAL_TRACK_ID_PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon <= 0 || colon === rest.length - 1) return null;
  return { folderId: rest.slice(0, colon), path: rest.slice(colon + 1) };
}

/** The track's source; tracks saved before `source` existed are classified by id prefix. */
export function trackSource(track: Pick<PlaylistTrack, 'id' | 'source'>): TrackSource {
  if (track.source) return track.source;
  if (track.id.startsWith(URL_TRACK_ID_PREFIX)) return 'url';
  if (track.id.startsWith(LOCAL_TRACK_ID_PREFIX)) return 'local';
  return 'library';
}

/** Library tracks and folder tracks: ids that resolve again after a reload (playlists, saved queue). */
export function isResolvableTrack(track: Pick<PlaylistTrack, 'id' | 'source' | 'local'>): boolean {
  const source = trackSource(track);
  return source === 'library' || (source === 'local' && (!!track.local || parseLocalTrackId(track.id) !== null));
}

export function isLibraryTrack(track: Pick<PlaylistTrack, 'id' | 'source'>): boolean {
  return trackSource(track) === 'library';
}
