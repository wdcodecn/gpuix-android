//! iOS UIKit host integration using gpui-mobile's IosPlatform + CADisplayLink
//! frame loop and the shared RetainedTree / UiCommand channel.

use super::*;
use std::cell::RefCell;
use std::sync::{
    mpsc::{channel, Sender, TryRecvError},
    OnceLock,
};

struct IosInit {
    options: WindowOptions,
    tree: Arc<Mutex<RetainedTree>>,
    selection: SharedSelection,
    callback: Option<EventCallback>,
    window_metrics: SharedWindowMetrics,
    commands: mpsc::UnboundedReceiver<UiCommand>,
    running: Arc<AtomicBool>,
    response: SyncSender<std::result::Result<(), String>>,
}

static IOS_INIT: OnceLock<Mutex<Option<Sender<IosInit>>>> = OnceLock::new();
static IOS_STOP_JS: OnceLock<Mutex<Option<Arc<dyn Fn() + Send + Sync>>>> = OnceLock::new();
static IOS_ACTIVE_RENDERER: OnceLock<Mutex<Option<Arc<AtomicBool>>>> = OnceLock::new();
thread_local! {
    static IOS_APP_HANDLE: RefCell<Option<gpui::ApplicationHandle>> = const { RefCell::new(None) };
}

fn attach_ios_renderer(
    cx: &mut gpui::App,
    request: IosInit,
    active_renderer: &Arc<Mutex<Option<Arc<AtomicBool>>>>,
) {
    let IosInit {
        options,
        tree,
        selection,
        callback,
        window_metrics,
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
            gpui::px(options.width.unwrap_or(390.0) as f32),
            gpui::px(options.height.unwrap_or(844.0) as f32),
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
                .send(Err(format!("Failed to attach GPUIX iOS window: {error}")))
                .ok();
            return;
        }
    };
    let _ = window.update(cx, |view, window, cx| {
        view.sync_window_metrics(window);
        cx.observe_window_bounds(window, |view, window, _cx| {
            view.sync_window_metrics(window);
        })
        .detach();
        cx.notify();
        window.refresh();
    });
    cx.spawn(async move |cx| run_ui_commands(commands, window, cx).await)
        .detach();
    running.store(true, Ordering::Release);
    *active_renderer.lock().unwrap() = Some(Arc::clone(&running));
    *IOS_ACTIVE_RENDERER.get_or_init(|| Mutex::new(None)).lock().unwrap() = Some(running);
    response.send(Ok(())).ok();
    log::info!("GPUIX React renderer attached to iOS window");
}

fn wait_for_ios_renderer(
    cx: &mut gpui::App,
    requests: std::sync::mpsc::Receiver<IosInit>,
    active_renderer: Arc<Mutex<Option<Arc<AtomicBool>>>>,
) {
    cx.spawn(async move |cx| loop {
        match requests.try_recv() {
            Ok(request) => {
                cx.update(move |cx| attach_ios_renderer(cx, request, &active_renderer));
                return;
            }
            Err(TryRecvError::Disconnected) => {
                log::error!("Hermes stopped before calling GpuixRenderer.init");
                return;
            }
            Err(TryRecvError::Empty) => {
                cx.background_executor()
                    .timer(Duration::from_millis(8))
                    .await;
            }
        }
    })
    .detach();
}

/// Start the GPUI iOS host on the UIKit main thread without blocking UIApplication.
pub fn start_ios_host(
    start_js: impl FnOnce() + Send + 'static,
    stop_js: impl Fn() + Send + Sync + 'static,
) -> anyhow::Result<()> {
    let app_ptr = gpui_mobile::ios::ffi::gpui_ios_initialize();
    anyhow::ensure!(!app_ptr.is_null(), "gpui_ios_initialize returned null");

    let stop_js: Arc<dyn Fn() + Send + Sync> = Arc::new(stop_js);
    *IOS_STOP_JS.get_or_init(|| Mutex::new(None)).lock().unwrap() = Some(stop_js);

    let (sender, requests) = channel::<IosInit>();
    {
        let slot = IOS_INIT.get_or_init(|| Mutex::new(None));
        let mut guard = slot.lock().unwrap();
        anyhow::ensure!(guard.is_none(), "iOS GPUIX host is already running");
        *guard = Some(sender);
    }

    if let Err(error) = std::thread::Builder::new()
        .name("gpuix-js".into())
        .spawn(start_js)
    {
        if let Some(slot) = IOS_INIT.get() {
            slot.lock().unwrap().take();
        }
        return Err(error.into());
    }

    let early_request = requests.recv_timeout(Duration::from_secs(2)).ok();
    let active_renderer = Arc::new(Mutex::new(None::<Arc<AtomicBool>>));
    let active_renderer_for_launch = active_renderer.clone();
    let platform = gpui_mobile::ios::current_platform(false);

    let app_handle = gpui::Application::with_platform(platform).run_embedded(move |cx| {
        if let Some(request) = early_request {
            attach_ios_renderer(cx, request, &active_renderer_for_launch);
        } else {
            match requests.try_recv() {
                Ok(request) => attach_ios_renderer(cx, request, &active_renderer_for_launch),
                Err(TryRecvError::Empty) => {
                    wait_for_ios_renderer(cx, requests, active_renderer_for_launch)
                }
                Err(TryRecvError::Disconnected) => {
                    log::error!("Hermes stopped before calling GpuixRenderer.init");
                }
            }
        }
    });
    IOS_APP_HANDLE.with(|slot| {
        *slot.borrow_mut() = Some(app_handle);
    });

    gpui_mobile::ios::ffi::gpui_ios_did_finish_launching(app_ptr);
    Ok(())
}

/// Stop the iOS JS runtime and clear host channels during app termination.
pub fn stop_ios_host() {
    if let Some(slot) = IOS_INIT.get() {
        slot.lock().unwrap().take();
    }
    if let Some(slot) = IOS_ACTIVE_RENDERER.get() {
        if let Some(running) = slot.lock().unwrap().take() {
            running.store(false, Ordering::Release);
        }
    }
    if let Some(slot) = IOS_STOP_JS.get() {
        if let Some(stop_js) = slot.lock().unwrap().take() {
            stop_js();
        }
    }
    IOS_APP_HANDLE.with(|slot| {
        slot.borrow_mut().take();
    });
}

impl GpuixRenderer {
    pub(super) fn init_ios(&self, options: Option<WindowOptions>) -> Result<()> {
        if *self.initialized.lock().unwrap() {
            return Err(Error::from_reason("Renderer is already initialized"));
        }
        let sender = IOS_INIT
            .get()
            .and_then(|slot| slot.lock().unwrap().clone())
            .ok_or_else(|| {
                Error::from_reason("Call start_ios_host before starting the JavaScript runtime")
            })?;
        let (command_sender, commands) = mpsc::unbounded();
        let (response, receiver) = sync_channel(1);
        sender
            .send(IosInit {
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
                Error::from_reason("iOS GPUIX host is no longer accepting a renderer")
            })?;
        receiver
            .recv_timeout(Duration::from_secs(60))
            .map_err(|error| {
                Error::from_reason(format!("Waiting for the iOS GPUIX window: {error}"))
            })?
            .map_err(Error::from_reason)?;
        *self.ui_commands.lock().unwrap() = Some(command_sender);
        *self.initialized.lock().unwrap() = true;
        self.event_callback.lock().unwrap().take();
        Ok(())
    }
}
