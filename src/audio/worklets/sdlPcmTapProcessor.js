// @ts-check
// AudioWorkletProcessor that reads the SDL3 WASM PCM ring (SharedArrayBuffer)
// into the shared analyser graph. Static same-origin module (no blob URL).

/** @typedef {import('./sdlPcmTapMessages').SdlPcmTapOptions} SdlTapOptions */

class SdlPcmTapProcessor extends AudioWorkletProcessor {
  /** @param {AudioWorkletNodeOptions} options */
  constructor(options) {
    super();
    /** @type {SdlTapOptions} */
    const o = options.processorOptions;
    this.writeIdx = new Int32Array(o.memory, o.writeOffset, 1);
    this.readIdx = new Int32Array(o.memory, o.readOffset, 1);
    this.capacity = o.capacity;
    this.pcmData = new Float32Array(o.memory, o.dataOffset, o.capacity);
    this.channels = o.channels || 2;
    this.localReadPos = Atomics.load(this.readIdx, 0) >>> 0;
  }

  /**
   * @param {Float32Array[][]} _inputs
   * @param {Float32Array[][]} outputs
   */
  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const chCount = output.length;
    const frames = output[0].length;
    const wp = Atomics.load(this.writeIdx, 0) >>> 0;
    let rp = this.localReadPos;

    for (let i = 0; i < frames; i++) {
      for (let ch = 0; ch < chCount; ch++) {
        if (rp < wp) {
          output[ch][i] = this.pcmData[rp % this.capacity];
          rp++;
        } else {
          output[ch][i] = 0;
        }
      }
    }

    this.localReadPos = rp;
    Atomics.store(this.readIdx, 0, rp);
    return true;
  }
}

registerProcessor('sdl-pcm-tap', SdlPcmTapProcessor);
