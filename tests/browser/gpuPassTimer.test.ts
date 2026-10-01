import { describe, expect, it } from 'vitest';
import { buildDeviceDescriptor } from '../../src/visuals/webgpu/canvasConfig';
import { createGuiResources } from '../../src/visuals/webgpu/guiResources';
import { GpuPassTimer } from '../../src/visuals/webgpu/gpuPassTimer';

/**
 * Real-device check: ShaderGUI WGSL compiles (Tint) and timestamp-query yields a
 * non-zero pass time after a few frames. Skips without a WebGPU adapter / feature.
 */
async function getDevice(): Promise<GPUDevice | null> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) return null;
  const adapter = await gpu.requestAdapter().catch(() => null);
  return adapter ? adapter.requestDevice(buildDeviceDescriptor(adapter)) : null;
}

describe('ShaderGUI pass timing', async () => {
  const device = await getDevice();

  it.skipIf(!device)('compiles the waveform module on a real adapter', async () => {
    const gui = await createGuiResources(device!, 'rgba8unorm');
    expect(gui.f16).toBe(device!.features.has('shader-f16'));
  });

  it.skipIf(!device || !device.features.has('timestamp-query'))(
    'reports a non-zero gpuTimeMs after a few frames',
    async () => {
      const gui = await createGuiResources(device!, 'rgba8unorm');
      const target = device!.createTexture({
        size: [512, 256],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      const timer = new GpuPassTimer(device!);
      expect(timer.supported).toBe(true);

      for (let frame = 0; frame < 30 && timer.gpuTimeMs === null; frame++) {
        const encoder = device!.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store' }],
          timestampWrites: timer.passTimestampWrites(),
        });
        pass.setPipeline(gui.pipeline);
        pass.setBindGroup(0, gui.bindGroup);
        pass.draw(6);
        pass.end();
        timer.resolve(encoder);
        device!.queue.submit([encoder.finish()]);
        timer.afterSubmit();
        await device!.queue.onSubmittedWorkDone();
        await new Promise((r) => setTimeout(r, 10));
      }

      expect(timer.gpuTimeMs).not.toBeNull();
      expect(timer.gpuTimeMs!).toBeGreaterThan(0);
      timer.destroy();
    },
  );
});
