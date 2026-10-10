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
/// 10.9: the most declarations of one device and board that wait for their bound post; a further one folds them.
pub const MAX_DECLARED: i64 = 8;

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

/// A frontier as a post names it: per writer `[seq, hash]`, each the writer's envelope in the room group that the
/// hub holds under that number and has not cut (9.0.10).
fn frontier_of(c: &Connection, room: &Room, body: &Value) -> Res<Frontier> {
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
        let (seq, hash) = head_of(head)?;
        let known: bool = c
            .prepare_cached("SELECT 1 FROM devices WHERE room_id = ?1 AND device = ?2")?
            .exists(params![&room[..], &writer[..]])?;
        if !known {
            return Err(refuse(
                "bad-format",
                "a frontier names a device that is not of this room",
            ));
        }
        let held: Option<(Vec<u8>, i64)> = c
            .prepare_cached(
                "SELECT hash, cut FROM envelopes WHERE group_id = ?1 AND sender = ?2 AND seq = ?3",
            )?
            .query_row(params![group, &writer[..], seq as i64], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?;
        match held {
            None => {
                return Err(refuse(
                    "bad-format",
                    "a frontier reaches beyond what the hub holds of a writer",
                ))
            }
            Some((h, _)) if !same(&h, &hash) => {
                return Err(refuse(
                    "bad-format",
                    "a frontier's hash is not that envelope's",
                ))
            }
            // a snapshot that reaches beyond a removed writer's Cut is one no device loads (10.3)
            Some((_, 1)) => {
                return Err(refuse(
                    "removed-sender",
                    "a frontier reaches beyond a removed writer's Cut",
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
    Ok(frontier)
}

/// `[seq, hash]`: a number of 1 or more and a 32-byte hash.
fn head_of(head: &Value) -> Res<(u64, [u8; 32])> {
    if head.as_array().map(|a| a.len()) != Some(2) {
        return Err(refuse("bad-format", "a head is [seq, hash]"));
    }
    let seq = head[0]
        .as_u64()
        .filter(|s| *s >= 1 && *s <= i64::MAX as u64)
        .ok_or_else(|| refuse("bad-format", "a head's number"))?;
    let hash: [u8; 32] = head[1]
        .as_str()
        .and_then(unb64)
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| refuse("bad-format", "a head's hash"))?;
    Ok((seq, hash))
}

/// The file ids a post keeps, one after another.
fn files_of(body: &Value) -> Res<Vec<u8>> {
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
    Ok(files)
}

/// Folds a device's open declarations of a board into one: per writer the smallest number of all of them (a writer
/// one lacks is left out, it counts 0), the files of all of them, the newest time.
fn fold_declarations(
    c: &Connection,
    room: &Room,
    board: &[u8; 16],
    device: &[u8; 32],
    now: u64,
) -> Res<()> {
    let rows: Vec<(Vec<u8>, Vec<u8>, i64)> = {
        let mut s = c.prepare_cached(
            "SELECT frontier, files, waiting FROM board_frontiers WHERE room_id = ?1 AND board = ?2 AND device = ?3 AND bound = 0",
        )?;
        let rows = s
            .query_map(params![&room[..], &board[..], &device[..]], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let mut folded: Option<Frontier> = None;
    let mut files: Vec<u8> = Vec::new();
    let mut seen: std::collections::HashSet<Vec<u8>> = std::collections::HashSet::new();
    let waiting: i64 = rows.iter().map(|r| r.2).sum();
    for (frontier, kept, _) in &rows {
        let f = decode_frontier(frontier);
        folded = Some(match folded {
            None => f,
            Some(before) => before
                .into_iter()
                .filter_map(|(w, s)| f.iter().find(|(v, _)| *v == w).map(|(_, t)| (w, s.min(*t))))
                .collect(),
        });
        for id in ids_of(kept) {
            if seen.insert(id.to_vec()) {
                files.extend_from_slice(id);
            }
        }
    }
    c.prepare_cached(
        "DELETE FROM board_frontiers WHERE room_id = ?1 AND board = ?2 AND device = ?3 AND bound = 0",
    )?
    .execute(params![&room[..], &board[..], &device[..]])?;
    if let Some(folded) = folded {
        c.prepare_cached(
            "INSERT INTO board_frontiers (room_id, board, device, bound, frontier, files, at, counts, waiting) VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6, 1, ?7)",
        )?
        .execute(params![&room[..], &board[..], &device[..], encode_frontier(&folded), files, now as i64, waiting])?;
    }
    Ok(())
}

/// A snapshot whose frontier leaves out an item of the board that is already pruned could never be loaded: the
/// item after its frontier has no body. Such a frontier is `replay` (the device loads the newest snapshot and the
/// tail, and captures again).
fn behind_nothing_pruned(
    c: &Connection,
    room: &Room,
    board: &[u8; 16],
    frontier: &Frontier,
) -> Res<()> {
    let group: &[u8] = &room[..];
    let pruned: Vec<(Vec<u8>, i64)> = {
        let mut s = c.prepare_cached(
            "SELECT sender, max(seq) FROM envelopes WHERE room_id = ?1 AND timeline = ?2 AND group_id = ?3
               AND body IS NULL AND cut = 0 AND void_code IS NULL GROUP BY sender",
        )?;
        let rows = s
            .query_map(params![&room[..], board_key(board), group], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    for (sender, seq) in pruned {
        let covered = frontier
            .iter()
            .find(|(w, _)| w[..] == sender[..])
            .map_or(0, |(_, s)| *s as i64);
        if covered < seq {
            return Err(refuse(
                "replay",
                "a frontier behind an item of the board that is already pruned",
            ));
        }
    }
    Ok(())
}

/// `POST /v1/boards/{board}/frontier` (10.9), in two steps around a snapshot register value of `board`:
///
/// - `{ frontier, files }` before the register is written: a declaration, one row per declared frontier (at most
///   `MAX_DECLARED` open ones per device and board; more fold them into one). It only holds pruning back, so that a snapshot that becomes
///   current before its device binds it is covered from the start; its own bound post answers it, the 30 days of
///   10.9 end it otherwise. The same frontier declared twice (two snapshots of the same state, two tabs) waits
///   for two bound posts (`waiting`).
/// - `{ frontier, files, snapshot: [seq, hash] }` once the hub took the register value: bound to that envelope
///   (the device's own, a register value, its newest of that register, not cut), it replaces the device's bound
///   post; a bound post of an older value is `replay`. Its time is the value's arrival, never the post's.
///
/// Every frontier is checked against the room group's chains; then the board is pruned to what the counting
/// posts allow.
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
    let frontier = frontier_of(c, &room, body)?;
    behind_nothing_pruned(c, &room, board, &frontier)?;
    let files = files_of(body)?;
    let encoded = encode_frontier(&frontier);
    let stored = || -> Res<Option<(Option<i64>, Option<Vec<u8>>)>> {
        Ok(c.prepare_cached(
            "SELECT snapshot_seq, register_id FROM board_frontiers WHERE room_id = ?1 AND board = ?2 AND device = ?3 AND bound = 1",
        )?
        .query_row(params![&room[..], &board[..], &auth.device[..]], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?)
    };
    if body.get("snapshot").is_none() {
        // a declaration: its own row, until its bound post answers it
        let (open, again): (i64, i64) = c
            .prepare_cached(
                "SELECT count(*), coalesce(sum(frontier = ?4), 0) FROM board_frontiers WHERE room_id = ?1 AND board = ?2 AND device = ?3 AND bound = 0",
            )?
            .query_row(params![&room[..], &board[..], &auth.device[..], &encoded], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?;
        if again == 0 && open >= MAX_DECLARED {
            // (declarations whose bound posts never came: folded into one with, per writer, the smallest number of
            //  them and all their files; it holds back at least as much as they did, until the 30 days end it)
            fold_declarations(c, &room, board, &auth.device, now)?;
        }
        c.prepare_cached(
            "INSERT INTO board_frontiers (room_id, board, device, bound, frontier, files, at, counts) VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6, 1)
             ON CONFLICT (room_id, board, device, bound, frontier) DO UPDATE SET files = excluded.files, at = excluded.at, counts = 1, waiting = min(waiting + 1, 1000)",
        )?
        .execute(params![&room[..], &board[..], &auth.device[..], &encoded, files, now as i64])?;
    } else {
        // bound to the snapshot register value
        let (seq, hash) = head_of(&body["snapshot"])?;
        let value: Option<(Vec<u8>, Option<Vec<u8>>, i64, i64, Option<String>, i64)> = c
            .prepare_cached(
                "SELECT hash, register_id, cut, change, void_code, received_at FROM envelopes WHERE group_id = ?1 AND sender = ?2 AND seq = ?3",
            )?
            .query_row(params![group, &auth.device[..], seq as i64], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
            })
            .optional()?;
        let Some((held, Some(register_id), 0, change, None, arrived)) = value else {
            return Err(refuse(
                "bad-format",
                "snapshot: no register value of this device that the hub took",
            ));
        };
        if !same(&held, &hash) {
            return Err(refuse(
                "bad-format",
                "snapshot: the hash is not that envelope's",
            ));
        }
        let head: Option<i64> = c
            .prepare_cached(
                "SELECT head_change FROM registers WHERE group_id = ?1 AND writer = ?2 AND register_id = ?3",
            )?
            .query_row(params![group, &auth.device[..], &register_id], |r| r.get(0))
            .optional()?;
        if let Some((Some(before), Some(bound_register))) = stored()? {
            if !same(&bound_register, &register_id) {
                return Err(refuse(
                    "bad-format",
                    "snapshot: another register than this device's snapshot of the board",
                ));
            }
            if before > seq as i64 {
                return Err(refuse(
                    "replay",
                    "snapshot: an older value than the one bound",
                ));
            }
            if before == seq as i64 {
                // the same value again: nothing changes, its time stays
                let pruned = apply_board(c, &room, board, now, fx)?;
                return Ok(json!({ "pruned": pruned }));
            }
        }
        if head != Some(change) {
            return Err(refuse(
                "replay",
                "snapshot: not the newest value of its register",
            ));
        }
        c.prepare_cached(
            "DELETE FROM board_frontiers WHERE room_id = ?1 AND board = ?2 AND device = ?3 AND bound = 1",
        )?
        .execute(params![&room[..], &board[..], &auth.device[..]])?;
        c.prepare_cached(
            "INSERT INTO board_frontiers (room_id, board, device, bound, frontier, files, at, snapshot_seq, register_id, counts) VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, ?8, 1)",
        )?
        .execute(params![&room[..], &board[..], &auth.device[..], &encoded, files, arrived, seq as i64, &register_id])?;
        // the declaration of this very snapshot is answered; others (a snapshot still on its way, also one of the
        // same frontier from another tab of this device) hold back on
        c.prepare_cached(
            "UPDATE board_frontiers SET waiting = waiting - 1 WHERE room_id = ?1 AND board = ?2 AND device = ?3 AND bound = 0 AND frontier = ?4",
        )?
        .execute(params![&room[..], &board[..], &auth.device[..], &encoded])?;
        c.prepare_cached(
            "DELETE FROM board_frontiers WHERE room_id = ?1 AND board = ?2 AND device = ?3 AND bound = 0 AND frontier = ?4 AND waiting <= 0",
        )?
        .execute(params![&room[..], &board[..], &auth.device[..], &encoded])?;
    }
    let pruned = apply_board(c, &room, board, now, fx)?;
    Ok(json!({ "pruned": pruned }))
}

/// Whether a stored post still stands: nothing it names (its frontier, its snapshot value) lies beyond a Cut.
fn standing(
    c: &Connection,
    room: &Room,
    frontier: &Frontier,
    snapshot: Option<(&[u8], i64)>,
) -> Res<bool> {
    let group: &[u8] = &room[..];
    let mut s = c.prepare_cached(
        "SELECT cut FROM envelopes WHERE group_id = ?1 AND sender = ?2 AND seq = ?3",
    )?;
    let cut = |s: &mut rusqlite::CachedStatement, w: &[u8], seq: i64| -> Res<bool> {
        Ok(s.query_row(params![group, w, seq], |r| r.get::<_, i64>(0))
            .optional()?
            .is_none_or(|c| c == 1))
    };
    for (w, seq) in frontier {
        if cut(&mut s, &w[..], *seq as i64)? {
            return Ok(false);
        }
    }
    if let Some((device, seq)) = snapshot {
        if cut(&mut s, device, seq)? {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Marks which posts of `board` count, then prunes per writer up to the smallest number the counting posts give
/// it. A post counts while it is at most 30 days older than the board's newest and nothing it names lies beyond a
/// Cut; its device need not be a leaf any more: a removed device's snapshot value within its Cut can still be
/// current. Declarations only hold back: without a standing bound post nothing is pruned, and the 30 days run from
/// the newest bound one.
pub fn apply_board(
    c: &Connection,
    room: &Room,
    board: &[u8; 16],
    now: u64,
    fx: &mut Effects,
) -> Res<usize> {
    let group: &[u8] = &room[..];
    let posts: Vec<(Vec<u8>, i64, Vec<u8>, i64, Option<i64>)> = {
        let mut s = c.prepare_cached(
            "SELECT device, bound, frontier, at, snapshot_seq FROM board_frontiers WHERE room_id = ?1 AND board = ?2",
        )?;
        let rows = s
            .query_map(params![&room[..], &board[..]], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let mark = |device: &[u8], bound: i64, stored: &[u8], counts: bool| -> Res<()> {
        c.prepare_cached("UPDATE board_frontiers SET counts = ?1 WHERE room_id = ?2 AND board = ?3 AND device = ?4 AND bound = ?5 AND frontier = ?6")?
            .execute(params![counts as i64, &room[..], &board[..], device, bound, stored])?;
        Ok(())
    };
    let mut live: Vec<(Vec<u8>, i64, Vec<u8>, Frontier, i64)> = Vec::new();
    for (device, bound, stored, at, snapshot) in posts {
        let frontier = decode_frontier(&stored);
        if standing(c, room, &frontier, snapshot.map(|s| (&device[..], s)))? {
            live.push((device, bound, stored, frontier, at));
        } else {
            mark(&device, bound, &stored, false)?;
        }
    }
    // the 30 days run from the newest bound post: a declaration only holds back, it never ends another's count
    let Some(newest) = live.iter().filter(|p| p.1 == 1).map(|p| p.4).max() else {
        return Ok(0);
    };
    let from = newest.saturating_sub(FRONTIER_WINDOW_MS as i64);
    let mut counting: Vec<Frontier> = Vec::new();
    for (device, bound, stored, frontier, at) in live {
        let counts = at >= from;
        if !counts && bound == 0 {
            // a declaration out of the 30 days is over
            c.prepare_cached("DELETE FROM board_frontiers WHERE room_id = ?1 AND board = ?2 AND device = ?3 AND bound = 0 AND frontier = ?4")?
                .execute(params![&room[..], &board[..], &device, &stored])?;
            continue;
        }
        mark(&device, bound, &stored, counts)?;
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
