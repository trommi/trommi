//! The interop driver (dev/interop/protocol.mjs): one agent device of the Rust core, JSON lines on stdin/stdout.
//!
//!   trommi-connector driver --home <dir>
//!
//! driver -> {"ready": true, "impl": "rust", "driver_protocol": 1}; runner -> {"id", "cmd", "args"}; driver ->
//! {"id", "ok": true, "result"} | {"id", "ok": false, "error": {"code", "message"}}. A command it does not have
//! answers `unsupported` (the human commands: this core is an agent's).
use crate::client::{Client, ClientEvent, Command};
use crate::codec;
use crate::crypto::{self, b64u, hex, unb64u};
use crate::error::{Result, ZError};
use crate::model::{self, js_string};
use crate::room;
use crate::storage::FileStorage;
use serde_json::{json, Map, Value};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub const DRIVER_PROTOCOL: u64 = 1;
const COMMANDS: [&str; 18] = ["version_info", "join", "join_wait", "whoami", "sync", "set_live", "members", "sessions", "list_cards", "card", "chat_send", "chat_list", "check_envelope", "alerts", "agent_card", "agent_revise", "close_card", "withdraw_card"];
const MORE: [&str; 2] = ["agent_inbox", "agent_newer"];

struct D {
    home: std::path::PathBuf,
    client: Option<Arc<Client>>,
    joining: Option<tokio::task::JoinHandle<Result<room::Opened>>>,
    inbox: Arc<Mutex<Vec<Command>>>,
}

fn fail<T>(code: &str, msg: &str) -> Result<T> {
    Err(ZError::new(code, msg))
}

pub async fn run(home: std::path::PathBuf) -> Result<()> {
    let mut out = tokio::io::stdout();
    out.write_all(format!("{}\n", json!({ "ready": true, "impl": "rust", "driver_protocol": DRIVER_PROTOCOL })).as_bytes()).await?;
    out.flush().await?;
    let mut d = D { home, client: None, joining: None, inbox: Arc::new(Mutex::new(vec![])) };
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let req: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => {
                out.write_all(format!("{}\n", json!({ "id": null, "ok": false, "error": { "code": "bad-request", "message": "not a command line" } })).as_bytes()).await?;
                continue;
            }
        };
        let id = req["id"].clone();
        let cmd = req["cmd"].as_str().unwrap_or("").to_string();
        let args = req["args"].as_object().cloned().unwrap_or_default();
        let r = d.call(&cmd, args).await;
        let line = match r {
            Ok(v) => json!({ "id": id, "ok": true, "result": v }),
            Err(e) => json!({ "id": id, "ok": false, "error": { "code": if e.code.is_empty() { "internal".into() } else { e.code.clone() }, "message": e.text(), "status": e.status } }),
        };
        out.write_all(format!("{line}\n").as_bytes()).await?;
        out.flush().await?;
    }
    if let Some(c) = &d.client {
        c.stop().await;
    }
    Ok(())
}

fn card_json(c: &model::Card, stack: &[String]) -> Value {
    let options: Vec<Value> = c.options().iter().map(|o| match o {
        Value::String(s) => json!({ "key": s, "label": s, "final": false }),
        o => json!({ "key": o.get("key").cloned().unwrap_or(Value::Null), "label": o.get("label").filter(|v| !v.is_null()).cloned().or_else(|| o.get("key").cloned()).unwrap_or(Value::Null), "final": o.get("final") == Some(&Value::Bool(true)) }),
    }).collect();
    json!({
        "id": c.object_id, "title": c.f("title").as_str().unwrap_or(""), "card_type": c.f("card_type").as_str().unwrap_or("decision"), "state": c.object_state,
        "closed_how": c.closed_how, "urgency": c.urgency, "session_id": c.session_id, "agent_device_id": c.agent_device_id, "options": options,
        "choices": c.answer.as_ref().map(|a| a.choices.clone()).unwrap_or_default(), "multiple": c.f("allows_multiple") == &Value::Bool(true),
        "unsupported": c.unsupported.is_some(), "version": c.object_version, "teaser": c.f("teaser").clone(),
        "sections": c.f("sections").as_array().map(|a| a.len()).unwrap_or(0), "has_html": !c.f("html").is_null(), "attachments": c.attachments().len(),
        "has_picture": c.attachments().iter().any(|a| a.get("media_type").map(js_string).unwrap_or_default().starts_with("image/")),
        "recommended": c.recommended_list(), "urgency_reason": c.f("urgency_reason").clone(), "close_summary": c.f("close_summary").clone(),
        "in_stack": stack.contains(&c.object_id),
    })
}

impl D {
    fn need(&self) -> Result<Arc<Client>> {
        self.client.clone().ok_or_else(|| ZError::new("no-room", "join or log in first"))
    }
    async fn adopt(&mut self, opened: room::Opened) -> Result<Arc<Client>> {
        let (c, mut rx) = opened;
        let inbox = self.inbox.clone();
        tokio::spawn(async move {
            while let Some(e) = rx.recv().await {
                if let ClientEvent::Command(cmd) = e {
                    inbox.lock().unwrap().push(*cmd);
                }
            }
        });
        c.start(true, None).await?;
        c.when_session().await;
        self.client = Some(c.clone());
        Ok(c)
    }
    async fn settle(&self) -> Result<()> {
        let c = self.need()?;
        c.settle(15_000).await
    }
    async fn card_of(&self, id: &str) -> Result<String> {
        let c = self.need()?;
        let core = c.core.lock().await;
        if core.model.cards.contains_key(id) {
            return Ok(id.into());
        }
        core.model.cards.keys().find(|k| k.starts_with(id)).cloned().ok_or_else(|| ZError::new("not-found", format!("no card {id}")))
    }

    async fn call(&mut self, cmd: &str, a: Map<String, Value>) -> Result<Value> {
        match cmd {
            "version_info" => {
                let hub = match &self.client {
                    Some(c) => c.hub.version().await.ok(),
                    None => None,
                };
                let mut commands: Vec<&str> = COMMANDS.to_vec();
                commands.extend(MORE);
                let mut ct = codec::CONTENT_TYPES.to_vec();
                ct.sort();
                let mut ot = codec::OBJECT_TYPES.to_vec();
                ot.sort();
                let mut cards = codec::CARD_TYPES.to_vec();
                cards.sort();
                let mut aa = codec::ANSWER_ACTIONS.to_vec();
                aa.sort();
                Ok(json!({
                    "impl": "rust", "driver_protocol": DRIVER_PROTOCOL, "client": "connector", "protocol_version": 1, "schema_version": codec::SCHEMA_VERSION,
                    "commands": commands, "roles": ["agent"],
                    "known": { "content_types": ct, "object_types": ot, "card_types": cards, "answer_actions": aa, "envelope_kinds": [1, 2, 3, 4, 5, 6, 7], "timeline_kinds": [1, 2] },
                    "hub": hub,
                }))
            }
            "join" => {
                let link = a.get("link").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let name = a.get("name").and_then(|v| v.as_str()).unwrap_or("Rust device").to_string();
                std::fs::create_dir_all(&self.home)?;
                let storage = Arc::new(FileStorage::open(&self.home, Some(&self.home.join("device.key")), "")?);
                let (tx, rx) = tokio::sync::oneshot::channel::<String>();
                let tx = Arc::new(Mutex::new(Some(tx)));
                let info = json!({ "device_name": name, "platform": "rust" });
                let h = tokio::spawn(async move {
                    room::join_room(&link, storage, info, Some(crate::CLIENT.into()), false, 50, 15 * 60_000, move |code| {
                        if let Some(t) = tx.lock().unwrap().take() {
                            let _ = t.send(code);
                        }
                    }).await
                });
                self.joining = Some(h);
                match rx.await {
                    Ok(code) => Ok(json!({ "check_code": code })),
                    Err(_) => {
                        let h = self.joining.take().unwrap();
                        match h.await {
                            Ok(Err(e)) => Err(e),
                            _ => fail("internal", "the join ended without a check code"),
                        }
                    }
                }
            }
            "join_wait" => {
                let Some(h) = self.joining.take() else { return fail("bad-argument", "no join running") };
                let opened = h.await.map_err(|e| ZError::new("internal", e.to_string()))??;
                let c = self.adopt(opened).await?;
                let room = c.core.lock().await.model.room.room_id.clone();
                Ok(json!({ "device_id": c.me(), "room_id": room }))
            }
            "whoami" => {
                let c = self.need()?;
                let core = c.core.lock().await;
                Ok(json!({ "device_id": c.me(), "room_id": core.model.room.room_id, "role": core.model.room.my_role, "live": core.model.room.connection == "live", "key_epoch": core.model.room.key_epoch }))
            }
            "sync" => {
                self.need()?.catch_up().await?;
                Ok(json!({}))
            }
            "set_live" => Ok(json!({})),
            "members" => {
                let c = self.need()?;
                let core = c.core.lock().await;
                Ok(Value::Array(core.model.members.values().map(|m| json!({ "device_id": m.device_id, "role": m.device_role, "active": m.is_active, "name": m.device_name })).collect()))
            }
            "sessions" => {
                let c = self.need()?;
                let core = c.core.lock().await;
                Ok(Value::Array(core.model.sessions.values().map(|s| json!({ "session_id": s.session_id, "agent_device_ids": s.agent_device_ids, "active": s.is_active, "name": s.settings.as_ref().and_then(|x| x.get("name")).cloned().unwrap_or(Value::Null) })).collect()))
            }
            "list_cards" => {
                let all = a.get("all").and_then(|v| v.as_bool()).unwrap_or(false);
                let c = self.need()?;
                let core = c.core.lock().await;
                Ok(Value::Array(core.model.cards.values().filter(|k| all || k.object_state == "open").map(|k| card_json(k, &core.model.stack)).collect()))
            }
            "card" => {
                let id = self.card_of(a.get("card").and_then(|v| v.as_str()).unwrap_or("")).await?;
                let c = self.need()?;
                let core = c.core.lock().await;
                Ok(card_json(&core.model.cards[&id], &core.model.stack))
            }
            "chat_send" => {
                let c = self.need()?;
                let card = match a.get("card").and_then(|v| v.as_str()) {
                    Some(k) => Some(self.card_of(k).await?),
                    None => None,
                };
                let mut f = Map::new();
                f.insert("text".into(), a.get("text").cloned().unwrap_or(json!("")));
                c.send_message(f, card, None).await?;
                self.settle().await?;
                Ok(json!({}))
            }
            "chat_list" => {
                let c = self.need()?;
                let key = match (a.get("card").and_then(|v| v.as_str()), a.get("session").and_then(|v| v.as_str())) {
                    (Some(k), _) => format!("chat:card/{k}"),
                    (None, Some(s)) => format!("chat:session/{s}"),
                    (None, None) => format!("chat:session/{}", c.core.lock().await.session_id().unwrap_or_default()),
                };
                let mut core = c.core.lock().await;
                let before = core.model.room.last_envelope_number + 1;
                let items = c.read_timeline(&mut core, &key, before, 500).await?;
                Ok(Value::Array(items.iter().map(|i| {
                    let content = i["c"].as_object();
                    let role = core.model.members.get(i["s"].as_str().unwrap_or("")).map(|m| m.device_role.clone()).unwrap_or_else(|| "unknown".into());
                    json!({ "from": role, "text": content.and_then(|c| c.get("text")).cloned().unwrap_or(Value::Null), "content_type": content.and_then(|c| c.get("content_type")).cloned().unwrap_or(Value::Null),
                        "state": model::item_state_of(content, i["cs"].as_str().unwrap_or("")), "envelope_number": i["n"] })
                }).collect()))
            }
            "check_envelope" => {
                let c = self.need()?;
                let bytes = unb64u(a.get("envelope").and_then(|v| v.as_str()).unwrap_or(""))?;
                let core = c.core.lock().await;
                let mut chains = core.chains.clone();
                let opts = crypto::VerifyOpts { allow_chain_start: true, allow_removed_sender: true, commit: false, freshness: None, strict_kinds: false };
                let secrets = |h: &crypto::Header| core.open_key(h);
                match crypto::open_envelope(&bytes, &core.state, &mut chains, &secrets, Some(&c.device.id), &opts, true) {
                    Ok(o) => Ok(json!({ "ok": true, "code": null, "content_state": if o.quarantined.is_some() { "undecryptable" } else { "ok" } })),
                    Err(e) if e.code != "no-key" => Ok(json!({ "ok": false, "code": e.code })),
                    Err(_) => match crypto::verify_envelope(&bytes, &core.state, &mut chains, &opts) {
                        Ok(_) => Ok(json!({ "ok": true, "code": null, "content_state": "undecryptable" })),
                        Err(e) => Ok(json!({ "ok": false, "code": e.code })),
                    },
                }
            }
            "alerts" => {
                let c = self.need()?;
                let core = c.core.lock().await;
                Ok(Value::Array(core.model.alerts.iter().map(|x| json!({ "code": x.code, "envelope_number": x.envelope_number })).collect()))
            }
            "agent_card" => {
                let c = self.need()?;
                let newer = a.get("newer_schema").is_some_and(model::truthy);
                let mut f = a.clone();
                f.remove("newer_schema");
                if newer {
                    c.newer.lock().unwrap().card = true;
                }
                let r = c.send_card(f, None).await;
                c.newer.lock().unwrap().card = false;
                let id = r?;
                self.settle().await?;
                Ok(json!({ "id": id }))
            }
            "agent_revise" => {
                let id = self.card_of(a.get("card").and_then(|v| v.as_str()).unwrap_or("")).await?;
                let mut f = a.clone();
                f.remove("card");
                let urgency = f.remove("urgency").and_then(|v| v.as_str().map(String::from));
                self.need()?.revise(&id, f, urgency).await?;
                self.settle().await?;
                Ok(json!({}))
            }
            "close_card" => {
                let id = self.card_of(a.get("card").and_then(|v| v.as_str()).unwrap_or("")).await?;
                self.need()?.close(&id, a.get("summary").and_then(|v| v.as_str()).unwrap_or("")).await?;
                self.settle().await?;
                Ok(json!({}))
            }
            "withdraw_card" => {
                let id = self.card_of(a.get("card").and_then(|v| v.as_str()).unwrap_or("")).await?;
                self.need()?.withdraw(&id, a.get("reason").and_then(|v| v.as_str()).unwrap_or("")).await?;
                self.settle().await?;
                Ok(json!({}))
            }
            "agent_inbox" => Ok(Value::Array(self.inbox.lock().unwrap().iter().map(|x| json!({
                "command": x.command, "object_id": x.object_id, "choices": if x.command == "answer" || x.command == "trust" || x.command == "read" || x.command == "shred" { json!(x.choices) } else { Value::Null },
                "text": x.content.get("text").cloned().unwrap_or(Value::Null), "sender_device_id": x.sender_device_id, "unsupported": x.unsupported.clone().or(x.what.clone()),
            })).collect())),
            "agent_newer" => {
                let c = self.need()?;
                let on = a.get("on").map(model::truthy).unwrap_or(true);
                let mut n = c.newer.lock().unwrap();
                match a.get("kind").and_then(|v| v.as_str()) {
                    Some("message") => n.message = on,
                    Some("answer") => n.answer = on,
                    Some("card") => n.card = on,
                    _ => {}
                }
                Ok(json!({}))
            }
            _ => {
                let _ = (b64u(&[]), hex(&[]));
                fail("unsupported", &format!("the Rust driver has no command {cmd}"))
            }
        }
    }
}
