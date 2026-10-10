//! What this agent knows of the board: its sessions (profile, status lines, the Desk's goals), its cards with
//! their answers, its permission requests and its Artifacts. The model is built from envelopes that took their
//! place in a chain (`vault.rs`), in the hub's order, and holds only what opened: an agent device reads its own
//! session groups and nothing of the room group.
//!
//! Ids are shown as the agent sees them: an object or session id as 32 hex digits, a device id as base64url, an
//! envelope's place as the hub's change number. Every record is stored as JSON under its own key and written
//! with the envelope that changed it.
use crate::util::{js_string, truthy};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use trommi_core::envelope::{Bind, Header, ObjectState, ObjectType, Subject, Timeline, Urgency};
use trommi_core::ids::Hash32;

/// A Desk's goals as an agent keeps them: at most this many lines of this many characters (9.3.3).
pub const GOALS_LINES: usize = 20;
/// See [`GOALS_LINES`].
pub const GOALS_LINE_MAX: usize = 200;

/// The urgencies by name, lowest first.
pub const URGENCIES: [&str; 4] = ["low", "normal", "high", "critical"];

/// An urgency's name.
pub fn urgency_name(urgency: Urgency) -> &'static str {
    URGENCIES[urgency.byte() as usize % 4]
}

/// The urgency a name stands for; normal for anything else.
pub fn urgency_of(name: &str) -> Urgency {
    match name {
        "low" => Urgency::Low,
        "high" => Urgency::High,
        "critical" => Urgency::Critical,
        _ => Urgency::Normal,
    }
}

fn state_name(state: ObjectState) -> &'static str {
    match state {
        ObjectState::Open => "open",
        ObjectState::Answered => "answered",
        ObjectState::Closed => "closed",
    }
}

/// One line of an agent's status strip.
#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
pub struct StatusLine {
    pub id: String,
    pub label: Value,
    pub state: Value,
    pub detail: Value,
    pub object_id: Value,
    pub envelope_number: u64,
    pub updated_at: u64,
}

/// One session this device is a leaf of: its main session, or a helper session it opened.
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Session {
    pub session_id: String,
    /// The main session a helper session hangs under; none for a main session.
    #[serde(default)]
    pub parent: Option<String>,
    /// The session's agent device, or a helper session's opener: the device a human addresses.
    #[serde(default)]
    pub agent_device_id: Option<String>,
    /// Every leaf that is not a human device.
    #[serde(default)]
    pub agent_device_ids: Vec<String>,
    /// The `profile` register: `model`, `task`, `icon`, `agent_name`, and what the board keeps beside them.
    #[serde(default)]
    pub profile: Option<Value>,
    #[serde(default)]
    pub status_lines: Vec<StatusLine>,
    /// The `goals` register a human device keeps for this session: `{ desk_id, desk_name, goals }`.
    #[serde(default)]
    pub desk_goals: Option<Value>,
    /// The `heard` register: the newest change of a human's message this agent has been handed.
    #[serde(default)]
    pub heard_up_to: Option<u64>,
}

/// A human's answer to a card.
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Answer {
    pub answer_action: String,
    pub choices: Vec<Value>,
    pub note: Value,
    pub option_notes: Value,
    pub attachments: Value,
    pub marks: Value,
    pub trusted: bool,
    /// The card's version the answer was given to.
    pub bound_object_version: u64,
    pub envelope_number: Option<u64>,
    pub envelope_hash: Option<String>,
    pub by_device_id: Option<String>,
    pub answered_at: u64,
    pub taken_back_at: Option<u64>,
}

impl Answer {
    /// The chosen keys as text.
    pub fn choice_strs(&self) -> Vec<String> {
        self.choices.iter().map(js_string).collect()
    }
}

/// A card the human handed back, or asked to have explained: it is with the agent until a new version or a
/// reply that presents it.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct InRevision {
    /// `handback` or `explain`.
    pub by: String,
    pub envelope_number: u64,
}

/// A Decision card or an Info card.
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Card {
    pub object_id: String,
    /// The device that wrote the current version.
    pub agent_device_id: String,
    /// `open`, `answered` or `closed`.
    pub object_state: String,
    pub urgency: String,
    pub object_version: u64,
    /// The current version's `envelope_hash`, base64url.
    pub version_hash: Option<String>,
    pub envelope_number: u64,
    pub first_envelope_number: u64,
    pub created_at: u64,
    pub session_id: Option<String>,
    pub updated_at: u64,
    /// The answer in force.
    pub answer: Option<Answer>,
    /// Every answer the card ever had, oldest first.
    pub answers: Vec<Answer>,
    /// How it left the stack: `answered`, `settled` (a final option), `read`, `shredded`, `closed`,
    /// `withdrawn`, `merged`.
    pub closed_how: Option<String>,
    pub in_revision: Option<InRevision>,
    /// The content fields of the current version (`card_type`, `title`, `body`, `options`, …).
    pub content: Map<String, Value>,
    /// The current version's payload as it was sealed: what the command gate holds an answer against. Empty
    /// when the current version's body did not open.
    #[serde(default)]
    pub payload: String,
    /// Whether the current version's content is not known (its body did not open): `content` is then what an
    /// earlier version said, for showing only.
    #[serde(default)]
    pub content_unknown: bool,
}

impl Card {
    /// A content field; null when absent.
    pub fn f(&self, k: &str) -> &Value {
        self.content.get(k).unwrap_or(&Value::Null)
    }
    /// A content field as text; empty when absent.
    pub fn s(&self, k: &str) -> String {
        match self.f(k) {
            Value::String(s) => s.clone(),
            Value::Null => String::new(),
            v => js_string(v),
        }
    }
    /// `decision` or `info`.
    pub fn card_type(&self) -> String {
        self.f("card_type")
            .as_str()
            .unwrap_or("decision")
            .to_string()
    }
    pub fn title(&self) -> String {
        self.s("title")
    }
    pub fn options(&self) -> Vec<Value> {
        self.f("options").as_array().cloned().unwrap_or_default()
    }
    pub fn option_keys(&self) -> Vec<String> {
        self.options()
            .iter()
            .map(|o| {
                o.get("key")
                    .map(js_string)
                    .unwrap_or_else(|| "undefined".into())
            })
            .collect()
    }
    pub fn allows_multiple(&self) -> bool {
        truthy(self.f("allows_multiple"))
    }
    /// The recommended keys as a list (empty for none).
    pub fn recommended_list(&self) -> Vec<String> {
        match self.f("recommended") {
            Value::Null => vec![],
            Value::Array(a) => a.iter().map(js_string).collect(),
            v => vec![js_string(v)],
        }
    }
    pub fn attachments(&self) -> Vec<Value> {
        self.f("attachments")
            .as_array()
            .cloned()
            .unwrap_or_default()
    }
}

/// Whether choosing these options closes the card by itself: every chosen option is marked `final`.
pub fn choices_final(card: &Card, choices: &[String]) -> bool {
    !choices.is_empty()
        && choices.iter().all(|choice| {
            card.options().iter().any(|o| {
                o.get("key").map(js_string).as_deref() == Some(choice)
                    && o.get("final") == Some(&Value::Bool(true))
            })
        })
}

/// A permission request of this agent.
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Permission {
    pub object_id: String,
    pub agent_device_id: String,
    pub session_id: Option<String>,
    pub tool_name: Value,
    pub description: Value,
    pub input_preview: Value,
    pub expires_at: u64,
    /// The request's `envelope_hash`, base64url.
    pub version_hash: String,
    pub envelope_number: u64,
    pub sent_at: u64,
    /// `pending`, `allowed` or `denied`.
    pub permission_state: String,
}

/// An Artifact: something this agent published.
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Published {
    pub object_id: String,
    pub agent_device_id: String,
    pub session_id: Option<String>,
    pub attachments: Value,
    pub title: Value,
    pub note: Value,
    pub artifact_type: Value,
    pub shared_until: Value,
    pub object_version: u64,
    pub version_hash: String,
    pub envelope_number: u64,
    pub object_state: String,
}

/// How this device stands with its room.
#[derive(Clone, Debug, Default)]
pub struct RoomInfo {
    /// The room, base64url.
    pub room_id: String,
    /// `connected`, `offline` or `removed`.
    pub connection: String,
    /// Whether another connector continues this device's session (a takeover).
    pub replaced: bool,
    /// Why nothing more is sent, when a chain of this device stopped for good.
    pub outbox_blocked: Option<String>,
}

/// An envelope as the model takes it.
pub struct Seen<'a> {
    /// The hub's change number.
    pub change: u64,
    /// The session of the envelope's group, as hex.
    pub session: &'a str,
    pub header: &'a Header,
    pub hash: Hash32,
    /// The opened payload, if the body opened and is a JSON object.
    pub payload: Option<&'a Map<String, Value>>,
    /// The payload's text, as sealed.
    pub raw: &'a str,
    pub bind: Option<&'a Bind>,
    /// Whether the sender is a human device.
    pub human: bool,
}

/// The board as this agent knows it.
#[derive(Default)]
pub struct Model {
    pub room: RoomInfo,
    pub sessions: BTreeMap<String, Session>,
    pub cards: BTreeMap<String, Card>,
    pub permissions: BTreeMap<String, Permission>,
    pub published: BTreeMap<String, Published>,
    /// The open cards as the human's stack shows them: most urgent first, then oldest first.
    pub stack: Vec<String>,
    /// What changed since the last [`Model::take_dirty`]: `card/<id>`, `session/<id>`, `perm/<id>`, `pub/<id>`.
    dirty: BTreeSet<String>,
}

/// The lines of a Desk's goals, cleaned and bounded.
pub fn clean_goals(text: &str) -> String {
    text.lines()
        .map(|l| l.trim().chars().take(GOALS_LINE_MAX).collect::<String>())
        .filter(|l| !l.is_empty())
        .take(GOALS_LINES)
        .collect::<Vec<_>>()
        .join("\n")
}

/// The value of the `goals` register as an agent keeps it: `{ desk_id, desk_name, goals }`, or none for none.
pub fn desk_goals_of(value: &Value) -> Option<Value> {
    let goals = clean_goals(value.get("goals").and_then(|g| g.as_str()).unwrap_or(""));
    if goals.is_empty() {
        return None;
    }
    let short = |k: &str, max: usize| {
        value
            .get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .chars()
            .take(max)
            .collect::<String>()
    };
    Some(
        serde_json::json!({ "desk_id": short("desk_id", 64), "desk_name": short("desk_name", 80), "goals": goals }),
    )
}

impl Model {
    /// An empty model.
    pub fn new() -> Self {
        Self::default()
    }

    /// The session record, made if it is new.
    pub fn session_of(&mut self, sid: &str) -> &mut Session {
        self.dirty.insert(format!("session/{sid}"));
        self.sessions
            .entry(sid.to_string())
            .or_insert_with(|| Session {
                session_id: sid.to_string(),
                ..Default::default()
            })
    }

    /// Who holds an object now (9.2): the device that wrote its current version while it is a leaf of the
    /// session, else the session's agent device (a helper session's opener).
    pub fn holder_of(&self, agent: &str, session_id: Option<&str>) -> String {
        let Some(session) = session_id.and_then(|sid| self.sessions.get(sid)) else {
            return agent.to_string();
        };
        if session.agent_device_ids.iter().any(|leaf| leaf == agent) {
            return agent.to_string();
        }
        session
            .agent_device_id
            .clone()
            .unwrap_or_else(|| agent.to_string())
    }

    /// Forgets everything of one session: its envelopes are read again.
    pub fn forget_session(&mut self, sid: &str) -> Vec<String> {
        let mut gone = Vec::new();
        let of = |s: &Option<String>| s.as_deref() == Some(sid);
        self.cards.retain(|id, card| {
            let keep = !of(&card.session_id);
            if !keep {
                gone.push(format!("card/{id}"));
            }
            keep
        });
        self.permissions.retain(|id, p| {
            let keep = !of(&p.session_id);
            if !keep {
                gone.push(format!("perm/{id}"));
            }
            keep
        });
        self.published.retain(|id, p| {
            let keep = !of(&p.session_id);
            if !keep {
                gone.push(format!("pub/{id}"));
            }
            keep
        });
        if let Some(session) = self.sessions.get_mut(sid) {
            session.profile = None;
            session.status_lines.clear();
            session.desk_goals = None;
            session.heard_up_to = None;
            self.dirty.insert(format!("session/{sid}"));
        }
        self.project();
        gone
    }

    /// Holds a card against the object as the device holds it (9.2.1): its state, and whether the version the
    /// model shows is the current one. A card the device does not hold is not one.
    pub fn reconcile_card(&mut self, id: &str, object: Option<&trommi_core::objects::Object>) {
        let Some(object) = object else {
            if self.cards.remove(id).is_some() {
                self.dirty.insert(format!("card/{id}"));
                self.project();
            }
            return;
        };
        let Some(card) = self.cards.get_mut(id) else {
            return;
        };
        let state = state_name(object.state);
        let current = object.current.to_base64url();
        if card.object_state != state || card.version_hash.as_deref() != Some(current.as_str()) {
            if card.version_hash.as_deref() != Some(current.as_str()) {
                // A version this connector could not read is the current one.
                card.version_hash = Some(current);
                card.payload = String::new();
                card.content_unknown = true;
            }
            card.object_state = state.into();
            if state == "open" {
                card.answer = None;
                card.closed_how = None;
            }
            self.dirty.insert(format!("card/{id}"));
            self.project();
        }
    }

    /// The names of the records that changed since the last call.
    pub fn take_dirty(&mut self) -> BTreeSet<String> {
        std::mem::take(&mut self.dirty)
    }

    /// A record's stored form, by its name; none if it is gone.
    pub fn record(&self, name: &str) -> Option<Vec<u8>> {
        let (kind, id) = name.split_once('/')?;
        let json = match kind {
            "card" => serde_json::to_vec(self.cards.get(id)?),
            "session" => serde_json::to_vec(self.sessions.get(id)?),
            "perm" => serde_json::to_vec(self.permissions.get(id)?),
            "pub" => serde_json::to_vec(self.published.get(id)?),
            _ => return None,
        };
        json.ok()
    }

    /// Takes a stored record back in. False when it does not read.
    pub fn load(&mut self, name: &str, bytes: &[u8]) -> bool {
        let Some((kind, id)) = name.split_once('/') else {
            return false;
        };
        let id = id.to_string();
        match kind {
            "card" => serde_json::from_slice(bytes).map(|v| {
                self.cards.insert(id, v);
            }),
            "session" => serde_json::from_slice(bytes).map(|v| {
                self.sessions.insert(id, v);
            }),
            "perm" => serde_json::from_slice(bytes).map(|v| {
                self.permissions.insert(id, v);
            }),
            "pub" => serde_json::from_slice(bytes).map(|v| {
                self.published.insert(id, v);
            }),
            _ => return false,
        }
        .is_ok()
    }

    /// Orders the stack again.
    pub fn project(&mut self) {
        let rank = |u: &str| URGENCIES.iter().position(|x| *x == u).unwrap_or(1);
        let mut open: Vec<&Card> = self
            .cards
            .values()
            .filter(|c| c.object_state == "open")
            .collect();
        open.sort_by_key(|c| (std::cmp::Reverse(rank(&c.urgency)), c.first_envelope_number));
        self.stack = open.iter().map(|c| c.object_id.clone()).collect();
    }

    /// Applies one envelope that passed its checks and whose object transition, if it has one, was taken.
    pub fn apply(&mut self, seen: &Seen<'_>) {
        let sender = seen.header.sender.to_base64url();
        let hash = seen.hash.to_base64url();
        let empty = Map::new();
        let content = seen.payload.unwrap_or(&empty);
        match &seen.header.subject {
            Subject::Version(fields) if fields.object_type == ObjectType::Card => {
                let id = crate::util::hex(fields.object_id.as_bytes());
                self.dirty.insert(format!("card/{id}"));
                let card = self.cards.entry(id.clone()).or_insert_with(|| Card {
                    object_id: id,
                    first_envelope_number: seen.change,
                    created_at: seen.header.time,
                    session_id: Some(seen.session.to_string()),
                    ..Default::default()
                });
                card.agent_device_id = sender;
                card.object_state = state_name(fields.state).into();
                card.urgency = urgency_name(fields.urgency).into();
                card.version_hash = Some(hash);
                card.envelope_number = seen.change;
                card.updated_at = seen.header.time;
                card.in_revision = None;
                if seen.payload.is_some() {
                    card.object_version = content
                        .get("object_version")
                        .and_then(Value::as_u64)
                        .unwrap_or(card.object_version + 1);
                    card.content = content.clone();
                    card.payload = seen.raw.to_string();
                    card.content_unknown = false;
                } else {
                    // The body did not open (pruned, or no key): the version counts, its content is not
                    // known, and what the version before said is no longer the card.
                    card.object_version += 1;
                    card.payload = String::new();
                    card.content_unknown = true;
                }
                if fields.state == ObjectState::Closed {
                    card.closed_how = Some(
                        if truthy(card.f("merged_into_object_id")) {
                            "merged"
                        } else if !card.f("withdraw_reason").is_null() {
                            "withdrawn"
                        } else if card.answer.is_some() {
                            "answered"
                        } else {
                            "closed"
                        }
                        .into(),
                    );
                }
            }
            Subject::Version(fields) if fields.object_type == ObjectType::Artifact => {
                let id = crate::util::hex(fields.object_id.as_bytes());
                self.dirty.insert(format!("pub/{id}"));
                let p = self
                    .published
                    .entry(id.clone())
                    .or_insert_with(|| Published {
                        object_id: id,
                        session_id: Some(seen.session.to_string()),
                        ..Default::default()
                    });
                p.agent_device_id = sender;
                p.object_state = state_name(fields.state).into();
                p.version_hash = hash;
                p.envelope_number = seen.change;
                p.object_version += 1;
                if seen.payload.is_some() {
                    let field = |k: &str| content.get(k).cloned().unwrap_or(Value::Null);
                    p.attachments = field("attachments");
                    p.title = field("title");
                    p.note = field("note");
                    p.artifact_type = field("artifact_type");
                    p.shared_until = field("shared_until");
                }
            }
            Subject::Request(fields) => {
                let id = crate::util::hex(fields.object_id.as_bytes());
                self.dirty.insert(format!("perm/{id}"));
                let expires_at = match seen.bind {
                    Some(Bind::Request(bind)) => bind.expires_at,
                    _ => 0,
                };
                let field = |k: &str| content.get(k).cloned().unwrap_or(Value::Null);
                self.permissions.insert(
                    id.clone(),
                    Permission {
                        object_id: id,
                        agent_device_id: sender,
                        session_id: Some(seen.session.to_string()),
                        tool_name: field("tool_name"),
                        description: field("description"),
                        input_preview: field("input_preview"),
                        expires_at,
                        version_hash: hash,
                        envelope_number: seen.change,
                        sent_at: seen.header.time,
                        permission_state: "pending".into(),
                    },
                );
            }
            Subject::Answer(fields) => {
                let id = crate::util::hex(fields.object_id.as_bytes());
                let Some(card) = self.cards.get_mut(&id) else {
                    return;
                };
                self.dirty.insert(format!("card/{id}"));
                let field = |k: &str| content.get(k).cloned().unwrap_or(Value::Null);
                let action = content
                    .get("answer_action")
                    .and_then(Value::as_str)
                    .unwrap_or("answer")
                    .to_string();
                let choices: Vec<Value> = match seen.bind {
                    Some(Bind::Answer(bind)) => bind
                        .choices
                        .iter()
                        .map(|c| Value::String(String::from_utf8_lossy(c).into_owned()))
                        .collect(),
                    _ => vec![],
                };
                let answer = Answer {
                    answer_action: action.clone(),
                    choices,
                    note: field("note"),
                    option_notes: field("option_notes"),
                    attachments: field("attachments"),
                    marks: field("marks"),
                    trusted: content.get("trusted").is_some_and(truthy),
                    bound_object_version: card.object_version,
                    envelope_number: Some(seen.change),
                    envelope_hash: Some(hash),
                    by_device_id: Some(sender),
                    answered_at: if fields.answered_at > 0 {
                        fields.answered_at
                    } else {
                        seen.header.time
                    },
                    taken_back_at: None,
                };
                card.object_state = state_name(fields.state).into();
                card.closed_how = Some(
                    match (action.as_str(), fields.state) {
                        ("read", _) => "read",
                        ("shred", _) => "shredded",
                        (_, ObjectState::Closed) => "settled",
                        _ => "answered",
                    }
                    .into(),
                );
                card.envelope_number = seen.change;
                card.updated_at = seen.header.time;
                card.in_revision = None;
                card.answers.push(answer.clone());
                card.answer = Some(answer);
            }
            Subject::TakeBack(fields) => {
                let id = crate::util::hex(fields.object_id.as_bytes());
                let Some(card) = self.cards.get_mut(&id) else {
                    return;
                };
                self.dirty.insert(format!("card/{id}"));
                if let Some(last) = card.answers.last_mut() {
                    last.taken_back_at = Some(seen.header.time);
                }
                card.answer = None;
                card.closed_how = None;
                card.object_state = state_name(fields.state).into();
                card.envelope_number = seen.change;
                card.updated_at = seen.header.time;
            }
            Subject::Verdict(fields) => {
                let id = crate::util::hex(fields.object_id.as_bytes());
                if let (Some(p), Some(Bind::Verdict(bind))) =
                    (self.permissions.get_mut(&id), seen.bind)
                {
                    self.dirty.insert(format!("perm/{id}"));
                    p.permission_state = match bind.verdict {
                        trommi_core::envelope::Verdict::Allow => "allowed",
                        trommi_core::envelope::Verdict::Deny => "denied",
                    }
                    .into();
                }
            }
            Subject::Item(Timeline::CardChat(object)) => {
                let id = crate::util::hex(object.as_bytes());
                let Some(card) = self.cards.get_mut(&id) else {
                    return;
                };
                let turn = |k: &str| content.get(k).is_some_and(truthy);
                if seen.human && (turn("hand_back") || turn("explain")) {
                    card.in_revision = Some(InRevision {
                        by: if turn("explain") {
                            "explain"
                        } else {
                            "handback"
                        }
                        .into(),
                        envelope_number: seen.change,
                    });
                    self.dirty.insert(format!("card/{id}"));
                } else if !seen.human && turn("present_card") {
                    card.in_revision = None;
                    self.dirty.insert(format!("card/{id}"));
                }
            }
            _ => {}
        }
        self.project();
    }

    /// Applies a register value of a session group that became the current one. `human` says whether its
    /// writer is a human device; each name is taken only from the role that owns it, which the core judged.
    pub fn apply_register(
        &mut self,
        session: &str,
        name: &str,
        value: Option<&str>,
        change: u64,
        time: u64,
    ) {
        let parsed: Option<Value> = value.and_then(|text| serde_json::from_str(text).ok());
        let record = self.session_of(session);
        if name == "profile" {
            record.profile = parsed.filter(Value::is_object);
        } else if name == "goals" {
            record.desk_goals = parsed.as_ref().and_then(desk_goals_of);
        } else if name == "heard" {
            record.heard_up_to = parsed.as_ref().and_then(|v| {
                v.as_u64()
                    .or_else(|| v.get("up_to").and_then(Value::as_u64))
            });
        } else if let Some(id) = name.strip_prefix("status_line/") {
            record.status_lines.retain(|line| line.id != id);
            if let Some(v) = parsed.filter(Value::is_object) {
                let field = |k: &str| v.get(k).cloned().unwrap_or(Value::Null);
                record.status_lines.push(StatusLine {
                    id: id.to_string(),
                    label: field("label"),
                    state: field("state"),
                    detail: field("detail"),
                    object_id: field("object_id"),
                    envelope_number: change,
                    updated_at: time,
                });
            }
        }
    }
}
