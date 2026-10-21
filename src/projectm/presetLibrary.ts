/**
 * Runtime Milkdrop preset pack for the in-app projectM host.
 *
 * The host WASM ships no presets. `public/projectm/presets.json` lists a curated
 * subset of projectM's "Cream of the Crop" pack (pinned commit) and the CDN base
 * plus mirrors the files are fetched from; each .milk is fetched only when it is
 * shown and is cached by the service worker. jsDelivr intermittently answers 403
 * for this repo (it is over jsDelivr's 50 MB package limit), so a failed fetch
 * falls through to the mirrors (raw.githubusercontent.com).
 * `REACT_APP_PROJECTM_PRESET_BASE` replaces them all (self-hosted mirror).
 * Under COEP require-corp every host must answer CORS.
 */
import { assetUrl } from '../utils/publicPath';

export const PRESET_MANIFEST_URL = assetUrl('projectm/presets.json');
/** `?preset=<path in pack>` opens that preset (shareable link). */
export const PRESET_URL_PARAM = 'preset';

export interface PresetManifest {
  name: string;
  /** Absolute base URLs ending in '/', tried in order; preset paths are relative to them. */
  bases: string[];
  presets: string[];
}

/** Display name: file name without folders or the .milk extension. */
export function presetDisplayName(path: string): string {
  const file = path.split('/').pop() ?? path;
  return file.replace(/\.milk$/i, '');
}

/**
 * A pack-relative .milk path (from the manifest or a `?preset=` link). Rejects
 * absolute URLs, `..` segments and backslashes so a link cannot point the
 * fetch anywhere but the configured base.
 */
export function isSafePresetPath(path: string): boolean {
  if (!/\.milk$/i.test(path) || path.length > 512) return false;
  if (path.startsWith('/') || path.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(path)) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export function presetUrl(base: string, path: string): string {
  return base + path.split('/').map(encodeURIComponent).join('/');
}

function envPresetBase(): string {
  try {
    return process.env.REACT_APP_PROJECTM_PRESET_BASE || '';
  } catch {
    return '';
  }
}

function withSlash(base: string): string {
  return base.endsWith('/') ? base : `${base}/`;
}

/** Validate presets.json `{ name, base, mirrors?, presets }`; `baseOverride` (env) replaces base + mirrors. */
export function parsePresetManifest(json: unknown, baseOverride = envPresetBase()): PresetManifest {
  const raw = json as { name?: unknown; base?: unknown; mirrors?: unknown; presets?: unknown } | null;
  if (!raw || typeof raw.base !== 'string' || !Array.isArray(raw.presets)) {
    throw new Error('presets.json: expected { base, presets[] }');
  }
  const mirrors = Array.isArray(raw.mirrors) ? raw.mirrors.filter((m): m is string => typeof m === 'string') : [];
  return {
    name: typeof raw.name === 'string' ? raw.name : 'Presets',
    bases: (baseOverride ? [baseOverride] : [raw.base, ...mirrors]).map(withSlash),
    presets: raw.presets.filter((p): p is string => typeof p === 'string' && isSafePresetPath(p)),
  };
}

export async function fetchPresetManifest(
  fetchImpl: typeof fetch = fetch,
  url = PRESET_MANIFEST_URL,
): Promise<PresetManifest> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return parsePresetManifest(await res.json());
}

/** Preset named by `?preset=` in `search`, when it is a safe pack path. */
export function readPresetFromSearch(
  search: string = typeof window !== 'undefined' ? window.location.search : '',
): string | null {
  try {
    const value = new URLSearchParams(search).get(PRESET_URL_PARAM);
    return value && isSafePresetPath(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Link that reopens `path`: keeps the current query (room, etc.) and opens the
 * projectM view unless the link already picks an aesthetic.
 */
export function buildPresetShareUrl(path: string, href: string = window.location.href): string {
  const url = new URL(href);
  url.searchParams.set(PRESET_URL_PARAM, path);
  if (!url.searchParams.has('aesthetic')) url.searchParams.set('aesthetic', 'projectm');
  return url.toString();
}

/**
 * Order / history over the manifest. `next` walks the list, `random` picks any
 * other entry, `back` returns through what was shown. Paths that failed to
 * load are skipped until the playlist is rebuilt.
 */
export class PresetPlaylist {
  private readonly history: string[] = [];
  private readonly rejected = new Set<string>();
  private current: string | null = null;

  constructor(
    readonly presets: readonly string[],
    private readonly random: () => number = Math.random,
  ) {}

  getCurrent(): string | null {
    return this.current;
  }

  /** Record `path` as shown (pushes the previous one onto the history). */
  markShown(path: string): void {
    if (this.current && this.current !== path) {
      this.history.push(this.current);
      if (this.history.length > 100) this.history.shift();
    }
    this.current = path;
  }

  markRejected(path: string): void {
    this.rejected.add(path);
    if (this.current === path) this.current = this.history.pop() ?? null;
  }

  private usable(): string[] {
    return this.presets.filter((p) => !this.rejected.has(p));
  }

  next(): string | null {
    const list = this.usable();
    if (list.length === 0) return null;
    const at = this.current ? list.indexOf(this.current) : -1;
    return list[(at + 1) % list.length] ?? null;
  }

  previousInList(): string | null {
    const list = this.usable();
    if (list.length === 0) return null;
    const at = this.current ? list.indexOf(this.current) : 0;
    return list[(at - 1 + list.length) % list.length] ?? null;
  }

  randomPick(): string | null {
    const list = this.usable().filter((p) => p !== this.current);
    if (list.length === 0) return this.current;
    return list[Math.floor(this.random() * list.length) % list.length] ?? null;
  }

  /** Last shown preset, removed from the history (the caller shows it next). */
  back(): string | null {
    while (this.history.length > 0) {
      const path = this.history.pop()!;
      if (!this.rejected.has(path)) {
        // markShown would push current again; drop it so back/back keeps going.
        this.current = null;
        return path;
      }
    }
    return this.previousInList();
  }
}

/**
 * Fetches preset text from the first base that answers, keeping the last few in
 * memory (the SW keeps the rest).
 */
export class PresetFetcher {
  private readonly cache = new Map<string, string>();

  constructor(
    private readonly bases: readonly string[],
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    private readonly maxEntries = 16,
  ) {}

  async fetch(path: string, signal?: AbortSignal): Promise<string> {
    const hit = this.cache.get(path);
    if (hit !== undefined) {
      this.cache.delete(path);
      this.cache.set(path, hit);
      return hit;
    }
    const text = await this.fetchFirst(path, signal);
    this.cache.set(path, text);
    if (this.cache.size > this.maxEntries) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    return text;
  }

  private async fetchFirst(path: string, signal?: AbortSignal): Promise<string> {
    let lastError: unknown = new Error('no preset base configured');
    for (const base of this.bases) {
      const url = presetUrl(base, path);
      try {
        const res = await this.fetchImpl(url, { signal, mode: 'cors' });
        if (res.ok) return await res.text();
        lastError = new Error(`${url}: HTTP ${res.status}`);
      } catch (err) {
        if (signal?.aborted) throw err;
        lastError = err;
      }
    }
    throw lastError;
  }
}
