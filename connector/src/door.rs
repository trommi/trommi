//! The slot's door (a Unix socket of the process that holds a keyed slot: `say`, the hooks, yielding),
//! the bell of a Claude Code process, and the monitor's socket. One JSON line in, one JSON line out.
use crate::client::BoxFut;
use crate::slots::{uid, SlotPaths};
use crate::util::{hex, sha256};
use serde_json::{json, Value};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

/// $XDG_RUNTIME_DIR (or the temp dir)/trommi-<uid>, 0700, this user's own.
pub fn door_dir() -> std::io::Result<PathBuf> {
    let base = std::env::var("XDG_RUNTIME_DIR")
        .ok()
        .filter(|x| !x.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let dir = base.join(format!("trommi-{}", uid()));
    std::fs::create_dir_all(&dir)?;
    let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    let st = std::fs::symlink_metadata(&dir)?;
    if !st.is_dir() || st.uid() != uid() || st.mode() & 0o077 != 0 {
        return Err(std::io::Error::other(format!(
            "{} is not a private directory of this user",
            dir.display()
        )));
    }
    Ok(dir)
}
pub fn door_of(p: &SlotPaths) -> std::io::Result<PathBuf> {
    let resolved = absolute(&p.key_file);
    Ok(door_dir()?.join(format!(
        "{}.sock",
        &hex(&sha256(resolved.display().to_string().as_bytes()))[..20]
    )))
}
pub fn absolute(p: &Path) -> PathBuf {
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(p)
    }
}

/// The handler of a door: (request, gone) -> answer. `gone` resolves when the caller hung up before the answer.
pub type Handler = Arc<dyn Fn(Value, Gone) -> BoxFut<'static, Value> + Send + Sync>;
#[derive(Clone)]
pub struct Gone(
    pub Arc<tokio::sync::Notify>,
    pub Arc<std::sync::atomic::AtomicBool>,
);
impl Gone {
    pub fn never() -> Gone {
        Gone(
            Arc::new(tokio::sync::Notify::new()),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
        )
    }
    pub async fn wait(&self) {
        loop {
            let n = self.0.notified();
            if self.1.load(std::sync::atomic::Ordering::SeqCst) {
                return;
            }
            n.await;
        }
    }
}

fn mark(file: &Path) -> Option<String> {
    let st = std::fs::metadata(file).ok()?;
    Some(format!(
        "{}/{}",
        st.ino(),
        st.ctime_nsec() as i64 + st.ctime() * 1_000_000_000
    ))
}

/// A listening door; closing it removes the socket file only if it is still this door's own.
pub struct Door {
    file: PathBuf,
    ino: Mutex<Option<String>>,
    task: tokio::task::JoinHandle<()>,
}
impl Door {
    pub fn close(&self) {
        self.task.abort();
        let own = self
            .ino
            .lock()
            .unwrap()
            .clone()
            .is_some_and(|i| mark(&self.file).as_deref() == Some(&i));
        if own {
            let _ = std::fs::remove_file(&self.file);
        }
    }
}
impl Drop for Door {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub fn open_door(p: &SlotPaths, handler: Handler) -> std::io::Result<Door> {
    open_door_at(&door_of(p)?, handler)
}
pub fn open_door_at(file: &Path, handler: Handler) -> std::io::Result<Door> {
    let _ = std::fs::remove_file(file);
    let listener = UnixListener::bind(file)?;
    let _ = std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600));
    let ino = mark(file);
    let task = tokio::spawn(async move {
        loop {
            let Ok((sock, _)) = listener.accept().await else {
                continue;
            };
            let h = handler.clone();
            tokio::spawn(async move { serve(sock, h).await });
        }
    });
    Ok(Door {
        file: file.to_path_buf(),
        ino: Mutex::new(ino),
        task,
    })
}
async fn serve(sock: UnixStream, handler: Handler) {
    let (rd, mut wr) = sock.into_split();
    let mut reader = BufReader::new(rd);
    let mut line = String::new();
    let mut total = 0usize;
    loop {
        let mut buf = vec![];
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) => return,
            Ok(n) => {
                total += n;
                line.push_str(&String::from_utf8_lossy(&buf));
                if total > 64 * 1024 {
                    return;
                }
                if line.ends_with('\n') {
                    break;
                }
            }
            Err(_) => return,
        }
    }
    let req: Value = match serde_json::from_str(line.trim_end_matches('\n')) {
        Ok(v) => v,
        Err(e) => {
            let _ = wr
                .write_all(
                    format!("{}\n", json!({ "ok": false, "error": e.to_string() })).as_bytes(),
                )
                .await;
            let _ = wr.shutdown().await;
            return;
        }
    };
    let gone = Gone::never();
    let g2 = gone.clone();
    let watcher = tokio::spawn(async move {
        let mut r = reader;
        let mut b = [0u8; 64];
        loop {
            match r.read(&mut b).await {
                Ok(0) | Err(_) => {
                    g2.1.store(true, std::sync::atomic::Ordering::SeqCst);
                    g2.0.notify_waiters();
                    return;
                }
                Ok(_) => {}
            }
        }
    });
    let answer = handler(req, gone).await;
    watcher.abort();
    let _ = wr.write_all(format!("{answer}\n").as_bytes()).await;
    let _ = wr.shutdown().await;
}

/// Knock at a door: the holder's answer, or an error (no door, no answer within timeout_ms).
pub async fn knock_at(file: &Path, request: &Value, timeout_ms: u64) -> Result<Value, String> {
    let fut = async {
        let mut sock = UnixStream::connect(file).await.map_err(|e| e.to_string())?;
        sock.write_all(format!("{request}\n").as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        let mut buf = String::new();
        sock.read_to_string(&mut buf)
            .await
            .map_err(|e| e.to_string())?;
        serde_json::from_str::<Value>(buf.trim())
            .map_err(|_| "the connector holding the key gave no answer".to_string())
    };
    match tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), fut).await {
        Ok(r) => r,
        Err(_) => Err("the connector holding the key did not answer".into()),
    }
}
pub async fn knock(p: &SlotPaths, request: &Value, timeout_ms: u64) -> Result<Value, String> {
    let f = door_of(p).map_err(|e| e.to_string())?;
    knock_at(&f, request, timeout_ms).await
}

/// The socket of one Claude Code process: <runtime dir>/trommi-<uid>/mon-<pid>.sock.
pub fn socket_path(claude_pid: u32) -> PathBuf {
    // The same private directory as the door's (owned by this user, mode 0700, no link): where that cannot be
    // had, a path that cannot exist, so that nothing listens or connects in a directory of someone else's.
    door_dir()
        .unwrap_or_else(|_| PathBuf::from("/nonexistent/trommi"))
        .join(format!("mon-{claude_pid}.sock"))
}
pub fn bell_path(claude_pid: u32) -> PathBuf {
    socket_path(claude_pid)
        .parent()
        .unwrap()
        .join(format!("bell-{claude_pid}.sock"))
}
/// A hook's ring at the connector of its own Claude Code process, if one runs.
pub async fn ring(pids: &[u32], timeout_ms: u64) -> Option<Value> {
    for p in pids {
        let f = bell_path(*p);
        if !f.exists() {
            continue;
        }
        return knock_at(&f, &json!({ "op": "awake", "ancestors": pids }), timeout_ms)
            .await
            .ok();
    }
    None
}

// ---- the monitor ----------------------------------------------------------------------------------------------

/// The connector's end: listens on the socket of its Claude Code process and writes its lines (line.rs) to every monitor.
pub struct MonitorFeed {
    pub file: PathBuf,
    clients: Arc<Mutex<Vec<tokio::net::unix::OwnedWriteHalf>>>,
    ino: Option<String>,
    task: Option<tokio::task::JoinHandle<()>>,
    count: Arc<std::sync::atomic::AtomicUsize>,
}
impl MonitorFeed {
    pub fn new(claude_pid: u32) -> MonitorFeed {
        let file = socket_path(claude_pid);
        let clients: Arc<Mutex<Vec<tokio::net::unix::OwnedWriteHalf>>> =
            Arc::new(Mutex::new(vec![]));
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut task = None;
        let mut ino = None;
        let res = (|| -> std::io::Result<()> {
            std::fs::create_dir_all(file.parent().unwrap())?;
            std::fs::set_permissions(
                file.parent().unwrap(),
                std::fs::Permissions::from_mode(0o700),
            )?;
            let _ = std::fs::remove_file(&file);
            let listener = UnixListener::bind(&file)?;
            ino = mark(&file);
            let cl = clients.clone();
            let cnt = count.clone();
            task = Some(tokio::spawn(async move {
                loop {
                    let Ok((sock, _)) = listener.accept().await else {
                        continue;
                    };
                    let (mut rd, wr) = sock.into_split();
                    cl.lock().unwrap().push(wr);
                    cnt.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let cnt2 = cnt.clone();
                    tokio::spawn(async move {
                        let mut b = [0u8; 256];
                        while let Ok(n) = rd.read(&mut b).await {
                            if n == 0 {
                                break;
                            }
                        }
                        cnt2.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                    });
                }
            }));
            Ok(())
        })();
        if let Err(e) = res {
            eprintln!("[trommi] monitor socket not opened: {e}");
        }
        MonitorFeed {
            file,
            clients,
            ino,
            task,
            count,
        }
    }
    pub fn connected(&self) -> bool {
        self.count.load(std::sync::atomic::Ordering::SeqCst) > 0
    }
    pub fn push(&self, line: &str) {
        let one = regex::Regex::new(r"[\r\n]+")
            .unwrap()
            .replace_all(line, " ")
            .to_string()
            + "\n";
        let mut cl = self.clients.lock().unwrap();
        let mut keep = vec![];
        for w in cl.drain(..) {
            if w.try_write(one.as_bytes()).is_ok() {
                keep.push(w);
            }
        }
        *cl = keep;
    }
    fn own(&self) -> bool {
        self.ino.is_some() && mark(&self.file) == self.ino
    }
    pub fn close(&self) {
        self.clients.lock().unwrap().clear();
        if self.own() {
            if let Some(t) = &self.task {
                t.abort();
            }
            let _ = std::fs::remove_file(&self.file);
        }
    }
}

/// The monitor's end (`trommi-connector monitor`): prints each line of the connector of its Claude Code process.
pub async fn run_monitor() {
    let pid: u32 = std::env::var("CLAUDE_PID")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|p| *p > 0)
        .unwrap_or_else(crate::slots::ppid);
    let file = socket_path(pid);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(5000)).await;
            if !crate::slots::alive(pid) {
                std::process::exit(0);
            }
        }
    });
    let mut out = tokio::io::stdout();
    loop {
        if !crate::slots::alive(pid) {
            std::process::exit(0);
        }
        if let Ok(sock) = UnixStream::connect(&file).await {
            let mut lines = BufReader::new(sock).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.starts_with(crate::line::HEAD) {
                    let _ = out.write_all(format!("{line}\n").as_bytes()).await;
                    let _ = out.flush().await;
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
    }
}
