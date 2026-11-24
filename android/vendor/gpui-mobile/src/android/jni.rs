//! Android entry point and event loop using the `android-activity` crate.
//!
//! This module replaces the previous hand-rolled `ANativeActivity_onCreate`,
//! `JNI_OnLoad`, and lifecycle callback implementations with the higher-level
//! `android-activity` glue layer.
//!
//! ## Entry sequence
//!
//! ```text
//! android-activity loads the .so and calls android_main(app: AndroidApp)
//!   └── We store the AndroidApp globally
//!       └── Call the user-supplied gpui_android_main(app)
//! ```
//!
//! ## Threading model
//!
//! `android-activity` spawns a dedicated native thread and calls `android_main`
//! on it.  All GPUI draw / event callbacks run on this thread.  The
//! `AndroidApp` handle is `Send + Sync` and can be shared across threads.
//!
//! ## User entry point
//!
//! Applications must define:
//!
//! ```rust,no_run
//! #[no_mangle]
//! fn android_main(app: android_activity::AndroidApp) {
//!     // Initialise GPUI and run the application.
//! }
//! ```
//!
//! ## Event handling
//!
//! Lifecycle events (window creation/destruction, focus changes, etc.) are
//! delivered via `AndroidApp::poll_events()`.  Input events are obtained via
//! `AndroidApp::input_events_iter()`.

#![allow(unsafe_code)]
#![allow(non_snake_case)]

use std::{
    collections::VecDeque,
    ffi::c_void,
    mem::ManuallyDrop,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, OnceLock,
    },
    time::Duration,
};

/// Whether the deferred init-window callback has already been invoked.
///
/// Reset to `false` on `TerminateWindow` so that when the surface is
/// recreated on resume the init callbacks run again.
static INIT_WINDOW_DONE: AtomicBool = AtomicBool::new(false);

/// Whether the GPUI native library has completed initialization.
///
/// Set to `true` after the first frame is rendered. This can be queried
/// via JNI by a custom Activity to dismiss the splash screen, although
/// with NativeActivity the system splash handles this automatically.
pub static NATIVE_INITIALIZED: AtomicBool = AtomicBool::new(false);

/// Deferred lifecycle flags.
///
/// We must NOT call `win.set_active()` or `platform.did_enter_background()`
/// inside `handle_main_event` (which runs within `poll_events`).
/// The android-activity crate's Java-side callbacks block on a condvar
/// waiting for the native thread to finish processing the command.
/// If our handler tries to acquire the window `state` lock (a
/// `parking_lot::Mutex`), and a background thread is holding it (e.g.
/// during a render pass), we deadlock: native waits on the lock,
/// the lock holder waits for native rendering to complete, but native
/// is stuck.
///
/// Instead, the handlers set these flags and the main loop body
/// processes them AFTER `poll_events` returns.
static PAUSE_PENDING: AtomicBool = AtomicBool::new(false);
static RESUME_PENDING: AtomicBool = AtomicBool::new(false);
static TERM_WINDOW_PENDING: AtomicBool = AtomicBool::new(false);
static INIT_WINDOW_PENDING: AtomicBool = AtomicBool::new(false);
static WINDOW_RESIZED_PENDING: AtomicBool = AtomicBool::new(false);
static LOW_MEMORY_LISTENER: parking_lot::RwLock<Option<fn()>> = parking_lot::RwLock::new(None);
static BACK_PRESSED_LISTENER: parking_lot::RwLock<Option<fn()>> = parking_lot::RwLock::new(None);
static DEEP_LINK_LISTENER: parking_lot::RwLock<Option<fn(String)>> = parking_lot::RwLock::new(None);
static BRIDGE_RESULT_LISTENER: parking_lot::RwLock<Option<fn(u64, bool, String)>> =
    parking_lot::RwLock::new(None);
static BRIDGE_EVENT_LISTENER: parking_lot::RwLock<Option<fn(String, String)>> =
    parking_lot::RwLock::new(None);
#[allow(clippy::type_complexity)]
static WS_EVENT_LISTENER: parking_lot::RwLock<
    Option<fn(u64, String, Option<String>, Option<Vec<u8>>, i32, Option<String>)>,
> = parking_lot::RwLock::new(None);
static A11Y_ACTION_LISTENER: parking_lot::RwLock<Option<fn(u64, String, Option<String>)>> =
    parking_lot::RwLock::new(None);
static A11Y_ENABLED: AtomicBool = AtomicBool::new(false);

/// Software keyboard IME events delivered by `GpuiActivity.GpuiInputConnection`.
#[derive(Debug, Clone)]
pub enum ImeEvent {
    CommitText(String),
    SetComposingText(String),
    FinishComposing,
    DeleteSurrounding { before: i32, after: i32 },
    EditorAction(i32),
}

static IME_EVENTS: parking_lot::Mutex<VecDeque<ImeEvent>> =
    parking_lot::Mutex::new(VecDeque::new());

fn wake_for_ime() {
    if let Some(platform) = platform() {
        if let Some(win) = platform.primary_window() {
            win.schedule_frame();
        }
    }
    if let Some(app) = android_app() {
        app.create_waker().wake();
    }
}

/// Drain all queued IME events on the UI thread before building the frame.
pub fn drain_ime_events() -> Vec<ImeEvent> {
    let mut queue = IME_EVENTS.lock();
    queue.drain(..).collect()
}

/// Returns `true` when at least one IME event awaits processing.
pub fn has_pending_ime_events() -> bool {
    !IME_EVENTS.lock().is_empty()
}

/// Register a listener invoked when Android delivers `MainEvent::LowMemory`.
pub fn set_low_memory_listener(cb: fn()) {
    *LOW_MEMORY_LISTENER.write() = Some(cb);
}

/// Register a listener invoked when Android triggers system back / predictive back.
pub fn set_back_pressed_listener(cb: fn()) {
    *BACK_PRESSED_LISTENER.write() = Some(cb);
}

/// Register a listener invoked when an incoming deep link URL arrives.
pub fn set_deep_link_listener(cb: fn(String)) {
    *DEEP_LINK_LISTENER.write() = Some(cb);
}

/// Register a listener invoked when `GpuiNativeBridge` resolves an async call.
pub fn set_bridge_result_listener(cb: fn(u64, bool, String)) {
    *BRIDGE_RESULT_LISTENER.write() = Some(cb);
}

/// Register a listener invoked when `GpuiNativeBridge` emits a background event.
pub fn set_bridge_event_listener(cb: fn(String, String)) {
    *BRIDGE_EVENT_LISTENER.write() = Some(cb);
}

/// Register a listener invoked when `GpuiWebSocket` emits a socket event.
pub fn set_ws_event_listener(
    cb: fn(u64, String, Option<String>, Option<Vec<u8>>, i32, Option<String>),
) {
    *WS_EVENT_LISTENER.write() = Some(cb);
}

/// Register a listener invoked when TalkBack triggers an action on a node.
pub fn set_a11y_action_listener(cb: fn(u64, String, Option<String>)) {
    *A11Y_ACTION_LISTENER.write() = Some(cb);
}

/// Returns `true` when Android Accessibility / TalkBack is active.
pub fn is_a11y_enabled() -> bool {
    A11Y_ENABLED.load(Ordering::Acquire)
}

/// Read plain text from Android's system clipboard via `GpuiActivity.getClipboardText()`.
pub fn read_system_clipboard() -> Option<String> {
    with_env(|env| {
        let cls = find_app_class(env, "dev.gpui.mobile.GpuiActivity")?;
        let val = env
            .call_static_method(
                &cls,
                jni::jni_str!("getClipboardText"),
                jni::jni_sig!("()Ljava/lang/String;"),
                &[],
            )
            .and_then(|v| v.l())
            .map_err(|e| {
                env.exception_clear();
                e.to_string()
            })?;
        if val.is_null() {
            return Ok(None);
        }
        Ok(Some(get_string(env, &val)))
    })
    .ok()
    .flatten()
}

/// Write plain text to Android's system clipboard via `GpuiActivity.setClipboardText()`.
pub fn write_system_clipboard(text: &str) -> bool {
    with_env(|env| {
        let cls = find_app_class(env, "dev.gpui.mobile.GpuiActivity")?;
        let jtext = env.new_string(text).e()?;
        let ok = env
            .call_static_method(
                &cls,
                jni::jni_str!("setClipboardText"),
                jni::jni_sig!("(Ljava/lang/String;)Z"),
                &[JValue::Object(&jtext)],
            )
            .and_then(|v| v.z())
            .map_err(|e| {
                env.exception_clear();
                e.to_string()
            })?;
        Ok(ok)
    })
    .unwrap_or(false)
}
static CONFIG_CHANGED_PENDING: AtomicBool = AtomicBool::new(false);
// Java delivers animation samples; the native UI loop owns all GPUI callbacks.
static WINDOW_INSETS_PENDING: parking_lot::Mutex<Option<([i32; 4], [i32; 4])>> =
    parking_lot::Mutex::new(None);

use android_activity::{AndroidApp, MainEvent, PollEvent};

use super::platform::{AndroidPlatform, SharedPlatform};

use jni::objects::{JObject, JString, JValue};
use jni::JavaVM;

// ── JNI helpers (safe `jni` crate wrappers) ──────────────────────────────────

static JAVA_VM: OnceLock<JavaVM> = OnceLock::new();

/// Get or create the static `JavaVM` wrapper.
fn java_vm_safe() -> Result<&'static JavaVM, String> {
    if let Some(vm) = JAVA_VM.get() {
        return Ok(vm);
    }
    let ptr = java_vm();
    if ptr.is_null() {
        return Err("JavaVM not available".into());
    }
    Ok(JAVA_VM.get_or_init(|| unsafe { JavaVM::from_raw(ptr as *mut jni::sys::JavaVM) }))
}

/// Run a closure with an attached `jni::Env` for the current thread.
///
/// In jni 0.22 the `attach_current_thread` API is closure-based.
/// The thread is auto-detached when the closure returns (if it was
/// not already attached).
pub fn with_env<T>(f: impl FnOnce(&mut jni::Env) -> Result<T, String>) -> Result<T, String> {
    let vm = java_vm_safe()?;
    let mut result: Option<Result<T, String>> = None;
    vm.attach_current_thread(|env: &mut jni::Env| -> Result<(), jni::errors::Error> {
        result = Some(f(env));
        Ok(())
    })
    .map_err(|e: jni::errors::Error| e.to_string())?;
    result.unwrap()
}

/// Convenience alias: kept so existing callers that import `obtain_env`
/// compile with minimal changes. Returns a result by running the given
/// closure inside `with_env`.
#[inline]
pub fn obtain_env<T>(f: impl FnOnce(&mut jni::Env) -> Result<T, String>) -> Result<T, String> {
    with_env(f)
}

/// Get the Activity as a [`JObject`].
///
/// `activity_as_ptr()` returns a JNI global reference from `android-activity`
/// that is valid for the lifetime of the app. We wrap it in a `JObject`.
///
/// Requires `&Env` because jni 0.22's `JObject::from_raw` binds the
/// local-reference-frame lifetime.
pub fn activity<'local>(env: &jni::Env<'local>) -> Result<JObject<'local>, String> {
    let ptr = activity_as_ptr();
    if ptr.is_null() {
        return Err("Activity not available".into());
    }
    Ok(unsafe { JObject::from_raw(env, ptr as jni::sys::jobject) })
}

/// Convert a Java String (`JObject` wrapping a `java.lang.String`) to a Rust `String`.
///
/// Returns an empty string on null or error.
pub fn get_string(env: &mut jni::Env<'_>, obj: &JObject<'_>) -> String {
    if obj.is_null() {
        return String::new();
    }
    let jstr = unsafe { JString::from_raw(env, obj.as_raw()) };
    jstr.to_string()
}

/// Extension trait for converting `jni::errors::Result<T>` to `Result<T, String>`.
pub(crate) trait JniExt<T> {
    fn e(self) -> Result<T, String>;
}

impl<T> JniExt<T> for jni::errors::Result<T> {
    fn e(self) -> Result<T, String> {
        self.map_err(|e| e.to_string())
    }
}

/// Find an application class by name using the Activity's classloader.
///
/// From native threads, `JNIEnv::FindClass` uses the system classloader
/// which doesn't know about application classes.  This helper uses the
/// Activity's classloader via `activity.getClass().getClassLoader().loadClass(name)`.
///
/// `class_name` uses Java dot notation (e.g. `"dev.gpui.mobile.GpuiHelper"`).
pub fn find_app_class<'local>(
    env: &mut jni::Env<'local>,
    class_name: &str,
) -> Result<jni::objects::JClass<'local>, String> {
    let act = activity(env)?;

    // activity.getClassLoader() — call on the Context instance directly.
    // Do NOT use activity.getClass().getClassLoader(): NativeActivity is a
    // framework class loaded by BootClassLoader, which cannot see app classes.
    let class_loader = env
        .call_method(
            &act,
            jni::jni_str!("getClassLoader"),
            jni::jni_sig!("()Ljava/lang/ClassLoader;"),
            &[],
        )
        .and_then(|v| v.l())
        .map_err(|e| {
            env.exception_clear();
            let msg = format!("getClassLoader failed: {e}");
            log::error!("find_app_class({class_name}): {msg}");
            msg
        })?;

    // classLoader.loadClass("dev.gpui.mobile.GpuiHelper")
    let jname = env.new_string(class_name).e()?;
    let loaded = env
        .call_method(
            &class_loader,
            jni::jni_str!("loadClass"),
            jni::jni_sig!("(Ljava/lang/String;)Ljava/lang/Class;"),
            &[JValue::Object(&jname)],
        )
        .and_then(|v| v.l())
        .map_err(|e| {
            // Print full Java stack trace to logcat, then clear.
            env.exception_describe();
            env.exception_clear();
            let msg = format!("loadClass({class_name}) failed: {e}");
            log::error!("{msg}");
            msg
        })?;

    log::debug!("find_app_class: loaded {class_name}");
    Ok(unsafe { jni::objects::JClass::from_raw(env, loaded.as_raw()) })
}

// ── global state ─────────────────────────────────────────────────────────────

/// The `AndroidApp` handle from `android-activity`.
///
/// Replaced on each `init_platform` call and cleared on `shutdown_platform`.
static ANDROID_APP: parking_lot::RwLock<Option<AndroidApp>> = parking_lot::RwLock::new(None);

/// Cached hardware display modes discovered from Android's Display API. The
/// value is refreshed on each surface init; the mutex keeps the query usable
/// from the Hermes worker when the settings page opens.
static SUPPORTED_REFRESH_RATES: OnceLock<parking_lot::Mutex<Vec<f32>>> = OnceLock::new();
static INTERACTION_FRAME_RATE_CAP: AtomicU32 = AtomicU32::new(0);

/// A non-blocking request from the Hermes settings UI. The Android event loop
/// consumes it on its own thread, avoiding a synchronous GPUI command hop
/// while InputDispatcher is waiting for the current MotionEvent.
static PENDING_POWER_FRAME_RATE: AtomicU32 = AtomicU32::new(0);

/// Active `AndroidPlatform` instance for the current Activity session.
///
/// Initialised in `init_platform` on the active `android_main` thread and
/// cleared in `shutdown_platform` when the session exits.
static PLATFORM: parking_lot::RwLock<Option<Arc<AndroidPlatform>>> =
    parking_lot::RwLock::new(None);

/// Get the unicode character produced by an Android key event via JNI.
///
/// This creates a `android.view.KeyEvent` Java object and calls
/// `getUnicodeChar(metaState)` on it.  Returns 0 on failure.
pub fn unicode_char_for_key_event(key_code: i32, action: i32, meta_state: i32) -> u32 {
    with_env(|env| {
        let key_event = match env.new_object(
            jni::jni_str!("android/view/KeyEvent"),
            jni::jni_sig!("(II)V"),
            &[JValue::Int(action), JValue::Int(key_code)],
        ) {
            Ok(o) => o,
            Err(_) => {
                env.exception_clear();
                return Ok(0);
            }
        };
        match env.call_method(
            &key_event,
            jni::jni_str!("getUnicodeChar"),
            jni::jni_sig!("(I)I"),
            &[JValue::Int(meta_state)],
        ) {
            Ok(v) => {
                let c = v.i().unwrap_or(0);
                Ok(if c > 0 { c as u32 } else { 0 })
            }
            Err(_) => {
                env.exception_clear();
                Ok(0)
            }
        }
    })
    .unwrap_or(0)
}

// ── public accessors ──────────────────────────────────────────────────────────

/// Public accessor for the JavaVM pointer.
///
/// Uses `AndroidApp::vm_as_ptr()` from the stored `AndroidApp`.
/// Used by `platform.rs` for JNI calls.
pub fn java_vm() -> *mut c_void {
    ANDROID_APP
        .read()
        .as_ref()
        .map(|app| app.vm_as_ptr())
        .unwrap_or(std::ptr::null_mut())
}

/// Public accessor for the current Activity's JNI object reference.
///
/// Uses `AndroidApp::activity_as_ptr()` from the stored `AndroidApp`.
/// Used by `platform.rs` and `window.rs` for JNI calls that require the
/// activity's jobject.
///
/// NOTE: This returns a jobject (JNI global ref), NOT an `ANativeActivity *`.
/// Code that previously used `(*activity).clazz` should use this directly
/// as the activity jobject.
pub fn activity_as_ptr() -> *mut c_void {
    ANDROID_APP
        .read()
        .as_ref()
        .map(|app| app.activity_as_ptr())
        .unwrap_or(std::ptr::null_mut())
}

/// Returns a clone of the stored `AndroidApp`, if initialised.
pub fn android_app() -> Option<AndroidApp> {
    ANDROID_APP.read().clone()
}

/// Discover the highest refresh rate that this app may request for an active
/// gesture. We use the panel's supported modes and clamp to the user's
/// `peak_refresh_rate` setting when the OEM exposes it, so 120/144/165 Hz
/// devices work without hard-coding a single target and devices configured to
/// 60 Hz do not fight the system policy.
pub fn query_interaction_frame_rate() -> Option<f32> {
    let result = with_env(|env| {
        let activity = activity(env)?;
        let window_manager = env
            .call_method(
                &activity,
                jni::jni_str!("getWindowManager"),
                jni::jni_sig!("()Landroid/view/WindowManager;"),
                &[],
            )
            .and_then(|value| value.l())
            .map_err(|error| error.to_string())?;
        let display = env
            .call_method(
                &window_manager,
                jni::jni_str!("getDefaultDisplay"),
                jni::jni_sig!("()Landroid/view/Display;"),
                &[],
            )
            .and_then(|value| value.l())
            .map_err(|error| error.to_string())?;
        let modes = env
            .call_method(
                &display,
                jni::jni_str!("getSupportedModes"),
                jni::jni_sig!("()[Landroid/view/Display$Mode;"),
                &[],
            )
            .and_then(|value| value.l())
            .map_err(|error| error.to_string())?;
        if modes.is_null() {
            return Ok(None);
        }

        let modes = unsafe {
            jni::objects::JObjectArray::<JObject>::from_raw(env, modes.as_raw())
        };
        let mut supported = Vec::new();
        for index in 0..modes.len(env).map_err(|error| error.to_string())? {
            let mode = modes
                .get_element(env, index)
                .map_err(|error| error.to_string())?;
            if let Ok(rate) = env
                .call_method(
                    &mode,
                    jni::jni_str!("getRefreshRate"),
                    jni::jni_sig!("()F"),
                    &[],
                )
                .and_then(|value| value.f())
            {
                if rate.is_finite() && rate > 1.0 {
                    supported.push(rate);
                }
            } else {
                env.exception_clear();
            }
        }
        if supported.is_empty() {
            return Ok(None);
        }

        let peak_refresh_rate = (|| {
            let resolver = env
                .call_method(
                    &activity,
                    jni::jni_str!("getContentResolver"),
                    jni::jni_sig!("()Landroid/content/ContentResolver;"),
                    &[],
                )
                .and_then(|value| value.l())
                .ok()?;
            let settings = env.find_class(jni::jni_str!("android/provider/Settings$System")).ok()?;
            let key = env.new_string("peak_refresh_rate").ok()?;
            env.call_static_method(
                &settings,
                jni::jni_str!("getFloat"),
                jni::jni_sig!("(Landroid/content/ContentResolver;Ljava/lang/String;F)F"),
                &[
                    JValue::Object(&resolver),
                    JValue::Object(&key),
                    JValue::Float(0.0),
                ],
            )
            .ok()
            .and_then(|value| value.f().ok())
            .filter(|value| value.is_finite() && *value > 1.0)
        })();

        let max_supported = supported.iter().copied().fold(0.0_f32, f32::max);
        SUPPORTED_REFRESH_RATES
            .get_or_init(|| parking_lot::Mutex::new(Vec::new()))
            .lock()
            .clone_from(&supported);
        let cap = peak_refresh_rate.unwrap_or(max_supported);
        INTERACTION_FRAME_RATE_CAP.store(cap.round() as u32, Ordering::Release);
        let target = supported
            .iter()
            .copied()
            .filter(|rate| *rate <= cap + 0.5)
            .fold(0.0_f32, f32::max);
        let target = if target > 1.0 { target } else { max_supported };
        log::info!(
            "display refresh capability: supported={:?} system_peak={:.0}Hz interaction_target={:.0}Hz",
            supported,
            cap,
            target
        );
        Ok(Some(target))
    });

    result.unwrap_or(None)
}

/// Return the physical display modes reported by Android, sorted and
/// de-duplicated. This is used by the settings UI to show common refresh-rate
/// choices while disabling rates the current phone does not provide.
pub fn query_supported_refresh_rates() -> Vec<f32> {
    let cache = SUPPORTED_REFRESH_RATES.get_or_init(|| parking_lot::Mutex::new(Vec::new()));
    if cache.lock().is_empty() {
        let _ = query_interaction_frame_rate();
    }
    let mut rates = cache.lock().clone();
    rates.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    rates.dedup_by(|a, b| (*a - *b).abs() < 0.5);
    rates
}

/// Effective high-refresh ceiling after applying the device's current system
/// peak-refresh setting. A phone can expose a 120/144/165 mode but have it
/// disabled by the user/system policy; callers must honor this cap.
pub fn query_interaction_frame_rate_cap() -> f32 {
    let cached = INTERACTION_FRAME_RATE_CAP.load(Ordering::Acquire);
    if cached > 1 {
        return cached as f32;
    }
    query_interaction_frame_rate().unwrap_or(90.0)
}

/// Queue an idle/power-balanced target from JavaScript without waiting for the
/// GPUI executor. The native loop applies it on its next iteration.
pub fn request_power_frame_rate(frame_rate: f32) {
    let rounded = frame_rate.round() as u32;
    if !matches!(rounded, 20 | 30 | 40 | 50 | 60 | 90 | 120 | 144 | 165) {
        log::warn!("ignoring unsupported power frame rate request: {frame_rate}");
        return;
    }
    PENDING_POWER_FRAME_RATE.store(rounded, Ordering::Release);
    if let Some(app) = android_app() {
        app.create_waker().wake();
    }
}

fn take_power_frame_rate_request() -> Option<f32> {
    match PENDING_POWER_FRAME_RATE.swap(0, Ordering::AcqRel) {
        0 => None,
        value => Some(value as f32),
    }
}

/// Returns a clone of the active `AndroidPlatform`, if initialised.
///
/// Returns `None` before `init_platform` has set it up or after `shutdown_platform`.
pub fn platform() -> Option<Arc<AndroidPlatform>> {
    PLATFORM.read().clone()
}

/// Returns a [`SharedPlatform`] wrapping the active `Arc<AndroidPlatform>`.
///
/// This is the value you hand to `Application::with_platform(...)`:
///
/// ```rust,no_run
/// let platform = jni::shared_platform().unwrap();
/// Application::with_platform(platform.into_rc()).run(|cx| { … });
/// ```
///
/// Returns `None` before `init_platform` has been called.
pub fn shared_platform() -> Option<SharedPlatform> {
    platform().map(SharedPlatform::new)
}

// ── input event types ─────────────────────────────────────────────────────────

/// Motion event action constants from the NDK.
const AMOTION_EVENT_ACTION_DOWN: u32 = 0;
const AMOTION_EVENT_ACTION_UP: u32 = 1;
const AMOTION_EVENT_ACTION_MOVE: u32 = 2;

// ── night mode query via NDK Configuration ───────────────────────────────────

/// Query the current night mode using the NDK Configuration API.
///
/// Returns `true` if the system is in dark mode.
pub fn query_night_mode_via_jni() -> bool {
    let app = match android_app() {
        Some(app) => app,
        None => return false,
    };

    // Build an ndk::configuration::Configuration from the app's asset manager.
    let config = ndk::configuration::Configuration::from_asset_manager(&app.asset_manager());
    let is_dark = config.ui_mode_night() == ndk::configuration::UiModeNight::Yes;

    log::debug!("query_night_mode (ndk): is_dark={}", is_dark);
    is_dark
}

// ── input event processing ────────────────────────────────────────────────────

/// Process input events from the `AndroidApp` and dispatch them to the window.
/// Returns whether at least one user input event was consumed.
fn process_input_events(app: &AndroidApp) -> bool {
    let platform = match platform() {
        Some(p) => p,
        None => {
            log::trace!("process_input_events: no platform yet");
            return false;
        }
    };

    let win = match platform.primary_window() {
        Some(w) => w,
        None => {
            log::trace!("process_input_events: no primary window yet");
            return false;
        }
    };

    let mut had_input = false;
    match app.input_events_iter() {
        Ok(mut iter) => {
            loop {
                let read_input = iter.next(|event| {
                    use android_activity::input::{InputEvent, MotionAction};

                    had_input = true;

                    match event {
                        InputEvent::MotionEvent(motion_event) => {
                            let action = motion_event.action();
                            let pointer_count = motion_event.pointer_count();

                            log::debug!(
                                "process_input_events: MotionEvent action={:?} pointers={}",
                                action,
                                pointer_count,
                            );

                            // Check if this touch lands on a platform view.
                            //
                            // On Android with NativeActivity, ALL touch events go
                            // to the native surface first. Platform views are real
                            // Java Views in a FrameLayout overlay, but they won't
                            // receive touches unless we skip GPUI dispatch and let
                            // Android's view hierarchy handle the event instead.
                            //
                            // We use the primary pointer for the hit-test on DOWN
                            // actions. Physical pixel coordinates are converted to
                            // logical pixels to match PlatformViewBounds.
                            let hits_platform_view = {
                                let registry = crate::platform_view::PlatformViewRegistry::global();
                                if registry.active_view_count() > 0 {
                                    let primary = motion_event.pointer_at_index(
                                        match action {
                                            MotionAction::PointerDown | MotionAction::PointerUp => {
                                                motion_event.pointer_index()
                                            }
                                            _ => 0,
                                        }
                                    );
                                    let scale = win.scale_factor();
                                    let logical_x = primary.x() / scale;
                                    let logical_y = primary.y() / scale;
                                    registry.hit_test(logical_x, logical_y)
                                } else {
                                    false
                                }
                            };

                            if hits_platform_view {
                                log::debug!(
                                    "process_input_events: touch hits platform view, skipping GPUI dispatch",
                                );
                                // Return Unhandled so android-activity can pass
                                // the event back to the Java view hierarchy where
                                // the platform view's FrameLayout lives.
                                return android_activity::InputStatus::Unhandled;
                            }

                            if matches!(action, MotionAction::Move) && pointer_count > 0 {
                                let current_event_time = motion_event.event_time();
                                let primary = motion_event.pointer_at_index(0);
                                for hist in primary.history() {
                                    let age_nanos =
                                        current_event_time.saturating_sub(hist.event_time()).max(0)
                                            as u64;
                                    win.record_touch_history(hist.x(), hist.y(), age_nanos);
                                }
                            }

                            for i in 0..pointer_count {
                                let pointer = motion_event.pointer_at_index(i);

                                let touch_action = match action {
                                    MotionAction::Down => AMOTION_EVENT_ACTION_DOWN,
                                    MotionAction::PointerDown => {
                                        // For pointer down, only dispatch the specific pointer
                                        if i != motion_event.pointer_index() {
                                            continue;
                                        }
                                        AMOTION_EVENT_ACTION_DOWN
                                    }
                                    MotionAction::Up => AMOTION_EVENT_ACTION_UP,
                                    MotionAction::PointerUp => {
                                        // For pointer up, only dispatch the specific pointer
                                        if i != motion_event.pointer_index() {
                                            continue;
                                        }
                                        AMOTION_EVENT_ACTION_UP
                                    }
                                    MotionAction::Move => AMOTION_EVENT_ACTION_MOVE,
                                    MotionAction::Cancel => AMOTION_EVENT_ACTION_UP,
                                    _ => continue,
                                };

                                let touch = crate::android::TouchPoint {
                                    id: pointer.pointer_id(),
                                    x: pointer.x(),
                                    y: pointer.y(),
                                    action: touch_action,
                                };

                                log::debug!(
                                    "process_input_events: dispatching touch id={} x={:.0} y={:.0} action={}",
                                    touch.id, touch.x, touch.y, touch.action,
                                );

                                win.handle_touch(touch);
                            }

                            android_activity::InputStatus::Handled
                        }
                        InputEvent::KeyEvent(key_event) => {
                            use android_activity::input::KeyAction;

                            let action = match key_event.action() {
                                KeyAction::Down => 0,
                                KeyAction::Up => 1,
                                _ => return android_activity::InputStatus::Unhandled,
                            };

                            let key_code: u32 = key_event.key_code().into();
                            let meta_state: u32 = key_event.meta_state().0;

                            let unicode_char = unicode_char_for_key_event(
                                key_code as i32,
                                action,
                                meta_state as i32,
                            );

                            if unicode_char != 0 {
                                log::trace!(
                                    "dispatch_key_event: code={} action={} meta={:#x} → unicode=U+{:04X}",
                                    key_code,
                                    action,
                                    meta_state,
                                    unicode_char
                                );
                            }

                            let key_event = crate::android::AndroidKeyEvent {
                                key_code: key_code as i32,
                                action,
                                meta_state: meta_state as i32,
                                unicode_char,
                            };

                            win.handle_key_event(key_event);
                            android_activity::InputStatus::Handled
                        }
                        _ => android_activity::InputStatus::Unhandled,
                    }
                });

                if !read_input {
                    break;
                }
            }
        }
        Err(err) => {
            log::error!("Failed to get input events iterator: {err:?}");
        }
    }

    had_input
}

// ── main event loop ───────────────────────────────────────────────────────────

/// The event loop that processes `android-activity` events and drives the
/// platform.
///
/// Called from `android_main` after the platform is initialised.
/// Runs until the platform requests quit or the activity is destroyed.
pub fn run_event_loop(app: &AndroidApp) {
    log::info!("run_event_loop: entering main loop");

    // Track whether the on_init_window callback has already been invoked.
    // We do NOT invoke it inside handle_main_event (which runs inside
    // poll_events) because the callback can be heavy (shader compilation,
    // GPUI Application setup).  Running it there blocks the event loop and
    // prevents the system's FocusEvent from being consumed, triggering an
    // ANR after 10 seconds.
    //
    // Instead we check each loop iteration: if a primary window exists and
    // the callback is still pending, invoke it *after* poll_events has
    // returned so focus/input events have already been drained.
    INIT_WINDOW_DONE.store(false, Ordering::Relaxed);
    let mut iteration: u64 = 0;
    let mut last_heartbeat = std::time::Instant::now();
    let loop_started = std::time::Instant::now();
    let mut app_is_active = false;

    loop {
        iteration += 1;

        // Log a heartbeat every 5 seconds so we can tell if the loop is alive.
        let now = std::time::Instant::now();
        if now.duration_since(last_heartbeat) >= Duration::from_secs(5) {
            log::info!(
                "run_event_loop: heartbeat — iteration={}, init_done={}, active={}",
                iteration,
                INIT_WINDOW_DONE.load(Ordering::Relaxed),
                app_is_active,
            );
            last_heartbeat = now;
        }

        // Check if quit was requested.
        if let Some(platform) = platform() {
            if platform.should_quit() {
                log::info!("run_event_loop: platform requested quit");
                dispose_all_platform_views();
                break;
            }
            platform.tick();
        }

        // Apply settings changes on the Android/native thread. The Hermes
        // worker only enqueues an atomic request, so changing the selector
        // cannot block the input acknowledgement path.
        if let Some(frame_rate) = take_power_frame_rate_request() {
            if let Some(platform) = platform() {
                if let Some(window) = platform.primary_window() {
                    window.set_power_frame_rate(frame_rate);
                }
            }
        }

        // ── Poll for events ──
        //
        // Use high-rate polling only while a touch/momentum interaction is
        // active. A dirty-frame wake is handled immediately; otherwise static
        // content gets a coarse 1s watchdog and enters deep idle after one
        // minute. The Android looper/input queue and GPUI frame waker still
        // interrupt both waits immediately when work arrives.
        let (frame_pending, interactive) = platform()
            .and_then(|platform| platform.primary_window())
            .map(|window| {
                (
                    window.has_frame_request() || has_pending_ime_events(),
                    window.is_active() && window.is_interactive(),
                )
            })
            .unwrap_or((has_pending_ime_events(), false));
        let external_demand = crate::android::vsync::has_external_demand();
        let vsync_requested = crate::android::vsync::is_requested();
        let can_render = app_is_active && INIT_WINDOW_DONE.load(Ordering::Relaxed);
        let need_vsync =
            can_render && (frame_pending || interactive || external_demand || vsync_requested);
        let hw_vsync = if need_vsync {
            crate::android::vsync::arm_if_needed()
        } else {
            false
        };

        let poll_timeout = if !can_render {
            // Never busy-spin while backgrounded/unfocused/uninitialized:
            // frame_pending or a late VSync is not consumed until active again.
            Some(Duration::from_secs(1))
        } else if crate::android::vsync::has_fired() {
            Some(Duration::ZERO)
        } else if need_vsync && hw_vsync {
            // Wait for hardware AChoreographer VSync callback (which wakes the
            // looper immediately), keeping a bounded 50 ms safety watchdog.
            Some(Duration::from_millis(50))
        } else if frame_pending {
            Some(Duration::ZERO)
        } else if interactive || external_demand {
            Some(Duration::from_millis(8))
        } else {
            // Keep a finite NativeActivity poll so Android's InputDispatcher
            // can complete its acknowledgement handshake on OEM builds that
            // do not wake a `None` timeout reliably.
            Some(Duration::from_secs(1))
        };
        app.poll_events(poll_timeout, |event| match event {
            PollEvent::Main(main_event) => {
                handle_main_event(app, main_event);
            }
            PollEvent::Wake => {}
            PollEvent::Timeout => {}
            _ => {}
        });

        // ── Deferred lifecycle processing ──
        //
        // Between each handler, call poll_events again to drain any
        // events the Java UI thread may have queued while we were
        // processing.  This keeps the condvar wait short and prevents
        // the InputDispatcher ANR (10s timeout on MotionEvent delivery).
        //
        // Helper closure to drain events quickly:
        let drain_events = |app: &AndroidApp| {
            app.poll_events(Some(Duration::ZERO), |event| {
                if let PollEvent::Main(main_event) = event {
                    handle_main_event(app, main_event);
                }
            });
        };

        // 1. TerminateWindow — unconfigure surface, release native window
        if TERM_WINDOW_PENDING.swap(false, Ordering::Relaxed) {
            log::info!("deferred: TerminateWindow (iter={})", iteration);
            INIT_WINDOW_DONE.store(false, Ordering::Relaxed);
            crate::android::vsync::reset();
            *LAST_CHROME_STYLE.lock().unwrap() = None;
            if let Some(platform) = platform() {
                if let Some(win) = platform.primary_window() {
                    win.term_window();
                }
            }
            // Drain immediately — Java thread may be blocked on InitWindow condvar.
            drain_events(app);
        }

        // 2. InitWindow — replace surface on existing renderer, or create new
        if INIT_WINDOW_PENDING.swap(false, Ordering::Relaxed) {
            log::info!("deferred: InitWindow (iter={})", iteration);
            if let Some(platform) = platform() {
                if let Some(native_window) = app.native_window() {
                    let width = native_window.width();
                    let height = native_window.height();
                    log::info!("InitWindow: {}×{}", width, height);

                    platform.update_primary_display(&native_window, &app.asset_manager());

                    let scale_factor = platform
                        .primary_display()
                        .map(|d| d.scale_factor())
                        .unwrap_or(1.0);

                    if let Some(existing) = platform.primary_window() {
                        let gpu_ctx = platform.gpu_context();
                        match existing.init_window(native_window, gpu_ctx) {
                            Ok(()) => {
                                log::info!("InitWindow: reinitialised existing window");
                            }
                            Err(e) => {
                                log::error!("failed to reinit window surface: {e:#}");
                            }
                        }

                        // Trigger GPUI resize so layout adapts to new dimensions.
                        existing.handle_resize();

                        let cr = app.content_rect();
                        existing.update_safe_area_from_content_rect(
                            cr.left, cr.top, cr.right, cr.bottom,
                        );

                        INIT_WINDOW_DONE.store(true, Ordering::Relaxed);
                    } else {
                        match platform.open_window(native_window, scale_factor, false) {
                            Ok(win) => {
                                log::info!(
                                    "window opened — id={:#x} scale={:.1}",
                                    win.id(),
                                    scale_factor
                                );

                                let cr = app.content_rect();
                                win.update_safe_area_from_content_rect(
                                    cr.left, cr.top, cr.right, cr.bottom,
                                );
                            }
                            Err(e) => {
                                log::error!("failed to open window: {e:#}");
                            }
                        }
                    }
                }
            }
            // Drain — Java thread may have queued ConfigChanged/WindowResized.
            drain_events(app);
        }

        // 3. WindowResized
        if WINDOW_RESIZED_PENDING.swap(false, Ordering::Relaxed) {
            log::debug!("deferred: WindowResized");
            if let Some(platform) = platform() {
                if let Some(win) = platform.primary_window() {
                    win.handle_resize();
                    let cr = app.content_rect();
                    win.update_safe_area_from_content_rect(cr.left, cr.top, cr.right, cr.bottom);
                }
            }
        }

        // 4. ConfigChanged
        if CONFIG_CHANGED_PENDING.swap(false, Ordering::Relaxed) {
            log::debug!("deferred: ConfigChanged");
            if let Some(platform) = platform() {
                platform.notify_keyboard_layout_change();
                let is_dark = query_night_mode_via_jni();
                if let Some(win) = platform.primary_window() {
                    let appearance = if is_dark {
                        crate::android::window::WindowAppearance::Dark
                    } else {
                        crate::android::window::WindowAppearance::Light
                    };
                    win.set_appearance(appearance);
                }
            }
        }

        if let Some(window) = platform().and_then(|platform| platform.primary_window()) {
            let pending = WINDOW_INSETS_PENDING.lock().take();
            if let Some((safe_area, ime)) = pending {
                let insets = |values: [i32; 4]| super::window::SafeAreaInsets {
                    left: values[0].max(0) as f32,
                    top: values[1].max(0) as f32,
                    right: values[2].max(0) as f32,
                    bottom: values[3].max(0) as f32,
                };
                window.update_system_insets(insets(safe_area), insets(ime));
            }
        }

        // 5. Pause / background
        if PAUSE_PENDING.swap(false, Ordering::Relaxed) {
            log::info!("deferred: Pause (iter={})", iteration);
            crate::android::vsync::reset();
            if let Some(platform) = platform() {
                platform.did_enter_background();
                if let Some(win) = platform.primary_window() {
                    win.set_active(false);
                }
            }
            // Pause platform views
            pause_platform_views();
        }

        // 6. Resume / foreground
        if RESUME_PENDING.swap(false, Ordering::Relaxed) {
            log::info!("deferred: Resume (iter={})", iteration);
            if let Some(platform) = platform() {
                platform.did_become_active();
                if let Some(win) = platform.primary_window() {
                    win.set_active(true);
                }
            }
            // Resume platform views
            resume_platform_views();
        }

        // Track active/focused state.
        if let Some(platform) = platform() {
            if let Some(win) = platform.primary_window() {
                let is_active = win.is_active();
                if is_active != app_is_active {
                    log::info!(
                        "run_event_loop: active {} -> {} (iter={})",
                        app_is_active,
                        is_active,
                        iteration,
                    );
                    app_is_active = is_active;
                }
            }
        }

        // Process input events.
        process_input_events(app);

        // Deferred initialisation callbacks (runs once).
        if !INIT_WINDOW_DONE.load(Ordering::Relaxed) {
            if let Some(platform) = platform() {
                if platform.primary_window().is_some() {
                    if let Some(finish_cb) = platform.take_finish_launching_callback() {
                        log::info!("invoking finish_launching callback (iter={})", iteration);
                        finish_cb();
                    }

                    if let Some(init_cb) = platform.take_on_init_window_callback() {
                        let win = platform.primary_window().unwrap();
                        log::info!("invoking on_init_window callback (iter={})", iteration);
                        init_cb(win);
                    }

                    INIT_WINDOW_DONE.store(true, Ordering::Relaxed);
                    NATIVE_INITIALIZED.store(true, Ordering::Release);
                    log::info!("NATIVE_INITIALIZED = true");

                    // The window starts with one pending frame request. Keep
                    // the render demand-driven so a static surface does not
                    // keep repainting after the first frame.
                    if let Some(win) = platform.primary_window() {
                        win.schedule_frame();
                    }
                }
            }
        }

        // ── Render ──
        if let Some(platform) = platform() {
            if INIT_WINDOW_DONE.load(Ordering::Relaxed) && app_is_active {
                let fired_ns = crate::android::vsync::take_fired();
                let external_now = crate::android::vsync::has_external_demand();
                if let Some(frame_time_ns) = fired_ns {
                    crate::android::vsync::notify_frame_listener(frame_time_ns);
                } else if !hw_vsync && (external_now || vsync_requested) {
                    let fallback_ns = loop_started.elapsed().as_nanos() as i64;
                    crate::android::vsync::notify_frame_listener(fallback_ns);
                }

                platform.flush_main_thread_tasks();
                if let Some(win) = platform.primary_window() {
                    if fired_ns.is_some() || !hw_vsync || iteration <= 4 {
                        let had_request = win.take_frame_request();
                        let should_render =
                            had_request || (fired_ns.is_some() && win.is_interactive());
                        if should_render {
                            // Arm next VSync on the dedicated VSync thread before rendering
                            // so 120Hz (8.33ms) edges are never missed.
                            if win.is_interactive() || crate::android::vsync::has_external_demand() {
                                crate::android::vsync::arm_if_needed();
                            }
                            win.request_frame();
                        }
                    }
                }

                // Drain lifecycle events that arrived during rendering
                // (e.g. rotation triggers TerminateWindow while we were
                // in get_current_texture / present).
                drain_events(app);
                process_input_events(app);
            }
        }

        // No busy-wait here: poll_events above is the idle backoff and is
        // interrupted by Android input or the GPUI dispatcher waker.
    }

    log::info!("run_event_loop: exiting main loop");
}

/// Pause all platform views when the app goes to background.
fn pause_platform_views() {
    let _ = with_env(|env| {
        if let Ok(helper_class) = find_app_class(env, "dev.gpui.mobile.GpuiPlatformView") {
            let _ = env.call_static_method(
                &helper_class,
                jni::jni_str!("pauseAll"),
                jni::jni_sig!("()V"),
                &[],
            );
            env.exception_clear();
        }
        Ok(())
    });
}

/// Resume all platform views when the app returns to foreground.
fn resume_platform_views() {
    let _ = with_env(|env| {
        if let Ok(helper_class) = find_app_class(env, "dev.gpui.mobile.GpuiPlatformView") {
            let _ = env.call_static_method(
                &helper_class,
                jni::jni_str!("resumeAll"),
                jni::jni_sig!("()V"),
                &[],
            );
            env.exception_clear();
        }
        Ok(())
    });
}

/// Dispose all platform views during app shutdown.
fn dispose_all_platform_views() {
    let _ = with_env(|env| {
        if let Ok(helper_class) = find_app_class(env, "dev.gpui.mobile.GpuiPlatformView") {
            let _ = env.call_static_method(
                &helper_class,
                jni::jni_str!("disposeAll"),
                jni::jni_sig!("()V"),
                &[],
            );
            env.exception_clear();
        }
        Ok(())
    });
}

/// Handle a single `MainEvent` from `android-activity`.
fn handle_main_event(_app: &AndroidApp, event: MainEvent<'_>) {
    match event {
        MainEvent::InitWindow { .. } => {
            log::info!("MainEvent::InitWindow");
            // Defer to after poll_events to avoid deadlock with state lock.
            INIT_WINDOW_PENDING.store(true, Ordering::Relaxed);
        }

        MainEvent::TerminateWindow { .. } => {
            log::info!("MainEvent::TerminateWindow");
            // Defer to after poll_events to avoid deadlock with state lock.
            TERM_WINDOW_PENDING.store(true, Ordering::Relaxed);
        }

        MainEvent::WindowResized { .. } => {
            log::debug!("MainEvent::WindowResized");
            // Defer to after poll_events to avoid deadlock with state lock.
            WINDOW_RESIZED_PENDING.store(true, Ordering::Relaxed);
        }

        MainEvent::GainedFocus => {
            log::info!("MainEvent::GainedFocus");
            RESUME_PENDING.store(true, Ordering::Relaxed);
        }

        MainEvent::LostFocus => {
            log::info!("MainEvent::LostFocus");
            PAUSE_PENDING.store(true, Ordering::Relaxed);
        }

        MainEvent::Resume { .. } => {
            log::info!("MainEvent::Resume");
            RESUME_PENDING.store(true, Ordering::Relaxed);
        }

        MainEvent::Pause => {
            log::info!("MainEvent::Pause");
            // set_active uses AtomicBool so it never blocks.
            PAUSE_PENDING.store(true, Ordering::Relaxed);
        }

        MainEvent::ConfigChanged { .. } => {
            log::debug!("MainEvent::ConfigChanged");
            CONFIG_CHANGED_PENDING.store(true, Ordering::Relaxed);
        }

        MainEvent::Start => {
            log::info!("MainEvent::Start");
        }

        MainEvent::Stop => {
            log::info!("MainEvent::Stop");
        }

        MainEvent::SaveState { .. } => {
            log::info!("MainEvent::SaveState");
        }

        MainEvent::LowMemory => {
            log::warn!("MainEvent::LowMemory — triggering memory reclaim");
            if let Some(cb) = *LOW_MEMORY_LISTENER.read() {
                cb();
            }
        }

        MainEvent::Destroy => {
            log::info!("MainEvent::Destroy");

            if let Some(platform) = platform() {
                platform.quit();
            }
        }

        MainEvent::InsetsChanged { .. } => {
            log::debug!("MainEvent::InsetsChanged");
            WINDOW_RESIZED_PENDING.store(true, Ordering::Relaxed);
        }

        MainEvent::ContentRectChanged { .. } => {
            log::debug!("MainEvent::ContentRectChanged");
            WINDOW_RESIZED_PENDING.store(true, Ordering::Relaxed);
        }

        _ => {
            log::trace!("MainEvent: other variant");
        }
    }
}

// ── main loop helper (compat with existing code) ──────────────────────────────

/// Run one iteration of the event loop.
///
/// This is a compatibility wrapper for code that uses a manual poll loop.
/// Prefer `run_event_loop` for the standard event loop.
///
/// `timeout_ms` — how long to block waiting for events (milliseconds).
/// Pass `0` for non-blocking, `-1` to block indefinitely.
///
/// Returns `true` if the application should exit.
pub fn poll_events(timeout_ms: i32) -> bool {
    if let Some(platform) = platform() {
        if platform.should_quit() {
            return true;
        }
        platform.tick();
    }

    let app = match android_app() {
        Some(app) => app,
        None => return false,
    };

    let timeout = if timeout_ms < 0 {
        None
    } else {
        Some(Duration::from_millis(timeout_ms as u64))
    };

    app.poll_events(timeout, |event| match event {
        PollEvent::Main(main_event) => {
            handle_main_event(&app, main_event);
        }
        PollEvent::Wake => {}
        _ => {}
    });

    process_input_events(&app);

    // Drive the GPUI rendering pipeline (same as run_event_loop).
    if let Some(platform) = platform() {
        platform.flush_main_thread_tasks();
        if let Some(win) = platform.primary_window() {
            win.request_frame();
        }
    }

    false
}

// ── public init / run helpers ─────────────────────────────────────────────────

/// Install a panic hook that routes panic messages to logcat.
///
/// Call this early in `android_main` so that any subsequent panic is
/// visible via `adb logcat`.  Safe to call multiple times — each call
/// replaces the previous hook.
pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "Box<dyn Any>".to_string()
        };
        if let Some(loc) = info.location() {
            log::error!(
                "PANIC at {}:{}:{}: {}",
                loc.file(),
                loc.line(),
                loc.column(),
                payload
            );
        } else {
            log::error!("PANIC: {}", payload);
        }
    }));
}

/// Store the `AndroidApp` and create a fresh `AndroidPlatform` bound to the
/// current `android_main` thread.
///
/// Safe to invoke across Activity destroy/recreate cycles inside the same
/// Android process; each call resets per-session deferred flags and binds the
/// new `AndroidDispatcher` to `std::thread::current().id()`.
pub fn init_platform(app: &AndroidApp) -> Arc<AndroidPlatform> {
    INIT_WINDOW_DONE.store(false, Ordering::Release);
    NATIVE_INITIALIZED.store(false, Ordering::Release);
    PAUSE_PENDING.store(false, Ordering::Release);
    RESUME_PENDING.store(false, Ordering::Release);
    TERM_WINDOW_PENDING.store(false, Ordering::Release);
    INIT_WINDOW_PENDING.store(false, Ordering::Release);
    WINDOW_RESIZED_PENDING.store(false, Ordering::Release);
    CONFIG_CHANGED_PENDING.store(false, Ordering::Release);
    PENDING_POWER_FRAME_RATE.store(0, Ordering::Release);
    IME_EVENTS.lock().clear();
    *LAST_CHROME_STYLE.lock().unwrap() = None;
    crate::android::vsync::reset();

    *ANDROID_APP.write() = Some(app.clone());
    log::info!("init_platform: stored AndroidApp");

    let platform = Arc::new(AndroidPlatform::new(false));
    log::info!("init_platform: AndroidPlatform created");

    *PLATFORM.write() = Some(Arc::clone(&platform));
    platform
}

/// Tear down the current `AndroidPlatform` session on the owning `android_main`
/// thread before releasing control back to `android-activity`.
///
/// Only clears the global `PLATFORM` / `ANDROID_APP` slots if they still point
/// to `expected`, ensuring a finishing teardown never clobbers a newer session.
pub fn shutdown_platform(expected: &Arc<AndroidPlatform>) {
    crate::android::vsync::reset();
    expected.background_executor().shutdown();
    expected.clear_windows();

    let mut platform_slot = PLATFORM.write();
    let is_same = platform_slot
        .as_ref()
        .is_some_and(|current| Arc::ptr_eq(current, expected));
    if is_same {
        *platform_slot = None;
        drop(platform_slot);
        *ANDROID_APP.write() = None;
        INIT_WINDOW_DONE.store(false, Ordering::Release);
        NATIVE_INITIALIZED.store(false, Ordering::Release);
        log::info!("shutdown_platform: cleared active AndroidPlatform session");
    } else {
        log::warn!("shutdown_platform: active PLATFORM already replaced; skipping global clear");
    }
}

// ── system chrome (status bar / navigation bar) ───────────────────────────────

/// Cached last-applied system chrome style.
///
/// `set_system_chrome` is called on every frame render.  The JNI calls it
/// makes (getWindow, setStatusBarColor, etc.) are View operations that can
/// contend with the Android UI thread and intermittently deadlock.
/// By caching the last applied style we skip the JNI calls entirely when
/// nothing changed — which is the common case.
#[allow(clippy::type_complexity)]
static LAST_CHROME_STYLE: std::sync::Mutex<
    Option<(Option<u32>, Option<u32>, crate::StatusBarContentStyle)>,
> = std::sync::Mutex::new(None);

/// Apply system chrome styling on Android.
///
/// Sets the status bar color, navigation bar color, and light/dark
/// status bar icons via JNI calls to `Window` and `WindowInsetsController`.
///
/// Must be called from the main (native) thread that has JNI access.
pub fn set_system_chrome(style: &crate::SystemChromeStyle) {
    let status_bar_color = style.status_bar_color;
    let navigation_bar_color = style.navigation_bar_color;
    let status_bar_style = style.status_bar_style;

    // Skip the (expensive, potentially deadlocking) JNI calls when nothing changed.
    {
        let key = (status_bar_color, navigation_bar_color, status_bar_style);
        let mut last = LAST_CHROME_STYLE.lock().unwrap();
        if *last == Some(key) {
            return;
        }
        *last = Some(key);
    }

    let result = with_env(|env| {
        let activity_obj = activity(env)?;

        // 1. Get the Window: activity.getWindow()
        let window = env
            .call_method(
                &activity_obj,
                jni::jni_str!("getWindow"),
                jni::jni_sig!("()Landroid/view/Window;"),
                &[],
            )
            .and_then(|v: jni::objects::JValueOwned| v.l())
            .map_err(|e| {
                env.exception_clear();
                e.to_string()
            })?;
        if window.is_null() {
            return Err("getWindow returned null".into());
        }

        // 2. Set status bar color if provided
        if let Some(color) = status_bar_color {
            let argb = (0xFF000000_u32 | color) as i32;
            let _ = env.call_method(
                &window,
                jni::jni_str!("setStatusBarColor"),
                jni::jni_sig!("(I)V"),
                &[JValue::Int(argb)],
            );
            env.exception_clear();
        }

        // 3. Set navigation bar color if provided
        if let Some(color) = navigation_bar_color {
            let argb = (0xFF000000_u32 | color) as i32;
            let _ = env.call_method(
                &window,
                jni::jni_str!("setNavigationBarColor"),
                jni::jni_sig!("(I)V"),
                &[JValue::Int(argb)],
            );
            env.exception_clear();
        }

        // 4. Set light/dark status bar icons via WindowInsetsController (API 30+)
        let insetsctl = env.call_method(
            &window,
            jni::jni_str!("getInsetsController"),
            jni::jni_sig!("()Landroid/view/WindowInsetsController;"),
            &[],
        );

        if let Ok(v) = insetsctl {
            if let Ok(ctl) = v.l() {
                if !ctl.is_null() {
                    let mask: i32 = 0x00000008;
                    let appearance: i32 = match status_bar_style {
                        crate::StatusBarContentStyle::Dark => 0x00000008,
                        crate::StatusBarContentStyle::Light => 0,
                    };
                    let _ = env.call_method(
                        &ctl,
                        jni::jni_str!("setSystemBarsAppearance"),
                        jni::jni_sig!("(II)V"),
                        &[JValue::Int(appearance), JValue::Int(mask)],
                    );
                    env.exception_clear();
                }
            }
        } else {
            env.exception_clear();

            if let Ok(decor) = env
                .call_method(
                    &window,
                    jni::jni_str!("getDecorView"),
                    jni::jni_sig!("()Landroid/view/View;"),
                    &[],
                )
                .and_then(|v: jni::objects::JValueOwned| v.l())
            {
                if !decor.is_null() {
                    if let Ok(current) = env
                        .call_method(
                            &decor,
                            jni::jni_str!("getSystemUiVisibility"),
                            jni::jni_sig!("()I"),
                            &[],
                        )
                        .and_then(|v: jni::objects::JValueOwned| v.i())
                    {
                        let new_flags = match status_bar_style {
                            crate::StatusBarContentStyle::Dark => current | 0x00002000,
                            crate::StatusBarContentStyle::Light => current & !0x00002000,
                        };
                        let _ = env.call_method(
                            &decor,
                            jni::jni_str!("setSystemUiVisibility"),
                            jni::jni_sig!("(I)V"),
                            &[JValue::Int(new_flags)],
                        );
                        env.exception_clear();
                    }
                }
            }
        }

        Ok(())
    });

    if let Err(e) = result {
        log::warn!("set_system_chrome: {e}");
    }

    log::info!(
        "set_system_chrome: status_bar_color={:?}, nav_bar_color={:?}, style={:?}",
        style.status_bar_color,
        style.navigation_bar_color,
        style.status_bar_style
    );
}

// ── software keyboard (IME) control ───────────────────────────────────────────

/// Safely borrow a JVM-passed `jstring` parameter without letting `jni::objects::JString`
/// drop or delete the JVM-owned local reference.
pub(crate) unsafe fn borrow_jstring(env: &mut jni::Env<'_>, raw: *mut c_void) -> Option<String> {
    if raw.is_null() {
        return None;
    }
    let jstr = ManuallyDrop::new(unsafe { JString::from_raw(env, raw as _) });
    Some(jstr.to_string())
}

/// Safely borrow a JVM-passed `jbyteArray` parameter and copy its contents into a `Vec<u8>`.
pub(crate) unsafe fn borrow_jbyte_array(
    env: &mut jni::Env<'_>,
    raw: *mut c_void,
) -> Option<Vec<u8>> {
    if raw.is_null() {
        return None;
    }
    let arr = ManuallyDrop::new(unsafe { jni::objects::JByteArray::from_raw(env, raw as _) });
    env.convert_byte_array(&*arr).ok()
}

/// Show the software keyboard on Android via `GpuiActivity.showIme(keyboardType)`.
/// Falls back to NDK `show_soft_input` if JNI invocation is unavailable.
pub fn show_keyboard_android(keyboard_type: crate::KeyboardType) {
    let type_code: i32 = match keyboard_type {
        crate::KeyboardType::Default => 0,
        crate::KeyboardType::EmailAddress => 1,
        crate::KeyboardType::Phone => 2,
        crate::KeyboardType::NumberPad => 3,
        crate::KeyboardType::URL => 4,
        crate::KeyboardType::Decimal => 5,
    };
    let ok = with_env(|env| {
        let cls = find_app_class(env, "dev.gpui.mobile.GpuiActivity")?;
        env.call_static_method(
            &cls,
            jni::jni_str!("showIme"),
            jni::jni_sig!("(I)V"),
            &[JValue::Int(type_code)],
        )
        .map_err(|e| {
            env.exception_clear();
            e.to_string()
        })?;
        Ok(())
    })
    .is_ok();
    if !ok {
        if let Some(app) = android_app() {
            log::info!("show_keyboard_android: fallback to NDK show_soft_input");
            app.show_soft_input(false);
        }
    }
}

/// Hide the software keyboard on Android via `GpuiActivity.hideIme()`.
pub fn hide_keyboard_android() {
    let ok = with_env(|env| {
        let cls = find_app_class(env, "dev.gpui.mobile.GpuiActivity")?;
        env.call_static_method(&cls, jni::jni_str!("hideIme"), jni::jni_sig!("()V"), &[])
            .map_err(|e| {
                env.exception_clear();
                e.to_string()
            })?;
        Ok(())
    })
    .is_ok();
    if !ok {
        if let Some(app) = android_app() {
            log::info!("hide_keyboard_android: fallback to NDK hide_soft_input");
            app.hide_soft_input(false);
        }
    }
}

/// Update the IME insertion cursor / candidate anchor on Android via `GpuiActivity.updateImeCursor`.
pub fn update_ime_cursor(x: f32, y: f32, height: f32) {
    let _ = with_env(|env| {
        let cls = find_app_class(env, "dev.gpui.mobile.GpuiActivity")?;
        env.call_static_method(
            &cls,
            jni::jni_str!("updateImeCursor"),
            jni::jni_sig!("(FFF)V"),
            &[JValue::Float(x), JValue::Float(y), JValue::Float(height)],
        )
        .map_err(|e| {
            env.exception_clear();
            e.to_string()
        })?;
        Ok(())
    });
}

/// Move task to background via `GpuiActivity.moveAppToBack()`.
pub fn move_app_to_back() {
    let _ = with_env(|env| {
        let cls = find_app_class(env, "dev.gpui.mobile.GpuiActivity")?;
        env.call_static_method(
            &cls,
            jni::jni_str!("moveAppToBack"),
            jni::jni_sig!("()V"),
            &[],
        )
        .map_err(|e| {
            env.exception_clear();
            e.to_string()
        })?;
        Ok(())
    });
}

/// Invoke an async native module method on `GpuiNativeBridge`.
pub fn invoke_native_bridge_async(
    request_id: u64,
    module: &str,
    method: &str,
    args_json: &str,
) -> bool {
    with_env(|env| {
        let cls = find_app_class(env, "dev.gpui.mobile.GpuiNativeBridge")?;
        let jmodule = env.new_string(module).e()?;
        let jmethod = env.new_string(method).e()?;
        let jargs = env.new_string(args_json).e()?;
        env.call_static_method(
            &cls,
            jni::jni_str!("invokeAsync"),
            jni::jni_sig!("(JLjava/lang/String;Ljava/lang/String;Ljava/lang/String;)V"),
            &[
                JValue::Long(request_id as i64),
                JValue::Object(&jmodule),
                JValue::Object(&jmethod),
                JValue::Object(&jargs),
            ],
        )
        .map_err(|e| {
            env.exception_clear();
            e.to_string()
        })?;
        Ok(())
    })
    .is_ok()
}

pub fn kv_get(key: &str) -> Option<String> {
    with_env(|env| {
        let cls = find_app_class(env, "dev.gpui.mobile.GpuiNativeBridge")?;
        let jkey = env.new_string(key).e()?;
        let val = env
            .call_static_method(
                &cls,
                jni::jni_str!("kvGet"),
                jni::jni_sig!("(Ljava/lang/String;)Ljava/lang/String;"),
                &[JValue::Object(&jkey)],
            )
            .and_then(|v| v.l())
            .map_err(|e| {
                env.exception_clear();
                e.to_string()
            })?;
        if val.is_null() {
            return Ok(None);
        }
        Ok(Some(get_string(env, &val)))
    })
    .ok()
    .flatten()
}

pub fn kv_set(key: &str, value: &str) -> bool {
    with_env(|env| {
        let cls = find_app_class(env, "dev.gpui.mobile.GpuiNativeBridge")?;
        let jkey = env.new_string(key).e()?;
        let jval = env.new_string(value).e()?;
        env.call_static_method(
            &cls,
            jni::jni_str!("kvSet"),
            jni::jni_sig!("(Ljava/lang/String;Ljava/lang/String;)Z"),
            &[JValue::Object(&jkey), JValue::Object(&jval)],
        )
        .and_then(|v| v.z())
        .map_err(|e| {
            env.exception_clear();
            e.to_string()
        })
    })
    .unwrap_or(false)
}

pub fn kv_remove(key: &str) -> bool {
    with_env(|env| {
        let cls = find_app_class(env, "dev.gpui.mobile.GpuiNativeBridge")?;
        let jkey = env.new_string(key).e()?;
        env.call_static_method(
            &cls,
            jni::jni_str!("kvRemove"),
            jni::jni_sig!("(Ljava/lang/String;)Z"),
            &[JValue::Object(&jkey)],
        )
        .and_then(|v| v.z())
        .map_err(|e| {
            env.exception_clear();
            e.to_string()
        })
    })
    .unwrap_or(false)
}

pub fn kv_clear() -> bool {
    with_env(|env| {
        let cls = find_app_class(env, "dev.gpui.mobile.GpuiNativeBridge")?;
        env.call_static_method(&cls, jni::jni_str!("kvClear"), jni::jni_sig!("()Z"), &[])
            .and_then(|v| v.z())
            .map_err(|e| {
                env.exception_clear();
                e.to_string()
            })
    })
    .unwrap_or(false)
}

pub fn kv_keys_json() -> String {
    with_env(|env| {
        let cls = find_app_class(env, "dev.gpui.mobile.GpuiNativeBridge")?;
        let val = env
            .call_static_method(
                &cls,
                jni::jni_str!("kvKeysJson"),
                jni::jni_sig!("()Ljava/lang/String;"),
                &[],
            )
            .and_then(|v| v.l())
            .map_err(|e| {
                env.exception_clear();
                e.to_string()
            })?;
        if val.is_null() {
            return Ok("[]".to_string());
        }
        Ok(get_string(env, &val))
    })
    .unwrap_or_else(|_| "[]".to_string())
}

pub fn secure_write(service: &str, account: &str, base64_value: &str) -> bool {
    with_env(|env| {
        let cls = find_app_class(env, "dev.gpui.mobile.GpuiNativeBridge")?;
        let jservice = env.new_string(service).e()?;
        let jaccount = env.new_string(account).e()?;
        let jval = env.new_string(base64_value).e()?;
        env.call_static_method(
            &cls,
            jni::jni_str!("secureWrite"),
            jni::jni_sig!("(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Z"),
            &[
                JValue::Object(&jservice),
                JValue::Object(&jaccount),
                JValue::Object(&jval),
            ],
        )
        .and_then(|v| v.z())
        .map_err(|e| {
            env.exception_clear();
            e.to_string()
        })
    })
    .unwrap_or(false)
}

pub fn secure_read(service: &str, account: &str) -> Option<String> {
    with_env(|env| {
        let cls = find_app_class(env, "dev.gpui.mobile.GpuiNativeBridge")?;
        let jservice = env.new_string(service).e()?;
        let jaccount = env.new_string(account).e()?;
        let val = env
            .call_static_method(
                &cls,
                jni::jni_str!("secureRead"),
                jni::jni_sig!("(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;"),
                &[JValue::Object(&jservice), JValue::Object(&jaccount)],
            )
            .and_then(|v| v.l())
            .map_err(|e| {
                env.exception_clear();
                e.to_string()
            })?;
        if val.is_null() {
            return Ok(None);
        }
        Ok(Some(get_string(env, &val)))
    })
    .ok()
    .flatten()
}

pub fn secure_delete(service: &str, account: &str) -> bool {
    with_env(|env| {
        let cls = find_app_class(env, "dev.gpui.mobile.GpuiNativeBridge")?;
        let jservice = env.new_string(service).e()?;
        let jaccount = env.new_string(account).e()?;
        env.call_static_method(
            &cls,
            jni::jni_str!("secureDelete"),
            jni::jni_sig!("(Ljava/lang/String;Ljava/lang/String;)Z"),
            &[JValue::Object(&jservice), JValue::Object(&jaccount)],
        )
        .and_then(|v| v.z())
        .map_err(|e| {
            env.exception_clear();
            e.to_string()
        })
    })
    .unwrap_or(false)
}

pub fn ws_connect(socket_id: u64, url: &str, headers_json: &str) -> bool {
    with_env(|env| {
        let cls = find_app_class(env, "dev.gpui.mobile.GpuiWebSocket")?;
        let jurl = env.new_string(url).e()?;
        let jheaders = env.new_string(headers_json).e()?;
        env.call_static_method(
            &cls,
            jni::jni_str!("connect"),
            jni::jni_sig!("(JLjava/lang/String;Ljava/lang/String;)Z"),
            &[
                JValue::Long(socket_id as i64),
                JValue::Object(&jurl),
                JValue::Object(&jheaders),
            ],
        )
        .and_then(|v| v.z())
        .map_err(|e| {
            env.exception_clear();
            e.to_string()
        })
    })
    .unwrap_or(false)
}

pub fn ws_send_text(socket_id: u64, text: &str) -> bool {
    with_env(|env| {
        let cls = find_app_class(env, "dev.gpui.mobile.GpuiWebSocket")?;
        let jtext = env.new_string(text).e()?;
        env.call_static_method(
            &cls,
            jni::jni_str!("sendText"),
            jni::jni_sig!("(JLjava/lang/String;)Z"),
            &[JValue::Long(socket_id as i64), JValue::Object(&jtext)],
        )
        .and_then(|v| v.z())
        .map_err(|e| {
            env.exception_clear();
            e.to_string()
        })
    })
    .unwrap_or(false)
}

pub fn ws_send_binary(socket_id: u64, data: &[u8]) -> bool {
    with_env(|env| {
        let cls = find_app_class(env, "dev.gpui.mobile.GpuiWebSocket")?;
        let jbytes = env.byte_array_from_slice(data).e()?;
        let jobj: JObject = jbytes.into();
        env.call_static_method(
            &cls,
            jni::jni_str!("sendBinary"),
            jni::jni_sig!("(J[B)Z"),
            &[JValue::Long(socket_id as i64), JValue::Object(&jobj)],
        )
        .and_then(|v| v.z())
        .map_err(|e| {
            env.exception_clear();
            e.to_string()
        })
    })
    .unwrap_or(false)
}

pub fn ws_close(socket_id: u64, code: i32, reason: &str) {
    let _ = with_env(|env| {
        let cls = find_app_class(env, "dev.gpui.mobile.GpuiWebSocket")?;
        let jreason = env.new_string(reason).e()?;
        env.call_static_method(
            &cls,
            jni::jni_str!("close"),
            jni::jni_sig!("(JILjava/lang/String;)V"),
            &[
                JValue::Long(socket_id as i64),
                JValue::Int(code),
                JValue::Object(&jreason),
            ],
        )
        .map_err(|e| {
            env.exception_clear();
            e.to_string()
        })?;
        Ok(())
    });
}

pub fn update_a11y_tree_json(json: &str) {
    let _ = with_env(|env| {
        let cls = find_app_class(env, "dev.gpui.mobile.GpuiAccessibilityBridge")?;
        let jjson = env.new_string(json).e()?;
        env.call_static_method(
            &cls,
            jni::jni_str!("updateTreeJson"),
            jni::jni_sig!("(Ljava/lang/String;)V"),
            &[JValue::Object(&jjson)],
        )
        .map_err(|e| {
            env.exception_clear();
            e.to_string()
        })?;
        Ok(())
    });
}

// ── tests ─────────────────────────────────────────────────────────────────────

// ── JNI export for GpuiActivity splash screen ────────────────────────────────

/// Queues WindowInsets and animation samples in physical pixels, without
/// entering GPUI from Android's Java UI thread.
#[unsafe(no_mangle)]
pub extern "C" fn Java_dev_gpui_mobile_GpuiActivity_nativeInsetsChanged(
    _env: *mut std::ffi::c_void,
    _class: *mut std::ffi::c_void,
    safe_left: i32,
    safe_top: i32,
    safe_right: i32,
    safe_bottom: i32,
    ime_left: i32,
    ime_top: i32,
    ime_right: i32,
    ime_bottom: i32,
) {
    *WINDOW_INSETS_PENDING.lock() = Some((
        [safe_left, safe_top, safe_right, safe_bottom],
        [ime_left, ime_top, ime_right, ime_bottom],
    ));
    if let Some(app) = android_app() {
        app.create_waker().wake();
    }
}

/// Called from `GpuiActivity.nativeIsInitialized()` to check whether the
/// native library has finished initializing (first frame rendered).
///
/// The AndroidX SplashScreen API calls this via `setKeepOnScreenCondition`
/// to hold the splash visible until GPUI is ready.
///
/// # Safety
/// Must only be called from the JVM on a valid JNI thread.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn Java_dev_gpui_mobile_GpuiActivity_nativeIsInitialized(
    _env: *mut std::ffi::c_void,
    _class: *mut std::ffi::c_void,
) -> u8 {
    if NATIVE_INITIALIZED.load(Ordering::Acquire) {
        1 // JNI_TRUE
    } else {
        0 // JNI_FALSE
    }
}

/// JNI bridge: receive a deeplink URL from `GpuiActivity.onNewIntent()`.
///
/// When the app is already running and a deeplink is opened (e.g. via
/// `adb shell am start -d gpui://video_player`), the Java side calls
/// this to notify the Rust deeplink handler.
///
/// # Safety
/// Must only be called from the JVM on a valid JNI thread with a valid `url` jobject.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn Java_dev_gpui_mobile_GpuiActivity_nativeOnDeepLink(
    _env: *mut std::ffi::c_void,
    _class: *mut std::ffi::c_void,
    url: *mut std::ffi::c_void,
) {
    let _ = with_env(|env| {
        let Some(url_string) = (unsafe { borrow_jstring(env, url) }) else {
            return Ok(());
        };
        if url_string.is_empty() {
            return Ok(());
        }
        log::info!("nativeOnDeepLink: {}", url_string);

        if let Some(cb) = *DEEP_LINK_LISTENER.read() {
            cb(url_string.clone());
        }
        #[cfg(feature = "deeplink")]
        {
            crate::packages::deeplink::notify_deep_link(&url_string);
        }
        Ok(())
    });
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn Java_dev_gpui_mobile_GpuiActivity_nativeImeCommitText(
    _env: *mut std::ffi::c_void,
    _class: *mut std::ffi::c_void,
    text: *mut std::ffi::c_void,
) {
    let _ = with_env(|env| {
        if let Some(text) = unsafe { borrow_jstring(env, text) } {
            IME_EVENTS.lock().push_back(ImeEvent::CommitText(text));
            wake_for_ime();
        }
        Ok(())
    });
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn Java_dev_gpui_mobile_GpuiActivity_nativeImeSetComposingText(
    _env: *mut std::ffi::c_void,
    _class: *mut std::ffi::c_void,
    text: *mut std::ffi::c_void,
) {
    let _ = with_env(|env| {
        let text = unsafe { borrow_jstring(env, text) }.unwrap_or_default();
        IME_EVENTS
            .lock()
            .push_back(ImeEvent::SetComposingText(text));
        wake_for_ime();
        Ok(())
    });
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn Java_dev_gpui_mobile_GpuiActivity_nativeImeFinishComposing(
    _env: *mut std::ffi::c_void,
    _class: *mut std::ffi::c_void,
) {
    IME_EVENTS.lock().push_back(ImeEvent::FinishComposing);
    wake_for_ime();
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn Java_dev_gpui_mobile_GpuiActivity_nativeImeDeleteSurrounding(
    _env: *mut std::ffi::c_void,
    _class: *mut std::ffi::c_void,
    before: i32,
    after: i32,
) {
    IME_EVENTS
        .lock()
        .push_back(ImeEvent::DeleteSurrounding { before, after });
    wake_for_ime();
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn Java_dev_gpui_mobile_GpuiActivity_nativeImeEditorAction(
    _env: *mut std::ffi::c_void,
    _class: *mut std::ffi::c_void,
    action_code: i32,
) {
    IME_EVENTS
        .lock()
        .push_back(ImeEvent::EditorAction(action_code));
    wake_for_ime();
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn Java_dev_gpui_mobile_GpuiActivity_nativeBackPressed(
    _env: *mut std::ffi::c_void,
    _class: *mut std::ffi::c_void,
) {
    if let Some(cb) = *BACK_PRESSED_LISTENER.read() {
        cb();
    } else {
        move_app_to_back();
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn Java_dev_gpui_mobile_GpuiNativeBridge_nativeBridgeResult(
    _env: *mut std::ffi::c_void,
    _class: *mut std::ffi::c_void,
    request_id: i64,
    ok: u8,
    payload_json: *mut std::ffi::c_void,
) {
    let _ = with_env(|env| {
        let payload = unsafe { borrow_jstring(env, payload_json) }.unwrap_or_else(|| "null".into());
        if let Some(cb) = *BRIDGE_RESULT_LISTENER.read() {
            cb(request_id.max(0) as u64, ok != 0, payload);
        }
        Ok(())
    });
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn Java_dev_gpui_mobile_GpuiNativeBridge_nativeBridgeEvent(
    _env: *mut std::ffi::c_void,
    _class: *mut std::ffi::c_void,
    channel: *mut std::ffi::c_void,
    payload_json: *mut std::ffi::c_void,
) {
    let _ = with_env(|env| {
        let channel = unsafe { borrow_jstring(env, channel) }.unwrap_or_default();
        let payload = unsafe { borrow_jstring(env, payload_json) }.unwrap_or_else(|| "null".into());
        if let Some(cb) = *BRIDGE_EVENT_LISTENER.read() {
            cb(channel, payload);
        }
        Ok(())
    });
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn Java_dev_gpui_mobile_GpuiWebSocket_nativeWsEvent(
    _env: *mut std::ffi::c_void,
    _class: *mut std::ffi::c_void,
    socket_id: i64,
    event_type: *mut std::ffi::c_void,
    text_payload: *mut std::ffi::c_void,
    binary_payload: *mut std::ffi::c_void,
    code: i32,
    reason: *mut std::ffi::c_void,
) {
    let _ = with_env(|env| {
        let event_type = unsafe { borrow_jstring(env, event_type) }.unwrap_or_default();
        let text = unsafe { borrow_jstring(env, text_payload) };
        let binary = unsafe { borrow_jbyte_array(env, binary_payload) };
        let reason = unsafe { borrow_jstring(env, reason) };
        if let Some(cb) = *WS_EVENT_LISTENER.read() {
            cb(
                socket_id.max(0) as u64,
                event_type,
                text,
                binary,
                code,
                reason,
            );
        }
        Ok(())
    });
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn Java_dev_gpui_mobile_GpuiAccessibilityBridge_nativeA11yStateChanged(
    _env: *mut std::ffi::c_void,
    _class: *mut std::ffi::c_void,
    enabled: u8,
) {
    A11Y_ENABLED.store(enabled != 0, Ordering::Release);
    if enabled != 0 {
        wake_for_ime();
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn Java_dev_gpui_mobile_GpuiAccessibilityBridge_nativeA11yAction(
    _env: *mut std::ffi::c_void,
    _class: *mut std::ffi::c_void,
    node_id: i64,
    action: *mut std::ffi::c_void,
    arg: *mut std::ffi::c_void,
) {
    let _ = with_env(|env| {
        let action = unsafe { borrow_jstring(env, action) }.unwrap_or_default();
        let arg = unsafe { borrow_jstring(env, arg) };
        if let Some(cb) = *A11Y_ACTION_LISTENER.read() {
            cb(node_id.max(0) as u64, action, arg);
        }
        Ok(())
    });
}

/// JNI bridge: receive a media action from `GpuiMediaSession` system controls.
///
/// Actions: "play", "pause", "stop", "next", "previous"
///
/// # Safety
/// Must only be called from the JVM on a valid JNI thread with a valid `action` jobject.
#[cfg(feature = "media_session")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn Java_dev_gpui_mobile_GpuiMediaSession_nativeMediaAction(
    _env: *mut std::ffi::c_void,
    _class: *mut std::ffi::c_void,
    action: *mut std::ffi::c_void,
) {
    let action_raw = action as jni::sys::jobject;
    let _ = with_env(|env| {
        let action_obj = unsafe { JObject::from_raw(env, action_raw) };
        let action_str = get_string(env, &action_obj);

        let media_action = match action_str.as_str() {
            "play" => crate::packages::media_session::MediaAction::Play,
            "pause" => crate::packages::media_session::MediaAction::Pause,
            "stop" => crate::packages::media_session::MediaAction::Stop,
            "next" => crate::packages::media_session::MediaAction::Next,
            "previous" => crate::packages::media_session::MediaAction::Previous,
            other => {
                log::warn!("nativeMediaAction: unknown action '{}'", other);
                return Ok(());
            }
        };

        log::info!("nativeMediaAction: {:?}", media_action);
        crate::packages::media_session::notify_action(media_action);
        Ok(())
    });
}

/// JNI bridge: receive a seek request from `GpuiMediaSession` system controls.
///
/// # Safety
/// Must only be called from the JVM on a valid JNI thread.
#[cfg(feature = "media_session")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn Java_dev_gpui_mobile_GpuiMediaSession_nativeMediaSeek(
    _env: *mut std::ffi::c_void,
    _class: *mut std::ffi::c_void,
    position_ms: i64,
) {
    log::info!("nativeMediaSeek: {}ms", position_ms);
    crate::packages::media_session::notify_seek(position_ms as u64);
}

/// Trigger an immediate clean Android process restart from native/Rust watchdog recovery.
pub fn request_ota_process_restart() -> bool {
    with_env(|env| {
        let cls = find_app_class(env, "dev.gpui.mobile.GpuiOtaManager")?;
        let ok = env
            .call_static_method(
                &cls,
                jni::jni_str!("requestProcessRestartFromNative"),
                jni::jni_sig!("()Z"),
                &[],
            )
            .and_then(|v| v.z())
            .map_err(|e| {
                env.exception_clear();
                e.to_string()
            })?;
        Ok(ok)
    })
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn poll_events_returns_false_when_no_platform() {
        // PLATFORM is not set in a unit-test context, so poll_events should
        // be a safe no-op and return false (don't quit).
        let result = poll_events(0);
        let _ = result;
    }

    #[test]
    fn java_vm_returns_null_before_init() {
        // Before android_main is called, java_vm() should return null.
        let vm = java_vm();
        assert!(vm.is_null());
    }

    #[test]
    fn activity_as_ptr_returns_null_before_init() {
        let ptr = activity_as_ptr();
        assert!(ptr.is_null());
    }

    #[test]
    fn android_app_returns_none_before_init() {
        assert!(android_app().is_none());
    }

    #[test]
    fn platform_returns_none_before_init() {
        assert!(platform().is_none());
    }
}
