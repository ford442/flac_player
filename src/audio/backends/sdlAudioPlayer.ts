import { AudioContextManager, sharedAudioContextManager } from '../AudioContextManager';
import { WASM_ASSETS, loadWasmScript } from '../wasmLoader';
import type { AudioBackend } from '../../types/audio';
import { BaseSdlBackend, SdlCommonModule } from './BaseSdlBackend';

// Define the Emscripten module interface
interface SdlModule extends SdlCommonModule {
  _create_audio_buffer(length: number): number;
  _set_audio_data(length: number, channels: number, sampleRate: number): void;
}

// Global function exposed by the WASM script
declare global {
  function createSdlAudioModule(): Promise<SdlModule>;
  interface Window {
    __sdl_script_processor_shim_loaded?: boolean;
  }
}

export class SdlAudioPlayer extends BaseSdlBackend<SdlModule> implements AudioBackend {
  protected readonly label = 'SdlAudioPlayer';

  constructor(contextManager: AudioContextManager = sharedAudioContextManager) {
    super(contextManager);
    this.startInitialization();
  }

  protected async loadModule(): Promise<SdlModule> {
    // Load the ScriptProcessor->AudioWorklet shim first (best-effort). This enables environments
    // where ScriptProcessorNode is missing/deprecated to still work via AudioWorkletNode.
    if (!window.__sdl_script_processor_shim_loaded) {
      console.log('[SdlAudioPlayer] Loading script-processor-shim.js...');
      try {
        await loadWasmScript(WASM_ASSETS.scriptProcessorShim);
        window.__sdl_script_processor_shim_loaded = true;
        console.log('[SdlAudioPlayer] script-processor-shim.js loaded.');
      } catch {
        console.warn('[SdlAudioPlayer] Script processor shim failed to load; continuing without shim.');
      }
    }

    if (!window.createSdlAudioModule) {
      console.log('[SdlAudioPlayer] Loading sdl-audio.js...');
      await loadWasmScript(WASM_ASSETS.sdl3);
      console.log('[SdlAudioPlayer] sdl-audio.js loaded.');
    }

    console.log('[SdlAudioPlayer] Calling createSdlAudioModule()...');
    return window.createSdlAudioModule();
  }

  /**
   * SDL3 build: the module allocates the buffer and hands back a pointer, which we
   * write into directly through HEAPF32.
   */
  protected writeAudioData(
    module: SdlModule,
    interleaved: Float32Array,
    channels: number,
    sampleRate: number
  ): void {
    const interleavedLength = interleaved.length;
    console.log('[SdlAudioPlayer] Interleaved samples ready. Total samples:', interleavedLength);

    // Let C++ allocate the memory and give us a pointer
    const ptr = module._create_audio_buffer(interleavedLength);
    if (!ptr) {
      throw new Error('[SdlAudioPlayer] _create_audio_buffer failed to allocate memory.');
    }

    console.log('[SdlAudioPlayer] C++ allocated buffer at ptr:', ptr);

    try {
      // Get the correct memory view
      let memoryView: Float32Array | null = null;
      if (module.HEAPF32) {
        memoryView = module.HEAPF32;
      } else if (module.wasmMemory?.buffer) {
        // Fallback for certain Emscripten versions/configs
        memoryView = new Float32Array(module.wasmMemory.buffer);
      }

      if (!memoryView) {
        throw new Error('Unable to access WebAssembly HEAPF32 memory view.');
      }

      // Write directly to the WASM memory at the provided pointer.
      // The pointer is a byte offset, so we need to convert it to a Float32 index.
      const floatIndex = ptr / 4;
      console.log(`[SdlAudioPlayer] Writing ${interleavedLength} samples to HEAPF32 at index ${floatIndex}`);

      memoryView.set(interleaved, floatIndex);

      console.log('[SdlAudioPlayer] Copy successful. Calling _set_audio_data...');
      module._set_audio_data(interleavedLength, channels, sampleRate);
      console.log('[SdlAudioPlayer] _set_audio_data returned.');
    } catch (err) {
      console.error('[SdlAudioPlayer] Failed to write audio data into WASM heap:', err, {
        ptr,
        interleavedLength,
        hasWasmMemory: !!module.wasmMemory,
        hasHEAPF32: !!module.HEAPF32
      });
      // No need to free ptr, as it's a direct pointer to a vector's data, not a malloc'd block
      throw err;
    }
  }
}
