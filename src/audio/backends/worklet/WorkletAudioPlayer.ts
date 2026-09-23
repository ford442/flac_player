// Audio player using AudioWorkletNode (flac-processor) for buffered and hi-fi
// streaming playback. Falls back to ScriptProcessorNode for buffered playback
// when AudioWorklet is unavailable. The shared AudioContext is never suspended
// here: pause is a message to the processor.
import { decodeAudio } from '../../../audioDecoder';
import { AudioContextManager, isAudioContextSinkSupported, sharedAudioContextManager } from '../../AudioContextManager';
import { ensureContextForBuffer, ensureContextForUrl } from '../../ensureContextForSource';
import { createStreamResampler, resampleInterleaved, type StreamResampler } from '../../resampler';
import { HifiStreamSession, type HifiTrackSource } from '../../hifiStreamPipeline';
import { getOrFetchTrack } from '../../../storage/trackCache';
import type { PlaybackPathInfo } from '../../../utils/playbackPath';
import { describePlaybackPath } from '../../../utils/playbackPath';
import type { AudioBackendCapabilities, AudioPlaybackState, DecodedPcmView } from '../../../types/audio';
import {
  DEFAULT_CROSSFADE_MS,
  DEFAULT_GAPLESS_MODE,
  isGaplessActive,
  type GaplessSettings,
  type PreloadNextOptions,
} from '../../../types/gapless';
import { BaseAudioBackend } from '../BaseAudioBackend';
import {
  FLAC_PROCESSOR_NAME,
  type FlacProcessorInbound,
  type FlacProcessorOptions,
  type FlacProcessorOutbound,
} from '../../worklets/flacProcessorMessages';
import { HifiStreamFeeder } from './hifiStreamFeeder';
import { createScriptProcessorPlayback, stopScriptProcessorPlayback } from './scriptProcessorFallback';

/** Static same-origin processor module (emitted as an asset by webpack / served by Vite). */
const FLAC_PROCESSOR_URL = new URL('../../worklets/flacProcessor.js', import.meta.url);

const STREAM_RING_SECONDS = 30;


export class WorkletAudioPlayer extends BaseAudioBackend {
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | ScriptProcessorNode | null = null;
  private gainNode: GainNode | null = null;
  private audioBuffer: Float32Array | null = null;
  private channels: number = 0;
  private sampleRate: number = 0;
  private fileSampleRate: number = 0;
  private streamResampler: StreamResampler | null = null;
  private isPlaying: boolean = false;
  private isStreaming: boolean = false;
  private duration: number = 0;
  private currentTime: number = 0;
  private playbackRate: number = 1.0;
  private useScriptProcessor: boolean = false;
  private streamFeeder: HifiStreamFeeder | null = null;
  private onPCMBlock?: (buffer: Float32Array, channels: number, sampleRate: number) => void;
  private playbackPath: PlaybackPathInfo | null = null;
  private session: HifiStreamSession | null = null;
  /** Bumped on every stream seek; stale `position` messages are ignored. */
  private streamEpoch = 0;
  /** Durations of spliced tracks, in ring order, until their segmentEnded arrives. */
  private splicedDurations: Array<number | null> = [];
  /** The processor reported `ended`: play() restarts the stream from 0. */
  private streamFinished = false;
  /** Latest preloadNext() request, forwarded to the hi-fi session once it exists. */
  private nextSource: HifiTrackSource | null = null;
  private lastPreloadRequest: HifiTrackSource | null = null;
  private gaplessSettings: GaplessSettings = {
    mode: DEFAULT_GAPLESS_MODE,
    crossfadeMs: DEFAULT_CROSSFADE_MS,
  };
  private prebufferingNext = false;
  private preloadAbort: AbortController | null = null;
  private pendingNextBuffer: Float32Array | null = null;
  private pendingNextChannels = 0;
  private pendingNextDuration = 0;
  private pendingNextSampleRate = 0;
  private readonly unsubscribeGraph: () => void;

  constructor(private contextManager: AudioContextManager = sharedAudioContextManager) {
    super();
    this.unsubscribeGraph = contextManager.subscribeGraphRecreated(() => {
      this.stopNode();
      this.gainNode = null;
      this.audioContext = null;
    });
  }

  private post(msg: FlacProcessorInbound, transfer?: Transferable[]): void {
    if (!this.workletNode || this.useScriptProcessor) return;
    const port = (this.workletNode as AudioWorkletNode).port;
    if (transfer) port.postMessage(msg, transfer);
    else port.postMessage(msg);
  }

  private createFlacNode(ctx: AudioContext, options: FlacProcessorOptions): AudioWorkletNode {
    return new AudioWorkletNode(ctx, FLAC_PROCESSOR_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [options.channels],
      processorOptions: options,
    });
  }

  getCapabilities(): AudioBackendCapabilities {
    return {
      // Hi-fi streams restart the decoder at the target frame (hifiStreamPipeline.ts).
      seek: true,
      playbackRate: false,
      // Hi-fi streams splice same-format successors into the ring; crossfade mode
      // is treated as gapless here (overlap stays native-streaming / web-audio).
      gapless: !this.useScriptProcessor,
      crossfade: false,
      sinkId: isAudioContextSinkSupported(),
    };
  }

  async initialize(): Promise<void> {
    /* AudioContext is created on first load at the track native rate. */
  }

  private async ensureWorkletGraph(sampleRate?: number, channels?: number): Promise<AudioContext> {
    await this.contextManager.ensureForTrack({ sampleRate, channels });
    const ctx = this.contextManager.getContext();
    if (this.audioContext === ctx && this.gainNode) return ctx;

    this.audioContext = ctx;
    this.gainNode = ctx.createGain();
    this.contextManager.connectInput(this.gainNode);

    if (this.audioContext.audioWorklet) {
      try {
        await this.audioContext.audioWorklet.addModule(FLAC_PROCESSOR_URL.href);
        console.log('[AudioWorkletPlayer] Using AudioWorklet');
        this.useScriptProcessor = false;
      } catch (err) {
        console.warn('[AudioWorkletPlayer] AudioWorklet failed, falling back to ScriptProcessor:', err);
        this.useScriptProcessor = true;
      }
    } else {
      console.log('[AudioWorkletPlayer] AudioWorklet not available, using ScriptProcessor');
      this.useScriptProcessor = true;
    }
    return ctx;
  }

  /** No-op when chooseContextSampleRate matched the file rate. */
  private async pcmForContext(interleaved: Float32Array, channels: number, fileRate: number): Promise<Float32Array> {
    const contextRate = this.audioContext?.sampleRate ?? fileRate;
    if (!fileRate || contextRate === fileRate) return interleaved;
    return resampleInterleaved(interleaved, channels, fileRate, contextRate);
  }

  /**
   * Register a callback that receives interleaved PCM blocks (512 samples/ch)
   * directly from the audio worklet thread.  Use this to feed a projectM
   * visualizer with audio-clock-synchronized PCM data.
   *
   * Pass `undefined` to unregister.
   */
  setPCMCallback(
    callback: ((buffer: Float32Array, channels: number, sampleRate: number) => void) | undefined
  ): void {
    this.onPCMBlock = callback;
  }

  private setPrebuffering(active: boolean): void {
    if (this.prebufferingNext === active) return;
    this.prebufferingNext = active;
    this.notifyStateChange();
  }

  setGaplessSettings(settings: GaplessSettings): void {
    this.gaplessSettings = settings;
    if (!isGaplessActive(settings)) this.clearPreload();
  }

  setCrossfadeEnabled(enabled: boolean): void {
    this.setGaplessSettings({
      mode: enabled ? 'crossfade' : 'off',
      crossfadeMs: this.gaplessSettings.crossfadeMs,
    });
  }

  preloadNext(options: PreloadNextOptions | string): void {
    if (!isGaplessActive(this.gaplessSettings)) return;
    const { url, duration } = typeof options === 'string' ? { url: options, duration: undefined } : options;
    this.lastPreloadRequest = { url, expectedDuration: duration };
    if (this.playbackPath?.strategy === 'hifi-stream') {
      // Decode-ahead happens in the session once the current decode finishes.
      this.nextSource = { url, expectedDuration: duration };
      this.session?.setNext(this.nextSource);
      return;
    }
    this.preloadAbort?.abort();
    const controller = new AbortController();
    this.preloadAbort = controller;
    this.setPrebuffering(true);

    void (async () => {
      try {
        const response = await getOrFetchTrack(url);
        if (controller.signal.aborted) return;
        const arrayBuffer = await response.arrayBuffer();
        if (controller.signal.aborted) return;
        if (!this.audioContext) await this.ensureWorkletGraph();
        const decoded = await decodeAudio(arrayBuffer, this.audioContext!, undefined);
        if (controller.signal.aborted) return;

        this.pendingNextBuffer = decoded.interleavedBuffer;
        this.pendingNextChannels = decoded.channels;
        this.pendingNextDuration = decoded.duration;
        this.pendingNextSampleRate = decoded.sampleRate;
        this._sendQueuedBufferToWorklet();
      } catch (err) {
        if (!controller.signal.aborted) {
          console.warn('[AudioWorkletPlayer] preloadNext failed:', err);
        }
      } finally {
        if (!controller.signal.aborted) this.setPrebuffering(false);
      }
    })();
  }

  clearPreload(): void {
    this.preloadAbort?.abort();
    this.preloadAbort = null;
    this.pendingNextBuffer = null;
    this.pendingNextChannels = 0;
    this.pendingNextDuration = 0;
    this.pendingNextSampleRate = 0;
    this.setPrebuffering(false);
    this.nextSource = null;
    this.lastPreloadRequest = null;
    this.session?.setNext(null);
    this.post({ type: 'clearQueue' });
  }

  private _sendQueuedBufferToWorklet(): void {
    if (!this.pendingNextBuffer || !this.workletNode || this.useScriptProcessor || this.isStreaming) {
      return;
    }
    this.post({
      type: 'queueBuffer',
      buffer: this.pendingNextBuffer,
      channels: this.pendingNextChannels,
    });
    // Keep a reference until segmentEnded swaps track metadata on the main thread.
  }

  private _handleSegmentEnded(): void {
    if (this.pendingNextBuffer) {
      this.audioBuffer = this.pendingNextBuffer;
      this.channels = this.pendingNextChannels;
      this.duration = this.pendingNextDuration;
      this.sampleRate = this.pendingNextSampleRate;
      this.fileSampleRate = this.pendingNextSampleRate;
      this.currentTime = 0;
      this.pendingNextBuffer = null;
      this.pendingNextChannels = 0;
      this.pendingNextDuration = 0;
      this.notifyStateChange();
      if (this.onEndedCallback) {
        try { this.onEndedCallback({ alreadyPlayingNext: true }); } catch (err) { console.warn('onEnded threw', err); }
      }
      return;
    }
    this.isPlaying = false;
    this.currentTime = 0;
    this.notifyStateChange();
    if (this.onEndedCallback) {
      try { this.onEndedCallback(); } catch (err) { console.warn('onEnded threw', err); }
    }
  }

  /** Streaming: the read head crossed a gapless splice. */
  private handleStreamSegmentEnded(): void {
    this.session?.crossBoundary();
    const duration = this.splicedDurations.shift();
    this.duration = duration ?? 0;
    this.currentTime = 0;
    this.notifyStateChange();
    if (this.onEndedCallback) {
      try { this.onEndedCallback({ alreadyPlayingNext: true }); } catch (err) { console.warn('onEnded threw', err); }
    }
  }

  private attachWorkletPort(node: AudioWorkletNode): void {
    node.port.onmessage = (e: MessageEvent<FlacProcessorOutbound>) => {
      if (e.data.type === 'ended') {
        this.isPlaying = false;
        if (this.isStreaming) {
          // Keep the node and session: seek (or play → restart) works after the end.
          this.streamFinished = true;
          this.currentTime = this.duration;
        } else {
          this.currentTime = 0;
        }
        this.notifyStateChange();
        if (this.onEndedCallback) {
          try { this.onEndedCallback(); } catch (err) { console.warn('onEnded threw', err); }
        }
      } else if (e.data.type === 'segmentEnded') {
        if (!this.isStreaming) this._handleSegmentEnded();
        else if (e.data.epoch === this.streamEpoch) this.handleStreamSegmentEnded();
      } else if (e.data.type === 'position') {
        if (this.isStreaming) {
          if (e.data.epoch !== this.streamEpoch) return;
          this.streamFeeder?.noteConsumed(e.data.consumed);
        }
        this.currentTime = e.data.position;
      } else if (e.data.type === 'projectm-pcm') {
        if (this.onPCMBlock) {
          this.onPCMBlock(e.data.buffer, e.data.channels, e.data.sampleRate);
        }
      }
    };
  }

  async loadAudio(arrayBuffer: ArrayBuffer, filename?: string): Promise<void> {
    await ensureContextForBuffer(this.contextManager, arrayBuffer);
    const audioContext = await this.ensureWorkletGraph();
    if (!audioContext) throw new Error('AudioWorklet context failed to initialize');

    this.notifyStateChange();

    try {
      this.stop();
      this.clearPreload();

      const decodedData = await decodeAudio(arrayBuffer, audioContext, filename);
      await this.contextManager.ensureForTrack({
        sampleRate: decodedData.sampleRate,
        channels: decodedData.channels,
      });
      await this.ensureWorkletGraph(decodedData.sampleRate, decodedData.channels);

      this.channels = decodedData.channels;
      this.fileSampleRate = decodedData.sampleRate;
      this.sampleRate = this.audioContext?.sampleRate ?? decodedData.sampleRate;
      this.duration = decodedData.duration;
      this.currentTime = 0;
      this.isStreaming = false;
      this.playbackPath = describePlaybackPath('buffered');

      this.audioBuffer = await this.pcmForContext(
        decodedData.interleavedBuffer,
        decodedData.channels,
        decodedData.sampleRate
      );

      console.log('[AudioWorkletPlayer] Loaded audio:', {
        channels: this.channels,
        sampleRate: this.sampleRate,
        duration: this.duration,
        samples: this.audioBuffer.length
      });

      this.notifyStateChange();
    } catch (error) {
      console.error('[AudioWorkletPlayer] Error loading audio:', error);
      throw error;
    }
  }

  loadFromArrayBuffer(arrayBuffer: ArrayBuffer, filename?: string): Promise<void> {
    this.playbackPath = describePlaybackPath('buffered');
    return this.loadAudio(arrayBuffer, filename);
  }

  getPlaybackPath(): PlaybackPathInfo | null {
    return this.playbackPath;
  }

  /**
   * Stream-decode a remote FLAC URL via HTTP Range → WASM chunks → worklet ring buffer.
   * Memory stays bounded; no full-file ArrayBuffer is retained. Seek restarts the
   * decoder at the target frame; a queued same-format successor is spliced in gaplessly.
   */
  async loadFromURLStreaming(
    url: string,
    options: {
      expectedDuration?: number;
      cachedResponse?: Response;
      onProgress?: (loaded: number, total: number | null) => void;
    } = {}
  ): Promise<void> {
    // Set before any await: a preloadNext() racing this load goes to the session.
    this.playbackPath = describePlaybackPath('hifi-stream');
    this.adoptPreloadForStream(url);
    await ensureContextForUrl(this.contextManager, url);
    await this.ensureWorkletGraph();
    if (this.useScriptProcessor) {
      throw new Error('Hi-Fi streaming requires AudioWorklet (ScriptProcessor fallback unavailable)');
    }

    this.cancelStream();
    this.stopNode();
    this.isPlaying = false;
    this.isStreaming = false;

    const session = new HifiStreamSession({
      onFormat: async ({ channels, sampleRate }) => {
        this.channels = channels;
        this.fileSampleRate = sampleRate;
        await this.startStreaming(channels, sampleRate);
        this.duration = (await session.audibleDuration) ?? options.expectedDuration ?? 0;
      },
      pushPcm: async (pcm, signal) => {
        // Backpressure: hold the decoder while paused or while the ring is near full.
        await this.streamFeeder?.waitForSpace(pcm.length, signal);
        if (!signal.aborted && this.session === session) this.appendChunk(pcm);
      },
      onSplice: ({ duration }) => {
        // Same rate on both sides: the resampler keeps running across the join
        // (the marker lands within the filter latency, < 3 ms, of the true boundary).
        this.splicedDurations.push(duration);
        this.post({ type: 'markSegment' });
      },
      onDecodeEnded: () => {
        this.drainResampler();
        this.endStreaming();
      },
      onError: (err) => console.error('[AudioWorkletPlayer] Stream error:', err),
    });
    this.session = session;
    session.setNext(this.nextSource);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Streaming playback did not start in time')), 30_000);
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

  /** A buffered preload requested before this stream load becomes the session's successor. */
  private adoptPreloadForStream(url: string): void {
    const request = this.lastPreloadRequest;
    if (this.preloadAbort) {
      this.preloadAbort.abort();
      this.preloadAbort = null;
      this.pendingNextBuffer = null;
      this.setPrebuffering(false);
      this.post({ type: 'clearQueue' });
    }
    if (!this.nextSource && request && request.url !== url && isGaplessActive(this.gaplessSettings)) {
      this.nextSource = request;
    }
    if (this.nextSource?.url === url) this.nextSource = null;
  }

  private cancelStream(): void {
    this.streamFeeder?.release();
    this.session?.cancel();
    this.session = null;
    this.splicedDurations = [];
    this.streamFinished = false;
    this.streamResampler?.destroy();
    this.streamResampler = null;
  }

  // ---------------------------------------------------------------------------
  // Streaming mode (Phase 2)
  // ---------------------------------------------------------------------------

  async startStreaming(channels: number, sampleRate: number): Promise<void> {
    await this.ensureWorkletGraph(sampleRate, channels);

    // Tear down playback nodes only — do not abort an in-flight stream pipeline.
    this.stopNode();
    this.isPlaying = false;

    this.channels = channels;
    this.fileSampleRate = sampleRate;
    this.sampleRate = this.audioContext?.sampleRate ?? sampleRate;
    this.streamResampler?.destroy();
    this.streamResampler = this.sampleRate !== sampleRate
      ? await createStreamResampler(channels, sampleRate, this.sampleRate)
      : null;
    if (this.streamResampler) {
      console.log(`[AudioWorkletPlayer] Resampling ${sampleRate} → ${this.sampleRate} Hz (${this.streamResampler.kind})`);
    }
    this.currentTime = 0;
    this.duration = 0;
    this.audioBuffer = null;
    this.isStreaming = true;
    this.streamEpoch = 0;
    this.streamFinished = false;
    this.splicedDurations = [];

    await this.contextManager.resume();

    if (this.useScriptProcessor) {
      console.warn('[AudioWorkletPlayer] Streaming mode requires AudioWorklet. ScriptProcessor fallback not supported for streaming.');
      return;
    }

    const node = this.createFlacNode(this.audioContext!, {
      sampleRate: this.sampleRate,
      channels,
      ringBufferSeconds: STREAM_RING_SECONDS,
    });
    this.workletNode = node;
    node.connect(this.gainNode!);
    this.streamFeeder?.release();
    this.streamFeeder = new HifiStreamFeeder(
      Math.floor(STREAM_RING_SECONDS * this.sampleRate * channels)
    );
    this.post({ type: 'startStreaming', channels, sampleRate: this.sampleRate });
    this.attachWorkletPort(node);

    this.isPlaying = true;
    this.notifyStateChange();
  }

  private postPcm(pcm: Float32Array): void {
    if (pcm.length === 0) return;
    this.streamFeeder?.noteWritten(pcm.length);
    this.post({ type: 'chunk', buffer: pcm }, [pcm.buffer]);
  }

  appendChunk(interleavedBuffer: Float32Array): void {
    if (!this.workletNode || this.useScriptProcessor || !this.isStreaming) return;
    const pcm = this.streamResampler ? this.streamResampler.process(interleavedBuffer) : interleavedBuffer;
    // A subarray view would transfer (and detach) its whole parent buffer.
    this.postPcm(pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength ? pcm : pcm.slice());
  }

  /** Emit the resampler's filter tail (end of a track's samples). */
  private drainResampler(): void {
    if (!this.streamResampler || !this.isStreaming) return;
    const tail = this.streamResampler.flush();
    this.streamResampler.reset();
    this.postPcm(tail.slice());
  }

  endStreaming(): void {
    if (!this.workletNode || this.useScriptProcessor || !this.isStreaming) return;
    this.post({ type: 'endStreaming' });
  }

  // ---------------------------------------------------------------------------
  // Playback controls
  // ---------------------------------------------------------------------------

  play(): void {
    if (!this.audioContext || !this.gainNode) {
      console.error('[AudioWorkletPlayer] Not ready to play');
      return;
    }

    if (this.isPlaying) {
      return;
    }

    if (this.audioContext.state === 'suspended') {
      void this.contextManager.resume();
    }

    if (this.isStreaming) {
      if (this.streamFinished) {
        // Ring drained at end of stream: restart from the top.
        this.isPlaying = true;
        this.seek(0);
      }
      this.post({ type: 'resume' });
      this.streamFeeder?.setPaused(false);
      this.isPlaying = true;
      this.notifyStateChange();
      return;
    }

    const startSample = Math.floor(this.currentTime * this.sampleRate) * this.channels;

    if (this.useScriptProcessor) {
      this.createScriptProcessorNode(startSample);
    } else {
      this.createWorkletNode(startSample);
    }

    this.isPlaying = true;
    this.notifyStateChange();
  }

  private createWorkletNode(startSample: number): void {
    if (!this.audioContext || !this.gainNode || !this.audioBuffer) return;

    const node = this.createFlacNode(this.audioContext, {
      sampleRate: this.sampleRate,
      channels: this.channels,
    });
    this.workletNode = node;
    node.connect(this.gainNode);
    this.post({ type: 'buffer', buffer: this.audioBuffer, channels: this.channels });
    this.attachWorkletPort(node);
    this._sendQueuedBufferToWorklet();

    if (startSample > 0) {
      this.post({ type: 'seek', position: this.currentTime });
    }
  }

  private createScriptProcessorNode(startSample: number): void {
    if (!this.audioContext || !this.gainNode || !this.audioBuffer) return;
    this.workletNode = createScriptProcessorPlayback({
      context: this.audioContext,
      destination: this.gainNode,
      pcm: this.audioBuffer,
      channels: this.channels,
      sampleRate: this.sampleRate,
      startSample,
      onTime: (t) => { this.currentTime = t; },
      onEnded: () => {
        if (!this.isPlaying) return;
        this.isPlaying = false;
        this.currentTime = 0;
        this.notifyStateChange();
        if (this.onEndedCallback) {
          try { this.onEndedCallback(); } catch (err) { console.warn('onEnded threw', err); }
        }
      },
    });
  }

  pause(): void {
    if (!this.isPlaying) return;

    if (this.isStreaming) {
      // Never suspend the shared AudioContext (EQ, analyser, SDL tap live on it).
      // The processor holds its ring position; the feeder stops the decoder.
      this.post({ type: 'pause' });
      this.streamFeeder?.setPaused(true);
      this.isPlaying = false;
      this.notifyStateChange();
      return;
    }

    this.stopNode();
    this.isPlaying = false;
    this.notifyStateChange();
  }

  stop(): void {
    this.cancelStream();
    this.clearPreload();
    if (this.isStreaming) {
      this.isStreaming = false;
    }
    this.stopNode();
    this.isPlaying = false;
    this.currentTime = 0;
    this.notifyStateChange();
  }

  private stopNode(): void {
    if (this.workletNode) {
      if (this.useScriptProcessor) {
        stopScriptProcessorPlayback(this.workletNode as ScriptProcessorNode);
      } else {
        this.post({ type: 'stop' });
        this.workletNode.disconnect();
      }
      this.workletNode = null;
    }
  }

  seek(time: number): void {
    if (this.isStreaming) {
      this.seekStream(time);
      return;
    }

    if (!this.audioBuffer) return;

    const wasPlaying = this.isPlaying;

    if (this.isPlaying) {
      this.pause();
    }

    this.currentTime = Math.max(0, Math.min(time, this.duration));

    if (wasPlaying) {
      this.play();
    }

    this.notifyStateChange();
  }

  /**
   * Hi-fi stream seek: empty the processor ring (epoch-tagged so late position
   * messages are dropped), then restart the decoder at the target frame.
   * The shared AudioContext keeps running throughout.
   */
  private seekStream(time: number): void {
    if (!this.session?.isActive || !this.workletNode) return;
    const target = Math.max(0, this.duration > 0 ? Math.min(time, this.duration) : time);
    this.streamEpoch++;
    this.splicedDurations = [];
    this.streamFinished = false;
    this.streamResampler?.reset();
    this.streamFeeder?.reset();
    this.post({ type: 'seekStream', position: target, epoch: this.streamEpoch });
    if (!this.isPlaying) {
      // After `ended` the processor is not paused; hold it until play().
      this.post({ type: 'pause' });
      this.streamFeeder?.setPaused(true);
    }
    this.currentTime = target;
    this.session.seek(target);
    this.notifyStateChange();
  }

  getCurrentTime(): number {
    return this.currentTime;
  }

  getDuration(): number {
    return this.duration;
  }

  getState(): AudioPlaybackState {
    return {
      isPlaying: this.isPlaying,
      currentTime: this.currentTime,
      duration: this.duration,
      isLoading: false,
      prebufferingNext: this.prebufferingNext,
    };
  }

  setVolume(volume: number): void {
    this.contextManager.setVolume(volume);
  }

  private _warnedPlaybackRate = false;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setPlaybackRate(_rate: number): void {
    // AudioWorkletPlayer does not support variable playback rate;
    // the worklet processes at fixed sampleRate. Switch to Streaming mode for speed control.
    if (!this._warnedPlaybackRate) {
      this._warnedPlaybackRate = true;
      console.warn('AudioWorkletPlayer: playback rate control is not supported. Switch to Streaming mode to use this feature.');
    }
  }

  setEQBandGain(bandIndex: number, gainDb: number): void {
    const gains = this.contextManager.getEQGains();
    gains[bandIndex] = gainDb;
    this.contextManager.setEQGains(gains);
  }

  getEQGains(): number[] {
    return this.contextManager.getEQGains();
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
    if (!this.audioBuffer || this.isStreaming) return null;
    return {
      pcm: this.audioBuffer,
      channels: this.channels,
      sampleRate: this.fileSampleRate || this.sampleRate,
    };
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubscribeGraph();
    this.cancelStream();
    this.stop();
    if (this.gainNode) this.gainNode.disconnect();
    this.gainNode = null;
    this.audioContext = null;
  }
}
