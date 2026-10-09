//! Push (section 15.2): what a notification carries. No content: the room, the hub's change number to fetch from,
//! and the urgency.
//!
//! - **Web Push** is encrypted to the browser by RFC 8291 already; its payload is the JSON
//!   `{ "room_id", "change", "urgency" }` ([`WebPush`]).
//! - **APNs** shows Apple the payload, so the hub seals the same facts and a `ticket` under 32 random bytes the app
//!   made and registered ([`generate_key`]): `nonce(12) ‖ AEAD.Seal(key, nonce, aad = "trommi apns v2", JSON)`
//!   ([`seal`], [`open`]). The ticket is the hub's own MAC, with which the notification extension fetches one
//!   envelope; here it is opaque bytes, empty when there is nothing to fetch.
//!
//! The JSON has one spelling: the fields in the order given, no white space, bytes as base64url, numbers as plain
//! decimals. A reader refuses any other text (`bad-format`), so that what is parsed is what was sealed.

use crate::crypto::{self, Entropy, Secret, NONCE_LEN, TAG_LEN};
use crate::error::Error;
use crate::ids::{self, RoomId};
use serde::{Deserialize, Serialize};
use std::fmt;
use zeroize::{Zeroize, Zeroizing};

/// The associated data of the APNs sealing.
const APNS_AAD: &[u8] = b"trommi apns v2";
/// The highest urgency (section 9: 0 low, 1 normal, 2 high, 3 critical).
pub const MAX_URGENCY: u8 = 3;
/// The highest change number a payload carries: every JSON reader holds it exactly.
pub const MAX_CHANGE: u64 = (1 << 53) - 1;
/// The longest ticket, in bytes.
pub const MAX_TICKET_LEN: usize = 256;
/// The longest Web Push payload: the three fields at their longest.
pub const MAX_WEB_PUSH_LEN: usize = 128;
/// The longest sealed APNs payload: the JSON with the longest ticket, the nonce and the tag.
pub const MAX_APNS_LEN: usize = 512;

/// The payload of a Web Push.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebPush {
    /// The room something changed in.
    pub room_id: RoomId,
    /// The hub's change number of the envelope that rang.
    pub change: u64,
    /// 0 low, 1 normal, 2 high, 3 critical.
    pub urgency: u8,
}

/// What an APNs notification carries sealed. The ticket fetches an envelope for a day: it is not printed.
#[derive(Clone, PartialEq, Eq)]
pub struct ApnsPush {
    /// The room something changed in.
    pub room_id: RoomId,
    /// The hub's change number of the envelope that rang.
    pub change: u64,
    /// 0 low, 1 normal, 2 high, 3 critical.
    pub urgency: u8,
    /// The hub's ticket for `GET /v2/push-envelope`; empty when there is no envelope to fetch.
    pub ticket: Vec<u8>,
}

impl fmt::Debug for ApnsPush {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ApnsPush")
            .field("room_id", &self.room_id)
            .field("change", &self.change)
            .field("urgency", &self.urgency)
            .field("ticket", &"<redacted>")
            .finish()
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WebPushJson {
    room_id: String,
    change: u64,
    urgency: u8,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ApnsPushJson {
    room_id: String,
    change: u64,
    urgency: u8,
    ticket: String,
}

fn check_numbers(change: u64, urgency: u8) -> Result<(), Error> {
    if change > MAX_CHANGE || urgency > MAX_URGENCY {
        return Err(Error::BadFormat);
    }
    Ok(())
}

/// The JSON of a payload, written into one buffer large enough for the longest: it holds the ticket and is
/// not moved while it grows. The caller wipes it.
fn to_json<T: Serialize>(value: &T) -> Result<Vec<u8>, Error> {
    let mut json = Vec::with_capacity(MAX_APNS_LEN);
    serde_json::to_writer(&mut json, value).map_err(|_| Error::Internal("push json"))?;
    Ok(json)
}

/// Parses `bytes` as `T` and accepts it only if writing `T` again gives the same bytes.
fn from_json<T: Serialize + for<'a> Deserialize<'a>>(bytes: &[u8]) -> Result<T, Error> {
    let value: T = serde_json::from_slice(bytes).map_err(|_| Error::BadFormat)?;
    if *Zeroizing::new(to_json(&value)?) != bytes {
        return Err(Error::BadFormat);
    }
    Ok(value)
}

impl WebPush {
    /// The JSON payload. `bad-format` for a change or an urgency outside its range.
    pub fn encode(&self) -> Result<Vec<u8>, Error> {
        check_numbers(self.change, self.urgency)?;
        to_json(&WebPushJson {
            room_id: self.room_id.to_base64url(),
            change: self.change,
            urgency: self.urgency,
        })
    }

    /// The payload these bytes spell; `too-large` above [`MAX_WEB_PUSH_LEN`], `bad-format` for anything but the
    /// one spelling of the three fields.
    pub fn decode(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > MAX_WEB_PUSH_LEN {
            return Err(Error::TooLarge);
        }
        let json: WebPushJson = from_json(bytes)?;
        check_numbers(json.change, json.urgency)?;
        Ok(Self {
            room_id: RoomId::from_base64url(&json.room_id)?,
            change: json.change,
            urgency: json.urgency,
        })
    }
}

impl ApnsPush {
    fn encode(&self) -> Result<Vec<u8>, Error> {
        check_numbers(self.change, self.urgency)?;
        if self.ticket.len() > MAX_TICKET_LEN {
            return Err(Error::TooLarge);
        }
        let mut fields = ApnsPushJson {
            room_id: self.room_id.to_base64url(),
            change: self.change,
            urgency: self.urgency,
            ticket: ids::base64url_encode(&self.ticket),
        };
        let json = to_json(&fields);
        fields.ticket.zeroize();
        json
    }

    fn decode(bytes: &[u8]) -> Result<Self, Error> {
        let mut fields: ApnsPushJson = from_json(bytes)?;
        let ticket = ids::base64url_decode(&fields.ticket);
        fields.ticket.zeroize();
        check_numbers(fields.change, fields.urgency)?;
        let mut ticket = ticket?;
        if ticket.len() > MAX_TICKET_LEN {
            ticket.zeroize();
            return Err(Error::BadFormat);
        }
        Ok(Self {
            room_id: RoomId::from_base64url(&fields.room_id)?,
            change: fields.change,
            urgency: fields.urgency,
            ticket,
        })
    }
}

/// The key an app makes for its APNs registration and hands to the hub: 32 fresh random bytes.
pub fn generate_key(entropy: &mut dyn Entropy) -> Result<Secret<32>, Error> {
    Secret::random(entropy)
}

/// Hub side: `nonce ‖ ciphertext` for one notification, under the key the device registered, with a fresh random
/// nonce. `bad-format` for a change or an urgency outside its range, `too-large` for a ticket above
/// [`MAX_TICKET_LEN`].
pub fn seal(
    key: &Secret<32>,
    push: &ApnsPush,
    entropy: &mut dyn Entropy,
) -> Result<Vec<u8>, Error> {
    let json = Zeroizing::new(push.encode()?);
    let nonce: [u8; NONCE_LEN] = crypto::random(entropy)?;
    let ciphertext = crypto::aead_seal(key, &nonce, APNS_AAD, &json)?;
    Ok([nonce.as_slice(), &ciphertext].concat())
}

/// Device side: what a sealed notification says. `too-large` above [`MAX_APNS_LEN`], `bad-format` when it is too
/// short to be one, `decrypt-failed` when it does not open under `key`, `bad-format` when what opens is not the
/// one spelling of the four fields.
pub fn open(key: &Secret<32>, sealed: &[u8]) -> Result<ApnsPush, Error> {
    if sealed.len() > MAX_APNS_LEN {
        return Err(Error::TooLarge);
    }
    let (nonce, ciphertext) = sealed
        .split_first_chunk::<NONCE_LEN>()
        .ok_or(Error::BadFormat)?;
    if ciphertext.len() < TAG_LEN {
        return Err(Error::BadFormat);
    }
    ApnsPush::decode(&Zeroizing::new(crypto::aead_open(
        key, nonce, APNS_AAD, ciphertext,
    )?))
}
