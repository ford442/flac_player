// Thin Emscripten ABI over the SpeexDSP resampler (libspeexdsp/resample.c,
// pinned in scripts/build-resampler-wasm.sh). Used by src/audio/resampler.ts
// when the AudioContext cannot open the file's native rate. Stateful, so chunk
// boundaries of the hi-fi stream are seamless.
#include <emscripten.h>
#include "speex/speex_resampler.h"

static spx_uint32_t g_last_consumed = 0;

// quality 0..10 (SPEEX_RESAMPLER_QUALITY_MAX). Returns 0 on failure.
EMSCRIPTEN_KEEPALIVE
SpeexResamplerState* rs_create(int channels, int in_rate, int out_rate, int quality) {
    int err = 0;
    SpeexResamplerState* st = speex_resampler_init((spx_uint32_t)channels, (spx_uint32_t)in_rate,
                                                   (spx_uint32_t)out_rate, quality, &err);
    if (!st || err != RESAMPLER_ERR_SUCCESS) return 0;
    // Drop the filter's leading zeros so output sample 0 aligns with input sample 0.
    speex_resampler_skip_zeros(st);
    return st;
}

// Interleaved f32. Returns frames written; rs_last_consumed() = input frames used.
EMSCRIPTEN_KEEPALIVE
int rs_process(SpeexResamplerState* st, const float* in, int in_frames, float* out, int out_capacity_frames) {
    spx_uint32_t in_len = (spx_uint32_t)in_frames;
    spx_uint32_t out_len = (spx_uint32_t)out_capacity_frames;
    if (speex_resampler_process_interleaved_float(st, in, &in_len, out, &out_len) != RESAMPLER_ERR_SUCCESS) {
        g_last_consumed = 0;
        return -1;
    }
    g_last_consumed = in_len;
    return (int)out_len;
}

EMSCRIPTEN_KEEPALIVE
int rs_last_consumed(void) { return (int)g_last_consumed; }

// Input frames still inside the filter (feed this many zero frames to flush the tail).
EMSCRIPTEN_KEEPALIVE
int rs_input_latency(SpeexResamplerState* st) { return speex_resampler_get_input_latency(st); }

EMSCRIPTEN_KEEPALIVE
void rs_reset(SpeexResamplerState* st) {
    speex_resampler_reset_mem(st);
    speex_resampler_skip_zeros(st);
}

EMSCRIPTEN_KEEPALIVE
void rs_destroy(SpeexResamplerState* st) { speex_resampler_destroy(st); }
