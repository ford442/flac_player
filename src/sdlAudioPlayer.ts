import { FlacDecoder } from './flacDecoder';
import { PlayerState } from './audioPlayer';

// Define the Emscripten module interface
interface SdlModule {
  _init_audio(): number;
  _set_audio_data(dataPtr: number, length: number, channels: number, sampleRate: number): void;
  _play(): void;
  _pause_audio(): void;
  _resume_audio(): void;
  _stop(): void;
  _seek(time: number): void;
  _get_current_time(): number;
  _set_volume(volume: number): void;
  _cleanup(): void;
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPF32: Float32Array;
  HEAPU8: Uint8Array;
  wasmMemory?: WebAssembly.Memory;
  HEAP8?: Int8Array;
  ccall?(ident: string, returnType: string | null, argTypes: string[], args: unknown[]): unknown;
}

type SdlModuleWithMemory = SdlModule & { wasmMemory?: WebAssembly.Memory };

// Global function exposed by the WASM script
declare global {
  function createSdlAudioModule(): Promise<SdlModule>;
}

export class SdlAudioPlayer {
  private module: SdlModule | null = null;
  private isReady: boolean = false;
  private isPlaying: boolean = false;
  private duration: number = 0;
  private onStateChange?: (state: PlayerState) => void;
  private pollInterval: number | null = null;
  private lastVolume: number = 1.0;

  constructor() {
    this.initializeModule();
  }

  private async initializeModule() {
    // Load the ScriptProcessor->AudioWorklet shim first (best-effort). This enables environments
    // where ScriptProcessorNode is missing/deprecated to still work via AudioWorkletNode.
    if (!(window as any).__sdl_script_processor_shim_loaded) {
      const shim = document.createElement('script');
      shim.src = 'script-processor-shim.js';
      shim.async = true;
      document.head.appendChild(shim);

      await new Promise<void>((resolve) => {
        shim.onload = () => { (window as any).__sdl_script_processor_shim_loaded = true; resolve(); };
        shim.onerror = () => { console.warn('Script processor shim failed to load; continuing without shim.'); resolve(); };
      });
    }

    // Dynamically load the WASM/SDL script if not already present
    if (!window.createSdlAudioModule) {
      const script = document.createElement('script');
      script.src = 'sdl-audio.js';
      script.async = true;
      document.body.appendChild(script);

      await new Promise<void>((resolve, reject) => {
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Failed to load sdl-audio.js'));
      });
    }

    try {
      this.module = await window.createSdlAudioModule();
      const success = this.module._init_audio();
      if (!success) {
        console.error('Failed to initialize SDL audio');
      } else {
        this.isReady = true;
        this.startPolling();
      }
    } catch (err) {
      console.error('Error initializing SDL module:', err);
    }
  }

  setStateChangeCallback(callback: (state: PlayerState) => void): void {
    this.onStateChange = callback;
  }

  private notifyStateChange(): void {
    if (this.onStateChange) {
      this.onStateChange(this.getState());
    }
  }

  // Poll for playback position updates
  private startPolling() {
    if (this.pollInterval) window.clearInterval(this.pollInterval);
    this.pollInterval = window.setInterval(() => {
      if (this.isPlaying && this.module) {
        this.notifyStateChange();
      }
    }, 100);
  }

  async loadAudio(arrayBuffer: ArrayBuffer): Promise<void> {
    if (!this.module || !this.isReady) {
        // Retry init if not ready? or wait?
        // For simplicity, assume initialized by the time user clicks load.
        if (!this.module) throw new Error('SDL Module not initialized');
    }

    this.stop();
    this.notifyStateChange();

    try {
      const decoder = new FlacDecoder();
      const result = await decoder.decode(arrayBuffer);

      this.duration = result.duration;

      // Interleave samples
      const channels = result.channels;
      const length = result.samples[0].length;
      const interleavedLength = length * channels;
      const interleaved = new Float32Array(interleavedLength);

      for (let i = 0; i < length; i++) {
        for (let ch = 0; ch < channels; ch++) {
          interleaved[i * channels + ch] = result.samples[ch][i];
        }
      }

      // Allocate memory in WASM (in bytes) and write safely to the current WASM buffer
      const byteLength = interleaved.byteLength;
      const ptr = (this.module as any)._malloc(byteLength);

      if (!ptr || ptr === 0) {
        // Malloc failed: fall back to ccall copy (note: ccall -> writeArrayToMemory may hit RangeError if it writes into a stale view)
        console.warn('WASM malloc failed (returned 0). Trying ccall fallback that copies the array into WASM memory.');
        try {
          (this.module as any).ccall('set_audio_data', null, ['array', 'number', 'number', 'number'], [interleaved, interleavedLength, channels, result.sampleRate]);
        } catch (ccErr) {
          console.error('Fallback ccall set_audio_data failed:', ccErr);
          throw ccErr;
        }
      } else {
        try {
          // Critical fix: always use an up-to-date WASM heap buffer. Some environments (e.g., AudioWorklet)
          // don't populate HEAP* views on the main thread, so reconstruct them from wasmMemory when needed.
          const wasmModule = this.module as SdlModuleWithMemory;
          if (wasmModule.wasmMemory?.buffer) {
            const currentBuffer = wasmModule.wasmMemory.buffer;
            const rebuildView = <T extends ArrayBufferView>(
              existing: T | undefined,
              ViewCtor: new (buffer: ArrayBufferLike, byteOffset?: number, length?: number) => T
            ): T => {
              const offset = existing?.byteOffset ?? 0;
              const length = existing?.length;
              return length !== undefined
                ? new ViewCtor(currentBuffer, offset, length)
                : new ViewCtor(currentBuffer);
            };

            wasmModule.HEAPU8 = rebuildView(wasmModule.HEAPU8, Uint8Array);
            wasmModule.HEAPF32 = rebuildView(wasmModule.HEAPF32, Float32Array);
            wasmModule.HEAP8 = rebuildView(wasmModule.HEAP8, Int8Array);
          }

          let memoryBuffer: ArrayBufferLike;

          if (wasmModule.HEAPU8?.buffer) {
            memoryBuffer = wasmModule.HEAPU8.buffer;
          } else if (wasmModule.wasmMemory?.buffer) {
            memoryBuffer = wasmModule.wasmMemory.buffer;
          } else if (wasmModule.HEAP8?.buffer) {
            memoryBuffer = wasmModule.HEAP8.buffer;
          } else {
            // Debug log to help identify available properties if all else fails
            console.error('Available module properties:', Object.keys(wasmModule));
            throw new Error('Cannot find WASM memory buffer (HEAPU8, wasmMemory, or HEAP8 are missing)');
          }

          const destination = new Float32Array(memoryBuffer, ptr, interleavedLength);
          destination.set(interleaved);

          // Send to C++ (direct call, faster and avoids writeArrayToMemory)
          (this.module as any)._set_audio_data(ptr, interleavedLength, channels, result.sampleRate);
        } catch (err) {
          const heapByteLength = (this.module as any).HEAPU8?.buffer?.byteLength ||
                                 (this.module as any).wasmMemory?.buffer?.byteLength ||
                                 undefined;

          console.error('Failed to write audio data into WASM heap:', err, { ptr, byteLength, heapByteLength });

          // Try fallback ccall if direct write fails (covers browser-specific edge cases)
          try {
            (this.module as any).ccall('set_audio_data', null, ['array', 'number', 'number', 'number'], [interleaved, interleavedLength, channels, result.sampleRate]);
          } catch (ccErr) {
            console.error('Fallback ccall set_audio_data also failed:', ccErr);
            // Free pointer and rethrow original error
            (this.module as any)._free && (this.module as any)._free(ptr);
            throw err;
          }
        } finally {
          // Free malloc'd memory (the C++ copy made its own copy into g_state.audioBuffer)
          (this.module as any)._free && (this.module as any)._free(ptr);
        }
      }

      this.notifyStateChange();

    } catch (error) {
      console.error('Error loading audio in SDL player:', error);
      throw error;
    }
  }

  play(): void {
    if (!this.module) return;
    this.module._play();
    this.isPlaying = true;
    this.notifyStateChange();
  }

  pause(): void {
    if (!this.module) return;
    this.module._pause_audio();
    this.isPlaying = false;
    this.notifyStateChange();
  }

  stop(): void {
    if (!this.module) return;
    this.module._stop();
    this.isPlaying = false;
    this.notifyStateChange();
  }

  seek(time: number): void {
    if (!this.module) return;
    this.module._seek(time);
    this.notifyStateChange();
  }

  getCurrentTime(): number {
    if (!this.module) return 0;
    return this.module._get_current_time();
  }

  getDuration(): number {
    return this.duration;
  }

  getState(): PlayerState {
    return {
      isPlaying: this.isPlaying,
      currentTime: this.getCurrentTime(),
      duration: this.getDuration(),
      isLoading: false
    };
  }

  setVolume(volume: number): void {
    this.lastVolume = volume;
    if (this.module) {
      this.module._set_volume(volume);
    }
  }

  getAnalyser(): AnalyserNode {
    // SDL player doesn't support Web Audio AnalyserNode integration yet
    // Return a dummy analyser to satisfy interface if needed, or throw/return null and handle in UI
    // The UI handles null but the type signature says AnalyserNode.
    // We'll cast null or create a dummy one.
    // Creating a dummy one requires AudioContext.
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    return analyser;
  }

  destroy(): void {
    this.stop();
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.module) {
      this.module._cleanup();
    }
  }
}
