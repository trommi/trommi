//! `spec/vectors/invite.json`: joining by link, once for a human device and once for an agent device that
//! takes a session over: every message with its hashes, the check code, and what the confirmation refuses
//! (section 12.1).

use serde_json::{json, Value};
use trommi_core::crypto::{self, Entropy, Secret, SigningKey};
use trommi_core::device::Device;
use trommi_core::hub_auth::HubAddress;
use trommi_core::ids::{self, DeviceId, Hash32, RoomId, SessionId};
use trommi_core::invite::{
    hub_check_offer, hub_check_request, request_hash, CheckCode, InviteLink, InviteTerms, Inviter,
    Joiner, Reveal, Role, CONFIRM_MS,
};
use trommi_core::mls::key_package::verify_key_package;
use trommi_core::Error;

use super::{entropy, hex};
use crate::MemoryStorage;

/// The name of the file.
pub const NAME: &str = "invite";
/// The app's origin in the links.
pub const APP: &str = "https://app.example.org";
/// The hub the room lives on.
pub const HUB: &str = "https://hub.example.org";
/// When the invites were opened and the KeyPackages made. A KeyPackage is valid from an hour before it was
/// made, so this lies in the past.
pub const OPENED_AT: u64 = 1_790_000_000_000;

/// A new device with its signature key and one KeyPackage, made by a device whose randomness is the stream
/// named `name`: the same key and the same KeyPackage on every run.
fn new_device(name: &str) -> Result<(SigningKey, Vec<u8>), Error> {
    // A device draws its signature key first: the same stream gives the same key here.
    let key = SigningKey::generate(&mut entropy(name)?)?;
    let mut device = Device::create(MemoryStorage::new(), Box::new(entropy(name)?))?;
    if device.id() != DeviceId::new(key.public()) {
        return Err(Error::Internal("the device drew its key otherwise"));
    }
    Ok((key, device.key_package(OPENED_AT)?))
}

fn text(bytes: &[u8]) -> Result<String, Error> {
    String::from_utf8(bytes.to_vec()).map_err(|_| Error::Internal("vector text"))
}

fn one(role: Role, session_id: SessionId, entropy: &mut dyn Entropy) -> Result<Value, Error> {
    let (what, stream) = match role {
        Role::Human => ("a human device", "invite new human device"),
        Role::Agent => (
            "an agent device that takes a session over",
            "invite new agent device",
        ),
    };
    let inviter_key = SigningKey::generate(entropy)?;
    let (new_key, key_package) = new_device(stream)?;
    let room_id = RoomId::new(crypto::random(entropy)?);
    let terms = InviteTerms {
        app: APP.to_owned(),
        hub: HubAddress::parse(HUB)?,
        room_id,
        role,
        session_id,
        room_epoch: 3,
        room_state: Hash32::new(crypto::random(entropy)?),
    };
    let mut inviter = Inviter::open(&inviter_key, terms, OPENED_AT, entropy)?;
    let link = text(inviter.link().to_text().expose())?;
    // The secret is the part before the deadline, the last part.
    let secret = link.rsplit('.').nth(1).ok_or(Error::Internal("a link"))?;
    let secret = Secret::<32>::from_slice(&ids::base64url_decode(secret)?)?;
    let context = [
        room_id.as_bytes().as_slice(),
        &inviter.offer().expires_at.to_be_bytes(),
    ]
    .concat();
    let mac_key: Secret<32> = crypto::expand_with_label(&secret, "trommi invite mac", &context)?;
    let offer_mac_key: Secret<32> =
        crypto::expand_with_label(&secret, "trommi invite offer", &context)?;
    let signed_offer = inviter.signed_offer().clone();
    hub_check_offer(&signed_offer)?;

    let requested_at = OPENED_AT + 1_000;
    let (joiner, request) = Joiner::request(
        &InviteLink::parse(&link)?,
        &signed_offer,
        &new_key,
        &key_package,
        requested_at,
    )?;
    let asks = hub_check_request(&signed_offer, &request, &HubAddress::parse(HUB)?)?;
    let accepted_at = OPENED_AT + 2_000;
    let accepted = inviter.accept(&inviter_key, &request, accepted_at)?;
    let shown = joiner.reveal(&accepted.reveal)?;
    if shown != accepted.code || asks != accepted.new_device {
        return Err(Error::Internal("the two sides disagree"));
    }
    let nonce = Reveal::decode(&accepted.reveal.reveal)?.nonce;
    let inviter_stored = inviter.to_stored()?;

    // 12.1.4: what the function that commits is given, and what it answers.
    let mut other_code = accepted.code.numbers();
    if let Some(first) = other_code.first_mut() {
        *first = (*first + 1) % 64;
    }
    let other_hash = Hash32::new([0x22; 32]);
    let confirm = |inviter: &Inviter, code: [u8; 6], hash: &Hash32, now: u64| match inviter.confirm(
        &CheckCode::from_numbers(code)?,
        hash,
        now,
    ) {
        Ok(_) => Ok("confirmed"),
        Err(error) => Ok::<_, Error>(error.code()),
    };
    let right = accepted.code.numbers();
    let mut burned = Inviter::from_stored(inviter_stored.expose())?;
    burned.burn();
    let case = |why: &str, code: [u8; 6], hash: &Hash32, now: u64, after_burning: bool| {
        let asked = if after_burning { &burned } else { &inviter };
        Ok::<_, Error>(json!({
            "why": why,
            "code": code,
            "request_hash": hex(hash.as_bytes()),
            "now": now,
            "after_they_dont_match": after_burning,
            "result": confirm(asked, code, hash, now)?,
        }))
    };
    let hash = accepted.request_hash;
    let confirmations = vec![
        case(
            "the code and the Request the person compared",
            right,
            &hash,
            accepted_at + CONFIRM_MS,
            false,
        )?,
        case("another code", other_code, &hash, accepted_at, false)?,
        case(
            "the code, for another Request",
            right,
            &other_hash,
            accepted_at,
            false,
        )?,
        case(
            "more than five minutes after the Request was accepted",
            right,
            &hash,
            accepted_at + CONFIRM_MS + 1,
            false,
        )?,
        case(
            "after \"they don't match\"",
            right,
            &hash,
            accepted_at,
            true,
        )?,
    ];

    let offer = inviter.offer();
    Ok(json!({
        "what": what,
        "role": role as u8,
        "session_id": hex(session_id.as_bytes()),
        "room_id": hex(room_id.as_bytes()),
        "room_epoch": offer.room_epoch,
        "room_state": hex(offer.room_state.as_bytes()),
        "inviter_seed": hex(inviter_key.seed().expose()),
        "inviter": hex(&inviter_key.public()),
        "new_device_seed": hex(new_key.seed().expose()),
        "new_device": hex(&new_key.public()),
        "key_package": hex(&key_package),
        "key_package_not_after": verify_key_package(&key_package)?.not_after_ms,
        "link": link,
        "secret": hex(secret.expose()),
        "invite_id": hex(offer.invite_id.as_bytes()),
        "mac_key": hex(mac_key.expose()),
        "nonce": hex(&nonce),
        "commitment": hex(offer.commitment.as_bytes()),
        "opened_at": OPENED_AT,
        "expires_at": offer.expires_at,
        "offer": hex(&signed_offer.offer),
        "offer_signature": hex(&signed_offer.signature),
        "offer_mac_key": hex(offer_mac_key.expose()),
        "offer_mac": hex(&signed_offer.mac),
        "offer_hash": hex(crypto::ref_hash("Trommi Invite Offer", &signed_offer.offer)?.as_bytes()),
        "requested_at": requested_at,
        "request": hex(&request.request),
        "mac": hex(&request.mac),
        "request_signature": hex(&request.signature),
        "request_hash": hex(request_hash(&request)?.as_bytes()),
        "accepted_at": accepted_at,
        "reveal": hex(&accepted.reveal.reveal),
        "reveal_signature": hex(&accepted.reveal.signature),
        "code": accepted.code.numbers(),
        "emoji": accepted.code.emoji(),
        "words": accepted.code.words(),
        "inviter_stored": hex(inviter_stored.expose()),
        "joiner_stored": hex(&joiner.to_stored()?),
        "confirmations": confirmations,
    }))
}

/// Makes the file.
pub fn generate() -> Result<Value, Error> {
    let mut entropy = entropy(NAME)?;
    let takeover = SessionId::new(crypto::random(&mut entropy)?);
    let invites = vec![
        one(Role::Human, SessionId::ZERO, &mut entropy)?,
        one(Role::Agent, takeover, &mut entropy)?,
    ];
    Ok(json!({
        "about": "Joining by link (spec/v2.md section 12.1), played once for each role. Each invite: the link with its secret and its deadline (expires_at, the last part) and what follows from both (invite_id, mac_key, offer_mac_key; the context of each derivation is room_id followed by expires_at as 8 bytes big-endian), the inviter's nonce and its commitment, the Offer with its signature and its MAC (offer_mac: HMAC-SHA-256 under offer_mac_key over the Offer followed by its signature), the Request with its MAC, the Reveal, each as its encoding (hex) with its signature and hash, and the check code as six numbers, emoji and words. The KeyPackage is one the new device made at opened_at; OpenMLS holds a KeyPackage's lifetime against the clock, so the steps that verify it (taking a Request) pass only until key_package_not_after. room_state stands for the hash of the room group's GroupContext and is random here. inviter_stored and joiner_stored are the two sides' stored state after the Reveal, from which everything behind it is computed again without the KeyPackage being verified. confirmations: what the function that commits answers (12.1.4) when it is given a code and a request hash at now, from the stored inviter, or from it after \"they don't match\": 'confirmed' or the code.",
        "app": APP,
        "hub": HUB,
        "invites": invites,
    }))
}
