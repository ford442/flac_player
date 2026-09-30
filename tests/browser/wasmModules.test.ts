// Smoke: the committed WASM artifacts in public/ instantiate in real Chromium
// (COOP/COEP headers from vitest.browser.config.ts enable the pthread build).
// verify:wasm proves the hashes match; this proves the binaries actually run.
import { describe, expect, it } from 'vitest';
import { WASM_ASSETS, loadWasmScript } from '../../src/audio/wasmLoader';

type Factory = () => Promise<Record<string, unknown>>;

async function instantiate(url: string, exportName: string): Promise<Record<string, unknown>> {
  await loadWasmScript(url);
  const factory = (window as unknown as Record<string, Factory | undefined>)[exportName];
  expect(factory, `${exportName} defined by ${url}`).toBeTypeOf('function');
  return factory!();
}

describe('committed WASM artifacts', () => {
  it('createSdlAudioModule() resolves and exposes the engine ABI', async () => {
    const module = await instantiate(WASM_ASSETS.sdl3, 'createSdlAudioModule');
    expect(module._init_audio).toBeTypeOf('function');
    expect(module._cleanup).toBeTypeOf('function');
  });

  it('createSpeexResamplerModule() resolves', async () => {
    const module = await instantiate(WASM_ASSETS.speexResampler, 'createSpeexResamplerModule');
    expect(module._malloc).toBeTypeOf('function');
  });
});
