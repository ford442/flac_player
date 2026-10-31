import type { PlaylistTrack } from '../types/library';
import { LOCAL_TRACK_ID_PREFIX } from '../types/track';
import { parseReplayGainFromCommon, replayGainTagsToTrackFields } from '../utils/replayGain';

const stripExtension = (name: string) => name.replace(/\.[^/.]+$/, '');

/** A `local` queue entry for a dropped or picked file, with tags when they parse. */
export async function readLocalTrack(file: File): Promise<PlaylistTrack> {
  const base: PlaylistTrack = {
    id: `${LOCAL_TRACK_ID_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    source: 'local',
    file,
    name: file.name,
    title: stripExtension(file.name),
    author: 'Unknown Artist',
    url: URL.createObjectURL(file),
    duration: 0,
  };
  try {
    const { parseBlob } = await import('music-metadata');
    const meta = await parseBlob(file);
    return {
      ...base,
      title: meta.common.title || base.title,
      author: meta.common.artist || base.author,
      duration: meta.format.duration || 0,
      ...replayGainTagsToTrackFields(parseReplayGainFromCommon(meta.common)),
    };
  } catch {
    return base;
  }
}
