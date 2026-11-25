use std::{
    collections::BinaryHeap,
    sync::{Arc, mpsc},
    thread,
    time::{Duration, Instant},
};

use gpui::{
    PlatformDispatcher, Priority, PriorityQueueReceiver, PriorityQueueSender, RunnableVariant,
    profiler,
};
use parking_lot::{Condvar, Mutex};

use crate::tty::TerminalEvent;

const MIN_THREADS: usize = 2;

/// Everything the main thread waits for arrives on one channel, so the event
/// loop blocks in a single place: GPUI runnables, terminal input and resizes.
pub(crate) enum MainMessage {
    Runnable(RunnableVariant),
    Terminal(TerminalEvent),
}

/// Tells an embedding host that the main thread has work, so it calls
/// `TerminalPlatform::pump_events`. Empty when the platform owns its loop.
#[derive(Clone, Default)]
pub(crate) struct Wake(Arc<Mutex<Option<Arc<dyn Fn() + Send + Sync>>>>);

impl Wake {
    pub(crate) fn set(&self, hook: Option<Arc<dyn Fn() + Send + Sync>>) {
        *self.0.lock() = hook;
    }

    pub(crate) fn wake(&self) {
        let hook = self.0.lock().clone();
        if let Some(hook) = hook {
            hook();
        }
    }
}

/// Sends to the main thread and wakes the host after every message.
#[derive(Clone)]
pub(crate) struct MainSender {
    sender: mpsc::Sender<MainMessage>,
    wake: Wake,
}

impl MainSender {
    pub(crate) fn new(sender: mpsc::Sender<MainMessage>, wake: Wake) -> Self {
        Self { sender, wake }
    }

    pub(crate) fn send(&self, message: MainMessage) -> Result<(), mpsc::SendError<MainMessage>> {
        self.sender.send(message)?;
        self.wake.wake();
        Ok(())
    }
}

pub(crate) struct TerminalDispatcher {
    main_sender: MainSender,
    background_sender: PriorityQueueSender<RunnableVariant>,
    timers: Arc<TimerQueue>,
    main_thread_id: thread::ThreadId,
}

impl TerminalDispatcher {
    pub(crate) fn new(main_sender: MainSender) -> Self {
        let (background_sender, background_receiver) = PriorityQueueReceiver::new();
        let thread_count = thread::available_parallelism()
            .map_or(MIN_THREADS, |count| count.get().max(MIN_THREADS));
        for index in 0..thread_count {
            let receiver: PriorityQueueReceiver<RunnableVariant> = background_receiver.clone();
            thread::Builder::new()
                .name(format!("TerminalWorker-{index}"))
                .spawn(move || {
                    for runnable in receiver.iter() {
                        run(runnable);
                    }
                })
                .expect("failed to spawn terminal worker thread");
        }

        let timers = Arc::new(TimerQueue {
            state: Mutex::new(TimerState {
                heap: BinaryHeap::new(),
                next_sequence: 0,
            }),
            condvar: Condvar::new(),
        });
        thread::Builder::new()
            .name("TerminalTimer".to_owned())
            .spawn({
                let timers = timers.clone();
                move || timers.run()
            })
            .expect("failed to spawn terminal timer thread");

        Self {
            main_sender,
            background_sender,
            timers,
            main_thread_id: thread::current().id(),
        }
    }

    /// Wakes the host at `due`, e.g. when a throttled frame becomes due.
    pub(crate) fn wake_main_thread_at(&self, due: Instant) {
        self.timers
            .push(due, TimerAction::Wake(self.main_sender.wake.clone()));
    }
}

impl PlatformDispatcher for TerminalDispatcher {
    fn is_main_thread(&self) -> bool {
        thread::current().id() == self.main_thread_id
    }

    fn dispatch(&self, runnable: RunnableVariant, priority: Priority) {
        if let Err(error) = self.background_sender.send(priority, runnable) {
            // Workers only stop when the process exits. The runnable may wrap a
            // !Send future, so it must not be dropped on this thread.
            std::mem::forget(error);
        }
    }

    fn dispatch_on_main_thread(&self, runnable: RunnableVariant, _priority: Priority) {
        if let Err(error) = self.main_sender.send(MainMessage::Runnable(runnable)) {
            // The event loop has exited. Same reason as above for forgetting.
            std::mem::forget(error);
        }
    }

    fn dispatch_after(&self, duration: Duration, runnable: RunnableVariant) {
        self.timers
            .push(Instant::now() + duration, TimerAction::Run(runnable));
    }

    fn spawn_realtime(&self, function: Box<dyn FnOnce() + Send>) {
        thread::Builder::new()
            .name("TerminalRealtime".to_owned())
            .spawn(function)
            .expect("failed to spawn terminal realtime thread");
    }
}

fn run(runnable: RunnableVariant) {
    let location = runnable.metadata().location;
    let spawned = runnable.metadata().spawned;
    profiler::update_running_task(spawned, location);
    runnable.run();
    profiler::save_task_timing();
}

struct TimerQueue {
    state: Mutex<TimerState>,
    condvar: Condvar,
}

struct TimerState {
    heap: BinaryHeap<TimerEntry>,
    next_sequence: u64,
}

impl TimerQueue {
    fn push(&self, due: Instant, action: TimerAction) {
        let mut state = self.state.lock();
        let sequence = state.next_sequence;
        state.next_sequence += 1;
        state.heap.push(TimerEntry {
            due,
            sequence,
            action,
        });
        self.condvar.notify_one();
    }

    fn run(&self) {
        let mut state = self.state.lock();
        loop {
            let Some(due) = state.heap.peek().map(|entry| entry.due) else {
                self.condvar.wait(&mut state);
                continue;
            };
            if due > Instant::now() {
                self.condvar.wait_until(&mut state, due);
                continue;
            }
            let Some(entry) = state.heap.pop() else {
                continue;
            };
            drop(state);
            match entry.action {
                TimerAction::Run(runnable) => run(runnable),
                TimerAction::Wake(wake) => wake.wake(),
            }
            state = self.state.lock();
        }
    }
}

enum TimerAction {
    Run(RunnableVariant),
    Wake(Wake),
}

struct TimerEntry {
    due: Instant,
    sequence: u64,
    action: TimerAction,
}

impl PartialEq for TimerEntry {
    fn eq(&self, other: &Self) -> bool {
        self.due == other.due && self.sequence == other.sequence
    }
}

impl Eq for TimerEntry {}

impl PartialOrd for TimerEntry {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for TimerEntry {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        // Reversed: BinaryHeap is a max-heap and the earliest timer must be on top.
        other
            .due
            .cmp(&self.due)
            .then_with(|| other.sequence.cmp(&self.sequence))
    }
}
