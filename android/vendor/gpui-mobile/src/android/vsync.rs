//! Android hardware VSync integration via `AChoreographer` (`dlsym` loaded).
//!
//! Safety & threading invariant:
//! - `AChoreographer_getInstance()` binds to the calling thread's `ALooper`, so
//!   `arm_if_needed()` MUST ONLY be called from the `android_main` event loop
//!   thread.
//! - Any background thread (Hermes JS / GPUI background worker) may call
//!   `request_vsync()`, which atomically flags the request and wakes the main
//!   `ALooper` via `AndroidAppWaker`.

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

struct ChoreographerFns {
    get_instance: GetInstanceFn,
    post_64: Option<PostFrameCallback64Fn>,
    post_32: Option<PostFrameCallback32Fn>,
}

static FNS: OnceLock<Option<ChoreographerFns>> = OnceLock::new();
static VSYNC_REQUESTED: AtomicBool = AtomicBool::new(false);
static VSYNC_ARMED: AtomicBool = AtomicBool::new(false);
static VSYNC_FIRED: AtomicBool = AtomicBool::new(false);
static LAST_FRAME_TIME_NANOS: AtomicI64 = AtomicI64::new(0);

static FRAME_LISTENER: RwLock<Option<fn(f64)>> = RwLock::new(None);
static EXTERNAL_DEMAND: RwLock<Option<fn() -> bool>> = RwLock::new(None);

fn resolve_fns() -> Option<&'static ChoreographerFns> {
    FNS.get_or_init(|| unsafe {
        let get_ptr = libc::dlsym(libc::RTLD_DEFAULT, c"AChoreographer_getInstance".as_ptr());
        if get_ptr.is_null() {
            log::warn!("AChoreographer_getInstance not found; falling back to timer pacing");
            return None;
        }
        let post64_ptr = libc::dlsym(
            libc::RTLD_DEFAULT,
            c"AChoreographer_postFrameCallback64".as_ptr(),
        );
        let post32_ptr = libc::dlsym(
            libc::RTLD_DEFAULT,
            c"AChoreographer_postFrameCallback".as_ptr(),
        );
        if post64_ptr.is_null() && post32_ptr.is_null() {
            log::warn!("AChoreographer_postFrameCallback* not found; falling back to timer pacing");
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
        })
    })
    .as_ref()
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

/// Arm `AChoreographer` for the next hardware VSync on the calling `android_main` thread.
///
/// Returns `true` when hardware VSync is available (either already armed/fired or
/// newly posted); returns `false` when `AChoreographer` is unavailable on this thread/ABI.
pub fn arm_if_needed() -> bool {
    if VSYNC_FIRED.load(Ordering::Acquire) || VSYNC_ARMED.load(Ordering::Acquire) {
        return true;
    }
    let Some(fns) = resolve_fns() else {
        return false;
    };
    unsafe {
        let choreographer = (fns.get_instance)();
        if choreographer.is_null() {
            return false;
        }
        VSYNC_REQUESTED.store(false, Ordering::Release);
        VSYNC_ARMED.store(true, Ordering::Release);
        if let Some(post64) = fns.post_64 {
            post64(choreographer, on_choreographer_frame_64, std::ptr::null_mut());
            return true;
        }
        if let Some(post32) = fns.post_32 {
            post32(choreographer, on_choreographer_frame_32, std::ptr::null_mut());
            return true;
        }
        VSYNC_ARMED.store(false, Ordering::Release);
        false
    }
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
    VSYNC_REQUESTED.store(false, Ordering::Release);
    VSYNC_ARMED.store(false, Ordering::Release);
    VSYNC_FIRED.store(false, Ordering::Release);
}
