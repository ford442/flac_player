/**
 * Deployment base path (build-time `PUBLIC_PATH`, default "/"). The same value feeds
 * webpack `output.publicPath`, the HTML template, and the service worker precache,
 * so a build served from e.g. https://host/flac-player/ resolves everything there.
 */

/** Force a leading and trailing slash: "" → "/", "flac-player" → "/flac-player/". */
export function normalizePublicPath(raw: string | undefined | null): string {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '' || trimmed === '/') return '/';
  // Absolute URLs / "auto" are not supported here; keep only the path part.
  const path = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? new URL(trimmed).pathname : trimmed;
  return `/${path.replace(/^\/+|\/+$/g, '')}/`;
}

export const PUBLIC_PATH = normalizePublicPath(process.env.PUBLIC_PATH);

/** URL path of a file shipped next to index.html (e.g. "sdl-audio.js"). */
export function assetUrl(path: string, base: string = PUBLIC_PATH): string {
  return base + path.replace(/^\/+/, '');
}

/** `location.pathname` relative to the app base, always starting with "/". */
export function routePath(pathname: string, base: string = PUBLIC_PATH): string {
  if (base !== '/' && (pathname + '/').startsWith(base)) {
    return '/' + pathname.slice(base.length);
  }
  return pathname;
}
