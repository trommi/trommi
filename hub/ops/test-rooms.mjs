// test-rooms.mjs: rooms for load tests, opened by a signed test request. OFF unless HUB_TEST_PUBLIC_KEY is set to an
// Ed25519 public key (base64url x); there is no default key ("off" or empty: off; keep it off before launch).
// The load harness holds the private half and signs
//   x-test-signature: v1.<timestamp ms>.<nonce>.<sig>, sig = base64url Ed25519 signature of
//   "trommi-test-request/v1\n<METHOD>\n<path?query>\n<timestamp>\n<nonce>" (nonce: 16 random base64url characters).
// Valid for 60 s and once. Such a request may found a room with `test_room: true` (without the founding token and
// the per-address founding limit) and may DELETE a test room. Rate limits are lifted only for the routes of a room in
// the test-room set; never for a real room. A test room expires after 24 hours.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { refuse } from './http.mjs'

const DAY = 86400000, FRESH_MS = 60000, LABEL = 'trommi-test-request/v1'

const message = (method, pathAndQuery, at, nonce) => Buffer.from(`${LABEL}\n${method}\n${pathAndQuery}\n${at}\n${nonce}`)

/** The header value for one request (the harness side). `privateKey`: PEM or KeyObject. */
export function signTestRequest(privateKey, method, pathAndQuery, at = Date.now()) {
  const nonce = crypto.randomBytes(12).toString('base64url')
  return `v1.${at}.${nonce}.${crypto.sign(null, message(method, pathAndQuery, at, nonce), privateKey).toString('base64url')}`
}

/** The public key from the environment value, or null (test rooms off) when unset, empty or "off". */
function publicKeyOf(value) {
  const v = String(value ?? '').trim()
  if (!v || /^(off|0|false|no)$/i.test(v)) return null
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: v }, format: 'jwk' })
}

export function testRooms({ db, dataDir, publicKey = null, closeRoom = async () => {}, now = Date.now, log = () => {}, lifetimeMs = DAY }) {
  db.exec('CREATE TABLE IF NOT EXISTS test_rooms (room_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL) WITHOUT ROWID')
  const ids = new Set(db.prepare('SELECT room_id FROM test_rooms').all().map(r => r.room_id))
  const key = publicKeyOf(publicKey)
  const used = new Map()             // nonce -> expiry: each signed request works once
  const verdicts = new WeakMap()     // req -> boolean, so one request can be asked several times

  function verify(req) {
    if (!key) return false
    const m = /^v1\.(\d{13})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{86})$/.exec(req.headers['x-test-signature'] ?? '')
    if (!m) return false
    const at = Number(m[1]), t = now()
    if (Math.abs(t - at) > FRESH_MS || used.has(m[2])) return false
    if (!crypto.verify(null, message(req.method, req.url, at, m[2]), key, Buffer.from(m[3], 'base64url'))) return false
    for (const [s, exp] of used) { if (exp > t) break; used.delete(s) }       // oldest first: insertion order
    used.set(m[2], t + 2 * FRESH_MS)
    return true
  }
  /** True if the request carries a valid, fresh, unused test signature. */
  const isTestRequest = req => { let v = verdicts.get(req); if (v === undefined) verdicts.set(req, v = verify(req)); return v }

  /** Every table with a room_id column, read from the schema, so new tables are covered without a change here. */
  const roomTables = () => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(t => t.name)
    .filter(name => db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = 'room_id'`).get(name))

  async function remove(roomId) {
    await closeRoom(roomId)
    db.tx(() => { for (const t of roomTables()) db.q(`DELETE FROM "${t}" WHERE room_id = ?`).run(roomId) })
    fs.rmSync(path.join(dataDir, 'attachments', roomId), { recursive: true, force: true })
    ids.delete(roomId)
    log(`test room ${roomId.slice(0, 8)} deleted`)
  }

  return {
    enabled: !!key,
    isTestRequest,
    /** In the test-room set while test rooms are on (with the key unset, old test rooms are ordinary rooms). */
    isTestRoom: roomId => !!key && ids.has(roomId),
    /** Before founding: is this a test room, and may it be one? */
    wanted(req, body) {
      if (body?.test_room !== true) return false
      if (!isTestRequest(req)) refuse(403, 'forbidden', 'a test room needs a signed test request (x-test-signature)')
      return true
    },
    mark(roomId) {
      db.q('INSERT OR REPLACE INTO test_rooms (room_id, expires_at) VALUES (?, ?)').run(roomId, now() + lifetimeMs)
      ids.add(roomId)
    },
    /** DELETE /v1/rooms/:room_id, signed; only test rooms. */
    async delete(req, roomId) {
      if (!isTestRequest(req)) refuse(403, 'forbidden', 'deleting a room needs a signed test request (x-test-signature)')
      if (!ids.has(roomId)) refuse(404, 'not-found', 'no such test room; only test rooms can be deleted')
      await remove(roomId)
    },
    async expire() {
      for (const r of db.q('SELECT room_id FROM test_rooms WHERE expires_at < ?').all(now())) await remove(r.room_id)
    },
  }
}
