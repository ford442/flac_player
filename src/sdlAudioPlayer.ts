import { decodeAudio } from './audioDecoder';
import { PlayerState } from './audioPlayer';

// Define the Emscripten module interface
interface SdlModule {
  _init_audio(): number;
  _create_audio_buffer(length: number): number;
  _set_audio_data(length: number, channels: number, sampleRate: number): void;
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
  private dummyAudioContext: AudioContext | null = null;
  private dummyAnalyser: AnalyserNode | null = null;

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
      shim.src = '/script-processor-shim.js';
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
      script.src = '/sdl-audio.js';
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

  private onEnded?: () => void;

  setStateChangeCallback(callback: (state: PlayerState) => void): void {
    this.onStateChange = callback;
  }

  setOnEndedCallback(callback?: () => void): void {
    this.onEnded = callback;
  }

  private notifyStateChange(): void {
    if (this.onStateChange) {
      this.onStateChange(this.getState());
    }
  }

  // Poll for playback position updates and detect "ended" for SDL player
  private startPolling() {
    if (this.pollInterval) window.clearInterval(this.pollInterval);
    this.pollInterval = window.setInterval(() => {
      if (!this.module) return;
      const current = typeof (this.module as any)._get_current_time === 'function' ? (this.module as any)._get_current_time() : 0;
      if (this.isPlaying) {
        this.notifyStateChange();
        // Detect end-of-track (small tolerance)
        if (this.duration && current >= this.duration - 0.25) {
          this.isPlaying = false;
          this.notifyStateChange();
          if (this.onEnded) {
            try { this.onEnded(); } catch (err) { console.warn('onEnded handler threw', err); }
          }
        }
      }
    }, 100);
  }

  async loadAudio(arrayBuffer: ArrayBuffer, filename?: string): Promise<void> {
    console.log('[SdlAudioPlayer] loadAudio called with ArrayBuffer of size:', arrayBuffer.byteLength);
    if (!this.module || !this.isReady) {
      console.warn('[SdlAudioPlayer] Module not ready during loadAudio call.');
      if (!this.module) throw new Error('SDL Module not initialized');
    }

    this.stop();
    this.notifyStateChange();

    try {
      console.log('[SdlAudioPlayer] Decoding audio...');
      const result = await decodeAudio(arrayBuffer, undefined, filename);
      console.log('[SdlAudioPlayer] Decoded. Channels:', result.channels, 'SampleRate:', result.sampleRate, 'Duration:', result.duration);

      this.duration = result.duration;

      // Use pre-interleaved buffer from decoder
      const channels = result.channels;
      const interleaved = result.interleavedBuffer;
      const interleavedLength = interleaved.length;
      console.log('[SdlAudioPlayer] Interleaved samples ready. Total samples:', interleavedLength);

      // Allocate memory in WASM (in bytes) and write safely to the current WASM buffer
      // Let C++ allocate the memory and give us a pointer
      const ptr = (this.module as any)._create_audio_buffer(interleavedLength);
      if (!ptr) {
        throw new Error('[SdlAudioPlayer] _create_audio_buffer failed to allocate memory.');
      }

      console.log('[SdlAudioPlayer] C++ allocated buffer at ptr:', ptr);

      try {
        // Get the correct memory view
        let memoryView: Float32Array | null = null;
        if ((this.module as any).HEAPF32) {
          memoryView = (this.module as any).HEAPF32;
        } else if ((this.module as any).wasmMemory && (this.module as any).wasmMemory.buffer) {
          // Fallback for certain Emscripten versions/configs
          memoryView = new Float32Array((this.module as any).wasmMemory.buffer);
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
        (this.module as any)._set_audio_data(interleavedLength, channels, result.sampleRate);
        console.log('[SdlAudioPlayer] _set_audio_data returned.');

      } catch (err) {
        console.error('[SdlAudioPlayer] Failed to write audio data into WASM heap:', err, {
          ptr,
          interleavedLength,
          hasWasmMemory: !!(this.module as any).wasmMemory,
          hasHEAPF32: !!(this.module as any).HEAPF32
        });
        // No need to free ptr, as it's a direct pointer to a vector's data, not a malloc'd block
        throw err;
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
    // Create a dummy analyser once and reuse it to avoid creating multiple AudioContexts
    if (!this.dummyAnalyser) {
      this.dummyAudioContext = new AudioContext();
      this.dummyAnalyser = this.dummyAudioContext.createAnalyser();
    }
    return this.dummyAnalyser;
  }

  destroy(): void {
    this.stop();
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.module) {
      this.module._cleanup();
    }
    if (this.dummyAudioContext) {
      // Close the AudioContext asynchronously. Since destroy() is called from the
      // Player cleanup function when switching backends (see Player.tsx line 374),
      // and the old player instance is immediately discarded, a race condition
      // cannot occur - any new getAnalyser() calls will be from a fresh player instance.
      void this.dummyAudioContext.close();
      this.dummyAudioContext = null;
      this.dummyAnalyser = null;
    }
  }
}
