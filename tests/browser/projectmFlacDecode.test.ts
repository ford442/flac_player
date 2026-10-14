/**
 * Real-browser decode of the projectM FLACs (https://projectm.1ink.us/songs/).
 *
 * These files have frame headers that take sample rate / bit depth from
 * STREAMINFO. @wasm-audio-decoders/flac (0.2.10, 0.2.11) feeds libFLAC frames
 * without the metadata and fails with LOST_SYNC / BAD_HEADER, returning
 * {channels: 0, sampleRate: 0, duration: NaN} or a truncated result.
 * decodeAudio() must detect that and fall back to decodeAudioData.
 *
 * Needs network access; each test skips itself when the host is unreachable.
 */
import { describe, it, expect } from 'vitest';
import { decodeAudio, isUsableFlacDecode } from '../../src/audio/audioDecoder';
import { FlacDecoder } from '../../src/audio/flacDecoder';
import { openHifiTrack, runHifiStreamPipeline } from '../../src/audio/hifiStreamPipeline';

const SONGS_BASE = 'https://projectm.1ink.us/songs/';

const SONGS = [
  'Claws of the Angel.flac', // ~80MB, 44.1kHz/24-bit, 5:32 — from the bug report
  'A Chuva.flac',
];

/** STREAMINFO max block size, sample rate and total samples (36 bits). */
function readStreamInfo(buf: ArrayBuffer) {
  const b = new Uint8Array(buf, 0, 26);
  const maxBlockSize = (b[10]! << 8) | b[11]!;
  const sampleRate = (b[18]! << 12) | (b[19]! << 4) | (b[20]! >> 4);
  const totalSamples = (b[21]! & 0x0f) * 2 ** 32
    + ((b[22]! << 24) >>> 0) + (b[23]! << 16) + (b[24]! << 8) + b[25]!;
  return { maxBlockSize, sampleRate, totalSamples };
}

async function fetchSong(name: string): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(SONGS_BASE + encodeURIComponent(name));
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

describe('projectM FLAC decode', () => {
  for (const name of SONGS) {
    it(`decodes ${name} to full-length PCM (no AudioContext → OfflineAudioContext)`, async (ctx) => {
      const buf = await fetchSong(name);
      if (!buf) ctx.skip();
      const info = readStreamInfo(buf!);

      const result = await decodeAudio(buf!, undefined, name);

      expect(result.channels).toBe(2);
      expect(result.sampleRate).toBe(info.sampleRate);
      expect(Number.isFinite(result.duration)).toBe(true);
      // Some of these files carry up to one block more audio than STREAMINFO's
      // total (ffmpeg decodes the same count), so allow one block of overshoot.
      const frames = result.interleavedBuffer.length / result.channels;
      expect(frames).toBeGreaterThanOrEqual(info.totalSamples);
      expect(frames - info.totalSamples).toBeLessThanOrEqual(info.maxBlockSize);
      expect(result.duration).toBeCloseTo(frames / result.sampleRate, 6);
    }, 300_000);
  }

  it('WASM-only decode of Claws of the Angel is flagged unusable (upstream bug guard)', async (ctx) => {
    const buf = await fetchSong(SONGS[0]!);
    if (!buf) ctx.skip();

    const decoder = new FlacDecoder();
    await decoder.init();
    const wasmResult = await decoder.decode(buf!).finally(() => decoder.destroy());

    // If this starts failing, @wasm-audio-decoders/flac was fixed and the
    // fallback in audioDecoder.ts may no longer be needed for these files.
    expect(isUsableFlacDecode(wasmResult)).toBe(false);
  }, 300_000);

  describe('hi-fi streaming pipeline', () => {
    const url = SONGS_BASE + encodeURIComponent(SONGS[0]!);

    async function stream(opened: Awaited<ReturnType<typeof openHifiTrack>>, startSeconds: number) {
      let frames = 0;
      let channels = 0;
      let sampleRate = 0;
      let ended = false;
      let error: Error | null = null;
      await runHifiStreamPipeline({
        url,
        opened,
        startSeconds,
        onMetadata: (m) => { channels = m.channels; sampleRate = m.sampleRate; },
        onPcmChunk: (pcm) => { frames += pcm.length / channels; },
        onEnded: () => { ended = true; },
        onError: (e) => { error = e; },
      });
      return { frames, channels, sampleRate, ended, error };
    }

    it('streams Claws of the Angel to the end via the decodeAudioData fallback, then seeks', async (ctx) => {
      // This host does not expose Content-Range / Accept-Ranges to CORS, so
      // `opened.reader` is null (non-seekable path); read STREAMINFO directly.
      let opened;
      let info;
      try {
        opened = await openHifiTrack({ url });
        const prefix = await fetch(url, { headers: { Range: 'bytes=0-63' } });
        info = readStreamInfo(await prefix.arrayBuffer());
      } catch {
        ctx.skip();
      }

      const full = await stream(opened!, 0);
      expect(full.error).toBeNull();
      expect(full.ended).toBe(true);
      expect(full.channels).toBe(2);
      expect(full.sampleRate).toBe(info!.sampleRate);
      expect(full.frames).toBeGreaterThanOrEqual(info!.totalSamples);
      expect(full.frames - info!.totalSamples).toBeLessThanOrEqual(info!.maxBlockSize);
      expect(opened!.wasmUnusable).toBe(true);

      // Seek reuses the cached native decode and starts at the exact sample.
      const t0 = performance.now();
      const seeked = await stream(opened!, 100);
      expect(seeked.ended).toBe(true);
      expect(seeked.frames).toBe(full.frames - 100 * info!.sampleRate);
      expect(performance.now() - t0).toBeLessThan(5_000);
    }, 300_000);
  });
});
