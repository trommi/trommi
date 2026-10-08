//! client.mjs for an agent device: the sync engine (one cursor, verify every header, decrypt heads, lazy timelines),
//! membership and sessions (R6), persistence in the JS record shapes. The agent's actions and the outbox are in
//! agent.rs. Everything that the JS core runs inside `serial()` runs here holding the core lock.
use crate::codec;
use crate::crypto::grants::{self as G, SessionState};
use crate::crypto::{self, b64u, hex, unb64u, unhex, Chains, Device, Header, LogState, Secret};
use crate::error::{Result, ZError};
use crate::model::{self, now_ms, Change, Model, Rec};
use crate::storage::FileStorage;
use crate::transport::{Hub, HubEvent};
use futures_util::StreamExt;
use indexmap::IndexMap;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex, Weak};
use std::time::Duration;
use tokio::sync::{mpsc, Mutex, Notify};

pub type BoxFut<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;
pub const CHAIN_HASHES_KEPT: usize = 256;
const PAGE: u64 = 1000;
const SIGNED_SKEW_MS: u64 = 3 * 60_000;
pub const BLOCKED_RETRY_MS: u64 = 60_000;
pub fn pad(n: u64) -> String {
    format!("{n:012}")
}
pub async fn sleep(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await
}

// ---- (de)serialising crypto state ----------------------------------------------------------------------------

pub fn secret_to_json(s: &Secret) -> Value {
    json!({ "epoch": s.epoch, "key": b64u(&s.key), "hist": s.hist.map(|h| b64u(&h)) })
}
pub fn secret_from_json(o: &Value) -> Result<Secret> {
    let key = unb64u(o["key"].as_str().unwrap_or(""))?;
    let hist = match o["hist"].as_str() {
        Some(h) => Some(unb64u(h)?.try_into().map_err(|_| ZError::new("bad-format", "secret"))?),
        None => None,
    };
    Ok(Secret { epoch: o["epoch"].as_u64().unwrap_or(0) as u32, key: key.try_into().map_err(|_| ZError::new("bad-format", "secret"))?, hist })
}
fn pin_to_json(p: &crypto::Pin) -> Value {
    json!({ "seq": p.seq, "hash": b64u(&p.hash), "hashes": p.hashes.as_ref().map(|h| h.iter().map(|x| b64u(x)).collect::<Vec<_>>()).unwrap_or_default(), "lastRecoverSeq": p.last_recover_seq })
}
fn pin_from_json(o: &Value) -> Option<crypto::Pin> {
    if !o.is_object() {
        return None;
    }
    let hashes = o["hashes"].as_array().map(|a| a.iter().filter_map(|h| unb64u(h.as_str()?).ok()?.try_into().ok()).collect::<Vec<[u8; 32]>>());
    Some(crypto::Pin { seq: o["seq"].as_u64()? as u32, hash: unb64u(o["hash"].as_str()?).ok()?.try_into().ok()?, hashes, last_recover_seq: o["lastRecoverSeq"].as_i64().unwrap_or(-1) })
}
pub fn chain_to_json(c: &crypto::Chain) -> Value {
    let hashes: Vec<(u64, [u8; 32])> = c.hashes.iter().map(|(s, h)| (*s, *h)).collect();
    let keep = &hashes[hashes.len().saturating_sub(CHAIN_HASHES_KEPT)..];
    json!({ "seq": c.seq, "hash": b64u(&c.hash), "hashes": keep.iter().map(|(s, h)| json!([s, b64u(h)])).collect::<Vec<_>>() })
}
pub fn chain_from_json(o: &Value) -> Option<crypto::Chain> {
    let mut hashes = BTreeMap::new();
    for p in o["hashes"].as_array()? {
        hashes.insert(p[0].as_u64()?, unb64u(p[1].as_str()?).ok()?.try_into().ok()?);
    }
    Some(crypto::Chain { seq: o["seq"].as_u64()?, hash: unb64u(o["hash"].as_str()?).ok()?.try_into().ok()?, hashes, told: None })
}
fn trim_chain(c: &mut crypto::Chain) {
    if c.hashes.len() > CHAIN_HASHES_KEPT * 2 {
        let keys: Vec<u64> = c.hashes.keys().cloned().collect();
        let cut = keys[keys.len() - CHAIN_HASHES_KEPT];
        c.hashes.retain(|k, _| *k >= cut);
    }
}

/// One session's keys: its verified grant chain, the secrets this device holds, when its epoch last changed.
#[derive(Clone, Debug)]
pub struct SessionKeys {
    pub state: SessionState,
    pub grants: Vec<String>,
    pub secrets: BTreeMap<u32, Secret>,
    pub since: Option<u64>,
}
impl SessionKeys {
    /// Session key epoch -> the agents its grants gave that key (B03).
    pub fn epoch_agents(&self) -> BTreeMap<String, Vec<String>> {
        let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for g in &self.grants {
            if let Ok(d) = unb64u(g).and_then(|b| G::decode_grant(&b)) {
                let l = out.entry(d.epoch.to_string()).or_default();
                for id in d.agent_ids {
                    let h = hex(&id);
                    if !l.contains(&h) {
                        l.push(h);
                    }
                }
            }
        }
        out
    }
    pub fn ever_agents(&self) -> Vec<String> {
        let mut out: Vec<String> = vec![];
        for g in &self.grants {
            if let Ok(d) = unb64u(g).and_then(|b| G::decode_grant(&b)) {
                for id in d.agent_ids {
                    let h = hex(&id);
                    if !out.contains(&h) {
                        out.push(h);
                    }
                }
            }
        }
        out
    }
    pub fn epoch_start_time(&self, epoch: u32) -> Option<u64> {
        for g in &self.grants {
            if let Ok(d) = unb64u(g).and_then(|b| G::decode_grant(&b)) {
                if d.epoch == epoch {
                    return Some(d.time);
                }
            }
        }
        None
    }
}

/// An item of the outbox, persisted in the JS shape ({ local_id, bytes, seq, hash, prev, public, args, envelope_number? }).
#[derive(Clone, Debug)]
pub struct OutboxItem {
    pub raw: Map<String, Value>,
}
impl OutboxItem {
    pub fn local_id(&self) -> String {
        self.raw["local_id"].as_str().unwrap_or("").into()
    }
    pub fn bytes(&self) -> String {
        self.raw["bytes"].as_str().unwrap_or("").into()
    }
    pub fn hash(&self) -> String {
        self.raw["hash"].as_str().unwrap_or("").into()
    }
    pub fn envelope_number(&self) -> Option<u64> {
        self.raw.get("envelope_number").and_then(|v| v.as_u64())
    }
}

/// A command for the agent, as client.on('command') hands it out.
#[derive(Clone, Debug, Default)]
pub struct Command {
    pub command: String,
    pub session_id: Option<String>,
    pub envelope_number: u64,
    pub envelope_hash: String,
    pub sender_device_id: String,
    pub sender_sequence: u64,
    pub sent_at: u64,
    pub object_id: Option<String>,
    pub timeline_key: Option<String>,
    pub content: Map<String, Value>,
    pub late: bool,
    pub history: bool,
    pub choices: Vec<String>,
    pub previous_choices: Vec<String>,
    pub allow: bool,
    pub settled: bool,
    pub unsupported: Option<String>,
    pub what: Option<String>,
}

#[derive(Clone, Debug)]
pub enum ClientEvent {
    Command(Box<Command>),
    Removed { replaced: bool },
    Error(ZError),
    Session { session_id: String },
}

/// A command found while processing a batch, before delivery (agent.mjs _preAuthorise's record).
#[derive(Clone, Debug)]
pub struct PendingCmd {
    pub rec: Rec,
    pub session_id: Option<String>,
    pub envelope_number: u64,
    pub envelope_hash: String,
    pub sender_sequence: u64,
    pub sent_at: u64,
    pub sender_device_id: String,
    pub object_id: Option<String>,
    pub timeline_key: Option<String>,
    pub refused: Option<String>,
    pub message: Option<String>,
    pub late: bool,
    pub unsupported: Option<String>,
    pub previous_choices: Option<Vec<String>>,
}

pub struct LocalHead {
    pub session_id: Option<String>,
    pub object_version: u64,
    pub version_hash: String,
    pub content: Map<String, Value>,
    pub object_state: String,
    pub urgency: String,
}

pub struct Core {
    pub state: LogState,
    pub secrets: BTreeMap<u32, Secret>,
    pub chains: Chains,
    pub room_record: Map<String, Value>,
    pub model: Model,
    pub outbox: Vec<OutboxItem>,
    pub recent_sent: Vec<OutboxItem>,
    pub by_hash: HashMap<String, String>,
    pub delivered: BTreeMap<String, u64>,
    pub ledger: indexmap::IndexSet<String>,
    pub frontiers: HashMap<String, HashMap<String, u64>>,
    pub commands_halted: Option<String>,
    pub started_at: u64,
    pub session_keys: IndexMap<String, SessionKeys>,
    pub attachment_cache: Vec<(String, Vec<u8>)>,
    pub sent_content: HashMap<String, Map<String, Value>>,
    pub local_heads: HashMap<String, LocalHead>,
    pub lamport: u64,
    pub history_before: Option<u64>,
    pub history_before_number: Option<u64>,
    pub epoch_changed_at: Option<u64>,
    pub fresh_storage: bool,
    pub dirty_records: BTreeMap<String, Value>,
    pub dirty_chains: BTreeSet<String>,
    pub stale_hashes: indexmap::IndexSet<String>,
    pub missing_keys: HashSet<String>,
    pub need_resync: bool,
    pub resyncing: bool,
    pub gap_in_resync: bool,
    pub gap_backoff: u64,
    pub last_gap_resync: u64,
    pub live_from: Option<u64>,
    pub live_batch: bool,
    pub grant_tried: HashSet<String>,
    pub behind_alerted: Option<u64>,
    pub held_commands: Vec<PendingCmd>,
    pub reasserted: HashMap<String, u64>,
    pub requests: HashMap<String, (Option<String>, u64, bool)>,
    pub heard_sent: HashMap<String, u64>,
    pub voided_own: HashSet<String>,
    pub storage_failed: Option<String>,
    pub sync_extra: Map<String, Value>,
    pub hub_has_more: bool,
}

impl Core {
    pub fn my_device_id(&self) -> String {
        self.model.room.my_device_id.clone()
    }
    pub fn is_human(&self) -> bool {
        self.model.room.my_role == "human"
    }
    /// The sessions assigned to this agent now (grants), in the order the keys were learned.
    pub fn session_ids(&self) -> Vec<String> {
        let me = self.my_device_id();
        self.session_keys.values().filter(|k| k.state.agent_ids.contains(&me)).map(|k| k.state.session_id.clone()).collect()
    }
    /// The main session: one a human gave this agent; a child session it opened itself never is.
    pub fn session_id(&self) -> Option<String> {
        let ids = self.session_ids();
        ids.iter().find(|sid| !self.session_keys[*sid].state.created_by_agent).cloned().or_else(|| ids.first().cloned())
    }
    pub fn child_session_ids(&self) -> Vec<String> {
        self.session_ids().into_iter().filter(|sid| self.session_keys.get(sid).is_some_and(|k| k.state.created_by_agent)).collect()
    }
    pub fn own_seq(&self, me: &[u8]) -> u64 {
        self.chains.get(&b64u(me)).map(|c| c.seq).unwrap_or(0)
    }
    /// The opening side of the key choice: room secrets by epoch, session secrets by session and epoch.
    pub fn open_key(&self, h: &Header) -> Option<Secret> {
        if h.key_scope == 1 {
            self.session_keys.get(&hex(&h.session_id?)).and_then(|k| k.secrets.get(&h.epoch)).cloned()
        } else {
            self.secrets.get(&h.epoch).cloned()
        }
    }
    pub fn holds_obj(&self, agent: &str, session_id: Option<&str>) -> bool {
        self.model.holder_of(agent, session_id) == self.my_device_id()
    }
    fn members_list(&self) -> Vec<(String, String, bool, u32, Option<u32>)> {
        self.state.members.iter().map(|m| (hex(&m.id), if m.role == crypto::ROLE_HUMAN { "human".to_string() } else { "agent".to_string() }, m.removed_seq.is_none(), m.added_seq, m.removed_seq)).collect()
    }
    pub fn sync_record(&self) -> Value {
        let mut s = Map::new();
        s.insert("cursor".into(), json!(self.model.room.last_envelope_number));
        s.insert("delivered".into(), json!(self.delivered));
        s.insert("history_before".into(), json!(self.history_before));
        s.insert("history_before_number".into(), json!(self.history_before_number));
        s.insert("lamport".into(), json!(self.lamport));
        if !self.stale_hashes.is_empty() {
            s.insert("stale_hashes".into(), json!(self.stale_hashes.iter().collect::<Vec<_>>()));
        }
        if self.model.newer.count > 0 {
            s.insert("newer".into(), serde_json::to_value(&self.model.newer).unwrap());
        }
        for (k, v) in &self.sync_extra {
            s.insert(k.clone(), v.clone());
        }
        let fr: Map<String, Value> = self.frontiers.iter().map(|(k, m)| (k.clone(), json!(m))).collect();
        s.insert("frontiers".into(), Value::Object(fr));
        Value::Object(s)
    }
    fn advance_frontier(&mut self, sender: &str, h: &Header) {
        let f = self.frontiers.entry(sender.to_string()).or_default();
        for s in &h.seen {
            let o = hex(&s.sender);
            if f.get(&o).copied().unwrap_or(0) < s.seq {
                f.insert(o, s.seq);
            }
        }
        f.insert(sender.to_string(), h.seq);
    }
    fn remember_stale(&mut self, h: String) {
        self.stale_hashes.insert(h);
        if self.stale_hashes.len() > 4096 {
            self.stale_hashes.shift_remove_index(0);
        }
    }
    /// The scope's current epoch, when this device learned of it, and the signed start time of an epoch.
    fn epoch_info(&self, h: &Header) -> Option<(u32, Option<u64>, Box<dyn Fn(u32) -> Option<u64> + '_>)> {
        if h.key_scope == 1 {
            let k = self.session_keys.get(&hex(&h.session_id?))?;
            return Some((k.state.epoch, k.since, Box::new(move |e| k.epoch_start_time(e))));
        }
        let st = &self.state;
        Some((st.epoch, self.epoch_changed_at, Box::new(move |e| st.epochs.get(&e).and_then(|at| st.entry(at.seq)).map(|x| x.time))))
    }
    /// R3 on clients (B03/A7): is this envelope in an older key epoch of its scope past the grace?
    fn is_stale(&self, h: &Header, started: bool) -> bool {
        let Some((current, since, signed_at)) = self.epoch_info(h) else { return false };
        if h.epoch >= current {
            return false;
        }
        if self.live_batch && started && !self.resyncing {
            if let (Some(since), Some(live_from)) = (since, self.live_from) {
                if live_from <= since {
                    return now_ms().saturating_sub(since) > crypto::EPOCH_GRACE_MS;
                }
            }
        }
        let Some(changed_at) = signed_at(h.epoch + 1) else { return false };
        h.time.saturating_sub(changed_at) > crypto::EPOCH_GRACE_MS + SIGNED_SKEW_MS && h.time > changed_at
    }
    fn void_plausible(&self, h: &Header, code: Option<&str>) -> bool {
        match code {
            Some("wrong-epoch") => self.epoch_info(h).is_some_and(|(cur, _, _)| h.epoch != cur),
            Some("forbidden") => {
                let role = self.state.member(&h.sender).map(|m| m.role);
                if role != Some(crypto::ROLE_AGENT) {
                    return false;
                }
                if h.key_scope != 1 {
                    return true;
                }
                let at = h.session_id.and_then(|s| self.session_keys.get(&hex(&s))).map(|k| k.epoch_agents()).and_then(|m| m.get(&h.epoch.to_string()).cloned());
                at.is_some_and(|a| !a.contains(&hex(&h.sender)))
            }
            _ => false,
        }
    }
    pub fn mark_dirty(&mut self, ch: &Change, tl: &[Rec]) {
        for id in &ch.cards {
            if let Some(c) = self.model.cards.get(id) {
                self.dirty_records.insert(format!("card/{id}"), serde_json::to_value(c).unwrap());
            }
        }
        for id in &ch.sessions {
            if let Some(s) = self.model.sessions.get(id) {
                self.dirty_records.insert(format!("session/{id}"), serde_json::to_value(s).unwrap());
            }
        }
        for id in &ch.permissions {
            if let Some(p) = self.model.permissions.get(id) {
                self.dirty_records.insert(format!("perm/{id}"), serde_json::to_value(p).unwrap());
            }
        }
        for id in &ch.published {
            if let Some(p) = self.model.published.get(id) {
                self.dirty_records.insert(format!("pub/{id}"), serde_json::to_value(p).unwrap());
            }
        }
        for key in &ch.timelines {
            if let Some(t) = self.model.timelines.get(key) {
                let mut t = t.clone();
                t.window_open = false;
                self.dirty_records.insert(format!("tlmeta/{key}"), serde_json::to_value(&t).unwrap());
            }
        }
        for key in &ch.registers {
            if key.starts_with("device/") {
                let regs: Vec<Value> = self.model.device_registers.iter().map(|(k, v)| json!([k, v])).collect();
                self.dirty_records.insert("devregs".into(), Value::Array(regs));
            }
        }
        for rec in tl {
            let key = model::timeline_key(rec.timeline_kind.as_deref().unwrap_or(""), rec.timeline_id.as_deref().unwrap_or(""));
            self.dirty_records.insert(format!("tl/{key}/{}", pad(rec.envelope_number)), json!({
                "n": rec.envelope_number, "h": rec.envelope_hash, "s": rec.sender_device_id, "q": rec.sender_sequence, "r": rec.recipient_device_id, "t": rec.sent_at,
                "c": rec.content.clone().map(Value::Object).unwrap_or(Value::Null), "cs": rec.content_state,
            }));
        }
    }
}

pub struct Client {
    pub hub: Arc<Hub>,
    pub storage: Arc<FileStorage>,
    pub device: Device,
    pub core: Mutex<Core>,
    pub events: mpsc::UnboundedSender<ClientEvent>,
    pub started: AtomicBool,
    pub pump_running: AtomicBool,
    pub background: AtomicUsize,
    pub session_notify: Notify,
    pub stream_open: AtomicBool,
    pub lease_lost: AtomicBool,
    pub too_old: AtomicBool,
    pub process_instance: StdMutex<Option<String>>,
    pub self_ref: StdMutex<Weak<Client>>,
    tasks: StdMutex<Vec<tokio::task::JoinHandle<()>>>,
    stream_stop: Notify,
    lease_recovering: AtomicBool,
    pub rekey_wait_ms: u64,
    /// Tests stand in for a newer client here (the interop driver's agent_newer).
    pub newer: StdMutex<NewerFlags>,
}
#[derive(Default, Clone, Copy)]
pub struct NewerFlags {
    pub message: bool,
    pub answer: bool,
    pub card: bool,
}

fn role_name(r: u8) -> &'static str {
    if r == crypto::ROLE_HUMAN { "human" } else { "agent" }
}
fn is_transient(e: &ZError) -> bool {
    e.code == "offline" || e.code == "rate-limited" || e.code == "timeout" || e.status == Some(0) || e.status.is_some_and(|s| s >= 500) || e.code.starts_with("http-5")
}
const REREAD_ON: [&str; 9] = ["bad-signature", "bad-format", "bad-version", "chain-break", "hash-mismatch", "decrypt-failed", "not-member", "log-fork", "wrong-room"];

/// Decode an opened body: every attachment it names must be in the signed header's blob list.
pub fn decode_opened(payload: &[u8], header: &Header) -> (Option<Map<String, Value>>, String) {
    let (content, cs) = codec::decode_payload(payload);
    if let Some(c) = &content {
        let blobs: Vec<String> = header.blobs.iter().map(|b| hex(b)).collect();
        if codec::attachment_ids_of(c).iter().any(|id| !blobs.contains(id)) {
            return (None, "undecryptable".into());
        }
    }
    (content, cs.into())
}

pub struct Pre {
    pub envelope_number: u64,
    pub bytes: Vec<u8>,
    pub peek: Option<crypto::Peek>,
    pub hash: Option<[u8; 32]>,
    pub opened: Option<(Option<Vec<u8>>, Option<Vec<u8>>)>,
    pub content_state: String,
    pub error: Option<ZError>,
    pub void: bool,
    pub void_code: Option<String>,
    pub stale: bool,
    pub missing_key: Option<String>,
    pub need_keys: bool,
}

impl Client {
    /// A client over a verified member list and its stored room record (room.rs opens and joins).
    pub fn new(storage: Arc<FileStorage>, device: Device, state: LogState, secrets: Vec<Secret>, room_record: Map<String, Value>, client_name: Option<String>) -> Result<(Arc<Client>, mpsc::UnboundedReceiver<ClientEvent>)> {
        let hub_url = room_record["hub_url"].as_str().unwrap_or("").to_string();
        let room_id = room_record["room_id"].as_str().unwrap_or("").to_string();
        let dev2 = device.clone();
        let rid = state.room_id;
        let hub_slot: Arc<StdMutex<String>> = Arc::new(StdMutex::new(String::new()));
        let hs = hub_slot.clone();
        let signer: crate::transport::Signer = Arc::new(move |challenge: &[u8]| crypto::sign_hub_auth(&dev2, &rid, &hs.lock().unwrap(), challenge));
        let hub = Hub::new(&hub_url, Some(room_id.clone()), client_name, Some(signer))?;
        *hub_slot.lock().unwrap() = hub.hub_url.clone();
        let (tx, rx) = mpsc::unbounded_channel();
        let my_role = state.member_now(&device.id).map(|m| role_name(m.role).to_string()).or_else(|| room_record["my_role"].as_str().map(String::from)).unwrap_or_else(|| "agent".into());
        let mut model = Model::new();
        model.room.room_id = room_id;
        model.room.hub_url = hub.hub_url.clone();
        model.room.my_device_id = hex(&device.id);
        model.room.my_role = my_role;
        model.room.key_epoch = state.epoch;
        model.room.last_entry_number = state.head_seq as i64;
        let core = Core {
            secrets: secrets.into_iter().map(|s| (s.epoch, s)).collect(), chains: Chains::new(), epoch_changed_at: room_record.get("epoch_changed_at").and_then(|v| v.as_u64()),
            room_record, model, outbox: vec![], recent_sent: vec![], by_hash: HashMap::new(), delivered: BTreeMap::new(), ledger: Default::default(),
            frontiers: HashMap::new(), commands_halted: None, started_at: now_ms(), session_keys: IndexMap::new(), attachment_cache: vec![],
            sent_content: HashMap::new(), local_heads: HashMap::new(), lamport: 0, history_before: None, history_before_number: None, fresh_storage: false,
            dirty_records: BTreeMap::new(), dirty_chains: BTreeSet::new(), stale_hashes: Default::default(), missing_keys: HashSet::new(), need_resync: false,
            resyncing: false, gap_in_resync: false, gap_backoff: 2000, last_gap_resync: 0, live_from: None, live_batch: false, grant_tried: HashSet::new(),
            behind_alerted: None, held_commands: vec![], reasserted: HashMap::new(), requests: HashMap::new(), heard_sent: HashMap::new(), voided_own: HashSet::new(),
            storage_failed: None, sync_extra: Map::new(), hub_has_more: false, state,
        };
        let client = Arc::new(Client {
            hub: Arc::new(hub), storage, device, core: Mutex::new(core), events: tx, started: AtomicBool::new(false), pump_running: AtomicBool::new(false),
            background: AtomicUsize::new(0), session_notify: Notify::new(), stream_open: AtomicBool::new(false), lease_lost: AtomicBool::new(false), too_old: AtomicBool::new(false),
            process_instance: StdMutex::new(None), self_ref: StdMutex::new(Weak::new()), tasks: StdMutex::new(vec![]), stream_stop: Notify::new(),
            lease_recovering: AtomicBool::new(false), rekey_wait_ms: 60_000, newer: StdMutex::new(NewerFlags::default()),
        });
        *client.self_ref.lock().unwrap() = Arc::downgrade(&client);
        // what the hub says by itself (too old, the lease lost for good) goes to the client's handlers
        let (htx, mut hrx) = mpsc::unbounded_channel();
        *client.hub.events.lock().unwrap() = Some(htx);
        let w = Arc::downgrade(&client);
        tokio::spawn(async move {
            while let Some(e) = hrx.recv().await {
                let Some(c) = w.upgrade() else { break };
                match e {
                    HubEvent::TooOld(e) => c.on_too_old(e).await,
                    HubEvent::LeaseLost(e) => c.on_lease_lost(e),
                }
            }
        });
        Ok((client, rx))
    }
    pub fn me(&self) -> String {
        hex(&self.device.id)
    }
    fn arc(&self) -> Option<Arc<Client>> {
        self.self_ref.lock().unwrap().upgrade()
    }
    pub fn emit(&self, e: ClientEvent) {
        let _ = self.events.send(e);
    }
    fn spawn(&self, f: impl std::future::Future<Output = ()> + Send + 'static) {
        let h = tokio::spawn(f);
        let mut t = self.tasks.lock().unwrap();
        t.retain(|h| !h.is_finished());
        t.push(h);
    }

    async fn on_too_old(&self, e: ZError) {
        if self.too_old.swap(true, Ordering::SeqCst) {
            return;
        }
        self.emit(ClientEvent::Error(e));
        self.stop().await;
    }
    /// lease-lost: ask for the lease again; only if another live process holds it does this process stop (R4).
    pub fn on_lease_lost(&self, e: ZError) {
        if self.lease_lost.load(Ordering::SeqCst) || self.lease_recovering.swap(true, Ordering::SeqCst) {
            return;
        }
        let Some(me) = self.arc() else { return };
        tokio::spawn(async move {
            let ok = loop {
                match me.hub.recover_lease().await {
                    Ok(v) => break Some(v),
                    Err(_) => {
                        if !me.started.load(Ordering::SeqCst) {
                            break None;
                        }
                        sleep(2000).await;
                    }
                }
            };
            me.lease_recovering.store(false, Ordering::SeqCst);
            match ok {
                None => {}
                Some(true) => {
                    if me.started.load(Ordering::SeqCst) {
                        me.restart_stream();
                    }
                    me.pump_outbox();
                }
                Some(false) => {
                    me.lease_lost.store(true, Ordering::SeqCst);
                    me.emit(ClientEvent::Error(e));
                    me.stop().await;
                }
            }
        });
    }

    // ---- warm start ----------------------------------------------------------------------------------------------

    /// Load the persisted model, chains and cursor (openRoom).
    pub async fn load_persisted(&self) -> Result<()> {
        let st = &self.storage;
        let mut c = self.core.lock().await;
        let sync = st.get("sync");
        c.fresh_storage = sync.is_none();
        for (k, v) in st.range("chain/", None, None, None, false) {
            if let Some(ch) = chain_from_json(&v) {
                c.chains.insert(k[6..].to_string(), ch);
            }
        }
        if let Some(sync) = &sync {
            c.model.room.last_envelope_number = sync["cursor"].as_u64().unwrap_or(0);
            if let Some(d) = sync["delivered"].as_object() {
                c.delivered = d.iter().filter_map(|(k, v)| Some((k.clone(), v.as_u64()?))).collect();
            }
            if let Some(f) = sync["frontiers"].as_object() {
                c.frontiers = f.iter().map(|(k, m)| (k.clone(), m.as_object().map(|m| m.iter().filter_map(|(a, b)| Some((a.clone(), b.as_u64()?))).collect()).unwrap_or_default())).collect();
            }
            c.lamport = sync["lamport"].as_u64().unwrap_or(0);
            if let Some(h) = sync["stale_hashes"].as_array() {
                c.stale_hashes = h.iter().filter_map(|x| x.as_str().map(String::from)).collect();
            }
            if sync["newer"]["count"].as_u64().unwrap_or(0) > 0 {
                c.model.newer = serde_json::from_value(sync["newer"].clone()).unwrap_or_default();
            }
            for k in ["snapshot_cursor", "snapshot_chains"] {
                if let Some(v) = sync.get(k) {
                    c.sync_extra.insert(k.into(), v.clone());
                }
            }
        }
        if let Some(d) = st.get("delivered").and_then(|v| v.as_object().cloned()) {
            for (k, v) in d {
                if let Some(n) = v.as_u64() {
                    if n > c.delivered.get(&k).copied().unwrap_or(0) {
                        c.delivered.insert(k, n);
                    }
                }
            }
        }
        if let Some(l) = st.get("lamport").and_then(|v| v.as_u64()) {
            if l > c.lamport {
                c.lamport = l;
            }
        }
        c.history_before = match &sync { Some(s) => s["history_before"].as_u64(), None => Some(c.started_at) };
        c.history_before_number = sync.as_ref().and_then(|s| s["history_before_number"].as_u64());
        c.ledger = st.get("ledger").and_then(|v| v.as_array().cloned()).unwrap_or_default().into_iter().filter_map(|v| v.as_str().map(String::from)).collect();
        let sessions = c.room_record.get("sessions").and_then(|v| v.as_object().cloned()).unwrap_or_default();
        for (sid, rec) in sessions {
            let grants: Vec<String> = rec["grants"].as_array().map(|a| a.iter().filter_map(|g| g.as_str().map(String::from)).collect()).unwrap_or_default();
            let bytes: Vec<Vec<u8>> = grants.iter().filter_map(|g| unb64u(g).ok()).collect();
            match G::verify_grants(&bytes, &c.state) {
                Ok(Some(state)) => {
                    let secrets: BTreeMap<u32, Secret> = rec["secrets"].as_array().map(|a| a.iter().filter_map(|x| secret_from_json(x).ok()).map(|s| (s.epoch, s)).collect()).unwrap_or_default();
                    c.session_keys.insert(sid.clone(), SessionKeys { state, grants, secrets, since: rec["since"].as_u64() });
                }
                Ok(None) => {}
                Err(e) => eprintln!("[core] stored grants of {sid} {}", e.text()),
            }
        }
        if let Some(Value::Array(regs)) = st.get("devregs") {
            for r in regs {
                if let (Some(k), Some(v)) = (r.get(0).and_then(|k| k.as_str()), r.get(1)) {
                    c.model.device_registers.insert(k.into(), v.clone());
                }
            }
        }
        let mut ch = Change::default();
        let members = c.members_list();
        c.model.apply_members(&members, &mut ch);
        let online = st.get("devices").and_then(|v| v.as_array().cloned()).unwrap_or_default();
        c.model.apply_devices(&online, &mut ch);
        for (_, v) in st.range("session/", None, None, None, false) {
            if let Ok(s) = serde_json::from_value::<model::Session>(v) {
                c.model.sessions.insert(s.session_id.clone(), s);
            }
        }
        for (_, v) in st.range("card/", None, None, None, false) {
            if let Ok(x) = serde_json::from_value::<model::Card>(v) {
                c.model.cards.insert(x.object_id.clone(), x);
            }
        }
        for (_, v) in st.range("perm/", None, None, None, false) {
            if let Ok(x) = serde_json::from_value::<model::Permission>(v) {
                c.model.permissions.insert(x.object_id.clone(), x);
            }
        }
        for (_, v) in st.range("pub/", None, None, None, false) {
            if let Ok(x) = serde_json::from_value::<model::Published>(v) {
                c.model.published.insert(x.object_id.clone(), x);
            }
        }
        for (_, v) in st.range("tlmeta/", None, None, None, false) {
            if let Ok(mut x) = serde_json::from_value::<model::Timeline>(v) {
                x.loaded_down_to = None;
                x.window_open = false;
                c.model.timelines.insert(x.timeline_key.clone(), x);
            }
        }
        c.outbox = st.get("outbox").and_then(|v| v.as_array().cloned()).unwrap_or_default().into_iter().filter_map(|v| v.as_object().cloned()).map(|raw| OutboxItem { raw }).collect();
        let outbox_hashes: Vec<(String, String)> = c.outbox.iter().map(|o| (o.hash(), o.local_id())).collect();
        for (h, l) in outbox_hashes {
            c.by_hash.insert(h, l);
        }
        let keys: Vec<(SessionState, Vec<String>, BTreeMap<String, Vec<String>>)> = c.session_keys.values().map(|k| (k.state.clone(), k.ever_agents(), k.epoch_agents())).collect();
        for (s, ever, ea) in keys {
            c.model.apply_session_grant(&s, &mut ch, &ever, Some(ea));
        }
        c.model.project(&mut ch);
        Ok(())
    }

    pub fn save_room(&self, c: &mut Core) -> Result<()> {
        let entries: Vec<Value> = c.state.entries.iter().map(|e| json!(b64u(&e.bytes()))).collect();
        let pin = pin_to_json(&crypto::pin_of(&c.state));
        let secrets: Vec<Value> = c.secrets.values().map(secret_to_json).collect();
        let sessions: Map<String, Value> = c.session_keys.iter().map(|(sid, k)| (sid.clone(), json!({ "grants": k.grants, "secrets": k.secrets.values().map(secret_to_json).collect::<Vec<_>>(), "since": k.since }))).collect();
        let r = &mut c.room_record;
        r.insert("entries".into(), Value::Array(entries));
        r.insert("pin".into(), pin);
        r.insert("secrets".into(), Value::Array(secrets));
        r.insert("epoch_changed_at".into(), json!(c.epoch_changed_at));
        r.insert("sessions".into(), Value::Object(sessions));
        self.storage.set("room", Value::Object(c.room_record.clone()))
    }

    // ---- start / stop --------------------------------------------------------------------------------------------

    pub async fn start(&self, stream: bool, process_instance: Option<String>) -> Result<()> {
        if self.started.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        if let Some(p) = process_instance {
            *self.process_instance.lock().unwrap() = Some(p);
        }
        self.set_connection("connecting").await;
        if let Err(e) = self.hub.auth_header().await {
            if e.code != "not-member" {
                return Err(e);
            }
            {
                let mut c = self.core.lock().await;
                let _ = self.learn_removal(&mut c, Some(e.clone())).await;
                if c.model.room.connection != "removed" {
                    return Err(e);
                }
                let replaced = c.model.room.replaced;
                return Err(ZError::new("removed", if replaced { "another connector continues this session: this device was retired" } else { "this device was removed from the room" }).with("replaced", replaced));
            }
        }
        let devices = self.hub.devices().await.ok();
        let session_list = self.hub.sessions().await;
        {
            let mut c = self.core.lock().await;
            if c.fresh_storage && c.history_before_number.is_none() && !c.is_human() {
                if let Ok(head) = self.hub.envelopes(crypto::MAX_SAFE, 1, false).await {
                    if let Some(n) = head["last_envelope_number"].as_u64() {
                        c.history_before_number = Some(n);
                        let s = c.sync_record();
                        c.dirty_records.insert("sync".into(), s);
                    }
                }
            }
            self.refresh_members(&mut c, false, None).await?;
            self.refresh_sessions(&mut c, Some(session_list)).await?;
        }
        if let Some(d) = devices {
            let _ = self.refresh_devices(Some(d), false).await;
        }
        self.pump_outbox();
        self.send_device_register().await?;
        self.set_connection("catching_up").await;
        self.catch_up().await?;
        self.reassert_refused().await;
        let has_lease = self.hub.lease_generation().is_some();
        if stream && !self.core.lock().await.is_human() && !has_lease {
            let pi = self.process_instance.lock().unwrap().clone();
            self.claim_session(pi).await?;
        }
        if stream {
            self.open_stream();
        } else {
            self.set_connection("live").await;
        }
        // presence every minute
        let w = self.self_ref.lock().unwrap().clone();
        self.spawn(async move {
            loop {
                sleep(60_000).await;
                let Some(c) = w.upgrade() else { break };
                if !c.started.load(Ordering::SeqCst) {
                    break;
                }
                let _ = c.refresh_devices(None, false).await;
            }
        });
        // B03: a device that slept was not live; until its stream opens again it judges by signed times
        let w = self.self_ref.lock().unwrap().clone();
        self.spawn(async move {
            let mut beat = now_ms();
            loop {
                sleep(5_000).await;
                let Some(c) = w.upgrade() else { break };
                if !c.started.load(Ordering::SeqCst) {
                    break;
                }
                let n = now_ms();
                if n - beat > 20_000 {
                    c.core.lock().await.live_from = None;
                }
                beat = n;
            }
        });
        Ok(())
    }

    /// device/<id> right after joining; agents only once a session is assigned.
    pub async fn send_device_register(&self) -> Result<()> {
        let info = {
            let mut c = self.core.lock().await;
            if c.room_record.get("device_register_sent").and_then(|v| v.as_bool()).unwrap_or(false) {
                return Ok(());
            }
            let Some(info) = c.room_record.get("device_info").cloned().filter(|v| !v.is_null()) else { return Ok(()) };
            if !c.is_human() && c.session_id().is_none() {
                return Ok(());
            }
            c.room_record.insert("device_register_sent".into(), json!(true));
            self.save_room(&mut c)?;
            info
        };
        let mut v = Map::new();
        v.insert(format!("device/{}", self.me()), info);
        self.set_registers(v, None).await.map(|_| ())
    }

    pub async fn stop(&self) {
        self.started.store(false, Ordering::SeqCst);
        self.stream_stop.notify_waiters();
        for h in self.tasks.lock().unwrap().drain(..) {
            h.abort();
        }
        self.stream_open.store(false, Ordering::SeqCst);
        let mut c = self.core.lock().await;
        c.live_from = None;
        let _ = self.flush(&mut c);
        c.model.room.connection = "offline".into();
    }

    pub async fn set_connection(&self, s: &str) {
        self.core.lock().await.model.room.connection = s.into();
    }

    // ---- membership and keys ---------------------------------------------------------------------------------------

    /// The hub refuses this device (403): it may have been removed; the refusal carries the signed entries.
    pub async fn learn_removal(&self, c: &mut Core, refusal: Option<ZError>) -> Result<()> {
        let e = match refusal {
            Some(e) => Some(e),
            None => {
                match self.refresh_members(c, false, None).await {
                    Ok(()) => return Ok(()),
                    Err(x) if x.status != Some(403) => return Err(x),
                    Err(_) => {}
                }
                self.hub.clear_token();
                self.hub.sign_in(None).await.err()
            }
        };
        let entries = e.as_ref().filter(|e| e.code == "not-member").and_then(|e| e.body.as_ref()).and_then(|b| b["signed_entries"].as_array().cloned());
        if let Some(entries) = entries {
            let given = json!({ "last_entry_number": entries.len() as i64 - 1, "signed_entries": entries.iter().skip(c.state.head_seq as usize + 1).cloned().collect::<Vec<_>>() });
            self.refresh_members(c, false, Some(given)).await?;
        }
        Ok(())
    }

    pub async fn refresh_members(&self, c: &mut Core, throw_on_fork: bool, given: Option<Value>) -> Result<()> {
        let had_given = given.is_some();
        let r = match given {
            Some(g) => g,
            None => self.hub.members(c.state.head_seq as i64, None).await?,
        };
        let mut ch = Change::default();
        let last = r["last_entry_number"].as_i64().unwrap_or(-1);
        if last < c.state.head_seq as i64 {
            let head = c.state.head_seq;
            c.model.push_alert(&mut ch, "log-rollback", &format!("the hub shows member list entry {last}, this device saw {head}"), None, None, "local");
            if throw_on_fork {
                return Err(ZError::new("log-rollback", "member list rolled back"));
            }
            return Ok(());
        }
        let entries: Vec<String> = r["signed_entries"].as_array().map(|a| a.iter().filter_map(|e| e.as_str().map(String::from)).collect()).unwrap_or_default();
        let epoch_before = c.state.epoch;
        let mut state = c.state.clone();
        let res: Result<()> = (|| {
            for e in &entries {
                state = crypto::apply_entry(Some(&state), &unb64u(e)?)?;
            }
            let pin = c.room_record.get("pin").and_then(pin_from_json);
            if crypto::check_log_against_pin(&state, pin.as_ref())? == "recovery-override" {
                c.model.push_alert(&mut ch, "recovery-override", "a recovery replaced the member list this device knew", None, None, "local");
            }
            Ok(())
        })();
        if let Err(e) = res {
            c.model.push_alert(&mut ch, if e.code.is_empty() { "bad-entry" } else { &e.code }, &e.text(), None, None, "local");
            if throw_on_fork {
                return Err(e);
            }
            return Ok(());
        }
        if entries.is_empty() && !had_given {
            return Ok(());
        }
        c.state = state;
        if c.state.epoch != epoch_before {
            c.epoch_changed_at = Some(now_ms());
        }
        c.model.room.last_entry_number = c.state.head_seq as i64;
        c.model.room.key_epoch = c.state.epoch;
        let members = c.members_list();
        c.model.apply_members(&members, &mut ch);
        let me = c.state.member(&self.device.id).cloned();
        if me.as_ref().map(|m| m.removed_seq.is_some()).unwrap_or(true) {
            let was = c.model.room.connection.clone();
            c.model.room.connection = "removed".into();
            let out = me.as_ref().and_then(|m| m.removed_seq).and_then(|s| c.state.entry(s).cloned());
            let before = out.as_ref().and_then(|o| o.seq.checked_sub(1)).and_then(|s| c.state.entry(s).cloned());
            let replaced = !c.is_human() && before.as_ref().zip(out.as_ref()).is_some_and(|(b, o)| b.type_ == crypto::ENTRY_ADD && b.member.map(|m| m.role) == Some(crypto::ROLE_AGENT) && b.signer == o.signer);
            c.model.room.replaced = replaced;
            c.model.push_alert(&mut ch, "removed", if replaced { "another connector continues this session: this device was retired" } else { "this device was removed from the room" }, None, None, "local");
            self.save_room(c)?;
            self.stream_stop.notify_waiters();
            self.stream_open.store(false, Ordering::SeqCst);
            if was != "removed" {
                self.emit(ClientEvent::Removed { replaced });
            }
            return Ok(());
        }
        if !c.secrets.contains_key(&c.state.epoch) {
            self.fetch_keys(c).await?;
        }
        self.save_room(c)?;
        Ok(())
    }

    async fn fetch_keys(&self, c: &mut Core) -> Result<()> {
        let have = c.secrets.keys().max().copied().unwrap_or(0);
        let r = self.hub.sealed_room_keys(have).await?;
        for k in r["sealed_room_keys"].as_array().cloned().unwrap_or_default() {
            let ep = k["key_epoch"].as_u64().unwrap_or(0) as u32;
            if c.secrets.contains_key(&ep) {
                continue;
            }
            let s = crypto::unwrap_epoch_key(&c.state, &self.device, &unb64u(k["key_sealed"].as_str().unwrap_or(""))?, ep)?;
            c.secrets.insert(ep, s);
        }
        Ok(())
    }

    pub async fn refresh_devices(&self, prefetched: Option<Value>, partial: bool) -> Result<()> {
        let r = match prefetched {
            Some(p) => p,
            None => self.hub.devices().await?,
        };
        let mut c = self.core.lock().await;
        let mut ch = Change::default();
        let list = r["devices"].as_array().cloned().unwrap_or_default();
        c.model.apply_devices(&list, &mut ch);
        let rows: Vec<Value> = if partial {
            c.model.members.values().map(|d| json!({ "device_id": d.device_id, "is_online": d.is_online, "offline_since": d.offline_since, "link": d.link, "agent_session_id": d.agent_session_id })).collect()
        } else {
            list.iter().map(|d| json!({ "device_id": d["device_id"], "is_online": d["is_online"], "offline_since": d.get("offline_since").cloned().unwrap_or(Value::Null), "link": d.get("link").cloned().unwrap_or(Value::Null), "agent_session_id": d.get("agent_session_id").cloned().unwrap_or(Value::Null) })).collect()
        };
        let _ = self.storage.set("devices", Value::Array(rows));
        // the sessions carry their agent's presence: persisted with them
        let sessions: Vec<String> = ch.sessions.iter().cloned().collect();
        let mut c2 = Change::default();
        c2.sessions = sessions.into_iter().collect();
        c.mark_dirty(&c2, &[]);
        Ok(())
    }

    /// R6: fetch the grant chains of every session (new grants only), verify, open this device's session keys.
    pub fn refresh_sessions<'a>(&'a self, c: &'a mut Core, prefetched: Option<Result<Value>>) -> BoxFut<'a, Result<()>> {
        Box::pin(async move {
            let list = match prefetched {
                Some(Ok(v)) => v,
                Some(Err(e)) => {
                    if e.status == Some(404) {
                        return Ok(());
                    }
                    return Err(e);
                }
                None => match self.hub.sessions().await {
                    Ok(v) => v,
                    Err(e) if e.status == Some(404) => return Ok(()),
                    Err(e) => return Err(e),
                },
            };
            let list = list["sessions"].as_array().cloned().unwrap_or_default();
            let mut ch = Change::default();
            let before: HashSet<String> = c.session_ids().into_iter().collect();
            let mut todo: Vec<String> = vec![];
            for s in &list {
                let Some(sid) = s["session_id"].as_str().filter(|x| crypto::is_hex(x, 32)) else { continue };
                if let Some(known) = c.session_keys.get(sid) {
                    if let Some(n) = s["last_grant_number"].as_u64() {
                        if n <= known.state.grant_number as u64 {
                            continue;
                        }
                    }
                }
                todo.push(sid.to_string());
            }
            let bundle = self.session_bundle(&todo, todo.len() == list.len()).await?;
            let me = self.me();
            for sid in &todo {
                let known = c.session_keys.get(sid).cloned();
                let b = bundle.as_ref().and_then(|m| m.get(sid)).cloned();
                let fresh: Vec<String> = match &bundle {
                    Some(_) => b.as_ref().and_then(|b| b["signed_grants"].as_array().cloned()).unwrap_or_default().into_iter().filter_map(|g| g.as_str().map(String::from)).skip(known.as_ref().map(|k| k.state.grant_number as usize + 1).unwrap_or(0)).collect(),
                    None => self.hub.session_grants(sid, known.as_ref().map(|k| k.state.grant_number as i64).unwrap_or(-1)).await?["signed_grants"].as_array().cloned().unwrap_or_default().into_iter().filter_map(|g| g.as_str().map(String::from)).collect(),
                };
                if fresh.is_empty() && known.is_some() {
                    continue;
                }
                let mut state = known.as_ref().map(|k| k.state.clone());
                let mut grants = known.as_ref().map(|k| k.grants.clone()).unwrap_or_default();
                let mut failed = None;
                for g in &fresh {
                    let bytes = match unb64u(g) {
                        Ok(b) => b,
                        Err(e) => {
                            failed = Some(e);
                            break;
                        }
                    };
                    let applied = match G::apply_grant(state.as_ref(), &bytes, &c.state) {
                        Err(e) if e.code == "log-behind" => {
                            self.refresh_members(c, false, None).await?;
                            G::apply_grant(state.as_ref(), &bytes, &c.state)
                        }
                        r => r,
                    };
                    match applied {
                        Ok(s) => {
                            state = Some(s);
                            grants.push(g.clone());
                        }
                        Err(e) => {
                            failed = Some(e);
                            break;
                        }
                    }
                }
                if let Some(e) = failed {
                    c.model.push_alert(&mut ch, if e.code.is_empty() { "bad-grant" } else { &e.code }, &format!("session {}: {}", &sid[..8], e.text()), None, None, "local");
                    continue;
                }
                let Some(state) = state else { continue };
                let mut k = known.clone().unwrap_or(SessionKeys { state: state.clone(), grants: vec![], secrets: BTreeMap::new(), since: None });
                if known.as_ref().is_some_and(|k| k.state.epoch != state.epoch) {
                    k.since = Some(now_ms());
                }
                k.state = state.clone();
                k.grants = grants;
                c.session_keys.insert(sid.clone(), k);
                let holds = c.is_human() || state.agent_ids.contains(&me);
                if holds && !c.session_keys[sid].secrets.contains_key(&state.epoch) {
                    let wraps = match &b {
                        Some(b) => b["sealed_session_keys"].as_array().cloned().unwrap_or_default(),
                        None => self.hub.sealed_session_keys(sid, 0).await?["sealed_session_keys"].as_array().cloned().unwrap_or_default(),
                    };
                    for w in wraps {
                        let ep = w["session_key_epoch"].as_u64().unwrap_or(0) as u32;
                        if c.session_keys[sid].secrets.contains_key(&ep) {
                            continue;
                        }
                        let opened = unb64u(w["key_sealed"].as_str().unwrap_or("")).and_then(|sealed| G::unwrap_session_key(&c.state.room_id, &state, &self.device, &sealed, ep));
                        match opened {
                            Ok(s) => {
                                c.session_keys.get_mut(sid).unwrap().secrets.insert(ep, s);
                                if c.missing_keys.contains(&format!("{sid}:{ep}")) {
                                    c.need_resync = true;
                                }
                            }
                            Err(e) => c.model.push_alert(&mut ch, if e.code.is_empty() { "bad-key" } else { &e.code }, &format!("session key {}/{ep}: {}", &sid[..8], e.text()), None, None, "local"),
                        }
                    }
                    let links = b.as_ref().and_then(|b| b.get("key_back_links")).cloned().filter(|v| !v.is_null());
                    let _ = self.walk_session_back_links(c, sid, links).await;
                }
                let k = c.session_keys[sid].clone();
                c.model.apply_session_grant(&k.state, &mut ch, &k.ever_agents(), Some(k.epoch_agents()));
            }
            self.save_room(c)?;
            c.model.project(&mut ch);
            c.mark_dirty(&ch, &[]);
            if !c.is_human() {
                let now_ids = c.session_ids();
                let new: Vec<String> = now_ids.into_iter().filter(|s| !before.contains(s)).collect();
                if !new.is_empty() {
                    self.session_notify.notify_waiters();
                    for sid in new {
                        self.emit(ClientEvent::Session { session_id: sid });
                    }
                    if let Some(me) = self.arc() {
                        tokio::spawn(async move {
                            if let Err(e) = me.send_device_register().await {
                                me.emit(ClientEvent::Error(e));
                            }
                        });
                    }
                }
            }
            Ok(())
        })
    }

    /// Grants, own sealed keys and back links of these sessions, in requests of 64; None from a hub without the route.
    async fn session_bundle(&self, ids: &[String], all: bool) -> Result<Option<HashMap<String, Value>>> {
        if ids.is_empty() {
            return Ok(Some(HashMap::new()));
        }
        let mut out = HashMap::new();
        let parts: Vec<Option<Vec<String>>> = if all { vec![None] } else { ids.chunks(64).map(|c| Some(c.to_vec())).collect() };
        for p in parts {
            match self.hub.session_bundle(p.as_deref()).await {
                Ok(a) => {
                    for x in a["sessions"].as_array().cloned().unwrap_or_default() {
                        if let Some(sid) = x["session_id"].as_str() {
                            out.insert(sid.to_string(), x.clone());
                        }
                    }
                }
                Err(e) if e.status == Some(404) || e.status == Some(405) => return Ok(None),
                Err(e) => return Err(e),
            }
        }
        Ok(Some(out))
    }

    async fn walk_session_back_links(&self, c: &mut Core, sid: &str, prefetched: Option<Value>) -> Result<()> {
        let k = c.session_keys.get(sid).cloned().unwrap();
        let Some(mut low) = k.secrets.keys().min().copied() else { return Ok(()) };
        if low <= 1 || k.secrets.get(&low).and_then(|s| s.hist).is_none() {
            return Ok(());
        }
        let r = match prefetched {
            Some(p) => json!({ "key_back_links": p }),
            None => self.hub.session_back_links(sid).await?,
        };
        let links: HashMap<u32, Vec<u8>> = r["key_back_links"].as_array().cloned().unwrap_or_default().iter().filter_map(|l| Some((l["session_key_epoch"].as_u64()? as u32, unb64u(l["key_back_link"].as_str()?).ok()?))).collect();
        while low > 1 && links.contains_key(&low) && c.session_keys[sid].secrets.get(&low).and_then(|s| s.hist).is_some() {
            let s = c.session_keys[sid].secrets[&low].clone();
            let prev = G::open_session_back_link(&c.state.room_id, &c.session_keys[sid].state, &s, &links[&low])?;
            let pe = prev.epoch;
            c.session_keys.get_mut(sid).unwrap().secrets.insert(pe, prev);
            if c.missing_keys.contains(&format!("{sid}:{pe}")) {
                c.need_resync = true;
            }
            low = pe;
        }
        Ok(())
    }

    /// One session refresh in the queue at a time (a burst of grant events is one refresh).
    pub fn queue_session_refresh(&self) {
        let Some(me) = self.arc() else { return };
        tokio::spawn(async move {
            let mut c = me.core.lock().await;
            if let Err(e) = me.refresh_sessions(&mut c, None).await {
                me.local_alert(&mut c, "sessions", &e);
            }
            if c.need_resync {
                if let Err(e) = Box::pin(me.resync(&mut c)).await {
                    me.local_alert(&mut c, "resync", &e);
                }
            }
            let _ = me.flush(&mut c);
        });
    }

    pub fn local_alert(&self, c: &mut Core, where_: &str, e: &ZError) {
        let mut ch = Change::default();
        let code = if e.code.is_empty() { where_.to_string() } else { e.code.clone() };
        c.model.push_alert(&mut ch, &code, &format!("{where_}: {}", e.text()), None, None, "local");
    }

    // ---- the stream ---------------------------------------------------------------------------------------------

    pub fn restart_stream(&self) {
        self.stream_stop.notify_waiters();
        self.open_stream();
    }

    pub fn open_stream(&self) {
        let Some(me) = self.arc() else { return };
        let w = Arc::downgrade(&me);
        drop(me);
        self.spawn(async move {
            let mut backoff = 500u64;
            let mut reauth = 0;
            loop {
                let Some(c) = w.upgrade() else { break };
                if !c.started.load(Ordering::SeqCst) {
                    break;
                }
                c.set_connection("connecting").await;
                if std::env::var("CORE_DEBUG").is_ok() { eprintln!("[stream] {} connecting", now_ms() % 100000); }
                let generation = c.hub.lease_generation();
                let cursor = c.core.lock().await.model.room.last_envelope_number;
                let mut healthy = false;
                let mut closed = false;
                let res = c.hub.open_stream(cursor).await;
                let outcome: Result<()> = async {
                    let res = res?;
                    let status = res.status().as_u16();
                    if status == 426 {
                        let e = ZError::new("client-too-old", "this client is too old for the hub: update it").status(426);
                        c.on_too_old(e.clone()).await;
                        closed = true;
                        return Err(e);
                    }
                    if status == 401 {
                        c.hub.clear_token();
                        reauth += 1;
                        if reauth <= 2 {
                            return Ok(());
                        }
                        return Err(ZError::new("unauthorised", "stream sign-in"));
                    }
                    if !(200..300).contains(&status) {
                        let err: Value = res.json().await.unwrap_or(json!({}));
                        let e = ZError::new(err["error"].as_str().map(String::from).unwrap_or_else(|| format!("http-{status}")), err["message"].as_str().unwrap_or("stream refused")).status(status);
                        if e.code == "lease-lost" && c.hub.lease_generation() == generation {
                            closed = true;
                            c.on_lease_lost(e.clone());
                        }
                        return Err(e);
                    }
                    reauth = 0;
                    c.stream_open.store(true, Ordering::SeqCst);
                    c.on_stream_open().await;
                    let mut body = res.bytes_stream();
                    let mut buf: Vec<u8> = vec![];
                    loop {
                        let next = tokio::select! {
                            n = tokio::time::timeout(Duration::from_millis(70_000), body.next()) => n,
                            _ = c.stream_stop.notified() => { closed = true; break }
                        };
                        let chunk = match next {
                            Err(_) => return Err(ZError::new("offline", "stream went silent").status(0)),
                            Ok(None) => break,
                            Ok(Some(Err(e))) => return Err(ZError::new("offline", e.to_string()).status(0)),
                            Ok(Some(Ok(b))) => b,
                        };
                        buf.extend_from_slice(&chunk);
                        while let Some(at) = find_double_newline(&buf) {
                            let block = String::from_utf8_lossy(&buf[..at]).to_string();
                            buf.drain(..at + 2);
                            let (event, data) = parse_sse(&block);
                            healthy = true;
                            backoff = 500;
                            if event == "upgrade_required" {
                                let e = ZError::new("client-too-old", "the hub asks for a newer client");
                                c.on_too_old(e).await;
                                closed = true;
                                break;
                            }
                            c.on_stream_event(&event, data).await?;
                            if !c.started.load(Ordering::SeqCst) {
                                closed = true;
                                break;
                            }
                        }
                        if closed {
                            break;
                        }
                    }
                    Ok(())
                }
                .await;
                c.stream_open.store(false, Ordering::SeqCst);
                {
                    let mut core = c.core.lock().await;
                    core.live_from = None;
                    if core.model.room.connection != "removed" {
                        core.model.room.connection = "connecting".into();
                    }
                    if let Err(e) = &outcome {
                        if e.status.is_some_and(|s| s >= 400 && s != 401) {
                            c.local_alert(&mut core, "stream", e);
                        }
                    }
                }
                if std::env::var("CORE_DEBUG").is_ok() { eprintln!("[stream] {} outcome {:?}", now_ms() % 100000, outcome.as_ref().err().map(|e| e.text())); }
                if let Err(e) = &outcome {
                    if e.code == "client-too-old" {
                        closed = true;
                    }
                    if e.status == Some(403) {
                        let c2 = c.clone();
                        tokio::spawn(async move {
                            let mut core = c2.core.lock().await;
                            let _ = c2.learn_removal(&mut core, None).await;
                        });
                    }
                }
                if closed || !c.started.load(Ordering::SeqCst) || c.core.lock().await.model.room.connection == "removed" {
                    break;
                }
                let wait = if healthy { 250 } else { backoff };
                backoff = (backoff * 2).min(2000);
                let hub = c.hub.clone();
                drop(c);
                tokio::select! {
                    _ = sleep(wait + crate::transport::rand_ms(500)) => {},
                    _ = hub.wake.notified() => {},
                }
            }
        });
    }

    async fn on_stream_open(&self) {
        {
            let mut c = self.core.lock().await;
            if c.live_from.is_none() {
                c.live_from = Some(now_ms());
            }
            c.model.room.connection = "live".into();
        }
        if let Some(me) = self.arc() {
            tokio::spawn(async move {
                let _ = me.refresh_devices(None, false).await;
                let mut c = me.core.lock().await;
                if let Err(e) = me.refresh_members(&mut c, false, None).await {
                    me.local_alert(&mut c, "sessions", &e);
                }
                drop(c);
                me.queue_session_refresh();
            });
        }
    }

    async fn on_stream_event(&self, event: &str, data: Value) -> Result<()> {
        match event {
            "envelope" => {
                let n = data["envelope_number"].as_u64().unwrap_or(0);
                let cur = self.core.lock().await.model.room.last_envelope_number;
                if n <= cur {
                    return Ok(());
                }
                if n > cur + 1 {
                    self.catch_up().await?;
                }
                let cur = self.core.lock().await.model.room.last_envelope_number;
                if n == cur + 1 {
                    self.process_records(vec![data], true).await?;
                }
            }
            "member_entry" => {
                {
                    let mut c = self.core.lock().await;
                    self.refresh_members(&mut c, false, None).await?;
                }
                let _ = self.refresh_devices(None, false).await;
            }
            "presence" => {
                if data["device_id"].is_string() {
                    self.refresh_devices(Some(json!({ "devices": [data] })), true).await?;
                }
            }
            "session_grant" => {
                let known = {
                    let c = self.core.lock().await;
                    let sid = data["session_id"].as_str().unwrap_or("");
                    c.session_keys.get(sid).is_some_and(|k| data["grant_number"].as_u64().is_some_and(|g| g <= k.state.grant_number as u64))
                };
                if !known {
                    self.queue_session_refresh();
                }
            }
            _ => {}
        }
        Ok(())
    }

    // ---- the sync engine -------------------------------------------------------------------------------------------

    /// Page through GET envelopes from the cursor to the hub's end.
    pub async fn catch_up(&self) -> Result<()> {
        loop {
            let cur = self.core.lock().await.model.room.last_envelope_number;
            let r = self.hub.envelopes(cur, PAGE, false).await?;
            let envs = r["envelopes"].as_array().cloned().unwrap_or_default();
            let last = r["last_envelope_number"].as_u64().unwrap_or(0);
            if envs.is_empty() {
                if last > cur {
                    let mut c = self.core.lock().await;
                    self.gap_seen(&mut c);
                    if c.need_resync {
                        if let Err(e) = Box::pin(self.resync(&mut c)).await {
                            self.local_alert(&mut c, "resync", &e);
                        }
                    }
                }
                break;
            }
            self.process_records(envs, false).await?;
            let now = self.core.lock().await.model.room.last_envelope_number;
            if now >= last || now == cur {
                break;
            }
        }
        Ok(())
    }

    /// Process records in hub order, then a resync if keys arrived for envelopes seen unopened.
    pub async fn process_records(&self, records: Vec<Value>, live: bool) -> Result<()> {
        let mut c = self.core.lock().await;
        self.process_batch(&mut c, &records, live).await?;
        if c.need_resync {
            Box::pin(self.resync(&mut c)).await?;
        }
        Ok(())
    }

    pub async fn process_batch(&self, c: &mut Core, records: &[Value], live: bool) -> Result<()> {
        c.live_batch = live && !c.resyncing;
        let mut ch = Change::default();
        let mut tl: Vec<Rec> = vec![];
        let mut commands: Vec<PendingCmd> = vec![];
        let mut holes = false;
        let todo: Vec<&Value> = records.iter().filter(|r| r["envelope_number"].as_u64().unwrap_or(0) > c.model.room.last_envelope_number).collect();
        for r in todo {
            let n = r["envelope_number"].as_u64().unwrap_or(0);
            let mut pre = self.precheck(c, r, false);
            if pre.need_keys {
                if let Err(e) = self.refresh_sessions(c, None).await {
                    self.local_alert(c, "sessions", &e);
                }
                pre = self.precheck(c, r, true);
            }
            if n > c.model.room.last_envelope_number + 1 {
                if c.resyncing {
                    c.gap_in_resync = true;
                } else {
                    holes = true;
                }
            }
            match self.commit(c, pre).await {
                Ok(rec) => {
                    if let Some(mut rec) = rec {
                        if rec.object.is_some() && (rec.kind == codec::KIND_OBJECT_VERSION || rec.kind == codec::KIND_PERMISSION_REQUEST) {
                            rec.object_id_ok = Some(hex(&crypto::object_id_of(&unhex(&rec.sender_device_id).unwrap(), rec.sender_sequence)) == rec.object.unwrap().object_id());
                        }
                        let cmd = if c.model.room.my_role == "agent" { self.pre_authorise(c, &rec) } else { None };
                        let result = c.model.apply_record(&rec, &mut ch);
                        if rec.kind == codec::KIND_TIMELINE_ITEM && result.applied {
                            tl.push(rec.clone());
                        }
                        if let Some(mut cmd) = cmd {
                            if cmd.refused.is_none() && rec.is_head && !result.applied {
                                cmd.refused = result.refused.clone();
                            }
                            commands.push(cmd);
                        }
                    }
                }
                Err(e) => {
                    if is_transient(&e) || e.code == "log-behind" {
                        if e.code == "log-behind" && c.behind_alerted != Some(n) {
                            c.behind_alerted = Some(n);
                            c.model.push_alert(&mut ch, "log-behind", &format!("envelope {n} names a member list entry the hub does not show ({}): held back and read again", e.text()), Some(n), None, "local");
                        }
                        self.schedule_catch_up(if e.code == "log-behind" { 5000 } else { 1500 });
                        break;
                    }
                    if e.code == "newer-version" {
                        c.model.note_newer(&mut ch, "envelope format", n);
                        c.model.push_alert(&mut ch, "needs-update", &format!("envelope {n}: {}", codec::UPDATE_MESSAGE), Some(n), None, "local");
                    } else {
                        c.model.push_alert(&mut ch, if e.code.is_empty() { "internal" } else { &e.code }, &e.text(), Some(n), None, "local");
                    }
                    if e.code == "gap" || REREAD_ON.contains(&e.code.as_str()) {
                        if c.resyncing {
                            c.gap_in_resync = true;
                        } else {
                            self.gap_seen(c);
                        }
                    }
                }
            }
            c.model.room.last_envelope_number = n;
        }
        ch.room = true;
        c.model.project(&mut ch);
        c.mark_dirty(&ch, &tl);
        self.flush(c)?;
        if !commands.is_empty() {
            self.deliver_commands(c, commands).await;
        }
        if !c.is_human() {
            self.reassert_refused_locked(c);
        }
        self.check_missed_echoes(c);
        if holes {
            self.gap_seen(c);
        }
        Ok(())
    }

    /// An own envelope the hub acknowledged at a number the cursor passed without it coming back: read the room again.
    pub fn check_missed_echoes(&self, c: &mut Core) {
        if c.resyncing || c.by_hash.is_empty() {
            return;
        }
        let last = c.model.room.last_envelope_number;
        if c.recent_sent.iter().any(|it| it.envelope_number().is_some_and(|n| n <= last) && c.by_hash.contains_key(&it.hash())) {
            self.gap_seen(c);
        }
    }
    pub fn gap_seen(&self, c: &mut Core) {
        let wait = c.gap_backoff;
        let since = now_ms().saturating_sub(c.last_gap_resync);
        if since >= wait {
            c.last_gap_resync = now_ms();
            c.gap_backoff = (wait * 2).min(600_000);
            c.need_resync = true;
            return;
        }
        let Some(me) = self.arc() else { return };
        tokio::spawn(async move {
            sleep(wait - since).await;
            if !me.started.load(Ordering::SeqCst) {
                return;
            }
            let mut c = me.core.lock().await;
            c.last_gap_resync = now_ms();
            c.gap_backoff = (c.gap_backoff * 2).min(600_000);
            if let Err(e) = Box::pin(me.resync(&mut c)).await {
                me.local_alert(&mut c, "resync", &e);
            }
        });
    }
    fn schedule_catch_up(&self, ms: u64) {
        let Some(me) = self.arc() else { return };
        tokio::spawn(async move {
            sleep(ms).await;
            if me.started.load(Ordering::SeqCst) && me.catch_up().await.is_err() {
                me.schedule_catch_up(5000);
            }
        });
    }

    /// Replay the room from the start, verifying everything again; the own chain for sealing is kept aside.
    pub fn resync<'a>(&'a self, c: &'a mut Core) -> BoxFut<'a, Result<()>> {
        Box::pin(async move {
            c.need_resync = false;
            let me = b64u(&self.device.id);
            let own = c.chains.get(&me).cloned();
            let mut m = Model::new();
            m.room = c.model.room.clone();
            m.room.last_envelope_number = 0;
            m.members = std::mem::take(&mut c.model.members);
            m.device_registers = std::mem::take(&mut c.model.device_registers);
            m.alerts = std::mem::take(&mut c.model.alerts);
            let mut ch = Change::default();
            let keys: Vec<SessionKeys> = c.session_keys.values().cloned().collect();
            for k in &keys {
                m.apply_session_grant(&k.state, &mut ch, &k.ever_agents(), Some(k.epoch_agents()));
            }
            c.model = m;
            c.chains = Chains::new();
            c.frontiers = HashMap::new();
            c.missing_keys = HashSet::new();
            c.gap_in_resync = false;
            c.resyncing = true;
            let res: Result<()> = async {
                loop {
                    let at = c.model.room.last_envelope_number;
                    let r = self.hub.envelopes(at, PAGE, false).await?;
                    let envs = r["envelopes"].as_array().cloned().unwrap_or_default();
                    if envs.is_empty() {
                        break;
                    }
                    self.process_batch(c, &envs, false).await?;
                    let now = c.model.room.last_envelope_number;
                    if now >= r["last_envelope_number"].as_u64().unwrap_or(0) || now == at {
                        break;
                    }
                }
                Ok(())
            }
            .await;
            if res.is_err() {
                c.gap_in_resync = true;
            }
            c.resyncing = false;
            if !c.gap_in_resync {
                c.gap_backoff = 2000;
            } else if let Some(me2) = self.arc() {
                let wait = c.gap_backoff;
                tokio::spawn(async move {
                    sleep(wait).await;
                    if !me2.started.load(Ordering::SeqCst) {
                        return;
                    }
                    let mut c = me2.core.lock().await;
                    c.last_gap_resync = now_ms();
                    c.gap_backoff = (c.gap_backoff * 2).min(600_000);
                    if let Err(e) = Box::pin(me2.resync(&mut c)).await {
                        me2.local_alert(&mut c, "resync", &e);
                    }
                });
            }
            if let Some(o) = own {
                c.chains.insert(me.clone(), o);
            }
            c.dirty_chains.insert(me);
            res?;
            let mut ch = Change::default();
            c.model.project(&mut ch);
            ch.cards = c.model.cards.keys().cloned().collect();
            ch.sessions = c.model.sessions.keys().cloned().collect();
            ch.permissions = c.model.permissions.keys().cloned().collect();
            ch.published = c.model.published.keys().cloned().collect();
            ch.timelines = c.model.timelines.keys().cloned().collect();
            c.mark_dirty(&ch, &[]);
            self.flush(c)?;
            Ok(())
        })
    }

    /// Phase 1: everything that does not depend on the sender's chain (an empty chain map, nothing advances).
    pub fn precheck(&self, c: &Core, r: &Value, retried: bool) -> Pre {
        let n = r["envelope_number"].as_u64().unwrap_or(0);
        let is_void = r["void"].as_bool().unwrap_or(false);
        let mut pre = Pre {
            envelope_number: n, bytes: vec![], peek: None, hash: None, opened: None, content_state: "ok".into(), error: None, void: is_void,
            void_code: if is_void { r["void_code"].as_str().map(String::from) } else { None }, stale: false, missing_key: None, need_keys: false,
        };
        let bytes = match unb64u(r["envelope"].as_str().unwrap_or("")) {
            Ok(b) => b,
            Err(e) => {
                pre.error = Some(e);
                return pre;
            }
        };
        pre.bytes = bytes.clone();
        let peek = match crypto::peek_envelope(&bytes) {
            Ok(p) => p,
            Err(e) => {
                pre.error = Some(e);
                return pre;
            }
        };
        let h = peek.header.clone();
        let pruned = peek.pruned;
        pre.peek = Some(peek);
        if hex(&h.sender) == self.me() && !c.resyncing {
            return pre;
        }
        if !pre.void {
            pre.stale = c.is_stale(&h, self.started.load(Ordering::SeqCst));
        }
        let opts = crypto::VerifyOpts { allow_chain_start: true, allow_removed_sender: true, commit: false, freshness: None, strict_kinds: false };
        let mut scratch = Chains::new();
        if !pruned {
            let secrets = |hd: &Header| c.open_key(hd);
            match crypto::open_envelope(&bytes, &c.state, &mut scratch, &secrets, Some(&self.device.id), &opts, true) {
                Ok(o) => {
                    pre.hash = Some(o.v.hash);
                    if let Some(q) = &o.quarantined {
                        pre.content_state = if q == "newer-version" { "newer_schema".into() } else { "undecryptable".into() };
                    } else {
                        pre.opened = Some((o.bind, o.payload));
                    }
                }
                Err(e) => {
                    if e.code == "no-key" && e.extra.get("keyScope").and_then(|v| v.as_u64()) == Some(1) && !retried {
                        pre.need_keys = true;
                    }
                    if !["no-key", "decrypt-failed", "kind-mismatch", "bad-format", "bad-version"].contains(&e.code.as_str()) {
                        pre.error = Some(e);
                        return pre;
                    }
                    if e.code == "no-key" {
                        pre.missing_key = Some(if e.extra.get("keyScope").and_then(|v| v.as_u64()) == Some(1) {
                            format!("{}:{}", e.extra.get("sessionId").and_then(|v| v.as_str()).unwrap_or(""), e.extra.get("epoch").and_then(|v| v.as_u64()).unwrap_or(0))
                        } else {
                            format!("room:{}", e.extra.get("epoch").and_then(|v| v.as_u64()).unwrap_or(0))
                        });
                    }
                    match crypto::verify_envelope(&bytes, &c.state, &mut scratch, &opts) {
                        Ok(v) => {
                            pre.hash = Some(v.hash);
                            pre.content_state = "undecryptable".into();
                        }
                        Err(e) => pre.error = Some(e),
                    }
                }
            }
        } else {
            match crypto::verify_envelope(&bytes, &c.state, &mut scratch, &opts) {
                Ok(v) => {
                    pre.hash = Some(v.hash);
                    pre.content_state = if h.is_head { "pruned".into() } else { "header".into() };
                }
                Err(e) => pre.error = Some(e),
            }
        }
        pre
    }

    /// Phase 2, strictly in hub order: the sender's chain and own envelopes. Returns the reducer record, or None.
    async fn commit(&self, c: &mut Core, mut pre: Pre) -> Result<Option<Rec>> {
        if pre.error.as_ref().is_some_and(|e| e.code == "log-behind") {
            self.refresh_members(c, false, None).await?;
            let r = json!({ "envelope_number": pre.envelope_number, "envelope": b64u(&pre.bytes), "void": pre.void, "void_code": pre.void_code });
            pre = self.precheck(c, &r, false);
        }
        if let Some(e) = pre.error.take() {
            return Err(e);
        }
        let peek = pre.peek.take().unwrap();
        let h = peek.header.clone();
        let sender = hex(&h.sender);
        let key = b64u(&h.sender);
        if sender == self.me() && !c.resyncing {
            let known = c.chains.get(&key).and_then(|ch| ch.hashes.get(&h.seq)).copied();
            let Some(known) = known else {
                return Err(ZError::new("equivocation", format!("an envelope in this device's name that it did not send (#{})", h.seq)));
            };
            if c.frontiers.get(&sender).and_then(|f| f.get(&sender)).copied().unwrap_or(0) >= h.seq {
                return Ok(None);
            }
            let kh = hex(&known);
            let local_id = c.by_hash.get(&kh).cloned();
            if pre.void {
                if !c.voided_own.contains(&kh) && local_id.is_some() {
                    self.local_alert(c, "hub-voided", &ZError::new("hub-voided", format!("the hub voided envelope #{} after accepting it", h.seq)));
                }
                c.by_hash.remove(&kh);
                c.sent_content.remove(&kh);
                return Ok(None);
            }
            let (hash, opened, cs) = if !peek.pruned {
                let secrets = |hd: &Header| c.open_key(hd);
                let (_hd, hash, bind, payload, _) = crypto::open_verified_envelope(&pre.bytes, &c.state, &secrets, &known, Some(&self.device.id))?;
                (hash, Some((Some(bind), Some(payload))), "ok".to_string())
            } else {
                let got = crypto::hash(crypto::label::ENVELOPE, &[&peek.header_bytes, &peek.nonce, &peek.ciphertext_hash.unwrap()]);
                if got != known {
                    return Err(ZError::new("equivocation", format!("the hub shows another envelope #{} in this device's name", h.seq)));
                }
                (known, None, if h.is_head { "pruned".to_string() } else { "header".to_string() })
            };
            let mut rec = self.record(c, pre.envelope_number, &h, hash, opened, &cs, local_id);
            if let Some(sent) = c.sent_content.remove(&rec.envelope_hash) {
                if rec.content.is_none() {
                    rec.content = Some(sent);
                    rec.content_state = "ok".into();
                }
            }
            return Ok(Some(rec));
        }
        let hash = pre.hash.unwrap();
        // F11: a session envelope the grants this device knows do not cover yet: fetch the grants first.
        if h.key_scope == 1 {
            if let Some(sid) = h.session_id.map(|s| hex(&s)) {
                let k = c.session_keys.get(&sid);
                let role = c.state.member(&h.sender).map(|m| m.role);
                let covered = k.is_some_and(|k| h.epoch <= k.state.epoch && (role != Some(crypto::ROLE_AGENT) || k.epoch_agents().get(&h.epoch.to_string()).is_some_and(|a| a.contains(&sender))));
                let mark = format!("{sid}:{}:{}", h.epoch, k.map(|k| k.grants.len()).unwrap_or(0));
                if !covered && !c.grant_tried.contains(&mark) {
                    self.refresh_sessions(c, None).await?;
                    c.grant_tried.insert(mark);
                }
            }
        }
        match c.chains.get(&key) {
            None => {
                if h.seq != 1 {
                    return Err(ZError::new("gap", format!("first envelope seen from this sender has number {}", h.seq)).with("have", 0).with("got", h.seq));
                }
                if !crypto::is_zero(&h.prev) {
                    return Err(ZError::new("chain-break", "the first envelope names a predecessor"));
                }
            }
            Some(chain) => {
                if h.seq <= chain.seq {
                    if let Some(k) = chain.hashes.get(&h.seq) {
                        if *k != hash {
                            return Err(ZError::new("equivocation", format!("two different envelopes with number {} from one sender", h.seq)));
                        }
                    }
                    return Ok(None);
                } else if h.seq > chain.seq + 1 {
                    return Err(ZError::new("gap", format!("envelope {} arrived, {} is missing", h.seq, chain.seq + 1)).with("have", chain.seq).with("got", h.seq));
                } else if h.prev != chain.hash {
                    return Err(ZError::new("chain-break", "the predecessor hash does not match the envelope accepted before"));
                }
            }
        }
        for s in &h.seen {
            if let Some(k) = c.chains.get(&b64u(&s.sender)).and_then(|ch| ch.hashes.get(&s.seq)) {
                if *k != s.hash {
                    return Err(ZError::new("equivocation", "the sender saw a different envelope than this device under the same number"));
                }
            }
        }
        let ch = c.chains.entry(key.clone()).or_default();
        ch.seq = h.seq;
        ch.hash = hash;
        ch.hashes.insert(h.seq, hash);
        trim_chain(ch);
        c.dirty_chains.insert(key);
        let own_local = if sender == self.me() { c.by_hash.get(&hex(&hash)).cloned() } else { None };
        if pre.void && sender == self.me() {
            c.by_hash.remove(&hex(&hash));
            c.sent_content.remove(&hex(&hash));
        }
        if pre.void {
            c.advance_frontier(&sender, &h);
            if !c.void_plausible(&h, pre.void_code.as_deref()) {
                let mut chg = Change::default();
                c.model.push_alert(&mut chg, "hub-voided-other", &format!("the hub withheld envelope #{} of this sender as void ({})", h.seq, pre.void_code.as_deref().unwrap_or("no reason")), Some(pre.envelope_number), Some(&sender), "local");
            }
            return Ok(None);
        }
        if pre.stale || c.stale_hashes.contains(&hex(&hash)) {
            c.remember_stale(hex(&hash));
            c.advance_frontier(&sender, &h);
            let mut chg = Change::default();
            c.model.push_alert(&mut chg, "wrong-epoch", &format!("envelope #{} was sent in an outdated key epoch: ignored", h.seq), Some(pre.envelope_number), Some(&sender), "local");
            return Ok(None);
        }
        let opened = pre.opened.take();
        let cs = pre.content_state.clone();
        Ok(Some(self.record(c, pre.envelope_number, &h, hash, opened, &cs, own_local)))
    }

    fn record(&self, c: &mut Core, envelope_number: u64, h: &Header, hash: [u8; 32], opened: Option<(Option<Vec<u8>>, Option<Vec<u8>>)>, content_state: &str, local_id: Option<String>) -> Rec {
        let sender = hex(&h.sender);
        c.advance_frontier(&sender, h);
        let mut content = None;
        let mut cs = content_state.to_string();
        let mut bind = None;
        let mut raw_bind = None;
        if let Some((b, p)) = opened {
            if let Some(p) = p {
                let (ct, s) = decode_opened(&p, h);
                content = ct;
                cs = s;
            }
            if let Some(b) = b {
                bind = codec::decode_bind_for(h.kind, &b);
                raw_bind = Some(b);
            }
        }
        let mut lamport = model::lamport_of(content.as_ref());
        let claimed = content.as_ref().and_then(|c| c.get("lamport")).and_then(|v| v.as_f64()).filter(|x| *x > 0.0).unwrap_or(0.0);
        if claimed > 0.0 && !(lamport > 0 && model::lamport_accepted(lamport, c.lamport)) {
            let mut chg = Change::default();
            let seen = c.lamport;
            c.model.push_alert(&mut chg, "lamport-inflated", &format!("a write claims lamport {claimed}, far above {seen}: ignored"), Some(envelope_number), Some(&sender), "local");
            lamport = 0;
        }
        if lamport > c.lamport {
            c.lamport = lamport;
        }
        let member_role = c.state.member(&h.sender).map(|m| role_name(m.role).to_string()).unwrap_or_else(|| "unknown".into());
        let hash_hex = hex(&hash);
        if let Some(l) = &local_id {
            let _ = l;
            c.by_hash.remove(&hash_hex);
        }
        Rec {
            envelope_number, envelope_hash: hash_hex, sender_device_id: sender.clone(), sender_role: member_role,
            recipient_device_id: if crypto::is_zero(&h.recipient) { None } else { Some(hex(&h.recipient)) }, sent_at: h.time, kind: h.kind, is_head: h.is_head,
            object: h.card.map(|cb| model::ObjRef { object_state: cb.state, urgency: cb.urgency, answered_at: cb.answered_at, id: cb.id }),
            timeline_kind: h.timeline_kind.map(codec::timeline_kind_name), timeline_id: h.timeline_id.clone(),
            session_id: if h.key_scope == 1 { h.session_id.map(|s| hex(&s)) } else { None },
            attachment_ids: h.blobs.iter().map(|b| hex(b)).collect(), content, content_state: cs, bind, local_id,
            causal: model::Causal { sender_device_id: sender, sender_sequence: h.seq, sent_at: h.time, lamport, no_body: false },
            sender_sequence: h.seq, header: h.clone(), raw_bind, epoch: h.epoch, object_id_ok: None, newer_content: None,
        }
    }

    // ---- persistence ----------------------------------------------------------------------------------------------

    /// Write everything dirty in one journal line, with the cursor and the touched chains.
    pub fn flush(&self, c: &mut Core) -> Result<()> {
        let mut entries: Vec<(String, Option<Value>)> = std::mem::take(&mut c.dirty_records).into_iter().map(|(k, v)| (k, Some(v))).collect();
        for k in std::mem::take(&mut c.dirty_chains) {
            if let Some(ch) = c.chains.get(&k) {
                entries.push((format!("chain/{k}"), Some(chain_to_json(ch))));
            }
        }
        entries.retain(|(k, _)| k != "sync");
        entries.push(("sync".into(), Some(c.sync_record())));
        self.storage.set_many(entries)
    }

    /// The executed-command ledger (R4).
    pub async fn ledger_has(&self, h: &str) -> bool {
        self.core.lock().await.ledger.contains(h)
    }
    pub async fn ledger_mark(&self, h: &str) -> Result<()> {
        let mut c = self.core.lock().await;
        c.ledger.insert(h.to_string());
        if c.ledger.len() > 5000 {
            c.ledger.shift_remove_index(0);
        }
        let v: Vec<Value> = c.ledger.iter().map(|x| json!(x)).collect();
        self.storage.set("ledger", Value::Array(v))
    }
}

fn find_double_newline(b: &[u8]) -> Option<usize> {
    b.windows(2).position(|w| w == b"\n\n")
}
fn parse_sse(block: &str) -> (String, Value) {
    let mut event = "message".to_string();
    let mut data = String::new();
    for line in block.split('\n') {
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        let (field, val) = match line.find(':') {
            Some(i) => (&line[..i], line[i + 1..].strip_prefix(' ').unwrap_or(&line[i + 1..])),
            None => (line, ""),
        };
        match field {
            "event" => event = val.to_string(),
            "data" => {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(val);
            }
            _ => {}
        }
    }
    let v = if data.is_empty() { json!({}) } else { serde_json::from_str(&data).unwrap_or(json!({})) };
    (event, v)
}
