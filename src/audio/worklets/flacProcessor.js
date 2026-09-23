// @ts-check
/* global sampleRate */
// AudioWorkletProcessor for WorkletAudioPlayer: buffered PCM playback, gapless
// queue, and the hi-fi streaming ring. Loaded as a static same-origin module
// (no blob URL). Message types live in flacProcessorMessages.ts.

/** @typedef {import('./flacProcessorMessages').FlacProcessorInbound} FlacInbound */
/** @typedef {import('./flacProcessorMessages').FlacProcessorOutbound} FlacOutbound */
/** @typedef {import('./flacProcessorMessages').FlacProcessorOptions} FlacOptions */

class RingBuffer {
  /** @param {number} capacity */
  constructor(capacity) {
    this.capacity = capacity;
    this.buffer = new Float32Array(capacity);
    this.writeIndex = 0;
    this.readIndex = 0;
    this.available = 0;
  }

  /** @param {Float32Array} data */
  write(data) {
    const toWrite = Math.min(data.length, this.capacity - this.available);
    for (let i = 0; i < toWrite; i++) {
      this.buffer[this.writeIndex] = data[i];
      this.writeIndex = (this.writeIndex + 1) % this.capacity;
    }
    this.available += toWrite;
    return toWrite;
  }

  /**
   * @param {Float32Array[]} outputs
   * @param {number} channels
   */
  read(outputs, channels) {
    const frames = outputs[0].length;
    let readFrames = 0;
    for (let i = 0; i < frames && this.available >= channels; i++) {
      for (let ch = 0; ch < channels; ch++) {
        if (ch < outputs.length) outputs[ch][i] = this.buffer[this.readIndex];
        this.readIndex = (this.readIndex + 1) % this.capacity;
      }
      this.available -= channels;
      readFrames++;
    }
    return readFrames;
  }

  getAvailable() {
    return this.available;
  }

  clear() {
    this.writeIndex = 0;
    this.readIndex = 0;
    this.available = 0;
  }
}

/** @param {Float32Array[]} output */
function silence(output) {
  for (let ch = 0; ch < output.length; ch++) output[ch].fill(0);
}

class FlacProcessor extends AudioWorkletProcessor {
  /** @param {AudioWorkletNodeOptions} options */
  constructor(options) {
    super();
    /** @type {FlacOptions | undefined} */
    const opts = options?.processorOptions;
    /** @type {Float32Array | null} */
    this.buffer = null;
    this.position = 0;
    this.channels = 0;
    this.sampleRate = opts?.sampleRate || sampleRate;
    this.isStreaming = false;
    this.paused = false;
    this.hasEnded = false;
    // Streaming clock. readAbs/writtenAbs count interleaved samples since the
    // last startStreaming/seekStream; a segment is one track inside the ring.
    this.readAbs = 0;
    this.writtenAbs = 0;
    this.segStartAbs = 0;
    this.segStartTime = 0;
    /** @type {number[]} writtenAbs values where a spliced track begins */
    this.boundaries = [];
    this.epoch = 0;
    this.framesSincePosition = 0;

    // PCM tap for projectM visualization (512 samples per channel)
    this.pcmBlockSize = 512;
    /** @type {Float32Array | null} */
    this.pcmAccum = null;
    this.pcmAccumPos = 0;

    const ringSeconds = opts?.ringBufferSeconds || 30;
    const ringChannels = opts?.channels || 2;
    const ringCapacity = Math.floor(ringSeconds * this.sampleRate * ringChannels);
    this.ringBuffer = new RingBuffer(ringCapacity);

    /** @type {Float32Array | null} */
    this.nextBuffer = null;
    this.nextChannels = 0;

    this.port.onmessage = (/** @type {MessageEvent<FlacInbound>} */ e) => this.onMessage(e.data);
  }

  /** @param {FlacOutbound} msg @param {Transferable[]} [transfer] */
  send(msg, transfer) {
    if (transfer) this.port.postMessage(msg, transfer);
    else this.port.postMessage(msg);
  }

  resetTap() {
    this.pcmAccum = null;
    this.pcmAccumPos = 0;
  }

  /** Empty the ring and restart the clock at `position` seconds. */
  resetStreamClock(/** @type {number} */ position, /** @type {number} */ epoch) {
    this.ringBuffer.clear();
    this.hasEnded = false;
    this.readAbs = 0;
    this.writtenAbs = 0;
    this.segStartAbs = 0;
    this.segStartTime = position;
    this.boundaries = [];
    this.epoch = epoch;
    this.framesSincePosition = 0;
    this.resetTap();
  }

  sendStreamPosition() {
    this.framesSincePosition = 0;
    this.send({
      type: 'position',
      position: this.segStartTime + (this.readAbs - this.segStartAbs) / (this.channels * this.sampleRate),
      consumed: this.readAbs,
      epoch: this.epoch,
    });
  }

  /** @param {FlacInbound} msg */
  onMessage(msg) {
    switch (msg.type) {
      case 'buffer':
        this.buffer = msg.buffer;
        this.channels = msg.channels;
        this.position = 0;
        this.isStreaming = false;
        this.paused = false;
        this.ringBuffer.clear();
        this.resetTap();
        break;
      case 'startStreaming':
        this.isStreaming = true;
        this.paused = false;
        this.channels = msg.channels || 2;
        this.sampleRate = msg.sampleRate || this.sampleRate;
        this.resetStreamClock(0, 0);
        break;
      case 'seekStream':
        this.resetStreamClock(msg.position, msg.epoch);
        break;
      case 'markSegment':
        if (this.isStreaming) this.boundaries.push(this.writtenAbs);
        break;
      case 'chunk':
        if (this.isStreaming) this.writtenAbs += this.ringBuffer.write(msg.buffer);
        break;
      case 'endStreaming':
        this.hasEnded = true;
        break;
      case 'seek':
        this.position = Math.floor(msg.position * this.sampleRate) * this.channels;
        this.resetTap();
        break;
      case 'pause':
        this.paused = true;
        break;
      case 'resume':
        this.paused = false;
        break;
      case 'stop':
        this.buffer = null;
        this.nextBuffer = null;
        this.nextChannels = 0;
        this.position = 0;
        this.isStreaming = false;
        this.paused = false;
        this.ringBuffer.clear();
        this.resetTap();
        break;
      case 'queueBuffer':
        this.nextBuffer = msg.buffer;
        this.nextChannels = msg.channels || this.channels;
        break;
      case 'clearQueue':
        this.nextBuffer = null;
        this.nextChannels = 0;
        break;
    }
  }

  /**
   * Accumulate output frames into fixed-size interleaved PCM blocks and post
   * them to the main thread for projectM visualization (zero-copy transfer).
   * @param {Float32Array[]} output
   * @param {number} frames
   */
  tapPCM(output, frames) {
    if (!this.channels || frames === 0) return;
    for (let i = 0; i < frames; i++) {
      if (!this.pcmAccum) {
        this.pcmAccum = new Float32Array(this.pcmBlockSize * this.channels);
        this.pcmAccumPos = 0;
      }
      for (let ch = 0; ch < Math.min(output.length, this.channels); ch++) {
        this.pcmAccum[this.pcmAccumPos * this.channels + ch] = output[ch][i];
      }
      this.pcmAccumPos++;
      if (this.pcmAccumPos >= this.pcmBlockSize) {
        const toSend = this.pcmAccum;
        this.resetTap();
        this.send(
          { type: 'projectm-pcm', buffer: toSend, channels: this.channels, sampleRate: this.sampleRate },
          [toSend.buffer]
        );
      }
    }
  }

  /**
   * @param {Float32Array[][]} _inputs
   * @param {Float32Array[][]} outputs
   */
  process(_inputs, outputs) {
    const output = outputs[0];
    if (this.paused) {
      // Paused: hold position, emit silence. The shared AudioContext keeps running.
      silence(output);
      return true;
    }
    if (this.isStreaming) return this.processStreaming(output);
    return this.processBuffered(output);
  }

  /** @param {Float32Array[]} output */
  processBuffered(output) {
    if (!this.buffer || this.channels === 0) {
      silence(output);
      return true;
    }

    const frames = output[0].length;
    let segmentEndedThisBlock = false;
    for (let i = 0; i < frames; i++) {
      if (this.position >= this.buffer.length) {
        if (this.nextBuffer) {
          this.buffer = this.nextBuffer;
          this.channels = this.nextChannels || this.channels;
          this.nextBuffer = null;
          this.nextChannels = 0;
          this.position = 0;
          if (!segmentEndedThisBlock) {
            segmentEndedThisBlock = true;
            this.send({ type: 'segmentEnded' });
          }
        } else {
          for (let ch = 0; ch < output.length; ch++) output[ch][i] = 0;
          if (i === 0) this.send({ type: 'ended' });
          continue;
        }
      }
      for (let ch = 0; ch < Math.min(output.length, this.channels); ch++) {
        output[ch][i] = this.buffer[this.position + ch];
      }
      this.position += this.channels;
    }

    this.tapPCM(output, frames);

    if (frames > 0 && this.position % (this.channels * this.sampleRate) < this.channels * 128) {
      this.send({
        type: 'position',
        position: this.position / (this.channels * this.sampleRate),
        consumed: 0,
      });
    }
    return true;
  }

  /** @param {Float32Array[]} output */
  processStreaming(output) {
    const frames = output[0].length;
    const readFrames = this.ringBuffer.read(output, this.channels);

    for (let i = readFrames; i < frames; i++) {
      for (let ch = 0; ch < output.length; ch++) output[ch][i] = 0;
    }

    this.readAbs += readFrames * this.channels;
    this.tapPCM(output, frames);

    // Gapless splice: the next track's samples follow in the same ring. Once
    // the read head passes the boundary, restart the per-track clock.
    let crossed = false;
    while (this.boundaries.length > 0 && this.readAbs >= this.boundaries[0]) {
      this.segStartAbs = /** @type {number} */ (this.boundaries.shift());
      this.segStartTime = 0;
      crossed = true;
    }
    if (crossed) this.send({ type: 'segmentEnded', epoch: this.epoch });

    if (this.hasEnded && this.ringBuffer.getAvailable() === 0 && readFrames < frames) {
      this.hasEnded = false;
      this.send({ type: 'ended' });
    }

    // ~every 100 ms (the seek bar and the feeder's backpressure read this).
    this.framesSincePosition += frames;
    if (crossed || this.framesSincePosition >= this.sampleRate / 10) this.sendStreamPosition();
    return true;
  }
}

registerProcessor('flac-processor', FlacProcessor);
