//! codec.mjs: the encrypted body's payload (UTF-8 JSON, schema_version 1), the names of header values, attachment
//! references.
use crate::crypto::{self, b64u, hex};
use crate::error::{fail, Result};
use serde_json::{json, Map, Value};

pub const SCHEMA_VERSION: i64 = 1;
pub const KIND_TIMELINE_ITEM: u8 = 1;
pub const KIND_OBJECT_VERSION: u8 = 2;
pub const KIND_ANSWER: u8 = 3;
pub const KIND_PERMISSION_REQUEST: u8 = 4;
pub const KIND_VERDICT: u8 = 5;
pub const KIND_STATUS: u8 = 6;
pub const KIND_DECIDE_AGAIN: u8 = 7;

pub fn kind_name(k: u8) -> &'static str {
    match k {
        1 => "timeline_item",
        2 => "object_version",
        3 => "answer",
        4 => "permission_request",
        5 => "verdict",
        6 => "status",
        7 => "decide_again",
        8 => "scribble",
        _ => "",
    }
}
pub fn object_state_name(n: u8) -> Option<&'static str> {
    match n {
        1 => Some("open"),
        2 => Some("answered"),
        3 => Some("closed"),
        _ => None,
    }
}
pub fn object_state_num(s: &str) -> Option<u8> {
    match s {
        "open" => Some(1),
        "answered" => Some(2),
        "closed" => Some(3),
        _ => None,
    }
}
pub fn urgency_name(n: u8) -> Option<&'static str> {
    match n {
        0 => Some("low"),
        1 => Some("normal"),
        2 => Some("high"),
        3 => Some("critical"),
        _ => None,
    }
}
pub fn urgency_num(s: &str) -> Option<u8> {
    match s {
        "low" => Some(0),
        "normal" => Some(1),
        "high" => Some(2),
        "critical" => Some(3),
        _ => None,
    }
}
pub fn timeline_kind_name(n: u8) -> String {
    match n {
        1 => "chat".into(),
        2 => "scribble".into(),
        n => n.to_string(),
    }
}
pub fn timeline_kind_num(s: &str) -> Option<u8> {
    match s {
        "chat" => Some(1),
        "scribble" => Some(2),
        s => s.parse().ok(),
    }
}

/// Body fields per kind (besides schema_version), the README names.
pub fn fields(name: &str) -> Option<&'static [&'static str]> {
    Some(match name {
        "message" => &["content_type", "text", "details", "html", "attachments", "hand_back", "explain", "present_card", "copied_cards", "marks", "published_object_id", "note"],
        "strokes" => &["content_type", "strokes", "attachments"],
        "erase" | "move" | "send_away" => &["content_type", "stroke_ids", "offset"],
        "selection_sent" => &["content_type", "text", "attachments", "stroke_ids", "board"],
        "card" => &["object_type", "object_version", "previous_version_hash", "card_type", "title", "teaser", "body", "options", "sections", "html", "allows_multiple",
            "recommended", "urgency_reason", "attachments", "change_note", "close_summary", "withdraw_reason", "merged_into_object_id", "merged_from_object_ids"],
        "note" => &["object_type", "object_version", "previous_version_hash", "text"],
        "published" => &["object_type", "object_version", "previous_version_hash", "attachments", "title", "note", "released_until"],
        "answer" => &["answer_action", "choices", "note", "option_notes", "attachments", "marks", "trusted"],
        "permission_request" => &["tool_name", "description", "input_preview", "withdraw_reason"],
        "verdict" => &[],
        "status" => &["values", "lamport"],
        "decide_again" => &[],
        _ => return None,
    })
}
pub fn card_content_fields() -> &'static [&'static str] {
    &fields("card").unwrap()[3..]
}
pub const CONTENT_TYPES: [&str; 6] = ["message", "strokes", "erase", "move", "send_away", "selection_sent"];
pub const OBJECT_TYPES: [&str; 3] = ["card", "note", "published"];
pub const CARD_TYPES: [&str; 2] = ["decision", "info"];
pub const ANSWER_ACTIONS: [&str; 3] = ["answer", "read", "shred"];
pub const UPDATE_MESSAGE: &str = "This needs a newer version of Trommi. Update to see it.";
pub const TEASER_MAX: usize = 160;

pub fn teaser_valid(t: &Value) -> bool {
    let Some(s) = t.as_str() else { return false };
    !s.is_empty() && s == js_trim(s) && s.chars().count() <= TEASER_MAX && !s.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f)
}
/// JavaScript's String.prototype.trim (Unicode white space and line terminators).
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

fn is_hex32(s: &str) -> bool {
    crypto::is_hex(s, 32)
}

pub fn note_ref_valid(m: &Value) -> bool {
    let Some(o) = m.as_object() else { return false };
    if o.keys().any(|k| k != "object_id" && k != "written_at") {
        return false;
    }
    if !o.get("object_id").and_then(|v| v.as_str()).is_some_and(is_hex32) {
        return false;
    }
    match o.get("written_at") {
        None | Some(Value::Null) => true,
        Some(v) => v.as_f64().is_some_and(|n| n >= 0.0 && n.fract() == 0.0 && n <= crypto::MAX_SAFE as f64),
    }
}

/// encodePayload(kind, content): the README fields of the kind (notes pass through), schema_version first.
pub fn encode_payload(kind: u8, content: &Map<String, Value>) -> Result<Vec<u8>> {
    let mut content = content.clone();
    let obj_type = content.get("object_type").and_then(|v| v.as_str()).map(String::from);
    if kind == KIND_OBJECT_VERSION && obj_type.as_deref() == Some("card") {
        if let Some(Value::Array(opts)) = content.get_mut("options") {
            for o in opts.iter_mut() {
                if let Some(m) = o.as_object_mut() {
                    if m.get("final").is_some_and(|f| *f != Value::Bool(true)) {
                        m.remove("final");
                    }
                }
            }
        }
        if let Some(t) = content.get("teaser") {
            if !t.is_null() && !teaser_valid(t) {
                return fail("bad-argument", format!("teaser must be plain one-paragraph text, trimmed, at most {TEASER_MAX} characters"));
            }
        }
    }
    if kind == KIND_TIMELINE_ITEM && content.get("content_type").and_then(|v| v.as_str()) == Some("message") {
        if let Some(n) = content.get("note") {
            if !note_ref_valid(n) {
                return fail("bad-argument", "note must be { object_id: 32 hex, written_at?: ms }");
            }
        }
    }
    let list: Option<&[&str]> = match kind {
        KIND_TIMELINE_ITEM => {
            let ct = content.get("content_type").and_then(|v| v.as_str()).unwrap_or("");
            match fields(ct).filter(|f| f.first() == Some(&"content_type")) {
                Some(f) => Some(f),
                None => return fail("bad-argument", format!("unknown content_type {ct}")),
            }
        }
        KIND_OBJECT_VERSION => match obj_type.as_deref() {
            Some("note") => None,
            Some(t) if OBJECT_TYPES.contains(&t) => fields(t),
            t => return fail("bad-argument", format!("unknown object_type {}", t.unwrap_or("undefined"))),
        },
        k => fields(kind_name(k)),
    };
    let mut out = Map::new();
    out.insert("schema_version".into(), json!(SCHEMA_VERSION));
    match list {
        None => {
            for (k, v) in content {
                if k != "schema_version" {
                    out.insert(k, v);
                }
            }
        }
        Some(f) => {
            for k in f {
                if let Some(v) = content.get(*k) {
                    out.insert((*k).to_string(), v.clone());
                }
            }
        }
    }
    Ok(serde_json::to_vec(&Value::Object(out))?)
}

/// -> (content, content_state 'ok' | 'newer_schema' | 'undecryptable')
pub fn decode_payload(bytes: &[u8]) -> (Option<Map<String, Value>>, &'static str) {
    let Ok(text) = std::str::from_utf8(bytes) else { return (None, "undecryptable") };
    if text.starts_with('\u{feff}') {
        return (None, "undecryptable");
    }
    let Ok(Value::Object(mut content)) = serde_json::from_str::<Value>(text) else { return (None, "undecryptable") };
    if !attachment_ids_valid(&Value::Object(content.clone()), 0) {
        return (None, "undecryptable");
    }
    if content.get("schema_version").and_then(|v| v.as_f64()).is_some_and(|v| v > SCHEMA_VERSION as f64) {
        return (Some(content), "newer_schema");
    }
    if content.get("content_type").and_then(|v| v.as_str()) == Some("message") && content.get("note").is_some_and(|n| !note_ref_valid(n)) {
        content.remove("note");
    }
    if content.get("object_type").and_then(|v| v.as_str()) == Some("card") {
        if content.get("teaser").is_some_and(|t| !t.is_null() && !teaser_valid(t)) {
            content.remove("teaser");
        }
        if let Some(Value::Array(opts)) = content.get_mut("options") {
            for o in opts.iter_mut() {
                if let Some(m) = o.as_object_mut() {
                    if m.get("final").is_some_and(|f| *f != Value::Bool(true)) {
                        m.remove("final");
                    }
                }
            }
        }
    }
    (Some(content), "ok")
}

pub fn attachment_ids_valid(content: &Value, depth: usize) -> bool {
    if depth > 32 {
        return false;
    }
    match content {
        Value::Array(a) => a.iter().all(|v| attachment_ids_valid(v, depth + 1)),
        Value::Object(o) => {
            for (k, v) in o {
                if (k == "attachment_id" || k == "poster_attachment_id") && !v.is_null() && !v.as_str().is_some_and(is_hex32) {
                    return false;
                }
                if (v.is_object() || v.is_array()) && !attachment_ids_valid(v, depth + 1) {
                    return false;
                }
            }
            true
        }
        _ => true,
    }
}

/// The attachment ids a body references (they go into the header's blob list), in first-seen order.
pub fn attachment_ids_of(content: &Map<String, Value>) -> Vec<String> {
    let mut ids: Vec<String> = vec![];
    let mut add = |list: &Value| {
        if let Some(a) = list.as_array() {
            for r in a {
                if let Some(id) = r.get("attachment_id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                    if !ids.contains(&id.to_string()) {
                        ids.push(id.to_string());
                    }
                    if let Some(p) = r.get("poster_attachment_id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                        if !ids.contains(&p.to_string()) {
                            ids.push(p.to_string());
                        }
                    }
                }
            }
        }
    };
    if let Some(a) = content.get("attachments") {
        add(a);
    }
    if let Some(Value::Object(values)) = content.get("values") {
        for v in values.values() {
            if let Some(att) = v.get("attachment") {
                if att.get("attachment_id").and_then(|x| x.as_str()).is_some_and(|s| !s.is_empty()) {
                    add(&Value::Array(vec![att.clone()]));
                }
            }
        }
    }
    ids
}

pub const ATTACHMENT_FIELDS: [&str; 12] = ["attachment_id", "file_key", "sha256", "file_name", "media_type", "total_size", "width", "height", "caption", "page", "poster_attachment_id", "marks"];

/// The README attachment reference from an encrypted asset.
pub fn attachment_ref(asset: &crypto::Asset, meta: &Map<String, Value>) -> Map<String, Value> {
    let mut r = Map::new();
    r.insert("attachment_id".into(), json!(hex(&asset.blob_id)));
    r.insert("file_key".into(), json!(b64u(&asset.key)));
    r.insert("sha256".into(), json!(b64u(&asset.sha256)));
    r.insert("total_size".into(), json!(asset.size));
    for f in ATTACHMENT_FIELDS {
        if let Some(v) = meta.get(f) {
            if !r.contains_key(f) {
                r.insert(f.into(), v.clone());
            }
        }
    }
    r
}

/// A bind's byte fields as hex (what the reducer compares).
#[derive(Clone, Debug, Default)]
pub struct BindHex {
    pub card_id: Option<String>,
    pub version_hash: Option<String>,
    pub choices: Option<Vec<String>>,
    pub previous_hash: Option<String>,
    pub request_id: Option<String>,
    pub request_hash: Option<String>,
    pub expires_at: Option<u64>,
    pub allow: Option<bool>,
}
pub fn decode_bind_for(kind: u8, bind: &[u8]) -> Option<BindHex> {
    if ![KIND_ANSWER, KIND_PERMISSION_REQUEST, KIND_VERDICT, KIND_DECIDE_AGAIN].contains(&kind) {
        return None;
    }
    let b = crypto::decode_bind(kind, bind).ok()?;
    Some(match b {
        crypto::Bind::Answer { object_id, version_hash, choices } => BindHex { card_id: Some(hex(&object_id)), version_hash: Some(hex(&version_hash)), choices: Some(choices), ..Default::default() },
        crypto::Bind::DecideAgain { object_id, previous_hash, version_hash } => BindHex { card_id: Some(hex(&object_id)), previous_hash: Some(hex(&previous_hash)), version_hash: Some(hex(&version_hash)), ..Default::default() },
        crypto::Bind::Request { request_id, expires_at } => BindHex { request_id: Some(hex(&request_id)), expires_at: Some(expires_at), ..Default::default() },
        crypto::Bind::Verdict { request_id, request_hash, expires_at, allow } => BindHex { request_id: Some(hex(&request_id)), request_hash: Some(hex(&request_hash)), expires_at: Some(expires_at), allow: Some(allow), ..Default::default() },
    })
}
