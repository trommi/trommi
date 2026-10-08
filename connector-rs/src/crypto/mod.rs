//! zcrypto in Rust: the exact bytes of shared/crypto/zcrypto.mjs (FORMAT.md). Ed25519, X25519, AES-256-GCM,
//! HKDF-SHA-256, HMAC-SHA-256, SHA-256 from RustCrypto/dalek; nothing else. Checked against vectors.json.
pub mod bytes;
pub mod grants;

use crate::error::{fail, Result, ZError};
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
pub use bytes::*;
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use x25519_dalek::{PublicKey as XPublic, StaticSecret};

pub const VERSION: u8 = 1;

// ---- object types, labels ------------------------------------------------------------------------------------
pub mod obj {
    pub const LOG_ENTRY: u8 = 0x01;
    pub const ENVELOPE: u8 = 0x02;
    pub const ENVELOPE_PRUNED: u8 = 0x03;
    pub const SEALED: u8 = 0x04;
    pub const INVITE_OFFER: u8 = 0x05;
    pub const INVITE_REQUEST: u8 = 0x06;
    pub const INVITE_REVEAL: u8 = 0x07;
    pub const BACK_LINK: u8 = 0x08;
    pub const ASSET: u8 = 0x09;
    pub const DEVICE_SECRET: u8 = 0x0c;
    pub const HUB_AUTH: u8 = 0x0d;
}
pub mod label {
    pub const DEVICE_ID: &str = "trommi/v1/device-id";
    pub const LOG_ENTRY: &str = "trommi/v1/log-entry";
    pub const LOG_SIG: &str = "trommi/v1/log-sig";
    pub const SEALED_BOX: &str = "trommi/v1/sealed-box";
    pub const EPOCH_WRAP: &str = "trommi/v1/epoch-wrap";
    pub const KEY_COMMIT: &str = "trommi/v1/epoch-commit/key";
    pub const HIST_COMMIT: &str = "trommi/v1/epoch-commit/hist";
    pub const BACK_LINK: &str = "trommi/v1/back-link";
    pub const SENDER_KEY: &str = "trommi/v1/sender-key";
    pub const ENVELOPE: &str = "trommi/v1/envelope";
    pub const ENVELOPE_SIG: &str = "trommi/v1/envelope-sig";
    pub const INVITE_ID: &str = "trommi/v1/invite-id";
    pub const INVITE_MAC: &str = "trommi/v1/invite-mac";
    pub const INVITE_COMMIT: &str = "trommi/v1/invite-commit";
    pub const INVITE_OFFER: &str = "trommi/v1/invite-offer";
    pub const INVITE_OFFER_SIG: &str = "trommi/v1/invite-offer-sig";
    pub const INVITE_REQUEST: &str = "trommi/v1/invite-request";
    pub const INVITE_REQUEST_SIG: &str = "trommi/v1/invite-request-sig";
    pub const INVITE_REVEAL_SIG: &str = "trommi/v1/invite-reveal-sig";
    pub const INVITE_CODE: &str = "trommi/v1/invite-code";
    pub const RECOVERY_SIGN: &str = "trommi/v1/recovery/sign";
    pub const RECOVERY_KEX: &str = "trommi/v1/recovery/kex";
    pub const HUB_AUTH: &str = "trommi/v1/hub-auth";
    pub const OBJECT_ID: &str = "trommi/v1/object-id";
}
fn label_bytes(l: &str) -> Vec<u8> {
    let mut v = l.as_bytes().to_vec();
    v.push(0);
    v
}
pub const ZERO32: [u8; 32] = [0u8; 32];
pub const ZERO16: [u8; 16] = [0u8; 16];

// ---- randomness ------------------------------------------------------------------------------------------------

/// The OS generator, or the test generator of vectors.json: call c of seed s returns n bytes, byte j = (s + 17c + j) mod 256.
pub enum Rng {
    Os,
    Test { seed: u32, calls: u32 },
}
impl Rng {
    pub fn test(seed: u32) -> Self {
        Rng::Test { seed, calls: 0 }
    }
    pub fn bytes(&mut self, n: usize) -> Vec<u8> {
        match self {
            Rng::Os => random_bytes(n),
            Rng::Test { seed, calls } => {
                let c = *calls;
                *calls += 1;
                (0..n).map(|j| ((*seed as u64 + 17 * c as u64 + j as u64) % 256) as u8).collect()
            }
        }
    }
    pub fn arr32(&mut self) -> [u8; 32] {
        self.bytes(32).try_into().unwrap()
    }
}
pub fn random_bytes(n: usize) -> Vec<u8> {
    let mut v = vec![0u8; n];
    getrandom::getrandom(&mut v).expect("the system's random number generator");
    v
}
pub fn random_hex(n: usize) -> String {
    hex(&random_bytes(n))
}

// ---- primitives -------------------------------------------------------------------------------------------------

pub fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}
/// SHA-256(utf8(label) || 0x00 || parts...)
pub fn hash(label: &str, parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(label.as_bytes());
    h.update([0u8]);
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}
/// HKDF-SHA-256 with info = utf8(label) || 0x00 || context.
pub fn hkdf(ikm: &[u8], salt: &[u8], label: &str, context: &[u8], length: usize) -> Vec<u8> {
    let hk = hkdf::Hkdf::<Sha256>::new(Some(salt), ikm);
    let mut info = label_bytes(label);
    info.extend_from_slice(context);
    let mut out = vec![0u8; length];
    hk.expand(&info, &mut out).expect("HKDF output length");
    out
}
pub fn gcm_seal(key: &[u8], nonce: &[u8], aad: &[u8], plaintext: &[u8]) -> Vec<u8> {
    let c = Aes256Gcm::new_from_slice(key).expect("AES key of 32 bytes");
    c.encrypt(Nonce::from_slice(nonce), Payload { msg: plaintext, aad }).expect("AES-GCM")
}
pub fn gcm_open(key: &[u8], nonce: &[u8], aad: &[u8], ct: &[u8]) -> Result<Vec<u8>> {
    let c = Aes256Gcm::new_from_slice(key).map_err(|_| ZError::new("bad-argument", "AES key must be 32 bytes"))?;
    c.decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad }).map_err(|_| ZError::new("decrypt-failed", "authentication tag does not match"))
}
pub fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC key");
    m.update(msg);
    m.finalize().into_bytes().into()
}

// ---- device identity --------------------------------------------------------------------------------------------

pub const ROLE_HUMAN: u8 = 1;
pub const ROLE_AGENT: u8 = 2;

pub fn device_id(sign_pub: &[u8], kex_pub: &[u8]) -> [u8; 32] {
    hash(label::DEVICE_ID, &[sign_pub, kex_pub])
}

/// A device: its id, public keys and private keys (seeds kept for the key file).
#[derive(Clone)]
pub struct Device {
    pub id: [u8; 32],
    pub sign_pub: [u8; 32],
    pub kex_pub: [u8; 32],
    pub sign_seed: [u8; 32],
    pub kex_seed: [u8; 32],
}
impl Device {
    pub fn from_seeds(sign_seed: [u8; 32], kex_seed: [u8; 32]) -> Device {
        let sk = SigningKey::from_bytes(&sign_seed);
        let sign_pub = sk.verifying_key().to_bytes();
        let kex_pub = XPublic::from(&StaticSecret::from(kex_seed)).to_bytes();
        Device { id: device_id(&sign_pub, &kex_pub), sign_pub, kex_pub, sign_seed, kex_seed }
    }
    pub fn generate() -> Device {
        let a: [u8; 32] = random_bytes(32).try_into().unwrap();
        let b: [u8; 32] = random_bytes(32).try_into().unwrap();
        Device::from_seeds(a, b)
    }
    pub fn public(&self) -> PublicDevice {
        PublicDevice { id: self.id, sign_pub: self.sign_pub, kex_pub: self.kex_pub }
    }
    pub fn sign(&self, label: &str, message: &[u8]) -> [u8; 64] {
        let sk = SigningKey::from_bytes(&self.sign_seed);
        let mut m = label_bytes(label);
        m.extend_from_slice(message);
        sk.sign(&m).to_bytes()
    }
    pub fn kex_secret(&self) -> StaticSecret {
        StaticSecret::from(self.kex_seed)
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PublicDevice {
    pub id: [u8; 32],
    pub sign_pub: [u8; 32],
    pub kex_pub: [u8; 32],
}

/// 0x01 0x0c signSeed(32) kexSeed(32): the agent's key file (mode 0600).
pub fn export_device_secret(d: &Device) -> Vec<u8> {
    W::new().u8(VERSION).u8(obj::DEVICE_SECRET).raw(&d.sign_seed).raw(&d.kex_seed).done()
}
pub fn import_device_secret(b: &[u8]) -> Result<Device> {
    let mut r = R::new(b);
    header(&mut r, obj::DEVICE_SECRET)?;
    let s = r.take_arr::<32>()?;
    let k = r.take_arr::<32>()?;
    r.end()?;
    Ok(Device::from_seeds(s, k))
}
fn header(r: &mut R, t: u8) -> Result<()> {
    let v = r.u8()?;
    if v != VERSION {
        return fail("bad-version", format!("version {v} is not supported"));
    }
    let got = r.u8()?;
    if got != t {
        return fail("bad-format", format!("object type {got}, expected {t}"));
    }
    Ok(())
}

/// Ed25519 over utf8(label) || 0x00 || message.
pub fn verify(sign_pub: &[u8], label: &str, message: &[u8], signature: &[u8]) -> bool {
    if signature.len() != 64 || sign_pub.len() != 32 {
        return false;
    }
    let Ok(vk) = VerifyingKey::from_bytes(sign_pub.try_into().unwrap()) else { return false };
    let sig = ed25519_dalek::Signature::from_bytes(signature.try_into().unwrap());
    let mut m = label_bytes(label);
    m.extend_from_slice(message);
    ed25519_dalek::Verifier::verify(&vk, &m, &sig).is_ok()
}

// ---- sealed box: ZSEAL1 = X25519 + HKDF-SHA-256 + AES-256-GCM ---------------------------------------------------

fn x25519(priv_: &StaticSecret, public: &[u8]) -> Result<[u8; 32]> {
    let p: [u8; 32] = public.try_into().map_err(|_| ZError::new("bad-argument", "X25519 public key must be 32 bytes"))?;
    let shared = priv_.diffie_hellman(&XPublic::from(p));
    if !shared.was_contributory() {
        return fail("bad-key", "X25519 gave the all-zero secret");
    }
    Ok(shared.to_bytes())
}
fn seal_keys(shared: &[u8], eph_pub: &[u8], recipient_pub: &[u8]) -> (Vec<u8>, Vec<u8>) {
    let okm = hkdf(shared, &concat(&[eph_pub, recipient_pub]), label::SEALED_BOX, &[], 44);
    (okm[..32].to_vec(), okm[32..].to_vec())
}
/// 0x01 0x04 ephemeralPub(32) ciphertext+tag. `aad` is bound but not transmitted.
pub fn seal(recipient_kex_pub: &[u8], plaintext: &[u8], aad: &[u8], rng: &mut Rng) -> Result<Vec<u8>> {
    let eph = StaticSecret::from(rng.arr32());
    let eph_pub = XPublic::from(&eph).to_bytes();
    let shared = x25519(&eph, recipient_kex_pub)?;
    let (key, nonce) = seal_keys(&shared, &eph_pub, recipient_kex_pub);
    Ok(concat(&[&[VERSION, obj::SEALED], &eph_pub, &gcm_seal(&key, &nonce, aad, plaintext)]))
}
pub fn open_sealed(device: &Device, sealed: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
    let mut r = R::new(sealed);
    header(&mut r, obj::SEALED)?;
    let eph = r.take(32)?;
    let ct = r.rest();
    if ct.len() < 16 {
        return fail("bad-format", "sealed box too short");
    }
    let shared = x25519(&device.kex_secret(), &eph)?;
    let (key, nonce) = seal_keys(&shared, &eph, &device.kex_pub);
    gcm_open(&key, &nonce, aad, &ct)
}

// ---- membership log ---------------------------------------------------------------------------------------------

pub const ENTRY_GENESIS: u8 = 1;
pub const ENTRY_ADD: u8 = 2;
pub const ENTRY_REMOVE: u8 = 3;
pub const ENTRY_RECOVER: u8 = 5;
pub const SIGNER_DEVICE: u8 = 1;
pub const SIGNER_RECOVERY: u8 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MemberKeys {
    pub role: u8,
    pub sign_pub: [u8; 32],
    pub kex_pub: [u8; 32],
}
#[derive(Clone, Copy, Debug)]
pub struct Removed {
    pub id: [u8; 32],
    pub seq: u64,
    pub hash: [u8; 32],
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeyPair {
    pub sign_pub: [u8; 32],
    pub kex_pub: [u8; 32],
}
#[derive(Clone, Debug)]
pub struct Entry {
    pub type_: u8,
    pub seq: u32,
    pub prev: [u8; 32],
    pub time: u64,
    pub signer_kind: u8,
    pub signer: [u8; 32],
    pub room_nonce: Option<[u8; 16]>,
    pub member: Option<MemberKeys>,
    pub invite_id: Option<[u8; 16]>,
    pub removed: Vec<Removed>,
    pub epoch: Option<u32>,
    pub key_commit: Option<[u8; 32]>,
    pub hist_commit: Option<[u8; 32]>,
    pub recovery: Option<KeyPair>,
    pub body: Vec<u8>,
    pub signature: Vec<u8>,
}
impl Entry {
    pub fn bytes(&self) -> Vec<u8> {
        concat(&[&self.body, &self.signature])
    }
}

fn write_member(w: W, m: &MemberKeys) -> Result<W> {
    if m.role != ROLE_HUMAN && m.role != ROLE_AGENT {
        return fail("bad-argument", "role");
    }
    Ok(w.u8(m.role).raw(&m.sign_pub).raw(&m.kex_pub))
}
fn read_member(r: &mut R) -> Result<MemberKeys> {
    let role = r.u8()?;
    if role != ROLE_HUMAN && role != ROLE_AGENT {
        return fail("bad-format", "unknown role");
    }
    Ok(MemberKeys { role, sign_pub: r.take_arr()?, kex_pub: r.take_arr()? })
}
fn write_removed(mut w: W, removed: &[Removed]) -> Result<W> {
    let mut sorted = removed.to_vec();
    sorted.sort_by(|a, b| a.id.cmp(&b.id));
    for i in 1..sorted.len() {
        if sorted[i - 1].id == sorted[i].id {
            return fail("bad-argument", "duplicate id");
        }
    }
    w = w.u16(sorted.len() as u16);
    for x in &sorted {
        w = w.raw(&x.id).u64(x.seq).raw(&x.hash);
    }
    Ok(w)
}
fn read_removed(r: &mut R) -> Result<Vec<Removed>> {
    let n = r.u16()?;
    let mut out: Vec<Removed> = Vec::new();
    for i in 0..n as usize {
        let x = Removed { id: r.take_arr()?, seq: r.u64()?, hash: r.take_arr()? };
        if i > 0 && out[i - 1].id >= x.id {
            return fail("bad-format", "ids not strictly ascending");
        }
        if x.seq == 0 && !is_zero(&x.hash) {
            return fail("bad-format", "a cut without an envelope has a zero hash");
        }
        out.push(x);
    }
    Ok(out)
}

/// The fields of an entry to sign (type-specific ones optional).
pub struct EntryFields {
    pub type_: u8,
    pub seq: u32,
    pub prev: [u8; 32],
    pub time: u64,
    pub signer_kind: u8,
    pub signer: [u8; 32],
    pub room_nonce: [u8; 16],
    pub member: Option<MemberKeys>,
    pub invite_id: [u8; 16],
    pub removed: Vec<Removed>,
    pub epoch: u32,
    pub key_commit: [u8; 32],
    pub hist_commit: [u8; 32],
    pub recovery: Option<KeyPair>,
}
fn encode_entry_body(e: &EntryFields) -> Result<Vec<u8>> {
    let mut w = W::new().u8(VERSION).u8(obj::LOG_ENTRY).u8(e.type_).u32(e.seq).raw(&e.prev).u64(e.time).u8(e.signer_kind).raw(&e.signer);
    let epoch = |w: W| w.u32(e.epoch).raw(&e.key_commit).raw(&e.hist_commit);
    let rec = e.recovery.unwrap_or(KeyPair { sign_pub: ZERO32, kex_pub: ZERO32 });
    match e.type_ {
        ENTRY_GENESIS => {
            w = w.raw(&e.room_nonce);
            w = write_member(w, e.member.as_ref().unwrap())?;
            w = w.raw(&rec.sign_pub).raw(&rec.kex_pub);
            w = epoch(w);
        }
        ENTRY_ADD => {
            w = write_member(w, e.member.as_ref().unwrap())?;
            w = w.raw(&e.invite_id);
        }
        ENTRY_REMOVE => {
            w = write_removed(w, &e.removed)?;
            w = epoch(w);
        }
        ENTRY_RECOVER => {
            w = write_member(w, e.member.as_ref().unwrap())?;
            w = write_removed(w, &e.removed)?;
            w = epoch(w);
            w = w.raw(&rec.sign_pub).raw(&rec.kex_pub);
        }
        _ => return fail("bad-argument", "entry type"),
    }
    Ok(w.done())
}

/// Parse an entry without judging it. Wire form: body || signature(64).
pub fn decode_entry(bytes: &[u8]) -> Result<Entry> {
    if bytes.len() < 64 {
        return fail("bad-format", "entry too short");
    }
    let body = bytes[..bytes.len() - 64].to_vec();
    let signature = bytes[bytes.len() - 64..].to_vec();
    let mut r = R::new(&body);
    header(&mut r, obj::LOG_ENTRY)?;
    let mut e = Entry {
        type_: r.u8()?, seq: r.u32()?, prev: r.take_arr()?, time: r.u64()?, signer_kind: r.u8()?, signer: r.take_arr()?,
        room_nonce: None, member: None, invite_id: None, removed: vec![], epoch: None, key_commit: None, hist_commit: None, recovery: None,
        body: vec![], signature,
    };
    fn epoch(r: &mut R, e: &mut Entry) -> Result<()> {
        e.epoch = Some(r.u32()?);
        e.key_commit = Some(r.take_arr()?);
        e.hist_commit = Some(r.take_arr()?);
        Ok(())
    }
    fn recovery(r: &mut R, e: &mut Entry) -> Result<()> {
        e.recovery = Some(KeyPair { sign_pub: r.take_arr()?, kex_pub: r.take_arr()? });
        Ok(())
    }
    match e.type_ {
        ENTRY_GENESIS => {
            e.room_nonce = Some(r.take_arr()?);
            e.member = Some(read_member(&mut r)?);
            recovery(&mut r, &mut e)?;
            epoch(&mut r, &mut e)?;
        }
        ENTRY_ADD => {
            e.member = Some(read_member(&mut r)?);
            e.invite_id = Some(r.take_arr()?);
        }
        ENTRY_REMOVE => {
            e.removed = read_removed(&mut r)?;
            epoch(&mut r, &mut e)?;
        }
        ENTRY_RECOVER => {
            e.member = Some(read_member(&mut r)?);
            e.removed = read_removed(&mut r)?;
            epoch(&mut r, &mut e)?;
            recovery(&mut r, &mut e)?;
        }
        _ => return fail("bad-format", "unknown entry type"),
    }
    r.end()?;
    if e.signer_kind != SIGNER_DEVICE && e.signer_kind != SIGNER_RECOVERY {
        return fail("bad-format", "unknown signer kind");
    }
    e.body = body;
    Ok(e)
}

fn sign_entry(fields: &EntryFields, signer: &Device) -> Result<Vec<u8>> {
    let body = encode_entry_body(fields)?;
    let sig = signer.sign(label::LOG_SIG, &body);
    Ok(concat(&[&body, &sig]))
}

/// X25519 ignores bit 255: compare with it cleared (C24).
fn kex_canon(k: &[u8; 32]) -> [u8; 32] {
    let mut c = *k;
    c[31] &= 0x7f;
    c
}
fn keys_clash(a_sign: &[u8; 32], a_kex: &[u8; 32], b_sign: &[u8; 32], b_kex: &[u8; 32]) -> bool {
    bytes_equal(a_sign, b_sign) || bytes_equal(&kex_canon(a_kex), &kex_canon(b_kex))
}

#[derive(Clone, Debug)]
pub struct Member {
    pub id: [u8; 32],
    pub role: u8,
    pub sign_pub: [u8; 32],
    pub kex_pub: [u8; 32],
    pub added_seq: u32,
    pub removed_seq: Option<u32>,
    pub cut: Option<(u64, [u8; 32])>,
}
#[derive(Clone, Debug)]
pub struct EpochInfo {
    pub seq: u32,
    pub key_commit: [u8; 32],
    pub hist_commit: [u8; 32],
}
#[derive(Clone, Debug)]
pub struct Recovery {
    pub sign_pub: [u8; 32],
    pub kex_pub: [u8; 32],
    pub id: [u8; 32],
}
/// A verified member list (JS: the zcrypto log state).
#[derive(Clone, Debug)]
pub struct LogState {
    pub room_id: [u8; 32],
    pub head_seq: u32,
    pub head_hash: [u8; 32],
    pub hashes: Vec<[u8; 32]>,
    pub entries: Vec<Entry>,
    /// in insertion order (JS Map order: activeMembers, wrapForAll)
    pub members: Vec<Member>,
    pub epoch: u32,
    pub epochs: BTreeMap<u32, EpochInfo>,
    pub recovery: Recovery,
    pub invite_ids: HashSet<[u8; 16]>,
    pub last_recover_seq: i64,
}
impl LogState {
    pub fn member(&self, id: &[u8]) -> Option<&Member> {
        self.members.iter().find(|m| m.id[..] == *id)
    }
    fn member_mut(&mut self, id: &[u8]) -> Option<&mut Member> {
        self.members.iter_mut().find(|m| m.id[..] == *id)
    }
    /// The member with this id if it was active once entry `log_seq` had been applied.
    pub fn member_at(&self, id: &[u8], log_seq: u32) -> Option<&Member> {
        let m = self.member(id)?;
        if m.added_seq > log_seq || m.removed_seq.is_some_and(|r| r <= log_seq) {
            return None;
        }
        Some(m)
    }
    pub fn member_now(&self, id: &[u8]) -> Option<&Member> {
        self.member_at(id, self.head_seq)
    }
    pub fn active_members(&self) -> Vec<&Member> {
        self.members.iter().filter(|m| m.removed_seq.is_none()).collect()
    }
    pub fn epoch_at(&self, log_seq: u32) -> u32 {
        let mut best = 0;
        for (e, info) in &self.epochs {
            if info.seq <= log_seq && *e > best {
                best = *e;
            }
        }
        best
    }
    pub fn entry(&self, seq: u32) -> Option<&Entry> {
        self.entries.iter().find(|e| e.seq == seq)
    }
}

/// Verify one entry against the state before it and return the state after it. Never mutates.
pub fn apply_entry(state: Option<&LogState>, entry_bytes: &[u8]) -> Result<LogState> {
    let e = decode_entry(entry_bytes)?;
    let entry_hash = hash(label::LOG_ENTRY, &[&e.body]);
    let bad = |why: &str| -> ZError { ZError::new("bad-entry", format!("entry {}: {}", e.seq, why)) };
    let check_sig = |pubk: &[u8]| -> Result<()> {
        if !verify(pubk, label::LOG_SIG, &e.body, &e.signature) {
            return fail("bad-signature", format!("entry {}", e.seq));
        }
        Ok(())
    };
    let Some(state) = state else {
        if e.type_ != ENTRY_GENESIS {
            return Err(bad("a log starts with a genesis entry"));
        }
        if e.seq != 0 || !is_zero(&e.prev) {
            return Err(bad("genesis must have number 0 and no predecessor"));
        }
        let m = e.member.unwrap();
        if e.signer_kind != SIGNER_DEVICE || m.role != ROLE_HUMAN {
            return Err(bad("genesis must be signed by a human device"));
        }
        let id = device_id(&m.sign_pub, &m.kex_pub);
        if !bytes_equal(&id, &e.signer) {
            return Err(bad("signer is not the founding device"));
        }
        if e.epoch != Some(1) {
            return Err(bad("the first epoch is 1"));
        }
        check_sig(&m.sign_pub)?;
        let rk = e.recovery.unwrap();
        let recovery = Recovery { sign_pub: rk.sign_pub, kex_pub: rk.kex_pub, id: device_id(&rk.sign_pub, &rk.kex_pub) };
        if bytes_equal(&recovery.id, &id) || keys_clash(&recovery.sign_pub, &recovery.kex_pub, &m.sign_pub, &m.kex_pub) {
            return Err(bad("recovery key equals the device key"));
        }
        let mut epochs = BTreeMap::new();
        epochs.insert(1, EpochInfo { seq: 0, key_commit: e.key_commit.unwrap(), hist_commit: e.hist_commit.unwrap() });
        return Ok(LogState {
            room_id: entry_hash, head_seq: 0, head_hash: entry_hash, hashes: vec![entry_hash],
            members: vec![Member { id, role: m.role, sign_pub: m.sign_pub, kex_pub: m.kex_pub, added_seq: 0, removed_seq: None, cut: None }],
            entries: vec![e], epoch: 1, epochs, recovery, invite_ids: HashSet::new(), last_recover_seq: -1,
        });
    };

    if e.type_ == ENTRY_GENESIS {
        return Err(bad("a second genesis entry"));
    }
    if e.seq != state.head_seq + 1 {
        return Err(bad(&format!("number {} does not follow {}", e.seq, state.head_seq)));
    }
    if !bytes_equal(&e.prev, &state.head_hash) {
        return Err(bad("predecessor hash does not match"));
    }
    if e.type_ == ENTRY_RECOVER {
        if e.signer_kind != SIGNER_RECOVERY || !bytes_equal(&e.signer, &state.recovery.id) {
            return Err(bad("only the recovery key may sign a recovery"));
        }
        check_sig(&state.recovery.sign_pub)?;
    } else if e.signer_kind == SIGNER_RECOVERY {
        let m = e.member.as_ref();
        if e.type_ != ENTRY_ADD || m.map(|m| m.role) != Some(ROLE_HUMAN) || !is_zero(&e.invite_id.unwrap_or(ZERO16)) {
            return Err(bad("the recovery key signs recoveries and the add of a human device without an invite only"));
        }
        if !bytes_equal(&e.signer, &state.recovery.id) {
            return Err(bad("not the recovery key of this room"));
        }
        check_sig(&state.recovery.sign_pub)?;
    } else {
        if e.signer_kind != SIGNER_DEVICE {
            return Err(bad("the recovery key signs recovery entries only"));
        }
        let m = state.member(&e.signer);
        let Some(m) = m.filter(|m| m.removed_seq.is_none()) else { return Err(bad("signer is not a member")) };
        if m.role != ROLE_HUMAN {
            return Err(bad("agents may not change the membership"));
        }
        check_sig(&m.sign_pub)?;
    }

    let mut next = state.clone();
    let add_member = |next: &mut LogState, member: &MemberKeys| -> Result<()> {
        let id = device_id(&member.sign_pub, &member.kex_pub);
        if next.member(&id).is_some() {
            return Err(bad("this device was already a member (removed devices cannot return)"));
        }
        if bytes_equal(&id, &state.recovery.id) || keys_clash(&state.recovery.sign_pub, &state.recovery.kex_pub, &member.sign_pub, &member.kex_pub) {
            return Err(bad("the recovery key cannot be a member"));
        }
        for m in &next.members {
            if keys_clash(&m.sign_pub, &m.kex_pub, &member.sign_pub, &member.kex_pub) {
                return Err(bad("key already in use by another member"));
            }
        }
        next.members.push(Member { id, role: member.role, sign_pub: member.sign_pub, kex_pub: member.kex_pub, added_seq: e.seq, removed_seq: None, cut: None });
        Ok(())
    };
    let remove_members = |next: &mut LogState, removed: &[Removed]| -> Result<()> {
        for x in removed {
            match next.member_mut(&x.id) {
                Some(m) if m.removed_seq.is_none() => {
                    m.removed_seq = Some(e.seq);
                    m.cut = Some((x.seq, x.hash));
                }
                _ => return Err(bad("removing someone who is not a member")),
            }
        }
        Ok(())
    };
    let new_epoch = |next: &mut LogState| -> Result<()> {
        let ep = e.epoch.unwrap();
        if ep != state.epoch + 1 {
            return Err(bad(&format!("epoch {} does not follow {}", ep, state.epoch)));
        }
        next.epoch = ep;
        next.epochs.insert(ep, EpochInfo { seq: e.seq, key_commit: e.key_commit.unwrap(), hist_commit: e.hist_commit.unwrap() });
        Ok(())
    };
    match e.type_ {
        ENTRY_ADD => {
            add_member(&mut next, e.member.as_ref().unwrap())?;
            let inv = e.invite_id.unwrap();
            if !is_zero(&inv) {
                if next.invite_ids.contains(&inv) {
                    return Err(bad("this invite already produced a member"));
                }
                next.invite_ids.insert(inv);
            }
        }
        ENTRY_REMOVE => {
            if e.removed.is_empty() {
                return Err(bad("nothing to remove"));
            }
            remove_members(&mut next, &e.removed)?;
            new_epoch(&mut next)?;
        }
        ENTRY_RECOVER => {
            let m = e.member.unwrap();
            if m.role != ROLE_HUMAN {
                return Err(bad("recovery enrols a human device"));
            }
            let humans: Vec<_> = state.active_members().into_iter().filter(|m| m.role == ROLE_HUMAN).map(|m| m.id).collect();
            if !humans.iter().all(|h| e.removed.iter().any(|x| x.id == *h)) {
                return Err(bad("a recovery removes every human device"));
            }
            remove_members(&mut next, &e.removed)?;
            add_member(&mut next, &m)?;
            new_epoch(&mut next)?;
            let rk = e.recovery.unwrap();
            let id = device_id(&rk.sign_pub, &rk.kex_pub);
            if bytes_equal(&id, &state.recovery.id) {
                return Err(bad("recovery must install a new recovery key"));
            }
            if next.member(&id).is_some() || next.members.iter().any(|m| keys_clash(&m.sign_pub, &m.kex_pub, &rk.sign_pub, &rk.kex_pub)) {
                return Err(bad("recovery key equals a device key"));
            }
            next.recovery = Recovery { sign_pub: rk.sign_pub, kex_pub: rk.kex_pub, id };
            next.last_recover_seq = e.seq as i64;
        }
        _ => {}
    }
    next.head_seq = e.seq;
    next.head_hash = entry_hash;
    next.hashes.push(entry_hash);
    next.entries.push(e);
    Ok(next)
}

/// Verify a whole log against a room id from elsewhere.
pub fn verify_log(entries: &[Vec<u8>], room_id: Option<&[u8]>) -> Result<LogState> {
    if entries.is_empty() {
        return fail("bad-entry", "empty log");
    }
    let mut state: Option<LogState> = None;
    for b in entries {
        state = Some(apply_entry(state.as_ref(), b)?);
    }
    let state = state.unwrap();
    if let Some(rid) = room_id {
        if !bytes_equal(&state.room_id, rid) {
            return fail("wrong-room", "the genesis entry does not hash to this room id");
        }
    }
    Ok(state)
}

/// What a device stores to refuse rollbacks and forks.
#[derive(Clone, Debug)]
pub struct Pin {
    pub seq: u32,
    pub hash: [u8; 32],
    pub hashes: Option<Vec<[u8; 32]>>,
    pub last_recover_seq: i64,
}
pub fn pin_of(s: &LogState) -> Pin {
    Pin { seq: s.head_seq, hash: s.head_hash, hashes: Some(s.hashes.clone()), last_recover_seq: s.last_recover_seq }
}
/// 'same' | 'extended' | 'recovery-override'; throws log-rollback / log-fork.
pub fn check_log_against_pin(state: &LogState, pin: Option<&Pin>) -> Result<&'static str> {
    let Some(pin) = pin else { return Ok("extended") };
    let n = state.hashes.len().min(pin.seq as usize + 1);
    let mut fork: i64 = -1;
    if let Some(hashes) = &pin.hashes {
        for i in 0..n {
            if hashes.get(i).map(|h| !bytes_equal(&state.hashes[i], h)).unwrap_or(true) {
                fork = i as i64;
                break;
            }
        }
    } else if state.head_seq >= pin.seq && !bytes_equal(&state.hashes[pin.seq as usize], &pin.hash) {
        fork = pin.seq as i64;
    }
    if fork < 0 {
        if state.head_seq < pin.seq {
            return fail("log-rollback", format!("the log ends at {}, this device already saw {}", state.head_seq, pin.seq));
        }
        return Ok(if state.head_seq == pin.seq { "same" } else { "extended" });
    }
    let e = &state.entries[fork as usize];
    if pin.hashes.is_some() && e.type_ == ENTRY_RECOVER && fork > pin.last_recover_seq {
        return Ok("recovery-override");
    }
    Err(ZError::new("log-fork", format!("entry {fork} differs from the one this device already accepted")).with("forkSeq", fork))
}

// ---- room key epochs ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Secret {
    pub epoch: u32,
    pub key: [u8; 32],
    pub hist: Option<[u8; 32]>,
}
pub fn new_epoch_secret(epoch: u32, rng: &mut Rng) -> Secret {
    Secret { epoch, key: rng.arr32(), hist: Some(rng.arr32()) }
}
fn epoch_ctx(e: u32) -> [u8; 4] {
    e.to_be_bytes()
}
pub fn epoch_commits(s: &Secret) -> ([u8; 32], Option<[u8; 32]>) {
    let k = hkdf(&s.key, &[], label::KEY_COMMIT, &epoch_ctx(s.epoch), 32).try_into().unwrap();
    let h = s.hist.map(|h| hkdf(&h, &[], label::HIST_COMMIT, &epoch_ctx(s.epoch), 32).try_into().unwrap());
    (k, h)
}
fn check_commits(state: &LogState, s: &Secret) -> Result<()> {
    let Some(info) = state.epochs.get(&s.epoch) else { return fail("wrong-epoch", format!("the log knows no epoch {}", s.epoch)) };
    let (k, h) = epoch_commits(s);
    if !bytes_equal(&k, &info.key_commit) {
        return fail("key-mismatch", "room key does not match the commitment in the log");
    }
    if let Some(h) = h {
        if !bytes_equal(&h, &info.hist_commit) {
            return fail("key-mismatch", "history key does not match the commitment in the log");
        }
    }
    Ok(())
}
fn wrap_aad(room_id: &[u8], epoch: u32, recipient: &[u8]) -> Vec<u8> {
    concat(&[&label_bytes(label::EPOCH_WRAP), room_id, &epoch_ctx(epoch), recipient])
}
/// Seal an epoch secret to one active human device or the recovery key.
pub fn wrap_epoch_key(state: &LogState, secret: &Secret, recipient: &[u8], rng: &mut Rng) -> Result<Vec<u8>> {
    let kex = if bytes_equal(recipient, &state.recovery.id) {
        state.recovery.kex_pub
    } else {
        let Some(m) = state.member_now(recipient) else { return fail("not-member", "cannot wrap a key for someone who is not a member") };
        if m.role != ROLE_HUMAN {
            return fail("bad-argument", "agents hold no room key: they get session keys");
        }
        m.kex_pub
    };
    let Some(hist) = secret.hist else { return fail("bad-argument", "no history key to pass on") };
    let plain = concat(&[&[2u8], &secret.key, &hist]);
    seal(&kex, &plain, &wrap_aad(&state.room_id, secret.epoch, recipient), rng)
}
/// Open a wrapped epoch secret and check it against the commitments in the verified log.
pub fn unwrap_epoch_key(state: &LogState, device: &Device, sealed: &[u8], epoch: u32) -> Result<Secret> {
    let plain = open_sealed(device, sealed, &wrap_aad(&state.room_id, epoch, &device.id))?;
    let s = if plain.len() == 33 && plain[0] == 1 {
        Secret { epoch, key: plain[1..].try_into().unwrap(), hist: None }
    } else if plain.len() == 65 && plain[0] == 2 {
        Secret { epoch, key: plain[1..33].try_into().unwrap(), hist: Some(plain[33..].try_into().unwrap()) }
    } else {
        return fail("bad-format", "wrapped epoch secret");
    };
    check_commits(state, &s)?;
    Ok(s)
}
/// One wrap per active human device and one for the recovery key.
pub fn wrap_for_all(state: &LogState, secret: &Secret, rng: &mut Rng) -> Result<Vec<([u8; 32], Vec<u8>)>> {
    let mut out = vec![];
    for m in state.active_members().into_iter().filter(|m| m.role == ROLE_HUMAN) {
        out.push((m.id, wrap_epoch_key(state, secret, &m.id, rng)?));
    }
    out.push((state.recovery.id, wrap_epoch_key(state, secret, &state.recovery.id, rng)?));
    Ok(out)
}
fn back_link_keys(room_id: &[u8], s: &Secret) -> Result<(Vec<u8>, Vec<u8>)> {
    let Some(hist) = s.hist else { return fail("no-key", "agents hold no history key") };
    let okm = hkdf(&hist, room_id, label::BACK_LINK, &epoch_ctx(s.epoch), 44);
    Ok((okm[..32].to_vec(), okm[32..].to_vec()))
}
fn back_link_aad(room_id: &[u8], epoch: u32) -> Vec<u8> {
    concat(&[&[VERSION, obj::BACK_LINK], room_id, &epoch_ctx(epoch)])
}
pub fn make_back_link(room_id: &[u8], s: &Secret, previous: &Secret) -> Result<Vec<u8>> {
    if previous.epoch + 1 != s.epoch || previous.hist.is_none() {
        return fail("bad-argument", "back link needs the full previous epoch");
    }
    let (k, n) = back_link_keys(room_id, s)?;
    let ct = gcm_seal(&k, &n, &back_link_aad(room_id, s.epoch), &concat(&[&previous.key, &previous.hist.unwrap()]));
    Ok(concat(&[&[VERSION, obj::BACK_LINK], &epoch_ctx(s.epoch), &ct]))
}
pub fn open_back_link(state: &LogState, s: &Secret, link: &[u8]) -> Result<Secret> {
    let mut r = R::new(link);
    header(&mut r, obj::BACK_LINK)?;
    if r.u32()? != s.epoch {
        return fail("wrong-epoch", "back link belongs to another epoch");
    }
    let (k, n) = back_link_keys(&state.room_id, s)?;
    let plain = gcm_open(&k, &n, &back_link_aad(&state.room_id, s.epoch), &r.rest())?;
    if plain.len() != 64 {
        return fail("bad-format", "back link");
    }
    let prev = Secret { epoch: s.epoch - 1, key: plain[..32].try_into().unwrap(), hist: Some(plain[32..].try_into().unwrap()) };
    check_commits(state, &prev)?;
    Ok(prev)
}

// ---- building log entries ----------------------------------------------------------------------------------------

fn base(state: &LogState, type_: u8, signer: &[u8; 32], signer_kind: u8, time: u64) -> EntryFields {
    EntryFields {
        type_, seq: state.head_seq + 1, prev: state.head_hash, time, signer_kind, signer: *signer, room_nonce: ZERO16, member: None,
        invite_id: ZERO16, removed: vec![], epoch: 0, key_commit: ZERO32, hist_commit: ZERO32, recovery: None,
    }
}
pub struct Founded {
    pub entry: Vec<u8>,
    pub state: LogState,
    pub secret: Secret,
    pub wraps: Vec<([u8; 32], Vec<u8>)>,
}
/// Found a room (vectors and tests; the connector never founds one).
pub fn create_room(device: &Device, recovery: KeyPair, time: u64, rng: &mut Rng) -> Result<Founded> {
    let room_nonce: [u8; 16] = rng.bytes(16).try_into().unwrap();
    let secret = new_epoch_secret(1, rng);
    let (kc, hc) = epoch_commits(&secret);
    let entry = sign_entry(&EntryFields {
        type_: ENTRY_GENESIS, seq: 0, prev: ZERO32, time, signer_kind: SIGNER_DEVICE, signer: device.id, room_nonce,
        member: Some(MemberKeys { role: ROLE_HUMAN, sign_pub: device.sign_pub, kex_pub: device.kex_pub }), invite_id: ZERO16,
        removed: vec![], epoch: 1, key_commit: kc, hist_commit: hc.unwrap(), recovery: Some(recovery),
    }, device)?;
    let state = apply_entry(None, &entry)?;
    let wraps = wrap_for_all(&state, &secret, rng)?;
    Ok(Founded { entry, state, secret, wraps })
}
pub fn add_member(state: &LogState, signer: &Device, member: MemberKeys, invite_id: [u8; 16], time: u64) -> Result<(Vec<u8>, LogState)> {
    let kind = if bytes_equal(&signer.id, &state.recovery.id) { SIGNER_RECOVERY } else { SIGNER_DEVICE };
    let mut f = base(state, ENTRY_ADD, &signer.id, kind, time);
    f.member = Some(member);
    f.invite_id = invite_id;
    let entry = sign_entry(&f, signer)?;
    let s = apply_entry(Some(state), &entry)?;
    Ok((entry, s))
}
pub struct Rotated {
    pub entry: Vec<u8>,
    pub state: LogState,
    pub secret: Secret,
    pub wraps: Vec<([u8; 32], Vec<u8>)>,
    pub back_link: Option<Vec<u8>>,
    pub previous: Option<Secret>,
}
fn rotated(state: &LogState, entry: Vec<u8>, secret: Secret, previous: Option<&Secret>, rng: &mut Rng) -> Result<Rotated> {
    let next = apply_entry(Some(state), &entry)?;
    let wraps = wrap_for_all(&next, &secret, rng)?;
    let back_link = match previous { Some(p) if p.hist.is_some() => Some(make_back_link(&next.room_id, &secret, p)?), _ => None };
    Ok(Rotated { entry, state: next, secret, wraps, back_link, previous: previous.cloned() })
}
/// Remove members and rotate the room key in the same entry.
pub fn remove_members(state: &LogState, signer: &Device, ids: &[[u8; 32]], cuts: &HashMap<[u8; 32], (u64, [u8; 32])>, previous: Option<&Secret>, time: u64, rng: &mut Rng) -> Result<Rotated> {
    let secret = new_epoch_secret(state.epoch + 1, rng);
    let (kc, hc) = epoch_commits(&secret);
    let mut f = base(state, ENTRY_REMOVE, &signer.id, SIGNER_DEVICE, time);
    f.removed = ids.iter().map(|id| { let c = cuts.get(id).copied().unwrap_or((0, ZERO32)); Removed { id: *id, seq: c.0, hash: c.1 } }).collect();
    f.epoch = secret.epoch;
    f.key_commit = kc;
    f.hist_commit = hc.unwrap();
    let entry = sign_entry(&f, signer)?;
    rotated(state, entry, secret, previous, rng)
}

// ---- recovery code ---------------------------------------------------------------------------------------------

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
pub fn format_recovery_code(b: &[u8; 32]) -> String {
    let mut out = String::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for &x in b {
        acc = (acc << 8) | x as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(CROCKFORD[((acc >> bits) & 31) as usize] as char);
        }
        acc &= (1 << bits) - 1;
    }
    out.push(CROCKFORD[((acc << (5 - bits)) & 31) as usize] as char);
    out.as_bytes().chunks(4).map(|c| std::str::from_utf8(c).unwrap()).collect::<Vec<_>>().join("-")
}
pub fn parse_recovery_code(text: &str) -> Result<[u8; 32]> {
    let clean: String = text.to_uppercase().chars().filter(|c| !c.is_whitespace() && *c != '-').map(|c| match c { 'O' => '0', 'I' | 'L' => '1', c => c }).collect();
    if clean.chars().count() != 52 {
        return fail("bad-recovery-code", "a recovery code has 52 characters");
    }
    let mut out = [0u8; 32];
    let (mut acc, mut bits, mut o) = (0u32, 0u32, 0usize);
    for ch in clean.bytes() {
        let Some(v) = CROCKFORD.iter().position(|c| *c == ch) else { return fail("bad-recovery-code", "foreign character") };
        acc = (acc << 5) | v as u32;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            if o < 32 {
                out[o] = ((acc >> bits) & 0xff) as u8;
                o += 1;
            }
            acc &= (1 << bits) - 1;
        }
    }
    if acc != 0 {
        return fail("bad-recovery-code", "non-canonical last character");
    }
    Ok(out)
}
pub fn recovery_device(code: &str) -> Result<Device> {
    let raw = parse_recovery_code(code)?;
    Ok(Device::from_seeds(hkdf(&raw, &[], label::RECOVERY_SIGN, &[], 32).try_into().unwrap(), hkdf(&raw, &[], label::RECOVERY_KEX, &[], 32).try_into().unwrap()))
}
/// All devices lost, code at hand (vectors; humans only).
#[allow(clippy::too_many_arguments)]
pub fn recover_room(state: &LogState, code: &str, new_code: &str, new_device: &PublicDevice, remove_agents: &[[u8; 32]], cuts: &HashMap<[u8; 32], (u64, [u8; 32])>, recovery_wrap: &[u8], time: u64, rng: &mut Rng) -> Result<Rotated> {
    let rec = recovery_device(code)?;
    if !bytes_equal(&rec.id, &state.recovery.id) {
        return fail("bad-recovery-code", "this code does not belong to the room");
    }
    let previous = unwrap_epoch_key(state, &rec, recovery_wrap, state.epoch)?;
    let next = recovery_device(new_code)?;
    let mut ids: Vec<[u8; 32]> = state.active_members().into_iter().filter(|m| m.role == ROLE_HUMAN).map(|m| m.id).collect();
    ids.extend_from_slice(remove_agents);
    let secret = new_epoch_secret(state.epoch + 1, rng);
    let (kc, hc) = epoch_commits(&secret);
    let mut f = base(state, ENTRY_RECOVER, &rec.id, SIGNER_RECOVERY, time);
    f.member = Some(MemberKeys { role: ROLE_HUMAN, sign_pub: new_device.sign_pub, kex_pub: new_device.kex_pub });
    f.removed = ids.iter().map(|id| { let c = cuts.get(id).copied().unwrap_or((0, ZERO32)); Removed { id: *id, seq: c.0, hash: c.1 } }).collect();
    f.epoch = secret.epoch;
    f.key_commit = kc;
    f.hist_commit = hc.unwrap();
    f.recovery = Some(KeyPair { sign_pub: next.sign_pub, kex_pub: next.kex_pub });
    let entry = sign_entry(&f, &rec)?;
    let mut r = rotated(state, entry, secret, Some(&previous), rng)?;
    r.previous = Some(previous);
    Ok(r)
}

// ---- invites ------------------------------------------------------------------------------------------------------

pub const INVITE_TTL_MS: u64 = 10 * 60 * 1000;
pub const INVITE_CONFIRM_MS: u64 = 5 * 60 * 1000;
const HUB_MAX: usize = 512;

fn invite_keys(secret: &[u8], room_id: &[u8]) -> ([u8; 16], Vec<u8>) {
    (hkdf(secret, room_id, label::INVITE_ID, &[], 16).try_into().unwrap(), hkdf(secret, room_id, label::INVITE_MAC, &[], 32))
}
pub fn invite_id_of(secret: &[u8], room_id: &[u8]) -> [u8; 16] {
    invite_keys(secret, room_id).0
}

/// R9: https:// + lowercase host [+ :port], no path; plain http only for localhost and 127.0.0.1.
pub fn check_hub_address(hub: &str) -> Result<()> {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"^(https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*|http://(localhost|127\.0\.0\.1))(:[1-9][0-9]{0,4})?$").unwrap());
    if !re.is_match(hub) {
        return fail("bad-argument", "hub address: https://host[:port], lowercase, no path");
    }
    Ok(())
}
pub fn invite_link(app: &str, hub: &str, room_id: &[u8], secret: &[u8]) -> String {
    format!("{app}#v{VERSION}.{}.{}.{}", b64u(hub.as_bytes()), b64u(room_id), b64u(secret))
}
pub struct ParsedLink {
    pub hub: String,
    pub room_id: [u8; 32],
    pub secret: [u8; 32],
}
pub fn parse_invite_link(link: &str) -> Result<ParsedLink> {
    let Some(at) = link.find('#') else { return fail("bad-invite", "no fragment") };
    let parts: Vec<&str> = link[at + 1..].split('.').collect();
    if parts[0] != format!("v{VERSION}") {
        return fail("bad-version", "invite link version");
    }
    if parts.len() != 4 {
        return fail("bad-invite", "malformed link");
    }
    let hub = unb64u(parts[1]).ok().and_then(|b| String::from_utf8(b).ok()).ok_or_else(|| ZError::new("bad-invite", "hub address"))?;
    if hub.starts_with('\u{feff}') {
        return fail("bad-invite", "hub address");
    }
    if check_hub_address(&hub).is_err() {
        return fail("bad-invite", "the hub address in the link is not canonical");
    }
    let room = unb64u(parts[2])?;
    let secret = unb64u(parts[3])?;
    if room.len() != 32 || secret.len() != 32 {
        return fail("bad-invite", "malformed link");
    }
    Ok(ParsedLink { hub, room_id: room.try_into().unwrap(), secret: secret.try_into().unwrap() })
}

#[derive(Clone, Debug)]
pub struct Offer {
    pub room_id: [u8; 32],
    pub invite_id: [u8; 16],
    pub role: u8,
    pub expires_at: u64,
    pub commit: [u8; 32],
    pub inviter_id: [u8; 32],
    pub log_seq: u32,
    pub log_hash: [u8; 32],
    pub body: Vec<u8>,
    pub signature: Vec<u8>,
}
pub fn decode_offer(b: &[u8]) -> Result<Offer> {
    if b.len() < 64 {
        return fail("bad-format", "offer");
    }
    let body = b[..b.len() - 64].to_vec();
    let mut r = R::new(&body);
    header(&mut r, obj::INVITE_OFFER)?;
    let o = Offer {
        room_id: r.take_arr()?, invite_id: r.take_arr()?, role: r.u8()?, expires_at: r.u64()?, commit: r.take_arr()?, inviter_id: r.take_arr()?,
        log_seq: r.u32()?, log_hash: r.take_arr()?, body: vec![], signature: b[b.len() - 64..].to_vec(),
    };
    r.end()?;
    Ok(Offer { body, ..o })
}
pub struct Request {
    pub room_id: [u8; 32],
    pub invite_id: [u8; 16],
    pub hub: String,
    pub role: u8,
    pub sign_pub: [u8; 32],
    pub kex_pub: [u8; 32],
    pub offer_hash: [u8; 32],
    pub body: Vec<u8>,
    pub mac: Vec<u8>,
    pub signature: Vec<u8>,
}
pub fn decode_request(b: &[u8]) -> Result<Request> {
    if b.len() < 96 {
        return fail("bad-format", "request");
    }
    let body = b[..b.len() - 96].to_vec();
    let mut r = R::new(&body);
    header(&mut r, obj::INVITE_REQUEST)?;
    let q = Request {
        room_id: r.take_arr()?, invite_id: r.take_arr()?, hub: r.str16(HUB_MAX)?, role: r.u8()?, sign_pub: r.take_arr()?, kex_pub: r.take_arr()?,
        offer_hash: r.take_arr()?, body: vec![], mac: b[b.len() - 96..b.len() - 64].to_vec(), signature: b[b.len() - 64..].to_vec(),
    };
    r.end()?;
    Ok(Request { body, ..q })
}
pub fn verify_invite_offer(state: &LogState, offer: &[u8], now: u64) -> Result<Offer> {
    let o = decode_offer(offer)?;
    if !bytes_equal(&o.room_id, &state.room_id) {
        return fail("bad-invite", "the offer belongs to another room");
    }
    let Some(inviter) = state.member_now(&o.inviter_id).filter(|m| m.role == ROLE_HUMAN) else { return fail("bad-invite", "the offer is not from a human member of this room") };
    if !verify(&inviter.sign_pub, label::INVITE_OFFER_SIG, &o.body, &o.signature) {
        return fail("bad-signature", "invite offer");
    }
    if o.role != ROLE_HUMAN && o.role != ROLE_AGENT {
        return fail("bad-format", "unknown role");
    }
    if now > o.expires_at {
        return fail("invite-expired", "this invite has run out");
    }
    Ok(o)
}
pub fn invite_offer_hash(offer: &[u8]) -> Result<[u8; 32]> {
    Ok(hash(label::INVITE_OFFER, &[&decode_offer(offer)?.body]))
}
pub fn invite_request_hash(request: &[u8]) -> [u8; 32] {
    hash(label::INVITE_REQUEST, &[&request[..request.len() - 64]])
}
pub const CHECK_CODE_SYMBOLS: usize = 6;
fn invite_code(offer: &[u8], request: &[u8], nonce: &[u8]) -> Result<String> {
    let h = hash(label::INVITE_CODE, &[&decode_offer(offer)?.body, &request[..request.len() - 64], nonce]);
    let mut n = u64::from_be_bytes(h[..8].try_into().unwrap()) >> 28;
    let mut out = vec![];
    for _ in 0..CHECK_CODE_SYMBOLS {
        out.insert(0, format!("{:02}", n & 63));
        n >>= 6;
    }
    Ok(out.join("-"))
}
/// The joining device's record of a join (keep it until the join completes).
#[derive(Clone, Debug)]
pub struct Join {
    pub room_id: [u8; 32],
    pub hub: String,
    pub role: u8,
    pub invite_id: [u8; 16],
    pub inviter_id: [u8; 32],
    pub commit: [u8; 32],
    pub offer: Vec<u8>,
    pub request: Vec<u8>,
}
/// Step 3, on the joining device.
pub fn create_join_request(link: &str, offer: &[u8], log: &[Vec<u8>], device: &Device, now: u64) -> Result<(Vec<u8>, Join)> {
    let p = parse_invite_link(link)?;
    let state = verify_log(log, Some(&p.room_id))?;
    let (invite_id, mac_key) = invite_keys(&p.secret, &p.room_id);
    if !bytes_equal(&decode_offer(offer)?.invite_id, &invite_id) {
        return fail("bad-invite", "the offer does not belong to this link");
    }
    let o = verify_invite_offer(&state, offer, now)?;
    if o.log_seq > state.head_seq || !bytes_equal(&state.hashes[o.log_seq as usize], &o.log_hash) {
        return fail("bad-invite", "the offer names a member list this hub does not show");
    }
    let offer_hash = invite_offer_hash(offer)?;
    let body = W::new().u8(VERSION).u8(obj::INVITE_REQUEST).raw(&p.room_id).raw(&invite_id).str16(&p.hub, HUB_MAX)?.u8(o.role).raw(&device.sign_pub).raw(&device.kex_pub).raw(&offer_hash).done();
    let mac = hmac_sha256(&mac_key, &concat(&[&label_bytes(label::INVITE_MAC), &body]));
    let sig = device.sign(label::INVITE_REQUEST_SIG, &concat(&[&body, &mac]));
    let request = concat(&[&body, &mac, &sig]);
    Ok((request.clone(), Join { room_id: p.room_id, hub: p.hub, role: o.role, invite_id, inviter_id: o.inviter_id, commit: o.commit, offer: offer.to_vec(), request }))
}
pub fn verify_invite_reveal(state: &LogState, reveal: &[u8], inviter_id: &[u8]) -> Result<([u8; 16], [u8; 32], [u8; 32])> {
    let Some(inviter) = state.member_now(inviter_id).filter(|m| m.role == ROLE_HUMAN) else { return fail("bad-invite", "the inviter is no longer a member") };
    if reveal.len() < 64 {
        return fail("bad-format", "reveal");
    }
    let body = &reveal[..reveal.len() - 64];
    if !verify(&inviter.sign_pub, label::INVITE_REVEAL_SIG, body, &reveal[reveal.len() - 64..]) {
        return fail("bad-signature", "invite reveal");
    }
    let mut r = R::new(body);
    header(&mut r, obj::INVITE_REVEAL)?;
    let out = (r.take_arr()?, r.take_arr()?, r.take_arr()?);
    r.end()?;
    Ok(out)
}
/// On the joining device: check the reveal and return the check code.
pub fn check_reveal(join: &Join, reveal: &[u8], log: &[Vec<u8>]) -> Result<String> {
    let state = verify_log(log, Some(&join.room_id))?;
    let (invite_id, nonce, request_hash) = verify_invite_reveal(&state, reveal, &join.inviter_id)?;
    if !bytes_equal(&invite_id, &join.invite_id) {
        return fail("bad-invite", "reveal for another invite");
    }
    if !bytes_equal(&request_hash, &invite_request_hash(&join.request)) {
        return fail("bad-invite", "the inviter answered a different request (someone else used this link)");
    }
    if !bytes_equal(&join.commit, &hash(label::INVITE_COMMIT, &[&invite_id, &nonce])) {
        return fail("bad-invite", "the revealed number does not match the commitment");
    }
    invite_code(&join.offer, &join.request, &nonce)
}
/// On the joining device: verify the log up to the room id, find itself, open the room key (humans).
pub fn complete_join(join: &Join, device: &Device, log: &[Vec<u8>], wrap: Option<&[u8]>) -> Result<(LogState, Option<Secret>)> {
    let state = verify_log(log, Some(&join.room_id))?;
    let Some(me) = state.member_now(&device.id) else { return fail("not-member", "the log does not list this device") };
    if me.role != join.role {
        return fail("bad-invite", "enrolled with a different role than invited");
    }
    let added = state.entry(me.added_seq).unwrap();
    if !bytes_equal(&added.invite_id.unwrap_or(ZERO16), &join.invite_id) || !bytes_equal(&added.signer, &join.inviter_id) {
        return fail("bad-invite", "this device was added by another invite or another device");
    }
    if me.role == ROLE_AGENT {
        return Ok((state, None));
    }
    let Some(w) = wrap else { return fail("no-key", "no sealed room key for this device") };
    let ep = state.epoch_at(me.added_seq);
    let s = unwrap_epoch_key(&state, device, w, ep)?;
    Ok((state, Some(s)))
}

/// The inviter's private record (vectors and tests).
pub struct Invite {
    pub room_id: [u8; 32],
    pub hub: String,
    pub role: u8,
    pub secret: [u8; 32],
    pub nonce: [u8; 32],
    pub invite_id: [u8; 16],
    pub expires_at: u64,
    pub offer: Vec<u8>,
    pub used: bool,
    pub request: Option<Vec<u8>>,
    pub accepted_at: Option<u64>,
}
pub fn create_invite(state: &LogState, inviter: &Device, hub: &str, role: u8, app: &str, ttl_ms: u64, now: u64, rng: &mut Rng) -> Result<(String, Vec<u8>, Invite)> {
    let me = state.member_now(&inviter.id);
    if me.map(|m| m.role) != Some(ROLE_HUMAN) {
        return fail("not-human", "only a human device can invite");
    }
    check_hub_address(hub)?;
    let secret = rng.arr32();
    let nonce = rng.arr32();
    let (invite_id, _) = invite_keys(&secret, &state.room_id);
    let expires_at = now + ttl_ms;
    let body = W::new().u8(VERSION).u8(obj::INVITE_OFFER).raw(&state.room_id).raw(&invite_id).u8(role).u64(expires_at)
        .raw(&hash(label::INVITE_COMMIT, &[&invite_id, &nonce])).raw(&inviter.id).u32(state.head_seq).raw(&state.head_hash).done();
    let offer = concat(&[&body, &inviter.sign(label::INVITE_OFFER_SIG, &body)]);
    let link = invite_link(app, hub, &state.room_id, &secret);
    Ok((link, offer.clone(), Invite { room_id: state.room_id, hub: hub.to_string(), role, secret, nonce, invite_id, expires_at, offer, used: false, request: None, accepted_at: None }))
}
/// Step 4, on the inviter: returns (reveal, code, member keys, request hash).
pub fn accept_join_request(invite: &mut Invite, request: &[u8], inviter: &Device, now: u64) -> Result<(Vec<u8>, String, MemberKeys, [u8; 32])> {
    if invite.used {
        return fail("invite-used", "this invite was already answered");
    }
    if now > invite.expires_at {
        return fail("invite-expired", "this invite has run out");
    }
    let q = decode_request(request)?;
    let (_, mac_key) = invite_keys(&invite.secret, &invite.room_id);
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(&mac_key).unwrap();
    m.update(&concat(&[&label_bytes(label::INVITE_MAC), &q.body]));
    if m.verify_slice(&q.mac).is_err() {
        return fail("bad-mac", "the request was not made with this invite link");
    }
    if !bytes_equal(&q.room_id, &invite.room_id) || !bytes_equal(&q.invite_id, &invite.invite_id) || q.hub != invite.hub || q.role != invite.role
        || !bytes_equal(&q.offer_hash, &invite_offer_hash(&invite.offer)?) {
        return fail("bad-invite", "the request does not match the invite");
    }
    if !verify(&q.sign_pub, label::INVITE_REQUEST_SIG, &concat(&[&q.body, &q.mac]), &q.signature) {
        return fail("bad-signature", "invite request");
    }
    invite.used = true;
    invite.accepted_at = Some(now);
    invite.request = Some(request.to_vec());
    let rh = invite_request_hash(request);
    let body = W::new().u8(VERSION).u8(obj::INVITE_REVEAL).raw(&invite.invite_id).raw(&invite.nonce).raw(&rh).done();
    let reveal = concat(&[&body, &inviter.sign(label::INVITE_REVEAL_SIG, &body)]);
    let code = invite_code(&invite.offer, request, &invite.nonce)?;
    Ok((reveal, code, MemberKeys { role: q.role, sign_pub: q.sign_pub, kex_pub: q.kex_pub }, rh))
}
/// Step 5, on the inviter, after the human compared the codes.
pub fn finalize_invite(invite: &Invite, state: &LogState, inviter: &Device, secret: Option<&Secret>, code_confirmed: bool, now: u64, rng: &mut Rng) -> Result<(Vec<u8>, LogState, Option<Vec<u8>>)> {
    let Some(req) = &invite.request else { return fail("bad-invite", "no request was accepted for this invite") };
    if now > invite.accepted_at.unwrap_or(0) + INVITE_CONFIRM_MS {
        return fail("invite-expired", "the confirmation came too late");
    }
    if !code_confirmed && invite.role != ROLE_AGENT {
        return fail("code-not-confirmed", "the check code was not confirmed");
    }
    let q = decode_request(req)?;
    let human = invite.role == ROLE_HUMAN;
    let (entry, next) = add_member(state, inviter, MemberKeys { role: invite.role, sign_pub: q.sign_pub, kex_pub: q.kex_pub }, invite.invite_id, now)?;
    let wrap = if human {
        let s = secret.ok_or_else(|| ZError::new("wrong-epoch", "pass the current epoch secret"))?;
        Some(wrap_epoch_key(&next, s, &device_id(&q.sign_pub, &q.kex_pub), rng)?)
    } else {
        None
    };
    Ok((entry, next, wrap))
}

// ---- signing in to the hub ---------------------------------------------------------------------------------------

pub fn sign_hub_auth(device: &Device, room_id: &[u8], hub: &str, challenge: &[u8]) -> Result<Vec<u8>> {
    check_hub_address(hub)?;
    let body = W::new().u8(VERSION).u8(obj::HUB_AUTH).raw(room_id).str16(hub, HUB_MAX)?.raw(&device.id).raw(challenge).done();
    Ok(concat(&[&body, &device.sign(label::HUB_AUTH, &body)]))
}

// ---- message envelope --------------------------------------------------------------------------------------------

pub mod kind {
    pub const TIMELINE_ITEM: u8 = 1;
    pub const OBJECT_VERSION: u8 = 2;
    pub const ANSWER: u8 = 3;
    pub const PERMISSION_REQUEST: u8 = 4;
    pub const VERDICT: u8 = 5;
    pub const STATUS: u8 = 6;
    pub const DECIDE_AGAIN: u8 = 7;
}
const KIND_MAX: u8 = 7;
pub fn is_known_kind(k: u8) -> bool {
    (1..=KIND_MAX).contains(&k)
}
fn object_kind(k: u8) -> bool {
    matches!(k, kind::OBJECT_VERSION | kind::ANSWER | kind::PERMISSION_REQUEST | kind::VERDICT | kind::DECIDE_AGAIN)
}
pub fn is_thread_kind(k: u8) -> bool {
    k == kind::TIMELINE_ITEM
}
pub const TIMELINE_CHAT: u8 = 1;
pub const TIMELINE_SCRIBBLE: u8 = 2;
pub const KEY_SCOPE_ROOM: u8 = 0;
pub const KEY_SCOPE_SESSION: u8 = 1;
pub const SEEN_MAX: usize = 64;
const FLAG_PUSH: u8 = 1;
const FLAG_OBJECT: u8 = 2;
const NONCE_LEN: usize = 12;
pub const EPOCH_GRACE_MS: u64 = 2 * 60 * 1000;

fn scope_name(s: u8) -> Option<&'static str> {
    match s {
        1 => Some("card"),
        2 => Some("session"),
        3 => Some("desk"),
        _ => None,
    }
}
/// Parse `card/<32 hex>` (also session/, desk/) into (scope, ref).
pub fn parse_timeline_id(text: &str) -> Result<(u8, [u8; 16])> {
    let bad = || ZError::new("bad-argument", "timeline id: card/, session/ or desk/ and 32 lowercase hex characters");
    let (scope, rest) = text.split_once('/').ok_or_else(bad)?;
    let s = match scope {
        "card" => 1,
        "session" => 2,
        "desk" => 3,
        _ => return Err(bad()),
    };
    if !is_hex(rest, 32) {
        return Err(bad());
    }
    Ok((s, unhex(rest).unwrap().try_into().unwrap()))
}
pub fn timeline_id_of(scope: u8, r: &[u8]) -> String {
    format!("{}/{}", scope_name(scope).unwrap_or("?"), hex(r))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Seen {
    pub sender: [u8; 32],
    pub seq: u64,
    pub hash: [u8; 32],
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CardBlock {
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
    pub card: Option<CardBlock>,
    pub timeline_kind: Option<u8>,
    pub timeline_id: Option<String>,
    pub blobs: Vec<[u8; 16]>,
    pub is_head: bool,
    pub known_kind: bool,
}

fn check_grammar(h: &Header, bad: &dyn Fn(&str) -> ZError, strict_kinds: bool) -> Result<()> {
    let known = is_known_kind(h.kind);
    if !known && (strict_kinds || h.kind < 1) {
        return Err(bad(&format!("unknown envelope kind {}", h.kind)));
    }
    if h.key_scope != KEY_SCOPE_ROOM && h.key_scope != KEY_SCOPE_SESSION {
        return Err(bad("unknown key scope"));
    }
    let thread = is_thread_kind(h.kind);
    if known && object_kind(h.kind) != h.card.is_some() {
        return Err(bad(if object_kind(h.kind) { "this kind needs the object block" } else { "this kind has no object block" }));
    }
    if thread != h.timeline_id.is_some() {
        return Err(bad(if thread { "a timeline item needs a timeline" } else { "only timeline items have a timeline" }));
    }
    if thread {
        if h.timeline_kind.unwrap_or(0) < 1 {
            return Err(bad("timeline kind"));
        }
        let (scope, r) = parse_timeline_id(h.timeline_id.as_deref().unwrap())?;
        if scope == 2 && (h.key_scope != KEY_SCOPE_SESSION || h.session_id.map(|s| s != r).unwrap_or(true)) {
            return Err(bad("a session's timeline is sent under that session's key"));
        }
        if scope == 3 && h.key_scope != KEY_SCOPE_ROOM {
            return Err(bad("a desk is sent under the room key"));
        }
    }
    if h.seen.len() > SEEN_MAX {
        return Err(bad(&format!("seen lists at most {SEEN_MAX} senders")));
    }
    Ok(())
}

pub fn encode_header(h: &Header) -> Result<Vec<u8>> {
    check_grammar(h, &|w| ZError::new("bad-argument", w), true)?;
    let flags = (if h.push { FLAG_PUSH } else { 0 }) | (if h.card.is_some() { FLAG_OBJECT } else { 0 });
    let mut w = W::new().u8(VERSION).u8(flags).raw(&h.room_id).u32(h.epoch).u8(h.key_scope);
    if h.key_scope == KEY_SCOPE_SESSION {
        w = w.raw(&h.session_id.ok_or_else(|| ZError::new("bad-argument", "session id must be 16 bytes"))?);
    }
    w = w.raw(&h.sender).u64(h.seq).raw(&h.prev).u32(h.log_seq).raw(&h.log_hash).raw(&h.recipient).u64(h.time).u8(h.kind);
    let mut seen = h.seen.clone();
    seen.sort_by(|a, b| a.sender.cmp(&b.sender));
    w = w.u16(seen.len() as u16);
    for i in 0..seen.len() {
        if i > 0 && seen[i - 1].sender == seen[i].sender {
            return fail("bad-argument", "duplicate sender in seen");
        }
        w = w.raw(&seen[i].sender).u64(seen[i].seq).raw(&seen[i].hash);
    }
    if let Some(c) = &h.card {
        if !(1..=3).contains(&c.state) {
            return fail("bad-argument", "card state");
        }
        if c.urgency > 3 {
            return fail("bad-argument", "urgency");
        }
        w = w.raw(&c.id).u8(c.state).u8(c.urgency).u64(c.answered_at);
    }
    if let Some(tid) = &h.timeline_id {
        let (scope, r) = parse_timeline_id(tid)?;
        w = w.u8(h.timeline_kind.unwrap()).u8(scope).raw(&r);
    }
    if h.blobs.len() > 255 {
        return fail("bad-argument", "too many attachments");
    }
    w = w.u8(h.blobs.len() as u8);
    for b in &h.blobs {
        w = w.raw(b);
    }
    Ok(w.done())
}
fn check_version(v: u8, what: &str) -> Result<()> {
    if v != VERSION {
        return fail(if v > VERSION { "newer-version" } else { "bad-version" }, format!("{what} version {v}"));
    }
    Ok(())
}
pub fn decode_header(bytes: &[u8], strict_kinds: bool) -> Result<Header> {
    let mut r = R::new(bytes);
    check_version(r.u8()?, "envelope header")?;
    let flags = r.u8()?;
    if flags & !(FLAG_PUSH | FLAG_OBJECT) != 0 {
        return fail("bad-format", "unknown header flags");
    }
    let room_id = r.take_arr()?;
    let epoch = r.u32()?;
    let key_scope = r.u8()?;
    if key_scope > 1 {
        return fail("bad-format", "unknown key scope");
    }
    let session_id = if key_scope == KEY_SCOPE_SESSION { Some(r.take_arr()?) } else { None };
    let mut h = Header {
        push: flags & FLAG_PUSH != 0, room_id, epoch, key_scope, session_id, sender: r.take_arr()?, seq: r.u64()?, prev: r.take_arr()?,
        log_seq: r.u32()?, log_hash: r.take_arr()?, recipient: r.take_arr()?, time: r.u64()?, kind: r.u8()?, seen: vec![], card: None,
        timeline_kind: None, timeline_id: None, blobs: vec![], is_head: false, known_kind: false,
    };
    let n = r.u16()? as usize;
    if n > SEEN_MAX {
        return fail("bad-format", format!("seen lists at most {SEEN_MAX} senders"));
    }
    for i in 0..n {
        let s = Seen { sender: r.take_arr()?, seq: r.u64()?, hash: r.take_arr()? };
        if i > 0 && h.seen[i - 1].sender >= s.sender {
            return fail("bad-format", "seen not strictly ascending");
        }
        h.seen.push(s);
    }
    if flags & FLAG_OBJECT != 0 {
        let c = CardBlock { id: r.take_arr()?, state: r.u8()?, urgency: r.u8()?, answered_at: r.u64()? };
        if !(1..=3).contains(&c.state) {
            return fail("bad-format", "unknown card state");
        }
        if c.urgency > 3 {
            return fail("bad-format", "unknown urgency");
        }
        h.card = Some(c);
    }
    if is_thread_kind(h.kind) {
        h.timeline_kind = Some(r.u8()?);
        let scope = r.u8()?;
        if scope_name(scope).is_none() {
            return fail("bad-format", "unknown timeline scope");
        }
        h.timeline_id = Some(timeline_id_of(scope, &r.take(16)?));
    }
    let blobs = r.u8()?;
    for _ in 0..blobs {
        h.blobs.push(r.take_arr()?);
    }
    r.end()?;
    if h.seq < 1 {
        return fail("bad-format", "sequence numbers start at 1");
    }
    check_grammar(&h, &|w| ZError::new("bad-format", w), strict_kinds)?;
    h.is_head = !is_thread_kind(h.kind);
    h.known_kind = is_known_kind(h.kind);
    Ok(h)
}

/// Padded plaintext size: powers of two from 256 bytes to 64 KiB, then multiples of 64 KiB.
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
const BOM: [u8; 3] = [0xef, 0xbb, 0xbf];
fn encode_body(bind: &[u8], payload: &[u8]) -> Result<Vec<u8>> {
    if payload.starts_with(&BOM) {
        return fail("bad-argument", "the payload starts with a byte order mark");
    }
    let raw = W::new().u8(VERSION).var16(bind).var32(payload).done();
    let mut out = vec![0u8; padded_length(raw.len())];
    out[..raw.len()].copy_from_slice(&raw);
    Ok(out)
}
fn decode_body(bytes: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
    let mut r = R::new(bytes);
    check_version(r.u8()?, "envelope body")?;
    let bind = r.var16()?;
    let payload = r.var32()?;
    let used = r.pos();
    if padded_length(used) != bytes.len() {
        return fail("bad-format", "wrong padding length");
    }
    if !is_zero(&r.rest()) {
        return fail("bad-format", "padding is not zero");
    }
    if payload.starts_with(&BOM) {
        return fail("bad-format", "the payload starts with a byte order mark");
    }
    Ok((bind, payload))
}

#[derive(Debug)]
pub struct Split {
    pub header_bytes: Vec<u8>,
    pub nonce: Vec<u8>,
    pub ct: Option<Vec<u8>>,
    pub ct_hash: Option<[u8; 32]>,
    pub signature: Vec<u8>,
    pub pruned: bool,
}
pub fn split_envelope(bytes: &[u8]) -> Result<Split> {
    let mut r = R::new(bytes);
    check_version(r.u8()?, "envelope")?;
    let t = r.u8()?;
    if t != obj::ENVELOPE && t != obj::ENVELOPE_PRUNED {
        return fail("bad-format", "not an envelope");
    }
    let header_bytes = r.var16()?;
    let nonce = r.take(NONCE_LEN)?;
    let pruned = t == obj::ENVELOPE_PRUNED;
    let ct = if pruned { None } else { Some(r.var32()?) };
    let ct_hash = if pruned { Some(r.take_arr()?) } else { None };
    let signature = r.take(64)?;
    r.end()?;
    if ct.as_ref().is_some_and(|c| c.len() < 16) {
        return fail("bad-format", "ciphertext shorter than its tag");
    }
    Ok(Split { header_bytes, nonce, ct, ct_hash, signature, pruned })
}
pub fn prune_envelope(bytes: &[u8]) -> Result<Vec<u8>> {
    let e = split_envelope(bytes)?;
    if e.pruned {
        return Ok(bytes.to_vec());
    }
    Ok(concat(&[&[VERSION, obj::ENVELOPE_PRUNED], &W::new().var16(&e.header_bytes).done(), &e.nonce, &sha256(&[e.ct.as_ref().unwrap()]), &e.signature]))
}
pub struct Peek {
    pub header: Header,
    pub header_bytes: Vec<u8>,
    pub nonce: Vec<u8>,
    pub ciphertext_hash: Option<[u8; 32]>,
    pub pruned: bool,
}
pub fn peek_envelope(bytes: &[u8]) -> Result<Peek> {
    let e = split_envelope(bytes)?;
    Ok(Peek { header: decode_header(&e.header_bytes, false)?, header_bytes: e.header_bytes, nonce: e.nonce, ciphertext_hash: e.ct_hash, pruned: e.pruned })
}

/// One sender's chain: { seq, hash, hashes: seq -> hash }.
#[derive(Clone, Debug, Default)]
pub struct Chain {
    pub seq: u64,
    pub hash: [u8; 32],
    pub hashes: BTreeMap<u64, [u8; 32]>,
    pub told: Option<HashMap<String, u64>>,
}
/// Per-sender chains, keyed by b64u(sender id) as in JS.
pub type Chains = HashMap<String, Chain>;
fn id_key(id: &[u8]) -> String {
    b64u(id)
}

fn seen_from(chains: &Chains, self_id: &[u8; 32], state: &LogState) -> Vec<Seen> {
    let me = id_key(self_id);
    let empty = HashMap::new();
    let told = chains.get(&me).and_then(|c| c.told.as_ref()).unwrap_or(&empty);
    let mut out = vec![];
    for (k, c) in chains {
        if *k == me || c.seq == 0 {
            continue;
        }
        let Ok(id) = unb64u(k) else { continue };
        if state.member_now(&id).is_none() {
            continue;
        }
        if told.get(k) == Some(&c.seq) {
            continue;
        }
        out.push(Seen { sender: id.try_into().unwrap(), seq: c.seq, hash: c.hash });
    }
    out.sort_by(|a, b| a.sender.cmp(&b.sender));
    out.truncate(SEEN_MAX);
    out
}
fn advance(chains: &mut Chains, sender: &[u8], seq: u64, h: [u8; 32], told: Option<&[Seen]>) {
    let c = chains.entry(id_key(sender)).or_default();
    c.seq = seq;
    c.hash = h;
    c.hashes.insert(seq, h);
    if let Some(t) = told {
        let m = c.told.get_or_insert_with(HashMap::new);
        for s in t {
            m.insert(id_key(&s.sender), s.seq);
        }
    }
}

pub struct SenderScope {
    pub key_scope: u8,
    pub session_id: Option<[u8; 16]>,
}
pub fn derive_sender_key(room_id: &[u8], secret: &Secret, sender: &[u8], key_scope: u8, session_id: Option<&[u8; 16]>) -> Vec<u8> {
    let scope = if key_scope == KEY_SCOPE_SESSION { concat(&[&[1u8], session_id.unwrap()]) } else { vec![0u8] };
    hkdf(&secret.key, room_id, label::SENDER_KEY, &concat(&[&scope, &epoch_ctx(secret.epoch), sender]), 32)
}

/// What to seal.
pub struct SealArgs<'a> {
    pub device: &'a Device,
    pub state: &'a LogState,
    pub secret: &'a Secret,
    pub key_scope: u8,
    pub session_id: Option<[u8; 16]>,
    pub kind: u8,
    pub bind: Vec<u8>,
    pub payload: Vec<u8>,
    pub recipient: Option<[u8; 32]>,
    pub time: u64,
    pub card: Option<CardBlock>,
    pub timeline_kind: Option<u8>,
    pub timeline_id: Option<String>,
    pub blobs: Vec<[u8; 16]>,
    pub push: bool,
    pub seen: Option<Vec<Seen>>,
}
pub struct Sealed {
    pub bytes: Vec<u8>,
    pub hash: [u8; 32],
    pub seq: u64,
    pub header: Header,
}
/// Encrypt and sign one message; advances the sender's own chain once the bytes are complete.
pub fn seal_envelope(a: SealArgs, chains: &mut Chains, rng: &mut Rng) -> Result<Sealed> {
    let Some(me) = a.state.member_now(&a.device.id) else { return fail("not-member", "this device is not a member") };
    if a.key_scope == KEY_SCOPE_ROOM {
        if me.role != ROLE_HUMAN {
            return fail("forbidden", "agents hold no room key: they send under a session key");
        }
        if a.secret.epoch != a.state.epoch {
            return fail("wrong-epoch", "send with the current epoch");
        }
        check_commits(a.state, &Secret { hist: None, ..a.secret.clone() })?;
    }
    let own = chains.get(&id_key(&a.device.id));
    let told = a.seen.clone().unwrap_or_else(|| seen_from(chains, &a.device.id, a.state));
    let h = Header {
        push: a.push, room_id: a.state.room_id, epoch: a.secret.epoch, key_scope: a.key_scope,
        session_id: if a.key_scope == KEY_SCOPE_SESSION { a.session_id } else { None }, sender: a.device.id,
        seq: own.map(|c| c.seq).unwrap_or(0) + 1, prev: own.map(|c| c.hash).unwrap_or(ZERO32), log_seq: a.state.head_seq, log_hash: a.state.head_hash,
        recipient: a.recipient.unwrap_or(ZERO32), time: a.time, kind: a.kind, seen: told.clone(), card: a.card,
        timeline_kind: if a.timeline_id.is_some() { a.timeline_kind } else { None }, timeline_id: a.timeline_id.clone(), blobs: a.blobs.clone(),
        is_head: !is_thread_kind(a.kind), known_kind: true,
    };
    let header_bytes = encode_header(&h)?;
    let nonce = rng.bytes(NONCE_LEN);
    let key = derive_sender_key(&a.state.room_id, a.secret, &a.device.id, h.key_scope, h.session_id.as_ref());
    let ct = gcm_seal(&key, &nonce, &header_bytes, &encode_body(&a.bind, &a.payload)?);
    let env_hash = hash(label::ENVELOPE, &[&header_bytes, &nonce, &sha256(&[&ct])]);
    let signature = a.device.sign(label::ENVELOPE_SIG, &env_hash);
    let bytes = concat(&[&[VERSION, obj::ENVELOPE], &W::new().var16(&header_bytes).done(), &nonce, &W::new().var32(&ct).done(), &signature]);
    advance(chains, &a.device.id, h.seq, env_hash, Some(&told));
    Ok(Sealed { bytes, hash: env_hash, seq: h.seq, header: decode_header(&header_bytes, false)? })
}

/// Live acceptance (R3).
pub struct Freshness {
    pub now: u64,
    pub current_epoch: u32,
    pub current_since: u64,
}
pub struct VerifyOpts<'a> {
    pub allow_chain_start: bool,
    pub allow_removed_sender: bool,
    pub commit: bool,
    pub freshness: Option<&'a Freshness>,
    pub strict_kinds: bool,
}
impl Default for VerifyOpts<'_> {
    fn default() -> Self {
        VerifyOpts { allow_chain_start: false, allow_removed_sender: false, commit: true, freshness: None, strict_kinds: false }
    }
}
#[derive(Debug)]
pub struct Verified {
    pub header: Header,
    pub hash: [u8; 32],
    pub ciphertext_hash: [u8; 32],
    pub member_sign_pub: [u8; 32],
    pub pruned: bool,
    pub withheld: Vec<(String, u64, u64)>,
    pub chain_start: bool,
    pub removed_now: bool,
    split: Split,
}
/// Check everything about an envelope that needs no key (FORMAT.md section 9, receiver checks 1-9).
pub fn verify_envelope(bytes: &[u8], state: &LogState, chains: &mut Chains, o: &VerifyOpts) -> Result<Verified> {
    let e = split_envelope(bytes)?;
    let h = decode_header(&e.header_bytes, o.strict_kinds)?;
    if !bytes_equal(&h.room_id, &state.room_id) {
        return fail("wrong-room", "envelope of another room");
    }
    if h.log_seq > state.head_seq {
        return Err(ZError::new("log-behind", format!("the sender knows log entry {}, this device only {}", h.log_seq, state.head_seq)).with("logSeq", h.log_seq));
    }
    if !bytes_equal(&state.hashes[h.log_seq as usize], &h.log_hash) {
        return Err(ZError::new("log-fork", format!("the sender has a different log entry {}", h.log_seq)).with("logSeq", h.log_seq));
    }
    let Some(member) = state.member_at(&h.sender, h.log_seq) else { return fail("not-member", "the sender was not a member at the log state it names") };
    let member_sign_pub = member.sign_pub;
    if h.key_scope == KEY_SCOPE_ROOM {
        if member.role != ROLE_HUMAN {
            return fail("forbidden", "agents hold no room key");
        }
        if state.epoch_at(h.log_seq) != h.epoch {
            return fail("wrong-epoch", "the epoch does not match the log state the sender names");
        }
    }
    if let Some(f) = o.freshness {
        if h.epoch < f.current_epoch && f.now.saturating_sub(f.current_since) > EPOCH_GRACE_MS {
            return fail("wrong-epoch", "sent in an outdated key epoch: the sender is on an old member list");
        }
    }
    let now = state.member(&h.sender).unwrap();
    let removed_now = now.removed_seq.is_some();
    if removed_now {
        if !o.allow_removed_sender {
            return fail("removed-sender", "the sender has been removed since");
        }
        if let Some(cut) = now.cut {
            if h.seq > cut.0 {
                return fail("removed-sender", "beyond the cut its removal names");
            }
        }
    }
    for s in &h.seen {
        if state.member_at(&s.sender, h.log_seq).is_none() {
            return fail("bad-format", "seen names a sender that was not active at the named log state");
        }
    }
    let ct_hash = if e.pruned { e.ct_hash.unwrap() } else { sha256(&[e.ct.as_ref().unwrap()]) };
    let env_hash = hash(label::ENVELOPE, &[&e.header_bytes, &e.nonce, &ct_hash]);
    if !verify(&member_sign_pub, label::ENVELOPE_SIG, &env_hash, &e.signature) {
        return fail("bad-signature", "envelope");
    }
    if removed_now {
        if let Some(cut) = now.cut {
            if h.seq == cut.0 && !bytes_equal(&cut.1, &env_hash) {
                return fail("equivocation", "not the envelope the removal cut names");
            }
        }
    }
    let mut chain_start = false;
    match chains.get(&id_key(&h.sender)) {
        None => {
            if h.seq == 1 {
                if !is_zero(&h.prev) {
                    return fail("chain-break", "the first envelope names a predecessor");
                }
            } else if o.allow_chain_start {
                chain_start = true;
            } else {
                return Err(ZError::new("gap", format!("first envelope seen from this sender has number {}", h.seq)).with("have", 0).with("got", h.seq));
            }
        }
        Some(chain) => {
            if h.seq <= chain.seq {
                if let Some(k) = chain.hashes.get(&h.seq) {
                    if !bytes_equal(k, &env_hash) {
                        return fail("equivocation", format!("two different envelopes with number {} from one sender", h.seq));
                    }
                }
                return fail("replay", format!("envelope {} was already accepted", h.seq));
            } else if h.seq > chain.seq + 1 {
                return Err(ZError::new("gap", format!("envelope {} arrived, {} is missing", h.seq, chain.seq + 1)).with("have", chain.seq).with("got", h.seq));
            } else if !bytes_equal(&h.prev, &chain.hash) {
                return fail("chain-break", "the predecessor hash does not match the envelope accepted before");
            }
        }
    }
    let mut withheld = vec![];
    for s in &h.seen {
        if s.sender == h.sender {
            return fail("bad-format", "a sender cannot list itself as seen");
        }
        let c = chains.get(&id_key(&s.sender));
        if let Some(k) = c.and_then(|c| c.hashes.get(&s.seq)) {
            if !bytes_equal(k, &s.hash) {
                return fail("equivocation", "the sender saw a different envelope than this device under the same number");
            }
        }
        let have = c.map(|c| c.seq).unwrap_or(0);
        if s.seq > have {
            withheld.push((hex(&s.sender), have, s.seq));
        }
    }
    if o.commit {
        advance(chains, &h.sender, h.seq, env_hash, None);
    }
    Ok(Verified { header: h, hash: env_hash, ciphertext_hash: ct_hash, member_sign_pub, pruned: e.pruned, withheld, chain_start, removed_now, split: e })
}

/// How a receiver finds the key: (header) -> secret of its scope and epoch.
pub type SecretsFn<'a> = &'a dyn Fn(&Header) -> Option<Secret>;
#[derive(Debug)]
pub struct Opened {
    pub v: Verified,
    pub bind: Option<Vec<u8>>,
    pub payload: Option<Vec<u8>>,
    pub quarantined: Option<String>,
    pub for_me: bool,
}
fn no_key(h: &Header) -> ZError {
    let mut e = ZError::new("no-key", format!("no key for epoch {}", h.epoch)).with("epoch", h.epoch).with("keyScope", h.key_scope);
    if let Some(s) = h.session_id {
        e = e.with("sessionId", hex(&s));
    }
    e
}
/// Verify, then decrypt (quarantine bodies that fail under a valid signature).
pub fn open_envelope(bytes: &[u8], state: &LogState, chains: &mut Chains, secrets: SecretsFn, self_id: Option<&[u8; 32]>, o: &VerifyOpts, quarantine: bool) -> Result<Opened> {
    let v = verify_envelope(bytes, state, chains, &VerifyOpts { commit: false, ..*o })?;
    if v.pruned {
        return fail("pruned", "the ciphertext of this envelope was deleted");
    }
    let Some(secret) = secrets(&v.header) else { return Err(no_key(&v.header)) };
    let key = derive_sender_key(&state.room_id, &secret, &v.header.sender, v.header.key_scope, v.header.session_id.as_ref());
    let res = gcm_open(&key, &v.split.nonce, &v.split.header_bytes, v.split.ct.as_ref().unwrap()).and_then(|p| decode_body(&p));
    let (bind, payload, quarantined) = match res {
        Ok((b, p)) => (Some(b), Some(p), None),
        Err(err) => {
            if !quarantine || !["decrypt-failed", "bad-format", "bad-version", "newer-version"].contains(&err.code.as_str()) {
                return Err(err);
            }
            (None, None, Some(err.code))
        }
    };
    if o.commit {
        advance(chains, &v.header.sender, v.header.seq, v.hash, None);
    }
    let for_me = is_zero(&v.header.recipient) || self_id.is_some_and(|s| *s == v.header.recipient);
    Ok(Opened { v, bind, payload, quarantined, for_me })
}
/// Open a full envelope whose form the chain verified already (a thread item fetched later).
pub fn open_verified_envelope(bytes: &[u8], state: &LogState, secrets: SecretsFn, envelope_hash: &[u8], self_id: Option<&[u8; 32]>) -> Result<(Header, [u8; 32], Vec<u8>, Vec<u8>, bool)> {
    let e = split_envelope(bytes)?;
    if e.pruned {
        return fail("pruned", "the ciphertext of this envelope was deleted");
    }
    let h = decode_header(&e.header_bytes, false)?;
    if !bytes_equal(&h.room_id, &state.room_id) {
        return fail("wrong-room", "envelope of another room");
    }
    let env_hash = hash(label::ENVELOPE, &[&e.header_bytes, &e.nonce, &sha256(&[e.ct.as_ref().unwrap()])]);
    if !bytes_equal(&env_hash, envelope_hash) {
        return fail("hash-mismatch", "this envelope is not the one the chain verified");
    }
    let Some(member) = state.member(&h.sender) else { return fail("not-member", "the sender is not in the member list") };
    if !verify(&member.sign_pub, label::ENVELOPE_SIG, &env_hash, &e.signature) {
        return fail("bad-signature", "envelope");
    }
    let Some(secret) = secrets(&h) else { return Err(no_key(&h)) };
    let key = derive_sender_key(&state.room_id, &secret, &h.sender, h.key_scope, h.session_id.as_ref());
    let (bind, payload) = decode_body(&gcm_open(&key, &e.nonce, &e.header_bytes, e.ct.as_ref().unwrap())?)?;
    let for_me = is_zero(&h.recipient) || self_id.is_some_and(|s| *s == h.recipient);
    Ok((h, env_hash, bind, payload, for_me))
}

// ---- binds and the agent's gate ------------------------------------------------------------------------------------

pub fn encode_answer_bind(object_id: &[u8; 16], version_hash: &[u8; 32], choices: &[String]) -> Result<Vec<u8>> {
    if choices.len() > 64 {
        return fail("bad-argument", "choices");
    }
    let mut w = W::new().u8(VERSION).raw(object_id).raw(version_hash).u8(choices.len() as u8);
    for c in choices {
        w = w.str16(c, 256)?;
    }
    Ok(w.done())
}
pub fn encode_verdict_bind(request_id: &[u8; 16], request_hash: &[u8; 32], expires_at: u64, allow: bool) -> Vec<u8> {
    W::new().u8(VERSION).raw(request_id).raw(request_hash).u64(expires_at).u8(if allow { 1 } else { 2 }).done()
}
pub fn encode_decide_again_bind(object_id: &[u8; 16], previous_hash: &[u8; 32], version_hash: &[u8; 32]) -> Vec<u8> {
    W::new().u8(VERSION).raw(object_id).raw(previous_hash).raw(version_hash).done()
}
pub fn encode_request_bind(request_id: &[u8; 16], expires_at: u64) -> Vec<u8> {
    W::new().u8(VERSION).raw(request_id).u64(expires_at).done()
}
#[derive(Clone, Debug, PartialEq)]
pub enum Bind {
    Answer { object_id: [u8; 16], version_hash: [u8; 32], choices: Vec<String> },
    DecideAgain { object_id: [u8; 16], previous_hash: [u8; 32], version_hash: [u8; 32] },
    Request { request_id: [u8; 16], expires_at: u64 },
    Verdict { request_id: [u8; 16], request_hash: [u8; 32], expires_at: u64, allow: bool },
}
pub fn decode_bind(k: u8, bind: &[u8]) -> Result<Bind> {
    let mut r = R::new(bind);
    check_version(r.u8()?, "bind")?;
    let out = match k {
        kind::ANSWER => {
            let object_id = r.take_arr()?;
            let version_hash = r.take_arr()?;
            let n = r.u8()?;
            let mut choices = vec![];
            for _ in 0..n {
                choices.push(r.str16(256)?);
            }
            Bind::Answer { object_id, version_hash, choices }
        }
        kind::DECIDE_AGAIN => Bind::DecideAgain { object_id: r.take_arr()?, previous_hash: r.take_arr()?, version_hash: r.take_arr()? },
        kind::PERMISSION_REQUEST => Bind::Request { request_id: r.take_arr()?, expires_at: r.u64()? },
        kind::VERDICT => {
            let request_id = r.take_arr()?;
            let request_hash = r.take_arr()?;
            let expires_at = r.u64()?;
            let a = r.u8()?;
            if a != 1 && a != 2 {
                return fail("bad-format", "verdict");
            }
            Bind::Verdict { request_id, request_hash, expires_at, allow: a == 1 }
        }
        _ => return fail("bad-format", "this kind carries no bind"),
    };
    r.end()?;
    Ok(out)
}

pub struct CardCtx {
    pub id: [u8; 16],
    pub hash: [u8; 32],
    pub open: bool,
    pub options: Option<Vec<String>>,
}
pub struct RequestCtx {
    pub id: [u8; 16],
    pub hash: [u8; 32],
    pub expires_at: u64,
    pub pending: bool,
}
pub struct AuthCtx<'a> {
    pub state: &'a LogState,
    pub agent_id: [u8; 32],
    pub now: u64,
    pub epoch_changed_at: Option<u64>,
    pub own_seq: u64,
    pub max_age_ms: Option<u64>,
    pub seen_of_me: u64,
    pub session_epoch: Option<u32>,
    pub card: Option<CardCtx>,
    pub decision: Option<[u8; 32]>,
    pub request: Option<RequestCtx>,
}
/// The agent's gate (FORMAT.md section 10). Returns `late`.
pub fn authorise_command(h: &Header, quarantined: bool, bind: Option<&[u8]>, ctx: &AuthCtx) -> Result<bool> {
    if quarantined {
        return fail("not-a-command", "the body was quarantined");
    }
    let sender = ctx.state.member_now(&h.sender);
    if sender.map(|m| m.role) != Some(ROLE_HUMAN) {
        return fail("not-human", "commands are accepted from active human devices only");
    }
    if h.recipient != ctx.agent_id {
        return fail("not-for-me", "the command is addressed to someone else");
    }
    let current_epoch = if h.key_scope == KEY_SCOPE_SESSION { ctx.session_epoch } else { Some(ctx.state.epoch) };
    let Some(current_epoch) = current_epoch else { return fail("stale-epoch", "the current session key epoch is not known") };
    let current = h.epoch == current_epoch;
    let grace = h.epoch + 1 == current_epoch && ctx.epoch_changed_at.is_some_and(|at| ctx.now.saturating_sub(at) <= EPOCH_GRACE_MS);
    if !current && !grace {
        return fail("stale-epoch", "the command was sent in an outdated epoch");
    }
    if let Some(max) = ctx.max_age_ms {
        if ctx.now.saturating_sub(h.time) > max {
            return fail("stale", "the command is older than allowed");
        }
    }
    let seen_of_me = h.seen.iter().find(|s| s.sender == ctx.agent_id).map(|s| s.seq).unwrap_or(ctx.seen_of_me);
    let late = seen_of_me < ctx.own_seq;
    if h.kind == kind::TIMELINE_ITEM {
        if h.timeline_kind != Some(TIMELINE_CHAT) {
            return fail("not-a-command", "only chat items reach the agent as messages");
        }
        return Ok(late);
    }
    if h.kind != kind::ANSWER && h.kind != kind::VERDICT && h.kind != kind::DECIDE_AGAIN {
        return fail("not-a-command", "this kind is not a command");
    }
    let b = decode_bind(h.kind, bind.unwrap_or(&[]))?;
    if let Bind::Verdict { request_id, request_hash, expires_at, .. } = &b {
        let Some(q) = ctx.request.as_ref().filter(|q| q.id == *request_id) else { return fail("request-mismatch", "verdict for another request") };
        if h.card.map(|c| c.id) != Some(*request_id) {
            return fail("request-mismatch", "the request id is the object id in the header");
        }
        if !q.pending {
            return fail("request-not-pending", "the request is no longer waiting");
        }
        if q.hash != *request_hash || q.expires_at != *expires_at {
            return fail("request-changed", "the human approved something else than what was asked");
        }
        if ctx.now > q.expires_at {
            return fail("request-expired", "the request has run out");
        }
        return Ok(late);
    }
    let (object_id, version_hash) = match &b {
        Bind::Answer { object_id, version_hash, .. } => (*object_id, *version_hash),
        Bind::DecideAgain { object_id, version_hash, .. } => (*object_id, *version_hash),
        _ => return fail("bad-format", "bind"),
    };
    let Some(card) = ctx.card.as_ref().filter(|c| c.id == object_id) else { return fail("card-mismatch", "answer to another card") };
    if h.card.map(|c| c.id) != Some(object_id) {
        return fail("card-mismatch", "header and body name different cards");
    }
    if card.hash != version_hash {
        return fail("card-changed", "the human saw a different version of the card");
    }
    match &b {
        Bind::Answer { choices, .. } => {
            if !card.open {
                return fail("card-closed", "the card is not open");
            }
            if choices.is_empty() && card.options.as_ref().is_some_and(|o| !o.is_empty()) {
                return fail("bad-choice", "an answer names at least one option");
            }
            if let Some(opts) = &card.options {
                if choices.iter().any(|c| !opts.contains(c)) {
                    return fail("bad-choice", "the card has no such option");
                }
            }
        }
        Bind::DecideAgain { previous_hash, .. } => {
            if ctx.decision != Some(*previous_hash) {
                return fail("decision-mismatch", "this is not the decision in force");
            }
        }
        _ => {}
    }
    Ok(late)
}

// ---- assets ----------------------------------------------------------------------------------------------------------

pub const ASSET_CHUNK: usize = 65536;
const ASSET_HEAD: usize = 22;
fn asset_nonce(index: u64, last: bool) -> [u8; 12] {
    let mut n = [0u8; 12];
    n[3..11].copy_from_slice(&index.to_be_bytes());
    n[11] = last as u8;
    n
}
fn asset_header(blob_id: &[u8]) -> Vec<u8> {
    W::new().u8(VERSION).u8(obj::ASSET).raw(blob_id).u32(ASSET_CHUNK as u32).done()
}
pub struct Asset {
    pub blob: Vec<u8>,
    pub key: [u8; 32],
    pub blob_id: [u8; 16],
    pub sha256: [u8; 32],
    pub size: usize,
}
pub fn encrypt_asset(data: &[u8], rng: &mut Rng) -> Asset {
    let key = rng.arr32();
    let blob_id: [u8; 16] = rng.bytes(16).try_into().unwrap();
    let head = asset_header(&blob_id);
    let mut blob = head.clone();
    let chunks = data.len().div_ceil(ASSET_CHUNK).max(1);
    for i in 0..chunks {
        let from = (i * ASSET_CHUNK).min(data.len());
        let to = ((i + 1) * ASSET_CHUNK).min(data.len());
        blob.extend(gcm_seal(&key, &asset_nonce(i as u64, i == chunks - 1), &head, &data[from..to]));
    }
    let sha = sha256(&[&blob]);
    Asset { blob, key, blob_id, sha256: sha, size: data.len() }
}
pub fn decrypt_asset(blob: &[u8], key: &[u8], expected_sha256: Option<&[u8]>) -> Result<Vec<u8>> {
    if let Some(x) = expected_sha256 {
        if !bytes_equal(&sha256(&[blob]), x) {
            return fail("decrypt-failed", "this is not the blob the message names");
        }
    }
    let mut r = R::new(blob);
    header(&mut r, obj::ASSET)?;
    let _blob_id = r.take(16)?;
    if r.u32()? as usize != ASSET_CHUNK {
        return fail("bad-format", "unsupported chunk size");
    }
    let body = blob.len() - ASSET_HEAD;
    let full = ASSET_CHUNK + 16;
    let chunks = body.div_ceil(full);
    if chunks < 1 || body < (chunks - 1) * full + 16 {
        return fail("bad-format", "asset is cut off");
    }
    let head = &blob[..ASSET_HEAD];
    let mut out = vec![];
    for i in 0..chunks {
        let from = ASSET_HEAD + i * full;
        let to = (from + full).min(blob.len());
        out.extend(gcm_open(key, &asset_nonce(i as u64, i == chunks - 1), head, &blob[from..to])?);
    }
    Ok(out)
}

/// object_id = first 16 bytes of H("trommi/v1/object-id", creator ‖ sender_sequence of version 1).
pub fn object_id_of(creator: &[u8], seq: u64) -> [u8; 16] {
    hash(label::OBJECT_ID, &[creator, &seq.to_be_bytes()])[..16].try_into().unwrap()
}
