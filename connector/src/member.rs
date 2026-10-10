//! The member: this process as a member of the room. Key slot, sign-in, lease, stream; joining by an
//! agent invite link; keys that are out (put aside, the next usable key at once); handing the key over.
use crate::client::{BoxFut, Client, ClientEvent, Command};
use crate::door::knock;
use crate::error::{Fault, Result};
use crate::hooks::ancestors;
use crate::slots::*;
use crate::slotstore::{SlotStore, KEY_MARKER};
use crate::util::now_ms;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub fn slug(s: &str) -> String {
    let r = regex::Regex::new(r"[^a-z0-9]+")
        .unwrap()
        .replace_all(&s.to_lowercase(), "-")
        .to_string();
    let r = r.trim_matches('-').to_string();
    if r.is_empty() {
        "x".into()
    } else {
        r
    }
}
pub fn hostname() -> String {
    let name = rustix::system::uname()
        .nodename()
        .to_string_lossy()
        .to_string();
    if name.is_empty() {
        "localhost".into()
    } else {
        name
    }
}
pub fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}
/// path.resolve: absolute and normalised.
pub fn resolve(p: &str) -> PathBuf {
    let pb = PathBuf::from(p);
    let pb = if pb.is_absolute() {
        pb
    } else {
        std::env::current_dir().unwrap_or_default().join(pb)
    };
    let mut out = PathBuf::from("/");
    for c in pb.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::Normal(x) => out.push(x),
            _ => {}
        }
    }
    out
}

/// The name the folder's key slots go by: kept in <folder>/.trommi/slot-base once written.
fn slot_base(folder: &Path, derived: &str, write: bool) -> String {
    let dir = folder.join(".trommi");
    let file = dir.join("slot-base");
    if let Ok(k) = std::fs::read_to_string(&file) {
        let k = k.trim();
        if regex::Regex::new(r"^[a-z0-9-]{1,200}$")
            .unwrap()
            .is_match(k)
        {
            return k.to_string();
        }
    }
    if write {
        let _ = (|| -> std::io::Result<()> {
            std::fs::create_dir_all(&dir)?;
            if !dir.join(".gitignore").exists() {
                std::fs::write(dir.join(".gitignore"), "*\n")?;
            }
            let mut f = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&file)?;
            std::io::Write::write_all(&mut f, format!("{derived}\n").as_bytes())
        })();
    }
    derived.to_string()
}

#[derive(Clone, Debug)]
pub struct Cfg {
    pub keys_dir: PathBuf,
    pub folder: PathBuf,
    pub shown: String,
    pub host: String,
    pub base: String,
    pub session: String,
    pub owner: String,
    pub takeover_ms: u64,
    pub hub_url: String,
    pub invite: String,
    pub room: String,
}
pub fn env(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.is_empty())
}
pub fn connector_config(folder_override: Option<String>, write: bool) -> Cfg {
    let h = home();
    let keys_dir = resolve(
        &env("TROMMI_KEYS_DIR")
            .unwrap_or_else(|| h.join(".local/share/trommi/keys").display().to_string()),
    );
    let folder = resolve(
        &folder_override
            .or_else(|| env("TROMMI_FOLDER"))
            .unwrap_or_else(|| {
                std::env::current_dir()
                    .unwrap_or_default()
                    .display()
                    .to_string()
            }),
    );
    let hs = h.display().to_string();
    let fs_ = folder.display().to_string();
    let shown = if fs_ == hs {
        "~".to_string()
    } else if fs_.starts_with(&format!("{hs}/")) {
        format!("~/{}", &fs_[hs.len() + 1..])
    } else {
        fs_.clone()
    };
    let host = hostname();
    let rest = regex::Regex::new(r"^~/?")
        .unwrap()
        .replace(&shown, "")
        .to_string();
    let derived = format!("{}-{}", slug(&host), slug(&rest));
    let base = slot_base(&folder, &derived, write);
    let session = env("TROMMI_SESSION_KEY").unwrap_or_else(|| format!("ppid:{}", ppid()));
    let owner = if let Some(c) = env("CLAUDE_CODE_SESSION_ID") {
        format!("cc:{c}")
    } else if let Some(k) = env("TROMMI_SESSION_KEY") {
        format!("key:{k}")
    } else {
        String::new()
    };
    let takeover_ms = env("TROMMI_TAKEOVER_MS")
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| *v != 0.0 && v.is_finite())
        .map(|v| v as u64)
        .unwrap_or(4000);
    Cfg {
        keys_dir,
        folder,
        shown,
        host,
        base,
        session,
        owner,
        takeover_ms,
        hub_url: env("TROMMI_HUB").unwrap_or_else(|| "https://hub.trommi.com".into()),
        invite: env("TROMMI_INVITE").unwrap_or_default(),
        room: env("TROMMI_ROOM").unwrap_or_default(),
    }
}

pub fn room_of_link(link: &str) -> Result<(String, String)> {
    crate::join::room_of_link(link)
}
pub fn slots_in(cfg: &Cfg, dir: &Path) -> Vec<u32> {
    let re = regex::Regex::new(&format!(r"^{}-(\d+)\.key$", regex::escape(&cfg.base))).unwrap();
    let Ok(rd) = std::fs::read_dir(dir) else {
        return vec![];
    };
    let mut v: Vec<u32> = rd
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            re.captures(&e.file_name().to_string_lossy())
                .and_then(|c| c[1].parse().ok())
        })
        .collect();
    v.sort();
    v
}
/// The room this folder belongs to: from the invite link, TROMMI_ROOM, or the only room with a key of this folder.
pub fn resolve_room(cfg: &Cfg) -> Result<Option<String>> {
    if !cfg.room.is_empty() {
        return Ok(Some(cfg.room.clone()));
    }
    if !cfg.invite.is_empty() {
        return Ok(Some(room_of_link(&cfg.invite)?.0));
    }
    let names: Vec<String> = std::fs::read_dir(&cfg.keys_dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default();
    let mut rooms: Vec<String> = names
        .iter()
        .filter(|r| !slots_in(cfg, &cfg.keys_dir.join(r)).is_empty())
        .cloned()
        .collect();
    if rooms.is_empty() {
        rooms = names
            .iter()
            .filter(|r| last_out(cfg, r).is_some())
            .cloned()
            .collect();
    }
    rooms.sort();
    if rooms.len() > 1 {
        return Err(Fault::plain(format!(
            "this folder has keys for {} rooms ({}); set TROMMI_ROOM",
            rooms.len(),
            rooms.join(", ")
        ))
        .with("code", "ambiguous-room"));
    }
    Ok(rooms.into_iter().next())
}
pub fn paths_of(cfg: &Cfg, room_id: &str, slot: u32) -> SlotPaths {
    let dir = cfg.keys_dir.join(room_id);
    let name = format!("{}-{slot}", cfg.base);
    SlotPaths {
        key_file: dir.join(format!("{name}.key")),
        lock_file: dir.join(format!("{name}.lock")),
        prefix: format!("{name}."),
        cache: dir.join(format!("{name}.files")),
        dir,
        slot,
        ..Default::default()
    }
}
/// The newest out mark of this folder in a room.
pub fn last_out(cfg: &Cfg, room_id: &str) -> Option<Value> {
    let dir = cfg.keys_dir.join(room_id);
    let re = regex::Regex::new(&format!(
        r"^replaced-(\d{{8}}T\d{{6}})-{}-\d+\.out$",
        regex::escape(&cfg.base)
    ))
    .unwrap();
    let names: Vec<String> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|f| re.is_match(f))
                .collect()
        })
        .unwrap_or_default();
    let mut marks: Vec<Value> = names
        .iter()
        .filter_map(|f| read_json(&dir.join(f)))
        .collect();
    marks.sort_by_key(|m| m.get("at").and_then(|v| v.as_u64()).unwrap_or(0));
    let own = marks
        .iter()
        .rfind(|m| owned_by(m.get("owner"), &cfg.owner, ppid()))
        .cloned();
    own.or_else(|| marks.last().cloned())
}
fn clear_leftovers(p: &SlotPaths) {
    if p.key_file.exists() {
        return;
    }
    let name = p
        .key_file
        .file_stem()
        .unwrap()
        .to_string_lossy()
        .to_string();
    let left: Vec<String> = std::fs::read_dir(&p.dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|f| {
                    f.starts_with(&format!("{name}.")) && !f.starts_with(&format!("{name}.lock"))
                })
                .collect()
        })
        .unwrap_or_default();
    if !left.is_empty() {
        let aside = set_slot_aside(p, None);
        eprintln!(
            "[trommi] slot {} had files without a key ({}): put aside as {}",
            p.slot,
            left.join(", "),
            aside.display()
        );
    }
}

/// Ask the holder of a slot for its key: Ok when it gave it up, else its answer (used, quiet_ms, after_ms) or silent.
pub async fn ask_yield(p: &SlotPaths, session: &str) -> std::result::Result<(), Refused> {
    match knock(
        p,
        &json!({ "op": "yield", "pid": pid(), "session": session }),
        10_000,
    )
    .await
    {
        Err(_) => Err(Refused {
            silent: true,
            ..Default::default()
        }),
        Ok(r) => {
            if r["ok"] == Value::Bool(true) {
                return Ok(());
            }
            if r["busy"] == Value::Bool(true) {
                Err(Refused {
                    used: r["used"] == Value::Bool(true),
                    quiet_ms: r["quiet_ms"].as_f64().unwrap_or(0.0) as u64,
                    after_ms: r["after_ms"].as_f64().unwrap_or(0.0) as u64,
                    ..Default::default()
                })
            } else {
                Err(Refused {
                    silent: true,
                    ..Default::default()
                })
            }
        }
    }
}

/// The slot this process uses in a room.
pub async fn pick_slot(cfg: &Cfg, room_id: &str, ask: bool) -> SlotPaths {
    let dir = cfg.keys_dir.join(room_id);
    let keyed_raw = slots_in(cfg, &dir);
    let keyed = slot_order(
        &keyed_raw,
        |n| {
            owned_by(
                owner_of(&paths_of(cfg, room_id, n)).as_ref(),
                &cfg.owner,
                ppid(),
            )
        },
        |n| {
            let p = paths_of(cfg, room_id, n);
            holders_of(&p)
                .iter()
                .any(|h| session_of(&p, *h) == cfg.session)
        },
    );
    let mut holders = vec![];
    let mut busy = vec![];
    let mut refused: Option<Refused> = None;
    for n in &keyed {
        let p = paths_of(cfg, room_id, *n);
        let mut r = claim_slot(&p, &cfg.session, cfg.takeover_ms).await;
        if !r.took_over.is_empty() {
            eprintln!(
                "[trommi] slot {n} taken over from the earlier connector of this session (pid {})",
                r.took_over
                    .iter()
                    .map(|x| x.to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        }
        let mut handed = false;
        if !r.ok && ask {
            let was = r.holders.clone();
            match ask_yield(&p, &cfg.session).await {
                Ok(()) => {
                    r = claim_slot(&p, &cfg.session, cfg.takeover_ms).await;
                    if r.ok {
                        eprintln!(
                            "[trommi] slot {n} handed over by its idle holder (pid {})",
                            was.iter()
                                .map(|x| x.to_string())
                                .collect::<Vec<_>>()
                                .join(", ")
                        );
                        handed = true;
                    }
                }
                Err(y) => {
                    if refused.is_none() {
                        refused = Some(Refused {
                            slot: *n,
                            pids: was,
                            ..y
                        });
                    }
                }
            }
        }
        if r.ok {
            if owner_of(&p).is_none() && !cfg.owner.is_empty() {
                write_owner(&p, &owner_record(&cfg.owner, Some(ppid())));
            }
            return SlotPaths {
                has_key: true,
                busy,
                holders,
                took_over: !r.took_over.is_empty(),
                handed_over: handed,
                ..p
            };
        }
        busy.push(*n);
        holders.extend(r.holders);
    }
    let mut n = 1;
    loop {
        if !keyed.contains(&n) {
            let p = paths_of(cfg, room_id, n);
            if claim_slot(&p, &cfg.session, cfg.takeover_ms).await.ok {
                clear_leftovers(&p);
                return SlotPaths {
                    has_key: false,
                    busy,
                    holders,
                    refused,
                    ..p
                };
            }
        }
        n += 1;
    }
}
/// The first slot of the folder without a key, claimed.
pub async fn free_slot(cfg: &Cfg, room_id: &str) -> SlotPaths {
    let keyed = slots_in(cfg, &cfg.keys_dir.join(room_id));
    let mut n = 1;
    loop {
        if !keyed.contains(&n) {
            let p = paths_of(cfg, room_id, n);
            if claim_slot(&p, &cfg.session, cfg.takeover_ms).await.ok {
                clear_leftovers(&p);
                return SlotPaths {
                    has_key: false,
                    busy: keyed,
                    holders: vec![],
                    ..p
                };
            }
        }
        n += 1;
    }
}
/// The keyed slot of this folder that a running connector of this same Claude Code session holds, if any.
async fn own_held_slot(cfg: &Cfg, room_id: &str) -> Option<SlotPaths> {
    let up = ancestors(8);
    for n in slots_in(cfg, &cfg.keys_dir.join(room_id)) {
        let p = paths_of(cfg, room_id, n);
        if holders_of(&p).is_empty() {
            continue;
        }
        if let Ok(r) = knock(&p, &json!({ "op": "whose", "ancestors": up }), 3000).await {
            if r["ok"] == Value::Bool(true) && r["mine"] == Value::Bool(true) {
                return Some(p);
            }
        }
    }
    None
}

/// What the member tells its host.
pub trait Host: Send + Sync {
    fn on_command(&self, cmd: Command) -> BoxFut<'_, ()>;
    fn on_ready(&self) -> BoxFut<'_, ()>;
    fn on_lease_lost(&self) -> BoxFut<'_, ()>;
    fn on_too_old(&self) -> BoxFut<'_, ()>;
    fn on_retired(&self) -> BoxFut<'_, ()>;
    fn on_dropped(&self) -> BoxFut<'_, ()>;
}
pub struct NoHost;
impl Host for NoHost {
    fn on_command(&self, _: Command) -> BoxFut<'_, ()> {
        Box::pin(async {})
    }
    fn on_ready(&self) -> BoxFut<'_, ()> {
        Box::pin(async {})
    }
    fn on_lease_lost(&self) -> BoxFut<'_, ()> {
        Box::pin(async {})
    }
    fn on_too_old(&self) -> BoxFut<'_, ()> {
        Box::pin(async {})
    }
    fn on_retired(&self) -> BoxFut<'_, ()> {
        Box::pin(async {})
    }
    fn on_dropped(&self) -> BoxFut<'_, ()> {
        Box::pin(async {})
    }
}

#[derive(Default)]
pub struct Me {
    pub phase: String,
    pub error: Option<String>,
    pub client: Option<Arc<Client>>,
    pub room_id: Option<String>,
    pub storage: Option<Arc<SlotStore>>,
    pub session: Option<Value>,
    pub paths: Option<SlotPaths>,
    pub out: Option<Value>,
    pub out_told: bool,
    pub joining: bool,
}

pub struct Member {
    pub me: Mutex<Me>,
    pub cfg: Cfg,
    pub process_instance: String,
    device_info: Value,
    host: Mutex<Option<Arc<dyn Host>>>,
    op: tokio::sync::Mutex<()>,
    moving: std::sync::atomic::AtomicBool,
    /// Whether the removal this process learned of was verified: it processed the Commit itself.
    verified: std::sync::atomic::AtomicBool,
    /// When what answered was last found to be no hub of this protocol (ms; 0 for never).
    no_hub_at: std::sync::atomic::AtomicU64,
    self_ref: Mutex<std::sync::Weak<Member>>,
}

/// How long a connector that found no hub of this protocol waits before it asks again.
const NO_HUB_PAUSE_MS: u64 = 60_000;

pub fn client_name() -> Option<String> {
    Some(crate::CLIENT.to_string())
}

impl Member {
    pub fn new(cfg: Cfg) -> Arc<Member> {
        let name = cfg
            .folder
            .file_name()
            .map(|x| x.to_string_lossy().to_string())
            .filter(|x| !x.is_empty())
            .unwrap_or_else(|| cfg.shown.clone());
        let device_info = json!({ "device_name": name, "platform": "claude-code", "folder": cfg.shown, "host": cfg.host });
        let m = Arc::new(Member {
            me: Mutex::new(Me {
                phase: "asleep".into(),
                ..Default::default()
            }),
            cfg,
            process_instance: crate::util::random_hex(8),
            device_info,
            host: Mutex::new(None),
            op: tokio::sync::Mutex::new(()),
            moving: std::sync::atomic::AtomicBool::new(false),
            verified: std::sync::atomic::AtomicBool::new(false),
            no_hub_at: std::sync::atomic::AtomicU64::new(0),
            self_ref: Mutex::new(std::sync::Weak::new()),
        });
        *m.self_ref.lock().unwrap() = Arc::downgrade(&m);
        m
    }
    pub fn set_host(&self, h: Arc<dyn Host>) {
        *self.host.lock().unwrap() = Some(h);
    }
    fn host(&self) -> Arc<dyn Host> {
        self.host
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| Arc::new(NoHost))
    }
    pub fn phase(&self) -> String {
        self.me.lock().unwrap().phase.clone()
    }
    pub fn client(&self) -> Option<Arc<Client>> {
        self.me.lock().unwrap().client.clone()
    }
    pub fn paths(&self) -> Option<SlotPaths> {
        self.me.lock().unwrap().paths.clone()
    }
    fn set_phase(&self, p: &str) {
        self.me.lock().unwrap().phase = p.into();
    }

    async fn storage_for(&self, room_id: &str, ask: bool) -> Result<Arc<SlotStore>> {
        let (have, same) = {
            let me = self.me.lock().unwrap();
            (me.paths.clone(), me.room_id.as_deref() == Some(room_id))
        };
        let p = match (have, same) {
            (Some(p), true) => p,
            (Some(p), false) => {
                unlock_slot(&p);
                pick_slot(&self.cfg, room_id, ask).await
            }
            (None, _) => pick_slot(&self.cfg, room_id, ask).await,
        };
        // The slot this process holds already keeps its state open: one handle, one lock.
        let held = {
            let me = self.me.lock().unwrap();
            me.storage
                .clone()
                .filter(|_| me.paths.as_ref().is_some_and(|q| q.key_file == p.key_file))
        };
        let st = match held {
            Some(st) => st,
            None => SlotStore::open(&p.key_file)?,
        };
        let mut me = self.me.lock().unwrap();
        me.room_id = Some(room_id.into());
        me.paths = Some(p);
        me.storage = Some(st.clone());
        Ok(st)
    }

    fn out_text(was: &Value) -> String {
        let kf = was["key_file"].as_str().unwrap_or("");
        if was["verified"] == Value::Bool(false) {
            format!("This connector stopped: the hub no longer takes its device. Either the human removed it or let another connector continue this Trommi session while this one was away, or the hub is wrong. Its state is kept ({kf}); nothing sent from here reaches the board. To use Trommi again here, the human reconnects this session in the Trommi app (a new invite link), then `trommi-connector connect '<link>'` here.")
        } else if was["replaced"] == Value::Bool(true) {
            format!("This connector is retired: the human let another connector continue this Trommi session (a new invite link for the same session), and this key ({kf}) no longer belongs to the room; it is put aside, and no other usable key is left in this folder. Nothing sent from here reaches the board. If this Claude Code session should use Trommi again, the human invites this session again in the Trommi app.")
        } else {
            format!("This connector is retired: the human removed its key ({kf}) from the Trommi room; it is put aside, and no other usable key is left in this folder. Nothing sent from here reaches the board. To use Trommi again here, the human invites this session again in the Trommi app.")
        }
    }
    /// The slot this process holds is out. A removal this device verified itself (it processed the Commit)
    /// wipes the slot's state (13.5) and gives the slot back; returns true. One that only the hub asserts
    /// (it refuses the device as no member) stops this process and leaves the state where it is, because a
    /// hub's word must not destroy a membership; returns false.
    fn put_out(&self, replaced: bool) -> bool {
        let verified = self
            .verified
            .swap(false, std::sync::atomic::Ordering::SeqCst);
        let mut me = self.me.lock().unwrap();
        let Some(p) = me.paths.clone() else {
            return verified;
        };
        let was = json!({ "replaced": replaced, "verified": verified, "key_file": p.key_file.display().to_string(), "at": now_ms(), "owner": owner_of(&p) });
        if !verified {
            me.storage = None;
            unlock_slot(&p);
            me.paths = None;
            me.out = Some(was);
            me.out_told = false;
            eprintln!("[trommi] slot {}: the hub no longer takes this device; this connector stops, its state stays where it is", p.slot);
            return false;
        }
        let _ = write_private(&out_file(&p), &was.to_string());
        // 13.5: a device that is out keeps nothing of its session.
        let wiped = match me.storage.take() {
            Some(storage) => storage.journal().wipe().is_ok(),
            None => true,
        };
        let aside = set_slot_aside(&p, None);
        let gone = !crate::slotstore::state_dir(&p.key_file).exists();
        unlock_slot(&p);
        me.paths = None;
        me.out = Some(was);
        me.out_told = false;
        if wiped && gone {
            eprintln!("[trommi] slot {}: {}; its state is wiped (what is left is put aside as {}), looking for another usable key", p.slot, if replaced { "another connector continues its session, its device is retired" } else { "its device was removed from the room" }, aside.display());
        } else {
            eprintln!("[trommi] slot {}: its device is out of the room, but its state could NOT be wiped: delete {} by hand", p.slot, crate::slotstore::state_dir(&p.key_file).display());
        }
        true
    }

    /// Start the client, take the lease, wait for a session; commands flow once the host is ready.
    async fn run(
        self: &Arc<Self>,
        client: Arc<Client>,
        mut rx: tokio::sync::mpsc::UnboundedReceiver<ClientEvent>,
    ) -> Result<()> {
        self.me.lock().unwrap().client = Some(client.clone());
        let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<bool>();
        let (cmd_tx, mut cmd_rx) = tokio::sync::mpsc::unbounded_channel::<Command>();
        let ready = Arc::new(tokio::sync::Notify::new());
        let is_ready = Arc::new(std::sync::atomic::AtomicBool::new(false));
        // the client's events
        let me = self.clone();
        // Held weakly: these tasks live as long as the client's events come, and the client lives as long as
        // someone else holds it. A client that was given up frees its state at once.
        let c2 = Arc::downgrade(&client);
        tokio::spawn(async move {
            while let Some(e) = rx.recv().await {
                let Some(c2) = c2.upgrade() else { break };
                let current = me.client().is_some_and(|c| Arc::ptr_eq(&c, &c2));
                if !current {
                    continue;
                }
                match e {
                    ClientEvent::Command(cmd) => {
                        if me.phase() == "halted" {
                            eprintln!(
                                "[trommi] command {} held back: this connector halted",
                                cmd.envelope_number
                            );
                            continue;
                        }
                        let _ = cmd_tx.send(*cmd);
                    }
                    ClientEvent::Removed { replaced, verified } => {
                        me.verified
                            .store(verified, std::sync::atomic::Ordering::SeqCst);
                        if me.phase() != "ready" {
                            let _ = out_tx.send(replaced);
                        } else {
                            me.move_on(c2.clone(), replaced);
                        }
                    }
                    ClientEvent::Error(err) => {
                        if err.code == "lease-lost" {
                            {
                                let mut m = me.me.lock().unwrap();
                                m.phase = "lease-lost".into();
                                m.error = Some(
                                    "another process took over this key; this one stops".into(),
                                );
                            }
                            eprintln!(
                                "[trommi] another process took over this key; this one stops"
                            );
                            me.host().on_lease_lost().await;
                            continue;
                        }
                        if err.code == "client-too-old" || err.code == "upgrade_required" {
                            let text = format!("The Trommi hub needs a newer connector than {}: update the trommi plugin (or run the connect script again), then /mcp → trommi → Reconnect. Nothing is sent or acted on until then.", crate::CLIENT);
                            {
                                let mut m = me.me.lock().unwrap();
                                m.phase = "too-old".into();
                                m.error = Some(text.clone());
                            }
                            eprintln!("[trommi] {text}");
                            me.host().on_too_old().await;
                            continue;
                        }
                        if err.code == "hub-unusable"
                            || err.code == "bad-group"
                            || err.code == "bad-invite"
                            || err.code == "state-too-old"
                        {
                            let mut m = me.me.lock().unwrap();
                            m.phase = "halted".into();
                            m.error = Some(format!("{} Nothing is acted on until the human reconnects this session in the Trommi app (a new invite link for it).", err.text()));
                        }
                        eprintln!("[trommi] client: {}", err.text());
                    }
                    ClientEvent::Session { .. } => {}
                }
            }
        });
        // commands, in order, once the host is ready; executed once (the ledger survives restarts)
        let me = self.clone();
        let c3 = Arc::downgrade(&client);
        let rd = ready.clone();
        let isr = is_ready.clone();
        tokio::spawn(async move {
            loop {
                let n = rd.notified();
                if isr.load(std::sync::atomic::Ordering::SeqCst) {
                    break;
                }
                // (a client that was given up before it was ready ends this task too)
                tokio::select! {
                    _ = n => {}
                    _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => {
                        if c3.strong_count() == 0 {
                            return;
                        }
                    }
                }
            }
            while let Some(cmd) = cmd_rx.recv().await {
                let Some(c3) = c3.upgrade() else { break };
                if !me.client().is_some_and(|c| Arc::ptr_eq(&c, &c3)) {
                    break;
                }
                // A connector that halted meanwhile hands out nothing more; the command stays noted and is
                // reported as uncertain when the session is connected again.
                if me.phase() == "halted" {
                    continue;
                }
                me.host().on_command(cmd.clone()).await;
                if !cmd.envelope_hash.is_empty() {
                    if let Err(e) = c3.ledger_mark(&cmd.envelope_hash).await {
                        eprintln!("[trommi] command not relayed: {}", e.text());
                    }
                }
            }
        });
        let removed_err = |replaced: bool| {
            Fault::new("removed", "this device is out of the room").with("replaced", replaced)
        };
        tokio::select! {
            r = client.start() => r?,
            Some(rep) = out_rx.recv() => return Err(removed_err(rep)),
        }
        {
            let c = client.core.lock().await;
            if c.model.room.connection == "removed" {
                return Err(removed_err(c.model.room.replaced));
            }
        }
        if client.core.lock().await.session_id().is_none() {
            self.set_phase("waiting-session");
            eprintln!("[trommi] waiting for the human's app to put this agent into its session");
            tokio::select! {
                _ = client.when_session() => {},
                Some(rep) = out_rx.recv() => return Err(removed_err(rep)),
            }
        }
        let sid = client.core.lock().await.session_id();
        self.me.lock().unwrap().session = Some(json!({ "agent_session_id": sid }));
        if let Err(e) = client.ensure_device_register(&self.device_info).await {
            eprintln!("[trommi] label not written: {}", e.text());
        }
        {
            let mut m = self.me.lock().unwrap();
            m.phase = "ready".into();
            m.error = None;
        }
        self.host().on_ready().await;
        is_ready.store(true, std::sync::atomic::Ordering::SeqCst);
        ready.notify_waiters();
        Ok(())
    }

    pub async fn open(self: &Arc<Self>, ask: bool) -> Result<()> {
        let Some(room_id) = resolve_room(&self.cfg)? else {
            self.set_phase("needs-invite");
            return Ok(());
        };
        loop {
            let storage = self.storage_for(&room_id, ask).await?;
            let p = self.paths().unwrap();
            if !p.has_key {
                let has_out = self.me.lock().unwrap().out.is_some();
                if !self.cfg.invite.is_empty() && !has_out {
                    return Box::pin(self.join(&self.cfg.invite.clone(), false, false)).await;
                }
                let out = if p.busy.is_empty() {
                    self.me
                        .lock()
                        .unwrap()
                        .out
                        .clone()
                        .or_else(|| last_out(&self.cfg, &room_id))
                } else {
                    None
                };
                let tell = {
                    let mut me = self.me.lock().unwrap();
                    me.phase = if out.is_some() {
                        "retired".into()
                    } else {
                        "needs-invite".into()
                    };
                    me.error = out.as_ref().map(Self::out_text);
                    if out.is_some() {
                        if let Some(pp) = me.paths.take() {
                            unlock_slot(&pp);
                        }
                        me.storage = None;
                    }
                    let tell = out.is_some() && me.out.is_some() && !me.out_told;
                    if tell {
                        me.out_told = true;
                    }
                    tell
                };
                if tell {
                    eprintln!(
                        "[trommi] {}",
                        self.me.lock().unwrap().error.clone().unwrap_or_default()
                    );
                    self.host().on_retired().await;
                }
                return Ok(());
            }
            if storage.room().is_none() {
                self.set_phase("needs-invite");
                return Ok(());
            }
            let (client, rx) = Client::open(storage.journal().clone()).await?;
            storage.attach(&client);
            match self.run(client.clone(), rx).await {
                Ok(()) => {
                    self.me.lock().unwrap().out = None;
                    return Ok(());
                }
                Err(mut e) => {
                    if e.code == "not-member" || e.code == "removed-sender" {
                        // The hub no longer knows this device: it was removed, or another connector took its
                        // session over while this one was away.
                        // (whether the device verified its removal itself decides about its state)
                        let (replaced, verified) = client.removal().await.unwrap_or((false, false));
                        self.verified
                            .store(verified, std::sync::atomic::Ordering::SeqCst);
                        e.code = "removed".into();
                        e.extra.insert("replaced".into(), json!(replaced));
                    }
                    if e.code != "removed" {
                        return Err(e);
                    }
                    self.me.lock().unwrap().client = None;
                    client.stop().await;
                    let replaced = e
                        .extra
                        .get("replaced")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    if !self.put_out(replaced) {
                        // Unverified: the state stays, and this process does not try the same slot again.
                        let tell = {
                            let mut me = self.me.lock().unwrap();
                            me.phase = "retired".into();
                            me.error = me.out.as_ref().map(Self::out_text);
                            !std::mem::replace(&mut me.out_told, true)
                        };
                        if tell {
                            eprintln!(
                                "[trommi] {}",
                                self.me.lock().unwrap().error.clone().unwrap_or_default()
                            );
                            self.host().on_retired().await;
                        }
                        return Ok(());
                    }
                }
            }
        }
    }

    /// The key of a running connector is out: the client stops, the key goes aside, the next usable key opens.
    fn move_on(self: &Arc<Self>, client: Arc<Client>, replaced: bool) {
        if self.moving.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let me = self.clone();
        tokio::spawn(async move {
            let _g = me.op.lock().await;
            me.set_phase("moving");
            {
                let mut m = me.me.lock().unwrap();
                m.client = None;
                m.session = None;
            }
            client.stop().await;
            me.host().on_dropped().await;
            // What the client knows by now decides: whether it verified the removal, and what kind it was.
            let replaced = match client.removal().await {
                Some((replaced, verified)) => {
                    me.verified
                        .store(verified, std::sync::atomic::Ordering::SeqCst);
                    replaced
                }
                None => replaced,
            };
            if !me.put_out(replaced) {
                {
                    let mut m = me.me.lock().unwrap();
                    m.phase = "retired".into();
                    m.error = m.out.as_ref().map(Self::out_text);
                    m.out_told = true;
                }
                me.host().on_retired().await;
                me.moving.store(false, std::sync::atomic::Ordering::SeqCst);
                return;
            }
            me.set_phase("starting");
            if let Err(e) = me.open(false).await {
                let mut m = me.me.lock().unwrap();
                m.error = Some(e.text());
                if m.phase == "starting" {
                    if let Some(p) = m.paths.take() {
                        unlock_slot(&p);
                    }
                    m.storage = None;
                    m.phase = "asleep".into();
                }
                eprintln!(
                    "[trommi] not connected after the key was put aside: {}",
                    e.text()
                );
            }
            me.moving.store(false, std::sync::atomic::Ordering::SeqCst);
        });
    }
    pub fn is_moving(&self) -> bool {
        self.moving.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Join by an agent invite link; resolves when the human's app has added this device and the session is claimed.
    pub async fn join(self: &Arc<Self>, link: &str, replace_held: bool, cli: bool) -> Result<()> {
        if self.phase() == "ready" {
            return Err(Fault::plain("this session is already in a room"));
        }
        let (room_id, _hub) = room_of_link(link)?;
        let _ = self.storage_for(&room_id, false).await?;
        let mut old: Option<SlotPaths> = None;
        let cur = self.paths().unwrap();
        let held = if cur.has_key || !replace_held {
            None
        } else {
            own_held_slot(&self.cfg, &room_id).await
        };
        let rec = if cur.has_key && !self.cfg.owner.is_empty() {
            owner_of(&cur)
        } else {
            None
        };
        if rec
            .as_ref()
            .and_then(|r| r["owner"].as_str())
            .is_some_and(|o| !o.is_empty() && o != self.cfg.owner)
        {
            eprintln!("[trommi] slot {} belongs to another Claude Code session: it stays as it is, and this join goes into a free slot", cur.slot);
            unlock_slot(&cur);
            let p = free_slot(&self.cfg, &room_id).await;
            let st = SlotStore::open(&p.key_file)?;
            let mut me = self.me.lock().unwrap();
            me.paths = Some(p);
            me.storage = Some(st);
        } else if cur.has_key {
            old = Some(cur.clone());
            let p = free_slot(&self.cfg, &room_id).await;
            let st = SlotStore::open(&p.key_file)?;
            {
                let mut me = self.me.lock().unwrap();
                me.paths = Some(p);
                me.storage = Some(st);
            }
            eprintln!("[trommi] this session has a key for this room already (slot {}); joining with a new key, the old one stays until the app has added the new one", cur.slot);
        }
        {
            let mut me = self.me.lock().unwrap();
            me.phase = "joining".into();
            me.joining = true;
        }
        let storage = self.me.lock().unwrap().storage.clone().unwrap();
        let key_file = self.paths().map(|p| p.key_file);
        let res = async {
            crate::join::join_room(link.trim(), storage.journal().clone(), |code| {
                eprintln!("[trommi] invite answered: check code {}  ({})", code.emoji().join("  "), code.words().join(", "));
                eprintln!("[trommi] the Trommi app shows six emoji on its invite page: the same six in the same order? Tap \"They match\" there; if not, \"They don't match\". Waiting for the app to add this session");
            }, 800, 15 * 60_000).await?;
            // The slot is keyed from here on: the marker is what the slot logic looks for.
            if let Some(key_file) = &key_file {
                write_private(key_file, KEY_MARKER)?;
            }
            let (client, rx) = Client::open(storage.journal().clone()).await?;
            storage.attach(&client);
            Ok::<_, Fault>((client, rx))
        }
        .await;
        self.me.lock().unwrap().joining = false;
        let (client, rx) = match res {
            Ok(x) => x,
            Err(e) => {
                if let Some(o) = &old {
                    let mut me = self.me.lock().unwrap();
                    if let Some(p) = me.paths.take() {
                        unlock_slot(&p);
                    }
                    me.paths = Some(o.clone());
                    me.storage = None;
                    eprintln!(
                        "[trommi] not joined: this session keeps the key it had (slot {})",
                        o.slot
                    );
                }
                let mut me = self.me.lock().unwrap();
                if me.phase == "joining" {
                    me.phase = "needs-invite".into();
                }
                me.error = Some(e.text());
                return Err(e);
            }
        };
        {
            let mut me = self.me.lock().unwrap();
            if let Some(p) = me.paths.as_mut() {
                p.has_key = true;
            }
            me.out = None;
        }
        let p = self.paths().unwrap();
        write_owner(
            &p,
            &owner_record(&self.cfg.owner, if cli { None } else { Some(ppid()) }),
        );
        if let Some(before) = old.clone().or(held.clone()) {
            // The earlier device's id is in its state, which its connector holds locked; it is not named here.
            let was_id: Option<String> = None;
            let gone = old.is_none() && !before.key_file.exists();
            if gone {
                let name = before
                    .key_file
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                let mut found: Vec<String> = std::fs::read_dir(&before.dir)
                    .map(|d| {
                        d.flatten()
                            .map(|e| e.file_name().to_string_lossy().to_string())
                            .filter(|f| {
                                f.starts_with("replaced-") && f.ends_with(&format!("-{name}"))
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                found.sort();
                let aside = found
                    .last()
                    .map(|a| before.dir.join(a).display().to_string())
                    .unwrap_or_else(|| "replaced-…".into());
                eprintln!("[trommi] this session was another device before (slot {}); that key is put aside as {aside} (its connector found it retired) and this session uses the new one from now on.", before.slot);
            } else {
                let free = if old.is_some() {
                    true
                } else {
                    let r = knock(
                        &before,
                        &json!({ "op": "replaced", "ancestors": ancestors(8) }),
                        10_000,
                    )
                    .await;
                    r.is_ok_and(|r| r["ok"] == Value::Bool(true))
                        && claim_slot(&before, &self.cfg.session, self.cfg.takeover_ms)
                            .await
                            .ok
                };
                let owner = owner_of(&before).and_then(|r| r["owner"].as_str().map(String::from));
                let foreign = old.is_none()
                    && owner.as_ref().is_some_and(|o| !o.is_empty())
                    && !self.cfg.owner.is_empty()
                    && owner.as_deref() != Some(self.cfg.owner.as_str());
                let aside = if free && !foreign {
                    Some(set_slot_aside(&before, None))
                } else {
                    None
                };
                if free {
                    unlock_slot(&before);
                }
                let dev = was_id
                    .as_ref()
                    .map(|d| format!("device {}…", &d[..12]))
                    .unwrap_or_else(|| "another device".into());
                if foreign && free {
                    eprintln!("[trommi] this session's connector ran on another session's key (slot {}, device {}…); it gave that key back, which stays where it is, and this session uses the new one from now on.", before.slot, was_id.as_deref().map(|d| &d[..12]).unwrap_or("?"));
                } else {
                    eprintln!("[trommi] this session was {dev} before (slot {}); {}. The old device is still a member of the room: remove it under Agents & devices → Devices in the Trommi app if you no longer need it.", before.slot,
                        match &aside { Some(a) => format!("that key is put aside as {} and this session uses the new one from now on", a.display()), None => "its connector did not give that key up: restart this Claude Code session to use the new key".into() });
                }
            }
        }
        let r = self.run(client, rx).await;
        if let Err(e) = &r {
            let mut me = self.me.lock().unwrap();
            if me.phase == "joining" {
                me.phase = "needs-invite".into();
            }
            me.error = Some(e.text());
        }
        r
    }

    /// Give up what this process holds of the slot.
    async fn drop_key(&self) {
        let c = {
            let mut me = self.me.lock().unwrap();
            me.session = None;
            me.client.take()
        };
        if let Some(c) = c {
            let _ = c.settle(3000).await;
            c.stop().await;
        }
        let mut me = self.me.lock().unwrap();
        if let Some(p) = me.paths.take() {
            unlock_slot(&p);
        }
        me.storage = None;
    }

    /// Take the key, if this process has none. Never fails: what went wrong is in me.error.
    pub async fn claim(self: &Arc<Self>, ask: bool) {
        let _g = self.op.lock().await;
        let (phase, keyless) = {
            let me = self.me.lock().unwrap();
            let keyless = me.phase == "needs-invite"
                && !me.joining
                && me
                    .paths
                    .as_ref()
                    .is_some_and(|p| !p.has_key && !p.busy.is_empty());
            (me.phase.clone(), keyless)
        };
        if phase != "asleep" && !keyless && phase != "retired" {
            return;
        }
        // A device the hub refuses (unverified) stays stopped in this process: its state is kept, and trying
        // again is a restart's or a new invite's.
        let refused = self
            .me
            .lock()
            .unwrap()
            .out
            .as_ref()
            .is_some_and(|out| out["verified"] == Value::Bool(false));
        if phase == "retired" && refused {
            return;
        }
        // What answered last was no hub of this protocol: it is not asked again with every call, only after
        // a pause. The reason stays in `me.error`.
        let since =
            now_ms().saturating_sub(self.no_hub_at.load(std::sync::atomic::Ordering::SeqCst));
        if phase == "asleep" && since < NO_HUB_PAUSE_MS {
            return;
        }
        {
            let mut me = self.me.lock().unwrap();
            if let Some(p) = me.paths.take() {
                unlock_slot(&p);
            }
            me.storage = None;
            me.error = None;
            me.phase = "starting".into();
        }
        if let Err(e) = self.open(ask).await {
            if e.code == "hub-unusable" {
                self.no_hub_at
                    .store(now_ms(), std::sync::atomic::Ordering::SeqCst);
            }
            if self.phase() == "retired" {
                return;
            }
            let starting = {
                let mut me = self.me.lock().unwrap();
                me.error = Some(e.text());
                if e.code == "client-too-old" {
                    me.phase = "too-old".into();
                }
                me.phase == "starting"
            };
            if starting {
                self.drop_key().await;
                self.set_phase("asleep");
            }
            eprintln!("[trommi] not connected: {}", e.text());
        }
    }
    /// Hand the key back: afterwards this process sleeps and holds nothing.
    pub async fn release(&self) {
        self.set_phase("asleep");
        self.drop_key().await;
    }
    pub async fn stop(&self) {
        let c = self.client();
        if let Some(c) = c {
            c.stop().await;
        }
        if let Some(p) = self.paths() {
            unlock_slot(&p);
        }
    }
}
