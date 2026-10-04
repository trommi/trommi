// store.mjs: the hub's SQLite database (hub.db). Table and column names are the README's ("What the hub
// stores"). Truth: envelopes and member_entries. Derived and rebuildable: objects, timelines.
//
// roomStorage(db, roomId) is the storage crypto/hub.mjs asks for (the methods of its memoryStorage), plus
// chainHeads/envelopeHash (so a room loads without re-verifying every envelope) and transaction.
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import * as z from '../crypto/zcrypto.mjs'

const { hex, unhex } = z
const bytes = v => (v == null ? null : new Uint8Array(v.buffer ?? v, v.byteOffset ?? 0, v.byteLength ?? v.length))
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
  added_entry_number INTEGER NOT NULL, removed_entry_number INTEGER, agent_session_id TEXT,
  PRIMARY KEY (room_id, device_id)
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS devices_by_session ON devices (room_id, agent_session_id) WHERE agent_session_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS sealed_room_keys (
  room_id TEXT NOT NULL, key_epoch INTEGER NOT NULL, device_id TEXT NOT NULL, key_sealed BLOB NOT NULL,
  PRIMARY KEY (room_id, device_id, key_epoch)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS key_back_links (
  room_id TEXT NOT NULL, key_epoch INTEGER NOT NULL, key_back_link BLOB NOT NULL, PRIMARY KEY (room_id, key_epoch)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS invites (
  room_id TEXT NOT NULL, invite_id TEXT NOT NULL, device_role TEXT NOT NULL, inviter_device_id TEXT NOT NULL, signed_offer BLOB NOT NULL,
  expires_at INTEGER NOT NULL, signed_reveal BLOB, answered_request_hash TEXT, used_at INTEGER, added_device_id TEXT,
  PRIMARY KEY (room_id, invite_id)
);
CREATE TABLE IF NOT EXISTS join_requests (
  room_id TEXT NOT NULL, invite_id TEXT NOT NULL, request_hash TEXT NOT NULL, device_id TEXT NOT NULL, signed_request BLOB NOT NULL, received_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, invite_id, request_hash)
);
CREATE TABLE IF NOT EXISTS envelopes (
  room_id TEXT NOT NULL, envelope_number INTEGER NOT NULL, sender_device_id TEXT NOT NULL, sender_sequence INTEGER NOT NULL,
  previous_envelope_hash TEXT NOT NULL, envelope_hash TEXT NOT NULL, key_epoch INTEGER NOT NULL, recipient_device_id TEXT,
  object_id TEXT, object_state INTEGER, urgency INTEGER, answered_at INTEGER,
  envelope_kind INTEGER NOT NULL, timeline_kind INTEGER, timeline_id TEXT, is_head INTEGER NOT NULL, send_push INTEGER NOT NULL,
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
CREATE TABLE IF NOT EXISTS push_subscriptions (
  room_id TEXT NOT NULL, device_id TEXT NOT NULL, endpoint TEXT NOT NULL, subscription TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, device_id, endpoint)
) WITHOUT ROWID;
`

/** Open (or create) HUB_DATA/hub.db. */
export function openDb(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(path.join(dir, 'hub.db'))
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY;')
  db.exec(SCHEMA)
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

/** Ciphertext bytes -> STREAM chunk count of an encrypted attachment (22-byte head, 64 KiB + tag per chunk). */
export const chunkCount = size => Math.max(1, Math.ceil(Math.max(0, size - 22) / (65536 + 16)))

// ---- derived tables --------------------------------------------------------------

function deriveRow(db, r) {
  if (r.object_id) {
    const o = db.q('SELECT first_envelope_number FROM objects WHERE room_id = ? AND object_id = ?').get(r.room_id, r.object_id)
    if (!o) {
      db.q('INSERT INTO objects (room_id, object_id, object_state, urgency, answered_at, owner_device_id, first_envelope_number, latest_head_envelope_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(r.room_id, r.object_id, r.object_state, r.urgency, r.answered_at, r.sender_device_id, r.envelope_number, r.envelope_number)
    } else if (r.is_head) {
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
    for (const r of db.prepare('SELECT room_id, envelope_number, sender_device_id, object_id, object_state, urgency, answered_at, timeline_kind, timeline_id, is_head FROM envelopes WHERE object_id IS NOT NULL OR timeline_id IS NOT NULL ORDER BY room_id, envelope_number').iterate()) deriveRow(db, r)
  })
}

// ---- one room, as crypto/hub.mjs sees it -----------------------------------------------

export function roomStorage(db, roomId) {
  const q = db.q
  const inviteOf = r => {
    if (!r) return null
    const requests = q('SELECT request_hash, device_id, signed_request, received_at FROM join_requests WHERE room_id = ? AND invite_id = ? ORDER BY received_at, rowid').all(roomId, r.invite_id)
      .map(x => ({ hash: x.request_hash, bytes: bytes(x.signed_request), device: x.device_id, at: x.received_at }))
    const entrySeq = r.added_device_id ? q('SELECT added_entry_number FROM devices WHERE room_id = ? AND device_id = ?').get(roomId, r.added_device_id)?.added_entry_number ?? null : null
    return {
      id: r.invite_id, role: r.device_role, inviter: r.inviter_device_id, expiresAt: r.expires_at, usedAt: r.used_at, offer: bytes(r.signed_offer), requests,
      reveal: r.signed_reveal ? { bytes: bytes(r.signed_reveal), requestHash: r.answered_request_hash } : null, member: r.added_device_id, entrySeq,
    }
  }
  return {
    transaction: fn => db.tx(fn),
    entries: () => q('SELECT signed_entry FROM member_entries WHERE room_id = ? ORDER BY entry_number').all(roomId).map(r => bytes(r.signed_entry)),
    appendEntry(entry, info) {
      q('INSERT INTO member_entries (room_id, entry_number, previous_entry_hash, entry_hash, entry_action, signer_device_id, signed_entry, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(roomId, info.seq, info.prevHash, info.hash, ACTION[info.type], info.signer, entry, info.at)
      if (info.seq === 0) q('INSERT INTO rooms (room_id, founded_at, last_entry_number) VALUES (?, ?, 0)').run(roomId, info.at)
      else q('UPDATE rooms SET last_entry_number = ? WHERE room_id = ?').run(info.seq, roomId)
      for (const m of info.state.members.values()) {
        q(`INSERT INTO devices (room_id, device_id, device_role, key_signing_public, key_exchange_public, added_entry_number, removed_entry_number) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (room_id, device_id) DO UPDATE SET removed_entry_number = excluded.removed_entry_number`)
          .run(roomId, hex(m.id), m.role === z.ROLE.HUMAN ? 'human' : 'agent', m.signPub, m.kexPub, m.addedSeq, m.removedSeq)
      }
    },
    putWrap(epoch, id, sealed) { q('INSERT OR IGNORE INTO sealed_room_keys (room_id, key_epoch, device_id, key_sealed) VALUES (?, ?, ?, ?)').run(roomId, epoch, id, sealed) },
    wraps: (id, afterEpoch = 0) => q('SELECT key_epoch, key_sealed FROM sealed_room_keys WHERE room_id = ? AND device_id = ? AND key_epoch > ? ORDER BY key_epoch').all(roomId, id, afterEpoch)
      .map(r => ({ epoch: r.key_epoch, id, sealed: bytes(r.key_sealed) })),
    putBackLink(epoch, link) { q('INSERT OR IGNORE INTO key_back_links (room_id, key_epoch, key_back_link) VALUES (?, ?, ?)').run(roomId, epoch, link) },
    backLinks: () => q('SELECT key_epoch, key_back_link FROM key_back_links WHERE room_id = ? ORDER BY key_epoch').all(roomId).map(r => ({ epoch: r.key_epoch, bytes: bytes(r.key_back_link) })),
    putInvite(id, inv) {
      db.tx(() => {
        q(`INSERT INTO invites (room_id, invite_id, device_role, inviter_device_id, signed_offer, expires_at, signed_reveal, answered_request_hash, used_at, added_device_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (room_id, invite_id) DO UPDATE SET signed_reveal = excluded.signed_reveal,
          answered_request_hash = excluded.answered_request_hash, used_at = excluded.used_at, added_device_id = excluded.added_device_id`)
          .run(roomId, id, inv.role, inv.inviter, inv.offer, inv.expiresAt, inv.reveal?.bytes ?? null, inv.reveal?.requestHash ?? null, inv.usedAt ?? null, inv.member ?? null)
        for (const r of inv.requests) q('INSERT OR IGNORE INTO join_requests (room_id, invite_id, request_hash, device_id, signed_request, received_at) VALUES (?, ?, ?, ?, ?, ?)').run(roomId, id, r.hash, r.device, r.bytes, r.at)
      })
    },
    invite: id => inviteOf(q('SELECT * FROM invites WHERE room_id = ? AND invite_id = ?').get(roomId, id)),
    // Only the open ones: crypto/hub.mjs counts these against the limit of open invites.
    invites: () => q('SELECT * FROM invites WHERE room_id = ? AND used_at IS NULL AND expires_at >= ?').all(roomId, Date.now() - 60000).map(inviteOf),
    appendEnvelope(envelope, m) {
      return db.tx(() => {
        const n = q('SELECT last_envelope_number FROM rooms WHERE room_id = ?').get(roomId).last_envelope_number + 1
        const h = m.header
        const row = {
          room_id: roomId, envelope_number: n, sender_device_id: m.sender, object_id: h.card ? hex(h.card.id) : null, object_state: h.card?.state ?? null,
          urgency: h.card?.urgency ?? null, answered_at: h.card?.answeredAt ?? null, timeline_kind: h.timelineKind, timeline_id: h.timelineId, is_head: h.isHead ? 1 : 0,
        }
        q(`INSERT INTO envelopes (room_id, envelope_number, sender_device_id, sender_sequence, previous_envelope_hash, envelope_hash, key_epoch, recipient_device_id,
          object_id, object_state, urgency, answered_at, envelope_kind, timeline_kind, timeline_id, is_head, send_push, attachment_ids, padded_size, sent_at, received_at,
          envelope_header, envelope_nonce, encrypted_body, encrypted_body_hash, envelope_signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(roomId, n, m.sender, h.seq, hex(h.prev), hex(m.hash), h.epoch, m.recipient, row.object_id, row.object_state, row.urgency, row.answered_at,
            h.kind, h.timelineKind, h.timelineId, row.is_head, h.push ? 1 : 0, h.blobs.length ? h.blobs.map(hex).join(',') : null, m.ciphertext.length - 16, h.time, m.time,
            m.headerBytes, m.nonce, m.ciphertext, m.ciphertextHash, m.signature)
        q('UPDATE rooms SET last_envelope_number = ? WHERE room_id = ?').run(n, roomId)
        deriveRow(db, row)
        // Attachments named in the header belong to the object (or to the card whose chat this is): deleted with it.
        const owner = row.object_id ?? (h.timelineKind === z.TIMELINE.CHAT && /^card\/[0-9a-f]{32}$/.test(h.timelineId ?? '') ? h.timelineId.slice(5) : null)
        if (owner) for (const b of h.blobs) q('UPDATE attachments SET object_id = ? WHERE room_id = ? AND attachment_id = ? AND object_id IS NULL').run(owner, roomId, hex(b))
        return n
      })
    },
    envelopes: (after = 0, limit = 200) => q('SELECT * FROM envelopes WHERE room_id = ? AND envelope_number > ? ORDER BY envelope_number LIMIT ?').all(roomId, after, Number.isFinite(limit) ? limit : -1)
      .map(r => ({ n: r.envelope_number, bytes: envelopeBytes(r, true), pruned: r.encrypted_body == null, card: r.object_id ? { id: r.object_id, state: r.object_state, urgency: r.urgency, answeredAt: r.answered_at } : null, time: r.received_at })),
    replaceEnvelope(n) { q('UPDATE envelopes SET encrypted_body = NULL WHERE room_id = ? AND envelope_number = ?').run(roomId, n) },
    bindSession(device, session) { q('UPDATE devices SET agent_session_id = ? WHERE room_id = ? AND device_id = ?').run(session, roomId, device) },
    sessionOf: device => q('SELECT agent_session_id FROM devices WHERE room_id = ? AND device_id = ?').get(roomId, device)?.agent_session_id ?? null,
    boundSessions: () => q('SELECT agent_session_id FROM devices WHERE room_id = ? AND agent_session_id IS NOT NULL').all(roomId).map(r => r.agent_session_id),
    chainHeads: () => q('SELECT sender_device_id, MAX(sender_sequence) AS seq, envelope_hash FROM envelopes WHERE room_id = ? GROUP BY sender_device_id').all(roomId)
      .map(r => ({ sender: r.sender_device_id, seq: r.seq, hash: unhex(r.envelope_hash) })),
    envelopeHash: (sender, seq) => { const r = q('SELECT envelope_hash FROM envelopes WHERE room_id = ? AND sender_device_id = ? AND sender_sequence = ?').get(roomId, sender, seq); return r ? unhex(r.envelope_hash) : null },
  }
}

/** The wire bytes of a stored envelope: full if `full` and the body is still there, else the pruned form. */
export function envelopeBytes(r, full) {
  const body = full ? r.encrypted_body : null
  return z.joinEnvelope({ headerBytes: bytes(r.envelope_header), nonce: bytes(r.envelope_nonce), signature: bytes(r.envelope_signature), ciphertext: body ? bytes(body) : null, ciphertextHash: bytes(r.encrypted_body_hash) })
}
