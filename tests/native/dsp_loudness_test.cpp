// src/sdl/dsp_loudness.h: BS.1770-4 K-weighting, channel weights and the
// momentary / short-term windows. Cross-checked against libebur128 1.2.6 while
// it was written (equal to < 1e-7 LU at every 100 ms boundary, 1-6 ch,
// 11.025-192 kHz); these cases pin the standard's own numbers so the test needs
// no third-party code. tests/dspChainWasm.test.ts runs the shipped module.
#include <cmath>
#include <vector>
#include "../../src/sdl/dsp_loudness.h"
#include "native_test.h"

static std::vector<float> sine(int channels, int sampleRate, double seconds, double peakDb,
                               const std::vector<double>& channelGainDb = {}) {
    const int frames = (int)std::lround(seconds * sampleRate);
    std::vector<float> out((size_t)frames * (size_t)channels);
    for (int i = 0; i < frames; ++i) {
        const double v = std::sin(2.0 * M_PI * 1000.0 * i / sampleRate);
        for (int c = 0; c < channels; ++c) {
            const double db = peakDb + (c < (int)channelGainDb.size() ? channelGainDb[(size_t)c] : 0.0);
            out[(size_t)i * (size_t)channels + (size_t)c] = (float)(std::pow(10.0, db / 20.0) * v);
        }
    }
    return out;
}

static bool near(double a, double b, double eps) { return std::fabs(a - b) <= eps; }

int main() {
    // ITU-R BS.1770-4 Table 1 / 2: the 48 kHz K-weighting coefficients.
    {
        DspLoudness m;
        dsp_loudness_reset(m, 2, 48000);
        CHECK(near(m.shelfB[0], 1.53512485958697, 1e-9));
        CHECK(near(m.shelfB[1], -2.69169618940638, 1e-9));
        CHECK(near(m.shelfB[2], 1.19839281085285, 1e-9));
        CHECK(near(m.shelfA[1], -1.69065929318241, 1e-9));
        CHECK(near(m.shelfA[2], 0.73248077421585, 1e-9));
        CHECK(near(m.hpA[1], -1.99004745483398, 1e-9));
        CHECK(near(m.hpA[2], 0.99007225036621, 1e-9));
        CHECK_EQ(m.blockFrames, 4800);
    }

    // EBU Tech 3341 cases 1 and 2: stereo 1 kHz sine at -23 / -33 dBFS reads
    // -23.0 / -33.0 LUFS (±0.1 LU) on the momentary and short-term meters.
    for (const int rate : {44100, 48000, 96000, 192000}) {
        for (const double db : {-23.0, -33.0}) {
            DspLoudness m;
            dsp_loudness_reset(m, 2, rate);
            const auto x = sine(2, rate, 4.0, db);
            dsp_loudness_push(m, x.data(), (int)x.size());
            CHECK(near(dsp_loudness_momentary(m), db, 0.1));
            CHECK(near(dsp_loudness_short_term(m), db, 0.1));
        }
    }

    // NaN until the window is full, -inf for digital silence.
    {
        DspLoudness m;
        dsp_loudness_reset(m, 2, 48000);
        const auto x = sine(2, 48000, 0.35, -23.0);
        dsp_loudness_push(m, x.data(), (int)x.size());
        CHECK(std::isnan(dsp_loudness_momentary(m)));
        const auto more = sine(2, 48000, 0.05, -23.0);
        dsp_loudness_push(m, more.data(), (int)more.size());
        CHECK(near(dsp_loudness_momentary(m), -23.0, 0.1));
        CHECK(std::isnan(dsp_loudness_short_term(m)));

        DspLoudness quiet;
        dsp_loudness_reset(quiet, 2, 48000);
        std::vector<float> zeros(48000 * 2);
        dsp_loudness_push(quiet, zeros.data(), (int)zeros.size());
        CHECK(std::isinf(dsp_loudness_momentary(quiet)) && dsp_loudness_momentary(quiet) < 0);
    }

    // Channel weights: mono carries half the stereo energy; 5.1 weights the
    // surrounds 1.41 and drops the LFE (libebur128's default map).
    {
        DspLoudness mono;
        dsp_loudness_reset(mono, 1, 48000);
        const auto x = sine(1, 48000, 1.0, -23.0);
        dsp_loudness_push(mono, x.data(), (int)x.size());
        CHECK(near(dsp_loudness_momentary(mono), -23.0 - 10.0 * std::log10(2.0), 0.1));

        DspLoudness surround;
        dsp_loudness_reset(surround, 6, 48000);
        const auto y = sine(6, 48000, 1.0, -23.0);
        dsp_loudness_push(surround, y.data(), (int)y.size());
        const double weights = 1 + 1 + 1 + 0 + 1.41 + 1.41;
        CHECK(near(dsp_loudness_momentary(surround), -23.0 + 10.0 * std::log10(weights / 2.0), 0.1));

        DspLoudness lfe;
        dsp_loudness_reset(lfe, 6, 48000);
        const auto z = sine(6, 48000, 1.0, -10.0, {-300, -300, -300, 0, -300, -300});
        dsp_loudness_push(lfe, z.data(), (int)z.size());
        CHECK(dsp_loudness_momentary(lfe) < -200.0);
    }

    // Odd chunks (frames split across calls) read the same as one push.
    {
        const auto x = sine(2, 48000, 3.2, -18.0);
        DspLoudness whole, chunked;
        dsp_loudness_reset(whole, 2, 48000);
        dsp_loudness_reset(chunked, 2, 48000);
        dsp_loudness_push(whole, x.data(), (int)x.size());
        const int chunks[] = {1, 7, 4096, 3, 513};
        size_t pos = 0;
        for (int k = 0; pos < x.size(); ++k) {
            const int n = (int)std::min<size_t>((size_t)chunks[k % 5], x.size() - pos);
            dsp_loudness_push(chunked, x.data() + pos, n);
            pos += (size_t)n;
        }
        CHECK(dsp_loudness_momentary(whole) == dsp_loudness_momentary(chunked));
        CHECK(dsp_loudness_short_term(whole) == dsp_loudness_short_term(chunked));
    }

    return native_test_result("dsp_loudness_test");
}
