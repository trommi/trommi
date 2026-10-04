// escrow.mjs: one password escrow per room, opaque to the hub (stream B's format: PBKDF2 parameters, salt and
// AES-GCM inside `key_escrow`). PUT and DELETE by a human member; GET by anyone with the room id, rate limited
// per room and per address, because the blob is all a password guesser needs.
import { refuse } from './http.mjs'

export const ESCROW_MAX_BYTES = 4096
const B64U = /^[A-Za-z0-9_-]+$/

export function passwordEscrow({ db, now = Date.now }) {
  db.exec(`CREATE TABLE IF NOT EXISTS escrows (room_id TEXT PRIMARY KEY, escrow_version INTEGER NOT NULL, key_escrow BLOB NOT NULL,
    updater_device_id TEXT NOT NULL, updated_at INTEGER NOT NULL) WITHOUT ROWID`)
  return {
    put(roomId, deviceId, body) {
      const version = body.escrow_version
      if (!Number.isInteger(version) || version < 1 || version > 255) refuse(400, 'bad-argument', 'escrow_version must be an integer from 1 to 255')
      if (typeof body.key_escrow !== 'string' || !B64U.test(body.key_escrow)) refuse(400, 'bad-argument', 'key_escrow (base64url) is missing')
      const blob = Buffer.from(body.key_escrow, 'base64url')
      if (blob.length > ESCROW_MAX_BYTES) refuse(413, 'too-large', `key_escrow is at most ${ESCROW_MAX_BYTES} bytes`)
      const at = now()
      db.q(`INSERT INTO escrows (room_id, escrow_version, key_escrow, updater_device_id, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (room_id) DO UPDATE SET escrow_version = excluded.escrow_version, key_escrow = excluded.key_escrow,
        updater_device_id = excluded.updater_device_id, updated_at = excluded.updated_at`).run(roomId, version, blob, deviceId, at)
      return { escrow_version: version, updated_at: at }
    },
    get(roomId) {
      const r = db.q('SELECT escrow_version, key_escrow, updated_at FROM escrows WHERE room_id = ?').get(roomId)
      if (!r) refuse(404, 'not-found', 'this room has no password escrow')
      return { escrow_version: r.escrow_version, key_escrow: Buffer.from(r.key_escrow).toString('base64url'), updated_at: r.updated_at }
    },
    delete(roomId) { db.q('DELETE FROM escrows WHERE room_id = ?').run(roomId) },
  }
}
