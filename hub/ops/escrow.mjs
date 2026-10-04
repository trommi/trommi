// escrow.mjs: one password escrow per room, opaque to the hub (the client's format inside `key_escrow`). PUT and
// DELETE by a human member. v2 (review 2): the blob is stored under an `escrow_id` the client derives from the slow
// passphrase KDF, and GET /escrow/:escrow_id returns it only for that id, so every passphrase guess is an online,
// rate-limited request. v1 (no id): GET /escrow with the room id, kept until the app has cut over; a v2 escrow is
// never served there.
import { refuse } from './http.mjs'

export const ESCROW_MAX_BYTES = 4096
const B64U = /^[A-Za-z0-9_-]+$/

export function passwordEscrow({ db, now = Date.now }) {
  db.exec(`CREATE TABLE IF NOT EXISTS escrows (room_id TEXT PRIMARY KEY, escrow_version INTEGER NOT NULL, key_escrow BLOB NOT NULL,
    updater_device_id TEXT NOT NULL, updated_at INTEGER NOT NULL) WITHOUT ROWID`)
  if (!db.prepare("SELECT 1 FROM pragma_table_info('escrows') WHERE name = 'escrow_id'").get()) db.exec('ALTER TABLE escrows ADD COLUMN escrow_id TEXT')
  return {
    put(roomId, deviceId, body) {
      const version = body.escrow_version
      if (!Number.isInteger(version) || version < 1 || version > 255) refuse(400, 'bad-argument', 'escrow_version must be an integer from 1 to 255')
      if (typeof body.key_escrow !== 'string' || !B64U.test(body.key_escrow)) refuse(400, 'bad-argument', 'key_escrow (base64url) is missing')
      const blob = Buffer.from(body.key_escrow, 'base64url')
      if (blob.length > ESCROW_MAX_BYTES) refuse(413, 'too-large', `key_escrow is at most ${ESCROW_MAX_BYTES} bytes`)
      const escrowId = version >= 2 ? body.escrow_id : null
      if (version >= 2 && (typeof escrowId !== 'string' || !/^[0-9a-f]{32}$/.test(escrowId))) refuse(400, 'bad-argument', 'escrow_id (32 lowercase hex) is required from escrow_version 2')
      const at = now()
      db.q(`INSERT INTO escrows (room_id, escrow_version, key_escrow, updater_device_id, updated_at, escrow_id) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (room_id) DO UPDATE SET escrow_version = excluded.escrow_version, key_escrow = excluded.key_escrow,
        updater_device_id = excluded.updater_device_id, updated_at = excluded.updated_at, escrow_id = excluded.escrow_id`).run(roomId, version, blob, deviceId, at, escrowId)
      return { escrow_version: version, updated_at: at }
    },
    /** v1: by room id (never a v2 escrow). v2: only with its escrow id. One 404 for every miss. */
    get(roomId, escrowId = null) {
      const r = db.q('SELECT escrow_version, key_escrow, updated_at, escrow_id FROM escrows WHERE room_id = ?').get(roomId)
      if (!r || (escrowId == null ? r.escrow_id != null : r.escrow_id !== escrowId)) refuse(404, 'not-found', 'this room has no password escrow')
      return { escrow_version: r.escrow_version, key_escrow: Buffer.from(r.key_escrow).toString('base64url'), updated_at: r.updated_at }
    },
    delete(roomId) { db.q('DELETE FROM escrows WHERE room_id = ?').run(roomId) },
  }
}
