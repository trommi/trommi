//! `spec/vectors/hub_auth.json`: a sign-in to the hub, and what the hub refuses of it (section 12.3).

use serde_json::{json, Value};
use trommi_core::crypto::SigningKey;
use trommi_core::hub_auth::{sign, verify, HubAddress, IssuedChallenge, SignedHubAuth};
use trommi_core::ids::{DeviceId, RoomId};
use trommi_core::Error;

use super::{entropy, hex};

/// The name of the file.
pub const NAME: &str = "hub_auth";
/// The hub signed in to.
pub const HUB: &str = "https://hub.example.org";
/// When the challenge was handed out.
pub const ISSUED_AT: u64 = 1_790_000_000_000;

/// Makes the file.
pub fn generate() -> Result<Value, Error> {
    let mut entropy = entropy(NAME)?;
    let key = SigningKey::generate(&mut entropy)?;
    let other = SigningKey::generate(&mut entropy)?;
    let room = RoomId::new(trommi_core::crypto::random(&mut entropy)?);
    let hub = HubAddress::parse(HUB)?;
    let issued = IssuedChallenge::issue(&mut entropy, ISSUED_AT)?;
    let signed = sign(&key, room, &hub, issued.challenge)?;
    let device = DeviceId::new(key.public());

    // What the hub answers to the sign-in and to its variations, in the order of its checks.
    let ask = |signed: &SignedHubAuth, room: &RoomId, hub: &HubAddress, now: u64| match verify(
        signed, room, hub, &issued, now,
    ) {
        Ok(device) => format!("signed in: {}", hex(device.as_bytes())),
        Err(error) => error.code().to_owned(),
    };
    let elsewhere = HubAddress::parse("https://hub.example.com")?;
    let other_room = RoomId::new([9; 32]);
    let other_challenge = sign(&key, room, &hub, [9; 32])?;
    let signed_by_other = SignedHubAuth {
        auth: signed.auth.clone(),
        signature: sign(&other, room, &hub, issued.challenge)?.signature,
    };
    let cut = SignedHubAuth {
        auth: signed.auth.get(1..).unwrap_or_default().to_vec(),
        signature: signed.signature.clone(),
    };
    let cases = [
        (
            "the sign-in, at the challenge's last moment",
            &signed,
            room,
            &hub,
            issued.expires_at,
        ),
        (
            "posted for another room",
            &signed,
            other_room,
            &hub,
            ISSUED_AT,
        ),
        (
            "posted to a hub of another address",
            &signed,
            room,
            &elsewhere,
            ISSUED_AT,
        ),
        (
            "answers another challenge",
            &other_challenge,
            room,
            &hub,
            ISSUED_AT,
        ),
        (
            "a moment after the challenge ran out",
            &signed,
            room,
            &hub,
            issued.expires_at + 1,
        ),
        (
            "signed by another key than the device named",
            &signed_by_other,
            room,
            &hub,
            ISSUED_AT,
        ),
        ("a byte of the HubAuth missing", &cut, room, &hub, ISSUED_AT),
    ];
    Ok(json!({
        "about": "Signing in to the hub (spec/v1.md section 12.3): HubAuth = room_id, hub<V>, device, challenge, and SignWithLabel(device's key, \"TrommiHubAuth\", HubAuth). The hub handed the challenge out at issued_at, good until expires_at. cases: what the hub answers when the sign-in (auth, signature) is posted for room_id to the hub of that address at now: 'signed in: <device>' or the code, by the order of its checks.",
        "seed": hex(key.seed().expose()),
        "device": hex(device.as_bytes()),
        "room_id": hex(room.as_bytes()),
        "hub": HUB,
        "challenge": hex(&issued.challenge),
        "issued_at": ISSUED_AT,
        "expires_at": issued.expires_at,
        "auth": hex(&signed.auth),
        "signature": hex(&signed.signature),
        "cases": cases.iter().map(|(why, signed, room, hub, now)| json!({
            "why": why,
            "auth": hex(&signed.auth),
            "signature": hex(&signed.signature),
            "room_id": hex(room.as_bytes()),
            "hub": hub.as_str(),
            "now": now,
            "result": ask(signed, room, hub, *now),
        })).collect::<Vec<_>>(),
    }))
}
