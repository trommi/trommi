//! Joining by link (section 12.1): Offer, Request, Reveal, the check code, the guard of the confirmed commit.
//!
//! A human device (the inviter) lets a new device into the room. The hub passes three signed messages between
//! them and could put a device of its own in the new one's place, so both sides show six emoji computed from
//! everything exchanged, and the person compares them:
//!
//! 1. The inviter makes a link with a secret and a deadline, and publishes an **Offer** that commits to a nonce
//!    it keeps, with a MAC under a key from the link's secret ([`Inviter::open`]).
//! 2. The new device, which has the link, checks the Offer's MAC, so that the Offer is the one of the link's
//!    inviter and no Offer a hub made, and answers with a **Request** that carries its KeyPackage and a MAC
//!    under another key from the link's secret ([`Joiner::request`]).
//! 3. The inviter accepts the first Request with a valid MAC and publishes the **Reveal** with the nonce
//!    ([`Inviter::accept`]). The new device checks it against the commitment ([`Joiner::reveal`]).
//! 4. Both show the [`CheckCode`]. Only when the person says they match does the inviter get a
//!    [`ConfirmedInvite`] ([`Inviter::confirm`]), without which nothing commits the new device into a group.
//!
//! The code covers the Offer, the Request with its KeyPackage, the MAC and the nonce. Whoever swaps a KeyPackage
//! changes the code; and because the inviter is bound to its nonce before it sees a Request, and the new device
//! to its Request before it sees the nonce, neither a hub nor a holder of the link can search for a matching
//! code: one guess per invite, at 36 bits.
//!
//! # The KeyPackage
//!
//! The new device is the signature key of the KeyPackage in its Request, and nothing a caller or a hub says
//! beside it. Whoever takes a Request ([`Inviter::accept`], [`hub_check_request`]) verifies that KeyPackage as
//! section 4.5 asks (its signature, its credential, the profile's capabilities), reads the key out of it and
//! checks the Request's signature under that key; whoever makes one ([`Joiner::request`]) checks that the
//! KeyPackage is its own. The [`ConfirmedInvite`] then names that very KeyPackage and that device, so that what
//! is committed is what the code covered.
//!
//! # What stays with the caller
//!
//! That only a human device invites, that the Offer's room epoch and state are the room's, and how many invites
//! are open. What follows the confirmation is the device's: the Commit, the handover, and on the new device the
//! checks of the Welcome or of the `agents` Commit against [`Joiner::offer`] (12.1.5, 12.1.6).
//!
//! # Time
//!
//! An invite for a human device lives ten minutes, one for an agent device fifteen ([`Role::invite_life_ms`]);
//! the deadline is the inviter's clock plus that, and stands in the link. An invite is used by one Request and
//! is confirmed within five minutes of that Request. The inviter enforces all three with the `now_ms` it is
//! given; "they don't match" burns the invite. The new device holds the deadline against its own clock with
//! [`CLOCK_TOLERANCE_MS`] either way ([`InviteLink::check_deadline`], [`Joiner::request`]).

use crate::codec::{self, Decode, Encode, Reader, Writer};
use crate::crypto::{self, Entropy, Secret, SecretBytes, SigningKey};
use crate::error::Error;
use crate::hub_auth::{is_canonical_origin, HubAddress};
use crate::ids::{self, DeviceId, Hash32, InviteId, RoomId, SessionId};
use crate::mls::key_package::{verify_key_package, verify_key_package_of};
use zeroize::Zeroizing;

/// How long an invite for a human device may be answered.
pub const HUMAN_INVITE_LIFE_MS: u64 = 10 * 60 * 1000;
/// How long an invite for an agent device, for a new session or a takeover, may be answered.
pub const AGENT_INVITE_LIFE_MS: u64 = 15 * 60 * 1000;
/// How far the new device's clock may stand from the inviter's, which set the deadline: the allowance the
/// format uses for freshness (section 9.0.5).
pub const CLOCK_TOLERANCE_MS: u64 = 2 * 60 * 1000;
/// How long the person has to confirm the code once a Request was accepted.
pub const CONFIRM_MS: u64 = 5 * 60 * 1000;
/// The longest KeyPackage a Request carries, in bytes.
pub const MAX_KEY_PACKAGE_LEN: usize = 8192;
/// The length of the MAC over a Request, and of the MAC over an Offer.
pub const MAC_LEN: usize = 32;
/// The length of the inviter's signature over an Offer, as the Offer's MAC covers it.
pub const OFFER_SIGNATURE_LEN: usize = 64;
/// The length of the inviter's nonce.
pub const NONCE_LEN: usize = 32;

/// The longest hub address as base64url, the length of 32 bytes (the room id, the secret) and of 8 bytes (the
/// deadline) as base64url.
const MAX_HUB_PART_LEN: usize = (512usize * 4).div_ceil(3);
const SECRET_PART_LEN: usize = 43;
const DEADLINE_PART_LEN: usize = 11;
/// The version a link names.
const LINK_VERSION: &str = "2";
/// The path of a join link under the app's origin.
const LINK_PATH: &str = "/join";
/// The longest encoded Request: its fixed fields, the longest hub address and KeyPackage, and their lengths.
const MAX_REQUEST_LEN: usize = 32 + 16 + 2 + 512 + 1 + 4 + MAX_KEY_PACKAGE_LEN + 32;
/// The length of every encoded Offer and Reveal.
const OFFER_LEN: usize = 32 + 16 + 1 + 16 + 8 + 32 + 32 + 8 + 32;
const REVEAL_LEN: usize = 16 + 32 + 32;
/// The version byte of an inviter's or a joiner's stored state.
const STORED_VERSION: u8 = 2;
/// The longest stored state: an Offer, a Request, their signatures and a link.
const MAX_STORED_LEN: usize = 4 * MAX_REQUEST_LEN;

const LABEL_INVITE_ID: &str = "trommi invite id";
const LABEL_MAC_KEY: &str = "trommi invite mac";
const LABEL_OFFER_MAC_KEY: &str = "trommi invite offer";
const LABEL_COMMITMENT: &str = "Trommi Invite Commitment";
const LABEL_OFFER_HASH: &str = "Trommi Invite Offer";
const LABEL_REQUEST_HASH: &str = "Trommi Invite Request";
const LABEL_CODE: &str = "Trommi Invite Code";
const SIGN_OFFER: &str = "TrommiInviteOffer";
const SIGN_REQUEST: &str = "TrommiInviteRequest";
const SIGN_REVEAL: &str = "TrommiInviteReveal";

/// What the new device is invited as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// A human device: it becomes a leaf of the room group.
    Human = 1,
    /// An agent device: its key is enrolled in `agents`.
    Agent = 2,
}

impl Encode for Role {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.u8(*self as u8);
        Ok(())
    }
}

impl Decode for Role {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        match reader.u8()? {
            1 => Ok(Role::Human),
            2 => Ok(Role::Agent),
            _ => Err(Error::BadFormat),
        }
    }
}

impl Role {
    /// How long an invite for this kind of device may be answered: [`HUMAN_INVITE_LIFE_MS`] or
    /// [`AGENT_INVITE_LIFE_MS`].
    pub fn invite_life_ms(self) -> u64 {
        match self {
            Role::Human => HUMAN_INVITE_LIFE_MS,
            Role::Agent => AGENT_INVITE_LIFE_MS,
        }
    }
}

/// What the inviter publishes: who invites whom into which room, until when, and the commitment to its nonce.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Offer {
    /// The room invited into.
    pub room_id: RoomId,
    /// The invite, as the link's secret gives it.
    pub invite_id: InviteId,
    /// What the new device is invited as.
    pub role: Role,
    /// Zeros; or, for an agent, the session it shall take over.
    pub session_id: SessionId,
    /// The last moment a Request is accepted, by the inviter's clock: the link's deadline.
    pub expires_at: u64,
    /// `RefHash("Trommi Invite Commitment", invite_id ‖ nonce)`.
    pub commitment: Hash32,
    /// The inviting device.
    pub inviter: DeviceId,
    /// The room epoch the inviter stood in.
    pub room_epoch: u64,
    /// `RefHash("Trommi Room State", GroupContext)` of the room group at `room_epoch`.
    pub room_state: Hash32,
}

impl Encode for Offer {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.value(&self.room_id)?;
        writer.value(&self.invite_id)?;
        writer.value(&self.role)?;
        writer.value(&self.session_id)?;
        writer.u64(self.expires_at);
        writer.value(&self.commitment)?;
        writer.value(&self.inviter)?;
        writer.u64(self.room_epoch);
        writer.value(&self.room_state)
    }
}

impl Decode for Offer {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        let offer = Self {
            room_id: reader.value()?,
            invite_id: reader.value()?,
            role: reader.value()?,
            session_id: reader.value()?,
            expires_at: reader.u64()?,
            commitment: reader.value()?,
            inviter: reader.value()?,
            room_epoch: reader.u64()?,
            room_state: reader.value()?,
        };
        // Only an agent is invited to take a session over.
        if offer.role == Role::Human && !offer.session_id.is_zero() {
            return Err(Error::BadFormat);
        }
        Ok(offer)
    }
}

impl Offer {
    /// The Offer these bytes encode; `bad-format` for anything else.
    pub fn decode(bytes: &[u8]) -> Result<Self, Error> {
        codec::decode(bytes, OFFER_LEN).map_err(|_| Error::BadFormat)
    }
}

/// What the new device answers: the room, invite, hub and role it understood, its KeyPackage, and the Offer it
/// answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    /// The room of the link.
    pub room_id: RoomId,
    /// The invite of the link.
    pub invite_id: InviteId,
    /// The hub of the link.
    pub hub: HubAddress,
    /// The Offer's role.
    pub role: Role,
    /// A fresh KeyPackage of the new device, as the TLS-encoded `MLSMessage`.
    pub key_package: Vec<u8>,
    /// `RefHash("Trommi Invite Offer", Offer)`.
    pub offer_hash: Hash32,
}

impl Encode for Request {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.value(&self.room_id)?;
        writer.value(&self.invite_id)?;
        writer.value(&self.hub)?;
        writer.value(&self.role)?;
        writer.opaque(&self.key_package)?;
        writer.value(&self.offer_hash)
    }
}

impl Decode for Request {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        let request = Self {
            room_id: reader.value()?,
            invite_id: reader.value()?,
            hub: reader.value()?,
            role: reader.value()?,
            key_package: reader.opaque()?.to_vec(),
            offer_hash: reader.value()?,
        };
        if request.key_package.is_empty() || request.key_package.len() > MAX_KEY_PACKAGE_LEN {
            return Err(Error::BadFormat);
        }
        Ok(request)
    }
}

impl Request {
    /// The Request these bytes encode; `bad-format` for anything else, a KeyPackage above
    /// [`MAX_KEY_PACKAGE_LEN`] included.
    pub fn decode(bytes: &[u8]) -> Result<Self, Error> {
        codec::decode(bytes, MAX_REQUEST_LEN).map_err(|_| Error::BadFormat)
    }
}

/// What the inviter publishes once it accepted a Request: the nonce it committed to, and which Request it took.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reveal {
    /// The invite.
    pub invite_id: InviteId,
    /// The nonce behind the Offer's commitment.
    pub nonce: [u8; NONCE_LEN],
    /// `RefHash("Trommi Invite Request", Request ‖ mac)` of the accepted Request.
    pub request_hash: Hash32,
}

impl Encode for Reveal {
    fn write(&self, writer: &mut Writer) -> Result<(), Error> {
        writer.value(&self.invite_id)?;
        writer.fixed(&self.nonce);
        writer.value(&self.request_hash)
    }
}

impl Decode for Reveal {
    fn read(reader: &mut Reader<'_>) -> Result<Self, Error> {
        Ok(Self {
            invite_id: reader.value()?,
            nonce: reader.fixed()?,
            request_hash: reader.value()?,
        })
    }
}

impl Reveal {
    /// The Reveal these bytes encode; `bad-format` for anything else.
    pub fn decode(bytes: &[u8]) -> Result<Self, Error> {
        codec::decode(bytes, REVEAL_LEN).map_err(|_| Error::BadFormat)
    }
}

/// An Offer as it travels: its encoding, `SignWithLabel(inviter, "TrommiInviteOffer", Offer)` and
/// `HMAC-SHA-256(offer_mac_key, Offer ‖ signature)` under the key from the link's secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedOffer {
    /// The encoded [`Offer`].
    pub offer: Vec<u8>,
    /// The inviter's signature: 64 bytes.
    pub signature: Vec<u8>,
    /// The MAC that binds the Offer to the link: 32 bytes. The hub stores and serves it and cannot check it.
    pub mac: Vec<u8>,
}

/// A Request as it travels: its encoding, `HMAC-SHA-256(mac_key, Request)` and
/// `SignWithLabel(new device, "TrommiInviteRequest", Request ‖ mac)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedRequest {
    /// The encoded [`Request`].
    pub request: Vec<u8>,
    /// The MAC under the key from the link's secret: 32 bytes.
    pub mac: Vec<u8>,
    /// The signature of the KeyPackage's signature key.
    pub signature: Vec<u8>,
}

/// A Reveal as it travels: its encoding and `SignWithLabel(inviter, "TrommiInviteReveal", Reveal)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedReveal {
    /// The encoded [`Reveal`].
    pub reveal: Vec<u8>,
    /// The inviter's signature.
    pub signature: Vec<u8>,
}

/// The 64 emoji a check code picks from, each with a word for a terminal that draws emoji badly. The place in
/// the list is the number in the code: the order is that of `app/web/core/check-emoji.ts` and never changes.
pub const CHECK_EMOJI: [(&str, &str); 64] = [
    ("🐶", "dog"),
    ("🐱", "cat"),
    ("🦁", "lion"),
    ("🐎", "horse"),
    ("🦄", "unicorn"),
    ("🐷", "pig"),
    ("🐘", "elephant"),
    ("🐰", "rabbit"),
    ("🐼", "panda"),
    ("🐓", "rooster"),
    ("🐧", "penguin"),
    ("🐢", "turtle"),
    ("🐟", "fish"),
    ("🐙", "octopus"),
    ("🦋", "butterfly"),
    ("🌷", "flower"),
    ("🌳", "tree"),
    ("🌵", "cactus"),
    ("🍄", "mushroom"),
    ("🌏", "globe"),
    ("🌙", "moon"),
    ("☁️", "cloud"),
    ("🔥", "fire"),
    ("🍌", "banana"),
    ("🍎", "apple"),
    ("🍓", "strawberry"),
    ("🌽", "corn"),
    ("🍕", "pizza"),
    ("🎂", "cake"),
    ("❤️", "heart"),
    ("😀", "smiley"),
    ("🤖", "robot"),
    ("🎩", "hat"),
    ("👓", "glasses"),
    ("🔧", "spanner"),
    ("🎅", "santa"),
    ("👍", "thumbs up"),
    ("☂️", "umbrella"),
    ("⌛", "hourglass"),
    ("⏰", "clock"),
    ("🎁", "gift"),
    ("💡", "light bulb"),
    ("📕", "book"),
    ("✏️", "pencil"),
    ("📎", "paperclip"),
    ("✂️", "scissors"),
    ("🔒", "lock"),
    ("🔑", "key"),
    ("🔨", "hammer"),
    ("☎️", "telephone"),
    ("🏁", "flag"),
    ("🚂", "train"),
    ("🚲", "bicycle"),
    ("✈️", "aeroplane"),
    ("🚀", "rocket"),
    ("🏆", "trophy"),
    ("⚽", "ball"),
    ("🎸", "guitar"),
    ("🎺", "trumpet"),
    ("🔔", "bell"),
    ("⚓", "anchor"),
    ("🎧", "headphones"),
    ("📁", "folder"),
    ("📌", "pin"),
];

/// The check code: six numbers 0–63, the first 36 bits of
/// `RefHash("Trommi Invite Code", Offer ‖ Request ‖ mac ‖ nonce)`, most significant first. Both devices show it
/// as six emoji and the person compares them.
#[derive(Debug, Clone, Copy)]
pub struct CheckCode([u8; 6]);

impl CheckCode {
    /// The code with these six numbers, as the person confirmed them; `bad-format` unless each is below 64.
    pub fn from_numbers(numbers: [u8; 6]) -> Result<Self, Error> {
        if numbers.iter().all(|n| usize::from(*n) < CHECK_EMOJI.len()) {
            Ok(Self(numbers))
        } else {
            Err(Error::BadFormat)
        }
    }

    /// The six numbers.
    pub fn numbers(&self) -> [u8; 6] {
        self.0
    }

    fn entries(&self) -> [(&'static str, &'static str); 6] {
        self.0
            .map(|n| CHECK_EMOJI.get(usize::from(n)).copied().unwrap_or_default())
    }

    /// The six emoji.
    pub fn emoji(&self) -> [&'static str; 6] {
        self.entries().map(|(emoji, _)| emoji)
    }

    /// The six words that stand under the emoji.
    pub fn words(&self) -> [&'static str; 6] {
        self.entries().map(|(_, word)| word)
    }
}

impl PartialEq for CheckCode {
    fn eq(&self, other: &Self) -> bool {
        crypto::ct_eq(&self.0, &other.0)
    }
}

impl Eq for CheckCode {}

/// `Offer ‖ signature`: what the Offer's MAC covers. `bad-invite` unless the signature has its 64 bytes and
/// the Offer the length of one, so that the two parts cannot be cut elsewhere.
fn offer_with_signature(offer: &SignedOffer) -> Result<Vec<u8>, Error> {
    if offer.signature.len() != OFFER_SIGNATURE_LEN || offer.offer.len() != OFFER_LEN {
        return Err(Error::BadInvite);
    }
    Ok([offer.offer.as_slice(), &offer.signature].concat())
}

fn commitment(invite_id: &InviteId, nonce: &[u8; NONCE_LEN]) -> Result<Hash32, Error> {
    let input = Zeroizing::new([invite_id.as_bytes().as_slice(), nonce].concat());
    crypto::ref_hash(LABEL_COMMITMENT, &input)
}

fn offer_hash(offer: &[u8]) -> Result<Hash32, Error> {
    crypto::ref_hash(LABEL_OFFER_HASH, offer)
}

/// `Request ‖ mac`: what the new device signs and what the request hash covers. `bad-format` unless the MAC has
/// its 32 bytes, so that the two parts cannot be cut elsewhere, and the Request is no longer than one can be,
/// so that nothing larger is copied.
fn request_with_mac(request: &SignedRequest) -> Result<Vec<u8>, Error> {
    if request.mac.len() != MAC_LEN || request.request.len() > MAX_REQUEST_LEN {
        return Err(Error::BadFormat);
    }
    Ok([request.request.as_slice(), &request.mac].concat())
}

/// `RefHash("Trommi Invite Request", Request ‖ mac)`: how a Reveal names the Request it answers. `bad-format`
/// unless the MAC has its 32 bytes.
pub fn request_hash(request: &SignedRequest) -> Result<Hash32, Error> {
    crypto::ref_hash(LABEL_REQUEST_HASH, &request_with_mac(request)?)
}

fn check_code(
    offer: &[u8],
    request: &SignedRequest,
    nonce: &[u8; NONCE_LEN],
) -> Result<CheckCode, Error> {
    let input = Zeroizing::new([offer, &request_with_mac(request)?, nonce].concat());
    let hash = crypto::ref_hash(LABEL_CODE, &input)?;
    // The first five bytes hold 40 bits; the code is the upper 36 of them, six bits a number.
    let bits = hash
        .as_bytes()
        .iter()
        .take(5)
        .fold(0u64, |bits, byte| bits << 8 | u64::from(*byte))
        >> 4;
    Ok(CheckCode(
        [30u32, 24, 18, 12, 6, 0].map(|shift| ((bits >> shift) & 63) as u8),
    ))
}

/// Decodes and verifies a signed Offer: `bad-format`, then `bad-signature` unless `inviter` signed it.
fn verified_offer(offer: &SignedOffer) -> Result<Offer, Error> {
    let decoded = Offer::decode(&offer.offer)?;
    crypto::verify_with_label(
        decoded.inviter.as_bytes(),
        SIGN_OFFER,
        &offer.offer,
        &offer.signature,
    )?;
    Ok(decoded)
}

/// The new device's check of a deadline against its own clock: `invite-expired` when its clock is more than
/// [`CLOCK_TOLERANCE_MS`] past it, `bad-invite` when it lies more than `life` and that tolerance ahead.
fn check_deadline(expires_at: u64, life: u64, now_ms: u64) -> Result<(), Error> {
    if now_ms > expires_at.saturating_add(CLOCK_TOLERANCE_MS) {
        return Err(Error::InviteExpired);
    }
    if expires_at
        > now_ms
            .saturating_add(life)
            .saturating_add(CLOCK_TOLERANCE_MS)
    {
        return Err(Error::BadInvite);
    }
    Ok(())
}

/// The link the inviter hands over: `<app>/join#v2.<hub>.<room_id>.<secret>.<expires_at>`, where `<app>` is the
/// app's origin in the canonical spelling of a hub address and the four parts are base64url (the hub as the
/// UTF-8 of its address, the deadline as a uint64 of milliseconds, big-endian). The secret reaches only who gets
/// the link; the hub never sees it. The deadline enters every key and id the secret gives: a link whose
/// deadline was changed names another invite.
#[derive(Debug, PartialEq, Eq)]
pub struct InviteLink {
    app: String,
    /// The hub the room lives on.
    pub hub: HubAddress,
    /// The room.
    pub room_id: RoomId,
    secret: Secret<32>,
    /// The last moment the inviter accepts a Request, by its clock.
    pub expires_at: u64,
}

impl InviteLink {
    /// The link with these parts; `bad-format` unless `app` is a canonical origin.
    pub fn new(
        app: &str,
        hub: HubAddress,
        room_id: RoomId,
        secret: Secret<32>,
        expires_at: u64,
    ) -> Result<Self, Error> {
        if !is_canonical_origin(app) {
            return Err(Error::BadFormat);
        }
        Ok(Self {
            app: app.to_owned(),
            hub,
            room_id,
            secret,
            expires_at,
        })
    }

    /// The link `text` is. `newer-version` for a link of a later version; `bad-format` for anything but the exact
    /// form, a hub address that is not canonical included: it is refused, never rewritten.
    pub fn parse(text: &str) -> Result<Self, Error> {
        let (address, fragment) = text.split_once('#').ok_or(Error::BadFormat)?;
        let app = address.strip_suffix(LINK_PATH).ok_or(Error::BadFormat)?;
        let mut parts = fragment.split('.');
        let version = parts
            .next()
            .and_then(|part| part.strip_prefix('v'))
            .ok_or(Error::BadFormat)?;
        let is_number = !version.is_empty()
            && !version.starts_with('0')
            && version.bytes().all(|b| b.is_ascii_digit());
        match version {
            LINK_VERSION => {}
            // Every other number without a leading zero, however long, is above 2; but for 1.
            "1" => return Err(Error::BadFormat),
            _ if is_number => return Err(Error::NewerVersion),
            _ => return Err(Error::BadFormat),
        }
        let (Some(hub), Some(room_id), Some(secret), Some(deadline), None) = (
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
        ) else {
            return Err(Error::BadFormat);
        };
        // Parts of another length than theirs are refused unread.
        if hub.len() > MAX_HUB_PART_LEN
            || room_id.len() != SECRET_PART_LEN
            || secret.len() != SECRET_PART_LEN
            || deadline.len() != DEADLINE_PART_LEN
        {
            return Err(Error::BadFormat);
        }
        let mut deadline_bytes = [0u8; 8];
        ids::base64url_decode_into(deadline, &mut deadline_bytes)?;
        // The secret goes straight into a place that is wiped: no buffer on the heap holds it on the way.
        let mut secret_bytes = Zeroizing::new([0u8; 32]);
        ids::base64url_decode_into(secret, secret_bytes.as_mut_slice())?;
        Self::new(
            app,
            HubAddress::from_bytes(&ids::base64url_decode(hub)?)?,
            RoomId::from_base64url(room_id)?,
            Secret::new(*secret_bytes),
            u64::from_be_bytes(deadline_bytes),
        )
    }

    /// The app's origin.
    pub fn app(&self) -> &str {
        &self.app
    }

    /// The link as text. It holds the secret: it is for the person to hand to the new device, never for a log.
    pub fn to_text(&self) -> SecretBytes {
        // Room for the whole link, so that no shorter copy of it is left behind while it grows.
        let capacity = self.app.len() + self.hub.as_str().len() * 2 + 128;
        let mut text = Zeroizing::new(String::with_capacity(capacity));
        text.push_str(&self.app);
        text.push_str(LINK_PATH);
        text.push_str("#v");
        text.push_str(LINK_VERSION);
        text.push('.');
        text.push_str(&ids::base64url_encode(self.hub.as_str().as_bytes()));
        text.push('.');
        text.push_str(&self.room_id.to_base64url());
        text.push('.');
        text.push_str(&Zeroizing::new(ids::base64url_encode(self.secret.expose())));
        text.push('.');
        text.push_str(&ids::base64url_encode(&self.expires_at.to_be_bytes()));
        SecretBytes::new(text.as_bytes().to_vec())
    }

    /// `room_id ‖ uint64 expires_at`: the context of every derivation from the secret.
    fn context(&self) -> [u8; 40] {
        let mut context = [0u8; 40];
        let (room, deadline) = context.split_at_mut(32);
        room.copy_from_slice(self.room_id.as_bytes());
        deadline.copy_from_slice(&self.expires_at.to_be_bytes());
        context
    }

    /// `ExpandWithLabel(secret, "trommi invite id", room_id ‖ expires_at, 16)`: what the hub knows the invite by.
    pub fn invite_id(&self) -> Result<InviteId, Error> {
        let id = crypto::expand_with_label::<16>(&self.secret, LABEL_INVITE_ID, &self.context())?;
        Ok(InviteId::new(*id.expose()))
    }

    /// `ExpandWithLabel(secret, "trommi invite mac", room_id ‖ expires_at, 32)`: the key of the Request's MAC.
    fn mac_key(&self) -> Result<Secret<32>, Error> {
        crypto::expand_with_label(&self.secret, LABEL_MAC_KEY, &self.context())
    }

    /// `HMAC-SHA-256(ExpandWithLabel(secret, "trommi invite offer", room_id ‖ expires_at, 32), Offer ‖ signature)`:
    /// the MAC that binds an Offer to this link. `bad-invite` for a signature of another length than 64 bytes.
    fn offer_mac(&self, offer: &SignedOffer) -> Result<[u8; MAC_LEN], Error> {
        let key = crypto::expand_with_label(&self.secret, LABEL_OFFER_MAC_KEY, &self.context())?;
        crypto::hmac_sha256(&key, &offer_with_signature(offer)?)
    }

    /// Whether `offer` carries this link's MAC, compared in constant time: `bad-invite` for a MAC that is
    /// missing, of another length or wrong.
    fn check_offer_mac(&self, offer: &SignedOffer) -> Result<(), Error> {
        if offer.mac.len() != MAC_LEN {
            return Err(Error::BadInvite);
        }
        let key = crypto::expand_with_label(&self.secret, LABEL_OFFER_MAC_KEY, &self.context())?;
        if crypto::hmac_verify(&key, &offer_with_signature(offer)?, &offer.mac)? {
            Ok(())
        } else {
            Err(Error::BadInvite)
        }
    }

    /// The new device's check of the link before it fetches anything (12.1.2), by its own clock `now_ms`:
    /// `invite-expired` when that is more than [`CLOCK_TOLERANCE_MS`] past the deadline, `bad-invite` when the
    /// deadline lies further ahead than the longest invite life ([`AGENT_INVITE_LIFE_MS`]: the Offer, which
    /// says the kind, is not known yet) and that tolerance. [`Joiner::request`] checks again with the Offer's
    /// kind.
    pub fn check_deadline(&self, now_ms: u64) -> Result<(), Error> {
        check_deadline(self.expires_at, AGENT_INVITE_LIFE_MS, now_ms)
    }
}

/// What an invite is for: handed to [`Inviter::open`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteTerms {
    /// The app's origin, for the link.
    pub app: String,
    /// The hub the room lives on.
    pub hub: HubAddress,
    /// The room.
    pub room_id: RoomId,
    /// What the new device is invited as.
    pub role: Role,
    /// Zeros; or, for an agent, the session it shall take over.
    pub session_id: SessionId,
    /// The room epoch the inviter stands in.
    pub room_epoch: u64,
    /// `RefHash("Trommi Room State", GroupContext)` of the room group at that epoch.
    pub room_state: Hash32,
}

/// Where an invite stands on the inviter's side.
#[derive(Debug, Clone, PartialEq, Eq)]
enum InviterState {
    /// No Request was accepted yet.
    Open,
    /// One Request was accepted and revealed to; the person has not confirmed yet.
    Accepted {
        request: SignedRequest,
        new_device: DeviceId,
        accepted_at: u64,
    },
    /// The person said the codes do not match.
    Burned,
    /// The new device was committed.
    Done,
}

/// What the inviter publishes and shows once it accepted a Request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Accepted {
    /// The Reveal to publish.
    pub reveal: SignedReveal,
    /// The code to show.
    pub code: CheckCode,
    /// The hash of the accepted Request: with the code, what the person's confirmation names.
    pub request_hash: Hash32,
    /// The new device: the signature key of the Request's KeyPackage.
    pub new_device: DeviceId,
}

/// One invite on the inviting device, from the link to the confirmation. It holds the link's secret and the
/// nonce, and enforces expiry, single use and the time to confirm. The caller stores it
/// ([`Inviter::to_stored`]) in the same write as whatever a step sends.
pub struct Inviter {
    link: InviteLink,
    nonce: Secret<NONCE_LEN>,
    offer: Offer,
    signed_offer: SignedOffer,
    state: InviterState,
}

impl std::fmt::Debug for Inviter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Inviter")
            .field("offer", &self.offer)
            .field("state", &self.state)
            .finish_non_exhaustive()
    }
}

impl Inviter {
    /// Opens an invite: a fresh link secret and nonce, and the signed Offer with its MAC, which expires the
    /// invite life of its role after `now_ms` ([`Role::invite_life_ms`]); the link carries that deadline. `key`
    /// is the inviting device's signature key. `bad-format` for terms no Offer may carry (an app origin that is
    /// not canonical, a session to take over for a human device).
    pub fn open(
        key: &SigningKey,
        terms: InviteTerms,
        now_ms: u64,
        entropy: &mut dyn Entropy,
    ) -> Result<Self, Error> {
        if terms.role == Role::Human && !terms.session_id.is_zero() {
            return Err(Error::BadFormat);
        }
        let expires_at = now_ms.saturating_add(terms.role.invite_life_ms());
        let link = InviteLink::new(
            &terms.app,
            terms.hub,
            terms.room_id,
            Secret::random(entropy)?,
            expires_at,
        )?;
        let nonce = Secret::random(entropy)?;
        let invite_id = link.invite_id()?;
        let offer = Offer {
            room_id: terms.room_id,
            invite_id,
            role: terms.role,
            session_id: terms.session_id,
            expires_at,
            commitment: commitment(&invite_id, nonce.expose())?,
            inviter: DeviceId::new(key.public()),
            room_epoch: terms.room_epoch,
            room_state: terms.room_state,
        };
        let encoded = codec::encode(&offer)?;
        let signature = crypto::sign_with_label(key, SIGN_OFFER, &encoded)?;
        let mut signed_offer = SignedOffer {
            offer: encoded,
            signature,
            mac: Vec::new(),
        };
        signed_offer.mac = link.offer_mac(&signed_offer)?.to_vec();
        Ok(Self {
            link,
            nonce,
            offer,
            signed_offer,
            state: InviterState::Open,
        })
    }

    /// The link to hand to the new device.
    pub fn link(&self) -> &InviteLink {
        &self.link
    }

    /// The Offer to publish, with its signature and MAC.
    pub fn signed_offer(&self) -> &SignedOffer {
        &self.signed_offer
    }

    /// The Offer's fields.
    pub fn offer(&self) -> &Offer {
        &self.offer
    }

    /// Accepts a Request: the first one that carries a valid MAC, matches the invite, holds a KeyPackage that
    /// verifies (section 4.5) and is signed by that KeyPackage's key. The invite is then used, and the Reveal,
    /// the code to show and the request hash are returned.
    ///
    /// `key` is the inviting device's signature key.
    ///
    /// Refusals, in this order: `invite-burned`; `invite-used` (a Request was accepted before, this very one
    /// included); `invite-expired`; `bad-format` (not a Request with a 32-byte MAC); `bad-invite` (the MAC is
    /// not the link's, or room, invite, hub, role or offer hash are not this invite's); `bad-key-package`;
    /// `bad-signature`. A refused Request leaves the invite as it was: junk cannot use it up. The MAC is
    /// checked before the KeyPackage is parsed: without the link nobody gets that far. The deadline is the
    /// inviter's own: after `expires_at` by `now_ms` no Request is taken, with no tolerance.
    pub fn accept(
        &mut self,
        key: &SigningKey,
        request: &SignedRequest,
        now_ms: u64,
    ) -> Result<Accepted, Error> {
        match self.state {
            InviterState::Open => {}
            InviterState::Burned => return Err(Error::InviteBurned),
            InviterState::Accepted { .. } | InviterState::Done => return Err(Error::InviteUsed),
        }
        if now_ms > self.offer.expires_at {
            return Err(Error::InviteExpired);
        }
        let signed = request_with_mac(request)?;
        let decoded = Request::decode(&request.request)?;
        if !crypto::hmac_verify(&self.link.mac_key()?, &request.request, &request.mac)? {
            return Err(Error::BadInvite);
        }
        if decoded.room_id != self.offer.room_id
            || decoded.invite_id != self.offer.invite_id
            || decoded.hub != self.link.hub
            || decoded.role != self.offer.role
            || decoded.offer_hash != offer_hash(&self.signed_offer.offer)?
        {
            return Err(Error::BadInvite);
        }
        let new_device = verify_key_package(&decoded.key_package)?.device;
        crypto::verify_with_label(
            new_device.as_bytes(),
            SIGN_REQUEST,
            &signed,
            &request.signature,
        )?;
        let accepted = self.reveal_to(key, request, new_device)?;
        self.state = InviterState::Accepted {
            request: request.clone(),
            new_device,
            accepted_at: now_ms,
        };
        Ok(accepted)
    }

    fn reveal_to(
        &self,
        key: &SigningKey,
        request: &SignedRequest,
        new_device: DeviceId,
    ) -> Result<Accepted, Error> {
        if key.public() != *self.offer.inviter.as_bytes() {
            return Err(Error::Internal("not the inviter's key"));
        }
        let request_hash = request_hash(request)?;
        let reveal = codec::encode(&Reveal {
            invite_id: self.offer.invite_id,
            nonce: *self.nonce.expose(),
            request_hash,
        })?;
        let signature = crypto::sign_with_label(key, SIGN_REVEAL, &reveal)?;
        Ok(Accepted {
            reveal: SignedReveal { reveal, signature },
            code: check_code(&self.signed_offer.offer, request, self.nonce.expose())?,
            request_hash,
            new_device,
        })
    }

    /// What [`Inviter::accept`] returned, again: after a restart, to publish the same Reveal and show the same
    /// code. `None` unless a Request stands accepted and unconfirmed.
    pub fn accepted(&self, key: &SigningKey) -> Result<Option<Accepted>, Error> {
        match &self.state {
            InviterState::Accepted {
                request,
                new_device,
                ..
            } => self.reveal_to(key, request, *new_device).map(Some),
            _ => Ok(None),
        }
    }

    /// The person said the two codes are the same: `code` and `request_hash` are what this device showed them
    /// for, as [`Inviter::accept`] returned them. Both are computed again from the accepted Request, and only if
    /// both are equal is there a [`ConfirmedInvite`], which the commit of the new device demands.
    ///
    /// Refusals: `invite-burned`; `invite-used` (the new device was committed already); `bad-invite` (no Request
    /// was accepted); `invite-expired` (more than five minutes since the Request was accepted);
    /// `code-not-confirmed` (another code, or another Request); `bad-key-package` (the Request's KeyPackage does
    /// not verify now, or is not the new device's).
    pub fn confirm(
        &self,
        code: &CheckCode,
        request_hash: &Hash32,
        now_ms: u64,
    ) -> Result<ConfirmedInvite, Error> {
        let (request, new_device, accepted_at) = match &self.state {
            InviterState::Accepted {
                request,
                new_device,
                accepted_at,
            } => (request, new_device, accepted_at),
            InviterState::Open => return Err(Error::BadInvite),
            InviterState::Burned => return Err(Error::InviteBurned),
            InviterState::Done => return Err(Error::InviteUsed),
        };
        if now_ms > accepted_at.saturating_add(CONFIRM_MS) {
            return Err(Error::InviteExpired);
        }
        let own_hash = self::request_hash(request)?;
        let own_code = check_code(&self.signed_offer.offer, request, self.nonce.expose())?;
        let same_request = crypto::ct_eq(own_hash.as_bytes(), request_hash.as_bytes());
        let same_code = own_code == *code;
        if !(same_request && same_code) {
            return Err(Error::CodeNotConfirmed);
        }
        // What is confirmed is a device with its own KeyPackage, also when this invite came from a store.
        let key_package = Request::decode(&request.request)?.key_package;
        verify_key_package_of(&key_package, new_device)?;
        Ok(ConfirmedInvite {
            room_id: self.offer.room_id,
            invite_id: self.offer.invite_id,
            inviter: self.offer.inviter,
            role: self.offer.role,
            session_id: self.offer.session_id,
            new_device: *new_device,
            key_package,
            request_hash: own_hash,
        })
    }

    /// Whether `confirmed` still stands: the invite is neither burned nor finished, and the Request it stands
    /// accepted for is the confirmed one. Whatever commits the new device calls this first, and stores
    /// [`Inviter::finish`] in the same write as the commit, so that a confirmation is acted on once and never
    /// after "they don't match". `invite-burned`, `invite-used`, `bad-invite` (no Request stands accepted),
    /// `code-not-confirmed` (it is the confirmation of another invite or Request).
    pub fn check_confirmed(&self, confirmed: &ConfirmedInvite) -> Result<(), Error> {
        match &self.state {
            InviterState::Accepted { request, .. } => {
                let same = confirmed.invite_id == self.offer.invite_id
                    && confirmed.inviter == self.offer.inviter
                    && confirmed.request_hash == request_hash(request)?;
                if same {
                    Ok(())
                } else {
                    Err(Error::CodeNotConfirmed)
                }
            }
            InviterState::Open => Err(Error::BadInvite),
            InviterState::Burned => Err(Error::InviteBurned),
            InviterState::Done => Err(Error::InviteUsed),
        }
    }

    /// The person said the codes do not match, or gave up: the invite is burned and accepts and confirms nothing
    /// any more. An invite whose device was committed stays as it is.
    pub fn burn(&mut self) {
        if self.state != InviterState::Done {
            self.state = InviterState::Burned;
        }
    }

    /// The new device was committed: the invite confirms nothing any more. `bad-invite` unless a Request stood
    /// accepted.
    pub fn finish(&mut self) -> Result<(), Error> {
        match self.state {
            InviterState::Accepted { .. } => {
                self.state = InviterState::Done;
                Ok(())
            }
            _ => Err(Error::BadInvite),
        }
    }

    /// The invite for the device's store. It holds the link's secret and the nonce; the Offer's MAC is computed
    /// from them again when it is read back, the link's deadline is the Offer's.
    pub fn to_stored(&self) -> Result<SecretBytes, Error> {
        // Room for all of it, so that the secret and the nonce are written once and never moved.
        let mut writer = Writer::with_capacity(MAX_STORED_LEN);
        writer.u8(STORED_VERSION);
        writer.opaque(self.link.app.as_bytes())?;
        writer.value(&self.link.hub)?;
        writer.fixed(self.link.secret.expose());
        writer.fixed(self.nonce.expose());
        writer.opaque(&self.signed_offer.offer)?;
        writer.opaque(&self.signed_offer.signature)?;
        match &self.state {
            InviterState::Open => writer.u8(1),
            InviterState::Accepted {
                request,
                new_device,
                accepted_at,
            } => {
                writer.u8(2);
                writer.opaque(&request.request)?;
                writer.opaque(&request.mac)?;
                writer.opaque(&request.signature)?;
                writer.value(new_device)?;
                writer.u64(*accepted_at);
            }
            InviterState::Burned => writer.u8(3),
            InviterState::Done => writer.u8(4),
        }
        Ok(SecretBytes::new(writer.into_bytes()))
    }

    /// The invite a store gave back. `bad-format` unless the bytes are a stored invite whose parts belong
    /// together: the Offer is signed by its inviter, names the invite of the secret and commits to the nonce,
    /// and an accepted Request is one this invite would accept, signed by the new device stored with it. That
    /// this device is the Request's KeyPackage's was verified when the Request was accepted and is verified
    /// again by [`Inviter::confirm`] and by whatever adds the device (section 4.5); it is not verified here,
    /// where a KeyPackage's lifetime against the clock would decide whether a stored invite still reads.
    pub fn from_stored(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > MAX_STORED_LEN {
            return Err(Error::BadFormat);
        }
        let mut reader = Reader::new(bytes);
        if reader.u8()? != STORED_VERSION {
            return Err(Error::BadFormat);
        }
        let app = std::str::from_utf8(reader.opaque()?).map_err(|_| Error::BadFormat)?;
        let hub: HubAddress = reader.value()?;
        let secret = Secret::new(reader.fixed()?);
        let nonce = Secret::new(reader.fixed()?);
        let mut signed_offer = SignedOffer {
            offer: reader.opaque()?.to_vec(),
            signature: reader.opaque()?.to_vec(),
            mac: Vec::new(),
        };
        let state = match reader.u8()? {
            1 => InviterState::Open,
            2 => InviterState::Accepted {
                request: SignedRequest {
                    request: reader.opaque()?.to_vec(),
                    mac: reader.opaque()?.to_vec(),
                    signature: reader.opaque()?.to_vec(),
                },
                new_device: reader.value()?,
                accepted_at: reader.u64()?,
            },
            3 => InviterState::Burned,
            4 => InviterState::Done,
            _ => return Err(Error::BadFormat),
        };
        reader.finish()?;

        let offer = verified_offer(&signed_offer).map_err(|_| Error::BadFormat)?;
        let link = InviteLink::new(app, hub, offer.room_id, secret, offer.expires_at)?;
        if offer.invite_id != link.invite_id()?
            || offer.commitment != commitment(&offer.invite_id, nonce.expose())?
        {
            return Err(Error::BadFormat);
        }
        signed_offer.mac = link
            .offer_mac(&signed_offer)
            .map_err(|_| Error::BadFormat)?
            .to_vec();
        if let InviterState::Accepted {
            request,
            new_device,
            ..
        } = &state
        {
            let decoded = Request::decode(&request.request)?;
            let signed = request_with_mac(request)?;
            let authentic = crypto::hmac_verify(&link.mac_key()?, &request.request, &request.mac)?
                && crypto::verify_with_label(
                    new_device.as_bytes(),
                    SIGN_REQUEST,
                    &signed,
                    &request.signature,
                )
                .is_ok();
            if !authentic
                || decoded.room_id != offer.room_id
                || decoded.invite_id != offer.invite_id
                || decoded.hub != link.hub
                || decoded.role != offer.role
                || decoded.offer_hash != offer_hash(&signed_offer.offer)?
            {
                return Err(Error::BadFormat);
            }
        }
        Ok(Self {
            link,
            nonce,
            offer,
            signed_offer,
            state,
        })
    }
}

/// The proof that the person confirmed the check code for one accepted Request. Only [`Inviter::confirm`] makes
/// one, and only from the code and request hash it computes itself; it cannot be built, copied or read from
/// bytes. The functions that commit a device invited by link take it, and commit exactly what it names, after
/// [`Inviter::check_confirmed`] said that the invite it came from still stands.
#[derive(Debug, PartialEq, Eq)]
pub struct ConfirmedInvite {
    room_id: RoomId,
    invite_id: InviteId,
    inviter: DeviceId,
    role: Role,
    session_id: SessionId,
    new_device: DeviceId,
    key_package: Vec<u8>,
    request_hash: Hash32,
}

impl ConfirmedInvite {
    /// The room invited into.
    pub fn room_id(&self) -> &RoomId {
        &self.room_id
    }

    /// The invite.
    pub fn invite_id(&self) -> &InviteId {
        &self.invite_id
    }

    /// The device that invited, and that alone may commit the outcome.
    pub fn inviter(&self) -> &DeviceId {
        &self.inviter
    }

    /// What the new device was invited as.
    pub fn role(&self) -> Role {
        self.role
    }

    /// Zeros; or, for an agent, the session it shall take over.
    pub fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    /// The new device: the signature key of its KeyPackage.
    pub fn new_device(&self) -> &DeviceId {
        &self.new_device
    }

    /// The KeyPackage to add: the one the confirmed code covers.
    pub fn key_package(&self) -> &[u8] {
        &self.key_package
    }

    /// The hash of the confirmed Request.
    pub fn request_hash(&self) -> &Hash32 {
        &self.request_hash
    }
}

/// One invite on the new device, from its Request to the code. It holds no secret: the link's secret is used
/// for the two MACs, of the Offer and of the Request, and dropped. It exists only for an Offer whose MAC
/// verified.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Joiner {
    offer: Offer,
    signed_offer: SignedOffer,
    request: SignedRequest,
}

impl Joiner {
    /// Checks the Offer served for `link` and answers it. `key` is the new device's signature key and
    /// `key_package` a fresh KeyPackage of that key, as the TLS-encoded `MLSMessage`; `now_ms` is this device's
    /// clock.
    ///
    /// In this order: the link's deadline against the clock ([`InviteLink::check_deadline`]); the Offer decodes
    /// (`bad-format`); it is for the link's room and invite (`bad-invite`); its MAC is the link's, compared in
    /// constant time (`bad-invite` for a MAC that is missing, of another length or wrong, or a signature of
    /// another length than 64 bytes); it is signed by the `inviter` it names (`bad-signature`); its
    /// `expires_at` is the link's (`bad-invite`), the clock is at most [`CLOCK_TOLERANCE_MS`] past it
    /// (`invite-expired`) and it lies at most the invite life of the Offer's role and that tolerance ahead
    /// (`bad-invite`). Then the KeyPackage: `bad-format` when it is empty or above [`MAX_KEY_PACKAGE_LEN`],
    /// `bad-key-package` when it does not verify by section 4.5 or is not `key`'s (the Request would be signed
    /// by another key than its KeyPackage's). A refused Offer is refused here, and nothing is sent.
    ///
    /// That `inviter` is a human device of the room is not known here: a human device learns it from the
    /// Welcome, an agent device from the room group it observes (12.1.5, 12.1.6), for which [`Joiner::offer`]
    /// keeps what the Offer said.
    pub fn request(
        link: &InviteLink,
        offer: &SignedOffer,
        key: &SigningKey,
        key_package: &[u8],
        now_ms: u64,
    ) -> Result<(Self, SignedRequest), Error> {
        link.check_deadline(now_ms)?;
        let decoded = Offer::decode(&offer.offer)?;
        if decoded.room_id != link.room_id || decoded.invite_id != link.invite_id()? {
            return Err(Error::BadInvite);
        }
        link.check_offer_mac(offer)?;
        crypto::verify_with_label(
            decoded.inviter.as_bytes(),
            SIGN_OFFER,
            &offer.offer,
            &offer.signature,
        )?;
        if decoded.expires_at != link.expires_at {
            return Err(Error::BadInvite);
        }
        check_deadline(decoded.expires_at, decoded.role.invite_life_ms(), now_ms)?;
        if key_package.is_empty() || key_package.len() > MAX_KEY_PACKAGE_LEN {
            return Err(Error::BadFormat);
        }
        verify_key_package_of(key_package, &DeviceId::new(key.public()))?;
        let request = codec::encode(&Request {
            room_id: link.room_id,
            invite_id: decoded.invite_id,
            hub: link.hub.clone(),
            role: decoded.role,
            key_package: key_package.to_vec(),
            offer_hash: offer_hash(&offer.offer)?,
        })?;
        let mac = crypto::hmac_sha256(&link.mac_key()?, &request)?.to_vec();
        let mut signed = SignedRequest {
            request,
            mac,
            signature: Vec::new(),
        };
        signed.signature = crypto::sign_with_label(key, SIGN_REQUEST, &request_with_mac(&signed)?)?;
        let joiner = Self {
            offer: decoded,
            signed_offer: offer.clone(),
            request: signed.clone(),
        };
        Ok((joiner, signed))
    }

    /// Checks the Reveal and returns the code to show. `bad-format` (not a Reveal); `bad-signature` (not signed
    /// by the Offer's inviter); `bad-invite` (another invite; the inviter answered another Request: someone else
    /// used the link; or the nonce is not the one the Offer committed to).
    pub fn reveal(&self, reveal: &SignedReveal) -> Result<CheckCode, Error> {
        let decoded = Reveal::decode(&reveal.reveal)?;
        crypto::verify_with_label(
            self.offer.inviter.as_bytes(),
            SIGN_REVEAL,
            &reveal.reveal,
            &reveal.signature,
        )?;
        if decoded.invite_id != self.offer.invite_id
            || decoded.request_hash != request_hash(&self.request)?
            || decoded.commitment_of()? != self.offer.commitment
        {
            return Err(Error::BadInvite);
        }
        check_code(&self.signed_offer.offer, &self.request, &decoded.nonce)
    }

    /// What the Offer said: the inviter that must have committed this device, the role, the session, and the
    /// room epoch and state an agent device starts observing at.
    pub fn offer(&self) -> &Offer {
        &self.offer
    }

    /// The Request that was sent, to send again.
    pub fn signed_request(&self) -> &SignedRequest {
        &self.request
    }

    /// The invite for the device's store, with the Offer's MAC as it verified.
    pub fn to_stored(&self) -> Result<Vec<u8>, Error> {
        let mut writer = Writer::new();
        writer.u8(STORED_VERSION);
        writer.opaque(&self.signed_offer.offer)?;
        writer.opaque(&self.signed_offer.signature)?;
        writer.opaque(&self.signed_offer.mac)?;
        writer.opaque(&self.request.request)?;
        writer.opaque(&self.request.mac)?;
        writer.opaque(&self.request.signature)?;
        Ok(writer.into_bytes())
    }

    /// The invite a store gave back. `bad-format` unless the bytes are a stored invite whose parts belong
    /// together: the Offer is signed by its inviter, carries a MAC of 32 bytes, and the Request answers that
    /// Offer. The MAC is not verified again (the secret is gone): it was verified before the state was first
    /// written, and the store is the device's own.
    pub fn from_stored(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > MAX_STORED_LEN {
            return Err(Error::BadFormat);
        }
        let mut reader = Reader::new(bytes);
        if reader.u8()? != STORED_VERSION {
            return Err(Error::BadFormat);
        }
        let signed_offer = SignedOffer {
            offer: reader.opaque()?.to_vec(),
            signature: reader.opaque()?.to_vec(),
            mac: reader.opaque()?.to_vec(),
        };
        if signed_offer.mac.len() != MAC_LEN {
            return Err(Error::BadFormat);
        }
        let request = SignedRequest {
            request: reader.opaque()?.to_vec(),
            mac: reader.opaque()?.to_vec(),
            signature: reader.opaque()?.to_vec(),
        };
        reader.finish()?;
        let offer = verified_offer(&signed_offer).map_err(|_| Error::BadFormat)?;
        let decoded = Request::decode(&request.request)?;
        request_with_mac(&request)?;
        if decoded.room_id != offer.room_id
            || decoded.invite_id != offer.invite_id
            || decoded.role != offer.role
            || decoded.offer_hash != offer_hash(&signed_offer.offer)?
        {
            return Err(Error::BadFormat);
        }
        Ok(Self {
            offer,
            signed_offer,
            request,
        })
    }
}

impl Reveal {
    /// The commitment this Reveal's nonce opens.
    fn commitment_of(&self) -> Result<Hash32, Error> {
        commitment(&self.invite_id, &self.nonce)
    }
}

/// Hub side, `POST /v2/invites`: the Offer a device posts. `bad-format` unless it is an Offer with a MAC of 32
/// bytes, then `bad-signature` unless the `inviter` it names signed it. The MAC is stored and served with the
/// Offer; the hub cannot check more than its length, its key follows from the link's secret.
///
/// Left to the hub's own state: the posting device is that `inviter` and a human device now; `room_id`,
/// `room_epoch` and `room_state` are the room's current ones; the invite id is new; the limit of open invites.
pub fn hub_check_offer(offer: &SignedOffer) -> Result<Offer, Error> {
    Offer::decode(&offer.offer)?;
    if offer.mac.len() != MAC_LEN {
        return Err(Error::BadFormat);
    }
    verified_offer(offer)
}

/// Hub side, `POST /v2/invites/{invite_id}/request`: a Request for the stored `offer`. Returns the device that
/// asks: the signature key of the Request's KeyPackage, which is verified here (section 4.5). `bad-format` (not
/// a Request with a 32-byte MAC); `bad-invite` (room, invite, role or offer hash are not the stored Offer's, or
/// the hub named is not this hub); `bad-key-package`; `bad-signature` (not signed by the KeyPackage's key).
///
/// The hub cannot check the MAC: its key follows from the link's secret, which the hub never sees. It therefore
/// cannot tell a Request made with the link from one made without; only the inviter can, and the hub keeps every
/// Request that passes this check, up to its limit per invite.
pub fn hub_check_request(
    offer: &SignedOffer,
    request: &SignedRequest,
    own_address: &HubAddress,
) -> Result<DeviceId, Error> {
    let signed = request_with_mac(request)?;
    let decoded = Request::decode(&request.request)?;
    let stored = Offer::decode(&offer.offer)?;
    if decoded.room_id != stored.room_id
        || decoded.invite_id != stored.invite_id
        || decoded.role != stored.role
        || decoded.offer_hash != offer_hash(&offer.offer)?
        || decoded.hub != *own_address
    {
        return Err(Error::BadInvite);
    }
    let new_device = verify_key_package(&decoded.key_package)?.device;
    crypto::verify_with_label(
        new_device.as_bytes(),
        SIGN_REQUEST,
        &signed,
        &request.signature,
    )?;
    Ok(new_device)
}

/// What an invite came to, as the hub knows it once the inviter revealed: the one device that may now be added
/// (12.1.7). Only [`hub_check_reveal`] makes one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Revealed {
    room_id: RoomId,
    invite_id: InviteId,
    inviter: DeviceId,
    role: Role,
    session_id: SessionId,
    new_device: DeviceId,
    key_package: Vec<u8>,
    request_hash: Hash32,
}

/// Hub side, `PUT /v2/invites/{id}/reveal`: the Reveal for the stored `offer`, against the Requests the hub
/// holds for that invite. `bad-format` (not a Reveal); `bad-signature` (not signed by the Offer's inviter);
/// `bad-invite` (another invite, a nonce the Offer did not commit to, or a Request the hub does not hold or that
/// does not answer this Offer); `bad-key-package`. The Requests are those that passed [`hub_check_request`] for
/// this Offer: their signatures are not verified again here; the new device is read from the KeyPackage of the
/// revealed one again.
pub fn hub_check_reveal(
    offer: &SignedOffer,
    reveal: &SignedReveal,
    requests: &[SignedRequest],
) -> Result<Revealed, Error> {
    let stored = Offer::decode(&offer.offer)?;
    let decoded = Reveal::decode(&reveal.reveal)?;
    crypto::verify_with_label(
        stored.inviter.as_bytes(),
        SIGN_REVEAL,
        &reveal.reveal,
        &reveal.signature,
    )?;
    if decoded.invite_id != stored.invite_id || decoded.commitment_of()? != stored.commitment {
        return Err(Error::BadInvite);
    }
    for request in requests {
        if request_hash(request)? == decoded.request_hash {
            let answered = Request::decode(&request.request)?;
            if answered.room_id != stored.room_id
                || answered.invite_id != stored.invite_id
                || answered.role != stored.role
                || answered.offer_hash != offer_hash(&offer.offer)?
            {
                return Err(Error::BadInvite);
            }
            return Ok(Revealed {
                room_id: stored.room_id,
                invite_id: stored.invite_id,
                inviter: stored.inviter,
                role: stored.role,
                session_id: stored.session_id,
                new_device: verify_key_package(&answered.key_package)?.device,
                key_package: answered.key_package,
                request_hash: decoded.request_hash,
            });
        }
    }
    Err(Error::BadInvite)
}

impl Revealed {
    /// The room.
    pub fn room_id(&self) -> &RoomId {
        &self.room_id
    }

    /// The invite.
    pub fn invite_id(&self) -> &InviteId {
        &self.invite_id
    }

    /// The inviter: the only device whose Commit may carry the outcome.
    pub fn inviter(&self) -> &DeviceId {
        &self.inviter
    }

    /// The invited role.
    pub fn role(&self) -> Role {
        self.role
    }

    /// Zeros; or, for an agent, the session it shall take over.
    pub fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    /// The new device: the signature key of the KeyPackage of the Request the inviter revealed to.
    pub fn new_device(&self) -> &DeviceId {
        &self.new_device
    }

    /// That KeyPackage.
    pub fn key_package(&self) -> &[u8] {
        &self.key_package
    }

    /// The hash of that Request.
    pub fn request_hash(&self) -> &Hash32 {
        &self.request_hash
    }

    /// Hub side, 12.1.7: whether a Commit by `committer` may add `key_package` as the outcome of this invite:
    /// `bad-invite` unless it is the inviter's Commit, the invited role and the very KeyPackage of the revealed
    /// Request. `role` is what the Commit makes of the device: an Add in the room group needs an invite for a
    /// human device, the founding or takeover of a session with that KeyPackage one for an agent device.
    pub fn check_outcome(
        &self,
        committer: &DeviceId,
        role: Role,
        key_package: &[u8],
    ) -> Result<(), Error> {
        if *committer == self.inviter && role == self.role && key_package == self.key_package {
            Ok(())
        } else {
            Err(Error::BadInvite)
        }
    }

    /// Hub side, 12.1.7: whether a Commit by `committer` may add `key` to `agents` as the outcome of this
    /// invite: `bad-invite` unless it is the inviter's Commit, the invite is for an agent device and `key` is
    /// the new device.
    pub fn check_enrolment(&self, committer: &DeviceId, key: &DeviceId) -> Result<(), Error> {
        if *committer == self.inviter && self.role == Role::Agent && *key == self.new_device {
            Ok(())
        } else {
            Err(Error::BadInvite)
        }
    }
}
