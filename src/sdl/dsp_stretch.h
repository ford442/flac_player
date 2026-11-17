#pragma once
// Pitch hold for the speed control, a stage of dsp_chain.h (after the limiter
// and volume, before EQ, so EQ shapes what is heard).
//
// Every source the chain hears plays varispeed: BufferSourceNode.playbackRate,
// the flac worklet and the `sdl` engine all read their PCM at `rate` frames per
// output frame, so tempo and pitch move together. A Web Audio node gets as many
// frames out as in, so the time-stretch cannot happen here; the pitch shift
// can. With pitch held, this stage transposes by 1/rate at a 1:1 time ratio:
// tempo stays at `rate`, pitch returns to the original. That is the time ratio
// 1/rate at pitch ratio 1 the speed control asks for, split between the source
// and the chain. Varispeed (pitch held off) leaves the stage bypassed.
//
// Engine: Signalsmith Stretch 1.4.0 + Signalsmith Linear 0.6.4 (MIT, header
// only, fetched pinned by scripts/dsp-third-party.sh), default preset (120 ms
// block, 30 ms interval) with split computation, so the spectral work is spread
// over the interval instead of landing in one render quantum. That adds one
// interval of latency: 150 ms in total while engaged, reported by
// dsp_stretch_latency_frames(). The engine has no hand-written SIMD; -msimd128
// auto-vectorizes it like the rest of the module.
//
// Memory: dsp_stretch_configure() is the only function that allocates. The
// worklet calls it from its constructor for the graph's fixed format (channel
// count and context rate never change for one processor), so dsp_process never
// allocates and never sizes anything. A dsp_process() at another format leaves
// the stage bypassed. Formats above DSP_STRETCH_MAX_CHANNEL_HZ or
// DSP_STRETCH_MAX_RATE are refused (the speed control stays varispeed there);
// within them the stretcher needs less than DSP_STRETCH_HEAP_BUDGET
// (tests/native/dsp_stretch_golden.cpp measures it on wasm32).
//
// Engaging (1.0× → held rate) primes the stretcher with the last seekLength()
// frames of input and crossfades over DSP_STRETCH_FADE_S; disengaging crossfades
// back. Each costs one seam of roughly the stretch latency (a short repeat when
// engaging, a skip when leaving). Engaging within one latency of a reset (a
// seek, a new stream, the first quantum) has no history worth fading from, so it
// starts on the stretched signal: the latency is a short silence, never a blip
// of the un-held pitch. Rate changes while engaged only retune the transpose;
// they never reset the stretch window.
//
// Threading: like dsp_chain.h, everything after configure runs on the one
// audio thread.

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <new>
#include <vector>

#include "signalsmith-stretch.h"

constexpr int DSP_STRETCH_MAX_CHANNELS = 8;
/** Largest channels × Hz pitch hold runs at: stereo 192 kHz, or 8 channels at 48 kHz. */
constexpr int DSP_STRETCH_MAX_CHANNEL_HZ = 2 * 192000;
/** And no faster context than this (the window, so the heap, grows with the rate alone too). */
constexpr int DSP_STRETCH_MAX_RATE = 192000;
/** Heap the stretcher (engine + history) may take at the cap; INITIAL_MEMORY is sized from it. */
constexpr size_t DSP_STRETCH_HEAP_BUDGET = (size_t)4608 * 1024;
/** Frames per engine call: the stage copies its input here because the engine cannot run in place. */
constexpr int DSP_STRETCH_CHUNK_FRAMES = 1024;
/** Crossfade between bypass and the stretched signal on engage / disengage. */
constexpr double DSP_STRETCH_FADE_S = 0.064;
/** A rate this close to 1 is 1: the stage stays bypassed (bit-identical output). */
constexpr float DSP_STRETCH_UNITY_EPSILON = 1e-4f;

struct DspStretch {
    using Engine = signalsmith::stretch::SignalsmithStretch<float>;

    // The engine lives in raw storage so a reconfigure can destroy it (freeing
    // every buffer) before the next format allocates: peak heap is one format.
    alignas(Engine) unsigned char storage[sizeof(Engine)];
    bool constructed = false;
    int channels = 0;
    int sampleRate = 0;
    int latencyFrames = 0;
    int fadeFrames = 1;

    /** Last seekLength() frames of stage input, interleaved ring (priming on engage). */
    std::vector<float> history;
    size_t historyPos = 0; // next float to write

    /** True while the engine runs (engaged, or fading either way); it restarts clean when it stops. */
    bool running = false;
    /** Share of the stretched signal in the output, 0..1. */
    double mix = 0.0;
    float transpose = 1.0f;
    /** Interleave position at the stage input, carried across calls. */
    int channelPos = 0;
    /** Frames remembered since the last reset, saturating at latencyFrames. */
    int framesSinceReset = 0;

    alignas(16) float in[DSP_STRETCH_CHUNK_FRAMES * DSP_STRETCH_MAX_CHANNELS];

    Engine& engine() { return *std::launder(reinterpret_cast<Engine*>(storage)); }
};

inline DspStretch g_dspStretch;

/** Channel-indexed view of interleaved floats (`view[c][i]`), as the engine expects. */
struct DspStretchInterleaved {
    float* data;
    int channels;
    struct Channel {
        float* data;
        int stride;
        float& operator[](int i) const { return data[(size_t)i * (size_t)stride]; }
    };
    Channel operator[](int c) const { return Channel{data + c, channels}; }
};

/** The history ring, oldest frame first. */
struct DspStretchHistory {
    const DspStretch* st;
    struct Channel {
        const DspStretch* st;
        int c;
        float operator[](int i) const {
            const size_t n = st->history.size();
            return st->history[(st->historyPos + (size_t)i * (size_t)st->channels + (size_t)c) % n];
        }
    };
    Channel operator[](int c) const { return Channel{st, c}; }
};

inline bool dsp_stretch_format_supported(int channels, int sampleRate) {
    return channels > 0 && channels <= DSP_STRETCH_MAX_CHANNELS && sampleRate >= 8000
        && sampleRate <= DSP_STRETCH_MAX_RATE && (long long)channels * sampleRate <= DSP_STRETCH_MAX_CHANNEL_HZ;
}

/**
 * Size the stretcher for the stream format (allocates; never call it from the
 * audio callback). Returns the stretch latency in frames, or 0 when pitch hold
 * is unavailable at this format (the stage then stays bypassed).
 */
inline int dsp_stretch_configure(DspStretch& st, int channels, int sampleRate) {
    if (st.constructed && st.channels == channels && st.sampleRate == sampleRate) return st.latencyFrames;
    if (st.constructed) {
        using Engine = DspStretch::Engine;
        st.engine().~Engine();
        st.constructed = false;
    }
    std::vector<float>().swap(st.history);
    st.channels = 0;
    st.sampleRate = 0;
    st.latencyFrames = 0;
    st.running = false;
    st.mix = 0.0;
    st.channelPos = 0;
    st.framesSinceReset = 0;
    if (!dsp_stretch_format_supported(channels, sampleRate)) return 0;

    // Fixed seed: std::random_device would import WASI entropy, and the phase
    // randomisation it feeds only runs above a 2× time ratio (never here).
    new (st.storage) DspStretch::Engine(1);
    st.constructed = true;
    DspStretch::Engine& engine = st.engine();
    engine.presetDefault(channels, (float)sampleRate, /*splitComputation=*/true);
    st.channels = channels;
    st.sampleRate = sampleRate;
    st.latencyFrames = engine.inputLatency() + engine.outputLatency();
    st.fadeFrames = std::max(1, (int)std::lround(DSP_STRETCH_FADE_S * sampleRate));
    st.history.assign((size_t)engine.seekLength() * (size_t)channels, 0.0f);
    st.historyPos = 0;
    st.transpose = 1.0f;
    engine.setTransposeFactor(1.0f);
    return st.latencyFrames;
}

inline int dsp_stretch_latency_frames(const DspStretch& st) {
    return st.constructed ? st.latencyFrames : 0;
}

/** True while the stretched signal is (part of) the output. */
inline bool dsp_stretch_engaged(const DspStretch& st) {
    return st.running;
}

/** Clear history and drop the running engine (seek, stop, new stream). No allocation. */
inline void dsp_stretch_reset(DspStretch& st) {
    std::fill(st.history.begin(), st.history.end(), 0.0f);
    st.historyPos = 0;
    st.running = false;
    st.mix = 0.0;
    st.channelPos = 0;
    st.framesSinceReset = 0;
}

inline void dsp_stretch_remember(DspStretch& st, const float* samples, int numFloats) {
    const size_t n = st.history.size();
    if (n == 0) return;
    if (st.framesSinceReset < st.latencyFrames)
        st.framesSinceReset = std::min(st.latencyFrames, st.framesSinceReset + numFloats / std::max(1, st.channels));
    if ((size_t)numFloats >= n) {
        // Only the newest n floats survive; keep the ring phase as if all were written.
        const float* tail = samples + (numFloats - (int)n);
        st.historyPos = (st.historyPos + (size_t)numFloats) % n;
        for (size_t i = 0; i < n; ++i) st.history[(st.historyPos + i) % n] = tail[i];
        return;
    }
    for (int i = 0; i < numFloats; ++i) {
        st.history[st.historyPos] = samples[i];
        if (++st.historyPos == n) st.historyPos = 0;
    }
}

/**
 * The stage, in place on interleaved f32. `rate` is the source's varispeed rate
 * (0.25..4) and `hold` asks for the original pitch. Bypassed (output untouched)
 * at rate 1, without hold, at an unconfigured format, or for a call that is not
 * whole frames. Never allocates.
 */
inline void dsp_stretch_process(DspStretch& st, float* samples, int numFloats, int channels, int sampleRate,
                                float rate, bool hold) {
    if (numFloats <= 0) return;
    const bool configured = st.constructed && st.channels == channels && st.sampleRate == sampleRate;
    if (!configured) return;
    const bool aligned = st.channelPos == 0 && numFloats % channels == 0;
    if (!aligned) {
        // Not whole frames (the worklet never does this): hard bypass, restart later.
        dsp_stretch_remember(st, samples, numFloats);
        st.channelPos = (st.channelPos + numFloats) % channels;
        st.running = false;
        st.mix = 0.0;
        return;
    }

    if (!(rate > 0.0f) || !std::isfinite(rate)) rate = 1.0f;
    const bool want = hold && std::fabs(rate - 1.0f) > DSP_STRETCH_UNITY_EPSILON;
    if (!st.running && !want) {
        dsp_stretch_remember(st, samples, numFloats);
        return;
    }

    DspStretch::Engine& engine = st.engine();
    if (!st.running) {
        // Engage: a clean engine primed with the recent input (seek only copies,
        // no spectral work), faded in from the bypass signal, or straight in
        // right after a reset (nothing before it to fade from).
        engine.reset();
        engine.seek(DspStretchHistory{&st}, engine.seekLength(), 1.0);
        st.running = true;
        st.mix = st.framesSinceReset < st.latencyFrames ? 1.0 : 0.0;
    }
    const float transpose = 1.0f / rate;
    if (transpose != st.transpose) {
        st.transpose = transpose;
        engine.setTransposeFactor(transpose);
    }

    const double target = want ? 1.0 : 0.0;
    const double step = 1.0 / st.fadeFrames;
    const int frames = numFloats / channels;
    for (int start = 0; start < frames;) {
        float* out = samples + (size_t)start * (size_t)channels;
        if (!st.running) {
            // Faded out earlier in this call: the rest is bypass.
            dsp_stretch_remember(st, out, (frames - start) * channels);
            break;
        }
        const int n = std::min(DSP_STRETCH_CHUNK_FRAMES, frames - start);
        const int count = n * channels;
        std::copy(out, out + count, st.in);
        dsp_stretch_remember(st, st.in, count);
        engine.process(DspStretchInterleaved{st.in, channels}, n, DspStretchInterleaved{out, channels}, n);

        if (st.mix == target && target == 1.0) {
            start += n;
            continue;
        }
        for (int f = 0; f < n; ++f) {
            if (st.mix < target) st.mix = std::min(target, st.mix + step);
            else if (st.mix > target) st.mix = std::max(target, st.mix - step);
            // Equal power: the two signals are a stretch-latency apart, so uncorrelated.
            const double wet = std::sin(st.mix * (M_PI / 2.0));
            const double dry = std::cos(st.mix * (M_PI / 2.0));
            float* o = out + (size_t)f * (size_t)channels;
            const float* d = st.in + (size_t)f * (size_t)channels;
            for (int c = 0; c < channels; ++c) o[c] = (float)(dry * d[c] + wet * o[c]);
        }
        start += n;
        if (st.mix == 0.0 && target == 0.0) st.running = false;
    }
}
