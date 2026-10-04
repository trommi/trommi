// wal.mjs: keeps SQLite's write-ahead log short. A passive checkpoint every tick (never blocks), and a
// truncating one when the WAL file has grown past `truncateBytes`. The hub has one connection, so a
// checkpoint is never held back by a reader in another process.
import fs from 'node:fs'
import path from 'node:path'

export function walKeeper({ db, dataDir, truncateBytes = 64 << 20 }) {
  const file = path.join(dataDir, 'hub.db')
  const size = f => { try { return fs.statSync(f).size } catch { return 0 } }
  const last = { log_frames: 0, checkpointed_frames: 0, truncations: 0, last_ms: 0 }
  return {
    last,
    dbBytes: () => size(file),
    walBytes: () => size(`${file}-wal`),
    checkpoint() {
      const t = performance.now()
      const mode = size(`${file}-wal`) > truncateBytes ? 'TRUNCATE' : 'PASSIVE'
      const r = db.prepare(`PRAGMA wal_checkpoint(${mode})`).get()
      if (mode === 'TRUNCATE') last.truncations++
      last.log_frames = Math.max(0, r.log)
      last.checkpointed_frames = Math.max(0, r.checkpointed)
      last.last_ms = performance.now() - t
      return last
    },
  }
}
