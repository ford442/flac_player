// Tracks that come from a user-supplied URL or the built-in demo set (no backend row).
import type { PlaylistTrack } from '../types/library';

export const DEMO_BASE_URL = 'https://projectm.1ink.us/songs/';

/** Files known to exist in the demo directory (a directory index is not CORS-readable). */
export const DEMO_FILES = [
  'Claws of the Angel.flac',
  'Canon in D.flac',
  'Arboreality.flac',
  'Ceramic Dream.flac',
  'Dark Particle.flac',
] as const;

/** "…/Claws%20of%20the%20Angel.flac?x=1" → "Claws of the Angel". */
function titleFromUrl(url: URL): string {
  const last = url.pathname.split('/').filter(Boolean).pop() ?? url.hostname;
  let decoded = last;
  try { decoded = decodeURIComponent(last); } catch { /* keep raw segment */ }
  return decoded.replace(/\.[a-z0-9]{2,5}$/i, '') || url.hostname;
}

/** Build a track from user input; null unless it is an absolute http(s) URL. */
export function trackFromUrl(raw: string): PlaylistTrack | null {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const title = titleFromUrl(url);
  return { id: `url:${url.href}`, name: title, title, url: url.href, type: 'music' };
}

export function demoTracks(): PlaylistTrack[] {
  return DEMO_FILES
    .map(file => trackFromUrl(DEMO_BASE_URL + encodeURIComponent(file)))
    .filter((t): t is PlaylistTrack => t !== null);
}
