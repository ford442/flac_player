// gpu-chores `fft_spectrum` — radix-2 Stockham FFT (loaded via `?raw` by webgpuFft.ts).
// Definition and CPU golden: src/gpu-chores/fft.ts. `stage_main` is mirrored line
// for line by `stockhamFftReference` so the algorithm is unit-tested without a GPU.
//
// Twiddles and the Hann window come from f64 tables built on the CPU: WGSL only
// guarantees cos/sin to 2^-11 absolute error, which alone exceeds FFT_GPU_EPSILON.

struct Params {
  n: u32,          // FFT size (power of two)
  segments: u32,   // Welch segments (batch)
  channels: u32,   // interleaved PCM channels
  ns: u32,         // Stockham sub-transform size for this stage
  flip: u32,       // 0: A → B, 1: B → A (stage); final buffer select (magnitude)
  frames: u32,     // PCM frames available
  norm: f32,       // 2 / Σw
  samples: u32,    // PCM sample count (bounds)
};

@group(0) @binding(0) var<storage, read> pcm: array<f32>;
@group(0) @binding(1) var<storage, read_write> bufA: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> bufB: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read_write> mags: array<f32>;
@group(0) @binding(4) var<uniform> params: Params;
// twiddles[m] = exp(-2πi·m/n), m in [0, n/2)
@group(0) @binding(5) var<storage, read> twiddles: array<vec2<f32>>;
// hann[i] = 0.5·(1 − cos(2πi/(n−1)))
@group(0) @binding(6) var<storage, read> hann: array<f32>;

@compute @workgroup_size({{WORKGROUP_SIZE}})
fn window_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= params.n * params.segments) { return; }
  let i = idx % params.n;
  let frame = idx; // segment * n + i
  var s = 0.0;
  if (frame < params.frames) {
    for (var c = 0u; c < params.channels; c = c + 1u) {
      let at = frame * params.channels + c;
      if (at < params.samples) { s = s + pcm[at]; }
    }
    s = s / f32(params.channels);
  }
  bufA[idx] = vec2<f32>(s * hann[i], 0.0);
}

fn cmul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

@compute @workgroup_size({{WORKGROUP_SIZE}})
fn stage_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let halfN = params.n / 2u;
  if (gid.x >= halfN * params.segments) { return; }
  let base = (gid.x / halfN) * params.n;
  let j = gid.x % halfN;
  let ns = params.ns;
  let k = j % ns;
  // exp(-πi·k/ns) = twiddles[k · n/(2·ns)]
  let w = twiddles[k * (params.n / (2u * ns))];
  let idx = (j / ns) * ns * 2u + k;

  if (params.flip == 0u) {
    let v0 = bufA[base + j];
    let v1 = cmul(bufA[base + j + halfN], w);
    bufB[base + idx] = v0 + v1;
    bufB[base + idx + ns] = v0 - v1;
  } else {
    let v0 = bufB[base + j];
    let v1 = cmul(bufB[base + j + halfN], w);
    bufA[base + idx] = v0 + v1;
    bufA[base + idx + ns] = v0 - v1;
  }
}

@compute @workgroup_size({{WORKGROUP_SIZE}})
fn magnitude_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k = gid.x;
  if (k >= params.n / 2u) { return; }
  var sum = 0.0;
  for (var s = 0u; s < params.segments; s = s + 1u) {
    let at = s * params.n + k;
    if (params.flip == 0u) {
      sum = sum + length(bufA[at]);
    } else {
      sum = sum + length(bufB[at]);
    }
  }
  mags[k] = sum * params.norm / f32(params.segments);
}
