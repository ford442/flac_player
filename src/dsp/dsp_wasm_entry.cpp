// Thin C exports over src/sdl/dsp_chain.h for the AudioWorklet DSP module
// (public/dsp-chain.{js,wasm}, built by scripts/build-dsp-wasm.sh).
//
// Same object code as the SDL speaker path: ReplayGain -> limiter -> volume ->
// EQ. No SDL, no pthread; the worklet is the only thread that touches state, so
// the atomics in DspParams are uncontended. The setters keep the SDL export
// names (set_eq_band / set_replaygain) so JS pushes DEFAULT_EQ_BANDS the same way.

#include <emscripten/emscripten.h>
#include "../sdl/dsp_chain.h"

// One render quantum is 128 frames today; renderSizeHint may raise it. 4096
// frames x 8 channels covers any quantum the worklet will see.
constexpr int DSP_WASM_SCRATCH_FLOATS = 4096 * DSP_MAX_CHANNELS;
alignas(16) static float g_scratch[DSP_WASM_SCRATCH_FLOATS];

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

}
