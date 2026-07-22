import { parseBuffer } from 'music-metadata';
import type { ReplayGainTags } from './replayGain';
import { parseReplayGainFromCommon } from './replayGain';

const TAG_PROBE_BYTES = 65536;

/**
 * Range-fetch the first 64 KiB of a remote audio file and parse ReplayGain tags.
 * Returns undefined when the fetch fails or no tags are present.
 */
export async function fetchReplayGainFromUrl(url: string, signal?: AbortSignal): Promise<ReplayGainTags | undefined> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Range: `bytes=0-${TAG_PROBE_BYTES - 1}` },
      signal,
    });
    if (!response.ok && response.status !== 206) return undefined;

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0) return undefined;

    const meta = await parseBuffer(new Uint8Array(buffer), {
      mimeType: response.headers.get('content-type') ?? undefined,
    });
    const tags = parseReplayGainFromCommon(meta.common);
    if (tags.trackDb === undefined && tags.albumDb === undefined) return undefined;
    return tags;
  } catch {
    return undefined;
  }
}
