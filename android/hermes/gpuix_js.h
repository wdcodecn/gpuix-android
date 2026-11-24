#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Same ABI as Node-API napi_register_module_v1; opaque pointers keep Rust independent.
typedef void *(*gpuix_register_module)(void *env, void *exports);
typedef void (*gpuix_request_vsync_fn)(void);
typedef void (*gpuix_fatal_error_fn)(const char *message);
typedef void (*gpuix_hot_eval_result_fn)(bool ok, const char *source_url, const char *error_message);

// Run on a dedicated JS thread. Accepts either UTF-8 JS or pre-compiled Hermes
// bytecode (.hbc). Bundle storage must remain valid until return.
int gpuix_js_run(const uint8_t *bundle, size_t length, gpuix_register_module register_module);
// Safe from the Android activity/render thread. No-op when no runtime is running.
void gpuix_js_request_stop(void);
// Trigger an asynchronous GC pass on the active Hermes thread (e.g. LowMemory).
void gpuix_js_low_memory(void);
// Register a native hook invoked when JS schedules requestAnimationFrame().
void gpuix_js_set_vsync_requester(gpuix_request_vsync_fn fn);
// Register a callback invoked when an unhandled JS fatal error occurs.
void gpuix_js_set_fatal_handler(gpuix_fatal_error_fn fn);
// Register a callback invoked when a hot-eval script or bytecode bundle finishes.
void gpuix_js_set_hot_eval_handler(gpuix_hot_eval_result_fn fn);
// Deliver a hardware VSync frame timestamp (in ms) to pending rAF callbacks.
void gpuix_js_on_vsync(double timestamp_ms);
// Returns true when JS has pending requestAnimationFrame callbacks.
bool gpuix_js_has_raf_callbacks(void);
// Evaluate a hot-reload JS bundle on the active Hermes thread.
bool gpuix_js_eval_script(const uint8_t *source, size_t length, const char *source_url);
// Evaluate a hot-reload JS source or Hermes bytecode (.hbc) bundle on the active Hermes thread.
bool gpuix_js_eval_bundle(const uint8_t *data, size_t length, const char *source_url, bool reset_timers);

#ifdef __cplusplus
}
#endif
