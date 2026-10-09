//! The lock (one process per key), who gets the key (presence, yielding), the folder watch, and which
//! slot is whose. The files: `<keys>/<room>/<base>-<slot>.key` (a marker; the state is in `<base>-<slot>.state/`), `.lock.<pid>`, `.owner`, `.out`,
//! `<base>.here.<pid>`, `<base>.gone.<hash>`, `replaced-<time>-<name>.*`.
use crate::util::now_ms;
use crate::util::{hex, sha256};
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

pub fn pid() -> u32 {
    std::process::id()
}
pub fn ppid() -> u32 {
    std::os::unix::process::parent_id()
}
pub fn uid() -> u32 {
    rustix::process::getuid().as_raw()
}
/// Whether a process with this id exists (also one of another user, which may not be signalled).
pub fn alive(pid: u32) -> bool {
    let Some(pid) = i32::try_from(pid)
        .ok()
        .and_then(rustix::process::Pid::from_raw)
    else {
        return false;
    };
    match rustix::process::test_kill_process(pid) {
        Ok(()) => true,
        Err(error) => error == rustix::io::Errno::PERM,
    }
}
pub fn sigterm(pid: u32) {
    if let Some(pid) = i32::try_from(pid)
        .ok()
        .and_then(rustix::process::Pid::from_raw)
    {
        let _ = rustix::process::kill_process(pid, rustix::process::Signal::TERM);
    }
}
fn pause_ms(ms: u64) {
    std::thread::sleep(std::time::Duration::from_millis(ms));
}
pub fn rand_u64(max: u64) -> u64 {
    crate::util::rand_below(max)
}
pub fn write_private(file: &Path, text: &str) -> std::io::Result<()> {
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(file)?;
    f.write_all(text.as_bytes())
}
pub fn read_json(file: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(file).ok()?).ok()
}

/// The paths of one key slot.
#[derive(Clone, Debug, Default)]
pub struct SlotPaths {
    pub dir: PathBuf,
    pub slot: u32,
    pub key_file: PathBuf,
    pub lock_file: PathBuf,
    pub prefix: String,
    pub cache: PathBuf,
    pub has_key: bool,
    pub busy: Vec<u32>,
    pub holders: Vec<u32>,
    pub took_over: bool,
    pub handed_over: bool,
    pub refused: Option<Refused>,
}
#[derive(Clone, Debug, Default)]
pub struct Refused {
    pub slot: u32,
    pub pids: Vec<u32>,
    pub silent: bool,
    pub used: bool,
    pub quiet_ms: u64,
    pub after_ms: u64,
}

// ---- the lock ----------------------------------------------------------------------------------------------------

fn claims_of(p: &SlotPaths) -> Vec<u32> {
    let base = format!("{}.", p.lock_file.file_name().unwrap().to_string_lossy());
    let Ok(rd) = fs::read_dir(&p.dir) else {
        return vec![];
    };
    rd.filter_map(|e| e.ok())
        .filter_map(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            let rest = n.strip_prefix(&base)?;
            if !rest.is_empty() && rest.bytes().all(|c| c.is_ascii_digit()) {
                rest.parse().ok()
            } else {
                None
            }
        })
        .collect()
}
fn claim_file(p: &SlotPaths, pid: u32) -> PathBuf {
    PathBuf::from(format!("{}.{pid}", p.lock_file.display()))
}
pub fn session_of(p: &SlotPaths, pid: u32) -> String {
    fs::read_to_string(claim_file(p, pid))
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}
/// The command line of a process.
pub fn args_of(pid: u32) -> Vec<String> {
    if let Ok(t) = fs::read(format!("/proc/{pid}/cmdline")) {
        return t
            .split(|b| *b == 0)
            .map(|x| String::from_utf8_lossy(x).to_string())
            .collect();
    }
    std::process::Command::new("ps")
        .args(["-o", "args=", "-p", &pid.to_string()])
        .output()
        .ok()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .split_whitespace()
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}
/// A Trommi connector: this binary.
pub fn is_connector(pid: u32) -> bool {
    args_of(pid).iter().take(3).any(|a| {
        let b = Path::new(a)
            .file_name()
            .map(|x| x.to_string_lossy().to_string())
            .unwrap_or_default();
        b == "trommi-connector"
    })
}
/// Take the slot; true if this process holds it now. `session` is written into the claim.
pub fn lock_slot(p: &SlotPaths, session: &str) -> bool {
    let _ = fs::create_dir_all(&p.dir);
    let _ = fs::set_permissions(&p.dir, fs::Permissions::from_mode(0o700));
    for _ in 0..8 {
        if write_private(&claim_file(p, pid()), session).is_err() {
            return false;
        }
        let mut others = false;
        for c in claims_of(p) {
            if c == pid() {
                continue;
            }
            if alive(c) {
                others = true;
            } else {
                let _ = fs::remove_file(claim_file(p, c));
            }
        }
        if !others {
            return true;
        }
        let _ = fs::remove_file(claim_file(p, pid()));
        pause_ms(5 + rand_u64(40));
    }
    false
}
pub fn holders_of(p: &SlotPaths) -> Vec<u32> {
    claims_of(p)
        .into_iter()
        .filter(|c| *c != pid() && alive(*c))
        .collect()
}
pub struct Claim {
    pub ok: bool,
    pub holders: Vec<u32>,
    pub took_over: Vec<u32>,
}
/// lockSlot, plus the take-over of a reconnect: live claims of the same session are asked to stop, then removed.
pub async fn claim_slot(p: &SlotPaths, session: &str, wait_ms: u64) -> Claim {
    if lock_slot(p, session) {
        return Claim {
            ok: true,
            holders: vec![],
            took_over: vec![],
        };
    }
    let holders = holders_of(p);
    if session.is_empty()
        || holders.is_empty()
        || holders.iter().any(|h| session_of(p, *h) != session)
    {
        return Claim {
            ok: false,
            holders,
            took_over: vec![],
        };
    }
    for h in &holders {
        if is_connector(*h) {
            sigterm(*h);
        }
    }
    let until = now_ms() + wait_ms;
    while holders.iter().any(|h| alive(*h)) && now_ms() < until {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    for h in &holders {
        if session_of(p, *h) == session {
            let _ = fs::remove_file(claim_file(p, *h));
        }
    }
    if lock_slot(p, session) {
        Claim {
            ok: true,
            holders: vec![],
            took_over: holders,
        }
    } else {
        Claim {
            ok: false,
            holders: holders_of(p),
            took_over: vec![],
        }
    }
}
pub fn unlock_slot(p: &SlotPaths) {
    let _ = fs::remove_file(claim_file(p, pid()));
}

// ---- who gets the key --------------------------------------------------------------------------------------------

/// A Claude Code spare: `claude bg-spare --bg-spare <socket>`.
pub fn is_spare(args: Option<Vec<String>>) -> bool {
    match std::env::var("TROMMI_SPARE").as_deref() {
        Ok("1") => return true,
        Ok("0") => return false,
        _ => {}
    }
    let a = args.unwrap_or_else(|| args_of(ppid()));
    a.iter()
        .take(4)
        .any(|x| x == "bg-spare" || x == "--bg-spare")
}
pub struct YieldState {
    pub free: bool,
    pub used: bool,
    pub quiet_ms: u64,
    pub after_ms: u64,
}
pub fn yield_state(
    used_at: u64,
    since: u64,
    calls: u64,
    spare: bool,
    now: u64,
    unused_ms: u64,
    idle_ms: u64,
) -> YieldState {
    let used = used_at > 0;
    let quiet_ms = now.saturating_sub(if used { used_at } else { since });
    let need = if used {
        idle_ms
    } else if spare {
        0
    } else {
        unused_ms
    };
    YieldState {
        free: calls == 0 && quiet_ms >= need,
        used,
        quiet_ms,
        after_ms: if calls > 0 {
            need
        } else {
            need.saturating_sub(quiet_ms)
        },
    }
}
pub fn claims_at_start(spare: bool, reconnect: bool, others: usize, joining: bool) -> bool {
    !spare && (reconnect || joining || others == 0)
}
fn here_file(dir: &Path, base: &str, p: u32) -> PathBuf {
    dir.join(format!("{base}.here.{p}"))
}
pub fn check_in(dir: &Path, base: &str, who: &Value) {
    let _ = write_private(&here_file(dir, base, pid()), &who.to_string());
}
pub fn check_out(dir: &Path, base: &str) {
    let _ = fs::remove_file(here_file(dir, base, pid()));
}
pub struct Other {
    pub pid: u32,
    pub session: String,
    pub spare: bool,
}
pub fn others_here(dir: &Path, base: &str, keep_dead: bool) -> Vec<Other> {
    let head = format!("{base}.here.");
    let mut out = vec![];
    let Ok(rd) = fs::read_dir(dir) else {
        return out;
    };
    for e in rd.filter_map(|e| e.ok()) {
        let f = e.file_name().to_string_lossy().to_string();
        let Some(rest) = f.strip_prefix(&head) else {
            continue;
        };
        if rest.is_empty() || !rest.bytes().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let p: u32 = rest.parse().unwrap_or(0);
        if p == pid() {
            continue;
        }
        if !alive(p) {
            if !keep_dead {
                let _ = fs::remove_file(dir.join(&f));
            }
            continue;
        }
        if let Some(who) = read_json(&dir.join(&f)) {
            out.push(Other {
                pid: p,
                session: who
                    .get("session")
                    .map(crate::util::js_string)
                    .filter(|_| !who["session"].is_null())
                    .unwrap_or_default(),
                spare: crate::util::truthy(&who["spare"]),
            });
        }
    }
    out
}

// ---- the folder watch ----------------------------------------------------------------------------------------------

/// The start time of a process (field 22 of /proc/<pid>/stat), or ps's lstart.
pub fn start_of(pid: u32) -> String {
    if let Ok(t) = fs::read_to_string(format!("/proc/{pid}/stat")) {
        if let Some(i) = t.rfind(") ") {
            return t[i + 2..].split(' ').nth(19).unwrap_or("").to_string();
        }
        return String::new();
    }
    std::process::Command::new("ps")
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}
fn mark_file(dir: &Path, base: &str, session: &str) -> PathBuf {
    dir.join(format!(
        "{base}.gone.{}",
        &hex(&sha256(session.as_bytes()))[..16]
    ))
}
/// What a connector says of itself in its presence file.
pub fn presence_of(
    session: &str,
    spare: bool,
    claude_pid: u32,
    used_at: u64,
    slot: Option<u32>,
    link: Option<Value>,
) -> Value {
    json!({ "session": session, "spare": spare, "claude_pid": claude_pid, "claude_start": start_of(claude_pid), "used_at": used_at, "slot": slot, "link": link })
}
/// Whether the loss of this connector means something to the human.
pub fn loss_matters(who: &Value, at: u64, idle_ms: u64) -> bool {
    who.get("session").is_some_and(crate::util::truthy)
        && who
            .get("claude_pid")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0)
            > 1.0
        && (!who.get("slot").is_none_or(|v| v.is_null())
            || (who.get("used_at").and_then(|v| v.as_u64()).unwrap_or(0) > 0
                && at.saturating_sub(who["used_at"].as_u64().unwrap_or(0)) < idle_ms))
}
pub fn leave_mark(dir: &Path, base: &str, who: &Value, at: u64, why: &str, by: u32) {
    let mut m = who.as_object().cloned().unwrap_or_default();
    m.insert("at".into(), json!(at));
    m.insert("why".into(), json!(why));
    m.insert("pid".into(), json!(by));
    let session = crate::util::js_string(&who["session"]);
    let _ = write_private(
        &mark_file(dir, base, &session),
        &Value::Object(m).to_string(),
    );
}
pub struct Watch {
    pub cut: Vec<Value>,
    pub pending: Vec<Value>,
    pub cut_since: Option<u64>,
}
/// One look at the folder: buries dead connectors, drops marks that no longer hold.
pub fn folder_watch(dir: &Path, base: &str, now: u64, grace_ms: u64, idle_ms: u64) -> Watch {
    let here = format!("{base}.here.");
    let gone = format!("{base}.gone.");
    let list = || -> Vec<String> {
        fs::read_dir(dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .collect()
            })
            .unwrap_or_default()
    };
    let mut live = std::collections::HashSet::new();
    for f in list() {
        let Some(rest) = f.strip_prefix(&here) else {
            continue;
        };
        if rest.is_empty() || !rest.bytes().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let p: u32 = rest.parse().unwrap_or(0);
        let file = dir.join(&f);
        let who = read_json(&file);
        if p == pid() || alive(p) {
            if let Some(s) = who
                .as_ref()
                .and_then(|w| w.get("session"))
                .filter(|v| crate::util::truthy(v))
            {
                live.insert(crate::util::js_string(s));
            }
            continue;
        }
        if let Some(w) = &who {
            if loss_matters(w, now, idle_ms)
                && !mark_file(dir, base, &crate::util::js_string(&w["session"])).exists()
            {
                leave_mark(dir, base, w, now, "killed", p);
            }
        }
        let _ = fs::remove_file(&file);
    }
    let (mut cut, mut pending) = (vec![], vec![]);
    for f in list() {
        if !f.starts_with(&gone) {
            continue;
        }
        let file = dir.join(&f);
        let t = read_json(&file);
        let holds = t.as_ref().is_some_and(|t| {
            let s = t
                .get("session")
                .filter(|v| crate::util::truthy(v))
                .map(crate::util::js_string);
            let cp = t.get("claude_pid").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let cs = t.get("claude_start").and_then(|v| v.as_str()).unwrap_or("");
            s.is_some_and(|s| !live.contains(&s))
                && alive(cp)
                && (cs.is_empty() || start_of(cp) == cs)
        });
        if !holds {
            let _ = fs::remove_file(&file);
            continue;
        }
        let mut t = t.unwrap().as_object().cloned().unwrap();
        t.insert("file".into(), json!(file.display().to_string()));
        let at = t.get("at").and_then(|v| v.as_u64()).unwrap_or(0);
        if now.saturating_sub(at) >= grace_ms {
            cut.push(Value::Object(t));
        } else {
            pending.push(Value::Object(t));
        }
    }
    let cut_since = cut.iter().filter_map(|t| t["at"].as_u64()).min();
    Watch {
        cut,
        pending,
        cut_since,
    }
}

// ---- which slot is whose ------------------------------------------------------------------------------------

pub fn owner_file(p: &SlotPaths) -> PathBuf {
    p.dir.join(format!(
        "{}.owner",
        p.key_file.file_stem().unwrap().to_string_lossy()
    ))
}
pub fn out_file(p: &SlotPaths) -> PathBuf {
    p.dir.join(format!(
        "{}.out",
        p.key_file.file_stem().unwrap().to_string_lossy()
    ))
}
pub fn owner_of(p: &SlotPaths) -> Option<Value> {
    read_json(&owner_file(p))
}
pub fn owner_record(owner: &str, claude_pid: Option<u32>) -> Value {
    json!({ "owner": owner, "claude_pid": claude_pid, "at": now_ms() })
}
pub fn write_owner(p: &SlotPaths, record: &Value) {
    let _ = write_private(&owner_file(p), &record.to_string());
}
/// Whether a slot's owner record names this session: the same owner key; without one, the same Claude Code process.
pub fn owned_by(record: Option<&Value>, owner: &str, claude_pid: u32) -> bool {
    let Some(r) = record else { return false };
    if !owner.is_empty() {
        return r.get("owner").and_then(|v| v.as_str()) == Some(owner);
    }
    !r.get("owner").is_some_and(crate::util::truthy)
        && r.get("claude_pid").and_then(|v| v.as_u64()) == Some(claude_pid as u64)
}
/// The slots of a room in the order a connector of this session tries them: its own, its earlier connector's, the rest.
pub fn slot_order(
    keyed: &[u32],
    owned: impl Fn(u32) -> bool,
    held_by_session: impl Fn(u32) -> bool,
) -> Vec<u32> {
    let rank = |n: u32| {
        if owned(n) {
            0
        } else if held_by_session(n) {
            1
        } else {
            2
        }
    };
    let mut v = keyed.to_vec();
    v.sort_by(|a, b| rank(*a).cmp(&rank(*b)).then(a.cmp(b)));
    v
}
/// Put a slot's key and everything stored with it aside: `replaced-<time>-<name>` in the same directory.
/// Takes a slot's files out of the way: the state and the key marker are deleted (a device that is out keeps
/// nothing of its session, spec/v2.md 13.5), what else belongs to the slot is renamed `replaced-<time>-…`.
pub fn set_slot_aside(p: &SlotPaths, stamp: Option<String>) -> PathBuf {
    let stamp = stamp.unwrap_or_else(compact_stamp);
    let name = p
        .key_file
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let _ = fs::remove_dir_all(crate::slotstore::state_dir(&p.key_file));
    // What was downloaded and decrypted for this device goes too.
    let _ = fs::remove_dir_all(&p.cache);
    let _ = fs::remove_file(&p.key_file);
    if let Ok(rd) = fs::read_dir(&p.dir) {
        for e in rd.filter_map(|e| e.ok()) {
            let f = e.file_name().to_string_lossy().to_string();
            if !f.starts_with(&format!("{name}.")) || f.starts_with(&format!("{name}.lock")) {
                continue;
            }
            let _ = fs::rename(p.dir.join(&f), p.dir.join(format!("replaced-{stamp}-{f}")));
        }
    }
    p.dir.join(format!("replaced-{stamp}-{name}.owner"))
}
/// new Date().toISOString().replace(/[-:]|\..*$/g, ''): 20261008T101500
pub fn compact_stamp() -> String {
    let ms = now_ms();
    let secs = (ms / 1000) as i64;
    let (y, mo, d) = crate::bridge::civil(secs.div_euclid(86400));
    let r = secs.rem_euclid(86400);
    format!(
        "{y:04}{mo:02}{d:02}T{:02}{:02}{:02}",
        r / 3600,
        r % 3600 / 60,
        r % 60
    )
}
