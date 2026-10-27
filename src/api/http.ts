// One HTTP path for the library host (#258): every catalog request goes through
// apiFetch, which checks the status, validates the body with a valibot schema and
// honours an AbortSignal. resolveTrackUrl is the only place a catalog row's `url`
// becomes playable.

import * as v from 'valibot';
import { debug } from '../utils/debug';

/** Library host. Do not change without updating the backend CORS origins (see CLAUDE.md). */
export const API_BASE_URL = process.env.REACT_APP_API_URL || (typeof window !== 'undefined' ? window.location.origin : 'https://storage.noahcohn.com');

/** Cloud playlists host (may differ from the library host). */
export const PLAYLIST_API_URL = process.env.REACT_APP_PLAYLIST_API_URL || 'https://storage.noahcohn.com';

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly url: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiRequestOptions extends Omit<RequestInit, 'body'> {
  /** Sent as a JSON body with `Content-Type: application/json`. */
  json?: unknown;
  /** Host for a relative `path`; defaults to API_BASE_URL. */
  base?: string;
}

/** Absolute URL for an API path on `base`. */
export function apiUrl(path: string, base: string = API_BASE_URL): string {
  return /^https?:\/\//i.test(path) ? path : `${base}${path}`;
}

/** The raw request (no status check) for callers that read status codes themselves. */
export async function apiRequest(path: string, options: ApiRequestOptions = {}): Promise<Response> {
  const { json, base, headers, ...init } = options;
  const url = apiUrl(path, base);
  const started = performance.now();
  const response = await fetch(url, {
    mode: 'cors',
    credentials: 'omit',
    ...init,
    headers: json === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  debug.log('API_RESPONSE', {
    method: init.method ?? 'GET',
    url,
    status: response.status,
    duration: `${(performance.now() - started).toFixed(2)}ms`,
  });
  return response;
}

/**
 * Request `path` and return its body validated by `schema` (or nothing when the
 * schema is null). Non-2xx responses and bodies that fail validation throw ApiError.
 */
export function apiFetch<T>(path: string, schema: v.GenericSchema<unknown, T>, options?: ApiRequestOptions): Promise<T>;
export function apiFetch(path: string, schema: null, options?: ApiRequestOptions): Promise<void>;
export async function apiFetch<T>(
  path: string,
  schema: v.GenericSchema<unknown, T> | null,
  options: ApiRequestOptions = {},
): Promise<T | void> {
  const response = await apiRequest(path, options);
  const method = options.method ?? 'GET';
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    debug.error('API_ERROR', { method, url: response.url || path, status: response.status, body: body.slice(0, 200) });
    throw new ApiError(`${method} ${path} failed: ${response.status} ${response.statusText}`.trim(), response.status, path);
  }
  if (!schema) return;
  const result = v.safeParse(schema, await response.json());
  if (!result.success) {
    throw new ApiError(`Unexpected response from ${path}: ${v.summarize(result.issues)}`, response.status, path);
  }
  return result.output;
}

/**
 * Absolute URL for a catalog row. The backend sends absolute https URLs; a
 * server-relative path gets the API host, and a row without one falls back to the
 * `/api/music/{id}` proxy (should not happen with a healthy backend).
 */
export function resolveTrackUrl(url: string | null | undefined, id: string): string {
  if (url && /^(https?:|gs:)/i.test(url)) return url;
  if (url) return `${API_BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
  return `${API_BASE_URL}/api/music/${encodeURIComponent(id)}`;
}
