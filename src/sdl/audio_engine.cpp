// C++ playback engine for the `sdl` output mode (Sdl3AudioPlayer.ts).
//
// The engine owns the PCM: a buffered track (malloc'd, capped) or the play ring
// a hi-fi stream is pushed into, plus the transport block in engine_state.h.
// It does not render audio. The `sdl-engine` AudioWorkletProcessor reads both
// out of this module's SharedArrayBuffer on the audio thread and feeds the
// shared Web Audio graph, where the dsp-chain worklet (dsp_chain.h) runs the
// speaker DSP and fills the analysis ring. Every export here runs on the main
// thread and only writes PCM or transport words; nothing blocks on the audio
// thread.
//
// SDL left the audio path in #268: its Emscripten backend pumped this engine
// from a ScriptProcessorNode on the main thread, in a second AudioContext, so
// React renders and the visualizer stalled the mixer. The mode keeps its name.

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#else
// Host clang (tests/native): the exports are plain functions.
#define EMSCRIPTEN_KEEPALIVE
#endif
#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include "engine_state.h"
#include "pcm_scrub.h"
#include "play_ring.h"

#ifdef __cplusplus
extern "C" {
#endif

static EngineState g_engine;

struct BufferedTrack {
    // malloc (not std::vector) so OOM returns nullptr instead of aborting:
    // exceptions are disabled, and with ALLOW_MEMORY_GROWTH Emscripten's malloc
    // returns NULL when sbrk cannot grow.
    float* data = nullptr;
    size_t floats = 0;
} g_buffer;

// 384 MiB of f32 PCM; leaves ~128 MiB inside the 512 MiB WASM ceiling for the
// play ring, pthread stacks and fragmentation.
static constexpr int kMaxBufferedFloats = (384 * 1024 * 1024) / (int)sizeof(float); // 100663296

static float clamp_rate(float ratio) {
    if (!(ratio > 0.0f)) ratio = 1.0f;
    return std::max(0.25f, std::min(4.0f, ratio));
}

// Stop reading, then publish. The processor applies the epoch at its next
// quantum; until then `playing` is already 0, so it is silent.
static void go_idle() {
    g_engine.playing.store(0);
    g_engine.mode.store(ENGINE_IDLE);
    g_engine.bufferPtr.store(0);
    g_engine.bufferFloats.store(0);
    g_engine.startFrame.store(0);
    g_engine.ringStart.store(play_ring_write_pos());
    engine_bump(g_engine);
}

static void free_buffer() {
    std::free(g_buffer.data);
    g_buffer.data = nullptr;
    g_buffer.floats = 0;
}

EMSCRIPTEN_KEEPALIVE
int init_audio() {
    engine_reset(g_engine);
    play_ring_init(PLAY_RING_CAPACITY);
    return play_ring_capacity() == PLAY_RING_CAPACITY ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE
float* create_audio_buffer(int length) {
    if (length <= 0 || length > kMaxBufferedFloats) {
        std::fprintf(stderr, "[C++] create_audio_buffer rejected length=%d\n", length);
        return nullptr;
    }
    // The processor must not be reading the old buffer when it is freed. The
    // backend stops before it decodes the next track, so `playing` has been 0
    // for far longer than one render quantum by the time this runs.
    go_idle();
    free_buffer();
    // Fragmentation / growth failure inside the cap: nullptr, never an abort.
    float* data = static_cast<float*>(std::malloc((size_t)length * sizeof(float)));
    if (!data) {
        std::fprintf(stderr, "[C++] create_audio_buffer out of memory length=%d\n", length);
        return nullptr;
    }
    g_buffer.data = data;
    g_buffer.floats = (size_t)length;
    return data;
}

// The buffer JS filled: scrubbed, then published as the buffered track at
// `sampleRate` (the AudioContext rate; JS resamples when the file differs).
EMSCRIPTEN_KEEPALIVE
int set_audio_data(int length, int channels, int sampleRate) {
    if (!g_buffer.data || g_buffer.floats != (size_t)length || channels <= 0 || sampleRate <= 0) {
        std::fprintf(stderr, "[C++] set_audio_data: buffer size or format mismatch\n");
        return 0;
    }
    pcm_scrub_nonfinite(g_buffer.data, g_buffer.floats);
    g_engine.playing.store(0);
    g_engine.mode.store(ENGINE_BUFFERED);
    g_engine.channels.store((uint32_t)channels);
    g_engine.sampleRate.store((uint32_t)sampleRate);
    g_engine.bufferPtr.store((uint32_t)(uintptr_t)g_buffer.data);
    g_engine.bufferFloats.store((uint32_t)g_buffer.floats);
    g_engine.startFrame.store(0);
    engine_bump(g_engine);
    return 1;
}

// A new stream: PCM pushed from now on is current. Positions only move
// forward; everything before the current write position is skipped.
EMSCRIPTEN_KEEPALIVE
int set_stream_format(int channels, int sampleRate) {
    if (channels <= 0 || sampleRate <= 0 || !play_ring_capacity()) return 0;
    go_idle();
    free_buffer();
    play_ring_set_ended(0);
    g_engine.mode.store(ENGINE_STREAM);
    g_engine.channels.store((uint32_t)channels);
    g_engine.sampleRate.store((uint32_t)sampleRate);
    g_engine.startFrame.store(0);
    g_engine.ringStart.store(play_ring_write_pos());
    engine_bump(g_engine);
    return 1;
}

// `samples` is the caller's malloc'd staging block; it is scrubbed in place.
EMSCRIPTEN_KEEPALIVE
int push_pcm(float* samples, int count) {
    if (count > 0) pcm_scrub_nonfinite(samples, (size_t)count);
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
    if (g_engine.mode.load() == ENGINE_IDLE) return;
    g_engine.playing.store(1);
}

EMSCRIPTEN_KEEPALIVE
void pause_audio() {
    g_engine.playing.store(0);
}

EMSCRIPTEN_KEEPALIVE
void resume_audio() {
    play();
}

EMSCRIPTEN_KEEPALIVE
void stop() {
    go_idle();
}

// Buffered seek: the processor restarts at the frame `time` lands on.
EMSCRIPTEN_KEEPALIVE
void seek(float time) {
    if (g_engine.mode.load() != ENGINE_BUFFERED) return;
    const uint32_t channels = g_engine.channels.load();
    const uint32_t frames = channels ? g_engine.bufferFloats.load() / channels : 0;
    g_engine.startFrame.store(engine_frame_at(time, g_engine.sampleRate.load(), frames));
    engine_bump(g_engine);
}

// Stream seek: PCM already in the ring is stale. The processor skips to the
// current write position, and the clock reads `seconds` until the first
// post-seek PCM plays. JS restarts its decoder at `seconds`; C++ never parses FLAC.
EMSCRIPTEN_KEEPALIVE
int seek_stream(double seconds) {
    if (g_engine.mode.load() != ENGINE_STREAM) return 0;
    play_ring_set_ended(0);
    g_engine.startFrame.store(engine_frame_at(seconds, g_engine.sampleRate.load(), 0));
    g_engine.ringStart.store(play_ring_write_pos());
    engine_bump(g_engine);
    return 1;
}

// After the AudioContext is replaced, before the new processor starts: carry
// the position over (engine_state.h engine_rebase).
EMSCRIPTEN_KEEPALIVE
void rebase() {
    engine_rebase(g_engine, play_ring_read_pos());
}

// Tempo: the processor reads the ring at `ratio` frames per output frame
// (pitch follows speed, like HTMLMediaElement with preservesPitch=false).
// Clamped to 0.25..4 like useAudioSettings.ts. The clock stays in media seconds.
EMSCRIPTEN_KEEPALIVE
int set_playback_rate(float ratio) {
    g_engine.rateBits.store(engine_float_bits(clamp_rate(ratio)));
    return 1;
}

EMSCRIPTEN_KEEPALIVE
float get_current_time() {
    return (float)engine_position_seconds(g_engine);
}

// 1 once buffered PCM ran out, or a stream ended and its ring drained.
EMSCRIPTEN_KEEPALIVE
int is_drained() {
    return g_engine.ackEpoch.load() == g_engine.epoch.load() && g_engine.drained.load() ? 1 : 0;
}

// Before constructing a processor with this id, so a replaced one retires.
EMSCRIPTEN_KEEPALIVE
void set_output_owner(uint32_t id) {
    g_engine.owner.store(id);
}

EMSCRIPTEN_KEEPALIVE
EngineState* get_engine_state() {
    return &g_engine;
}

EMSCRIPTEN_KEEPALIVE
PlayRingState* get_play_ring_state() {
    return &g_playRing;
}

EMSCRIPTEN_KEEPALIVE
float* get_play_ring_data() {
    return g_playRingData;
}

EMSCRIPTEN_KEEPALIVE
void cleanup() {
    g_engine.owner.store(0);
    go_idle();
    free_buffer();
    play_ring_cleanup();
}

#ifdef __cplusplus
}
#endif
