import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { AudioContextManager } from '../src/audio/AudioContextManager';
import { WorkletAudioPlayer } from '../src/audio/backends/WorkletAudioPlayer';
import type { FlacProcessorInbound, FlacProcessorOptions } from '../src/audio/worklets/flacProcessorMessages';
import { attachPlayRing, playRingEnded, playRingWritePos } from '../src/audio/worklets/playRingSAB';
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

describe('WorkletAudioPlayer hi-fi transport', () => {
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
    expect(ctx.addedModules[0]).toMatch(/flacProcessor\.ts$/);
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

  it('forwards the playback rate (clamped) to every processor node', async () => {
    const player = new WorkletAudioPlayer(new AudioContextManager());
    player.setPlaybackRate(1.5);
    await player.startStreaming(2, 44100);
    const node = FakeAudioWorkletNode.instances.at(-1)!;
    expect(node.sent).toContainEqual({ type: 'setPlaybackRate', rate: 1.5 });
    player.setPlaybackRate(10);
    expect(node.sent.at(-1)).toEqual({ type: 'setPlaybackRate', rate: 4 });
    player.destroy();
  });

  it('shared ring: PCM goes into the SharedArrayBuffer, messages carry positions only', async () => {
    const player = new WorkletAudioPlayer(new AudioContextManager(), { sharedRing: true });
    await player.startStreaming(2, 44100);
    const node = FakeAudioWorkletNode.instances.at(-1)!;
    const start = node.sent.find((m) => m.type === 'startStreaming');
    expect(start && 'ring' in start && start.ring).toBeInstanceOf(SharedArrayBuffer);
    expect((node.options as { processorOptions: FlacProcessorOptions }).processorOptions.tapRing)
      .toBeInstanceOf(SharedArrayBuffer);

    player.appendChunk(new Float32Array(2048).fill(0.25));
    player.endStreaming();
    expect(node.sent.map((m) => m.type)).not.toContain('chunk');
    expect(node.sent.map((m) => m.type)).not.toContain('endStreaming');
    const ring = attachPlayRing(start && 'ring' in start ? start.ring! : new SharedArrayBuffer(16));
    expect(playRingWritePos(ring)).toBe(2048);
    expect(playRingEnded(ring)).toBe(true);
    player.destroy();
  });

  it('chunk fallback posts PCM when SharedArrayBuffer is unavailable', async () => {
    const player = new WorkletAudioPlayer(new AudioContextManager(), { sharedRing: false });
    await player.startStreaming(2, 44100);
    const node = FakeAudioWorkletNode.instances.at(-1)!;
    player.appendChunk(new Float32Array(2048));
    player.endStreaming();
    const types = node.sent.map((m) => m.type);
    expect(types).toContain('chunk');
    expect(types).toContain('endStreaming');
    player.destroy();
  });

  it('without AudioWorklet: fails loudly and reports no playback rate', async () => {
    (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode = undefined;
    const player = new WorkletAudioPlayer(new AudioContextManager());
    expect(player.getCapabilities()).toMatchObject({ playbackRate: false, gapless: false });
    await expect(player.startStreaming(2, 44100)).rejects.toThrow(/AudioWorklet/);
    player.destroy();
  });

  it('reports hi-fi capabilities honestly', async () => {
    const player = new WorkletAudioPlayer(new AudioContextManager());
    await player.startStreaming(2, 44100);
    expect(player.getCapabilities()).toMatchObject({ seek: true, gapless: true, playbackRate: true, crossfade: false });
    player.destroy();
  });
});
