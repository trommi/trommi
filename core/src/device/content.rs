//! Stored content on the device (section 9): writing an envelope, receiving one, the state that follows from
//! the envelopes received, and the command gate.
//!
//! **Writing.** [`Device::seal`] signs this device's next envelope in a group and writes it into the outbox in
//! the same batch as the advanced chain: a number is signed once, and a retry sends the stored bytes. What
//! the envelope does to this device's own view (the chain it accepted, an object's state, a register) happens
//! when it comes back from the hub at its place in the hub's order, like every other device's.
//!
//! **Receiving.** [`Device::receive_envelope`] runs the receiver's nine checks and writes the outcome (chain,
//! record of the envelope, object state, registers, cursor) in one batch. The hub's change number orders
//! envelopes among the entries of the log: one above [`Device::cursor`] comes in the hub's order and moves
//! the cursor; one at or below it is read back along its sender's chain, and the chain decides whether it is
//! new. When an envelope is accepted behind later ones of its group, the group's object states and registers
//! are built again in the hub's order.
//!
//! **The hub refused an envelope.** With `voided: true` ([`Device::outbox_voided`]) the number is used: the
//! void record comes back through the chain. Any other refusal took no number at the hub, but this device
//! signed the envelope and never signs another under its number (9.0.1): the entry stays in the outbox and the
//! same bytes are sent again. A device that gives up on it ([`Device::envelope_abandon`]) keeps the number
//! used, and writes into that group again only if the hub holds the abandoned envelope after all.

use super::facts::{
    group_key, take_extra, Facts, Record, Status, SUB_OWN_CHAIN, SUB_OWN_IDS, SUB_PROVISIONAL,
};
use super::Device;
use crate::board;
use crate::board_items::{Board, ItemBody, Unread};
use crate::chain::{
    self, GroupFacts, Head, Mode, Outcome, OwnChain, Provisional, Receipt, Role, Served, Standing,
};
use crate::codec::{self, Decode, Encode, Reader, Writer};
use crate::crypto::{self, SecretBytes};
use crate::envelope::{
    self, AnswerBind, Bind, Body, Envelope, Header, ObjectType, RequestBind, Subject, TakeBackBind,
    Timeline, Urgency, Verdict, VerdictBind,
};
use crate::error::Error;
use crate::ids::{
    base64url_decode, BoardId, DeviceId, FileId, GroupId, Hash32, ObjectId, SessionId,
};
use crate::mls::profile::Cut;
use crate::objects::{self, Decision, GateLog, Object, Opened, OwnRecord};
use crate::registers::{self, OwnIds};
use crate::store::{self, table, Batch, OutboxKind, Storage};
use serde::Deserialize;

/// A device writes `heads` in a group at most this often while it is connected (9.0.7).
pub const HEADS_EVERY_MS: u64 = 10 * 60 * 1000;

const SUB_GATE_LOG: u8 = 0;
const SUB_CANDIDATE: u8 = 1;

/// What a device writes (9.1, 9.2). A payload is the body's JSON as its writer made it; the device adds
/// nothing to it. Header fields that follow from stored state (the version answered, the request's hash and
/// expiry, the card's urgency, the object's owner) are filled in from that state.
#[derive(Debug)]
pub enum Draft {
    /// A Chat message in a session's Chat.
    SessionChat {
        /// The session.
        session: SessionId,
        /// The body.
        payload: SecretBytes,
    },
    /// A Chat message in a card's own Chat.
    CardChat {
        /// The session the card belongs to.
        session: SessionId,
        /// The card.
        card: ObjectId,
        /// The body.
        payload: SecretBytes,
    },
    /// An item of a Scribble Board, in the room group.
    BoardItem {
        /// The board.
        board: BoardId,
        /// The body.
        payload: SecretBytes,
    },
    /// A register value: `value` is JSON text, none deletes the name. The lamport and the register id are
    /// the device's (9.3).
    Register {
        /// The group.
        group: GroupId,
        /// The name.
        name: String,
        /// The value.
        value: Option<SecretBytes>,
    },
    /// The first version of a Note, in the room group.
    NoteFirst {
        /// The body.
        payload: SecretBytes,
    },
    /// A later version of a Note. It follows the version its payload names as `previous_version_hash`.
    NoteVersion {
        /// The Note.
        object_id: ObjectId,
        /// Whether this version closes the Note.
        closed: bool,
        /// The body.
        payload: SecretBytes,
    },
    /// A human's answer to the current version of a card.
    Answer {
        /// The session.
        session: SessionId,
        /// The card.
        object_id: ObjectId,
        /// The keys of the chosen options.
        choices: Vec<String>,
        /// Whether the answer closes the card.
        closes: bool,
        /// The body.
        payload: SecretBytes,
    },
    /// A human takes back the answer in force.
    TakeBack {
        /// The session.
        session: SessionId,
        /// The card.
        object_id: ObjectId,
        /// The body.
        payload: SecretBytes,
    },
    /// A human's verdict on a permission request.
    Verdict {
        /// The session.
        session: SessionId,
        /// The request.
        request_id: ObjectId,
        /// Allow, or deny.
        allow: bool,
        /// The body.
        payload: SecretBytes,
    },
    /// An agent or helper device: the first version of a Decision card or an Info card.
    CardFirst {
        /// The session.
        session: SessionId,
        /// The card's urgency.
        urgency: Urgency,
        /// Whether a push is asked for.
        push: bool,
        /// The body.
        payload: SecretBytes,
    },
    /// An agent or helper device: a later version of a card, which follows the version its payload names as
    /// `previous_version_hash`.
    CardVersion {
        /// The session.
        session: SessionId,
        /// The card.
        object_id: ObjectId,
        /// Whether this version closes the card.
        closed: bool,
        /// The card's urgency.
        urgency: Urgency,
        /// Whether a push is asked for.
        push: bool,
        /// The body.
        payload: SecretBytes,
    },
    /// An agent or helper device: a permission request that a verdict may answer until `expires_at`.
    PermissionRequest {
        /// The session.
        session: SessionId,
        /// The request's urgency.
        urgency: Urgency,
        /// Until when a verdict counts, in ms.
        expires_at: u64,
        /// Whether a push is asked for.
        push: bool,
        /// The body.
        payload: SecretBytes,
    },
    /// An agent or helper device: the first version of an Artifact, which publishes it.
    ArtifactFirst {
        /// The session.
        session: SessionId,
        /// The body.
        payload: SecretBytes,
    },
    /// An agent or helper device: a later version of an Artifact; a closed one revokes it.
    ArtifactVersion {
        /// The session.
        session: SessionId,
        /// The Artifact.
        object_id: ObjectId,
        /// Whether this version closes the Artifact.
        closed: bool,
        /// The body.
        payload: SecretBytes,
    },
}

impl Draft {
    /// The group the item is written into.
    fn group(&self, room: crate::ids::RoomId) -> GroupId {
        match self {
            Self::BoardItem { .. } | Self::NoteFirst { .. } | Self::NoteVersion { .. } => {
                GroupId::room(room)
            }
            Self::Register { group, .. } => *group,
            Self::SessionChat { session, .. }
            | Self::CardChat { session, .. }
            | Self::Answer { session, .. }
            | Self::TakeBack { session, .. }
            | Self::Verdict { session, .. }
            | Self::CardFirst { session, .. }
            | Self::CardVersion { session, .. }
            | Self::PermissionRequest { session, .. }
            | Self::ArtifactFirst { session, .. }
            | Self::ArtifactVersion { session, .. } => GroupId::session(room, *session),
        }
    }

    fn wants_push(&self) -> bool {
        match self {
            Self::CardFirst { push, .. }
            | Self::CardVersion { push, .. }
            | Self::PermissionRequest { push, .. } => *push,
            _ => false,
        }
    }
}

/// What sealing made: the envelope waits in the outbox; its hash and number are final.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sealed {
    /// The outbox entry that holds the envelope.
    pub outbox_id: u64,
    /// Its `envelope_hash`.
    pub envelope_hash: Hash32,
    /// Its number in this device's chain in the group.
    pub seq: u64,
    /// The group.
    pub group: GroupId,
    /// The object it belongs to, for the kinds that have one; of a first version, the new object's id.
    pub object_id: Option<ObjectId>,
    /// The `time` of its header.
    pub time: u64,
}

/// What became of a received envelope (9.0.5, 9.0.6, 9.0.8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnvelopeOutcome {
    /// It passed all nine checks and what it carries was taken.
    Applied,
    /// It took its place in its sender's chain and is not applied; `code` says why (`forbidden`,
    /// `wrong-epoch`, `stale-session`, `epoch-full`, `too-large`; `no-key`, `pruned`, `decrypt-failed`,
    /// `bad-format`, `newer-version`). One whose body alone failed still counts for its object's state.
    Chained,
    /// The hub's void record: chained, never applied; `code` is its void code.
    Void,
    /// Fetched out of order: it may be shown, marked as not yet confirmed, and no command follows from it.
    Provisional,
    /// It consumed nothing; `code` is the check that refused it.
    Refused,
}

/// What the chain said about an envelope that was shown as provisional.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Confirmation {
    /// The chain reached its number with that very envelope and took it.
    Confirmed,
    /// The provisional envelope is dropped from what is shown: `hash-mismatch` when the chain holds another
    /// envelope under its number, else the code its chain refused or voided it with.
    Dropped(Error),
}

/// A register value that was taken.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegisterChange {
    /// The name.
    pub name: String,
    /// The sender, for a name of which each device holds its own value.
    pub of: Option<DeviceId>,
    /// Whether this value is now the current one of the name (9.3.2).
    pub current: bool,
}

/// A received envelope and what became of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceivedEnvelope {
    /// The hub's change number it came under.
    pub change: u64,
    /// Its `envelope_hash`.
    pub envelope_hash: Hash32,
    /// Its header.
    pub header: Header,
    /// What became of it.
    pub outcome: EnvelopeOutcome,
    /// Why it is not applied.
    pub code: Option<Error>,
    /// A finding to show beside it: `hub-voided-other`.
    pub finding: Option<Error>,
    /// Its opened body: the bind and the JSON payload. None when it did not open.
    pub body: Option<Body>,
    /// The object after this envelope, by the replay of headers (9.2.1); none for items and registers, and
    /// for an envelope that changed no object.
    pub object_after: Option<(ObjectId, Object)>,
    /// For a register whose value was taken: its name and whether it is now the current one.
    pub register: Option<RegisterChange>,
    /// For an envelope that came through its chain and had been shown as provisional before.
    pub provisional: Option<Confirmation>,
    /// The envelope was accepted behind later ones of its group, and the group's object states and registers
    /// were built again in the hub's order: what was read from them before is to be read again.
    pub replayed: bool,
    /// On an agent or helper device: the envelope is addressed to this device and is of a kind the command
    /// gate knows. [`Device::command`] decides whether to act on it.
    pub command: bool,
}

impl ReceivedEnvelope {
    fn of(change: u64, envelope_hash: Hash32, header: Header, outcome: EnvelopeOutcome) -> Self {
        Self {
            change,
            envelope_hash,
            header,
            outcome,
            code: None,
            finding: None,
            body: None,
            object_after: None,
            register: None,
            provisional: None,
            replayed: false,
            command: false,
        }
    }
}

/// One item of a Scribble Board as [`board_reduce`] takes it: the sender and number of its signed header, and
/// its body.
#[derive(Debug)]
pub struct BoardItem {
    /// The sender of the item's envelope.
    pub sender: DeviceId,
    /// The envelope's number in the sender's chain in the room group.
    pub seq: u64,
    /// The item's body.
    pub payload: SecretBytes,
}

/// A snapshot file with the frontier its register names (10.2). The file may hold the keys of files: it is
/// not printed.
#[derive(Clone, Copy)]
pub struct BoardSnapshot<'a> {
    /// The file's JSON, decompressed. It may hold file keys.
    pub file: &'a [u8],
    /// The frontier of the register `board_snapshot/<board>`, ascending by writer.
    pub frontier: &'a [(DeviceId, Head)],
}

impl std::fmt::Debug for BoardSnapshot<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "BoardSnapshot({} bytes, <redacted>)", self.file.len())
    }
}

/// The Scribble Board's merge (10.7), without state: the board that `items` make of `snapshot`, written as
/// the snapshot file's JSON for `frontier` (10.8).
///
/// `snapshot` is a snapshot file (decompressed) with the frontier its register names; none starts from an
/// empty board. `items` are board items that passed the receiver's checks, in any order: each writer's are
/// applied in the order of its chain, and those the snapshot covers are skipped. `frontier` names per writer
/// the last envelope the caller accepted in the room group. An item whose body is of a newer version is
/// skipped, and the result is then `newer-version`: such a board writes no snapshot (10.5).
pub fn board_reduce(
    snapshot: Option<&BoardSnapshot<'_>>,
    items: &[BoardItem],
    frontier: &[(DeviceId, Head)],
) -> Result<SecretBytes, Error> {
    let mut board = match snapshot {
        Some(snapshot) => Board::from_snapshot(snapshot.file, snapshot.frontier)?,
        None => Board::new(),
    };
    let mut ordered: Vec<&BoardItem> = items.iter().collect();
    ordered.sort_by_key(|item| (item.sender, item.seq));
    for item in ordered {
        match ItemBody::decode(item.payload.expose()) {
            Ok(body) => {
                board.apply(item.sender, item.seq, body)?;
            }
            Err(Error::NewerVersion) => board.skip_unread(item.sender, item.seq, Unread::Newer),
            Err(error) => return Err(error),
        }
    }
    board.snapshot(frontier)
}

/// The field of a version's payload that names the version before it.
#[derive(Deserialize)]
struct Previous {
    previous_version_hash: String,
}

fn previous_of(payload: &[u8]) -> Result<Hash32, Error> {
    let named: Previous = serde_json::from_slice(payload).map_err(|_| Error::BadFormat)?;
    Hash32::from_slice(&base64url_decode(&named.previous_version_hash)?)
}

/// The field of a Note version's payload that counts with the lamports of the group's registers.
#[derive(Deserialize)]
struct Lamport {
    lamport: u64,
}

/// What a record keeps of an opened body for later steps.
fn extra_of(header: &Header, body: &Body, keeps_cards: bool) -> Vec<u8> {
    match (&header.subject, body.bind()) {
        (Subject::Register(_), _) => body.payload().to_vec(),
        (Subject::Version(fields), _) if fields.object_type == ObjectType::Note => {
            serde_json::from_slice::<Lamport>(body.payload())
                .map(|note| note.lamport.to_be_bytes().to_vec())
                .unwrap_or_default()
        }
        (Subject::Version(fields), _) if keeps_cards && fields.object_type == ObjectType::Card => {
            body.payload().to_vec()
        }
        (Subject::Request(_), Bind::Request(bind)) => bind.expires_at.to_be_bytes().to_vec(),
        _ => Vec::new(),
    }
}

/// An envelope the command gate has to decide on, with the state of its object just before it.
struct Candidate {
    state: Asked,
    before: Option<Object>,
    envelope: Vec<u8>,
}

/// What the gate said about a candidate so far.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Asked {
    /// It was not asked yet.
    No = 0,
    /// It refused.
    Refused = 1,
    /// It let the command through, and the command was recorded as started.
    Started = 2,
    /// The command's effect is complete.
    Finished = 3,
}

impl Encode for Candidate {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.u8(self.state as u8);
        writer.u8(u8::from(self.before.is_some()));
        if let Some(before) = &self.before {
            writer.value(before)?;
        }
        writer.opaque(&self.envelope)
    }
}

impl Decode for Candidate {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        let flag = |byte| match byte {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(Error::BadFormat),
        };
        let state = match reader.u8()? {
            0 => Asked::No,
            1 => Asked::Refused,
            2 => Asked::Started,
            3 => Asked::Finished,
            _ => return Err(Error::BadFormat),
        };
        let before = if flag(reader.u8()?)? {
            Some(reader.value()?)
        } else {
            None
        };
        Ok(Self {
            state,
            before,
            envelope: reader.opaque()?.to_vec(),
        })
    }
}

fn damaged(what: &'static str) -> Error {
    Error::Storage(format!("{what} does not decode"))
}

fn candidate_key(hash: &Hash32) -> Vec<u8> {
    store::key(table::COMMAND, &[&[SUB_CANDIDATE], hash.as_bytes()])
}

fn gate_log_key() -> Vec<u8> {
    store::key(table::COMMAND, &[&[SUB_GATE_LOG]])
}

/// Checks one stored entry of the table of commands when the device is opened.
pub(super) fn check_command(rest: &[u8], value: &[u8]) -> Result<(), Error> {
    match rest.first() {
        Some(&SUB_GATE_LOG) => GateLog::from_bytes(value).map(|_| ()),
        Some(&SUB_CANDIDATE) => codec::decode::<Candidate>(value, value.len())
            .and_then(|candidate| Envelope::decode(&candidate.envelope))
            .map(|_| ()),
        _ => Err(Error::BadFormat),
    }
}

fn read_frontier(stored: &[u8]) -> Result<Vec<(DeviceId, Head)>, Error> {
    let mut reader = Reader::new(stored);
    let mut frontier = Vec::new();
    while !reader.is_empty() {
        frontier.push((reader.value()?, reader.value()?));
    }
    Ok(frontier)
}

/// Checks one stored entry of the table of boards when the device is opened.
pub(super) fn check_board(value: &[u8]) -> Result<(), Error> {
    read_frontier(value).map(|_| ())
}

fn provisional_key(group: &GroupId, sender: &DeviceId, seq: u64) -> Vec<u8> {
    group_key(
        table::CHAIN,
        SUB_PROVISIONAL,
        group,
        &[&sender.as_bytes()[..], &seq.to_be_bytes()].concat(),
    )
}

fn is_fault(error: &Error) -> bool {
    matches!(
        error,
        Error::Storage(_) | Error::Internal(_) | Error::Entropy
    )
}

impl<S: Storage> Device<S> {
    fn own_chain(&self, group: &GroupId) -> Result<OwnChain, Error> {
        // The chain is written when the device begins its first epoch in the group: without it the device
        // cannot tell which numbers it used.
        self.stored(&group_key(table::CHAIN, SUB_OWN_CHAIN, group, &[]))
            .map_or(Err(damaged("the own chain")), OwnChain::from_bytes)
    }

    fn own_ids(&self, group: &GroupId) -> Result<OwnIds, Error> {
        self.stored(&group_key(table::REGISTER, SUB_OWN_IDS, group, &[]))
            .map_or(Ok(OwnIds::new()), OwnIds::from_bytes)
    }

    // ---- writing ----

    /// Seals one item as this device's next envelope in its group, in the group's current epoch, and puts
    /// it in the outbox. The advanced chain, a new register id and the outbox entry are one write (9.0.1,
    /// 13.2): the number is used for good, and after a crash the same bytes are sent again.
    ///
    /// `recipient`: none lets the device address the item as 9.2 asks (a human's Chat message to the
    /// session's agent device or opener; an answer, take back or verdict to the object's owner; nobody
    /// otherwise). `file_ids` are the files the payload refers to.
    ///
    /// Refused before anything is signed, and without using a number: what the hub would refuse
    /// (`not-member`, `removed-sender`, `stale-session`, `epoch-full`, `forbidden` against the object state
    /// this device holds, `no-key`), `busy` while a Commit of this device in the group or its founding waits
    /// for the hub's answer, `gone` in an archived session, `bad-group` in a group that failed its first contact,
    /// `not-found` for an object or request this device does not know, `bad-format` and `too-large` for a
    /// payload no envelope may carry.
    pub fn seal(
        &mut self,
        draft: &Draft,
        recipient: Option<&DeviceId>,
        file_ids: &[FileId],
        now_ms: u64,
    ) -> Result<Sealed, Error> {
        self.transact(|this, batch| {
            this.begin(now_ms);
            let room = this.memory.record.room.ok_or(Error::NoRoom)?;
            let group = draft.group(room);
            let meta = this
                .memory
                .groups
                .get(&group)
                .filter(|meta| !meta.removed)
                .ok_or(Error::NotMember)?;
            if meta.archived {
                return Err(Error::Gone);
            }
            // An own Commit that the hub accepted is merged where the log shows it. Until then the group
            // stands in the old epoch here, and what is sealed is sealed under it: the hub and the readers
            // take an envelope of an epoch that just ended (9.0.5), so writing goes on meanwhile.
            let unanswered = meta
                .pending
                .as_ref()
                .is_some_and(|pending| !pending.accepted);
            if meta.founding || unanswered {
                return Err(Error::Busy);
            }
            if meta.distrusted {
                return Err(Error::BadGroup);
            }
            let epoch = Facts(this)
                .processed_epoch(&group)?
                .ok_or(Error::GroupBehind)?;
            let role = Facts(this)
                .leaf_role(&group, epoch, &this.id)?
                .ok_or(Error::NotMember)?;
            let chains = this.chains(&group)?;
            let objects = this.object_states(&group)?;
            let mut own = this.own_chain(&group)?;
            // The own chain never stands behind what this device accepted of itself or still has to send.
            let queued = this
                .memory
                .outbox
                .values()
                .filter(|entry| entry.kind == OutboxKind::Envelope && entry.group == Some(group))
                .filter_map(|entry| Envelope::decode(entry.parts.first()?).ok())
                .map(|envelope| envelope.header.seq)
                .max()
                .unwrap_or(0);
            if own.head().seq < chains.head(&this.id).seq.max(queued) {
                return Err(damaged("the own chain"));
            }
            let mut own_ids = None;
            let mut heads = None;
            let inner = match draft {
                Draft::Register { name, value, .. } => {
                    if !registers::may_write(name, group.is_room(), role, &this.id) {
                        return Err(Error::Forbidden);
                    }
                    let value = value
                        .as_ref()
                        .map(|value| std::str::from_utf8(value.expose()))
                        .transpose()
                        .map_err(|_| Error::BadFormat)?;
                    let known = this.registers(&group)?;
                    let mut ids = this.own_ids(&group)?;
                    let inner = this.provider.with_entropy(|entropy| {
                        registers::write(&known, &mut ids, name, value, entropy)
                    })?;
                    own_ids = Some(ids);
                    if name == registers::HEADS {
                        heads = Some(crypto::sha256(value.unwrap_or_default().as_bytes())?);
                    }
                    inner
                }
                other => this.place(other, &group, epoch, role, &objects, recipient)?,
            };
            let inner = if draft.wants_push() {
                inner.with_push()
            } else {
                inner
            }
            .with_files(file_ids.to_vec());
            let outgoing = this.provider.with_entropy(|entropy| {
                chain::seal_next(
                    &Facts(this),
                    &chains,
                    &objects,
                    &mut own,
                    &inner,
                    group,
                    &this.key,
                    now_ms,
                    entropy,
                )
            })?;
            let header = &outgoing.envelope.header;
            let sealed = Sealed {
                outbox_id: 0,
                envelope_hash: outgoing.hash,
                seq: header.seq,
                group,
                object_id: header.subject.object().map(|fields| fields.object_id),
                time: header.time,
            };
            this.put_stored(
                batch,
                group_key(table::CHAIN, SUB_OWN_CHAIN, &group, &[]),
                own.to_bytes()?,
            );
            if let Some(ids) = own_ids {
                this.put_stored(
                    batch,
                    group_key(table::REGISTER, SUB_OWN_IDS, &group, &[]),
                    ids.to_bytes()?,
                );
            }
            if let Some(hash) = heads {
                let mut state = this.group_state(&group)?;
                state.heads_at = now_ms;
                state.heads_hash = hash;
                this.put_group_state(batch, &group, &state)?;
            }
            let outbox_id = this.enqueue(
                batch,
                OutboxKind::Envelope,
                Some(group),
                epoch,
                vec![outgoing.envelope.encode()?],
            )?;
            Ok(Sealed {
                outbox_id,
                ..sealed
            })
        })
    }

    /// The envelope draft for everything but a register, with what the stored state says about its object.
    fn place(
        &self,
        draft: &Draft,
        group: &GroupId,
        epoch: u64,
        role: Role,
        objects: &objects::Objects,
        recipient: Option<&DeviceId>,
    ) -> Result<envelope::Draft, Error> {
        let facts = Facts(self);
        let known = |object_id: &ObjectId| objects.get(object_id).ok_or(Error::NotFound);
        // A human's Chat message goes to the session's agent device, in a helper session to its opener.
        let chat_to = || -> Result<DeviceId, Error> {
            Ok(match recipient {
                Some(recipient) => *recipient,
                None if role == Role::Human => facts.seat(group, epoch)?.unwrap_or(DeviceId::ZERO),
                None => DeviceId::ZERO,
            })
        };
        let owner_of = |object: &Object| -> Result<DeviceId, Error> {
            match recipient {
                Some(recipient) => Ok(*recipient),
                None => objects::owner(&facts, group, epoch, object)?.ok_or(Error::Forbidden),
            }
        };
        let urgency_of = |object: &Object| -> Result<Urgency, Error> {
            Ok(self
                .record_by_hash(group, &object.current)?
                .and_then(|record| record.header.subject.object().map(|fields| fields.urgency))
                .unwrap_or(Urgency::Normal))
        };
        Ok(match draft {
            Draft::SessionChat { session, payload } => {
                envelope::Draft::session_chat(*session, chat_to()?, payload.expose())
            }
            Draft::CardChat { card, payload, .. } => {
                envelope::Draft::card_chat(*card, chat_to()?, payload.expose())
            }
            Draft::BoardItem { board, payload } => {
                envelope::Draft::board_item(*board, payload.expose())
            }
            Draft::NoteFirst { payload } => {
                envelope::Draft::first_version(ObjectType::Note, Urgency::Normal, payload.expose())?
            }
            Draft::NoteVersion {
                object_id,
                closed,
                payload,
            } => envelope::Draft::later_version(
                *object_id,
                ObjectType::Note,
                *closed,
                Urgency::Normal,
                previous_of(payload.expose())?,
                payload.expose(),
            )?,
            Draft::Answer {
                object_id,
                choices,
                closes,
                payload,
                ..
            } => {
                let card = known(object_id)?;
                let bind = AnswerBind {
                    object_id: *object_id,
                    version_hash: card.current,
                    choices: choices
                        .iter()
                        .map(|choice| choice.as_bytes().to_vec())
                        .collect(),
                };
                envelope::Draft::answer(
                    bind,
                    *closes,
                    urgency_of(card)?,
                    owner_of(card)?,
                    payload.expose(),
                )
            }
            Draft::TakeBack {
                object_id, payload, ..
            } => {
                let card = known(object_id)?;
                let bind = TakeBackBind {
                    object_id: *object_id,
                    previous_hash: card.answer.ok_or(Error::Forbidden)?,
                    version_hash: card.current,
                };
                envelope::Draft::take_back(
                    bind,
                    urgency_of(card)?,
                    owner_of(card)?,
                    payload.expose(),
                )
            }
            Draft::Verdict {
                request_id,
                allow,
                payload,
                ..
            } => {
                let request = known(request_id)?;
                // The request's own expiry, from its body as this device opened it.
                let expires_at = self
                    .record_by_hash(group, &request.current)?
                    .and_then(|record| <[u8; 8]>::try_from(record.extra.as_slice()).ok())
                    .map(u64::from_be_bytes)
                    .ok_or(Error::NotFound)?;
                let bind = VerdictBind {
                    request_id: *request_id,
                    request_hash: request.current,
                    expires_at,
                    verdict: if *allow {
                        Verdict::Allow
                    } else {
                        Verdict::Deny
                    },
                };
                envelope::Draft::verdict(
                    bind,
                    urgency_of(request)?,
                    owner_of(request)?,
                    payload.expose(),
                )
            }
            Draft::CardFirst {
                urgency, payload, ..
            } => envelope::Draft::first_version(ObjectType::Card, *urgency, payload.expose())?,
            Draft::CardVersion {
                object_id,
                closed,
                urgency,
                payload,
                ..
            } => envelope::Draft::later_version(
                *object_id,
                ObjectType::Card,
                *closed,
                *urgency,
                previous_of(payload.expose())?,
                payload.expose(),
            )?,
            Draft::PermissionRequest {
                urgency,
                expires_at,
                payload,
                ..
            } => envelope::Draft::request(*urgency, *expires_at, payload.expose()),
            Draft::ArtifactFirst { payload, .. } => envelope::Draft::first_version(
                ObjectType::Artifact,
                Urgency::Normal,
                payload.expose(),
            )?,
            Draft::ArtifactVersion {
                object_id,
                closed,
                payload,
                ..
            } => envelope::Draft::later_version(
                *object_id,
                ObjectType::Artifact,
                *closed,
                Urgency::Normal,
                previous_of(payload.expose())?,
                payload.expose(),
            )?,
            Draft::Register { .. } => return Err(Error::Internal("a register draft")),
        })
    }

    /// The hub refused the envelope of the outbox entry `id` with `voided: true` (9.0.8): it keeps the
    /// envelope's number as a void record. The entry goes; the number stays used, and the void record takes
    /// its place in this device's view of its own chain when it comes back from the hub.
    pub fn outbox_voided(&mut self, id: u64) -> Result<(), Error> {
        self.drop_envelope(id)
    }

    /// Gives up on the envelope of the outbox entry `id`, which the hub refused without taking its number.
    /// The number stays used: this device signed the envelope and signs no other under it (9.0.1). Its next
    /// envelope in that group names the abandoned one as `prev`, so the hub takes it only if it holds the
    /// abandoned one after all. This is for a device that is out of the group (`not-member`,
    /// `removed-sender`): there is nothing more for it to write there.
    pub fn envelope_abandon(&mut self, id: u64) -> Result<(), Error> {
        self.drop_envelope(id)
    }

    fn drop_envelope(&mut self, id: u64) -> Result<(), Error> {
        self.transact(|this, batch| {
            let envelope = this
                .memory
                .outbox
                .get(&id)
                .is_some_and(|entry| entry.kind == OutboxKind::Envelope);
            if !envelope {
                return Err(Error::NotFound);
            }
            this.drop_outbox(batch, id);
            Ok(())
        })
    }

    /// The value of the register `heads` to write in `group` now (9.0.7), as JSON; none when nothing is
    /// due. It is due when a head changed since the value this device last wrote there, and this is the
    /// first call for the group since the device was opened (it came online) or the last one was written at
    /// least [`HEADS_EVERY_MS`] ago. The caller seals it as [`Draft::Register`] under the name `heads`,
    /// which records the writing.
    pub fn heads_due(&mut self, group: &GroupId, now_ms: u64) -> Result<Option<Vec<u8>>, Error> {
        self.owner()?;
        let chains = self.chains(group)?;
        let came_online = self.memory.wire.heads_asked.insert(*group);
        if chains.heads().is_empty() {
            return Ok(None);
        }
        let value = chain::heads_value(&chains)?;
        let state = self.group_state(group)?;
        let changed = crypto::sha256(value.as_bytes())? != state.heads_hash;
        let waited = now_ms.saturating_sub(state.heads_at) >= HEADS_EVERY_MS;
        Ok((changed && (came_online || waited)).then(|| value.into_bytes()))
    }

    /// The Cut of `device` in `group` for a Commit that removes it (9.0.10): the last envelope of that device
    /// this device accepted there, number 0 and zeros if none. A provisional envelope moves no Cut.
    pub fn cut_of(&self, group: &GroupId, device: &DeviceId) -> Result<Cut, Error> {
        let head = self.chain_head(group, device)?;
        Ok(Cut {
            device: *device,
            seq: head.seq,
            hash: head.hash,
        })
    }

    // ---- reading ----

    /// The last envelope of `sender` this device accepted in `group`; [`Head::START`] if none.
    pub fn chain_head(&self, group: &GroupId, sender: &DeviceId) -> Result<Head, Error> {
        self.owner()?;
        Ok(self.chains(group)?.head(sender))
    }

    /// The Cut that ended the chain of `device` in `group`, once this device processed the Commit that
    /// removed it. Whatever was shown of that device beyond it is dropped (9.0.10).
    pub fn chain_cut(&self, group: &GroupId, device: &DeviceId) -> Result<Option<Head>, Error> {
        self.owner()?;
        self.cut(group, device)
    }

    /// The state of the object `object_id` of `group`, as the envelopes accepted so far leave it (9.2.1).
    pub fn object(&self, group: &GroupId, object_id: &ObjectId) -> Result<Option<Object>, Error> {
        self.owner()?;
        Ok(self.object_states(group)?.get(object_id).cloned())
    }

    /// Every object of `group` with its state, ascending by id.
    pub fn objects(&self, group: &GroupId) -> Result<Vec<(ObjectId, Object)>, Error> {
        self.owner()?;
        Ok(self
            .object_states(group)?
            .iter()
            .map(|(id, object)| (*id, object.clone()))
            .collect())
    }

    /// The device that owns `object_id` now (9.2): the writer of its newest version while it is a leaf, then
    /// the session's agent device or opener.
    pub fn object_owner(
        &self,
        group: &GroupId,
        object_id: &ObjectId,
    ) -> Result<Option<DeviceId>, Error> {
        self.owner()?;
        let facts = Facts(self);
        let Some(epoch) = facts.processed_epoch(group)? else {
            return Ok(None);
        };
        match self.object_states(group)?.get(object_id) {
            Some(object) => objects::owner(&facts, group, epoch, object),
            None => Ok(None),
        }
    }

    /// The current value of the shared register `name` in `group` (9.3.2), as JSON text; none if it was never
    /// written or is deleted.
    pub fn register(&self, group: &GroupId, name: &str) -> Result<Option<SecretBytes>, Error> {
        self.owner()?;
        Ok(self
            .registers(group)?
            .get(name)
            .map(|value| SecretBytes::new(value.as_bytes().to_vec())))
    }

    /// The current value that `sender` wrote under a name each device writes for itself (`heads`,
    /// `device/<id>`).
    pub fn register_of(
        &self,
        group: &GroupId,
        name: &str,
        sender: &DeviceId,
    ) -> Result<Option<SecretBytes>, Error> {
        self.owner()?;
        Ok(self
            .registers(group)?
            .get_of(name, sender)
            .map(|value| SecretBytes::new(value.as_bytes().to_vec())))
    }

    /// Compares the `heads` that `writer` wrote in `group` with this device's own chains there (9.0.7): per
    /// named sender whether this device holds the named envelope, holds less (it fetches that sender's chain;
    /// if the hub has nothing, [`chain::HeadStanding::after_fetch`] is the finding `withheld`), or holds
    /// another envelope under the number (`equivocation`).
    pub fn compare_heads(
        &self,
        group: &GroupId,
        writer: &DeviceId,
    ) -> Result<Vec<(DeviceId, chain::HeadStanding)>, Error> {
        self.owner()?;
        let registers = self.registers(group)?;
        let Some(value) = registers.get_of(registers::HEADS, writer) else {
            return Ok(Vec::new());
        };
        let named = chain::parse_heads(value)?;
        chain::compare_heads(&Facts(self), &self.chains(group)?, group, &named)
    }

    // ---- the Scribble Board ----

    /// The frontier of the snapshot this device last loaded for `board`.
    fn board_frontier(&self, board: &BoardId) -> Result<Vec<(DeviceId, Head)>, Error> {
        let Some(stored) = self.stored(&store::key(table::BOARD, &[board.as_bytes()])) else {
            return Ok(Vec::new());
        };
        read_frontier(stored).map_err(|_| damaged("a board's frontier"))
    }

    /// Loads `board` by the rule of 10.3, from what this device holds: the newest snapshot (the current
    /// value of `board_snapshot/<board>`), the Cuts of the room group, and every writer's chain after the
    /// snapshot's frontier as this device accepted it. `served` are the board's items the hub gave from
    /// [`board::Snapshot::items_after_change`] on. The device has read the writers' chains up to their heads
    /// before (9.0.6, 9.0.7).
    ///
    /// On success the snapshot's frontier is the one applied from now on, and the result says which served
    /// items the snapshot covers and which are to be added to it ([`board_reduce`]). The refusals are those
    /// of [`board::verify_load`]: `withheld`, `hash-mismatch`, `equivocation`, `replay`, `removed-sender`,
    /// `gap`, `chain-break`, `forbidden`; `not-found` without a snapshot.
    pub fn board_load(
        &mut self,
        board: &BoardId,
        served: &[board::ServedItem],
    ) -> Result<board::Loaded, Error> {
        self.transact(|this, batch| {
            this.begin(0);
            let room = GroupId::room(this.memory.record.room.ok_or(Error::NoRoom)?);
            let registers = this.registers(&room)?;
            let value = registers
                .get(&board::snapshot_name(board))
                .ok_or(Error::NotFound)?;
            let snapshot = board::Snapshot::parse(value)?;
            let applied = this.board_frontier(board)?;
            let chains_held = this.chains(&room)?;
            // The snapshot's frontier is held against the chains this device verified itself: it has read
            // each writer's chain that far (`withheld` otherwise), and holds the very envelope the frontier
            // names (`equivocation`).
            for (writer, named) in &snapshot.frontier {
                let held = chains_held.head(writer);
                // Of a writer this device holds nothing of, the frontier is the one shortcut of 9.0.6.
                if held.seq == 0 {
                    continue;
                }
                if held.seq < named.seq {
                    return Err(Error::Withheld);
                }
                let at_frontier = if held.seq == named.seq {
                    held.hash
                } else {
                    this.record(&room, writer, named.seq)?
                        .ok_or_else(|| damaged("a chain record"))?
                        .hash
                };
                if at_frontier != named.hash {
                    return Err(Error::Equivocation);
                }
            }
            let heads = chains_held.heads();
            let mut cuts = Vec::new();
            let mut chains = Vec::new();
            for (writer, head) in &heads {
                if let Some(cut) = this.cut(&room, writer)? {
                    cuts.push((*writer, cut));
                }
                let mut links = Vec::new();
                // A writer's chain starts after what this device applied of it, taken back to its Cut;
                // for a writer it applied nothing of, after the snapshot's frontier.
                let cut = cuts
                    .iter()
                    .find(|(of, _)| of == writer)
                    .map(|(_, cut)| cut.seq);
                let mut seq = applied
                    .iter()
                    .find(|(of, _)| of == writer)
                    .map_or(snapshot.frontier_of(writer).seq, |(_, held)| {
                        held.seq.min(cut.unwrap_or(u64::MAX))
                    });
                while seq < head.seq {
                    seq = seq.saturating_add(1);
                    let record = this
                        .record(&room, writer, seq)?
                        .ok_or(Error::Internal("an accepted envelope without its record"))?;
                    let counts = record.status == Status::Taken;
                    links.push(board::Link {
                        seq,
                        prev: record.header.prev,
                        hash: record.hash,
                        board: match record.header.subject {
                            Subject::Item(Timeline::Board(of)) if counts => Some(of),
                            _ => None,
                        },
                    });
                }
                chains.push((*writer, links));
            }
            for (writer, _) in snapshot.frontier.iter().chain(&applied) {
                if !cuts.iter().any(|(cut, _)| cut == writer) {
                    if let Some(cut) = this.cut(&room, writer)? {
                        cuts.push((*writer, cut));
                    }
                }
            }
            let loaded = board::verify_load(board, &applied, &cuts, &snapshot, served, &chains)?;
            let mut frontier = Writer::new();
            for (writer, head) in &loaded.frontier {
                frontier.fixed(writer.as_bytes());
                frontier.value(head)?;
            }
            this.put_stored(
                batch,
                store::key(table::BOARD, &[board.as_bytes()]),
                frontier.into_bytes(),
            );
            Ok(loaded)
        })
    }

    // ---- receiving ----

    /// Takes one envelope from the hub (9.0.5, 9.0.6) and writes what follows from it in one batch.
    ///
    /// `ordered`: the envelope comes at its place, by the changes route or the stream, or along its sender's
    /// chain. With `change` above [`Device::cursor`] it is checked against the group state of its place and
    /// moves the cursor to `change`; the caller hands the entries of the log and the envelopes in one order,
    /// by change number (5.4.1). At or below the cursor it is read back, and only the next envelope of its
    /// sender's chain is new (`replay` otherwise). Not `ordered`: the envelope was fetched out of order (a
    /// page of a Chat, an object) and is at most provisional; the chain is not touched.
    ///
    /// `void_code`: the hub served it as a void record with this code.
    ///
    /// The result says what became of it. [`EnvelopeOutcome::Refused`] consumed nothing; with `group-behind`
    /// for a group this device is a leaf of, whose log it has not processed up to the envelope's epoch, the
    /// cursor stays and the caller processes the log first. Every other outcome of an envelope above the
    /// cursor moves the cursor. An envelope of an epoch before this device joined its group is
    /// `group-behind` too, and is passed.
    ///
    /// `Err` is a failure of this device (its store), or bytes that are no envelope at all (`bad-format`,
    /// `too-large`, `newer-version`): nothing changed and the cursor stays.
    pub fn receive_envelope(
        &mut self,
        bytes: &[u8],
        change: u64,
        ordered: bool,
        void_code: Option<&Error>,
        now_ms: u64,
    ) -> Result<ReceivedEnvelope, Error> {
        self.transact(|this, batch| {
            this.begin(now_ms);
            let envelope = Envelope::decode(bytes)?;
            let hash = envelope.hash()?;
            let header = envelope.header;
            let group = header.group;
            if !ordered {
                return this.receive_provisional(batch, bytes, change, hash, header, now_ms);
            }
            let in_order = change > this.memory.record.cursor;
            let mode = if in_order {
                Mode::InOrder
            } else {
                Mode::ReadingBack
            };
            let served = void_code.map_or(Served::Stored, |code| Served::Void(code.clone()));
            // An envelope that comes behind later ones of its group is judged at its own place.
            let objects = if change < this.group_state(&group)?.max_change {
                this.objects_before(&group, change)?
            } else {
                this.object_states(&group)?
            };
            let received = chain::receive(
                &Facts(this),
                &Facts(this),
                &this.chains(&group)?,
                &objects,
                &this.id,
                bytes,
                &served,
                mode,
                now_ms,
            );
            let receipt = match received {
                Ok(receipt) => receipt,
                Err(fault) if is_fault(&fault) => return Err(fault),
                Err(code) => {
                    // The one refusal that the caller mends by processing the log: the group's next
                    // Commits are still to come.
                    let ahead = code == Error::GroupBehind
                        && this.is_leaf_of(&group)
                        && Facts(this)
                            .processed_epoch(&group)?
                            .is_some_and(|stands| header.epoch > stands);
                    if in_order && !ahead {
                        this.advance(batch, change)?;
                    }
                    let mut refused =
                        ReceivedEnvelope::of(change, hash, header, EnvelopeOutcome::Refused);
                    refused.code = Some(code);
                    return Ok(refused);
                }
            };
            let received = this.take_receipt(batch, receipt, change, bytes)?;
            if in_order {
                this.advance(batch, change)?;
            }
            Ok(received)
        })
    }

    /// Writes what an envelope that took its place in its chain leaves behind.
    fn take_receipt(
        &mut self,
        batch: &mut Batch,
        receipt: Receipt,
        change: u64,
        bytes: &[u8],
    ) -> Result<ReceivedEnvelope, Error> {
        let Receipt {
            envelope,
            hash,
            advance,
            outcome,
        } = receipt;
        let header = envelope.header;
        let group = header.group;
        let mut chains = self.chains(&group)?;
        chains.apply(&advance)?;
        self.put_chains(batch, &group, &chains)?;
        let mut state = self.group_state(&group)?;
        let behind = change < state.max_change;
        state.max_change = state.max_change.max(change);
        self.put_group_state(batch, &group, &state)?;

        let mut received =
            ReceivedEnvelope::of(change, hash, header.clone(), EnvelopeOutcome::Chained);
        let mut record = Record {
            change,
            hash,
            status: Status::Taken,
            fresh: matches!(outcome, Outcome::Taken { .. })
                || Facts(self).processed_epoch(&group)? == Some(header.epoch),
            code: None,
            header: header.clone(),
            extra: Vec::new(),
        };
        let mut before = None;
        match outcome {
            Outcome::Taken { transition, body } => {
                if let Some(transition) = transition {
                    // Behind later envelopes the whole state is built again below.
                    if !behind {
                        let mut objects = self.object_states(&group)?;
                        objects.apply(&transition)?;
                        self.put_objects(batch, &group, &objects)?;
                    }
                    received.object_after = Some((transition.object_id, transition.after));
                    before = transition.before;
                }
                match body {
                    Ok(body) => {
                        record.extra = extra_of(&header, &body, !self.is_human());
                        received.outcome = EnvelopeOutcome::Applied;
                        received.body = Some(body);
                    }
                    Err(code) => received.code = Some(code),
                }
            }
            Outcome::Refused(code) => {
                if code != Error::Forbidden {
                    record.status = Status::Refused;
                } else {
                    record.status = Status::Forbidden;
                }
                received.code = Some(code);
            }
            Outcome::Void { code, finding } => {
                record.status = Status::Void;
                received.outcome = EnvelopeOutcome::Void;
                received.code = Some(code);
                received.finding = finding;
            }
            Outcome::Reserved => {
                record.status = Status::Reserved;
                received.code = Some(Error::NewerVersion);
            }
        }
        record.code = received.code.clone();

        // A register's value and a Note version's lamport, for an envelope whose body opened.
        if received.outcome == EnvelopeOutcome::Applied {
            let mut registers = self.registers(&group)?;
            if matches!(header.subject, Subject::Register(_)) {
                let judged = registers.judge(&Facts(self), &header, &record.extra);
                match judged {
                    Ok(update) => {
                        registers.apply(&update)?;
                        received.register = Some(RegisterChange {
                            name: update.name.clone(),
                            of: update.of,
                            current: update.current,
                        });
                    }
                    Err(fault) if is_fault(&fault) => return Err(fault),
                    // The value is not taken; the envelope keeps its place.
                    Err(code) => {
                        received.outcome = EnvelopeOutcome::Chained;
                        record.code = Some(code.clone());
                        received.code = Some(code);
                        record.extra = Vec::new();
                    }
                }
            } else {
                take_extra(&Facts(self), &mut registers, &record)?;
            }
            self.put_registers(batch, &group, &registers)?;
        }
        self.put_envelope_record(batch, &group, &record)?;

        if behind {
            self.replay_group(batch, &group)?;
            received.replayed = true;
            if let Some((object_id, _)) = received.object_after {
                received.object_after = self
                    .object_states(&group)?
                    .get(&object_id)
                    .map(|object| (object_id, object.clone()));
            }
        }

        // An envelope that was shown as provisional is confirmed or dropped here (9.0.6).
        let shown = provisional_key(&group, &header.sender, header.seq);
        if let Some(stored) = self.stored(&shown) {
            let same = stored == hash.as_bytes();
            received.provisional = Some(if !same {
                Confirmation::Dropped(Error::HashMismatch)
            } else if record.status == Status::Taken {
                Confirmation::Confirmed
            } else {
                Confirmation::Dropped(record.code.clone().unwrap_or(Error::Forbidden))
            });
            self.delete_stored(batch, shown);
        }

        // 9.0.9: what an agent or helper device may act on is kept with the state its object had just
        // before, against which the gate judges it.
        let commands = match &header.subject {
            Subject::Item(timeline) => timeline.is_chat(),
            Subject::Answer(_) | Subject::Verdict(_) | Subject::TakeBack(_) => true,
            _ => false,
        };
        if commands
            && !behind
            && received.outcome == EnvelopeOutcome::Applied
            && header.recipient == self.id
            && !self.is_human()
        {
            let candidate = Candidate {
                state: Asked::No,
                before,
                envelope: bytes.to_vec(),
            };
            self.put_stored(batch, candidate_key(&hash), codec::encode(&candidate)?);
            received.command = true;
        }
        Ok(received)
    }

    fn receive_provisional(
        &mut self,
        batch: &mut Batch,
        bytes: &[u8],
        change: u64,
        hash: Hash32,
        header: Header,
        now_ms: u64,
    ) -> Result<ReceivedEnvelope, Error> {
        let group = header.group;
        let checked = chain::provisional(
            &Facts(self),
            &Facts(self),
            &self.chains(&group)?,
            bytes,
            now_ms,
        );
        let mut received = ReceivedEnvelope::of(change, hash, header, EnvelopeOutcome::Refused);
        let Provisional { body, standing, .. } = match checked {
            Ok(provisional) => provisional,
            Err(fault) if is_fault(&fault) => return Err(fault),
            Err(code) => {
                received.code = Some(code);
                return Ok(received);
            }
        };
        let (sender, seq) = (received.header.sender, received.header.seq);
        if standing == Standing::Provisional {
            self.put_stored(
                batch,
                provisional_key(&group, &sender, seq),
                hash.as_bytes().to_vec(),
            );
            received.outcome = EnvelopeOutcome::Provisional;
            received.body = Some(body);
            return Ok(received);
        }
        // The chain holds this very envelope: its record says what became of it there.
        let record = self
            .record(&group, &sender, seq)?
            .ok_or(Error::Internal("a chained envelope without its record"))?;
        let mut record = record;
        if record.status == Status::Taken && record.code.is_some() {
            // It took its place without its body (pruned as served then, or its key came later): the body
            // that opens now is taken, with what it says for the registers and for the gate.
            record.code = None;
            record.extra = extra_of(&received.header, &body, !self.is_human());
            let mut registers = self.registers(&group)?;
            if matches!(received.header.subject, Subject::Register(_)) {
                match registers.judge(&Facts(self), &received.header, &record.extra) {
                    Ok(update) => {
                        registers.apply(&update)?;
                        received.register = Some(RegisterChange {
                            name: update.name.clone(),
                            of: update.of,
                            current: update.current,
                        });
                    }
                    Err(fault) if is_fault(&fault) => return Err(fault),
                    Err(code) => {
                        record.code = Some(code);
                        record.extra = Vec::new();
                    }
                }
            } else {
                take_extra(&Facts(self), &mut registers, &record)?;
            }
            self.put_registers(batch, &group, &registers)?;
            self.put_envelope_record(batch, &group, &record)?;
        }
        if record.status == Status::Taken && record.code.is_none() {
            received.outcome = EnvelopeOutcome::Applied;
            received.body = Some(body);
            if let Some(fields) = received.header.subject.object() {
                received.object_after = self
                    .object_states(&group)?
                    .get(&fields.object_id)
                    .map(|object| (fields.object_id, object.clone()));
            }
        } else {
            received.outcome = if record.status == Status::Void {
                EnvelopeOutcome::Void
            } else {
                EnvelopeOutcome::Chained
            };
            received.code = record.code;
        }
        Ok(received)
    }

    // ---- relayed messages ----

    /// Takes a stroke piece the hub only passed on (7.2): it is in no log and has no change number, so the
    /// cursor stays. `message` is the application message as it was relayed; the group's ratchet state after
    /// it is written. None for a message this device cannot open, or of a group it is no leaf of.
    /// `bad-format`, with nothing consumed, for a message that opens to anything but a stroke piece: every
    /// other message comes through the log, once. `group-behind` for a message of an epoch the device has
    /// not reached.
    pub fn receive_relay(
        &mut self,
        group: &GroupId,
        message: &[u8],
        now_ms: u64,
    ) -> Result<Option<super::Received>, Error> {
        self.transact(|this, batch| {
            this.begin(now_ms);
            if !this.is_leaf_of(group) {
                return Ok(None);
            }
            match this.process_message(batch, group, message)? {
                super::Processed::Message(piece @ super::Received::StrokePiece { .. }) => {
                    Ok(Some(piece))
                }
                super::Processed::Message(_) => Err(Error::BadFormat),
                _ => Ok(None),
            }
        })
    }

    // ---- the command gate ----

    fn gate_log(&self) -> Result<GateLog, Error> {
        self.stored(&gate_log_key())
            .map_or(Ok(GateLog::new()), GateLog::from_bytes)
    }

    /// The command gate (9.0.9), for an agent or helper device: whether to act on the envelope with this
    /// hash. Only an envelope that came through its sender's chain, passed all nine checks and is addressed
    /// to this device can be asked about ([`ReceivedEnvelope::command`]); `not-found` for any other. It is
    /// judged against the state its object had just before it.
    ///
    /// [`Decision::Act`] is answered once per envelope, and only after the command was recorded as started
    /// in the store: the caller acts, then calls [`Device::command_finished`]. Asked again, the answer is
    /// [`Decision::Done`], or [`Decision::Uncertain`] when the command was started and never finished (a
    /// crash in between): its effect is reported to the human, not repeated.
    pub fn command(&mut self, envelope_hash: &Hash32, now_ms: u64) -> Result<Decision, Error> {
        self.transact(|this, batch| {
            this.begin(now_ms);
            if this.is_human() {
                return Err(Error::Forbidden);
            }
            let key = candidate_key(envelope_hash);
            let stored = this.stored(&key).ok_or(Error::NotFound)?;
            let mut candidate: Candidate =
                codec::decode(stored, stored.len()).map_err(|_| damaged("a command record"))?;
            let envelope =
                Envelope::decode(&candidate.envelope).map_err(|_| damaged("a command record"))?;
            if envelope.hash()? != *envelope_hash {
                return Err(damaged("a command record"));
            }
            let header = &envelope.header;
            let group = header.group;
            // The envelope still counts: a Cut or a rebuilt state may have taken it out since.
            let counts = this
                .record_by_hash(&group, envelope_hash)?
                .is_some_and(|record| record.status == Status::Taken);
            if !counts {
                return Err(Error::NotFound);
            }
            let mut log = this.gate_log()?;
            let decision = {
                let facts = Facts(this);
                let content_key = facts
                    .content_key(&group, header.epoch)?
                    .ok_or(Error::NoKey)?;
                let body = envelope.open(&content_key)?;
                // What the answer or verdict refers to, as this device holds it: the card version's body,
                // the request's bind.
                let referred = candidate
                    .before
                    .as_ref()
                    .map(|object| this.record_by_hash(&group, &object.current))
                    .transpose()?
                    .flatten();
                let own = match (&header.subject, &referred) {
                    (Subject::Answer(_), Some(record)) if !record.extra.is_empty() => {
                        OwnRecord::CardVersion {
                            hash: record.hash,
                            payload: &record.extra,
                        }
                    }
                    (Subject::Verdict(_), Some(record)) => {
                        let expires_at = <[u8; 8]>::try_from(record.extra.as_slice()).ok();
                        let request_id = record
                            .header
                            .subject
                            .object()
                            .map(|fields| fields.object_id);
                        match (request_id, expires_at) {
                            (Some(request_id), Some(expires_at)) => OwnRecord::Request {
                                hash: record.hash,
                                bind: RequestBind {
                                    request_id,
                                    expires_at: u64::from_be_bytes(expires_at),
                                },
                            },
                            _ => OwnRecord::None,
                        }
                    }
                    _ => OwnRecord::None,
                };
                let opened = Opened {
                    header,
                    hash: *envelope_hash,
                    body: &body,
                    before: candidate.before.as_ref(),
                };
                objects::command_gate(&facts, &mut log, &this.id, &opened, &own, now_ms)?
            };
            let asked = match &decision {
                // The gate lets a command through once. If its own record says nothing of a command that
                // was let through before, that record is damaged, and nothing is acted on again.
                Decision::Act(_) if candidate.state != Asked::No => {
                    return Err(damaged("the record of started commands"));
                }
                Decision::Act(_) => {
                    this.put_stored(batch, gate_log_key(), log.to_bytes()?);
                    Asked::Started
                }
                Decision::Refused(_) => Asked::Refused,
                Decision::Done | Decision::Uncertain => candidate.state,
            };
            if asked != candidate.state {
                candidate.state = asked;
                this.put_stored(batch, key, codec::encode(&candidate)?);
            }
            Ok(decision)
        })
    }

    /// The effect of the command [`Device::command`] let through is complete. `not-found` for a command the
    /// gate never let through.
    pub fn command_finished(&mut self, envelope_hash: &Hash32) -> Result<(), Error> {
        self.transact(|this, batch| {
            this.begin(0);
            let mut log = this.gate_log()?;
            log.finish(envelope_hash)?;
            this.put_stored(batch, gate_log_key(), log.to_bytes()?);
            let key = candidate_key(envelope_hash);
            if let Some(stored) = this.stored(&key) {
                let mut candidate: Candidate =
                    codec::decode(stored, stored.len()).map_err(|_| damaged("a command record"))?;
                candidate.state = Asked::Finished;
                this.put_stored(batch, key, codec::encode(&candidate)?);
            }
            Ok(())
        })
    }

    /// The state of `group` was built again: what the gate was not yet asked about there is kept only if its
    /// envelope still counts, with the state its object has just before it now.
    pub(super) fn refresh_undecided(
        &mut self,
        batch: &mut Batch,
        group: &GroupId,
    ) -> Result<(), Error> {
        let prefix = store::key(table::COMMAND, &[&[SUB_CANDIDATE]]);
        for (key, value) in self.stored_under(&prefix) {
            let mut candidate: Candidate =
                codec::decode(&value, value.len()).map_err(|_| damaged("a command record"))?;
            let Ok(envelope) = Envelope::decode(&candidate.envelope) else {
                return Err(damaged("a command record"));
            };
            if candidate.state != Asked::No || envelope.header.group != *group {
                continue;
            }
            let record = self
                .record(group, &envelope.header.sender, envelope.header.seq)?
                .filter(|record| record.status == Status::Taken);
            let Some(record) = record else {
                self.delete_stored(batch, key);
                continue;
            };
            let before = match envelope.header.subject.object() {
                Some(fields) => self
                    .objects_before(group, record.change)?
                    .get(&fields.object_id)
                    .cloned(),
                None => None,
            };
            if before != candidate.before {
                candidate.before = before;
                self.put_stored(batch, key, codec::encode(&candidate)?);
            }
        }
        Ok(())
    }

    /// The envelopes [`Device::command`] was not asked about yet, by hash: after a restart, what arrived
    /// and was stored before the caller could decide on it.
    pub fn commands_pending(&self) -> Result<Vec<Hash32>, Error> {
        self.candidates(Asked::No)
    }

    /// The commands the gate let through that were never reported as finished: after a restart, those whose
    /// effect is uncertain. They are reported to the human, not repeated (9.0.9).
    pub fn commands_uncertain(&self) -> Result<Vec<Hash32>, Error> {
        self.candidates(Asked::Started)
    }

    fn candidates(&self, state: Asked) -> Result<Vec<Hash32>, Error> {
        self.owner()?;
        let prefix = store::key(table::COMMAND, &[&[SUB_CANDIDATE]]);
        let mut pending = Vec::new();
        for (key, value) in self.stored_under(&prefix) {
            let candidate: Candidate =
                codec::decode(&value, value.len()).map_err(|_| damaged("a command record"))?;
            if candidate.state == state {
                let hash = key.get(prefix.len()..).unwrap_or_default();
                pending.push(Hash32::from_slice(hash).map_err(|_| damaged("a command record"))?);
            }
        }
        Ok(pending)
    }
}
