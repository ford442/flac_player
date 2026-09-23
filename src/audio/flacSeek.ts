/**
 * FLAC stream-seek helpers for the hi-fi streaming paths (worklet ring / SDL play ring).
 *
 * Seeking a remote FLAC without downloading it:
 *   1. read the metadata header (STREAMINFO + optional SEEKTABLE) with a small Range GET
 *   2. pick a byte offset (seek point, else a bitrate estimate) and Range GET a window
 *   3. scan the window for a frame header whose CRC-8 and STREAMINFO fields check out;
 *      its coded number gives the frame's first sample exactly
 *   4. decode from that frame (after a synthetic `fLaC` + STREAMINFO prefix) and drop
 *      `target - frameSample` leading frames → sample-accurate seek
 *
 * Pure byte parsing — no decoder, no DOM — so it is unit-testable in node.
 */

export interface FlacStreamInfo {
  minBlockSize: number;
  maxBlockSize: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** 0 when the encoder did not know the length. */
  totalSamples: number;
}

export interface FlacSeekPoint {
  sample: number;
  /** Byte offset from the first frame (audioStart). */
  offset: number;
}

export interface FlacStreamHeader {
  streamInfo: FlacStreamInfo;
  /** Raw 34-byte STREAMINFO body (for the synthetic decoder prefix). */
  streamInfoBytes: Uint8Array;
  seekPoints: FlacSeekPoint[];
  /** Absolute byte offset of the first audio frame. */
  audioStart: number;
}

export interface FlacFramePosition {
  /** Absolute byte offset of the frame header. */
  offset: number;
  /** First sample (per channel) in this frame. */
  sample: number;
}

/** Random access over the compressed file (HTTP Range or a cached Blob). */
export interface ByteReader {
  /** Total bytes, or null when unknown. */
  readonly size: number | null;
  /** Bytes [start, end) — may return fewer at EOF. */
  read(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array>;
}

const MAX_HEADER_BYTES = 16 * 1024 * 1024;

function id3v2Length(bytes: Uint8Array): number {
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
  const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
  const footer = (bytes[5] & 0x10) ? 10 : 0;
  return 10 + size + footer;
}

function readUint64(view: DataView, at: number): number {
  return view.getUint32(at) * 2 ** 32 + view.getUint32(at + 4);
}

export function parseStreamInfo(body: Uint8Array): FlacStreamInfo {
  if (body.length < 34) throw new Error('STREAMINFO too short');
  const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const sampleRate = (body[10] << 12) | (body[11] << 4) | (body[12] >> 4);
  const channels = ((body[12] >> 1) & 0x07) + 1;
  const bitsPerSample = (((body[12] & 0x01) << 4) | (body[13] >> 4)) + 1;
  const totalSamples = (body[13] & 0x0f) * 2 ** 32 + v.getUint32(14);
  return {
    minBlockSize: v.getUint16(0),
    maxBlockSize: v.getUint16(2),
    sampleRate,
    channels,
    bitsPerSample,
    totalSamples,
  };
}

/**
 * Parse `fLaC` metadata from the start of the file. Only STREAMINFO and SEEKTABLE
 * bodies are read; other blocks (pictures, tags) are skipped by length.
 */
export async function readFlacHeader(reader: ByteReader, signal?: AbortSignal): Promise<FlacStreamHeader> {
  let buf = await reader.read(0, 64 * 1024, signal);
  const ensure = async (end: number) => {
    if (end <= buf.length) return;
    if (end > MAX_HEADER_BYTES) throw new Error('FLAC metadata too large');
    if (reader.size !== null && end > reader.size) throw new Error('Truncated FLAC metadata');
    const more = await reader.read(buf.length, Math.max(end, buf.length * 2), signal);
    const merged = new Uint8Array(buf.length + more.length);
    merged.set(buf);
    merged.set(more, buf.length);
    buf = merged;
    if (end > buf.length) throw new Error('Truncated FLAC metadata');
  };

  await ensure(10);
  let pos = id3v2Length(buf);
  await ensure(pos + 4);
  if (buf[pos] !== 0x66 || buf[pos + 1] !== 0x4c || buf[pos + 2] !== 0x61 || buf[pos + 3] !== 0x43) {
    throw new Error('Not a FLAC stream (missing fLaC marker)');
  }
  pos += 4;

  let streamInfoBytes: Uint8Array | null = null;
  const seekPoints: FlacSeekPoint[] = [];
  for (;;) {
    await ensure(pos + 4);
    const last = (buf[pos] & 0x80) !== 0;
    const type = buf[pos] & 0x7f;
    const length = (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
    pos += 4;
    if (type === 0 || type === 3) {
      await ensure(pos + length);
      const body = buf.subarray(pos, pos + length);
      if (type === 0) {
        streamInfoBytes = body.slice(0, 34);
      } else {
        const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
        for (let p = 0; p + 18 <= length; p += 18) {
          if (v.getUint32(p) === 0xffffffff && v.getUint32(p + 4) === 0xffffffff) continue; // placeholder
          seekPoints.push({ sample: readUint64(v, p), offset: readUint64(v, p + 8) });
        }
      }
    }
    pos += length;
    if (last) break;
  }

  if (!streamInfoBytes) throw new Error('FLAC stream has no STREAMINFO');
  seekPoints.sort((a, b) => a.sample - b.sample);
  return { streamInfo: parseStreamInfo(streamInfoBytes), streamInfoBytes, seekPoints, audioStart: pos };
}

/** `fLaC` + last-block STREAMINFO: lets the decoder start at any frame. */
export function syntheticFlacPrefix(header: FlacStreamHeader): ArrayBuffer {
  const out = new Uint8Array(4 + 4 + 34);
  out.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0x00, 0x00, 34], 0);
  out.set(header.streamInfoBytes.subarray(0, 34), 8);
  return out.buffer;
}

const CRC8_TABLE = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let b = 0; b < 8; b++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    t[i] = c;
  }
  return t;
})();

export function crc8(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0;
  for (let i = start; i < end; i++) crc = CRC8_TABLE[crc ^ bytes[i]];
  return crc;
}

const SAMPLE_RATE_CODES = [0, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000];
const BPS_CODES = [0, 8, 12, 0, 16, 20, 24, 32];

/**
 * Parse a frame header at `at`. Returns the frame's first sample, or null when the
 * bytes are not a frame header consistent with `info` (sync, reserved bits, CRC-8).
 */
export function parseFrameHeader(bytes: Uint8Array, at: number, info: FlacStreamInfo): number | null {
  if (at + 6 > bytes.length) return null;
  if (bytes[at] !== 0xff || (bytes[at + 1] & 0xfe) !== 0xf8) return null;
  const variable = (bytes[at + 1] & 0x01) === 1;
  const bsCode = bytes[at + 2] >> 4;
  const srCode = bytes[at + 2] & 0x0f;
  const chCode = bytes[at + 3] >> 4;
  const bpsCode = (bytes[at + 3] >> 1) & 0x07;
  if (bsCode === 0 || srCode === 15 || chCode > 10 || bpsCode === 3 || (bytes[at + 3] & 0x01)) return null;

  const channels = chCode < 8 ? chCode + 1 : 2;
  if (channels !== info.channels) return null;
  if (srCode >= 1 && srCode <= 11 && SAMPLE_RATE_CODES[srCode] !== info.sampleRate) return null;
  if (bpsCode !== 0 && BPS_CODES[bpsCode] !== info.bitsPerSample) return null;

  // Coded number: UTF-8-style, up to 7 bytes (36 bits).
  let p = at + 4;
  const first = bytes[p++];
  let extra: number;
  let value: number;
  if (first < 0x80) { extra = 0; value = first; }
  else if ((first & 0xe0) === 0xc0) { extra = 1; value = first & 0x1f; }
  else if ((first & 0xf0) === 0xe0) { extra = 2; value = first & 0x0f; }
  else if ((first & 0xf8) === 0xf0) { extra = 3; value = first & 0x07; }
  else if ((first & 0xfc) === 0xf8) { extra = 4; value = first & 0x03; }
  else if ((first & 0xfe) === 0xfc) { extra = 5; value = first & 0x01; }
  else if (first === 0xfe) { extra = 6; value = 0; }
  else return null;
  if (!variable && extra > 5) return null;
  if (p + extra > bytes.length) return null;
  for (let i = 0; i < extra; i++) {
    const b = bytes[p++];
    if ((b & 0xc0) !== 0x80) return null;
    value = value * 64 + (b & 0x3f);
  }

  let blockSize: number;
  if (bsCode === 1) blockSize = 192;
  else if (bsCode <= 5) blockSize = 576 << (bsCode - 2);
  else if (bsCode === 6) { if (p + 1 > bytes.length) return null; blockSize = bytes[p++] + 1; }
  else if (bsCode === 7) { if (p + 2 > bytes.length) return null; blockSize = ((bytes[p] << 8) | bytes[p + 1]) + 1; p += 2; }
  else blockSize = 256 << (bsCode - 8);
  if (info.maxBlockSize > 0 && blockSize > info.maxBlockSize) return null;

  if (srCode === 12) p += 1;
  else if (srCode === 13 || srCode === 14) p += 2;
  if (p + 1 > bytes.length) return null;
  if (crc8(bytes, at, p) !== bytes[p]) return null;

  const sample = variable ? value : value * (info.maxBlockSize || blockSize);
  if (info.totalSamples > 0 && sample >= info.totalSamples) return null;
  return sample;
}

/** First valid frame header in `bytes` (absolute offset = `base + index`). */
export function findFrame(bytes: Uint8Array, base: number, info: FlacStreamInfo): FlacFramePosition | null {
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] !== 0xff || (bytes[i + 1] & 0xfe) !== 0xf8) continue;
    const sample = parseFrameHeader(bytes, i, info);
    if (sample !== null) return { offset: base + i, sample };
  }
  return null;
}

const SCAN_WINDOW = 256 * 1024;

/**
 * Locate a frame whose first sample is ≤ `targetSample` (as close as practical).
 * Uses the SEEKTABLE when present, else a constant-bitrate estimate that backs
 * off until the found frame starts at or before the target. Returns null when
 * the file size is unknown (caller skip-decodes from the start).
 */
export async function locateFrame(
  reader: ByteReader,
  header: FlacStreamHeader,
  targetSample: number,
  signal?: AbortSignal
): Promise<FlacFramePosition | null> {
  const { streamInfo: info, audioStart } = header;
  if (targetSample <= 0) return { offset: audioStart, sample: 0 };

  const scanAt = async (offset: number): Promise<FlacFramePosition | null> => {
    const bytes = await reader.read(offset, offset + SCAN_WINDOW, signal);
    return findFrame(bytes, offset, info);
  };

  let point: FlacSeekPoint | null = null;
  for (const sp of header.seekPoints) {
    if (sp.sample <= targetSample) point = sp;
    else break;
  }
  if (point) {
    const found = await scanAt(audioStart + point.offset);
    // A seek point targets a frame start; accept only an exact match.
    if (found && found.offset === audioStart + point.offset && found.sample === point.sample) {
      // Close enough (< 20 s of skip-decode)? Otherwise refine with the estimate below.
      if (targetSample - found.sample <= info.sampleRate * 20 || reader.size === null) return found;
    }
  }

  if (reader.size === null || info.totalSamples <= 0) return null;
  const audioBytes = reader.size - audioStart;
  let backoff = Math.max(info.maxBlockSize * info.channels * 4, 64 * 1024);
  for (let attempt = 0; attempt < 12; attempt++) {
    const estimate = audioStart + Math.floor((targetSample / info.totalSamples) * audioBytes) - backoff;
    const offset = Math.max(audioStart, Math.min(estimate, reader.size - 1));
    const found = offset <= audioStart ? { offset: audioStart, sample: 0 } : await scanAt(offset);
    if (found && found.sample <= targetSample) return found;
    if (offset <= audioStart) break;
    backoff *= 2;
  }
  return { offset: audioStart, sample: 0 };
}
