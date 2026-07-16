import type { AudioOutputMode } from '../hooks/usePlayerState';
import { AudioContextManager, sharedAudioContextManager } from './AudioContextManager';
import type { ConfigurableAudioBackend } from '../types/audio';

export async function createAudioBackend(
  mode: AudioOutputMode,
  contextManager: AudioContextManager = sharedAudioContextManager
): Promise<ConfigurableAudioBackend> {
  switch (mode) {
    case 'streaming': {
      const { StreamingAudioPlayer } = await import('../streamingAudioPlayer');
      return new StreamingAudioPlayer(contextManager);
    }
    case 'worklet': {
      const { AudioWorkletPlayer } = await import('../audioWorkletPlayer');
      return new AudioWorkletPlayer(contextManager);
    }
    case 'sdl': {
      const { SdlAudioPlayer } = await import('../sdlAudioPlayer');
      return new SdlAudioPlayer(contextManager);
    }
    case 'sdl2': {
      const { Sdl2AudioPlayer } = await import('../sdl2AudioPlayer');
      return new Sdl2AudioPlayer(contextManager);
    }
    case 'web-audio': {
      const { AudioPlayer } = await import('../audioPlayer');
      return new AudioPlayer(contextManager);
    }
  }
}
