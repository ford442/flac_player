/**
 * URLs of files copied verbatim into the build root (service-worker.js, *.wasm,
 * icons), resolved against webpack's public path so a deploy under `/flac-player/`
 * finds them. At the site root the result is the same root-relative path as before.
 */

// Replaced by webpack with its runtime public path; absent under vitest.
declare const __webpack_public_path__: string | undefined;

/**
 * `path` under `publicPath` as seen from `pageUrl`. Same-origin results stay
 * root-relative (`/flac-player/dsp-chain.wasm`); another origin's stay absolute.
 *
 * webpack's `publicPath: 'auto'` arrives as an absolute URL of the bundle's
 * directory; an empty one means "next to the page".
 */
export function resolvePublicUrl(path: string, publicPath: string, pageUrl: string): string {
  const prefix = publicPath === '' ? './' : publicPath.endsWith('/') ? publicPath : `${publicPath}/`;
  const base = new URL(prefix, new URL('./', pageUrl));
  const resolved = new URL(path.replace(/^\/+/, ''), base);
  return resolved.origin === new URL(pageUrl).origin ? resolved.pathname + resolved.search : resolved.href;
}

export function publicUrl(path: string): string {
  const pageUrl = typeof document !== 'undefined'
    ? document.baseURI
    : typeof location !== 'undefined' ? location.href : null;
  if (!pageUrl) return `/${path.replace(/^\/+/, '')}`;
  const publicPath = typeof __webpack_public_path__ === 'string' ? __webpack_public_path__ : '';
  return resolvePublicUrl(path, publicPath, pageUrl);
}
