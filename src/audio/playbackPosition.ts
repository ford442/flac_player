// Resume position persistence (localStorage `flac_position`).
//
// Keyed by a stable track identity: catalog id, else the http(s) URL. Local
// files (`local-…` ids, blob:/object URLs) get a fresh id/URL every session,
// so they are never saved.

export const POSITION_STORAGE_KEY = 'flac_position';
/** Minimum spacing between writes while playing; pause / track change also write. */
export const POSITION_SAVE_INTERVAL_MS = 5000;

export interface PositionTrackIdentity {
  id?: string;
  url?: string;
}

interface SavedPosition {
  key?: string;
  /** Pre-engine format: catalog id only. */
  trackId?: string;
  time: number;
}

export function positionKeyForTrack(track: PositionTrackIdentity | null | undefined): string | null {
  if (!track) return null;
  if (track.id && !track.id.startsWith('local-')) return `id:${track.id}`;
  if (track.url && /^https?:\/\//i.test(track.url)) return `url:${track.url}`;
  return null;
}

export function readSavedPosition(key: string | null): number | null {
  if (!key) return null;
  try {
    const saved = JSON.parse(localStorage.getItem(POSITION_STORAGE_KEY) || 'null') as SavedPosition | null;
    if (!saved || !(saved.time > 0)) return null;
    const savedKey = saved.key ?? (saved.trackId ? `id:${saved.trackId}` : null);
    return savedKey === key ? saved.time : null;
  } catch {
    return null;
  }
}

export function writeSavedPosition(key: string, time: number): void {
  try {
    localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify({ key, time } satisfies SavedPosition));
  } catch { /* quota / private mode */ }
}
