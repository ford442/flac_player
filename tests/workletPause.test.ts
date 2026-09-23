import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { AudioContextManager } from '../src/audio/AudioContextManager';
import { WorkletAudioPlayer } from '../src/audio/backends/WorkletAudioPlayer';
import type { FlacProcessorInbound } from '../src/audio/worklets/flacProcessorMessages';
import { RecordingAudioContext, installRecordingAudioContext } from './helpers/recordingAudioContext';

class FakeAudioWorkletNode {
  static instances: FakeAudioWorkletNode[] = [];
  readonly sent: FlacProcessorInbound[] = [];
  readonly port = {
    onmessage: null as ((e: MessageEvent) => void) | null,
    postMessage: (msg: FlacProcessorInbound) => { this.sent.push(msg); },
  };
  constructor(readonly context: unknown, readonly name: string, readonly options: unknown) {
    FakeAudioWorkletNode.instances.push(this);
  }
  connect(dest: unknown) { return dest; }
  disconnect() {}
}

describe('WorkletAudioPlayer hi-fi pause', () => {
  let restore: (() => void) | undefined;
  const prevNode = (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode;

  beforeEach(() => {
    restore = installRecordingAudioContext();
    FakeAudioWorkletNode.instances.length = 0;
    (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode = FakeAudioWorkletNode;
  });
  afterEach(() => {
    restore?.();
    (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode = prevNode;
  });

  it('pauses via the processor port and leaves the shared context running', async () => {
    const manager = new AudioContextManager();
    const player = new WorkletAudioPlayer(manager);
    await player.startStreaming(2, 44100);

    const ctx = RecordingAudioContext.instances.at(-1)!;
    expect(ctx.addedModules[0]).toMatch(/flacProcessor\.js$/);
    expect(ctx.addedModules[0]).not.toMatch(/^blob:/);

    player.pause();
    expect(ctx.suspendCalls).toBe(0);
    expect(ctx.state).toBe('running');
    const node = FakeAudioWorkletNode.instances.at(-1)!;
    expect(node.sent.map((m) => m.type)).toContain('pause');
    expect(player.getState().isPlaying).toBe(false);

    player.play();
    expect(node.sent.at(-1)?.type).toBe('resume');
    expect(ctx.state).toBe('running');
    expect(player.getState().isPlaying).toBe(true);
    player.destroy();
  });

  it('reports hi-fi capabilities honestly', async () => {
    const player = new WorkletAudioPlayer(new AudioContextManager());
    await player.startStreaming(2, 44100);
    expect(player.getCapabilities()).toMatchObject({ seek: false, playbackRate: false, crossfade: false });
    player.destroy();
  });
});
