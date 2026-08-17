/**
 * Lazy-loaded ffmpeg.wasm converter for local MP3 ↔ FLAC.
 *
 * The UMD glue + classic worker are served from /ffmpeg/ (same origin) so webpack
 * does not rewrite Worker construction. The large ffmpeg-core.wasm is fetched once
 * from CDN into a blob URL (COEP-safe).
 */

import {
  buildFfmpegArgs,
  memfsInputName,
  memfsOutputName,
  mimeForDirection,
  outputFileName,
  type ConvertDirection,
  type Mp3Bitrate,
} from '../../utils/convertFileNames';

export type { ConvertDirection, Mp3Bitrate };

export interface ConvertOptions {
  direction: ConvertDirection;
  mp3Bitrate?: Mp3Bitrate;
  flacCompressionLevel?: number;
  onProgress?: (ratio: number) => void;
}

export interface ConvertResult {
  data: Uint8Array;
  outputName: string;
  mimeType: string;
}

const CORE_VERSION = '0.12.6';
const CORE_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/umd`;
/** Same-origin UMD build (copied to public/ffmpeg/). */
const FFMPEG_UMD = '/ffmpeg/ffmpeg.js';

/** Minimal surface we use from @ffmpeg/ffmpeg. */
interface FFmpegInstance {
  loaded: boolean;
  on(event: 'progress', cb: (e: { progress: number }) => void): void;
  on(event: 'log', cb: (e: { message: string }) => void): void;
  load(config: {
    coreURL?: string;
    wasmURL?: string;
    classWorkerURL?: string;
  }): Promise<boolean>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array | string>;
  deleteFile(path: string): Promise<void>;
  exec(args: string[]): Promise<number>;
}

interface FFmpegNamespace {
  FFmpeg: new () => FFmpegInstance;
}

declare global {
  interface Window {
    FFmpegWASM?: FFmpegNamespace;
  }
}

let ffmpegInstance: FFmpegInstance | null = null;
let loadPromise: Promise<void> | null = null;
let convertChain: Promise<unknown> = Promise.resolve();
let progressCb: ((ratio: number) => void) | null = null;

async function toBlobURL(url: string, mimeType: string): Promise<string> {
  const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!res.ok) {
    throw new Error(`Failed to download ${url} (${res.status})`);
  }
  const buf = await res.arrayBuffer();
  return URL.createObjectURL(new Blob([buf], { type: mimeType }));
}

function loadScript(src: string): Promise<void> {
  const existing = document.querySelector<HTMLScriptElement>(`script[data-ffmpeg-src="${src}"]`);
  if (existing) {
    return existing.dataset.loaded === '1'
      ? Promise.resolve()
      : new Promise((resolve, reject) => {
          existing.addEventListener('load', () => resolve(), { once: true });
          existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), {
            once: true,
          });
        });
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.ffmpegSrc = src;
    script.onload = () => {
      script.dataset.loaded = '1';
      resolve();
    };
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

async function createFfmpeg(onStatus?: (msg: string) => void): Promise<FFmpegInstance> {
  onStatus?.('Loading converter library…');
  await loadScript(FFMPEG_UMD);

  const ns = window.FFmpegWASM;
  if (!ns?.FFmpeg) {
    throw new Error('FFmpegWASM global not available after script load');
  }

  const ffmpeg = new ns.FFmpeg();
  ffmpeg.on('progress', (event) => {
    const ratio = typeof event.progress === 'number' ? event.progress : 0;
    progressCb?.(Math.max(0, Math.min(1, ratio)));
  });

  onStatus?.('Downloading converter core (~25MB, first time)…');
  // UMD core works with the classic worker (importScripts); ESM core needs module worker.
  const [coreURL, wasmURL] = await Promise.all([
    toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
    toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
  ]);

  onStatus?.('Initializing converter…');
  // Omit classWorkerURL so the UMD package uses its bundled classic worker at /ffmpeg/814.ffmpeg.js
  await ffmpeg.load({ coreURL, wasmURL });
  return ffmpeg;
}

/**
 * Ensure the ffmpeg.wasm core is loaded. Safe to call multiple times.
 */
export async function ensureFfmpegLoaded(onStatus?: (msg: string) => void): Promise<void> {
  if (ffmpegInstance?.loaded) return;
  if (!loadPromise) {
    loadPromise = (async () => {
      ffmpegInstance = await createFfmpeg(onStatus);
      onStatus?.('Converter ready');
    })().catch((err) => {
      loadPromise = null;
      ffmpegInstance = null;
      throw err;
    });
  }
  await loadPromise;
}

export function isFfmpegLoaded(): boolean {
  return Boolean(ffmpegInstance?.loaded);
}

async function runConvert(
  inputBytes: Uint8Array,
  inputName: string,
  options: ConvertOptions
): Promise<ConvertResult> {
  await ensureFfmpegLoaded();
  const ffmpeg = ffmpegInstance;
  if (!ffmpeg) {
    throw new Error('FFmpeg failed to initialize');
  }

  const { direction } = options;
  const inPath = memfsInputName(direction);
  const outPath = memfsOutputName(direction);
  const args = buildFfmpegArgs(direction, {
    mp3Bitrate: options.mp3Bitrate,
    flacCompressionLevel: options.flacCompressionLevel,
  });

  progressCb = (ratio) => options.onProgress?.(ratio);

  try {
    try {
      await ffmpeg.deleteFile(inPath);
    } catch {
      /* ignore */
    }
    try {
      await ffmpeg.deleteFile(outPath);
    } catch {
      /* ignore */
    }

    await ffmpeg.writeFile(inPath, inputBytes);
    options.onProgress?.(0);

    const code = await ffmpeg.exec(args);
    if (code !== 0) {
      throw new Error(`Conversion failed (ffmpeg exit code ${code})`);
    }

    const raw = await ffmpeg.readFile(outPath);
    if (typeof raw === 'string') {
      throw new Error('Unexpected text output from converter');
    }

    const data = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
    options.onProgress?.(1);

    return {
      data: new Uint8Array(data),
      outputName: outputFileName(inputName, direction),
      mimeType: mimeForDirection(direction),
    };
  } finally {
    progressCb = null;
    try {
      await ffmpeg.deleteFile(inPath);
    } catch {
      /* ignore */
    }
    try {
      await ffmpeg.deleteFile(outPath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Convert a single audio file. Concurrent calls are serialized (shared MEMFS).
 */
export async function convertAudioFile(
  input: File | Uint8Array,
  inputName: string,
  options: ConvertOptions
): Promise<ConvertResult> {
  const bytes =
    input instanceof Uint8Array
      ? input
      : new Uint8Array(await input.arrayBuffer());

  const job = convertChain.then(() => runConvert(bytes, inputName, options));
  convertChain = job.then(
    () => undefined,
    () => undefined
  );
  return job;
}
