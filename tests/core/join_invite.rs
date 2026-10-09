//! Joining by link (section 12.1): Offer, Request, Reveal, the check code and the guard of the confirmed
//! commit, on the inviter, on the new device and at the hub, with KeyPackages as devices make them.

use trommi_core::codec::{self, Writer};
use trommi_core::crypto::{self, Entropy, Secret, SigningKey, SystemEntropy};
use trommi_core::hub_auth::HubAddress;
use trommi_core::ids::{self, DeviceId, Hash32, InviteId, RoomId, SessionId};
use trommi_core::invite::*;
use trommi_core::Error;
use trommi_tests::forge::Forger;

const ROOM: RoomId = RoomId::new([7; 32]);
const NOW: u64 = 1_700_000_000_000;
const APP: &str = "https://app.example.org";

// The lengths and labels of section 12.1, stated here a second time.
const OFFER_LEN: usize = 32 + 16 + 1 + 16 + 8 + 32 + 32 + 8 + 32;
const REVEAL_LEN: usize = 16 + 32 + 32;
const MAX_REQUEST_LEN: usize = 32 + 16 + 2 + 512 + 1 + 4 + MAX_KEY_PACKAGE_LEN + 32;
const MAX_STORED_LEN: usize = 4 * MAX_REQUEST_LEN;
const SIGN_OFFER: &str = "TrommiInviteOffer";
const SIGN_REQUEST: &str = "TrommiInviteRequest";
const SIGN_REVEAL: &str = "TrommiInviteReveal";

/// `mac_key` as whoever holds the link derives it: from the secret behind the link's last dot.
fn mac_key(link: &InviteLink) -> Secret<32> {
    let text = String::from_utf8(link.to_text().expose().to_vec()).expect("utf-8");
    let secret = text.rsplit('.').next().expect("the secret");
    let secret =
        Secret::from_slice(&ids::base64url_decode(secret).expect("base64url")).expect("32 bytes");
    crypto::expand_with_label(&secret, "trommi invite mac", link.room_id.as_bytes())
        .expect("expands")
}

/// `Request ‖ mac`.
fn request_with_mac(request: &SignedRequest) -> Vec<u8> {
    [request.request.as_slice(), &request.mac].concat()
}

/// The check code by the formula: the first 36 bits of the hash over Offer, Request, MAC and nonce, as six
/// numbers of six bits.
fn check_code(offer: &[u8], request: &SignedRequest, nonce: &[u8; 32]) -> CheckCode {
    let input = [offer, &request_with_mac(request), nonce].concat();
    let hash = crypto::ref_hash("Trommi Invite Code", &input).expect("hashes");
    let bits = hash.as_bytes()[..5]
        .iter()
        .fold(0u64, |bits, byte| bits << 8 | u64::from(*byte))
        >> 4;
    let numbers = [30u32, 24, 18, 12, 6, 0].map(|shift| ((bits >> shift) & 63) as u8);
    CheckCode::from_numbers(numbers).expect("six numbers below 64")
}

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

/// A KeyPackage of device `seed` whose leaf states an extension the profile does not have.
fn foreign_key_package(seed: u8) -> Vec<u8> {
    let mut forger = Forger::with_key(key(seed));
    forger.extra_extension = Some(0xF1F1);
    forger.key_package()
}

/// A KeyPackage of device `seed`, as that device makes one.
fn key_package(seed: u8) -> Vec<u8> {
    Forger::with_key(key(seed)).key_package()
}

/// Device `seed` answers the invite with a KeyPackage of its own.
fn requested_by(inviter: &Inviter, seed: u8) -> (Joiner, SignedRequest) {
    Joiner::request(
        &handed_over(inviter),
        inviter.signed_offer(),
        &key(seed),
        &key_package(seed),
        NOW + 1_000,
    )
    .expect("requests")
}

/// The new device, device 2, answers the invite.
fn requested(inviter: &Inviter) -> (Joiner, SignedRequest) {
    requested_by(inviter, 2)
}

struct NoEntropy;
impl Entropy for NoEntropy {
    fn fill(&mut self, _: &mut [u8]) -> Result<(), Error> {
        Err(Error::Entropy)
    }
}

/// The whole ceremony with the hub's checks beside it; returns what the commit would take.
fn ceremony(role: Role, session_id: SessionId) -> ConfirmedInvite {
    let mut inviter =
        Inviter::open(&key(1), terms(role, session_id), NOW, &mut SystemEntropy).expect("opens");
    let offer = hub_check_offer(inviter.signed_offer()).expect("the hub takes the offer");
    assert_eq!(offer.inviter, device(1));
    assert_eq!(offer.role, role);
    assert_eq!(offer.session_id, session_id);
    assert_eq!(offer.expires_at, NOW + INVITE_LIFE_MS);

    let (joiner, request) = requested(&inviter);
    hub_check_request(inviter.signed_offer(), &request, &hub()).expect("the hub takes the request");

    let accepted = inviter
        .accept(&key(1), &request, NOW + 2_000)
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
    assert_eq!(
        confirmed.key_package(),
        Request::decode(&request.request)
            .expect("decodes")
            .key_package
    );
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
        revealed.check_outcome(&device(1), role, &key_package(2)),
        Err(Error::BadInvite)
    );
    // The key that may be enrolled in `agents` is the new device's, by the inviter, for an agent invite.
    assert_eq!(revealed.new_device(), &device(2));
    let enrolled = revealed.check_enrolment(&device(1), &device(2));
    assert_eq!(enrolled.is_ok(), role == Role::Agent);
    assert_eq!(
        revealed.check_enrolment(&device(3), &device(2)),
        Err(Error::BadInvite)
    );
    assert_eq!(
        revealed.check_enrolment(&device(1), &device(3)),
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
    assert_eq!(mac_key(&link).expose(), mac.expose());

    let inviter = opened(Role::Human);
    let (_, request) = requested(&inviter);
    let offer = &inviter.signed_offer().offer.clone();
    let decoded = Request::decode(&request.request).expect("decodes");
    assert_eq!(
        decoded.offer_hash,
        crypto::ref_hash("Trommi Invite Offer", offer).expect("hashes")
    );
    let handed = handed_over(&inviter);
    assert_eq!(
        request.mac,
        crypto::hmac_sha256(&mac_key(&handed), &request.request).expect("macs")
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
        .accept(&key(1), &request, NOW + 2_000)
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
    // The nonce the Reveal gives out is the one the Offer committed to.
    let nonce = Reveal::decode(&accepted.reveal.reveal)
        .expect("decodes")
        .nonce;
    assert_eq!(
        inviter.offer().commitment,
        crypto::ref_hash(
            "Trommi Invite Commitment",
            &[inviter.offer().invite_id.as_bytes().as_slice(), &nonce].concat()
        )
        .expect("hashes")
    );
    let code_hash = crypto::ref_hash(
        "Trommi Invite Code",
        &[offer.as_slice(), &with_mac, &nonce].concat(),
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
    let (_, request) = requested(&inviter);
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
    let own = key_package(2);
    let ask =
        |offer: &SignedOffer, now: u64| Joiner::request(&link, offer, &key(2), &own, now).err();
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
    let (_, request) = Joiner::request(&link, &hubs, &key(2), &own, NOW).expect("requests");
    let mut inviter = inviter;
    assert_eq!(
        inviter.accept(&key(1), &request, NOW).err(),
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
    // A KeyPackage that is none, is not the profile's, or is another device's: the Request would be signed
    // by another key than its KeyPackage's.
    for key_package in [b"kp".to_vec(), foreign_key_package(2), key_package(3)] {
        assert_eq!(
            Joiner::request(&link, inviter.signed_offer(), &key(2), &key_package, NOW).err(),
            Some(Error::BadKeyPackage)
        );
    }
}

#[test]
fn a_request_with_a_wrong_mac_is_refused_and_does_not_use_the_invite() {
    let mut inviter = opened(Role::Human);
    let (_, good) = requested(&inviter);

    // Made without the link: with another secret for the same room and invite id.
    let guessed = InviteLink::new(APP, hub(), ROOM, Secret::new([0x99; 32])).expect("a link");
    let mut request = Request::decode(&good.request).expect("decodes");
    request.key_package = b"the hub's key package".to_vec();
    let bytes = codec::encode(&request).expect("encodes");
    let mac = crypto::hmac_sha256(&mac_key(&guessed), &bytes)
        .expect("macs")
        .to_vec();
    let mut forged = SignedRequest {
        request: bytes,
        mac,
        signature: vec![],
    };
    forged.signature =
        crypto::sign_with_label(&key(9), SIGN_REQUEST, &request_with_mac(&forged)).expect("signs");
    assert_eq!(
        inviter.accept(&key(1), &forged, NOW).err(),
        Some(Error::BadInvite)
    );

    // The good Request with one bit of the MAC, or of the body, changed.
    let mut bad_mac = good.clone();
    bad_mac.mac[0] ^= 1;
    assert_eq!(
        inviter.accept(&key(1), &bad_mac, NOW).err(),
        Some(Error::BadInvite)
    );
    let mut bad_body = good.clone();
    let end = bad_body.request.len() - 1;
    bad_body.request[end] ^= 1;
    assert_eq!(
        inviter.accept(&key(1), &bad_body, NOW).err(),
        Some(Error::BadInvite)
    );
    // A MAC of another length, and bytes that are no Request.
    for mac in [vec![], vec![0; 31], vec![0; 33]] {
        let short = SignedRequest {
            mac,
            ..good.clone()
        };
        assert_eq!(
            inviter.accept(&key(1), &short, NOW).err(),
            Some(Error::BadFormat)
        );
    }
    let junk = SignedRequest {
        request: vec![1, 2, 3],
        ..good.clone()
    };
    assert_eq!(
        inviter.accept(&key(1), &junk, NOW).err(),
        Some(Error::BadFormat)
    );

    // None of this used the invite up.
    assert!(inviter.accept(&key(1), &good, NOW).is_ok());
}

#[test]
fn a_request_that_does_not_match_the_invite_is_refused() {
    let mut inviter = opened(Role::Human);
    let link = handed_over(&inviter);
    let (_, good) = requested(&inviter);
    // Whoever holds the link can make any Request with a valid MAC; each field is still compared.
    let remade = |change: &dyn Fn(&mut Request)| {
        let mut request = Request::decode(&good.request).expect("decodes");
        change(&mut request);
        let bytes = codec::encode(&request).expect("encodes");
        let mac = crypto::hmac_sha256(&mac_key(&link), &bytes)
            .expect("macs")
            .to_vec();
        let mut signed = SignedRequest {
            request: bytes,
            mac,
            signature: vec![],
        };
        signed.signature =
            crypto::sign_with_label(&key(2), SIGN_REQUEST, &request_with_mac(&signed))
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
            inviter.accept(&key(1), &remade(change), NOW).err(),
            Some(Error::BadInvite)
        );
    }
    // Signed by another key than the KeyPackage's: device 2 puts device 3's KeyPackage into its Request.
    let of_another = key_package(3);
    assert_eq!(
        inviter
            .accept(
                &key(1),
                &remade(&move |r| r.key_package = of_another.clone()),
                NOW
            )
            .err(),
        Some(Error::BadSignature)
    );
    // A KeyPackage that is none, or not the profile's.
    for bad in [b"no key package".to_vec(), foreign_key_package(2)] {
        assert_eq!(
            inviter
                .accept(&key(1), &remade(&move |r| r.key_package = bad.clone()), NOW)
                .err(),
            Some(Error::BadKeyPackage)
        );
    }
    let mut resigned = good.clone();
    resigned.signature =
        crypto::sign_with_label(&key(3), SIGN_REQUEST, &request_with_mac(&good)).expect("signs");
    assert_eq!(
        inviter.accept(&key(1), &resigned, NOW).err(),
        Some(Error::BadSignature)
    );
    // The signature covers the MAC: one over the Request alone is none.
    let mut unbound = good.clone();
    unbound.signature =
        crypto::sign_with_label(&key(2), SIGN_REQUEST, &good.request).expect("signs");
    assert_eq!(
        inviter.accept(&key(1), &unbound, NOW).err(),
        Some(Error::BadSignature)
    );
    assert!(inviter.accept(&key(1), &good, NOW).is_ok());
}

#[test]
fn an_invite_is_used_once() {
    let mut inviter = opened(Role::Human);
    let (_, first) = requested(&inviter);
    let accepted = inviter.accept(&key(1), &first, NOW).expect("accepts");
    // The same Request again, and another valid one of someone else who has the link.
    assert_eq!(
        inviter.accept(&key(1), &first, NOW).err(),
        Some(Error::InviteUsed)
    );
    let (_, second) = Joiner::request(
        &handed_over(&inviter),
        inviter.signed_offer(),
        &key(3),
        &key_package(3),
        NOW,
    )
    .expect("requests");
    assert_eq!(
        inviter.accept(&key(1), &second, NOW).err(),
        Some(Error::InviteUsed)
    );
    // After a restart the same Reveal and code are there again.
    assert_eq!(inviter.accepted(&key(1)), Ok(Some(accepted)));
    assert_eq!(opened(Role::Human).accepted(&key(1)), Ok(None));
}

#[test]
fn an_invite_expires_after_ten_minutes() {
    let mut inviter = opened(Role::Human);
    let (_, request) = requested(&inviter);
    assert_eq!(
        inviter
            .accept(&key(1), &request, NOW + INVITE_LIFE_MS + 1)
            .err(),
        Some(Error::InviteExpired)
    );
    assert!(inviter
        .accept(&key(1), &request, NOW + INVITE_LIFE_MS)
        .is_ok());
}

#[test]
fn the_code_is_confirmed_within_five_minutes() {
    let mut inviter = opened(Role::Human);
    let (_, request) = requested(&inviter);
    let at = NOW + 1_000;
    let accepted = inviter.accept(&key(1), &request, at).expect("accepts");
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

    let (_, request) = requested(&inviter);
    let accepted = inviter.accept(&key(1), &request, NOW).expect("accepts");
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
    let (_, request) = requested(&inviter);
    let accepted = inviter.accept(&key(1), &request, NOW).expect("accepts");
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
        inviter.accept(&key(1), &request, NOW).err(),
        Some(Error::InviteBurned)
    );
    // Nor does it stand for another invite.
    let mut other = opened(Role::Human);
    assert_eq!(other.check_confirmed(&confirmed), Err(Error::BadInvite));
    let (_, other_request) = requested(&other);
    other.accept(&key(1), &other_request, NOW).expect("accepts");
    assert_eq!(
        other.check_confirmed(&confirmed),
        Err(Error::CodeNotConfirmed)
    );
    assert_eq!(inviter.accepted(&key(1)), Ok(None));
    assert_eq!(inviter.finish(), Err(Error::BadInvite));

    // Burned before any Request, too.
    let mut unused = opened(Role::Human);
    let (_, request) = requested(&unused);
    unused.burn();
    assert_eq!(
        unused.accept(&key(1), &request, NOW).err(),
        Some(Error::InviteBurned)
    );
}

#[test]
fn a_substituted_key_package_changes_the_code() {
    // Someone who also has the link answers first, with a KeyPackage of its own.
    let mut inviter = opened(Role::Human);
    let (joiner, _honest) = requested(&inviter);
    let (_, intruder) = Joiner::request(
        &handed_over(&inviter),
        inviter.signed_offer(),
        &key(3),
        &key_package(3),
        NOW,
    )
    .expect("requests");
    let accepted = inviter.accept(&key(1), &intruder, NOW).expect("accepts");
    // The honest device sees that the inviter answered another Request.
    assert_eq!(joiner.reveal(&accepted.reveal), Err(Error::BadInvite));
    // And the code the inviter shows is not the one of the honest Request with the same nonce.
    let reveal = Reveal::decode(&accepted.reveal.reveal).expect("decodes");
    let honest_code = check_code(
        &inviter.signed_offer().offer,
        joiner.signed_request(),
        &reveal.nonce,
    );
    assert_ne!(honest_code, accepted.code);
}

#[test]
fn the_code_covers_every_part() {
    let inviter = opened(Role::Human);
    let (_, request) = requested(&inviter);
    let offer = inviter.signed_offer().offer.clone();
    let nonce = [4u8; 32];
    let code = check_code(&offer, &request, &nonce);
    assert_eq!(check_code(&offer, &request, &nonce), code);

    let mut other_offer = offer.clone();
    other_offer[100] ^= 1;
    assert_ne!(check_code(&other_offer, &request, &nonce), code);
    let (_, other_request) = requested(&inviter);
    assert_ne!(check_code(&offer, &other_request, &nonce), code);
    let mut other_mac = request.clone();
    other_mac.mac[5] ^= 1;
    assert_ne!(check_code(&offer, &other_mac, &nonce), code);
    assert_ne!(check_code(&offer, &request, &[5u8; 32]), code);
    // The signature is no part of it.
    let mut other_signature = request.clone();
    other_signature.signature[0] ^= 1;
    assert_eq!(check_code(&offer, &other_signature, &nonce), code);
}

#[test]
fn the_new_device_refuses_a_reveal_that_is_not_its_invites() {
    let mut inviter = opened(Role::Human);
    let (joiner, request) = requested(&inviter);
    let accepted = inviter.accept(&key(1), &request, NOW).expect("accepts");
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
    let (_, request) = requested(&inviter);
    assert!(matches!(
        inviter.accept(&key(4), &request, NOW),
        Err(Error::Internal(_))
    ));
    // The refused call left the invite open.
    assert!(inviter.accept(&key(1), &request, NOW).is_ok());
}

#[test]
fn an_inviter_goes_through_the_store_in_every_state() {
    let mut inviter = opened(Role::Agent);
    let (_, request) = requested(&inviter);
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
    let accepted = open.accept(&key(1), &request, NOW).expect("accepts");
    inviter.accept(&key(1), &request, NOW).expect("accepts");

    // Accepted: the restored invite reveals the same and confirms, and stays used.
    let mut held = restored(&inviter);
    assert_eq!(held.accepted(&key(1)), Ok(Some(accepted.clone())));
    assert!(held
        .confirm(&accepted.code, &accepted.request_hash, NOW)
        .is_ok());
    assert_eq!(
        held.accept(&key(1), &request, NOW).err(),
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
    let (_, request) = requested(&inviter);
    let open = inviter.to_stored().expect("stores").expose().to_vec();
    inviter.accept(&key(1), &request, NOW).expect("accepts");
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
    let (joiner, request) = requested(&inviter);
    let stored = joiner.to_stored().expect("stores");
    let back = Joiner::from_stored(&stored).expect("restores");
    assert_eq!(back, joiner);
    assert_eq!(back.signed_request(), &request);
    assert_eq!(back.offer().inviter, device(1));
    assert_eq!(back.offer().room_epoch, 5);
    assert_eq!(back.offer().room_state, Hash32::new([0x55; 32]));

    let accepted = inviter.accept(&key(1), &request, NOW).expect("accepts");
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
    let (other_joiner, _) = requested(&other);
    let stored_with = |request: &SignedRequest| {
        let mut writer = Writer::new();
        writer.u8(1);
        writer
            .opaque(&inviter.signed_offer().offer)
            .expect("writes");
        writer
            .opaque(&inviter.signed_offer().signature)
            .expect("writes");
        writer.opaque(&request.request).expect("writes");
        writer.opaque(&request.mac).expect("writes");
        writer.opaque(&request.signature).expect("writes");
        writer.into_bytes()
    };
    assert_eq!(stored_with(joiner.signed_request()), stored);
    assert_eq!(
        Joiner::from_stored(&stored_with(other_joiner.signed_request())).err(),
        Some(Error::BadFormat)
    );
}

#[test]
fn the_hub_checks_what_it_can() {
    let mut inviter = opened(Role::Human);
    let offer = inviter.signed_offer().clone();
    let (_, request) = requested(&inviter);

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

    // Request: for this Offer, this hub, with a KeyPackage that verifies, signed by that KeyPackage's key.
    // The hub learns the new device from the KeyPackage and from nothing else.
    assert_eq!(hub_check_request(&offer, &request, &hub()), Ok(device(2)));
    let with_key_package = |key_package: Vec<u8>, signer: u8| {
        let mut changed = Request::decode(&request.request).expect("decodes");
        changed.key_package = key_package;
        let mut signed = SignedRequest {
            request: codec::encode(&changed).expect("encodes"),
            mac: request.mac.clone(),
            signature: vec![],
        };
        signed.signature =
            crypto::sign_with_label(&key(signer), SIGN_REQUEST, &request_with_mac(&signed))
                .expect("signs");
        signed
    };
    assert_eq!(
        hub_check_request(&offer, &with_key_package(key_package(3), 2), &hub()).err(),
        Some(Error::BadSignature)
    );
    assert_eq!(
        hub_check_request(&offer, &with_key_package(key_package(3), 3), &hub()),
        Ok(device(3))
    );
    for bad in [b"kp".to_vec(), foreign_key_package(2)] {
        assert_eq!(
            hub_check_request(&offer, &with_key_package(bad, 2), &hub()).err(),
            Some(Error::BadKeyPackage)
        );
    }
    let elsewhere = HubAddress::parse("https://hub.example.com").expect("canonical");
    assert_eq!(
        hub_check_request(&offer, &request, &elsewhere).err(),
        Some(Error::BadInvite)
    );
    let other = opened(Role::Human);
    assert_eq!(
        hub_check_request(other.signed_offer(), &request, &hub()).err(),
        Some(Error::BadInvite)
    );
    let short_mac = SignedRequest {
        mac: vec![0; 16],
        ..request.clone()
    };
    assert_eq!(
        hub_check_request(&offer, &short_mac, &hub()).err(),
        Some(Error::BadFormat)
    );
    // The MAC is beyond the hub: a Request whose MAC is wrong but which is signed over that MAC passes
    // here, and is refused by the inviter.
    let mut unkeyed = request.clone();
    unkeyed.mac = vec![0; 32];
    unkeyed.signature =
        crypto::sign_with_label(&key(2), SIGN_REQUEST, &request_with_mac(&unkeyed)).expect("signs");
    assert!(hub_check_request(&offer, &unkeyed, &hub()).is_ok());
    assert_eq!(
        inviter.accept(&key(1), &unkeyed, NOW).err(),
        Some(Error::BadInvite)
    );

    // Reveal: signed by the inviter, opening the commitment, naming a Request the hub holds.
    let accepted = inviter.accept(&key(1), &request, NOW).expect("accepts");
    let held = [unkeyed.clone(), request.clone()];
    let revealed = hub_check_reveal(&offer, &accepted.reveal, &held).expect("checks");
    assert_eq!(*revealed.inviter(), device(1));
    assert_eq!(revealed.role(), Role::Human);
    assert_eq!(
        revealed.key_package(),
        Request::decode(&request.request)
            .expect("decodes")
            .key_package
    );
    assert_eq!(revealed.new_device(), &device(2));
    assert_eq!(*revealed.request_hash(), accepted.request_hash);
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
    assert_eq!(
        revealed.key_package(),
        Request::decode(&request.request)
            .expect("decodes")
            .key_package
    );
    assert_eq!(revealed.new_device(), &device(2));
    assert_eq!(revealed.request_hash(), &accepted.request_hash);
    // A Request longer than one can be is refused before anything is copied or hashed.
    let huge = SignedRequest {
        request: vec![0; MAX_REQUEST_LEN + 1],
        ..request.clone()
    };
    assert_eq!(request_hash(&huge), Err(Error::BadFormat));
    assert_eq!(
        hub_check_request(&offer, &huge, &hub()).err(),
        Some(Error::BadFormat)
    );
    // A Request the hub holds for another Offer names that Offer, whatever a Reveal says of its hash.
    let (_, elsewhere_request) = requested(&other);
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
