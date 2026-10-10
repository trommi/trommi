//! Joining by link (spec/v1.md 12.1, D4): the hub keeps the three signed messages of the ceremony (Offer,
//! Request, Reveal) by `invite_id`. It never sees the link's secret, cannot check the Request's MAC and takes no
//! part in the emoji; what it enforces is 12.1.7: the room group takes a new device only as the outcome of an
//! invite its inviter revealed.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::delivery::Ctx;
use crate::error::{refuse, Res};
use crate::store::{self, Audience, Auth, Effects, Event, GroupKind};
use crate::util::{b64, same};
use crate::wire::{self, InviteRequest, Offer, Reveal, ZERO16};

/// The invite life of each kind of device (12.1.2): 10 minutes for a human device, 15 for an agent device; the
/// inviter's clock may differ from the hub's by 2 minutes either way.
pub const HUMAN_INVITE_MS: u64 = 600_000;
pub const AGENT_INVITE_MS: u64 = 900_000;
pub const CLOCK_TOLERANCE_MS: u64 = 120_000;
/// The Offer's MAC under the link's secret (12.1.2): the hub stores and serves it, and checks only its length.
pub const OFFER_MAC_LEN: usize = 32;
const MAX_REQUESTS: i64 = 4;

/// `POST /v1/invites`: only a human device invites; it publishes the signed Offer with its MAC.
pub fn publish(
    x: &Ctx,
    auth: &Auth,
    offer_bytes: &[u8],
    signature: &[u8],
    mac: Option<&[u8]>,
) -> Res<Value> {
    auth.human()?;
    let offer = Offer::parse(offer_bytes)?;
    // optional until every client sends it; when sent, exactly 32 bytes
    if mac.is_some_and(|m| m.len() != OFFER_MAC_LEN) {
        return Err(refuse("bad-format", "mac: the Offer's MAC, 32 bytes"));
    }
    if offer.room_id != auth.room || offer.inviter != auth.device {
        return Err(refuse(
            "bad-invite",
            "an Offer of this room, by the device that posts it",
        ));
    }
    if !x
        .obs
        .verify(&offer.inviter, "TrommiInviteOffer", offer_bytes, signature)
    {
        return Err(refuse(
            "bad-signature",
            "the Offer's signature does not verify",
        ));
    }
    // a repeated post of the same Offer gets the first answer again, whatever the room has become since
    if let Some(held) =
        x.c.prepare_cached(
            "SELECT offer, offer_signature, offer_mac FROM invites WHERE invite_id = ?1",
        )?
        .query_row([&offer.invite_id[..]], |r| {
            Ok((
                r.get::<_, Vec<u8>>(0)?,
                r.get::<_, Vec<u8>>(1)?,
                r.get::<_, Option<Vec<u8>>>(2)?,
            ))
        })
        .optional()?
    {
        let (held_offer, held_signature, held_mac) = held;
        return if same(&held_offer, offer_bytes)
            && same(&held_signature, signature)
            && match (held_mac.as_deref(), mac) {
                (Some(held), Some(mac)) => same(held, mac),
                (None, None) => true,
                _ => false,
            } {
            Ok(json!({ "invite_id": b64(&offer.invite_id) }))
        } else {
            Err(refuse("replay", "this invite id is used"))
        };
    }
    // the invite life of its kind, with the clocks' tolerance; the hub's own expiry is the Offer's `expires_at`
    let life = if offer.role == 2 {
        AGENT_INVITE_MS
    } else {
        HUMAN_INVITE_MS
    };
    if offer.expires_at <= x.now || offer.expires_at > x.now + life + CLOCK_TOLERANCE_MS {
        return Err(refuse(
            "bad-invite",
            "an invite lives 10 minutes (an agent's 15)",
        ));
    }
    let view = store::room_view(x.c, &auth.room)?;
    if offer.room_epoch < view.epoch {
        return Err(refuse("room-behind", "the Offer names an older room epoch"));
    }
    if offer.room_epoch != view.epoch || offer.room_state != view.state {
        return Err(refuse(
            "bad-invite",
            "the Offer does not name the room's state",
        ));
    }
    if offer.session_id != ZERO16 {
        let group = [&auth.room[..], &offer.session_id[..]].concat();
        let row = store::group(x.c, &auth.room, &group)
            .map_err(|_| refuse("bad-invite", "no such session"))?;
        if row.kind != GroupKind::Main || !row.live {
            return Err(refuse(
                "bad-invite",
                "an agent takes over a live main session",
            ));
        }
    }
    let open: i64 = x
        .c
        .prepare_cached("SELECT count(*) FROM invites WHERE room_id = ?1 AND expires_at > ?2 AND used_at IS NULL AND burned_at IS NULL")?
        .query_row(params![&auth.room[..], x.now as i64], |r| r.get(0))?;
    if open as usize >= x.cfg.open_invites {
        return Err(refuse("too-many", "a room has at most 16 open invites"));
    }
    x.c.prepare_cached(
        "INSERT INTO invites (invite_id, room_id, inviter, role, offer, offer_signature, offer_mac, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    )?
    .execute(params![&offer.invite_id[..], &auth.room[..], &offer.inviter[..], offer.role, offer_bytes, signature, mac, x.now as i64, offer.expires_at as i64])?;
    Ok(json!({ "invite_id": b64(&offer.invite_id) }))
}

struct Invite {
    room: [u8; 32],
    inviter: Vec<u8>,
    offer: Vec<u8>,
    offer_signature: Vec<u8>,
    /// none for an invite stored before the MAC was
    offer_mac: Option<Vec<u8>>,
    reveal: Option<Vec<u8>>,
    reveal_signature: Option<Vec<u8>>,
    expires_at: u64,
    used: bool,
    burned: bool,
}

fn load(c: &Connection, id: &[u8]) -> Res<Invite> {
    c.prepare_cached("SELECT room_id, inviter, offer, offer_signature, reveal, reveal_signature, expires_at, used_at IS NOT NULL, burned_at IS NOT NULL, offer_mac FROM invites WHERE invite_id = ?1")?
        .query_row([id], |r| {
            Ok(Invite {
                room: store::fixed(r.get(0)?)?,
                inviter: r.get(1)?,
                offer: r.get(2)?,
                offer_signature: r.get(3)?,
                reveal: r.get(4)?,
                reveal_signature: r.get(5)?,
                expires_at: r.get::<_, i64>(6)? as u64,
                used: r.get(7)?,
                burned: r.get(8)?,
                offer_mac: r.get(9)?,
            })
        })
        .optional()?
        .ok_or_else(|| refuse("not-found", "no such invite"))
}

fn open(invite: &Invite, now: u64) -> Res<()> {
    if invite.burned {
        return Err(refuse("invite-burned", "this invite was burned"));
    }
    if invite.used {
        return Err(refuse("invite-used", "this invite was used"));
    }
    if invite.expires_at <= now {
        return Err(refuse("invite-expired", "this invite ran out"));
    }
    Ok(())
}

/// `GET /v1/invites/{invite_id}`: the Offer, by `invite_id` only. A human device of the invite's room also gets
/// the Requests that arrived.
pub fn read(c: &Connection, id: &[u8], asker: Option<&Auth>, now: u64) -> Res<Value> {
    let invite = load(c, id)?;
    open(&invite, now)?;
    let mut out = json!({ "offer": b64(&invite.offer), "signature": b64(&invite.offer_signature), "mac": invite.offer_mac.as_deref().map(b64), "expires_at": invite.expires_at });
    if asker.is_some_and(|a| a.room == invite.room && a.who == store::Who::Human) {
        let mut s = c.prepare_cached(
            "SELECT request, mac, signature FROM invite_requests WHERE invite_id = ?1 ORDER BY at",
        )?;
        let rows = s
            .query_map([id], |r| {
                Ok(json!({ "request": b64(&r.get::<_, Vec<u8>>(0)?), "mac": b64(&r.get::<_, Vec<u8>>(1)?), "signature": b64(&r.get::<_, Vec<u8>>(2)?) }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        out["requests"] = Value::Array(rows);
    }
    Ok(out)
}

/// `POST /v1/invites/{invite_id}/request`: the new device's Request with its KeyPackage, MAC and signature. At
/// most four per invite.
pub fn request(
    x: &Ctx,
    id: &[u8],
    request_bytes: &[u8],
    mac: &[u8],
    signature: &[u8],
    fx: &mut Effects,
) -> Res<Value> {
    let invite = load(x.c, id)?;
    open(&invite, x.now)?;
    // 8.7: a room in recovery takes nothing else
    if crate::delivery::open_recovery_of(x.c, &invite.room, x.now)?.is_some() {
        return Err(refuse(
            "overloaded",
            "the room is being recovered: try again in a moment",
        )
        .retry(30));
    }
    if invite.reveal.is_some() {
        return Err(refuse("invite-used", "the inviter accepted a Request"));
    }
    let offer = Offer::parse(&invite.offer)?;
    let request = InviteRequest::parse(request_bytes)?;
    let fits = request.room_id == offer.room_id
        && request.invite_id == offer.invite_id
        && request.hub == x.cfg.url.as_bytes()
        && request.role == offer.role
        && request.offer_hash == wire::ref_hash("Trommi Invite Offer", &invite.offer)
        && mac.len() == 32;
    if !fits {
        return Err(refuse(
            "bad-invite",
            "the Request does not fit the Offer or this hub",
        ));
    }
    let kp = x.obs.key_package(&request.key_package)?;
    let signed = [request_bytes, mac].concat();
    if !x
        .obs
        .verify(&kp.device, "TrommiInviteRequest", &signed, signature)
    {
        return Err(refuse(
            "bad-signature",
            "the Request is not signed by its KeyPackage's key",
        ));
    }
    let hash = wire::ref_hash("Trommi Invite Request", &signed);
    if x.c
        .prepare_cached("SELECT 1 FROM invite_requests WHERE invite_id = ?1 AND request_hash = ?2")?
        .exists(params![id, &hash[..]])?
    {
        return Ok(json!({ "request_hash": b64(&hash) }));
    }
    let count: i64 =
        x.c.prepare_cached("SELECT count(*) FROM invite_requests WHERE invite_id = ?1")?
            .query_row([id], |r| r.get(0))?;
    if count >= MAX_REQUESTS {
        return Err(refuse("too-many", "an invite takes four Requests"));
    }
    x.c.prepare_cached("INSERT INTO invite_requests (invite_id, request_hash, request, mac, signature, key_package_ref, device, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")?
        .execute(params![id, &hash[..], request_bytes, mac, signature, kp.key_package_ref, &kp.device[..], x.now as i64])?;
    fx.events.push(Event {
        room: invite.room,
        audience: Audience {
            humans: true,
            others: vec![],
            except: None,
        },
        name: "request",
        change: None,
        data: json!({ "kind": "invite", "invite_id": b64(id) }),
    });
    Ok(json!({ "request_hash": b64(&hash) }))
}

/// `PUT /v1/invites/{invite_id}/reveal`: the inviter accepted one Request and reveals its nonce. From here on
/// the room group takes exactly that Request's KeyPackage or key, from this inviter (12.1.7).
pub fn reveal(
    x: &Ctx,
    auth: &Auth,
    id: &[u8],
    reveal_bytes: &[u8],
    signature: &[u8],
) -> Res<Value> {
    auth.human()?;
    let invite = load(x.c, id)?;
    if invite.room != auth.room || !same(&invite.inviter, &auth.device) {
        return Err(refuse("not-found", "no such invite"));
    }
    if let Some(held) = &invite.reveal {
        return if same(held, reveal_bytes) {
            Ok(json!({ "revealed": true }))
        } else {
            Err(refuse(
                "invite-used",
                "this invite revealed another Request",
            ))
        };
    }
    open(&invite, x.now)?;
    let reveal = Reveal::parse(reveal_bytes)?;
    let offer = Offer::parse(&invite.offer)?;
    if reveal.invite_id[..] != *id {
        return Err(refuse("bad-invite", "a Reveal of another invite"));
    }
    if !x
        .obs
        .verify(&auth.device, "TrommiInviteReveal", reveal_bytes, signature)
    {
        return Err(refuse(
            "bad-signature",
            "the Reveal's signature does not verify",
        ));
    }
    let commitment = wire::ref_hash(
        "Trommi Invite Commitment",
        &[&reveal.invite_id[..], &reveal.nonce[..]].concat(),
    );
    if commitment != offer.commitment {
        return Err(refuse(
            "bad-invite",
            "the Reveal does not open the Offer's commitment",
        ));
    }
    // the KeyPackage of that Request was checked when it came
    let (key_package_ref, device): (Vec<u8>, Vec<u8>) =
        x.c.prepare_cached("SELECT key_package_ref, device FROM invite_requests WHERE invite_id = ?1 AND request_hash = ?2")?
            .query_row(params![id, &reveal.request_hash[..]], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?
            .ok_or_else(|| refuse("bad-invite", "the Reveal names a Request the hub does not hold"))?;
    x.c.prepare_cached("UPDATE invites SET reveal = ?1, reveal_signature = ?2, revealed_request = ?3, revealed_ref = ?4, revealed_device = ?5 WHERE invite_id = ?6")?
        .execute(params![reveal_bytes, signature, &reveal.request_hash[..], key_package_ref, device, id])?;
    Ok(json!({ "revealed": true }))
}

/// `GET /v1/invites/{invite_id}/reveal`: the Reveal, once the inviter published it.
pub fn read_reveal(c: &Connection, id: &[u8]) -> Res<Value> {
    let invite = load(c, id)?;
    if invite.burned {
        return Err(refuse("invite-burned", "this invite was burned"));
    }
    match (invite.reveal, invite.reveal_signature) {
        (Some(reveal), Some(signature)) => {
            Ok(json!({ "reveal": b64(&reveal), "signature": b64(&signature) }))
        }
        _ => Err(refuse("not-found", "not revealed yet")),
    }
}

/// `DELETE /v1/invites/{invite_id}`: "they don't match" burns the invite. Its inviter or any human device.
pub fn burn(x: &Ctx, auth: &Auth, id: &[u8]) -> Res<Value> {
    auth.human()?;
    let invite = load(x.c, id)?;
    if invite.room != auth.room {
        return Err(refuse("not-found", "no such invite"));
    }
    x.c.prepare_cached("UPDATE invites SET burned_at = coalesce(burned_at, ?1) WHERE invite_id = ?2 AND used_at IS NULL")?.execute(params![x.now as i64, id])?;
    Ok(json!({ "burned": true }))
}
