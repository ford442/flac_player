#pragma once
// Transport shared between the engine's exports (main thread) and its audio
// thread, the `sdl-engine` AudioWorkletProcessor (src/audio/worklets/
// sdlEngineProcessor.js), which reads this block and the play ring out of the
// module's SharedArrayBuffer every render quantum.
//
// Protocol: the main thread writes the fields of a change (load, seek, stop,
// rebase), then bumps `epoch`. The processor applies a new epoch at the start
// of a quantum: it re-reads the fields, re-checks that `epoch` did not move
// meanwhile, moves its read position to `startFrame` (buffered) or the ring to
// `ringStart` (stream), resets `framesPlayed`, and publishes `ackEpoch`.
// `playing`, `rateBits` and the ring's `ended` flag are read every quantum and
// need no epoch. Only the processor whose id is in `owner` touches anything;
// a replaced node sees another id and retires.
//
// The play ring stays SPSC: the main thread only ever advances writePos, the
// processor only readPos. A seek never rewinds a position; it names the write
// position from which PCM is current (`ringStart`) and the processor skips to it.
//
// Word offsets are mirrored in sdlEngineProcessor.js and sdlEngineMessages.ts
// (tests/sdlEngineProcessor.test.ts compares them with the static_asserts below).
// Requires -pthread so this lives in shared WASM memory.

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>

enum EngineMode : uint32_t { ENGINE_IDLE = 0, ENGINE_BUFFERED = 1, ENGINE_STREAM = 2 };

struct EngineState {
    // Main thread -> processor.
    std::atomic<uint32_t> epoch;        // 0  bumped after every transport change
    std::atomic<uint32_t> mode;         // 1  EngineMode
    std::atomic<uint32_t> playing;      // 2  0: silence, position held
    std::atomic<uint32_t> channels;     // 3  interleave of the PCM
    std::atomic<uint32_t> sampleRate;   // 4  Hz of the PCM (the AudioContext rate)
    std::atomic<uint32_t> rateBits;     // 5  playback rate, f32 bits (pitch follows speed)
    std::atomic<uint32_t> bufferPtr;    // 6  buffered PCM, byte offset in WASM memory
    std::atomic<uint32_t> bufferFloats; // 7  buffered PCM length
    std::atomic<uint32_t> startFrame;   // 8  media frame this epoch starts at
    std::atomic<uint32_t> ringStart;    // 9  stream: ring position of this epoch's first float
    std::atomic<uint32_t> owner;        // 10 id of the processor allowed to read
    // Processor -> main thread.
    std::atomic<uint32_t> ackEpoch;     // 11 last epoch the processor applied
    std::atomic<uint32_t> framesPlayed; // 12 media frames consumed since startFrame
    std::atomic<uint32_t> drained;      // 13 1: buffered PCM ran out / stream ended and ring empty
    uint32_t reserved[2];               // 14..15
};
static_assert(sizeof(EngineState) == 64, "sdlEngineProcessor.js reads 16 u32 words");
static_assert(offsetof(EngineState, epoch) == 0 * 4, "word 0");
static_assert(offsetof(EngineState, mode) == 1 * 4, "word 1");
static_assert(offsetof(EngineState, playing) == 2 * 4, "word 2");
static_assert(offsetof(EngineState, channels) == 3 * 4, "word 3");
static_assert(offsetof(EngineState, sampleRate) == 4 * 4, "word 4");
static_assert(offsetof(EngineState, rateBits) == 5 * 4, "word 5");
static_assert(offsetof(EngineState, bufferPtr) == 6 * 4, "word 6");
static_assert(offsetof(EngineState, bufferFloats) == 7 * 4, "word 7");
static_assert(offsetof(EngineState, startFrame) == 8 * 4, "word 8");
static_assert(offsetof(EngineState, ringStart) == 9 * 4, "word 9");
static_assert(offsetof(EngineState, owner) == 10 * 4, "word 10");
static_assert(offsetof(EngineState, ackEpoch) == 11 * 4, "word 11");
static_assert(offsetof(EngineState, framesPlayed) == 12 * 4, "word 12");
static_assert(offsetof(EngineState, drained) == 13 * 4, "word 13");

inline uint32_t engine_float_bits(float f) {
    uint32_t bits;
    std::memcpy(&bits, &f, sizeof bits);
    return bits;
}

inline float engine_bits_float(uint32_t bits) {
    float f;
    std::memcpy(&f, &bits, sizeof f);
    return f;
}

inline void engine_reset(EngineState& s) {
    s.mode.store(ENGINE_IDLE);
    s.playing.store(0);
    s.channels.store(0);
    s.sampleRate.store(0);
    s.rateBits.store(engine_float_bits(1.0f));
    s.bufferPtr.store(0);
    s.bufferFloats.store(0);
    s.startFrame.store(0);
    s.ringStart.store(0);
    s.owner.store(0);
    s.ackEpoch.store(0);
    s.framesPlayed.store(0);
    s.drained.store(0);
    s.epoch.store(0);
}

// Publish the fields written since the last bump. seq_cst, like every access
// here: the processor's Atomics are sequentially consistent too.
inline void engine_bump(EngineState& s) {
    s.epoch.fetch_add(1);
}

// Media position in frames: the target of a change the processor has not
// applied yet, else where it has played to.
inline uint64_t engine_position_frames(const EngineState& s) {
    const uint32_t start = s.startFrame.load();
    if (s.ackEpoch.load() != s.epoch.load()) return start;
    return static_cast<uint64_t>(start) + s.framesPlayed.load();
}

inline double engine_position_seconds(const EngineState& s) {
    const uint32_t rate = s.sampleRate.load();
    if (rate == 0) return 0.0;
    return static_cast<double>(engine_position_frames(s)) / static_cast<double>(rate);
}

// Frame `seconds` lands on, clamped to `limitFrames` when non-zero.
inline uint32_t engine_frame_at(double seconds, uint32_t sampleRate, uint32_t limitFrames) {
    if (!(seconds > 0.0) || sampleRate == 0) return 0;
    double frame = seconds * static_cast<double>(sampleRate);
    if (limitFrames != 0 && frame > static_cast<double>(limitFrames)) frame = static_cast<double>(limitFrames);
    if (frame > 4294967295.0) frame = 4294967295.0;
    return static_cast<uint32_t>(frame);
}

// A new processor (the AudioContext was replaced) carries on from where the
// old one stopped: the media position it reached and the ring position it read
// to become the start of a fresh epoch. Call only once the old one is gone. A
// change the old one never applied already says where to start, so it stays.
inline void engine_rebase(EngineState& s, uint32_t ringReadPos) {
    if (s.ackEpoch.load() != s.epoch.load()) return;
    const uint64_t frames = engine_position_frames(s);
    s.startFrame.store(frames > 0xffffffffull ? 0xffffffffu : static_cast<uint32_t>(frames));
    s.ringStart.store(ringReadPos);
    engine_bump(s);
}
