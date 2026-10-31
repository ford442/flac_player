/** Lazy-load Emscripten glue scripts from public/ (not bundled into the main JS chunk). */

import { assetUrl } from '../utils/publicPath';

/** One promise per URL: concurrent callers share the same <script> and its load event. */
const inflight = new Map<string, Promise<void>>();

function whenScriptLoads(script: HTMLScriptElement, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    script.addEventListener('load', () => {
      script.dataset.loaded = '1';
      resolve();
    }, { once: true });
    script.addEventListener('error', () => reject(new Error(`Failed to load ${url}`)), { once: true });
  });
}

/**
 * Resolves once the script has executed (its `load` event), not when the tag
 * exists. A failed load is forgotten and its tag removed so a later call retries.
 */
export function loadWasmScript(url: string): Promise<void> {
  const pending = inflight.get(url);
  if (pending) return pending;

  let promise: Promise<void>;
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${url}"]`);
  if (existing?.dataset.loaded === '1') {
    promise = Promise.resolve();
  } else if (existing) {
    promise = whenScriptLoads(existing, url);
  } else {
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    promise = whenScriptLoads(script, url);
    document.head.appendChild(script);
  }

  promise = promise.catch((err: unknown) => {
    inflight.delete(url);
    document.querySelector(`script[src="${url}"]`)?.remove();
    throw err;
  });
  inflight.set(url, promise);
  return promise;
}

export const WASM_ASSETS = {
  sdl3: assetUrl('sdl-audio.js'),
  projectmHost: assetUrl('projectm/projectm-host.js'),
  speexResampler: assetUrl('speex-resampler.js'),
} as const;
