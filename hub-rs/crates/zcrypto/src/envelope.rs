//! Envelopes (FORMAT.md section 9): header grammar, the receiver checks that need no key, the pruned form,
//! and (for the vectors) sender keys, bodies and binds.

use crate::bytes::{arr16, bytes_equal, hex, is_zero, unhex, R, W};
use crate::log::{LogState, Member};
use crate::prim::{hash, hkdf, sha256, verify};
use crate::{fail, label, obj, ZError, ZResult, ROLE_HUMAN, VERSION};

pub const KIND_TIMELINE_ITEM: u8 = 1;
pub const KIND_OBJECT_VERSION: u8 = 2;
pub const KIND_ANSWER: u8 = 3;
pub const KIND_PERMISSION_REQUEST: u8 = 4;
pub const KIND_VERDICT: u8 = 5;
pub const KIND_STATUS: u8 = 6;
pub const KIND_DECIDE_AGAIN: u8 = 7;
pub const KIND_MAX: u8 = 7;
pub const TIMELINE_CHAT: u8 = 1;
pub const TIMELINE_SCRIBBLE: u8 = 2;
pub const SCOPE_CARD: u8 = 1;
pub const SCOPE_SESSION: u8 = 2;
pub const SCOPE_DESK: u8 = 3;
pub const TIMELINE_ID_MAX: usize = 40;
pub const KEY_SCOPE_ROOM: u8 = 0;
pub const KEY_SCOPE_SESSION: u8 = 1;
pub const SEEN_MAX: usize = 64;
pub const CARD_OPEN: u8 = 1;
pub const URGENCY_HIGH: u8 = 2;
const FLAG_PUSH: u8 = 1;
const FLAG_OBJECT: u8 = 2;
pub const NONCE_LEN: usize = 12;

pub fn is_known_kind(kind: u8) -> bool { (1..=KIND_MAX).contains(&kind) }
fn is_object_kind(kind: u8) -> bool { matches!(kind, 2 | 3 | 4 | 5 | 7) }
pub fn is_thread_kind(kind: u8) -> bool { kind == KIND_TIMELINE_ITEM }

/// `card/<32 hex>`, `session/…`, `desk/…` -> (scope, ref); anything else is refused.
pub fn parse_timeline_id(text: &str) -> ZResult<(u8, [u8; 16])> {
    let bad = || fail("bad-argument", "timeline id: card/, session/ or desk/ and 32 lowercase hex characters");
    let (scope, rest) = text.split_once('/').ok_or_else(bad)?;
    let scope = match scope {
        "card" => SCOPE_CARD,
        "session" => SCOPE_SESSION,
        "desk" => SCOPE_DESK,
        _ => return Err(bad()),
    };
    if !crate::bytes::is_hex(rest, 32) {
        return Err(bad());
    }
    Ok((scope, arr16(&unhex(rest)?)))
}
pub fn timeline_id_of(scope: u8, r: &[u8]) -> String {
    let name = match scope { SCOPE_CARD => "card", SCOPE_SESSION => "session", _ => "desk" };
    format!("{}/{}", name, hex(r))
}

#[derive(Clone, Debug)]
pub struct Seen {
    pub sender: [u8; 32],
    pub seq: u64,
    pub hash: [u8; 32],
}
#[derive(Clone, Debug)]
pub struct Card {
    pub id: [u8; 16],
    pub state: u8,
    pub urgency: u8,
    pub answered_at: u64,
}
#[derive(Clone, Debug)]
pub struct Header {
    pub push: bool,
    pub room_id: [u8; 32],
    pub epoch: u32,
    pub key_scope: u8,
    pub session_id: Option<[u8; 16]>,
    pub sender: [u8; 32],
    pub seq: u64,
    pub prev: [u8; 32],
    pub log_seq: u32,
    pub log_hash: [u8; 32],
    pub recipient: [u8; 32],
    pub time: u64,
    pub kind: u8,
    pub seen: Vec<Seen>,
    pub card: Option<Card>,
    pub timeline_kind: Option<u8>,
    pub timeline_id: Option<String>,
    pub blobs: Vec<[u8; 16]>,
    pub is_head: bool,
    pub known_kind: bool,
}

fn check_version(v: u8, what: &str) -> ZResult<()> {
    if v != VERSION {
        return Err(fail(if v > VERSION { "newer-version" } else { "bad-version" }, &format!("{what} version {v}")));
    }
    Ok(())
}

fn check_grammar(h: &Header, strict_kinds: bool) -> ZResult<()> {
    let bad = |what: &str| fail("bad-format", what);
    let known = is_known_kind(h.kind);
    if !known && (strict_kinds || h.kind < 1) {
        return Err(bad(&format!("unknown envelope kind {}", h.kind)));
    }
    if h.key_scope != KEY_SCOPE_ROOM && h.key_scope != KEY_SCOPE_SESSION {
        return Err(bad("unknown key scope"));
    }
    let thread = is_thread_kind(h.kind);
    if known && is_object_kind(h.kind) != h.card.is_some() {
        return Err(bad(if is_object_kind(h.kind) { "this kind needs the object block" } else { "this kind has no object block" }));
    }
    if thread != h.timeline_id.is_some() {
        return Err(bad(if thread { "a timeline item needs a timeline" } else { "only timeline items have a timeline" }));
    }
    if thread {
        let tk = h.timeline_kind.unwrap_or(0);
        if tk < 1 {
            return Err(bad("timeline kind"));
        }
        // parseTimelineId refuses with bad-argument in JS too
        let (scope, r) = parse_timeline_id(h.timeline_id.as_ref().unwrap())?;
        if scope == SCOPE_SESSION && (h.key_scope != KEY_SCOPE_SESSION || h.session_id.map(|s| s != r).unwrap_or(true)) {
            return Err(bad("a session's timeline is sent under that session's key"));
        }
        if scope == SCOPE_DESK && h.key_scope != KEY_SCOPE_ROOM {
            return Err(bad("a desk is sent under the room key"));
        }
    }
    if h.seen.len() > SEEN_MAX {
        return Err(bad(&format!("seen lists at most {SEEN_MAX} senders")));
    }
    Ok(())
}

pub fn decode_header(bytes: &[u8], strict_kinds: bool) -> ZResult<Header> {
    let mut r = R::new(bytes);
    check_version(r.u8()?, "envelope header")?;
    let flags = r.u8()?;
    if flags & !(FLAG_PUSH | FLAG_OBJECT) != 0 {
        return Err(fail("bad-format", "unknown header flags"));
    }
    let room_id = r.take32()?;
    let epoch = r.u32()?;
    let key_scope = r.u8()?;
    if key_scope > 1 {
        return Err(fail("bad-format", "unknown key scope"));
    }
    let session_id = if key_scope == KEY_SCOPE_SESSION { Some(r.take16()?) } else { None };
    let sender = r.take32()?;
    let seq = r.u64()?;
    let prev = r.take32()?;
    let log_seq = r.u32()?;
    let log_hash = r.take32()?;
    let recipient = r.take32()?;
    let time = r.u64()?;
    let kind = r.u8()?;
    let n = r.u16()? as usize;
    if n > SEEN_MAX {
        return Err(fail("bad-format", &format!("seen lists at most {SEEN_MAX} senders")));
    }
    let mut seen: Vec<Seen> = Vec::with_capacity(n);
    for i in 0..n {
        let s = Seen { sender: r.take32()?, seq: r.u64()?, hash: r.take32()? };
        if i > 0 && seen[i - 1].sender >= s.sender {
            return Err(fail("bad-format", "seen not strictly ascending"));
        }
        seen.push(s);
    }
    let card = if flags & FLAG_OBJECT != 0 {
        let c = Card { id: r.take16()?, state: r.u8()?, urgency: r.u8()?, answered_at: r.u64()? };
        if !(1..=3).contains(&c.state) {
            return Err(fail("bad-format", "unknown card state"));
        }
        if c.urgency > 3 {
            return Err(fail("bad-format", "unknown urgency"));
        }
        Some(c)
    } else {
        None
    };
    let (mut timeline_kind, mut timeline_id) = (None, None);
    if is_thread_kind(kind) {
        timeline_kind = Some(r.u8()?);
        let scope = r.u8()?;
        if !(1..=3).contains(&scope) {
            return Err(fail("bad-format", "unknown timeline scope"));
        }
        timeline_id = Some(timeline_id_of(scope, r.take(16)?));
    }
    let nb = r.u8()?;
    let mut blobs = Vec::with_capacity(nb as usize);
    for _ in 0..nb {
        blobs.push(r.take16()?);
    }
    r.end()?;
    if seq < 1 {
        return Err(fail("bad-format", "sequence numbers start at 1"));
    }
    let h = Header {
        push: flags & FLAG_PUSH != 0, room_id, epoch, key_scope, session_id, sender, seq, prev, log_seq, log_hash, recipient, time, kind, seen, card,
        timeline_kind, timeline_id, blobs, is_head: !is_thread_kind(kind), known_kind: is_known_kind(kind),
    };
    check_grammar(&h, strict_kinds)?;
    Ok(h)
}

/// The parts of an envelope's wire form.
#[derive(Clone, Debug)]
pub struct Split {
    pub header_bytes: Vec<u8>,
    pub nonce: [u8; 12],
    pub ct: Option<Vec<u8>>,
    pub ct_hash: Option<[u8; 32]>,
    pub signature: [u8; 64],
    pub pruned: bool,
}
pub fn split_envelope(bytes: &[u8]) -> ZResult<Split> {
    let mut r = R::new(bytes);
    check_version(r.u8()?, "envelope")?;
    let ty = r.u8()?;
    if ty != obj::ENVELOPE && ty != obj::ENVELOPE_PRUNED {
        return Err(fail("bad-format", "not an envelope"));
    }
    let header_bytes = r.var16()?.to_vec();
    let nonce: [u8; 12] = r.take(NONCE_LEN)?.try_into().unwrap();
    let pruned = ty == obj::ENVELOPE_PRUNED;
    let ct = if pruned { None } else { Some(r.var32()?.to_vec()) };
    let ct_hash = if pruned { Some(r.take32()?) } else { None };
    let signature: [u8; 64] = r.take(64)?.try_into().unwrap();
    r.end()?;
    if let Some(c) = &ct {
        if c.len() < 16 {
            return Err(fail("bad-format", "ciphertext shorter than its tag"));
        }
    }
    Ok(Split { header_bytes, nonce, ct, ct_hash, signature, pruned })
}

#[derive(Debug)]
pub struct Peek {
    pub header: Header,
    pub split: Split,
}
/// Read the cleartext header without verifying anything.
pub fn peek_envelope(bytes: &[u8], strict_kinds: bool) -> ZResult<Peek> {
    let split = split_envelope(bytes)?;
    Ok(Peek { header: decode_header(&split.header_bytes, strict_kinds)?, split })
}

/// The wire form from its parts: full with `ciphertext`, pruned with only `ciphertext_hash`.
pub fn join_envelope(header_bytes: &[u8], nonce: &[u8], ciphertext: Option<&[u8]>, ciphertext_hash: &[u8], signature: &[u8]) -> Vec<u8> {
    match ciphertext {
        Some(ct) => W::new().u8(VERSION).u8(obj::ENVELOPE).var16(header_bytes).raw(nonce).var32(ct).raw(signature).done(),
        None => W::new().u8(VERSION).u8(obj::ENVELOPE_PRUNED).var16(header_bytes).raw(nonce).raw(ciphertext_hash).raw(signature).done(),
    }
}
/// Header, nonce, hash of the ciphertext, signature: still verifiable.
pub fn prune_envelope(bytes: &[u8]) -> ZResult<Vec<u8>> {
    let e = split_envelope(bytes)?;
    match &e.ct {
        None => Ok(bytes.to_vec()),
        Some(ct) => Ok(join_envelope(&e.header_bytes, &e.nonce, None, &sha256(&[ct]), &e.signature)),
    }
}

/// object_id = first 16 bytes of H("trommi/v1/object-id", creator id || u64 sequence of version 1).
pub fn object_id_of(creator: &[u8], seq: u64) -> [u8; 16] {
    arr16(&hash(label::OBJECT_ID, &[creator, &seq.to_be_bytes()]))
}

/// What a receiver knows of one sender's chain: the newest accepted number and hash, and older hashes on request.
pub trait ChainLookup {
    /// (seq, hash) of the newest accepted envelope of this sender, or None if never seen.
    fn head(&self, sender: &[u8; 32]) -> Option<(u64, [u8; 32])>;
    /// The hash this receiver accepted under (sender, seq), if it knows it.
    fn hash_at(&self, sender: &[u8; 32], seq: u64) -> Option<[u8; 32]>;
}

#[derive(Debug)]
pub struct Verified {
    pub header: Header,
    pub hash: [u8; 32],
    pub ciphertext_hash: [u8; 32],
    pub split: Split,
    pub member_role: u8,
    pub chain_start: bool,
}

/// Everything about an envelope that needs no key (FORMAT.md section 9, receiver checks 1-9). Never commits.
pub fn verify_envelope(bytes: &[u8], state: &LogState, chains: &dyn ChainLookup, allow_chain_start: bool, allow_removed_sender: bool, strict_kinds: bool) -> ZResult<Verified> {
    let e = split_envelope(bytes)?;
    let h = decode_header(&e.header_bytes, strict_kinds)?;
    if !bytes_equal(&h.room_id, &state.room_id) {
        return Err(fail("wrong-room", "envelope of another room"));
    }
    if h.log_seq > state.head_seq {
        return Err(fail("log-behind", &format!("the sender knows log entry {}, this device only {}", h.log_seq, state.head_seq)));
    }
    if !bytes_equal(&state.hashes[h.log_seq as usize], &h.log_hash) {
        return Err(fail("log-fork", &format!("the sender has a different log entry {}", h.log_seq)));
    }
    let member: &Member = state.member_at(&h.sender, Some(h.log_seq)).ok_or_else(|| fail("not-member", "the sender was not a member at the log state it names"))?;
    if h.key_scope == KEY_SCOPE_ROOM {
        if member.role != ROLE_HUMAN {
            return Err(fail("forbidden", "agents hold no room key"));
        }
        if state.epoch_at(h.log_seq) != h.epoch {
            return Err(fail("wrong-epoch", "the epoch does not match the log state the sender names"));
        }
    }
    let now = state.members.get(&h.sender).unwrap();
    let removed_now = now.removed_seq.is_some();
    if removed_now {
        if !allow_removed_sender {
            return Err(fail("removed-sender", "the sender has been removed since"));
        }
        if let Some((cs, _)) = now.cut {
            if h.seq > cs {
                return Err(fail("removed-sender", "beyond the cut its removal names"));
            }
        }
    }
    for s in &h.seen {
        if state.member_at(&s.sender, Some(h.log_seq)).is_none() {
            return Err(fail("bad-format", "seen names a sender that was not active at the named log state"));
        }
    }
    let ct_hash = match &e.ct {
        Some(ct) => sha256(&[ct]),
        None => e.ct_hash.unwrap(),
    };
    let env_hash = hash(label::ENVELOPE, &[&e.header_bytes, &e.nonce, &ct_hash]);
    if !verify(&member.sign_pub, label::ENVELOPE_SIG, &env_hash, &e.signature) {
        return Err(fail("bad-signature", "envelope"));
    }
    if removed_now {
        if let Some((cs, ch)) = now.cut {
            if h.seq == cs && !bytes_equal(&ch, &env_hash) {
                return Err(fail("equivocation", "not the envelope the removal cut names"));
            }
        }
    }
    let mut chain_start = false;
    match chains.head(&h.sender) {
        None => {
            if h.seq == 1 {
                if !is_zero(&h.prev) {
                    return Err(fail("chain-break", "the first envelope names a predecessor"));
                }
            } else if allow_chain_start {
                chain_start = true;
            } else {
                return Err(fail("gap", &format!("first envelope seen from this sender has number {}", h.seq)));
            }
        }
        Some((cseq, chash)) => {
            if h.seq <= cseq {
                if let Some(known) = chains.hash_at(&h.sender, h.seq) {
                    if !bytes_equal(&known, &env_hash) {
                        return Err(fail("equivocation", &format!("two different envelopes with number {} from one sender", h.seq)));
                    }
                }
                return Err(fail("replay", &format!("envelope {} was already accepted", h.seq)));
            } else if h.seq > cseq + 1 {
                return Err(fail("gap", &format!("envelope {} arrived, {} is missing", h.seq, cseq + 1)));
            } else if !bytes_equal(&h.prev, &chash) {
                return Err(fail("chain-break", "the predecessor hash does not match the envelope accepted before"));
            }
        }
    }
    for s in &h.seen {
        if bytes_equal(&s.sender, &h.sender) {
            return Err(fail("bad-format", "a sender cannot list itself as seen"));
        }
        if let Some(known) = chains.hash_at(&s.sender, s.seq) {
            if !bytes_equal(&known, &s.hash) {
                return Err(fail("equivocation", "the sender saw a different envelope than this device under the same number"));
            }
        }
    }
    let member_role = member.role;
    Ok(Verified { header: h, hash: env_hash, ciphertext_hash: ct_hash, split: e, member_role, chain_start })
}

// ---- keys, bodies and binds (clients; used by the vector tests) ---------------------------------

/// HKDF(scope key, salt = room id, label, scope || [session id] || epoch u32 || sender id).
pub fn derive_sender_key(room_id: &[u8], key: &[u8], epoch: u32, sender: &[u8], session_id: Option<&[u8]>) -> Vec<u8> {
    let mut ctx = match session_id {
        Some(s) => {
            let mut v = vec![1u8];
            v.extend_from_slice(s);
            v
        }
        None => vec![0u8],
    };
    ctx.extend_from_slice(&epoch.to_be_bytes());
    ctx.extend_from_slice(sender);
    hkdf(key, room_id, label::SENDER_KEY, &ctx, 32)
}
pub fn padded_length(n: usize) -> usize {
    if n > 65536 {
        return n.div_ceil(65536) * 65536;
    }
    let mut size = 256;
    while size < n {
        size *= 2;
    }
    size
}
pub struct Body {
    pub bind: Vec<u8>,
    pub payload: Vec<u8>,
}
pub fn decode_body(bytes: &[u8]) -> ZResult<Body> {
    let mut r = R::new(bytes);
    check_version(r.u8()?, "envelope body")?;
    let bind = r.var16()?.to_vec();
    let payload = r.var32()?.to_vec();
    let used = bytes.len() - r.left();
    if padded_length(used) != bytes.len() {
        return Err(fail("bad-format", "wrong padding length"));
    }
    if !is_zero(r.take(r.left())?) {
        return Err(fail("bad-format", "padding is not zero"));
    }
    if payload.starts_with(&[0xef, 0xbb, 0xbf]) {
        return Err(fail("bad-format", "the payload starts with a byte order mark"));
    }
    Ok(Body { bind, payload })
}
/// Decrypt a full envelope's body with the scope key of its header (no chain, no signature: the caller verified).
pub fn open_body(bytes: &[u8], room_id: &[u8], scope_key: &[u8]) -> ZResult<(Header, Body)> {
    let e = split_envelope(bytes)?;
    let h = decode_header(&e.header_bytes, false)?;
    let ct = e.ct.as_ref().ok_or_else(|| fail("pruned", "the ciphertext of this envelope was deleted"))?;
    let key = derive_sender_key(room_id, scope_key, h.epoch, &h.sender, h.session_id.as_ref().map(|s| &s[..]));
    let plain = crate::prim::gcm_open(&key, &e.nonce, &e.header_bytes, ct)?;
    Ok((h, decode_body(&plain)?))
}

#[derive(Debug, PartialEq)]
pub enum Bind {
    Answer { object_id: [u8; 16], version_hash: [u8; 32], choices: Vec<String> },
    DecideAgain { object_id: [u8; 16], previous_hash: [u8; 32], version_hash: [u8; 32] },
    Request { request_id: [u8; 16], expires_at: u64 },
    Verdict { request_id: [u8; 16], request_hash: [u8; 32], expires_at: u64, allow: bool },
}
pub fn decode_bind(kind: u8, bind: &[u8]) -> ZResult<Bind> {
    let mut r = R::new(bind);
    check_version(r.u8()?, "bind")?;
    let out = match kind {
        KIND_ANSWER => {
            let object_id = r.take16()?;
            let version_hash = r.take32()?;
            let n = r.u8()?;
            let mut choices = vec![];
            for _ in 0..n {
                choices.push(r.str16(256)?);
            }
            Bind::Answer { object_id, version_hash, choices }
        }
        KIND_DECIDE_AGAIN => Bind::DecideAgain { object_id: r.take16()?, previous_hash: r.take32()?, version_hash: r.take32()? },
        KIND_PERMISSION_REQUEST => Bind::Request { request_id: r.take16()?, expires_at: r.u64()? },
        KIND_VERDICT => {
            let request_id = r.take16()?;
            let request_hash = r.take32()?;
            let expires_at = r.u64()?;
            let a = r.u8()?;
            if a != 1 && a != 2 {
                return Err(fail("bad-format", "verdict"));
            }
            Bind::Verdict { request_id, request_hash, expires_at, allow: a == 1 }
        }
        _ => return Err(fail("bad-format", "this kind carries no bind")),
    };
    r.end()?;
    Ok(out)
}

/// Decrypt a whole asset blob (FORMAT.md section 11).
pub fn decrypt_asset(blob: &[u8], key: &[u8]) -> ZResult<Vec<u8>> {
    const CHUNK: usize = 65536;
    const HEAD: usize = 22;
    let mut r = R::new(blob);
    crate::prim::header(&mut r, obj::ASSET)?;
    r.take(16)?;
    if r.u32()? != CHUNK as u32 {
        return Err(fail("bad-format", "unsupported chunk size"));
    }
    let body = blob.len() - HEAD;
    let full = CHUNK + 16;
    let chunks = body.div_ceil(full);
    if chunks < 1 || body < (chunks - 1) * full + 16 {
        return Err(fail("bad-format", "asset is cut off"));
    }
    let head = &blob[..HEAD];
    let mut out = vec![];
    for i in 0..chunks {
        let mut nonce = [0u8; 12];
        nonce[3..11].copy_from_slice(&(i as u64).to_be_bytes());
        nonce[11] = (i == chunks - 1) as u8;
        let from = HEAD + i * full;
        out.extend(crate::prim::gcm_open(key, &nonce, head, &blob[from..(from + full).min(blob.len())])?);
    }
    Ok(out)
}

impl From<ZError> for String {
    fn from(e: ZError) -> String { e.message }
}
