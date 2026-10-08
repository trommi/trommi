//! The membership log (FORMAT.md sections 6, 7): entries, `applyEntry`, `verifyLog`, epochs, back links.

use crate::bytes::{bytes_equal, is_zero, R, W};
use crate::prim::{device_id, hash, hkdf, verify};
use crate::{fail, label, obj, ZError, ZResult, ROLE_AGENT, ROLE_HUMAN, VERSION};
use indexmap::IndexMap;
use std::collections::{BTreeMap, HashSet};

pub const ENTRY_GENESIS: u8 = 1;
pub const ENTRY_ADD: u8 = 2;
pub const ENTRY_REMOVE: u8 = 3;
pub const ENTRY_RECOVER: u8 = 5;
pub const SIGNER_DEVICE: u8 = 1;
pub const SIGNER_RECOVERY: u8 = 2;

#[derive(Clone, Debug)]
pub struct MemberKeys {
    pub role: u8,
    pub sign_pub: [u8; 32],
    pub kex_pub: [u8; 32],
}
#[derive(Clone, Debug)]
pub struct Removed {
    pub id: [u8; 32],
    pub seq: u64,
    pub hash: [u8; 32],
}
#[derive(Clone, Debug)]
pub struct Recovery {
    pub sign_pub: [u8; 32],
    pub kex_pub: [u8; 32],
}

/// A decoded entry (not judged).
#[derive(Clone, Debug)]
pub struct Entry {
    pub ty: u8,
    pub seq: u32,
    pub prev: [u8; 32],
    pub time: u64,
    pub signer_kind: u8,
    pub signer: [u8; 32],
    pub room_nonce: Option<[u8; 16]>,
    pub member: Option<MemberKeys>,
    pub invite_id: Option<[u8; 16]>,
    pub removed: Vec<Removed>,
    pub epoch: Option<(u32, [u8; 32], [u8; 32])>,
    pub recovery: Option<Recovery>,
    pub body: Vec<u8>,
    pub signature: [u8; 64],
}

fn read_member(r: &mut R) -> ZResult<MemberKeys> {
    let role = r.u8()?;
    if role != ROLE_HUMAN && role != ROLE_AGENT {
        return Err(fail("bad-format", "unknown role"));
    }
    Ok(MemberKeys { role, sign_pub: r.take32()?, kex_pub: r.take32()? })
}
fn read_removed(r: &mut R) -> ZResult<Vec<Removed>> {
    let n = r.u16()?;
    let mut out: Vec<Removed> = Vec::new();
    for i in 0..n {
        let x = Removed { id: r.take32()?, seq: r.u64()?, hash: r.take32()? };
        if i > 0 && out[i as usize - 1].id >= x.id {
            return Err(fail("bad-format", "ids not strictly ascending"));
        }
        if x.seq == 0 && !is_zero(&x.hash) {
            return Err(fail("bad-format", "a cut without an envelope has a zero hash"));
        }
        out.push(x);
    }
    Ok(out)
}

/// Parse an entry without judging it. Wire form: body || signature(64).
pub fn decode_entry(bytes: &[u8]) -> ZResult<Entry> {
    if bytes.len() < 64 {
        return Err(fail("bad-format", "entry too short"));
    }
    let body = &bytes[..bytes.len() - 64];
    let signature: [u8; 64] = bytes[bytes.len() - 64..].try_into().unwrap();
    let mut r = R::new(body);
    crate::prim::header(&mut r, obj::LOG_ENTRY)?;
    let ty = r.u8()?;
    let seq = r.u32()?;
    let prev = r.take32()?;
    let time = r.u64()?;
    let signer_kind = r.u8()?;
    let signer = r.take32()?;
    let mut e = Entry { ty, seq, prev, time, signer_kind, signer, room_nonce: None, member: None, invite_id: None, removed: vec![], epoch: None, recovery: None, body: body.to_vec(), signature };
    let epoch = |r: &mut R| -> ZResult<(u32, [u8; 32], [u8; 32])> { Ok((r.u32()?, r.take32()?, r.take32()?)) };
    let recovery = |r: &mut R| -> ZResult<Recovery> { Ok(Recovery { sign_pub: r.take32()?, kex_pub: r.take32()? }) };
    match ty {
        ENTRY_GENESIS => {
            e.room_nonce = Some(r.take16()?);
            e.member = Some(read_member(&mut r)?);
            e.recovery = Some(recovery(&mut r)?);
            e.epoch = Some(epoch(&mut r)?);
        }
        ENTRY_ADD => {
            e.member = Some(read_member(&mut r)?);
            e.invite_id = Some(r.take16()?);
        }
        ENTRY_REMOVE => {
            e.removed = read_removed(&mut r)?;
            e.epoch = Some(epoch(&mut r)?);
        }
        ENTRY_RECOVER => {
            e.member = Some(read_member(&mut r)?);
            e.removed = read_removed(&mut r)?;
            e.epoch = Some(epoch(&mut r)?);
            e.recovery = Some(recovery(&mut r)?);
        }
        _ => return Err(fail("bad-format", "unknown entry type")),
    }
    r.end()?;
    if signer_kind != SIGNER_DEVICE && signer_kind != SIGNER_RECOVERY {
        return Err(fail("bad-format", "unknown signer kind"));
    }
    Ok(e)
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
pub struct RecoveryKey {
    pub sign_pub: [u8; 32],
    pub kex_pub: [u8; 32],
    pub id: [u8; 32],
}

/// The verified member list.
#[derive(Clone, Debug)]
pub struct LogState {
    pub room_id: [u8; 32],
    pub head_seq: u32,
    pub head_hash: [u8; 32],
    pub hashes: Vec<[u8; 32]>,
    pub entries: Vec<Entry>,
    pub members: IndexMap<[u8; 32], Member>,
    pub epoch: u32,
    pub epochs: BTreeMap<u32, EpochInfo>,
    pub recovery: RecoveryKey,
    pub invite_ids: HashSet<[u8; 16]>,
    pub last_recover_seq: i64,
}

fn kex_canon(k: &[u8; 32]) -> [u8; 32] {
    let mut c = *k;
    c[31] &= 0x7f;
    c
}
fn same_kex(a: &[u8; 32], b: &[u8; 32]) -> bool { bytes_equal(&kex_canon(a), &kex_canon(b)) }
fn keys_clash(a_sign: &[u8; 32], a_kex: &[u8; 32], b_sign: &[u8; 32], b_kex: &[u8; 32]) -> bool {
    bytes_equal(a_sign, b_sign) || same_kex(a_kex, b_kex)
}

impl LogState {
    /// The member with this id if it was active once entry `log_seq` had been applied.
    pub fn member_at(&self, id: &[u8], log_seq: Option<u32>) -> Option<&Member> {
        let log_seq = log_seq.unwrap_or(self.head_seq);
        let key: [u8; 32] = id.try_into().ok()?;
        let m = self.members.get(&key)?;
        if m.added_seq > log_seq || m.removed_seq.is_some_and(|r| r <= log_seq) {
            return None;
        }
        Some(m)
    }
    pub fn active_members(&self) -> impl Iterator<Item = &Member> { self.members.values().filter(|m| m.removed_seq.is_none()) }
    pub fn epoch_at(&self, log_seq: u32) -> u32 {
        let mut best = 0;
        for (&epoch, info) in &self.epochs {
            if info.seq <= log_seq && epoch > best {
                best = epoch;
            }
        }
        best
    }
}

/// Verify one entry against the state before it and return the state after it. Never mutates.
pub fn apply_entry(state: Option<&LogState>, entry_bytes: &[u8]) -> ZResult<LogState> {
    let e = decode_entry(entry_bytes)?;
    let entry_hash = hash(label::LOG_ENTRY, &[&e.body]);
    let bad = |why: &str| -> ZError { fail("bad-entry", &format!("entry {}: {}", e.seq, why)) };
    let check_sig = |pub_key: &[u8; 32]| -> ZResult<()> {
        if !verify(pub_key, label::LOG_SIG, &e.body, &e.signature) {
            return Err(fail("bad-signature", &format!("entry {}", e.seq)));
        }
        Ok(())
    };

    let Some(state) = state else {
        if e.ty != ENTRY_GENESIS {
            return Err(bad("a log starts with a genesis entry"));
        }
        if e.seq != 0 || !is_zero(&e.prev) {
            return Err(bad("genesis must have number 0 and no predecessor"));
        }
        let member = e.member.clone().unwrap();
        if e.signer_kind != SIGNER_DEVICE || member.role != ROLE_HUMAN {
            return Err(bad("genesis must be signed by a human device"));
        }
        let id = device_id(&member.sign_pub, &member.kex_pub);
        if !bytes_equal(&id, &e.signer) {
            return Err(bad("signer is not the founding device"));
        }
        let (epoch, kc, hc) = e.epoch.unwrap();
        if epoch != 1 {
            return Err(bad("the first epoch is 1"));
        }
        check_sig(&member.sign_pub)?;
        let rec = e.recovery.clone().unwrap();
        let rid = device_id(&rec.sign_pub, &rec.kex_pub);
        if bytes_equal(&rid, &id) || keys_clash(&rec.sign_pub, &rec.kex_pub, &member.sign_pub, &member.kex_pub) {
            return Err(bad("recovery key equals the device key"));
        }
        let mut members = IndexMap::new();
        members.insert(id, Member { id, role: member.role, sign_pub: member.sign_pub, kex_pub: member.kex_pub, added_seq: 0, removed_seq: None, cut: None });
        let mut epochs = BTreeMap::new();
        epochs.insert(1, EpochInfo { seq: 0, key_commit: kc, hist_commit: hc });
        return Ok(LogState {
            room_id: entry_hash,
            head_seq: 0,
            head_hash: entry_hash,
            hashes: vec![entry_hash],
            entries: vec![e],
            members,
            epoch: 1,
            epochs,
            recovery: RecoveryKey { sign_pub: rec.sign_pub, kex_pub: rec.kex_pub, id: rid },
            invite_ids: HashSet::new(),
            last_recover_seq: -1,
        });
    };

    if e.ty == ENTRY_GENESIS {
        return Err(bad("a second genesis entry"));
    }
    if e.seq as u64 != state.head_seq as u64 + 1 {
        return Err(bad(&format!("number {} does not follow {}", e.seq, state.head_seq)));
    }
    if !bytes_equal(&e.prev, &state.head_hash) {
        return Err(bad("predecessor hash does not match"));
    }

    if e.ty == ENTRY_RECOVER {
        if e.signer_kind != SIGNER_RECOVERY || !bytes_equal(&e.signer, &state.recovery.id) {
            return Err(bad("only the recovery key may sign a recovery"));
        }
        check_sig(&state.recovery.sign_pub)?;
    } else if e.signer_kind == SIGNER_RECOVERY {
        let m = e.member.as_ref();
        if e.ty != ENTRY_ADD || m.map(|m| m.role) != Some(ROLE_HUMAN) || !is_zero(&e.invite_id.unwrap_or([1; 16])) {
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
        let m = state.members.get(&e.signer);
        let Some(m) = m.filter(|m| m.removed_seq.is_none()) else { return Err(bad("signer is not a member")) };
        if m.role != ROLE_HUMAN {
            return Err(bad("agents may not change the membership"));
        }
        check_sig(&m.sign_pub)?;
    }

    let mut next = state.clone();
    let add_member = |next: &mut LogState, member: &MemberKeys| -> ZResult<()> {
        let id = device_id(&member.sign_pub, &member.kex_pub);
        if next.members.contains_key(&id) {
            return Err(bad("this device was already a member (removed devices cannot return)"));
        }
        if bytes_equal(&id, &state.recovery.id) || keys_clash(&state.recovery.sign_pub, &state.recovery.kex_pub, &member.sign_pub, &member.kex_pub) {
            return Err(bad("the recovery key cannot be a member"));
        }
        for m in next.members.values() {
            if keys_clash(&m.sign_pub, &m.kex_pub, &member.sign_pub, &member.kex_pub) {
                return Err(bad("key already in use by another member"));
            }
        }
        next.members.insert(id, Member { id, role: member.role, sign_pub: member.sign_pub, kex_pub: member.kex_pub, added_seq: e.seq, removed_seq: None, cut: None });
        Ok(())
    };
    let remove_members = |next: &mut LogState, removed: &[Removed]| -> ZResult<()> {
        for x in removed {
            match next.members.get_mut(&x.id) {
                Some(m) if m.removed_seq.is_none() => {
                    m.removed_seq = Some(e.seq);
                    m.cut = Some((x.seq, x.hash));
                }
                _ => return Err(bad("removing someone who is not a member")),
            }
        }
        Ok(())
    };
    let new_epoch = |next: &mut LogState| -> ZResult<()> {
        let (epoch, kc, hc) = e.epoch.unwrap();
        if epoch as u64 != state.epoch as u64 + 1 {
            return Err(bad(&format!("epoch {} does not follow {}", epoch, state.epoch)));
        }
        next.epoch = epoch;
        next.epochs.insert(epoch, EpochInfo { seq: e.seq, key_commit: kc, hist_commit: hc });
        Ok(())
    };
    match e.ty {
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
            let member = e.member.as_ref().unwrap();
            if member.role != ROLE_HUMAN {
                return Err(bad("recovery enrols a human device"));
            }
            let all_humans = state.active_members().filter(|m| m.role == ROLE_HUMAN).all(|m| e.removed.iter().any(|x| bytes_equal(&x.id, &m.id)));
            if !all_humans {
                return Err(bad("a recovery removes every human device"));
            }
            remove_members(&mut next, &e.removed)?;
            add_member(&mut next, member)?;
            new_epoch(&mut next)?;
            let rec = e.recovery.clone().unwrap();
            let id = device_id(&rec.sign_pub, &rec.kex_pub);
            if bytes_equal(&id, &state.recovery.id) {
                return Err(bad("recovery must install a new recovery key"));
            }
            if next.members.contains_key(&id) || next.members.values().any(|m| keys_clash(&m.sign_pub, &m.kex_pub, &rec.sign_pub, &rec.kex_pub)) {
                return Err(bad("recovery key equals a device key"));
            }
            next.recovery = RecoveryKey { sign_pub: rec.sign_pub, kex_pub: rec.kex_pub, id };
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

/// Verify a whole log. `room_id` (from the invite link or from local storage) is what makes it trustworthy.
pub fn verify_log(entries: &[Vec<u8>], room_id: Option<&[u8]>) -> ZResult<LogState> {
    if entries.is_empty() {
        return Err(fail("bad-entry", "empty log"));
    }
    let mut state: Option<LogState> = None;
    for b in entries {
        state = Some(apply_entry(state.as_ref(), b)?);
    }
    let state = state.unwrap();
    if let Some(rid) = room_id {
        if !bytes_equal(&state.room_id, rid) {
            return Err(fail("wrong-room", "the genesis entry does not hash to this room id"));
        }
    }
    Ok(state)
}

// ---- epoch secrets: commitments, wraps, back links (for the vectors and clients) -------------------

#[derive(Clone, Debug, PartialEq)]
pub struct EpochSecret {
    pub epoch: u32,
    pub key: Vec<u8>,
    pub hist: Option<Vec<u8>>,
}
pub fn epoch_commits(secret: &EpochSecret) -> ([u8; 32], Option<[u8; 32]>) {
    let ctx = secret.epoch.to_be_bytes();
    let k = hkdf(&secret.key, &[], label::KEY_COMMIT, &ctx, 32);
    let h = secret.hist.as_ref().map(|h| crate::bytes::arr32(&hkdf(h, &[], label::HIST_COMMIT, &ctx, 32)));
    (crate::bytes::arr32(&k), h)
}
pub fn check_commits(state: &LogState, secret: &EpochSecret) -> ZResult<()> {
    let Some(info) = state.epochs.get(&secret.epoch) else { return Err(fail("wrong-epoch", &format!("the log knows no epoch {}", secret.epoch))) };
    let (k, h) = epoch_commits(secret);
    if !bytes_equal(&k, &info.key_commit) {
        return Err(fail("key-mismatch", "room key does not match the commitment in the log"));
    }
    if let Some(h) = h {
        if !bytes_equal(&h, &info.hist_commit) {
            return Err(fail("key-mismatch", "history key does not match the commitment in the log"));
        }
    }
    Ok(())
}
pub fn epoch_wrap_aad(room_id: &[u8], epoch: u32, recipient: &[u8]) -> Vec<u8> {
    let mut v = crate::prim::label_bytes(label::EPOCH_WRAP);
    v.extend_from_slice(room_id);
    v.extend_from_slice(&epoch.to_be_bytes());
    v.extend_from_slice(recipient);
    v
}
pub fn secret_of_plain(epoch: u32, plain: &[u8]) -> ZResult<EpochSecret> {
    if plain.len() == 33 && plain[0] == 1 {
        Ok(EpochSecret { epoch, key: plain[1..].to_vec(), hist: None })
    } else if plain.len() == 65 && plain[0] == 2 {
        Ok(EpochSecret { epoch, key: plain[1..33].to_vec(), hist: Some(plain[33..].to_vec()) })
    } else {
        Err(fail("bad-format", "wrapped epoch secret"))
    }
}
pub fn unwrap_epoch_key(state: &LogState, device: &crate::prim::Device, sealed: &[u8], epoch: u32) -> ZResult<EpochSecret> {
    let plain = crate::prim::open_sealed(device, sealed, &epoch_wrap_aad(&state.room_id, epoch, &device.id))?;
    let s = secret_of_plain(epoch, &plain)?;
    check_commits(state, &s)?;
    Ok(s)
}
/// Open a room back link with the epoch secret it belongs to: the previous epoch secret.
pub fn open_back_link(state: &LogState, secret: &EpochSecret, link: &[u8]) -> ZResult<EpochSecret> {
    let mut r = R::new(link);
    crate::prim::header(&mut r, obj::BACK_LINK)?;
    if r.u32()? != secret.epoch {
        return Err(fail("wrong-epoch", "back link belongs to another epoch"));
    }
    let Some(hist) = &secret.hist else { return Err(fail("no-key", "agents hold no history key")) };
    let okm = hkdf(hist, &state.room_id, label::BACK_LINK, &secret.epoch.to_be_bytes(), 44);
    let aad = W::new().u8(VERSION).u8(obj::BACK_LINK).raw(&state.room_id).u32(secret.epoch).done();
    let plain = crate::prim::gcm_open(&okm[..32], &okm[32..], &aad, r.take(r.left())?)?;
    if plain.len() != 64 {
        return Err(fail("bad-format", "back link"));
    }
    let prev = EpochSecret { epoch: secret.epoch - 1, key: plain[..32].to_vec(), hist: Some(plain[32..].to_vec()) };
    check_commits(state, &prev)?;
    Ok(prev)
}
