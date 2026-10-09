//! The hub's updater (hub/updater) against a stand-in for GitHub's release API, a stand-in for the hub's health
//! route and a stand-in for systemd: what it takes, what it refuses, and what it leaves running when things fail.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use trommi_hub_updater::{
    public_key, serve, tailnet_allows, verify_manifest, Asset, Callers, Config, Manifest, Outcome,
    Service, Updater, MANIFEST, SIGNATURE,
};

const TARGET: &str = "x86_64-unknown-linux-musl";
const REPOSITORY: &str = "trommi/trommi";

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn commit_of(version: u64) -> String {
    format!("{version:040x}")
}

// ---- a release, as the deploy workflow publishes it ----

#[derive(Clone)]
struct Release {
    tag: String,
    assets: Vec<(String, Vec<u8>)>,
}

/// What the stand-in "hub binary" says: the stand-in for systemd reads it when it "starts" the hub.
fn hub_file(version: u64, well: bool) -> Vec<u8> {
    format!("commit={} well={well}\n", commit_of(version)).into_bytes()
}

struct Make {
    key: SigningKey,
    version: u64,
    product: String,
    repository: String,
    hub: Vec<u8>,
    updater: Vec<u8>,
    unit: Vec<u8>,
    /// the tag the release is published under, when it is not the one the manifest names
    published_as: Option<String>,
}

fn make(version: u64) -> Make {
    Make {
        key: signing_key(),
        version,
        product: "trommi-hub".into(),
        repository: REPOSITORY.into(),
        hub: hub_file(version, true),
        updater: b"updater A\n".to_vec(),
        unit: format!("[Service]\n# unit of {version}\n").into_bytes(),
        published_as: None,
    }
}

impl Make {
    fn release(&self) -> Release {
        let files = [
            (format!("trommi-hub-{TARGET}"), self.hub.clone()),
            (format!("trommi-hub-updater-{TARGET}"), self.updater.clone()),
            ("trommi-hub.service".to_string(), self.unit.clone()),
        ];
        let tag = format!("hub-v{}", self.version);
        let manifest = Manifest {
            product: self.product.clone(),
            repository: self.repository.clone(),
            version: self.version,
            tag: tag.clone(),
            commit: commit_of(self.version),
            assets: files
                .iter()
                .map(|(name, bytes)| Asset {
                    name: name.clone(),
                    sha256: hex(&Sha256::digest(bytes)),
                    size: bytes.len() as u64,
                })
                .collect(),
        };
        let manifest = serde_json::to_vec_pretty(&manifest).unwrap();
        let signature = self.key.sign(&manifest).to_bytes().to_vec();
        let mut assets = files.to_vec();
        assets.push((MANIFEST.to_string(), manifest));
        assets.push((SIGNATURE.to_string(), signature));
        Release {
            tag: self.published_as.clone().unwrap_or(tag),
            assets,
        }
    }
}

fn signing_key() -> SigningKey {
    SigningKey::from_bytes(&[7; 32])
}

// ---- stand-ins ----

#[derive(Default)]
struct World {
    releases: Mutex<HashMap<String, Release>>,
    /// requests GitHub's stand-in answered
    fetched: AtomicUsize,
    /// what the hub's stand-in is: (commit, well) while "running"
    hub: Mutex<Option<(String, bool)>>,
    starts: AtomicUsize,
    stops: AtomicUsize,
    reloads: AtomicUsize,
}

struct FakeSystemd {
    world: Arc<World>,
    root: PathBuf,
}

impl Service for FakeSystemd {
    fn stop(&self) -> Result<(), String> {
        self.world.stops.fetch_add(1, Ordering::SeqCst);
        *self.world.hub.lock().unwrap() = None;
        Ok(())
    }
    fn start(&self) -> Result<(), String> {
        self.world.starts.fetch_add(1, Ordering::SeqCst);
        let text = std::fs::read_to_string(self.root.join("current/trommi-hub"))
            .map_err(|e| format!("203/EXEC: {e}"))?;
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(self.root.join("current/trommi-hub"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o111, 0o111, "the hub binary must be executable");
        assert!(
            self.root.join("current/trommi-hub.service").exists(),
            "the unit comes with the release"
        );
        let commit = text
            .split_whitespace()
            .find_map(|w| w.strip_prefix("commit="))
            .unwrap_or("")
            .to_string();
        *self.world.hub.lock().unwrap() = Some((commit, text.contains("well=true")));
        Ok(())
    }
    fn reload(&self) -> Result<(), String> {
        self.world.reloads.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

/// One HTTP/1.1 exchange per connection, by hand: enough for the two stand-ins.
async fn tiny_server<F>(answer: F) -> SocketAddr
where
    F: Fn(String) -> (u16, Vec<u8>) + Send + Sync + 'static,
{
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let answer = Arc::new(answer);
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let answer = answer.clone();
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    if socket.read(&mut byte).await.unwrap_or(0) == 0 {
                        return;
                    }
                    head.push(byte[0]);
                }
                let head = String::from_utf8_lossy(&head).to_string();
                let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                let (status, body) = answer(path);
                let top = format!(
                    "HTTP/1.1 {status} X\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                let _ = socket.write_all(top.as_bytes()).await;
                let _ = socket.write_all(&body).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    address
}

struct Bench {
    world: Arc<World>,
    root: PathBuf,
    cfg: Config,
}

impl Bench {
    async fn new(name: &str) -> Bench {
        let world = Arc::new(World::default());
        let root = std::env::temp_dir().join(format!(
            "trommi-updater-test-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("data")).unwrap();

        let github = world.clone();
        let base = Arc::new(Mutex::new(String::new()));
        let own = base.clone();
        let api = tiny_server(move |path| {
            let base = own.lock().unwrap().clone();
            github.fetched.fetch_add(1, Ordering::SeqCst);
            let releases = github.releases.lock().unwrap();
            let prefix = format!("/repos/{REPOSITORY}/releases/");
            let Some(rest) = path.strip_prefix(&prefix) else {
                return (404, b"{}".to_vec());
            };
            if let Some(tag) = rest.strip_prefix("tags/") {
                let Some(release) = releases.get(tag) else {
                    return (404, b"{}".to_vec());
                };
                let assets: Vec<serde_json::Value> = release
                    .assets
                    .iter()
                    .enumerate()
                    .map(|(i, (name, _))| {
                        let number = parse_version(&release.tag) * 100 + i as u64;
                        serde_json::json!({ "name": name, "url": format!("{base}/repos/{REPOSITORY}/releases/assets/{number}") })
                    })
                    .collect();
                let body = serde_json::json!({ "tag_name": release.tag, "draft": false, "assets": assets });
                return (200, body.to_string().into_bytes());
            }
            if let Some(number) = rest.strip_prefix("assets/").and_then(|n| n.parse::<u64>().ok()) {
                let found = releases
                    .values()
                    .find(|r| parse_version(&r.tag) == number / 100)
                    .and_then(|r| r.assets.get((number % 100) as usize));
                if let Some((_, bytes)) = found {
                    return (200, bytes.clone());
                }
            }
            (404, b"{}".to_vec())
        })
        .await;
        *base.lock().unwrap() = format!("http://{api}");

        let hub = world.clone();
        let health = tiny_server(move |_| match hub.hub.lock().unwrap().clone() {
            Some((commit, well)) => (
                if well { 200 } else { 503 },
                serde_json::json!({ "ok": well, "commit": commit, "protocol_version": 2 })
                    .to_string()
                    .into_bytes(),
            ),
            None => (502, b"down".to_vec()),
        })
        .await;

        let cfg = Config {
            repository: REPOSITORY.into(),
            api: format!("http://{api}"),
            key: signing_key().verifying_key(),
            target: TARGET.into(),
            data: root.join("data"),
            root: root.clone(),
            health_url: format!("http://{health}/healthz"),
            health_wait: Duration::from_millis(600),
            health_every: Duration::from_millis(50),
            lock_wait: Duration::from_secs(20),
        };
        Bench { world, root, cfg }
    }

    /// An updater as it is after a start of the program.
    fn updater(&self) -> Arc<Updater> {
        Updater::new(
            self.cfg.clone(),
            Arc::new(FakeSystemd {
                world: self.world.clone(),
                root: self.root.clone(),
            }),
        )
        .unwrap()
    }

    fn publish(&self, release: Release) {
        self.world
            .releases
            .lock()
            .unwrap()
            .insert(release.tag.clone(), release);
    }

    fn link(&self, name: &str) -> Option<String> {
        std::fs::read_link(self.root.join(name))
            .ok()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
    }

    fn hub_commit(&self) -> Option<String> {
        self.world.hub.lock().unwrap().clone().map(|h| h.0)
    }

    fn fetched(&self) -> usize {
        self.world.fetched.load(Ordering::SeqCst)
    }

    fn leftovers(&self) -> Vec<String> {
        std::fs::read_dir(self.root.join("releases"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with(".tmp"))
            .collect()
    }
}

impl Drop for Bench {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn parse_version(tag: &str) -> u64 {
    tag.trim_start_matches("hub-v").parse().unwrap()
}

async fn bench(name: &str) -> Bench {
    Bench::new(name).await
}

async fn deploy(updater: &Updater, version: u64) -> Outcome {
    updater.deploy(&format!("hub-v{version}")).await
}

// ---------------------------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_signed_release_is_deployed_and_reports_what_runs() {
    let b = bench("good").await;
    b.publish(make(5).release());
    let updater = b.updater();
    let outcome = deploy(&updater, 5).await;
    assert!(outcome.ok, "{}", outcome.message);
    assert_eq!(outcome.result, "deployed");
    assert_eq!(outcome.http_status(), 200);
    assert_eq!(outcome.running.as_deref(), Some("hub-v5"));
    assert_eq!(outcome.commit, Some(commit_of(5)));
    assert_eq!(outcome.sha256, Some(hex(&Sha256::digest(hub_file(5, true)))));
    assert!(outcome.health.as_ref().unwrap().ok);
    assert_eq!(b.link("current").as_deref(), Some("hub-v5"));
    assert_eq!(b.hub_commit(), Some(commit_of(5)));
    assert!(b.world.reloads.load(Ordering::SeqCst) >= 1, "the unit is read again");
    assert!(b.leftovers().is_empty());
    assert!(!b.root.join("deploy-journal.json").exists());

    let status = updater.status().await;
    assert_eq!(status["hub"]["release"], "hub-v5");
    assert_eq!(status["hub"]["files_match_manifest"], true);
    assert_eq!(status["hub"]["health"]["ok"], true);
    assert_eq!(status["high_water"], 5);

    // a file changed on disk afterwards is seen
    std::fs::write(b.root.join("releases/hub-v5/trommi-hub"), b"other").unwrap();
    assert_eq!(updater.status().await["hub"]["files_match_manifest"], false);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_release_signed_with_another_key_is_not_taken() {
    let b = bench("badsig").await;
    b.publish(make(5).release());
    let updater = b.updater();
    assert!(deploy(&updater, 5).await.ok);

    let mut forged = make(6);
    forged.key = SigningKey::from_bytes(&[9; 32]);
    b.publish(forged.release());
    let starts = b.world.starts.load(Ordering::SeqCst);
    let outcome = deploy(&updater, 6).await;
    assert_eq!(outcome.result, "not-verified", "{}", outcome.message);
    assert_eq!(outcome.http_status(), 422);
    assert_eq!(b.link("current").as_deref(), Some("hub-v5"));
    assert_eq!(b.hub_commit(), Some(commit_of(5)), "the hub was never touched");
    assert_eq!(b.world.starts.load(Ordering::SeqCst), starts);
    assert!(b.leftovers().is_empty());
    assert!(!b.root.join("releases/hub-v6").exists());
    assert_eq!(updater.status().await["high_water"], 5, "an unproved release raises no floor");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_manifest_changed_after_signing_is_not_taken() {
    let b = bench("changed").await;
    let mut release = make(5).release();
    let manifest = release.assets.iter_mut().find(|a| a.0 == MANIFEST).unwrap();
    let text = String::from_utf8(manifest.1.clone()).unwrap();
    manifest.1 = text.replace(&commit_of(5), &commit_of(6)).into_bytes();
    b.publish(release);
    let outcome = deploy(&b.updater(), 5).await;
    assert_eq!(outcome.result, "not-verified");
    assert_eq!(b.link("current"), None);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_file_that_is_not_the_one_the_manifest_names_is_not_taken() {
    let b = bench("swapped").await;
    let (hub, updater) = (format!("trommi-hub-{TARGET}"), format!("trommi-hub-updater-{TARGET}"));
    for (which, longer) in [(hub.as_str(), false), (updater.as_str(), false), ("trommi-hub.service", false), (hub.as_str(), true)] {
        let mut release = make(5).release();
        let asset = release.assets.iter_mut().find(|a| a.0 == which).unwrap();
        if longer {
            asset.1.extend_from_slice(&[0; 4096]);
        } else {
            asset.1[0] ^= 1;
        }
        b.publish(release);
        let outcome = deploy(&b.updater(), 5).await;
        assert_eq!(outcome.result, "not-verified", "{which}: {}", outcome.message);
        assert_eq!(b.link("current"), None);
        assert!(b.leftovers().is_empty());
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_release_of_another_product_repository_or_name_is_not_taken() {
    let b = bench("wrong").await;
    // signed with the right key, but for the connector
    let mut other = make(5);
    other.product = "trommi-connector".into();
    b.publish(other.release());
    assert_eq!(deploy(&b.updater(), 5).await.result, "not-verified");

    // signed with the right key, but for another repository
    let mut other = make(5);
    other.repository = "someone/else".into();
    b.publish(other.release());
    assert_eq!(deploy(&b.updater(), 5).await.result, "not-verified");

    // an older, properly signed release offered under a newer name
    let mut old = make(4);
    old.published_as = Some("hub-v9".into());
    b.publish(old.release());
    let outcome = deploy(&b.updater(), 9).await;
    assert_eq!(outcome.result, "not-verified", "{}", outcome.message);

    // a release without this machine's binary
    let mut release = make(5).release();
    release.assets.retain(|a| a.0 != format!("trommi-hub-{TARGET}"));
    b.publish(release);
    let outcome = deploy(&b.updater(), 5).await;
    assert!(matches!(outcome.result, "not-verified" | "fetch-failed"), "{}", outcome.message);

    // not a release name at all: refused before anything is asked of GitHub
    let before = b.fetched();
    for tag in ["v5", "hub-v05", "hub-v", "hub-v5/../x", "connector-v5", "hub-v1234567890123"] {
        let outcome = b.updater().deploy(tag).await;
        assert_eq!(outcome.result, "bad-request", "{tag}");
        assert_eq!(outcome.http_status(), 400);
    }
    assert_eq!(b.fetched(), before);
    assert_eq!(b.link("current"), None);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_older_release_is_refused_without_fetching() {
    let b = bench("older").await;
    for v in [4, 5] {
        b.publish(make(v).release());
    }
    let updater = b.updater();
    assert!(deploy(&updater, 5).await.ok);
    let (fetched, stops) = (b.fetched(), b.world.stops.load(Ordering::SeqCst));
    let outcome = deploy(&updater, 4).await;
    assert_eq!(outcome.result, "refused");
    assert_eq!(outcome.http_status(), 409);
    assert_eq!(outcome.running.as_deref(), Some("hub-v5"));
    assert_eq!(b.fetched(), fetched, "nothing was fetched");
    assert_eq!(b.world.stops.load(Ordering::SeqCst), stops, "the hub was not touched");

    // the floor outlives the state file (what runs counts) and a new start of the updater
    std::fs::remove_file(b.root.join("state.json")).unwrap();
    assert_eq!(deploy(&b.updater(), 4).await.result, "refused");
    // an unreadable state file refuses everything rather than forgetting the floor
    std::fs::write(b.root.join("state.json"), b"{").unwrap();
    b.publish(make(6).release());
    assert_eq!(deploy(&b.updater(), 6).await.result, "failed");
    assert_eq!(b.link("current").as_deref(), Some("hub-v5"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_release_that_is_not_well_is_rolled_back() {
    let b = bench("rollback").await;
    b.publish(make(5).release());
    let mut sick = make(6);
    sick.hub = hub_file(6, false);
    b.publish(sick.release());
    std::fs::write(b.root.join("data/hub.db"), b"database").unwrap();
    std::fs::write(b.root.join("data/vapid.key"), b"key").unwrap();
    let updater = b.updater();
    assert!(deploy(&updater, 5).await.ok);

    let outcome = deploy(&updater, 6).await;
    assert!(!outcome.ok);
    assert_eq!(outcome.result, "rolled-back", "{}", outcome.message);
    assert_eq!(outcome.http_status(), 500);
    assert!(!outcome.health.as_ref().unwrap().ok);
    assert!(outcome.rollback_health.as_ref().unwrap().ok);
    assert_eq!(outcome.running.as_deref(), Some("hub-v5"));
    assert_eq!(b.link("current").as_deref(), Some("hub-v5"));
    assert_eq!(b.link("previous"), None, "what was before stays what it was");
    assert_eq!(b.hub_commit(), Some(commit_of(5)));
    assert!(!b.root.join("deploy-journal.json").exists());
    assert!(!b.root.join("releases/hub-v6").exists(), "the release that failed is not kept");
    // the copy made while the hub stood still
    let backup = PathBuf::from(outcome.backup.unwrap());
    assert_eq!(std::fs::read(backup.join("hub.db")).unwrap(), b"database");
    assert_eq!(std::fs::read(backup.join("vapid.key")).unwrap(), b"key");

    // the release that failed raised the floor: nothing older comes back through a call
    b.publish(make(4).release());
    assert_eq!(deploy(&updater, 4).await.result, "refused");
    assert_eq!(updater.status().await["high_water"], 6);
    // what runs can be asked for again and is left alone
    assert_eq!(deploy(&updater, 5).await.result, "unchanged");
    // and a later, good release is taken
    b.publish(make(7).release());
    let outcome = deploy(&updater, 7).await;
    assert_eq!(outcome.result, "deployed", "{}", outcome.message);
    assert_eq!(b.link("previous").as_deref(), Some("hub-v5"));
    assert!(!b.root.join("releases/hub-v6").exists(), "what no link names is tidied away");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_first_release_that_is_not_well_leaves_nothing_running_and_says_so() {
    let b = bench("first").await;
    let mut sick = make(5);
    sick.hub = hub_file(5, false);
    b.publish(sick.release());
    let outcome = deploy(&b.updater(), 5).await;
    assert_eq!(outcome.result, "failed", "{}", outcome.message);
    assert_eq!(b.link("current"), None);
    assert_eq!(b.hub_commit(), None);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_hub_that_reports_another_commit_is_not_accepted() {
    let b = bench("commit").await;
    b.publish(make(5).release());
    let mut liar = make(6);
    liar.hub = hub_file(5, true); // well, but it is not the commit the manifest names
    b.publish(liar.release());
    let updater = b.updater();
    assert!(deploy(&updater, 5).await.ok);
    let outcome = deploy(&updater, 6).await;
    assert_eq!(outcome.result, "rolled-back", "{}", outcome.message);
    assert_eq!(b.link("current").as_deref(), Some("hub-v5"));
}

#[tokio::test(flavor = "multi_thread")]
async fn two_calls_at_once_are_served_one_after_the_other() {
    let b = bench("two").await;
    b.publish(make(5).release());
    let updater = b.updater();
    let (first, second) = tokio::join!(deploy(&updater, 5), deploy(&updater, 5));
    let mut results = [first.result, second.result];
    results.sort();
    assert_eq!(results, ["deployed", "unchanged"]);
    assert_eq!(b.world.starts.load(Ordering::SeqCst), 1, "the hub was started once");

    // two different releases at once, also from a second process (the command line): the newer one runs in the end
    for v in [6, 7] {
        b.publish(make(v).release());
    }
    let other_process = b.updater();
    let (six, seven) = tokio::join!(deploy(&updater, 6), deploy(&other_process, 7));
    assert_eq!(seven.result, "deployed", "{}", seven.message);
    assert!(matches!(six.result, "deployed" | "refused"), "{}", six.message);
    assert_eq!(b.link("current").as_deref(), Some("hub-v7"));
    assert_eq!(b.hub_commit(), Some(commit_of(7)));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_release_that_runs_is_left_alone_and_a_stopped_one_is_started_again() {
    let b = bench("same").await;
    b.publish(make(5).release());
    let updater = b.updater();
    assert!(deploy(&updater, 5).await.ok);
    let (fetched, starts) = (b.fetched(), b.world.starts.load(Ordering::SeqCst));
    let outcome = deploy(&updater, 5).await;
    assert_eq!(outcome.result, "unchanged");
    assert!(outcome.ok);
    assert_eq!((b.fetched(), b.world.starts.load(Ordering::SeqCst)), (fetched, starts));

    *b.world.hub.lock().unwrap() = None; // the hub fell over
    let outcome = deploy(&updater, 5).await;
    assert_eq!(outcome.result, "restarted", "{}", outcome.message);
    assert_eq!(b.fetched(), fetched);
    assert_eq!(b.hub_commit(), Some(commit_of(5)));
}

#[tokio::test(flavor = "multi_thread")]
async fn when_github_does_not_answer_nothing_changes() {
    let b = bench("down").await;
    b.publish(make(5).release());
    assert!(deploy(&b.updater(), 5).await.ok);
    let mut cfg = b.cfg.clone();
    cfg.api = "http://127.0.0.1:1".into();
    let updater = Updater::new(
        cfg,
        Arc::new(FakeSystemd {
            world: b.world.clone(),
            root: b.root.clone(),
        }),
    )
    .unwrap();
    let outcome = updater.deploy("hub-v6").await;
    assert_eq!(outcome.result, "fetch-failed", "{}", outcome.message);
    assert_eq!(outcome.http_status(), 502);
    assert_eq!(b.hub_commit(), Some(commit_of(5)));
    assert!(b.leftovers().is_empty());
    // a release GitHub does not have
    assert_eq!(deploy(&b.updater(), 8).await.result, "fetch-failed");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_release_already_on_disk_is_proved_and_used_without_github() {
    let b = bench("ondisk").await;
    // the first installation puts a release folder in place; the updater proves it as it proves a fetched one
    let dir = b.root.join("releases/hub-v5");
    std::fs::create_dir_all(&dir).unwrap();
    for (name, bytes) in make(5).release().assets {
        let stored = name.replace(&format!("-{TARGET}"), "");
        std::fs::write(dir.join(&stored), bytes).unwrap();
        if !stored.contains('.') {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir.join(&stored), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }
    let outcome = deploy(&b.updater(), 5).await;
    assert_eq!(outcome.result, "deployed", "{}", outcome.message);
    assert_eq!(b.fetched(), 0);

    // a folder on disk that does not prove is not used: it is fetched afresh (here: GitHub has no such release)
    let dir = b.root.join("releases/hub-v6");
    std::fs::create_dir_all(&dir).unwrap();
    for (name, bytes) in make(6).release().assets {
        std::fs::write(dir.join(name.replace(&format!("-{TARGET}"), "")), bytes).unwrap();
    }
    std::fs::write(dir.join("trommi-hub"), b"planted").unwrap();
    let outcome = deploy(&b.updater(), 6).await;
    assert_eq!(outcome.result, "fetch-failed", "{}", outcome.message);
    assert_eq!(b.link("current").as_deref(), Some("hub-v5"));
}

#[tokio::test(flavor = "multi_thread")]
async fn when_the_copy_before_the_swap_fails_the_old_hub_runs_on() {
    let b = bench("backup").await;
    for v in [5, 6] {
        b.publish(make(v).release());
    }
    std::fs::write(b.root.join("data/hub.db"), b"database").unwrap();
    let updater = b.updater();
    assert!(deploy(&updater, 5).await.ok);
    // no room for the copy (here: its folder cannot be made)
    std::fs::remove_dir_all(b.root.join("backups")).unwrap();
    std::fs::write(b.root.join("backups"), b"in the way").unwrap();
    let outcome = deploy(&updater, 6).await;
    assert!(!outcome.ok);
    assert_eq!(outcome.result, "rolled-back", "{}", outcome.message);
    assert_eq!(b.link("current").as_deref(), Some("hub-v5"));
    assert_eq!(b.hub_commit(), Some(commit_of(5)));
}

/// The machine went down after the swap to hub-v6 and before its health was known.
async fn cut_off(name: &str, six_is_well: bool) -> Bench {
    let b = bench(name).await;
    b.publish(make(5).release());
    assert!(deploy(&b.updater(), 5).await.ok);
    let mut six = make(6);
    six.hub = hub_file(6, six_is_well);
    let dir = b.root.join("releases/hub-v6");
    std::fs::create_dir_all(&dir).unwrap();
    for (name, bytes) in six.release().assets {
        std::fs::write(dir.join(name.replace(&format!("-{TARGET}"), "")), bytes).unwrap();
    }
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir.join("trommi-hub"), std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::remove_file(b.root.join("current")).unwrap();
    std::os::unix::fs::symlink("releases/hub-v6", b.root.join("current")).unwrap();
    std::os::unix::fs::symlink("releases/hub-v5", b.root.join("previous")).unwrap();
    std::fs::write(
        b.root.join("deploy-journal.json"),
        br#"{"tag":"hub-v6","old":"hub-v5","old_previous":null}"#,
    )
    .unwrap();
    *b.world.hub.lock().unwrap() = None;
    b
}

#[tokio::test(flavor = "multi_thread")]
async fn a_deploy_cut_off_halfway_is_undone_at_the_next_start() {
    let b = cut_off("cut", false).await;
    let updater = b.updater();
    assert_eq!(updater.status().await["deploy_cut_off"], true);
    updater.started().await;
    assert_eq!(b.link("current").as_deref(), Some("hub-v5"));
    assert_eq!(b.link("previous"), None);
    assert_eq!(b.hub_commit(), Some(commit_of(5)));
    assert!(!b.root.join("deploy-journal.json").exists());
    // and without a journal a start of the updater simply makes sure the hub runs
    *b.world.hub.lock().unwrap() = None;
    b.updater().started().await;
    assert_eq!(b.hub_commit(), Some(commit_of(5)));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_deploy_cut_off_after_the_new_hub_was_in_place_and_well_counts_as_done() {
    let b = cut_off("cutwell", true).await;
    b.updater().started().await;
    assert_eq!(b.link("current").as_deref(), Some("hub-v6"));
    assert_eq!(b.link("previous").as_deref(), Some("hub-v5"));
    assert_eq!(b.hub_commit(), Some(commit_of(6)));
    assert!(!b.root.join("deploy-journal.json").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cut_off_deploy_is_settled_before_the_next_one_begins() {
    let b = cut_off("cutnext", false).await;
    b.publish(make(7).release());
    // no start of the updater in between: the call itself finds the note
    let outcome = deploy(&b.updater(), 7).await;
    assert_eq!(outcome.result, "deployed", "{}", outcome.message);
    assert_eq!(b.link("current").as_deref(), Some("hub-v7"));
    assert_eq!(b.link("previous").as_deref(), Some("hub-v5"), "the release before is the last one that was well");
}

#[tokio::test(flavor = "multi_thread")]
async fn while_a_new_updater_is_on_trial_no_further_deploy_is_taken() {
    let b = bench("trial").await;
    b.publish(make(5).release());
    assert!(deploy(&b.updater(), 5).await.ok);
    let mut newer = make(6);
    newer.updater = b"updater B\n".to_vec();
    b.publish(newer.release());
    let mut newest = make(7);
    newest.updater = b"updater C\n".to_vec();
    b.publish(newest.release());
    let updater = b.updater();
    assert_eq!(deploy(&updater, 6).await.updater.next.as_deref(), Some("hub-v6"));
    // a second call reaches the old process before it has ended, or another process: the fallback stays hub-v5
    for other in [updater.clone(), b.updater()] {
        let outcome = deploy(&other, 7).await;
        assert_eq!(outcome.result, "busy", "{}", outcome.message);
        assert_eq!(outcome.http_status(), 503);
    }
    assert_eq!(b.link("updater").as_deref(), Some("hub-v6"));
    assert_eq!(b.link("updater-previous").as_deref(), Some("hub-v5"));
    assert_eq!(b.link("current").as_deref(), Some("hub-v6"));
    // once the new updater is up, the next release is taken
    prestart(&b.root);
    let new = b.updater();
    new.started().await;
    assert_eq!(deploy(&new, 7).await.result, "deployed");
}

#[tokio::test(flavor = "multi_thread")]
async fn asking_for_what_runs_proves_it_again() {
    let b = bench("reprove").await;
    b.publish(make(5).release());
    let updater = b.updater();
    assert!(deploy(&updater, 5).await.ok);
    std::fs::write(b.root.join("releases/hub-v5/trommi-hub-updater"), b"planted").unwrap();
    let outcome = deploy(&updater, 5).await;
    assert!(!outcome.ok);
    assert_eq!(outcome.result, "failed", "{}", outcome.message);
}

// ---- the updater's own update ----

fn prestart(root: &Path) {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../hub/deploy/updater-prestart.sh");
    let status = std::process::Command::new("sh")
        .arg(script)
        .arg(root)
        .status()
        .unwrap();
    assert!(status.success(), "the pre-start script never fails a start");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_updater_takes_over_and_one_that_does_not_come_up_is_put_back() {
    let b = bench("self").await;
    b.publish(make(5).release());
    // the first installation: the updater of hub-v5 is in place and runs
    assert!(deploy(&b.updater(), 5).await.ok);
    assert_eq!(b.link("updater").as_deref(), Some("hub-v5"));
    assert!(!b.root.join("updater-trial").exists(), "nothing to go back to: no trial");

    // a release with the same updater changes nothing about it
    b.publish(make(6).release());
    let updater = b.updater();
    let outcome = deploy(&updater, 6).await;
    assert_eq!(outcome.updater.release.as_deref(), Some("hub-v5"));
    assert_eq!(outcome.updater.next, None);
    assert!(!updater.replaced());
    assert_eq!(b.link("updater").as_deref(), Some("hub-v5"));
    b.publish(make(7).release());
    assert!(deploy(&updater, 7).await.ok);
    assert!(b.root.join("releases/hub-v5").exists(), "the release the updater is from is kept");

    // a release with another updater: answered first, then the process makes room
    let mut newer = make(8);
    newer.updater = b"updater B\n".to_vec();
    b.publish(newer.release());
    let outcome = deploy(&updater, 8).await;
    assert!(outcome.ok, "{}", outcome.message);
    assert_eq!(outcome.updater.release.as_deref(), Some("hub-v5"));
    assert_eq!(outcome.updater.next.as_deref(), Some("hub-v8"));
    assert!(updater.replaced());
    assert_eq!(b.link("updater").as_deref(), Some("hub-v8"));
    assert_eq!(b.link("updater-previous").as_deref(), Some("hub-v5"));
    assert_eq!(std::fs::read_to_string(b.root.join("updater-trial")).unwrap(), "0 hub-v8\n");

    // systemd starts it: the first start is its try
    prestart(&b.root);
    assert_eq!(b.link("updater").as_deref(), Some("hub-v8"));
    // it does not come up (it ends, or never says it is ready): systemd starts again, the script puts the old one back
    prestart(&b.root);
    assert_eq!(b.link("updater").as_deref(), Some("hub-v5"));
    assert!(!b.root.join("updater-trial").exists());
    // a further start changes nothing more
    prestart(&b.root);
    assert_eq!(b.link("updater").as_deref(), Some("hub-v5"));

    // the old updater is back and says so: in its status and on the next call
    let old = b.updater();
    old.started().await;
    let status = old.status().await;
    assert_eq!(status["updater"]["release"], "hub-v5");
    assert_eq!(status["updater"]["reverted"], "hub-v8");
    let outcome = deploy(&old, 8).await;
    assert_eq!(outcome.result, "unchanged");
    assert_eq!(outcome.updater.release.as_deref(), Some("hub-v5"));
    assert_eq!(outcome.updater.reverted.as_deref(), Some("hub-v8"));
    assert_eq!(outcome.updater.next, None, "the same updater is not tried a second time");
    assert!(!old.replaced());
    assert_eq!(b.hub_commit(), Some(commit_of(8)), "the hub of the release runs all the while");

    // a later release brings a working one: it is tried, comes up, and stays
    let mut fixed = make(9);
    fixed.updater = b"updater C\n".to_vec();
    b.publish(fixed.release());
    let outcome = deploy(&old, 9).await;
    assert_eq!(outcome.updater.next.as_deref(), Some("hub-v9"));
    assert_eq!(outcome.updater.reverted, None);
    prestart(&b.root);
    let new = b.updater();
    new.started().await; // it is up: the trial ends
    assert!(!b.root.join("updater-trial").exists());
    prestart(&b.root); // a later, ordinary restart
    assert_eq!(b.link("updater").as_deref(), Some("hub-v9"));
    let status = new.status().await;
    assert_eq!(status["updater"]["release"], "hub-v9");
    assert_eq!(status["updater"]["reverted"], serde_json::Value::Null);
    assert_eq!(status["updater"]["on_trial"], false);
    // the key and the floor were never part of it
    assert_eq!(status["high_water"], 9);
}

// ---- the endpoint ----

struct Only(bool);
impl Callers for Only {
    fn allowed(&self, _: SocketAddr) -> Result<(), String> {
        if self.0 {
            Ok(())
        } else {
            Err("this tailnet device may not deploy".into())
        }
    }
}

async fn call(address: SocketAddr, request: &str) -> (u16, serde_json::Value) {
    let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
    socket.write_all(request.as_bytes()).await.unwrap();
    let mut answer = Vec::new();
    socket.read_to_end(&mut answer).await.unwrap();
    let text = String::from_utf8_lossy(&answer).to_string();
    let status = text.split_whitespace().nth(1).unwrap().parse().unwrap();
    let body = text.split_once("\r\n\r\n").unwrap().1;
    (status, serde_json::from_str(body).unwrap_or(serde_json::Value::Null))
}

fn post(tag: &str) -> String {
    let body = format!("{{\"tag\":\"{tag}\"}}");
    format!(
        "POST /deploy HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
        body.len()
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn the_endpoint_answers_with_the_result_and_lets_only_known_callers_in() {
    let b = bench("http").await;
    for v in [5, 6] {
        b.publish(make(v).release());
    }
    // as after the first installation: hub-v5 and its updater are in place
    assert!(deploy(&b.updater(), 5).await.ok);
    let stop = Arc::new(tokio::sync::Notify::new());

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let open = listener.local_addr().unwrap();
    let serving = tokio::spawn(serve(b.updater(), listener, Arc::new(Only(true)), stop.clone()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let closed = listener.local_addr().unwrap();
    let other = Arc::new(tokio::sync::Notify::new());
    tokio::spawn(serve(b.updater(), listener, Arc::new(Only(false)), other));

    let (status, body) = call(closed, &post("hub-v6")).await;
    assert_eq!((status, body["result"].as_str()), (403, Some("forbidden")));
    let (status, _) = call(closed, "GET /status HTTP/1.1\r\nhost: x\r\n\r\n").await;
    assert_eq!(status, 403);
    assert_eq!(b.link("current").as_deref(), Some("hub-v5"));

    let (status, body) = call(open, &post("hub-v6")).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["ok"], true);
    assert_eq!(body["result"], "deployed");
    assert_eq!(body["running"], "hub-v6");
    assert_eq!(body["health"]["ok"], true);
    assert_eq!(body["updater"]["release"], "hub-v5");
    assert_eq!(body["updater"]["next"], serde_json::Value::Null);
    let (status, body) = call(open, &post("hub-v4")).await;
    assert_eq!((status, body["result"].as_str()), (409, Some("refused")));
    let (status, body) = call(open, "GET /status HTTP/1.1\r\nhost: x\r\n\r\n").await;
    assert_eq!(status, 200);
    assert_eq!(body["hub"]["release"], "hub-v6");
    assert_eq!(body["updater"]["release"], "hub-v5");
    let (status, _) = call(open, "POST /deploy HTTP/1.1\r\nhost: x\r\ncontent-length: 3\r\n\r\nabc").await;
    assert_eq!(status, 400);
    let (status, _) = call(open, "GET / HTTP/1.1\r\nhost: x\r\n\r\n").await;
    assert_eq!(status, 404);
    let (status, _) = call(open, "POST /run HTTP/1.1\r\nhost: x\r\ncontent-length: 0\r\n\r\n").await;
    assert_eq!(status, 404);
    assert!(!serving.is_finished());

    // a release with another updater: the caller gets the whole answer first, then the updater ends to make room
    let mut newer = make(7);
    newer.updater = b"updater B\n".to_vec();
    b.publish(newer.release());
    let (status, body) = call(open, &post("hub-v7")).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["result"], "deployed");
    assert_eq!(body["updater"]["next"], "hub-v7");
    tokio::time::timeout(Duration::from_secs(5), serving)
        .await
        .expect("the updater ends after it has answered")
        .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_caller_that_hangs_up_does_not_stop_a_deploy_halfway() {
    let b = bench("hangup").await;
    b.publish(make(5).release());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let stop = Arc::new(tokio::sync::Notify::new());
    tokio::spawn(serve(b.updater(), listener, Arc::new(Only(true)), stop));
    {
        let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
        socket.write_all(post("hub-v5").as_bytes()).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        // gone before the answer
    }
    for _ in 0..100 {
        if b.hub_commit().is_some() && !b.root.join("deploy-journal.json").exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(b.link("current").as_deref(), Some("hub-v5"));
    assert_eq!(b.hub_commit(), Some(commit_of(5)));
}

#[test]
fn the_tailnet_decides_who_a_caller_is() {
    let tags = vec!["tag:trommi-ci".to_string()];
    let users = vec!["owner@example.com".to_string()];
    let ci = br#"{"Node":{"Name":"runner.ts.net.","Tags":["tag:trommi-ci"]},"UserProfile":{"LoginName":"tagged-devices"}}"#;
    let owner = br#"{"Node":{"Name":"laptop.ts.net."},"UserProfile":{"LoginName":"owner@example.com"}}"#;
    let guest = br#"{"Node":{"Name":"phone.ts.net."},"UserProfile":{"LoginName":"guest@example.com"}}"#;
    let server = br#"{"Node":{"Name":"hub.ts.net.","Tags":["tag:trommi"]},"UserProfile":{"LoginName":"tagged-devices"}}"#;
    // a tagged device is never taken for a person, whatever its profile says
    let odd = br#"{"Node":{"Tags":["tag:other"]},"UserProfile":{"LoginName":"owner@example.com"}}"#;
    assert!(tailnet_allows(ci, &tags, &users).is_ok());
    assert!(tailnet_allows(owner, &tags, &users).is_ok());
    assert!(tailnet_allows(guest, &tags, &users).is_err());
    assert!(tailnet_allows(server, &tags, &users).is_err());
    assert!(tailnet_allows(odd, &tags, &users).is_err());
    assert!(tailnet_allows(owner, &tags, &[]).is_err());
    assert!(tailnet_allows(b"not json", &tags, &users).is_err());
    assert!(tailnet_allows(b"{}", &tags, &users).is_err());
}

// ---- the release form: what the scripts write is what the updater reads ----

#[test]
fn the_key_in_the_repository_is_an_ed25519_public_key() {
    let pem = include_str!("../../release/public-key.pem");
    public_key(pem).expect("release/public-key.pem");
    assert!(public_key("-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n").is_err());
}

#[test]
fn a_manifest_written_and_signed_by_the_scripts_is_accepted() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let dir = std::env::temp_dir().join(format!("trommi-release-form-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("release")).unwrap();
    let sh = |program: &str, args: &[&str], env: &[(&str, &str)]| {
        let out = std::process::Command::new(program)
            .args(args)
            .envs(env.iter().copied())
            .current_dir(&dir)
            .output()
            .unwrap();
        assert!(out.status.success(), "{program} {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        out.stdout
    };
    // a key made for this test, and the scripts beside it as they lie in the repository
    for name in ["manifest.sh", "sign.sh"] {
        std::fs::copy(repo.join("release").join(name), dir.join("release").join(name)).unwrap();
    }
    sh("openssl", &["genpkey", "-algorithm", "ed25519", "-out", "key.pem"], &[]);
    sh("openssl", &["pkey", "-in", "key.pem", "-pubout", "-out", "release/public-key.pem"], &[]);
    let hub = format!("trommi-hub-{TARGET}");
    let updater = format!("trommi-hub-updater-{TARGET}");
    std::fs::write(dir.join(&hub), b"the hub").unwrap();
    std::fs::write(dir.join(&updater), b"the updater").unwrap();
    std::fs::write(dir.join("trommi-hub.service"), b"[Service]\n").unwrap();
    let commit = commit_of(77);
    let manifest = sh(
        "sh",
        &["release/manifest.sh", "trommi-hub", "77", &commit, &hub, &updater, "trommi-hub.service"],
        &[("GITHUB_REPOSITORY", REPOSITORY)],
    );
    std::fs::write(dir.join("manifest.json"), &manifest).unwrap();
    // the key as the 1Password Environment hands it over: on one line
    let one_line = std::fs::read_to_string(dir.join("key.pem")).unwrap().replace('\n', " ");
    sh("sh", &["release/sign.sh", "sign", "manifest.json"], &[("SIGN_RELEASE_KEY", &one_line)]);
    sh("sh", &["release/sign.sh", "files", "manifest.json"], &[]);

    let key = public_key(&std::fs::read_to_string(dir.join("release/public-key.pem")).unwrap()).unwrap();
    let signature = std::fs::read(dir.join("manifest.json.sig")).unwrap();
    let proved = verify_manifest(&key, &manifest, &signature, REPOSITORY, "hub-v77").unwrap();
    assert_eq!((proved.version, proved.commit.as_str()), (77, commit.as_str()));
    assert_eq!(proved.assets.len(), 3);
    assert_eq!(proved.assets[0].sha256, hex(&Sha256::digest(b"the hub")));
    assert_eq!(proved.assets[0].size, 7);
    // asked for under another name, or for another repository: no
    assert!(verify_manifest(&key, &manifest, &signature, REPOSITORY, "hub-v78").is_err());
    assert!(verify_manifest(&key, &manifest, &signature, "someone/else", "hub-v77").is_err());
    // one byte changed: the script's own check and the updater's both say no
    let mut changed = manifest.clone();
    changed[20] ^= 1;
    assert!(verify_manifest(&key, &changed, &signature, REPOSITORY, "hub-v77").is_err());
    std::fs::write(dir.join("manifest.json"), &changed).unwrap();
    let verify = std::process::Command::new("sh")
        .args(["release/sign.sh", "verify", "manifest.json"])
        .current_dir(&dir)
        .output()
        .unwrap();
    assert!(!verify.status.success());
    let _ = std::fs::remove_dir_all(&dir);
}
