//! The Trommi connector: an agent device of a Trommi room (protocol v2, every key and check from `trommi-core`)
//! and the MCP server through which a Claude Code session talks to the human's board.
#![forbid(unsafe_code)]

pub mod agent;
pub mod client;
pub mod error;
pub mod hub;
pub mod keeper;
pub mod model;
pub mod recovery;
pub mod store;
pub mod util;
pub mod vault;

/// Sent as `Trommi-Client` on every request; the hub answers `client-too-old` when it wants a newer one.
pub const CLIENT: &str = concat!("connector/", env!("CARGO_PKG_VERSION"));
