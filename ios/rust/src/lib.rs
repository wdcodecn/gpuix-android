use std::ffi::{c_char, c_void, CStr};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

type RegisterModule = unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void;
type RequestVsyncFn = unsafe extern "C" fn();
type FatalErrorFn = unsafe extern "C" fn(*const c_char);
type HotEvalResultFn = unsafe extern "C" fn(bool, *const c_char, *const c_char);

extern "C" {
    fn napi_register_module_v1(env: *mut c_void, exports: *mut c_void) -> *mut c_void;
    fn gpuix_js_run(source: *const u8, length: usize, register: RegisterModule) -> i32;
    fn gpuix_js_request_stop();
    fn gpuix_js_low_memory();
    fn gpuix_js_set_vsync_requester(fn_ptr: RequestVsyncFn);
    fn gpuix_js_set_fatal_handler(fn_ptr: FatalErrorFn);
    fn gpuix_js_set_hot_eval_handler(fn_ptr: HotEvalResultFn);
    fn gpuix_js_on_vsync(timestamp_ms: f64);
    fn gpuix_js_has_raf_callbacks() -> bool;
}

struct StderrLogger;

impl log::Log for StderrLogger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= log::Level::Info
    }

    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
            eprintln!("[{}][{}] {}", record.level(), record.target(), record.args());
        }
    }

    fn flush(&self) {}
}

static LOGGER: StderrLogger = StderrLogger;

fn init_logging() {
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(log::LevelFilter::Info);
    std::panic::set_hook(Box::new(|info| log::error!("native panic: {info}")));
}

unsafe extern "C" fn on_js_request_vsync() {
    // CADisplayLink pumps every active display frame on iOS and drains rAF ticks.
}

unsafe extern "C" fn on_js_fatal_error(message: *const c_char) {
    if message.is_null() {
        log::error!("JS fatal error (null message)");
        return;
    }
    let err = unsafe { CStr::from_ptr(message) }.to_string_lossy();
    log::error!("JS fatal error: {err}");
}

unsafe extern "C" fn on_js_hot_eval_result(
    ok: bool,
    source_url: *const c_char,
    error_message: *const c_char,
) {
    let url = if source_url.is_null() {
        "<unknown>".into()
    } else {
        unsafe { CStr::from_ptr(source_url) }.to_string_lossy()
    };
    if ok {
        log::info!("Hot eval succeeded: {url}");
    } else {
        let err = if error_message.is_null() {
            "unknown error".into()
        } else {
            unsafe { CStr::from_ptr(error_message) }.to_string_lossy()
        };
        log::error!("Hot eval failed for {url}: {err}");
    }
}

/// Start the GPUI iOS host and run the Hermes bundle at `bundle_path`.
#[no_mangle]
pub unsafe extern "C" fn gpuix_ios_start(bundle_path: *const c_char) -> i32 {
    init_logging();
    if bundle_path.is_null() {
        log::error!("gpuix_ios_start called with null bundle_path");
        return 1;
    }
    let path_str = unsafe { CStr::from_ptr(bundle_path) }.to_string_lossy().into_owned();
    let path = PathBuf::from(&path_str);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => {
            log::error!("Failed to read bundle {}: {error}", path.display());
            return 2;
        }
    };

    unsafe {
        gpuix_js_set_vsync_requester(on_js_request_vsync);
        gpuix_js_set_fatal_handler(on_js_fatal_error);
        gpuix_js_set_hot_eval_handler(on_js_hot_eval_result);
    }

    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_for_stop = Arc::clone(&stop_flag);
    log::info!(
        "Starting GPUIX iOS host with bundle {} ({} bytes)",
        path.display(),
        bytes.len()
    );

    if let Err(error) = gpuix_native::start_ios_host(
        move || {
            let code = unsafe {
                gpuix_js_run(bytes.as_ptr(), bytes.len(), napi_register_module_v1)
            };
            if code != 0 && !stop_flag.load(Ordering::Acquire) {
                log::error!("Hermes iOS JS host exited with code {code}");
            }
        },
        move || {
            stop_for_stop.store(true, Ordering::Release);
            unsafe { gpuix_js_request_stop() };
        },
    ) {
        log::error!("Failed to start GPUIX iOS host: {error:#}");
        return 3;
    }
    0
}

/// Drive one CADisplayLink vsync tick for Hermes rAF and GPUI Metal presentation.
#[no_mangle]
pub extern "C" fn gpuix_ios_tick_frame(timestamp_ms: f64) {
    unsafe {
        if gpuix_js_has_raf_callbacks() {
            gpuix_js_on_vsync(timestamp_ms);
        }
    }
    let window_ptr = gpui_mobile::ios::ffi::gpui_ios_get_window();
    if !window_ptr.is_null() {
        gpui_mobile::ios::ffi::gpui_ios_request_frame(window_ptr);
    }
}

#[no_mangle]
pub extern "C" fn gpuix_ios_low_memory() {
    unsafe { gpuix_js_low_memory() };
}

#[no_mangle]
pub extern "C" fn gpuix_ios_will_enter_foreground() {
    gpui_mobile::ios::ffi::gpui_ios_will_enter_foreground(std::ptr::null_mut());
}

#[no_mangle]
pub extern "C" fn gpuix_ios_did_become_active() {
    gpui_mobile::ios::ffi::gpui_ios_did_become_active(std::ptr::null_mut());
}

#[no_mangle]
pub extern "C" fn gpuix_ios_will_resign_active() {
    gpui_mobile::ios::ffi::gpui_ios_will_resign_active(std::ptr::null_mut());
}

#[no_mangle]
pub extern "C" fn gpuix_ios_did_enter_background() {
    gpui_mobile::ios::ffi::gpui_ios_did_enter_background(std::ptr::null_mut());
}

#[no_mangle]
pub extern "C" fn gpuix_ios_set_status_bar_style(style: i32) {
    gpui_mobile::ios::ffi::gpui_ios_set_status_bar_style(style);
}

#[no_mangle]
pub extern "C" fn gpuix_ios_will_terminate() {
    gpui_mobile::ios::ffi::gpui_ios_will_terminate(std::ptr::null_mut());
    gpuix_native::stop_ios_host();
}
