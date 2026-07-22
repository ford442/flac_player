/**
 * Lightweight FLAC/WAV header parsing for sample-accurate duration.
 * Fetches only the first bytes of a remote file via HTTP Range when possible.
 */

import { fetchByteRange } from './rangeFetch';

export interface ParsedAudioHeader {
  sampleRate: number;
  channels: number;
  totalSamples: number;
  durationSeconds: number;
  format: 'flac' | 'wav';
}

const HEADER_PROBE_BYTES = 64 * 1024;

function readAscii(view: DataView, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += String.fromCharCode(view.getUint8(offset + i));
  }
  return out;
}

/** Parse FLAC STREAMINFO from the start of a FLAC file. */
export function parseFlacHeader(buffer: ArrayBuffer): ParsedAudioHeader | null {
  if (buffer.byteLength < 42) return null;
  const view = new DataView(buffer);
  if (readAscii(view, 0, 4) !== 'fLaC') return null;

  let offset = 4;
  while (offset + 4 <= buffer.byteLength) {
    const header = view.getUint8(offset);
    const isLast = (header & 0x80) !== 0;
    const blockType = header & 0x7f;
    const blockSize =
      (view.getUint8(offset + 1) << 16) |
      (view.getUint8(offset + 2) << 8) |
      view.getUint8(offset + 3);
    offset += 4;
    if (offset + blockSize > buffer.byteLength) break;

    if (blockType === 0 && blockSize >= 18) {
      const base = offset + 10;
      const b10 = view.getUint8(base);
      const b11 = view.getUint8(base + 1);
      const b12 = view.getUint8(base + 2);
      const b13 = view.getUint8(base + 3);
      const b14 = view.getUint8(base + 4);
      const b15 = view.getUint8(base + 5);
      const b16 = view.getUint8(base + 6);
      const b17 = view.getUint8(base + 7);

      const sampleRate = ((b10 << 12) | (b11 << 4) | (b12 >> 4)) >>> 0;
      const channels = ((b12 & 0x0e) >> 1) + 1;
      const totalSamples =
        ((b13 & 0x0f) * 0x100000000) +
        (b14 * 0x1000000) +
        (b15 * 0x10000) +
        (b16 * 0x100) +
        b17;

      if (sampleRate <= 0) return null;
      const durationSeconds = totalSamples / sampleRate;
      return {
        sampleRate,
        channels,
        totalSamples,
        durationSeconds,
        format: 'flac',
      };
    }

    offset += blockSize;
    if (isLast) break;
  }

  return null;
}

/** Parse a canonical PCM WAV header (RIFF/WAVE). */
export function parseWavHeader(buffer: ArrayBuffer): ParsedAudioHeader | null {
  if (buffer.byteLength < 44) return null;
  const view = new DataView(buffer);
  if (readAscii(view, 0, 4) !== 'RIFF') return null;
  if (readAscii(view, 8, 4) !== 'WAVE') return null;

  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataSize = 0;

  while (offset + 8 <= buffer.byteLength) {
    const chunkId = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    offset += 8;

    if (chunkId === 'fmt ') {
      if (offset + 16 > buffer.byteLength) break;
      channels = view.getUint16(offset + 2, true);
      sampleRate = view.getUint32(offset + 4, true);
      bitsPerSample = view.getUint16(offset + 14, true);
    } else if (chunkId === 'data') {
      dataSize = chunkSize;
    }

    offset += chunkSize + (chunkSize % 2);
  }

  if (!sampleRate || !channels || !bitsPerSample || !dataSize) return null;
  const bytesPerFrame = channels * (bitsPerSample / 8);
  const totalSamples = dataSize / bytesPerFrame;
  return {
    sampleRate,
    channels,
    totalSamples,
    durationSeconds: totalSamples / sampleRate,
    format: 'wav',
  };
}

export function parseAudioHeader(buffer: ArrayBuffer): ParsedAudioHeader | null {
  return parseFlacHeader(buffer) ?? parseWavHeader(buffer);
}

/** Probe remote URL header for precise duration; returns null on failure. */
export async function probeRemoteAudioDuration(
  url: string,
  signal?: AbortSignal
): Promise<ParsedAudioHeader | null> {
  try {
    const headerBytes = await fetchByteRange(url, 0, HEADER_PROBE_BYTES - 1, signal);
    return parseAudioHeader(headerBytes);
  } catch {
    return null;
  }
}
