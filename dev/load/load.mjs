// load.mjs: the load generator. Founds a dedicated test room, adds agents and humans as real E2E members (real
// invites, check codes for humans), forks worker processes that send a realistic mix through shared/, and
// measures while it runs. Big runs go against a local hub (dev/load/hub-local.mjs, real hub code, server metrics
// every 5 s); runs against hub.trommi.com stay within its default limits and measure client-side only.
//
//   node dev/load/load.mjs --hub=local --total=100000 --agents=20 --humans=3 --out=<dir> [--phases=ramp,sustain,...]
//   node dev/load/load.mjs --hub=https://hub.trommi.com --total=20000 --agents=20 --humans=3 --out=<dir>
//
// Phases (in this order, any subset): ramp, sustain, burst, stall, catchup, paging, chatstrokes.
//   ramp       per-member rate steps until the ingest stops growing; records ingest and latency per step
//   sustain    a steady rate until --total envelopes are in the room
//   burst      max rate for 15 s, quiet 10 s, three times
//   stall      --stalled=1000 streams that never read, while the room keeps sending; hub memory must stay flat
//   catchup    a fresh human device joins and catches up the whole room (history key) with memory storage
//   paging     that fresh device pages a huge chat timeline 50 at a time, deep
//   chatstrokes  one session with 40 chat messages and 10,000 strokes: open its chat (one index hit, chat only)
//
// Latency: three stream observers (human devices, the core's transport) note the arrival of every live envelope;
// seal->delivered = arrival - signed header time (all senders run on this machine, one clock). A probe agent sends
// 2 messages/s with an empty outbox: probe = what a user feels under that load.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { fork } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { memoryStorage, joinRoom, z } from '../../shared/index.mjs'
import { HERE, NET, useTestKey, deleteTestRoom, arg, flag, sleep, until, pct, found, addAgent, addHuman, reopen, leanSender, trimWindows, startLocalHub, writeJson, readJsonl, text, rngOf, stroke, hex16 } from './lib.mjs'
import { guard } from '../guard.mjs'
guard({ usage: 'node dev/load/load.mjs --hub=local|URL --total=N --agents=N --humans=N --out=DIR [--phases=…]', values: ['agents', 'depth', 'every', 'hub', 'humans', 'out', 'pages', 'pens', 'phases', 'ramp', 'rate', 'stalled', 'stall-from', 'stall-ms', 'step-ms', 'streams-per-device', 'strokes', 'test-key', 'total', 'workers'], flags: ['keep-hub', 'keep-room'], targets: ['hub'] })


// undici (fetch over HTTP/2 to Cloudflare) can emit an unhandled 'error' on an idle stream (UND_ERR_INFO "socket
// idle timeout"); the core's transport reconnects by itself, so note it and go on. Anything else ends the process.
process.on('uncaughtException', e => {
  if (String(e?.code ?? '').startsWith('UND_ERR')) { console.error(`[e2e] ignored ${e.code}: ${e.message}`); return }
  console.error(e); process.exit(1)
})

const HUB = arg('hub', 'local')
const TOTAL = Number(arg('total', 100_000))
const AGENTS = Number(arg('agents', 20))
const HUMANS = Number(arg('humans', 3))
const WORKERS = Number(arg('workers', 6))
const STALLED = Number(arg('stalled', 1000))
const DEPTH = Number(arg('depth', 4))
const SUSTAIN_RATE = Number(arg('rate', 0))           // per member; 0 = max
const PHASES = arg('phases', 'ramp,sustain,burst,stall,catchup,paging,chatstrokes').split(',')
const OUT = path.resolve(arg('out', `/tmp/trommi-load-${Date.now()}`))
const IS_LOCAL = HUB === 'local'
const TEST_KEY = arg('test-key', null)
await useTestKey(TEST_KEY)
fs.mkdirSync(OUT, { recursive: true })
const log = (...a) => { const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(line); fs.appendFileSync(path.join(OUT, 'run.log'), line + '\n') }
const results = { hub: HUB, started_at: new Date().toISOString(), config: { TOTAL, AGENTS, HUMANS, WORKERS, STALLED, DEPTH, PHASES }, phases: {} }
const save = () => writeJson(path.join(OUT, 'results.json'), results)

// ---- hub -------------------------------------------------------------------------------------------
let localHub = null, hubUrl = HUB
if (IS_LOCAL) {
  localHub = await startLocalHub({ data: path.join(OUT, 'hub'), metrics: path.join(OUT, 'hub-metrics.jsonl'), every: Number(arg('every', 5000)) })
  hubUrl = localHub.hub_url
  log(`local hub ${hubUrl} pid ${localHub.pid}`)
}
const lastMetric = () => readJsonl(path.join(OUT, 'hub-metrics.jsonl')).at(-1) ?? null

// ---- room and members -----------------------------------------------------------------------------
const membersDir = path.join(OUT, 'members')
const t0 = performance.now()
const { client: phone } = await found({ hub_url: hubUrl, dir: membersDir })
const room_id = phone.model.room.room_id
log(`room ${room_id.slice(0, 12)} founded`)
const roster = [{ dir: path.join(membersDir, 'phone'), role: 'human', name: 'Load phone' }]
const joined = []
for (let i = 0; i < AGENTS; i++) {
  const dir = path.join(membersDir, `agent-${i}`)
  const { client } = await addAgent(phone, { dir, name: `agent-${i}`, label: `Agent ${i}` })
  joined.push(client); roster.push({ dir, role: 'agent', name: `agent-${i}` })
}
for (let i = 1; i < HUMANS; i++) {
  const dir = path.join(membersDir, `human-${i}`)
  const { client } = await addHuman(phone, { dir, name: `human-${i}` })
  joined.push(client); roster.push({ dir, role: 'human', name: `human-${i}` })
}
const { client: observer } = await addHuman(phone, { dir: path.join(membersDir, 'observer'), name: 'observer' })
const { client: probe } = await addAgent(phone, { dir: path.join(membersDir, 'probe'), name: 'probe', label: 'Probe' })
results.setup = { members: roster.length + 2, ms: Math.round(performance.now() - t0) }
log(`${roster.length + 2} members in ${results.setup.ms} ms`)
await phone.settle({ timeout_ms: 60_000 }).catch(() => {})
await phone.stop()
for (const c of joined) await c.stop()
const desk_id = hex16()

// ---- observers and probe ----------------------------------------------------------------------------
let lat = [], probeLat = [], perSecond = new Map(), arrivals = 0, liveCursor = 0
await observer.start({ stream: false })
const obsStreams = []
function observe(n = 3) {
  const from = observer.model.room.last_envelope_number
  for (let i = 0; i < n; i++) {
    let cursor = from
    obsStreams.push(observer.hub.stream({
      after_envelope_number: () => cursor,
      onEvent: ({ event, data }) => {
        if (event !== 'envelope') return
        cursor = Math.max(cursor, data.envelope_number)
        if (i !== 0) return
        liveCursor = cursor
        const at = Date.now()
        const h = z.peekEnvelope(z.unb64u(data.envelope)).header
        const ms = at - Number(h.time)
        lat.push(ms); arrivals++
        const sec = Math.floor(at / 1000)
        const b = perSecond.get(sec) ?? { n: 0, lat: [] }; b.n++; if (b.lat.length < 2000) b.lat.push(ms); perSecond.set(sec, b)
        if (z.hex(h.sender) === probe.my_device_id) probeLat.push(ms)
      },
    }))
  }
}
await probe.start({ stream: false })
leanSender(probe)
let probing = false
async function probeLoop() {
  while (probing) {
    if (!probe.outbox.length) await probe.sendMessage({ text: `probe ${Date.now()}` }).catch(() => {})
    await sleep(500)
  }
}

// ---- workers ----------------------------------------------------------------------------------------
const workers = []
const nW = Math.min(WORKERS, roster.length)
for (let w = 0; w < nW; w++) {
  const members = roster.filter((_, i) => i % nW === w)
  const p = fork(path.join(HERE, 'worker.mjs'), [JSON.stringify({ members, desk_id, seed: 1000 + w, test_key: TEST_KEY })], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
  const st = { p, tick: null, ready: false, stopped: false }
  p.on('message', m => { if (m.type === 'ready') st.ready = true; else if (m.type === 'tick') st.tick = m; else if (m.type === 'stopped') st.stopped = true })
  workers.push(st)
}
await until(() => workers.every(w => w.ready), 'workers ready', 120_000)
log(`${nW} workers ready`)
const totals = () => workers.reduce((a, w) => { const t = w.tick ?? { sent: 0, acked: 0, failed: 0, outbox: 0, rss_mb: 0 }; a.sent += t.sent; a.acked += t.acked; a.failed += t.failed; a.outbox += t.outbox; a.rss_mb += t.rss_mb; return a }, { sent: 0, acked: 0, failed: 0, outbox: 0, rss_mb: 0 })
const byAction = () => { const o = {}; for (const w of workers) for (const [k, v] of Object.entries(w.tick?.by_action ?? {})) o[k] = (o[k] ?? 0) + v; return o }
const errors = () => { const o = {}; for (const w of workers) for (const [k, v] of Object.entries(w.tick?.errors ?? {})) o[k] = (o[k] ?? 0) + v; return o }
const tell = msg => { for (const w of workers) w.p.send(msg) }

// the timeline of the run, one row per second
const timeline = []
let phaseName = 'setup'
let prevAcked = 0
const rowTimer = setInterval(() => {
  const t = totals(), sec = Math.floor(Date.now() / 1000) - 1, b = perSecond.get(sec)
  perSecond.delete(sec - 5)
  const m = IS_LOCAL ? lastMetric() : null
  const posts = workers.map(w => w.tick?.post).filter(Boolean)
  timeline.push({ at: Date.now(), phase: phaseName, post_p50: posts.length ? Math.max(...posts.map(p => p.p50)) : null, post_p99: posts.length ? Math.max(...posts.map(p => p.p99)) : null, acked: t.acked, acked_per_s: t.acked - prevAcked, outbox: t.outbox, workers_rss_mb: t.rss_mb, delivered_per_s: b?.n ?? 0,
    lat_p50: b ? pct(b.lat).p50 : null, lat_p99: b ? pct(b.lat).p99 : null, hub_cpu: m?.cpu_percent ?? null, hub_rss_mb: m?.rss_mb ?? null, hub_heap_mb: m?.heap_used_mb ?? null, db_mb: m?.db_mb ?? null, socket_queued_mb: m?.socket_queued_mb ?? null })
  prevAcked = t.acked
}, 1000)
const saveTimeline = () => fs.writeFileSync(path.join(OUT, 'timeline.jsonl'), timeline.map(r => JSON.stringify(r)).join('\n') + '\n')

/** Run the workers at a rate for a time (or until the room holds `untilAcked`), measure that window. */
async function window(name, { rate, ms = Infinity, untilAcked = Infinity, depth = DEPTH }) {
  phaseName = name
  lat = []; probeLat = []
  const a0 = totals().acked, t = performance.now()
  tell({ type: 'run', rate, depth })
  while (performance.now() - t < ms && totals().acked < untilAcked) {
    await sleep(500)
    if (!IS_LOCAL) {
      const recent = probeLat.slice(-6)
      if (recent.length >= 6 && Math.min(...recent) > 3000) { tell({ type: 'pause' }); throw new Error(`watchdog: probe latency over 3 s for 3 s (${recent.join(', ')} ms): the hub degrades, run stopped`) }
    }
    if (Math.round(performance.now() - t) % 30000 < 500) { saveTimeline(); log(`${name}: ${totals().acked} acked, ${Math.round((totals().acked - a0) / ((performance.now() - t) / 1000))}/s, outbox ${totals().outbox}, errors ${JSON.stringify(errors())}`) }
  }
  tell({ type: 'pause' })
  const secs = (performance.now() - t) / 1000, acked = totals().acked - a0
  await sleep(1500)    // let the last envelopes arrive at the observers
  const r = { rate_per_member: rate, seconds: +secs.toFixed(1), acked, ingest_per_s: Math.round(acked / secs), seal_to_delivered_ms: pct(lat), probe_ms: pct(probeLat), hub: IS_LOCAL ? lastMetric() : null }
  log(`${name}: ${acked} in ${secs.toFixed(0)} s = ${r.ingest_per_s}/s; delivered p50 ${r.seal_to_delivered_ms.p50} p99 ${r.seal_to_delivered_ms.p99} ms; probe p50 ${r.probe_ms.p50} p99 ${r.probe_ms.p99}`)
  return r
}

observe(3)
probing = true
probeLoop()

// ---- phases -----------------------------------------------------------------------------------------
try {
  if (PHASES.includes('ramp')) {
    const steps = (arg('ramp', IS_LOCAL ? '2,5,10,20,40,0' : '1,2,5,10,0')).split(',').map(Number)
    const out = []
    for (const rate of steps) out.push(await window(`ramp ${rate || 'max'}`, { rate, ms: Number(arg('step-ms', 30_000)) }))
    results.phases.ramp = out
    save()
  }
  if (PHASES.includes('sustain')) {
    results.phases.sustain = await window('sustain', { rate: SUSTAIN_RATE, untilAcked: TOTAL })
    save()
  }
  if (PHASES.includes('burst')) {
    const out = []
    for (let i = 0; i < 3; i++) {
      out.push(await window(`burst ${i + 1}`, { rate: 0, ms: 15_000, depth: DEPTH * 4 }))
      phaseName = 'quiet'; await sleep(10_000)
    }
    results.phases.burst = out
    save()
  }
  if (PHASES.includes('stall') && STALLED > 0) results.phases.stall = await stallPhase(), save()
  let fresh = null
  if (PHASES.includes('catchup')) { const r = await catchupPhase(); fresh = r.client; results.phases.catchup = r.result; save() }
  if (PHASES.includes('paging')) { results.phases.paging = await pagingPhase(fresh); save() }
  if (PHASES.includes('chatstrokes')) { results.phases.chatstrokes = await chatStrokesPhase(); save() }
} catch (e) {
  log(`FAILED: ${e.stack}`)
  results.error = String(e.stack)
} finally {
  probing = false
  tell({ type: 'stop' })
  await until(() => workers.every(w => w.stopped), 'workers stopped', 120_000).catch(() => {})
  for (const s of obsStreams) s.close()
  clearInterval(rowTimer)
  saveTimeline()
  results.totals = { ...totals(), by_action: byAction(), errors: errors(), room_envelopes: observer.model.room.last_envelope_number }
  if (IS_LOCAL) {
    const ms = readJsonl(path.join(OUT, 'hub-metrics.jsonl'))
    results.hub_metrics = { samples: ms.length, rss_mb_max: Math.max(...ms.map(m => m.rss_mb)), heap_used_mb_max: Math.max(...ms.map(m => m.heap_used_mb)), cpu_percent_max: Math.max(...ms.map(m => m.cpu_percent)), db_mb_end: ms.at(-1)?.db_mb, loop_max_ms: Math.max(...ms.map(m => m.loop_max_ms)) }
  }
  if (TEST_KEY && !flag('keep-room')) { results.deleted = await deleteTestRoom(hubUrl, room_id).catch(e => ({ error: e.message })); log(`test room deleted: ${JSON.stringify(results.deleted)}`) }
  results.finished_at = new Date().toISOString()
  save()
  log(`done: ${JSON.stringify(results.totals)}`)
  if (localHub && !flag('keep-hub')) await localHub.stop()
  process.exit(0)
}

// ---- phase bodies ---------------------------------------------------------------------------------

/** N streams that read nothing: raw HTTP requests paused after the headers, while the room keeps sending. */
async function stallPhase() {
  log(`stall: opening ${STALLED} stalled streams`)
  const perDevice = Number(arg('streams-per-device', IS_LOCAL ? 1e6 : 8))
  const tokens = [await observer.hub.authHeader()]
  for (let i = 0; i < Math.ceil(STALLED / perDevice) - 1; i++) {
    const { client } = await addAgent(observer, { dir: path.join(membersDir, `staller-${i}`), name: `staller-${i}` })
    await client.hub.signIn()
    tokens.push(await client.hub.authHeader())
  }
  const u = new URL(observer.hub.url(observer.hub.roomPath('/stream')))
  const lib = u.protocol === 'https:' ? https : http
  const agent = new lib.Agent({ keepAlive: false, maxSockets: Infinity })
  const reqs = []
  let opened = 0, refused = {}
  for (let i = 0; i < STALLED; i++) {
    // --stall-from=live (default): listeners that were up to date and then stop reading; zero: each starts a catch-up of the whole room
    const pathq = `${u.pathname}?after_envelope_number=${arg('stall-from', 'live') === 'zero' ? 0 : liveCursor}`
    const headers = { authorization: tokens[Math.floor(i / perDevice)], accept: 'text/event-stream', 'trommi-client': 'connector/0.9.0-loadgen', 'trommi-protocol': '1' }
    if (NET.sign) headers['x-test-signature'] = NET.sign('GET', `${u.origin}${pathq}`)
    const req = lib.request({ host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: pathq, headers, agent })
    req.on('response', res => { if (res.statusCode === 200) { opened++; res.pause(); res.socket.setNoDelay(true) } else { refused[res.statusCode] = (refused[res.statusCode] ?? 0) + 1; res.resume() } })
    req.on('error', () => {})
    req.end()
    reqs.push(req)
    if (i % 50 === 49) await sleep(50)
  }
  await sleep(3000)
  log(`stall: ${opened} open, refused ${JSON.stringify(refused)}`)
  const before = IS_LOCAL ? lastMetric() : null
  const r = await window('stall', { rate: SUSTAIN_RATE, ms: Number(arg('stall-ms', 120_000)) })
  const after = IS_LOCAL ? lastMetric() : null
  for (const q of reqs) q.destroy()
  agent.destroy()
  await sleep(6000)
  return { ...r, stalled_open: opened, refused, hub_before: before, hub_after: after, hub_after_close: IS_LOCAL ? lastMetric() : null }
}

/** A fresh human device joins (check code) and catches up the whole room from envelope 0 with memory storage. */
async function catchupPhase() {
  phaseName = 'catchup'
  const p = observer      // the inviter: a human device of this process (the others' chains live in the workers)
  await p.catchUp()
  const storage = memoryStorage({ extractable_keys: false })
  const inv = await p.createInvite({ device_role: 'human' })
  const j = joinRoom({ link: inv.link, storage, device_name: 'fresh', poll_ms: 100, fetch: NET.fetch })
  const code = await j.check_code
  await until(() => p.model.invites.get(inv.invite_id)?.invite_state === 'confirm_code', 'code')
  await p.confirmInvite(inv.invite_id, p.model.invites.get(inv.invite_id).check_code === code)
  const c = await j.client
  const rss0 = process.memoryUsage().rss
  const t = performance.now()
  await c.start({ stream: false })
  const ms = performance.now() - t
  const n = c.model.room.last_envelope_number
  const result = { envelopes: n, ms: Math.round(ms), per_s: Math.round(n / ms * 1000), verified: c.stats?.verified, decrypted: c.stats?.decrypted, verify_ms: Math.round(c.stats?.verify_ms ?? 0),
    rss_growth_mb: Math.round((process.memoryUsage().rss - rss0) / 1048576), cards: c.model.cards.size, open_cards: c.model.stack.length, timelines: c.model.timelines.size }
  log(`catchup: ${n} envelopes in ${result.ms} ms = ${result.per_s}/s (processing ${result.verify_ms} ms), +${result.rss_growth_mb} MB`)
  return { client: c, result }
}

/** Page the biggest chat timeline 50 at a time, newest first, deep; then one windowed read at the very bottom. */
async function pagingPhase(c) {
  phaseName = 'paging'
  if (!c) { c = observer; await c.catchUp() }
  const chats = [...c.model.timelines.values()].filter(t => t.timeline_kind === 'chat').sort((a, b) => b.item_count - a.item_count)
  const t = chats[0]
  const pages = Number(arg('pages', 40))
  const times = []
  for (let i = 0; i < pages; i++) {
    const s = performance.now()
    const r = await c.loadTimeline(t.timeline_key, { limit: 50 })
    times.push(performance.now() - s)
    trimWindows(c, 200)
    if (!r.has_more) break
  }
  const s = performance.now()
  const deep = await c.timelineWindow(t.timeline_key, { before_envelope_number: 1 + Math.min(...[...(await c.hub.threads({ timeline_kind: 'chat', timeline_id: t.timeline_id, after_envelope_number: 0, limit: 60 })).envelopes.map(e => e.envelope_number)].slice(50, 51)), limit: 50 })
  const deepMs = performance.now() - s
  const result = { timeline_items: t.item_count, pages: times.length, page_ms: pct(times), deep_window_ms: Math.round(deepMs), deep_items: deep.length }
  log(`paging: ${t.item_count} items, ${times.length} pages p50 ${result.page_ms.p50} p95 ${result.page_ms.p95} ms; deepest window ${result.deep_window_ms} ms`)
  return result
}

/** One session: 40 chat messages and 10,000 strokes on its canvas; then open its chat. */
async function chatStrokesPhase() {
  phaseName = 'chatstrokes'
  await observer.catchUp()
  const { client: a } = await addAgent(observer, { dir: path.join(membersDir, 'painter'), name: 'painter', label: 'Painter' })   // a new session
  leanSender(a)
  await a.start({ stream: false })
  const rng = rngOf(7)
  const N = Number(arg('strokes', 10_000))
  // the strokes come from the agent and from --pens human devices (a canvas of a session takes both), interleaved with 40 chat messages
  const pens = [a]
  for (let i = 0; i < Number(arg('pens', 8)); i++) {
    const { client } = await addHuman(observer, { dir: path.join(membersDir, `pen-${i}`), name: `pen-${i}` })
    leanSender(client); await client.start({ stream: false }); pens.push(client)
  }
  const t = performance.now()
  let sent = 0
  const every = Math.floor((N + 40) / 40)
  await Promise.all(pens.map(async (p, k) => {
    while (sent < N + 40) {
      const i = sent++
      while (p.outbox.length > 8) await sleep(1)
      if (i % every === 0 && i / every < 40) await a.sendMessage({ text: `chat ${i}: ${text(rng)}` })
      else await p.sendStrokes({ timeline_id: `session/${a.session_id}`, strokes: [stroke(rng)] })
    }
  }))
  await until(() => pens.every(p => !p.outbox.length), 'pen outboxes empty', 1_800_000)
  for (const p of pens.slice(1)) await p.stop()
  const sendS = (performance.now() - t) / 1000
  // a read of this session's chat by a human device
  const h = observer
  await h.catchUp()
  const key = `chat:session/${a.session_id}`
  const tl = h.model.timelines.get(key)
  const canvas = h.model.timelines.get(`scribble:session/${a.session_id}`)
  const times = []
  let items = 0, kinds = new Set()
  for (let i = 0; i < 5; i++) {
    tl.items.clear(); tl.loaded_down_to = Infinity; tl.has_more = true
    const s = performance.now()
    const res = await h.hub.threads({ timeline_kind: 'chat', timeline_id: `session/${a.session_id}`, limit: 50 })
    times.push(performance.now() - s)
    items = res.envelopes.length
    for (const e of res.envelopes) kinds.add(z.peekEnvelope(z.unb64u(e.envelope)).header.timelineKind)
  }
  const s = performance.now()
  const loaded = await h.loadTimeline(key, { limit: 50 })
  const openMs = performance.now() - s
  let plan = null
  if (IS_LOCAL) {
    const db = new DatabaseSync(path.join(OUT, 'hub', 'hub.db'), { readOnly: true })
    plan = db.prepare(`EXPLAIN QUERY PLAN SELECT envelope_number FROM envelopes WHERE room_id = ? AND timeline_kind = 1 AND timeline_id = ? AND envelope_number < ? ORDER BY envelope_number DESC LIMIT 50`).all(room_id, `session/${a.session_id}`, 1e12).map(r => r.detail)
    db.close()
  }
  const result = { strokes: N, chat: 40, send_seconds: +sendS.toFixed(1), chat_items_counted: tl?.item_count, canvas_items_counted: canvas?.item_count, threads_request_ms: pct(times), items_returned: items, timeline_kinds_returned: [...kinds], open_chat_ms: Math.round(openMs), loaded: loaded.loaded, query_plan: plan }
  log(`chatstrokes: chat ${tl?.item_count} / canvas ${canvas?.item_count}; GET threads p50 ${result.threads_request_ms.p50} ms, ${items} items, kinds ${[...kinds]}; open chat ${result.open_chat_ms} ms; plan ${JSON.stringify(plan)}`)
  return result
}
