#pragma once
// Analysis ring: broadcast tap of the post-DSP PCM the user hears, for every
// analysis consumer (gpu-chores FFT, dsp_fft.h, projectM, ShaderGUI).
//
// Unlike pcm_ring.h (SPSC, drained by the sdlPcmTap worklet into the analyser)
// nothing is consumed here: the audio callback only memcpy's its block in and
// bumps writePos; readers snapshot the newest N frames (or follow writePos with
// their own cursor) on their own thread, at UI rate. Torn reads are detected
// by the reader re-checking writePos / generation after the copy. Data lands
// before writePos is published, so writers publish at least every
// analysis_ring_block(capacity) floats and readers keep that much margin.
//
// The header layout is shared with src/audio/analysisRing.ts, which reads this
// ring out of the SDL module's SharedArrayBuffer and also writes the same
// layout from the dsp-chain AudioWorklet for the Web Audio backends:
//
//   u32[0] writePos    floats written since the last reset (wraps at 2^32)
//   u32[1] generation  bumped on reset / format change; readers resync
//   u32[2] capacity    floats, power of two
//   u32[3] channels    interleave of the samples
//   u32[4] sampleRate  Hz of the samples (file rate on SDL)
//   u32[5..7]          reserved
//
// Requires -pthread so the header lives in shared WASM memory.

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstring>

// 2^17 floats (512 KiB): after the writer margin, 15360 frames at 8 channels
// (61440 stereo) — far more than the 2048-frame analysis windows read today.
static constexpr uint32_t ANALYSIS_RING_CAPACITY = 1u << 17;
// Largest block a writer appends before publishing writePos (SDL's callback
// scratch is 8192 floats). Mirrored as ANALYSIS_RING_MAX_BLOCK in analysisRing.ts.
static constexpr uint32_t ANALYSIS_RING_MAX_BLOCK = 8192;

inline uint32_t analysis_ring_block(uint32_t capacity) {
    return std::max(1u, std::min(ANALYSIS_RING_MAX_BLOCK, capacity / 2));
}

struct AnalysisRingState {
    alignas(4) std::atomic<uint32_t> writePos;
    alignas(4) std::atomic<uint32_t> generation;
    uint32_t capacity;
    std::atomic<uint32_t> channels;
    std::atomic<uint32_t> sampleRate;
    uint32_t reserved[3];
};
static_assert(sizeof(AnalysisRingState) == 32, "analysisRing.ts reads 8 u32 header words");

static AnalysisRingState g_analysisRing = {};
static float* g_analysisRingData = nullptr;

inline float* analysis_ring_data() {
    return g_analysisRingData;
}

// Readers compare generation before and after a copy, so bump it last.
inline void analysis_ring_reset() {
    g_analysisRing.writePos.store(0, std::memory_order_relaxed);
    g_analysisRing.generation.fetch_add(1, std::memory_order_release);
}

inline void analysis_ring_set_format(int channels, int sampleRate) {
    g_analysisRing.channels.store(channels > 0 ? (uint32_t)channels : 0u, std::memory_order_relaxed);
    g_analysisRing.sampleRate.store(sampleRate > 0 ? (uint32_t)sampleRate : 0u, std::memory_order_relaxed);
    analysis_ring_reset();
}

inline void analysis_ring_init(uint32_t capacityFloats) {
    delete[] g_analysisRingData;
    g_analysisRingData = nullptr;
    g_analysisRing.capacity = 0;
    if (capacityFloats == 0 || (capacityFloats & (capacityFloats - 1)) != 0) return;
    g_analysisRingData = new float[capacityFloats]();
    g_analysisRing.capacity = capacityFloats;
    analysis_ring_reset();
}

inline void analysis_ring_cleanup() {
    delete[] g_analysisRingData;
    g_analysisRingData = nullptr;
    g_analysisRing.capacity = 0;
    analysis_ring_reset();
}

// Audio callback: O(block) memcpy, no allocation, never blocks on readers.
inline void analysis_ring_write(const float* samples, int count) {
    if (!g_analysisRingData || !samples || count <= 0) return;
    const uint32_t cap = g_analysisRing.capacity;
    if (cap == 0) return;

    uint32_t n = static_cast<uint32_t>(count);
    uint32_t wp = g_analysisRing.writePos.load(std::memory_order_relaxed);
    // A block larger than the ring keeps only its newest `cap` floats; publish
    // the skip first so readers see those positions as gone.
    if (n > cap) {
        samples += n - cap;
        wp += n - cap;
        n = cap;
        g_analysisRing.writePos.store(wp, std::memory_order_release);
    }
    const uint32_t block = analysis_ring_block(cap);
    while (n > 0) {
        const uint32_t chunk = std::min(n, block);
        const uint32_t idx = wp & (cap - 1);
        const uint32_t first = std::min(chunk, cap - idx);
        std::memcpy(g_analysisRingData + idx, samples, first * sizeof(float));
        if (chunk > first) {
            std::memcpy(g_analysisRingData, samples + first, (chunk - first) * sizeof(float));
        }
        wp += chunk;
        samples += chunk;
        n -= chunk;
        g_analysisRing.writePos.store(wp, std::memory_order_release);
    }
}
