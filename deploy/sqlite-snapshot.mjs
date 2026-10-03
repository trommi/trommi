#!/usr/bin/env node
// A consistent copy of one SQLite database while another process (the hub) keeps writing to it.
//
//   node deploy/sqlite-snapshot.mjs <database> <copy>      take the copy, check it, print what is in it
//   node deploy/sqlite-snapshot.mjs --counts <database>    only print what is in a database
//
// The copy is made by SQLite itself (VACUUM INTO) from a read-only connection: one read transaction, so the copy is
// the database as it was at one moment, including what still sits in the write-ahead log (pad.db-wal). Copying the
// three files pad.db, pad.db-wal and pad.db-shm by hand while the hub runs can give a torn or stale database.
// The source is never written to. The copy is one file of mode 0600, checked with PRAGMA integrity_check.
//
// Prints one line of JSON: records per kind of the board, rows per table, the size. Never a record's content.
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const fail = words => { console.error(`error: ${words}`); process.exit(1) }

function contents(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const check = db.prepare('PRAGMA integrity_check').all().map(row => Object.values(row)[0])
    if (check.length !== 1 || check[0] !== 'ok') fail(`${file} fails SQLite's integrity check`)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name)
    const rows = Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).get().n]))
    const board = tables.includes('board_docs')
      ? Object.fromEntries(db.prepare("SELECT kind, count(*) AS n FROM board_docs WHERE kind <> 'root' GROUP BY kind ORDER BY kind").all().map(row => [row.kind, row.n]))
      : {}
    return { board, tables: rows, bytes: fs.statSync(file).size }
  } finally {
    db.close()
  }
}

const args = process.argv.slice(2)
if (args[0] === '--counts' && args[1]) {
  console.log(JSON.stringify(contents(args[1])))
} else if (args.length === 2 && !args[0].startsWith('-')) {
  const [source, copy] = args
  if (!fs.existsSync(source)) fail(`no database at ${source}`)
  if (fs.existsSync(copy)) fail(`${copy} exists already`)
  process.umask(0o077)
  const db = new DatabaseSync(source, { readOnly: true })
  try {
    // The hub may hold the write lock for a moment; wait for it instead of giving up.
    db.exec('PRAGMA busy_timeout = 10000')
    db.prepare('VACUUM INTO ?').run(copy)
  } catch (err) {
    fs.rmSync(copy, { force: true })
    fail(`could not copy ${source}: ${err.message}`)
  } finally {
    db.close()
  }
  fs.chmodSync(copy, 0o600)
  console.log(JSON.stringify(contents(copy)))
} else {
  console.error('usage: sqlite-snapshot.mjs <database> <copy> | --counts <database>')
  process.exit(2)
}
