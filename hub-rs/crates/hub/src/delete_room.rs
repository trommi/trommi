//! Removing whole rooms for the admin page's "Test accounts" (hub/ops/delete-room.mjs): only rooms whose account
//! email ends with @example.org; an online backup first (VACUUM INTO, gzipped, the 5 newest kept), then one
//! transaction per room over every table with a room_id column, then its attachment files; each deletion logged and
//! appended to <data>/deletions.log.

use crate::server::Hub;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use std::io::Write;
use std::path::{Path, PathBuf};

pub const TEST_EMAIL_SUFFIX: &str = "@example.org";
const BACKUPS_KEPT: usize = 5;

pub fn is_test_email(e: Option<&str>) -> bool { e.is_some_and(|e| e.trim().to_lowercase().ends_with(TEST_EMAIL_SUFFIX)) }
fn has_table(c: &Connection, name: &str) -> bool {
    c.query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [name], |_| Ok(())).optional().ok().flatten().is_some()
}

#[derive(Clone)]
pub struct TestAccount {
    pub room_id: String,
    pub email: String,
    pub created_at: Option<i64>,
    pub last_activity: Option<i64>,
    pub envelopes: i64,
    pub attachments: i64,
}

/// Accounts whose email ends with @example.org, with what their room holds. Works on a read-only connection.
pub fn test_accounts(c: &Connection) -> Vec<TestAccount> {
    if !has_table(c, "accounts") {
        return vec![];
    }
    let count = |t: &str| if has_table(c, t) { format!("(SELECT COUNT(*) FROM \"{t}\" x WHERE x.room_id = a.room_id)") } else { "0".into() };
    let last = if has_table(c, "envelopes") { "(SELECT MAX(received_at) FROM envelopes x WHERE x.room_id = a.room_id)" } else { "NULL" };
    let updated = if c.query_row("SELECT 1 FROM pragma_table_info('accounts') WHERE name = 'updated_at'", [], |_| Ok(())).optional().ok().flatten().is_some() { "a.updated_at" } else { "NULL" };
    let sql = format!(
        "SELECT a.room_id, a.email, a.created_at, MAX(COALESCE({last}, 0), COALESCE({updated}, 0), COALESCE(a.created_at, 0)) AS last_activity,
      {} AS envelopes, {} AS attachments
    FROM accounts a WHERE lower(trim(a.email)) LIKE ? ORDER BY a.created_at, a.room_id",
        count("envelopes"),
        count("attachments")
    );
    let Ok(mut st) = c.prepare(&sql) else { return vec![] };
    let rows: Vec<TestAccount> = st
        .query_map([format!("%{TEST_EMAIL_SUFFIX}")], |r| {
            Ok(TestAccount { room_id: r.get(0)?, email: r.get::<_, Option<String>>(1)?.unwrap_or_default(), created_at: r.get(2)?, last_activity: r.get(3)?, envelopes: r.get(4)?, attachments: r.get(5)? })
        })
        .and_then(|it| it.collect())
        .unwrap_or_default();
    rows.into_iter().filter(|r| is_test_email(Some(&r.email))).collect()
}

/// The account email of the room; Err unless it ends with @example.org (or allow_non_test).
fn check_test_room(c: &Connection, room: &str, allow_non_test: bool) -> Result<Option<String>, String> {
    if !zcrypto::bytes::is_hex(room, 64) {
        return Err("room id: 64 hex characters".into());
    }
    let email: Option<String> = if has_table(c, "accounts") { c.query_row("SELECT email FROM accounts WHERE room_id = ?", [room], |r| r.get(0)).optional().ok().flatten() } else { None };
    if !allow_non_test && !is_test_email(email.as_deref()) {
        return Err(format!("room {} is not a test room (its account email does not end with {TEST_EMAIL_SUFFIX}); refused", &room[..12]));
    }
    Ok(email)
}

/// Every row of the room (one transaction), then its attachment files. → (email, rows per table, files)
pub fn delete_room(c: &Connection, data_dir: &Path, room: &str, allow_non_test: bool) -> Result<(Option<String>, Map<String, Value>, usize), String> {
    let email = check_test_room(c, room, allow_non_test)?;
    let mut rows = Map::new();
    crate::db::tx(c, |c| {
        for t in crate::ops::room_tables(c) {
            let n = c.execute(&format!("DELETE FROM \"{t}\" WHERE room_id = ?"), [room])?;
            if n > 0 {
                rows.insert(t, json!(n));
            }
        }
        Ok::<_, rusqlite::Error>(())
    })
    .map_err(|e| e.to_string())?;
    let dir = data_dir.join("attachments").join(room);
    let files = std::fs::read_dir(&dir).map(|d| d.count()).unwrap_or(0);
    let _ = std::fs::remove_dir_all(&dir);
    Ok((email, rows, files))
}

/// An online copy of hub.db (VACUUM INTO on the hub's connection), gzipped. → its path
pub fn backup_db(c: &Connection, data_dir: &Path, label: &str) -> Result<PathBuf, String> {
    let dir = data_dir.join("backups");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    let ms = crate::util::now();
    let (y, mo, d, h, mi, s) = crate::util::civil(ms.div_euclid(1000));
    let raw = dir.join(format!("hub-{y:04}{mo:02}{d:02}-{h:02}{mi:02}{s:02}-{label}.db"));
    let _ = std::fs::remove_file(&raw);
    c.execute("VACUUM INTO ?", [raw.to_string_lossy().as_ref()]).map_err(|e| e.to_string())?;
    let gz = PathBuf::from(format!("{}.gz", raw.display()));
    let part = PathBuf::from(format!("{}.part", gz.display()));
    let r = (|| -> std::io::Result<()> {
        let mut input = std::fs::File::open(&raw)?;
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.mode(0o600);
        }
        let mut enc = flate2::write::GzEncoder::new(o.open(&part)?, flate2::Compression::new(1));
        std::io::copy(&mut input, &mut enc)?;
        enc.finish()?.flush()?;
        std::fs::rename(&part, &gz)
    })();
    let _ = std::fs::remove_file(&raw);
    let _ = std::fs::remove_file(&part);
    r.map_err(|e| e.to_string())?;
    let suffix = format!("-{label}.db.gz");
    let mut old: Vec<String> = std::fs::read_dir(&dir).map(|d| d.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|f| f.ends_with(&suffix)).collect()).unwrap_or_default();
    old.sort();
    old.reverse();
    for f in old.into_iter().skip(BACKUPS_KEPT) {
        let _ = std::fs::remove_file(dir.join(f));
    }
    Ok(gz)
}

/// Backup first, then each room. → { backup, deleted: [{ room_id, email, rows, files }], refused: [{ room_id, message }], totals }
pub fn delete_rooms(hub: &Hub, ids: &[String], by: &str, allow_non_test: bool) -> Result<Value, String> {
    let data_dir = PathBuf::from(&hub.cfg.data_dir);
    let backup = backup_db(&hub.db.w(), &data_dir, "before-delete")?;
    let bk = backup.to_string_lossy().into_owned();
    hub.log(&format!("delete rooms: backup {bk}"));
    let (mut deleted, mut refused) = (vec![], vec![]);
    let mut totals = Map::new();
    for room in ids {
        let checked = check_test_room(&hub.db.w(), room, allow_non_test);
        let res = checked.and_then(|_| {
            hub.close_room(room);
            let r = delete_room(&hub.db.w(), &data_dir, room, allow_non_test);
            hub.close_room(room);
            r
        });
        match res {
            Ok((email, rows, files)) => {
                for (t, n) in &rows {
                    let cur = totals.get(t).and_then(|v| v.as_i64()).unwrap_or(0);
                    totals.insert(t.clone(), json!(cur + n.as_i64().unwrap_or(0)));
                }
                let cur = totals.get("files").and_then(|v| v.as_i64()).unwrap_or(0);
                totals.insert("files".into(), json!(cur + files as i64));
                let line = json!({ "at": crate::util::iso_time(crate::util::now()), "by": by, "room_id": room, "email": email, "rows": rows, "files": files,
                    "backup": backup.file_name().unwrap().to_string_lossy() });
                if let Ok(mut f) = std::fs::OpenOptions::new().append(true).create(true).open(data_dir.join("deletions.log")) {
                    let _ = writeln!(f, "{line}");
                }
                let summary = rows.iter().map(|(t, n)| format!("{t} {n}")).collect::<Vec<_>>().join(", ");
                hub.log(&format!("delete rooms: room {} ({}) deleted by {by}: {}, files {files}", &room[..12], email.clone().unwrap_or_default(), if summary.is_empty() { "no rows".into() } else { summary }));
                deleted.push(json!({ "room_id": room, "email": email, "rows": rows, "files": files }));
            }
            Err(message) => {
                hub.log(&format!("delete rooms: room {} not deleted: {message}", room.chars().take(12).collect::<String>()));
                refused.push(json!({ "room_id": room, "message": message }));
            }
        }
    }
    Ok(json!({ "backup": bk, "deleted": deleted, "refused": refused, "totals": totals }))
}
