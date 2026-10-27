// play_fill.h: the audio callback's drain step.
//   - every block handed to the sink is whole frames and fits the scratch
//     (the engine's 8192-float scratch holds 1365 frames of 5.1, not 8192/6)
//   - a request larger than the scratch is served by several blocks
//   - channels never rotate: sample (frame, ch) arrives as frame * 16 + ch
//   - buffered PCM with a trailing partial frame ends after the last whole frame
//   - a sink that refuses (SDL put failed) stops the loop
#include <vector>
#include "native_test.h"
#include "../../src/sdl/play_fill.h"

static float coded(int frame, int ch) { return static_cast<float>(frame * 16 + ch); }

static std::vector<float> frames_of(int frames, int channels) {
    std::vector<float> v(static_cast<size_t>(frames * channels));
    for (int f = 0; f < frames; ++f)
        for (int c = 0; c < channels; ++c) v[static_cast<size_t>(f * channels + c)] = coded(f, c);
    return v;
}

struct Collect {
    int channels;
    int scratchFloats;
    int blocks = 0;
    int nextFrame = 0;
    bool ok = true;
    bool operator()(const float* block, int floats) {
        ++blocks;
        if (floats % channels != 0 || floats > scratchFloats) ok = false;
        for (int i = 0; i < floats; ++i) {
            if (block[i] != coded(nextFrame, i % channels)) ok = false;
            if (i % channels == channels - 1) ++nextFrame;
        }
        return true;
    }
};

static void ring_multichannel(int channels) {
    constexpr int kScratch = 8192;
    play_ring_init(1u << 16);
    const int frames = 30000 / channels; // 30000 floats: more than the 20000 asked for below
    std::vector<float> pcm = frames_of(frames, channels);
    CHECK_EQ(play_ring_push(pcm.data(), static_cast<int>(pcm.size())), static_cast<int>(pcm.size()));

    std::vector<float> scratch(kScratch);
    PlayFillSource ring;
    Collect sink{channels, kScratch};
    // 20000 floats is not a multiple of 6 or 8 and needs more than one scratch block.
    const int taken = play_fill(scratch.data(), kScratch, channels, 20000, ring, sink);
    CHECK(sink.ok);
    CHECK_EQ(taken, play_fill_frames_wanted(20000, channels) * channels);
    CHECK(sink.blocks >= 2);
    CHECK_EQ(taken % channels, 0);

    // Ask for more than is buffered: whole frames only, then nothing.
    const int rest = play_fill(scratch.data(), kScratch, channels, 1 << 20, ring, sink);
    CHECK(sink.ok);
    CHECK_EQ(taken + rest, frames * channels);
    CHECK_EQ(play_fill(scratch.data(), kScratch, channels, 1 << 20, ring, sink), 0);
    play_ring_cleanup();
}

static void ring_partial_tail() {
    play_ring_init(1u << 12);
    std::vector<float> pcm = frames_of(10, 6);
    CHECK_EQ(play_ring_push(pcm.data(), 63), 63); // 10 frames + 3 floats of the 11th
    std::vector<float> scratch(8192);
    PlayFillSource ring;
    Collect sink{6, 8192};
    CHECK_EQ(play_fill(scratch.data(), 8192, 6, 600, ring, sink), 60);
    CHECK(sink.ok);
    CHECK_EQ(play_ring_fill(), 3u);
    play_ring_cleanup();
}

static void buffered_trailing_partial_frame() {
    constexpr int kChannels = 6;
    std::vector<float> pcm = frames_of(100, kChannels);
    pcm.push_back(1.0f);
    pcm.push_back(2.0f);
    pcm.push_back(3.0f);
    PlayFillSource buffered;
    buffered.buffer = pcm.data();
    buffered.length = pcm.size();
    std::vector<float> scratch(256); // 42 frames of 6 per block
    Collect sink{kChannels, 256};
    CHECK_EQ(play_fill(scratch.data(), 256, kChannels, 4000, buffered, sink), 600);
    CHECK(sink.ok);
    CHECK_EQ(buffered.head, static_cast<size_t>(600));
    CHECK(play_fill_buffer_done(buffered, kChannels));
    CHECK_EQ(play_fill(scratch.data(), 256, kChannels, 4000, buffered, sink), 0);
}

static void refusing_sink_stops() {
    std::vector<float> pcm = frames_of(1000, 2);
    PlayFillSource buffered;
    buffered.buffer = pcm.data();
    buffered.length = pcm.size();
    std::vector<float> scratch(64);
    int calls = 0;
    auto refuse = [&calls](const float*, int) { ++calls; return false; };
    CHECK_EQ(play_fill(scratch.data(), 64, 2, 2000, buffered, refuse), 64);
    CHECK_EQ(calls, 1);
    CHECK_EQ(buffered.head, static_cast<size_t>(64));
}

static void degenerate() {
    std::vector<float> scratch(4);
    PlayFillSource ring;
    auto never = [](const float*, int) { return true; };
    CHECK_EQ(play_fill(scratch.data(), 4, 6, 100, ring, never), 0); // scratch smaller than a frame
    CHECK_EQ(play_fill(scratch.data(), 4, 0, 100, ring, never), 0);
    CHECK_EQ(play_fill_frames_wanted(1, 6), 1);
    CHECK_EQ(play_fill_frames_wanted(0, 6), 0);
}

int main() {
    for (int channels : {1, 2, 6, 8}) ring_multichannel(channels);
    ring_partial_tail();
    buffered_trailing_partial_frame();
    refusing_sink_stops();
    degenerate();
    return native_test_result("play_fill_test");
}
