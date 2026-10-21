import { describe, expect, it } from 'vitest';
import { GpuDeviceService } from '../../src/visuals/webgpu/deviceService';
import { probeWebGPU, type WebGPUProbeSuccess } from '../../src/visuals/webgpuProbe';
import { WebGPUVisualizer } from '../../src/visuals/webgpuVisualizer';
import { runWebGpuFft } from '../../src/gpu-chores/webgpuFft';

/**
 * Real-device boot of the ShaderGUI pipelines (#259 W1/W4/W5): createRenderPipelineAsync
 * inside validation scopes, the uniform audio-bar layout, the P3 output conversion and
 * the lazy cube. SwiftShader is a fallback adapter, so the service opts in explicitly.
 *
 * Headless SwiftShader loses the device when a canvas swapchain texture is drawn, so
 * the visualizer renders into an offscreen texture of the canvas format instead; the
 * canvas itself is still probed and configured. Skips when there is no adapter.
 */
function analyserAt(sampleRate: number): AnalyserNode {
  return { context: { sampleRate } } as unknown as AnalyserNode;
}

describe('WebGPUVisualizer on a real device', async () => {
  const service = new GpuDeviceService({ lendToChores: false, allowFallbackAdapter: () => true });
  const available = (await service.acquire()).ok;

  async function boot(colorSpace: PredefinedColorSpace): Promise<{ canvas: HTMLCanvasElement; boot: WebGPUProbeSuccess }> {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 80;
    const result = await probeWebGPU(canvas, {
      deviceService: service,
      publish: false,
      display: { colorSpace, formatOverride: null },
    });
    if (!result.ok) throw new Error(`probe failed: ${result.breadcrumb.reason}`);
    const target = result.device.createTexture({
      size: [canvas.width, canvas.height],
      format: result.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const offscreen = { getCurrentTexture: () => target } as unknown as GPUCanvasContext;
    return { canvas, boot: { ...result, context: offscreen } };
  }

  it.skipIf(!available).each(['srgb', 'display-p3'] as const)('renders GUI and 3D for a %s canvas without GPU errors', async (colorSpace) => {
    const { canvas, boot: result } = await boot(colorSpace);
    const errors: string[] = [];
    const onError = (e: Event) => errors.push((e as GPUUncapturedErrorEvent).error.message);
    result.device.addEventListener('uncapturederror', onError);

    const visualizer = new WebGPUVisualizer(canvas);
    await expect(visualizer.initialize(analyserAt(44_100), result)).resolves.toBe(true);
    visualizer.setAnalyser(analyserAt(96_000));
    visualizer.setAudioData(new Uint8Array(2048).fill(200));
    visualizer.renderGUI();

    visualizer.setMode('3D');
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 25));
      visualizer.render();
    }
    await result.device.queue.onSubmittedWorkDone();
    result.device.removeEventListener('uncapturederror', onError);

    expect(errors).toEqual([]);
    expect(visualizer.getDevice()).toBe(service.device);
    visualizer.destroy();
    expect(service.device).toBe(result.device);
    expect(service.stats.deviceRequests).toBe(1);
  });

  it.skipIf(!available)('reuses fft buffers across runs on the shared device', async () => {
    const device = service.device!;
    const pcm = new Float32Array(4096).map((_, i) => Math.sin(i / 7));
    const a = await runWebGpuFft(device, pcm, 64, 1, 2048);
    const b = await runWebGpuFft(device, pcm, 64, 1, 2048);
    expect(Array.from(b.spectrum)).toEqual(Array.from(a.spectrum));
  });
});
