/**
 * Single source of truth for ShaderGUI waveform layout + uniform contracts.
 *
 * Knob/LED UV coordinates must stay aligned with ShaderGUI.css
 * (`.shader-gui-layout`, `.shader-gui-top-right`, knobs, buttons).
 * Change positions here once — both WGSL and GLSL shaders inject these values.
 */

/** Shared per-frame GUI shader parameters (WebGPU + WebGL2). */
export interface WaveformUniforms {
  resolution: [number, number];
  time: number;
  beatPhase: number;
  rsycrb: number;
  fractal: number;
  pulse: number;
  audioLevel: number;
  audioLevelL: number;
  audioLevelR: number;
  spectrum0: number;
  spectrum1: number;
  spectrum2: number;
  spectrum3: number;
  spectrum4: number;
  modeNone: number;
  modeIR: number;
  isPlaying: number;
  playbackProgress: number;
  volume: number;
  colorShift: number;
}

export interface WaveformVec2 {
  x: number;
  y: number;
}

export interface WaveformVec3 {
  r: number;
  g: number;
  b: number;
}

export interface WaveformKnobLayout {
  /** UV center in canvas space (0–1). */
  center: WaveformVec2;
  radius: number;
}

export interface WaveformLedLayout {
  center: WaveformVec2;
  color: WaveformVec3;
}

/**
 * CSS ↔ shader alignment map for ShaderGUI chrome overlays.
 *
 * Top-right knob row: ~72%, 82%, 92% across width, ~22% from top.
 * Button/LED row: ~68–92% across, ~42% from top.
 */
export const WAVEFORM_LAYOUT = {
  knobs: {
    rsycrb: { center: { x: 0.72, y: 0.22 }, radius: 0.06 },
    fractal: { center: { x: 0.82, y: 0.22 }, radius: 0.06 },
    pulse: { center: { x: 0.92, y: 0.22 }, radius: 0.06 },
  },
  leds: {
    none: { center: { x: 0.68, y: 0.42 }, color: { r: 0.3, g: 0.33, b: 0.39 } },
    ir: { center: { x: 0.76, y: 0.42 }, color: { r: 0.96, g: 0.45, b: 0.71 } },
    stop: { center: { x: 0.84, y: 0.42 }, color: { r: 0.97, g: 0.44, b: 0.44 } },
    play: { center: { x: 0.92, y: 0.42 }, color: { r: 0.29, g: 0.87, b: 0.5 } },
  },
  colors: {
    knobGlow: { r: 0.75, g: 0.52, b: 0.99 },
    wavePrimary: { r: 0.75, g: 0.52, b: 0.99 },
    wavePulse: { r: 0.96, g: 0.45, b: 0.71 },
    screenGradTop: { r: 0.102, g: 0.039, b: 0.18 },
    screenGradBottom: { r: 0.176, g: 0.106, b: 0.306 },
  },
  /** Intensity multipliers applied to LED glow draws. */
  ledIntensity: {
    none: 0.3,
    ir: 0.6,
    stop: 0.0,
    play: 0.6,
  },
  /** Knob glow intensity scale (multiplied by knob uniform). */
  knobIntensityScale: 0.5,
  audioBins: 64,
  aberrationScale: 0.015,
} as const satisfies {
  knobs: Record<string, WaveformKnobLayout>;
  leds: Record<string, WaveformLedLayout>;
  colors: Record<string, WaveformVec3>;
  ledIntensity: Record<string, number>;
  knobIntensityScale: number;
  audioBins: number;
  aberrationScale: number;
};

export type WaveformLayout = typeof WAVEFORM_LAYOUT;

/** Default uniform values shared by both GPU backends. */
export const DEFAULT_WAVEFORM_UNIFORMS: WaveformUniforms = {
  resolution: [1, 1],
  time: 0,
  beatPhase: 0,
  rsycrb: 0,
  fractal: 0,
  pulse: 0,
  audioLevel: 0,
  audioLevelL: 0,
  audioLevelR: 0,
  spectrum0: 0,
  spectrum1: 0,
  spectrum2: 0,
  spectrum3: 0,
  spectrum4: 0,
  modeNone: 0,
  modeIR: 0,
  isPlaying: 0,
  playbackProgress: 0,
  volume: 1,
  colorShift: 0,
};

function fmt(n: number): string {
  // Keep a decimal so GLSL/WGSL treat the literal as float.
  if (Number.isInteger(n)) return `${n}.0`;
  return String(n);
}

export function wgslVec2(v: WaveformVec2): string {
  return `vec2<f32>(${fmt(v.x)}, ${fmt(v.y)})`;
}

export function wgslVec3(v: WaveformVec3): string {
  return `vec3<f32>(${fmt(v.r)}, ${fmt(v.g)}, ${fmt(v.b)})`;
}

export function glslVec2(v: WaveformVec2): string {
  return `vec2(${fmt(v.x)}, ${fmt(v.y)})`;
}

export function glslVec3(v: WaveformVec3): string {
  return `vec3(${fmt(v.r)}, ${fmt(v.g)}, ${fmt(v.b)})`;
}

export type WaveformShaderLanguage = 'wgsl' | 'glsl';

/**
 * The ONE layout inject: WAVEFORM_LAYOUT → shader literals, keyed by the
 * placeholder names used in src/shaders/waveform.wgsl and the GLSL port.
 */
export function waveformLayoutTokens(lang: WaveformShaderLanguage): Record<string, string> {
  const L = WAVEFORM_LAYOUT;
  const v2 = lang === 'wgsl' ? wgslVec2 : glslVec2;
  const v3 = lang === 'wgsl' ? wgslVec3 : glslVec3;
  return {
    knobRsycrb: v2(L.knobs.rsycrb.center),
    knobFractal: v2(L.knobs.fractal.center),
    knobPulse: v2(L.knobs.pulse.center),
    knobRadius: fmt(L.knobs.rsycrb.radius),
    knobScale: fmt(L.knobIntensityScale),
    ledNone: v2(L.leds.none.center),
    ledIR: v2(L.leds.ir.center),
    ledStop: v2(L.leds.stop.center),
    ledPlay: v2(L.leds.play.center),
    ledNoneColor: v3(L.leds.none.color),
    ledIRColor: v3(L.leds.ir.color),
    ledStopColor: v3(L.leds.stop.color),
    ledPlayColor: v3(L.leds.play.color),
    ledNoneI: fmt(L.ledIntensity.none),
    ledIRI: fmt(L.ledIntensity.ir),
    ledStopI: fmt(L.ledIntensity.stop),
    ledPlayI: fmt(L.ledIntensity.play),
    knobGlow: v3(L.colors.knobGlow),
    wavePrimary: v3(L.colors.wavePrimary),
    wavePulse: v3(L.colors.wavePulse),
    gradTop: v3(L.colors.screenGradTop),
    gradBottom: v3(L.colors.screenGradBottom),
    audioBins: String(L.audioBins),
    aberration: fmt(L.aberrationScale),
  };
}

/** Replace every double-brace token; throws on unknown or leftover placeholders. */
export function injectShaderTokens(source: string, tokens: Record<string, string>): string {
  const out = source.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const value = tokens[name];
    if (value === undefined) throw new Error(`waveform shader: unknown placeholder {{${name}}}`);
    return value;
  });
  return out;
}

/** Float32 payload for the WebGPU ShaderGUI uniform buffer (22 floats / 88 bytes). */
export const WAVEFORM_UNIFORM_FLOATS = 22;

/** Pack into `out` (length ≥ WAVEFORM_UNIFORM_FLOATS) to avoid a per-frame allocation. */
export function packWaveformUniforms(
  u: WaveformUniforms,
  debugMode = 0,
  out: Float32Array = new Float32Array(WAVEFORM_UNIFORM_FLOATS),
): Float32Array {
  out[0] = u.resolution[0]; out[1] = u.resolution[1]; out[2] = u.time; out[3] = u.beatPhase;
  out[4] = u.rsycrb; out[5] = u.fractal; out[6] = u.pulse;
  out[7] = u.audioLevel; out[8] = u.audioLevelL; out[9] = u.audioLevelR;
  out[10] = u.spectrum0; out[11] = u.spectrum1; out[12] = u.spectrum2; out[13] = u.spectrum3; out[14] = u.spectrum4;
  out[15] = u.modeNone; out[16] = u.modeIR; out[17] = u.isPlaying; out[18] = u.playbackProgress;
  out[19] = u.volume; out[20] = u.colorShift;
  out[21] = debugMode;
  return out;
}
