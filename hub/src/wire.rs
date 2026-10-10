//! The structs of spec/v1.md that the hub parses, in TLS presentation language with MLS's variable-length
//! vectors (`<V>`, RFC 9420 section 2.1.2). Parsing is strict: minimal length encodings, no trailing bytes, and
//! every struct re-encodes to the bytes it was read from. The hub reads headers and public fields only; nothing
//! here can open a body.
//!
//! Seam for the merge with `trommi-core`: once the core exports these encodings, this module is replaced by it.

use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Malformed(pub &'static str);

pub type Parse<T> = Result<T, Malformed>;

pub struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Reader { bytes, at: 0 }
    }
    pub fn take(&mut self, n: usize) -> Parse<&'a [u8]> {
        let end = self.at.checked_add(n).ok_or(Malformed("length"))?;
        let out = self.bytes.get(self.at..end).ok_or(Malformed("cut short"))?;
        self.at = end;
        Ok(out)
    }
    pub fn u8(&mut self) -> Parse<u8> {
        Ok(self.take(1)?[0])
    }
    pub fn u32(&mut self) -> Parse<u32> {
        Ok(u32::from_be_bytes(
            self.take(4)?.try_into().expect("four bytes"),
        ))
    }
    /// A `uint64` of the wire. Every number the hub stores or compares (epochs, sequence numbers, times) must
    /// fit the database's signed 64 bits; a larger one is refused as malformed, never wrapped.
    pub fn u64(&mut self) -> Parse<u64> {
        let v = u64::from_be_bytes(self.take(8)?.try_into().expect("eight bytes"));
        if v > i64::MAX as u64 {
            return Err(Malformed("a number above 2^63"));
        }
        Ok(v)
    }
    pub fn fixed<const N: usize>(&mut self) -> Parse<[u8; N]> {
        Ok(self.take(N)?.try_into().expect("fixed length"))
    }
    /// The length prefix of a `<V>` vector: one, two or four bytes, the shortest form only.
    fn varint(&mut self) -> Parse<usize> {
        let first = self.u8()?;
        let (value, minimum) = match first >> 6 {
            0 => (usize::from(first & 0x3f), 0),
            1 => (
                (usize::from(first & 0x3f) << 8) | usize::from(self.u8()?),
                64,
            ),
            2 => {
                let rest = self.take(3)?;
                (
                    (usize::from(first & 0x3f) << 24)
                        | (usize::from(rest[0]) << 16)
                        | (usize::from(rest[1]) << 8)
                        | usize::from(rest[2]),
                    16384,
                )
            }
            _ => return Err(Malformed("length prefix")),
        };
        if value < minimum {
            return Err(Malformed("length prefix not minimal"));
        }
        Ok(value)
    }
    pub fn vec(&mut self) -> Parse<&'a [u8]> {
        let n = self.varint()?;
        self.take(n)
    }
    pub fn position(&self) -> usize {
        self.at
    }
    pub fn end(&self) -> Parse<()> {
        if self.at == self.bytes.len() {
            Ok(())
        } else {
            Err(Malformed("trailing bytes"))
        }
    }
}

#[derive(Default)]
pub struct Writer(pub Vec<u8>);

impl Writer {
    pub fn u8(&mut self, v: u8) -> &mut Self {
        self.0.push(v);
        self
    }
    pub fn u32(&mut self, v: u32) -> &mut Self {
        self.0.extend_from_slice(&v.to_be_bytes());
        self
    }
    pub fn u64(&mut self, v: u64) -> &mut Self {
        self.0.extend_from_slice(&v.to_be_bytes());
        self
    }
    pub fn raw(&mut self, v: &[u8]) -> &mut Self {
        self.0.extend_from_slice(v);
        self
    }
    pub fn vec(&mut self, v: &[u8]) -> &mut Self {
        let n = v.len();
        if n < 64 {
            self.0.push(n as u8);
        } else if n < 16384 {
            self.0
                .extend_from_slice(&((n as u16) | 0x4000).to_be_bytes());
        } else {
            assert!(n < 1 << 30, "vector too long for the encoding");
            self.0
                .extend_from_slice(&((n as u32) | 0x8000_0000).to_be_bytes());
        }
        self.0.extend_from_slice(v);
        self
    }
}

pub const ZERO16: [u8; 16] = [0; 16];
pub const ZERO32: [u8; 32] = [0; 32];

/// RFC 9420 section 5.2: `RefHash(label, value) = SHA-256(opaque label<V> ‖ opaque value<V>)`.
pub fn ref_hash(label: &str, value: &[u8]) -> [u8; 32] {
    let mut w = Writer::default();
    w.vec(label.as_bytes()).vec(value);
    Sha256::digest(&w.0).into()
}

/// RFC 9420 section 5.1.2: what `SignWithLabel(key, label, content)` signs.
pub fn sign_content(label: &str, content: &[u8]) -> Vec<u8> {
    let mut w = Writer::default();
    w.vec(format!("MLS 1.0 {label}").as_bytes()).vec(content);
    w.0
}

// ---- group context extensions (section 3) ----

pub const EXT_ROOM: u16 = 0xF001;
pub const EXT_SESSION: u16 = 0xF002;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TrommiRoom {
    pub recovery_signature_key: Vec<u8>,
    pub recovery_hpke_key: Vec<u8>,
    /// enrolled agent devices, ascending, no duplicates
    pub agents: Vec<[u8; 32]>,
}

impl TrommiRoom {
    pub fn parse(bytes: &[u8]) -> Parse<Self> {
        let mut r = Reader::new(bytes);
        let recovery_signature_key = r.vec()?.to_vec();
        let recovery_hpke_key = r.vec()?.to_vec();
        let list = r.vec()?;
        r.end()?;
        if recovery_signature_key.len() != 32 || recovery_hpke_key.len() != 32 {
            return Err(Malformed("recovery key length"));
        }
        if list.len() % 32 != 0 {
            return Err(Malformed("agents length"));
        }
        let agents: Vec<[u8; 32]> = list.chunks(32).map(|c| c.try_into().expect("32")).collect();
        if agents.windows(2).any(|w| w[0] >= w[1]) {
            return Err(Malformed("agents not ascending"));
        }
        Ok(TrommiRoom {
            recovery_signature_key,
            recovery_hpke_key,
            agents,
        })
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut w = Writer::default();
        w.vec(&self.recovery_signature_key)
            .vec(&self.recovery_hpke_key)
            .vec(&self.agents.concat());
        w.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TrommiSession {
    pub room_id: [u8; 32],
    pub session_id: [u8; 16],
    pub parent: [u8; 16],
}

impl TrommiSession {
    pub fn parse(bytes: &[u8]) -> Parse<Self> {
        let mut r = Reader::new(bytes);
        let out = TrommiSession {
            room_id: r.fixed()?,
            session_id: r.fixed()?,
            parent: r.fixed()?,
        };
        r.end()?;
        Ok(out)
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut w = Writer::default();
        w.raw(&self.room_id).raw(&self.session_id).raw(&self.parent);
        w.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cut {
    pub device: [u8; 32],
    pub seq: u64,
    pub hash: [u8; 32],
}

/// The `authenticated_data` of every Commit (3.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitNote {
    pub room_epoch: u64,
    pub room_state: [u8; 32],
    pub time: u64,
    pub cuts: Vec<Cut>,
    pub join: bool,
}

impl CommitNote {
    pub fn parse(bytes: &[u8]) -> Parse<Self> {
        let mut r = Reader::new(bytes);
        if r.u8()? != 2 {
            return Err(Malformed("note version"));
        }
        let room_epoch = r.u64()?;
        let room_state = r.fixed()?;
        let time = r.u64()?;
        let list = r.vec()?;
        let join = match r.u8()? {
            0 => false,
            1 => true,
            _ => return Err(Malformed("join")),
        };
        r.end()?;
        if list.len() % 72 != 0 {
            return Err(Malformed("cuts length"));
        }
        let mut cuts = Vec::new();
        let mut c = Reader::new(list);
        while c.position() < list.len() {
            cuts.push(Cut {
                device: c.fixed()?,
                seq: c.u64()?,
                hash: c.fixed()?,
            });
        }
        if cuts.windows(2).any(|w| w[0].device >= w[1].device) {
            return Err(Malformed("cuts not ascending"));
        }
        Ok(CommitNote {
            room_epoch,
            room_state,
            time,
            cuts,
            join,
        })
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut list = Writer::default();
        for c in &self.cuts {
            list.raw(&c.device).u64(c.seq).raw(&c.hash);
        }
        let mut w = Writer::default();
        w.u8(2)
            .u64(self.room_epoch)
            .raw(&self.room_state)
            .u64(self.time)
            .vec(&list.0)
            .u8(u8::from(self.join));
        w.0
    }
}

// ---- recovery (section 8) ----

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyContext {
    pub group_id: Vec<u8>,
    pub epoch: u64,
    pub group_info: [u8; 32],
}

impl KeyContext {
    fn read(r: &mut Reader) -> Parse<Self> {
        let group_id = r.vec()?;
        if !(group_id.len() == 32 || group_id.len() == 48) {
            return Err(Malformed("group id length"));
        }
        Ok(KeyContext {
            group_id: group_id.to_vec(),
            epoch: r.u64()?,
            group_info: r.fixed()?,
        })
    }
    fn write(&self, w: &mut Writer) {
        w.vec(&self.group_id).u64(self.epoch).raw(&self.group_info);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedKey {
    pub context: KeyContext,
    pub room_epoch: u64,
    pub recovery_hpke_key: Vec<u8>,
    pub kem_output: Vec<u8>,
    pub ciphertext: Vec<u8>,
    pub writer: [u8; 32],
    pub mac: Vec<u8>,
}

impl SealedKey {
    pub fn parse(bytes: &[u8]) -> Parse<Self> {
        let mut r = Reader::new(bytes);
        let out = SealedKey {
            context: KeyContext::read(&mut r)?,
            room_epoch: r.u64()?,
            recovery_hpke_key: r.vec()?.to_vec(),
            kem_output: r.vec()?.to_vec(),
            ciphertext: r.vec()?.to_vec(),
            writer: r.fixed()?,
            mac: r.vec()?.to_vec(),
        };
        r.end()?;
        // X25519 encapsulation, a 32-byte key under ChaCha20-Poly1305, an HMAC-SHA-256 tag or none.
        if out.recovery_hpke_key.len() != 32
            || out.kem_output.len() != 32
            || out.ciphertext.len() != 48
            || !(out.mac.is_empty() || out.mac.len() == 32)
        {
            return Err(Malformed("sealed key lengths"));
        }
        Ok(out)
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut w = Writer::default();
        self.context.write(&mut w);
        w.u64(self.room_epoch)
            .vec(&self.recovery_hpke_key)
            .vec(&self.kem_output)
            .vec(&self.ciphertext)
            .raw(&self.writer)
            .vec(&self.mac);
        w.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryAuth {
    pub base: KeyContext,
    pub room_epoch: u64,
    pub room_state: [u8; 32],
    pub joiner: [u8; 32],
    pub commit: [u8; 32],
    pub signature: Vec<u8>,
}

impl RecoveryAuth {
    pub fn parse(bytes: &[u8]) -> Parse<Self> {
        let mut r = Reader::new(bytes);
        let out = RecoveryAuth {
            base: KeyContext::read(&mut r)?,
            room_epoch: r.u64()?,
            room_state: r.fixed()?,
            joiner: r.fixed()?,
            commit: r.fixed()?,
            signature: r.vec()?.to_vec(),
        };
        r.end()?;
        if out.signature.len() != 64 {
            return Err(Malformed("signature length"));
        }
        Ok(out)
    }
    /// `join ‖ commit`: what the recovery key signed under the label "TrommiRecoveryJoin".
    pub fn signed(&self) -> Vec<u8> {
        let mut w = Writer::default();
        self.base.write(&mut w);
        w.u64(self.room_epoch)
            .raw(&self.room_state)
            .raw(&self.joiner)
            .raw(&self.commit);
        w.0
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut w = Writer(self.signed());
        w.vec(&self.signature);
        w.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryLink {
    pub room_id: [u8; 32],
    pub new_recovery_hpke_key: Vec<u8>,
    pub kem_output: Vec<u8>,
    pub ciphertext: Vec<u8>,
    pub mac: Vec<u8>,
}

impl RecoveryLink {
    pub fn parse(bytes: &[u8]) -> Parse<Self> {
        let mut r = Reader::new(bytes);
        let out = RecoveryLink {
            room_id: r.fixed()?,
            new_recovery_hpke_key: r.vec()?.to_vec(),
            kem_output: r.vec()?.to_vec(),
            ciphertext: r.vec()?.to_vec(),
            mac: r.vec()?.to_vec(),
        };
        r.end()?;
        // OldRecovery is 64 bytes; the tag is always set (a human device writes it).
        if out.new_recovery_hpke_key.len() != 32
            || out.kem_output.len() != 32
            || out.ciphertext.len() != 80
            || out.mac.len() != 32
        {
            return Err(Malformed("recovery link lengths"));
        }
        Ok(out)
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut w = Writer::default();
        w.raw(&self.room_id)
            .vec(&self.new_recovery_hpke_key)
            .vec(&self.kem_output)
            .vec(&self.ciphertext)
            .vec(&self.mac);
        w.0
    }
}

// ---- envelopes (section 9) ----

pub const KIND_ITEM: u8 = 1;
pub const KIND_VERSION: u8 = 2;
pub const KIND_ANSWER: u8 = 3;
pub const KIND_REQUEST: u8 = 4;
pub const KIND_VERDICT: u8 = 5;
pub const KIND_REGISTER: u8 = 6;
pub const KIND_TAKE_BACK: u8 = 7;

pub const TYPE_CARD: u8 = 1;
pub const TYPE_NOTE: u8 = 2;
pub const TYPE_REQUEST: u8 = 3;
pub const TYPE_ARTIFACT: u8 = 4;

pub const STATE_OPEN: u8 = 1;
pub const STATE_ANSWERED: u8 = 2;
pub const STATE_CLOSED: u8 = 3;

pub const TIMELINE_CHAT: u8 = 1;
pub const TIMELINE_BOARD: u8 = 2;
pub const SCOPE_CARD: u8 = 1;
pub const SCOPE_SESSION: u8 = 2;
pub const SCOPE_DESK: u8 = 3;

pub const FLAG_PUSH: u8 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Subject {
    Item {
        timeline_kind: u8,
        timeline_scope: u8,
        timeline_ref: [u8; 16],
    },
    Register {
        register_id: [u8; 16],
    },
    Object {
        object_id: [u8; 16],
        object_type: u8,
        object_state: u8,
        urgency: u8,
        answered_at: u64,
        object_ref: [u8; 32],
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Header {
    pub kind: u8,
    pub flags: u8,
    pub group_id: Vec<u8>,
    pub epoch: u64,
    pub sender: [u8; 32],
    pub seq: u64,
    pub prev: [u8; 32],
    pub recipient: [u8; 32],
    pub time: u64,
    pub subject: Subject,
    pub file_ids: Vec<[u8; 16]>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeaderError {
    Malformed(&'static str),
    NewerVersion,
}

impl From<Malformed> for HeaderError {
    fn from(m: Malformed) -> Self {
        HeaderError::Malformed(m.0)
    }
}

impl Header {
    fn read(r: &mut Reader) -> Result<Self, HeaderError> {
        let version = r.u8()?;
        if version > 2 {
            return Err(HeaderError::NewerVersion);
        }
        if version != 2 {
            return Err(HeaderError::Malformed("version"));
        }
        let kind = r.u8()?;
        let flags = r.u8()?;
        if flags & !FLAG_PUSH != 0 {
            return Err(HeaderError::Malformed("flags"));
        }
        let group_id = r.vec()?.to_vec();
        if !(group_id.len() == 32 || group_id.len() == 48) {
            return Err(HeaderError::Malformed("group id length"));
        }
        let epoch = r.u64()?;
        let sender = r.fixed()?;
        let seq = r.u64()?;
        let prev = r.fixed()?;
        let recipient = r.fixed()?;
        let time = r.u64()?;
        let subject = match kind {
            KIND_ITEM => {
                let (timeline_kind, timeline_scope, timeline_ref) = (r.u8()?, r.u8()?, r.fixed()?);
                let fits = matches!(
                    (timeline_kind, timeline_scope),
                    (TIMELINE_CHAT, SCOPE_CARD)
                        | (TIMELINE_CHAT, SCOPE_SESSION)
                        | (TIMELINE_BOARD, SCOPE_DESK)
                );
                if !fits {
                    return Err(HeaderError::Malformed("timeline"));
                }
                Subject::Item {
                    timeline_kind,
                    timeline_scope,
                    timeline_ref,
                }
            }
            KIND_REGISTER => Subject::Register {
                register_id: r.fixed()?,
            },
            KIND_VERSION | KIND_ANSWER | KIND_REQUEST | KIND_VERDICT | KIND_TAKE_BACK => {
                let s = Subject::Object {
                    object_id: r.fixed()?,
                    object_type: r.u8()?,
                    object_state: r.u8()?,
                    urgency: r.u8()?,
                    answered_at: r.u64()?,
                    object_ref: r.fixed()?,
                };
                if let Subject::Object {
                    object_type,
                    object_state,
                    urgency,
                    ..
                } = &s
                {
                    if !(1..=4).contains(object_type)
                        || !(1..=3).contains(object_state)
                        || *urgency > 3
                    {
                        return Err(HeaderError::Malformed("object fields"));
                    }
                }
                s
            }
            // 9.0.4: kinds 8 to 255 are reserved, writers and the hub refuse them.
            _ => return Err(HeaderError::Malformed("kind")),
        };
        let files = r.vec()?;
        if files.len() % 16 != 0 || files.len() / 16 > 255 {
            return Err(HeaderError::Malformed("file ids"));
        }
        let file_ids: Vec<[u8; 16]> = files
            .chunks(16)
            .map(|c| c.try_into().expect("16"))
            .collect();
        if seq == 0 {
            return Err(HeaderError::Malformed("seq"));
        }
        Ok(Header {
            kind,
            flags,
            group_id,
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

    pub fn parse(bytes: &[u8]) -> Result<Self, HeaderError> {
        let mut r = Reader::new(bytes);
        let h = Self::read(&mut r)?;
        r.end()?;
        Ok(h)
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut w = Writer::default();
        w.u8(2)
            .u8(self.kind)
            .u8(self.flags)
            .vec(&self.group_id)
            .u64(self.epoch);
        w.raw(&self.sender)
            .u64(self.seq)
            .raw(&self.prev)
            .raw(&self.recipient)
            .u64(self.time);
        match &self.subject {
            Subject::Item {
                timeline_kind,
                timeline_scope,
                timeline_ref,
            } => {
                w.u8(*timeline_kind).u8(*timeline_scope).raw(timeline_ref);
            }
            Subject::Register { register_id } => {
                w.raw(register_id);
            }
            Subject::Object {
                object_id,
                object_type,
                object_state,
                urgency,
                answered_at,
                object_ref,
            } => {
                w.raw(object_id)
                    .u8(*object_type)
                    .u8(*object_state)
                    .u8(*urgency)
                    .u64(*answered_at)
                    .raw(object_ref);
            }
        }
        w.vec(&self.file_ids.concat());
        w.0
    }

    pub fn push(&self) -> bool {
        self.flags & FLAG_PUSH != 0
    }
}

/// An envelope as posted or served. `body` is the ciphertext of a full envelope; a pruned one carries only its
/// hash. Both forms give the same `envelope_hash` and verify under the same signature (9.0.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Envelope {
    pub header: Header,
    pub header_bytes: Vec<u8>,
    pub nonce: [u8; 12],
    pub body: Option<Vec<u8>>,
    pub body_hash: [u8; 32],
    pub signature: Vec<u8>,
}

impl Envelope {
    pub fn parse(bytes: &[u8]) -> Result<Self, HeaderError> {
        let mut r = Reader::new(bytes);
        let form = r.u8()?;
        let start = r.position();
        let header = Header::read(&mut r)?;
        let header_bytes = bytes[start..r.position()].to_vec();
        let nonce = r.fixed()?;
        let (body, body_hash) = match form {
            1 => {
                let c = r.vec()?;
                (Some(c.to_vec()), Sha256::digest(c).into())
            }
            2 => (None, r.fixed()?),
            _ => return Err(HeaderError::Malformed("form")),
        };
        let signature = r.vec()?.to_vec();
        r.end()?;
        if signature.len() != 64 {
            return Err(HeaderError::Malformed("signature length"));
        }
        Ok(Envelope {
            header,
            header_bytes,
            nonce,
            body,
            body_hash,
            signature,
        })
    }

    pub fn hash(&self) -> [u8; 32] {
        envelope_hash(&self.header_bytes, &self.nonce, &self.body_hash)
    }
}

pub fn envelope_hash(header: &[u8], nonce: &[u8], body_hash: &[u8]) -> [u8; 32] {
    let mut v = Vec::with_capacity(header.len() + 44);
    v.extend_from_slice(header);
    v.extend_from_slice(nonce);
    v.extend_from_slice(body_hash);
    ref_hash("Trommi Envelope", &v)
}

/// The bytes of an envelope from its stored parts; pruned when there is no body.
pub fn encode_envelope(
    header: &[u8],
    nonce: &[u8],
    body: Option<&[u8]>,
    body_hash: &[u8],
    signature: &[u8],
) -> Vec<u8> {
    let mut w = Writer::default();
    w.u8(if body.is_some() { 1 } else { 2 })
        .raw(header)
        .raw(nonce);
    match body {
        Some(b) => w.vec(b),
        None => w.raw(body_hash),
    };
    w.vec(signature);
    w.0
}

/// `object_id` of an object's first version: the first 16 bytes of
/// `RefHash("Trommi Object", group_id ‖ sender ‖ seq)`.
pub fn object_id(group_id: &[u8], sender: &[u8; 32], seq: u64) -> [u8; 16] {
    let mut v = group_id.to_vec();
    v.extend_from_slice(sender);
    v.extend_from_slice(&seq.to_be_bytes());
    ref_hash("Trommi Object", &v)[..16].try_into().expect("16")
}

// ---- sign-in and invites (section 12) ----

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HubAuth {
    pub room_id: [u8; 32],
    pub hub: Vec<u8>,
    pub device: [u8; 32],
    pub challenge: [u8; 32],
}

impl HubAuth {
    pub fn parse(bytes: &[u8]) -> Parse<Self> {
        let mut r = Reader::new(bytes);
        let out = HubAuth {
            room_id: r.fixed()?,
            hub: r.vec()?.to_vec(),
            device: r.fixed()?,
            challenge: r.fixed()?,
        };
        r.end()?;
        Ok(out)
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut w = Writer::default();
        w.raw(&self.room_id)
            .vec(&self.hub)
            .raw(&self.device)
            .raw(&self.challenge);
        w.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Offer {
    pub room_id: [u8; 32],
    pub invite_id: [u8; 16],
    pub role: u8,
    pub session_id: [u8; 16],
    pub expires_at: u64,
    pub commitment: [u8; 32],
    pub inviter: [u8; 32],
    pub room_epoch: u64,
    pub room_state: [u8; 32],
}

impl Offer {
    pub fn parse(bytes: &[u8]) -> Parse<Self> {
        let mut r = Reader::new(bytes);
        let out = Offer {
            room_id: r.fixed()?,
            invite_id: r.fixed()?,
            role: r.u8()?,
            session_id: r.fixed()?,
            expires_at: r.u64()?,
            commitment: r.fixed()?,
            inviter: r.fixed()?,
            room_epoch: r.u64()?,
            room_state: r.fixed()?,
        };
        r.end()?;
        if !(1..=2).contains(&out.role) || (out.role == 1 && out.session_id != ZERO16) {
            return Err(Malformed("role"));
        }
        Ok(out)
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut w = Writer::default();
        w.raw(&self.room_id)
            .raw(&self.invite_id)
            .u8(self.role)
            .raw(&self.session_id)
            .u64(self.expires_at);
        w.raw(&self.commitment)
            .raw(&self.inviter)
            .u64(self.room_epoch)
            .raw(&self.room_state);
        w.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteRequest {
    pub room_id: [u8; 32],
    pub invite_id: [u8; 16],
    pub hub: Vec<u8>,
    pub role: u8,
    pub key_package: Vec<u8>,
    pub offer_hash: [u8; 32],
}

impl InviteRequest {
    pub fn parse(bytes: &[u8]) -> Parse<Self> {
        let mut r = Reader::new(bytes);
        let out = InviteRequest {
            room_id: r.fixed()?,
            invite_id: r.fixed()?,
            hub: r.vec()?.to_vec(),
            role: r.u8()?,
            key_package: r.vec()?.to_vec(),
            offer_hash: r.fixed()?,
        };
        r.end()?;
        Ok(out)
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut w = Writer::default();
        w.raw(&self.room_id)
            .raw(&self.invite_id)
            .vec(&self.hub)
            .u8(self.role)
            .vec(&self.key_package)
            .raw(&self.offer_hash);
        w.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reveal {
    pub invite_id: [u8; 16],
    pub nonce: [u8; 32],
    pub request_hash: [u8; 32],
}

impl Reveal {
    pub fn parse(bytes: &[u8]) -> Parse<Self> {
        let mut r = Reader::new(bytes);
        let out = Reveal {
            invite_id: r.fixed()?,
            nonce: r.fixed()?,
            request_hash: r.fixed()?,
        };
        r.end()?;
        Ok(out)
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut w = Writer::default();
        w.raw(&self.invite_id)
            .raw(&self.nonce)
            .raw(&self.request_hash);
        w.0
    }
}
