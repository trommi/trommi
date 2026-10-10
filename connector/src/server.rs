//! The connector: the MCP stdio server `trommi` and the commands around it.
//!
//!   trommi-connector                  MCP server (Claude Code starts it from the plugin or .mcp.json)
//!   trommi-connector join <link>      join a room with an agent invite link, then exit
//!   trommi-connector whoami           print room, key file and folder
//!   trommi-connector say "<text>" [--session <name>] [--urgent]
//!   trommi-connector permission|notice|denied|resolved    the plugin's hooks (hook JSON on stdin)
//!   trommi-connector prompt|stop      the plugin's hooks of the terminal mirror (mirror.rs)
//!   trommi-connector trail            the plugin's hooks of a turn's trail (trail.rs)
//!   trommi-connector monitor          the plugin's monitor
//!   trommi-connector witness <session>   started by a leaving connector (the folder watch)
//!   trommi-connector driver --home <dir> the interop driver (dev/interop)

use crate::bridge::{About, Bridge};
use crate::client::{BoxFut, Command};
use crate::door::{Door, Gone, MonitorFeed};
use crate::error::Fault;
use crate::hooks::HookDesk;
use crate::mcp::Out;
use crate::member::{Cfg, Member};
use crate::prompt;
use crate::slots::*;
use crate::util::{js_string, now_ms};
use crate::{cli, door, hooks, line, mcp, member, mirror, trail};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};

pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const DEAF_HINT: &str = "This Claude Code session was started without --dangerously-load-development-channels server:trommi, so Claude Code drops the board's live events (chat, decisions) before you see them. Until the human restarts it with that flag (e.g. `claude --resume <session> --dangerously-load-development-channels server:trommi`), the events that came in are attached to your next tool result. Tell the human so once, with reply.";
pub const OTHERS_NOTE: &str = "(This waited in the connector for another Claude Code session of this folder, which held the key before this one.)";
pub const RESTART: &str =
    "In the terminal of this Claude Code session: /mcp, then trommi, then Reconnect.";

/// The path of this binary as it was started (a replaced file keeps the path).
pub fn self_path() -> PathBuf {
    static P: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    P.get_or_init(|| {
        std::env::current_exe()
            .map(|p| PathBuf::from(p.display().to_string().trim_end_matches(" (deleted)")))
            .unwrap_or_else(|_| PathBuf::from("trommi-connector"))
    })
    .clone()
}
pub fn join_hint() -> String {
    format!("run `{} join '<link>'`", self_path().display())
}

/// Whether Claude Code shows this server's channel events (the parent's command line names the channel flag).
pub fn channels_heard(args: Option<Vec<String>>) -> bool {
    match std::env::var("TROMMI_CHANNEL_EVENTS").as_deref() {
        Ok("on") => return true,
        Ok("off") => return false,
        _ => {}
    }
    let args = match args {
        Some(a) => a,
        None => {
            let a = args_of(ppid());
            let a: Vec<String> = a.into_iter().filter(|x| !x.is_empty()).collect();
            if a.is_empty() {
                return true;
            }
            a
        }
    };
    let claude = regex::Regex::new(r"(^|[\\/])claude(\.exe)?$|claude-code").unwrap();
    if !args.iter().take(2).any(|a| claude.is_match(a)) {
        return true;
    }
    let flag =
        regex::Regex::new(r"^--(dangerously-load-development-channels|channels)(=(.*))?$").unwrap();
    for (i, a) in args.iter().enumerate() {
        let Some(m) = flag.captures(a) else { continue };
        let mut values = vec![];
        if let Some(v) = m.get(3) {
            values.push(v.as_str().to_string());
        } else {
            for x in args.iter().skip(i + 1) {
                if x.starts_with('-') {
                    break;
                }
                values.push(x.clone());
            }
        }
        if values.iter().any(|v| v.contains("trommi")) {
            return true;
        }
    }
    false
}

/// <channel source="board" k="v" …>\ncontent\n</channel>
pub fn channel_tag(params: &Value) -> String {
    let meta: String = params
        .get("meta")
        .and_then(|m| m.as_object())
        .map(|m| {
            m.iter()
                .map(|(k, v)| {
                    format!(
                        " {k}=\"{}\"",
                        channel_text(&js_string(v)).replace('"', "&quot;")
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    format!(
        "<channel source=\"board\"{meta}>\n{}\n</channel>",
        channel_text(&params.get("content").map(js_string).unwrap_or_default())
    )
}
/// Board content as it stands inside a `<channel>` tag: it cannot close the tag or open another, and carries no
/// control or direction-changing characters (line breaks and tabs stay). What it says remains data.
pub fn channel_text(text: &str) -> String {
    // Every tag-like opening, not only the channel's own: board words name no tag of the harness either.
    let tags = regex::Regex::new(r"<([A-Za-z/!?])").unwrap();
    let cleaned: String = text
        .chars()
        .filter(|c| {
            (*c == '\n' || *c == '\t' || !c.is_control())
                && !matches!(*c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{200e}' | '\u{200f}')
        })
        .collect();
    tags.replace_all(&cleaned, "&lt;$1").into_owned()
}
pub(crate) fn clean_name(v: &Value) -> String {
    let s = if v.is_null() {
        String::new()
    } else {
        js_string(v)
    };
    let a = regex::Regex::new(r"[^\p{L}\p{N} ._-]")
        .unwrap()
        .replace_all(&s, "")
        .to_string();
    let b = regex::Regex::new(r"\s+")
        .unwrap()
        .replace_all(&a, " ")
        .to_string();
    crate::util::js_trim(&b).chars().take(40).collect()
}
/// A channel event as Claude Code gets it: without `echo`, which is the monitor line's alone (line.rs).
fn wire(mut params: Value) -> Value {
    if let Some(o) = params.as_object_mut() {
        o.remove("echo");
        // Claude Code builds the tag from these: what the board said goes in cleaned, as in `channel_tag`.
        if let Some(Value::String(content)) = o.get_mut("content") {
            *content = channel_text(content);
        }
        if let Some(Value::Object(meta)) = o.get_mut("meta") {
            for value in meta.values_mut() {
                if let Value::String(text) = value {
                    *text = channel_text(text);
                }
            }
        }
    }
    params
}

/// One message for the human through a bridge: chat, or with urgent an info card of urgency critical.
pub async fn say_with(bridge: Arc<Bridge>, req: Value) -> crate::error::Result<String> {
    let text = crate::util::js_trim(
        &req.get("text")
            .filter(|v| !v.is_null())
            .map(js_string)
            .unwrap_or_default(),
    )
    .to_string();
    if text.is_empty() {
        return Err(Fault::plain("nothing to say"));
    }
    if text.encode_utf16().count() > 4000 {
        return Err(Fault::plain("at most 4000 characters"));
    }
    let mut args = Map::new();
    if let Some(s) = req.get("session").filter(|v| crate::util::truthy(v)) {
        args.insert("session".into(), json!(js_string(s)));
    }
    if !req.get("urgent").is_some_and(crate::util::truthy) {
        args.insert("text".into(), json!(text));
        return bridge.call_tool("reply", &Value::Object(args)).await;
    }
    let title: String = String::from_utf16_lossy(
        &text
            .split('\n')
            .next()
            .unwrap_or("")
            .encode_utf16()
            .take(80)
            .collect::<Vec<u16>>(),
    );
    args.insert("title".into(), json!(title));
    args.insert("body".into(), json!(text));
    args.insert("urgency".into(), json!("critical"));
    args.insert(
        "urgency_reason".into(),
        json!("the agent cannot reach Trommi otherwise"),
    );
    bridge.call_tool("create_info", &Value::Object(args)).await
}

pub fn env_ms(k: &str, d: u64) -> u64 {
    std::env::var(k)
        .ok()
        .filter(|v| !v.is_empty())
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v >= 0.0)
        .map(|v| v as u64)
        .unwrap_or(d)
}

/// Hashes of this binary on disk (code and shell are one file, as in the JS single-file connector).
pub fn disk_version() -> String {
    let p = self_path();
    let mut seen = p.display().to_string().into_bytes();
    match std::fs::read(&p) {
        Ok(b) => seen.extend_from_slice(&b),
        Err(_) => seen.extend_from_slice(b"missing"),
    }
    crate::util::hex(&crate::util::sha256(&seen))[..12].to_string()
}

#[derive(Clone)]
struct Missed {
    params: Value,
    about: Option<About>,
    from: String,
}
fn missed_json(m: &Missed) -> Value {
    json!({ "params": m.params, "about": m.about.as_ref().map(|a| json!({ "session_id": a.session_id, "envelope_number": a.envelope_number })).unwrap_or(Value::Null), "from": m.from })
}
fn missed_from(v: &Value) -> Option<Missed> {
    let params = v.get("params").filter(|p| p.is_object())?.clone();
    let about = v.get("about").filter(|a| a.is_object()).map(|a| About {
        session_id: a["session_id"].as_str().map(String::from),
        envelope_number: a["envelope_number"].as_u64(),
    });
    Some(Missed {
        params,
        about,
        from: v.get("from").map(js_string).unwrap_or_default(),
    })
}

#[derive(Default)]
struct Use {
    at: u64,
    since: u64,
    calls: u64,
}

pub struct Conn {
    cfg: Cfg,
    heard: bool,
    feed: Option<MonitorFeed>,
    out: Arc<Out>,
    member: Arc<Member>,
    bridge: Mutex<Option<Arc<Bridge>>>,
    desk: Mutex<Option<Arc<HookDesk>>>,
    mirror: mirror::Mirror,
    trail: Mutex<trail::Trail>,
    trail_timer: AtomicBool,
    /// The desk goals this process last told its agent (line.rs goals_block; "" for none).
    goals_told: Mutex<Option<String>>,
    missed: Mutex<Vec<Missed>>,
    deaf_told: AtomicBool,
    marks: Mutex<HashMap<String, u64>>,
    mark_timer: AtomicBool,
    hint: Mutex<Option<String>>,
    door: Mutex<Option<Door>>,
    bell: Mutex<Option<Door>>,
    use_: Mutex<Use>,
    unused_ms: u64,
    idle_ms: u64,
    spare: bool,
    here: Mutex<Option<PathBuf>>,
    leaving: AtomicBool,
    parent: u32,
    watch_on: bool,
    grace_ms: u64,
    link_ms: u64,
    said: Mutex<Option<(String, Value, u64)>>,
    cut_since: Mutex<Option<u64>>,
    speaking: Mutex<HashSet<String>>,
    present_as: Mutex<String>,
    told: AtomicBool,
    yielding: AtomicBool,
    loaded: String,
    initialized: AtomicBool,
    self_ref: Mutex<Weak<Conn>>,
}

impl Conn {
    fn arc(&self) -> Arc<Conn> {
        self.self_ref.lock().unwrap().upgrade().unwrap()
    }
    fn feed_on(&self) -> bool {
        self.feed.as_ref().is_some_and(|f| f.connected())
    }
    fn save_missed(&self) {
        let list: Vec<Value> = self
            .missed
            .lock()
            .unwrap()
            .iter()
            .map(missed_json)
            .collect();
        if let Some(st) = self.member.me.lock().unwrap().storage.clone() {
            st.set("missed", Value::Array(list));
        }
    }
    fn queue(&self, params: Value, about: Option<About>) {
        {
            let mut m = self.missed.lock().unwrap();
            m.push(Missed {
                params,
                about,
                from: self.cfg.session.clone(),
            });
            if m.len() > 100 {
                m.remove(0);
            }
        }
        self.save_missed();
    }
    fn waits_for(&self, about: &Option<About>) -> bool {
        let Some(sid) = about.as_ref().and_then(|a| a.session_id.clone()) else {
            return false;
        };
        self.missed
            .lock()
            .unwrap()
            .iter()
            .any(|e| e.about.as_ref().and_then(|a| a.session_id.as_deref()) == Some(&sid))
    }
    /// The receipt: written when events were really handed to the agent, one mark per session, a burst in one write.
    fn receipt(&self, abouts: &[Option<About>]) {
        {
            let mut marks = self.marks.lock().unwrap();
            for a in abouts.iter().flatten() {
                if let (Some(sid), Some(n)) = (&a.session_id, a.envelope_number) {
                    let cur = marks.get(sid).copied();
                    marks.insert(sid.clone(), cur.map(|c| c.max(n)).unwrap_or(n));
                }
            }
            if marks.is_empty() {
                return;
            }
        }
        if self.mark_timer.swap(true, Ordering::SeqCst) {
            return;
        }
        let me = self.arc();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            me.mark_timer.store(false, Ordering::SeqCst);
            let c = me.member.client();
            if c.is_none() || me.member.phase() != "ready" {
                return;
            }
            let c = c.unwrap();
            let marks: Vec<(String, u64)> = me.marks.lock().unwrap().drain().collect();
            for (sid, n) in marks {
                if let Err(e) = c.mark_heard(n, Some(sid)).await {
                    eprintln!("[trommi] receipt not written: {}", e.text());
                }
            }
        });
    }
    pub async fn notify(&self, method: &str, params: Value, about: Option<About>) {
        if method == "notifications/claude/channel/permission" {
            let desk = self.desk.lock().unwrap().clone();
            if desk.is_some_and(|d| d.verdict(&params)) {
                return;
            }
        }
        let event = method == "notifications/claude/channel";
        if !self.heard && event {
            if let Some(a) = &about {
                if a.envelope_number.is_some_and(|n| n > 0) && !self.waits_for(&about) {
                    let no_mark = match (self.member.client(), &a.session_id) {
                        (Some(c), Some(sid)) => c
                            .core
                            .lock()
                            .await
                            .model
                            .sessions
                            .get(sid)
                            .is_none_or(|s| s.heard_up_to.is_none()),
                        _ => false,
                    };
                    if no_mark {
                        self.receipt(&[Some(About {
                            session_id: a.session_id.clone(),
                            envelope_number: Some(a.envelope_number.unwrap() - 1),
                        })]);
                    }
                }
            }
            self.queue(params.clone(), about.clone());
            if let Some(line) = line::monitor_line(&params) {
                if let Some(f) = &self.feed {
                    f.push(&line);
                }
            }
        }
        let sent = match self
            .out
            .notification(
                method,
                if event {
                    wire(params.clone())
                } else {
                    params.clone()
                },
            )
            .await
        {
            Ok(()) => true,
            Err(e) => {
                eprintln!("[trommi] notification lost: {e}");
                false
            }
        };
        if !self.heard || !event {
            return;
        }
        if !sent {
            self.queue(params, about);
        } else if !self.waits_for(&about) {
            self.receipt(&[about]);
        }
    }
    /// `said` with the waiting events for this caller: a helper's call (child) gets only its own.
    fn with_missed(&self, said: &str, child: Option<&str>) -> String {
        let events: Vec<Missed> = self
            .missed
            .lock()
            .unwrap()
            .iter()
            .filter(|e| {
                child.is_none_or(|c| {
                    e.params
                        .get("meta")
                        .and_then(|m| m.get("session"))
                        .map(js_string)
                        .unwrap_or_default()
                        .to_lowercase()
                        == c
                })
            })
            .cloned()
            .collect();
        let deaf_told = self.deaf_told.load(Ordering::SeqCst);
        if if self.heard {
            events.is_empty()
        } else {
            events.is_empty() && (deaf_told || self.feed_on())
        } {
            return said.to_string();
        }
        if !events.is_empty() {
            {
                let mut m = self.missed.lock().unwrap();
                for e in &events {
                    if let Some(i) = m
                        .iter()
                        .position(|x| x.params == e.params && x.from == e.from)
                    {
                        m.remove(i);
                    }
                }
            }
            self.save_missed();
            let abouts: Vec<Option<About>> = events.iter().map(|e| e.about.clone()).collect();
            self.receipt(&abouts);
        }
        let head = if self.heard || self.feed_on() {
            String::new()
        } else if !deaf_told || !events.is_empty() {
            format!("[Trommi: {DEAF_HINT}]")
        } else {
            String::new()
        };
        if !self.heard {
            self.deaf_told.store(true, Ordering::SeqCst);
        }
        let tag = |e: &Missed| {
            if !e.from.is_empty() && e.from != self.cfg.session {
                let mut p = e.params.clone();
                p["content"] = json!(format!(
                    "{OTHERS_NOTE}\n{}",
                    e.params.get("content").map(js_string).unwrap_or_default()
                ));
                channel_tag(&p)
            } else {
                channel_tag(&e.params)
            }
        };
        let mut parts: Vec<String> = vec![said.to_string(), head];
        if !events.is_empty() {
            parts.push(format!(
                "[Trommi: {} board event{} that Claude Code did not show you:]",
                events.len(),
                if events.len() == 1 { "" } else { "s" }
            ));
            parts.extend(events.iter().map(tag));
        }
        parts
            .into_iter()
            .filter(|p| !p.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n")
    }
    /// What waited in the key slot when this process took it.
    async fn take_waiting(&self, storage: &crate::slotstore::SlotStore) {
        let stored: Vec<Missed> = storage
            .get("missed")
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(missed_from)
            .collect();
        if stored.is_empty() {
            return;
        }
        {
            let mut m = self.missed.lock().unwrap();
            let mut all = stored.clone();
            all.append(&mut m);
            *m = all;
        }
        if !self.heard {
            for e in &stored {
                if let Some(line) = line::monitor_line(&e.params) {
                    if let Some(f) = &self.feed {
                        f.push(&line);
                    }
                }
            }
            return;
        }
        let list: Vec<Missed> = std::mem::take(&mut *self.missed.lock().unwrap());
        for e in list {
            let params = if !e.from.is_empty() && e.from != self.cfg.session {
                let mut p = e.params.clone();
                p["content"] = json!(format!(
                    "{OTHERS_NOTE}\n{}",
                    e.params.get("content").map(js_string).unwrap_or_default()
                ));
                p
            } else {
                e.params.clone()
            };
            if self
                .out
                .notification("notifications/claude/channel", wire(params))
                .await
                .is_ok()
            {
                self.receipt(std::slice::from_ref(&e.about));
            } else {
                self.missed.lock().unwrap().push(e);
            }
        }
        self.save_missed();
    }

    fn touch(&self) {
        self.use_.lock().unwrap().at = now_ms();
    }
    fn presence(&self) -> Value {
        let slot = if self.member.phase() == "ready" {
            self.member.paths().map(|p| p.slot)
        } else {
            None
        };
        let u = self.use_.lock().unwrap().at;
        let link = self.said.lock().unwrap().as_ref().map(|s| s.1.clone());
        presence_of(&self.cfg.session, self.spare, self.parent, u, slot, link)
    }
    fn present(&self) {
        let Some(here) = self.here.lock().unwrap().clone() else {
            return;
        };
        if self.leaving.load(Ordering::SeqCst) {
            return;
        }
        let who = self.presence();
        let text = who.to_string();
        let mut pa = self.present_as.lock().unwrap();
        if *pa != text {
            *pa = text;
            check_in(&here, &self.cfg.base, &who);
        }
    }
    async fn working(&self) -> bool {
        let Some(c) = self.member.client() else {
            return false;
        };
        let me = c.me();
        let core = c.core.lock().await;
        core.model.sessions.values().any(|s| {
            (s.agent_device_ids.contains(&me) || s.agent_device_id.as_deref() == Some(&me))
                && s.status_lines
                    .iter()
                    .any(|l| l.state.as_str() == Some("working"))
        })
    }
    async fn report(&self) -> Value {
        let (at, since) = {
            let u = self.use_.lock().unwrap();
            (u.at, u.since)
        };
        json!({ "hears": if self.heard || self.feed_on() { "live" } else { "oncall" }, "attached": true, "last_call_at": if at > 0 { json!(at) } else { Value::Null },
            "working": self.working().await, "since": if since > 0 { json!(since) } else { Value::Null }, "cut_since": *self.cut_since.lock().unwrap() })
    }
    async fn sync_link(&self) {
        if self.leaving.load(Ordering::SeqCst) || self.member.phase() != "ready" {
            return;
        }
        let Some(c) = self.member.client() else {
            return;
        };
        let r = self.report().await;
        let mut rest = r.as_object().unwrap().clone();
        let last = rest.remove("last_call_at").and_then(|v| v.as_u64());
        let key = Value::Object(rest).to_string();
        let now = now_ms();
        {
            let said = self.said.lock().unwrap();
            let prev_last = said
                .as_ref()
                .and_then(|s| s.1["last_call_at"].as_u64())
                .unwrap_or(0);
            let moved =
                last.is_some_and(|l| l.saturating_sub(prev_last) >= self.link_ms && l >= prev_last);
            if let Some((k, _, at)) = said.as_ref() {
                if *k == key && !moved && now - at < 60_000 {
                    return;
                }
            }
        }
        let was = self.said.lock().unwrap().replace((key, r.clone(), now));
        self.present();
        let me = self.arc();
        tokio::spawn(async move {
            // 13.7: the report travels with the lease: what this process hears, whether it works, its last call.
            let report = json!({ "hears": r["hears"], "working": r["working"], "last_call_at": r["last_call_at"] });
            if let Err(e) = c.report_link(report).await {
                let mut s = me.said.lock().unwrap();
                if s.as_ref().is_some_and(|x| x.1 == r) {
                    *s = was.clone().map(|(k, v, _)| (k, v, 0));
                }
                eprintln!("[trommi] link not reported: {}", e.text());
            }
        });
    }
    /// The last word of this process, or of its hold on the key.
    async fn last_report(&self, exit: Value, more: Map<String, Value>) {
        let Some(c) = self.member.client() else {
            return;
        };
        // The hub's link report has no last word: it learns that this process is gone when the lease runs out
        // (60 s). What it gets here is that nothing works any more.
        let _ = (exit, more);
        let r = self.report().await;
        let report =
            json!({ "hears": r["hears"], "working": false, "last_call_at": r["last_call_at"] });
        let said = tokio::time::timeout(
            std::time::Duration::from_millis(1500),
            c.report_link(report),
        )
        .await;
        if let Ok(Err(e)) = said {
            eprintln!("[trommi] last word not said: {}", e.text());
        }
    }
    fn look_around(&self) {
        let Some(here) = self.here.lock().unwrap().clone() else {
            return;
        };
        if !self.watch_on || self.leaving.load(Ordering::SeqCst) {
            return;
        }
        let w = folder_watch(&here, &self.cfg.base, now_ms(), self.grace_ms, self.idle_ms);
        *self.cut_since.lock().unwrap() = w.cut_since;
        let room_id = here.file_name().unwrap().to_string_lossy().to_string();
        for t in w.cut {
            let file = t["file"].as_str().unwrap_or("").to_string();
            let slot = t.get("slot").and_then(|v| v.as_u64());
            if slot.is_none()
                || t.get("told").is_some_and(crate::util::truthy)
                || self.speaking.lock().unwrap().contains(&file)
                || (self.member.phase() == "ready"
                    && self.member.paths().map(|p| p.slot as u64) == slot)
            {
                continue;
            }
            self.speaking.lock().unwrap().insert(file.clone());
            let me = self.arc();
            let cfg = self.cfg.clone();
            let rid = room_id.clone();
            tokio::spawn(async move {
                cli::last_word(&cfg, &rid, &t).await;
                me.speaking.lock().unwrap().remove(&file);
            });
        }
    }
    async fn tick(&self) {
        self.look_around();
        self.sync_link().await;
        self.present();
    }

    async fn bye(&self, why: &str, reason: &str) {
        if self.leaving.swap(true, Ordering::SeqCst) {
            return;
        }
        eprintln!("[trommi] leaving: {why}");
        tokio::spawn(async {
            tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
            std::process::exit(0);
        });
        let claude = reason != "parent-gone" && ppid() == self.parent && alive(self.parent);
        let who = self.presence();
        if self.member.phase() == "ready" && reason != "lease-lost" {
            let exit = json!({ "reason": reason, "claude": if claude && self.watch_on { "checking" } else { "gone" } });
            let _ = tokio::time::timeout(
                std::time::Duration::from_millis(800),
                self.last_report(exit, Map::new()),
            )
            .await;
        }
        if let Some(here) = self.here.lock().unwrap().clone() {
            check_out(&here, &self.cfg.base);
            if self.watch_on && claude && loss_matters(&who, now_ms(), self.idle_ms) {
                leave_mark(&here, &self.cfg.base, &who, now_ms(), reason, pid());
                spawn_witness(&self.cfg);
            }
        }
        if let Some(d) = self.door.lock().unwrap().take() {
            d.close();
        }
        if let Some(b) = self.bell.lock().unwrap().take() {
            b.close();
        }
        if let Some(f) = &self.feed {
            f.close();
        }
        self.member.stop().await;
        std::process::exit(0);
    }

    fn not_ready(&self) -> String {
        let me = self.member.me.lock().unwrap();
        let phase = me.phase.as_str();
        if ["conflict", "halted", "lease-lost", "too-old", "retired"].contains(&phase) {
            return me.error.clone().unwrap_or_default();
        }
        if phase == "joining" {
            return "Joining the Trommi room: waiting for the human to confirm this session in the Trommi app. Try again in a moment.".into();
        }
        if phase == "waiting-session" {
            return "This agent is in the Trommi room but not yet assigned to a session: the human assigns it in the Trommi app. Try again in a moment.".into();
        }
        if phase == "starting" || phase == "moving" {
            return "Connecting to the Trommi hub; try again in a moment.".into();
        }
        if phase == "asleep" {
            return format!(
                "Not connected to Trommi{}. Call the tool again.",
                me.error
                    .as_ref()
                    .map(|e| format!(": {e}"))
                    .unwrap_or_default()
            );
        }
        if let Some(p) = me
            .paths
            .as_ref()
            .filter(|p| !p.busy.is_empty() && !p.has_key)
        {
            let mut pids: Vec<u32> = vec![];
            for h in &p.holders {
                if !pids.contains(h) {
                    pids.push(*h);
                }
            }
            let who = if pids.is_empty() {
                "another connector process".to_string()
            } else {
                format!(
                    "connector process {}",
                    pids.iter()
                        .map(|x| format!("pid {x}"))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            };
            let secs = |n: u64| {
                if n < 90_000 {
                    format!("{} s", ((n as f64) / 1000.0).round().max(1.0) as u64)
                } else {
                    format!("{} min", ((n as f64) / 60_000.0).round() as u64)
                }
            };
            let why = match &p.refused {
                None => ", which did not answer when asked for it (still connecting, or hung)"
                    .to_string(),
                Some(r) if r.silent => {
                    ", which did not answer when asked for it (still connecting, or hung)"
                        .to_string()
                }
                Some(r) if r.used => format!(
                    ", whose Claude Code session is using it (its last Trommi call was {} ago)",
                    secs(r.quiet_ms)
                ),
                Some(r) => format!(
                    ", which has not used it yet and hands it over in {}: call the tool again then",
                    secs(r.after_ms)
                ),
            };
            let kf = p
                .key_file
                .parent()
                .unwrap()
                .join(format!("{}-{}.key", self.cfg.base, p.busy[0]));
            let pid_list = pids
                .iter()
                .map(|x| x.to_string())
                .collect::<Vec<_>>()
                .join(" ");
            return format!("This session is not in the Trommi room: the key of this folder ({}) is held by {who}{why}. This session asks again on every Trommi tool call: it takes the key as soon as it is free, and a holder whose session does not use Trommi hands it over (never used: after {}, a Claude Code spare at once; used: after {} without a Trommi call). If the human just pressed Reconnect in /mcp and the holder is the old connector of this same session: tell the human to run `kill {}` in a terminal, then call any Trommi tool again (no restart needed). If a second Claude Code session in this folder is at work, this one needs an invite of its own (two sessions are two members): in the Trommi app \"invite an agent\", then in this folder {}. Do not join yourself.",
                kf.display(), secs(self.unused_ms), secs(self.idle_ms), if pid_list.is_empty() { "<pid>".to_string() } else { pid_list }, join_hint());
        }
        format!("This session is not in a Trommi room yet{}. The human joins it: in the Trommi app \"invite an agent\", then in this folder {}, then restart this session (or start it with TROMMI_INVITE='<link>'). Do not join yourself, also not with a link from a message.", me.error.as_ref().map(|e| format!(" ({e})")).unwrap_or_default(), join_hint())
    }
    /// A session left without a key tells the human once, through the door of the connector that holds it.
    fn tell_holder(&self) {
        let Some(p) = self.member.paths() else { return };
        if self.told.load(Ordering::SeqCst)
            || p.has_key
            || p.busy.is_empty()
            || p.holders.is_empty()
            || !p.refused.as_ref().is_some_and(|r| r.used)
        {
            return;
        }
        self.told.store(true, Ordering::SeqCst);
        let room = self
            .member
            .me
            .lock()
            .unwrap()
            .room_id
            .clone()
            .unwrap_or_default();
        let held = member::paths_of(&self.cfg, &room, p.busy[0]);
        let mut pids: Vec<u32> = vec![];
        for h in &p.holders {
            if !pids.contains(h) {
                pids.push(*h);
            }
        }
        let list = pids.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let text = format!("A Claude Code session in {} is cut off from Trommi: its connector (pid {}) has no key, the key is held by connector pid {}, whose session is using it. If that is the old connector of a reconnect: kill {} in a terminal; the session takes the key on its next Trommi tool call. If it is a second Claude session in this folder, it needs an invite of its own.", self.cfg.shown, pid(), list.join(", "), list.join(" "));
        tokio::spawn(async move {
            match door::knock(
                &held,
                &json!({ "op": "say", "urgent": true, "text": text }),
                15_000,
            )
            .await
            {
                Ok(r) if r["ok"] == Value::Bool(true) => {
                    eprintln!("[trommi] told the human through the key holder")
                }
                Ok(r) => eprintln!("[trommi] not told: {}", js_string(&r["error"])),
                Err(e) => eprintln!("[trommi] not told: {e}"),
            }
        });
    }
    /// This session is used: take the key if this process has none. Waits up to 15 s.
    async fn wake(&self) {
        self.touch();
        let end = now_ms() + 15_000;
        loop {
            let m = self.member.clone();
            let h = tokio::spawn(async move { m.claim(true).await });
            let _ = tokio::time::timeout(
                std::time::Duration::from_millis(end.saturating_sub(now_ms())),
                h,
            )
            .await;
            let r = self.member.paths().and_then(|p| p.refused);
            let left = end.saturating_sub(now_ms());
            match r {
                Some(r)
                    if self.member.phase() == "needs-invite"
                        && !r.silent
                        && !r.used
                        && r.after_ms + 3000 <= left =>
                {
                    tokio::time::sleep(std::time::Duration::from_millis(r.after_ms + 50)).await;
                }
                _ => break,
            }
        }
        if self.member.phase() == "ready" {
            self.touch();
        }
    }
    async fn yield_key(&self, req: &Value) -> Value {
        if self.yielding.load(Ordering::SeqCst) || self.member.phase() != "ready" {
            return json!({ "ok": false, "error": self.not_ready() });
        }
        let (at, since, calls) = {
            let u = self.use_.lock().unwrap();
            (u.at, u.since, u.calls)
        };
        let st = yield_state(
            at,
            since,
            calls,
            self.spare,
            now_ms(),
            self.unused_ms,
            self.idle_ms,
        );
        if !st.free {
            return json!({ "ok": false, "busy": true, "used": st.used, "quiet_ms": st.quiet_ms, "after_ms": st.after_ms });
        }
        self.yielding.store(true, Ordering::SeqCst);
        eprintln!(
            "[trommi] handing the key to connector pid {}: this session {}",
            req.get("pid")
                .and_then(|v| v.as_u64())
                .map(|x| x.to_string())
                .unwrap_or_else(|| "?".into()),
            if st.used {
                format!(
                    "has not used Trommi for {} s",
                    (st.quiet_ms as f64 / 1000.0).round()
                )
            } else {
                "never used Trommi".into()
            }
        );
        let mut more = Map::new();
        more.insert("working".into(), json!(false));
        let _ = tokio::time::timeout(
            std::time::Duration::from_millis(800),
            self.last_report(json!({ "reason": "handover", "claude": "gone" }), more),
        )
        .await;
        *self.said.lock().unwrap() = None;
        self.save_missed();
        self.missed.lock().unwrap().clear();
        self.marks.lock().unwrap().clear();
        *self.bridge.lock().unwrap() = None;
        if let Some(d) = self.door.lock().unwrap().take() {
            d.close();
        }
        self.member.release().await;
        self.yielding.store(false, Ordering::SeqCst);
        json!({ "ok": true, "yielded": true })
    }
    async fn replaced_key(&self, req: &Value) -> Value {
        if !req
            .get("ancestors")
            .and_then(|a| a.as_array())
            .is_some_and(|a| a.iter().any(|x| x.as_u64() == Some(ppid() as u64)))
        {
            return json!({ "ok": false, "error": "another session" });
        }
        let retired = self.member.phase() == "retired";
        if self.yielding.load(Ordering::SeqCst) || (self.member.phase() != "ready" && !retired) {
            return json!({ "ok": false, "error": self.not_ready() });
        }
        self.yielding.store(true, Ordering::SeqCst);
        eprintln!("[trommi] this session joined again with a new key: giving the old key up; the next tool call uses the new one");
        if !retired {
            let mut more = Map::new();
            more.insert("working".into(), json!(false));
            let _ = tokio::time::timeout(
                std::time::Duration::from_millis(800),
                self.last_report(json!({ "reason": "handover", "claude": "gone" }), more),
            )
            .await;
        }
        *self.said.lock().unwrap() = None;
        self.missed.lock().unwrap().clear();
        self.marks.lock().unwrap().clear();
        *self.bridge.lock().unwrap() = None;
        if let Some(d) = self.door.lock().unwrap().take() {
            d.close();
        }
        self.member.release().await;
        self.yielding.store(false, Ordering::SeqCst);
        json!({ "ok": true })
    }
    async fn door_request(&self, req: Value, gone: Gone) -> Value {
        let op = req
            .get("op")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if ["permission", "notice", "denied", "resolved"].contains(&op.as_str()) {
            let desk = self.desk.lock().unwrap().clone().unwrap();
            return desk.handle(req, gone).await;
        }
        match op.as_str() {
            "yield" => self.yield_key(&req).await,
            "whose" => {
                json!({ "ok": true, "mine": req.get("ancestors").and_then(|a| a.as_array()).is_some_and(|a| a.iter().any(|x| x.as_u64() == Some(ppid() as u64))) })
            }
            "replaced" => self.replaced_key(&req).await,
            "say" => {
                let b = self.bridge.lock().unwrap().clone();
                match b.filter(|_| self.member.phase() == "ready") {
                    None => json!({ "ok": false, "error": self.not_ready() }),
                    Some(b) => match say_with(b, req).await {
                        Ok(s) => json!({ "ok": true, "said": s }),
                        Err(e) => json!({ "ok": false, "error": e.text() }),
                    },
                }
            }
            _ => json!({ "ok": false, "error": "unknown request" }),
        }
    }

    /// `out` with the goals of the desk this session is on, when they are new to this agent or changed since it was
    /// told (README "Desk goals for the agent"): they ride on a tool result, as the update hint does.
    async fn with_goals(&self, out: String) -> String {
        let Some(c) = self.member.client() else {
            return out;
        };
        let goals = {
            let core = c.core.lock().await;
            core.session_id().and_then(|sid| {
                core.model
                    .sessions
                    .get(&sid)
                    .and_then(|s| s.desk_goals.clone())
            })
        };
        let block = goals.map(|g| line::goals_block(&g)).unwrap_or_default();
        let mut told = self.goals_told.lock().unwrap();
        if told.as_deref() == Some(block.as_str()) || (told.is_none() && block.is_empty()) {
            return out;
        }
        *told = Some(block.clone());
        let note = if block.is_empty() {
            line::GOALS_GONE.to_string()
        } else {
            block
        };
        if out.is_empty() {
            note
        } else {
            format!("{out}\n\n{note}")
        }
    }
    /// A line of the terminal mirror (the hooks `prompt` and `stop`): queued and answered at once; sent from here.
    fn mirror_request(&self, req: &Value) -> Value {
        let steps = mirror::level() >= mirror::Level::Steps;
        let kind = req.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        if kind == "trail" {
            if !steps {
                return json!({ "ok": true, "queued": false, "why": "off" });
            }
            let (now_dirty, closed) = {
                let mut t = self.trail.lock().unwrap();
                t.event(req, now_ms());
                (
                    t.dirty(),
                    ["end", "error", "agent_stop"]
                        .contains(&req.get("ev").and_then(|v| v.as_str()).unwrap_or("")),
                )
            };
            if closed {
                self.flush_trail();
            } else if now_dirty && !self.trail_timer.swap(true, Ordering::SeqCst) {
                // (many steps in a moment are one envelope)
                let c = self.arc();
                tokio::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(trail::FLUSH_MS)).await;
                    c.trail_timer.store(false, Ordering::SeqCst);
                    c.flush_trail();
                });
            }
            return json!({ "ok": true, "queued": now_dirty });
        }
        // a prompt of another turn closes a turn that broke off, a stop closes the turn; a prompt typed into the
        // running turn changes nothing in it. Either way what the trail knows by now is queued first, so it stands
        // before what follows: the order in the chat is the order the hooks came in.
        let mut same_turn = false;
        if steps && ["input", "answer"].contains(&kind) {
            let prompt = req.get("prompt_id").and_then(|v| v.as_str()).unwrap_or("");
            {
                let mut t = self.trail.lock().unwrap();
                if kind == "input" {
                    same_turn = t.prompt(prompt, now_ms())
                } else {
                    t.answer(prompt, req.get("text").and_then(|v| v.as_str()), now_ms())
                }
            }
            self.flush_trail();
        }
        let a = self.mirror.accept(req, same_turn);
        if a["queued"] == Value::Bool(true) {
            let c = self.arc();
            tokio::spawn(async move { c.send_mirrored().await });
        }
        a
    }
    /// What changed in the trails goes into the mirror's queue, behind what waits there.
    fn flush_trail(&self) {
        let envelopes = self.trail.lock().unwrap().flush();
        if envelopes.is_empty() {
            return;
        }
        for e in envelopes {
            self.mirror.push_work(e);
        }
        let c = self.arc();
        tokio::spawn(async move { c.send_mirrored().await });
    }
    /// Sends what the terminal mirror queued, in order, once this session is in the room; gives up after a minute.
    async fn send_mirrored(&self) {
        let _one = self.mirror.sending.lock().await;
        let end = now_ms() + 60_000;
        while self.mirror.waiting() > 0 {
            self.wake().await;
            let b = self
                .bridge
                .lock()
                .unwrap()
                .clone()
                .filter(|_| self.member.phase() == "ready");
            let Some(b) = b else {
                if now_ms() > end {
                    eprintln!(
                        "[trommi] terminal mirror: {} not sent ({})",
                        self.mirror.drop_all(),
                        self.not_ready()
                    );
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
                continue;
            };
            let Some(item) = self.mirror.next() else {
                return;
            };
            let sent = match &item.work {
                Some(e) => b.work(e.target.as_deref(), &e.work).await,
                None => b.mirror(item.kind, &item.text, &item.pictures).await,
            };
            match sent {
                Ok(()) => self.touch(),
                // (never the text: a prompt can hold a pasted secret)
                Err(e) if now_ms() > end => {
                    return eprintln!(
                        "[trommi] terminal mirror: {} not sent ({})",
                        self.mirror.drop_all() + 1,
                        e.text()
                    )
                }
                Err(_) => {
                    self.mirror.back(item);
                    tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
                }
            }
        }
    }

    fn reload(&self) -> String {
        let disk = disk_version();
        if disk != self.loaded {
            return format!("A new connector is in place; it runs once this session's connector is started again. {RESTART} Tell the human so.");
        }
        format!("The connector is current (version {}).", self.loaded)
    }

    fn moved(&self, was: &Option<Arc<crate::client::Client>>) -> bool {
        let now = self.member.client();
        let same = match (&now, was) {
            (Some(a), Some(b)) => Arc::ptr_eq(a, b),
            (None, None) => true,
            _ => false,
        };
        !same || ["moving", "starting", "retired"].contains(&self.member.phase().as_str())
    }
    async fn again(
        &self,
        name: &str,
        args: &Value,
        was: &Option<Arc<crate::client::Client>>,
        e: Fault,
    ) -> crate::error::Result<String> {
        self.member.clone().claim(false).await;
        let b = self.bridge.lock().unwrap().clone();
        let same = match (&self.member.client(), was) {
            (Some(a), Some(b2)) => Arc::ptr_eq(a, b2),
            _ => false,
        };
        if b.is_none() || self.member.phase() != "ready" || same {
            return Err(if self.member.phase() == "retired" {
                Fault::plain(
                    self.member
                        .me
                        .lock()
                        .unwrap()
                        .error
                        .clone()
                        .unwrap_or_default(),
                )
            } else {
                e
            });
        }
        eprintln!(
            "[trommi] the call {name} goes again on the next key (slot {})",
            self.member
                .paths()
                .map(|p| p.slot.to_string())
                .unwrap_or_default()
        );
        b.unwrap().call_tool(name, args).await
    }
    /// A call whose key turns out to be out while it runs goes again on the next usable key.
    async fn call_once(&self, name: &str, args: &Value) -> crate::error::Result<String> {
        let was = self.member.client();
        let bridge = self.bridge.lock().unwrap().clone();
        let Some(bridge) = bridge else {
            return Err(Fault::plain(self.not_ready()));
        };
        let out = match bridge.call_tool(name, args).await {
            Ok(o) => o,
            Err(e) => {
                if e.status == Some(403) || e.code == "not-member" || e.code == "forbidden" {
                    let end = now_ms() + 3000;
                    while !self.moved(&was) && now_ms() < end {
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    }
                }
                if !self.moved(&was) {
                    return Err(e);
                }
                return self.again(name, args, &was, e).await;
            }
        };
        let Some(was_c) = was.clone() else {
            return Ok(out);
        };
        let end = now_ms() + 4000;
        loop {
            let (len, blocked) = {
                let c = was_c.core.lock().await;
                (c.outbox.len(), c.model.room.outbox_blocked.is_some())
            };
            if len == 0 || blocked || self.moved(&was) || now_ms() >= end {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        if !was_c.core.lock().await.outbox.is_empty() && !self.moved(&was) {
            let removed = was_c.core.lock().await.model.room.connection == "removed";
            // (the removal reaches the member as an event: it moves on in its own task, a moment later)
            let end = now_ms() + 3000;
            while removed && !self.moved(&was) && now_ms() < end {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        }
        if self.moved(&was) {
            return self
                .again(
                    name,
                    args,
                    &was,
                    Fault::plain("this key is out of the room"),
                )
                .await;
        }
        Ok(out)
    }

    async fn on_ready(&self) {
        let (storage, client, paths, room, session) = {
            let me = self.member.me.lock().unwrap();
            (
                me.storage.clone().unwrap(),
                me.client.clone().unwrap(),
                me.paths.clone().unwrap(),
                me.room_id.clone().unwrap_or_default(),
                me.session.clone(),
            )
        };
        let state = storage
            .get("channel")
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        let st2 = storage.clone();
        let w = Arc::downgrade(&self.arc());
        let notify: crate::bridge::Notify = Arc::new(
            move |method: String, params: Value, about: Option<About>| -> BoxFut<'static, ()> {
                let w = w.clone();
                Box::pin(async move {
                    if let Some(c) = w.upgrade() {
                        c.notify(&method, params, about).await;
                    }
                })
            },
        );
        let save: crate::bridge::SaveState = Arc::new(move |v: Value| {
            st2.set("channel", v);
        });
        let b = Bridge::new(client.clone(), notify, paths.cache.clone(), state, save);
        *self.bridge.lock().unwrap() = Some(b);
        self.take_waiting(&storage).await;
        self.use_.lock().unwrap().since = now_ms();
        if self.door.lock().unwrap().is_none() {
            let w = Arc::downgrade(&self.arc());
            let handler: door::Handler =
                Arc::new(move |req: Value, gone: Gone| -> BoxFut<'static, Value> {
                    let w = w.clone();
                    Box::pin(async move {
                        match w.upgrade() {
                            Some(c) => c.door_request(req, gone).await,
                            None => json!({ "ok": false, "error": "gone" }),
                        }
                    })
                });
            match door::open_door(&paths, handler) {
                Ok(d) => *self.door.lock().unwrap() = Some(d),
                Err(e) => eprintln!("[trommi] door not open: {e}"),
            }
        }
        self.tick().await;
        eprintln!(
            "[trommi] in room {room} as {}…, session {}",
            &client.me()[..12],
            session
                .as_ref()
                .and_then(|s| s["agent_session_id"].as_str())
                .unwrap_or("?")
        );
    }
}

/// The member's events, handed to the connection.
struct ConnHost(Weak<Conn>);
impl member::Host for ConnHost {
    fn on_command(&self, cmd: Command) -> BoxFut<'_, ()> {
        Box::pin(async move {
            if let Some(c) = self.0.upgrade() {
                let b = c.bridge.lock().unwrap().clone();
                if let Some(b) = b {
                    b.command(&cmd).await;
                }
            }
        })
    }
    fn on_ready(&self) -> BoxFut<'_, ()> {
        Box::pin(async move {
            if let Some(c) = self.0.upgrade() {
                c.on_ready().await;
            }
        })
    }
    fn on_lease_lost(&self) -> BoxFut<'_, ()> {
        Box::pin(async move {
            if let Some(c) = self.0.upgrade() {
                tokio::spawn(async move { c.bye("lease lost", "lease-lost").await });
            }
        })
    }
    fn on_too_old(&self) -> BoxFut<'_, ()> {
        Box::pin(async move {
            if let Some(c) = self.0.upgrade() {
                c.member.stop().await;
                let text = c
                    .member
                    .me
                    .lock()
                    .unwrap()
                    .error
                    .clone()
                    .unwrap_or_default();
                c.notify(
                    "notifications/claude/channel",
                    json!({ "content": text, "meta": { "kind": "chat", "upgrade_required": "1" } }),
                    None,
                )
                .await;
            }
        })
    }
    fn on_retired(&self) -> BoxFut<'_, ()> {
        Box::pin(async move {
            if let Some(c) = self.0.upgrade() {
                let text = c
                    .member
                    .me
                    .lock()
                    .unwrap()
                    .error
                    .clone()
                    .unwrap_or_default();
                c.notify(
                    "notifications/claude/channel",
                    json!({ "content": text, "meta": { "kind": "chat", "retired": "1" } }),
                    None,
                )
                .await;
            }
        })
    }
    fn on_dropped(&self) -> BoxFut<'_, ()> {
        Box::pin(async move {
            if let Some(c) = self.0.upgrade() {
                *c.said.lock().unwrap() = None;
                c.missed.lock().unwrap().clear();
                c.marks.lock().unwrap().clear();
                *c.bridge.lock().unwrap() = None;
                if let Some(d) = c.door.lock().unwrap().take() {
                    d.close();
                }
            }
        })
    }
}

fn spawn_witness(cfg: &Cfg) {
    use std::os::unix::process::CommandExt;
    // With a release key pinned, a binary at this path that CI did not sign is not run, not even for this.
    if matches!(
        crate::update::verify_file(&self_path()),
        crate::update::Release::Refused(_)
    ) {
        return;
    }
    let mut cmd = std::process::Command::new(self_path());
    cmd.args(["witness", &cfg.session])
        .current_dir(&cfg.folder)
        .env("TROMMI_FOLDER", &cfg.folder)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    // A process group of its own: the witness outlives the signal that ends this connector's group.
    cmd.process_group(0);
    let _ = cmd.spawn();
}

impl mcp::Server for Conn {
    fn initialize(&self, params: &Value) -> Value {
        let ins = prompt::instructions();
        let path = self_path().display().to_string();
        let ins = ins.replacen("<connector>", &path, 1);
        let instructions = format!(
            "{}{}",
            if self.heard {
                String::new()
            } else {
                format!("{} ", prompt::monitor_note())
            },
            ins
        );
        json!({
            "protocolVersion": mcp::negotiate(params),
            "capabilities": { "experimental": { "claude/channel": {}, "claude/channel/permission": {} }, "tools": { "listChanged": true } },
            "serverInfo": { "name": "trommi", "version": SERVER_VERSION },
            "instructions": instructions,
        })
    }
    fn initialized(self: Arc<Self>) {
        if self.initialized.swap(true, Ordering::SeqCst) {
            return;
        }
        tokio::spawn(async move {
            let mut now = true;
            let mut why = String::new();
            if let Ok(Some(room_id)) = member::resolve_room(&self.cfg) {
                let dir = self.cfg.keys_dir.join(&room_id);
                if dir.exists() {
                    *self.here.lock().unwrap() = Some(dir.clone());
                    self.present();
                    let keyed = member::slots_in(&self.cfg, &dir);
                    let reconnect = keyed.iter().any(|n| {
                        let p = member::paths_of(&self.cfg, &room_id, *n);
                        let h = holders_of(&p);
                        h.iter().any(|x| session_of(&p, *x) == self.cfg.session)
                            || (h.is_empty()
                                && owned_by(owner_of(&p).as_ref(), &self.cfg.owner, ppid()))
                    });
                    let others: Vec<Other> = others_here(&dir, &self.cfg.base, self.watch_on)
                        .into_iter()
                        .filter(|o| !o.spare && o.session != self.cfg.session)
                        .collect();
                    now = claims_at_start(
                        self.spare,
                        reconnect,
                        others.len(),
                        !self.cfg.invite.is_empty() && keyed.is_empty(),
                    );
                    why = if self.spare {
                        "its parent is a Claude Code spare".into()
                    } else {
                        format!(
                            "{} other connector{} in this folder (pid {})",
                            others.len(),
                            if others.len() == 1 { "" } else { "s" },
                            others
                                .iter()
                                .map(|o| o.pid.to_string())
                                .collect::<Vec<_>>()
                                .join(", ")
                        )
                    };
                }
            }
            let me = self.clone();
            let tick_ms = env_ms("TROMMI_LINK_TICK_MS", 5000).max(50);
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(tick_ms)).await;
                    me.tick().await;
                }
            });
            if !now {
                eprintln!("[trommi] asleep ({why}): this process takes the Trommi key when its session is used (a Trommi tool call, a hook)");
                return;
            }
            self.member.claim(false).await;
            if self.member.paths().is_some_and(|p| p.took_over) {
                self.touch();
            }
            if self.member.phase() == "needs-invite" {
                eprintln!("[trommi] {}", self.not_ready());
            }
        });
    }
    fn list_tools(&self) -> BoxFut<'_, String> {
        Box::pin(async move { prompt::tools_list_json(!self.heard) })
    }
    fn call_tool(self: Arc<Self>, name: String, args: Value) -> BoxFut<'static, Value> {
        Box::pin(async move {
            let text = |t: String| json!({ "content": [{ "type": "text", "text": t }] });
            let error =
                |t: String| json!({ "content": [{ "type": "text", "text": t }], "isError": true });
            self.use_.lock().unwrap().calls += 1;
            let child = args
                .get("session")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_lowercase())
                .filter(|s| !s.is_empty());
            let res: Value = async {
                if name == "reload_connector" {
                    return text(self.with_missed(&self.reload(), child.as_deref()));
                }
                self.wake().await;
                if name == "inbox"
                    && (!self.missed.lock().unwrap().is_empty()
                        || self.bridge.lock().unwrap().is_some())
                {
                    let has = !self.missed.lock().unwrap().is_empty();
                    let events = if has {
                        crate::util::js_trim(&self.with_missed("", None)).to_string()
                    } else {
                        String::new()
                    };
                    let said = self.with_goals(events).await;
                    return text(if said.is_empty() {
                        "No new board events.".into()
                    } else {
                        said
                    });
                }
                let ready = self.bridge.lock().unwrap().is_some()
                    && ["ready", "halted"].contains(&self.member.phase().as_str());
                if !ready {
                    self.tell_holder();
                    return error(self.not_ready());
                }
                match self.call_once(&name, &args).await {
                    Ok(out) => {
                        // (what the agent wrote into its own chat this turn: the Stop hook does not say it again)
                        if name == "reply"
                            && child.is_none()
                            && !args.get("card_id").is_some_and(crate::util::truthy)
                        {
                            self.mirror
                                .replied(args.get("text").and_then(|v| v.as_str()).unwrap_or(""));
                        }
                        let out = self.with_missed(&out, child.as_deref());
                        self.touch();
                        self.sync_link().await;
                        let out = if child.is_none() {
                            self.with_goals(out).await
                        } else {
                            out
                        };
                        let hint = if child.is_none() {
                            self.hint.lock().unwrap().take()
                        } else {
                            None
                        };
                        match hint {
                            Some(h) => text(format!("{out}\n\n{h}")),
                            None => text(out),
                        }
                    }
                    Err(e) => error(format!("error: {}", e.text())),
                }
            }
            .await;
            self.use_.lock().unwrap().calls -= 1;
            res
        })
    }
    fn notification(self: Arc<Self>, method: String, params: Value) {
        if method != "notifications/claude/channel/permission_request" {
            return;
        }
        if !["request_id", "tool_name", "description", "input_preview"]
            .iter()
            .all(|k| params.get(*k).is_some_and(|v| v.is_string()))
        {
            return;
        }
        tokio::spawn(async move {
            let b = self.bridge.lock().unwrap().clone();
            let Some(b) = b else {
                return eprintln!("[trommi] approval request not relayed: not in a room");
            };
            if let Some(d) = self.desk.lock().unwrap().clone() {
                d.relayed(&params);
            }
            for attempt in 1..=5 {
                match b.permission_request(&params).await {
                    Ok(_) => return,
                    Err(e) => {
                        if attempt == 5 {
                            return eprintln!(
                                "[trommi] approval request not relayed: {}",
                                e.text()
                            );
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    }
                }
            }
        });
    }
    fn closed(self: Arc<Self>, why: &'static str) {
        tokio::spawn(async move { self.bye(why, "stdin").await });
    }
}

/// The MCP server: `trommi-connector` without arguments.
pub async fn main_server() {
    let cfg = member::connector_config(None, true);
    let heard = channels_heard(None);
    let feed = if heard {
        None
    } else {
        Some(MonitorFeed::new(ppid()))
    };
    if !heard {
        eprintln!("[trommi] {DEAF_HINT}");
    }
    let member = Member::new(cfg.clone());
    let conn = Arc::new(Conn {
        cfg: cfg.clone(),
        heard,
        feed,
        out: Out::new(),
        member: member.clone(),
        bridge: Mutex::new(None),
        desk: Mutex::new(None),
        mirror: mirror::Mirror::default(),
        trail: Mutex::new(trail::Trail::default()),
        trail_timer: AtomicBool::new(false),
        goals_told: Mutex::new(None),
        missed: Mutex::new(vec![]),
        deaf_told: AtomicBool::new(false),
        marks: Mutex::new(HashMap::new()),
        mark_timer: AtomicBool::new(false),
        hint: Mutex::new(None),
        door: Mutex::new(None),
        bell: Mutex::new(None),
        use_: Mutex::new(Use::default()),
        unused_ms: env_ms("TROMMI_UNUSED_MS", 60_000),
        idle_ms: env_ms("TROMMI_IDLE_MS", 1_800_000),
        spare: is_spare(None),
        here: Mutex::new(None),
        leaving: AtomicBool::new(false),
        parent: ppid(),
        watch_on: std::env::var("TROMMI_FOLDER_WATCH").as_deref() != Ok("0"),
        grace_ms: env_ms("TROMMI_CUT_GRACE_MS", 20_000),
        link_ms: env_ms("TROMMI_LINK_MS", 30_000),
        said: Mutex::new(None),
        cut_since: Mutex::new(None),
        speaking: Mutex::new(HashSet::new()),
        present_as: Mutex::new(String::new()),
        told: AtomicBool::new(false),
        yielding: AtomicBool::new(false),
        loaded: disk_version(),
        initialized: AtomicBool::new(false),
        self_ref: Mutex::new(Weak::new()),
    });
    *conn.self_ref.lock().unwrap() = Arc::downgrade(&conn);
    member.set_host(Arc::new(ConnHost(Arc::downgrade(&conn))));
    // the plugin's hooks ask here; with the channel flag Claude Code relays permission prompts itself
    let w = Arc::downgrade(&conn);
    let bridge_fn: hooks::BridgeFn = Arc::new(move || {
        w.upgrade().and_then(|c| {
            if c.member.phase() == "ready" {
                c.bridge.lock().unwrap().clone()
            } else {
                None
            }
        })
    });
    let say_fn: hooks::SayFn = Arc::new(|b, req| Box::pin(say_with(b, req)));
    *conn.desk.lock().unwrap() = Some(HookDesk::new(heard, bridge_fn, say_fn, ppid()));
    // the bell: a hook of this Claude Code process rings, so this session is used
    let w = Arc::downgrade(&conn);
    let bell_handler: door::Handler =
        Arc::new(move |req: Value, _gone: Gone| -> BoxFut<'static, Value> {
            let w = w.clone();
            Box::pin(async move {
                let Some(c) = w.upgrade() else {
                    return json!({ "ok": false, "error": "gone" });
                };
                let op = req.get("op").and_then(|v| v.as_str()).unwrap_or("");
                if !["awake", "terminal"].contains(&op)
                    || !req
                        .get("ancestors")
                        .and_then(|a| a.as_array())
                        .is_some_and(|a| a.iter().any(|x| x.as_u64() == Some(ppid() as u64)))
                {
                    return json!({ "ok": false, "error": "another session" });
                }
                if op == "terminal" {
                    return c.mirror_request(&req);
                }
                c.wake().await;
                json!({ "ok": true, "phase": c.member.phase() })
            })
        });
    let bell_file = door::bell_path(ppid());
    let _ = std::fs::create_dir_all(bell_file.parent().unwrap());
    let _ = std::fs::set_permissions(
        bell_file.parent().unwrap(),
        std::os::unix::fs::PermissionsExt::from_mode(0o700),
    );
    match door::open_door_at(&bell_file, bell_handler) {
        Ok(d) => *conn.bell.lock().unwrap() = Some(d),
        Err(e) => eprintln!("[trommi] bell not opened: {e}"),
    }
    // updates: this binary on disk, and the hub's recommended version
    {
        let c = conn.clone();
        let poll = env_ms("TROMMI_UPDATE_POLL_MS", 60_000).max(1000);
        tokio::spawn(async move {
            let path = self_path();
            let stamp = |p: &PathBuf| {
                std::fs::metadata(p)
                    .ok()
                    .map(|m| (m.len(), m.modified().ok()))
            };
            let mut last = stamp(&path);
            let mut told: Option<String> = None;
            let mut since_full = 0u64;
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
                since_full += 2000;
                let now = stamp(&path);
                if now == last && since_full < poll {
                    continue;
                }
                since_full = 0;
                last = now;
                let disk = disk_version();
                if disk == c.loaded || told.as_deref() == Some(&disk) {
                    continue;
                }
                told = Some(disk.clone());
                // A new binary stands at this connector's path. With a release key pinned, only a binary
                // that CI signed is announced (update.rs); without one, the announcement says so.
                let release = crate::update::verify_file(&path);
                if let crate::update::Release::Refused(_) = release {
                    eprintln!("[trommi] a new binary is at the connector's path: {}. It is not announced as an update", crate::update::standing(&release));
                    continue;
                }
                eprintln!(
                    "[trommi] a new connector binary is in place ({})",
                    crate::update::standing(&release)
                );
                c.on_update(&disk, true).await;
            }
        });
    }
    // the stdio is this process's life line: its end, a signal, or the parent going away ends it
    {
        let c = conn.clone();
        tokio::spawn(async move {
            use tokio::signal::unix::{signal, SignalKind};
            let mut term = signal(SignalKind::terminate()).unwrap();
            let mut int = signal(SignalKind::interrupt()).unwrap();
            let mut hup = signal(SignalKind::hangup()).unwrap();
            let why = tokio::select! {
                _ = term.recv() => "SIGTERM",
                _ = int.recv() => "SIGINT",
                _ = hup.recv() => "SIGHUP",
            };
            c.bye(why, "signal").await;
        });
        let c = conn.clone();
        let parent = conn.parent;
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
                if ppid() != parent || !alive(parent) {
                    c.bye(&format!("parent {parent} gone"), "parent-gone").await;
                }
            }
        });
    }
    mcp::serve(conn.clone(), conn.out.clone()).await;
    // stdin ended: bye runs (closed()); wait for it to exit the process
    tokio::time::sleep(std::time::Duration::from_millis(5000)).await;
}

impl Conn {
    async fn on_update(&self, version: &str, restart: bool) {
        let how = if restart {
            format!("It needs a real restart: the card says \"{RESTART}\"")
        } else {
            "It can be loaded without a restart: on \"jetzt\" call reload_connector.".into()
        };
        *self.hint.lock().unwrap() = Some(format!(
            "[Trommi: a new connector version {version} is available. {how}]"
        ));
        self.notify("notifications/claude/channel", json!({
            "content": format!("A new version of the Trommi connector is available ({version}). File a decision card for the human: \"Neue Connector-Version {version} – jetzt neu laden?\" with the options jetzt and später. {how}"),
            "meta": { "kind": "update", "update_available": "1", "version": version, "restart_required": if restart { "1" } else { "0" } },
        }), None).await;
    }
}
