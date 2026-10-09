//! The plugin's hooks (permission, notice, denied, resolved): the pieces, the hook process's request
//! and output, and the connector's desk that answers them.
use crate::bridge::Bridge;
use crate::client::BoxFut;
use crate::door::Gone;
use crate::util::{js_string, now_ms};
use regex::Regex;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

pub const HOOK_TIMEOUT_S: u64 = 3700;
pub const NOTICE_TYPES: [&str; 2] = ["permission_prompt", "elicitation_dialog"];
const DIALOG_TOOLS: [&str; 2] = ["AskUserQuestion", "ExitPlanMode"];

/// How long a permission hook waits for the human (TROMMI_PERMISSION_MS, default 5 minutes, 1 s to 1 h).
pub fn wait_ms() -> u64 {
    let v = std::env::var("TROMMI_PERMISSION_MS")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| *v != 0.0 && v.is_finite())
        .unwrap_or(300_000.0);
    v.clamp(1000.0, 3_600_000.0) as u64
}

/// The pids above this process, nearest first.
pub fn ancestors(depth: usize) -> Vec<u32> {
    let mut up = vec![];
    let mut p = crate::slots::ppid();
    while p > 1 && up.len() < depth {
        up.push(p);
        p = parent_of(p);
    }
    up
}
fn parent_of(pid: u32) -> u32 {
    if let Ok(t) = std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        if let Some(i) = t.rfind(") ") {
            return t[i + 2..]
                .split(' ')
                .nth(1)
                .and_then(|x| x.parse().ok())
                .unwrap_or(0);
        }
    }
    std::process::Command::new("ps")
        .args(["-o", "ppid=", "-p", &pid.to_string()])
        .output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok())
        .unwrap_or(0)
}

/// A line of a tool call or a reason with what looks like a secret taken out.
pub fn redact(s: &str) -> String {
    let r1 = Regex::new(r"(?i)(?-u:\b)(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}").unwrap();
    let r2 = Regex::new(r"(?i)((?-u:\b)[a-z][a-z0-9+.-]*://)[^\s/@:]+(?::[^\s/@]*)?@").unwrap();
    let r3 = Regex::new(r"(?i)(--?[A-Za-z0-9_-]*(?:token|secret|password|passwd|pass|key|auth|credential)[A-Za-z0-9_-]*)([= ])\S+").unwrap();
    let r4 = Regex::new(r#"(?-u:\b)([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S*)"#).unwrap();
    let r5 = Regex::new(r"(?-u:\b)(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}|(?-u:\b)gh[pousr]_[A-Za-z0-9]{16,}|(?-u:\b)github_pat_[A-Za-z0-9_]{16,}|(?-u:\b)xox[abprs]-[A-Za-z0-9_-]{8,}|(?-u:\b)AKIA[0-9A-Z]{12,}|(?-u:\b)eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?").unwrap();
    let r6 = Regex::new(r"(?-u:\b)[A-Za-z0-9+/_-]{32,}={0,2}").unwrap();
    let a = r1.replace_all(s, "Bearer …");
    let b = r2.replace_all(&a, "${1}…@");
    let c = r3.replace_all(&b, "${1}${2}…");
    let d = r4.replace_all(&c, "${1}=…");
    let e = r5.replace_all(&d, "…");
    r6.replace_all(&e, "…").to_string()
}
/// JS clip(s, n) on UTF-16 units.
pub fn clip(s: &str, n: usize) -> String {
    let u: Vec<u16> = s.encode_utf16().collect();
    if u.len() > n {
        format!("{}…", String::from_utf16_lossy(&u[..n - 1]))
    } else {
        s.to_string()
    }
}
fn ws1(s: &str) -> String {
    crate::util::js_trim(&Regex::new(r"\s+").unwrap().replace_all(s, " ")).to_string()
}
/// What the card shows of a tool call: its own description, and the call itself in short.
pub fn preview_of(tool_input: &Value) -> (String, String) {
    let i = if tool_input.is_object() {
        tool_input.clone()
    } else {
        json!({})
    };
    let preview = match i.get("command") {
        Some(Value::String(c)) => c.clone(),
        _ => {
            // What the call is about comes first, so that a long content cannot push it out of the preview.
            let first = ["file_path", "path", "notebook_path", "url", "pattern"];
            let fields = i.as_object().cloned().unwrap_or_default();
            let ordered = first
                .iter()
                .filter_map(|k| fields.get_key_value(*k))
                .chain(fields.iter().filter(|(k, _)| !first.contains(&k.as_str())));
            let parts: Vec<String> = ordered
                .map(|(k, v)| format!("{}:{v}", Value::String(k.clone())))
                .collect();
            format!("{{{}}}", parts.join(","))
        }
    };
    let desc = match i.get("description") {
        Some(Value::String(d)) => d.clone(),
        _ => String::new(),
    };
    // Sent to the board without anyone looking at it first: secrets are taken out before it is cut.
    (clip(&redact(&desc), 300), clip(&redact(&preview), 600))
}
/// The line the board gets for a denial.
pub fn denied_text(tool_name: &str, reason: &str, tool_input: &Value) -> String {
    let i = if tool_input.is_object() {
        tool_input.clone()
    } else {
        json!({})
    };
    let call = ["command", "file_path", "url"]
        .iter()
        .find_map(|k| i.get(*k).and_then(|v| v.as_str()).map(String::from))
        .unwrap_or_default();
    let why = {
        let r = ws1(&redact(reason));
        if r.is_empty() {
            ws1(&redact(&call))
        } else {
            r
        }
    };
    format!(
        "Auto mode blocked: {}{}",
        clip(&ws1(&redact(tool_name)), 60),
        if why.is_empty() {
            String::new()
        } else {
            format!(" — {}", clip(&why, 120))
        }
    )
}
/// The door request for a hook's input JSON, or None when this hook has nothing to ask.
pub fn hook_request(kind: &str, input: &Value) -> Option<Value> {
    if !input.is_object() {
        return None;
    }
    let tool = input
        .get("tool_name")
        .filter(|v| crate::util::truthy(v))
        .map(js_string);
    match kind {
        "permission" | "resolved" => {
            let t = tool?;
            if DIALOG_TOOLS.contains(&t.as_str()) {
                return None;
            }
            let (description, input_preview) =
                preview_of(input.get("tool_input").unwrap_or(&Value::Null));
            let mut r = json!({ "op": kind, "ancestors": ancestors(8), "tool_name": t, "description": description, "input_preview": input_preview });
            if kind == "permission" {
                r["wait_ms"] = json!(wait_ms());
            }
            Some(r)
        }
        "notice" => {
            let nt = input.get("notification_type").and_then(|v| v.as_str())?;
            if !NOTICE_TYPES.contains(&nt) {
                return None;
            }
            Some(
                json!({ "op": "notice", "ancestors": ancestors(8), "notification_type": nt, "message": clip(&input.get("message").filter(|v| !v.is_null()).map(js_string).unwrap_or_default(), 300) }),
            )
        }
        "denied" => {
            let t = tool?;
            Some(
                json!({ "op": "denied", "ancestors": ancestors(8), "text": denied_text(&t, &input.get("reason").filter(|v| !v.is_null()).map(js_string).unwrap_or_default(), input.get("tool_input").unwrap_or(&Value::Null)) }),
            )
        }
        _ => None,
    }
}
/// What a hook prints for the connector's answer: Claude Code's decision JSON, or '' for no decision.
pub fn hook_output(kind: &str, answer: &Value) -> String {
    let b = answer
        .get("behavior")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if kind != "permission"
        || answer.get("ok") != Some(&Value::Bool(true))
        || !["allow", "deny"].contains(&b)
    {
        return String::new();
    }
    let decision = if b == "allow" {
        json!({ "behavior": "allow" })
    } else {
        json!({ "behavior": "deny", "message": "Denied by the human on the Trommi board." })
    };
    json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": decision } })
        .to_string()
}

pub type BridgeFn = Arc<dyn Fn() -> Option<Arc<Bridge>> + Send + Sync>;
pub type SayFn =
    Arc<dyn Fn(Arc<Bridge>, Value) -> BoxFut<'static, crate::error::Result<String>> + Send + Sync>;

struct OpenEntry {
    id: u64,
    tool_name: String,
    key: String,
    request_id: Option<String>,
    end: Arc<tokio::sync::Mutex<Option<tokio::sync::oneshot::Sender<String>>>>,
}
struct DeskState {
    open: Vec<OpenEntry>,
    unpaired: Vec<(String, String, u64)>,
    answered_at: u64,
    denied_at: Option<u64>,
    denied_more: u64,
    denied_timer: Option<tokio::task::JoinHandle<()>>,
    next: u64,
}
/// The connector's side: answers the hooks' door requests.
pub struct HookDesk {
    heard: bool,
    bridge: BridgeFn,
    say: SayFn,
    ppid: u32,
    st: Mutex<DeskState>,
    pub settle_ms: u64,
    pub denied_window_ms: u64,
    pub pair_ms: u64,
}
fn key_of(req: &Value) -> String {
    [
        req.get("tool_name"),
        req.get("description"),
        req.get("input_preview"),
    ]
    .iter()
    .map(|v| {
        v.filter(|x| !x.is_null())
            .map(js_string)
            .unwrap_or_default()
    })
    .collect::<Vec<_>>()
    .join("\n")
}
impl HookDesk {
    pub fn new(heard: bool, bridge: BridgeFn, say: SayFn, ppid: u32) -> Arc<HookDesk> {
        Arc::new(HookDesk {
            heard,
            bridge,
            say,
            ppid,
            st: Mutex::new(DeskState {
                open: vec![],
                unpaired: vec![],
                answered_at: 0,
                denied_at: None,
                denied_more: 0,
                denied_timer: None,
                next: 0,
            }),
            settle_ms: 1500,
            denied_window_ms: 30_000,
            pair_ms: 30_000,
        })
    }
    pub async fn handle(self: &Arc<Self>, req: Value, gone: Gone) -> Value {
        if !req
            .get("ancestors")
            .and_then(|a| a.as_array())
            .is_some_and(|a| a.iter().any(|x| x.as_u64() == Some(self.ppid as u64)))
        {
            return json!({ "ok": false, "error": "another session" });
        }
        match req.get("op").and_then(|v| v.as_str()) {
            Some("permission") => self.permission(req, gone).await,
            Some("resolved") => self.resolved(&req),
            Some("notice") => self.notice(&req).await,
            Some("denied") => self.denied(&req).await,
            _ => json!({ "ok": false, "error": "unknown request" }),
        }
    }
    async fn permission(self: &Arc<Self>, req: Value, gone: Gone) -> Value {
        let Some(b) = (self.bridge)() else {
            return json!({ "ok": false, "error": "not in a room" });
        };
        let wait = req
            .get("wait_ms")
            .and_then(|v| v.as_f64())
            .filter(|v| *v != 0.0)
            .unwrap_or(300_000.0)
            .clamp(1000.0, 3_600_000.0) as u64;
        let (tx, rx) = tokio::sync::oneshot::channel::<String>();
        let end = Arc::new(tokio::sync::Mutex::new(Some(tx)));
        let id;
        {
            let mut st = self.st.lock().unwrap();
            st.next += 1;
            id = st.next;
            st.open.push(OpenEntry {
                id,
                tool_name: js_string(&req["tool_name"]),
                key: key_of(&req),
                request_id: None,
                end: end.clone(),
            });
        }
        let quiet = if self.heard {
            json!({ "ok": true, "silent": true })
        } else {
            json!({ "ok": true, "timeout": true })
        };
        let result = async {
            if self.heard {
                let mut st = self.st.lock().unwrap();
                let now = now_ms();
                let tn = js_string(&req["tool_name"]);
                if let Some(i) = st.unpaired.iter().position(|(_, t, at)| *t == tn && now - at < self.pair_ms) {
                    let rid = st.unpaired.remove(i).0;
                    if let Some(e) = st.open.iter_mut().find(|e| e.id == id) {
                        e.request_id = Some(rid);
                    }
                }
            } else {
                let rid = format!("hook:{}", crate::util::random_hex(8));
                if let Some(e) = self.st.lock().unwrap().open.iter_mut().find(|e| e.id == id) {
                    e.request_id = Some(rid.clone());
                }
                let params = json!({ "request_id": rid, "tool_name": req["tool_name"], "description": req.get("description").cloned().unwrap_or(Value::Null), "input_preview": req.get("input_preview").cloned().unwrap_or(Value::Null), "expires_in_ms": wait });
                if let Err(e) = b.permission_request(&params).await {
                    return json!({ "ok": false, "error": e.text() });
                }
            }
            let how = tokio::select! {
                r = rx => r.unwrap_or_else(|_| "timeout".into()),
                _ = gone.wait() => "gone".into(),
                _ = tokio::time::sleep(std::time::Duration::from_millis(wait)) => "timeout".into(),
            };
            if how == "allow" || how == "deny" {
                self.st.lock().unwrap().answered_at = now_ms();
                return if self.heard { quiet.clone() } else { json!({ "ok": true, "behavior": how }) };
            }
            let rid = self.st.lock().unwrap().open.iter().find(|e| e.id == id).and_then(|e| e.request_id.clone());
            if how != "timeout" {
                if let Some(rid) = rid {
                    self.st.lock().unwrap().answered_at = now_ms();
                    if let Some(bb) = (self.bridge)() {
                        if let Err(e) = bb.permission_withdraw(&rid, "answered in the terminal").await {
                            eprintln!("[trommi] permission request not withdrawn: {}", e.text());
                        }
                    }
                }
            }
            quiet.clone()
        }
        .await;
        self.st.lock().unwrap().open.retain(|e| e.id != id);
        result
    }
    fn resolved(&self, req: &Value) -> Value {
        let k = key_of(req);
        let end = self
            .st
            .lock()
            .unwrap()
            .open
            .iter()
            .find(|e| e.key == k)
            .map(|e| e.end.clone());
        match end {
            Some(e) => {
                if let Ok(mut g) = e.try_lock() {
                    if let Some(tx) = g.take() {
                        let _ = tx.send("resolved".into());
                    }
                }
                json!({ "ok": true, "withdrawn": true })
            }
            None => json!({ "ok": true, "silent": true }),
        }
    }
    async fn notice(&self, req: &Value) -> Value {
        let nt = req
            .get("notification_type")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !NOTICE_TYPES.contains(&nt) {
            return json!({ "ok": true, "silent": true });
        }
        if nt == "permission_prompt" {
            if self.heard {
                return json!({ "ok": true, "silent": true });
            }
            tokio::time::sleep(std::time::Duration::from_millis(self.settle_ms)).await;
            let st = self.st.lock().unwrap();
            if !st.open.is_empty()
                || now_ms().saturating_sub(st.answered_at) < self.settle_ms + 10_000
            {
                return json!({ "ok": true, "silent": true });
            }
        }
        let Some(b) = (self.bridge)() else {
            return json!({ "ok": false, "error": "not in a room" });
        };
        let what = ws1(&req
            .get("message")
            .filter(|v| !v.is_null())
            .map(js_string)
            .unwrap_or_default());
        let text = format!(
            "The terminal is waiting for you{}",
            if what.is_empty() {
                ".".to_string()
            } else {
                format!(": {what}")
            }
        );
        if let Err(e) = (self.say)(b, json!({ "urgent": true, "text": text })).await {
            return json!({ "ok": false, "error": e.text() });
        }
        json!({ "ok": true, "said": true })
    }
    async fn denied(self: &Arc<Self>, req: &Value) -> Value {
        let Some(b) = (self.bridge)() else {
            return json!({ "ok": false, "error": "not in a room" });
        };
        let text: String = ws1(&redact(
            &req.get("text")
                .filter(|v| !v.is_null())
                .map(js_string)
                .unwrap_or_default(),
        ))
        .chars()
        .take(260)
        .collect();
        if !text.starts_with("Auto mode blocked: ") {
            return json!({ "ok": false, "error": "bad request" });
        }
        {
            let mut st = self.st.lock().unwrap();
            let now = now_ms();
            if st
                .denied_at
                .is_some_and(|at| now.saturating_sub(at) < self.denied_window_ms)
            {
                st.denied_more += 1;
                return json!({ "ok": true, "counted": true });
            }
            st.denied_at = Some(now);
            st.denied_more = 0;
            if let Some(t) = st.denied_timer.take() {
                t.abort();
            }
            let me = self.clone();
            st.denied_timer = Some(tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(me.denied_window_ms)).await;
                let n = std::mem::take(&mut me.st.lock().unwrap().denied_more);
                if n > 0 {
                    if let Some(bb) = (me.bridge)() {
                        if let Err(e) = (me.say)(bb, json!({ "urgent": false, "text": format!("…and {n} more Auto mode block{}.", if n == 1 { "" } else { "s" }) })).await {
                            eprintln!("[trommi] denied: {}", e.text());
                        }
                    }
                }
            }));
        }
        if let Err(e) = (self.say)(b, json!({ "urgent": false, "text": text })).await {
            return json!({ "ok": false, "error": e.text() });
        }
        json!({ "ok": true, "said": true })
    }
    /// A verdict the bridge reports: true when it answers a hook (then it is not a channel notification).
    pub fn verdict(&self, params: &Value) -> bool {
        let id = js_string(params.get("request_id").unwrap_or(&Value::Null));
        let end = self
            .st
            .lock()
            .unwrap()
            .open
            .iter()
            .find(|e| e.request_id.as_deref() == Some(&id))
            .map(|e| e.end.clone());
        let found = end.is_some();
        if let Some(e) = end {
            let how = if params.get("behavior").and_then(|v| v.as_str()) == Some("allow") {
                "allow"
            } else {
                "deny"
            };
            if let Ok(mut g) = e.try_lock() {
                if let Some(tx) = g.take() {
                    let _ = tx.send(how.into());
                }
            }
        }
        if !id.starts_with("hook:") {
            return false;
        }
        if !found {
            eprintln!("[trommi] verdict for a permission hook that waits no more ({id})");
        }
        true
    }
    /// Channel mode: Claude Code relayed a prompt; the permission hook of the same prompt stands for it.
    pub fn relayed(&self, params: &Value) {
        let mut st = self.st.lock().unwrap();
        let tn = js_string(&params["tool_name"]);
        let rid = js_string(&params["request_id"]);
        if let Some(e) = st
            .open
            .iter_mut()
            .find(|e| e.request_id.is_none() && e.tool_name == tn)
        {
            e.request_id = Some(rid);
        } else {
            st.unpaired.push((rid, tn, now_ms()));
            if st.unpaired.len() > 20 {
                st.unpaired.remove(0);
            }
        }
    }
}
