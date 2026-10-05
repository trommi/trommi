// channel-lock.mjs: one process per agent key slot (README R4), for connector/channel.mjs.
//
// Node has no flock. Each process that wants a slot writes a claim file of its own, `<lock>.<pid>`. Nobody else
// ever writes or renames it. Then it looks at all claims of the slot:
//   - A claim whose pid is gone is stale. Anyone may delete it, and that never touches a live claim.
//   - If another live claim is there, this process withdraws its own and the slot is busy.
// So at most one process can win. Suppose A and B both claim. Whichever looks second sees the other's claim,
// because each one writes before it looks, so both cannot see only themselves. If both look at the same time,
// both withdraw and retry after a random pause.
//
// A claim file holds the claimer's session key (connector/channel.mjs: the parent pid, i.e. the Claude Code session
// that started it). claimSlot() takes a slot over from a live claim of the SAME session: that is a reconnect
// (/mcp -> Reconnect), where Claude Code starts the new connector before the old one is gone. The old one is asked to
// stop (SIGTERM, only when its command line shows a Trommi connector) and given a few seconds; then its claim is
// removed either way. The hub's lease fences the old process if it still runs. Claims of other sessions are never
// taken over: two Claude sessions in one folder stay two slots.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

export const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const claimsOf = p => {
  const base = `${path.basename(p.lock_file)}.`
  try { return fs.readdirSync(p.dir).filter(f => f.startsWith(base) && /^\d+$/.test(f.slice(base.length))).map(f => Number(f.slice(base.length))) } catch { return [] }
}
const claimFile = (p, pid = process.pid) => `${p.lock_file}.${pid}`
const sessionOf = (p, pid) => { try { return fs.readFileSync(claimFile(p, pid), 'utf8').trim() } catch { return '' } }
const argsOf = pid => {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0') } catch {}
  try { return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim().split(/\s+/) } catch { return [] }
}
// A Trommi connector: node with connector/channel.mjs, hub/channel.mjs (the old path) or the bundle connector.mjs.
const isConnector = pid => argsOf(pid).slice(0, 3).some(a => /(^|[\\/])(channel|connector)\.mjs$/.test(a))

/** Take the slot ({ dir, lock_file }); true if this process holds it now. `session` is written into the claim. */
export function lockSlot(p, session = '') {
  fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < 8; attempt++) {
    fs.writeFileSync(claimFile(p), session, { mode: 0o600 })
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

/** The live processes that hold the slot, other than this one. */
export const holdersOf = p => claimsOf(p).filter(pid => pid !== process.pid && alive(pid))

/**
 * lockSlot, plus the take-over of a reconnect: live claims of the same `session` are asked to stop, waited for up to
 * `wait_ms`, then removed. Resolves { ok, holders } (holders: the live pids that keep the slot busy).
 */
export async function claimSlot(p, { session = '', wait_ms = 4000 } = {}) {
  if (lockSlot(p, session)) return { ok: true, holders: [] }
  const holders = holdersOf(p)
  if (!session || !holders.length || holders.some(pid => sessionOf(p, pid) !== session)) return { ok: false, holders }
  for (const pid of holders) if (isConnector(pid)) { try { process.kill(pid, 'SIGTERM') } catch {} }
  const until = Date.now() + wait_ms
  while (holders.some(alive) && Date.now() < until) await sleep(100)
  for (const pid of holders) if (sessionOf(p, pid) === session) fs.rmSync(claimFile(p, pid), { force: true })
  return lockSlot(p, session) ? { ok: true, holders: [], took_over: holders } : { ok: false, holders: holdersOf(p) }
}

/** Give the slot back. */
export function unlockSlot(p) { fs.rmSync(claimFile(p), { force: true }) }

// ---- the slot's door: a local socket of the process that holds a keyed slot ----------------------------------
//
// `channel.mjs say` (the emergency side channel) must not open a key that a running connector holds: two processes
// sealing with one key would sign the same sender sequence twice. So it asks the holder instead, over a Unix socket
// in a directory only this user can enter ($XDG_RUNTIME_DIR or the temp dir, /trommi-<uid>, mode 0700). The socket is
// named by a hash of the key file (a socket path has at most ~100 characters). One JSON line in, one JSON line out.
function doorDir() {
  const uid = process.getuid?.() ?? 0
  const dir = path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), `trommi-${uid}`)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const st = fs.lstatSync(dir)
  if (!st.isDirectory() || (process.getuid && st.uid !== uid) || (st.mode & 0o077)) throw new Error(`${dir} is not a private directory of this user`)
  return dir
}
export const doorOf = p => path.join(doorDir(), `${crypto.createHash('sha256').update(path.resolve(p.key_file)).digest('hex').slice(0, 20)}.sock`)

/**
 * Open the door of a slot this process holds: handler(request, gone) -> answer object. `gone` resolves when the
 * caller hung up before the answer (a hook that waited for the human and was ended). Returns close().
 */
export function openDoor(p, handler, log = () => {}) {
  const file = doorOf(p)
  fs.rmSync(file, { force: true })   // this process holds the slot, so a socket file there is a dead holder's
  const server = net.createServer(sock => {
    let buf = '', asked = false
    const gone = new Promise(resolve => sock.on('close', resolve))
    sock.setEncoding('utf8')
    sock.on('error', () => {})
    sock.on('data', async d => {
      if (asked) return
      buf += d
      if (buf.length > 64 * 1024) return sock.destroy()
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      asked = true
      let answer
      try { answer = await handler(JSON.parse(buf.slice(0, nl)), gone) } catch (err) { answer = { ok: false, error: err.message } }
      if (!sock.destroyed) sock.end(JSON.stringify(answer) + '\n')
    })
  })
  server.on('error', err => log(`door not open: ${err.message}`))
  server.listen(file, () => { try { fs.chmodSync(file, 0o600) } catch {} })
  server.unref()
  return () => { server.close(); fs.rmSync(file, { force: true }) }
}

/** Knock at a slot's door: resolves the holder's answer, or rejects (no door, no answer within timeout_ms). */
export function knock(p, request, timeout_ms = 30000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(doorOf(p))
    let buf = ''
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('the connector holding the key did not answer')) }, timeout_ms)
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(JSON.stringify(request) + '\n'))
    sock.on('data', d => { buf += d })
    sock.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(buf)) } catch { reject(new Error('the connector holding the key gave no answer')) } })
    sock.on('error', err => { clearTimeout(timer); reject(err) })
  })
}
