import type { AudioOutputMode } from '../hooks/usePlayerState';
import { AudioContextManager, sharedAudioContextManager } from './AudioContextManager';
import type { ConfigurableAudioBackend } from '../types/audio';

export async function createAudioBackend(
  mode: AudioOutputMode,
  contextManager: AudioContextManager = sharedAudioContextManager
): Promise<ConfigurableAudioBackend> {
  switch (mode) {
    case 'streaming': {
      const { StreamingAudioPlayer } = await import('./backends/StreamingAudioPlayer');
      return new StreamingAudioPlayer(contextManager);
    }
    case 'worklet': {
      const { WorkletAudioPlayer } = await import('./backends/WorkletAudioPlayer');
      return new WorkletAudioPlayer(contextManager);
    }
    case 'sdl': {
      const { Sdl3AudioPlayer } = await import('./backends/Sdl3AudioPlayer');
      return new Sdl3AudioPlayer(contextManager);
    }
    case 'sdl2': {
      const { Sdl2AudioPlayer } = await import('./backends/Sdl2AudioPlayer');
      return new Sdl2AudioPlayer(contextManager);
    }
    case 'web-audio': {
      const { WebAudioPlayer } = await import('./backends/WebAudioPlayer');
      return new WebAudioPlayer(contextManager);
    }
  }
}
