//! The push payload (section 15.2): sealed to a device's push key, opened by it alone.

use trommi_core::crypto::{self, Entropy, Secret, SystemEntropy, NONCE_LEN, TAG_LEN};
use trommi_core::ids::RoomId;
use trommi_core::push::*;
use trommi_core::Error;

/// The associated data of the APNs sealing.
const APNS_AAD: &[u8] = b"trommi apns v1";

const ROOM: RoomId = RoomId::new([0xA7; 32]);
const ROOM_TEXT: &str = "p6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp6c";

fn key(byte: u8) -> Secret<32> {
    Secret::new([byte; 32])
}

fn push() -> ApnsPush {
    ApnsPush {
        room_id: ROOM,
        change: 4_711,
        urgency: 2,
        ticket: vec![1, 2, 3, 4, 5],
    }
}

/// An entropy source that hands out one fixed byte.
struct Fixed(u8);
impl Entropy for Fixed {
    fn fill(&mut self, out: &mut [u8]) -> Result<(), Error> {
        out.fill(self.0);
        Ok(())
    }
}

struct NoEntropy;
impl Entropy for NoEntropy {
    fn fill(&mut self, _: &mut [u8]) -> Result<(), Error> {
        Err(Error::Entropy)
    }
}

#[test]
fn web_push_is_the_three_fields_in_one_spelling() {
    let payload = WebPush {
        room_id: ROOM,
        change: 4_711,
        urgency: 3,
    };
    let bytes = payload.encode().expect("encodes");
    assert_eq!(
        String::from_utf8(bytes.clone()).expect("utf-8"),
        format!(r#"{{"room_id":"{ROOM_TEXT}","change":4711,"urgency":3}}"#)
    );
    assert_eq!(WebPush::decode(&bytes), Ok(payload));
}

#[test]
fn web_push_holds_the_largest_values_within_its_bound() {
    let payload = WebPush {
        room_id: RoomId::new([0xff; 32]),
        change: MAX_CHANGE,
        urgency: MAX_URGENCY,
    };
    let bytes = payload.encode().expect("encodes");
    assert!(bytes.len() <= MAX_WEB_PUSH_LEN);
    assert_eq!(WebPush::decode(&bytes), Ok(payload));
}

#[test]
fn web_push_refuses_values_out_of_range() {
    let mut payload = WebPush {
        room_id: ROOM,
        change: MAX_CHANGE + 1,
        urgency: 0,
    };
    assert_eq!(payload.encode(), Err(Error::BadFormat));
    payload.change = 0;
    payload.urgency = 4;
    assert_eq!(payload.encode(), Err(Error::BadFormat));
}

#[test]
fn web_push_refuses_every_other_text() {
    let good = format!(r#"{{"room_id":"{ROOM_TEXT}","change":1,"urgency":1}}"#);
    assert!(WebPush::decode(good.as_bytes()).is_ok());
    let cases = [
        String::new(),
        "null".into(),
        "[]".into(),
        "{}".into(),
        format!(r#"{{"room_id":"{ROOM_TEXT}","change":1}}"#),
        format!(r#"{{"room_id":"{ROOM_TEXT}","urgency":1,"change":1}}"#),
        format!(r#"{{"room_id":"{ROOM_TEXT}","change":1,"urgency":1,"title":"x"}}"#),
        format!(r#"{{"room_id":"{ROOM_TEXT}","change":1,"urgency":1,"urgency":1}}"#),
        format!(r#"{{"room_id":"{ROOM_TEXT}","change":1,"urgency":1}} "#),
        format!(r#"{{ "room_id":"{ROOM_TEXT}","change":1,"urgency":1}}"#),
        format!(r#"{{"room_id":"{ROOM_TEXT}","change":1.0,"urgency":1}}"#),
        format!(r#"{{"room_id":"{ROOM_TEXT}","change":1e0,"urgency":1}}"#),
        format!(r#"{{"room_id":"{ROOM_TEXT}","change":01,"urgency":1}}"#),
        format!(r#"{{"room_id":"{ROOM_TEXT}","change":-1,"urgency":1}}"#),
        format!(r#"{{"room_id":"{ROOM_TEXT}","change":"1","urgency":1}}"#),
        format!(r#"{{"room_id":"{ROOM_TEXT}","change":9007199254740992,"urgency":1}}"#),
        format!(r#"{{"room_id":"{ROOM_TEXT}","change":1,"urgency":4}}"#),
        format!(r#"{{"room_id":"{ROOM_TEXT}","change":1,"urgency":256}}"#),
        format!(r#"{{"room_id":"{ROOM_TEXT}=","change":1,"urgency":1}}"#),
        format!(
            r#"{{"room_id":"{}","change":1,"urgency":1}}"#,
            &ROOM_TEXT[1..]
        ),
        r#"{"room_id":"","change":1,"urgency":1}"#.into(),
        r#"{"room_id":7,"change":1,"urgency":1}"#.into(),
        // The same text with its first letter written as an escape.
        good.replacen("\"p", &format!("\"{}u0070", '\\'), 1),
    ];
    for case in cases {
        assert_eq!(
            WebPush::decode(case.as_bytes()),
            Err(Error::BadFormat),
            "{case}"
        );
    }
    assert_eq!(
        WebPush::decode(&[b' '; MAX_WEB_PUSH_LEN + 1]),
        Err(Error::TooLarge)
    );
    assert_eq!(WebPush::decode(&[0xff, 0xfe]), Err(Error::BadFormat));
}

#[test]
fn apns_seals_and_opens() {
    let sealed = seal(&key(1), &push(), &mut SystemEntropy).expect("seals");
    assert_eq!(open(&key(1), &sealed), Ok(push()));
    let printed = format!("{:?}", open(&key(1), &sealed));
    assert!(printed.contains("redacted") && printed.contains("4711"));
    assert!(!printed.contains("[1, 2, 3"));

    let empty_ticket = ApnsPush {
        ticket: vec![],
        ..push()
    };
    let sealed = seal(&key(1), &empty_ticket, &mut SystemEntropy).expect("seals");
    assert_eq!(open(&key(1), &sealed), Ok(empty_ticket));
}

#[test]
fn apns_is_nonce_then_the_suites_aead_over_the_json() {
    let sealed = seal(&key(1), &push(), &mut Fixed(0x42)).expect("seals");
    let (nonce, ciphertext) = sealed.split_at(NONCE_LEN);
    assert_eq!(nonce, [0x42; NONCE_LEN]);
    let json = crypto::aead_open(&key(1), &[0x42; NONCE_LEN], b"trommi apns v1", ciphertext)
        .expect("opens");
    assert_eq!(
        String::from_utf8(json).expect("utf-8"),
        format!(r#"{{"room_id":"{ROOM_TEXT}","change":4711,"urgency":2,"ticket":"AQIDBAU"}}"#)
    );
}

#[test]
fn apns_takes_a_fresh_nonce_each_time() {
    let a = seal(&key(1), &push(), &mut SystemEntropy).expect("seals");
    let b = seal(&key(1), &push(), &mut SystemEntropy).expect("seals");
    assert_ne!(a, b);
    assert_eq!(seal(&key(1), &push(), &mut NoEntropy), Err(Error::Entropy));
}

#[test]
fn apns_holds_the_longest_payload_within_its_bound() {
    let longest = ApnsPush {
        room_id: RoomId::new([0xff; 32]),
        change: MAX_CHANGE,
        urgency: MAX_URGENCY,
        ticket: vec![0xff; MAX_TICKET_LEN],
    };
    let sealed = seal(&key(1), &longest, &mut SystemEntropy).expect("seals");
    assert!(sealed.len() <= MAX_APNS_LEN);
    assert_eq!(open(&key(1), &sealed), Ok(longest));
}

#[test]
fn apns_refuses_to_seal_what_is_out_of_range() {
    let too_long = ApnsPush {
        ticket: vec![0; MAX_TICKET_LEN + 1],
        ..push()
    };
    assert_eq!(
        seal(&key(1), &too_long, &mut SystemEntropy),
        Err(Error::TooLarge)
    );
    let urgent = ApnsPush {
        urgency: 4,
        ..push()
    };
    assert_eq!(
        seal(&key(1), &urgent, &mut SystemEntropy),
        Err(Error::BadFormat)
    );
    let late = ApnsPush {
        change: MAX_CHANGE + 1,
        ..push()
    };
    assert_eq!(
        seal(&key(1), &late, &mut SystemEntropy),
        Err(Error::BadFormat)
    );
}

#[test]
fn apns_does_not_open_under_another_key() {
    let sealed = seal(&key(1), &push(), &mut SystemEntropy).expect("seals");
    assert_eq!(open(&key(2), &sealed), Err(Error::DecryptFailed));
}

#[test]
fn apns_does_not_open_when_any_bit_changed() {
    let sealed = seal(&key(1), &push(), &mut SystemEntropy).expect("seals");
    for at in 0..sealed.len() {
        let mut tampered = sealed.clone();
        if let Some(byte) = tampered.get_mut(at) {
            *byte ^= 1;
        }
        assert_eq!(open(&key(1), &tampered), Err(Error::DecryptFailed), "{at}");
    }
}

#[test]
fn apns_does_not_open_what_was_sealed_for_another_use() {
    let nonce = [7; NONCE_LEN];
    // The JSON as the hub seals it, taken out of a sealed notification.
    let sealed = seal(&key(1), &push(), &mut SystemEntropy).expect("seals");
    let (first, ciphertext) = sealed.split_first_chunk::<NONCE_LEN>().expect("a nonce");
    let json = crypto::aead_open(&key(1), first, APNS_AAD, ciphertext).expect("opens");
    let other = crypto::aead_seal(&key(1), &nonce, b"trommi apns v2", &json).expect("seals");
    assert_eq!(
        open(&key(1), &[nonce.as_slice(), &other].concat()),
        Err(Error::DecryptFailed)
    );
}

#[test]
fn apns_refuses_every_length_that_cannot_be_a_payload() {
    let sealed = seal(&key(1), &push(), &mut SystemEntropy).expect("seals");
    for len in 0..NONCE_LEN + TAG_LEN {
        let short = sealed.get(..len).expect("in range");
        assert_eq!(open(&key(1), short), Err(Error::BadFormat), "{len}");
    }
    for len in NONCE_LEN + TAG_LEN..sealed.len() {
        let cut = sealed.get(..len).expect("in range");
        assert_eq!(open(&key(1), cut), Err(Error::DecryptFailed), "{len}");
    }
    assert_eq!(
        open(&key(1), &vec![0; MAX_APNS_LEN + 1]),
        Err(Error::TooLarge)
    );
}

#[test]
fn apns_refuses_an_authentic_payload_of_another_shape() {
    let nonce = [7; NONCE_LEN];
    let cases = [
        String::new(),
        "{}".into(),
        format!(r#"{{"room_id":"{ROOM_TEXT}","change":1,"urgency":1}}"#),
        format!(r#"{{"room_id":"{ROOM_TEXT}","change":1,"urgency":1,"ticket":"AQ","title":"x"}}"#),
        format!(r#"{{"room_id":"{ROOM_TEXT}","change":1,"urgency":1,"ticket":"AQ=="}}"#),
        format!(r#"{{"room_id":"{ROOM_TEXT}","change":1,"urgency":1,"ticket":"AR"}}"#),
        format!(r#"{{"room_id":"{ROOM_TEXT}","change":1,"urgency":1,"ticket":null}}"#),
        format!(r#"{{"room_id":"{ROOM_TEXT}","change":1,"urgency":9,"ticket":"AQ"}}"#),
        format!(r#"{{"room_id":"{ROOM_TEXT}", "change":1,"urgency":1,"ticket":"AQ"}}"#),
        format!(r#"{{"ticket":"AQ","room_id":"{ROOM_TEXT}","change":1,"urgency":1}}"#),
    ];
    for case in cases {
        let ciphertext =
            crypto::aead_seal(&key(1), &nonce, APNS_AAD, case.as_bytes()).expect("seals");
        assert_eq!(
            open(&key(1), &[nonce.as_slice(), &ciphertext].concat()),
            Err(Error::BadFormat),
            "{case}"
        );
    }
}

#[test]
fn a_registration_key_is_fresh_random_bytes() {
    let a = generate_key(&mut SystemEntropy).expect("entropy");
    let b = generate_key(&mut SystemEntropy).expect("entropy");
    assert_ne!(a.expose(), b.expose());
    assert_eq!(generate_key(&mut NoEntropy).err(), Some(Error::Entropy));
    assert!(format!("{a:?}").contains("redacted"));
}
