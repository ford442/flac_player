// Audio player using AudioWorkletNode for better performance
// Falls back to ScriptProcessorNode if AudioWorklet is not available
import { FlacDecoder } from './flacDecoder';

export interface PlayerState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  isLoading: boolean;
}

// AudioWorklet processor code as a string (will be loaded as a blob URL)
const WORKLET_PROCESSOR_CODE = `
class FlacProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = null;
    this.position = 0;
    this.channels = 0;
    this.port.onmessage = (e) => {
      if (e.data.type === 'buffer') {
        this.buffer = e.data.buffer;
        this.channels = e.data.channels;
        this.position = 0;
      } else if (e.data.type === 'seek') {
        this.position = Math.floor(e.data.position * sampleRate) * this.channels;
      } else if (e.data.type === 'stop') {
        this.buffer = null;
        this.position = 0;
      }
    };
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!this.buffer || this.channels === 0) {
      for (let ch = 0; ch < output.length; ch++) {
        output[ch].fill(0);
      }
      return true;
    }

    const frames = output[0].length;
    for (let i = 0; i < frames; i++) {
      if (this.position >= this.buffer.length) {
        // End of buffer - fill with silence
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

    // Report position
    if (frames > 0 && this.position % (this.channels * 44100) < this.channels * 128) {
      this.port.postMessage({ type: 'position', position: this.position / (this.channels * sampleRate) });
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
  private analyser: AnalyserNode | null = null;
  private audioBuffer: Float32Array | null = null;
  private channels: number = 0;
  private sampleRate: number = 44100;
  private isPlaying: boolean = false;
  private duration: number = 0;
  private currentTime: number = 0;
  private onStateChange?: (state: PlayerState) => void;
  private onEndedCallback?: () => void;
  private useScriptProcessor: boolean = false;
  private workletUrl: string | null = null;

  constructor() {
    this.setupWorkletUrl();
  }

  private setupWorkletUrl() {
    // Create a blob URL for the worklet processor
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
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 2048;

      // Try AudioWorklet first
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

  async loadAudio(arrayBuffer: ArrayBuffer): Promise<void> {
    if (!this.audioContext) {
      await this.initialize();
    }

    this.notifyStateChange();

    try {
      // Stop current playback
      this.stop();

      // Decode the audio
      const decoder = new FlacDecoder();
      const decodedData = await decoder.decode(arrayBuffer);
      
      this.channels = decodedData.channels;
      this.sampleRate = decodedData.sampleRate;
      this.duration = decodedData.duration;
      this.currentTime = 0;

      // Interleave samples into a single Float32Array
      const length = decodedData.samples[0].length;
      const interleavedLength = length * this.channels;
      this.audioBuffer = new Float32Array(interleavedLength);

      for (let i = 0; i < length; i++) {
        for (let ch = 0; ch < this.channels; ch++) {
          this.audioBuffer[i * this.channels + ch] = decodedData.samples[ch][i];
        }
      }

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

  play(): void {
    if (!this.audioContext || !this.gainNode || !this.analyser || !this.audioBuffer) {
      console.error('[AudioWorkletPlayer] Not ready to play');
      return;
    }

    if (this.isPlaying) {
      return;
    }

    // Resume audio context if suspended
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }

    // Calculate start position in samples
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
    if (!this.audioContext || !this.gainNode || !this.analyser || !this.audioBuffer) return;

    this.workletNode = new AudioWorkletNode(this.audioContext, 'flac-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [this.channels],
      processorOptions: {
        sampleRate: this.sampleRate
      }
    });

    // Connect: worklet -> gain -> analyser -> destination
    this.workletNode.connect(this.gainNode);
    this.gainNode.connect(this.analyser);
    this.analyser.connect(this.audioContext.destination);

    // Send buffer to worklet
    (this.workletNode as AudioWorkletNode).port.postMessage({
      type: 'buffer',
      buffer: this.audioBuffer,
      channels: this.channels
    });

    // Handle messages from worklet
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

    // Seek to position
    if (startSample > 0) {
      (this.workletNode as AudioWorkletNode).port.postMessage({
        type: 'seek',
        position: this.currentTime
      });
    }
  }

  private createScriptProcessorNode(startSample: number): void {
    if (!this.audioContext || !this.gainNode || !this.analyser || !this.audioBuffer) return;

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
          // End of buffer
          for (let ch = 0; ch < output.numberOfChannels; ch++) {
            output.getChannelData(ch)[i] = 0;
          }
          if (i === 0 && this.isPlaying) {
            // Track ended
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

    // Connect: scriptProcessor -> gain -> analyser -> destination
    this.workletNode.connect(this.gainNode);
    this.gainNode.connect(this.analyser);
    this.analyser.connect(this.audioContext.destination);
  }

  pause(): void {
    if (!this.isPlaying) return;

    this.stopNode();
    this.isPlaying = false;
    this.notifyStateChange();
  }

  stop(): void {
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

  getAnalyser(): AnalyserNode {
    return this.analyser!;
  }

  destroy(): void {
    this.stop();
    if (this.gainNode) this.gainNode.disconnect();
    if (this.analyser) this.analyser.disconnect();
    if (this.audioContext) this.audioContext.close();
    if (this.workletUrl) URL.revokeObjectURL(this.workletUrl);
  }
}
