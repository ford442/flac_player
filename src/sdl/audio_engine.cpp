#include <SDL3/SDL.h>
#include <emscripten.h>
#include <vector>
#include <iostream>
#include <cstdio>
#include <cmath>
#include <cstdlib>
#include <algorithm>
#include "pcm_ring.h"
#include "play_ring.h"
#include "dsp_chain.h"

#ifdef __cplusplus
extern "C" {
#endif

struct PlayerState {
    SDL_AudioStream* stream = nullptr;
    // Buffered PCM. malloc (not std::vector) so OOM returns nullptr instead of
    // aborting: exceptions are disabled, and with ALLOW_MEMORY_GROWTH Emscripten's
    // malloc returns NULL when sbrk cannot grow.
    float* audioBuffer = nullptr;
    size_t audioLength = 0; // floats
    bool isPlaying = false;
    bool streamMode = false;
    float volume = 1.0f;
    float playbackRate = 1.0f; // SDL_SetAudioStreamFrequencyRatio
    int sampleRate = 0;
    int channels = 2;
    size_t playHead = 0; // Index in float samples (buffered path) / samples consumed (stream)
    SDL_AudioDeviceID deviceId = 0;
} g_state;

// Bounded callback drain (no heap alloc). SDL additional_amount is typically a few KB.
static float g_callbackScratch[8192];

void SDLCALL fill_audio_callback(void *userdata, SDL_AudioStream *stream, int additional_amount, int total_amount);

static void free_audio_buffer() {
    std::free(g_state.audioBuffer);
    g_state.audioBuffer = nullptr;
    g_state.audioLength = 0;
}

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
    SDL_SetAudioStreamFrequencyRatio(g_state.stream, g_state.playbackRate);

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

    if (!g_state.audioBuffer) {
        return;
    }

    size_t samplesRemaining = g_state.audioLength - g_state.playHead;
    if (samplesRemaining == 0) {
        g_state.isPlaying = false;
        return;
    }

    int floatsToPush = (int)std::min(samplesRemaining, (size_t)floatsWanted);
    std::copy_n(g_state.audioBuffer + g_state.playHead, floatsToPush, g_callbackScratch);
    dsp_process(g_callbackScratch, floatsToPush, g_state.channels, g_state.sampleRate, g_state.volume);

    pcm_ring_write(g_callbackScratch, floatsToPush);
    SDL_PutAudioStreamData(stream, g_callbackScratch, floatsToPush * (int)sizeof(float));

    g_state.playHead += (size_t)floatsToPush;

    if (g_state.playHead >= g_state.audioLength) {
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
    // Stop the callback from reading the old buffer before it is freed.
    g_state.isPlaying = false;
    if (g_state.stream) SDL_LockAudioStream(g_state.stream);
    free_audio_buffer();
    if (g_state.stream) SDL_UnlockAudioStream(g_state.stream);
    // Fragmentation / growth failure inside the cap: nullptr, never an abort.
    float* buf = static_cast<float*>(std::malloc((size_t)length * sizeof(float)));
    if (!buf) {
        std::cerr << "[C++] create_audio_buffer out of memory length=" << length << std::endl;
        return nullptr;
    }
    g_state.audioBuffer = buf;
    g_state.audioLength = (size_t)length;
    return buf;
}

EMSCRIPTEN_KEEPALIVE
int set_audio_data(int length, int channels, int sampleRate) {
    if (!g_state.audioBuffer || g_state.audioLength != (size_t)length) {
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
    g_state.isPlaying = false;
    if (g_state.stream) SDL_LockAudioStream(g_state.stream);
    free_audio_buffer();
    if (g_state.stream) SDL_UnlockAudioStream(g_state.stream);
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
    if (!g_state.streamMode && !g_state.audioBuffer) return;

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
    if (!g_state.stream || !g_state.audioBuffer) return;

    size_t sampleIndex = (size_t)(time * g_state.sampleRate) * g_state.channels;
    sampleIndex = sampleIndex - (sampleIndex % g_state.channels);

    if (sampleIndex >= g_state.audioLength) {
        sampleIndex = g_state.audioLength;
    }

    SDL_ClearAudioStream(g_state.stream);
    g_state.playHead = sampleIndex;
    pcm_ring_reset();
    dsp_request_reset();
}

// Stream-mode seek: make the rings seek-safe so JS can restart its decoder at
// `seconds`. C++ never parses FLAC. The stream lock is the lock SDL holds while
// running fill_audio_callback, so the SPSC read side is quiescent during reset.
// playHead is set to the target so get_current_time() reports `seconds`
// immediately (before the first post-seek PCM arrives).
EMSCRIPTEN_KEEPALIVE
int seek_stream(double seconds) {
    if (!g_state.streamMode || !g_state.stream) return 0;
    if (g_state.sampleRate <= 0 || g_state.channels <= 0) return 0;
    if (!(seconds > 0.0)) seconds = 0.0;

    SDL_LockAudioStream(g_state.stream);
    SDL_ClearAudioStream(g_state.stream);
    play_ring_reset(); // also clears the ended flag
    pcm_ring_reset();
    dsp_request_reset();
    const size_t frame = (size_t)(seconds * (double)g_state.sampleRate);
    g_state.playHead = frame * (size_t)g_state.channels;
    SDL_UnlockAudioStream(g_state.stream);
    return 1;
}

// Tempo change via SDL's resampler (pitch follows speed, like HTMLMediaElement
// with preservesPitch=false). Clamped to 0.25..4 like useAudioSettings.ts.
// Clock: playHead counts *file* samples handed to SDL, so get_current_time()
// stays in media seconds at any ratio (see get_current_time).
EMSCRIPTEN_KEEPALIVE
int set_playback_rate(float ratio) {
    if (!(ratio > 0.0f)) ratio = 1.0f;
    ratio = std::max(0.25f, std::min(4.0f, ratio));
    g_state.playbackRate = ratio;
    if (!g_state.stream) return 1; // applied in configure_stream
    return SDL_SetAudioStreamFrequencyRatio(g_state.stream, ratio) ? 1 : 0;
}

// Device output format, for logging device vs file rate. Returns 1 on success.
EMSCRIPTEN_KEEPALIVE
int get_device_format(int* freq, int* channels) {
    if (!g_state.deviceId) return 0;
    SDL_AudioSpec spec;
    if (!SDL_GetAudioDeviceFormat(g_state.deviceId, &spec, nullptr)) return 0;
    if (freq) *freq = spec.freq;
    if (channels) *channels = spec.channels;
    return 1;
}

EMSCRIPTEN_KEEPALIVE
float get_current_time() {
    if (!g_state.stream || g_state.sampleRate <= 0 || g_state.channels <= 0) return 0.0f;
    if (!g_state.streamMode && !g_state.audioBuffer) return 0.0f;

    // Available bytes are post-conversion output; with frequency ratio r each
    // output sample holds r input samples, so scale back to file samples.
    int queuedBytes = SDL_GetAudioStreamAvailable(g_state.stream);
    size_t queuedSamples = (size_t)((double)(queuedBytes / (int)sizeof(float)) * g_state.playbackRate);

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
    free_audio_buffer();
    play_ring_cleanup();
    pcm_ring_cleanup();
    SDL_Quit();
}

#ifdef __cplusplus
}
#endif
