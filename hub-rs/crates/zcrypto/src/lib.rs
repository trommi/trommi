//! zcrypto: the Trommi wire format version 1 in Rust, byte for byte as `shared/crypto/zcrypto.mjs` and
//! `shared/crypto/session-grants.mjs` (spec: `shared/crypto/FORMAT.md`). The hub needs the verifying half
//! (member list, invites, sign-in, envelope headers and chains, session grants); the primitives that build and
//! open things (sealed box, back links, sender keys, assets) are here too, so that `vectors.json` can be checked.

pub mod bytes;
pub mod prim;
pub mod log;
pub mod invite;
pub mod envelope;
pub mod grants;

pub use bytes::{b64u, hex, unb64u, unhex};

/// Every refusal carries a stable machine-readable code (`ZError.code` in JS). `message` is the JS
/// `err.message`, which starts with the code ("bad-signature: envelope").
#[derive(Debug, Clone, PartialEq)]
pub struct ZError {
    pub code: String,
    pub message: String,
    /// `not-member` of a removed device's sign-in: the entry that removed it.
    pub removed_seq: Option<u32>,
}

impl ZError {
    pub fn new(code: &str, message: &str) -> Self {
        let message = if message.is_empty() { code.to_string() } else { format!("{code}: {message}") };
        ZError { code: code.to_string(), message, removed_seq: None }
    }
}
impl std::fmt::Display for ZError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(&self.message) }
}
impl std::error::Error for ZError {}

pub type ZResult<T> = Result<T, ZError>;
pub fn fail(code: &str, message: &str) -> ZError { ZError::new(code, message) }

pub const VERSION: u8 = 1;

/// Second byte of every top-level object, after the version byte.
pub mod obj {
    pub const LOG_ENTRY: u8 = 0x01;
    pub const ENVELOPE: u8 = 0x02;
    pub const ENVELOPE_PRUNED: u8 = 0x03;
    pub const SEALED: u8 = 0x04;
    pub const INVITE_OFFER: u8 = 0x05;
    pub const INVITE_REQUEST: u8 = 0x06;
    pub const INVITE_REVEAL: u8 = 0x07;
    pub const BACK_LINK: u8 = 0x08;
    pub const ASSET: u8 = 0x09;
    pub const DEVICE_SECRET: u8 = 0x0c;
    pub const HUB_AUTH: u8 = 0x0d;
    pub const GRANT: u8 = 0x0e;
    pub const SESSION_BACK_LINK: u8 = 0x0f;
}

/// Every domain-separation label (FORMAT.md section 3).
pub mod label {
    pub const DEVICE_ID: &str = "trommi/v1/device-id";
    pub const LOG_ENTRY: &str = "trommi/v1/log-entry";
    pub const LOG_SIG: &str = "trommi/v1/log-sig";
    pub const SEALED_BOX: &str = "trommi/v1/sealed-box";
    pub const EPOCH_WRAP: &str = "trommi/v1/epoch-wrap";
    pub const KEY_COMMIT: &str = "trommi/v1/epoch-commit/key";
    pub const HIST_COMMIT: &str = "trommi/v1/epoch-commit/hist";
    pub const BACK_LINK: &str = "trommi/v1/back-link";
    pub const SENDER_KEY: &str = "trommi/v1/sender-key";
    pub const ENVELOPE: &str = "trommi/v1/envelope";
    pub const ENVELOPE_SIG: &str = "trommi/v1/envelope-sig";
    pub const INVITE_ID: &str = "trommi/v1/invite-id";
    pub const INVITE_MAC: &str = "trommi/v1/invite-mac";
    pub const INVITE_COMMIT: &str = "trommi/v1/invite-commit";
    pub const INVITE_OFFER: &str = "trommi/v1/invite-offer";
    pub const INVITE_OFFER_SIG: &str = "trommi/v1/invite-offer-sig";
    pub const INVITE_REQUEST: &str = "trommi/v1/invite-request";
    pub const INVITE_REQUEST_SIG: &str = "trommi/v1/invite-request-sig";
    pub const INVITE_REVEAL_SIG: &str = "trommi/v1/invite-reveal-sig";
    pub const INVITE_CODE: &str = "trommi/v1/invite-code";
    pub const RECOVERY_SIGN: &str = "trommi/v1/recovery/sign";
    pub const RECOVERY_KEX: &str = "trommi/v1/recovery/kex";
    pub const HUB_AUTH: &str = "trommi/v1/hub-auth";
    pub const OBJECT_ID: &str = "trommi/v1/object-id";
    pub const SESSION_COMMIT_KEY: &str = "trommi/v1/session-commit/key";
    pub const SESSION_COMMIT_HIST: &str = "trommi/v1/session-commit/hist";
    pub const GRANT_SIG: &str = "trommi/v1/session-grant-sig";
    pub const GRANT: &str = "trommi/v1/session-grant";
    pub const SESSION_WRAP: &str = "trommi/v1/session-wrap";
    pub const SESSION_MANIFEST: &str = "trommi/v1/session-manifest";
    pub const SESSION_BACK_LINK: &str = "trommi/v1/session-back-link";
}

pub const ROLE_HUMAN: u8 = 1;
pub const ROLE_AGENT: u8 = 2;
pub const EPOCH_GRACE_MS: i64 = 2 * 60 * 1000;
