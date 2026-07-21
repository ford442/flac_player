import { decodeAudio } from '../../audioDecoder';
import { SdlPcmModule, sharedSdlPcmBridge } from '../SdlPcmBridge';
import type { AudioPlaybackState } from '../../types/audio';
import { BaseAudioBackend } from './BaseAudioBackend';

/**
 * The Emscripten exports common to the SDL3 and SDL2 builds.
 *
 * `_set_audio_data` is intentionally absent: SDL3 has the module allocate the
 * buffer and takes (length, channels, sampleRate), while SDL2 takes a caller
 * malloc'd pointer. That difference is what `writeAudioData()` abstracts over.
 */
export interface SdlCommonModule extends SdlPcmModule {
  _init_audio(): number;
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

/**
 * Shared implementation of the SDL3 and SDL2 backends, which differ only in how
 * their WASM module is loaded and how decoded PCM is written into the heap.
 *
 * Subclasses must stay in their own module files — webpack's splitChunks cache
 * groups match on `sdlAudioPlayer.ts` / `sdl2AudioPlayer.ts` to lazy-load the
 * SDL WASM chunks.
 */
export abstract class BaseSdlBackend<TModule extends SdlCommonModule> extends BaseAudioBackend {
  protected module: TModule | null = null;
  private isReady = false;
  private isPlaying = false;
  private duration = 0;
  private pollInterval: number | null = null;
  private lastVolume = 1.0;
  // Assigned by startInitialization(), which subclasses call from their constructor
  // (it cannot run in this constructor: the abstract `label`/`loadModule` members
  // are not initialized until the subclass constructor body runs).
  private initialization!: Promise<void>;
  private destroyed = false;

  /** Log prefix and error label, e.g. "SdlAudioPlayer" / "SDL". */
  protected abstract readonly label: string;

  /** Load the WASM script (if needed) and instantiate the Emscripten module. */
  protected abstract loadModule(): Promise<TModule>;

  /** Copy interleaved PCM into the module's heap and hand it to the SDL device. */
  protected abstract writeAudioData(
    module: TModule,
    interleaved: Float32Array,
    channels: number,
    sampleRate: number
  ): void;

  protected startInitialization(): void {
    this.initialization = this.initializeModule();
  }

  async initialize(): Promise<void> {
    await this.initialization;
    if (!this.isReady) throw new Error(`${this.label} module failed to initialize`);
  }

  private async initializeModule(): Promise<void> {
    console.log(`[${this.label}] Initializing module...`);
    try {
      this.module = await this.loadModule();
      console.log(`[${this.label}] Module created.`);

      if (this.destroyed) {
        this.module._cleanup();
        this.module = null;
        return;
      }

      const success = this.module._init_audio();
      if (!success) {
        console.error(`[${this.label}] Failed to initialize SDL audio (init_audio returned 0)`);
      } else {
        console.log(`[${this.label}] SDL Audio initialized successfully.`);
        this.isReady = true;
        this.module._set_volume(this.lastVolume);
        this.startPolling();
      }
    } catch (err) {
      console.error(`[${this.label}] Error initializing SDL module:`, err);
    }
  }

  // Poll for playback position updates and detect "ended".
  private startPolling(): void {
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
          this.notifyEnded();
        }
      }
    }, 100);
  }

  async loadAudio(arrayBuffer: ArrayBuffer, filename?: string): Promise<void> {
    console.log(`[${this.label}] loadAudio called. Size:`, arrayBuffer.byteLength);
    await this.initialize();
    if (!this.module || !this.isReady) {
      throw new Error(`${this.label} module not initialized`);
    }

    this.stop();
    this.notifyStateChange();

    try {
      console.log(`[${this.label}] Decoding...`);
      const result = await decodeAudio(arrayBuffer, undefined, filename);
      console.log(
        `[${this.label}] Decoded. Channels:`, result.channels,
        'SampleRate:', result.sampleRate,
        'Duration:', result.duration
      );

      this.duration = result.duration;

      // Use pre-interleaved buffer from decoder
      const channels = result.channels;
      this.writeAudioData(this.module, result.interleavedBuffer, channels, result.sampleRate);

      await this.contextManager.resume();
      await sharedSdlPcmBridge.connect(this.contextManager, this.module, channels);

      this.notifyStateChange();
    } catch (error) {
      console.error(`[${this.label}] Error loading audio:`, error);
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
  // exposes no playback-rate hook. EQ is kept in the shared graph (see
  // BaseAudioBackend.setEQGains) so it survives switching back to a Web Audio backend.
  setPlaybackRate(rate: number): void { void rate; /* unsupported by SDL */ }

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
