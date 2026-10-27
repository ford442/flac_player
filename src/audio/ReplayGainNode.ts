import { dbToLinear } from '../utils/replayGain';

/**
 * ReplayGain gain stage with optional soft limiter.
 *
 * Inserted before the user master volume fader so loudness normalization
 * is independent of the volume slider.
 *
 * The limiter stage only exists while it is enabled: the spec clamps a
 * DynamicsCompressorNode to two channels, so one left in the chain "off"
 * (ratio 1) would still downmix 5.1 / 7.1 to stereo. Off, the gain feeds the
 * destination directly. On, up to stereo is one (channel-linked) compressor;
 * above stereo each channel gets its own behind a channel splitter, which
 * does not link them the way `dsp_chain.h` does, but is all Web Audio offers
 * without the worklet.
 */
export class ReplayGainNode {
  readonly input: GainNode;
  private readonly gainNode: GainNode;
  private destination: AudioNode | null = null;
  private limiterEnabled = false;
  private channels = 2;
  private limiter: LimiterStage | null = null;

  constructor(private readonly context: AudioContext) {
    this.gainNode = context.createGain();
    this.gainNode.gain.value = 1;
    this.input = this.gainNode;
  }

  /** Route the stage's output; replaces any earlier destination. */
  connect(destination: AudioNode): void {
    this.destination = destination;
    this.rewire();
  }

  disconnect(): void {
    this.destination = null;
    this.rewire();
  }

  setGainDb(db: number): void {
    this.gainNode.gain.value = dbToLinear(db);
  }

  setGainLinear(linear: number): void {
    this.gainNode.gain.value = Math.max(0, linear);
  }

  setLimiterEnabled(enabled: boolean): void {
    if (this.limiterEnabled === enabled) return;
    this.limiterEnabled = enabled;
    this.rewire();
  }

  /** Width of the signal the limiter must carry (the destination's channel count, >= 2). */
  setChannelCount(channels: number): void {
    const next = Math.max(2, Math.floor(channels));
    if (this.channels === next) return;
    this.channels = next;
    // Only a limiter built per channel depends on the width.
    if (this.limiter) this.rewire();
  }

  private rewire(): void {
    this.gainNode.disconnect();
    this.limiter?.dispose();
    this.limiter = null;
    if (!this.destination) return;
    if (!this.limiterEnabled) {
      this.gainNode.connect(this.destination);
      return;
    }
    this.limiter = buildLimiter(this.context, this.channels);
    this.gainNode.connect(this.limiter.entry);
    this.limiter.exit.connect(this.destination);
  }
}

interface LimiterStage {
  entry: AudioNode;
  exit: AudioNode;
  dispose(): void;
}

function createLimiterCompressor(context: AudioContext): DynamicsCompressorNode {
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -1;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.1;
  return limiter;
}

function buildLimiter(context: AudioContext, channels: number): LimiterStage {
  if (channels <= 2) {
    const limiter = createLimiterCompressor(context);
    return { entry: limiter, exit: limiter, dispose: () => limiter.disconnect() };
  }

  // Mix to the destination layout first so a wider source is downmixed the way
  // the destination would, not truncated by the splitter's discrete mapping.
  const mix = context.createGain();
  mix.channelCount = channels;
  mix.channelCountMode = 'explicit';
  mix.channelInterpretation = 'speakers';
  const split = context.createChannelSplitter(channels);
  const merge = context.createChannelMerger(channels);
  mix.connect(split);
  const limiters: DynamicsCompressorNode[] = [];
  for (let ch = 0; ch < channels; ch++) {
    const limiter = createLimiterCompressor(context);
    split.connect(limiter, ch, 0);
    limiter.connect(merge, 0, ch);
    limiters.push(limiter);
  }
  return {
    entry: mix,
    exit: merge,
    dispose: () => {
      mix.disconnect();
      split.disconnect();
      limiters.forEach((limiter) => limiter.disconnect());
      merge.disconnect();
    },
  };
}
