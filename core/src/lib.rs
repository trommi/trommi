//! Trommi's protocol core (`spec/v2.md`): every key comes from MLS (RFC 9420) through OpenMLS, and Trommi's own
//! constructs (stored content, recovery, files, invites) run on the same primitives. One crate for the web app
//! (WASM), the iOS app (UniFFI), the connector and the hub; there is no second implementation.
//!
//! # Layers
//!
//! - **Foundation**: [`error`], [`ids`], [`codec`], [`crypto`], [`store`]. They know nothing of the rest.
//! - **Pure modules**: [`envelope`], [`chain`], [`objects`], [`registers`], [`board`], [`files`], [`invite`],
//!   [`hub_auth`], [`push`], [`account`], [`recovery`]. Bytes and state in, bytes and state out: no store, no
//!   OpenMLS group. Where one needs a fact about a group, it declares a small trait for exactly that fact.
//! - **MLS**: [`mls`] wraps OpenMLS.
//! - **Device**: [`device`] composes everything and is the only place that writes to the store. The hub uses the
//!   pure modules, `mls::observer` and `mls::rules`, never the device.
//!
//! No type of OpenMLS, `tls_codec` or `serde` is part of the public interface: bytes, ids and plain structs only.
//! No function reads a clock: whatever needs the time takes `now_ms`. Randomness comes only from a
//! [`crypto::Entropy`].

#![forbid(unsafe_code)]
#![cfg_attr(
    not(test),
    deny(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )
)]

pub mod account;
pub mod board;
pub mod chain;
pub mod codec;
pub mod crypto;
pub mod device;
pub mod envelope;
pub mod error;
pub mod files;
pub mod hub_auth;
pub mod ids;
pub mod invite;
pub mod mls;
pub mod objects;
pub mod push;
pub mod recovery;
pub mod registers;
pub mod store;

pub use error::Error;

/// The version of this crate, as every binding reports it.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
