// @ts-check
/* global sampleRate */
// AudioWorkletProcessor for the `sdl` output mode: the audio thread of the C++
// engine (src/sdl/audio_engine.cpp). Each render quantum it reads the engine's
// transport block (engine_state.h) and whole frames of PCM, either the
// buffered track or the play ring (play_ring.h), straight out of the module's
// shared memory, and writes them to its output. That output feeds the shared
// graph's input, where the dsp-chain worklet (dsp_chain.h) runs the speaker
// DSP and fills the analysis ring. Static same-origin module (no blob URL);
// the contract and word indices live in sdlEngineMessages.ts.
//
// Nothing here allocates per quantum, takes a lock, or waits: the main thread
// only writes words and PCM, and this processor only moves the ring's readPos
// and its own progress words.

// engine_state.h / sdlEngineMessages.ts ENGINE_STATE_WORDS (a classic script cannot import TS).
const S_EPOCH = 0;
const S_MODE = 1;
const S_PLAYING = 2;
const S_CHANNELS = 3;
const S_SAMPLE_RATE = 4;
const S_RATE_BITS = 5;
const S_BUFFER_PTR = 6;
const S_BUFFER_FLOATS = 7;
const S_START_FRAME = 8;
const S_RING_START = 9;
const S_OWNER = 10;
const S_ACK_EPOCH = 11;
const S_FRAMES_PLAYED = 12;
const S_DRAINED = 13;
const STATE_WORDS = 16;

// play_ring.h PlayRingState / PLAY_RING_WORDS.
const R_WRITE_POS = 0;
const R_READ_POS = 1;
const R_CAPACITY = 2;
const R_ENDED = 3;

// EngineMode / ENGINE_MODE.
const MODE_IDLE = 0;
const MODE_BUFFERED = 1;
const MODE_STREAM = 2;

/** @typedef {import('./sdlEngineMessages').SdlEngineOptions} EngineOptions */

class SdlEngineProcessor extends AudioWorkletProcessor {
  /** @param {AudioWorkletNodeOptions} options */
  constructor(options) {
    super();
    /** @type {EngineOptions} */
    const opts = options.processorOptions;
    this.memory = opts.memory;
    this.owner = opts.owner >>> 0;
    this.statePtr = opts.statePtr;
    this.ringStatePtr = opts.ringStatePtr;
    this.ringDataPtr = opts.ringDataPtr;
    this.retired = false;

    /** @type {Uint32Array} */
    this.state = new Uint32Array(0);
    /** @type {Uint32Array} */
    this.ring = new Uint32Array(0);
    /** @type {Float32Array} whole-memory view; buffered PCM and the ring data are offsets into it */
    this.heap = new Float32Array(0);
    this.ringBase = 0;
    this.ringMask = 0;
    this.mapViews();

    // Converts rateBits without allocating.
    this.rateF32 = new Float32Array(1);
    this.rateU32 = new Uint32Array(this.rateF32.buffer);

    // What the last applied epoch said; read only on this thread.
    this.epoch = -1;
    this.mode = MODE_IDLE;
    this.channels = 0;
    /** PCM frames per output frame at rate 1: the PCM's rate over the context's */
    this.rateScale = 1;
    this.bufBase = 0;
    this.bufFloats = 0;
    /** buffered: float offset of the next frame inside the track */
    this.bufPos = 0;
    /** fractional frame between the next frame and the one after (rate != 1) */
    this.frac = 0;
    this.framesPlayed = 0;
    this.drained = 0;
  }

  /** (Re)create the views on the memory's current buffer (it grows, never shrinks). */
  mapViews() {
    const buffer = this.memory.buffer;
    this.state = new Uint32Array(buffer, this.statePtr, STATE_WORDS);
    this.ring = new Uint32Array(buffer, this.ringStatePtr, 4);
    this.heap = new Float32Array(buffer);
    const capacity = this.ring[R_CAPACITY];
    // play_ring.h only accepts a power-of-two capacity; 0 means not initialised.
    const valid = capacity > 0 && (capacity & (capacity - 1)) === 0;
    this.ringMask = valid ? capacity - 1 : 0;
    this.ringBase = this.ringDataPtr >>> 2;
  }

  /**
   * Take over the change the main thread published as `epoch`. The fields are
   * re-read until the epoch is stable, so a change written mid-read is never
   * half-applied (the main thread writes the fields, then bumps).
   * @param {number} epoch
   */
  applyEpoch(epoch) {
    const s = this.state;
    let mode = 0;
    let channels = 0;
    let pcmRate = 0;
    let bufferPtr = 0;
    let bufferFloats = 0;
    let startFrame = 0;
    let ringStart = 0;
    for (;;) {
      mode = Atomics.load(s, S_MODE);
      channels = Atomics.load(s, S_CHANNELS);
      pcmRate = Atomics.load(s, S_SAMPLE_RATE);
      bufferPtr = Atomics.load(s, S_BUFFER_PTR);
      bufferFloats = Atomics.load(s, S_BUFFER_FLOATS);
      startFrame = Atomics.load(s, S_START_FRAME);
      ringStart = Atomics.load(s, S_RING_START);
      const again = Atomics.load(s, S_EPOCH);
      if (again === epoch) break;
      epoch = again;
    }

    // The consumer only ever moves readPos forward: a seek names a later start.
    const readPos = Atomics.load(this.ring, R_READ_POS);
    if (((ringStart - readPos) | 0) > 0) Atomics.store(this.ring, R_READ_POS, ringStart);

    this.channels = channels;
    // JS resamples to the context rate, so this is 1 unless the context was
    // replaced at another rate mid-track; then interpolation keeps pitch and clock.
    this.rateScale = pcmRate > 0 ? pcmRate / sampleRate : 1;
    this.frac = 0;
    this.mode = mode;
    if (mode === MODE_BUFFERED) {
      const end = bufferPtr + bufferFloats * 4;
      if (end > this.heap.byteLength) this.mapViews();
      if (channels === 0 || (bufferPtr & 3) !== 0 || end > this.heap.byteLength) {
        this.mode = MODE_IDLE;
      } else {
        this.bufBase = bufferPtr >>> 2;
        this.bufFloats = bufferFloats;
        this.bufPos = Math.min(startFrame * channels, bufferFloats - (bufferFloats % channels));
      }
    } else if (mode === MODE_STREAM && (channels === 0 || this.ringMask === 0)) {
      this.mode = MODE_IDLE;
    }

    this.epoch = epoch;
    this.framesPlayed = 0;
    this.drained = 0;
    Atomics.store(s, S_FRAMES_PLAYED, 0);
    Atomics.store(s, S_DRAINED, 0);
    // Last: the main thread's clock switches to startFrame + framesPlayed now.
    Atomics.store(s, S_ACK_EPOCH, epoch);
  }

  /** @param {Float32Array[]} output @param {number} from */
  silence(output, from) {
    for (let ch = 0; ch < output.length; ch++) output[ch].fill(0, from);
  }

  /**
   * @param {Float32Array[][]} _inputs
   * @param {Float32Array[][]} outputs
   */
  process(_inputs, outputs) {
    const output = outputs[0];
    if (this.retired) return false;
    const s = this.state;
    if (Atomics.load(s, S_OWNER) !== this.owner) {
      // A newer node owns the engine (or cleanup ran): never touch its words again.
      this.retired = true;
      if (output) this.silence(output, 0);
      return false;
    }
    if (!output || output.length === 0) return true;

    const epoch = Atomics.load(s, S_EPOCH);
    if (epoch !== this.epoch) this.applyEpoch(epoch);

    const mode = this.mode;
    if (mode === MODE_IDLE || Atomics.load(s, S_PLAYING) === 0) {
      this.silence(output, 0);
      return true;
    }

    const channels = this.channels;
    const frames = output[0].length;
    const outChannels = Math.min(channels, output.length);
    const heap = this.heap;
    const isStream = mode === MODE_STREAM;
    // Float index of a position: the ring wraps at its power-of-two capacity
    // (positions are u32 counters), a buffered track does not wrap.
    const base = isStream ? this.ringBase : this.bufBase;
    const mask = isStream ? this.ringMask : 0x7fffffff;

    let pos;
    let available;
    let ended = 0;
    if (isStream) {
      // `ended` before writePos: once it reads 1, every float was pushed before it.
      ended = Atomics.load(this.ring, R_ENDED);
      pos = Atomics.load(this.ring, R_READ_POS);
      available = Math.floor(((Atomics.load(this.ring, R_WRITE_POS) - pos) >>> 0) / channels);
    } else {
      pos = this.bufPos;
      available = Math.floor((this.bufFloats - pos) / channels);
    }

    this.rateU32[0] = Atomics.load(s, S_RATE_BITS);
    let rate = this.rateF32[0];
    if (!(rate > 0)) rate = 1;
    rate *= this.rateScale;

    // No more PCM will arrive: the buffered track, or a stream whose producer ended.
    const final = !isStream || ended === 1;

    let i = 0;
    let consumed = 0;
    if (rate === 1 && this.frac === 0) {
      const n = Math.min(frames, available);
      for (; i < n; i++) {
        const p = pos + i * channels;
        for (let ch = 0; ch < outChannels; ch++) output[ch][i] = heap[base + ((p + ch) & mask)];
      }
      consumed = n;
    } else {
      // Pitch follows speed: linear interpolation between neighbouring frames.
      // Between frames the next one is needed, unless this is the last there is.
      let frac = this.frac;
      for (; i < frames; i++) {
        const left = available - consumed;
        if (left < 1) break;
        const lerp = frac > 0 && left >= 2;
        if (frac > 0 && !lerp && !final) break;
        const p = pos + consumed * channels;
        for (let ch = 0; ch < outChannels; ch++) {
          const a = heap[base + ((p + ch) & mask)];
          output[ch][i] = lerp ? a + (heap[base + ((p + channels + ch) & mask)] - a) * frac : a;
        }
        frac += rate;
        const step = Math.floor(frac);
        frac -= step;
        consumed += step;
      }
      if (consumed > available) {
        consumed = available;
        frac = 0;
      }
      this.frac = frac;
    }
    if (i < frames || outChannels < output.length) {
      for (let ch = 0; ch < output.length; ch++) output[ch].fill(0, ch < outChannels ? i : 0);
    }

    if (consumed > 0) {
      pos += consumed * channels;
      if (isStream) Atomics.store(this.ring, R_READ_POS, pos >>> 0);
      else this.bufPos = pos;
      this.framesPlayed = (this.framesPlayed + consumed) >>> 0;
      Atomics.store(s, S_FRAMES_PLAYED, this.framesPlayed);
    }

    const drained = final && available - consumed === 0 ? 1 : 0;
    if (drained !== this.drained) {
      this.drained = drained;
      Atomics.store(s, S_DRAINED, drained);
    }
    return true;
  }
}

registerProcessor('sdl-engine', SdlEngineProcessor);
