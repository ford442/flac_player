import { adoptVisualizerDevice, releaseVisualizerDevice } from '../gpu-chores/device';
import type { VisualizerBackend } from './types';
import {
  probeWebGPU,
  recordWebGPUFailure,
  type WebGPUProbeBreadcrumb,
  type WebGPUProbeSuccess,
} from './webgpuProbe';

/** Recoveries allowed inside the window before a flapping GPU stays on the fatal panel. */
export const MAX_DEVICE_RECOVERIES = 3;
export const DEVICE_RECOVERY_WINDOW_MS = 60_000;

/** The slice of WebGPUVisualizer a session drives. */
export interface SessionVisualizer {
  initialize(analyser: AnalyserNode, boot: WebGPUProbeSuccess): Promise<boolean>;
  getDevice(): GPUDevice | null;
  setOnDeviceLost(cb: (reason: string) => void): void;
  destroy(): void;
}

export interface WebGPUSessionDeps {
  probe: typeof probeWebGPU;
  adoptDevice: (device: GPUDevice | null) => void;
  releaseDevice: (device?: GPUDevice | null) => void;
  now: () => number;
}

export interface WebGPUSessionOptions<V extends SessionVisualizer> {
  canvas: HTMLCanvasElement;
  analyser: AnalyserNode;
  requestedVisualizer: VisualizerBackend | null;
  isCancelled: () => boolean;
  createVisualizer: (canvas: HTMLCanvasElement) => V;
  /** Visualizer initialised and its device adopted by gpu-chores: first boot and every recovery. */
  onReady: (visualizer: V, boot: WebGPUProbeSuccess) => void;
  /** The device was lost and a recovery is under way: stop rendering with `visualizer`. */
  onLost?: (visualizer: V) => void;
  /** Fail closed (fatal panel). Audio is untouched. */
  onFatal: (breadcrumb: WebGPUProbeBreadcrumb) => void;
  deps?: Partial<WebGPUSessionDeps>;
}

/**
 * Boot the WebGPU visualizer through `probeWebGPU` (the only requestDevice() caller) and keep it
 * alive across device loss: a lost device is re-requested through the same probe on the same
 * canvas, the new visualizer is handed to `onReady` and its device re-adopted by gpu-chores.
 * A 'destroyed' loss we did not cause, or too many losses in a short window, fails closed.
 * Resolves after the first boot; later recoveries run from the device's `lost` promise.
 */
export async function startWebGPUSession<V extends SessionVisualizer>(
  options: WebGPUSessionOptions<V>,
): Promise<void> {
  const { canvas, analyser, requestedVisualizer, isCancelled, createVisualizer, onReady, onLost, onFatal } = options;
  const deps: WebGPUSessionDeps = {
    probe: options.deps?.probe ?? probeWebGPU,
    adoptDevice: options.deps?.adoptDevice ?? adoptVisualizerDevice,
    releaseDevice: options.deps?.releaseDevice ?? releaseVisualizerDevice,
    now: options.deps?.now ?? Date.now,
  };
  const recoveries: number[] = [];

  interface Loss {
    reason: string;
    breadcrumb: WebGPUProbeBreadcrumb;
  }

  const lostFatal = (loss: Loss, detail: string): void => {
    onFatal(recordWebGPUFailure(loss.breadcrumb, 'webgpu-device-lost', detail));
  };

  const boot = async (loss: Loss | null): Promise<void> => {
    const result = await deps.probe(canvas, { requestedVisualizer });
    if (isCancelled()) {
      if (result.ok) result.device.destroy();
      return;
    }
    if (!result.ok) {
      console.warn('[ShaderGUI] WebGPU boot probe failed:', result.breadcrumb.reason);
      if (loss) {
        lostFatal(loss, `${loss.reason}; re-request failed: ${result.breadcrumb.reason}`);
      } else {
        onFatal(result.breadcrumb);
      }
      return;
    }

    const visualizer = createVisualizer(canvas);
    // A loss before initialize() finishes is replayed once the visualizer is live.
    const state = { live: false, earlyLoss: null as string | null };
    visualizer.setOnDeviceLost((reason) => {
      if (isCancelled()) return;
      if (!state.live) {
        state.earlyLoss = reason;
        return;
      }
      recover(visualizer, result, reason).catch((err: unknown) => {
        console.error('[ShaderGUI] WebGPU device recovery failed:', err);
        if (!isCancelled()) lostFatal({ reason, breadcrumb: result.breadcrumb }, err instanceof Error ? err.message : String(err));
      });
    });

    try {
      await visualizer.initialize(analyser, result);
    } catch (err: unknown) {
      visualizer.destroy();
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[ShaderGUI] WebGPU initialization failed:', msg);
      if (isCancelled()) return;
      onFatal(recordWebGPUFailure(result.breadcrumb, 'webgpu-visualizer-initialize-failed', msg));
      return;
    }
    if (isCancelled()) {
      visualizer.destroy();
      return;
    }
    state.live = true;
    if (state.earlyLoss !== null) {
      await recover(visualizer, result, state.earlyLoss);
      return;
    }
    deps.adoptDevice(visualizer.getDevice());
    onReady(visualizer, result);
  };

  const recover = async (visualizer: V, result: WebGPUProbeSuccess, reason: string): Promise<void> => {
    const loss: Loss = { reason, breadcrumb: result.breadcrumb };
    deps.releaseDevice(result.device);
    visualizer.destroy();
    onLost?.(visualizer);

    if (reason === 'destroyed') {
      lostFatal(loss, reason);
      return;
    }
    const now = deps.now();
    while (recoveries.length > 0) {
      const oldest = recoveries[0];
      if (oldest === undefined || now - oldest <= DEVICE_RECOVERY_WINDOW_MS) break;
      recoveries.shift();
    }
    if (recoveries.length >= MAX_DEVICE_RECOVERIES) {
      lostFatal(loss, `${reason}; gave up after ${MAX_DEVICE_RECOVERIES} recoveries in ${DEVICE_RECOVERY_WINDOW_MS / 1000}s`);
      return;
    }
    recoveries.push(now);
    console.warn('[ShaderGUI] WebGPU device lost, re-requesting through the probe:', reason);
    await boot(loss);
  };

  await boot(null);
}
