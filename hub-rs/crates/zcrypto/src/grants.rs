//! Session grants (FORMAT.md section 19, `session-grants.mjs`): decode, `applyGrant`, the manifest hash, staleness.

use crate::bytes::{bytes_equal, hex, R};
use crate::log::{LogState, ENTRY_GENESIS, ENTRY_RECOVER, ENTRY_REMOVE};
use crate::prim::{device_id, hash, sha256, verify};
use crate::{fail, label, obj, ZResult, ROLE_AGENT, ROLE_HUMAN, VERSION};
use std::collections::BTreeMap;

const FLAG_HISTORY: u8 = 1;

#[derive(Debug)]
pub struct Grant {
    pub room_id: [u8; 32],
    pub session_id: [u8; 16],
    pub grant_number: u32,
    pub previous_grant_hash: [u8; 32],
    pub epoch: u32,
    pub with_history: bool,
    pub agent_ids: Vec<[u8; 32]>,
    pub key_commit: [u8; 32],
    pub hist_commit: [u8; 32],
    pub manifest_hash: [u8; 32],
    pub log_seq: u32,
    pub log_hash: [u8; 32],
    pub time: u64,
    pub signer_id: [u8; 32],
    pub body: Vec<u8>,
    pub signature: Vec<u8>,
}

pub fn decode_grant(bytes: &[u8]) -> ZResult<Grant> {
    if bytes.len() < 64 {
        return Err(fail("bad-format", "grant too short"));
    }
    let body = &bytes[..bytes.len() - 64];
    let trunc = |e: crate::ZError| if e.code == "bad-format" && e.message == "bad-format: truncated" { fail("bad-format", "truncated grant") } else { e };
    let mut r = R::new(body);
    if r.u8().map_err(trunc)? != VERSION {
        return Err(fail("bad-version", "grant version"));
    }
    if r.u8().map_err(trunc)? != obj::GRANT {
        return Err(fail("bad-format", "not a session grant"));
    }
    let g = (|| -> ZResult<Grant> {
        let room_id = r.take32()?;
        let session_id = r.take16()?;
        let grant_number = r.u32()?;
        let previous_grant_hash = r.take32()?;
        let epoch = r.u32()?;
        let flags = r.u8()?;
        if flags & !FLAG_HISTORY != 0 {
            return Err(fail("bad-format", "unknown grant flags"));
        }
        let n = r.u16()?;
        let mut agent_ids: Vec<[u8; 32]> = vec![];
        for i in 0..n as usize {
            let id = r.take32()?;
            if i > 0 && agent_ids[i - 1] >= id {
                return Err(fail("bad-format", "agent ids not strictly ascending"));
            }
            agent_ids.push(id);
        }
        let key_commit = r.take32()?;
        let hist_commit = r.take32()?;
        let manifest_hash = r.take32()?;
        let log_seq = r.u32()?;
        let log_hash = r.take32()?;
        let time = r.u64()?;
        let signer_id = r.take32()?;
        r.end()?;
        Ok(Grant {
            room_id, session_id, grant_number, previous_grant_hash, epoch, with_history: flags & FLAG_HISTORY != 0, agent_ids, key_commit, hist_commit, manifest_hash,
            log_seq, log_hash, time, signer_id, body: body.to_vec(), signature: bytes[bytes.len() - 64..].to_vec(),
        })
    })()
    .map_err(trunc)?;
    Ok(g)
}

#[derive(Clone, Debug)]
pub struct EpochInfo {
    pub key_commit: [u8; 32],
    pub hist_commit: [u8; 32],
    pub with_history: bool,
}
#[derive(Clone, Debug)]
pub struct SessionState {
    pub session_id: String,
    pub grant_number: u32,
    pub grant_hash: [u8; 32],
    pub epoch: u32,
    pub agent_ids: Vec<String>,
    pub with_history: bool,
    pub key_commit: [u8; 32],
    pub hist_commit: [u8; 32],
    pub manifest_hash: [u8; 32],
    pub log_seq: u32,
    pub signer_id: String,
    pub epochs: BTreeMap<u32, EpochInfo>,
    pub creator_id: String,
    pub created_by_agent: bool,
    pub stale: bool,
}

fn member_changes(room: &LogState) -> impl Iterator<Item = u32> + '_ {
    room.entries.iter().filter(|e| e.ty == ENTRY_REMOVE || e.ty == ENTRY_RECOVER).map(|e| e.seq)
}
fn change_between(room: &LogState, a: u32, b: u32) -> bool { member_changes(room).any(|s| s > a && s <= b) }
/// True if a removal or recovery came after the session's newest grant.
pub fn grant_is_stale(s: Option<&SessionState>, room: &LogState) -> bool { s.is_some_and(|s| change_between(room, s.log_seq, room.head_seq)) }

fn recovery_id_at(room: &LogState, log_seq: u32) -> Option<([u8; 32], [u8; 32])> {
    let mut rec = None;
    for e in &room.entries {
        if e.seq > log_seq {
            break;
        }
        if e.ty == ENTRY_GENESIS || e.ty == ENTRY_RECOVER {
            rec = e.recovery.clone();
        }
    }
    rec.map(|r| (device_id(&r.sign_pub, &r.kex_pub), r.sign_pub))
}

/// Verify one grant against the session's state before it (None for the first) and the verified member list.
pub fn apply_grant(prev: Option<&SessionState>, grant_bytes: &[u8], room: &LogState) -> ZResult<SessionState> {
    let g = decode_grant(grant_bytes)?;
    let bad = |why: &str| fail("bad-grant", &format!("grant {}: {}", g.grant_number, why));
    if !bytes_equal(&g.room_id, &room.room_id) {
        return Err(fail("wrong-room", "grant of another room"));
    }
    if g.log_seq > room.head_seq {
        return Err(fail("log-behind", &format!("the grant names member list entry {}", g.log_seq)));
    }
    if !bytes_equal(&room.hashes[g.log_seq as usize], &g.log_hash) {
        return Err(fail("log-fork", &format!("the grant names another member list entry {}", g.log_seq)));
    }
    let rec = recovery_id_at(room, g.log_seq);
    let is_recovery = rec.is_some_and(|(id, _)| bytes_equal(&g.signer_id, &id));
    let signer = if is_recovery { None } else { room.member_at(&g.signer_id, Some(g.log_seq)) };
    let agent_own = !is_recovery && signer.is_some_and(|s| s.role == ROLE_AGENT) && prev.is_none() && g.agent_ids.len() == 1 && bytes_equal(&g.agent_ids[0], &g.signer_id) && !g.with_history;
    if !is_recovery && !agent_own && signer.map(|s| s.role) != Some(ROLE_HUMAN) {
        return Err(bad(if signer.map(|s| s.role) == Some(ROLE_AGENT) {
            "an agent signs only the first grant of a session of its own, assigned to itself alone"
        } else {
            "the signer is not an active human device"
        }));
    }
    let pub_key = if is_recovery { rec.unwrap().1 } else { signer.unwrap().sign_pub };
    if !verify(&pub_key, label::GRANT_SIG, &g.body, &g.signature) {
        return Err(fail("bad-signature", "session grant"));
    }
    match prev {
        None => {
            if g.grant_number != 0 || !crate::bytes::is_zero(&g.previous_grant_hash) || g.epoch != 1 {
                return Err(bad("the first grant has number 0, no predecessor and epoch 1"));
            }
        }
        Some(p) => {
            if hex(&g.session_id) != p.session_id {
                return Err(bad("another session"));
            }
            if g.grant_number as u64 != p.grant_number as u64 + 1 {
                return Err(bad(&format!("number {} does not follow {}", g.grant_number, p.grant_number)));
            }
            if !bytes_equal(&g.previous_grant_hash, &p.grant_hash) {
                return Err(bad("predecessor hash does not match"));
            }
            if g.epoch != p.epoch && g.epoch as u64 != p.epoch as u64 + 1 {
                return Err(bad(&format!("epoch {} after {}", g.epoch, p.epoch)));
            }
            if g.epoch == p.epoch && (!bytes_equal(&g.key_commit, &p.key_commit) || !bytes_equal(&g.hist_commit, &p.hist_commit)) {
                return Err(bad("same epoch, different key"));
            }
            let (lo, hi) = (g.log_seq.min(p.log_seq), g.log_seq.max(p.log_seq));
            if change_between(room, lo, hi) {
                if g.log_seq < p.log_seq {
                    return Err(bad("names a member list entry before a removal its predecessor already saw"));
                }
                if g.epoch == p.epoch {
                    return Err(bad("after a removal or recovery the session key must change"));
                }
            }
            if g.epoch == p.epoch && !p.agent_ids.iter().all(|a| g.agent_ids.iter().any(|b| &hex(b) == a)) {
                return Err(bad("an agent loses the session: the key must change"));
            }
        }
    }
    for id in &g.agent_ids {
        match room.member_at(id, Some(g.log_seq)) {
            Some(m) if m.role == ROLE_AGENT => {}
            _ => return Err(bad("an assigned device is not an active agent")),
        }
    }
    let mut epochs = prev.map(|p| p.epochs.clone()).unwrap_or_default();
    let prev_hist = epochs.get(&g.epoch).is_some_and(|i| i.with_history);
    epochs.insert(g.epoch, EpochInfo { key_commit: g.key_commit, hist_commit: g.hist_commit, with_history: g.with_history || prev_hist });
    Ok(SessionState {
        session_id: hex(&g.session_id),
        grant_number: g.grant_number,
        grant_hash: hash(label::GRANT, &[&g.body]),
        epoch: g.epoch,
        agent_ids: g.agent_ids.iter().map(|a| hex(a)).collect(),
        with_history: g.with_history,
        key_commit: g.key_commit,
        hist_commit: g.hist_commit,
        manifest_hash: g.manifest_hash,
        log_seq: g.log_seq,
        signer_id: hex(&g.signer_id),
        epochs,
        creator_id: prev.map(|p| p.creator_id.clone()).unwrap_or_else(|| hex(&g.signer_id)),
        created_by_agent: prev.map(|p| p.created_by_agent).unwrap_or(agent_own),
        stale: change_between(room, g.log_seq, room.head_seq),
    })
}

/// The hash a grant carries over its wrap set: H(manifest, for each recipient ascending: id || SHA-256(sealed)).
pub fn grant_manifest_hash(wraps: &[([u8; 32], Vec<u8>)]) -> [u8; 32] {
    let mut sorted: Vec<&([u8; 32], Vec<u8>)> = wraps.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let mut parts: Vec<Vec<u8>> = vec![];
    for (id, sealed) in sorted {
        parts.push(id.to_vec());
        parts.push(sha256(&[sealed]).to_vec());
    }
    let refs: Vec<&[u8]> = parts.iter().map(|p| p.as_slice()).collect();
    hash(label::SESSION_MANIFEST, &refs)
}
