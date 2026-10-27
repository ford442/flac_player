import { describe, expect, it } from 'vitest';
import {
  RecordingAudioContext,
  channelsAt,
  type RecordingAudioNode,
} from './helpers/recordingAudioContext';

/** The channel tests elsewhere are only as good as this model of the spec. */
describe('RecordingAudioContext channel model', () => {
  const node = (n: unknown) => n as RecordingAudioNode;

  it('clamps a DynamicsCompressorNode to stereo', () => {
    const ctx = new RecordingAudioContext();
    const source = node(ctx.createBufferSource());
    const compressor = node(ctx.createDynamicsCompressor());
    const sink = node(ctx.createGain());
    source.connect(compressor as unknown as AudioNode);
    compressor.connect(sink as unknown as AudioNode);

    expect(channelsAt(source, 6, compressor)).toBe(2);
    expect(channelsAt(source, 6, sink)).toBe(2);
    expect(channelsAt(source, 1, sink)).toBe(1);
  });

  it('lets a GainNode pass the widest input', () => {
    const ctx = new RecordingAudioContext();
    const source = node(ctx.createBufferSource());
    const gain = node(ctx.createGain());
    source.connect(gain as unknown as AudioNode);
    expect(channelsAt(source, 6, gain)).toBe(6);
  });

  it('splits to mono per output and merges back to one channel per input', () => {
    const ctx = new RecordingAudioContext();
    const source = node(ctx.createBufferSource());
    const split = node(ctx.createChannelSplitter(6));
    const merge = node(ctx.createChannelMerger(6));
    const through = node(ctx.createGain());
    source.connect(split as unknown as AudioNode);
    split.connect(through as unknown as AudioNode, 2, 0);
    through.connect(merge as unknown as AudioNode, 0, 2);

    expect(channelsAt(source, 6, through)).toBe(1);
    expect(channelsAt(source, 6, merge)).toBe(6);
  });
});
