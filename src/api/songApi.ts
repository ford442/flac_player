// API client for song/library management endpoints

import { PlaylistTrack, LibraryStats, TagInfo, ShareResponse, SortBy } from '../audioLoader';

// API Configuration
const API_BASE_URL = process.env.REACT_APP_API_URL || (typeof window !== 'undefined' ? window.location.origin : 'https://storage.noahcohn.com');

// Debug mode
const DEBUG_MODE = true;

const debug = {
  log: (label: string, data: any) => {
    if (DEBUG_MODE) console.log(`[FLAC:${label}]`, data);
  },
  error: (label: string, data: any) => {
    if (DEBUG_MODE) console.error(`[FLAC:${label}]`, data);
  },
  warn: (label: string, data: any) => {
    if (DEBUG_MODE) console.warn(`[FLAC:${label}]`, data);
  }
};

const SYNC_MUSIC_ENDPOINTS = [
  {
    url: `${API_BASE_URL}/api/admin/sync-music?type=music`,
    init: { method: 'POST' as const }
  },
  {
    url: `${API_BASE_URL}/api/admin/sync-music`,
    init: {
      method: 'POST' as const,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'music' })
    }
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

// =============================================================================
// Songs / Library
// =============================================================================

export async function fetchSongs(
  options: {
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
  } = {}
): Promise<{ tracks: PlaylistTrack[]; total: number }> {
  try {
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

    const url = `${API_BASE_URL}/api/songs?${params}`;
    debug.log('FETCH_LIBRARY_REQUEST', { url, apiBase: API_BASE_URL, params: Object.fromEntries(params) });

    const startTime = performance.now();
    const response = await fetch(url, {
      mode: 'cors',
      credentials: 'omit'
    });
    const endTime = performance.now();

    debug.log('FETCH_LIBRARY_RESPONSE', {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      contentType: response.headers.get('content-type'),
      corsOrigin: response.headers.get('access-control-allow-origin'),
      responseUrl: response.url,
      duration: `${(endTime - startTime).toFixed(2)}ms`
    });

    if (!response.ok) {
      const text = await response.text();
      debug.error('FETCH_LIBRARY_ERROR_BODY', { text, status: response.status });
      throw new Error(`Failed to fetch library: ${response.status} ${response.statusText}`);
    }

    const tracks = await response.json();
    debug.log('FETCH_LIBRARY_PARSED', { trackCount: tracks.length });

    const tracksWithUrls = tracks.map((item: any) => ({
      ...item,
      url: item.url ? (item.url.startsWith('http') ? item.url : `${API_BASE_URL}${item.url}`) : `${API_BASE_URL}/api/music/${item.id}`
    }));

    return { tracks: tracksWithUrls, total: tracks.length };
  } catch (error) {
    debug.error('FETCH_LIBRARY_FAILED', {
      message: error instanceof Error ? error.message : String(error),
      type: error instanceof TypeError ? 'TypeError (network-level)' : error instanceof Error ? error.constructor.name : 'unknown',
      apiBase: API_BASE_URL,
      stack: error instanceof Error ? error.stack?.split('\n').slice(0, 3) : undefined
    });
    throw error;
  }
}

export async function fetchTags(): Promise<TagInfo[]> {
  try {
    const url = `${API_BASE_URL}/api/songs/tags`;
    debug.log('FETCH_TAGS_REQUEST', { url, apiBase: API_BASE_URL });

    const startTime = performance.now();
    const response = await fetch(url, {
      mode: 'cors',
      credentials: 'omit'
    });
    const endTime = performance.now();

    debug.log('FETCH_TAGS_RESPONSE', {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      contentType: response.headers.get('content-type'),
      corsOrigin: response.headers.get('access-control-allow-origin'),
      corsAllowMethods: response.headers.get('access-control-allow-methods'),
      responseUrl: response.url,
      duration: `${(endTime - startTime).toFixed(2)}ms`
    });

    if (!response.ok) {
      const text = await response.text();
      debug.error('FETCH_TAGS_ERROR_BODY', { text, status: response.status, statusText: response.statusText });
      throw new Error(`Failed to fetch tags: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    debug.log('FETCH_TAGS_PARSED', { tagCount: data.tags?.length || 0 });
    return data.tags || [];
  } catch (error) {
    debug.error('FETCH_TAGS_FAILED', {
      message: error instanceof Error ? error.message : String(error),
      type: error instanceof TypeError ? 'TypeError (network-level)' : error instanceof Error ? error.constructor.name : 'unknown',
      apiBase: API_BASE_URL,
      url: `${API_BASE_URL}/api/songs/tags`,
      stack: error instanceof Error ? error.stack?.split('\n').slice(0, 3) : undefined
    });
    return [];
  }
}

export async function fetchStats(): Promise<LibraryStats> {
  try {
    const url = `${API_BASE_URL}/api/songs/stats`;
    debug.log('FETCH_STATS_REQUEST', { url, apiBase: API_BASE_URL });

    const startTime = performance.now();
    const response = await fetch(url, {
      mode: 'cors',
      credentials: 'omit'
    });
    const endTime = performance.now();

    debug.log('FETCH_STATS_RESPONSE', {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      contentType: response.headers.get('content-type'),
      corsOrigin: response.headers.get('access-control-allow-origin'),
      responseUrl: response.url,
      duration: `${(endTime - startTime).toFixed(2)}ms`
    });

    if (!response.ok) {
      const text = await response.text();
      debug.error('FETCH_STATS_ERROR_BODY', { text, status: response.status });
      throw new Error(`Failed to fetch stats: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    debug.log('FETCH_STATS_PARSED', { totalTracks: data.total_tracks });
    return data;
  } catch (error) {
    debug.error('FETCH_STATS_FAILED', {
      message: error instanceof Error ? error.message : String(error),
      type: error instanceof TypeError ? 'TypeError (network-level)' : error instanceof Error ? error.constructor.name : 'unknown',
      apiBase: API_BASE_URL
    });
    return {
      total_tracks: 0,
      rated_4plus: 0,
      total_duration_hours: 0,
      total_play_count: 0,
      untagged_count: 0,
      trash_count: 0,
      unique_tags: 0,
      top_tags: []
    };
  }
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
        debug.log('SYNC_MUSIC_REQUEST', { endpoint: endpoint.url, attempt, attempts });

        const response = await fetch(endpoint.url, {
          mode: 'cors',
          credentials: 'omit',
          signal: controller.signal,
          ...endpoint.init
        });

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
          debug.log('SYNC_MUSIC_SUCCESS', { endpoint: endpoint.url, status: response.status });
          return {
            endpoint: endpoint.url,
            status: response.status,
            statusText: response.statusText,
            payload,
            isAcceptedOrRunning
          };
        }

        // Retry transient server failures and rate limits, but do not retry 4xx request errors.
        const shouldRetrySameEndpoint = response.status >= 500 || response.status === 429;
        debug.warn('SYNC_MUSIC_FAILED_RESPONSE', {
          endpoint: endpoint.url,
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
          endpoint: endpoint.url,
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

export async function recordPlay(musicId: string): Promise<void> {
  try {
    const url = `${API_BASE_URL}/api/songs/${musicId}/play`;
    debug.log('RECORD_PLAY_REQUEST', { url, musicId });

    const response = await fetch(url, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit'
    });

    debug.log('RECORD_PLAY_RESPONSE', { status: response.status, ok: response.ok });

    if (!response.ok) {
      debug.warn('RECORD_PLAY_ERROR', { status: response.status, musicId });
    }
  } catch (error) {
    debug.warn('RECORD_PLAY_FAILED', {
      message: error instanceof Error ? error.message : String(error),
      musicId
    });
  }
}

export async function updateSampleMetadata(
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
  try {
    const url = `${API_BASE_URL}/api/songs/${musicId}`;
    debug.log('UPDATE_METADATA_REQUEST', { url, musicId, updatesKeys: Object.keys(updates) });

    const response = await fetch(url, {
      method: 'PATCH',
      mode: 'cors',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });

    debug.log('UPDATE_METADATA_RESPONSE', { status: response.status, ok: response.ok, musicId });

    if (!response.ok) {
      const text = await response.text();
      debug.error('UPDATE_METADATA_ERROR_BODY', { text, status: response.status });
      throw new Error(`Failed to update metadata: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    debug.error('UPDATE_METADATA_FAILED', {
      message: error instanceof Error ? error.message : String(error),
      musicId
    });
    throw error;
  }
}

export async function trashTrack(musicId: string): Promise<void> {
  try {
    const url = `${API_BASE_URL}/api/songs/${musicId}/trash`;
    debug.log('TRASH_TRACK_REQUEST', { url, musicId });

    const response = await fetch(url, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit'
    });

    debug.log('TRASH_TRACK_RESPONSE', { status: response.status, ok: response.ok, musicId });

    if (!response.ok) {
      throw new Error(`Failed to trash track: ${response.status}`);
    }
  } catch (error) {
    debug.error('TRASH_TRACK_FAILED', {
      message: error instanceof Error ? error.message : String(error),
      musicId
    });
    throw error;
  }
}

export async function suggestTags(musicId: string): Promise<{ suggestions: string[]; source: string }> {
  try {
    const url = `${API_BASE_URL}/api/songs/${musicId}/suggest-tags`;
    debug.log('SUGGEST_TAGS_REQUEST', { url, musicId });

    const response = await fetch(url, {
      mode: 'cors',
      credentials: 'omit'
    });

    debug.log('SUGGEST_TAGS_RESPONSE', { status: response.status, ok: response.ok, musicId });

    if (!response.ok) {
      throw new Error(`Failed to get suggestions: ${response.status}`);
    }
    const data = await response.json();
    debug.log('SUGGEST_TAGS_PARSED', { suggestionCount: data.suggestions?.length });
    return data;
  } catch (error) {
    debug.error('SUGGEST_TAGS_FAILED', {
      message: error instanceof Error ? error.message : String(error),
      musicId
    });
    return { suggestions: [], source: 'error' };
  }
}

// =============================================================================
// Sharing
// =============================================================================

export async function fetchSharedPlaylist(shareId: string): Promise<{ title: string; tracks: PlaylistTrack[] }> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/share/${shareId}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch shared playlist: ${response.status}`);
    }

    const data = await response.json() as { title: string; tracks: PlaylistTrack[] };

    const tracksWithUrls = data.tracks.map((item) => ({
      ...item,
      url: item.url || `${API_BASE_URL}/api/music/${item.id}`
    }));

    return { title: data.title, tracks: tracksWithUrls };
  } catch (error) {
    console.error('Error fetching shared playlist:', error);
    throw error;
  }
}

export async function createShare(
  trackIds: string[],
  title: string = 'Shared Playlist',
  expiresInDays: number = 30
): Promise<ShareResponse> {
  if (!trackIds || trackIds.length === 0) {
    throw new Error('No tracks available to share');
  }

  const payload = {
    track_ids: trackIds,
    title,
    expires_in_days: expiresInDays,
  };

  const url = `${API_BASE_URL}/api/share`;
  debug.log('CREATE_SHARE_REQUEST', { url, payload });

  const response = await fetch(url, {
    method: 'POST',
    mode: 'cors',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    debug.error('CREATE_SHARE_ERROR_BODY', { text, status: response.status });
    throw new Error(`Failed to create share: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  debug.log('CREATE_SHARE_RESPONSE', data);
  return data as ShareResponse;
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

  const results: Record<string, any> = {};
  const endpoints = [
    { name: 'songs', method: 'GET', path: '/api/songs' },
    { name: 'tags', method: 'GET', path: '/api/songs/tags' },
    { name: 'stats', method: 'GET', path: '/api/songs/stats' }
  ];

  for (const endpoint of endpoints) {
    try {
      const url = `${API_BASE_URL}${endpoint.path}`;
      const startTime = performance.now();

      const response = await fetch(url, {
        method: endpoint.method,
        mode: 'cors',
        credentials: 'omit'
      });

      const endTime = performance.now();
      const duration = endTime - startTime;

      results[endpoint.name] = {
        status: response.status,
        ok: response.ok,
        duration: `${duration.toFixed(2)}ms`,
        contentType: response.headers.get('content-type'),
        corsOrigin: response.headers.get('access-control-allow-origin')
      };

      debug.log(`HEALTH_CHECK_${endpoint.name.toUpperCase()}`, results[endpoint.name]);

      if (!response.ok) {
        const text = await response.text();
        results[endpoint.name].errorBody = text.substring(0, 200);
      }
    } catch (error) {
      results[endpoint.name] = {
        error: error instanceof Error ? error.message : String(error),
        type: error instanceof TypeError ? 'TypeError (network-level)' : 'Other'
      };
      debug.error(`HEALTH_CHECK_${endpoint.name.toUpperCase()}_ERROR`, results[endpoint.name]);
    }
  }

  const isHealthy = Object.values(results).every((r: any) => !r.error && r.ok);
  debug.log('HEALTH_CHECK_RESULT', { isHealthy, apiBase: API_BASE_URL });

  return {
    isHealthy,
    apiBase: API_BASE_URL,
    results
  };
}
