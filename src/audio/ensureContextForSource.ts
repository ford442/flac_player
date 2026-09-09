import { probeRemoteAudioDuration, parseAudioHeader } from '../utils/audioHeader';
import type { AudioContextManager } from './AudioContextManager';

export async function ensureContextForUrl(
  manager: AudioContextManager,
  url: string,
  signal?: AbortSignal
): Promise<void> {
  const header = await probeRemoteAudioDuration(url, signal);
  await manager.ensureForTrack({
    sampleRate: header?.sampleRate,
    channels: header?.channels,
  });
}

export async function ensureContextForBuffer(
  manager: AudioContextManager,
  buffer: ArrayBuffer
): Promise<void> {
  const header = parseAudioHeader(buffer);
  await manager.ensureForTrack({
    sampleRate: header?.sampleRate,
    channels: header?.channels,
  });
}
