import { fetchByteRange } from '../utils/rangeFetch';

export interface AudioHeaderInfo {
  sampleRate?: number;
  channels?: number;
}

const FLAC_MAGIC = [0x66, 0x4c, 0x61, 0x43]; // fLaC

function readAscii(view: DataView, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) {
    s += String.fromCharCode(view.getUint8(offset + i));
  }
  return s;
}

function parseFlacHeader(buffer: ArrayBuffer): AudioHeaderInfo | null {
  if (buffer.byteLength < 42) return null;

  const view = new DataView(buffer);
  for (let i = 0; i < FLAC_MAGIC.length; i++) {
    if (view.getUint8(i) !== FLAC_MAGIC[i]) return null;
  }

  let offset = 4;
  while (offset + 4 <= buffer.byteLength) {
    const header = view.getUint32(offset, false);
    const isLast = (header & 0x80000000) !== 0;
    const blockType = (header >> 24) & 0x7f;
    const blockLength = header & 0x00ffffff;
    offset += 4;

    if (offset + blockLength > buffer.byteLength) return null;

    if (blockType === 0 && blockLength >= 18) {
      const body = offset;
      const sampleRate = (view.getUint8(body + 10) << 12)
        | (view.getUint8(body + 11) << 4)
        | (view.getUint8(body + 12) >> 4);
      const channels = ((view.getUint8(body + 12) & 0x0e) >> 1) + 1;
      return { sampleRate, channels };
    }

    offset += blockLength;
    if (isLast) break;
  }

  return null;
}

function parseWavHeader(buffer: ArrayBuffer): AudioHeaderInfo | null {
  if (buffer.byteLength < 44) return null;

  const view = new DataView(buffer);
  if (readAscii(view, 0, 4) !== 'RIFF') return null;
  if (readAscii(view, 8, 4) !== 'WAVE') return null;

  let offset = 12;
  while (offset + 8 <= buffer.byteLength) {
    const chunkId = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    offset += 8;

    if (chunkId === 'fmt ' && chunkSize >= 16 && offset + 16 <= buffer.byteLength) {
      const channels = view.getUint16(offset + 2, true);
      const sampleRate = view.getUint32(offset + 4, true);
      return { sampleRate, channels };
    }

    offset += chunkSize + (chunkSize % 2);
  }

  return null;
}

/** Parse sample rate/channels from the start of a FLAC or WAV file. */
export function probeAudioHeader(buffer: ArrayBuffer): AudioHeaderInfo | null {
  return parseFlacHeader(buffer) ?? parseWavHeader(buffer);
}

/** Fetch the first 64 KiB of a remote audio file and parse its header. */
export async function probeRemoteAudioHeader(
  url: string,
  signal?: AbortSignal,
): Promise<AudioHeaderInfo | null> {
  try {
    const buffer = await fetchByteRange(url, 0, 65535, signal);
    return probeAudioHeader(buffer);
  } catch {
    return null;
  }
}
