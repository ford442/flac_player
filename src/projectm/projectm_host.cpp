#include <projectM-4/projectM.h>
#include <projectM-4/playlist.h>
#include <emscripten.h>
#include <emscripten/html5.h>
#include <emscripten/html5_webgl.h>
#include <SDL.h>
#include <GL/gl.h>
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <vector>

static projectm_handle g_pm = nullptr;
static projectm_playlist_handle g_playlist = nullptr;
static SDL_Window* g_window = nullptr;
static SDL_Renderer* g_renderer = nullptr;
static int g_width = 640;
static int g_height = 360;

static void renderFrame() {
    if (!g_pm) return;
    projectm_opengl_render_frame(g_pm);
    glFlush();
    if (g_renderer) {
        SDL_RenderPresent(g_renderer);
    }
}

static bool ensureGlExtensions() {
    EmscriptenWebGLContextAttributes attrs;
    emscripten_webgl_init_context_attributes(&attrs);
    attrs.majorVersion = 2;
    attrs.minorVersion = 0;

    EMSCRIPTEN_WEBGL_CONTEXT_HANDLE ctx = emscripten_webgl_get_current_context();
    if (ctx) {
        emscripten_webgl_enable_extension(ctx, "OES_texture_float");
        return true;
    }
    return false;
}

static bool initSdlSurface(int width, int height) {
    if (g_window && g_renderer) {
        SDL_SetWindowSize(g_window, width, height);
        return true;
    }

    if (SDL_Init(SDL_INIT_VIDEO) != 0) {
        std::fprintf(stderr, "[projectM host] SDL_Init failed: %s\n", SDL_GetError());
        return false;
    }

    g_width = width;
    g_height = height;

    g_window = SDL_CreateWindow(
        "projectM",
        SDL_WINDOWPOS_UNDEFINED,
        SDL_WINDOWPOS_UNDEFINED,
        width,
        height,
        SDL_WINDOW_OPENGL | SDL_WINDOW_RESIZABLE
    );

    if (!g_window) {
        std::fprintf(stderr, "[projectM host] SDL_CreateWindow failed: %s\n", SDL_GetError());
        return false;
    }

    g_renderer = SDL_CreateRenderer(g_window, -1, SDL_RENDERER_ACCELERATED);
    if (!g_renderer) {
        std::fprintf(stderr, "[projectM host] SDL_CreateRenderer failed: %s\n", SDL_GetError());
        return false;
    }

    ensureGlExtensions();
    return true;
}

extern "C" {

EMSCRIPTEN_KEEPALIVE
int pm_init(int width, int height) {
    if (g_pm) return 1;

    width = std::max(320, width);
    height = std::max(180, height);

    if (!initSdlSurface(width, height)) {
        return 0;
    }

    g_pm = projectm_create();
    if (!g_pm) {
        std::fprintf(stderr, "[projectM host] projectm_create failed\n");
        return 0;
    }

    projectm_set_window_size(g_pm, static_cast<size_t>(width), static_cast<size_t>(height));
    projectm_set_soft_cut_duration(g_pm, 2.0);
    projectm_set_preset_duration(g_pm, 45.0);
    projectm_set_hard_cut_enabled(g_pm, true);
    projectm_set_hard_cut_duration(g_pm, 12.0);
    projectm_set_beat_sensitivity(g_pm, 1.2f);
    projectm_set_fps(g_pm, 60);

    g_playlist = projectm_playlist_create(g_pm);
    if (g_playlist) {
        projectm_playlist_connect(g_playlist, g_pm);
        projectm_playlist_set_shuffle(g_playlist, true);
        const uint32_t added = projectm_playlist_add_path(g_playlist, "/presets", true, false);
        if (added > 0) {
            projectm_playlist_play_next(g_playlist, false);
        } else {
            projectm_load_preset_file(g_pm, "idle://", false);
        }
    } else {
        projectm_load_preset_file(g_pm, "idle://", false);
    }

    emscripten_set_main_loop(renderFrame, 0, false);
    return 1;
}

EMSCRIPTEN_KEEPALIVE
void pm_resize(int width, int height) {
    if (!g_pm) return;
    width = std::max(320, width);
    height = std::max(180, height);
    g_width = width;
    g_height = height;
    if (g_window) SDL_SetWindowSize(g_window, width, height);
    projectm_set_window_size(g_pm, static_cast<size_t>(width), static_cast<size_t>(height));
}

EMSCRIPTEN_KEEPALIVE
void pm_add_pcm(float* samples, int floatCount, int channels) {
    if (!g_pm || !samples || floatCount <= 0) return;
    const projectm_channels ch = channels <= 1 ? PROJECTM_MONO : PROJECTM_STEREO;
    const int channelCount = ch == PROJECTM_MONO ? 1 : 2;
    const unsigned int frameCount = static_cast<unsigned int>(floatCount / channelCount);
    if (frameCount == 0) return;
    projectm_pcm_add_float(g_pm, samples, frameCount, ch);
}

EMSCRIPTEN_KEEPALIVE
void pm_next_preset(int hardCut) {
    if (g_playlist) {
        projectm_playlist_play_next(g_playlist, hardCut != 0);
    }
}

EMSCRIPTEN_KEEPALIVE
void pm_prev_preset(int hardCut) {
    if (g_playlist) {
        projectm_playlist_play_previous(g_playlist, hardCut != 0);
    }
}

EMSCRIPTEN_KEEPALIVE
int pm_load_preset_data(const char* data, int length, int smooth) {
    if (!g_pm || !data || length <= 0) return 0;
    std::vector<char> presetCopy(static_cast<size_t>(length) + 1);
    std::memcpy(presetCopy.data(), data, static_cast<size_t>(length));
    presetCopy[static_cast<size_t>(length)] = '\0';
    projectm_load_preset_data(g_pm, presetCopy.data(), smooth != 0);
    return 1;
}

EMSCRIPTEN_KEEPALIVE
void pm_set_beat_sensitivity(float value) {
    if (g_pm) projectm_set_beat_sensitivity(g_pm, value);
}

EMSCRIPTEN_KEEPALIVE
void pm_destroy() {
    emscripten_cancel_main_loop();
    if (g_playlist) {
        projectm_playlist_destroy(g_playlist);
        g_playlist = nullptr;
    }
    if (g_pm) {
        projectm_destroy(g_pm);
        g_pm = nullptr;
    }
    if (g_renderer) {
        SDL_DestroyRenderer(g_renderer);
        g_renderer = nullptr;
    }
    if (g_window) {
        SDL_DestroyWindow(g_window);
        g_window = nullptr;
    }
    SDL_Quit();
}

} // extern "C"
