//! The device's store at the edge. The core computes and the platform stores (`trommi_core::store`): the host
//! implements two calls, and must keep the core's contract for them.
//!
//! - **All or nothing.** `apply` writes every entry of a [`StoreWrite`] and its deletions, or nothing.
//! - **Durable on return.** `apply` returns only once the write would survive a crash or a power cut.
//! - **The revision.** A store keeps one number beside its entries, 0 when empty. `apply` compares it with
//!   `expected_revision` and writes the entries and the number plus one in the same atomic step; when the number
//!   differs it writes nothing and answers with a conflict.
//! - **One owner.** One device object works on a stored state at a time: a lock held from before `load` until
//!   the device is closed (a file lock, a Web Lock). The revision is the check behind that lock. A device that
//!   meets a conflict is the owner no more and answers `storage` from then on; the state is opened again.
//!
//! The values are private keys. A store never logs them, and an error's text never holds one.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, PoisonError};
use trommi_core::crypto::Secret;
use trommi_core::store::{table, Batch, Entry, Loaded, Storage, StorageError};

record! {
    /// One stored entry. The store treats key and value as opaque; the value may be a private key.
    secret pub struct StoreEntry {
        /// The key.
        pub key: Vec<u8>,
        /// The value.
        pub value: Vec<u8>,
    }
}

record! {
    /// Everything a store holds.
    pub struct StoredState {
        /// How many writes were ever applied; 0 for an empty store.
        pub revision: u64,
        /// Every entry, in any order.
        pub entries: Vec<StoreEntry>,
    }
}

record! {
    /// The changes of one operation: applied together or not at all. The deletions come first, so a key that is
    /// both deleted and put ends up put; of two puts of one key the later counts.
    pub struct StoreWrite {
        /// The revision the device believes is stored. The write makes it this plus one.
        pub expected_revision: u64,
        /// Entries to write, replacing what is stored under their keys.
        pub put: Vec<StoreEntry>,
        /// Keys to remove; a key that is not stored is no error.
        pub delete: Vec<Vec<u8>>,
    }
}

impl From<Loaded> for StoredState {
    fn from(loaded: Loaded) -> Self {
        Self {
            revision: loaded.revision,
            entries: loaded
                .entries
                .iter()
                .map(|entry| StoreEntry {
                    key: entry.key.clone(),
                    value: entry.value.clone(),
                })
                .collect(),
        }
    }
}

impl From<StoredState> for Loaded {
    fn from(state: StoredState) -> Self {
        Self {
            revision: state.revision,
            entries: state
                .entries
                .into_iter()
                .map(|entry| Entry::new(entry.key, entry.value))
                .collect(),
        }
    }
}

impl StoreWrite {
    fn of(expected_revision: u64, batch: &Batch) -> Self {
        Self {
            expected_revision,
            put: batch
                .put
                .iter()
                .map(|entry| StoreEntry {
                    key: entry.key.clone(),
                    value: entry.value.clone(),
                })
                .collect(),
            delete: batch.delete.clone(),
        }
    }
}

/// Why a store written in Swift did not do what was asked. Nothing was written.
#[cfg(feature = "uniffi")]
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Error)]
pub enum StoreError {
    /// The stored revision is not the one the write names: another owner wrote to this state.
    Conflict,
    /// The platform's store failed. The text is for a log and holds no stored value.
    Failed {
        /// The platform's own words.
        message: String,
    },
}

#[cfg(feature = "uniffi")]
impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Conflict => f.write_str("another owner wrote to this state"),
            StoreError::Failed { message } => f.write_str(message),
        }
    }
}

#[cfg(feature = "uniffi")]
impl std::error::Error for StoreError {}

/// A Swift error of another type than [`StoreError`], thrown from the store: a failure like any other. Its own
/// description is not passed on: nothing says what it holds.
#[cfg(feature = "uniffi")]
impl From<uniffi::UnexpectedUniFFICallbackError> for StoreError {
    fn from(_: uniffi::UnexpectedUniFFICallbackError) -> Self {
        StoreError::Failed {
            message: "the store threw an error that is not a StoreError".to_owned(),
        }
    }
}

/// The store a host implements in Swift: a file or a database in the app's own container. The module
/// documentation states what must hold of it. Both calls are made on the thread that called the device, while
/// the device is locked: the store must not call the device back, and must not wait for another thread that
/// does.
#[cfg(feature = "uniffi")]
#[uniffi::export(with_foreign)]
pub trait CoreStore: Send + Sync {
    /// Everything stored and its revision. Called once, when the device is opened.
    fn load(&self) -> Result<StoredState, StoreError>;

    /// Applies all of `write` or none of it, and returns only once that is durable.
    fn apply(&self, write: StoreWrite) -> Result<(), StoreError>;

    /// The device lets the store go: it closed, failed for good, or could not be opened. The store releases
    /// its lock here, so that the stored state can be opened again. Called once, as the last call.
    fn close(&self);
}

/// The core's store over one written in Swift.
#[cfg(feature = "uniffi")]
pub(crate) struct ForeignStore(pub(crate) Arc<dyn CoreStore>);

#[cfg(feature = "uniffi")]
impl Drop for ForeignStore {
    /// The device that owned this store is gone: the store hears of it. A store that fails here has still
    /// been let go.
    fn drop(&mut self) {
        let store = std::sync::Arc::clone(&self.0);
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || store.close()));
    }
}

#[cfg(feature = "uniffi")]
impl From<StoreError> for StorageError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::Conflict => StorageError::Conflict,
            StoreError::Failed { message } => StorageError::Failed(message),
        }
    }
}

#[cfg(feature = "uniffi")]
impl Storage for ForeignStore {
    fn load(&mut self) -> Result<Loaded, StorageError> {
        Ok(self.0.load()?.into())
    }

    fn apply(&mut self, expected_revision: u64, batch: Batch) -> Result<(), StorageError> {
        Ok(self.0.apply(StoreWrite::of(expected_revision, &batch))?)
    }
}

/// The writes a device made that the page has not stored yet, oldest first.
#[cfg(feature = "js")]
pub(crate) type Writes = Arc<Mutex<Vec<StoreWrite>>>;

/// The core's store in a browser. The core is synchronous and IndexedDB is not, so the page reads everything
/// before the device is opened, and every `apply` only queues its write here. The JavaScript side takes the
/// queue after each call and writes it out, one transaction per write, before it lets the call's result reach
/// anyone; when a transaction fails it closes the device, whose memory is then ahead of what is stored.
#[cfg(feature = "js")]
pub(crate) struct QueueStore {
    loaded: Option<StoredState>,
    writes: Writes,
}

#[cfg(feature = "js")]
impl QueueStore {
    /// A store that holds `loaded`, and the queue it shares with its device.
    pub(crate) fn new(loaded: StoredState) -> (Self, Writes) {
        let writes = Writes::default();
        let store = Self {
            loaded: Some(loaded),
            writes: Arc::clone(&writes),
        };
        (store, writes)
    }
}

#[cfg(feature = "js")]
impl Storage for QueueStore {
    fn load(&mut self) -> Result<Loaded, StorageError> {
        self.loaded
            .take()
            .map(Loaded::from)
            .ok_or_else(|| StorageError::Failed("the store was loaded before".into()))
    }

    fn apply(&mut self, expected_revision: u64, batch: Batch) -> Result<(), StorageError> {
        self.writes
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(StoreWrite::of(expected_revision, &batch));
        Ok(())
    }
}

/// A store in memory, shared by every handle to it: for the self-test, where nothing is to outlive the call.
#[derive(Clone, Default)]
pub(crate) struct MemoryStore(Arc<Mutex<Content>>);

/// The revision and the entries.
type Content = (u64, BTreeMap<Vec<u8>, Vec<u8>>);

impl Storage for MemoryStore {
    fn load(&mut self) -> Result<Loaded, StorageError> {
        let content = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        Ok(Loaded {
            revision: content.0,
            entries: content
                .1
                .iter()
                .map(|(key, value)| Entry::new(key.clone(), value.clone()))
                .collect(),
        })
    }

    fn apply(&mut self, expected_revision: u64, batch: Batch) -> Result<(), StorageError> {
        let mut content = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if content.0 != expected_revision {
            return Err(StorageError::Conflict);
        }
        for key in &batch.delete {
            content.1.remove(key);
        }
        for entry in &batch.put {
            content.1.insert(entry.key.clone(), entry.value.clone());
        }
        content.0 = expected_revision.saturating_add(1);
        Ok(())
    }
}

/// The seed of the device's signature key, as the device's store holds it.
pub(crate) type Seed = Arc<Mutex<Option<Secret<32>>>>;

/// Any store as the one type a facade device is built on. It also notes the seed of the device's signature key
/// as it passes by, for the one thing the core's device does not do itself yet: signing the hub's challenge.
pub(crate) struct AnyStore {
    inner: Box<dyn Storage + Send>,
    seed: Seed,
}

impl AnyStore {
    /// `inner` as the facade's store, and where the seed will be found.
    pub(crate) fn new(inner: Box<dyn Storage + Send>) -> (Self, Seed) {
        let seed = Seed::default();
        let store = Self {
            inner,
            seed: Arc::clone(&seed),
        };
        (store, seed)
    }

    /// Keeps the seed if `key` is where the device stores it: table `DEVICE`, entry 0.
    fn note(&self, key: &[u8], value: &[u8]) {
        if key == [table::DEVICE, 0] {
            if let Ok(seed) = Secret::from_slice(value) {
                *self.seed.lock().unwrap_or_else(PoisonError::into_inner) = Some(seed);
            }
        }
    }
}

impl Storage for AnyStore {
    fn load(&mut self) -> Result<Loaded, StorageError> {
        let loaded = self.inner.load()?;
        for entry in &loaded.entries {
            self.note(&entry.key, &entry.value);
        }
        Ok(loaded)
    }

    fn apply(&mut self, expected_revision: u64, batch: Batch) -> Result<(), StorageError> {
        let seed = batch
            .put
            .iter()
            .rev()
            .find(|entry| entry.key == [table::DEVICE, 0])
            .map(|entry| entry.value.clone());
        self.inner.apply(expected_revision, batch)?;
        if let Some(seed) = seed {
            self.note(&[table::DEVICE, 0], &seed);
        }
        Ok(())
    }
}
