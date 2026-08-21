/**
 * Local gpu-chores constants (stub of a future shared package).
 *
 * Break-even (auto skips WebGPU below this):
 *   GPU_BREAK_EVEN_SAMPLES = 1_048_576  (~12 s mono / ~6 s stereo @ 44.1 kHz)
 *
 * Rationale, measured on the CPU golden (`reduceMinMax`):
 *   - 1,048,576 samples → typically 2–8 ms for min/max in JS
 *   - WebGPU writeBuffer of ~4 MiB + compute + mapAsync of a 8–32 KiB
 *     overview is often *slower* than that CPU pass once queue overhead
 *     is included. Auto therefore stays on Worker/CPU for short clips.
 *
 * VRAM cap (auto skips WebGPU above this):
 *   GPU_MAX_UPLOAD_SAMPLES = 4_194_304  (~16 MiB of f32)
 *   Avoids a second large PCM heap next to the visualizer working set.
 *   Longer files stay on the Worker TS reduce (small overview readback).
 */

/** @workgroup_size used by the 1D reduce compute shader. */
export const GPU_CHORES_WORKGROUP_SIZE = 64;

/** Default scrubber resolution (min/max pairs). In the 1–4k range. */
export const DEFAULT_SCRUBBER_BINS = 2048;

/** Hard clamp for overview bins. */
export const MIN_SCRUBBER_BINS = 1;
export const MAX_SCRUBBER_BINS = 4096;

/** Default HUD spectrum bin count (optional chore). */
export const DEFAULT_SPECTRUM_BINS = 64;

/**
 * Skip WebGPU below this many PCM samples (prefer Worker/CPU).
 * Documented break-even for `prefer: 'auto'`.
 */
export const GPU_BREAK_EVEN_SAMPLES = 1_048_576;

/** Do not upload more than this many f32 samples to the visualizer device. */
export const GPU_MAX_UPLOAD_SAMPLES = 4_194_304;

/**
 * Worker overhead is not worth it for tiny clips; main-thread CPU is <2 ms.
 * ~6 s mono / ~3 s stereo @ 44.1 kHz.
 */
export const WORKER_MIN_SAMPLES = 262_144;

/** Samples per Worker postMessage chunk (4 MiB of f32). */
export const WORKER_CHUNK_SAMPLES = 1_048_576;

/** Live meters: never faster than this (UI/overview rate, not audio callback). */
export const METER_HZ = 30;
