import { useCallback } from 'react';
import type { ConfigurableAudioBackend } from '../types/audio';
import type { PlaylistTrack } from '../types/library';
import { fetchReplayGainFromUrl } from '../utils/fetchReplayGain';
import {
  computeReplayGainLinear,
  replayGainTagsToTrackFields,
  resolveAlbumReferenceDb,
  type ReplayGainSettings,
} from '../utils/replayGain';

export interface ReplayGainApplicationOptions {
  player: ConfigurableAudioBackend | null;
  track: PlaylistTrack;
  queue: PlaylistTrack[];
  settings: ReplayGainSettings;
}

/** Merge fetched ReplayGain tags into a track when API metadata is missing. */
export async function enrichTrackReplayGain(track: PlaylistTrack): Promise<PlaylistTrack> {
  if (track.replaygain_track_db !== undefined || track.replaygain_album_db !== undefined) {
    return track;
  }
  if (!track.url || track.url.startsWith('blob:')) return track;

  const tags = await fetchReplayGainFromUrl(track.url);
  if (!tags) return track;
  return { ...track, ...replayGainTagsToTrackFields(tags) };
}

export function applyReplayGainToPlayer({
  player,
  track,
  queue,
  settings,
}: ReplayGainApplicationOptions): void {
  if (!player?.setReplayGainLinear) return;

  const albumReferenceDb = resolveAlbumReferenceDb(queue, track);
  const linear = computeReplayGainLinear(track, settings, albumReferenceDb);
  player.setReplayGainLinear(linear);
  player.setReplayGainLimiter?.(settings.limiterEnabled);
}

export function useReplayGainApplication() {
  const applyReplayGain = useCallback(async (
    player: ConfigurableAudioBackend | null,
    track: PlaylistTrack,
    queue: PlaylistTrack[],
    settings: ReplayGainSettings
  ): Promise<PlaylistTrack> => {
    const enriched = await enrichTrackReplayGain(track);
    applyReplayGainToPlayer({ player, track: enriched, queue, settings });
    return enriched;
  }, []);

  return { applyReplayGain };
}
