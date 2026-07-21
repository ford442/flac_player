import { FLACDecoder } from '@wasm-audio-decoders/flac';
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

/**
 * Chunk-boundary coverage for the decode step that StreamingDecoder wraps.
 *
 * StreamingDecoder itself runs in a Web Worker, so it cannot be constructed in
 * a Node test environment — the browser integration spec exercises that layer.
 * What is portable, and what actually matters here, is that FLAC decoding is
 * insensitive to where the byte boundaries fall: frames straddle them, so a
 * decoder that mishandles partial frames produces wrong or missing samples.
 */
const FIXTURE = path.join(process.cwd(), 'tests/fixtures/test.flac');
const readFixture = () => fs.readFileSync(FIXTURE);

function chunkify(data: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < data.length; offset += size) {
    out.push(data.subarray(offset, Math.min(offset + size, data.length)));
  }
  return out;
}

async function decodeInChunks(size: number) {
  const decoder = new FLACDecoder();
  await decoder.ready;

  let samplesDecoded = 0;
  let sampleRate = 0;
  let channels = 0;
  let peak = 0;

  for (const chunk of chunkify(readFixture(), size)) {
    const result = await decoder.decode(chunk);
    samplesDecoded += result.samplesDecoded;
    sampleRate = result.sampleRate || sampleRate;
    channels = Math.max(channels, result.channelData.length);
    for (const channel of result.channelData) {
      for (const sample of channel) {
        const magnitude = Math.abs(sample);
        if (magnitude > peak) peak = magnitude;
      }
    }
  }

  const tail = await decoder.flush();
  samplesDecoded += tail.samplesDecoded;
  sampleRate = sampleRate || tail.sampleRate;
  decoder.free();

  return { samplesDecoded, sampleRate, channels, peak };
}

describe('FLAC chunked decode', () => {
  // Sizes chosen to misalign with FLAC frame boundaries.
  const chunkSizes = [512, 1024, 4096, 8192, 16384];

  it.each(chunkSizes)('decodes the full fixture in %i-byte chunks', async (size) => {
    const { samplesDecoded, sampleRate, channels } = await decodeInChunks(size);

    expect(sampleRate).toBe(44100);
    expect(channels).toBe(2);
    // The fixture is exactly 1 s; decodeFile yields 44100 frames.
    expect(samplesDecoded).toBe(44100);
  }, 30000);

  it('yields an identical sample count at every chunk size', async () => {
    const results = await Promise.all([256, 3000, 20000].map(decodeInChunks));
    const counts = results.map(r => r.samplesDecoded);
    expect(new Set(counts).size).toBe(1);
    expect(counts[0]).toBe(44100);
  }, 30000);

  it('matches whole-file decode', async () => {
    const decoder = new FLACDecoder();
    await decoder.ready;
    const whole = await decoder.decodeFile(readFixture());
    decoder.free();

    const chunked = await decodeInChunks(4096);
    expect(chunked.samplesDecoded).toBe(whole.samplesDecoded);
    expect(chunked.sampleRate).toBe(whole.sampleRate);
  }, 30000);

  it('decodes real audio, not silence', async () => {
    const { peak } = await decodeInChunks(8192);
    expect(peak).toBeGreaterThan(0.01);
    expect(peak).toBeLessThanOrEqual(1.0001);
  }, 30000);
});
