//! What stands between a caller and a stateful object of the core: one caller at a time, no call from inside the
//! object's own callback, and no use after a fault.

use crate::CoreError;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Mutex, MutexGuard, PoisonError};

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
///   refused instead of waiting for itself for ever.
/// - **No panic leaves.** A panic inside a call is caught where the platform can catch one (not in WebAssembly,
///   where a panic stops the module and the JavaScript side closes everything). The object is then closed for
///   good: every later call is refused with `internal`, and the caller opens the stored state again.
pub(crate) struct Guarded<T> {
    slot: Mutex<Slot<T>>,
    /// The thread that is inside the object now.
    #[cfg(not(target_arch = "wasm32"))]
    inside: Mutex<Option<std::thread::ThreadId>>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // A poisoned lock only says that a thread panicked while it held it. The slot's own flag says whether the
    // value may still be used, so the lock itself is taken either way.
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
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

    /// The lock on the slot, or the refusal of a call from inside the object.
    #[cfg(not(target_arch = "wasm32"))]
    fn enter(&self) -> Result<MutexGuard<'_, Slot<T>>, CoreError> {
        let me = std::thread::current().id();
        if *locked(&self.inside) == Some(me) {
            return Err(CoreError::internal(
                "the object was called from inside its own callback",
            ));
        }
        let slot = locked(&self.slot);
        *locked(&self.inside) = Some(me);
        Ok(slot)
    }

    /// In WebAssembly there is one thread: a lock that is taken can only be this caller's own.
    #[cfg(target_arch = "wasm32")]
    fn enter(&self) -> Result<MutexGuard<'_, Slot<T>>, CoreError> {
        self.slot
            .try_lock()
            .map_err(|_| CoreError::internal("the object was called from inside its own callback"))
    }

    fn leave(&self) {
        #[cfg(not(target_arch = "wasm32"))]
        {
            *locked(&self.inside) = None;
        }
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
        let mut slot = self.enter()?;
        let closed = slot.closed;
        let outcome = match (closed, slot.value.as_mut()) {
            (None, Some(value)) => catch_unwind(AssertUnwindSafe(|| call(value))),
            _ => Ok(Err(Self::refusal(closed))),
        };
        let result = outcome.unwrap_or_else(|_| {
            // The value stays where it is, unused: dropping half an operation could panic again.
            slot.closed = Some(Closed::Fault);
            Err(Self::refusal(Some(Closed::Fault)))
        });
        drop(slot);
        self.leave();
        result
    }

    /// Takes the value out for a call that ends the object, and runs `call` on it.
    pub(crate) fn finish<R>(
        &self,
        call: impl FnOnce(T) -> Result<R, CoreError>,
    ) -> Result<R, CoreError> {
        let mut slot = self.enter()?;
        let closed = slot.closed;
        let outcome = match (closed, slot.value.take()) {
            (None, Some(value)) => {
                slot.closed = Some(Closed::ByCaller);
                catch_unwind(AssertUnwindSafe(|| call(value)))
            }
            (_, value) => {
                slot.value = value;
                Ok(Err(Self::refusal(closed)))
            }
        };
        let result = outcome.unwrap_or_else(|_| {
            slot.closed = Some(Closed::Fault);
            Err(Self::refusal(Some(Closed::Fault)))
        });
        drop(slot);
        self.leave();
        result
    }

    /// Closes the object and drops what it holds. A call from inside the object itself closes nothing.
    pub(crate) fn close(&self) {
        let dropped = self.finish(|value| {
            drop(value);
            Ok(())
        });
        // An object that was closed already stays closed: nothing to report.
        let _ = dropped;
    }
}
