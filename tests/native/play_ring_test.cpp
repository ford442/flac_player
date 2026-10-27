// play_ring.h: the SPSC ring between push_pcm and the audio callback.
//   - a running counter pushed in uneven chunks comes back in order across many
//     seams, read in whole frames, for 1/2/6/8 channels
//   - the same with positions about to wrap at 2^32 (needs a power-of-two capacity)
//   - a trailing partial frame is left for the producer to complete
//   - full ring, non-power-of-two capacity
#include <cstdint>
#include <vector>
#include "native_test.h"
#include "../../src/sdl/play_ring.h"

static void set_positions(uint32_t pos) {
    g_playRing.writePos.store(pos);
    g_playRing.readPos.store(pos);
}

// Small ring so the seam is crossed many times. Pushes and reads use sizes that
// share no factor with the capacity or the channel count.
static void counter_roundtrip(int channels, uint32_t startPos) {
    constexpr uint32_t kCap = 64;
    play_ring_init(kCap);
    set_positions(startPos);
    const int pushSizes[] = {5, 13, 1, 31, 7, 64};
    const int readSizes[] = {6, 17, 40, 1, 64};
    std::vector<float> chunk(64), out(64);
    float nextPushed = 0.0f;
    float nextRead = 0.0f;
    int k = 0;
    while (nextRead < 2000.0f) {
        const int want = pushSizes[k % 6];
        for (int i = 0; i < want; ++i) chunk[i] = nextPushed + static_cast<float>(i);
        const int pushed = play_ring_push(chunk.data(), want);
        CHECK(pushed >= 0 && pushed <= want);
        nextPushed += static_cast<float>(pushed);

        const int got = play_ring_read_frames(out.data(), readSizes[k % 5], channels);
        CHECK_EQ(got % channels, 0);
        for (int i = 0; i < got; ++i) {
            if (out[i] != nextRead) {
                std::printf("FAIL channels=%d start=%u: read %g, expected %g\n", channels, startPos,
                            static_cast<double>(out[i]), static_cast<double>(nextRead));
                ++g_failures;
                return;
            }
            nextRead += 1.0f;
        }
        CHECK(play_ring_fill() <= kCap);
        ++k;
    }
    // Everything not read is either a partial frame or still in the ring.
    CHECK_EQ(static_cast<uint32_t>(nextPushed - nextRead), play_ring_fill());
}

static void partial_frame_waits() {
    play_ring_init(64);
    std::vector<float> in(32), out(64);
    for (int i = 0; i < 32; ++i) in[i] = static_cast<float>(i);
    CHECK_EQ(play_ring_push(in.data(), 22), 22); // 3 frames of 6 + 4 floats
    CHECK_EQ(play_ring_read_frames(out.data(), 64, 6), 18);
    CHECK_EQ(play_ring_fill(), 4u);
    CHECK_EQ(play_ring_read_frames(out.data(), 64, 6), 0);
    CHECK_EQ(play_ring_push(in.data() + 22, 2), 2);
    CHECK_EQ(play_ring_read_frames(out.data(), 64, 6), 6);
    CHECK(out[0] == 18.0f && out[5] == 23.0f);
    // A request smaller than one frame reads nothing.
    CHECK_EQ(play_ring_push(in.data(), 6), 6);
    CHECK_EQ(play_ring_read_frames(out.data(), 5, 6), 0);
}

static void full_and_invalid() {
    play_ring_init(16);
    std::vector<float> in(32, 1.0f);
    CHECK_EQ(play_ring_push(in.data(), 32), 16);
    CHECK_EQ(play_ring_push(in.data(), 1), 0);
    play_ring_init(384000); // the old capacity: not a power of two, rejected
    CHECK_EQ(play_ring_capacity(), 0u);
    CHECK_EQ(play_ring_push(in.data(), 4), 0);
    play_ring_init(PLAY_RING_CAPACITY);
    CHECK_EQ(play_ring_capacity(), PLAY_RING_CAPACITY);
    play_ring_cleanup();
}

int main() {
    for (int channels : {1, 2, 6, 8}) {
        counter_roundtrip(channels, 0);
        counter_roundtrip(channels, 0xFFFFFF00u); // positions wrap at 2^32 mid-test
    }
    partial_frame_waits();
    full_and_invalid();
    play_ring_cleanup();
    return native_test_result("play_ring_test");
}
