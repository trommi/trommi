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
//! a copy of the state that replaces the real one only when the hub accepted it, or when the log shows the
//! join's own Commit; it is held back and decided by the log in the same way. While a Commit of a group is
//! pending the device sends no application message in that group.
//!
//! **The log** is processed entry by entry in the hub's order ([`Device::process_log_entry`]), each entry
//! once. An entry that does not verify, process or obey the rules changes nothing: the error says why, and
//! [`log_finding`] says what it means (`bad-group`, an entry that came too early, a duplicate).
//!
//! **Leaf or observer.** A device follows a group as a leaf of it or as an observer, never as both. When it
//! becomes a leaf of a group it followed, what the observer verified becomes the device's own record and the
//! observer goes in the same write; a human device that processes its removal from the room group becomes an
//! observer of it and so knows the room state that removed it.
//!
//! **One owner.** A write that meets [`StorageError::Conflict`] ends this object: it answers
//! `Error::Storage` from then on and hands out nothing ([`Device::is_owner`]).

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
    self, CommitFacts, Judged, Parent, RoomHistory, RoomState, SessionBefore, SessionFacts,
    Verifier,
};
use crate::recovery::{
    self, AuthMessage, CheckedRoom, KeyContext, MacKeys, PublicRules, RecoveryJoin, RecoveryKeys,
    RecoveryMac, RecoveryPublic, Replacement, SealedKey, Sealing, ServedGroup, ServedRoom, Taken,
};
use crate::store::{self, table, Batch, Entry, OutboxEntry, OutboxKind, Storage, StorageError};
use openmls::group::MlsGroup;
use openmls::prelude::{KeyPackage, ProcessedMessageContent, ProtocolMessage, Sender};
use openmls_traits::OpenMlsProvider as _;
use std::collections::{BTreeMap, BTreeSet};
use tls_codec::{Deserialize as _, Serialize as _};
use zeroize::{Zeroize as _, Zeroizing};

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
const SUB_OWED: u8 = 7;
const SUB_MAC: u8 = 0;
const SUB_UNCONFIRMED: u8 = 1;
const SUB_UNBOUND: u8 = 6;
mod content;
mod facts;
mod invite;

pub use content::{
    board_reduce, BoardItem, BoardSnapshot, Confirmation, Draft, EnvelopeOutcome, ReceivedEnvelope,
    RegisterChange, Sealed, HEADS_EVERY_MS,
};
pub use facts::Finding;
pub use invite::{
    InviteAccepted, InviteConfirmed, InviteOpened, InviteStep, JoinRequest, MAX_OPEN_INVITES,
};

const SUB_OWN_HISTORY: u8 = 0;
const SUB_OBSERVER: u8 = 1;

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
    /// The entry is this device's own Commit: merged now, or already when the hub accepted it. Also its own
    /// join from outside, whose copy becomes the real state here when the hub's answer never came.
    OwnCommit,
    /// A Commit of a group this device follows as an observer.
    Observed(CommitFacts),
    /// A Commit of another device took the epoch that a join from outside of this device was built on: the
    /// join and its outbox entry `superseded` are dropped, and the join is to be built again on a newer
    /// GroupInfo. `observed`: what that Commit did, where this device follows the group as an observer.
    JoinSuperseded {
        /// The dropped join.
        superseded: u64,
        /// The Commit that took the epoch, as an observer saw it.
        observed: Option<CommitFacts>,
    },
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
    /// A key is taken only for an epoch its group has reached, as far as the device can tell: up to the
    /// epoch of a group it is a leaf of or follows. A human device takes the keys of a session group it
    /// never held as they come, in the room group, since it is handed them before it is added there; when
    /// it joins that group, the handed keys of its joining epoch and of later ones are dropped. A key of a
    /// group it was removed from is not taken.
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
    /// The `recovery_mac` of the room's recovery key, from a human device (7.4): this device holds it now.
    RecoveryAuth {
        /// The sender.
        from: DeviceId,
        /// The recovery key it belongs to.
        recovery_hpke_key: [u8; RECOVERY_KEY_LEN],
        /// Whether the key was new to this device.
        new: bool,
    },
    /// A second, different `recovery_mac` for a recovery key this device holds one for: the finding
    /// `equivocation`. Nothing was replaced.
    RecoveryAuthConflict {
        /// The sender.
        from: DeviceId,
        /// The recovery key it names.
        recovery_hpke_key: [u8; RECOVERY_KEY_LEN],
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
    /// The entry lies behind what the device already processed: a duplicate. Its `change` is not above the
    /// cursor, or it is a Commit for an epoch its group has left.
    Duplicate,
    /// The entry does not verify, process or obey the rules: the finding `bad-group` (13.4). The device kept
    /// its last good state; the entry is reported to the hub.
    BadGroup,
    /// The device itself failed: its store, its entropy, or a request still pending.
    Local,
}

/// The group whose handshake message `bytes` are, as it travels: an `MLSMessage` holding a `PublicMessage`. The
/// group is the one the message itself names, whatever the log entry says.
fn handshake_group(bytes: &[u8]) -> Option<GroupId> {
    if bytes.len() > MAX_COMMIT_REQUEST_LEN {
        return None;
    }
    let parsed = openmls::prelude::MlsMessageIn::tls_deserialize_exact(bytes)
        .ok()
        .and_then(|message| message.try_into_protocol_message().ok());
    match parsed {
        Some(message @ ProtocolMessage::PublicMessage(_)) => {
            GroupId::from_bytes(message.group_id().as_slice()).ok()
        }
        _ => None,
    }
}

/// Whether a refusal of the hub says nothing about the request it answers, so that the same request is sent
/// again unchanged: `internal`, `overloaded`, `rate-limited`, `unauthorised` and `bad-challenge` (sign in
/// again), `client-too-old`, `lease-lost` (take the lease again). Every other code judges the request.
pub fn refusal_is_passing(code: &Error) -> bool {
    matches!(
        code,
        Error::Internal(_)
            | Error::Overloaded
            | Error::RateLimited
            | Error::Unauthorised
            | Error::BadChallenge
            | Error::ClientTooOld
            | Error::LeaseLost
    )
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
    /// For a last-resort one that was replaced: since when its private part is kept for one period more;
    /// [`REPLACED`] until the device is told the time; 0 for one that is current.
    retired_ms: u64,
}

/// A last-resort KeyPackage that the hub replaced, before the device was told the time again.
const REPLACED: u64 = u64::MAX;

/// A change to the stored state that waits for the hub (13.2): everything a join from outside, or a whole
/// recovery, leaves behind. It was made on a copy and is applied only when the hub accepted the outbox entry
/// it is kept under.
struct Staged {
    /// The outbox entries that belong to it: when the hub refuses one, all of them go.
    entries: Vec<u64>,
    put: Vec<(Vec<u8>, Vec<u8>)>,
    delete: Vec<Vec<u8>>,
    /// The hub answered `epoch-taken`: the log decides.
    awaiting_log: bool,
}

impl Encode for Staged {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.vector(&self.entries)?;
        let mut put = Writer::new();
        for (key, value) in &self.put {
            put.opaque(key)?;
            put.opaque(value)?;
        }
        writer.opaque(&put.into_bytes())?;
        let delete: Vec<Opaque> = self.delete.iter().cloned().map(Opaque).collect();
        writer.vector(&delete)?;
        writer.u8(u8::from(self.awaiting_log));
        Ok(())
    }
}

impl Decode for Staged {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        let entries = reader.vector()?;
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
        let awaiting_log = match reader.u8()? {
            0 => false,
            1 => true,
            _ => return Err(Error::BadFormat),
        };
        Ok(Self {
            entries,
            put,
            delete,
            awaiting_log,
        })
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        // The copy holds content keys, recovery_mac keys and OpenMLS's private state.
        for (_, value) in &mut self.put {
            value.zeroize();
        }
    }
}

impl Staged {
    /// Whether the copy touches only what a join or a recovery writes: OpenMLS's entries, content keys, the
    /// room's roles, the recovery keys, the records of groups and of their epochs with what a Cut does to
    /// chains and objects, and the device record. Never the device's key,
    /// its KeyPackages, the outbox or another staged copy.
    fn in_scope(&self) -> bool {
        let allowed = |key: &Vec<u8>| {
            matches!(
                key.as_slice(),
                [table::DEVICE, SUB_RECORD]
                    | [table::DEVICE, SUB_GROUP, ..]
                    | [
                        table::MLS
                            | table::CONTENT_KEY
                            | table::ROOM_STATE
                            | table::RECOVERY
                            | table::CHAIN
                            | table::OBJECT
                            | table::REGISTER,
                        ..
                    ]
            )
        };
        self.put.iter().all(|(key, _)| allowed(key)) && self.delete.iter().all(allowed)
    }
}

/// How far a group is, as a device that is handed one of its keys can tell.
enum Reached {
    /// The device is a leaf of the group or follows it, and it stands in this epoch.
    Epoch(u64),
    /// The device never held the group.
    NotJoined,
    /// The device was a leaf of the group and is none now, or its state of the group does not load.
    Unknown,
}

/// What a Commit of the log means for a join from outside that waits.
enum StagedVerdict {
    /// It is the join's own Commit.
    Own,
    /// It took the epoch: the join with this outbox entry is dropped.
    Superseded(u64),
}

/// A `recovery_mac` this device owes another (7.4), written with the Commit it follows from. It waits for an
/// outbox entry: the Commit, until it is merged and the message can be encrypted in the new epoch; then the
/// message, until the hub took it.
struct Owed {
    recovery_hpke_key: [u8; RECOVERY_KEY_LEN],
    recovery_mac: Secret<32>,
    /// Whether it is the consequence of the Commit it waits for, and goes if that Commit does.
    bound: bool,
}

impl Encode for Owed {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.fixed(&self.recovery_hpke_key);
        writer.fixed(self.recovery_mac.expose());
        writer.u8(u8::from(self.bound));
        Ok(())
    }
}

impl Decode for Owed {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        Ok(Self {
            recovery_hpke_key: reader.fixed()?,
            recovery_mac: Secret::new(reader.fixed()?),
            bound: match reader.u8()? {
                0 => false,
                1 => true,
                _ => return Err(Error::BadFormat),
            },
        })
    }
}

/// What an owed `recovery_mac` is kept under: the outbox entry it waits for, its recipient, and the recovery
/// key it belongs to.
type OwedKey = (u64, DeviceId, [u8; RECOVERY_KEY_LEN]);

/// What a Commit leaves to post.
struct Posting {
    group: GroupId,
    /// The epoch the Commit builds on.
    epoch: u64,
    commit: Vec<u8>,
    group_info: Vec<u8>,
    /// Empty when the Commit adds nobody.
    welcome: Vec<u8>,
    sealed: Vec<u8>,
    /// Empty unless the Commit is a join from outside.
    recovery_auth: Vec<u8>,
    /// The room epoch its note names.
    room_epoch: u64,
    /// Whether it has a path, which renews this device's leaf; a Commit that only adds has none (3.4).
    renews_leaf: bool,
}

/// What a join with the code leaves behind (8.4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodeJoin {
    /// The outbox entries to post, in order. The device's state changes only when the hub accepted the last.
    pub outbox: Vec<u64>,
    /// A recovery key whose link to the code it replaced the hub did not serve: the content of the older
    /// codes' time stays closed. The finding is `withheld`.
    pub missing_link: Option<[u8; RECOVERY_KEY_LEN]>,
    /// The live session groups that did not verify from their founding, by their place in what was served,
    /// each with the reason: they are not joined.
    pub unverified: Vec<(usize, Error)>,
}

/// Everything the device holds in memory that is rebuilt from the store.
#[derive(Default)]
struct Memory {
    /// What the content layer holds between the steps of one operation.
    wire: facts::Transient,
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
    /// The `recovery_mac` keys this device holds (8.3).
    macs: MacKeys,
    /// The `recovery_mac`s it owes.
    owed: BTreeMap<OwedKey, Owed>,
    /// The content keys that only a row without a `mac` vouches for (8.5).
    unconfirmed: BTreeSet<(GroupId, u64)>,
    /// Content keys that were handed over for a session group this device was no leaf of yet, so that it
    /// could not tell whether the group had reached their epoch: group and epoch.
    unbound: BTreeSet<(GroupId, u64)>,
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

fn unbound_key(group: &GroupId, epoch: u64) -> Vec<u8> {
    let group = group.as_bytes();
    device_key(
        SUB_UNBOUND,
        &[&[group.len() as u8], group, &epoch.to_be_bytes()].concat(),
    )
}

fn observer_prefix(group: &GroupId) -> Vec<u8> {
    let group = group.as_bytes();
    store::key(
        table::ROOM_STATE,
        &[&[SUB_OBSERVER, group.len() as u8], group],
    )
}

fn mac_key(recovery_hpke_key: &[u8; RECOVERY_KEY_LEN]) -> Vec<u8> {
    store::key(table::RECOVERY, &[&[SUB_MAC], recovery_hpke_key])
}

fn unconfirmed_key(group: &GroupId, epoch: u64) -> Vec<u8> {
    let group = group.as_bytes();
    store::key(
        table::RECOVERY,
        &[
            &[SUB_UNCONFIRMED, group.len() as u8],
            group,
            &epoch.to_be_bytes(),
        ],
    )
}

fn owed_key(key: &OwedKey) -> Vec<u8> {
    let (waits_for, recipient, recovery_hpke_key) = key;
    device_key(
        SUB_OWED,
        &[
            &waits_for.to_be_bytes()[..],
            recipient.as_bytes(),
            recovery_hpke_key,
        ]
        .concat(),
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
                    if !rest.is_empty() || !staged.in_scope() || staged.entries.last() != Some(&id)
                    {
                        return Err(damaged("a staged join"));
                    }
                    memory.staged.insert(id, staged);
                }
                SUB_SENT => {
                    let recipient: DeviceId =
                        rest.value().map_err(|_| damaged("a handover record"))?;
                    let group = GroupId::from_bytes(rest.take(rest.remaining())?)
                        .map_err(|_| damaged("a handover record"))?;
                    memory.sent.insert((recipient, group));
                }
                SUB_UNBOUND => {
                    let parsed = (|| {
                        let group = group_after(&mut rest)?;
                        let epoch = rest.u64()?;
                        rest.finish()?;
                        Ok::<_, Error>((group, epoch))
                    })()
                    .map_err(|_| damaged("a handed key's record"))?;
                    memory.unbound.insert(parsed);
                }
                SUB_OWED => {
                    let waits_for = rest.u64().map_err(|_| damaged("an owed key"))?;
                    let recipient: DeviceId = rest.value().map_err(|_| damaged("an owed key"))?;
                    let owed: Owed =
                        codec::decode(value, value.len()).map_err(|_| damaged("an owed key"))?;
                    let named: [u8; RECOVERY_KEY_LEN] =
                        rest.fixed().map_err(|_| damaged("an owed key"))?;
                    if !rest.is_empty() || named != owed.recovery_hpke_key {
                        return Err(damaged("an owed key"));
                    }
                    memory.owed.insert((waits_for, recipient, named), owed);
                }
                _ => return Err(damaged("a key")),
            },
            table::RECOVERY => match rest.u8().map_err(|_| damaged("a key"))? {
                SUB_MAC => {
                    let held = (|| {
                        Ok::<_, Error>(RecoveryMac {
                            recovery_hpke_key: rest.fixed()?,
                            key: Secret::from_slice(value)?,
                        })
                    })()
                    .ok()
                    .filter(|_| rest.is_empty())
                    .ok_or_else(|| damaged("a recovery key"))?;
                    memory
                        .macs
                        .hold(held)
                        .map_err(|_| damaged("a recovery key"))?;
                }
                SUB_UNCONFIRMED => {
                    let group = group_after(&mut rest).map_err(|_| damaged("a key mark"))?;
                    let epoch = rest.u64().map_err(|_| damaged("a key mark"))?;
                    if !rest.is_empty() || !value.is_empty() {
                        return Err(damaged("a key mark"));
                    }
                    memory.unconfirmed.insert((group, epoch));
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
            // The tables of stored content are read where they are used; here they are only checked.
            _ => facts::check_entry(key, value)?,
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
    pub fn create(mut store: S, mut entropy: Box<dyn Entropy + Send>) -> Result<Self, Error> {
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
            memory: Memory {
                record,
                ..Memory::default()
            },
            lost: false,
        })
    }

    /// The device a store holds. `Error::Storage` when anything in it does not decode or fit together, or a
    /// stored group stands in an epoch above [`profile::MAX_STORED_EPOCH`].
    pub fn open(mut store: S, entropy: Box<dyn Entropy + Send>) -> Result<Self, Error> {
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

    /// Adds to `batch` what OpenMLS and the observers changed since the last write.
    fn fold(&mut self, batch: &mut Batch) -> Result<(), Error> {
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
        Ok(())
    }

    /// Runs one operation on a copy: memory is put back to what is stored, and what the operation would have
    /// written is returned instead of written (13.2: a join from outside replaces the real state only when
    /// the hub accepted it).
    fn shadow<T>(
        &mut self,
        operation: impl FnOnce(&mut Self, &mut Batch) -> Result<T, Error>,
    ) -> Result<(T, Batch), Error> {
        self.owner()?;
        let mut batch = Batch::new();
        let result = operation(self, &mut batch).and_then(|value| {
            self.fold(&mut batch)?;
            Ok(value)
        });
        self.reset()?;
        result.map(|value| (value, batch))
    }

    fn write(&mut self, mut batch: Batch) -> Result<(), Error> {
        self.fold(&mut batch)?;
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

    /// The room's roles per epoch as this device knows them: from its own room group, or as an observer. One
    /// record at a time: a device that becomes a leaf of the room group takes its observer's record over, and
    /// one that is removed from it hands its record to the observer it becomes.
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

    /// Whether this device is a human device now: a leaf of the room group in the newest room state it
    /// knows. A device that processed its own removal from the room group follows that group as an observer
    /// from then on and is no human device; operations in the room group answer `forbidden`.
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

    /// Takes the observer of `group` out of memory and its entries out of the store, in `batch`: for a device
    /// that becomes a leaf of the group it followed.
    fn retire_observer(&mut self, batch: &mut Batch, group: &GroupId) -> Option<Observer> {
        let observer = self.memory.observers.remove(group)?;
        let prefix = observer_prefix(group);
        for key in self
            .mirror
            .range(prefix.clone()..)
            .map(|(key, _)| key)
            .take_while(|key| key.starts_with(&prefix))
        {
            batch.delete(key.clone());
        }
        Some(observer)
    }

    /// Makes `state`, the room group as this device joined it, the newest state of its own history. What it
    /// verified before as an observer is carried over whole, revocations included (4.2), and the joined state
    /// must fit its end: in the observer's epoch it is the same state (`bad-group`); one epoch on it follows
    /// it, and brings back no key the history knows as revoked (`bad-group`); further on is `room-behind`:
    /// the device processes the log up to the Commit that added it first. A state behind the observer's
    /// epoch is `wrong-epoch`: nothing verified is given up for it.
    fn adopt_room_history(
        &mut self,
        batch: &mut Batch,
        observed: Option<RoomHistory>,
        state: RoomState,
    ) -> Result<(), Error> {
        let history = match observed {
            None => RoomHistory::new(state),
            Some(mut observed) => {
                let stands = observed.newest().epoch;
                if state.epoch < stands {
                    return Err(Error::WrongEpoch);
                }
                if state.epoch == stands {
                    if *observed.newest() != state {
                        return Err(Error::BadGroup);
                    }
                } else if stands.checked_add(1) == Some(state.epoch) {
                    // The Commit that led here was not judged by the observer: what it must not have done
                    // to the roles is checked on its result.
                    let returns = state
                        .humans
                        .iter()
                        .chain(state.room.agents.iter())
                        .any(|device| observed.is_revoked(device, stands));
                    if returns {
                        return Err(Error::BadGroup);
                    }
                    observed.record(state)?;
                } else {
                    return Err(Error::RoomBehind);
                }
                observed
            }
        };
        for state in history.states() {
            batch.put(history_key(state.epoch), codec::encode(state)?);
        }
        self.memory.history = Some(history);
        Ok(())
    }

    /// What an observer of a session group knew of it, for the record of a device that became a leaf of it
    /// at `epoch` with `leaves`: the agent leaf over time and the room epoch of the last Commit. An observer
    /// that stands in that epoch must hold the same leaves (`bad-group`); one in another epoch says nothing.
    fn adopt_session_record(
        meta: &mut GroupMeta,
        observer: &Observer,
        epoch: u64,
        leaves: &BTreeSet<DeviceId>,
    ) -> Result<(), Error> {
        if observer.epoch()? != epoch {
            return Ok(());
        }
        if observer.leaves()? != *leaves {
            return Err(Error::BadGroup);
        }
        meta.seats = observer.seats().to_vec();
        meta.previous_room_epoch = observer.previous_room_epoch();
        Ok(())
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

    /// Stores the content key this device derived from its own group state. It is the key: whatever was held
    /// for that group and epoch from a row or a handover gives way, and the mark of an unconfirmed key goes.
    fn own_key(&mut self, batch: &mut Batch, group: &GroupId, epoch: u64, key: Secret<32>) {
        let place = (*group, epoch);
        if self.memory.unconfirmed.remove(&place) {
            batch.delete(unconfirmed_key(group, epoch));
        }
        if self.memory.keys.get(&place) != Some(&key) {
            batch.put(content_key_key(group, epoch), key.expose().to_vec());
            self.memory.keys.insert(place, key);
        }
    }

    /// This device stands in `group` at `epoch` now, as a leaf: of the keys it was handed for the group before
    /// it could tell how far the group was (7.1), those of that epoch and of later ones go. The key of its
    /// own epoch it derives itself, and a later epoch the group had not reached.
    fn bound_handed_keys(&mut self, batch: &mut Batch, group: &GroupId, epoch: u64) {
        let handed: Vec<u64> = self
            .memory
            .unbound
            .range((*group, 0)..=(*group, u64::MAX))
            .map(|(_, epoch)| *epoch)
            .collect();
        for handed in handed {
            self.memory.unbound.remove(&(*group, handed));
            batch.delete(unbound_key(group, handed));
            if handed >= epoch {
                self.memory.keys.remove(&(*group, handed));
                batch.delete(content_key_key(group, handed));
            }
        }
    }

    /// How far `group` is, as far as this device can tell: the epoch of a group it is a leaf of or follows.
    fn reached(&self, group: &GroupId) -> Reached {
        match self.memory.groups.get(group) {
            Some(meta) if meta.removed => Reached::Unknown,
            Some(_) => group::load(&self.provider, group).map_or(Reached::Unknown, |held| {
                Reached::Epoch(held.epoch().as_u64())
            }),
            None => match self.memory.observers.get(group).map(Observer::epoch) {
                Some(Ok(epoch)) => Reached::Epoch(epoch),
                Some(Err(_)) => Reached::Unknown,
                None => Reached::NotJoined,
            },
        }
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
    /// reported; a Commit or a join from outside refused with `epoch-taken` is held back until the log decided
    /// it. Empty for a device
    /// that is no longer the owner of its stored state ([`Device::is_owner`]): what it holds may have been sent
    /// or replaced by the other owner.
    pub fn outbox(&self) -> Vec<OutboxEntry> {
        if self.lost {
            return Vec::new();
        }
        let joins = self
            .memory
            .staged
            .iter()
            .filter(|(_, staged)| staged.awaiting_log)
            .map(|(outbox, _)| *outbox);
        let held: BTreeSet<u64> = self
            .memory
            .groups
            .values()
            .filter_map(|meta| meta.pending.as_ref())
            .filter(|pending| pending.awaiting_log)
            .map(|pending| pending.outbox)
            .chain(joins)
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
        let adopted = self.transact(|device, batch| {
            let mut adopted = false;
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
                (OutboxKind::ExternalCommit | OutboxKind::RecoveryFinish, _) => {
                    device.adopt_staged(batch, id)?;
                    adopted = true;
                }
                (OutboxKind::Message, _) => device.forget_owed(batch, id),
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
            // An own envelope is not passed: it takes effect on this device's view when it comes back
            // from the hub at its place, like everyone's.
            let next = device
                .memory
                .record
                .cursor
                .checked_add(1)
                .filter(|_| entry.kind != OutboxKind::Envelope);
            if let Some(change) = answer.change.filter(|change| Some(*change) == next) {
                device.advance(batch, change)?;
            }
            Ok(adopted)
        })?;
        if adopted {
            // What was staged is stored now: memory follows it.
            self.reset()?;
        }
        Ok(())
    }

    /// The hub refused the outbox entry `id` with `code`.
    ///
    /// A refusal that does not judge the request ([`refusal_is_passing`]: the hub failed, is busy, wants a
    /// new sign-in, a newer client or the lease) changes nothing, for every kind of entry: the entry stays
    /// and the same bytes are sent again. An envelope stays after every refusal (see
    /// [`Device::outbox_voided`], [`Device::envelope_abandon`]). Every other refusal is final for its entry:
    ///
    /// `epoch-taken` for a Commit or a join from outside:
    /// it is held back, and the caller processes the log, which decides it. Any other refusal undoes what the
    /// entry was for: the pending Commit is cleared, a founding's group or a staged join is dropped, the
    /// KeyPackages' private parts go.
    pub fn outbox_refused(&mut self, id: u64, code: &Error) -> Result<(), Error> {
        self.transact(|device, batch| {
            let entry = device
                .memory
                .outbox
                .get(&id)
                .cloned()
                .ok_or(Error::NotFound)?;
            // A refusal that says nothing about the request leaves it to be sent again.
            if refusal_is_passing(code) {
                return Ok(());
            }
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
                (
                    OutboxKind::ExternalCommit
                    | OutboxKind::RecoveryCommit
                    | OutboxKind::RecoveryFinish,
                    _,
                ) => {
                    if entry.kind == OutboxKind::ExternalCommit && *code == Error::EpochTaken {
                        // 13.2: the copy stays until the log shows which Commit took the epoch.
                        let staged = device.memory.staged.get_mut(&id).ok_or(Error::NotFound)?;
                        staged.awaiting_log = true;
                        batch.put(
                            device_key(SUB_STAGED, &id.to_be_bytes()),
                            codec::encode(staged)?,
                        );
                        return Ok(());
                    }
                    device.drop_staged(batch, id);
                }
                (OutboxKind::Message, _) => {
                    // 7.0: a message of an epoch that ended is encrypted again; a recovery_mac is owed
                    // until the hub took it.
                    let again = *code == Error::WrongEpoch;
                    for (recipient, owed) in device.take_owed(batch, id) {
                        if again {
                            device.owe(batch, recipient, owed)?;
                        }
                    }
                }
                // The hub took no number, and this device signs no other envelope under the one it
                // used (9.0.1): the entry stays and the same bytes are sent again.
                (OutboxKind::Envelope, _) => return Ok(()),
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
        self.merging_own(id, pending.outbox, pending.time)?;
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
        self.settle(batch, id, &group, pending.room_epoch)?;
        // 7.4: the recovery_mac owed with this Commit is encrypted in the epoch it led to.
        for (recipient, owed) in self.take_owed(batch, pending.outbox) {
            self.hold_mac(
                batch,
                RecoveryMac {
                    recovery_hpke_key: owed.recovery_hpke_key,
                    key: owed.recovery_mac.duplicate(),
                },
            )?;
            self.owe(batch, recipient, owed)?;
        }
        Ok(())
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
            self.record_epoch(batch, id, group.epoch().as_u64(), &leaves, room_epoch)?;
            return self.leave(batch, id);
        }
        let key = group::content_key(&self.provider, group)?;
        self.own_key(batch, id, group.epoch().as_u64(), key);
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
        self.record_epoch(batch, id, group.epoch().as_u64(), &leaves, room_epoch)?;
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
        // What the Commit would have brought goes with it; what merely waited behind it is sent now.
        for (recipient, owed) in self.take_owed(batch, pending.outbox) {
            if !owed.bound {
                self.owe(batch, recipient, owed)?;
            }
        }
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

    /// The hub accepted what was staged under the outbox entry `id`: the copy becomes the real state. The
    /// caller rebuilds memory once it is written.
    fn adopt_staged(&mut self, batch: &mut Batch, id: u64) -> Result<(), Error> {
        let mut staged = self.memory.staged.remove(&id).ok_or(Error::NotFound)?;
        batch.delete(device_key(SUB_STAGED, &id.to_be_bytes()));
        let record = device_key(SUB_RECORD, &[]);
        for (key, value) in std::mem::take(&mut staged.put) {
            if key == record {
                // The copy's record names the room; cursor and outbox counter are the real ones.
                let copy: Record =
                    codec::decode(&value, value.len()).map_err(|_| damaged("a staged record"))?;
                self.memory.record.room = copy.room;
            } else {
                batch.put(key, value);
            }
        }
        for key in std::mem::take(&mut staged.delete) {
            batch.delete(key);
        }
        self.put_record(batch)
    }

    /// The hub refused the outbox entry `id` of something staged: all of it goes, and the real state is as
    /// it was.
    fn drop_staged(&mut self, batch: &mut Batch, id: u64) {
        let found = self
            .memory
            .staged
            .iter()
            .find(|(_, staged)| staged.entries.contains(&id))
            .map(|(under, _)| *under);
        let Some(under) = found else { return };
        if let Some(staged) = self.memory.staged.remove(&under) {
            for entry in &staged.entries {
                self.drop_outbox(batch, *entry);
            }
        }
        batch.delete(device_key(SUB_STAGED, &under.to_be_bytes()));
    }

    /// Keeps what a shadow run would have written under the outbox entry whose acceptance adopts it.
    fn stage(&mut self, batch: &mut Batch, entries: Vec<u64>, copy: Batch) -> Result<(), Error> {
        let under = *entries.last().ok_or(Error::Internal("staged entries"))?;
        let staged = Staged {
            entries,
            put: copy
                .put
                .iter()
                .map(|entry| (entry.key.clone(), entry.value.clone()))
                .collect(),
            delete: copy.delete.clone(),
            awaiting_log: false,
        };
        batch.put(
            device_key(SUB_STAGED, &under.to_be_bytes()),
            codec::encode(&staged)?,
        );
        self.memory.staged.insert(under, staged);
        Ok(())
    }

    // ---- recovery_mac (7.4, 8.3) ----

    /// Holds a `recovery_mac`. A held key is never replaced: `equivocation` for a second, different value.
    fn hold_mac(&mut self, batch: &mut Batch, mac: RecoveryMac) -> Result<Taken, Error> {
        let key = mac_key(&mac.recovery_hpke_key);
        let value = mac.key.expose().to_vec();
        let taken = self.memory.macs.hold(mac)?;
        if taken == Taken::New {
            batch.put(key, value);
        }
        Ok(taken)
    }

    /// Whether this device holds the `recovery_mac` of the room's current recovery key. A human device that
    /// does not founds nothing and commits nothing (7.4): it asks for it (`POST /v2/requests`, kind
    /// `handover`).
    pub fn holds_recovery_mac(&self) -> bool {
        self.room_history()
            .is_some_and(|history| recovery::may_commit(&self.memory.macs, history.newest()))
    }

    /// Takes the owed `recovery_mac`s that wait for the outbox entry `waits_for`.
    fn take_owed(&mut self, batch: &mut Batch, waits_for: u64) -> Vec<(DeviceId, Owed)> {
        let waiting: Vec<OwedKey> = self
            .memory
            .owed
            .keys()
            .filter(|key| key.0 == waits_for)
            .copied()
            .collect();
        let mut taken = Vec::new();
        for key in waiting {
            batch.delete(owed_key(&key));
            if let Some(owed) = self.memory.owed.remove(&key) {
                taken.push((key.1, owed));
            }
        }
        taken
    }

    fn forget_owed(&mut self, batch: &mut Batch, waits_for: u64) {
        self.take_owed(batch, waits_for);
    }

    /// Keeps `owed` until the outbox entry `waits_for` is answered. One that is the consequence of a Commit
    /// is never displaced by one that merely waits behind it.
    fn put_owed(
        &mut self,
        batch: &mut Batch,
        waits_for: u64,
        recipient: DeviceId,
        owed: Owed,
    ) -> Result<(), Error> {
        let key = (waits_for, recipient, owed.recovery_hpke_key);
        if self.memory.owed.get(&key).is_some_and(|held| held.bound) {
            return Ok(());
        }
        batch.put(owed_key(&key), codec::encode(&owed)?);
        self.memory.owed.insert(key, owed);
        Ok(())
    }

    /// Sends an owed `recovery_mac` in the room group's current epoch and keeps it owed until the hub took
    /// the message: refused there with `wrong-epoch`, it is encrypted again. While a Commit of this device is
    /// pending in the room group it waits for that Commit instead, since no message can be encrypted beside
    /// a pending Commit. Returns the message's outbox entry, if it was sent now.
    fn owe(
        &mut self,
        batch: &mut Batch,
        recipient: DeviceId,
        mut owed: Owed,
    ) -> Result<Option<u64>, Error> {
        let group = GroupId::room(self.memory.record.room.ok_or(Error::NoRoom)?);
        owed.bound = false;
        let pending = self
            .meta(&group)?
            .pending
            .as_ref()
            .map(|pending| pending.outbox);
        let sent = match pending {
            Some(_) => None,
            None => {
                let message = TrommiMessage::RecoveryAuth {
                    recipient,
                    recovery_hpke_key: owed.recovery_hpke_key,
                    recovery_mac: owed.recovery_mac.duplicate(),
                };
                Some(self.send(batch, &group, &message, false)?)
            }
        };
        let waits_for = sent.or(pending).ok_or(Error::Internal("owed"))?;
        self.put_owed(batch, waits_for, recipient, owed)?;
        Ok(sent)
    }

    /// Whether a row with a valid `mac` vouches for the content key of `group` at `epoch`, or the device
    /// derived it itself. Content of an epoch whose key is not confirmed is shown as unconfirmed (8.5).
    pub fn key_is_confirmed(&self, group: &GroupId, epoch: u64) -> bool {
        !self.memory.unconfirmed.contains(&(*group, epoch))
    }

    // ---- KeyPackages ----

    /// Makes the KeyPackages this device should publish now, given how many unused single-use ones the hub
    /// still holds: enough to have [`SINGLE_USE_KEY_PACKAGES`], and a last-resort one when none was made in
    /// the last [`LAST_RESORT_FOR_MS`]. Their private parts are written with the outbox entry that publishes
    /// them (13.2). The last-resort one before it is retired when the hub accepted that entry, and its
    /// private part kept [`LAST_RESORT_FOR_MS`] more, counted from the first call of this function after the
    /// hub's answer; a refused entry leaves it the current one. Returns the entry's id, or none when nothing
    /// is due.
    pub fn key_packages_to_upload(
        &mut self,
        unused_at_hub: usize,
        now_ms: u64,
    ) -> Result<Option<u64>, Error> {
        self.transact(|device, batch| {
            // A last-resort one that the hub replaced is kept for a period from now on.
            let replaced: Vec<Hash32> = device
                .memory
                .key_packages
                .iter()
                .filter(|(_, own)| own.retired_ms == REPLACED)
                .map(|(reference, _)| *reference)
                .collect();
            for reference in replaced {
                if let Some(own) = device.memory.key_packages.get_mut(&reference) {
                    // A time of 0 would read as current.
                    own.retired_ms = now_ms.clamp(1, REPLACED.saturating_sub(1));
                    let own = own.clone();
                    device.put_key_package(batch, &reference, &own);
                }
            }
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
                            && own.retired_ms != REPLACED
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

    /// The hub took `replacement` as this device's last-resort KeyPackage: every one made before it is
    /// replaced. The period for which a replaced one's private part stays begins at the next call of
    /// [`Device::key_packages_to_upload`], the first time after the hub's answer that the device is told the
    /// time. One made after `replacement` is a later upload's and stays current.
    fn retire_last_resort(&mut self, batch: &mut Batch, replacement: &Hash32) {
        let Some(made) = self
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
            .filter(|(_, own)| own.last_resort && own.retired_ms == 0 && own.made_ms < made)
            .map(|(reference, _)| *reference)
            .collect();
        for reference in before {
            if let Some(own) = self.memory.key_packages.get_mut(&reference) {
                own.retired_ms = REPLACED;
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

    /// The `SealedKey` of the group and epoch `of`, sealed to the recovery key `to.1` of the room epoch `to.0` (8.2). A human
    /// device sets the `mac` with the `recovery_mac` of that key: `given` for a key that only now comes into
    /// force, else the one it holds. Without it, it founds nothing and commits nothing (7.4): `no-key`.
    fn seal_key(
        &mut self,
        of: (&GroupId, u64),
        content_key: &Secret<32>,
        group_info: &[u8],
        to: (u64, &[u8; RECOVERY_KEY_LEN]),
        human: bool,
        given: Option<&Secret<32>>,
    ) -> Result<Vec<u8>, Error> {
        let (group, epoch) = of;
        let (room_epoch, recovery_hpke_key) = to;
        let recovery_mac = if human {
            let held = given.or_else(|| self.memory.macs.get(recovery_hpke_key));
            Some(held.ok_or(Error::NoKey)?.duplicate())
        } else {
            None
        };
        let sealing = Sealing {
            context: KeyContext::of(group, epoch, group_info)?,
            room_epoch,
            recovery_hpke_key,
            writer: self.id,
            content_key,
        };
        self.provider
            .with_entropy(|entropy| SealedKey::seal(entropy, &sealing, recovery_mac.as_ref()))?
            .to_bytes()
    }

    /// Founds the room (5.1.1) with the public keys of the recovery code `keys` (8.1) and posts the GroupInfo
    /// of epoch 0 with its `SealedKey`. The device keeps the code's `recovery_mac`. Returns the room's id, 32
    /// random bytes.
    pub fn found_room(&mut self, keys: &RecoveryKeys, now_ms: u64) -> Result<RoomId, Error> {
        let RecoveryPublic {
            signature_key: recovery_signature_key,
            hpke_key: recovery_hpke_key,
        } = keys.public();
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
            device.hold_mac(batch, keys.mac_key())?;
            let sealed = device.seal_key(
                (&group_id, 0),
                &key,
                &info,
                (0, &recovery_hpke_key),
                true,
                None,
            )?;
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
            device.record_epoch(batch, &group_id, 0, &leaves, 0)?;
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
            let sealed_0 = device.seal_key(
                (&group_id, 0),
                &key_0,
                &info_0,
                (room.epoch, &hpke),
                human,
                None,
            )?;
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
            let sealed = device.seal_key(
                (&group_id, 1),
                &built.next_key,
                &built.group_info,
                (room.epoch, &hpke),
                human,
                None,
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
            device.keep_own_cuts(batch, &group_id, outbox)?;
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
            let founder = rules::leaves_of(group.members())?;
            device.record_epoch(batch, &group_id, 0, &founder, room.epoch)?;
            Ok(session.session_id)
        })
    }

    // ---- Commits ----

    /// Builds one Commit in `group` and leaves it pending in OpenMLS. `cuts` name the leaves it removes;
    /// `context` a new room extension; `new_mac` the `recovery_mac` of the recovery key that extension brings.
    fn build(
        &mut self,
        id: &GroupId,
        adds: Vec<KeyPackage>,
        cuts: &[Cut],
        context: Option<TrommiRoom>,
        new_mac: Option<&Secret<32>>,
        now_ms: u64,
    ) -> Result<Posting, Error> {
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
        self.built_cuts(&note.cuts);
        // 8.2: a room Commit that replaces the recovery keys seals its new epoch to the new key, and its row
        // names the new room epoch.
        let (sealed_epoch, hpke, given) = match &kind {
            Some(GroupKind::Room(new)) if new.recovery_hpke_key != room.room.recovery_hpke_key => {
                (room.epoch.saturating_add(1), new.recovery_hpke_key, new_mac)
            }
            _ => (room.epoch, room.room.recovery_hpke_key, None),
        };
        let Built {
            epoch,
            commit,
            group_info,
            welcome,
            next_key,
        } = built;
        let sealed = self.seal_key(
            (id, epoch.saturating_add(1)),
            &next_key,
            &group_info,
            (sealed_epoch, &hpke),
            human,
            given,
        )?;
        Ok(Posting {
            group: *id,
            epoch,
            commit,
            group_info,
            welcome: welcome.unwrap_or_default(),
            sealed,
            recovery_auth: Vec::new(),
            room_epoch: room.epoch,
            renews_leaf,
        })
    }

    /// Puts a built Commit in the outbox and records it as pending. `with` are the parts a replacement of the
    /// recovery code posts beside it.
    fn pend(
        &mut self,
        batch: &mut Batch,
        posting: Posting,
        with: Option<[Vec<u8>; 2]>,
        now_ms: u64,
    ) -> Result<u64, Error> {
        let Posting {
            group,
            epoch,
            commit,
            group_info,
            welcome,
            sealed,
            room_epoch,
            renews_leaf,
            ..
        } = posting;
        let (kind, parts) = match with {
            Some([link, account]) => (
                OutboxKind::RecoveryCode,
                vec![commit, group_info, sealed, link, account],
            ),
            None => (
                OutboxKind::Commit,
                vec![commit, group_info, welcome, sealed],
            ),
        };
        let outbox = self.enqueue(batch, kind, Some(group), epoch, parts)?;
        self.keep_own_cuts(batch, &group, outbox)?;
        self.meta(&group)?.pending = Some(Pending {
            outbox,
            room_epoch,
            time: now_ms,
            awaiting_log: false,
            renews_leaf,
        });
        self.put_group(batch, &group)?;
        Ok(outbox)
    }

    /// Builds one Commit in `group`, leaves it pending and puts it in the outbox with its GroupInfo, Welcome
    /// and `SealedKey`.
    fn commit(
        &mut self,
        batch: &mut Batch,
        id: &GroupId,
        adds: Vec<KeyPackage>,
        cuts: &[Cut],
        context: Option<TrommiRoom>,
        now_ms: u64,
    ) -> Result<u64, Error> {
        let posting = self.build(id, adds, cuts, context, None, now_ms)?;
        self.pend(batch, posting, None, now_ms)
    }

    /// Builds one Commit in `group` and merges it at once: for a state that is itself a copy, where the hub's
    /// answer decides over all of it (8.7).
    fn commit_now(
        &mut self,
        batch: &mut Batch,
        id: &GroupId,
        cuts: &[Cut],
        context: Option<TrommiRoom>,
        now_ms: u64,
    ) -> Result<Posting, Error> {
        let posting = self.build(id, Vec::new(), cuts, context, None, now_ms)?;
        let mut group = group::load(&self.provider, id)?;
        group
            .merge_pending_commit(&self.provider)
            .map_err(mls_fault)?;
        self.meta(id)?.own_leaf_ms = now_ms;
        self.merging_now(now_ms);
        self.settle(batch, id, &group, posting.room_epoch)?;
        Ok(posting)
    }

    fn room_group(&self) -> Result<GroupId, Error> {
        let room = self.memory.record.room.ok_or(Error::NoRoom)?;
        if !self.is_human() {
            return Err(Error::Forbidden);
        }
        Ok(GroupId::room(room))
    }

    /// Adds a human device to the room group without an invite. Only under the cargo feature `vectors`, for
    /// the scenario tests and the generator of the vectors, whose subject is not the invite; in a shipped
    /// build a human device is added by [`Device::invite_confirm`] alone (12.1.4).
    #[cfg(feature = "vectors")]
    pub fn add_human_device(
        &mut self,
        device: &DeviceId,
        key_package: &[u8],
        now_ms: u64,
    ) -> Result<u64, Error> {
        self.transact(|this, batch| this.add_human(batch, device, key_package, now_ms))
    }

    /// Commits the Add of the human device `device` to the room group with its KeyPackage (5.1.2, 12.1.5),
    /// which must verify and be that device's (4.5).
    fn add_human(
        &mut self,
        batch: &mut Batch,
        device: &DeviceId,
        key_package: &[u8],
        now_ms: u64,
    ) -> Result<u64, Error> {
        let group = self.room_group()?;
        let history = self.history()?;
        let room = history.newest();
        if room.is_agent(device) || history.is_revoked(device, room.epoch) {
            return Err(Error::BadCommit);
        }
        if room.humans.len() >= MAX_HUMAN_DEVICES {
            return Err(Error::TooMany);
        }
        key_package::verify_key_package_of(key_package, device)?;
        let (package, _) = key_package::validated(key_package)?;
        let recovery_hpke_key = room.room.recovery_hpke_key;
        let outbox = self.commit(batch, &group, vec![package], &[], None, now_ms)?;
        // 7.4: the newcomer is owed the recovery_mac, written with the Commit that adds it.
        let recovery_mac = self
            .memory
            .macs
            .get(&recovery_hpke_key)
            .ok_or(Error::NoKey)?
            .duplicate();
        let owed = Owed {
            recovery_hpke_key,
            recovery_mac,
            bound: true,
        };
        self.put_owed(batch, outbox, *device, owed)?;
        Ok(outbox)
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

    /// Takes agent devices out of the room's `agents` (5.1.2). Removing one makes its main session and the
    /// helper sessions it opened stale (5.3.1). An agent device is enrolled by [`Device::invite_confirm`]
    /// alone (12.1.4).
    pub fn remove_agents(&mut self, remove: &[DeviceId], now_ms: u64) -> Result<u64, Error> {
        self.transact(|this, batch| this.set_agents(batch, &[], remove, now_ms))
    }

    /// Changes the room's enrolled agent devices without an invite. Only under the cargo feature `vectors`,
    /// like [`Device::add_human_device`].
    #[cfg(feature = "vectors")]
    pub fn change_agents(
        &mut self,
        enrol: &[DeviceId],
        remove: &[DeviceId],
        now_ms: u64,
    ) -> Result<u64, Error> {
        self.transact(|this, batch| this.set_agents(batch, enrol, remove, now_ms))
    }

    /// Commits a change of the room's enrolled agent devices (5.1.2): `enrol` are added to `agents`, `remove`
    /// taken out.
    fn set_agents(
        &mut self,
        batch: &mut Batch,
        enrol: &[DeviceId],
        remove: &[DeviceId],
        now_ms: u64,
    ) -> Result<u64, Error> {
        let group = self.room_group()?;
        let mut room = self.history()?.newest().room.clone();
        let mut agents: BTreeSet<DeviceId> = room.agents.iter().copied().collect();
        for gone in remove {
            if !agents.remove(gone) {
                return Err(Error::NotMember);
            }
        }
        agents.extend(enrol.iter().copied());
        room.agents = agents.into_iter().collect();
        self.commit(batch, &group, Vec::new(), &[], Some(room), now_ms)
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
    /// with more than 32 human or 256 agent devices is refused (`too-many`).
    ///
    /// A device that followed the group as an observer becomes its leaf here: what it verified (the room's
    /// roles per epoch with every revocation, a main session's agent leaf over time) becomes its own record,
    /// the joined state must agree with it at the same epoch and bring back no revoked key (`bad-group`), and
    /// the observer goes in the same write. A Welcome into the room group more than one epoch beyond what
    /// the observer followed is `room-behind` and uses up nothing: the device processes the log further and
    /// takes it then. One for an epoch the observer has left behind is `wrong-epoch`: a Welcome is taken at
    /// its place in the log, with the Commit that made it. A Welcome that is refused or does not open still uses up its single-use KeyPackage
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
            let mut joining = Batch::new();
            match this.join(&mut joining, welcome, expected, now_ms) {
                Ok(joined) => {
                    batch.put.append(&mut joining.put);
                    batch.delete.append(&mut joining.delete);
                    Ok(Ok(joined))
                }
                Err(error) => {
                    // Nothing of the attempt stays. The refusal stands, and so does the loss of the
                    // single-use KeyPackage (3.7), except where the Welcome only came too early: the room
                    // group is to be processed further first, and the Welcome is taken then.
                    this.reset()?;
                    if error != Error::RoomBehind {
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
                    Ok(Err(error))
                }
            }
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
        // An epoch no group reaches by Commits: such a state would not open again.
        if epoch > profile::MAX_STORED_EPOCH {
            return Err(Error::BadGroup);
        }
        let mut meta = GroupMeta {
            own_leaf_ms: now_ms,
            joined_epoch: epoch,
            ..GroupMeta::default()
        };
        let mut offending = Vec::new();
        match kind {
            GroupKind::Room(_) => {
                self.invited(batch, &id, &added_by, welcome)?;
                let state = rules::room_state_of(staged.group_context(), &leaves)?;
                // Section 16: a device is added to a room of at most 32 human and 256 agent devices.
                if state.humans.len() > MAX_HUMAN_DEVICES
                    || state.room.agents.len() > MAX_AGENT_DEVICES
                {
                    return Err(Error::TooMany);
                }
                // What the device verified as an observer becomes its own history; the observer goes.
                let observed = self
                    .retire_observer(batch, &id)
                    .and_then(Observer::into_history);
                self.adopt_room_history(batch, observed, state)?;
                self.memory.record.room = Some(expected.room);
                self.put_record(batch)?;
            }
            GroupKind::Session(session) => {
                self.enrolment_verified()?;
                if let Some(observer) = self.retire_observer(batch, &id) {
                    Self::adopt_session_record(&mut meta, &observer, epoch, &devices)?;
                }
                let known = self.known();
                let history = self.history()?;
                let room = history.newest();
                meta.session = Some(session);
                if session.parent.is_zero() && meta.seats.is_empty() {
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
        // Section 3: every leaf of the tree the Welcome brought is the profile's.
        rules::profile_leaves(group.public_group())?;
        let key = group::content_key(&self.provider, &group)?;
        self.bound_handed_keys(batch, &id, epoch);
        self.keep_key(batch, &id, epoch, key);
        self.memory.groups.insert(id, meta);
        self.put_group(batch, &id)?;
        // The Commit that began this epoch is not known to the joiner: the roles are those of the newest
        // room state it holds.
        self.record_epoch(batch, &id, epoch, &leaves, u64::MAX)?;
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
            this.observing_as_invited(expected_state, observer.history())?;
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
        self.transact(|this, batch| {
            let room = this.history()?.newest().clone();
            let observer = Observer::follow_session(group_info, &room)?;
            let group = observer.group();
            if group.room_id() != this.memory.record.room.ok_or(Error::NoRoom)?
                || this.memory.observers.contains_key(&group)
                || this.memory.groups.contains_key(&group)
            {
                return Err(Error::Replay);
            }
            // The device can tell how far the group is now: handed keys beyond that go.
            let beyond = observer.epoch()?.saturating_add(1);
            this.bound_handed_keys(batch, &group, beyond);
            this.memory.observers.insert(group, observer);
            Ok(())
        })
    }

    // ---- joining with the code (8.4, 8.5), replacing it (8.6), recovery (8.7) ----

    /// Takes over what the check of a served room established: the room, its roles from the founding on, the
    /// code's `recovery_mac`, and every content key the code opened, each marked if it is unconfirmed.
    fn take_checked(
        &mut self,
        batch: &mut Batch,
        keys: &RecoveryKeys,
        room: RoomId,
        checked: CheckedRoom,
    ) -> Result<(), Error> {
        let history = checked
            .observer
            .history()
            .ok_or(Error::Internal("room observer"))?
            .clone();
        for state in history.states() {
            batch.put(history_key(state.epoch), codec::encode(state)?);
        }
        self.memory.history = Some(history);
        self.memory.record.room = Some(room);
        self.put_record(batch)?;
        self.hold_mac(batch, keys.mac_key())?;
        for key in checked.keys {
            if self.keep_key(batch, &key.group, key.epoch, key.key) && !key.confirmed {
                batch.put(unconfirmed_key(&key.group, key.epoch), Vec::new());
                self.memory.unconfirmed.insert((key.group, key.epoch));
            }
        }
        Ok(())
    }

    /// Joins the group of `group_info` from outside (3.4, 8.4), in the state this is called on, which is a
    /// copy: the Commit with `join` = 1 naming the newest room state, its `RecoveryAuth` signed with the
    /// code, and the `SealedKey` of the epoch it leads to. `seats` is a main session's agent leaf over time,
    /// as its verification from the founding found it.
    fn join_built(
        &mut self,
        batch: &mut Batch,
        keys: &RecoveryKeys,
        group_info: &[u8],
        seats: &[(u64, Option<DeviceId>)],
        now_ms: u64,
    ) -> Result<Posting, Error> {
        let room = self.history()?.newest().clone();
        let verifiable = observer::parse_group_info(group_info)?;
        let (id, kind) =
            profile::kind_of_context(verifiable.group_context()).map_err(|_| Error::BadGroup)?;
        if self.memory.record.room != Some(id.room_id()) {
            return Err(Error::WrongRoom);
        }
        let known = self.memory.groups.get(&id);
        // 5.2.10: an archived session is not reopened.
        if known.is_some_and(|meta| meta.archived) {
            return Err(Error::Gone);
        }
        if known.is_some_and(|meta| !meta.removed) {
            return Err(Error::Replay);
        }
        // 4.3: a device that lost its state comes back under a new key. With a leaf of this key in the
        // tree the join would remove that leaf, and a Remove needs the Cut that only the others hold.
        if group::tree_holds(&verifiable, &self.id) {
            return Err(Error::BadCommit);
        }
        let note = CommitNote {
            room_epoch: room.epoch,
            room_state: room.state,
            time: now_ms,
            cuts: Vec::new(),
            join: true,
        };
        let (group, built) = group::external_commit(&self.provider, &self.key, group_info, &note)?;
        let join = RecoveryJoin {
            base: KeyContext::of(&id, built.epoch, group_info)?,
            room_epoch: room.epoch,
            room_state: room.state,
            joiner: self.id,
        };
        let recovery_auth = keys.authorise(&join, &built.commit)?;
        let sealed = self.seal_key(
            (&id, built.epoch.saturating_add(1)),
            &built.next_key,
            &built.group_info,
            (room.epoch, &room.room.recovery_hpke_key),
            true,
            None,
        )?;
        self.memory.groups.insert(
            id,
            GroupMeta {
                session: match kind {
                    GroupKind::Session(session) => Some(session),
                    GroupKind::Room(_) => None,
                },
                seats: seats.to_vec(),
                own_leaf_ms: now_ms,
                joined_epoch: built.epoch.saturating_add(1),
                ..GroupMeta::default()
            },
        );
        self.settle(batch, &id, &group, room.epoch)?;
        Ok(Posting {
            group: id,
            epoch: built.epoch,
            commit: built.commit,
            group_info: built.group_info,
            welcome: Vec::new(),
            sealed,
            recovery_auth,
            room_epoch: room.epoch,
            renews_leaf: true,
        })
    }

    /// Whether a join from outside into `group` already waits for the hub.
    fn joining(&self, group: &GroupId) -> bool {
        self.memory
            .outbox
            .values()
            .any(|entry| entry.kind == OutboxKind::ExternalCommit && entry.group == Some(*group))
    }

    /// Puts a join from outside in the outbox, with the copy it was built on kept beside it.
    fn post_join(&mut self, posting: Posting, copy: Batch) -> Result<u64, Error> {
        self.transact(|this, batch| {
            let outbox = this.enqueue(
                batch,
                OutboxKind::ExternalCommit,
                Some(posting.group),
                posting.epoch,
                vec![
                    posting.commit,
                    posting.group_info,
                    posting.sealed,
                    posting.recovery_auth,
                ],
            )?;
            this.stage(batch, vec![outbox], copy)?;
            Ok(outbox)
        })
    }

    /// Signs in on a new device with the recovery code (8.4, 8.5): checks the room the hub serves
    /// ([`recovery::check_room`]: the anchor, the walk from the founding, the agreement of the current
    /// GroupInfo, the code's public keys, the links, the rows) and builds the join of the room group from
    /// outside on a copy of the state. Nothing of the real state changes until the hub accepted the outbox
    /// entry; then the device is a human device, holds the room's roles from its founding, the code's
    /// `recovery_mac` and every content key the code opened. It joins each live session group next
    /// ([`Device::join_session_with_code`]). The caller drops `keys` when the last join is posted: the device
    /// keeps nothing of the code but `recovery_mac`.
    pub fn join_room_with_code(
        &mut self,
        keys: &RecoveryKeys,
        served: &ServedRoom<'_>,
        now_ms: u64,
    ) -> Result<CodeJoin, Error> {
        if self.memory.record.room.is_some() {
            return Err(Error::RoomExists);
        }
        if self.joining(&GroupId::room(served.room)) {
            return Err(Error::Busy);
        }
        let checked = recovery::check_room(keys, served)?;
        let missing_link = checked.missing_link;
        let unverified = checked
            .sessions
            .iter()
            .enumerate()
            .filter_map(|(at, session)| Some((at, session.as_ref().err()?.clone())))
            .collect();
        let (posting, copy) = self.shadow(|this, batch| {
            this.take_checked(batch, keys, served.room, checked)?;
            this.join_built(batch, keys, served.group.current, &[], now_ms)
        })?;
        Ok(CodeJoin {
            outbox: vec![self.post_join(posting, copy)?],
            missing_link,
            unverified,
        })
    }

    /// Joins a live session group with the recovery code (8.4, 5.2.7), as a human device that joined the
    /// room group with it: verifies the group as any reader does, from its founding GroupInfo through its
    /// Commits against the room states this device holds, requires the GroupInfo served as current to agree
    /// with the state so reached, and builds the join from outside on a copy of the state. A stale group
    /// takes the join too. Main sessions are joined before their helper sessions.
    pub fn join_session_with_code(
        &mut self,
        keys: &RecoveryKeys,
        served: &ServedGroup<'_>,
        now_ms: u64,
    ) -> Result<u64, Error> {
        let room = self.memory.record.room.ok_or(Error::NoRoom)?;
        if !self.is_human() {
            return Err(Error::Forbidden);
        }
        let checked = recovery::check_session(served, &room, self.history()?, &self.known())?;
        if self.joining(&checked.observer.group()) {
            return Err(Error::Busy);
        }
        let seats = checked.observer.seats().to_vec();
        let (posting, copy) = self
            .shadow(|this, batch| this.join_built(batch, keys, served.current, &seats, now_ms))?;
        self.post_join(posting, copy)
    }

    /// First contact with a session group this device joined by Welcome (5.2.6): verifies the group as any
    /// reader does, from its founding GroupInfo through its Commits against the room states this device holds
    /// ([`recovery::check_session`]), so that a helper session is known to have been founded by its main
    /// session's agent leaf of that time, and requires what the hub serves to end in the state this device
    /// stands in. `bad-group` is the finding: the device then opens none of the session's content and removes
    /// the offending leaves or leaves the group closed. `room-behind` when this device's record of the room
    /// does not reach back to the session's founding, and `group-behind` when the device has not processed
    /// the group up to what is served: neither is a finding.
    pub fn verify_founding(&self, group: &GroupId, served: &ServedGroup<'_>) -> Result<(), Error> {
        self.owner()?;
        let room = self.memory.record.room.ok_or(Error::NoRoom)?;
        if !self.is_leaf_of(group) || group.is_room() {
            return Err(Error::NotFound);
        }
        let checked = recovery::check_session(served, &room, self.history()?, &self.known())
            .map_err(|error| match error {
                Error::WrongRecovery | Error::WrongRoom => Error::BadGroup,
                other => other,
            })?;
        if checked.observer.group() != *group {
            return Err(Error::BadGroup);
        }
        let own = group::load(&self.provider, group)?;
        if checked.observer.epoch()? != own.epoch().as_u64() {
            return Err(Error::GroupBehind);
        }
        // The state reached from the founding is this device's own: the GroupInfo that agrees with the one
        // agrees with the other.
        observer::signer_of(own.public_group(), served.current)
            .map(|_| ())
            .map_err(|_| Error::BadGroup)
    }

    /// Replaces the recovery code (8.6) as a human device that holds the current code `keys`: one request with
    /// the room Commit that puts the new public keys into the room's state, its `SealedKey` sealed to the new
    /// key, the `RecoveryLink` and the account's new sealed copies. `replacement` comes from
    /// [`RecoveryKeys::replace`] with this device's [`Device::room_history`]; `account` are the sealed
    /// copies of `replacement.code`, opaque here. When the hub accepted it, the device holds the new
    /// `recovery_mac` and sends it to every human device.
    pub fn replace_code(
        &mut self,
        keys: &RecoveryKeys,
        replacement: &Replacement,
        account: &[u8],
        now_ms: u64,
    ) -> Result<u64, Error> {
        self.transact(|this, batch| {
            let group = this.room_group()?;
            let history = this.history()?;
            let mut room = history.newest().room.clone();
            keys.check_room(&room)?;
            let new = this.new_keys(replacement)?;
            room.recovery_signature_key = new.signature_key;
            room.recovery_hpke_key = new.hpke_key;
            let new_mac = replacement.keys.mac_key();
            let posting = this.build(
                &group,
                Vec::new(),
                &[],
                Some(room),
                Some(&new_mac.key),
                now_ms,
            )?;
            let with = [replacement.link.clone(), account.to_vec()];
            let outbox = this.pend(batch, posting, Some(with), now_ms)?;
            let owed = Owed {
                recovery_hpke_key: new_mac.recovery_hpke_key,
                recovery_mac: new_mac.key,
                bound: true,
            };
            this.put_owed(batch, outbox, DeviceId::ZERO, owed)?;
            Ok(outbox)
        })
    }

    /// The public keys of a replacement, if the room never held them (8.6); `bad-commit` otherwise.
    fn new_keys(&self, replacement: &Replacement) -> Result<RecoveryPublic, Error> {
        let history = self.history()?;
        let new = replacement.keys.public();
        if history.held_recovery_key(&new.signature_key) || history.held_recovery_key(&new.hpke_key)
        {
            return Err(Error::BadCommit);
        }
        Ok(new)
    }

    /// The Cuts for the leaves `gone` of `group`, from what the caller verified; `incomplete` when one is
    /// missing.
    fn cuts_of(
        group: &GroupId,
        gone: &[DeviceId],
        cuts: &[(GroupId, Cut)],
    ) -> Result<Vec<Cut>, Error> {
        gone.iter()
            .map(|device| {
                cuts.iter()
                    .find(|(of, cut)| of == group && cut.device == *device)
                    .map(|(_, cut)| *cut)
                    .ok_or(Error::Incomplete)
            })
            .collect()
    }

    /// The whole recovery, when every device is lost (8.7), as a new device with the code `keys`. `served` is
    /// what the hub serves after the recovery was opened there, with every live session group. The device
    /// checks the room as in [`Device::join_room_with_code`] and requires every session to verify; then, on
    /// a copy of its state, it joins the room group and every session group from outside, commits in the
    /// room group the removal of every other human device together with the replacement of the code, and
    /// after that, against the new room epoch, removes from every session group (main sessions first) each
    /// leaf the new room state does not allow. `cuts` hold, per group, the Cut of every leaf to go
    /// ([`recovery::removals`] names them), as the caller verified each chain through pruned envelopes;
    /// `incomplete` when one is missing. `account` are the sealed copies of `replacement.code`.
    ///
    /// The outbox entries are the recovery's Commits in order and its finish. The device's state changes
    /// only when the hub accepted the finish; when the hub refuses any of them, or the recovery ran out,
    /// which the caller reports as a refusal, all of it goes and the state is as before.
    pub fn recover(
        &mut self,
        keys: &RecoveryKeys,
        served: &ServedRoom<'_>,
        replacement: &Replacement,
        cuts: &[(GroupId, Cut)],
        account: &[u8],
        now_ms: u64,
    ) -> Result<CodeJoin, Error> {
        if self.memory.record.room.is_some() {
            return Err(Error::RoomExists);
        }
        if !self.memory.staged.is_empty() {
            return Err(Error::Busy);
        }
        let mut checked = recovery::check_room(keys, served)?;
        let missing_link = checked.missing_link;
        // Every live session is joined and cleaned, or the hub publishes nothing.
        let mut sessions = Vec::new();
        for (session, served) in std::mem::take(&mut checked.sessions)
            .into_iter()
            .zip(served.sessions)
        {
            sessions.push((session?.observer.seats().to_vec(), served.current));
        }
        let room_group = GroupId::room(served.room);
        let (postings, copy) = self.shadow(|this, batch| {
            this.take_checked(batch, keys, served.room, checked)?;
            this.hold_mac(batch, replacement.keys.mac_key())?;
            let mut postings =
                vec![this.join_built(batch, keys, served.group.current, &[], now_ms)?];
            for (seats, current) in &sessions {
                postings.push(this.join_built(batch, keys, current, seats, now_ms)?);
            }
            // The room Commit: every other human device goes, and the code with them.
            let mut room = this.history()?.newest().clone();
            let others: Vec<DeviceId> = room
                .humans
                .iter()
                .copied()
                .filter(|human| *human != this.id)
                .collect();
            let new = this.new_keys(replacement)?;
            room.room.recovery_signature_key = new.signature_key;
            room.room.recovery_hpke_key = new.hpke_key;
            let gone = Self::cuts_of(&room_group, &others, cuts)?;
            postings.push(this.commit_now(batch, &room_group, &gone, Some(room.room), now_ms)?);
            // The session groups, against the new room epoch: main sessions before helper sessions.
            let mut groups = this.groups()?;
            groups.retain(|summary| summary.session.is_some());
            groups.sort_by_key(|summary| {
                summary
                    .session
                    .is_some_and(|session| !session.parent.is_zero())
            });
            for summary in groups {
                let unfit = this.group(&summary.group)?.disallowed;
                if unfit.is_empty() {
                    continue;
                }
                let gone = Self::cuts_of(&summary.group, &unfit, cuts)?;
                postings.push(this.commit_now(batch, &summary.group, &gone, None, now_ms)?);
            }
            // The log brings every Commit of the recovery by again: none of them is for this device.
            let ids: Vec<GroupId> = this.memory.groups.keys().copied().collect();
            for id in ids {
                let epoch = group::load(&this.provider, &id)?.epoch().as_u64();
                this.meta(&id)?.joined_epoch = epoch;
                this.put_group(batch, &id)?;
            }
            Ok(postings)
        })?;
        let outbox = self.transact(|this, batch| {
            let mut outbox = Vec::new();
            for posting in postings {
                outbox.push(this.enqueue(
                    batch,
                    OutboxKind::RecoveryCommit,
                    Some(posting.group),
                    posting.epoch,
                    vec![
                        posting.commit,
                        posting.group_info,
                        posting.welcome,
                        posting.sealed,
                        posting.recovery_auth,
                    ],
                )?);
            }
            outbox.push(this.enqueue(
                batch,
                OutboxKind::RecoveryFinish,
                Some(room_group),
                0,
                vec![replacement.link.clone(), account.to_vec()],
            )?);
            this.stage(batch, outbox.clone(), copy)?;
            Ok(outbox)
        })?;
        Ok(CodeJoin {
            outbox,
            missing_link,
            unverified: Vec::new(),
        })
    }

    /// Posts the `SealedKey` of the epoch `group` stands in, with this device's `mac` (8.3), when the hub
    /// lists none for it whose `mac` this device can verify: `listed` are the rows the hub lists, and
    /// `group_info` the GroupInfo it holds for that epoch, which is checked against this device's own state of
    /// the group before the row names it (`incomplete` when it is another). Returns none when an
    /// authenticated row is listed. Only a human device posts one.
    pub fn post_sealed_key(
        &mut self,
        group: &GroupId,
        group_info: &[u8],
        listed: &[Vec<u8>],
    ) -> Result<Option<u64>, Error> {
        self.transact(|this, batch| {
            if !this.is_human() {
                return Err(Error::Forbidden);
            }
            let meta = this.meta(group)?.clone();
            if meta.archived {
                return Err(Error::Gone);
            }
            // 5.2.8: nothing is written for a stale group but the Commit that cleans it, with its own row.
            if !this.group(group)?.disallowed.is_empty() {
                return Err(Error::StaleSession);
            }
            let state = group::load(&this.provider, group)?;
            let epoch = state.epoch().as_u64();
            let begun = if group.is_room() {
                epoch
            } else {
                meta.previous_room_epoch
            };
            let listed = recovery::lists_authenticated(
                listed,
                (group, epoch),
                &this.memory.macs,
                this.history()?,
                begun,
            )?;
            if listed {
                return Ok(None);
            }
            observer::signer_of(state.public_group(), group_info)?;
            let key = this.content_key(group, epoch)?;
            let room = this.history()?.newest().clone();
            let sealed = this.seal_key(
                (group, epoch),
                &key,
                group_info,
                (room.epoch, &room.room.recovery_hpke_key),
                true,
                None,
            )?;
            this.enqueue(
                batch,
                OutboxKind::SealedKey,
                Some(*group),
                epoch,
                vec![sealed],
            )
            .map(Some)
        })
    }

    // ---- the log ----

    /// Processes one entry of the hub's ordered log (5.4.1, 13.2): the group state after it, the content key of
    /// a new epoch and the cursor are written together. Entries are handed in the hub's order across groups; a
    /// Commit that is not the next of its group, or a session Commit whose room epoch this device has not
    /// reached, is refused and changes nothing ([`log_finding`]).
    ///
    /// Every entry is processed once: one whose `change` is not above [`Device::cursor`] is refused as a
    /// duplicate (`wrong-epoch`). An entry processed moves the cursor to its `change`, so handing a later
    /// entry first passes the earlier ones. An own request that the hub accepted moves the cursor only when
    /// its `change` is the next one; otherwise the log brings it by again, above the cursor, and it is met
    /// there ([`Processed::OwnCommit`], or a message that is skipped).
    ///
    /// One kind of entry is processed at or below the cursor, and leaves the cursor where it is: the next
    /// Commit of a group this device is a leaf of or follows, the one that names the epoch the group stands
    /// in. It cannot be a duplicate. A device meets it there when it joined a group by a Welcome it took
    /// after it had passed that group's later Commits, or when an entry was filed under another group: it
    /// hands the group's entries again from the Welcome's place, and each next Commit is processed. An
    /// application message at or below the cursor stays a duplicate: it opens once.
    ///
    /// An entry called a message whose bytes are a handshake message (a `PublicMessage`) of a group this
    /// device is a leaf of or follows, by the group the message itself names, is refused (`bad-format`, the
    /// finding `bad-group`) and the cursor stays: it is not passed over as a message that does not open.
    ///
    /// `now_ms` is this device's clock: when it processed the Commit that ended an epoch decides how long
    /// an envelope of that epoch is still taken (9.0.5, check 8).
    pub fn process_log_entry(
        &mut self,
        entry: &LogEntry<'_>,
        now_ms: u64,
    ) -> Result<Processed, Error> {
        let (processed, adopted) = self.transact(|this, batch| {
            this.begin(now_ms);
            let mut adopted = false;
            // 5.4.1: every entry once, in the hub's order. One at or below the cursor was processed, or was
            // passed when a later one was: it is a duplicate. The one exception is the next Commit of a
            // group this device is a leaf of or follows, which cannot have been processed.
            if entry.change <= this.memory.record.cursor && !this.is_next_commit(entry) {
                return Err(Error::WrongEpoch);
            }
            // A group this device is a leaf of is processed as a member, also when an observer of it is
            // still held.
            let member = this.is_leaf_of(&entry.group);
            let observed = this.memory.observers.contains_key(&entry.group);
            let processed = match entry.kind {
                LogKind::Commit {
                    bytes,
                    recovery_auth,
                } => match this.decide_staged(batch, &entry.group, bytes)? {
                    Some(StagedVerdict::Own) => {
                        adopted = true;
                        Processed::OwnCommit
                    }
                    verdict => {
                        let processed = if member {
                            this.process_commit(batch, &entry.group, bytes, recovery_auth)?
                        } else if observed {
                            this.observe_commit(&entry.group, bytes, recovery_auth)?
                        } else {
                            Processed::Skipped
                        };
                        match (verdict, processed) {
                            (Some(StagedVerdict::Superseded(superseded)), processed) => {
                                Processed::JoinSuperseded {
                                    superseded,
                                    observed: match processed {
                                        Processed::Observed(facts) => Some(facts),
                                        _ => None,
                                    },
                                }
                            }
                            (_, processed) => processed,
                        }
                    }
                },
                LogKind::Message { bytes } => {
                    // A handshake message of a group this device follows is no application message,
                    // whatever the entry is called and whichever group it is filed under: passing it over
                    // would lose a Commit.
                    let hidden = handshake_group(bytes).is_some_and(|named| {
                        this.is_leaf_of(&named) || this.memory.observers.contains_key(&named)
                    });
                    if hidden {
                        return Err(Error::BadFormat);
                    }
                    if member {
                        this.process_message(batch, &entry.group, bytes)?
                    } else {
                        Processed::Skipped
                    }
                }
            };
            this.enrolled_by_inviter(batch, &processed)?;
            this.advance(batch, entry.change)?;
            Ok((processed, adopted))
        })?;
        if adopted {
            // What was staged is stored now: memory follows it.
            self.reset()?;
        }
        Ok(processed)
    }

    /// 13.2 for a join from outside into `group` that waits: a Commit of the log that is the join's own makes
    /// the copy the real state, as the hub's acceptance does, so that the Commits behind it are processed as
    /// a member; another Commit for the epoch the join builds on, or a later one, took that epoch, and the
    /// join with its outbox entry is dropped. A Commit of an earlier epoch decides nothing.
    fn decide_staged(
        &mut self,
        batch: &mut Batch,
        group: &GroupId,
        commit: &[u8],
    ) -> Result<Option<StagedVerdict>, Error> {
        let waiting = self.memory.outbox.values().find(|entry| {
            entry.kind == OutboxKind::ExternalCommit
                && entry.group == Some(*group)
                && self.memory.staged.contains_key(&entry.id)
        });
        let Some((outbox, built_on, own)) = waiting.map(|entry| {
            let own = entry.parts.first().is_some_and(|own| own == commit);
            (entry.id, entry.epoch, own)
        }) else {
            return Ok(None);
        };
        if own {
            self.adopt_staged(batch, outbox)?;
            self.drop_outbox(batch, outbox);
            return Ok(Some(StagedVerdict::Own));
        }
        let takes_the_epoch = rules::parse_commit(commit).is_ok_and(|message| {
            GroupId::from_bytes(message.group_id().as_slice()) == Ok(*group)
                && message.epoch().as_u64() >= built_on
        });
        if !takes_the_epoch {
            return Ok(None);
        }
        self.drop_staged(batch, outbox);
        Ok(Some(StagedVerdict::Superseded(outbox)))
    }

    fn is_leaf_of(&self, group: &GroupId) -> bool {
        self.memory
            .groups
            .get(group)
            .is_some_and(|meta| !meta.removed)
    }

    /// Whether `entry` is the next Commit of its group as this device holds or follows it: the Commit names
    /// the group and the epoch the group stands in. Such an entry was not processed, whatever its place in the
    /// log: a device that took a Welcome after it had passed the group's later Commits meets them this way.
    fn is_next_commit(&self, entry: &LogEntry<'_>) -> bool {
        let LogKind::Commit { bytes, .. } = entry.kind else {
            return false;
        };
        let Ok(message) = rules::parse_commit(bytes) else {
            return false;
        };
        if GroupId::from_bytes(message.group_id().as_slice()) != Ok(entry.group) {
            return false;
        }
        let stands = if self.is_leaf_of(&entry.group) {
            group::load(&self.provider, &entry.group)
                .ok()
                .map(|group| group.epoch().as_u64())
        } else {
            self.memory
                .observers
                .get(&entry.group)
                .and_then(|observer| observer.epoch().ok())
        };
        stands == Some(message.epoch().as_u64())
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
            recovery: &PublicRules,
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
            recovery: &PublicRules,
            max_human_devices: profile::MAX_HUMAN_DEVICES_IN_RECOVERY,
            posting: false,
        };
        let judged = Judged {
            facts: &facts,
            commit,
            recovery_auth,
            base_group_info: None,
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
        // A device removed from the room group goes on as an observer of it, so that it knows the room
        // state that removed it and judges its remaining session groups against it.
        let follower = if id.is_room() && staged.self_removed() {
            Some(self.follow_after_removal(id, commit, recovery_auth, &known)?)
        } else {
            None
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
        self.merging_foreign(facts.note.as_ref());
        self.settle(batch, id, &group, room_epoch)?;
        if let Some(observer) = follower {
            // The roles are the observer's from here on: the device's own record of them goes.
            for state in self
                .memory
                .history
                .take()
                .iter()
                .flat_map(RoomHistory::states)
            {
                batch.delete(history_key(state.epoch));
            }
            self.memory.observers.insert(*id, observer);
        }
        Ok(Processed::Commit {
            facts,
            superseded,
            removed,
        })
    }

    /// An observer of the room group that stands behind `commit`, which removes this device: started from the
    /// public state this device holds as a leaf, with its history, and then following the Commit as any
    /// observer does. OpenMLS gives a removed member the new tree and no full group context; the observer has
    /// both. Nothing of the state before the Commit is verified again: the leaf verified it.
    fn follow_after_removal(
        &self,
        group: &GroupId,
        commit: &[u8],
        recovery_auth: Option<&[u8]>,
        known: &Known,
    ) -> Result<Observer, Error> {
        let id = openmls::prelude::GroupId::from_slice(group.as_bytes());
        let public = provider::public_entries(&self.provider.entries(), &id)?;
        let history = self.memory.history.clone().ok_or(Error::RoomBehind)?;
        let mut observer = Observer::from_member(public, *group, history)?;
        let context = Context {
            room: None,
            sessions: known,
            recovery: &PublicRules,
            max_human_devices: profile::MAX_HUMAN_DEVICES_IN_RECOVERY,
        };
        observer.process_commit(commit, recovery_auth, &context)?;
        Ok(observer)
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
        let content = Zeroizing::new(content.into_bytes());
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
        let history = self.history()?;
        let room = history.newest().clone();
        let from_human = room.is_human(&from);
        let from_revoked = history.is_revoked(&from, room.epoch);
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
                    // Only for an epoch that group has reached. A human device is handed the keys of the
                    // session groups in the room group before it is added to them (7.1): of a session group
                    // it never held it takes them unchecked and remembers that, until it joins the group.
                    // A key of a group whose epoch it cannot tell for another reason is not taken.
                    let reached = if here {
                        Reached::Epoch(own_epoch)
                    } else {
                        self.reached(&key.group)
                    };
                    let unbound = match reached {
                        Reached::Epoch(reached) if key.epoch <= reached => false,
                        Reached::NotJoined if !key.group.is_room() => true,
                        _ => continue,
                    };
                    let (of, epoch) = (key.group, key.epoch);
                    if self.keep_key(batch, &of, epoch, key.content_key) {
                        taken = taken.saturating_add(1);
                        if unbound {
                            self.memory.unbound.insert((of, epoch));
                            batch.put(unbound_key(&of, epoch), Vec::new());
                        }
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
                // 7.3: from the session's agent or helper devices. A leaf that is no human device is one of them
                // unless its key is revoked: a removed human device, or a replaced agent device.
            } if session.is_some() && !from_human && !from_revoked && number != 0 => {
                Received::WorkTrail {
                    from,
                    turn,
                    number,
                    time,
                    step,
                }
            }
            TrommiMessage::RecoveryAuth {
                recipient,
                recovery_hpke_key,
                recovery_mac,
            } if session.is_none() => {
                let message = AuthMessage {
                    sender: &from,
                    recipient: &recipient,
                    recovery_hpke_key: &recovery_hpke_key,
                    recovery_mac: &recovery_mac,
                };
                // The message was opened in the group's current epoch, whose state `room` is.
                let taken =
                    recovery::take_recovery_auth(&mut self.memory.macs, &self.id, &room, &message);
                match taken {
                    Ok(Taken::New) => {
                        batch.put(mac_key(&recovery_hpke_key), recovery_mac.expose().to_vec());
                        Received::RecoveryAuth {
                            from,
                            recovery_hpke_key,
                            new: true,
                        }
                    }
                    Ok(Taken::Held) => Received::RecoveryAuth {
                        from,
                        recovery_hpke_key,
                        new: false,
                    },
                    Ok(Taken::Dropped) => Received::Dropped,
                    Err(Error::Equivocation) => Received::RecoveryAuthConflict {
                        from,
                        recovery_hpke_key,
                    },
                    Err(error) => return Err(error),
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
        // A message may carry keys: its plaintext is wiped.
        let plaintext = Zeroizing::new(codec::encode(message)?);
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
            // 5.2.6: no key of a group that failed its first contact is handed on.
            let quarantined: BTreeSet<GroupId> = this
                .memory
                .groups
                .iter()
                .filter(|(_, meta)| meta.distrusted)
                .map(|(of, _)| *of)
                .collect();
            let keys: Vec<EpochKey> = this
                .memory
                .keys
                .iter()
                .filter(|((of, _), _)| of == group || (group.is_room() && human))
                .filter(|((of, _), _)| !quarantined.contains(of))
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
    /// room group, from a human device that holds it (`no-key` otherwise). This answers the request of a
    /// device that does not hold it; after an Add by link and after a replacement of the code the device sends
    /// it by itself, with the Commit. The message is owed until the hub took it. Returns its outbox entry, or
    /// none while a Commit of this device is pending in the room group: it is then sent when that is decided.
    pub fn send_recovery_auth(&mut self, recipient: &DeviceId) -> Result<Option<u64>, Error> {
        self.transact(|this, batch| {
            this.room_group()?;
            let recovery_hpke_key = this.history()?.newest().room.recovery_hpke_key;
            let recovery_mac = this
                .memory
                .macs
                .get(&recovery_hpke_key)
                .ok_or(Error::NoKey)?
                .duplicate();
            let owed = Owed {
                recovery_hpke_key,
                recovery_mac,
                bound: false,
            };
            this.owe(batch, *recipient, owed)
        })
    }
}

/// What a KeyPackage says, for a caller that picks the ones to add: re-exported beside the device's API.
pub fn key_package_info(bytes: &[u8]) -> Result<KeyPackageInfo, Error> {
    key_package::verify_key_package(bytes)
}
