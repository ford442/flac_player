// Audio player using AudioWorkletNode for better performance
// Falls back to ScriptProcessorNode if AudioWorklet is not available
// Phase 2: Added streaming mode with ring buffer for chunked/low-memory playback.
import { decodeAudio } from './audioDecoder';

export interface PlayerState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  isLoading: boolean;
}

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

    const ringSeconds = options?.processorOptions?.ringBufferSeconds || 30;
    const ringChannels = options?.processorOptions?.channels || 2;
    const ringSampleRate = options?.processorOptions?.sampleRate || 44100;
    const ringCapacity = Math.floor(ringSeconds * ringSampleRate * ringChannels);
    this.ringBuffer = new RingBuffer(ringCapacity);

    this.port.onmessage = (e) => {
      if (e.data.type === 'buffer') {
        this.buffer = e.data.buffer;
        this.channels = e.data.channels;
        this.position = 0;
        this.isStreaming = false;
        this.ringBuffer.clear();
      } else if (e.data.type === 'startStreaming') {
        this.isStreaming = true;
        this.channels = e.data.channels || 2;
        this.sampleRate = e.data.sampleRate || 44100;
        this.hasEnded = false;
        this.totalRead = 0;
        this.ringBuffer.clear();
      } else if (e.data.type === 'chunk') {
        if (this.isStreaming) {
          this.ringBuffer.write(e.data.buffer);
        }
      } else if (e.data.type === 'endStreaming') {
        this.hasEnded = true;
      } else if (e.data.type === 'seek') {
        this.position = Math.floor(e.data.position * sampleRate) * this.channels;
      } else if (e.data.type === 'stop') {
        this.buffer = null;
        this.position = 0;
        this.isStreaming = false;
        this.ringBuffer.clear();
      }
    };
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
    for (let i = 0; i < frames; i++) {
      if (this.position >= this.buffer.length) {
        for (let ch = 0; ch < output.length; ch++) {
          output[ch][i] = 0;
        }
        if (i === 0) {
          this.port.postMessage({ type: 'ended' });
        }
      } else {
        for (let ch = 0; ch < Math.min(output.length, this.channels); ch++) {
          output[ch][i] = this.buffer[this.position + ch];
        }
        this.position += this.channels;
      }
    }

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

export class AudioWorkletPlayer {
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | ScriptProcessorNode | null = null;
  private gainNode: GainNode | null = null;
  private eqChain: import('./audio/EQChain').EQChain | null = null;
  private analyser: AnalyserNode | null = null;
  private audioBuffer: Float32Array | null = null;
  private channels: number = 0;
  private sampleRate: number = 44100;
  private isPlaying: boolean = false;
  private isStreaming: boolean = false;
  private duration: number = 0;
  private currentTime: number = 0;
  private playbackRate: number = 1.0;
  private onStateChange?: (state: PlayerState) => void;
  private onEndedCallback?: () => void;
  private useScriptProcessor: boolean = false;
  private workletUrl: string | null = null;

  constructor() {
    this.setupWorkletUrl();
  }

  private setupWorkletUrl() {
    const blob = new Blob([WORKLET_PROCESSOR_CODE], { type: 'application/javascript' });
    this.workletUrl = URL.createObjectURL(blob);
  }

  async initialize(): Promise<boolean> {
    try {
      this.audioContext = new AudioContext({
        latencyHint: 'playback',
        sampleRate: 44100
      });

      this.gainNode = this.audioContext.createGain();
      this.eqChain = new (await import('./audio/EQChain')).EQChain(this.audioContext);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 2048;

      // Wire: gainNode → eqChain → analyser → destination
      // (analyser/destination connection happens in createWorkletNode/createScriptProcessorNode)

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

      return true;
    } catch (err) {
      console.error('[AudioWorkletPlayer] Failed to initialize:', err);
      return false;
    }
  }

  setStateChangeCallback(callback: (state: PlayerState) => void): void {
    this.onStateChange = callback;
  }

  setOnEndedCallback(callback?: () => void): void {
    this.onEndedCallback = callback;
  }

  private notifyStateChange(): void {
    if (this.onStateChange) {
      this.onStateChange(this.getState());
    }
  }

  async loadAudio(arrayBuffer: ArrayBuffer, filename?: string): Promise<void> {
    if (!this.audioContext) {
      await this.initialize();
    }

    this.notifyStateChange();

    try {
      this.stop();

      const decodedData = await decodeAudio(arrayBuffer, this.audioContext, filename);

      this.channels = decodedData.channels;
      this.sampleRate = decodedData.sampleRate;
      this.duration = decodedData.duration;
      this.currentTime = 0;
      this.isStreaming = false;

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

  // ---------------------------------------------------------------------------
  // Streaming mode (Phase 2)
  // ---------------------------------------------------------------------------

  async startStreaming(channels: number = 2, sampleRate: number = 44100): Promise<void> {
    if (!this.audioContext) {
      await this.initialize();
    }

    this.stop();

    this.channels = channels;
    this.sampleRate = sampleRate;
    this.currentTime = 0;
    this.duration = 0;
    this.audioBuffer = null;
    this.isStreaming = true;

    if (this.audioContext!.state === 'suspended') {
      await this.audioContext!.resume();
    }

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
    this.gainNode!.connect(this.analyser!);
    this.analyser!.connect(this.audioContext!.destination);

    (this.workletNode as AudioWorkletNode).port.postMessage({
      type: 'startStreaming',
      channels,
      sampleRate
    });

    (this.workletNode as AudioWorkletNode).port.onmessage = (e) => {
      if (e.data.type === 'ended') {
        this.isPlaying = false;
        this.isStreaming = false;
        this.currentTime = 0;
        this.notifyStateChange();
        if (this.onEndedCallback) {
          try { this.onEndedCallback(); } catch (err) { console.warn('onEnded threw', err); }
        }
      } else if (e.data.type === 'position') {
        this.currentTime = e.data.position;
      }
    };

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
    if (!this.audioContext || !this.gainNode || !this.analyser) {
      console.error('[AudioWorkletPlayer] Not ready to play');
      return;
    }

    if (this.isPlaying) {
      return;
    }

    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
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
    if (!this.audioContext || !this.gainNode || !this.eqChain || !this.analyser || !this.audioBuffer) return;

    this.workletNode = new AudioWorkletNode(this.audioContext, 'flac-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [this.channels],
      processorOptions: {
        sampleRate: this.sampleRate
      }
    });

    this.workletNode.connect(this.gainNode);
    this.gainNode.connect(this.eqChain.input);
    this.eqChain.output.connect(this.analyser);
    this.analyser.connect(this.audioContext.destination);

    (this.workletNode as AudioWorkletNode).port.postMessage({
      type: 'buffer',
      buffer: this.audioBuffer,
      channels: this.channels
    });

    (this.workletNode as AudioWorkletNode).port.onmessage = (e) => {
      if (e.data.type === 'ended') {
        this.isPlaying = false;
        this.currentTime = 0;
        this.notifyStateChange();
        if (this.onEndedCallback) {
          try { this.onEndedCallback(); } catch (err) { console.warn('onEnded threw', err); }
        }
      } else if (e.data.type === 'position') {
        this.currentTime = e.data.position;
      }
    };

    if (startSample > 0) {
      (this.workletNode as AudioWorkletNode).port.postMessage({
        type: 'seek',
        position: this.currentTime
      });
    }
  }

  private createScriptProcessorNode(startSample: number): void {
    if (!this.audioContext || !this.gainNode || !this.eqChain || !this.analyser || !this.audioBuffer) return;

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
    this.gainNode.connect(this.eqChain.input);
    this.eqChain.output.connect(this.analyser);
    this.analyser.connect(this.audioContext.destination);
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

  getState(): PlayerState {
    return {
      isPlaying: this.isPlaying,
      currentTime: this.currentTime,
      duration: this.duration,
      isLoading: false
    };
  }

  setVolume(volume: number): void {
    if (this.gainNode) {
      this.gainNode.gain.value = Math.max(0, Math.min(1, volume));
    }
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
    this.eqChain?.setBandGain(bandIndex, gainDb);
  }

  getEQGains(): number[] {
    return this.eqChain?.getAllGains() ?? [0, 0, 0, 0, 0];
  }

  getAnalyser(): AnalyserNode {
    return this.analyser!;
  }

  destroy(): void {
    this.stop();
    if (this.gainNode) this.gainNode.disconnect();
    if (this.eqChain) this.eqChain.disconnect();
    if (this.analyser) this.analyser.disconnect();
    if (this.audioContext) this.audioContext.close();
    if (this.workletUrl) URL.revokeObjectURL(this.workletUrl);
  }
}
