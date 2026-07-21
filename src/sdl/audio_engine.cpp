#include <SDL3/SDL.h>
#include <emscripten.h>
#include <vector>
#include <iostream>
#include <cmath>
#include <algorithm>
#include "pcm_ring.h"
#include "feed_ring.h"

#ifdef __cplusplus
extern "C" {
#endif

// Buffered: whole track resident in audioBuffer, arbitrary seek.
// Streaming: only feed_ring is resident, fed in chunks from JS. Seek is not
// supported in this mode (matching the AudioWorklet hi-fi stream path); the
// JS side restarts the pipeline instead.
void SDLCALL fill_audio_callback(void *userdata, SDL_AudioStream *stream, int additional_amount, int total_amount);

enum PlaybackMode { MODE_BUFFERED = 0, MODE_STREAMING = 1 };

struct PlayerState {
    SDL_AudioStream* stream = nullptr;
    std::vector<float> audioBuffer;
    bool isPlaying = false;
    float volume = 1.0f;
    int sampleRate = 44100;
    int channels = 2;
    size_t playHead = 0; // Index in float samples
    SDL_AudioDeviceID deviceId = 0;
    PlaybackMode mode = MODE_BUFFERED;
    // Streaming bookkeeping
    bool streamEnded = false;              // JS signalled end-of-decode
    uint64_t streamSamplesConsumed = 0;    // total floats pulled from feed ring
} g_state;

// Scratch for moving samples out of the feed ring inside the audio callback.
static std::vector<float> g_feedScratch;

/** Set up the SDL audio stream for the current channels/sampleRate. */
static bool create_stream_locked() {
    if (g_state.stream) {
        SDL_DestroyAudioStream(g_state.stream);
        g_state.stream = nullptr;
    }

    SDL_AudioSpec spec;
    spec.channels = g_state.channels;
    spec.format = SDL_AUDIO_F32;
    spec.freq = g_state.sampleRate;

    g_state.stream = SDL_CreateAudioStream(&spec, &spec);
    if (!g_state.stream) {
        std::cerr << "[C++] SDL_CreateAudioStream failed: " << SDL_GetError() << std::endl;
        return false;
    }

    SDL_SetAudioStreamGetCallback(g_state.stream, fill_audio_callback, nullptr);

    if (!SDL_BindAudioStream(g_state.deviceId, g_state.stream)) {
        std::cerr << "[C++] SDL_BindAudioStream failed: " << SDL_GetError() << std::endl;
        return false;
    }
    return true;
}

// ---------------------------------------------------------
// SDL3 Stream Callback
// Automatically called by SDL's audio pump when it needs data
// ---------------------------------------------------------
void SDLCALL fill_audio_callback(void *userdata, SDL_AudioStream *stream, int additional_amount, int total_amount) {
    (void)userdata;
    (void)total_amount;

    if (!g_state.isPlaying) return;

    if (g_state.mode == MODE_STREAMING) {
        int floatsWanted = additional_amount / (int)sizeof(float);
        if (floatsWanted <= 0) return;

        g_feedScratch.resize((size_t)floatsWanted);
        uint32_t got = feed_ring_read(g_feedScratch.data(), (uint32_t)floatsWanted);

        if (got == 0) {
            // Underrun. If JS says the stream is done, playback is over;
            // otherwise stay silent and wait for the next chunk.
            if (g_state.streamEnded) g_state.isPlaying = false;
            return;
        }

        const float* scaled = scale_samples(g_feedScratch.data(), (int)got, g_state.volume);
        pcm_ring_write(scaled, (int)got);
        SDL_PutAudioStreamData(stream, scaled, (int)(got * sizeof(float)));
        g_state.streamSamplesConsumed += got;
        return;
    }

    if (g_state.audioBuffer.empty()) {
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
    g_state.mode = MODE_BUFFERED;
    g_state.streamEnded = false;
    g_state.streamSamplesConsumed = 0;
    feed_ring_cleanup();
    pcm_ring_reset();

    create_stream_locked();
}

EMSCRIPTEN_KEEPALIVE
int start_stream(int channels, int sampleRate, int bufferSeconds) {
    g_state.channels = channels > 0 ? channels : 2;
    g_state.sampleRate = sampleRate > 0 ? sampleRate : 44100;
    g_state.mode = MODE_STREAMING;
    g_state.streamEnded = false;
    g_state.streamSamplesConsumed = 0;
    g_state.playHead = 0;
    g_state.isPlaying = false;
    g_state.audioBuffer.clear();
    g_state.audioBuffer.shrink_to_fit();

    // Bound the resident audio. 8s stereo @48k is ~3 MB, versus hundreds of MB
    // for a whole 24/96 album track.
    int seconds = bufferSeconds > 0 ? bufferSeconds : 8;
    long long capacity = (long long)g_state.sampleRate * g_state.channels * seconds;
    const long long kMaxCapacity = 4ll * 1024 * 1024; // 16 MB of float
    if (capacity > kMaxCapacity) capacity = kMaxCapacity;

    feed_ring_init((int)capacity);
    pcm_ring_reset();

    if (!create_stream_locked()) return 0;
    printf("[C++] start_stream ch=%d sr=%d ring=%lld floats\n",
           g_state.channels, g_state.sampleRate, capacity);
    return 1;
}

/**
 * Accepts as many samples as the ring has room for and returns that count.
 * A short return is the back-pressure signal: JS must retry the remainder.
 */
EMSCRIPTEN_KEEPALIVE
int feed_pcm_chunk(float* data, int samples) {
    if (!data || samples <= 0 || g_state.mode != MODE_STREAMING) return 0;
    return (int)feed_ring_write(data, (uint32_t)samples);
}

EMSCRIPTEN_KEEPALIVE
int get_buffer_fill_level() {
    return feed_ring_fill_percent();
}

EMSCRIPTEN_KEEPALIVE
void set_stream_ended(int ended) {
    g_state.streamEnded = ended != 0;
}

EMSCRIPTEN_KEEPALIVE
void play() {
    if (!g_state.stream) return;
    if (g_state.mode == MODE_BUFFERED && g_state.audioBuffer.empty()) return;

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
    if (g_state.mode == MODE_STREAMING) {
        feed_ring_reset();
        g_state.streamSamplesConsumed = 0;
        g_state.streamEnded = false;
    }
    pcm_ring_reset();
}

EMSCRIPTEN_KEEPALIVE
void seek(float time) {
    // Streaming mode holds only a few seconds of audio, so there is nothing to
    // seek within. JS restarts the decode pipeline at the new offset instead.
    if (g_state.mode == MODE_STREAMING) {
        std::cerr << "[C++] seek ignored: unsupported in streaming mode" << std::endl;
        return;
    }
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
    if (!g_state.stream) return 0.0f;
    if (g_state.mode == MODE_BUFFERED && g_state.audioBuffer.empty()) return 0.0f;

    int queuedBytes = SDL_GetAudioStreamAvailable(g_state.stream);
    size_t queuedSamples = queuedBytes / sizeof(float);

    // In streaming mode the play position is the running count of samples the
    // callback has pulled, since there is no buffer to index into.
    size_t consumed = g_state.mode == MODE_STREAMING
        ? (size_t)g_state.streamSamplesConsumed
        : g_state.playHead;

    size_t audibleSampleIndex = 0;
    if (consumed > queuedSamples) {
        audibleSampleIndex = consumed - queuedSamples;
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
    feed_ring_cleanup();
    pcm_ring_cleanup();
    SDL_Quit();
}

#ifdef __cplusplus
}
#endif
