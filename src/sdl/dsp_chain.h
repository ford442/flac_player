#pragma once
// Speaker-path DSP for the SDL3 engine: ReplayGain -> limiter -> volume -> EQ.
//
// Mirrors the Web Audio graph in AudioContextManager.ts (ReplayGainNode ->
// master Gain -> EQChain) so SDL users hear the same EQ / loudness settings.
// Biquad coefficients follow the Web Audio spec (RBJ cookbook; shelves use S = 1
// and ignore Q, exactly like BiquadFilterNode). Band layout is pushed from JS
// (DEFAULT_EQ_BANDS) so there is one source of truth for frequencies and Q.
//
// Threading: setters run on the JS main thread and only write atomics + bump a
// version; dsp_process() runs in the SDL audio callback, recomputes coefficients
// when the version or stream format changes, and never allocates.

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>

enum DspEqType { DSP_EQ_LOWSHELF = 0, DSP_EQ_PEAKING = 1, DSP_EQ_HIGHSHELF = 2 };

constexpr int DSP_EQ_MAX_BANDS = 8;
constexpr int DSP_MAX_CHANNELS = 8;

struct DspBiquadCoeffs {
    double b0 = 1.0, b1 = 0.0, b2 = 0.0, a1 = 0.0, a2 = 0.0; // normalized by a0
};

inline DspBiquadCoeffs dsp_biquad_coeffs(int type, double freq, double q, double gainDb, double sampleRate) {
    DspBiquadCoeffs c;
    if (sampleRate <= 0.0 || freq <= 0.0) return c;
    const double nyquist = sampleRate * 0.5;
    if (freq >= nyquist) freq = nyquist * 0.999;
    const double A = std::pow(10.0, gainDb / 40.0);
    const double w0 = 2.0 * M_PI * freq / sampleRate;
    const double cw = std::cos(w0);
    const double sw = std::sin(w0);
    double b0, b1, b2, a0, a1, a2;

    if (type == DSP_EQ_PEAKING) {
        const double alpha = sw / (2.0 * std::max(q, 1e-4));
        b0 = 1.0 + alpha * A;
        b1 = -2.0 * cw;
        b2 = 1.0 - alpha * A;
        a0 = 1.0 + alpha / A;
        a1 = -2.0 * cw;
        a2 = 1.0 - alpha / A;
    } else {
        // Web Audio shelves: alpha = sin(w0)/2 * sqrt((A + 1/A)(1/S - 1) + 2), S = 1.
        const double alpha = sw / 2.0 * std::sqrt(2.0);
        const double k = 2.0 * std::sqrt(A) * alpha;
        if (type == DSP_EQ_LOWSHELF) {
            b0 = A * ((A + 1.0) - (A - 1.0) * cw + k);
            b1 = 2.0 * A * ((A - 1.0) - (A + 1.0) * cw);
            b2 = A * ((A + 1.0) - (A - 1.0) * cw - k);
            a0 = (A + 1.0) + (A - 1.0) * cw + k;
            a1 = -2.0 * ((A - 1.0) + (A + 1.0) * cw);
            a2 = (A + 1.0) + (A - 1.0) * cw - k;
        } else {
            b0 = A * ((A + 1.0) + (A - 1.0) * cw + k);
            b1 = -2.0 * A * ((A - 1.0) + (A + 1.0) * cw);
            b2 = A * ((A + 1.0) + (A - 1.0) * cw - k);
            a0 = (A + 1.0) - (A - 1.0) * cw + k;
            a1 = 2.0 * ((A - 1.0) - (A + 1.0) * cw);
            a2 = (A + 1.0) - (A - 1.0) * cw - k;
        }
    }
    c.b0 = b0 / a0;
    c.b1 = b1 / a0;
    c.b2 = b2 / a0;
    c.a1 = a1 / a0;
    c.a2 = a2 / a0;
    return c;
}

struct DspParams {
    std::atomic<int> type[DSP_EQ_MAX_BANDS];
    std::atomic<float> freq[DSP_EQ_MAX_BANDS];
    std::atomic<float> q[DSP_EQ_MAX_BANDS];
    std::atomic<float> gainDb[DSP_EQ_MAX_BANDS];
    std::atomic<int> bandCount{0};
    std::atomic<float> replayGain{1.0f};
    std::atomic<int> limiter{0};
    std::atomic<uint32_t> version{1};
    std::atomic<uint32_t> resetVersion{0};

    DspParams() {
        for (int i = 0; i < DSP_EQ_MAX_BANDS; ++i) {
            type[i].store(DSP_EQ_PEAKING);
            freq[i].store(1000.0f);
            q[i].store(1.0f);
            gainDb[i].store(0.0f);
        }
    }
};

struct DspState {
    DspBiquadCoeffs coeffs[DSP_EQ_MAX_BANDS];
    bool bandActive[DSP_EQ_MAX_BANDS] = {};
    // Transposed direct form II state per band per channel.
    double z1[DSP_EQ_MAX_BANDS][DSP_MAX_CHANNELS] = {};
    double z2[DSP_EQ_MAX_BANDS][DSP_MAX_CHANNELS] = {};
    int bands = 0;
    uint32_t appliedVersion = 0;
    uint32_t appliedResetVersion = 0;
    int sampleRate = 0;
    int channels = 0;
    int channelPos = 0; // interleave position carried across callbacks
    double limiterEnvDb = 0.0; // current gain reduction (<= 0 dB)
    double attackCoeff = 0.0;
    double releaseCoeff = 0.0;
};

inline DspParams g_dspParams;
inline DspState g_dspState;

// Matches ReplayGainNode.setLimiterEnabled(true): threshold -1 dBFS, ratio 20,
// knee 0, attack 3 ms, release 100 ms. No makeup gain.
constexpr double DSP_LIMITER_THRESHOLD_DB = -1.0;
constexpr double DSP_LIMITER_RATIO = 20.0;
constexpr double DSP_LIMITER_ATTACK_S = 0.003;
constexpr double DSP_LIMITER_RELEASE_S = 0.1;

inline void dsp_set_eq_band(int index, int type, float freq, float q, float gainDb) {
    if (index < 0 || index >= DSP_EQ_MAX_BANDS) return;
    g_dspParams.type[index].store(type);
    g_dspParams.freq[index].store(freq);
    g_dspParams.q[index].store(q);
    g_dspParams.gainDb[index].store(std::max(-12.0f, std::min(12.0f, gainDb)));
    int count = g_dspParams.bandCount.load();
    if (index + 1 > count) g_dspParams.bandCount.store(index + 1);
    g_dspParams.version.fetch_add(1);
}

inline void dsp_set_replaygain(float linear, int limiterEnabled) {
    g_dspParams.replayGain.store(std::max(0.0f, linear));
    g_dspParams.limiter.store(limiterEnabled ? 1 : 0);
}

/** Clear filter/limiter history (seek, stop, new stream). Safe from any thread. */
inline void dsp_request_reset() {
    g_dspParams.resetVersion.fetch_add(1);
}

inline void dsp_refresh(DspState& s, int channels, int sampleRate) {
    const uint32_t version = g_dspParams.version.load();
    const uint32_t resetVersion = g_dspParams.resetVersion.load();
    const bool formatChanged = s.sampleRate != sampleRate || s.channels != channels;

    if (formatChanged || resetVersion != s.appliedResetVersion) {
        for (int b = 0; b < DSP_EQ_MAX_BANDS; ++b) {
            for (int ch = 0; ch < DSP_MAX_CHANNELS; ++ch) {
                s.z1[b][ch] = 0.0;
                s.z2[b][ch] = 0.0;
            }
        }
        s.channelPos = 0;
        s.limiterEnvDb = 0.0;
        s.appliedResetVersion = resetVersion;
    }

    if (formatChanged || version != s.appliedVersion) {
        s.sampleRate = sampleRate;
        s.channels = channels;
        s.bands = std::min(g_dspParams.bandCount.load(), DSP_EQ_MAX_BANDS);
        for (int b = 0; b < s.bands; ++b) {
            const float gain = g_dspParams.gainDb[b].load();
            // 0 dB peaking/shelf is an identity filter; skip it and keep its history clean.
            const bool active = std::fabs(gain) > 1e-3f;
            if (!active && s.bandActive[b]) {
                for (int ch = 0; ch < DSP_MAX_CHANNELS; ++ch) {
                    s.z1[b][ch] = 0.0;
                    s.z2[b][ch] = 0.0;
                }
            }
            s.bandActive[b] = active;
            s.coeffs[b] = dsp_biquad_coeffs(
                g_dspParams.type[b].load(),
                g_dspParams.freq[b].load(),
                g_dspParams.q[b].load(),
                gain,
                (double)sampleRate);
        }
        if (sampleRate > 0) {
            s.attackCoeff = std::exp(-1.0 / (DSP_LIMITER_ATTACK_S * sampleRate));
            s.releaseCoeff = std::exp(-1.0 / (DSP_LIMITER_RELEASE_S * sampleRate));
        }
        s.appliedVersion = version;
    }
}

/**
 * In-place speaker DSP on interleaved f32. `samples` must be a scratch copy,
 * never the buffered source PCM. `numFloats` need not be frame-aligned.
 */
inline void dsp_process(float* samples, int numFloats, int channels, int sampleRate, float volume) {
    if (numFloats <= 0 || channels <= 0) return;
    channels = std::min(channels, DSP_MAX_CHANNELS);
    DspState& s = g_dspState;
    dsp_refresh(s, channels, sampleRate);

    const double preGain = g_dspParams.replayGain.load();
    const bool limiter = g_dspParams.limiter.load() != 0;
    const double vol = volume;
    int ch = s.channelPos;

    for (int i = 0; i < numFloats; ++i) {
        double x = samples[i] * preGain;

        if (limiter) {
            // Channel-linked envelope: every sample of every channel drives one detector.
            const double peak = std::fabs(x);
            double targetDb = 0.0;
            if (peak > 1e-9) {
                const double levelDb = 20.0 * std::log10(peak);
                const double over = levelDb - DSP_LIMITER_THRESHOLD_DB;
                if (over > 0.0) targetDb = -over * (1.0 - 1.0 / DSP_LIMITER_RATIO);
            }
            const double coeff = targetDb < s.limiterEnvDb ? s.attackCoeff : s.releaseCoeff;
            s.limiterEnvDb = targetDb + coeff * (s.limiterEnvDb - targetDb);
            if (s.limiterEnvDb < -1e-6) x *= std::pow(10.0, s.limiterEnvDb / 20.0);
        }

        x *= vol;

        for (int b = 0; b < s.bands; ++b) {
            if (!s.bandActive[b]) continue;
            const DspBiquadCoeffs& c = s.coeffs[b];
            const double y = c.b0 * x + s.z1[b][ch];
            s.z1[b][ch] = c.b1 * x - c.a1 * y + s.z2[b][ch];
            s.z2[b][ch] = c.b2 * x - c.a2 * y;
            x = y;
        }

        samples[i] = (float)x;
        if (++ch >= channels) ch = 0;
    }
    s.channelPos = ch;
}
