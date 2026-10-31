import { describe, it, expect } from 'vitest';
import { WebGL2Visualizer } from '../src/visuals/webgl2/WebGL2Visualizer';
import { GUI_FRAGMENT, FLAT_FRAGMENT } from '../src/visuals/webgl2/shaders/waveform';
import { DEFAULT_WAVEFORM_UNIFORMS } from '../src/visuals/waveformContract';

const GL_TYPES: Record<string, number> = {
  float: 0x1406, vec2: 0x8b50, vec3: 0x8b51, vec4: 0x8b52, int: 0x1404, bool: 0x8b56,
};

interface Decl { name: string; glslType: string; size: number }
interface FakeProgram { id: number; decls: Decl[]; deleted: boolean; fragmentSrc: string }
interface FakeLocation { program: FakeProgram; decl: Decl }

/**
 * Minimal WebGL2 stand-in that enforces the validation Chrome applies to uniform calls:
 * a program must be current, the location must belong to it, and the uniform method must
 * match the type the GLSL declares. Declarations are parsed from the real shader sources.
 */
class StrictGL {
  FLOAT = GL_TYPES.float; FLOAT_VEC2 = GL_TYPES.vec2; FLOAT_VEC3 = GL_TYPES.vec3;
  FLOAT_VEC4 = GL_TYPES.vec4; INT = GL_TYPES.int; BOOL = GL_TYPES.bool;
  ACTIVE_UNIFORMS = 0x8b86; VERTEX_SHADER = 0x8b31; FRAGMENT_SHADER = 0x8b30;
  COMPILE_STATUS = 0x8b81; LINK_STATUS = 0x8b82; DEPTH_TEST = 0x0b71; BLEND = 0x0be2; TRIANGLES = 4;

  errors: string[] = [];
  calls: Array<{ method: string; name: string }> = [];
  programs: FakeProgram[] = [];
  draws = 0;
  current: FakeProgram | null = null;

  createShader(type: number) { return { type, src: '' }; }
  shaderSource(shader: { src: string }, src: string) { shader.src = src; }
  compileShader() {}
  getShaderParameter() { return true; }
  getShaderInfoLog() { return ''; }
  deleteShader() {}
  createProgram(): FakeProgram {
    const program = { id: this.programs.length + 1, decls: [], deleted: false, fragmentSrc: '' };
    this.programs.push(program);
    return program;
  }
  attachShader(program: FakeProgram, shader: { type: number; src: string }) {
    if (shader.type === this.FRAGMENT_SHADER) program.fragmentSrc = shader.src;
  }
  linkProgram(program: FakeProgram) {
    for (const m of program.fragmentSrc.matchAll(/^\s*uniform\s+(\w+)\s+(\w+)(?:\[(\d+)\])?\s*;/gm)) {
      program.decls.push({ glslType: m[1]!, name: m[2]!, size: m[3] ? Number(m[3]) : 1 });
    }
  }
  getProgramParameter(program: FakeProgram, pname: number) {
    return pname === this.ACTIVE_UNIFORMS ? program.decls.length : true;
  }
  getProgramInfoLog() { return ''; }
  getActiveUniform(program: FakeProgram, index: number) {
    const d = program.decls[index]!;
    return { name: d.size > 1 ? `${d.name}[0]` : d.name, type: GL_TYPES[d.glslType]!, size: d.size };
  }
  getUniformLocation(program: FakeProgram, name: string): FakeLocation | null {
    const decl = program.decls.find((d) => d.name === name.replace(/\[0\]$/, ''));
    return decl ? { program, decl } : null;
  }
  deleteProgram(program: FakeProgram) { program.deleted = true; }
  useProgram(program: FakeProgram) { this.current = program; }
  getContextAttributes() { return {}; }
  isContextLost() { return false; }
  getExtension() { return null; }
  disable() {}
  viewport() {}
  readPixels() {}
  drawArrays() {
    if (!this.current) this.errors.push('drawArrays: no program in use');
    this.draws++;
  }

  private check(method: string, loc: FakeLocation | null, accepts: string[], arrayOnly = false) {
    if (!loc) return; // null location is a silent no-op in GL
    this.calls.push({ method, name: loc.decl.name });
    if (!this.current) {
      this.errors.push(`${method}: no program in use`);
    } else if (loc.program !== this.current) {
      this.errors.push(`${method}: location is not from the associated program`);
    } else if (!accepts.includes(loc.decl.glslType) || (arrayOnly !== loc.decl.size > 1)) {
      this.errors.push(`${method}: Uniform size does not match uniform method (${loc.decl.name} is ${loc.decl.glslType})`);
    }
  }
  uniform1f(loc: FakeLocation | null) { this.check('uniform1f', loc, ['float']); }
  uniform1fv(loc: FakeLocation | null) { this.check('uniform1fv', loc, ['float'], true); }
  uniform2fv(loc: FakeLocation | null) { this.check('uniform2fv', loc, ['vec2']); }
  uniform3fv(loc: FakeLocation | null) { this.check('uniform3fv', loc, ['vec3']); }
  uniform4fv(loc: FakeLocation | null) { this.check('uniform4fv', loc, ['vec4']); }
  uniform1i(loc: FakeLocation | null) { this.check('uniform1i', loc, ['int', 'bool']); }
}

function setup() {
  const gl = new StrictGL();
  const canvas = {
    width: 640,
    height: 160,
    getContext: (type: string) => (type === 'webgl2' ? gl : null),
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;
  const analyser = {
    frequencyBinCount: 8,
    getByteFrequencyData: (a: Uint8Array) => a.fill(32),
  } as unknown as AnalyserNode;
  const make = () => {
    const vis = new WebGL2Visualizer(canvas);
    expect(vis.initialize(analyser)).toBe(true);
    vis.setUniforms({ ...DEFAULT_WAVEFORM_UNIFORMS, resolution: [640, 160] });
    vis.setAudioData(new Uint8Array(1024).fill(128));
    return vis;
  };
  return { gl, make };
}

describe('StrictGL fake (guards the test itself)', () => {
  it('parses the real shader declarations, including the int uniform', () => {
    const { gl, make } = setup();
    make();
    const gui = gl.programs.find((p) => p.fragmentSrc === GUI_FRAGMENT)!;
    const flat = gl.programs.find((p) => p.fragmentSrc === FLAT_FRAGMENT)!;
    expect(gui.decls.find((d) => d.name === 'u_debugMode')?.glslType).toBe('int');
    expect(gui.decls.find((d) => d.name === 'u_audioData')?.size).toBeGreaterThan(1);
    expect(flat.decls.map((d) => d.name)).toEqual(['u_resolution', 'u_time', 'u_audioLevel']);
  });

  it('rejects the two original mistakes: float setter on an int, and a location from another program', () => {
    const { gl, make } = setup();
    make();
    const gui = gl.programs.find((p) => p.fragmentSrc === GUI_FRAGMENT)!;
    const flat = gl.programs.find((p) => p.fragmentSrc === FLAT_FRAGMENT)!;

    gl.useProgram(gui);
    gl.uniform1f(gl.getUniformLocation(gui, 'u_debugMode'));
    expect(gl.errors.at(-1)).toContain('Uniform size does not match uniform method');

    gl.useProgram(flat);
    gl.uniform1f(gl.getUniformLocation(gui, 'u_time'));
    expect(gl.errors.at(-1)).toContain('location is not from the associated program');
  });
});

describe('WebGL2Visualizer uniform binding', () => {
  it('issues no invalid uniform calls rendering the GUI pass', () => {
    const { gl, make } = setup();
    const vis = make();
    for (let i = 0; i < 3; i++) vis.renderGUI();
    expect(gl.errors).toEqual([]);
    expect(gl.draws).toBe(3);
  });

  it('picks the setter that matches each declared type', () => {
    const { gl, make } = setup();
    make().renderGUI();
    const method = (name: string) => gl.calls.find((c) => c.name === name)?.method;
    expect(method('u_debugMode')).toBe('uniform1i'); // `uniform int`
    expect(method('u_resolution')).toBe('uniform2fv'); // vec2
    expect(method('u_time')).toBe('uniform1f');
    expect(method('u_audioData')).toBe('uniform1fv'); // float[]
  });

  it('never uses a stale program when flat and GUI passes alternate', () => {
    const { gl, make } = setup();
    const vis = make();
    for (let i = 0; i < 2; i++) {
      vis.renderFlat();
      vis.renderGUI();
    }
    expect(gl.errors).toEqual([]);
  });

  it('is clean when a new visualizer binds while the previous (deleted) program is still current', () => {
    const { gl, make } = setup();
    const first = make();
    first.renderGUI();
    first.destroy(); // old program stays current in GL until another is bound
    expect(gl.current?.deleted).toBe(true);

    const second = make();
    second.renderGUI(); // first frame after re-init
    expect(gl.errors).toEqual([]);
  });
});
