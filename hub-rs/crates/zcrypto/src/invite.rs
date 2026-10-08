//! Invites (FORMAT.md section 8) and the hub sign-in (section 17): what the hub and the vectors check.

use crate::bytes::{bytes_equal, R};
use crate::log::{LogState, Member};
use crate::prim::{device_id, hash, hkdf, label_bytes, verify};
use crate::{fail, label, obj, ZResult, ROLE_AGENT, ROLE_HUMAN};
use hmac::{Hmac, Mac};
use sha2::Sha256;

pub const HUB_MAX: usize = 512;

#[derive(Debug)]
pub struct Offer {
    pub room_id: [u8; 32],
    pub invite_id: [u8; 16],
    pub role: u8,
    pub expires_at: u64,
    pub commit: [u8; 32],
    pub inviter_id: [u8; 32],
    pub log_seq: u32,
    pub log_hash: [u8; 32],
    pub body: Vec<u8>,
    pub signature: Vec<u8>,
}
pub fn decode_offer(bytes: &[u8]) -> ZResult<Offer> {
    if bytes.len() < 64 {
        return Err(fail("bad-format", "offer"));
    }
    let body = &bytes[..bytes.len() - 64];
    let mut r = R::new(body);
    crate::prim::header(&mut r, obj::INVITE_OFFER)?;
    let o = Offer {
        room_id: r.take32()?,
        invite_id: r.take16()?,
        role: r.u8()?,
        expires_at: r.u64()?,
        commit: r.take32()?,
        inviter_id: r.take32()?,
        log_seq: r.u32()?,
        log_hash: r.take32()?,
        body: body.to_vec(),
        signature: bytes[bytes.len() - 64..].to_vec(),
    };
    r.end()?;
    Ok(o)
}
/// An offer is good if an active human member of this room signed it and it has not run out.
pub fn verify_invite_offer(state: &LogState, offer: &[u8], now: i64) -> ZResult<Offer> {
    let o = decode_offer(offer)?;
    if !bytes_equal(&o.room_id, &state.room_id) {
        return Err(fail("bad-invite", "the offer belongs to another room"));
    }
    let inviter = state.member_at(&o.inviter_id, None);
    let Some(inviter) = inviter.filter(|m| m.role == ROLE_HUMAN) else { return Err(fail("bad-invite", "the offer is not from a human member of this room")) };
    if !verify(&inviter.sign_pub, label::INVITE_OFFER_SIG, &o.body, &o.signature) {
        return Err(fail("bad-signature", "invite offer"));
    }
    if o.role != ROLE_HUMAN && o.role != ROLE_AGENT {
        return Err(fail("bad-format", "unknown role"));
    }
    if now as f64 > o.expires_at as f64 {
        return Err(fail("invite-expired", "this invite has run out"));
    }
    Ok(o)
}

#[derive(Debug)]
pub struct Request {
    pub room_id: [u8; 32],
    pub invite_id: [u8; 16],
    pub hub: String,
    pub role: u8,
    pub sign_pub: [u8; 32],
    pub kex_pub: [u8; 32],
    pub offer_hash: [u8; 32],
    pub body: Vec<u8>,
    pub mac: Vec<u8>,
    pub signature: Vec<u8>,
    pub id: [u8; 32],
}
pub fn decode_request(bytes: &[u8]) -> ZResult<Request> {
    if bytes.len() < 96 {
        return Err(fail("bad-format", "request"));
    }
    let body = &bytes[..bytes.len() - 96];
    let mut r = R::new(body);
    crate::prim::header(&mut r, obj::INVITE_REQUEST)?;
    let room_id = r.take32()?;
    let invite_id = r.take16()?;
    let hub = r.str16(HUB_MAX)?;
    let role = r.u8()?;
    let sign_pub = r.take32()?;
    let kex_pub = r.take32()?;
    let offer_hash = r.take32()?;
    r.end()?;
    Ok(Request {
        room_id, invite_id, hub, role, sign_pub, kex_pub, offer_hash,
        body: body.to_vec(),
        mac: bytes[bytes.len() - 96..bytes.len() - 64].to_vec(),
        signature: bytes[bytes.len() - 64..].to_vec(),
        id: device_id(&sign_pub, &kex_pub),
    })
}
/// Well-formed and signed by the key it carries.
pub fn verify_invite_request(request: &[u8]) -> ZResult<Request> {
    let q = decode_request(request)?;
    if q.role != ROLE_HUMAN && q.role != ROLE_AGENT {
        return Err(fail("bad-format", "unknown role"));
    }
    let mut signed = q.body.clone();
    signed.extend_from_slice(&q.mac);
    if !verify(&q.sign_pub, label::INVITE_REQUEST_SIG, &signed, &q.signature) {
        return Err(fail("bad-signature", "invite request"));
    }
    Ok(q)
}
/// H("trommi/v1/invite-request", request body || mac): without the signature.
pub fn invite_request_hash(request: &[u8]) -> [u8; 32] {
    hash(label::INVITE_REQUEST, &[&request[..request.len().saturating_sub(64)]])
}
pub fn invite_offer_hash(offer: &[u8]) -> ZResult<[u8; 32]> {
    Ok(hash(label::INVITE_OFFER, &[&decode_offer(offer)?.body]))
}

#[derive(Debug)]
pub struct Reveal {
    pub invite_id: [u8; 16],
    pub nonce: [u8; 32],
    pub request_hash: [u8; 32],
}
/// A reveal is good if the inviter, an active human member, signed it.
pub fn verify_invite_reveal(state: &LogState, reveal: &[u8], inviter_id: &[u8]) -> ZResult<Reveal> {
    let inviter = state.member_at(inviter_id, None);
    let Some(inviter) = inviter.filter(|m| m.role == ROLE_HUMAN) else { return Err(fail("bad-invite", "the inviter is no longer a member")) };
    if reveal.len() < 64 {
        return Err(fail("bad-format", "reveal"));
    }
    let body = &reveal[..reveal.len() - 64];
    if !verify(&inviter.sign_pub, label::INVITE_REVEAL_SIG, body, &reveal[reveal.len() - 64..]) {
        return Err(fail("bad-signature", "invite reveal"));
    }
    let mut r = R::new(body);
    crate::prim::header(&mut r, obj::INVITE_REVEAL)?;
    let out = Reveal { invite_id: r.take16()?, nonce: r.take32()?, request_hash: r.take32()? };
    r.end()?;
    Ok(out)
}

/// Invite id and MAC key from the link secret.
pub fn invite_keys(secret: &[u8], room_id: &[u8]) -> ([u8; 16], Vec<u8>) {
    let id = hkdf(secret, room_id, label::INVITE_ID, &[], 16);
    let mac = hkdf(secret, room_id, label::INVITE_MAC, &[], 32);
    (crate::bytes::arr16(&id), mac)
}
pub fn check_request_mac(mac_key: &[u8], body: &[u8], mac: &[u8]) -> bool {
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(mac_key).unwrap();
    m.update(&label_bytes(label::INVITE_MAC));
    m.update(body);
    m.verify_slice(mac).is_ok()
}
/// The check code: six numbers 0-63 from the first 36 bits, "07-33-12-05-60-01".
pub fn invite_code(offer: &[u8], request: &[u8], nonce: &[u8]) -> ZResult<String> {
    let h = hash(label::INVITE_CODE, &[&decode_offer(offer)?.body, &request[..request.len() - 64], nonce]);
    let mut n = u64::from_be_bytes(h[..8].try_into().unwrap()) >> 28;
    let mut out = vec![];
    for _ in 0..6 {
        out.insert(0, format!("{:02}", n & 63));
        n >>= 6;
    }
    Ok(out.join("-"))
}

/// The canonical hub address (R9).
pub fn check_hub_address(hub: &str) -> bool {
    fn label_ok(l: &str) -> bool {
        !l.is_empty() && l.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-') && !l.starts_with('-') && !l.ends_with('-')
    }
    let (host_port, https) = if let Some(r) = hub.strip_prefix("https://") { (r, true) } else if let Some(r) = hub.strip_prefix("http://") { (r, false) } else { return false };
    let (host, port) = match host_port.rsplit_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (host_port, None),
    };
    if let Some(p) = port {
        let b = p.as_bytes();
        if b.is_empty() || b.len() > 5 || !(b'1'..=b'9').contains(&b[0]) || !b.iter().all(|c| c.is_ascii_digit()) {
            return false;
        }
    }
    if https { host.split('.').all(label_ok) } else { host == "localhost" || host == "127.0.0.1" }
}

#[derive(Debug)]
pub struct HubAuth {
    pub id: [u8; 32],
    pub recovery: bool,
    pub member_role: Option<u8>,
    pub challenge: [u8; 32],
}
/// The hub sign-in. A removed device that proves its key gets `not-member` with the entry that removed it.
pub fn verify_hub_auth(bytes: &[u8], state: &LogState, hub: &str) -> ZResult<HubAuth> {
    if bytes.len() < 64 {
        return Err(fail("bad-format", "hub auth"));
    }
    let body = &bytes[..bytes.len() - 64];
    let mut r = R::new(body);
    crate::prim::header(&mut r, obj::HUB_AUTH)?;
    let room_id = r.take32()?;
    let a_hub = r.str16(HUB_MAX)?;
    let id = r.take32()?;
    let challenge = r.take32()?;
    r.end()?;
    if !bytes_equal(&room_id, &state.room_id) {
        return Err(fail("wrong-room", "signed for another room"));
    }
    if a_hub != hub {
        return Err(fail("wrong-hub", "signed for another hub"));
    }
    let recovery = bytes_equal(&id, &state.recovery.id);
    let member: Option<&Member> = if recovery { None } else { state.member_at(&id, None) };
    let gone = if !recovery && member.is_none() { state.members.get(&id) } else { None };
    if !recovery && member.is_none() && gone.is_none() {
        return Err(fail("not-member", "this device is not a member (or was removed)"));
    }
    let pub_key = if recovery { state.recovery.sign_pub } else { member.or(gone).unwrap().sign_pub };
    if !verify(&pub_key, label::HUB_AUTH, body, &bytes[bytes.len() - 64..]) {
        return Err(fail("bad-signature", "hub auth"));
    }
    if let Some(g) = gone {
        let mut e = fail("not-member", "this device was removed");
        e.removed_seq = g.removed_seq;
        return Err(e);
    }
    Ok(HubAuth { id, recovery, member_role: member.map(|m| m.role), challenge })
}
