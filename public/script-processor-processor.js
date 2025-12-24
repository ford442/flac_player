class ScriptProcessorProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._bufferPool = []; // Array of Float32Array interleaved buffers
    this._channels = 1;
    this._bufferSize = 128;

    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.type === 'buffers' && Array.isArray(d.buffers)) {
        // Initialize pool from transferred ArrayBuffers
        this._channels = d.channels || this._channels;
        this._bufferSize = d.bufferSize || this._bufferSize;
        this._bufferPool = d.buffers.map(b => new Float32Array(b));
      } else if (d.type === 'returnBuffer' && d.buffer) {
        // Returned ArrayBuffer from main thread - re-create view and push back
        this._bufferPool.push(new Float32Array(d.buffer));
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0] || [];
    const output = outputs[0] || [];

    // Try to use a pooled interleaved buffer and transfer back to main thread
    if (this._bufferPool.length > 0) {
      const buf = this._bufferPool.shift(); // take ownership
      const chCount = Math.min(this._channels, input.length || 0);
      const frameCount = buf.length / this._channels;
      // Fill interleaved buffer
      for (let i = 0, idx = 0; i < frameCount; i++, idx += this._channels) {
        for (let ch = 0; ch < this._channels; ch++) {
          const channelArr = input[ch] || new Float32Array(frameCount);
          buf[idx + ch] = channelArr[i] || 0;
        }
      }

      try {
        // Transfer the underlying ArrayBuffer to the main thread
        this.port.postMessage({ type: 'audio', buffer: buf.buffer, channels: this._channels, frameCount }, [buf.buffer]);
      } catch (err) {
        // If transfer fails, drop it and continue
      }

      // For output, do a simple passthrough if node is connected to destination
      for (let ch = 0; ch < output.length; ch++) {
        const outC = output[ch];
        const inC = input[ch] || new Float32Array(outC.length);
        outC.set(inC);
      }

      return true;
    }

    // Fallback: no pooled buffer available, do per-frame copy and post non-transferable message
    try {
      const arr = input.map(ch => new Float32Array(ch));
      this.port.postMessage({ type: 'audio', input: arr });
    } catch (e) {
      // ignore
    }

    for (let ch = 0; ch < output.length; ch++) {
      const outC = output[ch];
      const inC = input[ch] || new Float32Array(outC.length);
      outC.set(inC);
    }

    return true;
  }
}

registerProcessor('script-processor-processor', ScriptProcessorProcessor);
