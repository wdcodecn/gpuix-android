#![cfg(any(target_os = "macos", target_os = "linux", target_os = "freebsd"))]
//! Runs GPUI applications inside a terminal.
//!
//! The window is the terminal grid. Each frame is rendered offscreen on the
//! GPU, read back, and shown with the kitty graphics protocol. Terminal input
//! (SGR pixel mouse, kitty keyboard protocol, bracketed paste, focus and
//! resize reports) is translated into GPUI platform input.
//!
//! ```text
//! GPUI Scene ──► Metal / wgpu offscreen texture ──► RGBA readback into POSIX shm
//!                                                     │
//!                                                     ▼
//!                     terminal ◄── ESC_G a=T,t=s,i=1,p=1 (one ~100 byte write)
//!                        │         or, over SSH, the frame inline (t=d,o=z)
//!                        │
//!                        └── /dev/tty bytes ──► input thread ──► main loop ──► PlatformInput
//! ```

mod dispatcher;
mod kitty;
mod tty;
mod window;

use std::{
    cell::{Cell, RefCell},
    path::{Path, PathBuf},
    rc::{Rc, Weak},
    sync::{Arc, mpsc},
    time::{Duration, Instant},
};

use anyhow::{Context as _, Result};
use base64::Engine as _;
use futures::channel::oneshot;
use gpui::{
    Action, AnyWindowHandle, BackgroundExecutor, Bounds, ClipboardItem, CursorStyle, DisplayId,
    DummyKeyboardMapper, ForegroundExecutor, Keymap, Menu, MenuItem, PathPromptOptions, Pixels,
    Platform, PlatformDisplay, PlatformKeyboardLayout, PlatformKeyboardMapper, PlatformTextSystem,
    PlatformWindow, Point, Task, ThermalState, WindowAppearance, WindowKind, WindowParams, px,
    size,
};

use crate::{
    dispatcher::{MainMessage, MainSender, TerminalDispatcher, Wake},
    tty::{TerminalEvent, Tty},
    window::{TerminalWindow, WindowInner},
};

/// How long one `pump_events` call may run queued work before it yields to
/// the host. A task that keeps waking itself must not starve the host loop.
const PUMP_BUDGET: Duration = Duration::from_millis(8);

/// A GPUI application whose single window is the current terminal.
pub fn application() -> Result<gpui::Application> {
    Ok(gpui::Application::with_platform(Rc::new(
        TerminalPlatform::new()?,
    )))
}

pub struct TerminalPlatform {
    /// The host owns the run loop: `run` returns after launching and the host
    /// calls `pump_events` whenever the wake hook fires.
    embedded: bool,
    dispatcher: Arc<TerminalDispatcher>,
    wake: Wake,
    scheduled_wake: Cell<Option<Instant>>,
    shut_down: Cell<bool>,
    background_executor: BackgroundExecutor,
    foreground_executor: ForegroundExecutor,
    text_system: Arc<dyn PlatformTextSystem>,
    main_receiver: mpsc::Receiver<MainMessage>,
    tty: Rc<RefCell<Tty>>,
    display: Rc<dyn PlatformDisplay>,
    quit_requested: Rc<Cell<bool>>,
    window: RefCell<Option<(AnyWindowHandle, Weak<WindowInner>)>>,
    clipboard: RefCell<Option<ClipboardItem>>,
    #[cfg(any(target_os = "linux", target_os = "freebsd"))]
    primary: RefCell<Option<ClipboardItem>>,
    cursor_style: Cell<Option<CursorStyle>>,
    quit_callback: RefCell<Option<Box<dyn FnMut() -> bool>>>,
}

impl TerminalPlatform {
    /// Takes over the controlling terminal: raw mode, alternate screen, mouse
    /// and keyboard reporting. The terminal is restored on quit, panic or
    /// `exit(3)`. `Platform::run` blocks until the application quits.
    pub fn new() -> Result<Self> {
        Self::create(false)
    }

    /// Like `new`, for a host that owns the thread's run loop (e.g. Node).
    /// `Platform::run` returns right after launching. Set a wake hook with
    /// `set_wake_hook`, and call `pump_events` on this thread when it fires.
    pub fn new_embedded() -> Result<Self> {
        Self::create(true)
    }

    fn create(embedded: bool) -> Result<Self> {
        let wake = Wake::default();
        let (sender, main_receiver) = mpsc::channel();
        let main_sender = MainSender::new(sender, wake.clone());
        let dispatcher = Arc::new(TerminalDispatcher::new(main_sender.clone()));
        let tty = Tty::open()?;
        let terminal_size = tty.size()?;
        tty.spawn_input_thread(main_sender)?;
        Ok(Self {
            embedded,
            dispatcher: dispatcher.clone(),
            wake,
            scheduled_wake: Cell::new(None),
            shut_down: Cell::new(false),
            background_executor: BackgroundExecutor::new(dispatcher.clone()),
            foreground_executor: ForegroundExecutor::new(dispatcher),
            text_system: new_text_system(),
            main_receiver,
            tty: Rc::new(RefCell::new(tty)),
            display: Rc::new(TerminalDisplay {
                bounds: Bounds::new(
                    Point::default(),
                    size(
                        px(terminal_size.width as f32),
                        px(terminal_size.height as f32),
                    ),
                ),
            }),
            quit_requested: Rc::new(Cell::new(false)),
            window: RefCell::new(None),
            clipboard: RefCell::new(None),
            #[cfg(any(target_os = "linux", target_os = "freebsd"))]
            primary: RefCell::new(None),
            cursor_style: Cell::new(None),
            quit_callback: RefCell::new(None),
        })
    }

    /// Called from any thread whenever the main thread has work: a runnable,
    /// terminal input, or a frame that became due. Pass `None` to clear it.
    pub fn set_wake_hook(&self, hook: Option<Arc<dyn Fn() + Send + Sync>>) {
        self.wake.set(hook);
    }

    /// Runs queued main-thread work and a due frame, without blocking.
    /// Returns false once the application quit; the terminal is restored then.
    pub fn pump_events(&self) -> bool {
        if self.shut_down.get() {
            return false;
        }
        let started = Instant::now();
        while !self.quit_requested.get() {
            if started.elapsed() >= PUMP_BUDGET {
                self.wake.wake();
                break;
            }
            match self.main_receiver.try_recv() {
                Ok(message) => self.handle_message(message),
                Err(_) => break,
            }
        }
        if !self.quit_requested.get()
            && let Some(deadline) = self.window().and_then(|window| window.run_frame_if_due())
        {
            self.wake_at(deadline);
        }
        if self.quit_requested.get() {
            self.shut_down();
            return false;
        }
        true
    }

    fn wake_at(&self, deadline: Instant) {
        let pending = self
            .scheduled_wake
            .get()
            .is_some_and(|scheduled| scheduled > Instant::now() && scheduled <= deadline);
        if !pending {
            self.scheduled_wake.set(Some(deadline));
            self.dispatcher.wake_main_thread_at(deadline);
        }
    }

    fn shut_down(&self) {
        if self.shut_down.replace(true) {
            return;
        }
        let should_quit = self
            .quit_callback
            .borrow_mut()
            .as_mut()
            .is_none_or(|callback| callback());
        if !should_quit {
            log::warn!("the quit callback asked to stay open, but the terminal session ended");
        }
        if let Some(window) = self.window() {
            window.close();
        }
        tty::restore_terminal();
    }

    fn window(&self) -> Option<Rc<WindowInner>> {
        self.window.borrow().as_ref()?.1.upgrade()
    }

    fn write_to_terminal(&self, bytes: &[u8]) {
        if let Err(error) = self.tty.borrow_mut().write_all(bytes) {
            log::error!("{error:#}");
        }
    }

    /// OSC 52 sets a system selection (`c` clipboard, `p` primary), also over SSH.
    fn write_selection(&self, selection: char, item: &ClipboardItem) {
        if let Some(text) = item.text() {
            let encoded = base64::engine::general_purpose::STANDARD.encode(text);
            self.write_to_terminal(format!("\x1b]52;{selection};{encoded}\x1b\\").as_bytes());
        }
    }

    /// Hands a URL or file to the user's apps with `open(1)` or `xdg-open(1)`.
    fn run_open(&self, arguments: Vec<std::ffi::OsString>) {
        let program = if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        };
        self.background_executor
            .spawn(async move {
                match smol::process::Command::new(program)
                    .args(&arguments)
                    .status()
                    .await
                {
                    Ok(status) if status.success() => {}
                    Ok(status) => log::error!("{program} {arguments:?} exited with {status}"),
                    Err(error) => log::error!("failed to run {program} {arguments:?}: {error}"),
                }
            })
            .detach();
    }

    fn handle_message(&self, message: MainMessage) {
        match message {
            MainMessage::Runnable(runnable) => {
                let location = runnable.metadata().location;
                let spawned = runnable.metadata().spawned;
                gpui::profiler::update_running_task(spawned, location);
                runnable.run();
                gpui::profiler::save_task_timing();
            }
            MainMessage::Terminal(TerminalEvent::Quit) => self.quit_requested.set(true),
            MainMessage::Terminal(event) => {
                if let Some(window) = self.window() {
                    window.handle_event(event);
                }
            }
        }
    }
}

impl Platform for TerminalPlatform {
    fn background_executor(&self) -> BackgroundExecutor {
        self.background_executor.clone()
    }

    fn foreground_executor(&self) -> ForegroundExecutor {
        self.foreground_executor.clone()
    }

    fn text_system(&self) -> Arc<dyn PlatformTextSystem> {
        self.text_system.clone()
    }

    fn run(&self, on_finish_launching: Box<dyn 'static + FnOnce()>) {
        on_finish_launching();
        if self.embedded {
            return;
        }
        while !self.quit_requested.get() {
            let deadline = self.window().and_then(|window| window.run_frame_if_due());
            let message = match deadline {
                Some(deadline) => {
                    let timeout = deadline.saturating_duration_since(Instant::now());
                    match self.main_receiver.recv_timeout(timeout) {
                        Ok(message) => message,
                        Err(mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
                None => match self.main_receiver.recv() {
                    Ok(message) => message,
                    Err(_) => break,
                },
            };
            self.handle_message(message);
        }
        self.shut_down();
    }

    fn quit(&self) {
        self.quit_requested.set(true);
        self.wake.wake();
    }

    fn restart(&self, _binary_path: Option<PathBuf>, _arguments: Vec<std::ffi::OsString>) {}

    fn activate(&self, _ignoring_other_apps: bool) {}

    fn hide(&self) {}

    fn hide_other_apps(&self) {}

    fn unhide_other_apps(&self) {}

    fn displays(&self) -> Vec<Rc<dyn PlatformDisplay>> {
        vec![self.display.clone()]
    }

    fn primary_display(&self) -> Option<Rc<dyn PlatformDisplay>> {
        Some(self.display.clone())
    }

    fn active_window(&self) -> Option<AnyWindowHandle> {
        let window = self.window.borrow();
        let (handle, inner) = window.as_ref()?;
        (inner.strong_count() > 0).then_some(*handle)
    }

    fn open_window(
        &self,
        handle: AnyWindowHandle,
        params: WindowParams,
    ) -> Result<Box<dyn PlatformWindow>> {
        anyhow::ensure!(
            matches!(params.kind, WindowKind::Normal),
            "a terminal only has one surface; {:?} windows are not supported",
            params.kind
        );
        anyhow::ensure!(
            self.window().is_none(),
            "a terminal only has one surface and a window is already open"
        );
        let size = self.tty.borrow().size()?;
        let window = TerminalWindow::new(
            self.tty.clone(),
            self.display.clone(),
            self.quit_requested.clone(),
            self.wake.clone(),
            size,
        )?;
        *self.window.borrow_mut() = Some((handle, Rc::downgrade(&window.0)));
        Ok(Box::new(window))
    }

    fn window_appearance(&self) -> WindowAppearance {
        WindowAppearance::Dark
    }

    fn open_url(&self, url: &str) {
        self.run_open(vec![url.into()]);
    }

    fn on_open_urls(&self, _callback: Box<dyn FnMut(Vec<String>)>) {}

    fn register_url_scheme(&self, _url: &str) -> Task<Result<()>> {
        Task::ready(Err(anyhow::anyhow!(
            "a terminal application cannot register URL schemes"
        )))
    }

    fn prompt_for_paths(
        &self,
        _options: PathPromptOptions,
    ) -> oneshot::Receiver<Result<Option<Vec<PathBuf>>>> {
        let (sender, receiver) = oneshot::channel();
        sender
            .send(Err(anyhow::anyhow!(
                "file dialogs are not available in a terminal"
            )))
            .ok();
        receiver
    }

    fn prompt_for_new_path(
        &self,
        _directory: &Path,
        _suggested_name: Option<&str>,
    ) -> oneshot::Receiver<Result<Option<PathBuf>>> {
        let (sender, receiver) = oneshot::channel();
        sender
            .send(Err(anyhow::anyhow!(
                "file dialogs are not available in a terminal"
            )))
            .ok();
        receiver
    }

    fn can_select_mixed_files_and_dirs(&self) -> bool {
        false
    }

    fn reveal_path(&self, path: &Path) {
        if cfg!(target_os = "macos") {
            self.run_open(vec!["-R".into(), path.into()]);
        } else {
            // xdg-open cannot select a file; open the folder that contains it.
            self.run_open(vec![path.parent().unwrap_or(path).into()]);
        }
    }

    fn open_with_system(&self, path: &Path) {
        self.run_open(vec![path.into()]);
    }

    fn on_quit(&self, callback: Box<dyn FnMut() -> bool>) {
        *self.quit_callback.borrow_mut() = Some(callback);
    }

    fn on_reopen(&self, _callback: Box<dyn FnMut()>) {}

    fn on_system_wake(&self, _callback: Box<dyn FnMut()>) {}

    fn set_menus(&self, _menus: Vec<Menu>, _keymap: &Keymap) {}

    fn set_dock_menu(&self, _menu: Vec<MenuItem>, _keymap: &Keymap) {}

    fn on_app_menu_action(&self, _callback: Box<dyn FnMut(&dyn Action)>) {}

    fn on_will_open_app_menu(&self, _callback: Box<dyn FnMut()>) {}

    fn on_validate_app_menu_command(&self, _callback: Box<dyn FnMut(&dyn Action) -> bool>) {}

    fn thermal_state(&self) -> ThermalState {
        ThermalState::Nominal
    }

    fn on_thermal_state_change(&self, _callback: Box<dyn FnMut()>) {}

    fn compositor_name(&self) -> &'static str {
        "terminal"
    }

    fn app_path(&self) -> Result<PathBuf> {
        std::env::current_exe().context("resolving the executable path")
    }

    fn path_for_auxiliary_executable(&self, name: &str) -> Result<PathBuf> {
        let executable = self.app_path()?;
        let directory = executable
            .parent()
            .context("the executable has no parent directory")?;
        Ok(directory.join(name))
    }

    /// OSC 22 sets the pointer shape in kitty, Ghostty and WezTerm. The names
    /// are CSS cursor names.
    fn set_cursor_style(&self, style: CursorStyle) {
        if self.cursor_style.replace(Some(style)) == Some(style) {
            return;
        }
        let name = match style {
            CursorStyle::Arrow => "default",
            CursorStyle::IBeam => "text",
            CursorStyle::Crosshair => "crosshair",
            CursorStyle::ClosedHand => "grabbing",
            CursorStyle::OpenHand => "grab",
            CursorStyle::PointingHand => "pointer",
            CursorStyle::ResizeLeft | CursorStyle::ResizeRight | CursorStyle::ResizeLeftRight => {
                "ew-resize"
            }
            CursorStyle::ResizeUp | CursorStyle::ResizeDown | CursorStyle::ResizeUpDown => {
                "ns-resize"
            }
            CursorStyle::ResizeUpLeftDownRight => "nwse-resize",
            CursorStyle::ResizeUpRightDownLeft => "nesw-resize",
            CursorStyle::ResizeColumn => "col-resize",
            CursorStyle::ResizeRow => "row-resize",
            CursorStyle::IBeamCursorForVerticalLayout => "vertical-text",
            CursorStyle::OperationNotAllowed => "not-allowed",
            CursorStyle::DragLink => "alias",
            CursorStyle::DragCopy => "copy",
            CursorStyle::ContextualMenu => "context-menu",
        };
        self.write_to_terminal(format!("\x1b]22;{name}\x1b\\").as_bytes());
    }

    fn hide_cursor_until_mouse_moves(&self) {}

    fn is_cursor_visible(&self) -> bool {
        true
    }

    fn should_auto_hide_scrollbars(&self) -> bool {
        true
    }

    /// The terminal's paste arrives as bracketed paste, not through here, so
    /// this only returns what this application copied.
    fn read_from_clipboard(&self) -> Option<ClipboardItem> {
        self.clipboard.borrow().clone()
    }

    fn write_to_clipboard(&self, item: ClipboardItem) {
        self.write_selection('c', &item);
        *self.clipboard.borrow_mut() = Some(item);
    }

    #[cfg(target_os = "macos")]
    fn read_from_find_pasteboard(&self) -> Option<ClipboardItem> {
        None
    }

    #[cfg(target_os = "macos")]
    fn write_to_find_pasteboard(&self, _item: ClipboardItem) {}

    #[cfg(any(target_os = "linux", target_os = "freebsd"))]
    fn read_from_primary(&self) -> Option<ClipboardItem> {
        self.primary.borrow().clone()
    }

    #[cfg(any(target_os = "linux", target_os = "freebsd"))]
    fn write_to_primary(&self, item: ClipboardItem) {
        self.write_selection('p', &item);
        *self.primary.borrow_mut() = Some(item);
    }

    fn write_credentials(&self, _url: &str, _username: &str, _password: &[u8]) -> Task<Result<()>> {
        Task::ready(Err(anyhow::anyhow!(
            "credential storage is not available in a terminal"
        )))
    }

    fn read_credentials(&self, _url: &str) -> Task<Result<Option<(String, Vec<u8>)>>> {
        Task::ready(Ok(None))
    }

    fn delete_credentials(&self, _url: &str) -> Task<Result<()>> {
        Task::ready(Err(anyhow::anyhow!(
            "credential storage is not available in a terminal"
        )))
    }

    fn keyboard_layout(&self) -> Box<dyn PlatformKeyboardLayout> {
        Box::new(TerminalKeyboardLayout)
    }

    fn keyboard_mapper(&self) -> Rc<dyn PlatformKeyboardMapper> {
        Rc::new(DummyKeyboardMapper)
    }

    fn on_keyboard_layout_change(&self, _callback: Box<dyn FnMut()>) {}
}

#[cfg(target_os = "macos")]
fn new_text_system() -> Arc<dyn PlatformTextSystem> {
    Arc::new(gpui_macos::MacTextSystem::new())
}

#[cfg(not(target_os = "macos"))]
fn new_text_system() -> Arc<dyn PlatformTextSystem> {
    Arc::new(gpui_wgpu::CosmicTextSystem::new("IBM Plex Sans"))
}

/// The kitty keyboard protocol reports layout-independent keys plus the
/// typed text, so there is no layout to expose.
struct TerminalKeyboardLayout;

impl PlatformKeyboardLayout for TerminalKeyboardLayout {
    fn id(&self) -> &str {
        "terminal"
    }

    fn name(&self) -> &str {
        "Terminal"
    }
}

#[derive(Debug)]
struct TerminalDisplay {
    bounds: Bounds<Pixels>,
}

impl PlatformDisplay for TerminalDisplay {
    fn id(&self) -> DisplayId {
        DisplayId::new(0)
    }

    fn uuid(&self) -> Result<uuid::Uuid> {
        Ok(uuid::Uuid::nil())
    }

    fn bounds(&self) -> Bounds<Pixels> {
        self.bounds
    }
}
