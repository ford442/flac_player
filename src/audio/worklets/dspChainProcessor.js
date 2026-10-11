// @ts-check
/* global sampleRate */
// AudioWorkletProcessor running the speaker DSP chain from src/sdl/dsp_chain.h
// (ReplayGain -> limiter -> volume -> EQ) compiled to public/dsp-chain.wasm by
// scripts/build-dsp-wasm.sh. Same object code as the SDL audio callback, so the
// Web Audio backends and SDL sound identical. Static same-origin module (no blob
// URL). Message types live in dspChainMessages.ts.
//
// The module is STANDALONE_WASM with no imports: it is instantiated
// synchronously here and never touches the network from the audio thread.
//
// The processed output is also copied into the analysis ring (header layout in
// src/audio/analysisRing.ts / src/sdl/analysis_ring.h) when one is passed —
// a memcpy per quantum; analysis itself runs on the readers' threads.

// analysisRing.ts header words (this static module cannot import TS).
const RING_WRITE_POS = 0;
const RING_GENERATION = 1;
const RING_CAPACITY = 2;
const RING_CHANNELS = 3;
const RING_SAMPLE_RATE = 4;
const RING_HEADER_BYTES = 32;
/** analysisRing.ts ANALYSIS_RING_MAX_BLOCK: publish writePos at least this often. */
const RING_MAX_BLOCK = 8192;

/** @typedef {import('./dspChainMessages').DspChainInbound} DspInbound */
/** @typedef {import('./dspChainMessages').DspChainOutbound} DspOutbound */
/** @typedef {import('./dspChainMessages').DspChainOptions} DspOptions */

/**
 * @typedef {object} DspExports
 * @property {WebAssembly.Memory} memory
 * @property {() => void} [_initialize]
 * @property {() => number} scratch_ptr
 * @property {() => number} scratch_floats
 * @property {(index: number, type: number, freq: number, q: number, gainDb: number) => void} set_eq_band
 * @property {(linear: number, limiterEnabled: number) => void} set_replaygain
 * @property {() => void} request_reset
 * @property {(numFloats: number, channels: number, sampleRate: number, volume: number) => void} process
 */

class DspChainProcessor extends AudioWorkletProcessor {
  /** @param {AudioWorkletNodeOptions} options */
  constructor(options) {
    super();
    /** @type {DspOptions} */
    const opts = options.processorOptions;
    this.channels = Math.max(1, opts.channels | 0);
    this.volume = 1;
    /** @type {DspExports | null} */
    this.dsp = null;
    /** @type {Float32Array} */
    this.scratch = new Float32Array(0);
    /** @type {Uint32Array | null} */
    this.ringHeader = null;
    /** @type {Float32Array} */
    this.ringData = new Float32Array(0);
    if (opts.analysisRing) {
      this.ringHeader = new Uint32Array(opts.analysisRing, 0, RING_HEADER_BYTES / 4);
      this.ringData = new Float32Array(opts.analysisRing, RING_HEADER_BYTES, this.ringHeader[RING_CAPACITY]);
      Atomics.store(this.ringHeader, RING_CHANNELS, this.channels);
      Atomics.store(this.ringHeader, RING_SAMPLE_RATE, sampleRate);
      this.resetRing();
    }

    try {
      const module = opts.wasm instanceof WebAssembly.Module ? opts.wasm : new WebAssembly.Module(opts.wasm);
      const dsp = /** @type {DspExports} */ (/** @type {unknown} */ (new WebAssembly.Instance(module, {}).exports));
      dsp._initialize?.();
      // Memory is fixed-size (ALLOW_MEMORY_GROWTH=0), so this view never detaches.
      this.scratch = new Float32Array(dsp.memory.buffer, dsp.scratch_ptr(), dsp.scratch_floats());
      const { eqBands, replayGain, limiter, volume } = opts.initial;
      eqBands.forEach((b, i) => dsp.set_eq_band(i, b.filterType, b.frequency, b.q, b.gainDb));
      dsp.set_replaygain(replayGain, limiter ? 1 : 0);
      this.volume = volume;
      this.dsp = dsp;
      this.send({ type: 'ready' });
    } catch (err) {
      this.send({ type: 'error', message: String(err) });
    }

    this.port.onmessage = (/** @type {MessageEvent<DspInbound>} */ e) => this.onMessage(e.data);
  }

  /** Readers compare generation before and after a copy, so bump it last. */
  resetRing() {
    if (!this.ringHeader) return;
    Atomics.store(this.ringHeader, RING_WRITE_POS, 0);
    Atomics.add(this.ringHeader, RING_GENERATION, 1);
  }

  /**
   * Append the first `count` floats of scratch to the analysis ring. Plain
   * loops, no views: nothing is allocated on the audio thread.
   * @param {number} count
   */
  writeRing(count) {
    const header = this.ringHeader;
    if (!header || count <= 0) return;
    const data = this.ringData;
    const scratch = this.scratch;
    const capacity = data.length;
    const mask = capacity - 1;
    const block = Math.max(1, Math.min(RING_MAX_BLOCK, capacity >>> 1));
    let wp = Atomics.load(header, RING_WRITE_POS);
    let i = 0;
    if (count > capacity) {
      // Keep the newest `capacity` floats; publish the skip first.
      i = count - capacity;
      wp = (wp + i) >>> 0;
      Atomics.store(header, RING_WRITE_POS, wp);
    }
    while (i < count) {
      const end = Math.min(count, i + block);
      for (; i < end; i++, wp++) data[wp & mask] = scratch[i];
      wp >>>= 0;
      Atomics.store(header, RING_WRITE_POS, wp);
    }
  }

  /** @param {DspOutbound} msg */
  send(msg) {
    this.port.postMessage(msg);
  }

  /** @param {DspInbound} msg */
  onMessage(msg) {
    const dsp = this.dsp;
    if (!dsp) return;
    switch (msg.type) {
      case 'eqBand':
        dsp.set_eq_band(msg.index, msg.filterType, msg.frequency, msg.q, msg.gainDb);
        break;
      case 'replayGain':
        dsp.set_replaygain(msg.linear, msg.limiter ? 1 : 0);
        break;
      case 'volume':
        this.volume = msg.volume;
        break;
      case 'reset':
        dsp.request_reset();
        this.resetRing();
        break;
    }
  }

  /**
   * @param {Float32Array[][]} inputs
   * @param {Float32Array[][]} outputs
   */
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const frames = output[0].length;
    const outChannels = output.length;
    const dsp = this.dsp;

    if (!input || input.length === 0) {
      for (let ch = 0; ch < outChannels; ch++) output[ch].fill(0);
      return true;
    }
    if (!dsp) {
      // Never reached in practice (the node is only wired after 'ready'); pass through.
      for (let ch = 0; ch < outChannels; ch++) {
        if (ch < input.length) output[ch].set(input[ch]);
        else output[ch].fill(0);
      }
      return true;
    }

    const channels = Math.min(this.channels, outChannels);
    const scratch = this.scratch;
    const framesPerPass = Math.max(1, Math.floor(scratch.length / channels));
    for (let start = 0; start < frames; start += framesPerPass) {
      const end = Math.min(frames, start + framesPerPass);
      let k = 0;
      for (let i = start; i < end; i++) {
        for (let ch = 0; ch < channels; ch++) {
          scratch[k++] = ch < input.length ? input[ch][i] : 0;
        }
      }
      dsp.process(k, channels, sampleRate, this.volume);
      this.writeRing(k);
      k = 0;
      for (let i = start; i < end; i++) {
        for (let ch = 0; ch < channels; ch++) output[ch][i] = scratch[k++];
      }
    }
    for (let ch = channels; ch < outChannels; ch++) output[ch].fill(0);
    return true;
  }
}

registerProcessor('dsp-chain', DspChainProcessor);
