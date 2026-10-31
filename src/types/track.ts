import type { PlaylistTrack } from './library';

/**
 * Where a track came from. Only `library` tracks have a catalog row, so only
 * they may reach `/api/songs/{id}/…`, share links or listening rooms (#258).
 */
export type TrackSource = 'library' | 'url' | 'local';

/** Id prefix of tracks built from a user-supplied URL (`remoteTracks.ts`). */
export const URL_TRACK_ID_PREFIX = 'url:';
/** Id prefix of tracks built from a local File. */
export const LOCAL_TRACK_ID_PREFIX = 'local-';

/** The track's source; tracks saved before `source` existed are classified by id prefix. */
export function trackSource(track: Pick<PlaylistTrack, 'id' | 'source'>): TrackSource {
  if (track.source) return track.source;
  if (track.id.startsWith(URL_TRACK_ID_PREFIX)) return 'url';
  if (track.id.startsWith(LOCAL_TRACK_ID_PREFIX)) return 'local';
  return 'library';
}

export function isLibraryTrack(track: Pick<PlaylistTrack, 'id' | 'source'>): boolean {
  return trackSource(track) === 'library';
}
