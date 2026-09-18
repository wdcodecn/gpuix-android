#pragma once
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Same ABI as Node-API napi_register_module_v1; opaque pointers keep Rust independent.
typedef void *(*gpuix_register_module)(void *env, void *exports);
// Run on a dedicated JS thread. Bundle storage must remain valid until return.
int gpuix_js_run(const uint8_t *bundle, size_t length, gpuix_register_module register_module);
// Safe from the Android activity/render thread. No-op when no runtime is running.
void gpuix_js_request_stop(void);

#ifdef __cplusplus
}
#endif
