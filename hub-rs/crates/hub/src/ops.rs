//! hub/ops: client versions (426), write admission (503), test rooms, the attachment quota, the WAL keeper.

use crate::config::Config;
use crate::error::{Fail, HResult};
use crate::stream::Client;
use crate::util::now;
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

// ---- versions ------------------------------------------------------------------------------------

pub const PROTOCOL_VERSIONS: [i64; 1] = [1];
const KINDS: [&str; 3] = ["app", "connector", "ios"];

fn semver(s: &str) -> Option<[u64; 3]> {
    // ^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+][0-9A-Za-z.-]*)?$
    let (core, rest) = match s.find(['-', '+']) {
        Some(i) => (&s[..i], Some(&s[i + 1..])),
        None => (s, None),
    };
    if let Some(r) = rest {
        if !r.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-') {
            return None;
        }
    }
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let mut out = [0u64; 3];
    for (i, p) in parts.iter().enumerate() {
        if p.is_empty() || p.len() > 6 || !p.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        out[i] = p.parse().ok()?;
    }
    Some(out)
}
pub fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering { semver(a).unwrap_or([0; 3]).cmp(&semver(b).unwrap_or([0; 3])) }

/// `Trommi-Client` header -> { kind, version } or None.
pub fn parse_client(h: Option<&str>) -> Option<Client> {
    let t = h?.trim();
    let (kind, version) = t.split_once('/')?;
    if kind.is_empty() || !kind.bytes().all(|c| c.is_ascii_lowercase()) || version.is_empty() || version.chars().any(char::is_whitespace) {
        return None;
    }
    if !KINDS.contains(&kind) || semver(version).is_none() {
        return None;
    }
    Some(Client { kind: kind.into(), version: version.into() })
}

pub struct Versions {
    pub minimum: Mutex<Vec<(String, String)>>,
    pub recommended: Mutex<Vec<(String, String)>>,
    pub message: Mutex<String>,
    formats: (u64, u64),
    unnamed: Mutex<(i64, u64)>,
}
fn from_env(cfg: &Config, prefix: &str) -> Vec<(String, String)> {
    KINDS.iter().filter_map(|k| cfg.get(&format!("{prefix}{}", k.to_uppercase())).filter(|v| semver(v).is_some()).map(|v| (k.to_string(), v.to_string()))).collect()
}
fn write_level(cfg: &Config, name: &str) -> u64 {
    match cfg.env.get(name) {
        Some(v) if !v.is_empty() && v.len() <= 3 && v.as_bytes()[0] != b'0' && v.bytes().all(|c| c.is_ascii_digit()) => v.parse().unwrap_or(1),
        _ => 1,
    }
}
fn obj(list: &[(String, String)]) -> Value { Value::Object(list.iter().map(|(k, v)| (k.clone(), json!(v))).collect::<Map<_, _>>()) }

impl Versions {
    pub fn new(cfg: &Config) -> Versions {
        Versions {
            minimum: Mutex::new(from_env(cfg, "HUB_MIN_")),
            recommended: Mutex::new(from_env(cfg, "HUB_RECOMMENDED_")),
            message: Mutex::new(cfg.get("HUB_UPGRADE_MESSAGE").unwrap_or("").to_string()),
            formats: (write_level(cfg, "HUB_WRITE_ENVELOPE_VERSION"), write_level(cfg, "HUB_WRITE_SCHEMA_VERSION")),
            unnamed: Mutex::new((0, 0)),
        }
    }
    pub fn info(&self) -> Value {
        let mut v = json!({
            "protocol_versions_supported": PROTOCOL_VERSIONS,
            "minimum_client_versions": obj(&self.minimum.lock()),
            "recommended_client_versions": obj(&self.recommended.lock()),
            "write_format_versions": { "envelope": self.formats.0, "schema": self.formats.1 },
        });
        let m = self.message.lock().clone();
        if !m.is_empty() {
            v.as_object_mut().unwrap().insert("message".into(), json!(m));
        }
        v
    }
    fn min_of(&self, kind: &str) -> Option<String> { self.minimum.lock().iter().find(|(k, _)| k == kind).map(|x| x.1.clone()) }
    pub fn too_old(&self, c: Option<&Client>) -> bool {
        let Some(c) = c else { return false };
        match self.min_of(&c.kind) {
            Some(m) => compare_versions(&c.version, &m) == std::cmp::Ordering::Less,
            None => false,
        }
    }
    pub fn upgrade_body(&self, c: &Client) -> Value {
        let min = self.min_of(&c.kind).unwrap_or_default();
        let m = self.message.lock().clone();
        json!({ "minimum_version": min, "message": if m.is_empty() { format!("Please update Trommi ({}) to {} or newer.", c.kind, min) } else { m } })
    }
    pub fn check(&self, protocol: Option<&str>, client: Option<&str>, log: &dyn Fn(&str)) -> HResult<Option<Client>> {
        if let Some(p) = protocol {
            let n = crate::util::js_number_int(p);
            if !n.is_some_and(|n| PROTOCOL_VERSIONS.iter().any(|&v| v as f64 == n)) {
                let shown: String = p.chars().take(10).collect();
                return Err(Fail::reply(400, "bad-version", &format!("this hub speaks protocol {}, not {}", PROTOCOL_VERSIONS.map(|v| v.to_string()).join(", "), shown), json!({})));
            }
        }
        let c = parse_client(client);
        let Some(c) = c else {
            let mut u = self.unnamed.lock();
            u.1 += 1;
            if now() - u.0 > 60000 {
                log(&format!("{} request(s) without a Trommi-Client header in the last minute", u.1));
                *u = (now(), 0);
            }
            return Ok(None);
        };
        if self.too_old(Some(&c)) {
            let b = self.upgrade_body(&c);
            return Err(Fail::reply(426, "client-too-old", b["message"].as_str().unwrap(), json!({ "minimum_version": b["minimum_version"] })));
        }
        Ok(Some(c))
    }
    /// Change minimum/recommended/message at run time.
    pub fn update(&self, next: &Value) {
        let list = |v: &Value| -> Vec<(String, String)> { v.as_object().map(|o| o.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect()).unwrap_or_default() };
        if let Some(m) = next.get("minimum").filter(|v| !v.is_null()) {
            *self.minimum.lock() = list(m);
        }
        if let Some(r) = next.get("recommended").filter(|v| !v.is_null()) {
            *self.recommended.lock() = list(r);
        }
        if let Some(m) = next.get("message").and_then(|v| v.as_str()) {
            *self.message.lock() = m.to_string();
        }
    }
}

// ---- write admission -------------------------------------------------------------------------------

pub struct Flow {
    max_writes: usize,
    max_membership: usize,
    max_per_ip: usize,
    pub writes: AtomicUsize,
    pub membership: AtomicUsize,
    per_ip: Mutex<HashMap<String, usize>>,
    pub refused_writes: AtomicU64,
    pub refused_per_ip: AtomicU64,
    pub dropped_streams: Arc<AtomicU64>,
}
pub struct Slot {
    flow: Arc<Flow>,
    membership: bool,
    ip: String,
}
impl Drop for Slot {
    fn drop(&mut self) {
        if self.membership {
            self.flow.membership.fetch_sub(1, Ordering::AcqRel);
        } else {
            self.flow.writes.fetch_sub(1, Ordering::AcqRel);
        }
        let mut m = self.flow.per_ip.lock();
        let n = m.get(&self.ip).copied().unwrap_or(1).saturating_sub(1);
        if n > 0 {
            m.insert(self.ip.clone(), n);
        } else {
            m.remove(&self.ip);
        }
    }
}
pub fn is_membership_write(method: &str, path: &str) -> bool {
    if method != "POST" {
        return false;
    }
    let Some(rest) = path.strip_prefix("/v1/rooms/") else { return false };
    if rest.len() < 65 || !zcrypto::bytes::is_hex(&rest[..64], 64) || rest.as_bytes()[64] != b'/' {
        return false;
    }
    let tail = &rest[65..];
    tail == "members" || tail == "session_grants" || (tail.starts_with("sessions/") && tail.ends_with("/grants") && {
        let mid = &tail[9..tail.len() - 7];
        !mid.is_empty() && !mid.contains('/')
    })
}
impl Flow {
    pub fn new(cfg: &Config) -> Arc<Flow> {
        Arc::new(Flow {
            max_writes: cfg.write_queue as usize,
            max_membership: cfg.write_queue_membership as usize,
            max_per_ip: cfg.write_per_ip as usize,
            writes: AtomicUsize::new(0),
            membership: AtomicUsize::new(0),
            per_ip: Mutex::new(HashMap::new()),
            refused_writes: AtomicU64::new(0),
            refused_per_ip: AtomicU64::new(0),
            dropped_streams: Arc::new(AtomicU64::new(0)),
        })
    }
    pub fn depth(&self) -> usize { self.writes.load(Ordering::Acquire) + self.membership.load(Ordering::Acquire) }
    /// Count a write until its answer is done; refuse when its address holds too many, or the queue is full.
    pub fn admit(self: &Arc<Flow>, method: &str, path: &str, ip: &str) -> HResult<Option<Slot>> {
        if !matches!(method, "POST" | "PUT" | "DELETE") {
            return Ok(None);
        }
        let busy = |m: &str| Fail::reply(503, "overloaded", m, json!({})).retry(1);
        let mut per = self.per_ip.lock();
        let held = per.get(ip).copied().unwrap_or(0);
        if held >= self.max_per_ip {
            self.refused_per_ip.fetch_add(1, Ordering::Relaxed);
            return Err(busy("too many writes in flight from this address; try again in a second"));
        }
        let membership;
        if self.writes.load(Ordering::Acquire) < self.max_writes {
            self.writes.fetch_add(1, Ordering::AcqRel);
            membership = false;
        } else if self.membership.load(Ordering::Acquire) < self.max_membership && is_membership_write(method, path) {
            self.membership.fetch_add(1, Ordering::AcqRel);
            membership = true;
        } else {
            self.refused_writes.fetch_add(1, Ordering::Relaxed);
            return Err(busy("the hub is busy; try again in a second"));
        }
        per.insert(ip.to_string(), held + 1);
        Ok(Some(Slot { flow: self.clone(), membership, ip: ip.into() }))
    }
}

// ---- test rooms ------------------------------------------------------------------------------------

pub struct TestRooms {
    key: Option<ed25519_dalek::VerifyingKey>,
    ids: Mutex<HashSet<String>>,
    used: Mutex<indexmap::IndexMap<String, i64>>,
    lifetime_ms: i64,
}
impl TestRooms {
    pub fn new(c: &Connection, cfg: &Config) -> TestRooms {
        let v = cfg.get("HUB_TEST_PUBLIC_KEY").unwrap_or("").trim().to_string();
        let off = v.is_empty() || ["off", "0", "false", "no"].contains(&v.to_lowercase().as_str());
        let key = if off {
            None
        } else {
            zcrypto::unb64u(&v).ok().filter(|b| b.len() == 32).and_then(|b| ed25519_dalek::VerifyingKey::from_bytes(&b.try_into().unwrap()).ok())
        };
        let ids = c.prepare("SELECT room_id FROM test_rooms").and_then(|mut s| s.query_map([], |r| r.get::<_, String>(0))?.collect::<Result<HashSet<_>, _>>()).unwrap_or_default();
        TestRooms { key, ids: Mutex::new(ids), used: Mutex::new(Default::default()), lifetime_ms: 86400000 }
    }
    pub fn enabled(&self) -> bool { self.key.is_some() }
    /// True if the request carries a valid, fresh, unused test signature (asked once per request).
    pub fn verify(&self, method: &str, path_and_query: &str, header: Option<&str>) -> bool {
        use ed25519_dalek::Verifier;
        let Some(key) = &self.key else { return false };
        let Some(h) = header else { return false };
        let parts: Vec<&str> = h.split('.').collect();
        if parts.len() != 4 || parts[0] != "v1" || parts[1].len() != 13 || !parts[1].bytes().all(|c| c.is_ascii_digit()) {
            return false;
        }
        let b64ok = |s: &str, n: usize| s.len() == n && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-');
        if !b64ok(parts[2], 16) || !b64ok(parts[3], 86) {
            return false;
        }
        let at: i64 = parts[1].parse().unwrap_or(0);
        let t = now();
        if (t - at).abs() > 60000 || self.used.lock().contains_key(parts[2]) {
            return false;
        }
        let Ok(sig) = base64_lenient(parts[3]) else { return false };
        if sig.len() != 64 {
            return false;
        }
        let msg = format!("trommi-test-request/v1\n{method}\n{path_and_query}\n{at}\n{}", parts[2]);
        if key.verify(msg.as_bytes(), &ed25519_dalek::Signature::from_bytes(&sig.try_into().unwrap())).is_err() {
            return false;
        }
        let mut used = self.used.lock();
        while let Some((_, &exp)) = used.get_index(0) {
            if exp > t {
                break;
            }
            used.shift_remove_index(0);
        }
        used.insert(parts[2].to_string(), t + 120000);
        true
    }
    pub fn is_test_room(&self, id: &str) -> bool { self.key.is_some() && self.ids.lock().contains(id) }
    pub fn mark(&self, c: &Connection, id: &str) {
        let _ = c.execute("INSERT OR REPLACE INTO test_rooms (room_id, expires_at) VALUES (?, ?)", params![id, now() + self.lifetime_ms]);
        self.ids.lock().insert(id.into());
    }
    pub fn forget(&self, id: &str) { self.ids.lock().remove(id); }
    pub fn expired(&self, c: &Connection) -> Vec<String> {
        c.prepare("SELECT room_id FROM test_rooms WHERE expires_at < ?").and_then(|mut s| s.query_map([now()], |r| r.get::<_, String>(0))?.collect()).unwrap_or_default()
    }
}
/// Node's Buffer.from(x, 'base64url') is lenient; the signature part is checked by its pattern first.
fn base64_lenient(s: &str) -> Result<Vec<u8>, ()> {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s).or_else(|_| base64::engine::GeneralPurpose::new(&base64::alphabet::URL_SAFE, base64::engine::GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true).with_encode_padding(false).with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent)).decode(s)).map_err(|_| ())
}

/// Every table with a room_id column, read from the schema.
pub fn room_tables(c: &Connection) -> Vec<String> {
    let names: Vec<String> = c.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").and_then(|mut s| s.query_map([], |r| r.get(0))?.collect()).unwrap_or_default();
    names.into_iter().filter(|n| c.query_row(&format!("SELECT 1 FROM pragma_table_info('{n}') WHERE name = 'room_id'"), [], |_| Ok(())).optional().ok().flatten().is_some()).collect()
}

// ---- the attachment quota ---------------------------------------------------------------------------

const AGENT_SHARE: f64 = 0.25;
pub struct Evict {
    pub attachment_id: String,
    pub total_size: i64,
}
pub fn quota_used(c: &Connection, room: &str) -> i64 {
    c.prepare_cached("SELECT COALESCE(SUM(total_size), 0) FROM attachments WHERE room_id = ?").and_then(|mut s| s.query_row([room], |r| r.get(0))).unwrap_or(0)
}
fn agents_of(c: &Connection, room: &str) -> HashSet<String> {
    c.prepare_cached("SELECT device_id FROM devices WHERE room_id = ? AND device_role = 'agent'").and_then(|mut s| s.query_map([room], |r| r.get(0))?.collect()).unwrap_or_default()
}
fn agent_bytes(c: &Connection, room: &str, agents: &HashSet<String>) -> i64 {
    let rows: Vec<(String, i64)> = c.prepare_cached("SELECT uploader_device_id, total_size FROM attachments WHERE room_id = ?").and_then(|mut s| s.query_map([room], |r| Ok((r.get(0)?, r.get(1)?)))?.collect()).unwrap_or_default();
    rows.iter().filter(|r| agents.contains(&r.0)).map(|r| r.1).sum()
}
fn scope_of_header(h: &[u8]) -> String { if h.get(38) == Some(&1) && h.len() >= 55 { zcrypto::hex(&h[39..55]) } else { "room".into() } }

/// Evictable attachments of a room, oldest first (only `uploader`'s when given).
fn evictable(c: &Connection, room: &str, uploader: Option<&str>) -> rusqlite::Result<Vec<Evict>> {
    const OPEN: i64 = 1;
    const TIMELINE_ITEM: i64 = 1;
    const STATUS: i64 = 6;
    let agents = agents_of(c, room);
    let mut refs: HashMap<String, HashSet<i64>> = HashMap::new();
    let mut newest_agent_status: indexmap::IndexMap<String, Vec<String>> = indexmap::IndexMap::new();
    {
        let mut st = c.prepare_cached("SELECT envelope_kind, attachment_ids, sender_device_id, envelope_header FROM envelopes WHERE room_id = ? AND attachment_ids IS NOT NULL ORDER BY envelope_number")?;
        let mut rows = st.query([room])?;
        while let Some(r) = rows.next()? {
            let kind: i64 = r.get(0)?;
            let ids: String = r.get(1)?;
            let sender = zcrypto::hex(&r.get::<_, Vec<u8>>(2)?);
            let header: Vec<u8> = r.get(3)?;
            let ids: Vec<String> = ids.split(',').map(String::from).collect();
            if kind == STATUS && agents.contains(&sender) {
                newest_agent_status.insert(format!("{sender} {}", scope_of_header(&header)), ids);
                continue;
            }
            for id in ids {
                refs.entry(format!("{sender} {id}")).or_default().insert(kind);
            }
        }
    }
    let mut pinned = HashSet::new();
    for (key, ids) in &newest_agent_status {
        let who = key.split(' ').next().unwrap();
        for id in ids {
            pinned.insert(format!("{who} {id}"));
        }
    }
    let rows: Vec<(String, i64, Option<String>, String, Option<i64>)> = c
        .prepare_cached(
            "SELECT a.attachment_id, a.total_size, a.object_id, a.uploader_device_id, o.object_state FROM attachments a
        LEFT JOIN objects o ON o.room_id = a.room_id AND o.object_id = a.object_id WHERE a.room_id = ? ORDER BY a.stored_at, a.attachment_id",
        )?
        .query_map([room], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
        .collect::<Result<_, _>>()?;
    let mut out = vec![];
    for (aid, size, oid, up, state) in rows {
        if uploader.is_some_and(|u| u != up) {
            continue;
        }
        let own = format!("{up} {aid}");
        if pinned.contains(&own) {
            continue;
        }
        let keep = match refs.get(&own) {
            None => {
                let older_status_named = agents.contains(&up)
                    && oid.is_none()
                    && c.prepare_cached("SELECT 1 FROM envelopes WHERE room_id = ? AND envelope_kind = ? AND sender_device_id = ? AND (',' || attachment_ids || ',') LIKE ?")?
                        .query_row(params![room, STATUS, zcrypto::unhex(&up).unwrap_or_default(), format!("%,{aid},%")], |_| Ok(()))
                        .optional()?
                        .is_some();
                older_status_named
            }
            Some(k) => {
                if k.contains(&STATUS) {
                    false
                } else if oid.is_some() {
                    state.is_some_and(|s| s != OPEN)
                } else {
                    k.len() == 1 && k.contains(&TIMELINE_ITEM)
                }
            }
        };
        if keep {
            out.push(Evict { attachment_id: aid, total_size: size });
        }
    }
    Ok(out)
}

/// What has to go so that `bytes` more fit (for an upload by `uploader`); refuses with 413 quota-exceeded otherwise.
pub fn quota_plan(c: &Connection, quota: f64, room: &str, bytes: i64, uploader: Option<&str>) -> HResult<Vec<Evict>> {
    let agents = if uploader.is_some() { agents_of(c, room) } else { HashSet::new() };
    let is_agent = uploader.is_some_and(|u| agents.contains(u));
    let used = quota_used(c, room) as f64;
    let cap = (quota * AGENT_SHARE).floor();
    let agent_now = if is_agent { agent_bytes(c, room, &agents) as f64 } else { 0.0 };
    let b = bytes as f64;
    if used + b <= quota && (!is_agent || agent_now + b <= cap) {
        return Ok(vec![]);
    }
    let mut out = vec![];
    let mut freed = 0.0;
    for a in evictable(c, room, if is_agent { uploader } else { None })? {
        if used - freed + b <= quota && (!is_agent || agent_now - freed + b <= cap) {
            break;
        }
        freed += a.total_size as f64;
        out.push(a);
    }
    if used - freed + b <= quota && (!is_agent || agent_now - freed + b <= cap) {
        return Ok(out);
    }
    if is_agent && used - freed + b <= quota {
        return Err(Fail::reply(413, "quota-exceeded", &format!("agents hold at most {} bytes of this room's attachments", cap as i64), json!({ "used": agent_now as i64, "quota": cap as i64 })));
    }
    Err(Fail::reply(413, "quota-exceeded", &format!("this room holds at most {} bytes of attachments", quota as i64), json!({ "used": used as i64, "quota": quota as i64 })))
}

// ---- the WAL keeper ---------------------------------------------------------------------------------

#[derive(Default, Clone)]
pub struct WalLast {
    pub log_frames: i64,
    pub checkpointed_frames: i64,
    pub truncations: u64,
    pub last_ms: f64,
}
pub fn file_size(p: &std::path::Path) -> u64 { std::fs::metadata(p).map(|m| m.len()).unwrap_or(0) }
pub fn checkpoint(c: &Connection, db_path: &std::path::Path, truncate_bytes: f64, last: &Mutex<WalLast>) -> rusqlite::Result<WalLast> {
    let t = std::time::Instant::now();
    let wal = std::path::PathBuf::from(format!("{}-wal", db_path.display()));
    let mode = if file_size(&wal) as f64 > truncate_bytes { "TRUNCATE" } else { "PASSIVE" };
    let (log, done): (i64, i64) = c.query_row(&format!("PRAGMA wal_checkpoint({mode})"), [], |r| Ok((r.get(1)?, r.get(2)?)))?;
    let mut l = last.lock();
    if mode == "TRUNCATE" {
        l.truncations += 1;
    }
    l.log_frames = log.max(0);
    l.checkpointed_frames = done.max(0);
    l.last_ms = t.elapsed().as_secs_f64() * 1000.0;
    Ok(l.clone())
}
