/**
 * HTTP Range fetch helpers for chunked audio streaming.
 * Reuses progress callback shape compatible with trackCache offline downloads.
 */

export interface RemoteAudioProbe {
  url: string;
  contentLength: number | null;
  acceptsRanges: boolean;
  contentType: string | null;
}

export interface RangeFetchProgress {
  loaded: number;
  total: number | null;
  /** 0–1 when total is known */
  percent: number | null;
}

export interface StreamRemoteAudioOptions {
  chunkSize?: number;
  signal?: AbortSignal;
  onProgress?: (progress: RangeFetchProgress) => void;
}

const DEFAULT_CHUNK_SIZE = 256 * 1024;

function parseContentLength(value: string | null): number | null {
  if (!value) return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function emitProgress(
  loaded: number,
  total: number | null,
  onProgress?: (progress: RangeFetchProgress) => void
): void {
  onProgress?.({
    loaded,
    total,
    percent: total !== null && total > 0 ? loaded / total : null,
  });
}

/** HEAD probe for Content-Length and Accept-Ranges support. */
export async function probeRemoteAudio(url: string, signal?: AbortSignal): Promise<RemoteAudioProbe> {
  const response = await fetch(url, {
    method: 'HEAD',
    mode: 'cors',
    credentials: 'omit',
    signal,
  });

  if (!response.ok) {
    throw new Error(`Probe failed: ${response.status} ${response.statusText}`);
  }

  const acceptRanges = (response.headers.get('accept-ranges') || '').toLowerCase() === 'bytes';
  return {
    url,
    contentLength: parseContentLength(response.headers.get('content-length')),
    acceptsRanges: acceptRanges,
    contentType: response.headers.get('content-type'),
  };
}

/** Fetch a single byte range [start, end] inclusive. */
export async function fetchByteRange(
  url: string,
  start: number,
  end: number,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  const response = await fetch(url, {
    method: 'GET',
    mode: 'cors',
    credentials: 'omit',
    headers: { Range: `bytes=${start}-${end}` },
    signal,
  });

  if (response.status !== 206 && response.status !== 200) {
    throw new Error(`Range fetch failed: ${response.status} ${response.statusText}`);
  }

  return response.arrayBuffer();
}

/**
 * Stream a remote audio URL in fixed-size chunks via HTTP Range requests.
 * Falls back to a single full GET when the server does not advertise ranges.
 */
export async function* streamRemoteAudio(
  url: string,
  options: StreamRemoteAudioOptions = {}
): AsyncGenerator<ArrayBuffer, void, undefined> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const signal = options.signal;

  const probe = await probeRemoteAudio(url, signal);
  const total = probe.contentLength;
  let loaded = 0;

  if (!probe.acceptsRanges || total === null) {
    const response = await fetch(url, { mode: 'cors', credentials: 'omit', signal });
    if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) {
      const buf = await response.arrayBuffer();
      emitProgress(buf.byteLength, buf.byteLength, options.onProgress);
      yield buf;
      return;
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const copy = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
      loaded += copy.byteLength;
      emitProgress(loaded, total, options.onProgress);
      yield copy;
    }
    return;
  }

  for (let start = 0; start < total; start += chunkSize) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const end = Math.min(start + chunkSize - 1, total - 1);
    const chunk = await fetchByteRange(url, start, end, signal);
    loaded += chunk.byteLength;
    emitProgress(loaded, total, options.onProgress);
    yield chunk;
  }
}

/**
 * Stream from an existing Response body (e.g. Cache API hit) without loading the full file at once.
 */
export async function* streamResponseBody(
  response: Response,
  options: StreamRemoteAudioOptions = {}
): AsyncGenerator<ArrayBuffer, void, undefined> {
  const total = parseContentLength(response.headers.get('content-length'));
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const reader = response.body?.getReader();

  if (!reader) {
    const buf = await response.arrayBuffer();
    emitProgress(buf.byteLength, total ?? buf.byteLength, options.onProgress);
    yield buf;
    return;
  }

  let loaded = 0;
  let pending = new Uint8Array(0);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.length === 0) continue;

    const merged = new Uint8Array(pending.length + value.length);
    merged.set(pending);
    merged.set(value, pending.length);
    pending = merged;

    while (pending.length >= chunkSize) {
      const slice = pending.slice(0, chunkSize);
      pending = pending.slice(chunkSize);
      loaded += slice.byteLength;
      emitProgress(loaded, total, options.onProgress);
      yield slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
    }
  }

  if (pending.length > 0) {
    loaded += pending.length;
    emitProgress(loaded, total, options.onProgress);
    yield pending.buffer.slice(pending.byteOffset, pending.byteOffset + pending.byteLength);
  }
}

/** Random-access reader (matches `ByteReader` in audio/flacSeek.ts). */
export interface RangeByteReader {
  readonly size: number | null;
  /** True when arbitrary offsets can be read (Range support or local Blob). */
  readonly seekable: boolean;
  read(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array>;
}

/**
 * Confirm Range support when HEAD did not advertise it (some servers/CDNs omit
 * Accept-Ranges on HEAD): a 1-byte Range GET answered with 206 + Content-Range.
 */
export async function confirmRangeSupport(probe: RemoteAudioProbe, signal?: AbortSignal): Promise<RemoteAudioProbe> {
  if (probe.acceptsRanges && probe.contentLength !== null) return probe;
  try {
    const response = await fetch(probe.url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      headers: { Range: 'bytes=0-0' },
      signal,
    });
    const match = /\/(\d+)\s*$/.exec(response.headers.get('content-range') || '');
    void response.body?.cancel();
    if (response.status === 206 && match) {
      return { ...probe, acceptsRanges: true, contentLength: parseInt(match[1], 10) };
    }
  } catch (err) {
    if (signal?.aborted) throw err;
  }
  return probe;
}

/** HTTP Range reader. `size` comes from the HEAD probe. */
export function createRangeReader(probe: RemoteAudioProbe): RangeByteReader {
  const size = probe.contentLength;
  return {
    size,
    seekable: probe.acceptsRanges && size !== null,
    async read(start, end, signal) {
      const last = (size !== null ? Math.min(end, size) : end) - 1;
      if (last < start) return new Uint8Array(0);
      return new Uint8Array(await fetchByteRange(probe.url, start, last, signal));
    },
  };
}

/** Reader over a Blob (e.g. a Cache API hit) — slices stay lazy. */
export function createBlobReader(blob: Blob): RangeByteReader {
  return {
    size: blob.size,
    seekable: true,
    async read(start, end) {
      return new Uint8Array(await blob.slice(start, Math.min(end, blob.size)).arrayBuffer());
    },
  };
}

/** Stream `reader` from `startByte` to EOF in `chunkSize` pieces. */
export async function* streamFromReader(
  reader: RangeByteReader,
  startByte: number,
  options: StreamRemoteAudioOptions = {}
): AsyncGenerator<ArrayBuffer, void, undefined> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const total = reader.size;
  if (total === null) throw new Error('streamFromReader requires a known size');
  let loaded = startByte;
  for (let start = startByte; start < total; start += chunkSize) {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const bytes = await reader.read(start, Math.min(start + chunkSize, total), options.signal);
    loaded += bytes.byteLength;
    emitProgress(loaded, total, options.onProgress);
    yield bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
}
