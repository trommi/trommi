//! Files and Share links (spec/v2.md section 11, D3). A file is ciphertext to the hub: bytes under a random id,
//! written once, never changed. It lies beside the database, one file per id. A Share link gives one file of an
//! open Artifact to whoever presents the link's secret; the hub keeps the secret's hash, never the file's key.

use std::io::Write;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::delivery::Ctx;
use crate::error::{refuse, Res};
use crate::observer::Device;
use crate::store::{self, Auth, Effects, Room, Who};
use crate::util::{b64, hex, random, same};
use crate::wire;

/// Where a file's bytes lie. Both parts of the path are hex of fixed-length ids: nothing of a request reaches a
/// path as text.
pub fn path(dir: &Path, room: &Room, file_id: &[u8; 16]) -> PathBuf {
    dir.join(hex(room)).join(hex(file_id))
}

/// An upload in progress: written to a temporary file beside its target, hashed as it comes.
pub struct Upload {
    target: PathBuf,
    temp: PathBuf,
    file: Option<std::fs::File>,
    hash: Sha256,
    pub size: u64,
}

impl Upload {
    pub fn begin(dir: &Path, room: &Room, file_id: &[u8; 16]) -> std::io::Result<Upload> {
        let target = path(dir, room, file_id);
        std::fs::create_dir_all(target.parent().expect("a room folder"))?;
        let temp = target.with_extension(format!("part-{}", hex(&random::<8>())));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&temp)?;
        Ok(Upload {
            target,
            temp,
            file: Some(file),
            hash: Sha256::new(),
            size: 0,
        })
    }

    pub fn write(&mut self, chunk: &[u8]) -> std::io::Result<()> {
        self.hash.update(chunk);
        self.size += chunk.len() as u64;
        self.file
            .as_mut()
            .expect("open until finished")
            .write_all(chunk)
    }

    /// Flushes to disk and returns the SHA-256 of what was written. The file is not yet at its place.
    pub fn seal(&mut self) -> std::io::Result<[u8; 32]> {
        let file = self.file.take().expect("sealed once");
        file.sync_all()?;
        Ok(self.hash.clone().finalize().into())
    }

    /// Puts the file at its place. Called inside the transaction that writes its row, so that no deletion of
    /// that row can come between the two. Something lying there without a row is a leftover of a crash and
    /// gives way; a stored file with its row is never overwritten (the row is checked before).
    pub fn place(&mut self) -> std::io::Result<()> {
        let mut result = std::fs::hard_link(&self.temp, &self.target);
        if matches!(&result, Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists) {
            std::fs::remove_file(&self.target)?;
            result = std::fs::hard_link(&self.temp, &self.target);
        }
        result?;
        let _ = std::fs::remove_file(&self.temp);
        self.temp = PathBuf::new();
        Ok(())
    }
}

/// An upload that ends in any other way leaves no temporary file behind.
impl Drop for Upload {
    fn drop(&mut self) {
        if !self.temp.as_os_str().is_empty() {
            let _ = std::fs::remove_file(&self.temp);
        }
    }
}

/// Before the bytes: may this device upload under this id. Returns the bytes the room's files hold, and whether
/// the id holds a file of this uploader already (then the bytes decide: a repeat is answered like the first
/// time and needs no room, other bytes are `replay`).
pub fn admit(x: &Ctx, auth: &Auth, file_id: &[u8; 16], announced: Option<u64>) -> Res<(u64, bool)> {
    auth.member()?;
    if announced.is_some_and(|n| n > x.cfg.file_limit) {
        return Err(refuse("too-large", "a file is at most 64 MiB"));
    }
    let held: Option<(Vec<u8>, bool)> = x
        .c
        .prepare_cached("SELECT uploader, deleted_at IS NOT NULL FROM files WHERE room_id = ?1 AND file_id = ?2")?
        .query_row(params![&auth.room[..], &file_id[..]], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    let again = match held {
        Some((_, true)) => {
            return Err(refuse(
                "gone",
                "this file was deleted; its id is not used again",
            ))
        }
        Some((uploader, false)) if !same(&uploader, &auth.device) => {
            return Err(refuse("replay", "this file id is used"))
        }
        Some(_) => true,
        None => false,
    };
    Ok((store::room_row(x.c, &auth.room)?.file_bytes, again))
}

pub fn over_quota(used: u64, quota: u64) -> crate::error::Refused {
    refuse("quota-exceeded", "the room's files are at their limit")
        .with(json!({ "used": used, "quota": quota }))
}

pub enum Stored {
    New,
    /// the same bytes were stored before: answered like the first time
    Again,
}

/// After the bytes: the row. Judged again inside the transaction (the device may have been removed, another
/// upload may have won meanwhile).
pub fn record(
    x: &Ctx,
    auth: &Auth,
    file_id: &[u8; 16],
    size: u64,
    sha256: &[u8; 32],
) -> Res<Stored> {
    let held: Option<(Vec<u8>, i64, Vec<u8>, bool)> = x
        .c
        .prepare_cached("SELECT uploader, size, sha256, deleted_at IS NOT NULL FROM files WHERE room_id = ?1 AND file_id = ?2")?
        .query_row(params![&auth.room[..], &file_id[..]], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .optional()?;
    if let Some((uploader, held_size, held_hash, deleted)) = held {
        if deleted {
            return Err(refuse(
                "gone",
                "this file was deleted; its id is not used again",
            ));
        }
        let same_file =
            same(&uploader, &auth.device) && held_size as u64 == size && same(&held_hash, sha256);
        return if same_file {
            Ok(Stored::Again)
        } else {
            Err(refuse("replay", "other bytes under a used file id"))
        };
    }
    let room = store::room_row(x.c, &auth.room)?;
    if room.file_bytes + size > x.cfg.room_quota {
        return Err(
            refuse("quota-exceeded", "the room's files are at their limit")
                .with(json!({ "used": room.file_bytes, "quota": x.cfg.room_quota })),
        );
    }
    x.c.prepare_cached("INSERT INTO files (room_id, file_id, uploader, size, sha256, stored_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")?
        .execute(params![&auth.room[..], &file_id[..], &auth.device[..], size as i64, &sha256[..], x.now as i64])?;
    x.c.prepare_cached("UPDATE rooms SET file_bytes = file_bytes + ?1 WHERE room_id = ?2")?
        .execute(params![size as i64, &auth.room[..]])?;
    Ok(Stored::New)
}

pub struct FileRow {
    pub size: u64,
    pub uploader: Device,
    pub group_id: Option<Vec<u8>>,
    pub object_id: Option<Vec<u8>>,
}

fn file_row(c: &Connection, room: &Room, file_id: &[u8]) -> Res<Option<FileRow>> {
    Ok(c.prepare_cached("SELECT size, uploader, group_id, object_id FROM files WHERE room_id = ?1 AND file_id = ?2 AND deleted_at IS NULL")?
        .query_row(params![&room[..], file_id], |r| {
            Ok(FileRow { size: r.get::<_, i64>(0)? as u64, uploader: store::fixed(r.get(1)?)?, group_id: r.get(2)?, object_id: r.get(3)? })
        })
        .optional()?)
}

/// 11.3: human devices of the room fetch a file; an agent or helper device only while it is a leaf of the file's
/// group; a file no envelope names yet, only its uploader. What the asker may not fetch does not exist for it.
pub fn readable(c: &Connection, auth: &Auth, file_id: &[u8; 16]) -> Res<FileRow> {
    auth.member()?;
    let missing = || refuse("not-found", "no such file");
    let row = file_row(c, &auth.room, file_id)?.ok_or_else(missing)?;
    let allowed = match (&row.group_id, auth.who) {
        (None, _) => row.uploader == auth.device,
        (Some(_), Who::Human) => true,
        (Some(group), _) => store::is_leaf(c, group, &auth.device)?,
    };
    if allowed {
        Ok(row)
    } else {
        Err(missing())
    }
}

/// `DELETE /v2/files/{file_id}`: its uploader or a human device.
pub fn delete(x: &Ctx, auth: &Auth, file_id: &[u8; 16], fx: &mut Effects) -> Res<Value> {
    auth.member()?;
    let row =
        file_row(x.c, &auth.room, file_id)?.ok_or_else(|| refuse("not-found", "no such file"))?;
    if !(auth.who == Who::Human || row.uploader == auth.device) {
        return Err(refuse("not-found", "no such file"));
    }
    crate::content::delete_file(x.c, &auth.room, file_id, row.size as i64, x.now, fx)?;
    fx.events.push(crate::store::Event {
        room: auth.room,
        audience: crate::store::Audience {
            humans: true,
            others: row
                .group_id
                .as_deref()
                .map(|g| store::leaves(x.c, g))
                .transpose()?
                .unwrap_or_default(),
            except: None,
        },
        name: "file_evicted",
        change: None,
        data: json!({ "file_id": b64(file_id) }),
    });
    Ok(json!({ "deleted": true }))
}

/// 11.3: a file that no envelope of its uploader named within an hour is deleted.
pub fn sweep_pending(db: &crate::db::Db, now: u64, fx: &mut Effects) -> Res<usize> {
    db.write(|c| {
        let due: Vec<(Vec<u8>, Vec<u8>, i64)> = {
            let mut s = c.prepare_cached("SELECT room_id, file_id, size FROM files WHERE referenced_at IS NULL AND deleted_at IS NULL AND stored_at <= ?1 LIMIT 500")?;
            let rows = s.query_map([now.saturating_sub(3_600_000) as i64], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        for (room, file, size) in &due {
            if let Ok(room) = <Room>::try_from(&room[..]) {
                crate::content::delete_file(c, &room, file, *size, now, fx)?;
            }
        }
        Ok(due.len())
    })
}

/// Temporary files that a crash left behind: older than a day, they belong to no running upload.
pub fn sweep_parts(dir: &Path) -> usize {
    let mut removed = 0;
    let Ok(rooms) = std::fs::read_dir(dir) else {
        return 0;
    };
    for room in rooms.flatten() {
        let Ok(files) = std::fs::read_dir(room.path()) else {
            continue;
        };
        for f in files.flatten() {
            let stale = f.file_name().to_string_lossy().contains(".part-")
                && f.metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.elapsed().ok())
                    .is_some_and(|age| age.as_secs() > 86_400);
            if stale && std::fs::remove_file(f.path()).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

// ---- Share links (11.5)

const MAX_SHARES_PER_ROOM: i64 = 1000;

/// `POST /v2/shares`: its maker (the session's agent or helper device, or a human device) registers the id, the
/// hash of the link's secret, the file and an expiry. The file belongs to an open Artifact.
pub fn share(
    x: &Ctx,
    auth: &Auth,
    share_id: &[u8; 16],
    secret_hash: &[u8; 32],
    file_id: &[u8; 16],
    expires_at: u64,
) -> Res<Value> {
    let row = readable(x.c, auth, file_id)?;
    let missing = || refuse("forbidden", "a Share link gives a file of an open Artifact");
    let (Some(group), Some(object)) = (&row.group_id, &row.object_id) else {
        return Err(missing());
    };
    let artifact_open =
        x.c.prepare_cached(
            "SELECT 1 FROM artifacts WHERE room_id = ?1 AND object_id = ?2 AND state = ?3",
        )?
        .exists(params![&auth.room[..], object, wire::STATE_OPEN])?;
    if !artifact_open {
        return Err(missing());
    }
    if auth.who != Who::Human && !store::is_leaf(x.c, group, &auth.device)? {
        return Err(missing());
    }
    if expires_at <= x.now || expires_at > x.now + x.cfg.share_days * 86_400_000 {
        return Err(refuse(
            "bad-format",
            format!("a Share link expires within {} days", x.cfg.share_days),
        ));
    }
    if let Some((held_room, held_hash, held_file, held_expires)) =
        x.c.prepare_cached(
            "SELECT room_id, secret_hash, file_id, expires_at FROM shares WHERE share_id = ?1",
        )?
        .query_row([&share_id[..]], |r| {
            Ok((
                r.get::<_, Vec<u8>>(0)?,
                r.get::<_, Vec<u8>>(1)?,
                r.get::<_, Vec<u8>>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })
        .optional()?
    {
        // never replaced: the same registration again is answered like the first time
        let again = same(&held_room, &auth.room)
            && same(&held_hash, secret_hash)
            && same(&held_file, file_id)
            && held_expires as u64 == expires_at;
        return if again {
            Ok(json!({ "share_id": b64(share_id), "expires_at": expires_at }))
        } else {
            Err(refuse("replay", "this share id is used"))
        };
    }
    let open: i64 =
        x.c.prepare_cached("SELECT count(*) FROM shares WHERE room_id = ?1")?
            .query_row([&auth.room[..]], |r| r.get(0))?;
    if open >= MAX_SHARES_PER_ROOM {
        return Err(refuse("too-many", "a room has at most 1000 Share links"));
    }
    x.c.prepare_cached("INSERT INTO shares (share_id, room_id, file_id, secret_hash, expires_at, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")?
        .execute(params![&share_id[..], &auth.room[..], &file_id[..], &secret_hash[..], expires_at as i64, &auth.device[..], x.now as i64])?;
    Ok(json!({ "share_id": b64(share_id), "expires_at": expires_at }))
}

/// `DELETE /v2/shares/{share_id}`: revoked by its maker or a human device of its room.
pub fn unshare(x: &Ctx, auth: &Auth, share_id: &[u8; 16]) -> Res<Value> {
    auth.member()?;
    let n = x
        .c
        .prepare_cached("DELETE FROM shares WHERE share_id = ?1 AND room_id = ?2 AND (?3 = 1 OR created_by = ?4)")?
        .execute(params![&share_id[..], &auth.room[..], auth.who == Who::Human, &auth.device[..]])?;
    if n == 0 {
        return Err(refuse("not-found", "no such share"));
    }
    Ok(json!({ "deleted": true }))
}

/// `GET /v2/shares/{share_id}` with the link's secret: the room and file to serve. Every refusal is the same
/// answer, and the stored hash is compared in constant time.
pub fn open_share(
    c: &Connection,
    share_id: &[u8; 16],
    secret: Option<&[u8]>,
    now: u64,
) -> Res<(Room, [u8; 16], u64)> {
    let missing = || refuse("not-found", "no such share, or it ran out");
    let row: Option<(Vec<u8>, Vec<u8>, Vec<u8>, i64)> = c
        .prepare_cached(
            "SELECT room_id, file_id, secret_hash, expires_at FROM shares WHERE share_id = ?1",
        )?
        .query_row([&share_id[..]], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .optional()?;
    // compare against something in every case, so that an unknown id costs what a known one costs
    let presented: [u8; 32] = Sha256::digest(secret.unwrap_or(&[])).into();
    let (room, file, hash, expires) =
        row.unwrap_or((vec![0; 32], vec![0; 16], random::<32>().to_vec(), 0));
    let matches = same(&presented, &hash);
    if !matches || secret.is_none_or(|s| s.len() != 32) || expires as u64 <= now {
        return Err(missing());
    }
    let room: Room = room.try_into().map_err(|_| missing())?;
    let file: [u8; 16] = file.try_into().map_err(|_| missing())?;
    let size = file_row(c, &room, &file)?.ok_or_else(missing)?.size;
    Ok((room, file, size))
}
