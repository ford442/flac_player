import { FLACDecoder } from '@wasm-audio-decoders/flac';
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

describe('FLAC fixture decode', () => {
  it('decodes tests/fixtures/test.flac via wasm-audio-decoders', async () => {
    const decoder = new FLACDecoder();
    await decoder.ready;

    const data = fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/test.flac'));
    const result = await decoder.decodeFile(data);

    expect(result.sampleRate).toBe(44100);
    expect(result.channelData.length).toBe(2);
    expect(result.samplesDecoded).toBe(44100);

    decoder.free();
  });
});
