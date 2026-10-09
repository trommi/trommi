//! The vectors of the specification (`spec/vectors/*.json`): how they are made and checked.
//!
//! Every subject has one module here with `pub fn generate() -> Result<Value, Error>` and one line in [`FILES`].
//! A generator draws all its randomness from [`entropy`], so the same file comes out on every run. The program
//! `vectors` writes the files; the test `core_vectors` fails when a committed file differs from what the core
//! produces now; each subject's own test reads its file back and checks it through the core's public interface.

pub mod board;
pub mod envelope;
pub mod files;
pub mod hub_auth;
pub mod invite;
pub mod recovery;
pub mod trail;

use std::path::PathBuf;

use serde_json::Value;
use trommi_core::crypto::{sha256, SeededEntropy};
use trommi_core::Error;

/// Makes the content of one vector file.
pub type Generate = fn() -> Result<Value, Error>;

/// Every vector file: its name without `.json`, and its generator. A subject adds its line here.
pub const FILES: &[(&str, Generate)] = &[
    (board::NAME, board::generate),
    (envelope::NAME, envelope::generate),
    (files::NAME, files::generate),
    (hub_auth::NAME, hub_auth::generate),
    (invite::NAME, invite::generate),
    (recovery::NAME, recovery::generate),
    (trail::NAME, trail::generate),
];

/// The random source of the vector file `name`: seeded from the name alone.
pub fn entropy(name: &str) -> Result<SeededEntropy, Error> {
    let seed = sha256(format!("trommi vectors {name}").as_bytes())?;
    Ok(SeededEntropy::new(*seed.as_bytes()))
}

/// Bytes as lower-case hex, the form every vector file uses.
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Hex text back to bytes; `None` if it is not hex.
pub fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|at| {
            text.get(at..at + 2)
                .and_then(|pair| u8::from_str_radix(pair, 16).ok())
        })
        .collect()
}

/// The text of a vector file: indented JSON with a final line break.
pub fn render(value: &Value) -> Result<String, Error> {
    let mut text =
        serde_json::to_string_pretty(value).map_err(|_| Error::Internal("vector json"))?;
    text.push('\n');
    Ok(text)
}

/// Where the vector files lie: `spec/vectors` of the repository.
pub fn directory() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../spec/vectors")
}

/// The committed content of the vector file `name`, parsed.
pub fn read(name: &str) -> Result<Value, Error> {
    let text = std::fs::read_to_string(directory().join(format!("{name}.json")))
        .map_err(|error| Error::Storage(error.to_string()))?;
    serde_json::from_str(&text).map_err(|_| Error::BadFormat)
}
