import { DEFAULT_EQ_BANDS } from './EQChain';
import { assetUrl } from '../utils/publicPath';
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
 * Speaker DSP (ReplayGain -> limiter -> volume -> pitch hold -> EQ) as one
 * AudioWorkletNode running src/sdl/dsp_chain.h compiled to
 * public/dsp-chain.wasm, for every backend (the `sdl` engine plays into it
 * too). AudioContextManager wires it between the backend input and the
 * analyser and keeps ReplayGainNode / EQChain as the fallback when the module
 * or AudioWorklet is unavailable (mirrors SpeexDSP → linear resampling). The
 * fallback has no pitch hold: the speed control is then varispeed.
 *
 * The processor also copies its output into an analysis ring (analysisRing.ts)
 * when the page is cross-origin isolated — the Web Audio backends' side of the
 * shared PCM tap that SDL writes from its audio callback.
 */

const DSP_CHAIN_PROCESSOR_URL = new URL('./worklets/dspChainProcessor.js', import.meta.url);
export const DSP_CHAIN_WASM_URL = assetUrl('dsp-chain.wasm');
/** dsp_chain.h DSP_MAX_CHANNELS. */
export const DSP_MAX_CHANNELS = 8;
const READY_TIMEOUT_MS = 3000;

export interface DspChainSettings {
  /** dB per DEFAULT_EQ_BANDS entry. */
  eqGains: number[];
  replayGainLinear: number;
  limiter: boolean;
  volume: number;
  /** Varispeed rate of the source feeding the chain (1 when an `<audio>` element holds pitch). */
  playbackRate: number;
  /** Transpose by 1/playbackRate in the worklet so only the tempo changes. */
  preservePitch: boolean;
}

const FLAT_SETTINGS: DspChainSettings = {
  eqGains: DEFAULT_EQ_BANDS.map(() => 0),
  replayGainLinear: 1,
  limiter: false,
  volume: 1,
  playbackRate: 1,
  preservePitch: true,
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

function waitForReady(node: AudioWorkletNode): Promise<{ stretchLatencyFrames: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      node.port.onmessage = null;
      reject(new Error(`dsp-chain processor not ready after ${READY_TIMEOUT_MS} ms`));
    }, READY_TIMEOUT_MS);
    node.port.onmessage = (e: MessageEvent<DspChainOutbound>) => {
      clearTimeout(timer);
      node.port.onmessage = null;
      if (e.data.type === 'ready') resolve({ stretchLatencyFrames: e.data.stretchLatencyFrames });
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
      playbackRate: s.playbackRate,
      preservePitch: s.preservePitch,
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
    let ready: { stretchLatencyFrames: number };
    try {
      ready = await waitForReady(node);
    } catch (err) {
      node.disconnect();
      node.port.close();
      throw err;
    }
    const reader = analysisRing ? readerForRingBuffer(analysisRing) : null;
    return new DspChainNode(node, count, reader, Math.max(0, ready.stretchLatencyFrames | 0), context.sampleRate);
  }

  private constructor(
    readonly node: AudioWorkletNode,
    readonly channels: number,
    /** The processor's output tap; null when SharedArrayBuffer is unavailable. */
    readonly analysisRing: AnalysisRingReader | null,
    /** Delay the pitch-hold stage adds while engaged; 0 = no pitch hold at this format. */
    readonly stretchLatencyFrames: number,
    private readonly sampleRate: number,
  ) {}

  /** True when the worklet can hold pitch at this node's channel count × context rate. */
  get canHoldPitch(): boolean {
    return this.stretchLatencyFrames > 0;
  }

  /** Pitch-hold latency in seconds (0 when unavailable). */
  get stretchLatency(): number {
    return this.sampleRate > 0 ? this.stretchLatencyFrames / this.sampleRate : 0;
  }

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

  /** The source plays at `rate` (varispeed); with `preservePitch` the worklet transposes back. */
  setPlaybackRate(rate: number, preservePitch: boolean): void {
    this.post({ type: 'playbackRate', rate, preservePitch });
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
