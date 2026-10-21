import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioContextManager } from '../../src/audio/AudioContextManager';
import { createAudioBackend } from '../../src/audio/createAudioBackend';
import type { AudioOutputMode } from '../../src/types/audio';

// #259 A1: 5.1 / 7.1 must reach the destination at full width on every speaker-DSP
// path. The old fallback kept a DynamicsCompressorNode (clamped to 2 channels) in
// the chain even with the limiter off, so surround was downmixed to stereo.
//
// An AudioWorklet probe on the analyser output (the node that feeds the speaker
// gain and destination) reports the channel count and per-channel energy. Each
// fixture channel is a different sine, so a stereo downmix re-upmixed by a later
// 'speakers' node still fails: channels 3+ would be silent.

const PROBE_SOURCE = `
class ChannelProbe extends AudioWorkletProcessor {
  constructor() {
    super();
    this.energy = [];
    this.port.onmessage = () => {
      this.port.postMessage({ channels: this.energy.length, energy: this.energy.slice() });
      this.energy = [];
    };
  }
  process(inputs) {
    const input = inputs[0];
    if (input.length !== this.energy.length) this.energy = new Array(input.length).fill(0);
    for (let ch = 0; ch < input.length; ch++) {
      let sum = 0;
      for (const x of input[ch]) sum += x * x;
      this.energy[ch] += sum;
    }
    return true;
  }
}
registerProcessor('channel-probe', ChannelProbe);
`;

interface ProbeReport {
  channels: number;
  energy: number[];
}

/**
 * Headless Chromium has a stereo fake device; let the graph size itself for surround.
 * The real destination still refuses > 2 channels (the manager logs and keeps
 * going), so the probe sits on the node that feeds it.
 */
function pretendSurroundDevice(): () => void {
  const warn = console.warn.bind(console);
  const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    if (!String(args[0]).includes('destination.channelCount rejected')) warn(...args);
  });
  const proto = AudioDestinationNode.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, 'maxChannelCount')!;
  Object.defineProperty(proto, 'maxChannelCount', {
    configurable: true,
    get(this: AudioDestinationNode) {
      return Math.max(8, original.get!.call(this) as number);
    },
  });
  return () => {
    Object.defineProperty(proto, 'maxChannelCount', original);
    spy.mockRestore();
  };
}

function setDspQuery(engine: 'wasm' | 'webaudio'): void {
  const url = new URL(window.location.href);
  if (engine === 'webaudio') url.searchParams.set('dsp', 'webaudio');
  else url.searchParams.delete('dsp');
  window.history.replaceState(null, '', url);
}

async function probeChannels(
  mode: AudioOutputMode,
  fixture: string,
  options: { dsp: 'wasm' | 'webaudio'; limiter: boolean },
): Promise<{ report: ProbeReport; dspEngine: string }> {
  setDspQuery(options.dsp);
  const manager = new AudioContextManager();
  manager.setReplayGainLimiter(options.limiter);
  const backend = await createAudioBackend(mode, manager);
  try {
    await backend.initialize();
    const bytes = await (await fetch(new URL(`/tests/fixtures/${fixture}`, window.location.origin))).arrayBuffer();
    await backend.loadFromArrayBuffer(bytes, fixture);

    const ctx = manager.getContext();
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([PROBE_SOURCE], { type: 'text/javascript' })));
    const probe = new AudioWorkletNode(ctx, 'channel-probe', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCountMode: 'max',
    });
    manager.getAnalyser()!.connect(probe);

    await manager.resume();
    await backend.play();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const report = await new Promise<ProbeReport>((resolve) => {
      probe.port.onmessage = (e: MessageEvent<ProbeReport>) => resolve(e.data);
      probe.port.postMessage('report');
    });
    probe.disconnect();
    return { report, dspEngine: manager.getDspEngine() };
  } finally {
    backend.destroy();
    if (manager.hasContext()) await manager.getContext().close();
  }
}

describe('surround reaches the destination at full width (#259 A1)', () => {
  let restoreDevice: (() => void) | null = null;
  afterEach(() => {
    restoreDevice?.();
    restoreDevice = null;
    setDspQuery('wasm');
  });

  const cases = [
    { fixture: 'surround-5.1.flac', channels: 6 },
    { fixture: 'surround-7.1.flac', channels: 8 },
  ];
  const paths = [
    { dsp: 'wasm', limiter: true },
    { dsp: 'webaudio', limiter: false },
    { dsp: 'webaudio', limiter: true },
  ] as const;

  for (const { fixture, channels } of cases) {
    for (const path of paths) {
      it(`${fixture} through ${path.dsp} DSP, limiter ${path.limiter ? 'on' : 'off'}`, async () => {
        restoreDevice = pretendSurroundDevice();
        const { report, dspEngine } = await probeChannels('web-audio', fixture, path);
        expect(dspEngine).toBe(path.dsp === 'wasm' ? 'wasm' : 'web-audio');
        expect(report.channels).toBe(channels);
        // Every channel carries its own sine (none silent, none zero-filled by an upmix).
        const quietest = Math.min(...report.energy);
        expect(quietest).toBeGreaterThan(1);
      });
    }
  }
});
