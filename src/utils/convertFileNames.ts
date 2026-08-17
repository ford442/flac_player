/** Helpers for MP3 ↔ FLAC convert UI (pure, no ffmpeg). */

export type ConvertDirection = 'mp3-to-flac' | 'flac-to-mp3';

export type Mp3Bitrate = '128k' | '192k' | '256k' | '320k';

const MP3_EXT = /\.mp3$/i;
const FLAC_EXT = /\.flac$/i;

export function detectConvertDirection(file: { name: string; type?: string }): ConvertDirection | null {
  const name = file.name || '';
  const type = (file.type || '').toLowerCase();

  if (MP3_EXT.test(name) || type === 'audio/mpeg' || type === 'audio/mp3') {
    return 'mp3-to-flac';
  }
  if (FLAC_EXT.test(name) || type === 'audio/flac' || type === 'audio/x-flac') {
    return 'flac-to-mp3';
  }
  return null;
}

export function outputFileName(inputName: string, direction: ConvertDirection): string {
  const base = inputName.replace(/\.[^/.]+$/, '') || 'converted';
  return direction === 'mp3-to-flac' ? `${base}.flac` : `${base}.mp3`;
}

export function mimeForDirection(direction: ConvertDirection): string {
  return direction === 'mp3-to-flac' ? 'audio/flac' : 'audio/mpeg';
}

export function directionLabel(direction: ConvertDirection): string {
  return direction === 'mp3-to-flac' ? 'MP3 → FLAC' : 'FLAC → MP3';
}

/** Safe MEMFS basenames (ffmpeg.wasm MEMFS is flat). */
export function memfsInputName(direction: ConvertDirection): string {
  return direction === 'mp3-to-flac' ? 'input.mp3' : 'input.flac';
}

export function memfsOutputName(direction: ConvertDirection): string {
  return direction === 'mp3-to-flac' ? 'output.flac' : 'output.mp3';
}

export function buildFfmpegArgs(
  direction: ConvertDirection,
  options: { mp3Bitrate?: Mp3Bitrate; flacCompressionLevel?: number } = {}
): string[] {
  const input = memfsInputName(direction);
  const output = memfsOutputName(direction);
  const compression = clampCompression(options.flacCompressionLevel ?? 5);
  const bitrate = options.mp3Bitrate ?? '320k';

  if (direction === 'mp3-to-flac') {
    return [
      '-i', input,
      '-map_metadata', '0',
      '-c:a', 'flac',
      '-compression_level', String(compression),
      output,
    ];
  }

  return [
    '-i', input,
    '-map_metadata', '0',
    '-c:a', 'libmp3lame',
    '-b:a', bitrate,
    '-id3v2_version', '3',
    output,
  ];
}

function clampCompression(level: number): number {
  if (!Number.isFinite(level)) return 5;
  return Math.max(0, Math.min(12, Math.round(level)));
}

export function triggerDownload(data: Uint8Array, fileName: string, mimeType: string): void {
  // Copy into a fresh ArrayBuffer-backed view so BlobPart typing is satisfied.
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const blob = new Blob([copy.buffer], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke after the browser has started the download.
  setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
