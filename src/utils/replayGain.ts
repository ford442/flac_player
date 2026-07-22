import type { ICommonTagsResult } from 'music-metadata';
import type { PlaylistTrack } from '../types/library';

/** User-selectable ReplayGain application mode. */
export type ReplayGainMode = 'off' | 'track' | 'album';

export const REPLAYGAIN_DB_MIN = -12;
export const REPLAYGAIN_DB_MAX = 12;
export const DEFAULT_REPLAYGAIN_MODE: ReplayGainMode = 'off';

export interface ReplayGainTags {
  trackDb?: number;
  albumDb?: number;
  trackPeak?: number;
  albumPeak?: number;
}

export interface ReplayGainSettings {
  mode: ReplayGainMode;
  limiterEnabled: boolean;
}

/** Convert decibels to linear gain (10^(dB/20)). */
export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/** Clamp ReplayGain offset to a safe playback range. */
export function clampReplayGainDb(db: number): number {
  return Math.max(REPLAYGAIN_DB_MIN, Math.min(REPLAYGAIN_DB_MAX, db));
}

/** Parse ReplayGain tags from music-metadata `common` fields. */
export function parseReplayGainFromCommon(common: ICommonTagsResult): ReplayGainTags {
  const trackDb = common.replaygain_track_gain?.dB;
  const albumDb = common.replaygain_album_gain?.dB;
  const trackPeak = common.replaygain_track_peak?.ratio;
  const albumPeak = common.replaygain_album_peak?.ratio;

  return {
    trackDb: typeof trackDb === 'number' && Number.isFinite(trackDb) ? trackDb : undefined,
    albumDb: typeof albumDb === 'number' && Number.isFinite(albumDb) ? albumDb : undefined,
    trackPeak: typeof trackPeak === 'number' && Number.isFinite(trackPeak) ? trackPeak : undefined,
    albumPeak: typeof albumPeak === 'number' && Number.isFinite(albumPeak) ? albumPeak : undefined,
  };
}

/** Map parsed tags onto PlaylistTrack optional fields. */
export function replayGainTagsToTrackFields(tags: ReplayGainTags): Partial<PlaylistTrack> {
  const fields: Partial<PlaylistTrack> = {};
  if (tags.trackDb !== undefined) fields.replaygain_track_db = tags.trackDb;
  if (tags.albumDb !== undefined) fields.replaygain_album_db = tags.albumDb;
  if (tags.trackPeak !== undefined) fields.replaygain_track_peak = tags.trackPeak;
  if (tags.albumPeak !== undefined) fields.replaygain_album_peak = tags.albumPeak;
  return fields;
}

export function hasReplayGainMetadata(track: PlaylistTrack): boolean {
  return track.replaygain_track_db !== undefined || track.replaygain_album_db !== undefined;
}

/**
 * Album mode uses the first queued track's album gain (reference album for the session).
 * Falls back to the current track's album gain when the queue is empty.
 */
export function resolveAlbumReferenceDb(
  queue: PlaylistTrack[],
  fallbackTrack?: PlaylistTrack | null
): number | undefined {
  const ref = queue[0] ?? fallbackTrack;
  return ref?.replaygain_album_db;
}

/** Select the dB offset for the active mode, or 0 when off / missing tags. */
export function resolveReplayGainDb(
  track: PlaylistTrack,
  settings: ReplayGainSettings,
  albumReferenceDb?: number
): number {
  if (settings.mode === 'off') return 0;

  let rawDb = 0;
  if (settings.mode === 'track') {
    rawDb = track.replaygain_track_db ?? 0;
  } else {
    rawDb = albumReferenceDb ?? track.replaygain_album_db ?? track.replaygain_track_db ?? 0;
  }

  if (rawDb === 0) return 0;
  return clampReplayGainDb(rawDb);
}

/**
 * When limiter is enabled and peak metadata exists, reduce positive gain to avoid clipping.
 * Uses the peak tag that matches the active mode when available.
 */
export function applyPeakLimiting(
  gainDb: number,
  track: PlaylistTrack,
  mode: ReplayGainMode,
  limiterEnabled: boolean
): number {
  if (!limiterEnabled || gainDb <= 0) return gainDb;

  const peak = mode === 'album'
    ? (track.replaygain_album_peak ?? track.replaygain_track_peak)
    : (track.replaygain_track_peak ?? track.replaygain_album_peak);

  if (peak === undefined || peak <= 0) return gainDb;

  const headroomDb = 20 * Math.log10(1 / peak);
  return Math.min(gainDb, headroomDb);
}

export function computeReplayGainLinear(
  track: PlaylistTrack,
  settings: ReplayGainSettings,
  albumReferenceDb?: number
): number {
  const limitedDb = applyPeakLimiting(
    resolveReplayGainDb(track, settings, albumReferenceDb),
    track,
    settings.mode,
    settings.limiterEnabled
  );
  return dbToLinear(limitedDb);
}
