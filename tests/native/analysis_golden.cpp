// dsp_fft.h, the FFT behind fft_spectrum (src/audio/wasmFft.ts), which reads
// the analysis ring on the reader's thread: its SIMD stages are bit-identical
// to the scalar ones. The ring itself has one writer since #268, the dsp-chain
// worklet (tests/analysisRing.test.ts). Build + run: npm run test:dsp-golden
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <vector>
#include "../../src/sdl/dsp_fft.h"

#if !defined(__wasm_simd128__)
#error "build with -msimd128"
#endif

static int g_failures = 0;

#define CHECK(cond)                                                      \
    do {                                                                 \
        if (!(cond)) {                                                   \
            std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            ++g_failures;                                                \
        }                                                                \
    } while (0)

static void fft_simd_matches_scalar() {
    std::vector<float> pcm(16384 * 2);
    uint32_t x = 0x9e3779b9u;
    for (float& v : pcm) {
        x ^= x << 13; x ^= x >> 17; x ^= x << 5;
        v = (float)x / 2147483648.0f - 1.0f;
    }
    std::vector<float> a(4096), b(4096);
    for (int n : {64, 128, 2048, 16384}) {
        for (int ch : {1, 2, 6}) {
            const int samples = std::min<int>((int)pcm.size(), n * ch * 2);
            dsp_fft_spectrum(pcm.data(), samples, ch, n, a.data(), 4096, true);
            std::vector<float> linesSimd(g_dspFft.lines, g_dspFft.lines + n / 2);
            dsp_fft_spectrum(pcm.data(), samples, ch, n, b.data(), 4096, false);
            CHECK(std::memcmp(linesSimd.data(), g_dspFft.lines, sizeof(float) * (n / 2)) == 0);
            CHECK(std::memcmp(a.data(), b.data(), sizeof(float) * 4096) == 0);
        }
    }
}

int main() {
    fft_simd_matches_scalar();
    if (g_failures) {
        std::printf("analysis golden: %d failure(s)\n", g_failures);
        return 1;
    }
    std::printf("analysis golden: dsp_fft.h SIMD == scalar\n");
    return 0;
}
