import {
  WAVEFORM_LAYOUT,
  glslVec2,
  glslVec3,
} from '../../waveformContract';

const L = WAVEFORM_LAYOUT;

function f(n: number): string {
  if (Number.isInteger(n)) return `${n}.0`;
  return String(n);
}

/** GLSL literals injected from WAVEFORM_LAYOUT (single source of truth). */
const G = {
  knobRsycrb: glslVec2(L.knobs.rsycrb.center),
  knobFractal: glslVec2(L.knobs.fractal.center),
  knobPulse: glslVec2(L.knobs.pulse.center),
  knobRadius: f(L.knobs.rsycrb.radius),
  knobScale: f(L.knobIntensityScale),
  ledNone: glslVec2(L.leds.none.center),
  ledIR: glslVec2(L.leds.ir.center),
  ledStop: glslVec2(L.leds.stop.center),
  ledPlay: glslVec2(L.leds.play.center),
  ledNoneColor: glslVec3(L.leds.none.color),
  ledIRColor: glslVec3(L.leds.ir.color),
  ledStopColor: glslVec3(L.leds.stop.color),
  ledPlayColor: glslVec3(L.leds.play.color),
  ledNoneI: f(L.ledIntensity.none),
  ledIRI: f(L.ledIntensity.ir),
  ledStopI: f(L.ledIntensity.stop),
  ledPlayI: f(L.ledIntensity.play),
  knobGlow: glslVec3(L.colors.knobGlow),
  wavePrimary: glslVec3(L.colors.wavePrimary),
  wavePulse: glslVec3(L.colors.wavePulse),
  gradTop: glslVec3(L.colors.screenGradTop),
  gradBottom: glslVec3(L.colors.screenGradBottom),
  audioBins: L.audioBins,
  aberration: f(L.aberrationScale),
};

/** Full-screen triangle vertex shader (shared by GUI + flat passes). */
export const FULLSCREEN_VERTEX = `#version 300 es
precision highp float;
out vec2 v_uv;
void main() {
  vec2 pos[3] = vec2[3](
    vec2(-1.0, -1.0),
    vec2( 3.0, -1.0),
    vec2(-1.0,  3.0)
  );
  v_uv = pos[gl_VertexID] * 0.5 + 0.5;
  gl_Position = vec4(pos[gl_VertexID], 0.0, 1.0);
}
`;

/**
 * GLSL port of src/shaders/waveform.ts (ShaderGUI WGSL).
 * Knob/LED UVs and palette colors come from WAVEFORM_LAYOUT — edit that file only.
 */
export const GUI_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;

uniform vec2 u_resolution;
uniform float u_time;
uniform float u_beatPhase;
uniform float u_rsycrb;
uniform float u_fractal;
uniform float u_pulse;
uniform float u_audioLevel;
uniform float u_audioLevelL;
uniform float u_audioLevelR;
uniform float u_spectrum0;
uniform float u_spectrum1;
uniform float u_spectrum2;
uniform float u_spectrum3;
uniform float u_spectrum4;
uniform float u_modeNone;
uniform float u_modeIR;
uniform float u_isPlaying;
uniform float u_playbackProgress;
uniform float u_volume;
uniform float u_colorShift;
uniform float u_audioData[${G.audioBins}];
uniform int u_debugMode;

const int AUDIO_BINS = ${G.audioBins};

float fractalWave(float x, float depth, float audio) {
  float y = 0.0;
  float amp = 1.0;
  float freq = 1.0;
  int levels = int(depth * 6.0) + 1;
  for (int i = 0; i < 7; i++) {
    if (i >= levels) break;
    y += amp * sin(x * freq * 3.14159 + u_time * 0.5);
    amp *= 0.5;
    freq = freq * 2.0 + audio * 0.5;
  }
  return y;
}

float sampleRealWaveform(vec2 uv) {
  float x = uv.x;
  float binCount = float(AUDIO_BINS);
  float idx = x * binCount;
  int i0 = clamp(int(idx), 0, AUDIO_BINS - 1);
  int i1 = clamp(i0 + 1, 0, AUDIO_BINS - 1);
  float frac = idx - float(i0);
  float v0 = u_audioData[i0];
  float v1 = u_audioData[i1];
  float value = mix(v0, v1, frac);
  float waveY = 0.5 + value * 0.38;
  float dist = abs(uv.y - waveY);
  float glow = 0.018 / (dist + 0.008);
  float waveY2 = 0.5 - value * 0.38;
  float dist2 = abs(uv.y - waveY2);
  float glow2 = 0.018 / (dist2 + 0.008);
  return max(glow, glow2);
}

float sampleSyntheticWaveform(vec2 uv, float audio) {
  float waveX = uv.x * 2.0 - 1.0;
  float audioMod = audio * 0.3;
  float waveY = sin(waveX * 10.0 + u_time * 2.0) * audioMod;
  float waveY2 = cos(waveX * 7.0 - u_time * 1.5) * audioMod * 0.5;
  float fractalDetail = fractalWave(waveX, u_fractal, audio);
  float combinedWave = waveY + waveY2 + fractalDetail * 0.1;
  float dist = abs(uv.y - 0.5 - combinedWave * 0.3);
  return 0.02 / (dist + 0.008);
}

float sampleWaveform(vec2 uv, float audio) {
  if (audio < 0.005) {
    float fallback = sampleSyntheticWaveform(uv, 0.15 + sin(u_time * 0.8) * 0.08);
    return fallback * 0.6;
  }
  return sampleRealWaveform(uv);
}

vec3 drawKnobGlow(vec2 uv, vec2 center, float radius, float intensity) {
  float glowRadius = radius + 0.04;
  float glowDist = abs(distance(uv, center) - glowRadius);
  float glow = 0.5 / (glowDist + 1.0) * intensity;
  return ${G.knobGlow} * glow;
}

vec3 drawLedGlow(vec2 uv, vec2 center, vec3 color, float intensity) {
  float ledDist = distance(uv, center);
  float ledGlow = 0.01 / (ledDist + 0.001) * intensity;
  return color * ledGlow;
}

void main() {
  vec2 uv = v_uv;

  if (u_debugMode == 1) {
    fragColor = vec4(uv, 0.5, 1.0);
    return;
  }

  if (u_debugMode == 3) {
    int bin = clamp(int(uv.x * float(AUDIO_BINS)), 0, AUDIO_BINS - 1);
    float h = u_audioData[bin];
    float bar = step(uv.y, h) * step(0.02, uv.y);
    fragColor = vec4(vec3(0.2, 0.6, 1.0) * bar + vec3(0.05, 0.05, 0.1), 1.0);
    return;
  }

  if (u_debugMode == 4) {
    float s = u_spectrum0 + u_spectrum1 + u_spectrum2 + u_spectrum3 + u_spectrum4;
    fragColor = vec4(vec3(s, u_audioLevelL, u_audioLevelR) * 2.0, 1.0);
    return;
  }

  float audio = u_audioLevel;
  vec3 screenGrad = mix(
    ${G.gradTop},
    ${G.gradBottom},
    uv.y
  );

  float aberration = u_rsycrb * ${G.aberration};
  float rVal = sampleWaveform(uv + vec2(-aberration, 0.0), audio);
  float gVal = sampleWaveform(uv, audio);
  float bVal = sampleWaveform(uv + vec2(aberration, 0.0), audio);

  float pulseBloom = 1.0 + u_pulse * 2.0;
  float rWave = rVal * pulseBloom;
  float gWave = gVal * pulseBloom;
  float bWave = bVal * pulseBloom;

  vec3 waveColor = mix(
    ${G.wavePrimary},
    ${G.wavePulse},
    u_pulse
  );

  vec3 finalColor = screenGrad + vec3(rWave, gWave, bWave) * waveColor;

  if (u_debugMode != 2) {
    float scanline = sin(uv.y * 200.0) * 0.04;
    finalColor -= scanline;
    float vignette = 1.0 - length((uv - 0.5) * 1.2);
    finalColor *= vignette;
    finalColor += drawKnobGlow(uv, ${G.knobRsycrb}, ${G.knobRadius}, u_rsycrb * ${G.knobScale});
    finalColor += drawKnobGlow(uv, ${G.knobFractal}, ${G.knobRadius}, u_fractal * ${G.knobScale});
    finalColor += drawKnobGlow(uv, ${G.knobPulse}, ${G.knobRadius}, u_pulse * ${G.knobScale});
    finalColor += drawLedGlow(uv, ${G.ledNone}, ${G.ledNoneColor}, u_modeNone * ${G.ledNoneI});
    finalColor += drawLedGlow(uv, ${G.ledIR}, ${G.ledIRColor}, u_modeIR * ${G.ledIRI});
    finalColor += drawLedGlow(uv, ${G.ledStop}, ${G.ledStopColor}, ${G.ledStopI});
    finalColor += drawLedGlow(uv, ${G.ledPlay}, ${G.ledPlayColor}, u_isPlaying * ${G.ledPlayI});
    finalColor *= (0.7 + u_volume * 0.3);
  }

  fragColor = vec4(finalColor, 1.0);
}
`;

/** GLSL port of the inline flat waveform shader in webgpuVisualizer.ts. */
export const FLAT_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;

uniform vec2 u_resolution;
uniform float u_time;
uniform float u_audioLevel;

void main() {
  vec2 uv = v_uv;
  vec2 p = (uv - 0.5) * 2.0;
  float wave = sin(p.x * 3.0 + u_time + u_audioLevel * 3.0) * 0.5 * u_audioLevel;
  float dist = abs(p.y - wave);
  float glow = 0.05 / (dist + 0.01);
  vec3 color = vec3(0.2, 0.5, 1.0) * glow;
  float grid = step(0.95, fract(uv.x * 20.0)) + step(0.95, fract(uv.y * 20.0));
  vec3 screenColor = mix(color, vec3(0.0, 0.2, 0.4), grid * 0.1);
  fragColor = vec4(screenColor, 1.0);
}
`;
