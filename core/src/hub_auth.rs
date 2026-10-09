//! Signing in to the hub (section 12.3): the signed challenge.
//!
//! The hub hands out 32 random bytes; a device signs them together with the room, the hub's address and its own
//! key, and gets a token. The signer is a device's signature key or, for a join with the code, the room's recovery
//! signature key (section 8.4): both are Ed25519 keys and sign alike.
//!
//! What stays with the hub: a challenge is used once, and the device's standing (12.3.2: a leaf, a key in
//! `agents`, or the room's recovery signature key; anyone else is `not-member`) is looked up for the device
//! [`verify`] returns.
//!
//! [`HubAddress`] is the canonical address of v1 section 8.1, which the sign-in, the invite link and the invite
//! Request all carry: an address in any other spelling is refused and never rewritten.

use crate::codec::{self, Decode, Encode, Reader, Writer};
use crate::crypto::{self, Entropy, SigningKey};
use crate::error::Error;
use crate::ids::{DeviceId, RoomId};

/// The label of the signature.
const LABEL: &str = "TrommiHubAuth";
/// The length of a challenge.
pub const CHALLENGE_LEN: usize = 32;
/// How long a challenge may be answered.
pub const CHALLENGE_LIFE_MS: u64 = 2 * 60 * 1000;
/// How long the token lasts that a sign-in gives.
pub const TOKEN_LIFE_MS: u64 = 10 * 60 * 1000;
/// The longest address, in bytes.
pub const MAX_ADDRESS_LEN: usize = 512;
/// The longest encoded [`HubAuth`]: the three fixed fields, and the address behind its two-byte length.
const MAX_AUTH_LEN: usize = 32 + 2 + MAX_ADDRESS_LEN + 32 + 32;

fn is_alphanumeric(byte: u8) -> bool {
    byte.is_ascii_lowercase() || byte.is_ascii_digit()
}

/// One label of a host name: lowercase letters, digits and hyphens, neither first nor last a hyphen.
fn is_label(label: &[u8]) -> bool {
    let inner_ok = label.iter().all(|b| is_alphanumeric(*b) || *b == b'-');
    let edges_ok = label.first().is_some_and(|b| is_alphanumeric(*b))
        && label.last().is_some_and(|b| is_alphanumeric(*b));
    inner_ok && edges_ok
}

/// A port as the address writes it: one to five digits, the first not zero.
fn is_port(port: &[u8]) -> bool {
    (1..=5).contains(&port.len())
        && port.first().is_some_and(|b| *b != b'0')
        && port.iter().all(u8::is_ascii_digit)
}

/// Whether `text` is an origin in the one canonical spelling: `https://` and a lowercase host, or `http://` and
/// `localhost` or `127.0.0.1`, then an optional `:port`; no path, no trailing slash, at most
/// [`MAX_ADDRESS_LEN`] bytes. Exactly the pattern of v1 section 8.1.
pub(crate) fn is_canonical_origin(text: &str) -> bool {
    if text.len() > MAX_ADDRESS_LEN {
        return false;
    }
    let (secure, rest) = match (text.strip_prefix("https://"), text.strip_prefix("http://")) {
        (Some(rest), _) => (true, rest),
        (None, Some(rest)) => (false, rest),
        (None, None) => return false,
    };
    let (host, port) = match rest.split_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (rest, None),
    };
    let host_ok = if secure {
        host.split('.').all(|label| is_label(label.as_bytes()))
    } else {
        host == "localhost" || host == "127.0.0.1"
    };
    host_ok && port.is_none_or(|port| is_port(port.as_bytes()))
}

/// A hub's canonical address. It can only be made from text that already is canonical.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HubAddress(String);

impl HubAddress {
    /// The address `text` spells; `bad-format` unless it is canonical.
    pub fn parse(text: &str) -> Result<Self, Error> {
        if is_canonical_origin(text) {
            Ok(Self(text.to_owned()))
        } else {
            Err(Error::BadFormat)
        }
    }

    /// The address these bytes spell; `bad-format` unless they are a canonical address.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        Self::parse(std::str::from_utf8(bytes).map_err(|_| Error::BadFormat)?)
    }

    /// The address.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Encode for HubAddress {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.opaque(self.0.as_bytes())
    }
}

impl Decode for HubAddress {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        Self::from_bytes(reader.opaque()?)
    }
}

/// `struct { opaque room_id[32]; opaque hub<V>; opaque device[32]; opaque challenge[32]; } HubAuth`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HubAuth {
    /// The room signed in to.
    pub room_id: RoomId,
    /// The hub signed in to.
    pub hub: HubAddress,
    /// The signer: a device's signature key, or the room's recovery signature key.
    pub device: DeviceId,
    /// The hub's challenge.
    pub challenge: [u8; CHALLENGE_LEN],
}

impl Encode for HubAuth {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.value(&self.room_id)?;
        writer.value(&self.hub)?;
        writer.value(&self.device)?;
        writer.fixed(&self.challenge);
        Ok(())
    }
}

impl Decode for HubAuth {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        Ok(Self {
            room_id: reader.value()?,
            hub: reader.value()?,
            device: reader.value()?,
            challenge: reader.fixed()?,
        })
    }
}

impl HubAuth {
    /// The sign-in these bytes encode, unverified: a hub reads `challenge` from it to find the challenge it
    /// issued, then calls [`verify`]. `bad-format` for anything else, `too-large` above the longest encoding.
    pub fn decode(bytes: &[u8]) -> Result<Self, Error> {
        codec::decode(bytes, MAX_AUTH_LEN)
    }
}

/// What a device posts: the encoded [`HubAuth`] and the signature over it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedHubAuth {
    /// The encoded `HubAuth`.
    pub auth: Vec<u8>,
    /// `SignWithLabel(key, "TrommiHubAuth", auth)`.
    pub signature: Vec<u8>,
}

/// A challenge as the hub keeps it until it is answered or runs out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssuedChallenge {
    /// The 32 random bytes handed out.
    pub challenge: [u8; CHALLENGE_LEN],
    /// The last moment it may be answered.
    pub expires_at: u64,
}

impl IssuedChallenge {
    /// A fresh challenge, good for two minutes from `now_ms`.
    pub fn issue(entropy: &mut dyn Entropy, now_ms: u64) -> Result<Self, Error> {
        Ok(Self {
            challenge: crypto::random(entropy)?,
            expires_at: now_ms.saturating_add(CHALLENGE_LIFE_MS),
        })
    }
}

/// Device side: answers `challenge` for `room_id` at `hub`. `key` is the device's signature key, or the recovery
/// signature key of a device that joins with the code; its public half is the `device` of the sign-in.
pub fn sign(
    key: &SigningKey,
    room_id: RoomId,
    hub: &HubAddress,
    challenge: [u8; CHALLENGE_LEN],
) -> Result<SignedHubAuth, Error> {
    let auth = codec::encode(&HubAuth {
        room_id,
        hub: hub.clone(),
        device: DeviceId::new(key.public()),
        challenge,
    })?;
    let signature = crypto::sign_with_label(key, LABEL, &auth)?;
    Ok(SignedHubAuth { auth, signature })
}

/// Hub side: checks a posted sign-in against the room it was posted for, the hub's own address and the challenge
/// it issued, and returns the key that signed it. In this order: `bad-format` (not a `HubAuth`), `wrong-room`,
/// `unauthorised` (the sign-in names another hub), `bad-challenge` (another challenge, or one that ran out),
/// `bad-signature`.
///
/// The caller then marks the challenge used, and issues a token only if the returned key has standing in the
/// room (12.3.2); for the recovery signature key, a token that reaches only what a join with the code needs.
pub fn verify(
    signed: &SignedHubAuth,
    room_id: &RoomId,
    own_address: &HubAddress,
    issued: &IssuedChallenge,
    now_ms: u64,
) -> Result<DeviceId, Error> {
    let auth = HubAuth::decode(&signed.auth).map_err(|_| Error::BadFormat)?;
    if auth.room_id != *room_id {
        return Err(Error::WrongRoom);
    }
    if auth.hub != *own_address {
        return Err(Error::Unauthorised);
    }
    if !crypto::ct_eq(&auth.challenge, &issued.challenge) || now_ms > issued.expires_at {
        return Err(Error::BadChallenge);
    }
    crypto::verify_with_label(
        auth.device.as_bytes(),
        LABEL,
        &signed.auth,
        &signed.signature,
    )?;
    Ok(auth.device)
}
