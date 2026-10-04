// store.mjs: the hub's SQLite database (hub.db). Table and column names are the README's ("What the hub
// stores"). Truth: envelopes and member_entries. Derived and rebuildable: objects, timelines.
//
// roomStorage(db, roomId) is the storage core/hub.mjs asks for (the methods of its memoryStorage), plus
// chainHeads/envelopeHash (so a room loads without re-verifying every envelope) and transaction.
//
// Ids and hashes in the hot envelopes table are BLOBs (32 bytes instead of 64 hex characters); room_id,
// object_id and timeline_id stay text (A2's ops modules and the admin view address rows by them).
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import * as z from '../core/zcrypto.mjs'

const { hex, unhex } = z
export const SCHEMA_VERSION = 2
const bytes = v => (v == null ? null : new Uint8Array(v.buffer ?? v, v.byteOffset ?? 0, v.byteLength ?? v.length))
const hexOf = v => (v == null ? null : hex(bytes(v)))
const ACTION = { [z.ENTRY.GENESIS]: 'room_founded', [z.ENTRY.ADD]: 'device_added', [z.ENTRY.REMOVE]: 'devices_removed', [z.ENTRY.RECOVER]: 'recovery' }

const SCHEMA = `
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
  room_id TEXT NOT NULL, device_id TEXT NOT NULL, endpoint TEXT NOT NULL, subscription TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, device_id, endpoint)
) WITHOUT ROWID;
`

/**
 * Open (or create) HUB_DATA/hub.db. A database of an older schema (pre-launch: test rooms only, unreadable
 * under the v1.1 bytes) is moved aside to hub.db.v<old>-<date>, with its attachments, and a fresh one begins.
 */
export function openDb(dir, { log = () => {} } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'hub.db')
  if (fs.existsSync(file)) {
    const probe = new DatabaseSync(file)
    const version = probe.prepare('PRAGMA user_version').get().user_version
    const used = probe.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'rooms'").get().n > 0
    probe.close()
    if (used && version < SCHEMA_VERSION) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const aside = `${file}.v${version || 1}-${stamp}`
      for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(file + suffix)) fs.renameSync(file + suffix, aside + suffix)
      const att = path.join(dir, 'attachments')
      if (fs.existsSync(att)) fs.renameSync(att, `${att}.v${version || 1}-${stamp}`)
      log(`hub.db had schema ${version || 1}; moved aside to ${path.basename(aside)}, starting fresh with schema ${SCHEMA_VERSION}`)
    }
  }
  const db = new DatabaseSync(file)
  // Incremental auto-vacuum, set before the first table exists (a fresh file): deleted rooms give space back in small steps.
  if (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get().n === 0) db.exec('PRAGMA auto_vacuum = INCREMENTAL')
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY;')
  db.exec(SCHEMA)
  // Added without a schema bump: when an envelope of the uploader first named an attachment (null: pending upload,
  // deleted after an hour). Rows from before are counted as referenced.
  if (!db.prepare("SELECT 1 FROM pragma_table_info('attachments') WHERE name = 'referenced_at'").get()) {
    db.exec('ALTER TABLE attachments ADD COLUMN referenced_at INTEGER')
    db.exec('UPDATE attachments SET referenced_at = stored_at')
  }
  // Void records (review 2 #5): a refused envelope kept pruned so the sender's chain moves on; void_code is the refusal.
  if (!db.prepare("SELECT 1 FROM pragma_table_info('envelopes') WHERE name = 'void_code'").get()) db.exec('ALTER TABLE envelopes ADD COLUMN void_code TEXT')
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  const cache = new Map()
  db.q = sql => { let s = cache.get(sql); if (!s) cache.set(sql, s = db.prepare(sql)); return s }
  let depth = 0
  db.tx = fn => {
    if (depth) return fn()
    depth++
    db.exec('BEGIN IMMEDIATE')
    try { const out = fn(); db.exec('COMMIT'); return out } catch (err) { db.exec('ROLLBACK'); throw err } finally { depth-- }
  }
  return db
}

/** Give free pages back to the file system, a few megabytes per call (off the hot path: a timer, after room deletions). */
export function vacuumStep(db, pages = 2048) {
  const free = db.prepare('PRAGMA freelist_count').get().freelist_count
  if (free > 0) db.exec(`PRAGMA incremental_vacuum(${pages})`)
  return free
}

/** Ciphertext bytes -> STREAM chunk count of an encrypted attachment (22-byte head, 64 KiB + tag per chunk). */
export const chunkCount = size => Math.max(1, Math.ceil(Math.max(0, size - 22) / (65536 + 16)))

// ---- derived tables --------------------------------------------------------------

function deriveRow(db, r) {
  if (r.object_id) {
    const o = db.q('SELECT first_envelope_number FROM objects WHERE room_id = ? AND object_id = ?').get(r.room_id, r.object_id)
    if (!o) {
      db.q('INSERT INTO objects (room_id, object_id, object_state, urgency, answered_at, owner_device_id, first_envelope_number, latest_head_envelope_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(r.room_id, r.object_id, r.object_state, r.urgency, r.answered_at, r.sender, r.envelope_number, r.envelope_number)
    } else {
      db.q('UPDATE objects SET object_state = ?, urgency = ?, answered_at = ?, latest_head_envelope_number = ? WHERE room_id = ? AND object_id = ?')
        .run(r.object_state, r.urgency, r.answered_at, r.envelope_number, r.room_id, r.object_id)
    }
  }
  if (r.timeline_id != null) {
    db.q(`INSERT INTO timelines (room_id, timeline_kind, timeline_id, last_envelope_number, item_count) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT (room_id, timeline_kind, timeline_id) DO UPDATE SET last_envelope_number = excluded.last_envelope_number, item_count = item_count + 1`)
      .run(r.room_id, r.timeline_kind, r.timeline_id, r.envelope_number)
  }
}

/** Drop and rebuild objects and timelines from envelopes (all rooms). */
export function rebuildDerived(db) {
  db.tx(() => {
    db.exec('DELETE FROM objects; DELETE FROM timelines;')
    for (const r of db.prepare('SELECT room_id, envelope_number, sender_device_id, object_id, object_state, urgency, answered_at, timeline_kind, timeline_id FROM envelopes WHERE object_id IS NOT NULL OR timeline_id IS NOT NULL ORDER BY room_id, envelope_number').iterate()) {
      deriveRow(db, { ...r, sender: hexOf(r.sender_device_id) })
    }
  })
}

// ---- one room, as core/hub.mjs sees it -----------------------------------------------

export function roomStorage(db, roomId) {
  const q = db.q
  const inviteOf = r => {
    if (!r) return null
    const requests = q('SELECT request_hash, device_id, signed_request, received_at FROM join_requests WHERE room_id = ? AND invite_id = ? ORDER BY received_at, rowid').all(roomId, r.invite_id)
      .map(x => ({ hash: x.request_hash, bytes: bytes(x.signed_request), device: x.device_id, at: x.received_at }))
    const entrySeq = r.added_device_id ? q('SELECT added_entry_number FROM devices WHERE room_id = ? AND device_id = ?').get(roomId, r.added_device_id)?.added_entry_number ?? null : null
    return {
      id: r.invite_id, role: r.device_role, inviter: r.inviter_device_id, expiresAt: r.expires_at, usedAt: r.used_at, burnedAt: r.burned_at ?? null, offer: bytes(r.signed_offer), requests,
      reveal: r.signed_reveal ? { bytes: bytes(r.signed_reveal), requestHash: r.answered_request_hash } : null, member: r.added_device_id, entrySeq,
    }
  }
  return {
    transaction: fn => db.tx(fn),
    entries: () => q('SELECT signed_entry FROM member_entries WHERE room_id = ? ORDER BY entry_number').all(roomId).map(r => bytes(r.signed_entry)),
    entryTimes: () => q('SELECT received_at FROM member_entries WHERE room_id = ? ORDER BY entry_number').all(roomId).map(r => r.received_at),
    appendEntry(entry, info) {
      q('INSERT INTO member_entries (room_id, entry_number, previous_entry_hash, entry_hash, entry_action, signer_device_id, signed_entry, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(roomId, info.seq, info.prevHash, info.hash, ACTION[info.type], info.signer, entry, info.at)
      if (info.seq === 0) q('INSERT INTO rooms (room_id, founded_at, last_entry_number) VALUES (?, ?, 0)').run(roomId, info.at)
      else q('UPDATE rooms SET last_entry_number = ? WHERE room_id = ?').run(info.seq, roomId)
      for (const m of info.state.members.values()) {
        q(`INSERT INTO devices (room_id, device_id, device_role, key_signing_public, key_exchange_public, added_entry_number, removed_entry_number, removal_cut_sequence, removal_cut_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (room_id, device_id) DO UPDATE SET removed_entry_number = excluded.removed_entry_number,
          removal_cut_sequence = excluded.removal_cut_sequence, removal_cut_hash = excluded.removal_cut_hash`)
          .run(roomId, hex(m.id), m.role === z.ROLE.HUMAN ? 'human' : 'agent', m.signPub, m.kexPub, m.addedSeq, m.removedSeq, m.cut?.seq ?? null, m.cut?.hash ?? null)
      }
      // A removed device's push subscriptions go in the same transaction (R6).
      for (const d of info.removed ?? []) q('DELETE FROM push_subscriptions WHERE room_id = ? AND device_id = ?').run(roomId, d)
    },
    // R4 leases survive a hub restart (a deploy must not stop every running agent).
    getLease(id) { const r = q('SELECT process_instance, lease_generation, expires_at FROM agent_leases WHERE room_id = ? AND device_id = ?').get(roomId, id); return r ? { instance: r.process_instance, generation: r.lease_generation, expiresAt: r.expires_at } : null },
    putLease(id, l) { q('INSERT INTO agent_leases (room_id, device_id, process_instance, lease_generation, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (room_id, device_id) DO UPDATE SET process_instance = excluded.process_instance, lease_generation = excluded.lease_generation, expires_at = excluded.expires_at').run(roomId, id, l.instance, l.generation, l.expiresAt) },
    deleteLease(id) { q('DELETE FROM agent_leases WHERE room_id = ? AND device_id = ?').run(roomId, id) },
    putWrap(epoch, id, sealed) { q('INSERT OR IGNORE INTO sealed_room_keys (room_id, key_epoch, device_id, key_sealed) VALUES (?, ?, ?, ?)').run(roomId, epoch, id, sealed) },
    wraps: (id, afterEpoch = 0) => q('SELECT key_epoch, key_sealed FROM sealed_room_keys WHERE room_id = ? AND device_id = ? AND key_epoch > ? ORDER BY key_epoch').all(roomId, id, afterEpoch)
      .map(r => ({ epoch: r.key_epoch, id, sealed: bytes(r.key_sealed) })),
    putBackLink(epoch, link) { q('INSERT OR IGNORE INTO key_back_links (room_id, key_epoch, key_back_link) VALUES (?, ?, ?)').run(roomId, epoch, link) },
    backLinks: () => q('SELECT key_epoch, key_back_link FROM key_back_links WHERE room_id = ? ORDER BY key_epoch').all(roomId).map(r => ({ epoch: r.key_epoch, bytes: bytes(r.key_back_link) })),
    putGrant(sessionId, g) {
      q('INSERT INTO session_grants (room_id, session_id, grant_number, previous_grant_hash, grant_hash, session_key_epoch, signer_device_id, signed_grant, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(roomId, sessionId, g.grantNumber, g.previousGrantHash, g.grantHash, g.epoch, g.signer, g.bytes, g.receivedAt)
    },
    grants: sessionId => q('SELECT signed_grant, received_at FROM session_grants WHERE room_id = ? AND session_id = ? ORDER BY grant_number').all(roomId, sessionId).map(r => ({ bytes: bytes(r.signed_grant), receivedAt: r.received_at })),
    sessionsCreatedBy: signer => q('SELECT COUNT(*) AS n FROM session_grants WHERE room_id = ? AND grant_number = 0 AND signer_device_id = ?').get(roomId, signer).n,
    sessions: () => q('SELECT session_id, MAX(grant_number) AS last_grant_number, MAX(session_key_epoch) AS session_key_epoch FROM session_grants WHERE room_id = ? GROUP BY session_id ORDER BY session_id').all(roomId),
    putSessionWrap(sessionId, epoch, id, sealed) { q('INSERT OR IGNORE INTO sealed_session_keys (room_id, session_id, session_key_epoch, device_id, key_sealed) VALUES (?, ?, ?, ?, ?)').run(roomId, sessionId, epoch, id, sealed) },
    sessionWraps: (sessionId, id, afterEpoch = 0) => q('SELECT session_key_epoch, key_sealed FROM sealed_session_keys WHERE room_id = ? AND session_id = ? AND device_id = ? AND session_key_epoch > ? ORDER BY session_key_epoch')
      .all(roomId, sessionId, id, afterEpoch).map(r => ({ epoch: r.session_key_epoch, id, sealed: bytes(r.key_sealed) })),
    putSessionBackLink(sessionId, epoch, link) { q('INSERT OR IGNORE INTO session_key_back_links (room_id, session_id, session_key_epoch, key_back_link) VALUES (?, ?, ?, ?)').run(roomId, sessionId, epoch, link) },
    sessionBackLinks: sessionId => q('SELECT session_key_epoch, key_back_link FROM session_key_back_links WHERE room_id = ? AND session_id = ? ORDER BY session_key_epoch').all(roomId, sessionId)
      .map(r => ({ epoch: r.session_key_epoch, bytes: bytes(r.key_back_link) })),
    putInvite(id, inv) {
      db.tx(() => {
        q(`INSERT INTO invites (room_id, invite_id, device_role, inviter_device_id, signed_offer, expires_at, signed_reveal, answered_request_hash, used_at, added_device_id, burned_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (room_id, invite_id) DO UPDATE SET signed_reveal = excluded.signed_reveal,
          answered_request_hash = excluded.answered_request_hash, used_at = excluded.used_at, added_device_id = excluded.added_device_id, burned_at = excluded.burned_at`)
          .run(roomId, id, inv.role, inv.inviter, inv.offer, inv.expiresAt, inv.reveal?.bytes ?? null, inv.reveal?.requestHash ?? null, inv.usedAt ?? null, inv.member ?? null, inv.burnedAt ?? null)
        for (const r of inv.requests) q('INSERT OR IGNORE INTO join_requests (room_id, invite_id, request_hash, device_id, signed_request, received_at) VALUES (?, ?, ?, ?, ?, ?)').run(roomId, id, r.hash, r.device, r.bytes, r.at)
      })
    },
    invite: id => inviteOf(q('SELECT * FROM invites WHERE room_id = ? AND invite_id = ?').get(roomId, id)),
    // Only the open ones: core/hub.mjs counts these against the limit of open invites.
    invites: () => q('SELECT * FROM invites WHERE room_id = ? AND used_at IS NULL AND burned_at IS NULL AND expires_at >= ?').all(roomId, Date.now() - 60000).map(inviteOf),
    appendEnvelope(envelope, m) {
      return db.tx(() => {
        const n = q('SELECT last_envelope_number FROM rooms WHERE room_id = ?').get(roomId).last_envelope_number + 1
        const h = m.header
        const isVoid = !!m.voidCode                   // a void record names no object, timeline or attachment
        const row = {
          room_id: roomId, envelope_number: n, sender: m.sender, object_id: h.card && !isVoid ? hex(h.card.id) : null, object_state: isVoid ? null : h.card?.state ?? null,
          urgency: isVoid ? null : h.card?.urgency ?? null, answered_at: isVoid ? null : h.card?.answeredAt ?? null, timeline_kind: isVoid ? null : h.timelineKind, timeline_id: isVoid ? null : h.timelineId,
        }
        q(`INSERT INTO envelopes (room_id, envelope_number, sender_device_id, sender_sequence, previous_envelope_hash, envelope_hash, key_epoch, recipient_device_id,
          object_id, object_state, urgency, answered_at, envelope_kind, timeline_kind, timeline_id, send_push, attachment_ids, padded_size, sent_at, received_at,
          envelope_header, envelope_nonce, encrypted_body, encrypted_body_hash, envelope_signature, void_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(roomId, n, h.sender, h.seq, h.prev, m.hash, h.epoch, m.recipient ? h.recipient : null, row.object_id, row.object_state, row.urgency, row.answered_at,
            h.kind, row.timeline_kind, row.timeline_id, m.push ? 1 : 0, h.blobs.length && !isVoid ? h.blobs.map(hex).join(',') : null, m.ciphertext ? m.ciphertext.length - 16 : 0, h.time, m.time,
            m.headerBytes, m.nonce, m.ciphertext ?? null, m.ciphertextHash, m.signature, m.voidCode ?? null)
        q('UPDATE rooms SET last_envelope_number = ? WHERE room_id = ?').run(n, roomId)
        if (isVoid) return n
        deriveRow(db, row)
        // Attachments named in the header belong to the object (or to the card whose chat this is): deleted with it.
        const owner = row.object_id ?? (h.timelineKind === z.TIMELINE.CHAT && /^card\/[0-9a-f]{32}$/.test(h.timelineId ?? '') ? h.timelineId.slice(5) : null)
        // C02: only the sender's own uploads; naming someone else's attachment binds (and so deletes) nothing.
        if (owner) for (const b of h.blobs) q('UPDATE attachments SET object_id = ? WHERE room_id = ? AND attachment_id = ? AND object_id IS NULL AND uploader_device_id = ?').run(owner, roomId, hex(b), m.sender)
        for (const b of h.blobs) q('UPDATE attachments SET referenced_at = ? WHERE room_id = ? AND attachment_id = ? AND uploader_device_id = ? AND referenced_at IS NULL').run(m.time, roomId, hex(b), m.sender)
        return n
      })
    },
    envelopes: (after = 0, limit = 200) => q('SELECT * FROM envelopes WHERE room_id = ? AND envelope_number > ? ORDER BY envelope_number LIMIT ?').all(roomId, after, Number.isFinite(limit) ? limit : -1)
      .map(r => ({ n: r.envelope_number, bytes: envelopeBytes(r, true), pruned: r.encrypted_body == null, voidCode: r.void_code ?? undefined, card: r.object_id ? { id: r.object_id, state: r.object_state, urgency: r.urgency, answeredAt: r.answered_at } : null, time: r.received_at })),
    replaceEnvelope(n) { q('UPDATE envelopes SET encrypted_body = NULL WHERE room_id = ? AND envelope_number = ?').run(roomId, n) },
    /** What the hub needs to judge a write to an object: its creator, the kind and key scope of its first envelope. */
    objectInfo(objectId) {
      const r = q(`SELECT o.owner_device_id, e.envelope_kind, e.envelope_header FROM objects o JOIN envelopes e ON e.room_id = o.room_id AND e.envelope_number = o.first_envelope_number
        WHERE o.room_id = ? AND o.object_id = ?`).get(roomId, objectId)
      if (!r) return null
      const hb = bytes(r.envelope_header)
      const keyScope = hb[38]                                  // version, flags, room id (32), epoch (4), then the scope byte
      return { owner: r.owner_device_id, firstKind: r.envelope_kind, keyScope, sessionId: keyScope === 1 ? hex(hb.slice(39, 55)) : null }
    },
    chainHeads: () => q('SELECT sender_device_id, MAX(sender_sequence) AS seq, envelope_hash FROM envelopes WHERE room_id = ? GROUP BY sender_device_id').all(roomId)
      .map(r => ({ sender: hexOf(r.sender_device_id), seq: r.seq, hash: bytes(r.envelope_hash) })),
    envelopeHash: (sender, seq) => { const r = q('SELECT envelope_hash FROM envelopes WHERE room_id = ? AND sender_device_id = ? AND sender_sequence = ?').get(roomId, unhex(sender), seq); return r ? bytes(r.envelope_hash) : null },
  }
}

/** The wire bytes of a stored envelope: full if `full` and the body is still there, else the pruned form. */
export function envelopeBytes(r, full) {
  const body = full ? r.encrypted_body : null
  return z.joinEnvelope({ headerBytes: bytes(r.envelope_header), nonce: bytes(r.envelope_nonce), signature: bytes(r.envelope_signature), ciphertext: body ? bytes(body) : null, ciphertextHash: bytes(r.encrypted_body_hash) })
}
