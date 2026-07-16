import { EQChain } from './EQChain';

/**
 * Owns the application-lifetime Web Audio graph.
 *
 * Web Audio backends connect disposable source/input nodes to `input`; the
 * master Gain -> EQ -> Analyser -> destination chain is connected exactly once.
 * SDL backends tap PCM into the analyser via {@link connectVisualizerFeed} while
 * {@link setExternalPlaybackActive} mutes Web Audio speakers (SDL owns output).
 */
export class AudioContextManager {
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private eqChain: EQChain | null = null;
  private analyser: AnalyserNode | null = null;
  private speakerGain: GainNode | null = null;
  private visualizerFeedGain: GainNode | null = null;
  private externalPlaybackActive = false;

  initialize(): AudioContext {
    if (this.context) return this.context;

    this.context = new AudioContext({ latencyHint: 'playback', sampleRate: 44100 });
    this.masterGain = this.context.createGain();
    this.eqChain = new EQChain(this.context);
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 2048;
    this.speakerGain = this.context.createGain();
    this.visualizerFeedGain = this.context.createGain();
    this.visualizerFeedGain.gain.value = 1;

    this.masterGain.connect(this.eqChain.input);
    this.eqChain.output.connect(this.analyser);
    this.visualizerFeedGain.connect(this.analyser);
    this.analyser.connect(this.speakerGain);
    this.speakerGain.connect(this.context.destination);
    return this.context;
  }

  getContext(): AudioContext {
    return this.initialize();
  }

  getAnalyser(): AnalyserNode {
    this.initialize();
    return this.analyser!;
  }

  connectInput(node: AudioNode): void {
    this.initialize();
    node.connect(this.masterGain!);
  }

  /** Feed SDL PCM tap worklet into the analyser (parallel to masterGain path). */
  connectVisualizerFeed(node: AudioNode): void {
    this.initialize();
    node.connect(this.visualizerFeedGain!);
  }

  /** Mute Web Audio speakers when SDL owns playback; analyser still receives PCM. */
  setExternalPlaybackActive(active: boolean): void {
    this.initialize();
    this.externalPlaybackActive = active;
    this.speakerGain!.gain.value = active ? 0 : 1;
  }

  isExternalPlaybackActive(): boolean {
    return this.externalPlaybackActive;
  }

  async resume(): Promise<void> {
    const context = this.initialize();
    if (context.state === 'suspended') await context.resume();
  }

  setVolume(volume: number): void {
    this.initialize();
    this.masterGain!.gain.value = Math.max(0, Math.min(1, volume));
  }

  setEQGains(gains: number[]): void {
    this.initialize();
    this.eqChain!.setAllGains(gains);
  }

  getEQGains(): number[] {
    this.initialize();
    return this.eqChain!.getAllGains();
  }
}

export const sharedAudioContextManager = new AudioContextManager();
