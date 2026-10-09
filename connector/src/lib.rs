//! The Trommi connector: an agent device of a Trommi room (protocol v2, every key and check from `trommi-core`)
//! and the MCP server through which a Claude Code session talks to the human's board.
#![forbid(unsafe_code)]

pub mod agent;
pub mod bridge;
pub mod cli;
pub mod client;
pub mod door;
pub mod error;
pub mod hooks;
pub mod html;
pub mod hub;
pub mod join;
pub mod keeper;
pub mod line;
pub mod mcp;
pub mod member;
pub mod mirror;
pub mod model;
pub mod prompt;
pub mod server;
pub mod slots;
pub mod slotstore;
pub mod store;
pub mod trail;
pub mod update;
pub mod util;
pub mod vault;

/// Sent as `Trommi-Client` on every request; the hub answers `client-too-old` when it wants a newer one.
pub const CLIENT: &str = concat!("connector/", env!("CARGO_PKG_VERSION"));
