//! The Trommi hub for protocol v2 (spec/v1.md, spec/hub-api.md): the MLS delivery service and the store. It holds
//! no private key of a room and reads no content.

#![forbid(unsafe_code)]
// Rows are read from SQLite as tuples and checks take the facts they check: both read better whole than
// wrapped in a type each.
#![allow(clippy::type_complexity, clippy::too_many_arguments)]

pub mod accounts;
pub mod admin;
pub mod api;
pub mod app;
pub mod config;
pub mod content;
pub mod db;
pub mod delivery;
pub mod error;
pub mod files;
pub mod http;
pub mod invites;
pub mod limits;
pub mod live;
pub mod log;
pub mod memo;
pub mod observer;
pub mod prepare;
pub mod push;
pub mod quota;
pub mod rules;
pub mod server;
pub mod session;
pub mod store;
pub mod throttle;
pub mod util;
pub mod webauthn;
pub mod wire;
