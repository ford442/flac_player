import { FLACDecoder } from '@wasm-audio-decoders/flac';
import fs from 'fs';
import path from 'path';

async function test() {
  const decoder = new FLACDecoder();
  await decoder.ready;
  
  const data = fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/test.flac'));
  const result = await decoder.decodeFile(data);
  
  console.log('sampleRate:', result.sampleRate);
  console.log('channels:', result.channelData.length);
  console.log('samplesDecoded:', result.samplesDecoded);
  console.log('duration:', result.samplesDecoded / result.sampleRate);
  console.log('bitDepth:', result.bitDepth);
  
  // Assertions
  if (result.sampleRate !== 44100) throw new Error(`Expected sampleRate 44100, got ${result.sampleRate}`);
  if (result.channelData.length !== 2) throw new Error(`Expected 2 channels, got ${result.channelData.length}`);
  if (result.samplesDecoded !== 44100) throw new Error(`Expected 44100 samples, got ${result.samplesDecoded}`);
  
  console.log('✓ All assertions passed');
  decoder.free();
}

test().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
