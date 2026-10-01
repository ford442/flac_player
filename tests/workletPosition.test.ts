import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { AudioContextManager } from '../src/audio/AudioContextManager';
import { WorkletAudioPlayer } from '../src/audio/backends/WorkletAudioPlayer';
import type { AudioPlaybackState } from '../src/types/audio';
import { installRecordingAudioContext } from './helpers/recordingAudioContext';

class FakeAudioWorkletNode {
  static instances: FakeAudioWorkletNode[] = [];
  readonly port = {
    onmessage: null as ((e: MessageEvent) => void) | null,
    postMessage: () => {},
  };
  constructor(readonly context: unknown, readonly name: string, readonly options: unknown) {
    FakeAudioWorkletNode.instances.push(this);
  }
  connect(dest: unknown) { return dest; }
  disconnect() {}
}

describe('WorkletAudioPlayer position updates', () => {
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

  // The UI only sees playback progress through the state callback, so a
  // position message that updates currentTime silently freezes the seek bar.
  it('notifies state listeners when the processor reports a new position', async () => {
    const player = new WorkletAudioPlayer(new AudioContextManager());
    await player.startStreaming(2, 44100);

    const states: AudioPlaybackState[] = [];
    player.setStateChangeCallback((state) => { states.push(state); });

    const node = FakeAudioWorkletNode.instances.at(-1)!;
    node.port.onmessage!({ data: { type: 'position', position: 1.5, consumed: 132300, epoch: 0 } } as MessageEvent);

    expect(player.getState().currentTime).toBe(1.5);
    expect(states.at(-1)?.currentTime).toBe(1.5);
    player.destroy();
  });
});
