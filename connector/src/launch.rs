//! The launcher: what Claude Code or Codex starts (`trommi-connector` without arguments). It owns the MCP
//! session's stdin and stdout and runs the real connector (`trommi-connector serve`) as its child, passing the
//! JSON-RPC lines through unchanged in both directions. So a new connector can take over without the client
//! noticing ("hot swap"), with no /mcp → Reconnect:
//!
//! 1. The child sees a new binary at its path (`server.rs`, which also downloads releases) and asks for the swap
//!    with the private notification [`SWAP`]. Only a binary of the same launcher ABI ([`ABI`]) is swapped in;
//!    for another one the child files today's card (reconnect by hand).
//! 2. Draining: the client's new messages are held back in order; the requests the old child is answering are
//!    awaited (each gets exactly one answer, from the child that took it). If they take longer than
//!    [`DRAIN_MS`], the swap is called off, the held messages go to the old child and it is tried again later.
//! 3. The old child is told [`STOP`] (it hands its key back without a last report and exits) and awaited: the
//!    key's lease and slot are never held by two processes at once.
//! 4. The new child starts, is given the client's `initialize` again (under a private id, its answer is kept
//!    back) and `notifications/initialized`; the held messages follow in their order, and the client is told
//!    `notifications/tools/list_changed`.
//!
//! The launcher is kept small and almost never changes; a change of what it and the child agree on raises
//! [`ABI`], and an update across that falls back to the card.
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::mpsc;

/// What a launcher and its child agree on: these names, the environment below, the order of a swap.
pub const ABI: u32 = 1;
/// Child → launcher: a new binary stands at the path; swap it in.
pub const SWAP: &str = "trommi/launch/swap";
/// Launcher → child: hand over and exit.
pub const STOP: &str = "trommi/launch/stop";
/// The environment a child is started with: the launcher's ABI, and the pid of the process that started the
/// launcher (Claude Code), which the child counts as its parent.
pub const ENV_ABI: &str = "TROMMI_LAUNCH_ABI";
pub const ENV_PARENT: &str = "TROMMI_PARENT_PID";
/// How long the old child's open requests are awaited before a swap is called off.
const DRAIN_MS: u64 = 60_000;
/// After a swap that was called off, the next try.
const RETRY_MS: u64 = 30_000;
/// How long an old child may take to exit, and a new one to answer `initialize`.
const STOP_MS: u64 = 10_000;
const START_MS: u64 = 30_000;

/// Whether this process runs as a launcher's child.
pub fn launched() -> bool {
    std::env::var(ENV_ABI).is_ok_and(|abi| !abi.is_empty())
}

/// Whether the launcher this child runs under can swap in the binary at `path`: that binary's ABI is this one's.
pub fn swappable(path: &std::path::Path) -> bool {
    if std::env::var(ENV_ABI).ok().as_deref() != Some(ABI.to_string().as_str()) {
        return false;
    }
    std::process::Command::new(path)
        .arg("launch-abi")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .filter(|out| out.status.success())
        .is_some_and(|out| String::from_utf8_lossy(&out.stdout).trim() == ABI.to_string())
}

enum Event {
    Client(Option<String>),
    Child(u64, Option<String>),
}

struct Kid {
    generation: u64,
    process: Child,
    stdin: Option<ChildStdin>,
}

enum Phase {
    Normal,
    Draining { until: Instant },
    Starting { until: Instant, init_id: String },
}

struct Launcher {
    program: PathBuf,
    parent: u32,
    events: mpsc::UnboundedSender<Event>,
    out: tokio::io::Stdout,
    kid: Kid,
    next_generation: u64,
    phase: Phase,
    /// The client's `initialize` request, and whether it said `notifications/initialized`.
    init: Option<Value>,
    initialized: bool,
    /// The client's requests in flight: id → the child generation that took it.
    pending: HashMap<String, u64>,
    held: VecDeque<String>,
    wanted: bool,
    retry_at: Option<Instant>,
}

fn key(id: &Value) -> String {
    id.to_string()
}

/// Starts the connector at `program` as a launcher's child of this generation; its lines become events.
fn spawn(
    program: &std::path::Path,
    parent: u32,
    events: &mpsc::UnboundedSender<Event>,
    generation: u64,
) -> std::io::Result<Kid> {
    let mut process = Command::new(program)
        .arg("serve")
        .env(ENV_ABI, ABI.to_string())
        .env(ENV_PARENT, parent.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()?;
    let stdin = process.stdin.take();
    if let Some(stdout) = process.stdout.take() {
        let events = events.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = events.send(Event::Child(generation, Some(line)));
            }
            let _ = events.send(Event::Child(generation, None));
        });
    }
    Ok(Kid {
        generation,
        process,
        stdin,
    })
}

impl Launcher {
    fn spawn(&mut self) -> std::io::Result<Kid> {
        self.next_generation += 1;
        spawn(
            &self.program,
            self.parent,
            &self.events,
            self.next_generation,
        )
    }

    async fn send_client(&mut self, line: &str) {
        let mut bytes = line.as_bytes().to_vec();
        bytes.push(b'\n');
        if self.out.write_all(&bytes).await.is_err() || self.out.flush().await.is_err() {
            self.end(0).await;
        }
    }

    async fn send_kid(&mut self, line: &str) {
        let parsed = serde_json::from_str::<Value>(line).ok();
        if let Some(msg) = &parsed {
            if msg.get("method").is_some() {
                if let Some(id) = msg.get("id").filter(|id| !id.is_null()) {
                    self.pending.insert(key(id), self.kid.generation);
                }
            }
        }
        if let Some(stdin) = self.kid.stdin.as_mut() {
            let mut bytes = line.as_bytes().to_vec();
            bytes.push(b'\n');
            let _ = stdin.write_all(&bytes).await;
            let _ = stdin.flush().await;
        }
    }

    fn open_requests(&self) -> bool {
        self.pending.values().any(|g| *g == self.kid.generation)
    }

    async fn on_client(&mut self, line: String) {
        if line.trim().is_empty() {
            return;
        }
        if let Ok(msg) = serde_json::from_str::<Value>(line.trim_end_matches('\r')) {
            match msg.get("method").and_then(Value::as_str) {
                Some("initialize") if msg.get("id").is_some() => self.init = Some(msg.clone()),
                Some("notifications/initialized") => self.initialized = true,
                _ => {}
            }
        }
        match self.phase {
            Phase::Normal => self.send_kid(&line).await,
            _ => self.held.push_back(line),
        }
    }

    async fn on_kid(&mut self, generation: u64, line: String) {
        let msg = serde_json::from_str::<Value>(&line).ok();
        let method = msg
            .as_ref()
            .and_then(|m| m.get("method"))
            .and_then(Value::as_str);
        if method == Some(SWAP) {
            if generation == self.kid.generation {
                self.wanted = true;
                self.retry_at = None;
                self.try_swap().await;
            }
            return;
        }
        let id = msg
            .as_ref()
            .and_then(|m| m.get("id"))
            .filter(|_| method.is_none());
        if let (Phase::Starting { init_id, .. }, Some(id)) = (&self.phase, id) {
            if generation == self.kid.generation && key(id) == *init_id {
                return self.started().await;
            }
        }
        if let Some(id) = id {
            self.pending.remove(&key(id));
        }
        self.send_client(&line).await;
        if matches!(self.phase, Phase::Draining { .. }) && !self.open_requests() {
            self.stop_old().await;
        }
    }

    /// Begins a swap when one is wanted and the session is set up.
    async fn try_swap(&mut self) {
        if !self.wanted || !matches!(self.phase, Phase::Normal) || !self.initialized {
            return;
        }
        if self.init.is_none() {
            return;
        }
        if matches!(
            crate::update::verify_file(&self.program),
            crate::update::Release::Refused(_)
        ) {
            eprintln!("[trommi] launcher: the binary at the connector's path is refused; no swap");
            self.wanted = false;
            return;
        }
        eprintln!("[trommi] launcher: swapping in the new connector");
        self.phase = Phase::Draining {
            until: Instant::now() + Duration::from_millis(DRAIN_MS),
        };
        if !self.open_requests() {
            self.stop_old().await;
        }
    }

    /// The old child has no open request: it is stopped and awaited, then the new one is started.
    async fn stop_old(&mut self) {
        let stop = json!({ "jsonrpc": "2.0", "method": STOP }).to_string();
        if let Some(mut stdin) = self.kid.stdin.take() {
            let _ = stdin.write_all(format!("{stop}\n").as_bytes()).await;
            let _ = stdin.flush().await;
        }
        let exited =
            tokio::time::timeout(Duration::from_millis(STOP_MS), self.kid.process.wait()).await;
        if exited.is_err() {
            let _ = self.kid.process.kill().await;
        }
        // Whatever the old child still wrote before it exited goes out first (its stdout ends with it).
        self.pending.retain(|_, g| *g != self.kid.generation);
        let kid = match self.spawn() {
            Ok(kid) => kid,
            Err(error) => {
                eprintln!("[trommi] launcher: the new connector does not start: {error}");
                return self.end(1).await;
            }
        };
        self.kid = kid;
        let init_id = format!("trommi-launch-{}", self.kid.generation);
        let mut init = self.init.clone().unwrap_or(Value::Null);
        init["id"] = json!(init_id);
        self.phase = Phase::Starting {
            until: Instant::now() + Duration::from_millis(START_MS),
            init_id: key(&init["id"]),
        };
        let line = init.to_string();
        if let Some(stdin) = self.kid.stdin.as_mut() {
            let _ = stdin.write_all(format!("{line}\n").as_bytes()).await;
            let _ = stdin.flush().await;
        }
    }

    /// The new child answered `initialize`: it is told `initialized`, gets what was held, and the client learns
    /// that the tools may have changed.
    async fn started(&mut self) {
        self.phase = Phase::Normal;
        self.wanted = false;
        self.send_kid(
            &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }).to_string(),
        )
        .await;
        while let Some(line) = self.held.pop_front() {
            self.send_kid(&line).await;
        }
        let changed =
            json!({ "jsonrpc": "2.0", "method": "notifications/tools/list_changed" }).to_string();
        self.send_client(&changed).await;
        eprintln!("[trommi] launcher: the new connector runs");
    }

    async fn tick(&mut self) {
        let now = Instant::now();
        match &self.phase {
            Phase::Draining { until } if now >= *until => {
                eprintln!(
                    "[trommi] launcher: open requests took too long; the swap is tried again later"
                );
                self.phase = Phase::Normal;
                while let Some(line) = self.held.pop_front() {
                    self.send_kid(&line).await;
                }
                self.retry_at = Some(now + Duration::from_millis(RETRY_MS));
            }
            Phase::Starting { until, .. } if now >= *until => {
                eprintln!("[trommi] launcher: the new connector did not answer initialize");
                self.end(1).await;
            }
            Phase::Normal if self.retry_at.is_some_and(|at| now >= at) => {
                self.retry_at = None;
                self.try_swap().await;
            }
            _ => {}
        }
    }

    /// The session ends: the child's stdin closes, it gets a moment to say goodbye, then this process exits.
    async fn end(&mut self, code: i32) {
        self.kid.stdin = None;
        if tokio::time::timeout(Duration::from_millis(STOP_MS), self.kid.process.wait())
            .await
            .is_err()
        {
            let _ = self.kid.process.kill().await;
        }
        std::process::exit(code);
    }

    async fn signalled(&mut self, signal: rustix::process::Signal) {
        if let Some(pid) = self
            .kid
            .process
            .id()
            .and_then(|pid| i32::try_from(pid).ok())
            .and_then(rustix::process::Pid::from_raw)
        {
            let _ = rustix::process::kill_process(pid, signal);
        }
        self.end(0).await;
    }
}

/// `trommi-connector` without arguments: the launcher.
pub async fn main_launcher() -> i32 {
    use tokio::signal::unix::{signal, SignalKind};
    let (events, mut inbox) = mpsc::unbounded_channel();
    let client = events.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(tokio::io::stdin()).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = client.send(Event::Client(Some(line)));
        }
        let _ = client.send(Event::Client(None));
    });
    let program = crate::server::self_path();
    let parent = std::os::unix::process::parent_id();
    let kid = match spawn(&program, parent, &events, 1) {
        Ok(kid) => kid,
        Err(error) => {
            eprintln!("[trommi] launcher: the connector does not start: {error}");
            return 1;
        }
    };
    let mut launcher = Launcher {
        program,
        parent,
        events,
        out: tokio::io::stdout(),
        kid,
        next_generation: 1,
        phase: Phase::Normal,
        init: None,
        initialized: false,
        pending: HashMap::new(),
        held: VecDeque::new(),
        wanted: false,
        retry_at: None,
    };
    let (Ok(mut term), Ok(mut int), Ok(mut hup)) = (
        signal(SignalKind::terminate()),
        signal(SignalKind::interrupt()),
        signal(SignalKind::hangup()),
    ) else {
        return 1;
    };
    let mut ticks = tokio::time::interval(Duration::from_millis(500));
    use rustix::process::Signal;
    loop {
        tokio::select! {
            event = inbox.recv() => match event {
                Some(Event::Client(Some(line))) => launcher.on_client(line).await,
                Some(Event::Client(None)) | None => launcher.end(0).await,
                Some(Event::Child(generation, Some(line))) => launcher.on_kid(generation, line).await,
                Some(Event::Child(generation, None)) => {
                    // The running child ended by itself: the session ends with it, as it did without a launcher.
                    if generation == launcher.kid.generation {
                        let code = launcher.kid.process.wait().await.ok().and_then(|s| s.code()).unwrap_or(0);
                        std::process::exit(code);
                    }
                }
            },
            _ = term.recv() => launcher.signalled(Signal::TERM).await,
            _ = int.recv() => launcher.signalled(Signal::INT).await,
            _ = hup.recv() => launcher.signalled(Signal::HUP).await,
            _ = ticks.tick() => launcher.tick().await,
        }
    }
}
