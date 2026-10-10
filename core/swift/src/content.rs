//! Stored content at the edge (sections 9 and 10): what a device writes, what became of an envelope it received,
//! the state of objects and registers, the command gate and the loading of a Scribble Board, as plain records.
//!
//! Where the core tells with an enum that carries data, a record here has a `kind` and the fields that kind
//! fills. Nothing here hands out a content key: a body is sealed and opened inside the device, after the checks
//! of its chain.

use crate::error::core_error;
use crate::records::{board_id, device_id, group_id, hash32, session_id, Cut};
use crate::{CoreError, ErrorCode};
use trommi_core::chain::{Head, HeadStanding as CoreStanding};
use trommi_core::crypto::SecretBytes;
use trommi_core::device as core;
use trommi_core::envelope::{self, Bind as CoreBind, Header, Subject, Timeline};
use trommi_core::ids::{DeviceId, FileId, ObjectId};
use trommi_core::objects::{AnswerAction, Command, Decision, Object, Refusal};
use trommi_core::Error;

choice! {
    /// How pressing a card or a permission request is.
    pub enum Urgency {
        /// Low.
        Low = "low",
        /// Normal.
        Normal = "normal",
        /// High.
        High = "high",
        /// Critical.
        Critical = "critical",
    }
}

impl From<envelope::Urgency> for Urgency {
    fn from(urgency: envelope::Urgency) -> Self {
        match urgency {
            envelope::Urgency::Low => Urgency::Low,
            envelope::Urgency::Normal => Urgency::Normal,
            envelope::Urgency::High => Urgency::High,
            envelope::Urgency::Critical => Urgency::Critical,
        }
    }
}

impl From<Urgency> for envelope::Urgency {
    fn from(urgency: Urgency) -> Self {
        match urgency {
            Urgency::Low => envelope::Urgency::Low,
            Urgency::Normal => envelope::Urgency::Normal,
            Urgency::High => envelope::Urgency::High,
            Urgency::Critical => envelope::Urgency::Critical,
        }
    }
}

choice! {
    /// What an object is.
    pub enum ObjectType {
        /// A Decision card or an Info card.
        Card = "card",
        /// A Note.
        Note = "note",
        /// A permission request.
        Request = "request",
        /// An Artifact.
        Artifact = "artifact",
    }
}

impl From<envelope::ObjectType> for ObjectType {
    fn from(object_type: envelope::ObjectType) -> Self {
        match object_type {
            envelope::ObjectType::Card => ObjectType::Card,
            envelope::ObjectType::Note => ObjectType::Note,
            envelope::ObjectType::Request => ObjectType::Request,
            envelope::ObjectType::Artifact => ObjectType::Artifact,
        }
    }
}

choice! {
    /// The state of an object.
    pub enum ObjectState {
        /// Open.
        Open = "open",
        /// Answered.
        Answered = "answered",
        /// Closed.
        Closed = "closed",
    }
}

impl From<envelope::ObjectState> for ObjectState {
    fn from(state: envelope::ObjectState) -> Self {
        match state {
            envelope::ObjectState::Open => ObjectState::Open,
            envelope::ObjectState::Answered => ObjectState::Answered,
            envelope::ObjectState::Closed => ObjectState::Closed,
        }
    }
}

choice! {
    /// What a device writes.
    pub enum DraftKind {
        /// A Chat message in a session's Chat: `session`, `payload`.
        SessionChat = "sessionChat",
        /// A Chat message in a card's own Chat: `session`, `card`, `payload`.
        CardChat = "cardChat",
        /// An item of a Scribble Board, in the room group: `board`, `payload`.
        BoardItem = "boardItem",
        /// A register value: `group`, `name`, `value` (JSON text; none deletes the name).
        Register = "register",
        /// The first version of a Note, in the room group: `payload`.
        NoteFirst = "noteFirst",
        /// A later version of a Note: `object_id`, `closed`, `payload`.
        NoteVersion = "noteVersion",
        /// A human's answer to the current version of a card: `session`, `object_id`, `choices`, `closes`,
        /// `payload`.
        Answer = "answer",
        /// A human takes back the answer in force: `session`, `object_id`, `payload`.
        TakeBack = "takeBack",
        /// A human's verdict on a permission request: `session`, `request_id`, `allow`, `payload`.
        Verdict = "verdict",
        /// An agent or helper device, the first version of a card: `session`, `urgency`, `push`, `payload`.
        CardFirst = "cardFirst",
        /// An agent or helper device, a later version of a card: `session`, `object_id`, `closed`, `urgency`,
        /// `push`, `payload`.
        CardVersion = "cardVersion",
        /// An agent or helper device, a permission request: `session`, `urgency`, `expires_at`, `push`,
        /// `payload`.
        PermissionRequest = "permissionRequest",
        /// An agent or helper device, the first version of an Artifact: `session`, `payload`.
        ArtifactFirst = "artifactFirst",
        /// An agent or helper device, a later version of an Artifact: `session`, `object_id`, `closed`,
        /// `payload`.
        ArtifactVersion = "artifactVersion",
    }
}

record! {
    /// What a device writes: its kind, and the fields that kind names (see [`DraftKind`]); the others are left
    /// out. A payload is the body's JSON as its writer made it; the device adds nothing to it. A field a kind
    /// needs and does not find is `bad-format`.
    secret pub struct Draft {
        /// What is written.
        pub kind: DraftKind,
        /// The session, 16 bytes.
        pub session: Option<Vec<u8>>,
        /// The card whose Chat a message goes to, 16 bytes.
        pub card: Option<Vec<u8>>,
        /// The board, 16 bytes.
        pub board: Option<Vec<u8>>,
        /// The group of a register.
        pub group: Option<Vec<u8>>,
        /// The name of a register.
        pub name: Option<String>,
        /// The value of a register, JSON text; none deletes the name.
        pub value: Option<Vec<u8>>,
        /// The object a version, an answer or a take back belongs to, 16 bytes.
        pub object_id: Option<Vec<u8>>,
        /// The permission request a verdict answers, 16 bytes.
        pub request_id: Option<Vec<u8>>,
        /// The keys of the options an answer chooses.
        pub choices: Option<Vec<String>>,
        /// Whether an answer closes the card.
        pub closes: Option<bool>,
        /// Whether a version closes its object.
        pub closed: Option<bool>,
        /// A verdict: allow, or deny.
        pub allow: Option<bool>,
        /// The urgency of a card or a permission request.
        pub urgency: Option<Urgency>,
        /// Whether a push is asked for.
        pub push: Option<bool>,
        /// Until when a verdict on a permission request counts, in milliseconds.
        pub expires_at: Option<u64>,
        /// The body's JSON.
        pub payload: Option<Vec<u8>>,
    }
}

fn needed<T>(field: Option<T>, name: &str) -> Result<T, CoreError> {
    field.ok_or_else(|| CoreError::bad_format(&format!("the draft lacks `{name}`")))
}

fn object_id(bytes: &[u8]) -> Result<ObjectId, CoreError> {
    Ok(ObjectId::from_slice(bytes)?)
}

impl Draft {
    /// The draft as the core takes it.
    pub(crate) fn into_core(self) -> Result<core::Draft, CoreError> {
        let session = || session_id(&needed(self.session.clone(), "session")?);
        let object = || object_id(&needed(self.object_id.clone(), "objectId")?);
        let payload =
            || Ok::<_, CoreError>(SecretBytes::new(needed(self.payload.clone(), "payload")?));
        let urgency = || Ok::<_, CoreError>(needed(self.urgency, "urgency")?.into());
        let push = || needed(self.push, "push");
        let closed = || needed(self.closed, "closed");
        Ok(match self.kind {
            DraftKind::SessionChat => core::Draft::SessionChat {
                session: session()?,
                payload: payload()?,
            },
            DraftKind::CardChat => core::Draft::CardChat {
                session: session()?,
                card: object_id(&needed(self.card.clone(), "card")?)?,
                payload: payload()?,
            },
            DraftKind::BoardItem => core::Draft::BoardItem {
                board: board_id(&needed(self.board.clone(), "board")?)?,
                payload: payload()?,
            },
            DraftKind::Register => core::Draft::Register {
                group: group_id(&needed(self.group.clone(), "group")?)?,
                name: needed(self.name.clone(), "name")?,
                value: self.value.clone().map(SecretBytes::new),
            },
            DraftKind::NoteFirst => core::Draft::NoteFirst {
                payload: payload()?,
            },
            DraftKind::NoteVersion => core::Draft::NoteVersion {
                object_id: object()?,
                closed: closed()?,
                payload: payload()?,
            },
            DraftKind::Answer => core::Draft::Answer {
                session: session()?,
                object_id: object()?,
                choices: needed(self.choices.clone(), "choices")?,
                closes: needed(self.closes, "closes")?,
                payload: payload()?,
            },
            DraftKind::TakeBack => core::Draft::TakeBack {
                session: session()?,
                object_id: object()?,
                payload: payload()?,
            },
            DraftKind::Verdict => core::Draft::Verdict {
                session: session()?,
                request_id: object_id(&needed(self.request_id.clone(), "requestId")?)?,
                allow: needed(self.allow, "allow")?,
                payload: payload()?,
            },
            DraftKind::CardFirst => core::Draft::CardFirst {
                session: session()?,
                urgency: urgency()?,
                push: push()?,
                payload: payload()?,
            },
            DraftKind::CardVersion => core::Draft::CardVersion {
                session: session()?,
                object_id: object()?,
                closed: closed()?,
                urgency: urgency()?,
                push: push()?,
                payload: payload()?,
            },
            DraftKind::PermissionRequest => core::Draft::PermissionRequest {
                session: session()?,
                urgency: urgency()?,
                expires_at: needed(self.expires_at, "expiresAt")?,
                push: push()?,
                payload: payload()?,
            },
            DraftKind::ArtifactFirst => core::Draft::ArtifactFirst {
                session: session()?,
                payload: payload()?,
            },
            DraftKind::ArtifactVersion => core::Draft::ArtifactVersion {
                session: session()?,
                object_id: object()?,
                closed: closed()?,
                payload: payload()?,
            },
        })
    }
}

/// The file ids of a draft as the core takes them.
pub(crate) fn file_ids(ids: &[Vec<u8>]) -> Result<Vec<FileId>, CoreError> {
    ids.iter().map(|id| Ok(FileId::from_slice(id)?)).collect()
}

record! {
    /// What sealing made: the envelope waits in the outbox; its hash and number are final.
    pub struct Sealed {
        /// The outbox entry that holds the envelope.
        pub outbox_id: u64,
        /// Its hash, 32 bytes.
        pub envelope_hash: Vec<u8>,
        /// Its number in this device's chain in the group.
        pub seq: u64,
        /// The group.
        pub group: Vec<u8>,
        /// The object it belongs to, for the kinds that have one; of a first version, the new object's id.
        pub object_id: Option<Vec<u8>>,
        /// The time of its header, in milliseconds.
        pub time: u64,
    }
}

impl From<core::Sealed> for Sealed {
    fn from(sealed: core::Sealed) -> Self {
        Self {
            outbox_id: sealed.outbox_id,
            envelope_hash: sealed.envelope_hash.as_bytes().to_vec(),
            seq: sealed.seq,
            group: sealed.group.as_bytes().to_vec(),
            object_id: sealed.object_id.map(|id| id.as_bytes().to_vec()),
            time: sealed.time,
        }
    }
}

choice! {
    /// The kind of an envelope.
    pub enum EnvelopeKind {
        /// An item on a timeline: a Chat message or a board item.
        Item = "item",
        /// A version of a card, a Note or an Artifact.
        Version = "version",
        /// An answer to a card version.
        Answer = "answer",
        /// A permission request.
        Request = "request",
        /// A verdict on a permission request.
        Verdict = "verdict",
        /// A register value.
        Register = "register",
        /// An answer taken back.
        TakeBack = "takeBack",
        /// A kind a newer Trommi defines: nothing of it is applied.
        Reserved = "reserved",
    }
}

choice! {
    /// Which timeline an item stands on.
    pub enum TimelineKind {
        /// The Chat of a session: `id` is the session, 16 bytes.
        SessionChat = "sessionChat",
        /// A card's own Chat: `id` is the card, 16 bytes.
        CardChat = "cardChat",
        /// A Scribble Board: `id` is the board, 16 bytes.
        Board = "board",
    }
}

record! {
    /// The timeline of an item.
    pub struct TimelineRef {
        /// Which kind of timeline.
        pub kind: TimelineKind,
        /// The session, the card or the board.
        pub id: Vec<u8>,
    }
}

record! {
    /// What an envelope's header says of the object it belongs to.
    pub struct ObjectHeader {
        /// The object, 16 bytes.
        pub object_id: Vec<u8>,
        /// Its type.
        pub object_type: ObjectType,
        /// The state this envelope gives it.
        pub object_state: ObjectState,
        /// Its urgency.
        pub urgency: Urgency,
        /// When it was answered, in milliseconds; 0 while open. For display only.
        pub answered_at: u64,
        /// A version: the hash of the version before it, zeros for the first. An answer or a take back: the
        /// version answered. A verdict: the request. A request: zeros.
        pub object_ref: Vec<u8>,
    }
}

record! {
    /// The readable header of an envelope. Everything in it is signed by its sender; `time` is a claim.
    pub struct EnvelopeHeader {
        /// The group whose content key seals the body.
        pub group: Vec<u8>,
        /// The session of that group; none in the room group.
        pub session_id: Option<Vec<u8>>,
        /// The epoch of that key.
        pub epoch: u64,
        /// The device that signs, 32 bytes.
        pub sender: Vec<u8>,
        /// The envelope's number in its sender's chain in this group, from 1.
        pub seq: u64,
        /// The hash of the sender's envelope before it; zeros for the first.
        pub prev: Vec<u8>,
        /// The device the envelope is addressed to; none when it is addressed to nobody.
        pub recipient: Option<Vec<u8>>,
        /// The sender's clock, in milliseconds.
        pub time: u64,
        /// The kind.
        pub kind: EnvelopeKind,
        /// Whether the sender asks for a push.
        pub push: bool,
        /// For an item, its timeline.
        pub timeline: Option<TimelineRef>,
        /// For a register value, the register's id, 16 bytes.
        pub register_id: Option<Vec<u8>>,
        /// For a version, an answer, a request, a verdict and a take back: the object block.
        pub object: Option<ObjectHeader>,
        /// The files the body refers to, 16 bytes each.
        pub file_ids: Vec<Vec<u8>>,
        /// For a kind a newer Trommi defines: its number, 8 or above.
        pub reserved_kind: Option<u8>,
        /// For such a kind: its object block as it came, unread.
        pub reserved_block: Option<Vec<u8>>,
    }
}

impl From<&Header> for EnvelopeHeader {
    fn from(header: &Header) -> Self {
        let object = |fields: &envelope::ObjectFields| ObjectHeader {
            object_id: fields.object_id.as_bytes().to_vec(),
            object_type: fields.object_type.into(),
            object_state: fields.state.into(),
            urgency: fields.urgency.into(),
            answered_at: fields.answered_at,
            object_ref: fields.object_ref.as_bytes().to_vec(),
        };
        let (kind, timeline, register_id, fields) = match &header.subject {
            Subject::Item(timeline) => {
                let (kind, id) = match timeline {
                    Timeline::SessionChat(session) => {
                        (TimelineKind::SessionChat, session.as_bytes().to_vec())
                    }
                    Timeline::CardChat(card) => (TimelineKind::CardChat, card.as_bytes().to_vec()),
                    Timeline::Board(board) => (TimelineKind::Board, board.as_bytes().to_vec()),
                };
                (
                    EnvelopeKind::Item,
                    Some(TimelineRef { kind, id }),
                    None,
                    None,
                )
            }
            Subject::Version(fields) => (EnvelopeKind::Version, None, None, Some(object(fields))),
            Subject::Answer(fields) => (EnvelopeKind::Answer, None, None, Some(object(fields))),
            Subject::Request(fields) => (EnvelopeKind::Request, None, None, Some(object(fields))),
            Subject::Verdict(fields) => (EnvelopeKind::Verdict, None, None, Some(object(fields))),
            Subject::Register(id) => (
                EnvelopeKind::Register,
                None,
                Some(id.as_bytes().to_vec()),
                None,
            ),
            Subject::TakeBack(fields) => (EnvelopeKind::TakeBack, None, None, Some(object(fields))),
            Subject::Reserved { .. } => (EnvelopeKind::Reserved, None, None, None),
        };
        let (reserved_kind, reserved_block) = match &header.subject {
            Subject::Reserved { kind, block } => (Some(*kind), Some(block.to_vec())),
            _ => (None, None),
        };
        Self {
            reserved_kind,
            reserved_block,
            group: header.group.as_bytes().to_vec(),
            session_id: header
                .group
                .session_id()
                .map(|session| session.as_bytes().to_vec()),
            epoch: header.epoch,
            sender: header.sender.as_bytes().to_vec(),
            seq: header.seq,
            prev: header.prev.as_bytes().to_vec(),
            recipient: Some(header.recipient)
                .filter(|recipient| !recipient.is_zero())
                .map(|recipient| recipient.as_bytes().to_vec()),
            time: header.time,
            kind,
            push: header.push,
            timeline,
            register_id,
            object: fields,
            file_ids: header
                .file_ids
                .iter()
                .map(|id| id.as_bytes().to_vec())
                .collect(),
        }
    }
}

choice! {
    /// What a body binds beside its payload.
    pub enum BindKind {
        /// An answer: `object_id`, `version_hash`, `choices`.
        Answer = "answer",
        /// A permission request: `request_id`, `expires_at`.
        Request = "request",
        /// A verdict: `request_id`, `request_hash`, `expires_at`, `allow`.
        Verdict = "verdict",
        /// A take back: `object_id`, `previous_hash`, `version_hash`.
        TakeBack = "takeBack",
    }
}

record! {
    /// What the body of an answer, a request, a verdict or a take back binds. The fields are filled as `kind`
    /// says.
    pub struct Bind {
        /// What kind of body it is.
        pub kind: BindKind,
        /// The card.
        pub object_id: Option<Vec<u8>>,
        /// The permission request.
        pub request_id: Option<Vec<u8>>,
        /// The hash of the version answered.
        pub version_hash: Option<Vec<u8>>,
        /// The hash of the answer taken back.
        pub previous_hash: Option<Vec<u8>>,
        /// The hash of the request a verdict answers.
        pub request_hash: Option<Vec<u8>>,
        /// The chosen options of an answer.
        pub choices: Vec<String>,
        /// Until when a verdict counts, in milliseconds.
        pub expires_at: u64,
        /// A verdict: allow, or deny.
        pub allow: bool,
    }
}

impl Bind {
    fn of(bind: &CoreBind) -> Option<Self> {
        let empty = |kind| Self {
            kind,
            object_id: None,
            request_id: None,
            version_hash: None,
            previous_hash: None,
            request_hash: None,
            choices: Vec::new(),
            expires_at: 0,
            allow: false,
        };
        Some(match bind {
            CoreBind::None => return None,
            CoreBind::Answer(answer) => Self {
                object_id: Some(answer.object_id.as_bytes().to_vec()),
                version_hash: Some(answer.version_hash.as_bytes().to_vec()),
                choices: answer
                    .choices
                    .iter()
                    .map(|choice| String::from_utf8_lossy(choice).into_owned())
                    .collect(),
                ..empty(BindKind::Answer)
            },
            CoreBind::Request(request) => Self {
                request_id: Some(request.request_id.as_bytes().to_vec()),
                expires_at: request.expires_at,
                ..empty(BindKind::Request)
            },
            CoreBind::Verdict(verdict) => Self {
                request_id: Some(verdict.request_id.as_bytes().to_vec()),
                request_hash: Some(verdict.request_hash.as_bytes().to_vec()),
                expires_at: verdict.expires_at,
                allow: verdict.verdict == envelope::Verdict::Allow,
                ..empty(BindKind::Verdict)
            },
            CoreBind::TakeBack(take_back) => Self {
                object_id: Some(take_back.object_id.as_bytes().to_vec()),
                previous_hash: Some(take_back.previous_hash.as_bytes().to_vec()),
                version_hash: Some(take_back.version_hash.as_bytes().to_vec()),
                ..empty(BindKind::TakeBack)
            },
        })
    }
}

record! {
    /// An object as the envelopes accepted so far leave it.
    pub struct ObjectView {
        /// The object, 16 bytes.
        pub object_id: Vec<u8>,
        /// What it is.
        pub object_type: ObjectType,
        /// The device that wrote its newest version. Who owns it now, `object_owner` says.
        pub owner: Vec<u8>,
        /// Open, answered or closed.
        pub object_state: ObjectState,
        /// The hash of its current version; of a permission request, of the request.
        pub current: Vec<u8>,
        /// The answer in force, while the state is answered or an answer closed the card.
        pub answer: Option<Vec<u8>>,
    }
}

impl ObjectView {
    pub(crate) fn of(id: &ObjectId, object: &Object) -> Self {
        Self {
            object_id: id.as_bytes().to_vec(),
            object_type: object.object_type.into(),
            owner: object.owner.as_bytes().to_vec(),
            object_state: object.state.into(),
            current: object.current.as_bytes().to_vec(),
            answer: object.answer.map(|answer| answer.as_bytes().to_vec()),
        }
    }
}

record! {
    /// A register value that was taken.
    pub struct RegisterChange {
        /// The name.
        pub name: String,
        /// The sender, for a name of which each device holds its own value.
        pub of: Option<Vec<u8>>,
        /// Whether this value is now the current one of the name.
        pub current: bool,
    }
}

choice! {
    /// What became of a received envelope.
    pub enum EnvelopeOutcome {
        /// It passed all nine checks and what it carries was taken.
        Applied = "applied",
        /// It took its place in its sender's chain and is not applied; `code` says why. One whose body alone
        /// failed still counts for its object's state.
        Chained = "chained",
        /// The hub's void record: chained, never applied; `code` is its void code.
        Void = "void",
        /// Fetched out of order: it may be shown, marked as not yet confirmed, and no command follows from it.
        Provisional = "provisional",
        /// It consumed nothing; `code` is the check that refused it.
        Refused = "refused",
    }
}

record! {
    /// A received envelope and what became of it. `payload` is decrypted content.
    secret pub struct ReceivedEnvelope {
        /// The hub's change number it came under.
        pub change: u64,
        /// Its hash, 32 bytes.
        pub envelope_hash: Vec<u8>,
        /// Its header.
        pub header: EnvelopeHeader,
        /// What became of it.
        pub outcome: EnvelopeOutcome,
        /// Why it is not applied.
        pub code: Option<ErrorCode>,
        /// A finding to show beside it: `hub-voided-other`.
        pub finding: Option<ErrorCode>,
        /// The body's JSON; none when the body did not open.
        pub payload: Option<Vec<u8>>,
        /// What the body binds; none for items, versions and registers, and when the body did not open.
        pub bind: Option<Bind>,
        /// The object after this envelope; none for items and registers, and for an envelope that changed no
        /// object.
        pub object_after: Option<ObjectView>,
        /// For a register whose value was taken: its name and whether it is now the current one.
        pub register: Option<RegisterChange>,
        /// For an envelope that came through its chain and had been shown as provisional before: true when the
        /// chain took that very envelope, false when what was shown is to be dropped (`dropped` says why).
        pub confirmed: Option<bool>,
        /// Why a provisional envelope is dropped from what is shown: `hash-mismatch` when the chain holds
        /// another envelope under its number, else the code its chain refused or voided it with.
        pub dropped: Option<ErrorCode>,
        /// The envelope was accepted behind later ones of its group, and the group's object states and
        /// registers were built again in the hub's order: what was read from them before is read again.
        pub replayed: bool,
        /// On an agent or helper device: the envelope is addressed to this device and is of a kind the command
        /// gate knows. `command` decides whether to act on it.
        pub command: bool,
    }
}

fn code(error: Error) -> ErrorCode {
    CoreError::from(error).code()
}

impl From<core::ReceivedEnvelope> for ReceivedEnvelope {
    fn from(received: core::ReceivedEnvelope) -> Self {
        let (confirmed, dropped) = match received.provisional {
            None => (None, None),
            Some(core::Confirmation::Confirmed) => (Some(true), None),
            Some(core::Confirmation::Dropped(error)) => (Some(false), Some(code(error))),
        };
        Self {
            change: received.change,
            envelope_hash: received.envelope_hash.as_bytes().to_vec(),
            header: EnvelopeHeader::from(&received.header),
            outcome: match received.outcome {
                core::EnvelopeOutcome::Applied => EnvelopeOutcome::Applied,
                core::EnvelopeOutcome::Chained => EnvelopeOutcome::Chained,
                core::EnvelopeOutcome::Void => EnvelopeOutcome::Void,
                core::EnvelopeOutcome::Provisional => EnvelopeOutcome::Provisional,
                core::EnvelopeOutcome::Refused => EnvelopeOutcome::Refused,
            },
            code: received.code.map(code),
            finding: received.finding.map(code),
            payload: received.body.as_ref().map(|body| body.payload().to_vec()),
            bind: received
                .body
                .as_ref()
                .and_then(|body| Bind::of(body.bind())),
            object_after: received
                .object_after
                .as_ref()
                .map(|(id, object)| ObjectView::of(id, object)),
            register: received.register.map(|change| RegisterChange {
                name: change.name,
                of: change.of.map(|device| device.as_bytes().to_vec()),
                current: change.current,
            }),
            confirmed,
            dropped,
            replayed: received.replayed,
            command: received.command,
        }
    }
}

/// The void code a hub served an envelope with, as the core takes it; `bad-format` for a code that no hub
/// voids with and the core has no error for.
pub(crate) fn void_code(code: Option<ErrorCode>) -> Result<Option<Error>, CoreError> {
    match code {
        None => Ok(None),
        Some(code) if crate::error::is_core_code(code) => Ok(Some(core_error(code))),
        Some(_) => Err(CoreError::bad_format("not a code a hub voids with")),
    }
}

record! {
    /// One envelope of a sender's chain: its number and its hash.
    pub struct ChainHead {
        /// The envelope's number; 0 before the first.
        pub seq: u64,
        /// Its hash, 32 bytes; zeros before the first.
        pub hash: Vec<u8>,
    }
}

impl From<Head> for ChainHead {
    fn from(head: Head) -> Self {
        Self {
            seq: head.seq,
            hash: head.hash.as_bytes().to_vec(),
        }
    }
}

record! {
    /// The last envelope of one writer.
    pub struct WriterHead {
        /// The writer, 32 bytes.
        pub writer: Vec<u8>,
        /// The envelope's number.
        pub seq: u64,
        /// Its hash, 32 bytes.
        pub hash: Vec<u8>,
    }
}

pub(crate) fn writer_heads(heads: &[(DeviceId, Head)]) -> Vec<WriterHead> {
    heads
        .iter()
        .map(|(writer, head)| WriterHead {
            writer: writer.as_bytes().to_vec(),
            seq: head.seq,
            hash: head.hash.as_bytes().to_vec(),
        })
        .collect()
}

pub(crate) fn core_heads(heads: &[WriterHead]) -> Result<Vec<(DeviceId, Head)>, CoreError> {
    heads
        .iter()
        .map(|head| {
            Ok((
                device_id(&head.writer)?,
                Head {
                    seq: head.seq,
                    hash: hash32(&head.hash)?,
                },
            ))
        })
        .collect()
}

choice! {
    /// How this device's chain of one sender compares with a head another device names.
    pub enum Standing {
        /// This device holds the named envelope.
        Held = "held",
        /// This device holds less (`have` is its last number): it fetches the sender's chain after that. If the
        /// hub then has nothing, the finding is `withheld`.
        Behind = "behind",
        /// This device holds another envelope under the named number: the finding `equivocation`.
        Equivocation = "equivocation",
        /// This device holds more than the named number and keeps no record of it: nothing to compare.
        Unknown = "unknown",
    }
}

record! {
    /// One sender named in another device's `heads`, compared with this device's own chain of it.
    pub struct HeadStanding {
        /// The sender, 32 bytes.
        pub sender: Vec<u8>,
        /// How the two compare.
        pub standing: Standing,
        /// This device's last accepted number of that sender, where it holds less.
        pub have: u64,
    }
}

impl HeadStanding {
    pub(crate) fn of(sender: &DeviceId, standing: CoreStanding) -> Self {
        let (standing, have) = match standing {
            CoreStanding::Held => (Standing::Held, 0),
            CoreStanding::Behind { have } => (Standing::Behind, have),
            CoreStanding::Equivocation => (Standing::Equivocation, 0),
            CoreStanding::Unknown => (Standing::Unknown, 0),
        };
        Self {
            sender: sender.as_bytes().to_vec(),
            standing,
            have,
        }
    }
}

record! {
    /// One item of a board as the hub served it: who sent it, its number, its hash.
    pub struct ServedItem {
        /// Its sender, 32 bytes.
        pub sender: Vec<u8>,
        /// Its number in the sender's chain.
        pub seq: u64,
        /// Its hash, 32 bytes.
        pub hash: Vec<u8>,
    }
}

record! {
    /// A Scribble Board, loaded and verified.
    pub struct BoardLoaded {
        /// The frontier now applied: per writer the last envelope of its verified chain. The next snapshot
        /// stands at or beyond it.
        pub frontier: Vec<WriterHead>,
        /// The served items (by their place in what was served, from 0) that lie after the snapshot and were
        /// found in their writer's chain: they are added to the snapshot's shapes.
        pub fresh: Vec<u32>,
        /// The served items the snapshot stands for.
        pub covered: Vec<u32>,
    }
}

fn places(places: &[usize]) -> Vec<u32> {
    places
        .iter()
        .map(|place| u32::try_from(*place).unwrap_or(u32::MAX))
        .collect()
}

impl From<trommi_core::board::Loaded> for BoardLoaded {
    fn from(loaded: trommi_core::board::Loaded) -> Self {
        Self {
            frontier: writer_heads(&loaded.frontier),
            fresh: places(&loaded.fresh),
            covered: places(&loaded.covered),
        }
    }
}

choice! {
    /// What the command gate says of an envelope.
    pub enum Gate {
        /// Every condition holds and the command is new: it is recorded as started. The caller acts, then
        /// calls `command_finished`.
        Act = "act",
        /// A condition does not hold: nothing is executed. `refusal` names it.
        Refused = "refused",
        /// The command was executed before.
        Done = "done",
        /// The command was started before and never finished: its effect is uncertain. It is reported to the
        /// human, not repeated.
        Uncertain = "uncertain",
    }
}

choice! {
    /// What a command asks an agent or helper device to do.
    pub enum CommandKind {
        /// Take a human's Chat message as input.
        Chat = "chat",
        /// Act on the answer to a card of this device: `action`, `choices`.
        Answer = "answer",
        /// Act on the verdict on a permission request of this device: `allow`.
        Verdict = "verdict",
        /// Stop acting on an answer: the human took it back.
        TakeBack = "takeBack",
    }
}

choice! {
    /// What a human did with a card.
    pub enum AnswerKind {
        /// Chose among the options, or answered a card without options.
        Answer = "answer",
        /// Marked an Info card as read.
        Read = "read",
        /// Threw the card away unanswered.
        Shred = "shred",
    }
}

record! {
    /// The command gate's answer for one envelope.
    pub struct CommandDecision {
        /// What the gate says.
        pub gate: Gate,
        /// For `act`: what to do.
        pub command: Option<CommandKind>,
        /// For an answer: what the human did.
        pub action: Option<AnswerKind>,
        /// For an answer: the keys of the chosen options, in the order given.
        pub choices: Vec<String>,
        /// For a verdict: allow, or deny.
        pub allow: Option<bool>,
        /// For `refused`: the condition that does not hold, in words for a log.
        pub refusal: Option<String>,
    }
}

impl From<Decision> for CommandDecision {
    fn from(decision: Decision) -> Self {
        let empty = |gate| Self {
            gate,
            command: None,
            action: None,
            choices: Vec::new(),
            allow: None,
            refusal: None,
        };
        match decision {
            Decision::Act(Command::Chat) => Self {
                command: Some(CommandKind::Chat),
                ..empty(Gate::Act)
            },
            Decision::Act(Command::Answer { action, choices }) => Self {
                command: Some(CommandKind::Answer),
                action: Some(match action {
                    AnswerAction::Answer => AnswerKind::Answer,
                    AnswerAction::Read => AnswerKind::Read,
                    AnswerAction::Shred => AnswerKind::Shred,
                }),
                choices,
                ..empty(Gate::Act)
            },
            Decision::Act(Command::Verdict(verdict)) => Self {
                command: Some(CommandKind::Verdict),
                allow: Some(verdict == envelope::Verdict::Allow),
                ..empty(Gate::Act)
            },
            Decision::Act(Command::TakeBack) => Self {
                command: Some(CommandKind::TakeBack),
                ..empty(Gate::Act)
            },
            Decision::Refused(refusal) => Self {
                refusal: Some(refusal_text(refusal).to_owned()),
                ..empty(Gate::Refused)
            },
            Decision::Done => empty(Gate::Done),
            Decision::Uncertain => empty(Gate::Uncertain),
        }
    }
}

fn refusal_text(refusal: Refusal) -> &'static str {
    match refusal {
        Refusal::NotHuman => "the sender is not a human device now",
        Refusal::NotAddressed => "the envelope is not addressed to this device",
        Refusal::OldEpoch => "the envelope's epoch is over",
        Refusal::NotACommand => "the envelope is of no kind that commands",
        Refusal::BindMismatch => "the body names another object than the header",
        Refusal::NotOwned => "the object is not one this device owns",
        Refusal::NotOpen => "the card is not open",
        Refusal::VersionChanged => "the version answered is not the current one",
        Refusal::NoRecord => "this device has no record of the version or request named",
        Refusal::BadAnswer => "the answer names no known action",
        Refusal::BadChoice => "the choices are not what the card allows",
        Refusal::NotPending => "the permission request is not pending",
        Refusal::RequestMismatch => "the verdict is not for this request",
        Refusal::Expired => "the permission request has expired",
        Refusal::NotTheAnswer => "the answer taken back is not the one in force",
    }
}

record! {
    /// A finding the device made while it processed a Commit, kept until the client has read it.
    pub struct Finding {
        /// The group.
        pub group: Vec<u8>,
        /// The device whose chain it is about, 32 bytes.
        pub sender: Vec<u8>,
        /// The finding: `equivocation` when a Cut names another envelope than the one this device had accepted
        /// under the Cut's number.
        pub code: ErrorCode,
    }
}

impl From<core::Finding> for Finding {
    fn from(finding: core::Finding) -> Self {
        Self {
            group: finding.group.as_bytes().to_vec(),
            sender: finding.sender.as_bytes().to_vec(),
            code: code(finding.code),
        }
    }
}

record! {
    /// One item of a Scribble Board for [`board_reduce`]: the sender and number of its signed header, and its
    /// body, which is decrypted content.
    secret pub struct BoardItem {
        /// The sender of the item's envelope, 32 bytes.
        pub sender: Vec<u8>,
        /// The envelope's number in the sender's chain in the room group.
        pub seq: u64,
        /// The item's body.
        pub payload: Vec<u8>,
    }
}

/// The Scribble Board's merge, without state: the board that `items` make of a snapshot, written as the
/// snapshot file's JSON for `frontier`.
///
/// `snapshot` is a snapshot file (decompressed) and `snapshot_frontier` the frontier its register names; none
/// starts from an empty board. `items` are board items that passed the receiver's checks, in any order: each
/// writer's are applied in the order of its chain, and those the snapshot covers are skipped. `frontier` names
/// per writer the last envelope the caller accepted in the room group. An item of a newer version is skipped,
/// and the result is then `newer-version`: such a board writes no snapshot. The result may hold file keys.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn board_reduce(
    snapshot: Option<Vec<u8>>,
    snapshot_frontier: Vec<WriterHead>,
    items: Vec<BoardItem>,
    frontier: Vec<WriterHead>,
) -> Result<Vec<u8>, CoreError> {
    let snapshot_frontier = core_heads(&snapshot_frontier)?;
    let snapshot = snapshot.as_ref().map(|file| core::BoardSnapshot {
        file,
        frontier: &snapshot_frontier,
    });
    let items = items
        .into_iter()
        .map(|item| {
            Ok(core::BoardItem {
                sender: device_id(&item.sender)?,
                seq: item.seq,
                payload: SecretBytes::new(item.payload),
            })
        })
        .collect::<Result<Vec<_>, CoreError>>()?;
    let board = core::board_reduce(snapshot.as_ref(), &items, &core_heads(&frontier)?)?;
    Ok(board.expose().to_vec())
}

record! {
    /// An envelope's readable part, read without a device.
    pub struct EnvelopeInfo {
        /// Its hash, 32 bytes.
        pub envelope_hash: Vec<u8>,
        /// Its header.
        pub header: EnvelopeHeader,
        /// Whether its body was removed (the pruned form).
        pub pruned: bool,
    }
}

/// Reads the header of an envelope, in full or in pruned form, without a device: for sorting what the hub
/// serves before it is handed to [`crate::CoreDevice::receive_envelope`]. The sender's signature is verified
/// (`bad-signature`), which says that the device named as sender wrote it and nothing more: whether that device
/// was a member, and where the envelope stands in its chain, only a device's own checks tell.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn envelope_header(envelope: Vec<u8>) -> Result<EnvelopeInfo, CoreError> {
    let envelope = envelope::Envelope::decode(&envelope)?;
    Ok(EnvelopeInfo {
        envelope_hash: envelope.verify()?.as_bytes().to_vec(),
        header: EnvelopeHeader::from(&envelope.header),
        pruned: envelope.is_pruned(),
    })
}

/// The Cut of a device as a record.
pub(crate) fn cut(cut: &trommi_core::mls::profile::Cut) -> Cut {
    Cut::from(cut)
}
