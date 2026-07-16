#include <SDL3/SDL.h>
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
    size_t playHead = 0; // Index in float samples
    SDL_AudioDeviceID deviceId = 0;
} g_state;

// ---------------------------------------------------------
// SDL3 Stream Callback
// Automatically called by SDL's audio pump when it needs data
// ---------------------------------------------------------
void SDLCALL fill_audio_callback(void *userdata, SDL_AudioStream *stream, int additional_amount, int total_amount) {
    (void)userdata;
    (void)total_amount;

    if (!g_state.isPlaying || g_state.audioBuffer.empty()) {
        return;
    }

    size_t samplesRemaining = g_state.audioBuffer.size() - g_state.playHead;
    size_t bytesRemaining = samplesRemaining * sizeof(float);

    if (bytesRemaining > 0) {
        int bytesToPush = std::min((int)bytesRemaining, additional_amount);
        int floatsToPush = bytesToPush / (int)sizeof(float);

        const float* src = &g_state.audioBuffer[g_state.playHead];
        const float* scaled = scale_samples(src, floatsToPush, g_state.volume);

        pcm_ring_write(scaled, floatsToPush);
        SDL_PutAudioStreamData(stream, scaled, bytesToPush);

        g_state.playHead += floatsToPush;

        if (g_state.playHead >= g_state.audioBuffer.size()) {
            g_state.isPlaying = false;
        }
    }
}

EMSCRIPTEN_KEEPALIVE
int init_audio() {
    printf("[C++] init_audio called\n");
    if (!SDL_Init(SDL_INIT_AUDIO)) {
        std::cerr << "[C++] SDL_Init failed: " << SDL_GetError() << std::endl;
        return 0;
    }

    g_state.deviceId = SDL_OpenAudioDevice(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK, NULL);
    if (g_state.deviceId == 0) {
        std::cerr << "[C++] SDL_OpenAudioDevice failed: " << SDL_GetError() << std::endl;
        return 0;
    }

    pcm_ring_init(65536);
    printf("[C++] init_audio success. Device ID: %u\n", g_state.deviceId);
    return 1;
}

EMSCRIPTEN_KEEPALIVE
float* create_audio_buffer(int length) {
    try {
        g_state.audioBuffer.resize(length);
        return g_state.audioBuffer.data();
    } catch (const std::exception& e) {
        std::cerr << "[C++] Error resizing audio buffer: " << e.what() << std::endl;
        return nullptr;
    }
}

EMSCRIPTEN_KEEPALIVE
void set_audio_data(int length, int channels, int sampleRate) {
    if (g_state.stream) {
        SDL_DestroyAudioStream(g_state.stream);
        g_state.stream = nullptr;
    }

    if (g_state.audioBuffer.size() != (size_t)length) {
        std::cerr << "[C++] Buffer size mismatch." << std::endl;
        return;
    }

    g_state.channels = channels;
    g_state.sampleRate = sampleRate;
    g_state.playHead = 0;
    g_state.isPlaying = false;
    pcm_ring_reset();

    SDL_AudioSpec spec;
    spec.channels = channels;
    spec.format = SDL_AUDIO_F32;
    spec.freq = sampleRate;

    g_state.stream = SDL_CreateAudioStream(&spec, &spec);
    if (!g_state.stream) {
        std::cerr << "[C++] SDL_CreateAudioStream failed: " << SDL_GetError() << std::endl;
        return;
    }

    SDL_SetAudioStreamGetCallback(g_state.stream, fill_audio_callback, nullptr);

    if (!SDL_BindAudioStream(g_state.deviceId, g_state.stream)) {
        std::cerr << "[C++] SDL_BindAudioStream failed: " << SDL_GetError() << std::endl;
    }
}

EMSCRIPTEN_KEEPALIVE
void play() {
    if (!g_state.stream || g_state.audioBuffer.empty()) return;

    g_state.isPlaying = true;
    SDL_ResumeAudioDevice(g_state.deviceId);
}

EMSCRIPTEN_KEEPALIVE
void pause_audio() {
    g_state.isPlaying = false;
    SDL_PauseAudioDevice(g_state.deviceId);
}

EMSCRIPTEN_KEEPALIVE
void resume_audio() {
    if (g_state.isPlaying) return;
    g_state.isPlaying = true;
    SDL_ResumeAudioDevice(g_state.deviceId);
}

EMSCRIPTEN_KEEPALIVE
void stop() {
    if (!g_state.stream) return;
    SDL_ClearAudioStream(g_state.stream);
    g_state.isPlaying = false;
    g_state.playHead = 0;
    pcm_ring_reset();
}

EMSCRIPTEN_KEEPALIVE
void seek(float time) {
    if (!g_state.stream || g_state.audioBuffer.empty()) return;

    size_t sampleIndex = (size_t)(time * g_state.sampleRate) * g_state.channels;
    sampleIndex = sampleIndex - (sampleIndex % g_state.channels);

    if (sampleIndex >= g_state.audioBuffer.size()) {
        sampleIndex = g_state.audioBuffer.size();
    }

    SDL_ClearAudioStream(g_state.stream);
    g_state.playHead = sampleIndex;
    pcm_ring_reset();
}

EMSCRIPTEN_KEEPALIVE
float get_current_time() {
    if (!g_state.stream || g_state.audioBuffer.empty()) return 0.0f;

    int queuedBytes = SDL_GetAudioStreamAvailable(g_state.stream);
    size_t queuedSamples = queuedBytes / sizeof(float);

    size_t audibleSampleIndex = 0;
    if (g_state.playHead > queuedSamples) {
        audibleSampleIndex = g_state.playHead - queuedSamples;
    }

    size_t frames = audibleSampleIndex / g_state.channels;
    return (float)frames / g_state.sampleRate;
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
    if (g_state.stream) {
        SDL_DestroyAudioStream(g_state.stream);
        g_state.stream = nullptr;
    }
    if (g_state.deviceId) {
        SDL_CloseAudioDevice(g_state.deviceId);
        g_state.deviceId = 0;
    }
    g_state.audioBuffer.clear();
    pcm_ring_cleanup();
    SDL_Quit();
}

#ifdef __cplusplus
}
#endif
