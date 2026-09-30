// AudioWorkletProcessor for WorkletAudioPlayer: buffered PCM playback, gapless
// queue, the hi-fi streaming ring, varispeed playback rate and the projectM tap.
// Bundled as its own worklet entry (webpack `module.parser.javascript.worker`,
// Vite serves the module directly), so it may import shared modules — never a
// blob URL. Protocol: flacProcessorMessages.ts. Ring layout: playRingSAB.ts.
import {
  FLAC_PROCESSOR_NAME,
  MAX_PLAYBACK_RATE,
  PCM_TAP_BLOCK_FRAMES,
  clampPlaybackRate,
  type FlacProcessorInbound,
  type FlacProcessorOptions,
  type FlacProcessorOutbound,
} from './flacProcessorMessages';
import {
  attachPlayRing,
  createPlayRing,
  pcmTapWrite,
  playRingEnded,
  playRingFill,
  playRingPush,
  playRingReadFrames,
  playRingReadInterleaved,
  playRingReadPos,
  playRingSetEnded,
  playRingSkipTo,
  playRingWritePos,
  ringDistance,
  type PlayRing,
} from './playRingSAB';

/** Render quantum the varispeed scratch is pre-sized for (resized if a host uses more). */
const RENDER_QUANTUM = 128;

function silence(output: Float32Array[], from: number): void {
  for (let ch = 0; ch < output.length; ch++) output[ch]!.fill(0, from);
}

export class FlacProcessor extends AudioWorkletProcessor {
  private mode: 'idle' | 'buffered' | 'stream' = 'idle';
  private channels: number;
  /** Rate of the PCM we are handed (= context rate; main resamples). */
  private rate: number;
  private paused = false;
  private playbackRate = 1;
  private framesSincePosition = 0;
  private endedSent = false;

  // Buffered: `position` = floats pulled from `buffer`.
  private buffer: Float32Array | null = null;
  private position = 0;
  private nextBuffer: Float32Array | null = null;
  private nextChannels = 0;
  private swapped = false;

  // Streaming. Absolute positions count floats pulled from the ring since
  // startStreaming (a JS number, so they never wrap); `boundaries` are splice
  // points in that space.
  private ring: PlayRing | null = null;
  private readonly ringSeconds: number;
  private pulled = 0;
  private seekAbs = 0;
  private segStartAbs = 0;
  private segStartTime = 0;
  private boundaries: number[] = [];
  private epoch = 0;

  // Varispeed: interleaved frames pulled ahead of the output. `vsPos` is the
  // fractional read position in frames; frame floor(vsPos) − 1 is kept as history.
  private vs: Float32Array | null = null;
  private vsFrames = 0;
  private vsPos = 0;
  private vsActive = false;
  /** Last frame the direct path played: varispeed history, so a rate change is seamless. */
  private lastFrame = new Float32Array(8);
  private hasLastFrame = false;

  // projectM tap: shared ring + `pcmTap` notifications, or transferred blocks.
  private readonly tapRing: PlayRing | null;
  private tapEnabled = false;
  private tapFrames = 0;
  private tapBlock: Float32Array | null = null;

  constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    const opts = options?.processorOptions as FlacProcessorOptions | undefined;
    this.rate = opts?.sampleRate || sampleRate;
    this.channels = opts?.channels || 2;
    this.ringSeconds = opts?.ringBufferSeconds || 30;
    this.tapRing = opts?.tapRing ? attachPlayRing(opts.tapRing) : null;
    this.port.onmessage = (e: MessageEvent<FlacProcessorInbound>) => this.onMessage(e.data);
  }

  private send(msg: FlacProcessorOutbound, transfer?: Transferable[]): void {
    if (transfer) this.port.postMessage(msg, transfer);
    else this.port.postMessage(msg);
  }

  onMessage(msg: FlacProcessorInbound): void {
    switch (msg.type) {
      case 'buffer':
        this.mode = 'buffered';
        this.ring = null;
        this.buffer = msg.buffer;
        this.channels = msg.channels;
        this.position = 0;
        this.paused = false;
        this.endedSent = false;
        this.resetVarispeed();
        this.varispeedBuffer(RENDER_QUANTUM);
        break;
      case 'startStreaming':
        this.mode = 'stream';
        this.buffer = null;
        this.paused = false;
        this.channels = msg.channels || 2;
        this.rate = msg.sampleRate || this.rate;
        this.ring = msg.ring
          ? attachPlayRing(msg.ring)
          : createPlayRing(Math.floor(this.ringSeconds * this.rate) * this.channels, false);
        this.pulled = 0;
        this.seekAbs = 0;
        this.resetStreamClock(0, 0);
        this.resetVarispeed();
        this.varispeedBuffer(RENDER_QUANTUM);
        break;
      case 'seekStream': {
        const ring = this.ring;
        if (!ring) break;
        // Shared ring: the writer cleared `ended` before posting. Local ring: we are the writer.
        if (msg.readFrom === undefined) playRingSetEnded(ring, false);
        const overshoot = playRingSkipTo(ring, msg.readFrom ?? playRingWritePos(ring));
        this.resetVarispeed();
        this.seekAbs = this.pulled - overshoot;
        this.resetStreamClock(msg.position, msg.epoch);
        break;
      }
      case 'markSegment':
        if (this.ring) {
          const at = msg.at ?? playRingWritePos(this.ring);
          this.boundaries.push(this.pulled + ringDistance(this.ring, playRingReadPos(this.ring), at));
        }
        break;
      case 'chunk':
        if (this.ring) playRingPush(this.ring, msg.buffer);
        break;
      case 'endStreaming':
        if (this.ring) playRingSetEnded(this.ring, true);
        break;
      case 'seek':
        this.position = Math.floor(msg.position * this.rate) * this.channels;
        this.endedSent = false;
        this.resetVarispeed();
        break;
      case 'pause':
        this.paused = true;
        break;
      case 'resume':
        this.paused = false;
        break;
      case 'stop':
        this.mode = 'idle';
        this.buffer = null;
        this.nextBuffer = null;
        this.nextChannels = 0;
        this.ring = null;
        this.position = 0;
        this.paused = false;
        this.resetVarispeed();
        break;
      case 'queueBuffer':
        this.nextBuffer = msg.buffer;
        this.nextChannels = msg.channels || this.channels;
        break;
      case 'clearQueue':
        this.nextBuffer = null;
        this.nextChannels = 0;
        break;
      case 'setPlaybackRate':
        this.playbackRate = clampPlaybackRate(msg.rate);
        break;
      case 'setTap':
        this.tapEnabled = msg.enabled;
        this.tapFrames = 0;
        this.tapBlock = null;
        break;
    }
  }

  private resetStreamClock(position: number, epoch: number): void {
    this.segStartAbs = this.seekAbs;
    this.segStartTime = position;
    this.boundaries = [];
    this.epoch = epoch;
    this.framesSincePosition = 0;
    this.endedSent = false;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    // Paused: hold position, emit silence. The shared AudioContext keeps running.
    if (this.paused || this.mode === 'idle') {
      silence(output, 0);
      return true;
    }

    const frames = output[0]!.length;
    let produced: number;
    if (this.playbackRate === 1 && !this.vsActive) {
      produced = this.pullFrames(output, 0, frames);
      if (produced > 0) this.keepLastFrame(output, produced - 1);
    } else {
      produced = this.renderVarispeed(output, frames);
    }
    for (let ch = 0; ch < output.length; ch++) output[ch]!.fill(0, ch < this.channels ? produced : 0);

    if (this.tapEnabled) this.tap(output, frames);
    this.framesSincePosition += frames;
    if (this.mode === 'stream') this.afterStream(produced < frames);
    else this.afterBuffered(produced < frames);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Sources: pull whole frames from the buffered track or the streaming ring.
  // ---------------------------------------------------------------------------

  /** Buffered: true while `buffer` has a whole frame left (swapping in the queued track at the end). */
  private bufferHasFrame(): boolean {
    if (!this.buffer) return false;
    if (this.position + this.channels <= this.buffer.length) return true;
    if (!this.nextBuffer) return false;
    this.buffer = this.nextBuffer;
    this.channels = this.nextChannels || this.channels;
    this.nextBuffer = null;
    this.nextChannels = 0;
    this.position = 0;
    this.swapped = true;
    return this.channels <= this.buffer.length;
  }

  /** Deinterleave up to `frames` frames into `out[ch][offset…]`. */
  private pullFrames(out: Float32Array[], offset: number, frames: number): number {
    const ch = this.channels;
    if (this.ring) {
      const n = playRingReadFrames(this.ring, out, offset, frames, ch);
      this.pulled += n * ch;
      return n;
    }
    let done = 0;
    while (done < frames && this.bufferHasFrame()) {
      const buf = this.buffer!;
      const n = Math.min(frames - done, Math.floor((buf.length - this.position) / ch));
      const o = offset + done;
      for (let c = 0; c < Math.min(out.length, ch); c++) {
        const dst = out[c]!;
        for (let i = 0, j = this.position + c; i < n; i++, j += ch) dst[o + i] = buf[j]!;
      }
      this.position += n * ch;
      done += n;
    }
    return done;
  }

  /** Copy up to `frames` interleaved frames into `dest[offset…]` (floats). */
  private pullInterleaved(dest: Float32Array, offset: number, frames: number): number {
    const ch = this.channels;
    if (this.ring) {
      const n = playRingReadInterleaved(this.ring, dest, offset, frames, ch);
      this.pulled += n * ch;
      return n;
    }
    let done = 0;
    while (done < frames && this.bufferHasFrame()) {
      const buf = this.buffer!;
      const n = Math.min(frames - done, Math.floor((buf.length - this.position) / ch));
      dest.set(buf.subarray(this.position, this.position + n * ch), offset + done * ch);
      this.position += n * ch;
      done += n;
    }
    return done;
  }

  // ---------------------------------------------------------------------------
  // Varispeed: consume the source at `playbackRate` × the callback rate with a
  // 4-point Hermite interpolator (tempo and pitch move together, as with SDL's
  // SDL_SetAudioStreamFrequencyRatio). At 1× the direct path runs untouched.
  // ---------------------------------------------------------------------------

  private varispeedBuffer(frames: number): Float32Array {
    const needed = (Math.ceil(frames * MAX_PLAYBACK_RATE) + 8) * this.channels;
    if (!this.vs || this.vs.length < needed) {
      const next = new Float32Array(needed);
      if (this.vs && this.vsActive) next.set(this.vs.subarray(0, this.vsFrames * this.channels));
      this.vs = next;
    }
    return this.vs;
  }

  /** Seek / new source: drops carried frames and the history. */
  private resetVarispeed(): void {
    this.leaveVarispeedState();
    this.hasLastFrame = false;
  }

  private leaveVarispeedState(): void {
    this.vsActive = false;
    this.vsFrames = 0;
    this.vsPos = 0;
  }

  private keepLastFrame(out: Float32Array[], i: number): void {
    const ch = Math.min(this.channels, out.length, this.lastFrame.length);
    for (let c = 0; c < ch; c++) this.lastFrame[c] = out[c]![i]!;
    this.hasLastFrame = true;
  }

  /** Floats pulled from the source but not yet heard. */
  private carriedFloats(): number {
    return this.vsActive ? Math.max(0, this.vsFrames - this.vsPos) * this.channels : 0;
  }

  private renderVarispeed(out: Float32Array[], frames: number): number {
    const ch = this.channels;
    const vs = this.varispeedBuffer(frames);
    if (!this.vsActive) {
      // Prime: history = the last frame played at 1× (or the next frame, after a seek).
      if (this.pullInterleaved(vs, ch, 1) === 0) return 0;
      if (this.hasLastFrame && ch <= this.lastFrame.length) vs.set(this.lastFrame.subarray(0, ch), 0);
      else vs.copyWithin(0, ch, 2 * ch);
      this.vsFrames = 2;
      this.vsPos = 1;
      this.vsActive = true;
    }
    if (this.playbackRate === 1) return this.leaveVarispeed(out, frames);

    const ratio = this.playbackRate;
    // Output i interpolates frames floor(pos_i) − 1 … floor(pos_i) + 2.
    const need = Math.min(vs.length / ch, Math.floor(this.vsPos + (frames - 1) * ratio) + 3);
    if (need > this.vsFrames) this.vsFrames += this.pullInterleaved(vs, this.vsFrames * ch, need - this.vsFrames);

    const outChannels = Math.min(out.length, ch);
    let pos = this.vsPos;
    let i = 0;
    for (; i < frames; i++) {
      const ip = Math.floor(pos);
      if (ip + 2 >= this.vsFrames) break; // underrun: the rest of the block is silence
      const t = pos - ip;
      const base = (ip - 1) * ch;
      for (let c = 0; c < outChannels; c++) {
        const xm1 = vs[base + c]!;
        const x0 = vs[base + ch + c]!;
        const x1 = vs[base + 2 * ch + c]!;
        const x2 = vs[base + 3 * ch + c]!;
        const c1 = 0.5 * (x1 - xm1);
        const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
        const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
        out[c]![i] = ((c3 * t + c2) * t + c1) * t + x0;
      }
      pos += ratio;
    }
    this.vsPos = pos;
    this.compactVarispeed();
    return i;
  }

  /** Back at 1×: snap to the next whole frame, play out the carried frames exactly, then go direct. */
  private leaveVarispeed(out: Float32Array[], frames: number): number {
    const ch = this.channels;
    const vs = this.vs!;
    const p = Math.ceil(this.vsPos);
    const n = Math.max(0, Math.min(frames, this.vsFrames - p));
    for (let c = 0; c < Math.min(out.length, ch); c++) {
      const dst = out[c]!;
      for (let i = 0, j = p * ch + c; i < n; i++, j += ch) dst[i] = vs[j]!;
    }
    if (p + n >= this.vsFrames) {
      this.leaveVarispeedState();
      const produced = n + this.pullFrames(out, n, frames - n);
      if (produced > 0) this.keepLastFrame(out, produced - 1);
      return produced;
    }
    this.vsPos = p + n;
    this.compactVarispeed();
    return n;
  }

  /** Drop frames before the history frame; keeps vsPos in [1, 2) while data lasts. */
  private compactVarispeed(): void {
    const drop = Math.min(Math.floor(this.vsPos) - 1, this.vsFrames);
    if (drop <= 0) return;
    const ch = this.channels;
    this.vs!.copyWithin(0, drop * ch, this.vsFrames * ch);
    this.vsFrames -= drop;
    this.vsPos -= drop;
  }

  // ---------------------------------------------------------------------------
  // Per-block bookkeeping
  // ---------------------------------------------------------------------------

  /** Every ~100 ms of media time (the seek bar and the feeder's backpressure read `position`). */
  private positionDue(): boolean {
    return this.framesSincePosition * this.playbackRate >= this.rate / 10;
  }

  private afterBuffered(underrun: boolean): void {
    if (this.swapped) {
      this.swapped = false;
      this.send({ type: 'segmentEnded' });
    }
    if (this.endedSent) return;
    if (underrun && !this.bufferHasFrame()) {
      this.endedSent = true;
      this.send({ type: 'ended' });
      return;
    }
    if (this.positionDue()) {
      this.framesSincePosition = 0;
      const heard = Math.max(0, this.position - this.carriedFloats());
      this.send({ type: 'position', position: heard / (this.channels * this.rate), consumed: 0 });
    }
  }

  private afterStream(underrun: boolean): void {
    const ring = this.ring!;
    const heard = this.pulled - this.carriedFloats();

    // Gapless splice: the next track's samples follow in the same ring. Once
    // the audible position passes the boundary, restart the per-track clock.
    let crossed = false;
    while (this.boundaries.length > 0 && heard >= this.boundaries[0]!) {
      this.segStartAbs = this.boundaries.shift()!;
      this.segStartTime = 0;
      crossed = true;
    }
    if (crossed) this.send({ type: 'segmentEnded', epoch: this.epoch });

    // `ended` before fill: the writer stores its last samples, then the flag.
    if (underrun && !this.endedSent && playRingEnded(ring) && playRingFill(ring) < this.channels) {
      this.endedSent = true;
      this.send({ type: 'ended', epoch: this.epoch });
    }

    if (crossed || this.positionDue()) {
      this.framesSincePosition = 0;
      this.send({
        type: 'position',
        position: Math.max(0, this.segStartTime + (heard - this.segStartAbs) / (this.channels * this.rate)),
        consumed: this.pulled - this.seekAbs,
        epoch: this.epoch,
      });
    }
  }

  /** projectM tap: the samples actually sent to the output, in 512-frame blocks. */
  private tap(out: Float32Array[], frames: number): void {
    const ch = this.channels;
    if (this.tapRing) {
      pcmTapWrite(this.tapRing, out, frames, ch);
      this.tapFrames += frames;
      while (this.tapFrames >= PCM_TAP_BLOCK_FRAMES) {
        this.tapFrames -= PCM_TAP_BLOCK_FRAMES;
        this.send({ type: 'pcmTap' });
      }
      return;
    }
    let i = 0;
    while (i < frames) {
      if (!this.tapBlock) {
        this.tapBlock = new Float32Array(PCM_TAP_BLOCK_FRAMES * ch);
        this.tapFrames = 0;
      }
      const block = this.tapBlock;
      const n = Math.min(frames - i, PCM_TAP_BLOCK_FRAMES - this.tapFrames);
      for (let c = 0; c < ch; c++) {
        const src = out[c];
        for (let k = 0; k < n; k++) block[(this.tapFrames + k) * ch + c] = src ? src[i + k]! : 0;
      }
      i += n;
      this.tapFrames += n;
      if (this.tapFrames === PCM_TAP_BLOCK_FRAMES) {
        this.tapBlock = null;
        this.send({ type: 'projectm-pcm', buffer: block, channels: ch, sampleRate: this.rate }, [block.buffer]);
      }
    }
  }
}

registerProcessor(FLAC_PROCESSOR_NAME, FlacProcessor);
