import { AudioContextManager } from './AudioContextManager';

/** WASM exports shared by SDL3 and SDL2 audio modules. */
export interface SdlPcmModule {
  _get_pcm_ring_state(): number;
  _get_pcm_ring_data(): number;
  wasmMemory?: WebAssembly.Memory;
}

const SDL_PCM_TAP_PROCESSOR = `
class SdlPcmTapProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions;
    this.memory = o.memory;
    this.writeIdx = new Int32Array(this.memory, o.writeOffset, 1);
    this.readIdx = new Int32Array(this.memory, o.readOffset, 1);
    this.capacity = o.capacity;
    this.pcmData = new Float32Array(this.memory, o.dataOffset, o.capacity);
    this.channels = o.channels || 2;
    this.localReadPos = Atomics.load(this.readIdx, 0) >>> 0;
  }

  process(inputs, outputs) {
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
`;

let workletBlobUrl: string | null = null;

function getWorkletUrl(): string {
  if (!workletBlobUrl) {
    workletBlobUrl = URL.createObjectURL(
      new Blob([SDL_PCM_TAP_PROCESSOR], { type: 'application/javascript' })
    );
  }
  return workletBlobUrl;
}

/**
 * Bridges SDL WASM playback into the shared Web Audio analyser graph.
 * SDL owns speaker output; this worklet feeds the analyser only (speakers muted).
 */
export class SdlPcmBridge {
  private workletNode: AudioWorkletNode | null = null;
  private connected = false;

  async connect(
    contextManager: AudioContextManager,
    module: SdlPcmModule,
    channels: number
  ): Promise<void> {
    this.disconnect(contextManager);

    const memoryBuffer = module.wasmMemory?.buffer;
    if (!memoryBuffer) {
      console.warn('[SdlPcmBridge] wasmMemory unavailable; visualizer will stay silent.');
      return;
    }

    const ringStatePtr = module._get_pcm_ring_state();
    const dataPtr = module._get_pcm_ring_data();
    if (!ringStatePtr || !dataPtr) {
      console.warn('[SdlPcmBridge] PCM ring not initialized in WASM.');
      return;
    }

    const headerView = new Uint32Array(memoryBuffer, ringStatePtr, 4);
    const capacity = headerView[2];
    if (!capacity) {
      console.warn('[SdlPcmBridge] PCM ring capacity is zero.');
      return;
    }

    const context = contextManager.getContext();
    if (!context.audioWorklet) {
      console.warn('[SdlPcmBridge] AudioWorklet unavailable; visualizer will stay silent.');
      return;
    }

    try {
      await context.audioWorklet.addModule(getWorkletUrl());
    } catch (err) {
      console.warn('[SdlPcmBridge] Failed to load PCM tap worklet:', err);
      return;
    }

    this.workletNode = new AudioWorkletNode(context, 'sdl-pcm-tap', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [channels],
      processorOptions: {
        memory: memoryBuffer,
        writeOffset: ringStatePtr,
        readOffset: ringStatePtr + 4,
        dataOffset: dataPtr,
        capacity,
        channels,
      },
    });

    contextManager.connectVisualizerFeed(this.workletNode);
    contextManager.setExternalPlaybackActive(true);
    this.connected = true;
  }

  disconnect(contextManager: AudioContextManager): void {
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.connected) {
      contextManager.setExternalPlaybackActive(false);
      this.connected = false;
    }
  }

  resetRing(module: SdlPcmModule): void {
    const memoryBuffer = module.wasmMemory?.buffer;
    const ringStatePtr = module._get_pcm_ring_state?.();
    if (!memoryBuffer || !ringStatePtr) return;

    const writeIdx = new Int32Array(memoryBuffer, ringStatePtr, 1);
    const readIdx = new Int32Array(memoryBuffer, ringStatePtr + 4, 1);
    Atomics.store(writeIdx, 0, 0);
    Atomics.store(readIdx, 0, 0);
  }
}

export const sharedSdlPcmBridge = new SdlPcmBridge();
