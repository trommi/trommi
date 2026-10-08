//! What the hub does for one room (a port of shared/crypto/hub.mjs createHub): the verified member list, sign-in,
//! sealed keys, session grants, invites, envelopes with the write rules (R1, R3, R6), leases. Every call runs under
//! the room's lock, which is what hub.mjs's serial queue gives: one change at a time.

use crate::error::{Fail, HResult};
use crate::store::{Invite, JoinRequest, Lease, ObjectInfo, Store};
use crate::util::{now, random_bytes};
use indexmap::IndexMap;
use rusqlite::Connection;
use std::collections::HashMap;
use zcrypto::bytes::{arr32, bytes_equal, is_zero, unhex};
use zcrypto::envelope::{self as env, ChainLookup, Header};
use zcrypto::grants::{apply_grant, grant_is_stale, grant_manifest_hash, SessionState};
use zcrypto::invite as inv;
use zcrypto::log::{apply_entry, verify_log, LogState, ENTRY_ADD, ENTRY_GENESIS, ENTRY_RECOVER, ENTRY_REMOVE};
use zcrypto::{b64u, fail as zfail, hex, obj, ZError, EPOCH_GRACE_MS, ROLE_AGENT, ROLE_HUMAN};

pub const CHALLENGE_TTL_MS: i64 = 2 * 60 * 1000;
pub const SESSION_TTL_MS: i64 = 10 * 60 * 1000;
pub const MAX_OPEN_INVITES: usize = 16;
pub const MAX_REQUESTS_PER_INVITE: usize = 4;
pub const INVITE_AFTER_USE_MS: i64 = 15 * 60 * 1000;
pub const LEASE_MS: i64 = 60 * 1000;
pub const MAX_AGENT_SESSIONS: i64 = 32;
const WRAP_AGENT: usize = 2 + 32 + 33 + 16;
const WRAP_HUMAN: usize = 2 + 32 + 65 + 16;
const BACK_LINK: usize = 2 + 4 + 64 + 16;
const SESSION_BACK_LINK: usize = 2 + 16 + 4 + 64 + 16;
pub const VOIDABLE: [&str; 4] = ["forbidden", "wrong-epoch", "too-large", "bad-format"];

type ZR<T> = Result<T, Fail>;
fn zf<T>(code: &str, msg: &str) -> ZR<T> { Err(zfail(code, msg).into()) }
fn db(e: rusqlite::Error) -> Fail { Fail::internal(format!("sqlite: {e}")) }

#[derive(Clone, Debug)]
pub struct Token {
    pub id: String,
    pub id_bytes: [u8; 32],
    pub recovery: bool,
    pub role: Option<u8>,
    pub expires_at: i64,
}
#[derive(Clone, Debug)]
pub struct Auth {
    pub id: String,
    pub recovery: bool,
    pub role: Option<&'static str>,
}

struct Chain {
    seq: u64,
    hash: [u8; 32],
    recent: IndexMap<u64, [u8; 32]>,
}
struct SessionCache {
    state: Option<SessionState>,
    since: HashMap<u32, i64>,
}

pub struct RoomCore {
    pub id: String,
    pub hub_url: String,
    pub state: LogState,
    chains: HashMap<[u8; 32], Chain>,
    challenges: IndexMap<String, i64>,
    sessions: HashMap<String, Token>,
    leases: HashMap<String, Lease>,
    epoch_since: HashMap<u32, i64>,
    session_cache: HashMap<String, SessionCache>,
}

pub struct EntryOut {
    pub seq: u32,
    pub hash: String,
    pub epoch: u32,
    pub ty: u8,
    pub removed: Vec<String>,
}
pub struct GrantOut {
    pub session_id: String,
    pub grant_number: u32,
    pub grant_hash: String,
    pub session_key_epoch: u32,
}
pub struct EnvelopeOut {
    pub n: i64,
    pub push: bool,
    pub urgency: Option<u8>,
}
pub struct GrantIn {
    pub session_id: String,
    pub grant: Vec<u8>,
    pub wraps: Vec<([u8; 32], Vec<u8>)>,
    pub back_link: Option<Vec<u8>>,
}
pub struct SessionBundle {
    pub session_id: String,
    pub grants: Vec<Vec<u8>>,
    pub wraps: Vec<(i64, Vec<u8>)>,
    pub links: Option<Vec<(i64, Vec<u8>)>>,
}
pub enum JoinStatus {
    Waiting,
    Revealed(Vec<u8>),
    Joined { reveal: Option<Vec<u8>>, entries: Vec<Vec<u8>>, wrap: Option<Vec<u8>> },
    Taken,
}

fn is_sealed(b: &[u8], lens: &[usize]) -> bool { lens.contains(&b.len()) && b[0] == 1 && b[1] == obj::SEALED }
fn role_name(r: u8) -> &'static str { if r == ROLE_HUMAN { "human" } else { "agent" } }

/// Chain lookups for verify_envelope: the newest head in memory, older hashes from the store when asked.
struct Lookup<'a> {
    chains: &'a HashMap<[u8; 32], Chain>,
    store: &'a Store<'a>,
}
impl ChainLookup for Lookup<'_> {
    fn head(&self, s: &[u8; 32]) -> Option<(u64, [u8; 32])> { self.chains.get(s).map(|c| (c.seq, c.hash)) }
    fn hash_at(&self, s: &[u8; 32], seq: u64) -> Option<[u8; 32]> {
        let c = self.chains.get(s)?;
        if let Some(h) = c.recent.get(&seq) {
            return Some(*h);
        }
        self.store.envelope_hash(s, seq as i64).ok().flatten()
    }
}

impl RoomCore {
    /// Come back up from what is stored: the member list is verified again; each sender's chain head from the columns.
    pub fn load(c: &Connection, id: &str, hub_url: &str) -> HResult<RoomCore> {
        let st = Store::new(c, id);
        let entries = st.entries().map_err(db)?;
        let state = verify_log(&entries, None)?;
        let times = st.entry_times().map_err(db)?;
        let mut epoch_since = HashMap::new();
        for (&epoch, info) in &state.epochs {
            epoch_since.insert(epoch, times.get(info.seq as usize).copied().unwrap_or(0));
        }
        let mut chains = HashMap::new();
        for (sender, seq, hash) in st.chain_heads().map_err(db)? {
            chains.insert(sender, Chain { seq: seq as u64, hash, recent: IndexMap::new() });
        }
        Ok(RoomCore { id: id.into(), hub_url: hub_url.into(), state, chains, challenges: IndexMap::new(), sessions: HashMap::new(), leases: HashMap::new(), epoch_since, session_cache: HashMap::new() })
    }

    // ---- tokens -------------------------------------------------------------------------

    pub fn session(&mut self, token: &str, human: bool, member: bool) -> ZR<Token> {
        let s = match self.sessions.get(token) {
            Some(s) if now() <= s.expires_at => s.clone(),
            _ => {
                self.sessions.remove(token);
                return zf("unauthorised", "sign in first");
            }
        };
        if !s.recovery && self.state.member_at(&s.id_bytes, None).is_none() {
            self.sessions.remove(token);
            return zf("not-member", "this device was removed");
        }
        if s.recovery && !bytes_equal(&s.id_bytes, &self.state.recovery.id) {
            self.sessions.remove(token);
            return zf("unauthorised", "this recovery code was replaced");
        }
        if (member || human) && s.recovery {
            return zf("forbidden", "the recovery key only reads the member list and its own sealed keys");
        }
        if human && s.role != Some(ROLE_HUMAN) {
            return zf("forbidden", "agents cannot do this");
        }
        Ok(s)
    }
    pub fn authorise(&mut self, token: &str, human: bool, member: bool) -> ZR<Auth> {
        let s = self.session(token, human, member)?;
        Ok(Auth { id: s.id, recovery: s.recovery, role: s.role.map(role_name) })
    }
    fn sweep_tokens(&mut self) {
        let t = now();
        self.sessions.retain(|_, s| t <= s.expires_at);
    }

    fn active_role(&self, dev: &str) -> Option<u8> {
        let b = unhex(dev).ok()?;
        self.state.member_at(&b, None).map(|m| m.role)
    }

    fn check_wraps(&self, wraps: &[([u8; 32], Vec<u8>)], wanted: &[([u8; 32], Vec<usize>)]) -> ZR<Vec<([u8; 32], Vec<u8>)>> {
        let mut given: IndexMap<[u8; 32], Vec<u8>> = IndexMap::new();
        for (id, sealed) in wraps {
            if given.contains_key(id) {
                return zf("bad-format", "two wraps for one recipient");
            }
            given.insert(*id, sealed.clone());
        }
        if given.len() != wanted.len() {
            return zf("incomplete", &format!("this needs {} sealed keys, got {}", wanted.len(), given.len()));
        }
        for (id, sizes) in wanted {
            let Some(sealed) = given.get(id) else { return zf("incomplete", &format!("no sealed key for {}", &hex(id)[..8])) };
            if !is_sealed(sealed, sizes) {
                return zf("bad-format", "not a sealed key of the right kind for this recipient");
            }
        }
        Ok(given.into_iter().collect())
    }

    // ---- the member list --------------------------------------------------------------------

    /// Found (state empty), add, remove or recover. The entry authenticates itself.
    pub fn accept_entry(c: &Connection, core: Option<&mut RoomCore>, room_id_for_found: &str, entry: &[u8], wraps: &[([u8; 32], Vec<u8>)], back_link: Option<&[u8]>, founding: bool) -> ZR<(EntryOut, Option<LogState>)> {
        let body = &entry[..entry.len().saturating_sub(64)];
        let h = zcrypto::prim::hash(zcrypto::label::LOG_ENTRY, &[body]);
        let state = core.as_ref().map(|c| &c.state);
        if let Some(s) = state {
            if s.hashes.iter().any(|x| bytes_equal(x, &h)) {
                return zf("replay", "this entry is already in the member list");
            }
        }
        if founding && state.is_some() {
            return zf("room-exists", "this hub already has a room");
        }
        if !founding && state.is_none() {
            return zf("no-room", "no room has been founded on this hub");
        }
        let next = apply_entry(state, entry)?;
        let e = next.entries.last().unwrap().clone();
        if founding != (e.ty == ENTRY_GENESIS) {
            return zf("bad-entry", "a room is founded through found(), and only once");
        }
        let room_id = if founding { room_id_for_found.to_string() } else { core.as_ref().unwrap().id.clone() };
        let st = Store::new(c, &room_id);
        let wanted: Vec<([u8; 32], Vec<usize>)> = if e.ty == ENTRY_ADD {
            let mk = e.member.as_ref().unwrap();
            let id = zcrypto::prim::device_id(&mk.sign_pub, &mk.kex_pub);
            let m = next.member_at(&id, None).unwrap();
            if m.role == ROLE_HUMAN { vec![(m.id, vec![WRAP_HUMAN])] } else { vec![] }
        } else {
            let mut w: Vec<([u8; 32], Vec<usize>)> = next.active_members().filter(|m| m.role == ROLE_HUMAN).map(|m| (m.id, vec![WRAP_HUMAN])).collect();
            w.push((next.recovery.id, vec![WRAP_HUMAN]));
            w
        };
        let tmp = RoomCore::empty_for_checks();
        let sealed = tmp.check_wraps(wraps, &wanted)?;
        let rotated = e.ty == ENTRY_REMOVE || e.ty == ENTRY_RECOVER || e.ty == ENTRY_GENESIS;
        if rotated && e.ty != ENTRY_GENESIS {
            let ok = back_link.is_some_and(|b| b.len() == BACK_LINK && b[0] == 1 && b[1] == obj::BACK_LINK && u32::from_be_bytes(b[2..6].try_into().unwrap()) == next.epoch);
            if !ok {
                return zf("incomplete", "a new room key comes with the link back to the old one");
            }
        } else if back_link.is_some() {
            return zf("bad-format", "only an epoch change carries a back link");
        }
        let mut invite: Option<Invite> = None;
        if e.ty == ENTRY_ADD && !is_zero(&e.invite_id.unwrap()) {
            let i = st.invite(&hex(&e.invite_id.unwrap())).map_err(db)?;
            let Some(i) = i else { return zf("bad-invite", "the entry names an invite this hub never saw") };
            let mk = e.member.as_ref().unwrap();
            let dev = hex(&zcrypto::prim::device_id(&mk.sign_pub, &mk.kex_pub));
            let answered = i.reveal.as_ref().and_then(|(_, rh)| i.requests.iter().find(|r| &r.hash == rh));
            if answered.map(|a| a.device != dev).unwrap_or(true) || i.role != role_name(mk.role) || i.inviter != hex(&e.signer) {
                return zf("bad-invite", "the entry is not the outcome of this invite");
            }
            invite = Some(i);
        }
        let at = now();
        let removed: Vec<String> = next.members.values().filter(|m| m.removed_seq == Some(e.seq)).map(|m| hex(&m.id)).collect();
        let added = if e.ty == ENTRY_ADD { next.members.values().find(|m| m.added_seq == e.seq).map(|m| hex(&m.id)) } else { None };
        crate::db::tx(c, |c| {
            let st = Store::new(c, &room_id);
            st.append_entry(entry, e.seq, &hex(&next.head_hash), &hex(&e.prev), e.ty, &hex(&e.signer), at, &next, &removed)?;
            for (id, s) in &sealed {
                st.put_wrap(next.epoch, &hex(id), s)?;
            }
            if let Some(b) = back_link {
                st.put_back_link(next.epoch, b)?;
            }
            if let Some(i) = &invite {
                let mut i = i.clone();
                i.used_at = Some(at);
                i.entry_seq = Some(e.seq as i64);
                if added.is_some() {
                    i.member = added.clone();
                }
                st.put_invite(&i)?;
            }
            Ok::<_, rusqlite::Error>(())
        })
        .map_err(db)?;
        let out = EntryOut { seq: e.seq, hash: hex(&next.head_hash), epoch: next.epoch, ty: e.ty, removed: removed.clone() };
        match core {
            None => Ok((out, Some(next))),
            Some(core) => {
                core.state = next;
                if rotated {
                    core.epoch_since.insert(core.state.epoch, at);
                }
                let state = &core.state;
                core.sessions.retain(|_, s| if s.recovery { bytes_equal(&s.id_bytes, &state.recovery.id) } else { state.member_at(&s.id_bytes, None).is_some() });
                for d in &removed {
                    core.leases.remove(d);
                    let _ = Store::new(c, &core.id).delete_lease(d);
                }
                let st = &core.state;
                for cache in core.session_cache.values_mut() {
                    if let Some(s) = cache.state.as_mut() {
                        s.stale = grant_is_stale(Some(s), st);
                    }
                }
                Ok((out, None))
            }
        }
    }
    fn empty_for_checks() -> RoomCore {
        // check_wraps reads nothing of the room; a hollow core keeps it a method.
        RoomCore {
            id: String::new(),
            hub_url: String::new(),
            state: LogState {
                room_id: [0; 32],
                head_seq: 0,
                head_hash: [0; 32],
                hashes: vec![],
                entries: vec![],
                members: IndexMap::new(),
                epoch: 0,
                epochs: Default::default(),
                recovery: zcrypto::log::RecoveryKey { sign_pub: [0; 32], kex_pub: [0; 32], id: [0; 32] },
                invite_ids: Default::default(),
                last_recover_seq: -1,
            },
            chains: HashMap::new(),
            challenges: IndexMap::new(),
            sessions: HashMap::new(),
            leases: HashMap::new(),
            epoch_since: HashMap::new(),
            session_cache: HashMap::new(),
        }
    }
    /// A freshly founded room's core.
    pub fn founded(id: &str, hub_url: &str, state: LogState, at: i64) -> RoomCore {
        let mut r = RoomCore::empty_for_checks();
        r.id = id.into();
        r.hub_url = hub_url.into();
        r.epoch_since.insert(state.epoch, at);
        r.state = state;
        r
    }

    pub fn log(&mut self, c: &Connection, token: Option<&str>, invite_id: Option<&str>, after: i64) -> ZR<(String, u32, Vec<Vec<u8>>)> {
        match invite_id {
            Some(i) => {
                self.open_invite(c, i, true)?;
            }
            None => {
                self.session(token.unwrap_or(""), false, false)?;
            }
        }
        let entries = Store::new(c, &self.id).entries().map_err(db)?;
        let skip = (after + 1).max(0) as usize;
        Ok((hex(&self.state.room_id), self.state.head_seq, entries.into_iter().skip(skip).collect()))
    }

    // ---- sign-in ----------------------------------------------------------------------------

    pub fn challenge(&mut self) -> Vec<u8> {
        let t = now();
        self.challenges.retain(|_, exp| t <= *exp);
        while self.challenges.len() >= 10000 {
            self.challenges.shift_remove_index(0);
        }
        let c = random_bytes(32);
        self.challenges.insert(b64u(&c), t + CHALLENGE_TTL_MS);
        c
    }
    pub fn sign_in(&mut self, c: &Connection, signed: &[u8]) -> ZR<(String, String, bool, Option<&'static str>, i64)> {
        let a = match inv::verify_hub_auth(signed, &self.state, &self.hub_url) {
            Ok(a) => a,
            Err(e) => {
                let mut f: Fail = e.clone().into();
                if e.code == "not-member" {
                    if let Some(rs) = e.removed_seq {
                        let entries = Store::new(c, &self.id).entries().map_err(db)?;
                        f.signed_entries = Some(entries.into_iter().take(rs as usize + 1).collect());
                    }
                }
                return Err(f);
            }
        };
        let k = b64u(&a.challenge);
        let exp = self.challenges.shift_remove(&k);
        if exp.is_none_or(|e| now() > e) {
            return zf("bad-challenge", "this challenge is not ours, was used, or ran out");
        }
        self.sweep_tokens();
        let token = b64u(&random_bytes(32));
        let s = Token { id: hex(&a.id), id_bytes: a.id, recovery: a.recovery, role: a.member_role, expires_at: now() + SESSION_TTL_MS };
        let role = if a.recovery { None } else { a.member_role.map(role_name) };
        let out = (token.clone(), s.id.clone(), s.recovery, role, s.expires_at);
        self.sessions.insert(token, s);
        Ok(out)
    }

    // ---- sealed room keys ---------------------------------------------------------------------

    pub fn wraps(&mut self, c: &Connection, token: &str, after: i64) -> ZR<Vec<(i64, Vec<u8>)>> {
        let s = self.session(token, false, false)?;
        Store::new(c, &self.id).wraps(&s.id, after).map_err(db)
    }
    pub fn back_links(&mut self, c: &Connection, token: &str) -> ZR<Vec<(i64, Vec<u8>)>> {
        let s = self.session(token, false, false)?;
        if !s.recovery && s.role != Some(ROLE_HUMAN) {
            return zf("forbidden", "agents hold no room key");
        }
        Store::new(c, &self.id).back_links().map_err(db)
    }

    // ---- session grants -----------------------------------------------------------------------

    fn session_of(&mut self, c: &Connection, sid: &str) -> ZR<&mut SessionCache> {
        if !self.session_cache.contains_key(sid) {
            let mut st: Option<SessionState> = None;
            let mut since = HashMap::new();
            for (bytes, at) in Store::new(c, &self.id).grants(sid).map_err(db)? {
                let prev_epoch = st.as_ref().map(|s| s.epoch);
                let next = apply_grant(st.as_ref(), &bytes, &self.state)?;
                if prev_epoch != Some(next.epoch) {
                    since.insert(next.epoch, at);
                }
                st = Some(next);
            }
            self.session_cache.insert(sid.to_string(), SessionCache { state: st, since });
        }
        Ok(self.session_cache.get_mut(sid).unwrap())
    }
    fn assigned_agents(&self, st: Option<&SessionState>) -> Vec<String> {
        st.map(|s| s.agent_ids.iter().filter(|a| self.active_role(a) == Some(ROLE_AGENT)).cloned().collect()).unwrap_or_default()
    }

    /// Check one grant (prepareGrant): returns what to write.
    fn prepare_grant(&mut self, c: &Connection, g: &GrantIn) -> ZR<(SessionState, bool, Vec<([u8; 32], Vec<u8>)>, i64, Option<SessionState>)> {
        if !zcrypto::bytes::is_hex(&g.session_id, 32) {
            return zf("bad-argument", "a session id is 32 hex characters");
        }
        let prev = self.session_of(c, &g.session_id)?.state.clone();
        let next = apply_grant(prev.as_ref(), &g.grant, &self.state)?;
        if next.session_id != g.session_id {
            return zf("bad-argument", "the grant names another session");
        }
        let agent_own = prev.is_none() && next.created_by_agent;
        if agent_own {
            if self.active_role(&next.signer_id) != Some(ROLE_AGENT) {
                return zf("stale-grant", "the signer is no longer an active agent");
            }
            let n = Store::new(c, &self.id).sessions_created_by(&next.signer_id).map_err(db)?;
            if n >= MAX_AGENT_SESSIONS {
                return zf("rate-limited", &format!("an agent opens at most {MAX_AGENT_SESSIONS} sessions of its own"));
            }
        } else if !(next.signer_id == hex(&self.state.recovery.id)) && self.active_role(&next.signer_id) != Some(ROLE_HUMAN) {
            return zf("stale-grant", "the signer is no longer an active human device");
        }
        if next.stale {
            return zf("stale-grant", "the grant names a member list from before a removal or recovery: build it on the current list");
        }
        for a in &next.agent_ids {
            if self.active_role(a) != Some(ROLE_AGENT) {
                return zf("bad-grant", "an assigned agent is no longer a member");
            }
        }
        let mut wanted: Vec<([u8; 32], Vec<usize>)> = self.state.active_members().filter(|m| m.role == ROLE_HUMAN).map(|m| (m.id, vec![WRAP_HUMAN])).collect();
        wanted.push((self.state.recovery.id, vec![WRAP_HUMAN]));
        for a in &next.agent_ids {
            let id = arr32(&unhex(a).unwrap());
            wanted.push((id, if next.with_history { vec![WRAP_HUMAN, WRAP_AGENT] } else { vec![WRAP_AGENT] }));
        }
        let given = self.check_wraps(&g.wraps, &wanted)?;
        if !bytes_equal(&grant_manifest_hash(&g.wraps), &next.manifest_hash) {
            return zf("bad-grant", "the sealed keys are not the ones the grant lists");
        }
        let rose = prev.as_ref().is_some_and(|p| next.epoch > p.epoch);
        if rose {
            let ok = g.back_link.as_ref().is_some_and(|b| {
                b.len() == SESSION_BACK_LINK && b[0] == 1 && b[1] == 0x0f && hex(&b[2..18]) == g.session_id && u32::from_be_bytes(b[18..22].try_into().unwrap()) == next.epoch
            });
            if !ok {
                return zf("incomplete", "a new session key comes with the link back to the old one");
            }
        } else if g.back_link.is_some() {
            return zf("bad-format", "only a new session key epoch carries a back link");
        }
        Ok((next, rose, given, now(), prev))
    }
    fn write_grant(st: &Store, g: &GrantIn, next: &SessionState, rose: bool, given: &[([u8; 32], Vec<u8>)], at: i64, prev: Option<&SessionState>) -> rusqlite::Result<()> {
        let prev_hash = prev.map(|p| hex(&p.grant_hash)).unwrap_or_else(|| "0".repeat(64));
        st.put_grant(&g.session_id, &g.grant, next.grant_number, &hex(&next.grant_hash), &prev_hash, next.epoch, &next.signer_id, at)?;
        for (id, s) in given {
            st.put_session_wrap(&g.session_id, next.epoch, &hex(id), s)?;
        }
        if rose {
            st.put_session_back_link(&g.session_id, next.epoch, g.back_link.as_ref().unwrap())?;
        }
        Ok(())
    }
    fn finish_grant(&mut self, sid: &str, next: SessionState, rose: bool, at: i64, first: bool) -> GrantOut {
        let cache = self.session_cache.get_mut(sid).unwrap();
        if first || rose {
            cache.since.insert(next.epoch, at);
        }
        let out = GrantOut { session_id: sid.into(), grant_number: next.grant_number, grant_hash: hex(&next.grant_hash), session_key_epoch: next.epoch };
        cache.state = Some(next);
        out
    }
    pub fn post_grant(&mut self, c: &Connection, g: GrantIn) -> ZR<GrantOut> {
        let (next, rose, given, at, prev) = self.prepare_grant(c, &g)?;
        crate::db::tx(c, |c| Self::write_grant(&Store::new(c, &self.id), &g, &next, rose, &given, at, prev.as_ref())).map_err(db)?;
        Ok(self.finish_grant(&g.session_id, next, rose, at, prev.is_none()))
    }
    /// Several grants at once: all checked first, then written in one transaction, or none.
    pub fn post_grants(&mut self, c: &Connection, list: Vec<GrantIn>) -> ZR<Vec<GrantOut>> {
        if list.is_empty() || list.len() > 1024 {
            return zf("bad-argument", "grants: a list of 1 to 1024");
        }
        let distinct: std::collections::HashSet<&str> = list.iter().map(|g| g.session_id.as_str()).collect();
        if distinct.len() != list.len() {
            return zf("bad-argument", "one grant per session in a batch");
        }
        let mut prepared = vec![];
        for g in &list {
            prepared.push(self.prepare_grant(c, g)?);
        }
        crate::db::tx(c, |c| {
            let st = Store::new(c, &self.id);
            for (g, p) in list.iter().zip(&prepared) {
                Self::write_grant(&st, g, &p.0, p.1, &p.2, p.3, p.4.as_ref())?;
            }
            Ok::<_, rusqlite::Error>(())
        })
        .map_err(db)?;
        let mut out = vec![];
        for (g, p) in list.iter().zip(prepared) {
            out.push(self.finish_grant(&g.session_id, p.0, p.1, p.3, p.4.is_none()));
        }
        Ok(out)
    }
    pub fn grants(&mut self, c: &Connection, token: &str, sid: &str) -> ZR<Vec<Vec<u8>>> {
        self.session(token, false, false)?;
        Ok(Store::new(c, &self.id).grants(sid).map_err(db)?.into_iter().map(|g| g.0).collect())
    }
    pub fn session_wraps(&mut self, c: &Connection, token: &str, sid: &str, after: i64) -> ZR<Vec<(i64, Vec<u8>)>> {
        let s = self.session(token, false, false)?;
        Store::new(c, &self.id).session_wraps(sid, &s.id, after).map_err(db)
    }
    pub fn session_back_links(&mut self, c: &Connection, token: &str, sid: &str) -> ZR<Vec<(i64, Vec<u8>)>> {
        let s = self.session(token, false, false)?;
        let links = Store::new(c, &self.id).session_back_links(sid).map_err(db)?;
        if s.recovery || s.role == Some(ROLE_HUMAN) {
            return Ok(links);
        }
        let st = self.session_of(c, sid)?.state.clone();
        if !self.assigned_agents(st.as_ref()).contains(&s.id) {
            return zf("forbidden", "not assigned to this session");
        }
        let top = st.map(|s| s.epochs.iter().filter(|(_, i)| i.with_history).map(|(e, _)| *e as i64).max().unwrap_or(0).max(0)).unwrap_or(0);
        Ok(links.into_iter().filter(|l| l.0 <= top).collect())
    }
    pub fn session_bundle(&mut self, c: &Connection, token: &str, ids: Option<Vec<String>>) -> ZR<Vec<SessionBundle>> {
        let s = self.session(token, false, false)?;
        let st = Store::new(c, &self.id);
        let ids = match ids {
            Some(i) => i,
            None => st.sessions().map_err(db)?.into_iter().map(|x| x.0).collect(),
        };
        let links = s.recovery || s.role == Some(ROLE_HUMAN);
        let mut out = vec![];
        for sid in ids {
            let grants: Vec<Vec<u8>> = st.grants(&sid).map_err(db)?.into_iter().map(|g| g.0).collect();
            if grants.is_empty() {
                continue;
            }
            out.push(SessionBundle { wraps: st.session_wraps(&sid, &s.id, 0).map_err(db)?, links: if links { Some(st.session_back_links(&sid).map_err(db)?) } else { None }, grants, session_id: sid });
        }
        Ok(out)
    }
    pub fn sessions_list(&self, c: &Connection) -> ZR<Vec<(String, i64, i64)>> { Store::new(c, &self.id).sessions().map_err(db) }

    // ---- invites --------------------------------------------------------------------------------

    fn open_invite(&self, c: &Connection, id: &str, used: bool) -> ZR<Invite> {
        let i = Store::new(c, &self.id).invite(id).map_err(db)?;
        let Some(i) = i else { return zf("not-found", "no such invite") };
        if i.burned_at.is_some() {
            return zf("invite-burned", "the inviter called this invite off");
        }
        if !used && i.used_at.is_some() {
            return zf("invite-used", "this invite already produced a member");
        }
        if let Some(u) = i.used_at {
            if now() - u > INVITE_AFTER_USE_MS {
                return zf("invite-expired", "this invite was used and is closed now");
            }
        }
        if i.used_at.is_none() && now() > i.expires_at {
            return zf("invite-expired", "this invite has run out");
        }
        Ok(i)
    }
    pub fn post_invite(&mut self, c: &Connection, token: &str, offer: &[u8]) -> ZR<(String, &'static str, i64)> {
        let s = self.session(token, true, false)?;
        let o = inv::verify_invite_offer(&self.state, offer, now())?;
        if hex(&o.inviter_id) != s.id {
            return zf("forbidden", "an offer is posted by the device that signed it");
        }
        let key = hex(&o.invite_id);
        let st = Store::new(c, &self.id);
        if st.invite(&key).map_err(db)?.is_some() {
            return zf("replay", "this invite is already known");
        }
        let t = now();
        if st.open_invites().map_err(db)?.iter().filter(|i| i.used_at.is_none() && t <= i.expires_at).count() >= MAX_OPEN_INVITES {
            return zf("too-many", "too many open invites");
        }
        let i = Invite { id: key.clone(), role: role_name(o.role).into(), inviter: s.id.clone(), expires_at: o.expires_at as i64, used_at: None, burned_at: None, offer: offer.to_vec(), requests: vec![], reveal: None, member: None, entry_seq: None };
        crate::db::tx(c, |c| Store::new(c, &self.id).put_invite(&i)).map_err(db)?;
        Ok((key, role_name(o.role), o.expires_at as i64))
    }
    pub fn invite(&self, c: &Connection, id: &str) -> ZR<(Vec<u8>, String, i64, String, Vec<Vec<u8>>)> {
        let i = self.open_invite(c, id, false)?;
        let entries = Store::new(c, &self.id).entries().map_err(db)?;
        Ok((i.offer, i.role, i.expires_at, hex(&self.state.room_id), entries))
    }
    /// Returns (request hash, inviter, repeated).
    pub fn post_request(&mut self, c: &Connection, id: &str, request: &[u8]) -> ZR<(String, String, bool)> {
        let i = self.open_invite(c, id, false)?;
        let q = inv::verify_invite_request(request)?;
        if hex(&q.invite_id) != i.id || !bytes_equal(&q.room_id, &self.state.room_id) || role_name(q.role) != i.role {
            return zf("bad-invite", "the request does not belong to this invite");
        }
        if self.state.members.contains_key(&q.id) {
            return zf("bad-invite", "this device is or was a member");
        }
        let rh = hex(&inv::invite_request_hash(request));
        if i.requests.iter().any(|r| r.hash == rh) {
            return Ok((rh, i.inviter, true));
        }
        if i.reveal.is_some() {
            return zf("invite-used", "the inviter already answered another request");
        }
        if i.requests.len() >= MAX_REQUESTS_PER_INVITE {
            return zf("too-many", "too many requests for one invite");
        }
        let mut next = i.clone();
        next.requests.push(JoinRequest { hash: rh.clone(), bytes: request.to_vec(), device: hex(&q.id), at: now() });
        crate::db::tx(c, |c| Store::new(c, &self.id).put_invite(&next)).map_err(db)?;
        Ok((rh, i.inviter, false))
    }
    pub fn burn_invite(&mut self, c: &Connection, token: &str, id: &str) -> ZR<()> {
        let s = self.session(token, true, false)?;
        let i = Store::new(c, &self.id).invite(id).map_err(db)?;
        let Some(mut i) = i else { return zf("not-found", "no such invite") };
        if i.inviter != s.id {
            return zf("forbidden", "not your invite");
        }
        if i.used_at.is_some() {
            return zf("invite-used", "this invite already produced a member");
        }
        i.burned_at = Some(now());
        crate::db::tx(c, |c| Store::new(c, &self.id).put_invite(&i)).map_err(db)?;
        Ok(())
    }
    pub fn requests(&mut self, c: &Connection, token: &str, id: &str) -> ZR<Vec<Vec<u8>>> {
        let s = self.session(token, true, false)?;
        let i = self.open_invite(c, id, true)?;
        if i.inviter != s.id {
            return zf("forbidden", "not your invite");
        }
        Ok(i.requests.into_iter().map(|r| r.bytes).collect())
    }
    pub fn post_reveal(&mut self, c: &Connection, token: &str, id: &str, reveal: &[u8]) -> ZR<String> {
        let s = self.session(token, true, false)?;
        let i = self.open_invite(c, id, false)?;
        if i.inviter != s.id {
            return zf("forbidden", "not your invite");
        }
        let r = inv::verify_invite_reveal(&self.state, reveal, &s.id_bytes)?;
        if hex(&r.invite_id) != i.id {
            return zf("bad-invite", "reveal for another invite");
        }
        let rh = hex(&r.request_hash);
        if !i.requests.iter().any(|q| q.hash == rh) {
            return zf("bad-invite", "reveal for a request the hub never saw");
        }
        if i.reveal.is_some() {
            return zf("invite-used", "this invite was already answered");
        }
        let mut next = i;
        next.reveal = Some((reveal.to_vec(), rh.clone()));
        crate::db::tx(c, |c| Store::new(c, &self.id).put_invite(&next)).map_err(db)?;
        Ok(rh)
    }
    pub fn join_status(&self, c: &Connection, id: &str, request_hash: &str) -> ZR<JoinStatus> {
        let i = self.open_invite(c, id, true)?;
        let Some(mine) = i.requests.iter().find(|r| r.hash == request_hash) else { return zf("not-found", "no such request") };
        if let Some((_, rh)) = &i.reveal {
            if rh != request_hash {
                return Ok(JoinStatus::Taken);
            }
        }
        if i.used_at.is_some() {
            if i.member.as_deref() != Some(mine.device.as_str()) {
                return Ok(JoinStatus::Taken);
            }
            let st = Store::new(c, &self.id);
            let epoch = self.state.epoch_at(i.entry_seq.unwrap_or(0) as u32) as i64;
            let wrap = st.wraps(&mine.device, 0).map_err(db)?.into_iter().find(|w| w.0 == epoch).map(|w| w.1);
            return Ok(JoinStatus::Joined { reveal: i.reveal.map(|r| r.0), entries: st.entries().map_err(db)?, wrap });
        }
        Ok(match i.reveal {
            Some((b, _)) => JoinStatus::Revealed(b),
            None => JoinStatus::Waiting,
        })
    }

    // ---- envelopes ------------------------------------------------------------------------------

    fn scope_of(info: &ObjectInfo) -> String { format!("{}:{}", info.key_scope, info.session_id.clone().unwrap_or_default()) }

    /// Key scope and epoch (R3, R6): returns the session's assigned agents, if session scope.
    fn authorise_scope(&mut self, c: &Connection, h: &Header, human: bool) -> ZR<Option<Vec<String>>> {
        let sender = hex(&h.sender);
        if h.key_scope == env::KEY_SCOPE_SESSION {
            let sid = hex(&h.session_id.unwrap());
            let cache = self.session_of(c, &sid)?;
            let Some(state) = cache.state.clone() else { return zf("forbidden", "no such session") };
            let since = cache.since.clone();
            let agents = self.assigned_agents(Some(&state));
            if !human && !agents.contains(&sender) {
                return zf("forbidden", "this agent is not assigned to the session");
            }
            if grant_is_stale(Some(&state), &self.state) {
                return zf("stale-session-key", "this session has not been re-keyed since the last removal or recovery: retry after the new grant");
            }
            if h.epoch > state.epoch {
                return zf("wrong-epoch", "a session key epoch the hub does not know");
            }
            if h.epoch < state.epoch {
                let s = since.get(&(h.epoch + 1));
                if s.is_none_or(|s| now() - s > EPOCH_GRACE_MS) {
                    return zf("wrong-epoch", "sent in an old session key epoch: fetch the grants");
                }
            }
            Ok(Some(agents))
        } else {
            if !human {
                return zf("forbidden", "agents hold no room key");
            }
            if h.epoch < self.state.epoch {
                let s = self.epoch_since.get(&(h.epoch + 1));
                if s.is_none_or(|s| now() - s > EPOCH_GRACE_MS) {
                    return zf("wrong-epoch", "sent in an old key epoch: fetch the member list");
                }
            }
            Ok(None)
        }
    }

    fn authorise_envelope(&mut self, c: &Connection, h: &Header, sender_role: u8) -> ZR<bool> {
        let sender = hex(&h.sender);
        let human = sender_role == ROLE_HUMAN;
        let recipient = if is_zero(&h.recipient) { None } else { Some(hex(&h.recipient)) };
        let sess = self.authorise_scope(c, h, human)?;
        let my_scope = format!("{}:{}", h.key_scope, h.session_id.map(|s| hex(&s)).unwrap_or_default());
        let holds = |info: &ObjectInfo, device: Option<&str>| -> bool {
            let Some(d) = device else { return false };
            d == info.owner || sess.as_ref().is_some_and(|a| !a.contains(&info.owner) && a.iter().any(|x| x == d))
        };
        let st = Store::new(c, &self.id);
        let mut push = false;
        match h.kind {
            env::KIND_OBJECT_VERSION | env::KIND_PERMISSION_REQUEST => {
                let oid = hex(&h.card.as_ref().unwrap().id);
                match st.object_info(&oid).map_err(db)? {
                    None => {
                        if oid != hex(&env::object_id_of(&h.sender, h.seq)) {
                            return zf("forbidden", "a new object id is derived from its creator and sequence number");
                        }
                        if h.kind == env::KIND_PERMISSION_REQUEST && human {
                            return zf("forbidden", "permission requests come from agents");
                        }
                    }
                    Some(info) => {
                        if Self::scope_of(&info) != my_scope {
                            return zf("forbidden", "an object stays under the key it was created with");
                        }
                        if info.first_kind != h.kind {
                            return zf("forbidden", "an object keeps its kind");
                        }
                        let note = unhex(&info.owner).ok().and_then(|b| self.state.members.get(&arr32(&b)).map(|m| m.role)) == Some(ROLE_HUMAN);
                        if !holds(&info, Some(&sender)) && !(note && human) {
                            return zf("forbidden", "only its creator (or the agent its session was handed to) writes new versions of an object");
                        }
                    }
                }
                push = h.push;
            }
            env::KIND_ANSWER | env::KIND_DECIDE_AGAIN | env::KIND_VERDICT => {
                if !human {
                    return zf("forbidden", "answers and verdicts come from human devices");
                }
                let Some(info) = st.object_info(&hex(&h.card.as_ref().unwrap().id)).map_err(db)? else { return zf("forbidden", "no such object") };
                if Self::scope_of(&info) != my_scope {
                    return zf("forbidden", "answered under the key of the object");
                }
                if !holds(&info, recipient.as_deref()) {
                    return zf("forbidden", "addressed to the object's creator (or the agent its session was handed to)");
                }
                if h.kind == env::KIND_VERDICT && info.first_kind != env::KIND_PERMISSION_REQUEST {
                    return zf("forbidden", "a verdict answers a permission request");
                }
                if h.kind != env::KIND_VERDICT && info.first_kind != env::KIND_OBJECT_VERSION {
                    return zf("forbidden", "an answer answers an object");
                }
            }
            env::KIND_STATUS => {}
            env::KIND_TIMELINE_ITEM => {
                let (scope, r) = env::parse_timeline_id(h.timeline_id.as_deref().unwrap_or(""))?;
                if scope == env::SCOPE_SESSION {
                    if human && h.timeline_kind == Some(env::TIMELINE_CHAT) && recipient.as_ref().is_none_or(|r| !sess.as_ref().is_some_and(|a| a.contains(r))) {
                        return zf("forbidden", "a human's message in a session goes to its agent");
                    }
                } else if scope == env::SCOPE_CARD {
                    let Some(info) = st.object_info(&hex(&r)).map_err(db)? else { return zf("forbidden", "no such card") };
                    if Self::scope_of(&info) != my_scope {
                        return zf("forbidden", "a card's chat is under the card's key");
                    }
                    if !holds(&info, Some(&sender)) && !(human && holds(&info, recipient.as_deref())) {
                        return zf("forbidden", "a card's chat: its creator, or a human writing to the creator");
                    }
                } else if !human {
                    return zf("forbidden", "desks are for human devices");
                }
            }
            _ => return zf("bad-format", "unknown kind"),
        }
        Ok(push)
    }

    fn lease_get(&mut self, c: &Connection, id: &str) -> Option<Lease> {
        if let Some(l) = self.leases.get(id) {
            return Some(l.clone());
        }
        let l = Store::new(c, &self.id).get_lease(id).ok().flatten()?;
        self.leases.insert(id.into(), l.clone());
        Some(l)
    }

    fn advance(&mut self, h: &Header, hash: [u8; 32]) {
        let c = self.chains.entry(h.sender).or_insert(Chain { seq: 0, hash: [0; 32], recent: IndexMap::new() });
        c.seq = h.seq;
        c.hash = hash;
        c.recent.insert(h.seq, hash);
        if c.recent.len() > 32 {
            c.recent.shift_remove_index(0);
        }
    }

    /// A member posts one sealed envelope. Err carries a void record's number when it was voided.
    pub fn post_envelope(&mut self, c: &Connection, token: &str, bytes: &[u8], lease_generation: Option<i64>) -> ZR<EnvelopeOut> {
        let s = self.session(token, false, true)?;
        let head = env::peek_envelope(bytes, true)?;
        if head.split.pruned {
            return zf("bad-format", "an envelope is posted with its ciphertext");
        }
        if hex(&head.header.sender) != s.id {
            return zf("wrong-sender", "a device posts its own envelopes only");
        }
        if s.role == Some(ROLE_AGENT) && self.lease_get(c, &s.id).map(|l| l.generation) != lease_generation {
            return zf("lease-lost", "this process does not hold the lease of this agent key: take it with agent_lease and post with its generation");
        }
        let v = {
            let st = Store::new(c, &self.id);
            let lk = Lookup { chains: &self.chains, store: &st };
            env::verify_envelope(bytes, &self.state, &lk, false, false, true)?
        };
        let h = v.header.clone();
        let checked: ZR<bool> = (|| {
            if h.kind == env::KIND_STATUS && v.split.ct.as_ref().map(|c| c.len()).unwrap_or(0) as i64 - 16 > 4096 {
                return zf("too-large", "a status body is at most 4 KiB");
            }
            self.authorise_envelope(c, &h, s.role.unwrap_or(0))
        })();
        let push = match checked {
            Ok(p) => p,
            Err(err) => {
                if !matches!(err.kind, crate::error::Kind::Z) || !VOIDABLE.contains(&err.code.as_str()) {
                    return Err(err);
                }
                let void_bytes = env::join_envelope(&v.split.header_bytes, &v.split.nonce, None, &v.ciphertext_hash, &v.split.signature);
                let code = err.code.clone();
                let n = crate::db::tx(c, |c| {
                    Store::new(c, &self.id).append_envelope(&h, &s.id, &v.hash, false, false, now(), &v.split.header_bytes, &v.split.nonce, None, &v.ciphertext_hash, &v.split.signature, Some(&code))
                })
                .map_err(db)?;
                self.advance(&h, v.hash);
                let mut err = err;
                err.voided = Some(n);
                err.void_bytes = Some(void_bytes);
                return Err(err);
            }
        };
        let recipient = !is_zero(&h.recipient);
        let n = crate::db::tx(c, |c| {
            Store::new(c, &self.id).append_envelope(&h, &s.id, &v.hash, recipient, push, now(), &v.split.header_bytes, &v.split.nonce, v.split.ct.as_deref(), &v.ciphertext_hash, &v.split.signature, None)
        })
        .map_err(db)?;
        self.advance(&h, v.hash);
        Ok(EnvelopeOut { n, push, urgency: h.card.as_ref().map(|c| c.urgency) })
    }

    // ---- leases (R4) --------------------------------------------------------------------------

    /// (generation, expires_at, previous instance if another one held it)
    pub fn take_lease(&mut self, c: &Connection, token: &str, instance: &str, renew: bool) -> ZR<(i64, i64, Option<String>)> {
        let s = self.session(token, false, true)?;
        if s.role != Some(ROLE_AGENT) {
            return zf("forbidden", "only agents hold a lease");
        }
        if instance.is_empty() {
            return zf("bad-argument", "process_instance");
        }
        let old = self.lease_get(c, &s.id);
        let st = Store::new(c, &self.id);
        if let Some(mut o) = old.clone() {
            if o.instance == instance {
                o.expires_at = now() + LEASE_MS;
                st.put_lease(&s.id, &o).map_err(db)?;
                self.leases.insert(s.id.clone(), o.clone());
                return Ok((o.generation, o.expires_at, None));
            }
        }
        if renew && old.as_ref().is_some_and(|o| now() <= o.expires_at) {
            return zf("lease-lost", "another process took over this agent key");
        }
        let generation = std::cmp::max(old.as_ref().map(|o| o.generation).unwrap_or(0) + 1, now());
        let l = Lease { instance: instance.into(), generation, expires_at: now() + LEASE_MS };
        self.leases.insert(s.id.clone(), l.clone());
        st.put_lease(&s.id, &l).map_err(db)?;
        Ok((generation, l.expires_at, old.filter(|o| o.instance != instance).map(|o| o.instance)))
    }
    pub fn touch_lease(&mut self, c: &Connection, id: &str) {
        if self.lease_get(c, id).is_some() {
            if let Some(l) = self.leases.get_mut(id) {
                l.expires_at = now() + LEASE_MS;
            }
        }
    }
    pub fn lease_of(&mut self, c: &Connection, id: &str) -> Option<Lease> { self.lease_get(c, id) }
}

impl From<Fail> for ZError {
    fn from(f: Fail) -> ZError { ZError { code: f.code, message: f.message, removed_seq: None } }
}
