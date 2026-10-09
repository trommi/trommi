//! Updates of the connector itself, and the check a release must pass.
//!
//! The connector is one file, code and shell together, so nothing is loaded into a running process: a new binary
//! put in place of the running one is noticed (`server.rs` polls its own path), announced to the agent once, and
//! runs after `reload_connector` and a reconnect of the MCP server.
//!
//! **Release signatures.** Releases are built and signed in CI (`.github/workflows/deploy_connector.yml`), in the
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
//! A manifest lies beside the binary it is for ([`verify_file`] looks in the binary's folder and the two above
//! it, where an installer puts `manifest.json` and `manifest.json.sig`). A binary without one is
//! [`Release::Unverified`], and the connector says so instead of pretending; one whose manifest does not check
//! is [`Release::Refused`], is never announced as an update and never started by this process.
use ed25519_dalek::{Signature, VerifyingKey};
use serde_json::Value;
use std::path::Path;

include!(concat!(env!("OUT_DIR"), "/release.rs"));

/// The product a connector release names.
pub const PRODUCT: &str = "trommi-connector";
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
    if stated.get("product").and_then(Value::as_str) != Some(PRODUCT) {
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
    if stated.get("tag").and_then(Value::as_str) != Some(format!("connector-v{version}").as_str()) {
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
        Release::Verified(version) => format!("release connector-v{version}, signature verified"),
        Release::Unverified => {
            "not verified: no signed release manifest lies beside this binary".into()
        }
        Release::Refused(why) => format!("REFUSED as a release: {why}"),
    }
}
