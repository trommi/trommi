//! The facade over `trommi-core` that both bindings share: the browser's (`core/wasm`, wasm-bindgen) and Swift's
//! (this crate with the feature `uniffi`, through UniFFI).
//!
//! # One design for both
//!
//! - **Plain data.** Bytes, text, numbers, records ([`macros`]) and enums without data cross the edge. No type
//!   of OpenMLS does, and no handle to anything but the three stateful objects: [`CoreDevice`],
//!   [`FileEncryptor`], [`FileDecryptor`].
//! - **Every call is declared once**, here, with UniFFI's attribute on it. `core/wasm` wraps each for
//!   JavaScript by name; a test compares both bindings with the manifest of these declarations.
//! - **Errors** are [`CoreError`]: the stable code of the specification's section 16 as an [`ErrorCode`], and a
//!   text for a log that never holds key material.
//! - **The store is the host's** ([`store`]): Swift implements a protocol the core calls; the browser hands over
//!   what it loaded and writes out what each call queued.
//! - **Time is the host's** (`now_ms` on every call that needs it); **randomness is the system's**, read inside
//!   the core.
//! - **No panic crosses the edge**, and a stateful object that failed inside the core answers no more
//!   ([`guard`]).
//! - **Freed memory is wiped** ([`wipe`]), so that the copies of keys made at the edge do not outlive their use.

#[macro_use]
mod macros;

pub mod account;
pub mod content;
pub mod device;
pub mod error;
pub mod files;
mod guard;
pub mod invite;
#[cfg(feature = "js")]
pub mod js;
pub mod push;
pub mod records;
pub mod recovery;
pub mod selftest;
pub mod store;
pub mod wipe;

pub use account::*;
pub use content::*;
pub use device::{log_finding, CoreDevice};
pub use error::{error_code_from_text, error_code_text, CoreError, ErrorCode};
pub use files::*;
pub use invite::{
    check_emoji, hub_address, invite_link_parse, CheckCode, EmojiWord, InviteAccepted,
    InviteConfirmed, InviteLinkParts, InviteOpened, InviteRole, InviteStep, InviteStepKind,
    JoinRequest, SignedOffer, SignedRequest, SignedReveal,
};
pub use push::*;
pub use records::*;
pub use recovery::{
    recovery_anchor, recovery_sign_in, Anchor, CodeJoin, Learned, RecoveryPlan, Removals,
    ServedCommit, ServedEnvelope, ServedGroup, ServedRoom, UnverifiedSession,
};
pub use selftest::{self_test, versions, SelfTestReport, SelfTestStep, Versions};
pub use store::{StoreEntry, StoreWrite, StoredState};

#[cfg(feature = "uniffi")]
pub use store::{CoreStore, StoreError};

#[cfg(feature = "uniffi")]
uniffi::setup_scaffolding!();

// Catching a panic at the edge needs unwinding. A build that aborts instead would take the app down with it.
#[cfg(all(feature = "uniffi", panic = "abort"))]
compile_error!("the Swift binding must be built with panic = \"unwind\" (the default)");

#[global_allocator]
static ALLOCATOR: wipe::Wiping = wipe::Wiping;

use trommi_core::ids::{self, GroupId, RoomId, SessionId};

/// What a KeyPackage says, after verifying it; `bad-key-package` when it does not verify.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn key_package_info(key_package: Vec<u8>) -> Result<KeyPackageInfo, CoreError> {
    Ok(trommi_core::device::key_package_info(&key_package)?.into())
}

/// The id of a room's room group: the room id itself, 32 bytes.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn room_group_id(room: Vec<u8>) -> Result<Vec<u8>, CoreError> {
    Ok(GroupId::room(RoomId::from_slice(&room)?)
        .as_bytes()
        .to_vec())
}

/// The id of a session's group: the room id followed by the session id, 48 bytes.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn session_group_id(room: Vec<u8>, session: Vec<u8>) -> Result<Vec<u8>, CoreError> {
    let group = GroupId::session(RoomId::from_slice(&room)?, SessionId::from_slice(&session)?);
    Ok(group.as_bytes().to_vec())
}

/// Bytes as the protocol writes them in text: base64url without padding.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn base64url_encode(bytes: Vec<u8>) -> String {
    ids::base64url_encode(&bytes)
}

/// The bytes a base64url text stands for; `bad-format` for anything but the one canonical spelling.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn base64url_decode(text: String) -> Result<Vec<u8>, CoreError> {
    Ok(ids::base64url_decode(&text)?)
}
