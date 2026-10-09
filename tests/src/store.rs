//! A store in memory with planned failures, for the tests: it implements the core's `Storage` contract (whole
//! batches, the revision check) and lets a test play a failing write, a crash and a second owner.

use std::collections::BTreeMap;
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use trommi_core::store::{Batch, Entry, Loaded, Storage, StorageError};

#[derive(Default)]
struct Content {
    revision: u64,
    entries: BTreeMap<Vec<u8>, Vec<u8>>,
    /// How many more calls of `apply` pass before one fails; none when no failure is planned.
    passes_before_failure: Option<u64>,
    applied: u64,
}

/// A store in memory, for tests: durable is what `apply` accepted. A crash is played by dropping the device and
/// opening a new one on [`MemoryStorage::reopened`]; a second owner by [`MemoryStorage::handle`].
#[derive(Default)]
pub struct MemoryStorage {
    content: Arc<Mutex<Content>>,
}

impl MemoryStorage {
    /// An empty store at revision 0.
    pub fn new() -> Self {
        Self::default()
    }

    fn content(&self) -> MutexGuard<'_, Content> {
        // A panic of another test thread while it held the lock leaves the content as it was: still usable.
        self.content.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The same store once more: what a second owner would hold, and a test's view of what a device wrote.
    pub fn handle(&self) -> Self {
        Self {
            content: Arc::clone(&self.content),
        }
    }

    /// A separate store holding what is durable here now, with no failure planned: what a restart finds.
    pub fn reopened(&self) -> Self {
        let content = self.content();
        Self {
            content: Arc::new(Mutex::new(Content {
                revision: content.revision,
                entries: content.entries.clone(),
                passes_before_failure: None,
                applied: 0,
            })),
        }
    }

    /// Makes the `nth` call of `apply` from now fail (1 is the next one), writing nothing.
    pub fn fail_apply(&self, nth: u64) {
        self.content().passes_before_failure = nth.checked_sub(1);
    }

    /// The stored revision.
    pub fn revision(&self) -> u64 {
        self.content().revision
    }

    /// How many batches this store accepted since it was made.
    pub fn applied(&self) -> u64 {
        self.content().applied
    }

    /// Every entry, ascending by key.
    pub fn entries(&self) -> Vec<Entry> {
        let content = self.content();
        content
            .entries
            .iter()
            .map(|(key, value)| Entry::new(key.clone(), value.clone()))
            .collect()
    }

    /// The value under `key`.
    pub fn get(&self, key: &[u8]) -> Option<Vec<u8>> {
        self.content().entries.get(key).cloned()
    }
}

impl fmt::Debug for MemoryStorage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let content = self.content();
        write!(
            f,
            "MemoryStorage(revision {}, {} entries)",
            content.revision,
            content.entries.len()
        )
    }
}

impl Storage for MemoryStorage {
    fn load(&mut self) -> Result<Loaded, StorageError> {
        Ok(Loaded {
            revision: self.revision(),
            entries: self.entries(),
        })
    }

    fn apply(&mut self, expected_revision: u64, mut batch: Batch) -> Result<(), StorageError> {
        let mut content = self.content();
        match content.passes_before_failure {
            Some(0) => {
                content.passes_before_failure = None;
                return Err(StorageError::Failed("planned failure".into()));
            }
            Some(passes) => content.passes_before_failure = Some(passes.saturating_sub(1)),
            None => {}
        }
        if content.revision != expected_revision {
            return Err(StorageError::Conflict);
        }
        let next = expected_revision
            .checked_add(1)
            .ok_or_else(|| StorageError::Failed("the revision is at its maximum".into()))?;
        for key in batch.delete.drain(..) {
            content.entries.remove(&key);
        }
        for entry in batch.put.iter_mut() {
            content.entries.insert(
                std::mem::take(&mut entry.key),
                std::mem::take(&mut entry.value),
            );
        }
        content.revision = next;
        content.applied = content.applied.saturating_add(1);
        Ok(())
    }
}
