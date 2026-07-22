import { dbToLinear } from '../utils/replayGain';

/**
 * ReplayGain gain stage with optional soft limiter.
 *
 * Inserted before the user master volume fader so loudness normalization
 * is independent of the volume slider.
 */
export class ReplayGainNode {
  readonly input: GainNode;
  readonly output: AudioNode;
  private gainNode: GainNode;
  private limiter: DynamicsCompressorNode;

  constructor(private readonly context: AudioContext) {
    this.gainNode = context.createGain();
    this.gainNode.gain.value = 1;
    this.limiter = context.createDynamicsCompressor();
    this.limiter.threshold.value = 0;
    this.limiter.knee.value = 40;
    this.limiter.ratio.value = 1;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.1;
    this.gainNode.connect(this.limiter);
    this.input = this.gainNode;
    this.output = this.limiter;
  }

  setGainDb(db: number): void {
    this.gainNode.gain.value = dbToLinear(db);
  }

  setGainLinear(linear: number): void {
    this.gainNode.gain.value = Math.max(0, linear);
  }

  setLimiterEnabled(enabled: boolean): void {
    if (enabled) {
      this.limiter.threshold.value = -1;
      this.limiter.knee.value = 0;
      this.limiter.ratio.value = 20;
    } else {
      this.limiter.threshold.value = 0;
      this.limiter.knee.value = 40;
      this.limiter.ratio.value = 1;
    }
  }
}
