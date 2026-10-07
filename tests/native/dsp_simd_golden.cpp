// Scalar vs wasm-SIMD speaker DSP golden test (dsp_chain.h).
// Build + run: npm run test:dsp-golden
// Also prints an FNV-1a hash of the SIMD output per limiter setting;
// tests/dspChainWasm.test.ts replays these vectors through public/dsp-chain.wasm
// (the AudioWorklet build) and expects the same hashes.
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <vector>
#include "../../src/sdl/dsp_chain.h"

#if !defined(__wasm_simd128__)
#error "build with -msimd128"
#endif

static std::vector<float> run(bool simd, const std::vector<float>& in, bool limiter) {
    g_dspState = DspState{};
    dsp_set_replaygain(limiter ? 2.5f : 1.0f, limiter ? 1 : 0);
    std::vector<float> out = in;
    // Odd chunk sizes exercise frames split across callbacks.
    const int chunks[] = {1, 7, 256, 3, 1024, 513};
    size_t pos = 0;
    for (int k = 0; pos < out.size(); ++k) {
        int n = std::min<int>(chunks[k % 6], (int)(out.size() - pos));
        dsp_process(out.data() + pos, n, 2, 48000, 0.8f, simd);
        pos += (size_t)n;
    }
    return out;
}

static uint32_t fnv1a(const std::vector<float>& v) {
    uint32_t h = 2166136261u;
    for (float f : v) {
        uint32_t bits;
        std::memcpy(&bits, &f, sizeof bits);
        for (int k = 0; k < 4; ++k) {
            h ^= (bits >> (8 * k)) & 0xffu;
            h *= 16777619u;
        }
    }
    return h;
}

int main() {
    const float freqs[] = {32, 64, 125, 250, 500, 1000, 2000, 4000};
    const float gains[] = {6, -3, 4, 0, -6, 2, 9, -12};
    for (int b = 0; b < 8; ++b) {
        int type = b == 0 ? DSP_EQ_LOWSHELF : b == 7 ? DSP_EQ_HIGHSHELF : DSP_EQ_PEAKING;
        dsp_set_eq_band(b, type, freqs[b], 1.4f, gains[b]);
    }
    std::vector<float> in(48000 * 2 + 1); // odd length: trailing half frame
    for (size_t i = 0; i < in.size(); ++i) {
        double t = (double)(i / 2) / 48000.0;
        in[i] = (float)(0.9 * std::sin(2 * M_PI * (i % 2 ? 440.0 : 1000.0) * t));
    }
    int failures = 0;
    for (int lim = 0; lim < 2; ++lim) {
        auto a = run(false, in, lim);
        auto b = run(true, in, lim);
        double maxDiff = 0;
        for (size_t i = 0; i < a.size(); ++i) maxDiff = std::max(maxDiff, (double)std::fabs(a[i] - b[i]));
        std::printf("limiter=%d max |scalar - simd| = %.3g  simd fnv1a = 0x%08x\n", lim, maxDiff, fnv1a(b));
        if (!(maxDiff <= 1e-6)) ++failures;
    }
    std::puts(failures ? "FAIL" : "PASS");
    return failures ? 1 : 0;
}
