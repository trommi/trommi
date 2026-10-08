//! model.mjs: the board model and its reducer, as an agent device builds it. The records persisted per object
//! (`card/…`, `session/…`, `perm/…`, `pub/…`, `tlmeta/…`) have the JSON shape of the JS model, so a slot can be
//! taken over by either connector. Human registers and notes never apply on an agent (it holds no room key).
use crate::codec::{self, BindHex};
use crate::crypto::Header;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

pub const ALERTS_MAX: usize = 200;
pub const LAMPORT_MAX: u64 = 1 << 48;
pub const LAMPORT_STEP: u64 = 1 << 24;
pub const ASLEEP_MS: u64 = 10 * 60_000;

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Causal {
    pub sender_device_id: String,
    pub sender_sequence: u64,
    pub sent_at: u64,
    pub lamport: u64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub no_body: bool,
}
/// R2: (lamport, sender_device_id, sender_sequence), strictly lexicographic.
pub fn compare_writes(x: &Causal, y: &Causal) -> std::cmp::Ordering {
    x.lamport.cmp(&y.lamport).then(x.sender_device_id.cmp(&y.sender_device_id)).then(x.sender_sequence.cmp(&y.sender_sequence))
}
pub fn causally_after(x: Option<&Causal>, y: Option<&Causal>) -> bool {
    match (x, y) {
        (_, None) => true,
        (None, _) => false,
        (Some(x), Some(y)) => compare_writes(x, y).is_gt(),
    }
}
pub fn lamport_of(c: Option<&Map<String, Value>>) -> u64 {
    c.and_then(|c| c.get("lamport")).and_then(|v| v.as_f64()).filter(|n| n.fract() == 0.0 && *n > 0.0 && *n <= LAMPORT_MAX as f64).map(|n| n as u64).unwrap_or(0)
}
pub fn lamport_accepted(l: u64, seen: u64) -> bool {
    l > 0 && l <= seen + LAMPORT_STEP
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Newer {
    pub count: u64,
    pub what: Vec<String>,
    pub envelope_number: u64,
}

#[derive(Clone, Debug, Default)]
pub struct RoomInfo {
    pub room_id: String,
    pub hub_url: String,
    pub my_device_id: String,
    pub my_role: String,
    pub key_epoch: u32,
    pub last_entry_number: i64,
    pub last_envelope_number: u64,
    pub connection: String,
    pub agent_session_id: Option<String>,
    pub outbox_blocked: Option<Value>,
    pub replaced: bool,
}

#[derive(Clone, Debug, Default)]
pub struct MemberRow {
    pub device_id: String,
    pub device_role: String,
    pub device_name: String,
    pub platform: Value,
    pub folder: Value,
    pub host: Value,
    pub is_active: bool,
    pub added_entry_number: u32,
    pub removed_entry_number: Option<u32>,
    pub is_me: bool,
    pub is_online: bool,
    pub offline_since: Option<u64>,
    pub link: Option<Value>,
    pub agent_session_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct RegEntry {
    pub value: Value,
    pub envelope_number: u64,
    #[serde(default)]
    pub sender_sequence: u64,
    #[serde(default)]
    pub causal: Option<Causal>,
}
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct StatusLine {
    pub id: String,
    pub label: Value,
    pub state: Value,
    pub detail: Value,
    pub object_id: Value,
    pub envelope_number: u64,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Session {
    pub session_id: String,
    #[serde(default)]
    pub agent_device_ids: Vec<String>,
    #[serde(default)]
    pub ever_agent_ids: Vec<String>,
    #[serde(default)]
    pub epoch_agent_ids: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub agent_device_id: Option<String>,
    #[serde(default)]
    pub agent_session_id: Option<String>,
    #[serde(default)]
    pub device_name: String,
    #[serde(default = "yes")]
    pub is_active: bool,
    #[serde(default)]
    pub is_online: bool,
    #[serde(default)]
    pub offline_since: Option<u64>,
    #[serde(default)]
    pub link: Option<Value>,
    #[serde(default)]
    pub heard_up_to: Option<u64>,
    #[serde(default)]
    pub heard_at: Option<u64>,
    #[serde(default)]
    pub session_key_epoch: u32,
    #[serde(default)]
    pub with_history: bool,
    #[serde(default)]
    pub profile: Option<Value>,
    #[serde(default)]
    pub status_lines: Vec<StatusLine>,
    #[serde(default)]
    pub agent_alerts: Vec<Value>,
    #[serde(default)]
    pub registers: Vec<(String, RegEntry)>,
    #[serde(default)]
    pub settings: Option<Value>,
    #[serde(default)]
    pub card_ids: Vec<String>,
    #[serde(default)]
    pub open_card_ids: Vec<String>,
    #[serde(default)]
    pub timeline_key: String,
    #[serde(default)]
    pub last_activity_at: u64,
    #[serde(default)]
    pub created_by_agent: bool,
    #[serde(default)]
    pub creator_device_id: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}
fn yes() -> bool {
    true
}
impl Session {
    pub fn register(&self, key: &str) -> Option<&RegEntry> {
        self.registers.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
    fn set_register(&mut self, key: &str, e: RegEntry) {
        if let Some(slot) = self.registers.iter_mut().find(|(k, _)| k == key) {
            slot.1 = e;
        } else {
            self.registers.push((key.to_string(), e));
        }
    }
    pub fn profile_str(&self, k: &str) -> Option<String> {
        self.profile.as_ref().and_then(|p| p.get(k)).and_then(|v| v.as_str()).map(String::from)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Answer {
    pub answer_action: String,
    #[serde(default)]
    pub choices: Vec<Value>,
    #[serde(default)]
    pub note: Value,
    #[serde(default)]
    pub option_notes: Value,
    #[serde(default)]
    pub attachments: Value,
    #[serde(default)]
    pub marks: Value,
    #[serde(default)]
    pub trusted: bool,
    #[serde(default)]
    pub bound_version_hash: Option<String>,
    #[serde(default)]
    pub bound_object_version: u64,
    #[serde(default)]
    pub envelope_number: Option<u64>,
    #[serde(default)]
    pub envelope_hash: Option<String>,
    #[serde(default)]
    pub by_device_id: Option<String>,
    #[serde(default)]
    pub answered_at: u64,
    #[serde(default)]
    pub taken_back_at: Option<u64>,
    #[serde(default)]
    pub taken_back_sent_at: Option<u64>,
    #[serde(default)]
    pub pending: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unsupported: Option<bool>,
}
impl Answer {
    pub fn choice_strs(&self) -> Vec<String> {
        self.choices.iter().map(js_string).collect()
    }
}
/// String(v) for a JSON value as JS writes it.
pub fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        other => other.to_string(),
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct InRevision {
    pub by: String,
    pub envelope_number: u64,
}

pub const CARD_CONTENT: [&str; 16] = ["card_type", "title", "teaser", "body", "options", "sections", "html", "allows_multiple", "recommended", "urgency_reason", "attachments", "change_note", "close_summary", "withdraw_reason", "merged_into_object_id", "merged_from_object_ids"];

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Card {
    pub object_id: String,
    pub agent_device_id: String,
    pub object_state: String,
    pub urgency: String,
    #[serde(default)]
    pub object_version: u64,
    #[serde(default)]
    pub version_hash: Option<String>,
    #[serde(default)]
    pub envelope_number: u64,
    #[serde(default)]
    pub first_envelope_number: u64,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub updated_at: u64,
    #[serde(default)]
    pub versions: Vec<Value>,
    #[serde(default)]
    pub answer: Option<Answer>,
    #[serde(default)]
    pub answers: Vec<Answer>,
    #[serde(default)]
    pub closed_how: Option<String>,
    #[serde(default)]
    pub in_revision: Option<InRevision>,
    #[serde(default)]
    pub timeline_key: String,
    #[serde(default)]
    pub content_state: String,
    #[serde(default)]
    pub unsupported: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refused_head: Option<u64>,
    /// The content fields of the current version (card_type, title, teaser, body, options, …) and any unknown field.
    #[serde(flatten)]
    pub content: Map<String, Value>,
}
impl Card {
    pub fn f(&self, k: &str) -> &Value {
        self.content.get(k).unwrap_or(&Value::Null)
    }
    pub fn s(&self, k: &str) -> String {
        match self.f(k) {
            Value::String(s) => s.clone(),
            Value::Null => String::new(),
            v => js_string(v),
        }
    }
    pub fn card_type(&self) -> String {
        self.f("card_type").as_str().unwrap_or("decision").to_string()
    }
    pub fn title(&self) -> String {
        self.s("title")
    }
    pub fn options(&self) -> Vec<Value> {
        self.f("options").as_array().cloned().unwrap_or_default()
    }
    pub fn option_keys(&self) -> Vec<String> {
        self.options().iter().map(|o| o.get("key").map(js_string).unwrap_or_else(|| "undefined".into())).collect()
    }
    pub fn allows_multiple(&self) -> bool {
        self.f("allows_multiple").as_bool().unwrap_or(false) || (!self.f("allows_multiple").is_null() && truthy(self.f("allows_multiple")))
    }
    /// card.recommended as a list ([] for none).
    pub fn recommended_list(&self) -> Vec<String> {
        match self.f("recommended") {
            Value::Null => vec![],
            Value::Array(a) => a.iter().map(js_string).collect(),
            v => vec![js_string(v)],
        }
    }
    pub fn attachments(&self) -> Vec<Value> {
        self.f("attachments").as_array().cloned().unwrap_or_default()
    }
}
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Permission {
    pub object_id: String,
    pub agent_device_id: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub tool_name: Value,
    #[serde(default)]
    pub description: Value,
    #[serde(default)]
    pub input_preview: Value,
    #[serde(default)]
    pub expires_at: u64,
    #[serde(default)]
    pub version_hash: String,
    #[serde(default)]
    pub envelope_number: u64,
    #[serde(default)]
    pub sent_at: u64,
    pub permission_state: String,
    #[serde(default)]
    pub verdict: Option<Value>,
    #[serde(default)]
    pub withdraw_reason: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Published {
    pub object_id: String,
    pub agent_device_id: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub attachments: Value,
    #[serde(default)]
    pub title: Value,
    #[serde(default)]
    pub note: Value,
    #[serde(default)]
    pub released_until: Value,
    #[serde(default)]
    pub object_version: u64,
    #[serde(default)]
    pub version_hash: String,
    #[serde(default)]
    pub envelope_number: u64,
    pub object_state: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Timeline {
    pub timeline_key: String,
    pub timeline_kind: String,
    pub timeline_id: String,
    pub object_id: String,
    #[serde(default)]
    pub item_count: u64,
    #[serde(default)]
    pub newest_envelope_number: u64,
    #[serde(default)]
    pub newest_human_envelope_number: u64,
    #[serde(default)]
    pub newest_agent_envelope_number: u64,
    #[serde(default)]
    pub loaded_down_to: Option<u64>,
    #[serde(default)]
    pub has_more: bool,
    #[serde(default)]
    pub window_open: bool,
}

#[derive(Clone, Debug)]
pub struct Alert {
    pub code: String,
    pub message: String,
    pub envelope_number: Option<u64>,
    pub sender_device_id: Option<String>,
    pub at: u64,
    pub source: String,
}

#[derive(Default)]
pub struct Model {
    pub room: RoomInfo,
    pub members: BTreeMap<String, MemberRow>,
    pub sessions: BTreeMap<String, Session>,
    pub cards: BTreeMap<String, Card>,
    pub permissions: BTreeMap<String, Permission>,
    pub published: BTreeMap<String, Published>,
    pub timelines: BTreeMap<String, Timeline>,
    pub alerts: Vec<Alert>,
    pub stack: Vec<String>,
    pub open_permission_ids: Vec<String>,
    pub newer: Newer,
    pub device_registers: BTreeMap<String, Value>,
}

/// What a batch touched (only what persistence and the connector need).
#[derive(Default, Debug)]
pub struct Change {
    pub cards: std::collections::BTreeSet<String>,
    pub sessions: std::collections::BTreeSet<String>,
    pub permissions: std::collections::BTreeSet<String>,
    pub published: std::collections::BTreeSet<String>,
    pub timelines: std::collections::BTreeSet<String>,
    pub registers: std::collections::BTreeSet<String>,
    pub members: bool,
    pub alerts: bool,
    pub stack: bool,
    pub room: bool,
}

pub fn timeline_key(kind: &str, id: &str) -> String {
    format!("{kind}:{id}")
}
pub struct ParsedKey {
    pub timeline_kind: String,
    pub timeline_id: String,
    pub scope: String,
    pub scope_id: String,
}
pub fn parse_timeline_key(key: &str) -> ParsedKey {
    let (k, id) = key.split_once(':').unwrap_or(("", key));
    let (scope, sid) = id.split_once('/').unwrap_or((id, ""));
    ParsedKey { timeline_kind: k.into(), timeline_id: id.into(), scope: scope.into(), scope_id: sid.into() }
}

/// The record the sync engine hands the reducer.
#[derive(Clone, Debug)]
pub struct Rec {
    pub envelope_number: u64,
    pub envelope_hash: String,
    pub sender_device_id: String,
    pub sender_role: String,
    pub recipient_device_id: Option<String>,
    pub sent_at: u64,
    pub kind: u8,
    pub is_head: bool,
    pub object: Option<ObjRef>,
    pub timeline_kind: Option<String>,
    pub timeline_id: Option<String>,
    pub session_id: Option<String>,
    pub attachment_ids: Vec<String>,
    pub content: Option<Map<String, Value>>,
    pub content_state: String,
    pub bind: Option<BindHex>,
    pub local_id: Option<String>,
    pub causal: Causal,
    pub sender_sequence: u64,
    pub header: Header,
    pub raw_bind: Option<Vec<u8>>,
    pub epoch: u32,
    pub object_id_ok: Option<bool>,
    pub newer_content: Option<Map<String, Value>>,
}
#[derive(Clone, Copy, Debug)]
pub struct ObjRef {
    pub object_state: u8,
    pub urgency: u8,
    pub answered_at: u64,
    pub id: [u8; 16],
}
impl ObjRef {
    pub fn object_id(&self) -> String {
        crate::crypto::hex(&self.id)
    }
}

pub struct Applied {
    pub applied: bool,
    pub refused: Option<String>,
}
fn ok() -> Applied {
    Applied { applied: true, refused: None }
}
fn not() -> Applied {
    Applied { applied: false, refused: None }
}

impl Model {
    pub fn new() -> Self {
        Model { room: RoomInfo { connection: "offline".into(), last_entry_number: -1, ..Default::default() }, ..Default::default() }
    }
    pub fn is_agent(&self) -> bool {
        self.room.my_role == "agent"
    }

    // ---- alerts ----
    pub fn push_alert(&mut self, ch: &mut Change, code: &str, message: &str, envelope_number: Option<u64>, sender: Option<&str>, source: &str) {
        if std::env::var("CORE_DEBUG").is_ok() {
            eprintln!("[alert] {code} {message}");
        }
        self.alerts.push(Alert { code: code.into(), message: message.into(), envelope_number, sender_device_id: sender.map(String::from), at: now_ms(), source: source.into() });
        if self.alerts.len() > ALERTS_MAX {
            let n = self.alerts.len() - ALERTS_MAX;
            self.alerts.drain(..n);
        }
        ch.alerts = true;
    }
    fn refuse(&mut self, ch: &mut Change, rec: &Rec, code: &str, message: &str) -> Applied {
        self.push_alert(ch, code, message, Some(rec.envelope_number), Some(&rec.sender_device_id), "local");
        Applied { applied: false, refused: Some(code.into()) }
    }
    pub fn note_newer(&mut self, ch: &mut Change, what: &str, envelope_number: u64) {
        self.newer.count += 1;
        if !self.newer.what.iter().any(|w| w == what) {
            self.newer.what.push(what.into());
            if self.newer.what.len() > 16 {
                self.newer.what.remove(0);
            }
        }
        self.newer.envelope_number = self.newer.envelope_number.max(envelope_number);
        ch.room = true;
    }

    // ---- members and sessions ----
    /// Rebuild the members from the verified member list (plus what GET devices said before).
    pub fn apply_members(&mut self, list: &[(String, String, bool, u32, Option<u32>)], ch: &mut Change) {
        for (id, role, active, added, removed) in list {
            let old = self.members.get(id).cloned();
            let reg = self.device_registers.get(id).cloned();
            let name = reg.as_ref().and_then(|r| r.get("device_name")).and_then(|v| v.as_str()).map(String::from).or(old.as_ref().map(|o| o.device_name.clone())).unwrap_or_default();
            let g = |k: &str| reg.as_ref().and_then(|r| r.get(k)).cloned().unwrap_or(Value::Null);
            let next = MemberRow {
                device_id: id.clone(), device_role: role.clone(), device_name: name, platform: g("platform"), folder: g("folder"), host: g("host"),
                is_active: *active, added_entry_number: *added, removed_entry_number: *removed, is_me: *id == self.room.my_device_id,
                is_online: old.as_ref().map(|o| o.is_online).unwrap_or(false), offline_since: old.as_ref().and_then(|o| o.offline_since),
                link: old.as_ref().and_then(|o| o.link.clone()), agent_session_id: old.as_ref().and_then(|o| o.agent_session_id.clone()),
            };
            self.members.insert(id.clone(), next);
            if role == "agent" {
                self.touch_agent(id, ch);
            }
        }
        ch.members = true;
    }
    pub fn apply_devices(&mut self, devices: &[Value], ch: &mut Change) {
        for d in devices {
            let Some(id) = d.get("device_id").and_then(|v| v.as_str()) else { continue };
            let Some(m) = self.members.get_mut(id) else { continue };
            m.is_online = truthy(d.get("is_online").unwrap_or(&Value::Null));
            m.offline_since = if m.is_online { None } else { d.get("offline_since").and_then(|v| v.as_u64()) };
            m.link = clean_link(d.get("link"));
            if let Some(s) = d.get("agent_session_id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                m.agent_session_id = Some(s.into());
            }
            let role = m.device_role.clone();
            if role == "agent" {
                self.touch_agent(id, ch);
            }
        }
        ch.members = true;
    }
    pub fn session_of(&mut self, sid: &str) -> &mut Session {
        self.sessions.entry(sid.to_string()).or_insert_with(|| Session {
            session_id: sid.into(), is_active: true, timeline_key: timeline_key("chat", &format!("session/{sid}")), ..Default::default()
        })
    }
    fn sync_session_agent(&mut self, sid: &str) {
        let agent = self.sessions.get(sid).and_then(|s| s.agent_device_id.clone());
        let Some(m) = agent.and_then(|a| self.members.get(&a).cloned()) else { return };
        let s = self.sessions.get_mut(sid).unwrap();
        s.agent_session_id = Some(m.agent_session_id.clone().unwrap_or_else(|| m.device_id[..16].to_string()));
        s.device_name = m.device_name.clone();
        s.is_active = m.is_active;
        s.is_online = m.is_online;
        s.offline_since = m.offline_since;
        s.link = m.link.clone();
    }
    fn touch_agent(&mut self, agent: &str, ch: &mut Change) {
        let ids: Vec<String> = self.sessions.values().filter(|s| s.agent_device_ids.iter().any(|a| a == agent) || s.agent_device_id.as_deref() == Some(agent)).map(|s| s.session_id.clone()).collect();
        for sid in ids {
            self.sync_session_agent(&sid);
            ch.sessions.insert(sid);
        }
    }
    /// A verified grant chain state for one session.
    pub fn apply_session_grant(&mut self, ss: &crate::crypto::grants::SessionState, ch: &mut Change, ever: &[String], epoch_agents: Option<BTreeMap<String, Vec<String>>>) {
        let s = self.session_of(&ss.session_id);
        if let Some(e) = epoch_agents {
            s.epoch_agent_ids = e;
        }
        s.agent_device_ids = ss.agent_ids.clone();
        for a in ever.iter().chain(ss.agent_ids.iter()) {
            if !s.ever_agent_ids.contains(a) {
                s.ever_agent_ids.push(a.clone());
            }
        }
        if let Some(first) = s.agent_device_ids.first() {
            s.agent_device_id = Some(first.clone());
        }
        s.session_key_epoch = ss.epoch;
        s.with_history = ss.with_history;
        s.created_by_agent = ss.created_by_agent;
        s.creator_device_id = Some(ss.creator_id.clone());
        let sid = ss.session_id.clone();
        self.sync_session_agent(&sid);
        ch.sessions.insert(sid);
        ch.stack = true;
    }
    fn ever_agent(&self, sid: Option<&str>, device: Option<&str>) -> bool {
        match (sid, device) {
            (Some(sid), Some(d)) => self.sessions.get(sid).is_some_and(|s| s.ever_agent_ids.iter().any(|a| a == d)),
            _ => false,
        }
    }
    /// B03/A7: may this agent write into session `sid` with this record (the agents of the record's session key epoch).
    fn agent_at(&self, sid: Option<&str>, device: Option<&str>, rec: Option<&Rec>) -> bool {
        let (Some(sid), Some(device)) = (sid, device) else { return false };
        let Some(s) = self.sessions.get(sid) else { return false };
        let at = rec.filter(|r| r.session_id.as_deref() == Some(sid)).and_then(|r| s.epoch_agent_ids.get(&r.epoch.to_string()));
        match at {
            Some(list) => list.iter().any(|a| a == device),
            None => s.ever_agent_ids.iter().any(|a| a == device),
        }
    }
    /// R1: who holds an object, judged for one record.
    fn holds_at(&self, obj_agent: &str, obj_session: Option<&str>, device: Option<&str>, rec: &Rec) -> bool {
        let Some(device) = device else { return false };
        device == obj_agent
            || (obj_session.is_some() && rec.session_id.as_deref() == obj_session && self.agent_at(obj_session, Some(device), Some(rec)) && !self.agent_at(obj_session, Some(obj_agent), Some(rec)))
    }
    /// Who holds an object now: its creator while assigned, else the session's agent.
    pub fn holder_of(&self, agent: &str, session_id: Option<&str>) -> String {
        let now: Vec<String> = session_id.and_then(|s| self.sessions.get(s)).map(|s| s.agent_device_ids.clone()).unwrap_or_default();
        if now.is_empty() || now.iter().any(|a| a == agent) {
            agent.to_string()
        } else {
            now[0].clone()
        }
    }

    // ---- the reducer ----
    pub fn apply_record(&mut self, rec: &Rec, ch: &mut Change) -> Applied {
        if let Some(sid) = &rec.session_id {
            if self.is_agent() && rec.sender_device_id != self.room.my_device_id && !self.ever_agent(Some(sid), Some(&self.room.my_device_id.clone())) {
                return not();
            }
            let s = self.session_of(sid);
            s.last_activity_at = s.last_activity_at.max(rec.sent_at);
            ch.sessions.insert(sid.clone());
        }
        let mut rec = rec.clone();
        if rec.content_state == "newer_schema" {
            let what = rec.content.as_ref().map(|c| format!("schema_version {}", c.get("schema_version").map(js_string).unwrap_or_default())).unwrap_or_else(|| "body format".into());
            self.note_newer(ch, &what, rec.envelope_number);
            if rec.kind != codec::KIND_TIMELINE_ITEM {
                rec.newer_content = rec.content.take();
            }
        }
        match rec.kind {
            codec::KIND_TIMELINE_ITEM => self.apply_timeline_item(&rec, ch),
            codec::KIND_OBJECT_VERSION => self.apply_object_version(&rec, ch),
            codec::KIND_ANSWER => self.apply_answer(&rec, ch),
            codec::KIND_PERMISSION_REQUEST => self.apply_permission_request(&rec, ch),
            codec::KIND_VERDICT => self.apply_verdict(&rec, ch),
            codec::KIND_STATUS => self.apply_status(&rec, ch),
            codec::KIND_DECIDE_AGAIN => self.apply_decide_again(&rec, ch),
            k => {
                self.note_newer(ch, &format!("envelope kind {k}"), rec.envelope_number);
                Applied { applied: false, refused: Some("needs-update".into()) }
            }
        }
    }

    pub fn timeline_of(&mut self, key: &str) -> &mut Timeline {
        self.timelines.entry(key.to_string()).or_insert_with(|| {
            let p = parse_timeline_key(key);
            Timeline { timeline_key: key.into(), timeline_kind: p.timeline_kind, timeline_id: p.timeline_id, object_id: p.scope_id, ..Default::default() }
        })
    }
    /// R1: who may write into which timeline. None if allowed, else a refusal code.
    pub fn timeline_refusal(&self, rec: &Rec) -> Option<&'static str> {
        let tk = rec.timeline_kind.clone().unwrap_or_default();
        let tid = rec.timeline_id.clone().unwrap_or_default();
        let p = parse_timeline_key(&timeline_key(&tk, &tid));
        let human = rec.sender_role == "human";
        if p.timeline_kind == "chat" {
            if p.scope == "session" {
                if rec.session_id.as_deref().is_some_and(|s| s != p.scope_id) {
                    return Some("not-allowed");
                }
                return if self.agent_at(Some(&p.scope_id), Some(&rec.sender_device_id), Some(rec)) || (human && self.ever_agent(Some(&p.scope_id), rec.recipient_device_id.as_deref())) { None } else { Some("not-allowed") };
            }
            if p.scope == "card" {
                let Some(card) = self.cards.get(&p.scope_id) else { return Some("card-mismatch") };
                return if self.holds_at(&card.agent_device_id, card.session_id.as_deref(), Some(&rec.sender_device_id), rec)
                    || (human && self.holds_at(&card.agent_device_id, card.session_id.as_deref(), rec.recipient_device_id.as_deref(), rec)) { None } else { Some("not-allowed") };
            }
            return Some("not-allowed");
        }
        if p.timeline_kind == "scribble" {
            if p.scope == "desk" {
                return if human { None } else { Some("not-allowed") };
            }
            if p.scope == "session" {
                return if human || self.agent_at(Some(&p.scope_id), Some(&rec.sender_device_id), Some(rec)) { None } else { Some("not-allowed") };
            }
            if p.scope == "card" {
                let ok = human || self.cards.get(&p.scope_id).is_some_and(|c| self.holds_at(&c.agent_device_id, c.session_id.as_deref(), Some(&rec.sender_device_id), rec));
                return if ok { None } else { Some("not-allowed") };
            }
            return Some("not-allowed");
        }
        None
    }
    fn apply_timeline_item(&mut self, rec: &Rec, ch: &mut Change) -> Applied {
        if let Some(why) = self.timeline_refusal(rec) {
            return self.refuse(ch, rec, why, &format!("not allowed in {}", rec.timeline_id.clone().unwrap_or_default()));
        }
        let tk = rec.timeline_kind.clone().unwrap_or_default();
        let key = timeline_key(&tk, rec.timeline_id.as_deref().unwrap_or(""));
        if tk != "chat" && tk != "scribble" {
            self.note_newer(ch, &format!("timeline kind {tk}"), rec.envelope_number);
        } else if let Some(c) = rec.content.as_ref().filter(|_| rec.content_state == "ok") {
            if !content_type_known(c) {
                self.note_newer(ch, &format!("content_type {}", c.get("content_type").map(js_string).unwrap_or_default()), rec.envelope_number);
            }
        }
        let human = rec.sender_role == "human";
        let t = self.timeline_of(&key);
        t.item_count += 1;
        t.newest_envelope_number = t.newest_envelope_number.max(rec.envelope_number);
        if human {
            t.newest_human_envelope_number = rec.envelope_number;
        } else {
            t.newest_agent_envelope_number = rec.envelope_number;
        }
        ch.timelines.insert(key.clone());
        let p = parse_timeline_key(&key);
        if p.timeline_kind == "chat" && p.scope == "card" {
            if let Some(card) = self.cards.get_mut(&p.scope_id) {
                if let Some(c) = &rec.content {
                    if truthy(c.get("present_card").unwrap_or(&Value::Null)) {
                        card.in_revision = None;
                    } else if human && (truthy(c.get("hand_back").unwrap_or(&Value::Null)) || truthy(c.get("explain").unwrap_or(&Value::Null)))
                        && (card.object_state == "open" || card.answer.as_ref().is_some_and(|a| a.pending)) {
                        card.in_revision = Some(InRevision { by: if truthy(c.get("hand_back").unwrap_or(&Value::Null)) { "hand_back".into() } else { "explain".into() }, envelope_number: rec.envelope_number });
                    }
                }
                ch.cards.insert(card.object_id.clone());
                if let Some(s) = &card.session_id {
                    ch.sessions.insert(s.clone());
                }
            }
        } else if p.scope == "session" {
            ch.sessions.insert(p.scope_id);
        }
        ok()
    }

    fn apply_object_version(&mut self, rec: &Rec, ch: &mut Change) -> Applied {
        let Some(obj) = rec.object else { return self.refuse(ch, rec, "bad-object", "object version without object id") };
        let object_id = obj.object_id();
        let c = rec.content.clone();
        let type_ = c.as_ref().or(rec.newer_content.as_ref()).and_then(|c| c.get("object_type")).map(js_string).unwrap_or_else(|| {
            if rec.sender_role == "human" { "note".into() } else if self.published.contains_key(&object_id) { "published".into() } else { "card".into() }
        });
        if c.is_none() && rec.content_state == "undecryptable" && self.is_agent() && rec.sender_role == "human" {
            return not();
        }
        if !codec::OBJECT_TYPES.contains(&type_.as_str()) {
            self.note_newer(ch, &format!("object_type {type_}"), rec.envelope_number);
            return Applied { applied: false, refused: Some("needs-update".into()) };
        }
        if type_ == "note" {
            // notes: room scope, human devices only; an agent never reads them
            if rec.sender_role != "human" {
                return self.refuse(ch, rec, "not-creator", "notes come from human devices");
            }
            return not();
        }
        if type_ == "published" {
            return self.apply_published(rec, ch, &object_id);
        }
        if rec.sender_role != "agent" {
            return self.refuse(ch, rec, "not-creator", "cards come from agents");
        }
        let fresh = !self.cards.contains_key(&object_id);
        if let Some(card) = self.cards.get(&object_id) {
            if !self.holds_at(&card.agent_device_id, card.session_id.as_deref(), Some(&rec.sender_device_id), rec) {
                return self.refuse(ch, rec, "not-creator", "a card version from someone else than its creator");
            }
        }
        if rec.session_id.is_some() && !self.agent_at(rec.session_id.as_deref(), Some(&rec.sender_device_id), Some(rec)) {
            return self.refuse(ch, rec, "not-allowed", "a card in a session this agent is not assigned to");
        }
        if let Some(card) = self.cards.get(&object_id) {
            if card.session_id != rec.session_id {
                return self.refuse(ch, rec, "not-allowed", "a card version in another session");
            }
        }
        if fresh && rec.object_id_ok == Some(false) {
            return self.refuse(ch, rec, "bad-object-id", "object id is not H(creator, sequence of version 1)");
        }
        if let Some(c) = &c {
            let cur_version = self.cards.get(&object_id).map(|k| k.object_version).unwrap_or(0);
            let expected = cur_version + 1;
            let ov = c.get("object_version").and_then(|v| v.as_f64());
            if ov != Some(expected as f64) {
                return self.refuse(ch, rec, "bad-version", &format!("card version {}, expected {expected}", c.get("object_version").map(js_string).unwrap_or_else(|| "undefined".into())));
            }
            let pvh = c.get("previous_version_hash");
            if expected > 1 && pvh.and_then(|v| v.as_str()) != self.cards.get(&object_id).and_then(|k| k.version_hash.as_deref()) {
                return self.refuse(ch, rec, "bad-version", "previous_version_hash does not name the current version");
            }
            if expected == 1 && pvh.is_some_and(|v| truthy(v) && !v.as_str().is_some_and(|s| s.chars().all(|c| c == '0'))) {
                return self.refuse(ch, rec, "bad-version", "version 1 names a predecessor");
            }
        }
        if fresh {
            let card = Card {
                object_id: object_id.clone(), agent_device_id: rec.sender_device_id.clone(), object_state: "open".into(), urgency: "normal".into(),
                envelope_number: rec.envelope_number, first_envelope_number: rec.envelope_number, created_at: rec.sent_at, session_id: rec.session_id.clone(),
                updated_at: rec.sent_at, timeline_key: timeline_key("chat", &format!("card/{object_id}")), content_state: "ok".into(),
                content: default_card_content(), ..Default::default()
            };
            let created = card.created_at;
            self.cards.insert(object_id.clone(), card);
            if let Some(sid) = rec.session_id.clone() {
                let cards = &self.cards;
                let mut at;
                {
                    let l = &self.sessions.get(&sid).map(|s| s.card_ids.clone()).unwrap_or_default();
                    at = l.len();
                    while at > 0 && cards.get(&l[at - 1]).map(|c| c.created_at).unwrap_or(0) > created {
                        at -= 1;
                    }
                }
                self.session_of(&sid).card_ids.insert(at, object_id.clone());
            }
        }
        let (st, urg) = state_of(rec);
        let card = self.cards.get_mut(&object_id).unwrap();
        let was_open = card.object_state == "open";
        card.object_state = st.into();
        card.urgency = urg.into();
        card.envelope_number = rec.envelope_number;
        card.updated_at = rec.sent_at;
        card.version_hash = Some(rec.envelope_hash.clone());
        if let (Some(c), true) = (&c, rec.content_state == "ok") {
            for f in CARD_CONTENT {
                let v = c.get(f).filter(|v| !v.is_null()).cloned().unwrap_or_else(|| default_of(f));
                card.content.insert(f.into(), v);
            }
            card.object_version = c.get("object_version").and_then(|v| v.as_u64()).unwrap_or(card.object_version + 1);
            card.content_state = "ok".into();
        } else {
            card.object_version += 1;
            card.content_state = rec.content_state.clone();
        }
        card.unsupported = if card.content_state == "newer_schema" {
            Some("newer_schema".into())
        } else if card.content_state == "ok" && !codec::CARD_TYPES.contains(&card.card_type().as_str()) {
            Some("card_type".into())
        } else {
            None
        };
        let unsupported_type = card.unsupported.as_deref() == Some("card_type");
        let ct = card.card_type();
        card.versions.push(json!({
            "object_version": card.object_version, "version_hash": rec.envelope_hash, "previous_version_hash": c.as_ref().and_then(|c| c.get("previous_version_hash")).cloned().unwrap_or(Value::Null),
            "envelope_number": rec.envelope_number, "sent_at": rec.sent_at, "object_state": st, "urgency": urg, "content": c.clone().map(Value::Object).unwrap_or(Value::Null),
        }));
        card.in_revision = None;
        if card.object_state == "open" {
            card.closed_how = None;
            if !was_open && card.answer.is_some() {
                card.answer = None;
            }
        } else if card.object_state == "closed" {
            card.closed_how = Some(
                if truthy(card.f("merged_into_object_id")) { "merged" }
                else if truthy(card.f("withdraw_reason")) { "withdrawn" }
                else if card.answer.as_ref().is_some_and(|a| a.answer_action == "read") { "read" }
                else if card.answer.as_ref().is_some_and(|a| a.answer_action == "shred") { "shredded" }
                else { "closed" }.into(),
            );
        } else if card.object_state == "answered" {
            card.closed_how = Some("answered".into());
        }
        let sid = card.session_id.clone();
        if unsupported_type {
            self.note_newer(ch, &format!("card_type {ct}"), rec.envelope_number);
        }
        ch.cards.insert(object_id);
        if let Some(s) = sid {
            ch.sessions.insert(s);
        }
        ch.stack = true;
        ok()
    }

    fn apply_published(&mut self, rec: &Rec, ch: &mut Change, object_id: &str) -> Applied {
        let old = self.published.get(object_id).cloned();
        if rec.sender_role != "agent" {
            return self.refuse(ch, rec, "not-creator", "published objects come from agents");
        }
        if rec.session_id.is_some() && !self.agent_at(rec.session_id.as_deref(), Some(&rec.sender_device_id), Some(rec)) {
            return self.refuse(ch, rec, "not-allowed", "a published object in a session this agent is not assigned to");
        }
        if let Some(o) = &old {
            if !self.holds_at(&o.agent_device_id, o.session_id.as_deref(), Some(&rec.sender_device_id), rec) {
                return self.refuse(ch, rec, "not-creator", "a published object from someone else than its creator");
            }
        }
        if old.is_none() && rec.object_id_ok == Some(false) {
            return self.refuse(ch, rec, "bad-object-id", "object id is not H(creator, sequence of version 1)");
        }
        let empty = Map::new();
        let c = rec.content.as_ref().unwrap_or(&empty);
        let expected = old.as_ref().map(|o| o.object_version).unwrap_or(0) + 1;
        if rec.content.is_some() && c.get("object_version").and_then(|v| v.as_f64()) != Some(expected as f64) {
            return self.refuse(ch, rec, "bad-version", &format!("published version {}, expected {expected}", c.get("object_version").map(js_string).unwrap_or_else(|| "undefined".into())));
        }
        if rec.content.is_some() {
            if let Some(o) = &old {
                if let Some(p) = c.get("previous_version_hash").filter(|v| truthy(v)) {
                    if p.as_str() != Some(o.version_hash.as_str()) {
                        return self.refuse(ch, rec, "bad-version", "previous_version_hash does not name the current version");
                    }
                }
            }
        }
        let pick = |k: &str, fallback: Option<Value>, default: Value| c.get(k).filter(|v| !v.is_null()).cloned().or(fallback).unwrap_or(default);
        let p = Published {
            object_id: object_id.into(),
            agent_device_id: old.as_ref().map(|o| o.agent_device_id.clone()).unwrap_or_else(|| rec.sender_device_id.clone()),
            session_id: rec.session_id.clone().or(old.as_ref().and_then(|o| o.session_id.clone())),
            attachments: pick("attachments", old.as_ref().map(|o| o.attachments.clone()).filter(|v| !v.is_null()), json!([])),
            title: pick("title", old.as_ref().map(|o| o.title.clone()).filter(|v| !v.is_null()), json!("")),
            note: c.get("note").cloned().filter(|v| !v.is_null()).unwrap_or(Value::Null),
            released_until: c.get("released_until").cloned().filter(|v| !v.is_null()).unwrap_or(Value::Null),
            object_version: expected, version_hash: rec.envelope_hash.clone(), envelope_number: rec.envelope_number, object_state: state_of(rec).0.into(),
        };
        self.published.insert(object_id.into(), p);
        ch.published.insert(object_id.into());
        if let Some(s) = &rec.session_id {
            ch.sessions.insert(s.clone());
        }
        ok()
    }

    /// Whether an answer counts (the same rule on every client).
    pub fn answer_refusal(&self, rec: &Rec) -> Option<&'static str> {
        let card = rec.object.and_then(|o| self.cards.get(&o.object_id()));
        if rec.sender_role != "human" {
            return Some("not-human");
        }
        let Some(card) = card else { return Some("card-mismatch") };
        if !self.holds_at(&card.agent_device_id, card.session_id.as_deref(), rec.recipient_device_id.as_deref(), rec) {
            return Some("not-for-owner");
        }
        let b = rec.bind.as_ref();
        if b.is_none() && rec.content.is_none() && (rec.content_state == "pruned" || rec.content_state == "header") {
            return if card.object_state == "open" { None } else { Some("card-closed") };
        }
        let Some(b) = b.filter(|b| b.card_id.as_deref() == Some(&card.object_id)) else { return Some("card-mismatch") };
        if card.object_state != "open" {
            return Some("card-closed");
        }
        if b.version_hash.as_deref() != card.version_hash.as_deref() {
            return Some("answer-stale");
        }
        let Some(c) = &rec.content else { return None };
        let action = c.get("answer_action");
        if let Some(Value::String(a)) = action {
            if !codec::ANSWER_ACTIONS.contains(&a.as_str()) {
                return None;
            }
        } else {
            return Some("bad-answer");
        }
        let action = action.unwrap().as_str().unwrap();
        if card.content_state != "ok" && !card.content_state.is_empty() {
            return None;
        }
        let choices: Vec<Value> = c.get("choices").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let bound = b.choices.clone().unwrap_or_default();
        let bound_json = serde_json::to_string(&bound).unwrap();
        let choices_json = serde_json::to_string(&c.get("choices").cloned().unwrap_or(json!([]))).unwrap();
        if bound_json != choices_json {
            return Some("bad-answer");
        }
        if action == "answer" {
            let keys = card.option_keys();
            if card.card_type() == "info" {
                return Some("bad-answer");
            }
            let is_key = |k: &Value| k.as_str().is_some_and(|s| keys.iter().any(|x| x == s));
            if truthy(c.get("trusted").unwrap_or(&Value::Null)) {
                let rec_list = card.recommended_list();
                if choices.iter().any(|k| !is_key(k) || !k.as_str().is_some_and(|s| rec_list.iter().any(|r| r == s))) {
                    return Some("bad-choice");
                }
            } else if choices.is_empty() || choices.iter().any(|k| !is_key(k)) {
                return Some("bad-choice");
            }
            if choices.len() > 1 && !card.allows_multiple() {
                return Some("bad-choice");
            }
            if state_of(rec).0 == "closed" && (truthy(c.get("trusted").unwrap_or(&Value::Null)) || !choices_final(card, &choices)) {
                return Some("bad-answer");
            }
        }
        if action == "read" && card.card_type() != "info" {
            return Some("bad-answer");
        }
        None
    }

    fn apply_answer(&mut self, rec: &Rec, ch: &mut Change) -> Applied {
        if let Some(why) = self.answer_refusal(rec) {
            if let Some(card) = rec.object.and_then(|o| self.cards.get_mut(&o.object_id())) {
                if rec.is_head && state_of(rec).0 != "open" && rec.envelope_number > card.refused_head.unwrap_or(0) && rec.envelope_number > card.envelope_number {
                    card.refused_head = Some(rec.envelope_number);
                    ch.cards.insert(card.object_id.clone());
                }
            }
            return self.refuse(ch, rec, why, "answer not counted");
        }
        let oid = rec.object.unwrap().object_id();
        let empty = Map::new();
        let c = rec.content.as_ref().unwrap_or(&empty);
        let newer_action = c.get("answer_action").and_then(|v| v.as_str()).is_some_and(|a| !codec::ANSWER_ACTIONS.contains(&a));
        if newer_action {
            let a = c.get("answer_action").map(js_string).unwrap_or_default();
            self.note_newer(ch, &format!("answer_action {a}"), rec.envelope_number);
        }
        let card = self.cards.get_mut(&oid).unwrap();
        let answer = Answer {
            answer_action: c.get("answer_action").and_then(|v| v.as_str()).unwrap_or("answer").into(),
            choices: c.get("choices").and_then(|v| v.as_array()).cloned().unwrap_or_default(),
            note: c.get("note").cloned().filter(|v| !v.is_null()).unwrap_or(Value::Null),
            option_notes: c.get("option_notes").cloned().filter(|v| !v.is_null()).unwrap_or(json!({})),
            attachments: c.get("attachments").cloned().filter(|v| !v.is_null()).unwrap_or(json!([])),
            marks: c.get("marks").cloned().filter(|v| !v.is_null()).unwrap_or(json!([])),
            trusted: truthy(c.get("trusted").unwrap_or(&Value::Null)),
            bound_version_hash: rec.bind.as_ref().and_then(|b| b.version_hash.clone()),
            bound_object_version: card.object_version,
            envelope_number: Some(rec.envelope_number), envelope_hash: Some(rec.envelope_hash.clone()), by_device_id: Some(rec.sender_device_id.clone()),
            answered_at: if rec.object.unwrap().answered_at > 0 { rec.object.unwrap().answered_at } else { rec.sent_at },
            taken_back_at: None, taken_back_sent_at: None, pending: false,
            unsupported: if newer_action || rec.newer_content.is_some() { Some(true) } else { None },
        };
        card.answer = Some(answer.clone());
        card.answers.push(answer.clone());
        let st = state_of(rec).0;
        card.object_state = if st == "open" { "answered".into() } else { st.into() };
        card.closed_how = Some(if answer.answer_action == "read" { "read" } else if answer.answer_action == "shred" { "shredded" }
            else if card.object_state == "closed" && rec.content.is_some() && !newer_action { "settled" }
            else if card.object_state == "closed" { "closed" } else { "answered" }.into());
        card.in_revision = None;
        card.updated_at = rec.sent_at;
        ch.cards.insert(card.object_id.clone());
        if let Some(s) = &card.session_id {
            ch.sessions.insert(s.clone());
        }
        ch.stack = true;
        ok()
    }

    pub fn decide_again_refusal(&self, rec: &Rec) -> Option<&'static str> {
        let card = rec.object.and_then(|o| self.cards.get(&o.object_id()));
        if rec.sender_role != "human" {
            return Some("not-human");
        }
        let Some(card) = card else { return Some("card-mismatch") };
        if !self.holds_at(&card.agent_device_id, card.session_id.as_deref(), rec.recipient_device_id.as_deref(), rec) {
            return Some("not-for-owner");
        }
        let Some(b) = rec.bind.as_ref().filter(|b| b.card_id.as_deref() == Some(&card.object_id)) else { return Some("card-mismatch") };
        if card.answer.as_ref().and_then(|a| a.envelope_hash.as_deref()) != b.previous_hash.as_deref() || card.answer.is_none() {
            return Some("decision-mismatch");
        }
        if b.version_hash.is_some() && b.version_hash.as_deref() != card.version_hash.as_deref() {
            return Some("card-changed");
        }
        if card.object_state == "closed" && ["closed", "withdrawn", "merged"].contains(&card.closed_how.as_deref().unwrap_or("")) {
            return Some("card-closed");
        }
        None
    }
    fn apply_decide_again(&mut self, rec: &Rec, ch: &mut Change) -> Applied {
        if let Some(why) = self.decide_again_refusal(rec) {
            return self.refuse(ch, rec, why, "decide again not counted");
        }
        let card = self.cards.get_mut(&rec.object.unwrap().object_id()).unwrap();
        let hash = card.answer.as_ref().and_then(|a| a.envelope_hash.clone());
        for a in card.answers.iter_mut().filter(|a| a.envelope_hash == hash) {
            a.taken_back_at = Some(rec.envelope_number);
            a.taken_back_sent_at = Some(rec.sent_at);
        }
        card.answer = None;
        card.object_state = "open".into();
        card.closed_how = None;
        card.updated_at = rec.sent_at;
        ch.cards.insert(card.object_id.clone());
        if let Some(s) = &card.session_id {
            ch.sessions.insert(s.clone());
        }
        ch.stack = true;
        ok()
    }

    fn apply_permission_request(&mut self, rec: &Rec, ch: &mut Change) -> Applied {
        let object_id = rec.object.map(|o| o.object_id());
        if rec.sender_role != "agent" {
            return self.refuse(ch, rec, "not-creator", "permission requests come from agents");
        }
        if rec.session_id.is_some() && !self.agent_at(rec.session_id.as_deref(), Some(&rec.sender_device_id), Some(rec)) {
            return self.refuse(ch, rec, "not-allowed", "a permission request in a session this agent is not assigned to");
        }
        let known = object_id.as_ref().and_then(|id| self.permissions.get(id)).cloned();
        if let Some(k) = &known {
            if k.agent_device_id == rec.sender_device_id && rec.object.map(|o| o.object_state) == Some(3) {
                if k.permission_state != "pending" {
                    return not();
                }
                let p = self.permissions.get_mut(object_id.as_ref().unwrap()).unwrap();
                p.permission_state = "withdrawn".into();
                p.withdraw_reason = Some(rec.content.as_ref().and_then(|c| c.get("withdraw_reason")).cloned().filter(|v| !v.is_null()).unwrap_or(json!("")));
                let sid = p.session_id.clone();
                ch.permissions.insert(object_id.clone().unwrap());
                if let Some(s) = sid {
                    ch.sessions.insert(s);
                }
                ch.stack = true;
                return ok();
            }
        }
        if object_id.is_none() || known.is_some() {
            return self.refuse(ch, rec, "bad-object", "permission request without a new object id");
        }
        let object_id = object_id.unwrap();
        if let Some(b) = &rec.bind {
            if b.request_id.as_deref() != Some(&object_id) {
                return self.refuse(ch, rec, "bad-object", "request id differs from object id");
            }
        }
        if rec.object_id_ok == Some(false) {
            return self.refuse(ch, rec, "bad-object-id", "object id is not H(creator, sequence)");
        }
        let empty = Map::new();
        let c = rec.content.as_ref().unwrap_or(&empty);
        let g = |k: &str| c.get(k).cloned().filter(|v| !v.is_null()).unwrap_or(json!(""));
        self.permissions.insert(object_id.clone(), Permission {
            object_id: object_id.clone(), agent_device_id: rec.sender_device_id.clone(), session_id: rec.session_id.clone(), tool_name: g("tool_name"), description: g("description"),
            input_preview: g("input_preview"), expires_at: rec.bind.as_ref().and_then(|b| b.expires_at).unwrap_or(0), version_hash: rec.envelope_hash.clone(),
            envelope_number: rec.envelope_number, sent_at: rec.sent_at, permission_state: "pending".into(), verdict: None, withdraw_reason: None,
        });
        ch.permissions.insert(object_id);
        if let Some(s) = &rec.session_id {
            ch.sessions.insert(s.clone());
        }
        ch.stack = true;
        ok()
    }
    pub fn verdict_refusal(&self, rec: &Rec) -> Option<&'static str> {
        let id = rec.object.map(|o| o.object_id()).or_else(|| rec.bind.as_ref().and_then(|b| b.request_id.clone()));
        let p = id.and_then(|i| self.permissions.get(&i));
        if rec.sender_role != "human" {
            return Some("not-human");
        }
        let Some(p) = p else { return Some("request-mismatch") };
        let Some(b) = rec.bind.as_ref().filter(|b| b.request_id.as_deref() == Some(&p.object_id)) else { return Some("request-mismatch") };
        if rec.recipient_device_id.as_deref() != Some(&p.agent_device_id) {
            return Some("not-for-owner");
        }
        if p.permission_state != "pending" {
            return Some("request-not-pending");
        }
        if b.request_hash.as_deref() != Some(&p.version_hash) || b.expires_at != Some(p.expires_at) {
            return Some("request-changed");
        }
        None
    }
    fn apply_verdict(&mut self, rec: &Rec, ch: &mut Change) -> Applied {
        if let Some(why) = self.verdict_refusal(rec) {
            return self.refuse(ch, rec, why, "verdict not counted");
        }
        let b = rec.bind.clone().unwrap();
        let p = self.permissions.get_mut(b.request_id.as_ref().unwrap()).unwrap();
        let allow = b.allow.unwrap_or(false);
        p.verdict = Some(json!({ "allow": allow, "by_device_id": rec.sender_device_id, "envelope_number": rec.envelope_number }));
        p.permission_state = if allow { "allowed".into() } else { "denied".into() };
        ch.permissions.insert(p.object_id.clone());
        if let Some(s) = &p.session_id {
            ch.sessions.insert(s.clone());
        }
        ch.stack = true;
        ok()
    }

    fn apply_status(&mut self, rec: &Rec, ch: &mut Change) -> Applied {
        let values = rec.content.as_ref().and_then(|c| c.get("values")).and_then(|v| v.as_object()).cloned();
        let Some(values) = values else {
            if rec.content_state == "ok" {
                return self.refuse(ch, rec, "bad-status", "status without values");
            }
            return not();
        };
        for (key, value) in values {
            if key.starts_with("device/") {
                if key != format!("device/{}", rec.sender_device_id) {
                    self.refuse(ch, rec, "foreign-key", &format!("{key} from another device"));
                    continue;
                }
                self.device_registers.insert(rec.sender_device_id.clone(), value.clone());
                if let Some(m) = self.members.get_mut(&rec.sender_device_id) {
                    m.device_name = value.get("device_name").and_then(|v| v.as_str()).unwrap_or("").into();
                    m.platform = value.get("platform").cloned().unwrap_or(Value::Null);
                    m.folder = value.get("folder").cloned().unwrap_or(Value::Null);
                    m.host = value.get("host").cloned().unwrap_or(Value::Null);
                    ch.members = true;
                    if m.device_role == "agent" {
                        let id = m.device_id.clone();
                        self.touch_agent(&id, ch);
                    }
                }
                ch.registers.insert(key);
            } else if rec.sender_role == "human" && is_human_key(&key) {
                // agents ignore human keys
                continue;
            } else if rec.sender_role == "agent" && is_agent_key(&key) {
                if rec.session_id.is_none() || !self.agent_at(rec.session_id.as_deref(), Some(&rec.sender_device_id), Some(rec)) {
                    self.refuse(ch, rec, "not-allowed", &format!("{key} outside the agent's session"));
                    continue;
                }
                let sid = rec.session_id.clone().unwrap();
                self.set_agent_register(&sid, &key, value, rec, ch);
            } else if (rec.sender_role == "agent" && is_human_key(&key)) || (rec.sender_role == "human" && is_agent_key(&key)) {
                self.refuse(ch, rec, "foreign-key", &format!("{key} is not a {} key", rec.sender_role));
            } else if rec.sender_role == "agent" {
                if rec.session_id.is_some() && self.agent_at(rec.session_id.as_deref(), Some(&rec.sender_device_id), Some(rec)) {
                    let sid = rec.session_id.clone().unwrap();
                    self.set_agent_register(&sid, &key, value, rec, ch);
                }
            }
        }
        ok()
    }
    fn set_agent_register(&mut self, sid: &str, key: &str, value: Value, rec: &Rec, ch: &mut Change) {
        let agent = rec.sender_device_id.clone();
        let mut alert: Option<(String, String)> = None;
        {
            let s = self.session_of(sid);
            let old = s.register(key).cloned();
            if let Some(o) = &old {
                let refuse = match &o.causal {
                    Some(oc) => !causally_after(Some(&rec.causal), Some(oc)),
                    None => o.sender_sequence > 0 && rec.sender_sequence > 0 && rec.sender_sequence <= o.sender_sequence,
                };
                if refuse {
                    return;
                }
            }
            let value = if value.is_null() { Value::Null } else { value };
            s.set_register(key, RegEntry { value: value.clone(), envelope_number: rec.envelope_number, sender_sequence: rec.sender_sequence, causal: Some(rec.causal.clone()) });
            if key == "profile" {
                s.profile = if value.is_null() { None } else { Some(value.clone()) };
            } else if key == "heard" {
                let up_to = value.get("up_to").and_then(|v| v.as_u64()).filter(|n| *n <= crate::crypto::MAX_SAFE);
                if let Some(u) = up_to {
                    if s.heard_up_to.is_none_or(|h| u >= h) {
                        s.heard_up_to = Some(u);
                        s.heard_at = value.get("at").and_then(|v| v.as_u64()).filter(|n| *n > 0).or(Some(rec.sent_at));
                    }
                }
            } else if let Some(id) = key.strip_prefix("status_line/") {
                let at = s.status_lines.iter().position(|l| l.id == id);
                if value.is_null() {
                    if let Some(i) = at {
                        s.status_lines.remove(i);
                    }
                } else {
                    let line = StatusLine {
                        id: id.into(), label: value.get("label").cloned().filter(|v| !v.is_null()).unwrap_or(json!(id)), state: value.get("state").cloned().unwrap_or(Value::Null),
                        detail: value.get("detail").cloned().unwrap_or(Value::Null), object_id: value.get("object_id").cloned().unwrap_or(Value::Null),
                        envelope_number: rec.envelope_number, updated_at: rec.sent_at,
                    };
                    match at {
                        Some(i) => s.status_lines[i] = line,
                        None => s.status_lines.push(line),
                    }
                }
            } else if key.starts_with("alert/") {
                let at = s.agent_alerts.iter().position(|a| a.get("key").and_then(|k| k.as_str()) == Some(key));
                if value.is_null() {
                    if let Some(i) = at {
                        s.agent_alerts.remove(i);
                    }
                } else {
                    let a = json!({ "key": key, "value": value, "envelope_number": rec.envelope_number });
                    match at {
                        Some(i) => s.agent_alerts[i] = a,
                        None => s.agent_alerts.push(a),
                    }
                    alert = Some((value.get("code").and_then(|v| v.as_str()).unwrap_or("agent-alert").into(), value.get("message").and_then(|v| v.as_str()).unwrap_or("").into()));
                }
            }
        }
        if let Some((code, msg)) = alert {
            self.push_alert(ch, &code, &msg, Some(rec.envelope_number), Some(&agent), "agent");
        }
        ch.sessions.insert(sid.into());
        ch.registers.insert(key.into());
    }

    /// F15: own open cards the hub holds as closed (a refused answer is their newest head).
    pub fn cards_to_reassert(&self, me: &str) -> Vec<String> {
        self.cards.values().filter(|c| self.holder_of(&c.agent_device_id, c.session_id.as_deref()) == me && c.object_state == "open" && c.refused_head.unwrap_or(0) > c.envelope_number).map(|c| c.object_id.clone()).collect()
    }

    /// Stack, per-session open cards, open permissions.
    pub fn project(&mut self, ch: &mut Change) {
        let now = now_ms();
        let before = self.stack.clone();
        let before_perm = self.open_permission_ids.clone();
        let rank = |u: &str| match u { "critical" => 3, "high" => 2, "normal" => 1, "low" => 0, _ => 1 };
        let mut open: Vec<&Card> = self.cards.values().filter(|c| c.object_state == "open").collect();
        open.sort_by(|a, b| rank(&b.urgency).cmp(&rank(&a.urgency)).then(a.created_at.cmp(&b.created_at)).then(a.agent_device_id.cmp(&b.agent_device_id)).then(a.object_id.cmp(&b.object_id)));
        let archived: Vec<String> = self.sessions.values().filter(|s| s.settings.as_ref().and_then(|v| v.get("archived")).is_some_and(truthy)).map(|s| s.session_id.clone()).collect();
        self.stack = open.iter().filter(|c| !c.session_id.as_ref().is_some_and(|s| archived.contains(s))).map(|c| c.object_id.clone()).collect();
        let cards = &self.cards;
        for s in self.sessions.values_mut() {
            s.open_card_ids = s.card_ids.iter().filter(|id| cards.get(*id).is_some_and(|c| c.object_state == "open")).cloned().collect();
        }
        let mut pending: Vec<&Permission> = self.permissions.values().filter(|p| p.permission_state == "pending" && now <= p.expires_at).collect();
        pending.sort_by_key(|p| p.envelope_number);
        self.open_permission_ids = pending.iter().map(|p| p.object_id.clone()).collect();
        if before != self.stack || before_perm != self.open_permission_ids {
            ch.stack = true;
        }
    }
}

pub fn state_of(rec: &Rec) -> (&'static str, &'static str) {
    (
        rec.object.and_then(|o| codec::object_state_name(o.object_state)).unwrap_or("open"),
        rec.object.and_then(|o| codec::urgency_name(o.urgency)).unwrap_or("normal"),
    )
}
fn default_of(f: &str) -> Value {
    match f {
        "options" | "attachments" => json!([]),
        "allows_multiple" => json!(false),
        "card_type" => json!("decision"),
        "title" => json!(""),
        _ => Value::Null,
    }
}
fn default_card_content() -> Map<String, Value> {
    let mut m = Map::new();
    for f in CARD_CONTENT {
        m.insert(f.into(), default_of(f));
    }
    m
}
/// Every choice is an option the agent marked final (and there is at least one).
pub fn choices_final(card: &Card, choices: &[Value]) -> bool {
    let finals: Vec<String> = card.options().iter().filter(|o| o.get("final") == Some(&Value::Bool(true))).filter_map(|o| o.get("key").map(js_string)).collect();
    !choices.is_empty() && choices.iter().all(|k| k.as_str().is_some_and(|s| finals.iter().any(|f| f == s)))
}
pub fn content_type_known(c: &Map<String, Value>) -> bool {
    match c.get("content_type") {
        None | Some(Value::Null) => true,
        Some(v) => v.as_str().is_some_and(|s| codec::CONTENT_TYPES.contains(&s)),
    }
}
pub fn item_state_of(content: Option<&Map<String, Value>>, cs: &str) -> String {
    match content {
        Some(c) => {
            if cs != "ok" {
                cs.into()
            } else if content_type_known(c) {
                "loaded".into()
            } else {
                "unsupported".into()
            }
        }
        None => if ["pruned", "undecryptable", "newer_schema"].contains(&cs) { cs.into() } else { "header".into() },
    }
}
const HUMAN_PREFIXES: [&str; 7] = ["draft/", "snooze/", "duck/", "desk/", "session/", "session_history/", "scribble_snapshot/"];
pub fn is_human_key(k: &str) -> bool {
    k == "crown" || k == "room_snapshot" || HUMAN_PREFIXES.iter().any(|p| k.starts_with(p))
}
pub fn is_agent_key(k: &str) -> bool {
    k == "profile" || k == "heard" || k.starts_with("status_line/") || k.starts_with("alert/")
}
/// client.mjs's register key check (no session_history/ there).
pub fn is_human_register_key(k: &str) -> bool {
    k == "crown" || k == "room_snapshot" || ["draft/", "snooze/", "duck/", "desk/", "session/", "scribble_snapshot/"].iter().any(|p| k.starts_with(p))
}

/// A link report as the model keeps it.
pub fn clean_link(l: Option<&Value>) -> Option<Value> {
    let l = l?.as_object()?;
    let hears = l.get("hears")?.as_str()?;
    if hears != "live" && hears != "oncall" {
        return None;
    }
    let stamp = |v: Option<&Value>| v.and_then(|x| x.as_u64()).filter(|n| *n > 0 && *n <= crate::crypto::MAX_SAFE).map(Value::from).unwrap_or(Value::Null);
    let exit = l.get("exit").and_then(|e| e.as_object()).map(|e| {
        let reason: String = e.get("reason").map(js_string).unwrap_or_default().chars().take(40).collect();
        let claude = e.get("claude").and_then(|v| v.as_str()).filter(|c| ["alive", "gone", "checking"].contains(c)).unwrap_or("gone");
        json!({ "reason": reason, "claude": claude })
    });
    Some(json!({
        "hears": hears, "attached": l.get("attached") != Some(&Value::Bool(false)), "last_call_at": stamp(l.get("last_call_at")), "working": l.get("working") == Some(&Value::Bool(true)),
        "since": stamp(l.get("since")), "cut_since": stamp(l.get("cut_since")), "exit": exit.unwrap_or(Value::Null),
    }))
}
