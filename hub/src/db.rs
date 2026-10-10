//! The database: SQLite, one file, one writing connection and a few reading ones (WAL). This is the first schema of
//! the hub; there is nothing to migrate from. Table and column names are the product's own words, as
//! spec/hub-api.md lists them. `envelopes` is the one truth for stored content; the object tables, `chats`,
//! `boards` and `registers` are indexes over it, written in the same transaction, and can be rebuilt.
//!
//! What a column may hold: ids, numbers, public keys, signed public MLS state, and ciphertext. No column holds a
//! key that opens content.

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::{Connection, OpenFlags};

pub const SCHEMA_VERSION: i64 = 5;

/// 10.9: the board frontier posts (created in place with schema 5; a table of the first layout, one post per
/// device without `bound`, is rebuilt: its posts were bound ones).
const BOARD_FRONTIERS: &str = "
-- 10.9: per human device and board its frontier posts: `bound` 0 a declaration made before a snapshot register
-- is written (one row per declared frontier; it only holds pruning back), `bound` 1 the one post bound to the
-- device's snapshot register value (`snapshot_seq`, `register_id`; `at` its arrival). `counts` as last judged
-- (within 30 days of the board's newest bound post, nothing it names beyond a Cut). `frontier`: per writer 32
-- bytes and the number as 8 bytes big-endian, ascending; `files`: 16-byte file ids one after another.
CREATE TABLE IF NOT EXISTS board_frontiers (
  room_id        BLOB NOT NULL,
  board          BLOB NOT NULL CHECK (length(board) = 16),
  device         BLOB NOT NULL CHECK (length(device) = 32),
  bound          INTEGER NOT NULL CHECK (bound IN (0, 1)),
  frontier       BLOB NOT NULL,
  files          BLOB NOT NULL,
  at             INTEGER NOT NULL,
  snapshot_seq   INTEGER,
  register_id    BLOB,
  counts         INTEGER NOT NULL DEFAULT 1 CHECK (counts IN (0, 1)),
  PRIMARY KEY (room_id, board, device, bound, frontier)
) STRICT, WITHOUT ROWID;
";

/// Added to schema 5 in place (Welcomes stored once, ids never given twice, an index for deleting by group, the
/// Offer's MAC, an index for paging the groups, an index of register values with bodies, the board frontiers, settled Notes), on every open (a fresh database and one that holds data alike): nothing is
/// rewritten, rows written before keep working. A Welcome is stored once per group and epoch in
/// `welcome_bytes`; a row of `welcomes` with `epoch` set points to it and keeps an empty `bytes`, a row without
/// `epoch` (written before) holds its own. At 1000 human devices a founding's Welcome is some 0.3 MB, and it is
/// for every one of them.
const ADDED_TO_5: &str = "
CREATE TABLE IF NOT EXISTS welcome_bytes (
  group_id       BLOB NOT NULL,
  epoch          INTEGER NOT NULL,
  bytes          BLOB NOT NULL,
  PRIMARY KEY (group_id, epoch)
) STRICT, WITHOUT ROWID;
-- the next id of a `welcomes` row: never one given before, also when the newest row was deleted (a device reads
-- its Welcomes on from the last id it saw)
-- 9.4.2: the register values that still carry a body, found per writer and register for pruning
CREATE INDEX IF NOT EXISTS envelopes_register_bodies ON envelopes(group_id, sender, register_id, seq)
  WHERE register_id IS NOT NULL AND body IS NOT NULL;
-- 9.4.1: a Note deleted (closed) settles; one closed before this rule gets its arrival of closing
CREATE INDEX IF NOT EXISTS notes_due ON notes(settled_at) WHERE settled_at IS NOT NULL AND pruned_at IS NULL;
UPDATE notes SET settled_at = closed_at WHERE state = 3 AND settled_at IS NULL AND closed_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS welcome_ids (
  one            INTEGER PRIMARY KEY CHECK (one = 1),
  last           INTEGER NOT NULL
) STRICT;
";

/// The first id the counter of `welcome_ids` starts above, in a database the hub wrote before it had one: above
/// every id SQLite can have given. Without AUTOINCREMENT SQLite gives the largest id there is plus one, so no id
/// was larger than the number of rows ever written; each row was written for one Add of a Commit, a Commit is
/// never deleted from the log and adds at most `MAX_LEAVES` devices.
const WELCOME_IDS_SEED: &str = "
INSERT INTO welcome_ids (one, last) VALUES (1, max(
  (SELECT coalesce(max(id), 0) FROM welcomes),
  (SELECT count(*) FROM group_log WHERE kind = 'commit') * 1024
)) ON CONFLICT (one) DO UPDATE SET last = max(last, excluded.last);
";

pub const SCHEMA: &str = r#"
-- ---- accounts: a way into a room. The hub checks the login; the sealed copies of the recovery code are opaque.
CREATE TABLE accounts (
  account_id     INTEGER PRIMARY KEY,
    -- none: an account whose way in is a passkey needs no e-mail
  email          TEXT UNIQUE,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  revision       INTEGER NOT NULL DEFAULT 1,
  -- password: a slow hash of the login key the device derived; the KDF record the device needs; the sealed copy
  auth_salt      BLOB,
  auth_hash      BLOB,
  kdf            TEXT,
  password_copy  BLOB,
  -- Emergency Kit: a slow hash of the kit's login key; the sealed copy
  kit_salt       BLOB NOT NULL,
  kit_hash       BLOB NOT NULL,
    kit_copy       BLOB NOT NULL,
  -- which salt the kit's keys were derived with: the e-mail's or the account id's
  kit_form       TEXT NOT NULL CHECK (kit_form IN ('email', 'id')),
    -- the account's id: a UUID the hub mints; the passkeys' user handle
  user_handle    BLOB NOT NULL CHECK (length(user_handle) = 16)
) STRICT;

CREATE TABLE passkeys (
  credential_id  BLOB PRIMARY KEY,
  account_id     INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  public_key     BLOB NOT NULL,
  algorithm      INTEGER NOT NULL,
  sign_count     INTEGER NOT NULL,
  transports     TEXT NOT NULL,
  sealed_copy    BLOB NOT NULL,
  created_at     INTEGER NOT NULL,
  last_used_at   INTEGER
) STRICT;
CREATE INDEX passkeys_by_account ON passkeys(account_id, created_at);
-- the account's random id: what names an account that has no e-mail
CREATE UNIQUE INDEX accounts_by_handle ON accounts(user_handle);

-- The places an account was signed in to from (a keyed hash of the address, never the address): a failed-login
-- slow-down for sources an account does not know leaves these alone. The newest 16 are kept.
CREATE TABLE account_sources (
  account_id     INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  source         BLOB NOT NULL,
  last_at        INTEGER NOT NULL,
  PRIMARY KEY (account_id, source)
) STRICT, WITHOUT ROWID;

-- The login throttle (throttle.rs): hashes of an account key (password or kit, and the e-mail) and of a keyed
-- hash of a source; no address, no e-mail. Kept in the database so that a restart resets nothing.
CREATE TABLE login_sources (
  account        BLOB NOT NULL,
  source         BLOB NOT NULL,
  failures       INTEGER NOT NULL,
  next_at        INTEGER NOT NULL,
  -- the attempt being checked now
  checking       INTEGER,
  -- made while the tables were full (only for a source the account knows): its waits are answered as theirs
  over           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account, source)
) STRICT;
CREATE INDEX login_sources_by_wait ON login_sources(next_at);
CREATE INDEX login_sources_by_account_wait ON login_sources(account, next_at);
-- an account's hour of checks from sources it does not know, and its line
CREATE TABLE login_accounts (
  account        BLOB PRIMARY KEY,
  budget_start   INTEGER NOT NULL,
  budget_used    INTEGER NOT NULL,
  next_turn      INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX login_accounts_by_age ON login_accounts(budget_start);
CREATE TABLE login_turns (
  account        BLOB NOT NULL,
  source         BLOB NOT NULL,
  turn           INTEGER NOT NULL,
  good_until     INTEGER NOT NULL,
  PRIMARY KEY (account, source)
) STRICT, WITHOUT ROWID;
CREATE INDEX login_turns_in_order ON login_turns(account, turn);
CREATE TABLE login_counts (
  sources        INTEGER NOT NULL,
  accounts       INTEGER NOT NULL
) STRICT;
INSERT INTO login_counts (sources, accounts) VALUES (0, 0);

-- An account has a list of rooms (one for now); a room belongs to one account.
CREATE TABLE account_rooms (
  account_id     INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  room_id        BLOB NOT NULL UNIQUE REFERENCES rooms(room_id),
  position       INTEGER NOT NULL,
  PRIMARY KEY (account_id, position)
) STRICT, WITHOUT ROWID;

-- ---- rooms, devices, groups: public MLS state
CREATE TABLE rooms (
  room_id        BLOB PRIMARY KEY CHECK (length(room_id) = 32),
  founded_at     INTEGER NOT NULL,
  -- one counter per room: every Commit, message, envelope and fetchable row carries the change it was written at
  change         INTEGER NOT NULL DEFAULT 0,
  file_bytes     INTEGER NOT NULL DEFAULT 0,
  -- how many of each the room has ever made (quota.rs)
  file_count     INTEGER NOT NULL DEFAULT 0,
  register_count INTEGER NOT NULL DEFAULT 0,
  void_count     INTEGER NOT NULL DEFAULT 0,
  group_count    INTEGER NOT NULL DEFAULT 1,
  device_count   INTEGER NOT NULL DEFAULT 1,
  helper_count   INTEGER NOT NULL DEFAULT 0,
  -- read from the room group's public state at its current epoch, kept beside it for the checks of every request
  epoch              INTEGER NOT NULL DEFAULT 0,
  room_state         BLOB NOT NULL,
  recovery_signature_key BLOB NOT NULL,
  recovery_hpke_key  BLOB NOT NULL
) STRICT, WITHOUT ROWID;

-- Every signature key the room has ever seen in a role. A key has one role for ever; a human or agent device
-- with removed_epoch set is revoked and never returns (4.2).
CREATE TABLE devices (
  room_id        BLOB NOT NULL REFERENCES rooms(room_id),
  device         BLOB NOT NULL CHECK (length(device) = 32),
  role           TEXT NOT NULL CHECK (role IN ('human', 'agent', 'helper')),
  added_epoch    INTEGER NOT NULL,
  removed_epoch  INTEGER,
  PRIMARY KEY (room_id, device)
) STRICT, WITHOUT ROWID;

-- Who is, and was, a leaf of which group; with the Cut once removed (9.0.10). A key comes back to a group only
-- if nothing it wrote lies beyond its Cut; its row is then its present membership.
CREATE TABLE group_members (
  group_id       BLOB NOT NULL REFERENCES groups(group_id),
  device         BLOB NOT NULL,
  added_epoch    INTEGER NOT NULL,
  removed_epoch  INTEGER,
  cut_seq        INTEGER,
  cut_hash       BLOB,
  PRIMARY KEY (group_id, device)
) STRICT, WITHOUT ROWID;
CREATE INDEX group_members_by_device ON group_members(device, group_id) WHERE removed_epoch IS NULL;

CREATE TABLE key_packages (
  id             INTEGER PRIMARY KEY,
  room_id        BLOB NOT NULL REFERENCES rooms(room_id),
  device         BLOB NOT NULL,
  ref            BLOB NOT NULL,
  last_resort    INTEGER NOT NULL CHECK (last_resort IN (0, 1)),
  uploaded_at    INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  bytes          BLOB NOT NULL
) STRICT;
-- claim: one device's oldest single-use package, else its last-resort one
CREATE INDEX key_packages_claim ON key_packages(room_id, device, last_resort, id);
-- The references of single-use KeyPackages this hub has handed out, in any room, for good: one is never handed
-- out twice (14.2), whatever is uploaded, removed or revoked later. 32 bytes each.
CREATE TABLE spent_key_packages (
  ref            BLOB PRIMARY KEY,
  at             INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX key_packages_by_ref ON key_packages(room_id, ref);
CREATE INDEX key_packages_ref ON key_packages(ref);
-- exactly one last-resort package per device
CREATE UNIQUE INDEX key_packages_last_resort ON key_packages(room_id, device) WHERE last_resort = 1;

CREATE TABLE groups (
  -- 3.2: the room id for the room group, the room id and the session id for a session group
  group_id       BLOB PRIMARY KEY CHECK (length(group_id) IN (32, 48) AND substr(group_id, 1, 32) = room_id),
  room_id        BLOB NOT NULL REFERENCES rooms(room_id),
  kind           TEXT NOT NULL CHECK (kind IN ('room', 'main', 'helper')),
  session_id     BLOB,
  parent         BLOB,
  founder        BLOB NOT NULL,
  epoch          INTEGER NOT NULL,
  -- the room epoch the group's last Commit named (5.2.1)
  room_epoch     INTEGER NOT NULL,
  -- arrival of the last Commit: an envelope of the epoch before it is taken for two minutes (9.0.8)
  epoch_at       INTEGER NOT NULL,
  live           INTEGER NOT NULL DEFAULT 1 CHECK (live IN (0, 1)),
  archived_at    INTEGER,
  log_n          INTEGER NOT NULL DEFAULT 0,
  -- log entries up to this number are no longer kept (retention): asking below it is `gone`
  log_kept_from  INTEGER NOT NULL DEFAULT 0,
  founded_change INTEGER NOT NULL,
  -- the serialised public group: tree, context, transcript hash, confirmation tag
  state          BLOB NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX groups_by_room ON groups(room_id, kind);
CREATE UNIQUE INDEX groups_by_session ON groups(room_id, session_id) WHERE session_id IS NOT NULL;

-- One ordered log per group: Commits (readable) and application messages (opaque).
CREATE TABLE group_log (
  group_id       BLOB NOT NULL REFERENCES groups(group_id),
  n              INTEGER NOT NULL,
  room_id        BLOB NOT NULL,
  -- for a Commit the epoch it builds on, for a message the epoch it was sent in
  epoch          INTEGER NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('commit', 'message')),
  sender         BLOB NOT NULL,
  at             INTEGER NOT NULL,
  change         INTEGER NOT NULL,
  recovery_auth  BLOB,
  -- SHA-256 of the bytes: a repeated post of the same bytes gets the first answer again
  digest         BLOB NOT NULL,
  bytes          BLOB NOT NULL,
  PRIMARY KEY (group_id, n)
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX group_log_by_change ON group_log(room_id, change);
-- one Commit per group and epoch
CREATE UNIQUE INDEX group_log_one_commit ON group_log(group_id, epoch) WHERE kind = 'commit';
CREATE UNIQUE INDEX group_log_by_digest ON group_log(group_id, digest);
CREATE INDEX group_log_messages_by_age ON group_log(at) WHERE kind = 'message';

CREATE TABLE group_infos (
  group_id       BLOB NOT NULL REFERENCES groups(group_id),
  epoch          INTEGER NOT NULL,
  -- RefHash("Trommi Group Info", bytes): what a SealedKey of this epoch names (8.2)
  hash           BLOB NOT NULL,
  -- kept for the current epoch and epoch 0 of every group, and for every epoch of the room group
  bytes          BLOB,
  PRIMARY KEY (group_id, epoch)
) STRICT, WITHOUT ROWID;

CREATE TABLE welcomes (
  id             INTEGER PRIMARY KEY,
  room_id        BLOB NOT NULL,
  device         BLOB NOT NULL,
  group_id       BLOB NOT NULL,
  at             INTEGER NOT NULL,
  bytes          BLOB NOT NULL
) STRICT;
CREATE INDEX welcomes_by_device ON welcomes(room_id, device, id);

-- One sealed content key per group, epoch and writer (8.3). The hub reads the context, never the key.
CREATE TABLE sealed_keys (
  room_id            BLOB NOT NULL,
  group_id           BLOB NOT NULL,
  epoch              INTEGER NOT NULL,
  writer             BLOB NOT NULL,
  room_epoch         INTEGER NOT NULL,
  recovery_hpke_key  BLOB NOT NULL,
  has_mac            INTEGER NOT NULL,
  change             INTEGER NOT NULL,
  sealed             BLOB NOT NULL,
  PRIMARY KEY (group_id, epoch, writer)
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX sealed_keys_by_change ON sealed_keys(room_id, change);

CREATE TABLE recovery_links (
  room_id            BLOB NOT NULL,
  -- the room epoch that began with the new recovery key
  room_epoch         INTEGER NOT NULL,
  recovery_hpke_key  BLOB NOT NULL,
  change             INTEGER NOT NULL,
  sealed             BLOB NOT NULL,
  PRIMARY KEY (room_id, room_epoch)
) STRICT, WITHOUT ROWID;
CREATE UNIQUE INDEX recovery_links_by_change ON recovery_links(room_id, change);

-- A recovery in progress (8.7): its parts are kept apart and published at `finish`, all or none.
-- Every recovery key a room ever held, signature and HPKE alike: none of them comes back (8.6).
CREATE TABLE recovery_keys_held (
  room_id        BLOB NOT NULL,
  key            BLOB NOT NULL,
  PRIMARY KEY (room_id, key)
) STRICT, WITHOUT ROWID;
CREATE TABLE recoveries (
  recovery_id    BLOB PRIMARY KEY,
  room_id        BLOB NOT NULL,
  recovery_key   BLOB NOT NULL,
  opened_at      INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  -- hash of the finish request and its answer: a repeated finish gets the same answer
  finish_hash    BLOB,
  finish_answer  TEXT,
  -- what it holds, counted as it is kept
  parts          INTEGER NOT NULL DEFAULT 0,
  bytes          INTEGER NOT NULL DEFAULT 0,
  memo_bytes     INTEGER NOT NULL DEFAULT 0
) STRICT, WITHOUT ROWID;
CREATE INDEX recoveries_by_room ON recoveries(room_id, expires_at);
CREATE TABLE recovery_parts (
  recovery_id    BLOB NOT NULL REFERENCES recoveries(recovery_id) ON DELETE CASCADE,
  n              INTEGER NOT NULL,
  group_id       BLOB NOT NULL,
  body           TEXT NOT NULL,
  -- SHA-256 of the body: a repeated post is found without reading the bodies
  body_hash      BLOB NOT NULL,
  -- where the outcome of this part's Commit lies in recovery_memo
  commit_key     BLOB,
  PRIMARY KEY (recovery_id, n)
) STRICT, WITHOUT ROWID;
CREATE INDEX recovery_parts_by_group ON recovery_parts(recovery_id, group_id, n);
CREATE UNIQUE INDEX recovery_parts_by_body ON recovery_parts(recovery_id, body_hash);
-- What verifying each part gave (the public state after its Commit): computed once, outside the write lock, so
-- that checking the next part and publishing them all replay writes, not cryptography. Public data.
CREATE TABLE recovery_memo (
  recovery_id    BLOB NOT NULL REFERENCES recoveries(recovery_id) ON DELETE CASCADE,
  key            BLOB NOT NULL,
  value          BLOB NOT NULL,
  PRIMARY KEY (recovery_id, key)
) STRICT, WITHOUT ROWID;

-- ---- stored content
CREATE TABLE envelopes (
  id             INTEGER PRIMARY KEY,
  room_id        BLOB NOT NULL,
  change         INTEGER NOT NULL,
  group_id       BLOB NOT NULL,
  epoch          INTEGER NOT NULL,
  sender         BLOB NOT NULL,
  seq            INTEGER NOT NULL,
  prev           BLOB NOT NULL,
  hash           BLOB NOT NULL,
  recipient      BLOB NOT NULL,
  kind           INTEGER NOT NULL,
  flags          INTEGER NOT NULL,
  time           INTEGER NOT NULL,
  received_at    INTEGER NOT NULL,
  -- an item's timeline: kind (1 chat, 2 board) ‖ scope (1 card, 2 session, 3 desk) ‖ ref (16)
  timeline       BLOB,
  object_id      BLOB,
  object_type    INTEGER,
  object_state   INTEGER,
  urgency        INTEGER,
  answered_at    INTEGER,
  object_ref     BLOB,
  register_id    BLOB,
  file_ids       BLOB NOT NULL,
  padded_size    INTEGER NOT NULL,
  -- a void record's refusal (9.0.8); NULL for an accepted envelope
  void_code      TEXT,
  -- beyond its sender's Cut (9.0.10): kept as evidence, served only on the chain route
  cut            INTEGER NOT NULL DEFAULT 0 CHECK (cut IN (0, 1)),
  header         BLOB NOT NULL,
  nonce          BLOB NOT NULL,
  body_hash      BLOB NOT NULL,
  signature      BLOB NOT NULL,
  -- the ciphertext; NULL once pruned and for a void record. A pruned row keeps header, hash and signature, so
  -- removing content later needs no change of this table.
  body           BLOB
) STRICT;
-- the chain: one envelope per sender, group and number
CREATE UNIQUE INDEX envelopes_chain ON envelopes(group_id, sender, seq);
-- catch-up: everything above N
CREATE UNIQUE INDEX envelopes_by_change ON envelopes(room_id, change);
-- page a chat, load a board
CREATE INDEX envelopes_by_timeline ON envelopes(room_id, timeline, change) WHERE timeline IS NOT NULL;
-- every envelope of an object
CREATE INDEX envelopes_by_object ON envelopes(room_id, object_id, change) WHERE object_id IS NOT NULL;

-- how many envelopes a group took in an epoch (`epoch-full` at 2^24)
CREATE TABLE epoch_counts (
  group_id       BLOB NOT NULL,
  epoch          INTEGER NOT NULL,
  envelopes      INTEGER NOT NULL,
  PRIMARY KEY (group_id, epoch)
) STRICT, WITHOUT ROWID;

-- ---- indexes over envelopes, derived from signed header fields
CREATE TABLE cards (
  room_id        BLOB NOT NULL,
  object_id      BLOB NOT NULL,
  group_id       BLOB NOT NULL,
  state          INTEGER NOT NULL,
  urgency        INTEGER NOT NULL,
  answered_at    INTEGER NOT NULL,
  owner          BLOB NOT NULL,
  first_change   INTEGER NOT NULL,
  head_change    INTEGER NOT NULL,
  -- the current version: its envelope hash and the change it came at
  version_hash   BLOB NOT NULL,
  version_change INTEGER NOT NULL,
  -- arrival of the newest state that is answered or closed: bodies are pruned 30 days after it (9.4)
  settled_at     INTEGER,
  closed_at      INTEGER,
  pruned_at      INTEGER,
  PRIMARY KEY (room_id, object_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX cards_desk ON cards(room_id, urgency DESC, first_change) WHERE state = 1;
CREATE INDEX cards_due ON cards(settled_at) WHERE settled_at IS NOT NULL AND pruned_at IS NULL;

CREATE TABLE permission_requests (
  room_id        BLOB NOT NULL,
  object_id      BLOB NOT NULL,
  group_id       BLOB NOT NULL,
  state          INTEGER NOT NULL,
  urgency        INTEGER NOT NULL,
  answered_at    INTEGER NOT NULL,
  owner          BLOB NOT NULL,
  first_change   INTEGER NOT NULL,
  head_change    INTEGER NOT NULL,
  version_hash   BLOB NOT NULL,
  version_change INTEGER NOT NULL,
  settled_at     INTEGER,
  closed_at      INTEGER,
  pruned_at      INTEGER,
  PRIMARY KEY (room_id, object_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX permission_requests_desk ON permission_requests(room_id, urgency DESC, first_change) WHERE state = 1;
CREATE INDEX permission_requests_due ON permission_requests(settled_at) WHERE settled_at IS NOT NULL AND pruned_at IS NULL;

CREATE TABLE artifacts (
  room_id        BLOB NOT NULL,
  object_id      BLOB NOT NULL,
  group_id       BLOB NOT NULL,
  state          INTEGER NOT NULL,
  urgency        INTEGER NOT NULL,
  answered_at    INTEGER NOT NULL,
  owner          BLOB NOT NULL,
  first_change   INTEGER NOT NULL,
  head_change    INTEGER NOT NULL,
  version_hash   BLOB NOT NULL,
  version_change INTEGER NOT NULL,
  settled_at     INTEGER,
  closed_at      INTEGER,
  pruned_at      INTEGER,
  PRIMARY KEY (room_id, object_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX artifacts_desk ON artifacts(room_id, urgency DESC, first_change) WHERE state = 1;
CREATE INDEX artifacts_due ON artifacts(settled_at) WHERE settled_at IS NOT NULL AND pruned_at IS NULL;

-- Notes: any human device writes a version; the hub keeps the newest by arrival and prunes as v1.md 9.4 says.
CREATE TABLE notes (
  room_id        BLOB NOT NULL,
  object_id      BLOB NOT NULL,
  group_id       BLOB NOT NULL,
  state          INTEGER NOT NULL,
  urgency        INTEGER NOT NULL,
  answered_at    INTEGER NOT NULL,
  owner          BLOB NOT NULL,
  first_change   INTEGER NOT NULL,
  head_change    INTEGER NOT NULL,
  version_hash   BLOB NOT NULL,
  version_change INTEGER NOT NULL,
  settled_at     INTEGER,
  closed_at      INTEGER,
  pruned_at      INTEGER,
  PRIMARY KEY (room_id, object_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX notes_desk ON notes(room_id, urgency DESC, first_change) WHERE state = 1;

CREATE TABLE chats (
  room_id        BLOB NOT NULL,
  timeline       BLOB NOT NULL,
  group_id       BLOB NOT NULL,
  item_count     INTEGER NOT NULL,
  last_change    INTEGER NOT NULL,
  PRIMARY KEY (room_id, timeline)
) STRICT, WITHOUT ROWID;

CREATE TABLE boards (
  room_id        BLOB NOT NULL,
  timeline       BLOB NOT NULL,
  group_id       BLOB NOT NULL,
  item_count     INTEGER NOT NULL,
  last_change    INTEGER NOT NULL,
  PRIMARY KEY (room_id, timeline)
) STRICT, WITHOUT ROWID;

-- every writer's newest value per register
CREATE TABLE registers (
  room_id        BLOB NOT NULL,
  group_id       BLOB NOT NULL,
  writer         BLOB NOT NULL,
  register_id    BLOB NOT NULL,
  head_change    INTEGER NOT NULL,
  PRIMARY KEY (group_id, writer, register_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX registers_by_room ON registers(room_id, head_change);

-- ---- files and share links
CREATE TABLE files (
  room_id        BLOB NOT NULL,
  file_id        BLOB NOT NULL CHECK (length(file_id) = 16),
  uploader       BLOB NOT NULL,
  -- group and object of the first envelope of its uploader that names it (11.3); NULL while pending
  group_id       BLOB,
  object_id      BLOB,
  size           INTEGER NOT NULL,
  sha256         BLOB NOT NULL,
  stored_at      INTEGER NOT NULL,
  referenced_at  INTEGER,
  -- the bytes are gone (retention, an unreferenced upload, a closed Artifact); the row stays, so that the id is
  -- never used for other bytes (11.3)
  deleted_at     INTEGER,
  PRIMARY KEY (room_id, file_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX files_by_object ON files(room_id, object_id) WHERE object_id IS NOT NULL;
CREATE INDEX files_pending ON files(stored_at) WHERE referenced_at IS NULL AND deleted_at IS NULL;

CREATE TABLE shares (
  share_id       BLOB PRIMARY KEY CHECK (length(share_id) = 16),
  room_id        BLOB NOT NULL,
  file_id        BLOB NOT NULL,
  secret_hash    BLOB NOT NULL CHECK (length(secret_hash) = 32),
  expires_at     INTEGER NOT NULL,
  created_by     BLOB NOT NULL,
  created_at     INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX shares_by_file ON shares(room_id, file_id);
CREATE INDEX shares_by_expiry ON shares(expires_at);

-- ---- invites (12.1): signed, public messages of the ceremony; the link's secret never reaches the hub
CREATE TABLE invites (
  invite_id        BLOB PRIMARY KEY CHECK (length(invite_id) = 16),
  room_id          BLOB NOT NULL,
  inviter          BLOB NOT NULL,
  role             INTEGER NOT NULL,
  offer            BLOB NOT NULL,
  offer_signature  BLOB NOT NULL,
  reveal           BLOB,
  reveal_signature BLOB,
  -- of the Request the inviter revealed: the KeyPackage and device the room may take (12.1.7)
  revealed_request BLOB,
  revealed_ref     BLOB,
  revealed_device  BLOB,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  used_at          INTEGER,
  burned_at        INTEGER
) STRICT, WITHOUT ROWID;
CREATE INDEX invites_by_room ON invites(room_id, expires_at);
CREATE TABLE invite_requests (
  invite_id      BLOB NOT NULL REFERENCES invites(invite_id) ON DELETE CASCADE,
  request_hash   BLOB NOT NULL,
  request        BLOB NOT NULL,
  mac            BLOB NOT NULL,
  signature      BLOB NOT NULL,
  -- of the Request's KeyPackage, checked when it came
  key_package_ref BLOB NOT NULL,
  device         BLOB NOT NULL,
  at             INTEGER NOT NULL,
  PRIMARY KEY (invite_id, request_hash)
) STRICT, WITHOUT ROWID;

-- an unsigned wish of a signed-in device to the human devices; nothing follows from it without a Commit
CREATE TABLE requests (
  id             INTEGER PRIMARY KEY,
  room_id        BLOB NOT NULL,
  device         BLOB NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('readmit', 'handover', 'session', 'reject')),
  group_id       BLOB,
  -- of a reject: the device that made the Commit
  committer      BLOB,
  key_package    BLOB,
  n              INTEGER,
  at             INTEGER NOT NULL
) STRICT;
CREATE INDEX requests_by_room ON requests(room_id, id);

-- ---- push, Live Activity, presence: how the hub reaches a device; no content
CREATE TABLE push_subscriptions (
  id             INTEGER PRIMARY KEY,
  room_id        BLOB NOT NULL,
  device         BLOB NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('web_push', 'apns')),
  -- web push: the endpoint; APNs: the device token (hex)
  endpoint       TEXT NOT NULL,
  p256dh         BLOB,
  auth           BLOB,
  -- APNs: the 32 random bytes the app registered, under which the hub seals the wake-up number (15.2)
  apns_key       BLOB,
  environment    TEXT,
  topic          TEXT,
  level          TEXT NOT NULL CHECK (level IN ('all', 'knocking')),
  created_at     INTEGER NOT NULL,
  UNIQUE (room_id, device, endpoint)
) STRICT;
CREATE INDEX push_by_room ON push_subscriptions(room_id, device);

CREATE TABLE live_activities (
  room_id        BLOB NOT NULL,
  device         BLOB NOT NULL,
  environment    TEXT NOT NULL,
  topic          TEXT NOT NULL,
  tag            TEXT NOT NULL,
  start_token    TEXT,
  activity_token TEXT,
  started_at     INTEGER,
  -- the counts last sent
  sent_working   INTEGER,
  sent_waiting   INTEGER,
  sent_at        INTEGER,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (room_id, device)
) STRICT, WITHOUT ROWID;

CREATE TABLE agent_leases (
  room_id        BLOB NOT NULL,
  device         BLOB NOT NULL,
  process        BLOB NOT NULL,
  generation     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  hears          INTEGER NOT NULL DEFAULT 0,
  working        INTEGER NOT NULL DEFAULT 0,
  last_call_at   INTEGER NOT NULL DEFAULT 0,
  -- when the hub told the human devices that this agent's lease ran out and it stayed away
  lost_at        INTEGER,
  PRIMARY KEY (room_id, device)
) STRICT, WITHOUT ROWID;
"#;

pub struct Db {
    writer: Mutex<Connection>,
    readers: Vec<Mutex<Connection>>,
    next: std::sync::atomic::AtomicUsize,
}

fn tune(c: &Connection) -> rusqlite::Result<()> {
    c.execute_batch("PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY; PRAGMA foreign_keys = ON; PRAGMA cache_size = -32768;")?;
    c.set_prepared_statement_cache_capacity(256);
    Ok(())
}

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Db> {
        let writer = Connection::open(path)?;
        let tables: i64 =
            writer.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get(0))?;
        if tables == 0 {
            // must be set before the first table
            writer.execute_batch("PRAGMA auto_vacuum = INCREMENTAL;")?;
        }
        writer.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")?;
        tune(&writer)?;
        let version: i64 = writer.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if tables == 0 {
            writer.execute_batch(&format!(
                "BEGIN; {SCHEMA} PRAGMA user_version = {SCHEMA_VERSION}; COMMIT;"
            ))?;
        } else if version != SCHEMA_VERSION {
            return Err(rusqlite::Error::InvalidParameterName(format!(
                "the database has schema {version}, this hub writes schema {SCHEMA_VERSION}"
            )));
        }
        writer.execute_batch("BEGIN;")?;
        let added = (|| {
            writer.execute_batch(ADDED_TO_5)?;
            let has_bound: i64 = writer.query_row(
                "SELECT count(*) FROM pragma_table_info('board_frontiers') WHERE name = 'bound'",
                [],
                |r| r.get(0),
            )?;
            let had_table: i64 = writer.query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'board_frontiers'",
                [],
                |r| r.get(0),
            )?;
            if had_table == 1 && has_bound == 0 {
                writer.execute_batch(
                    "ALTER TABLE board_frontiers RENAME TO board_frontiers_first;",
                )?;
                writer.execute_batch(BOARD_FRONTIERS)?;
                writer.execute_batch(
                    "INSERT INTO board_frontiers (room_id, board, device, bound, frontier, files, at, counts)
                       SELECT room_id, board, device, 1, frontier, files, at, counts FROM board_frontiers_first;
                     DROP TABLE board_frontiers_first;",
                )?;
            } else {
                writer.execute_batch(BOARD_FRONTIERS)?;
            }
            let has_epoch: i64 = writer.query_row(
                "SELECT count(*) FROM pragma_table_info('welcomes') WHERE name = 'epoch'",
                [],
                |r| r.get(0),
            )?;
            if has_epoch == 0 {
                writer.execute_batch("ALTER TABLE welcomes ADD COLUMN epoch INTEGER;")?;
            }
            // the Offer's MAC (12.1.2), stored and served with it; none for an invite stored before
            let has_mac: i64 = writer.query_row(
                "SELECT count(*) FROM pragma_table_info('invites') WHERE name = 'offer_mac'",
                [],
                |r| r.get(0),
            )?;
            if has_mac == 0 {
                writer.execute_batch("ALTER TABLE invites ADD COLUMN offer_mac BLOB;")?;
            }
            // on every open, never lowering it: also a counter an earlier build seeded too low is raised (the
            // ids it skips cost nothing)
            writer.execute_batch(WELCOME_IDS_SEED)?;
            writer.execute_batch(
                "CREATE INDEX IF NOT EXISTS welcomes_by_epoch ON welcomes(group_id, epoch) WHERE epoch IS NOT NULL;
                 CREATE INDEX IF NOT EXISTS welcomes_by_group ON welcomes(group_id, device);
                 CREATE INDEX IF NOT EXISTS groups_by_founding ON groups(room_id, founded_change);",
            )
        })();
        match added {
            Ok(()) => writer.execute_batch("COMMIT;")?,
            Err(e) => {
                let _ = writer.execute_batch("ROLLBACK;");
                return Err(e);
            }
        }
        let mut readers = Vec::new();
        for _ in 0..8 {
            let r = Connection::open_with_flags(
                path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?;
            tune(&r)?;
            readers.push(Mutex::new(r));
        }
        Ok(Db {
            writer: Mutex::new(writer),
            readers,
            next: Default::default(),
        })
    }

    /// The one writing connection. A poisoned lock is taken over: every write is a transaction, so a panic in the
    /// middle of one left nothing behind but an open transaction, which `write` rolls back.
    fn writer(&self) -> MutexGuard<'_, Connection> {
        self.writer.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// One transaction on the writing connection: all of `f` or nothing.
    pub fn write<T, E: From<rusqlite::Error>>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, E>,
    ) -> Result<T, E> {
        self.write_then(f, |_| {})
    }

    /// As `write`; `then` runs once the transaction is committed and before the next writer gets its turn, so
    /// that what it announces is announced in the order of the commits.
    pub fn write_then<T, E: From<rusqlite::Error>>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, E>,
        then: impl FnOnce(&T),
    ) -> Result<T, E> {
        let c = self.writer();
        if !c.is_autocommit() {
            let _ = c.execute_batch("ROLLBACK");
        }
        c.execute_batch("BEGIN IMMEDIATE")?;
        match f(&c) {
            Ok(v) => {
                c.execute_batch("COMMIT")?;
                then(&v);
                Ok(v)
            }
            Err(e) => {
                let _ = c.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    /// Runs `f` in a transaction that is always rolled back: a dry run against the real state.
    pub fn rehearse<T, E: From<rusqlite::Error>>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, E>,
    ) -> Result<T, E> {
        let c = self.writer();
        if !c.is_autocommit() {
            let _ = c.execute_batch("ROLLBACK");
        }
        c.execute_batch("BEGIN IMMEDIATE")?;
        let out = f(&c);
        let _ = c.execute_batch("ROLLBACK");
        out
    }

    /// A consistent read on one of the reading connections.
    pub fn read<T, E: From<rusqlite::Error>>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, E>,
    ) -> Result<T, E> {
        // a reader that is free, if there is one: a long read on one connection does not hold up the others
        let start = self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let free = (0..self.readers.len()).find_map(|k| {
            self.readers[(start + k) % self.readers.len()]
                .try_lock()
                .ok()
        });
        let c = match free {
            Some(c) => c,
            None => self.readers[start % self.readers.len()]
                .lock()
                .unwrap_or_else(|e| e.into_inner()),
        };
        if !c.is_autocommit() {
            let _ = c.execute_batch("ROLLBACK");
        }
        c.execute_batch("BEGIN")?;
        let out = f(&c);
        let _ = c.execute_batch("ROLLBACK");
        out
    }

    pub fn maintain(&self) {
        let c = self.writer();
        let _ = c.execute_batch("PRAGMA incremental_vacuum(2048); PRAGMA wal_checkpoint(PASSIVE);");
    }

    /// At shutdown: only if no write holds the connection; a WAL that was not checkpointed is replayed at the
    /// next start.
    pub fn checkpoint(&self) {
        if let Ok(c) = self.writer.try_lock() {
            let _ = c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        }
    }
}

/// The next change number of a room.
pub fn next_change(c: &Connection, room: &[u8]) -> rusqlite::Result<i64> {
    c.query_row(
        "UPDATE rooms SET change = change + 1 WHERE room_id = ?1 RETURNING change",
        [room],
        |r| r.get(0),
    )
}
