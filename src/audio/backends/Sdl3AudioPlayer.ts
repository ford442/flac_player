import { decodeAudio } from '../../audioDecoder';
import { AudioContextManager, sharedAudioContextManager } from '../AudioContextManager';
import { DEFAULT_EQ_BANDS } from '../EQChain';
import { SdlPcmModule, sharedSdlPcmBridge } from '../SdlPcmBridge';
import { WASM_ASSETS, loadWasmScript } from '../wasmLoader';
import type { AudioPlaybackState, DecodedPcmView } from '../../types/audio';
import { BaseAudioBackend } from './BaseAudioBackend';
import { runHifiStreamPipeline } from '../hifiStreamPipeline';
import { describePlaybackPath, type PlaybackPathInfo } from '../../utils/playbackPath';
import { playRingShouldPause } from '../playRingBackpressure';

interface SdlModule extends SdlPcmModule {
  _init_audio(): number;
  _create_audio_buffer(length: number): number;
  _set_audio_data(length: number, channels: number, sampleRate: number): number;
  _set_stream_format(channels: number, sampleRate: number): number;
  _push_pcm(ptr: number, count: number): number;
  _get_play_ring_fill(): number;
  _get_play_ring_capacity(): number;
  _set_stream_ended(ended: number): void;
  _play(): void;
  _pause_audio(): void;
  _resume_audio(): void;
  _stop(): void;
  _seek(time: number): void;
  _get_current_time(): number;
  _set_volume(volume: number): void;
  /** Speaker DSP (dsp_chain.h). Optional so an older prebuilt WASM still loads. */
  _set_eq_band?(index: number, type: number, frequency: number, q: number, gainDb: number): void;
  _set_replaygain?(linear: number, limiterEnabled: number): void;
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
  function createSdlAudioModule(): Promise<SdlModule>;
  interface Window {
    __sdl_script_processor_shim_loaded?: boolean;
  }
}

const EQ_TYPE_CODES: Partial<Record<BiquadFilterType, number>> = {
  lowshelf: 0,
  peaking: 1,
  highshelf: 2,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Sdl3AudioPlayer extends BaseAudioBackend {
  private module: SdlModule | null = null;
  private isReady: boolean = false;
  private isPlaying: boolean = false;
  private duration: number = 0;
  private pollInterval: number | null = null;
  private initialization: Promise<void>;
  private decodedPcm: Float32Array | null = null;
  private decodedChannels = 1;
  private decodedSampleRate = 0;
  private isStreaming = false;
  private streamDecodeEnded = false;
  private endedNotified = false;
  private playbackPath: PlaybackPathInfo | null = null;
  private streamAbort: AbortController | null = null;
  private pipelineTask: Promise<void> | null = null;
  private limiterEnabled = false;

  constructor(private contextManager: AudioContextManager = sharedAudioContextManager) {
    super();
    this.initialization = this.initializeModule();
  }

  async initialize(): Promise<void> {
    await this.initialization;
    if (!this.isReady) throw new Error('SDL Module failed to initialize');
  }

  getPlaybackPath(): PlaybackPathInfo | null {
    return this.playbackPath;
  }

  private async initializeModule() {
    console.log('[SdlAudioPlayer] Initializing module...');
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
        this.applyNativeEq(this.contextManager.getEQGains());
        this.applyNativeReplayGain();
        this.setVolume(this.lastVolume);
        this.startPolling();
      }
    } catch (err) {
      console.error('[SdlAudioPlayer] Error initializing SDL module:', err);
    }
  }

  private startPolling() {
    if (this.pollInterval) window.clearInterval(this.pollInterval);
    this.pollInterval = window.setInterval(() => {
      if (!this.module) return;
      const current = this.module._get_current_time();
      if (this.isPlaying) {
        this.notifyStateChange();
        if (this.endedNotified) return;
        const streamDrained = this.isStreaming
          && this.streamDecodeEnded
          && this.module._get_play_ring_fill() === 0;
        const bufferedEnded = !this.isStreaming
          && this.duration > 0
          && current >= this.duration - 0.25;
        if (streamDrained || bufferedEnded) {
          this.endedNotified = true;
          this.isPlaying = false;
          this.notifyStateChange();
          if (this.onEndedCallback) {
            try { this.onEndedCallback(); } catch (err) { console.warn('onEnded handler threw', err); }
          }
        }
      }
    }, 100);
  }

  private cancelStream(): void {
    this.streamAbort?.abort();
    this.streamAbort = null;
    this.pipelineTask = null;
  }

  private heapF32(): Float32Array {
    if (!this.module) throw new Error('SDL module not ready');
    if (this.module.HEAPF32) return this.module.HEAPF32;
    if (this.module.wasmMemory?.buffer) {
      return new Float32Array(this.module.wasmMemory.buffer);
    }
    throw new Error('Unable to access WebAssembly HEAPF32 memory view.');
  }

  private async pushPcmWithBackpressure(interleaved: Float32Array): Promise<void> {
    const module = this.module;
    if (!module) return;
    let offset = 0;
    while (offset < interleaved.length) {
      if (this.streamAbort?.signal.aborted || this.destroyed) return;
      const cap = module._get_play_ring_capacity();
      const fill = module._get_play_ring_fill();
      if (playRingShouldPause(fill, cap) || cap - fill <= 0) {
        await sleep(8);
        continue;
      }
      const n = Math.min(interleaved.length - offset, cap - fill);
      const ptr = module._malloc(n * 4);
      if (!ptr) {
        await sleep(8);
        continue;
      }
      try {
        this.heapF32().set(interleaved.subarray(offset, offset + n), ptr / 4);
        const written = module._push_pcm(ptr, n);
        if (written <= 0) {
          await sleep(8);
          continue;
        }
        offset += written;
      } finally {
        module._free(ptr);
      }
    }
  }

  async loadAudio(arrayBuffer: ArrayBuffer, filename?: string): Promise<void> {
    console.log('[SdlAudioPlayer] loadAudio called with ArrayBuffer of size:', arrayBuffer.byteLength);
    await this.initialize();
    if (!this.module || !this.isReady) {
      console.warn('[SdlAudioPlayer] Module not ready during loadAudio call.');
      if (!this.module) throw new Error('SDL Module not initialized');
    }

    this.cancelStream();
    this.isStreaming = false;
    this.streamDecodeEnded = false;
    this.endedNotified = false;
    this.playbackPath = describePlaybackPath('buffered');
    this.stop();
    this.notifyStateChange();

    try {
      console.log('[SdlAudioPlayer] Decoding audio...');
      const result = await decodeAudio(arrayBuffer, undefined, filename);
      console.log('[SdlAudioPlayer] Decoded. Channels:', result.channels, 'SampleRate:', result.sampleRate, 'Duration:', result.duration);

      this.duration = result.duration;

      const channels = result.channels;
      const interleaved = result.interleavedBuffer;
      const interleavedLength = interleaved.length;
      this.decodedPcm = interleaved;
      this.decodedChannels = channels;
      this.decodedSampleRate = result.sampleRate;

      const ptr = this.module._create_audio_buffer(interleavedLength);
      if (!ptr) {
        throw new Error('[SdlAudioPlayer] _create_audio_buffer failed to allocate memory.');
      }

      try {
        const floatIndex = ptr / 4;
        this.heapF32().set(interleaved, floatIndex);
        const configured = this.module._set_audio_data(interleavedLength, channels, result.sampleRate);
        if (configured !== 1) {
          throw new Error('SDL stream configure failed (set_audio_data)');
        }

        await this.contextManager.ensureForTrack({
          sampleRate: result.sampleRate,
          channels: channels,
        });
        await this.contextManager.resume();
        await sharedSdlPcmBridge.connect(this.contextManager, this.module, channels);
      } catch (err) {
        console.error('[SdlAudioPlayer] Failed to write audio data into WASM heap:', err, {
          ptr,
          interleavedLength,
          hasWasmMemory: !!this.module.wasmMemory,
          hasHEAPF32: !!this.module.HEAPF32
        });
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

  async loadFromURLStreaming(
    url: string,
    options: {
      expectedDuration?: number;
      cachedResponse?: Response;
      onProgress?: (loaded: number, total: number | null) => void;
    } = {}
  ): Promise<void> {
    await this.initialize();
    if (!this.module || !this.isReady) {
      throw new Error('SDL Module not initialized');
    }

    this.cancelStream();
    this.stop();
    this.isPlaying = false;
    this.isStreaming = true;
    this.streamDecodeEnded = false;
    this.endedNotified = false;
    this.decodedPcm = null;
    this.duration = options.expectedDuration ?? 0;
    this.playbackPath = describePlaybackPath('hifi-stream');
    this.streamAbort = new AbortController();

    let finishResolve!: () => void;
    let finishReject!: (err: unknown) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      finishResolve = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      finishReject = (err: unknown) => {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      setTimeout(() => {
        finishReject(new Error('SDL streaming playback did not start in time'));
      }, 30_000);
    });

    const pipeline = runHifiStreamPipeline({
      url,
      cachedResponse: options.cachedResponse,
      expectedDuration: options.expectedDuration,
      signal: this.streamAbort.signal,
      onProgress: (p) => options.onProgress?.(p.loaded, p.total),
      onMetadata: async ({ channels, sampleRate }) => {
        if (!this.module) return;
        this.decodedChannels = channels;
        this.decodedSampleRate = sampleRate;
        const configured = this.module._set_stream_format(channels, sampleRate);
        if (configured !== 1) {
          throw new Error('SDL stream configure failed (set_stream_format)');
        }
        await this.contextManager.ensureForTrack({ sampleRate, channels });
        await this.contextManager.resume();
        await sharedSdlPcmBridge.connect(this.contextManager, this.module, channels);
        this.module._play();
        this.isPlaying = true;
        this.notifyStateChange();
        finishResolve();
      },
      onPcmChunk: (interleaved) => this.pushPcmWithBackpressure(interleaved),
      onEnded: () => {
        this.streamDecodeEnded = true;
        this.module?._set_stream_ended(1);
      },
      onError: (err) => {
        console.error('[SdlAudioPlayer] Stream error:', err);
        finishReject(err);
      },
    });

    this.pipelineTask = pipeline;
    pipeline.catch(finishReject);
    await readyPromise;
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
    this.cancelStream();
    if (!this.module) return;
    this.module._stop();
    sharedSdlPcmBridge.resetRing(this.module);
    this.isPlaying = false;
    this.notifyStateChange();
  }

  seek(time: number): void {
    if (!this.module) return;
    if (this.isStreaming) {
      console.warn('[SdlAudioPlayer] Seek not supported in streaming mode');
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
    this.setVolumeBase(volume, (effective) => {
      if (this.module) {
        this.module._set_volume(effective);
      }
    });
  }

  setPlaybackRate(rate: number): void { void rate; }

  /** WASM runs EQ / ReplayGain / limiter on the speaker path (dsp_chain.h). */
  private hasNativeDsp(): boolean {
    return typeof this.module?._set_eq_band === 'function'
      && typeof this.module?._set_replaygain === 'function';
  }

  /** Legacy WASM without DSP exports: fold ReplayGain into `_set_volume` (clamps at 1). */
  protected effectiveVolume(volume: number): number {
    return this.hasNativeDsp() ? volume : super.effectiveVolume(volume);
  }

  private applyNativeEq(gains: number[]): void {
    if (!this.module || !this.hasNativeDsp()) return;
    DEFAULT_EQ_BANDS.forEach((band, i) => {
      this.module!._set_eq_band!(i, EQ_TYPE_CODES[band.type] ?? 1, band.frequency, band.Q, gains[i] ?? 0);
    });
  }

  private applyNativeReplayGain(): void {
    if (!this.module || !this.hasNativeDsp()) return;
    this.module._set_replaygain!(this.replayGainLinear, this.limiterEnabled ? 1 : 0);
  }

  // The shared graph keeps the values (speakers are muted while SDL plays, and the
  // viz tap bypasses its EQ), so a later switch to a Web Audio backend applies them once.
  setEQGains(gains: number[]): void {
    this.contextManager.setEQGains(gains);
    this.applyNativeEq(this.contextManager.getEQGains());
  }

  setReplayGainLinear(linear: number): void {
    this.applyReplayGainLinear(linear, () => this.setVolume(this.lastVolume));
    this.contextManager.setReplayGainLinear(this.replayGainLinear);
    this.applyNativeReplayGain();
  }

  setReplayGainLimiter(enabled: boolean): void {
    this.limiterEnabled = enabled;
    this.contextManager.setReplayGainLimiter(enabled);
    this.applyNativeReplayGain();
  }

  getAnalyser(): AnalyserNode | null {
    return this.contextManager.getAnalyser();
  }

  getDecodedPcm(): DecodedPcmView | null {
    if (!this.decodedPcm || this.isStreaming) return null;
    return {
      pcm: this.decodedPcm,
      channels: this.decodedChannels,
      sampleRate: this.decodedSampleRate,
    };
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
