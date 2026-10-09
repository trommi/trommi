//! The stub hub: a delivery service and an observer. It stores key packages (handed
//! out once), orders commits per group (one commit per epoch wins), relays Welcomes,
//! keeps the current GroupInfo, the archive rows and the stored content. It follows
//! every group's PUBLIC state with OpenMLS's `PublicGroup` and holds no group secret:
//! this struct has no field that could contain one.

use std::collections::{BTreeMap, HashMap};

use openmls::group::{ProposalStore, PublicGroup};
use openmls::prelude::*;
use openmls_rust_crypto::{MemoryStorage, RustCrypto};

use crate::device::{facts, meta_of, parse_msg, Out};
use crate::rules::{self, GroupMeta, Kind, RoomView};
use crate::seal::{ArchiveRow, Envelope, EpochKeyRow};
use crate::{unhex, Gid, SigKey};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reject {
    /// the commit builds on an epoch that is not the current one: fetch and retry
    Stale { current: u64 },
    /// MLS itself refuses the message (signature, membership, structure)
    Mls(String),
    /// valid MLS, against Trommi's rules
    Rule(String),
}

#[derive(Default, Clone)]
pub struct Rows {
    pub archive: Option<ArchiveRow>,
    pub epoch_key: Option<EpochKeyRow>,
}

pub struct HubGroup {
    pub public: PublicGroup,
    /// commits[i] leads from epoch i to i+1
    pub commits: Vec<Vec<u8>>,
    pub group_info: Vec<u8>,
}

#[derive(Default)]
struct Pool {
    once: Vec<Vec<u8>>,
    last_resort: Option<Vec<u8>>,
}

pub struct Hub {
    crypto: RustCrypto,
    storage: MemoryStorage,
    pub room: Option<Gid>,
    pub groups: BTreeMap<Gid, HubGroup>,
    pools: HashMap<SigKey, Pool>,
    welcomes: HashMap<SigKey, Vec<Vec<u8>>>,
    /// every Welcome ever relayed, kept: needed by a member that joins months later
    pub welcome_log: Vec<(SigKey, Vec<u8>)>,
    pub archive: BTreeMap<u64, ArchiveRow>,
    pub epoch_keys: BTreeMap<(Gid, u64), EpochKeyRow>,
    pub items: Vec<Envelope>,
    /// refuse a room commit that comes without its archive row
    pub require_archive_rows: bool,
    /// false = a hub that does not enforce Trommi's rules (a careless or hostile one);
    /// it still cannot produce valid MLS for a group it is not in
    pub enforce_rules: bool,
    /// how often the last-resort key package of a device was handed out
    pub last_resort_handed_out: usize,
}

impl Default for Hub {
    fn default() -> Self {
        Self::new()
    }
}

impl Hub {
    pub fn new() -> Self {
        Hub {
            crypto: RustCrypto::default(),
            storage: MemoryStorage::default(),
            room: None,
            groups: BTreeMap::new(),
            pools: HashMap::new(),
            welcomes: HashMap::new(),
            welcome_log: vec![],
            archive: BTreeMap::new(),
            epoch_keys: BTreeMap::new(),
            items: vec![],
            require_archive_rows: true,
            enforce_rules: true,
            last_resort_handed_out: 0,
        }
    }

    // ---- key packages ----

    pub fn publish_key_package(&mut self, owner: &SigKey, kp: Vec<u8>, last_resort: bool) {
        let p = self.pools.entry(owner.clone()).or_default();
        if last_resort {
            p.last_resort = Some(kp);
        } else {
            p.once.push(kp);
        }
    }

    /// One key package of a device: an unused one (then deleted), else its last-resort one.
    pub fn take_key_package(&mut self, owner: &SigKey) -> Option<Vec<u8>> {
        let p = self.pools.get_mut(owner)?;
        if let Some(kp) = p.once.pop() {
            return Some(kp);
        }
        if p.last_resort.is_some() {
            self.last_resort_handed_out += 1;
        }
        p.last_resort.clone()
    }

    pub fn unused_key_packages(&self, owner: &SigKey) -> usize {
        self.pools.get(owner).map_or(0, |p| p.once.len())
    }

    // ---- the public state, read without any key ----

    pub fn epoch(&self, gid: &[u8]) -> u64 {
        self.groups[gid].public.group_context().epoch().as_u64()
    }

    pub fn meta(&self, gid: &[u8]) -> GroupMeta {
        meta_of(self.groups[gid].public.group_context()).unwrap()
    }

    /// (credential text, signature key) of every member.
    pub fn members(&self, gid: &[u8]) -> Vec<(String, SigKey)> {
        self.groups[gid]
            .public
            .members()
            .map(|m| (String::from_utf8_lossy(m.credential.serialized_content()).to_string(), m.signature_key))
            .collect()
    }

    pub fn member_keys(&self, gid: &[u8]) -> Vec<SigKey> {
        self.groups[gid].public.members().map(|m| m.signature_key).collect()
    }

    pub fn room_view(&self) -> Option<RoomView> {
        let gid = self.room.clone()?;
        let meta = self.meta(&gid);
        Some(RoomView {
            epoch: self.epoch(&gid),
            humans: self.member_keys(&gid).into_iter().collect(),
            agents: meta.agents.iter().map(|a| unhex(a)).collect(),
            recovery_sign: meta.recovery_sign.as_ref().map(|h| unhex(h)),
            gid,
        })
    }

    /// The role of a signature key, from the room group's public state alone.
    pub fn role(&self, key: &SigKey) -> &'static str {
        match self.room_view() {
            Some(v) if v.humans.contains(key) => "human",
            Some(v) if v.agents.contains(key) => "agent",
            _ => "unknown",
        }
    }

    // ---- groups ----

    /// A new group, from its founder's first GroupInfo (with the tree).
    pub fn found_group(&mut self, group_info: &[u8]) -> Result<Gid, Reject> {
        let public = observe(&self.crypto, &self.storage, group_info)?;
        let gid = public.group_id().as_slice().to_vec();
        if self.groups.contains_key(&gid) {
            return Err(Reject::Rule("group id taken".into()));
        }
        let members: Vec<SigKey> = public.members().map(|m| m.signature_key).collect();
        if members.len() != 1 || public.group_context().epoch().as_u64() != 0 {
            return Err(Reject::Rule("a group is founded with one member at epoch 0".into()));
        }
        let meta = meta_of(public.group_context()).map_err(Reject::Rule)?;
        let parent_members = meta
            .parent
            .as_ref()
            .and_then(|p| self.groups.get(&unhex(p)))
            .map(|g| g.public.members().map(|m| m.signature_key).collect::<Vec<_>>());
        let parent_ok = meta.parent.as_ref().and_then(|p| self.groups.get(&unhex(p))).is_some_and(|g| {
            meta_of(g.public.group_context()).is_ok_and(|pm| pm.kind == Kind::Session && pm.room == meta.room)
        });
        if self.enforce_rules {
            rules::check_founding(&meta, &gid, &members[0], self.room_view().as_ref(), parent_members.as_deref(), parent_ok)
                .map_err(Reject::Rule)?;
        }
        if meta.kind == Kind::Room {
            self.room = Some(gid.clone());
        }
        self.groups.insert(gid.clone(), HubGroup { public, commits: vec![], group_info: group_info.to_vec() });
        Ok(gid)
    }

    /// A commit for a group. Accepted only if it builds on the current epoch, is valid
    /// MLS on the public state, and keeps Trommi's rules. Returns the new epoch.
    pub fn submit(&mut self, out: &Out, rows: Rows) -> Result<u64, Reject> {
        let room = self.room_view();
        let is_room = self.room.as_deref() == Some(&out.gid[..]);
        let parent_members = self
            .groups
            .get(&out.gid)
            .and_then(|g| meta_of(g.public.group_context()).ok())
            .and_then(|m| m.parent)
            .and_then(|p| self.groups.get(&unhex(&p)))
            .map(|g| g.public.members().map(|m| m.signature_key).collect::<Vec<_>>());
        let g = self.groups.get_mut(&out.gid).ok_or(Reject::Rule("no such group".into()))?;
        let current = g.public.group_context().epoch().as_u64();
        let pm = parse_msg(&out.commit)
            .map_err(Reject::Mls)?
            .try_into_protocol_message()
            .map_err(|e| Reject::Mls(format!("{e:?}")))?;
        if pm.epoch().as_u64() != current {
            return Err(Reject::Stale { current });
        }
        let meta = meta_of(g.public.group_context()).map_err(Reject::Rule)?;
        let members: Vec<Member> = g.public.members().collect();
        let processed = g
            .public
            .process_message(&self.crypto, pm)
            .map_err(|e| Reject::Mls(format!("{e:?}")))?;
        let mut f = facts(&out.gid, &meta, current, &members, &processed).map_err(Reject::Rule)?;
        f.parent_members = parent_members;
        let room = room.ok_or(Reject::Rule("no room".into()))?;
        if self.enforce_rules {
            rules::check(&f, &room, &self.crypto).map_err(Reject::Rule)?;
        }
        if is_room && self.require_archive_rows && self.enforce_rules {
            match &rows.archive {
                Some(r) if r.epoch == current + 1 => {}
                _ => return Err(Reject::Rule("room commit without its archive row".into())),
            }
        }
        if let Some(r) = &rows.epoch_key {
            // a session key sealed under an archive key of an OLDER room epoch would be
            // readable by a device removed from the room since: the committer must
            // have caught up with the room first
            if self.enforce_rules && (r.group != out.gid || r.epoch != current + 1 || r.room_epoch != room.epoch) {
                return Err(Reject::Rule("session key row for the wrong epoch or sealed under a stale room epoch".into()));
            }
        }
        let ProcessedMessageContent::StagedCommitMessage(staged) = processed.into_content() else {
            return Err(Reject::Mls("not a commit".into()));
        };
        g.public
            .merge_commit(&self.storage, *staged)
            .map_err(|e| Reject::Mls(format!("{e:?}")))?;
        g.commits.push(out.commit.clone());
        g.group_info = out.group_info.clone();
        if let Some(w) = &out.welcome {
            for k in &f.adds {
                self.welcomes.entry(k.clone()).or_default().push(w.clone());
                self.welcome_log.push((k.clone(), w.clone()));
            }
        }
        if let Some(r) = rows.archive {
            self.archive.insert(r.epoch, r);
        }
        if let Some(r) = rows.epoch_key {
            self.epoch_keys.insert((r.group.clone(), r.epoch), r);
        }
        Ok(current + 1)
    }

    pub fn commits_since(&self, gid: &[u8], epoch: u64) -> Vec<Vec<u8>> {
        self.groups[gid].commits[epoch as usize..].to_vec()
    }

    pub fn group_info(&self, gid: &[u8]) -> Vec<u8> {
        self.groups[gid].group_info.clone()
    }

    pub fn welcomes_for(&mut self, device: &SigKey) -> Vec<Vec<u8>> {
        self.welcomes.remove(device).unwrap_or_default()
    }

    pub fn put_epoch_key(&mut self, row: EpochKeyRow) {
        self.epoch_keys.insert((row.group.clone(), row.epoch), row);
    }

    pub fn post(&mut self, env: Envelope) {
        self.items.push(env);
    }

    pub fn items_of(&self, gid: &[u8]) -> Vec<Envelope> {
        self.items.iter().filter(|e| e.group == gid).cloned().collect()
    }

    /// Bytes of all archive rows and all epoch-key rows.
    pub fn archive_bytes(&self) -> (usize, usize) {
        (
            self.archive.values().map(|r| r.bytes()).sum(),
            self.epoch_keys.values().map(|r| r.group.len() + 16 + r.sealed.len()).sum(),
        )
    }
}

/// Starts following a group's public state from a GroupInfo that carries the tree.
/// OpenMLS checks the GroupInfo's signature against the tree. Anyone can do this: the
/// hub, and an agent that follows the room group without being in it.
pub fn observe(crypto: &RustCrypto, storage: &MemoryStorage, group_info: &[u8]) -> Result<PublicGroup, Reject> {
    let MlsMessageBodyIn::GroupInfo(vgi) = parse_msg(group_info).map_err(Reject::Mls)?.extract() else {
        return Err(Reject::Mls("not a GroupInfo".into()));
    };
    let tree = vgi
        .extensions()
        .ratchet_tree()
        .ok_or(Reject::Mls("GroupInfo without the tree".into()))?
        .ratchet_tree()
        .clone();
    PublicGroup::from_external(crypto, storage, tree.into(), vgi, ProposalStore::new())
        .map(|(public, _)| public)
        .map_err(|e| Reject::Mls(format!("{e:?}")))
}
