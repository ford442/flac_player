// Listening rooms — room links and per-tab host credentials.
//
// Join links use `?room={id}` (like `?share=`): the bundle loads with
// relative asset paths, so a query string works from any static host or
// subpath. `/room/{id}` is also recognized for hosts that rewrite it to the SPA.
//
// The host token lives in sessionStorage only: it survives a reload of the
// host tab (so the host reclaims the room within the grace period) but is
// never part of the join URL.

const ROOM_ID = /^[A-Za-z0-9_-]{4,64}$/;
const ROOM_PATH = /^(.*\/)room\/([A-Za-z0-9_-]{4,64})\/?$/;
const DEEP_LINK_PATH = /\/(?:room|playlist)\/[^/]*\/?$/;
const HOST_TOKEN_PREFIX = 'flac_room_host:';
const CLIENT_ID_KEY = 'flac_room_client_id';

/** Room id from `?room=` or a `/room/{id}` path; null when absent or malformed. */
export function getRoomIdFromLocation(search: string, pathname: string): string | null {
  const fromQuery = new URLSearchParams(search).get('room');
  if (fromQuery !== null) return ROOM_ID.test(fromQuery) ? fromQuery : null;
  const match = pathname.match(ROOM_PATH);
  return match ? match[2] : null;
}

export function getCurrentRoomId(): string | null {
  return getRoomIdFromLocation(window.location.search, window.location.pathname);
}

export function isRoomRoute(): boolean {
  return getCurrentRoomId() !== null;
}

/** App path with any `/room/{id}` or `/playlist/{id}` suffix removed (usually `/`). */
export function appBasePath(pathname: string = window.location.pathname): string {
  return pathname.replace(DEEP_LINK_PATH, '/') || '/';
}

/** Relative URL of a room inside this app. */
export function roomHref(roomId: string, pathname: string = window.location.pathname): string {
  return `${appBasePath(pathname)}?room=${encodeURIComponent(roomId)}`;
}

/** Join links are built from the app's own origin, whatever host serves the API. */
export function joinUrlFor(
  roomId: string,
  origin: string = window.location.origin,
  pathname: string = window.location.pathname,
): string {
  return `${origin}${roomHref(roomId, pathname)}`;
}

export function saveHostToken(roomId: string, token: string): void {
  try { sessionStorage.setItem(HOST_TOKEN_PREFIX + roomId, token); } catch { /* storage blocked */ }
}

export function loadHostToken(roomId: string): string | null {
  try { return sessionStorage.getItem(HOST_TOKEN_PREFIX + roomId); } catch { return null; }
}

export function clearHostToken(roomId: string): void {
  try { sessionStorage.removeItem(HOST_TOKEN_PREFIX + roomId); } catch { /* storage blocked */ }
}

/** Stable per-tab id so a guest reconnect reclaims its slot instead of taking a new one. */
export function getRoomClientId(): string {
  try {
    const existing = sessionStorage.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
    const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem(CLIENT_ID_KEY, id);
    return id;
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
