//! Push (section 15.2): the key an app registers for its notifications, and the opening of what arrives. A push
//! carries no content: it names a room and a change, and for APNs a ticket that fetches one envelope.

use crate::CoreError;
use trommi_core::crypto::{Secret, SystemEntropy};
use trommi_core::push;

record! {
    /// What a push says. The ticket fetches an envelope for a day: it is not printed.
    secret pub struct PushNote {
        /// The room something changed in, 32 bytes.
        pub room_id: Vec<u8>,
        /// The hub's change number of the envelope that rang.
        pub change: u64,
        /// 0 low, 1 normal, 2 high, 3 critical.
        pub urgency: u8,
        /// For APNs, what fetches that one envelope for a day; empty when there is none, and for a Web Push.
        pub ticket: Vec<u8>,
    }
}

/// A fresh key for the APNs payload: 32 random bytes, registered at the hub and kept in the app group for the
/// notification extension.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn generate_push_key() -> Result<Vec<u8>, CoreError> {
    Ok(push::generate_key(&mut SystemEntropy)?.expose().to_vec())
}

/// Opens the sealed payload of an APNs notification under the key the app registered; `decrypt-failed` when it
/// does not open, `bad-format` for a payload of another spelling.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn open_apns_push(key: Vec<u8>, sealed: Vec<u8>) -> Result<PushNote, CoreError> {
    let opened = push::open(&Secret::<32>::from_slice(&key)?, &sealed)?;
    Ok(PushNote {
        room_id: opened.room_id.as_bytes().to_vec(),
        change: opened.change,
        urgency: opened.urgency,
        ticket: opened.ticket.clone(),
    })
}

/// Reads the payload of a Web Push, after the browser decrypted it; `bad-format` for another spelling.
#[cfg_attr(feature = "uniffi", uniffi::export)]
pub fn read_web_push(payload: Vec<u8>) -> Result<PushNote, CoreError> {
    let read = push::WebPush::decode(&payload)?;
    Ok(PushNote {
        room_id: read.room_id.as_bytes().to_vec(),
        change: read.change,
        urgency: read.urgency,
        ticket: Vec::new(),
    })
}
