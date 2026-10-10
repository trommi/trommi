//! Updates of the connector itself, and the check a release must pass.
//!
//! The connector is one file, code and shell together, so nothing is loaded into a running process: a new binary
//! put in place of the running one is noticed (`server.rs` polls its own path), announced to the agent once, and
//! runs after `reload_connector` and a reconnect of the MCP server.
//!
//! **Release signatures.** Releases are built and signed in CI (`.github/workflows/release.yml`), in the
//! form every signed part of the repository uses (`release/manifest.sh`, `release/sign.sh`): one `manifest.json`
//! for all files of a release, and `manifest.json.sig`, an Ed25519 signature (64 raw bytes) over the exact bytes
//! of the manifest. The public key is `release/public-key.pem` of this repository, compiled in ([`RELEASE_KEY`]):
//! a release never brings a key with it.
//!
//! Whoever takes a release checks, in this order ([`check`]): the signature; that the manifest is of this
//! product (`trommi-connector`), this repository, with the tag that belongs to its version, and of a version
//! that is not older than the one running; then that the binary is the file the manifest names for this
//! machine's target, by size and SHA-256.
//!
//! **Where a connector is installed.** `install.sh` of the repository puts the program, `manifest.json` and
//! `manifest.json.sig` into `~/.local/share/trommi/bin/` ([`installed_dir`]) after the same checks, done with
//! openssl. `trommi-connector update` ([`update`]) does it again from inside: it finds the newest release that
//! has a connector for this machine (GitHub's feed of releases, then each release asked for its files), downloads the three files (https only, GitHub's hosts only, each bounded),
//! runs [`check`] under the compiled-in key and only then replaces what is installed ([`install`]: the
//! manifest first, the program last, each by a rename).
//!
//! A manifest lies beside the binary it is for ([`verify_file`] looks in the binary's folder and the two above
//! it, where an installer puts `manifest.json` and `manifest.json.sig`). A binary without one is
//! [`Release::Unverified`], and the connector says so instead of pretending; one whose manifest does not check
//! is [`Release::Refused`], is never announced as an update and never started by this process.
use ed25519_dalek::{Signature, VerifyingKey};
use serde_json::Value;
use std::path::{Path, PathBuf};

include!(concat!(env!("OUT_DIR"), "/release.rs"));

/// The products a release that holds a connector names: a release of the connector alone, or one of the
/// whole repository (one tag series `v<N>`).
pub const PRODUCTS: [&str; 2] = ["trommi-connector", "trommi"];
/// The repository releases come from.
pub const REPOSITORY: &str = "trommi/trommi";
/// The largest manifest that is read.
const MAX_MANIFEST_LEN: u64 = 1 << 20;

/// What the check of a binary says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Release {
    /// The binary is a file of a release signed with the release key: its version.
    Verified(u64),
    /// No manifest lies beside the binary: nothing was checked.
    Unverified,
    /// A manifest lies beside it and the check failed: why.
    Refused(&'static str),
}

/// What a release is held against: the key, and what the taker is.
#[derive(Debug, Clone, Copy)]
pub struct Expect<'a> {
    /// The release public key.
    pub key: &'a [u8; 32],
    /// The target the binary must be for, e.g. `x86_64-unknown-linux-musl`.
    pub target: &'a str,
    /// The version that runs now; an older release is refused. 0 for a build that is no release.
    pub running: u64,
}

/// Checks a binary against a signed manifest. `Ok` is the release's version.
pub fn check(
    expect: &Expect<'_>,
    manifest: &[u8],
    signature: &[u8],
    binary: &[u8],
) -> Result<u64, &'static str> {
    // 1. The signature, over the manifest's exact bytes.
    let key = VerifyingKey::from_bytes(expect.key).map_err(|_| "the release key is no key")?;
    let signature =
        Signature::from_slice(signature).map_err(|_| "the signature is not 64 bytes")?;
    key.verify_strict(manifest, &signature)
        .map_err(|_| "the manifest's signature does not match the release key")?;
    // 2. What the manifest says it is.
    let stated: Value = serde_json::from_slice(manifest).map_err(|_| "the manifest is not JSON")?;
    let product = stated.get("product").and_then(Value::as_str);
    if !product.is_some_and(|product| PRODUCTS.contains(&product)) {
        return Err("the manifest is of another product");
    }
    if stated.get("repository").and_then(Value::as_str) != Some(REPOSITORY) {
        return Err("the manifest is of another repository");
    }
    let version = stated
        .get("version")
        .and_then(Value::as_u64)
        .filter(|version| *version > 0)
        .ok_or("the manifest names no version")?;
    // The tag is the manifest's own word, and it must be its version's: `connector-v<N>`, or `v<N>`.
    let tag = stated.get("tag").and_then(Value::as_str);
    if !tag
        .is_some_and(|tag| tag == format!("v{version}") || tag == format!("connector-v{version}"))
    {
        return Err("the manifest's tag is not its version's");
    }
    if version < expect.running {
        return Err("the release is older than the connector that runs");
    }
    // 3. The file, by the name it has in a release, its size and its SHA-256.
    let name = format!("trommi-connector-{}", expect.target);
    let asset = stated
        .get("assets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|asset| asset.get("name").and_then(Value::as_str) == Some(name.as_str()))
        .ok_or("the manifest names no binary for this machine")?;
    let same_size = asset.get("size").and_then(Value::as_u64) == Some(binary.len() as u64);
    let same_hash = asset.get("sha256").and_then(Value::as_str)
        == Some(crate::util::hex(&crate::util::sha256(binary)).as_str());
    if !same_size || !same_hash {
        return Err("the binary is not the file the manifest names");
    }
    Ok(version)
}

/// Checks the binary at `path` with the manifest beside it, under the compiled-in key, for this build's target
/// and against this build's version.
pub fn verify_file(path: &Path) -> Release {
    let found = path
        .ancestors()
        .skip(1)
        .take(3)
        .map(|dir| (dir.join("manifest.json"), dir.join("manifest.json.sig")))
        .find(|(manifest, _)| manifest.is_file());
    let Some((manifest, signature)) = found else {
        return Release::Unverified;
    };
    let small = |file: &Path| {
        std::fs::metadata(file)
            .ok()
            .filter(|meta| meta.len() <= MAX_MANIFEST_LEN)
            .and_then(|_| std::fs::read(file).ok())
    };
    let (Some(manifest), Some(signature)) = (small(&manifest), small(&signature)) else {
        return Release::Refused("the manifest or its signature cannot be read");
    };
    let Ok(binary) = std::fs::read(path) else {
        return Release::Refused("the binary cannot be read");
    };
    let expect = Expect {
        key: &RELEASE_KEY,
        target: TARGET,
        running: RELEASE_VERSION,
    };
    match check(&expect, &manifest, &signature, &binary) {
        Ok(version) => Release::Verified(version),
        Err(why) => Release::Refused(why),
    }
}

/// One line on how far a binary can be trusted, for the update notice and `--version`.
pub fn standing(release: &Release) -> String {
    match release {
        Release::Verified(version) => format!("release {version}, signature verified"),
        Release::Unverified => {
            "not verified: no signed release manifest lies beside this binary".into()
        }
        Release::Refused(why) => format!("REFUSED as a release: {why}"),
    }
}

/// The folder `install.sh` installs into: `~/.local/share/trommi/bin`.
pub fn installed_dir() -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var_os("HOME").filter(|home| !home.is_empty())?);
    home.is_absolute()
        .then(|| home.join(".local/share/trommi/bin"))
}

/// The installed program: what the plugin for Claude Code and a Codex set-up name.
pub fn installed_program() -> Option<PathBuf> {
    installed_dir().map(|dir| dir.join("trommi-connector"))
}

/// The version of the release a folder holds, when its manifest is signed with `key`. A manifest that is not
/// counts for nothing.
pub fn installed_version(key: &[u8; 32], dir: &Path) -> u64 {
    let read = |name: &str| std::fs::read(dir.join(name)).ok();
    let (Some(manifest), Some(signature)) = (read("manifest.json"), read("manifest.json.sig"))
    else {
        return 0;
    };
    let signed = VerifyingKey::from_bytes(key).ok().is_some_and(|key| {
        Signature::from_slice(&signature)
            .is_ok_and(|sig| key.verify_strict(&manifest, &sig).is_ok())
    });
    if !signed {
        return 0;
    }
    serde_json::from_slice::<Value>(&manifest)
        .ok()
        .and_then(|stated| stated.get("version").and_then(Value::as_u64))
        .unwrap_or(0)
}

/// Puts a release into `dir` after [`check`] passed: `manifest.json.sig`, `manifest.json`, then
/// `trommi-connector` (0755), each written beside its place and renamed onto it. A release older than the one
/// `dir` holds is refused. The program is left in place when it is the same file (a release in which the
/// connector did not change): only the manifest and its signature are new. `Ok` is the version that is installed
/// now.
pub fn install(
    expect: &Expect<'_>,
    dir: &Path,
    manifest: &[u8],
    signature: &[u8],
    binary: &[u8],
) -> Result<u64, String> {
    let expect = Expect {
        running: expect.running.max(installed_version(expect.key, dir)),
        ..*expect
    };
    let version = check(&expect, manifest, signature, binary)?;
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let put = |name: &str, bytes: &[u8], mode: u32| -> std::io::Result<()> {
        let new = dir.join(format!(".new.{name}"));
        let _ = std::fs::remove_file(&new);
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(&new)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&new, dir.join(name))
    };
    std::fs::create_dir_all(dir)
        .and_then(|()| put("manifest.json.sig", signature, 0o644))
        .and_then(|()| put("manifest.json", manifest, 0o644))
        .and_then(|()| {
            let same = std::fs::read(dir.join("trommi-connector")).is_ok_and(|have| have == binary);
            if same {
                Ok(())
            } else {
                put("trommi-connector", binary, 0o755)
            }
        })
        .map_err(|error| format!("{} could not be written: {error}", dir.display()))?;
    Ok(version)
}

/// The number of a release tag: `v<N>` or `<series>-v<N>` (series in lower-case letters), no leading zero.
pub fn tag_number(tag: &str) -> Option<u64> {
    let (series, number) = tag.rsplit_once('v')?;
    let plain = series.is_empty()
        || (series.len() > 1
            && series.ends_with('-')
            && series[..series.len() - 1]
                .bytes()
                .all(|byte| byte.is_ascii_lowercase()));
    let whole = !number.is_empty()
        && number.len() <= 12
        && !number.starts_with('0')
        && number.bytes().all(|byte| byte.is_ascii_digit());
    (plain && whole).then(|| number.parse().ok()).flatten()
}

/// The release tags in GitHub's feed of a repository's releases (`https://github.com/<repo>/releases.atom`),
/// highest number first, of the series that hold a connector: `connector-v<N>` and `v<N>`. Which of them hold a
/// connector for this machine is asked of each in turn ([`update`]): the feed does not list a release's files.
pub fn tags_in_feed(feed: &str) -> Vec<String> {
    let link = format!("href=\"https://github.com/{REPOSITORY}/releases/tag/");
    let mut tags: Vec<(u64, String)> = feed
        .split(link.as_str())
        .skip(1)
        .filter_map(|rest| rest.split('"').next())
        // only the series that hold a connector; other parts' releases share the numbers (hub-v34)
        .filter(|tag| tag.starts_with('v') || tag.starts_with("connector-v"))
        .filter_map(|tag| tag_number(tag).map(|number| (number, tag.to_string())))
        .collect();
    tags.sort_by(|a, b| b.cmp(a));
    tags.dedup();
    tags.into_iter().map(|(_, tag)| tag).collect()
}

/// The largest connector that is downloaded.
const MAX_BINARY_LEN: u64 = 200 << 20;
/// The largest feed of releases that is read.
const MAX_LISTING_LEN: u64 = 8 << 20;
/// How many of the newest releases are asked whether they hold a connector for this machine.
const MAX_PROBES: usize = 20;
/// The hosts GitHub hands a release's file out from.
const ASSET_HOSTS: [&str; 2] = [
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
];

/// The higher of what this process was built as and what is installed.
fn newer_of(built: u64, installed: u64) -> u64 {
    built.max(installed)
}

/// One GET: https only, no redirect followed (the client is built so).
async fn get(http: &reqwest::Client, url: &str) -> Result<reqwest::Response, String> {
    http.get(url)
        .send()
        .await
        .map_err(|_| format!("{url} cannot be reached"))
}

async fn body(mut response: reqwest::Response, url: &str, max: u64) -> Result<Vec<u8>, String> {
    if !response.status().is_success() {
        return Err(format!("{url} answers {}", response.status().as_u16()));
    }
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if bytes.len() as u64 + chunk.len() as u64 > max {
                    return Err(format!("{url} is larger than it may be"));
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(None) => return Ok(bytes),
            Err(_) => return Err(format!("{url} broke off")),
        }
    }
}

/// A file of a release: github.com answers with a redirect into its release store; the redirect is held
/// against the hosts that store is, and fetched as a second request.
async fn asset(http: &reqwest::Client, tag: &str, name: &str, max: u64) -> Result<Vec<u8>, String> {
    let url = format!("https://github.com/{REPOSITORY}/releases/download/{tag}/{name}");
    let first = get(http, &url).await?;
    if !first.status().is_redirection() {
        return Err(format!("{url} answers {}", first.status().as_u16()));
    }
    let to = first
        .headers()
        .get("location")
        .and_then(|value| value.to_str().ok())
        .and_then(|to| reqwest::Url::parse(to).ok())
        .filter(|to| {
            to.scheme() == "https"
                && to
                    .host_str()
                    .is_some_and(|host| ASSET_HOSTS.contains(&host))
        })
        .ok_or_else(|| format!("{url} points somewhere unexpected"))?;
    let second = http
        .get(to)
        .send()
        .await
        .map_err(|_| format!("{url} cannot be reached"))?;
    body(second, &url, max).await
}

/// Whether a release has a file: github.com answers a file of a release with a redirect, and a missing one
/// with 404. Nothing is downloaded.
async fn has_asset(http: &reqwest::Client, tag: &str, name: &str) -> Result<bool, String> {
    let url = format!("https://github.com/{REPOSITORY}/releases/download/{tag}/{name}");
    let answer = http
        .head(&url)
        .send()
        .await
        .map_err(|_| format!("{url} cannot be reached"))?;
    match answer.status().as_u16() {
        301 | 302 | 303 | 307 | 308 => Ok(true),
        404 => Ok(false),
        other => Err(format!("{url} answers {other}")),
    }
}

/// The newest release that holds `manifest.json` and the connector for this machine.
async fn newest_release(http: &reqwest::Client) -> Result<String, String> {
    let feed_url = format!("https://github.com/{REPOSITORY}/releases.atom");
    let feed = body(get(http, &feed_url).await?, &feed_url, MAX_LISTING_LEN).await?;
    let name = format!("trommi-connector-{TARGET}");
    for tag in tags_in_feed(&String::from_utf8_lossy(&feed))
        .iter()
        .take(MAX_PROBES)
    {
        if has_asset(http, tag, &name).await? && has_asset(http, tag, "manifest.json").await? {
            return Ok(tag.clone());
        }
    }
    Err(format!(
        "no recent release of {REPOSITORY} has a connector for {TARGET}"
    ))
}

/// `trommi-connector update`: the newest release that has a connector for this machine is downloaded, checked
/// and put in place of the installed one. With `only_look` nothing is written. The answer is one line for the
/// human.
pub async fn update(only_look: bool) -> Result<String, String> {
    let dir = installed_dir().ok_or("HOME is not set to a folder")?;
    let this = crate::server::self_path();
    let installed = dir.join("trommi-connector");
    let same = crate::setup::is_installed(&this);
    if !same && !only_look {
        return Err(format!(
            "this connector ({}) is not the installed one ({}): install with install.sh of github.com/{REPOSITORY}, then `update` keeps that one new",
            this.display(),
            installed.display()
        ));
    }
    let http = reqwest::Client::builder()
        .user_agent(crate::CLIENT)
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(900))
        .redirect(reqwest::redirect::Policy::none())
        .https_only(true)
        .build()
        .map_err(|_| "no HTTP client".to_string())?;
    let tag = newest_release(&http).await?;
    let manifest = asset(&http, &tag, "manifest.json", MAX_MANIFEST_LEN).await?;
    let signature = asset(&http, &tag, "manifest.json.sig", 1024).await?;
    let expect = Expect {
        key: &RELEASE_KEY,
        target: TARGET,
        running: newer_of(RELEASE_VERSION, installed_version(&RELEASE_KEY, &dir)),
    };
    // The manifest is believed only as far as its signature goes; the version it names decides whether the
    // binary is fetched at all.
    let key = VerifyingKey::from_bytes(expect.key).map_err(|_| "the release key is no key")?;
    let signed = Signature::from_slice(&signature)
        .is_ok_and(|signature| key.verify_strict(&manifest, &signature).is_ok());
    if !signed {
        return Err(format!(
            "release {tag}: the manifest's signature does not match the release key; nothing was changed"
        ));
    }
    let stated = serde_json::from_slice::<Value>(&manifest).unwrap_or(Value::Null);
    // The release the files were downloaded from must be the one the manifest says it is.
    if stated.get("tag").and_then(Value::as_str) != Some(tag.as_str()) {
        return Err(format!(
            "release {tag}: its manifest is of another release; nothing was changed"
        ));
    }
    let version = stated.get("version").and_then(Value::as_u64).unwrap_or(0);
    if version <= expect.running {
        return Ok(format!(
            "release {} is installed, and the newest is {tag}: nothing to do",
            expect.running
        ));
    }
    if only_look {
        return Ok(format!(
            "release {tag} is newer than this one ({}), its manifest is signed with the release key: `trommi-connector update` installs it",
            expect.running
        ));
    }
    let name = format!("trommi-connector-{TARGET}");
    // The connector did not change in that release (the same SHA-256 as the installed program): nothing is
    // downloaded, and `install` keeps the program and takes the newer manifest.
    let stated_sha256 = stated
        .get("assets")
        .and_then(Value::as_array)
        .and_then(|assets| {
            assets
                .iter()
                .find(|a| a.get("name").and_then(Value::as_str) == Some(name.as_str()))
        })
        .and_then(|a| a.get("sha256").and_then(Value::as_str))
        .map(str::to_string);
    let have = std::fs::read(&installed).ok();
    let binary = match have {
        Some(have)
            if stated_sha256.as_deref()
                == Some(crate::util::hex(&crate::util::sha256(&have)).as_str()) =>
        {
            have
        }
        _ => asset(&http, &tag, &name, MAX_BINARY_LEN).await?,
    };
    let version = install(&expect, &dir, &manifest, &signature, &binary)
        .map_err(|why| format!("release {tag}: {why}; nothing was changed"))?;
    Ok(format!(
        "installed release {version} ({tag}), signature verified. A running connector says so on its next event; `reload_connector` and a reconnect start the new one."
    ))
}
