import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { parseBlob, parseBuffer } from 'music-metadata';

const fixturesDir = path.join(process.cwd(), 'tests/fixtures');

describe('music-metadata (browser-compatible parseBlob/parseBuffer)', () => {
  it('parses FLAC fixture title, duration, and sampleRate', async () => {
    const data = fs.readFileSync(path.join(fixturesDir, 'test.flac'));
    const meta = await parseBuffer(new Uint8Array(data), { mimeType: 'audio/flac', path: 'test.flac' });

    expect(meta.common.title).toBe('Fixture FLAC');
    expect(meta.format.duration).toBeCloseTo(1, 2);
    expect(meta.format.sampleRate).toBe(44100);
  });

  it('parses WAV fixture title, duration, and sampleRate via parseBlob', async () => {
    const data = fs.readFileSync(path.join(fixturesDir, 'test.wav'));
    const blob = new Blob([data], { type: 'audio/wav' });
    // File.name helps the parser when MIME alone is ambiguous
    const file = new File([blob], 'test.wav', { type: 'audio/wav' });
    const meta = await parseBlob(file);

    expect(meta.common.title).toBe('Test Track');
    expect(meta.format.duration).toBeCloseTo(0.25, 2);
    expect(meta.format.sampleRate).toBe(44100);
  });
});
