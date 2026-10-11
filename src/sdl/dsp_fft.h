#pragma once
// `fft_spectrum` in C++: the WASM CPU golden for the gpu-chores WebGPU FFT and
// the spectrum path when WebGPU compute is unavailable.
//
// Definition (identical to src/gpu-chores/fft.ts, which documents it):
//   1. Mono mixdown: mean of the interleaved channels per frame.
//   2. Non-overlapping segments of `fftSize` frames (Welch, hop = fftSize). Fewer
//      frames than one segment -> one zero-padded segment; a trailing partial
//      segment is dropped otherwise.
//   3. Symmetric Hann window w[i] = 0.5 * (1 - cos(2*pi*i / (N-1))).
//   4. |X[k]| for k in [0, N/2), scaled by 2 / sum(w).
//   5. Mean over segments, then averaged into `bins` linear HUD bins.
//
// Arithmetic mirrors the WGSL kernels in src/gpu-chores/fft.wgsl rather than the
// f64 JS golden: f32 samples, f32 twiddle / Hann tables rounded from f64, radix-2
// Stockham autosort with the same butterfly expression order, f32 magnitude sum.
// The wasm-SIMD path (stages with ns >= 4) runs the same f32 ops in the same
// order and wasm has no implicit FMA, so it is bit-identical to the scalar path.
//
// Not real-time code: plan tables are rebuilt (cos/sin) when the size changes.
// Never call this from the audio callback — analysis consumers pull it at UI
// rate (<= 30 Hz) from their own thread. Storage is static (no heap), so it
// links into the fixed-memory STANDALONE_WASM dsp-chain module.

#include <cmath>
#include <cstdint>
#if defined(__wasm_simd128__)
#include <wasm_simd128.h>
#endif

constexpr int DSP_FFT_MIN_SIZE = 64;
constexpr int DSP_FFT_MAX_SIZE = 16384;
constexpr int DSP_FFT_DEFAULT_SIZE = 2048;
constexpr int DSP_FFT_MAX_LINES = DSP_FFT_MAX_SIZE / 2;
constexpr int DSP_FFT_MAX_BINS = 4096;

struct DspFftState {
    int n = 0;
    int log2n = 0;
    double windowSum = 0.0;
    alignas(16) float hann[DSP_FFT_MAX_SIZE];
    // Stage twiddles packed contiguously: stage `ns` owns [ns - 1, 2 * ns - 1),
    // entry k = exp(-pi*i*k/ns) = exp(-2*pi*i*m/n) with m = k * n / (2 * ns).
    alignas(16) float twRe[DSP_FFT_MAX_SIZE];
    alignas(16) float twIm[DSP_FFT_MAX_SIZE];
    // Ping-pong split-complex work buffers (SoA so stages vectorize).
    alignas(16) float re[2][DSP_FFT_MAX_SIZE];
    alignas(16) float im[2][DSP_FFT_MAX_SIZE];
    // Segment-summed magnitudes, then the final N/2 lines.
    alignas(16) float lines[DSP_FFT_MAX_LINES];
};

inline DspFftState g_dspFft;

/** clampFftSize(): non-finite / <= 0 -> default; else the next power of two in [MIN, MAX]. */
inline int dsp_fft_clamp_size(int size) {
    if (size <= 0) return DSP_FFT_DEFAULT_SIZE;
    int p = DSP_FFT_MIN_SIZE;
    while (p < size && p < DSP_FFT_MAX_SIZE) p <<= 1;
    return p;
}

/** clampBinCount(): <= 0 -> fallback; else [1, DSP_FFT_MAX_BINS]. */
inline int dsp_fft_clamp_bins(int bins, int fallback) {
    if (bins <= 0) return fallback;
    return bins > DSP_FFT_MAX_BINS ? DSP_FFT_MAX_BINS : bins;
}

/** Rebuild window / twiddle tables for size `n` (power of two, already clamped). */
inline void dsp_fft_plan(DspFftState& f, int n) {
    if (f.n == n) return;
    f.n = n;
    f.log2n = 0;
    while ((1 << f.log2n) < n) ++f.log2n;
    const double denom = n > 1 ? (double)(n - 1) : 1.0;
    double sum = 0.0;
    for (int i = 0; i < n; ++i) {
        const double w = 0.5 * (1.0 - std::cos(2.0 * M_PI * (double)i / denom));
        sum += w;
        f.hann[i] = (float)w;
    }
    f.windowSum = sum;
    for (int ns = 1; ns < n; ns <<= 1) {
        const int stride = n / (2 * ns);
        for (int k = 0; k < ns; ++k) {
            const double angle = -2.0 * M_PI * (double)(k * stride) / (double)n;
            f.twRe[ns - 1 + k] = (float)std::cos(angle);
            f.twIm[ns - 1 + k] = (float)std::sin(angle);
        }
    }
}

// One Stockham stage over j in [begin, end): src -> dst. Mirrors WGSL stage_main.
inline void dsp_fft_stage_scalar(const DspFftState& f, int ns, int begin, int end,
                                 const float* sr, const float* si, float* dr, float* di) {
    const int half = f.n >> 1;
    const float* twr = f.twRe + (ns - 1);
    const float* twi = f.twIm + (ns - 1);
    for (int j = begin; j < end; ++j) {
        const int k = j & (ns - 1);
        const int idx = ((j - k) << 1) + k;
        const float wr = twr[k];
        const float wi = twi[k];
        const float v0r = sr[j];
        const float v0i = si[j];
        const float b_r = sr[j + half];
        const float b_i = si[j + half];
        const float v1r = b_r * wr - b_i * wi;
        const float v1i = b_r * wi + b_i * wr;
        dr[idx] = v0r + v1r;
        di[idx] = v0i + v1i;
        dr[idx + ns] = v0r - v1r;
        di[idx + ns] = v0i - v1i;
    }
}

#if defined(__wasm_simd128__)
// ns >= 4: four consecutive j share one ns-block, so k, idx and the stage
// twiddles are contiguous and every load/store is a plain v128.
inline void dsp_fft_stage_simd(const DspFftState& f, int ns,
                               const float* sr, const float* si, float* dr, float* di) {
    const int half = f.n >> 1;
    const float* twr = f.twRe + (ns - 1);
    const float* twi = f.twIm + (ns - 1);
    for (int j = 0; j < half; j += 4) {
        const int k = j & (ns - 1);
        const int idx = ((j - k) << 1) + k;
        const v128_t wr = wasm_v128_load(twr + k);
        const v128_t wi = wasm_v128_load(twi + k);
        const v128_t v0r = wasm_v128_load(sr + j);
        const v128_t v0i = wasm_v128_load(si + j);
        const v128_t b_r = wasm_v128_load(sr + j + half);
        const v128_t b_i = wasm_v128_load(si + j + half);
        const v128_t v1r = wasm_f32x4_sub(wasm_f32x4_mul(b_r, wr), wasm_f32x4_mul(b_i, wi));
        const v128_t v1i = wasm_f32x4_add(wasm_f32x4_mul(b_r, wi), wasm_f32x4_mul(b_i, wr));
        wasm_v128_store(dr + idx, wasm_f32x4_add(v0r, v1r));
        wasm_v128_store(di + idx, wasm_f32x4_add(v0i, v1i));
        wasm_v128_store(dr + idx + ns, wasm_f32x4_sub(v0r, v1r));
        wasm_v128_store(di + idx + ns, wasm_f32x4_sub(v0i, v1i));
    }
}
#endif

/**
 * Forward FFT of re[0] / im[0] (planned size). Returns the buffer index (0 or 1)
 * holding the result. `allowSimd` exists for the scalar-vs-SIMD golden test.
 */
inline int dsp_fft_forward(DspFftState& f, bool allowSimd = true) {
    const int half = f.n >> 1;
    int src = 0;
    for (int ns = 1; ns < f.n; ns <<= 1) {
        const int dst = src ^ 1;
#if defined(__wasm_simd128__)
        if (allowSimd && ns >= 4) {
            dsp_fft_stage_simd(f, ns, f.re[src], f.im[src], f.re[dst], f.im[dst]);
            src = dst;
            continue;
        }
#else
        (void)allowSimd;
#endif
        dsp_fft_stage_scalar(f, ns, 0, half, f.re[src], f.im[src], f.re[dst], f.im[dst]);
        src = dst;
    }
    return src;
}

/**
 * Steps 1-4 (+ segment mean) over `samples` interleaved floats. Writes N/2
 * amplitude-normalized lines to g_dspFft.lines and returns the effective N.
 */
inline int dsp_fft_magnitudes(const float* pcm, int samples, int channels, int fftSize,
                              bool allowSimd = true) {
    DspFftState& f = g_dspFft;
    const int n = dsp_fft_clamp_size(fftSize);
    dsp_fft_plan(f, n);
    const int ch = channels > 0 ? channels : 1;
    const int frames = samples > 0 ? samples / ch : 0;
    const int segments = frames / n > 0 ? frames / n : 1;
    const int lineCount = n >> 1;
    const float chScale = (float)ch;
    for (int k = 0; k < lineCount; ++k) f.lines[k] = 0.0f;

    for (int seg = 0; seg < segments; ++seg) {
        // window_main: mono mixdown (f32 sum / channels) x Hann table.
        float* re = f.re[0];
        float* im = f.im[0];
        for (int i = 0; i < n; ++i) {
            const int frame = seg * n + i;
            float s = 0.0f;
            if (frame < frames) {
                const float* at = pcm + (size_t)frame * (size_t)ch;
                for (int c = 0; c < ch; ++c) s += at[c];
                s = s / chScale;
            }
            re[i] = s * f.hann[i];
            im[i] = 0.0f;
        }
        const int out = dsp_fft_forward(f, allowSimd);
        const float* xr = f.re[out];
        const float* xi = f.im[out];
        for (int k = 0; k < lineCount; ++k) {
            f.lines[k] += std::sqrt(xr[k] * xr[k] + xi[k] * xi[k]);
        }
    }

    // magnitude_main: sum * norm / segments, norm passed as f32 like the uniform.
    const float norm = f.windowSum > 0.0 ? (float)(2.0 / f.windowSum) : 0.0f;
    const float segScale = (float)segments;
    for (int k = 0; k < lineCount; ++k) f.lines[k] = f.lines[k] * norm / segScale;
    return n;
}

/** binFftMagnitudes(): average `count` lines into `bins` linear bins. */
inline void dsp_fft_bin(const float* lines, int count, float* out, int bins) {
    if (count <= 0) {
        for (int b = 0; b < bins; ++b) out[b] = 0.0f;
        return;
    }
    for (int b = 0; b < bins; ++b) {
        int start = (int)(((int64_t)b * count) / bins);
        if (start > count - 1) start = count - 1;
        const int end = (int)(((int64_t)(b + 1) * count) / bins);
        if (end <= start) {
            out[b] = lines[start];
            continue;
        }
        double sum = 0.0;
        for (int i = start; i < end; ++i) sum += lines[i];
        out[b] = (float)(sum / (double)(end - start));
    }
}

/** Full `fft_spectrum`: `bins` HUD bins into `out`. Returns the effective FFT size. */
inline int dsp_fft_spectrum(const float* pcm, int samples, int channels, int fftSize,
                            float* out, int bins, bool allowSimd = true) {
    const int n = dsp_fft_magnitudes(pcm, samples, channels, fftSize, allowSimd);
    dsp_fft_bin(g_dspFft.lines, n >> 1, out, bins);
    return n;
}
