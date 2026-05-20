import { decodeAudio } from './audioDecoder';
import { PlayerState } from './audioPlayer';

// Define the Emscripten module interface for SDL2
interface Sdl2Module {
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
  wasmMemory?: WebAssembly.Memory;
  buffer?: ArrayBuffer;
}

declare global {
  function createSdl2AudioModule(): Promise<Sdl2Module>;
}

export class Sdl2AudioPlayer {
  private module: Sdl2Module | null = null;
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
    console.log('[Sdl2AudioPlayer] Initializing module...');

    // Load sdl2-audio.js
    if (!window.createSdl2AudioModule) {
      console.log('[Sdl2AudioPlayer] Loading sdl2-audio.js...');
      const script = document.createElement('script');
      script.src = '/sdl2-audio.js';
      script.async = true;
      document.body.appendChild(script);

      await new Promise<void>((resolve, reject) => {
        script.onload = () => {
          console.log('[Sdl2AudioPlayer] sdl2-audio.js loaded.');
          resolve();
        };
        script.onerror = () => reject(new Error('Failed to load sdl2-audio.js'));
      });
    }

    try {
      console.log('[Sdl2AudioPlayer] Calling createSdl2AudioModule()...');
      this.module = await window.createSdl2AudioModule();
      console.log('[Sdl2AudioPlayer] Module created.');

      const success = this.module._init_audio();
      if (!success) {
        console.error('[Sdl2AudioPlayer] Failed to initialize SDL audio');
      } else {
        console.log('[Sdl2AudioPlayer] SDL Audio initialized successfully.');
        this.isReady = true;
        this.startPolling();
      }
    } catch (err) {
      console.error('[Sdl2AudioPlayer] Error initializing SDL module:', err);
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

  private startPolling() {
    if (this.pollInterval) window.clearInterval(this.pollInterval);
    this.pollInterval = window.setInterval(() => {
      if (!this.module) return;
      const current = typeof (this.module as any)._get_current_time === 'function' ? (this.module as any)._get_current_time() : 0;
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
      const ptr = (this.module as any)._malloc(byteLength);

      if (!ptr) throw new Error('Malloc failed');

      // Access memory
      // For SDL2 AudioWorklet build, it might use WASM memory or HEAPU8
      let memoryBuffer: any = null;
      if (this.module.wasmMemory) memoryBuffer = this.module.wasmMemory.buffer;
      else if (this.module.buffer) memoryBuffer = this.module.buffer;
      else if (this.module.HEAPU8) memoryBuffer = this.module.HEAPU8.buffer;

      if (!memoryBuffer) throw new Error('No memory buffer');

      const destination = new Float32Array(memoryBuffer, ptr, interleaved.length);
      destination.set(interleaved);

      this.module._set_audio_data(ptr, interleaved.length, channels, result.sampleRate);

      this.module._free(ptr);
      this.notifyStateChange();

    } catch (error) {
      console.error('[Sdl2AudioPlayer] Error loading audio:', error);
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
    // Return dummy - create once and reuse to avoid multiple AudioContexts
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
      this.dummyAudioContext.close();
      this.dummyAudioContext = null;
      this.dummyAnalyser = null;
    }
  }
}
