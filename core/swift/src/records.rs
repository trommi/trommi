//! The plain data of the device's calls: ids are bytes, counts are numbers, and what the core tells with an enum
//! that carries data is a record with a `kind` and the fields that kind fills.

use crate::CoreError;
use trommi_core::device as core;
use trommi_core::ids::{BoardId, DeviceId, GroupId, Hash32, RoomId, SessionId, TurnId};
use trommi_core::mls::key_package::KeyPackageInfo as CoreKeyPackageInfo;
use trommi_core::mls::profile::{Cut as CoreCut, GroupKind};
use trommi_core::mls::rules::{CommitFacts, ContextChange, RoomState};
use trommi_core::store::{OutboxEntry as CoreOutboxEntry, OutboxKind as CoreOutboxKind};

/// A device id from its 32 bytes.
pub(crate) fn device_id(bytes: &[u8]) -> Result<DeviceId, CoreError> {
    Ok(DeviceId::from_slice(bytes)?)
}

/// A room id from its 32 bytes.
pub(crate) fn room_id(bytes: &[u8]) -> Result<RoomId, CoreError> {
    Ok(RoomId::from_slice(bytes)?)
}

/// A session id from its 16 bytes.
pub(crate) fn session_id(bytes: &[u8]) -> Result<SessionId, CoreError> {
    Ok(SessionId::from_slice(bytes)?)
}

/// A group id from its 32 or 48 bytes.
pub(crate) fn group_id(bytes: &[u8]) -> Result<GroupId, CoreError> {
    Ok(GroupId::from_bytes(bytes)?)
}

/// A hash from its 32 bytes.
pub(crate) fn hash32(bytes: &[u8]) -> Result<Hash32, CoreError> {
    Ok(Hash32::from_slice(bytes)?)
}

/// A board id from its 16 bytes.
pub(crate) fn board_id(bytes: &[u8]) -> Result<BoardId, CoreError> {
    Ok(BoardId::from_slice(bytes)?)
}

/// A turn id from its 16 bytes.
pub(crate) fn turn_id(bytes: &[u8]) -> Result<TurnId, CoreError> {
    Ok(TurnId::from_slice(bytes)?)
}

fn devices<'a>(devices: impl IntoIterator<Item = &'a DeviceId>) -> Vec<Vec<u8>> {
    devices
        .into_iter()
        .map(|device| device.as_bytes().to_vec())
        .collect()
}

/// A count as the edge carries it: nothing the core counts passes 2^32.
fn count(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

record! {
    /// Which session of which room a session group is.
    pub struct SessionInfo {
        /// The room, 32 bytes.
        pub room_id: Vec<u8>,
        /// The session, 16 bytes.
        pub session_id: Vec<u8>,
        /// The main session a helper session hangs under, 16 bytes; zeros for a main session.
        pub parent: Vec<u8>,
    }
}

record! {
    /// One group as the device holds it.
    pub struct GroupSummary {
        /// The group id: the room's 32 bytes, for a session group followed by the session's 16.
        pub group: Vec<u8>,
        /// For a session group, which session it is.
        pub session: Option<SessionInfo>,
        /// Its epoch.
        pub epoch: u64,
        /// The devices of its leaves, ascending.
        pub leaves: Vec<Vec<u8>>,
        /// The leaves the newest room state does not allow: not empty means the group is stale, and a human
        /// device cleans it with `clean_session`.
        pub disallowed: Vec<Vec<u8>>,
        /// Whether this device archived it.
        pub archived: bool,
        /// Whether a Commit of this device waits for the hub's answer.
        pub pending: bool,
    }
}

impl From<core::GroupSummary> for GroupSummary {
    fn from(summary: core::GroupSummary) -> Self {
        Self {
            group: summary.group.as_bytes().to_vec(),
            session: summary.session.map(|session| SessionInfo {
                room_id: session.room_id.as_bytes().to_vec(),
                session_id: session.session_id.as_bytes().to_vec(),
                parent: session.parent.as_bytes().to_vec(),
            }),
            epoch: summary.epoch,
            leaves: devices(&summary.leaves),
            disallowed: devices(&summary.disallowed),
            archived: summary.archived,
            pending: summary.pending,
        }
    }
}

record! {
    /// The room's roles at its newest epoch, as this device knows them.
    pub struct RoomRoles {
        /// The room group's epoch.
        pub epoch: u64,
        /// The hash that names the room's state at that epoch, 32 bytes.
        pub state: Vec<u8>,
        /// The human devices: the leaves of the room group.
        pub humans: Vec<Vec<u8>>,
        /// The enrolled agent devices.
        pub agents: Vec<Vec<u8>>,
        /// The public key that authorises a join with the recovery code.
        pub recovery_signature_key: Vec<u8>,
        /// The public key every content key is sealed to.
        pub recovery_hpke_key: Vec<u8>,
    }
}

impl From<&RoomState> for RoomRoles {
    fn from(state: &RoomState) -> Self {
        Self {
            epoch: state.epoch,
            state: state.state.as_bytes().to_vec(),
            humans: devices(&state.humans),
            agents: devices(&state.room.agents),
            recovery_signature_key: state.room.recovery_signature_key.to_vec(),
            recovery_hpke_key: state.room.recovery_hpke_key.to_vec(),
        }
    }
}

choice! {
    /// What an outbox entry asks the hub for. The parts of each kind, in order; a part a request does not have
    /// is empty.
    pub enum OutboxKind {
        /// The founding of a room: GroupInfo of epoch 0, its SealedKey.
        RoomFounding = "roomFounding",
        /// The founding of a session group: GroupInfo of epoch 0, its SealedKey, the first Commit, its
        /// GroupInfo, its Welcome, its SealedKey.
        GroupFounding = "groupFounding",
        /// A Commit by a member: Commit, GroupInfo, Welcome, SealedKey.
        Commit = "commit",
        /// A join from outside: Commit, GroupInfo, SealedKey, RecoveryAuth.
        ExternalCommit = "externalCommit",
        /// An application message the hub stores: the message.
        Message = "message",
        /// An application message the hub only passes on: the message.
        RelayMessage = "relayMessage",
        /// A stored item: the Envelope.
        Envelope = "envelope",
        /// KeyPackages to publish: the last-resort one, then the single-use ones.
        KeyPackages = "keyPackages",
        /// A SealedKey posted on its own: the SealedKey.
        SealedKey = "sealedKey",
        /// The replacing of the recovery code: Commit, GroupInfo, SealedKey, RecoveryLink.
        RecoveryCode = "recoveryCode",
    }
}

record! {
    /// One request waiting to be sent, or sent and not yet answered. The host posts it, then reports the hub's
    /// answer with `outbox_accepted` or `outbox_refused`; until then the same entry is listed again, also after a
    /// restart, and is sent again unchanged.
    pub struct OutboxEntry {
        /// Its place in the order of sending.
        pub id: u64,
        /// Which request it is.
        pub kind: OutboxKind,
        /// The group it is for; none for KeyPackages.
        pub group: Option<Vec<u8>>,
        /// The epoch a Commit builds on, or a message was made in; 0 for a kind without one.
        pub epoch: u64,
        /// The exact bytes of every part, in the order its kind names.
        pub parts: Vec<Vec<u8>>,
    }
}

impl From<CoreOutboxEntry> for OutboxEntry {
    fn from(entry: CoreOutboxEntry) -> Self {
        Self {
            id: entry.id,
            kind: match entry.kind {
                CoreOutboxKind::RoomFounding => OutboxKind::RoomFounding,
                CoreOutboxKind::GroupFounding => OutboxKind::GroupFounding,
                CoreOutboxKind::Commit => OutboxKind::Commit,
                CoreOutboxKind::ExternalCommit => OutboxKind::ExternalCommit,
                CoreOutboxKind::Message => OutboxKind::Message,
                CoreOutboxKind::RelayMessage => OutboxKind::RelayMessage,
                CoreOutboxKind::Envelope => OutboxKind::Envelope,
                CoreOutboxKind::KeyPackages => OutboxKind::KeyPackages,
                CoreOutboxKind::SealedKey => OutboxKind::SealedKey,
                CoreOutboxKind::RecoveryCode => OutboxKind::RecoveryCode,
            },
            group: entry.group.map(|group| group.as_bytes().to_vec()),
            epoch: entry.epoch,
            parts: entry.parts,
        }
    }
}

record! {
    /// A device's last envelope in a group that the remover accepted: where its chain ends for everyone.
    pub struct Cut {
        /// The removed device, 32 bytes.
        pub device: Vec<u8>,
        /// The number of its last accepted envelope; 0 if none.
        pub seq: u64,
        /// That envelope's hash, 32 bytes; zeros if none.
        pub hash: Vec<u8>,
    }
}

impl Cut {
    pub(crate) fn to_core(&self) -> Result<CoreCut, CoreError> {
        Ok(CoreCut {
            device: device_id(&self.device)?,
            seq: self.seq,
            hash: hash32(&self.hash)?,
        })
    }
}

impl From<&CoreCut> for Cut {
    fn from(cut: &CoreCut) -> Self {
        Self {
            device: cut.device.as_bytes().to_vec(),
            seq: cut.seq,
            hash: cut.hash.as_bytes().to_vec(),
        }
    }
}

record! {
    /// A device to add in the Commit that cleans a stale session: the agent device that takes a main session
    /// over, or a helper session's new opener.
    pub struct Replacement {
        /// The device, 32 bytes.
        pub device: Vec<u8>,
        /// Its KeyPackage.
        pub key_package: Vec<u8>,
    }
}

record! {
    /// A group joined from a Welcome.
    pub struct Joined {
        /// The group.
        pub group: Vec<u8>,
        /// Its epoch.
        pub epoch: u64,
        /// The device that added this one.
        pub added_by: Vec<u8>,
        /// The leaves that do not belong (the finding of first contact). Not empty: the device holds the group
        /// but hands out no content key of it and opens no message of it until those leaves are removed.
        pub offending: Vec<Vec<u8>>,
    }
}

impl From<core::Joined> for Joined {
    fn from(joined: core::Joined) -> Self {
        Self {
            group: joined.group.as_bytes().to_vec(),
            epoch: joined.epoch,
            added_by: joined.added_by.as_bytes().to_vec(),
            offending: devices(&joined.offending),
        }
    }
}

choice! {
    /// What a log entry holds.
    pub enum LogEntryKind {
        /// A Commit.
        Commit = "commit",
        /// An application message.
        Message = "message",
    }
}

record! {
    /// One entry of the hub's ordered log.
    pub struct LogEntry {
        /// The room's change number of the entry.
        pub change: u64,
        /// The group it belongs to.
        pub group: Vec<u8>,
        /// What it is.
        pub kind: LogEntryKind,
        /// The Commit or the message.
        pub bytes: Vec<u8>,
        /// For a Commit that is a join from outside, the RecoveryAuth stored beside it.
        pub recovery_auth: Option<Vec<u8>>,
    }
}

record! {
    /// What a Commit did.
    pub struct CommitSummary {
        /// The group.
        pub group: Vec<u8>,
        /// The epoch the Commit builds on; the group stands one above it now.
        pub epoch: u64,
        /// The committer.
        pub committer: Vec<u8>,
        /// Whether it is a join from outside.
        pub external: bool,
        /// The devices it adds.
        pub adds: Vec<Vec<u8>>,
        /// The devices it removes.
        pub removes: Vec<Vec<u8>>,
        /// Where each removed device's chain ends.
        pub cuts: Vec<Cut>,
        /// For a room Commit that changes the enrolled agent devices or the recovery keys: the agent devices
        /// after it.
        pub agents: Option<Vec<Vec<u8>>>,
        /// The room epoch its note names; none when the note does not decode.
        pub room_epoch: Option<u64>,
        /// The committer's clock, in milliseconds; none when the note does not decode.
        pub time: Option<u64>,
    }
}

impl From<&CommitFacts> for CommitSummary {
    fn from(facts: &CommitFacts) -> Self {
        Self {
            group: facts.group.as_bytes().to_vec(),
            epoch: facts.epoch,
            committer: facts.committer.as_bytes().to_vec(),
            external: facts.external,
            adds: devices(&facts.adds),
            removes: devices(&facts.removes),
            cuts: facts
                .note
                .iter()
                .flat_map(|note| note.cuts.iter().map(Cut::from))
                .collect(),
            agents: match &facts.context {
                ContextChange::To(GroupKind::Room(room)) => Some(devices(&room.agents)),
                _ => None,
            },
            room_epoch: facts.note.as_ref().map(|note| note.room_epoch),
            time: facts.note.as_ref().map(|note| note.time),
        }
    }
}

choice! {
    /// What an application message was.
    pub enum ReceivedKind {
        /// A key handover for this device: `keys_taken` keys were new to it; `last` says whether it is complete.
        Keys = "keys",
        /// A piece of a stroke in progress: `board`, and the JSON piece in `payload`.
        StrokePiece = "strokePiece",
        /// A step of an agent's turn: `turn`, `number`, `time`, and the JSON step in `payload`.
        WorkTrail = "workTrail",
        /// The room's recovery authentication key, from a human device.
        RecoveryAuth = "recoveryAuth",
        /// A message this device may not take from that sender in that group, or that is for another device.
        Dropped = "dropped",
        /// A message of a newer version: it opened and is not read; the device is to be updated.
        NewerVersion = "newerVersion",
    }
}

record! {
    /// An application message as its receiver takes it.
    pub struct ReceivedMessage {
        /// What it was. The fields below are filled as that kind says, and empty or 0 otherwise.
        pub kind: ReceivedKind,
        /// The sender; none for a dropped message.
        pub from: Option<Vec<u8>>,
        /// How many keys a handover brought that were new.
        pub keys_taken: u32,
        /// Whether a handover is complete.
        pub last: bool,
        /// The board of a stroke piece, 16 bytes.
        pub board: Option<Vec<u8>>,
        /// The turn of a work trail step, 16 bytes.
        pub turn: Option<Vec<u8>>,
        /// The number of a work trail step.
        pub number: u32,
        /// The sender's clock of a work trail step, in milliseconds.
        pub time: u64,
        /// The JSON of a stroke piece or of a work trail step.
        pub payload: Vec<u8>,
    }
}

impl ReceivedMessage {
    fn of(kind: ReceivedKind, from: Option<&DeviceId>) -> Self {
        Self {
            kind,
            from: from.map(|device| device.as_bytes().to_vec()),
            keys_taken: 0,
            last: false,
            board: None,
            turn: None,
            number: 0,
            time: 0,
            payload: Vec::new(),
        }
    }
}

impl From<core::Received> for ReceivedMessage {
    fn from(received: core::Received) -> Self {
        match received {
            core::Received::Keys { from, taken, last } => Self {
                keys_taken: count(taken),
                last,
                ..Self::of(ReceivedKind::Keys, Some(&from))
            },
            core::Received::StrokePiece { from, board, piece } => Self {
                board: Some(board.as_bytes().to_vec()),
                payload: piece,
                ..Self::of(ReceivedKind::StrokePiece, Some(&from))
            },
            core::Received::WorkTrail {
                from,
                turn,
                number,
                time,
                step,
            } => Self {
                turn: Some(turn.as_bytes().to_vec()),
                number,
                time,
                payload: step,
                ..Self::of(ReceivedKind::WorkTrail, Some(&from))
            },
            // The key itself stays inside: it is wiped here, where the core hands it out.
            core::Received::RecoveryAuth { from, .. } => {
                Self::of(ReceivedKind::RecoveryAuth, Some(&from))
            }
            core::Received::Dropped => Self::of(ReceivedKind::Dropped, None),
            core::Received::NewerVersion { from } => {
                Self::of(ReceivedKind::NewerVersion, Some(&from))
            }
        }
    }
}

choice! {
    /// What processing a log entry did.
    pub enum ProcessedKind {
        /// A Commit of another device was merged: `commit` says what it did, `superseded` and `removed` apply.
        Commit = "commit",
        /// The entry is this device's own Commit.
        OwnCommit = "ownCommit",
        /// A Commit of a group this device follows as an observer: `commit` says what it did.
        Observed = "observed",
        /// A Commit of another device took the epoch that a join from outside of this device was built on: the
        /// join and its outbox entry `superseded` are dropped, and the join is built again on a newer GroupInfo.
        /// `commit` says what that Commit did, where this device follows the group.
        JoinSuperseded = "joinSuperseded",
        /// An application message that opened: `message` holds it.
        Message = "message",
        /// Nothing for this device: a group it does not hold, or a message it cannot open.
        Skipped = "skipped",
    }
}

record! {
    /// What processing a log entry did.
    pub struct Processed {
        /// What the entry was for this device.
        pub kind: ProcessedKind,
        /// What a Commit did.
        pub commit: Option<CommitSummary>,
        /// The outbox entry of an own Commit, or of an own join from outside, for the same epoch that was dropped
        /// for this one: that change is to be built again.
        pub superseded: Option<u64>,
        /// Whether the Commit removed this device from the group.
        pub removed: bool,
        /// The application message.
        pub message: Option<ReceivedMessage>,
    }
}

impl Processed {
    fn of(kind: ProcessedKind) -> Self {
        Self {
            kind,
            commit: None,
            superseded: None,
            removed: false,
            message: None,
        }
    }
}

impl From<core::Processed> for Processed {
    fn from(processed: core::Processed) -> Self {
        match processed {
            core::Processed::Commit {
                facts,
                superseded,
                removed,
            } => Self {
                commit: Some(CommitSummary::from(&facts)),
                superseded,
                removed,
                ..Self::of(ProcessedKind::Commit)
            },
            core::Processed::OwnCommit => Self::of(ProcessedKind::OwnCommit),
            core::Processed::Observed(facts) => Self {
                commit: Some(CommitSummary::from(&facts)),
                ..Self::of(ProcessedKind::Observed)
            },
            core::Processed::JoinSuperseded {
                superseded,
                observed,
            } => Self {
                commit: observed.as_ref().map(CommitSummary::from),
                superseded: Some(superseded),
                ..Self::of(ProcessedKind::JoinSuperseded)
            },
            core::Processed::Message(received) => Self {
                message: Some(received.into()),
                ..Self::of(ProcessedKind::Message)
            },
            core::Processed::Skipped => Self::of(ProcessedKind::Skipped),
        }
    }
}

choice! {
    /// What a refusal of `process_log_entry` means for the caller.
    pub enum LogFinding {
        /// The entry came before another it needs: process further and try it again.
        Early = "early",
        /// The entry lies behind what the device already processed: pass it over.
        Duplicate = "duplicate",
        /// The entry does not verify, process or obey the rules: the finding `bad-group`. The device kept its
        /// last good state; the entry is shown and reported to the hub.
        BadGroup = "badGroup",
        /// The device itself failed: its store, its entropy, or a request still pending.
        Local = "local",
    }
}

record! {
    /// A handover this device sent whose recipient is not yet known to read.
    pub struct HandoverSent {
        /// The recipient, 32 bytes.
        pub recipient: Vec<u8>,
        /// The group it went through.
        pub group: Vec<u8>,
    }
}

record! {
    /// What a KeyPackage says, for a caller that picks the ones to add.
    pub struct KeyPackageInfo {
        /// The device it is for, 32 bytes.
        pub device: Vec<u8>,
        /// Whether it is a last-resort KeyPackage.
        pub last_resort: bool,
        /// Its reference, 32 bytes.
        pub reference: Vec<u8>,
        /// The end of its lifetime, in milliseconds.
        pub not_after_ms: u64,
    }
}

impl From<CoreKeyPackageInfo> for KeyPackageInfo {
    fn from(info: CoreKeyPackageInfo) -> Self {
        Self {
            device: info.device.as_bytes().to_vec(),
            last_resort: info.last_resort,
            reference: info.reference.as_bytes().to_vec(),
            not_after_ms: info.not_after_ms,
        }
    }
}

record! {
    /// The hub's sign-in request as the device posts it: the challenge the hub handed out, bound to the room,
    /// the hub's address and this device, and signed.
    pub struct SignedHubAuth {
        /// The encoded `HubAuth`.
        pub auth: Vec<u8>,
        /// The device's signature over it.
        pub signature: Vec<u8>,
    }
}
