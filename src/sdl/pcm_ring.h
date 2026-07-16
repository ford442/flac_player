#pragma once

#include <atomic>
#include <cstdint>
#include <cstring>
#include <vector>

// Lock-free ring buffer for interleaved float PCM (SDL callback -> JS AudioWorklet).
// Requires -sUSE_PTHREADS=1 so writePos/readPos live in shared WASM memory.
struct PcmRingState {
    alignas(4) std::atomic<uint32_t> writePos;
    alignas(4) std::atomic<uint32_t> readPos;
    uint32_t capacity;
    uint32_t pad;
};

static PcmRingState g_pcmRing = {};
static float* g_pcmRingData = nullptr;

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
    pcm_ring_reset();
}

inline void pcm_ring_cleanup() {
    delete[] g_pcmRingData;
    g_pcmRingData = nullptr;
    g_pcmRing.capacity = 0;
    pcm_ring_reset();
}

inline void pcm_ring_write(const float* samples, int count) {
    if (!g_pcmRingData || count <= 0) return;

    const uint32_t cap = g_pcmRing.capacity;
    uint32_t wp = g_pcmRing.writePos.load(std::memory_order_relaxed);

    for (int i = 0; i < count; ++i) {
        g_pcmRingData[wp % cap] = samples[i];
        ++wp;
    }

    g_pcmRing.writePos.store(wp, std::memory_order_release);
}

// Scratch buffer for volume scaling in audio callbacks (single-threaded per engine).
static thread_local std::vector<float> g_volumeScratch;

inline const float* scale_samples(const float* src, int numFloats, float volume) {
    if (volume == 1.0f) return src;

    g_volumeScratch.resize(static_cast<size_t>(numFloats));
    for (int i = 0; i < numFloats; ++i) {
        g_volumeScratch[static_cast<size_t>(i)] = src[i] * volume;
    }
    return g_volumeScratch.data();
}
