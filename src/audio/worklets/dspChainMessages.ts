/**
 * Message protocol between DspChainNode (main thread) and the `dsp-chain`
 * AudioWorkletProcessor (dspChainProcessor.js), which runs src/sdl/dsp_chain.h
 * compiled to public/dsp-chain.wasm. The processor imports these via JSDoc so
 * `npm run typecheck` covers both sides.
 */

export const DSP_CHAIN_PROCESSOR_NAME = 'dsp-chain';

export interface DspChainEqBand {
  filterType: number;
  frequency: number;
  q: number;
  gainDb: number;
}

/** Settings applied before the first render quantum (later changes are messages). */
export interface DspChainInitialState {
  eqBands: DspChainEqBand[];
  replayGain: number;
  limiter: boolean;
  volume: number;
}

/** processorOptions for the `dsp-chain` processor. */
export interface DspChainOptions {
  /** Compiled module (preferred) or the raw bytes when Module cloning is unavailable. */
  wasm: WebAssembly.Module | ArrayBuffer;
  channels: number;
  initial: DspChainInitialState;
}

/** EQ type codes shared with dsp_chain.h (DspEqType) and the SDL `_set_eq_band` export. */
export const DSP_EQ_TYPE_CODES: Partial<Record<BiquadFilterType, number>> = {
  lowshelf: 0,
  peaking: 1,
  highshelf: 2,
};

/** Main thread → processor. */
export type DspChainInbound =
  | ({ type: 'eqBand'; index: number } & DspChainEqBand)
  | { type: 'replayGain'; linear: number; limiter: boolean }
  | { type: 'volume'; volume: number }
  /** Clear filter / limiter history (seek, new stream). */
  | { type: 'reset' };

/** Processor → main thread. Exactly one of these after construction. */
export type DspChainOutbound =
  | { type: 'ready' }
  | { type: 'error'; message: string };
