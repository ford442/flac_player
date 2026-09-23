// ShaderGUI waveform — SOURCE OF TRUTH (loaded via `?raw` by src/shaders/waveform.ts).
//
// Double-brace placeholders are replaced once from src/visuals/waveformContract.ts
// (WAVEFORM_LAYOUT) — the same contract the WebGL2 GLSL uses. Do not hardcode
// knob/LED UVs or palette colors here; edit the contract.
//
// F16_ENABLE / GLOW_T: `enable f16;` + `f16` when the device has
// `shader-f16`, otherwise empty + `f32`. The glow math in sampleRealWaveform runs in
// glow_t; everything else stays f32.

{{F16_ENABLE}}
alias glow_t = {{GLOW_T}};

struct ShaderGUIUniforms {
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
  values: array<f32, {{audioBins}}>,
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

const AUDIO_BINS: i32 = {{audioBins}};

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

  // Draw mirrored waveform (top and bottom) in glow_t (f16 when available).
  let v = glow_t(value);
  let y = glow_t(uv.y);
  let waveY = glow_t(0.5) + v * glow_t(0.38);
  let dist = abs(y - waveY);
  let glow = glow_t(0.018) / (dist + glow_t(0.008));

  let waveY2 = glow_t(0.5) - v * glow_t(0.38);
  let dist2 = abs(y - waveY2);
  let glow2 = glow_t(0.018) / (dist2 + glow_t(0.008));

  return f32(max(glow, glow2));
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
  return {{knobGlow}} * glow;
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
    {{gradTop}},
    {{gradBottom}},
    uv.y
  );

  let aberration = uniforms.rsycrb * {{aberration}};

  let rVal = sampleWaveform(uv + vec2<f32>(-aberration, 0.0), audio);
  let gVal = sampleWaveform(uv, audio);
  let bVal = sampleWaveform(uv + vec2<f32>(aberration, 0.0), audio);

  let pulseBloom = 1.0 + uniforms.pulse * 2.0;
  var rWave = rVal * pulseBloom;
  var gWave = gVal * pulseBloom;
  var bWave = bVal * pulseBloom;

  let waveColor = mix(
    {{wavePrimary}},
    {{wavePulse}},
    uniforms.pulse
  );

  var finalColor = screenGrad + vec3<f32>(rWave, gWave, bWave) * waveColor;

  // debugMode 2 = waveform-only (skip scanlines, vignette, chrome glows)
  if (debugMode != 2) {
    let scanline = sin(uv.y * 200.0) * 0.04;
    finalColor = finalColor - scanline;

    let vignette = 1.0 - length((uv - 0.5) * 1.2);
    finalColor = finalColor * vignette;

    finalColor = finalColor + drawKnobGlow(uv, {{knobRsycrb}}, {{knobRadius}}, uniforms.rsycrb * {{knobScale}});
    finalColor = finalColor + drawKnobGlow(uv, {{knobFractal}}, {{knobRadius}}, uniforms.fractal * {{knobScale}});
    finalColor = finalColor + drawKnobGlow(uv, {{knobPulse}}, {{knobRadius}}, uniforms.pulse * {{knobScale}});

    finalColor = finalColor + drawLedGlow(uv, {{ledNone}}, {{ledNoneColor}}, uniforms.modeNone * {{ledNoneI}});
    finalColor = finalColor + drawLedGlow(uv, {{ledIR}}, {{ledIRColor}}, uniforms.modeIR * {{ledIRI}});
    finalColor = finalColor + drawLedGlow(uv, {{ledStop}}, {{ledStopColor}}, {{ledStopI}});
    finalColor = finalColor + drawLedGlow(uv, {{ledPlay}}, {{ledPlayColor}}, uniforms.isPlaying * {{ledPlayI}});

    finalColor = finalColor * (0.7 + uniforms.volume * 0.3);
  }

  return vec4<f32>(finalColor, 1.0);
}
