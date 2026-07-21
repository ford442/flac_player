#pragma once

#include <atomic>
#include <cstdint>
#include <algorithm>

// Bounded ring for interleaved float PCM fed from JS (producer) and drained by
// the SDL audio callback (consumer).
//
// This is what makes streaming playback possible: instead of holding a whole
// decoded track in a std::vector, only a few seconds of audio is resident at
// any time. Writes that would overflow are rejected rather than dropped
// silently, so the JS side can apply back-pressure (see feed_pcm_chunk).
//
// Distinct from pcm_ring.h, which is a lossy tap for the visualiser: this one
// carries the audio actually being played and must not drop samples.
//
// Single producer, single consumer. writePos/readPos are free-running counters
// (never wrapped) so a full ring is distinguishable from an empty one; they are
// reduced modulo capacity only when indexing.
struct FeedRingState {
    alignas(4) std::atomic<uint32_t> writePos;
    alignas(4) std::atomic<uint32_t> readPos;
    uint32_t capacity;
    uint32_t pad;
};

static FeedRingState g_feedRing = {};
static float* g_feedRingData = nullptr;

inline void feed_ring_reset() {
    g_feedRing.writePos.store(0, std::memory_order_relaxed);
    g_feedRing.readPos.store(0, std::memory_order_relaxed);
}

inline void feed_ring_init(int capacityFloats) {
    if (g_feedRingData) {
        delete[] g_feedRingData;
        g_feedRingData = nullptr;
    }
    if (capacityFloats <= 0) {
        g_feedRing.capacity = 0;
        return;
    }
    g_feedRingData = new float[capacityFloats]();
    g_feedRing.capacity = static_cast<uint32_t>(capacityFloats);
    feed_ring_reset();
}

inline void feed_ring_cleanup() {
    delete[] g_feedRingData;
    g_feedRingData = nullptr;
    g_feedRing.capacity = 0;
    feed_ring_reset();
}

/** Samples currently readable. */
inline uint32_t feed_ring_available() {
    const uint32_t wp = g_feedRing.writePos.load(std::memory_order_acquire);
    const uint32_t rp = g_feedRing.readPos.load(std::memory_order_relaxed);
    return wp - rp;
}

/** Free space in samples. */
inline uint32_t feed_ring_space() {
    if (g_feedRing.capacity == 0) return 0;
    return g_feedRing.capacity - feed_ring_available();
}

/**
 * Producer side. Writes as much of `samples` as fits and returns the count
 * accepted, so a partial write tells JS to retry the remainder later.
 */
inline uint32_t feed_ring_write(const float* samples, uint32_t count) {
    if (!g_feedRingData || count == 0) return 0;

    const uint32_t cap = g_feedRing.capacity;
    const uint32_t writable = std::min(count, feed_ring_space());
    uint32_t wp = g_feedRing.writePos.load(std::memory_order_relaxed);

    for (uint32_t i = 0; i < writable; ++i) {
        g_feedRingData[(wp + i) % cap] = samples[i];
    }

    g_feedRing.writePos.store(wp + writable, std::memory_order_release);
    return writable;
}

/** Consumer side. Copies up to `count` samples into `dest`, returns the count read. */
inline uint32_t feed_ring_read(float* dest, uint32_t count) {
    if (!g_feedRingData || count == 0) return 0;

    const uint32_t cap = g_feedRing.capacity;
    const uint32_t readable = std::min(count, feed_ring_available());
    uint32_t rp = g_feedRing.readPos.load(std::memory_order_relaxed);

    for (uint32_t i = 0; i < readable; ++i) {
        dest[i] = g_feedRingData[(rp + i) % cap];
    }

    g_feedRing.readPos.store(rp + readable, std::memory_order_release);
    return readable;
}

/** Fill level as a percentage (0-100), for JS back-pressure decisions. */
inline int feed_ring_fill_percent() {
    if (g_feedRing.capacity == 0) return 0;
    return static_cast<int>((feed_ring_available() * 100ull) / g_feedRing.capacity);
}
