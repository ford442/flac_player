#include <SDL3/SDL.h>
#include <emscripten.h>
#include <vector>
#include <iostream>
#include <cstdio>
#include <cmath>
#include <algorithm>
#include "pcm_ring.h"
#include "play_ring.h"
#include "dsp_chain.h"

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
    dsp_request_reset();

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
        destroy_stream();
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

    // Speaker DSP (ReplayGain -> limiter -> volume -> EQ) runs in place on the
    // scratch copy; the viz ring receives the processed signal the user hears.
    if (g_state.streamMode) {
        int got = play_ring_read(g_callbackScratch, floatsWanted);
        if (got > 0) {
            dsp_process(g_callbackScratch, got, g_state.channels, g_state.sampleRate, g_state.volume);
            pcm_ring_write(g_callbackScratch, got);
            SDL_PutAudioStreamData(stream, g_callbackScratch, got * (int)sizeof(float));
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
    std::copy_n(&g_state.audioBuffer[g_state.playHead], floatsToPush, g_callbackScratch);
    dsp_process(g_callbackScratch, floatsToPush, g_state.channels, g_state.sampleRate, g_state.volume);

    pcm_ring_write(g_callbackScratch, floatsToPush);
    SDL_PutAudioStreamData(stream, g_callbackScratch, floatsToPush * (int)sizeof(float));

    g_state.playHead += (size_t)floatsToPush;

    if (g_state.playHead >= g_state.audioBuffer.size()) {
        g_state.isPlaying = false;
    }
}

EMSCRIPTEN_KEEPALIVE
int init_audio() {
#ifndef NDEBUG
    printf("[C++] init_audio called\n");
#endif
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
#ifndef NDEBUG
    printf("[C++] init_audio success. Device ID: %u play_ring=%u floats\n",
           g_state.deviceId, PLAY_RING_CAPACITY);
#endif
    return 1;
}

// 384 MiB of f32 PCM; leaves ~128 MiB inside the 512 MiB WASM ceiling
// for SDL, pthread stacks, play/viz rings, and fragmentation.
static constexpr int kMaxBufferedFloats = (384 * 1024 * 1024) / (int)sizeof(float); // 100663296

EMSCRIPTEN_KEEPALIVE
float* create_audio_buffer(int length) {
    if (length <= 0 || length > kMaxBufferedFloats) {
        std::cerr << "[C++] create_audio_buffer rejected length=" << length << std::endl;
        return nullptr;
    }
    g_state.streamMode = false;
    // resize may still throw std::bad_alloc / abort on fragmentation OOM
    // inside the cap. Until DISABLE_EXCEPTION_CATCHING, that is an uncaught
    // wasm exception, not nullptr.
    g_state.audioBuffer.resize((size_t)length);
    return g_state.audioBuffer.data();
}

EMSCRIPTEN_KEEPALIVE
int set_audio_data(int length, int channels, int sampleRate) {
    if (g_state.audioBuffer.size() != (size_t)length) {
        std::cerr << "[C++] Buffer size mismatch." << std::endl;
        return 0;
    }
    g_state.streamMode = false;
    play_ring_reset();
    return configure_stream(channels, sampleRate);
}

EMSCRIPTEN_KEEPALIVE
int set_stream_format(int channels, int sampleRate) {
    g_state.streamMode = true;
    g_state.audioBuffer.clear();
    g_state.audioBuffer.shrink_to_fit();
    play_ring_reset();
    return configure_stream(channels, sampleRate);
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
    dsp_request_reset();
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
    dsp_request_reset();
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

// EQ band from JS DEFAULT_EQ_BANDS. type: 0 lowshelf, 1 peaking, 2 highshelf.
EMSCRIPTEN_KEEPALIVE
void set_eq_band(int index, int type, float freq, float q, float gainDb) {
    dsp_set_eq_band(index, type, freq, q, gainDb);
}

// ReplayGain stage before volume (linear, unclamped above 1) + peak limiter toggle.
EMSCRIPTEN_KEEPALIVE
void set_replaygain(float linear, int limiterEnabled) {
    dsp_set_replaygain(linear, limiterEnabled);
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
