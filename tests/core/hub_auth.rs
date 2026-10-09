//! Signing in to the hub (section 12.3): the signed challenge, on the device and at the hub.

use trommi_core::codec;
use trommi_core::crypto::{self, Entropy, Secret, SigningKey, SystemEntropy};
use trommi_core::hub_auth::*;
use trommi_core::ids::{DeviceId, RoomId};
use trommi_core::Error;

/// The longest encoded sign-in: the three fixed fields, and the address behind its two-byte length.
const MAX_AUTH_LEN: usize = 32 + 2 + MAX_ADDRESS_LEN + 32 + 32;

fn is_canonical_origin(text: &str) -> bool {
    HubAddress::parse(text).is_ok()
}

fn key(seed: u8) -> SigningKey {
    SigningKey::from_seed(Secret::new([seed; 32]))
}

fn hub() -> HubAddress {
    HubAddress::parse("https://hub.example.org").expect("canonical")
}

const ROOM: RoomId = RoomId::new([7; 32]);

fn issued() -> IssuedChallenge {
    IssuedChallenge {
        challenge: [9; 32],
        expires_at: 1_000 + CHALLENGE_LIFE_MS,
    }
}

#[test]
fn canonical_addresses_are_exactly_the_pattern() {
    for good in [
        "https://hub.example.org",
        "https://a",
        "https://a.b-c.d:1",
        "https://xn--mller-kva.example:65535",
        "https://1.2.3.4:99999",
        "https://a--b.example",
        "http://localhost",
        "http://localhost:8787",
        "http://127.0.0.1:3000",
        "https://localhost",
    ] {
        assert!(is_canonical_origin(good), "{good}");
        assert_eq!(HubAddress::parse(good).expect("canonical").as_str(), good);
    }
    for bad in [
        "",
        "https://",
        "http://",
        "hub.example.org",
        "https://Hub.example.org",
        "HTTPS://hub.example.org",
        "https://hub.example.org/",
        "https://hub.example.org/path",
        "https://hub.example.org?x",
        "https://hub.example.org#x",
        "https://hub.example.org:",
        "https://hub.example.org:0",
        "https://hub.example.org:01",
        "https://hub.example.org:123456",
        "https://hub.example.org:12a",
        "https://hub.example.org:1:2",
        "https://hub..example.org",
        "https://.example.org",
        "https://example.org.",
        "https://-a.example",
        "https://a-.example",
        "https://a_b.example",
        "https://user@hub.example.org",
        "https://[::1]",
        "https://hub.example.org ",
        " https://hub.example.org",
        "https://hub.example.org\n",
        "https://hüb.example.org",
        "http://hub.example.org",
        "http://localhost.",
        "http://127.0.0.2",
        "http://LOCALHOST",
        "ftp://localhost",
        "https:/hub.example.org",
    ] {
        assert!(!is_canonical_origin(bad), "{bad:?}");
        assert_eq!(HubAddress::parse(bad), Err(Error::BadFormat), "{bad:?}");
    }
}

#[test]
fn an_address_has_a_longest_length() {
    let prefix = "https://";
    let longest = format!("{prefix}{}", "a".repeat(MAX_ADDRESS_LEN - prefix.len()));
    assert!(HubAddress::parse(&longest).is_ok());
    assert_eq!(
        HubAddress::parse(&format!("{longest}a")),
        Err(Error::BadFormat)
    );
    assert_eq!(HubAddress::from_bytes(&[0xff, 0xfe]), Err(Error::BadFormat));
}

#[test]
fn hub_auth_encodes_as_the_struct_says() {
    let auth = HubAuth {
        room_id: ROOM,
        hub: HubAddress::parse("https://a").expect("canonical"),
        device: DeviceId::new([3; 32]),
        challenge: [9; 32],
    };
    let bytes = codec::encode(&auth).expect("encodes");
    let mut expected = vec![7u8; 32];
    expected.push(9);
    expected.extend_from_slice(b"https://a");
    expected.extend_from_slice(&[3; 32]);
    expected.extend_from_slice(&[9; 32]);
    assert_eq!(bytes, expected);
    assert_eq!(HubAuth::decode(&bytes), Ok(auth));
}

#[test]
fn a_device_signs_in() {
    let device = key(1);
    let signed = sign(&device, ROOM, &hub(), [9; 32]).expect("signs");
    assert_eq!(
        verify(&signed, &ROOM, &hub(), &issued(), 1_000),
        Ok(DeviceId::new(device.public()))
    );
    assert_eq!(
        verify(&signed, &ROOM, &hub(), &issued(), issued().expires_at),
        Ok(DeviceId::new(device.public()))
    );
}

#[test]
fn the_recovery_signature_key_signs_in_like_a_device() {
    let code = Secret::new([5; 32]);
    let seed =
        crypto::expand_with_label::<32>(&code, "trommi recovery sign", &[]).expect("derives");
    let recovery = SigningKey::from_seed(seed);
    let signed = sign(&recovery, ROOM, &hub(), [9; 32]).expect("signs");
    assert_eq!(
        verify(&signed, &ROOM, &hub(), &issued(), 1_000),
        Ok(DeviceId::new(recovery.public()))
    );
}

#[test]
fn a_sign_in_for_another_hub_is_refused() {
    let other = HubAddress::parse("https://hub.example.com").expect("canonical");
    let signed = sign(&key(1), ROOM, &other, [9; 32]).expect("signs");
    assert_eq!(
        verify(&signed, &ROOM, &hub(), &issued(), 1_000),
        Err(Error::Unauthorised)
    );
}

#[test]
fn a_sign_in_for_another_room_is_refused() {
    let signed = sign(&key(1), RoomId::new([8; 32]), &hub(), [9; 32]).expect("signs");
    assert_eq!(
        verify(&signed, &ROOM, &hub(), &issued(), 1_000),
        Err(Error::WrongRoom)
    );
}

#[test]
fn another_or_an_old_challenge_is_refused() {
    let signed = sign(&key(1), ROOM, &hub(), [8; 32]).expect("signs");
    assert_eq!(
        verify(&signed, &ROOM, &hub(), &issued(), 1_000),
        Err(Error::BadChallenge)
    );
    let signed = sign(&key(1), ROOM, &hub(), [9; 32]).expect("signs");
    assert_eq!(
        verify(&signed, &ROOM, &hub(), &issued(), issued().expires_at + 1),
        Err(Error::BadChallenge)
    );
}

#[test]
fn a_signature_of_another_key_or_over_other_bytes_is_refused() {
    let signed = sign(&key(1), ROOM, &hub(), [9; 32]).expect("signs");

    let by_another = SignedHubAuth {
        auth: signed.auth.clone(),
        signature: sign(&key(2), ROOM, &hub(), [9; 32])
            .expect("signs")
            .signature,
    };
    assert_eq!(
        verify(&by_another, &ROOM, &hub(), &issued(), 1_000),
        Err(Error::BadSignature)
    );

    // The same fields under another device id: the signature is not that key's.
    let mut auth = HubAuth::decode(&signed.auth).expect("decodes");
    auth.device = DeviceId::new(key(2).public());
    let renamed = SignedHubAuth {
        auth: codec::encode(&auth).expect("encodes"),
        signature: signed.signature.clone(),
    };
    assert_eq!(
        verify(&renamed, &ROOM, &hub(), &issued(), 1_000),
        Err(Error::BadSignature)
    );

    for signature in [vec![], vec![0; 63], vec![0; 64], vec![0; 65]] {
        let forged = SignedHubAuth {
            auth: signed.auth.clone(),
            signature,
        };
        assert_eq!(
            verify(&forged, &ROOM, &hub(), &issued(), 1_000),
            Err(Error::BadSignature)
        );
    }
}

#[test]
fn a_signature_under_another_label_is_refused() {
    let device = key(1);
    let signed = sign(&device, ROOM, &hub(), [9; 32]).expect("signs");
    let relabelled = SignedHubAuth {
        signature: crypto::sign_with_label(&device, "TrommiInviteOffer", &signed.auth)
            .expect("signs"),
        auth: signed.auth,
    };
    assert_eq!(
        verify(&relabelled, &ROOM, &hub(), &issued(), 1_000),
        Err(Error::BadSignature)
    );
}

#[test]
fn malformed_sign_ins_are_refused_without_a_panic() {
    let signed = sign(&key(1), ROOM, &hub(), [9; 32]).expect("signs");
    for cut in 0..signed.auth.len() {
        let truncated = SignedHubAuth {
            auth: signed.auth.get(..cut).expect("in range").to_vec(),
            signature: signed.signature.clone(),
        };
        assert_eq!(
            verify(&truncated, &ROOM, &hub(), &issued(), 1_000),
            Err(Error::BadFormat)
        );
    }
    let mut trailing = signed.clone();
    trailing.auth.push(0);
    assert_eq!(
        verify(&trailing, &ROOM, &hub(), &issued(), 1_000),
        Err(Error::BadFormat)
    );

    // An address that is not canonical does not decode, whoever signed it.
    let mut bytes = vec![7u8; 32];
    bytes.push(10);
    bytes.extend_from_slice(b"https://a/");
    bytes.extend_from_slice(&key(1).public());
    bytes.extend_from_slice(&[9; 32]);
    assert_eq!(HubAuth::decode(&bytes), Err(Error::BadFormat));

    let oversize = SignedHubAuth {
        auth: vec![0; MAX_AUTH_LEN + 1],
        signature: vec![0; 64],
    };
    assert_eq!(HubAuth::decode(&oversize.auth), Err(Error::TooLarge));
    assert_eq!(
        verify(&oversize, &ROOM, &hub(), &issued(), 1_000),
        Err(Error::BadFormat)
    );
}

#[test]
fn a_challenge_is_fresh_random_bytes_with_two_minutes() {
    let a = IssuedChallenge::issue(&mut SystemEntropy, 5).expect("entropy");
    let b = IssuedChallenge::issue(&mut SystemEntropy, 5).expect("entropy");
    assert_ne!(a.challenge, b.challenge);
    assert_eq!(a.expires_at, 5 + 120_000);
    assert_eq!(
        IssuedChallenge::issue(&mut SystemEntropy, u64::MAX)
            .expect("entropy")
            .expires_at,
        u64::MAX
    );

    struct NoEntropy;
    impl Entropy for NoEntropy {
        fn fill(&mut self, _: &mut [u8]) -> Result<(), Error> {
            Err(Error::Entropy)
        }
    }
    assert_eq!(
        IssuedChallenge::issue(&mut NoEntropy, 5),
        Err(Error::Entropy)
    );
}
