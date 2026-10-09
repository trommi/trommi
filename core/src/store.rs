//! Where a device's state lives, and what must hold of it (section 13.2).
//!
//! The core computes; the platform stores. A device reads everything once ([`Storage::load`]) and from then on
//! writes one [`Batch`] per operation ([`Storage::apply`]).
//!
//! **Durable and whole.** `apply` writes all of a batch or none of it, and returns only once it would survive a
//! crash or a power cut. A batch holds the state an operation leaves behind together with every byte string that
//! operation wants sent, as outbox entries: nothing leaves a device that is not stored with the state it implies.
//! When `apply` fails, the device puts its memory back to what is stored.
//!
//! **One owner.** Exactly one device object works on a stored state at a time: a process lock on the directory, a
//! Web Lock in a browser. Two owners would sign two different items under one number. The revision is the check
//! behind the lock: a store keeps one number beside its entries, 0 when empty. `load` returns it, every `apply`
//! names the revision the device believes is stored, and the store refuses with [`StorageError::Conflict`] when its
//! own differs; otherwise it writes the batch and the revision plus one in the same atomic step. A device that
//! meets a conflict is no longer the owner and stops. A store that cannot compare and write in one atomic step
//! holds its exclusive lock from before `load` until it is dropped instead, and still keeps the number.
//!
//! **Untrusted.** What a store returns is input like any other: an entry that does not decode is
//! `Error::Storage`, never a panic.
//!
//! # Keys
//!
//! The first byte of a key names its table ([`table`]); the bytes after it are that table's own, of a fixed layout
//! per table so that no key is the start of another. A store treats keys as opaque.
//!
//! # Outbox
//!
//! An [`OutboxEntry`] is one request to the hub, in the exact bytes of its parts. Entries are sent in the order of
//! their ids and stay stored until the hub's answer was applied, so a retry after a crash sends the same bytes.

use crate::codec::{self, Decode, Encode, Opaque, Reader, Writer};
use crate::error::Error;
use crate::ids::GroupId;
use std::fmt;
use zeroize::Zeroize;

/// The first byte of every key: which kind of state the entry holds.
pub mod table {
    /// The device itself: its signature key, its room, its cursor in the hub's order, its counters.
    pub const DEVICE: u8 = 0x01;
    /// OpenMLS's own entries (groups, trees, key packages' private parts, pending commits).
    pub const MLS: u8 = 0x02;
    /// Content keys, per group and epoch.
    pub const CONTENT_KEY: u8 = 0x03;
    /// The room group as an observer follows it, and the roles per room epoch.
    pub const ROOM_STATE: u8 = 0x04;
    /// Envelope chains, per group and sender.
    pub const CHAIN: u8 = 0x05;
    /// Object states.
    pub const OBJECT: u8 = 0x06;
    /// Register values and the lamport clock.
    pub const REGISTER: u8 = 0x07;
    /// Commands an agent device recorded before acting.
    pub const COMMAND: u8 = 0x08;
    /// What is to be sent: [`super::OutboxEntry`], under [`super::outbox_key`].
    pub const OUTBOX: u8 = 0x09;
    /// Recovery: the mac key, sealed keys still to post.
    pub const RECOVERY: u8 = 0x0A;
    /// Open invites.
    pub const INVITE: u8 = 0x0B;
    /// Board frontiers and snapshots applied.
    pub const BOARD: u8 = 0x0C;
}

/// A key: the table's byte, then `parts` one after another.
pub fn key(table: u8, parts: &[&[u8]]) -> Vec<u8> {
    let mut key = vec![table];
    for part in parts {
        key.extend_from_slice(part);
    }
    key
}

/// One stored entry. The value may be a private key: it is wiped when the entry is dropped and never printed.
#[derive(Clone, PartialEq, Eq)]
pub struct Entry {
    /// The key: a table byte and that table's own bytes.
    pub key: Vec<u8>,
    /// The value.
    pub value: Vec<u8>,
}

impl Entry {
    /// An entry.
    pub fn new(key: Vec<u8>, value: Vec<u8>) -> Self {
        Self { key, value }
    }
}

impl Drop for Entry {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

impl fmt::Debug for Entry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Entry(key ")?;
        self.key
            .iter()
            .try_for_each(|byte| write!(f, "{byte:02x}"))?;
        write!(f, ", {} bytes)", self.value.len())
    }
}

/// The changes of one operation. The deletions are applied first, so a key that is both deleted and put ends up
/// put; of two puts of one key the later counts.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Batch {
    /// Entries to write, replacing what is stored under their keys.
    pub put: Vec<Entry>,
    /// Keys to remove; a key that is not stored is no error.
    pub delete: Vec<Vec<u8>>,
}

impl Batch {
    /// An empty batch.
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds an entry to write.
    pub fn put(&mut self, key: Vec<u8>, value: Vec<u8>) {
        self.put.push(Entry::new(key, value));
    }

    /// Adds a key to remove.
    pub fn delete(&mut self, key: Vec<u8>) {
        self.delete.push(key);
    }

    /// Whether it changes nothing.
    pub fn is_empty(&self) -> bool {
        self.put.is_empty() && self.delete.is_empty()
    }
}

/// Everything a store holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Loaded {
    /// How many batches were ever applied.
    pub revision: u64,
    /// Every entry, in any order.
    pub entries: Vec<Entry>,
}

/// Why a store did not do what was asked. Nothing was written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StorageError {
    /// The stored revision is not the one named: another owner wrote to this state.
    Conflict,
    /// The platform's store failed; the text is its own and holds no stored value.
    Failed(String),
}

impl fmt::Display for StorageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StorageError::Conflict => f.write_str("another owner wrote to this state"),
            StorageError::Failed(text) => f.write_str(text),
        }
    }
}

impl std::error::Error for StorageError {}

impl From<StorageError> for Error {
    fn from(error: StorageError) -> Self {
        Error::Storage(error.to_string())
    }
}

/// A device's store. The module documentation states what an implementation must hold: durable and whole writes,
/// one owner, the revision.
pub trait Storage {
    /// Everything stored and its revision. Called once, when the device is opened.
    fn load(&mut self) -> Result<Loaded, StorageError>;

    /// Applies all of `batch` or none of it, with the revision becoming `expected_revision + 1`, and returns only
    /// once that is durable. Refuses with [`StorageError::Conflict`], writing nothing, when the stored revision is
    /// not `expected_revision`.
    fn apply(&mut self, expected_revision: u64, batch: Batch) -> Result<(), StorageError>;
}

/// What an outbox entry asks the hub for. The parts of each kind, in order; a part a request does not have is
/// empty.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutboxKind {
    /// The founding of a room: GroupInfo of epoch 0, its SealedKey.
    RoomFounding = 1,
    /// The founding of a session group: GroupInfo of epoch 0, its SealedKey, the first Commit, its GroupInfo, its
    /// Welcome, its SealedKey.
    GroupFounding = 2,
    /// A Commit by a member, pending until the hub answers: Commit, GroupInfo, Welcome, SealedKey.
    Commit = 3,
    /// A join from outside, built on a copy of the state: Commit, GroupInfo, SealedKey, RecoveryAuth.
    ExternalCommit = 4,
    /// An application message the hub stores: the message.
    Message = 5,
    /// An application message the hub only passes on: the message.
    RelayMessage = 6,
    /// A stored item: the Envelope.
    Envelope = 7,
    /// KeyPackages to publish: the last-resort one, then the single-use ones.
    KeyPackages = 8,
    /// A SealedKey posted on its own: the SealedKey.
    SealedKey = 9,
    /// The replacing of the recovery code: Commit, GroupInfo, SealedKey, RecoveryLink.
    RecoveryCode = 10,
}

impl OutboxKind {
    const ALL: [OutboxKind; 10] = [
        OutboxKind::RoomFounding,
        OutboxKind::GroupFounding,
        OutboxKind::Commit,
        OutboxKind::ExternalCommit,
        OutboxKind::Message,
        OutboxKind::RelayMessage,
        OutboxKind::Envelope,
        OutboxKind::KeyPackages,
        OutboxKind::SealedKey,
        OutboxKind::RecoveryCode,
    ];

    fn from_u8(value: u8) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| *kind as u8 == value)
    }
}

/// One request waiting to be sent, or sent and not yet answered.
///
/// Stored as `struct { uint64 id; uint8 kind; opaque group<V>; uint64 epoch; opaque parts<V><V>; }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboxEntry {
    /// Its place in the order of sending: counted up by one per entry, never reused.
    pub id: u64,
    /// Which request it is.
    pub kind: OutboxKind,
    /// The group it is for; none for key packages.
    pub group: Option<GroupId>,
    /// The epoch a Commit builds on, or a message or envelope was made in; 0 for a kind without one.
    pub epoch: u64,
    /// The exact bytes of every part, in the order its kind names.
    pub parts: Vec<Vec<u8>>,
}

/// The key of the outbox entry `id`: stores that list keys in order list the outbox in sending order.
pub fn outbox_key(id: u64) -> Vec<u8> {
    key(table::OUTBOX, &[&id.to_be_bytes()])
}

impl Encode for OutboxEntry {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.u64(self.id);
        writer.u8(self.kind as u8);
        writer.opaque(self.group.as_ref().map_or(&[], GroupId::as_bytes))?;
        writer.u64(self.epoch);
        let parts: Vec<Opaque> = self.parts.iter().cloned().map(Opaque).collect();
        writer.vector(&parts)
    }
}

impl Decode for OutboxEntry {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        let id = reader.u64()?;
        let kind = OutboxKind::from_u8(reader.u8()?).ok_or(Error::BadFormat)?;
        let group = match reader.opaque()? {
            [] => None,
            bytes => Some(GroupId::from_bytes(bytes)?),
        };
        let epoch = reader.u64()?;
        let parts = reader
            .vector::<Opaque>()?
            .into_iter()
            .map(|part| part.0)
            .collect();
        Ok(Self {
            id,
            kind,
            group,
            epoch,
            parts,
        })
    }
}

impl OutboxEntry {
    /// The stored form: under [`outbox_key`], its encoding.
    pub fn to_entry(&self) -> Result<Entry, Error> {
        Ok(Entry::new(outbox_key(self.id), codec::encode(self)?))
    }

    /// Reads a stored outbox entry; `Error::Storage` when the value does not decode or sits under another key
    /// than its id's.
    pub fn from_entry(entry: &Entry) -> Result<Self, Error> {
        let damaged = || Error::Storage("an outbox entry does not decode".into());
        let decoded: Self =
            codec::decode(&entry.value, entry.value.len()).map_err(|_| damaged())?;
        if entry.key != outbox_key(decoded.id) {
            return Err(damaged());
        }
        Ok(decoded)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::{RoomId, SessionId};

    fn batch(put: &[(&[u8], &[u8])], delete: &[&[u8]]) -> Batch {
        let mut batch = Batch::new();
        for (key, value) in put {
            batch.put(key.to_vec(), value.to_vec());
        }
        for key in delete {
            batch.delete(key.to_vec());
        }
        batch
    }

    #[test]
    fn an_entry_shows_its_key_and_only_the_size_of_its_value() {
        let entry = Entry::new(key(table::DEVICE, &[b"\x00\xff"]), b"private key".to_vec());
        assert_eq!(format!("{entry:?}"), "Entry(key 0100ff, 11 bytes)");
        assert!(!format!("{:?}", batch(&[(b"k", b"private key")], &[])).contains("private"));
    }

    #[test]
    fn storage_errors_become_the_storage_error() {
        assert_eq!(
            Error::from(StorageError::Failed("disk full".into())),
            Error::Storage("disk full".into())
        );
        assert_eq!(Error::from(StorageError::Conflict).code(), "storage");
    }

    fn outbox_entry() -> OutboxEntry {
        OutboxEntry {
            id: 258,
            kind: OutboxKind::Commit,
            group: Some(GroupId::session(
                RoomId::new([1; 32]),
                SessionId::new([2; 16]),
            )),
            epoch: 7,
            parts: vec![
                b"commit".to_vec(),
                b"group info".to_vec(),
                vec![],
                vec![9; 300],
            ],
        }
    }

    #[test]
    fn an_outbox_entry_round_trips_under_its_key() {
        let entry = outbox_entry();
        let stored = entry.to_entry().unwrap();
        assert_eq!(stored.key, [table::OUTBOX, 0, 0, 0, 0, 0, 0, 1, 2]);
        assert_eq!(OutboxEntry::from_entry(&stored).unwrap(), entry);

        let without_group = OutboxEntry {
            kind: OutboxKind::KeyPackages,
            group: None,
            epoch: 0,
            parts: vec![],
            ..entry
        };
        let stored = without_group.to_entry().unwrap();
        assert_eq!(
            stored.value,
            [0, 0, 0, 0, 0, 0, 1, 2, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        );
        assert_eq!(OutboxEntry::from_entry(&stored).unwrap(), without_group);
    }

    #[test]
    fn outbox_keys_sort_in_sending_order() {
        let mut keys: Vec<Vec<u8>> = [300, 2, 70_000, 1, 255, 256]
            .into_iter()
            .map(outbox_key)
            .collect();
        keys.sort();
        assert_eq!(keys, [1, 2, 255, 256, 300, 70_000].map(outbox_key));
    }

    #[test]
    fn every_outbox_kind_has_its_own_number() {
        for (index, kind) in OutboxKind::ALL.into_iter().enumerate() {
            assert_eq!(kind as usize, index + 1);
            assert_eq!(OutboxKind::from_u8(kind as u8), Some(kind));
        }
        assert_eq!(OutboxKind::from_u8(0), None);
        assert_eq!(OutboxKind::from_u8(11), None);
    }

    #[test]
    fn a_damaged_outbox_entry_is_a_storage_error() {
        let good = outbox_entry().to_entry().unwrap();
        let damaged = Error::Storage("an outbox entry does not decode".into());
        // Under another id's key.
        let moved = Entry::new(outbox_key(259), good.value.clone());
        assert_eq!(OutboxEntry::from_entry(&moved), Err(damaged.clone()));
        // An unknown kind, a group id of no valid length, trailing bytes, every truncation.
        let mut unknown_kind = good.clone();
        unknown_kind.value[8] = 99;
        assert_eq!(OutboxEntry::from_entry(&unknown_kind), Err(damaged.clone()));
        let mut bad_group = good.clone();
        bad_group.value[9] = 47;
        assert_eq!(OutboxEntry::from_entry(&bad_group), Err(damaged.clone()));
        let mut longer = good.clone();
        longer.value.push(0);
        assert_eq!(OutboxEntry::from_entry(&longer), Err(damaged.clone()));
        for cut in 0..good.value.len() {
            let short = Entry::new(good.key.clone(), good.value[..cut].to_vec());
            assert_eq!(
                OutboxEntry::from_entry(&short),
                Err(damaged.clone()),
                "cut at {cut}"
            );
        }
    }
}
