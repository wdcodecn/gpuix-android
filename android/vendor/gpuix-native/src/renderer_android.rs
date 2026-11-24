//! NativeActivity owns the GPUI loop; the existing N-API renderer runs on a
//! separate JavaScript thread and uses the same retained tree/UiCommand channel
//! as the desktop threaded hosts.
use super::*;
use std::sync::{
    mpsc::{channel, Sender, TryRecvError},
    OnceLock,
};

struct AndroidInit {
    options: WindowOptions,
    tree: Arc<Mutex<RetainedTree>>,
    selection: SharedSelection,
    callback: Option<EventCallback>,
    window_metrics: SharedWindowMetrics,
    commands: mpsc::UnboundedReceiver<UiCommand>,
    running: Arc<AtomicBool>,
    response: SyncSender<std::result::Result<(), String>>,
}

/// The Android host owns exactly one renderer. The JavaScript runtime sends its
/// initial renderer request across this ordinary thread channel while the GPUI
/// application is ready to attach it on its main-thread `App` context.
///
/// The initial receive is non-blocking because blocking Android's NativeActivity
/// callback prevents the system from delivering its Focus event and causes an
/// input-dispatch ANR.
struct ActiveAndroidSession {
    platform: Arc<gpui_mobile::android::AndroidPlatform>,
    app: android_activity::AndroidApp,
    stop_js: Arc<dyn Fn() + Send + Sync>,
}

static ANDROID_INIT: OnceLock<Mutex<Option<Sender<AndroidInit>>>> = OnceLock::new();
static ANDROID_EVENT_CALLBACK: OnceLock<Mutex<Option<EventCallback>>> = OnceLock::new();
static ANDROID_SESSION_LOCK: Mutex<()> = Mutex::new(());
static ACTIVE_ANDROID_SESSION: Mutex<Option<ActiveAndroidSession>> = Mutex::new(None);

fn clear_active_session_if(platform: &Arc<gpui_mobile::android::AndroidPlatform>) {
    let mut active = ACTIVE_ANDROID_SESSION
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if active
        .as_ref()
        .is_some_and(|session| Arc::ptr_eq(&session.platform, platform))
    {
        *active = None;
    }
}

fn shared_android_callback() -> Option<EventCallback> {
    ANDROID_EVENT_CALLBACK
        .get()
        .and_then(|slot| slot.lock().unwrap().clone())
}

fn on_android_back_pressed() {
    if let Some(cb) = shared_android_callback() {
        emit_event_full(&Some(cb), 0, "backPressed", |_| {});
    }
}

fn on_android_deep_link(url: String) {
    if let Some(cb) = shared_android_callback() {
        emit_event_full(&Some(cb), 0, "deepLink", |payload| {
            payload.value = Some(url);
        });
    }
}

fn on_android_bridge_result(request_id: u64, ok: bool, payload_json: String) {
    if let Some(cb) = shared_android_callback() {
        let encoded = serde_json::json!({
            "requestId": request_id,
            "ok": ok,
            "payloadJson": payload_json,
        })
        .to_string();
        emit_event_full(&Some(cb), 0, "nativeBridgeResult", |payload| {
            payload.value = Some(encoded);
        });
    }
}

fn on_android_bridge_event(channel: String, payload_json: String) {
    if let Some(cb) = shared_android_callback() {
        let encoded = serde_json::json!({
            "channel": channel,
            "payloadJson": payload_json,
        })
        .to_string();
        emit_event_full(&Some(cb), 0, "nativeBridgeEvent", |payload| {
            payload.value = Some(encoded);
        });
    }
}

fn on_android_ws_event(
    socket_id: u64,
    event_type: String,
    text: Option<String>,
    binary: Option<Vec<u8>>,
    code: i32,
    reason: Option<String>,
) {
    use base64::Engine as _;
    if let Some(cb) = shared_android_callback() {
        let binary_base64 = binary
            .as_deref()
            .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes));
        let encoded = serde_json::json!({
            "socketId": socket_id,
            "type": event_type,
            "text": text,
            "binaryBase64": binary_base64,
            "code": code,
            "reason": reason,
        })
        .to_string();
        emit_event_full(&Some(cb), 0, "wsEvent", |payload| {
            payload.value = Some(encoded);
        });
    }
}

fn on_android_a11y_action(node_id: u64, action: String, arg: Option<String>) {
    if let Some(cb) = shared_android_callback() {
        if action == "click" {
            emit_event_full(&Some(cb), node_id, "click", |payload| {
                payload.button = Some(0);
                payload.click_count = Some(1);
                payload.is_right_click = Some(false);
            });
        } else {
            let encoded = serde_json::json!({
                "nodeId": node_id,
                "action": action,
                "arg": arg,
            })
            .to_string();
            emit_event_full(&Some(cb), 0, "a11yAction", |payload| {
                payload.value = Some(encoded);
            });
        }
    }
}

fn attach_android_renderer(
    cx: &mut gpui::App,
    request: AndroidInit,
    active_renderer: &Arc<Mutex<Option<Arc<AtomicBool>>>>,
) {
    let AndroidInit {
        options,
        tree,
        selection,
        callback,
        window_metrics,
        commands,
        running,
        response,
    } = request;
    let slot = ANDROID_EVENT_CALLBACK.get_or_init(|| Mutex::new(None));
    *slot.lock().unwrap() = callback.clone();
    android_jni::set_back_pressed_listener(on_android_back_pressed);
    android_jni::set_deep_link_listener(on_android_deep_link);
    android_jni::set_bridge_result_listener(on_android_bridge_result);
    android_jni::set_bridge_event_listener(on_android_bridge_event);
    android_jni::set_ws_event_listener(on_android_ws_event);
    android_jni::set_a11y_action_listener(on_android_a11y_action);
    crate::custom_elements::input::init(cx);
    crate::custom_elements::img::init(cx);
    let title = options.title.clone().unwrap_or_else(|| "GPUIX".into());
    let bounds = gpui::Bounds::centered(
        None,
        gpui::size(
            gpui::px(options.width.unwrap_or(400.0) as f32),
            gpui::px(options.height.unwrap_or(800.0) as f32),
        ),
        cx,
    );
    let window = match cx.open_window(to_gpui_window_options(&options, bounds), |_window, cx| {
        cx.new(|_| {
            GpuixView::new(tree, callback, title, selection).with_window_metrics(window_metrics)
        })
    }) {
        Ok(window) => window,
        Err(error) => {
            response
                .send(Err(format!(
                    "Failed to attach GPUIX Android window: {error}"
                )))
                .ok();
            cx.quit();
            return;
        }
    };
    let _ = window.update(cx, |view, window, cx| {
        view.sync_window_metrics(window);
        cx.observe_window_bounds(window, |view, window, _cx| {
            view.sync_window_metrics(window);
        })
        .detach();
    });
    cx.spawn(async move |cx| run_ui_commands(commands, window, cx).await)
        .detach();
    running.store(true, Ordering::Release);
    *active_renderer.lock().unwrap() = Some(running);
    response.send(Ok(())).ok();
    log::info!("GPUIX React renderer attached to Android window");
}

fn wait_for_android_renderer(
    cx: &mut gpui::App,
    requests: std::sync::mpsc::Receiver<AndroidInit>,
    active_renderer: Arc<Mutex<Option<Arc<AtomicBool>>>>,
) {
    cx.spawn(async move |cx| loop {
        match requests.try_recv() {
            Ok(request) => {
                cx.update(move |cx| attach_android_renderer(cx, request, &active_renderer));
                return;
            }
            Err(TryRecvError::Disconnected) => {
                cx.update(|cx| {
                    log::error!("Hermes stopped before calling GpuixRenderer.init");
                    cx.quit();
                });
                return;
            }
            Err(TryRecvError::Empty) => {
                // The JavaScript worker is normally already queued before the
                // surface arrives. If it is still loading, yield to Android's
                // lifecycle loop instead of waiting on this native thread.
                cx.background_executor()
                    .timer(Duration::from_millis(8))
                    .await;
            }
        }
    })
    .detach();
}

/// Run on the thread supplied by `android_activity::android_main`.
///
/// `start_js` initializes the standalone JS runtime and evaluates the bundled
/// application on a dedicated worker before the NativeActivity's first surface
/// callback. Its GpuixRenderer.init call attaches to this NativeActivity rather
/// than creating another platform/event loop. After this function returns the
/// host should request its JS runtime to stop.
pub fn run_android(
    app: android_activity::AndroidApp,
    start_js: impl FnOnce() + Send + 'static,
) -> anyhow::Result<()> {
    run_android_with_stop(app, start_js, || {})
}

/// Run an Android Activity host session with explicit JS shutdown coordination.
///
/// Serializes Activity lifecycles across `onDestroy` → `onCreate` recreations
/// inside the same process so the previous `gpuix-js` runtime and GPUI platform
/// finish tearing down before the new `android_main` thread initializes.
pub fn run_android_with_stop(
    app: android_activity::AndroidApp,
    start_js: impl FnOnce() + Send + 'static,
    stop_js: impl Fn() + Send + Sync + 'static,
) -> anyhow::Result<()> {
    let stop_js: Arc<dyn Fn() + Send + Sync> = Arc::new(stop_js);
    if let Some(prev) = ACTIVE_ANDROID_SESSION
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
    {
        log::info!("run_android_with_stop: superseding previous active Android session");
        if let Some(slot) = ANDROID_INIT.get() {
            slot.lock().unwrap().take();
        }
        (prev.stop_js)();
        prev.platform.quit();
        prev.app.create_waker().wake();
    }
    let _session_guard = ANDROID_SESSION_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    gpui_mobile::android::init_logger();
    gpui_mobile::android::jni::install_panic_hook();
    let platform = gpui_mobile::android::jni::init_platform(&app);
    *ACTIVE_ANDROID_SESSION
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(ActiveAndroidSession {
        platform: Arc::clone(&platform),
        app: app.clone(),
        stop_js: Arc::clone(&stop_js),
    });
    let shared_platform = gpui_mobile::android::SharedPlatform::new(Arc::clone(&platform));
    let (sender, requests) = channel::<AndroidInit>();
    let slot = ANDROID_INIT.get_or_init(|| Mutex::new(None));
    {
        let mut slot = slot.lock().unwrap();
        anyhow::ensure!(slot.is_none(), "Android GPUIX host is already running");
        *slot = Some(sender);
    }
    let js_handle = match std::thread::Builder::new()
        .name("gpuix-js".into())
        .spawn(start_js)
    {
        Ok(handle) => handle,
        Err(error) => {
            slot.lock().unwrap().take();
            clear_active_session_if(&platform);
            gpui_mobile::android::jni::shutdown_platform(&platform);
            return Err(error.into());
        }
    };
    // Hermes normally reaches `GpuixRenderer.init()` before the first Android
    // surface is delivered.  If the GPUI callback starts first, however, the
    // old `cx.spawn` fallback depends on the Android foreground dispatcher to
    // wake a future that is not yet attached to a window.  That left Hermes
    // blocked for the full 60-second N-API timeout and produced a black screen.
    // Give the JS worker a bounded head-start without busy-polling so the
    // common path enters `Application::run` with the request already queued.
    let early_request = requests.recv_timeout(Duration::from_secs(5)).ok();

    let active_renderer = Arc::new(Mutex::new(None::<Arc<AtomicBool>>));
    let active_renderer_for_launch = active_renderer.clone();
    gpui::Application::with_platform(shared_platform.into_rc()).run(move |cx| {
        // Hermes began before Android delivered this surface, so the normal
        // path consumes an already queued request without blocking the
        // NativeActivity loop. The rare slow-start path polls asynchronously.
        if let Some(request) = early_request {
            attach_android_renderer(cx, request, &active_renderer_for_launch);
        } else {
            match requests.try_recv() {
                Ok(request) => attach_android_renderer(cx, request, &active_renderer_for_launch),
                Err(TryRecvError::Empty) => {
                    wait_for_android_renderer(cx, requests, active_renderer_for_launch)
                }
                Err(TryRecvError::Disconnected) => {
                    log::error!("Hermes stopped before calling GpuixRenderer.init");
                    cx.quit();
                }
            }
        }
    });
    slot.lock().unwrap().take();
    if let Some(cb_slot) = ANDROID_EVENT_CALLBACK.get() {
        cb_slot.lock().unwrap().take();
    }
    if let Some(running) = active_renderer.lock().unwrap().take() {
        running.store(false, Ordering::Release);
    }
    stop_js();
    let _ = js_handle.join();
    gpui_mobile::android::jni::shutdown_platform(&platform);
    clear_active_session_if(&platform);
    Ok(())
}

impl GpuixRenderer {
    pub(super) fn init_android(&self, options: Option<WindowOptions>) -> Result<()> {
        if *self.initialized.lock().unwrap() {
            return Err(Error::from_reason("Renderer is already initialized"));
        }
        let sender = ANDROID_INIT
            .get()
            .and_then(|slot| slot.lock().unwrap().clone())
            .ok_or_else(|| {
                Error::from_reason("Call run_android before starting the JavaScript runtime")
            })?;
        let (command_sender, commands) = mpsc::unbounded();
        let (response, receiver) = sync_channel(1);
        sender
            .send(AndroidInit {
                options: options.unwrap_or_default(),
                tree: self.tree.clone(),
                selection: self.selection.clone(),
                callback: self.event_callback_for_view(),
                window_metrics: self.window_metrics.clone(),
                commands,
                running: self.ui_running.clone(),
                response,
            })
            .map_err(|_| {
                Error::from_reason("Android GPUIX host is no longer accepting a renderer")
            })?;
        receiver
            .recv_timeout(Duration::from_secs(60))
            .map_err(|error| {
                Error::from_reason(format!("Waiting for the Android GPUIX window: {error}"))
            })?
            .map_err(Error::from_reason)?;
        *self.ui_commands.lock().unwrap() = Some(command_sender);
        *self.initialized.lock().unwrap() = true;
        self.event_callback.lock().unwrap().take();
        Ok(())
    }
}
