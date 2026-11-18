// A local file enters the hi-fi pipeline as a Blob (#284): the same range reader as HTTP,
// so opening + seeking reads the header and a window, never the whole file.
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { isFlacBlob, openHifiTrack } from '../src/audio/hifiStreamPipeline';
import { locateFrame } from '../src/audio/flacSeek';

const bytes = fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/seek-index-40s.flac'));

/** A Blob that counts the bytes sliced out of it. */
function countingBlob(data: Uint8Array) {
  const blob = new Blob([data]);
  const counter = { read: 0 };
  const proxy = {
    size: blob.size,
    type: '',
    slice(start = 0, end = blob.size) {
      counter.read += Math.max(0, Math.min(end, blob.size) - start);
      return blob.slice(start, end);
    },
  } as unknown as Blob;
  return { blob: proxy, counter };
}

describe('Blob sources on the hi-fi session', () => {
  it('opens from the Blob without fetching, and a 30 s seek reads a small window', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { blob, counter } = countingBlob(bytes);
    const opened = await openHifiTrack({ url: 'local:fab12/seek.flac', blob });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(opened.reader?.seekable).toBe(true);
    expect(opened.duration).toBeCloseTo(40, 0);
    const info = opened.header!.streamInfo;

    const pos = await locateFrame(opened.reader!, opened.header!, Math.round(30 * info.sampleRate));
    expect(pos).not.toBeNull();
    expect(pos!.offset).toBeGreaterThan(bytes.length / 2);
    // Header + a few 64 KiB probe windows (5 here), whatever the file size.
    expect(counter.read).toBeLessThanOrEqual(6 * 64 * 1024);
    expect(counter.read).toBeLessThan(bytes.length / 2);
    fetchSpy.mockRestore();
  });

  it('detects FLAC by magic bytes, else by name', async () => {
    expect(await isFlacBlob(new Blob([bytes.subarray(0, 16)]), 'whatever.bin')).toBe(true);
    expect(await isFlacBlob(new Blob([new TextEncoder().encode('RIFF....WAVE')]), 'a.wav')).toBe(false);
    expect(await isFlacBlob(new Blob([new TextEncoder().encode('ID3\u0004')]), 'tagged.FLAC')).toBe(true);
  });
});
