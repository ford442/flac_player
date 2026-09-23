import { AudioContextManager } from './AudioContextManager';
import { SDL_PCM_TAP_NAME, type SdlPcmTapOptions } from './worklets/sdlPcmTapMessages';

/** WASM exports from the SDL3 audio module. */
export interface SdlPcmModule {
  _get_pcm_ring_state(): number;
  _get_pcm_ring_data(): number;
  wasmMemory?: WebAssembly.Memory;
}

/** Static same-origin processor module (no blob URL). */
const SDL_PCM_TAP_URL = new URL('./worklets/sdlPcmTapProcessor.js', import.meta.url);

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
      await context.audioWorklet.addModule(SDL_PCM_TAP_URL.href);
    } catch (err) {
      console.warn('[SdlPcmBridge] Failed to load PCM tap worklet:', err);
      return;
    }

    const processorOptions: SdlPcmTapOptions = {
      memory: memoryBuffer,
      writeOffset: ringStatePtr,
      readOffset: ringStatePtr + 4,
      dataOffset: dataPtr,
      capacity,
      channels,
      sampleRate: context.sampleRate,
    };
    this.workletNode = new AudioWorkletNode(context, SDL_PCM_TAP_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [channels],
      processorOptions,
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
