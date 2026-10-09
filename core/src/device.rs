//! The device (section 13): the one stateful object an app holds. It owns the store, the signature key, every
//! group it is a leaf of, the groups it follows as an observer, the content keys and the outbox.
//!
//! **Every operation is one write.** An operation works in memory and ends in one [`Batch`]: the group state
//! it leaves, the content key of a new epoch, the cursor, and every byte string it wants sent as an outbox
//! entry. When the operation or the write fails, memory is rebuilt from what is stored. Nothing is handed out
//! for sending except through [`Device::outbox`]; the caller posts an entry and reports the hub's answer with
//! [`Device::outbox_accepted`] or [`Device::outbox_refused`]. A retry sends the same bytes.
//!
//! **A Commit is pending** until the hub answers. Accepted: it is merged. `epoch-taken`: it stays until the
//! log shows the Commit that took the epoch; if that is this device's own it is merged, otherwise it is
//! dropped, the other one is processed, and the caller builds its change again. A join from outside is built on
//! a copy of the state that replaces the real one only when the hub accepted it.
//!
//! **The log** is processed entry by entry in the hub's order ([`Device::process_log_entry`]). An entry that
//! does not verify, process or obey the rules changes nothing: the error says why, and
//! [`log_finding`] says what it means (`bad-group`, or an entry that came too early).

use crate::codec::{self, Decode, Encode, Opaque, Reader, Writer};
use crate::crypto::{self, Entropy, Secret, SigningKey};
use crate::error::Error;
use crate::ids::{BoardId, DeviceId, GroupId, Hash32, RoomId, SessionId, TurnId};
use crate::mls::group::{self, Built, Change};
use crate::mls::key_package::{self, KeyPackageInfo};
use crate::mls::message::{EpochKey, TrommiMessage, MAX_HANDOVER_KEYS, MAX_MESSAGE_LEN};
use crate::mls::observer::{self, Context, Observer};
use crate::mls::profile::{
    self, CommitNote, Cut, GroupKind, TrommiRoom, TrommiSession, MAX_AGENT_DEVICES,
    MAX_COMMIT_REQUEST_LEN, MAX_HELPER_DEVICES, MAX_HUMAN_DEVICES, RECOVERY_KEY_LEN,
};
use crate::mls::provider::{self, DeviceSigner, MlsEntries, Provider};
use crate::mls::rules::{
    self, CommitFacts, Judged, Parent, RecoveryRules, RoomHistory, RoomState, SessionBefore,
    SessionFacts, Verifier,
};
use crate::store::{self, table, Batch, Entry, OutboxEntry, OutboxKind, Storage, StorageError};
use openmls::group::MlsGroup;
use openmls::prelude::{KeyPackage, ProcessedMessageContent, ProtocolMessage, Sender};
use openmls_traits::OpenMlsProvider as _;
use std::collections::{BTreeMap, BTreeSet};
use tls_codec::{Deserialize as _, Serialize as _};

/// A human device updates its leaf in a live group when the leaf is older than this (5.2.9).
pub const UPDATE_AFTER_MS: u64 = 7 * 24 * 60 * 60 * 1000;
/// And at most once in this time.
pub const UPDATE_AT_MOST_EVERY_MS: u64 = 24 * 60 * 60 * 1000;
/// A device keeps this many single-use KeyPackages at the hub.
pub const SINGLE_USE_KEY_PACKAGES: usize = 100;
/// The last-resort KeyPackage is replaced after this time, and its private part kept as long again.
pub const LAST_RESORT_FOR_MS: u64 = 30 * 24 * 60 * 60 * 1000;

const SUB_SEED: u8 = 0;
const SUB_RECORD: u8 = 1;
const SUB_GROUP: u8 = 2;
const SUB_KEY_PACKAGE: u8 = 3;
const SUB_STAGED: u8 = 4;
const SUB_SENT: u8 = 5;
const SUB_OWN_HISTORY: u8 = 0;
const SUB_OBSERVER: u8 = 1;

/// What the `SealedKey` that goes with a Commit or a founding is made from (8.2).
#[derive(Debug)]
pub struct SealRequest<'a> {
    /// The group.
    pub group: &'a GroupId,
    /// The epoch whose content key is sealed.
    pub epoch: u64,
    /// `content_key(group, epoch)`.
    pub content_key: &'a Secret<32>,
    /// The GroupInfo of that epoch, as it is posted.
    pub group_info: &'a [u8],
    /// The room epoch the row names.
    pub room_epoch: u64,
    /// The recovery key it is sealed to.
    pub recovery_hpke_key: &'a [u8; RECOVERY_KEY_LEN],
    /// This device, the row's writer.
    pub writer: &'a DeviceId,
    /// Whether this device is a human device, whose row carries a `mac`.
    pub writer_is_human: bool,
}

/// The recovery construct (section 8) as the device needs it: the public checks, and the making of the
/// `SealedKey` that goes with every Commit and founding.
pub trait DeviceRecovery: RecoveryRules {
    /// The `SealedKey` for `request`, as it is posted. A human device that does not hold the `recovery_mac` of
    /// the key in force fails here, and so founds nothing and commits nothing (7.4).
    fn seal_key(
        &mut self,
        entropy: &mut dyn Entropy,
        request: &SealRequest<'_>,
    ) -> Result<Vec<u8>, Error>;

    /// The checks, for the rules.
    fn rules(&self) -> &dyn RecoveryRules;
}

/// Makes the `RecoveryAuth` of a join from outside, from the Commit as it will be posted and its note (8.4).
pub type Authorise<'a> = dyn FnMut(&[u8], &CommitNote) -> Result<Vec<u8>, Error> + 'a;

/// One entry of the hub's ordered log.
#[derive(Debug, Clone, Copy)]
pub struct LogEntry<'a> {
    /// The room's change number of the entry.
    pub change: u64,
    /// The group it belongs to.
    pub group: GroupId,
    /// What it is.
    pub kind: LogKind<'a>,
}

/// What a log entry holds.
#[derive(Debug, Clone, Copy)]
pub enum LogKind<'a> {
    /// A Commit, with the `RecoveryAuth` stored beside a join from outside.
    Commit {
        /// The Commit.
        bytes: &'a [u8],
        /// Its `RecoveryAuth`, if any.
        recovery_auth: Option<&'a [u8]>,
    },
    /// An application message.
    Message {
        /// The message.
        bytes: &'a [u8],
    },
}

/// What processing a log entry did.
#[derive(Debug, PartialEq, Eq)]
pub enum Processed {
    /// A Commit of another device was merged. `superseded` names the outbox entry of an own Commit for the
    /// same epoch that was dropped for it: that change is to be built again. `removed`: it removed this device.
    Commit {
        /// What the Commit did.
        facts: CommitFacts,
        /// The dropped own Commit, if any.
        superseded: Option<u64>,
        /// Whether this device is no leaf of the group any more.
        removed: bool,
    },
    /// The entry is this device's own Commit: merged now, or already when the hub accepted it.
    OwnCommit,
    /// A Commit of a group this device follows as an observer.
    Observed(CommitFacts),
    /// An application message that opened.
    Message(Received),
    /// Nothing for this device: a group it does not hold, a message it cannot open (7.0), or a message of a
    /// group that failed its first contact, which is not opened (5.2.6).
    Skipped,
}

/// An application message as its receiver takes it (section 7).
#[derive(Debug, PartialEq, Eq)]
pub enum Received {
    /// A key handover for this device: how many keys were new to it, and whether it was the last message.
    Keys {
        /// The sender.
        from: DeviceId,
        /// The keys taken.
        taken: usize,
        /// Whether the handover is complete.
        last: bool,
    },
    /// A piece of a stroke in progress.
    StrokePiece {
        /// The sender.
        from: DeviceId,
        /// The board.
        board: BoardId,
        /// The JSON piece.
        piece: Vec<u8>,
    },
    /// A step of an agent's turn.
    WorkTrail {
        /// The sender.
        from: DeviceId,
        /// The turn.
        turn: TurnId,
        /// The step's number.
        number: u32,
        /// The sender's clock.
        time: u64,
        /// The JSON step.
        step: Vec<u8>,
    },
    /// The `recovery_mac` of the room's current recovery key, from a human device. Whether it replaces nothing
    /// (`equivocation`) is the recovery construct's to judge.
    RecoveryAuth {
        /// The sender.
        from: DeviceId,
        /// The recovery key it belongs to.
        recovery_hpke_key: [u8; RECOVERY_KEY_LEN],
        /// The key.
        recovery_mac: Secret<32>,
    },
    /// A message this device may not take from that sender in that group, or that is for another device.
    Dropped,
    /// A message that names a version above this build's: the finding `newer-version`. It opened and is not
    /// read; the device is to be updated.
    NewerVersion {
        /// The sender.
        from: DeviceId,
    },
}

/// What an error of [`Device::process_log_entry`] means for the caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogFinding {
    /// The entry came before another it needs: process the room group, or this group, further and try again.
    Early,
    /// The entry lies behind what the device already processed: a duplicate.
    Duplicate,
    /// The entry does not verify, process or obey the rules: the finding `bad-group` (13.4). The device kept
    /// its last good state; the entry is reported to the hub.
    BadGroup,
    /// The device itself failed: its store, its entropy, or a request still pending.
    Local,
}

/// Sorts an error of [`Device::process_log_entry`].
pub fn log_finding(error: &Error) -> LogFinding {
    match error {
        Error::RoomBehind | Error::GroupBehind => LogFinding::Early,
        Error::WrongEpoch => LogFinding::Duplicate,
        Error::Storage(_) | Error::Entropy | Error::Internal(_) | Error::Busy => LogFinding::Local,
        _ => LogFinding::BadGroup,
    }
}

/// What a device expects of a Welcome before it joins (12.1.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WelcomeExpectation {
    /// The room the group must belong to.
    pub room: RoomId,
    /// The device that must have committed the Add, where the joiner was told one (its inviter).
    pub committer: Option<DeviceId>,
}

/// A group joined from a Welcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Joined {
    /// The group.
    pub group: GroupId,
    /// Its epoch.
    pub epoch: u64,
    /// The device that added this one.
    pub added_by: DeviceId,
    /// The leaves the room state does not allow, or in a helper session whatever breaks 5.2.3 (also every
    /// helper device of a session that holds more than seven): the finding of first contact (5.2.6). Not empty: the device holds the group, hands out no content key of it, opens no
    /// message of it and writes nothing into it but the Commit that removes leaves, until those leaves are
    /// removed.
    pub offending: Vec<DeviceId>,
}

/// One group as the device holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupSummary {
    /// The group.
    pub group: GroupId,
    /// For a session group, its extension.
    pub session: Option<TrommiSession>,
    /// Its epoch.
    pub epoch: u64,
    /// Its leaves.
    pub leaves: BTreeSet<DeviceId>,
    /// The leaves the newest room state does not allow: not empty means stale (5.2.8).
    pub disallowed: Vec<DeviceId>,
    /// Whether it was archived (5.2.10).
    pub archived: bool,
    /// Whether a Commit of this device waits for the hub's answer.
    pub pending: bool,
}

/// The hub's answer to an accepted request.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Accepted {
    /// The change number the hub gave it, where it gives one.
    pub change: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct Record {
    room: Option<RoomId>,
    cursor: u64,
    next_outbox: u64,
}

impl Encode for Record {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.value(&self.room.unwrap_or(RoomId::ZERO))?;
        writer.u64(self.cursor);
        writer.u64(self.next_outbox);
        Ok(())
    }
}

impl Decode for Record {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        let room: RoomId = reader.value()?;
        Ok(Self {
            room: Some(room).filter(|room| !room.is_zero()),
            cursor: reader.u64()?,
            next_outbox: reader.u64()?,
        })
    }
}

/// A Commit of this device that waits for the hub.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Pending {
    outbox: u64,
    room_epoch: u64,
    time: u64,
    /// The hub answered `epoch-taken`: the log decides.
    awaiting_log: bool,
    /// The Commit has a path, which renews this device's leaf; one that only adds has none (3.4).
    renews_leaf: bool,
}

/// What the device keeps of a group beside OpenMLS's state.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct GroupMeta {
    /// Read from the group's context when the device is opened; none for the room group.
    session: Option<TrommiSession>,
    previous_room_epoch: u64,
    /// A main session's agent leaf over time.
    seats: Vec<(u64, Option<DeviceId>)>,
    /// When this device's leaf was last renewed: by an own Commit with a path, or when the group was founded
    /// or joined (a Welcome does not say when the KeyPackage it used was made, so the join counts). And when
    /// the device last committed an update.
    own_leaf_ms: u64,
    last_update_ms: u64,
    archived: bool,
    /// The group exists only as a founding the hub has not answered.
    founding: bool,
    /// First contact found leaves that do not belong: no content key is handed out.
    distrusted: bool,
    /// This device was removed: OpenMLS's state is gone, the keys stay.
    removed: bool,
    pending: Option<Pending>,
    /// The epoch this device's last merged own Commit built on, and its hash: so it is known when the log
    /// brings it by again.
    last_commit: Option<(u64, Hash32)>,
    /// The epoch this device joined the group at: Commits before it are not for it.
    joined_epoch: u64,
}

impl Encode for GroupMeta {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.u64(self.previous_room_epoch);
        let mut seats = Writer::new();
        for (room_epoch, seat) in &self.seats {
            seats.u64(*room_epoch);
            seats.value(&seat.unwrap_or(DeviceId::ZERO))?;
        }
        writer.opaque(&seats.into_bytes())?;
        writer.u64(self.own_leaf_ms);
        writer.u64(self.last_update_ms);
        let flags = u8::from(self.archived)
            | (u8::from(self.founding) << 1)
            | (u8::from(self.distrusted) << 2)
            | (u8::from(self.removed) << 3)
            | (u8::from(
                self.pending
                    .as_ref()
                    .is_some_and(|pending| pending.awaiting_log),
            ) << 4)
            | (u8::from(
                self.pending
                    .as_ref()
                    .is_some_and(|pending| pending.renews_leaf),
            ) << 5);
        writer.u8(flags);
        let pending = self.pending.as_ref();
        writer.u64(pending.map_or(0, |pending| pending.outbox));
        writer.u64(pending.map_or(0, |pending| pending.room_epoch));
        writer.u64(pending.map_or(0, |pending| pending.time));
        let (epoch, hash) = self.last_commit.unwrap_or((u64::MAX, Hash32::ZERO));
        writer.u64(epoch);
        writer.value(&hash)?;
        writer.u64(self.joined_epoch);
        Ok(())
    }
}

impl Decode for GroupMeta {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        let previous_room_epoch = reader.u64()?;
        let mut listed = Reader::new(reader.opaque()?);
        let mut seats = Vec::new();
        while !listed.is_empty() {
            let room_epoch = listed.u64()?;
            let seat: DeviceId = listed.value()?;
            seats.push((room_epoch, Some(seat).filter(|seat| !seat.is_zero())));
        }
        let own_leaf_ms = reader.u64()?;
        let last_update_ms = reader.u64()?;
        let flags = reader.u8()?;
        if flags >= 1 << 6 {
            return Err(Error::BadFormat);
        }
        let outbox = reader.u64()?;
        let room_epoch = reader.u64()?;
        let time = reader.u64()?;
        let pending = (outbox != 0).then_some(Pending {
            outbox,
            room_epoch,
            time,
            awaiting_log: flags & (1 << 4) != 0,
            renews_leaf: flags & (1 << 5) != 0,
        });
        let epoch = reader.u64()?;
        let hash: Hash32 = reader.value()?;
        Ok(Self {
            session: None,
            previous_room_epoch,
            seats,
            own_leaf_ms,
            last_update_ms,
            archived: flags & 1 != 0,
            founding: flags & (1 << 1) != 0,
            distrusted: flags & (1 << 2) != 0,
            removed: flags & (1 << 3) != 0,
            pending,
            last_commit: (epoch != u64::MAX).then_some((epoch, hash)),
            joined_epoch: reader.u64()?,
        })
    }
}

/// A KeyPackage of this device whose private part is stored.
#[derive(Debug, Clone, PartialEq, Eq)]
struct OwnKeyPackage {
    last_resort: bool,
    made_ms: u64,
    /// For a last-resort one that was replaced: when.
    retired_ms: u64,
}

/// A join from outside that waits for the hub: the group's state as a set of changes to OpenMLS's entries.
struct Staged {
    group: GroupId,
    /// The epoch the group stands in once joined.
    epoch: u64,
    room_epoch: u64,
    key: Secret<32>,
    put: Vec<(Vec<u8>, Vec<u8>)>,
    delete: Vec<Vec<u8>>,
}

impl Encode for Staged {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.value(&self.group)?;
        writer.u64(self.epoch);
        writer.u64(self.room_epoch);
        writer.fixed(self.key.expose());
        let mut put = Writer::new();
        for (key, value) in &self.put {
            put.opaque(key)?;
            put.opaque(value)?;
        }
        writer.opaque(&put.into_bytes())?;
        let delete: Vec<Opaque> = self.delete.iter().cloned().map(Opaque).collect();
        writer.vector(&delete)
    }
}

impl Decode for Staged {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        let group = reader.value()?;
        let epoch = reader.u64()?;
        let room_epoch = reader.u64()?;
        let key = Secret::new(reader.fixed()?);
        let mut listed = Reader::new(reader.opaque()?);
        let mut put = Vec::new();
        while !listed.is_empty() {
            put.push((listed.opaque()?.to_vec(), listed.opaque()?.to_vec()));
        }
        let delete = reader
            .vector::<Opaque>()?
            .into_iter()
            .map(|key| key.0)
            .collect();
        Ok(Self {
            group,
            epoch,
            room_epoch,
            key,
            put,
            delete,
        })
    }
}

/// Everything the device holds in memory that is rebuilt from the store.
#[derive(Default)]
struct Memory {
    record: Record,
    outbox: BTreeMap<u64, OutboxEntry>,
    keys: BTreeMap<(GroupId, u64), Secret<32>>,
    /// A human device's own record of the room's roles; other devices use their observer's.
    history: Option<RoomHistory>,
    groups: BTreeMap<GroupId, GroupMeta>,
    key_packages: BTreeMap<Hash32, OwnKeyPackage>,
    observers: BTreeMap<GroupId, Observer>,
    staged: BTreeMap<u64, Staged>,
    /// Handovers sent and not yet seen read: the recipient and the group they went through.
    sent: BTreeSet<(DeviceId, GroupId)>,
}

/// What the device knows of the room's sessions, as the rules ask it.
struct Known {
    seats: BTreeMap<SessionId, Vec<(u64, Option<DeviceId>)>>,
    helpers: BTreeMap<SessionId, usize>,
}

impl SessionFacts for Known {
    fn main_session(&self, session: &SessionId, room_epoch: u64) -> Parent {
        match self.seats.get(session) {
            Some(seats) => Parent::Seat(observer::seat_at(seats, room_epoch)),
            None => Parent::Unknown,
        }
    }

    fn main_session_of(&self, agent: &DeviceId) -> Option<SessionId> {
        self.seats
            .iter()
            .find(|(_, seats)| seats.last().is_some_and(|(_, seat)| *seat == Some(*agent)))
            .map(|(session, _)| *session)
    }

    fn live_helpers(&self, parent: &SessionId) -> usize {
        self.helpers.get(parent).copied().unwrap_or(0)
    }
}

/// One device. Exactly one object works on a stored state at a time (see [`crate::store`]).
pub struct Device<S: Storage> {
    store: S,
    revision: u64,
    /// What the store holds, entry for entry.
    mirror: BTreeMap<Vec<u8>, Vec<u8>>,
    key: SigningKey,
    id: DeviceId,
    provider: Provider,
    recovery: Box<dyn DeviceRecovery>,
    memory: Memory,
    /// Another owner wrote to the stored state: this object works on it no more.
    lost: bool,
}

impl<S: Storage> std::fmt::Debug for Device<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Device({})", self.id)
    }
}

fn damaged(what: &'static str) -> Error {
    Error::Storage(format!("{what} does not decode"))
}

fn mls_fault<E>(_: E) -> Error {
    Error::Storage("the MLS storage failed".into())
}

fn device_key(sub: u8, rest: &[u8]) -> Vec<u8> {
    store::key(table::DEVICE, &[&[sub], rest])
}

fn mls_key(key: &[u8]) -> Vec<u8> {
    store::key(table::MLS, &[key])
}

fn content_key_key(group: &GroupId, epoch: u64) -> Vec<u8> {
    let group = group.as_bytes();
    // Group ids have two lengths: the length byte keeps one key from being the start of another.
    store::key(
        table::CONTENT_KEY,
        &[&[group.len() as u8], group, &epoch.to_be_bytes()],
    )
}

fn observer_prefix(group: &GroupId) -> Vec<u8> {
    let group = group.as_bytes();
    store::key(
        table::ROOM_STATE,
        &[&[SUB_OBSERVER, group.len() as u8], group],
    )
}

fn history_key(epoch: u64) -> Vec<u8> {
    store::key(
        table::ROOM_STATE,
        &[&[SUB_OWN_HISTORY], &epoch.to_be_bytes()],
    )
}

fn group_after(reader: &mut Reader<'_>) -> Result<GroupId, Error> {
    let len = usize::from(reader.u8()?);
    GroupId::from_bytes(reader.take(len)?)
}

/// Rebuilds memory from the store's entries. Returns it with OpenMLS's entries.
fn rebuild(mirror: &BTreeMap<Vec<u8>, Vec<u8>>) -> Result<(Memory, MlsEntries, Secret<32>), Error> {
    let mut memory = Memory::default();
    let mut mls = MlsEntries::new();
    let mut seed = None;
    let mut record = None;
    let mut states = Vec::new();
    let mut observed: BTreeMap<GroupId, Vec<Entry>> = BTreeMap::new();
    for (key, value) in mirror {
        let (table, rest) = key.split_first().ok_or_else(|| damaged("a key"))?;
        let mut rest = Reader::new(rest);
        match *table {
            table::DEVICE => match rest.u8().map_err(|_| damaged("a key"))? {
                SUB_SEED => {
                    seed = Some(Secret::from_slice(value).map_err(|_| damaged("the key"))?);
                }
                SUB_RECORD => {
                    let decoded: Record = codec::decode(value, value.len())
                        .map_err(|_| damaged("the device record"))?;
                    record = Some(decoded);
                }
                SUB_GROUP => {
                    let group = GroupId::from_bytes(rest.take(rest.remaining())?)
                        .map_err(|_| damaged("a group key"))?;
                    let meta: GroupMeta =
                        codec::decode(value, value.len()).map_err(|_| damaged("a group record"))?;
                    memory.groups.insert(group, meta);
                }
                SUB_KEY_PACKAGE => {
                    let reference = Hash32::from_slice(rest.take(rest.remaining())?)
                        .map_err(|_| damaged("a key package key"))?;
                    let mut reader = Reader::new(value);
                    let own = (|| {
                        Ok::<_, Error>(OwnKeyPackage {
                            last_resort: reader.u8()? == 1,
                            made_ms: reader.u64()?,
                            retired_ms: reader.u64()?,
                        })
                    })()
                    .map_err(|_| damaged("a key package record"))?;
                    memory.key_packages.insert(reference, own);
                }
                SUB_STAGED => {
                    let id = rest.u64().map_err(|_| damaged("a staged join"))?;
                    let staged: Staged =
                        codec::decode(value, value.len()).map_err(|_| damaged("a staged join"))?;
                    memory.staged.insert(id, staged);
                }
                SUB_SENT => {
                    let recipient: DeviceId =
                        rest.value().map_err(|_| damaged("a handover record"))?;
                    let group = GroupId::from_bytes(rest.take(rest.remaining())?)
                        .map_err(|_| damaged("a handover record"))?;
                    memory.sent.insert((recipient, group));
                }
                _ => return Err(damaged("a key")),
            },
            table::MLS => {
                mls.insert(rest.take(rest.remaining())?.to_vec(), value.clone());
            }
            table::CONTENT_KEY => {
                let parsed = (|| {
                    let group = group_after(&mut rest)?;
                    let epoch = rest.u64()?;
                    rest.finish()?;
                    Ok::<_, Error>((group, epoch, Secret::from_slice(value)?))
                })()
                .map_err(|_| damaged("a content key"))?;
                memory.keys.insert((parsed.0, parsed.1), parsed.2);
            }
            table::ROOM_STATE => match rest.u8().map_err(|_| damaged("a key"))? {
                SUB_OWN_HISTORY => {
                    let state: RoomState =
                        codec::decode(value, value.len()).map_err(|_| damaged("a room state"))?;
                    states.push(state);
                }
                SUB_OBSERVER => {
                    let group = group_after(&mut rest).map_err(|_| damaged("an observer key"))?;
                    let own = rest.take(rest.remaining())?.to_vec();
                    observed
                        .entry(group)
                        .or_default()
                        .push(Entry::new(own, value.clone()));
                }
                _ => return Err(damaged("a key")),
            },
            table::OUTBOX => {
                let entry = OutboxEntry::from_entry(&Entry::new(key.clone(), value.clone()))?;
                memory.outbox.insert(entry.id, entry);
            }
            // The tables of the modules that are composed on top keep their entries untouched.
            _ => {}
        }
    }
    provider::validate_entries(&mls)?;
    memory.record = record.ok_or_else(|| damaged("the device record"))?;
    states.sort_by_key(|state| state.epoch);
    let mut states = states.into_iter();
    if let Some(first) = states.next() {
        let mut history = RoomHistory::new(first);
        for state in states {
            history
                .record(state)
                .map_err(|_| damaged("the room history"))?;
        }
        memory.history = Some(history);
    }
    for (group, entries) in observed {
        let observer = Observer::load(entries)?;
        if observer.group() != group {
            return Err(damaged("an observer"));
        }
        memory.observers.insert(group, observer);
    }
    let seed = seed.ok_or_else(|| damaged("the key"))?;
    Ok((memory, mls, seed))
}

impl<S: Storage> Device<S> {
    /// A new device in an empty store: a fresh signature key, no room yet.
    pub fn create(
        mut store: S,
        mut entropy: Box<dyn Entropy + Send>,
        recovery: Box<dyn DeviceRecovery>,
    ) -> Result<Self, Error> {
        let loaded = store.load()?;
        if loaded.revision != 0 || !loaded.entries.is_empty() {
            return Err(Error::Storage("the store is not empty".into()));
        }
        let key = SigningKey::generate(entropy.as_mut())?;
        let record = Record {
            room: None,
            cursor: 0,
            next_outbox: 1,
        };
        let mut batch = Batch::new();
        batch.put(device_key(SUB_SEED, &[]), key.seed().expose().to_vec());
        batch.put(device_key(SUB_RECORD, &[]), codec::encode(&record)?);
        store.apply(0, batch.clone())?;
        let mirror = batch
            .put
            .iter()
            .map(|entry| (entry.key.clone(), entry.value.clone()))
            .collect();
        Ok(Self {
            store,
            revision: 1,
            mirror,
            id: DeviceId::new(key.public()),
            key,
            provider: Provider::new(entropy, MlsEntries::new())?,
            recovery,
            memory: Memory {
                record,
                ..Memory::default()
            },
            lost: false,
        })
    }

    /// The device a store holds. `Error::Storage` when anything in it does not decode or fit together, or a
    /// stored group stands in an epoch above [`profile::MAX_STORED_EPOCH`].
    pub fn open(
        mut store: S,
        entropy: Box<dyn Entropy + Send>,
        recovery: Box<dyn DeviceRecovery>,
    ) -> Result<Self, Error> {
        let loaded = store.load()?;
        let mirror: BTreeMap<Vec<u8>, Vec<u8>> = loaded
            .entries
            .iter()
            .map(|entry| (entry.key.clone(), entry.value.clone()))
            .collect();
        let (memory, mls, seed) = rebuild(&mirror)?;
        let key = SigningKey::from_seed(seed);
        let mut device = Self {
            store,
            revision: loaded.revision,
            mirror,
            id: DeviceId::new(key.public()),
            key,
            provider: Provider::new(entropy, mls)?,
            recovery,
            memory,
            lost: false,
        };
        device.read_groups()?;
        Ok(device)
    }

    /// Loads every group once: what does not load is damaged state, and each session group's extension is
    /// read from its context.
    fn read_groups(&mut self) -> Result<(), Error> {
        let ids: Vec<GroupId> = self.memory.groups.keys().copied().collect();
        for id in ids {
            let removed = self.memory.groups.get(&id).is_some_and(|meta| meta.removed);
            if removed {
                continue;
            }
            let group = group::load(&self.provider, &id).map_err(|_| damaged("a group"))?;
            let context = group.public_group().group_context();
            let (stored, kind) =
                profile::kind_of_context(context).map_err(|_| damaged("a group"))?;
            // The leaf OpenMLS holds as this device's own is the one with this device's key.
            let own_leaf = group
                .own_leaf_node()
                .is_some_and(|leaf| leaf.signature_key().as_slice() == self.id.as_bytes());
            let exhausted = group.epoch().as_u64() > profile::MAX_STORED_EPOCH;
            if stored != id || !own_leaf || exhausted || rules::leaves_of(group.members()).is_err()
            {
                return Err(damaged("a group"));
            }
            if let (GroupKind::Session(session), Some(meta)) =
                (kind, self.memory.groups.get_mut(&id))
            {
                meta.session = Some(session);
            }
        }
        Ok(())
    }

    /// Puts memory back to what is stored.
    fn reset(&mut self) -> Result<(), Error> {
        let (memory, mls, _) = rebuild(&self.mirror)?;
        self.provider.restore(mls);
        self.memory = memory;
        self.read_groups()
    }

    /// The error of a device that is no longer the owner of its stored state.
    fn owner(&self) -> Result<(), Error> {
        if self.lost {
            Err(StorageError::Conflict.into())
        } else {
            Ok(())
        }
    }

    /// Whether this object is still the owner of its stored state. It is not once a write met
    /// [`StorageError::Conflict`]: another owner wrote, and what this object holds in memory is behind. Every
    /// operation and every reading that hands out keys or groups then returns `Error::Storage`,
    /// [`Device::outbox`] is empty, and nothing more is written; the state is used again by
    /// [`Device::open`] under the store's lock.
    pub fn is_owner(&self) -> bool {
        !self.lost
    }

    /// Runs one operation and writes what it changed in one batch; on any failure memory is what is stored.
    fn transact<T>(
        &mut self,
        operation: impl FnOnce(&mut Self, &mut Batch) -> Result<T, Error>,
    ) -> Result<T, Error> {
        self.owner()?;
        let mut batch = Batch::new();
        let result = operation(self, &mut batch).and_then(|value| {
            self.write(batch)?;
            Ok(value)
        });
        if result.is_err() {
            self.reset()?;
        }
        result
    }

    fn write(&mut self, mut batch: Batch) -> Result<(), Error> {
        let stored: MlsEntries = self
            .mirror
            .range(vec![table::MLS]..vec![table::MLS.saturating_add(1)])
            .filter_map(|(key, value)| Some((key.get(1..)?.to_vec(), value.clone())))
            .collect();
        let (put, delete) = self.provider.changes(&stored);
        for (key, value) in put {
            batch.put(mls_key(&key), value);
        }
        for key in delete {
            batch.delete(mls_key(&key));
        }
        for (group, observer) in &mut self.memory.observers {
            let prefix = observer_prefix(group);
            let changes = observer.take_changes()?;
            for entry in &changes.put {
                batch.put([&prefix[..], &entry.key].concat(), entry.value.clone());
            }
            for key in &changes.delete {
                batch.delete([&prefix[..], key].concat());
            }
        }
        if batch.is_empty() {
            return Ok(());
        }
        if let Err(error) = self.store.apply(self.revision, batch.clone()) {
            self.lost = error == StorageError::Conflict;
            return Err(error.into());
        }
        self.revision = self.revision.saturating_add(1);
        for key in &batch.delete {
            self.mirror.remove(key);
        }
        for entry in &batch.put {
            self.mirror.insert(entry.key.clone(), entry.value.clone());
        }
        Ok(())
    }

    // ---- what the device is and holds ----

    /// The device id: its signature public key.
    pub fn id(&self) -> DeviceId {
        self.id
    }

    /// The room this device belongs to, once it founded or joined one.
    pub fn room(&self) -> Option<RoomId> {
        self.memory.record.room
    }

    /// The highest change number of the hub's log this device processed.
    pub fn cursor(&self) -> u64 {
        self.memory.record.cursor
    }

    /// The room's roles per epoch as this device knows them: from its own room group, or as an observer.
    pub fn room_history(&self) -> Option<&RoomHistory> {
        let observed = self
            .memory
            .record
            .room
            .and_then(|room| self.memory.observers.get(&GroupId::room(room)))
            .and_then(Observer::history);
        self.memory.history.as_ref().or(observed)
    }

    fn history(&self) -> Result<&RoomHistory, Error> {
        self.room_history().ok_or(Error::RoomBehind)
    }

    /// Whether this device is a human device now.
    pub fn is_human(&self) -> bool {
        self.room_history()
            .is_some_and(|history| history.newest().is_human(&self.id))
    }

    /// The content key of `group` at `epoch` (section 6); `no-key` when it is not held, or the group failed
    /// its first contact.
    pub fn content_key(&self, group: &GroupId, epoch: u64) -> Result<Secret<32>, Error> {
        self.owner()?;
        if self
            .memory
            .groups
            .get(group)
            .is_some_and(|meta| meta.distrusted)
        {
            return Err(Error::NoKey);
        }
        self.memory
            .keys
            .get(&(*group, epoch))
            .map(Secret::duplicate)
            .ok_or(Error::NoKey)
    }

    /// The groups this device is a leaf of.
    pub fn groups(&self) -> Result<Vec<GroupSummary>, Error> {
        self.owner()?;
        let known = self.known();
        let mut summaries = Vec::new();
        for (id, meta) in &self.memory.groups {
            if meta.removed {
                continue;
            }
            let group = group::load(&self.provider, id)?;
            let leaves: BTreeSet<DeviceId> = rules::leaves_of(group.members())?
                .into_iter()
                .map(|(_, device)| device)
                .collect();
            summaries.push(GroupSummary {
                group: *id,
                session: meta.session,
                epoch: group.epoch().as_u64(),
                disallowed: self.disallowed(meta, &leaves, &known),
                leaves,
                archived: meta.archived,
                pending: meta.pending.is_some(),
            });
        }
        Ok(summaries)
    }

    /// One group this device is a leaf of; `not-found` otherwise.
    pub fn group(&self, group: &GroupId) -> Result<GroupSummary, Error> {
        self.groups()?
            .into_iter()
            .find(|summary| summary.group == *group)
            .ok_or(Error::NotFound)
    }

    /// The leaves of a session group that the newest room state does not allow.
    fn disallowed(
        &self,
        meta: &GroupMeta,
        leaves: &BTreeSet<DeviceId>,
        known: &Known,
    ) -> Vec<DeviceId> {
        let (Some(session), Some(history)) = (meta.session.as_ref(), self.room_history()) else {
            return Vec::new();
        };
        let room = history.newest();
        let parent = if session.parent.is_zero() {
            Parent::NotAMainSession
        } else {
            known.main_session(&session.parent, room.epoch)
        };
        rules::disallowed_leaves(history, room, session, parent, leaves)
    }

    /// What first contact finds among a session group's leaves (5.2.6): the leaves the newest room state does
    /// not allow, and in a helper session that holds more helper devices than 5.2.3 allows, all of those.
    fn unfit_at_first_contact(
        &self,
        meta: &GroupMeta,
        leaves: &BTreeSet<DeviceId>,
        known: &Known,
    ) -> Vec<DeviceId> {
        let mut unfit = self.disallowed(meta, leaves, known);
        if let (Some(session), Some(history)) = (meta.session.as_ref(), self.room_history()) {
            let room = history.newest();
            let parent = known.main_session(&session.parent, room.epoch);
            let helpers = rules::helper_devices(history, room, session, parent, leaves);
            if helpers.len() > MAX_HELPER_DEVICES {
                for helper in helpers {
                    if !unfit.contains(&helper) {
                        unfit.push(helper);
                    }
                }
            }
        }
        unfit
    }

    /// Whether this device is the opener of the helper session `session` (5.2.3), by what it knows: an agent
    /// device that is its main session's agent leaf. A device that does not follow the main session cannot
    /// tell; as an agent device it then takes itself for the opener, and the others judge what it sends.
    fn opens(&self, session: &TrommiSession) -> bool {
        let Some(room) = self.room_history().map(RoomHistory::newest) else {
            return false;
        };
        if session.parent.is_zero() || !room.is_agent(&self.id) {
            return false;
        }
        match self.known().main_session(&session.parent, room.epoch) {
            Parent::Seat(seat) => seat == Some(self.id),
            Parent::Unknown => true,
            Parent::NotAMainSession => false,
        }
    }

    fn known(&self) -> Known {
        let mut known = Known {
            seats: BTreeMap::new(),
            helpers: BTreeMap::new(),
        };
        for meta in self.memory.groups.values() {
            let Some(session) = meta.session.as_ref() else {
                continue;
            };
            if meta.archived || meta.removed {
                continue;
            }
            if session.parent.is_zero() {
                known.seats.insert(session.session_id, meta.seats.clone());
            } else {
                let count = known.helpers.entry(session.parent).or_insert(0);
                *count = count.saturating_add(1);
            }
        }
        for observer in self.memory.observers.values() {
            if let Some(session) = observer
                .session()
                .filter(|session| session.parent.is_zero())
            {
                known
                    .seats
                    .entry(session.session_id)
                    .or_insert_with(|| observer.seats().to_vec());
            }
        }
        known
    }

    // ---- small writers ----

    fn put_record(&self, batch: &mut Batch) -> Result<(), Error> {
        batch.put(
            device_key(SUB_RECORD, &[]),
            codec::encode(&self.memory.record)?,
        );
        Ok(())
    }

    fn put_group(&self, batch: &mut Batch, group: &GroupId) -> Result<(), Error> {
        let meta = self.memory.groups.get(group).ok_or(Error::NotFound)?;
        batch.put(
            device_key(SUB_GROUP, group.as_bytes()),
            codec::encode(meta)?,
        );
        Ok(())
    }

    fn meta(&mut self, group: &GroupId) -> Result<&mut GroupMeta, Error> {
        self.memory
            .groups
            .get_mut(group)
            .filter(|meta| !meta.removed)
            .ok_or(Error::NotFound)
    }

    /// Stores a content key unless one is held for that group and epoch: a held key is never replaced.
    fn keep_key(
        &mut self,
        batch: &mut Batch,
        group: &GroupId,
        epoch: u64,
        key: Secret<32>,
    ) -> bool {
        if self.memory.keys.contains_key(&(*group, epoch)) {
            return false;
        }
        batch.put(content_key_key(group, epoch), key.expose().to_vec());
        self.memory.keys.insert((*group, epoch), key);
        true
    }

    fn enqueue(
        &mut self,
        batch: &mut Batch,
        kind: OutboxKind,
        group: Option<GroupId>,
        epoch: u64,
        parts: Vec<Vec<u8>>,
    ) -> Result<u64, Error> {
        let id = self.memory.record.next_outbox;
        self.memory.record.next_outbox = id.checked_add(1).ok_or(Error::Internal("outbox id"))?;
        let entry = OutboxEntry {
            id,
            kind,
            group,
            epoch,
            parts,
        };
        batch.put.push(entry.to_entry()?);
        self.memory.outbox.insert(id, entry);
        self.put_record(batch)?;
        Ok(id)
    }

    fn drop_outbox(&mut self, batch: &mut Batch, id: u64) {
        self.memory.outbox.remove(&id);
        batch.delete(store::outbox_key(id));
    }

    // ---- the outbox ----

    /// Everything waiting to be sent, in the order to send it. An entry stays until the hub's answer was
    /// reported; a Commit refused with `epoch-taken` is held back until the log decided it. Empty for a device
    /// that is no longer the owner of its stored state ([`Device::is_owner`]): what it holds may have been sent
    /// or replaced by the other owner.
    pub fn outbox(&self) -> Vec<OutboxEntry> {
        if self.lost {
            return Vec::new();
        }
        let held: BTreeSet<u64> = self
            .memory
            .groups
            .values()
            .filter_map(|meta| meta.pending.as_ref())
            .filter(|pending| pending.awaiting_log)
            .map(|pending| pending.outbox)
            .collect();
        self.memory
            .outbox
            .values()
            .filter(|entry| !held.contains(&entry.id))
            .cloned()
            .collect()
    }

    /// The hub accepted the outbox entry `id`: the entry goes, and its consequence is applied in the same write
    /// (a pending Commit is merged, a join from outside replaces the real state).
    pub fn outbox_accepted(&mut self, id: u64, answer: Accepted) -> Result<(), Error> {
        self.transact(|device, batch| {
            let entry = device
                .memory
                .outbox
                .get(&id)
                .cloned()
                .ok_or(Error::NotFound)?;
            match (entry.kind, entry.group) {
                (
                    OutboxKind::Commit | OutboxKind::GroupFounding | OutboxKind::RecoveryCode,
                    Some(group),
                ) => {
                    device.merge_own(batch, &group)?;
                }
                (OutboxKind::RoomFounding, Some(group)) => {
                    device.meta(&group)?.founding = false;
                    device.put_group(batch, &group)?;
                }
                (OutboxKind::ExternalCommit, Some(_)) => device.adopt_staged(batch, id)?,
                (OutboxKind::KeyPackages, _) => {
                    let replacement = entry.parts.first().filter(|part| !part.is_empty());
                    if let Some(replacement) = replacement {
                        device.retire_last_resort(batch, &key_package::reference(replacement)?);
                    }
                }
                _ => {}
            }
            device.drop_outbox(batch, id);
            // The cursor moves past the own entry only when nothing lies between: an entry of another
            // device that the hub ordered before it is still to be processed (5.4.1), and the log then
            // brings the own one by again.
            let next = device.memory.record.cursor.checked_add(1);
            if let Some(change) = answer.change.filter(|change| Some(*change) == next) {
                device.advance(batch, change)?;
            }
            Ok(())
        })
    }

    /// The hub refused the outbox entry `id` with `code`. `epoch-taken` for a Commit: it is held back, and the
    /// caller processes the log, which decides it. Any other refusal undoes what the entry was for: the pending
    /// Commit is cleared, a founding's group or a staged join is dropped, the KeyPackages' private parts go.
    pub fn outbox_refused(&mut self, id: u64, code: &Error) -> Result<(), Error> {
        self.transact(|device, batch| {
            let entry = device
                .memory
                .outbox
                .get(&id)
                .cloned()
                .ok_or(Error::NotFound)?;
            match (entry.kind, entry.group) {
                (OutboxKind::Commit | OutboxKind::RecoveryCode, Some(group)) => {
                    if *code == Error::EpochTaken {
                        if let Some(pending) = device.meta(&group)?.pending.as_mut() {
                            pending.awaiting_log = true;
                        }
                        return device.put_group(batch, &group);
                    }
                    device.clear_pending(batch, &group)?;
                }
                (OutboxKind::RoomFounding | OutboxKind::GroupFounding, Some(group)) => {
                    device.forget_group(batch, &group)?;
                    if entry.kind == OutboxKind::RoomFounding {
                        device.memory.record.room = None;
                        device.put_record(batch)?;
                        for state in device
                            .memory
                            .history
                            .take()
                            .iter()
                            .flat_map(RoomHistory::states)
                        {
                            batch.delete(history_key(state.epoch));
                        }
                    }
                }
                (OutboxKind::ExternalCommit, _) => {
                    device.memory.staged.remove(&id);
                    batch.delete(device_key(SUB_STAGED, &id.to_be_bytes()));
                }
                (OutboxKind::KeyPackages, _) => {
                    // The refusal may be for the KeyPackages themselves: they are not verified here.
                    for part in entry.parts.iter().filter(|part| !part.is_empty()) {
                        let reference = key_package::reference(part)?;
                        key_package::forget(&device.provider, &reference)?;
                        device.memory.key_packages.remove(&reference);
                        batch.delete(device_key(SUB_KEY_PACKAGE, reference.as_bytes()));
                    }
                }
                _ => {}
            }
            device.drop_outbox(batch, id);
            Ok(())
        })
    }

    fn advance(&mut self, batch: &mut Batch, change: u64) -> Result<(), Error> {
        if change > self.memory.record.cursor {
            self.memory.record.cursor = change;
            self.put_record(batch)?;
        }
        Ok(())
    }

    /// Merges this device's pending Commit of `group` and settles the new epoch.
    fn merge_own(&mut self, batch: &mut Batch, id: &GroupId) -> Result<(), Error> {
        let pending = self.meta(id)?.pending.take().ok_or(Error::NotFound)?;
        let commit = self
            .memory
            .outbox
            .get(&pending.outbox)
            .and_then(|entry| {
                let at = usize::from(entry.kind == OutboxKind::GroupFounding).saturating_mul(2);
                entry.parts.get(at)
            })
            .cloned()
            .ok_or(Error::Internal("pending commit"))?;
        let mut group = group::load(&self.provider, id)?;
        let built_on = group.epoch().as_u64();
        group
            .merge_pending_commit(&self.provider)
            .map_err(mls_fault)?;
        let meta = self.meta(id)?;
        meta.founding = false;
        if pending.renews_leaf {
            meta.own_leaf_ms = pending.time;
        }
        meta.last_commit = Some((built_on, crypto::sha256(&commit)?));
        self.settle(batch, id, &group, pending.room_epoch)
    }

    /// After a merge: the new epoch's content key, the roles, the record of the group, all in the batch.
    fn settle(
        &mut self,
        batch: &mut Batch,
        id: &GroupId,
        group: &MlsGroup,
        room_epoch: u64,
    ) -> Result<(), Error> {
        let leaves = rules::leaves_of(group.members())?;
        if !group.is_active() {
            return self.leave(batch, id);
        }
        let key = group::content_key(&self.provider, group)?;
        self.keep_key(batch, id, group.epoch().as_u64(), key);
        if id.is_room() {
            let state = rules::room_state_of(group.public_group().group_context(), &leaves)?;
            batch.put(history_key(state.epoch), codec::encode(&state)?);
            match self.memory.history.as_mut() {
                Some(history) => history.record(state)?,
                None => self.memory.history = Some(RoomHistory::new(state)),
            }
        } else {
            let room = self.history()?.at(room_epoch).cloned();
            let meta = self.meta(id)?;
            meta.previous_room_epoch = room_epoch;
            if let (Some(session), Some(room)) = (meta.session, room) {
                if session.parent.is_zero() {
                    let now = observer::seat(&session, &leaves, &room);
                    if meta.seats.last().map(|(_, seat)| *seat) != Some(now) {
                        meta.seats.push((room_epoch, now));
                    }
                }
            }
        }
        self.put_group(batch, id)
    }

    /// This device is no leaf of `group` any more: OpenMLS's state of it goes, its content keys stay.
    fn leave(&mut self, batch: &mut Batch, id: &GroupId) -> Result<(), Error> {
        if let Ok(mut group) = group::load(&self.provider, id) {
            group.delete(self.provider.storage()).map_err(mls_fault)?;
        }
        let meta = self.meta(id)?;
        meta.removed = true;
        meta.pending = None;
        self.put_group(batch, id)
    }

    fn clear_pending(&mut self, batch: &mut Batch, id: &GroupId) -> Result<Option<u64>, Error> {
        let Some(pending) = self.meta(id)?.pending.take() else {
            return Ok(None);
        };
        let mut group = group::load(&self.provider, id)?;
        group
            .clear_pending_commit(self.provider.storage())
            .map_err(mls_fault)?;
        self.put_group(batch, id)?;
        Ok(Some(pending.outbox))
    }

    /// Drops a group that never came to be: a founding the hub refused.
    fn forget_group(&mut self, batch: &mut Batch, id: &GroupId) -> Result<(), Error> {
        if let Ok(mut group) = group::load(&self.provider, id) {
            group.delete(self.provider.storage()).map_err(mls_fault)?;
        }
        self.memory.groups.remove(id);
        batch.delete(device_key(SUB_GROUP, id.as_bytes()));
        let epochs: Vec<u64> = self
            .memory
            .keys
            .range((*id, 0)..=(*id, u64::MAX))
            .map(|((_, epoch), _)| *epoch)
            .collect();
        for epoch in epochs {
            self.memory.keys.remove(&(*id, epoch));
            batch.delete(content_key_key(id, epoch));
        }
        Ok(())
    }

    /// The hub accepted a join from outside: the copy becomes the real state.
    fn adopt_staged(&mut self, batch: &mut Batch, id: u64) -> Result<(), Error> {
        let staged = self.memory.staged.remove(&id).ok_or(Error::NotFound)?;
        batch.delete(device_key(SUB_STAGED, &id.to_be_bytes()));
        let mut entries = self.provider.entries();
        for key in &staged.delete {
            entries.remove(key);
        }
        for (key, value) in &staged.put {
            entries.insert(key.clone(), value.clone());
        }
        provider::validate_entries(&entries)?;
        self.provider.restore(entries);
        let group = group::load(&self.provider, &staged.group)?;
        let (_, kind) = profile::kind_of_context(group.public_group().group_context())?;
        let meta = self.memory.groups.entry(staged.group).or_default();
        *meta = GroupMeta {
            session: match kind {
                GroupKind::Session(session) => Some(session),
                GroupKind::Room(_) => None,
            },
            seats: std::mem::take(&mut meta.seats),
            joined_epoch: staged.epoch,
            // 5.2.10: what was archived stays archived.
            archived: meta.archived,
            ..GroupMeta::default()
        };
        if staged.group.is_room() {
            self.memory.record.room = Some(staged.group.room_id());
            self.put_record(batch)?;
            // The joiner is a human device from here on and keeps the history it followed as an observer.
            if self.memory.history.is_none() {
                let leaves = rules::leaves_of(group.members())?;
                let state = rules::room_state_of(group.public_group().group_context(), &leaves)?;
                batch.put(history_key(state.epoch), codec::encode(&state)?);
                self.memory.history = Some(RoomHistory::new(state));
                self.keep_key(batch, &staged.group, staged.epoch, staged.key.duplicate());
                return self.put_group(batch, &staged.group);
            }
        }
        self.settle(batch, &staged.group, &group, staged.room_epoch)
    }

    // ---- KeyPackages ----

    /// Makes the KeyPackages this device should publish now, given how many unused single-use ones the hub
    /// still holds: enough to have [`SINGLE_USE_KEY_PACKAGES`], and a last-resort one when none was made in
    /// the last [`LAST_RESORT_FOR_MS`]. Their private parts are written with the outbox entry that publishes
    /// them (13.2). The last-resort one before it is retired when the hub accepted that entry, and its
    /// private part kept [`LAST_RESORT_FOR_MS`] more; a refused entry leaves it the current one. Returns the
    /// entry's id, or none when nothing is due.
    pub fn key_packages_to_upload(
        &mut self,
        unused_at_hub: usize,
        now_ms: u64,
    ) -> Result<Option<u64>, Error> {
        self.transact(|device, batch| {
            let fresh_last_resort = device.memory.key_packages.values().any(|own| {
                own.last_resort
                    && own.retired_ms == 0
                    && now_ms.saturating_sub(own.made_ms) < LAST_RESORT_FOR_MS
            });
            let single_use = SINGLE_USE_KEY_PACKAGES.saturating_sub(unused_at_hub);
            if fresh_last_resort && single_use == 0 {
                return Ok(None);
            }
            let mut parts = vec![Vec::new()];
            if !fresh_last_resort {
                // One that was replaced stays usable for another period, since a Welcome made with it may
                // still come, and goes after it. The one the hub holds now is retired only when the hub
                // took its replacement ([`Device::outbox_accepted`]): until then it is the current one.
                let expired: Vec<Hash32> = device
                    .memory
                    .key_packages
                    .iter()
                    .filter(|(_, own)| {
                        own.last_resort
                            && own.retired_ms != 0
                            && now_ms.saturating_sub(own.retired_ms) >= LAST_RESORT_FOR_MS
                    })
                    .map(|(reference, _)| *reference)
                    .collect();
                for reference in expired {
                    key_package::forget(&device.provider, &reference)?;
                    device.memory.key_packages.remove(&reference);
                    batch.delete(device_key(SUB_KEY_PACKAGE, reference.as_bytes()));
                }
                parts = vec![device.make_key_package(batch, now_ms, true)?];
            }
            for _ in 0..single_use {
                parts.push(device.make_key_package(batch, now_ms, false)?);
            }
            device
                .enqueue(batch, OutboxKind::KeyPackages, None, 0, parts)
                .map(Some)
        })
    }

    /// The hub took `replacement` as this device's last-resort KeyPackage: every one before it is retired from
    /// the time the replacement was made. Its private part stays for [`LAST_RESORT_FOR_MS`] more.
    fn retire_last_resort(&mut self, batch: &mut Batch, replacement: &Hash32) {
        let Some(since) = self
            .memory
            .key_packages
            .get(replacement)
            .map(|own| own.made_ms)
        else {
            return;
        };
        let before: Vec<Hash32> = self
            .memory
            .key_packages
            .iter()
            .filter(|(reference, own)| {
                own.last_resort && own.retired_ms == 0 && *reference != replacement
            })
            .map(|(reference, _)| *reference)
            .collect();
        for reference in before {
            if let Some(own) = self.memory.key_packages.get_mut(&reference) {
                // A time of 0 would read as not retired.
                own.retired_ms = since.max(1);
                let own = own.clone();
                self.put_key_package(batch, &reference, &own);
            }
        }
    }

    /// Makes one KeyPackage that reaches whoever adds this device outside the hub: a helper device's for its
    /// opener (5.3.5), a new device's for its invite (12.1.2). Its private part is stored before it is returned.
    pub fn key_package(&mut self, now_ms: u64) -> Result<Vec<u8>, Error> {
        self.transact(|device, batch| device.make_key_package(batch, now_ms, false))
    }

    fn put_key_package(&self, batch: &mut Batch, reference: &Hash32, own: &OwnKeyPackage) {
        let mut value = Writer::new();
        value.u8(u8::from(own.last_resort));
        value.u64(own.made_ms);
        value.u64(own.retired_ms);
        batch.put(
            device_key(SUB_KEY_PACKAGE, reference.as_bytes()),
            value.into_bytes(),
        );
    }

    fn make_key_package(
        &mut self,
        batch: &mut Batch,
        now_ms: u64,
        last_resort: bool,
    ) -> Result<Vec<u8>, Error> {
        let (bytes, info) = key_package::make(&self.provider, &self.key, now_ms, last_resort)?;
        let own = OwnKeyPackage {
            last_resort,
            made_ms: now_ms,
            retired_ms: 0,
        };
        self.put_key_package(batch, &info.reference, &own);
        self.memory.key_packages.insert(info.reference, own);
        Ok(bytes)
    }

    // ---- founding ----

    /// The `SealedKey` of `epoch`, sealed to the recovery key `to.1` of the room epoch `to.0`.
    fn seal(
        &mut self,
        group: &GroupId,
        epoch: u64,
        content_key: &Secret<32>,
        group_info: &[u8],
        to: (u64, &[u8; RECOVERY_KEY_LEN]),
        human: bool,
    ) -> Result<Vec<u8>, Error> {
        let (room_epoch, recovery_hpke_key) = to;
        let request = SealRequest {
            group,
            epoch,
            content_key,
            group_info,
            room_epoch,
            recovery_hpke_key,
            writer: &self.id,
            writer_is_human: human,
        };
        let recovery = &mut self.recovery;
        let sealed = self
            .provider
            .with_entropy(|entropy| recovery.seal_key(entropy, &request))?;
        if sealed.is_empty() {
            return Err(Error::Incomplete);
        }
        Ok(sealed)
    }

    /// Founds the room (5.1.1) with the recovery public keys of section 8 and posts the GroupInfo of epoch 0
    /// with its `SealedKey`. Returns the room's id, 32 random bytes.
    pub fn found_room(
        &mut self,
        recovery_signature_key: [u8; RECOVERY_KEY_LEN],
        recovery_hpke_key: [u8; RECOVERY_KEY_LEN],
        now_ms: u64,
    ) -> Result<RoomId, Error> {
        self.transact(|device, batch| {
            if device.memory.record.room.is_some() {
                return Err(Error::RoomExists);
            }
            let mut id = [0u8; 32];
            device.provider.fill(&mut id)?;
            let room_id = RoomId::new(id);
            let group_id = GroupId::room(room_id);
            let room = TrommiRoom {
                recovery_signature_key,
                recovery_hpke_key,
                agents: Vec::new(),
            };
            let group = group::create(
                &device.provider,
                &device.key,
                &group_id,
                &GroupKind::Room(room),
                now_ms,
            )?;
            let leaves = rules::leaves_of(group.members())?;
            let state = rules::room_state_of(group.public_group().group_context(), &leaves)?;
            rules::check_room_founding(&state)?;
            let info = group::group_info(&device.provider, &device.key, &group)?;
            let key = group::content_key(&device.provider, &group)?;
            let sealed = device.seal(&group_id, 0, &key, &info, (0, &recovery_hpke_key), true)?;
            device.keep_key(batch, &group_id, 0, key);
            batch.put(history_key(0), codec::encode(&state)?);
            device.memory.history = Some(RoomHistory::new(state));
            device.memory.record.room = Some(room_id);
            device.memory.groups.insert(
                group_id,
                GroupMeta {
                    founding: true,
                    own_leaf_ms: now_ms,
                    ..GroupMeta::default()
                },
            );
            device.put_group(batch, &group_id)?;
            device.enqueue(
                batch,
                OutboxKind::RoomFounding,
                Some(group_id),
                0,
                vec![info, sealed],
            )?;
            Ok(room_id)
        })
    }

    /// Founds a main session (5.2.5) as a human device: one request with the GroupInfo of epoch 0 and the
    /// first Commit, which adds the agent device and every other human device of the room. `key_packages` must
    /// hold exactly one KeyPackage of each of them; a missing one fails the founding (`incomplete`), and it is
    /// tried again with fresh ones.
    pub fn found_session(
        &mut self,
        agent: &DeviceId,
        key_packages: &[Vec<u8>],
        now_ms: u64,
    ) -> Result<SessionId, Error> {
        self.found(SessionId::ZERO, Some(agent), key_packages, now_ms)
    }

    /// Founds a helper session under the main session `parent` as its opener (5.2.5), adding every human
    /// device of the room and the helper devices whose KeyPackages are given.
    pub fn found_helper(
        &mut self,
        parent: &SessionId,
        key_packages: &[Vec<u8>],
        now_ms: u64,
    ) -> Result<SessionId, Error> {
        if parent.is_zero() {
            return Err(Error::BadFormat);
        }
        self.found(*parent, None, key_packages, now_ms)
    }

    fn found(
        &mut self,
        parent: SessionId,
        agent: Option<&DeviceId>,
        key_packages: &[Vec<u8>],
        now_ms: u64,
    ) -> Result<SessionId, Error> {
        self.transact(|device, batch| {
            let room_id = device.memory.record.room.ok_or(Error::NoRoom)?;
            let room = device.history()?.newest().clone();
            let human = room.is_human(&device.id);
            if human != parent.is_zero() {
                return Err(Error::Forbidden);
            }
            let mut adds = Vec::new();
            let mut added = BTreeSet::new();
            for bytes in key_packages {
                let (package, info) = key_package::validated(bytes)?;
                if !added.insert(info.device) {
                    return Err(Error::BadKeyPackage);
                }
                adds.push(package);
            }
            // All or nothing: every other human device, and for a main session its agent device.
            let needed = room
                .humans
                .iter()
                .chain(agent)
                .filter(|needed| **needed != device.id);
            if !needed.clone().all(|needed| added.contains(needed)) {
                return Err(Error::Incomplete);
            }
            let mut id = [0u8; 16];
            device.provider.fill(&mut id)?;
            let session = TrommiSession {
                room_id,
                session_id: SessionId::new(id),
                parent,
            };
            let group_id = session.group_id();
            let mut group = group::create(
                &device.provider,
                &device.key,
                &group_id,
                &GroupKind::Session(session),
                now_ms,
            )?;
            let info_0 = group::group_info(&device.provider, &device.key, &group)?;
            let key_0 = group::content_key(&device.provider, &group)?;
            let hpke = room.room.recovery_hpke_key;
            let sealed_0 =
                device.seal(&group_id, 0, &key_0, &info_0, (room.epoch, &hpke), human)?;
            let note = CommitNote {
                room_epoch: room.epoch,
                room_state: room.state,
                time: now_ms,
                cuts: Vec::new(),
                join: false,
            };
            let change = Change {
                adds,
                ..Change::default()
            };
            let built = group::commit(&device.provider, &device.key, &mut group, &note, change)?;
            let sealed = device.seal(
                &group_id,
                1,
                &built.next_key,
                &built.group_info,
                (room.epoch, &hpke),
                human,
            )?;
            device.keep_key(batch, &group_id, 0, key_0);
            let outbox = device.enqueue(
                batch,
                OutboxKind::GroupFounding,
                Some(group_id),
                0,
                vec![
                    info_0,
                    sealed_0,
                    built.commit,
                    built.group_info,
                    built.welcome.unwrap_or_default(),
                    sealed,
                ],
            )?;
            device.memory.groups.insert(
                group_id,
                GroupMeta {
                    session: Some(session),
                    founding: true,
                    own_leaf_ms: now_ms,
                    pending: Some(Pending {
                        outbox,
                        room_epoch: room.epoch,
                        time: now_ms,
                        awaiting_log: false,
                        // The founder's leaf is as old as the group; the first Commit only adds.
                        renews_leaf: false,
                    }),
                    ..GroupMeta::default()
                },
            );
            device.put_group(batch, &group_id)?;
            Ok(session.session_id)
        })
    }

    // ---- Commits ----

    /// Builds one Commit in `group`, leaves it pending and puts it in the outbox with its GroupInfo, Welcome
    /// and `SealedKey`. `cuts` name the leaves it removes; `context` a new room extension.
    fn commit(
        &mut self,
        batch: &mut Batch,
        id: &GroupId,
        adds: Vec<KeyPackage>,
        cuts: &[Cut],
        context: Option<TrommiRoom>,
        now_ms: u64,
    ) -> Result<u64, Error> {
        let meta = self.meta(id)?.clone();
        if meta.archived {
            return Err(Error::Gone);
        }
        if meta.pending.is_some() || meta.founding {
            return Err(Error::Busy);
        }
        let room = self.history()?.newest().clone();
        let human = room.is_human(&self.id);
        let mut cuts = cuts.to_vec();
        cuts.sort_unstable_by_key(|cut| cut.device);
        let removes: Vec<DeviceId> = cuts.iter().map(|cut| cut.device).collect();
        let mut group = group::load(&self.provider, id)?;
        // 5.2.8: nobody writes into a stale group but the Commit that removes every leaf the room disallows.
        let leaves: BTreeSet<DeviceId> = rules::leaves_of(group.members())?
            .into_iter()
            .map(|(_, device)| device)
            .collect();
        let unfit = self.disallowed(&meta, &leaves, &self.known());
        if !unfit.iter().all(|leaf| removes.contains(leaf)) {
            return Err(Error::StaleSession);
        }
        // 5.2.6: a group that failed its first contact takes only the Commit that removes leaves from it.
        if meta.distrusted && removes.is_empty() {
            return Err(Error::BadGroup);
        }
        let note = CommitNote {
            room_epoch: room.epoch,
            room_state: room.state,
            time: now_ms,
            cuts,
            join: false,
        };
        let kind = context.map(GroupKind::Room);
        // 3.4: a Commit that only adds has no path, and so leaves the committer's leaf as it is.
        let renews_leaf = adds.is_empty() || !removes.is_empty() || kind.is_some();
        let change = Change {
            adds,
            removes: &removes,
            context: kind.as_ref(),
        };
        let built = group::commit(&self.provider, &self.key, &mut group, &note, change)?;
        // 8.2: a room Commit that replaces the recovery keys seals its new epoch to the new key, and its row
        // names the new room epoch.
        let (sealed_epoch, hpke) = match &kind {
            Some(GroupKind::Room(new)) if new.recovery_hpke_key != room.room.recovery_hpke_key => {
                (room.epoch.saturating_add(1), new.recovery_hpke_key)
            }
            _ => (room.epoch, room.room.recovery_hpke_key),
        };
        let Built {
            epoch,
            commit,
            group_info,
            welcome,
            next_key,
        } = built;
        let sealed = self.seal(
            id,
            epoch.saturating_add(1),
            &next_key,
            &group_info,
            (sealed_epoch, &hpke),
            human,
        )?;
        let outbox = self.enqueue(
            batch,
            OutboxKind::Commit,
            Some(*id),
            epoch,
            vec![commit, group_info, welcome.unwrap_or_default(), sealed],
        )?;
        self.meta(id)?.pending = Some(Pending {
            outbox,
            room_epoch: room.epoch,
            time: now_ms,
            awaiting_log: false,
            renews_leaf,
        });
        self.put_group(batch, id)?;
        Ok(outbox)
    }

    fn room_group(&self) -> Result<GroupId, Error> {
        let room = self.memory.record.room.ok_or(Error::NoRoom)?;
        if !self.is_human() {
            return Err(Error::Forbidden);
        }
        Ok(GroupId::room(room))
    }

    /// Adds the human device `device` to the room group with its KeyPackage (5.1.2, 12.1.5), which must verify
    /// and be that device's (4.5). The caller then hands the history over ([`Device::send_handover`]) and adds
    /// it to every live session group ([`Device::add_to_session`]).
    pub fn add_human_device(
        &mut self,
        device: &DeviceId,
        key_package: &[u8],
        now_ms: u64,
    ) -> Result<u64, Error> {
        self.transact(|this, batch| {
            let group = this.room_group()?;
            let history = this.history()?;
            let room = history.newest();
            if room.is_agent(device) || history.is_revoked(device, room.epoch) {
                return Err(Error::BadCommit);
            }
            if room.humans.len() >= MAX_HUMAN_DEVICES {
                return Err(Error::TooMany);
            }
            key_package::verify_key_package_of(key_package, device)?;
            let (package, _) = key_package::validated(key_package)?;
            this.commit(batch, &group, vec![package], &[], None, now_ms)
        })
    }

    /// Adds `device` to the session group `group` with its KeyPackage: a human device missing from a live
    /// session (5.2.7), by any human device of the group; or a helper device, by the opener (5.2.4).
    pub fn add_to_session(
        &mut self,
        group: &GroupId,
        device: &DeviceId,
        key_package: &[u8],
        now_ms: u64,
    ) -> Result<u64, Error> {
        self.transact(|this, batch| {
            if group.is_room() {
                return Err(Error::BadFormat);
            }
            key_package::verify_key_package_of(key_package, device)?;
            let (package, _) = key_package::validated(key_package)?;
            this.commit(batch, group, vec![package], &[], None, now_ms)
        })
    }

    /// Changes the room's enrolled agent devices (5.1.2): `enrol` are added to `agents`, `remove` taken out.
    /// Removing one makes its main session and the helper sessions it opened stale (5.3.1).
    pub fn change_agents(
        &mut self,
        enrol: &[DeviceId],
        remove: &[DeviceId],
        now_ms: u64,
    ) -> Result<u64, Error> {
        self.transact(|this, batch| {
            let group = this.room_group()?;
            let mut room = this.history()?.newest().room.clone();
            let mut agents: BTreeSet<DeviceId> = room.agents.iter().copied().collect();
            for gone in remove {
                if !agents.remove(gone) {
                    return Err(Error::NotMember);
                }
            }
            agents.extend(enrol.iter().copied());
            room.agents = agents.into_iter().collect();
            this.commit(batch, &group, Vec::new(), &[], Some(room), now_ms)
        })
    }

    /// Removes human devices from the room group (5.2.8), each with its Cut there. This is the first Commit of
    /// a removal: the session groups that hold the device are stale from it on, and the caller finishes each
    /// with [`Device::clean_session`] once this Commit was accepted.
    pub fn remove_human_devices(&mut self, cuts: &[Cut], now_ms: u64) -> Result<u64, Error> {
        self.transact(|this, batch| {
            let group = this.room_group()?;
            if cuts.is_empty() || cuts.iter().any(|cut| cut.device == this.id) {
                return Err(Error::BadCommit);
            }
            this.commit(batch, &group, Vec::new(), cuts, None, now_ms)
        })
    }

    /// The Commit that makes a stale session group live again (5.2.8, 5.3.1): it removes every leaf the room
    /// state does not allow, each with its Cut, and may add one device in the same Commit: the agent device
    /// that takes a main session over, or a helper session's new opener. `cuts` must name exactly the leaves
    /// to go. Any human device of the group may commit it, so a removal that another device began is finished
    /// by whoever comes next.
    pub fn clean_session(
        &mut self,
        group: &GroupId,
        cuts: &[Cut],
        replacement: Option<(&DeviceId, &[u8])>,
        now_ms: u64,
    ) -> Result<u64, Error> {
        self.transact(|this, batch| {
            if group.is_room() || !this.is_human() {
                return Err(Error::Forbidden);
            }
            let summary = this.group(group)?;
            let named: BTreeSet<DeviceId> = cuts.iter().map(|cut| cut.device).collect();
            if named != summary.disallowed.iter().copied().collect() {
                return Err(Error::BadCommit);
            }
            let mut adds = Vec::new();
            if let Some((device, key_package)) = replacement {
                key_package::verify_key_package_of(key_package, device)?;
                adds.push(key_package::validated(key_package)?.0);
            }
            if adds.is_empty() && cuts.is_empty() {
                return Err(Error::BadCommit);
            }
            this.commit(batch, group, adds, cuts, None, now_ms)
        })
    }

    /// The opener replaces a helper device that lost its state (5.3.5): Remove of the old leaf with its Cut
    /// and Add of the new device in one Commit. A handover follows. Only the session's opener does this
    /// (`forbidden`). The device that comes back has a new key (4.3), and the leaf that goes is a helper
    /// device's: the same key again, a human device's leaf or the opener's own is `bad-commit`.
    pub fn readmit_helper(
        &mut self,
        group: &GroupId,
        old: Cut,
        device: &DeviceId,
        key_package: &[u8],
        now_ms: u64,
    ) -> Result<u64, Error> {
        self.transact(|this, batch| {
            let session = this.meta(group)?.session;
            if !session.is_some_and(|session| this.opens(&session)) {
                return Err(Error::Forbidden);
            }
            let human = this.history()?.newest().is_human(&old.device);
            if *device == old.device || old.device == this.id || human {
                return Err(Error::BadCommit);
            }
            key_package::verify_key_package_of(key_package, device)?;
            let (package, _) = key_package::validated(key_package)?;
            this.commit(batch, group, vec![package], &[old], None, now_ms)
        })
    }

    /// The own-leaf update of a human device (5.2.9): an empty Commit when its leaf in `group` is older than
    /// seven days and its last update there older than a day, or at once when `forced` (after 5 000 stroke
    /// pieces in an epoch, or `epoch-full`). A leaf's age counts from the device's last Commit there that had
    /// a path (an Add alone has none and renews nothing), or from its founding or joining the group. Agent
    /// and helper devices make no Commit for an update (`forbidden`). Returns none when nothing is due.
    pub fn update(
        &mut self,
        group: &GroupId,
        forced: bool,
        now_ms: u64,
    ) -> Result<Option<u64>, Error> {
        self.transact(|this, batch| {
            if !this.is_human() {
                return Err(Error::Forbidden);
            }
            let meta = this.meta(group)?;
            let due = now_ms.saturating_sub(meta.own_leaf_ms) >= UPDATE_AFTER_MS
                && now_ms.saturating_sub(meta.last_update_ms) >= UPDATE_AT_MOST_EVERY_MS;
            if !due && !forced {
                return Ok(None);
            }
            meta.last_update_ms = now_ms;
            this.commit(batch, group, Vec::new(), &[], None, now_ms)
                .map(Some)
        })
    }

    /// Records that a human device archived the session (5.2.10): the device commits and sends nothing more in
    /// its group (`gone`). The group's keys stay.
    pub fn archive(&mut self, group: &GroupId) -> Result<(), Error> {
        self.transact(|this, batch| {
            if group.is_room() {
                return Err(Error::BadFormat);
            }
            this.meta(group)?.archived = true;
            this.put_group(batch, group)
        })
    }

    // ---- joining ----

    /// Joins the group a Welcome is for (12.1.5, 5.2.6). The Welcome must be for one of this device's
    /// KeyPackages, for a group of the expected room that this device does not hold, and committed by the
    /// expected device; one above [`MAX_COMMIT_REQUEST_LEN`] is `too-large` and is not parsed. A room group
    /// with more than 32 human or 256 agent devices is refused (`too-many`). A Welcome that is refused or does not open still uses up its single-use KeyPackage
    /// (3.7): the device then asks to be added again.
    pub fn join_welcome(
        &mut self,
        welcome: &[u8],
        expected: &WelcomeExpectation,
        now_ms: u64,
    ) -> Result<Joined, Error> {
        self.transact(|this, batch| {
            // Section 16: nothing above the limit of a Commit's request is parsed.
            if welcome.len() > MAX_COMMIT_REQUEST_LEN {
                return Err(Error::TooLarge);
            }
            let own: Vec<Hash32> = group::welcome_recipients(welcome)?
                .iter()
                .filter_map(|reference| Hash32::from_slice(reference).ok())
                .filter(|reference| this.memory.key_packages.contains_key(reference))
                .collect();
            if own.is_empty() {
                return Err(Error::NotMember);
            }
            let before = this.provider.entries();
            let joined = this.join(batch, welcome, expected, now_ms);
            if joined.is_err() {
                // The refusal stands, and so does the loss of the single-use KeyPackage.
                this.provider.restore(before);
                for reference in own {
                    let single_use = this
                        .memory
                        .key_packages
                        .get(&reference)
                        .is_some_and(|own| !own.last_resort);
                    if single_use {
                        key_package::forget(&this.provider, &reference)?;
                        this.memory.key_packages.remove(&reference);
                        batch.delete(device_key(SUB_KEY_PACKAGE, reference.as_bytes()));
                    }
                }
            }
            Ok(joined)
        })?
    }

    fn join(
        &mut self,
        batch: &mut Batch,
        welcome: &[u8],
        expected: &WelcomeExpectation,
        now_ms: u64,
    ) -> Result<Joined, Error> {
        let staged = group::stage_welcome(&self.provider, welcome)?;
        let (id, kind) =
            profile::kind_of_context(staged.group_context()).map_err(|_| Error::BadGroup)?;
        if id.room_id() != expected.room
            || self
                .memory
                .record
                .room
                .is_some_and(|room| room != expected.room)
        {
            return Err(Error::WrongRoom);
        }
        // A Welcome never replaces a group this device holds.
        if self.memory.groups.contains_key(&id) {
            return Err(Error::Replay);
        }
        let leaves = rules::leaves_of(staged.members())?;
        let added_by = staged
            .welcome_sender()
            .ok()
            .and_then(key_package::leaf_device)
            .ok_or(Error::BadGroup)?;
        if expected
            .committer
            .is_some_and(|committer| committer != added_by)
        {
            return Err(Error::BadInvite);
        }
        let devices: BTreeSet<DeviceId> = leaves.iter().map(|(_, device)| *device).collect();
        if !devices.contains(&self.id) || devices.len() != leaves.len() {
            return Err(Error::BadGroup);
        }
        let epoch = staged.group_context().epoch().as_u64();
        let mut meta = GroupMeta {
            own_leaf_ms: now_ms,
            joined_epoch: epoch,
            ..GroupMeta::default()
        };
        let mut offending = Vec::new();
        match kind {
            GroupKind::Room(_) => {
                let state = rules::room_state_of(staged.group_context(), &leaves)?;
                // Section 16: a device is added to a room of at most 32 human and 256 agent devices.
                if state.humans.len() > MAX_HUMAN_DEVICES
                    || state.room.agents.len() > MAX_AGENT_DEVICES
                {
                    return Err(Error::TooMany);
                }
                batch.put(history_key(state.epoch), codec::encode(&state)?);
                self.memory.history = Some(RoomHistory::new(state));
                self.memory.record.room = Some(expected.room);
                self.put_record(batch)?;
            }
            GroupKind::Session(session) => {
                let known = self.known();
                let history = self.history()?;
                let room = history.newest();
                meta.session = Some(session);
                if session.parent.is_zero() {
                    meta.seats
                        .push((0, observer::seat(&session, &leaves, room)));
                }
                // 5.2.6: the group must obey the rules of its kind, and a helper session must have been
                // made by its main session's agent leaf, the only non-human device that adds anyone.
                offending = self.unfit_at_first_contact(&meta, &devices, &known);
                let by_human = room.is_human(&added_by);
                let by_opener = !session.parent.is_zero()
                    && !offending.contains(&added_by)
                    && room.is_agent(&added_by);
                if !by_human && !by_opener && !offending.contains(&added_by) {
                    offending.push(added_by);
                }
                meta.distrusted = !offending.is_empty();
            }
        }
        let group = staged
            .into_group(&self.provider)
            .map_err(|_| Error::BadGroup)?;
        let key = group::content_key(&self.provider, &group)?;
        self.keep_key(batch, &id, epoch, key);
        self.memory.groups.insert(id, meta);
        self.put_group(batch, &id)?;
        // The KeyPackage's private part is gone from OpenMLS's storage unless it is the last-resort one.
        let used: Vec<Hash32> = self
            .memory
            .key_packages
            .iter()
            .filter(|(_, own)| !own.last_resort)
            .map(|(reference, _)| *reference)
            .filter(|reference| {
                group::welcome_recipients(welcome)
                    .is_ok_and(|named| named.iter().any(|name| name == reference.as_bytes()))
            })
            .collect();
        for reference in used {
            self.memory.key_packages.remove(&reference);
            batch.delete(device_key(SUB_KEY_PACKAGE, reference.as_bytes()));
        }
        Ok(Joined {
            group: id,
            epoch,
            added_by,
            offending,
        })
    }

    /// Starts following the room group as an observer (4.4, 12.1.6), for a device that is not a human device:
    /// from the GroupInfo of the epoch it was told, which must hash to `expected_state`.
    pub fn observe_room(
        &mut self,
        group_info: &[u8],
        expected_state: Option<&Hash32>,
    ) -> Result<(), Error> {
        self.transact(|this, batch| {
            let observer = Observer::follow_room(group_info, expected_state)?;
            let group = observer.group();
            let known_room = this.memory.record.room;
            if this.memory.history.is_some()
                || this.memory.observers.contains_key(&group)
                || known_room.is_some_and(|room| room != group.room_id())
            {
                return Err(Error::RoomExists);
            }
            this.memory.record.room = Some(group.room_id());
            this.put_record(batch)?;
            this.memory.observers.insert(group, observer);
            Ok(())
        })
    }

    /// Starts following a main session's group as an observer, as a helper device does for the session its
    /// helper session hangs under (4.4).
    pub fn observe_session(&mut self, group_info: &[u8]) -> Result<(), Error> {
        self.transact(|this, _| {
            let room = this.history()?.newest().clone();
            let observer = Observer::follow_session(group_info, &room)?;
            let group = observer.group();
            if group.room_id() != this.memory.record.room.ok_or(Error::NoRoom)?
                || this.memory.observers.contains_key(&group)
                || this.memory.groups.contains_key(&group)
            {
                return Err(Error::Replay);
            }
            this.memory.observers.insert(group, observer);
            Ok(())
        })
    }

    /// Builds a join from outside into the group of `group_info` (3.4, 8.4) on a copy of the state: nothing
    /// of the real state changes until the hub accepted it. Refused before anything is built: a group this
    /// device archived (`gone`), and a GroupInfo whose tree holds a leaf of this device's key (`bad-commit`). `authorise` is handed the Commit as it will be
    /// posted and the note it carries, and returns the `RecoveryAuth` to post with it. The device must follow
    /// the room group, as an observer or a member, so that the note names a room state it verified.
    pub fn join_from_outside(
        &mut self,
        group_info: &[u8],
        now_ms: u64,
        authorise: &mut Authorise<'_>,
    ) -> Result<u64, Error> {
        self.transact(|this, batch| {
            let room = this.history()?.newest().clone();
            let verifiable = observer::parse_group_info(group_info)?;
            let (id, _) = profile::kind_of_context(verifiable.group_context())
                .map_err(|_| Error::BadGroup)?;
            if this.memory.record.room != Some(id.room_id()) {
                return Err(Error::WrongRoom);
            }
            if this.memory.staged.values().any(|staged| staged.group == id) {
                return Err(Error::Busy);
            }
            // 5.2.10: an archived session is not reopened.
            if this
                .memory
                .groups
                .get(&id)
                .is_some_and(|meta| meta.archived)
            {
                return Err(Error::Gone);
            }
            // 4.3: a device that lost its state comes back under a new key. With a leaf of this key in the
            // tree the join would remove that leaf, and a Remove needs the Cut that only the others hold.
            if group::tree_holds(&verifiable, &this.id) {
                return Err(Error::BadCommit);
            }
            let note = CommitNote {
                room_epoch: room.epoch,
                room_state: room.state,
                time: now_ms,
                cuts: Vec::new(),
                join: true,
            };
            let before = this.provider.entries();
            let result = group::external_commit(&this.provider, &this.key, group_info, &note);
            let (put, delete) = this.provider.changes(&before);
            this.provider.restore(before);
            let (_, built) = result?;
            let recovery_auth = authorise(&built.commit, &note)?;
            let human = true;
            let sealed = this.seal(
                &id,
                built.epoch.saturating_add(1),
                &built.next_key,
                &built.group_info,
                (room.epoch, &room.room.recovery_hpke_key),
                human,
            )?;
            let outbox = this.enqueue(
                batch,
                OutboxKind::ExternalCommit,
                Some(id),
                built.epoch,
                vec![built.commit, built.group_info, sealed, recovery_auth],
            )?;
            let staged = Staged {
                group: id,
                epoch: built.epoch.saturating_add(1),
                room_epoch: room.epoch,
                key: built.next_key,
                put,
                delete,
            };
            batch.put(
                device_key(SUB_STAGED, &outbox.to_be_bytes()),
                codec::encode(&staged)?,
            );
            this.memory.staged.insert(outbox, staged);
            Ok(outbox)
        })
    }

    // ---- the log ----

    /// Processes one entry of the hub's ordered log (5.4.1, 13.2): the group state after it, the content key of
    /// a new epoch and the cursor are written together. Entries are handed in the hub's order across groups; a
    /// Commit that is not the next of its group, or a session Commit whose room epoch this device has not
    /// reached, is refused and changes nothing ([`log_finding`]).
    pub fn process_log_entry(&mut self, entry: &LogEntry<'_>) -> Result<Processed, Error> {
        self.transact(|this, batch| {
            let processed = match entry.kind {
                LogKind::Commit {
                    bytes,
                    recovery_auth,
                } => {
                    if this.memory.observers.contains_key(&entry.group) {
                        this.observe_commit(&entry.group, bytes, recovery_auth)?
                    } else if this
                        .memory
                        .groups
                        .get(&entry.group)
                        .is_some_and(|meta| !meta.removed)
                    {
                        this.process_commit(batch, &entry.group, bytes, recovery_auth)?
                    } else {
                        Processed::Skipped
                    }
                }
                LogKind::Message { bytes } => {
                    if this
                        .memory
                        .groups
                        .get(&entry.group)
                        .is_some_and(|meta| !meta.removed)
                    {
                        this.process_message(batch, &entry.group, bytes)?
                    } else {
                        Processed::Skipped
                    }
                }
            };
            this.advance(batch, entry.change)?;
            Ok(processed)
        })
    }

    fn observe_commit(
        &mut self,
        group: &GroupId,
        commit: &[u8],
        recovery_auth: Option<&[u8]>,
    ) -> Result<Processed, Error> {
        let known = self.known();
        let room = if group.is_room() {
            None
        } else {
            self.room_history().cloned()
        };
        let context = Context {
            room: room.as_ref(),
            sessions: &known,
            recovery: self.recovery.rules(),
            max_human_devices: profile::MAX_HUMAN_DEVICES_IN_RECOVERY,
        };
        let observer = self
            .memory
            .observers
            .get_mut(group)
            .ok_or(Error::NotFound)?;
        match observer.process_commit(commit, recovery_auth, &context) {
            Ok(facts) => Ok(Processed::Observed(facts)),
            Err(Error::EpochTaken) => Err(Error::WrongEpoch),
            Err(error) => Err(error),
        }
    }

    fn process_commit(
        &mut self,
        batch: &mut Batch,
        id: &GroupId,
        commit: &[u8],
        recovery_auth: Option<&[u8]>,
    ) -> Result<Processed, Error> {
        let message = rules::parse_commit(commit)?;
        if GroupId::from_bytes(message.group_id().as_slice()) != Ok(*id) {
            return Err(Error::BadCommit);
        }
        let mut group = group::load(&self.provider, id)?;
        let epoch = group.epoch().as_u64();
        let named = message.epoch().as_u64();
        let meta = self.meta(id)?.clone();
        if named < meta.joined_epoch {
            return Ok(Processed::Skipped);
        }
        if named < epoch {
            // An own Commit that was merged when the hub accepted it comes by again in the log.
            let own = meta.last_commit == Some((named, crypto::sha256(commit)?));
            return if own {
                Ok(Processed::OwnCommit)
            } else {
                Err(Error::WrongEpoch)
            };
        }
        if named > epoch {
            return Err(Error::GroupBehind);
        }
        // 13.2: the Commit that took the epoch is this device's own, or the pending one goes.
        let mut superseded = None;
        if let Some(pending) = &meta.pending {
            let own = self
                .memory
                .outbox
                .get(&pending.outbox)
                .is_some_and(|entry| {
                    let at = usize::from(entry.kind == OutboxKind::GroupFounding).saturating_mul(2);
                    entry.parts.get(at).is_some_and(|own| own == commit)
                });
            let outbox = pending.outbox;
            if own {
                self.merge_own(batch, id)?;
                self.drop_outbox(batch, outbox);
                return Ok(Processed::OwnCommit);
            }
            self.clear_pending(batch, id)?;
            self.drop_outbox(batch, outbox);
            superseded = Some(outbox);
            group = group::load(&self.provider, id)?;
        }
        let leaves = rules::leaves_of(group.members())?;
        let processed = group
            .process_message(&self.provider, message)
            .map_err(|_| Error::BadGroup)?;
        let ProcessedMessageContent::StagedCommitMessage(staged) = processed.content() else {
            return Err(Error::BadGroup);
        };
        let facts = rules::commit_facts(id, &leaves, &processed, staged)?;
        let known = self.known();
        let verifier = Verifier {
            history: self.history()?,
            sessions: &known,
            recovery: self.recovery.rules(),
            max_human_devices: profile::MAX_HUMAN_DEVICES_IN_RECOVERY,
            posting: false,
        };
        let judged = Judged {
            facts: &facts,
            commit,
            recovery_auth,
        };
        match meta.session {
            None => rules::check_room_commit(&verifier, &judged)?,
            Some(session) => rules::check_session_commit(
                &verifier,
                &SessionBefore {
                    session,
                    leaves: leaves.iter().map(|(_, device)| *device).collect(),
                    previous_room_epoch: meta.previous_room_epoch,
                },
                &judged,
            )?,
        }
        let ProcessedMessageContent::StagedCommitMessage(staged) = processed.into_content() else {
            return Err(Error::BadGroup);
        };
        group
            .merge_staged_commit(&self.provider, *staged)
            .map_err(|_| Error::BadGroup)?;
        let room_epoch = facts.note.as_ref().map_or(0, |note| note.room_epoch);
        if self.meta(id)?.distrusted {
            // The offending leaves of a first contact may be gone now.
            let after: BTreeSet<DeviceId> = rules::leaves_of(group.members())?
                .into_iter()
                .map(|(_, device)| device)
                .collect();
            let meta = self.meta(id)?.clone();
            let clean = self
                .unfit_at_first_contact(&meta, &after, &known)
                .is_empty();
            self.meta(id)?.distrusted = !clean;
        }
        let removed = !group.is_active();
        self.settle(batch, id, &group, room_epoch)?;
        Ok(Processed::Commit {
            facts,
            superseded,
            removed,
        })
    }

    // ---- application messages ----

    fn process_message(
        &mut self,
        batch: &mut Batch,
        id: &GroupId,
        bytes: &[u8],
    ) -> Result<Processed, Error> {
        if bytes.len() > MAX_MESSAGE_LEN {
            return Ok(Processed::Skipped);
        }
        let parsed = openmls::prelude::MlsMessageIn::tls_deserialize_exact(bytes)
            .ok()
            .and_then(|message| message.try_into_protocol_message().ok());
        let Some(message @ ProtocolMessage::PrivateMessage(_)) = parsed else {
            return Ok(Processed::Skipped);
        };
        let mut group = group::load(&self.provider, id)?;
        if message.epoch().as_u64() > group.epoch().as_u64() {
            return Err(Error::GroupBehind);
        }
        // 5.2.6: the content of a group that failed its first contact is never opened.
        if self.meta(id)?.distrusted {
            return Ok(Processed::Skipped);
        }
        let leaves = rules::leaves_of(group.members())?;
        let before = self.provider.entries();
        let Ok(processed) = group.process_message(&self.provider, message) else {
            // 7.0: a receiver that cannot open a message skips it.
            self.provider.restore(before);
            return Ok(Processed::Skipped);
        };
        let from = match processed.sender() {
            Sender::Member(index) => leaves
                .iter()
                .find(|(at, _)| at == index)
                .map(|(_, device)| *device),
            _ => None,
        };
        let (Some(from), ProcessedMessageContent::ApplicationMessage(content)) =
            (from, processed.into_content())
        else {
            return Ok(Processed::Skipped);
        };
        let content = content.into_bytes();
        let message = match codec::decode::<TrommiMessage>(&content, MAX_MESSAGE_LEN) {
            Ok(message) => message,
            Err(Error::NewerVersion) => {
                return Ok(Processed::Message(Received::NewerVersion { from }))
            }
            Err(_) => return Ok(Processed::Message(Received::Dropped)),
        };
        let received = self.take_message(batch, id, &group, from, message)?;
        Ok(Processed::Message(received))
    }

    /// The acceptance rules of 7.1 to 7.4.
    fn take_message(
        &mut self,
        batch: &mut Batch,
        id: &GroupId,
        group: &MlsGroup,
        from: DeviceId,
        message: TrommiMessage,
    ) -> Result<Received, Error> {
        let room = self.history()?.newest().clone();
        let from_human = room.is_human(&from);
        let session = self.meta(id)?.session;
        let helper = session.is_some_and(|session| !session.parent.is_zero());
        let from_opener = helper && !from_human && {
            let known = self.known();
            let parent = session.map_or(Parent::NotAMainSession, |session| {
                known.main_session(&session.parent, room.epoch)
            });
            match parent {
                Parent::Seat(seat) => seat == Some(from),
                Parent::Unknown => room.is_agent(&from),
                Parent::NotAMainSession => false,
            }
        };
        Ok(match message {
            TrommiMessage::KeyHandover {
                recipient,
                keys,
                last,
            } => {
                // Keys come only from a human device, or in a helper session from its opener.
                if recipient != self.id || !(from_human || from_opener) {
                    return Ok(Received::Dropped);
                }
                let own_epoch = group.epoch().as_u64();
                let human = room.is_human(&self.id);
                let mut taken = 0usize;
                for key in keys {
                    // In a session group only that group's keys travel; an agent or helper device takes
                    // no key of another group anywhere.
                    let here = key.group == *id;
                    if !here && (!human || session.is_some()) {
                        continue;
                    }
                    if key.group.room_id() != id.room_id() {
                        continue;
                    }
                    // Only for an epoch that group has reached.
                    let reached = if here {
                        Some(own_epoch)
                    } else {
                        group::load(&self.provider, &key.group)
                            .ok()
                            .map(|other| other.epoch().as_u64())
                    };
                    if reached.is_some_and(|reached| key.epoch > reached) {
                        continue;
                    }
                    if self.keep_key(batch, &key.group, key.epoch, key.content_key) {
                        taken = taken.saturating_add(1);
                    }
                }
                Received::Keys { from, taken, last }
            }
            TrommiMessage::StrokePiece { board, piece } if session.is_none() && from_human => {
                Received::StrokePiece { from, board, piece }
            }
            TrommiMessage::WorkTrail {
                turn,
                number,
                time,
                step,
            } if session.is_some() && !from_human && number != 0 => Received::WorkTrail {
                from,
                turn,
                number,
                time,
                step,
            },
            TrommiMessage::RecoveryAuth {
                recipient,
                recovery_hpke_key,
                recovery_mac,
            } if session.is_none()
                && from_human
                && (recipient == self.id || recipient.is_zero())
                && recovery_hpke_key == room.room.recovery_hpke_key =>
            {
                Received::RecoveryAuth {
                    from,
                    recovery_hpke_key,
                    recovery_mac,
                }
            }
            _ => Received::Dropped,
        })
    }

    /// Encrypts one application message in `group` and puts it in the outbox with the ratchet state after it.
    /// `busy` while a Commit of this device in the group waits for the hub or the log, or its founding is
    /// unanswered; `bad-group` in a group that failed its first contact; `stale-session` in a stale one.
    fn send(
        &mut self,
        batch: &mut Batch,
        id: &GroupId,
        message: &TrommiMessage,
        relay: bool,
    ) -> Result<u64, Error> {
        let meta = self.meta(id)?.clone();
        if meta.archived {
            return Err(Error::Gone);
        }
        // A message made now would be of the epoch a pending Commit ends, and reach the hub after it.
        if meta.founding || meta.pending.is_some() {
            return Err(Error::Busy);
        }
        // 5.2.6: nothing is written into a group that failed its first contact.
        if meta.distrusted {
            return Err(Error::BadGroup);
        }
        let mut group = group::load(&self.provider, id)?;
        let leaves: BTreeSet<DeviceId> = rules::leaves_of(group.members())?
            .into_iter()
            .map(|(_, device)| device)
            .collect();
        if !self.disallowed(&meta, &leaves, &self.known()).is_empty() {
            return Err(Error::StaleSession);
        }
        let plaintext = codec::encode(message)?;
        if plaintext.len() > MAX_MESSAGE_LEN {
            return Err(Error::TooLarge);
        }
        let sealed = group
            .create_message(&self.provider, &DeviceSigner(&self.key), &plaintext)
            .map_err(|_| Error::Busy)?
            .tls_serialize_detached()
            .map_err(|_| Error::Internal("message encoding"))?;
        if sealed.len() > MAX_MESSAGE_LEN {
            return Err(Error::TooLarge);
        }
        let kind = if relay {
            OutboxKind::RelayMessage
        } else {
            OutboxKind::Message
        };
        self.enqueue(batch, kind, Some(*id), group.epoch().as_u64(), vec![sealed])
    }

    /// Hands old content keys to `recipient` in `group` (7.1), in as many messages as needed. In the room
    /// group a human device sends every key it holds for every group of the room; in a session group a human
    /// device, or a helper session's opener, sends that group's keys; any other device is `forbidden`. What was sent is remembered until
    /// [`Device::handover_read`]. Returns the outbox ids.
    pub fn send_handover(
        &mut self,
        group: &GroupId,
        recipient: &DeviceId,
    ) -> Result<Vec<u64>, Error> {
        self.transact(|this, batch| {
            let human = this.is_human();
            let session = this.meta(group)?.session;
            if !human && !session.is_some_and(|session| this.opens(&session)) {
                return Err(Error::Forbidden);
            }
            let keys: Vec<EpochKey> = this
                .memory
                .keys
                .iter()
                .filter(|((of, _), _)| of == group || (group.is_room() && human))
                .map(|((of, epoch), key)| EpochKey {
                    group: *of,
                    epoch: *epoch,
                    content_key: key.duplicate(),
                })
                .collect();
            let mut chunks: Vec<Vec<EpochKey>> = Vec::new();
            for key in keys {
                match chunks.last_mut() {
                    Some(chunk) if chunk.len() < MAX_HANDOVER_KEYS => chunk.push(key),
                    _ => chunks.push(vec![key]),
                }
            }
            if chunks.is_empty() {
                chunks.push(Vec::new());
            }
            let count = chunks.len();
            let mut ids = Vec::new();
            for (at, keys) in chunks.into_iter().enumerate() {
                let message = TrommiMessage::KeyHandover {
                    recipient: *recipient,
                    keys,
                    last: at.saturating_add(1) == count,
                };
                ids.push(this.send(batch, group, &message, false)?);
            }
            this.memory.sent.insert((*recipient, *group));
            batch.put(
                device_key(SUB_SENT, &[recipient.as_bytes(), group.as_bytes()].concat()),
                Vec::new(),
            );
            Ok(ids)
        })
    }

    /// The handovers this device sent and whose recipient is not yet known to read: recipient and group.
    pub fn handovers_sent(&self) -> Vec<(DeviceId, GroupId)> {
        self.memory.sent.iter().copied().collect()
    }

    /// The recipient's `heads` shows that it reads: the record of the handover through `group` goes.
    pub fn handover_read(&mut self, group: &GroupId, recipient: &DeviceId) -> Result<(), Error> {
        self.transact(|this, batch| {
            this.memory.sent.remove(&(*recipient, *group));
            batch.delete(device_key(
                SUB_SENT,
                &[recipient.as_bytes(), group.as_bytes()].concat(),
            ));
            Ok(())
        })
    }

    /// Sends the points of a stroke still being drawn (7.2): room group, human devices, relayed and not stored.
    pub fn send_stroke_piece(&mut self, board: &BoardId, piece: &[u8]) -> Result<u64, Error> {
        self.transact(|this, batch| {
            let group = this.room_group()?;
            let message = TrommiMessage::StrokePiece {
                board: *board,
                piece: piece.to_vec(),
            };
            this.send(batch, &group, &message, true)
        })
    }

    /// Sends one step of the running turn (7.3): a session group, from its agent or helper devices. `number`
    /// counts from 1 within `turn` (`bad-format` for 0); `step` is the application's JSON and is not read here.
    pub fn send_work_trail(
        &mut self,
        group: &GroupId,
        turn: &TurnId,
        number: u32,
        step: &[u8],
        now_ms: u64,
    ) -> Result<u64, Error> {
        self.transact(|this, batch| {
            if group.is_room() || this.is_human() {
                return Err(Error::Forbidden);
            }
            if number == 0 {
                return Err(Error::BadFormat);
            }
            let message = TrommiMessage::WorkTrail {
                turn: *turn,
                number,
                time: now_ms,
                step: step.to_vec(),
            };
            this.send(batch, group, &message, false)
        })
    }

    /// Sends the `recovery_mac` of the room's current recovery key (7.4) to `recipient`, or to all with zeros:
    /// room group, from a human device.
    pub fn send_recovery_auth(
        &mut self,
        recipient: &DeviceId,
        recovery_mac: Secret<32>,
    ) -> Result<u64, Error> {
        self.transact(|this, batch| {
            let group = this.room_group()?;
            let message = TrommiMessage::RecoveryAuth {
                recipient: *recipient,
                recovery_hpke_key: this.history()?.newest().room.recovery_hpke_key,
                recovery_mac,
            };
            this.send(batch, &group, &message, false)
        })
    }
}

/// What a KeyPackage says, for a caller that picks the ones to add: re-exported beside the device's API.
pub fn key_package_info(bytes: &[u8]) -> Result<KeyPackageInfo, Error> {
    key_package::verify_key_package(bytes)
}
