#pragma once
// Non-finite samples are zeroed where PCM enters the engine (push_pcm,
// set_audio_data), never in the audio callback. dsp_chain.h has no NaN guard:
// one NaN or Inf through a biquad poisons its history, and the band then
// outputs NaN until the next reset.

#include <cstddef>
#include <cstdint>
#include <cstring>

// Replaces every NaN / +-Inf in `samples` with 0. Returns how many were replaced.
inline size_t pcm_scrub_nonfinite(float* samples, size_t count) {
    if (!samples) return 0;
    size_t replaced = 0;
    for (size_t i = 0; i < count; ++i) {
        uint32_t bits;
        std::memcpy(&bits, &samples[i], sizeof bits);
        if ((bits & 0x7f800000u) == 0x7f800000u) {
            samples[i] = 0.0f;
            ++replaced;
        }
    }
    return replaced;
}
