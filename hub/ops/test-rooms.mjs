// test-rooms.mjs: rooms for load tests. Founding with `test_room: true` needs header x-test-token
// (= HUB_TEST_TOKEN); such a room expires after 24 hours and can be deleted at once with the same token.
// The token also lifts rate limits for the requests that carry it; envelopes of a test room skip them too.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { refuse } from './http.mjs'

const DAY = 86400000

export function testRooms({ db, dataDir, token = '', closeRoom = async () => {}, now = Date.now, log = () => {}, lifetimeMs = DAY }) {
  db.exec('CREATE TABLE IF NOT EXISTS test_rooms (room_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL) WITHOUT ROWID')
  const ids = new Set(db.prepare('SELECT room_id FROM test_rooms').all().map(r => r.room_id))
  const expected = token ? crypto.createHash('sha256').update(token).digest() : null

  /** True if the request carries the right x-test-token (constant time). */
  const hasToken = req => {
    const given = req.headers['x-test-token']
    return !!expected && typeof given === 'string' && crypto.timingSafeEqual(expected, crypto.createHash('sha256').update(given).digest())
  }

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
    hasToken,
    isTestRoom: roomId => ids.has(roomId),
    /** Before founding: is this a test room, and may it be one? */
    wanted(req, body) {
      if (body.test_room !== true) return false
      if (!hasToken(req)) refuse(403, 'forbidden', 'a test room needs header x-test-token')
      return true
    },
    mark(roomId) {
      db.q('INSERT OR REPLACE INTO test_rooms (room_id, expires_at) VALUES (?, ?)').run(roomId, now() + lifetimeMs)
      ids.add(roomId)
    },
    /** DELETE /v1/rooms/:room_id with the token; only test rooms. */
    async delete(req, roomId) {
      if (!hasToken(req)) refuse(403, 'forbidden', 'deleting a room needs header x-test-token')
      if (!ids.has(roomId)) refuse(404, 'not-found', 'no such test room; only test rooms can be deleted')
      await remove(roomId)
    },
    async expire() {
      for (const r of db.q('SELECT room_id FROM test_rooms WHERE expires_at < ?').all(now())) await remove(r.room_id)
    },
  }
}
