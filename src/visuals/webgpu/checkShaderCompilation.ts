export async function checkShaderCompilation(module: GPUShaderModule, label: string): Promise<void> {
  const info = await module.getCompilationInfo();
  for (const msg of info.messages) {
    const log = msg.type === 'error' ? console.error : console.warn;
    log(`[WebGPU Shader ${label}] ${msg.type}: ${msg.message} (line ${msg.lineNum}, col ${msg.linePos})`);
  }
  if (info.messages.some((m) => m.type === 'error')) {
    throw new Error(`webgpu-shader-compile-error: ${label}`);
  }
}
