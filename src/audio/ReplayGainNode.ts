import { dbToLinear } from '../utils/replayGain';

/**
 * ReplayGain gain stage with optional soft limiter.
 *
 * Inserted before the user master volume fader so loudness normalization
 * is independent of the volume slider.
 *
 * The limiter is only in the chain while enabled. DynamicsCompressorNode is
 * clamped to two channels (`channelCountMode: 'clamped-max'`), so leaving it in
 * at ratio 1 downmixed 5.1 / 7.1 to stereo. Wider tracks are limited per channel
 * pair (front L/R, C/LFE, surround L/R, …) and merged back to full width.
 */
export class ReplayGainNode {
  readonly input: GainNode;
  readonly output: GainNode;
  private limiterEnabled = false;
  private channels = 2;
  /** Nodes between input and output while the limiter is on. */
  private limiterNodes: AudioNode[] = [];

  constructor(private readonly context: BaseAudioContext) {
    this.input = context.createGain();
    this.input.gain.value = 1;
    this.output = context.createGain();
    this.rewire();
  }

  setGainDb(db: number): void {
    this.input.gain.value = dbToLinear(db);
  }

  setGainLinear(linear: number): void {
    this.input.gain.value = Math.max(0, linear);
  }

  setLimiterEnabled(enabled: boolean): void {
    if (enabled === this.limiterEnabled) return;
    this.limiterEnabled = enabled;
    this.rewire();
  }

  /** Track width; the limiter splits into stereo pairs above 2 channels. */
  setChannelCount(channels: number): void {
    const count = Math.max(1, Math.floor(channels));
    if (count === this.channels) return;
    this.channels = count;
    if (this.limiterEnabled) this.rewire();
  }

  disconnect(): void {
    this.input.disconnect();
    this.limiterNodes.forEach((node) => node.disconnect());
    this.limiterNodes = [];
    this.output.disconnect();
  }

  private rewire(): void {
    this.input.disconnect();
    this.limiterNodes.forEach((node) => node.disconnect());
    this.limiterNodes = [];
    if (!this.limiterEnabled) {
      this.input.connect(this.output);
      return;
    }
    if (this.channels <= 2) {
      const limiter = this.createLimiter();
      this.limiterNodes.push(limiter);
      this.input.connect(limiter);
      limiter.connect(this.output);
      return;
    }
    const n = this.channels;
    const splitter = this.context.createChannelSplitter(n);
    const merger = this.context.createChannelMerger(n);
    this.limiterNodes.push(splitter, merger);
    for (let first = 0; first < n; first += 2) {
      const hasSecond = first + 1 < n;
      const pairIn = this.context.createChannelMerger(2);
      const limiter = this.createLimiter();
      const pairOut = this.context.createChannelSplitter(2);
      this.limiterNodes.push(pairIn, limiter, pairOut);
      splitter.connect(pairIn, first, 0);
      if (hasSecond) splitter.connect(pairIn, first + 1, 1);
      pairIn.connect(limiter);
      limiter.connect(pairOut);
      pairOut.connect(merger, 0, first);
      if (hasSecond) pairOut.connect(merger, 1, first + 1);
    }
    this.input.connect(splitter);
    merger.connect(this.output);
  }

  private createLimiter(): DynamicsCompressorNode {
    const limiter = this.context.createDynamicsCompressor();
    limiter.threshold.value = -1;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;
    return limiter;
  }
}
