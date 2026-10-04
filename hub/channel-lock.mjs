// channel-lock.mjs: one process per agent key slot (README R4), for hub/channel.mjs.
//
// Node has no flock, so the lock is a file holding the owner's pid, created atomically WITH its content: the pid
// goes into a private temp file first, then link() puts it in place, which fails if a lock exists. So no process
// ever reads an empty or half-written lock. A lock whose pid is gone is stale. It is moved aside with rename(),
// which is atomic, so only one process wins. If the moved file is not the stale lock that was looked at (another
// process took over in between), it is put back and the slot counts as busy.
import fs from 'node:fs'

const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const pidIn = file => { try { return Number(fs.readFileSync(file, 'utf8')) || 0 } catch { return 0 } }

/** Take the lock of a slot ({ dir, lock_file }); true if this process holds it now. */
export function lockSlot(p) {
  fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 })
  const mine = `${p.lock_file}.${process.pid}.tmp`
  fs.writeFileSync(mine, String(process.pid), { mode: 0o600 })
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try { fs.linkSync(mine, p.lock_file); return true } catch (e) { if (e.code !== 'EEXIST') throw e }
      const pid = pidIn(p.lock_file)
      if (pid === process.pid) return true
      if (!pid || alive(pid)) return false
      const aside = `${p.lock_file}.${process.pid}.stale`
      try { fs.renameSync(p.lock_file, aside) } catch { continue }
      if (pidIn(aside) !== pid) { try { fs.linkSync(aside, p.lock_file) } catch {} fs.rmSync(aside, { force: true }); return false }
      fs.rmSync(aside, { force: true })
    }
    return false
  } finally { fs.rmSync(mine, { force: true }) }
}

/** Give the lock back, if this process holds it. */
export function unlockSlot(p) {
  if (pidIn(p.lock_file) === process.pid) fs.rmSync(p.lock_file, { force: true })
}
