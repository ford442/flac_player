import { decodeAudio } from './audioDecoder';
import { AudioContextManager, sharedAudioContextManager } from './audio/AudioContextManager';
import { SdlPcmModule, sharedSdlPcmBridge } from './audio/SdlPcmBridge';
import { WASM_ASSETS, loadWasmScript } from './audio/wasmLoader';
import type { AudioBackend, AudioPlaybackState } from './types/audio';

// Define the Emscripten module interface
interface SdlModule extends SdlPcmModule {
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
  _get_pcm_ring_state(): number;
  _get_pcm_ring_data(): number;
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
  interface Window {
    __sdl_script_processor_shim_loaded?: boolean;
  }
}

export class SdlAudioPlayer implements AudioBackend {
  private module: SdlModule | null = null;
  private isReady: boolean = false;
  private isPlaying: boolean = false;
  private duration: number = 0;
  private onStateChange?: (state: AudioPlaybackState) => void;
  private pollInterval: number | null = null;
  private lastVolume: number = 1.0;
  private initialization: Promise<void>;
  private destroyed = false;

  constructor(private contextManager: AudioContextManager = sharedAudioContextManager) {
    this.initialization = this.initializeModule();
  }

  async initialize(): Promise<void> {
    await this.initialization;
    if (!this.isReady) throw new Error('SDL Module failed to initialize');
  }

  private async initializeModule() {
    console.log('[SdlAudioPlayer] Initializing module...');
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

    try {
      console.log('[SdlAudioPlayer] Calling createSdlAudioModule()...');
      this.module = await window.createSdlAudioModule();
      console.log('[SdlAudioPlayer] Module created. Inspecting keys:', Object.keys(this.module));
      console.log('[SdlAudioPlayer] Module.wasmMemory:', this.module.wasmMemory);
      console.log('[SdlAudioPlayer] Module.buffer:', this.module.buffer);
      console.log('[SdlAudioPlayer] Module.HEAPU8:', this.module.HEAPU8);

      if (this.destroyed) {
        this.module._cleanup();
        this.module = null;
        return;
      }

      const success = this.module._init_audio();
      if (!success) {
        console.error('[SdlAudioPlayer] Failed to initialize SDL audio (init_audio returned 0)');
      } else {
        console.log('[SdlAudioPlayer] SDL Audio initialized successfully.');
        this.isReady = true;
        this.module._set_volume(this.lastVolume);
        this.startPolling();
      }
    } catch (err) {
      console.error('[SdlAudioPlayer] Error initializing SDL module:', err);
    }
  }

  private onEnded?: () => void;

  setStateChangeCallback(callback: (state: AudioPlaybackState) => void): void {
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
      const current = this.module._get_current_time();
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
    await this.initialize();
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
      const ptr = this.module._create_audio_buffer(interleavedLength);
      if (!ptr) {
        throw new Error('[SdlAudioPlayer] _create_audio_buffer failed to allocate memory.');
      }

      console.log('[SdlAudioPlayer] C++ allocated buffer at ptr:', ptr);

      try {
        // Get the correct memory view
        let memoryView: Float32Array | null = null;
        if (this.module.HEAPF32) {
          memoryView = this.module.HEAPF32;
        } else if (this.module.wasmMemory?.buffer) {
          // Fallback for certain Emscripten versions/configs
          memoryView = new Float32Array(this.module.wasmMemory.buffer);
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
        this.module._set_audio_data(interleavedLength, channels, result.sampleRate);
        console.log('[SdlAudioPlayer] _set_audio_data returned.');

        await this.contextManager.resume();
        await sharedSdlPcmBridge.connect(this.contextManager, this.module, channels);

      } catch (err) {
        console.error('[SdlAudioPlayer] Failed to write audio data into WASM heap:', err, {
          ptr,
          interleavedLength,
          hasWasmMemory: !!this.module.wasmMemory,
          hasHEAPF32: !!this.module.HEAPF32
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

  loadFromArrayBuffer(arrayBuffer: ArrayBuffer, filename?: string): Promise<void> {
    return this.loadAudio(arrayBuffer, filename);
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
    sharedSdlPcmBridge.resetRing(this.module);
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

  getState(): AudioPlaybackState {
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

  // SDL's Emscripten device is isolated from the Web Audio graph and currently
  // exposes no playback-rate or EQ hooks. Keep the settings in the shared graph
  // so they survive switching back to a Web Audio backend.
  setPlaybackRate(rate: number): void { void rate; /* unsupported by SDL */ }

  setEQGains(gains: number[]): void {
    this.contextManager.setEQGains(gains);
  }

  getAnalyser(): AnalyserNode {
    return this.contextManager.getAnalyser();
  }

  destroy(): void {
    this.destroyed = true;
    this.stop();
    sharedSdlPcmBridge.disconnect(this.contextManager);
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.module) {
      this.module._cleanup();
    }
  }
}
