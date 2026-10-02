#!/usr/bin/env node
// The board's state in SQLite: cards, chat, sessions, status lines, assets and
// the agents' waiting events, in the same file as the pad (data/pad.db).
//
// The hub still works on one object in memory (`state` in server.mjs). What
// changed is where it rests: instead of rewriting state.json whole on every
// change, each record is a row, and a commit writes only the rows that
// changed, in one transaction. A hub that dies in the middle of a write
// leaves the previous commit behind, whole.
//
//   board_docs (kind, key) -> ord, doc
//     kind 'root', key ''          everything in the state that is not a list of records
//                                  (next_number, hub, queue, pending, ...)
//     kind 'cards', 'messages', …  one row per record of that list; ord is its place in the list
//
// The lists are taken as they come: any top-level array of records in the
// state is a kind. A new list in server.mjs needs nothing here.
//
// As a tool:
//   node server/board-store.mjs export <data dir> [file]   the state as JSON, as state.json held it (default: stdout)
//   node server/board-store.mjs counts <data dir>          how many records of each kind
//   node server/board-store.mjs back <data dir>            the way back, with the hub stopped: writes the state to
//                                                          state.json (an existing one is renamed, not overwritten) and
//                                                          takes the marker away, so a hub with BOARD_STORE=json, or
//                                                          on a Node without SQLite, starts from it
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Older Nodes have no SQLite; the hub then keeps its state in state.json, as before.
let DatabaseSync = null
try { ({ DatabaseSync } = await import('node:sqlite')) } catch {}

export const DB_NAME = 'pad.db'
// Lies in the data folder from the moment the board rests in the database. A hub that cannot or shall not use
// SQLite refuses to start beside it: state.json is then out of date, and it would show a board from the past.
export const MOVED_NAME = 'state.in-sqlite'
const dbFile = dataDir => path.join(dataDir, DB_NAME)

// A record's key within its list: its id, with its session where it has one (status lines are named per session).
// Records without an id, or with an id that is there twice, are told apart by their place.
function keysOf(list) {
  const seen = new Set()
  return list.map((item, at) => {
    const id = item && typeof item === 'object' && item.id != null ? `${item.agent ?? ''}/${item.id}` : `#${at}`
    const key = seen.has(id) ? `${id}#${at}` : id
    seen.add(key)
    return key
  })
}
// A list of records gets a row per record; an empty list, or one of plain values (the queue of ids), stays in the root.
const isList = value => Array.isArray(value) && value.length > 0 && value.every(x => x && typeof x === 'object' && !Array.isArray(x))

/** Opens the board's tables in <dataDir>/pad.db. Throws when this Node has no SQLite. */
export function openBoard(dataDir) {
  if (!DatabaseSync) throw new Error(`this Node ${process.versions.node} has no SQLite (node:sqlite)`)
  const file = dbFile(dataDir)
  const db = new DatabaseSync(file)
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA journal_mode = WAL')
  // A committed write survives a crash of the hub; on power loss the last commits may be missing, never half.
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('CREATE TABLE IF NOT EXISTS board_docs (kind TEXT NOT NULL, key TEXT NOT NULL, ord INTEGER NOT NULL, doc TEXT NOT NULL, PRIMARY KEY (kind, key)) WITHOUT ROWID')
  // The state holds what the token protects; nobody but the owner reads it.
  const lock = () => { for (const f of [file, `${file}-wal`, `${file}-shm`]) try { fs.chmodSync(f, 0o600) } catch {} }
  lock()
  const all = db.prepare('SELECT kind, key, ord, doc FROM board_docs ORDER BY kind, ord, key')
  const put = db.prepare('INSERT INTO board_docs (kind, key, ord, doc) VALUES (?, ?, ?, ?) ON CONFLICT (kind, key) DO UPDATE SET ord = excluded.ord, doc = excluded.doc')
  const drop = db.prepare('DELETE FROM board_docs WHERE kind = ? AND key = ?')
  // What the file holds, as this process last read or wrote it: kind -> key -> [ord, doc].
  let held = new Map()

  // The state as an object like the one state.json held, or null for a board that was never written.
  function read() {
    held = new Map()
    const out = {}
    let root = null
    for (const row of all.all()) {
      if (!held.has(row.kind)) held.set(row.kind, new Map())
      held.get(row.kind).set(row.key, [row.ord, row.doc])
      if (row.kind === 'root') root = JSON.parse(row.doc)
      else (out[row.kind] ??= []).push(JSON.parse(row.doc))
    }
    if (!root) return null
    // A list that is empty has no rows; the root remembers that it is a list.
    for (const kind of root.lists ?? []) out[kind] ??= []
    return { ...root.rest, ...out }
  }

  // Brings the file to this state: only rows that differ are written, all of them or none.
  function write(state) {
    const next = new Map()
    const rest = {}
    const lists = []
    for (const [name, value] of Object.entries(state)) {
      if (value === undefined) continue
      if (!isList(value) || name === 'root') { rest[name] = value; continue }
      lists.push(name)
      const keys = keysOf(value)
      next.set(name, new Map(value.map((item, at) => [keys[at], [at, JSON.stringify(item)]])))
    }
    next.set('root', new Map([['', [0, JSON.stringify({ lists, rest })]]]))
    let changed = 0
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const [kind, rows] of next) {
        const before = held.get(kind)
        for (const [key, [ord, doc]] of rows) {
          const was = before?.get(key)
          if (was && was[0] === ord && was[1] === doc) continue
          put.run(kind, key, ord, doc)
          changed++
        }
      }
      for (const [kind, rows] of held) {
        const now = next.get(kind)
        for (const key of rows.keys()) if (!now?.has(key)) { drop.run(kind, key); changed++ }
      }
      db.exec('COMMIT')
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
    held = next
    if (changed) lock()
    return changed
  }

  // Whether the file, read anew, says what this state says. Returns the names of what differs.
  function differences(state) {
    const kept = held
    const stored = read() ?? {}
    held = kept
    const names = new Set([...Object.keys(stored), ...Object.keys(state).filter(k => state[k] !== undefined)])
    return [...names].filter(name => JSON.stringify(stored[name]) !== JSON.stringify(state[name]))
  }

  const counts = () => Object.fromEntries(db.prepare("SELECT kind, count(*) AS n FROM board_docs WHERE kind <> 'root' GROUP BY kind").all().map(r => [r.kind, r.n]))
  // Back to a board that was never written.
  const clear = () => { db.exec('DELETE FROM board_docs'); held = new Map() }
  return { file, read, write, differences, counts, clear, close: () => db.close() }
}

/** The stored state of a data folder, read once: for tests and tools. null when the board was never written. */
export function readBoard(dataDir) {
  if (!fs.existsSync(dbFile(dataDir))) return null
  const board = openBoard(dataDir)
  try { return board.read() } finally { board.close() }
}

/** Replaces the stored state of a data folder: for tests and for restoring an export. The hub must not be running. */
export function writeBoard(dataDir, state) {
  const board = openBoard(dataDir)
  try { board.read(); return board.write(state) } finally { board.close() }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, dir, out] = process.argv.slice(2)
  if (!['export', 'counts', 'back'].includes(cmd) || !dir) {
    console.error('usage: board-store.mjs export <data dir> [file] | counts <data dir> | back <data dir>')
    process.exit(1)
  }
  const board = fs.existsSync(dbFile(dir)) ? openBoard(dir) : null
  const stored = board?.read()
  if (!stored) {
    console.error(`no board state in ${dbFile(dir)}`)
    process.exit(1)
  }
  if (cmd === 'counts') console.log(JSON.stringify(board.counts()))
  else if (cmd === 'back') {
    const target = path.join(dir, 'state.json')
    if (fs.existsSync(target)) fs.renameSync(target, path.join(dir, `state.before-${Date.now()}.json`))
    fs.writeFileSync(target, JSON.stringify(stored, null, 2), { mode: 0o600 })
    fs.rmSync(path.join(dir, MOVED_NAME), { force: true })
    console.log(`state.json written from ${dbFile(dir)}; start the hub with BOARD_STORE=json to stay with it`)
  }
  else if (out) fs.writeFileSync(out, JSON.stringify(stored, null, 2), { mode: 0o600 })
  else process.stdout.write(JSON.stringify(stored, null, 2) + '\n')
  board.close()
}
