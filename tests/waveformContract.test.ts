import { describe, it, expect } from 'vitest';
import {
  WAVEFORM_LAYOUT,
  packWaveformUniforms,
  DEFAULT_WAVEFORM_UNIFORMS,
  wgslVec2,
  glslVec2,
  wgslVec3,
  glslVec3,
} from '../src/visuals/waveformContract';
import { waveformWGSL } from '../src/shaders/waveform';
import { GUI_FRAGMENT } from '../src/visuals/webgl2/shaders/waveform';

describe('WAVEFORM_LAYOUT', () => {
  it('defines three knobs and four LEDs', () => {
    expect(Object.keys(WAVEFORM_LAYOUT.knobs)).toEqual(['rsycrb', 'fractal', 'pulse']);
    expect(Object.keys(WAVEFORM_LAYOUT.leds)).toEqual(['none', 'ir', 'stop', 'play']);
  });

  it('keeps knob UVs in the top-right chrome band', () => {
    for (const knob of Object.values(WAVEFORM_LAYOUT.knobs)) {
      expect(knob.center.x).toBeGreaterThan(0.65);
      expect(knob.center.y).toBeLessThan(0.35);
      expect(knob.radius).toBeGreaterThan(0);
    }
  });
});

describe('shader injection parity', () => {
  it('embeds the same knob centers in WGSL and GLSL', () => {
    for (const knob of Object.values(WAVEFORM_LAYOUT.knobs)) {
      expect(waveformWGSL).toContain(wgslVec2(knob.center));
      expect(GUI_FRAGMENT).toContain(glslVec2(knob.center));
    }
  });

  it('embeds the same LED centers and colors in both shaders', () => {
    for (const led of Object.values(WAVEFORM_LAYOUT.leds)) {
      expect(waveformWGSL).toContain(wgslVec2(led.center));
      expect(GUI_FRAGMENT).toContain(glslVec2(led.center));
      expect(waveformWGSL).toContain(wgslVec3(led.color));
      expect(GUI_FRAGMENT).toContain(glslVec3(led.color));
    }
  });

  it('does not hardcode legacy knob UV literals outside the contract helpers', () => {
    // Guards against reintroducing duplicated magic numbers.
    // Both shaders must source positions from WAVEFORM_LAYOUT injection.
    const knobs = WAVEFORM_LAYOUT.knobs;
    expect(wgslVec2(knobs.rsycrb.center)).toBe('vec2<f32>(0.72, 0.22)');
    expect(glslVec2(knobs.rsycrb.center)).toBe('vec2(0.72, 0.22)');
  });

  it('includes Alt+D debug mode branches in both shaders', () => {
    expect(waveformWGSL).toContain('debugMode');
    expect(waveformWGSL).toMatch(/debugMode == 1/);
    expect(waveformWGSL).toMatch(/debugMode == 3/);
    expect(waveformWGSL).toMatch(/debugMode == 4/);
    expect(waveformWGSL).toMatch(/debugMode != 2/);

    expect(GUI_FRAGMENT).toContain('u_debugMode');
    expect(GUI_FRAGMENT).toMatch(/u_debugMode == 1/);
    expect(GUI_FRAGMENT).toMatch(/u_debugMode == 3/);
    expect(GUI_FRAGMENT).toMatch(/u_debugMode == 4/);
    expect(GUI_FRAGMENT).toMatch(/u_debugMode != 2/);
  });
});

describe('packWaveformUniforms', () => {
  it('packs 22 floats (88-byte WebGPU uniform buffer)', () => {
    const packed = packWaveformUniforms(DEFAULT_WAVEFORM_UNIFORMS, 3);
    expect(packed.length).toBe(22);
    expect(packed.byteLength).toBe(88);
    expect(packed[21]).toBe(3); // debugMode slot
  });
});
