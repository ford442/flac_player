export const SDL_PCM_TAP_NAME = 'sdl-pcm-tap';

/** processorOptions for the `sdl-pcm-tap` AudioWorkletProcessor (sdlPcmTapProcessor.js). */
export interface SdlPcmTapOptions {
  memory: ArrayBuffer | SharedArrayBuffer;
  writeOffset: number;
  readOffset: number;
  dataOffset: number;
  capacity: number;
  channels: number;
  sampleRate: number;
}
