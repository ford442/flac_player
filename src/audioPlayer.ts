// Audio player with load/play/pause/seek functionality
import { decodeAudioWithBuffer } from './audioDecoder';
import { EQChain } from './audio/EQChain';

export interface PlayerState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  isLoading: boolean;
}

export class AudioPlayer {
  private audioContext: AudioContext;
  private sourceNode: AudioBufferSourceNode | null = null;
  private gainNode: GainNode;
  private eqChain: EQChain;
  private analyser: AnalyserNode;
  private audioBuffer: AudioBuffer | null = null;
  private startTime: number = 0;
  private pausedAt: number = 0;
  private rateAtPause: number = 1.0;
  private isPlaying: boolean = false;
  private playbackRate: number = 1.0;
  private onStateChange?: (state: PlayerState) => void;

  constructor() {
    this.audioContext = new AudioContext();
    this.gainNode = this.audioContext.createGain();
    this.eqChain = new EQChain(this.audioContext);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 2048;

    this.gainNode.connect(this.eqChain.input);
    this.eqChain.output.connect(this.analyser);
    this.analyser.connect(this.audioContext.destination);
  }

  private onEndedCallback?: () => void;

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
    this.notifyStateChange();

    try {
      // Stop current playback
      this.stop();

      // Decode the audio (auto-detects FLAC vs native formats like MP3)
      const { decoderResult, audioBuffer: nativeBuffer } = await decodeAudioWithBuffer(
        arrayBuffer,
        this.audioContext,
        filename
      );

      // If we have the original native AudioBuffer, use it directly (more efficient)
      if (nativeBuffer) {
        this.audioBuffer = nativeBuffer;
      } else {
        // Otherwise, reconstruct from interleaved buffer (for FLAC)
        const frameCount = decoderResult.interleavedBuffer.length / decoderResult.channels;
        this.audioBuffer = this.audioContext.createBuffer(
          decoderResult.channels,
          frameCount,
          decoderResult.sampleRate
        );

        // Use typed array operations for better performance
        const interleaved = decoderResult.interleavedBuffer;
        for (let ch = 0; ch < decoderResult.channels; ch++) {
          const channelData = this.audioBuffer.getChannelData(ch);
          // Copy channel data using stride
          for (let i = 0, idx = ch; i < frameCount; i++, idx += decoderResult.channels) {
            channelData[i] = interleaved[idx];
          }
        }
      }

      this.pausedAt = 0;
      this.notifyStateChange();
    } catch (error) {
      console.error('Error loading audio:', error);
      throw error;
    }
  }

  play(): void {
    if (!this.audioBuffer) {
      console.error('No audio loaded');
      return;
    }

    if (this.isPlaying) {
      return;
    }

    // Resume audio context if suspended
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }

    // Create and configure source node
    this.sourceNode = this.audioContext.createBufferSource();
    this.sourceNode.buffer = this.audioBuffer;
    this.sourceNode.connect(this.gainNode);

    // Handle playback end
    this.sourceNode.onended = () => {
      if (this.isPlaying) {
        this.isPlaying = false;
        this.pausedAt = 0;
        this.notifyStateChange();
        if (this.onEndedCallback) {
          try { this.onEndedCallback(); } catch (err) { console.warn('onEnded callback threw', err); }
        }
      }
    };

    // Apply playback rate
    this.sourceNode.playbackRate.value = this.playbackRate;

    // Start playback from the paused position
    this.startTime = this.audioContext.currentTime - this.pausedAt / this.playbackRate;
    this.sourceNode.start(0, this.pausedAt);
    this.isPlaying = true;

    this.notifyStateChange();
  }

  pause(): void {
    if (!this.isPlaying || !this.sourceNode) {
      return;
    }

    // Capture the rate used during this segment before stopping
    this.rateAtPause = this.playbackRate;
    // Calculate current position (adjusted for the rate that was actually playing)
    this.pausedAt = (this.audioContext.currentTime - this.startTime) * this.rateAtPause;

    // Stop the source node
    this.sourceNode.stop();
    this.sourceNode.disconnect();
    this.sourceNode = null;

    this.isPlaying = false;
    this.notifyStateChange();
  }

  stop(): void {
    if (this.sourceNode) {
      this.sourceNode.stop();
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    this.isPlaying = false;
    this.pausedAt = 0;
    this.startTime = 0;
    this.notifyStateChange();
  }

  seek(time: number): void {
    if (!this.audioBuffer) {
      return;
    }

    const wasPlaying = this.isPlaying;

    if (this.isPlaying) {
      this.pause();
    }

    this.pausedAt = Math.max(0, Math.min(time, this.audioBuffer.duration));

    if (wasPlaying) {
      this.play();
    }

    this.notifyStateChange();
  }

  getCurrentTime(): number {
    if (!this.audioBuffer) {
      return 0;
    }

    if (this.isPlaying) {
      return Math.min(
        (this.audioContext.currentTime - this.startTime) * this.playbackRate,
        this.audioBuffer.duration
      );
    }

    return this.pausedAt;
  }

  getDuration(): number {
    return this.audioBuffer ? this.audioBuffer.duration : 0;
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
    this.gainNode.gain.value = Math.max(0, Math.min(1, volume));
  }

  setPlaybackRate(rate: number): void {
    const clampedRate = Math.max(0.25, Math.min(4.0, rate));
    if (this.isPlaying && this.sourceNode) {
      // Recalculate startTime so getCurrentTime() stays accurate after rate change
      const currentPos = this.getCurrentTime();
      this.playbackRate = clampedRate;
      this.sourceNode.playbackRate.value = clampedRate;
      this.startTime = this.audioContext.currentTime - currentPos / clampedRate;
    } else {
      this.playbackRate = clampedRate;
    }
  }

  setEQBandGain(bandIndex: number, gainDb: number): void {
    this.eqChain.setBandGain(bandIndex, gainDb);
  }

  getEQGains(): number[] {
    return this.eqChain.getAllGains();
  }

  getAnalyser(): AnalyserNode {
    return this.analyser;
  }

  destroy(): void {
    this.stop();
    this.gainNode.disconnect();
    this.eqChain.disconnect();
    this.analyser.disconnect();
    this.audioContext.close();
  }
}
