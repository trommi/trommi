//! The thin hub (a port of hub/server.mjs): transport, storage, limits and the live stream around the room core.
//! The contract is the README section "Hub v1: the wire protocol".

use crate::config::Config;
use crate::db::{self, Db};
use crate::error::{answer, fail, Fail, HResult};
use crate::files::{Files, PutError};
use crate::http::{b64, header, hex_param, hex_value, int_param, json, read_json, Body, Conn, Resp};
use crate::limits::Buckets;
use crate::ops::{self, Flow, TestRooms, Versions, WalLast};
use crate::push::{Apns, Pusher};
use crate::room::{GrantIn, JoinStatus, RoomCore};
use crate::stream::{Chunk, Client, SseBody, Stream};
use crate::util::{now, Query};
use bytes::Bytes;
use http_body_util::BodyExt;
use hyper::body::Incoming;
use hyper::{HeaderMap, Request, Response, StatusCode};
use parking_lot::Mutex;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Notify, OnceCell};
use zcrypto::{b64u, hex};

pub const PROTOCOL_VERSION: i64 = 1;
const DAY: i64 = 86400000;
const CATCH_UP_SLICE: i64 = 64;
const CATCH_UP_HIGH_WATER: usize = 256 << 10;
const IDLE_MS: u64 = 30000;
const UPLOAD_MIN_BYTES_PER_S: f64 = 16384.0;
const SHARE_MAX_MS: i64 = 30 * DAY;
const PUSH_LEVELS: [&str; 2] = ["all", "knocking"];
const LINK_HEARS: [&str; 2] = ["live", "oncall"];
const LINK_CLAUDE: [&str; 3] = ["alive", "gone", "checking"];

/// Loopback or a private (RFC 1918 / ULA) peer: a proxy on this machine. Not the tailnet's 100.64/10, not public.
pub fn trusted_peer(ip: &str) -> bool {
    let v4 = ip.strip_prefix("::ffff:").unwrap_or(ip);
    let parts: Vec<&str> = v4.split('.').collect();
    if parts.len() == 4 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit())) {
        let a: u32 = parts[0].parse().unwrap_or(999);
        let b: u32 = parts[1].parse().unwrap_or(999);
        return a == 127 || a == 10 || (a == 172 && (16..=31).contains(&b)) || (a == 192 && b == 168);
    }
    let l = ip.to_lowercase();
    ip == "::1" || (l.len() >= 5 && (l.starts_with("fc") || l.starts_with("fd")) && l.as_bytes()[2].is_ascii_hexdigit() && l.as_bytes()[3].is_ascii_hexdigit() && l.as_bytes()[4] == b':')
}

#[derive(Default)]
pub struct LinkEntry {
    pub report: Option<Value>,
    pub working: bool,
    pub timer: u64,
    pub lost_pushed: bool,
    pub cut_pushed: Option<i64>,
    pub said: String,
}
#[derive(Default)]
pub struct Live {
    pub streams: Vec<Arc<Stream>>,
    pub offline_since: HashMap<String, i64>,
    pub link: HashMap<String, LinkEntry>,
    /// A Live Activity round is due (live_soon): at most one per HUB_LIVE_MS.
    pub live_due: bool,
    /// The beat of a running Live Activity is scheduled (live_beat): the same counts again every HUB_LIVE_BEAT_MS.
    pub live_beat: bool,
}
pub struct Room {
    pub id: String,
    pub core: Mutex<RoomCore>,
    pub live: Mutex<Live>,
}

pub struct Hub {
    pub cfg: Config,
    pub hub_url: String,
    pub db: Db,
    pub rooms: Mutex<HashMap<String, Arc<OnceCell<Arc<Room>>>>>,
    found_lock: tokio::sync::Mutex<()>,
    founded: Mutex<HashMap<String, Vec<i64>>>,
    envelope_limit: Buckets,
    push_limit: Buckets,
    open_limit: Buckets,
    share_limit: Buckets,
    pub stats: Mutex<Vec<(String, f64)>>,
    pub catch_up_slices: AtomicU64,
    pub versions: Versions,
    pub flow: Arc<Flow>,
    pub tests: TestRooms,
    pub wal_last: Mutex<WalLast>,
    pub metrics: crate::metrics::Metrics,
    pub accounts: crate::accounts::Accounts,
    pub push: Pusher,
    pub apns: Option<Apns>,
    pub tickets: crate::push::PushTickets,
    pub files: Files,
    pub streams: Mutex<HashMap<u64, Arc<Stream>>>,
    pub closing: AtomicBool,
    pub in_flight: AtomicUsize,
    pub drained: Notify,
    pub started: Instant,
}

/// What one request carries through the handlers.
pub struct Ctx {
    pub method: String,
    pub path: String,
    pub path_and_query: String,
    pub query: Query,
    pub headers: HeaderMap,
    pub conn: Conn,
    pub body: Option<Incoming>,
    pub ip: String,
    pub client: Option<Client>,
    pub guards: Vec<Box<dyn std::any::Any + Send + Sync>>,
    test_req: Option<bool>,
}
impl Ctx {
    pub fn take_body(&mut self) -> Incoming { self.body.take().expect("body read once") }
    pub fn header(&self, n: &str) -> Option<&str> { header(&self.headers, n) }
}

fn sse(event: &str, data: &Value, id: Option<i64>) -> Bytes {
    let mut s = String::new();
    if let Some(id) = id {
        s.push_str(&format!("id: {id}\n"));
    }
    s.push_str(&format!("event: {event}\ndata: {}\n\n", serde_json::to_string(data).unwrap()));
    Bytes::from(s)
}
fn bearer(ctx: &Ctx) -> HResult<String> {
    let h = ctx.header("authorization").unwrap_or("");
    if let Some(t) = h.strip_prefix("Bearer ") {
        if (16..=200).contains(&t.len()) && t.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') {
            return Ok(t.to_string());
        }
    }
    fail("unauthorised", "sign in first: Authorization: Bearer <access_token>")
}
fn wraps_of(list: Option<&Value>, what: &str) -> HResult<Vec<([u8; 32], Vec<u8>)>> {
    let Some(Value::Array(a)) = list else { return fail("bad-argument", &format!("{what} must be a list")) };
    a.iter()
        .map(|w| {
            let id = hex_value(w.get("device_id"), 64, "device_id")?;
            let sealed = b64(w.get("key_sealed"), "key_sealed")?;
            Ok((zcrypto::bytes::arr32(&zcrypto::unhex(id)?), sealed))
        })
        .collect()
}

impl Hub {
    pub fn log(&self, msg: &str) {
        if !self.cfg.quiet {
            println!("[hub] {msg}");
        }
    }
    pub fn new(cfg: Config, hub_url: String) -> Result<Hub, String> {
        let quiet = cfg.quiet;
        let log = move |m: &str| {
            if !quiet {
                println!("[hub] {m}")
            }
        };
        let dir = std::path::PathBuf::from(&cfg.data_dir);
        let db = Db::open(&dir, &log).map_err(|e| format!("hub.db: {e}"))?;
        let files = Files::new(dir.join("attachments")).map_err(|e| e.to_string())?;
        let push = Pusher::new(&dir, &cfg).map_err(|e| e.to_string())?;
        let apns = match crate::push::apns_config(&cfg) {
            Some(c) => Some(Apns::new(c, &cfg)?),
            None => None,
        };
        if let Some(a) = &apns {
            log(&format!("apns on for {}", a.topics.join(", ")));
        }
        let tickets = crate::push::PushTickets::new(&dir);
        let tests = TestRooms::new(&db.w(), &cfg);
        let accounts = crate::accounts::Accounts::new(&cfg)?;
        let metrics = crate::metrics::Metrics::new(&dir, &cfg);
        let l = &cfg.limits;
        Ok(Hub {
            envelope_limit: Buckets::new(l.envelopes_per_second, l.envelope_burst),
            push_limit: Buckets::new(10.0 / 60.0, 10.0),
            open_limit: Buckets::new(l.open_requests_per_ip_minute / 60.0, l.open_requests_per_ip_minute),
            share_limit: Buckets::new(1.0, 60.0),
            versions: Versions::new(&cfg),
            flow: Flow::new(&cfg),
            tests,
            wal_last: Mutex::new(WalLast::default()),
            metrics,
            accounts,
            push,
            apns,
            tickets,
            files,
            db,
            hub_url,
            rooms: Mutex::new(HashMap::new()),
            found_lock: tokio::sync::Mutex::new(()),
            founded: Mutex::new(HashMap::new()),
            stats: Mutex::new(vec![]),
            catch_up_slices: AtomicU64::new(0),
            streams: Mutex::new(HashMap::new()),
            closing: AtomicBool::new(false),
            in_flight: AtomicUsize::new(0),
            drained: Notify::new(),
            started: Instant::now(),
            cfg,
        })
    }

    // ---- rooms, loaded on first use ------------------------------------------------------------

    pub fn room_exists(&self, id: &str) -> bool {
        self.db.w().prepare_cached("SELECT 1 FROM rooms WHERE room_id = ?").and_then(|mut s| s.query_row([id], |_| Ok(())).optional()).ok().flatten().is_some()
    }
    pub async fn room(&self, id: &str) -> HResult<Arc<Room>> {
        if !zcrypto::bytes::is_hex(id, 64) {
            return fail("bad-argument", "a room id is 64 hex characters");
        }
        let slot = {
            let mut rooms = self.rooms.lock();
            match rooms.get(id) {
                Some(s) => s.clone(),
                None => {
                    if !self.room_exists(id) {
                        return fail("no-room", "no such room on this hub");
                    }
                    let s = Arc::new(OnceCell::new());
                    rooms.insert(id.to_string(), s.clone());
                    s
                }
            }
        };
        let r = slot
            .get_or_try_init(|| async {
                let t = Instant::now();
                let core = RoomCore::load(&self.db.w(), id, &self.hub_url)?;
                self.stats.lock().push((id.to_string(), t.elapsed().as_secs_f64() * 1000.0));
                Ok::<_, Fail>(Arc::new(Room { id: id.to_string(), core: Mutex::new(core), live: Mutex::new(Live::default()) }))
            })
            .await;
        match r {
            Ok(r) => Ok(r.clone()),
            Err(e) => {
                self.rooms.lock().remove(id);
                self.log(&format!("room {} failed to load: {}", &id[..8], e.message));
                Err(e)
            }
        }
    }
    /// The room leaves memory; its streams end.
    pub fn close_room(&self, id: &str) {
        let slot = self.rooms.lock().remove(id);
        if let Some(r) = slot.and_then(|s| s.get().cloned()) {
            let streams: Vec<_> = r.live.lock().streams.clone();
            for s in streams {
                s.end(None);
            }
        }
    }

    // ---- the live stream -------------------------------------------------------------------------

    pub fn deliver(&self, r: &Room, chunk: Chunk, filter: impl Fn(&Stream) -> bool) {
        let live = r.live.lock();
        for s in &live.streams {
            if !s.over() && filter(s) {
                s.send(&chunk);
            }
        }
    }
    pub fn deliver_all(&self, r: &Room, chunk: Chunk) { self.deliver(r, chunk, |_| true) }
    fn close_streams(&self, r: &Room, ids: &[String], which: impl Fn(&Stream) -> bool) {
        let list: Vec<Arc<Stream>> = r.live.lock().streams.iter().filter(|s| ids.contains(&s.device_id) && which(s) && !s.over()).cloned().collect();
        for s in list {
            s.end(None);
        }
    }
    fn device_stream_count(live: &Live, dev: &str) -> usize { live.streams.iter().filter(|s| s.device_id == dev).count() }

    /// A device's row of GET devices, without what the member list says: presence and the link.
    fn presence_of(live: &Live, dev: &str) -> Value {
        let online = Self::device_stream_count(live, dev) > 0;
        let mut row = json!({ "device_id": dev, "is_online": online });
        let o = row.as_object_mut().unwrap();
        if !online {
            if let Some(t) = live.offline_since.get(dev) {
                o.insert("offline_since".into(), json!(t));
            }
        }
        if let Some(rep) = live.link.get(dev).and_then(|e| e.report.clone()) {
            o.insert("link".into(), rep);
        }
        row
    }
    /// Tell every stream of the room what a device's row is now, unless it was said already.
    fn announce(&self, r: &Room, dev: &str) {
        let mut live = r.live.lock();
        let row = Self::presence_of(&live, dev);
        let text = serde_json::to_string(&row).unwrap();
        let e = live.link.entry(dev.to_string()).or_default();
        if e.said == text {
            return;
        }
        e.said = text;
        let chunk = Chunk { text: sse("presence", &row, None), n: None };
        for s in &live.streams {
            if !s.over() {
                s.send(&chunk);
            }
        }
    }
    fn stream_opened(&self, r: &Room, dev: &str) {
        {
            let mut live = r.live.lock();
            let e = live.link.entry(dev.to_string()).or_default();
            e.timer += 1;
            e.lost_pushed = false;
            if let Some(Value::Object(rep)) = e.report.as_mut() {
                rep.remove("exit");
            }
        }
        self.announce(r, dev);
    }
    fn streams_gone(self: &Arc<Self>, r: &Arc<Room>, dev: &str) {
        self.announce(r, dev);
        let gen = {
            let mut live = r.live.lock();
            let e = live.link.entry(dev.to_string()).or_default();
            e.timer += 1;
            e.timer
        };
        let (hub, room, dev) = (self.clone(), r.clone(), dev.to_string());
        let ms = self.cfg.loss_ms;
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            let push = {
                let mut live = room.live.lock();
                let streams = Self::device_stream_count(&live, &dev);
                let since = live.offline_since.get(&dev).copied();
                let e = live.link.entry(dev.clone()).or_default();
                if e.timer != gen || streams > 0 || e.lost_pushed {
                    return;
                }
                let cut = e.report.as_ref().and_then(|r| r.get("exit")).and_then(|x| x.get("claude")).and_then(|c| c.as_str()) == Some("alive");
                if !cut && !e.working {
                    return;
                }
                e.lost_pushed = true;
                e.working = false;
                (if cut { "cut" } else { "gone" }, since)
            };
            hub.live_soon(&room);
            hub.send_link_push(&room.id, &dev, push.0, push.1.map(|s| json!(s)).unwrap_or(Value::Null)).await;
        });
    }

    async fn push_to(&self, sub: &Value, message: &Value, urgency: &str) -> u16 {
        let log = |m: &str| self.log(m);
        if let Some(a) = sub.get("apns") {
            return match &self.apns {
                Some(ap) => ap.send(a, message, &log).await,
                None => 0,
            };
        }
        self.push.send(sub, message, urgency, &log).await
    }
    fn push_rows(&self, sql: &str, p: &[&dyn rusqlite::ToSql]) -> Vec<(String, String, String)> {
        let c = self.db.w();
        c.prepare_cached(sql).and_then(|mut s| s.query_map(p, |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect()).unwrap_or_default()
    }
    async fn send_link_push(&self, room: &str, dev: &str, state: &str, since: Value) {
        let subs = self.push_rows(
            "SELECT p.device_id, p.endpoint, p.subscription FROM push_subscriptions p JOIN devices d ON d.room_id = p.room_id AND d.device_id = p.device_id
      WHERE p.room_id = ? AND d.device_role = 'human' AND d.removed_entry_number IS NULL",
            &[&room],
        );
        let message = json!({ "room_id": room, "kind": "agent-lost", "state": state, "device_id": dev, "since": since });
        let sends = subs.iter().map(|s| async {
            let sub: Value = serde_json::from_str(&s.2).unwrap_or(Value::Null);
            let status = self.push_to(&sub, &message, "high").await;
            if status == 404 || status == 410 {
                let _ = self.db.w().execute("DELETE FROM push_subscriptions WHERE room_id = ? AND device_id = ? AND endpoint = ?", params![room, s.0, s.1]);
            }
        });
        futures_util::future::join_all(sends).await;
    }
    async fn send_pushes(&self, room: &str, sender: &str, n: i64, urgency: Option<u8>) {
        let knocks = urgency.is_some_and(|u| u >= zcrypto::envelope::URGENCY_HIGH);
        let k: i64 = knocks as i64;
        let subs = self.push_rows(
            "SELECT p.device_id, p.endpoint, p.subscription FROM push_subscriptions p JOIN devices d ON d.room_id = p.room_id AND d.device_id = p.device_id
      WHERE p.room_id = ? AND d.device_role = 'human' AND d.removed_entry_number IS NULL AND p.device_id != ? AND (p.level = 'all' OR ?)",
            &[&room, &sender, &k],
        );
        let web_urgency = if knocks { "high" } else { "normal" };
        let message = json!({ "room_id": room, "envelope_number": n, "urgency": urgency });
        let sends = subs.iter().map(|s| async {
            let sub: Value = serde_json::from_str(&s.2).unwrap_or(Value::Null);
            // an iPhone also gets a ticket for this one envelope (its Notification Service Extension shows the title)
            let mut message = message.clone();
            if sub.get("apns").is_some() {
                message.as_object_mut().unwrap().insert("t".into(), json!(self.tickets.issue(room, &s.0, n, now())));
            }
            let status = self.push_to(&sub, &message, web_urgency).await;
            if status == 404 || status == 410 {
                let _ = self.db.w().execute("DELETE FROM push_subscriptions WHERE room_id = ? AND device_id = ? AND endpoint = ?", params![room, s.0, s.1]);
            }
        });
        futures_util::future::join_all(sends).await;
    }

    // ---- Live Activity (hub/server.mjs liveSoon, liveCounts, liveNow) ---------------------------------

    pub fn live_soon(self: &Arc<Self>, r: &Arc<Room>) {
        if self.apns.is_none() {
            return;
        }
        {
            let mut live = r.live.lock();
            if live.live_due {
                return;
            }
            live.live_due = true;
        }
        let (hub, room) = (self.clone(), r.clone());
        let ms = self.cfg.live_ms;
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            room.live.lock().live_due = false;
            hub.live_now(&room).await;
        });
    }
    fn live_beat(self: &Arc<Self>, r: &Arc<Room>) {
        {
            let mut live = r.live.lock();
            if live.live_beat {
                return;
            }
            live.live_beat = true;
        }
        let (hub, room) = (self.clone(), r.clone());
        let ms = self.cfg.live_beat_ms;
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            room.live.lock().live_beat = false;
            hub.live_now(&room).await;
        });
    }
    fn live_counts(&self, r: &Room) -> (i64, i64) {
        let agents: std::collections::HashSet<String> = self
            .db
            .read(|c| c.prepare_cached("SELECT device_id FROM devices WHERE room_id = ? AND device_role = 'agent' AND removed_entry_number IS NULL").and_then(|mut s| s.query_map([&r.id], |x| x.get(0))?.collect()))
            .unwrap_or_default();
        let working = r.live.lock().link.iter().filter(|(id, e)| e.working && agents.contains(*id)).count() as i64;
        let waiting: i64 = self
            .db
            .read(|c| {
                c.prepare_cached(
                    "SELECT COUNT(*) FROM objects o JOIN devices d ON d.room_id = o.room_id AND d.device_id = o.owner_device_id
      WHERE o.room_id = ? AND o.object_state = 1 AND d.device_role = 'agent'",
                )
                .and_then(|mut s| s.query_row([&r.id], |x| x.get(0)))
            })
            .unwrap_or(0);
        (working, waiting)
    }
    async fn live_now(self: &Arc<Self>, r: &Arc<Room>) {
        let Some(apns) = &self.apns else { return };
        type Row = (String, String, String, String, Option<String>, Option<String>, Option<i64>, Option<String>, Option<i64>);
        let rows: Vec<Row> = {
            let c = self.db.w();
            c.prepare_cached(
                "SELECT l.device_id, l.environment, l.topic, l.tag, l.start_token, l.activity_token, l.started_at, l.sent, l.sent_at FROM live_activities l
      JOIN devices d ON d.room_id = l.room_id AND d.device_id = l.device_id WHERE l.room_id = ? AND d.device_role = 'human' AND d.removed_entry_number IS NULL",
            )
            .and_then(|mut s| s.query_map([&r.id], |x| Ok((x.get(0)?, x.get(1)?, x.get(2)?, x.get(3)?, x.get(4)?, x.get(5)?, x.get(6)?, x.get(7)?, x.get(8)?)))?.collect())
            .unwrap_or_default()
        };
        if rows.is_empty() {
            return;
        }
        let (working, waiting) = self.live_counts(r);
        let key = format!("{working}:{waiting}");
        let beat = self.cfg.live_beat_ms as i64;
        let stale_s = (3 * beat + 999) / 1000;
        let stale_s = stale_s.max(60);
        if working > 0 {
            self.live_beat(r);
        }
        let log = |m: &str| self.log(m);
        let set = |dev: &str, sql: &str, p: &[&dyn rusqlite::ToSql]| {
            let mut all: Vec<&dyn rusqlite::ToSql> = p.to_vec();
            all.push(&r.id);
            all.push(&dev);
            let _ = self.db.w().execute(&format!("UPDATE live_activities SET {sql} WHERE room_id = ? AND device_id = ?"), all.as_slice());
        };
        let sends = rows.iter().map(|(dev, env, topic, tag, start, act, started, sent, sent_at)| {
            let (key, log, set) = (&key, &log, &set);
            async move {
                let reg = |tok: &str| json!({ "token": tok, "environment": env, "topic": topic });
                if let Some(act) = act {
                    if working == 0 {
                        apns.send_live(&reg(act), "end", working, waiting, "", false, stale_s, log).await;
                        return set(dev, "activity_token = NULL, started_at = NULL, sent = NULL, sent_at = NULL", &[]);
                    }
                    // the same counts go out again only as the beat (to move the stale date)
                    if sent.as_deref() == Some(key.as_str()) && (now() - sent_at.unwrap_or(0)) * 10 < beat * 9 {
                        return;
                    }
                    let before: i64 = sent.as_deref().and_then(|s| s.split(':').nth(1)).and_then(|w| w.parse().ok()).unwrap_or(0);
                    let status = apns.send_live(&reg(act), "update", working, waiting, "", waiting > before, stale_s, log).await;
                    return if status == 410 { set(dev, "activity_token = NULL, started_at = NULL, sent = NULL, sent_at = NULL", &[]) } else { set(dev, "sent = ?, sent_at = ?", &[key, &now()]) };
                }
                if working == 0 {
                    if started.is_some() {
                        set(dev, "started_at = NULL, sent = NULL, sent_at = NULL", &[]);
                    }
                    return;
                }
                let Some(start) = start else { return };
                if started.is_some_and(|t| now() - t < 8 * 3_600_000) {
                    return;
                }
                let status = apns.send_live(&reg(start), "start", working, waiting, tag, false, stale_s, log).await;
                if status == 410 {
                    set(dev, "start_token = NULL", &[]);
                } else if status == 200 {
                    set(dev, "started_at = ?, sent = ?, sent_at = ?", &[&now(), key, &now()]);
                }
            }
        });
        futures_util::future::join_all(sends).await;
    }

    // ---- HTTP helpers ------------------------------------------------------------------------------

    fn allowed_origin(&self, o: Option<&str>) -> bool {
        let Some(o) = o else { return false };
        if o == "https://app.trommi.com" || self.cfg.origins.iter().any(|x| x == o) {
            return true;
        }
        if self.cfg.dev_origins {
            for p in ["http://localhost", "http://127.0.0.1"] {
                if let Some(rest) = o.strip_prefix(p) {
                    if rest.is_empty() || (rest.starts_with(':') && rest.len() > 1 && rest[1..].bytes().all(|c| c.is_ascii_digit())) {
                        return true;
                    }
                }
            }
        }
        false
    }
    /// C06: cf-connecting-ip only when enabled AND the socket peer is this machine or a private address.
    fn ip_of(&self, conn: &Conn, headers: &HeaderMap) -> String {
        let peer = conn.peer_ip();
        match header(headers, "cf-connecting-ip") {
            Some(h) if self.cfg.trust_cf && crate::util::js_len(h) <= 64 && trusted_peer(&peer) => h.to_string(),
            _ => peer,
        }
    }
    fn test_request(&self, ctx: &mut Ctx) -> bool {
        if ctx.test_req.is_none() {
            let v = self.tests.verify(&ctx.method, &ctx.path_and_query, ctx.header("x-test-signature"));
            ctx.test_req = Some(v);
        }
        ctx.test_req.unwrap()
    }
    pub fn unlimited(&self, room: &str) -> bool { self.tests.is_test_room(room) }
    fn open_route(&self, ctx: &Ctx, room: &str) -> HResult<()> {
        if self.unlimited(room) {
            return Ok(());
        }
        let wait = self.open_limit.take(&ctx.ip);
        if wait > 0 {
            return Err(Fail::hub("rate-limited", "too many requests from this address").retry(wait));
        }
        Ok(())
    }
    fn json_deadline(&self) -> Duration { Duration::from_millis(self.cfg.body_timeout_ms) }
    async fn read_json(&self, ctx: &mut Ctx) -> HResult<Map<String, Value>> {
        let body = ctx.take_body();
        read_json(body, &ctx.headers, self.cfg.limits.json, self.json_deadline(), &ctx.conn).await
    }

    // ---- serving ---------------------------------------------------------------------------------------

    pub async fn serve(self: Arc<Self>, req: Request<Incoming>, conn: Conn) -> Resp {
        if self.closing.load(Ordering::Acquire) {
            let mut r = json(503, &json!({ "error": "overloaded", "message": "the hub is restarting; try again in a second" }));
            r.headers_mut().insert("retry-after", "1".parse().unwrap());
            return r;
        }
        self.in_flight.fetch_add(1, Ordering::AcqRel);
        let in_flight = InFlight(self.clone());
        let start = Instant::now();
        let (parts, body) = req.into_parts();
        let path = parts.uri.path().to_string();
        let path_and_query = parts.uri.path_and_query().map(|p| p.as_str().to_string()).unwrap_or_else(|| path.clone());
        let ip = self.ip_of(&conn, &parts.headers);
        let mut ctx = Ctx {
            method: parts.method.as_str().to_string(),
            query: Query(crate::util::query_pairs(parts.uri.query())),
            path,
            path_and_query,
            headers: parts.headers,
            conn,
            body: Some(body),
            ip,
            client: None,
            guards: vec![],
            test_req: None,
        };
        if self.cfg.test_control {
            if let Some(t) = ctx.header("x-test-now").and_then(|v| v.parse::<i64>().ok()) {
                crate::util::set_test_now(t);
            }
        }
        let origin = ctx.header("origin").map(String::from);
        let allowed = self.allowed_origin(origin.as_deref());
        let label = crate::metrics::route_label(&ctx.method, &ctx.path);
        let what = format!("{} {}", ctx.method, ctx.path);
        let result = self.handle(&mut ctx, allowed).await;
        let mut resp = match result {
            Ok(r) => r,
            Err(f) => {
                let log = |m: &str| self.log(m);
                match answer(&f, &log, &what) {
                    Some((s, b, ra)) => {
                        let mut r = json(s, &b);
                        if let Some(ra) = ra {
                            r.headers_mut().insert("retry-after", ra.to_string().parse().unwrap());
                        }
                        r
                    }
                    None => {
                        ctx.conn.destroy();
                        let mut r = Response::new(Body::empty());
                        *r.status_mut() = StatusCode::BAD_REQUEST;
                        r
                    }
                }
            }
        };
        if allowed && ctx.method != "OPTIONS" {
            let h = resp.headers_mut();
            h.insert("access-control-allow-origin", origin.unwrap().parse().unwrap());
            h.insert("vary", "Origin".parse().unwrap());
            h.insert("access-control-expose-headers", "content-range, content-length, retry-after".parse().unwrap());
        }
        let status = resp.status().as_u16();
        let body = resp.body_mut();
        for g in ctx.guards.drain(..) {
            body.guard(g);
        }
        body.guard(Box::new(self.metrics.request(label, status, start)));
        body.guard(Box::new(in_flight));
        resp
    }

    async fn handle(self: &Arc<Self>, ctx: &mut Ctx, allowed: bool) -> HResult<Resp> {
        if ctx.method == "OPTIONS" {
            let mut r = Response::new(Body::empty());
            *r.status_mut() = StatusCode::NO_CONTENT;
            if allowed {
                let h = r.headers_mut();
                let o = ctx.header("origin").unwrap().to_string();
                h.insert("access-control-allow-origin", o.parse().unwrap());
                h.insert("vary", "Origin".parse().unwrap());
                h.insert("access-control-expose-headers", "content-range, content-length, retry-after".parse().unwrap());
                h.insert("access-control-allow-methods", "GET, POST, PUT, DELETE".parse().unwrap());
                h.insert("access-control-allow-headers", "authorization, content-type, range, last-event-id, x-found-token, x-test-signature, x-lease-generation, x-share-secret, trommi-client, trommi-protocol".parse().unwrap());
                h.insert("access-control-max-age", "86400".parse().unwrap());
            }
            return Ok(r);
        }
        if self.cfg.test_control && ctx.path.starts_with("/__test/") {
            return crate::control::handle(self, ctx).await;
        }
        // ops.handle: the version gate, write admission, /v1/version, DELETE a test room, usage
        let log = |m: &str| self.log(m);
        ctx.client = self.versions.check(ctx.header("trommi-protocol"), ctx.header("trommi-client"), &log)?;
        if let Some(slot) = self.flow.admit(&ctx.method, &ctx.path, &ctx.ip)? {
            ctx.guards.push(Box::new(slot));
        }
        if ctx.path == "/v1/version" && ctx.method == "GET" {
            return Ok(json(200, &self.versions.info()));
        }
        if let Some(rest) = ctx.path.strip_prefix("/v1/rooms/") {
            let (id, sub) = match rest.split_once('/') {
                Some((a, b)) => (a, Some(b)),
                None => (rest, None),
            };
            if zcrypto::bytes::is_hex(id, 64) && (sub.is_none() || sub == Some("usage")) {
                let id = id.to_string();
                if sub.is_none() && ctx.method == "DELETE" {
                    self.delete_test_room(ctx, &id).await?;
                    return Ok(json(200, &json!({ "ok": true })));
                }
                if sub == Some("usage") && ctx.method == "GET" {
                    let r = self.room(&id).await?;
                    r.core.lock().authorise(&bearer(ctx)?, false, true)?;
                    let used = ops::quota_used(&self.db.w(), &id);
                    return Ok(json(200, &json!({ "attachment_bytes": used, "quota_bytes": self.cfg.quota_bytes })));
                }
            }
        }
        if let Some(r) = crate::accounts::handle(self, ctx).await? {
            return Ok(r);
        }
        if ctx.path == "/healthz" && ctx.method == "GET" {
            return Ok(json(200, &json!({ "ok": true, "commit": self.cfg.commit, "protocol_version": PROTOCOL_VERSION })));
        }
        if ctx.path == "/v1/push_key" && ctx.method == "GET" {
            return Ok(json(200, &json!({ "vapid_public_key": self.push.public_key, "apns": self.apns.is_some() })));
        }
        if let Some(id) = ctx.path.strip_prefix("/v1/shares/") {
            if !id.contains('/') && !id.is_empty() && (ctx.method == "GET" || ctx.method == "HEAD") {
                let id = id.to_string();
                return self.get_share(ctx, &id).await;
            }
        }
        if ctx.path == "/v1/rooms" && ctx.method == "POST" {
            return self.found(ctx).await;
        }
        if let Some(rest) = ctx.path.strip_prefix("/v1/rooms/") {
            let (id, sub) = match rest.find('/') {
                Some(i) => (&rest[..i], &rest[i..]),
                None => (rest, ""),
            };
            if !id.is_empty() {
                let (id, sub) = (id.to_string(), sub.to_string());
                return self.room_route(ctx, &id, &sub).await;
            }
        }
        if (ctx.method == "GET" || ctx.method == "HEAD") && !ctx.path.starts_with("/v1/") && (ctx.path == "/" || self.is_navigation(ctx)) {
            let mut r = Response::new(Body::empty());
            *r.status_mut() = StatusCode::FOUND;
            let h = r.headers_mut();
            h.insert("location", self.cfg.app_url.parse().unwrap());
            h.insert("cache-control", "no-store".parse().unwrap());
            h.insert("content-length", "0".parse().unwrap());
            return Ok(r);
        }
        fail("not-found", "no such route")
    }
    fn is_navigation(&self, ctx: &Ctx) -> bool {
        ctx.header("sec-fetch-mode") == Some("navigate") || ctx.header("accept").is_some_and(|a| a.split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '/')).any(|w| w == "text/html"))
    }

    async fn delete_test_room(self: &Arc<Self>, ctx: &mut Ctx, id: &str) -> HResult<()> {
        if !self.test_request(ctx) {
            return Err(Fail::reply(403, "forbidden", "deleting a room needs a signed test request (x-test-signature)", json!({})));
        }
        if !self.tests.is_test_room(id) {
            return Err(Fail::reply(404, "not-found", "no such test room; only test rooms can be deleted", json!({})));
        }
        self.remove_test_room(id);
        Ok(())
    }
    pub fn remove_test_room(&self, id: &str) {
        self.close_room(id);
        {
            let c = self.db.w();
            let tables = ops::room_tables(&c);
            let _ = db::tx(&c, |c| {
                for t in &tables {
                    c.execute(&format!("DELETE FROM \"{t}\" WHERE room_id = ?"), [id])?;
                }
                Ok::<_, rusqlite::Error>(())
            });
        }
        self.files.remove_room(id);
        self.tests.forget(id);
        self.log(&format!("test room {} deleted", &id[..8]));
    }

    // ---- routes ----------------------------------------------------------------------------------------

    async fn found(self: &Arc<Self>, ctx: &mut Ctx) -> HResult<Resp> {
        let signed_test = self.test_request(ctx);
        if !self.cfg.found_token.is_empty() && ctx.header("x-found-token") != Some(self.cfg.found_token.as_str()) && !signed_test {
            return fail("forbidden", "founding a room on this hub needs x-found-token");
        }
        let ip = ctx.ip.clone();
        let t = now();
        let recent: Vec<i64> = self.founded.lock().get(&ip).cloned().unwrap_or_default().into_iter().filter(|x| t - x < 3600000).collect();
        if recent.len() as f64 >= self.cfg.limits.found_per_ip_hour && !signed_test {
            let wait = ((recent[0] + 3600000 - t) as f64 / 1000.0).ceil() as u64;
            return Err(Fail::hub("rate-limited", "too many rooms founded from this address in the last hour").retry(wait));
        }
        let body = self.read_json(ctx).await?;
        let test_room = if body.get("test_room") == Some(&Value::Bool(true)) {
            if !signed_test {
                return Err(Fail::reply(403, "forbidden", "a test room needs a signed test request (x-test-signature)", json!({})));
            }
            true
        } else {
            false
        };
        if signed_test && !test_room {
            return fail("forbidden", "a signed test request founds test rooms only (test_room: true)");
        }
        let entry = b64(body.get("signed_entry"), "signed_entry")?;
        let wraps = wraps_of(body.get("sealed_room_keys"), "sealed_room_keys")?;
        if entry.len() < 64 {
            return fail("bad-format", "signed_entry");
        }
        let id = hex(&zcrypto::prim::hash(zcrypto::label::LOG_ENTRY, &[&entry[..entry.len() - 64]]));
        let _g = self.found_lock.lock().await;
        if self.rooms.lock().contains_key(&id) || self.room_exists(&id) {
            return fail("room-exists", "this room is already founded");
        }
        let n: i64 = self.db.w().query_row("SELECT COUNT(*) FROM rooms", [], |r| r.get(0))?;
        if n >= self.cfg.max_rooms {
            return fail("too-many", "this hub holds as many rooms as it may");
        }
        let (out, state) = {
            let c = self.db.w();
            RoomCore::accept_entry(&c, None, &id, &entry, &wraps, None, true)?
        };
        let state = state.unwrap();
        let core = RoomCore::founded(&id, &self.hub_url, state, now());
        let room = Arc::new(Room { id: id.clone(), core: Mutex::new(core), live: Mutex::new(Live::default()) });
        let cell = OnceCell::new();
        let _ = cell.set(room);
        self.rooms.lock().insert(id.clone(), Arc::new(cell));
        let mut f = self.founded.lock();
        let mut list = recent;
        list.push(now());
        f.insert(ip, list);
        drop(f);
        if test_room {
            self.tests.mark(&self.db.w(), &id);
        }
        self.log(&format!("room {} founded", &id[..8]));
        Ok(json(201, &json!({ "room_id": id, "entry_number": 0, "entry_hash": out.hash, "key_epoch": 1 })))
    }

    async fn member_entry(self: &Arc<Self>, r: &Arc<Room>, ctx: &mut Ctx) -> HResult<Resp> {
        let body = self.read_json(ctx).await?;
        let entry = b64(body.get("signed_entry"), "signed_entry")?;
        let wraps = wraps_of(body.get("sealed_room_keys"), "sealed_room_keys")?;
        let back_link = match body.get("key_back_link") {
            None | Some(Value::Null) => None,
            v => Some(b64(v, "key_back_link")?),
        };
        let mut core = r.core.lock();
        let (out, _) = {
            let c = self.db.w();
            RoomCore::accept_entry(&c, Some(&mut core), "", &entry, &wraps, back_link.as_deref(), false)?
        };
        if !out.removed.is_empty() {
            self.close_streams(r, &out.removed, |_| true);
            self.log(&format!("room {}: {} device(s) removed, key epoch {}", &r.id[..8], out.removed.len(), out.epoch));
        }
        self.deliver_all(r, Chunk { text: sse("member_entry", &json!({ "entry_number": out.seq, "entry_hash": out.hash, "key_epoch": out.epoch }), None), n: None });
        drop(core);
        Ok(json(200, &json!({ "entry_number": out.seq, "entry_hash": out.hash, "key_epoch": out.epoch, "entry_action": crate::store::action_name(out.ty) })))
    }

    async fn post_envelope(self: &Arc<Self>, r: &Arc<Room>, ctx: &mut Ctx) -> HResult<Resp> {
        let token = bearer(ctx)?;
        let me = r.core.lock().authorise(&token, false, true)?;
        let wait = if self.unlimited(&r.id) { 0 } else { self.envelope_limit.take(&format!("{}:{}", r.id, me.id)) };
        if wait > 0 {
            return Err(Fail::hub("rate-limited", "too many envelopes from this device").retry(wait));
        }
        let body = self.read_json(ctx).await?;
        let bytes = b64(body.get("envelope"), "envelope")?;
        let peek = zcrypto::envelope::peek_envelope(&bytes, true)?;
        if peek.split.ct.as_ref().is_some_and(|c| c.len() as f64 > self.cfg.limits.ciphertext) {
            return fail("too-large", "an envelope body is at most 64 KiB padded; put more into an attachment");
        }
        let lease = ctx.header("x-lease-generation").map(String::from);
        if let Some(l) = &lease {
            if l.is_empty() || l.len() > 16 || !l.bytes().all(|c| c.is_ascii_digit()) {
                return fail("bad-argument", "x-lease-generation");
            }
        }
        let text = body.get("envelope").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let out = {
            let mut core = r.core.lock();
            let res = {
                let c = self.db.w();
                core.post_envelope(&c, &token, &bytes, lease.as_ref().map(|l| l.parse::<i64>().unwrap()))
            };
            match res {
                Ok(out) => {
                    self.deliver_all(r, Chunk { text: sse("envelope", &json!({ "envelope_number": out.n, "envelope": text }), Some(out.n)), n: Some(out.n) });
                    out
                }
                Err(err) => {
                    if let (Some(n), Some(vb)) = (err.voided, &err.void_bytes) {
                        let rec = json!({ "envelope_number": n, "envelope": b64u(vb), "void": true, "void_code": err.code });
                        self.deliver_all(r, Chunk { text: sse("envelope", &rec, Some(n)), n: Some(n) });
                    }
                    return Err(err);
                }
            }
        };
        if out.push && self.push_limit.take(&format!("{}:{}", r.id, me.id)) == 0 {
            let (hub, room, sender) = (self.clone(), r.id.clone(), me.id.clone());
            tokio::spawn(async move { hub.send_pushes(&room, &sender, out.n, out.urgency).await });
        }
        if out.urgency.is_some() {
            self.live_soon(r);
        }
        Ok(json(200, &json!({ "envelope_number": out.n })))
    }

    /// R4 fencing: an agent names the lease generation it holds.
    fn fenced(&self, r: &Room, ctx: &Ctx, me: &crate::room::Auth) -> HResult<Option<i64>> {
        if me.role != Some("agent") {
            return Ok(None);
        }
        let raw = ctx.header("x-lease-generation");
        let ok = raw.is_some_and(|l| !l.is_empty() && l.len() <= 16 && l.bytes().all(|c| c.is_ascii_digit()));
        if !ok {
            return fail("lease-lost", "an agent names its lease generation (x-lease-generation): take the lease with agent_lease first");
        }
        let g: i64 = raw.unwrap().parse().unwrap();
        let held = {
            let mut core = r.core.lock();
            let c = self.db.w();
            core.lease_of(&c, &me.id)
        };
        if held.is_none_or(|h| h.generation != g) {
            return fail("lease-lost", "another process took over this agent key");
        }
        Ok(Some(g))
    }

    fn envelope_record(row: &EnvRow, full: bool) -> Value {
        let body = if full { row.body.as_deref() } else { None };
        let bytes = zcrypto::envelope::join_envelope(&row.header, &row.nonce, body, &row.ct_hash, &row.signature);
        let mut v = json!({ "envelope_number": row.n, "envelope": b64u(&bytes) });
        if let Some(code) = &row.void_code {
            let o = v.as_object_mut().unwrap();
            o.insert("void".into(), json!(true));
            o.insert("void_code".into(), json!(code));
        }
        v
    }
    pub fn envelope_rows(&self, room: &str, after: i64, limit: i64) -> Vec<EnvRow> {
        self.db.read(|c| {
            c.prepare_cached(
                "SELECT envelope_number, envelope_header, envelope_nonce, envelope_signature, encrypted_body_hash, void_code,
      CASE WHEN envelope_kind != 1 THEN encrypted_body END AS encrypted_body FROM envelopes WHERE room_id = ? AND envelope_number > ? ORDER BY envelope_number LIMIT ?",
            )
            .and_then(|mut s| s.query_map(params![room, after, limit], EnvRow::from_row)?.collect())
            .unwrap_or_default()
        })
    }

    async fn stream(self: &Arc<Self>, r: &Arc<Room>, ctx: &mut Ctx) -> HResult<Resp> {
        let token = bearer(ctx)?;
        let me = r.core.lock().authorise(&token, false, true)?;
        let count = Self::device_stream_count(&r.live.lock(), &me.id);
        if count as f64 >= self.cfg.limits.streams_per_device {
            return fail("too-many", &format!("at most {} streams per device", self.cfg.limits.streams_per_device));
        }
        let lease_generation = self.fenced(r, ctx, &me)?;
        let mut after = int_param(&ctx.query, "after_envelope_number", 0, 0, 9007199254740991)?;
        if !ctx.query.has("after_envelope_number") {
            if let Some(last) = ctx.header("last-event-id").and_then(crate::util::js_number_int) {
                if last.fract() == 0.0 && last > 0.0 && last <= 9007199254740991.0 {
                    after = last as i64;
                }
            }
        }
        let (s, rx) = Stream::new(&r.id, &me.id, lease_generation, ctx.client.clone(), ctx.conn.clone(), self.cfg.stream_buffer_bytes as usize, self.flow.dropped_streams.clone());
        r.live.lock().streams.push(s.clone());
        self.streams.lock().insert(s.id, s.clone());
        let agent = me.role == Some("agent");
        // pings, and an agent's lease that lives while it has a stream open
        {
            let (s2, hub, room, dev) = (s.clone(), self.clone(), r.clone(), me.id.clone());
            let ping = self.cfg.ping_ms;
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(Duration::from_millis(ping));
                tick.tick().await;
                let mut lease = tokio::time::interval(Duration::from_millis(20000));
                lease.tick().await;
                loop {
                    tokio::select! {
                        _ = tick.tick() => { if s2.over() { break } s2.write(sse("ping", &json!({}), None)); }
                        _ = lease.tick(), if agent => { hub.touch_lease(&room, &dev); }
                        _ = s2.gone.notified() => {}
                    }
                    if s2.over() {
                        break;
                    }
                }
            });
        }
        if agent {
            self.touch_lease(r, &me.id);
        }
        let first = {
            let mut live = r.live.lock();
            live.offline_since.remove(&me.id);
            Self::device_stream_count(&live, &me.id) == 1
        };
        if first {
            self.stream_opened(r, &me.id);
        }
        let on_close: Box<dyn FnOnce() + Send> = {
            let (hub, room, s3, dev) = (self.clone(), r.clone(), s.clone(), me.id.clone());
            Box::new(move || {
                let removed = {
                    let mut live = room.live.lock();
                    let before = live.streams.len();
                    live.streams.retain(|x| x.id != s3.id);
                    before != live.streams.len()
                };
                hub.streams.lock().remove(&s3.id);
                if !removed {
                    return;
                }
                if agent {
                    hub.touch_lease(&room, &dev);
                }
                let mut live = room.live.lock();
                if Self::device_stream_count(&live, &dev) > 0 {
                    return;
                }
                live.offline_since.insert(dev.clone(), now());
                drop(live);
                if hub.closing.load(Ordering::Acquire) {
                    return;
                }
                hub.streams_gone(&room, &dev);
            })
        };
        s.write(Bytes::from_static(b": trommi hub\n\n"));
        // Catch-up first (the depth rule of GET envelopes), in small slices, then whatever arrived meanwhile, then live.
        {
            let (hub, room, s4) = (self.clone(), r.id.clone(), s.clone());
            tokio::spawn(async move {
                let mut sent = after;
                while !s4.over() {
                    let rows = hub.envelope_rows(&room, sent, CATCH_UP_SLICE);
                    hub.catch_up_slices.fetch_add(1, Ordering::Relaxed);
                    for row in &rows {
                        if !s4.over() {
                            s4.write(sse("envelope", &Self::envelope_record(row, true), Some(row.n)));
                        }
                    }
                    if let Some(last) = rows.last() {
                        sent = last.n;
                    }
                    if (rows.len() as i64) < CATCH_UP_SLICE || s4.over() {
                        break;
                    }
                    if s4.queued.load(Ordering::Acquire) > CATCH_UP_HIGH_WATER {
                        loop {
                            let n = s4.drained.notified();
                            if s4.over() || s4.queued.load(Ordering::Acquire) <= CATCH_UP_HIGH_WATER {
                                break;
                            }
                            n.await;
                            break;
                        }
                    } else {
                        tokio::task::yield_now().await;
                    }
                }
                if s4.over() {
                    return;
                }
                s4.go_live(sent);
            });
        }
        let mut resp = Response::new(Body::from_box(SseBody::new(rx, s.clone(), on_close).boxed_unsync()));
        let h = resp.headers_mut();
        h.insert("content-type", "text/event-stream; charset=utf-8".parse().unwrap());
        h.insert("cache-control", "no-cache, no-transform".parse().unwrap());
        h.insert("x-accel-buffering", "no".parse().unwrap());
        h.insert("connection", "keep-alive".parse().unwrap());
        ctx.guards.push(Box::new(crate::metrics::StreamMark));
        Ok(resp)
    }
    fn touch_lease(&self, r: &Room, dev: &str) {
        let mut core = r.core.lock();
        let c = self.db.w();
        core.touch_lease(&c, dev);
    }

    async fn put_attachment(self: &Arc<Self>, r: &Arc<Room>, ctx: &mut Ctx, aid: &str) -> HResult<Resp> {
        let token = bearer(ctx)?;
        let me = r.core.lock().authorise(&token, false, true)?;
        hex_param(Some(aid), 32, "attachment_id")?;
        self.fenced(r, ctx, &me)?;
        let cl = ctx.header("content-length").and_then(|v| v.trim().parse::<f64>().ok()).unwrap_or(0.0);
        if cl > self.cfg.limits.attachment {
            return fail("too-large", "an attachment is at most 64 MiB");
        }
        ops::quota_plan(&self.db.w(), self.cfg.quota_bytes, &r.id, cl as i64, Some(&me.id))?;
        let exists = self.db.w().prepare_cached("SELECT 1 FROM attachments WHERE room_id = ? AND attachment_id = ?")?.query_row(params![r.id, aid], |_| Ok(())).optional()?.is_some();
        if exists {
            return fail("replay", "this attachment is already stored; attachments are immutable");
        }
        let limit = self.cfg.limits.attachment;
        let deadline = Duration::from_millis(60000 + ((if cl > 0.0 { cl } else { limit }) / UPLOAD_MIN_BYTES_PER_S).ceil() as u64 * 1000);
        let (file, tmp, mut f) = match self.files.begin(&r.id, aid) {
            Ok(x) => x,
            Err(PutError::Replay) => return fail("replay", "this attachment is already stored"),
            Err(PutError::Io(e)) => return Err(e.into()),
            Err(_) => return Err(Fail::internal("upload")),
        };
        let mut body = ctx.take_body();
        let mut size: u64 = 0;
        let read = async {
            use std::io::Write;
            loop {
                let frame = match tokio::time::timeout(Duration::from_millis(IDLE_MS), body.frame()).await {
                    Ok(Some(Ok(fr))) => fr,
                    Ok(Some(Err(_))) | Err(_) => return Err(PutError::Cut),
                    Ok(None) => break,
                };
                if let Some(d) = frame.data_ref() {
                    size += d.len() as u64;
                    if size as f64 > limit {
                        return Err(PutError::TooLarge);
                    }
                    f.write_all(d).map_err(PutError::Io)?;
                }
            }
            Ok(())
        };
        let res = match tokio::time::timeout(deadline, read).await {
            Ok(r) => r,
            Err(_) => Err(PutError::Cut),
        };
        match res {
            Ok(()) => {}
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                return match e {
                    PutError::TooLarge => fail("too-large", &format!("an attachment is at most {} bytes", limit as u64)),
                    PutError::Replay => fail("replay", "this attachment is already stored"),
                    PutError::Io(e) => Err(e.into()),
                    PutError::Cut => {
                        ctx.conn.destroy();
                        Err(Fail::destroy())
                    }
                };
            }
        }
        match Files::finish(&file, &tmp, f) {
            Ok(()) => {}
            Err(PutError::Replay) => return fail("replay", "this attachment is already stored"),
            Err(PutError::Io(e)) => return Err(e.into()),
            Err(_) => return Err(Fail::internal("upload")),
        }
        // C04: removed while uploading -> nothing stored.
        if let Err(e) = r.core.lock().authorise(&token, false, true) {
            self.files.delete(&r.id, aid);
            return Err(e);
        }
        let evicted = {
            let c = self.db.w();
            match ops::quota_plan(&c, self.cfg.quota_bytes, &r.id, size as i64, Some(&me.id)) {
                Ok(gone) => {
                    if !gone.is_empty() {
                        db::tx(&c, |c| {
                            for a in &gone {
                                c.execute("DELETE FROM attachments WHERE room_id = ? AND attachment_id = ?", params![r.id, a.attachment_id])?;
                            }
                            Ok::<_, rusqlite::Error>(())
                        })?;
                    }
                    gone
                }
                Err(e) => {
                    drop(c);
                    self.files.delete(&r.id, aid);
                    return Err(e);
                }
            }
        };
        if !evicted.is_empty() {
            for a in &evicted {
                self.files.delete(&r.id, &a.attachment_id);
            }
            self.log(&format!("room {}: evicted {} attachment(s) for the quota", &r.id[..8], evicted.len()));
            self.deliver_all(r, Chunk { text: sse("attachment_evicted", &json!({ "attachment_ids": evicted.iter().map(|a| a.attachment_id.clone()).collect::<Vec<_>>() }), None), n: None });
        }
        self.db.w().execute(
            "INSERT INTO attachments (room_id, attachment_id, object_id, uploader_device_id, total_size, chunk_count, stored_at) VALUES (?, ?, NULL, ?, ?, ?, ?)",
            params![r.id, aid, me.id, size as i64, db::chunk_count(size as i64), now()],
        )?;
        Ok(json(201, &json!({ "attachment_id": aid, "total_size": size })))
    }

    async fn serve_file(&self, ctx: &Ctx, room: &str, aid: &str, cacheable: bool) -> HResult<Resp> {
        let known = self.db.w().prepare_cached("SELECT 1 FROM attachments WHERE room_id = ? AND attachment_id = ?")?.query_row(params![room, aid], |_| Ok(())).optional()?.is_some();
        let file = if known { self.files.file_of(room, aid) } else { None };
        let f = match file {
            Some(p) => match tokio::fs::File::open(&p).await {
                Ok(f) => f,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return fail("not-found", "no such attachment"),
                Err(e) => return Err(e.into()),
            },
            None => return fail("not-found", "no such attachment"),
        };
        let size = f.metadata().await?.len();
        let cache = if cacheable { "private, max-age=31536000, immutable" } else { "private, no-store" };
        let head = ctx.method == "HEAD";
        let mut status = 200u16;
        let mut start = 0u64;
        let mut end = size.saturating_sub(1);
        let mut content_range = None;
        if let Some(range) = ctx.header("range") {
            let t = range.trim();
            let parsed = t.strip_prefix("bytes=").and_then(|x| x.split_once('-')).filter(|(a, b)| a.bytes().all(|c| c.is_ascii_digit()) && b.bytes().all(|c| c.is_ascii_digit()));
            let mut ok = false;
            if let Some((a, b)) = parsed {
                if !a.is_empty() {
                    start = a.parse().unwrap_or(u64::MAX);
                    end = if !b.is_empty() { b.parse::<u64>().unwrap_or(u64::MAX).min(size.saturating_sub(1)) } else { size.saturating_sub(1) };
                    ok = true;
                } else if !b.is_empty() {
                    start = size.saturating_sub(b.parse::<u64>().unwrap_or(u64::MAX));
                    end = size.saturating_sub(1);
                    ok = true;
                }
            }
            if !ok || start > end || start >= size {
                let text = serde_json::to_string(&json!({ "error": "bad-argument", "message": "range not satisfiable" })).unwrap();
                let mut r = Response::new(Body::full(text));
                *r.status_mut() = StatusCode::RANGE_NOT_SATISFIABLE;
                r.headers_mut().insert("content-range", format!("bytes */{size}").parse().unwrap());
                r.headers_mut().insert("content-type", "application/json".parse().unwrap());
                return Ok(r);
            }
            status = 206;
            content_range = Some(format!("bytes {start}-{end}/{size}"));
        }
        let len = if size == 0 { 0 } else { end - start + 1 };
        let body = if head || len == 0 {
            Body::empty()
        } else {
            use tokio::io::{AsyncReadExt, AsyncSeekExt};
            let mut f = f;
            f.seek(std::io::SeekFrom::Start(start)).await?;
            let reader = tokio_util::io::ReaderStream::with_capacity(f.take(len), 65536);
            // C03 for answers: a client that takes no bytes for 30 s loses the connection (Node's request idle timeout).
            let moved = Arc::new(AtomicU64::new(crate::util::wall() as u64));
            let (m2, conn) = (moved.clone(), ctx.conn.clone());
            let watch = tokio::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    if crate::util::wall() as u64 - m2.load(Ordering::Relaxed) > IDLE_MS {
                        conn.destroy();
                        break;
                    }
                }
            });
            let guard = AbortOnDrop(watch);
            let stream = futures_util::StreamExt::map(reader, move |c| {
                let _ = &guard;
                moved.store(crate::util::wall() as u64, Ordering::Relaxed);
                c.map(http_body::Frame::data)
            });
            Body::from_box(http_body_util::StreamBody::new(stream).boxed_unsync())
        };
        let mut r = Response::new(body);
        *r.status_mut() = StatusCode::from_u16(status).unwrap();
        let h = r.headers_mut();
        h.insert("content-type", "application/octet-stream".parse().unwrap());
        h.insert("accept-ranges", "bytes".parse().unwrap());
        h.insert("cache-control", cache.parse().unwrap());
        if let Some(cr) = content_range {
            h.insert("content-range", cr.parse().unwrap());
        }
        h.insert("content-length", len.into());
        Ok(r)
    }

    async fn post_share(self: &Arc<Self>, r: &Arc<Room>, ctx: &mut Ctx, aid: &str) -> HResult<Resp> {
        let token = bearer(ctx)?;
        let me = r.core.lock().authorise(&token, false, true)?;
        hex_param(Some(aid), 32, "attachment_id")?;
        let up: Option<String> = self.db.w().prepare_cached("SELECT uploader_device_id FROM attachments WHERE room_id = ? AND attachment_id = ?")?.query_row(params![r.id, aid], |x| x.get(0)).optional()?;
        let Some(up) = up else { return fail("not-found", "no such attachment") };
        if up != me.id && me.role != Some("human") {
            return fail("forbidden", "only the uploader or a human device shares an attachment");
        }
        let body = self.read_json(ctx).await?;
        r.core.lock().authorise(&token, false, true)?;
        let share_id = hex_value(body.get("share_id"), 32, "share_id")?.to_string();
        let hash = b64(body.get("share_secret_hash"), "share_secret_hash")?;
        if hash.len() != 32 {
            return fail("bad-argument", "share_secret_hash is a SHA-256 (32 bytes)");
        }
        let exp = body.get("expires_at").and_then(crate::util::safe_int);
        let Some(expires_at) = exp.filter(|e| *e > now() && *e <= now() + SHARE_MAX_MS) else { return fail("bad-argument", "expires_at: in the future, at most 30 days") };
        let c = self.db.w();
        if c.prepare_cached("SELECT 1 FROM shares WHERE share_id = ?")?.query_row([&share_id], |_| Ok(())).optional()?.is_some() {
            return fail("replay", "this share id is taken");
        }
        let open: i64 = c.prepare_cached("SELECT COUNT(*) FROM shares WHERE room_id = ? AND expires_at > ?")?.query_row(params![r.id, now()], |x| x.get(0))?;
        if open >= 1000 {
            return fail("too-many", "too many open shares in this room");
        }
        c.execute(
            "INSERT INTO shares (share_id, room_id, attachment_id, share_secret_hash, expires_at, created_by_device_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![share_id, r.id, aid, hash, expires_at, me.id, now()],
        )?;
        Ok(json(201, &json!({ "share_id": share_id, "expires_at": expires_at })))
    }
    fn delete_share(&self, r: &Room, ctx: &Ctx, aid: &str, share_id: &str) -> HResult<Resp> {
        let me = r.core.lock().authorise(&bearer(ctx)?, false, true)?;
        hex_param(Some(share_id), 32, "share_id")?;
        let c = self.db.w();
        let by: Option<String> = c.prepare_cached("SELECT created_by_device_id FROM shares WHERE share_id = ? AND room_id = ? AND attachment_id = ?")?.query_row(params![share_id, r.id, aid], |x| x.get(0)).optional()?;
        let Some(by) = by else { return fail("not-found", "no such share") };
        if by != me.id && me.role != Some("human") {
            return fail("forbidden", "the creator or a human device revokes a share");
        }
        c.execute("DELETE FROM shares WHERE share_id = ?", [share_id])?;
        Ok(json(200, &json!({ "ok": true })))
    }
    async fn get_share(&self, ctx: &mut Ctx, share_id: &str) -> HResult<Resp> {
        let wait = self.share_limit.take(&ctx.ip);
        if wait > 0 {
            return Err(Fail::hub("rate-limited", "too many share requests from this address").retry(wait));
        }
        hex_param(Some(share_id), 32, "share_id")?;
        let secret = ctx.header("x-share-secret").map(String::from);
        let sh: Option<(String, String, Vec<u8>, i64)> = self
            .db
            .w()
            .prepare_cached("SELECT room_id, attachment_id, share_secret_hash, expires_at FROM shares WHERE share_id = ?")?
            .query_row([share_id], |x| Ok((x.get(0)?, x.get(1)?, x.get(2)?, x.get(3)?)))
            .optional()?;
        let mut ok = false;
        if let (Some(sh), Some(sec)) = (&sh, &secret) {
            if sec.len() == 43 && sec.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') {
                let h = zcrypto::prim::sha256(&[&crate::push::b64_lenient(sec)]);
                ok = zcrypto::bytes::bytes_equal(&h, &sh.2);
            }
        }
        let Some(sh) = sh.filter(|s| ok && s.3 > now()) else { return fail("not-found", "no such share, or it ran out") };
        let mut r = self.serve_file(ctx, &sh.0, &sh.1, false).await?;
        r.headers_mut().insert("cache-control", "private, no-store".parse().unwrap());
        Ok(r)
    }

    fn link_report(body: &Map<String, Value>) -> HResult<Value> {
        let time = |v: Option<&Value>, what: &str| -> HResult<Value> {
            match v {
                None | Some(Value::Null) => Ok(Value::Null),
                Some(x) => match crate::util::safe_int(x) {
                    Some(n) if n > 0 => Ok(json!(n)),
                    _ => fail("bad-argument", &format!("{what} is a time in milliseconds, or null")),
                },
            }
        };
        let hears = body.get("hears").and_then(|h| h.as_str()).filter(|h| LINK_HEARS.contains(h));
        let Some(hears) = hears else { return fail("bad-argument", "hears: live or oncall") };
        if body.get("attached").is_some_and(|a| !a.is_null() && !a.is_boolean()) {
            return fail("bad-argument", "attached");
        }
        if body.get("working").is_some_and(|a| !a.is_null() && !a.is_boolean()) {
            return fail("bad-argument", "working");
        }
        let mut exit = None;
        if let Some(e) = body.get("exit").filter(|e| !e.is_null()) {
            let reason = e.get("reason").and_then(|r| r.as_str());
            let claude = e.get("claude").and_then(|c| c.as_str());
            let ok = e.is_object() && reason.is_some_and(|r| !r.is_empty() && r.len() <= 40 && r.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')) && claude.is_some_and(|c| LINK_CLAUDE.contains(&c));
            if !ok {
                return fail("bad-argument", "exit: { reason, claude: alive | gone | checking }");
            }
            exit = Some(json!({ "reason": reason, "claude": claude }));
        }
        let mut rep = json!({
            "hears": hears,
            "attached": body.get("attached") != Some(&Value::Bool(false)),
            "last_call_at": time(body.get("last_call_at"), "last_call_at")?,
            "working": body.get("working") == Some(&Value::Bool(true)),
            "since": time(body.get("since"), "since")?,
            "cut_since": time(body.get("cut_since"), "cut_since")?,
        });
        if let Some(e) = exit {
            rep.as_object_mut().unwrap().insert("exit".into(), e);
        }
        Ok(rep)
    }

    async fn room_route(self: &Arc<Self>, ctx: &mut Ctx, room_id: &str, rest: &str) -> HResult<Resp> {
        let r = self.room(room_id).await?;
        let m = ctx.method.clone();
        let parts: Vec<String> = rest.split('/').filter(|p| !p.is_empty()).map(String::from).collect();
        let a = parts.first().map(|s| s.as_str());
        let b = parts.get(1).map(|s| s.as_str());
        let c = parts.get(2).map(|s| s.as_str());
        let p3 = parts.get(3).map(|s| s.as_str());
        let db = || self.db.w();
        if m == "POST" && a == Some("challenge") && b.is_none() {
            self.open_route(ctx, &r.id)?;
            let ch = r.core.lock().challenge();
            return Ok(json(200, &json!({ "challenge": b64u(&ch) })));
        }
        if m == "POST" && a == Some("access_tokens") && b.is_none() {
            self.open_route(ctx, &r.id)?;
            let body = self.read_json(ctx).await?;
            let signed = b64(body.get("signed_challenge"), "signed_challenge")?;
            let (token, id, recovery, role, exp) = {
                let mut core = r.core.lock();
                let c = db();
                core.sign_in(&c, &signed)?
            };
            return Ok(json(200, &json!({ "access_token": token, "device_id": id, "signer": if recovery { "recovery" } else { "device" }, "device_role": if recovery { Value::Null } else { json!(role) }, "expires_at": exp })));
        }
        if a == Some("members") && b.is_none() {
            if m == "GET" {
                let after = int_param(&ctx.query, "after_entry_number", -1, -1, 1 << 32)?;
                let invite = ctx.query.get("invite_id").map(String::from);
                if let Some(i) = &invite {
                    self.open_route(ctx, &r.id)?;
                    hex_param(Some(i), 32, "invite_id")?;
                }
                let token = if invite.is_none() { Some(bearer(ctx)?) } else { None };
                let (rid, head, entries) = {
                    let mut core = r.core.lock();
                    let c = db();
                    core.log(&c, token.as_deref(), invite.as_deref(), after)?
                };
                return Ok(json(200, &json!({ "room_id": rid, "last_entry_number": head, "signed_entries": entries.iter().map(|e| b64u(e)).collect::<Vec<_>>() })));
            }
            if m == "POST" {
                return self.member_entry(&r, ctx).await;
            }
        }
        if m == "GET" && a == Some("devices") && b.is_none() {
            let token = bearer(ctx)?;
            let head = {
                let mut core = r.core.lock();
                core.authorise(&token, false, true)?;
                core.state.head_seq
            };
            let rows: Vec<(String, String, Option<i64>)> = db()
                .prepare_cached("SELECT device_id, device_role, removed_entry_number FROM devices WHERE room_id = ? ORDER BY added_entry_number, device_id")?
                .query_map([&r.id], |x| Ok((x.get(0)?, x.get(1)?, x.get(2)?)))?
                .collect::<Result<_, _>>()?;
            let live = r.live.lock();
            let devices: Vec<Value> = rows
                .iter()
                .map(|(d, role, removed)| {
                    let online = live.streams.iter().any(|s| &s.device_id == d);
                    let mut v = json!({ "device_id": d, "device_role": role, "is_active": removed.is_none(), "is_online": online });
                    let o = v.as_object_mut().unwrap();
                    if !online {
                        if let Some(t) = live.offline_since.get(d) {
                            o.insert("offline_since".into(), json!(t));
                        }
                    }
                    if let Some(rep) = live.link.get(d).and_then(|e| e.report.clone()) {
                        o.insert("link".into(), rep);
                    }
                    v
                })
                .collect();
            return Ok(json(200, &json!({ "last_entry_number": head, "devices": devices })));
        }
        if m == "GET" && a == Some("sealed_room_keys") && b.is_none() {
            let after = int_param(&ctx.query, "after_key_epoch", 0, 0, 1 << 32)?;
            let token = bearer(ctx)?;
            let w = {
                let mut core = r.core.lock();
                let c = db();
                core.wraps(&c, &token, after)?
            };
            return Ok(json(200, &json!({ "sealed_room_keys": w.iter().map(|(e, s)| json!({ "key_epoch": e, "key_sealed": b64u(s) })).collect::<Vec<_>>() })));
        }
        if m == "GET" && a == Some("key_back_links") && b.is_none() {
            let token = bearer(ctx)?;
            let links = {
                let mut core = r.core.lock();
                let c = db();
                core.back_links(&c, &token)?
            };
            return Ok(json(200, &json!({ "key_back_links": links.iter().map(|(e, l)| json!({ "key_epoch": e, "key_back_link": b64u(l) })).collect::<Vec<_>>() })));
        }
        if a == Some("invites") {
            if m == "POST" && b.is_none() {
                let token = bearer(ctx)?;
                r.core.lock().authorise(&token, true, false)?;
                let body = self.read_json(ctx).await?;
                let offer = b64(body.get("signed_offer"), "signed_offer")?;
                let (id, role, exp) = {
                    let mut core = r.core.lock();
                    let c = db();
                    core.post_invite(&c, &token, &offer)?
                };
                return Ok(json(200, &json!({ "invite_id": id, "device_role": role, "expires_at": exp })));
            }
            if let Some(b) = b {
                hex_param(Some(b), 32, "invite_id")?;
            }
            if m == "DELETE" && b.is_some() && c.is_none() {
                let token = bearer(ctx)?;
                let mut core = r.core.lock();
                let cn = db();
                core.burn_invite(&cn, &token, b.unwrap())?;
                return Ok(json(200, &json!({ "ok": true })));
            }
            if m == "GET" && b.is_some() && c.is_none() {
                self.open_route(ctx, &r.id)?;
                let (offer, role, exp, rid, entries) = {
                    let core = r.core.lock();
                    let cn = db();
                    core.invite(&cn, b.unwrap())?
                };
                return Ok(json(200, &json!({ "signed_offer": b64u(&offer), "device_role": role, "expires_at": exp, "room_id": rid, "signed_entries": entries.iter().map(|e| b64u(e)).collect::<Vec<_>>() })));
            }
            if b.is_some() && c == Some("requests") && p3.is_none() {
                let b = b.unwrap().to_string();
                if m == "POST" {
                    self.open_route(ctx, &r.id)?;
                    let body = self.read_json(ctx).await?;
                    let req = b64(body.get("signed_request"), "signed_request")?;
                    let mut core = r.core.lock();
                    let (rh, inviter, repeated) = {
                        let cn = db();
                        core.post_request(&cn, &b, &req)?
                    };
                    if !repeated {
                        self.deliver(&r, Chunk { text: sse("join_request", &json!({ "invite_id": b }), None), n: None }, |s| s.device_id == inviter);
                    }
                    return Ok(json(200, &json!({ "request_hash": rh })));
                }
                if m == "GET" {
                    let token = bearer(ctx)?;
                    let list = {
                        let mut core = r.core.lock();
                        let cn = db();
                        core.requests(&cn, &token, &b)?
                    };
                    return Ok(json(200, &json!({ "signed_requests": list.iter().map(|x| b64u(x)).collect::<Vec<_>>() })));
                }
            }
            if m == "POST" && b.is_some() && c == Some("reveal") && p3.is_none() {
                let b = b.unwrap().to_string();
                let token = bearer(ctx)?;
                r.core.lock().authorise(&token, true, false)?;
                let body = self.read_json(ctx).await?;
                let reveal = b64(body.get("signed_reveal"), "signed_reveal")?;
                let rh = {
                    let mut core = r.core.lock();
                    let cn = db();
                    core.post_reveal(&cn, &token, &b, &reveal)?
                };
                return Ok(json(200, &json!({ "request_hash": rh })));
            }
            if m == "GET" && b.is_some() && c == Some("status") && p3.is_none() {
                self.open_route(ctx, &r.id)?;
                let rh = hex_param(ctx.query.get("request_hash"), 64, "request_hash")?.to_string();
                let st = {
                    let core = r.core.lock();
                    let cn = db();
                    core.join_status(&cn, b.unwrap(), &rh)?
                };
                let v = match st {
                    JoinStatus::Waiting => json!({ "join_status": "waiting" }),
                    JoinStatus::Taken => json!({ "join_status": "taken" }),
                    JoinStatus::Revealed(rv) => json!({ "join_status": "revealed", "signed_reveal": b64u(&rv) }),
                    JoinStatus::Joined { reveal, entries, wrap } => {
                        let mut v = json!({ "join_status": "joined" });
                        let o = v.as_object_mut().unwrap();
                        if let Some(rv) = reveal {
                            o.insert("signed_reveal".into(), json!(b64u(&rv)));
                        }
                        o.insert("signed_entries".into(), json!(entries.iter().map(|e| b64u(e)).collect::<Vec<_>>()));
                        if let Some(w) = wrap {
                            o.insert("key_sealed".into(), json!(b64u(&w)));
                        }
                        v
                    }
                };
                return Ok(json(200, &v));
            }
        }
        if a == Some("envelopes") && b.is_none() {
            if m == "POST" {
                return self.post_envelope(&r, ctx).await;
            }
            if m == "GET" {
                let token = bearer(ctx)?;
                let who = r.core.lock().authorise(&token, false, false)?;
                let mut after = int_param(&ctx.query, "after_envelope_number", 0, 0, 9007199254740991)?;
                let limit = int_param(&ctx.query, "limit", 1000, 1, 1000)?;
                let last: i64 = self.db.read(|c| c.prepare_cached("SELECT last_envelope_number FROM rooms WHERE room_id = ?").and_then(|mut s| s.query_row([&r.id], |x| x.get(0)))).unwrap_or(0);
                if ctx.query.get("newest") == Some("1") {
                    after = after.max(last - limit);
                }
                let rows = self.envelope_rows(&r.id, after, limit);
                let out: Vec<Value> = rows.iter().map(|x| Self::envelope_record(x, !who.recovery)).collect();
                return Ok(json(200, &json!({ "last_envelope_number": last, "envelopes": out })));
            }
        }
        if m == "GET" && a == Some("threads") && b.is_none() {
            let token = bearer(ctx)?;
            r.core.lock().authorise(&token, false, true)?;
            let kp = ctx.query.get("timeline_kind").unwrap_or("");
            let kind = match kp {
                "chat" => Some(1),
                "scribble" => Some(2),
                _ if !kp.is_empty() && kp.len() <= 3 && kp.bytes().all(|c| c.is_ascii_digit()) && (1..=255).contains(&kp.parse::<i64>().unwrap()) => Some(kp.parse::<i64>().unwrap()),
                _ => None,
            };
            let Some(kind) = kind else { return fail("bad-argument", "timeline_kind: chat, canvas or a number") };
            let tid = ctx.query.get("timeline_id").unwrap_or("").to_string();
            if tid.is_empty() || tid.len() > zcrypto::envelope::TIMELINE_ID_MAX {
                return fail("bad-argument", "timeline_id");
            }
            let limit = int_param(&ctx.query, "limit", 50, 1, 500)?;
            let cols = "envelope_number, envelope_header, envelope_nonce, envelope_signature, encrypted_body_hash, void_code, encrypted_body";
            let rows: Vec<EnvRow> = if ctx.query.has("after_envelope_number") {
                let after = int_param(&ctx.query, "after_envelope_number", 0, 0, 9007199254740991)?;
                self.db.read(|c| {
                    c.prepare_cached(&format!("SELECT {cols} FROM envelopes WHERE room_id = ? AND timeline_kind = ? AND timeline_id = ? AND envelope_number > ? ORDER BY envelope_number LIMIT ?"))
                        .and_then(|mut s| s.query_map(params![r.id, kind, tid, after, limit + 1], EnvRow::from_row)?.collect())
                })?
            } else {
                let before = int_param(&ctx.query, "before_envelope_number", 9007199254740991, 1, 9007199254740991)?;
                self.db.read(|c| {
                    c.prepare_cached(&format!("SELECT {cols} FROM envelopes WHERE room_id = ? AND timeline_kind = ? AND timeline_id = ? AND envelope_number < ? ORDER BY envelope_number DESC LIMIT ?"))
                        .and_then(|mut s| s.query_map(params![r.id, kind, tid, before, limit + 1], EnvRow::from_row)?.collect())
                })?
            };
            let has_more = rows.len() as i64 > limit;
            let out: Vec<Value> = rows.iter().take(limit as usize).map(|x| Self::envelope_record(x, true)).collect();
            return Ok(json(200, &json!({ "envelopes": out, "has_more": has_more })));
        }
        if m == "GET" && a == Some("stream") && b.is_none() {
            return self.stream(&r, ctx).await;
        }
        if m == "POST" && a == Some("agent_lease") && b.is_none() {
            let token = bearer(ctx)?;
            r.core.lock().authorise(&token, false, true)?;
            let body = self.read_json(ctx).await?;
            let instance = body.get("process_instance").and_then(|v| v.as_str()).filter(|s| !s.is_empty() && crate::util::js_len(s) <= 200);
            let Some(instance) = instance else { return fail("bad-argument", "process_instance") };
            let mut core = r.core.lock();
            let me = core.authorise(&token, false, true)?;
            let (generation, exp, prev) = {
                let c = db();
                core.take_lease(&c, &token, instance, body.get("renew") == Some(&Value::Bool(true)))?
            };
            drop(core);
            if prev.is_some() {
                self.close_streams(&r, std::slice::from_ref(&me.id), |s| s.lease_generation != Some(generation));
            }
            return Ok(json(200, &json!({ "lease_generation": generation, "expires_at": exp })));
        }
        if m == "POST" && a == Some("agent_link") && b.is_none() {
            let token = bearer(ctx)?;
            let me = r.core.lock().authorise(&token, false, true)?;
            if me.role != Some("agent") {
                return fail("forbidden", "only an agent reports its link");
            }
            self.fenced(&r, ctx, &me)?;
            let body = self.read_json(ctx).await?;
            let report = Self::link_report(&body)?;
            let cut_since = report["cut_since"].as_i64();
            let mut changed = false;
            {
                let mut live = r.live.lock();
                let e = live.link.entry(me.id.clone()).or_default();
                let working = report["working"] == Value::Bool(true);
                if e.working != working {
                    changed = true;
                }
                e.working = working;
                e.report = Some(report);
            }
            if changed {
                self.live_soon(&r);
            }
            self.announce(&r, &me.id);
            let push = {
                let mut live = r.live.lock();
                let has_stream = Self::device_stream_count(&live, &me.id) > 0;
                let e = live.link.entry(me.id.clone()).or_default();
                match cut_since {
                    None => {
                        e.cut_pushed = None;
                        None
                    }
                    Some(cs) if e.cut_pushed != Some(cs) && has_stream => {
                        e.cut_pushed = Some(cs);
                        Some(cs)
                    }
                    _ => None,
                }
            };
            if let Some(cs) = push {
                let (hub, room, dev) = (self.clone(), r.id.clone(), me.id.clone());
                tokio::spawn(async move { hub.send_link_push(&room, &dev, "cut", json!(cs)).await });
            }
            return Ok(json(200, &json!({ "ok": true })));
        }
        if m == "POST" && a == Some("agent_watch") && b.is_none() {
            let token = bearer(ctx)?;
            let me = r.core.lock().authorise(&token, false, true)?;
            if me.role != Some("agent") {
                return fail("forbidden", "only an agent arms the loss watch");
            }
            self.fenced(&r, ctx, &me)?;
            let body = self.read_json(ctx).await?;
            let Some(working) = body.get("working").and_then(|w| w.as_bool()) else { return fail("bad-argument", "working") };
            let changed = {
                let mut live = r.live.lock();
                let e = live.link.entry(me.id.clone()).or_default();
                let changed = e.working != working;
                e.working = working;
                changed
            };
            if changed {
                self.live_soon(&r);
            }
            return Ok(json(200, &json!({ "ok": true })));
        }
        if a == Some("session_grants") && b.is_none() && m == "POST" {
            let body = self.read_json(ctx).await?;
            let Some(Value::Array(list)) = body.get("grants") else { return fail("bad-argument", "grants must be a list") };
            let mut grants = vec![];
            for g in list {
                let session_id = hex_value(g.get("session_id"), 32, "session_id")?.to_string();
                let grant = b64(g.get("signed_grant"), "signed_grant")?;
                let wraps = match g.get("sealed_session_keys") {
                    Some(Value::Array(_)) => wraps_of(g.get("sealed_session_keys"), "sealed_session_keys")?,
                    _ => return fail("bad-argument", "sealed_session_keys must be a list"),
                };
                let back_link = match g.get("key_back_link") {
                    None | Some(Value::Null) => None,
                    v => Some(b64(v, "key_back_link")?),
                };
                grants.push(GrantIn { session_id, grant, wraps, back_link });
            }
            let mut core = r.core.lock();
            let out = {
                let c = db();
                core.post_grants(&c, grants)?
            };
            for o in &out {
                self.deliver_all(&r, Chunk { text: sse("session_grant", &json!({ "session_id": o.session_id, "grant_number": o.grant_number, "session_key_epoch": o.session_key_epoch }), None), n: None });
            }
            drop(core);
            return Ok(json(200, &json!({ "grants": out.iter().map(|o| json!({ "session_id": o.session_id, "grant_number": o.grant_number, "grant_hash": o.grant_hash, "session_key_epoch": o.session_key_epoch })).collect::<Vec<_>>() })));
        }
        if a == Some("session_grants") && b.is_none() && m == "GET" {
            let ids = match ctx.query.get("session_ids") {
                None => None,
                Some(raw) => {
                    let mut v = vec![];
                    for x in raw.split(',').filter(|x| !x.is_empty()) {
                        v.push(hex_param(Some(x), 32, "session_id")?.to_string());
                    }
                    Some(v)
                }
            };
            if ids.as_ref().is_some_and(|i| i.len() > 256) {
                return fail("bad-argument", "at most 256 session_ids");
            }
            let token = bearer(ctx)?;
            let out = {
                let mut core = r.core.lock();
                let c = db();
                core.session_bundle(&c, &token, ids)?
            };
            let sessions: Vec<Value> = out
                .iter()
                .map(|x| {
                    let mut v = json!({
                        "session_id": x.session_id,
                        "signed_grants": x.grants.iter().map(|g| b64u(g)).collect::<Vec<_>>(),
                        "sealed_session_keys": x.wraps.iter().map(|(e, s)| json!({ "session_key_epoch": e, "key_sealed": b64u(s) })).collect::<Vec<_>>(),
                    });
                    if let Some(l) = &x.links {
                        v.as_object_mut().unwrap().insert("key_back_links".into(), json!(l.iter().map(|(e, k)| json!({ "session_key_epoch": e, "key_back_link": b64u(k) })).collect::<Vec<_>>()));
                    }
                    v
                })
                .collect();
            return Ok(json(200, &json!({ "sessions": sessions })));
        }
        if a == Some("sessions") {
            if m == "GET" && b.is_none() {
                let token = bearer(ctx)?;
                let list = {
                    let mut core = r.core.lock();
                    core.authorise(&token, false, false)?;
                    let c = db();
                    core.sessions_list(&c)?
                };
                return Ok(json(200, &json!({ "sessions": list.iter().map(|(s, g, e)| json!({ "session_id": s, "last_grant_number": g, "session_key_epoch": e })).collect::<Vec<_>>() })));
            }
            if let Some(b) = b {
                hex_param(Some(b), 32, "session_id")?;
            }
            if b.is_some() && c == Some("grants") && p3.is_none() {
                let b = b.unwrap().to_string();
                if m == "POST" {
                    let body = self.read_json(ctx).await?;
                    let grant = b64(body.get("signed_grant"), "signed_grant")?;
                    let wraps = wraps_of(body.get("sealed_session_keys"), "sealed_session_keys")?;
                    let back_link = match body.get("key_back_link") {
                        None | Some(Value::Null) => None,
                        v => Some(b64(v, "key_back_link")?),
                    };
                    let mut core = r.core.lock();
                    let out = {
                        let c = db();
                        core.post_grant(&c, GrantIn { session_id: b.clone(), grant, wraps, back_link })?
                    };
                    self.deliver_all(&r, Chunk { text: sse("session_grant", &json!({ "session_id": b, "grant_number": out.grant_number, "session_key_epoch": out.session_key_epoch }), None), n: None });
                    drop(core);
                    return Ok(json(200, &json!({ "grant_number": out.grant_number, "grant_hash": out.grant_hash, "session_key_epoch": out.session_key_epoch })));
                }
                if m == "GET" {
                    let after = int_param(&ctx.query, "after_grant_number", -1, -1, 1 << 32)?;
                    let token = bearer(ctx)?;
                    let g = {
                        let mut core = r.core.lock();
                        let c = db();
                        core.grants(&c, &token, &b)?
                    };
                    return Ok(json(200, &json!({ "signed_grants": g.iter().skip((after + 1).max(0) as usize).map(|x| b64u(x)).collect::<Vec<_>>() })));
                }
            }
            if m == "GET" && b.is_some() && c == Some("sealed_session_keys") && p3.is_none() {
                let after = int_param(&ctx.query, "after_session_key_epoch", 0, 0, 1 << 32)?;
                let token = bearer(ctx)?;
                let w = {
                    let mut core = r.core.lock();
                    let cn = db();
                    core.session_wraps(&cn, &token, b.unwrap(), after)?
                };
                return Ok(json(200, &json!({ "sealed_session_keys": w.iter().map(|(e, s)| json!({ "session_key_epoch": e, "key_sealed": b64u(s) })).collect::<Vec<_>>() })));
            }
            if m == "GET" && b.is_some() && c == Some("key_back_links") && p3.is_none() {
                let token = bearer(ctx)?;
                let l = {
                    let mut core = r.core.lock();
                    let cn = db();
                    core.session_back_links(&cn, &token, b.unwrap())?
                };
                return Ok(json(200, &json!({ "key_back_links": l.iter().map(|(e, k)| json!({ "session_key_epoch": e, "key_back_link": b64u(k) })).collect::<Vec<_>>() })));
            }
        }
        if a == Some("attachments") {
            if let Some(b) = b {
                hex_param(Some(b), 32, "attachment_id")?;
            }
            if b.is_some() && c == Some("shares") {
                if let Some(p) = p3 {
                    hex_param(Some(p), 32, "share_id")?;
                }
            }
            if b.is_some() && c.is_none() {
                let b = b.unwrap().to_string();
                if m == "PUT" {
                    return self.put_attachment(&r, ctx, &b).await;
                }
                if m == "GET" || m == "HEAD" {
                    r.core.lock().authorise(&bearer(ctx)?, false, true)?;
                    return self.serve_file(ctx, &r.id, &b, true).await;
                }
            }
            if b.is_some() && c == Some("shares") {
                let b = b.unwrap().to_string();
                if m == "POST" && p3.is_none() {
                    return self.post_share(&r, ctx, &b).await;
                }
                if m == "DELETE" && p3.is_some() && parts.get(4).is_none() {
                    return self.delete_share(&r, ctx, &b, p3.unwrap());
                }
            }
        }
        if m == "GET" && a == Some("push_subscriptions") && b.is_none() {
            r.core.lock().authorise(&bearer(ctx)?, true, false)?;
            let rows: Vec<(String, String, String)> = db()
                .prepare_cached(
                    "SELECT p.device_id, p.endpoint, p.level FROM push_subscriptions p JOIN devices d ON d.room_id = p.room_id AND d.device_id = p.device_id
        WHERE p.room_id = ? AND d.device_role = 'human' AND d.removed_entry_number IS NULL",
                )?
                .query_map([&r.id], |x| Ok((x.get(0)?, x.get(1)?, x.get(2)?)))?
                .collect::<Result<_, _>>()?;
            let mut devices = Map::new();
            for (dev, endpoint, level) in rows {
                let d = devices.entry(dev).or_insert_with(|| json!({ "web": 0, "apns": 0, "level": level }));
                let k = if endpoint.starts_with("apns:") { "apns" } else { "web" };
                d[k] = json!(d[k].as_i64().unwrap() + 1);
                if level == "all" {
                    d["level"] = json!("all");
                }
            }
            return Ok(json(200, &json!({ "devices": devices })));
        }
        if m == "POST" && a == Some("push_subscriptions") && b.is_none() {
            let token = bearer(ctx)?;
            let me = r.core.lock().authorise(&token, true, false)?;
            let body = self.read_json(ctx).await?;
            let apns_given = body.get("apns").is_some_and(|v| !v.is_null());
            if apns_given && self.apns.is_none() {
                return fail("bad-argument", "this hub sends no APNs push");
            }
            let a = if apns_given { self.apns.as_ref().unwrap().check(&body["apns"]) } else { None };
            if apns_given && a.is_none() {
                return fail("bad-argument", "not an APNs registration: { token, environment: sandbox | production, topic, key }");
            }
            let sub = match a {
                Some(a) => json!({ "endpoint": format!("apns:{}", a["token"].as_str().unwrap()), "apns": a }),
                None => match self.push.check(body.get("subscription")) {
                    Some(s) => s,
                    None => return fail("bad-argument", "not a Web Push subscription of a browser push service"),
                },
            };
            let level = body.get("level").filter(|l| !l.is_null());
            if let Some(l) = level {
                if !l.as_str().is_some_and(|s| PUSH_LEVELS.contains(&s)) {
                    return fail("bad-argument", &format!("level is one of {}", PUSH_LEVELS.join(", ")));
                }
            }
            let endpoint = sub["endpoint"].as_str().unwrap().to_string();
            let c = db();
            if body.get("remove") == Some(&Value::Bool(true)) {
                c.execute("DELETE FROM push_subscriptions WHERE room_id = ? AND device_id = ? AND endpoint = ?", params![r.id, me.id, endpoint])?;
            } else {
                let n: i64 = c.prepare_cached("SELECT COUNT(*) FROM push_subscriptions WHERE room_id = ? AND device_id = ?")?.query_row(params![r.id, me.id], |x| x.get(0))?;
                let has = c.prepare_cached("SELECT 1 FROM push_subscriptions WHERE room_id = ? AND device_id = ? AND endpoint = ?")?.query_row(params![r.id, me.id, endpoint], |_| Ok(())).optional()?.is_some();
                if n as f64 >= self.cfg.limits.push_subscriptions_per_device && !has {
                    return fail("too-many", "too many push subscriptions for this device");
                }
                let sql = format!(
                    "INSERT INTO push_subscriptions (room_id, device_id, endpoint, subscription, created_at, level) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET subscription = excluded.subscription{}",
                    if level.is_some() { ", level = excluded.level" } else { "" }
                );
                c.execute(&sql, params![r.id, me.id, endpoint, serde_json::to_string(&sub).unwrap(), now(), level.and_then(|l| l.as_str()).unwrap_or("all")])?;
            }
            return Ok(json(200, &json!({ "ok": true })));
        }
        // One envelope for an iPhone's Notification Service Extension, against the ticket of its push: no access token.
        if m == "GET" && a == Some("push_envelope") && b.is_none() {
            self.open_route(ctx, &r.id)?;
            let n = int_param(&ctx.query, "envelope_number", 0, 1, 9007199254740991)?;
            let dev = hex_param(ctx.query.get("device_id"), 64, "device_id")?.to_string();
            if !self.tickets.check(&r.id, &dev, n, ctx.query.get("ticket"), now()) {
                return fail("forbidden", "no valid ticket for this envelope");
            }
            let active = self
                .db
                .read(|c| c.prepare_cached("SELECT 1 FROM devices WHERE room_id = ? AND device_id = ? AND device_role = 'human' AND removed_entry_number IS NULL").and_then(|mut s| s.query_row([&r.id, &dev], |_| Ok(())).optional()))
                .ok()
                .flatten()
                .is_some();
            if !active {
                return fail("forbidden", "not an active human device");
            }
            let rows = self.envelope_rows(&r.id, n - 1, 1);
            let Some(row) = rows.first().filter(|x| x.n == n) else { return fail("not-found", "no such envelope") };
            return Ok(json(200, &Self::envelope_record(row, true)));
        }
        // An iPhone's Live Activity tokens: kind start (push-to-start, with its tag) or activity; remove: true forgets one.
        if m == "POST" && a == Some("live_activity") && b.is_none() {
            let token = bearer(ctx)?;
            let me = r.core.lock().authorise(&token, true, false)?;
            let body = self.read_json(ctx).await?;
            let Some(apns) = &self.apns else { return fail("bad-argument", "this hub sends no APNs push") };
            let Some(reg) = body.get("apns").and_then(|a| apns.check_live(a)) else {
                return fail("bad-argument", "not an APNs token: { token, environment: sandbox | production, topic }");
            };
            let kind = body.get("kind").and_then(|k| k.as_str()).unwrap_or("");
            if kind != "start" && kind != "activity" {
                return fail("bad-argument", "kind is start or activity");
            }
            let col = if kind == "start" { "start_token" } else { "activity_token" };
            let tok = reg["token"].as_str().unwrap().to_string();
            if body.get("remove") == Some(&Value::Bool(true)) {
                let c = db();
                c.execute(&format!("UPDATE live_activities SET {col} = NULL WHERE room_id = ? AND device_id = ? AND {col} = ?"), params![r.id, me.id, tok])?;
                c.execute("DELETE FROM live_activities WHERE room_id = ? AND device_id = ? AND start_token IS NULL AND activity_token IS NULL", params![r.id, me.id])?;
            } else {
                let tag = body.get("tag").and_then(|t| t.as_str()).unwrap_or("");
                if kind == "start" && !((8..=32).contains(&tag.len()) && tag.bytes().all(|x| matches!(x, b'0'..=b'9' | b'a'..=b'f'))) {
                    return fail("bad-argument", "tag: 8 to 32 lowercase hex");
                }
                let sql = format!(
                    "INSERT INTO live_activities (room_id, device_id, environment, topic, tag, {col}, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (room_id, device_id) DO UPDATE SET environment = excluded.environment, topic = excluded.topic, {col} = excluded.{col}{}",
                    if kind == "start" { ", tag = excluded.tag" } else { "" }
                );
                db().execute(&sql, params![r.id, me.id, reg["environment"].as_str().unwrap(), reg["topic"].as_str().unwrap(), if kind == "start" { tag } else { "" }, tok, now()])?;
                self.live_soon(&r);
            }
            let (working, waiting) = self.live_counts(&r);
            return Ok(json(200, &json!({ "ok": true, "working": working, "waiting": waiting })));
        }
        fail("not-found", "no such route")
    }

    // ---- retention, sweeps, caps ------------------------------------------------------------------

    /// Prune objects answered or closed for `days`: their envelopes and their card chat keep only header, hash, signature.
    pub fn prune(&self, days: f64) -> Value {
        let cutoff = now() - (days * DAY as f64) as i64;
        let c = self.db.w();
        let due: Vec<(String, String)> = c
            .prepare_cached(
                "SELECT o.room_id, o.object_id FROM objects o JOIN envelopes e ON e.room_id = o.room_id AND e.envelope_number = o.latest_head_envelope_number
      WHERE o.object_state != 1 AND e.received_at < ?",
            )
            .and_then(|mut s| s.query_map([cutoff], |r| Ok((r.get(0)?, r.get(1)?)))?.collect())
            .unwrap_or_default();
        let (mut envelopes, mut attachments) = (0usize, 0usize);
        for (room, oid) in &due {
            let mut gone = vec![];
            let r = db::tx(&c, |c| {
                let n = c.execute(
                    "UPDATE envelopes SET encrypted_body = NULL WHERE room_id = ? AND encrypted_body IS NOT NULL
          AND (object_id = ? OR (timeline_kind = 1 AND timeline_id = ?))",
                    params![room, oid, format!("card/{oid}")],
                )?;
                let ids: Vec<String> = c.prepare_cached("SELECT attachment_id FROM attachments WHERE room_id = ? AND object_id = ?")?.query_map(params![room, oid], |r| r.get(0))?.collect::<Result<_, _>>()?;
                for a in &ids {
                    c.execute("DELETE FROM attachments WHERE room_id = ? AND attachment_id = ?", params![room, a])?;
                }
                gone = ids;
                Ok::<_, rusqlite::Error>(n)
            });
            if let Ok(n) = r {
                envelopes += n;
                for a in &gone {
                    self.files.delete(room, a);
                }
                attachments += gone.len();
            }
        }
        if envelopes > 0 || attachments > 0 {
            self.log(&format!("retention: pruned {envelopes} envelopes, deleted {attachments} attachments"));
        }
        json!({ "objects": due.len(), "envelopes": envelopes, "attachments": attachments })
    }
    /// H3: an upload no envelope of its uploader named within an hour is deleted.
    pub fn sweep_pending(&self, older_than_ms: i64) -> usize {
        let c = self.db.w();
        let due: Vec<(String, String)> = c
            .prepare_cached("SELECT room_id, attachment_id FROM attachments WHERE referenced_at IS NULL AND stored_at < ?")
            .and_then(|mut s| s.query_map([now() - older_than_ms], |r| Ok((r.get(0)?, r.get(1)?)))?.collect())
            .unwrap_or_default();
        for (room, a) in &due {
            let _ = c.execute("DELETE FROM attachments WHERE room_id = ? AND attachment_id = ? AND referenced_at IS NULL", params![room, a]);
            self.files.delete(room, a);
        }
        if !due.is_empty() {
            self.log(&format!("deleted {} upload(s) no envelope named within an hour", due.len()));
        }
        due.len()
    }
    /// Over the global stream buffer cap: the fattest are dropped until 80 % remain.
    pub fn cap_streams(&self) -> usize {
        let cap = self.cfg.stream_buffer_total_bytes;
        let mut all: Vec<(Arc<Stream>, usize)> = self.streams.lock().values().map(|s| (s.clone(), s.queued.load(Ordering::Acquire) + if s.catching_up() { s.pending_bytes() } else { 0 })).collect();
        let mut total: usize = all.iter().map(|x| x.1).sum();
        if total as f64 <= cap {
            return 0;
        }
        all.sort_by(|a, b| b.1.cmp(&a.1));
        let mut dropped = 0;
        for (s, b) in all {
            if total as f64 <= cap * 0.8 {
                break;
            }
            s.destroy();
            total -= b;
            dropped += 1;
        }
        self.log(&format!("stream buffers over {} MiB: dropped {dropped} stream(s); they resume by cursor", (cap as u64) >> 20));
        dropped
    }
    /// Bytes waiting per stream: (total, max, count).
    pub fn outbound(&self) -> (usize, usize, usize) {
        let streams = self.streams.lock();
        let mut total = 0;
        let mut max = 0;
        for s in streams.values() {
            let b = s.queued.load(Ordering::Acquire) + if s.catching_up() { s.pending_bytes() } else { 0 };
            total += b;
            max = max.max(b);
        }
        (total, max, streams.len())
    }
    pub fn sweep_limits(&self) {
        self.envelope_limit.sweep();
        self.open_limit.sweep();
        self.push_limit.sweep();
        let t = now();
        self.founded.lock().retain(|_, times| {
            times.retain(|x| t - x < 3600000);
            !times.is_empty()
        });
    }
    /// New minimum versions at run time: open streams of clients now too old get `upgrade_required` and are closed.
    pub fn update_versions(&self, next: &Value) {
        self.versions.update(next);
        let list: Vec<Arc<Stream>> = self.streams.lock().values().cloned().collect();
        for s in list {
            if !self.versions.too_old(s.client.as_ref()) || s.over() {
                continue;
            }
            let body = self.versions.upgrade_body(s.client.as_ref().unwrap());
            s.end(Some(Bytes::from(format!("event: upgrade_required\ndata: {}\n\n", serde_json::to_string(&body).unwrap()))));
        }
    }
    /// End every stream (close()).
    pub fn end_all_streams(&self) {
        let list: Vec<Arc<Stream>> = self.streams.lock().values().cloned().collect();
        for s in list {
            s.end(None);
        }
    }
}

/** Ends a watchdog task when the answer it watches is gone. */
struct AbortOnDrop(tokio::task::JoinHandle<()>);
impl Drop for AbortOnDrop {
    fn drop(&mut self) { self.0.abort() }
}

struct InFlight(Arc<Hub>);
impl Drop for InFlight {
    fn drop(&mut self) {
        if self.0.in_flight.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.0.drained.notify_waiters();
        }
    }
}

pub struct EnvRow {
    pub n: i64,
    pub header: Vec<u8>,
    pub nonce: Vec<u8>,
    pub signature: Vec<u8>,
    pub ct_hash: Vec<u8>,
    pub void_code: Option<String>,
    pub body: Option<Vec<u8>>,
}
impl EnvRow {
    fn from_row(r: &rusqlite::Row) -> rusqlite::Result<EnvRow> {
        Ok(EnvRow { n: r.get(0)?, header: r.get(1)?, nonce: r.get(2)?, signature: r.get(3)?, ct_hash: r.get(4)?, void_code: r.get(5)?, body: r.get(6)? })
    }
}
