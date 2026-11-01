/**
 * Contract between Sdl3AudioPlayer (main thread), the C++ engine
 * (src/sdl/audio_engine.cpp, engine_state.h, play_ring.h) and the `sdl-engine`
 * AudioWorkletProcessor (sdlEngineProcessor.js), which reads the engine's PCM
 * out of the module's shared memory on the audio thread. There are no port
 * messages: the main thread writes transport words through the engine's
 * exports, and the processor publishes its progress in the same block.
 *
 * The processor is a classic script and repeats these word indices;
 * tests/sdlEngineProcessor.test.ts checks them against this file and the
 * C++ static_asserts.
 */

export const SDL_ENGINE_PROCESSOR_NAME = 'sdl-engine';

/** processorOptions for the `sdl-engine` processor. */
export interface SdlEngineOptions {
  /** The engine module's shared memory (`-pthread`), so its buffer is a SharedArrayBuffer. */
  memory: WebAssembly.Memory;
  /** Byte offset of EngineState (`_get_engine_state`). */
  statePtr: number;
  /** Byte offset of PlayRingState (`_get_play_ring_state`). */
  ringStatePtr: number;
  /** Byte offset of the play ring's floats (`_get_play_ring_data`). */
  ringDataPtr: number;
  /** Written to EngineState.owner (`_set_output_owner`) before construction; any other value retires the processor. */
  owner: number;
}

/** u32 word index of each EngineState field (engine_state.h). */
export const ENGINE_STATE_WORDS = {
  epoch: 0,
  mode: 1,
  playing: 2,
  channels: 3,
  sampleRate: 4,
  rateBits: 5,
  bufferPtr: 6,
  bufferFloats: 7,
  startFrame: 8,
  ringStart: 9,
  owner: 10,
  ackEpoch: 11,
  framesPlayed: 12,
  drained: 13,
} as const;

export const ENGINE_STATE_WORD_COUNT = 16;

/** u32 word index of each PlayRingState field (play_ring.h). */
export const PLAY_RING_WORDS = {
  writePos: 0,
  readPos: 1,
  capacity: 2,
  ended: 3,
} as const;

/** EngineMode (engine_state.h). */
export const ENGINE_MODE = {
  idle: 0,
  buffered: 1,
  stream: 2,
} as const;
