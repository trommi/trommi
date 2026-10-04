// channel-lock.mjs: one process per agent key slot (README R4), for connector/channel.mjs.
//
// Node has no flock. Each process that wants a slot writes a claim file of its own, `<lock>.<pid>`. Nobody else
// ever writes or renames it. Then it looks at all claims of the slot:
//   - A claim whose pid is gone is stale. Anyone may delete it, and that never touches a live claim.
//   - If another live claim is there, this process withdraws its own and the slot is busy.
// So at most one process can win. Suppose A and B both claim. Whichever looks second sees the other's claim,
// because each one writes before it looks, so both cannot see only themselves. If both look at the same time,
// both withdraw and retry after a random pause. There is no take-over step, so the take-over race of a single
// shared lock file cannot happen.
import fs from 'node:fs'
import path from 'node:path'

const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const claimsOf = p => {
  const base = `${path.basename(p.lock_file)}.`
  try { return fs.readdirSync(p.dir).filter(f => f.startsWith(base) && /^\d+$/.test(f.slice(base.length))).map(f => Number(f.slice(base.length))) } catch { return [] }
}
const claimFile = (p, pid = process.pid) => `${p.lock_file}.${pid}`

/** Take the slot ({ dir, lock_file }); true if this process holds it now. */
export function lockSlot(p) {
  fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < 8; attempt++) {
    fs.writeFileSync(claimFile(p), '', { mode: 0o600 })
    let others = false
    for (const pid of claimsOf(p)) {
      if (pid === process.pid) continue
      if (alive(pid)) others = true
      else fs.rmSync(claimFile(p, pid), { force: true })
    }
    if (!others) return true
    fs.rmSync(claimFile(p), { force: true })
    pause(5 + Math.random() * 40)   // a holder stays and we end busy; two newcomers drift apart and one wins
  }
  return false
}

/** Give the slot back. */
export function unlockSlot(p) { fs.rmSync(claimFile(p), { force: true }) }
