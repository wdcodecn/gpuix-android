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
static ANDROID_INIT: OnceLock<Mutex<Option<Sender<AndroidInit>>>> = OnceLock::new();

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
        commands,
        running,
        response,
    } = request;
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
        cx.new(|_| GpuixView::new(tree, callback, title, selection))
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
    gpui_mobile::android::init_logger();
    gpui_mobile::android::jni::install_panic_hook();
    gpui_mobile::android::jni::init_platform(&app);
    let platform = gpui_mobile::android::jni::shared_platform()
        .ok_or_else(|| anyhow::anyhow!("Android platform initialization failed"))?;
    let (sender, requests) = channel::<AndroidInit>();
    let slot = ANDROID_INIT.get_or_init(|| Mutex::new(None));
    {
        let mut slot = slot.lock().unwrap();
        anyhow::ensure!(slot.is_none(), "Android GPUIX host is already running");
        *slot = Some(sender);
    }
    if let Err(error) = std::thread::Builder::new()
        .name("gpuix-js".into())
        .spawn(start_js)
    {
        slot.lock().unwrap().take();
        return Err(error.into());
    }
    // Hermes normally reaches `GpuixRenderer.init()` before the first Android
    // surface is delivered.  If the GPUI callback starts first, however, the
    // old `cx.spawn` fallback depends on the Android foreground dispatcher to
    // wake a future that is not yet attached to a window.  That left Hermes
    // blocked for the full 60-second N-API timeout and produced a black screen.
    // Give the JS worker a short, bounded head-start so the common path enters
    // `Application::run` with the request already queued.  This wait is on the
    // NativeActivity thread (not Android's Java UI thread), and the fallback
    // remains non-blocking after the deadline for unusually slow JS startup.
    let mut early_request = None;
    let early_deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < early_deadline {
        match requests.try_recv() {
            Ok(request) => {
                early_request = Some(request);
                break;
            }
            Err(TryRecvError::Disconnected) => break,
            Err(TryRecvError::Empty) => std::thread::sleep(Duration::from_millis(4)),
        }
    }

    let active_renderer = Arc::new(Mutex::new(None::<Arc<AtomicBool>>));
    let active_renderer_for_launch = active_renderer.clone();
    gpui::Application::with_platform(platform.into_rc()).run(move |cx| {
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
    if let Some(running) = active_renderer.lock().unwrap().take() {
        running.store(false, Ordering::Release);
    }
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
