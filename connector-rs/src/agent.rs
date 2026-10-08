//! agent.mjs and the sending half of client.mjs: seal, outbox, settle; what an agent does (cards, messages, status
//! registers, permission requests, published objects, child sessions); the gate on every command (authoriseCommand);
//! timelines read lazily; attachments and share links.
use crate::client::*;
use crate::codec;
use crate::crypto::grants as G;
use crate::crypto::{self, b64u, hex, unb64u, unhex, Rng};
use crate::error::{Result, ZError};
use crate::model::{self, now_ms, Change};
use serde_json::{json, Map, Value};
use std::sync::atomic::Ordering;

pub const ZERO_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

pub struct ObjSpec {
    pub object_id: String,
    pub object_state: String,
    pub urgency: String,
    pub answered_at: u64,
}
pub struct Built {
    pub content: Map<String, Value>,
    pub object: Option<ObjSpec>,
    pub bind: Option<Vec<u8>>,
    pub session_id: Option<String>,
    pub recipient: Option<String>,
    pub timeline: Option<(String, String)>,
    pub push: bool,
}
pub struct SentInfo {
    pub local_id: String,
    pub envelope_hash: String,
    pub seq: u64,
}
type AfterFn = Box<dyn FnOnce(&mut Core, &crypto::Sealed, &Map<String, Value>) + Send>;

/// A version's urgency: given, or the head's.
pub enum Urg {
    Given(String),
    Head,
}

impl Client {
    /// Seal one envelope and queue it (the own chain and the outbox reach storage before the hub sees it).
    pub async fn send(&self, kind: u8, build: impl FnOnce(&mut Core) -> Result<Built>, after: Option<AfterFn>) -> Result<SentInfo> {
        let local_id = format!("local-{}", crypto::random_hex(8));
        let info = {
            let mut c = self.core.lock().await;
            if let Some(f) = &c.storage_failed {
                return Err(ZError::new("storage-failed", format!("storage failed earlier: restart before sending ({f})")));
            }
            let mut b = build(&mut c)?;
            let note = kind == codec::KIND_OBJECT_VERSION && b.content.get("object_type").and_then(|v| v.as_str()) == Some("note");
            if kind == codec::KIND_STATUS || note {
                c.lamport += 1;
                let l = c.lamport;
                b.content.insert("lamport".into(), json!(l));
            }
            let payload = {
                // (tests stand in for a newer client here)
                let n = *self.newer.lock().unwrap();
                let ct = b.content.get("content_type").and_then(|v| v.as_str());
                let card = kind == codec::KIND_OBJECT_VERSION && b.content.get("object_type").and_then(|v| v.as_str()) == Some("card");
                if (n.message && ct == Some("message")) || (n.answer && kind == codec::KIND_ANSWER) || (n.card && card) {
                    let mut x = Map::new();
                    x.insert("schema_version".into(), json!(1));
                    for (k, v) in &b.content {
                        x.insert(k.clone(), v.clone());
                    }
                    if n.message && ct == Some("message") {
                        x.insert("content_type".into(), json!("voice"));
                        x.insert("duration_ms".into(), json!(1200));
                    } else {
                        x.insert("schema_version".into(), json!(2));
                    }
                    serde_json::to_vec(&Value::Object(x))?
                } else {
                    codec::encode_payload(kind, &b.content)?
                }
            };
            if payload.len() > 60_000 {
                return Err(ZError::new("too-large", "body over 60 KB: put it into an attachment"));
            }
            if kind == codec::KIND_STATUS && payload.len() + b.bind.as_ref().map(|x| x.len()).unwrap_or(0) + 16 > 4096 {
                return Err(ZError::new("too-large", "a status body is at most 4 KiB"));
            }
            let blobs: Vec<[u8; 16]> = codec::attachment_ids_of(&b.content).iter().filter_map(|id| unhex(id).ok()?.try_into().ok()).collect();
            if let Some(sid) = &b.session_id {
                self.await_fresh_session(&mut c, sid).await?;
            }
            let (secret, key_scope, session_bytes) = match &b.session_id {
                Some(sid) => {
                    let k = c.session_keys.get(sid);
                    let s = k.and_then(|k| k.secrets.get(&k.state.epoch)).cloned();
                    let Some(s) = s else { return Err(ZError::new("no-key", format!("no key for session {}", &sid[..8.min(sid.len())]))) };
                    (s, 1u8, Some(unhex(sid)?.try_into().map_err(|_| ZError::new("bad-argument", "session id"))?))
                }
                None => {
                    if !c.is_human() {
                        return Err(ZError::new("no-session", "agents send under a session key: no session is assigned to this agent yet"));
                    }
                    let Some(s) = c.secrets.get(&c.state.epoch).cloned() else { return Err(ZError::new("no-key", "no key for the current epoch")) };
                    (s, 0u8, None)
                }
            };
            let card = match &b.object {
                Some(o) => Some(crypto::CardBlock {
                    id: unhex(&o.object_id)?.try_into().map_err(|_| ZError::new("bad-argument", "object id"))?,
                    state: codec::object_state_num(&o.object_state).unwrap_or(1),
                    urgency: codec::urgency_num(&o.urgency).unwrap_or(1),
                    answered_at: o.answered_at,
                }),
                None => None,
            };
            let recipient: Option<[u8; 32]> = match &b.recipient {
                Some(r) => Some(unhex(r)?.try_into().map_err(|_| ZError::new("bad-argument", "recipient"))?),
                None => None,
            };
            let (tk, tid) = match &b.timeline {
                Some((k, id)) => (codec::timeline_kind_num(k), Some(id.clone())),
                None => (None, None),
            };
            let state = c.state.clone();
            let sealed = {
                let core: &mut Core = &mut c;
                crypto::seal_envelope(crypto::SealArgs {
                    device: &self.device, state: &state, secret: &secret, key_scope, session_id: session_bytes, kind, bind: b.bind.clone().unwrap_or_default(),
                    payload, recipient, time: now_ms(), card, timeline_kind: tk, timeline_id: tid, blobs, push: b.push, seen: None,
                }, &mut core.chains, &mut Rng::Os)?
            };
            let hash_hex = hex(&sealed.hash);
            c.sent_content.insert(hash_hex.clone(), b.content.clone());
            if let Some(a) = after {
                a(&mut c, &sealed, &b.content);
            }
            let public = json!({
                "local_id": local_id, "envelope_kind": codec::kind_name(kind), "object_id": b.object.as_ref().map(|o| o.object_id.clone()),
                "timeline_key": b.timeline.as_ref().map(|(k, id)| model::timeline_key(k, id)), "recipient_device_id": b.recipient,
                "content": b.content, "outbox_state": "sending", "error": null,
            });
            let args = json!({
                "kind": kind, "content": b.content, "bind": b.bind.as_ref().filter(|x| !x.is_empty()).map(|x| b64u(x)), "recipient": b.recipient,
                "object": b.object.as_ref().map(|o| json!({ "object_id": o.object_id, "object_state": o.object_state, "urgency": o.urgency, "answered_at": o.answered_at })),
                "timeline": b.timeline.as_ref().map(|(k, id)| json!({ "timeline_kind": k, "timeline_id": id })), "push": b.push, "session_id": b.session_id,
            });
            let item = json!({ "local_id": local_id, "bytes": b64u(&sealed.bytes), "seq": sealed.seq, "hash": hash_hex, "prev": b64u(&sealed.header.prev), "public": public, "args": args });
            c.outbox.push(OutboxItem { raw: item.as_object().unwrap().clone() });
            c.by_hash.insert(hash_hex.clone(), local_id.clone());
            let me = b64u(&self.device.id);
            let outbox: Vec<Value> = c.outbox.iter().map(|o| Value::Object(o.raw.clone())).collect();
            let chain = c.chains.get(&me).map(chain_to_json).unwrap_or(Value::Null);
            if let Err(e) = self.storage.set_many(vec![("outbox".into(), Some(Value::Array(outbox))), (format!("chain/{me}"), Some(chain)), ("lamport".into(), Some(json!(c.lamport)))]) {
                c.outbox.pop();
                c.storage_failed = Some(e.text());
                let err = ZError::new("storage-failed", format!("could not save before sending: {}", e.text()));
                self.emit(ClientEvent::Error(err.clone()));
                return Err(err);
            }
            SentInfo { local_id: local_id.clone(), envelope_hash: hash_hex, seq: sealed.seq }
        };
        self.pump_outbox();
        Ok(info)
    }

    /// A1: never seal under a session key a removed device may hold; an agent waits for the human's re-key.
    async fn await_fresh_session(&self, c: &mut Core, sid: &str) -> Result<()> {
        let stale = |c: &Core| c.session_keys.get(sid).is_some_and(|k| G::grant_is_stale(&k.state, &c.state));
        if !stale(c) {
            return Ok(());
        }
        let mut t = 0;
        while t < self.rekey_wait_ms && stale(c) {
            sleep(1000).await;
            let _ = self.refresh_members(c, false, None).await;
            let _ = self.refresh_sessions(c, None).await;
            t += 1000;
        }
        if stale(c) {
            return Err(ZError::new("stale-session-key", "this session waits for a human device to re-key it after a removal"));
        }
        Ok(())
    }

    pub fn pump_outbox(&self) {
        if self.pump_running.swap(true, Ordering::SeqCst) {
            return;
        }
        let Some(me) = self.self_ref.lock().unwrap().upgrade() else {
            self.pump_running.store(false, Ordering::SeqCst);
            return;
        };
        tokio::spawn(async move {
            loop {
                me.pump_loop().await;
                me.pump_running.store(false, Ordering::SeqCst);
                // something came in while the pump stopped: go again
                let more = !me.core.lock().await.outbox.is_empty() && me.started.load(Ordering::SeqCst) && !me.lease_lost.load(Ordering::SeqCst);
                if !more || me.pump_running.swap(true, Ordering::SeqCst) {
                    break;
                }
            }
        });
    }
    async fn pump_loop(&self) {
        let mut backoff = 300u64;
        let mut lease_retried = false;
        loop {
            let item = {
                let c = self.core.lock().await;
                match c.outbox.first() {
                    Some(i) => i.clone(),
                    None => return,
                }
            };
            let is_human = self.core.lock().await.is_human();
            let res: Result<Value> = async {
                if !is_human && self.hub.lease_generation().is_none() {
                    self.claim_session(None).await?;
                }
                self.hub.post_envelope(&item.bytes()).await
            }
            .await;
            let generation = self.hub.lease_generation();
            match res {
                Ok(r) => {
                    let mut c = self.core.lock().await;
                    if let Some(first) = c.outbox.first_mut() {
                        if let Some(n) = r["envelope_number"].as_u64() {
                            first.raw.insert("envelope_number".into(), json!(n));
                        }
                    }
                    lease_retried = false;
                    c.model.room.outbox_blocked = None;
                    self.acked(&mut c);
                    backoff = 300;
                }
                Err(e) => {
                    if std::env::var("CORE_DEBUG").is_ok() {
                        eprintln!("[core] post {} {}", e.code, e.message);
                    }
                    if e.code == "replay" {
                        let mut c = self.core.lock().await;
                        self.acked(&mut c);
                        continue;
                    }
                    if e.code == "lease-lost" {
                        if self.hub.lease_generation() != generation {
                            continue;
                        }
                        let held = if lease_retried {
                            Ok(false)
                        } else {
                            self.hub.recover_lease().await
                        };
                        match held {
                            Err(_) => {
                                sleep(backoff).await;
                                backoff = (backoff * 2).min(2000);
                                continue;
                            }
                            Ok(true) => {
                                lease_retried = true;
                                continue;
                            }
                            Ok(false) => {
                                self.on_lease_lost(e);
                                return;
                            }
                        }
                    }
                    if e.code == "gap" {
                        let recent: Vec<String> = self.core.lock().await.recent_sent.iter().map(|o| o.bytes()).collect();
                        for b in recent {
                            let _ = self.hub.post_envelope(&b).await;
                        }
                        sleep(backoff).await;
                        backoff = (backoff * 2).min(10_000);
                        continue;
                    }
                    if e.code == "stale-session-key" {
                        let mut c = self.core.lock().await;
                        let _ = self.refresh_members(&mut c, false, None).await;
                        let _ = self.refresh_sessions(&mut c, None).await;
                    }
                    let st = e.status.unwrap_or(999);
                    if st == 0 || st >= 500 || st == 429 || e.code == "unauthorised" || e.code == "stale-session-key" {
                        sleep(e.retry_after.map(|r| r * 1000).unwrap_or(backoff)).await;
                        backoff = (backoff * 2).min(2000);
                        if !self.started.load(Ordering::SeqCst) && st == 0 {
                            return;
                        }
                        continue;
                    }
                    if e.body.as_ref().and_then(|b| b["voided"].as_bool()) == Some(true) {
                        let mut c = self.core.lock().await;
                        let h = item.hash();
                        if let Some(first) = c.outbox.first_mut() {
                            if let Some(p) = first.raw.get_mut("public").and_then(|p| p.as_object_mut()) {
                                p.insert("outbox_state".into(), json!("failed"));
                                p.insert("error".into(), json!(e.code));
                            }
                        }
                        c.sent_content.remove(&h);
                        c.voided_own.insert(h);
                        self.acked(&mut c);
                        let mut ch = Change::default();
                        c.model.push_alert(&mut ch, if e.code.is_empty() { "refused" } else { &e.code }, &format!("the hub refused an envelope: {}", e.message), None, None, "local");
                        continue;
                    }
                    {
                        let mut c = self.core.lock().await;
                        let lid = item.local_id();
                        let already = c.model.room.outbox_blocked.as_ref().and_then(|b| b["local_id"].as_str().map(String::from)) == Some(lid.clone());
                        if !already {
                            if let Some(first) = c.outbox.first_mut() {
                                if let Some(p) = first.raw.get_mut("public").and_then(|p| p.as_object_mut()) {
                                    p.insert("outbox_state".into(), json!("blocked"));
                                    p.insert("error".into(), json!(e.code));
                                }
                            }
                            c.model.room.outbox_blocked = Some(json!({ "local_id": lid, "code": if e.code.is_empty() { "refused".to_string() } else { e.code.clone() }, "message": e.message }));
                            let mut ch = Change::default();
                            c.model.push_alert(&mut ch, "chain-halted", &format!("the hub refused an envelope ({}): {}. Sending is halted; the same envelope is retried.", e.code, e.message), None, None, "local");
                        }
                    }
                    let mut t = 0;
                    while t < BLOCKED_RETRY_MS && self.started.load(Ordering::SeqCst) {
                        sleep(250).await;
                        t += 250;
                    }
                    if !self.started.load(Ordering::SeqCst) {
                        return;
                    }
                }
            }
        }
    }
    fn acked(&self, c: &mut Core) {
        if c.outbox.is_empty() {
            return;
        }
        let item = c.outbox.remove(0);
        c.recent_sent.push(item);
        if c.recent_sent.len() > 32 {
            c.recent_sent.remove(0);
        }
        let outbox: Vec<Value> = c.outbox.iter().map(|o| Value::Object(o.raw.clone())).collect();
        let _ = self.storage.set("outbox", Value::Array(outbox));
    }

    /// Wait until the outbox is empty and the hub's copies came back through sync.
    pub async fn settle(&self, timeout_ms: u64) -> Result<()> {
        let until = now_ms() + timeout_ms;
        while now_ms() < until {
            let (blocked, outbox_len, by_hash_len, need_resync) = {
                let c = self.core.lock().await;
                (c.model.room.outbox_blocked.clone(), c.outbox.len(), c.by_hash.len(), c.need_resync)
            };
            if let Some(b) = blocked {
                return Err(ZError::new("chain-halted", format!("sending is halted: the hub refused an envelope ({})", b["code"].as_str().unwrap_or(""))));
            }
            if self.pump_running.load(Ordering::SeqCst) && outbox_len > 0 {
                sleep(50).await;
                continue;
            }
            if self.background.load(Ordering::SeqCst) > 0 {
                sleep(20).await;
                continue;
            }
            if outbox_len == 0 && by_hash_len == 0 {
                return Ok(());
            }
            if outbox_len == 0 {
                let mut c = self.core.lock().await;
                self.check_missed_echoes(&mut c);
                if c.need_resync || need_resync {
                    Box::pin(self.resync(&mut c)).await?;
                }
            }
            if !self.stream_open.load(Ordering::SeqCst) || self.core.lock().await.model.room.connection != "live" {
                self.catch_up().await?;
                sleep(10).await;
            } else {
                sleep(10).await;
            }
        }
        let c = self.core.lock().await;
        Err(ZError::new("timeout", format!("outbox not settled ({} waiting, {} not echoed)", c.outbox.len(), c.by_hash.len())))
    }

    // ---- the lease --------------------------------------------------------------------------------------------------

    /// The lease (v1.1): one running process per agent key. Returns { agent_session_id, lease_generation, expires_at }.
    pub async fn claim_session(&self, process_instance: Option<String>) -> Result<Value> {
        let instance = process_instance.or_else(|| self.hub.lease_instance()).or_else(|| self.process_instance.lock().unwrap().clone()).unwrap_or_else(|| {
            let p = crypto::random_hex(8);
            *self.process_instance.lock().unwrap() = Some(p.clone());
            p
        });
        let r = self.hub.agent_lease(&instance, false).await?;
        self.hub.set_lease_generation(r["lease_generation"].as_u64());
        self.hub.set_lease_instance(Some(instance.clone()));
        let every = 30_000u64.max((5 * 60_000u64).min(r["expires_at"].as_u64().unwrap_or(now_ms() + 600_000).saturating_sub(now_ms()) / 2));
        let w = self.self_ref.lock().unwrap().clone();
        let inst = instance.clone();
        tokio::spawn(async move {
            loop {
                sleep(every).await;
                let Some(c) = w.upgrade() else { break };
                if !c.started.load(Ordering::SeqCst) || c.hub.lease_instance().as_deref() != Some(&inst) {
                    break;
                }
                match c.hub.agent_lease(&inst, true).await {
                    Ok(x) => c.hub.set_lease_generation(x["lease_generation"].as_u64()),
                    Err(e) if e.code == "lease-lost" => c.on_lease_lost(e),
                    Err(_) => {}
                }
            }
        });
        let asid = r["agent_session_id"].as_str().map(String::from).unwrap_or_else(|| self.me()[..16].to_string());
        self.core.lock().await.model.room.agent_session_id = Some(asid.clone());
        let mut out = r.as_object().cloned().unwrap_or_default();
        out.insert("agent_session_id".into(), json!(asid));
        Ok(Value::Object(out))
    }

    /// Resolves with the first session assigned to this agent.
    pub async fn when_session(&self) -> String {
        loop {
            let notified = self.session_notify.notified();
            if let Some(s) = self.core.lock().await.session_id() {
                return s;
            }
            tokio::select! { _ = notified => {}, _ = sleep(500) => {} }
        }
    }

    // ---- registers ------------------------------------------------------------------------------------------------

    /// Registers: agent keys from agents, `device/<own id>` from anyone.
    pub async fn set_registers(&self, values: Map<String, Value>, session_id: Option<String>) -> Result<SentInfo> {
        let me = self.me();
        let human = self.core.lock().await.is_human();
        for k in values.keys() {
            if k.starts_with("device/") {
                if *k != format!("device/{me}") {
                    return Err(ZError::new("forbidden", "a device writes only its own device register"));
                }
                continue;
            }
            let bad = if human { !model::is_human_register_key(k) && model::is_agent_key(k) } else { model::is_human_register_key(k) };
            if bad {
                return Err(ZError::new("forbidden", format!("{k} is not a {} key", if human { "human" } else { "agent" })));
            }
        }
        self.send(codec::KIND_STATUS, move |c| {
            let sid = if c.is_human() { session_id } else { session_id.or_else(|| c.session_id()) };
            let mut content = Map::new();
            content.insert("values".into(), Value::Object(values));
            Ok(Built { content, object: None, bind: None, session_id: sid, recipient: None, timeline: None, push: false })
        }, None).await
    }
    pub async fn set_status(&self, values: Map<String, Value>, session_id: Option<String>) -> Result<SentInfo> {
        self.set_registers(values, session_id).await
    }

    /// The receipt: every command of the session up to envelope number up_to was handed to the agent.
    pub async fn mark_heard(&self, up_to: u64, session_id: Option<String>) -> Result<bool> {
        let sid = {
            let mut c = self.core.lock().await;
            let Some(sid) = session_id.or_else(|| c.session_id()) else { return Ok(false) };
            let shown = c.model.sessions.get(&sid).and_then(|s| s.heard_up_to).map(|x| x as i64).unwrap_or(-1);
            let sent = c.heard_sent.get(&sid).map(|x| *x as i64).unwrap_or(-1);
            if up_to as i64 <= sent.max(shown) {
                return Ok(false);
            }
            c.heard_sent.insert(sid.clone(), up_to);
            sid
        };
        let mut v = Map::new();
        v.insert("heard".into(), json!({ "up_to": up_to, "at": now_ms() }));
        if let Err(e) = self.set_status(v, Some(sid.clone())).await {
            let mut c = self.core.lock().await;
            if c.heard_sent.get(&sid) == Some(&up_to) {
                c.heard_sent.remove(&sid);
            }
            return Err(e);
        }
        Ok(true)
    }

    // ---- own objects -------------------------------------------------------------------------------------------

    /// One new version of an own object (object_id None: a new object, R1 id).
    #[allow(clippy::too_many_arguments)]
    pub async fn version(&self, object_id: Option<String>, fields: Map<String, Value>, object_state: &str, urg: Urg, push: bool, kind: u8, bind: Option<Box<dyn FnOnce(&str) -> Vec<u8> + Send>>, session_id: Option<String>) -> Result<String> {
        let me = self.me();
        let dev_id = self.device.id;
        let id_cell = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let id_out = id_cell.clone();
        let object_state = object_state.to_string();
        let given_oid = object_id.clone();
        let sid_cell = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
        let sid_after = sid_cell.clone();
        let heads_self = self as *const Client as usize;
        let _ = heads_self;
        let built = move |c: &mut Core| -> Result<Built> {
            let sid = session_id
                .or_else(|| given_oid.as_ref().and_then(|o| c.model.cards.get(o).and_then(|k| k.session_id.clone()).or_else(|| c.model.published.get(o).and_then(|p| p.session_id.clone())).or_else(|| c.local_heads.get(o).and_then(|l| l.session_id.clone()))))
                .or_else(|| c.session_id());
            let Some(sid) = sid else { return Err(ZError::new("no-session", "no session is assigned to this agent yet")) };
            *sid_cell.lock().unwrap() = Some(sid.clone());
            let id = match &given_oid {
                Some(o) => o.clone(),
                None => hex(&crypto::object_id_of(&dev_id, c.own_seq(&dev_id) + 1)),
            };
            *id_cell.lock().unwrap() = id.clone();
            let head = if given_oid.is_some() { head_of(c, &id) } else { None };
            let urgency = match urg {
                Urg::Given(u) => u,
                Urg::Head => head.as_ref().map(|h| h.urgency.clone()).unwrap_or_else(|| "normal".into()),
            };
            let content = if kind == codec::KIND_OBJECT_VERSION {
                let mut m = head.as_ref().map(|h| h.content.clone()).unwrap_or_default();
                for (k, v) in fields {
                    m.insert(k, v);
                }
                m.insert("object_version".into(), json!(head.as_ref().map(|h| h.object_version).unwrap_or(0) + 1));
                m.insert("previous_version_hash".into(), json!(head.as_ref().and_then(|h| h.version_hash.clone()).unwrap_or_else(|| ZERO_HASH.into())));
                m
            } else {
                fields
            };
            let _ = &me;
            Ok(Built {
                content, object: Some(ObjSpec { object_id: id.clone(), object_state, urgency, answered_at: 0 }), bind: bind.map(|b| b(&id)), session_id: Some(sid),
                recipient: None, timeline: None, push,
            })
        };
        let id_for_after = id_out.clone();
        let after: Option<AfterFn> = if kind == codec::KIND_OBJECT_VERSION {
            Some(Box::new(move |c: &mut Core, sealed: &crypto::Sealed, content: &Map<String, Value>| {
                let id = id_for_after.lock().unwrap().clone();
                let card = sealed.header.card.unwrap();
                c.local_heads.insert(id, LocalHead {
                    session_id: sid_after.lock().unwrap().clone(), object_version: content.get("object_version").and_then(|v| v.as_u64()).unwrap_or(1), version_hash: hex(&sealed.hash),
                    content: content.clone(), object_state: codec::object_state_name(card.state).unwrap_or("open").into(), urgency: codec::urgency_name(card.urgency).unwrap_or("normal").into(),
                });
            }))
        } else {
            None
        };
        self.send(kind, built, after).await?;
        let id = id_out.lock().unwrap().clone();
        Ok(id)
    }

    pub async fn send_card(&self, mut fields: Map<String, Value>, session_id: Option<String>) -> Result<String> {
        self.need_agent().await?;
        let card_type = fields.remove("card_type").and_then(|v| v.as_str().map(String::from)).unwrap_or_else(|| "decision".into());
        let urgency = fields.remove("urgency").and_then(|v| v.as_str().map(String::from)).unwrap_or_else(|| "normal".into());
        if card_type == "decision" && !fields.get("options").and_then(|o| o.as_array()).is_some_and(|a| !a.is_empty()) {
            return Err(ZError::new("bad-argument", "a decision needs options"));
        }
        let mut f = Map::new();
        f.insert("object_type".into(), json!("card"));
        f.insert("card_type".into(), json!(card_type));
        for (k, v) in fields {
            f.insert(k, v);
        }
        self.version(None, f, "open", Urg::Given(urgency), true, codec::KIND_OBJECT_VERSION, None, session_id).await
    }

    async fn need_agent(&self) -> Result<()> {
        if self.core.lock().await.is_human() {
            return Err(ZError::new("forbidden", "only an agent does this"));
        }
        Ok(())
    }

    /// Whether this agent holds the object: it created it, or it continues the session it is in.
    pub fn holds(&self, c: &Core, agent: &str, session_id: Option<&str>) -> bool {
        c.model.holder_of(agent, session_id) == self.me()
    }

    fn own_open(&self, c: &Core, object_id: &str) -> Result<LocalHeadView> {
        let head = head_of(c, object_id);
        let Some(head) = head.filter(|h| h.content.get("object_type").and_then(|v| v.as_str()) == Some("card")) else {
            return Err(ZError::new("not-found", format!("no own card {object_id}")));
        };
        if let Some(card) = c.model.cards.get(object_id) {
            if c.model.holder_of(&card.agent_device_id, card.session_id.as_deref()) != self.me() {
                return Err(ZError::new("forbidden", "not this agent's card"));
            }
            if card.unsupported.is_some() {
                return Err(ZError::new("needs-update", format!("card {object_id} was made by a newer Trommi connector: {}", codec::UPDATE_MESSAGE)));
            }
        }
        Ok(head)
    }
    /// F1: an own card is open only if neither the last sent version nor the room closed it.
    fn own_open_state(&self, c: &Core, object_id: &str) -> Result<LocalHeadView> {
        let mut head = self.own_open(c, object_id)?;
        if let Some(card) = c.model.cards.get(object_id) {
            if card.object_state != "open" && !card.answer.as_ref().is_some_and(|a| a.pending) {
                head.object_state = card.object_state.clone();
            }
        }
        Ok(head)
    }

    pub async fn revise(&self, object_id: &str, mut changes: Map<String, Value>, urgency: Option<String>) -> Result<()> {
        self.need_agent().await?;
        let head = { let c = self.core.lock().await; self.own_open_state(&c, object_id)? };
        if head.object_state != "open" {
            return Err(ZError::new("card-closed", "only an open card can be revised"));
        }
        for f in ["close_summary", "withdraw_reason", "merged_into_object_id"] {
            if !changes.contains_key(f) || changes[f].is_null() {
                changes.insert(f.into(), Value::Null);
            }
        }
        let urg = match urgency { Some(u) => Urg::Given(u), None => Urg::Head };
        self.version(Some(object_id.into()), changes, "open", urg, false, codec::KIND_OBJECT_VERSION, None, None).await.map(|_| ())
    }
    pub async fn set_urgency(&self, object_id: &str, urgency: &str, reason: Option<Value>) -> Result<()> {
        let mut ch = Map::new();
        if let Some(r) = reason {
            ch.insert("urgency_reason".into(), r);
        }
        self.revise(object_id, ch, Some(urgency.into())).await
    }
    pub async fn withdraw(&self, object_id: &str, reason: &str) -> Result<()> {
        self.need_agent().await?;
        let head = { let c = self.core.lock().await; self.own_open_state(&c, object_id)? };
        if head.object_state != "open" {
            return Err(ZError::new("card-closed", "only an open card can be withdrawn; close an answered one"));
        }
        let mut f = Map::new();
        f.insert("withdraw_reason".into(), json!(reason));
        self.version(Some(object_id.into()), f, "closed", Urg::Head, false, codec::KIND_OBJECT_VERSION, None, None).await.map(|_| ())
    }
    pub async fn merge(&self, object_ids: &[String], mut fields: Map<String, Value>, session_id: Option<String>) -> Result<String> {
        self.need_agent().await?;
        let (heads, first_sid) = {
            let c = self.core.lock().await;
            let mut heads = vec![];
            for id in object_ids {
                heads.push(self.own_open_state(&c, id)?);
            }
            (heads, c.model.cards.get(&object_ids[0]).and_then(|k| k.session_id.clone()))
        };
        if heads.iter().any(|h| h.object_state != "open") {
            return Err(ZError::new("card-closed", "only open cards can be merged"));
        }
        let order = ["low", "normal", "high", "critical"];
        let urgency = fields.remove("urgency").and_then(|v| v.as_str().map(String::from)).unwrap_or_else(|| {
            heads.iter().map(|h| h.urgency.clone()).fold("low".to_string(), |a, b| if order.iter().position(|x| *x == b) > order.iter().position(|x| *x == a) { b } else { a })
        });
        fields.insert("urgency".into(), json!(urgency));
        fields.insert("merged_from_object_ids".into(), json!(object_ids));
        let new_id = self.send_card(fields, session_id.or(first_sid)).await?;
        for id in object_ids {
            let mut f = Map::new();
            f.insert("merged_into_object_id".into(), json!(new_id));
            self.version(Some(id.clone()), f, "closed", Urg::Head, false, codec::KIND_OBJECT_VERSION, None, None).await?;
        }
        Ok(new_id)
    }
    /// Close an own card (after an answer, or any time) or end a published object.
    pub async fn close(&self, object_id: &str, summary: &str) -> Result<()> {
        self.need_agent().await?;
        let head = { let c = self.core.lock().await; head_of(&c, object_id) };
        let Some(head) = head else { return Err(ZError::new("not-found", format!("no own object {object_id}"))) };
        if head.content.get("object_type").and_then(|v| v.as_str()) == Some("published") {
            return self.version(Some(object_id.into()), Map::new(), "closed", Urg::Head, false, codec::KIND_OBJECT_VERSION, None, None).await.map(|_| ());
        }
        { let c = self.core.lock().await; self.own_open(&c, object_id)?; }
        let mut f = Map::new();
        f.insert("close_summary".into(), json!(summary));
        self.version(Some(object_id.into()), f, "closed", Urg::Head, false, codec::KIND_OBJECT_VERSION, None, None).await.map(|_| ())
    }
    pub async fn unpublish(&self, object_id: &str) -> Result<()> {
        self.close(object_id, "").await
    }
    pub async fn publish(&self, attachments: Value, title: Value, note: Option<Value>, session_id: Option<String>) -> Result<String> {
        self.need_agent().await?;
        let mut f = Map::new();
        f.insert("object_type".into(), json!("published"));
        f.insert("attachments".into(), attachments);
        f.insert("title".into(), title);
        if let Some(n) = note {
            f.insert("note".into(), n);
        }
        self.version(None, f, "open", Urg::Given("normal".into()), false, codec::KIND_OBJECT_VERSION, None, session_id).await
    }

    /// A child session: the agent draws the key, seals it to itself, every human device and the recovery key,
    /// signs the first grant and writes its profile with parent_session = its main session.
    pub async fn open_child_session(&self, profile: Map<String, Value>) -> Result<String> {
        self.need_agent().await?;
        let sid = {
            let mut c = self.core.lock().await;
            let Some(parent) = c.session_id() else { return Err(ZError::new("no-session", "no main session is assigned to this agent yet")) };
            self.refresh_members(&mut c, false, None).await?;
            let r = G::create_session_grant(&c.state, &self.device, None, None, None, &[self.device.id], None, false, false, now_ms(), &mut Rng::Os)?;
            let sid = r.session_state.session_id.clone();
            let body = json!({ "signed_grant": b64u(&r.grant), "sealed_session_keys": r.wraps.iter().map(|(id, s)| json!({ "device_id": hex(id), "key_sealed": b64u(s) })).collect::<Vec<_>>() });
            self.hub.post_session_grant(&sid, body).await?;
            let mut k = SessionKeys { state: r.session_state.clone(), grants: vec![b64u(&r.grant)], secrets: Default::default(), since: None };
            k.secrets.insert(r.secret.epoch, r.secret.clone());
            c.session_keys.insert(sid.clone(), k.clone());
            let mut ch = Change::default();
            c.model.apply_session_grant(&k.state, &mut ch, &k.ever_agents(), Some(k.epoch_agents()));
            c.model.project(&mut ch);
            self.save_room(&mut c)?;
            c.mark_dirty(&ch, &[]);
            let _ = self.flush(&mut c);
            (sid, parent)
        };
        let mut p = profile;
        p.insert("parent_session".into(), json!(sid.1));
        p.insert("is_main".into(), json!(false));
        let mut v = Map::new();
        v.insert("profile".into(), Value::Object(p));
        self.set_status(v, Some(sid.0.clone())).await?;
        Ok(sid.0)
    }

    pub async fn request_permission(&self, tool_name: &str, description: &str, input_preview: &str, expires_in_ms: u64, session_id: Option<String>) -> Result<String> {
        self.need_agent().await?;
        let expires_at = now_ms() + expires_in_ms;
        let mut f = Map::new();
        f.insert("tool_name".into(), json!(tool_name));
        f.insert("description".into(), json!(description));
        f.insert("input_preview".into(), json!(input_preview));
        let bind: Box<dyn FnOnce(&str) -> Vec<u8> + Send> = Box::new(move |id: &str| crypto::encode_request_bind(&unhex(id).unwrap().try_into().unwrap(), expires_at));
        let id = self.version(None, f, "open", Urg::Given("critical".into()), true, codec::KIND_PERMISSION_REQUEST, Some(bind), session_id.clone()).await?;
        let mut c = self.core.lock().await;
        let sid = session_id.or_else(|| c.session_id());
        c.requests.insert(id.clone(), (sid, expires_at, false));
        Ok(id)
    }
    /// Withdraw an own pending permission request; false when it is not pending any more.
    pub async fn withdraw_permission(&self, object_id: &str, reason: &str) -> Result<bool> {
        self.need_agent().await?;
        let (sid, expires_at) = {
            let c = self.core.lock().await;
            let p = c.model.permissions.get(object_id);
            let own = c.requests.get(object_id);
            if p.is_none() && own.is_none() || p.is_some_and(|p| p.agent_device_id != self.me()) {
                return Err(ZError::new("not-found", format!("no own permission request {object_id}")));
            }
            let pending = match p { Some(p) => p.permission_state == "pending", None => !own.unwrap().2 };
            if !pending {
                return Ok(false);
            }
            let (sid, exp) = match (p, own) {
                (_, Some(o)) => (o.0.clone(), o.1),
                (Some(p), None) => (p.session_id.clone(), p.expires_at),
                _ => unreachable!(),
            };
            (sid, exp)
        };
        if now_ms() > expires_at {
            return Ok(false);
        }
        let mut f = Map::new();
        f.insert("withdraw_reason".into(), json!(reason));
        let bind: Box<dyn FnOnce(&str) -> Vec<u8> + Send> = Box::new(move |id: &str| crypto::encode_request_bind(&unhex(id).unwrap().try_into().unwrap(), expires_at));
        self.version(Some(object_id.into()), f, "closed", Urg::Given("critical".into()), false, codec::KIND_PERMISSION_REQUEST, Some(bind), sid).await?;
        if let Some(r) = self.core.lock().await.requests.get_mut(object_id) {
            r.2 = true;
        }
        Ok(true)
    }

    /// A message from the agent to everyone: into its session's chat, or a card's.
    pub async fn send_message(&self, mut fields: Map<String, Value>, object_id: Option<String>, session_id: Option<String>) -> Result<SentInfo> {
        let oid = object_id.clone();
        self.send(codec::KIND_TIMELINE_ITEM, move |c| {
            let card_sid = match &oid {
                Some(o) => {
                    let Some(card) = c.model.cards.get(o) else { return Err(ZError::new("not-found", format!("no card {o}"))) };
                    card.session_id.clone()
                }
                None => None,
            };
            let sid = card_sid.or(session_id).or_else(|| c.session_id());
            let tid = match &oid {
                Some(o) => format!("card/{o}"),
                None => format!("session/{}", sid.clone().unwrap_or_default()),
            };
            let mut content = Map::new();
            content.insert("content_type".into(), json!("message"));
            for (k, v) in std::mem::take(&mut fields) {
                content.insert(k, v);
            }
            Ok(Built { content, object: None, bind: None, session_id: sid, recipient: None, timeline: Some(("chat".into(), tid)), push: false })
        }, None).await
    }

    // ---- the gate ---------------------------------------------------------------------------------------------------

    /// Before the reducer applies the record: judge it against the board as it is.
    pub fn pre_authorise(&self, c: &Core, rec: &model::Rec) -> Option<PendingCmd> {
        let me = self.me();
        if rec.recipient_device_id.as_deref() != Some(&me) {
            return None;
        }
        if rec.sender_sequence <= c.delivered.get(&rec.sender_device_id).copied().unwrap_or(0) {
            return None;
        }
        if ![codec::KIND_TIMELINE_ITEM, codec::KIND_ANSWER, codec::KIND_VERDICT, codec::KIND_DECIDE_AGAIN].contains(&rec.kind) {
            return None;
        }
        let mut base = PendingCmd {
            rec: rec.clone(), session_id: rec.session_id.clone(), envelope_number: rec.envelope_number, envelope_hash: rec.envelope_hash.clone(), sender_sequence: rec.sender_sequence,
            sent_at: rec.sent_at, sender_device_id: rec.sender_device_id.clone(), object_id: rec.object.map(|o| o.object_id()),
            timeline_key: rec.timeline_id.as_ref().map(|tid| model::timeline_key(rec.timeline_kind.as_deref().unwrap_or(""), tid)), refused: None, message: None, late: false,
            unsupported: None, previous_choices: None,
        };
        if rec.is_head && rec.content.is_none() {
            if rec.content_state == "newer_schema" {
                base.unsupported = Some("a newer format".into());
                return Some(base);
            }
            base.refused = Some("undecryptable".into());
            return Some(base);
        }
        let sk = rec.session_id.as_ref().and_then(|s| c.session_keys.get(s));
        if rec.session_id.is_some() && !sk.is_some_and(|k| k.state.agent_ids.contains(&me)) {
            base.refused = Some("not-assigned".into());
            base.message = Some("a command in a session this agent does not hold".into());
            return Some(base);
        }
        let mut ctx = crypto::AuthCtx {
            state: &c.state, agent_id: self.device.id, now: now_ms(), epoch_changed_at: if rec.session_id.is_some() { sk.and_then(|k| k.since) } else { c.epoch_changed_at },
            own_seq: c.own_seq(&self.device.id), max_age_ms: None, seen_of_me: c.frontiers.get(&rec.sender_device_id).and_then(|f| f.get(&me)).copied().unwrap_or(0),
            session_epoch: sk.map(|k| k.state.epoch), card: None, decision: None, request: None,
        };
        let card = rec.object.and_then(|o| c.model.cards.get(&o.object_id()));
        if rec.kind == codec::KIND_ANSWER || rec.kind == codec::KIND_DECIDE_AGAIN {
            if let Some(card) = card {
                let answering = rec.kind == codec::KIND_ANSWER && rec.content.as_ref().and_then(|x| x.get("answer_action")).and_then(|v| v.as_str()) == Some("answer");
                let recd = card.recommended_list();
                let options = card.option_keys();
                let trusted = rec.content.as_ref().and_then(|x| x.get("trusted")).is_some_and(model::truthy);
                ctx.card = Some(crypto::CardCtx {
                    id: unhex(&card.object_id).ok().and_then(|b| b.try_into().ok()).unwrap_or([0; 16]),
                    hash: card.version_hash.as_deref().and_then(|h| unhex(h).ok()).and_then(|b| b.try_into().ok()).unwrap_or([0; 32]),
                    open: card.object_state == "open",
                    options: if answering { Some(if trusted { options.into_iter().filter(|k| recd.contains(k)).collect() } else { options }) } else { None },
                });
                if let Some(h) = card.answer.as_ref().and_then(|a| a.envelope_hash.as_deref()) {
                    ctx.decision = unhex(h).ok().and_then(|b| b.try_into().ok());
                }
                base.previous_choices = card.answer.as_ref().map(|a| a.choice_strs());
            }
        } else if rec.kind == codec::KIND_VERDICT {
            let pid = rec.object.map(|o| o.object_id()).or_else(|| rec.bind.as_ref().and_then(|b| b.request_id.clone()));
            if let Some(p) = pid.and_then(|i| c.model.permissions.get(&i)) {
                ctx.request = Some(crypto::RequestCtx {
                    id: unhex(&p.object_id).ok().and_then(|b| b.try_into().ok()).unwrap_or([0; 16]), hash: unhex(&p.version_hash).ok().and_then(|b| b.try_into().ok()).unwrap_or([0; 32]),
                    expires_at: p.expires_at, pending: p.permission_state == "pending",
                });
            }
        }
        match crypto::authorise_command(&rec.header, false, rec.raw_bind.as_deref(), &ctx) {
            Ok(late) => base.late = late,
            Err(e) => {
                base.refused = Some(if e.code.is_empty() { "refused".into() } else { e.code.clone() });
                base.message = Some(e.text());
            }
        }
        Some(base)
    }

    /// After a batch: refresh the member list before any answer/verdict/decide-again (R3), fetch bodies of thread
    /// items that came pruned, hand out commands once per (sender, sequence) (R4). Refusals become alert/<hash>.
    pub fn deliver_commands<'a>(&'a self, c: &'a mut Core, mut commands: Vec<PendingCmd>) -> BoxFut<'a, ()> {
        Box::pin(async move {
            if !c.held_commands.is_empty() && c.commands_halted.is_none() {
                let mut held = std::mem::take(&mut c.held_commands);
                held.append(&mut commands);
                commands = held;
            }
            commands = dedupe(commands);
            if c.commands_halted.is_none() && commands.iter().any(|x| x.refused.is_none() && x.rec.is_head) {
                match self.refresh_members(c, true, None).await {
                    Err(e) if e.code == "log-fork" || e.code == "log-rollback" => {
                        c.commands_halted = Some(e.code.clone());
                        self.emit(ClientEvent::Error(ZError::new(&e.code, "the member list forked: commands halted until a human acts")));
                    }
                    Err(_) => {
                        let mut held = std::mem::take(&mut c.held_commands);
                        held.extend(commands);
                        c.held_commands = dedupe(held);
                        if let Some(me) = self.self_ref.lock().unwrap().upgrade() {
                            tokio::spawn(async move {
                                sleep(3000).await;
                                let mut c = me.core.lock().await;
                                Box::pin(me.deliver_commands(&mut c, vec![])).await;
                            });
                        }
                        return;
                    }
                    Ok(()) => {}
                }
            }
            if c.commands_halted.is_some() {
                let mut held = std::mem::take(&mut c.held_commands);
                held.extend(commands);
                c.held_commands = dedupe(held);
                return;
            }
            for x in commands.iter_mut() {
                if x.refused.is_some() {
                    continue;
                }
                let sender = c.state.member_now(&unhex(&x.sender_device_id).unwrap_or_default()).map(|m| m.role);
                if sender != Some(crypto::ROLE_HUMAN) {
                    x.refused = Some("removed-sender".into());
                    x.message = Some("the sender was removed meanwhile".into());
                    continue;
                }
                if x.rec.kind == codec::KIND_TIMELINE_ITEM && x.rec.content.is_none() {
                    if let Some(key) = x.timeline_key.clone() {
                        let items = self.read_timeline(c, &key, x.envelope_number + 1, 50).await.unwrap_or_default();
                        match items.iter().find(|i| i["n"].as_u64() == Some(x.envelope_number)).and_then(|i| i["c"].as_object().cloned()) {
                            Some(content) => {
                                x.rec.content = Some(content);
                                x.rec.content_state = "ok".into();
                            }
                            None => {
                                x.refused = Some("undecryptable".into());
                                x.message = Some("the body of this message could not be fetched".into());
                            }
                        }
                    }
                }
            }
            let mut alerts = Map::new();
            for x in &commands {
                if c.delivered.get(&x.sender_device_id).copied().unwrap_or(0) < x.sender_sequence {
                    c.delivered.insert(x.sender_device_id.clone(), x.sender_sequence);
                }
                if let Some(r) = &x.refused {
                    alerts.insert(format!("alert/{}", x.envelope_hash), json!({ "code": r, "message": x.message.clone().unwrap_or_default(), "sender_device_id": x.sender_device_id, "envelope_number": x.envelope_number }));
                    let mut ch = Change::default();
                    c.model.push_alert(&mut ch, r, x.message.as_deref().unwrap_or(""), Some(x.envelope_number), Some(&x.sender_device_id), "local");
                    continue;
                }
                let history = c.history_before_number.is_some_and(|b| x.envelope_number <= b) || c.history_before.is_some_and(|b| x.sent_at < b);
                let mut cmd = command_of(&c.model, x);
                cmd.history = history;
                if let Some(u) = &x.unsupported {
                    cmd.command = "unsupported".into();
                    cmd.what = Some(u.clone());
                }
                self.emit(ClientEvent::Command(Box::new(cmd)));
            }
            if !alerts.is_empty() {
                if let Some(me) = self.self_ref.lock().unwrap().upgrade() {
                    tokio::spawn(async move {
                        if let Err(e) = me.set_registers(alerts, None).await {
                            me.emit(ClientEvent::Error(e));
                        }
                    });
                }
            }
            self.reassert_refused_locked(c);
            let s = c.sync_record();
            c.dirty_records.insert("sync".into(), s);
            if !commands.is_empty() {
                let d: Map<String, Value> = c.delivered.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
                if let Err(e) = self.storage.set("delivered", Value::Object(d)) {
                    self.emit(ClientEvent::Error(e));
                }
            }
        })
    }

    /// F15: re-send every own open card whose newest head at the hub is a refused answer (once per card and head).
    pub fn reassert_refused_locked(&self, c: &mut Core) {
        if c.is_human() {
            return;
        }
        let me = self.me();
        for id in c.model.cards_to_reassert(&me) {
            let head = c.model.cards[&id].refused_head.unwrap_or(0);
            if c.reasserted.get(&id) == Some(&head) {
                continue;
            }
            c.reasserted.insert(id.clone(), head);
            let Some(cl) = self.self_ref.lock().unwrap().upgrade() else { continue };
            cl.background.fetch_add(1, Ordering::SeqCst);
            tokio::spawn(async move {
                let r = cl.version(Some(id.clone()), Map::new(), "open", Urg::Head, false, codec::KIND_OBJECT_VERSION, None, None).await;
                if let Err(e) = r {
                    let mut c = cl.core.lock().await;
                    if c.reasserted.get(&id) == Some(&head) {
                        c.reasserted.remove(&id);
                    }
                    drop(c);
                    cl.emit(ClientEvent::Error(e));
                }
                cl.background.fetch_sub(1, Ordering::SeqCst);
            });
        }
    }
    pub async fn reassert_refused(&self) {
        let mut c = self.core.lock().await;
        self.reassert_refused_locked(&mut c);
    }
    /// A human resolved a fork: deliver commands again, the held ones first.
    pub async fn resume_commands(&self) {
        let mut c = self.core.lock().await;
        c.commands_halted = None;
        self.deliver_commands(&mut c, vec![]).await;
    }

    // ---- timelines: lazy, newest first ---------------------------------------------------------------------------

    /// Items of a timeline (stored records { n, h, s, q, r, t, c, cs }), oldest first, bodies fetched as needed.
    pub async fn read_timeline(&self, c: &mut Core, key: &str, before: u64, limit: u64) -> Result<Vec<Value>> {
        if !c.dirty_records.is_empty() {
            self.flush(c)?;
        }
        let prefix = format!("tl/{key}/");
        let mut recs: Vec<Value> = self.storage.range(&prefix, None, Some(&format!("{prefix}{}", pad(before))), Some(limit as usize), true).into_iter().map(|(_, v)| v).collect();
        let missing = recs.iter().any(|r| r["c"].is_null() && !["pruned", "undecryptable", "newer_schema"].contains(&r["cs"].as_str().unwrap_or("")));
        if missing || (recs.len() as u64) < limit {
            let p = model::parse_timeline_key(key);
            let res = self.hub.threads(&p.timeline_kind, &p.timeline_id, Some(before), None, limit).await?;
            c.hub_has_more = res["has_more"].as_bool().unwrap_or(false);
            let mut by_n: std::collections::BTreeMap<u64, Value> = recs.iter().filter_map(|r| Some((r["n"].as_u64()?, r.clone()))).collect();
            let mut writes = vec![];
            for e in res["envelopes"].as_array().cloned().unwrap_or_default() {
                let n = e["envelope_number"].as_u64().unwrap_or(0);
                let Some(r) = by_n.get(&n).cloned().or_else(|| self.storage.get(&format!("{prefix}{}", pad(n)))) else { continue };
                if !r["c"].is_null() {
                    by_n.insert(n, r);
                    continue;
                }
                let mut r = r.as_object().cloned().unwrap_or_default();
                let opened = (|| -> Result<(Option<Map<String, Value>>, String)> {
                    let bytes = unb64u(e["envelope"].as_str().unwrap_or(""))?;
                    let h = unhex(r.get("h").and_then(|v| v.as_str()).unwrap_or(""))?;
                    let secrets = |hd: &crypto::Header| c.open_key(hd);
                    let (hd, _hash, _bind, payload, _) = crypto::open_verified_envelope(&bytes, &c.state, &secrets, &h, Some(&self.device.id))?;
                    Ok(decode_opened(&payload, &hd))
                })();
                match opened {
                    Ok((content, cs)) => {
                        r.insert("c".into(), content.map(Value::Object).unwrap_or(Value::Null));
                        r.insert("cs".into(), json!(cs));
                    }
                    Err(e) => {
                        r.insert("cs".into(), json!(if e.code == "pruned" { "pruned" } else if e.code == "newer-version" { "newer_schema" } else { "undecryptable" }));
                        if e.code == "hash-mismatch" || e.code == "bad-signature" {
                            self.local_alert(c, "timeline", &e);
                        }
                    }
                }
                let v = Value::Object(r);
                by_n.insert(n, v.clone());
                writes.push((format!("{prefix}{}", pad(n)), Some(v)));
            }
            if !writes.is_empty() {
                self.storage.set_many(writes)?;
            }
            let mut all: Vec<Value> = by_n.into_values().collect();
            all.sort_by_key(|r| std::cmp::Reverse(r["n"].as_u64().unwrap_or(0)));
            all.truncate(limit as usize);
            recs = all;
        }
        recs.sort_by_key(|r| r["n"].as_u64().unwrap_or(0));
        Ok(recs)
    }

    // ---- attachments -------------------------------------------------------------------------------------------------

    pub async fn upload_attachment(&self, bytes: Vec<u8>, meta: Map<String, Value>) -> Result<Map<String, Value>> {
        let asset = crypto::encrypt_asset(&bytes, &mut Rng::Os);
        self.hub.put_attachment(&hex(&asset.blob_id), asset.blob.clone()).await?;
        let r = codec::attachment_ref(&asset, &meta);
        let mut c = self.core.lock().await;
        let id = hex(&asset.blob_id);
        c.attachment_cache.push((id, bytes));
        if c.attachment_cache.len() > 64 {
            c.attachment_cache.remove(0);
        }
        Ok(r)
    }
    pub async fn fetch_attachment(&self, r: &Value) -> Result<Vec<u8>> {
        let id = r["attachment_id"].as_str().unwrap_or("").to_string();
        if let Some((_, b)) = self.core.lock().await.attachment_cache.iter().find(|(k, _)| *k == id) {
            return Ok(b.clone());
        }
        let blob = self.hub.get_attachment(&id).await?;
        let bytes = crypto::decrypt_asset(&blob, &unb64u(r["file_key"].as_str().unwrap_or(""))?, Some(&unb64u(r["sha256"].as_str().unwrap_or(""))?))?;
        let mut c = self.core.lock().await;
        if c.attachment_cache.len() > 64 {
            c.attachment_cache.remove(0);
        }
        c.attachment_cache.push((id, bytes.clone()));
        Ok(bytes)
    }
    /// A link for someone outside the room: <app>/a/<share_id>#<secret>.<file_key>.<sha256>.
    pub async fn share_attachment(&self, r: &Value, expires_at: u64) -> Result<(String, String, u64)> {
        let secret = crypto::random_bytes(32);
        let share_id = crypto::random_hex(16);
        let att = r["attachment_id"].as_str().unwrap_or("").to_string();
        let res = self.hub.post_share(&att, json!({ "share_id": share_id, "share_secret_hash": b64u(&crypto::sha256(&[&secret])), "expires_at": expires_at })).await?;
        let link = format!("https://app.trommi.com/a/{share_id}#{}.{}.{}", b64u(&secret), r["file_key"].as_str().unwrap_or(""), r["sha256"].as_str().unwrap_or(""));
        let exp = res["expires_at"].as_u64().unwrap_or(expires_at);
        let mut shares = self.storage.get("shares").and_then(|v| v.as_object().cloned()).unwrap_or_default();
        shares.insert(share_id.clone(), json!({ "attachment_id": att, "expires_at": exp }));
        let now = now_ms();
        shares.retain(|_, x| x["expires_at"].as_u64().unwrap_or(0) >= now);
        self.storage.set("shares", Value::Object(shares))?;
        Ok((share_id, link, exp))
    }
    pub async fn revoke_share(&self, share_id: &str) -> Result<()> {
        let mut shares = self.storage.get("shares").and_then(|v| v.as_object().cloned()).unwrap_or_default();
        let Some(att) = shares.get(share_id).and_then(|x| x["attachment_id"].as_str().map(String::from)) else {
            return Err(ZError::new("not-found", "unknown share: pass its attachment_id"));
        };
        self.hub.delete_share(&att, share_id).await?;
        shares.remove(share_id);
        self.storage.set("shares", Value::Object(shares))
    }
}

/// The newest version of an own object as the agent sees it (local head or model).
#[derive(Clone, Debug)]
pub struct LocalHeadView {
    pub object_version: u64,
    pub version_hash: Option<String>,
    pub content: Map<String, Value>,
    pub object_state: String,
    pub urgency: String,
}
pub fn head_of(c: &Core, object_id: &str) -> Option<LocalHeadView> {
    let local = c.local_heads.get(object_id);
    let card = c.model.cards.get(object_id);
    if let Some(l) = local {
        if card.is_none_or(|k| l.object_version >= k.object_version) {
            return Some(LocalHeadView { object_version: l.object_version, version_hash: Some(l.version_hash.clone()), content: l.content.clone(), object_state: l.object_state.clone(), urgency: l.urgency.clone() });
        }
    }
    if let Some(k) = card {
        let mut content = Map::new();
        content.insert("object_type".into(), json!("card"));
        for f in codec::card_content_fields() {
            content.insert((*f).into(), k.f(f).clone());
        }
        return Some(LocalHeadView { object_version: k.object_version, version_hash: k.version_hash.clone(), content, object_state: k.object_state.clone(), urgency: k.urgency.clone() });
    }
    if let Some(p) = c.model.published.get(object_id) {
        let content = json!({ "object_type": "published", "attachments": p.attachments, "title": p.title, "note": p.note, "released_until": p.released_until });
        return Some(LocalHeadView { object_version: p.object_version, version_hash: Some(p.version_hash.clone()), content: content.as_object().unwrap().clone(), object_state: p.object_state.clone(), urgency: "normal".into() });
    }
    None
}

fn dedupe(list: Vec<PendingCmd>) -> Vec<PendingCmd> {
    let mut seen = std::collections::HashSet::new();
    list.into_iter().filter(|x| seen.insert(x.envelope_hash.clone())).collect()
}

/// The command as client.on('command') hands it out.
pub fn command_of(m: &model::Model, x: &PendingCmd) -> Command {
    let rec = &x.rec;
    let content = rec.content.clone().unwrap_or_default();
    let mut out = Command {
        session_id: x.session_id.clone(), envelope_number: x.envelope_number, envelope_hash: x.envelope_hash.clone(), sender_device_id: x.sender_device_id.clone(),
        sender_sequence: x.sender_sequence, sent_at: x.sent_at, object_id: x.object_id.clone(), timeline_key: x.timeline_key.clone(), content: content.clone(),
        late: x.late, ..Default::default()
    };
    match rec.kind {
        codec::KIND_TIMELINE_ITEM => {
            let ct = content.get("content_type").and_then(|v| v.as_str()).map(String::from);
            let scope = rec.timeline_id.as_deref().and_then(|t| t.strip_prefix("card/")).map(String::from);
            let unsupported = if rec.content_state == "newer_schema" {
                Some("a newer message format".to_string())
            } else if model::content_type_known(&content) {
                None
            } else {
                Some(format!("content_type {}", content.get("content_type").map(model::js_string).unwrap_or_default()))
            };
            out.command = if ct.as_deref() == Some("selection_sent") { "selection_sent".into() } else { "message".into() };
            out.object_id = scope;
            out.unsupported = unsupported;
        }
        codec::KIND_ANSWER => {
            let a = content.get("answer_action");
            let settled = a.and_then(|v| v.as_str()).unwrap_or("answer") == "answer" && rec.object.map(|o| o.object_state) == Some(3);
            if let Some(Value::String(s)) = a {
                if !codec::ANSWER_ACTIONS.contains(&s.as_str()) {
                    out.command = "unsupported".into();
                    out.what = Some(format!("answer_action {s}"));
                    return out;
                }
            }
            if rec.content_state == "newer_schema" {
                out.command = "unsupported".into();
                out.what = Some("a newer answer format".into());
                return out;
            }
            let action = a.and_then(|v| v.as_str()).unwrap_or("");
            out.command = match action {
                "read" => "read".into(),
                "shred" => "shred".into(),
                _ if content.get("trusted").is_some_and(model::truthy) => "trust".into(),
                _ => "answer".into(),
            };
            out.choices = content.get("choices").and_then(|v| v.as_array()).map(|a| a.iter().map(model::js_string).collect()).unwrap_or_default();
            out.settled = settled;
        }
        codec::KIND_DECIDE_AGAIN => {
            out.command = "decide_again".into();
            out.previous_choices = x.previous_choices.clone().unwrap_or_default();
        }
        codec::KIND_VERDICT => {
            out.command = "verdict".into();
            out.allow = rec.bind.as_ref().and_then(|b| b.allow).unwrap_or(false);
        }
        _ => {}
    }
    let _ = m;
    out
}
