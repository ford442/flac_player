import { decodeAudio } from '../../audioDecoder';
import { runHifiStreamPipeline } from '../hifiStreamPipeline';
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
  // Streaming mode: bounded feed instead of one-shot _set_audio_data.
  _start_stream(channels: number, sampleRate: number, bufferSeconds: number): number;
  /** Returns samples accepted; a short return means "ring full, retry". */
  _feed_pcm_chunk(dataPtr: number, samples: number): number;
  _get_buffer_fill_level(): number;
  _set_stream_ended(ended: number): void;
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
  private streaming = false;
  private streamAbort: AbortController | null = null;
  /** Reused staging buffer in WASM heap for handing PCM to _feed_pcm_chunk. */
  private feedPtr = 0;
  private feedCapacity = 0;
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

    this.streamAbort?.abort();
    this.streaming = false;
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

      // Let the shared graph match the source rate before we wire anything up.
      this.contextManager.configure({ sampleRate: result.sampleRate });

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
    if (this.streaming) {
      // Only a few seconds of audio are resident; seeking would mean restarting
      // the decode pipeline at a new byte offset. Matches AudioWorkletPlayer.
      console.warn(`[${this.label}] Seek not supported in streaming mode`);
      return;
    }
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

  /** Back-pressure threshold: stop feeding above this fill percentage. */
  private static readonly HIGH_WATER_PERCENT = 75;

  /** Grow the WASM-side staging buffer to hold at least `samples` floats. */
  private ensureFeedBuffer(module: TModule, samples: number): number {
    if (this.feedCapacity >= samples && this.feedPtr) return this.feedPtr;
    if (this.feedPtr) module._free(this.feedPtr);
    this.feedPtr = module._malloc(samples * 4);
    this.feedCapacity = this.feedPtr ? samples : 0;
    if (!this.feedPtr) throw new Error(`${this.label}: failed to allocate feed buffer`);
    return this.feedPtr;
  }

  private heapFloats(module: TModule): Float32Array | null {
    if (module.HEAPF32) return module.HEAPF32;
    if (module.wasmMemory?.buffer) return new Float32Array(module.wasmMemory.buffer);
    return null;
  }

  /** Resolves once the ring has drained below the high-water mark. */
  private async waitForCapacity(module: TModule): Promise<void> {
    while (module._get_buffer_fill_level() >= BaseSdlBackend.HIGH_WATER_PERCENT) {
      if (this.streamAbort?.signal.aborted) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  /**
   * Push one decoded chunk into the WASM ring, retrying the remainder when the
   * ring reports a short write. Copies through a reusable staging buffer, so
   * peak memory stays bounded regardless of track length.
   */
  private async feedChunk(module: TModule, interleaved: Float32Array): Promise<void> {
    let offset = 0;
    while (offset < interleaved.length) {
      if (this.streamAbort?.signal.aborted) return;

      const remaining = interleaved.subarray(offset);
      const ptr = this.ensureFeedBuffer(module, remaining.length);
      const heap = this.heapFloats(module);
      if (!heap) throw new Error(`${this.label}: cannot access WASM heap`);
      heap.set(remaining, ptr / 4);

      const accepted = module._feed_pcm_chunk(ptr, remaining.length);
      if (accepted <= 0) {
        await this.waitForCapacity(module);
        continue;
      }
      offset += accepted;
    }
  }

  /**
   * Stream a FLAC URL straight into the SDL device without ever holding the
   * whole decoded track in memory.
   */
  async loadFromURLStreaming(
    url: string,
    options: { expectedDuration?: number; cachedResponse?: Response } = {}
  ): Promise<void> {
    await this.initialize();
    const module = this.module;
    if (!module) throw new Error(`${this.label} module not initialized`);

    this.stop();
    this.streamAbort?.abort();
    const abort = new AbortController();
    this.streamAbort = abort;
    this.streaming = true;
    this.duration = options.expectedDuration ?? 0;

    let started = false;

    await new Promise<void>((resolve, reject) => {
      void runHifiStreamPipeline({
        url,
        cachedResponse: options.cachedResponse,
        expectedDuration: options.expectedDuration,
        signal: abort.signal,
        onMetadata: ({ channels, sampleRate }) => {
          if (started) return;
          started = true;
          this.contextManager.configure({ sampleRate });
          if (!module._start_stream(channels, sampleRate, 8)) {
            reject(new Error(`${this.label}: start_stream failed`));
            return;
          }
          void this.contextManager.resume();
          void sharedSdlPcmBridge.connect(this.contextManager, module, channels);
          // Enough audio is buffered to begin; the ring keeps filling behind us.
          resolve();
        },
        onPcmChunk: (interleaved) => {
          // Copy immediately: the pipeline reuses its decode buffer.
          void this.feedChunk(module, new Float32Array(interleaved));
        },
        waitForCapacity: () => this.waitForCapacity(module),
        onEnded: () => {
          module._set_stream_ended(1);
          if (!started) resolve();
        },
        onError: (err) => {
          module._set_stream_ended(1);
          if (!started) reject(err);
          else console.error(`[${this.label}] stream error:`, err);
        },
      });
    });

    this.notifyStateChange();
  }

  destroy(): void {
    this.destroyed = true;
    this.streamAbort?.abort();
    if (this.feedPtr && this.module) {
      this.module._free(this.feedPtr);
      this.feedPtr = 0;
      this.feedCapacity = 0;
    }
    this.stop();
    sharedSdlPcmBridge.disconnect(this.contextManager);
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.module) {
      this.module._cleanup();
    }
  }
}
