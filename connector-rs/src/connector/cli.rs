//! The commands beside the MCP server: join, say, the plugin's hooks, the monitor, the witness, whoami.
use super::door::{knock, ring};
use super::hooks::{hook_output, hook_request};
use super::member::{self, connector_config, paths_of, resolve_room, slots_in, Member};
use super::slots::*;
use super::{say_with, env_ms};
use crate::bridge::{About, Bridge};
use crate::client::BoxFut;
use crate::crypto::{self, unhex};
use crate::error::{Result, ZError};
use crate::model::now_ms;
use crate::storage::FileStorage;
use serde_json::{json, Value};
use std::sync::Arc;

/// `join <link>`: join a room with an agent invite link (or TROMMI_INVITE), then exit.
pub async fn join(given: Option<String>) -> Result<String> {
    let link = given.or_else(|| member::env("TROMMI_INVITE")).ok_or_else(|| ZError::plain("usage: trommi-connector join <invite link>  (or TROMMI_INVITE=<link> ... join)"))?;
    let m = Member::new(connector_config(None, true));
    eprintln!("[trommi] joining; confirm this session in the Trommi app");
    let replace_held = std::env::var("TROMMI_JOIN_OTHER").as_deref() != Ok("1");
    if let Err(e) = m.join(&link, replace_held, true).await {
        m.stop().await;
        let spent = ["invite-expired", "invite-used", "invite-burned", "invite-contested", "bad-invite"].contains(&e.code.as_str());
        return Err(ZError::plain(format!("not joined: {}{}", e.text(), if spent { " (an invite link works once and for a limited time: make a new one in the app)" } else { "" })));
    }
    let c = m.client().unwrap();
    let (room, sid) = {
        let core = c.core.lock().await;
        (core.model.room.room_id.clone(), core.session_id())
    };
    let sid = sid.or_else(|| m.me.lock().unwrap().session.as_ref().and_then(|s| s["agent_session_id"].as_str().map(String::from))).unwrap_or_else(|| "undefined".into());
    let kf = m.paths().map(|p| p.key_file.display().to_string()).unwrap_or_default();
    let out = format!("joined room {room} as device {}, session {sid}; key file {kf}", c.me());
    m.stop().await;
    Ok(out)
}

fn not_in_room(phase: &str) -> String {
    match phase {
        "waiting-session" => "the agent is not assigned to a session yet (the human does that in the Trommi app)".into(),
        "needs-invite" => "no free key of this folder".into(),
        p => format!("not in the room ({p})"),
    }
}

/// `say`: the emergency side channel, never a second writer on a key.
#[allow(unused_assignments)] // (as sayCli: a door's error is kept until the own try replaces it)
pub async fn say(argv: &[String]) -> Result<String> {
    let mut urgent = false;
    let mut session: Option<String> = None;
    let mut words = vec![];
    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            "--urgent" => urgent = true,
            "--session" => {
                i += 1;
                session = argv.get(i).cloned();
            }
            w => words.push(w.to_string()),
        }
        i += 1;
    }
    let text = crate::codec::js_trim(&words.join(" ")).to_string();
    if text.is_empty() {
        return Err(ZError::plain("usage: trommi-connector say \"<text>\" [--session <name>] [--urgent]"));
    }
    let mut cfg = connector_config(None, true);
    cfg.invite = String::new();
    cfg.session = format!("say:{}", pid());
    let Some(room_id) = resolve_room(&cfg)? else { return Err(ZError::plain(format!("this folder ({}) has no Trommi key: it is not in a room", cfg.shown))) };
    let until = now_ms() + env_ms("TROMMI_SAY_MS", 30_000).max(1);
    let request = json!({ "op": "say", "text": text, "session": session, "urgent": urgent });
    let mut last: Option<ZError>;
    loop {
        let mut silent = vec![];
        for n in slots_in(&cfg, &cfg.keys_dir.join(&room_id)) {
            let p = paths_of(&cfg, &room_id, n);
            let holders = holders_of(&p);
            if holders.is_empty() {
                continue;
            }
            match knock(&p, &request, until.saturating_sub(now_ms()).max(1000)).await {
                Ok(r) if r["ok"] == Value::Bool(true) => return Ok(format!("said through the running connector (pid {}): {}", holders.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(", "), crate::model::js_string(&r["said"]))),
                Ok(r) => last = Some(ZError::plain(crate::model::js_string(&r["error"]))),
                Err(e) => {
                    silent.extend(holders);
                    last = Some(ZError::plain(e));
                }
            }
        }
        let m = Member::new(cfg.clone());
        let res: Result<String> = async {
            let left = until.saturating_sub(now_ms()).max(1000);
            let m2 = m.clone();
            let h = tokio::spawn(async move { m2.open(false).await });
            let _ = tokio::time::timeout(std::time::Duration::from_millis(left), h).await;
            if m.phase() == "ready" {
                let (client, storage, cache) = {
                    let me = m.me.lock().unwrap();
                    (me.client.clone().unwrap(), me.storage.clone().unwrap(), me.paths.clone().unwrap().cache)
                };
                let state = storage.get("channel").and_then(|v| v.as_object().cloned()).unwrap_or_default();
                let st2 = storage.clone();
                let notify: crate::bridge::Notify = Arc::new(|_: String, _: Value, _: Option<About>| -> BoxFut<'static, ()> { Box::pin(async {}) });
                let b = Bridge::new(client.clone(), notify, cache, state, Arc::new(move |v| { let _ = st2.set("channel", v); }));
                let said = say_with(b, request.clone()).await?;
                client.settle(until.saturating_sub(now_ms()).max(5000)).await?;
                return Ok(format!("said as this folder's agent (slot {}): {said}", m.paths().map(|p| p.slot).unwrap_or(0)));
            }
            let p = m.paths();
            if p.as_ref().is_some_and(|p| !p.has_key) && !silent.is_empty() {
                let list = silent.iter().map(|x| format!("pid {x}")).collect::<Vec<_>>().join(", ");
                let kill = silent.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(" ");
                return Err(ZError::plain(format!("the key is held by connector process {list}, which does not answer (an older connector without the side channel, or a hung one). It is never overridden (two writers on one key break its chain): run `kill {kill}`, then say again")));
            }
            let e = m.me.lock().unwrap().error.clone();
            Err(ZError::plain(e.unwrap_or_else(|| not_in_room(&m.phase()))))
        }
        .await;
        m.stop().await;
        match res {
            Ok(s) => return Ok(s),
            Err(e) => last = Some(e),
        }
        if now_ms() >= until {
            return Err(last.unwrap_or_else(|| ZError::plain("not said")));
        }
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
    }
}

/// The plugin's hooks: reads the hook's JSON on stdin, asks the running connector of this Claude Code session.
pub async fn hook(kind: &str) -> String {
    let mut text = String::new();
    let _ = tokio::io::AsyncReadExt::read_to_string(&mut tokio::io::stdin(), &mut text).await;
    let input: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let Some(request) = hook_request(kind, &input) else { return String::new() };
    let folder = member::env("TROMMI_FOLDER").or_else(|| member::env("CLAUDE_PROJECT_DIR")).or_else(|| input.get("cwd").and_then(|v| v.as_str()).filter(|x| !x.is_empty()).map(String::from));
    let mut cfg = connector_config(folder, false);
    cfg.invite = String::new();
    let Ok(Some(room_id)) = resolve_room(&cfg) else { return String::new() };
    let pids: Vec<u32> = request["ancestors"].as_array().map(|a| a.iter().filter_map(|x| x.as_u64().map(|v| v as u32)).collect()).unwrap_or_default();
    ring(&pids, 15_000).await;
    let wait = request.get("wait_ms").and_then(|v| v.as_u64()).unwrap_or(0);
    for n in slots_in(&cfg, &cfg.keys_dir.join(&room_id)) {
        let p = paths_of(&cfg, &room_id, n);
        if holders_of(&p).is_empty() {
            continue;
        }
        match knock(&p, &request, wait + 15_000).await {
            Ok(a) if a["ok"] == Value::Bool(true) => return hook_output(kind, &a),
            Ok(a) => eprintln!("[trommi] hook {kind}: slot {n}: {}", crate::model::js_string(&a["error"])),
            Err(e) => eprintln!("[trommi] hook {kind}: slot {n}: {e}"),
        }
    }
    String::new()
}

/// "Cut off", said once in the name of a key nobody holds (the folder watch).
pub async fn last_word(cfg: &member::Cfg, room_id: &str, t: &Value) -> bool {
    let Some(slot) = t.get("slot").and_then(|v| v.as_u64()) else { return false };
    let p = paths_of(cfg, room_id, slot as u32);
    if !p.key_file.exists() || !lock_slot(&p, &format!("witness:{}", pid())) {
        return false;
    }
    let r: Result<()> = async {
        let storage = FileStorage::open(&p.dir, Some(&p.key_file), &p.prefix)?;
        let (Some(room), Some(device)) = (storage.get("room"), storage.load_device()?) else { return Err(ZError::plain("no room")) };
        let rid = unhex(room_id)?;
        let hub_url = room["hub_url"].as_str().unwrap_or("").to_string();
        let slot_url = Arc::new(std::sync::Mutex::new(String::new()));
        let su = slot_url.clone();
        let signer: crate::transport::Signer = Arc::new(move |ch: &[u8]| crypto::sign_hub_auth(&device, &rid, &su.lock().unwrap(), ch));
        let hub = crate::transport::Hub::new(&hub_url, Some(room_id.to_string()), Some(crate::CLIENT.into()), Some(signer))?;
        *slot_url.lock().unwrap() = hub.hub_url.clone();
        let lease = hub.agent_lease(&format!("witness-{}", crypto::random_hex(6)), false).await?;
        hub.set_lease_generation(lease["lease_generation"].as_u64());
        let why = t.get("why").and_then(|v| v.as_str()).filter(|w| regex::Regex::new(r"^[a-z0-9-]{1,40}$").unwrap().is_match(w)).unwrap_or("stdin");
        let mut report = json!({ "hears": "live" }).as_object().unwrap().clone();
        if let Some(l) = t.get("link").and_then(|l| l.as_object()) {
            for (k, v) in l {
                report.insert(k.clone(), v.clone());
            }
        }
        report.insert("cut_since".into(), Value::Null);
        report.insert("exit".into(), json!({ "reason": why, "claude": "alive" }));
        hub.agent_link_last(Value::Object(report), 8000).await?;
        let mut mark = t.as_object().cloned().unwrap_or_default();
        let file = mark.remove("file").and_then(|f| f.as_str().map(String::from)).unwrap_or_default();
        mark.insert("told".into(), json!(true));
        let _ = write_private(std::path::Path::new(&file), &Value::Object(mark).to_string());
        eprintln!("[trommi] said for the session of Claude Code pid {}: cut off (its connector, pid {}, is gone)", t["claude_pid"], t["pid"]);
        Ok(())
    }
    .await;
    unlock_slot(&p);
    match r {
        Ok(()) => true,
        Err(e) => {
            eprintln!("[trommi] cut off not said: {}", e.text());
            false
        }
    }
}

/// `witness <session>`: waits out the grace; if the session is then cut off and nobody holds its key, says so.
pub async fn witness(session: Option<String>) {
    let mut cfg = connector_config(None, false);
    cfg.invite = String::new();
    let (Ok(Some(room_id)), Some(session)) = (resolve_room(&cfg), session) else { return };
    let dir = cfg.keys_dir.join(&room_id);
    let grace = env_ms("TROMMI_CUT_GRACE_MS", 20_000);
    let idle = env_ms("TROMMI_IDLE_MS", 1_800_000);
    let until = now_ms() + grace + 60_000;
    loop {
        let w = folder_watch(&dir, &cfg.base, now_ms(), grace, idle);
        let in_cut = w.cut.iter().find(|m| crate::model::js_string(&m["session"]) == session).cloned();
        let in_pending = w.pending.iter().any(|m| crate::model::js_string(&m["session"]) == session);
        match in_cut {
            Some(t) => {
                if t.get("slot").is_some_and(|s| !s.is_null()) && !t.get("told").is_some_and(crate::model::truthy) {
                    last_word(&cfg, &room_id, &t).await;
                }
                return;
            }
            None if !in_pending => return,
            None => {}
        }
        if now_ms() > until {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis((grace / 4).clamp(50, 1000))).await;
    }
}

/// `whoami`: room, key file and folder.
pub fn whoami() -> Result<String> {
    let cfg = connector_config(None, true);
    let room = resolve_room(&cfg)?;
    let p = room.as_ref().map(|r| paths_of(&cfg, r, 1));
    Ok(serde_json::to_string_pretty(&json!({
        "room_id": room, "key_file": p.as_ref().map(|p| p.key_file.display().to_string()), "has_key": p.as_ref().is_some_and(|p| p.key_file.exists()),
        "folder": cfg.shown, "host": cfg.host,
    })).unwrap())
}

/// Dispatch a command line; Some(exit code) when it was one of the commands.
pub async fn run(argv: &[String]) -> i32 {
    let cmd = argv.first().map(|s| s.as_str()).unwrap_or("");
    let given = argv.get(1).cloned();
    match cmd {
        "join" => match join(given).await {
            Ok(s) => {
                println!("{s}");
                0
            }
            Err(e) => {
                eprintln!("[trommi] {}", e.text());
                1
            }
        },
        "say" => match say(&argv[1..]).await {
            Ok(s) => {
                println!("{s}");
                0
            }
            Err(e) => {
                eprintln!("[trommi] {}", e.text());
                1
            }
        },
        "permission" | "notice" | "denied" | "resolved" => {
            let out = hook(cmd).await;
            if !out.is_empty() {
                println!("{out}");
            }
            0
        }
        "monitor" => {
            super::door::run_monitor().await;
            0
        }
        "witness" => {
            witness(given).await;
            0
        }
        "whoami" => match whoami() {
            Ok(s) => {
                println!("{s}");
                0
            }
            Err(e) => {
                eprintln!("[trommi] {}", e.text());
                1
            }
        },
        "driver" => {
            let home = argv.iter().position(|a| a == "--home").and_then(|i| argv.get(i + 1)).map(std::path::PathBuf::from).unwrap_or_else(|| std::env::temp_dir().join("trommi-driver"));
            match crate::driver::run(home).await {
                Ok(()) => 0,
                Err(e) => {
                    eprintln!("[trommi] driver: {}", e.text());
                    1
                }
            }
        }
        "--version" | "version" => {
            println!("trommi-connector {} ({}, {})", super::SERVER_VERSION, crate::CLIENT, super::disk_version());
            0
        }
        other => {
            eprintln!("[trommi] unknown command {other}; use join <link>, say \"<text>\" [--session <name>] [--urgent] or whoami, or no argument for the MCP server");
            1
        }
    }
}
