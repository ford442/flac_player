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
};

struct AudioData {
  values: array<f32, 64>,
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

const AUDIO_BINS: i32 = 64;

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
  return vec3<f32>(0.75, 0.52, 0.99) * glow;
}

fn drawLedGlow(uv: vec2<f32>, center: vec2<f32>, color: vec3<f32>, intensity: f32) -> vec3<f32> {
  let ledDist = distance(uv, center);
  let ledGlow = 0.01 / (ledDist + 0.001) * intensity;
  return color * ledGlow;
}

// Shader-to-CSS alignment map:
// These UV coordinates correspond to the DOM positions in ShaderGUI.css
// Top-right knob row in CSS: .shader-gui-top-right at grid-column:2, grid-row:1
// Knobs are positioned at roughly 72%, 82%, 92% across the width
// and 22% from the top of the canvas (above the button row at ~42%).
// If .shader-gui-layout or .shader-gui-top-right changes, these must be recalibrated.

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let uv = input.uv;
  let time = uniforms.time;
  let audio = uniforms.audioLevel;

  let screenGrad = mix(
    vec3<f32>(0.102, 0.039, 0.180),
    vec3<f32>(0.176, 0.106, 0.306),
    uv.y
  );

  let aberration = uniforms.rsycrb * 0.015;

  let rVal = sampleWaveform(uv + vec2<f32>(-aberration, 0.0), audio);
  let gVal = sampleWaveform(uv, audio);
  let bVal = sampleWaveform(uv + vec2<f32>(aberration, 0.0), audio);

  let pulseBloom = 1.0 + uniforms.pulse * 2.0;
  var rWave = rVal * pulseBloom;
  var gWave = gVal * pulseBloom;
  var bWave = bVal * pulseBloom;

  let waveColor = mix(
    vec3<f32>(0.75, 0.52, 0.99),
    vec3<f32>(0.96, 0.45, 0.71),
    uniforms.pulse
  );

  var finalColor = screenGrad + vec3<f32>(rWave, gWave, bWave) * waveColor;

  let scanline = sin(uv.y * 200.0) * 0.04;
  finalColor = finalColor - scanline;

  let vignette = 1.0 - length((uv - 0.5) * 1.2);
  finalColor = finalColor * vignette;

  // Knob glows — aligned to CSS .shader-gui-knobs positions
  finalColor = finalColor + drawKnobGlow(uv, vec2<f32>(0.72, 0.22), 0.06, uniforms.rsycrb * 0.5);
  finalColor = finalColor + drawKnobGlow(uv, vec2<f32>(0.82, 0.22), 0.06, uniforms.fractal * 0.5);
  finalColor = finalColor + drawKnobGlow(uv, vec2<f32>(0.92, 0.22), 0.06, uniforms.pulse * 0.5);

  // LED glows — aligned to CSS .shader-gui-buttons positions
  finalColor = finalColor + drawLedGlow(uv, vec2<f32>(0.68, 0.42), vec3<f32>(0.3, 0.33, 0.39), uniforms.modeNone * 0.3);
  finalColor = finalColor + drawLedGlow(uv, vec2<f32>(0.76, 0.42), vec3<f32>(0.96, 0.45, 0.71), uniforms.modeIR * 0.6);
  finalColor = finalColor + drawLedGlow(uv, vec2<f32>(0.84, 0.42), vec3<f32>(0.97, 0.44, 0.44), 0.0);
  finalColor = finalColor + drawLedGlow(uv, vec2<f32>(0.92, 0.42), vec3<f32>(0.29, 0.87, 0.50), uniforms.isPlaying * 0.6);

  finalColor = finalColor * (0.7 + uniforms.volume * 0.3);

  return vec4<f32>(finalColor, 1.0);
}
`;
