#pragma once

#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>

// SPSC play-side ring of interleaved f32. Producer: JS push_pcm on the main
// thread. Consumer: the `sdl-engine` AudioWorkletProcessor on the audio thread
// (src/audio/worklets/sdlEngineProcessor.js), which reads this header and the
// data through a view of the module's SharedArrayBuffer. play_ring_read /
// play_ring_read_frames below are the reference consumer: the processor
// mirrors them, and tests/native exercises them. Requires -pthread so the
// header and data live in shared WASM memory.
//
// Positions count floats and wrap at 2^32. The capacity is a power of two so
// that wrap is invisible to `pos & (capacity - 1)`; with any other capacity the
// index would jump when a position wraps (once per 2^32 floats, about 1.5 h of
// 96 kHz 8-channel audio in one gapless run). Positions are never rewound while
// a consumer runs: a seek names a later start (engine_state.h `ringStart`).
//
// A consumer reads whole frames only: a producer may leave a partial frame at
// the tail (it writes whatever fits), and playing that would rotate channels.

static constexpr uint32_t PLAY_RING_CAPACITY = 1u << 19; // 524288 floats (2 MiB), ~2.7 s of 96 kHz stereo

// Header words, mirrored in sdlEngineProcessor.js.
struct PlayRingState {
    std::atomic<uint32_t> writePos; // 0  producer
    std::atomic<uint32_t> readPos;  // 1  consumer
    uint32_t capacity;              // 2  floats, power of two
    std::atomic<uint32_t> ended;    // 3  producer: no more PCM for this stream
};
static_assert(sizeof(PlayRingState) == 16, "sdlEngineProcessor.js reads 4 u32 header words");
static_assert(offsetof(PlayRingState, readPos) == 4, "word 1");
static_assert(offsetof(PlayRingState, capacity) == 8, "word 2");
static_assert(offsetof(PlayRingState, ended) == 12, "word 3");

static PlayRingState g_playRing = {};
static float* g_playRingData = nullptr;

// Only while no consumer runs (init / cleanup).
inline void play_ring_reset() {
    g_playRing.writePos.store(0, std::memory_order_relaxed);
    g_playRing.readPos.store(0, std::memory_order_relaxed);
    g_playRing.ended.store(0, std::memory_order_relaxed);
}

inline void play_ring_init(uint32_t capacityFloats) {
    if (g_playRingData) {
        delete[] g_playRingData;
        g_playRingData = nullptr;
    }
    g_playRing.capacity = 0;
    if (capacityFloats == 0 || (capacityFloats & (capacityFloats - 1)) != 0) return;
    g_playRingData = new float[capacityFloats]();
    g_playRing.capacity = capacityFloats;
    play_ring_reset();
}

inline void play_ring_cleanup() {
    delete[] g_playRingData;
    g_playRingData = nullptr;
    g_playRing.capacity = 0;
    play_ring_reset();
}

inline uint32_t play_ring_capacity() {
    return g_playRing.capacity;
}

inline uint32_t play_ring_fill() {
    if (!g_playRingData) return 0;
    const uint32_t wp = g_playRing.writePos.load(std::memory_order_acquire);
    const uint32_t rp = g_playRing.readPos.load(std::memory_order_relaxed);
    return wp - rp;
}

inline uint32_t play_ring_write_pos() {
    return g_playRing.writePos.load(std::memory_order_acquire);
}

inline uint32_t play_ring_read_pos() {
    return g_playRing.readPos.load(std::memory_order_acquire);
}

inline void play_ring_set_ended(int ended) {
    g_playRing.ended.store(ended ? 1 : 0, std::memory_order_release);
}

inline int play_ring_ended() {
    return static_cast<int>(g_playRing.ended.load(std::memory_order_acquire));
}

// Non-blocking write. Returns number of floats actually stored (0 if full).
inline int play_ring_push(const float* samples, int count) {
    if (!g_playRingData || !samples || count <= 0) return 0;

    const uint32_t cap = g_playRing.capacity;
    const uint32_t wp = g_playRing.writePos.load(std::memory_order_relaxed);
    const uint32_t rp = g_playRing.readPos.load(std::memory_order_acquire);
    const uint32_t fill = wp - rp;
    const uint32_t space = cap - fill;
    if (space == 0) return 0;

    const uint32_t toWrite = std::min(static_cast<uint32_t>(count), space);
    const uint32_t idx = wp & (cap - 1);
    const uint32_t first = std::min(toWrite, cap - idx);
    std::memcpy(g_playRingData + idx, samples, first * sizeof(float));
    if (toWrite > first) {
        std::memcpy(g_playRingData, samples + first, (toWrite - first) * sizeof(float));
    }
    g_playRing.writePos.store(wp + toWrite, std::memory_order_release);
    return static_cast<int>(toWrite);
}

// Non-blocking read into dest. Returns floats copied.
inline int play_ring_read(float* dest, int count) {
    if (!g_playRingData || !dest || count <= 0) return 0;

    const uint32_t cap = g_playRing.capacity;
    const uint32_t wp = g_playRing.writePos.load(std::memory_order_acquire);
    const uint32_t rp = g_playRing.readPos.load(std::memory_order_relaxed);
    const uint32_t fill = wp - rp;
    if (fill == 0) return 0;

    const uint32_t toRead = std::min(static_cast<uint32_t>(count), fill);
    const uint32_t idx = rp & (cap - 1);
    const uint32_t first = std::min(toRead, cap - idx);
    std::memcpy(dest, g_playRingData + idx, first * sizeof(float));
    if (toRead > first) {
        std::memcpy(dest + first, g_playRingData, (toRead - first) * sizeof(float));
    }
    g_playRing.readPos.store(rp + toRead, std::memory_order_release);
    return static_cast<int>(toRead);
}

// Whole frames only: at most `maxFloats` floats, rounded down to a multiple of
// `channels`. A trailing partial frame stays in the ring until the producer
// completes it. Returns floats copied (0 when less than one frame is buffered).
inline int play_ring_read_frames(float* dest, int maxFloats, int channels) {
    if (channels <= 0 || maxFloats < channels) return 0;
    const uint32_t fill = play_ring_fill();
    const uint32_t frames = std::min(static_cast<uint32_t>(maxFloats), fill) / static_cast<uint32_t>(channels);
    if (frames == 0) return 0;
    return play_ring_read(dest, static_cast<int>(frames * static_cast<uint32_t>(channels)));
}
