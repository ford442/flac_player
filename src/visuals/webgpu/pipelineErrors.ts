/**
 * Validation-checked WebGPU resource creation (#259 W4). A pipeline or bind-group
 * error used to surface only as an `uncapturederror` while the visualizer reported
 * `ready` over a black canvas; these helpers turn it into a rejected initialize().
 *
 * Each helper pushes and pops its error scope synchronously around the calls it
 * checks, so work on the same device from other tasks (gpu-chores) never lands in it.
 */

function messageOf(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/** Run `create` inside a validation scope that is popped even when it throws. */
function scoped<T>(device: GPUDevice, create: () => T): { value: T; scope: Promise<GPUError | null> } {
  device.pushErrorScope('validation');
  try {
    return { value: create(), scope: device.popErrorScope() };
  } catch (error) {
    void device.popErrorScope();
    throw error;
  }
}

/** Synchronous resource creation that throws if the validation scope recorded an error. */
export async function withValidationScope<T>(device: GPUDevice, label: string, create: () => T): Promise<T> {
  const { value, scope } = scoped(device, create);
  const error = await scope;
  if (error) throw new Error(`webgpu-validation-error: ${label}: ${error.message}`);
  return value;
}

/**
 * `createRenderPipelineAsync` (no first-frame compile hitch) that rejects with a
 * labelled error on a GPUPipelineError or a validation error in the descriptor.
 */
export async function createRenderPipelineChecked(
  device: GPUDevice,
  descriptor: GPURenderPipelineDescriptor,
  label: string,
): Promise<GPURenderPipeline> {
  const { value: pending, scope } = scoped(device, () => device.createRenderPipelineAsync({ label, ...descriptor }));
  const [pipeline, scopeError] = await Promise.allSettled([pending, scope]);
  if (pipeline.status === 'rejected') {
    throw new Error(`webgpu-pipeline-error: ${label}: ${messageOf(pipeline.reason)}`);
  }
  if (scopeError.status === 'fulfilled' && scopeError.value) {
    throw new Error(`webgpu-validation-error: ${label}: ${scopeError.value.message}`);
  }
  return pipeline.value;
}
