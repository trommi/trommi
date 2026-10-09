//! Joining by link (section 12.1): Offer, Request, Reveal, the check code, the guard of the confirmed commit.
//!
//! A human device (the inviter) lets a new device into the room. The hub passes three signed messages between
//! them and could put a device of its own in the new one's place, so both sides show six emoji computed from
//! everything exchanged, and the person compares them:
//!
//! 1. The inviter makes a link with a secret, and publishes an **Offer** that commits to a nonce it keeps
//!    ([`Inviter::open`]).
//! 2. The new device, which has the link, checks the Offer and answers with a **Request** that carries its
//!    KeyPackage and a MAC under a key from the link's secret ([`Joiner::request`]).
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
//! # What this module takes on trust from its caller
//!
//! A KeyPackage is opaque bytes here. The Request must be signed by the KeyPackage's signature key, which is the
//! new device's id: the caller, who can read a KeyPackage, verifies it as section 4.5 asks (its signature, its
//! credential, its capabilities), takes the signature key out of it and passes it to [`Inviter::accept`] and
//! [`hub_check_request`]. That only a human device invites, and how many invites are open, is the caller's too.
//!
//! # Time
//!
//! An invite lives ten minutes, is used by one Request, and is confirmed within five minutes of that Request.
//! The inviter enforces all three with the `now_ms` it is given; "they don't match" burns the invite.

use crate::codec::{self, Decode, Encode, Reader, Writer};
use crate::crypto::{self, Entropy, Secret, SecretBytes, SigningKey};
use crate::error::Error;
use crate::hub_auth::{is_canonical_origin, HubAddress};
use crate::ids::{self, DeviceId, Hash32, InviteId, RoomId, SessionId};
use zeroize::Zeroizing;

/// How long an invite may be answered.
pub const INVITE_LIFE_MS: u64 = 10 * 60 * 1000;
/// How long the person has to confirm the code once a Request was accepted.
pub const CONFIRM_MS: u64 = 5 * 60 * 1000;
/// The longest KeyPackage a Request carries, in bytes.
pub const MAX_KEY_PACKAGE_LEN: usize = 8192;
/// The length of the MAC over a Request.
pub const MAC_LEN: usize = 32;
/// The length of the inviter's nonce.
pub const NONCE_LEN: usize = 32;

/// The longest hub address as base64url, and the length of 32 bytes (the room id, the secret) as base64url.
const MAX_HUB_PART_LEN: usize = (512usize * 4).div_ceil(3);
const SECRET_PART_LEN: usize = 43;
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
const STORED_VERSION: u8 = 1;
/// The longest stored state: an Offer, a Request, their signatures and a link.
const MAX_STORED_LEN: usize = 4 * MAX_REQUEST_LEN;

const LABEL_INVITE_ID: &str = "trommi invite id";
const LABEL_MAC_KEY: &str = "trommi invite mac";
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
    /// The last moment a Request is accepted.
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

/// An Offer as it travels: its encoding and `SignWithLabel(inviter, "TrommiInviteOffer", Offer)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedOffer {
    /// The encoded [`Offer`].
    pub offer: Vec<u8>,
    /// The inviter's signature.
    pub signature: Vec<u8>,
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

fn invite_id(secret: &Secret<32>, room_id: &RoomId) -> Result<InviteId, Error> {
    let id = crypto::expand_with_label::<16>(secret, LABEL_INVITE_ID, room_id.as_bytes())?;
    Ok(InviteId::new(*id.expose()))
}

fn mac_key(secret: &Secret<32>, room_id: &RoomId) -> Result<Secret<32>, Error> {
    crypto::expand_with_label(secret, LABEL_MAC_KEY, room_id.as_bytes())
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

/// The link the inviter hands over: `<app>/join#v2.<hub>.<room_id>.<secret>`, where `<app>` is the app's origin
/// in the canonical spelling of a hub address and the three parts are base64url (the hub as the UTF-8 of its
/// address). The secret reaches only who gets the link; the hub never sees it.
#[derive(Debug, PartialEq, Eq)]
pub struct InviteLink {
    app: String,
    /// The hub the room lives on.
    pub hub: HubAddress,
    /// The room.
    pub room_id: RoomId,
    secret: Secret<32>,
}

impl InviteLink {
    /// The link with these parts; `bad-format` unless `app` is a canonical origin.
    pub fn new(
        app: &str,
        hub: HubAddress,
        room_id: RoomId,
        secret: Secret<32>,
    ) -> Result<Self, Error> {
        if !is_canonical_origin(app) {
            return Err(Error::BadFormat);
        }
        Ok(Self {
            app: app.to_owned(),
            hub,
            room_id,
            secret,
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
        let (Some(hub), Some(room_id), Some(secret), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(Error::BadFormat);
        };
        // Parts of another length than theirs are refused unread.
        if hub.len() > MAX_HUB_PART_LEN
            || room_id.len() != SECRET_PART_LEN
            || secret.len() != SECRET_PART_LEN
        {
            return Err(Error::BadFormat);
        }
        Self::new(
            app,
            HubAddress::from_bytes(&ids::base64url_decode(hub)?)?,
            RoomId::from_base64url(room_id)?,
            Secret::from_slice(&Zeroizing::new(ids::base64url_decode(secret)?))?,
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
        SecretBytes::new(text.as_bytes().to_vec())
    }

    /// `ExpandWithLabel(secret, "trommi invite id", room_id, 16)`: what the hub knows the invite by.
    pub fn invite_id(&self) -> Result<InviteId, Error> {
        invite_id(&self.secret, &self.room_id)
    }

    fn mac_key(&self) -> Result<Secret<32>, Error> {
        mac_key(&self.secret, &self.room_id)
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
    /// Opens an invite: a fresh link secret and nonce, and the signed Offer, which expires ten minutes after
    /// `now_ms`. `key` is the inviting device's signature key. `bad-format` for terms no Offer may carry (an app
    /// origin that is not canonical, a session to take over for a human device).
    pub fn open(
        key: &SigningKey,
        terms: InviteTerms,
        now_ms: u64,
        entropy: &mut dyn Entropy,
    ) -> Result<Self, Error> {
        if terms.role == Role::Human && !terms.session_id.is_zero() {
            return Err(Error::BadFormat);
        }
        let link = InviteLink::new(
            &terms.app,
            terms.hub,
            terms.room_id,
            Secret::random(entropy)?,
        )?;
        let nonce = Secret::random(entropy)?;
        let invite_id = link.invite_id()?;
        let offer = Offer {
            room_id: terms.room_id,
            invite_id,
            role: terms.role,
            session_id: terms.session_id,
            expires_at: now_ms.saturating_add(INVITE_LIFE_MS),
            commitment: commitment(&invite_id, nonce.expose())?,
            inviter: DeviceId::new(key.public()),
            room_epoch: terms.room_epoch,
            room_state: terms.room_state,
        };
        let encoded = codec::encode(&offer)?;
        let signature = crypto::sign_with_label(key, SIGN_OFFER, &encoded)?;
        Ok(Self {
            link,
            nonce,
            offer,
            signed_offer: SignedOffer {
                offer: encoded,
                signature,
            },
            state: InviterState::Open,
        })
    }

    /// The link to hand to the new device.
    pub fn link(&self) -> &InviteLink {
        &self.link
    }

    /// The Offer to publish.
    pub fn signed_offer(&self) -> &SignedOffer {
        &self.signed_offer
    }

    /// The Offer's fields.
    pub fn offer(&self) -> &Offer {
        &self.offer
    }

    /// Accepts a Request: the first one that carries a valid MAC, matches the invite and is signed by its
    /// KeyPackage's key. The invite is then used, and the Reveal, the code to show and the request hash are
    /// returned.
    ///
    /// `key` is the inviting device's signature key. `key_package_key` is the signature key of
    /// `request`'s KeyPackage, which the caller has verified and read out of it (section 4.5).
    ///
    /// Refusals, in this order: `invite-burned`; `invite-used` (a Request was accepted before, this very one
    /// included); `invite-expired`; `bad-format` (not a Request with a 32-byte MAC); `bad-invite` (the MAC is
    /// not the link's, or room, invite, hub, role or offer hash are not this invite's); `bad-signature`. A
    /// refused Request leaves the invite as it was: junk cannot use it up.
    pub fn accept(
        &mut self,
        key: &SigningKey,
        request: &SignedRequest,
        key_package_key: &DeviceId,
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
        crypto::verify_with_label(
            key_package_key.as_bytes(),
            SIGN_REQUEST,
            &signed,
            &request.signature,
        )?;
        let accepted = self.reveal_to(key, request, *key_package_key)?;
        self.state = InviterState::Accepted {
            request: request.clone(),
            new_device: *key_package_key,
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
    /// `code-not-confirmed` (another code, or another Request).
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
        Ok(ConfirmedInvite {
            room_id: self.offer.room_id,
            invite_id: self.offer.invite_id,
            inviter: self.offer.inviter,
            role: self.offer.role,
            session_id: self.offer.session_id,
            new_device: *new_device,
            key_package: Request::decode(&request.request)?.key_package,
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

    /// The invite for the device's store. It holds the link's secret and the nonce.
    pub fn to_stored(&self) -> Result<SecretBytes, Error> {
        let mut writer = Writer::new();
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
    /// and an accepted Request is one this invite would accept.
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
        let signed_offer = SignedOffer {
            offer: reader.opaque()?.to_vec(),
            signature: reader.opaque()?.to_vec(),
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
        let link = InviteLink::new(app, hub, offer.room_id, secret)?;
        if offer.invite_id != link.invite_id()?
            || offer.commitment != commitment(&offer.invite_id, nonce.expose())?
        {
            return Err(Error::BadFormat);
        }
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
/// once, for the MAC, and dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Joiner {
    offer: Offer,
    signed_offer: SignedOffer,
    request: SignedRequest,
}

impl Joiner {
    /// Checks the Offer served for `link` and answers it. `key` is the new device's signature key and
    /// `key_package` a fresh KeyPackage of that key, as the TLS-encoded `MLSMessage`.
    ///
    /// Refusals: `bad-format` (not an Offer; a KeyPackage that is empty or above [`MAX_KEY_PACKAGE_LEN`]);
    /// `bad-invite` (the Offer is for another room or another invite than the link's); `bad-signature` (not
    /// signed by the `inviter` it names); `invite-expired`.
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
        let decoded = Offer::decode(&offer.offer)?;
        if decoded.room_id != link.room_id || decoded.invite_id != link.invite_id()? {
            return Err(Error::BadInvite);
        }
        crypto::verify_with_label(
            decoded.inviter.as_bytes(),
            SIGN_OFFER,
            &offer.offer,
            &offer.signature,
        )?;
        if now_ms > decoded.expires_at {
            return Err(Error::InviteExpired);
        }
        if key_package.is_empty() || key_package.len() > MAX_KEY_PACKAGE_LEN {
            return Err(Error::BadFormat);
        }
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

    /// The invite for the device's store.
    pub fn to_stored(&self) -> Result<Vec<u8>, Error> {
        let mut writer = Writer::new();
        writer.u8(STORED_VERSION);
        writer.opaque(&self.signed_offer.offer)?;
        writer.opaque(&self.signed_offer.signature)?;
        writer.opaque(&self.request.request)?;
        writer.opaque(&self.request.mac)?;
        writer.opaque(&self.request.signature)?;
        Ok(writer.into_bytes())
    }

    /// The invite a store gave back. `bad-format` unless the bytes are a stored invite whose parts belong
    /// together: the Offer is signed by its inviter and the Request answers that Offer.
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
        };
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

/// Hub side, `POST /v2/invites`: the Offer a device posts. `bad-format`, then `bad-signature` unless the
/// `inviter` it names signed it.
///
/// Left to the hub's own state: the posting device is that `inviter` and a human device now; `room_id`,
/// `room_epoch` and `room_state` are the room's current ones; the invite id is new; the limit of open invites.
pub fn hub_check_offer(offer: &SignedOffer) -> Result<Offer, Error> {
    verified_offer(offer)
}

/// Hub side, `POST /v2/invites/{invite_id}/request`: a Request for the stored `offer`. `key_package_key` is the
/// signature key of the Request's KeyPackage, which the hub has verified and read out of it (section 4.5).
/// `bad-format` (not a Request with a 32-byte MAC); `bad-invite` (room, invite, role or offer hash are not the
/// stored Offer's, or the hub named is not this hub); `bad-signature`.
///
/// The hub cannot check the MAC: its key follows from the link's secret, which the hub never sees. It therefore
/// cannot tell a Request made with the link from one made without; only the inviter can, and the hub keeps every
/// Request that passes this check, up to its limit per invite.
pub fn hub_check_request(
    offer: &SignedOffer,
    request: &SignedRequest,
    own_address: &HubAddress,
    key_package_key: &DeviceId,
) -> Result<Request, Error> {
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
    crypto::verify_with_label(
        key_package_key.as_bytes(),
        SIGN_REQUEST,
        &signed,
        &request.signature,
    )?;
    Ok(decoded)
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
    key_package: Vec<u8>,
    request_hash: Hash32,
}

/// Hub side, `PUT /v2/invites/{id}/reveal`: the Reveal for the stored `offer`, against the Requests the hub
/// holds for that invite. `bad-format` (not a Reveal); `bad-signature` (not signed by the Offer's inviter);
/// `bad-invite` (another invite, a nonce the Offer did not commit to, or a Request the hub does not hold or that
/// does not answer this Offer). The Requests are those that passed [`hub_check_request`] for this Offer: their
/// signatures are not verified again here.
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

    /// The KeyPackage of the Request the inviter revealed to.
    pub fn key_package(&self) -> &[u8] {
        &self.key_package
    }

    /// The hash of that Request.
    pub fn request_hash(&self) -> &Hash32 {
        &self.request_hash
    }

    /// Hub side, 12.1.7: whether a Commit by `committer` may add the device of `key_package` in `role` as the
    /// outcome of this invite: `bad-invite` unless it is the inviter's Commit, the invited role and the very
    /// KeyPackage of the revealed Request. For an agent device the hub compares the key added to `agents` with
    /// that KeyPackage's signature key, and passes the KeyPackage the session is founded or taken over with.
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::SystemEntropy;

    const ROOM: RoomId = RoomId::new([7; 32]);
    const NOW: u64 = 1_700_000_000_000;
    const APP: &str = "https://app.example.org";

    fn key(seed: u8) -> SigningKey {
        SigningKey::from_seed(Secret::new([seed; 32]))
    }

    fn device(seed: u8) -> DeviceId {
        DeviceId::new(key(seed).public())
    }

    fn hub() -> HubAddress {
        HubAddress::parse("https://hub.example.org").expect("canonical")
    }

    fn terms(role: Role, session_id: SessionId) -> InviteTerms {
        InviteTerms {
            app: APP.into(),
            hub: hub(),
            room_id: ROOM,
            role,
            session_id,
            room_epoch: 5,
            room_state: Hash32::new([0x55; 32]),
        }
    }

    /// The inviter is device 1, the new device is device 2.
    fn opened(role: Role) -> Inviter {
        Inviter::open(
            &key(1),
            terms(role, SessionId::ZERO),
            NOW,
            &mut SystemEntropy,
        )
        .expect("opens")
    }

    /// The link as the new device got it: through its text.
    fn handed_over(inviter: &Inviter) -> InviteLink {
        let text = String::from_utf8(inviter.link().to_text().expose().to_vec()).expect("utf-8");
        InviteLink::parse(&text).expect("parses")
    }

    fn requested(inviter: &Inviter, key_package: &[u8]) -> (Joiner, SignedRequest) {
        Joiner::request(
            &handed_over(inviter),
            inviter.signed_offer(),
            &key(2),
            key_package,
            NOW + 1_000,
        )
        .expect("requests")
    }

    struct NoEntropy;
    impl Entropy for NoEntropy {
        fn fill(&mut self, _: &mut [u8]) -> Result<(), Error> {
            Err(Error::Entropy)
        }
    }

    /// The whole ceremony with the hub's checks beside it; returns what the commit would take.
    fn ceremony(role: Role, session_id: SessionId) -> ConfirmedInvite {
        let mut inviter = Inviter::open(&key(1), terms(role, session_id), NOW, &mut SystemEntropy)
            .expect("opens");
        let offer = hub_check_offer(inviter.signed_offer()).expect("the hub takes the offer");
        assert_eq!(offer.inviter, device(1));
        assert_eq!(offer.role, role);
        assert_eq!(offer.session_id, session_id);
        assert_eq!(offer.expires_at, NOW + INVITE_LIFE_MS);

        let (joiner, request) = requested(&inviter, b"key package of device 2");
        hub_check_request(inviter.signed_offer(), &request, &hub(), &device(2))
            .expect("the hub takes the request");

        let accepted = inviter
            .accept(&key(1), &request, &device(2), NOW + 2_000)
            .expect("accepts");
        assert_eq!(accepted.new_device, device(2));
        let revealed = hub_check_reveal(
            inviter.signed_offer(),
            &accepted.reveal,
            std::slice::from_ref(&request),
        )
        .expect("the hub takes the reveal");

        let shown = joiner.reveal(&accepted.reveal).expect("checks the reveal");
        assert_eq!(shown, accepted.code);
        assert_eq!(shown.emoji(), accepted.code.emoji());

        // The person compares, and types or taps what the new device shows.
        let read_back = CheckCode::from_numbers(shown.numbers()).expect("a code");
        let confirmed = inviter
            .confirm(&read_back, &accepted.request_hash, NOW + 60_000)
            .expect("confirms");
        assert_eq!(confirmed.room_id(), &ROOM);
        assert_eq!(confirmed.inviter(), &device(1));
        assert_eq!(confirmed.new_device(), &device(2));
        assert_eq!(confirmed.role(), role);
        assert_eq!(confirmed.session_id(), &session_id);
        assert_eq!(confirmed.key_package(), b"key package of device 2");
        assert_eq!(confirmed.request_hash(), &accepted.request_hash);
        assert_eq!(confirmed.invite_id(), &offer.invite_id);

        // The hub lets exactly that outcome through.
        assert_eq!(
            revealed.check_outcome(&device(1), role, confirmed.key_package()),
            Ok(())
        );
        assert_eq!(
            revealed.check_outcome(&device(3), role, confirmed.key_package()),
            Err(Error::BadInvite)
        );
        assert_eq!(
            revealed.check_outcome(&device(1), role, b"another key package"),
            Err(Error::BadInvite)
        );
        let other_role = if role == Role::Human {
            Role::Agent
        } else {
            Role::Human
        };
        assert_eq!(
            revealed.check_outcome(&device(1), other_role, confirmed.key_package()),
            Err(Error::BadInvite)
        );

        // The commit asks whether the confirmation still stands, and finishes the invite with it.
        assert_eq!(inviter.check_confirmed(&confirmed), Ok(()));
        inviter.finish().expect("finishes");
        assert_eq!(inviter.check_confirmed(&confirmed), Err(Error::InviteUsed));
        assert_eq!(
            inviter
                .confirm(&read_back, &accepted.request_hash, NOW + 61_000)
                .err(),
            Some(Error::InviteUsed)
        );
        confirmed
    }

    #[test]
    fn a_human_device_joins() {
        let confirmed = ceremony(Role::Human, SessionId::ZERO);
        assert_eq!(confirmed.role(), Role::Human);
    }

    #[test]
    fn an_agent_device_joins_for_a_new_session_or_a_takeover() {
        assert!(ceremony(Role::Agent, SessionId::ZERO)
            .session_id()
            .is_zero());
        let session = SessionId::new([0x5E; 16]);
        assert_eq!(ceremony(Role::Agent, session).session_id(), &session);
    }

    #[test]
    fn the_derivations_are_the_ones_given() {
        let secret = Secret::new([0x11; 32]);
        let link = InviteLink::new(APP, hub(), ROOM, secret.duplicate()).expect("a link");
        let id = crypto::expand_with_label::<16>(&secret, "trommi invite id", ROOM.as_bytes())
            .expect("expands");
        assert_eq!(link.invite_id().expect("derives").as_bytes(), id.expose());
        let mac = crypto::expand_with_label::<32>(&secret, "trommi invite mac", ROOM.as_bytes())
            .expect("expands");
        assert_eq!(link.mac_key().expect("derives").expose(), mac.expose());

        let inviter = opened(Role::Human);
        let (_, request) = requested(&inviter, b"kp");
        let offer = &inviter.signed_offer().offer.clone();
        assert_eq!(
            inviter.offer().commitment,
            crypto::ref_hash(
                "Trommi Invite Commitment",
                &[
                    inviter.offer().invite_id.as_bytes().as_slice(),
                    inviter.nonce.expose()
                ]
                .concat()
            )
            .expect("hashes")
        );
        let decoded = Request::decode(&request.request).expect("decodes");
        assert_eq!(
            decoded.offer_hash,
            crypto::ref_hash("Trommi Invite Offer", offer).expect("hashes")
        );
        let handed = handed_over(&inviter);
        assert_eq!(
            request.mac,
            crypto::hmac_sha256(&handed.mac_key().expect("derives"), &request.request)
                .expect("macs")
        );
        let with_mac = [request.request.as_slice(), &request.mac].concat();
        assert_eq!(
            request_hash(&request).expect("hashes"),
            crypto::ref_hash("Trommi Invite Request", &with_mac).expect("hashes")
        );
        assert_eq!(
            crypto::verify_with_label(
                &key(1).public(),
                "TrommiInviteOffer",
                offer,
                &inviter.signed_offer().signature
            ),
            Ok(())
        );
        assert_eq!(
            crypto::verify_with_label(
                &key(2).public(),
                "TrommiInviteRequest",
                &with_mac,
                &request.signature
            ),
            Ok(())
        );

        let mut inviter = inviter;
        let accepted = inviter
            .accept(&key(1), &request, &device(2), NOW + 2_000)
            .expect("accepts");
        assert_eq!(
            crypto::verify_with_label(
                &key(1).public(),
                "TrommiInviteReveal",
                &accepted.reveal.reveal,
                &accepted.reveal.signature
            ),
            Ok(())
        );
        let code_hash = crypto::ref_hash(
            "Trommi Invite Code",
            &[offer.as_slice(), &with_mac, inviter.nonce.expose()].concat(),
        )
        .expect("hashes");
        let first =
            u64::from_be_bytes(code_hash.as_bytes()[..8].try_into().expect("eight bytes")) >> 28;
        let expected: Vec<u8> = (0..6).map(|i| (first >> (30 - 6 * i) & 63) as u8).collect();
        assert_eq!(accepted.code.numbers().as_slice(), expected);
    }

    #[test]
    fn the_messages_encode_as_their_structs_say() {
        let offer = Offer {
            room_id: ROOM,
            invite_id: InviteId::new([1; 16]),
            role: Role::Agent,
            session_id: SessionId::new([2; 16]),
            expires_at: 0x0102_0304_0506_0708,
            commitment: Hash32::new([3; 32]),
            inviter: DeviceId::new([4; 32]),
            room_epoch: 9,
            room_state: Hash32::new([5; 32]),
        };
        let bytes = codec::encode(&offer).expect("encodes");
        let expected = [
            [7u8; 32].as_slice(),
            &[1; 16],
            &[2],
            &[2; 16],
            &[1, 2, 3, 4, 5, 6, 7, 8],
            &[3; 32],
            &[4; 32],
            &[0, 0, 0, 0, 0, 0, 0, 9],
            &[5; 32],
        ]
        .concat();
        assert_eq!(bytes, expected);
        assert_eq!(bytes.len(), OFFER_LEN);
        assert_eq!(Offer::decode(&bytes), Ok(offer));

        let request = Request {
            room_id: ROOM,
            invite_id: InviteId::new([1; 16]),
            hub: HubAddress::parse("https://a").expect("canonical"),
            role: Role::Human,
            key_package: vec![9; 3],
            offer_hash: Hash32::new([6; 32]),
        };
        let bytes = codec::encode(&request).expect("encodes");
        let expected = [
            [7u8; 32].as_slice(),
            &[1; 16],
            &[9],
            b"https://a",
            &[1],
            &[3, 9, 9, 9],
            &[6; 32],
        ]
        .concat();
        assert_eq!(bytes, expected);
        assert_eq!(Request::decode(&bytes), Ok(request));

        let reveal = Reveal {
            invite_id: InviteId::new([1; 16]),
            nonce: [8; 32],
            request_hash: Hash32::new([6; 32]),
        };
        let bytes = codec::encode(&reveal).expect("encodes");
        assert_eq!(bytes, [[1u8; 16].as_slice(), &[8; 32], &[6; 32]].concat());
        assert_eq!(bytes.len(), REVEAL_LEN);
        assert_eq!(Reveal::decode(&bytes), Ok(reveal));
    }

    #[test]
    fn messages_of_another_form_are_refused_without_a_panic() {
        let inviter = opened(Role::Human);
        let (_, request) = requested(&inviter, b"kp");
        let offer = &inviter.signed_offer().offer;
        for cut in 0..offer.len() {
            assert_eq!(Offer::decode(&offer[..cut]), Err(Error::BadFormat));
        }
        for cut in 0..request.request.len() {
            assert_eq!(
                Request::decode(&request.request[..cut]),
                Err(Error::BadFormat)
            );
        }
        let trailing = |bytes: &[u8]| [bytes, &[0]].concat();
        assert_eq!(Offer::decode(&trailing(offer)), Err(Error::BadFormat));
        assert_eq!(
            Request::decode(&trailing(&request.request)),
            Err(Error::BadFormat)
        );
        assert_eq!(Reveal::decode(&[0; REVEAL_LEN - 1]), Err(Error::BadFormat));
        assert_eq!(Reveal::decode(&[0; REVEAL_LEN + 1]), Err(Error::BadFormat));

        // A role that is none, and a session to take over for a human device.
        let mut bad_role = offer.clone();
        bad_role[48] = 3;
        assert_eq!(Offer::decode(&bad_role), Err(Error::BadFormat));
        bad_role[48] = 0;
        assert_eq!(Offer::decode(&bad_role), Err(Error::BadFormat));
        let mut human_takeover = offer.clone();
        human_takeover[49] = 1;
        assert_eq!(Offer::decode(&human_takeover), Err(Error::BadFormat));

        // A Request without a KeyPackage, with one that is too long, with a hub address that is not canonical.
        let with_key_package = |key_package: Vec<u8>| {
            let mut writer = Writer::new();
            writer.fixed(&[7; 32]);
            writer.fixed(&[1; 16]);
            writer.opaque(b"https://a").expect("writes");
            writer.u8(1);
            writer.opaque(&key_package).expect("writes");
            writer.fixed(&[6; 32]);
            writer.into_bytes()
        };
        assert!(Request::decode(&with_key_package(vec![1])).is_ok());
        assert!(Request::decode(&with_key_package(vec![1; MAX_KEY_PACKAGE_LEN])).is_ok());
        assert_eq!(
            Request::decode(&with_key_package(vec![])),
            Err(Error::BadFormat)
        );
        assert_eq!(
            Request::decode(&with_key_package(vec![1; MAX_KEY_PACKAGE_LEN + 1])),
            Err(Error::BadFormat)
        );
        let mut writer = Writer::new();
        writer.fixed(&[7; 32]);
        writer.fixed(&[1; 16]);
        writer.opaque(b"https://A").expect("writes");
        writer.u8(1);
        writer.opaque(&[1]).expect("writes");
        writer.fixed(&[6; 32]);
        assert_eq!(Request::decode(&writer.into_bytes()), Err(Error::BadFormat));
    }

    #[test]
    fn a_link_is_built_and_read() {
        let link = InviteLink::new(APP, hub(), ROOM, Secret::new([0x33; 32])).expect("a link");
        let text = String::from_utf8(link.to_text().expose().to_vec()).expect("utf-8");
        assert_eq!(
            text,
            "https://app.example.org/join#v2.aHR0cHM6Ly9odWIuZXhhbXBsZS5vcmc.\
             BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc.MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM"
        );
        let read = InviteLink::parse(&text).expect("parses");
        assert_eq!(read, link);
        assert_eq!(read.app(), APP);
        assert_eq!(read.hub, hub());
        assert_eq!(read.room_id, ROOM);
        assert!(!format!("{link:?} {:?}", link.to_text()).contains("MzMz"));
        assert!(!format!("{link:?}").contains("3333"));
    }

    #[test]
    fn a_link_of_any_other_form_is_refused() {
        let hub_part = "aHR0cHM6Ly9odWIuZXhhbXBsZS5vcmc";
        let room = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
        let secret = "MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM";
        let good = format!("{APP}/join#v2.{hub_part}.{room}.{secret}");
        assert!(InviteLink::parse(&good).is_ok());

        // "https://Hub.example.org", "https://hub.example.org/" and "hub.example.org" as the hub part.
        let capital = ids::base64url_encode(b"https://Hub.example.org");
        let slash = ids::base64url_encode(b"https://hub.example.org/");
        let bare = ids::base64url_encode(b"hub.example.org");
        let not_utf8 = ids::base64url_encode(&[0xff, 0xfe]);
        let cases = [
            String::new(),
            APP.to_string(),
            format!("{APP}/join"),
            format!("{APP}/join#"),
            format!("{APP}/join#v2"),
            format!("{APP}/join#v2.{hub_part}.{room}"),
            format!("{APP}/join#v2.{hub_part}.{room}.{secret}."),
            format!("{APP}/join#v2.{hub_part}.{room}.{secret}.{secret}"),
            format!("{APP}/join#{hub_part}.{room}.{secret}"),
            format!("{APP}/join#v1.{hub_part}.{room}.{secret}"),
            format!("{APP}/join#v0.{hub_part}.{room}.{secret}"),
            format!("{APP}/join#v02.{hub_part}.{room}.{secret}"),
            format!("{APP}/join#v.{hub_part}.{room}.{secret}"),
            format!("{APP}/join#V2.{hub_part}.{room}.{secret}"),
            format!("{APP}/join#v+2.{hub_part}.{room}.{secret}"),
            format!("{APP}/join#v2 .{hub_part}.{room}.{secret}"),
            format!("{APP}/join#v2.{capital}.{room}.{secret}"),
            format!("{APP}/join#v2.{slash}.{room}.{secret}"),
            format!("{APP}/join#v2.{bare}.{room}.{secret}"),
            format!("{APP}/join#v2.{not_utf8}.{room}.{secret}"),
            format!("{APP}/join#v2..{room}.{secret}"),
            format!("{APP}/join#v2.{hub_part}=.{room}.{secret}"),
            format!("{APP}/join#v2.{hub_part}.{}.{secret}", &room[1..]),
            format!("{APP}/join#v2.{hub_part}.{room}A.{secret}"),
            format!("{APP}/join#v2.{hub_part}.{room}.{}", &secret[1..]),
            format!("{APP}/join#v2.{hub_part}.{room}.{secret}A"),
            format!("{APP}/join#v2.{hub_part}.{room}.{}N", &secret[..42]),
            format!("{APP}/join#v2.{hub_part}.{room}.{secret} "),
            format!("{APP}/join#v2.{hub_part}.{room}.{secret}#"),
            format!("{APP}/join/#v2.{hub_part}.{room}.{secret}"),
            format!("{APP}/join?x#v2.{hub_part}.{room}.{secret}"),
            format!("{APP}/Join#v2.{hub_part}.{room}.{secret}"),
            format!("{APP}/#v2.{hub_part}.{room}.{secret}"),
            format!("{APP}#v2.{hub_part}.{room}.{secret}"),
            format!("{APP}/x/join#v2.{hub_part}.{room}.{secret}"),
            format!("https://App.example.org/join#v2.{hub_part}.{room}.{secret}"),
            format!("app.example.org/join#v2.{hub_part}.{room}.{secret}"),
        ];
        for case in cases {
            assert_eq!(
                InviteLink::parse(&case).err(),
                Some(Error::BadFormat),
                "{case}"
            );
        }
        for newer in ["v3", "v10", "v99999999999999999999999"] {
            assert_eq!(
                InviteLink::parse(&format!("{APP}/join#{newer}.{hub_part}.{room}.{secret}")).err(),
                Some(Error::NewerVersion)
            );
            // A later version may have other parts: the version is read first.
            assert_eq!(
                InviteLink::parse(&format!("{APP}/join#{newer}.x")).err(),
                Some(Error::NewerVersion)
            );
        }
        assert_eq!(
            InviteLink::new("app.example.org", hub(), ROOM, Secret::new([0; 32])).err(),
            Some(Error::BadFormat)
        );
    }

    #[test]
    fn opening_needs_entropy_and_terms_an_offer_may_carry() {
        assert_eq!(
            Inviter::open(
                &key(1),
                terms(Role::Human, SessionId::ZERO),
                NOW,
                &mut NoEntropy
            )
            .err(),
            Some(Error::Entropy)
        );
        assert_eq!(
            Inviter::open(
                &key(1),
                terms(Role::Human, SessionId::new([1; 16])),
                NOW,
                &mut SystemEntropy
            )
            .err(),
            Some(Error::BadFormat)
        );
        let mut bad_app = terms(Role::Human, SessionId::ZERO);
        bad_app.app = "https://app.example.org/".into();
        assert_eq!(
            Inviter::open(&key(1), bad_app, NOW, &mut SystemEntropy).err(),
            Some(Error::BadFormat)
        );
        let a = opened(Role::Human);
        let b = opened(Role::Human);
        assert_ne!(a.offer().invite_id, b.offer().invite_id);
        assert_ne!(a.offer().commitment, b.offer().commitment);
        assert!(!format!("{a:?}").contains("nonce"));
    }

    #[test]
    fn the_new_device_refuses_an_offer_that_is_not_the_links() {
        let inviter = opened(Role::Human);
        let link = handed_over(&inviter);
        let ask = |offer: &SignedOffer, now: u64| {
            Joiner::request(&link, offer, &key(2), b"kp", now).err()
        };
        assert_eq!(ask(inviter.signed_offer(), NOW), None);
        assert_eq!(ask(inviter.signed_offer(), NOW + INVITE_LIFE_MS), None);

        // Expired.
        assert_eq!(
            ask(inviter.signed_offer(), NOW + INVITE_LIFE_MS + 1),
            Some(Error::InviteExpired)
        );
        // The Offer of another invite, validly signed.
        let other = opened(Role::Human);
        assert_eq!(ask(other.signed_offer(), NOW), Some(Error::BadInvite));
        // The same invite id in another room.
        let mut moved = inviter.offer().clone();
        moved.room_id = RoomId::new([8; 32]);
        let moved = codec::encode(&moved).expect("encodes");
        let resigned = SignedOffer {
            signature: crypto::sign_with_label(&key(1), SIGN_OFFER, &moved).expect("signs"),
            offer: moved,
        };
        assert_eq!(ask(&resigned, NOW), Some(Error::BadInvite));
        // Signed by another key than the inviter it names; a changed field under the old signature.
        let forged = SignedOffer {
            offer: inviter.signed_offer().offer.clone(),
            signature: crypto::sign_with_label(&key(3), SIGN_OFFER, &inviter.signed_offer().offer)
                .expect("signs"),
        };
        assert_eq!(ask(&forged, NOW), Some(Error::BadSignature));
        let mut later = inviter.offer().clone();
        later.expires_at += 1;
        let changed = SignedOffer {
            offer: codec::encode(&later).expect("encodes"),
            signature: inviter.signed_offer().signature.clone(),
        };
        assert_eq!(ask(&changed, NOW), Some(Error::BadSignature));
        // A hub that puts itself in the inviter's place needs the invite id, which it knows, and gets a
        // Request; but that Request names the hub's Offer, and the real inviter refuses it.
        let mut hubs = inviter.offer().clone();
        hubs.inviter = device(9);
        let hubs = codec::encode(&hubs).expect("encodes");
        let hubs = SignedOffer {
            signature: crypto::sign_with_label(&key(9), SIGN_OFFER, &hubs).expect("signs"),
            offer: hubs,
        };
        let (_, request) = Joiner::request(&link, &hubs, &key(2), b"kp", NOW).expect("requests");
        let mut inviter = inviter;
        assert_eq!(
            inviter.accept(&key(1), &request, &device(2), NOW).err(),
            Some(Error::BadInvite)
        );
        // Not an Offer; no KeyPackage.
        let junk = SignedOffer {
            offer: vec![1, 2, 3],
            signature: vec![],
        };
        assert_eq!(ask(&junk, NOW), Some(Error::BadFormat));
        for key_package in [vec![], vec![0; MAX_KEY_PACKAGE_LEN + 1]] {
            assert_eq!(
                Joiner::request(&link, inviter.signed_offer(), &key(2), &key_package, NOW).err(),
                Some(Error::BadFormat)
            );
        }
    }

    #[test]
    fn a_request_with_a_wrong_mac_is_refused_and_does_not_use_the_invite() {
        let mut inviter = opened(Role::Human);
        let (_, good) = requested(&inviter, b"kp");

        // Made without the link: with another secret for the same room and invite id.
        let guessed = InviteLink::new(APP, hub(), ROOM, Secret::new([0x99; 32])).expect("a link");
        let mut request = Request::decode(&good.request).expect("decodes");
        request.key_package = b"the hub's key package".to_vec();
        let bytes = codec::encode(&request).expect("encodes");
        let mac = crypto::hmac_sha256(&guessed.mac_key().expect("derives"), &bytes)
            .expect("macs")
            .to_vec();
        let mut forged = SignedRequest {
            request: bytes,
            mac,
            signature: vec![],
        };
        forged.signature = crypto::sign_with_label(
            &key(9),
            SIGN_REQUEST,
            &request_with_mac(&forged).expect("32"),
        )
        .expect("signs");
        assert_eq!(
            inviter.accept(&key(1), &forged, &device(9), NOW).err(),
            Some(Error::BadInvite)
        );

        // The good Request with one bit of the MAC, or of the body, changed.
        let mut bad_mac = good.clone();
        bad_mac.mac[0] ^= 1;
        assert_eq!(
            inviter.accept(&key(1), &bad_mac, &device(2), NOW).err(),
            Some(Error::BadInvite)
        );
        let mut bad_body = good.clone();
        let end = bad_body.request.len() - 1;
        bad_body.request[end] ^= 1;
        assert_eq!(
            inviter.accept(&key(1), &bad_body, &device(2), NOW).err(),
            Some(Error::BadInvite)
        );
        // A MAC of another length, and bytes that are no Request.
        for mac in [vec![], vec![0; 31], vec![0; 33]] {
            let short = SignedRequest {
                mac,
                ..good.clone()
            };
            assert_eq!(
                inviter.accept(&key(1), &short, &device(2), NOW).err(),
                Some(Error::BadFormat)
            );
        }
        let junk = SignedRequest {
            request: vec![1, 2, 3],
            ..good.clone()
        };
        assert_eq!(
            inviter.accept(&key(1), &junk, &device(2), NOW).err(),
            Some(Error::BadFormat)
        );

        // None of this used the invite up.
        assert!(inviter.accept(&key(1), &good, &device(2), NOW).is_ok());
    }

    #[test]
    fn a_request_that_does_not_match_the_invite_is_refused() {
        let mut inviter = opened(Role::Human);
        let link = handed_over(&inviter);
        let (_, good) = requested(&inviter, b"kp");
        // Whoever holds the link can make any Request with a valid MAC; each field is still compared.
        let remade = |change: &dyn Fn(&mut Request)| {
            let mut request = Request::decode(&good.request).expect("decodes");
            change(&mut request);
            let bytes = codec::encode(&request).expect("encodes");
            let mac = crypto::hmac_sha256(&link.mac_key().expect("derives"), &bytes)
                .expect("macs")
                .to_vec();
            let mut signed = SignedRequest {
                request: bytes,
                mac,
                signature: vec![],
            };
            signed.signature = crypto::sign_with_label(
                &key(2),
                SIGN_REQUEST,
                &request_with_mac(&signed).expect("32"),
            )
            .expect("signs");
            signed
        };
        let changes: [&dyn Fn(&mut Request); 5] = [
            &|r| r.room_id = RoomId::new([8; 32]),
            &|r| r.invite_id = InviteId::new([8; 16]),
            &|r| r.hub = HubAddress::parse("https://hub.example.com").expect("canonical"),
            &|r| r.role = Role::Agent,
            &|r| r.offer_hash = Hash32::new([8; 32]),
        ];
        for change in changes {
            assert_eq!(
                inviter
                    .accept(&key(1), &remade(change), &device(2), NOW)
                    .err(),
                Some(Error::BadInvite)
            );
        }
        // Signed by another key than the KeyPackage's.
        assert_eq!(
            inviter.accept(&key(1), &good, &device(3), NOW).err(),
            Some(Error::BadSignature)
        );
        let mut resigned = good.clone();
        resigned.signature =
            crypto::sign_with_label(&key(3), SIGN_REQUEST, &request_with_mac(&good).expect("32"))
                .expect("signs");
        assert_eq!(
            inviter.accept(&key(1), &resigned, &device(2), NOW).err(),
            Some(Error::BadSignature)
        );
        // The signature covers the MAC: one over the Request alone is none.
        let mut unbound = good.clone();
        unbound.signature =
            crypto::sign_with_label(&key(2), SIGN_REQUEST, &good.request).expect("signs");
        assert_eq!(
            inviter.accept(&key(1), &unbound, &device(2), NOW).err(),
            Some(Error::BadSignature)
        );
        assert!(inviter.accept(&key(1), &good, &device(2), NOW).is_ok());
    }

    #[test]
    fn an_invite_is_used_once() {
        let mut inviter = opened(Role::Human);
        let (_, first) = requested(&inviter, b"kp");
        let accepted = inviter
            .accept(&key(1), &first, &device(2), NOW)
            .expect("accepts");
        // The same Request again, and another valid one of someone else who has the link.
        assert_eq!(
            inviter.accept(&key(1), &first, &device(2), NOW).err(),
            Some(Error::InviteUsed)
        );
        let (_, second) = Joiner::request(
            &handed_over(&inviter),
            inviter.signed_offer(),
            &key(3),
            b"kp of 3",
            NOW,
        )
        .expect("requests");
        assert_eq!(
            inviter.accept(&key(1), &second, &device(3), NOW).err(),
            Some(Error::InviteUsed)
        );
        // After a restart the same Reveal and code are there again.
        assert_eq!(inviter.accepted(&key(1)), Ok(Some(accepted)));
        assert_eq!(opened(Role::Human).accepted(&key(1)), Ok(None));
    }

    #[test]
    fn an_invite_expires_after_ten_minutes() {
        let mut inviter = opened(Role::Human);
        let (_, request) = requested(&inviter, b"kp");
        assert_eq!(
            inviter
                .accept(&key(1), &request, &device(2), NOW + INVITE_LIFE_MS + 1)
                .err(),
            Some(Error::InviteExpired)
        );
        assert!(inviter
            .accept(&key(1), &request, &device(2), NOW + INVITE_LIFE_MS)
            .is_ok());
    }

    #[test]
    fn the_code_is_confirmed_within_five_minutes() {
        let mut inviter = opened(Role::Human);
        let (_, request) = requested(&inviter, b"kp");
        let at = NOW + 1_000;
        let accepted = inviter
            .accept(&key(1), &request, &device(2), at)
            .expect("accepts");
        assert_eq!(
            inviter
                .confirm(&accepted.code, &accepted.request_hash, at + CONFIRM_MS + 1)
                .err(),
            Some(Error::InviteExpired)
        );
        assert!(inviter
            .confirm(&accepted.code, &accepted.request_hash, at + CONFIRM_MS)
            .is_ok());
    }

    #[test]
    fn nothing_is_confirmed_without_the_code_and_the_request() {
        let mut inviter = opened(Role::Human);
        let any_code = CheckCode::from_numbers([1, 2, 3, 4, 5, 6]).expect("a code");
        // Before any Request.
        assert_eq!(
            inviter.confirm(&any_code, &Hash32::ZERO, NOW).err(),
            Some(Error::BadInvite)
        );
        assert_eq!(inviter.finish(), Err(Error::BadInvite));

        let (_, request) = requested(&inviter, b"kp");
        let accepted = inviter
            .accept(&key(1), &request, &device(2), NOW)
            .expect("accepts");
        // Every code that differs in one number.
        for place in 0..6 {
            let mut numbers = accepted.code.numbers();
            numbers[place] = (numbers[place] + 1) % 64;
            let other = CheckCode::from_numbers(numbers).expect("a code");
            assert_eq!(
                inviter.confirm(&other, &accepted.request_hash, NOW).err(),
                Some(Error::CodeNotConfirmed)
            );
        }
        // The right code for another Request.
        assert_eq!(
            inviter
                .confirm(&accepted.code, &Hash32::new([1; 32]), NOW)
                .err(),
            Some(Error::CodeNotConfirmed)
        );
        assert_eq!(
            inviter.confirm(&any_code, &Hash32::ZERO, NOW).err(),
            Some(Error::CodeNotConfirmed)
        );
        assert!(inviter
            .confirm(&accepted.code, &accepted.request_hash, NOW)
            .is_ok());
    }

    #[test]
    fn they_dont_match_burns_the_invite() {
        let mut inviter = opened(Role::Human);
        let (_, request) = requested(&inviter, b"kp");
        let accepted = inviter
            .accept(&key(1), &request, &device(2), NOW)
            .expect("accepts");
        // A confirmation given before the person changed their mind stands no longer.
        let confirmed = inviter
            .confirm(&accepted.code, &accepted.request_hash, NOW)
            .expect("confirms");
        assert_eq!(inviter.check_confirmed(&confirmed), Ok(()));
        inviter.burn();
        assert_eq!(
            inviter.check_confirmed(&confirmed),
            Err(Error::InviteBurned)
        );
        assert_eq!(
            inviter
                .confirm(&accepted.code, &accepted.request_hash, NOW)
                .err(),
            Some(Error::InviteBurned)
        );
        assert_eq!(
            inviter.accept(&key(1), &request, &device(2), NOW).err(),
            Some(Error::InviteBurned)
        );
        // Nor does it stand for another invite.
        let mut other = opened(Role::Human);
        assert_eq!(other.check_confirmed(&confirmed), Err(Error::BadInvite));
        let (_, other_request) = requested(&other, b"kp");
        other
            .accept(&key(1), &other_request, &device(2), NOW)
            .expect("accepts");
        assert_eq!(
            other.check_confirmed(&confirmed),
            Err(Error::CodeNotConfirmed)
        );
        assert_eq!(inviter.accepted(&key(1)), Ok(None));
        assert_eq!(inviter.finish(), Err(Error::BadInvite));

        // Burned before any Request, too.
        let mut unused = opened(Role::Human);
        let (_, request) = requested(&unused, b"kp");
        unused.burn();
        assert_eq!(
            unused.accept(&key(1), &request, &device(2), NOW).err(),
            Some(Error::InviteBurned)
        );
    }

    #[test]
    fn a_substituted_key_package_changes_the_code() {
        // Someone who also has the link answers first, with a KeyPackage of its own.
        let mut inviter = opened(Role::Human);
        let (joiner, _honest) = requested(&inviter, b"key package of device 2");
        let (_, intruder) = Joiner::request(
            &handed_over(&inviter),
            inviter.signed_offer(),
            &key(3),
            b"key package of device 3",
            NOW,
        )
        .expect("requests");
        let accepted = inviter
            .accept(&key(1), &intruder, &device(3), NOW)
            .expect("accepts");
        // The honest device sees that the inviter answered another Request.
        assert_eq!(joiner.reveal(&accepted.reveal), Err(Error::BadInvite));
        // And the code the inviter shows is not the one of the honest Request with the same nonce.
        let reveal = Reveal::decode(&accepted.reveal.reveal).expect("decodes");
        let honest_code = check_code(
            &inviter.signed_offer().offer,
            joiner.signed_request(),
            &reveal.nonce,
        )
        .expect("a code");
        assert_ne!(honest_code, accepted.code);
    }

    #[test]
    fn the_code_covers_every_part() {
        let inviter = opened(Role::Human);
        let (_, request) = requested(&inviter, b"kp");
        let offer = inviter.signed_offer().offer.clone();
        let nonce = [4u8; 32];
        let code = check_code(&offer, &request, &nonce).expect("a code");
        assert_eq!(check_code(&offer, &request, &nonce), Ok(code));

        let mut other_offer = offer.clone();
        other_offer[100] ^= 1;
        assert_ne!(check_code(&other_offer, &request, &nonce), Ok(code));
        let (_, other_request) = requested(&inviter, b"kq");
        assert_ne!(check_code(&offer, &other_request, &nonce), Ok(code));
        let mut other_mac = request.clone();
        other_mac.mac[5] ^= 1;
        assert_ne!(check_code(&offer, &other_mac, &nonce), Ok(code));
        assert_ne!(check_code(&offer, &request, &[5u8; 32]), Ok(code));
        // The signature is no part of it.
        let mut other_signature = request.clone();
        other_signature.signature[0] ^= 1;
        assert_eq!(check_code(&offer, &other_signature, &nonce), Ok(code));
    }

    #[test]
    fn the_new_device_refuses_a_reveal_that_is_not_its_invites() {
        let mut inviter = opened(Role::Human);
        let (joiner, request) = requested(&inviter, b"kp");
        let accepted = inviter
            .accept(&key(1), &request, &device(2), NOW)
            .expect("accepts");
        let good = Reveal::decode(&accepted.reveal.reveal).expect("decodes");
        let signed_by = |reveal: &Reveal, seed: u8| {
            let bytes = codec::encode(reveal).expect("encodes");
            SignedReveal {
                signature: crypto::sign_with_label(&key(seed), SIGN_REVEAL, &bytes).expect("signs"),
                reveal: bytes,
            }
        };
        assert!(joiner.reveal(&signed_by(&good, 1)).is_ok());
        // Signed by another device.
        assert_eq!(
            joiner.reveal(&signed_by(&good, 3)),
            Err(Error::BadSignature)
        );
        // Another invite, another Request, another nonce: each signed by the inviter.
        let mut other = good.clone();
        other.invite_id = InviteId::new([8; 16]);
        assert_eq!(joiner.reveal(&signed_by(&other, 1)), Err(Error::BadInvite));
        let mut other = good.clone();
        other.request_hash = Hash32::new([8; 32]);
        assert_eq!(joiner.reveal(&signed_by(&other, 1)), Err(Error::BadInvite));
        let mut other = good.clone();
        other.nonce[0] ^= 1;
        assert_eq!(joiner.reveal(&signed_by(&other, 1)), Err(Error::BadInvite));
        // Not a Reveal.
        let junk = SignedReveal {
            reveal: vec![0; 79],
            signature: accepted.reveal.signature.clone(),
        };
        assert_eq!(joiner.reveal(&junk), Err(Error::BadFormat));
        // The Offer's signature is no Reveal's.
        let relabelled = SignedReveal {
            reveal: accepted.reveal.reveal.clone(),
            signature: crypto::sign_with_label(&key(1), SIGN_OFFER, &accepted.reveal.reveal)
                .expect("signs"),
        };
        assert_eq!(joiner.reveal(&relabelled), Err(Error::BadSignature));
    }

    #[test]
    fn only_the_inviters_key_reveals() {
        let mut inviter = opened(Role::Human);
        let (_, request) = requested(&inviter, b"kp");
        assert!(matches!(
            inviter.accept(&key(4), &request, &device(2), NOW),
            Err(Error::Internal(_))
        ));
        // The refused call left the invite open.
        assert!(inviter.accept(&key(1), &request, &device(2), NOW).is_ok());
    }

    #[test]
    fn an_inviter_goes_through_the_store_in_every_state() {
        let mut inviter = opened(Role::Agent);
        let (_, request) = requested(&inviter, b"kp");
        let restored = |inviter: &Inviter| {
            let stored = inviter.to_stored().expect("stores");
            assert!(format!("{stored:?}").contains("redacted"));
            let back = Inviter::from_stored(stored.expose()).expect("restores");
            assert_eq!(back.to_stored().expect("stores").expose(), stored.expose());
            assert_eq!(back.link(), inviter.link());
            assert_eq!(back.signed_offer(), inviter.signed_offer());
            back
        };

        // Open: the restored invite accepts the Request.
        let mut open = restored(&inviter);
        let accepted = open
            .accept(&key(1), &request, &device(2), NOW)
            .expect("accepts");
        inviter
            .accept(&key(1), &request, &device(2), NOW)
            .expect("accepts");

        // Accepted: the restored invite reveals the same and confirms, and stays used.
        let mut held = restored(&inviter);
        assert_eq!(held.accepted(&key(1)), Ok(Some(accepted.clone())));
        assert!(held
            .confirm(&accepted.code, &accepted.request_hash, NOW)
            .is_ok());
        assert_eq!(
            held.accept(&key(1), &request, &device(2), NOW).err(),
            Some(Error::InviteUsed)
        );
        assert_eq!(
            held.confirm(&accepted.code, &accepted.request_hash, NOW + CONFIRM_MS + 1)
                .err(),
            Some(Error::InviteExpired)
        );

        // Done and burned stay so.
        held.finish().expect("finishes");
        assert_eq!(
            restored(&held)
                .confirm(&accepted.code, &accepted.request_hash, NOW)
                .err(),
            Some(Error::InviteUsed)
        );
        inviter.burn();
        assert_eq!(
            restored(&inviter)
                .confirm(&accepted.code, &accepted.request_hash, NOW)
                .err(),
            Some(Error::InviteBurned)
        );
    }

    #[test]
    fn a_damaged_stored_inviter_is_refused_without_a_panic() {
        let mut inviter = opened(Role::Human);
        let (_, request) = requested(&inviter, b"kp");
        let open = inviter.to_stored().expect("stores").expose().to_vec();
        inviter
            .accept(&key(1), &request, &device(2), NOW)
            .expect("accepts");
        let accepted = inviter.to_stored().expect("stores").expose().to_vec();

        for stored in [&open, &accepted] {
            for cut in 0..stored.len() {
                assert_eq!(
                    Inviter::from_stored(&stored[..cut]).err(),
                    Some(Error::BadFormat),
                    "{cut}"
                );
            }
            // A changed bit breaks a length, a signature, the commitment, the MAC or a comparison. Nothing
            // covers the app's origin, the hub of an invite not yet answered, and the time of acceptance: there
            // a change may leave a stored invite that still reads, with another origin, hub or time.
            let is_accepted = std::ptr::eq(stored, &accepted);
            let app = 2..2 + APP.len();
            let hub_address = app.end + 1..app.end + 1 + hub().as_str().len();
            let time = stored.len() - 8..stored.len();
            let mut refused = 0;
            for at in 0..stored.len() {
                let mut changed = stored.to_vec();
                changed[at] ^= 0x01;
                match Inviter::from_stored(&changed) {
                    Err(error) => {
                        assert_eq!(error, Error::BadFormat, "{at}");
                        refused += 1;
                    }
                    Ok(_) => assert!(
                        app.contains(&at)
                            || (!is_accepted && hub_address.contains(&at))
                            || (is_accepted && time.contains(&at)),
                        "{at}"
                    ),
                }
            }
            assert!(refused >= stored.len() - app.len() - hub_address.len() - time.len());
            let mut trailing = stored.to_vec();
            trailing.push(0);
            assert_eq!(
                Inviter::from_stored(&trailing).err(),
                Some(Error::BadFormat)
            );
        }
        assert_eq!(
            Inviter::from_stored(&vec![1; MAX_STORED_LEN + 1]).err(),
            Some(Error::BadFormat)
        );
    }

    #[test]
    fn a_joiner_goes_through_the_store() {
        let mut inviter = opened(Role::Human);
        let (joiner, request) = requested(&inviter, b"kp");
        let stored = joiner.to_stored().expect("stores");
        let back = Joiner::from_stored(&stored).expect("restores");
        assert_eq!(back, joiner);
        assert_eq!(back.signed_request(), &request);
        assert_eq!(back.offer().inviter, device(1));
        assert_eq!(back.offer().room_epoch, 5);
        assert_eq!(back.offer().room_state, Hash32::new([0x55; 32]));

        let accepted = inviter
            .accept(&key(1), &request, &device(2), NOW)
            .expect("accepts");
        assert_eq!(back.reveal(&accepted.reveal), Ok(accepted.code));

        for cut in 0..stored.len() {
            assert_eq!(
                Joiner::from_stored(&stored[..cut]).err(),
                Some(Error::BadFormat)
            );
        }
        let mut trailing = stored.clone();
        trailing.push(0);
        assert_eq!(Joiner::from_stored(&trailing).err(), Some(Error::BadFormat));
        // A Request that answers another Offer.
        let other = opened(Role::Human);
        let (other_joiner, _) = requested(&other, b"kp");
        let mixed = Joiner {
            request: other_joiner.request.clone(),
            ..joiner.clone()
        };
        assert_eq!(
            Joiner::from_stored(&mixed.to_stored().expect("stores")).err(),
            Some(Error::BadFormat)
        );
    }

    #[test]
    fn the_hub_checks_what_it_can() {
        let mut inviter = opened(Role::Human);
        let offer = inviter.signed_offer().clone();
        let (_, request) = requested(&inviter, b"kp");

        // Offer: signed by the inviter it names.
        let forged = SignedOffer {
            offer: offer.offer.clone(),
            signature: crypto::sign_with_label(&key(3), SIGN_OFFER, &offer.offer).expect("signs"),
        };
        assert_eq!(hub_check_offer(&forged).err(), Some(Error::BadSignature));
        let junk = SignedOffer {
            offer: vec![0; 10],
            signature: vec![],
        };
        assert_eq!(hub_check_offer(&junk).err(), Some(Error::BadFormat));

        // Request: for this Offer, this hub, signed by the KeyPackage's key.
        assert!(hub_check_request(&offer, &request, &hub(), &device(2)).is_ok());
        assert_eq!(
            hub_check_request(&offer, &request, &hub(), &device(3)).err(),
            Some(Error::BadSignature)
        );
        let elsewhere = HubAddress::parse("https://hub.example.com").expect("canonical");
        assert_eq!(
            hub_check_request(&offer, &request, &elsewhere, &device(2)).err(),
            Some(Error::BadInvite)
        );
        let other = opened(Role::Human);
        assert_eq!(
            hub_check_request(other.signed_offer(), &request, &hub(), &device(2)).err(),
            Some(Error::BadInvite)
        );
        let short_mac = SignedRequest {
            mac: vec![0; 16],
            ..request.clone()
        };
        assert_eq!(
            hub_check_request(&offer, &short_mac, &hub(), &device(2)).err(),
            Some(Error::BadFormat)
        );
        // The MAC is beyond the hub: a Request whose MAC is wrong but which is signed over that MAC passes
        // here, and is refused by the inviter.
        let mut unkeyed = request.clone();
        unkeyed.mac = vec![0; 32];
        unkeyed.signature = crypto::sign_with_label(
            &key(2),
            SIGN_REQUEST,
            &request_with_mac(&unkeyed).expect("32"),
        )
        .expect("signs");
        assert!(hub_check_request(&offer, &unkeyed, &hub(), &device(2)).is_ok());
        assert_eq!(
            inviter.accept(&key(1), &unkeyed, &device(2), NOW).err(),
            Some(Error::BadInvite)
        );

        // Reveal: signed by the inviter, opening the commitment, naming a Request the hub holds.
        let accepted = inviter
            .accept(&key(1), &request, &device(2), NOW)
            .expect("accepts");
        let held = [unkeyed.clone(), request.clone()];
        let revealed = hub_check_reveal(&offer, &accepted.reveal, &held).expect("checks");
        assert_eq!(revealed.inviter, device(1));
        assert_eq!(revealed.role, Role::Human);
        assert_eq!(revealed.key_package, b"kp");
        assert_eq!(revealed.request_hash, accepted.request_hash);
        assert_eq!(
            hub_check_reveal(&offer, &accepted.reveal, &[unkeyed]).err(),
            Some(Error::BadInvite)
        );
        assert_eq!(
            hub_check_reveal(&offer, &accepted.reveal, &[]).err(),
            Some(Error::BadInvite)
        );
        assert_eq!(revealed.room_id(), &ROOM);
        assert_eq!(revealed.invite_id(), &inviter.offer().invite_id);
        assert_eq!(revealed.inviter(), &device(1));
        assert_eq!(revealed.role(), Role::Human);
        assert!(revealed.session_id().is_zero());
        assert_eq!(revealed.key_package(), b"kp");
        assert_eq!(revealed.request_hash(), &accepted.request_hash);
        // A Request longer than one can be is refused before anything is copied or hashed.
        let huge = SignedRequest {
            request: vec![0; MAX_REQUEST_LEN + 1],
            ..request.clone()
        };
        assert_eq!(request_hash(&huge), Err(Error::BadFormat));
        assert_eq!(
            hub_check_request(&offer, &huge, &hub(), &device(2)).err(),
            Some(Error::BadFormat)
        );
        // A Request the hub holds for another Offer names that Offer, whatever a Reveal says of its hash.
        let (_, elsewhere_request) = requested(&other, b"kp");
        let mut pointing = Reveal::decode(&accepted.reveal.reveal).expect("decodes");
        pointing.request_hash = request_hash(&elsewhere_request).expect("hashes");
        let bytes = codec::encode(&pointing).expect("encodes");
        let pointing = SignedReveal {
            signature: crypto::sign_with_label(&key(1), SIGN_REVEAL, &bytes).expect("signs"),
            reveal: bytes,
        };
        assert_eq!(
            hub_check_reveal(&offer, &pointing, &[elsewhere_request]).err(),
            Some(Error::BadInvite)
        );
        assert_eq!(
            hub_check_reveal(other.signed_offer(), &accepted.reveal, &held).err(),
            Some(Error::BadInvite)
        );
        let mut wrong_nonce = Reveal::decode(&accepted.reveal.reveal).expect("decodes");
        wrong_nonce.nonce[0] ^= 1;
        let bytes = codec::encode(&wrong_nonce).expect("encodes");
        let wrong_nonce = SignedReveal {
            signature: crypto::sign_with_label(&key(1), SIGN_REVEAL, &bytes).expect("signs"),
            reveal: bytes,
        };
        assert_eq!(
            hub_check_reveal(&offer, &wrong_nonce, &held).err(),
            Some(Error::BadInvite)
        );
        let forged = SignedReveal {
            reveal: accepted.reveal.reveal.clone(),
            signature: crypto::sign_with_label(&key(3), SIGN_REVEAL, &accepted.reveal.reveal)
                .expect("signs"),
        };
        assert_eq!(
            hub_check_reveal(&offer, &forged, &held).err(),
            Some(Error::BadSignature)
        );
        let junk = SignedReveal {
            reveal: vec![],
            signature: vec![],
        };
        assert_eq!(
            hub_check_reveal(&offer, &junk, &held).err(),
            Some(Error::BadFormat)
        );
    }

    #[test]
    fn a_check_code_is_six_numbers_below_64() {
        let code = CheckCode::from_numbers([0, 1, 29, 62, 63, 21]).expect("a code");
        assert_eq!(code.numbers(), [0, 1, 29, 62, 63, 21]);
        assert_eq!(
            code.words(),
            ["dog", "cat", "heart", "folder", "pin", "cloud"]
        );
        assert_eq!(code.emoji()[0], "🐶");
        assert_eq!(code.emoji()[4], "📌");
        assert_eq!(
            CheckCode::from_numbers([0, 1, 2, 3, 4, 64]),
            Err(Error::BadFormat)
        );
        assert_eq!(
            CheckCode::from_numbers([255, 1, 2, 3, 4, 5]),
            Err(Error::BadFormat)
        );
        assert_ne!(
            code,
            CheckCode::from_numbers([0, 1, 29, 62, 63, 22]).expect("a code")
        );
    }

    #[test]
    fn the_emoji_are_those_of_the_web_app_in_its_order() {
        let source = include_str!("../../app/web/core/check-emoji.ts");
        let table = source
            .split("Object.freeze([")
            .nth(1)
            .and_then(|rest| rest.split("].map(").next())
            .expect("the table");
        // Each entry is ['<emoji>', '<word>'].
        let quoted: Vec<&str> = table.split('\'').skip(1).step_by(2).collect();
        let entries: Vec<(&str, &str)> = quoted.chunks(2).map(|pair| (pair[0], pair[1])).collect();
        assert_eq!(entries.len(), 64);
        assert_eq!(CHECK_EMOJI.as_slice(), entries.as_slice());

        let distinct: std::collections::BTreeSet<&str> =
            CHECK_EMOJI.iter().map(|(emoji, _)| *emoji).collect();
        assert_eq!(distinct.len(), 64);
    }
}
