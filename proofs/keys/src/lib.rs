//! Feasibility proof: MLS distributes keys only, through a dumb delivery service.
//!
//! Self-contained: OpenMLS directly, an in-memory stub hub, no network.
//! Not production code: JSON where the spec would use a binary encoding,
//! `String` errors, no persistence.

pub mod device;
pub mod hub;
pub mod rules;
pub mod seal;

use openmls::prelude::Ciphersuite;

/// The one ciphersuite of the proof.
pub const CS: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519;

/// Group context extension that carries Trommi's public statement about a group.
pub const EXT_META: u16 = 0xF100;

pub const LABEL_ARCHIVE: &str = "trommi/v2/archive";
pub const LABEL_CONTENT: &str = "trommi/v2/content";
pub const LABEL_BIND: &str = "trommi/v2/helper-bind";

pub type Gid = Vec<u8>;
pub type Key = Vec<u8>;
pub type SigKey = Vec<u8>;

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn unhex(s: &str) -> Vec<u8> {
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap())
        .collect()
}
