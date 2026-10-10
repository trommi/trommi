//! What the hub prunes as content arrives (spec/v1.md 9.4.2, 9.4.3, 10.9; hub-api.md point 45). Pruning sets an
//! envelope's body to NULL: header, nonce, ciphertext hash and signature stay, so every chain still verifies and
//! every object state replays. A file goes when every envelope that named it is pruned and no counting board
//! frontier post keeps it.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::error::{refuse, Res};
use crate::store::{Auth, Effects, Room};
use crate::util::{same, unb64};
use crate::wire;

/// 10.9: a post that is more than this older than the newest post of a board no longer counts.
pub const FRONTIER_WINDOW_MS: u64 = 30 * 86_400_000;
/// 10.9: the most file ids one post keeps.
pub const MAX_FRONTIER_FILES: usize = 20_000;
/// The most writers one frontier names (the most human devices of a room).
pub const MAX_FRONTIER_WRITERS: usize = 1_000;

/// The 16-byte ids of a `file_ids` column.
fn ids_of(blob: &[u8]) -> impl Iterator<Item = &[u8]> {
    blob.as_chunks::<16>().0.iter().map(|id| &id[..])
}

/// Whether a file is still needed: an envelope with its body names it, or a counting frontier post keeps it.
fn file_needed(c: &Connection, room: &Room, file_id: &[u8]) -> Res<bool> {
    let mut s = c.prepare_cached(
        "SELECT file_ids FROM envelopes WHERE room_id = ?1 AND body IS NOT NULL AND instr(file_ids, ?2) > 0",
    )?;
    let mut rows = s.query(params![&room[..], file_id])?;
    while let Some(r) = rows.next()? {
        let ids: Vec<u8> = r.get(0)?;
        if ids_of(&ids).any(|id| id == file_id) {
            return Ok(true);
        }
    }
    let mut s = c.prepare_cached(
        "SELECT files FROM board_frontiers WHERE room_id = ?1 AND counts = 1 AND instr(files, ?2) > 0",
    )?;
    let mut rows = s.query(params![&room[..], file_id])?;
    while let Some(r) = rows.next()? {
        let ids: Vec<u8> = r.get(0)?;
        if ids_of(&ids).any(|id| id == file_id) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Deletes those of `file_ids` that nothing needs any more (as 9.4 deletes files). Returns how many.
fn drop_files(
    c: &Connection,
    room: &Room,
    file_ids: &[Vec<u8>],
    now: u64,
    fx: &mut Effects,
) -> Res<usize> {
    let mut n = 0;
    for id in file_ids {
        let size: Option<i64> = c
            .prepare_cached("SELECT size FROM files WHERE room_id = ?1 AND file_id = ?2 AND deleted_at IS NULL AND group_id IS NOT NULL")?
            .query_row(params![&room[..], id], |r| r.get(0))
            .optional()?;
        let Some(size) = size else { continue };
        if !file_needed(c, room, id)? {
            crate::content::delete_file(c, room, id, size, now, fx)?;
            n += 1;
        }
    }
    Ok(n)
}

/// Prunes the bodies of the envelopes `select` names (a WHERE clause over `envelopes` with `?1` the room and
/// further parameters in `rest`), then deletes the files only they named. Returns how many bodies went.
fn prune_where(
    c: &Connection,
    room: &Room,
    select: &str,
    rest: &[&dyn rusqlite::ToSql],
    now: u64,
    fx: &mut Effects,
) -> Res<usize> {
    let room_bytes: &[u8] = &room[..];
    let mut args: Vec<&dyn rusqlite::ToSql> = vec![&room_bytes as &dyn rusqlite::ToSql];
    args.extend_from_slice(rest);
    let mut files: Vec<Vec<u8>> = Vec::new();
    {
        let mut s = c.prepare_cached(&format!(
            "SELECT file_ids FROM envelopes WHERE room_id = ?1 AND body IS NOT NULL AND cut = 0 AND length(file_ids) > 0 AND {select}"
        ))?;
        let mut rows = s.query(args.as_slice())?;
        while let Some(r) = rows.next()? {
            let ids: Vec<u8> = r.get(0)?;
            for id in ids_of(&ids) {
                if !files.iter().any(|f| f == id) {
                    files.push(id.to_vec());
                }
            }
        }
    }
    let n = c
        .prepare_cached(&format!(
            "UPDATE envelopes SET body = NULL WHERE room_id = ?1 AND body IS NOT NULL AND cut = 0 AND {select}"
        ))?
        .execute(args.as_slice())?;
    if n > 0 && !files.is_empty() {
        drop_files(c, room, &files, now, fx)?;
    }
    Ok(n)
}

/// 9.4.2: a register value or a Note version was taken: the same writer's earlier values of that register, or
/// versions of that Note, lose their bodies. A writer's lamport rises along its chain, so none of them can be
/// current again.
pub fn superseded(
    c: &Connection,
    room: &Room,
    h: &wire::Header,
    now: u64,
    fx: &mut Effects,
) -> Res<usize> {
    let seq = h.seq as i64;
    match &h.subject {
        wire::Subject::Register { register_id } => prune_where(
            c,
            room,
            "group_id = ?2 AND sender = ?3 AND register_id = ?4 AND seq < ?5",
            &[&h.group_id, &&h.sender[..], &&register_id[..], &seq],
            now,
            fx,
        ),
        wire::Subject::Object {
            object_id,
            object_type,
            ..
        } if *object_type == wire::TYPE_NOTE && h.kind == wire::KIND_VERSION => prune_where(
            c,
            room,
            "object_id = ?2 AND sender = ?3 AND kind = ?4 AND seq < ?5 AND group_id = ?6",
            &[
                &&object_id[..],
                &&h.sender[..],
                &wire::KIND_VERSION,
                &seq,
                &h.group_id,
            ],
            now,
            fx,
        ),
        _ => Ok(0),
    }
}

/// The sweep for what was stored before 9.4.2 (and what a crash between two writes left): at most `batch`
/// writers' registers and Notes per call. Returns how many bodies went.
pub fn sweep_superseded(c: &Connection, now: u64, batch: i64, fx: &mut Effects) -> Res<usize> {
    let mut total = 0;
    // registers: every value below the writer's newest
    let rows: Vec<(Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>, i64)> = {
        let mut s = c.prepare_cached(
            "SELECT r.room_id, r.group_id, r.writer, r.register_id, e.seq FROM registers r
               JOIN envelopes e ON e.room_id = r.room_id AND e.change = r.head_change
             WHERE EXISTS (SELECT 1 FROM envelopes o WHERE o.group_id = r.group_id AND o.sender = r.writer
                             AND o.register_id = r.register_id AND o.seq < e.seq AND o.body IS NOT NULL AND o.cut = 0)
             LIMIT ?1",
        )?;
        let rows = s
            .query_map([batch], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    for (room, group, writer, register, seq) in rows {
        let Ok(room) = <Room>::try_from(&room[..]) else {
            continue;
        };
        total += prune_where(
            c,
            &room,
            "group_id = ?2 AND sender = ?3 AND register_id = ?4 AND seq < ?5",
            &[&group, &writer, &register, &seq],
            now,
            fx,
        )?;
    }
    // Notes: every version below the same writer's newest version of that Note
    let rows: Vec<(Vec<u8>, Vec<u8>, Vec<u8>, i64)> = {
        let mut s = c.prepare_cached(
            "SELECT room_id, object_id, sender, max(seq) FROM envelopes
             WHERE object_type = ?1 AND kind = ?2 AND void_code IS NULL AND cut = 0
             GROUP BY room_id, object_id, sender
             HAVING min(CASE WHEN body IS NOT NULL THEN seq END) < max(seq)
             LIMIT ?3",
        )?;
        let rows = s
            .query_map(params![wire::TYPE_NOTE, wire::KIND_VERSION, batch], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    for (room, object, sender, seq) in rows {
        let Ok(room) = <Room>::try_from(&room[..]) else {
            continue;
        };
        total += prune_where(
            c,
            &room,
            "object_id = ?2 AND sender = ?3 AND kind = ?4 AND seq < ?5",
            &[&object, &sender, &wire::KIND_VERSION, &seq],
            now,
            fx,
        )?;
    }
    Ok(total)
}

// ---- board frontiers (10.9)

/// The timeline key of a board.
fn board_key(board: &[u8; 16]) -> Vec<u8> {
    [&[wire::TIMELINE_BOARD, wire::SCOPE_DESK][..], &board[..]].concat()
}

/// A frontier as stored: per writer (32 bytes) its number, ascending by writer.
type Frontier = Vec<([u8; 32], u64)>;

fn encode_frontier(f: &Frontier) -> Vec<u8> {
    let mut out = Vec::with_capacity(f.len() * 40);
    for (w, seq) in f {
        out.extend_from_slice(w);
        out.extend_from_slice(&seq.to_be_bytes());
    }
    out
}

fn decode_frontier(b: &[u8]) -> Frontier {
    b.as_chunks::<40>()
        .0
        .iter()
        .map(|c| {
            (
                c[..32].try_into().unwrap_or([0; 32]),
                u64::from_be_bytes(c[32..].try_into().unwrap_or([0; 8])),
            )
        })
        .collect()
}

/// `POST /v1/boards/{board}/frontier`: a human device's word that its snapshot of `board` covers `frontier` and
/// keeps `files` (10.9). Checked against the room group's chains, stored as that device's newest post, then the
/// board is pruned to what the counting posts allow.
pub fn post_frontier(
    c: &Connection,
    auth: &Auth,
    board: &[u8; 16],
    body: &Value,
    now: u64,
    fx: &mut Effects,
) -> Res<Value> {
    auth.human()?;
    let room = auth.room;
    let group: &[u8] = &room[..];
    let named = body["frontier"]
        .as_object()
        .ok_or_else(|| refuse("bad-format", "frontier: an object of writer to [seq, hash]"))?;
    if named.len() > MAX_FRONTIER_WRITERS {
        return Err(refuse(
            "too-large",
            "a frontier names at most 1 000 writers",
        ));
    }
    let mut frontier: Frontier = Vec::with_capacity(named.len());
    for (writer, head) in named {
        let writer: [u8; 32] = unb64(writer)
            .and_then(|b| b.try_into().ok())
            .ok_or_else(|| refuse("bad-format", "a frontier's writer is a device id"))?;
        let seq = head[0]
            .as_u64()
            .filter(|s| *s >= 1 && *s <= i64::MAX as u64)
            .ok_or_else(|| refuse("bad-format", "a frontier's number"))?;
        let hash: [u8; 32] = head[1]
            .as_str()
            .and_then(unb64)
            .and_then(|b| b.try_into().ok())
            .ok_or_else(|| refuse("bad-format", "a frontier's hash"))?;
        if head.as_array().map(|a| a.len()) != Some(2) {
            return Err(refuse("bad-format", "a frontier's head is [seq, hash]"));
        }
        let known: bool = c
            .prepare_cached("SELECT 1 FROM devices WHERE room_id = ?1 AND device = ?2")?
            .exists(params![&room[..], &writer[..]])?;
        if !known {
            return Err(refuse(
                "bad-format",
                "a frontier names a device that is not of this room",
            ));
        }
        let held: Option<Vec<u8>> = c
            .prepare_cached(
                "SELECT hash FROM envelopes WHERE group_id = ?1 AND sender = ?2 AND seq = ?3",
            )?
            .query_row(params![group, &writer[..], seq as i64], |r| r.get(0))
            .optional()?;
        match held {
            None => {
                return Err(refuse(
                    "bad-format",
                    "a frontier reaches beyond what the hub holds of a writer",
                ))
            }
            Some(h) if !same(&h, &hash) => {
                return Err(refuse(
                    "bad-format",
                    "a frontier's hash is not that envelope's",
                ))
            }
            Some(_) => {}
        }
        frontier.push((writer, seq));
    }
    frontier.sort();
    frontier.dedup_by(|a, b| a.0 == b.0);
    if frontier.len() != named.len() {
        return Err(refuse("bad-format", "a frontier names a writer twice"));
    }
    let listed = body["files"]
        .as_array()
        .ok_or_else(|| refuse("bad-format", "files: a list of file ids"))?;
    if listed.len() > MAX_FRONTIER_FILES {
        return Err(refuse("too-large", "a frontier keeps at most 20 000 files"));
    }
    let mut files = Vec::with_capacity(listed.len() * 16);
    for f in listed {
        let id: [u8; 16] = f
            .as_str()
            .and_then(unb64)
            .and_then(|b| b.try_into().ok())
            .ok_or_else(|| refuse("bad-format", "a file id is 16 bytes"))?;
        files.extend_from_slice(&id);
    }
    c.prepare_cached(
        "INSERT INTO board_frontiers (room_id, board, device, frontier, files, at, counts) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)
         ON CONFLICT (room_id, board, device) DO UPDATE SET frontier = excluded.frontier, files = excluded.files, at = excluded.at, counts = 1",
    )?
    .execute(params![&room[..], &board[..], &auth.device[..], encode_frontier(&frontier), files, now as i64])?;
    let pruned = apply_board(c, &room, board, now, fx)?;
    Ok(json!({ "pruned": pruned }))
}

/// Marks which posts of `board` count (a human device that is a leaf of the room group, at most 30 days before
/// the newest post), then prunes per writer up to the smallest number the counting posts give it.
pub fn apply_board(
    c: &Connection,
    room: &Room,
    board: &[u8; 16],
    now: u64,
    fx: &mut Effects,
) -> Res<usize> {
    let group: &[u8] = &room[..];
    let posts: Vec<(Vec<u8>, Vec<u8>, i64)> = {
        let mut s = c.prepare_cached(
            "SELECT device, frontier, at FROM board_frontiers WHERE room_id = ?1 AND board = ?2",
        )?;
        let rows = s
            .query_map(params![&room[..], &board[..]], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let mut live: Vec<(Vec<u8>, Frontier, i64)> = Vec::new();
    for (device, frontier, at) in posts {
        let human_leaf: bool = c
            .prepare_cached(
                "SELECT 1 FROM devices d JOIN group_members m ON m.device = d.device AND m.group_id = ?1
                 WHERE d.room_id = ?2 AND d.device = ?3 AND d.role = 'human' AND d.removed_epoch IS NULL AND m.removed_epoch IS NULL",
            )?
            .exists(params![group, &room[..], &device])?;
        if human_leaf {
            live.push((device, decode_frontier(&frontier), at));
        } else {
            c.prepare_cached("UPDATE board_frontiers SET counts = 0 WHERE room_id = ?1 AND board = ?2 AND device = ?3")?
                .execute(params![&room[..], &board[..], &device])?;
        }
    }
    let Some(newest) = live.iter().map(|p| p.2).max() else {
        return Ok(0);
    };
    let from = newest.saturating_sub(FRONTIER_WINDOW_MS as i64);
    let mut counting: Vec<Frontier> = Vec::new();
    for (device, frontier, at) in live {
        let counts = at >= from;
        c.prepare_cached("UPDATE board_frontiers SET counts = ?1 WHERE room_id = ?2 AND board = ?3 AND device = ?4")?
            .execute(params![counts as i64, &room[..], &board[..], &device])?;
        if counts {
            counting.push(frontier);
        }
    }
    // per writer the smallest number among the counting posts; a post without that writer counts 0
    let Some(first) = counting.first() else {
        return Ok(0);
    };
    let mut total = 0;
    let key = board_key(board);
    for (writer, _) in first {
        let min = counting
            .iter()
            .map(|f| {
                f.iter()
                    .find(|(w, _)| w == writer)
                    .map(|(_, s)| *s)
                    .unwrap_or(0)
            })
            .min()
            .unwrap_or(0);
        if min == 0 {
            continue;
        }
        let min = min as i64;
        total += prune_where(
            c,
            room,
            "timeline = ?2 AND group_id = ?3 AND sender = ?4 AND seq <= ?5",
            &[&key, &group, &&writer[..], &min],
            now,
            fx,
        )?;
    }
    Ok(total)
}

/// The retention job's turn: every board with posts is applied again, so that a post that fell out of the 30
/// days or a device that was removed stops holding pruning back. Returns how many bodies went.
pub fn sweep_boards(c: &Connection, now: u64, fx: &mut Effects) -> Res<usize> {
    let boards: Vec<(Vec<u8>, Vec<u8>)> = {
        let mut s = c.prepare_cached("SELECT DISTINCT room_id, board FROM board_frontiers")?;
        let rows = s
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let mut total = 0;
    for (room, board) in boards {
        let (Ok(room), Ok(board)) = (
            <Room>::try_from(&room[..]),
            <[u8; 16]>::try_from(&board[..]),
        ) else {
            continue;
        };
        total += apply_board(c, &room, &board, now, fx)?;
    }
    Ok(total)
}
