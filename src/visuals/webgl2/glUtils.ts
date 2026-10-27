export function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  src: string,
  label: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error(`${label}: createShader failed`);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? 'unknown';
    gl.deleteShader(shader);
    throw new Error(`${label} shader error: ${log}`);
  }
  return shader;
}

export function linkProgram(
  gl: WebGL2RenderingContext,
  vs: WebGLShader,
  fs: WebGLShader,
  label: string,
): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error(`${label}: createProgram failed`);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? 'unknown';
    gl.deleteProgram(program);
    throw new Error(`${label} link error: ${log}`);
  }
  return program;
}

/** An active uniform of one linked program, with the type the GLSL declares. */
export interface UniformInfo {
  location: WebGLUniformLocation;
  /** GL type enum from getActiveUniform (gl.FLOAT, gl.FLOAT_VEC2, gl.INT, ...). */
  type: number;
  /** Array length (1 for non-arrays). */
  size: number;
}

/**
 * Active uniforms of `program`, keyed by name without the `[0]` array suffix.
 * Locations are only valid on the program they came from, so keep one table per pass.
 * Uniforms the GLSL compiler optimized out are absent (setUniform skips them).
 */
export function collectUniforms(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  label: string,
): Record<string, UniformInfo> {
  const out: Record<string, UniformInfo> = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < count; i++) {
    const active = gl.getActiveUniform(program, i);
    if (!active) continue;
    const location = gl.getUniformLocation(program, active.name);
    if (!location) continue;
    const name = active.name.replace(/\[0\]$/, '');
    if (!isSupportedUniformType(gl, active.type)) {
      console.warn(`[WebGL2] ${label}: uniform ${name} has unsupported type 0x${active.type.toString(16)}`);
      continue;
    }
    out[name] = { location, type: active.type, size: active.size };
  }
  return out;
}

function isSupportedUniformType(gl: WebGL2RenderingContext, type: number): boolean {
  return type === gl.FLOAT || type === gl.FLOAT_VEC2 || type === gl.FLOAT_VEC3
    || type === gl.FLOAT_VEC4 || type === gl.INT || type === gl.BOOL;
}

/**
 * Upload `value` with the uniform method that matches the declared GLSL type
 * (`uniform int` needs uniform1i, not uniform1f). The program that owns `info`
 * must already be current (gl.useProgram).
 */
export function setUniform(
  gl: WebGL2RenderingContext,
  info: UniformInfo | undefined,
  value: number | number[] | Float32Array,
): void {
  if (!info) return;
  const { location, type, size } = info;
  const scalar = typeof value === 'number' ? value : value[0] ?? 0;
  switch (type) {
    case gl.FLOAT:
      if (size > 1 && typeof value !== 'number') gl.uniform1fv(location, value);
      else gl.uniform1f(location, scalar);
      break;
    case gl.FLOAT_VEC2:
      if (typeof value !== 'number') gl.uniform2fv(location, value);
      break;
    case gl.FLOAT_VEC3:
      if (typeof value !== 'number') gl.uniform3fv(location, value);
      break;
    case gl.FLOAT_VEC4:
      if (typeof value !== 'number') gl.uniform4fv(location, value);
      break;
    case gl.INT:
    case gl.BOOL:
      gl.uniform1i(location, scalar);
      break;
    default:
      break;
  }
}
