import { StreamingDecoder } from '../utils/streamingDecoder';
import {
  confirmRangeSupport,
  createBlobReader,
  createRangeReader,
  probeRemoteAudio,
  streamFromReader,
  streamRemoteAudio,
  type RangeByteReader,
  type RangeFetchProgress,
} from '../utils/rangeFetch';
import { locateFrame, readFlacHeader, syntheticFlacPrefix, type FlacStreamHeader } from './flacSeek';

export interface HifiTrackSource {
  url: string;
  /** Pre-fetched Response (e.g. from track cache) — read lazily as a Blob, never arrayBuffer(). */
  cachedResponse?: Response;
  expectedDuration?: number;
}

/** A track after the HEAD probe + metadata read; reused by every seek. */
export interface OpenedHifiTrack {
  url: string;
  /** Null when the server has no Range support: seek falls back to skip-decode from 0. */
  reader: RangeByteReader | null;
  header: FlacStreamHeader | null;
  /** Exact duration from STREAMINFO, when the encoder recorded total samples. */
  duration: number | null;
}

export async function openHifiTrack(source: HifiTrackSource, signal?: AbortSignal): Promise<OpenedHifiTrack> {
  let reader: RangeByteReader | null = null;
  if (source.cachedResponse) {
    reader = createBlobReader(await source.cachedResponse.blob());
  } else {
    const probe = await confirmRangeSupport(await probeRemoteAudio(source.url, signal), signal);
    const rangeReader = createRangeReader(probe);
    reader = rangeReader.seekable ? rangeReader : null;
  }

  let header: FlacStreamHeader | null = null;
  if (reader) {
    try {
      header = await readFlacHeader(reader, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn('[hifiStream] FLAC header unreadable; seek will skip-decode:', err);
    }
  }
  const info = header?.streamInfo;
  const duration = info && info.totalSamples > 0 && info.sampleRate > 0
    ? info.totalSamples / info.sampleRate
    : null;
  return { url: source.url, reader, header, duration };
}

export interface HifiStreamPipelineOptions {
  url: string;
  /** Pre-fetched Response (e.g. from track cache) — streams without full arrayBuffer(). */
  cachedResponse?: Response;
  /** Already-opened track (seek restarts, gapless splice). Skips the probe. */
  opened?: OpenedHifiTrack;
  /** Start decoding at this media time (sample-accurate when the file is seekable). */
  startSeconds?: number;
  /** Pre-initialized decoder (consumed: destroyed when the run ends). */
  decoder?: Promise<StreamingDecoder>;
  expectedDuration?: number;
  signal?: AbortSignal;
  onProgress?: (progress: RangeFetchProgress) => void;
  onMetadata?: (meta: { channels: number; sampleRate: number }) => void | Promise<void>;
  onPcmChunk: (interleaved: Float32Array) => void | Promise<void>;
  onEnded: () => void;
  onError: (error: Error) => void;
}

/**
 * Fetch FLAC in HTTP Range chunks → WASM decodeChunk → PCM callbacks.
 * Never materializes the full compressed file in memory.
 *
 * With `startSeconds`, the decoder starts at the frame located by flacSeek.ts
 * (behind a synthetic `fLaC` + STREAMINFO prefix) and the leading
 * `target - frameStart` frames are dropped, so the first PCM delivered is the
 * target sample. Without Range support it skip-decodes from the start.
 */
export async function runHifiStreamPipeline(options: HifiStreamPipelineOptions): Promise<void> {
  const signal = options.signal;
  let decoder: StreamingDecoder | null = null;

  try {
    if (options.decoder) {
      decoder = await options.decoder;
    } else {
      decoder = new StreamingDecoder();
      await decoder.init();
    }
    const dec = decoder;

    const opened = options.opened ?? await openHifiTrack(
      { url: options.url, cachedResponse: options.cachedResponse },
      signal
    );
    if (signal?.aborted) return;

    const startSeconds = Math.max(0, options.startSeconds ?? 0);
    let startByte = 0;
    let prefix: ArrayBuffer | null = null;
    /** Leading frames to drop; null = derive from `startSeconds` once the rate is known. */
    let skipFrames: number | null = startSeconds > 0 ? null : 0;

    const header = opened.header;
    if (startSeconds > 0 && header && opened.reader?.seekable) {
      const info = header.streamInfo;
      let target = Math.round(startSeconds * info.sampleRate);
      if (info.totalSamples > 0) target = Math.min(target, info.totalSamples);
      const pos = await locateFrame(opened.reader, header, target, signal);
      if (signal?.aborted) return;
      if (pos) {
        startByte = pos.offset;
        skipFrames = target - pos.sample;
        if (startByte > 0) prefix = syntheticFlacPrefix(header);
      } else {
        skipFrames = target;
      }
    }

    let metadataSent = false;

    dec.onChunkDecoded(async (chunk) => {
      if (signal?.aborted) return;
      if (!metadataSent && chunk.sampleRate > 0 && chunk.channels > 0) {
        metadataSent = true;
        await options.onMetadata?.({ channels: chunk.channels, sampleRate: chunk.sampleRate });
      }
      let pcm = chunk.interleavedBuffer;
      const channels = Math.max(1, chunk.channels);
      if (skipFrames === null) skipFrames = Math.round(startSeconds * chunk.sampleRate);
      if (skipFrames > 0) {
        const frames = Math.floor(pcm.length / channels);
        if (skipFrames >= frames) {
          skipFrames -= frames;
          return;
        }
        pcm = pcm.subarray(skipFrames * channels);
        skipFrames = 0;
      }
      if (pcm.length > 0) await options.onPcmChunk(pcm);
    });

    dec.onEnded(() => options.onEnded());
    dec.onError((err) => options.onError(err));

    const streamOptions = {
      signal,
      onProgress: options.onProgress,
    };

    if (prefix) await dec.appendChunk(prefix);

    const chunks = opened.reader
      ? streamFromReader(opened.reader, startByte, streamOptions)
      : streamRemoteAudio(opened.url, streamOptions);
    for await (const raw of chunks) {
      if (signal?.aborted) return;
      await dec.appendChunk(raw);
    }
    if (signal?.aborted) return;

    await dec.flush();
  } catch (err) {
    if (signal?.aborted) return;
    options.onError(err instanceof Error ? err : new Error(String(err)));
  } finally {
    decoder?.destroy();
  }
}

export interface HifiStreamFormat {
  channels: number;
  sampleRate: number;
}

/** Backend side of a {@link HifiStreamSession}: the worklet ring or the SDL play ring. */
export interface HifiStreamSink {
  /** First decoded format of a `load()` (not repeated on seek or splice). */
  onFormat(format: HifiStreamFormat): Promise<void>;
  /** Must stop pushing (and return) once `signal` aborts. */
  pushPcm(pcm: Float32Array, signal: AbortSignal): Promise<void>;
  /**
   * Every sample of the audible track is pushed; the next track's PCM follows
   * back-to-back in the same ring. The backend records the boundary and calls
   * {@link HifiStreamSession.crossBoundary} when playback reaches it.
   */
  onSplice(next: { duration: number | null; format: HifiStreamFormat }): void;
  /** Decode finished and nothing was spliced: drain the ring, then end. */
  onDecodeEnded(): void;
  onError(error: Error): void;
}

interface SessionTrack {
  source: HifiTrackSource;
  opened: Promise<OpenedHifiTrack>;
  format: HifiStreamFormat | null;
}

function openTrack(source: HifiTrackSource, signal: AbortSignal): SessionTrack {
  const opened = openHifiTrack(source, signal);
  opened.catch(() => { /* surfaced where awaited */ });
  return { source, opened, format: null };
}

/**
 * One hi-fi stream = the audible track plus an optional gapless successor.
 *
 *   load(A)            → decode A into the sink
 *   setNext(B)         → probe B's header ahead of time
 *   A decode ends      → same channels/rate? onSplice, decode B into the same ring
 *                        (≤ one render quantum of extra silence); else onDecodeEnded
 *   crossBoundary()    → backend heard B start; B is now the audible track
 *   seek(t)            → abort the decode, restart the audible track at t
 *
 * Only one decoder runs at a time and memory stays bounded by the sink's ring —
 * nothing holds a whole decoded track.
 */
export class HifiStreamSession {
  private audible: SessionTrack | null = null;
  /** Spliced into the ring but not yet heard. */
  private pending: SessionTrack | null = null;
  private next: SessionTrack | null = null;
  private run: AbortController | null = null;
  private trackAbort: AbortController | null = null;
  private nextAbort: AbortController | null = null;
  /** Warm decoder (worker + WASM compiled) so a seek does not pay ~0.3–0.5 s startup. */
  private spare: Promise<StreamingDecoder> | null = null;

  constructor(private readonly sink: HifiStreamSink) {}

  private takeDecoder(): Promise<StreamingDecoder> {
    const warm = () => {
      const d = new StreamingDecoder();
      const ready = d.init().then(() => d);
      ready.catch(() => d.destroy());
      return ready;
    };
    const taken = this.spare ?? warm();
    this.spare = warm();
    return taken;
  }

  get audibleDuration(): Promise<number | null> {
    return this.audible ? this.audible.opened.then((o) => o.duration, () => null) : Promise.resolve(null);
  }

  get isActive(): boolean {
    return this.audible !== null;
  }

  get hasPendingSplice(): boolean {
    return this.pending !== null;
  }

  /** Start a new stream; resolves once the first PCM format is configured. */
  load(source: HifiTrackSource, options: { onProgress?: (p: RangeFetchProgress) => void } = {}): Promise<void> {
    // Keeps `next`: the backend may queue the successor before loading.
    this.run?.abort();
    this.trackAbort?.abort();
    this.pending = null;
    this.trackAbort = new AbortController();
    this.audible = openTrack(source, this.trackAbort.signal);
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (err?: unknown) => {
        if (settled) return;
        settled = true;
        if (err) reject(err instanceof Error ? err : new Error(String(err)));
        else resolve();
      };
      this.startRun(0, { onFirstFormat: () => settle(), onFail: settle, onProgress: options.onProgress });
    });
  }

  /** Restart the audible track at `seconds`. Returns false when nothing is loaded. */
  seek(seconds: number): boolean {
    if (!this.audible) return false;
    if (this.pending) {
      // The successor was spliced but not heard: it will be spliced again at the new end.
      this.next = this.pending;
      this.pending = null;
    }
    this.startRun(Math.max(0, seconds), {});
    return true;
  }

  /** Queue (or clear) the gapless successor. Its header is probed immediately. */
  setNext(source: HifiTrackSource | null): void {
    if (source && (this.pending?.source.url === source.url || this.next?.source.url === source.url)) return;
    this.nextAbort?.abort();
    this.nextAbort = null;
    this.next = null;
    if (!source) return;
    this.nextAbort = new AbortController();
    this.next = openTrack(source, this.nextAbort.signal);
  }

  /** Playback reached the splice point: the pending track is now audible. */
  crossBoundary(): void {
    if (!this.pending) return;
    this.audible = this.pending;
    this.pending = null;
  }

  cancel(): void {
    this.run?.abort();
    this.run = null;
    this.trackAbort?.abort();
    this.trackAbort = null;
    this.nextAbort?.abort();
    this.nextAbort = null;
    this.audible = null;
    this.pending = null;
    this.next = null;
    const spare = this.spare;
    this.spare = null;
    spare?.then((d) => d.destroy(), () => {});
  }

  private startRun(
    startSeconds: number,
    hooks: {
      onFirstFormat?: () => void;
      onFail?: (err: unknown) => void;
      onProgress?: (p: RangeFetchProgress) => void;
    }
  ): void {
    this.run?.abort();
    const run = new AbortController();
    this.run = run;
    const task = this.runChain(this.audible!, startSeconds, run.signal, hooks);
    task.catch((err) => {
      if (run.signal.aborted) return;
      hooks.onFail?.(err);
      this.sink.onError(err instanceof Error ? err : new Error(String(err)));
    });
  }

  private async runChain(
    first: SessionTrack,
    startSeconds: number,
    signal: AbortSignal,
    hooks: { onFirstFormat?: () => void; onFail?: (err: unknown) => void; onProgress?: (p: RangeFetchProgress) => void }
  ): Promise<void> {
    let track = first;
    let start = startSeconds;
    let isFirst = true;

    for (;;) {
      const opened = await track.opened;
      if (signal.aborted) return;

      let ended = false;
      let failure: Error | null = null;
      const current = track;
      const reportFormat = isFirst ? hooks.onFirstFormat : undefined;
      await runHifiStreamPipeline({
        url: opened.url,
        opened,
        startSeconds: start,
        decoder: this.takeDecoder(),
        signal,
        onProgress: isFirst ? hooks.onProgress : undefined,
        onMetadata: async (format) => {
          const known = current.format;
          current.format = format;
          if (reportFormat && !known) {
            await this.sink.onFormat(format);
            reportFormat();
          }
        },
        onPcmChunk: (pcm) => this.sink.pushPcm(pcm, signal),
        onEnded: () => { ended = true; },
        onError: (err) => { failure ??= err; },
      });
      if (signal.aborted) return;
      if (failure || !ended) {
        throw failure ?? new Error('Hi-fi stream ended unexpectedly');
      }

      const successor = await this.spliceCandidate(current, signal);
      if (signal.aborted) return;
      if (!successor) {
        this.sink.onDecodeEnded();
        return;
      }
      const nextOpened = await successor.opened;
      this.next = null;
      this.pending = successor;
      this.sink.onSplice({ duration: nextOpened.duration, format: successor.format! });
      track = successor;
      start = 0;
      isFirst = false;
    }
  }

  /** The queued successor, when its format matches the ring (else the backend must reload). */
  private async spliceCandidate(current: SessionTrack, signal: AbortSignal): Promise<SessionTrack | null> {
    const next = this.next;
    if (!next || !current.format) return null;
    let opened: OpenedHifiTrack;
    try {
      opened = await next.opened;
    } catch {
      return null;
    }
    if (signal.aborted || this.next !== next) return null;
    const info = opened.header?.streamInfo;
    if (!info || info.channels !== current.format.channels || info.sampleRate !== current.format.sampleRate) {
      return null; // rate/channel change → ensureForTrack via a normal reload
    }
    next.format = { channels: info.channels, sampleRate: info.sampleRate };
    return next;
  }
}
