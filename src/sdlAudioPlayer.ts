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
  HEAPF32?: Float32Array;
  HEAPU8?: Uint8Array;
  // Memory access for pthreads/AUDIO_WORKLET builds
  wasmMemory?: WebAssembly.Memory;
  buffer?: ArrayBuffer;
}

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
    console.log('[SdlAudioPlayer] Initializing module...');
    // Load the ScriptProcessor->AudioWorklet shim first (best-effort). This enables environments
    // where ScriptProcessorNode is missing/deprecated to still work via AudioWorkletNode.
    if (!(window as any).__sdl_script_processor_shim_loaded) {
      console.log('[SdlAudioPlayer] Loading script-processor-shim.js...');
      const shim = document.createElement('script');
      shim.src = 'script-processor-shim.js';
      shim.async = true;
      document.head.appendChild(shim);

      await new Promise<void>((resolve) => {
        shim.onload = () => {
          console.log('[SdlAudioPlayer] script-processor-shim.js loaded.');
          (window as any).__sdl_script_processor_shim_loaded = true;
          resolve();
        };
        shim.onerror = () => {
          console.warn('[SdlAudioPlayer] Script processor shim failed to load; continuing without shim.');
          resolve();
        };
      });
    }

    // Dynamically load the WASM/SDL script if not already present
    if (!window.createSdlAudioModule) {
      console.log('[SdlAudioPlayer] Loading sdl-audio.js...');
      const script = document.createElement('script');
      script.src = 'sdl-audio.js';
      script.async = true;
      document.body.appendChild(script);

      await new Promise<void>((resolve, reject) => {
        script.onload = () => {
           console.log('[SdlAudioPlayer] sdl-audio.js loaded.');
           resolve();
        };
        script.onerror = () => reject(new Error('Failed to load sdl-audio.js'));
      });
    }

    try {
      console.log('[SdlAudioPlayer] Calling createSdlAudioModule()...');
      this.module = await window.createSdlAudioModule();
      console.log('[SdlAudioPlayer] Module created. Inspecting keys:', Object.keys(this.module));
      console.log('[SdlAudioPlayer] Module.wasmMemory:', (this.module as any).wasmMemory);
      console.log('[SdlAudioPlayer] Module.buffer:', (this.module as any).buffer);
      console.log('[SdlAudioPlayer] Module.HEAPU8:', (this.module as any).HEAPU8);

      const success = this.module._init_audio();
      if (!success) {
        console.error('[SdlAudioPlayer] Failed to initialize SDL audio (init_audio returned 0)');
      } else {
        console.log('[SdlAudioPlayer] SDL Audio initialized successfully.');
        this.isReady = true;
        this.startPolling();
      }
    } catch (err) {
      console.error('[SdlAudioPlayer] Error initializing SDL module:', err);
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
    console.log('[SdlAudioPlayer] loadAudio called with ArrayBuffer of size:', arrayBuffer.byteLength);
    if (!this.module || !this.isReady) {
        console.warn('[SdlAudioPlayer] Module not ready during loadAudio call.');
        if (!this.module) throw new Error('SDL Module not initialized');
    }

    this.stop();
    this.notifyStateChange();

    try {
      console.log('[SdlAudioPlayer] Decoding audio...');
      const decoder = new FlacDecoder();
      const result = await decoder.decode(arrayBuffer);
      console.log('[SdlAudioPlayer] Decoded. Channels:', result.channels, 'SampleRate:', result.sampleRate, 'Duration:', result.duration);

      this.duration = result.duration;

      // Interleave samples
      const channels = result.channels;
      const length = result.samples[0].length;
      const interleavedLength = length * channels;
      console.log('[SdlAudioPlayer] Interleaving samples. Total samples:', interleavedLength);

      const interleaved = new Float32Array(interleavedLength);

      for (let i = 0; i < length; i++) {
        for (let ch = 0; ch < channels; ch++) {
          interleaved[i * channels + ch] = result.samples[ch][i];
        }
      }

      // Allocate memory in WASM (in bytes) and write safely to the current WASM buffer
      const byteLength = interleaved.byteLength;
      console.log('[SdlAudioPlayer] Attempting to malloc:', byteLength, 'bytes');

      const ptr = (this.module as any)._malloc(byteLength);
      console.log('[SdlAudioPlayer] malloc returned ptr:', ptr);

      if (!ptr || ptr === 0) {
        console.warn('[SdlAudioPlayer] WASM malloc failed (returned 0). Using ccall fallback.');
        try {
          (this.module as any).ccall('set_audio_data', null, ['array', 'number', 'number', 'number'], [interleaved, interleavedLength, channels, result.sampleRate]);
        } catch (ccErr) {
          console.error('[SdlAudioPlayer] Fallback ccall set_audio_data failed:', ccErr);
          throw ccErr;
        }
      } else {
        try {
          console.log('[SdlAudioPlayer] Accessing WASM memory buffer...');
          // Get WebAssembly memory buffer - different access patterns for different Emscripten builds
          // With pthreads and AUDIO_WORKLET, memory is typically accessed via wasmMemory.buffer
          let memoryBuffer: ArrayBuffer | null = null;
          
          if ((this.module as any).wasmMemory && (this.module as any).wasmMemory.buffer) {
            console.log('[SdlAudioPlayer] Using Module.wasmMemory.buffer');
            memoryBuffer = (this.module as any).wasmMemory.buffer;
          } else if ((this.module as any).buffer) {
            console.log('[SdlAudioPlayer] Using Module.buffer');
            memoryBuffer = (this.module as any).buffer;
          } else if ((this.module as any).HEAPU8 && (this.module as any).HEAPU8.buffer) {
            console.log('[SdlAudioPlayer] Using Module.HEAPU8.buffer');
            memoryBuffer = (this.module as any).HEAPU8.buffer;
          } else if ((this.module as any).HEAPF32 && (this.module as any).HEAPF32.buffer) {
             console.log('[SdlAudioPlayer] Using Module.HEAPF32.buffer');
            memoryBuffer = (this.module as any).HEAPF32.buffer;
          }

          if (!memoryBuffer) {
             console.error('[SdlAudioPlayer] Unable to find valid memory buffer on Module object:', this.module);
            throw new Error('Unable to access WebAssembly memory buffer');
          }

          console.log('[SdlAudioPlayer] Creating Float32Array view on memory buffer. Ptr:', ptr, 'Length:', interleavedLength);
          // Create a Float32Array view at the allocated memory location
          const destination = new Float32Array(memoryBuffer, ptr, interleavedLength);

          console.log('[SdlAudioPlayer] Copying data to WASM memory...');
          destination.set(interleaved);
          console.log('[SdlAudioPlayer] Copy successful.');

          // Send to C++ (direct call, faster and avoids writeArrayToMemory)
          console.log('[SdlAudioPlayer] Calling _set_audio_data...');
          (this.module as any)._set_audio_data(ptr, interleavedLength, channels, result.sampleRate);
          console.log('[SdlAudioPlayer] _set_audio_data returned.');

        } catch (err) {
          console.error('[SdlAudioPlayer] Failed to write audio data into WASM heap:', err, {
            ptr, 
            byteLength,
            hasWasmMemory: !!(this.module as any).wasmMemory,
            hasBuffer: !!(this.module as any).buffer,
            hasHEAPU8: !!(this.module as any).HEAPU8,
            hasHEAPF32: !!(this.module as any).HEAPF32
          });
          // Try fallback ccall if direct write fails (covers browser-specific edge cases)
          try {
            console.log('[SdlAudioPlayer] Attempting fallback ccall after error...');
            (this.module as any).ccall('set_audio_data', null, ['array', 'number', 'number', 'number'], [interleaved, interleavedLength, channels, result.sampleRate]);
          } catch (ccErr) {
            console.error('[SdlAudioPlayer] Fallback ccall set_audio_data also failed:', ccErr);
            // Free pointer and rethrow original error
            (this.module as any)._free && (this.module as any)._free(ptr);
            throw err;
          }
        } finally {
          // Free malloc'd memory (the C++ copy made its own copy into g_state.audioBuffer)
          console.log('[SdlAudioPlayer] Freeing ptr:', ptr);
          (this.module as any)._free && (this.module as any)._free(ptr);
        }
      }

      this.notifyStateChange();

    } catch (error) {
      console.error('[SdlAudioPlayer] Error loading audio in SDL player:', error);
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
