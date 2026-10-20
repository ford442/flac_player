import { describe, it, expect } from 'vitest';
import { CACHED_AUDIO_RE, createRangedResponse, parseRange } from '../src/sw/rangeResponse';

const body = new Uint8Array(Array.from({ length: 100 }, (_, i) => i));
const cached = () => new Response(body, { headers: { 'Content-Type': 'audio/mpeg' } });

describe('parseRange', () => {
  it('handles open, closed, suffix and invalid ranges', () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('invalid');
    expect(parseRange('items=0-1', 100)).toBeNull();
  });
});

describe('createRangedResponse', () => {
  it('returns 200 with full body when no Range', async () => {
    const res = await createRangedResponse(cached(), null);
    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect((await res.arrayBuffer()).byteLength).toBe(100);
  });

  it('returns 206 slice for a Range request', async () => {
    const res = await createRangedResponse(cached(), 'bytes=10-19');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 10-19/100');
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(
      Array.from({ length: 10 }, (_, i) => i + 10),
    );
  });

  it('returns 416 for unsatisfiable ranges', async () => {
    const res = await createRangedResponse(cached(), 'bytes=200-');
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */100');
  });
});

describe('CACHED_AUDIO_RE', () => {
  it('matches audio paths only', () => {
    expect(CACHED_AUDIO_RE.test('/files/audio/music/a.MP3')).toBe(true);
    expect(CACHED_AUDIO_RE.test('/files/audio/music/a.ogg')).toBe(true);
    expect(CACHED_AUDIO_RE.test('/api/songs')).toBe(false);
  });
});
