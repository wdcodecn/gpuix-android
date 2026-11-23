use std::ffi::{c_char, c_void, CStr};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

type RegisterModule = unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void;
type RequestVsyncFn = unsafe extern "C" fn();
type FatalErrorFn = unsafe extern "C" fn(*const c_char);

extern "C" {
    fn napi_register_module_v1(env: *mut c_void, exports: *mut c_void) -> *mut c_void;
    fn gpuix_js_run(source: *const u8, length: usize, register: RegisterModule) -> i32;
    fn gpuix_js_request_stop();
    fn gpuix_js_low_memory();
    fn gpuix_js_set_vsync_requester(fn_ptr: RequestVsyncFn);
    fn gpuix_js_set_fatal_handler(fn_ptr: FatalErrorFn);
    fn gpuix_js_on_vsync(timestamp_ms: f64);
    fn gpuix_js_has_raf_callbacks() -> bool;
    fn gpuix_js_eval_script(source: *const u8, length: usize, source_url: *const c_char) -> bool;
}

unsafe extern "C" fn on_js_request_vsync() {
    gpuix_native::android_vsync::request_vsync();
}

unsafe extern "C" fn on_js_fatal_error(message: *const c_char) {
    if message.is_null() {
        log::error!("JavaScript fatal error (null message)");
        return;
    }
    let text = CStr::from_ptr(message).to_string_lossy();
    log::error!("JavaScript fatal error: {text}");
}

fn parse_dev_port(raw: &[u8]) -> u16 {
    let text = std::str::from_utf8(raw).unwrap_or("");
    for token in text.split(|c: char| !c.is_ascii_digit()) {
        if let Ok(port) = token.parse::<u16>() {
            if port > 0 {
                return port;
            }
        }
    }
    8081
}

fn spawn_hot_reload_poller(port: u16, stop: Arc<AtomicBool>) {
    let _ = std::thread::Builder::new()
        .name("gpuix-hot-reload".into())
        .spawn(move || {
            let addr = SocketAddr::from(([127, 0, 0, 1], port));
            let mut version: u64 = 1;
            log::info!("Hot reload poller active on 127.0.0.1:{port}");
            while !stop.load(Ordering::Acquire) {
                match TcpStream::connect_timeout(&addr, Duration::from_millis(250)) {
                    Ok(mut stream) => {
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(20)));
                        let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
                        let req = format!(
                            "GET /poll?version={version} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
                        );
                        if stream.write_all(req.as_bytes()).is_ok() {
                            let mut response = Vec::new();
                            if stream.read_to_end(&mut response).is_ok() {
                                if let Some(split) = response.windows(4).position(|w| w == b"\r\n\r\n") {
                                    let head = std::str::from_utf8(&response[..split]).unwrap_or("");
                                    let body = &response[split + 4..];
                                    if head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200") {
                                        for line in head.lines() {
                                            if let Some((k, v)) = line.split_once(':') {
                                                if k.trim().eq_ignore_ascii_case("x-gpuix-version") {
                                                    if let Ok(next_ver) = v.trim().parse::<u64>() {
                                                        version = next_ver;
                                                    }
                                                }
                                            }
                                        }
                                        if !body.is_empty() {
                                            let ok = unsafe {
                                                gpuix_js_eval_script(
                                                    body.as_ptr(),
                                                    body.len(),
                                                    c"hot-reload.js".as_ptr(),
                                                )
                                            };
                                            log::info!("Hot reload applied v{version} ({} B, ok={ok})", body.len());
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Err(_) => {
                        for _ in 0..6 {
                            if stop.load(Ordering::Acquire) {
                                return;
                            }
                            std::thread::sleep(Duration::from_millis(200));
                        }
                    }
                }
            }
        });
}

#[no_mangle]
fn android_main(app: android_activity::AndroidApp) {
    android_logger::init_once(
        android_logger::Config::default()
            .with_tag("gpuix-android")
            .with_max_level(log::LevelFilter::Info),
    );
    std::panic::set_hook(Box::new(|info| log::error!("native panic: {info}")));
    log::info!("Starting GPUIX Android with standalone Hermes and native GPUI");

    gpuix_native::android_vsync::set_vsync_frame_listener(|timestamp_ms| unsafe {
        gpuix_js_on_vsync(timestamp_ms);
    });
    gpuix_native::android_vsync::set_external_demand_checker(|| unsafe {
        gpuix_js_has_raf_callbacks()
    });
    gpuix_native::android_jni::set_low_memory_listener(|| unsafe {
        gpuix_js_low_memory();
    });
    unsafe {
        gpuix_js_set_vsync_requester(on_js_request_vsync);
        gpuix_js_set_fatal_handler(on_js_fatal_error);
    }

    let hot_stop = Arc::new(AtomicBool::new(false));
    let hot_stop_for_js = Arc::clone(&hot_stop);
    let assets = app.asset_manager();
    let result = gpuix_native::run_android(app, move || {
        if let Some(mut dev_cfg) = assets.open(c"gpuix/dev.json") {
            if let Ok(bytes) = dev_cfg.buffer() {
                spawn_hot_reload_poller(parse_dev_port(bytes), hot_stop_for_js);
            }
        }
        let (mut _asset_hbc, mut _asset_js, bundle_name, source_ptr, source_len) =
            if let Some(mut hbc) = assets.open(c"gpuix/app.hbc") {
                match hbc.buffer() {
                    Ok(buf) => {
                        let ptr = buf.as_ptr();
                        let len = buf.len();
                        (Some(hbc), None, "gpuix/app.hbc", ptr, len)
                    }
                    Err(error) => {
                        log::error!("Could not mmap Android APK asset gpuix/app.hbc: {error}");
                        return;
                    }
                }
            } else if let Some(mut js) = assets.open(c"gpuix/app.js") {
                match js.buffer() {
                    Ok(buf) => {
                        let ptr = buf.as_ptr();
                        let len = buf.len();
                        (None, Some(js), "gpuix/app.js", ptr, len)
                    }
                    Err(error) => {
                        log::error!("Could not read Android APK asset gpuix/app.js: {error}");
                        return;
                    }
                }
            } else {
                log::error!("Neither gpuix/app.hbc nor gpuix/app.js exists in APK assets");
                return;
            };
        log::info!("Executing Hermes bundle {bundle_name} ({source_len} bytes)");
        let code = unsafe { gpuix_js_run(source_ptr, source_len, napi_register_module_v1) };
        if code != 0 {
            log::error!("JavaScript host exited with code {code}");
        }
    });
    if let Err(error) = result {
        log::error!("Android GPUI host failed: {error:#}");
    }
    hot_stop.store(true, Ordering::Release);
    unsafe { gpuix_js_request_stop() };
}
