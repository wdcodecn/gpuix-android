//! Android hardware VSync integration via `AChoreographer` (`dlsym` loaded).
//!
//! Runs `AChoreographer` on a dedicated `gpuix-vsync` thread with its own
//! `ALooper` so `android_main`'s `android-activity` looper is never polluted with
//! unregistered file descriptors (avoiding per-frame `Spurious ALOOPER_POLL_CALLBACK`
//! warnings) and rendering pauses on the main thread cannot miss a VSync edge.

use std::{
    ffi::c_void,
    sync::atomic::{AtomicBool, AtomicI64, Ordering},
    sync::OnceLock,
};

use parking_lot::RwLock;

type GetInstanceFn = unsafe extern "C" fn() -> *mut c_void;
type FrameCallback64Fn = unsafe extern "C" fn(frame_time_nanos: i64, data: *mut c_void);
type PostFrameCallback64Fn =
    unsafe extern "C" fn(choreographer: *mut c_void, callback: FrameCallback64Fn, data: *mut c_void);
type FrameCallback32Fn = unsafe extern "C" fn(frame_time_nanos: libc::c_long, data: *mut c_void);
type PostFrameCallback32Fn =
    unsafe extern "C" fn(choreographer: *mut c_void, callback: FrameCallback32Fn, data: *mut c_void);
type LooperPrepareFn = unsafe extern "C" fn(opts: libc::c_int) -> *mut c_void;
type LooperPollOnceFn = unsafe extern "C" fn(
    timeout_millis: libc::c_int,
    out_fd: *mut libc::c_int,
    out_events: *mut libc::c_int,
    out_data: *mut *mut c_void,
) -> libc::c_int;
type LooperWakeFn = unsafe extern "C" fn(looper: *mut c_void);

const ALOOPER_PREPARE_ALLOW_NON_CALLBACKS: libc::c_int = 1 << 0;

struct ChoreographerFns {
    get_instance: GetInstanceFn,
    post_64: Option<PostFrameCallback64Fn>,
    post_32: Option<PostFrameCallback32Fn>,
    looper_prepare: LooperPrepareFn,
    looper_poll_once: LooperPollOnceFn,
    looper_wake: LooperWakeFn,
}

static FNS: OnceLock<Option<ChoreographerFns>> = OnceLock::new();
static VSYNC_THREAD_LOOPER: OnceLock<Option<usize>> = OnceLock::new();
static VSYNC_WANT_ARM: AtomicBool = AtomicBool::new(false);
static VSYNC_REQUESTED: AtomicBool = AtomicBool::new(false);
static VSYNC_ARMED: AtomicBool = AtomicBool::new(false);
static VSYNC_FIRED: AtomicBool = AtomicBool::new(false);
static LAST_FRAME_TIME_NANOS: AtomicI64 = AtomicI64::new(0);

static FRAME_LISTENER: RwLock<Option<fn(f64)>> = RwLock::new(None);
static EXTERNAL_DEMAND: RwLock<Option<fn() -> bool>> = RwLock::new(None);

unsafe fn lookup_libandroid_symbol(name: &std::ffi::CStr) -> *mut c_void {
    let ptr = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
    if !ptr.is_null() {
        return ptr;
    }
    static LIBANDROID: OnceLock<usize> = OnceLock::new();
    let handle = *LIBANDROID.get_or_init(|| unsafe {
        libc::dlopen(b"libandroid.so\0".as_ptr().cast(), libc::RTLD_NOW) as usize
    });
    if handle != 0 {
        unsafe { libc::dlsym(handle as *mut c_void, name.as_ptr()) }
    } else {
        std::ptr::null_mut()
    }
}

fn resolve_fns() -> Option<&'static ChoreographerFns> {
    FNS.get_or_init(|| unsafe {
        let get_ptr = lookup_libandroid_symbol(c"AChoreographer_getInstance");
        if get_ptr.is_null() {
            log::warn!("AChoreographer_getInstance not found; falling back to timer pacing");
            return None;
        }
        let post64_ptr = lookup_libandroid_symbol(c"AChoreographer_postFrameCallback64");
        let post32_ptr = lookup_libandroid_symbol(c"AChoreographer_postFrameCallback");
        if post64_ptr.is_null() && post32_ptr.is_null() {
            log::warn!("AChoreographer_postFrameCallback* not found; falling back to timer pacing");
            return None;
        }
        let prepare_ptr = lookup_libandroid_symbol(c"ALooper_prepare");
        let poll_ptr = lookup_libandroid_symbol(c"ALooper_pollOnce");
        let wake_ptr = lookup_libandroid_symbol(c"ALooper_wake");
        if prepare_ptr.is_null() || poll_ptr.is_null() || wake_ptr.is_null() {
            log::warn!("ALooper_* entry points not found; falling back to timer pacing");
            return None;
        }
        Some(ChoreographerFns {
            get_instance: std::mem::transmute::<*mut c_void, GetInstanceFn>(get_ptr),
            post_64: if post64_ptr.is_null() {
                None
            } else {
                Some(std::mem::transmute::<*mut c_void, PostFrameCallback64Fn>(
                    post64_ptr,
                ))
            },
            post_32: if post32_ptr.is_null() {
                None
            } else {
                Some(std::mem::transmute::<*mut c_void, PostFrameCallback32Fn>(
                    post32_ptr,
                ))
            },
            looper_prepare: std::mem::transmute::<*mut c_void, LooperPrepareFn>(prepare_ptr),
            looper_poll_once: std::mem::transmute::<*mut c_void, LooperPollOnceFn>(poll_ptr),
            looper_wake: std::mem::transmute::<*mut c_void, LooperWakeFn>(wake_ptr),
        })
    })
    .as_ref()
}

fn ensure_vsync_thread() -> Option<(usize, &'static ChoreographerFns)> {
    let fns = resolve_fns()?;
    let looper_opt = *VSYNC_THREAD_LOOPER.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::sync_channel::<Option<usize>>(1);
        let spawn_result = std::thread::Builder::new()
            .name("gpuix-vsync".to_string())
            .spawn(move || unsafe {
                // Boost dedicated VSync thread priority for consistent 120Hz cadence.
                libc::setpriority(libc::PRIO_PROCESS as _, 0, -8);
                let looper = (fns.looper_prepare)(ALOOPER_PREPARE_ALLOW_NON_CALLBACKS);
                if looper.is_null() {
                    log::warn!("gpuix-vsync: ALooper_prepare returned null");
                    let _ = tx.send(None);
                    return;
                }
                let choreographer = (fns.get_instance)();
                if choreographer.is_null() {
                    log::warn!("gpuix-vsync: AChoreographer_getInstance returned null");
                    let _ = tx.send(None);
                    return;
                }
                let _ = tx.send(Some(looper as usize));
                loop {
                    if VSYNC_WANT_ARM.swap(false, Ordering::AcqRel)
                        && !VSYNC_ARMED.load(Ordering::Acquire)
                        && !VSYNC_FIRED.load(Ordering::Acquire)
                    {
                        VSYNC_REQUESTED.store(false, Ordering::Release);
                        VSYNC_ARMED.store(true, Ordering::Release);
                        if let Some(post64) = fns.post_64 {
                            post64(choreographer, on_choreographer_frame_64, std::ptr::null_mut());
                        } else if let Some(post32) = fns.post_32 {
                            post32(choreographer, on_choreographer_frame_32, std::ptr::null_mut());
                        } else {
                            VSYNC_ARMED.store(false, Ordering::Release);
                        }
                    }
                    (fns.looper_poll_once)(
                        -1,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                    );
                }
            });
        match spawn_result {
            Ok(_) => rx.recv().unwrap_or(None),
            Err(err) => {
                log::warn!("failed to spawn gpuix-vsync thread: {err}");
                None
            }
        }
    });
    looper_opt.map(|looper| (looper, fns))
}

unsafe extern "C" fn on_choreographer_frame_64(frame_time_nanos: i64, _data: *mut c_void) {
    LAST_FRAME_TIME_NANOS.store(frame_time_nanos, Ordering::Release);
    VSYNC_FIRED.store(true, Ordering::Release);
    VSYNC_ARMED.store(false, Ordering::Release);
    if let Some(app) = crate::android::jni::android_app() {
        app.create_waker().wake();
    }
}

unsafe extern "C" fn on_choreographer_frame_32(
    frame_time_nanos: libc::c_long,
    _data: *mut c_void,
) {
    on_choreographer_frame_64(frame_time_nanos as i64, std::ptr::null_mut());
}

/// Request a VSync callback from any thread (for example Hermes `requestAnimationFrame`).
pub fn request_vsync() {
    VSYNC_REQUESTED.store(true, Ordering::Release);
    if let Some(app) = crate::android::jni::android_app() {
        app.create_waker().wake();
    }
}

/// Returns whether an external caller requested a VSync wakeup.
pub fn is_requested() -> bool {
    VSYNC_REQUESTED.load(Ordering::Acquire)
}

/// Register a listener invoked on the main loop thread at each VSync (`timestamp_ms`).
pub fn set_vsync_frame_listener(cb: fn(f64)) {
    *FRAME_LISTENER.write() = Some(cb);
}

/// Register a callback that reports whether external work (such as pending JS rAF)
/// needs the next VSync tick.
pub fn set_external_demand_checker(cb: fn() -> bool) {
    *EXTERNAL_DEMAND.write() = Some(cb);
}

/// Returns `true` when external consumers (such as pending JS rAF callbacks) need VSync.
pub fn has_external_demand() -> bool {
    EXTERNAL_DEMAND.read().is_some_and(|checker| checker())
}

/// Notify the registered frame listener with a VSync timestamp in nanoseconds.
pub fn notify_frame_listener(frame_time_nanos: i64) {
    if let Some(cb) = *FRAME_LISTENER.read() {
        cb(frame_time_nanos as f64 / 1_000_000.0);
    }
}

/// Arm `AChoreographer` on the dedicated `gpuix-vsync` thread for the next hardware VSync.
///
/// Safe to call from any thread; returns `true` when hardware VSync is available.
pub fn arm_if_needed() -> bool {
    if VSYNC_FIRED.load(Ordering::Acquire) || VSYNC_ARMED.load(Ordering::Acquire) {
        return true;
    }
    let Some((looper, fns)) = ensure_vsync_thread() else {
        return false;
    };
    VSYNC_WANT_ARM.store(true, Ordering::Release);
    unsafe {
        (fns.looper_wake)(looper as *mut c_void);
    }
    true
}

/// Returns `true` if a hardware VSync callback has already fired and awaits processing.
pub fn has_fired() -> bool {
    VSYNC_FIRED.load(Ordering::Acquire)
}

/// Consume a fired hardware VSync event, returning its hardware frame timestamp (ns).
pub fn take_fired() -> Option<i64> {
    if VSYNC_FIRED.swap(false, Ordering::AcqRel) {
        Some(LAST_FRAME_TIME_NANOS.load(Ordering::Acquire))
    } else {
        None
    }
}

/// Clear armed/pending flags (e.g. when the surface is destroyed or app pauses).
pub fn reset() {
    VSYNC_WANT_ARM.store(false, Ordering::Release);
    VSYNC_REQUESTED.store(false, Ordering::Release);
    VSYNC_ARMED.store(false, Ordering::Release);
    VSYNC_FIRED.store(false, Ordering::Release);
}
