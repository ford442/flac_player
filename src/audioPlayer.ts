// Audio player with load/play/pause/seek functionality
import { FlacDecoder } from './flacDecoder';

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
  private analyser: AnalyserNode;
  private audioBuffer: AudioBuffer | null = null;
  private startTime: number = 0;
  private pausedAt: number = 0;
  private isPlaying: boolean = false;
  private onStateChange?: (state: PlayerState) => void;

  constructor() {
    this.audioContext = new AudioContext();
    this.gainNode = this.audioContext.createGain();
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 2048;
    
    this.gainNode.connect(this.analyser);
    this.analyser.connect(this.audioContext.destination);
  }

  setStateChangeCallback(callback: (state: PlayerState) => void): void {
    this.onStateChange = callback;
  }

  private notifyStateChange(): void {
    if (this.onStateChange) {
      this.onStateChange(this.getState());
    }
  }

  async loadAudio(arrayBuffer: ArrayBuffer): Promise<void> {
    this.notifyStateChange();
    
    try {
      // Stop current playback
      this.stop();

      // Decode the audio
      const decoder = new FlacDecoder();
      const decodedData = await decoder.decode(arrayBuffer);
      this.audioBuffer = await decoder.createAudioBuffer(decodedData);
      
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
      }
    };

    // Start playback from the paused position
    this.startTime = this.audioContext.currentTime - this.pausedAt;
    this.sourceNode.start(0, this.pausedAt);
    this.isPlaying = true;
    
    this.notifyStateChange();
  }

  pause(): void {
    if (!this.isPlaying || !this.sourceNode) {
      return;
    }

    // Calculate current position
    this.pausedAt = this.audioContext.currentTime - this.startTime;
    
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
        this.audioContext.currentTime - this.startTime,
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

  getAnalyser(): AnalyserNode {
    return this.analyser;
  }

  destroy(): void {
    this.stop();
    this.gainNode.disconnect();
    this.analyser.disconnect();
    this.audioContext.close();
  }
}
