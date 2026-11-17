// Thin C exports over src/sdl/dsp_chain.h for the AudioWorklet DSP module
// (public/dsp-chain.{js,wasm}, built by scripts/build-dsp-wasm.sh), plus the
// src/sdl/dsp_fft.h spectrum and src/sdl/dsp_loudness.h meter for main-thread
// analysis instances (src/audio/wasmFft.ts, src/audio/loudnessMeter.ts).
//
// ReplayGain -> limiter -> volume -> pitch hold -> EQ for every backend (the
// `sdl` engine plays into the same graph since #268). No pthread; the worklet
// is the only thread that touches state, so the atomics in DspParams are
// uncontended. An instance is either the worklet's (process, stretch) or a
// main-thread analysis instance (fft_spectrum, loudness_*), never both.

#include <emscripten/emscripten.h>
#include "../sdl/dsp_chain.h"
#include "../sdl/dsp_fft.h"
#include "../sdl/dsp_loudness.h"

// One render quantum is 128 frames today; renderSizeHint may raise it. 4096
// frames x 8 channels covers any quantum the worklet will see.
constexpr int DSP_WASM_SCRATCH_FLOATS = 4096 * DSP_MAX_CHANNELS;
alignas(16) static float g_scratch[DSP_WASM_SCRATCH_FLOATS];
alignas(16) static float g_fftOut[DSP_FFT_MAX_BINS];

extern "C" {

/** Interleaved f32 scratch the worklet fills before calling process(). */
EMSCRIPTEN_KEEPALIVE
float* scratch_ptr() { return g_scratch; }

EMSCRIPTEN_KEEPALIVE
int scratch_floats() { return DSP_WASM_SCRATCH_FLOATS; }

EMSCRIPTEN_KEEPALIVE
void set_eq_band(int index, int type, float freq, float q, float gainDb) {
    dsp_set_eq_band(index, type, freq, q, gainDb);
}

EMSCRIPTEN_KEEPALIVE
void set_replaygain(float linear, int limiterEnabled) {
    dsp_set_replaygain(linear, limiterEnabled);
}

EMSCRIPTEN_KEEPALIVE
void request_reset() { dsp_request_reset(); }

/**
 * Varispeed rate of the source and whether the chain holds the pitch
 * (dsp_set_playback_rate). Cheap; never resets the stretch window.
 */
EMSCRIPTEN_KEEPALIVE
void set_playback_rate(float rate, int preservePitch) { dsp_set_playback_rate(rate, preservePitch); }

/**
 * Size the pitch-hold stretcher for the processor's fixed format. The only
 * call that allocates: the worklet makes it from its constructor, never from
 * process(). Returns the stretch latency in frames, 0 when pitch hold is
 * unavailable at this format (dsp_stretch.h DSP_STRETCH_MAX_CHANNEL_HZ).
 */
EMSCRIPTEN_KEEPALIVE
int configure_stretch(int channels, int sampleRate) {
    return dsp_stretch_configure(g_dspStretch, channels, sampleRate);
}

/** 1 while the stretched signal is (part of) the output. */
EMSCRIPTEN_KEEPALIVE
int stretch_engaged() { return dsp_stretch_engaged(g_dspStretch) ? 1 : 0; }

/** dsp_process() on the first `numFloats` of scratch (interleaved, in place). */
EMSCRIPTEN_KEEPALIVE
void process(int numFloats, int channels, int sampleRate, float volume) {
    if (numFloats > DSP_WASM_SCRATCH_FLOATS) numFloats = DSP_WASM_SCRATCH_FLOATS;
    dsp_process(g_scratch, numFloats, channels, sampleRate, volume);
}

/** `fft_spectrum` HUD bins written by fft_spectrum() (DSP_FFT_MAX_BINS floats). */
EMSCRIPTEN_KEEPALIVE
float* fft_out_ptr() { return g_fftOut; }

/** N/2 normalized magnitude lines from the last fft_spectrum() call. */
EMSCRIPTEN_KEEPALIVE
float* fft_lines_ptr() { return g_dspFft.lines; }

/**
 * dsp_fft_spectrum() over the first `numFloats` of scratch (interleaved,
 * read-only). Writes `bins` (clamped 1..4096, default 64) to fft_out_ptr() and
 * returns the effective FFT size. `simd` = 0 forces the scalar stages (golden test).
 * Main-thread analysis instances only — never the worklet instance mid-quantum.
 */
EMSCRIPTEN_KEEPALIVE
int fft_spectrum(int numFloats, int channels, int fftSize, int bins, int simd) {
    if (numFloats > DSP_WASM_SCRATCH_FLOATS) numFloats = DSP_WASM_SCRATCH_FLOATS;
    if (numFloats < 0) numFloats = 0;
    return dsp_fft_spectrum(g_scratch, numFloats, channels, fftSize, g_fftOut,
                            dsp_fft_clamp_bins(bins, 64), simd != 0);
}

static DspLoudness g_loudness;

/** Start a loudness measurement (clears history) for this interleave and rate. */
EMSCRIPTEN_KEEPALIVE
void loudness_reset(int channels, int sampleRate) { dsp_loudness_reset(g_loudness, channels, sampleRate); }

/** Feed the first `numFloats` of scratch (interleaved, read-only) to the meter. */
EMSCRIPTEN_KEEPALIVE
void loudness_push(int numFloats) {
    if (numFloats > DSP_WASM_SCRATCH_FLOATS) numFloats = DSP_WASM_SCRATCH_FLOATS;
    if (numFloats > 0) dsp_loudness_push(g_loudness, g_scratch, numFloats);
}

/** Momentary loudness (400 ms), LUFS; NaN until 400 ms arrived, -Infinity for silence. */
EMSCRIPTEN_KEEPALIVE
double loudness_momentary() { return dsp_loudness_momentary(g_loudness); }

/** Short-term loudness (3 s), LUFS; NaN until 3 s arrived, -Infinity for silence. */
EMSCRIPTEN_KEEPALIVE
double loudness_short_term() { return dsp_loudness_short_term(g_loudness); }

}
