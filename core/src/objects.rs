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
    /// passes on when this device is no longer a leaf.
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
}

/// The objects of one group.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Objects {
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
        if self.objects.get(&transition.object_id) != transition.before.as_ref() {
            return Err(Error::Internal("a transition applied out of turn"));
        }
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
        let entries: Vec<ObjectEntry> = reader.vector()?;
        let mut versions = Reader::new(reader.opaque()?);
        reader.finish()?;
        let mut objects = Self::new();
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

/// The device that owns `object` in `epoch` of `group` (section 9.2): the writer of its newest version while it
/// is a leaf; after that the session's agent device, in a helper session its opener; nobody while that seat is
/// empty.
pub fn owner(
    facts: &dyn GroupFacts,
    group: &GroupId,
    epoch: u64,
    object: &Object,
) -> Result<Option<DeviceId>, Error> {
    if facts.leaf_role(group, epoch, &object.owner)?.is_some() {
        Ok(Some(object.owner))
    } else {
        facts.seat(group, epoch)
    }
}

/// A Chat message in a session group: from its agent or helper devices, or from a human device addressed to
/// the session's agent device (in a helper session: its opener).
fn chat_rule(facts: &dyn GroupFacts, header: &Header, role: Role) -> Result<(), Error> {
    allow(!header.group.is_room())?;
    if role == Role::Human {
        let seat = facts.seat(&header.group, header.epoch)?;
        allow(seat == Some(header.recipient))?;
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
    /// The answer's payload names no known `answer_action`, or its choices are not those of the bind.
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
    #[serde(default)]
    choices: Option<Vec<String>>,
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
    let header = opened.header;
    if owner(facts, &header.group, header.epoch, object)? != Some(*me) {
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
    hold(
        answer.choices.is_none_or(|named| named == choices),
        Refusal::BadAnswer,
    )?;
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
    } else if header.recipient != *me {
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
    use super::*;
    use crate::chain::testing::*;
    use crate::chain::{Mode, Outcome, Receipt, Served};
    use crate::envelope::testing::{device, payload, version_payload};
    use crate::envelope::{AnswerBind, Draft, TakeBackBind, Urgency, VerdictBind};
    use crate::ids::{BoardId, RegisterId, SessionId};
    use serde_json::json;

    fn first(object_type: ObjectType) -> Draft {
        Draft::first_version(
            object_type,
            Urgency::Normal,
            &version_payload(&Hash32::ZERO, json!({})),
        )
        .unwrap()
    }

    fn later(id: ObjectId, object_type: ObjectType, previous: Hash32, closed: bool) -> Draft {
        Draft::later_version(
            id,
            object_type,
            closed,
            Urgency::Normal,
            previous,
            &version_payload(&previous, json!({})),
        )
        .unwrap()
    }

    fn answer(id: ObjectId, version: Hash32, to: u8, closes: bool) -> Draft {
        let bind = AnswerBind {
            object_id: id,
            version_hash: version,
            choices: Vec::new(),
        };
        Draft::answer(
            bind,
            closes,
            Urgency::Normal,
            device(to),
            &serde_json::to_vec(&json!({ "answer_action": "answer" })).unwrap(),
        )
    }

    fn take_back(id: ObjectId, version: Hash32, answer: Hash32, to: u8) -> Draft {
        let bind = TakeBackBind {
            object_id: id,
            previous_hash: answer,
            version_hash: version,
        };
        Draft::take_back(bind, Urgency::Normal, device(to), b"{}")
    }

    fn verdict(id: ObjectId, request: Hash32, expires_at: u64, to: u8) -> Draft {
        let bind = VerdictBind {
            request_id: id,
            request_hash: request,
            expires_at,
            verdict: Verdict::Allow,
        };
        Draft::verdict(bind, Urgency::Normal, device(to), b"{}")
    }

    fn id_of(receipt: &Receipt) -> ObjectId {
        receipt.envelope.header.subject.object().unwrap().object_id
    }

    fn state(world: &World, group: &GroupId, id: &ObjectId) -> Object {
        world.objects(group).get(id).cloned().unwrap()
    }

    /// Whether the receiver forbids what device `n` signs.
    fn forbidden(world: &mut World, n: u8, group: GroupId, draft: &Draft) -> bool {
        match world.post(n, group, draft).outcome {
            Outcome::Refused(Error::Forbidden) => true,
            Outcome::Taken { .. } => false,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_card_goes_from_open_to_answered_and_back_and_closes() {
        let mut world = World::new();
        let v1 = world.post(3, session(), &first(ObjectType::Card));
        let id = id_of(&v1);
        assert_eq!(
            state(&world, &session(), &id),
            Object {
                object_type: ObjectType::Card,
                owner: device(3),
                state: ObjectState::Open,
                current: v1.hash,
                answer: None,
            }
        );
        // A later version by its owner becomes current.
        let v2 = world.post(3, session(), &later(id, ObjectType::Card, v1.hash, false));
        assert_eq!(state(&world, &session(), &id).current, v2.hash);
        // A human answers it: answered, the version stays current, the answer is in force.
        let a = world.post(2, session(), &answer(id, v2.hash, 3, false));
        let now = state(&world, &session(), &id);
        assert_eq!(
            (now.state, now.current, now.answer),
            (ObjectState::Answered, v2.hash, Some(a.hash))
        );
        // Taken back: open again.
        world.post(1, session(), &take_back(id, v2.hash, a.hash, 3));
        let now = state(&world, &session(), &id);
        assert_eq!((now.state, now.answer), (ObjectState::Open, None));
        // Answered again, this time closing it.
        let a2 = world.post(1, session(), &answer(id, v2.hash, 3, true));
        let now = state(&world, &session(), &id);
        assert_eq!(
            (now.state, now.answer),
            (ObjectState::Closed, Some(a2.hash))
        );
        // The owner reopens it with a new version.
        let v3 = world.post(3, session(), &later(id, ObjectType::Card, v2.hash, false));
        let now = state(&world, &session(), &id);
        assert_eq!(
            (now.state, now.current, now.answer),
            (ObjectState::Open, v3.hash, None)
        );
        // And closes it with another.
        world.post(3, session(), &later(id, ObjectType::Card, v3.hash, true));
        assert_eq!(state(&world, &session(), &id).state, ObjectState::Closed);
    }

    #[test]
    fn a_transition_carries_the_state_just_before() {
        let mut world = World::new();
        let v1 = world.post(3, session(), &first(ObjectType::Card));
        let id = id_of(&v1);
        let Outcome::Taken {
            transition: Some(created),
            ..
        } = &v1.outcome
        else {
            panic!("taken");
        };
        assert_eq!(created.before, None);
        let before = state(&world, &session(), &id);
        let a = world.post(2, session(), &answer(id, v1.hash, 3, false));
        let Outcome::Taken {
            transition: Some(answered),
            ..
        } = &a.outcome
        else {
            panic!("taken");
        };
        assert_eq!(answered.before.as_ref(), Some(&before));
        assert_eq!(answered.after, state(&world, &session(), &id));
        assert_eq!(answered.object_id, id);
    }

    #[test]
    fn a_permission_request_is_closed_by_its_verdict() {
        let mut world = World::new();
        let request = world.post(
            3,
            session(),
            &Draft::request(Urgency::High, NOW + 60_000, b"{}"),
        );
        let id = id_of(&request);
        let now = state(&world, &session(), &id);
        assert_eq!(
            (now.object_type, now.state, now.current, now.owner),
            (
                ObjectType::Request,
                ObjectState::Open,
                request.hash,
                device(3)
            )
        );
        // A verdict on another hash than the request, to another device than its owner, by the agent itself.
        let other = Hash32::new([9; 32]);
        assert!(forbidden(
            &mut world,
            2,
            session(),
            &verdict(id, other, NOW + 60_000, 3)
        ));
        assert!(forbidden(
            &mut world,
            2,
            session(),
            &verdict(id, request.hash, NOW + 60_000, 1)
        ));
        assert!(forbidden(
            &mut world,
            3,
            session(),
            &verdict(id, request.hash, NOW + 60_000, 3)
        ));
        assert!(!forbidden(
            &mut world,
            2,
            session(),
            &verdict(id, request.hash, NOW + 60_000, 3)
        ));
        assert_eq!(state(&world, &session(), &id).state, ObjectState::Closed);
        // A second verdict: the request is no longer open.
        assert!(forbidden(
            &mut world,
            1,
            session(),
            &verdict(id, request.hash, NOW + 60_000, 3)
        ));
        // A request has no later version, and nobody answers one.
        assert!(forbidden(
            &mut world,
            2,
            session(),
            &answer(id, request.hash, 3, false)
        ));
        // A human device makes no request; no request lives in the room group.
        assert!(forbidden(
            &mut world,
            2,
            session(),
            &Draft::request(Urgency::Low, 1, b"{}")
        ));
        assert!(forbidden(
            &mut world,
            2,
            room(),
            &Draft::request(Urgency::Low, 1, b"{}")
        ));
    }

    #[test]
    fn first_versions_are_created_only_by_those_who_may() {
        let mut world = World::new();
        // Cards and Artifacts: agent and helper devices, in a session group.
        for object_type in [ObjectType::Card, ObjectType::Artifact] {
            assert!(!forbidden(&mut world, 3, session(), &first(object_type)));
            assert!(!forbidden(
                &mut world,
                4,
                helper_session(),
                &first(object_type)
            ));
            assert!(!forbidden(
                &mut world,
                3,
                helper_session(),
                &first(object_type)
            ));
            assert!(forbidden(&mut world, 2, session(), &first(object_type)));
            assert!(forbidden(&mut world, 1, room(), &first(object_type)));
        }
        // Notes: human devices, in the room group.
        assert!(!forbidden(&mut world, 1, room(), &first(ObjectType::Note)));
        assert!(forbidden(
            &mut world,
            1,
            session(),
            &first(ObjectType::Note)
        ));
        assert!(forbidden(
            &mut world,
            3,
            session(),
            &first(ObjectType::Note)
        ));
        assert_eq!(world.objects(&session()).iter().count(), 2);
        assert_eq!(world.objects(&helper_session()).iter().count(), 4);
        assert_eq!(world.objects(&room()).iter().count(), 1);
    }

    /// The receiver's verdict on a header that no honest writer makes.
    fn forged(
        world: &mut World,
        n: u8,
        group: GroupId,
        draft: &Draft,
        change: impl FnOnce(&mut Header),
    ) -> Outcome {
        let envelope = world.forge(n, group, draft, change);
        world.take(&envelope).unwrap().outcome
    }

    fn object_mut(header: &mut Header) -> &mut ObjectFields {
        match &mut header.subject {
            Subject::Version(f)
            | Subject::Answer(f)
            | Subject::Request(f)
            | Subject::Verdict(f)
            | Subject::TakeBack(f) => f,
            other => panic!("{other:?}"),
        }
    }

    const REFUSED: Outcome = Outcome::Refused(Error::Forbidden);

    #[test]
    fn a_first_version_must_be_the_one_its_place_derives() {
        let mut world = World::new();
        let draft = first(ObjectType::Card);
        // Another object id than the one derived from group, sender and number.
        let outcome = forged(&mut world, 3, session(), &draft, |h| {
            object_mut(h).object_id = ObjectId::new([7; 16]);
        });
        assert_eq!(outcome, REFUSED);
        // Not open.
        for state in [ObjectState::Answered, ObjectState::Closed] {
            let outcome = forged(&mut world, 3, session(), &draft, |h| {
                object_mut(h).state = state;
            });
            assert_eq!(outcome, REFUSED);
        }
        // A request under the kind version, and a card under the kind request.
        let outcome = forged(&mut world, 3, session(), &draft, |h| {
            object_mut(h).object_type = ObjectType::Request;
        });
        assert_eq!(outcome, REFUSED);
        let request = Draft::request(Urgency::Low, 1, b"{}");
        let outcome = forged(&mut world, 3, session(), &request, |h| {
            object_mut(h).object_type = ObjectType::Card;
        });
        assert_eq!(outcome, REFUSED);
        // A request that names a predecessor.
        let outcome = forged(&mut world, 3, session(), &request, |h| {
            object_mut(h).object_ref = Hash32::new([1; 32]);
        });
        assert_eq!(outcome, REFUSED);
        assert_eq!(world.objects(&session()), Objects::new());
        // The honest one is taken.
        assert!(!forbidden(&mut world, 3, session(), &draft));
    }

    #[test]
    fn a_later_version_needs_the_current_version_and_the_owner() {
        let mut world = World::new();
        let v1 = world.post(3, session(), &first(ObjectType::Card));
        let id = id_of(&v1);
        let stale = Hash32::new([9; 32]);
        // An unknown object; a predecessor that is not current; a writer that does not own it.
        let unknown = ObjectId::new([7; 16]);
        assert!(forbidden(
            &mut world,
            3,
            session(),
            &later(unknown, ObjectType::Card, v1.hash, false)
        ));
        assert!(forbidden(
            &mut world,
            3,
            session(),
            &later(id, ObjectType::Card, stale, false)
        ));
        assert!(forbidden(
            &mut world,
            2,
            session(),
            &later(id, ObjectType::Card, v1.hash, false)
        ));
        // Another type than the first version fixed.
        assert!(forbidden(
            &mut world,
            3,
            session(),
            &later(id, ObjectType::Artifact, v1.hash, false)
        ));
        // A version cannot make its object answered.
        let draft = later(id, ObjectType::Card, v1.hash, false);
        let outcome = forged(&mut world, 3, session(), &draft, |h| {
            object_mut(h).state = ObjectState::Answered;
        });
        assert_eq!(outcome, REFUSED);
        assert_eq!(state(&world, &session(), &id).current, v1.hash);
        // In a helper session: the helper that made a card owns it, not the opener.
        let h1 = world.post(4, helper_session(), &first(ObjectType::Card));
        let helper_card = id_of(&h1);
        assert!(forbidden(
            &mut world,
            3,
            helper_session(),
            &later(helper_card, ObjectType::Card, h1.hash, false)
        ));
        assert!(!forbidden(
            &mut world,
            4,
            helper_session(),
            &later(helper_card, ObjectType::Card, h1.hash, false)
        ));
    }

    #[test]
    fn ownership_passes_to_the_seat_when_the_owner_has_left() {
        let mut world = World::new();
        let v1 = world.post(3, session(), &first(ObjectType::Card));
        let id = id_of(&v1);
        // A takeover: device 6 replaces device 3 as the session's agent.
        world.fake.commit(&session(), NOW, NOW, |leaves| {
            leaves.remove(&device(3));
            leaves.insert(device(6), Role::Agent);
        });
        let card = state(&world, &session(), &id);
        assert_eq!(
            owner(&world.fake, &session(), 0, &card).unwrap(),
            Some(device(3))
        );
        assert_eq!(
            owner(&world.fake, &session(), 1, &card).unwrap(),
            Some(device(6))
        );
        // An answer is now addressed to the new agent.
        assert!(forbidden(
            &mut world,
            2,
            session(),
            &answer(id, v1.hash, 3, false)
        ));
        assert!(!forbidden(
            &mut world,
            2,
            session(),
            &answer(id, v1.hash, 6, false)
        ));
        // The new agent writes the next version and is then the recorded owner.
        let v2 = world.post(6, session(), &later(id, ObjectType::Card, v1.hash, false));
        assert_eq!(state(&world, &session(), &id).owner, device(6));

        // In a helper session an object of a helper that left passes to the opener.
        let h1 = world.post(4, helper_session(), &first(ObjectType::Artifact));
        let artifact = id_of(&h1);
        world.fake.commit(&helper_session(), NOW, NOW, |leaves| {
            leaves.remove(&device(4));
            leaves.insert(device(7), Role::Helper);
        });
        assert!(forbidden(
            &mut world,
            7,
            helper_session(),
            &later(artifact, ObjectType::Artifact, h1.hash, false)
        ));
        assert!(!forbidden(
            &mut world,
            3,
            helper_session(),
            &later(artifact, ObjectType::Artifact, h1.hash, true)
        ));
        // While the seat is empty nobody owns it.
        world.fake.commit(&session(), NOW, NOW, |leaves| {
            leaves.remove(&device(6));
        });
        let card = state(&world, &session(), &id);
        assert_eq!(owner(&world.fake, &session(), 2, &card).unwrap(), None);
        assert!(forbidden(
            &mut world,
            2,
            session(),
            &answer(id, v2.hash, 6, false)
        ));
        assert!(forbidden(
            &mut world,
            2,
            session(),
            &answer(id, v2.hash, 0, false)
        ));
    }

    #[test]
    fn an_answer_needs_an_open_card_its_current_version_and_its_owner() {
        let mut world = World::new();
        let v1 = world.post(3, session(), &first(ObjectType::Card));
        let id = id_of(&v1);
        let v2 = world.post(3, session(), &later(id, ObjectType::Card, v1.hash, false));
        // The version before the current one; an unknown card; the agent answering itself; another recipient.
        assert!(forbidden(
            &mut world,
            2,
            session(),
            &answer(id, v1.hash, 3, false)
        ));
        assert!(forbidden(
            &mut world,
            2,
            session(),
            &answer(ObjectId::new([7; 16]), v2.hash, 3, false)
        ));
        assert!(forbidden(
            &mut world,
            3,
            session(),
            &answer(id, v2.hash, 3, false)
        ));
        assert!(forbidden(
            &mut world,
            2,
            session(),
            &answer(id, v2.hash, 1, false)
        ));
        // An answer that leaves the card open.
        let draft = answer(id, v2.hash, 3, false);
        let outcome = forged(&mut world, 2, session(), &draft, |h| {
            object_mut(h).state = ObjectState::Open;
            object_mut(h).answered_at = 0;
        });
        assert_eq!(outcome, REFUSED);
        // An answer that claims another type.
        let outcome = forged(&mut world, 2, session(), &draft, |h| {
            object_mut(h).object_type = ObjectType::Artifact;
        });
        assert_eq!(outcome, REFUSED);
        assert_eq!(state(&world, &session(), &id).state, ObjectState::Open);

        let a = world.post(2, session(), &answer(id, v2.hash, 3, false));
        // Answered: a second answer is refused; so are take backs of the wrong version or to the wrong owner.
        assert!(forbidden(
            &mut world,
            1,
            session(),
            &answer(id, v2.hash, 3, false)
        ));
        assert!(forbidden(
            &mut world,
            1,
            session(),
            &take_back(id, v1.hash, a.hash, 3)
        ));
        assert!(forbidden(
            &mut world,
            1,
            session(),
            &take_back(id, v2.hash, a.hash, 2)
        ));
        assert!(forbidden(
            &mut world,
            3,
            session(),
            &take_back(id, v2.hash, a.hash, 3)
        ));
        assert!(!forbidden(
            &mut world,
            1,
            session(),
            &take_back(id, v2.hash, a.hash, 3)
        ));
        // Open again: nothing to take back.
        assert!(forbidden(
            &mut world,
            1,
            session(),
            &take_back(id, v2.hash, a.hash, 3)
        ));
        // An Artifact is not answered.
        let artifact = world.post(3, session(), &first(ObjectType::Artifact));
        let draft = answer(id_of(&artifact), artifact.hash, 3, false);
        assert!(forbidden(&mut world, 2, session(), &draft));
    }

    #[test]
    fn any_human_device_writes_a_note_version_on_any_other() {
        let mut world = World::new();
        let v1 = world.post(1, room(), &first(ObjectType::Note));
        let id = id_of(&v1);
        // Two devices write on version 1 without knowing of each other; a third version follows the first of
        // those.
        let v2 = world.post(2, room(), &later(id, ObjectType::Note, v1.hash, false));
        let v3 = world.post(1, room(), &later(id, ObjectType::Note, v1.hash, false));
        let v4 = world.post(2, room(), &later(id, ObjectType::Note, v2.hash, true));
        let note = state(&world, &room(), &id);
        for version in [&v1, &v2, &v3, &v4] {
            assert!(world.objects(&room()).is_note_version(&id, &version.hash));
        }
        assert!(!world
            .objects(&room())
            .is_note_version(&id, &Hash32::new([9; 32])));
        assert_eq!((note.current, note.state), (v4.hash, ObjectState::Closed));
        // A version on something that is no version of this Note.
        assert!(forbidden(
            &mut world,
            1,
            room(),
            &later(id, ObjectType::Note, Hash32::new([9; 32]), false)
        ));
        // Nobody answers a Note.
        assert!(forbidden(
            &mut world,
            1,
            room(),
            &answer(id, v4.hash, 1, false)
        ));
    }

    #[test]
    fn chat_is_written_by_the_sessions_devices_and_by_humans_to_its_seat() {
        let mut world = World::new();
        let chat = |session, to: Option<u8>| {
            Draft::session_chat(session, to.map_or(DeviceId::ZERO, device), &payload("x"))
        };
        // The agent, to anyone or no one.
        assert!(!forbidden(&mut world, 3, session(), &chat(SESSION, None)));
        assert!(!forbidden(
            &mut world,
            3,
            session(),
            &chat(SESSION, Some(1))
        ));
        // A human device: only addressed to the session's agent device.
        assert!(!forbidden(
            &mut world,
            2,
            session(),
            &chat(SESSION, Some(3))
        ));
        assert!(forbidden(&mut world, 2, session(), &chat(SESSION, None)));
        assert!(forbidden(&mut world, 2, session(), &chat(SESSION, Some(1))));
        // The timeline of another session than the group's.
        assert!(forbidden(
            &mut world,
            3,
            session(),
            &chat(HELPER_SESSION, None)
        ));
        assert!(forbidden(
            &mut world,
            2,
            session(),
            &chat(SessionId::new([9; 16]), Some(3))
        ));
        // A helper session: its opener and helpers write; a human addresses the opener, not a helper.
        assert!(!forbidden(
            &mut world,
            4,
            helper_session(),
            &chat(HELPER_SESSION, None)
        ));
        assert!(!forbidden(
            &mut world,
            3,
            helper_session(),
            &chat(HELPER_SESSION, None)
        ));
        assert!(!forbidden(
            &mut world,
            1,
            helper_session(),
            &chat(HELPER_SESSION, Some(3))
        ));
        assert!(forbidden(
            &mut world,
            1,
            helper_session(),
            &chat(HELPER_SESSION, Some(4))
        ));
        // No Chat in the room group.
        let mut in_room = World::new();
        in_room.fake.group(&room()).epochs[0]
            .leaves
            .insert(device(3), Role::Agent);
        assert!(forbidden(&mut in_room, 1, room(), &chat(SESSION, Some(3))));
        // While the session waits for a takeover a human device has nobody to address.
        world.fake.commit(&session(), NOW, NOW, |leaves| {
            leaves.remove(&device(3));
        });
        assert!(forbidden(&mut world, 2, session(), &chat(SESSION, Some(3))));
        assert!(forbidden(&mut world, 2, session(), &chat(SESSION, None)));
    }

    #[test]
    fn a_cards_chat_follows_its_session_and_needs_the_card() {
        let mut world = World::new();
        let card = world.post(3, session(), &first(ObjectType::Card));
        let artifact = world.post(3, session(), &first(ObjectType::Artifact));
        let on = |id: ObjectId, to: Option<u8>| {
            Draft::card_chat(id, to.map_or(DeviceId::ZERO, device), &payload("x"))
        };
        assert!(!forbidden(
            &mut world,
            3,
            session(),
            &on(id_of(&card), None)
        ));
        assert!(!forbidden(
            &mut world,
            2,
            session(),
            &on(id_of(&card), Some(3))
        ));
        assert!(forbidden(
            &mut world,
            2,
            session(),
            &on(id_of(&card), Some(1))
        ));
        // An unknown object, an Artifact, a card of another group.
        assert!(forbidden(
            &mut world,
            3,
            session(),
            &on(ObjectId::new([7; 16]), None)
        ));
        assert!(forbidden(
            &mut world,
            3,
            session(),
            &on(id_of(&artifact), None)
        ));
        assert!(forbidden(
            &mut world,
            3,
            helper_session(),
            &on(id_of(&card), None)
        ));
    }

    #[test]
    fn board_items_and_room_registers_are_the_humans() {
        let mut world = World::new();
        let stroke = Draft::board_item(BoardId::ALL_DESKS, &payload("x"));
        let register = Draft::register(RegisterId::new([5; 16]), &payload("x"));
        assert!(!forbidden(&mut world, 1, room(), &stroke));
        assert!(!forbidden(&mut world, 2, room(), &register));
        // A board lives in the room group only.
        assert!(forbidden(&mut world, 1, session(), &stroke));
        assert!(forbidden(&mut world, 3, session(), &stroke));
        // In a session group any leaf writes registers.
        for n in [1, 3] {
            assert!(!forbidden(&mut world, n, session(), &register));
        }
        assert!(!forbidden(&mut world, 4, helper_session(), &register));
        // A device that is no human device, were it a leaf of the room group, writes neither.
        world.fake.group(&room()).epochs[0]
            .leaves
            .insert(device(3), Role::Agent);
        assert!(forbidden(&mut world, 3, room(), &stroke));
        assert!(forbidden(&mut world, 3, room(), &register));
    }

    #[test]
    fn the_push_flag_counts_on_card_versions_and_requests_of_the_sessions_devices() {
        let mut world = World::new();
        let honoured = |world: &mut World, n: u8, group: GroupId, draft: Draft| {
            let sealed = world.sign(n, group, &draft.with_push());
            push_honoured(&world.fake, &sealed.envelope.header).unwrap()
        };
        assert!(honoured(&mut world, 3, session(), first(ObjectType::Card)));
        assert!(honoured(
            &mut world,
            4,
            helper_session(),
            first(ObjectType::Card)
        ));
        assert!(honoured(
            &mut world,
            3,
            session(),
            Draft::request(Urgency::Low, 1, b"{}")
        ));
        // Not on an Artifact, a Chat message, a Note, a register; not from a human device.
        assert!(!honoured(
            &mut world,
            3,
            session(),
            first(ObjectType::Artifact)
        ));
        assert!(!honoured(
            &mut world,
            3,
            session(),
            Draft::session_chat(SESSION, DeviceId::ZERO, b"{}")
        ));
        assert!(!honoured(&mut world, 1, room(), first(ObjectType::Note)));
        assert!(!honoured(&mut world, 2, session(), first(ObjectType::Card)));
        assert!(!honoured(
            &mut world,
            2,
            session(),
            answer(ObjectId::new([1; 16]), Hash32::new([1; 32]), 3, false)
        ));
        // Not without the flag.
        let sealed = world.sign(3, session(), &first(ObjectType::Card));
        assert!(!push_honoured(&world.fake, &sealed.envelope.header).unwrap());
    }

    #[test]
    fn replay_from_headers_gives_the_same_state_and_skips_what_is_cut() {
        let mut world = World::new();
        let mut log: Vec<(Header, Hash32)> = Vec::new();
        let mut post = |world: &mut World, n: u8, draft: &Draft| {
            let receipt = world.post(n, session(), draft);
            log.push((receipt.envelope.header.clone(), receipt.hash));
            receipt
        };
        let v1 = post(&mut world, 3, &first(ObjectType::Card));
        let id = id_of(&v1);
        let a = post(&mut world, 2, &answer(id, v1.hash, 3, false));
        post(
            &mut world,
            3,
            &Draft::session_chat(SESSION, DeviceId::ZERO, b"{}"),
        );
        post(&mut world, 2, &first(ObjectType::Card));
        let request = post(&mut world, 3, &Draft::request(Urgency::Low, 1, b"{}"));
        post(&mut world, 1, &verdict(id_of(&request), request.hash, 1, 3));

        let replayed = replay(&world.fake, log.iter().map(|(h, hash)| (h, hash))).unwrap();
        assert_eq!(replayed, world.objects(&session()));
        assert_eq!(replayed.get(&id).unwrap().state, ObjectState::Answered);

        // Device 2 is removed and the remover had accepted nothing of it: its answer never came.
        let without: Vec<_> = log.iter().filter(|(h, _)| h.sender != device(2)).collect();
        let replayed = replay(&world.fake, without.iter().map(|(h, hash)| (h, hash))).unwrap();
        let card = replayed.get(&id).unwrap();
        assert_eq!((card.state, card.answer), (ObjectState::Open, None));
        assert_ne!(Some(a.hash), card.answer);

        // The stored form.
        let bytes = replayed.to_bytes().unwrap();
        assert_eq!(Objects::from_bytes(&bytes).unwrap(), replayed);
        for len in 0..bytes.len() {
            assert!(matches!(
                Objects::from_bytes(&bytes[..len]),
                Err(Error::Storage(_))
            ));
        }
        let mut damaged = bytes.clone();
        // The first entry's type byte: its id is 16 bytes behind the two-byte length.
        damaged[18] = 9;
        assert!(matches!(
            Objects::from_bytes(&damaged),
            Err(Error::Storage(_))
        ));
        let note_world = {
            let mut w = World::new();
            let v1 = w.post(1, room(), &first(ObjectType::Note));
            w.post(
                2,
                room(),
                &later(id_of(&v1), ObjectType::Note, v1.hash, false),
            );
            w
        };
        let notes = note_world.objects(&room());
        assert_eq!(
            Objects::from_bytes(&notes.to_bytes().unwrap()).unwrap(),
            notes
        );
    }

    #[test]
    fn a_pruned_envelope_counts_for_the_state() {
        let mut world = World::new();
        let v1 = world.sign(3, session(), &first(ObjectType::Card));
        let receipt = world
            .take_as(
                &v1.envelope.prune().unwrap().encode().unwrap(),
                &Served::Stored,
                Mode::ReadingBack,
            )
            .unwrap();
        assert_eq!(state(&world, &session(), &id_of(&receipt)).current, v1.hash);
    }

    // The command gate.

    struct Desk {
        world: World,
        log: GateLog,
        card: ObjectId,
        version: Hash32,
        card_payload: Vec<u8>,
    }

    /// The agent (device 3) is the receiver and has made a card with two options.
    fn desk(card_extra: serde_json::Value) -> Desk {
        let mut world = World::new();
        world.me = device(3);
        let card_payload = version_payload(&Hash32::ZERO, card_extra);
        let draft = Draft::first_version(ObjectType::Card, Urgency::Normal, &card_payload).unwrap();
        let v1 = world.post(3, session(), &draft);
        Desk {
            card: id_of(&v1),
            version: v1.hash,
            world,
            log: GateLog::new(),
            card_payload,
        }
    }

    fn two_options() -> serde_json::Value {
        json!({ "options": [{ "key": "yes", "label": "Yes" }, { "key": "no", "label": "No" }] })
    }

    impl Desk {
        fn answer_draft(&self, action: &str, choices: &[&str]) -> Draft {
            let bind = AnswerBind {
                object_id: self.card,
                version_hash: self.version,
                choices: choices.iter().map(|c| c.as_bytes().to_vec()).collect(),
            };
            let payload = serde_json::to_vec(&json!({ "answer_action": action })).unwrap();
            Draft::answer(bind, false, Urgency::Normal, device(3), &payload)
        }

        fn record(&self) -> OwnRecord<'_> {
            OwnRecord::CardVersion {
                hash: self.version,
                payload: &self.card_payload,
            }
        }

        fn gate(&mut self, receipt: &Receipt, own: &OwnRecord<'_>) -> Decision {
            command_gate(
                &self.world.fake,
                &mut self.log,
                &device(3),
                &receipt.opened().unwrap(),
                own,
                self.world.now,
            )
            .unwrap()
        }

        /// A human's answer, through the chain and the gate.
        fn answer(&mut self, action: &str, choices: &[&str]) -> Decision {
            let draft = self.answer_draft(action, choices);
            let receipt = self.world.post(2, session(), &draft);
            let payload = self.card_payload.clone();
            let own = OwnRecord::CardVersion {
                hash: self.version,
                payload: &payload,
            };
            self.gate(&receipt, &own)
        }
    }

    fn act_answer(action: AnswerAction, choices: &[&str]) -> Decision {
        Decision::Act(Command::Answer {
            action,
            choices: choices.iter().map(|c| c.to_string()).collect(),
        })
    }

    #[test]
    fn the_gate_lets_a_valid_answer_through_once() {
        let mut desk = desk(two_options());
        let draft = desk.answer_draft("answer", &["yes"]);
        let receipt = desk.world.post(2, session(), &draft);
        let payload = desk.card_payload.clone();
        let own = OwnRecord::CardVersion {
            hash: desk.version,
            payload: &payload,
        };
        assert_eq!(
            desk.gate(&receipt, &own),
            act_answer(AnswerAction::Answer, &["yes"])
        );
        // Recorded before acting: after a crash the same envelope is not acted on again.
        let stored = GateLog::from_bytes(&desk.log.to_bytes().unwrap()).unwrap();
        assert_eq!(stored, desk.log);
        assert_eq!(desk.gate(&receipt, &own), Decision::Uncertain);
        desk.log.finish(&receipt.hash).unwrap();
        assert_eq!(desk.gate(&receipt, &own), Decision::Done);
        assert_eq!(
            GateLog::from_bytes(&desk.log.to_bytes().unwrap()).unwrap(),
            desk.log
        );
        assert_eq!(desk.log.finish(&Hash32::new([9; 32])), Err(Error::NotFound));
        assert!(matches!(GateLog::from_bytes(&[1]), Err(Error::Storage(_))));
        let mut bad = desk.log.to_bytes().unwrap();
        *bad.last_mut().unwrap() = 2;
        assert!(matches!(GateLog::from_bytes(&bad), Err(Error::Storage(_))));
    }

    #[test]
    fn the_gate_holds_the_choices_to_the_card_version() {
        let refused = Decision::Refused(Refusal::BadChoice);
        // A card with options and a single choice.
        assert_eq!(
            desk(two_options()).answer("answer", &["no"]),
            act_answer(AnswerAction::Answer, &["no"])
        );
        assert_eq!(desk(two_options()).answer("answer", &[]), refused);
        assert_eq!(desk(two_options()).answer("answer", &["maybe"]), refused);
        assert_eq!(
            desk(two_options()).answer("answer", &["yes", "no"]),
            refused
        );
        assert_eq!(
            desk(two_options()).answer("answer", &["yes", "yes"]),
            refused
        );
        // Several only with `allows_multiple`, and still distinct options of the version.
        let mut multiple = two_options();
        multiple["allows_multiple"] = json!(true);
        assert_eq!(
            desk(multiple.clone()).answer("answer", &["yes", "no"]),
            act_answer(AnswerAction::Answer, &["yes", "no"])
        );
        assert_eq!(
            desk(multiple.clone()).answer("answer", &["yes", "yes"]),
            refused
        );
        assert_eq!(
            desk(multiple.clone()).answer("answer", &["yes", "maybe"]),
            refused
        );
        assert_eq!(desk(multiple).answer("answer", &[]), refused);
        // A card without options takes an answer without choices, and none with.
        for card in [
            json!({}),
            json!({ "options": [] }),
            json!({ "options": null }),
        ] {
            assert_eq!(
                desk(card.clone()).answer("answer", &[]),
                act_answer(AnswerAction::Answer, &[])
            );
            assert_eq!(desk(card).answer("answer", &["yes"]), refused);
        }
        // `read` and `shred` carry none.
        assert_eq!(
            desk(two_options()).answer("read", &[]),
            act_answer(AnswerAction::Read, &[])
        );
        assert_eq!(
            desk(two_options()).answer("shred", &[]),
            act_answer(AnswerAction::Shred, &[])
        );
        assert_eq!(desk(two_options()).answer("read", &["yes"]), refused);
        assert_eq!(desk(two_options()).answer("shred", &["no"]), refused);
    }

    #[test]
    fn the_gate_reads_the_answers_payload_strictly() {
        let mut desk = desk(two_options());
        let mut with_payload = |payload: &[u8], choices: &[&str]| {
            let bind = AnswerBind {
                object_id: desk.card,
                version_hash: desk.version,
                choices: choices.iter().map(|c| c.as_bytes().to_vec()).collect(),
            };
            let draft = Draft::answer(bind, false, Urgency::Normal, device(3), payload);
            let receipt = desk.world.post(2, session(), &draft);
            let card = desk.card_payload.clone();
            let own = OwnRecord::CardVersion {
                hash: desk.version,
                payload: &card,
            };
            let decision = desk.gate(&receipt, &own);
            // The card is open again for the next case.
            let a = receipt.hash;
            let back = take_back(desk.card, desk.version, a, 3);
            desk.world.post(1, session(), &back);
            decision
        };
        let refused = Decision::Refused(Refusal::BadAnswer);
        assert_eq!(with_payload(b"{}", &["yes"]), refused);
        assert_eq!(
            with_payload(br#"{"answer_action":"approve"}"#, &["yes"]),
            refused
        );
        assert_eq!(with_payload(br#"{"answer_action":7}"#, &["yes"]), refused);
        // What the envelope itself refuses never reaches the gate: a key twice, choices that are not the
        // bind's.
        for payload in [
            &br#"{"answer_action":"answer","answer_action":"read"}"#[..],
            br#"{"answer_action":"answer","choices":["no"]}"#,
            br#"{"answer_action":"answer","choices":"yes"}"#,
        ] {
            let bind = AnswerBind {
                object_id: ObjectId::new([1; 16]),
                version_hash: Hash32::new([1; 32]),
                choices: vec![b"yes".to_vec()],
            };
            let draft = Draft::answer(bind, false, Urgency::Normal, device(3), payload);
            let slot = crate::chain::OwnChain::new()
                .slot(session(), 0, device(2), NOW)
                .unwrap();
            let sealed = crate::envelope::seal(
                &draft,
                &slot,
                &crate::envelope::testing::key(0),
                &crate::envelope::testing::signer(2),
                &mut crate::envelope::testing::TestEntropy(1),
            );
            assert_eq!(sealed.err(), Some(Error::BadFormat));
        }
        // The same choices, and fields the gate does not know.
        assert_eq!(
            with_payload(
                br#"{"answer_action":"answer","choices":["yes"],"note":"ok","trusted":true}"#,
                &["yes"]
            ),
            act_answer(AnswerAction::Answer, &["yes"])
        );
    }

    #[test]
    fn the_gate_refuses_a_sender_that_is_not_human_now() {
        let mut desk = desk(two_options());
        let draft = desk.answer_draft("answer", &["yes"]);
        let receipt = desk.world.post(2, session(), &draft);
        // Device 2 was a human device when it signed, and has been removed from the room since.
        desk.world.fake.humans_now.remove(&device(2));
        let own = desk.record();
        let decision = command_gate(
            &desk.world.fake,
            &mut GateLog::new(),
            &device(3),
            &receipt.opened().unwrap(),
            &own,
            NOW,
        )
        .unwrap();
        assert_eq!(decision, Decision::Refused(Refusal::NotHuman));
        // The agent's own Chat message is no command to a helper.
        let mut world = World::new();
        world.me = device(4);
        let chat = Draft::session_chat(HELPER_SESSION, device(4), &payload("do this"));
        let receipt = world.post(3, helper_session(), &chat);
        let decision = command_gate(
            &world.fake,
            &mut GateLog::new(),
            &device(4),
            &receipt.opened().unwrap(),
            &OwnRecord::None,
            NOW,
        )
        .unwrap();
        assert_eq!(decision, Decision::Refused(Refusal::NotHuman));
    }

    #[test]
    fn the_gate_takes_chat_addressed_to_this_device_only() {
        let mut world = World::new();
        world.me = device(3);
        let mut log = GateLog::new();
        let mut gate = |world: &World, receipt: &Receipt, me: u8| {
            command_gate(
                &world.fake,
                &mut log,
                &device(me),
                &receipt.opened().unwrap(),
                &OwnRecord::None,
                world.now,
            )
            .unwrap()
        };
        let receipt = world.post(
            2,
            session(),
            &Draft::session_chat(SESSION, device(3), &payload("go")),
        );
        // Another device of the group reads it and does not act.
        assert_eq!(
            gate(&world, &receipt, 4),
            Decision::Refused(Refusal::NotAddressed)
        );
        assert_eq!(gate(&world, &receipt, 3), Decision::Act(Command::Chat));
        assert_eq!(gate(&world, &receipt, 3), Decision::Uncertain);
        // A card's Chat is a Chat too.
        let card = world.post(3, session(), &first(ObjectType::Card));
        let receipt = world.post(
            1,
            session(),
            &Draft::card_chat(id_of(&card), device(3), &payload("why?")),
        );
        assert_eq!(gate(&world, &receipt, 3), Decision::Act(Command::Chat));
        // A register, a human's Note or a board item is no command, whoever it names.
        let receipt = world.post(
            2,
            session(),
            &Draft::register(RegisterId::new([1; 16]), b"{}"),
        );
        assert_eq!(
            gate(&world, &receipt, 3),
            Decision::Refused(Refusal::NotAddressed)
        );
        let outcome = forged(
            &mut world,
            2,
            session(),
            &Draft::register(RegisterId::new([1; 16]), b"{}"),
            |h| h.recipient = device(3),
        );
        // Sealed under the header before the change: the body does not open, so nothing reaches the gate.
        assert!(matches!(
            outcome,
            Outcome::Taken {
                body: Err(Error::DecryptFailed),
                ..
            }
        ));
    }

    #[test]
    fn the_gate_refuses_a_kind_that_is_no_command() {
        // A register that names the agent as its recipient.
        let mut world = World::new();
        world.me = device(3);
        let receipt = world.post(
            2,
            session(),
            &Draft::register(RegisterId::new([1; 16]), b"{}"),
        );
        let mut opened = receipt.opened().unwrap();
        let mut header = opened.header.clone();
        header.recipient = device(3);
        opened.header = &header;
        let decision = command_gate(
            &world.fake,
            &mut GateLog::new(),
            &device(3),
            &opened,
            &OwnRecord::None,
            NOW,
        )
        .unwrap();
        assert_eq!(decision, Decision::Refused(Refusal::NotACommand));
    }

    #[test]
    fn the_gate_refuses_an_old_epoch() {
        let mut desk = desk(two_options());
        let draft = desk.answer_draft("answer", &["yes"]);
        let sealed = desk.world.sign(2, session(), &draft);
        // The Commit comes; the answer of the epoch before arrives within the two minutes and is taken.
        desk.world.fake.commit(&session(), NOW, NOW, |_| {});
        desk.world.now = NOW + LIVE_GRACE_MS;
        let receipt = desk.world.take(&sealed.envelope).unwrap();
        let own = desk.record();
        let gate = |desk: &Desk, now: u64| {
            command_gate(
                &desk.world.fake,
                &mut GateLog::new(),
                &device(3),
                &receipt.opened().unwrap(),
                &own,
                now,
            )
            .unwrap()
        };
        assert_eq!(
            gate(&desk, NOW + LIVE_GRACE_MS),
            act_answer(AnswerAction::Answer, &["yes"])
        );
        // The agent gets to it later than two minutes after the Commit.
        assert_eq!(
            gate(&desk, NOW + LIVE_GRACE_MS + 1),
            Decision::Refused(Refusal::OldEpoch)
        );
        // Two epochs back, however fast.
        let mut later = desk.world.fake.clone();
        later.commit(&session(), NOW, NOW, |_| {});
        let decision = command_gate(
            &later,
            &mut GateLog::new(),
            &device(3),
            &receipt.opened().unwrap(),
            &own,
            NOW,
        )
        .unwrap();
        assert_eq!(decision, Decision::Refused(Refusal::OldEpoch));
    }

    #[test]
    fn the_gate_refuses_an_object_this_device_does_not_own() {
        // The helper's card in the helper session: the opener reads the answer and does not own the card.
        let mut world = World::new();
        world.me = device(3);
        let card_payload = version_payload(&Hash32::ZERO, two_options());
        let draft = Draft::first_version(ObjectType::Card, Urgency::Normal, &card_payload).unwrap();
        let v1 = world.post(4, helper_session(), &draft);
        let bind = AnswerBind {
            object_id: id_of(&v1),
            version_hash: v1.hash,
            choices: vec![b"yes".to_vec()],
        };
        // Addressed to the opener although the helper owns the card: 9.2 forbids it, so no envelope of this
        // shape reaches the gate through the chain. The gate still holds the rule on its own.
        let answer = Draft::answer(
            bind.clone(),
            false,
            Urgency::Normal,
            device(4),
            br#"{"answer_action":"answer"}"#,
        );
        let receipt = world.post(2, helper_session(), &answer);
        let mut opened = receipt.opened().unwrap();
        let mut header = opened.header.clone();
        header.recipient = device(3);
        opened.header = &header;
        let own = OwnRecord::CardVersion {
            hash: v1.hash,
            payload: &card_payload,
        };
        let gate = |opened: &Opened<'_>, me: u8| {
            command_gate(
                &world.fake,
                &mut GateLog::new(),
                &device(me),
                opened,
                &own,
                NOW,
            )
            .unwrap()
        };
        assert_eq!(gate(&opened, 3), Decision::Refused(Refusal::NotOwned));
        // The helper, which owns it, acts.
        assert_eq!(
            gate(&receipt.opened().unwrap(), 4),
            act_answer(AnswerAction::Answer, &["yes"])
        );
        // Without the object's state before the envelope there is nothing to own.
        let mut opened = receipt.opened().unwrap();
        opened.before = None;
        assert_eq!(gate(&opened, 4), Decision::Refused(Refusal::NotOwned));
        // A bind that names another object than the header.
        let mut opened = receipt.opened().unwrap();
        let mut header = opened.header.clone();
        object_mut(&mut header).object_id = ObjectId::new([9; 16]);
        opened.header = &header;
        assert_eq!(gate(&opened, 4), Decision::Refused(Refusal::BindMismatch));
    }

    #[test]
    fn the_gate_holds_an_answer_against_the_state_before_it() {
        let mut desk = desk(two_options());
        let draft = desk.answer_draft("answer", &["yes"]);
        let receipt = desk.world.post(2, session(), &draft);
        let own = desk.record();
        let gate = |opened: &Opened<'_>, own: &OwnRecord<'_>| {
            command_gate(
                &desk.world.fake,
                &mut GateLog::new(),
                &device(3),
                opened,
                own,
                NOW,
            )
            .unwrap()
        };
        let before = receipt.opened().unwrap().before.unwrap().clone();
        let with_state = |change: &dyn Fn(&mut Object)| {
            let mut object = before.clone();
            change(&mut object);
            let mut opened = receipt.opened().unwrap();
            opened.before = Some(&object);
            gate(&opened, &own)
        };
        assert_eq!(
            with_state(&|_| {}),
            act_answer(AnswerAction::Answer, &["yes"])
        );
        // Not open; not a card; another current version.
        assert_eq!(
            with_state(&|o| o.state = ObjectState::Answered),
            Decision::Refused(Refusal::NotOpen)
        );
        assert_eq!(
            with_state(&|o| o.state = ObjectState::Closed),
            Decision::Refused(Refusal::NotOpen)
        );
        assert_eq!(
            with_state(&|o| o.object_type = ObjectType::Artifact),
            Decision::Refused(Refusal::NotOpen)
        );
        assert_eq!(
            with_state(&|o| o.current = Hash32::new([9; 32])),
            Decision::Refused(Refusal::VersionChanged)
        );
        // The device's record is of another version, of another kind, missing, or not a card body.
        let opened = receipt.opened().unwrap();
        let other = OwnRecord::CardVersion {
            hash: Hash32::new([9; 32]),
            payload: &desk.card_payload,
        };
        assert_eq!(gate(&opened, &other), Decision::Refused(Refusal::NoRecord));
        assert_eq!(
            gate(&opened, &OwnRecord::None),
            Decision::Refused(Refusal::NoRecord)
        );
        let request = OwnRecord::Request {
            hash: desk.version,
            bind: RequestBind {
                request_id: desk.card,
                expires_at: 0,
            },
        };
        assert_eq!(
            gate(&opened, &request),
            Decision::Refused(Refusal::NoRecord)
        );
        for payload in [
            &b"[]"[..],
            br#"{"options":"yes"}"#,
            br#"{"options":[{"label":"x"}]}"#,
        ] {
            let damaged = OwnRecord::CardVersion {
                hash: desk.version,
                payload,
            };
            assert_eq!(
                gate(&opened, &damaged),
                Decision::Refused(Refusal::NoRecord)
            );
        }
    }

    #[test]
    fn the_gate_holds_a_verdict_against_the_request() {
        let mut world = World::new();
        world.me = device(3);
        let expires_at = NOW + 60_000;
        let request = world.post(
            3,
            session(),
            &Draft::request(Urgency::High, expires_at, b"{}"),
        );
        let id = id_of(&request);
        let own = OwnRecord::Request {
            hash: request.hash,
            bind: RequestBind {
                request_id: id,
                expires_at,
            },
        };
        let receipt = world.post(2, session(), &verdict(id, request.hash, expires_at, 3));
        let gate = |opened: &Opened<'_>, own: &OwnRecord<'_>, now: u64| {
            command_gate(
                &world.fake,
                &mut GateLog::new(),
                &device(3),
                opened,
                own,
                now,
            )
            .unwrap()
        };
        let opened = receipt.opened().unwrap();
        assert_eq!(
            gate(&opened, &own, NOW),
            Decision::Act(Command::Verdict(Verdict::Allow))
        );
        // The clock: before `expires_at`, not at it.
        assert_eq!(
            gate(&opened, &own, expires_at - 1),
            Decision::Act(Command::Verdict(Verdict::Allow))
        );
        assert_eq!(
            gate(&opened, &own, expires_at),
            Decision::Refused(Refusal::Expired)
        );
        // The device's record: missing, of another request, with another expiry.
        assert_eq!(
            gate(&opened, &OwnRecord::None, NOW),
            Decision::Refused(Refusal::NoRecord)
        );
        let other = OwnRecord::Request {
            hash: Hash32::new([9; 32]),
            bind: RequestBind {
                request_id: id,
                expires_at,
            },
        };
        assert_eq!(
            gate(&opened, &other, NOW),
            Decision::Refused(Refusal::NoRecord)
        );
        let longer = OwnRecord::Request {
            hash: request.hash,
            bind: RequestBind {
                request_id: id,
                expires_at: expires_at + 1,
            },
        };
        assert_eq!(
            gate(&opened, &longer, NOW),
            Decision::Refused(Refusal::RequestMismatch)
        );
        let other_id = OwnRecord::Request {
            hash: request.hash,
            bind: RequestBind {
                request_id: ObjectId::new([9; 16]),
                expires_at,
            },
        };
        assert_eq!(
            gate(&opened, &other_id, NOW),
            Decision::Refused(Refusal::RequestMismatch)
        );
        // The state before: no longer pending, or another request hash.
        let before = opened.before.unwrap().clone();
        let mut closed = before.clone();
        closed.state = ObjectState::Closed;
        let mut changed = receipt.opened().unwrap();
        changed.before = Some(&closed);
        assert_eq!(
            gate(&changed, &own, NOW),
            Decision::Refused(Refusal::NotPending)
        );
        let mut moved = before.clone();
        moved.current = Hash32::new([9; 32]);
        let mut changed = receipt.opened().unwrap();
        changed.before = Some(&moved);
        assert_eq!(
            gate(&changed, &own, NOW),
            Decision::Refused(Refusal::RequestMismatch)
        );
        // A deny is a command too.
        let mut world = World::new();
        let request = world.post(
            3,
            session(),
            &Draft::request(Urgency::High, expires_at, b"{}"),
        );
        let id = id_of(&request);
        let bind = VerdictBind {
            request_id: id,
            request_hash: request.hash,
            expires_at,
            verdict: Verdict::Deny,
        };
        let receipt = world.post(
            1,
            session(),
            &Draft::verdict(bind, Urgency::High, device(3), b"{}"),
        );
        let own = OwnRecord::Request {
            hash: request.hash,
            bind: RequestBind {
                request_id: id,
                expires_at,
            },
        };
        let decision = command_gate(
            &world.fake,
            &mut GateLog::new(),
            &device(3),
            &receipt.opened().unwrap(),
            &own,
            NOW,
        )
        .unwrap();
        assert_eq!(decision, Decision::Act(Command::Verdict(Verdict::Deny)));
    }

    #[test]
    fn the_gate_holds_a_take_back_against_the_answer_in_force() {
        let mut desk = desk(two_options());
        let draft = desk.answer_draft("answer", &["yes"]);
        let a = desk.world.post(2, session(), &draft);
        let back = take_back(desk.card, desk.version, a.hash, 3);
        let receipt = desk.world.post(1, session(), &back);
        let gate = |opened: &Opened<'_>| {
            command_gate(
                &desk.world.fake,
                &mut GateLog::new(),
                &device(3),
                opened,
                &OwnRecord::None,
                NOW,
            )
            .unwrap()
        };
        assert_eq!(
            gate(&receipt.opened().unwrap()),
            Decision::Act(Command::TakeBack)
        );
        let before = receipt.opened().unwrap().before.unwrap().clone();
        let with_state = |change: &dyn Fn(&mut Object)| {
            let mut object = before.clone();
            change(&mut object);
            let mut opened = receipt.opened().unwrap();
            opened.before = Some(&object);
            gate(&opened)
        };
        assert_eq!(
            with_state(&|o| o.answer = Some(Hash32::new([9; 32]))),
            Decision::Refused(Refusal::NotTheAnswer)
        );
        assert_eq!(
            with_state(&|o| o.answer = None),
            Decision::Refused(Refusal::NotTheAnswer)
        );
        assert_eq!(
            with_state(&|o| o.state = ObjectState::Closed),
            Decision::Refused(Refusal::NotTheAnswer)
        );
        assert_eq!(
            with_state(&|o| o.current = Hash32::new([9; 32])),
            Decision::Refused(Refusal::VersionChanged)
        );

        // A take back that names another answer than the one in force passes 9.2.1, which reads headers only,
        // and stops at the gate.
        let mut desk = self::desk(two_options());
        let draft = desk.answer_draft("answer", &["yes"]);
        desk.world.post(2, session(), &draft);
        let back = take_back(desk.card, desk.version, Hash32::new([9; 32]), 3);
        let receipt = desk.world.post(1, session(), &back);
        let decision = command_gate(
            &desk.world.fake,
            &mut GateLog::new(),
            &device(3),
            &receipt.opened().unwrap(),
            &OwnRecord::None,
            NOW,
        )
        .unwrap();
        assert_eq!(decision, Decision::Refused(Refusal::NotTheAnswer));
    }

    #[test]
    fn nothing_reaches_the_gate_that_failed_a_check() {
        let mut desk = desk(two_options());
        // Forbidden: an answer to a version that is not current.
        let bind = AnswerBind {
            object_id: desk.card,
            version_hash: Hash32::new([9; 32]),
            choices: Vec::new(),
        };
        let draft = Draft::answer(bind, false, Urgency::Normal, device(3), b"{}");
        assert!(desk.world.post(2, session(), &draft).opened().is_none());
        // Pruned.
        let draft = desk.answer_draft("answer", &["yes"]);
        let sealed = desk.world.sign(2, session(), &draft);
        let receipt = desk.world.take(&sealed.envelope.prune().unwrap()).unwrap();
        assert!(receipt.opened().is_none());
        // A void record.
        let sealed = desk.world.sign(
            1,
            session(),
            &Draft::session_chat(SESSION, device(3), b"{}"),
        );
        let receipt = desk
            .world
            .take_as(
                &sealed.envelope.prune().unwrap().encode().unwrap(),
                &Served::Void(Error::WrongEpoch),
                Mode::InOrder,
            )
            .unwrap();
        assert!(receipt.opened().is_none());
    }
}
