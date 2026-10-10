//! The launcher swaps in a new connector in the middle of an MCP session, without a reconnect: requests before
//! and after work, a tool call in flight across the swap gets exactly one answer (from the old connector), the
//! client is told that the tools changed, and the key's lease is never held by two processes.
mod common;

use common::process::{connector_binary, Seat};
use common::{HubProc, Human};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// The processes whose parent is `pid`.
fn children_of(pid: u32) -> Vec<u32> {
    let out = std::process::Command::new("ps")
        .args(["-o", "pid=", "--ppid", &pid.to_string()])
        .output()
        .expect("ps runs");
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .filter_map(|pid| pid.parse().ok())
        .collect()
}

fn alive(pid: u32) -> bool {
    std::path::Path::new(&format!("/proc/{pid}")).exists()
}

/// The slot claims under `dir` held by live processes: `<lock file>.<pid>`.
fn live_claims(dir: &std::path::Path) -> Vec<u32> {
    let mut found = Vec::new();
    let mut dirs = vec![dir.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                dirs.push(path);
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(pid) = name
                .rsplit_once('.')
                .and_then(|(base, pid)| base.ends_with(".lock").then_some(pid))
                .and_then(|pid| pid.parse::<u32>().ok())
            {
                if alive(pid) {
                    found.push(pid);
                }
            }
        }
    }
    found
}

/// "… (version <hash>)" in the answer of reload_connector.
fn version_in(text: &str) -> String {
    text.rsplit_once("version ")
        .map(|(_, rest)| rest.trim_end_matches(['.', ')']).to_string())
        .unwrap_or_default()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_launcher_swaps_in_a_new_connector_mid_session() {
    let hub = HubProc::start().await;
    let mut human = Human::found(&hub.url).await;
    let seat = Seat::new(&hub.url);
    let mut invite = human.invite(None).await;
    let link = invite.link.clone();
    let join = seat.join(&link);
    let admit = async {
        let admitted = human.admit(&mut invite).await;
        human.found_session(&admitted).await
    };
    let ((joined, log), group) = tokio::join!(join, admit);
    assert!(joined, "the join failed:\n{log}");

    // The connector as installed: a copy the test replaces later.
    let bin = seat.home.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let program = bin.join("trommi-connector");
    let original = std::fs::read(connector_binary()).expect("the built connector");
    std::fs::write(&program, &original).unwrap();
    std::fs::set_permissions(
        &program,
        std::os::unix::fs::PermissionsExt::from_mode(0o755),
    )
    .unwrap();

    let mut mcp = seat
        .serve_launched(
            &program,
            &[
                ("TROMMI_UPDATE_POLL_MS", "1000"),
                ("TROMMI_TEST_SLOW_RELOAD_MS", "5000"),
            ],
        )
        .await;
    mcp.ready().await;
    let launcher = mcp.child.id().expect("the launcher runs");
    let first = children_of(launcher);
    assert_eq!(
        first.len(),
        1,
        "one connector under the launcher: {first:?}"
    );
    let old = first[0];
    let keys = seat.home.path().join("keys");
    assert_eq!(
        live_claims(&keys),
        vec![old],
        "the old connector holds the slot"
    );

    // A request before the swap.
    let (said, failed) = mcp.call("reload_connector", json!({})).await;
    assert!(!failed && said.contains("is current"), "{said}");
    let old_version = version_in(&said);
    assert!(!old_version.is_empty(), "{said}");

    // A tool call that is open while the new binary is put in place (as `update` does: a rename).
    mcp.send(&json!({ "jsonrpc": "2.0", "id": 9001, "method": "tools/call", "params": { "name": "reload_connector", "arguments": {} } }))
        .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mut changed = original.clone();
    changed.extend_from_slice(b"\nanother build");
    let new_file = bin.join(".new.trommi-connector");
    std::fs::write(&new_file, &changed).unwrap();
    std::fs::set_permissions(
        &new_file,
        std::os::unix::fs::PermissionsExt::from_mode(0o755),
    )
    .unwrap();
    std::fs::rename(&new_file, &program).unwrap();
    // While the swap waits for the open call, more requests come: they are held and answered after it.
    tokio::time::sleep(Duration::from_millis(3000)).await;
    mcp.send(&json!({ "jsonrpc": "2.0", "id": 9002, "method": "ping" }))
        .await;
    mcp.send(&json!({ "jsonrpc": "2.0", "id": 9003, "method": "tools/list", "params": {} }))
        .await;

    // Every answer and notification until the swap is done, and a little longer.
    let mut answers: HashMap<u64, Vec<Value>> = HashMap::new();
    let mut list_changed = 0;
    let until = Instant::now() + Duration::from_secs(60);
    let mut done_at: Option<Instant> = None;
    while Instant::now() < until && done_at.is_none_or(|at| at.elapsed() < Duration::from_secs(3)) {
        let Some(message) = mcp.read(200).await else {
            continue;
        };
        if let Some(id) = message.get("id").and_then(Value::as_u64) {
            answers.entry(id).or_default().push(message);
        } else if message["method"] == "notifications/tools/list_changed" {
            list_changed += 1;
        }
        if done_at.is_none()
            && list_changed > 0
            && [9001, 9002, 9003].iter().all(|id| answers.contains_key(id))
        {
            done_at = Some(Instant::now());
        }
    }
    for id in [9001, 9002, 9003] {
        assert_eq!(
            answers.get(&id).map(Vec::len),
            Some(1),
            "request {id} has exactly one answer: {answers:?}"
        );
    }
    assert_eq!(
        list_changed, 1,
        "the client is told once that the tools changed"
    );
    let in_flight = answers[&9001][0]["result"]["content"][0]["text"]
        .as_str()
        .unwrap_or("")
        .to_string();
    assert!(
        in_flight.contains("swapped in") && in_flight.contains(&old_version),
        "the open call was answered by the old connector: {in_flight}"
    );
    assert!(
        answers[&9003][0]["result"]["tools"].is_array(),
        "{answers:?}"
    );

    // The old process is gone, one new one runs, and only it holds the slot.
    let now = children_of(launcher);
    assert_eq!(now.len(), 1, "one connector under the launcher: {now:?}");
    let new = now[0];
    assert_ne!(new, old, "a new process");
    assert!(!alive(old), "the old connector ended");

    // Requests after the swap: the new connector, in the room (lease and stream), the same session.
    let (said, failed) = mcp.call("reload_connector", json!({})).await;
    assert!(!failed && said.contains("is current"), "{said}");
    assert_ne!(
        version_in(&said),
        old_version,
        "the new binary runs: {said}"
    );
    mcp.ready().await;
    assert_eq!(
        live_claims(&keys),
        vec![new],
        "only the new connector holds the slot"
    );
    human
        .say(
            &group,
            json!({ "content_type": "message", "text": "Heard after the swap." }),
        )
        .await
        .expect("the human writes");
    let heard = mcp.event("chat").await;
    assert!(
        heard.to_string().contains("Heard after the swap."),
        "{heard}"
    );
    let sent = mcp
        .ok("reply", json!({ "text": "Answered after the swap." }))
        .await;
    assert!(sent.starts_with("sent"), "{sent}");
    assert_eq!(
        children_of(launcher),
        vec![new],
        "no second swap, no lease fight"
    );
    mcp.close().await;
}
