//! Updates of the connector itself, and the check a new binary must pass.
//!
//! The connector is one file, code and shell together, so nothing is loaded into a running process: a new binary
//! put in place of the running one is noticed (`server.rs` polls its own path), announced to the agent once, and
//! runs after `reload_connector` and a reconnect of the MCP server. A plugin install gets a new release through
//! Claude Code's marketplace update.
//!
//! **Release signatures.** Releases are built and signed in CI (the owner's decision); a connector verifies a
//! new binary against a public key that is compiled in. The key is not in this build yet: [`RELEASE_KEY`] is the
//! one place it goes, and until it is set every check answers [`Release::NotEnforced`], which the connector says
//! out loud instead of pretending to have verified anything. With a key, a binary whose signature is missing or
//! wrong is never announced as an update.
//!
//! The signature is Ed25519 as RFC 9420 labels signatures (the core's `verify_with_label`):
//! `SignWithLabel(release key, "TrommiRelease", SHA-256(binary))`, 64 bytes, in a file beside the binary named
//! `<binary>.sig`.
use std::path::Path;

/// The release public key, 32 bytes of Ed25519. `None`: no key is pinned in this build, and release signatures
/// are **not yet enforced**. CI's public key goes here, and nowhere else.
pub const RELEASE_KEY: Option<[u8; 32]> = None;

const LABEL: &str = "TrommiRelease";

/// What the check of a binary says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Release {
    /// The binary is signed by the pinned release key.
    Verified,
    /// No release key is pinned in this build: nothing was checked.
    NotEnforced,
    /// A key is pinned and the binary's signature is missing or does not verify.
    Refused,
}

/// Checks `binary` against `signature` under `key`.
pub fn verify(key: Option<&[u8; 32]>, binary: &[u8], signature: Option<&[u8]>) -> Release {
    let Some(key) = key else {
        return Release::NotEnforced;
    };
    let digest = crate::util::sha256(binary);
    match signature {
        Some(signature)
            if trommi_core::crypto::verify_with_label(key, LABEL, &digest, signature).is_ok() =>
        {
            Release::Verified
        }
        _ => Release::Refused,
    }
}

/// Checks the binary at `path` with the signature beside it (`<path>.sig`) under the pinned key.
pub fn verify_file(path: &Path) -> Release {
    if RELEASE_KEY.is_none() {
        return Release::NotEnforced;
    }
    let Ok(binary) = std::fs::read(path) else {
        return Release::Refused;
    };
    let mut beside = path.as_os_str().to_owned();
    beside.push(".sig");
    let signature = std::fs::read(beside).ok();
    verify(RELEASE_KEY.as_ref(), &binary, signature.as_deref())
}

/// One line on how far a binary can be trusted, for the update notice and `--version`.
pub fn standing(release: Release) -> &'static str {
    match release {
        Release::Verified => "release signature verified",
        Release::NotEnforced => {
            "release signatures are not yet enforced: this build has no release key pinned"
        }
        Release::Refused => "its release signature is missing or wrong",
    }
}
