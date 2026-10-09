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
                // A sealed body within the limit has one of nine lengths. A longer one is refused later, with
                // its own code, by whoever chains the envelope.
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
                let choices: Vec<Opaque> = bind.choices.iter().cloned().map(Opaque).collect();
                writer.vector(&choices)?;
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

/// The fields of an answer's payload that repeat its bind.
#[derive(Deserialize)]
struct AnswerChoices {
    #[serde(default)]
    choices: Option<Vec<String>>,
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
        let mut writer = Writer::new();
        writer.u8(VERSION);
        writer.opaque(&self.bind.encode()?)?;
        writer.opaque(&self.payload)?;
        let mut padded = Zeroizing::new(writer.into_bytes());
        let len = bucket(padded.len()).ok_or(Error::TooLarge)?;
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
}

/// A sealed envelope with its hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sealed {
    /// The envelope, in full form.
    pub envelope: Envelope,
    /// Its `envelope_hash`: the `prev` of the sender's next envelope in the group.
    pub hash: Hash32,
}

/// Seals `draft` at `slot` under `key`, the content key of the slot's group and epoch, with a fresh random
/// nonce, and signs it. `wrong-sender` unless `signer` is the slot's sender; `too-large` for a payload above
/// [`MAX_PAYLOAD_LEN`], a body that does not fit the largest padded size, or more than [`MAX_FILE_IDS`] files;
/// `bad-format` for a payload that is not a JSON object, or a version whose `previous_version_hash` is not the
/// one its header names.
pub fn seal(
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
pub(crate) mod testing {
    //! What the tests of the stored-content modules share: a repeatable random source, devices with keys, and
    //! payloads.

    use super::*;

    /// A repeatable source of bytes (SplitMix64): for tests only.
    pub(crate) struct TestEntropy(pub u64);

    impl Entropy for TestEntropy {
        fn fill(&mut self, out: &mut [u8]) -> Result<(), Error> {
            for chunk in out.chunks_mut(8) {
                self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
                let mut z = self.0;
                z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
                z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
                z ^= z >> 31;
                for (to, from) in chunk.iter_mut().zip(z.to_be_bytes()) {
                    *to = from;
                }
            }
            Ok(())
        }
    }

    /// A source that gives nothing.
    pub(crate) struct NoEntropy;

    impl Entropy for NoEntropy {
        fn fill(&mut self, _: &mut [u8]) -> Result<(), Error> {
            Err(Error::Entropy)
        }
    }

    /// The signature key of test device `n`.
    pub(crate) fn signer(n: u8) -> SigningKey {
        SigningKey::from_seed(Secret::new([n; 32]))
    }

    /// The id of test device `n`.
    pub(crate) fn device(n: u8) -> DeviceId {
        DeviceId::new(signer(n).public())
    }

    /// The content key of test epoch `epoch`.
    pub(crate) fn key(epoch: u64) -> Secret<32> {
        let mut bytes = [0x4B; 32];
        for (to, from) in bytes.iter_mut().zip(epoch.to_be_bytes()) {
            *to = from;
        }
        Secret::new(bytes)
    }

    /// A payload: a JSON object with one text field.
    pub(crate) fn payload(text: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({ "schema_version": 2, "text": text })).unwrap()
    }

    /// The payload of a version that follows `previous`.
    pub(crate) fn version_payload(previous: &Hash32, extra: serde_json::Value) -> Vec<u8> {
        let mut object = extra;
        object["previous_version_hash"] = previous.to_base64url().into();
        serde_json::to_vec(&object).unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;
    use crate::ids::RoomId;
    use serde_json::json;

    fn room_group() -> GroupId {
        GroupId::room(RoomId::new([1; 32]))
    }

    fn session_group() -> GroupId {
        GroupId::session(RoomId::new([1; 32]), SessionId::new([2; 16]))
    }

    fn slot(group: GroupId, sender: u8, seq: u64, prev: Hash32) -> Slot {
        Slot {
            group,
            epoch: 3,
            sender: device(sender),
            seq,
            prev,
            time: 1_700_000_000_000,
        }
    }

    fn sealed(draft: &Draft, slot: &Slot) -> Sealed {
        let sender = (1..=9).find(|n| device(*n) == slot.sender).unwrap();
        seal(
            draft,
            slot,
            &key(slot.epoch),
            &signer(sender),
            &mut TestEntropy(slot.seq),
        )
        .unwrap()
    }

    fn fields(object_ref: Hash32) -> ObjectFields {
        ObjectFields {
            object_id: ObjectId::new([7; 16]),
            object_type: ObjectType::Card,
            state: ObjectState::Open,
            urgency: Urgency::High,
            answered_at: 0,
            object_ref,
        }
    }

    /// One draft of each kind, with the group it belongs in.
    fn one_of_each() -> Vec<(GroupId, Draft)> {
        let version = Hash32::new([9; 32]);
        let answer_bind = AnswerBind {
            object_id: ObjectId::new([7; 16]),
            version_hash: version,
            choices: vec![b"yes".to_vec(), b"later".to_vec()],
        };
        let verdict_bind = VerdictBind {
            request_id: ObjectId::new([8; 16]),
            request_hash: Hash32::new([10; 32]),
            expires_at: 99,
            verdict: Verdict::Deny,
        };
        let take_back_bind = TakeBackBind {
            object_id: ObjectId::new([7; 16]),
            previous_hash: Hash32::new([11; 32]),
            version_hash: version,
        };
        vec![
            (
                session_group(),
                Draft::session_chat(SessionId::new([2; 16]), device(2), &payload("hello")),
            ),
            (
                session_group(),
                Draft::card_chat(ObjectId::new([7; 16]), DeviceId::ZERO, &payload("on it")),
            ),
            (
                room_group(),
                Draft::board_item(BoardId::ALL_DESKS, &payload("stroke")),
            ),
            (
                room_group(),
                Draft::register(RegisterId::new([5; 16]), &payload("register")),
            ),
            (
                session_group(),
                Draft::first_version(
                    ObjectType::Card,
                    Urgency::High,
                    &version_payload(&Hash32::ZERO, json!({ "title": "Ship it?" })),
                )
                .unwrap()
                .with_push()
                .with_files(vec![FileId::new([3; 16]), FileId::new([4; 16])]),
            ),
            (
                session_group(),
                Draft::later_version(
                    ObjectId::new([7; 16]),
                    ObjectType::Artifact,
                    true,
                    Urgency::Low,
                    version,
                    &version_payload(&version, json!({ "title": "Report" })),
                )
                .unwrap(),
            ),
            (
                session_group(),
                Draft::request(Urgency::Critical, 99, &payload("run tests")).with_push(),
            ),
            (
                session_group(),
                Draft::answer(answer_bind, false, Urgency::High, device(2), &payload("a")),
            ),
            (
                session_group(),
                Draft::verdict(verdict_bind, Urgency::Normal, device(2), &payload("v")),
            ),
            (
                session_group(),
                Draft::take_back(take_back_bind, Urgency::High, device(2), &payload("t")),
            ),
        ]
    }

    #[test]
    fn every_kind_round_trips_full_and_pruned() {
        for (index, (group, draft)) in one_of_each().into_iter().enumerate() {
            let slot = slot(group, 1, index as u64 + 1, Hash32::new([index as u8; 32]));
            let sealed = sealed(&draft, &slot);
            let bytes = sealed.envelope.encode().unwrap();
            let decoded = Envelope::decode(&bytes).unwrap();
            assert_eq!(decoded, sealed.envelope);
            assert_eq!(decoded.encode().unwrap(), bytes);
            assert_eq!(decoded.verify().unwrap(), sealed.hash);

            let body = decoded.open(&key(3)).unwrap();
            assert_eq!(body.payload(), draft.payload.as_slice());
            assert_eq!(format!("{body:?}"), "Body(<redacted>)");

            let pruned = decoded.prune().unwrap();
            assert!(pruned.is_pruned());
            assert_eq!(pruned.hash().unwrap(), sealed.hash);
            assert_eq!(pruned.verify().unwrap(), sealed.hash);
            assert_eq!(pruned.open(&key(3)), Err(Error::Pruned));
            let pruned_bytes = pruned.encode().unwrap();
            assert!(pruned_bytes.len() < 400);
            assert_eq!(Envelope::decode(&pruned_bytes).unwrap(), pruned);
            assert_eq!(pruned.prune().unwrap(), pruned);
        }
    }

    #[test]
    fn the_header_is_laid_out_as_the_format_says() {
        let draft = Draft::board_item(BoardId::ALL_DESKS, &payload("x"));
        let sealed = sealed(&draft, &slot(room_group(), 1, 5, Hash32::new([6; 32])));
        let bytes = codec::encode(&sealed.envelope.header).unwrap();
        let expected = [
            &[2u8, 1, 0, 32][..],
            &[1; 32],
            &3u64.to_be_bytes(),
            device(1).as_bytes(),
            &5u64.to_be_bytes(),
            &[6; 32],
            &[0; 32],
            &1_700_000_000_000u64.to_be_bytes(),
            &[2, 3],
            BoardId::ALL_DESKS.as_bytes(),
            &[0],
        ]
        .concat();
        assert_eq!(bytes, expected);

        // An envelope: form, header, nonce, the sealed body behind its length, the signature behind its length.
        let envelope = sealed.envelope.encode().unwrap();
        assert_eq!(envelope[0], 1);
        assert_eq!(&envelope[1..1 + bytes.len()], bytes.as_slice());
        let after_nonce = 1 + bytes.len() + NONCE_LEN;
        // 272 bytes of ciphertext need a two-byte length: 0x4110.
        assert_eq!(&envelope[after_nonce..after_nonce + 2], [0x41, 0x10]);
        // So do the 64 bytes of the signature: 0x4040.
        assert_eq!(envelope.len(), after_nonce + 2 + 272 + 2 + SIGNATURE_LEN);
        assert_eq!(&envelope[envelope.len() - 66..][..2], [0x40, 0x40]);

        // The object block of the other kinds is 59 bytes.
        let draft = Draft::request(Urgency::Low, 1, &payload("x"));
        let header = draft
            .header(&slot(room_group(), 1, 5, Hash32::ZERO))
            .unwrap();
        assert_eq!(
            codec::encode(&header).unwrap().len(),
            bytes.len() - 18 + OBJECT_BLOCK_LEN
        );
    }

    #[test]
    fn the_kind_sets_the_object_fields_from_the_bind() {
        let drafts = one_of_each();
        let header = |index: usize| {
            let (group, draft) = &drafts[index];
            draft.header(&slot(*group, 1, 4, Hash32::ZERO)).unwrap()
        };
        let object = |index: usize| *header(index).subject.object().unwrap();

        let first = object(4);
        assert_eq!(
            first.object_id,
            object_id(&session_group(), &device(1), 4).unwrap()
        );
        assert_eq!(
            (first.state, first.object_ref, first.answered_at),
            (ObjectState::Open, Hash32::ZERO, 0)
        );
        assert!(header(4).push);
        assert_eq!(header(4).file_ids.len(), 2);

        let later = object(5);
        assert_eq!(
            (later.state, later.object_ref, later.object_type),
            (
                ObjectState::Closed,
                Hash32::new([9; 32]),
                ObjectType::Artifact
            )
        );

        let request = object(6);
        assert_eq!(
            request.object_id,
            object_id(&session_group(), &device(1), 4).unwrap()
        );
        assert_eq!(
            (request.object_type, request.state, request.object_ref),
            (ObjectType::Request, ObjectState::Open, Hash32::ZERO)
        );

        let answer = object(7);
        assert_eq!(
            (answer.state, answer.object_ref, answer.answered_at),
            (
                ObjectState::Answered,
                Hash32::new([9; 32]),
                1_700_000_000_000
            )
        );
        assert_eq!(header(7).recipient, device(2));

        let verdict = object(8);
        assert_eq!(
            (verdict.state, verdict.object_ref, verdict.object_type),
            (
                ObjectState::Closed,
                Hash32::new([10; 32]),
                ObjectType::Request
            )
        );

        let take_back = object(9);
        assert_eq!(
            (take_back.state, take_back.object_ref),
            (ObjectState::Open, Hash32::new([9; 32]))
        );
        assert_eq!(header(3).subject.kind(), 6);
        assert_eq!(header(0).subject.kind(), 1);
        assert!(header(0).subject.object().is_none());
    }

    #[test]
    fn the_object_id_follows_from_group_sender_and_number() {
        let id = object_id(&session_group(), &device(1), 1).unwrap();
        let input = [
            session_group().as_bytes(),
            device(1).as_bytes(),
            &1u64.to_be_bytes(),
        ]
        .concat();
        let hash = crypto::ref_hash("Trommi Object", &input).unwrap();
        assert_eq!(id.as_bytes(), &hash.as_bytes()[..16]);
        assert_ne!(id, object_id(&session_group(), &device(1), 2).unwrap());
        assert_ne!(id, object_id(&session_group(), &device(2), 1).unwrap());
        assert_ne!(id, object_id(&room_group(), &device(1), 1).unwrap());
    }

    #[test]
    fn hash_and_signature_are_the_labelled_ones() {
        let draft = Draft::board_item(BoardId::ALL_DESKS, &payload("x"));
        let sealed = sealed(&draft, &slot(room_group(), 1, 1, Hash32::ZERO));
        let Content::Full(ciphertext) = &sealed.envelope.content else {
            panic!("full form");
        };
        let input = [
            codec::encode(&sealed.envelope.header).unwrap().as_slice(),
            &sealed.envelope.nonce,
            crypto::sha256(ciphertext).unwrap().as_bytes(),
        ]
        .concat();
        assert_eq!(
            sealed.hash,
            crypto::ref_hash("Trommi Envelope", &input).unwrap()
        );
        crypto::verify_with_label(
            device(1).as_bytes(),
            "TrommiEnvelope",
            sealed.hash.as_bytes(),
            &sealed.envelope.signature,
        )
        .unwrap();
        // The body is sealed with the header as associated data.
        let padded = crypto::aead_open(
            &key(3),
            &sealed.envelope.nonce,
            &codec::encode(&sealed.envelope.header).unwrap(),
            ciphertext,
        )
        .unwrap();
        assert_eq!(padded.len(), 256);
        assert_eq!(padded[0], 2);
    }

    #[test]
    fn padding_fills_exactly_the_next_bucket() {
        assert_eq!(bucket(0), Some(256));
        assert_eq!(bucket(256), Some(256));
        assert_eq!(bucket(257), Some(512));
        assert_eq!(bucket(65_536), Some(65_536));
        assert_eq!(bucket(65_537), None);
        assert_eq!(bucket(usize::MAX), None);

        for (text_len, padded_len) in [
            (10, 256),
            (220, 256),
            (300, 512),
            (900, 1024),
            (40_000, 65_536),
        ] {
            let payload = payload(&"a".repeat(text_len));
            let draft = Draft::board_item(BoardId::ALL_DESKS, &payload);
            let sealed = sealed(&draft, &slot(room_group(), 1, 1, Hash32::ZERO));
            let Content::Full(ciphertext) = &sealed.envelope.content else {
                panic!("full form");
            };
            assert_eq!(ciphertext.len(), padded_len + TAG_LEN, "{text_len}");
            assert_eq!(sealed.envelope.open(&key(3)).unwrap().payload(), payload);
        }

        // A body of exactly 256 bytes is not padded: version (1), bind length (1), payload length (2), 252.
        let exact = format!("{{\"t\":\"{}\"}}", "a".repeat(244));
        assert_eq!(exact.len(), 252);
        let body = Body::new(Bind::None, exact.as_bytes()).unwrap();
        assert_eq!(body.pad().unwrap().len(), 256);
        let one_more = format!("{{\"t\":\"{}\"}}", "a".repeat(245));
        let body = Body::new(Bind::None, one_more.as_bytes()).unwrap();
        assert_eq!(body.pad().unwrap().len(), 512);
    }

    /// An envelope whose padded plaintext is `padded`, sealed and signed like a real one.
    fn with_plaintext(subject: Subject, padded: &[u8]) -> Envelope {
        let header = Header {
            push: false,
            group: session_group(),
            epoch: 3,
            sender: device(1),
            seq: 1,
            prev: Hash32::ZERO,
            recipient: DeviceId::ZERO,
            time: 5,
            subject,
            file_ids: Vec::new(),
        };
        let nonce = [7; NONCE_LEN];
        let aad = codec::encode(&header).unwrap();
        let ciphertext = crypto::aead_seal(&key(3), &nonce, &aad, padded).unwrap();
        let mut envelope = Envelope {
            header,
            nonce,
            content: Content::Full(ciphertext),
            signature: [0; SIGNATURE_LEN],
        };
        let hash = envelope.hash().unwrap();
        envelope.signature = crypto::sign_with_label(&signer(1), LABEL_SIGNATURE, hash.as_bytes())
            .unwrap()
            .try_into()
            .unwrap();
        envelope
    }

    fn padded_to(body: &[u8], len: usize) -> Vec<u8> {
        let mut padded = body.to_vec();
        padded.resize(len, 0);
        padded
    }

    /// `body` padded as the format says.
    fn padded(body: &[u8]) -> Vec<u8> {
        padded_to(body, bucket(body.len()).unwrap())
    }

    fn raw_body(version: u8, bind: &[u8], payload: &[u8]) -> Vec<u8> {
        let mut writer = Writer::new();
        writer.u8(version);
        writer.opaque(bind).unwrap();
        writer.opaque(payload).unwrap();
        writer.into_bytes()
    }

    #[test]
    fn open_refuses_bad_padding_binds_and_payloads() {
        let item = Subject::Item(Timeline::SessionChat(SessionId::new([2; 16])));
        let good = raw_body(2, &[], b"{}");
        let open = |subject: Subject, padded: &[u8]| with_plaintext(subject, padded).open(&key(3));

        assert!(open(item, &padded(&good)).is_ok());
        // A larger bucket than the body needs.
        assert_eq!(open(item, &padded_to(&good, 512)), Err(Error::BadFormat));
        // A byte of the padding is not zero.
        let mut dirty = padded(&good);
        dirty[255] = 1;
        assert_eq!(open(item, &dirty), Err(Error::BadFormat));
        let mut dirty = padded(&good);
        dirty[good.len()] = 0x80;
        assert_eq!(open(item, &dirty), Err(Error::BadFormat));
        // Body versions.
        assert_eq!(
            open(item, &padded(&raw_body(3, &[], b"{}"))),
            Err(Error::NewerVersion)
        );
        assert_eq!(
            open(item, &padded(&raw_body(1, &[], b"{}"))),
            Err(Error::BadFormat)
        );
        // Payloads that are not a JSON object.
        for payload in [&b""[..], b"[]", b"1", b"{", b"{} x", b"\xff", b"null"] {
            assert_eq!(
                open(item, &padded(&raw_body(2, &[], payload))),
                Err(Error::BadFormat),
                "{payload:?}"
            );
        }
        // A payload above the limit, in a body that still fits the largest bucket.
        let long = format!("{{\"t\":\"{}\"}}", "a".repeat(60_000));
        assert_eq!(
            open(item, &padded(&raw_body(2, &[], long.as_bytes()))),
            Err(Error::BadFormat)
        );
        // A key twice, at any depth; a schema this version does not know.
        for payload in [
            &br#"{"a":1,"a":2}"#[..],
            br#"{"a":{"b":1,"b":1}}"#,
            br#"{"a":[{"b":1,"b":2}]}"#,
            br#"{"schema_version":"2"}"#,
            br#"{"schema_version":-1}"#,
        ] {
            assert_eq!(
                open(item, &padded(&raw_body(2, &[], payload))),
                Err(Error::BadFormat),
                "{payload:?}"
            );
        }
        assert_eq!(
            open(item, &padded(&raw_body(2, &[], br#"{"schema_version":3}"#))),
            Err(Error::NewerVersion)
        );
        assert!(open(
            item,
            &padded(&raw_body(2, &[], br#"{"schema_version":2,"a":{"a":1}}"#))
        )
        .is_ok());
        // An item carries no bind.
        assert_eq!(
            open(item, &padded(&raw_body(2, &[0; 24], b"{}"))),
            Err(Error::BadFormat)
        );
        // A truncated body.
        assert_eq!(
            open(item, &padded_to(&[2, 5, 1], 256)),
            Err(Error::BadFormat)
        );
        assert_eq!(open(item, &[0; 256]), Err(Error::BadFormat));
    }

    #[test]
    fn open_checks_each_bind_against_its_kind_and_header() {
        let reference = Hash32::new([9; 32]);
        let block = fields(reference);
        let open = |subject: Subject, bind: &Bind| {
            let body = raw_body(2, &bind.encode().unwrap(), b"{}");
            with_plaintext(subject, &padded(&body)).open(&key(3))
        };
        let answer = AnswerBind {
            object_id: block.object_id,
            version_hash: reference,
            choices: vec![b"a".to_vec()],
        };
        let request = RequestBind {
            request_id: block.object_id,
            expires_at: 7,
        };
        let verdict = VerdictBind {
            request_id: block.object_id,
            request_hash: reference,
            expires_at: 7,
            verdict: Verdict::Allow,
        };
        let take_back = TakeBackBind {
            object_id: block.object_id,
            previous_hash: Hash32::new([4; 32]),
            version_hash: reference,
        };

        let body = open(Subject::Answer(block), &Bind::Answer(answer.clone())).unwrap();
        assert_eq!(body.bind(), &Bind::Answer(answer.clone()));
        let body = open(Subject::Request(block), &Bind::Request(request)).unwrap();
        assert_eq!(body.bind(), &Bind::Request(request));
        let body = open(Subject::Verdict(block), &Bind::Verdict(verdict)).unwrap();
        assert_eq!(body.bind(), &Bind::Verdict(verdict));
        let body = open(Subject::TakeBack(block), &Bind::TakeBack(take_back)).unwrap();
        assert_eq!(body.bind(), &Bind::TakeBack(take_back));

        // An answer whose choices are not text, or not those its payload names.
        let with_payload = |bind: &AnswerBind, payload: &[u8]| {
            let body = raw_body(2, &Bind::Answer(bind.clone()).encode().unwrap(), payload);
            with_plaintext(Subject::Answer(block), &padded(&body)).open(&key(3))
        };
        assert!(with_payload(&answer, br#"{"choices":["a"]}"#).is_ok());
        assert_eq!(
            with_payload(&answer, br#"{"choices":["b"]}"#).err(),
            Some(Error::BadFormat)
        );
        assert_eq!(
            with_payload(&answer, br#"{"choices":[]}"#).err(),
            Some(Error::BadFormat)
        );
        assert_eq!(
            with_payload(&answer, br#"{"choices":"a"}"#).err(),
            Some(Error::BadFormat)
        );
        let not_text = AnswerBind {
            choices: vec![vec![0xFF]],
            ..answer.clone()
        };
        assert_eq!(with_payload(&not_text, b"{}").err(), Some(Error::BadFormat));
        // A bind of another kind, or none.
        assert_eq!(
            open(Subject::Answer(block), &Bind::TakeBack(take_back)),
            Err(Error::BadFormat)
        );
        assert_eq!(
            open(Subject::Verdict(block), &Bind::None),
            Err(Error::BadFormat)
        );
        assert_eq!(
            open(Subject::Request(block), &Bind::Verdict(verdict)),
            Err(Error::BadFormat)
        );
        // A bind that names another object or another reference than the header.
        let other_object = ObjectId::new([8; 16]);
        let other_hash = Hash32::new([5; 32]);
        let cases = [
            (
                Subject::Answer(block),
                Bind::Answer(AnswerBind {
                    object_id: other_object,
                    ..answer.clone()
                }),
            ),
            (
                Subject::Answer(block),
                Bind::Answer(AnswerBind {
                    version_hash: other_hash,
                    ..answer.clone()
                }),
            ),
            (
                Subject::Request(block),
                Bind::Request(RequestBind {
                    request_id: other_object,
                    ..request
                }),
            ),
            (
                Subject::Verdict(block),
                Bind::Verdict(VerdictBind {
                    request_id: other_object,
                    ..verdict
                }),
            ),
            (
                Subject::Verdict(block),
                Bind::Verdict(VerdictBind {
                    request_hash: other_hash,
                    ..verdict
                }),
            ),
            (
                Subject::TakeBack(block),
                Bind::TakeBack(TakeBackBind {
                    object_id: other_object,
                    ..take_back
                }),
            ),
            (
                Subject::TakeBack(block),
                Bind::TakeBack(TakeBackBind {
                    version_hash: other_hash,
                    ..take_back
                }),
            ),
        ];
        for (subject, bind) in cases {
            assert_eq!(open(subject, &bind), Err(Error::BadFormat), "{bind:?}");
        }
    }

    #[test]
    fn binds_are_read_strictly() {
        let block = fields(Hash32::new([9; 32]));
        let open = |subject: Subject, bind: &[u8]| {
            with_plaintext(subject, &padded(&raw_body(2, bind, b"{}"))).open(&key(3))
        };
        let verdict = [&[7u8; 16][..], &[9; 32], &7u64.to_be_bytes()].concat();
        assert!(open(
            Subject::Verdict(block),
            &[verdict.as_slice(), &[1]].concat()
        )
        .is_ok());
        for byte in [0u8, 3, 255] {
            let bind = [verdict.as_slice(), &[byte]].concat();
            assert_eq!(open(Subject::Verdict(block), &bind), Err(Error::BadFormat));
        }
        // Trailing bytes and missing bytes.
        let bind = [verdict.as_slice(), &[1, 0]].concat();
        assert_eq!(open(Subject::Verdict(block), &bind), Err(Error::BadFormat));
        assert_eq!(
            open(Subject::Verdict(block), &verdict),
            Err(Error::BadFormat)
        );
        assert_eq!(
            open(Subject::Request(block), &[7; 23]),
            Err(Error::BadFormat)
        );
        assert_eq!(
            open(Subject::Request(block), &[7; 25]),
            Err(Error::BadFormat)
        );

        // Choices: at most 64, each at most 256 bytes.
        let answer = |choices: Vec<Vec<u8>>| {
            let mut writer = Writer::new();
            writer.fixed(&[7; 16]);
            writer.fixed(&[9; 32]);
            let choices: Vec<Opaque> = choices.into_iter().map(Opaque).collect();
            writer.vector(&choices).unwrap();
            writer.into_bytes()
        };
        assert!(open(Subject::Answer(block), &answer(vec![vec![1; 256]; 64])).is_ok());
        assert!(open(Subject::Answer(block), &answer(Vec::new())).is_ok());
        assert_eq!(
            open(Subject::Answer(block), &answer(vec![vec![1]; 65])),
            Err(Error::BadFormat)
        );
        assert_eq!(
            open(Subject::Answer(block), &answer(vec![vec![1; 257]])),
            Err(Error::BadFormat)
        );
        // The same limits for a writer.
        for choices in [vec![vec![1u8]; 65], vec![vec![1u8; 257]]] {
            let bind = AnswerBind {
                object_id: block.object_id,
                version_hash: block.object_ref,
                choices,
            };
            let draft = Draft::answer(bind, false, Urgency::Low, device(2), b"{}");
            let result = seal(
                &draft,
                &slot(session_group(), 1, 1, Hash32::ZERO),
                &key(3),
                &signer(1),
                &mut TestEntropy(1),
            );
            assert_eq!(result, Err(Error::TooLarge));
        }
    }

    #[test]
    fn a_version_names_its_predecessor_in_header_and_payload() {
        let previous = Hash32::new([9; 32]);
        let seal_version = |draft: Draft| {
            seal(
                &draft,
                &slot(session_group(), 1, 2, Hash32::ZERO),
                &key(3),
                &signer(1),
                &mut TestEntropy(2),
            )
        };
        let later = |payload: &[u8]| {
            Draft::later_version(
                ObjectId::new([7; 16]),
                ObjectType::Card,
                false,
                Urgency::Low,
                previous,
                payload,
            )
            .unwrap()
        };
        assert!(seal_version(later(&version_payload(&previous, json!({})))).is_ok());
        let cases = [
            version_payload(&Hash32::new([8; 32]), json!({})),
            version_payload(&Hash32::ZERO, json!({})),
            b"{}".to_vec(),
            br#"{"previous_version_hash":null}"#.to_vec(),
            br#"{"previous_version_hash":7}"#.to_vec(),
            br#"{"previous_version_hash":"not base64!"}"#.to_vec(),
            format!(
                r#"{{"previous_version_hash":"{0}","previous_version_hash":"{0}"}}"#,
                previous.to_base64url()
            )
            .into_bytes(),
        ];
        for payload in cases {
            assert_eq!(seal_version(later(&payload)), Err(Error::BadFormat));
        }
        // The first version names zeros.
        let first =
            |payload: &[u8]| Draft::first_version(ObjectType::Note, Urgency::Low, payload).unwrap();
        assert!(seal_version(first(&version_payload(&Hash32::ZERO, json!({})))).is_ok());
        assert_eq!(
            seal_version(first(&version_payload(&previous, json!({})))),
            Err(Error::BadFormat)
        );

        // A reader holds a received version to the same rule.
        let body = raw_body(2, &[], &version_payload(&Hash32::new([8; 32]), json!({})));
        let envelope = with_plaintext(Subject::Version(fields(previous)), &padded(&body));
        assert_eq!(envelope.open(&key(3)), Err(Error::BadFormat));
        let body = raw_body(2, &[], &version_payload(&previous, json!({})));
        let envelope = with_plaintext(Subject::Version(fields(previous)), &padded(&body));
        assert!(envelope.open(&key(3)).is_ok());
    }

    #[test]
    fn drafts_refuse_what_no_kind_allows() {
        assert!(Draft::first_version(ObjectType::Request, Urgency::Low, b"{}").is_err());
        assert!(Draft::later_version(
            ObjectId::new([7; 16]),
            ObjectType::Request,
            false,
            Urgency::Low,
            Hash32::new([1; 32]),
            b"{}"
        )
        .is_err());
        assert!(Draft::later_version(
            ObjectId::new([7; 16]),
            ObjectType::Card,
            false,
            Urgency::Low,
            Hash32::ZERO,
            b"{}"
        )
        .is_err());
        // No header of a reserved kind is written under a known kind's number.
        let mut header = Draft::board_item(BoardId::ALL_DESKS, b"{}")
            .header(&slot(room_group(), 1, 1, Hash32::ZERO))
            .unwrap();
        header.subject = Subject::Reserved {
            kind: 7,
            block: [0; OBJECT_BLOCK_LEN],
        };
        assert_eq!(codec::encode(&header), Err(Error::BadFormat));
    }

    #[test]
    fn seal_refuses_oversize_wrong_signer_and_failing_entropy() {
        let slot = slot(room_group(), 1, 1, Hash32::ZERO);
        let try_seal = |draft: &Draft| seal(draft, &slot, &key(3), &signer(1), &mut TestEntropy(1));

        let at_limit = format!("{{\"t\":\"{}\"}}", "a".repeat(MAX_PAYLOAD_LEN - 8));
        assert_eq!(at_limit.len(), MAX_PAYLOAD_LEN);
        let draft = Draft::board_item(BoardId::ALL_DESKS, at_limit.as_bytes());
        let sealed = try_seal(&draft).unwrap();
        assert_eq!(
            sealed.envelope.open(&key(3)).unwrap().payload(),
            at_limit.as_bytes()
        );
        let over = format!("{{\"t\":\"{}\"}}", "a".repeat(MAX_PAYLOAD_LEN - 7));
        let draft = Draft::board_item(BoardId::ALL_DESKS, over.as_bytes());
        assert_eq!(try_seal(&draft), Err(Error::TooLarge));

        // A payload within its limit whose bind pushes the body over the largest padded size.
        let bind = AnswerBind {
            object_id: ObjectId::new([7; 16]),
            version_hash: Hash32::new([9; 32]),
            choices: vec![vec![1; 256]; 64],
        };
        let draft = Draft::answer(bind, false, Urgency::Low, device(2), at_limit.as_bytes());
        assert_eq!(try_seal(&draft), Err(Error::TooLarge));

        let files = |n: usize| {
            Draft::board_item(BoardId::ALL_DESKS, b"{}").with_files(vec![FileId::new([1; 16]); n])
        };
        assert_eq!(
            try_seal(&files(255))
                .unwrap()
                .envelope
                .header
                .file_ids
                .len(),
            255
        );
        assert_eq!(try_seal(&files(256)), Err(Error::TooLarge));

        let draft = Draft::board_item(BoardId::ALL_DESKS, b"{}");
        assert_eq!(
            seal(&draft, &slot, &key(3), &signer(2), &mut TestEntropy(1)),
            Err(Error::WrongSender)
        );
        assert_eq!(
            seal(&draft, &slot, &key(3), &signer(1), &mut NoEntropy),
            Err(Error::Entropy)
        );
        let draft = Draft::board_item(BoardId::ALL_DESKS, b"not json");
        assert_eq!(try_seal(&draft), Err(Error::BadFormat));
    }

    #[test]
    fn nonces_are_fresh_and_the_wrong_key_or_header_opens_nothing() {
        let draft = Draft::board_item(BoardId::ALL_DESKS, &payload("x"));
        let slot = slot(room_group(), 1, 1, Hash32::ZERO);
        let mut entropy = TestEntropy(42);
        let first = seal(&draft, &slot, &key(3), &signer(1), &mut entropy).unwrap();
        let second = seal(&draft, &slot, &key(3), &signer(1), &mut entropy).unwrap();
        assert_ne!(first.envelope.nonce, second.envelope.nonce);
        assert_ne!(first.hash, second.hash);

        assert_eq!(first.envelope.open(&key(4)), Err(Error::DecryptFailed));
        let mut moved = first.envelope.clone();
        moved.header.time += 1;
        assert_eq!(moved.open(&key(3)), Err(Error::DecryptFailed));
        let mut moved = first.envelope.clone();
        moved.nonce[0] ^= 1;
        assert_eq!(moved.open(&key(3)), Err(Error::DecryptFailed));
        let mut moved = first.envelope.clone();
        if let Content::Full(ciphertext) = &mut moved.content {
            ciphertext[0] ^= 1;
        }
        assert_eq!(moved.open(&key(3)), Err(Error::DecryptFailed));
    }

    #[test]
    fn any_change_breaks_the_signature() {
        let draft = Draft::session_chat(SessionId::new([2; 16]), device(2), &payload("x"));
        let sealed = sealed(&draft, &slot(session_group(), 1, 1, Hash32::ZERO));
        let bytes = sealed.envelope.encode().unwrap();
        let pruned = sealed.envelope.prune().unwrap().encode().unwrap();
        for original in [bytes, pruned] {
            let mut refused = 0;
            for index in (0..original.len()).step_by(3) {
                let mut changed = original.clone();
                changed[index] ^= 0x01;
                match Envelope::decode(&changed) {
                    Ok(envelope) => {
                        assert_eq!(envelope.verify(), Err(Error::BadSignature), "byte {index}");
                    }
                    Err(error) => {
                        assert!(
                            matches!(error, Error::BadFormat | Error::NewerVersion),
                            "byte {index}: {error}"
                        );
                        refused += 1;
                    }
                }
            }
            assert!(refused > 0);
        }
        let mut other = sealed.envelope.clone();
        other.header.sender = device(2);
        assert_eq!(other.verify(), Err(Error::BadSignature));
    }

    /// The decoding of an item in a session group after `change` to its encoding.
    fn changed(change: impl FnOnce(&mut Vec<u8>)) -> Result<Envelope, Error> {
        let draft = Draft::session_chat(SessionId::new([2; 16]), device(2), &payload("x"));
        let sealed = sealed(&draft, &slot(session_group(), 1, 1, Hash32::ZERO));
        let mut bytes = sealed.envelope.encode().unwrap();
        change(&mut bytes);
        Envelope::decode(&bytes)
    }

    #[test]
    fn decode_refuses_versions_flags_kinds_and_values() {
        // Offsets: form 0, version 1, kind 2, flags 3, group length 4, group 5..53, epoch 53, sender 61,
        // seq 93, prev 101, recipient 133, time 165, timeline kind 173, scope 174, ref 175, file ids 191.
        assert!(changed(|_| {}).is_ok());
        assert_eq!(changed(|b| b[1] = 3), Err(Error::NewerVersion));
        assert_eq!(changed(|b| b[1] = 255), Err(Error::NewerVersion));
        assert_eq!(changed(|b| b[1] = 1), Err(Error::BadFormat));
        assert_eq!(changed(|b| b[1] = 0), Err(Error::BadFormat));
        assert_eq!(changed(|b| b[2] = 0), Err(Error::BadFormat));
        for flags in [2u8, 3, 0x80, 0xFF] {
            assert_eq!(changed(|b| b[3] = flags), Err(Error::BadFormat));
        }
        assert!(changed(|b| b[3] = 1).unwrap().header.push);
        // The form.
        assert_eq!(changed(|b| b[0] = 0), Err(Error::BadFormat));
        assert_eq!(changed(|b| b[0] = 3), Err(Error::BadFormat));
        // A number of zero.
        assert_eq!(
            changed(|b| b[93..101].copy_from_slice(&[0; 8])),
            Err(Error::BadFormat)
        );
        // Timeline kinds and scopes: only chat/card, chat/session and board/desk exist.
        for (kind, scope) in [(0, 2), (3, 2), (1, 0), (1, 3), (2, 1), (2, 2), (2, 4)] {
            assert_eq!(
                changed(|b| {
                    b[173] = kind;
                    b[174] = scope;
                }),
                Err(Error::BadFormat),
                "{kind}/{scope}"
            );
        }
        for (kind, scope) in [(1, 1), (1, 2), (2, 3)] {
            assert!(changed(|b| {
                b[173] = kind;
                b[174] = scope;
            })
            .is_ok());
        }
        // A group id that is neither 32 nor 48 bytes.
        assert_eq!(changed(|b| b[4] = 47), Err(Error::BadFormat));
    }

    #[test]
    fn decode_refuses_object_values_outside_the_table() {
        let header = Header {
            push: false,
            group: session_group(),
            epoch: 0,
            sender: device(1),
            seq: 1,
            prev: Hash32::ZERO,
            recipient: DeviceId::ZERO,
            time: 0,
            subject: Subject::Answer(fields(Hash32::new([9; 32]))),
            file_ids: Vec::new(),
        };
        let encoded = codec::encode(&header).unwrap();
        assert_eq!(codec::decode::<Header>(&encoded, 4096).unwrap(), header);
        // The object block starts at 172: id (16), type 188, state 189, urgency 190.
        let raw = |offset: usize, value: u8| {
            let mut bytes = encoded.clone();
            bytes[offset] = value;
            codec::decode::<Header>(&bytes, 4096)
        };
        for value in [0u8, 5, 255] {
            assert_eq!(raw(188, value), Err(Error::BadFormat), "type {value}");
        }
        for value in [0u8, 4, 255] {
            assert_eq!(raw(189, value), Err(Error::BadFormat), "state {value}");
        }
        for value in [4u8, 255] {
            assert_eq!(raw(190, value), Err(Error::BadFormat), "urgency {value}");
        }
        for value in 1..=4u8 {
            assert!(raw(188, value).is_ok());
        }
        for value in 1..=3u8 {
            assert!(raw(189, value).is_ok());
        }
        // `answered_at` is 0 while open.
        let mut answered = encoded.clone();
        answered[198] = 1;
        assert_eq!(
            codec::decode::<Header>(&answered, 4096),
            Err(Error::BadFormat)
        );
        answered[189] = 2;
        assert!(codec::decode::<Header>(&answered, 4096).is_ok());
        for value in 0..=3u8 {
            assert!(raw(190, value).is_ok());
        }
        assert_eq!(ObjectType::from_byte(4), Ok(ObjectType::Artifact));
        assert_eq!(Verdict::from_byte(2), Ok(Verdict::Deny));
        assert_eq!(Urgency::Critical.byte(), 3);
    }

    #[test]
    fn reserved_kinds_parse_with_the_object_block_and_open_nothing() {
        let header = Header {
            push: true,
            group: room_group(),
            epoch: 3,
            sender: device(1),
            seq: 2,
            prev: Hash32::new([1; 32]),
            recipient: DeviceId::ZERO,
            time: 9,
            // Values no known kind allows: a newer Trommi may give them a meaning.
            subject: Subject::Reserved {
                kind: 8,
                block: [0xEE; OBJECT_BLOCK_LEN],
            },
            file_ids: vec![FileId::new([3; 16])],
        };
        for kind in [8u8, 100, 255] {
            let mut header = header.clone();
            header.subject = Subject::Reserved {
                kind,
                block: [0xEE; OBJECT_BLOCK_LEN],
            };
            let bytes = codec::encode(&header).unwrap();
            let decoded = codec::decode::<Header>(&bytes, 4096).unwrap();
            assert_eq!(decoded, header);
            assert!(decoded.subject.is_reserved());
            assert_eq!(decoded.subject.kind(), kind);
            assert!(decoded.subject.object().is_none());
        }
        let envelope = with_plaintext(header.subject, &padded(&raw_body(2, &[], b"{}")));
        envelope.verify().unwrap();
        assert_eq!(envelope.open(&key(3)), Err(Error::NewerVersion));
        // A known kind with the same block is refused: its values are judged.
        let mut bytes = codec::encode(&header).unwrap();
        bytes[1] = 2;
        assert_eq!(codec::decode::<Header>(&bytes, 4096), Err(Error::BadFormat));
    }

    #[test]
    fn decode_refuses_truncated_trailing_and_oversize_input() {
        let draft = Draft::first_version(
            ObjectType::Card,
            Urgency::High,
            &version_payload(&Hash32::ZERO, json!({})),
        )
        .unwrap()
        .with_files(vec![FileId::new([3; 16])]);
        let sealed = sealed(&draft, &slot(session_group(), 1, 1, Hash32::ZERO));
        for bytes in [
            sealed.envelope.encode().unwrap(),
            sealed.envelope.prune().unwrap().encode().unwrap(),
        ] {
            for len in 0..bytes.len() {
                assert!(Envelope::decode(&bytes[..len]).is_err(), "cut at {len}");
            }
            let mut longer = bytes.clone();
            longer.push(0);
            assert_eq!(Envelope::decode(&longer), Err(Error::BadFormat));
        }
        assert_eq!(
            Envelope::decode(&vec![0; MAX_ENVELOPE_LEN + 1]),
            Err(Error::TooLarge)
        );
        assert_eq!(Envelope::decode(&[]), Err(Error::BadFormat));
    }

    #[test]
    fn decode_refuses_bad_ciphertext_lengths_signatures_and_file_lists() {
        let draft = Draft::board_item(BoardId::ALL_DESKS, &payload("x"));
        let sealed = sealed(&draft, &slot(room_group(), 1, 1, Hash32::ZERO));
        let rebuilt = |content: Content| {
            let mut envelope = sealed.envelope.clone();
            envelope.content = content;
            Envelope::decode(&envelope.encode().unwrap())
        };
        for len in [0usize, 15, 16, 271, 273, 300, 512, 65_536, 65_551] {
            assert_eq!(
                rebuilt(Content::Full(vec![0; len])),
                Err(Error::BadFormat),
                "{len}"
            );
        }
        for len in [272usize, 528, 65_552] {
            assert!(rebuilt(Content::Full(vec![0; len])).is_ok(), "{len}");
        }
        // Longer than any padded body: read, marked, and never opened.
        let oversize = rebuilt(Content::Full(vec![0; 65_553])).unwrap();
        assert!(oversize.is_oversize());
        assert_eq!(oversize.open(&key(3)), Err(Error::TooLarge));

        // A signature of another length.
        let bytes = sealed.envelope.encode().unwrap();
        let front = &bytes[..bytes.len() - 66];
        for len in [0usize, 63, 65] {
            let mut writer = Writer::new();
            writer.fixed(front);
            writer.opaque(&vec![5; len]).unwrap();
            let changed = writer.into_bytes();
            assert_eq!(Envelope::decode(&changed), Err(Error::BadFormat), "{len}");
        }

        // File ids: whole ids only, at most 255.
        let header_with_files = |content: &[u8]| {
            let mut bytes = codec::encode(&sealed.envelope.header).unwrap();
            bytes.pop();
            let mut writer = Writer::new();
            writer.opaque(content).unwrap();
            bytes.extend(writer.into_bytes());
            codec::decode::<Header>(&bytes, 8192)
        };
        assert_eq!(header_with_files(&[1; 15]), Err(Error::BadFormat));
        assert_eq!(header_with_files(&[1; 17]), Err(Error::BadFormat));
        assert_eq!(
            header_with_files(&[1; 16 * 255]).unwrap().file_ids.len(),
            255
        );
        assert_eq!(header_with_files(&[1; 16 * 256]), Err(Error::BadFormat));
        let mut too_many = sealed.envelope.header.clone();
        too_many.file_ids = vec![FileId::new([1; 16]); 256];
        assert_eq!(codec::encode(&too_many), Err(Error::TooLarge));
        let mut zero = sealed.envelope.header.clone();
        zero.seq = 0;
        assert_eq!(codec::encode(&zero), Err(Error::BadFormat));
    }

    #[test]
    fn hostile_bytes_never_panic() {
        let mut entropy = TestEntropy(7);
        let draft = Draft::request(Urgency::Low, 5, &payload("x"));
        let valid = sealed(&draft, &slot(session_group(), 1, 1, Hash32::ZERO))
            .envelope
            .encode()
            .unwrap();
        for round in 0..3000usize {
            let bytes = if round % 2 == 0 {
                let mut bytes = valid.clone();
                let mut places = [0u8; 8];
                entropy.fill(&mut places).unwrap();
                for pair in places.chunks(2) {
                    let index = (usize::from(pair[0]) * 3) % bytes.len().min(400);
                    bytes[index] = pair[1];
                }
                bytes
            } else {
                let mut len = [0u8; 2];
                entropy.fill(&mut len).unwrap();
                let mut bytes = vec![0u8; usize::from(u16::from_be_bytes(len)) % 600];
                entropy.fill(&mut bytes).unwrap();
                bytes
            };
            if let Ok(envelope) = Envelope::decode(&bytes) {
                assert_eq!(envelope.encode().unwrap(), bytes);
                let _ = envelope.verify();
                let _ = envelope.open(&key(3));
                let _ = envelope.prune();
            }
        }
    }
}
