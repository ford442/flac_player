import type { AudioOutputMode } from '../hooks/usePlayerState';
import { AudioContextManager, sharedAudioContextManager } from './AudioContextManager';
import type { ConfigurableAudioBackend } from '../types/audio';

export async function createAudioBackend(
  mode: AudioOutputMode,
  contextManager: AudioContextManager = sharedAudioContextManager
): Promise<ConfigurableAudioBackend> {
  switch (mode) {
    case 'streaming': {
      const { StreamingAudioPlayer } = await import('./backends/streamingAudioPlayer');
      return new StreamingAudioPlayer(contextManager);
    }
    case 'worklet': {
      const { AudioWorkletPlayer } = await import('./backends/audioWorkletPlayer');
      return new AudioWorkletPlayer(contextManager);
    }
    case 'sdl': {
      const { SdlAudioPlayer } = await import('./backends/sdlAudioPlayer');
      return new SdlAudioPlayer(contextManager);
    }
    case 'sdl2': {
      const { Sdl2AudioPlayer } = await import('./backends/sdl2AudioPlayer');
      return new Sdl2AudioPlayer(contextManager);
    }
    case 'web-audio': {
      const { AudioPlayer } = await import('./backends/audioPlayer');
      return new AudioPlayer(contextManager);
    }
  }
}
