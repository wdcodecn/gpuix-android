mod ota;

use std::ffi::{c_char, c_void, CStr, CString};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Condvar, Mutex, OnceLock,
};
use std::time::Duration;

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
    fn gpuix_js_eval_script(source: *const u8, length: usize, source_url: *const c_char) -> bool;
    fn gpuix_js_eval_bundle(
        data: *const u8,
        length: usize,
        source_url: *const c_char,
        reset_timers: bool,
    ) -> bool;
    fn gpuix_js_ping_async() -> u64;
    fn gpuix_js_ping_ack() -> u64;
}

#[derive(Default)]
struct OtaRuntimeCtx {
    data_dir: Option<PathBuf>,
    embedded: ota::EmbeddedMeta,
    running_ota_id: Option<String>,
    running_ota_confirmed: bool,
    boot_healthy: bool,
    boot_fatal_seen: bool,
    rollback_queued: bool,
    watchdog_gen: u64,
    hot_stop: Option<Arc<AtomicBool>>,
}

static OTA_CTX: OnceLock<Mutex<OtaRuntimeCtx>> = OnceLock::new();
static BOOT_GATE: OnceLock<(Mutex<bool>, Condvar)> = OnceLock::new();

fn ota_ctx() -> &'static Mutex<OtaRuntimeCtx> {
    OTA_CTX.get_or_init(|| Mutex::new(OtaRuntimeCtx::default()))
}

fn boot_gate() -> &'static (Mutex<bool>, Condvar) {
    BOOT_GATE.get_or_init(|| (Mutex::new(true), Condvar::new()))
}

fn wait_for_boot_gate(stop: &AtomicBool, max_wait: Duration) {
    let (lock, cvar) = boot_gate();
    let deadline = std::time::Instant::now() + max_wait;
    let mut ready = lock.lock().unwrap();
    while !*ready && !stop.load(Ordering::Acquire) {
        let now = std::time::Instant::now();
        if now >= deadline {
            log::warn!("Native boot gate wait timed out; proceeding with boot");
            break;
        }
        let step = (deadline - now).min(Duration::from_millis(100));
        let (guard, _) = cvar.wait_timeout(ready, step).unwrap();
        ready = guard;
    }
}

fn read_embedded_asset_bytes() -> Option<Vec<u8>> {
    let app = gpuix_native::android_jni::android_app()?;
    let assets = app.asset_manager();
    if let Some(mut hbc) = assets.open(c"gpuix/app.hbc") {
        if let Ok(buf) = hbc.buffer() {
            return Some(buf.to_vec());
        }
    }
    if let Some(mut js) = assets.open(c"gpuix/app.js") {
        if let Ok(buf) = js.buffer() {
            return Some(buf.to_vec());
        }
    }
    None
}

unsafe extern "C" fn on_js_request_vsync() {
    gpuix_native::android_vsync::request_vsync();
}

fn trigger_rollback_bundle_eval(prev: Option<(String, Vec<u8>)>, failed_label: &str) {
    if let Some((prev_id, prev_bytes)) = prev {
        log::warn!("Auto-rolling back failed OTA {failed_label} -> {prev_id}");
        if let Ok(c_url) = CString::new(format!("ota-rollback:{prev_id}")) {
            let ok = unsafe {
                gpuix_js_eval_bundle(prev_bytes.as_ptr(), prev_bytes.len(), c_url.as_ptr(), true)
            };
            if ok {
                return;
            }
        }
    }
    if let Some(emb_bytes) = read_embedded_asset_bytes() {
        log::warn!("Auto-rolling back failed OTA {failed_label} -> embedded APK bundle");
        let ok = unsafe {
            gpuix_js_eval_bundle(
                emb_bytes.as_ptr(),
                emb_bytes.len(),
                c"embedded:rollback".as_ptr(),
                true,
            )
        };
        if ok {
            return;
        }
    }
    log::error!("Failed to queue fallback bundle; requesting clean process restart");
    let _ = gpuix_native::android_jni::request_ota_process_restart();
}

unsafe extern "C" fn on_js_fatal_error(message: *const c_char) {
    let text = if message.is_null() {
        "JavaScript fatal error (null message)".to_string()
    } else {
        CStr::from_ptr(message).to_string_lossy().into_owned()
    };
    log::error!("JavaScript fatal error: {text}");

    let rollback_target = {
        let mut ctx = ota_ctx().lock().unwrap();
        ctx.boot_fatal_seen = true;
        if !ctx.running_ota_confirmed && !ctx.rollback_queued {
            if let (Some(dir), Some(id)) = (ctx.data_dir.clone(), ctx.running_ota_id.clone()) {
                ctx.rollback_queued = true;
                Some((dir, id, ctx.embedded.hbc_version))
            } else {
                None
            }
        } else {
            None
        }
    };
    if let Some((data_dir, id, hbc_version)) = rollback_target {
        log::warn!("Recording fatal error and recovering unconfirmed OTA release {id}");
        let prev = ota::record_unconfirmed_failure_and_rollback(
            &data_dir,
            &id,
            &text,
            hbc_version,
        );
        {
            let mut ctx = ota_ctx().lock().unwrap();
            ctx.running_ota_id = None;
            ctx.running_ota_confirmed = false;
        }
        trigger_rollback_bundle_eval(prev, &id);
    }
}

unsafe extern "C" fn on_js_hot_eval_result(
    ok: bool,
    source_url: *const c_char,
    error_message: *const c_char,
) {
    let url = if source_url.is_null() {
        String::new()
    } else {
        CStr::from_ptr(source_url).to_string_lossy().into_owned()
    };
    let err = if error_message.is_null() {
        "OTA hot evaluation failed".to_string()
    } else {
        CStr::from_ptr(error_message).to_string_lossy().into_owned()
    };

    if ok {
        let mut ctx = ota_ctx().lock().unwrap();
        ctx.rollback_queued = false;
        ctx.boot_fatal_seen = false;
        if let Some(id) = url.strip_prefix("ota:") {
            ctx.running_ota_id = Some(id.to_string());
            ctx.running_ota_confirmed = false;
        } else if let Some(id) = url.strip_prefix("ota-rollback:") {
            ctx.running_ota_id = Some(id.to_string());
            ctx.running_ota_confirmed = true;
        } else if url.starts_with("embedded:") {
            ctx.running_ota_id = None;
            ctx.running_ota_confirmed = true;
        }
        return;
    }

    log::error!("Hot eval failed for {url}: {err}");

    if let Some(failed_id) = url.strip_prefix("ota:") {
        let (data_dir, hbc_version, already_queued) = {
            let mut ctx = ota_ctx().lock().unwrap();
            ctx.boot_fatal_seen = true;
            let was_queued = ctx.rollback_queued;
            ctx.rollback_queued = true;
            ctx.running_ota_id = None;
            ctx.running_ota_confirmed = false;
            (ctx.data_dir.clone(), ctx.embedded.hbc_version, was_queued)
        };
        if already_queued {
            return;
        }
        let prev = data_dir.and_then(|dir| {
            ota::record_unconfirmed_failure_and_rollback(&dir, failed_id, &err, hbc_version)
        });
        trigger_rollback_bundle_eval(prev, failed_id);
    } else if url.starts_with("ota-rollback:") {
        log::warn!("Rollback OTA failed; falling back to embedded APK bundle");
        if let Some(emb_bytes) = read_embedded_asset_bytes() {
            if gpuix_js_eval_bundle(
                emb_bytes.as_ptr(),
                emb_bytes.len(),
                c"embedded:rollback".as_ptr(),
                true,
            ) {
                return;
            }
        }
        let _ = gpuix_native::android_jni::request_ota_process_restart();
    } else if url.starts_with("embedded:rollback") {
        log::error!("Embedded rollback evaluation failed; requesting process restart");
        let _ = gpuix_native::android_jni::request_ota_process_restart();
    }
}

#[no_mangle]
pub unsafe extern "C" fn Java_dev_gpui_mobile_GpuiOtaManager_nativeSetBootGateReady(
    _env: *mut c_void,
    _class: *mut c_void,
    ready: u8,
) {
    let (lock, cvar) = boot_gate();
    let mut guard = lock.lock().unwrap();
    *guard = ready != 0;
    if *guard {
        cvar.notify_all();
    }
}

#[no_mangle]
pub unsafe extern "C" fn Java_dev_gpui_mobile_GpuiOtaManager_nativeMarkBootHealthy(
    _env: *mut c_void,
    _class: *mut c_void,
) {
    let mut ctx = ota_ctx().lock().unwrap();
    ctx.boot_healthy = true;
}

#[no_mangle]
pub unsafe extern "C" fn Java_dev_gpui_mobile_GpuiOtaManager_nativeHasBootFatal(
    _env: *mut c_void,
    _class: *mut c_void,
) -> u8 {
    let ctx = ota_ctx().lock().unwrap();
    if ctx.boot_fatal_seen {
        1
    } else {
        0
    }
}

#[no_mangle]
pub unsafe extern "C" fn Java_dev_gpui_mobile_GpuiOtaManager_nativeTriggerHotApply(
    _env: *mut c_void,
    _class: *mut c_void,
) -> u8 {
    let (data_dir, embedded) = {
        let ctx = ota_ctx().lock().unwrap();
        (ctx.data_dir.clone(), ctx.embedded.clone())
    };
    let Some(dir) = data_dir else {
        log::error!("nativeTriggerHotApply: missing internal data directory");
        return 0;
    };
    match ota::load_active_for_hot_apply(&dir, &embedded) {
        Ok((release_id, bytes, _confirmed)) => {
            let Ok(c_url) = CString::new(format!("ota:{release_id}")) else {
                return 0;
            };
            let hot_stop = {
                let mut ctx = ota_ctx().lock().unwrap();
                ctx.rollback_queued = false;
                ctx.boot_fatal_seen = false;
                ctx.boot_healthy = false;
                ctx.running_ota_id = Some(release_id.clone());
                ctx.running_ota_confirmed = false;
                ctx.hot_stop.clone()
            };
            if let Some(stop_flag) = hot_stop {
                start_boot_watchdog(stop_flag);
            }
            let ok = gpuix_js_eval_bundle(bytes.as_ptr(), bytes.len(), c_url.as_ptr(), true);
            if ok {
                log::info!("Queued OTA hot apply for {release_id} ({} bytes)", bytes.len());
                1
            } else {
                0
            }
        }
        Err(err) => {
            log::error!("nativeTriggerHotApply rejected: {err}");
            0
        }
    }
}

#[no_mangle]
pub unsafe extern "C" fn Java_dev_gpui_mobile_GpuiOtaManager_nativeTriggerHotRollback(
    _env: *mut c_void,
    _class: *mut c_void,
) -> u8 {
    let (data_dir, embedded) = {
        let ctx = ota_ctx().lock().unwrap();
        (ctx.data_dir.clone(), ctx.embedded.clone())
    };
    if let Some(dir) = data_dir {
        if let Ok(Some((prev_id, prev_bytes))) =
            ota::load_current_active_or_embedded(&dir, &embedded)
        {
            if let Ok(c_url) = CString::new(format!("ota-rollback:{prev_id}")) {
                let ok = gpuix_js_eval_bundle(
                    prev_bytes.as_ptr(),
                    prev_bytes.len(),
                    c_url.as_ptr(),
                    true,
                );
                if ok {
                    log::info!("Queued OTA hot rollback -> {prev_id}");
                    return 1;
                }
            }
        }
    }
    if let Some(emb_bytes) = read_embedded_asset_bytes() {
        let ok = gpuix_js_eval_bundle(
            emb_bytes.as_ptr(),
            emb_bytes.len(),
            c"embedded:rollback".as_ptr(),
            true,
        );
        if ok {
            log::info!("Queued OTA hot rollback -> embedded bundle");
            return 1;
        }
    }
    0
}

fn watchdog_should_exit(hot_stop: &AtomicBool, gen: u64) -> bool {
    if hot_stop.load(Ordering::Acquire) {
        return true;
    }
    let ctx = ota_ctx().lock().unwrap();
    ctx.boot_healthy || ctx.watchdog_gen != gen
}

fn start_boot_watchdog(hot_stop: Arc<AtomicBool>) {
    let gen = {
        let mut ctx = ota_ctx().lock().unwrap();
        ctx.watchdog_gen = ctx.watchdog_gen.wrapping_add(1);
        ctx.watchdog_gen
    };
    let _ = std::thread::Builder::new()
        .name("gpuix-boot-watchdog".into())
        .spawn(move || {
            for _ in 0..30 {
                if watchdog_should_exit(&hot_stop, gen) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            if watchdog_should_exit(&hot_stop, gen) {
                return;
            }
            let seq = unsafe { gpuix_js_ping_async() };
            if seq == 0 {
                return;
            }
            for _ in 0..25 {
                if watchdog_should_exit(&hot_stop, gen) {
                    return;
                }
                if unsafe { gpuix_js_ping_ack() } >= seq {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            if watchdog_should_exit(&hot_stop, gen) {
                return;
            }
            if unsafe { gpuix_js_ping_ack() } < seq {
                log::error!(
                    "JS thread heartbeat timeout (2500ms); triggering OTA watchdog recovery"
                );
                let unconfirmed = {
                    let ctx = ota_ctx().lock().unwrap();
                    match (&ctx.data_dir, &ctx.running_ota_id, ctx.running_ota_confirmed) {
                        (Some(dir), Some(id), false) => {
                            Some((dir.clone(), id.clone(), ctx.embedded.hbc_version))
                        }
                        _ => None,
                    }
                };
                if let Some((dir, id, hbc_ver)) = unconfirmed {
                    let _ = ota::record_unconfirmed_failure_and_rollback(
                        &dir,
                        &id,
                        "JS thread heartbeat watchdog timeout",
                        hbc_ver,
                    );
                }
                let _ = gpuix_native::android_jni::request_ota_process_restart();
            }
        });
}

#[no_mangle]
pub unsafe extern "C" fn Java_dev_gpui_mobile_GpuiOtaManager_nativeNotifyOtaConfirmed(
    _env: *mut c_void,
    _class: *mut c_void,
) {
    let mut ctx = ota_ctx().lock().unwrap();
    if ctx.running_ota_id.is_some() {
        ctx.running_ota_confirmed = true;
    }
}

#[no_mangle]
pub unsafe extern "C" fn Java_dev_gpui_mobile_GpuiOtaManager_nativeAcquireStateLock(
    _env: *mut c_void,
    _class: *mut c_void,
) -> i64 {
    let data_dir = {
        let ctx = ota_ctx().lock().unwrap();
        ctx.data_dir.clone()
    };
    let Some(dir) = data_dir else {
        return -1;
    };
    ota::acquire_state_lock_raw(&ota::ota_root_dir(&dir))
}

#[no_mangle]
pub unsafe extern "C" fn Java_dev_gpui_mobile_GpuiOtaManager_nativeReleaseStateLock(
    _env: *mut c_void,
    _class: *mut c_void,
    fd: i64,
) {
    ota::release_state_lock_raw(fd);
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
                                        if !body.is_empty() && !stop.load(Ordering::Acquire) {
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
        gpuix_js_set_hot_eval_handler(on_js_hot_eval_result);
    }

    let hot_stop = Arc::new(AtomicBool::new(false));
    let hot_stop_for_js = Arc::clone(&hot_stop);
    let hot_stop_for_stop = Arc::clone(&hot_stop);
    let assets = app.asset_manager();
    let data_dir = app.internal_data_path();
    let embedded_meta = assets
        .open(c"gpuix/ota-meta.kv")
        .and_then(|mut asset| asset.buffer().ok().map(|b| b.to_vec()))
        .map(|bytes| ota::parse_embedded_meta(&String::from_utf8_lossy(&bytes)))
        .unwrap_or_default();
    {
        let mut ctx = ota_ctx().lock().unwrap();
        if ctx.data_dir.is_none() {
            ctx.data_dir = data_dir.clone();
        }
        ctx.embedded = embedded_meta.clone();
    }

    let result = gpuix_native::run_android_with_stop(
        app,
        move || {
            wait_for_boot_gate(&hot_stop_for_js, Duration::from_millis(5500));
            if hot_stop_for_js.load(Ordering::Acquire) {
                return;
            }
            {
                let mut ctx = ota_ctx().lock().unwrap();
                ctx.data_dir = data_dir.clone();
                ctx.embedded = embedded_meta.clone();
                ctx.running_ota_id = None;
                ctx.running_ota_confirmed = false;
                ctx.boot_healthy = false;
                ctx.boot_fatal_seen = false;
                ctx.rollback_queued = false;
                ctx.hot_stop = Some(Arc::clone(&hot_stop_for_js));
            }
            if let Some(mut dev_cfg) = assets.open(c"gpuix/dev.json") {
                if let Ok(bytes) = dev_cfg.buffer() {
                    spawn_hot_reload_poller(parse_dev_port(bytes), Arc::clone(&hot_stop_for_js));
                }
            }

            start_boot_watchdog(Arc::clone(&hot_stop_for_js));

            let run_embedded = || -> i32 {
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
                                return 2;
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
                                return 2;
                            }
                        }
                    } else {
                        log::error!("Neither gpuix/app.hbc nor gpuix/app.js exists in APK assets");
                        return 2;
                    };
                log::info!("Executing embedded Hermes bundle {bundle_name} ({source_len} bytes)");
                unsafe { gpuix_js_run(source_ptr, source_len, napi_register_module_v1) }
            };

            let boot_plan = data_dir
                .as_deref()
                .map(|dir| ota::resolve_boot_bundle(dir, &embedded_meta))
                .unwrap_or(ota::BootPlan::Embedded);

            let code = match boot_plan {
                ota::BootPlan::Ota {
                    release_id,
                    bytes,
                    confirmed,
                    ..
                } => {
                    {
                        let mut ctx = ota_ctx().lock().unwrap();
                        ctx.running_ota_id = Some(release_id.clone());
                        ctx.running_ota_confirmed = confirmed;
                    }
                    log::info!(
                        "Booting OTA bundle {release_id} ({} bytes, confirmed={confirmed})",
                        bytes.len()
                    );
                    let exit = unsafe {
                        gpuix_js_run(bytes.as_ptr(), bytes.len(), napi_register_module_v1)
                    };
                    if exit != 0 && !hot_stop_for_js.load(Ordering::Acquire) {
                        log::error!(
                            "OTA bundle {release_id} exited non-zero ({exit}); recovering inline"
                        );
                        let prev = if !confirmed {
                            data_dir.as_deref().and_then(|dir| {
                                ota::record_unconfirmed_failure_and_rollback(
                                    dir,
                                    &release_id,
                                    "JS host exited with non-zero status during unconfirmed OTA boot",
                                    embedded_meta.hbc_version,
                                )
                            })
                        } else {
                            None
                        };
                        {
                            let mut ctx = ota_ctx().lock().unwrap();
                            ctx.boot_fatal_seen = false;
                            ctx.rollback_queued = false;
                        }
                        if let Some((prev_id, prev_bytes)) = prev {
                            {
                                let mut ctx = ota_ctx().lock().unwrap();
                                ctx.running_ota_id = Some(prev_id.clone());
                                ctx.running_ota_confirmed = true;
                            }
                            log::warn!("Inline cold-boot recovery -> {prev_id}");
                            unsafe {
                                gpuix_js_run(
                                    prev_bytes.as_ptr(),
                                    prev_bytes.len(),
                                    napi_register_module_v1,
                                )
                            }
                        } else {
                            {
                                let mut ctx = ota_ctx().lock().unwrap();
                                ctx.running_ota_id = None;
                                ctx.running_ota_confirmed = true;
                            }
                            log::warn!("Inline cold-boot recovery -> embedded APK bundle");
                            run_embedded()
                        }
                    } else {
                        exit
                    }
                }
                ota::BootPlan::Embedded => {
                    {
                        let mut ctx = ota_ctx().lock().unwrap();
                        ctx.running_ota_id = None;
                        ctx.running_ota_confirmed = true;
                    }
                    run_embedded()
                }
            };

            if code != 0 {
                log::error!("JavaScript host exited with code {code}");
            }
        },
        move || {
            hot_stop_for_stop.store(true, Ordering::Release);
            let (_, cvar) = boot_gate();
            cvar.notify_all();
            unsafe { gpuix_js_request_stop() };
        },
    );
    if let Err(error) = result {
        log::error!("Android GPUI host failed: {error:#}");
    }
    hot_stop.store(true, Ordering::Release);
    let (_, cvar) = boot_gate();
    cvar.notify_all();
}
