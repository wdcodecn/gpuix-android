# Standalone Hermes / Node-API host

This host reuses [Hermes's official napi-runner](https://github.com/facebook/hermes/tree/static_h/tools/napi-runner) runtime and Node-API implementation, and [libuv](https://github.com/libuv/libuv) for cross-thread callbacks, work queues and timers. It uses neither WebView nor React Native UI.

Build with `bash android/scripts/build-hermes.sh`. The pinned Hermes revision is `4947871513667919bf2fe225134af3e3a1a3772c`; host compiler and Android runtime always use the same checkout.

Link Rust against `android/.build/hermes-android/libgpuix_js.so` and ship that file plus the NDK's `libc++_shared.so` in `jniLibs/arm64-v8a`. All Node-API symbols are included in this shared library, so the existing napi-rs addon can link normally.

After GPUI's Android platform is initialized, spawn a JS thread and call `gpuix_js_run(bundle_ptr, bundle_len, napi_register_module_v1)`. The call runs until `gpuix_js_request_stop()` is called from the native host. Bundle storage must live for the entire call. The registration callback runs on the JS thread with a live Hermes Node-API environment, before the application bundle is evaluated, and its exports are available at `globalThis.__gpuixNative`.

The Android host evaluates JavaScript source for initial integration; the matching host `hermesc` also provides an AOT path. JavaScript features in the application bundle must target Hermes (Babel transformation may be needed for Bun output).
