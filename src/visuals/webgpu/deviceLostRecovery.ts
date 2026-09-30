import {
  recordWebGPUFailure,
  type WebGPUProbeBreadcrumb,
  type WebGPUProbeResult,
  type WebGPUProbeSuccess,
} from '../webgpuProbe';

/** Re-probes allowed per canvas session after a non-'destroyed' device loss. */
export const MAX_DEVICE_LOST_RECOVERIES = 1;

/** The slice of WebGPUVisualizer the boot loop drives (mockable in unit tests). */
export interface RecoverableVisualizer {
  setOnDeviceLost(cb: (reason: string) => void): void;
  initialize(analyser: AnalyserNode, boot: WebGPUProbeSuccess): Promise<boolean>;
  getDevice(): GPUDevice | null;
  destroy(): void;
}

export interface WebGPUBootHooks<V extends RecoverableVisualizer> {
  probe: () => Promise<WebGPUProbeResult>;
  createVisualizer: () => V;
  analyser: AnalyserNode;
  cancelled: () => boolean;
  /** Visualizer configured on a fresh device (first boot or after recovery). */
  onReady: (visualizer: V, boot: WebGPUProbeSuccess) => void;
  /** Tear-down before a re-probe or fatal panel: drop refs, release the chores device. */
  onLost: (visualizer: V) => void;
  /** Fail-closed panel. Never auto-start WebGL2 from here. */
  onFatal: (breadcrumb: WebGPUProbeBreadcrumb) => void;
  maxRecoveries?: number;
}

/**
 * Probe → initialize the WebGPU visualizer, and on device loss (reason other than
 * 'destroyed', which the visualizer filters) re-run the probe on the same canvas
 * up to `maxRecoveries` times. A failed re-probe ends at `onFatal`, so the canvas
 * is never left frozen behind a `status: 'ready'` breadcrumb. Audio is untouched.
 */
export async function bootWebGPUWithRecovery<V extends RecoverableVisualizer>(
  hooks: WebGPUBootHooks<V>,
): Promise<void> {
  const maxRecoveries = hooks.maxRecoveries ?? MAX_DEVICE_LOST_RECOVERIES;

  const attempt = async (
    recoveries: number,
    lost: { breadcrumb: WebGPUProbeBreadcrumb; reason: string } | null,
  ): Promise<void> => {
    const boot = await hooks.probe();
    if (hooks.cancelled()) {
      if (boot.ok) boot.device.destroy();
      return;
    }
    if (!boot.ok) {
      console.warn('[ShaderGUI] WebGPU probe failed:', boot.breadcrumb.reason);
      hooks.onFatal(lost
        ? recordWebGPUFailure(
          boot.breadcrumb,
          'webgpu-device-lost',
          `${lost.reason}; re-probe failed: ${boot.breadcrumb.reason ?? 'unknown'}`,
        )
        : boot.breadcrumb);
      return;
    }
    if (recoveries > 0) boot.breadcrumb.deviceLostRecoveries = recoveries;

    const visualizer = hooks.createVisualizer();
    visualizer.setOnDeviceLost((reason) => {
      if (hooks.cancelled()) return;
      hooks.onLost(visualizer);
      visualizer.destroy();
      if (recoveries < maxRecoveries) {
        console.warn(`[ShaderGUI] WebGPU device lost (${reason}); re-probing once`);
        void attempt(recoveries + 1, { breadcrumb: boot.breadcrumb, reason });
        return;
      }
      hooks.onFatal(recordWebGPUFailure(boot.breadcrumb, 'webgpu-device-lost', reason));
    });

    try {
      await visualizer.initialize(hooks.analyser, boot);
    } catch (err: unknown) {
      visualizer.destroy();
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[ShaderGUI] WebGPU initialization failed:', msg);
      if (hooks.cancelled()) return;
      hooks.onFatal(recordWebGPUFailure(boot.breadcrumb, 'webgpu-visualizer-initialize-failed', msg));
      return;
    }
    if (hooks.cancelled()) {
      visualizer.destroy();
      return;
    }
    hooks.onReady(visualizer, boot);
  };

  await attempt(0, null);
}
