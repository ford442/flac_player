import { EQChain } from './EQChain';

/**
 * Owns the application-lifetime Web Audio graph.
 *
 * Web Audio backends connect disposable source/input nodes to `input`; the
 * master Gain -> EQ -> Analyser -> destination chain is connected exactly once.
 * SDL owns its output device inside Emscripten and therefore cannot feed this
 * graph yet, but it still reuses the analyser instead of creating a dummy
 * AudioContext. The analyser intentionally contains silence while SDL is active.
 */
export class AudioContextManager {
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private eqChain: EQChain | null = null;
  private analyser: AnalyserNode | null = null;

  initialize(): AudioContext {
    if (this.context) return this.context;

    this.context = new AudioContext({ latencyHint: 'playback', sampleRate: 44100 });
    this.masterGain = this.context.createGain();
    this.eqChain = new EQChain(this.context);
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 2048;

    this.masterGain.connect(this.eqChain.input);
    this.eqChain.output.connect(this.analyser);
    this.analyser.connect(this.context.destination);
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
