import { decodeAudio } from './audioDecoder';
import { AudioContextManager, sharedAudioContextManager } from './audio/AudioContextManager';
import { SdlPcmModule, sharedSdlPcmBridge } from './audio/SdlPcmBridge';
import { WASM_ASSETS, loadWasmScript } from './audio/wasmLoader';
import type { AudioBackend, AudioPlaybackState } from './types/audio';

// Define the Emscripten module interface for SDL2
interface Sdl2Module extends SdlPcmModule {
  _init_audio(): number;
  _set_audio_data(dataPtr: number, length: number, channels: number, sampleRate: number): void;
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
  wasmMemory?: WebAssembly.Memory;
  buffer?: ArrayBuffer;
}

declare global {
  function createSdl2AudioModule(): Promise<Sdl2Module>;
}

export class Sdl2AudioPlayer implements AudioBackend {
  private module: Sdl2Module | null = null;
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
    if (!this.isReady) throw new Error('SDL2 Module failed to initialize');
  }

  private async initializeModule() {
    console.log('[Sdl2AudioPlayer] Initializing module...');

    if (!window.createSdl2AudioModule) {
      console.log('[Sdl2AudioPlayer] Loading sdl2-audio.js...');
      await loadWasmScript(WASM_ASSETS.sdl2);
      console.log('[Sdl2AudioPlayer] sdl2-audio.js loaded.');
    }

    try {
      console.log('[Sdl2AudioPlayer] Calling createSdl2AudioModule()...');
      this.module = await window.createSdl2AudioModule();
      console.log('[Sdl2AudioPlayer] Module created.');

      if (this.destroyed) {
        this.module._cleanup();
        this.module = null;
        return;
      }

      const success = this.module._init_audio();
      if (!success) {
        console.error('[Sdl2AudioPlayer] Failed to initialize SDL audio');
      } else {
        console.log('[Sdl2AudioPlayer] SDL Audio initialized successfully.');
        this.isReady = true;
        this.module._set_volume(this.lastVolume);
        this.startPolling();
      }
    } catch (err) {
      console.error('[Sdl2AudioPlayer] Error initializing SDL module:', err);
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

  private startPolling() {
    if (this.pollInterval) window.clearInterval(this.pollInterval);
    this.pollInterval = window.setInterval(() => {
      if (!this.module) return;
      const current = this.module._get_current_time();
      if (this.isPlaying) {
        this.notifyStateChange();
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
    console.log('[Sdl2AudioPlayer] loadAudio called. Size:', arrayBuffer.byteLength);
    await this.initialize();
    if (!this.module || !this.isReady) {
      throw new Error('SDL2 Module not initialized');
    }

    this.stop();
    this.notifyStateChange();

    try {
      console.log('[Sdl2AudioPlayer] Decoding...');
      const result = await decodeAudio(arrayBuffer, undefined, filename);
      this.duration = result.duration;

      // Use pre-interleaved buffer from decoder
      const channels = result.channels;
      const interleaved = result.interleavedBuffer;

      const byteLength = interleaved.byteLength;
      const ptr = this.module._malloc(byteLength);

      if (!ptr) throw new Error('Malloc failed');

      // Access memory
      // For SDL2 AudioWorklet build, it might use WASM memory or HEAPU8
      let memoryBuffer: ArrayBufferLike | null = null;
      if (this.module.wasmMemory) memoryBuffer = this.module.wasmMemory.buffer;
      else if (this.module.buffer) memoryBuffer = this.module.buffer;
      else if (this.module.HEAPU8) memoryBuffer = this.module.HEAPU8.buffer;

      if (!memoryBuffer) throw new Error('No memory buffer');

      const destination = new Float32Array(memoryBuffer, ptr, interleaved.length);
      destination.set(interleaved);

      this.module._set_audio_data(ptr, interleaved.length, channels, result.sampleRate);

      this.module._free(ptr);

      await this.contextManager.resume();
      await sharedSdlPcmBridge.connect(this.contextManager, this.module, channels);

      this.notifyStateChange();

    } catch (error) {
      console.error('[Sdl2AudioPlayer] Error loading audio:', error);
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

  setPlaybackRate(rate: number): void { void rate; /* unsupported by SDL2 */ }

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
