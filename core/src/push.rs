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
use zeroize::Zeroizing;

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

fn to_json<T: Serialize>(value: &T) -> Result<Vec<u8>, Error> {
    serde_json::to_vec(value).map_err(|_| Error::Internal("push json"))
}

/// Parses `bytes` as `T` and accepts it only if writing `T` again gives the same bytes.
fn from_json<T: Serialize + for<'a> Deserialize<'a>>(bytes: &[u8]) -> Result<T, Error> {
    let value: T = serde_json::from_slice(bytes).map_err(|_| Error::BadFormat)?;
    if to_json(&value)? != bytes {
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
        to_json(&ApnsPushJson {
            room_id: self.room_id.to_base64url(),
            change: self.change,
            urgency: self.urgency,
            ticket: ids::base64url_encode(&self.ticket),
        })
    }

    fn decode(bytes: &[u8]) -> Result<Self, Error> {
        let json: ApnsPushJson = from_json(bytes)?;
        check_numbers(json.change, json.urgency)?;
        let ticket = ids::base64url_decode(&json.ticket)?;
        if ticket.len() > MAX_TICKET_LEN {
            return Err(Error::BadFormat);
        }
        Ok(Self {
            room_id: RoomId::from_base64url(&json.room_id)?,
            change: json.change,
            urgency: json.urgency,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::SystemEntropy;

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
        let json = crypto::aead_open(&key(1), &[0x42; NONCE_LEN], b"trommi apns v2", ciphertext)
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
        let json = push().encode().expect("encodes");
        let other = crypto::aead_seal(&key(1), &nonce, b"trommi apns v1", &json).expect("seals");
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
            format!(
                r#"{{"room_id":"{ROOM_TEXT}","change":1,"urgency":1,"ticket":"AQ","title":"x"}}"#
            ),
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
}
