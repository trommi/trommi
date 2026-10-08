// delete-room.mjs: removing a whole room from hub.db and the disk, for the admin page's "Test accounts" (the
// throwaway accounts of old end-to-end runs, email ending in @example.org).
//
//   deleteRoom(db, dataDir, roomId, { allowNonTest })  one transaction over every table with a room_id column
//                                                      (read from the schema: accounts, rooms, member_entries,
//                                                      devices, keys, grants, invites, join_requests, envelopes,
//                                                      objects, timelines, attachments, push_subscriptions, shares,
//                                                      agent_leases, test_rooms, an old escrows table, ...), then the
//                                                      room's attachment files. Refuses a room whose account email
//                                                      does not end with @example.org unless allowNonTest is true
//                                                      (the admin page never passes it). → { room_id, email, rows, files }
//   backupDb(db, dataDir)                              an online copy (VACUUM INTO, like hub/deploy-backup.sh),
//                                                      gzipped to <dataDir>/backups/hub-<stamp>-before-delete.db.gz;
//                                                      the 5 newest such copies are kept
//   deleteRooms({ db, dataDir, roomIds, closeRoom })   backup once, then each room (its live streams closed first);
//                                                      every deletion is logged and appended to <dataDir>/deletions.log
//   testAccounts(db)                                   the accounts the admin page lists
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { pipeline } from 'node:stream/promises'

export const TEST_EMAIL_SUFFIX = '@example.org'
const BACKUPS_KEPT = 5

export const isTestEmail = email => typeof email === 'string' && email.trim().toLowerCase().endsWith(TEST_EMAIL_SUFFIX)

const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)

/** Every table with a room_id column, read from the schema, so new tables are covered without a change here. */
export const roomTables = db => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(t => t.name)
  .filter(name => db.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = 'room_id'").get(name))

/** Accounts whose email ends with @example.org, with what their room holds. Works on a read-only connection. */
export function testAccounts(db) {
  if (!db || !hasTable(db, 'accounts')) return []
  const has = name => hasTable(db, name)
  const count = t => (has(t) ? `(SELECT COUNT(*) FROM "${t}" x WHERE x.room_id = a.room_id)` : '0')
  const last = has('envelopes') ? '(SELECT MAX(received_at) FROM envelopes x WHERE x.room_id = a.room_id)' : 'NULL'
  const updated = db.prepare("SELECT 1 FROM pragma_table_info('accounts') WHERE name = 'updated_at'").get() ? 'a.updated_at' : 'NULL'
  return db.prepare(`SELECT a.room_id, a.email, a.created_at, MAX(COALESCE(${last}, 0), COALESCE(${updated}, 0), COALESCE(a.created_at, 0)) AS last_activity,
      ${count('envelopes')} AS envelopes, ${count('attachments')} AS attachments
    FROM accounts a WHERE lower(trim(a.email)) LIKE ? ORDER BY a.created_at, a.room_id`).all(`%${TEST_EMAIL_SUFFIX}`)
    .filter(r => isTestEmail(r.email))   // LIKE treats _ and % as wildcards; the suffix has none, but be exact anyway
}

/** Removes every row of the room and its attachment files. Synchronous: one transaction, then the files. */
export function deleteRoom(db, dataDir, roomId, { allowNonTest = false } = {}) {
  const email = checkTestRoom(db, roomId, allowNonTest)
  const rows = {}
  const run = () => { for (const t of roomTables(db)) { const n = Number(db.prepare(`DELETE FROM "${t}" WHERE room_id = ?`).run(roomId).changes); if (n) rows[t] = n } }
  if (db.tx) db.tx(run)
  else {
    db.exec('BEGIN IMMEDIATE')
    try { run(); db.exec('COMMIT') } catch (err) { db.exec('ROLLBACK'); throw err }
  }
  let files = 0
  const dir = path.join(dataDir, 'attachments', roomId)
  try { files = fs.readdirSync(dir).length } catch { /* none */ }
  fs.rmSync(dir, { recursive: true, force: true })
  return { room_id: roomId, email, rows, files }
}

/** An online, consistent copy of hub.db (VACUUM INTO on the given connection), gzipped. → its path */
export async function backupDb(db, dataDir, { now = Date.now, label = 'before-delete' } = {}) {
  const dir = path.join(dataDir, 'backups')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stamp = new Date(now()).toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\..*$/, '')
  const raw = path.join(dir, `hub-${stamp}-${label}.db`)
  fs.rmSync(raw, { force: true })
  db.prepare('VACUUM INTO ?').run(raw)
  const gz = `${raw}.gz`
  try {
    await pipeline(fs.createReadStream(raw), zlib.createGzip({ level: 1 }), fs.createWriteStream(`${gz}.part`, { mode: 0o600 }))
    fs.renameSync(`${gz}.part`, gz)
  } finally { fs.rmSync(raw, { force: true }); fs.rmSync(`${gz}.part`, { force: true }) }
  const old = fs.readdirSync(dir).filter(f => f.endsWith(`-${label}.db.gz`)).sort().reverse().slice(BACKUPS_KEPT)
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true })
  return gz
}

/**
 * Backup first, then each room. A refused room (not a test room) stops nothing else; it is reported.
 * → { backup, deleted: [{ room_id, email, rows, files }], refused: [{ room_id, message }], totals: { table: n, files } }
 */
export async function deleteRooms({ db, dataDir, roomIds, closeRoom = async () => {}, allowNonTest = false, by = 'admin', now = Date.now, log = () => {} }) {
  const backup = await backupDb(db, dataDir, { now })
  log(`delete rooms: backup ${backup}`)
  const deleted = [], refused = [], totals = {}
  for (const roomId of roomIds) {
    try {
      // Check before closing the room, so a refused one keeps its live streams.
      checkTestRoom(db, roomId, allowNonTest)
      await closeRoom(roomId)
      const r = deleteRoom(db, dataDir, roomId, { allowNonTest })
      await closeRoom(roomId)   // a request may have loaded it again while the first close was awaited
      deleted.push(r)
      for (const [t, n] of Object.entries(r.rows)) totals[t] = (totals[t] || 0) + n
      totals.files = (totals.files || 0) + r.files
      const line = { at: new Date(now()).toISOString(), by, room_id: roomId, email: r.email, rows: r.rows, files: r.files, backup: path.basename(backup) }
      fs.appendFileSync(path.join(dataDir, 'deletions.log'), `${JSON.stringify(line)}\n`, { mode: 0o600 })
      log(`delete rooms: room ${roomId.slice(0, 12)} (${r.email}) deleted by ${by}: ${Object.entries(r.rows).map(([t, n]) => `${t} ${n}`).join(', ') || 'no rows'}, files ${r.files}`)
    } catch (err) {
      refused.push({ room_id: String(roomId), message: err.message })
      log(`delete rooms: room ${String(roomId).slice(0, 12)} not deleted: ${err.message}`)
    }
  }
  return { backup, deleted, refused, totals }
}

/** The account email of the room; throws unless it ends with @example.org (or allowNonTest). */
function checkTestRoom(db, roomId, allowNonTest) {
  if (!/^[0-9a-f]{64}$/.test(String(roomId))) throw Object.assign(new Error('room id: 64 hex characters'), { code: 'bad-argument' })
  const email = hasTable(db, 'accounts') ? db.prepare('SELECT email FROM accounts WHERE room_id = ?').get(roomId)?.email ?? null : null
  if (!allowNonTest && !isTestEmail(email)) {
    throw Object.assign(new Error(`room ${roomId.slice(0, 12)} is not a test room (its account email does not end with ${TEST_EMAIL_SUFFIX}); refused`), { code: 'not-a-test-room' })
  }
  return email
}
