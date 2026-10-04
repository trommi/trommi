// lib.mjs: shared pieces of the load generator (dev/e2e). Every member is a real client/core client: real device
// keys, real invites, real sealed envelopes over HTTP. Only the storage is lean (see leanStorage) and senders keep
// their echo bookkeeping small (see leanSender), so one process can host many members for hours.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { foundRoom, openRoom, joinRoom, z } from '../../core/index.mjs'
import { fileStorage } from '../../core/storage-file.mjs'

export const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(HERE, '../..')
export const sleep = ms => new Promise(r => setTimeout(r, ms))
export const arg = (name, def) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : def }
export const flag = name => process.argv.includes(`--${name}`)

export async function until(fn, msg, ms = 30_000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timeout: ${msg}`)
    await sleep(20)
  }
}

/** Percentiles of an array of numbers (ms). */
export function pct(values, ps = [50, 95, 99]) {
  const a = Float64Array.from(values).sort()
  const out = { n: a.length }
  for (const p of ps) out[`p${p}`] = a.length ? +a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))].toFixed(1) : null
  out.max = a.length ? +a[a.length - 1].toFixed(1) : null
  return out
}

/**
 * The file adapter of client/core (same key file, same state.json), but: thread-item records (`tl/…`) are dropped
 * (a load member never scrolls back) and state.json is written only on flush(). Device keys stay in a 0600 file.
 */
export async function leanStorage(dir, { persist = false } = {}) {
  const st = await fileStorage({ dir, write_delay_ms: persist ? 200 : 1e9 })
  const keep = k => !k.startsWith('tl/')
  const set = st.set.bind(st), setMany = st.setMany.bind(st)
  st.set = async (k, v) => (keep(k) ? set(k, v) : undefined)
  st.setMany = async entries => setMany(entries.filter(([k]) => keep(k)))
  return st
}

/**
 * A sender that does not keep a live stream (most load members): its own envelopes never come back through sync,
 * so once the hub confirmed one, drop the echo bookkeeping that would otherwise wait for it forever.
 */
export function leanSender(c) {
  const acked = c._acked.bind(c)
  c._acked = item => {
    acked(item)
    c.byHash.delete(item.hash)
    c.sentContent.delete(item.hash)
    c.echoes.delete(item.local_id)
    const k = item.public.timeline_key
    if (k) c.model.timelines.get(k)?.items.delete(item.local_id)
    c.onAcked?.(item)
  }
  return c
}

/**
 * A sender without sync never sees its own card come back, and sendMessage({ object_id }) looks the card up in the
 * model. Put the minimum the core reads there (who owns it, which session key): what sync would have put there.
 */
export function rememberOwnCard(c, object_id) {
  if (!c.model.cards.has(object_id)) c.model.cards.set(object_id, { object_id, agent_device_id: c.my_device_id, session_id: c.session_id, object_state: 'open', object_version: 0, stub: true })   // version 0: the agent's own local head (what it sent) stays newer
}

/** Keep the in-memory timeline windows small on long-running members (the core keeps every live item it saw). */
export function trimWindows(c, keep = 0) {
  let dropped = 0
  for (const t of c.model.timelines.values()) {
    if (t.items.size <= keep) continue
    const ks = [...t.items.keys()].filter(k => typeof k === 'number').sort((a, b) => a - b)
    for (const k of ks.slice(0, ks.length - keep)) { t.items.delete(k); dropped++ }
  }
  return dropped
}

/** Start dev/e2e/hub-local.mjs as its own process (so its CPU and memory are its own). */
export async function startLocalHub({ data, metrics, every = 5000, extra = [], detached = false }) {
  fs.mkdirSync(data, { recursive: true })
  const logFd = fs.openSync(path.join(data, 'hub.log'), 'a')
  const p = spawn(process.execPath, [path.join(HERE, 'hub-local.mjs'), `--data=${data}`, `--metrics=${metrics}`, `--every=${every}`, ...extra], { stdio: ['ignore', 'pipe', logFd], detached })
  if (detached) p.unref()
  const info = await new Promise((ok, bad) => {
    let buf = ''
    p.stdout.on('data', d => { buf += d; const nl = buf.indexOf('\n'); if (nl >= 0) { try { ok(JSON.parse(buf.slice(0, nl))) } catch (e) { bad(e) } } })
    p.once('exit', code => bad(new Error(`local hub exited with ${code}`)))
  })
  if (detached) p.stdout.destroy()
  return { ...info, proc: p, stop: () => new Promise(r => { p.once('exit', r); p.kill('SIGTERM') }) }
}

// ---- signed test requests (hub.trommi.com test rooms, hub/ops/test-rooms.mjs) ----------------------------
// With a test key every request is signed once (x-test-signature, 60 s, single use): the hub lifts its rate limits
// for it, and POST /v1/rooms founds a test room (deleted with a signed DELETE, or after 24 h). The key file never
// leaves the scratchpad and is never printed.
export const NET = { fetch: null, key: null, postMs: [] }
const CLIENT_HEADERS = { 'trommi-client': 'channel/0.9.0-loadgen', 'trommi-protocol': '1' }
export async function useTestKey(keyPath) {
  if (!keyPath) {   // no test key: only the client headers (the hub counts requests without them)
    NET.fetch = async (url, opts = {}) => {
      const t = performance.now()
      const res = await fetch(url, { ...opts, headers: { ...CLIENT_HEADERS, ...(opts.headers ?? {}) } })
      if ((opts.method ?? 'GET').toUpperCase() === 'POST' && String(url).endsWith('/envelopes')) { NET.postMs.push(performance.now() - t); if (NET.postMs.length > 20000) NET.postMs.splice(0, 10000) }
      return res
    }
    return
  }
  const { signTestRequest } = await import('../../hub/ops/test-rooms.mjs')
  NET.key = fs.readFileSync(keyPath, 'utf8')
  NET.sign = (method, url) => { const u = new URL(url); return signTestRequest(NET.key, method, u.pathname + u.search) }
  NET.fetch = async (url, opts = {}) => {
    const method = (opts.method ?? 'GET').toUpperCase()
    const headers = { ...CLIENT_HEADERS, ...(opts.headers ?? {}), 'x-test-signature': NET.sign(method, String(url)) }
    let body = opts.body
    if (method === 'POST' && new URL(String(url)).pathname === '/v1/rooms' && typeof body === 'string') body = JSON.stringify({ ...JSON.parse(body), test_room: true })
    const t = performance.now()
    const res = await fetch(url, { ...opts, headers, body })
    if (method === 'POST' && String(url).endsWith('/envelopes')) { NET.postMs.push(performance.now() - t); if (NET.postMs.length > 20000) NET.postMs.splice(0, 10000) }
    return res
  }
}
/** Delete a test room (signed DELETE). */
export async function deleteTestRoom(hub_url, room_id) {
  if (!NET.key) return { skipped: true }
  const url = `${hub_url.replace(/\/+$/, '')}/v1/rooms/${room_id}`
  const r = await fetch(url, { method: 'DELETE', headers: { ...CLIENT_HEADERS, 'x-test-signature': NET.sign('DELETE', url) } })
  return { status: r.status, body: await r.text() }
}

/** Found a room with one human device ("Phone") whose storage lives in dir/phone. */
export async function found({ hub_url, dir }) {
  const storage = await leanStorage(path.join(dir, 'phone'), { persist: true })
  const { client, recovery_code } = await foundRoom({ hub_url, storage, device_name: 'Load phone', fetch: NET.fetch })
  await client.start()
  return { client, recovery_code, storage }
}

/** Add an agent member through a real agent invite (no check code). */
export async function addAgent(inviter, { dir, name, label = null }) {
  const storage = await leanStorage(dir, { persist: true })
  const inv = await inviter.createInvite({ device_role: 'agent', label })
  const j = joinRoom({ link: inv.link, storage, device_name: name, device_info: { device_name: name, platform: 'node', folder: `~/git/${name}`, host: 'loadgen' }, poll_ms: 100, fetch: NET.fetch })
  const c = await j.client
  // v1.1 (R6): agents send under a session key; the inviter's core posts the grant once the agent joined
  if (!c.session_id) {
    await c.start({ stream: true })
    await Promise.race([c.whenSession(), sleep(30_000).then(() => { throw new Error(`no session grant for ${name}`) })])
    await c.stop()
  }
  return { client: c, storage }
}

/** Add a human member through a real human invite with the six-digit check code. */
export async function addHuman(inviter, { dir, name }) {
  const storage = await leanStorage(dir, { persist: true })
  const inv = await inviter.createInvite({ device_role: 'human' })
  const j = joinRoom({ link: inv.link, storage, device_name: name, poll_ms: 100, fetch: NET.fetch })
  const code = await j.check_code
  await until(() => inviter.model.invites.get(inv.invite_id)?.invite_state === 'confirm_code', 'inviter waits for the code')
  await inviter.confirmInvite(inv.invite_id, code)
  const c = await j.client
  return { client: c, storage }
}

export async function reopen(dir, { lean = true } = {}) {
  const storage = lean ? await leanStorage(dir) : await fileStorage({ dir, write_delay_ms: 1e9 })
  return { client: await openRoom({ storage, fetch: NET.fetch }), storage }
}

// ---- content -------------------------------------------------------------------------------------

const WORDS = 'der die das und ist nicht ein eine zu mit auf für von den im sich es Test Export Karte Frage Build Server Hub Client Antwort schneller langsamer heute morgen Datei Seite Modul Fehler Ursache Plan Schritt fertig läuft wartet prüft Liste Tabelle Bild'.split(' ')
export function text(rng, min = 4, max = 40) {
  const n = min + Math.floor(rng() * (max - min))
  const out = []
  for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(rng() * WORDS.length)])
  return out.join(' ')
}
export function rngOf(seed) {
  let s = seed >>> 0 || 1
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 }
}
/** A stroke in the README format: int16 big-endian deltas in 1/8 px, first point absolute, base64url. */
export function stroke(rng, n = 24) {
  const buf = new Uint8Array(n * 4)
  const dv = new DataView(buf.buffer)
  let x = Math.floor(rng() * 8000), y = Math.floor(rng() * 6000)
  for (let i = 0; i < n; i++) {
    const dx = i ? Math.floor(rng() * 80 - 40) : x, dy = i ? Math.floor(rng() * 80 - 40) : y
    dv.setInt16(i * 4, dx); dv.setInt16(i * 4 + 2, dy)
  }
  return { stroke_id: z.hex(crypto.getRandomValues(new Uint8Array(8))), points: z.b64u(buf), style: { tool: 'pen', color: '#222', size: 2 } }
}
export const hex16 = () => z.hex(crypto.getRandomValues(new Uint8Array(16)))

export function writeJson(file, obj) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj, null, 2)) }
export function readJsonl(file) { try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
