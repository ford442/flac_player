import { describe, expect, it } from 'vitest';
import { AudioContextManager } from '../../src/audio/AudioContextManager';
import { DspChainNode } from '../../src/audio/DspChainNode';
import { EQChain } from '../../src/audio/EQChain';

// A/B: the dsp-chain worklet (dsp_chain.h in WASM — the code SDL runs) against
// the BiquadFilterNode fallback, on steady tones. Documented epsilon:
// docs/AUDIO_BACKENDS.md "Speaker DSP".
const RATE = 48000;
const SECONDS = 1;
const EPSILON_DB = 0.01;

function rmsDbTail(buffer: AudioBuffer): number {
  const data = buffer.getChannelData(0);
  const from = Math.floor(data.length / 2);
  let sum = 0;
  for (let i = from; i < data.length; i++) sum += data[i] * data[i];
  return 10 * Math.log10(sum / (data.length - from));
}

async function renderTone(
  freq: number,
  insert: (ctx: OfflineAudioContext, source: AudioNode) => Promise<AudioNode>
): Promise<number> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: RATE * SECONDS, sampleRate: RATE });
  const osc = new OscillatorNode(ctx, { frequency: freq });
  const level = new GainNode(ctx, { gain: 0.25 });
  osc.connect(level);
  const out = await insert(ctx, level);
  out.connect(ctx.destination);
  osc.start();
  return rmsDbTail(await ctx.startRendering());
}

describe('dsp-chain worklet vs BiquadFilterNode', () => {
  it('matches the Web Audio EQ within the documented epsilon', async () => {
    const gains = [6, -3, 4, -6, 9];
    for (const freq of [60, 250, 1000, 4000, 12000]) {
      const dry = await renderTone(freq, async (_ctx, src) => src);
      const viaBiquad = await renderTone(freq, async (ctx, src) => {
        const eq = new EQChain(ctx as unknown as AudioContext);
        eq.setAllGains(gains);
        src.connect(eq.input);
        return eq.output;
      });
      const viaWasm = await renderTone(freq, async (ctx, src) => {
        const dsp = await DspChainNode.create(ctx, 2, { eqGains: gains });
        src.connect(dsp.node);
        return dsp.node;
      });
      const diff = Math.abs((viaWasm - dry) - (viaBiquad - dry));
      expect(diff, `${freq} Hz: wasm ${viaWasm - dry} dB vs biquad ${viaBiquad - dry} dB`).toBeLessThan(EPSILON_DB);
    }
  });

  it('runs ReplayGain and volume in the worklet', async () => {
    const dry = await renderTone(1000, async (_ctx, src) => src);
    const wet = await renderTone(1000, async (ctx, src) => {
      const dsp = await DspChainNode.create(ctx, 2, { replayGainLinear: 0.5, volume: 0.5 });
      src.connect(dsp.node);
      return dsp.node;
    });
    expect(wet - dry).toBeCloseTo(20 * Math.log10(0.25), 2);
  });
});

describe('AudioContextManager speaker DSP', () => {
  it('routes Web Audio backends through the WASM DSP worklet', async () => {
    const manager = new AudioContextManager();
    const ctx = await manager.ensureForTrack({ sampleRate: RATE, channels: 2 });
    expect(manager.getDspEngine()).toBe('wasm');
    expect(manager.getOutputInfo()?.dspEngine).toBe('wasm');
    await ctx.close();
  });
});
