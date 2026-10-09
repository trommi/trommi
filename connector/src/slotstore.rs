//! A slot's state as the connector's shell sees it: the journal (`store.rs`), opened under the slot's claim, and
//! the few values of the shell's own that live in it (the bridge's state, what waited for another session).
use crate::client::{room_record, Client, RoomRecord};
use crate::error::Result;
use crate::store::Journal;
use crate::vault::side_key;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

/// The marker a keyed slot's key file holds. The device's key itself is in the slot's state (13.1).
pub const KEY_MARKER: &str = "trommi-state v2\n";

/// The open state of one slot.
pub struct SlotStore {
    journal: Journal,
    /// The client at work on this state, once there is one: from then on it alone commits.
    client: Mutex<Weak<Client>>,
    /// Values set and not yet written, by name: a writer takes whatever is newest when its turn comes, so an
    /// older value never lands after a newer one.
    waiting: Arc<Mutex<std::collections::BTreeMap<String, Value>>>,
}

/// Where a slot's state lives: beside its key file, `<name>.state/`.
pub fn state_dir(key_file: &Path) -> PathBuf {
    key_file.with_extension("state")
}

impl SlotStore {
    /// Opens the state beside `key_file`, taking its lock. `state-locked` while another process holds it.
    pub fn open(key_file: &Path) -> Result<Arc<SlotStore>> {
        Ok(Arc::new(SlotStore {
            journal: Journal::open(&state_dir(key_file))?,
            client: Mutex::new(Weak::new()),
            waiting: Arc::new(Mutex::new(Default::default())),
        }))
    }

    /// The journal.
    pub fn journal(&self) -> &Journal {
        &self.journal
    }

    /// The room this slot was joined to, if it was.
    pub fn room(&self) -> Option<RoomRecord> {
        room_record(&self.journal)
    }

    /// Names the client that works on this state now.
    pub fn attach(&self, client: &Arc<Client>) {
        *self.client.lock().unwrap_or_else(|e| e.into_inner()) = Arc::downgrade(client);
    }

    /// A value of the shell's own.
    pub fn get(&self, name: &str) -> Option<Value> {
        self.journal
            .get(&side_key(b'k', &[name.as_bytes()]))
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    }

    /// Stores a value of the shell's own. With a client at work it is written by the client, between two of
    /// its steps, so that no step of it is ever written half.
    pub fn set(&self, name: &str, value: Value) {
        let client = self
            .client
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .upgrade();
        match client {
            Some(client) => {
                self.waiting
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(name.to_string(), value);
                let waiting = self.waiting.clone();
                tokio::spawn(async move {
                    let mut core = client.core.lock().await;
                    let newest =
                        std::mem::take(&mut *waiting.lock().unwrap_or_else(|e| e.into_inner()));
                    if newest.is_empty() {
                        return;
                    }
                    for (name, value) in &newest {
                        core.kv_set(name, value);
                    }
                    if let Err(fault) = core.commit() {
                        eprintln!("[trommi] state not written: {}", fault.code);
                    }
                });
            }
            None => {
                self.journal.put(
                    side_key(b'k', &[name.as_bytes()]),
                    value.to_string().into_bytes(),
                );
                if let Err(error) = self.journal.commit() {
                    eprintln!("[trommi] state not written: {error}");
                }
            }
        }
    }
}
