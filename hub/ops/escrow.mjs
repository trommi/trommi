// escrow.mjs: one password escrow per room, opaque to the hub (the client's format inside `key_escrow`). PUT and
// DELETE by a human member. v2 (review 2): the blob is stored under an `escrow_id` the client derives from the slow
// passphrase KDF, and GET /escrow/:escrow_id returns it only for that id, so every passphrase guess is an online,
// rate-limited request.
// Review 3:
//   - Only escrow_version 2 is stored; the room-id route never serves a blob.
//   - Compare-and-swap: every escrow row carries a `revision` (rising, kept across a delete as a tombstone). PUT names
//     the revision it replaces (`replaces`, 0 when there is none), DELETE names it (`?revision=`); anything else is
//     409 escrow-changed, so two devices cannot silently overwrite or delete each other's escrow.
import { refuse } from './http.mjs'

export const ESCROW_MAX_BYTES = 4096
const B64U = /^[A-Za-z0-9_-]+$/

export function passwordEscrow({ db, now = Date.now }) {
  db.exec(`CREATE TABLE IF NOT EXISTS escrows (room_id TEXT PRIMARY KEY, escrow_version INTEGER NOT NULL, key_escrow BLOB NOT NULL,
    updater_device_id TEXT NOT NULL, updated_at INTEGER NOT NULL, escrow_id TEXT, revision INTEGER NOT NULL DEFAULT 1) WITHOUT ROWID`)
  const row = roomId => db.q('SELECT escrow_version, key_escrow, updated_at, escrow_id, revision, updater_device_id FROM escrows WHERE room_id = ?').get(roomId)
  const live = r => r && r.escrow_version > 0 ? r : null          // escrow_version 0: a tombstone (deleted; keeps the revision)
  const swap = (roomId, expected) => {
    const r = row(roomId)
    const current = r ? r.revision : 0
    if (!Number.isInteger(expected) || expected !== current) refuse(409, 'escrow-changed', `the escrow is at revision ${current}; read it again (GET /escrow with your token) and name that revision`)
    return current
  }
  return {
    put(roomId, deviceId, body) {
      const version = body.escrow_version
      if (version !== 2) refuse(400, 'bad-argument', 'escrow_version must be 2')
      if (typeof body.key_escrow !== 'string' || !B64U.test(body.key_escrow)) refuse(400, 'bad-argument', 'key_escrow (base64url) is missing')
      const blob = Buffer.from(body.key_escrow, 'base64url')
      if (blob.length > ESCROW_MAX_BYTES) refuse(413, 'too-large', `key_escrow is at most ${ESCROW_MAX_BYTES} bytes`)
      const escrowId = body.escrow_id
      if (typeof escrowId !== 'string' || !/^[0-9a-f]{32}$/.test(escrowId)) refuse(400, 'bad-argument', 'escrow_id (32 lowercase hex) is required')
      const replaces = body.replaces
      const at = now()
      let revision
      db.tx(() => {
        revision = swap(roomId, replaces) + 1
        db.q(`INSERT INTO escrows (room_id, escrow_version, key_escrow, updater_device_id, updated_at, escrow_id, revision) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (room_id) DO UPDATE SET escrow_version = excluded.escrow_version, key_escrow = excluded.key_escrow,
          updater_device_id = excluded.updater_device_id, updated_at = excluded.updated_at, escrow_id = excluded.escrow_id, revision = excluded.revision`).run(roomId, version, blob, deviceId, at, escrowId, revision)
      })
      return { escrow_version: version, updated_at: at, revision }
    },
    /** Anonymous: v2 only, only with its escrow id. One 404 for every miss (and the room-id route never answers 200). */
    get(roomId, escrowId) {
      const r = live(row(roomId))
      if (!r || escrowId == null || r.escrow_id == null || r.escrow_id !== escrowId) refuse(404, 'not-found', 'this room has no password escrow')
      return { escrow_version: r.escrow_version, key_escrow: Buffer.from(r.key_escrow).toString('base64url'), updated_at: r.updated_at }
    },
    /** A signed-in human member: whether there is an escrow and its revision (for PUT/DELETE); never the blob. */
    status(roomId) {
      const r = row(roomId)
      const l = live(r)
      return { has_escrow: !!l, revision: r ? r.revision : 0, escrow_version: l?.escrow_version ?? null, updated_at: r?.updated_at ?? null, updater_device_id: r?.updater_device_id ?? null }
    },
    delete(roomId, deviceId, expected) {
      let revision
      db.tx(() => {
        const current = swap(roomId, expected)
        revision = current + 1
        if (current === 0) return
        db.q("UPDATE escrows SET escrow_version = 0, key_escrow = x'', escrow_id = NULL, updater_device_id = ?, updated_at = ?, revision = ? WHERE room_id = ?").run(deviceId, now(), revision, roomId)
      })
      return { revision }
    },
    /** True if a stored escrow (not a tombstone) matches this id: the room's miss budget is charged only otherwise. */
    exists(roomId, escrowId) { const r = live(row(roomId)); return !!r && escrowId != null && r.escrow_id === escrowId },
  }
}
