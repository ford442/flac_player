// Minimal AudioWorkletGlobalScope declarations for the processor modules in this
// folder (checked via // @ts-check). lib.dom does not ship these.

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor
): void;

/** Global in AudioWorkletGlobalScope only — do not use from main-thread code. */
declare const sampleRate: number;
