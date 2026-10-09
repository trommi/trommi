//! What every part of the hub reads from the database: who is asking, the room's public state, a group's row, and
//! the things to do once a transaction has been committed (`Effects`).

use std::collections::BTreeSet;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use crate::error::{refuse, Res};
use crate::observer::{Device, GroupState};
use crate::rules::{offending_leaves, RoomView, SessionKind, Standing};

pub type Room = [u8; 32];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Who {
    Human,
    Agent,
    Helper,
    /// signed in with the room's recovery signature key: reads what 8.4 to 8.7 need, posts their Commits
    Recovery,
    /// the recovery key of a recovery that was just finished and replaced it: may ask for that finish's answer
    /// again, nothing else
    Spent,
}

/// The signed-in asker of a request, checked against its present standing (12.3.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Auth {
    pub room: Room,
    pub device: Device,
    pub who: Who,
}

impl Auth {
    pub fn human(&self) -> Res<()> {
        if self.who == Who::Human {
            Ok(())
        } else {
            Err(refuse("forbidden", "only a human device does this"))
        }
    }
    pub fn member(&self) -> Res<()> {
        if matches!(self.who, Who::Recovery | Who::Spent) {
            Err(refuse(
                "forbidden",
                "the recovery key reads and joins, nothing else",
            ))
        } else {
            Ok(())
        }
    }
}

pub fn fixed<const N: usize>(v: Vec<u8>) -> rusqlite::Result<[u8; N]> {
    v.try_into().map_err(|_| {
        rusqlite::Error::InvalidColumnType(
            0,
            "fixed-length blob".into(),
            rusqlite::types::Type::Blob,
        )
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GroupKind {
    Room,
    Main,
    Helper,
}

impl GroupKind {
    pub fn text(self) -> &'static str {
        match self {
            GroupKind::Room => "room",
            GroupKind::Main => "main",
            GroupKind::Helper => "helper",
        }
    }
}

#[derive(Debug, Clone)]
pub struct GroupRow {
    pub group_id: Vec<u8>,
    pub room_id: Room,
    pub kind: GroupKind,
    pub session_id: Option<[u8; 16]>,
    pub parent: Option<[u8; 16]>,
    pub epoch: u64,
    pub room_epoch: u64,
    pub epoch_at: u64,
    pub live: bool,
    pub log_n: i64,
    pub log_kept_from: i64,
}

impl GroupRow {
    /// The group id of a helper session's main session.
    pub fn parent_group(&self) -> Option<Vec<u8>> {
        self.parent.map(|p| [&self.room_id[..], &p[..]].concat())
    }
}

const GROUP_COLUMNS: &str = "group_id, room_id, kind, session_id, parent, epoch, room_epoch, epoch_at, live, log_n, log_kept_from";

fn group_row(r: &rusqlite::Row) -> rusqlite::Result<GroupRow> {
    let kind: String = r.get(2)?;
    Ok(GroupRow {
        group_id: r.get(0)?,
        room_id: fixed(r.get(1)?)?,
        kind: match kind.as_str() {
            "room" => GroupKind::Room,
            "main" => GroupKind::Main,
            _ => GroupKind::Helper,
        },
        session_id: r.get::<_, Option<Vec<u8>>>(3)?.map(fixed).transpose()?,
        parent: r.get::<_, Option<Vec<u8>>>(4)?.map(fixed).transpose()?,
        epoch: r.get::<_, i64>(5)? as u64,
        room_epoch: r.get::<_, i64>(6)? as u64,
        epoch_at: r.get::<_, i64>(7)? as u64,
        live: r.get::<_, i64>(8)? == 1,
        log_n: r.get(9)?,
        log_kept_from: r.get(10)?,
    })
}

/// A group of this room; a group of another room does not exist for the asker.
pub fn group(c: &Connection, room: &Room, group_id: &[u8]) -> Res<GroupRow> {
    c.prepare_cached(&format!(
        "SELECT {GROUP_COLUMNS} FROM groups WHERE group_id = ?1 AND room_id = ?2"
    ))?
    .query_row(params![group_id, &room[..]], group_row)
    .optional()?
    .ok_or_else(|| refuse("not-found", "no such group"))
}

pub fn groups_of_room(c: &Connection, room: &Room) -> Res<Vec<GroupRow>> {
    let mut s = c.prepare_cached(&format!(
        "SELECT {GROUP_COLUMNS} FROM groups WHERE room_id = ?1 ORDER BY founded_change"
    ))?;
    let rows = s
        .query_map([&room[..]], group_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn group_state(c: &Connection, group_id: &[u8]) -> Res<GroupState> {
    Ok(GroupState(
        c.prepare_cached("SELECT state FROM groups WHERE group_id = ?1")?
            .query_row([group_id], |r| r.get(0))?,
    ))
}

/// The current leaves of a group.
pub fn leaves(c: &Connection, group_id: &[u8]) -> Res<Vec<Device>> {
    let mut s = c.prepare_cached(
        "SELECT device FROM group_members WHERE group_id = ?1 AND removed_epoch IS NULL",
    )?;
    let rows = s
        .query_map([group_id], |r| fixed::<32>(r.get(0)?))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn is_leaf(c: &Connection, group_id: &[u8], device: &Device) -> Res<bool> {
    Ok(c.prepare_cached(
        "SELECT 1 FROM group_members WHERE group_id = ?1 AND device = ?2 AND removed_epoch IS NULL",
    )?
    .exists(params![group_id, &device[..]])?)
}

pub struct RoomRow {
    pub change: i64,
    pub file_bytes: u64,
    pub recovery_signature_key: Vec<u8>,
    pub recovery_hpke_key: Vec<u8>,
}

pub fn room_row(c: &Connection, room: &Room) -> Res<RoomRow> {
    c.prepare_cached("SELECT change, file_bytes, recovery_signature_key, recovery_hpke_key FROM rooms WHERE room_id = ?1")?
        .query_row([&room[..]], |r| {
            Ok(RoomRow {
                change: r.get(0)?,
                file_bytes: r.get::<_, i64>(1)? as u64,
                recovery_signature_key: r.get(2)?,
                recovery_hpke_key: r.get(3)?,
            })
        })
        .optional()?
        .ok_or_else(|| refuse("no-room", "no such room"))
}

/// The room's public state for the rules: its epoch, who is a human device, an agent device, revoked.
pub fn room_view(c: &Connection, room: &Room) -> Res<RoomView> {
    let (epoch, state): (i64, Vec<u8>) = c
        .prepare_cached("SELECT epoch, room_state FROM rooms WHERE room_id = ?1")?
        .query_row([&room[..]], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?
        .ok_or_else(|| refuse("no-room", "no such room"))?;
    let (mut humans, mut agents, mut revoked) = (BTreeSet::new(), BTreeSet::new(), BTreeSet::new());
    let mut s = c.prepare_cached("SELECT device, role, removed_epoch IS NOT NULL FROM devices WHERE room_id = ?1 AND role != 'helper'")?;
    let mut rows = s.query([&room[..]])?;
    while let Some(r) = rows.next()? {
        let device: Device = fixed(r.get(0)?)?;
        let role: String = r.get(1)?;
        match (r.get::<_, bool>(2)?, role.as_str()) {
            (true, _) => revoked.insert(device),
            (false, "human") => humans.insert(device),
            (false, _) => agents.insert(device),
        };
    }
    Ok(RoomView {
        epoch: epoch as u64,
        state: fixed(state)?,
        humans,
        agents,
        revoked,
    })
}

/// The agent leaf of a session group now, if it has one.
pub fn agent_leaf(c: &Connection, view: &RoomView, group_id: &[u8]) -> Res<Option<Device>> {
    Ok(leaves(c, group_id)?
        .into_iter()
        .find(|d| view.standing(d) == Standing::Agent))
}

pub fn session_kind(c: &Connection, view: &RoomView, row: &GroupRow) -> Res<SessionKind> {
    Ok(match row.parent_group() {
        None => SessionKind::Main,
        Some(parent) => SessionKind::Helper {
            opener: agent_leaf(c, view, &parent)?,
        },
    })
}

/// 5.2.8: a session group that still has a leaf the current room state does not allow.
pub fn is_stale(c: &Connection, view: &RoomView, row: &GroupRow) -> Res<bool> {
    if row.kind == GroupKind::Room {
        return Ok(false);
    }
    let kind = session_kind(c, view, row)?;
    Ok(!offending_leaves(kind, view, &leaves(c, &row.group_id)?).is_empty())
}

/// What the asker may see of a group. `Leaf`: its log, envelopes, files and registers. `Public`: its Commits and
/// GroupInfo only (hub-api.md, "Who may read").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sight {
    Leaf,
    Public,
    None,
}

pub fn sight(c: &Connection, auth: &Auth, row: &GroupRow) -> Res<Sight> {
    Ok(match auth.who {
        Who::Human => Sight::Leaf,
        Who::Recovery => Sight::Public,
        Who::Spent => Sight::None,
        Who::Agent | Who::Helper => {
            if is_leaf(c, &row.group_id, &auth.device)? {
                Sight::Leaf
            } else if row.kind == GroupKind::Room
                || (row.kind == GroupKind::Main && sees_as_helper(c, auth, row)?)
            {
                Sight::Public
            } else {
                Sight::None
            }
        }
    })
}

/// Whether the asker is a leaf of a helper session under this main session.
fn sees_as_helper(c: &Connection, auth: &Auth, main: &GroupRow) -> Res<bool> {
    let Some(session) = main.session_id else {
        return Ok(false);
    };
    Ok(c.prepare_cached(
        "SELECT 1 FROM groups g JOIN group_members m ON m.group_id = g.group_id
         WHERE g.room_id = ?1 AND g.parent = ?2 AND m.device = ?3 AND m.removed_epoch IS NULL",
    )?
    .exists(params![&auth.room[..], &session[..], &auth.device[..]])?)
}

/// The groups whose content the asker may read. `None`: all of the room (a human device).
pub fn readable_groups(c: &Connection, auth: &Auth) -> Res<Option<Vec<Vec<u8>>>> {
    match auth.who {
        Who::Human | Who::Recovery => Ok(None),
        Who::Spent => Ok(Some(vec![])),
        Who::Agent | Who::Helper => {
            let mut s = c.prepare_cached(
                "SELECT m.group_id FROM group_members m JOIN groups g ON g.group_id = m.group_id
                 WHERE m.device = ?1 AND m.removed_epoch IS NULL AND g.room_id = ?2",
            )?;
            let rows = s
                .query_map(params![&auth.device[..], &auth.room[..]], |r| r.get(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(Some(rows))
        }
    }
}

/// The present standing of a signature key in a room, for sign-in and for every request with a token (12.3).
pub fn standing(c: &Connection, room: &Room, device: &Device) -> Res<Option<Who>> {
    let row: Option<(String, bool)> = c
        .prepare_cached("SELECT role, removed_epoch IS NOT NULL FROM devices WHERE room_id = ?1 AND device = ?2")?
        .query_row(params![&room[..], &device[..]], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    match row {
        Some((_, true)) => Ok(None),
        Some((role, false)) if role == "human" => Ok(Some(Who::Human)),
        Some((role, false)) if role == "agent" => Ok(Some(Who::Agent)),
        Some(_) => {
            // a helper device has standing while it is a leaf of a group of the room
            let leaf = c
                .prepare_cached(
                    "SELECT 1 FROM group_members m JOIN groups g ON g.group_id = m.group_id
                     WHERE m.device = ?1 AND m.removed_epoch IS NULL AND g.room_id = ?2",
                )?
                .exists(params![&device[..], &room[..]])?;
            Ok(leaf.then_some(Who::Helper))
        }
        None => {
            let key: Option<Vec<u8>> = c
                .prepare_cached("SELECT recovery_signature_key FROM rooms WHERE room_id = ?1")?
                .query_row([&room[..]], |r| r.get(0))
                .optional()?;
            Ok(key
                .filter(|k| crate::util::same(k, device))
                .map(|_| Who::Recovery))
        }
    }
}

// ---- after the transaction

/// Who gets a live event. Human devices of the room always may; others by name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Audience {
    pub humans: bool,
    pub others: Vec<Device>,
    pub except: Option<Device>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    pub room: Room,
    pub audience: Audience,
    pub name: &'static str,
    pub change: Option<i64>,
    pub data: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushJob {
    pub room: Room,
    pub sender: Option<Device>,
    pub change: i64,
    pub urgency: u8,
    /// the envelope the notification extension may fetch with its ticket; None for "an agent lost its connection"
    pub envelope: Option<[u8; 32]>,
}

/// Things that follow from a transaction and are done once it is committed: nothing here is done for a
/// transaction that was rolled back.
#[derive(Debug, Default)]
pub struct Effects {
    pub events: Vec<Event>,
    /// devices whose standing or groups changed: their tokens and streams are checked again
    pub recheck: Vec<(Room, Device)>,
    /// the room's recovery key was replaced: its tokens end
    pub recovery_replaced: Vec<Room>,
    pub pushes: Vec<PushJob>,
    /// files whose rows were deleted: (room, file id)
    pub unlink: Vec<(Room, [u8; 16])>,
    /// rooms whose counts for the Live Activity may have changed
    pub live: Vec<Room>,
}

/// Human devices and every device that follows the group's public state: for a Commit.
pub fn public_audience(c: &Connection, row: &GroupRow) -> Res<Audience> {
    let others = match row.kind {
        // every signed-in device observes the room group
        GroupKind::Room => {
            let mut s = c.prepare_cached(
                "SELECT device FROM devices WHERE room_id = ?1 AND role != 'human' AND removed_epoch IS NULL",
            )?;
            let rows = s
                .query_map([&row.room_id[..]], |r| fixed::<32>(r.get(0)?))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        }
        GroupKind::Main => {
            let mut out = leaves(c, &row.group_id)?;
            if let Some(session) = row.session_id {
                let mut s = c.prepare_cached(
                    "SELECT m.device FROM groups g JOIN group_members m ON m.group_id = g.group_id
                     WHERE g.room_id = ?1 AND g.parent = ?2 AND m.removed_epoch IS NULL",
                )?;
                let rows = s
                    .query_map(params![&row.room_id[..], &session[..]], |r| {
                        fixed::<32>(r.get(0)?)
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                out.extend(rows);
            }
            out
        }
        GroupKind::Helper => leaves(c, &row.group_id)?,
    };
    Ok(Audience {
        humans: true,
        others,
        except: None,
    })
}

/// Human devices and the group's other leaves: for content.
pub fn leaf_audience(c: &Connection, group_id: &[u8]) -> Res<Audience> {
    Ok(Audience {
        humans: true,
        others: leaves(c, group_id)?,
        except: None,
    })
}
