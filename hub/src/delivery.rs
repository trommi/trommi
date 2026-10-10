//! The MLS delivery service (spec/v2.md sections 5, 8 and 14): founding, one Commit per group and epoch, Welcomes,
//! GroupInfo, key packages, sealed keys, application messages, one order across the groups of a room. Every
//! function here runs inside one database transaction that the caller opened; what must happen after it is
//! collected in `Effects`.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::config::Config;
use crate::db::next_change;
use crate::error::{refuse, Res};
use crate::observer::{By, CommitFacts, Device, Observer};
use crate::rules::{self, SessionKind, Standing};
use crate::store::{self, Audience, Auth, Effects, Event, GroupKind, Room, Sight, Who};
use crate::util::{b64, same, short};
use crate::wire::{self, CommitNote, RecoveryAuth, RecoveryLink, SealedKey, ZERO16};

pub struct Ctx<'a> {
    pub c: &'a Connection,
    pub obs: &'a dyn Observer,
    pub cfg: &'a Config,
    pub now: u64,
}

/// One Commit as posted: the Commit, the GroupInfo of the new epoch, the Welcome if it adds, the SealedKey (5.4.2),
/// and for a join from outside its RecoveryAuth (8.4).
#[derive(Debug, Clone)]
pub struct CommitBody {
    pub epoch: u64,
    pub commit: Vec<u8>,
    pub group_info: Vec<u8>,
    pub welcome: Option<Vec<u8>>,
    pub sealed_key: Vec<u8>,
    pub recovery_auth: Option<Vec<u8>>,
}

/// What surrounds a Commit: an ordinary request, the replacing of the code (8.6), or a recovery (8.7).
#[derive(Debug, Default)]
pub struct Scope {
    /// inside a recovery: the room may hold 33 human devices and its member Commits are the joiner's
    pub recovery: bool,
    /// the RecoveryLink that came with this request: the room's recovery keys may change
    pub link: Option<RecoveryLink>,
    /// a recovery's parts are rehearsed before `finish` brings the link
    pub link_pending: bool,
    pub joiner: Option<Device>,
    pub keys_replaced: bool,
    /// in a recovery: the part applied last was the room Commit that replaced the recovery keys
    pub replaced_in_last: bool,
    pub joined: Vec<Vec<u8>>,
}

fn bad(m: impl Into<String>) -> crate::error::Refused {
    refuse("bad-commit", m)
}

fn digest(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

pub fn group_info_hash(bytes: &[u8]) -> [u8; 32] {
    wire::ref_hash("Trommi Group Info", bytes)
}

fn check_size(cfg: &Config, parts: &[Option<&[u8]>]) -> Res<()> {
    let total: usize = parts.iter().flatten().map(|p| p.len()).sum();
    if total > cfg.commit_limit {
        return Err(refuse(
            "too-large",
            "a Commit with its GroupInfo and Welcome is at most 1 MiB",
        ));
    }
    Ok(())
}

/// 8.2: the SealedKey that comes with a founding or a Commit. The hub checks the context, the key it is sealed
/// to, the writer and whether a tag is set; it cannot check the content or the tag.
fn check_sealed_key(
    bytes: &[u8],
    group_id: &[u8],
    epoch: u64,
    group_info: &[u8],
    room_epoch: u64,
    recovery_hpke_key: &[u8],
    writer: &Device,
    writer_is_human: bool,
) -> Res<SealedKey> {
    let incomplete = |m: &str| refuse("incomplete", format!("the SealedKey of the new epoch: {m}"));
    let key = SealedKey::parse(bytes).map_err(|m| incomplete(m.0))?;
    if key.context.group_id != group_id || key.context.epoch != epoch {
        return Err(incomplete("another group or epoch"));
    }
    if key.context.group_info != group_info_hash(group_info) {
        return Err(incomplete("it does not name the posted GroupInfo"));
    }
    if key.room_epoch != room_epoch {
        return Err(incomplete("another room epoch"));
    }
    if !same(&key.recovery_hpke_key, recovery_hpke_key) {
        return Err(incomplete("not sealed to the room's recovery key"));
    }
    if &key.writer != writer {
        return Err(incomplete("another writer"));
    }
    if writer_is_human != (key.mac.len() == 32) {
        return Err(incomplete(
            "a human device sets the tag, another writer leaves it empty",
        ));
    }
    Ok(key)
}

fn hold_recovery_keys(
    c: &Connection,
    room: &Room,
    signature_key: &[u8],
    hpke_key: &[u8],
) -> Res<()> {
    for key in [signature_key, hpke_key] {
        c.prepare_cached(
            "INSERT OR IGNORE INTO recovery_keys_held (room_id, key) VALUES (?1, ?2)",
        )?
        .execute(params![&room[..], key])?;
    }
    Ok(())
}

fn store_sealed_key(c: &Connection, room: &Room, key: &SealedKey, bytes: &[u8]) -> Res<()> {
    let change = next_change(c, room)?;
    c.prepare_cached(
        "INSERT INTO sealed_keys (room_id, group_id, epoch, writer, room_epoch, recovery_hpke_key, has_mac, change, sealed)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    )?
    .execute(params![
        &room[..],
        key.context.group_id,
        key.context.epoch as i64,
        &key.writer[..],
        key.room_epoch as i64,
        key.recovery_hpke_key,
        !key.mac.is_empty(),
        change,
        bytes
    ])?;
    Ok(())
}

fn store_group_info(
    c: &Connection,
    group_id: &[u8],
    epoch: u64,
    bytes: &[u8],
    keep_all: bool,
) -> Res<()> {
    c.prepare_cached(
        "INSERT INTO group_infos (group_id, epoch, hash, bytes) VALUES (?1, ?2, ?3, ?4)",
    )?
    .execute(params![
        group_id,
        epoch as i64,
        &group_info_hash(bytes)[..],
        bytes
    ])?;
    if !keep_all {
        prune_group_infos(c, group_id, epoch)?;
    }
    Ok(())
}

/// A session group keeps the GroupInfo of its founding, of its current epoch, and of every epoch that still lacks
/// a `SealedKey` with a tag (8.3: a human device checks that GroupInfo before it posts one); the hash of every
/// epoch stays.
fn prune_group_infos(c: &Connection, group_id: &[u8], current: u64) -> Res<()> {
    c.prepare_cached(
        "UPDATE group_infos SET bytes = NULL WHERE group_id = ?1 AND epoch NOT IN (0, ?2) AND bytes IS NOT NULL
           AND EXISTS (SELECT 1 FROM sealed_keys k WHERE k.group_id = ?1 AND k.epoch = group_infos.epoch AND k.has_mac = 1)",
    )?
    .execute(params![group_id, current as i64])?;
    Ok(())
}

fn add_member(c: &Connection, group_id: &[u8], device: &Device, epoch: u64) -> Res<()> {
    let n = c
        .prepare_cached("INSERT OR IGNORE INTO group_members (group_id, device, added_epoch) VALUES (?1, ?2, ?3)")?
        .execute(params![group_id, &device[..], epoch as i64])?;
    if n == 1 {
        return Ok(());
    }
    // The key was a leaf of this group before. It comes back (3.7: a device whose Welcome failed is added
    // again) only if its chain can go on where it was cut: nothing of it lies beyond its Cut (9.0.10).
    let n = c
        .prepare_cached(
            "UPDATE group_members SET added_epoch = ?1, removed_epoch = NULL, cut_seq = NULL, cut_hash = NULL
             WHERE group_id = ?2 AND device = ?3 AND removed_epoch IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM envelopes e WHERE e.group_id = ?2 AND e.sender = ?3 AND e.seq > group_members.cut_seq)",
        )?
        .execute(params![epoch as i64, group_id, &device[..]])?;
    if n == 0 {
        return Err(bad("a device whose chain in this group was cut short of what it wrote, or that is a leaf already"));
    }
    Ok(())
}

// ---- founding the room (5.1.1)

pub struct Founded {
    pub room: Room,
    pub founder: Device,
    pub again: bool,
}

pub fn found_room(x: &Ctx, group_info: &[u8], sealed_key: &[u8]) -> Res<Founded> {
    check_size(x.cfg, &[Some(group_info), Some(sealed_key)])?;
    let (state, snap, signer) = x.obs.open(group_info)?;
    let room_ext = snap
        .room
        .as_ref()
        .ok_or_else(|| bad("a room group carries TrommiRoom"))?;
    let room: Room = snap
        .group_id
        .clone()
        .try_into()
        .map_err(|_| bad("a room id is 32 bytes"))?;
    if snap.epoch != 0 || snap.leaves.len() != 1 || snap.leaves[0] != signer {
        return Err(bad("a group is founded by one device at epoch 0"));
    }
    let founder = signer;
    if !room_ext.agents.is_empty() {
        return Err(bad("a room is founded without agent devices"));
    }
    if same(&room_ext.recovery_signature_key, &founder)
        || same(&room_ext.recovery_hpke_key, &founder)
    {
        return Err(bad("a recovery key that is the device's key"));
    }
    if let Some(held) =
        x.c.prepare_cached("SELECT hash FROM group_infos WHERE group_id = ?1 AND epoch = 0")?
            .query_row([&room[..]], |r| r.get::<_, Vec<u8>>(0))
            .optional()?
    {
        // a lost answer is retried with the same bytes
        return if same(&held, &group_info_hash(group_info)) {
            Ok(Founded {
                room,
                founder,
                again: true,
            })
        } else {
            Err(refuse("room-exists", "this room exists"))
        };
    }
    if x.c
        .prepare_cached("SELECT 1 FROM groups WHERE group_id = ?1")?
        .exists([&room[..]])?
    {
        return Err(refuse("room-exists", "this room exists"));
    }
    let rooms: i64 =
        x.c.query_row("SELECT count(*) FROM rooms", [], |r| r.get(0))?;
    if rooms as u64 >= x.cfg.max_rooms {
        return Err(refuse("too-many", "this hub holds its limit of rooms"));
    }
    let key = check_sealed_key(
        sealed_key,
        &room,
        0,
        group_info,
        0,
        &room_ext.recovery_hpke_key,
        &founder,
        true,
    )?;
    hold_recovery_keys(
        x.c,
        &room,
        &room_ext.recovery_signature_key,
        &room_ext.recovery_hpke_key,
    )?;
    x.c.prepare_cached(
        "INSERT INTO rooms (room_id, founded_at, change, epoch, room_state, recovery_signature_key, recovery_hpke_key)
         VALUES (?1, ?2, 1, 0, ?3, ?4, ?5)",
    )?
    .execute(params![&room[..], x.now as i64, &snap.room_state()[..], room_ext.recovery_signature_key, room_ext.recovery_hpke_key])?;
    x.c.prepare_cached(
        "INSERT INTO groups (group_id, room_id, kind, founder, epoch, room_epoch, epoch_at, founded_change, state)
         VALUES (?1, ?1, 'room', ?2, 0, 0, ?3, 1, ?4)",
    )?
    .execute(params![&room[..], &founder[..], x.now as i64, state.0])?;
    x.c.prepare_cached(
        "INSERT INTO devices (room_id, device, role, added_epoch) VALUES (?1, ?2, 'human', 0)",
    )?
    .execute(params![&room[..], &founder[..]])?;
    add_member(x.c, &room, &founder, 0)?;
    store_group_info(x.c, &room, 0, group_info, true)?;
    store_sealed_key(x.c, &room, &key, sealed_key)?;
    crate::log::info(
        "room_founded",
        json!({ "room": short(&room), "device": short(&founder) }),
    );
    Ok(Founded {
        room,
        founder,
        again: false,
    })
}

// ---- founding a session group (5.2.5)

pub struct Founding {
    pub group_info_0: Vec<u8>,
    pub sealed_key_0: Vec<u8>,
    pub first: CommitBody,
}

pub fn found_session(x: &Ctx, auth: &Auth, f: &Founding, fx: &mut Effects) -> Res<Vec<u8>> {
    auth.member()?;
    check_size(
        x.cfg,
        &[
            Some(&f.group_info_0),
            Some(&f.first.commit),
            Some(&f.first.group_info),
            f.first.welcome.as_deref(),
        ],
    )?;
    let (state, snap, signer) = x.obs.open(&f.group_info_0)?;
    let session = snap
        .session
        .clone()
        .ok_or_else(|| bad("a session group carries TrommiSession"))?;
    if session.room_id != auth.room {
        return Err(refuse("wrong-room", "a session group of another room"));
    }
    let group_id = [&session.room_id[..], &session.session_id[..]].concat();
    if snap.group_id != group_id {
        return Err(bad(
            "a session group's id is the room id and the session id",
        ));
    }
    if snap.epoch != 0 || snap.leaves.len() != 1 || snap.leaves[0] != signer {
        return Err(bad("a group is founded by one device at epoch 0"));
    }
    if signer != auth.device {
        return Err(refuse(
            "wrong-sender",
            "a group is founded by the device that posts it",
        ));
    }
    // A lost answer is retried with the same bytes.
    if let Some(held) =
        x.c.prepare_cached("SELECT hash FROM group_infos WHERE group_id = ?1 AND epoch = 0")?
            .query_row([&group_id], |r| r.get::<_, Vec<u8>>(0))
            .optional()?
    {
        let first: Option<Vec<u8>> =
            x.c.prepare_cached("SELECT digest FROM group_log WHERE group_id = ?1 AND n = 1")?
                .query_row([&group_id], |r| r.get(0))
                .optional()?;
        let row = store::group(x.c, &auth.room, &group_id)?;
        let same_founding = same(&held, &group_info_hash(&f.group_info_0))
            && first.is_some_and(|d| same(&d, &digest(&f.first.commit)))
            && store::sight(x.c, auth, &row)? == Sight::Leaf;
        return if same_founding {
            Ok(group_id)
        } else {
            Err(refuse("replay", "this session exists"))
        };
    }
    let view = store::room_view(x.c, &auth.room)?;
    let room = store::room_row(x.c, &auth.room)?;
    let founder_standing = view.standing(&signer);
    let (kind, parent) = if session.parent == ZERO16 {
        if founder_standing != Standing::Human {
            return Err(bad("a human device founds a main session"));
        }
        (GroupKind::Main, None)
    } else {
        let parent_id = [&session.room_id[..], &session.parent[..]].concat();
        let parent = store::group(x.c, &auth.room, &parent_id)
            .map_err(|_| bad("the parent is no session of this room"))?;
        if parent.kind != GroupKind::Main || !parent.live {
            return Err(bad("the parent is no live main session"));
        }
        if founder_standing != Standing::Agent
            || store::agent_leaf(x.c, &view, &parent_id)? != Some(signer)
        {
            return Err(bad("the opener founds a helper session"));
        }
        let live: i64 =
            x.c.prepare_cached(
                "SELECT count(*) FROM groups WHERE room_id = ?1 AND parent = ?2 AND live = 1",
            )?
            .query_row(params![&auth.room[..], &session.parent[..]], |r| r.get(0))?;
        if live as usize >= x.cfg.helpers_per_main {
            return Err(refuse(
                "too-many",
                "a main session has at most 32 live helper sessions",
            ));
        }
        (GroupKind::Helper, Some(session.parent))
    };
    let key0 = check_sealed_key(
        &f.sealed_key_0,
        &group_id,
        0,
        &f.group_info_0,
        view.epoch,
        &room.recovery_hpke_key,
        &signer,
        founder_standing == Standing::Human,
    )?;
    x.cfg
        .quotas
        .take(x.c, &auth.room, crate::quota::Counted::Groups)?;
    let founded_change = next_change(x.c, &auth.room)?;
    x.c.prepare_cached(
        "INSERT INTO groups (group_id, room_id, kind, session_id, parent, founder, epoch, room_epoch, epoch_at, founded_change, state)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9, ?10)",
    )?
    .execute(params![
        group_id,
        &auth.room[..],
        kind.text(),
        &session.session_id[..],
        parent.as_ref().map(|p| &p[..]),
        &signer[..],
        view.epoch as i64,
        x.now as i64,
        founded_change,
        state.0
    ])?;
    add_member(x.c, &group_id, &signer, 0)?;
    store_group_info(x.c, &group_id, 0, &f.group_info_0, false)?;
    store_sealed_key(x.c, &auth.room, &key0, &f.sealed_key_0)?;
    if f.first.epoch != 0 {
        return Err(bad("the first Commit builds on epoch 0"));
    }
    commit_in(
        x,
        auth,
        &group_id,
        &f.first,
        &mut Scope::default(),
        fx,
        true,
    )?;
    crate::log::info(
        "session_founded",
        json!({ "room": short(&auth.room), "group": short(&group_id[32..]), "kind": kind.text() }),
    );
    Ok(group_id)
}

// ---- Commits (5.4, 14.1)

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Accepted {
    pub epoch: u64,
    pub change: i64,
}

pub fn commit(
    x: &Ctx,
    auth: &Auth,
    group_id: &[u8],
    body: &CommitBody,
    scope: &mut Scope,
    fx: &mut Effects,
) -> Res<Accepted> {
    commit_in(x, auth, group_id, body, scope, fx, false)
}

fn verify_recovery_auth(
    x: &Ctx,
    bytes: Option<&[u8]>,
    group_id: &[u8],
    facts: &CommitFacts,
    note: &CommitNote,
    commit: &[u8],
    joiner: &Device,
    recovery_signature_key: &[u8],
) -> Res<()> {
    let bytes =
        bytes.ok_or_else(|| bad("no join from outside without the recovery authorisation"))?;
    let auth = RecoveryAuth::parse(bytes).map_err(|m| bad(format!("RecoveryAuth: {}", m.0)))?;
    let base_hash: Vec<u8> =
        x.c.prepare_cached("SELECT hash FROM group_infos WHERE group_id = ?1 AND epoch = ?2")?
            .query_row(params![group_id, facts.before.epoch as i64], |r| r.get(0))?;
    let names_this = auth.base.group_id == group_id
        && auth.base.epoch == facts.before.epoch
        && same(&auth.base.group_info, &base_hash)
        && auth.room_epoch == note.room_epoch
        && auth.room_state == note.room_state
        && &auth.joiner == joiner
        && auth.commit == wire::ref_hash("Trommi Commit", commit);
    if !names_this {
        return Err(bad(
            "the recovery authorisation names another Commit, base or joiner",
        ));
    }
    if !x.obs.verify(
        recovery_signature_key,
        "TrommiRecoveryJoin",
        &auth.signed(),
        &auth.signature,
    ) {
        return Err(refuse(
            "bad-signature",
            "the recovery authorisation is not signed by the room's recovery key",
        ));
    }
    Ok(())
}

/// 12.1.7: an Add in the room group, or a key added to `agents`, is the outcome of an invite: the KeyPackage or
/// key of the Request the inviter revealed, the invited role, committed by the inviter.
fn use_invite(
    x: &Ctx,
    room: &Room,
    committer: &Device,
    device: &Device,
    role: u8,
    key_package_ref: Option<&[u8]>,
) -> Res<()> {
    let found: Option<(Vec<u8>, Option<Vec<u8>>)> = x
        .c
        .prepare_cached(
            "SELECT invite_id, revealed_ref FROM invites
             WHERE room_id = ?1 AND revealed_device = ?2 AND role = ?3 AND inviter = ?4 AND used_at IS NULL AND burned_at IS NULL",
        )?
        .query_row(params![&room[..], &device[..], role, &committer[..]], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    let Some((invite_id, revealed_ref)) = found else {
        return Err(refuse(
            "bad-invite",
            "no revealed invite of this committer for this device and role",
        ));
    };
    if let Some(wanted) = key_package_ref {
        if !revealed_ref.is_some_and(|r| same(&r, wanted)) {
            return Err(refuse(
                "bad-invite",
                "the Add is not the KeyPackage of the revealed Request",
            ));
        }
    }
    x.c.prepare_cached("UPDATE invites SET used_at = ?1 WHERE invite_id = ?2")?
        .execute(params![x.now as i64, invite_id])?;
    Ok(())
}

fn revoke(x: &Ctx, room: &Room, device: &Device, epoch: u64, fx: &mut Effects) -> Res<()> {
    x.c.prepare_cached("UPDATE devices SET removed_epoch = ?1 WHERE room_id = ?2 AND device = ?3")?
        .execute(params![epoch as i64, &room[..], &device[..]])?;
    for table in [
        "key_packages",
        "push_subscriptions",
        "live_activities",
        "agent_leases",
        "welcomes",
    ] {
        x.c.prepare_cached(&format!(
            "DELETE FROM {table} WHERE room_id = ?1 AND device = ?2"
        ))?
        .execute(params![&room[..], &device[..]])?;
    }
    fx.recheck.push((*room, *device));
    Ok(())
}

fn commit_in(
    x: &Ctx,
    auth: &Auth,
    group_id: &[u8],
    body: &CommitBody,
    scope: &mut Scope,
    fx: &mut Effects,
    founding: bool,
) -> Res<Accepted> {
    let room = auth.room;
    let row = store::group(x.c, &room, group_id)?;
    check_size(
        x.cfg,
        &[
            Some(&body.commit),
            Some(&body.group_info),
            body.welcome.as_deref(),
            Some(&body.sealed_key),
        ],
    )?;
    if body.epoch < row.epoch {
        // The epoch is taken. If it was taken by these very bytes, this is a retry: the first answer again.
        let taken: Option<(Vec<u8>, i64, Vec<u8>)> = x
            .c
            .prepare_cached("SELECT digest, change, sender FROM group_log WHERE group_id = ?1 AND epoch = ?2 AND kind = 'commit'")?
            .query_row(params![group_id, body.epoch as i64], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .optional()?;
        return match taken {
            Some((d, change, sender))
                if !scope.recovery
                    && same(&d, &digest(&body.commit))
                    && (auth.who == Who::Recovery || same(&sender, &auth.device)) =>
            {
                Ok(Accepted {
                    epoch: body.epoch + 1,
                    change,
                })
            }
            _ => Err(refuse(
                "epoch-taken",
                "another Commit took this epoch: fetch, process, build again",
            )
            .with(json!({ "epoch": row.epoch }))),
        };
    }
    if body.epoch > row.epoch {
        return Err(bad(
            "the Commit builds on an epoch the group has not reached",
        ));
    }
    if !row.live {
        return Err(refuse("gone", "the session is archived"));
    }
    let state = store::group_state(x.c, group_id)?;
    let (new_state, facts) = x.obs.commit(&state, &body.commit)?;
    let note =
        CommitNote::parse(&facts.aad).map_err(|m| bad(format!("the Commit's note: {}", m.0)))?;
    let view = store::room_view(x.c, &room)?;
    let room_row = store::room_row(x.c, &room)?;
    let committer = *facts.by.device();

    // Who posts it: the committer itself; a join from outside also under the recovery key's token; the member
    // Commits of a recovery under that token too, by the device that joined in it.
    match &facts.by {
        By::Member(k) => {
            let fits = if scope.recovery {
                scope.joiner.as_ref() == Some(k)
            } else {
                auth.who != Who::Recovery && &auth.device == k
            };
            if !fits {
                return Err(refuse(
                    "wrong-sender",
                    "a Commit is posted by the device that made it",
                ));
            }
        }
        By::External(j) => {
            if !(auth.who == Who::Recovery || &auth.device == j) {
                return Err(refuse(
                    "wrong-sender",
                    "a join is posted by the joiner or under the recovery key",
                ));
            }
        }
    }

    let mut committer_is_human = true;
    let sealed_to: Vec<u8>;
    // 8.2: the row's `room_epoch` is the note's; in the row of a room Commit that replaces the recovery keys it
    // is the new room epoch, whose state holds the new keys
    let mut row_room_epoch = note.room_epoch;
    let mut room_change = None;
    if row.kind == GroupKind::Room {
        rules::check_note(&note, row.epoch, &view.state, &facts)?;
        let humans = if scope.recovery {
            x.cfg.humans + 1
        } else {
            x.cfg.humans
        };
        let change = rules::check_room_commit(&view, &facts, humans, x.cfg.agents)?;
        if let By::External(joiner) = &facts.by {
            verify_recovery_auth(
                x,
                body.recovery_auth.as_deref(),
                group_id,
                &facts,
                &note,
                &body.commit,
                joiner,
                &room_row.recovery_signature_key,
            )?;
            scope.joiner = Some(*joiner);
        } else if body.recovery_auth.is_some() {
            return Err(bad("a recovery authorisation on a member's Commit"));
        }
        for add in &facts.adds {
            use_invite(
                x,
                &room,
                &committer,
                &add.device,
                1,
                Some(&add.key_package_ref),
            )?;
        }
        for agent in &change.agents_added {
            use_invite(x, &room, &committer, agent, 2, None)?;
        }
        let after = facts.after.room.as_ref().expect("checked by the rules");
        if change.recovery_keys_replaced {
            // 8.6: the code is replaced in one request that brings the RecoveryLink
            match &scope.link {
                Some(link) => {
                    if link.room_id != room
                        || !same(&link.new_recovery_hpke_key, &after.recovery_hpke_key)
                    {
                        return Err(refuse(
                            "incomplete",
                            "the RecoveryLink is not for the new recovery key",
                        ));
                    }
                }
                None if scope.link_pending => {}
                None => {
                    return Err(refuse(
                        "incomplete",
                        "new recovery keys come with their RecoveryLink and the account's copies",
                    ))
                }
            }
            if scope.keys_replaced {
                return Err(bad("the recovery keys are replaced once per request"));
            }
            // 8.1: a recovery key is no device's key, now or ever: a key that has or had a role would no longer
            // be told apart at sign-in
            for key in [&after.recovery_signature_key, &after.recovery_hpke_key] {
                if x.c
                    .prepare_cached("SELECT 1 FROM devices WHERE room_id = ?1 AND device = ?2")?
                    .exists(params![&room[..], key])?
                {
                    return Err(bad("a recovery key that is or was a device's key"));
                }
            }
            // 8.6: never a key the room held before, as either of the two
            for key in [&after.recovery_signature_key, &after.recovery_hpke_key] {
                if x.c
                    .prepare_cached(
                        "SELECT 1 FROM recovery_keys_held WHERE room_id = ?1 AND key = ?2",
                    )?
                    .exists(params![&room[..], key])?
                {
                    return Err(bad("a recovery key the room held before"));
                }
            }
            if after.recovery_signature_key == after.recovery_hpke_key {
                return Err(bad("one key for both of the recovery's uses"));
            }
            hold_recovery_keys(
                x.c,
                &room,
                &after.recovery_signature_key,
                &after.recovery_hpke_key,
            )?;
            scope.keys_replaced = true;
            row_room_epoch = facts.after.epoch;
        }
        sealed_to = after.recovery_hpke_key.clone();
        room_change = Some(change);
    } else {
        rules::check_note(&note, view.epoch, &view.state, &facts)?;
        if facts.changes_extensions || facts.before.session != facts.after.session {
            return Err(bad("a session group's TrommiSession never changes"));
        }
        let kind = store::session_kind(x.c, &view, &row)?;
        let was_stale = rules::is_stale(kind, &view, &facts.before.leaves);
        rules::check_session_commit(kind, &view, &facts, founding, was_stale, scope.recovery)?;
        if let By::External(joiner) = &facts.by {
            verify_recovery_auth(
                x,
                body.recovery_auth.as_deref(),
                group_id,
                &facts,
                &note,
                &body.commit,
                joiner,
                &room_row.recovery_signature_key,
            )?;
            scope.joined.push(group_id.to_vec());
        } else if body.recovery_auth.is_some() {
            return Err(bad("a recovery authorisation on a member's Commit"));
        }
        if kind == SessionKind::Main {
            // 5.2.2: an agent device is the agent leaf of at most one live main session
            for add in facts
                .adds
                .iter()
                .filter(|a| view.standing(&a.device) == Standing::Agent)
            {
                let elsewhere = x
                    .c
                    .prepare_cached(
                        "SELECT 1 FROM group_members m JOIN groups g ON g.group_id = m.group_id
                         WHERE m.device = ?1 AND m.removed_epoch IS NULL AND g.room_id = ?2 AND g.kind = 'main' AND g.live = 1 AND g.group_id != ?3",
                    )?
                    .exists(params![&add.device[..], &room[..], group_id])?;
                if elsewhere {
                    return Err(bad(
                        "the agent device is the agent leaf of another live main session",
                    ));
                }
            }
        }
        committer_is_human = view.standing(&committer) == Standing::Human;
        sealed_to = room_row.recovery_hpke_key.clone();
    }

    // 8.1, the other way round: no device comes in under the room's recovery signature key
    let incoming = facts.adds.iter().map(|a| &a.device).chain(match &facts.by {
        By::External(j) => Some(j),
        By::Member(_) => None,
    });
    for device in incoming {
        let recovery_key = facts
            .after
            .room
            .as_ref()
            .map_or(&room_row.recovery_signature_key, |r| {
                &r.recovery_signature_key
            });
        if same(device, recovery_key) || same(device, &room_row.recovery_signature_key) {
            return Err(bad("a device under the room's recovery key"));
        }
    }

    // 14.1: the GroupInfo of the new epoch, a Welcome for every Add, the SealedKey.
    x.obs
        .check_group_info(&body.group_info, &facts.after, &committer)?;
    match (&body.welcome, facts.adds.is_empty()) {
        (None, true) => {}
        (None, false) => {
            return Err(refuse(
                "incomplete",
                "a Commit that adds comes with its Welcome",
            ))
        }
        (Some(_), true) => return Err(bad("a Welcome without an Add")),
        (Some(w), false) => {
            let mut receivers = x.obs.welcome_receivers(w)?;
            let mut wanted: Vec<Vec<u8>> = facts
                .adds
                .iter()
                .map(|a| a.key_package_ref.clone())
                .collect();
            receivers.sort();
            wanted.sort();
            if receivers != wanted {
                return Err(bad("the Welcome is not for exactly the added KeyPackages"));
            }
        }
    }
    let new_epoch = facts.after.epoch;
    let key = check_sealed_key(
        &body.sealed_key,
        group_id,
        new_epoch,
        &body.group_info,
        row_room_epoch,
        &sealed_to,
        &committer,
        committer_is_human,
    )?;

    // ---- accepted: write it
    let change = next_change(x.c, &room)?;
    let n = row.log_n + 1;
    x.c.prepare_cached(
        "INSERT INTO group_log (group_id, n, room_id, epoch, kind, sender, at, change, recovery_auth, digest, bytes)
         VALUES (?1, ?2, ?3, ?4, 'commit', ?5, ?6, ?7, ?8, ?9, ?10)",
    )?
    .execute(params![group_id, n, &room[..], row.epoch as i64, &committer[..], x.now as i64, change, body.recovery_auth, &digest(&body.commit)[..], body.commit])?;
    x.c.prepare_cached("UPDATE groups SET epoch = ?1, room_epoch = ?2, epoch_at = ?3, log_n = ?4, state = ?5 WHERE group_id = ?6")?
        .execute(params![new_epoch as i64, note.room_epoch as i64, x.now as i64, n, new_state.0, group_id])?;
    store_group_info(
        x.c,
        group_id,
        new_epoch,
        &body.group_info,
        row.kind == GroupKind::Room,
    )?;
    store_sealed_key(x.c, &room, &key, &body.sealed_key)?;

    // a device that commits in a group has joined it
    if matches!(facts.by, By::Member(_)) {
        joined(x.c, group_id, &committer)?;
    }
    // the leaves
    for cut in &note.cuts {
        crate::content::cut_chain(x.c, &room, group_id, cut, fx)?;
        x.c.prepare_cached(
            "UPDATE group_members SET removed_epoch = ?1, cut_seq = ?2, cut_hash = ?3 WHERE group_id = ?4 AND device = ?5 AND removed_epoch IS NULL",
        )?
        .execute(params![new_epoch as i64, cut.seq as i64, &cut.hash[..], group_id, &cut.device[..]])?;
        x.c.prepare_cached("DELETE FROM welcomes WHERE group_id = ?1 AND device = ?2")?
            .execute(params![group_id, &cut.device[..]])?;
        fx.recheck.push((room, cut.device));
    }
    if let By::External(joiner) = &facts.by {
        add_member(x.c, group_id, joiner, new_epoch)?;
    }
    for add in &facts.adds {
        add_member(x.c, group_id, &add.device, new_epoch)?;
        if view.standing(&add.device) == Standing::Helper && row.kind == GroupKind::Helper {
            let n = x.c.prepare_cached("INSERT OR IGNORE INTO devices (room_id, device, role, added_epoch) VALUES (?1, ?2, 'helper', ?3)")?
                .execute(params![&room[..], &add.device[..], view.epoch as i64])?;
            if n == 1 {
                x.cfg
                    .quotas
                    .take(x.c, &room, crate::quota::Counted::HelperDevices)?;
            }
        }
        let welcome = body.welcome.as_ref().expect("checked above");
        x.c.prepare_cached("INSERT INTO welcomes (room_id, device, group_id, at, bytes) VALUES (?1, ?2, ?3, ?4, ?5)")?
            .execute(params![&room[..], &add.device[..], group_id, x.now as i64, welcome])?;
        fx.events.push(Event {
            room,
            audience: Audience {
                humans: false,
                others: vec![add.device],
                except: None,
            },
            name: "welcome",
            change: None,
            data: json!({ "group_id": b64(group_id) }),
        });
    }

    // the room's own state
    if let Some(change) = &room_change {
        let after = facts.after.room.as_ref().expect("checked by the rules");
        x.c.prepare_cached("UPDATE rooms SET epoch = ?1, room_state = ?2, recovery_signature_key = ?3, recovery_hpke_key = ?4 WHERE room_id = ?5")?
            .execute(params![new_epoch as i64, &facts.after.room_state()[..], after.recovery_signature_key, after.recovery_hpke_key, &room[..]])?;
        for (device, role) in change
            .humans_added
            .iter()
            .map(|d| (d, "human"))
            .chain(change.agents_added.iter().map(|d| (d, "agent")))
        {
            let n = x
                .c
                .prepare_cached("INSERT OR IGNORE INTO devices (room_id, device, role, added_epoch) VALUES (?1, ?2, ?3, ?4)")?
                .execute(params![&room[..], &device[..], role, new_epoch as i64])?;
            if n == 0 {
                return Err(bad("a key that already has or had a role in the room"));
            }
            x.cfg
                .quotas
                .take(x.c, &room, crate::quota::Counted::Devices)?;
        }
        for device in change
            .humans_removed
            .iter()
            .chain(change.agents_removed.iter())
        {
            revoke(x, &room, device, new_epoch, fx)?;
        }
        if change.recovery_keys_replaced {
            if let Some(link) = &scope.link {
                let link_change = next_change(x.c, &room)?;
                x.c.prepare_cached("INSERT INTO recovery_links (room_id, room_epoch, recovery_hpke_key, change, sealed) VALUES (?1, ?2, ?3, ?4, ?5)")?
                    .execute(params![&room[..], new_epoch as i64, link.new_recovery_hpke_key, link_change, link.encode()])?;
            }
            fx.recovery_replaced.push(room);
        }
        // a rehearsal of a recovery's part is rolled back: it is not an event of the room
        let log: fn(&str, Value) = if scope.link_pending {
            |_, _| {}
        } else {
            crate::log::info
        };
        log(
            "room_commit",
            json!({ "room": short(&room), "epoch": new_epoch, "added": change.humans_added.len() + change.agents_added.len(),
                    "removed": change.humans_removed.len() + change.agents_removed.len(), "join": change.joined_from_outside.is_some() }),
        );
    }

    let row_after = store::group(x.c, &room, group_id)?;
    fx.events.push(Event {
        room,
        audience: store::public_audience(x.c, &row_after)?,
        name: "log",
        change: Some(change),
        data: json!({ "group_id": b64(group_id), "n": n, "kind": "commit", "epoch": row.epoch }),
    });
    fx.live.push(room);
    Ok(Accepted {
        epoch: new_epoch,
        change,
    })
}

// ---- application messages (7, 14.3)

pub fn message(
    x: &Ctx,
    auth: &Auth,
    group_id: &[u8],
    epoch: u64,
    bytes: &[u8],
    relay: bool,
    fx: &mut Effects,
) -> Res<Value> {
    auth.member()?;
    if bytes.len() > x.cfg.message_limit {
        return Err(refuse(
            "too-large",
            "an application message is at most 48 KiB",
        ));
    }
    let row = store::group(x.c, &auth.room, group_id)?;
    if !store::is_leaf(x.c, group_id, &auth.device)? {
        return Err(refuse("not-member", "only a leaf of the group sends in it"));
    }
    let (in_group, in_epoch) = x.obs.application_message(bytes)?;
    if in_group != group_id {
        return Err(refuse("bad-format", "a message of another group"));
    }
    let d = digest(bytes);
    if !relay {
        if let Some(n) = x
            .c
            .prepare_cached("SELECT n, sender FROM group_log WHERE group_id = ?1 AND digest = ?2")?
            .query_row(params![group_id, &d[..]], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))
            })
            .optional()?
        {
            let (n, sender) = n;
            // a repeated post of the same bytes by the same device: the first answer again
            return if same(&sender, &auth.device) {
                Ok(json!({ "n": n }))
            } else {
                Err(refuse("replay", "these bytes are in the log"))
            };
        }
    }
    // (a stored message posted again got its first answer above, also for a group archived since)
    if !row.live {
        return Err(refuse("gone", "the session is archived"));
    }
    if in_epoch != row.epoch || epoch != row.epoch {
        return Err(refuse(
            "wrong-epoch",
            "not the group's current epoch: process the log, encrypt again",
        )
        .with(json!({ "epoch": row.epoch })));
    }
    let view = store::room_view(x.c, &auth.room)?;
    if store::is_stale(x.c, &view, &row)? {
        return Err(refuse("stale-session", "the group waits for a Remove"));
    }
    if relay {
        // 7.2: a stroke piece. Room group, human devices; passed on, never stored, not in the log.
        if row.kind != GroupKind::Room {
            return Err(refuse("forbidden", "only the room group relays"));
        }
        joined(x.c, group_id, &auth.device)?;
        fx.events.push(Event {
            room: auth.room,
            audience: Audience { humans: true, others: vec![], except: Some(auth.device) },
            name: "relay",
            change: None,
            data: json!({ "group_id": b64(group_id), "epoch": epoch, "sender": b64(&auth.device), "message": b64(bytes) }),
        });
        return Ok(json!({ "n": Value::Null }));
    }
    let change = next_change(x.c, &auth.room)?;
    let n = row.log_n + 1;
    x.c.prepare_cached(
        "INSERT INTO group_log (group_id, n, room_id, epoch, kind, sender, at, change, digest, bytes) VALUES (?1, ?2, ?3, ?4, 'message', ?5, ?6, ?7, ?8, ?9)",
    )?
    .execute(params![group_id, n, &auth.room[..], epoch as i64, &auth.device[..], x.now as i64, change, &d[..], bytes])?;
    x.c.prepare_cached("UPDATE groups SET log_n = ?1 WHERE group_id = ?2")?
        .execute(params![n, group_id])?;
    joined(x.c, group_id, &auth.device)?;
    fx.events.push(Event {
        room: auth.room,
        audience: store::leaf_audience(x.c, group_id)?,
        name: "log",
        change: Some(change),
        data: json!({ "group_id": b64(group_id), "n": n, "kind": "message", "epoch": epoch }),
    });
    Ok(json!({ "n": n }))
}

/// A device that writes in a group has joined it: its Welcome is no longer needed.
pub fn joined(c: &Connection, group_id: &[u8], device: &Device) -> Res<()> {
    c.prepare_cached("DELETE FROM welcomes WHERE group_id = ?1 AND device = ?2")?
        .execute(params![group_id, &device[..]])?;
    Ok(())
}

// ---- reading the log, GroupInfo, Welcomes, the list of groups

pub fn log(
    c: &Connection,
    auth: &Auth,
    group_id: &[u8],
    after: i64,
    limit: i64,
    commits: bool,
) -> Res<Value> {
    let row = store::group(c, &auth.room, group_id)?;
    let sight = store::sight(c, auth, &row)?;
    if sight == Sight::None {
        return Err(refuse("not-found", "no such group"));
    }
    if after < row.log_kept_from {
        return Err(refuse(
            "gone",
            "the log before this point is no longer kept",
        ));
    }
    // public sight: the Commits only; any reader may ask for the Commits alone (they are kept when messages are not)
    let only_commits = commits || sight == Sight::Public;
    let mut s = c.prepare_cached(
        "SELECT n, change, epoch, at, kind, bytes, recovery_auth, sender FROM group_log
         WHERE group_id = ?1 AND n > ?2 AND (?3 = 0 OR kind = 'commit') ORDER BY n LIMIT ?4",
    )?;
    let mut rows = s.query(params![group_id, after, only_commits, limit + 1])?;
    let (mut items, mut bytes, mut more) = (Vec::new(), 0usize, false);
    while let Some(r) = rows.next()? {
        if items.len() as i64 == limit {
            more = true;
            break;
        }
        let item = log_item(group_id, r)?;
        bytes += item["bytes"].as_str().map_or(0, str::len);
        // an answer holds at most 8 MiB; the first entry always goes in
        if bytes > crate::content::ANSWER_BYTES && !items.is_empty() {
            more = true;
            break;
        }
        items.push(item);
    }
    Ok(json!({ "items": items, "more": more }))
}

/// The log entry at a change number, for the stream.
/// How long after its removal a device may still fetch the Commits that prove it (13.5).
pub const REMOVAL_KEPT_MS: u64 = 30 * 86_400_000;
/// Commits per answer of that route.
pub const REMOVAL_PAGE: i64 = 200;

/// Where a device was removed in a group, if it was and that is not longer ago than `REMOVAL_KEPT_MS`: the log
/// number of the removing Commit. The room group: the Commit that revoked the device (a human device's Remove,
/// an agent's leaving `agents`); a session group: the Commit that removed its leaf.
fn removal_at(
    c: &Connection,
    room: &Room,
    device: &Device,
    group_id: &[u8],
    now: u64,
) -> Res<Option<i64>> {
    let epoch: Option<i64> = if group_id == &room[..] {
        c.prepare_cached("SELECT removed_epoch FROM devices WHERE room_id = ?1 AND device = ?2")?
            .query_row(params![&room[..], &device[..]], |r| r.get(0))
            .optional()?
            .flatten()
    } else {
        c.prepare_cached(
            "SELECT m.removed_epoch FROM group_members m JOIN groups g ON g.group_id = m.group_id
             WHERE m.group_id = ?1 AND m.device = ?2 AND g.room_id = ?3",
        )?
        .query_row(params![group_id, &device[..], &room[..]], |r| r.get(0))
        .optional()?
        .flatten()
    };
    let Some(epoch) = epoch else {
        return Ok(None);
    };
    // the Commit that made that epoch
    let found: Option<(i64, i64)> = c
        .prepare_cached(
            "SELECT n, at FROM group_log WHERE group_id = ?1 AND epoch = ?2 AND kind = 'commit'",
        )?
        .query_row(params![group_id, epoch - 1], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    Ok(found
        .filter(|(_, at)| (*at as u64).saturating_add(REMOVAL_KEPT_MS) > now)
        .map(|(n, _)| n))
}

/// Whether a key that has no standing in the room was removed from it, or from a group of it, so recently that
/// it may still sign in to fetch the proof (`removal`).
pub fn removed_lately(c: &Connection, room: &Room, device: &Device, now: u64) -> Res<bool> {
    if removal_at(c, room, device, &room[..], now)?.is_some() {
        return Ok(true);
    }
    let mut s = c.prepare_cached(
        "SELECT m.group_id FROM group_members m JOIN groups g ON g.group_id = m.group_id
         WHERE m.device = ?1 AND g.room_id = ?2 AND m.removed_epoch IS NOT NULL LIMIT 64",
    )?;
    let groups = s
        .query_map(params![&device[..], &room[..]], |r| r.get::<_, Vec<u8>>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for group in groups {
        if removal_at(c, room, device, &group, now)?.is_some() {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `GET /v2/groups/{group}/removal?after=`: for a device that was removed, the Commits of that group after
/// `after` up to and including the one that removed it — public group state it could read as a member — so
/// that it can verify its removal itself (13.5). Nothing else, and nothing after that Commit. One answer for a
/// device that was never there, was not removed, or was removed too long ago.
pub fn removal(
    c: &Connection,
    room: &Room,
    device: &Device,
    group_id: &[u8],
    after: i64,
    now: u64,
) -> Res<Value> {
    let Some(last) = removal_at(c, room, device, group_id, now)? else {
        return Err(refuse("not-found", "no removal to show"));
    };
    let mut s = c.prepare_cached(
        "SELECT n, change, epoch, at, kind, bytes, recovery_auth, sender FROM group_log
         WHERE group_id = ?1 AND n > ?2 AND n <= ?3 AND kind = 'commit' ORDER BY n LIMIT ?4",
    )?;
    let mut rows = s.query(params![group_id, after, last, REMOVAL_PAGE + 1])?;
    let (mut items, mut bytes, mut more) = (Vec::new(), 0usize, false);
    while let Some(r) = rows.next()? {
        let item = log_item(group_id, r)?;
        bytes += item["bytes"].as_str().map_or(0, str::len);
        if items.len() as i64 == REMOVAL_PAGE
            || (bytes > crate::content::ANSWER_BYTES && !items.is_empty())
        {
            more = true;
            break;
        }
        items.push(item);
    }
    Ok(json!({ "items": items, "more": more, "removed_at": last }))
}

pub fn log_at(c: &Connection, room: &Room, change: i64) -> Res<Option<Value>> {
    Ok(c.prepare_cached("SELECT n, change, epoch, at, kind, bytes, recovery_auth, sender, group_id FROM group_log WHERE room_id = ?1 AND change = ?2")?
        .query_row(params![&room[..], change], |r| log_item(&r.get::<_, Vec<u8>>(8)?, r))
        .optional()?)
}

/// Columns: n, change, epoch, at, kind, bytes, recovery_auth, sender.
pub fn log_item(group_id: &[u8], r: &rusqlite::Row) -> rusqlite::Result<Value> {
    let kind: String = r.get(4)?;
    let mut item = json!({
        "group_id": b64(group_id),
        "n": r.get::<_, i64>(0)?,
        "change": r.get::<_, i64>(1)?,
        "epoch": r.get::<_, i64>(2)?,
        "at": r.get::<_, i64>(3)?,
        "kind": kind,
        "bytes": b64(&r.get::<_, Vec<u8>>(5)?),
        "sender": b64(&r.get::<_, Vec<u8>>(7)?),
    });
    if let Some(auth) = r.get::<_, Option<Vec<u8>>>(6)? {
        item["recovery_auth"] = json!(b64(&auth));
    }
    Ok(item)
}

pub fn info(c: &Connection, auth: &Auth, group_id: &[u8], epoch: Option<u64>) -> Res<Value> {
    let row = store::group(c, &auth.room, group_id)?;
    if store::sight(c, auth, &row)? == Sight::None {
        return Err(refuse("not-found", "no such group"));
    }
    let epoch = epoch.unwrap_or(row.epoch);
    let bytes: Option<Option<Vec<u8>>> = c
        .prepare_cached("SELECT bytes FROM group_infos WHERE group_id = ?1 AND epoch = ?2")?
        .query_row(params![group_id, epoch as i64], |r| r.get(0))
        .optional()?;
    match bytes {
        Some(Some(b)) => Ok(json!({ "epoch": epoch, "group_info": b64(&b) })),
        Some(None) => Err(refuse(
            "gone",
            "the GroupInfo of this epoch is no longer kept",
        )),
        None => Err(refuse("not-found", "the group has not reached this epoch")),
    }
}

pub fn welcomes(c: &Connection, auth: &Auth) -> Res<Value> {
    let mut s = c.prepare_cached(
        "SELECT group_id, bytes, at FROM welcomes WHERE room_id = ?1 AND device = ?2 ORDER BY id",
    )?;
    let rows = s
        .query_map(params![&auth.room[..], &auth.device[..]], |r| {
            Ok(json!({ "group_id": b64(&r.get::<_, Vec<u8>>(0)?), "welcome": b64(&r.get::<_, Vec<u8>>(1)?), "at": r.get::<_, i64>(2)? }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Value::Array(rows))
}

pub fn group_list(c: &Connection, auth: &Auth) -> Res<Vec<Value>> {
    let view = store::room_view(c, &auth.room)?;
    let mut out = Vec::new();
    for row in store::groups_of_room(c, &auth.room)? {
        // a human device and the recovery key see all, another device its own groups and the room group
        let shown = match auth.who {
            Who::Human | Who::Recovery => true,
            _ => row.kind == GroupKind::Room || store::is_leaf(c, &row.group_id, &auth.device)?,
        };
        if !shown {
            continue;
        }
        let leaves = store::leaves(c, &row.group_id)?;
        out.push(json!({
            "group_id": b64(&row.group_id),
            "kind": row.kind.text(),
            "session_id": row.session_id.map(|s| b64(&s)),
            "parent": row.parent.map(|s| b64(&s)),
            "epoch": row.epoch,
            "room_epoch": row.room_epoch,
            "live": row.live,
            "stale": store::is_stale(c, &view, &row)?,
            "leaves": leaves.iter().map(|d| b64(d)).collect::<Vec<_>>(),
        }));
    }
    Ok(out)
}

pub fn archive(x: &Ctx, auth: &Auth, group_id: &[u8], fx: &mut Effects) -> Res<Value> {
    auth.human()?;
    let row = store::group(x.c, &auth.room, group_id)?;
    if row.kind == GroupKind::Room {
        return Err(refuse("forbidden", "the room group is not archived"));
    }
    if row.live {
        x.c.prepare_cached("UPDATE groups SET live = 0, archived_at = ?1 WHERE group_id = ?2")?
            .execute(params![x.now as i64, group_id])?;
        fx.events.push(Event {
            room: auth.room,
            audience: store::leaf_audience(x.c, group_id)?,
            name: "presence",
            change: None,
            data: json!({ "group_id": b64(group_id), "archived": true }),
        });
        fx.live.push(auth.room);
    }
    Ok(json!({ "archived": true }))
}

/// 14.7: a leaf that cannot merge an accepted Commit says so; the hub tells the human devices who made it.
pub fn reject(x: &Ctx, auth: &Auth, group_id: &[u8], n: i64, fx: &mut Effects) -> Res<Value> {
    auth.member()?;
    let row = store::group(x.c, &auth.room, group_id)?;
    if !store::is_leaf(x.c, group_id, &auth.device)? {
        return Err(refuse("not-found", "no such group"));
    }
    if !row.live {
        return Err(refuse("gone", "the session is archived"));
    }
    let committer: Vec<u8> =
        x.c.prepare_cached(
            "SELECT sender FROM group_log WHERE group_id = ?1 AND n = ?2 AND kind = 'commit'",
        )?
        .query_row(params![group_id, n], |r| r.get(0))
        .optional()?
        .ok_or_else(|| refuse("not-found", "no such Commit"))?;
    add_request(
        x,
        auth,
        "reject",
        Some(group_id),
        None,
        Some(n),
        json!({ "committer": b64(&committer) }),
        fx,
    )
}

// ---- key packages (14.2)

pub fn put_key_packages(
    x: &Ctx,
    auth: &Auth,
    single_use: &[Vec<u8>],
    last_resort: Option<&[u8]>,
) -> Res<Value> {
    auth.member()?;
    let expires = (x.now + x.cfg.key_package_days * 86_400_000) as i64;
    let insert = |bytes: &[u8], wanted_last_resort: bool| -> Res<()> {
        let facts = x.obs.key_package(bytes)?;
        if facts.device != auth.device {
            return Err(refuse(
                "bad-key-package",
                "a KeyPackage is uploaded by the device it names",
            ));
        }
        if facts.last_resort != wanted_last_resort {
            return Err(refuse(
                "bad-key-package",
                "the last_resort mark does not fit",
            ));
        }
        // 14.2: a single-use KeyPackage is handed out once, by this hub, in any room, for good
        if !wanted_last_resort
            && x.c
                .prepare_cached("SELECT 1 FROM spent_key_packages WHERE ref = ?1")?
                .exists([&facts.key_package_ref])?
        {
            return Ok(());
        }
        // it was valid when it was checked on the pool; it must still be now, and is handed out no longer than
        // its own lifetime says
        if facts.not_after <= x.now / 1000 {
            return Err(refuse(
                "bad-key-package",
                "the KeyPackage's lifetime is over",
            ));
        }
        let expires = expires.min((facts.not_after.min(i64::MAX as u64 / 1000) * 1000) as i64);
        if wanted_last_resort {
            x.c.prepare_cached("DELETE FROM key_packages WHERE room_id = ?1 AND device = ?2 AND last_resort = 1 AND ref != ?3")?
                .execute(params![&auth.room[..], &auth.device[..], facts.key_package_ref])?;
        }
        x.c.prepare_cached(
            "INSERT OR IGNORE INTO key_packages (room_id, device, ref, last_resort, uploaded_at, expires_at, bytes) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?
        .execute(params![&auth.room[..], &auth.device[..], facts.key_package_ref, wanted_last_resort, x.now as i64, expires, bytes])?;
        Ok(())
    };
    for kp in single_use {
        insert(kp, false)?;
    }
    if let Some(kp) = last_resort {
        insert(kp, true)?;
    }
    // A device keeps at most 100 single-use KeyPackages: with more, the oldest go. (A device that signs in again
    // uploads a fresh set beside what was left of the last; that is no fault of its.)
    x.c.prepare_cached(
        "DELETE FROM key_packages WHERE room_id = ?1 AND device = ?2 AND last_resort = 0 AND id NOT IN
           (SELECT id FROM key_packages WHERE room_id = ?1 AND device = ?2 AND last_resort = 0 ORDER BY id DESC LIMIT ?3)",
    )?
    .execute(params![&auth.room[..], &auth.device[..], x.cfg.key_packages as i64])?;
    let unused: i64 = x
        .c
        .prepare_cached("SELECT count(*) FROM key_packages WHERE room_id = ?1 AND device = ?2 AND last_resort = 0 AND expires_at > ?3")?
        .query_row(params![&auth.room[..], &auth.device[..], x.now as i64], |r| r.get(0))?;
    Ok(json!({ "unused": unused }))
}

/// One KeyPackage of each named device, all or nothing: a single-use one (then gone), else the last-resort one;
/// none that was uploaded more than 90 days ago.
pub fn claim_key_packages(x: &Ctx, auth: &Auth, devices: &[Device]) -> Res<Value> {
    // founding and adding are a human device's and an opener's acts; a helper device adds nobody
    if !matches!(auth.who, Who::Human | Who::Agent) {
        return Err(refuse(
            "forbidden",
            "only a human or agent device claims KeyPackages",
        ));
    }
    let mut out = serde_json::Map::new();
    for (i, device) in devices.iter().enumerate() {
        if devices[..i].contains(device) {
            return Err(refuse("bad-format", "a device is named once"));
        }
        let found: Option<(i64, bool, Vec<u8>, Vec<u8>)> = x
            .c
            .prepare_cached(
                "SELECT id, last_resort, bytes, ref FROM key_packages WHERE room_id = ?1 AND device = ?2 AND expires_at > ?3
                   AND (last_resort = 1 OR ref NOT IN (SELECT ref FROM spent_key_packages))
                 ORDER BY last_resort, id LIMIT 1",
            )?
            .query_row(params![&auth.room[..], &device[..], x.now as i64], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .optional()?;
        let Some((id, last_resort, bytes, package_ref)) = found else {
            // the transaction is rolled back: what was taken for the others is not used up
            return Err(refuse("not-found", "no KeyPackage for a device")
                .with(json!({ "device": b64(device) })));
        };
        if !last_resort {
            // handed out once: its reference is kept for good, hub-wide, so that the same package is never
            // handed out again, in this room or another, whatever is uploaded or removed later
            x.c.prepare_cached(
                "INSERT OR IGNORE INTO spent_key_packages (ref, at) VALUES (?1, ?2)",
            )?
            .execute(params![&package_ref, x.now as i64])?;
            // it goes from every room that holds it
            let _ = id;
            x.c.prepare_cached("DELETE FROM key_packages WHERE ref = ?1 AND last_resort = 0")?
                .execute([&package_ref])?;
        }
        out.insert(b64(device), json!(b64(&bytes)));
    }
    Ok(json!({ "key_packages": out }))
}

// ---- sealed keys (8.3)

pub fn put_sealed_key(x: &Ctx, auth: &Auth, bytes: &[u8]) -> Res<Value> {
    auth.member()?;
    let key = SealedKey::parse(bytes)?;
    let row = store::group(x.c, &auth.room, &key.context.group_id)?;
    if key.writer != auth.device {
        return Err(refuse(
            "wrong-sender",
            "a SealedKey is posted by its writer",
        ));
    }
    // 8.3: a posted row comes from a human device that is its writer, with a tag (a row without one comes only
    // with the Commit of a writer that cannot set it)
    let human = auth.who == Who::Human;
    if !human {
        return Err(refuse(
            "forbidden",
            "a SealedKey is posted by a human device",
        ));
    }
    if let Some(held) =
        x.c.prepare_cached(
            "SELECT sealed FROM sealed_keys WHERE group_id = ?1 AND epoch = ?2 AND writer = ?3",
        )?
        .query_row(
            params![
                key.context.group_id,
                key.context.epoch as i64,
                &key.writer[..]
            ],
            |r| r.get::<_, Vec<u8>>(0),
        )
        .optional()?
    {
        return if same(&held, bytes) {
            Ok(json!({ "stored": true }))
        } else {
            Err(refuse(
                "replay",
                "this writer filed another key for this epoch",
            ))
        };
    }
    if !row.live {
        return Err(refuse("gone", "the session is archived"));
    }
    let view = store::room_view(x.c, &auth.room)?;
    let room = store::room_row(x.c, &auth.room)?;
    if key.room_epoch < view.epoch {
        return Err(refuse(
            "room-behind",
            "the SealedKey names an older room epoch",
        ));
    }
    // 5.2.8: the hub takes nothing for a stale group but the Commit that repairs it, with its SealedKey
    if store::is_stale(x.c, &view, &row)? {
        return Err(refuse("stale-session", "the group waits for a Remove"));
    }
    let hash: Option<Vec<u8>> =
        x.c.prepare_cached("SELECT hash FROM group_infos WHERE group_id = ?1 AND epoch = ?2")?
            .query_row(
                params![key.context.group_id, key.context.epoch as i64],
                |r| r.get(0),
            )
            .optional()?;
    let fits = key.room_epoch == view.epoch
        && same(&key.recovery_hpke_key, &room.recovery_hpke_key)
        && hash.is_some_and(|h| same(&h, &key.context.group_info))
        && human == (key.mac.len() == 32);
    if !fits {
        return Err(refuse("incomplete", "the SealedKey does not name the GroupInfo the hub holds, the room's recovery key, or its tag"));
    }
    store_sealed_key(x.c, &auth.room, &key, bytes)?;
    // the epoch has its tagged key now: its GroupInfo is no longer needed, unless it is the current one
    if row.kind != GroupKind::Room {
        prune_group_infos(x.c, &row.group_id, row.epoch)?;
    }
    Ok(json!({ "stored": true }))
}

pub fn sealed_keys(c: &Connection, auth: &Auth, after: i64, limit: i64) -> Res<Value> {
    if !matches!(auth.who, Who::Human | Who::Recovery) {
        return Err(refuse(
            "forbidden",
            "sealed keys are read by human devices and the recovery key",
        ));
    }
    // Sealed keys and RecoveryLinks are two lists under one cursor: each is read up to the limit, and the answer
    // goes as far as both are complete, so that the next call (`after` = the answer's `change`) misses nothing.
    let mut q = c.prepare_cached("SELECT change, sealed FROM sealed_keys WHERE room_id = ?1 AND change > ?2 ORDER BY change LIMIT ?3")?;
    let mut rows: Vec<(i64, Value)> = q
        .query_map(params![&auth.room[..], after, limit + 1], |r| {
            let change: i64 = r.get(0)?;
            Ok((
                change,
                json!({ "change": change, "sealed_key": b64(&r.get::<_, Vec<u8>>(1)?) }),
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut q = c.prepare_cached("SELECT room_epoch, change, sealed FROM recovery_links WHERE room_id = ?1 AND change > ?2 ORDER BY change LIMIT ?3")?;
    let mut links: Vec<(i64, Value)> = q
        .query_map(params![&auth.room[..], after, limit + 1], |r| {
            let change: i64 = r.get(1)?;
            Ok((change, json!({ "room_epoch": r.get::<_, i64>(0)?, "change": change, "recovery_link": b64(&r.get::<_, Vec<u8>>(2)?) })))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let limit = limit as usize;
    let mut complete_to = i64::MAX;
    for list in [&mut rows, &mut links] {
        if list.len() > limit {
            list.truncate(limit);
            complete_to = complete_to.min(list.last().map_or(after, |(change, _)| *change));
        }
    }
    let more = complete_to != i64::MAX;
    rows.retain(|(change, _)| *change <= complete_to);
    links.retain(|(change, _)| *change <= complete_to);
    let cursor = if more {
        complete_to
    } else {
        rows.iter()
            .chain(links.iter())
            .map(|(change, _)| *change)
            .max()
            .unwrap_or(after)
    };
    let (rows, links): (Vec<Value>, Vec<Value>) = (
        rows.into_iter().map(|(_, v)| v).collect(),
        links.into_iter().map(|(_, v)| v).collect(),
    );
    Ok(json!({ "rows": rows, "links": links, "change": cursor, "more": more }))
}

// ---- requests: an unsigned wish to the human devices

#[allow(clippy::too_many_arguments)]
pub fn add_request(
    x: &Ctx,
    auth: &Auth,
    kind: &'static str,
    group_id: Option<&[u8]>,
    key_package: Option<&[u8]>,
    n: Option<i64>,
    mut extra: Value,
    fx: &mut Effects,
) -> Res<Value> {
    auth.member()?;
    if let Some(g) = group_id {
        let row = store::group(x.c, &auth.room, g)?;
        if store::sight(x.c, auth, &row)? == Sight::None {
            return Err(refuse("not-found", "no such group"));
        }
    }
    if let Some(kp) = key_package {
        if kp.len() > 8192 {
            return Err(refuse("too-large", "a KeyPackage is small"));
        }
    }
    // a device keeps its 16 newest wishes; older ones give way
    x.c.prepare_cached(
        "DELETE FROM requests WHERE room_id = ?1 AND device = ?2 AND id NOT IN
         (SELECT id FROM requests WHERE room_id = ?1 AND device = ?2 ORDER BY id DESC LIMIT 15)",
    )?
    .execute(params![&auth.room[..], &auth.device[..]])?;
    let committer = extra["committer"].as_str().and_then(crate::util::unb64);
    x.c.prepare_cached("INSERT INTO requests (room_id, device, kind, group_id, key_package, n, at, committer) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")?
        .execute(params![&auth.room[..], &auth.device[..], kind, group_id, key_package, n, x.now as i64, committer])?;
    let id = x.c.last_insert_rowid();
    extra["id"] = json!(id);
    extra["kind"] = json!(kind);
    extra["device"] = json!(b64(&auth.device));
    extra["group_id"] = json!(group_id.map(b64));
    extra["n"] = json!(n);
    fx.events.push(Event {
        room: auth.room,
        audience: Audience {
            humans: true,
            others: vec![],
            except: None,
        },
        name: "request",
        change: None,
        data: extra,
    });
    Ok(json!({ "id": id }))
}

pub fn requests(c: &Connection, auth: &Auth) -> Res<Value> {
    auth.member()?;
    // human devices see every wish of the room, another device its own
    let mut s = c.prepare_cached(
        "SELECT id, device, kind, group_id, key_package, n, at, committer FROM requests WHERE room_id = ?1 AND (?2 = 1 OR device = ?3) ORDER BY id",
    )?;
    let rows = s
        .query_map(
            params![&auth.room[..], auth.who == Who::Human, &auth.device[..]],
            |r| {
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "device": b64(&r.get::<_, Vec<u8>>(1)?),
                    "kind": r.get::<_, String>(2)?,
                    "group_id": r.get::<_, Option<Vec<u8>>>(3)?.map(|g| b64(&g)),
                    "key_package": r.get::<_, Option<Vec<u8>>>(4)?.map(|g| b64(&g)),
                    "n": r.get::<_, Option<i64>>(5)?,
                    "at": r.get::<_, i64>(6)?,
                    "committer": r.get::<_, Option<Vec<u8>>>(7)?.map(|g| b64(&g)),
                }))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Value::Array(rows))
}

// ---- recovery (8.6, 8.7)

/// A join and a cleaning Commit for each group: enough for 4 000 live sessions.
pub const MAX_RECOVERY_PARTS: i64 = 8192;
pub const MAX_RECOVERY_BYTES: i64 = 64 << 20;
pub const MAX_RECOVERY_PARTS_PER_GROUP: i64 = 8;
pub const MAX_RECOVERY_MEMO_BYTES: i64 = 512 << 20;

/// A room in recovery takes nothing else (8.7).
pub fn open_recovery_of(c: &Connection, room: &Room, now: u64) -> Res<Option<Vec<u8>>> {
    Ok(c.prepare_cached("SELECT recovery_id FROM recoveries WHERE room_id = ?1 AND finished_at IS NULL AND expires_at > ?2")?
        .query_row(params![&room[..], now as i64], |r| r.get(0))
        .optional()?)
}

pub fn recovery_open(x: &Ctx, auth: &Auth) -> Res<Value> {
    if auth.who != Who::Recovery {
        return Err(refuse(
            "forbidden",
            "a recovery is opened under the recovery key",
        ));
    }
    if open_recovery_of(x.c, &auth.room, x.now)?.is_some() {
        return Err(refuse("too-many", "a recovery of this room is running"));
    }
    // what an earlier recovery that ran out left behind
    x.c.prepare_cached(
        "DELETE FROM recoveries WHERE room_id = ?1 AND finished_at IS NULL AND expires_at <= ?2",
    )?
    .execute(params![&auth.room[..], x.now as i64])?;
    let id: [u8; 16] = crate::util::random();
    let expires = x.now + 600_000;
    x.c.prepare_cached("INSERT INTO recoveries (recovery_id, room_id, recovery_key, opened_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)")?
        .execute(params![&id[..], &auth.room[..], &auth.device[..], x.now as i64, expires as i64])?;
    crate::log::info("recovery_opened", json!({ "room": short(&auth.room) }));
    Ok(json!({ "recovery_id": b64(&id), "expires_at": expires }))
}

fn recovery_row(
    x: &Ctx,
    auth: &Auth,
    id: &[u8],
) -> Res<(Option<i64>, Option<Vec<u8>>, Option<String>)> {
    let row: Option<(Vec<u8>, i64, Option<i64>, Option<Vec<u8>>, Option<String>)> = x
        .c
        .prepare_cached("SELECT recovery_key, expires_at, finished_at, finish_hash, finish_answer FROM recoveries WHERE recovery_id = ?1 AND room_id = ?2")?
        .query_row(params![id, &auth.room[..]], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
        .optional()?;
    let Some((key, expires, finished, hash, answer)) = row else {
        return Err(refuse("not-found", "no such recovery"));
    };
    // A finished recovery is answered again under the key that ran it, although the room has a new one since,
    // and under the token of the device it brought in (8.7).
    let by_joiner = finished.is_some()
        && answer
            .as_deref()
            .and_then(|a| serde_json::from_str::<Value>(a).ok())
            .is_some_and(|a| a["device"] == b64(&auth.device));
    if !same(&key, &auth.device) && !by_joiner {
        return Err(refuse("not-found", "no such recovery"));
    }
    if finished.is_none() && (expires as u64) <= x.now {
        return Err(refuse("gone", "the recovery ran out"));
    }
    Ok((finished, hash, answer))
}

fn body_json(group_id: &[u8], b: &CommitBody) -> String {
    json!({
        "group_id": b64(group_id), "epoch": b.epoch, "commit": b64(&b.commit), "group_info": b64(&b.group_info),
        "welcome": b.welcome.as_deref().map(b64), "sealed_key": b64(&b.sealed_key), "recovery_auth": b.recovery_auth.as_deref().map(b64),
    })
    .to_string()
}

fn body_from_json(text: &str) -> Res<(Vec<u8>, CommitBody)> {
    let v: Value =
        serde_json::from_str(text).map_err(|_| refuse("internal", "stored recovery part"))?;
    let bytes = |k: &str| v[k].as_str().and_then(crate::util::unb64);
    let must = |k: &str| bytes(k).ok_or_else(|| refuse("internal", "stored recovery part"));
    Ok((
        must("group_id")?,
        CommitBody {
            epoch: v["epoch"].as_u64().unwrap_or(0),
            commit: must("commit")?,
            group_info: must("group_info")?,
            welcome: bytes("welcome"),
            sealed_key: must("sealed_key")?,
            recovery_auth: bytes("recovery_auth"),
        },
    ))
}

/// Applies every stored part of a recovery, in order, to the state as it is: the caller decides whether the
/// transaction around it is kept (finish) or rolled back (a rehearsal for the next part).
fn replay_recovery(
    x: &Ctx,
    auth: &Auth,
    id: &[u8],
    extra: Option<(&[u8], &CommitBody)>,
    scope: &mut Scope,
    fx: &mut Effects,
) -> Res<Option<Accepted>> {
    // A rehearsal applies the parts the new one can depend on: those of the room group, of its own group and of
    // its main session's group (a helper session's opener). The parts of other session groups do not touch
    // what its checks read. `finish` applies them all.
    let (own, parent): (Option<Vec<u8>>, Option<Vec<u8>>) = match extra {
        Some((group_id, _)) => {
            let parent = store::group(x.c, &auth.room, group_id)
                .ok()
                .and_then(|row| row.parent_group());
            (Some(group_id.to_vec()), parent)
        }
        None => (None, None),
    };
    let parts: Vec<String> = match &own {
        // (by the index on the group: the other groups' parts are not read)
        Some(own) => {
            let mut s = x.c.prepare_cached(
                "SELECT n, body FROM recovery_parts INDEXED BY recovery_parts_by_group WHERE recovery_id = ?1 AND group_id IN (?2, ?3, ?4)",
            )?;
            let mut rows = s
                .query_map(params![id, own, &auth.room[..], parent], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get(1)?))
                })?
                .collect::<rusqlite::Result<Vec<(i64, String)>>>()?;
            rows.sort_by_key(|(n, _)| *n);
            rows.into_iter().map(|(_, body)| body).collect()
        }
        None => {
            let mut s = x.c.prepare_cached(
                "SELECT body FROM recovery_parts WHERE recovery_id = ?1 ORDER BY n",
            )?;
            let rows = s
                .query_map([id], |r| r.get(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        }
    };
    let actor = Auth {
        room: auth.room,
        device: auth.device,
        who: Who::Recovery,
    };
    for text in &parts {
        let (group_id, body) = body_from_json(text)?;
        let replaced_before = scope.keys_replaced;
        commit(x, &actor, &group_id, &body, scope, fx)?;
        scope.replaced_in_last = scope.keys_replaced && !replaced_before;
    }
    match extra {
        Some((group_id, body)) => Ok(Some(commit(x, &actor, group_id, body, scope, fx)?)),
        None => Ok(None),
    }
}

/// One part of a recovery: checked against the state that the parts before it would leave, then kept apart.
/// Nothing of it is visible to anyone until `finish`. MUST run in a transaction that is rolled back
/// (`Db::rehearse`); `recovery_keep` then stores the part.
pub fn recovery_rehearse(
    x: &Ctx,
    auth: &Auth,
    id: &[u8],
    group_id: &[u8],
    body: &CommitBody,
) -> Res<Accepted> {
    let (finished, _, _) = recovery_row(x, auth, id)?;
    if finished.is_some() {
        return Err(refuse("gone", "the recovery is finished"));
    }
    let (count, bytes): (i64, i64) =
        x.c.prepare_cached("SELECT parts, bytes FROM recoveries WHERE recovery_id = ?1")?
            .query_row([id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    if count >= MAX_RECOVERY_PARTS
        || bytes + body_json(group_id, body).len() as i64 > MAX_RECOVERY_BYTES
    {
        return Err(refuse(
            "too-many",
            "a recovery has at most 8192 parts and 64 MiB",
        ));
    }
    // A part is checked against the parts it can depend on (see `replay_recovery`): with few parts per group
    // that is a fixed amount of work, however long the recovery is.
    let in_group: i64 =
        x.c.prepare_cached(
            "SELECT count(*) FROM recovery_parts WHERE recovery_id = ?1 AND group_id = ?2",
        )?
        .query_row(params![id, group_id], |r| r.get(0))?;
    if in_group >= MAX_RECOVERY_PARTS_PER_GROUP {
        return Err(refuse(
            "too-many",
            "a recovery has at most 8 parts for one group",
        ));
    }
    let mut scope = Scope {
        recovery: true,
        link_pending: true,
        ..Default::default()
    };
    let accepted = replay_recovery(
        x,
        auth,
        id,
        Some((group_id, body)),
        &mut scope,
        &mut Effects::default(),
    )?;
    Ok(accepted.expect("the new part was applied"))
}

pub fn recovery_keep(
    x: &Ctx,
    auth: &Auth,
    id: &[u8],
    group_id: &[u8],
    body: &CommitBody,
    commit_key: Option<&crate::memo::Key>,
    entries: &std::collections::HashMap<crate::memo::Key, crate::memo::Entry>,
) -> Res<()> {
    recovery_row(x, auth, id)?;
    // a repeated post of the same part is kept once
    let text = body_json(group_id, body);
    let hash = crate::util::sha256(text.as_bytes());
    let held = x
        .c
        .prepare_cached("SELECT 1 FROM recovery_parts WHERE recovery_id = ?1 AND body_hash = ?2")?
        .exists(params![id, &hash[..]])?;
    if held {
        return Ok(());
    }
    x.c.prepare_cached(
        "INSERT INTO recovery_parts (recovery_id, n, group_id, body, body_hash, commit_key)
         VALUES (?1, (SELECT parts + 1 FROM recoveries WHERE recovery_id = ?1), ?2, ?3, ?4, ?5)",
    )?
    .execute(params![
        id,
        group_id,
        text,
        &hash[..],
        commit_key.map(|k| &k[..])
    ])?;
    // what verifying it gave, for the parts that follow and for `finish`
    let mut memo_bytes = 0i64;
    for (key, entry) in entries {
        if let Some(value) = entry.encode() {
            let new = x.c.prepare_cached(
                "INSERT OR IGNORE INTO recovery_memo (recovery_id, key, value) VALUES (?1, ?2, ?3)",
            )?
            .execute(params![id, &key[..], value])?;
            memo_bytes += (new * value.len()) as i64;
        }
    }
    let held: i64 =
        x.c.prepare_cached(
            "UPDATE recoveries SET parts = parts + 1, bytes = bytes + ?2, memo_bytes = memo_bytes + ?3 WHERE recovery_id = ?1 RETURNING memo_bytes",
        )?
        .query_row(params![id, text.len() as i64, memo_bytes], |r| r.get(0))?;
    if held > MAX_RECOVERY_MEMO_BYTES {
        return Err(refuse(
            "too-many",
            "this recovery holds more public group state than a recovery may",
        ));
    }
    Ok(())
}

/// Whether this exact part is already kept: then its rehearsal would see its own epoch taken.
pub fn recovery_has(
    x: &Ctx,
    auth: &Auth,
    id: &[u8],
    group_id: &[u8],
    body: &CommitBody,
) -> Res<bool> {
    // whose recovery it is comes first: nothing is told about another room's or a finished one
    let (finished, _, _) = recovery_row(x, auth, id)?;
    if finished.is_some() {
        return Err(refuse("gone", "the recovery is finished"));
    }
    Ok(x.c
        .prepare_cached("SELECT 1 FROM recovery_parts WHERE recovery_id = ?1 AND body_hash = ?2")?
        .exists(params![
            id,
            &crate::util::sha256(body_json(group_id, body).as_bytes())[..]
        ])?)
}

/// 8.7: publishes all parts or none. The room group and every live session group were joined and cleaned, the
/// code was replaced, and no live group is stale.
pub fn recovery_finish(
    x: &Ctx,
    auth: &Auth,
    id: &[u8],
    link_bytes: &[u8],
    request_hash: &[u8; 32],
    fx: &mut Effects,
) -> Res<(Value, bool)> {
    let (finished, hash, answer) = recovery_row(x, auth, id)?;
    if finished.is_some() {
        return match (hash, answer) {
            (Some(h), Some(a)) if same(&h, request_hash) => Ok((
                serde_json::from_str(&a).map_err(|_| refuse("internal", "stored answer"))?,
                false,
            )),
            _ => Err(refuse("gone", "the recovery is finished")),
        };
    }
    let link = RecoveryLink::parse(link_bytes)?;
    let mut scope = Scope {
        recovery: true,
        link: Some(link),
        ..Default::default()
    };
    let first_change = store::room_row(x.c, &auth.room)?.change + 1;
    replay_recovery(x, auth, id, None, &mut scope, fx)?;
    let Some(joiner) = scope.joiner else {
        return Err(refuse(
            "incomplete",
            "the recovery did not join the room group",
        ));
    };
    // 8.7: the room Commit that removes the other human devices brings the new code (8.6); the session groups'
    // Removes follow it, against the new room epoch
    if !scope.keys_replaced {
        return Err(refuse(
            "incomplete",
            "a recovery holds the room Commit that brings the new code (8.6)",
        ));
    }
    let view = store::room_view(x.c, &auth.room)?;
    if view.humans.len() != 1 || !view.humans.contains(&joiner) {
        return Err(refuse(
            "incomplete",
            "a recovery removes every other human device from the room group",
        ));
    }
    for row in store::groups_of_room(x.c, &auth.room)? {
        if row.kind == GroupKind::Room || !row.live {
            continue;
        }
        if store::is_stale(x.c, &view, &row)? {
            return Err(refuse("stale-session", "a live session group is stale")
                .with(json!({ "group_id": b64(&row.group_id) })));
        }
        let leaves = store::leaves(x.c, &row.group_id)?;
        let humans: Vec<&Device> = leaves
            .iter()
            .filter(|d| view.standing(d) == Standing::Human)
            .collect();
        if humans != vec![&joiner] {
            return Err(refuse(
                "incomplete",
                "a live session group was not joined and cleaned",
            )
            .with(json!({ "group_id": b64(&row.group_id) })));
        }
    }
    let last_change = store::room_row(x.c, &auth.room)?.change;
    let answer = json!({ "published": true, "first_change": first_change, "change": last_change, "device": b64(&joiner) });
    // the answer can be asked again for ten minutes from now, whenever the recovery would have run out
    x.c.prepare_cached("UPDATE recoveries SET finished_at = ?1, expires_at = ?1 + 600000, finish_hash = ?2, finish_answer = ?3 WHERE recovery_id = ?4")?
        .execute(params![x.now as i64, &request_hash[..], answer.to_string(), id])?;
    x.c.prepare_cached("DELETE FROM recovery_parts WHERE recovery_id = ?1")?
        .execute([id])?;
    x.c.prepare_cached("DELETE FROM recovery_memo WHERE recovery_id = ?1")?
        .execute([id])?;
    crate::log::info(
        "recovery_finished",
        json!({ "room": short(&auth.room), "device": short(&joiner) }),
    );
    Ok((answer, true))
}

pub fn recovery_drop(x: &Ctx, auth: &Auth, id: &[u8]) -> Res<Value> {
    let (finished, _, _) = recovery_row(x, auth, id)?;
    if finished.is_none() {
        x.c.prepare_cached("DELETE FROM recoveries WHERE recovery_id = ?1")?
            .execute([id])?;
    }
    Ok(json!({ "dropped": finished.is_none() }))
}
