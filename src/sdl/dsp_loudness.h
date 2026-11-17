#pragma once
// EBU R128 / ITU-R BS.1770-4 momentary (400 ms) and short-term (3 s) loudness of
// the speaker PCM, read from the analysis ring on a reader thread
// (src/audio/loudnessMeter.ts through src/dsp/dsp_wasm_entry.cpp). The audio
// callback never calls into this header: it only memcpy's into the ring.
//
// Same filter and channel weighting as libebur128 1.2.6 (MIT), the reference it
// is tested against: the K-weighting pre-filter and RLB high-pass are derived
// for any sample rate from libebur128's analog prototype constants, and the
// default channel map matches ebur128_init_channel_map() for 1-6 channels.
// libebur128 keeps the whole 3 s window as per-channel doubles (2.2 MiB at
// 48 kHz stereo, 35 MiB at 8 ch / 192 kHz), which a fixed-heap module cannot
// hold. BS.1770 gating blocks are made of 100 ms steps, so this keeps one
// weighted mean-square sum per 100 ms block instead: fixed size, no allocation,
// and the momentary / short-term values equal libebur128's at every 100 ms
// boundary (tests/native/dsp_loudness_golden.cpp).

#include <cmath>

constexpr int DSP_LOUDNESS_MAX_CHANNELS = 8;
/** Short-term window: 30 blocks of 100 ms. Momentary uses the newest 4. */
constexpr int DSP_LOUDNESS_BLOCKS = 30;
constexpr int DSP_LOUDNESS_MOMENTARY_BLOCKS = 4;

struct DspLoudness {
    int channels = 0;
    int sampleRate = 0;
    /** libebur128 samples_in_100ms: (rate + 5) / 10. */
    int blockFrames = 0;
    double weight[DSP_LOUDNESS_MAX_CHANNELS] = {};
    // K-weighting: high-shelf pre-filter then RLB high-pass, TDF-II per channel.
    double shelfB[3] = {}, shelfA[3] = {};
    double hpB[3] = {}, hpA[3] = {};
    double z[DSP_LOUDNESS_MAX_CHANNELS][4] = {};
    /** Weighted sum of squares in the block being filled. */
    double partial = 0.0;
    int partialFrames = 0;
    int channelPos = 0;
    /** Mean square (channel-weighted) of each finished 100 ms block, ring. */
    double blocks[DSP_LOUDNESS_BLOCKS] = {};
    int newestBlock = -1;
    /** Finished blocks since the last reset (saturates at DSP_LOUDNESS_BLOCKS). */
    int filledBlocks = 0;
};

/**
 * BS.1770-4 channel weights for the interleave the analysis ring carries
 * (Web Audio 'speakers' order; FLAC / WAVE order beyond 5.1). 1-6 channels match
 * libebur128's default map: L R C LFE Ls Rs, LFE excluded, surrounds 1.41.
 * 7.1 (L R C LFE Lb Rb Ls Rs) and 6.1 (L R C LFE Cb Ls Rs) weight the side
 * surrounds (±90°) 1.41 and the backs 1.0, per the BS.1770-4 azimuth table;
 * libebur128 would ignore channels past the sixth.
 */
inline double dsp_loudness_channel_weight(int channels, int index) {
    if (channels == 4) return index >= 2 ? 1.41 : 1.0;
    if (channels == 5) return index >= 3 ? 1.41 : 1.0;
    if (index == 3 && channels >= 6) return 0.0; // LFE
    if (channels == 6) return index >= 4 ? 1.41 : 1.0;
    if (channels == 7) return index >= 5 ? 1.41 : 1.0;
    if (channels == 8) return index >= 6 ? 1.41 : 1.0;
    return 1.0;
}

/** Clear history and set up the filters for a stream format. */
inline void dsp_loudness_reset(DspLoudness& m, int channels, int sampleRate) {
    m = DspLoudness{};
    if (channels <= 0 || sampleRate <= 0) return;
    m.channels = channels < DSP_LOUDNESS_MAX_CHANNELS ? channels : DSP_LOUDNESS_MAX_CHANNELS;
    m.sampleRate = sampleRate;
    m.blockFrames = (sampleRate + 5) / 10;
    for (int c = 0; c < m.channels; ++c) m.weight[c] = dsp_loudness_channel_weight(m.channels, c);

    // libebur128 ebur128_init_filter(), kept as two biquads instead of one
    // 4th-order section (same transfer function, better conditioned).
    double f0 = 1681.974450955533;
    const double G = 3.999843853973347;
    double Q = 0.7071752369554196;
    double K = std::tan(M_PI * f0 / (double)sampleRate);
    const double Vh = std::pow(10.0, G / 20.0);
    const double Vb = std::pow(Vh, 0.4996667741545416);
    double a0 = 1.0 + K / Q + K * K;
    m.shelfB[0] = (Vh + Vb * K / Q + K * K) / a0;
    m.shelfB[1] = 2.0 * (K * K - Vh) / a0;
    m.shelfB[2] = (Vh - Vb * K / Q + K * K) / a0;
    m.shelfA[0] = 1.0;
    m.shelfA[1] = 2.0 * (K * K - 1.0) / a0;
    m.shelfA[2] = (1.0 - K / Q + K * K) / a0;

    f0 = 38.13547087602444;
    Q = 0.5003270373238773;
    K = std::tan(M_PI * f0 / (double)sampleRate);
    a0 = 1.0 + K / Q + K * K;
    m.hpB[0] = 1.0;
    m.hpB[1] = -2.0;
    m.hpB[2] = 1.0;
    m.hpA[0] = 1.0;
    m.hpA[1] = 2.0 * (K * K - 1.0) / a0;
    m.hpA[2] = (1.0 - K / Q + K * K) / a0;
}

/** Feed interleaved f32 (`numFloats` need not be frame-aligned). */
inline void dsp_loudness_push(DspLoudness& m, const float* samples, int numFloats) {
    if (m.channels <= 0) return;
    for (int i = 0; i < numFloats; ++i) {
        const int c = m.channelPos;
        double* z = m.z[c];
        const double x = samples[i];
        const double y1 = m.shelfB[0] * x + z[0];
        z[0] = m.shelfB[1] * x - m.shelfA[1] * y1 + z[1];
        z[1] = m.shelfB[2] * x - m.shelfA[2] * y1;
        const double y2 = m.hpB[0] * y1 + z[2];
        z[2] = m.hpB[1] * y1 - m.hpA[1] * y2 + z[3];
        z[3] = m.hpB[2] * y1 - m.hpA[2] * y2;
        m.partial += m.weight[c] * y2 * y2;
        if (++m.channelPos < m.channels) continue;
        m.channelPos = 0;
        if (++m.partialFrames < m.blockFrames) continue;
        m.newestBlock = (m.newestBlock + 1) % DSP_LOUDNESS_BLOCKS;
        m.blocks[m.newestBlock] = m.partial / (double)m.blockFrames;
        if (m.filledBlocks < DSP_LOUDNESS_BLOCKS) ++m.filledBlocks;
        m.partial = 0.0;
        m.partialFrames = 0;
    }
}

/** LUFS of the newest `count` 100 ms blocks; NaN until that much audio arrived, -inf for silence. */
inline double dsp_loudness_window(const DspLoudness& m, int count) {
    if (count <= 0 || count > DSP_LOUDNESS_BLOCKS || m.filledBlocks < count) return NAN;
    double sum = 0.0;
    for (int k = 0; k < count; ++k) {
        sum += m.blocks[(m.newestBlock - k + DSP_LOUDNESS_BLOCKS) % DSP_LOUDNESS_BLOCKS];
    }
    const double energy = sum / (double)count;
    if (!(energy > 0.0)) return -INFINITY;
    return 10.0 * std::log10(energy) - 0.691;
}

inline double dsp_loudness_momentary(const DspLoudness& m) {
    return dsp_loudness_window(m, DSP_LOUDNESS_MOMENTARY_BLOCKS);
}

inline double dsp_loudness_short_term(const DspLoudness& m) {
    return dsp_loudness_window(m, DSP_LOUDNESS_BLOCKS);
}
