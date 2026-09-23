import { decodeAudio } from '../../audioDecoder';
import { AudioContextManager, sharedAudioContextManager } from '../AudioContextManager';
import { DEFAULT_EQ_BANDS } from '../EQChain';
import { SdlPcmModule, sharedSdlPcmBridge } from '../SdlPcmBridge';
import { WASM_ASSETS, loadWasmScript } from '../wasmLoader';
import type { AudioBackendCapabilities, AudioPlaybackState, DecodedPcmView } from '../../types/audio';
import { isGaplessActive, DEFAULT_CROSSFADE_MS, DEFAULT_GAPLESS_MODE, type GaplessSettings, type PreloadNextOptions } from '../../types/gapless';
import { BaseAudioBackend } from './BaseAudioBackend';
import { HifiStreamSession, type HifiTrackSource } from '../hifiStreamPipeline';
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
  /** Stream-mode ring reset (audio_engine.cpp). Optional so an older prebuilt WASM still loads. */
  _seek_stream?(seconds: number): number;
  /** SDL_SetAudioStreamFrequencyRatio, clamped 0.25..4 in C++. */
  _set_playback_rate?(ratio: number): number;
  _get_device_format?(freqPtr: number, channelsPtr: number): number;
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
  private session: HifiStreamSession | null = null;
  /**
   * Interleaved samples pushed into the play ring, on the C++ playHead scale
   * (seek_stream sets playHead = floor(t × rate) × channels; push adds count).
   */
  private pushedAbs = 0;
  /** Gapless splice points on the playHead scale, in ring order. */
  private boundaries: Array<{ abs: number; duration: number | null }> = [];
  /** Media time (C++ clock) at which the audible track began. */
  private segmentOffset = 0;
  private gaplessSettings: GaplessSettings = { mode: DEFAULT_GAPLESS_MODE, crossfadeMs: DEFAULT_CROSSFADE_MS };
  private nextSource: HifiTrackSource | null = null;
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
        this.module._set_playback_rate?.(this.playbackRate);
        this.logDeviceFormat();
        this.startPolling();
      }
    } catch (err) {
      console.error('[SdlAudioPlayer] Error initializing SDL module:', err);
    }
  }

  private logDeviceFormat(): void {
    const m = this.module;
    if (!m?._get_device_format) return;
    const ptr = m._malloc(8);
    try {
      if (m._get_device_format(ptr, ptr + 4) === 1) {
        const heap = new Int32Array(this.heapF32().buffer, ptr, 2);
        console.log(`[SdlAudioPlayer] SDL device format: ${heap[0]} Hz, ${heap[1]} ch (streams at file rate; SDL resamples on bind)`);
      }
    } finally {
      m._free(ptr);
    }
  }

  private startPolling() {
    if (this.pollInterval) window.clearInterval(this.pollInterval);
    this.pollInterval = window.setInterval(() => {
      if (!this.module) return;
      const current = this.module._get_current_time();
      if (this.isStreaming) this.checkBoundaries(current);
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
    this.session?.cancel();
    this.session = null;
    this.boundaries = [];
    this.segmentOffset = 0;
    this.pushedAbs = 0;
  }

  /**
   * Gapless: once the audible clock passes a splice point, the next track is
   * playing. Audio is already continuous; this only moves the UI clock (100 ms poll).
   */
  private checkBoundaries(current: number): void {
    const frameSamples = this.decodedSampleRate * this.decodedChannels;
    if (frameSamples <= 0) return;
    while (this.boundaries.length > 0 && current * frameSamples >= this.boundaries[0].abs) {
      const b = this.boundaries.shift()!;
      this.segmentOffset = b.abs / frameSamples;
      this.duration = b.duration ?? 0;
      this.session?.crossBoundary();
      this.notifyStateChange();
      if (this.onEndedCallback) {
        try { this.onEndedCallback({ alreadyPlayingNext: true }); } catch (err) { console.warn('onEnded handler threw', err); }
      }
    }
  }

  private heapF32(): Float32Array {
    if (!this.module) throw new Error('SDL module not ready');
    if (this.module.HEAPF32) return this.module.HEAPF32;
    if (this.module.wasmMemory?.buffer) {
      return new Float32Array(this.module.wasmMemory.buffer);
    }
    throw new Error('Unable to access WebAssembly HEAPF32 memory view.');
  }

  /**
   * `signal` belongs to one decode run: after a seek aborts it, this loop exits
   * at its next check even if it was waiting on a full ring (no deadlock).
   */
  private async pushPcmWithBackpressure(interleaved: Float32Array, signal: AbortSignal): Promise<void> {
    const module = this.module;
    if (!module) return;
    let offset = 0;
    while (offset < interleaved.length) {
      if (signal.aborted || this.destroyed) return;
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
        this.pushedAbs += written;
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

    const session = new HifiStreamSession({
      onFormat: async ({ channels, sampleRate }) => {
        if (!this.module) return;
        this.decodedChannels = channels;
        this.decodedSampleRate = sampleRate;
        const configured = this.module._set_stream_format(channels, sampleRate);
        if (configured !== 1) {
          throw new Error('SDL stream configure failed (set_stream_format)');
        }
        this.pushedAbs = 0;
        this.duration = (await session.audibleDuration) ?? options.expectedDuration ?? 0;
        await this.contextManager.ensureForTrack({ sampleRate, channels });
        await this.contextManager.resume();
        await sharedSdlPcmBridge.connect(this.contextManager, this.module, channels);
        this.module._play();
        this.isPlaying = true;
        this.notifyStateChange();
      },
      pushPcm: (pcm, signal) => this.pushPcmWithBackpressure(pcm, signal),
      onSplice: ({ duration }) => {
        this.boundaries.push({ abs: this.pushedAbs, duration });
      },
      onDecodeEnded: () => {
        this.streamDecodeEnded = true;
        this.module?._set_stream_ended(1);
      },
      onError: (err) => console.error('[SdlAudioPlayer] Stream error:', err),
    });
    this.session = session;
    if (this.nextSource?.url === url) this.nextSource = null;
    session.setNext(this.nextSource);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('SDL streaming playback did not start in time')), 30_000);
    });
    try {
      await Promise.race([
        session.load(
          { url, cachedResponse: options.cachedResponse, expectedDuration: options.expectedDuration },
          { onProgress: (p) => options.onProgress?.(p.loaded, p.total) }
        ),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  setGaplessSettings(settings: GaplessSettings): void {
    this.gaplessSettings = settings;
    if (!isGaplessActive(settings)) this.clearPreload();
  }

  setCrossfadeEnabled(enabled: boolean): void {
    this.setGaplessSettings({ mode: enabled ? 'crossfade' : 'off', crossfadeMs: this.gaplessSettings.crossfadeMs });
  }

  /**
   * Hi-fi streams only: the successor is decoded straight into the play ring
   * after the current track (same rate/channels). Buffered SDL has no queue.
   */
  preloadNext(options: PreloadNextOptions | string): void {
    if (!isGaplessActive(this.gaplessSettings)) return;
    const { url, duration } = typeof options === 'string' ? { url: options, duration: undefined } : options;
    this.nextSource = { url, expectedDuration: duration };
    if (this.isStreaming) this.session?.setNext(this.nextSource);
  }

  clearPreload(): void {
    this.nextSource = null;
    this.session?.setNext(null);
  }

  play(): void {
    if (!this.module) return;
    if (this.isStreaming && this.endedNotified) {
      // Ring drained at end of stream: restart from the top.
      this.seek(0);
    }
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
      this.seekStream(time);
      return;
    }
    this.module._seek(time);
    this.notifyStateChange();
  }

  /**
   * Hi-fi stream seek: C++ resets the play/viz rings and DSP under the stream
   * lock and moves the clock to `time` (seek_stream); the session aborts the
   * current decode (its push loop exits even when parked on a full ring) and
   * restarts at the target frame. The shared AudioContext is never suspended.
   */
  private seekStream(time: number): void {
    const module = this.module;
    if (!module || !this.session?.isActive) return;
    if (typeof module._seek_stream !== 'function') {
      console.warn('[SdlAudioPlayer] Seek not supported in streaming mode (WASM lacks _seek_stream)');
      return;
    }
    const target = Math.max(0, this.duration > 0 ? Math.min(time, this.duration) : time);
    if (module._seek_stream(target) !== 1) return;
    sharedSdlPcmBridge.resetRing(module);
    this.boundaries = [];
    this.segmentOffset = 0;
    this.pushedAbs = Math.floor(target * this.decodedSampleRate) * this.decodedChannels;
    this.streamDecodeEnded = false;
    this.endedNotified = false;
    this.session.seek(target);
    this.notifyStateChange();
  }

  getCurrentTime(): number {
    if (!this.module) return 0;
    return Math.max(0, this.module._get_current_time() - this.segmentOffset);
  }

  getDuration(): number {
    return this.duration;
  }

  getCapabilities(): AudioBackendCapabilities {
    // SDL owns speaker output: no crossfade overlap, no Web Audio sink. Hi-fi streams
    // seek via _seek_stream and splice same-format successors (gapless).
    const seek = !this.isStreaming || !this.module || typeof this.module._seek_stream === 'function';
    return { seek, playbackRate: this.hasNativeRate(), gapless: this.isStreaming, crossfade: false, sinkId: false };
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

  private playbackRate = 1;

  private hasNativeRate(): boolean {
    // Before the module loads, report the capability the current build ships.
    return !this.module || typeof this.module._set_playback_rate === 'function';
  }

  /** Tempo via SDL resampling (pitch follows speed). Clock stays in media seconds. */
  setPlaybackRate(rate: number): void {
    this.playbackRate = Math.max(0.25, Math.min(4, Number.isFinite(rate) ? rate : 1));
    this.module?._set_playback_rate?.(this.playbackRate);
  }

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
