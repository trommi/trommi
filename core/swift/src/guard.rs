//! What stands between a caller and a stateful object of the core: one caller at a time, no call from inside the
//! object's own callback, and no use after a fault.

use crate::CoreError;
use std::cell::Cell;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Mutex, MutexGuard, Once};

/// Why an object answers no more.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Closed {
    /// The caller closed it, or used it up.
    ByCaller,
    /// A call panicked: what the object holds in memory may be half an operation.
    Fault,
}

struct Slot<T> {
    value: Option<T>,
    closed: Option<Closed>,
}

/// A stateful object behind a lock.
///
/// - **One caller at a time.** A second thread waits.
/// - **No re-entry.** A call made while this thread is already inside the object (from the store's callback) is
///   refused instead of waiting for itself for ever. A callback that hands the call to another thread and waits
///   for it cannot be told from an ordinary second caller, and waits for ever: a store must not do that.
/// - **No panic leaves.** A panic inside a call is caught where the platform can catch one (not in WebAssembly,
///   where a panic stops the module and the JavaScript side refuses every later call). The object is then closed
///   for good: every later call is refused with `internal`, and the caller opens the stored state again.
pub(crate) struct Guarded<T> {
    slot: Mutex<Slot<T>>,
    /// The thread that is inside the object now.
    #[cfg(not(target_arch = "wasm32"))]
    inside: Mutex<Option<std::thread::ThreadId>>,
}

#[cfg(not(target_arch = "wasm32"))]
fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // A poisoned lock only says that a thread panicked while it held it. The slot's own flag says whether the
    // value may still be used, so the lock itself is taken either way.
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

thread_local! {
    /// How many calls into the core this thread is inside of, one within another: what a panic there says is
    /// not printed.
    static INSIDE_CALLS: Cell<u32> = const { Cell::new(0) };
}

/// The time a thread spends inside the core on behalf of the edge. A panic in that time prints where it
/// happened and nothing else: its message could quote what the call was working on. Panics anywhere else
/// print as before. The hook that does this is the process's one panic hook, wrapped once; a host that sets
/// another afterwards takes this over.
pub(crate) struct Quiet;

impl Quiet {
    /// Starts such a time; it ends when the value is dropped.
    pub(crate) fn enter() -> Self {
        static HOOK: Once = Once::new();
        HOOK.call_once(|| {
            let before = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                if INSIDE_CALLS.with(Cell::get) > 0 {
                    if let Some(place) = info.location() {
                        eprintln!("trommi-core: a fault at {}:{}", place.file(), place.line());
                    }
                } else {
                    before(info);
                }
            }));
        });
        INSIDE_CALLS.with(|calls| calls.set(calls.get().saturating_add(1)));
        Quiet
    }
}

impl Drop for Quiet {
    fn drop(&mut self) {
        INSIDE_CALLS.with(|calls| calls.set(calls.get().saturating_sub(1)));
    }
}

/// The time one caller is inside the object: the lock on the slot, and this thread's marks.
struct Entry<'a, T> {
    slot: MutexGuard<'a, Slot<T>>,
    _quiet: Quiet,
    #[cfg(not(target_arch = "wasm32"))]
    inside: &'a Mutex<Option<std::thread::ThreadId>>,
}

impl<T> Drop for Entry<'_, T> {
    /// The mark goes before the lock does (the fields are dropped after this): the next caller, who sets its own
    /// mark once it holds the lock, cannot have it cleared by this one.
    fn drop(&mut self) {
        #[cfg(not(target_arch = "wasm32"))]
        {
            *locked(self.inside) = None;
        }
    }
}

impl<T> Guarded<T> {
    /// Guards `value`.
    pub(crate) fn new(value: T) -> Self {
        Self {
            slot: Mutex::new(Slot {
                value: Some(value),
                closed: None,
            }),
            #[cfg(not(target_arch = "wasm32"))]
            inside: Mutex::new(None),
        }
    }

    /// Lets this caller in, or refuses a call from inside the object.
    #[cfg(not(target_arch = "wasm32"))]
    fn enter(&self) -> Result<Entry<'_, T>, CoreError> {
        let me = std::thread::current().id();
        if *locked(&self.inside) == Some(me) {
            return Err(CoreError::internal(
                "the object was called from inside its own callback",
            ));
        }
        let slot = locked(&self.slot);
        *locked(&self.inside) = Some(me);
        Ok(Entry {
            slot,
            _quiet: Quiet::enter(),
            inside: &self.inside,
        })
    }

    /// In WebAssembly there is one thread: a lock that is taken can only be this caller's own.
    #[cfg(target_arch = "wasm32")]
    fn enter(&self) -> Result<Entry<'_, T>, CoreError> {
        let slot = self.slot.try_lock().map_err(|_| {
            CoreError::internal("the object was called from inside its own callback")
        })?;
        Ok(Entry {
            slot,
            _quiet: Quiet::enter(),
        })
    }

    fn refusal(closed: Option<Closed>) -> CoreError {
        match closed {
            Some(Closed::Fault) => CoreError::internal(
                "the object failed inside the core and is closed: open it again",
            ),
            _ => CoreError::internal("the object is closed"),
        }
    }

    /// Runs `call` on the value.
    pub(crate) fn run<R>(
        &self,
        call: impl FnOnce(&mut T) -> Result<R, CoreError>,
    ) -> Result<R, CoreError> {
        let mut entry = self.enter()?;
        let closed = entry.slot.closed;
        let outcome = match (closed, entry.slot.value.as_mut()) {
            (None, Some(value)) => catch_unwind(AssertUnwindSafe(|| call(value))),
            _ => Ok(Err(Self::refusal(closed))),
        };
        outcome.unwrap_or_else(|_| {
            // The value stays where it is, unused, until the object is closed or dropped.
            entry.slot.closed = Some(Closed::Fault);
            Err(Self::refusal(Some(Closed::Fault)))
        })
    }

    /// Takes the value out for a call that ends the object, and runs `call` on it.
    pub(crate) fn finish<R>(
        &self,
        call: impl FnOnce(T) -> Result<R, CoreError>,
    ) -> Result<R, CoreError> {
        let mut entry = self.enter()?;
        let closed = entry.slot.closed;
        if closed.is_some() {
            return Err(Self::refusal(closed));
        }
        entry.slot.closed = Some(Closed::ByCaller);
        let outcome = match entry.slot.value.take() {
            Some(value) => catch_unwind(AssertUnwindSafe(|| call(value))),
            None => Ok(Err(Self::refusal(closed))),
        };
        outcome.unwrap_or_else(|_| {
            entry.slot.closed = Some(Closed::Fault);
            Err(Self::refusal(Some(Closed::Fault)))
        })
    }

    /// Closes the object and drops what it holds, also after a fault: its keys are wiped and whatever it owns
    /// (the store) is let go. Returns whether it is closed now; a call from inside the object itself closes
    /// nothing.
    pub(crate) fn close(&self) -> bool {
        let Ok(mut entry) = self.enter() else {
            return false;
        };
        if entry.slot.closed.is_none() {
            entry.slot.closed = Some(Closed::ByCaller);
        }
        if let Some(value) = entry.slot.value.take() {
            // Dropping half an operation could panic again: that must not leave either.
            let _ = catch_unwind(AssertUnwindSafe(|| drop(value)));
        }
        true
    }
}
