//! hub.db: the same SQLite schema as hub/store.mjs (README "What the hub stores"), so either hub opens the
//! other's data directory. Truth: envelopes and member_entries. Derived and rebuildable: objects, timelines.
//!
//! One writing connection (as the Node hub has one), and a few reading connections for the hot read paths
//! (GET envelopes, threads, the stream's catch-up): WAL lets them read while the writer writes.

use parking_lot::{Mutex, MutexGuard};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};

pub const SCHEMA_VERSION: i64 = 2;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS rooms (
  room_id TEXT PRIMARY KEY, founded_at INTEGER NOT NULL, last_entry_number INTEGER NOT NULL, last_envelope_number INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS member_entries (
  room_id TEXT NOT NULL, entry_number INTEGER NOT NULL, previous_entry_hash TEXT NOT NULL, entry_hash TEXT NOT NULL,
  entry_action TEXT NOT NULL, signer_device_id TEXT NOT NULL, signed_entry BLOB NOT NULL, received_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, entry_number)
);
CREATE TABLE IF NOT EXISTS devices (
  room_id TEXT NOT NULL, device_id TEXT NOT NULL, device_role TEXT NOT NULL, key_signing_public BLOB NOT NULL, key_exchange_public BLOB NOT NULL,
  added_entry_number INTEGER NOT NULL, removed_entry_number INTEGER, removal_cut_sequence INTEGER, removal_cut_hash BLOB,
  PRIMARY KEY (room_id, device_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sealed_room_keys (
  room_id TEXT NOT NULL, key_epoch INTEGER NOT NULL, device_id TEXT NOT NULL, key_sealed BLOB NOT NULL,
  PRIMARY KEY (room_id, device_id, key_epoch)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS key_back_links (
  room_id TEXT NOT NULL, key_epoch INTEGER NOT NULL, key_back_link BLOB NOT NULL, PRIMARY KEY (room_id, key_epoch)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS session_grants (
  room_id TEXT NOT NULL, session_id TEXT NOT NULL, grant_number INTEGER NOT NULL, previous_grant_hash TEXT NOT NULL, grant_hash TEXT NOT NULL,
  session_key_epoch INTEGER NOT NULL, signer_device_id TEXT NOT NULL, signed_grant BLOB NOT NULL, received_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, session_id, grant_number)
);
CREATE TABLE IF NOT EXISTS sealed_session_keys (
  room_id TEXT NOT NULL, session_id TEXT NOT NULL, session_key_epoch INTEGER NOT NULL, device_id TEXT NOT NULL, key_sealed BLOB NOT NULL,
  PRIMARY KEY (room_id, session_id, device_id, session_key_epoch)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS session_key_back_links (
  room_id TEXT NOT NULL, session_id TEXT NOT NULL, session_key_epoch INTEGER NOT NULL, key_back_link BLOB NOT NULL,
  PRIMARY KEY (room_id, session_id, session_key_epoch)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS invites (
  room_id TEXT NOT NULL, invite_id TEXT NOT NULL, device_role TEXT NOT NULL, inviter_device_id TEXT NOT NULL, signed_offer BLOB NOT NULL,
  expires_at INTEGER NOT NULL, signed_reveal BLOB, answered_request_hash TEXT, used_at INTEGER, added_device_id TEXT, burned_at INTEGER,
  PRIMARY KEY (room_id, invite_id)
);
CREATE TABLE IF NOT EXISTS join_requests (
  room_id TEXT NOT NULL, invite_id TEXT NOT NULL, request_hash TEXT NOT NULL, device_id TEXT NOT NULL, signed_request BLOB NOT NULL, received_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, invite_id, request_hash)
);
CREATE TABLE IF NOT EXISTS envelopes (
  room_id TEXT NOT NULL, envelope_number INTEGER NOT NULL, sender_device_id BLOB NOT NULL, sender_sequence INTEGER NOT NULL,
  previous_envelope_hash BLOB NOT NULL, envelope_hash BLOB NOT NULL, key_epoch INTEGER NOT NULL, recipient_device_id BLOB,
  object_id TEXT, object_state INTEGER, urgency INTEGER, answered_at INTEGER,
  envelope_kind INTEGER NOT NULL, timeline_kind INTEGER, timeline_id TEXT, send_push INTEGER NOT NULL,
  attachment_ids TEXT, padded_size INTEGER NOT NULL, sent_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
  envelope_header BLOB NOT NULL, envelope_nonce BLOB NOT NULL, encrypted_body BLOB, encrypted_body_hash BLOB NOT NULL, envelope_signature BLOB NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS envelopes_by_number ON envelopes (room_id, envelope_number);
CREATE UNIQUE INDEX IF NOT EXISTS envelopes_by_sender ON envelopes (room_id, sender_device_id, sender_sequence);
CREATE INDEX IF NOT EXISTS envelopes_by_timeline ON envelopes (room_id, timeline_kind, timeline_id, envelope_number) WHERE timeline_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS envelopes_by_object ON envelopes (room_id, object_id) WHERE object_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS objects (
  room_id TEXT NOT NULL, object_id TEXT NOT NULL, object_state INTEGER NOT NULL, urgency INTEGER NOT NULL, answered_at INTEGER NOT NULL,
  owner_device_id TEXT NOT NULL, first_envelope_number INTEGER NOT NULL, latest_head_envelope_number INTEGER NOT NULL,
  PRIMARY KEY (room_id, object_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS objects_open ON objects (room_id, object_state, urgency);
CREATE TABLE IF NOT EXISTS timelines (
  room_id TEXT NOT NULL, timeline_kind INTEGER NOT NULL, timeline_id TEXT NOT NULL, last_envelope_number INTEGER NOT NULL, item_count INTEGER NOT NULL,
  PRIMARY KEY (room_id, timeline_kind, timeline_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS attachments (
  room_id TEXT NOT NULL, attachment_id TEXT NOT NULL, object_id TEXT, uploader_device_id TEXT NOT NULL, total_size INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL, stored_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, attachment_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS attachments_by_object ON attachments (room_id, object_id) WHERE object_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS agent_leases (
  room_id TEXT NOT NULL, device_id TEXT NOT NULL, process_instance TEXT NOT NULL, lease_generation INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, device_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS push_subscriptions (
  room_id TEXT NOT NULL, device_id TEXT NOT NULL, endpoint TEXT NOT NULL, subscription TEXT NOT NULL, created_at INTEGER NOT NULL, level TEXT NOT NULL DEFAULT 'all',
  PRIMARY KEY (room_id, device_id, endpoint)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS live_activities (
  room_id TEXT NOT NULL, device_id TEXT NOT NULL, environment TEXT NOT NULL, topic TEXT NOT NULL, tag TEXT NOT NULL DEFAULT '',
  start_token TEXT, activity_token TEXT, started_at INTEGER, sent TEXT, sent_at INTEGER, created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, device_id)
) WITHOUT ROWID;
"#;

/// Tables made by the other modules of the Node hub at start (server.mjs shares, test-rooms.mjs, accounts.mjs).
const MORE_TABLES: &str = r#"
CREATE TABLE IF NOT EXISTS shares (share_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, attachment_id TEXT NOT NULL, share_secret_hash BLOB NOT NULL,
    expires_at INTEGER NOT NULL, created_by_device_id TEXT NOT NULL, created_at INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS test_rooms (room_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS accounts (
    room_id TEXT PRIMARY KEY, email TEXT NOT NULL, email_verified_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL,
    auth_salt BLOB NOT NULL, auth_hash BLOB NOT NULL, key_wrapped BLOB NOT NULL, kdf TEXT NOT NULL,
    recovery_salt BLOB, recovery_hash BLOB, recovery_wrapped BLOB,
    code_salt BLOB, code_hash BLOB, code_expires_at INTEGER, code_attempts INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS accounts_by_email ON accounts (email);
"#;

fn has_column(c: &Connection, table: &str, col: &str) -> bool {
    c.query_row(&format!("SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?"), [col], |_| Ok(())).optional().ok().flatten().is_some()
}

fn pragmas(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY;")
}

pub struct Db {
    pub path: PathBuf,
    writer: Mutex<Connection>,
    readers: Mutex<Vec<Connection>>,
}

impl Db {
    /// Open (or create) <dir>/hub.db. A database of an older schema is moved aside to hub.db.v<old>-<stamp>, with
    /// its attachments, and a fresh one begins (hub/store.mjs openDb).
    pub fn open(dir: &Path, log: &dyn Fn(&str)) -> anyhow_like::Result<Db> {
        std::fs::create_dir_all(dir)?;
        let file = dir.join("hub.db");
        if file.exists() {
            let probe = Connection::open(&file)?;
            let version: i64 = probe.query_row("PRAGMA user_version", [], |r| r.get(0))?;
            let used: i64 = probe.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'rooms'", [], |r| r.get(0))?;
            drop(probe);
            if used > 0 && version < SCHEMA_VERSION {
                let stamp = crate::util::iso_stamp();
                let v = if version == 0 { 1 } else { version };
                let aside = format!("{}.v{}-{}", file.display(), v, stamp);
                for suffix in ["", "-wal", "-shm"] {
                    let from = PathBuf::from(format!("{}{}", file.display(), suffix));
                    if from.exists() {
                        std::fs::rename(&from, format!("{aside}{suffix}"))?;
                    }
                }
                let att = dir.join("attachments");
                if att.exists() {
                    std::fs::rename(&att, format!("{}.v{}-{}", att.display(), v, stamp))?;
                }
                log(&format!("hub.db had schema {v}; moved aside to {}, starting fresh with schema {SCHEMA_VERSION}", Path::new(&aside).file_name().unwrap().to_string_lossy()));
            }
        }
        let c = Connection::open(&file)?;
        let n: i64 = c.query_row("SELECT COUNT(*) FROM sqlite_master", [], |r| r.get(0))?;
        if n == 0 {
            c.execute_batch("PRAGMA auto_vacuum = INCREMENTAL")?;
        }
        pragmas(&c)?;
        c.execute_batch(SCHEMA)?;
        if !has_column(&c, "attachments", "referenced_at") {
            c.execute_batch("ALTER TABLE attachments ADD COLUMN referenced_at INTEGER; UPDATE attachments SET referenced_at = stored_at;")?;
        }
        if !has_column(&c, "envelopes", "void_code") {
            c.execute_batch("ALTER TABLE envelopes ADD COLUMN void_code TEXT")?;
        }
        if !has_column(&c, "push_subscriptions", "level") {
            c.execute_batch("ALTER TABLE push_subscriptions ADD COLUMN level TEXT NOT NULL DEFAULT 'all'")?;
        }
        c.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))?;
        c.execute_batch(MORE_TABLES)?;
        c.set_prepared_statement_cache_capacity(256);
        let mut readers = vec![];
        for _ in 0..4 {
            let r = Connection::open(&file)?;
            r.execute_batch("PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY;")?;
            r.set_prepared_statement_cache_capacity(64);
            readers.push(r);
        }
        Ok(Db { path: file, writer: Mutex::new(c), readers: Mutex::new(readers) })
    }

    /// The writing connection (also for reads that must see the newest write inside one serial step).
    pub fn w(&self) -> MutexGuard<'_, Connection> { self.writer.lock() }

    /// A reading connection for a read that needs no lock against writes (committed data only).
    pub fn read<T>(&self, f: impl FnOnce(&Connection) -> T) -> T {
        let c = self.readers.lock().pop();
        match c {
            Some(c) => {
                let out = f(&c);
                self.readers.lock().push(c);
                out
            }
            None => f(&self.w()),
        }
    }
}

/// BEGIN IMMEDIATE … COMMIT, or ROLLBACK on error.
pub fn tx<T, E: From<rusqlite::Error>>(c: &Connection, f: impl FnOnce(&Connection) -> Result<T, E>) -> Result<T, E> {
    c.execute_batch("BEGIN IMMEDIATE")?;
    match f(c) {
        Ok(v) => {
            c.execute_batch("COMMIT")?;
            Ok(v)
        }
        Err(e) => {
            let _ = c.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

/// Give free pages back to the file system, a few megabytes per call.
pub fn vacuum_step(c: &Connection, pages: i64) -> rusqlite::Result<i64> {
    let free: i64 = c.query_row("PRAGMA freelist_count", [], |r| r.get(0))?;
    if free > 0 {
        c.execute_batch(&format!("PRAGMA incremental_vacuum({pages})"))?;
    }
    Ok(free)
}

/// Ciphertext bytes -> STREAM chunk count of an encrypted attachment (22-byte head, 64 KiB + tag per chunk).
pub fn chunk_count(size: i64) -> i64 { std::cmp::max(1, ((size - 22).max(0) as f64 / (65536.0 + 16.0)).ceil() as i64) }

/// One row's share of the derived tables (objects, timelines).
pub struct DeriveRow<'a> {
    pub room_id: &'a str,
    pub envelope_number: i64,
    pub sender: &'a str,
    pub object_id: Option<&'a str>,
    pub object_state: Option<i64>,
    pub urgency: Option<i64>,
    pub answered_at: Option<i64>,
    pub timeline_kind: Option<i64>,
    pub timeline_id: Option<&'a str>,
}
pub fn derive_row(c: &Connection, r: &DeriveRow) -> rusqlite::Result<()> {
    if let Some(oid) = r.object_id {
        let exists: Option<i64> = c
            .prepare_cached("SELECT first_envelope_number FROM objects WHERE room_id = ? AND object_id = ?")?
            .query_row(params![r.room_id, oid], |x| x.get(0))
            .optional()?;
        if exists.is_none() {
            c.prepare_cached("INSERT INTO objects (room_id, object_id, object_state, urgency, answered_at, owner_device_id, first_envelope_number, latest_head_envelope_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")?
                .execute(params![r.room_id, oid, r.object_state, r.urgency, r.answered_at, r.sender, r.envelope_number, r.envelope_number])?;
        } else {
            c.prepare_cached("UPDATE objects SET object_state = ?, urgency = ?, answered_at = ?, latest_head_envelope_number = ? WHERE room_id = ? AND object_id = ?")?
                .execute(params![r.object_state, r.urgency, r.answered_at, r.envelope_number, r.room_id, oid])?;
        }
    }
    if let Some(tid) = r.timeline_id {
        c.prepare_cached(
            "INSERT INTO timelines (room_id, timeline_kind, timeline_id, last_envelope_number, item_count) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT (room_id, timeline_kind, timeline_id) DO UPDATE SET last_envelope_number = excluded.last_envelope_number, item_count = item_count + 1",
        )?
        .execute(params![r.room_id, r.timeline_kind, tid, r.envelope_number])?;
    }
    Ok(())
}

/// Drop and rebuild objects and timelines from envelopes (all rooms).
pub fn rebuild_derived(c: &Connection) -> rusqlite::Result<()> {
    tx(c, |c| {
        c.execute_batch("DELETE FROM objects; DELETE FROM timelines;")?;
        let mut st = c.prepare("SELECT room_id, envelope_number, sender_device_id, object_id, object_state, urgency, answered_at, timeline_kind, timeline_id FROM envelopes WHERE object_id IS NOT NULL OR timeline_id IS NOT NULL ORDER BY room_id, envelope_number")?;
        let rows: Vec<(String, i64, Vec<u8>, Option<String>, Option<i64>, Option<i64>, Option<i64>, Option<i64>, Option<String>)> =
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?)))?.collect::<Result<_, _>>()?;
        for r in &rows {
            let sender = zcrypto::hex(&r.2);
            derive_row(c, &DeriveRow { room_id: &r.0, envelope_number: r.1, sender: &sender, object_id: r.3.as_deref(), object_state: r.4, urgency: r.5, answered_at: r.6, timeline_kind: r.7, timeline_id: r.8.as_deref() })?;
        }
        Ok::<_, rusqlite::Error>(())
    })
}

/// A minimal error type for start-up (the hub's own errors are crate::error::Fail).
pub mod anyhow_like {
    pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
}
