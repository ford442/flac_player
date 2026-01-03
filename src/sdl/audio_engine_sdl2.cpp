#include <SDL2/SDL.h>
#include <emscripten.h>
#include <vector>
#include <iostream>
#include <cmath>

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
} g_state;

EMSCRIPTEN_KEEPALIVE
int init_audio() {
    printf("[C++ SDL2] init_audio called\n");
    if (SDL_Init(SDL_INIT_AUDIO) != 0) {
        std::cerr << "[C++ SDL2] SDL_Init failed: " << SDL_GetError() << std::endl;
        return 0;
    }

    // Open default playback device (dummy init)
    SDL_AudioSpec want, have;
    SDL_zero(want);
    want.freq = 44100;
    want.format = AUDIO_F32;
    want.channels = 2;
    want.samples = 1024;
    want.callback = NULL;

    g_state.deviceId = SDL_OpenAudioDevice(NULL, 0, &want, &have, 0);
    if (g_state.deviceId == 0) {
        std::cerr << "[C++ SDL2] SDL_OpenAudioDevice failed: " << SDL_GetError() << std::endl;
        return 0;
    }

    g_state.deviceFreq = have.freq;
    g_state.deviceChannels = have.channels;

    printf("[C++ SDL2] init_audio success. Device ID: %u, Freq: %d\n", g_state.deviceId, have.freq);
    return 1;
}

EMSCRIPTEN_KEEPALIVE
void set_audio_data(float* data, int length, int channels, int sampleRate) {
    printf("[C++ SDL2] set_audio_data called. Length: %d, Channels: %d, Rate: %d\n", length, channels, sampleRate);

    if (g_state.stream) {
        SDL_FreeAudioStream(g_state.stream);
        g_state.stream = nullptr;
    }

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

    SDL_AudioSpec want, have;
    SDL_zero(want);
    want.freq = sampleRate;
    want.format = AUDIO_F32;
    want.channels = channels;
    want.samples = 1024;
    want.callback = NULL;

    // Allow frequency changes (0 as last arg to SDL_OpenAudioDevice means SDL can change specs if hardware doesn't support request)
    // Actually, passing 0 for allowed_changes means "I want exactly this, if not, SDL can simulate/convert".
    // Wait, SDL_OpenAudioDevice docs:
    // "allowed_changes: If 0, SDL will match the requested format exactly, or fail." -> THIS IS WRONG for Web (Emscripten).
    // In Emscripten, SDL_OpenAudioDevice usually gets the browser context.
    // If we want SDL to handle conversion, we should check `have` vs `want`.
    // We will use AudioStream for conversion regardless, so we just take what we get.

    g_state.deviceId = SDL_OpenAudioDevice(NULL, 0, &want, &have, SDL_AUDIO_ALLOW_ANY_CHANGE);

    if (g_state.deviceId == 0) {
         std::cerr << "[C++ SDL2] SDL_OpenAudioDevice failed: " << SDL_GetError() << std::endl;
         return;
    }

    g_state.deviceFreq = have.freq;
    g_state.deviceChannels = have.channels;

    printf("[C++ SDL2] Device opened. Freq: %d, Channels: %d\n", have.freq, have.channels);

    // Create stream converting from Source -> Device
    g_state.stream = SDL_NewAudioStream(AUDIO_F32, channels, sampleRate,
                                        have.format, have.channels, have.freq);

    if (!g_state.stream) {
        std::cerr << "[C++ SDL2] SDL_NewAudioStream failed: " << SDL_GetError() << std::endl;
        return;
    }
}

EMSCRIPTEN_KEEPALIVE
void play() {
    if (!g_state.deviceId || g_state.audioBuffer.empty()) return;

    if (g_state.isPlaying) return;

    g_state.isPlaying = true;
    SDL_PauseAudioDevice(g_state.deviceId, 0);

    // If we haven't queued everything yet (or if we just started), queue it all.
    // Check if device is starving?
    // SDL_QueueAudio appends.
    // We only want to append ONCE per seek/play-start.
    // But `play()` can be called after `pause()`.
    // If we paused, the queue is still there. We just unpause.

    // Only if queue is empty AND we haven't finished, we push.
    // But how do we know if we finished?
    // We'll trust that if queue is empty, we need to push.
    // But if we just seeked, we cleared queue.

    Uint32 queued = SDL_GetQueuedAudioSize(g_state.deviceId);
    if (queued == 0 && g_state.playHead < g_state.audioBuffer.size()) {
        size_t samplesRemaining = g_state.audioBuffer.size() - g_state.playHead;

        SDL_AudioStreamPut(g_state.stream, &g_state.audioBuffer[g_state.playHead], samplesRemaining * sizeof(float));

        int available = SDL_AudioStreamAvailable(g_state.stream);
        if (available > 0) {
            std::vector<Uint8> converted(available);
            int got = SDL_AudioStreamGet(g_state.stream, converted.data(), available);
            if (got > 0) {
                SDL_QueueAudio(g_state.deviceId, converted.data(), got);
            }
        }
        // Once pushed, we effectively moved playHead to end?
        // No, playHead remains the *logical* start of the buffer we pushed.
        // We don't update playHead while playing. We use it as the anchor for time calc.
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
}

EMSCRIPTEN_KEEPALIVE
void seek(float time) {
    if (!g_state.deviceId || g_state.audioBuffer.empty()) return;

    size_t sampleIndex = (size_t)(time * g_state.sampleRate) * g_state.channels;
    // Align
    sampleIndex = sampleIndex - (sampleIndex % g_state.channels);
    if (sampleIndex >= g_state.audioBuffer.size()) sampleIndex = g_state.audioBuffer.size();

    g_state.playHead = sampleIndex;

    SDL_ClearQueuedAudio(g_state.deviceId);
    if (g_state.stream) SDL_AudioStreamClear(g_state.stream);

    if (g_state.isPlaying) {
        // Refill immediately
        size_t samplesRemaining = g_state.audioBuffer.size() - g_state.playHead;
        SDL_AudioStreamPut(g_state.stream, &g_state.audioBuffer[g_state.playHead], samplesRemaining * sizeof(float));

        int available = SDL_AudioStreamAvailable(g_state.stream);
        if (available > 0) {
             std::vector<Uint8> converted(available);
             int got = SDL_AudioStreamGet(g_state.stream, converted.data(), available);
             if (got > 0) {
                 SDL_QueueAudio(g_state.deviceId, converted.data(), got);
             }
        }
    }
}

EMSCRIPTEN_KEEPALIVE
float get_current_time() {
    if (!g_state.deviceId || g_state.audioBuffer.empty()) return 0.0f;

    Uint32 queuedBytes = SDL_GetQueuedAudioSize(g_state.deviceId);

    // queuedBytes is in Device Format (float32, deviceChannels, deviceFreq)
    // We want to convert this to Seconds.
    double queuedSeconds = (double)queuedBytes / (sizeof(float) * g_state.deviceChannels * g_state.deviceFreq);

    // Total duration of file
    double totalDuration = (double)g_state.audioBuffer.size() / (g_state.channels * g_state.sampleRate);

    // But we pushed from playHead to end.
    // So what is currently playing = (End of File) - (What is left in Queue).
    // This assumes we pushed EVERYTHING.
    // If we only pushed a chunk, this is wrong. But we push everything.

    // However, if we Seeked, playHead changed.
    // If we seek to 10s, we push (Duration - 10s) audio.
    // Queue has (Duration - 10s).
    // Time = Duration - Queue.
    // = Duration - (Duration - 10s) = 10s.
    // As Queue shrinks, Time increases.
    // Correct.

    // Wait, playHead logic:
    // If I seek to 10s. playHead corresponds to 10s.
    // We pushed data starting at 10s.
    // The "End" of the audio buffer corresponds to `totalDuration`.

    double currentTime = totalDuration - queuedSeconds;

    // Clamp
    if (currentTime < 0) currentTime = 0;
    if (currentTime > totalDuration) currentTime = totalDuration;

    return (float)currentTime;
}

EMSCRIPTEN_KEEPALIVE
void set_volume(float vol) {
    g_state.volume = vol;
    // TODO: Implement volume scaling
}

EMSCRIPTEN_KEEPALIVE
void cleanup() {
    if (g_state.stream) SDL_FreeAudioStream(g_state.stream);
    if (g_state.deviceId) SDL_CloseAudioDevice(g_state.deviceId);
    g_state.audioBuffer.clear();
    SDL_Quit();
}

#ifdef __cplusplus
}
#endif
