// API client for song/library management endpoints. Every request goes through
// apiFetch (status check + valibot validation, see ./http.ts).

import type { CloudPlaylist, PlaylistTrack, LibraryStats, TagInfo, ShareResponse, SortBy } from '../types/library';
import { debug } from '../utils/debug';
import { API_BASE_URL, PLAYLIST_API_URL, ApiError, apiFetch, apiRequest, resolveTrackUrl } from './http';
import {
  CloudPlaylistListSchema, CloudPlaylistSchema, LibraryStatsSchema, MusicBrainzSearchSchema, PlaylistHealthSchema,
  PlaylistTrackIdsSchema, ShareResponseSchema, SharedPlaylistSchema, SongListSchema, SuggestTagsSchema,
  TagsResponseSchema, CatalogSongSchema, type CatalogSong,
} from './schemas';

const SYNC_MUSIC_ENDPOINTS = [
  {
    path: '/api/admin/sync-music?type=music',
    init: { method: 'POST' as const }
  },
  {
    path: '/api/admin/sync-music',
    init: { method: 'POST' as const, json: { type: 'music' } }
  }
] as const;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const SYNC_REQUEST_TIMEOUT_MS = 20_000;
const SYNC_RETRY_BASE_DELAY_MS = 400;

export interface MusicResyncResult {
  endpoint: string;
  status: number;
  statusText: string;
  payload: unknown;
  isAcceptedOrRunning: boolean;
}

export function getApiBaseUrl(): string {
  return API_BASE_URL;
}

/** Library filters for `GET /api/songs`. */
export interface SongQuery {
  limit?: number;
  offset?: number;
  ratingGte?: number;
  ratingLt?: number;
  tags?: string[];
  tagsMatch?: number;
  untagged?: boolean;
  search?: string;
  sortBy?: SortBy;
  sortDesc?: boolean;
  excludeId?: string;
  generationModel?: string;
}

function toLibraryTrack(song: CatalogSong): PlaylistTrack {
  return { ...song, source: 'library', url: resolveTrackUrl(song.url, song.id) };
}

// =============================================================================
// Songs / Library
// =============================================================================

export async function fetchSongs(
  options: SongQuery = {},
  signal?: AbortSignal,
): Promise<{ tracks: PlaylistTrack[]; total: number }> {
  const params = new URLSearchParams();

  if (options.limit) params.append('limit', options.limit.toString());
  if (options.offset) params.append('offset', options.offset.toString());
  if (options.ratingGte !== undefined) params.append('rating_gte', options.ratingGte.toString());
  if (options.ratingLt !== undefined) params.append('rating_lt', options.ratingLt.toString());
  if (options.tags?.length) params.append('tags', options.tags.join(','));
  if (options.tagsMatch) params.append('tags_match', options.tagsMatch.toString());
  if (options.untagged) params.append('untagged', 'true');
  if (options.search) params.append('search', options.search);
  if (options.sortBy) params.append('sort_by', options.sortBy);
  if (options.sortDesc !== undefined) params.append('sort_desc', options.sortDesc.toString());
  if (options.excludeId) params.append('exclude_id', options.excludeId);
  if (options.generationModel) params.append('generation_model', options.generationModel);

  const songs = await apiFetch(`/api/songs?${params}`, SongListSchema, { signal });
  debug.log('FETCH_LIBRARY_PARSED', { trackCount: songs.length });
  const tracks = songs.map(toLibraryTrack);
  return { tracks, total: tracks.length };
}

export async function fetchSong(songId: string, signal?: AbortSignal): Promise<PlaylistTrack> {
  try {
    return toLibraryTrack(await apiFetch(`/api/songs/${encodeURIComponent(songId)}`, CatalogSongSchema, { signal }));
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      throw new Error(`Track ${songId} is not available in the library (404)`);
    }
    throw error;
  }
}

/** Tracks sharing up to three of `trackTags` (at least two), excluding the seed track. */
export async function findSimilarTracks(
  trackId: string,
  trackTags: string[],
  minRating: number = 4,
  limit: number = 20
): Promise<PlaylistTrack[]> {
  const { tracks } = await fetchSongs({
    tags: trackTags.slice(0, 3),
    tagsMatch: 2,
    ratingGte: minRating,
    excludeId: trackId,
    limit,
    sortBy: 'random'
  });
  return tracks;
}

export function fetchTags(signal?: AbortSignal): Promise<TagInfo[]> {
  return apiFetch('/api/songs/tags', TagsResponseSchema, { signal });
}

export function fetchStats(signal?: AbortSignal): Promise<LibraryStats> {
  return apiFetch('/api/songs/stats', LibraryStatsSchema, { signal });
}

export async function triggerMusicResync(maxAttempts: number = 3): Promise<MusicResyncResult> {
  const attempts = Math.max(1, maxAttempts);
  let lastError: unknown = null;
  const acceptedStatuses = new Set([202, 409]);
  const getRetryDelay = (attempt: number): number => SYNC_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1));

  for (const endpoint of SYNC_MUSIC_ENDPOINTS) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), SYNC_REQUEST_TIMEOUT_MS);

      try {
        debug.log('SYNC_MUSIC_REQUEST', { endpoint: endpoint.path, attempt, attempts });

        const response = await apiRequest(endpoint.path, { ...endpoint.init, signal: controller.signal });

        clearTimeout(timeout);

        const bodyText = await response.text();
        let payload: unknown = bodyText;
        if (bodyText) {
          try {
            payload = JSON.parse(bodyText);
          } catch {
            payload = bodyText;
          }
        }

        const isAcceptedOrRunning = acceptedStatuses.has(response.status);
        if (response.ok || isAcceptedOrRunning) {
          debug.log('SYNC_MUSIC_SUCCESS', { endpoint: endpoint.path, status: response.status });
          return {
            endpoint: `${API_BASE_URL}${endpoint.path}`,
            status: response.status,
            statusText: response.statusText,
            payload,
            isAcceptedOrRunning
          };
        }

        // Retry transient server failures and rate limits, but do not retry 4xx request errors.
        const shouldRetrySameEndpoint = response.status >= 500 || response.status === 429;
        debug.warn('SYNC_MUSIC_FAILED_RESPONSE', {
          endpoint: endpoint.path,
          status: response.status,
          attempt,
          shouldRetrySameEndpoint
        });

        if (!shouldRetrySameEndpoint) {
          break;
        }
        if (attempt < attempts) {
          await wait(getRetryDelay(attempt));
        }
      } catch (error) {
        clearTimeout(timeout);
        lastError = error;
        debug.warn('SYNC_MUSIC_REQUEST_ERROR', {
          endpoint: endpoint.path,
          attempt,
          message: error instanceof Error ? error.message : String(error)
        });
        if (attempt < attempts) {
          await wait(getRetryDelay(attempt));
        }
      }
    }
  }

  if (lastError instanceof Error) {
    throw new Error(`Failed to trigger library rescan: ${lastError.message}`);
  }
  throw new Error('Failed to trigger library rescan via admin sync endpoint');
}

// =============================================================================
// Track CRUD
// =============================================================================

/** Best effort: a failed play count never interrupts playback. */
export async function recordPlay(musicId: string): Promise<void> {
  try {
    await apiFetch(`/api/songs/${encodeURIComponent(musicId)}/play`, null, { method: 'POST' });
  } catch (error) {
    debug.warn('RECORD_PLAY_FAILED', {
      message: error instanceof Error ? error.message : String(error),
      musicId
    });
  }
}

export function updateSampleMetadata(
  musicId: string,
  updates: {
    name?: string;
    title?: string;
    rating?: number;
    description?: string;
    genre?: string;
    tags?: string[];
    last_played?: string;
    generation_model?: string;
    version?: string;
    prompt?: string;
  }
): Promise<void> {
  return apiFetch(`/api/songs/${encodeURIComponent(musicId)}`, null, { method: 'PATCH', json: updates });
}

export function trashTrack(musicId: string): Promise<void> {
  return apiFetch(`/api/songs/${encodeURIComponent(musicId)}/trash`, null, { method: 'POST' });
}

export async function suggestTags(musicId: string): Promise<{ suggestions: string[]; source: string }> {
  try {
    return await apiFetch(`/api/songs/${encodeURIComponent(musicId)}/suggest-tags`, SuggestTagsSchema);
  } catch (error) {
    debug.error('SUGGEST_TAGS_FAILED', {
      message: error instanceof Error ? error.message : String(error),
      musicId
    });
    return { suggestions: [], source: 'error' };
  }
}

// =============================================================================
// MusicBrainz
// =============================================================================

export interface MusicBrainzMatch {
  title?: string | null;
  artist?: string | null;
  genre?: string | null;
  tags: string[];
  description?: string | null;
  year?: number | null;
}

/** `GET /api/musicbrainz/search` — returns null when MusicBrainz has no match. Throws on HTTP errors. */
export async function searchMusicBrainz(query: string, artist?: string): Promise<MusicBrainzMatch | null> {
  const params = new URLSearchParams({ query });
  if (artist) params.append('artist', artist);
  const body = await apiFetch(`/api/musicbrainz/search?${params}`, MusicBrainzSearchSchema);
  return body.found && body.data ? body.data : null;
}

// =============================================================================
// Sharing
// =============================================================================

export async function fetchSharedPlaylist(shareId: string, signal?: AbortSignal): Promise<{ title: string; tracks: PlaylistTrack[] }> {
  const data = await apiFetch(`/api/share/${encodeURIComponent(shareId)}`, SharedPlaylistSchema, { signal });
  return { title: data.title, tracks: data.tracks.map(toLibraryTrack) };
}

export function createShare(
  trackIds: string[],
  title: string = 'Shared Playlist',
  expiresInDays: number = 30
): Promise<ShareResponse> {
  if (!trackIds || trackIds.length === 0) {
    return Promise.reject(new Error('No tracks available to share'));
  }
  return apiFetch('/api/share', ShareResponseSchema, {
    method: 'POST',
    json: { track_ids: trackIds, title, expires_in_days: expiresInDays },
  });
}

// =============================================================================
// Cloud playlists (CRUD contract — see docs/API.md "Playlists")
//
// Optional: storage.noahcohn.com may not implement the write routes. Callers treat
// a failure (404/405/network) as "stay local-only"; nothing here is required for
// the local IndexedDB playlists to work.
// =============================================================================

export function getPlaylistApiUrl(): string {
  return PLAYLIST_API_URL;
}

export interface CloudPlaylistInput {
  title: string;
  description?: string;
  track_ids: string[];
}

/** Read-only `GET /api/playlists`; an unavailable host reads as no playlists. */
export async function fetchPlaylists(): Promise<CloudPlaylist[]> {
  try {
    return await apiFetch('/api/playlists', CloudPlaylistListSchema, { base: PLAYLIST_API_URL });
  } catch (error) {
    debug.error('FETCH_PLAYLISTS_FAILED', { message: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

export async function fetchPlaylistTracks(playlistId: string): Promise<string[]> {
  try {
    return await apiFetch(`/api/playlists/${encodeURIComponent(playlistId)}`, PlaylistTrackIdsSchema, { base: PLAYLIST_API_URL });
  } catch {
    return [];
  }
}

function sendPlaylist(method: 'POST' | 'PUT', path: string, input: CloudPlaylistInput): Promise<CloudPlaylist> {
  return apiFetch(path, CloudPlaylistSchema, { method, json: input, base: PLAYLIST_API_URL });
}

export function createCloudPlaylist(input: CloudPlaylistInput): Promise<CloudPlaylist> {
  return sendPlaylist('POST', '/api/playlists', input);
}

export function replaceCloudPlaylist(id: string, input: CloudPlaylistInput): Promise<CloudPlaylist> {
  return sendPlaylist('PUT', `/api/playlists/${encodeURIComponent(id)}`, input);
}

export function deleteCloudPlaylist(id: string): Promise<void> {
  return apiFetch(`/api/playlists/${encodeURIComponent(id)}`, null, { method: 'DELETE', base: PLAYLIST_API_URL });
}

/** True only when the host answers `GET /api/playlists/health` with `{ writable: true }`. */
export async function probePlaylistWriteSupport(signal?: AbortSignal): Promise<boolean> {
  try {
    const body = await apiFetch('/api/playlists/health', PlaylistHealthSchema, { base: PLAYLIST_API_URL, signal });
    return body.writable;
  } catch {
    return false;
  }
}

// =============================================================================
// Health Check
// =============================================================================

export async function healthCheck(): Promise<{
  isHealthy: boolean;
  apiBase: string;
  results: Record<string, { status?: number; ok?: boolean; error?: string; duration?: string }>;
}> {
  debug.log('HEALTH_CHECK_START', { apiBase: API_BASE_URL });

  type HealthCheckResult = {
    status?: number;
    ok?: boolean;
    error?: string;
    duration?: string;
    contentType?: string | null;
    corsOrigin?: string | null;
    errorBody?: string;
    type?: string;
  };
  const results: Record<string, HealthCheckResult> = {};
  const endpoints = [
    { name: 'songs', method: 'GET', path: '/api/songs' },
    { name: 'tags', method: 'GET', path: '/api/songs/tags' },
    { name: 'stats', method: 'GET', path: '/api/songs/stats' }
  ];

  for (const endpoint of endpoints) {
    try {
      const startTime = performance.now();

      const response = await apiRequest(endpoint.path, { method: endpoint.method });

      const endTime = performance.now();
      const duration = endTime - startTime;

      const entry: HealthCheckResult = {
        status: response.status,
        ok: response.ok,
        duration: `${duration.toFixed(2)}ms`,
        contentType: response.headers.get('content-type'),
        corsOrigin: response.headers.get('access-control-allow-origin')
      };
      results[endpoint.name] = entry;

      debug.log(`HEALTH_CHECK_${endpoint.name.toUpperCase()}`, entry);

      if (!response.ok) {
        const text = await response.text();
        entry.errorBody = text.substring(0, 200);
      }
    } catch (error) {
      results[endpoint.name] = {
        error: error instanceof Error ? error.message : String(error),
        type: error instanceof TypeError ? 'TypeError (network-level)' : 'Other'
      };
      debug.error(`HEALTH_CHECK_${endpoint.name.toUpperCase()}_ERROR`, results[endpoint.name]);
    }
  }

  const isHealthy = Object.values(results).every((result) => !result.error && result.ok === true);
  debug.log('HEALTH_CHECK_RESULT', { isHealthy, apiBase: API_BASE_URL });

  return {
    isHealthy,
    apiBase: API_BASE_URL,
    results
  };
}
