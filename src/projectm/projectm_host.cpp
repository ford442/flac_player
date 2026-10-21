// In-app projectM host: one WebGL2 context on Module.canvas, one main loop.
//
// No SDL: SDL2's video init registered a window keydown handler that
// preventDefault-ed Tab, arrows, F-keys and every Ctrl+key app-wide. The
// context comes straight from the HTML5 WebGL API with explicit attributes.
//
// Presets are owned by JS (ProjectMEngine / projectmPresets.ts): it fetches
// .milk text and calls pm_load_preset_data. When projectM's preset timer
// expires it asks JS for the next one via Module.onPresetSwitchRequested.
#include <projectM-4/projectM.h>
#include <emscripten.h>
#include <emscripten/em_js.h>
#include <emscripten/html5.h>
#include <emscripten/html5_webgl.h>
#include <algorithm>
#include <string>

// Module.canvas is a detached-capable element owned by ProjectMEngine, not a
// document id, so register it as a special target instead of a CSS selector.
EM_JS_DEPS(pm_host_deps, "$specialHTMLTargets");
EM_JS(void, pm_register_canvas_target, (), {
    specialHTMLTargets["!projectm"] = Module["canvas"];
});
EM_JS(void, pm_notify_switch_requested, (int hardCut), {
    if (typeof Module["onPresetSwitchRequested"] === "function") Module["onPresetSwitchRequested"](hardCut !== 0);
});

static projectm_handle g_pm = nullptr;
static EMSCRIPTEN_WEBGL_CONTEXT_HANDLE g_ctx = 0;
static bool g_loadFailed = false;
static std::string g_loadError;

static void renderFrame() {
    if (!g_pm) return;
    projectm_opengl_render_frame(g_pm);
}

static void onSwitchRequested(bool isHardCut, void*) {
    pm_notify_switch_requested(isHardCut ? 1 : 0);
}

static void onSwitchFailed(const char*, const char* message, void*) {
    g_loadFailed = true;
    g_loadError = message ? message : "";
}

static bool createContext() {
    EmscriptenWebGLContextAttributes attrs;
    emscripten_webgl_init_context_attributes(&attrs);
    attrs.majorVersion = 2;
    attrs.minorVersion = 0;
    attrs.alpha = false;
    attrs.depth = false;
    attrs.stencil = false;
    attrs.antialias = true;
    attrs.premultipliedAlpha = false;
    attrs.preserveDrawingBuffer = false;
    attrs.powerPreference = EM_WEBGL_POWER_PREFERENCE_HIGH_PERFORMANCE;

    pm_register_canvas_target();
    g_ctx = emscripten_webgl_create_context("!projectm", &attrs);
    if (g_ctx <= 0) {
        emscripten_log(EM_LOG_ERROR, "[projectM host] WebGL2 context creation failed (%d)", static_cast<int>(g_ctx));
        g_ctx = 0;
        return false;
    }
    emscripten_webgl_make_context_current(g_ctx);
    return true;
}

extern "C" {

/** Width / height are drawing-buffer pixels (CSS px × DPR); JS sizes the canvas. */
EMSCRIPTEN_KEEPALIVE
int pm_init(int width, int height) {
    if (g_pm) return 1;
    if (!createContext()) return 0;

    g_pm = projectm_create();
    if (!g_pm) {
        emscripten_log(EM_LOG_ERROR, "[projectM host] projectm_create failed");
        emscripten_webgl_destroy_context(g_ctx);
        g_ctx = 0;
        return 0;
    }

    projectm_set_window_size(g_pm, static_cast<size_t>(std::max(1, width)), static_cast<size_t>(std::max(1, height)));
    projectm_set_soft_cut_duration(g_pm, 2.0);
    projectm_set_preset_duration(g_pm, 45.0);
    projectm_set_hard_cut_enabled(g_pm, true);
    projectm_set_hard_cut_duration(g_pm, 12.0);
    projectm_set_beat_sensitivity(g_pm, 1.2f);
    projectm_set_fps(g_pm, 60);
    projectm_set_preset_switch_requested_event_callback(g_pm, &onSwitchRequested, nullptr);
    projectm_set_preset_switch_failed_event_callback(g_pm, &onSwitchFailed, nullptr);
    projectm_load_preset_file(g_pm, "idle://", false);

    emscripten_set_main_loop(renderFrame, 0, false);
    return 1;
}

EMSCRIPTEN_KEEPALIVE
void pm_resize(int width, int height) {
    if (!g_pm) return;
    projectm_set_window_size(g_pm, static_cast<size_t>(std::max(1, width)), static_cast<size_t>(std::max(1, height)));
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

/**
 * Parse and switch to a .milk preset (NUL-terminated `data`). Returns 1 when
 * projectM accepted it, 0 when parsing / shader compilation failed (the
 * current preset keeps playing).
 */
EMSCRIPTEN_KEEPALIVE
int pm_load_preset_data(const char* data, int length, int smooth) {
    if (!g_pm || !data || length <= 0) return 0;
    g_loadFailed = false;
    g_loadError.clear();
    projectm_load_preset_data(g_pm, data, smooth != 0);
    if (g_loadFailed) {
        emscripten_log(EM_LOG_WARN, "[projectM host] preset rejected: %s", g_loadError.c_str());
        return 0;
    }
    return 1;
}

/** Locked: projectM never asks for the next preset (no timer / hard-cut switches). */
EMSCRIPTEN_KEEPALIVE
void pm_set_preset_locked(int locked) {
    if (g_pm) projectm_set_preset_locked(g_pm, locked != 0);
}

EMSCRIPTEN_KEEPALIVE
void pm_set_beat_sensitivity(float value) {
    if (g_pm) projectm_set_beat_sensitivity(g_pm, value);
}

/** Stop rendering while the canvas is detached (no host mounted); state is kept. */
EMSCRIPTEN_KEEPALIVE
void pm_set_paused(int paused) {
    if (!g_pm) return;
    if (paused) {
        emscripten_pause_main_loop();
    } else {
        emscripten_resume_main_loop();
    }
}

EMSCRIPTEN_KEEPALIVE
void pm_destroy() {
    emscripten_cancel_main_loop();
    if (g_pm) {
        projectm_destroy(g_pm);
        g_pm = nullptr;
    }
    if (g_ctx) {
        emscripten_webgl_destroy_context(g_ctx);
        g_ctx = 0;
    }
}

} // extern "C"
