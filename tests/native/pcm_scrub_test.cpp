// pcm_scrub.h + dsp_chain.h (host scalar build):
//   - NaN / +-Inf become 0; finite values (incl. -0, subnormals, FLT_MAX) are untouched
//   - why the scrub sits at the push boundary: one NaN through an active EQ band
//     poisons its history and later finite input keeps coming out NaN
//   - the same burst scrubbed first leaves the chain finite
#include <cfloat>
#include <cmath>
#include <limits>
#include <vector>
#include "native_test.h"
#include "../../src/sdl/dsp_chain.h"
#include "../../src/sdl/pcm_scrub.h"

static void scrub_values() {
    const float nan = std::numeric_limits<float>::quiet_NaN();
    const float inf = std::numeric_limits<float>::infinity();
    std::vector<float> v = {0.5f, nan, -inf, inf, -0.0f, FLT_MIN / 4.0f, FLT_MAX, -FLT_MAX, -nan};
    CHECK_EQ(pcm_scrub_nonfinite(v.data(), v.size()), static_cast<size_t>(4));
    CHECK(v[0] == 0.5f && v[1] == 0.0f && v[2] == 0.0f && v[3] == 0.0f);
    CHECK(v[4] == 0.0f && std::signbit(v[4]));
    CHECK(v[5] == FLT_MIN / 4.0f && v[6] == FLT_MAX && v[7] == -FLT_MAX && v[8] == 0.0f);
    CHECK_EQ(pcm_scrub_nonfinite(nullptr, 4), static_cast<size_t>(0));
}

static bool all_finite(const std::vector<float>& v) {
    for (float x : v)
        if (!std::isfinite(x)) return false;
    return true;
}

// 2 ch, 48 kHz, one active peaking band; returns the block after a burst.
static std::vector<float> block_after_burst(bool scrub) {
    g_dspState = DspState{};
    dsp_set_replaygain(1.0f, 0);
    dsp_set_eq_band(0, DSP_EQ_PEAKING, 1000.0f, 1.4f, 6.0f);
    std::vector<float> burst(512, 0.25f);
    burst[101] = std::numeric_limits<float>::quiet_NaN();
    if (scrub) pcm_scrub_nonfinite(burst.data(), burst.size());
    dsp_process(burst.data(), static_cast<int>(burst.size()), 2, 48000, 1.0f);
    std::vector<float> later(4096, 0.25f);
    dsp_process(later.data(), static_cast<int>(later.size()), 2, 48000, 1.0f);
    return later;
}

int main() {
    scrub_values();
    CHECK(!all_finite(block_after_burst(false)));
    CHECK(all_finite(block_after_burst(true)));
    return native_test_result("pcm_scrub_test");
}
