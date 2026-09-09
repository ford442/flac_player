#pragma once

#include <atomic>
#include <cstdint>
#include <cstring>
#include <algorithm>
#include <vector>

// Lock-free ring buffer for interleaved float PCM (SDL callback -> JS AudioWorklet).
// Requires -pthread so writePos/readPos live in shared WASM memory.
struct PcmRingState {
    alignas(4) std::atomic<uint32_t> writePos;
    alignas(4) std::atomic<uint32_t> readPos;
    uint32_t capacity;
    uint32_t pad;
};

static PcmRingState g_pcmRing = {};
static float* g_pcmRingData = nullptr;

// Grow-only volume scratch. Sized in pcm_ring_init on the main thread so the
// audio pthread callback does not allocate when volume != 1.
static std::vector<float> g_volumeScratch;
static constexpr int PCM_VOLUME_SCRATCH_MIN = 16384;

inline float* pcm_ring_data() {
    return g_pcmRingData;
}

inline void pcm_ring_reset() {
    g_pcmRing.writePos.store(0, std::memory_order_relaxed);
    g_pcmRing.readPos.store(0, std::memory_order_relaxed);
}

inline void pcm_ring_init(int capacityFloats) {
    if (g_pcmRingData) {
        delete[] g_pcmRingData;
        g_pcmRingData = nullptr;
    }
    if (capacityFloats <= 0) return;

    g_pcmRingData = new float[capacityFloats]();
    g_pcmRing.capacity = static_cast<uint32_t>(capacityFloats);
    if (g_volumeScratch.size() < static_cast<size_t>(PCM_VOLUME_SCRATCH_MIN)) {
        g_volumeScratch.resize(static_cast<size_t>(PCM_VOLUME_SCRATCH_MIN));
    }
    pcm_ring_reset();
}

inline void pcm_ring_cleanup() {
    delete[] g_pcmRingData;
    g_pcmRingData = nullptr;
    g_pcmRing.capacity = 0;
    pcm_ring_reset();
}

inline void pcm_ring_write(const float* samples, int count) {
    if (!g_pcmRingData || !samples || count <= 0) return;

    const uint32_t cap = g_pcmRing.capacity;
    if (cap == 0) return;

    // Overwrite-on-full: keep the newest `cap` samples if the block is larger than the ring.
    if (static_cast<uint32_t>(count) >= cap) {
        samples += static_cast<uint32_t>(count) - cap;
        count = static_cast<int>(cap);
    }

    uint32_t wp = g_pcmRing.writePos.load(std::memory_order_relaxed);
    const uint32_t idx = wp % cap;
    const uint32_t n = static_cast<uint32_t>(count);
    const uint32_t first = std::min(n, cap - idx);
    std::memcpy(g_pcmRingData + idx, samples, first * sizeof(float));
    if (n > first) {
        std::memcpy(g_pcmRingData, samples + first, (n - first) * sizeof(float));
    }
    g_pcmRing.writePos.store(wp + n, std::memory_order_release);
}

inline const float* scale_samples(const float* src, int numFloats, float volume) {
    if (volume == 1.0f || numFloats <= 0) return src;
    const size_t n = static_cast<size_t>(numFloats);
    if (g_volumeScratch.size() < n) {
        g_volumeScratch.resize(n);
    }
    float* dst = g_volumeScratch.data();
    for (int i = 0; i < numFloats; ++i) {
        dst[i] = src[i] * volume;
    }
    return dst;
}
