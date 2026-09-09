#pragma once

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstring>

// SPSC play-side ring: JS push_pcm (main) → SDL audio callback (pthread).
// Capacity is ~2 s of interleaved stereo f32 at 96 kHz (~1.5 MiB).
// Requires -pthread so writePos/readPos live in shared WASM memory.

static constexpr uint32_t PLAY_RING_CAPACITY = 96000u * 2u * 2u; // 384000 floats

struct PlayRingState {
    alignas(8) std::atomic<uint32_t> writePos;
    alignas(8) std::atomic<uint32_t> readPos;
    uint32_t capacity;
    uint32_t pad;
};

static PlayRingState g_playRing = {};
static float* g_playRingData = nullptr;
static std::atomic<int> g_streamEnded{0};

inline void play_ring_reset() {
    g_playRing.writePos.store(0, std::memory_order_relaxed);
    g_playRing.readPos.store(0, std::memory_order_relaxed);
    g_streamEnded.store(0, std::memory_order_relaxed);
}

inline void play_ring_init(uint32_t capacityFloats) {
    if (g_playRingData) {
        delete[] g_playRingData;
        g_playRingData = nullptr;
    }
    if (capacityFloats == 0) return;
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

inline void play_ring_set_ended(int ended) {
    g_streamEnded.store(ended ? 1 : 0, std::memory_order_release);
}

inline int play_ring_ended() {
    return g_streamEnded.load(std::memory_order_acquire);
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
    const uint32_t idx = wp % cap;
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
    const uint32_t idx = rp % cap;
    const uint32_t first = std::min(toRead, cap - idx);
    std::memcpy(dest, g_playRingData + idx, first * sizeof(float));
    if (toRead > first) {
        std::memcpy(dest + first, g_playRingData, (toRead - first) * sizeof(float));
    }
    g_playRing.readPos.store(rp + toRead, std::memory_order_release);
    return static_cast<int>(toRead);
}
