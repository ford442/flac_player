#include <SDL3/SDL.h>
#include <emscripten.h>
#include <vector>
#include <iostream>
#include <cmath>

// Define exports to ensure they are available to JS
#ifdef __cplusplus
extern "C" {
#endif

// Global state
struct PlayerState {
    SDL_AudioStream* stream = nullptr;
    std::vector<float> audioBuffer;
    bool isPlaying = false;
    float volume = 1.0f;
    int sampleRate = 44100;
    int channels = 2;
    // We track time manually based on how much data we've pushed or
    // simply by the stream position if possible.
    // However, SDL_AudioStream is a buffer.
    // To implement "Play/Pause/Seek" accurately with a large buffer:
    // We will clear the stream and push data from the current offset.
    size_t playHead = 0; // Index in float samples
    SDL_AudioDeviceID deviceId = 0;
} g_state;

EMSCRIPTEN_KEEPALIVE
int init_audio() {
    printf("[C++] init_audio called\n");
    // SDL3 returns bool (true on success)
    if (!SDL_Init(SDL_INIT_AUDIO)) {
        std::cerr << "[C++] SDL_Init failed: " << SDL_GetError() << std::endl;
        return 0;
    }

    // Open default playback device
    g_state.deviceId = SDL_OpenAudioDevice(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK, NULL);
    if (g_state.deviceId == 0) {
        std::cerr << "[C++] SDL_OpenAudioDevice failed: " << SDL_GetError() << std::endl;
        return 0;
    }

    printf("[C++] init_audio success. Device ID: %u\n", g_state.deviceId);
    return 1;
}

EMSCRIPTEN_KEEPALIVE
void set_audio_data(float* data, int length, int channels, int sampleRate) {
    printf("[C++] set_audio_data called. Length: %d, Channels: %d, Rate: %d\n", length, channels, sampleRate);

    // Stop current playback
    if (g_state.stream) {
        SDL_DestroyAudioStream(g_state.stream);
        g_state.stream = nullptr;
    }

    // Update state
    try {
        printf("[C++] Assigning to g_state.audioBuffer...\n");
        g_state.audioBuffer.assign(data, data + length);
        printf("[C++] g_state.audioBuffer assigned. Size: %zu\n", g_state.audioBuffer.size());
    } catch (const std::exception& e) {
        std::cerr << "[C++] Error assigning audio buffer: " << e.what() << std::endl;
        return;
    }

    g_state.channels = channels;
    g_state.sampleRate = sampleRate;
    g_state.playHead = 0;
    g_state.isPlaying = false;

    // Create a new stream matching the audio format
    SDL_AudioSpec spec;
    spec.channels = channels;
    spec.format = SDL_AUDIO_F32;
    spec.freq = sampleRate;

    g_state.stream = SDL_CreateAudioStream(&spec, &spec);
    if (!g_state.stream) {
        std::cerr << "[C++] SDL_CreateAudioStream failed: " << SDL_GetError() << std::endl;
        return;
    }

    // Bind stream to device (SDL3 returns bool)
    if (!SDL_BindAudioStream(g_state.deviceId, g_state.stream)) {
        std::cerr << "[C++] SDL_BindAudioStream failed: " << SDL_GetError() << std::endl;
    }
    printf("[C++] set_audio_data completed successfully.\n");
}

EMSCRIPTEN_KEEPALIVE
void play() {
    if (!g_state.stream || g_state.audioBuffer.empty()) return;

    if (g_state.isPlaying) return;

    g_state.isPlaying = true;
    SDL_ResumeAudioDevice(g_state.deviceId); // Ensure device is playing

    // Check if stream is empty. If so, push data from playHead.
    // How to check if stream is empty? SDL_GetAudioStreamAvailable(stream) (returns bytes queued)

    int queued = SDL_GetAudioStreamAvailable(g_state.stream);
    if (queued == 0 && g_state.playHead < g_state.audioBuffer.size()) {
        // Push all remaining data
        size_t samplesRemaining = g_state.audioBuffer.size() - g_state.playHead;
        SDL_PutAudioStreamData(g_state.stream, &g_state.audioBuffer[g_state.playHead], samplesRemaining * sizeof(float));
    }
}

EMSCRIPTEN_KEEPALIVE
void pause_audio() {
    if (!g_state.isPlaying) return;

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
}

EMSCRIPTEN_KEEPALIVE
void seek(float time) {
    if (!g_state.stream || g_state.audioBuffer.empty()) return;

    // Calculate sample index
    size_t sampleIndex = (size_t)(time * g_state.sampleRate) * g_state.channels;

    // Align to channels
    sampleIndex = sampleIndex - (sampleIndex % g_state.channels);

    if (sampleIndex >= g_state.audioBuffer.size()) {
        sampleIndex = g_state.audioBuffer.size();
    }

    g_state.playHead = sampleIndex;

    // Clear existing data in stream
    SDL_ClearAudioStream(g_state.stream);

    // If we are currently playing, push new data immediately
    if (g_state.isPlaying) {
        size_t samplesRemaining = g_state.audioBuffer.size() - g_state.playHead;
        if (samplesRemaining > 0) {
            SDL_PutAudioStreamData(g_state.stream, &g_state.audioBuffer[g_state.playHead], samplesRemaining * sizeof(float));
        }
    }
}

EMSCRIPTEN_KEEPALIVE
float get_current_time() {
    if (!g_state.stream) return 0.0f;

    if (g_state.audioBuffer.empty()) return 0.0f;

    // Bytes currently in the stream (not yet played)
    int queuedBytes = SDL_GetAudioStreamAvailable(g_state.stream);

    // Samples remaining to be played from what we pushed
    size_t samplesQueued = queuedBytes / sizeof(float);

    // Samples we INTENDED to play (from playHead to end)
    size_t totalSamplesToPlay = g_state.audioBuffer.size() - g_state.playHead;

    // Samples actually played so far since the last seek/play
    size_t samplesPlayedSinceSeek = totalSamplesToPlay - samplesQueued;

    size_t currentSampleIndex = g_state.playHead + samplesPlayedSinceSeek;

    if (currentSampleIndex > g_state.audioBuffer.size()) currentSampleIndex = g_state.audioBuffer.size();

    // Convert to seconds
    // Each frame has `channels` samples
    size_t frames = currentSampleIndex / g_state.channels;
    return (float)frames / g_state.sampleRate;
}

EMSCRIPTEN_KEEPALIVE
void set_volume(float vol) {
    g_state.volume = vol;
    if (g_state.stream) {
        SDL_SetAudioStreamGain(g_state.stream, vol);
    }
}

EMSCRIPTEN_KEEPALIVE
void cleanup() {
    printf("[C++] cleanup called\n");
    if (g_state.stream) {
        SDL_DestroyAudioStream(g_state.stream);
        g_state.stream = nullptr;
    }
    if (g_state.deviceId) {
        SDL_CloseAudioDevice(g_state.deviceId);
        g_state.deviceId = 0;
    }
    g_state.audioBuffer.clear();
    SDL_Quit();
}

#ifdef __cplusplus
}
#endif
