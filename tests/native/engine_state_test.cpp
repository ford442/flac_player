// engine_state.h: the transport block between the engine's exports and the
// sdl-engine processor.
//   - the clock reads the target of an unapplied change, then start + played
//   - engine_frame_at truncates, clamps to the track, and rejects bad input
//   - rebase carries the played position and the ring read position into a
//     new epoch, and leaves an unapplied change alone
//   - rate bits round-trip
#include <cstdint>
#include <initializer_list>
#include "native_test.h"
#include "../../src/sdl/engine_state.h"

// What sdlEngineProcessor.js does when it applies an epoch.
static void processor_ack(EngineState& s) {
    s.framesPlayed.store(0);
    s.drained.store(0);
    s.ackEpoch.store(s.epoch.load());
}

static void clock_follows_ack() {
    EngineState s;
    engine_reset(s);
    CHECK_EQ(engine_position_seconds(s), 0.0); // sampleRate 0: no clock yet

    s.sampleRate.store(48000);
    s.startFrame.store(96000);
    engine_bump(s);
    s.framesPlayed.store(4800); // stale progress from the previous epoch
    CHECK_EQ(engine_position_frames(s), 96000u);

    processor_ack(s);
    s.framesPlayed.store(24000);
    CHECK_EQ(engine_position_frames(s), 120000u);
    CHECK(engine_position_seconds(s) == 2.5);
}

static void frame_at() {
    CHECK_EQ(engine_frame_at(1.0, 44100, 0), 44100u);
    CHECK_EQ(engine_frame_at(0.99999, 44100, 0), 44099u); // truncates like floor(t × rate)
    CHECK_EQ(engine_frame_at(-1.0, 44100, 0), 0u);
    CHECK_EQ(engine_frame_at(0.0 / 0.0, 44100, 0), 0u);  // NaN
    CHECK_EQ(engine_frame_at(5.0, 0, 0), 0u);
    CHECK_EQ(engine_frame_at(30.0, 44100, 1000), 1000u); // past the end of a buffered track
    CHECK_EQ(engine_frame_at(1e12, 96000, 0), 0xffffffffu);
}

static void rebase() {
    EngineState s;
    engine_reset(s);
    s.sampleRate.store(44100);
    s.startFrame.store(1000);
    engine_bump(s);
    processor_ack(s);
    s.framesPlayed.store(500);

    const uint32_t epoch = s.epoch.load();
    engine_rebase(s, 0xfffffff0u);
    CHECK_EQ(s.epoch.load(), epoch + 1);
    CHECK_EQ(s.startFrame.load(), 1500u);
    CHECK_EQ(s.ringStart.load(), 0xfffffff0u);
    // Until the new processor applies it, the clock holds where the old one stopped.
    CHECK_EQ(engine_position_frames(s), 1500u);

    // A seek the old processor never applied already names the start: keep it.
    s.startFrame.store(7000);
    s.ringStart.store(123);
    engine_bump(s);
    const uint32_t pending = s.epoch.load();
    engine_rebase(s, 999);
    CHECK_EQ(s.epoch.load(), pending);
    CHECK_EQ(s.startFrame.load(), 7000u);
    CHECK_EQ(s.ringStart.load(), 123u);
}

static void rate_bits() {
    for (float f : {0.25f, 1.0f, 1.5f, 4.0f}) CHECK(engine_bits_float(engine_float_bits(f)) == f);
    EngineState s;
    engine_reset(s);
    CHECK(engine_bits_float(s.rateBits.load()) == 1.0f);
}

int main() {
    clock_follows_ack();
    frame_at();
    rebase();
    rate_bits();
    return native_test_result("engine_state_test");
}
