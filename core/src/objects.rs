//! Objects (sections 9.2 and 9.0.9): who may write which item, the state of every card, Note, permission
//! request and Artifact as it follows from headers alone, and the gate an agent passes before it acts on a
//! human's envelope.
//!
//! The hub and every client run [`judge`] on each envelope that took its place in a chain, in the hub's order,
//! and so agree on what is open, answered or closed without reading a body. [`Objects`] is the state of one
//! group; it is plain data that the caller stores.

use crate::chain::{GroupFacts, Role, LIVE_GRACE_MS};
use crate::codec::{Decode, Encode, Reader, Writer};
use crate::envelope::{
    self, Bind, Body, Header, ObjectFields, ObjectState, ObjectType, RequestBind, Subject,
    Timeline, Verdict,
};
use crate::error::Error;
use crate::ids::{DeviceId, GroupId, Hash32, ObjectId};
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

/// The largest stored state this module reads.
const MAX_STATE_LEN: usize = 1 << 28;

/// The state of one object, as the envelopes taken so far leave it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Object {
    /// What it is; fixed by its first version.
    pub object_type: ObjectType,
    /// The device that wrote its newest version. Who owns the object now is [`owner`]'s to say: the ownership
    /// passes on, for good, when this device is no longer a leaf.
    pub owner: DeviceId,
    /// Open, answered or closed.
    pub state: ObjectState,
    /// The `envelope_hash` of the current version; of a permission request, of the request. For a Note: of the
    /// version that arrived last (which one a client shows it chooses as for registers, from the bodies).
    pub current: Hash32,
    /// The answer in force, while the state is answered or an answer closed the card.
    pub answer: Option<Hash32>,
}

impl Encode for Object {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.u8(self.object_type.byte());
        writer.fixed(self.owner.as_bytes());
        writer.u8(self.state.byte());
        writer.fixed(self.current.as_bytes());
        writer.fixed(self.answer.unwrap_or(Hash32::ZERO).as_bytes());
        Ok(())
    }
}

impl Decode for Object {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        Ok(Self {
            object_type: ObjectType::from_byte(reader.u8()?)?,
            owner: reader.value()?,
            state: ObjectState::from_byte(reader.u8()?)?,
            current: reader.value()?,
            answer: Some(reader.value::<Hash32>()?).filter(|hash| !hash.is_zero()),
        })
    }
}

/// The change one envelope makes to its object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transition {
    /// The object.
    pub object_id: ObjectId,
    /// Its state just before the envelope; `None` for a first version or a permission request.
    pub before: Option<Object>,
    /// Its state with the envelope.
    pub after: Object,
    /// A Note's version: the envelope's hash, which later versions of the Note may follow.
    pub note_version: Option<Hash32>,
    /// The revision of the [`Objects`] the envelope was judged against.
    pub revision: u64,
}

/// The objects of one group.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Objects {
    /// How many transitions this state has taken: a transition fits only the revision it was judged against.
    revision: u64,
    objects: BTreeMap<ObjectId, Object>,
    /// Every version taken of every Note: a Note's version may follow any other.
    note_versions: BTreeSet<(ObjectId, Hash32)>,
}

struct ObjectEntry(ObjectId, Object);

impl Encode for ObjectEntry {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.fixed(self.0.as_bytes());
        writer.value(&self.1)
    }
}

impl Decode for ObjectEntry {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        Ok(Self(reader.value()?, reader.value()?))
    }
}

fn corrupt(_: Error) -> Error {
    Error::Storage("stored object state does not decode".into())
}

impl Objects {
    /// No object yet.
    pub fn new() -> Self {
        Self::default()
    }

    /// The state of `object`, if a first version of it was taken.
    pub fn get(&self, object: &ObjectId) -> Option<&Object> {
        self.objects.get(object)
    }

    /// Every object with its state, ascending by id.
    pub fn iter(&self) -> impl Iterator<Item = (&ObjectId, &Object)> {
        self.objects.iter()
    }

    /// Whether `hash` is a version taken of the Note `object`.
    pub fn is_note_version(&self, object: &ObjectId, hash: &Hash32) -> bool {
        self.note_versions.contains(&(*object, *hash))
    }

    /// Takes the change of one envelope. `Error::Internal`, and no change, if the object no longer stands as
    /// the envelope was judged: a transition is applied once, before the next envelope of the group is
    /// judged.
    pub fn apply(&mut self, transition: &Transition) -> Result<(), Error> {
        if self.revision != transition.revision
            || self.objects.get(&transition.object_id) != transition.before.as_ref()
        {
            return Err(Error::Internal("a transition applied out of turn"));
        }
        self.revision = self.revision.saturating_add(1);
        self.objects
            .insert(transition.object_id, transition.after.clone());
        if let Some(version) = transition.note_version {
            self.note_versions.insert((transition.object_id, version));
        }
        Ok(())
    }

    /// The stored form.
    pub fn to_bytes(&self) -> Result<Vec<u8>, Error> {
        let entries: Vec<ObjectEntry> = self
            .objects
            .iter()
            .map(|(id, object)| ObjectEntry(*id, object.clone()))
            .collect();
        let mut writer = Writer::new();
        writer.u64(self.revision);
        writer.vector(&entries)?;
        let mut versions = Writer::new();
        for (object, version) in &self.note_versions {
            versions.fixed(object.as_bytes());
            versions.fixed(version.as_bytes());
        }
        writer.opaque(&versions.into_bytes())?;
        Ok(writer.into_bytes())
    }

    fn read(bytes: &[u8]) -> Result<Self, Error> {
        let mut reader = Reader::new(bytes);
        let revision = reader.u64()?;
        let entries: Vec<ObjectEntry> = reader.vector()?;
        let mut versions = Reader::new(reader.opaque()?);
        reader.finish()?;
        let mut objects = Self {
            revision,
            ..Self::new()
        };
        for ObjectEntry(id, object) in entries {
            if objects.objects.insert(id, object).is_some() {
                return Err(Error::BadFormat);
            }
        }
        while !versions.is_empty() {
            let version = (versions.value()?, versions.value()?);
            let of_a_note = objects
                .get(&version.0)
                .is_some_and(|object| object.object_type == ObjectType::Note);
            if !of_a_note || !objects.note_versions.insert(version) {
                return Err(Error::BadFormat);
            }
        }
        Ok(objects)
    }

    /// Reads the stored form; `Error::Storage` if it does not decode.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        Self::read(bytes).map_err(corrupt)
    }
}

fn allow(condition: bool) -> Result<(), Error> {
    if condition {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}

/// The device that owns `object` in `epoch` of `group` (section 9.2): the writer of its newest version until
/// it is no longer a leaf; from then on, and for good, the session's agent device, in a helper session its
/// opener; nobody while that seat is empty. A writer whose leaf was removed does not own the object again when
/// the same key is a leaf of the group once more: its chain ended at its Cut, and what it owned has passed on.
pub fn owner(
    facts: &dyn GroupFacts,
    group: &GroupId,
    epoch: u64,
    object: &Object,
) -> Result<Option<DeviceId>, Error> {
    let writer = &object.owner;
    if facts.leaf_role(group, epoch, writer)?.is_some()
        && !facts.removed_by(group, epoch, writer)?
    {
        Ok(Some(*writer))
    } else {
        facts.seat(group, epoch)
    }
}

/// A Chat message in a session group: from its agent or helper devices, or from a human device addressed to
/// the session's agent device (in a helper session: its opener). While the session has no such leaf a human
/// device writes with `recipient` zeros: the message is stored and read, and is nobody's command, since the
/// gate acts only on what names its own device.
fn chat_rule(facts: &dyn GroupFacts, header: &Header, role: Role) -> Result<(), Error> {
    allow(!header.group.is_room())?;
    if role == Role::Human {
        let addressee = facts
            .seat(&header.group, header.epoch)?
            .unwrap_or(DeviceId::ZERO);
        allow(header.recipient == addressee)?;
    }
    Ok(())
}

/// The part of 9.2 that follows from the sender's role in the envelope's epoch, the group and the header
/// alone: `forbidden` when a device of that role may not write such an item there at all. What depends on the
/// object's state ([`judge`]) is not looked at; an envelope fetched out of order is held to this much until its
/// chain arrives.
pub fn sender_may(facts: &dyn GroupFacts, header: &Header) -> Result<(), Error> {
    let role = facts
        .leaf_role(&header.group, header.epoch, &header.sender)?
        .ok_or(Error::Forbidden)?;
    let human = role == Role::Human;
    let in_room = header.group.is_room();
    match &header.subject {
        Subject::Item(Timeline::SessionChat(session)) => {
            allow(header.group.session_id() == Some(*session))?;
            chat_rule(facts, header, role)
        }
        Subject::Item(Timeline::CardChat(_)) => chat_rule(facts, header, role),
        Subject::Item(Timeline::Board(_)) => allow(in_room && human),
        Subject::Register(_) => allow(!in_room || human),
        Subject::Version(fields) => match fields.object_type {
            ObjectType::Note => allow(in_room && human),
            ObjectType::Card | ObjectType::Artifact => allow(!in_room && !human),
            ObjectType::Request => Err(Error::Forbidden),
        },
        Subject::Request(fields) => {
            allow(!in_room && !human && fields.object_type == ObjectType::Request)
        }
        Subject::Answer(fields) | Subject::TakeBack(fields) => {
            allow(!in_room && human && fields.object_type == ObjectType::Card)
        }
        Subject::Verdict(fields) => {
            allow(!in_room && human && fields.object_type == ObjectType::Request)
        }
        Subject::Reserved { .. } => Ok(()),
    }
}

/// Whether the push flag of this envelope is honoured (section 9.2): on card versions and permission requests
/// from the session's agent or helper device.
pub fn push_honoured(facts: &dyn GroupFacts, header: &Header) -> Result<bool, Error> {
    let wanted = match &header.subject {
        Subject::Version(fields) => fields.object_type == ObjectType::Card,
        Subject::Request(_) => true,
        _ => false,
    };
    if !header.push || !wanted || header.group.is_room() {
        return Ok(false);
    }
    let role = facts.leaf_role(&header.group, header.epoch, &header.sender)?;
    Ok(matches!(
        role,
        Some(Role::Agent | Role::Opener | Role::Helper)
    ))
}

/// A first version, or a permission request: the object begins, open, owned by its sender.
fn begin(
    objects: &Objects,
    header: &Header,
    fields: &ObjectFields,
    hash: &Hash32,
) -> Result<Transition, Error> {
    let derived = envelope::object_id(&header.group, &header.sender, header.seq)?;
    allow(
        fields.object_id == derived
            && fields.object_ref.is_zero()
            && fields.state == ObjectState::Open
            && objects.get(&fields.object_id).is_none(),
    )?;
    Ok(Transition {
        object_id: fields.object_id,
        before: None,
        after: Object {
            object_type: fields.object_type,
            owner: header.sender,
            state: ObjectState::Open,
            current: *hash,
            answer: None,
        },
        note_version: (fields.object_type == ObjectType::Note).then_some(*hash),
        revision: objects.revision,
    })
}

/// Check 7 of section 9.0.5 with the object state machine of 9.2.1: whether the sender may write this item,
/// judged against the state just before it.
///
/// `Ok(Some(transition))` for an envelope that changes its object, `Ok(None)` for one that is allowed and
/// changes none (an item, a register, a reserved kind), `Err(forbidden)` otherwise: such an envelope is chained
/// and changes nothing. Any other error is a fault of `facts`. `objects` is the state of the envelope's group;
/// `hash` its `envelope_hash`.
pub fn judge(
    facts: &dyn GroupFacts,
    objects: &Objects,
    header: &Header,
    hash: &Hash32,
) -> Result<Option<Transition>, Error> {
    sender_may(facts, header)?;
    let (group, epoch) = (&header.group, header.epoch);
    let fields = match &header.subject {
        Subject::Item(Timeline::CardChat(card)) => {
            let known = objects.get(card);
            allow(known.is_some_and(|object| object.object_type == ObjectType::Card))?;
            return Ok(None);
        }
        Subject::Item(_) | Subject::Register(_) | Subject::Reserved { .. } => return Ok(None),
        Subject::Request(fields) => return begin(objects, header, fields, hash).map(Some),
        Subject::Version(fields) if fields.object_ref.is_zero() => {
            return begin(objects, header, fields, hash).map(Some)
        }
        Subject::Version(fields)
        | Subject::Answer(fields)
        | Subject::TakeBack(fields)
        | Subject::Verdict(fields) => fields,
    };
    let before = objects.get(&fields.object_id).ok_or(Error::Forbidden)?;
    allow(before.object_type == fields.object_type)?;
    let mut after = before.clone();
    after.current = *hash;
    after.state = fields.state;
    let mut note_version = None;
    match &header.subject {
        Subject::Version(_) if before.object_type == ObjectType::Note => {
            allow(
                objects.is_note_version(&fields.object_id, &fields.object_ref)
                    && fields.state != ObjectState::Answered,
            )?;
            note_version = Some(*hash);
        }
        Subject::Version(_) => {
            allow(
                fields.object_ref == before.current
                    && fields.state != ObjectState::Answered
                    && owner(facts, group, epoch, before)? == Some(header.sender),
            )?;
            after.owner = header.sender;
            after.answer = None;
        }
        _ => {
            // An answer leaves an open card answered or closed, a take back opens an answered one again, a
            // verdict closes an open request.
            let (from, reaches) = match &header.subject {
                Subject::Answer(_) => (ObjectState::Open, fields.state != ObjectState::Open),
                Subject::TakeBack(_) => (ObjectState::Answered, fields.state == ObjectState::Open),
                _ => (ObjectState::Open, fields.state == ObjectState::Closed),
            };
            allow(
                fields.object_ref == before.current
                    && before.state == from
                    && reaches
                    && owner(facts, group, epoch, before)? == Some(header.recipient),
            )?;
            // The current version stays; an answer is in force until it is taken back.
            after.current = before.current;
            after.answer = matches!(header.subject, Subject::Answer(_)).then_some(*hash);
        }
    }
    Ok(Some(Transition {
        object_id: fields.object_id,
        before: Some(before.clone()),
        after,
        note_version,
        revision: objects.revision,
    }))
}

/// The object state of a group, replayed from headers alone (section 9.2.1): the envelopes of the group that
/// took a place in a chain, in the hub's order, each with its hash, without the void records and without what
/// lies beyond a Cut. Pruned envelopes count like full ones. An envelope that [`judge`] forbids changes nothing.
/// A device replays after a Cut made it drop envelopes it had applied.
pub fn replay<'a>(
    facts: &dyn GroupFacts,
    envelopes: impl IntoIterator<Item = (&'a Header, &'a Hash32)>,
) -> Result<Objects, Error> {
    let mut objects = Objects::new();
    for (header, hash) in envelopes {
        match judge(facts, &objects, header, hash) {
            Ok(Some(transition)) => objects.apply(&transition)?,
            Ok(None) | Err(Error::Forbidden) => {}
            Err(fault) => return Err(fault),
        }
    }
    Ok(objects)
}

/// An envelope that passed all nine checks, with its opened body and the state of its object just before it.
/// Only [`crate::chain::Receipt::opened`] makes one.
#[derive(Debug, Clone, Copy)]
pub struct Opened<'a> {
    pub(crate) header: &'a Header,
    pub(crate) hash: Hash32,
    pub(crate) body: &'a Body,
    pub(crate) before: Option<&'a Object>,
}

impl Opened<'_> {
    /// The header.
    pub fn header(&self) -> &Header {
        self.header
    }

    /// The `envelope_hash`.
    pub fn hash(&self) -> Hash32 {
        self.hash
    }

    /// The body.
    pub fn body(&self) -> &Body {
        self.body
    }
}

/// What a human does with a card.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnswerAction {
    /// Chooses among the options, or answers a card without options.
    Answer,
    /// Marks an Info card as read.
    Read,
    /// Throws the card away unanswered.
    Shred,
}

/// What the gate lets an agent or helper device do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    /// Take a human's Chat message as input. The payload is the envelope's.
    Chat,
    /// Act on the answer to a card of this device.
    Answer {
        /// What the human did.
        action: AnswerAction,
        /// The keys of the chosen options, in the order given.
        choices: Vec<String>,
    },
    /// Act on the verdict on a permission request of this device.
    Verdict(Verdict),
    /// Stop acting on an answer: the human took it back.
    TakeBack,
}

/// Why the gate lets nothing happen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// The sender is not a human device now.
    NotHuman,
    /// `recipient` is not this device.
    NotAddressed,
    /// The envelope's epoch is neither the group's current one nor the one before with a Commit at most two
    /// minutes old.
    OldEpoch,
    /// The kind is none of: item on a Chat, answer, verdict, take back.
    NotACommand,
    /// The bind names another object or request than the header.
    BindMismatch,
    /// The object is not one of this group that this device owns.
    NotOwned,
    /// An answer to something that is not an open card.
    NotOpen,
    /// The version named is not the card's current one.
    VersionChanged,
    /// This device did not hand in its own record of the card version or request named, so the answer or
    /// verdict cannot be held against it.
    NoRecord,
    /// The answer's payload names no known `answer_action`.
    BadAnswer,
    /// The choices are not what the card version allows.
    BadChoice,
    /// A verdict on something that is not a pending permission request.
    NotPending,
    /// The verdict's `request_hash` or `expires_at` is not the request's own.
    RequestMismatch,
    /// The clock has reached the request's `expires_at`.
    Expired,
    /// A take back whose `previous_hash` is not the answer in force.
    NotTheAnswer,
}

/// The gate's decision on one envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// Every condition holds and the command is new: it is now recorded as started. The caller stores the
    /// [`GateLog`] (in the write that stores the envelope's transition) before it acts, and calls
    /// [`GateLog::finish`] when the effect is complete.
    Act(Command),
    /// A condition does not hold: nothing is executed.
    Refused(Refusal),
    /// The command was executed before.
    Done,
    /// The command was started before and never finished: its effect is uncertain. It is reported to the
    /// human, not repeated.
    Uncertain,
}

/// The commands a device has acted on, by `envelope_hash`: started, or finished.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct GateLog {
    finished: BTreeMap<Hash32, bool>,
}

struct LogEntry(Hash32, bool);

impl Encode for LogEntry {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.fixed(self.0.as_bytes());
        writer.u8(u8::from(self.1));
        Ok(())
    }
}

impl Decode for LogEntry {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        let hash = reader.value()?;
        match reader.u8()? {
            0 => Ok(Self(hash, false)),
            1 => Ok(Self(hash, true)),
            _ => Err(Error::BadFormat),
        }
    }
}

impl GateLog {
    /// No command yet.
    pub fn new() -> Self {
        Self::default()
    }

    /// Marks a started command as finished. `not-found` for a command the gate never let through.
    pub fn finish(&mut self, hash: &Hash32) -> Result<(), Error> {
        let finished = self.finished.get_mut(hash).ok_or(Error::NotFound)?;
        *finished = true;
        Ok(())
    }

    /// The stored form.
    pub fn to_bytes(&self) -> Result<Vec<u8>, Error> {
        let entries: Vec<LogEntry> = self
            .finished
            .iter()
            .map(|(h, f)| LogEntry(*h, *f))
            .collect();
        let mut writer = Writer::new();
        writer.vector(&entries)?;
        Ok(writer.into_bytes())
    }

    /// Reads the stored form; `Error::Storage` if it does not decode.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > MAX_STATE_LEN {
            return Err(corrupt(Error::TooLarge));
        }
        let mut reader = Reader::new(bytes);
        let entries: Vec<LogEntry> = reader.vector().map_err(corrupt)?;
        reader.finish().map_err(corrupt)?;
        let mut log = Self::new();
        for LogEntry(hash, finished) in entries {
            if log.finished.insert(hash, finished).is_some() {
                return Err(corrupt(Error::BadFormat));
            }
        }
        Ok(log)
    }
}

/// What this device kept of the thing an answer or a verdict refers to. It wrote it, so it holds it. A card's
/// payload is content and is not printed.
#[derive(Clone, Copy)]
pub enum OwnRecord<'a> {
    /// Nothing is needed (a Chat message, a take back), or nothing is held.
    None,
    /// A card version: its `envelope_hash` and its JSON payload.
    CardVersion {
        /// The version's `envelope_hash`.
        hash: Hash32,
        /// The version's payload.
        payload: &'a [u8],
    },
    /// A permission request: its `envelope_hash` and its bind.
    Request {
        /// The request's `envelope_hash`.
        hash: Hash32,
        /// The request's bind.
        bind: RequestBind,
    },
}

impl fmt::Debug for OwnRecord<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::None => f.write_str("None"),
            Self::CardVersion { hash, .. } => write!(f, "CardVersion({hash}, <redacted>)"),
            Self::Request { hash, bind } => write!(f, "Request({hash}, {bind:?})"),
        }
    }
}

/// The fields of a card version's payload that decide which choices an answer may carry.
#[derive(Deserialize)]
struct CardPayload {
    #[serde(default)]
    options: Option<Vec<CardOption>>,
    #[serde(default)]
    allows_multiple: Option<bool>,
}

#[derive(Deserialize)]
struct CardOption {
    key: String,
}

/// The fields of an answer's payload that the gate reads.
#[derive(Deserialize)]
struct AnswerPayload {
    answer_action: String,
}

type Gate<T> = Result<T, Refusal>;

fn hold(condition: bool, refusal: Refusal) -> Gate<()> {
    if condition {
        Ok(())
    } else {
        Err(refusal)
    }
}

/// The object an answer, verdict or take back names, if this device owns it.
fn owned<'a>(
    facts: &dyn GroupFacts,
    me: &DeviceId,
    opened: &Opened<'a>,
    fields: &ObjectFields,
    bound_to: &ObjectId,
) -> Result<Gate<&'a Object>, Error> {
    if *bound_to != fields.object_id {
        return Ok(Err(Refusal::BindMismatch));
    }
    let Some(object) = opened.before else {
        return Ok(Err(Refusal::NotOwned));
    };
    // Who owns it now, not in the envelope's epoch: an answer of the epoch before still comes in after the
    // Commit that removed its recipient, and what that device owned has passed on by then.
    let group = &opened.header.group;
    let now = facts.processed_epoch(group)?.ok_or(Error::GroupBehind)?;
    if owner(facts, group, now, object)? != Some(*me) {
        return Ok(Err(Refusal::NotOwned));
    }
    Ok(Ok(object))
}

fn answer_command(
    object: &Object,
    bind: &envelope::AnswerBind,
    payload: &[u8],
    own: &OwnRecord<'_>,
) -> Gate<Command> {
    hold(
        object.object_type == ObjectType::Card && object.state == ObjectState::Open,
        Refusal::NotOpen,
    )?;
    hold(bind.version_hash == object.current, Refusal::VersionChanged)?;
    let card = match own {
        OwnRecord::CardVersion { hash, payload }
            if *hash == object.current && envelope::is_json_object(payload) =>
        {
            serde_json::from_slice::<CardPayload>(payload).map_err(|_| Refusal::NoRecord)?
        }
        _ => return Err(Refusal::NoRecord),
    };
    let answer: AnswerPayload = serde_json::from_slice(payload).map_err(|_| Refusal::BadAnswer)?;
    let action = match answer.answer_action.as_str() {
        "answer" => AnswerAction::Answer,
        "read" => AnswerAction::Read,
        "shred" => AnswerAction::Shred,
        _ => return Err(Refusal::BadAnswer),
    };
    let choices = bind
        .choices
        .iter()
        .map(|choice| String::from_utf8(choice.clone()).map_err(|_| Refusal::BadChoice))
        .collect::<Gate<Vec<String>>>()?;
    let options: BTreeSet<&str> = card
        .options
        .iter()
        .flatten()
        .map(|option| option.key.as_str())
        .collect();
    let distinct: BTreeSet<&str> = choices.iter().map(String::as_str).collect();
    let allowed = match action {
        AnswerAction::Read | AnswerAction::Shred => choices.is_empty(),
        AnswerAction::Answer => {
            distinct.len() == choices.len()
                && distinct.is_subset(&options)
                && (options.is_empty() || !choices.is_empty())
                && (choices.len() <= 1 || card.allows_multiple == Some(true))
        }
    };
    hold(allowed, Refusal::BadChoice)?;
    Ok(Command::Answer { action, choices })
}

fn verdict_command(
    object: &Object,
    fields: &ObjectFields,
    bind: &envelope::VerdictBind,
    own: &OwnRecord<'_>,
    now_ms: u64,
) -> Gate<Command> {
    hold(
        object.object_type == ObjectType::Request && object.state == ObjectState::Open,
        Refusal::NotPending,
    )?;
    hold(
        bind.request_hash == object.current,
        Refusal::RequestMismatch,
    )?;
    let request = match own {
        OwnRecord::Request { hash, bind } if *hash == object.current => bind,
        _ => return Err(Refusal::NoRecord),
    };
    hold(
        request.request_id == fields.object_id && request.expires_at == bind.expires_at,
        Refusal::RequestMismatch,
    )?;
    hold(now_ms < request.expires_at, Refusal::Expired)?;
    Ok(Command::Verdict(bind.verdict))
}

fn take_back_command(object: &Object, bind: &envelope::TakeBackBind) -> Gate<Command> {
    hold(
        object.object_type == ObjectType::Card && bind.version_hash == object.current,
        Refusal::VersionChanged,
    )?;
    hold(
        object.state == ObjectState::Answered && object.answer == Some(bind.previous_hash),
        Refusal::NotTheAnswer,
    )?;
    Ok(Command::TakeBack)
}

/// Whether the envelope's epoch is the group's current one, or the one before with the Commit between at most
/// two minutes old by this device's clock.
fn epoch_in_force(facts: &dyn GroupFacts, header: &Header, now_ms: u64) -> Result<bool, Error> {
    let Some(current) = facts.processed_epoch(&header.group)? else {
        return Ok(false);
    };
    if header.epoch == current {
        return Ok(true);
    }
    if header.epoch.checked_add(1) != Some(current) {
        return Ok(false);
    }
    Ok(facts
        .epoch_end(&header.group, header.epoch)?
        .is_some_and(|end| now_ms.saturating_sub(end.processed_at) <= LIVE_GRACE_MS))
}

/// The command gate (section 9.0.9): whether this agent or helper device (`me`) acts on an envelope.
///
/// `opened` exists only for an envelope that passed all nine checks and came through its sender's chain, and
/// carries the object's state just before the envelope, against which everything here is judged. `own` is this
/// device's record of the card version an answer names, or of the request a verdict names.
///
/// The gate holds every condition of 9.0.9 and answers with a [`Decision`]. On [`Decision::Act`] it has
/// recorded the envelope's hash in `log` as started; a second call for the same envelope never answers `Act`
/// again. Storing the log before acting is the caller's.
pub fn command_gate(
    facts: &dyn GroupFacts,
    log: &mut GateLog,
    me: &DeviceId,
    opened: &Opened<'_>,
    own: &OwnRecord<'_>,
    now_ms: u64,
) -> Result<Decision, Error> {
    match log.finished.get(&opened.hash) {
        Some(true) => return Ok(Decision::Done),
        Some(false) => return Ok(Decision::Uncertain),
        None => {}
    }
    let header = opened.header;
    let standing = if !facts.is_human_now(&header.sender)? {
        Err(Refusal::NotHuman)
    } else if header.recipient.is_zero() || header.recipient != *me {
        // Zeros address nobody (9.2: a human's Chat while the session has no agent leaf).
        Err(Refusal::NotAddressed)
    } else if !epoch_in_force(facts, header, now_ms)? {
        Err(Refusal::OldEpoch)
    } else {
        Ok(())
    };
    if let Err(refusal) = standing {
        return Ok(Decision::Refused(refusal));
    }
    let command = match (&header.subject, opened.body.bind()) {
        (Subject::Item(timeline), Bind::None) if timeline.is_chat() => Ok(Command::Chat),
        (Subject::Answer(fields), Bind::Answer(bind)) => {
            owned(facts, me, opened, fields, &bind.object_id)?
                .and_then(|object| answer_command(object, bind, opened.body.payload(), own))
        }
        (Subject::Verdict(fields), Bind::Verdict(bind)) => {
            owned(facts, me, opened, fields, &bind.request_id)?
                .and_then(|object| verdict_command(object, fields, bind, own, now_ms))
        }
        (Subject::TakeBack(fields), Bind::TakeBack(bind)) => {
            owned(facts, me, opened, fields, &bind.object_id)?
                .and_then(|object| take_back_command(object, bind))
        }
        (Subject::Answer(_) | Subject::Verdict(_) | Subject::TakeBack(_), _) => {
            Err(Refusal::BindMismatch)
        }
        _ => Err(Refusal::NotACommand),
    };
    Ok(match command {
        Ok(command) => {
            log.finished.insert(opened.hash, false);
            Decision::Act(command)
        }
        Err(refusal) => Decision::Refused(refusal),
    })
}

#[cfg(test)]
mod tests {
    //! The gate's own hold on what the chain already refuses. No envelope of these shapes passes check 7, so
    //! no [`Opened`] of them comes out of the chain: they are made by hand here.

    use super::*;
    use crate::chain::{EpochEnd, Head};
    use crate::crypto::{Secret, SigningKey};
    use crate::envelope::{AnswerBind, Draft, Slot, TakeBackBind, Urgency, VerdictBind};
    use crate::ids::{RegisterId, RoomId, SessionId};

    const NOW: u64 = 1_700_000_000_000;
    const EXPIRES_AT: u64 = NOW + 60_000;

    fn device(n: u8) -> DeviceId {
        DeviceId::new(SigningKey::from_seed(Secret::new([n; 32])).public())
    }

    fn group() -> GroupId {
        GroupId::session(RoomId::new([1; 32]), SessionId::new([2; 16]))
    }

    /// A helper session in its epoch 0: device 2 is human, 3 the opener, 4 a helper device.
    struct Session;

    impl GroupFacts for Session {
        fn room(&self) -> RoomId {
            group().room_id()
        }

        fn processed_epoch(&self, _: &GroupId) -> Result<Option<u64>, Error> {
            Ok(Some(0))
        }

        fn leaf_role(&self, _: &GroupId, _: u64, of: &DeviceId) -> Result<Option<Role>, Error> {
            Ok([
                (device(2), Role::Human),
                (device(3), Role::Opener),
                (device(4), Role::Helper),
            ]
            .into_iter()
            .find(|(leaf, _)| leaf == of)
            .map(|(_, role)| role))
        }

        fn seat(&self, _: &GroupId, _: u64) -> Result<Option<DeviceId>, Error> {
            Ok(Some(device(3)))
        }

        fn cut(&self, _: &GroupId, _: &DeviceId) -> Result<Option<Head>, Error> {
            Ok(None)
        }

        fn epoch_end(&self, _: &GroupId, _: u64) -> Result<Option<EpochEnd>, Error> {
            Ok(None)
        }

        fn is_stale(&self, _: &GroupId) -> Result<bool, Error> {
            Ok(false)
        }

        fn is_human_now(&self, of: &DeviceId) -> Result<bool, Error> {
            Ok(*of == device(2))
        }

        fn content_key(&self, _: &GroupId, _: u64) -> Result<Option<Secret<32>>, Error> {
            Ok(None)
        }
    }

    const CARD: ObjectId = ObjectId::new([7; 16]);
    const VERSION: Hash32 = Hash32::new([8; 32]);
    const ANSWER: Hash32 = Hash32::new([6; 32]);
    const CARD_PAYLOAD: &[u8] = br#"{"options":[{"key":"yes","label":"Yes"}]}"#;

    /// The header and body of `draft` as device 2 writes it.
    fn written(draft: &Draft) -> (Header, Body) {
        let slot = Slot {
            group: group(),
            epoch: 0,
            sender: device(2),
            seq: 1,
            prev: Hash32::ZERO,
            time: NOW,
        };
        (draft.header(&slot).unwrap(), draft.body(&slot).unwrap())
    }

    fn object(object_type: ObjectType, owner: u8, state: ObjectState) -> Object {
        Object {
            object_type,
            owner: device(owner),
            state,
            current: VERSION,
            answer: (state == ObjectState::Answered).then_some(ANSWER),
        }
    }

    fn gate(
        me: u8,
        header: &Header,
        body: &Body,
        before: Option<&Object>,
        own: &OwnRecord<'_>,
    ) -> Decision {
        let opened = Opened {
            header,
            hash: Hash32::new([5; 32]),
            body,
            before,
        };
        command_gate(
            &Session,
            &mut GateLog::new(),
            &device(me),
            &opened,
            own,
            NOW,
        )
        .unwrap()
    }

    fn answer_to(recipient: u8) -> (Header, Body) {
        let bind = AnswerBind {
            object_id: CARD,
            version_hash: VERSION,
            choices: vec![b"yes".to_vec()],
        };
        written(&Draft::answer(
            bind,
            false,
            Urgency::Normal,
            device(recipient),
            br#"{"answer_action":"answer"}"#,
        ))
    }

    const OWN_CARD: OwnRecord<'static> = OwnRecord::CardVersion {
        hash: VERSION,
        payload: CARD_PAYLOAD,
    };

    #[test]
    fn the_gate_refuses_a_kind_that_is_no_command_whoever_it_names() {
        let (mut header, body) = written(&Draft::register(RegisterId::new([1; 16]), b"{}"));
        header.recipient = device(3);
        assert_eq!(
            gate(3, &header, &body, None, &OwnRecord::None),
            Decision::Refused(Refusal::NotACommand)
        );
    }

    #[test]
    fn the_gate_refuses_an_object_this_device_does_not_own() {
        // The helper's card, the answer addressed to the opener: 9.2 forbids it.
        let card = object(ObjectType::Card, 4, ObjectState::Open);
        let (header, body) = answer_to(3);
        assert_eq!(
            gate(3, &header, &body, Some(&card), &OWN_CARD),
            Decision::Refused(Refusal::NotOwned)
        );
        // Addressed to the helper, which owns it.
        let (header, body) = answer_to(4);
        assert_eq!(
            gate(4, &header, &body, Some(&card), &OWN_CARD),
            Decision::Act(Command::Answer {
                action: AnswerAction::Answer,
                choices: vec!["yes".to_owned()],
            })
        );
        // Without the object's state before the envelope there is nothing to own.
        assert_eq!(
            gate(4, &header, &body, None, &OWN_CARD),
            Decision::Refused(Refusal::NotOwned)
        );
        // A bind that names another object than the header.
        let mut elsewhere = header.clone();
        if let Subject::Answer(fields) = &mut elsewhere.subject {
            fields.object_id = ObjectId::new([9; 16]);
        }
        assert_eq!(
            gate(4, &elsewhere, &body, Some(&card), &OWN_CARD),
            Decision::Refused(Refusal::BindMismatch)
        );
        // A body of another kind than the header.
        let (_, chat) = written(&Draft::session_chat(
            SessionId::new([2; 16]),
            device(4),
            b"{}",
        ));
        assert_eq!(
            gate(4, &header, &chat, Some(&card), &OWN_CARD),
            Decision::Refused(Refusal::BindMismatch)
        );
    }

    #[test]
    fn the_gate_holds_an_answer_against_the_state_before_it() {
        let (header, body) = answer_to(3);
        let with_state = |change: &dyn Fn(&mut Object)| {
            let mut card = object(ObjectType::Card, 3, ObjectState::Open);
            change(&mut card);
            gate(3, &header, &body, Some(&card), &OWN_CARD)
        };
        assert!(matches!(with_state(&|_| {}), Decision::Act(_)));
        for refused in [
            with_state(&|o| o.state = ObjectState::Answered),
            with_state(&|o| o.state = ObjectState::Closed),
            with_state(&|o| o.object_type = ObjectType::Artifact),
        ] {
            assert_eq!(refused, Decision::Refused(Refusal::NotOpen));
        }
        assert_eq!(
            with_state(&|o| o.current = Hash32::new([9; 32])),
            Decision::Refused(Refusal::VersionChanged)
        );
    }

    #[test]
    fn the_gate_holds_a_verdict_against_the_state_before_it() {
        let bind = VerdictBind {
            request_id: CARD,
            request_hash: VERSION,
            expires_at: EXPIRES_AT,
            verdict: Verdict::Allow,
        };
        let (header, body) = written(&Draft::verdict(bind, Urgency::High, device(3), b"{}"));
        let own = OwnRecord::Request {
            hash: VERSION,
            bind: RequestBind {
                request_id: CARD,
                expires_at: EXPIRES_AT,
            },
        };
        let with_state = |change: &dyn Fn(&mut Object)| {
            let mut request = object(ObjectType::Request, 3, ObjectState::Open);
            change(&mut request);
            gate(3, &header, &body, Some(&request), &own)
        };
        assert_eq!(
            with_state(&|_| {}),
            Decision::Act(Command::Verdict(Verdict::Allow))
        );
        assert_eq!(
            with_state(&|o| o.state = ObjectState::Closed),
            Decision::Refused(Refusal::NotPending)
        );
        assert_eq!(
            with_state(&|o| o.object_type = ObjectType::Card),
            Decision::Refused(Refusal::NotPending)
        );
        assert_eq!(
            with_state(&|o| o.current = Hash32::new([9; 32])),
            Decision::Refused(Refusal::RequestMismatch)
        );
    }

    #[test]
    fn the_gate_holds_a_take_back_against_the_state_before_it() {
        let bind = TakeBackBind {
            object_id: CARD,
            previous_hash: ANSWER,
            version_hash: VERSION,
        };
        let (header, body) = written(&Draft::take_back(bind, Urgency::Normal, device(3), b"{}"));
        let with_state = |change: &dyn Fn(&mut Object)| {
            let mut card = object(ObjectType::Card, 3, ObjectState::Answered);
            change(&mut card);
            gate(3, &header, &body, Some(&card), &OwnRecord::None)
        };
        assert_eq!(with_state(&|_| {}), Decision::Act(Command::TakeBack));
        for refused in [
            with_state(&|o| o.answer = Some(Hash32::new([9; 32]))),
            with_state(&|o| o.answer = None),
            with_state(&|o| o.state = ObjectState::Closed),
        ] {
            assert_eq!(refused, Decision::Refused(Refusal::NotTheAnswer));
        }
        assert_eq!(
            with_state(&|o| o.current = Hash32::new([9; 32])),
            Decision::Refused(Refusal::VersionChanged)
        );
        assert_eq!(
            with_state(&|o| o.object_type = ObjectType::Artifact),
            Decision::Refused(Refusal::VersionChanged)
        );
    }
}
