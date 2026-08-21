type RecordingNodeKind =
  | 'destination'
  | 'gain'
  | 'compressor'
  | 'biquad'
  | 'analyser'
  | 'buffer-source';

export class RecordingAudioParam {
  value: number;

  constructor(value = 0) {
    this.value = value;
  }

  setValueAtTime(value: number, _startTime: number): AudioParam {
    this.value = value;
    return this as unknown as AudioParam;
  }

  linearRampToValueAtTime(value: number, _endTime: number): AudioParam {
    this.value = value;
    return this as unknown as AudioParam;
  }

  cancelScheduledValues(_cancelTime: number): AudioParam {
    return this as unknown as AudioParam;
  }
}

export class RecordingAudioNode {
  readonly connections: AudioNode[] = [];
  disconnectCalls = 0;

  constructor(
    readonly context: RecordingAudioContext,
    readonly kind: RecordingNodeKind
  ) {}

  connect(destination: AudioNode): AudioNode {
    this.connections.push(destination);
    return destination;
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    this.connections.length = 0;
  }
}

export class RecordingGainNode extends RecordingAudioNode {
  readonly gain = new RecordingAudioParam(1);

  constructor(context: RecordingAudioContext) {
    super(context, 'gain');
  }
}

export class RecordingDynamicsCompressorNode extends RecordingAudioNode {
  readonly threshold = new RecordingAudioParam(-24);
  readonly knee = new RecordingAudioParam(30);
  readonly ratio = new RecordingAudioParam(12);
  readonly attack = new RecordingAudioParam(0.003);
  readonly release = new RecordingAudioParam(0.25);

  constructor(context: RecordingAudioContext) {
    super(context, 'compressor');
  }
}

class RecordingBiquadFilterNode extends RecordingAudioNode {
  type: BiquadFilterType = 'lowpass';
  readonly frequency = new RecordingAudioParam(350);
  readonly gain = new RecordingAudioParam(0);
  readonly Q = new RecordingAudioParam(1);

  constructor(context: RecordingAudioContext) {
    super(context, 'biquad');
  }
}

class RecordingAnalyserNode extends RecordingAudioNode {
  fftSize = 2048;

  constructor(context: RecordingAudioContext) {
    super(context, 'analyser');
  }
}

export class RecordingAudioBuffer {
  readonly duration: number;
  private readonly channelData: Float32Array[];

  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number
  ) {
    this.duration = length / sampleRate;
    this.channelData = Array.from(
      { length: numberOfChannels },
      () => new Float32Array(length)
    );
  }

  getChannelData(channel: number): Float32Array {
    return this.channelData[channel];
  }
}

export interface RecordingStartCall {
  when: number;
  offset: number;
}

export class RecordingAudioBufferSourceNode extends RecordingAudioNode {
  buffer: AudioBuffer | null = null;
  readonly playbackRate = new RecordingAudioParam(1);
  onended: ((this: AudioScheduledSourceNode, ev: Event) => unknown) | null = null;
  readonly startCalls: RecordingStartCall[] = [];
  stopCalls = 0;

  constructor(context: RecordingAudioContext) {
    super(context, 'buffer-source');
  }

  start(when = 0, offset = 0): void {
    this.startCalls.push({ when, offset });
  }

  stop(): void {
    this.stopCalls += 1;
    this.onended?.call(this as unknown as AudioScheduledSourceNode, new Event('ended'));
  }
}

/** Minimal, inspectable Web Audio implementation for graph and scheduler tests. */
export class RecordingAudioContext {
  static readonly instances: RecordingAudioContext[] = [];

  readonly sampleRate: number;
  state: AudioContextState = 'running';
  currentTime = 0;
  readonly destination: AudioDestinationNode;
  readonly gainNodes: RecordingGainNode[] = [];
  readonly compressorNodes: RecordingDynamicsCompressorNode[] = [];
  readonly bufferSources: RecordingAudioBufferSourceNode[] = [];

  constructor(options: AudioContextOptions = {}) {
    this.sampleRate = options.sampleRate ?? 44100;
    this.destination = new RecordingAudioNode(this, 'destination') as unknown as AudioDestinationNode;
    RecordingAudioContext.instances.push(this);
  }

  setCurrentTime(time: number): void {
    this.currentTime = time;
  }

  createGain(): GainNode {
    const node = new RecordingGainNode(this);
    this.gainNodes.push(node);
    return node as unknown as GainNode;
  }

  createDynamicsCompressor(): DynamicsCompressorNode {
    const node = new RecordingDynamicsCompressorNode(this);
    this.compressorNodes.push(node);
    return node as unknown as DynamicsCompressorNode;
  }

  createBiquadFilter(): BiquadFilterNode {
    return new RecordingBiquadFilterNode(this) as unknown as BiquadFilterNode;
  }

  createAnalyser(): AnalyserNode {
    return new RecordingAnalyserNode(this) as unknown as AnalyserNode;
  }

  createBufferSource(): AudioBufferSourceNode {
    const node = new RecordingAudioBufferSourceNode(this);
    this.bufferSources.push(node);
    return node as unknown as AudioBufferSourceNode;
  }

  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer {
    return new RecordingAudioBuffer(channels, length, sampleRate) as unknown as AudioBuffer;
  }

  async resume(): Promise<void> {
    this.state = 'running';
  }

  async close(): Promise<void> {
    this.state = 'closed';
  }
}

/** Install the recording context globally and return a restoration callback. */
export function installRecordingAudioContext(): () => void {
  const previous = globalThis.AudioContext;
  RecordingAudioContext.instances.length = 0;
  Object.defineProperty(globalThis, 'AudioContext', {
    configurable: true,
    writable: true,
    value: RecordingAudioContext,
  });

  return () => {
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      writable: true,
      value: previous,
    });
    RecordingAudioContext.instances.length = 0;
  };
}
