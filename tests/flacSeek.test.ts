// Node env (vitest.decoder.config.ts): real WASM FLAC decode of frames located by flacSeek.ts.
import { FLACDecoder } from '@wasm-audio-decoders/flac';
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import {
  findFrame,
  locateFrame,
  readFlacHeader,
  syntheticFlacPrefix,
  type ByteReader,
  type FlacStreamHeader,
} from '../src/audio/flacSeek';
import { sampleIndexAt } from './helpers/indexCodedPcm';

const RATE = 44100;
const fixture = fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/seek-index-40s.flac'));

function memoryReader(bytes: Uint8Array): ByteReader & { bytesRead: number } {
  return {
    size: bytes.length,
    bytesRead: 0,
    async read(start, end) {
      const out = bytes.subarray(start, Math.min(end, bytes.length));
      this.bytesRead += out.length;
      return out;
    },
  };
}

/** Decode from `offset` (behind the synthetic prefix) and return the first frame's index. */
async function firstIndexFrom(bytes: Uint8Array, header: FlacStreamHeader, offset: number, skip: number): Promise<number> {
  const decoder = new FLACDecoder();
  await decoder.ready;
  try {
    const prefix = new Uint8Array(syntheticFlacPrefix(header));
    const body = bytes.subarray(offset, Math.min(bytes.length, offset + 512 * 1024));
    const input = new Uint8Array(prefix.length + body.length);
    input.set(prefix);
    input.set(body, prefix.length);
    const { channelData, samplesDecoded } = await decoder.decodeFile(input);
    expect(samplesDecoded).toBeGreaterThan(skip);
    return sampleIndexAt(channelData[0][skip], channelData[1][skip]);
  } finally {
    decoder.free();
  }
}

/** Copy of `bytes` with a SEEKTABLE (one point per ~`every` samples) after STREAMINFO. */
async function withSeekTable(bytes: Uint8Array, every: number): Promise<Uint8Array> {
  const header = await readFlacHeader(memoryReader(bytes));
  const points: Array<{ sample: number; offset: number }> = [];
  let at = header.audioStart;
  while (at < bytes.length) {
    const f = findFrame(bytes.subarray(at, at + 64 * 1024), at, header.streamInfo);
    if (!f) break;
    if (points.length === 0 || f.sample - points[points.length - 1].sample >= every) {
      points.push({ sample: f.sample, offset: f.offset - header.audioStart });
    }
    at = f.offset + 2;
  }
  const table = new Uint8Array(4 + points.length * 18);
  const v = new DataView(table.buffer);
  table[0] = 3; // SEEKTABLE, not last
  const len = points.length * 18;
  table[1] = (len >> 16) & 0xff; table[2] = (len >> 8) & 0xff; table[3] = len & 0xff;
  points.forEach((p, i) => {
    v.setUint32(4 + i * 18, 0); v.setUint32(8 + i * 18, p.sample);
    v.setUint32(12 + i * 18, 0); v.setUint32(16 + i * 18, p.offset);
    v.setUint16(20 + i * 18, 4608);
  });
  const split = 4 + 4 + 34; // fLaC + STREAMINFO (fixture has no ID3)
  const out = new Uint8Array(bytes.length + table.length);
  out.set(bytes.subarray(0, split));
  out[4] &= 0x7f; // STREAMINFO is no longer necessarily last (it was not anyway)
  out.set(table, split);
  out.set(bytes.subarray(split), split + table.length);
  return out;
}

describe('flacSeek', () => {
  it('reads STREAMINFO and the first-frame offset', async () => {
    const header = await readFlacHeader(memoryReader(fixture));
    expect(header.streamInfo).toMatchObject({ sampleRate: RATE, channels: 2, bitsPerSample: 16, totalSamples: 40 * RATE });
    expect(header.seekPoints).toHaveLength(0);
    expect(findFrame(fixture.subarray(header.audioStart, header.audioStart + 32), header.audioStart, header.streamInfo))
      .toEqual({ offset: header.audioStart, sample: 0 });
  });

  it('rejects bytes that only look like a sync code', async () => {
    const header = await readFlacHeader(memoryReader(fixture));
    const junk = new Uint8Array([0xff, 0xf8, 0x69, 0x08, 0x00, 0x00, 0x00]); // bad CRC-8
    expect(findFrame(junk, 0, header.streamInfo)).toBeNull();
  });

  const targets = [1, 4608, 10 * RATE + 7, 30 * RATE, 30 * RATE + 12345, 40 * RATE - 100, 40 * RATE - 1];

  it.each(targets)('estimate path lands sample-accurately on %i', async (target) => {
    const reader = memoryReader(fixture);
    const header = await readFlacHeader(reader);
    const pos = await locateFrame(reader, header, target);
    expect(pos).not.toBeNull();
    expect(pos!.sample).toBeLessThanOrEqual(target);
    expect(target - pos!.sample).toBeLessThan(RATE * 5); // bounded skip-decode
    expect(await firstIndexFrom(fixture, header, pos!.offset, target - pos!.sample)).toBe(target);
    expect(reader.bytesRead).toBeLessThan(fixture.length / 2); // no full download
  });

  it.each([30 * RATE + 99, 40 * RATE - 1])('SEEKTABLE path lands on the exact seek point for %i', async (target) => {
    const bytes = await withSeekTable(fixture, RATE);
    const reader = memoryReader(bytes);
    const header = await readFlacHeader(reader);
    expect(header.seekPoints.length).toBeGreaterThan(30);
    const pos = await locateFrame(reader, header, target);
    const point = [...header.seekPoints].reverse().find((p) => p.sample <= target)!;
    expect(pos).toEqual({ offset: header.audioStart + point.offset, sample: point.sample });
    expect(await firstIndexFrom(bytes, header, pos!.offset, target - pos!.sample)).toBe(target);
  });
});
