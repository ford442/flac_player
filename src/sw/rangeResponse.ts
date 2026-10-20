// Range-aware responses for cached audio served by the service worker.
// <audio> issues `Range: bytes=N-` requests; a cached full-body Response must be
// sliced into a 206 or the element refuses to seek (or play at all in Safari).

/** Audio file extensions the native <audio> path may request. */
export const CACHED_AUDIO_RE = /\.(flac|mp3|wav|ogg|oga|opus|m4a|aac)$/i;

export interface ByteRange {
  start: number;
  end: number; // inclusive
}

/** Parse a single `bytes=` range. Returns null if absent/unsupported, 'invalid' if unsatisfiable. */
export function parseRange(header: string | null, size: number): ByteRange | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, from = '', to = ''] = m;
  if (from === '' && to === '') return null;
  let start: number;
  let end: number;
  if (from === '') {
    // Suffix range: last N bytes
    const n = parseInt(to, 10);
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(from, 10);
    end = to === '' ? size - 1 : Math.min(parseInt(to, 10), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

/** Build a 200/206/416 response from a cached full-body response. */
export async function createRangedResponse(cached: Response, rangeHeader: string | null): Promise<Response> {
  const buf = await cached.arrayBuffer();
  const size = buf.byteLength;
  const headers = new Headers(cached.headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');

  const range = parseRange(rangeHeader, size);
  if (range === 'invalid') {
    headers.set('Content-Range', `bytes */${size}`);
    headers.delete('Content-Length');
    return new Response(null, { status: 416, statusText: 'Range Not Satisfiable', headers });
  }
  if (range === null) {
    headers.set('Content-Length', String(size));
    return new Response(buf, { status: 200, statusText: 'OK', headers });
  }

  const slice = buf.slice(range.start, range.end + 1);
  headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
  headers.set('Content-Length', String(slice.byteLength));
  return new Response(slice, { status: 206, statusText: 'Partial Content', headers });
}
