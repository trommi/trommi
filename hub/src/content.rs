//! Stored content (spec/v1.md section 9): the one write route for envelopes, the hub's checks 1 to 8 on headers,
//! the object state rule, the indexes with the app's names, and the reads built on them. The hub never opens a
//! body: everything here works on the signed header, the chain numbers and hashes.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::db::next_change;
use crate::delivery::Ctx;
use crate::error::{refuse, Refused, Res};
use crate::observer::Device;
use crate::rules::Standing;
use crate::store::{
    self, fixed, Auth, Effects, Event, GroupKind, GroupRow, PushJob, Room, Sight, Who,
};
use crate::util::{b64, same};
use crate::wire::{self, Cut, Envelope, Header, HeaderError, Subject, ZERO32};

/// The largest ciphertext: a padded body of 64 KiB and the AEAD tag.
pub const MAX_CIPHERTEXT: usize = 65536 + 16;
/// A register value is at most 4 KiB (9.3.5): with its name and number it pads to 8 KiB at most.
pub const MAX_REGISTER_CIPHERTEXT: usize = 8192 + 16;
/// 9.0.8: an envelope of the epoch before is taken for two minutes after the Commit arrived.
pub const EPOCH_GRACE_MS: u64 = 120_000;

fn object_table(object_type: u8) -> &'static str {
    match object_type {
        wire::TYPE_CARD => "cards",
        wire::TYPE_NOTE => "notes",
        wire::TYPE_REQUEST => "permission_requests",
        _ => "artifacts",
    }
}

const OBJECT_TABLES: [(&str, u8); 4] = [
    ("cards", wire::TYPE_CARD),
    ("notes", wire::TYPE_NOTE),
    ("permission_requests", wire::TYPE_REQUEST),
    ("artifacts", wire::TYPE_ARTIFACT),
];

/// An object's state as the hub derives it from headers (9.2.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Object {
    pub object_type: u8,
    pub group_id: Vec<u8>,
    pub state: u8,
    pub urgency: u8,
    pub answered_at: u64,
    pub owner: Device,
    pub first_change: i64,
    pub head_change: i64,
    pub version_hash: [u8; 32],
    pub version_change: i64,
    pub settled_at: Option<u64>,
    pub closed_at: Option<u64>,
}

pub fn load_object(c: &Connection, room: &Room, object_id: &[u8; 16]) -> Res<Option<Object>> {
    for (table, object_type) in OBJECT_TABLES {
        let found = c
            .prepare_cached(&format!(
                "SELECT group_id, state, urgency, answered_at, owner, first_change, head_change, version_hash, version_change, settled_at, closed_at
                 FROM {table} WHERE room_id = ?1 AND object_id = ?2"
            ))?
            .query_row(params![&room[..], &object_id[..]], |r| {
                Ok(Object {
                    object_type,
                    group_id: r.get(0)?,
                    state: r.get(1)?,
                    urgency: r.get(2)?,
                    answered_at: r.get::<_, i64>(3)? as u64,
                    owner: fixed(r.get(4)?)?,
                    first_change: r.get(5)?,
                    head_change: r.get(6)?,
                    version_hash: fixed(r.get(7)?)?,
                    version_change: r.get(8)?,
                    settled_at: r.get::<_, Option<i64>>(9)?.map(|v| v as u64),
                    closed_at: r.get::<_, Option<i64>>(10)?.map(|v| v as u64),
                })
            })
            .optional()?;
        if found.is_some() {
            return Ok(found);
        }
    }
    Ok(None)
}

fn save_object(c: &Connection, room: &Room, object_id: &[u8; 16], o: &Object) -> Res<()> {
    let table = object_table(o.object_type);
    c.prepare_cached(&format!(
        "INSERT INTO {table} (room_id, object_id, group_id, state, urgency, answered_at, owner, first_change, head_change, version_hash, version_change, settled_at, closed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT (room_id, object_id) DO UPDATE SET state = excluded.state, urgency = excluded.urgency, answered_at = excluded.answered_at,
           owner = excluded.owner, head_change = excluded.head_change, version_hash = excluded.version_hash, version_change = excluded.version_change,
           settled_at = excluded.settled_at, closed_at = excluded.closed_at,
           pruned_at = NULL"
    ))?
    .execute(params![
        &room[..],
        &object_id[..],
        o.group_id,
        o.state,
        o.urgency,
        o.answered_at as i64,
        &o.owner[..],
        o.first_change,
        o.head_change,
        &o.version_hash[..],
        o.version_change,
        o.settled_at.map(|v| v as i64),
        o.closed_at.map(|v| v as i64)
    ])?;
    Ok(())
}

/// 9.2.1, the same at the hub and on every client: the state after an envelope, from the state just before it
/// and the envelope's header alone. `Err` is `forbidden`: the envelope changes nothing.
pub fn step(
    before: Option<&Object>,
    h: &Header,
    hash: &[u8; 32],
    change: i64,
    received_at: u64,
) -> Result<Object, &'static str> {
    let Subject::Object {
        object_id,
        object_type,
        object_state,
        urgency,
        answered_at,
        object_ref,
    } = &h.subject
    else {
        return Err("not an object's envelope");
    };
    let settle = |o: &mut Object, state: u8| {
        o.state = state;
        o.settled_at = (state != wire::STATE_OPEN).then_some(received_at);
        o.closed_at = (state == wire::STATE_CLOSED).then_some(received_at);
    };
    let first = *object_ref == ZERO32 && matches!(h.kind, wire::KIND_VERSION | wire::KIND_REQUEST);
    if first {
        if before.is_some() {
            return Err("the object exists");
        }
        let kind_fits = match h.kind {
            wire::KIND_REQUEST => *object_type == wire::TYPE_REQUEST,
            _ => *object_type != wire::TYPE_REQUEST,
        };
        if !kind_fits {
            return Err("the kind does not fit the object's type");
        }
        if *object_id != wire::object_id(&h.group_id, &h.sender, h.seq) {
            return Err("the object id is not the one its first version gives");
        }
        if *object_state != wire::STATE_OPEN {
            return Err("an object begins open");
        }
        return Ok(Object {
            object_type: *object_type,
            group_id: h.group_id.clone(),
            state: wire::STATE_OPEN,
            urgency: *urgency,
            answered_at: 0,
            owner: h.sender,
            first_change: change,
            head_change: change,
            version_hash: *hash,
            version_change: change,
            settled_at: None,
            closed_at: None,
        });
    }
    let Some(before) = before else {
        return Err("no such object");
    };
    if before.object_type != *object_type || before.group_id != h.group_id {
        return Err("another object's type or group");
    }
    let mut o = before.clone();
    o.head_change = change;
    let note = before.object_type == wire::TYPE_NOTE;
    match h.kind {
        wire::KIND_VERSION => {
            if before.object_type == wire::TYPE_REQUEST {
                return Err("a permission request has one version");
            }
            // Notes: any human device writes a version on any other; the hub keeps the newest by arrival.
            if !note && *object_ref != before.version_hash {
                return Err("not a version of the current version");
            }
            if !matches!(*object_state, wire::STATE_OPEN | wire::STATE_CLOSED) {
                return Err("a version is open or closed");
            }
            o.owner = h.sender;
            o.version_hash = *hash;
            o.version_change = change;
            o.urgency = *urgency;
            if *object_state == wire::STATE_OPEN {
                o.answered_at = 0;
            }
            // a Note too: a deleting version (closed) settles it, its bodies go 30 days later (9.4.1)
            settle(&mut o, *object_state);
        }
        wire::KIND_ANSWER => {
            if before.object_type != wire::TYPE_CARD
                || *object_ref != before.version_hash
                || before.state != wire::STATE_OPEN
            {
                return Err("an answer names the current version of an open card");
            }
            if !matches!(*object_state, wire::STATE_ANSWERED | wire::STATE_CLOSED) {
                return Err("an answer leaves the card answered or closed");
            }
            o.answered_at = *answered_at;
            settle(&mut o, *object_state);
        }
        wire::KIND_TAKE_BACK => {
            if before.object_type != wire::TYPE_CARD
                || *object_ref != before.version_hash
                || before.state != wire::STATE_ANSWERED
            {
                return Err("a take back names the current version of an answered card");
            }
            if *object_state != wire::STATE_OPEN {
                return Err("a take back opens the card again");
            }
            o.answered_at = 0;
            settle(&mut o, wire::STATE_OPEN);
        }
        wire::KIND_VERDICT => {
            if before.object_type != wire::TYPE_REQUEST
                || *object_ref != before.version_hash
                || before.state != wire::STATE_OPEN
            {
                return Err("a verdict names an open permission request");
            }
            if *object_state != wire::STATE_CLOSED {
                return Err("a verdict closes the request");
            }
            o.answered_at = *answered_at;
            settle(&mut o, wire::STATE_CLOSED);
        }
        _ => return Err("the kind does not fit"),
    }
    Ok(o)
}

struct Sender {
    standing: Standing,
    /// the group's agent leaf; in a helper session its opener
    agent: Option<Device>,
}

/// 9.2: who may write what. `Err` is `forbidden`.
fn may_write(
    c: &Connection,
    room: &Room,
    row: &GroupRow,
    h: &Header,
    sender: &Sender,
    object: Option<&Object>,
) -> Res<Result<(), &'static str>> {
    let session = row.kind != GroupKind::Room;
    let human = sender.standing == Standing::Human;
    let agent_or_helper = matches!(sender.standing, Standing::Agent | Standing::Helper);
    // a human device addresses the session's agent device (helper session: its opener); zeros while there is none
    let addressed = h.recipient == sender.agent.unwrap_or(ZERO32);
    Ok(match &h.subject {
        Subject::Register { .. } => {
            if session || human {
                Ok(())
            } else {
                Err("registers of the room group are written by human devices")
            }
        }
        Subject::Item {
            timeline_kind,
            timeline_scope,
            timeline_ref,
        } => match (*timeline_kind, *timeline_scope) {
            (wire::TIMELINE_BOARD, _) => {
                if !session && human {
                    Ok(())
                } else {
                    Err("board items are written by human devices in the room group")
                }
            }
            (_, scope) => {
                if !session {
                    return Ok(Err("a Chat belongs to a session"));
                }
                let on_this_group = if scope == wire::SCOPE_SESSION {
                    row.session_id.as_ref() == Some(timeline_ref)
                } else {
                    load_object(c, room, timeline_ref)?.is_some_and(|o| {
                        o.object_type == wire::TYPE_CARD && o.group_id == row.group_id
                    })
                };
                if !on_this_group {
                    Err("the Chat is not of this session")
                } else if agent_or_helper || (human && addressed) {
                    Ok(())
                } else {
                    Err("a human device addresses the session's agent device")
                }
            }
        },
        Subject::Object {
            object_type,
            object_ref,
            ..
        } => {
            let first =
                *object_ref == ZERO32 && matches!(h.kind, wire::KIND_VERSION | wire::KIND_REQUEST);
            match (h.kind, *object_type) {
                (wire::KIND_VERSION, wire::TYPE_NOTE) => {
                    if !session && human {
                        Ok(())
                    } else {
                        Err("Notes are written by human devices in the room group")
                    }
                }
                (wire::KIND_VERSION | wire::KIND_REQUEST, _) => {
                    if !session || !agent_or_helper {
                        Err("cards, permission requests and Artifacts are written by the session's agent or helper devices")
                    } else if first {
                        Ok(())
                    } else {
                        // later versions: the owner; once the owner is no longer a leaf, the session's agent device
                        match object {
                            Some(o) if o.owner == h.sender => Ok(()),
                            Some(o)
                                if !store::is_leaf(c, &row.group_id, &o.owner)?
                                    && sender.agent == Some(h.sender) =>
                            {
                                Ok(())
                            }
                            _ => Err("only the object's owner writes its versions"),
                        }
                    }
                }
                _ => {
                    // answer, take back, verdict: a human device, to the object's owner
                    match object {
                        Some(o) if human && h.recipient == current_owner(c, row, o, sender)? => Ok(()),
                        _ => Err("answers and verdicts are a human device's, addressed to the object's owner"),
                    }
                }
            }
        }
    })
}

/// The owner of an object as a reader must address it now: the stored owner while it is a leaf of the group, else
/// the session's agent device (helper session: its opener), as the write rule has it.
pub fn effective_owner(c: &Connection, room: &Room, group_id: &[u8], owner: Device) -> Res<Device> {
    if store::is_leaf(c, group_id, &owner)? {
        return Ok(owner);
    }
    let row = store::group(c, room, group_id)?;
    let view = store::room_view(c, room)?;
    let agent = match row.kind {
        GroupKind::Room => None,
        GroupKind::Main => store::agent_leaf(c, &view, &row.group_id)?,
        GroupKind::Helper => match store::session_kind(c, &view, &row)? {
            crate::rules::SessionKind::Helper { opener } => opener,
            _ => None,
        },
    };
    Ok(agent.unwrap_or(owner))
}

/// 9.2: the owner, or once it is no longer a leaf, the session's agent device.
fn current_owner(c: &Connection, row: &GroupRow, o: &Object, sender: &Sender) -> Res<Device> {
    if store::is_leaf(c, &row.group_id, &o.owner)? {
        Ok(o.owner)
    } else {
        Ok(sender.agent.unwrap_or(o.owner))
    }
}

/// The object an envelope belongs to, for its files: its own, or the card of a card Chat.
fn object_of(h: &Header) -> Option<[u8; 16]> {
    match &h.subject {
        Subject::Object { object_id, .. } => Some(*object_id),
        Subject::Item {
            timeline_scope,
            timeline_ref,
            ..
        } if *timeline_scope == wire::SCOPE_CARD => Some(*timeline_ref),
        _ => None,
    }
}

fn timeline_key(h: &Header) -> Option<Vec<u8>> {
    match &h.subject {
        Subject::Item {
            timeline_kind,
            timeline_scope,
            timeline_ref,
        } => {
            let mut k = vec![*timeline_kind, *timeline_scope];
            k.extend_from_slice(timeline_ref);
            Some(k)
        }
        _ => None,
    }
}

/// 11.3: a file belongs to the group, and to the object if any, of the first envelope of its uploader that names
/// it. `Err` is `forbidden`.
fn claim_files(
    c: &Connection,
    room: &Room,
    h: &Header,
    owner_now: Option<Device>,
    now: u64,
    write: bool,
) -> Res<Result<(), &'static str>> {
    let object = object_of(h);
    for file_id in &h.file_ids {
        let found: Option<(Vec<u8>, Option<Vec<u8>>, Option<Vec<u8>>, bool)> = c
            .prepare_cached("SELECT uploader, group_id, object_id, deleted_at IS NOT NULL FROM files WHERE room_id = ?1 AND file_id = ?2")?
            .query_row(params![&room[..], &file_id[..]], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .optional()?;
        // an id the hub holds no bytes for claims nothing and grants nothing
        let Some((uploader, group, file_object, deleted)) = found else {
            continue;
        };
        if deleted {
            continue;
        }
        let by_uploader = same(&uploader, &h.sender);
        match group {
            None => {
                if !by_uploader {
                    return Ok(Err("a file is first named by the device that uploaded it"));
                }
                if write {
                    c.prepare_cached("UPDATE files SET group_id = ?1, object_id = ?2, referenced_at = ?3 WHERE room_id = ?4 AND file_id = ?5")?
                        .execute(params![h.group_id, object.as_ref().map(|o| &o[..]), now as i64, &room[..], &file_id[..]])?;
                }
            }
            Some(g) => {
                let same_place =
                    g == h.group_id && file_object.as_deref() == object.as_ref().map(|o| &o[..]);
                if !same_place {
                    return Ok(Err("the file belongs to another group or object"));
                }
                if !(by_uploader || owner_now == Some(h.sender)) {
                    return Ok(Err(
                        "the file is named by its uploader or the object's owner",
                    ));
                }
            }
        }
    }
    Ok(Ok(()))
}

/// Deletes the files of an object and their Share links (9.4, 11.5). The rows stay as tombstones.
pub fn delete_files_of(
    c: &Connection,
    room: &Room,
    object_id: &[u8],
    now: u64,
    fx: &mut Effects,
) -> Res<usize> {
    let ids: Vec<(Vec<u8>, i64)> = {
        let mut s = c.prepare_cached("SELECT file_id, size FROM files WHERE room_id = ?1 AND object_id = ?2 AND deleted_at IS NULL")?;
        let rows = s
            .query_map(params![&room[..], object_id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    for (id, size) in &ids {
        delete_file(c, room, id, *size, now, fx)?;
    }
    Ok(ids.len())
}

pub fn delete_file(
    c: &Connection,
    room: &Room,
    file_id: &[u8],
    size: i64,
    now: u64,
    fx: &mut Effects,
) -> Res<()> {
    c.prepare_cached("UPDATE files SET deleted_at = ?1 WHERE room_id = ?2 AND file_id = ?3")?
        .execute(params![now as i64, &room[..], file_id])?;
    c.prepare_cached("UPDATE rooms SET file_bytes = max(0, file_bytes - ?1) WHERE room_id = ?2")?
        .execute(params![size, &room[..]])?;
    c.prepare_cached("DELETE FROM shares WHERE room_id = ?1 AND file_id = ?2")?
        .execute(params![&room[..], file_id])?;
    if let Ok(id) = <[u8; 16]>::try_from(file_id) {
        fx.unlink.push((*room, id));
    }
    Ok(())
}

fn void(code: &'static str, message: impl Into<String>) -> Refused {
    refuse(code, message).with(json!({ "voided": true }))
}

struct Chain {
    seq: u64,
    hash: [u8; 32],
}

fn chain_head(c: &Connection, group_id: &[u8], sender: &Device) -> Res<Option<Chain>> {
    Ok(c.prepare_cached("SELECT seq, hash FROM envelopes WHERE group_id = ?1 AND sender = ?2 ORDER BY seq DESC LIMIT 1")?
        .query_row(params![group_id, &sender[..]], |r| Ok(Chain { seq: r.get::<_, i64>(0)? as u64, hash: fixed(r.get(1)?)? }))
        .optional()?)
}

/// What became of a posted envelope. A void record is stored (its number is used up) and then refused.
pub enum Posted {
    Stored { change: i64 },
    Voided(Refused),
}

/// The one write route for stored content (9.0.11): checks 1 to 8 without the body, 9.2, files, limits; then the
/// envelope and its index rows in one transaction.
pub fn post_envelope(x: &Ctx, auth: &Auth, bytes: &[u8], fx: &mut Effects) -> Res<Posted> {
    auth.member()?;
    // (1) encoding, flags, values; the room
    let env = match Envelope::parse(bytes) {
        Ok(e) => e,
        Err(HeaderError::NewerVersion) => {
            return Err(refuse("newer-version", "an envelope of a newer version"))
        }
        Err(HeaderError::Malformed(m)) => return Err(refuse("bad-format", m)),
    };
    let h = &env.header;
    let Some(body) = &env.body else {
        return Err(refuse("bad-format", "an envelope is posted in full"));
    };
    if h.group_id.len() < 32 || h.group_id[..32] != auth.room {
        return Err(refuse("wrong-room", "an envelope of another room"));
    }
    let row = store::group(x.c, &auth.room, &h.group_id)
        .map_err(|_| refuse("wrong-room", "no such group in this room"))?;
    if h.sender != auth.device {
        return Err(refuse(
            "wrong-sender",
            "an envelope is posted by the device that signed it",
        ));
    }
    let padded = body.len().saturating_sub(16);
    // (a sealed body beyond the largest padded size is `too-large`, a void record: check 8 below)
    if body.len() <= MAX_CIPHERTEXT && (padded < 256 || !padded.is_power_of_two()) {
        return Err(refuse(
            "bad-format",
            "the padded body is 256, 512 … 65536 bytes",
        ));
    }
    // (2) the group has reached the envelope's epoch
    if h.epoch > row.epoch {
        return Err(refuse(
            "group-behind",
            "the group has not reached this epoch",
        ));
    }
    // (3) the sender was a leaf of the group in that epoch; (4) a removed sender's chain ends at its Cut
    let member: Option<(i64, Option<i64>, Option<i64>, Option<Vec<u8>>)> = x
        .c
        .prepare_cached("SELECT added_epoch, removed_epoch, cut_seq, cut_hash FROM group_members WHERE group_id = ?1 AND device = ?2")?
        .query_row(params![h.group_id, &h.sender[..]], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .optional()?;
    let Some((added, removed, cut_seq, cut_hash)) = member else {
        return Err(refuse("not-member", "the sender is no leaf of this group"));
    };
    let hash = env.hash();
    // A repeated post of bytes the hub holds gets its first answer again, before anything that may have changed
    // since is looked at (the sender may have left the group and come back meanwhile).
    let held: Option<(Vec<u8>, i64, Option<String>)> = x
        .c
        .prepare_cached("SELECT hash, change, void_code FROM envelopes WHERE group_id = ?1 AND sender = ?2 AND seq = ?3")?
        .query_row(params![h.group_id, &h.sender[..], h.seq as i64], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()?;
    match &held {
        Some((held_hash, change, None)) if same(held_hash, &hash) => {
            return Ok(Posted::Stored { change: *change })
        }
        Some((held_hash, _, Some(code))) if same(held_hash, &hash) => {
            return Ok(Posted::Voided(void(
                void_code(code),
                "refused before; the number is used",
            )))
        }
        _ => {}
    }
    if !row.live {
        return Err(refuse("gone", "the session is archived"));
    }
    if let Some(cut) = cut_seq {
        if h.seq > cut as u64 {
            return Err(refuse(
                "removed-sender",
                "the sender was removed; its chain ended at its Cut",
            ));
        }
        if h.seq == cut as u64 && !cut_hash.is_some_and(|c| same(&c, &hash)) {
            return Err(refuse(
                "equivocation",
                "another envelope under the number of the Cut",
            ));
        }
    }
    if h.epoch < added as u64 || removed.is_some_and(|r| h.epoch >= r as u64) {
        return Err(refuse(
            "not-member",
            "the sender was no leaf of this group in that epoch",
        ));
    }
    // (5) the signature
    if !x
        .obs
        .verify(&h.sender, "TrommiEnvelope", &hash, &env.signature)
    {
        return Err(refuse(
            "bad-signature",
            "the envelope's signature does not verify",
        ));
    }
    // (6) the chain
    let head = chain_head(x.c, &h.group_id, &h.sender)?;
    let last = head.as_ref().map_or(0, |c| c.seq);
    if h.seq <= last {
        let held: Option<(Vec<u8>, i64, Option<String>)> = x
            .c
            .prepare_cached("SELECT hash, change, void_code FROM envelopes WHERE group_id = ?1 AND sender = ?2 AND seq = ?3")?
            .query_row(params![h.group_id, &h.sender[..], h.seq as i64], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .optional()?;
        return match held {
            // a repeated post of the same bytes gets the first answer again
            Some((held_hash, change, None)) if same(&held_hash, &hash) => {
                Ok(Posted::Stored { change })
            }
            Some((held_hash, _, Some(code))) if same(&held_hash, &hash) => Ok(Posted::Voided(
                void(void_code(&code), "refused before; the number is used"),
            )),
            Some(_) => Err(refuse("equivocation", "another envelope under this number")),
            None => Err(refuse("replay", "this number is used")),
        };
    }
    if h.seq > last + 1 {
        return Err(refuse("gap", "the chain misses envelopes before this one")
            .with(json!({ "seq": last })));
    }
    if h.prev != head.map_or(ZERO32, |c| c.hash) {
        return Err(refuse(
            "chain-break",
            "prev is not the sender's previous envelope",
        ));
    }

    // a register id the room does not hold yet: counted against the room's number (the envelope takes no number
    // if it is over)
    let new_register = match &h.subject {
        Subject::Register { register_id } => {
            !x.c.prepare_cached(
                "SELECT 1 FROM registers WHERE group_id = ?1 AND writer = ?2 AND register_id = ?3",
            )?
            .exists(params![h.group_id, &h.sender[..], &register_id[..]])?
        }
        _ => false,
    };
    if new_register {
        x.cfg
            .quotas
            .room_for(x.c, &auth.room, crate::quota::Counted::Registers)?;
    }

    // From here on the chain has advanced, whatever follows: a refusal is stored as a void record.
    let view = store::room_view(x.c, &auth.room)?;
    let sender = Sender {
        standing: view.standing(&h.sender),
        agent: match row.kind {
            GroupKind::Room => None,
            GroupKind::Main => store::agent_leaf(x.c, &view, &row.group_id)?,
            GroupKind::Helper => match store::session_kind(x.c, &view, &row)? {
                crate::rules::SessionKind::Helper { opener } => opener,
                _ => None,
            },
        },
    };
    let object_id = match &h.subject {
        Subject::Object { object_id, .. } => Some(*object_id),
        _ => None,
    };
    let object = match &object_id {
        Some(id) => load_object(x.c, &auth.room, id)?,
        None => None,
    };
    let count: i64 = x
        .c
        .prepare_cached("SELECT envelopes FROM epoch_counts WHERE group_id = ?1 AND epoch = ?2")?
        .query_row(params![h.group_id, h.epoch as i64], |r| r.get(0))
        .optional()?
        .unwrap_or(0);
    let change = next_change(x.c, &auth.room)?;
    let mut next_state = None;
    let verdict: Result<(), (&'static str, &'static str)> = (|| {
        if store::is_stale(x.c, &view, &row)? {
            return Ok(Err(("stale-session", "the group waits for a Remove")));
        }
        // (7) the sender may write this item, and the object state rule
        if let Err(why) = may_write(x.c, &auth.room, &row, h, &sender, object.as_ref())? {
            return Ok(Err(("forbidden", why)));
        }
        if object_id.is_some() {
            match step(object.as_ref(), h, &hash, change, x.now) {
                Ok(o) => next_state = Some(o),
                Err(why) => return Ok(Err(("forbidden", why))),
            }
        }
        let owner_now = match (&object, object_of(h)) {
            (Some(o), _) => Some(current_owner(x.c, &row, o, &sender)?),
            (None, Some(card)) if object_id.is_none() => match load_object(x.c, &auth.room, &card)?
            {
                Some(o) => Some(current_owner(x.c, &row, &o, &sender)?),
                None => None,
            },
            _ => None,
        };
        if let Err(why) = claim_files(x.c, &auth.room, h, owner_now, x.now, false)? {
            return Ok(Err(("forbidden", why)));
        }
        // (8) freshness: the current epoch, or the one before within two minutes of the Commit's arrival
        let fresh = h.epoch == row.epoch
            || (h.epoch + 1 == row.epoch && x.now.saturating_sub(row.epoch_at) <= EPOCH_GRACE_MS);
        if !fresh {
            return Ok(Err((
                "wrong-epoch",
                "an envelope of an epoch that ended: encrypt again",
            )));
        }
        if count as u64 >= x.cfg.epoch_envelopes {
            return Ok(Err((
                "epoch-full",
                "this epoch holds its limit of envelopes: commit an update",
            )));
        }
        let limit = if matches!(h.subject, Subject::Register { .. }) {
            MAX_REGISTER_CIPHERTEXT
        } else {
            MAX_CIPHERTEXT
        };
        if body.len() > limit {
            return Ok(Err((
                "too-large",
                "the body is larger than this kind of item may be",
            )));
        }
        Ok::<_, Refused>(Ok(()))
    })()?;

    let (void_code, stored_body): (Option<&str>, Option<&[u8]>) = match &verdict {
        Ok(()) => (None, Some(body)),
        Err((code, _)) => (Some(code), None),
    };
    let (object_type, object_state, urgency, answered_at, object_ref) = match &h.subject {
        Subject::Object {
            object_type,
            object_state,
            urgency,
            answered_at,
            object_ref,
            ..
        } => (
            Some(*object_type),
            Some(*object_state),
            Some(*urgency),
            Some(*answered_at as i64),
            Some(object_ref.to_vec()),
        ),
        _ => (None, None, None, None, None),
    };
    let register_id = match &h.subject {
        Subject::Register { register_id } => Some(register_id.to_vec()),
        _ => None,
    };
    x.c.prepare_cached(
        "INSERT INTO envelopes (room_id, change, group_id, epoch, sender, seq, prev, hash, recipient, kind, flags, time, received_at, timeline,
           object_id, object_type, object_state, urgency, answered_at, object_ref, register_id, file_ids, padded_size, void_code, header, nonce,
           body_hash, signature, body)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29)",
    )?
    .execute(params![
        &auth.room[..],
        change,
        h.group_id,
        h.epoch as i64,
        &h.sender[..],
        h.seq as i64,
        &h.prev[..],
        &hash[..],
        &h.recipient[..],
        h.kind,
        h.flags,
        h.time as i64,
        x.now as i64,
        timeline_key(h),
        object_id.as_ref().map(|o| &o[..]),
        object_type,
        object_state,
        urgency,
        answered_at,
        object_ref,
        register_id,
        h.file_ids.concat(),
        padded as i64,
        void_code,
        env.header_bytes,
        &env.nonce[..],
        &env.body_hash[..],
        env.signature,
        stored_body
    ])?;
    crate::delivery::joined(x.c, &h.group_id, &h.sender)?;
    let audience = store::leaf_audience(x.c, &h.group_id)?;
    if let Err((code, why)) = verdict {
        // A room holds so many void records; past that the refusal comes without one and the number is not
        // used (the transaction is rolled back).
        if x.cfg
            .quotas
            .take(x.c, &auth.room, crate::quota::Counted::Voids)
            .is_err()
        {
            return Err(refuse(code, why));
        }
        // receivers chain a void record and apply nothing
        fx.events.push(Event {
            room: auth.room,
            audience,
            name: "envelope",
            change: Some(change),
            data: json!({ "void_code": code }),
        });
        return Ok(Posted::Voided(void(code, why)));
    }

    // ---- accepted: the indexes, in the same transaction
    x.c.prepare_cached(
        "INSERT INTO epoch_counts (group_id, epoch, envelopes) VALUES (?1, ?2, 1) ON CONFLICT (group_id, epoch) DO UPDATE SET envelopes = envelopes + 1",
    )?
    .execute(params![h.group_id, h.epoch as i64])?;
    let owner_now = match &next_state {
        Some(o) => Some(o.owner),
        None => match object_of(h) {
            Some(card) => match load_object(x.c, &auth.room, &card)? {
                Some(o) => Some(current_owner(x.c, &row, &o, &sender)?),
                None => None,
            },
            None => None,
        },
    };
    let _ = claim_files(x.c, &auth.room, h, owner_now, x.now, true)?;
    apply_index(x.c, &auth.room, h, change, next_state.as_ref(), x.now, fx)?;
    if new_register {
        x.cfg
            .quotas
            .take(x.c, &auth.room, crate::quota::Counted::Registers)?;
    }
    // 9.2: the push flag is honoured on card versions and permission requests from the session's agent or helper device
    let pushes = h.push()
        && matches!(sender.standing, Standing::Agent | Standing::Helper)
        && matches!(
            (h.kind, object_type),
            (wire::KIND_VERSION, Some(wire::TYPE_CARD))
                | (wire::KIND_REQUEST, Some(wire::TYPE_REQUEST))
        );
    if pushes {
        fx.pushes.push(PushJob {
            room: auth.room,
            sender: Some(h.sender),
            change,
            urgency: urgency.unwrap_or(1),
            envelope: Some(hash),
        });
    }
    if object_id.is_some() {
        fx.live.push(auth.room);
    }
    fx.events.push(Event {
        room: auth.room,
        audience,
        name: "envelope",
        change: Some(change),
        data: json!({}),
    });
    Ok(Posted::Stored { change })
}

fn void_code(code: &str) -> &'static str {
    match code {
        "forbidden" => "forbidden",
        "wrong-epoch" => "wrong-epoch",
        "stale-session" => "stale-session",
        "epoch-full" => "epoch-full",
        _ => "too-large",
    }
}

/// The index rows of one accepted envelope: its object's state, its timeline's count, its register's head.
fn apply_index(
    c: &Connection,
    room: &Room,
    h: &Header,
    change: i64,
    object: Option<&Object>,
    now: u64,
    fx: &mut Effects,
) -> Res<()> {
    match &h.subject {
        Subject::Object { object_id, .. } => {
            if let Some(o) = object {
                save_object(c, room, object_id, o)?;
                // 9.4: an Artifact's files are deleted at once when it is closed
                if o.object_type == wire::TYPE_ARTIFACT && o.state == wire::STATE_CLOSED {
                    delete_files_of(c, room, object_id, now, fx)?;
                }
                // 9.4.2: a Note version prunes the same writer's earlier versions of that Note
                if o.object_type == wire::TYPE_NOTE {
                    crate::prune::superseded(c, room, h, now, fx)?;
                }
            }
        }
        Subject::Item { timeline_kind, .. } => {
            let table = if *timeline_kind == wire::TIMELINE_BOARD {
                "boards"
            } else {
                "chats"
            };
            c.prepare_cached(&format!(
                "INSERT INTO {table} (room_id, timeline, group_id, item_count, last_change) VALUES (?1, ?2, ?3, 1, ?4)
                 ON CONFLICT (room_id, timeline) DO UPDATE SET item_count = item_count + 1, last_change = excluded.last_change"
            ))?
            .execute(params![&room[..], timeline_key(h), h.group_id, change])?;
            // a message in the Chat of a card whose bodies were pruned: the card is due again
            if let Some(card) = object_of(h) {
                c.prepare_cached("UPDATE cards SET pruned_at = NULL WHERE room_id = ?1 AND object_id = ?2 AND pruned_at IS NOT NULL")?
                    .execute(params![&room[..], &card[..]])?;
            }
        }
        Subject::Register { register_id } => {
            c.prepare_cached(
                "INSERT INTO registers (room_id, group_id, writer, register_id, head_change) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (group_id, writer, register_id) DO UPDATE SET head_change = excluded.head_change",
            )?
            .execute(params![&room[..], h.group_id, &h.sender[..], &register_id[..], change])?;
            // 9.4.2: the same writer's earlier values of this register are no longer needed
            crate::prune::superseded(c, room, h, now, fx)?;
        }
    }
    Ok(())
}

/// Rebuilds one object's row from its envelopes (pruned ones count, void and cut ones do not), each judged
/// against the state just before it. The object tables are indexes: this is how they are rebuilt.
pub fn rebuild_object(c: &Connection, room: &Room, object_id: &[u8]) -> Res<()> {
    for (table, _) in OBJECT_TABLES {
        c.prepare_cached(&format!(
            "DELETE FROM {table} WHERE room_id = ?1 AND object_id = ?2"
        ))?
        .execute(params![&room[..], object_id])?;
    }
    let rows: Vec<(Vec<u8>, Vec<u8>, i64, i64)> = {
        let mut s = c.prepare_cached(
            "SELECT header, hash, change, received_at FROM envelopes
             WHERE room_id = ?1 AND object_id = ?2 AND void_code IS NULL AND cut = 0 ORDER BY change",
        )?;
        let rows = s
            .query_map(params![&room[..], object_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let mut state: Option<Object> = None;
    for (header, hash, change, received_at) in rows {
        let Ok(h) = Header::parse(&header) else {
            continue;
        };
        let hash: [u8; 32] = fixed(hash)?;
        if let Ok(next) = step(state.as_ref(), &h, &hash, change, received_at as u64) {
            state = Some(next);
        }
    }
    if let (Some(o), Ok(id)) = (state, <[u8; 16]>::try_from(object_id)) {
        save_object(c, room, &id, &o)?;
    }
    Ok(())
}

/// 9.0.10: a Commit that removes a leaf names that device's last envelope the remover accepted. What the hub had
/// taken beyond it stays stored as evidence and leaves every index, object state, file and share as if it had
/// never come.
pub fn cut_chain(
    c: &Connection,
    room: &Room,
    group_id: &[u8],
    cut: &Cut,
    fx: &mut Effects,
) -> Res<()> {
    let bad = |m: &str| refuse("bad-commit", format!("the Cut: {m}"));
    let head = chain_head(c, group_id, &cut.device)?;
    if cut.seq > head.as_ref().map_or(0, |h| h.seq) {
        return Err(bad("it names an envelope the hub does not hold"));
    }
    if cut.seq == 0 {
        if cut.hash != ZERO32 {
            return Err(bad("no envelope has the hash zero"));
        }
    } else {
        let held: Vec<u8> = c
            .prepare_cached(
                "SELECT hash FROM envelopes WHERE group_id = ?1 AND sender = ?2 AND seq = ?3",
            )?
            .query_row(params![group_id, &cut.device[..], cut.seq as i64], |r| {
                r.get(0)
            })?;
        if !same(&held, &cut.hash) {
            return Err(bad("another hash under that number"));
        }
    }
    let beyond: Vec<(Vec<u8>, i64)> = {
        let mut s = c.prepare_cached("SELECT header, change FROM envelopes WHERE group_id = ?1 AND sender = ?2 AND seq > ?3 AND void_code IS NULL AND cut = 0")?;
        let rows = s
            .query_map(params![group_id, &cut.device[..], cut.seq as i64], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    c.prepare_cached(
        "UPDATE envelopes SET cut = 1 WHERE group_id = ?1 AND sender = ?2 AND seq > ?3",
    )?
    .execute(params![group_id, &cut.device[..], cut.seq as i64])?;
    // each object, timeline, register and file that the cut envelopes touch is put right once, however many of
    // them touch it
    let mut done: std::collections::HashSet<Vec<u8>> = std::collections::HashSet::new();
    for (header, change) in beyond {
        let Ok(h) = Header::parse(&header) else {
            continue;
        };
        let subject = match &h.subject {
            Subject::Object { object_id, .. } => [&[0u8][..], &object_id[..]].concat(),
            Subject::Item { .. } => {
                [&[1u8][..], &timeline_key(&h).unwrap_or_default()[..]].concat()
            }
            Subject::Register { register_id } => [&[2u8][..], &register_id[..]].concat(),
        };
        let first_time = done.insert(subject);
        match &h.subject {
            _ if !first_time => {}
            Subject::Object { object_id, .. } => rebuild_object(c, room, object_id)?,
            Subject::Item { timeline_kind, .. } => {
                let table = if *timeline_kind == wire::TIMELINE_BOARD {
                    "boards"
                } else {
                    "chats"
                };
                let key = timeline_key(&h);
                c.prepare_cached(&format!(
                    "UPDATE {table} SET item_count = (SELECT count(*) FROM envelopes WHERE room_id = ?1 AND timeline = ?2 AND void_code IS NULL AND cut = 0),
                       last_change = coalesce((SELECT max(change) FROM envelopes WHERE room_id = ?1 AND timeline = ?2 AND void_code IS NULL AND cut = 0), 0)
                     WHERE room_id = ?1 AND timeline = ?2"
                ))?
                .execute(params![&room[..], key])?;
                c.prepare_cached(&format!(
                    "DELETE FROM {table} WHERE room_id = ?1 AND timeline = ?2 AND item_count = 0"
                ))?
                .execute(params![&room[..], key])?;
            }
            Subject::Register { register_id } => {
                let newest: Option<i64> = c
                    .prepare_cached(
                        "SELECT max(change) FROM envelopes WHERE group_id = ?1 AND sender = ?2 AND register_id = ?3 AND void_code IS NULL AND cut = 0",
                    )?
                    .query_row(params![group_id, &cut.device[..], &register_id[..]], |r| r.get(0))?;
                match newest {
                    Some(n) => c
                        .prepare_cached("UPDATE registers SET head_change = ?1 WHERE group_id = ?2 AND writer = ?3 AND register_id = ?4")?
                        .execute(params![n, group_id, &cut.device[..], &register_id[..]])?,
                    None => c
                        .prepare_cached("DELETE FROM registers WHERE group_id = ?1 AND writer = ?2 AND register_id = ?3")?
                        .execute(params![group_id, &cut.device[..], &register_id[..]])?,
                };
            }
        }
        // a file first named beyond the Cut is unclaimed again (and goes with the next sweep); its shares end
        for file_id in &h.file_ids {
            if !done.insert([&[3u8][..], &file_id[..]].concat()) {
                continue;
            }
            // named before, by an envelope of the same device that stays? (the list is 16-byte entries: an id
            // is compared entry by entry, never as a run of bytes across two of them)
            let earlier: Vec<Vec<u8>> = {
                let mut s = c.prepare_cached(
                    "SELECT file_ids FROM envelopes WHERE group_id = ?1 AND sender = ?2 AND cut = 0 AND void_code IS NULL
                       AND change < ?3 AND instr(file_ids, ?4) > 0",
                )?;
                let rows = s
                    .query_map(
                        params![group_id, &cut.device[..], change, &file_id[..]],
                        |r| r.get(0),
                    )?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                rows
            };
            if earlier
                .iter()
                .any(|list| list.chunks(16).any(|entry| entry == file_id))
            {
                continue;
            }
            let n = c
                .prepare_cached(
                    "UPDATE files SET group_id = NULL, object_id = NULL, referenced_at = NULL
                     WHERE room_id = ?1 AND file_id = ?2 AND uploader = ?3 AND referenced_at IS NOT NULL",
                )?
                .execute(params![&room[..], &file_id[..], &cut.device[..]])?;
            if n > 0 {
                c.prepare_cached("DELETE FROM shares WHERE room_id = ?1 AND file_id = ?2")?
                    .execute(params![&room[..], &file_id[..]])?;
            }
        }
    }
    fx.live.push(*room);
    Ok(())
}

// ---- reads

const ENVELOPE_COLUMNS: &str =
    "change, header, nonce, body_hash, signature, body, void_code, cut, received_at, seq";

/// One envelope as served: its bytes (pruned form when there is no body or the asker gets no bodies), the
/// change it came at, and its `void_code` if it is a void record.
fn envelope_item(r: &rusqlite::Row, pruned: bool) -> rusqlite::Result<Value> {
    // what lies beyond a Cut is evidence: its header, never its body
    let cut = r.get::<_, i64>(7)? == 1;
    let body: Option<Vec<u8>> = if pruned || cut { None } else { r.get(5)? };
    let bytes = wire::encode_envelope(
        &r.get::<_, Vec<u8>>(1)?,
        &r.get::<_, Vec<u8>>(2)?,
        body.as_deref(),
        &r.get::<_, Vec<u8>>(3)?,
        &r.get::<_, Vec<u8>>(4)?,
    );
    let mut item = json!({ "change": r.get::<_, i64>(0)?, "received_at": r.get::<_, i64>(8)?, "envelope": b64(&bytes) });
    if let Some(code) = r.get::<_, Option<String>>(6)? {
        item["void_code"] = json!(code);
    }
    if r.get::<_, i64>(7)? == 1 {
        item["cut"] = json!(true);
    }
    Ok(item)
}

pub fn envelope_at(c: &Connection, room: &Room, change: i64, pruned: bool) -> Res<Option<Value>> {
    Ok(c.prepare_cached(&format!(
        "SELECT {ENVELOPE_COLUMNS} FROM envelopes WHERE room_id = ?1 AND change = ?2"
    ))?
    .query_row(params![&room[..], change], |r| envelope_item(r, pruned))
    .optional()?)
}

fn clamp(limit: Option<i64>, default: i64, max: i64) -> i64 {
    limit.unwrap_or(default).clamp(1, max)
}

/// What one answer may hold of envelopes: an answer is built in memory, and a reader that asks for much gets
/// `more` and asks again.
pub const ANSWER_BYTES: usize = 8 << 20;

/// Collects envelopes of a query up to `limit` items and `ANSWER_BYTES`; says whether more remain.
fn collect(rows: &mut rusqlite::Rows, limit: i64, pruned: bool) -> Res<(Vec<Value>, bool)> {
    let (mut items, mut bytes) = (Vec::new(), 0usize);
    while let Some(r) = rows.next()? {
        if items.len() as i64 == limit {
            return Ok((items, true));
        }
        let item = envelope_item(r, pruned)?;
        bytes += item["envelope"].as_str().map_or(0, str::len);
        // the budget is checked before an item goes in; the first one always does
        if bytes > ANSWER_BYTES && !items.is_empty() {
            return Ok((items, true));
        }
        items.push(item);
    }
    Ok((items, false))
}

/// `GET /v1/desk`: the open objects with their current version, every writer's newest value per register, and
/// the groups, in what the asker may read.
pub fn desk(c: &Connection, auth: &Auth) -> Res<Value> {
    auth.member()?;
    let readable = store::readable_groups(c, auth)?;
    let sees = |group: &[u8]| {
        readable
            .as_ref()
            .is_none_or(|g| g.iter().any(|x| x == group))
    };
    let mut out = json!({});
    let (mut desk_bytes, mut truncated, mut any) = (0usize, false, false);
    for (table, _) in OBJECT_TABLES {
        let mut s = c.prepare_cached(&format!(
            "SELECT o.object_id, o.group_id, o.state, o.urgency, o.answered_at, o.owner, o.first_change, o.head_change, o.version_change
             FROM {table} o WHERE o.room_id = ?1 AND o.state = 1 ORDER BY o.urgency DESC, o.first_change"
        ))?;
        let mut rows = s.query([&auth.room[..]])?;
        let mut items = Vec::new();
        while let Some(r) = rows.next()? {
            // a Desk with more open objects of a kind than this, or more bytes, is cut short and says so
            if items.len() >= 1000 {
                truncated = true;
                break;
            }
            let group: Vec<u8> = r.get(1)?;
            if !sees(&group) {
                continue;
            }
            let version_change: i64 = r.get(8)?;
            let version = envelope_at(c, &auth.room, version_change, false)?;
            desk_bytes += version
                .as_ref()
                .and_then(|v| v["envelope"].as_str())
                .map_or(0, str::len);
            // one budget for the whole Desk, checked before an item goes in; only the very first always does
            if desk_bytes > ANSWER_BYTES && any {
                truncated = true;
                break;
            }
            items.push(json!({
                "object_id": b64(&r.get::<_, Vec<u8>>(0)?),
                "group_id": b64(&group),
                "state": r.get::<_, i64>(2)?,
                "urgency": r.get::<_, i64>(3)?,
                "answered_at": r.get::<_, i64>(4)?,
                "owner": b64(&effective_owner(c, &auth.room, &group, fixed(r.get(5)?)?)?),
                "first_change": r.get::<_, i64>(6)?,
                "head_change": r.get::<_, i64>(7)?,
                "version": version,
            }));
            any = true;
        }
        out[table] = Value::Array(items);
    }
    let mut registers = Vec::new();
    {
        let mut s = c.prepare_cached(&format!(
            "SELECT {ENVELOPE_COLUMNS}, r.group_id FROM registers r JOIN envelopes e ON e.room_id = r.room_id AND e.change = r.head_change
             WHERE r.room_id = ?1 ORDER BY r.head_change"
        ))?;
        let mut rows = s.query([&auth.room[..]])?;
        // one budget for the whole Desk
        let mut register_bytes = desk_bytes;
        while let Some(r) = rows.next()? {
            if registers.len() >= 20_000 {
                truncated = true;
                break;
            }
            if sees(&r.get::<_, Vec<u8>>(10)?) {
                let item = envelope_item(r, false)?;
                register_bytes += item["envelope"].as_str().map_or(0, str::len);
                if register_bytes > ANSWER_BYTES {
                    truncated = true;
                    break;
                }
                registers.push(item);
            }
        }
    }
    out["registers"] = Value::Array(registers);
    out["truncated"] = json!(truncated);
    out["groups"] = Value::Array(crate::delivery::group_list(c, auth)?);
    out["change"] = json!(store::room_row(c, &auth.room)?.change);
    Ok(out)
}

/// A timeline named in a route: `session/<hex>`, `card/<hex>` for Chats; a board's hex id.
pub fn chat_key(scope: &str, id_hex: &str) -> Res<Vec<u8>> {
    let id = crate::util::unhex(id_hex)
        .filter(|v| v.len() == 16)
        .ok_or_else(|| refuse("bad-format", "a timeline is named by 32 hex digits"))?;
    let scope = match scope {
        "session" => wire::SCOPE_SESSION,
        "card" => wire::SCOPE_CARD,
        _ => return Err(refuse("bad-format", "a Chat is session/<id> or card/<id>")),
    };
    Ok([&[wire::TIMELINE_CHAT, scope][..], &id].concat())
}

fn timeline_group(c: &Connection, auth: &Auth, table: &str, key: &[u8]) -> Res<Option<Vec<u8>>> {
    let group: Option<Vec<u8>> = c
        .prepare_cached(&format!(
            "SELECT group_id FROM {table} WHERE room_id = ?1 AND timeline = ?2"
        ))?
        .query_row(params![&auth.room[..], key], |r| r.get(0))
        .optional()?;
    let Some(group) = group else { return Ok(None) };
    let row = store::group(c, &auth.room, &group)?;
    if store::sight(c, auth, &row)? != Sight::Leaf {
        // what the asker may not read does not exist for it
        return Ok(None);
    }
    Ok(Some(group))
}

/// `GET /v1/chats/{timeline}/items?before=&limit=`: a Chat's envelopes, newest first.
pub fn chat_items(
    c: &Connection,
    auth: &Auth,
    key: &[u8],
    before: Option<i64>,
    limit: Option<i64>,
) -> Res<Value> {
    auth.member()?;
    let limit = clamp(limit, 50, 200);
    let Some(group) = timeline_group(c, auth, "chats", key)? else {
        return Ok(json!({ "items": [], "more": false }));
    };
    // only the envelopes of the timeline's own group: a refused envelope of another group may name it
    let mut s = c.prepare_cached(&format!(
        "SELECT {ENVELOPE_COLUMNS} FROM envelopes WHERE room_id = ?1 AND timeline = ?2 AND change < ?3 AND cut = 0 AND group_id = ?5
         ORDER BY change DESC LIMIT ?4"
    ))?;
    let mut rows = s.query(params![
        &auth.room[..],
        key,
        before.unwrap_or(i64::MAX),
        limit + 1,
        group
    ])?;
    let (items, more) = collect(&mut rows, limit, false)?;
    Ok(json!({ "items": items, "more": more }))
}

/// `GET /v1/boards/{board}?after_change=`: the board's items after the given change, oldest first (10.3).
pub fn board_items(
    c: &Connection,
    auth: &Auth,
    board: &[u8; 16],
    after: Option<i64>,
    limit: Option<i64>,
) -> Res<Value> {
    auth.member()?;
    let key = [&[wire::TIMELINE_BOARD, wire::SCOPE_DESK][..], &board[..]].concat();
    let limit = clamp(limit, 500, 2000);
    let Some(group) = timeline_group(c, auth, "boards", &key)? else {
        return Ok(json!({ "items": [], "more": false }));
    };
    let mut s = c.prepare_cached(&format!(
        "SELECT {ENVELOPE_COLUMNS} FROM envelopes WHERE room_id = ?1 AND timeline = ?2 AND change > ?3 AND cut = 0 AND group_id = ?5
         ORDER BY change LIMIT ?4"
    ))?;
    let mut rows = s.query(params![
        &auth.room[..],
        key,
        after.unwrap_or(0),
        limit + 1,
        group
    ])?;
    let (items, more) = collect(&mut rows, limit, false)?;
    Ok(json!({ "items": items, "more": more }))
}

/// `GET /v1/cards/{object}?after=&limit=` and its siblings: every envelope of the object in the order of their
/// change numbers, pruned ones in pruned form; `more` when the answer was cut short.
pub fn object_envelopes(
    c: &Connection,
    auth: &Auth,
    table: &str,
    object: &[u8; 16],
    after: Option<i64>,
    limit: Option<i64>,
) -> Res<Value> {
    auth.member()?;
    let id = *object;
    let missing = || refuse("not-found", "no such object");
    let object = load_object(c, &auth.room, &id)?.ok_or_else(missing)?;
    if object_table(object.object_type) != table {
        return Err(missing());
    }
    let row = store::group(c, &auth.room, &object.group_id)?;
    if store::sight(c, auth, &row)? != Sight::Leaf {
        return Err(missing());
    }
    let limit = clamp(limit, 500, 2000);
    let mut s = c.prepare_cached(&format!(
        "SELECT {ENVELOPE_COLUMNS} FROM envelopes WHERE room_id = ?1 AND object_id = ?2 AND cut = 0 AND group_id = ?3 AND change > ?4
         ORDER BY change LIMIT ?5"
    ))?;
    let mut rows = s.query(params![
        &auth.room[..],
        &id[..],
        object.group_id,
        after.unwrap_or(0),
        limit + 1
    ])?;
    let (items, more) = collect(&mut rows, limit, false)?;
    Ok(json!({
        "object_id": b64(&id), "group_id": b64(&object.group_id), "state": object.state, "urgency": object.urgency,
        "owner": b64(&effective_owner(c, &auth.room, &object.group_id, object.owner)?), "first_change": object.first_change, "head_change": object.head_change, "items": items,
        "more": more,
    }))
}

/// `GET /v1/groups/{group}/chains/{sender}?after=&limit=`: a sender's envelopes in pruned form, by `seq`; those
/// beyond its Cut marked `cut` (9.0.5, 9.0.10, 10.3).
pub fn chain(
    c: &Connection,
    auth: &Auth,
    group_id: &[u8],
    sender: &[u8],
    after: Option<i64>,
    limit: Option<i64>,
) -> Res<Value> {
    let row = store::group(c, &auth.room, group_id)?;
    let allowed = match auth.who {
        // the recovery key verifies the headers of the chains it cuts (8.7)
        Who::Recovery => true,
        _ => store::sight(c, auth, &row)? == Sight::Leaf,
    };
    if !allowed {
        return Err(refuse("not-found", "no such group"));
    }
    let limit = clamp(limit, 500, 2000);
    let mut s = c.prepare_cached(&format!(
        "SELECT {ENVELOPE_COLUMNS} FROM envelopes WHERE group_id = ?1 AND sender = ?2 AND seq > ?3 ORDER BY seq LIMIT ?4"
    ))?;
    let mut items = s
        .query_map(
            params![group_id, sender, after.unwrap_or(0), limit + 1],
            |r| {
                let mut item = envelope_item(r, true)?;
                item["seq"] = json!(r.get::<_, i64>(9)?);
                Ok(item)
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let more = items.len() as i64 > limit;
    items.truncate(limit as usize);
    Ok(json!({ "items": items, "more": more }))
}

/// How far one catch-up request looks: an asker that sees little of a busy room gets what lies in this stretch
/// and the cursor to go on from.
pub const CHANGES_WINDOW: i64 = 20_000;

/// `GET /v1/changes?after=&limit=`: everything the asker may see with a change number above `after`, in the
/// hub's one order across groups (5.4.1): log entries and envelopes. First the numbers and sizes of what is
/// visible are read (two integers a row, filtered and limited in SQL), then only the items that fit the limit
/// and the answer's byte budget are loaded. The cursor never skips an item the asker may see.
pub fn changes(c: &Connection, auth: &Auth, after: i64, limit: Option<i64>) -> Res<Value> {
    let limit = clamp(limit, 200, 1000);
    let head = store::room_row(c, &auth.room)?.change;
    let upto = after.saturating_add(CHANGES_WINDOW).min(head);
    let (human, recovery) = (auth.who == Who::Human, auth.who == Who::Recovery);
    // an agent or helper device: the groups it is a leaf of, and those whose Commits it follows
    let (mut leaf, mut public) = (Vec::new(), Vec::new());
    if !human && !recovery {
        for row in store::groups_of_room(c, &auth.room)? {
            match store::sight(c, auth, &row)? {
                Sight::Leaf => leaf.push(crate::util::hex(&row.group_id).to_uppercase()),
                Sight::Public => public.push(crate::util::hex(&row.group_id).to_uppercase()),
                Sight::None => {}
            }
        }
    }
    let (leaf, public) = (json!(leaf).to_string(), json!(public).to_string());
    let mut found: Vec<(i64, i64, bool)> = Vec::new();
    let (log_full, envelopes_full);
    {
        let mut s = c.prepare_cached(
            "SELECT change, length(bytes) FROM group_log
             WHERE room_id = ?1 AND change > ?2 AND change <= ?3
               AND (?4 = 1 OR hex(group_id) IN (SELECT value FROM json_each(?5))
                    OR (kind = 'commit' AND (?6 = 1 OR hex(group_id) IN (SELECT value FROM json_each(?7)))))
             ORDER BY change LIMIT ?8",
        )?;
        let rows = s
            .query_map(
                params![
                    &auth.room[..],
                    after,
                    upto,
                    human,
                    leaf,
                    recovery,
                    public,
                    limit + 1
                ],
                |r| Ok((r.get(0)?, r.get(1)?, true)),
            )?
            .collect::<rusqlite::Result<Vec<(i64, i64, bool)>>>()?;
        log_full = rows.len() as i64 > limit;
        found.extend(rows);
    }
    {
        // the recovery key gets envelopes in pruned form: their size is the header's
        let mut s = c.prepare_cached(
            "SELECT change, length(header) + CASE WHEN ?6 = 1 THEN 0 ELSE coalesce(length(body), 0) END FROM envelopes
             WHERE room_id = ?1 AND change > ?2 AND change <= ?3 AND cut = 0
               AND (?4 = 1 OR ?6 = 1 OR hex(group_id) IN (SELECT value FROM json_each(?5)))
             ORDER BY change LIMIT ?7",
        )?;
        let rows = s
            .query_map(
                params![
                    &auth.room[..],
                    after,
                    upto,
                    human,
                    leaf,
                    recovery,
                    limit + 1
                ],
                |r| Ok((r.get(0)?, r.get(1)?, false)),
            )?
            .collect::<rusqlite::Result<Vec<(i64, i64, bool)>>>()?;
        envelopes_full = rows.len() as i64 > limit;
        found.extend(rows);
    }
    found.sort_by_key(|(change, _, _)| *change);
    let (mut items, mut bytes, mut cut_short) = (Vec::new(), 0i64, log_full || envelopes_full);
    let mut cursor = after;
    for (change, size, is_log) in found {
        // base64 makes four bytes of three; the first item always goes in
        let size = size * 4 / 3 + 200;
        if items.len() as i64 == limit || (bytes + size > ANSWER_BYTES as i64 && !items.is_empty())
        {
            cut_short = true;
            break;
        }
        let item = if is_log {
            crate::delivery::log_at(c, &auth.room, change)?
        } else {
            envelope_at(c, &auth.room, change, recovery)?.map(|mut item| {
                item["kind"] = json!("envelope");
                item
            })
        };
        if let Some(item) = item {
            items.push(item);
            bytes += size;
        }
        cursor = change;
    }
    // nothing visible was left out of the stretch: the cursor moves to its end
    if !cut_short {
        cursor = upto;
    }
    Ok(json!({ "items": items, "change": cursor.max(after), "more": cursor < head }))
}

// ---- retention (9.4)

/// Prunes the bodies of objects whose newest state became answered or closed more than `days` ago: the bodies of
/// the object's envelopes and of its card Chat go, header, hash and signature stay; its files are deleted. A Note
/// settles when a version deletes it (9.4.1). One object per transaction, at most `batch` per call. Returns how many were pruned.
pub fn prune_due(
    db: &crate::db::Db,
    now: u64,
    days: u64,
    batch: usize,
    fx: &mut Effects,
) -> Res<usize> {
    let cutoff = now.saturating_sub(days * 86_400_000) as i64;
    let mut due: Vec<(&'static str, Vec<u8>, Vec<u8>)> = Vec::new();
    db.read(|c| {
        for table in ["cards", "permission_requests", "artifacts", "notes"] {
            let mut s = c.prepare_cached(&format!(
                "SELECT room_id, object_id FROM {table} WHERE settled_at IS NOT NULL AND pruned_at IS NULL AND settled_at <= ?1 ORDER BY settled_at LIMIT ?2"
            ))?;
            let rows = s.query_map(params![cutoff, batch as i64], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<Vec<(Vec<u8>, Vec<u8>)>>>()?;
            due.extend(rows.into_iter().map(|(room, object)| (table, room, object)));
        }
        Ok::<_, Refused>(())
    })?;
    due.truncate(batch);
    let mut pruned = 0;
    for (table, room, object) in due {
        let Ok(room_id) = <Room>::try_from(&room[..]) else {
            continue;
        };
        db.write(|c| {
            // judged again inside the transaction: a reopening cancels it
            let still: bool = c
                .prepare_cached(&format!(
                    "SELECT 1 FROM {table} WHERE room_id = ?1 AND object_id = ?2 AND settled_at IS NOT NULL AND pruned_at IS NULL AND settled_at <= ?3"
                ))?
                .exists(params![room, object, cutoff])?;
            if !still {
                return Ok::<_, Refused>(());
            }
            c.prepare_cached("UPDATE envelopes SET body = NULL WHERE room_id = ?1 AND object_id = ?2 AND body IS NOT NULL")?
                .execute(params![room, object])?;
            let chat = [&[wire::TIMELINE_CHAT, wire::SCOPE_CARD][..], &object].concat();
            c.prepare_cached("UPDATE envelopes SET body = NULL WHERE room_id = ?1 AND timeline = ?2 AND body IS NOT NULL")?
                .execute(params![room, chat])?;
            delete_files_of(c, &room_id, &object, now, fx)?;
            c.prepare_cached(&format!("UPDATE {table} SET pruned_at = ?1 WHERE room_id = ?2 AND object_id = ?3"))?
                .execute(params![now as i64, room, object])?;
            pruned += 1;
            Ok(())
        })?;
    }
    Ok(pruned)
}
