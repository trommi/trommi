//! Where a device's state lives. The core works on a copy in memory and hands the store every change of one
//! operation as one batch: the store's whole job is to make that batch durable, all of it or none.
//!
//! The entries are secret: they hold the device's private signature key and every group's secrets.
//!
//! One owner: a `Device` reads the store once, when it is opened, and from then on trusts its copy. Two devices open
//! on the same store (two tabs, the app and one of its extensions) overwrite each other's epochs, even if each write
//! is atomic. Whoever opens a device must hold the store exclusively for as long as the device lives, or open the
//! device anew for each operation under a lock (cheap: one read), or the store must refuse a batch that was not made
//! from its current revision. This proof builds none of the three.
//!
//! What an implementation needs:
//! - IndexedDB (web): `load` cannot be answered from IndexedDB inside a synchronous call. The page reads the object
//!   store once (async) before it builds the device and hands the entries in; `apply` queues the batch, and the page
//!   writes each queued batch in ONE readwrite transaction and awaits it before the bytes the operation returned leave
//!   the device; if that transaction fails, the device in memory is ahead of the disk and must be thrown away and
//!   loaded again. One owner per browser profile: a Web Lock held from before the load.
//! - SQLite (connector, or iOS): one table (key BLOB PRIMARY KEY, value BLOB) and a revision; `apply` is one
//!   transaction that checks the revision.
//! - A file (connector, iOS App Group): the whole map in one file, written to a temporary name, fsynced and renamed;
//!   a lock file (flock) held around open, operation and apply, with the device opened anew inside the lock, because
//!   the app and its extensions are separate processes.

use std::collections::HashMap;

/// A store failed. The text is for logs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreError(pub String);

pub trait StateStore {
    /// Everything stored, once, when the device is opened.
    fn load(&self) -> Result<Vec<(Vec<u8>, Vec<u8>)>, StoreError>;
    /// One operation's changes: all of them or none.
    fn apply(&mut self, put: Vec<(Vec<u8>, Vec<u8>)>, delete: Vec<Vec<u8>>) -> Result<(), StoreError>;
}

/// The store for tests and for a device that lives as long as its process.
#[derive(Default, Clone)]
pub struct MemoryStore {
    entries: HashMap<Vec<u8>, Vec<u8>>,
    /// How many batches were applied (a test can tell that an operation wrote once).
    pub batches: usize,
}

/// Never the entries: they are private keys.
impl std::fmt::Debug for MemoryStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "MemoryStore({} entries, {} batches)", self.entries.len(), self.batches)
    }
}

impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn from_entries(entries: Vec<(Vec<u8>, Vec<u8>)>) -> Self {
        Self { entries: entries.into_iter().collect(), batches: 0 }
    }
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

impl StateStore for MemoryStore {
    fn load(&self) -> Result<Vec<(Vec<u8>, Vec<u8>)>, StoreError> {
        Ok(self.entries.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
    }
    fn apply(&mut self, put: Vec<(Vec<u8>, Vec<u8>)>, delete: Vec<Vec<u8>>) -> Result<(), StoreError> {
        for key in delete {
            self.entries.remove(&key);
        }
        for (key, value) in put {
            self.entries.insert(key, value);
        }
        self.batches += 1;
        Ok(())
    }
}
