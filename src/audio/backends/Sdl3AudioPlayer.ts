// The `sdl` output mode: the C++ engine (src/sdl/audio_engine.cpp) owns the
// PCM — a buffered track or the play ring a hi-fi stream is pushed into — and
// the `sdl-engine` AudioWorkletProcessor plays it on the audio thread, out of
// the module's shared memory, into the shared graph. Speaker DSP (EQ /
// ReplayGain / limiter / volume) and the analysis ring are the dsp-chain
// worklet's, as for every other Web Audio backend; this file only writes PCM
// and transport words. No second AudioContext, no ScriptProcessor: without
// AudioWorklet and cross-origin isolation the mode reports `playable: false`
// and loads reject.
import { decodeAudio } from '../../audioDecoder';
import { AudioContextManager, isAudioContextSinkSupported, sharedAudioContextManager } from '../AudioContextManager';
import { createStreamResampler, resampleInterleaved, type StreamResampler } from '../resampler';
import { WASM_ASSETS, loadWasmScript } from '../wasmLoader';
import { SDL_ENGINE_PROCESSOR_NAME, type SdlEngineOptions } from '../worklets/sdlEngineMessages';
import type { AudioBackendCapabilities, AudioPlaybackState, DecodedPcmView } from '../../types/audio';
import { isGaplessActive, DEFAULT_CROSSFADE_MS, DEFAULT_GAPLESS_MODE, type GaplessSettings, type PreloadNextOptions } from '../../types/gapless';
import { BaseAudioBackend } from './BaseAudioBackend';
import { HifiStreamSession, type HifiTrackSource } from '../hifiStreamPipeline';
import { describePlaybackPath, type PlaybackPathInfo } from '../../utils/playbackPath';
import { playRingShouldPause } from '../playRingBackpressure';

/** Static same-origin processor module (emitted as an asset by webpack / served by Vite). */
const SDL_ENGINE_PROCESSOR_URL = new URL('../worklets/sdlEngineProcessor.js', import.meta.url);

interface SdlModule {
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
  _seek_stream(seconds: number): number;
  _rebase(): void;
  /** Clamped 0.25..4 in C++; the processor interpolates (pitch follows speed). */
  _set_playback_rate(ratio: number): number;
  _get_current_time(): number;
  _is_drained(): number;
  _set_output_owner(id: number): void;
  _get_engine_state(): number;
  _get_play_ring_state(): number;
  _get_play_ring_data(): number;
  _cleanup(): void;
  _malloc(size: number): number;
  _free(ptr: number): void;
  wasmMemory?: WebAssembly.Memory;
}

declare global {
  function createSdlAudioModule(): Promise<SdlModule>;
}

/**
 * The engine's audio thread is an AudioWorklet reading a SharedArrayBuffer, so
 * it needs both. Without them the mode fails closed (no ScriptProcessor).
 */
export function isSdlEngineSupported(): boolean {
  return typeof AudioWorkletNode === 'function'
    && typeof SharedArrayBuffer === 'function'
    && globalThis.crossOriginIsolated === true;
}

const UNSUPPORTED_MESSAGE =
  'The SDL output needs AudioWorklet and a cross-origin isolated page (SharedArrayBuffer); use Streaming instead.';

/** Processor ids; 0 means "no owner" in EngineState. */
let lastOwner = 0;
function nextOwner(): number {
  lastOwner = (lastOwner % 0xfffffffe) + 1;
  return lastOwner;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Sdl3AudioPlayer extends BaseAudioBackend {
  private module: SdlModule | null = null;
  private isReady = false;
  private readonly supported = isSdlEngineSupported();
  private isPlaying = false;
  private duration = 0;
  private pollInterval: number | null = null;
  private initialization: Promise<void>;
  /** Decoded buffered track at the file rate (getDecodedPcm). */
  private decodedPcm: Float32Array | null = null;
  private fileSampleRate = 0;
  private channels = 1;
  /** Rate of the PCM in the engine: the AudioContext rate when it was loaded. */
  private engineRate = 0;
  private isStreaming = false;
  private endedNotified = false;
  private playbackPath: PlaybackPathInfo | null = null;
  private session: HifiStreamSession | null = null;
  private streamResampler: StreamResampler | null = null;
  /** Aborted on every seek / stop: work for an older decode run must not touch the engine. */
  private streamRun: AbortController | null = null;
  /** Bumped by stop(): a buffered load that lost the race does not configure the engine. */
  private loadToken = 0;
  /**
   * Interleaved samples pushed into the play ring, on the engine clock's scale
   * (seek_stream starts it at floor(t × engineRate) × channels; pushes add count).
   */
  private pushedAbs = 0;
  /** Gapless splice points on that scale, in ring order. */
  private boundaries: Array<{ abs: number; duration: number | null }> = [];
  /** Media time (engine clock) at which the audible track began. */
  private segmentOffset = 0;
  private gaplessSettings: GaplessSettings = { mode: DEFAULT_GAPLESS_MODE, crossfadeMs: DEFAULT_CROSSFADE_MS };
  private nextSource: HifiTrackSource | null = null;
  private playbackRate = 1;
  private node: AudioWorkletNode | null = null;
  /** Contexts the processor module was added to. */
  private readonly workletContexts = new WeakSet<BaseAudioContext>();
  private heapView: Float32Array | null = null;
  private readonly unsubscribeGraph: () => void;

  constructor(private contextManager: AudioContextManager = sharedAudioContextManager) {
    super();
    this.unsubscribeGraph = contextManager.subscribeGraphRecreated(() => this.onGraphRecreated());
    this.initialization = this.supported ? this.initializeModule() : Promise.resolve();
  }

  async initialize(): Promise<void> {
    if (!this.supported) throw new Error(UNSUPPORTED_MESSAGE);
    await this.initialization;
    if (!this.isReady) throw new Error('SDL engine failed to initialize');
  }

  getPlaybackPath(): PlaybackPathInfo | null {
    return this.playbackPath;
  }

  private async initializeModule(): Promise<void> {
    try {
      if (!window.createSdlAudioModule) await loadWasmScript(WASM_ASSETS.sdl3);
      const module = await window.createSdlAudioModule();
      if (this.destroyed) {
        module._cleanup();
        return;
      }
      if (!(module.wasmMemory?.buffer instanceof SharedArrayBuffer)) {
        console.error('[SdlAudioPlayer] Engine memory is not shared; was sdl-audio.wasm built with -pthread?');
        return;
      }
      if (!module._init_audio()) {
        console.error('[SdlAudioPlayer] init_audio failed (play ring allocation)');
        return;
      }
      this.module = module;
      module._set_playback_rate(this.playbackRate);
      this.isReady = true;
      this.startPolling();
    } catch (err) {
      console.error('[SdlAudioPlayer] Error initializing the engine module:', err);
    }
  }

  private startPolling(): void {
    if (this.pollInterval) window.clearInterval(this.pollInterval);
    this.pollInterval = window.setInterval(() => this.poll(), 100);
  }

  private poll(): void {
    const module = this.module;
    if (!module) return;
    if (this.isStreaming) this.checkBoundaries(module._get_current_time());
    if (!this.isPlaying) return;
    this.notifyStateChange();
    if (this.endedNotified || module._is_drained() !== 1) return;
    // Buffered: the processor read the last frame. Stream: the decoder ended
    // (set_stream_ended) and the processor emptied the ring.
    this.endedNotified = true;
    this.isPlaying = false;
    module._pause_audio();
    this.notifyStateChange();
    if (this.onEndedCallback) {
      try { this.onEndedCallback(); } catch (err) { console.warn('onEnded handler threw', err); }
    }
  }

  /**
   * Gapless: once the audible clock passes a splice point, the next track is
   * playing. Audio is already continuous; this only moves the UI clock (100 ms poll).
   */
  private checkBoundaries(current: number): void {
    const frameSamples = this.engineRate * this.channels;
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
    const buffer = this.module?.wasmMemory?.buffer;
    if (!buffer) throw new Error('SDL engine not ready');
    // A shared Memory hands out a new, longer buffer after it grows.
    if (this.heapView?.buffer !== buffer) this.heapView = new Float32Array(buffer);
    return this.heapView;
  }

  /**
   * Node per load, connected to the shared graph's input. The owner id goes in
   * before construction, so the previous processor retires at its next quantum.
   */
  private async attachNode(ctx: AudioContext, channels: number): Promise<void> {
    const module = this.module;
    if (!module?.wasmMemory) throw new Error('SDL engine not ready');
    if (!this.workletContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(SDL_ENGINE_PROCESSOR_URL.href);
      this.workletContexts.add(ctx);
    }
    this.detachNode();
    const owner = nextOwner();
    module._set_output_owner(owner);
    const processorOptions: SdlEngineOptions = {
      memory: module.wasmMemory,
      statePtr: module._get_engine_state(),
      ringStatePtr: module._get_play_ring_state(),
      ringDataPtr: module._get_play_ring_data(),
      owner,
    };
    const node = new AudioWorkletNode(ctx, SDL_ENGINE_PROCESSOR_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [channels],
      processorOptions,
    });
    this.contextManager.connectInput(node);
    this.node = node;
  }

  private detachNode(): void {
    this.module?._set_output_owner(0);
    this.node?.disconnect();
    this.node = null;
  }

  /**
   * The context was replaced (latency change, or a rate change for another
   * load): the old processor died with it. Carry the position into a fresh
   * epoch and play on through a node in the new context.
   */
  private onGraphRecreated(): void {
    const module = this.module;
    if (!module || !this.node || this.destroyed) return;
    this.detachNode();
    module._rebase();
    void this.attachNode(this.contextManager.getContext(), this.channels).catch((err) => {
      console.error('[SdlAudioPlayer] Could not reattach after a graph recreate:', err);
    });
  }

  private cancelStream(): void {
    this.streamRun?.abort();
    this.streamRun = null;
    this.session?.cancel();
    this.session = null;
    this.streamResampler?.destroy();
    this.streamResampler = null;
    this.boundaries = [];
    this.segmentOffset = 0;
    this.pushedAbs = 0;
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

  private requireEngine(): SdlModule {
    if (!this.supported) throw new Error(UNSUPPORTED_MESSAGE);
    if (!this.module || !this.isReady) throw new Error('SDL engine not initialized');
    return this.module;
  }

  async loadAudio(arrayBuffer: ArrayBuffer, filename?: string): Promise<void> {
    await this.initialize();
    const module = this.requireEngine();
    this.stop();
    const token = this.loadToken;
    this.isStreaming = false;
    this.endedNotified = false;
    this.playbackPath = describePlaybackPath('buffered');
    this.notifyStateChange();

    const result = await decodeAudio(arrayBuffer, undefined, filename);
    const { channels, sampleRate } = result;
    await this.contextManager.ensureForTrack({ sampleRate, channels });
    const ctx = this.contextManager.getContext();
    const rate = ctx.sampleRate;
    // Speex to the context rate; the processor then copies frames 1:1.
    const pcm = rate === sampleRate
      ? result.interleavedBuffer
      : await resampleInterleaved(result.interleavedBuffer, channels, sampleRate, rate);
    if (token !== this.loadToken || this.destroyed) return;

    const ptr = module._create_audio_buffer(pcm.length);
    if (!ptr) throw new Error('SDL engine could not allocate the track (create_audio_buffer)');
    this.heapF32().set(pcm, ptr / 4);
    if (module._set_audio_data(pcm.length, channels, rate) !== 1) {
      throw new Error('SDL engine configure failed (set_audio_data)');
    }
    this.duration = result.duration;
    this.decodedPcm = result.interleavedBuffer;
    this.fileSampleRate = sampleRate;
    this.channels = channels;
    this.engineRate = rate;

    await this.contextManager.whenRunning();
    if (token !== this.loadToken || this.destroyed) return;
    await this.attachNode(ctx, channels);
    this.notifyStateChange();
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
    const module = this.requireEngine();
    this.stop();
    this.isStreaming = true;
    this.endedNotified = false;
    this.decodedPcm = null;
    this.duration = options.expectedDuration ?? 0;
    this.playbackPath = describePlaybackPath('hifi-stream');
    this.streamRun = new AbortController();

    const session: HifiStreamSession = new HifiStreamSession({
      onFormat: async ({ channels, sampleRate }) => {
        await this.contextManager.ensureForTrack({ sampleRate, channels });
        if (this.session !== session) return;
        const ctx = this.contextManager.getContext();
        const rate = ctx.sampleRate;
        this.streamResampler?.destroy();
        this.streamResampler = rate !== sampleRate ? await createStreamResampler(channels, sampleRate, rate) : null;
        if (this.session !== session) return;
        if (module._set_stream_format(channels, rate) !== 1) {
          throw new Error('SDL engine configure failed (set_stream_format)');
        }
        this.channels = channels;
        this.fileSampleRate = sampleRate;
        this.engineRate = rate;
        this.pushedAbs = 0;
        this.duration = (await session.audibleDuration) ?? options.expectedDuration ?? 0;
        await this.contextManager.whenRunning();
        if (this.session !== session) return;
        await this.attachNode(ctx, channels);
        module._play();
        this.isPlaying = true;
        this.notifyStateChange();
      },
      pushPcm: async (pcm, signal) => {
        // A cancelled session's decoder must not feed the next session's resampler.
        if (signal.aborted || this.session !== session) return;
        await this.pushPcmWithBackpressure(this.streamResampler ? this.streamResampler.process(pcm) : pcm, signal);
      },
      onSplice: ({ duration }) => {
        // Same rate on both sides: the resampler runs on across the join (the
        // boundary lands within its filter latency, < 3 ms, of the true one).
        this.boundaries.push({ abs: this.pushedAbs, duration });
      },
      onDecodeEnded: () => {
        if (this.session !== session) return;
        void this.finishStream(this.streamRun?.signal);
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

  /** Push the resampler's filter tail, then tell the processor no more PCM is coming. */
  private async finishStream(signal: AbortSignal | undefined): Promise<void> {
    if (!signal || signal.aborted) return;
    const tail = this.streamResampler?.flush();
    this.streamResampler?.reset();
    if (tail && tail.length > 0) await this.pushPcmWithBackpressure(tail, signal);
    if (!signal.aborted) this.module?._set_stream_ended(1);
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
    const module = this.module;
    if (!module) return;
    if (this.endedNotified) {
      // Played to the end: restart from the top.
      this.seek(0);
    }
    void this.contextManager.whenRunning();
    module._play();
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
    this.loadToken++;
    this.cancelStream();
    this.isPlaying = false;
    if (this.module) {
      this.module._stop();
      this.detachNode();
    }
    this.notifyStateChange();
  }

  seek(time: number): void {
    const module = this.module;
    if (!module) return;
    if (this.isStreaming) {
      this.seekStream(time);
      return;
    }
    module._seek(Math.max(0, this.duration > 0 ? Math.min(time, this.duration) : time));
    this.endedNotified = false;
    this.notifyStateChange();
  }

  /**
   * Hi-fi stream seek: the engine skips the processor past everything already
   * in the ring and holds the clock at `time` (seek_stream); the session aborts
   * the current decode (its push loop exits even when parked on a full ring)
   * and restarts at the target frame. The shared AudioContext keeps running.
   */
  private seekStream(time: number): void {
    const module = this.module;
    if (!module || !this.session?.isActive) return;
    const target = Math.max(0, this.duration > 0 ? Math.min(time, this.duration) : time);
    this.streamRun?.abort();
    this.streamRun = new AbortController();
    if (module._seek_stream(target) !== 1) return;
    this.streamResampler?.reset();
    this.boundaries = [];
    this.segmentOffset = 0;
    this.pushedAbs = Math.floor(target * this.engineRate) * this.channels;
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
    // One processor reads one ring: no overlap for crossfade. Hi-fi streams
    // splice same-format successors (gapless). Output goes through the shared
    // graph, so the Web Audio sink applies.
    return {
      playable: this.supported,
      seek: true,
      playbackRate: true,
      gapless: this.isStreaming,
      crossfade: false,
      sinkId: isAudioContextSinkSupported(),
    };
  }

  getState(): AudioPlaybackState {
    return {
      isPlaying: this.isPlaying,
      currentTime: this.getCurrentTime(),
      duration: this.getDuration(),
      isLoading: false,
    };
  }

  setVolume(volume: number): void {
    this.contextManager.setVolume(volume);
  }

  /** Tempo by interpolation in the processor (pitch follows speed). Clock stays in media seconds. */
  setPlaybackRate(rate: number): void {
    this.playbackRate = Math.max(0.25, Math.min(4, Number.isFinite(rate) ? rate : 1));
    this.module?._set_playback_rate(this.playbackRate);
  }

  setEQGains(gains: number[]): void {
    this.contextManager.setEQGains(gains);
  }

  setReplayGainLinear(linear: number): void {
    this.contextManager.setReplayGainLinear(linear);
  }

  setReplayGainLimiter(enabled: boolean): void {
    this.contextManager.setReplayGainLimiter(enabled);
  }

  getAnalyser(): AnalyserNode | null {
    return this.contextManager.getAnalyser();
  }

  getDecodedPcm(): DecodedPcmView | null {
    if (!this.decodedPcm || this.isStreaming) return null;
    return {
      pcm: this.decodedPcm,
      channels: this.channels,
      sampleRate: this.fileSampleRate,
    };
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubscribeGraph();
    this.stop();
    if (this.pollInterval) clearInterval(this.pollInterval);
    this.pollInterval = null;
    this.module?._cleanup();
    this.module = null;
  }
}
