/**
 * Output context contract — the one place audio / GPU / GL contexts are opened.
 *
 * AudioContext
 *   - One shared context per session, opened only by `openAudioContext` (called by
 *     AudioContextManager). Rate/latency decisions live in sampleRatePolicy.ts.
 *   - Never construct a context to test a rate: `AudioContext.isSampleRateSupported`
 *     where it exists, otherwise ask the real constructor and let
 *     `relaxContextOptions` back off (numeric latency → sinkId → renderSizeHint →
 *     sampleRate). The caller remembers each relaxation for the page lifetime.
 *   - A replaced context is closed (awaited) before the rebuild resolves.
 *
 * WebGPU (GpuDeviceService is the only requestDevice caller)
 *   - Adapter: powerPreference from `readGpuPowerPreference` (`?gpu=low`).
 *   - Device: optional features and REQUIRED_DEVICE_LIMITS, each intersected with
 *     the adapter — an unmet one is dropped, never fatal.
 *   - Canvas: `probeWebGPU` configures once; sRGB/SDR by default, display-p3 behind
 *     `?p3=1` on a P3 display, extended HDR behind `?hdr=1` only. No Settings control.
 *   - Loss: reason 'destroyed' is ours and a no-op; any other reason re-probes once
 *     (`bootWebGPUWithRecovery`); a second loss shows the fatal panel.
 *
 * WebGL2 (opt-in compat renderer)
 *   - Same powerPreference as WebGPU, `desynchronized` (retried without), no MSAA,
 *     no depth/stencil, no preserved buffer, no performance-caveat refusal unless
 *     `?gl=strict`.
 *
 * SDL: no device of its own — the SDL backend renders into the shared AudioContext.
 */
import { relaxContextOptions, type AudioContextOptionsWithSink } from './sampleRatePolicy';

export {
  buildDeviceDescriptor,
  buildCanvasConfiguration,
  buildWebGL2ContextAttributes,
  getWebGL2Context,
  readGpuPowerPreference,
} from '../visuals/webgpu/canvasConfig';

export interface AudioContextRequest {
  latencyHint: AudioContextLatencyCategory | number;
  sampleRate?: number;
  sinkId?: AudioContextOptionsWithSink['sinkId'];
  renderSizeHint?: AudioContextOptionsWithSink['renderSizeHint'];
}

/** Constructor options with undefined fields omitted (an explicit `undefined` still reaches some engines). */
export function buildAudioContextOptions(request: AudioContextRequest): AudioContextOptionsWithSink {
  const options: AudioContextOptionsWithSink = { latencyHint: request.latencyHint };
  if (request.sampleRate !== undefined) options.sampleRate = request.sampleRate;
  if (request.sinkId !== undefined) options.sinkId = request.sinkId;
  if (request.renderSizeHint !== undefined) options.renderSizeHint = request.renderSizeHint;
  return options;
}

/**
 * `new AudioContext(options)`, relaxing on each throw. `onRelaxed` sees every
 * rejected → retry pair so the caller can remember it. Rethrows when nothing is left.
 */
export function openAudioContext(
  options: AudioContextOptionsWithSink,
  onRelaxed?: (rejected: AudioContextOptionsWithSink, retry: AudioContextOptionsWithSink, err: unknown) => void,
): { context: AudioContext; options: AudioContextOptionsWithSink } {
  let attempt = options;
  for (;;) {
    try {
      return { context: new AudioContext(attempt), options: attempt };
    } catch (err) {
      const next = relaxContextOptions(attempt);
      if (!next) throw err;
      onRelaxed?.(attempt, next, err);
      attempt = next;
    }
  }
}
