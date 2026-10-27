/**
 * Track tag / technical-spec loading that never downloads a whole audio file.
 *
 * - Local `File`/`Blob`: `parseBlob` (lazy slices, no network).
 * - Remote URL: HTTP Range reads of just the tag region. FLAC metadata blocks are walked
 *   individually so unused blocks (padding, seek tables, oversized extras) are never
 *   fetched; ID3v2 / RIFF / others parse from a bounded header window.
 */

import { parseBlob, parseBuffer, selectCover } from 'music-metadata';
import type { IAudioMetadata } from 'music-metadata';
import { fetchRangeBytes } from './rangeFetch';

export interface TrackTags {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  year?: number;
  trackNo?: number;
  genre?: string;
}

export interface TrackSpecs {
  sampleRate?: number;
  bitsPerSample?: number;
  channels?: number;
  container?: string;
  codec?: string;
  /** bits per second */
  bitrate?: number;
  /** seconds */
  duration?: number;
}

export interface TrackPicture {
  mime: string;
  data: Uint8Array;
}

export interface TrackMetadata {
  tags: TrackTags;
  specs: TrackSpecs;
  picture?: TrackPicture;
}

/** Random-access byte source; `end` is exclusive and a short result means EOF. */
export interface ByteSource {
  read(start: number, end: number): Promise<Uint8Array>;
}

/** First read of a remote file; covers STREAMINFO + Vorbis comments + small ID3/RIFF headers. */
const FIRST_READ_BYTES = 128 * 1024;
/** Extra bytes pulled when a read misses the current window (avoids one request per block header). */
const READ_AHEAD_BYTES = 64 * 1024;
/** Largest single tag block / ID3 tag we will fetch (embedded cover art). */
export const MAX_TAG_BYTES = 8 * 1024 * 1024;
/** Frame data after an ID3v2 tag needed to read MPEG stream info. */
const MPEG_FRAME_BYTES = 64 * 1024;

const FLAC_STREAMINFO = 0;
const FLAC_VORBIS_COMMENT = 4;
const FLAC_PICTURE = 6;
const FLAC_MAX_BLOCKS = 128;

function toTrackMetadata(meta: IAudioMetadata): TrackMetadata {
  const { common, format } = meta;
  const cover = selectCover(common.picture);
  return {
    tags: {
      title: common.title,
      artist: common.artist,
      album: common.album,
      albumArtist: common.albumartist,
      year: common.year,
      trackNo: common.track?.no ?? undefined,
      genre: common.genre?.[0],
    },
    specs: {
      sampleRate: format.sampleRate,
      bitsPerSample: format.bitsPerSample,
      channels: format.numberOfChannels,
      container: format.container,
      codec: format.codec,
      bitrate: format.bitrate,
      duration: format.duration,
    },
    picture: cover ? { mime: cover.format, data: cover.data } : undefined,
  };
}

/** Parse a local file; `parseBlob` only slices what it needs. */
export async function loadLocalTrackMetadata(file: Blob): Promise<TrackMetadata> {
  return toTrackMetadata(await parseBlob(file));
}

/**
 * ByteSource over a `fetchRange`-style function that keeps one read window, so
 * consecutive small reads (FLAC block headers) hit memory instead of the network.
 */
export function createWindowedSource(
  fetchRange: (start: number, end: number) => Promise<Uint8Array>,
  initial?: { start: number; bytes: Uint8Array }
): ByteSource {
  let winStart = initial?.start ?? 0;
  let win = initial?.bytes ?? new Uint8Array(0);
  // A short fetch means EOF; remember it so we do not re-ask for bytes past the end.
  let eof = initial ? initial.bytes.byteLength < FIRST_READ_BYTES : false;

  return {
    async read(start, end) {
      const winEnd = winStart + win.byteLength;
      if (start >= winStart && end <= winEnd) return win.subarray(start - winStart, end - winStart);
      if (eof && start >= winStart && start < winEnd) return win.subarray(start - winStart);
      if (eof && start >= winEnd) return new Uint8Array(0);

      const want = Math.max(end - start, READ_AHEAD_BYTES);
      const bytes = await fetchRange(start, start + want);
      eof = bytes.byteLength < want;
      winStart = start;
      win = bytes;
      return win.subarray(0, Math.min(end - start, win.byteLength));
    },
  };
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = '';
  for (let i = start; i < start + length && i < bytes.length; i++) out += String.fromCharCode(bytes[i]!);
  return out;
}

export interface FlacMetadataRead {
  /** `fLaC` + only the blocks music-metadata needs, last-block flag fixed up. */
  bytes: Uint8Array;
  /** Offset of the first audio frame in the original file. */
  audioOffset: number;
}

/**
 * Walk FLAC metadata blocks through `src`, keeping STREAMINFO / VORBIS_COMMENT / PICTURE
 * and skipping the rest without reading their bodies.
 */
export async function readFlacMetadataBlocks(src: ByteSource): Promise<FlacMetadataRead | null> {
  if (ascii(await src.read(0, 4), 0, 4) !== 'fLaC') return null;

  const kept: Uint8Array[] = [];
  let sawStreamInfo = false;
  let offset = 4;
  let audioOffset = -1;

  for (let n = 0; n < FLAC_MAX_BLOCKS; n++) {
    const head = await src.read(offset, offset + 4);
    if (head.length < 4) return null;
    const isLast = (head[0]! & 0x80) !== 0;
    const type = head[0]! & 0x7f;
    const size = (head[1]! << 16) | (head[2]! << 8) | head[3]!;
    const bodyStart = offset + 4;

    const wanted = type === FLAC_STREAMINFO || type === FLAC_VORBIS_COMMENT || type === FLAC_PICTURE;
    if (wanted && size <= MAX_TAG_BYTES) {
      const body = await src.read(bodyStart, bodyStart + size);
      if (body.length < size) return null;
      const block = new Uint8Array(4 + size);
      block[0] = type; // flag bit added below once we know which block ends up last
      block[1] = head[1]!;
      block[2] = head[2]!;
      block[3] = head[3]!;
      block.set(body, 4);
      kept.push(block);
      if (type === FLAC_STREAMINFO) sawStreamInfo = true;
    }

    offset = bodyStart + size;
    if (isLast) {
      audioOffset = offset;
      break;
    }
  }

  if (audioOffset < 0 || !sawStreamInfo) return null;

  kept[kept.length - 1]![0]! |= 0x80;
  const total = 4 + kept.reduce((sum, b) => sum + b.length, 0);
  const bytes = new Uint8Array(total);
  bytes.set([0x66, 0x4c, 0x61, 0x43], 0);
  let at = 4;
  for (const block of kept) {
    bytes.set(block, at);
    at += block.length;
  }
  return { bytes, audioOffset };
}

/** Total length of an ID3v2 tag (header + body + optional footer), or 0 if absent. */
export function id3v2TagLength(head: Uint8Array): number {
  if (head.length < 10 || ascii(head, 0, 3) !== 'ID3') return 0;
  const size =
    ((head[6]! & 0x7f) << 21) | ((head[7]! & 0x7f) << 14) | ((head[8]! & 0x7f) << 7) | (head[9]! & 0x7f);
  const hasFooter = (head[5]! & 0x10) !== 0;
  return 10 + size + (hasFooter ? 10 : 0);
}

async function loadFlac(src: ByteSource, totalSize: number | null): Promise<TrackMetadata | null> {
  const flac = await readFlacMetadataBlocks(src);
  if (!flac) return null;
  const meta = toTrackMetadata(await parseBuffer(flac.bytes, { mimeType: 'audio/flac' }, { skipPostHeaders: true }));
  // The parser only saw the trimmed metadata, so its bitrate is meaningless; recompute from the real file size.
  const { duration } = meta.specs;
  meta.specs.bitrate =
    totalSize !== null && duration && duration > 0
      ? (8 * Math.max(0, totalSize - flac.audioOffset)) / duration
      : undefined;
  return meta;
}

async function loadHeaderWindow(src: ByteSource, path?: string): Promise<TrackMetadata | null> {
  const head = await src.read(0, FIRST_READ_BYTES);
  if (head.length === 0) return null;

  let want = FIRST_READ_BYTES;
  const id3Length = id3v2TagLength(head);
  if (id3Length > 0) {
    if (id3Length > MAX_TAG_BYTES) return null;
    want = Math.max(want, id3Length + MPEG_FRAME_BYTES);
  }
  const bytes = want > head.length ? await src.read(0, want) : head;

  const meta = toTrackMetadata(
    await parseBuffer(bytes, path ? { path } : undefined, { skipPostHeaders: true })
  );
  // Without the whole file, only WAV derives duration/bitrate from its header alone;
  // for MPEG and friends they would be extrapolated from our truncated window.
  if (meta.specs.container !== 'WAVE') {
    meta.specs.duration = undefined;
    meta.specs.bitrate = undefined;
  }
  return meta;
}

/** Load tags + specs through a ByteSource. Resolves null when the data is unreadable. */
export async function loadTrackMetadataFromSource(
  src: ByteSource,
  totalSize: () => number | null,
  path?: string
): Promise<TrackMetadata | null> {
  const magic = await src.read(0, 4);
  if (ascii(magic, 0, 4) === 'fLaC') return loadFlac(src, totalSize());
  return loadHeaderWindow(src, path);
}

/** Load tags + specs for a remote URL via Range reads (see module doc). */
export async function loadRemoteTrackMetadata(
  url: string,
  signal?: AbortSignal
): Promise<TrackMetadata | null> {
  let total: number | null = null;
  const fetchRange = async (start: number, end: number) => {
    const res = await fetchRangeBytes(url, start, end, signal);
    if (res.total !== null) total = res.total;
    return res.bytes;
  };

  let path: string | undefined;
  try {
    path = new URL(url, typeof location !== 'undefined' ? location.href : undefined).pathname;
  } catch {
    path = undefined;
  }

  const first = await fetchRange(0, FIRST_READ_BYTES);
  const src = createWindowedSource(fetchRange, { start: 0, bytes: first });
  try {
    return await loadTrackMetadataFromSource(src, () => total, path);
  } catch (err) {
    if (signal?.aborted) throw err;
    return null; // unparseable / truncated tag: callers fall back to backend fields
  }
}

// ─── Display helpers ────────────────────────────────────────────────────────

export function formatChannelCount(channels: number): string {
  if (channels === 1) return 'Mono';
  if (channels === 2) return 'Stereo';
  return `${channels}ch`;
}

export function formatDuration(seconds?: number): string | undefined {
  if (!seconds || !isFinite(seconds) || seconds <= 0) return undefined;
  const rounded = Math.floor(seconds);
  const mins = Math.floor(rounded / 60);
  const secs = rounded % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/** Short badge labels, e.g. ['FLAC', '44.1 kHz', '16-bit', 'Stereo', '987 kbps']. */
export function formatSpecBadges(specs: TrackSpecs | null | undefined): string[] {
  if (!specs) return [];
  const out: string[] = [];
  const format = specs.container ?? specs.codec;
  if (format) out.push(format);
  if (specs.sampleRate) out.push(`${(specs.sampleRate / 1000).toFixed(1)} kHz`);
  if (specs.bitsPerSample) out.push(`${specs.bitsPerSample}-bit`);
  if (specs.channels) out.push(formatChannelCount(specs.channels));
  if (specs.bitrate) out.push(`${Math.round(specs.bitrate / 1000)} kbps`);
  return out;
}
