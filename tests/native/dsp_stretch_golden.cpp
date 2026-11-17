// Pitch-hold golden for dsp_chain.h's stretch stage (src/sdl/dsp_stretch.h),
// built with the standalone-dsp codegen (wasm32, -msimd128) and run under node:
//   npm run test:dsp-golden
//
//   1. 1.0× with pitch hold is bit-identical to the bypassed chain (hold off, and
//      no stretcher configured at all).
//   2. 1.25× held: a 1250 Hz tone (a 1 kHz tone played varispeed at 1.25×) comes
//      out at 1 kHz: within STRETCH_MAX_HZ_ERROR, and in every 20 ms window the
//      residual after a least-squares sinusoid fit stays below
//      STRETCH_RESIDUAL_DB of the tone (both documented in docs/AUDIO_BACKENDS.md).
//      Varispeed (hold off) leaves the 1250 Hz tone alone.
//   3. A reset (seek) while held starts on the stretched signal: no 1250 Hz
//      blip during the stretch latency.
//   4. dsp_process never allocates: engage, rate retunes, disengage, re-engage,
//      reset and hold toggles, counted through operator new.
//   5. dsp_stretch_configure fits DSP_STRETCH_HEAP_BUDGET for every format up to
//      DSP_STRETCH_MAX_CHANNEL_HZ, and refuses the formats above it.
// Prints an FNV-1a of (2); tests/dspChainWasm.test.ts replays it through
// public/dsp-chain.wasm and expects the same hash.
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <new>
#include <vector>

static long g_allocs = 0;
static long g_liveBytes = 0;
static long g_peakBytes = 0;

// Size-prefixed so delete can account for it (wasm32: 8 bytes keeps 8-byte alignment).
void* operator new(size_t n) {
    ++g_allocs;
    auto* p = static_cast<unsigned char*>(std::malloc(n + 8));
    if (!p) std::abort();
    std::memcpy(p, &n, sizeof n);
    g_liveBytes += (long)n;
    if (g_liveBytes > g_peakBytes) g_peakBytes = g_liveBytes;
    return p + 8;
}
void operator delete(void* ptr) noexcept {
    if (!ptr) return;
    auto* p = static_cast<unsigned char*>(ptr) - 8;
    size_t n;
    std::memcpy(&n, p, sizeof n);
    g_liveBytes -= (long)n;
    std::free(p);
}
void operator delete(void* ptr, size_t) noexcept { operator delete(ptr); }

#include "../../src/sdl/dsp_chain.h"

#if !defined(__wasm_simd128__)
#error "build with -msimd128"
#endif

constexpr int RATE = 48000;
constexpr int QUANTUM = 128;
/** Documented bounds: worst 20 ms residual after a sinusoid fit, relative to the tone... */
constexpr double STRETCH_RESIDUAL_DB = -50.0;
/** ...and the held tone's frequency error (0.05 Hz at 1 kHz is 0.09 cent). */
constexpr double STRETCH_MAX_HZ_ERROR = 0.05;

static int g_failures = 0;
#define EXPECT(cond, ...)                                    \
    do {                                                     \
        if (!(cond)) {                                       \
            std::printf("FAIL %s:%d: ", __FILE__, __LINE__); \
            std::printf(__VA_ARGS__);                        \
            std::printf("\n");                               \
            ++g_failures;                                    \
        }                                                    \
    } while (0)

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

static std::vector<float> stereo_tone(double freq, double seconds, double amplitude) {
    const int frames = (int)std::lround(seconds * RATE);
    std::vector<float> out((size_t)frames * 2);
    for (int i = 0; i < frames; ++i) {
        const float v = (float)(amplitude * std::sin(2.0 * M_PI * freq * i / RATE));
        out[2 * (size_t)i] = v;
        out[2 * (size_t)i + 1] = v;
    }
    return out;
}

/** Fresh chain state: flat EQ, unity gain, stretcher configured (or not) for stereo 48 kHz. */
static void fresh_chain(bool configureStretch) {
    g_dspState = DspState{};
    for (int b = 0; b < DSP_EQ_MAX_BANDS; ++b) dsp_set_eq_band(b, DSP_EQ_PEAKING, 1000.0f, 1.0f, 0.0f);
    dsp_set_replaygain(1.0f, 0);
    dsp_set_playback_rate(1.0f, 1);
    if (configureStretch) dsp_stretch_configure(g_dspStretch, 2, RATE);
    else dsp_stretch_configure(g_dspStretch, 0, 0);
    dsp_request_reset();
}

/** Run `in` through dsp_process in worklet quanta (whole frames, as the worklet passes them). */
static std::vector<float> run(const std::vector<float>& in, float volume = 1.0f) {
    std::vector<float> out = in;
    for (size_t pos = 0; pos < out.size(); pos += QUANTUM * 2) {
        const int n = (int)std::min<size_t>(QUANTUM * 2, out.size() - pos);
        dsp_process(out.data() + pos, n, 2, RATE, volume);
    }
    return out;
}

struct ToneFit {
    double amplitude;
    double phase;
    double residualDb;
};

/** Least-squares a·sin + b·cos at `freq` over channel 0 frames [from, to); residual relative to the tone. */
static ToneFit fit_tone(const std::vector<float>& x, double freq, int from, int to) {
    double ss = 0, cc = 0, sc = 0, xs = 0, xc = 0;
    for (int i = from; i < to; ++i) {
        const double w = 2.0 * M_PI * freq * i / RATE;
        const double s = std::sin(w), c = std::cos(w), v = x[2 * (size_t)i];
        ss += s * s;
        cc += c * c;
        sc += s * c;
        xs += v * s;
        xc += v * c;
    }
    const double det = ss * cc - sc * sc;
    const double a = (xs * cc - xc * sc) / det;
    const double b = (xc * ss - xs * sc) / det;
    double residual = 0, tone = 0;
    for (int i = from; i < to; ++i) {
        const double w = 2.0 * M_PI * freq * i / RATE;
        const double fit = a * std::sin(w) + b * std::cos(w);
        const double e = x[2 * (size_t)i] - fit;
        residual += e * e;
        tone += fit * fit;
    }
    return {std::hypot(a, b), std::atan2(b, a), 10.0 * std::log10(residual / tone)};
}

struct ToneTrack {
    double amplitude;      // mean over windows
    double worstResidualDb;
    double frequency;      // `freq` + the phase slope across windows
};

/** Fit `freq` in 20 ms windows over [from, to): worst residual, and the true frequency from the phase drift. */
static ToneTrack track_tone(const std::vector<float>& x, double freq, int from, int to) {
    const int window = RATE / 50;
    double worst = -1e9, amp = 0, prevPhase = 0, unwrapped = 0;
    double sumT = 0, sumP = 0, sumTT = 0, sumTP = 0;
    int n = 0;
    for (int start = from; start + window <= to; start += window, ++n) {
        const ToneFit f = fit_tone(x, freq, start, start + window);
        worst = std::max(worst, f.residualDb);
        amp += f.amplitude;
        if (n > 0) {
            double d = f.phase - prevPhase;
            while (d > M_PI) d -= 2 * M_PI;
            while (d < -M_PI) d += 2 * M_PI;
            unwrapped += d;
        }
        prevPhase = f.phase;
        const double t = (start + window / 2.0) / RATE;
        sumT += t;
        sumP += unwrapped;
        sumTT += t * t;
        sumTP += t * unwrapped;
    }
    const double slope = (n * sumTP - sumT * sumP) / (n * sumTT - sumT * sumT); // rad/s
    // a·sin(wt) + b·cos(wt) = A·sin(wt + phase): a phase growing at `slope` is +slope/2π Hz.
    return {amp / n, worst, freq + slope / (2.0 * M_PI)};
}

static void unity_is_bypass() {
    // Music-like: two tones and a little noise, both channels different.
    std::vector<float> in((size_t)RATE * 2 * 2);
    uint32_t seed = 7;
    for (size_t i = 0; i < in.size(); ++i) {
        seed = seed * 1664525u + 1013904223u;
        const double t = (double)(i >> 1) / RATE;
        in[i] = (float)(0.4 * std::sin(2 * M_PI * (i % 2 ? 330.0 : 523.0) * t) + 0.05 * ((seed >> 9) / 8388608.0 - 1.0));
    }
    fresh_chain(false);
    const auto bypass = run(in, 0.8f);
    fresh_chain(true);
    dsp_set_playback_rate(1.0f, 1);
    const auto heldUnity = run(in, 0.8f);
    fresh_chain(true);
    dsp_set_playback_rate(1.0f, 0);
    const auto varispeedUnity = run(in, 0.8f);
    EXPECT(heldUnity == bypass, "1.0x with pitch hold differs from the bypassed chain");
    EXPECT(varispeedUnity == bypass, "1.0x varispeed differs from the bypassed chain");
    EXPECT(!dsp_stretch_engaged(g_dspStretch), "stretch engaged at 1.0x");
    fresh_chain(true);
    const auto flat = run(in, 1.0f);
    EXPECT(flat == in, "flat chain at 1.0x is not an identity");
    std::printf("1.0x pitch hold == bypass: %s (fnv1a 0x%08x)\n", heldUnity == bypass ? "yes" : "NO", fnv1a(heldUnity));
}

static void held_rate_keeps_pitch() {
    const double rate = 1.25;
    // What a 1 kHz tone sounds like from a source playing varispeed at 1.25x.
    const auto in = stereo_tone(1000.0 * rate, 3.0, 0.5);
    fresh_chain(true);
    dsp_set_playback_rate((float)rate, 1);
    const auto held = run(in);
    EXPECT(dsp_stretch_engaged(g_dspStretch), "stretch not engaged at 1.25x with pitch hold");
    // Skip the engage seam (fade + stretch latency), measure 2 s of steady state.
    const int from = RATE / 2, to = (int)(held.size() / 2) - RATE / 4;
    const ToneTrack at1k = track_tone(held, 1000.0, from, to);
    const ToneFit at1250 = fit_tone(held, 1250.0, from, to);
    std::printf("1.25x pitch hold: %.4f Hz (bound ±%.2f), amplitude %.4f, worst 20 ms residual %.1f dB (bound %.1f), "
                "1250 Hz left %.5f, fnv1a 0x%08x\n",
                at1k.frequency, STRETCH_MAX_HZ_ERROR, at1k.amplitude, at1k.worstResidualDb, STRETCH_RESIDUAL_DB,
                at1250.amplitude, fnv1a(held));
    EXPECT(std::fabs(at1k.frequency - 1000.0) < STRETCH_MAX_HZ_ERROR, "held tone at %.4f Hz", at1k.frequency);
    EXPECT(at1k.worstResidualDb < STRETCH_RESIDUAL_DB, "residual %.1f dB", at1k.worstResidualDb);
    EXPECT(std::fabs(at1k.amplitude - 0.5) < 0.05, "1 kHz amplitude %.4f, want 0.5", at1k.amplitude);
    EXPECT(at1250.amplitude < 0.005, "1250 Hz left over: %.5f", at1250.amplitude);

    fresh_chain(true);
    dsp_set_playback_rate((float)rate, 0);
    const auto varispeed = run(in);
    EXPECT(varispeed == in, "varispeed 1.25x is not a bypass");
}

/** A seek (reset) while held: the latency is quiet, never a blip of the un-held pitch. */
static void seek_while_held_has_no_unheld_blip() {
    const auto in = stereo_tone(1250.0, 2.0, 0.5);
    fresh_chain(true);
    dsp_set_playback_rate(1.25f, 1);
    std::vector<float> out = in;
    const size_t half = out.size() / 2;
    for (size_t pos = 0; pos < half; pos += QUANTUM * 2) dsp_process(out.data() + pos, QUANTUM * 2, 2, RATE, 1.0f);
    dsp_request_reset();
    for (size_t pos = half; pos < out.size(); pos += QUANTUM * 2) dsp_process(out.data() + pos, QUANTUM * 2, 2, RATE, 1.0f);
    const int resetFrame = (int)(half / 2);
    const int latency = dsp_stretch_latency_frames(g_dspStretch);
    const double blip = fit_tone(out, 1250.0, resetFrame, resetFrame + latency).amplitude;
    const ToneTrack after = track_tone(out, 1000.0, resetFrame + latency + RATE / 10, (int)(out.size() / 2));
    std::printf("seek while held: 1250 Hz in the %d-frame latency %.5f; after it %.4f Hz amplitude %.4f\n", latency, blip,
                after.frequency, after.amplitude);
    EXPECT(blip < 0.01, "un-held pitch after a reset: %.5f", blip);
    EXPECT(std::fabs(after.frequency - 1000.0) < STRETCH_MAX_HZ_ERROR, "held tone after reset at %.4f Hz", after.frequency);
    EXPECT(std::fabs(after.amplitude - 0.5) < 0.05, "amplitude after reset %.4f", after.amplitude);
}

static void process_never_allocates() {
    const auto in = stereo_tone(800.0, 4.0, 0.3);
    fresh_chain(true);
    std::vector<float> buf = in;
    const long before = g_allocs;
    const int quanta = (int)(buf.size() / (QUANTUM * 2));
    for (int q = 0; q < quanta; ++q) {
        // A script that crosses every state transition, mid-fade included.
        if (q == 10) dsp_set_playback_rate(1.25f, 1);          // engage
        if (q == 200) dsp_set_playback_rate(1.1f, 1);          // retune
        if (q == 300) dsp_set_playback_rate(0.75f, 1);         // retune below 1
        if (q == 400) dsp_set_playback_rate(1.0f, 1);          // disengage
        if (q == 410) dsp_set_playback_rate(2.0f, 1);          // re-engage mid-fade
        if (q == 600) dsp_request_reset();                     // seek while engaged
        if (q == 700) dsp_set_playback_rate(2.0f, 0);          // hold off: fade to varispeed
        if (q == 800) dsp_set_playback_rate(0.5f, 1);          // hold on again
        if (q == 1000) dsp_set_playback_rate(4.0f, 1);         // extremes
        if (q == 1100) dsp_set_playback_rate(0.25f, 1);
        dsp_process(buf.data() + (size_t)q * QUANTUM * 2, QUANTUM * 2, 2, RATE, 1.0f);
    }
    // Larger quanta (renderSizeHint) go through in DSP_STRETCH_CHUNK_FRAMES pieces.
    dsp_process(buf.data(), 4096 * 2, 2, RATE, 1.0f);
    const long during = g_allocs - before;
    bool finite = true;
    for (float v : buf) finite = finite && std::isfinite(v);
    std::printf("allocations inside dsp_process: %ld\n", during);
    EXPECT(during == 0, "dsp_process allocated %ld times", during);
    EXPECT(finite, "non-finite output");
}

static void heap_budget() {
    const int rates[] = {8000, 22050, 44100, 48000, 88200, 96000, 176400, 192000, 384000};
    long worst = 0;
    int worstChannels = 0, worstRate = 0;
    for (int channels = 1; channels <= DSP_STRETCH_MAX_CHANNELS; ++channels) {
        for (int rate : rates) {
            dsp_stretch_configure(g_dspStretch, 0, 0); // release the previous format first
            const long base = g_liveBytes;
            g_peakBytes = g_liveBytes;
            const int latency = dsp_stretch_configure(g_dspStretch, channels, rate);
            const long peak = g_peakBytes - base;
            const bool supported =
                rate <= DSP_STRETCH_MAX_RATE && (long long)channels * rate <= DSP_STRETCH_MAX_CHANNEL_HZ;
            EXPECT((latency > 0) == supported, "%d ch %d Hz: latency %d, supported %d", channels, rate, latency, supported);
            if (supported) {
                EXPECT(latency == (int)std::lround(0.15 * rate) || std::abs(latency - (int)(0.15 * rate)) <= 2,
                       "%d ch %d Hz: latency %d frames, want ~150 ms", channels, rate, latency);
                if (peak > worst) {
                    worst = peak;
                    worstChannels = channels;
                    worstRate = rate;
                }
            } else {
                EXPECT(peak == 0, "%d ch %d Hz refused but allocated %ld bytes", channels, rate, peak);
            }
        }
    }
    dsp_stretch_configure(g_dspStretch, 0, 0);
    EXPECT(g_liveBytes == 0, "stretcher leaked %ld bytes", g_liveBytes);
    std::printf("stretch heap peak %.1f KiB at %d ch %d Hz (budget %.1f KiB)\n", worst / 1024.0, worstChannels, worstRate,
                DSP_STRETCH_HEAP_BUDGET / 1024.0);
    EXPECT(worst <= (long)DSP_STRETCH_HEAP_BUDGET, "heap peak %ld > budget %zu", worst, DSP_STRETCH_HEAP_BUDGET);
}

int main() {
    unity_is_bypass();
    held_rate_keeps_pitch();
    seek_while_held_has_no_unheld_blip();
    process_never_allocates();
    heap_budget();
    std::puts(g_failures ? "FAIL" : "PASS");
    return g_failures ? 1 : 0;
}
