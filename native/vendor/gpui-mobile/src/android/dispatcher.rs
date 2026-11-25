//! Android task dispatcher.
//!
//! Mirrors the two-queue model used in `gpui_linux` and `IosDispatcher`:
//!
//! * **Foreground / main-thread tasks** — queued for the Android native-activity
//!   thread (the same thread that owns the `ANativeWindow` and processes input
//!   events), then woken through `android-activity`'s supported waker.
//!
//! * **Background tasks** — dispatched onto a fixed-size Rust thread-pool
//!   backed by `std::thread`.  The pool size defaults to
//!   `std::thread::available_parallelism()`.
//!
//! ## Design notes
//!
//! `android-activity` owns the `ALooper` and documents `AndroidAppWaker` as the
//! supported way to interrupt `poll_events`. Registering another fd callback
//! makes `android-activity` report a spurious callback on every poll and adds
//! work to the scroll hot path, so this dispatcher keeps only its task queue.
//!
//! ## GPUI integration
//!
//! `AndroidDispatcher` implements `gpui::PlatformDispatcher` so it can be
//! used to construct `BackgroundExecutor` and `ForegroundExecutor` instances.

use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use android_activity::{AndroidApp, AndroidAppWaker};
use gpui::{PlatformDispatcher, Priority, RunnableVariant};
use parking_lot::Mutex;

// ── task queue ────────────────────────────────────────────────────────────────

type BoxedTask = Box<dyn FnOnce() + Send + 'static>;

/// Shared state between producers and the foreground loop.
struct MainQueue {
    tasks: VecDeque<BoxedTask>,
}

// ── thread-pool ───────────────────────────────────────────────────────────────

/// A minimal fixed-size thread-pool for background tasks.
struct ThreadPool {
    sender: std::sync::mpsc::Sender<BoxedTask>,
}

impl ThreadPool {
    fn new(threads: usize) -> Self {
        let (sender, receiver) = std::sync::mpsc::channel::<BoxedTask>();
        let receiver = Arc::new(Mutex::new(receiver));

        for i in 0..threads {
            let rx = Arc::clone(&receiver);
            std::thread::Builder::new()
                .name(format!("gpui-bg-{}", i))
                .spawn(move || {
                    loop {
                        let task = {
                            let lock = rx.lock();
                            lock.recv()
                        };
                        match task {
                            Ok(f) => f(),
                            Err(_) => break, // channel closed
                        }
                    }
                })
                .expect("failed to spawn background thread");
        }

        ThreadPool { sender }
    }

    fn dispatch(&self, task: BoxedTask) {
        // If the pool is shutting down the send will fail silently.
        let _ = self.sender.send(task);
    }
}

// ── delayed task queue ────────────────────────────────────────────────────────

struct DelayedTask {
    due: Instant,
    task: BoxedTask,
}

// ── AndroidDispatcher ─────────────────────────────────────────────────────────

/// GPUI dispatcher for Android.
///
/// * Foreground tasks run on the Android main/native thread via `ALooper`.
/// * Background tasks run on a Rust thread-pool.
/// * Delayed tasks are checked on each `tick()` call (driven by the main loop).
pub struct AndroidDispatcher {
    /// Shared task queue for the native main thread.
    main_queue: Arc<Mutex<MainQueue>>,
    /// Official wake handle for the `android-activity` event loop. Headless
    /// mode has no event loop, so tasks are drained explicitly instead.
    waker: Option<AndroidAppWaker>,
    main_thread: std::thread::ThreadId,
    /// Background thread-pool.
    pool: ThreadPool,
    /// Delayed background tasks sorted by due time.
    delayed: Mutex<Vec<DelayedTask>>,
    /// Set to `true` once `shutdown()` is called.
    shutdown: AtomicBool,
}

impl AndroidDispatcher {
    /// Create a new dispatcher.
    ///
    /// Must be called on Android's native-activity thread.
    pub fn new(app: &AndroidApp) -> Arc<Self> {

        let pool_threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .max(2);

        let main_queue = Arc::new(Mutex::new(MainQueue { tasks: VecDeque::new() }));

        let dispatcher = Arc::new(Self {
            main_queue: Arc::clone(&main_queue),
            waker: Some(app.create_waker()),
            main_thread: std::thread::current().id(),
            pool: ThreadPool::new(pool_threads),
            delayed: Mutex::new(Vec::new()),
            shutdown: AtomicBool::new(false),
        });

        log::debug!("AndroidDispatcher created (pool_threads={})", pool_threads);

        dispatcher
    }

    /// Create a dispatcher without a real `ALooper`.
    ///
    /// Safe to call from any thread (including non-Android host environments
    /// and unit tests).  Foreground tasks accumulate in the queue and must
    /// be drained manually via `flush_main_thread_tasks()`.
    pub fn new_headless() -> Arc<Self> {
        let pool_threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(2)
            .max(1);

        let main_queue = Arc::new(Mutex::new(MainQueue { tasks: VecDeque::new() }));

        Arc::new(Self {
            main_queue,
            waker: None,
            main_thread: std::thread::current().id(),
            pool: ThreadPool::new(pool_threads),
            delayed: Mutex::new(Vec::new()),
            shutdown: AtomicBool::new(false),
        })
    }

    // ── public API ────────────────────────────────────────────────────────────

    /// Returns `true` if the calling thread is the main/UI thread.
    pub fn is_main_thread(&self) -> bool {
        std::thread::current().id() == self.main_thread
    }

    /// Enqueue a task to run on the **main** (foreground) thread.
    pub fn dispatch_on_main_thread<F>(&self, f: F)
    where
        F: FnOnce() + Send + 'static,
    {
        if self.shutdown.load(Ordering::Relaxed) {
            return;
        }
        let mut q = self.main_queue.lock();
        q.tasks.push_back(Box::new(f));
        drop(q);
        if let Some(waker) = &self.waker {
            waker.wake();
        }
    }

    /// Enqueue a task on the **background** thread-pool.
    pub fn dispatch<F>(&self, f: F)
    where
        F: FnOnce() + Send + 'static,
    {
        if self.shutdown.load(Ordering::Relaxed) {
            return;
        }
        self.pool.dispatch(Box::new(f));
    }

    /// Enqueue a task on the **background** thread-pool after `delay`.
    pub fn dispatch_after<F>(&self, delay: Duration, f: F)
    where
        F: FnOnce() + Send + 'static,
    {
        if self.shutdown.load(Ordering::Relaxed) {
            return;
        }
        let due = Instant::now() + delay;
        let mut delayed = self.delayed.lock();
        delayed.push(DelayedTask {
            due,
            task: Box::new(f),
        });
        // Keep sorted by ascending due time.
        delayed.sort_by_key(|d| d.due);
    }

    /// Process any delayed background tasks whose due time has passed.
    ///
    /// Should be called from the main loop on every iteration (e.g. just
    /// before calling `ALooper_pollOnce`).
    pub fn tick(&self) {
        let now = Instant::now();
        let mut ready: Vec<BoxedTask> = Vec::new();
        {
            let mut delayed = self.delayed.lock();
            while delayed.first().map(|d| d.due <= now).unwrap_or(false) {
                ready.push(delayed.remove(0).task);
            }
        }
        for task in ready {
            self.pool.dispatch(task);
        }
    }

    /// Drain all pending **main-thread** tasks synchronously.
    ///
    /// Useful in tests or when the looper callback is not set up.
    pub fn flush_main_thread_tasks(&self) {
        loop {
            let task = {
                let mut q = self.main_queue.lock();
                q.tasks.pop_front()
            };
            match task {
                Some(f) => f(),
                None => break,
            }
        }
    }

    /// Stop accepting new tasks and signal the thread-pool to wind down.
    pub fn shutdown(&self) {
        self.shutdown.store(true, Ordering::SeqCst);
    }
}

impl Default for AndroidDispatcher {
    fn default() -> Self {
        panic!(
            "AndroidDispatcher must be constructed via `AndroidDispatcher::new()` \
             on the main thread"
        );
    }
}

impl Drop for AndroidDispatcher {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
    }
}

// ── impl PlatformDispatcher ───────────────────────────────────────────────────

impl PlatformDispatcher for AndroidDispatcher {
    fn is_main_thread(&self) -> bool {
        // Delegate to the existing `is_main_thread` method.
        AndroidDispatcher::is_main_thread(self)
    }

    fn dispatch(&self, runnable: RunnableVariant, _priority: Priority) {
        // All non-realtime background tasks go to the thread-pool.
        // Priority-based scheduling is not yet implemented; all tasks are
        // treated equally by the pool.
        self.pool.dispatch(Box::new(move || {
            runnable.run();
        }));
    }

    fn dispatch_on_main_thread(&self, runnable: RunnableVariant, _priority: Priority) {
        if self.shutdown.load(Ordering::Relaxed) {
            return;
        }
        let mut q = self.main_queue.lock();
        q.tasks.push_back(Box::new(move || {
            runnable.run();
        }));
        drop(q);
        if let Some(waker) = &self.waker {
            waker.wake();
        }
    }

    fn dispatch_after(&self, duration: Duration, runnable: RunnableVariant) {
        if self.shutdown.load(Ordering::Relaxed) {
            return;
        }
        let due = Instant::now() + duration;
        let mut delayed = self.delayed.lock();
        delayed.push(DelayedTask {
            due,
            task: Box::new(move || {
                runnable.run();
            }),
        });
        delayed.sort_by_key(|d| d.due);
    }

    fn spawn_realtime(&self, f: Box<dyn FnOnce() + Send>) {
        // Spawn a dedicated thread for realtime (audio) tasks, matching the
        // behaviour of the Linux dispatcher.
        std::thread::Builder::new()
            .name("gpui-realtime".to_string())
            .spawn(move || {
                f();
            })
            .expect("failed to spawn realtime thread");
    }
}

// ── tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    /// Verify that the thread-pool executes background tasks.
    #[test]
    fn background_tasks_run() {
        let pool = ThreadPool::new(2);
        let counter = Arc::new(AtomicUsize::new(0));

        for _ in 0..10 {
            let c = Arc::clone(&counter);
            pool.dispatch(Box::new(move || {
                c.fetch_add(1, Ordering::Relaxed);
            }));
        }

        // Give threads time to process.
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(counter.load(Ordering::Relaxed), 10);
    }

    /// Verify that delayed tasks are not dispatched before their due time.
    #[test]
    fn delayed_tasks_not_early() {
        let dispatcher = AndroidDispatcher::new_headless();

        let ran = Arc::new(AtomicBool::new(false));
        let ran2 = Arc::clone(&ran);

        dispatcher.dispatch_after(Duration::from_secs(60), move || {
            ran2.store(true, Ordering::Relaxed);
        });

        dispatcher.tick();
        assert!(!ran.load(Ordering::Relaxed), "task should not run yet");
    }
}
