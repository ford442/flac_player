type RecordingNodeKind =
  | 'destination'
  | 'gain'
  | 'compressor'
  | 'biquad'
  | 'analyser'
  | 'channel-splitter'
  | 'channel-merger'
  | 'buffer-source';

interface ChannelConfig {
  channelCount: number;
  channelCountMode: ChannelCountMode;
  channelInterpretation: ChannelInterpretation;
}

/** Spec defaults per node type; the compressor is the one clamped to stereo. */
const CHANNEL_DEFAULTS: Record<RecordingNodeKind, ChannelConfig> = {
  destination: { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' },
  gain: { channelCount: 2, channelCountMode: 'max', channelInterpretation: 'speakers' },
  compressor: { channelCount: 2, channelCountMode: 'clamped-max', channelInterpretation: 'speakers' },
  biquad: { channelCount: 2, channelCountMode: 'max', channelInterpretation: 'speakers' },
  analyser: { channelCount: 2, channelCountMode: 'max', channelInterpretation: 'speakers' },
  'channel-splitter': { channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'discrete' },
  'channel-merger': { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' },
  'buffer-source': { channelCount: 2, channelCountMode: 'max', channelInterpretation: 'speakers' },
};

export interface RecordingEdge {
  to: RecordingAudioNode;
  output: number;
  input: number;
}

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
  readonly edges: RecordingEdge[] = [];
  disconnectCalls = 0;
  channelCount: number;
  channelCountMode: ChannelCountMode;
  channelInterpretation: ChannelInterpretation;

  constructor(
    readonly context: RecordingAudioContext,
    readonly kind: RecordingNodeKind
  ) {
    ({
      channelCount: this.channelCount,
      channelCountMode: this.channelCountMode,
      channelInterpretation: this.channelInterpretation,
    } = CHANNEL_DEFAULTS[kind]);
  }

  connect(destination: AudioNode, output = 0, input = 0): AudioNode {
    this.connections.push(destination);
    this.edges.push({ to: destination as unknown as RecordingAudioNode, output, input });
    return destination;
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    this.connections.length = 0;
    this.edges.length = 0;
  }
}

export class RecordingChannelSplitterNode extends RecordingAudioNode {
  constructor(context: RecordingAudioContext, readonly numberOfOutputs: number) {
    super(context, 'channel-splitter');
    this.channelCount = numberOfOutputs;
  }
}

export class RecordingChannelMergerNode extends RecordingAudioNode {
  constructor(context: RecordingAudioContext, readonly numberOfInputs: number) {
    super(context, 'channel-merger');
  }
}

/** Every node reachable from `from` by connections (excluding `from`). */
export function reachableNodes(from: RecordingAudioNode): RecordingAudioNode[] {
  const seen = new Set<RecordingAudioNode>();
  const visit = (node: RecordingAudioNode) => {
    for (const { to } of node.edges) {
      if (seen.has(to)) continue;
      seen.add(to);
      visit(to);
    }
  };
  visit(from);
  return [...seen];
}

/**
 * Channels arriving at `target` when `source` emits `sourceChannels`, following the
 * spec's up/down-mix rules ('max', 'clamped-max', 'explicit'; splitter outputs are
 * mono, a merger emits one channel per input). Undefined if `target` is unreachable.
 */
export function channelsAt(
  source: RecordingAudioNode,
  sourceChannels: number,
  target: RecordingAudioNode
): number | undefined {
  const reach = [source, ...reachableNodes(source)];
  const incoming = (node: RecordingAudioNode): Array<{ from: RecordingAudioNode }> =>
    reach.flatMap((from) => from.edges.filter((e) => e.to === node).map(() => ({ from })));
  const memo = new Map<RecordingAudioNode, number>();
  const emitted = (from: RecordingAudioNode): number => {
    if (from === source) return sourceChannels;
    if (from instanceof RecordingChannelSplitterNode) return 1;
    return computedInput(from);
  };
  const computedInput = (node: RecordingAudioNode): number => {
    const cached = memo.get(node);
    if (cached !== undefined) return cached;
    let result: number;
    if (node instanceof RecordingChannelMergerNode) {
      result = node.numberOfInputs;
    } else if (node.channelCountMode === 'explicit') {
      result = node.channelCount;
    } else {
      const widest = Math.max(1, ...incoming(node).map(({ from }) => emitted(from)));
      result = node.channelCountMode === 'clamped-max' ? Math.min(widest, node.channelCount) : widest;
    }
    memo.set(node, result);
    return result;
  };
  return reach.includes(target) ? computedInput(target) : undefined;
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

export class RecordingDestinationNode extends RecordingAudioNode {
  channelCount = 2;
  maxChannelCount = 2;
  channelCountMode: ChannelCountMode = 'explicit';
  channelInterpretation: ChannelInterpretation = 'speakers';

  constructor(context: RecordingAudioContext) {
    super(context, 'destination');
  }
}

class RecordingAnalyserNode extends RecordingAudioNode {
  // NaN until the graph applies an explicit policy (see analyserPolicy.test.ts).
  fftSize = NaN;
  smoothingTimeConstant = NaN;
  minDecibels = NaN;
  maxDecibels = NaN;

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
  /** Return true to make the constructor throw for these options (NotSupportedError). */
  static rejectOptions: ((options: AudioContextOptions & { sinkId?: string }) => boolean) | null = null;
  static maxChannelCount = 2;
  /** State a new context starts in ('suspended' models a gesture-gated start). */
  static initialState: AudioContextState | 'interrupted' = 'running';
  /** Lifecycle calls across instances, in order: `resume:<index>` / `close:<index>`. */
  static readonly events: string[] = [];

  readonly index: number;
  readonly constructorOptions: AudioContextOptions;
  readonly sampleRate: number;
  readonly latencyHint: AudioContextLatencyCategory | number | undefined;
  state: AudioContextState = 'running';
  private readonly stateListeners = new Set<() => void>();
  currentTime = 0;
  readonly destination: AudioDestinationNode;
  readonly baseLatency = 0.01;
  outputLatency = 0.02;
  sinkId: string;
  readonly setSinkIdCalls: string[] = [];
  readonly gainNodes: RecordingGainNode[] = [];
  readonly compressorNodes: RecordingDynamicsCompressorNode[] = [];
  readonly bufferSources: RecordingAudioBufferSourceNode[] = [];

  constructor(options: AudioContextOptions & { sinkId?: string } = {}) {
    if (RecordingAudioContext.rejectOptions?.(options)) {
      throw new DOMException('rejected by test', 'NotSupportedError');
    }
    this.constructorOptions = options;
    this.sampleRate = options.sampleRate ?? 44100;
    this.latencyHint = options.latencyHint;
    this.sinkId = options.sinkId ?? '';
    this.state = RecordingAudioContext.initialState as AudioContextState;
    this.index = RecordingAudioContext.instances.length;
    const destination = new RecordingDestinationNode(this);
    destination.maxChannelCount = RecordingAudioContext.maxChannelCount;
    this.destination = destination as unknown as AudioDestinationNode;
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

  createChannelSplitter(numberOfOutputs = 6): ChannelSplitterNode {
    return new RecordingChannelSplitterNode(this, numberOfOutputs) as unknown as ChannelSplitterNode;
  }

  createChannelMerger(numberOfInputs = 6): ChannelMergerNode {
    return new RecordingChannelMergerNode(this, numberOfInputs) as unknown as ChannelMergerNode;
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

  async setSinkId(sinkId: string): Promise<void> {
    this.setSinkIdCalls.push(sinkId);
    if (sinkId === 'missing-device') {
      throw new DOMException('device not found', 'NotFoundError');
    }
    this.sinkId = sinkId;
  }

  suspendCalls = 0;
  readonly addedModules: string[] = [];
  readonly audioWorklet = {
    addModule: async (url: string): Promise<void> => {
      this.addedModules.push(url);
    },
  };

  addEventListener(type: string, listener: () => void): void {
    if (type === 'statechange') this.stateListeners.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === 'statechange') this.stateListeners.delete(listener);
  }

  /** Change state the way the platform does: assign, then fire `statechange`. */
  setState(state: AudioContextState | 'interrupted'): void {
    this.state = state as AudioContextState;
    for (const listener of [...this.stateListeners]) listener();
  }

  resumeCalls = 0;

  async resume(): Promise<void> {
    this.resumeCalls += 1;
    RecordingAudioContext.events.push(`resume:${this.index}`);
    if (this.state === 'closed') throw new DOMException('closed', 'InvalidStateError');
    if (this.state !== 'running') this.setState('running');
  }

  async suspend(): Promise<void> {
    this.suspendCalls += 1;
    this.state = 'suspended';
  }

  async close(): Promise<void> {
    RecordingAudioContext.events.push(`close:${this.index}`);
    this.setState('closed');
  }
}

/** Install the recording context globally and return a restoration callback. */
export function installRecordingAudioContext(): () => void {
  const previous = globalThis.AudioContext;
  RecordingAudioContext.instances.length = 0;
  RecordingAudioContext.events.length = 0;
  RecordingAudioContext.rejectOptions = null;
  RecordingAudioContext.maxChannelCount = 2;
  RecordingAudioContext.initialState = 'running';
  Object.defineProperty(globalThis, 'AudioContext', {
    configurable: true,
    writable: true,
    // A fresh subclass per install: module-level caches keyed on the constructor
    // (the sample-rate probe memo) must not carry answers between tests.
    value: class extends RecordingAudioContext {},
  });

  return () => {
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      writable: true,
      value: previous,
    });
    RecordingAudioContext.instances.length = 0;
    RecordingAudioContext.events.length = 0;
    RecordingAudioContext.rejectOptions = null;
    RecordingAudioContext.initialState = 'running';
  };
}
