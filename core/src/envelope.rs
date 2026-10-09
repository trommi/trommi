//! The envelope (section 9): one stored, signed, encrypted item. A readable [`Header`], a [`Body`] sealed under
//! the content key of the header's group and epoch, the sender's signature over both. This module encodes and
//! decodes, pads, seals and opens, hashes, signs and verifies, and prunes. It knows no group and keeps no state:
//! whether the sender may write the item, and where it stands in its chain, is decided in [`crate::chain`] and
//! [`crate::objects`].
//!
//! Every accepted encoding is canonical: decoding and encoding again gives the same bytes, so the hash of an
//! envelope is computed over the encoding of what was decoded.

use crate::codec::{self, Decode, Encode, Opaque, Reader, Writer};
use crate::crypto::{self, Entropy, Secret, SigningKey, NONCE_LEN, TAG_LEN};
use crate::error::Error;
use crate::ids::{
    base64url_decode, BoardId, DeviceId, FileId, GroupId, Hash32, ObjectId, RegisterId, SessionId,
};
use serde::de::{Deserializer, MapAccess, SeqAccess, Visitor};
use serde::Deserialize;
use std::collections::BTreeSet;
use std::fmt;
use zeroize::{Zeroize, Zeroizing};

/// The version of the header and of the body.
pub const VERSION: u8 = 2;
/// The `schema_version` of a payload.
pub const SCHEMA_VERSION: u64 = 2;
/// The longest JSON payload, in bytes.
pub const MAX_PAYLOAD_LEN: usize = 60_000;
/// The largest padded body, in bytes.
pub const MAX_PADDED_LEN: usize = 65_536;
/// The smallest padded body, in bytes.
pub const MIN_PADDED_LEN: usize = 256;
/// How many files a header names at most.
pub const MAX_FILE_IDS: usize = 255;
/// How many choices an answer carries at most.
pub const MAX_CHOICES: usize = 64;
/// The longest single choice of an answer, in bytes.
pub const MAX_CHOICE_LEN: usize = 256;
/// The largest encoded envelope this module reads: the hub's limit for one request.
pub const MAX_ENVELOPE_LEN: usize = 1 << 20;
/// The length of an Ed25519 signature.
pub const SIGNATURE_LEN: usize = 64;
/// The first of the kinds 8 to 255, which no writer may use.
pub const FIRST_RESERVED_KIND: u8 = 8;
/// The length of the block a header carries for every kind but item and register.
pub const OBJECT_BLOCK_LEN: usize = 59;

const LABEL_HASH: &str = "Trommi Envelope";
const LABEL_SIGNATURE: &str = "TrommiEnvelope";
const LABEL_OBJECT: &str = "Trommi Object";
/// The most bytes a body has beside its bind and its payload: the version and the two lengths.
const BODY_OVERHEAD: usize = 1 + 4 + 4;
const FLAG_PUSH: u8 = 1;
const FORM_FULL: u8 = 1;
const FORM_PRUNED: u8 = 2;

macro_rules! byte_enum {
    ($(#[$doc:meta])* $name:ident { $($(#[$variant_doc:meta])* $variant:ident = $value:literal),+ $(,)? }) => {
        $(#[$doc])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
        pub enum $name {
            $($(#[$variant_doc])* $variant),+
        }

        impl $name {
            /// The value this byte stands for; `bad-format` for any other byte.
            pub fn from_byte(byte: u8) -> Result<Self, Error> {
                match byte {
                    $($value => Ok(Self::$variant),)+
                    _ => Err(Error::BadFormat),
                }
            }

            /// The byte of this value.
            pub fn byte(self) -> u8 {
                match self {
                    $(Self::$variant => $value),+
                }
            }
        }
    };
}

byte_enum!(
    /// What kind of thing an object is. The first version fixes it.
    ObjectType {
        /// A Decision card or an Info card.
        Card = 1,
        /// A Note.
        Note = 2,
        /// A permission request.
        Request = 3,
        /// An Artifact.
        Artifact = 4,
    }
);

byte_enum!(
    /// The state an envelope gives its object.
    ObjectState {
        /// Waiting for an answer or a verdict.
        Open = 1,
        /// Answered; the answer can be taken back.
        Answered = 2,
        /// Closed.
        Closed = 3,
    }
);

byte_enum!(
    /// How urgent an object is.
    Urgency {
        /// Nice to know.
        Low = 0,
        /// The usual.
        Normal = 1,
        /// Blocks a task.
        High = 2,
        /// Blocks everything.
        Critical = 3,
    }
);

byte_enum!(
    /// A human's verdict on a permission request.
    Verdict {
        /// The request is granted.
        Allow = 1,
        /// The request is refused.
        Deny = 2,
    }
);

/// The timeline an item belongs to. Only the three pairs of kind and scope that exist are a timeline: a Chat is
/// a session's or a card's, a board is a Desk's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Timeline {
    /// The Chat of a session: `session/<session>`.
    SessionChat(SessionId),
    /// A card's own Chat: `card/<object>`.
    CardChat(ObjectId),
    /// A Scribble Board: `desk/<board>`.
    Board(BoardId),
}

impl Timeline {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        let (kind, scope, reference) = (reader.u8()?, reader.u8()?, reader.fixed::<16>()?);
        match (kind, scope) {
            (1, 1) => Ok(Self::CardChat(ObjectId::new(reference))),
            (1, 2) => Ok(Self::SessionChat(SessionId::new(reference))),
            (2, 3) => Ok(Self::Board(BoardId::new(reference))),
            _ => Err(Error::BadFormat),
        }
    }

    fn write(&self, writer: &mut Writer) {
        let (kind, scope, reference) = match self {
            Self::CardChat(object) => (1, 1, object.as_bytes()),
            Self::SessionChat(session) => (1, 2, session.as_bytes()),
            Self::Board(board) => (2, 3, board.as_bytes()),
        };
        writer.u8(kind);
        writer.u8(scope);
        writer.fixed(reference);
    }

    /// Whether this is a Chat, a session's or a card's.
    pub fn is_chat(&self) -> bool {
        !matches!(self, Self::Board(_))
    }
}

/// What a header says about the object its envelope belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObjectFields {
    /// The object.
    pub object_id: ObjectId,
    /// Its type.
    pub object_type: ObjectType,
    /// The state this envelope gives it.
    pub state: ObjectState,
    /// Its urgency.
    pub urgency: Urgency,
    /// When it was answered, in ms; 0 while open. For display only.
    pub answered_at: u64,
    /// A version: the hash of the version before it, zeros for the first. An answer or a take back: the version
    /// answered. A verdict: the request. A request: zeros.
    pub object_ref: Hash32,
}

impl ObjectFields {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        let fields = Self {
            object_id: reader.value()?,
            object_type: ObjectType::from_byte(reader.u8()?)?,
            state: ObjectState::from_byte(reader.u8()?)?,
            urgency: Urgency::from_byte(reader.u8()?)?,
            answered_at: reader.u64()?,
            object_ref: reader.value()?,
        };
        if fields.state == ObjectState::Open && fields.answered_at != 0 {
            return Err(Error::BadFormat);
        }
        Ok(fields)
    }

    fn write(&self, writer: &mut Writer) {
        writer.fixed(self.object_id.as_bytes());
        writer.u8(self.object_type.byte());
        writer.u8(self.state.byte());
        writer.u8(self.urgency.byte());
        writer.u64(self.answered_at);
        writer.fixed(self.object_ref.as_bytes());
    }
}

/// The kind of an envelope with the block of header fields that belongs to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Subject {
    /// Kind 1: an item on a timeline.
    Item(Timeline),
    /// Kind 2: a version of a card, a Note or an Artifact.
    Version(ObjectFields),
    /// Kind 3: an answer to a card version.
    Answer(ObjectFields),
    /// Kind 4: a permission request.
    Request(ObjectFields),
    /// Kind 5: a verdict on a permission request.
    Verdict(ObjectFields),
    /// Kind 6: a register value.
    Register(RegisterId),
    /// Kind 7: an answer taken back.
    TakeBack(ObjectFields),
    /// Kinds 8 to 255, which a newer Trommi may define. The block is kept as it came: its values are not
    /// judged, since nothing of such an envelope is applied.
    Reserved {
        /// The kind, 8 or above.
        kind: u8,
        /// The object block, unread.
        block: [u8; OBJECT_BLOCK_LEN],
    },
}

impl Subject {
    /// The kind byte.
    pub fn kind(&self) -> u8 {
        match self {
            Self::Item(_) => 1,
            Self::Version(_) => 2,
            Self::Answer(_) => 3,
            Self::Request(_) => 4,
            Self::Verdict(_) => 5,
            Self::Register(_) => 6,
            Self::TakeBack(_) => 7,
            Self::Reserved { kind, .. } => *kind,
        }
    }

    /// The object fields, for the five kinds that belong to an object.
    pub fn object(&self) -> Option<&ObjectFields> {
        match self {
            Self::Version(fields)
            | Self::Answer(fields)
            | Self::Request(fields)
            | Self::Verdict(fields)
            | Self::TakeBack(fields) => Some(fields),
            Self::Item(_) | Self::Register(_) | Self::Reserved { .. } => None,
        }
    }

    /// Whether the kind is one this version does not know.
    pub fn is_reserved(&self) -> bool {
        matches!(self, Self::Reserved { .. })
    }
}

/// The readable part of an envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Header {
    /// Flag bit 0: the sender asks for a push. Whether it is honoured is 9.2's.
    pub push: bool,
    /// The group whose content key seals the body.
    pub group: GroupId,
    /// The epoch of that key.
    pub epoch: u64,
    /// The device that signs.
    pub sender: DeviceId,
    /// The envelope's number in its sender's chain in this group, from 1.
    pub seq: u64,
    /// The hash of the sender's envelope before it in this group; zeros for the first.
    pub prev: Hash32,
    /// The device the envelope is addressed to, or zeros.
    pub recipient: DeviceId,
    /// The sender's clock, in ms. A claim.
    pub time: u64,
    /// The kind and its block.
    pub subject: Subject,
    /// The files the body refers to.
    pub file_ids: Vec<FileId>,
}

impl Encode for Header {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        let misnamed =
            matches!(self.subject, Subject::Reserved { kind, .. } if kind < FIRST_RESERVED_KIND);
        if self.seq == 0 || misnamed {
            return Err(Error::BadFormat);
        }
        if self.file_ids.len() > MAX_FILE_IDS {
            return Err(Error::TooLarge);
        }
        writer.u8(VERSION);
        writer.u8(self.subject.kind());
        writer.u8(if self.push { FLAG_PUSH } else { 0 });
        writer.value(&self.group)?;
        writer.u64(self.epoch);
        writer.fixed(self.sender.as_bytes());
        writer.u64(self.seq);
        writer.fixed(self.prev.as_bytes());
        writer.fixed(self.recipient.as_bytes());
        writer.u64(self.time);
        match &self.subject {
            Subject::Item(timeline) => timeline.write(writer),
            Subject::Register(register) => writer.fixed(register.as_bytes()),
            Subject::Version(fields)
            | Subject::Answer(fields)
            | Subject::Request(fields)
            | Subject::Verdict(fields)
            | Subject::TakeBack(fields) => fields.write(writer),
            Subject::Reserved { block, .. } => writer.fixed(block),
        }
        writer.vector(&self.file_ids)
    }
}

impl Decode for Header {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        match reader.u8()? {
            VERSION => {}
            newer if newer > VERSION => return Err(Error::NewerVersion),
            _ => return Err(Error::BadFormat),
        }
        let kind = reader.u8()?;
        let flags = reader.u8()?;
        if flags & !FLAG_PUSH != 0 {
            return Err(Error::BadFormat);
        }
        let group = reader.value()?;
        let epoch = reader.u64()?;
        let sender = reader.value()?;
        let seq = reader.u64()?;
        if seq == 0 {
            return Err(Error::BadFormat);
        }
        let prev = reader.value()?;
        let recipient = reader.value()?;
        let time = reader.u64()?;
        let subject = match kind {
            0 => return Err(Error::BadFormat),
            1 => Subject::Item(Timeline::read(reader)?),
            2 => Subject::Version(ObjectFields::read(reader)?),
            3 => Subject::Answer(ObjectFields::read(reader)?),
            4 => Subject::Request(ObjectFields::read(reader)?),
            5 => Subject::Verdict(ObjectFields::read(reader)?),
            6 => Subject::Register(reader.value()?),
            7 => Subject::TakeBack(ObjectFields::read(reader)?),
            kind => Subject::Reserved {
                kind,
                block: reader.fixed()?,
            },
        };
        let file_ids: Vec<FileId> = reader.vector()?;
        if file_ids.len() > MAX_FILE_IDS {
            return Err(Error::BadFormat);
        }
        Ok(Self {
            push: flags & FLAG_PUSH != 0,
            group,
            epoch,
            sender,
            seq,
            prev,
            recipient,
            time,
            subject,
            file_ids,
        })
    }
}

/// What an envelope carries of its body.
#[derive(Clone, PartialEq, Eq)]
pub enum Content {
    /// The sealed body.
    Full(Vec<u8>),
    /// The SHA-256 of the sealed body, which was removed.
    Pruned(Hash32),
}

impl fmt::Debug for Content {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Full(ciphertext) => write!(f, "Full({} bytes)", ciphertext.len()),
            Self::Pruned(hash) => write!(f, "Pruned({hash})"),
        }
    }
}

/// One stored item, with its body or pruned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Envelope {
    /// The readable part, which is also the AEAD's associated data.
    pub header: Header,
    /// The AEAD nonce.
    pub nonce: [u8; NONCE_LEN],
    /// The sealed body, or its hash.
    pub content: Content,
    /// The sender's signature over the envelope hash.
    pub signature: [u8; SIGNATURE_LEN],
}

impl Encode for Envelope {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        match &self.content {
            Content::Full(_) => writer.u8(FORM_FULL),
            Content::Pruned(_) => writer.u8(FORM_PRUNED),
        }
        writer.value(&self.header)?;
        writer.fixed(&self.nonce);
        match &self.content {
            Content::Full(ciphertext) => writer.opaque(ciphertext)?,
            Content::Pruned(hash) => writer.fixed(hash.as_bytes()),
        }
        writer.opaque(&self.signature)
    }
}

impl Decode for Envelope {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        let form = reader.u8()?;
        let header = reader.value()?;
        let nonce = reader.fixed()?;
        let content = match form {
            FORM_FULL => {
                let ciphertext = reader.opaque()?;
                // A sealed body within the limit has one of nine lengths. A longer one has its own code: the
                // hub refuses it once it is chained, and it does not open.
                if ciphertext.len() <= MAX_PADDED_LEN.saturating_add(TAG_LEN)
                    && !is_bucket(ciphertext.len().saturating_sub(TAG_LEN))
                {
                    return Err(Error::BadFormat);
                }
                Content::Full(ciphertext.to_vec())
            }
            FORM_PRUNED => Content::Pruned(reader.value()?),
            _ => return Err(Error::BadFormat),
        };
        let signature = reader.opaque()?.try_into().map_err(|_| Error::BadFormat)?;
        Ok(Self {
            header,
            nonce,
            content,
            signature,
        })
    }
}

/// The padded length for a body of `len` bytes: the next of 256, 512, … 65536. `None` above the largest.
fn bucket(len: usize) -> Option<usize> {
    let padded = len.max(MIN_PADDED_LEN).checked_next_power_of_two()?;
    (padded <= MAX_PADDED_LEN).then_some(padded)
}

fn is_bucket(len: usize) -> bool {
    bucket(len) == Some(len)
}

impl Envelope {
    /// The envelope these bytes encode: `too-large` above [`MAX_ENVELOPE_LEN`], `newer-version` for a header
    /// version above 2, `bad-format` for anything else that is not exactly one envelope with legal flags and
    /// values.
    pub fn decode(bytes: &[u8]) -> Result<Self, Error> {
        codec::decode(bytes, MAX_ENVELOPE_LEN)
    }

    /// The encoding.
    pub fn encode(&self) -> Result<Vec<u8>, Error> {
        codec::encode(self)
    }

    /// `envelope_hash`: `RefHash("Trommi Envelope", Header ‖ nonce ‖ SHA-256(ciphertext))`. The same for the
    /// full and the pruned form.
    pub fn hash(&self) -> Result<Hash32, Error> {
        let body_hash = match &self.content {
            Content::Full(ciphertext) => crypto::sha256(ciphertext)?,
            Content::Pruned(hash) => *hash,
        };
        let mut writer = Writer::new();
        writer.value(&self.header)?;
        writer.fixed(&self.nonce);
        writer.fixed(body_hash.as_bytes());
        crypto::ref_hash(LABEL_HASH, &writer.into_bytes())
    }

    /// Checks the signature of the header's sender and gives the envelope hash; `bad-signature` otherwise.
    pub fn verify(&self) -> Result<Hash32, Error> {
        let hash = self.hash()?;
        crypto::verify_with_label(
            self.header.sender.as_bytes(),
            LABEL_SIGNATURE,
            hash.as_bytes(),
            &self.signature,
        )?;
        Ok(hash)
    }

    /// The pruned form: header, nonce, the hash of the sealed body, the signature. It has the same hash and
    /// verifies like the full one.
    pub fn prune(&self) -> Result<Self, Error> {
        let content = match &self.content {
            Content::Full(ciphertext) => Content::Pruned(crypto::sha256(ciphertext)?),
            Content::Pruned(hash) => Content::Pruned(*hash),
        };
        Ok(Self {
            header: self.header.clone(),
            nonce: self.nonce,
            content,
            signature: self.signature,
        })
    }

    /// Whether the body was removed.
    pub fn is_pruned(&self) -> bool {
        matches!(self.content, Content::Pruned(_))
    }

    /// Whether the sealed body is longer than any padded body may be.
    pub fn is_oversize(&self) -> bool {
        match &self.content {
            Content::Full(ciphertext) => ciphertext.len() > MAX_PADDED_LEN.saturating_add(TAG_LEN),
            Content::Pruned(_) => false,
        }
    }

    /// Opens the body with the content key of the header's group and epoch. `pruned` when the body was removed;
    /// `newer-version` for a reserved kind or a body version above 2; `too-large` for a sealed body beyond the
    /// largest padded size; `decrypt-failed` when the key, the header or the ciphertext is not the one sealed;
    /// `bad-format` for wrong padding, a bind that is not the kind's or does not agree with the header, or a
    /// payload that is not a JSON object.
    pub fn open(&self, key: &Secret<32>) -> Result<Body, Error> {
        let ciphertext = match &self.content {
            Content::Full(ciphertext) => ciphertext,
            Content::Pruned(_) => return Err(Error::Pruned),
        };
        if self.header.subject.is_reserved() {
            return Err(Error::NewerVersion);
        }
        if self.is_oversize() {
            return Err(Error::TooLarge);
        }
        let aad = codec::encode(&self.header)?;
        let padded = Zeroizing::new(crypto::aead_open(key, &self.nonce, &aad, ciphertext)?);
        let body = Body::unpad(&self.header.subject, &padded)?;
        body.fits(&self.header)?;
        Ok(body)
    }
}

/// `bind` of an answer: the version answered and the options chosen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnswerBind {
    /// The card.
    pub object_id: ObjectId,
    /// The `envelope_hash` of the version answered.
    pub version_hash: Hash32,
    /// The chosen options: at most [`MAX_CHOICES`], each at most [`MAX_CHOICE_LEN`] bytes.
    pub choices: Vec<Vec<u8>>,
}

/// `bind` of a permission request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RequestBind {
    /// The request: its object id.
    pub request_id: ObjectId,
    /// Until when a verdict counts, in ms.
    pub expires_at: u64,
}

/// `bind` of a verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VerdictBind {
    /// The request.
    pub request_id: ObjectId,
    /// The `envelope_hash` of the request.
    pub request_hash: Hash32,
    /// The request's own `expires_at`.
    pub expires_at: u64,
    /// Allow or deny.
    pub verdict: Verdict,
}

/// `bind` of a take back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TakeBackBind {
    /// The card.
    pub object_id: ObjectId,
    /// The `envelope_hash` of the answer taken back.
    pub previous_hash: Hash32,
    /// The `envelope_hash` of the version that was answered.
    pub version_hash: Hash32,
}

/// What a body binds its envelope to, by kind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Bind {
    /// Items, versions and registers bind nothing.
    None,
    /// An answer.
    Answer(AnswerBind),
    /// A permission request.
    Request(RequestBind),
    /// A verdict.
    Verdict(VerdictBind),
    /// A take back.
    TakeBack(TakeBackBind),
}

impl Bind {
    fn encode(&self) -> Result<Vec<u8>, Error> {
        let mut writer = Writer::new();
        match self {
            Self::None => {}
            Self::Answer(bind) => {
                if bind.choices.len() > MAX_CHOICES
                    || bind.choices.iter().any(|c| c.len() > MAX_CHOICE_LEN)
                {
                    return Err(Error::TooLarge);
                }
                writer.fixed(bind.object_id.as_bytes());
                writer.fixed(bind.version_hash.as_bytes());
                // Each choice behind its length, all of them behind theirs: no copy of a choice is made.
                let mut choices = Writer::new();
                for choice in &bind.choices {
                    choices.opaque(choice)?;
                }
                writer.opaque(&Zeroizing::new(choices.into_bytes()))?;
            }
            Self::Request(bind) => {
                writer.fixed(bind.request_id.as_bytes());
                writer.u64(bind.expires_at);
            }
            Self::Verdict(bind) => {
                writer.fixed(bind.request_id.as_bytes());
                writer.fixed(bind.request_hash.as_bytes());
                writer.u64(bind.expires_at);
                writer.u8(bind.verdict.byte());
            }
            Self::TakeBack(bind) => {
                writer.fixed(bind.object_id.as_bytes());
                writer.fixed(bind.previous_hash.as_bytes());
                writer.fixed(bind.version_hash.as_bytes());
            }
        }
        Ok(writer.into_bytes())
    }

    /// The bind of an envelope of this kind; `bad-format` unless the bytes are exactly that kind's struct.
    fn decode(subject: &Subject, bytes: &[u8]) -> Result<Self, Error> {
        let mut reader = Reader::new(bytes);
        let bind = match subject {
            Subject::Item(_) | Subject::Version(_) | Subject::Register(_) => Self::None,
            Subject::Answer(_) => {
                let object_id = reader.value()?;
                let version_hash = reader.value()?;
                let choices: Vec<Opaque> = reader.vector()?;
                if choices.len() > MAX_CHOICES || choices.iter().any(|c| c.0.len() > MAX_CHOICE_LEN)
                {
                    return Err(Error::BadFormat);
                }
                Self::Answer(AnswerBind {
                    object_id,
                    version_hash,
                    choices: choices.into_iter().map(|c| c.0).collect(),
                })
            }
            Subject::Request(_) => Self::Request(RequestBind {
                request_id: reader.value()?,
                expires_at: reader.u64()?,
            }),
            Subject::Verdict(_) => Self::Verdict(VerdictBind {
                request_id: reader.value()?,
                request_hash: reader.value()?,
                expires_at: reader.u64()?,
                verdict: Verdict::from_byte(reader.u8()?)?,
            }),
            Subject::TakeBack(_) => Self::TakeBack(TakeBackBind {
                object_id: reader.value()?,
                previous_hash: reader.value()?,
                version_hash: reader.value()?,
            }),
            Subject::Reserved { .. } => return Err(Error::NewerVersion),
        };
        reader.finish()?;
        Ok(bind)
    }
}

/// The one field of a version's payload that the header repeats.
#[derive(Deserialize)]
struct VersionPayload {
    previous_version_hash: String,
}

/// Any JSON value in which no object names a key twice, at any depth. Two readers then never see two
/// different values under one key.
struct NoKeyTwice;

impl<'de> Deserialize<'de> for NoKeyTwice {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Walk;

        impl<'de> Visitor<'de> for Walk {
            type Value = NoKeyTwice;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("JSON without a repeated key")
            }

            fn visit_bool<E>(self, _: bool) -> Result<NoKeyTwice, E> {
                Ok(NoKeyTwice)
            }

            fn visit_i64<E>(self, _: i64) -> Result<NoKeyTwice, E> {
                Ok(NoKeyTwice)
            }

            fn visit_u64<E>(self, _: u64) -> Result<NoKeyTwice, E> {
                Ok(NoKeyTwice)
            }

            fn visit_f64<E>(self, _: f64) -> Result<NoKeyTwice, E> {
                Ok(NoKeyTwice)
            }

            fn visit_str<E>(self, _: &str) -> Result<NoKeyTwice, E> {
                Ok(NoKeyTwice)
            }

            fn visit_unit<E>(self) -> Result<NoKeyTwice, E> {
                Ok(NoKeyTwice)
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<NoKeyTwice, A::Error> {
                while seq.next_element::<NoKeyTwice>()?.is_some() {}
                Ok(NoKeyTwice)
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<NoKeyTwice, A::Error> {
                let mut keys = BTreeSet::new();
                while let Some(key) = map.next_key::<String>()? {
                    if !keys.insert(key) {
                        return Err(serde::de::Error::custom("a key twice"));
                    }
                    map.next_value::<NoKeyTwice>()?;
                }
                Ok(NoKeyTwice)
            }
        }

        deserializer.deserialize_any(Walk)
    }
}

/// Whether `bytes` are one JSON object in UTF-8 and nothing else, with no key twice in any object.
pub(crate) fn is_json_object(bytes: &[u8]) -> bool {
    let first = bytes.iter().find(|b| !b" \t\n\r".contains(b));
    first == Some(&b'{') && serde_json::from_slice::<NoKeyTwice>(bytes).is_ok()
}

/// The fields of any payload that every reader looks at.
#[derive(Deserialize)]
struct CommonPayload {
    #[serde(default)]
    schema_version: Option<u64>,
}

/// The fields of an answer's payload that repeat its bind. A `choices` that is present is a list: null is
/// not "absent".
#[derive(Deserialize)]
struct AnswerChoices {
    #[serde(default, deserialize_with = "present")]
    choices: Option<Vec<String>>,
}

fn present<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Vec<String>>, D::Error> {
    Vec::deserialize(deserializer).map(Some)
}

/// The encrypted part of an envelope: what it is bound to, and its JSON payload. The payload may hold the keys
/// of files, so a body is never printed and its payload is wiped when dropped.
#[derive(Clone, PartialEq, Eq)]
pub struct Body {
    bind: Bind,
    payload: Vec<u8>,
}

impl fmt::Debug for Body {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Body(<redacted>)")
    }
}

impl Drop for Body {
    fn drop(&mut self) {
        self.payload.zeroize();
        if let Bind::Answer(answer) = &mut self.bind {
            answer.choices.iter_mut().for_each(Zeroize::zeroize);
        }
    }
}

impl Body {
    /// A body of this bind and payload. `too-large` above [`MAX_PAYLOAD_LEN`]; `bad-format` unless the payload
    /// is a JSON object in UTF-8 that names no key twice; `newer-version` for a `schema_version` above 2 (a
    /// payload without one is read as 2).
    pub fn new(bind: Bind, payload: &[u8]) -> Result<Self, Error> {
        if payload.len() > MAX_PAYLOAD_LEN {
            return Err(Error::TooLarge);
        }
        if !is_json_object(payload) {
            return Err(Error::BadFormat);
        }
        let common: CommonPayload =
            serde_json::from_slice(payload).map_err(|_| Error::BadFormat)?;
        if common
            .schema_version
            .is_some_and(|version| version > SCHEMA_VERSION)
        {
            return Err(Error::NewerVersion);
        }
        Ok(Self {
            bind,
            payload: payload.to_vec(),
        })
    }

    /// What the envelope is bound to.
    pub fn bind(&self) -> &Bind {
        &self.bind
    }

    /// The JSON payload.
    pub fn payload(&self) -> &[u8] {
        &self.payload
    }

    /// `Body ‖ zero bytes` up to the next of 256, 512, … 65536 bytes; `too-large` beyond.
    fn pad(&self) -> Result<Zeroizing<Vec<u8>>, Error> {
        let bind = Zeroizing::new(self.bind.encode()?);
        // The body is written into a buffer that has its padded length from the start: growing it would
        // leave the payload behind in the buffer it outgrew. The estimate may lie a few bytes above the
        // body; whether the body fits is judged by its own length.
        let estimate = BODY_OVERHEAD
            .saturating_add(bind.len())
            .saturating_add(self.payload.len());
        let mut writer = Writer::with_capacity(bucket(estimate).unwrap_or(MAX_PADDED_LEN));
        writer.u8(VERSION);
        writer.opaque(&bind)?;
        writer.opaque(&self.payload)?;
        let len = bucket(writer.len()).ok_or(Error::TooLarge)?;
        let mut padded = Zeroizing::new(writer.into_bytes());
        if len > padded.capacity() {
            return Err(Error::Internal("padded length"));
        }
        padded.resize(len, 0);
        Ok(padded)
    }

    /// The body of a padded plaintext, strictly: the padding is all zero and ends at the bucket the body
    /// needs, no larger one.
    fn unpad(subject: &Subject, padded: &[u8]) -> Result<Self, Error> {
        let mut reader = Reader::new(padded);
        match reader.u8()? {
            VERSION => {}
            newer if newer > VERSION => return Err(Error::NewerVersion),
            _ => return Err(Error::BadFormat),
        }
        let bind = reader.opaque()?;
        let payload = reader.opaque()?;
        let padding = reader.remaining();
        let body_len = padded.len().checked_sub(padding).ok_or(Error::BadFormat)?;
        if bucket(body_len) != Some(padded.len()) || reader.take(padding)?.iter().any(|b| *b != 0) {
            return Err(Error::BadFormat);
        }
        Self::new(Bind::decode(subject, bind)?, payload).map_err(|error| match error {
            Error::TooLarge => Error::BadFormat,
            other => other,
        })
    }

    /// Whether this body is one the header may carry: the bind is the kind's and names the header's object and
    /// reference, a version's payload names the same predecessor as the header, and an answer's choices are
    /// UTF-8 and those of its payload, if it names any. `bad-format` otherwise.
    fn fits(&self, header: &Header) -> Result<(), Error> {
        let agrees = match (&header.subject, &self.bind) {
            (Subject::Item(_) | Subject::Register(_), Bind::None) => true,
            (Subject::Version(fields), Bind::None) => {
                let payload: VersionPayload =
                    serde_json::from_slice(&self.payload).map_err(|_| Error::BadFormat)?;
                base64url_decode(&payload.previous_version_hash)?.as_slice()
                    == fields.object_ref.as_bytes()
            }
            (Subject::Answer(fields), Bind::Answer(bind)) => {
                let named: AnswerChoices =
                    serde_json::from_slice(&self.payload).map_err(|_| Error::BadFormat)?;
                let choices = bind
                    .choices
                    .iter()
                    .map(|choice| std::str::from_utf8(choice))
                    .collect::<Result<Vec<&str>, _>>()
                    .map_err(|_| Error::BadFormat)?;
                bind.object_id == fields.object_id
                    && bind.version_hash == fields.object_ref
                    && named.choices.is_none_or(|named| named == choices)
            }
            (Subject::Request(fields), Bind::Request(bind)) => bind.request_id == fields.object_id,
            (Subject::Verdict(fields), Bind::Verdict(bind)) => {
                bind.request_id == fields.object_id && bind.request_hash == fields.object_ref
            }
            (Subject::TakeBack(fields), Bind::TakeBack(bind)) => {
                bind.object_id == fields.object_id && bind.version_hash == fields.object_ref
            }
            _ => false,
        };
        if agrees {
            Ok(())
        } else {
            Err(Error::BadFormat)
        }
    }
}

/// `object_id`: the first 16 bytes of `RefHash("Trommi Object", group_id ‖ sender ‖ seq)` of the object's first
/// version (for a permission request: of the request). `group_id` is the group's 32 or 48 bytes as they are,
/// `seq` a `uint64`.
pub fn object_id(group: &GroupId, sender: &DeviceId, seq: u64) -> Result<ObjectId, Error> {
    let mut writer = Writer::new();
    writer.fixed(group.as_bytes());
    writer.fixed(sender.as_bytes());
    writer.u64(seq);
    let hash = crypto::ref_hash(LABEL_OBJECT, &writer.into_bytes())?;
    let (first, _) = hash
        .as_bytes()
        .split_at_checked(ObjectId::LEN)
        .ok_or(Error::Internal("hash length"))?;
    ObjectId::from_slice(first)
}

/// The place of a new envelope: its group and epoch, and its sender's next number with the hash before it.
/// [`crate::chain::OwnChain::slot`] hands it out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Slot {
    /// The group.
    pub group: GroupId,
    /// The group's current epoch.
    pub epoch: u64,
    /// The sender.
    pub sender: DeviceId,
    /// The number: one above the sender's last.
    pub seq: u64,
    /// The hash of the sender's last envelope in the group, or zeros.
    pub prev: Hash32,
    /// The sender's clock, in ms.
    pub time: u64,
}

enum What {
    Item(Timeline),
    Register(RegisterId),
    FirstVersion {
        object_type: ObjectType,
        urgency: Urgency,
    },
    LaterVersion {
        object_id: ObjectId,
        object_type: ObjectType,
        closed: bool,
        urgency: Urgency,
        previous: Hash32,
    },
    Request {
        urgency: Urgency,
        expires_at: u64,
    },
    Answer {
        urgency: Urgency,
        closes: bool,
        bind: AnswerBind,
    },
    Verdict {
        urgency: Urgency,
        bind: VerdictBind,
    },
    TakeBack {
        urgency: Urgency,
        bind: TakeBackBind,
    },
}

/// An envelope before it has a place in a chain. Each constructor makes one kind of item and takes exactly what
/// that kind needs; the header fields that follow from them (the object id of a first version, `object_ref`,
/// the state, the bind) are set when it is sealed, so they cannot disagree. No constructor makes a reserved
/// kind.
pub struct Draft {
    what: What,
    recipient: DeviceId,
    push: bool,
    file_ids: Vec<FileId>,
    payload: Zeroizing<Vec<u8>>,
}

impl Draft {
    fn new(what: What, recipient: DeviceId, payload: &[u8]) -> Self {
        Self {
            what,
            recipient,
            push: false,
            file_ids: Vec::new(),
            payload: Zeroizing::new(payload.to_vec()),
        }
    }

    /// A Chat message in a session's Chat. A human device addresses it to the session's agent device (in a
    /// helper session: its opener); an agent or helper device may pass zeros.
    pub fn session_chat(session: SessionId, recipient: DeviceId, payload: &[u8]) -> Self {
        Self::new(
            What::Item(Timeline::SessionChat(session)),
            recipient,
            payload,
        )
    }

    /// A Chat message in a card's own Chat; addressed like [`Draft::session_chat`].
    pub fn card_chat(card: ObjectId, recipient: DeviceId, payload: &[u8]) -> Self {
        Self::new(What::Item(Timeline::CardChat(card)), recipient, payload)
    }

    /// An item of a Scribble Board.
    pub fn board_item(board: BoardId, payload: &[u8]) -> Self {
        Self::new(What::Item(Timeline::Board(board)), DeviceId::ZERO, payload)
    }

    /// A register value under the id its writer keeps for the name (9.3.1).
    pub fn register(register: RegisterId, payload: &[u8]) -> Self {
        Self::new(What::Register(register), DeviceId::ZERO, payload)
    }

    /// The first version of a card, a Note or an Artifact: open, its object id derived from its place in the
    /// chain. The payload's `previous_version_hash` is 32 zero bytes. `bad-format` for a permission request,
    /// which [`Draft::request`] makes.
    pub fn first_version(
        object_type: ObjectType,
        urgency: Urgency,
        payload: &[u8],
    ) -> Result<Self, Error> {
        if object_type == ObjectType::Request {
            return Err(Error::BadFormat);
        }
        Ok(Self::new(
            What::FirstVersion {
                object_type,
                urgency,
            },
            DeviceId::ZERO,
            payload,
        ))
    }

    /// A later version of an object: open, or `closed`. `previous` is the hash of the version it replaces, which
    /// the payload repeats as `previous_version_hash`. `bad-format` for a permission request, which has no
    /// later version, and for a `previous` of zeros.
    pub fn later_version(
        object_id: ObjectId,
        object_type: ObjectType,
        closed: bool,
        urgency: Urgency,
        previous: Hash32,
        payload: &[u8],
    ) -> Result<Self, Error> {
        if object_type == ObjectType::Request || previous.is_zero() {
            return Err(Error::BadFormat);
        }
        Ok(Self::new(
            What::LaterVersion {
                object_id,
                object_type,
                closed,
                urgency,
                previous,
            },
            DeviceId::ZERO,
            payload,
        ))
    }

    /// A permission request that a verdict may answer until `expires_at`. Its object id, which is also the
    /// bind's `request_id`, is derived from its place in the chain.
    pub fn request(urgency: Urgency, expires_at: u64, payload: &[u8]) -> Self {
        Self::new(
            What::Request {
                urgency,
                expires_at,
            },
            DeviceId::ZERO,
            payload,
        )
    }

    /// An answer to the version `bind.version_hash` of a card, addressed to the card's owner. The card becomes
    /// answered, or closed with `closes`. `urgency` is the card's.
    pub fn answer(
        bind: AnswerBind,
        closes: bool,
        urgency: Urgency,
        owner: DeviceId,
        payload: &[u8],
    ) -> Self {
        Self::new(
            What::Answer {
                urgency,
                closes,
                bind,
            },
            owner,
            payload,
        )
    }

    /// A verdict on a permission request, addressed to the request's owner. The request becomes closed.
    pub fn verdict(bind: VerdictBind, urgency: Urgency, owner: DeviceId, payload: &[u8]) -> Self {
        Self::new(What::Verdict { urgency, bind }, owner, payload)
    }

    /// The taking back of the answer `bind.previous_hash`, addressed to the card's owner. The card is open
    /// again.
    pub fn take_back(
        bind: TakeBackBind,
        urgency: Urgency,
        owner: DeviceId,
        payload: &[u8],
    ) -> Self {
        Self::new(What::TakeBack { urgency, bind }, owner, payload)
    }

    /// Asks for a push. It is honoured on card versions and permission requests of a session's agent or helper
    /// device, and ignored elsewhere.
    pub fn with_push(mut self) -> Self {
        self.push = true;
        self
    }

    /// Names the files the payload refers to, at most [`MAX_FILE_IDS`].
    pub fn with_files(mut self, file_ids: Vec<FileId>) -> Self {
        self.file_ids = file_ids;
        self
    }

    /// The header and the bind this draft has at `slot`.
    fn place(&self, slot: &Slot) -> Result<(Header, Bind), Error> {
        let fields =
            |object_id, object_type, state, urgency, answered_at, object_ref| ObjectFields {
                object_id,
                object_type,
                state,
                urgency,
                answered_at,
                object_ref,
            };
        let (subject, bind) = match &self.what {
            What::Item(timeline) => (Subject::Item(*timeline), Bind::None),
            What::Register(register) => (Subject::Register(*register), Bind::None),
            What::FirstVersion {
                object_type,
                urgency,
            } => {
                let object_id = object_id(&slot.group, &slot.sender, slot.seq)?;
                let block = fields(
                    object_id,
                    *object_type,
                    ObjectState::Open,
                    *urgency,
                    0,
                    Hash32::ZERO,
                );
                (Subject::Version(block), Bind::None)
            }
            What::LaterVersion {
                object_id,
                object_type,
                closed,
                urgency,
                previous,
            } => {
                let (state, answered_at) = if *closed {
                    (ObjectState::Closed, slot.time)
                } else {
                    (ObjectState::Open, 0)
                };
                let block = fields(
                    *object_id,
                    *object_type,
                    state,
                    *urgency,
                    answered_at,
                    *previous,
                );
                (Subject::Version(block), Bind::None)
            }
            What::Request {
                urgency,
                expires_at,
            } => {
                let request_id = object_id(&slot.group, &slot.sender, slot.seq)?;
                let block = fields(
                    request_id,
                    ObjectType::Request,
                    ObjectState::Open,
                    *urgency,
                    0,
                    Hash32::ZERO,
                );
                let bind = RequestBind {
                    request_id,
                    expires_at: *expires_at,
                };
                (Subject::Request(block), Bind::Request(bind))
            }
            What::Answer {
                urgency,
                closes,
                bind,
            } => {
                let state = if *closes {
                    ObjectState::Closed
                } else {
                    ObjectState::Answered
                };
                let block = fields(
                    bind.object_id,
                    ObjectType::Card,
                    state,
                    *urgency,
                    slot.time,
                    bind.version_hash,
                );
                (Subject::Answer(block), Bind::Answer(bind.clone()))
            }
            What::Verdict { urgency, bind } => {
                let block = fields(
                    bind.request_id,
                    ObjectType::Request,
                    ObjectState::Closed,
                    *urgency,
                    slot.time,
                    bind.request_hash,
                );
                (Subject::Verdict(block), Bind::Verdict(*bind))
            }
            What::TakeBack { urgency, bind } => {
                let block = fields(
                    bind.object_id,
                    ObjectType::Card,
                    ObjectState::Open,
                    *urgency,
                    0,
                    bind.version_hash,
                );
                (Subject::TakeBack(block), Bind::TakeBack(*bind))
            }
        };
        let header = Header {
            push: self.push,
            group: slot.group,
            epoch: slot.epoch,
            sender: slot.sender,
            seq: slot.seq,
            prev: slot.prev,
            recipient: self.recipient,
            time: slot.time,
            subject,
            file_ids: self.file_ids.clone(),
        };
        Ok((header, bind))
    }

    /// The header this draft has at `slot`, as the rules of 9.2 judge it before it is sealed.
    pub fn header(&self, slot: &Slot) -> Result<Header, Error> {
        Ok(self.place(slot)?.0)
    }

    /// The body this draft has at `slot`: the bind its kind takes there, and its payload. What
    /// [`Body::new`] refuses of a payload is refused here.
    pub fn body(&self, slot: &Slot) -> Result<Body, Error> {
        Body::new(self.place(slot)?.1, &self.payload)
    }
}

/// A sealed envelope with its hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sealed {
    /// The envelope, in full form.
    pub envelope: Envelope,
    /// Its `envelope_hash`: the `prev` of the sender's next envelope in the group.
    pub hash: Hash32,
}

/// The one way from outside the crate is [`crate::chain::seal_next`], which uses each number once.
///
/// Seals `draft` at `slot` under `key`, the content key of the slot's group and epoch, with a fresh random
/// nonce, and signs it. `wrong-sender` unless `signer` is the slot's sender; `too-large` for a payload above
/// [`MAX_PAYLOAD_LEN`], a body that does not fit the largest padded size, or more than [`MAX_FILE_IDS`] files;
/// `bad-format` for a payload that is not a JSON object, or a version whose `previous_version_hash` is not the
/// one its header names.
pub(crate) fn seal(
    draft: &Draft,
    slot: &Slot,
    key: &Secret<32>,
    signer: &SigningKey,
    entropy: &mut dyn Entropy,
) -> Result<Sealed, Error> {
    if signer.public() != *slot.sender.as_bytes() {
        return Err(Error::WrongSender);
    }
    let (header, bind) = draft.place(slot)?;
    let body = Body::new(bind, &draft.payload)?;
    body.fits(&header)?;
    let padded = body.pad()?;
    let aad = codec::encode(&header)?;
    let nonce = crypto::random::<NONCE_LEN>(entropy)?;
    let ciphertext = crypto::aead_seal(key, &nonce, &aad, &padded)?;
    let mut envelope = Envelope {
        header,
        nonce,
        content: Content::Full(ciphertext),
        signature: [0; SIGNATURE_LEN],
    };
    let hash = envelope.hash()?;
    envelope.signature = crypto::sign_with_label(signer, LABEL_SIGNATURE, hash.as_bytes())?
        .try_into()
        .map_err(|_| Error::Internal("signature length"))?;
    Ok(Sealed { envelope, hash })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::SystemEntropy;
    use crate::ids::{BoardId, RoomId};

    #[test]
    fn a_body_is_padded_to_the_next_of_nine_sizes() {
        assert_eq!(bucket(0), Some(256));
        assert_eq!(bucket(256), Some(256));
        assert_eq!(bucket(257), Some(512));
        assert_eq!(bucket(65_536), Some(65_536));
        assert_eq!(bucket(65_537), None);
        assert_eq!(bucket(usize::MAX), None);
        assert_eq!((0..70_000).filter(|len| is_bucket(*len)).count(), 9);
    }

    #[test]
    fn only_the_slots_sender_seals() {
        let signer = SigningKey::from_seed(Secret::new([1; 32]));
        let other = SigningKey::from_seed(Secret::new([2; 32]));
        let slot = Slot {
            group: GroupId::room(RoomId::new([1; 32])),
            epoch: 0,
            sender: DeviceId::new(signer.public()),
            seq: 1,
            prev: Hash32::ZERO,
            time: 5,
        };
        let draft = Draft::board_item(BoardId::ALL_DESKS, b"{}");
        let key = Secret::new([3; 32]);
        assert_eq!(
            seal(&draft, &slot, &key, &other, &mut SystemEntropy),
            Err(Error::WrongSender)
        );
        assert!(seal(&draft, &slot, &key, &signer, &mut SystemEntropy).is_ok());
    }
}
