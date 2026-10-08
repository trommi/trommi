//! The Trommi connector in Rust: the crypto core (zcrypto, session grants), the client core of an agent device
//! (transport, storage, model, sync), and the connector around it (MCP server, tools, key slots, CLI).
pub mod agent;
pub mod bridge;
pub mod client;
pub mod codec;
pub mod connector;
pub mod crypto;
pub mod driver;
pub mod error;
pub mod html;
pub mod keychain;
pub mod model;
pub mod prompt;
pub mod room;
pub mod storage;
pub mod transport;

/// Sent as Trommi-Client on every request (the JS connector's CLIENT); the hub answers 426 when it is too old.
pub const CLIENT: &str = "connector/0.1.0";
