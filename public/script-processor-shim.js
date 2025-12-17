(function(){
  if (typeof AudioContext === 'undefined') return;
  // If createScriptProcessor already exists, nothing to do
  if (typeof AudioContext.prototype.createScriptProcessor === 'function') return;

  const moduleUrl = './script-processor-processor.js';

  AudioContext.prototype.createScriptProcessor = function(bufferSize = 4096, inputChannels = 1, outputChannels = 1) {
    const ctx = this;
    let workletNode = null;
    let handler = null;
    const pending = [];
    const POOL_SIZE = 4;

    const makeHandler = (e) => {
      if (!handler) return;
      // Two possible message shapes: {type:'audio', buffer:ArrayBuffer, channels, frameCount} or {type:'audio', input:[Float32Array,...]}
      const d = e.data || {};
      if (d.type === 'audio' && d.buffer) {
        // Received interleaved transferred buffer
        const interleaved = new Float32Array(d.buffer);
        const ch = d.channels || inputChannels;
        const frameCount = d.frameCount || (interleaved.length / ch);
        const bufferObj = {
          numberOfChannels: ch,
          getChannelData: (c) => {
            const out = new Float32Array(frameCount);
            for (let i = 0, j = c; i < frameCount; i++, j += ch) out[i] = interleaved[j];
            return out;
          }
        };
        const outputBuffer = { getChannelData: (c) => new Float32Array(frameCount) };
        try { handler({ inputBuffer: bufferObj, outputBuffer }); } catch (err) { console.error('onaudioprocess handler error:', err); }

        // Return buffer back to worklet for reuse by transferring it back
        try { workletNode.port.postMessage({ type: 'returnBuffer', buffer: d.buffer }, [d.buffer]); } catch (err) {}
      } else if (Array.isArray(d.input)) {
        const inputArr = d.input;
        const bufferObj = {
          numberOfChannels: inputArr.length,
          getChannelData: (c) => inputArr[c] || new Float32Array(bufferSize)
        };
        const outputBuffer = { getChannelData: (c) => new Float32Array(bufferSize) };
        try { handler({ inputBuffer: bufferObj, outputBuffer }); } catch (err) { console.error(err); }
      }
    };

    // Start loading the worklet module
    ctx.audioWorklet.addModule(moduleUrl).then(() => {
      workletNode = new AudioWorkletNode(ctx, 'script-processor-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [outputChannels]
      });

      // Initialize buffer pool: create a few transferable interleaved buffers and send them to worklet
      const buffers = [];
      const size = bufferSize * Math.max(1, inputChannels);
      for (let i = 0; i < POOL_SIZE; i++) {
        buffers.push(new Float32Array(size).buffer);
      }
      workletNode.port.postMessage({ type: 'buffers', buffers, channels: Math.max(1, inputChannels), bufferSize }, buffers);

      // Hook up handler if already set
      workletNode.port.onmessage = makeHandler;
      if (handler) {
        // no-op - handler is used in makeHandler
      }

      // flush pending connect/disconnect calls
      pending.forEach(evt => {
        if (evt.type === 'connect') workletNode.connect(evt.dest);
        else if (evt.type === 'disconnect') workletNode.disconnect();
      });
    }).catch(err => {
      console.warn('AudioWorklet module failed to load; ScriptProcessor shim will not work:', err);
    });

    const wrapper = {
      connect(dest) {
        if (workletNode) workletNode.connect(dest);
        else pending.push({ type: 'connect', dest });
      },
      disconnect() {
        if (workletNode) workletNode.disconnect();
        else pending.push({ type: 'disconnect' });
      },
      set onaudioprocess(cb) {
        handler = cb;
      },
      get onaudioprocess() { return handler; }
    };

    return wrapper;
  };

    return wrapper;
  };
})();
