#pragma once
// The audio callback's drain step, without SDL, so tests/native can build it
// with the host compiler.
//
// SDL asks for `additional_amount` bytes. play_fill() pulls whole frames from
// the play ring (stream mode) or the buffered PCM into a fixed scratch block,
// hands each block to `sink` (DSP, taps, SDL_PutAudioStreamData), and repeats
// until the request is covered or the source runs dry. Every block is a
// multiple of `channels`: SDL rejects a put that is not frame-sized, and a
// rejected partial frame used to shift every later sample by a channel (5.1 /
// 7.1 with an 8192-float scratch went silent or clicked).

#include <algorithm>
#include <cstddef>
#include <cstring>
#include "play_ring.h"

struct PlayFillSource {
    const float* buffer = nullptr; // nullptr: read the play ring
    size_t length = 0;             // buffered floats
    size_t head = 0;               // buffered read index (floats), advanced by play_fill
};

// Whole frames needed to cover `floatsWanted` (rounded up: SDL queues extra data).
inline int play_fill_frames_wanted(int floatsWanted, int channels) {
    if (floatsWanted <= 0 || channels <= 0) return 0;
    return (floatsWanted + channels - 1) / channels;
}

// Fills `scratch` (scratchFloats long) block by block and calls
// sink(scratch, floats) for each; sink returns false to stop early (SDL refused
// the data). Returns the floats taken from the source, all whole frames.
template <typename Sink>
inline int play_fill(float* scratch, int scratchFloats, int channels, int floatsWanted,
                     PlayFillSource& source, Sink&& sink) {
    if (!scratch || channels <= 0) return 0;
    const int scratchFrames = scratchFloats / channels;
    int framesLeft = play_fill_frames_wanted(floatsWanted, channels);
    int taken = 0;
    while (framesLeft > 0 && scratchFrames > 0) {
        const int blockFloats = std::min(framesLeft, scratchFrames) * channels;
        int got = 0;
        if (source.buffer) {
            const size_t remaining = source.length > source.head ? source.length - source.head : 0;
            const size_t wholeFrames = remaining / static_cast<size_t>(channels);
            got = static_cast<int>(std::min(static_cast<size_t>(blockFloats),
                                            wholeFrames * static_cast<size_t>(channels)));
            if (got > 0) {
                std::memcpy(scratch, source.buffer + source.head, static_cast<size_t>(got) * sizeof(float));
                source.head += static_cast<size_t>(got);
            }
        } else {
            got = play_ring_read_frames(scratch, blockFloats, channels);
        }
        if (got <= 0) break;
        taken += got;
        framesLeft -= got / channels;
        if (!sink(scratch, got)) break;
    }
    return taken;
}

// Buffered PCM is exhausted once less than one whole frame is left (a trailing
// partial frame can never be played).
inline bool play_fill_buffer_done(const PlayFillSource& source, int channels) {
    return channels <= 0 || source.length < source.head + static_cast<size_t>(channels);
}
