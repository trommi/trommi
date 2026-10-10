//! The connector as Claude Code runs it: the built binary as a child process, spoken to over MCP on its stdio.
use super::TempDir;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

/// A binary of this workspace, built once per test run beside the test's own executable.
pub fn built(package: &str, name: &str) -> PathBuf {
    static BUILT: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
    let exe = std::env::current_exe().expect("the test's path");
    // target/<profile>/deps/<test> → target/<profile>/<name>
    let profile_dir = exe
        .parent()
        .and_then(|p| p.parent())
        .expect("the target directory");
    let mut built = BUILT.lock().unwrap_or_else(|e| e.into_inner());
    if !built.iter().any(|done| done == package) {
        let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
        let mut build = std::process::Command::new(cargo);
        build.args(["build", "--locked", "-p", package]);
        if profile_dir.file_name().is_some_and(|dir| dir == "release") {
            build.arg("--release");
        }
        let status = build
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .status()
            .expect("cargo runs");
        assert!(status.success(), "{package} builds");
        built.push(package.to_string());
    }
    profile_dir.join(name)
}

/// The connector's binary.
pub fn connector_binary() -> PathBuf {
    built("trommi-connector", "trommi-connector")
}

/// The folder, home and state of one Claude Code session in a test.
pub struct Seat {
    pub home: TempDir,
    pub folder: PathBuf,
    pub hub_url: String,
    /// What stands for the Claude Code session: slots are owned by it.
    pub session_key: String,
    /// The runtime directory: short, because the connector's sockets live in it and a socket's path is
    /// bounded.
    run: TempDir,
}

impl Seat {
    pub fn new(hub_url: &str) -> Seat {
        let home = TempDir::new("seat");
        let folder = home.path().join("project");
        std::fs::create_dir_all(&folder).expect("a project folder");
        // Inside the temporary folder, with a short name: a socket's path is bounded (about 104 bytes), and
        // the connector's sockets lie two levels below this.
        let short =
            std::env::temp_dir().join(format!("r{}", trommi_connector::util::random_hex(3)));
        assert!(
            short.as_os_str().len() + 40 <= 103,
            "the temporary folder's path is too long for the connector's sockets ({}): set TMPDIR to a shorter one",
            short.display()
        );
        std::fs::create_dir_all(&short).expect("a runtime directory");
        Seat {
            run: TempDir(short),
            home,
            folder,
            hub_url: hub_url.to_string(),
            session_key: format!("test-{}", trommi_connector::util::random_hex(4)),
        }
    }

    /// A second machine state of the same device: this seat's home copied as it is now (keys, slots, state),
    /// with the same session, without the slot claims of `running` (so the twin does not stop it as the
    /// earlier connector of its session). A process on the seat and one on its twin are one device to the
    /// hub, as a restart whose old process has not ended yet.
    pub fn twin(&self, running: u32) -> Seat {
        let twin = Seat::new(&self.hub_url);
        let copied = std::process::Command::new("cp")
            .arg("-a")
            .arg(format!("{}/.", self.home.path().display()))
            .arg(twin.home.path())
            .status()
            .expect("cp runs");
        assert!(copied.success(), "the home is copied");
        let claim = format!(".{running}");
        let mut dirs = vec![twin.home.path().to_path_buf()];
        while let Some(dir) = dirs.pop() {
            for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    dirs.push(path);
                } else if path.to_string_lossy().ends_with(&claim) {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
        Seat {
            session_key: self.session_key.clone(),
            folder: twin.home.path().join("project"),
            ..twin
        }
    }

    /// The connector's command with this seat's environment and nothing of the machine's.
    pub fn command(&self, args: &[&str]) -> Command {
        self.command_of(&connector_binary(), args)
    }

    /// The same with another copy of the connector's binary.
    pub fn command_of(&self, program: &std::path::Path, args: &[&str]) -> Command {
        let mut command = Command::new(program);
        command
            .args(args)
            .env_clear()
            .env("HOME", self.home.path())
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("XDG_RUNTIME_DIR", self.run.path())
            .env("TMPDIR", self.home.path())
            .env("TROMMI_KEYS_DIR", self.home.path().join("keys"))
            .env("TROMMI_FOLDER", &self.folder)
            .env("TROMMI_HUB", &self.hub_url)
            .env("TROMMI_SESSION_KEY", &self.session_key)
            .env("TROMMI_CHANNEL_EVENTS", "on")
            // the server itself, not its launcher, unless TROMMI_TEST_LAUNCH=1 runs the suites through it
            // (tests/connector/swap.rs starts the launcher in any case)
            .env(
                "TROMMI_LAUNCH",
                std::env::var("TROMMI_TEST_LAUNCH").unwrap_or("0".into()),
            )
            // `say` gives up after half a minute by default; a busy test machine may need longer to go online
            .env("TROMMI_SAY_MS", "120000")
            .current_dir(&self.folder)
            .kill_on_drop(true);
        command
    }

    /// Runs `trommi-connector join <link>` to its end. Returns its exit status and what it wrote to stderr.
    pub async fn join(&self, link: &str) -> (bool, String) {
        let output = self
            .command(&["join", link])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await
            .expect("the join runs");
        (
            output.status.success(),
            format!(
                "{}{}(exit: {:?})\n",
                String::from_utf8_lossy(&output.stderr),
                String::from_utf8_lossy(&output.stdout),
                output.status
            ),
        )
    }

    /// Starts the MCP server.
    pub async fn serve(&self) -> Mcp {
        Mcp::start(self.command(&[])).await
    }

    /// Starts the MCP server as Claude Code does, through the launcher, from `program` (a copy of the binary
    /// that a test may replace).
    pub async fn serve_launched(&self, program: &std::path::Path, env: &[(&str, &str)]) -> Mcp {
        let mut command = self.command_of(program, &[]);
        command.env_remove("TROMMI_LAUNCH");
        for (key, value) in env {
            command.env(key, value);
        }
        Mcp::start(command).await
    }

    /// Starts the MCP server for a host that shows no channel events (a plain MCP client, Codex): board events
    /// wait for the `inbox` tool.
    pub async fn serve_plain(&self) -> Mcp {
        let mut command = self.command(&[]);
        command.env("TROMMI_CHANNEL_EVENTS", "off");
        Mcp::start(command).await
    }
}

/// A running connector, as its MCP client sees it.
pub struct Mcp {
    pub child: Child,
    stdin: ChildStdin,
    lines: tokio::io::Lines<BufReader<ChildStdout>>,
    next_id: u64,
    /// Every notification the server sent, in order: `(method, params)`.
    pub notifications: Vec<(String, Value)>,
}

impl Mcp {
    async fn start(mut command: Command) -> Mcp {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(if std::env::var_os("TROMMI_TEST_LOG").is_some() {
                Stdio::inherit()
            } else {
                Stdio::null()
            })
            .spawn()
            .expect("the connector starts");
        let stdin = child.stdin.take().expect("its stdin");
        let lines = BufReader::new(child.stdout.take().expect("its stdout")).lines();
        let mut mcp = Mcp {
            child,
            stdin,
            lines,
            next_id: 1,
            notifications: Vec::new(),
        };
        let hello = mcp
            .request(
                "initialize",
                json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "test", "version": "0" } }),
            )
            .await;
        assert_eq!(hello["serverInfo"]["name"], "trommi", "{hello}");
        mcp.send(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            .await;
        mcp
    }

    pub async fn send(&mut self, message: &Value) {
        self.stdin
            .write_all(format!("{message}\n").as_bytes())
            .await
            .expect("the connector reads");
        self.stdin.flush().await.expect("flushed");
    }

    /// One line from the server, or none within `ms`.
    pub async fn read(&mut self, ms: u64) -> Option<Value> {
        let line =
            tokio::time::timeout(std::time::Duration::from_millis(ms), self.lines.next_line())
                .await
                .ok()?
                .expect("the connector's stdout")?;
        Some(serde_json::from_str(&line).expect("one JSON message per line"))
    }

    /// A request and its result; notifications that come meanwhile are kept.
    pub async fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .await;
        loop {
            let message = self.read(60_000).await.expect("an answer in time");
            if message.get("id").and_then(Value::as_u64) == Some(id) {
                assert!(message.get("error").is_none(), "{method}: {message}");
                return message["result"].clone();
            }
            self.keep(message);
        }
    }

    fn keep(&mut self, message: Value) {
        if let Some(method) = message.get("method").and_then(Value::as_str) {
            self.notifications
                .push((method.to_string(), message["params"].clone()));
        }
    }

    /// Sends a notification, as Claude Code does for a permission prompt.
    pub async fn notify(&mut self, method: &str, params: Value) {
        self.send(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
            .await;
    }

    /// Waits for a notification of this method; returns its params.
    pub async fn notification(&mut self, method: &str) -> Value {
        for _ in 0..900 {
            if let Some(at) = self.notifications.iter().position(|(m, _)| m == method) {
                return self.notifications.remove(at).1;
            }
            if let Some(message) = self.read(100).await {
                self.keep(message);
            }
        }
        panic!("no {method}; got {:?}", self.notifications);
    }

    /// Calls a tool: `(its text, whether it is an error)`.
    pub async fn call(&mut self, name: &str, arguments: Value) -> (String, bool) {
        let result = self
            .request(
                "tools/call",
                json!({ "name": name, "arguments": arguments }),
            )
            .await;
        let text = result["content"][0]["text"]
            .as_str()
            .unwrap_or("")
            .to_string();
        (text, result["isError"] == json!(true))
    }

    /// Calls a tool that must succeed; returns its text.
    pub async fn ok(&mut self, name: &str, arguments: Value) -> String {
        let (text, failed) = self.call(name, arguments).await;
        assert!(!failed, "{name} failed: {text}");
        text
    }

    /// Waits for a channel event whose meta has `kind`; returns its params.
    pub async fn event(&mut self, kind: &str) -> Value {
        let found = |list: &mut Vec<(String, Value)>| {
            let at = list.iter().position(|(method, params)| {
                method == "notifications/claude/channel" && params["meta"]["kind"] == kind
            })?;
            Some(list.remove(at).1)
        };
        for _ in 0..900 {
            if let Some(params) = found(&mut self.notifications) {
                return params;
            }
            if let Some(message) = self.read(100).await {
                self.keep(message);
            }
        }
        panic!("no {kind} event; got {:?}", self.notifications);
    }

    /// Waits until the connector is in its room: a tool call no longer says it is not.
    pub async fn ready(&mut self) {
        for _ in 0..450 {
            let (text, failed) = self.call("list_cards", json!({})).await;
            if !failed {
                return;
            }
            let _ = text;
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        panic!("the connector never got into its room");
    }

    /// Ends the server as Claude Code does: its stdin closes.
    pub async fn close(mut self) {
        drop(self.stdin);
        let _ = tokio::time::timeout(std::time::Duration::from_secs(10), self.child.wait()).await;
    }
}

impl Seat {
    /// Runs one of the plugin's hooks (`prompt`, `stop`, `trail`, `permission`, …) with `input` on its stdin, as
    /// Claude Code does, and returns what it printed.
    pub async fn hook(&self, kind: &str, input: &Value) -> String {
        let mut child = self
            .command(&[kind])
            .env("CLAUDE_PLUGIN_ROOT", self.home.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("the hook starts");
        let mut stdin = child.stdin.take().expect("its stdin");
        stdin
            .write_all(input.to_string().as_bytes())
            .await
            .expect("the hook reads");
        drop(stdin);
        let output =
            tokio::time::timeout(std::time::Duration::from_secs(60), child.wait_with_output())
                .await
                .expect("the hook ends in time")
                .expect("the hook ran");
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    /// Starts the MCP server as the plugin does: with the terminal mirror's hooks at work.
    pub async fn serve_as_plugin(&self) -> Mcp {
        let mut command = self.command(&[]);
        command.env("CLAUDE_PLUGIN_ROOT", self.home.path());
        Mcp::start(command).await
    }
}
