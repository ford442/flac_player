import { DEFAULT_EQ_BANDS } from './EQChain';
import { createAnalysisRingBuffer, readerForRingBuffer, type AnalysisRingReader } from './analysisRing';
import {
  DSP_CHAIN_PROCESSOR_NAME,
  DSP_EQ_TYPE_CODES,
  type DspChainEqBand,
  type DspChainInbound,
  type DspChainOptions,
  type DspChainOutbound,
} from './worklets/dspChainMessages';

/**
 * Speaker DSP (ReplayGain -> limiter -> volume -> EQ) as one AudioWorkletNode
 * running src/sdl/dsp_chain.h compiled to public/dsp-chain.wasm — the same
 * code SDL runs in its audio callback. AudioContextManager wires it between
 * the backend input and the analyser and keeps ReplayGainNode / EQChain as the
 * fallback when the module or AudioWorklet is unavailable (mirrors SpeexDSP →
 * linear resampling).
 *
 * The processor also copies its output into an analysis ring (analysisRing.ts)
 * when the page is cross-origin isolated — the Web Audio backends' side of the
 * shared PCM tap that SDL writes from its audio callback.
 */

const DSP_CHAIN_PROCESSOR_URL = new URL('./worklets/dspChainProcessor.js', import.meta.url);
export const DSP_CHAIN_WASM_URL = '/dsp-chain.wasm';
/** dsp_chain.h DSP_MAX_CHANNELS. */
export const DSP_MAX_CHANNELS = 8;
const READY_TIMEOUT_MS = 3000;

export interface DspChainSettings {
  /** dB per DEFAULT_EQ_BANDS entry. */
  eqGains: number[];
  replayGainLinear: number;
  limiter: boolean;
  volume: number;
}

const FLAT_SETTINGS: DspChainSettings = {
  eqGains: DEFAULT_EQ_BANDS.map(() => 0),
  replayGainLinear: 1,
  limiter: false,
  volume: 1,
};

/** DEFAULT_EQ_BANDS layout with the given gains, in the dsp_chain.h encoding. */
function eqBands(gains: number[]): DspChainEqBand[] {
  return DEFAULT_EQ_BANDS.map((band, index) => ({
    filterType: DSP_EQ_TYPE_CODES[band.type] ?? 1,
    frequency: band.frequency,
    q: band.Q,
    gainDb: gains[index] ?? 0,
  }));
}

interface LoadedDspWasm {
  module: WebAssembly.Module;
  bytes: ArrayBuffer;
}

let wasmPromise: Promise<LoadedDspWasm> | null = null;
const modulesAdded = new WeakMap<BaseAudioContext, Promise<void>>();

/** public/dsp-chain.wasm, fetched and compiled once (also used by wasmFft.ts). */
export function loadDspWasm(): Promise<LoadedDspWasm> {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      const res = await fetch(DSP_CHAIN_WASM_URL);
      if (!res.ok) throw new Error(`${DSP_CHAIN_WASM_URL}: HTTP ${res.status}`);
      const bytes = await res.arrayBuffer();
      return { module: await WebAssembly.compile(bytes), bytes };
    })();
    // A failed load is retried by the next graph rather than cached forever.
    wasmPromise.catch(() => {
      wasmPromise = null;
    });
  }
  return wasmPromise;
}

function addProcessorModule(context: BaseAudioContext): Promise<void> {
  let added = modulesAdded.get(context);
  if (!added) {
    added = context.audioWorklet.addModule(DSP_CHAIN_PROCESSOR_URL.href);
    modulesAdded.set(context, added);
    added.catch(() => modulesAdded.delete(context));
  }
  return added;
}

/** `?dsp=webaudio` forces the BiquadFilterNode / DynamicsCompressorNode graph (A/B, debugging). */
export function isDspWasmDisabledByUrl(): boolean {
  if (typeof window === 'undefined' || !window.location) return false;
  try {
    return new URLSearchParams(window.location.search).get('dsp') === 'webaudio';
  } catch {
    return false;
  }
}

export function isDspWasmSupported(context: BaseAudioContext): boolean {
  return typeof AudioWorkletNode !== 'undefined'
    && typeof WebAssembly !== 'undefined'
    && typeof fetch === 'function'
    && !!context.audioWorklet;
}

function waitForReady(node: AudioWorkletNode): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      node.port.onmessage = null;
      reject(new Error(`dsp-chain processor not ready after ${READY_TIMEOUT_MS} ms`));
    }, READY_TIMEOUT_MS);
    node.port.onmessage = (e: MessageEvent<DspChainOutbound>) => {
      clearTimeout(timer);
      node.port.onmessage = null;
      if (e.data.type === 'ready') resolve();
      else reject(new Error(`dsp-chain processor: ${e.data.message}`));
    };
  });
}

export class DspChainNode {
  /**
   * Load the module (cached), register the processor on `context`, and resolve
   * once the processor has instantiated the WASM. Rejects on any failure; the
   * caller keeps the Web Audio fallback graph. `settings` are applied before
   * the first render quantum; use the setters for later changes.
   */
  static async create(
    context: BaseAudioContext,
    channels: number,
    settings: Partial<DspChainSettings> = {}
  ): Promise<DspChainNode> {
    const s = { ...FLAT_SETTINGS, ...settings };
    const initial = {
      eqBands: eqBands(s.eqGains),
      replayGain: Math.max(0, s.replayGainLinear),
      limiter: s.limiter,
      volume: s.volume,
    };
    const count = Math.max(1, Math.min(DSP_MAX_CHANNELS, Math.floor(channels)));
    const [wasm] = await Promise.all([loadDspWasm(), addProcessorModule(context)]);
    const analysisRing = createAnalysisRingBuffer();
    const construct = (payload: DspChainOptions['wasm']) => new AudioWorkletNode(context, DSP_CHAIN_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [count],
      // Fixed width: Web Audio up/down-mixes the input ('speakers') before the processor.
      channelCount: count,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { wasm: payload, channels: count, initial, analysisRing } satisfies DspChainOptions,
    });
    let node: AudioWorkletNode;
    try {
      node = construct(wasm.module);
    } catch (err) {
      // WebAssembly.Module is not cloneable into the worklet here; compile there instead.
      if (!(err instanceof DOMException && err.name === 'DataCloneError')) throw err;
      node = construct(wasm.bytes.slice(0));
    }
    try {
      await waitForReady(node);
    } catch (err) {
      node.disconnect();
      node.port.close();
      throw err;
    }
    return new DspChainNode(node, count, analysisRing ? readerForRingBuffer(analysisRing) : null);
  }

  private constructor(
    readonly node: AudioWorkletNode,
    readonly channels: number,
    /** The processor's output tap; null when SharedArrayBuffer is unavailable. */
    readonly analysisRing: AnalysisRingReader | null,
  ) {}

  private post(msg: DspChainInbound): void {
    this.node.port.postMessage(msg);
  }

  /** Gains (dB) per DEFAULT_EQ_BANDS entry; band layout is pushed with them. */
  setEQGains(gains: number[]): void {
    eqBands(gains).forEach((band, index) => this.post({ type: 'eqBand', index, ...band }));
  }

  setReplayGain(linear: number, limiter: boolean): void {
    this.post({ type: 'replayGain', linear: Math.max(0, linear), limiter });
  }

  setVolume(volume: number): void {
    this.post({ type: 'volume', volume });
  }

  reset(): void {
    this.post({ type: 'reset' });
  }

  disconnect(): void {
    try {
      this.node.disconnect();
    } catch {
      /* already disconnected */
    }
    this.node.port.close();
  }
}
