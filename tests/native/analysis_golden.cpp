// analysis_ring.h + dsp_fft.h checks for the C++ side (the SDL module itself
// cannot run under node). Build + run: npm run test:dsp-golden
//   - AnalysisRingState offsets match the u32 words src/audio/analysisRing.ts reads
//   - analysis_ring_write wraps, keeps the newest floats of oversize blocks, and
//     analysis_ring_reset / set_format bump the generation
//   - dsp_fft.h SIMD stages are bit-identical to the scalar stages
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <vector>
#include "../../src/sdl/analysis_ring.h"
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

static void ring_layout() {
    // analysisRing.ts: [0] writePos [1] generation [2] capacity [3] channels [4] sampleRate.
    CHECK(offsetof(AnalysisRingState, writePos) == 0);
    CHECK(offsetof(AnalysisRingState, generation) == 4);
    CHECK(offsetof(AnalysisRingState, capacity) == 8);
    CHECK(offsetof(AnalysisRingState, channels) == 12);
    CHECK(offsetof(AnalysisRingState, sampleRate) == 16);
    CHECK(sizeof(AnalysisRingState) == 32);
}

static void ring_writes() {
    analysis_ring_init(1000); // not a power of two: refused
    CHECK(analysis_ring_data() == nullptr);

    analysis_ring_init(16);
    const uint32_t gen0 = g_analysisRing.generation.load();
    analysis_ring_set_format(2, 48000);
    CHECK(g_analysisRing.generation.load() == gen0 + 1);
    CHECK(g_analysisRing.channels.load() == 2 && g_analysisRing.sampleRate.load() == 48000);

    float block[40];
    for (int i = 0; i < 40; ++i) block[i] = (float)i;
    analysis_ring_write(block, 10);
    analysis_ring_write(block + 10, 10); // wraps at 16
    CHECK(g_analysisRing.writePos.load() == 20);
    const float* d = analysis_ring_data();
    for (uint32_t p = 4; p < 20; ++p) CHECK(d[p & 15] == (float)p);

    analysis_ring_write(block, 40); // oversize: newest 16 floats, writePos still counts all 40
    CHECK(g_analysisRing.writePos.load() == 60);
    for (uint32_t p = 44; p < 60; ++p) CHECK(d[p & 15] == (float)(p - 20));

    analysis_ring_reset();
    CHECK(g_analysisRing.writePos.load() == 0);
    CHECK(g_analysisRing.generation.load() == gen0 + 2);
    analysis_ring_cleanup();
}

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
    ring_layout();
    ring_writes();
    fft_simd_matches_scalar();
    if (g_failures) {
        std::printf("analysis golden: %d failure(s)\n", g_failures);
        return 1;
    }
    std::printf("analysis golden: analysis_ring.h layout/wrap/reset OK, dsp_fft.h SIMD == scalar\n");
    return 0;
}
