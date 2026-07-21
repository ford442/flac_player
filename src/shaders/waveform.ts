import {
  WAVEFORM_LAYOUT,
  wgslVec2,
  wgslVec3,
} from '../visuals/waveformContract';

const L = WAVEFORM_LAYOUT;

function f(n: number): string {
  if (Number.isInteger(n)) return `${n}.0`;
  return String(n);
}

/** WGSL literals injected from WAVEFORM_LAYOUT (single source of truth). */
const W = {
  knobRsycrb: wgslVec2(L.knobs.rsycrb.center),
  knobFractal: wgslVec2(L.knobs.fractal.center),
  knobPulse: wgslVec2(L.knobs.pulse.center),
  knobRadius: f(L.knobs.rsycrb.radius),
  knobScale: f(L.knobIntensityScale),
  ledNone: wgslVec2(L.leds.none.center),
  ledIR: wgslVec2(L.leds.ir.center),
  ledStop: wgslVec2(L.leds.stop.center),
  ledPlay: wgslVec2(L.leds.play.center),
  ledNoneColor: wgslVec3(L.leds.none.color),
  ledIRColor: wgslVec3(L.leds.ir.color),
  ledStopColor: wgslVec3(L.leds.stop.color),
  ledPlayColor: wgslVec3(L.leds.play.color),
  ledNoneI: f(L.ledIntensity.none),
  ledIRI: f(L.ledIntensity.ir),
  ledStopI: f(L.ledIntensity.stop),
  ledPlayI: f(L.ledIntensity.play),
  knobGlow: wgslVec3(L.colors.knobGlow),
  wavePrimary: wgslVec3(L.colors.wavePrimary),
  wavePulse: wgslVec3(L.colors.wavePulse),
  gradTop: wgslVec3(L.colors.screenGradTop),
  gradBottom: wgslVec3(L.colors.screenGradBottom),
  audioBins: L.audioBins,
  aberration: f(L.aberrationScale),
};

/**
 * ShaderGUI waveform WGSL.
 * Knob/LED UVs and palette colors come from `src/visuals/waveformContract.ts`.
 * If CSS layout changes, update WAVEFORM_LAYOUT only — do not hardcode UVs here.
 */
export const waveformWGSL = `struct ShaderGUIUniforms {
  resolution: vec2<f32>,
  time: f32,
  beatPhase: f32,

  rsycrb: f32,
  fractal: f32,
  pulse: f32,

  audioLevel: f32,
  audioLevelL: f32,
  audioLevelR: f32,
  spectrum0: f32,
  spectrum1: f32,
  spectrum2: f32,
  spectrum3: f32,
  spectrum4: f32,

  modeNone: f32,
  modeIR: f32,
  isPlaying: f32,
  playbackProgress: f32,

  volume: f32,
  colorShift: f32,
  debugMode: f32,
};

struct AudioData {
  values: array<f32, ${W.audioBins}>,
};

@group(0) @binding(0) var<uniform> uniforms: ShaderGUIUniforms;
@group(0) @binding(1) var<storage, read> audioData: AudioData;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vertex_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var output: VertexOutput;
  var pos = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
    vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0)
  );
  output.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
  output.uv = pos[vertexIndex] * 0.5 + 0.5;
  return output;
}

const AUDIO_BINS: i32 = ${W.audioBins};

fn fractalWave(x: f32, depth: f32, audio: f32) -> f32 {
  var y = 0.0;
  var amp = 1.0;
  var freq = 1.0;
  let levels = i32(depth * 6.0) + 1;

  for (var i = 0; i < levels; i = i + 1) {
    y = y + amp * sin(x * freq * 3.14159 + uniforms.time * 0.5);
    amp = amp * 0.5;
    freq = freq * 2.0 + audio * 0.5;
  }
  return y;
}

fn sampleRealWaveform(uv: vec2<f32>) -> f32 {
  let x = uv.x;
  let binCount = f32(AUDIO_BINS);
  let idx = x * binCount;
  let i0 = clamp(i32(idx), 0, AUDIO_BINS - 1);
  let i1 = clamp(i0 + 1, 0, AUDIO_BINS - 1);
  let frac = idx - f32(i0);

  let v0 = audioData.values[i0];
  let v1 = audioData.values[i1];
  let value = mix(v0, v1, frac);

  // Draw mirrored waveform (top and bottom)
  let waveY = 0.5 + value * 0.38;
  let dist = abs(uv.y - waveY);
  let glow = 0.018 / (dist + 0.008);

  let waveY2 = 0.5 - value * 0.38;
  let dist2 = abs(uv.y - waveY2);
  let glow2 = 0.018 / (dist2 + 0.008);

  return max(glow, glow2);
}

fn sampleSyntheticWaveform(uv: vec2<f32>, audio: f32) -> f32 {
  let waveX = uv.x * 2.0 - 1.0;
  let audioMod = audio * 0.3;
  let waveY = sin(waveX * 10.0 + uniforms.time * 2.0) * audioMod;
  let waveY2 = cos(waveX * 7.0 - uniforms.time * 1.5) * audioMod * 0.5;
  let fractalDetail = fractalWave(waveX, uniforms.fractal, audio);
  let combinedWave = waveY + waveY2 + fractalDetail * 0.1;
  let dist = abs(uv.y - 0.5 - combinedWave * 0.3);
  let glow = 0.02 / (dist + 0.008);
  return glow;
}

fn sampleWaveform(uv: vec2<f32>, audio: f32) -> f32 {
  // If audio is very low (SDL dummy analyser), use synthetic fallback
  // that still animates so the screen doesn't flatline
  if (audio < 0.005) {
    let fallback = sampleSyntheticWaveform(uv, 0.15 + sin(uniforms.time * 0.8) * 0.08);
    return fallback * 0.6;
  }
  return sampleRealWaveform(uv);
}

fn drawKnobGlow(uv: vec2<f32>, center: vec2<f32>, radius: f32, intensity: f32) -> vec3<f32> {
  let glowRadius = radius + 0.04;
  let glowDist = abs(distance(uv, center) - glowRadius);
  let glow = 0.5 / (glowDist + 1.0) * intensity;
  return ${W.knobGlow} * glow;
}

fn drawLedGlow(uv: vec2<f32>, center: vec2<f32>, color: vec3<f32>, intensity: f32) -> vec3<f32> {
  let ledDist = distance(uv, center);
  let ledGlow = 0.01 / (ledDist + 0.001) * intensity;
  return color * ledGlow;
}

// Layout constants injected from src/visuals/waveformContract.ts (WAVEFORM_LAYOUT).

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let uv = input.uv;
  let debugMode = i32(uniforms.debugMode);

  // Alt+D debug modes (parity with WebGL2 GLSL path)
  if (debugMode == 1) {
    return vec4<f32>(uv, 0.5, 1.0);
  }

  if (debugMode == 3) {
    let bin = clamp(i32(uv.x * f32(AUDIO_BINS)), 0, AUDIO_BINS - 1);
    let h = audioData.values[bin];
    let bar = step(uv.y, h) * step(0.02, uv.y);
    return vec4<f32>(vec3<f32>(0.2, 0.6, 1.0) * bar + vec3<f32>(0.05, 0.05, 0.1), 1.0);
  }

  if (debugMode == 4) {
    let s = uniforms.spectrum0 + uniforms.spectrum1 + uniforms.spectrum2 + uniforms.spectrum3 + uniforms.spectrum4;
    return vec4<f32>(vec3<f32>(s, uniforms.audioLevelL, uniforms.audioLevelR) * 2.0, 1.0);
  }

  let audio = uniforms.audioLevel;

  let screenGrad = mix(
    ${W.gradTop},
    ${W.gradBottom},
    uv.y
  );

  let aberration = uniforms.rsycrb * ${W.aberration};

  let rVal = sampleWaveform(uv + vec2<f32>(-aberration, 0.0), audio);
  let gVal = sampleWaveform(uv, audio);
  let bVal = sampleWaveform(uv + vec2<f32>(aberration, 0.0), audio);

  let pulseBloom = 1.0 + uniforms.pulse * 2.0;
  var rWave = rVal * pulseBloom;
  var gWave = gVal * pulseBloom;
  var bWave = bVal * pulseBloom;

  let waveColor = mix(
    ${W.wavePrimary},
    ${W.wavePulse},
    uniforms.pulse
  );

  var finalColor = screenGrad + vec3<f32>(rWave, gWave, bWave) * waveColor;

  // debugMode 2 = waveform-only (skip scanlines, vignette, chrome glows)
  if (debugMode != 2) {
    let scanline = sin(uv.y * 200.0) * 0.04;
    finalColor = finalColor - scanline;

    let vignette = 1.0 - length((uv - 0.5) * 1.2);
    finalColor = finalColor * vignette;

    finalColor = finalColor + drawKnobGlow(uv, ${W.knobRsycrb}, ${W.knobRadius}, uniforms.rsycrb * ${W.knobScale});
    finalColor = finalColor + drawKnobGlow(uv, ${W.knobFractal}, ${W.knobRadius}, uniforms.fractal * ${W.knobScale});
    finalColor = finalColor + drawKnobGlow(uv, ${W.knobPulse}, ${W.knobRadius}, uniforms.pulse * ${W.knobScale});

    finalColor = finalColor + drawLedGlow(uv, ${W.ledNone}, ${W.ledNoneColor}, uniforms.modeNone * ${W.ledNoneI});
    finalColor = finalColor + drawLedGlow(uv, ${W.ledIR}, ${W.ledIRColor}, uniforms.modeIR * ${W.ledIRI});
    finalColor = finalColor + drawLedGlow(uv, ${W.ledStop}, ${W.ledStopColor}, ${W.ledStopI});
    finalColor = finalColor + drawLedGlow(uv, ${W.ledPlay}, ${W.ledPlayColor}, uniforms.isPlaying * ${W.ledPlayI});

    finalColor = finalColor * (0.7 + uniforms.volume * 0.3);
  }

  return vec4<f32>(finalColor, 1.0);
}
`;
