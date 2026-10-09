//! The connector's state on disk (spec/v2.md 13.1 to 13.4): one directory per installation, room, folder and slot,
//! mode 0700, files mode 0600, one process at a time.
//!
//! ```text
//! <dir>/lock         held with an exclusive OS lock for as long as the journal is open
//! <dir>/state.snap   everything, as of record number `seq`
//! <dir>/state.log    one record per write since then
//! ```
//!
//! **A write is one record**: `u32 length ‖ payload ‖ SHA-256(payload)`, appended and synced before the write
//! returns. A record is whole or absent: opening cuts a last record that is short or whose hash is wrong (a
//! crash while it was written; nothing was acknowledged for it), and refuses a damaged record that is followed
//! by another ([`StoreError::Damaged`]). When the log outgrows the snapshot, the state is written whole to a
//! temporary file, synced, renamed over the snapshot, and the log emptied; a crash in between leaves records the
//! snapshot already holds, which opening skips by their number.
//!
//! **Two kinds of entries, one record.** The core's entries are written by [`trommi_core::device::Device`] through
//! [`CoreStore`], the connector's own (what it knows of the board, its place in the hub's order) under keys that
//! start with [`SIDE`]. [`CoreStore::apply`] *stages* a batch; [`Journal::commit`] writes everything staged, the
//! core's batches and the connector's entries, as one record. So what the connector derived from an operation of
//! the core is stored with that operation or not at all. The price is the contract of `apply`, which asks for
//! durability on return: here a batch is durable when `commit` returns, and [`crate::vault::Vault`], the only
//! holder of the device, commits before anything of an operation leaves it (a tool's answer, a request to the
//! hub). A process that dies in between has done nothing.
//!
//! **One owner.** The lock file is locked before anything is read. The core's revision is kept beside the entries
//! and compared on every `apply`, as the core's `Storage` contract asks.
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use trommi_core::store::{Batch, Entry, Loaded, Storage, StorageError};
use zeroize::Zeroizing;

/// The first byte of every key of the connector's own entries. The core's tables are 0x01 to 0x0C.
pub const SIDE: u8 = 0xC0;

const SNAP_MAGIC: &[u8; 16] = b"TROMMI-STATE-02\n";
const SNAP_FILE: &str = "state.snap";
const LOG_FILE: &str = "state.log";
const LOCK_FILE: &str = "lock";
/// A record longer than this is not read: nothing the connector writes comes near it.
const MAX_RECORD_LEN: usize = 256 << 20;
/// The log is folded into the snapshot when it is longer than this and than the snapshot.
const COMPACT_ABOVE: u64 = 1 << 20;

/// Why the state could not be opened or written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    /// Another process holds the directory.
    Locked,
    /// The files do not read as a state: damaged, or written by a newer connector. The human reconnects the
    /// session; the connector never makes a new key by itself in a directory that holds something.
    Damaged(String),
    /// The file system failed.
    Io(String),
    /// An earlier write failed: what is in memory may be ahead of the files. The journal is opened again.
    Poisoned,
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Locked => f.write_str("another process holds this state"),
            StoreError::Damaged(what) => write!(f, "the stored state does not read: {what}"),
            StoreError::Io(what) => write!(f, "the state could not be written: {what}"),
            StoreError::Poisoned => f.write_str("an earlier write of the state failed"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<std::io::Error> for StoreError {
    fn from(error: std::io::Error) -> Self {
        StoreError::Io(error.to_string())
    }
}

impl From<StoreError> for crate::error::Fault {
    fn from(error: StoreError) -> Self {
        let code = match error {
            StoreError::Locked => "state-locked",
            StoreError::Damaged(_) => "state-damaged",
            StoreError::Io(_) | StoreError::Poisoned => "storage",
        };
        crate::error::Fault::new(code, error.to_string())
    }
}

type Entries = BTreeMap<Vec<u8>, Zeroizing<Vec<u8>>>;

/// One change of the stored entries.
enum Op {
    Put(Vec<u8>, Zeroizing<Vec<u8>>),
    Delete(Vec<u8>),
}

struct Inner {
    dir: PathBuf,
    /// Held locked until the journal is dropped.
    _lock: File,
    log: File,
    log_len: u64,
    snap_len: u64,
    entries: Entries,
    /// The number of the last record written.
    seq: u64,
    /// How many batches of the core were ever applied: its `Storage` revision.
    core_revision: u64,
    /// Changes not yet written, already visible to readers of this process.
    staged: Vec<Op>,
    staged_core_batches: u64,
    poisoned: bool,
}

/// The open state of one slot. Cloning gives another handle on the same state.
#[derive(Clone)]
pub struct Journal {
    inner: Arc<Mutex<Inner>>,
}

impl std::fmt::Debug for Journal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Journal")
    }
}

fn private_file(path: &Path, truncate: bool) -> std::io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(truncate)
        .mode(0o600)
        .open(path)?;
    // The mode of a file that was there already is put right too.
    file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    Ok(file)
}

fn sync_dir(dir: &Path) -> std::io::Result<()> {
    File::open(dir)?.sync_all()
}

fn put_u32(out: &mut Vec<u8>, value: usize) {
    out.extend_from_slice(&(value as u32).to_le_bytes());
}

fn put_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
    put_u32(out, bytes.len());
    out.extend_from_slice(bytes);
}

/// Reads the fields of a record or a snapshot; every read is bounds-checked.
struct Fields<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Fields<'a> {
    fn take(&mut self, len: usize) -> Option<&'a [u8]> {
        let end = self.at.checked_add(len)?;
        let out = self.bytes.get(self.at..end)?;
        self.at = end;
        Some(out)
    }
    fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|b| b[0])
    }
    fn u32(&mut self) -> Option<usize> {
        self.take(4)
            .and_then(|b| b.try_into().ok())
            .map(|b| u32::from_le_bytes(b) as usize)
    }
    fn u64(&mut self) -> Option<u64> {
        self.take(8)
            .and_then(|b| b.try_into().ok())
            .map(u64::from_le_bytes)
    }
    fn bytes(&mut self) -> Option<&'a [u8]> {
        let len = self.u32()?;
        self.take(len)
    }
    fn done(&self) -> bool {
        self.at == self.bytes.len()
    }
}

/// A record's payload: `u64 seq ‖ u64 core batches ‖ u32 count ‖ (u8 op ‖ key ‖ [value])…`.
fn encode_record(seq: u64, core_batches: u64, ops: &[Op]) -> Zeroizing<Vec<u8>> {
    let mut out = Zeroizing::new(Vec::new());
    out.extend_from_slice(&seq.to_le_bytes());
    out.extend_from_slice(&core_batches.to_le_bytes());
    put_u32(&mut out, ops.len());
    for op in ops {
        match op {
            Op::Put(key, value) => {
                out.push(1);
                put_bytes(&mut out, key);
                put_bytes(&mut out, value);
            }
            Op::Delete(key) => {
                out.push(0);
                put_bytes(&mut out, key);
            }
        }
    }
    out
}

fn decode_record(payload: &[u8]) -> Option<(u64, u64, Vec<Op>)> {
    let mut fields = Fields {
        bytes: payload,
        at: 0,
    };
    let seq = fields.u64()?;
    let core_batches = fields.u64()?;
    let count = fields.u32()?;
    let mut ops = Vec::new();
    for _ in 0..count {
        ops.push(match fields.u8()? {
            1 => {
                let key = fields.bytes()?.to_vec();
                Op::Put(key, Zeroizing::new(fields.bytes()?.to_vec()))
            }
            0 => Op::Delete(fields.bytes()?.to_vec()),
            _ => return None,
        });
    }
    fields.done().then_some((seq, core_batches, ops))
}

fn apply_ops(entries: &mut Entries, ops: Vec<Op>) {
    for op in ops {
        match op {
            Op::Put(key, value) => {
                entries.insert(key, value);
            }
            Op::Delete(key) => {
                entries.remove(&key);
            }
        }
    }
}

/// The snapshot: magic ‖ `u64 seq ‖ u64 core revision ‖ u32 count ‖ (key ‖ value)…` ‖ SHA-256 of all before.
fn encode_snapshot(seq: u64, core_revision: u64, entries: &Entries) -> Zeroizing<Vec<u8>> {
    let mut out = Zeroizing::new(SNAP_MAGIC.to_vec());
    out.extend_from_slice(&seq.to_le_bytes());
    out.extend_from_slice(&core_revision.to_le_bytes());
    put_u32(&mut out, entries.len());
    for (key, value) in entries {
        put_bytes(&mut out, key);
        put_bytes(&mut out, value);
    }
    let hash = crate::util::sha256(&out);
    out.extend_from_slice(&hash);
    out
}

fn decode_snapshot(bytes: &[u8]) -> Result<(u64, u64, Entries), StoreError> {
    let damaged = |what: &str| StoreError::Damaged(format!("{SNAP_FILE}: {what}"));
    if bytes.len() < SNAP_MAGIC.len() + 32 {
        return Err(damaged("too short"));
    }
    if &bytes[..SNAP_MAGIC.len()] != SNAP_MAGIC {
        return Err(damaged(
            "not a state of this connector version (a newer connector wrote it, or it is damaged)",
        ));
    }
    let (body, hash) = bytes.split_at(bytes.len() - 32);
    if crate::util::sha256(body) != hash {
        return Err(damaged("its checksum is wrong"));
    }
    let mut fields = Fields {
        bytes: body,
        at: SNAP_MAGIC.len(),
    };
    let mut read = || -> Option<(u64, u64, Entries)> {
        let seq = fields.u64()?;
        let core_revision = fields.u64()?;
        let count = fields.u32()?;
        let mut entries = Entries::new();
        for _ in 0..count {
            let key = fields.bytes()?.to_vec();
            entries.insert(key, Zeroizing::new(fields.bytes()?.to_vec()));
        }
        fields.done().then_some((seq, core_revision, entries))
    };
    read().ok_or_else(|| damaged("its entries do not read"))
}

impl Journal {
    /// Opens the state in `dir`, creating the directory and empty files if there is nothing. Takes the lock first:
    /// [`StoreError::Locked`] while another process holds it.
    pub fn open(dir: &Path) -> Result<Journal, StoreError> {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        let lock = private_file(&dir.join(LOCK_FILE), false)?;
        match lock.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => return Err(StoreError::Locked),
            Err(std::fs::TryLockError::Error(error)) => return Err(error.into()),
        }
        // A snapshot that was being written when the process died was never the state.
        let _ = std::fs::remove_file(dir.join(format!("{SNAP_FILE}.tmp")));

        let (mut seq, mut core_revision, mut entries, snap_len) =
            match std::fs::read(dir.join(SNAP_FILE)) {
                Ok(bytes) => {
                    let bytes = Zeroizing::new(bytes);
                    let (seq, revision, entries) = decode_snapshot(&bytes)?;
                    (seq, revision, entries, bytes.len() as u64)
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    (0, 0, Entries::new(), 0)
                }
                Err(error) => return Err(error.into()),
            };

        let mut log = private_file(&dir.join(LOG_FILE), false)?;
        let mut bytes = Zeroizing::new(Vec::new());
        log.read_to_end(&mut bytes)?;
        let mut at = 0usize;
        // Where the last whole record ends: everything after it is a write that never finished.
        let mut good = 0usize;
        while at < bytes.len() {
            let header = bytes.get(at..at + 4).and_then(|b| b.try_into().ok());
            let Some(len) = header.map(|b: [u8; 4]| u32::from_le_bytes(b) as usize) else {
                break;
            };
            let end = at
                .checked_add(4 + 32)
                .and_then(|n| n.checked_add(len))
                .filter(|_| len <= MAX_RECORD_LEN);
            let Some(end) = end.filter(|end| *end <= bytes.len()) else {
                break;
            };
            let payload = &bytes[at + 4..at + 4 + len];
            let record = (crate::util::sha256(payload) == bytes[at + 4 + len..end])
                .then(|| decode_record(payload))
                .flatten();
            let Some((record_seq, core_batches, ops)) = record else {
                if end == bytes.len() {
                    break;
                }
                return Err(StoreError::Damaged(format!(
                    "{LOG_FILE}: a record in the middle is damaged"
                )));
            };
            if record_seq > seq {
                if record_seq != seq + 1 {
                    return Err(StoreError::Damaged(format!(
                        "{LOG_FILE}: record {record_seq} follows record {seq}"
                    )));
                }
                apply_ops(&mut entries, ops);
                seq = record_seq;
                core_revision += core_batches;
            }
            at = end;
            good = end;
        }
        if good < bytes.len() {
            log.set_len(good as u64)?;
            log.sync_all()?;
        }
        log.seek(SeekFrom::End(0))?;
        sync_dir(dir)?;
        Ok(Journal {
            inner: Arc::new(Mutex::new(Inner {
                dir: dir.to_path_buf(),
                _lock: lock,
                log,
                log_len: good as u64,
                snap_len,
                entries,
                seq,
                core_revision,
                staged: Vec::new(),
                staged_core_batches: 0,
                poisoned: false,
            })),
        })
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // A panic while the lock was held leaves the data as it was: every change is one assignment.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The directory.
    pub fn dir(&self) -> PathBuf {
        self.lock().dir.clone()
    }

    /// Whether nothing is stored: a slot that never held a device.
    pub fn is_empty(&self) -> bool {
        self.lock().entries.is_empty()
    }

    /// The handle the core's device writes through. One device per journal.
    pub fn core_store(&self) -> CoreStore {
        CoreStore {
            journal: self.clone(),
        }
    }

    /// The value under `key`, staged changes included.
    pub fn get(&self, key: &[u8]) -> Option<Zeroizing<Vec<u8>>> {
        self.lock().entries.get(key).cloned()
    }

    /// Every entry of the connector's own whose key starts with `prefix`, in key order.
    pub fn scan(&self, prefix: &[u8]) -> Vec<(Vec<u8>, Zeroizing<Vec<u8>>)> {
        self.lock()
            .entries
            .range(prefix.to_vec()..)
            .take_while(|(key, _)| key.starts_with(prefix))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect()
    }

    /// Stages an entry of the connector's own; written by the next [`Journal::commit`].
    pub fn put(&self, key: Vec<u8>, value: Vec<u8>) {
        debug_assert_eq!(key.first(), Some(&SIDE));
        let mut inner = self.lock();
        let value = Zeroizing::new(value);
        inner.entries.insert(key.clone(), value.clone());
        inner.staged.push(Op::Put(key, value));
    }

    /// Stages the removal of an entry of the connector's own.
    pub fn delete(&self, key: Vec<u8>) {
        debug_assert_eq!(key.first(), Some(&SIDE));
        let mut inner = self.lock();
        inner.entries.remove(&key);
        inner.staged.push(Op::Delete(key));
    }

    /// Whether anything is staged and not yet written.
    pub fn is_dirty(&self) -> bool {
        !self.lock().staged.is_empty()
    }

    /// Writes everything staged as one record and returns once it is on disk. After a failure the journal is
    /// poisoned: memory may be ahead of the files, and the caller drops the device and opens the state again.
    pub fn commit(&self) -> Result<(), StoreError> {
        let mut inner = self.lock();
        if inner.poisoned {
            return Err(StoreError::Poisoned);
        }
        if inner.staged.is_empty() {
            return Ok(());
        }
        let payload = encode_record(inner.seq + 1, inner.staged_core_batches, &inner.staged);
        let mut record = Zeroizing::new(Vec::with_capacity(payload.len() + 36));
        put_u32(&mut record, payload.len());
        record.extend_from_slice(&payload);
        record.extend_from_slice(&crate::util::sha256(&payload));
        let written = inner
            .log
            .write_all(&record)
            .and_then(|()| inner.log.sync_data());
        if let Err(error) = written {
            inner.poisoned = true;
            return Err(error.into());
        }
        inner.seq += 1;
        inner.core_revision += inner.staged_core_batches;
        inner.staged_core_batches = 0;
        inner.staged.clear();
        inner.log_len += record.len() as u64;
        if inner.log_len > COMPACT_ABOVE.max(inner.snap_len) {
            // The record is safe; a snapshot that cannot be written only leaves the log longer.
            if let Err(error) = compact(&mut inner) {
                eprintln!("[trommi] the state's log was not folded into its snapshot: {error}");
            }
        }
        Ok(())
    }

    /// Removes the state for good: a device that is out of its session keeps nothing (13.5). The lock is held
    /// until this handle and its clones are dropped.
    pub fn wipe(&self) -> Result<(), StoreError> {
        let mut inner = self.lock();
        inner.poisoned = true;
        inner.entries.clear();
        inner.staged.clear();
        inner.log.set_len(0)?;
        inner.log.sync_all()?;
        for name in [SNAP_FILE, LOG_FILE] {
            match std::fs::remove_file(inner.dir.join(name)) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    return Err(error.into())
                }
                _ => {}
            }
        }
        sync_dir(&inner.dir)?;
        Ok(())
    }
}

fn compact(inner: &mut Inner) -> std::io::Result<()> {
    let snapshot = encode_snapshot(inner.seq, inner.core_revision, &inner.entries);
    let tmp = inner.dir.join(format!("{SNAP_FILE}.tmp"));
    let mut file = private_file(&tmp, true)?;
    file.write_all(&snapshot)?;
    file.sync_all()?;
    std::fs::rename(&tmp, inner.dir.join(SNAP_FILE))?;
    sync_dir(&inner.dir)?;
    // From here the snapshot holds every record of the log; a crash before the next line leaves them to be skipped.
    inner.log.set_len(0)?;
    inner.log.seek(SeekFrom::Start(0))?;
    inner.log.sync_all()?;
    inner.snap_len = snapshot.len() as u64;
    inner.log_len = 0;
    Ok(())
}

/// The core's view of the journal: its own entries and its revision.
pub struct CoreStore {
    journal: Journal,
}

impl Storage for CoreStore {
    fn load(&mut self) -> Result<Loaded, StorageError> {
        let inner = self.journal.lock();
        if inner.poisoned {
            return Err(StorageError::Failed(StoreError::Poisoned.to_string()));
        }
        Ok(Loaded {
            revision: inner.core_revision + inner.staged_core_batches,
            entries: inner
                .entries
                .iter()
                .filter(|(key, _)| key.first() != Some(&SIDE))
                .map(|(key, value)| Entry::new(key.clone(), value.to_vec()))
                .collect(),
        })
    }

    /// Stages the batch; see the module's documentation for when it is durable.
    fn apply(&mut self, expected_revision: u64, batch: Batch) -> Result<(), StorageError> {
        let mut inner = self.journal.lock();
        if inner.poisoned {
            return Err(StorageError::Failed(StoreError::Poisoned.to_string()));
        }
        if expected_revision != inner.core_revision + inner.staged_core_batches {
            return Err(StorageError::Conflict);
        }
        if batch
            .put
            .iter()
            .map(|entry| &entry.key)
            .chain(&batch.delete)
            .any(|key| key.first() == Some(&SIDE))
        {
            return Err(StorageError::Failed(
                "a key of the connector's own table".into(),
            ));
        }
        for key in &batch.delete {
            inner.entries.remove(key);
            inner.staged.push(Op::Delete(key.clone()));
        }
        for entry in &batch.put {
            let value = Zeroizing::new(entry.value.clone());
            inner.entries.insert(entry.key.clone(), value.clone());
            inner.staged.push(Op::Put(entry.key.clone(), value));
        }
        inner.staged_core_batches += 1;
        Ok(())
    }
}
