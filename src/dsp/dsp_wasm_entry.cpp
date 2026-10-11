// Thin C exports over src/sdl/dsp_chain.h for the AudioWorklet DSP module
// (public/dsp-chain.{js,wasm}, built by scripts/build-dsp-wasm.sh), plus the
// src/sdl/dsp_fft.h spectrum for main-thread analysis (src/audio/wasmFft.ts).
//
// Same object code as the SDL speaker path: ReplayGain -> limiter -> volume ->
// EQ. No SDL, no pthread; the worklet is the only thread that touches state, so
// the atomics in DspParams are uncontended. The setters keep the SDL export
// names (set_eq_band / set_replaygain) so JS pushes DEFAULT_EQ_BANDS the same way.

#include <emscripten/emscripten.h>
#include "../sdl/dsp_chain.h"
#include "../sdl/dsp_fft.h"

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

}
