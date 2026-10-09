//! Trommi's rules on top of MLS, as one function used by the hub (on the public
//! state) and by every device (before it merges a commit).
//!
//! How a role is carried: by the room group's public state and nothing else.
//!   human device = a leaf of the room group (its signature key)
//!   agent device = a signature key in the roster inside the room group's
//!                  context extension, which only a room member can change
//! A credential's text is a label for people; no rule reads it.

use std::collections::BTreeSet;

use openmls_rust_crypto::RustCrypto;
use openmls_traits::{crypto::OpenMlsCrypto, signatures::Signer, types::SignatureScheme};
use serde::{Deserialize, Serialize};

use crate::{hex, unhex, Gid, SigKey};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Kind {
    Room,
    Session,
}

/// The group context extension `EXT_META`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupMeta {
    pub kind: Kind,
    /// hex id of the room group (its own id for the room group)
    pub room: String,
    /// session groups: hex id of the parent session's group, for a helper
    pub parent: Option<String>,
    /// hex signature key of the device that founded the group
    pub founder: String,
    /// room group only: enrolled agent devices (hex signature keys)
    pub agents: Vec<String>,
    /// room group only: public halves of the recovery key
    pub recovery_sign: Option<String>,
    pub recovery_hpke: Option<String>,
}

impl GroupMeta {
    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap()
    }
    pub fn from_bytes(b: &[u8]) -> Result<Self, String> {
        serde_json::from_slice(b).map_err(|e| format!("group statement unreadable: {e}"))
    }
}

/// What anyone can read from the room group's public state.
#[derive(Clone, Debug)]
pub struct RoomView {
    pub gid: Gid,
    pub epoch: u64,
    pub humans: BTreeSet<SigKey>,
    pub agents: BTreeSet<SigKey>,
    pub recovery_sign: Option<SigKey>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum By {
    /// a member's commit: its signature key
    Member(SigKey),
    /// an external commit: the signature key of the leaf it brings
    External(SigKey),
}

/// What a commit does, read from the commit and the state before it.
#[derive(Clone, Debug)]
pub struct Facts {
    pub gid: Gid,
    pub meta: GroupMeta,
    pub epoch: u64,
    pub members: Vec<SigKey>,
    pub by: By,
    pub adds: Vec<SigKey>,
    pub removes: Vec<SigKey>,
    pub new_meta: Option<GroupMeta>,
    pub aad: Vec<u8>,
    /// helper groups: the members of the parent session's group, as the checker sees them
    pub parent_members: Option<Vec<SigKey>>,
    /// proposals of a kind the rules do not know
    pub unknown: usize,
}

fn recover_tbs(gid: &[u8], epoch: u64, joiner: &[u8]) -> Vec<u8> {
    let mut m = b"trommi/v2/recover".to_vec();
    m.extend(gid);
    m.extend(epoch.to_be_bytes());
    m.extend(joiner);
    m
}

/// The recovery key's statement "this device may join by external commit", put into
/// the commit's authenticated data.
pub fn recovery_authorisation(signer: &impl Signer, gid: &[u8], epoch: u64, joiner: &[u8]) -> Vec<u8> {
    signer.sign(&recover_tbs(gid, epoch, joiner)).unwrap()
}

pub fn check(f: &Facts, room: &RoomView, crypto: &RustCrypto) -> Result<(), String> {
    if f.unknown > 0 {
        return Err("a proposal of a kind the rules do not know".into());
    }
    match f.meta.kind {
        Kind::Room => check_room(f, crypto),
        Kind::Session => check_session(f, room),
    }
}

fn check_room(f: &Facts, crypto: &RustCrypto) -> Result<(), String> {
    if let Some(n) = &f.new_meta {
        if n.kind != Kind::Room || n.room != f.meta.room || n.founder != f.meta.founder || n.parent.is_some() {
            return Err("the room statement may change only its roster and recovery key".into());
        }
    }
    match &f.by {
        // every member of the room group is a human device
        By::Member(_) => Ok(()),
        By::External(k) => {
            if !f.adds.is_empty() || f.new_meta.is_some() {
                return Err("an external commit may only bring its own leaf".into());
            }
            if f.removes.iter().any(|r| r != k) {
                return Err("an external commit may only remove its own old leaf".into());
            }
            // (a) a member device that lost its state comes back under the same signature key
            if f.members.contains(k) && f.removes == vec![k.clone()] {
                return Ok(());
            }
            // (b) a device authorised by the recovery key
            let pk = f
                .meta
                .recovery_sign
                .as_ref()
                .map(|h| unhex(h))
                .ok_or("no recovery key in the room statement")?;
            crypto
                .verify_signature(SignatureScheme::ED25519, &recover_tbs(&f.gid, f.epoch, k), &pk, &f.aad)
                .map_err(|_| "external commit into the room group without the recovery key's signature".to_string())
        }
    }
}

fn check_session(f: &Facts, room: &RoomView) -> Result<(), String> {
    if f.new_meta.as_ref().is_some_and(|n| *n != f.meta) {
        return Err("a session group's statement never changes".into());
    }
    if f.meta.room != hex(&room.gid) {
        return Err("session group of another room".into());
    }
    let human = |k: &SigKey| room.humans.contains(k);
    match &f.by {
        By::Member(k) if human(k) => {
            for a in &f.adds {
                if !human(a) && !room.agents.contains(a) {
                    return Err("a human device may add human devices and enrolled agent devices only".into());
                }
            }
            if f.removes.iter().any(human) {
                return Err("a human device leaves a session group only after it has left the room group".into());
            }
            if f.epoch == 0 {
                if let Some(missing) = room.humans.iter().find(|h| *h != k && !f.adds.contains(h)) {
                    return Err(format!("founding commit leaves out human device {}", &hex(missing)[..8]));
                }
            }
            Ok(())
        }
        By::Member(k) => {
            // Agents commit nothing: every epoch of a session is made by a human device,
            // which also files that epoch's key. The one exception is the founder of a
            // helper group, in that group.
            let founder_of_helper = f.meta.parent.is_some() && f.meta.founder == hex(k);
            if !founder_of_helper {
                return Err("an agent adds and removes nobody, except in a helper group it founded".into());
            }
            // the founder's right lasts as long as it is in the parent session. (A checker
            // that cannot see the parent group, a helper's own agent device, skips this;
            // the hub and every human device can.)
            if f.parent_members.as_ref().is_some_and(|pm| !pm.contains(k)) {
                return Err("the founder is no longer a member of the parent session".into());
            }
            if f.epoch == 0 {
                // the founding commit: every human device of the room, at once
                if let Some(missing) = room.humans.iter().find(|h| !f.adds.contains(h)) {
                    return Err(format!("founding commit leaves out human device {}", &hex(missing)[..8]));
                }
                if !f.removes.is_empty() {
                    return Err("a founding commit removes nobody".into());
                }
                Ok(())
            } else {
                if f.adds.iter().chain(f.removes.iter()).any(human) {
                    return Err("only a human device adds or removes a human device".into());
                }
                Ok(())
            }
        }
        By::External(k) => {
            if !f.adds.is_empty() {
                return Err("an external commit may only bring its own leaf".into());
            }
            if f.removes.iter().any(|r| r != k) {
                return Err("an external commit may only remove its own old leaf".into());
            }
            if human(k) {
                return Ok(()); // a human device of the room joins a session by itself
            }
            let still_allowed = f.meta.parent.is_some() || room.agents.contains(k);
            if still_allowed && f.members.contains(k) && f.removes == vec![k.clone()] {
                return Ok(()); // an agent that lost its state comes back under the same key
            }
            Err("external commit into a session group by a device that is neither a human device nor a member".into())
        }
    }
}

/// The rules for a new group, read from its first GroupInfo (one member: the founder).
pub fn check_founding(
    meta: &GroupMeta,
    gid: &[u8],
    founder: &SigKey,
    room: Option<&RoomView>,
    parent_members: Option<&[SigKey]>,
    parent_is_session_of_room: bool,
) -> Result<(), String> {
    if meta.founder != hex(founder) {
        return Err("the group statement names another founder".into());
    }
    match meta.kind {
        Kind::Room => {
            if room.is_some() || meta.room != hex(gid) {
                return Err("there is one room group".into());
            }
            Ok(())
        }
        Kind::Session => {
            let room = room.ok_or("no room group yet")?;
            if meta.room != hex(&room.gid) {
                return Err("session group of another room".into());
            }
            if !meta.agents.is_empty() || meta.recovery_sign.is_some() {
                return Err("only the room statement has a roster and a recovery key".into());
            }
            if room.humans.contains(founder) {
                return Ok(());
            }
            // an agent founds: only a helper under a session it is a member of
            match (meta.parent.as_ref(), parent_members) {
                (Some(_), Some(pm)) if pm.contains(founder) && parent_is_session_of_room => Ok(()),
                (Some(_), _) => Err("helper founded by a device that is not a member of the parent session".into()),
                (None, _) => Err("an agent founds helper groups only".into()),
            }
        }
    }
}
