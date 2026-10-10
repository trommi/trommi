//! The hub's updater: the one thing on the server that changes which hub runs.
//!
//! A caller only names a release (`hub-v123`). The updater fetches that release from GitHub itself, checks the
//! signature of its manifest against the public key pinned on the server, checks the binary against the manifest,
//! puts it beside the running one, swaps, asks the new hub whether it is well, and puts the old one back when it is
//! not. Nothing a caller sends is ever run, and nothing older than what was already accepted is taken.
//!
//! On disk, under the root (`/srv/trommi/deploy`), which belongs to the user the updater runs as:
//!
//! ```text
//! releases/hub-v123/trommi-hub           the hub                 current  -> releases/hub-v123
//! releases/hub-v123/trommi-hub-updater   this program            previous -> releases/hub-v122
//! releases/hub-v123/manifest.json(.sig)  what was signed         updater  -> releases/hub-v123
//! state.json                             the highest version     updater-previous -> releases/hub-v122
//! deploy.lock                            one deploy at a time, across processes
//! deploy-journal.json                    there while the hub is being swapped: what to go back to
//! updater-trial, updater-reverted        a new updater on trial; one that did not come up (see `stage_updater`)
//! ```
//!
//! The updater has no rights beyond that folder. It is not root: it cannot change a unit, and it starts and stops
//! the hub only by asking a small helper for exactly that (`HubCtl`). The hub's unit is fixed on the server and
//! runs `current/trommi-hub` as the hub's own user, so what a release can do is what the hub can do. The hub's
//! data is not the updater's to read: the copy of the database before another release starts is made by the hub's
//! unit (`hub/deploy/hub-prestart.sh`).
//!
//! The pinned public key and the configuration live in `/etc/trommi` (root's) and never come from a release.

#![forbid(unsafe_code)]

use std::io::Write;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const PRODUCT: &str = "trommi-hub";
pub const MANIFEST: &str = "manifest.json";
pub const SIGNATURE: &str = "manifest.json.sig";
/// the names inside a release folder; the two programs are released with the machine's kind after their name
pub const BINARY: &str = "trommi-hub";
pub const UPDATER: &str = "trommi-hub-updater";

const RELEASE_CAP: u64 = 1 << 20;
const MANIFEST_CAP: u64 = 64 << 10;
const SIGNATURE_CAP: u64 = 1 << 10;
const BINARY_CAP: u64 = 200 << 20;

// ---------------------------------------------------------------------------------------------------------------
// What is signed
// ---------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Asset {
    pub name: String,
    pub sha256: String,
    pub size: u64,
}

/// The signed statement of a release. The signature covers the exact bytes of the file. Fields this updater does
/// not know are ignored (they are signed all the same), so a later release may say more without an older updater
/// refusing it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Manifest {
    pub product: String,
    pub repository: String,
    pub version: u64,
    pub tag: String,
    pub commit: String,
    pub assets: Vec<Asset>,
    /// what each program was built from; releases without it are decided by the programs' bytes (see `changes`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inputs: Option<Inputs>,
}

/// `"inputs": {"hub": "<sha256>", "updater": "<sha256>"}`: per program, a SHA-256 over everything its build reads
/// (sources, lockfile, toolchain). Two releases with the same value hold the same program, whatever their bytes.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Inputs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hub: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updater: Option<String>,
}

/// One of the two programs of a release.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Part {
    Hub,
    Updater,
}

/// THE decision whether going from the release `from` to `to` changes a program, so that it has to be started
/// anew. When both manifests name the program's inputs, those decide; otherwise the SHA-256 the manifests give for
/// the program's file on this machine's kind. Nothing known about `from` counts as a change.
///
/// Today the updater is replaced by it (`stage_updater`); the hub is still started anew with every release that is
/// not the one running. With one complete release per shipped change, the hub's swap asks it as well.
pub fn changes(part: Part, target: &str, from: Option<&Manifest>, to: &Manifest) -> bool {
    let Some(from) = from else {
        return true;
    };
    let inputs = |m: &Manifest| {
        m.inputs.as_ref().and_then(|i| match part {
            Part::Hub => i.hub.clone(),
            Part::Updater => i.updater.clone(),
        })
    };
    if let (Some(a), Some(b)) = (inputs(from), inputs(to)) {
        return a != b;
    }
    let name = match part {
        Part::Hub => format!("{BINARY}-{target}"),
        Part::Updater => format!("{UPDATER}-{target}"),
    };
    let sha256 = |m: &Manifest| {
        m.assets
            .iter()
            .find(|a| a.name == name)
            .map(|a| a.sha256.clone())
    };
    match (sha256(from), sha256(to)) {
        (Some(a), Some(b)) => a != b,
        _ => true,
    }
}

/// `hub-v123` → 123. One spelling only: no sign, no leading zero, at most twelve digits.
pub fn parse_tag(tag: &str) -> Option<u64> {
    let digits = tag.strip_prefix("hub-v")?;
    let plain = !digits.is_empty()
        && digits.len() <= 12
        && digits.bytes().all(|b| b.is_ascii_digit())
        && !digits.starts_with('0');
    if plain {
        digits.parse().ok()
    } else {
        None
    }
}

/// The two files of a release this server takes: the asset's name, its name in the release folder, the most it
/// may weigh, whether it is a program. Whatever else a release holds is left at GitHub.
pub fn wanted(target: &str) -> [(String, &'static str, u64, bool); 2] {
    [
        (format!("{BINARY}-{target}"), BINARY, BINARY_CAP, true),
        (format!("{UPDATER}-{target}"), UPDATER, BINARY_CAP, true),
    ]
}

/// The manifest's entry for an asset: exactly one, and usable.
fn entry<'a>(manifest: &'a Manifest, name: &str, cap: u64) -> Result<&'a Asset, String> {
    let found: Vec<&Asset> = manifest.assets.iter().filter(|a| a.name == name).collect();
    match found.as_slice() {
        [a] if a.size > 0 && a.size <= cap && is_hex(&a.sha256, 64) => Ok(a),
        [_] => Err(format!("the manifest's entry for {name} is not usable")),
        _ => Err(format!("the manifest does not name exactly one {name}")),
    }
}

/// An Ed25519 public key in PEM form (`-----BEGIN PUBLIC KEY-----`), as `openssl pkey -pubout` writes it.
pub fn public_key(pem: &str) -> Result<VerifyingKey, String> {
    let body: String = pem
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .flat_map(|l| l.chars())
        .filter(|c| !c.is_whitespace())
        .collect();
    let der = base64::engine::general_purpose::STANDARD
        .decode(body)
        .map_err(|_| "the public key is not base64".to_string())?;
    // SubjectPublicKeyInfo of an Ed25519 key: this prefix, then the 32 bytes
    const PREFIX: [u8; 12] = [
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    if der.len() != 44 || der[..12] != PREFIX {
        return Err("the public key is not an Ed25519 key".into());
    }
    let raw: [u8; 32] = der[12..].try_into().expect("32 bytes");
    VerifyingKey::from_bytes(&raw).map_err(|_| "the public key is not a point".to_string())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn is_hex(text: &str, len: usize) -> bool {
    text.len() == len
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The signature first, over the bytes as they came; only then is anything in them read. After that the manifest
/// must be about this product, this repository and exactly the release that was asked for.
pub fn verify_manifest(
    key: &VerifyingKey,
    bytes: &[u8],
    signature: &[u8],
    repository: &str,
    tag: &str,
) -> Result<Manifest, String> {
    let signature = Signature::from_slice(signature)
        .map_err(|_| "the signature is not 64 bytes".to_string())?;
    key.verify_strict(bytes, &signature)
        .map_err(|_| "the signature does not match the pinned key".to_string())?;
    let manifest: Manifest = serde_json::from_slice(bytes)
        .map_err(|e| format!("the manifest is signed but unreadable: {e}"))?;
    if manifest.product != PRODUCT {
        return Err(format!("signed for another product: {}", manifest.product));
    }
    if manifest.repository != repository {
        return Err(format!(
            "signed for another repository: {}",
            manifest.repository
        ));
    }
    if manifest.tag != tag || parse_tag(tag) != Some(manifest.version) {
        return Err(format!(
            "signed for another release: {} (version {})",
            manifest.tag, manifest.version
        ));
    }
    if !is_hex(&manifest.commit, 40) {
        return Err("the manifest names no commit".into());
    }
    Ok(manifest)
}

// ---------------------------------------------------------------------------------------------------------------
// Configuration, the service, the answer
// ---------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Config {
    /// `owner/name` at GitHub
    pub repository: String,
    /// `https://api.github.com`
    pub api: String,
    pub key: VerifyingKey,
    /// e.g. `x86_64-unknown-linux-musl`
    pub target: String,
    pub root: PathBuf,
    pub health_url: String,
    /// how long a freshly started hub has to become well
    pub health_wait: Duration,
    pub health_every: Duration,
    /// how long a call waits for a deploy that is already running
    pub lock_wait: Duration,
}

/// Starting and stopping the hub: all the updater may ask of the machine.
pub trait Service: Send + Sync {
    fn stop(&self) -> Result<(), String>;
    fn start(&self) -> Result<(), String>;
}

/// Runs a command and waits no longer than `limit` for it.
pub fn run(program: &str, args: &[&str], limit: Duration) -> Result<Vec<u8>, String> {
    use std::process::{Command, Stdio};
    let name = format!("{program} {}", args.first().copied().unwrap_or(""));
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{name}: {e}"))?;
    let began = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if began.elapsed() < limit => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{name}: no end after {} s", limit.as_secs()));
            }
            Err(e) => return Err(format!("{name}: {e}")),
        }
    }
    // the commands used here say little: their output fits the pipe, so reading after the end cannot block
    let out = child
        .wait_with_output()
        .map_err(|e| format!("{name}: {e}"))?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(format!(
            "{name}: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// The server's helper for the hub's unit (`hub/deploy/hub-ctl.sh` behind `trommi-hub-ctl.socket`): a socket only
/// the updater's user may open, which takes one word, `start` or `stop`, does that to the hub's unit as root, and
/// answers `ok` or `failed: …`. It takes nothing else, so this is everything the updater can have root do.
pub struct HubCtl {
    pub socket: PathBuf,
}

impl HubCtl {
    fn ask(&self, verb: &str) -> Result<(), String> {
        use std::io::Read;
        let fail = |e: std::io::Error| format!("hub helper ({verb}): {e}");
        let mut stream = std::os::unix::net::UnixStream::connect(&self.socket).map_err(fail)?;
        // systemd gives a unit 90 s to start and the hub 30 s to stop; the helper answers within that
        stream
            .set_read_timeout(Some(Duration::from_secs(150)))
            .map_err(fail)?;
        stream
            .write_all(format!("{verb}\n").as_bytes())
            .map_err(fail)?;
        stream.shutdown(std::net::Shutdown::Write).map_err(fail)?;
        let mut answer = String::new();
        stream
            .take(4096)
            .read_to_string(&mut answer)
            .map_err(fail)?;
        match answer.trim() {
            "ok" => Ok(()),
            "" => Err(format!("hub helper ({verb}): no answer")),
            other => Err(format!("hub helper ({verb}): {other}")),
        }
    }
}

impl Service for HubCtl {
    fn stop(&self) -> Result<(), String> {
        self.ask("stop")
    }
    fn start(&self) -> Result<(), String> {
        self.ask("start")
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Health {
    pub ok: bool,
    pub commit: Option<String>,
    pub seconds: u64,
    pub detail: String,
}

impl Health {
    fn failed(detail: String) -> Self {
        Health {
            ok: false,
            commit: None,
            seconds: 0,
            detail,
        }
    }
}

/// Which updater runs, and what is about to change about it.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct UpdaterState {
    /// the release the updater that answers is from
    pub release: Option<String>,
    /// set when this deploy brought a different updater: it takes over right after this answer
    pub next: Option<String>,
    /// a release whose updater was tried and did not come up; the one before was put back
    pub reverted: Option<String>,
}

/// The answer to a deploy call. `ok` is true only when the release asked for runs and is well.
#[derive(Debug, Clone, Serialize)]
pub struct Outcome {
    pub ok: bool,
    /// deployed · unchanged · restarted · refused · bad-request · not-verified · fetch-failed · rolled-back ·
    /// failed · busy
    pub result: &'static str,
    pub tag: String,
    pub version: Option<u64>,
    pub commit: Option<String>,
    /// of the hub binary
    pub sha256: Option<String>,
    /// the release that runs now
    pub running: Option<String>,
    pub health: Option<Health>,
    /// after a rollback: whether the release put back is well
    pub rollback_health: Option<Health>,
    pub updater: UpdaterState,
    pub message: String,
}

impl Outcome {
    fn new(result: &'static str, tag: &str, message: impl Into<String>) -> Self {
        Outcome {
            ok: matches!(result, "deployed" | "unchanged" | "restarted"),
            result,
            tag: tag.to_string(),
            version: parse_tag(tag),
            commit: None,
            sha256: None,
            running: None,
            health: None,
            rollback_health: None,
            updater: UpdaterState::default(),
            message: message.into(),
        }
    }

    pub fn http_status(&self) -> u16 {
        match self.result {
            _ if self.ok => 200,
            "bad-request" => 400,
            "refused" => 409,
            "not-verified" => 422,
            "fetch-failed" => 502,
            "busy" => 503,
            _ => 500,
        }
    }
}

enum Failure {
    Fetch(String),
    Verify(String),
    Local(String),
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct State {
    high_water: u64,
}

/// Written before the hub is stopped for a swap and removed when the swap is settled either way. Found at start,
/// it means the updater (or the machine) went down in between: the hub is put back to `old`.
#[derive(Debug, Serialize, Deserialize)]
struct Journal {
    tag: String,
    old: Option<String>,
    old_previous: Option<String>,
    /// set once the new release was found not well: it is never taken after that, whatever it answers later
    #[serde(default)]
    rejected: bool,
}

pub fn log(event: &str, fields: Value) {
    let at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    eprintln!("{}", json!({ "at": at, "event": event, "fields": fields }));
}

fn sync_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::File::open(dir)?.sync_all()
}

/// Writes a small file so that it is either the old or the new one, also after a power cut.
fn write_whole(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let part = path.with_extension("part");
    let mut f = std::fs::File::create(&part)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    std::fs::rename(&part, path)?;
    sync_dir(path.parent().unwrap_or(Path::new(".")))
}

fn remove_whole(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => sync_dir(path.parent().unwrap_or(Path::new("."))),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The updater
// ---------------------------------------------------------------------------------------------------------------

pub struct Updater {
    pub cfg: Config,
    service: Arc<dyn Service>,
    client: reqwest::Client,
    gate: tokio::sync::Mutex<()>,
    /// the release this running updater is from (the `updater` link when it started)
    own_release: Option<String>,
    /// set once a deploy has put another updater in place: the process ends after it has answered
    replaced: std::sync::atomic::AtomicBool,
}

struct Running {
    tag: String,
    version: u64,
    /// none when the stored manifest no longer verifies
    manifest: Option<Manifest>,
}

impl Updater {
    pub fn new(cfg: Config, service: Arc<dyn Service>) -> Result<Arc<Self>, String> {
        let client = reqwest::Client::builder()
            .user_agent("trommi-hub-updater")
            .no_proxy()
            .connect_timeout(Duration::from_secs(10))
            // the whole of one request, body included: a stalled download ends here
            .timeout(Duration::from_secs(300))
            .build()
            .map_err(|e| format!("http client: {e}"))?;
        std::fs::create_dir_all(cfg.root.join("releases"))
            .map_err(|e| format!("{}: {e}", cfg.root.display()))?;
        let mut updater = Updater {
            cfg,
            service,
            client,
            gate: tokio::sync::Mutex::new(()),
            own_release: None,
            replaced: std::sync::atomic::AtomicBool::new(false),
        };
        updater.own_release = updater.linked("updater");
        Ok(Arc::new(updater))
    }

    fn releases(&self) -> PathBuf {
        self.cfg.root.join("releases")
    }

    // ---- state on disk ----

    fn read_state(&self) -> Result<State, String> {
        match std::fs::read(self.cfg.root.join("state.json")) {
            Ok(bytes) => {
                serde_json::from_slice(&bytes).map_err(|e| format!("state.json is unreadable: {e}"))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(State::default()),
            Err(e) => Err(format!("state.json: {e}")),
        }
    }

    /// The release a link (`current`, `previous`, `updater`, `updater-previous`) points at.
    fn linked(&self, link: &str) -> Option<String> {
        let target = std::fs::read_link(self.cfg.root.join(link)).ok()?;
        let tag = target.file_name()?.to_str()?.to_string();
        parse_tag(&tag).map(|_| tag)
    }

    /// Points a link at a release (or takes it away), in one step: a new link is made beside it and renamed over.
    fn point(&self, link: &str, tag: Option<&str>) -> Result<(), String> {
        if self.linked(link).as_deref() == tag
            && (tag.is_some() || !self.cfg.root.join(link).exists())
        {
            return Ok(());
        }
        let path = self.cfg.root.join(link);
        let run = || -> std::io::Result<()> {
            match tag {
                Some(tag) => {
                    let part = self.cfg.root.join(format!("{link}.part"));
                    let _ = std::fs::remove_file(&part);
                    std::os::unix::fs::symlink(Path::new("releases").join(tag), &part)?;
                    std::fs::rename(&part, &path)?;
                    sync_dir(&self.cfg.root)
                }
                None => remove_whole(&path),
            }
        };
        run().map_err(|e| format!("link {link}: {e}"))
    }

    /// Proves a release folder from what is on disk: the signature of its manifest, then each of the three files
    /// against the manifest. Gives the manifest and the hub binary's SHA-256.
    fn proved(&self, dir: &Path, tag: &str) -> Result<(Manifest, String), String> {
        let bytes = std::fs::read(dir.join(MANIFEST)).map_err(|e| format!("{MANIFEST}: {e}"))?;
        let signature =
            std::fs::read(dir.join(SIGNATURE)).map_err(|e| format!("{SIGNATURE}: {e}"))?;
        let manifest =
            verify_manifest(&self.cfg.key, &bytes, &signature, &self.cfg.repository, tag)?;
        let mut hub = String::new();
        for (asset, stored, cap, _) in wanted(&self.cfg.target) {
            let entry = entry(&manifest, &asset, cap)?;
            let path = dir.join(stored);
            let size = std::fs::metadata(&path)
                .map_err(|e| format!("{stored}: {e}"))?
                .len();
            let sha256 = file_sha256(&path).ok_or_else(|| format!("{stored}: unreadable"))?;
            if size != entry.size || sha256 != entry.sha256 {
                return Err(format!(
                    "{asset} is not the file the manifest names (size {size}, sha256 {sha256})"
                ));
            }
            if stored == BINARY {
                hub = sha256;
            }
        }
        Ok((manifest, hub))
    }

    fn stored_manifest(&self, tag: &str) -> Option<Manifest> {
        let dir = self.releases().join(tag);
        let bytes = std::fs::read(dir.join(MANIFEST)).ok()?;
        let signature = std::fs::read(dir.join(SIGNATURE)).ok()?;
        verify_manifest(&self.cfg.key, &bytes, &signature, &self.cfg.repository, tag).ok()
    }

    fn running(&self) -> Option<Running> {
        let tag = self.linked("current")?;
        Some(Running {
            version: parse_tag(&tag)?,
            manifest: self.stored_manifest(&tag),
            tag,
        })
    }

    // ---- the service and its health ----

    async fn service(&self, what: fn(&dyn Service) -> Result<(), String>) -> Result<(), String> {
        let service = self.service.clone();
        tokio::task::spawn_blocking(move || what(service.as_ref()))
            .await
            .map_err(|e| format!("service: {e}"))?
    }

    async fn stop(&self) -> Result<(), String> {
        self.service(|s| s.stop()).await
    }

    async fn start(&self) -> Result<(), String> {
        self.service(|s| s.start()).await
    }

    /// One question to the hub: is it well, and which commit is it.
    async fn ask(&self) -> Result<(bool, Option<String>), String> {
        let answer = self
            .client
            .get(&self.cfg.health_url)
            .timeout(Duration::from_secs(3))
            .send()
            .await
            .map_err(|e| format!("no answer: {}", plain(&e)))?;
        let status = answer.status().as_u16();
        let body = read_capped(answer, 64 << 10)
            .await
            .map_err(|e| format!("answer: {e}"))?;
        let value: Value =
            serde_json::from_slice(&body).map_err(|_| format!("status {status}, not JSON"))?;
        let commit = value["commit"].as_str().map(str::to_string);
        Ok((status == 200 && value["ok"] == json!(true), commit))
    }

    /// Asks until the hub is well and is the commit expected, or the time is up.
    async fn wait_healthy(&self, commit: Option<&str>) -> Health {
        let began = Instant::now();
        loop {
            let last = match self.ask().await {
                Ok((true, got)) if commit.is_none() || got.as_deref() == commit => {
                    return Health {
                        ok: true,
                        commit: got,
                        seconds: began.elapsed().as_secs(),
                        detail: "well".into(),
                    };
                }
                Ok((true, got)) => {
                    let detail = format!(
                        "answers as commit {}, expected {}",
                        got.as_deref().unwrap_or("?"),
                        commit.unwrap_or("?")
                    );
                    (got, detail)
                }
                Ok((false, got)) => (got, "answers, but says it is not well".to_string()),
                Err(e) => (None, e),
            };
            if began.elapsed() >= self.cfg.health_wait {
                return Health {
                    ok: false,
                    commit: last.0,
                    seconds: began.elapsed().as_secs(),
                    detail: last.1,
                };
            }
            tokio::time::sleep(self.cfg.health_every).await;
        }
    }

    async fn started_healthy(&self, commit: Option<&str>) -> Health {
        match self.start().await {
            Ok(()) => self.wait_healthy(commit).await,
            Err(e) => Health::failed(e),
        }
    }

    // ---- fetching ----

    async fn get(&self, url: &str, accept: &str) -> Result<reqwest::Response, String> {
        let answer = self
            .client
            .get(url)
            .header("accept", accept)
            .header("x-github-api-version", "2022-11-28")
            .send()
            .await
            .map_err(|e| format!("GitHub did not answer: {}", plain(&e)))?;
        if answer.status().as_u16() != 200 {
            return Err(format!("GitHub answered {}", answer.status().as_u16()));
        }
        Ok(answer)
    }

    /// Fetches the release into `dir`: manifest and signature first; the files only after those hold, and never
    /// more bytes of a file than the manifest says it has. `proved` then checks the folder as a whole.
    async fn fetch(&self, tag: &str, dir: &Path) -> Result<(), Failure> {
        let (api, repository) = (&self.cfg.api, &self.cfg.repository);
        let release = self
            .get(
                &format!("{api}/repos/{repository}/releases/tags/{tag}"),
                "application/vnd.github+json",
            )
            .await
            .map_err(|e| Failure::Fetch(format!("release {tag}: {e}")))?;
        let release = read_capped(release, RELEASE_CAP)
            .await
            .map_err(|e| Failure::Fetch(format!("release {tag}: {e}")))?;
        let release: Value = serde_json::from_slice(&release)
            .map_err(|_| Failure::Fetch(format!("release {tag}: not JSON")))?;
        if release["tag_name"].as_str() != Some(tag) {
            return Err(Failure::Fetch(format!(
                "release {tag}: GitHub answered with another release"
            )));
        }
        if release["draft"] == json!(true) {
            return Err(Failure::Fetch(format!("release {tag} is a draft")));
        }
        // an asset is taken by its exact name and only from this repository's own asset addresses
        let assets_at = format!("{api}/repos/{repository}/releases/assets/");
        let asset_url = |name: &str| -> Result<String, Failure> {
            let found: Vec<&str> = release["assets"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|a| a["name"].as_str() == Some(name))
                .filter_map(|a| a["url"].as_str())
                .collect();
            match found.as_slice() {
                [url]
                    if url.starts_with(&assets_at)
                        && url[assets_at.len()..].bytes().all(|b| b.is_ascii_digit()) =>
                {
                    Ok(url.to_string())
                }
                [] => Err(Failure::Fetch(format!("release {tag} has no asset {name}"))),
                _ => Err(Failure::Fetch(format!(
                    "release {tag}: asset {name} is not at an address of this repository"
                ))),
            }
        };
        let local = |e: std::io::Error| Failure::Local(format!("writing the release: {e}"));
        // one file: at most `cap` bytes, written and flushed to disk
        let download = |url: String, name: String, to: PathBuf, cap: u64, program: bool| async move {
            let mut answer = self
                .get(&url, "application/octet-stream")
                .await
                .map_err(|e| Failure::Fetch(format!("{name}: {e}")))?;
            let mut file = std::fs::File::create(&to).map_err(local)?;
            let mut size = 0u64;
            while let Some(chunk) = answer
                .chunk()
                .await
                .map_err(|e| Failure::Fetch(format!("{name}: {}", plain(&e))))?
            {
                size += chunk.len() as u64;
                if size > cap {
                    return Err(Failure::Verify(format!("{name} is longer than it may be")));
                }
                file.write_all(&chunk).map_err(local)?;
            }
            use std::os::unix::fs::PermissionsExt;
            let mode = if program { 0o755 } else { 0o644 };
            file.set_permissions(std::fs::Permissions::from_mode(mode))
                .map_err(local)?;
            file.sync_all().map_err(local)
        };
        for (name, cap) in [(MANIFEST, MANIFEST_CAP), (SIGNATURE, SIGNATURE_CAP)] {
            download(asset_url(name)?, name.into(), dir.join(name), cap, false).await?;
        }
        let read = |name: &str| std::fs::read(dir.join(name)).map_err(local);
        let manifest = verify_manifest(
            &self.cfg.key,
            &read(MANIFEST)?,
            &read(SIGNATURE)?,
            repository,
            tag,
        )
        .map_err(Failure::Verify)?;
        for (asset, stored, cap, program) in wanted(&self.cfg.target) {
            let size = entry(&manifest, &asset, cap).map_err(Failure::Verify)?.size;
            download(asset_url(&asset)?, asset, dir.join(stored), size, program).await?;
        }
        sync_dir(dir).map_err(local)
    }

    /// The release, proved, in its folder `releases/<tag>`: the one already there when it still proves (nothing is
    /// fetched then), otherwise fetched from GitHub.
    async fn obtain(&self, tag: &str) -> Result<(Manifest, String), Failure> {
        let dir = self.releases().join(tag);
        if dir.exists() {
            match self.proved(&dir, tag) {
                Ok(proved) => return Ok(proved),
                Err(e) => {
                    let used = ["current", "previous", "updater", "updater-previous"]
                        .iter()
                        .any(|l| self.linked(l).as_deref() == Some(tag));
                    if used {
                        return Err(Failure::Local(format!(
                            "the stored copy of {tag} is in use and damaged: {e}"
                        )));
                    }
                    std::fs::remove_dir_all(&dir)
                        .map_err(|e| Failure::Local(format!("releases: {e}")))?;
                }
            }
        }
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let tmp = self
            .releases()
            .join(format!(".tmp-{tag}-{}-{unique}", std::process::id()));
        let result = async {
            std::fs::create_dir_all(&tmp).map_err(|e| Failure::Local(format!("releases: {e}")))?;
            self.fetch(tag, &tmp).await?;
            let proved = self.proved(&tmp, tag).map_err(Failure::Verify)?;
            std::fs::rename(&tmp, &dir)
                .and_then(|()| sync_dir(&self.releases()))
                .map_err(|e| Failure::Local(format!("releases: {e}")))?;
            Ok(proved)
        }
        .await;
        if result.is_err() {
            let _ = std::fs::remove_dir_all(&tmp);
        }
        result
    }

    // ---- tidying ----

    /// Removes what a fetch that was cut off left behind.
    fn tidy(&self) {
        for entry in std::fs::read_dir(self.releases())
            .into_iter()
            .flatten()
            .flatten()
        {
            if entry.file_name().to_string_lossy().starts_with(".tmp-") {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }

    /// After a deploy that went well: removes every release folder no link points at.
    fn prune(&self) {
        let keep: Vec<String> = ["current", "previous", "updater", "updater-previous"]
            .iter()
            .filter_map(|l| self.linked(l))
            .collect();
        for entry in std::fs::read_dir(self.releases())
            .into_iter()
            .flatten()
            .flatten()
        {
            let name = entry.file_name().to_string_lossy().to_string();
            if !keep.contains(&name) {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }

    // ---- one deploy at a time ----

    /// The lock other processes see (the command line on the server uses the same one).
    async fn file_lock(&self) -> Result<std::fs::File, String> {
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(self.cfg.root.join("deploy.lock"))
            .map_err(|e| format!("deploy.lock: {e}"))?;
        let began = Instant::now();
        loop {
            match file.try_lock() {
                Ok(()) => return Ok(file),
                Err(std::fs::TryLockError::WouldBlock) => {}
                Err(std::fs::TryLockError::Error(e)) => return Err(format!("deploy.lock: {e}")),
            }
            if began.elapsed() >= self.cfg.lock_wait {
                return Err("another deploy is still running".into());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// Makes `tag` the running release, and puts its updater in place when that differs from the one running.
    pub async fn deploy(&self, tag: &str) -> Outcome {
        let Some(version) = parse_tag(tag) else {
            // not echoed: it is not a release name
            return Outcome::new("bad-request", "", "the tag must look like hub-v123");
        };
        let Ok(_turn) = tokio::time::timeout(self.cfg.lock_wait, self.gate.lock()).await else {
            return Outcome::new("busy", tag, "another deploy is still running");
        };
        let _lock = match self.file_lock().await {
            Ok(lock) => lock,
            Err(e) => return Outcome::new("busy", tag, e),
        };
        if self.replaced() || self.cfg.root.join("updater-trial").exists() {
            // a new updater is taking over: it is not given a second change before it has shown that it is up
            return Outcome::new(
                "busy",
                tag,
                "the updater is being replaced; call again in a minute",
            );
        }
        log("deploy", json!({ "tag": tag }));
        // a swap that was cut off earlier is settled before a new one begins
        if !self.settle().await {
            return Outcome::new(
                "failed",
                tag,
                "an earlier deploy was cut off and could not be undone yet (see the updater's log); nothing was changed",
            );
        }
        let mut outcome = self.deploy_locked(tag, version).await;
        outcome.running = self.linked("current");
        outcome.updater = self.updater_state();
        if outcome.ok {
            match self.stage_updater(tag) {
                Ok(next) => outcome.updater.next = next,
                Err(e) => {
                    outcome.message = format!("{}; its updater was not taken: {e}", outcome.message)
                }
            }
            outcome.updater.reverted = self.reverted();
        }
        log(
            "deploy-end",
            serde_json::to_value(&outcome).unwrap_or(Value::Null),
        );
        outcome
    }

    async fn deploy_locked(&self, tag: &str, version: u64) -> Outcome {
        let state = match self.read_state() {
            Ok(state) => state,
            Err(e) => return Outcome::new("failed", tag, e),
        };
        let running = self.running();
        // the floor: the highest version ever accepted, and what runs (should the state file be lost)
        let floor = state
            .high_water
            .max(running.as_ref().map_or(0, |r| r.version));
        // asking for what runs changes nothing, whatever the floor is
        if running.as_ref().is_some_and(|r| r.tag == tag) {
            return self.same_again(tag).await;
        }
        if version < floor {
            return Outcome::new(
                "refused",
                tag,
                format!("older than hub-v{floor}, which this server already accepted"),
            );
        }

        // fetch and prove, beside what runs; nothing that serves is touched until this holds
        let (manifest, sha256) = match self.obtain(tag).await {
            Ok(proved) => proved,
            Err(Failure::Fetch(m)) => return Outcome::new("fetch-failed", tag, m),
            Err(Failure::Verify(m)) => return Outcome::new("not-verified", tag, m),
            Err(Failure::Local(m)) => return Outcome::new("failed", tag, m),
        };
        let mut outcome = Outcome::new("failed", tag, "");
        outcome.commit = Some(manifest.commit.clone());
        outcome.sha256 = Some(sha256);
        let fail = |mut outcome: Outcome, message: String| {
            outcome.message = message;
            outcome
        };

        // from here on nothing older is taken, also when this release turns out not to be well
        let old = running.as_ref().map(|r| r.tag.clone());
        let mut journal = Journal {
            tag: tag.to_string(),
            old: old.clone(),
            old_previous: self.linked("previous"),
            rejected: false,
        };
        let noted = (|| -> std::io::Result<()> {
            if version > state.high_water {
                let state = State {
                    high_water: version,
                };
                write_whole(
                    &self.cfg.root.join("state.json"),
                    &serde_json::to_vec(&state).expect("a state"),
                )?;
            }
            write_whole(
                &self.cfg.root.join("deploy-journal.json"),
                &serde_json::to_vec(&journal).expect("a journal"),
            )
        })();
        if let Err(e) = noted {
            return fail(outcome, format!("nothing was changed: {e}"));
        }

        // stand still, swap, start (the hub's unit copies the database before another release starts)
        let swapped = async {
            self.stop().await?;
            self.point("current", Some(tag))?;
            self.point("previous", old.as_deref())
        }
        .await;
        let health = match swapped {
            Ok(()) => self.started_healthy(Some(&manifest.commit)).await,
            Err(e) => Health::failed(e),
        };
        if health.ok {
            outcome.health = Some(health);
            outcome.ok = true;
            outcome.result = "deployed";
            outcome.message = format!("{tag} runs and is well");
            // should the note stay behind, the next start finds the release it names running and well and keeps it
            let _ = remove_whole(&self.cfg.root.join("deploy-journal.json"));
            self.prune();
            return outcome;
        }

        // not well: back to what ran before. The verdict is written down first, so that a start of the updater
        // in the middle of this does not take the release after all.
        journal.rejected = true;
        let _ = write_whole(
            &self.cfg.root.join("deploy-journal.json"),
            &serde_json::to_vec(&journal).expect("a journal"),
        );
        let why = health.detail.clone();
        outcome.health = Some(health);
        let old_commit = running
            .as_ref()
            .and_then(|r| r.manifest.as_ref())
            .map(|m| m.commit.clone());
        let again = self.put_back(&journal, old_commit.as_deref()).await;
        match (&old, again) {
            (None, _) => {
                outcome.message = format!(
                    "{tag} did not become well ({why}); nothing ran before it, the hub is stopped"
                );
            }
            (Some(old), again) => {
                outcome.result = "rolled-back";
                outcome.message = if again.ok {
                    format!("{tag} did not become well ({why}); {old} was put back and is well")
                } else {
                    format!(
                        "{tag} did not become well ({why}); {old} was put back and is NOT well either ({})",
                        again.detail
                    )
                };
                outcome.rollback_health = Some(again);
            }
        }
        // the release that failed is not kept (nothing points at it any more)
        if !self.cfg.root.join("deploy-journal.json").exists() {
            self.prune();
        }
        outcome
    }

    /// Puts the hub back to what the journal says ran before and starts it. The journal goes only when `current`
    /// is back where it was; otherwise it stays, and the next start of the updater tries again.
    async fn put_back(&self, journal: &Journal, commit: Option<&str>) -> Health {
        let _ = self.stop().await;
        let back = self.point("current", journal.old.as_deref());
        if back.is_ok() {
            // the link to the release before that is only a convenience: failing to restore it stops nothing
            let _ = self.point("previous", journal.old_previous.as_deref());
            let _ = remove_whole(&self.cfg.root.join("deploy-journal.json"));
        }
        match (back, &journal.old) {
            (Ok(()), None) => Health::failed("nothing ran before".into()),
            // also when the link could not be put back: whatever `current` names is better than a hub that stands
            (Ok(()), Some(_)) => self.started_healthy(commit).await,
            (Err(e), _) => {
                let _ = self.start().await;
                Health::failed(e)
            }
        }
    }

    /// Settles a swap that was cut off (the updater or the machine went down in the middle): when the release the
    /// note names is the one in place and it runs and is well, the deploy counts as done; otherwise the release
    /// before is put back.
    /// False when the swap could not be settled (the note is still there): no new deploy begins on top of it.
    async fn settle(&self) -> bool {
        let path = self.cfg.root.join("deploy-journal.json");
        let Ok(bytes) = std::fs::read(&path) else {
            return !path.exists();
        };
        let Ok(journal) = serde_json::from_slice::<Journal>(&bytes) else {
            // unreadable: nothing to go by; the hub runs whatever `current` names
            return remove_whole(&path).is_ok();
        };
        let commit_of = |tag: &Option<String>| {
            tag.as_ref()
                .and_then(|t| self.stored_manifest(t))
                .map(|m| m.commit)
        };
        let new = Some(journal.tag.clone());
        let in_place = self.linked("current") == new
            && self
                .proved(&self.releases().join(&journal.tag), &journal.tag)
                .is_ok();
        if in_place && !journal.rejected {
            if let Some(commit) = commit_of(&new) {
                if self.started_healthy(Some(&commit)).await.ok && remove_whole(&path).is_ok() {
                    log("deploy-completed", json!({ "cut_off": journal.tag }));
                    return true;
                }
            }
        }
        let health = self
            .put_back(&journal, commit_of(&journal.old).as_deref())
            .await;
        log(
            "deploy-undone",
            json!({ "cut_off": journal.tag, "back_to": journal.old, "health": health }),
        );
        let settled = !path.exists();
        if settled {
            self.prune();
        }
        settled
    }

    /// The release asked for is the one that runs: nothing is fetched or swapped. A hub that is well is left alone,
    /// so a repeated call costs no restart; one that is not is started again.
    async fn same_again(&self, tag: &str) -> Outcome {
        let (manifest, sha256) = match self.proved(&self.releases().join(tag), tag) {
            Ok(proved) => proved,
            Err(e) => {
                return Outcome::new(
                    "failed",
                    tag,
                    format!("the stored copy of {tag}, which runs, is damaged: {e}; a newer release replaces it"),
                )
            }
        };
        let commit = Some(manifest.commit);
        let mut outcome = Outcome::new("unchanged", tag, format!("{tag} already runs and is well"));
        outcome.commit = commit.clone();
        outcome.sha256 = Some(sha256);
        if let Ok((true, got)) = self.ask().await {
            if got == commit {
                return outcome;
            }
        }
        let _ = self.stop().await;
        let health = self.started_healthy(commit.as_deref()).await;
        outcome.ok = health.ok;
        outcome.result = if health.ok { "restarted" } else { "failed" };
        outcome.message = if health.ok {
            format!("{tag} was not well and was started again")
        } else {
            format!(
                "{tag} runs but is not well after a restart ({})",
                health.detail
            )
        };
        outcome.health = Some(health);
        outcome
    }

    // ---- the updater's own update ----
    //
    // A release brings an updater. When it differs from the one that runs, the deploy that brought it points the
    // `updater` link at the new release, keeps the old one as `updater-previous`, and leaves a trial note. The
    // running process answers its caller and ends; systemd starts the program the link names. The unit's pre-start
    // script (hub/deploy/updater-prestart.sh) counts starts while the trial note is there: a new updater that is up
    // removes the note; if it is still there at the next start, the script points the link back and leaves
    // `updater-reverted`, and the old updater starts and says so.

    fn reverted(&self) -> Option<String> {
        let text = std::fs::read_to_string(self.cfg.root.join("updater-reverted")).ok()?;
        Some(text.trim().to_string()).filter(|t| parse_tag(t).is_some())
    }

    fn updater_state(&self) -> UpdaterState {
        UpdaterState {
            release: self.own_release.clone(),
            next: None,
            reverted: self.reverted(),
        }
    }

    /// Puts the updater of `tag` in place when it is another program than the one in place now. Gives the tag when
    /// the running updater has to end for it.
    fn stage_updater(&self, tag: &str) -> Result<Option<String>, String> {
        let now = self.linked("updater");
        if now.as_deref() == Some(tag)
            || self.replaced()
            || self.cfg.root.join("updater-trial").exists()
        {
            return Ok(None);
        }
        // one that was tried and did not come up is not tried a second time; a later release may bring a better one
        if self.reverted().as_deref() == Some(tag) {
            return Ok(None);
        }
        // both stored manifests are proved by their signature, and their files were proved against them
        let new = self
            .stored_manifest(tag)
            .ok_or("the release's manifest does not verify")?;
        let old = now.as_deref().and_then(|n| self.stored_manifest(n));
        if !changes(Part::Updater, &self.cfg.target, old.as_ref(), &new) {
            return Ok(None);
        }
        let root = &self.cfg.root;
        if now.is_some() {
            // with an updater to go back to, the new one is on trial
            write_whole(&root.join("updater-trial"), format!("0 {tag}\n").as_bytes())
                .map_err(|e| format!("updater-trial: {e}"))?;
            self.point("updater-previous", now.as_deref())?;
        }
        self.point("updater", Some(tag))?;
        let _ = remove_whole(&root.join("updater-reverted"));
        log("updater-staged", json!({ "from": now, "to": tag }));
        if now.is_none() {
            // no updater was in place (a first installation by hand): nothing runs that has to make room
            return Ok(None);
        }
        self.replaced
            .store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(Some(tag.to_string()))
    }

    /// True once a deploy has put another updater in place: this process should end so that it can start.
    pub fn replaced(&self) -> bool {
        self.replaced.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Called once the updater is up and listening: ends a trial of this very program.
    pub fn confirm(&self) {
        let root = &self.cfg.root;
        // the note says whose trial it is ("1 hub-v124"): only that updater ends it
        let on_trial = std::fs::read_to_string(root.join("updater-trial"))
            .ok()
            .and_then(|note| note.split_whitespace().nth(1).map(str::to_string));
        if on_trial.is_some() && on_trial == self.own_release {
            let _ = remove_whole(&root.join("updater-trial"));
            log("updater-confirmed", json!({ "release": self.own_release }));
        }
        if let Some(reverted) = self.reverted() {
            log(
                "updater-reverted",
                json!({ "did_not_come_up": reverted, "runs": self.own_release }),
            );
        }
    }

    /// After a start: undoes a hub swap that was cut off halfway (the updater or the machine went down during a
    /// deploy), and makes sure the hub runs.
    /// False when another process held the deploy lock all the while: the caller tries again.
    pub async fn recover(&self) -> bool {
        let _turn = self.gate.lock().await;
        let Ok(_lock) = self.file_lock().await else {
            return false;
        };
        self.settle().await;
        if self.linked("current").is_some() {
            if let Err(e) = self.start().await {
                log("start", json!({ "error": e }));
            }
        }
        self.tidy();
        true
    }

    /// Both steps of a start, in the order the program takes them.
    pub async fn started(&self) {
        self.recover().await;
        self.confirm();
    }

    /// Waits until no deploy runs (before the updater stops).
    pub async fn idle(&self) {
        let _turn = self.gate.lock().await;
    }

    /// What runs: the hub (and whether the file on disk is the one the signed manifest names) and the updater.
    pub async fn status(&self) -> Value {
        let running = self.running();
        let proved = match &running {
            Some(r) => {
                let (dir, tag) = (self.releases().join(&r.tag), r.tag.clone());
                Some(self.proved(&dir, &tag))
            }
            None => None,
        };
        let health = match self.ask().await {
            Ok((ok, commit)) => json!({ "ok": ok, "commit": commit }),
            Err(e) => json!({ "ok": false, "detail": e }),
        };
        json!({
            "hub": {
                "release": running.as_ref().map(|r| r.tag.clone()),
                "version": running.as_ref().map(|r| r.version),
                "commit": running.as_ref().and_then(|r| r.manifest.as_ref()).map(|m| m.commit.clone()),
                "sha256": proved.as_ref().and_then(|p| p.as_ref().ok()).map(|p| p.1.clone()),
                "files_match_manifest": proved.as_ref().map(|p| p.is_ok()),
                "damage": proved.as_ref().and_then(|p| p.as_ref().err()),
                "health": health,
            },
            "previous": self.linked("previous"),
            "high_water": self.read_state().map(|s| s.high_water).ok(),
            "updater": {
                "release": self.own_release,
                "commit": option_env!("TROMMI_COMMIT").unwrap_or("dev"),
                "on_trial": self.cfg.root.join("updater-trial").exists(),
                "previous": self.linked("updater-previous"),
                "reverted": self.reverted(),
            },
            "deploy_cut_off": self.cfg.root.join("deploy-journal.json").exists(),
        })
    }
}

fn file_sha256(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut hash = Sha256::new();
    std::io::copy(&mut file, &mut hash).ok()?;
    Some(hex(&hash.finalize()))
}

/// An error of the HTTP client in plain words, without the address it was for.
fn plain(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "timed out".into()
    } else if e.is_connect() {
        "could not connect".into()
    } else if e.is_redirect() {
        "too many redirects".into()
    } else {
        "the transfer broke off".into()
    }
}

async fn read_capped(mut answer: reqwest::Response, cap: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    while let Some(chunk) = answer.chunk().await.map_err(|e| plain(&e))? {
        if (bytes.len() + chunk.len()) as u64 > cap {
            return Err(format!("longer than {cap} bytes"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

// ---------------------------------------------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------------------------------------------

/// Who may call. On the server: the tailnet says which device an address is.
pub trait Callers: Send + Sync {
    fn allowed(&self, peer: SocketAddr) -> Result<(), String>;
}

/// Asks the machine's own tailscaled who the caller is and lets in a device that carries one of `tags`, or a
/// device of one of `users` that carries no tag. When tailscaled cannot be asked, nobody is let in.
pub struct Tailnet {
    pub tags: Vec<String>,
    pub users: Vec<String>,
}

/// The decision, from what `tailscale whois --json` printed.
pub fn tailnet_allows(whois: &[u8], tags: &[String], users: &[String]) -> Result<(), String> {
    let who: Value =
        serde_json::from_slice(whois).map_err(|_| "tailscale whois: not JSON".to_string())?;
    let carried: Vec<&str> = who["Node"]["Tags"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| t.as_str())
        .collect();
    let allowed = if carried.is_empty() {
        // a person's own device
        who["UserProfile"]["LoginName"]
            .as_str()
            .is_some_and(|login| users.iter().any(|u| u == login))
    } else {
        carried.iter().any(|t| tags.iter().any(|a| a == t))
    };
    if allowed {
        Ok(())
    } else {
        Err("this tailnet device may not deploy".into())
    }
}

impl Callers for Tailnet {
    fn allowed(&self, peer: SocketAddr) -> Result<(), String> {
        let out = run(
            "tailscale",
            &["whois", "--json", &peer.to_string()],
            Duration::from_secs(5),
        )
        .map_err(|_| "the tailnet does not say who this caller is".to_string())?;
        tailnet_allows(&out, &self.tags, &self.users)
    }
}

type Answer = hyper::Response<http_body_util::Full<bytes::Bytes>>;

fn answer(status: u16, value: &Value) -> Answer {
    hyper::Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .header("cache-control", "no-store")
        .body(http_body_util::Full::new(bytes::Bytes::from(
            serde_json::to_vec(value).expect("a value"),
        )))
        .expect("a valid response")
}

async fn handle(
    updater: Arc<Updater>,
    callers: Arc<dyn Callers>,
    peer: SocketAddr,
    request: hyper::Request<hyper::body::Incoming>,
) -> Answer {
    use http_body_util::BodyExt;
    let route = (request.method().clone(), request.uri().path().to_string());
    if !matches!(
        (route.0.as_str(), route.1.as_str()),
        ("POST", "/deploy") | ("GET", "/status")
    ) {
        return answer(404, &json!({ "ok": false, "message": "no such route" }));
    }
    let check = callers.clone();
    let allowed = tokio::task::spawn_blocking(move || check.allowed(peer))
        .await
        .unwrap_or_else(|e| Err(e.to_string()));
    if let Err(why) = allowed {
        log(
            "caller-refused",
            json!({ "peer": peer.to_string(), "why": why }),
        );
        return answer(
            403,
            &json!({ "ok": false, "result": "forbidden", "message": why }),
        );
    }
    if route.0 == hyper::Method::GET {
        return answer(200, &updater.status().await);
    }
    let body = http_body_util::Limited::new(request.into_body(), 4096)
        .collect()
        .await
        .map(|b| b.to_bytes());
    let tag = body
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v["tag"].as_str().map(str::to_string));
    let Some(tag) = tag else {
        let outcome = Outcome::new("bad-request", "", "the body must be {\"tag\":\"hub-v123\"}");
        return answer(400, &serde_json::to_value(&outcome).expect("an outcome"));
    };
    log("call", json!({ "peer": peer.to_string(), "tag": tag }));
    // a task of its own: a caller that hangs up must not stop a deploy halfway
    let work = tokio::spawn(async move { updater.deploy(&tag).await });
    match work.await {
        Ok(outcome) => answer(
            outcome.http_status(),
            &serde_json::to_value(&outcome).expect("an outcome"),
        ),
        Err(e) => answer(
            500,
            &json!({ "ok": false, "result": "failed", "message": e.to_string() }),
        ),
    }
}

/// Serves until `stop` is notified or a deploy has put another updater in place (after that deploy's answer went
/// out), then waits for a running deploy to end.
pub async fn serve(
    updater: Arc<Updater>,
    listener: tokio::net::TcpListener,
    callers: Arc<dyn Callers>,
    stop: Arc<tokio::sync::Notify>,
) {
    let slots = Arc::new(tokio::sync::Semaphore::new(16));
    loop {
        let accepted = tokio::select! {
            a = listener.accept() => a,
            _ = stop.notified() => break,
        };
        let Ok((socket, peer)) = accepted else {
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        };
        let Ok(slot) = slots.clone().try_acquire_owned() else {
            continue;
        };
        let (updater, callers, stop) = (updater.clone(), callers.clone(), stop.clone());
        tokio::spawn(async move {
            let _slot = slot;
            let serving = updater.clone();
            let service = hyper::service::service_fn(move |request| {
                let (updater, callers) = (serving.clone(), callers.clone());
                async move {
                    Ok::<_, std::convert::Infallible>(handle(updater, callers, peer, request).await)
                }
            });
            let _ = hyper::server::conn::http1::Builder::new()
                .timer(hyper_util::rt::TokioTimer::new())
                .header_read_timeout(Duration::from_secs(10))
                .keep_alive(false)
                .serve_connection(hyper_util::rt::TokioIo::new(socket), service)
                .await;
            // the answer is out: now this updater may make room for the one a deploy put in place
            if updater.replaced() {
                stop.notify_one();
            }
        });
    }
    updater.idle().await;
}
