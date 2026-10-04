// A throwaway Turbo board for the parity verifier: its own hub (BOARD_HUB_ONLY) on its own port and data folder,
// three scripted demo agents (dev/fake-agent.mjs web, api, infra), every test card (server/fixtures.mjs) and one
// approval request from a linked session "Courier". Never the live board: port 8790 is refused.
//   node dev/verify/turbo-board.mjs [--port 8910] [--data DIR] [--keep SECONDS]
// Prints one JSON line {"ready":true,base,cookie,pid,...} when the board is populated, then keeps it running
// (default until killed). Writes <data>/../turbo-board.json with the same line (token included: the folder is a
// throwaway scratch folder, never commit it). Everything it started stops with it (dev/cdp.mjs guard()).
// As a module: const board = await startTurboBoard({ port, data }); ...; await board.stop()
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { guard } from '../cdp.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** A session linked over the agent API (as dev/session.mjs does it): { id, events, tool(name, args), permission(params), req }. */
export function linkSession({ base, token, name }) {
  const port = Number(new URL(base).port)
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const instance = crypto.createHash('sha256').update(`${id}|${token}`).digest('hex').slice(0, 16)
  const query = new URLSearchParams({ name, id, instance, cwd: ROOT, host: 'verify', platform: 'verify' })
  const events = []
  const req = http.get({ host: '127.0.0.1', port, path: `/agent/link?${query}`, headers: { 'x-board-token': token } }, res => {
    res.setEncoding('utf8'); let buf = ''
    res.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const f = buf.slice(0, i); buf = buf.slice(i + 2); if (f.startsWith('data: ')) { try { events.push({ at: Date.now(), ...JSON.parse(f.slice(6)) }) } catch {} } } })
  })
  req.on('error', () => {})
  const post = async (route, body) => {
    for (let i = 0; i < 50; i++) {
      const res = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-board-token': token }, body: JSON.stringify({ id, instance, ...body }) })
      const out = await res.json().catch(() => ({}))
      if (res.ok) return out
      if (!/not linked/.test(out.error ?? '')) throw new Error(`${name} ${route}: ${out.error}`)
      await sleep(100)
    }
    throw new Error(`${name} never got linked`)
  }
  return { id, events, req, close: () => req.destroy(), tool: async (tool, args = {}) => (await post('/agent/tool', { name: tool, args })).text ?? '', permission: params => post('/agent/permission', { params }) }
}

export async function startTurboBoard({ port = 8910, data, agents = ['web', 'api', 'infra'], fixtures = true, log = () => {} } = {}) {
  if (port === 8790) throw new Error('8790 is the live board; pick 8910-8919')
  if (!data) throw new Error('data folder needed')
  if (await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)) throw new Error(`port ${port} is taken by another process; pick another one (8910-8919)`)
  fs.rmSync(data, { recursive: true, force: true })
  fs.mkdirSync(data, { recursive: true })
  const token = crypto.randomBytes(12).toString('hex')
  const base = `http://127.0.0.1:${port}`
  const env = { ...process.env, BOARD_PORT: String(port), BOARD_HOST: '127.0.0.1', BOARD_DATA: data, BOARD_TOKEN: token, BOARD_HUB_ONLY: '1', BOARD_PASSKEYS: 'off', BOARD_PUSH: '0', BOARD_SNOOZE_TICK_MS: '1000' }
  delete env.BOARD_AGENT; delete env.BOARD_TURBO_BASE; delete env.TINFOIL_API_KEY
  const children = []
  const start = (name, args, e) => {
    const proc = spawn(process.execPath, args, { cwd: ROOT, env: e, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    guard(proc, { group: true })
    const child = { name, proc, log: '' }
    proc.stdout.on('data', c => { child.log += c }); proc.stderr.on('data', c => { child.log += c })
    children.push(child)
    return child
  }
  const hub = start('hub', [path.join(ROOT, 'server', 'server.mjs')], env)
  for (let i = 0; i < 150; i++) {
    if (hub.proc.exitCode != null) throw new Error(`hub stopped:\n${hub.log}`)
    if (await fetch(`${base}/`).then(r => r.status > 0, () => false)) break
    await sleep(100)
  }
  log(`hub up on ${base} (pid ${hub.proc.pid})`)
  const spokeEnv = { ...env }; delete spokeEnv.BOARD_HUB_ONLY
  for (const who of agents) {
    const a = start(`agent ${who}`, [path.join(ROOT, 'dev', 'fake-agent.mjs'), who], spokeEnv)
    for (let i = 0; i < 300 && !a.log.includes('is up'); i++) { if (a.proc.exitCode != null) break; await sleep(100) }
    log(`agent ${who}: ${a.log.includes('is up') ? 'up' : 'did not come up'}`)
  }
  const links = []
  const session = name => { const sess = linkSession({ base, token, name }); links.push(sess.req); return sess }
  const courier = session('Courier')
  let cards = []
  if (fixtures) {
    const res = await fetch(`${base}/dev/fixtures`, { method: 'POST', headers: { Cookie: `board=${token}`, Origin: base, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' })
    const out = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`fixtures: ${res.status} ${out.error ?? ''}`)
    cards = out.cards ?? []
    log(`fixtures: ${cards.length} cards on desk ${out.desk}`)
    await courier.tool('reply', { text: 'Ich bin **Courier**, die Sitzung des Prüfers. Gleich kommt eine Freigabe.' })
    await courier.permission({ request_id: 'verify1', tool_name: 'Bash', description: 'Run the test suite', input_preview: '{"command":"npm test -- --coverage"}' })
    await courier.tool('set_status', { id: 'verify', label: 'Prüfung', state: 'working', detail: 'Zustände werden fotografiert' })
  }
  await sleep(1500)
  const stop = async () => {
    for (const l of links) l.destroy()
    for (const { proc } of children) if (proc.exitCode == null) { try { process.kill(-proc.pid, 'SIGTERM') } catch {} }
    for (let i = 0; i < 30 && children.some(c => c.proc.exitCode == null); i++) await sleep(100)
    for (const { proc } of children) if (proc.exitCode == null) { try { process.kill(-proc.pid, 'SIGKILL') } catch {} }
  }
  return { base, token, cookie: { name: 'board', value: token }, pid: hub.proc.pid, data, cards, courier, session, stop, children }
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const arg = n => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null }
  const data = path.resolve(arg('data') ?? path.join(process.env.VERIFY_DIR ?? '/tmp/verify', 'turbo-data'))
  const board = await startTurboBoard({ port: Number(arg('port') ?? 8910), data, log: m => console.error(`[verify] ${m}`) })
  const line = JSON.stringify({ ready: true, base: board.base, cookie: `board=${board.token}`, pid: board.pid, runner: process.pid, data, cards: board.cards })
  fs.writeFileSync(path.join(path.dirname(data), 'turbo-board.json'), line + '\n', { mode: 0o600 })
  console.log(line)
  const keep = Number(arg('keep') ?? 0)
  const end = async () => { await board.stop(); process.exit(0) }
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, end)
  if (keep) setTimeout(end, keep * 1000)
  else setInterval(() => {}, 1 << 30)
}
