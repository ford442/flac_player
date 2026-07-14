import { AudioPlayer } from '../audioPlayer';
import { AudioWorkletPlayer } from '../audioWorkletPlayer';
import { Sdl2AudioPlayer } from '../sdl2AudioPlayer';
import { SdlAudioPlayer } from '../sdlAudioPlayer';
import { StreamingAudioPlayer } from '../streamingAudioPlayer';
import type { AudioOutputMode } from '../hooks/usePlayerState';
import { AudioContextManager, sharedAudioContextManager } from './AudioContextManager';
import type { ConfigurableAudioBackend } from '../types/audio';

export function createAudioBackend(
  mode: AudioOutputMode,
  contextManager: AudioContextManager = sharedAudioContextManager
): ConfigurableAudioBackend {
  switch (mode) {
    case 'streaming': return new StreamingAudioPlayer(contextManager);
    case 'worklet': return new AudioWorkletPlayer(contextManager);
    case 'sdl': return new SdlAudioPlayer(contextManager);
    case 'sdl2': return new Sdl2AudioPlayer(contextManager);
    case 'web-audio': return new AudioPlayer(contextManager);
  }
}
