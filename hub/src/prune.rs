//! What the hub prunes as content arrives (spec/v1.md 9.4.2, 9.4.3, 10.9; hub-api.md point 45). Pruning sets an
//! envelope's body to NULL: header, nonce, ciphertext hash and signature stay, so every chain still verifies and
//! every object state replays. A file goes when every envelope that named it is pruned and no counting board
//! frontier post keeps it.

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::Res;
use crate::store::{Effects, Room};
use crate::wire;

/// The 16-byte ids of a `file_ids` column.
fn ids_of(blob: &[u8]) -> impl Iterator<Item = &[u8]> {
    blob.chunks_exact(16)
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
    Ok(false)
}

/// Deletes those of `file_ids` that nothing needs any more (as 9.4 deletes files). Returns how many.
fn drop_files(c: &Connection, room: &Room, file_ids: &[Vec<u8>], now: u64, fx: &mut Effects) -> Res<usize> {
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

/// 9.4.2: a register value was taken: the same writer's earlier values of that register lose their bodies. A
/// writer's lamport rises along its chain, so none of them can be current again.
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
        _ => Ok(0),
    }
}

/// The sweep for what was stored before 9.4.2 (and what a crash between two writes left): at most `batch`
/// writers' registers per call. Returns how many bodies went.
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
            .query_map([batch], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    for (room, group, writer, register, seq) in rows {
        let Ok(room) = <Room>::try_from(&room[..]) else { continue };
        total += prune_where(
            c,
            &room,
            "group_id = ?2 AND sender = ?3 AND register_id = ?4 AND seq < ?5",
            &[&group, &writer, &register, &seq],
            now,
            fx,
        )?;
    }
    Ok(total)
}
