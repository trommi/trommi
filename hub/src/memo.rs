//! Expensive public-key work is done outside the database's one write lock. A request first computes what its
//! transaction will need (verifying a Commit on a group's public state, importing a GroupInfo, validating a
//! KeyPackage) on a bounded pool, into a `Memo`. Inside the transaction the same calls are answered from the memo
//! and never computed: if the state the work was done on has changed meanwhile, the call finds nothing and the
//! request is answered "try again" (`overloaded`), having held the lock for a moment only.
//!
//! A recovery keeps the memo of each of its parts beside the part, so that publishing it replays writes, not
//! cryptography.

use std::collections::HashMap;
use std::sync::{Condvar, Mutex};

use sha2::{Digest, Sha256};

use crate::error::{refuse, Refused};
use crate::observer::{
    CommitFacts, Device, GroupState, KeyPackageFacts, Observer, Refusal, Snapshot,
};
use crate::wire::{Reader, Writer};

pub type Key = [u8; 32];

#[derive(Debug, Clone)]
pub enum Entry {
    Opened(GroupState, Snapshot, Device),
    Committed(GroupState, Box<CommitFacts>),
    Checked,
    KeyPackage(KeyPackageFacts),
    Refused(Refusal),
}

fn key(tag: u8, parts: &[&[u8]]) -> Key {
    let mut h = Sha256::new();
    h.update([tag]);
    for p in parts {
        h.update((p.len() as u64).to_be_bytes());
        h.update(p);
    }
    h.finalize().into()
}

pub fn commit_key(state: &GroupState, commit: &[u8]) -> Key {
    key(2, &[&state.0, commit])
}

impl Entry {
    /// For a recovery's stored parts: the outcome of a Commit or of a GroupInfo check.
    pub fn encode(&self) -> Option<Vec<u8>> {
        let mut w = Writer::default();
        match self {
            Entry::Committed(state, facts) => {
                w.u8(1).vec(&state.0).raw(&serde_json::to_vec(facts).ok()?);
            }
            Entry::Checked => {
                w.u8(2);
            }
            Entry::Refused(r) => {
                w.u8(3).raw(&serde_json::to_vec(r).ok()?);
            }
            _ => return None,
        }
        Some(w.0)
    }

    pub fn decode(bytes: &[u8]) -> Option<Entry> {
        let mut r = Reader::new(bytes);
        match r.u8().ok()? {
            1 => {
                let state = GroupState(r.vec().ok()?.to_vec());
                Some(Entry::Committed(
                    state,
                    Box::new(serde_json::from_slice(&bytes[r.position()..]).ok()?),
                ))
            }
            2 => Some(Entry::Checked),
            3 => Some(Entry::Refused(serde_json::from_slice(&bytes[1..]).ok()?)),
            _ => None,
        }
    }
}

type Lookup<'a> = Box<dyn Fn(&Key) -> Option<Vec<u8>> + 'a>;

pub struct Memo<'a> {
    inner: &'a dyn Observer,
    /// inside a transaction: answer from what was prepared, never compute
    strict: bool,
    held: Mutex<HashMap<Key, Entry>>,
    /// the stored entries of a recovery's parts
    lookup: Option<Lookup<'a>>,
}

impl<'a> Memo<'a> {
    /// Outside a transaction: computes and remembers.
    pub fn preparing(inner: &'a dyn Observer) -> Self {
        Memo {
            inner,
            strict: false,
            held: Mutex::new(HashMap::new()),
            lookup: None,
        }
    }

    /// Inside a transaction: only what was prepared.
    pub fn prepared(
        inner: &'a dyn Observer,
        entries: HashMap<Key, Entry>,
        lookup: Option<Lookup<'a>>,
    ) -> Self {
        Memo {
            inner,
            strict: true,
            held: Mutex::new(entries),
            lookup,
        }
    }

    pub fn into_entries(self) -> HashMap<Key, Entry> {
        self.held.into_inner().unwrap_or_else(|e| e.into_inner())
    }

    pub fn entries(&self) -> HashMap<Key, Entry> {
        self.held.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn get(&self, k: &Key) -> Option<Entry> {
        if let Some(e) = self.held.lock().unwrap_or_else(|e| e.into_inner()).get(k) {
            return Some(e.clone());
        }
        self.lookup
            .as_ref()
            .and_then(|f| f(k))
            .and_then(|bytes| Entry::decode(&bytes))
    }

    fn resolve(&self, k: Key, compute: impl FnOnce() -> Entry) -> Result<Entry, Refusal> {
        if let Some(e) = self.get(&k) {
            return Ok(e);
        }
        if self.strict {
            return Err(Refusal::Busy);
        }
        let e = compute();
        self.held
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(k, e.clone());
        Ok(e)
    }
}

impl Observer for Memo<'_> {
    fn open(&self, group_info: &[u8]) -> Result<(GroupState, Snapshot, Device), Refusal> {
        let e = self.resolve(key(1, &[group_info]), || {
            match self.inner.open(group_info) {
                Ok((state, snapshot, signer)) => Entry::Opened(state, snapshot, signer),
                Err(r) => Entry::Refused(r),
            }
        })?;
        match e {
            Entry::Opened(a, b, c) => Ok((a, b, c)),
            Entry::Refused(r) => Err(r),
            _ => Err(Refusal::Busy),
        }
    }

    fn commit(
        &self,
        state: &GroupState,
        commit: &[u8],
    ) -> Result<(GroupState, CommitFacts), Refusal> {
        let e = self.resolve(commit_key(state, commit), || {
            match self.inner.commit(state, commit) {
                Ok((state, facts)) => Entry::Committed(state, Box::new(facts)),
                Err(r) => Entry::Refused(r),
            }
        })?;
        match e {
            Entry::Committed(state, facts) => Ok((state, *facts)),
            Entry::Refused(r) => Err(r),
            _ => Err(Refusal::Busy),
        }
    }

    fn check_group_info(
        &self,
        group_info: &[u8],
        expected: &Snapshot,
        signer: &Device,
    ) -> Result<(), Refusal> {
        let k = key(
            3,
            &[
                group_info,
                &expected.context,
                &expected.confirmation_tag,
                &expected.leaves.concat(),
                signer,
            ],
        );
        let e = self.resolve(k, || {
            match self.inner.check_group_info(group_info, expected, signer) {
                Ok(()) => Entry::Checked,
                Err(r) => Entry::Refused(r),
            }
        })?;
        match e {
            Entry::Checked => Ok(()),
            Entry::Refused(r) => Err(r),
            _ => Err(Refusal::Busy),
        }
    }

    fn key_package(&self, bytes: &[u8]) -> Result<KeyPackageFacts, Refusal> {
        let e = self.resolve(key(4, &[bytes]), || match self.inner.key_package(bytes) {
            Ok(facts) => Entry::KeyPackage(facts),
            Err(r) => Entry::Refused(r),
        })?;
        match e {
            Entry::KeyPackage(f) => Ok(f),
            Entry::Refused(r) => Err(r),
            _ => Err(Refusal::Busy),
        }
    }

    // parsing and one signature check: cheap, done where they are asked for
    fn welcome_receivers(&self, welcome: &[u8]) -> Result<Vec<Vec<u8>>, Refusal> {
        self.inner.welcome_receivers(welcome)
    }
    fn application_message(&self, bytes: &[u8]) -> Result<(Vec<u8>, u64), Refusal> {
        self.inner.application_message(bytes)
    }
    fn verify(&self, key: &[u8], label: &str, content: &[u8], signature: &[u8]) -> bool {
        self.inner.verify(key, label, content, signature)
    }
}

/// The bounded pool for expensive work: so many at a time, so many waiting, the rest is told to come back.
pub struct Gate {
    state: Mutex<(usize, usize)>,
    freed: Condvar,
    permits: usize,
    waiting: usize,
}

pub struct Permit<'a>(&'a Gate);

impl Gate {
    pub fn new(permits: usize, waiting: usize) -> Self {
        Gate {
            state: Mutex::new((0, 0)),
            freed: Condvar::new(),
            permits: permits.max(1),
            waiting,
        }
    }

    /// A place in the pool; waits for one if the queue has room, else `overloaded`.
    pub fn enter(&self) -> Result<Permit<'_>, Refused> {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if s.0 >= self.permits {
            if s.1 >= self.waiting {
                return Err(
                    refuse("overloaded", "the hub is busy: try again in a moment").retry(1),
                );
            }
            s.1 += 1;
            while s.0 >= self.permits {
                s = self.freed.wait(s).unwrap_or_else(|e| e.into_inner());
            }
            s.1 -= 1;
        }
        s.0 += 1;
        Ok(Permit(self))
    }

    /// (at work, waiting)
    pub fn load(&self) -> (usize, usize) {
        *self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        let mut s = self.0.state.lock().unwrap_or_else(|e| e.into_inner());
        s.0 -= 1;
        drop(s);
        self.0.freed.notify_one();
    }
}
