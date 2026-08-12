#include <SDL2/SDL.h>
#include <emscripten.h>
#include <vector>
#include <iostream>
#include <cmath>
#include <algorithm>
#include "pcm_ring.h"

#ifdef __cplusplus
extern "C" {
#endif

struct PlayerState {
    SDL_AudioStream* stream = nullptr;
    std::vector<float> audioBuffer;
    bool isPlaying = false;
    float volume = 1.0f;
    int sampleRate = 44100;
    int channels = 2;
    size_t playHead = 0;
    SDL_AudioDeviceID deviceId = 0;
    int deviceFreq = 44100;
    int deviceChannels = 2;
    // Streaming: PCM is queued to the device incrementally instead of all at
    // once, so only the device queue is resident. Seek is unsupported here.
    bool streaming = false;
    bool streamEnded = false;
    double streamFedSeconds = 0.0; // total audio handed to the device
} g_state;

// Target depth of the device queue in streaming mode. Back-pressure kicks in
// above this; ~8 s stereo @48k is a few MB, versus the whole track buffered.
static const double kTargetQueueSeconds = 8.0;

static Uint32 target_queue_bytes() {
    return (Uint32)(kTargetQueueSeconds * sizeof(float)
                    * g_state.deviceChannels * g_state.deviceFreq);
}

/** Convert interleaved float PCM through the resampler and queue it. */
static int queue_samples(const float* samples, int count) {
    if (!g_state.stream || !g_state.deviceId || count <= 0) return 0;

    const float* scaled = scale_samples(samples, count, g_state.volume);
    pcm_ring_write(scaled, count);
    SDL_AudioStreamPut(g_state.stream, scaled, count * sizeof(float));

    int available = SDL_AudioStreamAvailable(g_state.stream);
    if (available > 0) {
        std::vector<Uint8> converted(available);
        int got = SDL_AudioStreamGet(g_state.stream, converted.data(), available);
        if (got > 0) {
            SDL_QueueAudio(g_state.deviceId, converted.data(), got);
        }
    }
    return count;
}

static void queue_remaining_audio() {
    if (!g_state.stream || !g_state.deviceId || g_state.audioBuffer.empty()) return;

    size_t samplesRemaining = g_state.audioBuffer.size() - g_state.playHead;
    if (samplesRemaining == 0) return;

    const float* src = &g_state.audioBuffer[g_state.playHead];
    const float* scaled = scale_samples(src, (int)samplesRemaining, g_state.volume);

    pcm_ring_write(scaled, (int)samplesRemaining);
    SDL_AudioStreamPut(g_state.stream, scaled, samplesRemaining * sizeof(float));

    int available = SDL_AudioStreamAvailable(g_state.stream);
    if (available > 0) {
        std::vector<Uint8> converted(available);
        int got = SDL_AudioStreamGet(g_state.stream, converted.data(), available);
        if (got > 0) {
            SDL_QueueAudio(g_state.deviceId, converted.data(), got);
        }
    }
}

EMSCRIPTEN_KEEPALIVE
int init_audio() {
    printf("[C++ SDL2] init_audio called\n");
    if (SDL_Init(SDL_INIT_AUDIO) != 0) {
        std::cerr << "[C++ SDL2] SDL_Init failed: " << SDL_GetError() << std::endl;
        return 0;
    }

    pcm_ring_init(65536);
    printf("[C++ SDL2] init_audio success (device open deferred until track load)\n");
    return 1;
}

EMSCRIPTEN_KEEPALIVE
void set_audio_data(float* data, int length, int channels, int sampleRate) {
    g_state.streaming = false;
    g_state.streamEnded = false;
    g_state.streamFedSeconds = 0.0;
    printf("[C++ SDL2] set_audio_data called. Length: %d, Channels: %d, Rate: %d\n", length, channels, sampleRate);

    if (g_state.stream) {
        SDL_FreeAudioStream(g_state.stream);
    }
    g_state.stream = nullptr;

    if (g_state.deviceId) {
        SDL_CloseAudioDevice(g_state.deviceId);
        g_state.deviceId = 0;
    }

    try {
        g_state.audioBuffer.assign(data, data + length);
    } catch (const std::exception& e) {
        std::cerr << "[C++ SDL2] Error assigning audio buffer: " << e.what() << std::endl;
        return;
    }

    g_state.channels = channels;
    g_state.sampleRate = sampleRate;
    g_state.playHead = 0;
    g_state.isPlaying = false;
    pcm_ring_reset();

    SDL_AudioSpec want, have;
    SDL_zero(want);
    want.freq = sampleRate;
    want.format = AUDIO_F32;
    want.channels = channels;
    want.samples = 1024;
    want.callback = NULL;

    g_state.deviceId = SDL_OpenAudioDevice(NULL, 0, &want, &have, SDL_AUDIO_ALLOW_ANY_CHANGE);

    if (g_state.deviceId == 0) {
         std::cerr << "[C++ SDL2] SDL_OpenAudioDevice failed: " << SDL_GetError() << std::endl;
         return;
    }

    g_state.deviceFreq = have.freq;
    g_state.deviceChannels = have.channels;

    printf("[C++ SDL2] Device opened. Freq: %d, Channels: %d\n", have.freq, have.channels);

    g_state.stream = SDL_NewAudioStream(AUDIO_F32, channels, sampleRate,
                                        have.format, have.channels, have.freq);

    if (!g_state.stream) {
        std::cerr << "[C++ SDL2] SDL_NewAudioStream failed: " << SDL_GetError() << std::endl;
        return;
    }
}

EMSCRIPTEN_KEEPALIVE
int start_stream(int channels, int sampleRate, int bufferSeconds) {
    (void)bufferSeconds; // SDL2 bounds by device queue depth, not a ring
    g_state.channels = channels > 0 ? channels : 2;
    g_state.sampleRate = sampleRate > 0 ? sampleRate : 44100;
    g_state.streaming = true;
    g_state.streamEnded = false;
    g_state.streamFedSeconds = 0.0;
    g_state.playHead = 0;
    g_state.isPlaying = false;
    g_state.audioBuffer.clear();
    g_state.audioBuffer.shrink_to_fit();

    if (g_state.deviceId) SDL_ClearQueuedAudio(g_state.deviceId);
    pcm_ring_reset();

    if (g_state.stream) {
        SDL_FreeAudioStream(g_state.stream);
        g_state.stream = nullptr;
    }

    if (g_state.deviceId == 0) {
        SDL_AudioSpec want, have;
        SDL_zero(want);
        want.freq = g_state.sampleRate;
        want.format = AUDIO_F32;
        want.channels = g_state.channels;
        want.samples = 1024;
        want.callback = NULL;

        g_state.deviceId = SDL_OpenAudioDevice(NULL, 0, &want, &have, SDL_AUDIO_ALLOW_ANY_CHANGE);
        if (g_state.deviceId == 0) {
            std::cerr << "[C++ SDL2] SDL_OpenAudioDevice failed: " << SDL_GetError() << std::endl;
            return 0;
        }
        g_state.deviceFreq = have.freq;
        g_state.deviceChannels = have.channels;
        printf("[C++ SDL2] Device opened for stream. Freq: %d, Channels: %d\n", have.freq, have.channels);
    }

    g_state.stream = SDL_NewAudioStream(
        AUDIO_F32, g_state.channels, g_state.sampleRate,
        AUDIO_F32, g_state.deviceChannels, g_state.deviceFreq);
    if (!g_state.stream) {
        std::cerr << "[C++ SDL2] SDL_NewAudioStream failed: " << SDL_GetError() << std::endl;
        return 0;
    }
    printf("[C++ SDL2] start_stream ch=%d sr=%d\n", g_state.channels, g_state.sampleRate);
    return 1;
}

/**
 * Queues a chunk unless the device already holds enough audio. Returns the
 * samples accepted; 0 means "full, retry later" — the back-pressure signal.
 */
EMSCRIPTEN_KEEPALIVE
int feed_pcm_chunk(float* data, int samples) {
    if (!data || samples <= 0 || !g_state.streaming || !g_state.deviceId) return 0;
    if (SDL_GetQueuedAudioSize(g_state.deviceId) >= target_queue_bytes()) return 0;

    int accepted = queue_samples(data, samples);
    if (accepted > 0) {
        g_state.streamFedSeconds +=
            (double)accepted / (g_state.channels * g_state.sampleRate);
    }
    return accepted;
}

EMSCRIPTEN_KEEPALIVE
int get_buffer_fill_level() {
    if (!g_state.deviceId) return 0;
    const Uint32 target = target_queue_bytes();
    if (target == 0) return 0;
    Uint32 queued = SDL_GetQueuedAudioSize(g_state.deviceId);
    int pct = (int)((queued * 100ull) / target);
    return pct > 100 ? 100 : pct;
}

EMSCRIPTEN_KEEPALIVE
void set_stream_ended(int ended) {
    g_state.streamEnded = ended != 0;
}

EMSCRIPTEN_KEEPALIVE
void play() {
    if (!g_state.deviceId || g_state.audioBuffer.empty()) return;

    if (g_state.isPlaying) return;

    g_state.isPlaying = true;
    SDL_PauseAudioDevice(g_state.deviceId, 0);

    Uint32 queued = SDL_GetQueuedAudioSize(g_state.deviceId);
    if (queued == 0 && g_state.playHead < g_state.audioBuffer.size()) {
        queue_remaining_audio();
    }
}

EMSCRIPTEN_KEEPALIVE
void pause_audio() {
    if (!g_state.isPlaying) return;
    g_state.isPlaying = false;
    SDL_PauseAudioDevice(g_state.deviceId, 1);
}

EMSCRIPTEN_KEEPALIVE
void resume_audio() {
    if (g_state.isPlaying) return;
    play();
}

EMSCRIPTEN_KEEPALIVE
void stop() {
    if (!g_state.deviceId) return;
    SDL_ClearQueuedAudio(g_state.deviceId);
    if (g_state.stream) SDL_AudioStreamClear(g_state.stream);
    g_state.isPlaying = false;
    g_state.playHead = 0;
    pcm_ring_reset();
}

EMSCRIPTEN_KEEPALIVE
void seek(float time) {
    if (g_state.streaming) {
        std::cerr << "[C++ SDL2] seek ignored: unsupported in streaming mode" << std::endl;
        return;
    }
    if (!g_state.deviceId || g_state.audioBuffer.empty()) return;

    size_t sampleIndex = (size_t)(time * g_state.sampleRate) * g_state.channels;
    sampleIndex = sampleIndex - (sampleIndex % g_state.channels);
    if (sampleIndex >= g_state.audioBuffer.size()) sampleIndex = g_state.audioBuffer.size();

    g_state.playHead = sampleIndex;

    SDL_ClearQueuedAudio(g_state.deviceId);
    if (g_state.stream) SDL_AudioStreamClear(g_state.stream);
    pcm_ring_reset();

    if (g_state.isPlaying) {
        queue_remaining_audio();
    }
}

EMSCRIPTEN_KEEPALIVE
float get_current_time() {
    if (!g_state.deviceId) return 0.0f;
    if (!g_state.streaming && g_state.audioBuffer.empty()) return 0.0f;

    Uint32 queuedBytes = SDL_GetQueuedAudioSize(g_state.deviceId);

    double queuedSeconds = (double)queuedBytes / (sizeof(float) * g_state.deviceChannels * g_state.deviceFreq);

    // Streaming has no full buffer to measure against, so position is what has
    // been fed minus what is still sitting in the device queue.
    if (g_state.streaming) {
        double t = g_state.streamFedSeconds - queuedSeconds;
        return (float)(t < 0 ? 0 : t);
    }

    double totalDuration = (double)g_state.audioBuffer.size() / (g_state.channels * g_state.sampleRate);

    double currentTime = totalDuration - queuedSeconds;

    if (currentTime < 0) currentTime = 0;
    if (currentTime > totalDuration) currentTime = totalDuration;

    return (float)currentTime;
}

EMSCRIPTEN_KEEPALIVE
void set_volume(float vol) {
    g_state.volume = std::max(0.0f, std::min(1.0f, vol));
}

EMSCRIPTEN_KEEPALIVE
PcmRingState* get_pcm_ring_state() {
    return &g_pcmRing;
}

EMSCRIPTEN_KEEPALIVE
float* get_pcm_ring_data() {
    return pcm_ring_data();
}

EMSCRIPTEN_KEEPALIVE
void cleanup() {
    if (g_state.stream) SDL_FreeAudioStream(g_state.stream);
    if (g_state.deviceId) SDL_CloseAudioDevice(g_state.deviceId);
    g_state.audioBuffer.clear();
    pcm_ring_cleanup();
    SDL_Quit();
}

#ifdef __cplusplus
}
#endif
