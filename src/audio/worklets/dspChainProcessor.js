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
