// Audio player using AudioWorkletNode for better performance
// Falls back to ScriptProcessorNode if AudioWorklet is not available
// Phase 2: Added streaming mode with ring buffer for chunked/low-memory playback.
import { decodeAudio } from './audioDecoder';
import { AudioContextManager, sharedAudioContextManager } from './audio/AudioContextManager';
import { runHifiStreamPipeline } from './audio/hifiStreamPipeline';
import { getOrFetchTrack } from './storage/trackCache';
import type { PlaybackPathInfo } from './utils/playbackPath';
import { describePlaybackPath } from './utils/playbackPath';
import type { AudioBackend, AudioPlaybackState } from './types/audio';
import {
  DEFAULT_CROSSFADE_MS,
  DEFAULT_GAPLESS_MODE,
  isGaplessActive,
  type GaplessSettings,
  type PreloadNextOptions,
  type TrackTransitionEvent,
} from './types/gapless';

// AudioWorklet processor code as a string (will be loaded as a blob URL)
const WORKLET_PROCESSOR_CODE = `
class RingBuffer {
  constructor(capacity) {
    this.capacity = capacity;
    this.buffer = new Float32Array(capacity);
    this.writeIndex = 0;
    this.readIndex = 0;
    this.available = 0;
  }

  write(data) {
    const toWrite = Math.min(data.length, this.capacity - this.available);
    for (let i = 0; i < toWrite; i++) {
      this.buffer[this.writeIndex] = data[i];
      this.writeIndex = (this.writeIndex + 1) % this.capacity;
    }
    this.available += toWrite;
    return toWrite;
  }

  read(outputs, channels) {
    const frames = outputs[0].length;
    let readFrames = 0;
    for (let i = 0; i < frames && this.available >= channels; i++) {
      for (let ch = 0; ch < Math.min(outputs.length, channels); ch++) {
        outputs[ch][i] = this.buffer[this.readIndex];
        this.readIndex = (this.readIndex + 1) % this.capacity;
      }
      this.available -= channels;
      readFrames++;
    }
    return readFrames;
  }

  getAvailable() {
    return this.available;
  }

  clear() {
    this.writeIndex = 0;
    this.readIndex = 0;
    this.available = 0;
  }
}

class FlacProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.buffer = null;
    this.position = 0;
    this.channels = 0;
    this.sampleRate = options?.processorOptions?.sampleRate || 44100;
    this.isStreaming = false;
    this.hasEnded = false;
    this.totalRead = 0;

    // PCM tap for projectM visualization (512 samples per channel)
    this.pcmBlockSize = 512;
    this.pcmAccum = null;
    this.pcmAccumPos = 0;

    const ringSeconds = options?.processorOptions?.ringBufferSeconds || 30;
    const ringChannels = options?.processorOptions?.channels || 2;
    const ringSampleRate = options?.processorOptions?.sampleRate || 44100;
    const ringCapacity = Math.floor(ringSeconds * ringSampleRate * ringChannels);
    this.ringBuffer = new RingBuffer(ringCapacity);

    this.nextBuffer = null;
    this.nextChannels = 0;

    this.port.onmessage = (e) => {
      if (e.data.type === 'buffer') {
        this.buffer = e.data.buffer;
        this.channels = e.data.channels;
        this.position = 0;
        this.isStreaming = false;
        this.ringBuffer.clear();
        this.pcmAccum = null;
        this.pcmAccumPos = 0;
      } else if (e.data.type === 'startStreaming') {
        this.isStreaming = true;
        this.channels = e.data.channels || 2;
        this.sampleRate = e.data.sampleRate || 44100;
        this.hasEnded = false;
        this.totalRead = 0;
        this.ringBuffer.clear();
        this.pcmAccum = null;
        this.pcmAccumPos = 0;
      } else if (e.data.type === 'chunk') {
        if (this.isStreaming) {
          this.ringBuffer.write(e.data.buffer);
        }
      } else if (e.data.type === 'endStreaming') {
        this.hasEnded = true;
      } else if (e.data.type === 'seek') {
        this.position = Math.floor(e.data.position * sampleRate) * this.channels;
        this.pcmAccum = null;
        this.pcmAccumPos = 0;
      } else if (e.data.type === 'stop') {
        this.buffer = null;
        this.nextBuffer = null;
        this.nextChannels = 0;
        this.position = 0;
        this.isStreaming = false;
        this.ringBuffer.clear();
        this.pcmAccum = null;
        this.pcmAccumPos = 0;
      } else if (e.data.type === 'queueBuffer') {
        this.nextBuffer = e.data.buffer;
        this.nextChannels = e.data.channels || this.channels;
      } else if (e.data.type === 'clearQueue') {
        this.nextBuffer = null;
        this.nextChannels = 0;
      }
    };
  }

  // Accumulate output frames into fixed-size interleaved PCM blocks and post
  // them to the main thread for projectM visualization.  The buffer ownership
  // is transferred (zero-copy) so we allocate a fresh Float32Array each block.
  _tapPCM(output, frames) {
    if (!this.channels || frames === 0) return;
    for (let i = 0; i < frames; i++) {
      if (!this.pcmAccum) {
        this.pcmAccum = new Float32Array(this.pcmBlockSize * this.channels);
        this.pcmAccumPos = 0;
      }
      for (let ch = 0; ch < Math.min(output.length, this.channels); ch++) {
        this.pcmAccum[this.pcmAccumPos * this.channels + ch] = output[ch][i];
      }
      this.pcmAccumPos++;
      if (this.pcmAccumPos >= this.pcmBlockSize) {
        const toSend = this.pcmAccum;
        this.pcmAccum = null;
        this.pcmAccumPos = 0;
        this.port.postMessage(
          { type: 'projectm-pcm', buffer: toSend, channels: this.channels, sampleRate: this.sampleRate },
          [toSend.buffer]
        );
      }
    }
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (this.isStreaming) {
      return this.processStreaming(output);
    }
    return this.processBuffered(output);
  }

  processBuffered(output) {
    if (!this.buffer || this.channels === 0) {
      for (let ch = 0; ch < output.length; ch++) {
        output[ch].fill(0);
      }
      return true;
    }

    const frames = output[0].length;
    let segmentEndedThisBlock = false;
    for (let i = 0; i < frames; i++) {
      if (this.position >= this.buffer.length) {
        if (this.nextBuffer) {
          this.buffer = this.nextBuffer;
          this.channels = this.nextChannels || this.channels;
          this.nextBuffer = null;
          this.nextChannels = 0;
          this.position = 0;
          if (!segmentEndedThisBlock) {
            segmentEndedThisBlock = true;
            this.port.postMessage({ type: 'segmentEnded' });
          }
        } else {
          for (let ch = 0; ch < output.length; ch++) {
            output[ch][i] = 0;
          }
          if (i === 0) {
            this.port.postMessage({ type: 'ended' });
          }
          continue;
        }
      }
      for (let ch = 0; ch < Math.min(output.length, this.channels); ch++) {
        output[ch][i] = this.buffer[this.position + ch];
      }
      this.position += this.channels;
    }

    this._tapPCM(output, frames);

    if (frames > 0 && this.position % (this.channels * 44100) < this.channels * 128) {
      this.port.postMessage({ type: 'position', position: this.position / (this.channels * sampleRate) });
    }

    return true;
  }

  processStreaming(output) {
    const frames = output[0].length;
    const readFrames = this.ringBuffer.read(output, this.channels);

    for (let i = readFrames; i < frames; i++) {
      for (let ch = 0; ch < output.length; ch++) {
        output[ch][i] = 0;
      }
    }

    this.totalRead += readFrames * this.channels;

    this._tapPCM(output, frames);

    if (this.hasEnded && this.ringBuffer.getAvailable() === 0 && readFrames < frames) {
      this.hasEnded = false;
      this.port.postMessage({ type: 'ended' });
    }

    if (frames > 0 && this.totalRead % (this.channels * 44100) < this.channels * 128) {
      this.port.postMessage({ type: 'position', position: this.totalRead / (this.channels * this.sampleRate) });
    }

    return true;
  }
}

registerProcessor('flac-processor', FlacProcessor);
`;

export class AudioWorkletPlayer implements AudioBackend {
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | ScriptProcessorNode | null = null;
  private gainNode: GainNode | null = null;
  private audioBuffer: Float32Array | null = null;
  private channels: number = 0;
  private sampleRate: number = 44100;
  private isPlaying: boolean = false;
  private isStreaming: boolean = false;
  private duration: number = 0;
  private currentTime: number = 0;
  private playbackRate: number = 1.0;
  private onStateChange?: (state: AudioPlaybackState) => void;
  private onEndedCallback?: (event?: TrackTransitionEvent) => void;
  private useScriptProcessor: boolean = false;
  private workletUrl: string | null = null;
  private onPCMBlock?: (buffer: Float32Array, channels: number, sampleRate: number) => void;
  private streamAbort: AbortController | null = null;
  private playbackPath: PlaybackPathInfo | null = null;
  private pipelineTask: Promise<void> | null = null;
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

  constructor(private contextManager: AudioContextManager = sharedAudioContextManager) {
    this.setupWorkletUrl();
  }

  private setupWorkletUrl() {
    const blob = new Blob([WORKLET_PROCESSOR_CODE], { type: 'application/javascript' });
    this.workletUrl = URL.createObjectURL(blob);
  }

  async initialize(): Promise<void> {
    if (this.audioContext) return;
    try {
      this.audioContext = this.contextManager.getContext();
      this.gainNode = this.audioContext.createGain();
      this.contextManager.connectInput(this.gainNode);

      if (this.audioContext.audioWorklet && this.workletUrl) {
        try {
          await this.audioContext.audioWorklet.addModule(this.workletUrl);
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

    } catch (err) {
      console.error('[AudioWorkletPlayer] Failed to initialize:', err);
      this.audioContext = null;
      this.gainNode = null;
      throw err;
    }
  }

  setStateChangeCallback(callback: (state: AudioPlaybackState) => void): void {
    this.onStateChange = callback;
  }

  setOnEndedCallback(callback?: (event?: TrackTransitionEvent) => void): void {
    this.onEndedCallback = callback;
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

  private notifyStateChange(): void {
    if (this.onStateChange) {
      this.onStateChange(this.getState());
    }
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
    if (!isGaplessActive(this.gaplessSettings) || this.isStreaming) return;
    const { url } = typeof options === 'string' ? { url: options } : options;
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
        if (!this.audioContext) await this.initialize();
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
    if (this.workletNode && !this.useScriptProcessor) {
      (this.workletNode as AudioWorkletNode).port.postMessage({ type: 'clearQueue' });
    }
  }

  private _sendQueuedBufferToWorklet(): void {
    if (!this.pendingNextBuffer || !this.workletNode || this.useScriptProcessor || this.isStreaming) {
      return;
    }
    (this.workletNode as AudioWorkletNode).port.postMessage({
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

  private attachWorkletPort(node: AudioWorkletNode): void {
    node.port.onmessage = (e) => {
      if (e.data.type === 'ended') {
        this.isPlaying = false;
        this.isStreaming = false;
        this.currentTime = 0;
        this.notifyStateChange();
        if (this.onEndedCallback) {
          try { this.onEndedCallback(); } catch (err) { console.warn('onEnded threw', err); }
        }
      } else if (e.data.type === 'segmentEnded') {
        this._handleSegmentEnded();
      } else if (e.data.type === 'position') {
        this.currentTime = e.data.position;
      } else if (e.data.type === 'projectm-pcm') {
        if (this.onPCMBlock) {
          this.onPCMBlock(e.data.buffer, e.data.channels, e.data.sampleRate);
        }
      }
    };
  }

  async loadAudio(arrayBuffer: ArrayBuffer, filename?: string): Promise<void> {
    if (!this.audioContext) {
      await this.initialize();
    }
    const audioContext = this.audioContext;
    if (!audioContext) throw new Error('AudioWorklet context failed to initialize');

    this.notifyStateChange();

    try {
      this.stop();
      this.clearPreload();

      const decodedData = await decodeAudio(arrayBuffer, audioContext, filename);

      this.channels = decodedData.channels;
      this.sampleRate = decodedData.sampleRate;
      this.duration = decodedData.duration;
      this.currentTime = 0;
      this.isStreaming = false;
      this.playbackPath = describePlaybackPath('buffered');

      this.audioBuffer = decodedData.interleavedBuffer;

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
   * Memory stays bounded; no full-file ArrayBuffer is retained.
   */
  async loadFromURLStreaming(
    url: string,
    options: {
      expectedDuration?: number;
      cachedResponse?: Response;
      onProgress?: (loaded: number, total: number | null) => void;
    } = {}
  ): Promise<void> {
    if (!this.audioContext) {
      await this.initialize();
    }
    if (this.useScriptProcessor) {
      throw new Error('Hi-Fi streaming requires AudioWorklet (ScriptProcessor fallback unavailable)');
    }

    this.cancelStream();
    this.stopNode();
    this.isPlaying = false;
    this.isStreaming = false;
    this.playbackPath = describePlaybackPath('hifi-stream');
    this.streamAbort = new AbortController();

    let streamReady: Promise<void> | null = null;
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
        finishReject(new Error('Streaming playback did not start in time'));
      }, 30_000);
    });

    const pipeline = runHifiStreamPipeline({
      url,
      cachedResponse: options.cachedResponse,
      expectedDuration: options.expectedDuration,
      signal: this.streamAbort.signal,
      onProgress: (p) => options.onProgress?.(p.loaded, p.total),
      onMetadata: ({ channels, sampleRate }) => {
        this.channels = channels;
        this.sampleRate = sampleRate;
        streamReady = this.startStreaming(channels, sampleRate).then(() => {
          if (options.expectedDuration) {
            this.duration = options.expectedDuration;
          }
        });
        void streamReady.then(() => finishResolve());
      },
      onPcmChunk: (interleaved) => {
        if (streamReady) {
          void streamReady.then(() => this.appendChunk(interleaved));
        }
      },
      onEnded: () => this.endStreaming(),
      onError: (err) => {
        console.error('[AudioWorkletPlayer] Stream error:', err);
        finishReject(err);
      },
    });

    this.pipelineTask = pipeline;
    pipeline.catch(finishReject);
    await readyPromise;
  }

  private cancelStream(): void {
    this.streamAbort?.abort();
    this.streamAbort = null;
    this.pipelineTask = null;
  }

  // ---------------------------------------------------------------------------
  // Streaming mode (Phase 2)
  // ---------------------------------------------------------------------------

  async startStreaming(channels: number = 2, sampleRate: number = 44100): Promise<void> {
    if (!this.audioContext) {
      await this.initialize();
    }

    // Tear down playback nodes only — do not abort an in-flight stream pipeline.
    this.stopNode();
    this.isPlaying = false;

    this.channels = channels;
    this.sampleRate = sampleRate;
    this.currentTime = 0;
    this.duration = 0;
    this.audioBuffer = null;
    this.isStreaming = true;

    await this.contextManager.resume();

    if (this.useScriptProcessor) {
      console.warn('[AudioWorkletPlayer] Streaming mode requires AudioWorklet. ScriptProcessor fallback not supported for streaming.');
      return;
    }

    this.workletNode = new AudioWorkletNode(this.audioContext!, 'flac-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [channels],
      processorOptions: {
        sampleRate,
        channels,
        ringBufferSeconds: 30
      }
    });

    this.workletNode.connect(this.gainNode!);

    (this.workletNode as AudioWorkletNode).port.postMessage({
      type: 'startStreaming',
      channels,
      sampleRate
    });

    this.attachWorkletPort(this.workletNode as AudioWorkletNode);

    this.isPlaying = true;
    this.notifyStateChange();
  }

  appendChunk(interleavedBuffer: Float32Array): void {
    if (!this.workletNode || this.useScriptProcessor || !this.isStreaming) return;
    (this.workletNode as AudioWorkletNode).port.postMessage({
      type: 'chunk',
      buffer: interleavedBuffer
    }, [interleavedBuffer.buffer]);
  }

  endStreaming(): void {
    if (!this.workletNode || this.useScriptProcessor || !this.isStreaming) return;
    (this.workletNode as AudioWorkletNode).port.postMessage({ type: 'endStreaming' });
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

    this.workletNode = new AudioWorkletNode(this.audioContext, 'flac-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [this.channels],
      processorOptions: {
        sampleRate: this.sampleRate
      }
    });

    this.workletNode.connect(this.gainNode);

    (this.workletNode as AudioWorkletNode).port.postMessage({
      type: 'buffer',
      buffer: this.audioBuffer,
      channels: this.channels
    });

    this.attachWorkletPort(this.workletNode as AudioWorkletNode);
    this._sendQueuedBufferToWorklet();

    if (startSample > 0) {
      (this.workletNode as AudioWorkletNode).port.postMessage({
        type: 'seek',
        position: this.currentTime
      });
    }
  }

  private createScriptProcessorNode(startSample: number): void {
    if (!this.audioContext || !this.gainNode || !this.audioBuffer) return;

    const bufferSize = 4096;
    let position = startSample;

    this.workletNode = this.audioContext.createScriptProcessor(
      bufferSize,
      0,
      this.channels
    );

    this.workletNode.onaudioprocess = (e) => {
      const output = e.outputBuffer;
      const frames = output.length;

      for (let i = 0; i < frames; i++) {
        if (position >= this.audioBuffer!.length) {
          for (let ch = 0; ch < output.numberOfChannels; ch++) {
            output.getChannelData(ch)[i] = 0;
          }
          if (i === 0 && this.isPlaying) {
            this.isPlaying = false;
            this.currentTime = 0;
            this.notifyStateChange();
            if (this.onEndedCallback) {
              try { this.onEndedCallback(); } catch (err) { console.warn('onEnded threw', err); }
            }
          }
        } else {
          for (let ch = 0; ch < Math.min(output.numberOfChannels, this.channels); ch++) {
            output.getChannelData(ch)[i] = this.audioBuffer![position + ch];
          }
          position += this.channels;
        }
      }

      this.currentTime = position / (this.channels * this.sampleRate);
    };

    this.workletNode.connect(this.gainNode);
  }

  pause(): void {
    if (!this.isPlaying) return;

    if (this.isStreaming) {
      this.audioContext?.suspend();
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
        (this.workletNode as ScriptProcessorNode).onaudioprocess = null;
      } else {
        (this.workletNode as AudioWorkletNode).port.postMessage({ type: 'stop' });
      }
      this.workletNode.disconnect();
      this.workletNode = null;
    }
  }

  seek(time: number): void {
    if (this.isStreaming) {
      console.warn('[AudioWorkletPlayer] Seek not supported in streaming mode');
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

  getAnalyser(): AnalyserNode {
    return this.contextManager.getAnalyser();
  }

  destroy(): void {
    this.cancelStream();
    this.stop();
    if (this.gainNode) this.gainNode.disconnect();
    this.gainNode = null;
    this.audioContext = null;
    if (this.workletUrl) URL.revokeObjectURL(this.workletUrl);
  }
}
