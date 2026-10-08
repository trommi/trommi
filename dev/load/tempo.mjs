// tempo.mjs: engine-level numbers of the JS core (shared/, what the web app runs) and the Swift core (TrommiClient,
// what the iPhone runs, through trommi-swift) against a seeded room (dev/load/huge-room.mjs): what one device fetches,
// verifies and decrypts for a cold start, a warm start, opening the huge session, scrolling back, and ONE new message.
//
//   node dev/load/tempo.mjs --room=<dir with huge.json> [--impl=js,swift] [--pages=20] [--out=<file.json>]
//
// Every byte the measured device moves goes through a counting proxy in front of the hub (the invite link is rewritten
// to it, so the device keeps the proxy as its hub): bytes and requests per step, by route. The seeded members talk to
// the hub directly. Swift: ios/TrommiCore/.build/debug/trommi-swift (or TROMMI_SWIFT_BIN).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { arg, sleep, until, reopen, writeJson, countingHub } from './lib.mjs'
import { joinRoom, openRoom, z } from '../../shared/index.mjs'
import { fileStorage } from '../../shared/storage-file.mjs'
import { startDriver, swiftAvailable, SWIFT_BIN } from '../interop/protocol.mjs'
import { guard } from '../guard.mjs'
guard({ usage: 'node dev/load/tempo.mjs --room=<dir with huge.json> [--impl=js,swift] [--pages=20] [--out=<file.json>] [--agent=agent-1]', values: ['room', 'impl', 'pages', 'out', 'agent'] })

const ROOM = path.resolve(arg('room', '.'))
const IMPLS = arg('impl', 'js,swift').split(',')
const PAGES = Number(arg('pages', 20))
const OUT = arg('out', path.join(ROOM, 'tempo.json'))
const info = JSON.parse(fs.readFileSync(path.join(ROOM, 'huge.json'), 'utf8'))
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'trommi-tempo-'))
const results = { room: { envelopes: info.envelopes, counts: info.counts }, at: new Date().toISOString(), js: {}, swift: {} }
const log = (...a) => console.log(...a)

const heapMb = () => +(process.memoryUsage().heapUsed / 1048576).toFixed(0)
const dirMb = d => { let n = 0; const walk = p => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const q = path.join(p, e.name); if (e.isDirectory()) walk(q); else n += fs.statSync(q).size } }; try { walk(d) } catch {} return +(n / 1048576).toFixed(1) }

const proxy = await countingHub(info, ROOM)
const JS = 'tempo-js', SWIFT = 'ios/0.1.0'
const { client: phone } = await reopen(info.phone_dir)
await phone.start()
await phone.catchUp()
// the big session's agent (agent-1); --agent=agent-N picks another one (a member directory whose chain halted)
const agentDir = path.join(path.dirname(info.phone_dir), arg('agent', 'agent-1'))
const { client: agent } = await reopen(agentDir)
await agent.start({ stream: false })
log(`room ${info.envelopes} envelopes; counting hub ${info.hub_url}`)
const snapT = performance.now()
await phone.writeSnapshot().catch(e => log('snapshot', e.message))
await phone.settle({ timeout_ms: 120_000 }).catch(() => {})
results.snapshot_write_ms = Math.round(performance.now() - snapT)
const sessionKey = `chat:session/${info.big_session}`

/** One message from the big session's agent; resolves when `seen()` says the device has it. */
async function oneMessage(seen, what = 'one message') {
  const t = performance.now()
  await agent.sendMessage({ text: `tempo ${what} ${Date.now()}` })
  await until(seen, `${what} arrives`, 60_000)
  return performance.now() - t
}
async function invite() {
  const inv = await phone.createInvite({ device_role: 'human' })
  return { inv, confirm: async code => { await until(() => phone.model.invites.get(inv.invite_id)?.invite_state === 'confirm_code', 'phone waits for the code', 60_000); await phone.confirmInvite(inv.invite_id, phone.model.invites.get(inv.invite_id).check_code === code) } }
}

// ---- JS core ----
async function measureJs() {
  const out = results.js
  const dir = path.join(WORK, 'js')
  // cold start: join (snapshot boot) -> live
  const { inv, confirm } = await invite()
  let m = await proxy.mark()
  const storage = await fileStorage({ dir })
  const j = joinRoom({ link: inv.link, storage, client: JS, device_name: 'tempo js', poll_ms: 100 })
  await confirm(await j.check_code)
  let c = await j.client
  let t = performance.now()
  await c.start({ stream: true })
  await until(() => c.model.room.connection === 'live', 'live', 600_000)
  out.cold = { ms: Math.round(performance.now() - t), ...(await proxy.since(m, JS)), verified: c.stats.verified, decrypted: c.stats.decrypted, snapshot: c.stats.snapshot ? { at: c.stats.snapshot.envelope_number, kb: Math.round(c.stats.snapshot.bytes / 1024) } : null, cards: c.model.cards.size, heap_mb: heapMb() }
  // background work a start leaves behind (F2: hand-backs settled from card conversations), measured on its own
  m = await proxy.mark(); t = performance.now(); let d0 = c.stats.decrypted
  await c._revisions
  out.cold_background = { ms: Math.round(performance.now() - t), ...(await proxy.since(m, JS)), decrypted: c.stats.decrypted - d0 }
  log('js cold', JSON.stringify(out.cold), 'background', JSON.stringify(out.cold_background))
  await c.flush()

  // one new message, live
  const s0 = { ...c.stats }
  m = await proxy.mark()
  const before = c.model.room.last_envelope_number
  out.one_message_live = { ms: Math.round(await oneMessage(() => c.model.room.last_envelope_number > before)), ...(await proxy.since(m, JS)), verified: c.stats.verified - s0.verified, decrypted: c.stats.decrypted - s0.decrypted }
  log('js one message live', JSON.stringify(out.one_message_live))

  // the huge session: first page, then scroll back
  const sd = c.stats.decrypted
  m = await proxy.mark(); t = performance.now()
  let r = await c.loadTimeline(sessionKey, { limit: 50 })
  out.open_huge_session = { ms: Math.round(performance.now() - t), loaded: r.loaded, ...(await proxy.since(m, JS)), decrypted: c.stats.decrypted - sd }
  const pages = []
  for (let i = 0; i < PAGES && r.has_more; i++) {
    const d0 = c.stats.decrypted; m = await proxy.mark(); t = performance.now()
    r = await c.loadTimeline(sessionKey, { limit: 50 })
    pages.push({ ms: performance.now() - t, kb: (await proxy.since(m, JS)).kb_in, decrypted: c.stats.decrypted - d0 })
  }
  out.scroll_back = { pages: pages.length, ms_per_page: +(pages.reduce((a, p) => a + p.ms, 0) / Math.max(1, pages.length)).toFixed(1), kb_per_page: +(pages.reduce((a, p) => a + p.kb, 0) / Math.max(1, pages.length)).toFixed(1), decrypted_per_page: +(pages.reduce((a, p) => a + p.decrypted, 0) / Math.max(1, pages.length)).toFixed(1), window_items: c.model.timelines.get(sessionKey)?.items.size, heap_mb: heapMb() }
  log('js open', JSON.stringify(out.open_huge_session), 'scroll', JSON.stringify(out.scroll_back))

  // one message while the session is open (the window holds it)
  const d1 = c.stats.decrypted
  m = await proxy.mark()
  const items = () => c.model.timelines.get(sessionKey)?.items.size ?? 0
  const n0 = items()
  out.one_message_open_session = { ms: Math.round(await oneMessage(() => items() > n0, 'open')), ...(await proxy.since(m, JS)), decrypted: c.stats.decrypted - d1 }
  log('js one message, session open', JSON.stringify(out.one_message_open_session))

  // answer a card
  const open = [...c.model.cards.values()].find(x => x.object_state === 'open' && x.options?.length)
  if (open) { m = await proxy.mark(); t = performance.now(); await c.answer({ object_id: open.object_id, choices: [open.options[0].key] }); await c.settle({ timeout_ms: 30_000 }); out.answer = { ms: Math.round(performance.now() - t), ...(await proxy.since(m, JS)) } }
  await c.flush(); await c.stop()
  out.storage_mb = dirMb(dir)

  // warm start, nothing new; then with one new message; then the huge session again from storage
  for (const label of ['warm_nothing_new', 'warm_one_new']) {
    if (label === 'warm_one_new') await agent.sendMessage({ text: `tempo while away ${Date.now()}` })
    m = await proxy.mark(); t = performance.now()
    c = await openRoom({ storage: await fileStorage({ dir }), client: JS })
    const openMs = performance.now() - t
    await c.start({ stream: false })
    const startMs = performance.now() - t
    await c._revisions
    out[label] = { ms: Math.round(startMs), with_background_ms: Math.round(performance.now() - t), open_ms: Math.round(openMs), ...(await proxy.since(m, JS)), verified: c.stats.verified, decrypted: c.stats.decrypted, heap_mb: heapMb() }
    log('js', label, JSON.stringify(out[label]))
    if (label === 'warm_one_new') {
      const d = c.stats.decrypted; m = await proxy.mark(); t = performance.now()
      r = await c.loadTimeline(sessionKey, { limit: 50 })
      out.reopen_huge_session_warm = { ms: Math.round(performance.now() - t), loaded: r.loaded, ...(await proxy.since(m, JS)), decrypted: c.stats.decrypted - d }
      log('js reopen huge session', JSON.stringify(out.reopen_huge_session_warm))
    }
    await c.flush(); await c.stop()
  }
}

// ---- Swift core (TrommiClient) ----
function runCli(args, home) {
  return new Promise((ok, bad) => {
    const t = performance.now()
    const p = spawn(SWIFT_BIN, [...args, '--home', home], { stdio: ['ignore', 'pipe', 'pipe'] })
    let o = '', e = ''
    p.stdout.on('data', d => { o += d }); p.stderr.on('data', d => { e += d })
    p.on('exit', code => (code === 0 ? ok({ ms: performance.now() - t, out: o }) : bad(new Error(`trommi-swift ${args[0]} ${code}: ${e.slice(-400)}`))))
  })
}
async function measureSwift() {
  const out = results.swift
  if (!swiftAvailable()) { out.skipped = `no ${SWIFT_BIN}`; return }
  const home = path.join(WORK, 'swift')
  const d = await startDriver('swift', { home, label: 'swift', timeout_ms: 1_800_000 })
  const { inv, confirm } = await invite()
  let m = await proxy.mark()
  const { check_code } = await d.call('join', { link: inv.link, name: 'tempo swift' })
  await confirm(check_code)
  let t = performance.now()
  await d.call('join_wait', { name: 'tempo swift' })      // join, sign in, the whole catch-up, then live
  out.cold = { ms: Math.round(performance.now() - t), ...(await proxy.since(m, SWIFT)) }
  log('swift cold', JSON.stringify(out.cold))
  await sleep(1500)
  // one new message, live: what the stream brings (bytes), then the cache rewrite it causes
  m = await proxy.mark()
  // what the store holds: every file under the room's folder (records/*.seg append-only, head.bin, grants.bin), size and mtime
  const files = () => {
    const out = new Map()
    const walk = d => { for (const x of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, x.name); if (x.isDirectory()) walk(f); else { const st = fs.statSync(f); out.set(f, { size: st.size, mtime: st.mtimeMs }) } } }
    try { walk(home) } catch {}
    return out
  }
  // bytes written between two looks: an append-only segment by what it grew, any other changed file whole
  const written = (a, b) => { let n = 0; for (const [f, x] of b) { const y = a.get(f); if (!y) n += x.size; else if (x.mtime > y.mtime) n += f.endsWith('.seg') ? Math.max(0, x.size - y.size) : x.size }; return n }
  const cache = () => { const m = files(); return m.size ? { size: [...m.values()].reduce((s, x) => s + x.size, 0), mtimeMs: Math.max(...[...m.values()].map(x => x.mtime)), files: m } : null }
  await sleep(2500)
  const c0 = cache()
  t = performance.now()
  await agent.sendMessage({ text: `tempo swift live ${Date.now()}` })
  await until(async () => (await proxy.since(m, SWIFT)).kb_in > 0, 'stream bytes', 30_000).catch(() => {})
  out.one_message_live = { ms_to_bytes: Math.round(performance.now() - t), ...(await proxy.since(m, SWIFT)) }
  await until(() => { const c1 = cache(); return c1 && c0 && c1.mtimeMs > c0.mtimeMs }, 'cache rewritten', 20_000).catch(() => {})
  const c1 = cache()
  out.one_message_live.cache_written_kb = c0 && c1 ? +(written(c0.files, c1.files) / 1024).toFixed(1) : null
  log('swift one message live', JSON.stringify(out.one_message_live))
  await d.stop()
  out.cache_mb = c1 ? +(c1.size / 1048576).toFixed(1) : null
  // warm: the CLI opens the room, restores the cache (decrypt + replay of every record), catches up
  for (const label of ['warm_nothing_new', 'warm_one_new']) {
    if (label === 'warm_one_new') await agent.sendMessage({ text: `tempo swift away ${Date.now()}` })
    m = await proxy.mark()
    const r = await runCli(['cards'], home)
    const line = /caught up: (\d+) envelopes verified \((\d+) opened/.exec(r.out)
    out[label] = { ms: Math.round(r.ms), ...(await proxy.since(m, SWIFT)), verified: line ? Number(line[1]) : null, opened: line ? Number(line[2]) : null }
    log('swift', label, JSON.stringify(out[label]))
  }
}

try {
  if (IMPLS.includes('js')) await measureJs()
  writeJson(OUT, results)
  if (IMPLS.includes('swift')) await measureSwift()
} catch (e) { console.error(e.stack); results.error = e.stack }
finally {
  writeJson(OUT, results)
  await agent.stop().catch(() => {}); await phone.stop().catch(() => {})
  log(`written ${OUT}`)
  process.exit(results.error ? 1 : 0)
}
