import type { PlaylistTrack } from '../../types/library';

export const formatDuration = (seconds?: number) => {
  if (!seconds) return '--:--';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

export const formatDate = (dateStr?: string) => {
  if (!dateStr) return '--';
  return new Date(dateStr).toLocaleDateString();
};

export const formatReplayGainBadge = (track: PlaylistTrack) => {
  const db = track.replaygain_track_db ?? track.replaygain_album_db;
  if (db === undefined) return null;
  const sign = db >= 0 ? '+' : '';
  return `${sign}${db.toFixed(1)} dB`;
};

export const trackItemLabel = (track: PlaylistTrack) =>
  `${track.title || track.name} by ${track.author || 'Unknown'}. Space to queue and play, Enter to play now, E to edit`;

/** Bar heights (%) for the placeholder art, stable per track id. */
export function placeholderBars(id: string, count = 20): number[] {
  let seed = 2166136261;
  for (let i = 0; i < id.length; i++) seed = Math.imul(seed ^ id.charCodeAt(i), 16777619);
  return Array.from({ length: count }, () => {
    seed = Math.imul(seed ^ (seed >>> 15), 2246822507) >>> 0;
    return 30 + (seed % 60);
  });
}
