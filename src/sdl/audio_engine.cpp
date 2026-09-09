#include <SDL3/SDL.h>
#include <emscripten.h>
#include <vector>
#include <iostream>
#include <cmath>
#include <algorithm>
#include "pcm_ring.h"
#include "play_ring.h"

#ifdef __cplusplus
extern "C" {
#endif

struct PlayerState {
    SDL_AudioStream* stream = nullptr;
    std::vector<float> audioBuffer;
    bool isPlaying = false;
    bool streamMode = false;
    float volume = 1.0f;
    int sampleRate = 0;
    int channels = 2;
    size_t playHead = 0; // Index in float samples (buffered path) / samples consumed (stream)
    SDL_AudioDeviceID deviceId = 0;
} g_state;

// Bounded callback drain (no heap alloc). SDL additional_amount is typically a few KB.
static float g_callbackScratch[8192];

void SDLCALL fill_audio_callback(void *userdata, SDL_AudioStream *stream, int additional_amount, int total_amount);

static void destroy_stream() {
    if (g_state.stream) {
        SDL_DestroyAudioStream(g_state.stream);
        g_state.stream = nullptr;
    }
}

// Opens an SDL_AudioStream at the *file* rate/channels with identical in/out specs.
// SDL_OpenAudioDevice(..., NULL) uses the device native format; bind may resample
// if device freq/channels differ from this stream.
static int configure_stream(int channels, int sampleRate) {
    destroy_stream();

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
        return 0;
    }

    SDL_SetAudioStreamGetCallback(g_state.stream, fill_audio_callback, nullptr);

    if (!SDL_BindAudioStream(g_state.deviceId, g_state.stream)) {
        std::cerr << "[C++] SDL_BindAudioStream failed: " << SDL_GetError() << std::endl;
        return 0;
    }
    return 1;
}

// ---------------------------------------------------------
// SDL3 Stream Callback
// Automatically called by SDL's audio pump when it needs data
// ---------------------------------------------------------
void SDLCALL fill_audio_callback(void *userdata, SDL_AudioStream *stream, int additional_amount, int total_amount) {
    (void)userdata;
    (void)total_amount;

    if (!g_state.isPlaying) {
        return;
    }

    int floatsWanted = additional_amount / (int)sizeof(float);
    if (floatsWanted <= 0) return;
    floatsWanted = std::min(floatsWanted, (int)(sizeof(g_callbackScratch) / sizeof(g_callbackScratch[0])));

    if (g_state.streamMode) {
        int got = play_ring_read(g_callbackScratch, floatsWanted);
        if (got > 0) {
            const float* scaled = scale_samples(g_callbackScratch, got, g_state.volume);
            pcm_ring_write(scaled, got);
            SDL_PutAudioStreamData(stream, scaled, got * (int)sizeof(float));
            g_state.playHead += (size_t)got;
        }
        if (play_ring_fill() == 0 && play_ring_ended()) {
            g_state.isPlaying = false;
        }
        return;
    }

    if (g_state.audioBuffer.empty()) {
        return;
    }

    size_t samplesRemaining = g_state.audioBuffer.size() - g_state.playHead;
    if (samplesRemaining == 0) {
        g_state.isPlaying = false;
        return;
    }

    int floatsToPush = (int)std::min(samplesRemaining, (size_t)floatsWanted);
    const float* src = &g_state.audioBuffer[g_state.playHead];
    const float* scaled = scale_samples(src, floatsToPush, g_state.volume);

    pcm_ring_write(scaled, floatsToPush);
    SDL_PutAudioStreamData(stream, scaled, floatsToPush * (int)sizeof(float));

    g_state.playHead += (size_t)floatsToPush;

    if (g_state.playHead >= g_state.audioBuffer.size()) {
        g_state.isPlaying = false;
    }
}

EMSCRIPTEN_KEEPALIVE
int init_audio() {
    printf("[C++] init_audio called\n");
    if (!SDL_Init(SDL_INIT_AUDIO)) {
        std::cerr << "[C++] SDL_Init failed: " << SDL_GetError() << std::endl;
        return 0;
    }

    // Device native format (NULL spec). Stream is created later at file rate;
    // SDL3 may resample on bind if device != file.
    g_state.deviceId = SDL_OpenAudioDevice(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK, NULL);
    if (g_state.deviceId == 0) {
        std::cerr << "[C++] SDL_OpenAudioDevice failed: " << SDL_GetError() << std::endl;
        return 0;
    }

    pcm_ring_init(65536);
    play_ring_init(PLAY_RING_CAPACITY);
    printf("[C++] init_audio success. Device ID: %u play_ring=%u floats\n",
           g_state.deviceId, PLAY_RING_CAPACITY);
    return 1;
}

EMSCRIPTEN_KEEPALIVE
float* create_audio_buffer(int length) {
    try {
        g_state.streamMode = false;
        g_state.audioBuffer.resize(length);
        return g_state.audioBuffer.data();
    } catch (const std::exception& e) {
        std::cerr << "[C++] Error resizing audio buffer: " << e.what() << std::endl;
        return nullptr;
    }
}

EMSCRIPTEN_KEEPALIVE
void set_audio_data(int length, int channels, int sampleRate) {
    if (g_state.audioBuffer.size() != (size_t)length) {
        std::cerr << "[C++] Buffer size mismatch." << std::endl;
        return;
    }

    g_state.streamMode = false;
    play_ring_reset();
    configure_stream(channels, sampleRate);
}

EMSCRIPTEN_KEEPALIVE
void set_stream_format(int channels, int sampleRate) {
    g_state.streamMode = true;
    g_state.audioBuffer.clear();
    g_state.audioBuffer.shrink_to_fit();
    play_ring_reset();
    configure_stream(channels, sampleRate);
}

EMSCRIPTEN_KEEPALIVE
int push_pcm(const float* samples, int count) {
    return play_ring_push(samples, count);
}

EMSCRIPTEN_KEEPALIVE
int get_play_ring_fill() {
    return (int)play_ring_fill();
}

EMSCRIPTEN_KEEPALIVE
int get_play_ring_capacity() {
    return (int)play_ring_capacity();
}

EMSCRIPTEN_KEEPALIVE
void set_stream_ended(int ended) {
    play_ring_set_ended(ended);
}

EMSCRIPTEN_KEEPALIVE
void play() {
    if (!g_state.stream) return;
    if (!g_state.streamMode && g_state.audioBuffer.empty()) return;

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
    play_ring_reset();
    pcm_ring_reset();
}

EMSCRIPTEN_KEEPALIVE
void seek(float time) {
    if (g_state.streamMode) return;
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
    if (!g_state.stream || g_state.sampleRate <= 0 || g_state.channels <= 0) return 0.0f;
    if (!g_state.streamMode && g_state.audioBuffer.empty()) return 0.0f;

    int queuedBytes = SDL_GetAudioStreamAvailable(g_state.stream);
    size_t queuedSamples = queuedBytes / sizeof(float);

    size_t audibleSampleIndex = 0;
    if (g_state.playHead > queuedSamples) {
        audibleSampleIndex = g_state.playHead - queuedSamples;
    }

    size_t frames = audibleSampleIndex / (size_t)g_state.channels;
    return (float)frames / (float)g_state.sampleRate;
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
    destroy_stream();
    if (g_state.deviceId) {
        SDL_CloseAudioDevice(g_state.deviceId);
        g_state.deviceId = 0;
    }
    g_state.audioBuffer.clear();
    g_state.audioBuffer.shrink_to_fit();
    play_ring_cleanup();
    pcm_ring_cleanup();
    SDL_Quit();
}

#ifdef __cplusplus
}
#endif
