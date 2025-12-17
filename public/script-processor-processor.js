class ScriptProcessorProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
  }

  process(inputs, outputs) {
    // inputs: [ [Float32Array(channel0), Float32Array(channel1), ...] ]
    const input = inputs[0] || [];
    // Post channel data arrays to main thread for onaudioprocess handler
    try {
      // Note: transferring nested Float32Array arrays isn't straightforward; post as a simple array
      this.port.postMessage({ input: input });
    } catch (e) {
      // ignore
    }

    // Simple passthrough: copy input to output where possible
    const output = outputs[0] || [];
    for (let ch = 0; ch < output.length; ch++) {
      const outC = output[ch];
      const inC = input[ch] || new Float32Array(outC.length);
      outC.set(inC);
    }

    return true;
  }
}

registerProcessor('script-processor-processor', ScriptProcessorProcessor);
