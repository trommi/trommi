//! The connector against something that is no hub: a server that answers every route with 404, and one that
//! takes the connection and never answers. Whatever is asked of it meanwhile, the connector stays small and
//! asks seldom: no retry without a pause, nothing queued without a bound.
mod common;

use common::process::Seat;
use common::{HubProc, Human};
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// A hub, a human, and a connector joined to a session; then the hub is gone and its port is free.
async fn joined_then_gone() -> (Seat, u16) {
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
    let ((joined, log), _group) = tokio::join!(join, admit);
    assert!(joined, "the join failed:\n{log}");
    // Once in its room for real, so that it has a session and something to say.
    let mut mcp = seat.serve().await;
    mcp.ready().await;
    mcp.close().await;
    let (_data, port) = hub.stop();
    (seat, port)
}

/// Something that listens where the hub was. `answer`: what it writes to every request; none: nothing, ever.
/// Returns how many connections it took.
async fn stand_in(port: u16, answer: Option<&'static str>) -> Arc<AtomicUsize> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .expect("the hub's port is free again");
    let taken = Arc::new(AtomicUsize::new(0));
    let count = taken.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            count.fetch_add(1, Ordering::SeqCst);
            tokio::spawn(async move {
                let mut seen = Vec::new();
                let mut buffer = [0u8; 4096];
                loop {
                    match socket.read(&mut buffer).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => seen.extend_from_slice(&buffer[..n]),
                    }
                    if !seen.windows(4).any(|w| w == b"\r\n\r\n") {
                        continue;
                    }
                    match answer {
                        Some(answer) => {
                            let _ = socket.write_all(answer.as_bytes()).await;
                            return;
                        }
                        // Holds the connection and says nothing.
                        None => seen.clear(),
                    }
                }
            });
        }
    });
    taken
}

/// The resident memory of a process, in MiB.
fn resident_mib(pid: u32) -> u64 {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).unwrap_or_default();
    status
        .lines()
        .find_map(|line| line.strip_prefix("VmRSS:"))
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|kib| kib.parse::<u64>().ok())
        .map_or(0, |kib| kib / 1024)
}

const NOT_FOUND: &str =
    "HTTP/1.1 404 Not Found\r\ncontent-type: text/html\r\ncontent-length: 9\r\nconnection: close\r\n\r\nNot Found";

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn a_server_that_answers_404_to_everything_is_asked_seldom_and_costs_no_memory() {
    let (seat, port) = joined_then_gone().await;
    let taken = stand_in(port, Some(NOT_FOUND)).await;
    let mut mcp = seat.serve_as_plugin().await;
    let pid = mcp.child.id().expect("the connector runs");
    let started = std::time::Instant::now();
    let mut calls = 0usize;
    let mut said = String::new();
    while started.elapsed() < std::time::Duration::from_secs(12) {
        // The agent keeps working: tool calls, the terminal mirror, the trail.
        let (text, failed) = mcp.call("reply", json!({ "text": "x".repeat(2000) })).await;
        assert!(
            failed,
            "nothing is sent to something that is no hub: {text}"
        );
        said = text;
        seat.hook(
            "trail",
            &json!({ "hook_event_name": "PreToolUse", "session_id": "s", "prompt_id": "p", "tool_name": "Bash", "tool_use_id": format!("t{calls}"), "tool_input": { "command": "true" } }),
        )
        .await;
        calls += 1;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let requests = taken.load(Ordering::SeqCst);
    let memory = resident_mib(pid);
    eprintln!("404: {calls} tool calls, {requests} requests, {memory} MiB; it says: {said}");
    // It asked once, found no hub, said so, and waits a minute before it asks again, whatever is called.
    assert!(
        requests <= 6,
        "{requests} requests for {calls} calls in 12 s"
    );
    assert!(memory < 300, "{memory} MiB");
    assert!(
        said.contains("hub") || said.contains("Trommi"),
        "it says what is wrong: {said}"
    );
    // And quiet when nobody asks: no request for three seconds.
    let before = taken.load(Ordering::SeqCst);
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    assert!(
        taken.load(Ordering::SeqCst) - before <= 2,
        "it keeps asking while nobody calls"
    );
    mcp.close().await;
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn a_server_that_never_answers_is_asked_seldom_and_costs_no_memory() {
    let (seat, port) = joined_then_gone().await;
    let taken = stand_in(port, None).await;
    let mut mcp = seat.serve_as_plugin().await;
    let pid = mcp.child.id().expect("the connector runs");
    let started = std::time::Instant::now();
    let mut calls = 0usize;
    while started.elapsed() < std::time::Duration::from_secs(20) {
        let (text, failed) = mcp.call("reply", json!({ "text": "x".repeat(2000) })).await;
        assert!(
            failed,
            "nothing is sent to something that never answers: {text}"
        );
        calls += 1;
    }
    let requests = taken.load(Ordering::SeqCst);
    let memory = resident_mib(pid);
    eprintln!("silent: {calls} tool calls, {requests} connections, {memory} MiB");
    assert!(
        requests <= calls * 4 + 20,
        "{requests} connections for {calls} calls in 20 s"
    );
    assert!(memory < 300, "{memory} MiB");
    mcp.close().await;
}
