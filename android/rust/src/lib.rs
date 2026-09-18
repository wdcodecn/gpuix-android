use std::ffi::c_void;

type RegisterModule = unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void;

extern "C" {
    fn napi_register_module_v1(env: *mut c_void, exports: *mut c_void) -> *mut c_void;
    fn gpuix_js_run(source: *const u8, length: usize, register: RegisterModule) -> i32;
    fn gpuix_js_request_stop();
}

// Built from the same playground.tsx and component sources used by the desktop app.
static APP_SOURCE: &[u8] = include_bytes!("../../.build/app.js");

#[no_mangle]
fn android_main(app: android_activity::AndroidApp) {
    android_logger::init_once(
        android_logger::Config::default()
            .with_tag("gpuix-android")
            .with_max_level(log::LevelFilter::Info),
    );
    std::panic::set_hook(Box::new(|info| log::error!("native panic: {info}")));
    log::info!("Starting GPUIX Android with standalone Hermes and native GPUI");
    let result = gpuix_native::run_android(app, || {
        let code = unsafe {
            gpuix_js_run(APP_SOURCE.as_ptr(), APP_SOURCE.len(), napi_register_module_v1)
        };
        if code != 0 {
            log::error!("JavaScript host exited with code {code}");
        }
    });
    if let Err(error) = result {
        log::error!("Android GPUI host failed: {error:#}");
    }
    unsafe { gpuix_js_request_stop() };
}
