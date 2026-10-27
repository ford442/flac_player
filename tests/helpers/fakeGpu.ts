import { vi } from 'vitest';

/**
 * Minimal GPUDevice / GPU fakes for jsdom unit tests (no WebGPU there). Records
 * buffer creation and error-scope balance; pipelines resolve unless told to fail.
 */

/** Spec bit values for the GPU* enums jsdom does not define. */
export function installGpuEnums(): () => void {
  const enums: Record<string, Record<string, number>> = {
    GPUBufferUsage: {
      MAP_READ: 0x1, MAP_WRITE: 0x2, COPY_SRC: 0x4, COPY_DST: 0x8, INDEX: 0x10,
      VERTEX: 0x20, UNIFORM: 0x40, STORAGE: 0x80, INDIRECT: 0x100, QUERY_RESOLVE: 0x200,
    },
    GPUShaderStage: { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 },
    GPUTextureUsage: {
      COPY_SRC: 0x1, COPY_DST: 0x2, TEXTURE_BINDING: 0x4, STORAGE_BINDING: 0x8, RENDER_ATTACHMENT: 0x10,
    },
    GPUMapMode: { READ: 0x1, WRITE: 0x2 },
  };
  for (const [name, value] of Object.entries(enums)) vi.stubGlobal(name, value);
  return () => vi.unstubAllGlobals();
}

export interface FakeBuffer {
  size: number;
  label?: string;
  destroyed: boolean;
  destroy: () => void;
  mapAsync: () => Promise<void>;
  getMappedRange: () => ArrayBuffer;
  unmap: () => void;
}

export interface FakeDeviceOptions {
  features?: string[];
  /** Reject createRenderPipelineAsync for pipelines whose label matches. */
  failPipeline?: RegExp;
  /** Report a validation error from the next popErrorScope. */
  scopeError?: string;
}

export interface FakeDevice {
  device: GPUDevice;
  buffers: FakeBuffer[];
  /** Resolves `device.lost` with the given reason. */
  lose: (reason?: GPUDeviceLostReason) => void;
  destroy: ReturnType<typeof vi.fn>;
  scopeDepth: () => number;
}

export function fakeDevice(options: FakeDeviceOptions = {}): FakeDevice {
  const buffers: FakeBuffer[] = [];
  let depth = 0;
  let pendingScopeError = options.scopeError ?? null;
  let resolveLost: (info: GPUDeviceLostInfo) => void = () => {};
  const lost = new Promise<GPUDeviceLostInfo>((resolve) => { resolveLost = resolve; });
  const destroy = vi.fn(() => resolveLost({ reason: 'destroyed', message: 'destroyed' } as GPUDeviceLostInfo));
  const pass = {
    setPipeline: vi.fn(), setBindGroup: vi.fn(), draw: vi.fn(), drawIndexed: vi.fn(),
    setVertexBuffer: vi.fn(), setIndexBuffer: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn(),
  };
  const device = {
    label: 'fake',
    features: new Set(options.features ?? []),
    limits: {},
    lost,
    destroy,
    queue: { writeBuffer: vi.fn(), submit: vi.fn() },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    pushErrorScope: vi.fn(() => { depth += 1; }),
    popErrorScope: vi.fn(async () => {
      depth -= 1;
      const message = pendingScopeError;
      pendingScopeError = null;
      return message ? ({ message } as GPUError) : null;
    }),
    createBuffer: vi.fn((desc: GPUBufferDescriptor) => {
      const buffer: FakeBuffer = {
        size: desc.size,
        label: desc.label,
        destroyed: false,
        destroy() { this.destroyed = true; },
        mapAsync: async () => {},
        getMappedRange: () => new ArrayBuffer(desc.size),
        unmap: () => {},
      };
      buffers.push(buffer);
      return buffer;
    }),
    createTexture: vi.fn(() => ({ createView: vi.fn(() => ({})), destroy: vi.fn(), width: 1, height: 1 })),
    createSampler: vi.fn(() => ({})),
    createShaderModule: vi.fn(() => ({ getCompilationInfo: async () => ({ messages: [] }) })),
    createBindGroupLayout: vi.fn(() => ({})),
    createBindGroup: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    createComputePipeline: vi.fn(() => ({})),
    createRenderPipelineAsync: vi.fn(async (desc: GPURenderPipelineDescriptor) => {
      if (options.failPipeline && options.failPipeline.test(desc.label ?? '')) {
        throw Object.assign(new Error(`bad pipeline ${desc.label}`), { name: 'GPUPipelineError' });
      }
      return { label: desc.label };
    }),
    createQuerySet: vi.fn(() => ({ destroy: vi.fn() })),
    createCommandEncoder: vi.fn(() => ({
      beginRenderPass: vi.fn(() => pass),
      beginComputePass: vi.fn(() => pass),
      copyBufferToBuffer: vi.fn(),
      resolveQuerySet: vi.fn(),
      finish: vi.fn(() => ({})),
    })),
  };
  return {
    device: device as unknown as GPUDevice,
    buffers,
    lose: (reason = 'unknown') => resolveLost({ reason, message: 'lost' } as GPUDeviceLostInfo),
    destroy,
    scopeDepth: () => depth,
  };
}

export function fakeAdapter(
  device: () => GPUDevice,
  info: Partial<GPUAdapterInfo> = {},
): GPUAdapter & { requestDevice: ReturnType<typeof vi.fn> } {
  return {
    info: { vendor: 'v', architecture: 'a', device: 'd', description: 'Test GPU', isFallbackAdapter: false, ...info },
    features: new Set<string>(),
    limits: {},
    requestDevice: vi.fn(async () => device()),
  } as unknown as GPUAdapter & { requestDevice: ReturnType<typeof vi.fn> };
}

export function fakeGpu(
  adapters: { core: GPUAdapter | null; compatibility?: GPUAdapter | null },
): GPU & { requestAdapter: ReturnType<typeof vi.fn> } {
  return {
    requestAdapter: vi.fn(async (opts?: { featureLevel?: string }) =>
      (opts?.featureLevel === 'compatibility' ? adapters.compatibility ?? null : adapters.core)),
    getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm'),
  } as unknown as GPU & { requestAdapter: ReturnType<typeof vi.fn> };
}
