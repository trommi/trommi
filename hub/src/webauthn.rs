//! Passkeys: the part of WebAuthn the hub needs to check a registration and a sign-in (spec/v1.md §16.7). The hub
//! is the relying party's server: it checks the challenge, the origin, the relying-party id, user presence and
//! verification, and the assertion's signature under the stored public key. The attestation statement is not
//! verified (the account does not depend on which authenticator it is). The prf output never reaches the hub.

use p256::ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::util::{same, unb64};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bad(pub &'static str);

// ---- a minimal CBOR reader: definite lengths, small depth, what authenticators emit

#[derive(Debug, Clone, PartialEq)]
pub enum Cbor {
    Int(i64),
    Bytes(Vec<u8>),
    Text(String),
    Array(Vec<Cbor>),
    Map(Vec<(Cbor, Cbor)>),
    Bool(bool),
    Null,
}

impl Cbor {
    pub fn get_int(&self, key: i64) -> Option<&Cbor> {
        match self {
            Cbor::Map(m) => m.iter().find(|(k, _)| *k == Cbor::Int(key)).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn get_text(&self, key: &str) -> Option<&Cbor> {
        match self {
            Cbor::Map(m) => m
                .iter()
                .find(|(k, _)| matches!(k, Cbor::Text(t) if t == key))
                .map(|(_, v)| v),
            _ => None,
        }
    }
}

/// One CBOR item from the front of `bytes`; returns it and how many bytes it took.
pub fn cbor(bytes: &[u8]) -> Result<(Cbor, usize), Bad> {
    let mut at = 0;
    let item = cbor_item(bytes, &mut at, 0)?;
    Ok((item, at))
}

fn cbor_item(b: &[u8], at: &mut usize, depth: usize) -> Result<Cbor, Bad> {
    const BAD: Bad = Bad("cbor");
    if depth > 8 {
        return Err(BAD);
    }
    let first = *b.get(*at).ok_or(BAD)?;
    *at += 1;
    let (major, info) = (first >> 5, first & 0x1f);
    let mut take = |n: usize| -> Result<&[u8], Bad> {
        let end = at.checked_add(n).ok_or(BAD)?;
        let s = b.get(*at..end).ok_or(BAD)?;
        *at = end;
        Ok(s)
    };
    let argument: u64 = match info {
        0..=23 => u64::from(info),
        24 => u64::from(take(1)?[0]),
        25 => u64::from(u16::from_be_bytes(take(2)?.try_into().map_err(|_| BAD)?)),
        26 => u64::from(u32::from_be_bytes(take(4)?.try_into().map_err(|_| BAD)?)),
        27 => u64::from_be_bytes(take(8)?.try_into().map_err(|_| BAD)?),
        // indefinite lengths and reserved values
        _ => return Err(BAD),
    };
    if argument > (1 << 53) {
        return Err(BAD);
    }
    match major {
        0 => Ok(Cbor::Int(argument as i64)),
        1 => Ok(Cbor::Int(-1 - argument as i64)),
        2 => Ok(Cbor::Bytes(take(argument as usize)?.to_vec())),
        3 => Ok(Cbor::Text(
            String::from_utf8(take(argument as usize)?.to_vec()).map_err(|_| BAD)?,
        )),
        4 => {
            if argument > 64 {
                return Err(BAD);
            }
            let mut items = Vec::new();
            for _ in 0..argument {
                items.push(cbor_item(b, at, depth + 1)?);
            }
            Ok(Cbor::Array(items))
        }
        5 => {
            if argument > 64 {
                return Err(BAD);
            }
            let mut items: Vec<(Cbor, Cbor)> = Vec::new();
            for _ in 0..argument {
                let k = cbor_item(b, at, depth + 1)?;
                if !matches!(k, Cbor::Int(_) | Cbor::Text(_))
                    || items.iter().any(|(held, _)| *held == k)
                {
                    return Err(BAD);
                }
                let v = cbor_item(b, at, depth + 1)?;
                items.push((k, v));
            }
            Ok(Cbor::Map(items))
        }
        7 => match info {
            20 => Ok(Cbor::Bool(false)),
            21 => Ok(Cbor::Bool(true)),
            22 => Ok(Cbor::Null),
            _ => Err(BAD),
        },
        _ => Err(BAD),
    }
}

// ---- keys

pub const ES256: i64 = -7;
pub const EDDSA: i64 = -8;

/// A COSE public key an authenticator made: ES256 (P-256) or EdDSA (Ed25519). Returns its algorithm.
pub fn cose_algorithm(key: &[u8]) -> Result<i64, Bad> {
    let bad = Bad("public-key");
    let (k, used) = cbor(key).map_err(|_| bad.clone())?;
    if used != key.len() {
        return Err(bad);
    }
    let bytes =
        |label: i64, len: usize| matches!(k.get_int(label), Some(Cbor::Bytes(b)) if b.len() == len);
    match (k.get_int(1), k.get_int(3), k.get_int(-1)) {
        (Some(Cbor::Int(2)), Some(Cbor::Int(ES256)), Some(Cbor::Int(1)))
            if bytes(-2, 32) && bytes(-3, 32) =>
        {
            es256_key(&k).map(|_| ES256).ok_or(bad)
        }
        (Some(Cbor::Int(1)), Some(Cbor::Int(EDDSA)), Some(Cbor::Int(6))) if bytes(-2, 32) => {
            Ok(EDDSA)
        }
        _ => Err(bad),
    }
}

fn es256_key(k: &Cbor) -> Option<VerifyingKey> {
    let (Some(Cbor::Bytes(x)), Some(Cbor::Bytes(y))) = (k.get_int(-2), k.get_int(-3)) else {
        return None;
    };
    let mut point = vec![4u8];
    point.extend_from_slice(x);
    point.extend_from_slice(y);
    VerifyingKey::from_sec1_bytes(&point).ok()
}

fn verify(cose_key: &[u8], message: &[u8], signature: &[u8]) -> bool {
    let Ok((k, _)) = cbor(cose_key) else {
        return false;
    };
    match k.get_int(3) {
        Some(Cbor::Int(ES256)) => {
            let (Some(key), Ok(sig)) = (es256_key(&k), Signature::from_der(signature)) else {
                return false;
            };
            key.verify(message, &sig).is_ok()
        }
        Some(Cbor::Int(EDDSA)) => {
            let Some(Cbor::Bytes(x)) = k.get_int(-2) else {
                return false;
            };
            crate::observer::ed25519_verify(x, message, signature)
        }
        _ => false,
    }
}

// ---- authenticator data and client data

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthData {
    pub rp_id_hash: [u8; 32],
    pub user_present: bool,
    pub user_verified: bool,
    pub sign_count: u32,
    /// the credential id and its COSE public key, when the authenticator attested one (registration)
    pub credential: Option<(Vec<u8>, Vec<u8>)>,
}

pub fn auth_data(b: &[u8]) -> Result<AuthData, Bad> {
    let bad = Bad("authenticator-data");
    if b.len() < 37 {
        return Err(bad);
    }
    let flags = b[32];
    let (attested, extensions) = (flags & 0x40 != 0, flags & 0x80 != 0);
    let mut at = 37;
    let credential = if attested {
        // aaguid(16) ‖ length(2) ‖ credential id ‖ COSE key
        let len = usize::from(u16::from_be_bytes(
            b.get(53..55)
                .ok_or(bad.clone())?
                .try_into()
                .map_err(|_| bad.clone())?,
        ));
        if len == 0 || len > 1023 {
            return Err(bad);
        }
        let id = b.get(55..55 + len).ok_or(bad.clone())?.to_vec();
        let rest = &b[55 + len..];
        let (_, used) = cbor(rest).map_err(|_| bad.clone())?;
        at = 55 + len + used;
        Some((id, rest[..used].to_vec()))
    } else {
        None
    };
    if extensions {
        let (_, used) = cbor(&b[at..]).map_err(|_| bad.clone())?;
        at += used;
    }
    if at != b.len() {
        return Err(bad);
    }
    Ok(AuthData {
        rp_id_hash: b[..32].try_into().expect("32"),
        user_present: flags & 0x01 != 0,
        user_verified: flags & 0x04 != 0,
        sign_count: u32::from_be_bytes(b[33..37].try_into().expect("four")),
        credential,
    })
}

/// The host of an origin `https://host[:port]`: the relying-party id the hub accepts for it.
fn rp_id(origin: &str) -> Option<&str> {
    let rest = origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"))?;
    Some(rest.split(':').next().unwrap_or(rest))
}

/// Checks shared by registration and sign-in: the ceremony's type, a challenge this hub issued (the caller says
/// whether it did, and uses it up), an allowed origin, not cross-origin, the relying-party id of that origin,
/// user present and verified. Returns the challenge so that the caller can check and consume it first.
pub fn client_challenge(client_data_json: &[u8], ceremony: &str) -> Result<(Vec<u8>, String), Bad> {
    let v: Value = serde_json::from_slice(client_data_json).map_err(|_| Bad("client-data"))?;
    if v["type"].as_str() != Some(ceremony) {
        return Err(Bad("type"));
    }
    if v["crossOrigin"].as_bool() == Some(true) {
        return Err(Bad("cross-origin"));
    }
    let challenge = v["challenge"]
        .as_str()
        .and_then(unb64)
        .ok_or(Bad("challenge"))?;
    let origin = v["origin"].as_str().ok_or(Bad("origin"))?.to_string();
    Ok((challenge, origin))
}

fn check_flags(data: &AuthData, origin: &str, allowed_origins: &[String]) -> Result<(), Bad> {
    if !allowed_origins.iter().any(|o| o == origin) {
        return Err(Bad("origin"));
    }
    let id = rp_id(origin).ok_or(Bad("origin"))?;
    if !same(&Sha256::digest(id.as_bytes()), &data.rp_id_hash) {
        return Err(Bad("rp-id"));
    }
    if !data.user_present {
        return Err(Bad("user-present"));
    }
    if !data.user_verified {
        return Err(Bad("user-verified"));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Registered {
    pub credential_id: Vec<u8>,
    pub public_key: Vec<u8>,
    pub algorithm: i64,
    pub sign_count: u32,
}

/// A new passkey: `attestationObject` and the origin of its `clientDataJSON` (whose challenge the caller checked).
pub fn register(
    attestation_object: &[u8],
    origin: &str,
    allowed_origins: &[String],
) -> Result<Registered, Bad> {
    let (att, used) = cbor(attestation_object).map_err(|_| Bad("attestation"))?;
    if used != attestation_object.len() {
        return Err(Bad("attestation"));
    }
    let (Some(Cbor::Text(_)), Some(Cbor::Map(_)), Some(Cbor::Bytes(data))) = (
        att.get_text("fmt"),
        att.get_text("attStmt"),
        att.get_text("authData"),
    ) else {
        return Err(Bad("attestation"));
    };
    let parsed = auth_data(data)?;
    check_flags(&parsed, origin, allowed_origins)?;
    let (credential_id, public_key) = parsed.credential.ok_or(Bad("authenticator-data"))?;
    let algorithm = cose_algorithm(&public_key)?;
    Ok(Registered {
        credential_id,
        public_key,
        algorithm,
        sign_count: parsed.sign_count,
    })
}

/// A sign-in: the signature over `authenticatorData ‖ SHA-256(clientDataJSON)` under the stored key.
pub fn assert(
    public_key: &[u8],
    authenticator_data: &[u8],
    client_data_json: &[u8],
    signature: &[u8],
    origin: &str,
    allowed_origins: &[String],
) -> Result<u32, Bad> {
    let parsed = auth_data(authenticator_data)?;
    if parsed.credential.is_some() {
        return Err(Bad("authenticator-data"));
    }
    check_flags(&parsed, origin, allowed_origins)?;
    let mut message = authenticator_data.to_vec();
    message.extend_from_slice(&Sha256::digest(client_data_json));
    if !verify(public_key, &message, signature) {
        return Err(Bad("signature"));
    }
    Ok(parsed.sign_count)
}

/// A key nobody holds: an unknown credential is checked against it, so that it costs and answers like a known one.
pub fn dummy_key() -> Vec<u8> {
    use p256::elliptic_curve::sec1::ToEncodedPoint;
    let secret = p256::SecretKey::random(&mut p256::elliptic_curve::rand_core::OsRng);
    let point = secret.public_key().to_encoded_point(false);
    cose_es256(point.x().expect("x"), point.y().expect("y"))
}

pub fn cose_es256(x: &[u8], y: &[u8]) -> Vec<u8> {
    // { 1: 2, 3: -7, -1: 1, -2: x, -3: y }
    let mut k = vec![0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20];
    k.extend_from_slice(x);
    k.extend_from_slice(&[0x22, 0x58, 0x20]);
    k.extend_from_slice(y);
    k
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::util::b64;
    use p256::ecdsa::signature::Signer;
    use p256::ecdsa::SigningKey;

    pub struct Authenticator {
        pub key: SigningKey,
        pub credential_id: Vec<u8>,
    }

    impl Authenticator {
        #[allow(clippy::new_without_default)]
        pub fn new() -> Self {
            Authenticator {
                key: SigningKey::random(&mut p256::elliptic_curve::rand_core::OsRng),
                credential_id: crate::util::random::<20>().to_vec(),
            }
        }
        pub fn cose(&self) -> Vec<u8> {
            let p = self.key.verifying_key().to_encoded_point(false);
            cose_es256(p.x().unwrap(), p.y().unwrap())
        }
        fn data(&self, rp: &str, flags: u8, attested: bool) -> Vec<u8> {
            let mut d = Sha256::digest(rp.as_bytes()).to_vec();
            d.push(flags | if attested { 0x40 } else { 0 });
            d.extend_from_slice(&7u32.to_be_bytes());
            if attested {
                d.extend_from_slice(&[0; 16]);
                d.extend_from_slice(&(self.credential_id.len() as u16).to_be_bytes());
                d.extend_from_slice(&self.credential_id);
                d.extend_from_slice(&self.cose());
            }
            d
        }
        pub fn client_data(ceremony: &str, challenge: &[u8], origin: &str) -> Vec<u8> {
            serde_json::json!({ "type": ceremony, "challenge": b64(challenge), "origin": origin, "crossOrigin": false }).to_string().into_bytes()
        }
        pub fn attestation(&self, rp: &str, flags: u8) -> Vec<u8> {
            let data = self.data(rp, flags, true);
            // { "fmt": "none", "attStmt": {}, "authData": bytes }
            let mut a = vec![0xa3, 0x63];
            a.extend_from_slice(b"fmt");
            a.extend_from_slice(&[0x64]);
            a.extend_from_slice(b"none");
            a.extend_from_slice(&[0x67]);
            a.extend_from_slice(b"attStmt");
            a.push(0xa0);
            a.extend_from_slice(&[0x68]);
            a.extend_from_slice(b"authData");
            a.extend_from_slice(&[0x59]);
            a.extend_from_slice(&(data.len() as u16).to_be_bytes());
            a.extend_from_slice(&data);
            a
        }
        /// (authenticator data, signature)
        pub fn assertion(&self, rp: &str, flags: u8, client_data: &[u8]) -> (Vec<u8>, Vec<u8>) {
            let data = self.data(rp, flags, false);
            let mut message = data.clone();
            message.extend_from_slice(&Sha256::digest(client_data));
            let signature: Signature = self.key.sign(&message);
            (data, signature.to_der().as_bytes().to_vec())
        }
    }

    const ORIGIN: &str = "https://app.trommi.com";

    #[test]
    fn a_passkey_registers_and_signs_in() {
        let allowed = vec![ORIGIN.to_string()];
        let a = Authenticator::new();
        let client = Authenticator::client_data("webauthn.create", &[1; 32], ORIGIN);
        let (challenge, origin) = client_challenge(&client, "webauthn.create").unwrap();
        assert_eq!(challenge, vec![1; 32]);
        let r = register(&a.attestation("app.trommi.com", 0x05), &origin, &allowed).unwrap();
        assert_eq!(
            (r.credential_id.clone(), r.algorithm, r.sign_count),
            (a.credential_id.clone(), ES256, 7)
        );

        let client = Authenticator::client_data("webauthn.get", &[2; 32], ORIGIN);
        let (data, signature) = a.assertion("app.trommi.com", 0x05, &client);
        assert_eq!(
            assert(&r.public_key, &data, &client, &signature, ORIGIN, &allowed),
            Ok(7)
        );
        // another key, another client data, another signature
        assert_eq!(
            assert(&dummy_key(), &data, &client, &signature, ORIGIN, &allowed),
            Err(Bad("signature"))
        );
        let other = Authenticator::client_data("webauthn.get", &[3; 32], ORIGIN);
        assert_eq!(
            assert(&r.public_key, &data, &other, &signature, ORIGIN, &allowed),
            Err(Bad("signature"))
        );
    }

    #[test]
    fn each_webauthn_check_refuses_with_its_reason() {
        let allowed = vec![ORIGIN.to_string()];
        let a = Authenticator::new();
        let client = Authenticator::client_data("webauthn.get", &[2; 32], ORIGIN);
        assert_eq!(
            client_challenge(&client, "webauthn.create"),
            Err(Bad("type"))
        );
        let crossed = serde_json::json!({ "type": "webauthn.get", "challenge": "AA", "origin": ORIGIN, "crossOrigin": true }).to_string();
        assert_eq!(
            client_challenge(crossed.as_bytes(), "webauthn.get"),
            Err(Bad("cross-origin"))
        );
        assert_eq!(
            client_challenge(b"not json", "webauthn.get"),
            Err(Bad("client-data"))
        );
        // another origin, another relying party, no presence, no verification
        assert_eq!(
            register(
                &a.attestation("app.trommi.com", 0x05),
                "https://evil.example",
                &allowed
            ),
            Err(Bad("origin"))
        );
        assert_eq!(
            register(&a.attestation("evil.example", 0x05), ORIGIN, &allowed),
            Err(Bad("rp-id"))
        );
        assert_eq!(
            register(&a.attestation("app.trommi.com", 0x04), ORIGIN, &allowed),
            Err(Bad("user-present"))
        );
        assert_eq!(
            register(&a.attestation("app.trommi.com", 0x01), ORIGIN, &allowed),
            Err(Bad("user-verified"))
        );
        let mut trailing = a.attestation("app.trommi.com", 0x05);
        trailing.push(0);
        assert_eq!(
            register(&trailing, ORIGIN, &allowed),
            Err(Bad("attestation"))
        );
        // an assertion that carries attested credential data is not an assertion
        let (_, signature) = a.assertion("app.trommi.com", 0x05, &client);
        assert_eq!(
            assert(
                &a.cose(),
                &a.data("app.trommi.com", 0x05, true),
                &client,
                &signature,
                ORIGIN,
                &allowed
            ),
            Err(Bad("authenticator-data"))
        );
    }

    #[test]
    fn the_cbor_reader_refuses_what_it_does_not_need() {
        // indefinite length, nesting too deep, a duplicate key, a huge array
        assert!(cbor(&[0x9f, 0x01, 0xff]).is_err());
        assert!(cbor(&[0x81; 12]).is_err());
        assert!(cbor(&[0xa2, 0x01, 0x02, 0x01, 0x03]).is_err());
        assert!(cbor(&[0x9a, 0xff, 0xff, 0xff, 0xff]).is_err());
        assert_eq!(cbor(&[0x38, 0x18]).unwrap().0, Cbor::Int(-25));
        assert!(
            cose_algorithm(&cose_es256(&[1; 32], &[2; 32])).is_err(),
            "not a point on the curve"
        );
    }
}
