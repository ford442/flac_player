import { describe, expect, it } from 'vitest';
import {
  buildFfmpegArgs,
  detectConvertDirection,
  directionLabel,
  formatBytes,
  memfsInputName,
  memfsOutputName,
  mimeForDirection,
  outputFileName,
} from '../src/utils/convertFileNames';

describe('detectConvertDirection', () => {
  it('detects mp3 by extension', () => {
    expect(detectConvertDirection({ name: 'song.mp3' })).toBe('mp3-to-flac');
    expect(detectConvertDirection({ name: 'Song.MP3' })).toBe('mp3-to-flac');
  });

  it('detects flac by extension', () => {
    expect(detectConvertDirection({ name: 'track.flac' })).toBe('flac-to-mp3');
  });

  it('detects by MIME type', () => {
    expect(detectConvertDirection({ name: 'a', type: 'audio/mpeg' })).toBe('mp3-to-flac');
    expect(detectConvertDirection({ name: 'a', type: 'audio/flac' })).toBe('flac-to-mp3');
  });

  it('returns null for unsupported types', () => {
    expect(detectConvertDirection({ name: 'notes.txt' })).toBeNull();
    expect(detectConvertDirection({ name: 'clip.wav' })).toBeNull();
  });
});

describe('outputFileName', () => {
  it('swaps extensions', () => {
    expect(outputFileName('bohemian.mp3', 'mp3-to-flac')).toBe('bohemian.flac');
    expect(outputFileName('bohemian.flac', 'flac-to-mp3')).toBe('bohemian.mp3');
  });

  it('handles names without extension', () => {
    expect(outputFileName('raw', 'mp3-to-flac')).toBe('raw.flac');
  });
});

describe('buildFfmpegArgs', () => {
  it('builds mp3-to-flac args with compression level', () => {
    const args = buildFfmpegArgs('mp3-to-flac', { flacCompressionLevel: 8 });
    expect(args).toEqual([
      '-i', 'input.mp3',
      '-map_metadata', '0',
      '-c:a', 'flac',
      '-compression_level', '8',
      'output.flac',
    ]);
  });

  it('builds flac-to-mp3 args with bitrate', () => {
    const args = buildFfmpegArgs('flac-to-mp3', { mp3Bitrate: '192k' });
    expect(args).toEqual([
      '-i', 'input.flac',
      '-map_metadata', '0',
      '-c:a', 'libmp3lame',
      '-b:a', '192k',
      '-id3v2_version', '3',
      'output.mp3',
    ]);
  });

  it('clamps invalid compression levels', () => {
    expect(buildFfmpegArgs('mp3-to-flac', { flacCompressionLevel: 99 })).toContain('12');
    expect(buildFfmpegArgs('mp3-to-flac', { flacCompressionLevel: -3 })).toContain('0');
  });
});

describe('misc helpers', () => {
  it('maps mime and labels', () => {
    expect(mimeForDirection('mp3-to-flac')).toBe('audio/flac');
    expect(mimeForDirection('flac-to-mp3')).toBe('audio/mpeg');
    expect(directionLabel('mp3-to-flac')).toBe('MP3 → FLAC');
  });

  it('uses stable memfs names', () => {
    expect(memfsInputName('mp3-to-flac')).toBe('input.mp3');
    expect(memfsOutputName('flac-to-mp3')).toBe('output.mp3');
  });

  it('formats bytes', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB');
  });
});
