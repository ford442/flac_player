import { DEFAULT_EQ_BANDS } from '../audio/EQChain';
import { openAudioContext } from '../audio/contextContract';
import type { MiniEqPreset } from './types';

/** Gains (dB) per DEFAULT_EQ_BANDS band — the full app's band layout, reused. */
export const MINI_EQ_PRESETS: Record<MiniEqPreset, readonly number[]> = {
  flat: [0, 0, 0, 0, 0],
  bass: [5, 3, 0, 0, 0],
  vocal: [-2, -1, 2, 3, 1],
  bright: [0, 0, 0, 2, 4],
};

export interface MiniEqGraph {
  context: AudioContext;
  setPreset(preset: MiniEqPreset): void;
  resume(): void;
  close(): void;
}

/**
 * Route one <audio> element through biquads. Built lazily and only for a non-flat preset,
 * so the default embed never opens an AudioContext. A MediaElementSource is permanent for
 * its element, so the graph lives as long as the element does.
 */
export function attachEqGraph(audio: HTMLAudioElement, preset: MiniEqPreset): MiniEqGraph | null {
  if (typeof AudioContext === 'undefined') return null;
  const { context } = openAudioContext({ latencyHint: 'playback' });
  const source = context.createMediaElementSource(audio);
  const filters = DEFAULT_EQ_BANDS.map((band) => {
    const f = context.createBiquadFilter();
    f.type = band.type;
    f.frequency.value = band.frequency;
    f.Q.value = band.Q;
    return f;
  });
  let node: AudioNode = source;
  for (const f of filters) {
    node.connect(f);
    node = f;
  }
  node.connect(context.destination);
  const setPreset = (p: MiniEqPreset) => {
    const gains = MINI_EQ_PRESETS[p];
    filters.forEach((f, i) => { f.gain.value = gains[i] ?? 0; });
  };
  setPreset(preset);
  return {
    context,
    setPreset,
    resume: () => { if (context.state !== 'running') void context.resume().catch(() => {}); },
    close: () => { void context.close().catch(() => {}); },
  };
}
