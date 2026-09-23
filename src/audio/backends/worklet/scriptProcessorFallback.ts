/**
 * Buffered playback via ScriptProcessorNode for browsers without AudioWorklet.
 * Streaming (hi-fi) mode is not supported on this path.
 */

export interface ScriptProcessorPlaybackOptions {
  context: AudioContext;
  destination: AudioNode;
  pcm: Float32Array;
  channels: number;
  sampleRate: number;
  startSample: number;
  onTime: (seconds: number) => void;
  /** Fired once when the buffer runs out. */
  onEnded: () => void;
}

export function createScriptProcessorPlayback(opts: ScriptProcessorPlaybackOptions): ScriptProcessorNode {
  const { context, pcm, channels, sampleRate } = opts;
  const bufferSize = 4096;
  let position = opts.startSample;
  let ended = false;

  const node = context.createScriptProcessor(bufferSize, 0, channels);
  node.onaudioprocess = (e) => {
    const output = e.outputBuffer;
    const frames = output.length;

    for (let i = 0; i < frames; i++) {
      if (position >= pcm.length) {
        for (let ch = 0; ch < output.numberOfChannels; ch++) {
          output.getChannelData(ch)[i] = 0;
        }
        if (!ended) {
          ended = true;
          opts.onEnded();
        }
      } else {
        for (let ch = 0; ch < Math.min(output.numberOfChannels, channels); ch++) {
          output.getChannelData(ch)[i] = pcm[position + ch];
        }
        position += channels;
      }
    }

    opts.onTime(position / (channels * sampleRate));
  };

  node.connect(opts.destination);
  return node;
}

export function stopScriptProcessorPlayback(node: ScriptProcessorNode): void {
  node.onaudioprocess = null;
  node.disconnect();
}
