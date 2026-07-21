import { AudioContextManager, sharedAudioContextManager } from '../AudioContextManager';
import { WASM_ASSETS, loadWasmScript } from '../wasmLoader';
import type { AudioBackend } from '../../types/audio';
import { BaseSdlBackend, SdlCommonModule } from './BaseSdlBackend';

// Define the Emscripten module interface for SDL2
interface Sdl2Module extends SdlCommonModule {
  _set_audio_data(dataPtr: number, length: number, channels: number, sampleRate: number): void;
}

declare global {
  function createSdl2AudioModule(): Promise<Sdl2Module>;
}

export class Sdl2AudioPlayer extends BaseSdlBackend<Sdl2Module> implements AudioBackend {
  protected readonly label = 'Sdl2AudioPlayer';

  constructor(contextManager: AudioContextManager = sharedAudioContextManager) {
    super(contextManager);
    this.startInitialization();
  }

  protected async loadModule(): Promise<Sdl2Module> {
    if (!window.createSdl2AudioModule) {
      console.log('[Sdl2AudioPlayer] Loading sdl2-audio.js...');
      await loadWasmScript(WASM_ASSETS.sdl2);
      console.log('[Sdl2AudioPlayer] sdl2-audio.js loaded.');
    }

    console.log('[Sdl2AudioPlayer] Calling createSdl2AudioModule()...');
    return window.createSdl2AudioModule();
  }

  /**
   * SDL2 build: we malloc the buffer ourselves, copy into it, pass the pointer to
   * the module, then free it (the module keeps its own copy).
   */
  protected writeAudioData(
    module: Sdl2Module,
    interleaved: Float32Array,
    channels: number,
    sampleRate: number
  ): void {
    const byteLength = interleaved.byteLength;
    const ptr = module._malloc(byteLength);

    if (!ptr) throw new Error('Malloc failed');

    // Access memory.
    // For SDL2 AudioWorklet build, it might use WASM memory or HEAPU8
    let memoryBuffer: ArrayBufferLike | null = null;
    if (module.wasmMemory) memoryBuffer = module.wasmMemory.buffer;
    else if (module.buffer) memoryBuffer = module.buffer;
    else if (module.HEAPU8) memoryBuffer = module.HEAPU8.buffer;

    if (!memoryBuffer) throw new Error('No memory buffer');

    const destination = new Float32Array(memoryBuffer, ptr, interleaved.length);
    destination.set(interleaved);

    module._set_audio_data(ptr, interleaved.length, channels, sampleRate);

    module._free(ptr);
  }
}
