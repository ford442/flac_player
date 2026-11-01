// audio_engine.cpp exports, compiled with host clang: the transport words each
// export writes, as the sdl-engine processor will read them.
//   - a stream starts at the current write position and a seek skips forward
//   - push_pcm scrubs NaN / Inf before the ring sees it
//   - buffered seek clamps to the track; stop goes idle and frees the ring space
//   - the clock and is_drained only trust an epoch the processor acknowledged
//   - cleanup drops the owner, so a live processor retires
#include <cmath>
#include <cstdint>
#include <limits>
#include <vector>
#include "native_test.h"
#include "../../src/sdl/audio_engine.cpp"

// What sdlEngineProcessor.js does when it applies the current epoch.
static void processor_ack() {
    g_engine.framesPlayed.store(0);
    g_engine.drained.store(0);
    g_engine.ackEpoch.store(g_engine.epoch.load());
}

static void stream_start_and_seek() {
    CHECK_EQ(init_audio(), 1);
    std::vector<float> pcm(64, 0.25f);
    // Leftovers from an earlier stream: the next one starts after them.
    CHECK_EQ(push_pcm(pcm.data(), 64), 64);
    const uint32_t epoch0 = g_engine.epoch.load();
    CHECK_EQ(set_stream_format(2, 48000), 1);
    CHECK(g_engine.epoch.load() > epoch0);
    CHECK_EQ(g_engine.mode.load(), (uint32_t)ENGINE_STREAM);
    CHECK_EQ(g_engine.ringStart.load(), 64u);
    CHECK_EQ(g_engine.channels.load(), 2u);

    set_stream_ended(1);
    CHECK_EQ(seek_stream(2.0), 1);
    CHECK_EQ(play_ring_ended(), 0); // a seek reopens the stream
    CHECK_EQ(g_engine.startFrame.load(), 96000u);
    CHECK(get_current_time() == 2.0f); // before the processor applies it
    CHECK_EQ(is_drained(), 0);

    processor_ack();
    g_engine.framesPlayed.store(24000);
    CHECK(get_current_time() == 2.5f);
    g_engine.drained.store(1);
    CHECK_EQ(is_drained(), 1);
    const uint32_t epoch1 = g_engine.epoch.load();
    seek(1.0f); // buffered-only: a no-op in stream mode
    CHECK_EQ(g_engine.epoch.load(), epoch1);
    CHECK_EQ(g_engine.startFrame.load(), 96000u);
    cleanup();
}

static void push_scrubs() {
    CHECK_EQ(init_audio(), 1);
    CHECK_EQ(set_stream_format(2, 44100), 1);
    float pcm[4] = {0.5f, std::numeric_limits<float>::quiet_NaN(), std::numeric_limits<float>::infinity(), -0.5f};
    CHECK_EQ(push_pcm(pcm, 4), 4);
    float out[4] = {};
    CHECK_EQ(play_ring_read_frames(out, 4, 2), 4);
    CHECK(out[0] == 0.5f && out[1] == 0.0f && out[2] == 0.0f && out[3] == -0.5f);
    cleanup();
}

static void buffered_seek_stop() {
    CHECK_EQ(init_audio(), 1);
    float* data = create_audio_buffer(2 * 1000);
    CHECK(data != nullptr);
    for (int i = 0; i < 2000; ++i) data[i] = (i == 7) ? std::numeric_limits<float>::quiet_NaN() : 0.1f;
    CHECK_EQ(set_audio_data(2 * 1000, 2, 1000), 1);
    CHECK(data[7] == 0.0f);
    CHECK_EQ(g_engine.mode.load(), (uint32_t)ENGINE_BUFFERED);
    CHECK_EQ(g_engine.bufferFloats.load(), 2000u);
    CHECK_EQ(set_audio_data(1999, 2, 1000), 0); // length must match the allocation

    seek(0.25f);
    CHECK_EQ(g_engine.startFrame.load(), 250u);
    seek(99.0f);
    CHECK_EQ(g_engine.startFrame.load(), 1000u); // clamped to the end
    CHECK_EQ(seek_stream(1.0), 0);               // stream-only

    play();
    CHECK_EQ(g_engine.playing.load(), 1u);
    std::vector<float> pcm(10, 0.0f);
    push_pcm(pcm.data(), 10);
    stop();
    CHECK_EQ(g_engine.playing.load(), 0u);
    CHECK_EQ(g_engine.mode.load(), (uint32_t)ENGINE_IDLE);
    CHECK_EQ(g_engine.ringStart.load(), play_ring_write_pos()); // the processor skips what was queued
    play();
    CHECK_EQ(g_engine.playing.load(), 0u); // nothing loaded: play is ignored
    CHECK(create_audio_buffer(0) == nullptr);
    cleanup();
}

static void rate_and_owner() {
    CHECK_EQ(init_audio(), 1);
    set_playback_rate(9.0f);
    CHECK(engine_bits_float(g_engine.rateBits.load()) == 4.0f);
    set_playback_rate(std::nanf(""));
    CHECK(engine_bits_float(g_engine.rateBits.load()) == 1.0f);
    set_output_owner(5);
    CHECK_EQ(g_engine.owner.load(), 5u);
    cleanup();
    CHECK_EQ(g_engine.owner.load(), 0u);
    CHECK_EQ(play_ring_capacity(), 0u);
}

int main() {
    stream_start_and_seek();
    push_scrubs();
    buffered_seek_stop();
    rate_and_owner();
    return native_test_result("engine_exports_test");
}
