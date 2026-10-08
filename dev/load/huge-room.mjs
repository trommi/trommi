// huge-room.mjs: seed a huge, realistic demo room through shared/, as real members (real keys, invites, sealed
// envelopes over HTTP), for measuring what web and iOS load, verify and decrypt (README "Performance", dev/load/tempo.mjs):
//
//   44 agent sessions on 8 desks, with profiles and status lines; 6 human devices (phone, laptop, tablet, 3 more)
//   5,400 cards (5,000 answered, 400 open, every second one revised), snoozes, ducks, drafts on some
//   one session chat of 22,000 messages, every 6th with a picture (400 distinct encrypted PNGs), one card thread of
//   2,000, 20,000 more messages over the other sessions and cards
//   300 notes (a third edited), 120 published pages (agents), a Scribble Board of 20,000 strokes in the new stroke
//   format (shared/ink.mjs packPoints, colour tokens) on the main desk, 5,000 more on other desks and sessions
//
//   node dev/load/huge-room.mjs --hub=local|<url> --out=<dir> [--scale=1] [--keep-hub] [--seed=7]
//
// Deterministic content (seeded PRNG); ids and keys are random as in any room. Writes <out>/huge.json (hub url, room
// id, member dirs, the ids of the big timelines; the same shape as crazy.json, so app-perf.mjs and tempo.mjs read it).
// With --hub=local the hub keeps running (pid in huge.json) when --keep-hub is given.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { rememberOwnCard, arg, flag, sleep, until, found, addAgent, addHuman, leanSender, trimWindows, startLocalHub, writeJson, text, rngOf, hex16 } from './lib.mjs'
import { packPoints, PEN_COLORS, MARKER_COLORS } from '../../shared/scribble.mjs'
import { guard } from '../guard.mjs'
guard({ usage: 'node dev/load/huge-room.mjs --hub=local|<url> --out=<dir> [--scale=1] [--seed=7] [--keep-hub]', values: ['hub', 'out', 'scale', 'seed'], flags: ['keep-hub'], targets: ['hub'] })

const HUB = arg('hub', 'local')
const OUT = path.resolve(arg('out', `/tmp/trommi-huge-${Date.now()}`))
const S = Number(arg('scale', 1))
const N = {
  sessions: 44, desks: 8, humans: 6,
  answered: Math.round(5000 * S), open: Math.round(400 * S),
  bigSession: Math.round(22_000 * S), bigThread: Math.round(2000 * S), chat: Math.round(20_000 * S),
  pictures: Math.round(400 * S), pictureEvery: 6,
  notes: Math.round(300 * S), pages: Math.round(120 * S),
  bigBoard: Math.round(20_000 * S), strokes: Math.round(5000 * S),
}
fs.mkdirSync(OUT, { recursive: true })
const t0 = performance.now()
const log = (...a) => { const l = `[${((performance.now() - t0) / 1000).toFixed(0)} s] ${a.join(' ')}`; console.log(l); fs.appendFileSync(path.join(OUT, 'huge.log'), l + '\n') }
const rng = rngOf(Number(arg('seed', 7)))
const pick = a => a[Math.floor(rng() * a.length)]
/** The Scribble Board timeline of a desk, as the app derives it (app/web/public/whiteboard.mjs deskCanvas). */
function deskCanvas(desk) {
  const id = String(desk || 'main')
  if (/^[0-9a-f]{32}$/.test(id)) return `desk/${id}`
  const bytes = new TextEncoder().encode(id), out = new Uint8Array(16)
  bytes.forEach((v, i) => { out[i % 16] ^= v })
  out[15] ^= bytes.length & 0xff
  return `desk/${[...out].map(b => b.toString(16).padStart(2, '0')).join('')}`
}

// ---- content helpers ----
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = b => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
/** A real PNG (w x h, RGB): a diagonal gradient in a seeded hue, so every picture differs and decodes. */
function png(w, h) {
  const [r0, g0, b0] = [rng() * 255, rng() * 255, rng() * 255].map(Math.floor)
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (w * 3 + 1) + 1 + x * 3, t = (x + y) / (w + h)
    raw[o] = r0 * (1 - t) + 255 * t; raw[o + 1] = g0; raw[o + 2] = b0 * t
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
}
/** A stroke entry in the new format (README "Scribble strokes"): a wandering line of n points around (cx, cy). */
function inkEntry(n, cx, cy) {
  const pts = [], t = [], f = []
  let x = cx, y = cy, a = rng() * Math.PI * 2
  for (let i = 0; i < n; i++) { a += (rng() - 0.5) * 0.6; x += Math.cos(a) * 6; y += Math.sin(a) * 6; pts.push(x, y); t.push(i * 8); f.push(0.3 + rng() * 0.5) }
  const marker = rng() < 0.15
  return { tool: marker ? 'marker' : 'pen', color: marker ? pick(MARKER_COLORS) : pick(PEN_COLORS), width: marker ? 18 : 4, points: packPoints({ pts, t, f }) }
}

let hubUrl = HUB, local = null
if (HUB === 'local') {
  local = await startLocalHub({ data: path.join(OUT, 'hub'), metrics: path.join(OUT, 'hub-metrics.jsonl'), detached: flag('keep-hub') })
  hubUrl = local.hub_url
}
const dir = path.join(OUT, 'members')
const { client: phone } = await found({ hub_url: hubUrl, dir })
log(`room ${phone.model.room.room_id.slice(0, 12)} on ${hubUrl}`)
const humans = [phone]
for (const name of ['laptop', 'tablet', 'old-phone', 'office', 'kitchen-ipad'].slice(0, N.humans - 1)) {
  const { client } = await addHuman(phone, { dir: path.join(dir, name), name: `Seed ${name}` })
  await client.start({ stream: false })
  humans.push(client)
}
const LABELS = ['Krypto', 'App', 'Hub', 'Kanal', 'Prüfer', 'Last', 'Design', 'Docs', 'iOS', 'Tempo', 'Fuzz']
const agents = []
for (let i = 0; i < N.sessions; i++) {
  const { client } = await addAgent(phone, { dir: path.join(dir, `agent-${i}`), name: `agent-${i}`, label: LABELS[i % LABELS.length] + (i >= LABELS.length ? ` ${Math.floor(i / LABELS.length) + 1}` : '') })
  await client.start({ stream: false })
  leanSender(client)
  agents.push(client)
}
log(`${agents.length} agents, ${humans.length} humans`)

async function pool(n, fn, width = 64) {
  let i = 0
  const lanes = Array.from({ length: width }, async () => { while (i < n) { const k = i++; await fn(k) } })
  await Promise.all(lanes)
}
const backpressure = async c => { while (c.outbox.length > 16) await sleep(2) }
const settleAll = async cs => { for (const c of cs) await until(() => c.outbox.length === 0, 'outbox drained', 1_800_000) }
const human = () => pick(humans)

// 1. desks, sessions on desks, profiles and status lines
const desks = Array.from({ length: N.desks - 1 }, () => hex16())     // the main desk (null) plus 7 named desks
await phone.setRegisters({ 'desk/main': { name: 'Desk', created_at: Date.now() - 86400_000 }, ...Object.fromEntries(desks.map((d, i) => [`desk/${d}`, { name: ['Krypto', 'App', 'Hub', 'iOS', 'Docs', 'Tempo', 'Privat'][i] ?? `Tisch ${i + 1}`, created_at: Date.now() - 3600_000 + i }])) })
const deskOf = i => (i < 12 ? null : desks[i % desks.length])
const placed = agents.map((a, i) => [`session/${a.session_id}`, deskOf(i) ? { desk: deskOf(i) } : null]).filter(([, v]) => v)
for (let i = 0; i < placed.length; i += 16) await phone.setRegisters(Object.fromEntries(placed.slice(i, i + 16)))
await pool(agents.length, async i => {
  const a = agents[i]
  await a.setStatus({ profile: { model: pick(['claude-opus-5-5', 'claude-sonnet-5']), task: text(rng, 3, 8), icon: 'draw:flask', agent_name: `agent-${i}` } })
  for (let k = 0; k < 1 + (i % 3); k++) await a.setStatus({ [`status_line/s${k}`]: { label: text(rng, 1, 3), state: pick(['working', 'waiting', 'done']), detail: text(rng, 3, 9) } })
}, 44)
await settleAll([phone, ...agents])
log('desks, sessions on desks, status lines')

// 2. pictures: N.pictures distinct encrypted PNGs (uploaded by the phone; any member may reference a room attachment)
const pictures = []
await pool(N.pictures, async k => {
  const w = 160 + Math.floor(rng() * 480), h = 120 + Math.floor(rng() * 360)
  pictures.push(await phone.uploadAttachment(png(w, h), { file_name: `bild-${k}.png`, media_type: 'image/png', width: w, height: h }))
}, 16)
phone.attachmentCache.clear()
log(`${pictures.length} pictures`)

// 3. cards: answered ones (half revised) and open ones
const cards = []
await pool(N.answered + N.open, async k => {
  const a = agents[k % agents.length]
  await backpressure(a)
  const options = Array.from({ length: 2 + (k % 3) }, (_, j) => ({ key: String.fromCharCode(97 + j), label: text(rng, 2, 6), detail: rng() < 0.3 ? text(rng, 5, 20) : undefined }))
  const att = k % 11 === 0 ? { attachments: [pick(pictures)] } : {}
  const id = await a.sendCard({ title: `${k}: ${text(rng, 3, 9)}`, teaser: text(rng, 6, 18).slice(0, 150), body: text(rng, 10, 80), options, recommended: 'a', urgency: pick(['low', 'normal', 'normal', 'high', 'critical']), ...att })
  if (k % 2 === 0) await a.revise(id, { body: text(rng, 10, 80), change_note: text(rng, 2, 6) })
  rememberOwnCard(a, id)
  cards.push({ id, agent: a, k })
}, 128)
await settleAll(agents)
log(`${cards.length} cards`)

for (const h of humans) await h.catchUp()
const toAnswer = cards.filter(c => c.k < N.answered)
await pool(toAnswer.length, async i => {
  const h = humans[i % humans.length]
  await backpressure(h)
  const card = h.model.cards.get(toAnswer[i].id)
  await h.answer({ object_id: card.object_id, choices: [card.options[0].key], ...(i % 5 === 0 ? { note: text(rng, 3, 12) } : {}) })
}, 32)
await settleAll(humans)
const openCards = cards.filter(c => c.k >= N.answered)
const regs = {}
openCards.forEach((c, i) => {
  if (i % 9 === 0) regs[`snooze/${c.id}`] = { until: Date.now() + 6 * 3600_000 }
  if (i % 13 === 0) regs[`duck/${c.id}`] = { at: Date.now() }
  if (i % 17 === 0) regs[`draft/${c.id}`] = { text: text(rng, 3, 12) }
})
const regList = Object.entries(regs)
for (let i = 0; i < regList.length; i += 8) await phone.setRegisters(Object.fromEntries(regList.slice(i, i + 8)))   // a register body is at most 4 KiB
await settleAll([phone])
for (const h of humans) trimWindows(h)
log(`${toAnswer.length} answered, ${Object.keys(regs).length} registers`)

// 4. chat: the huge session chat (every 6th with a picture), the big card thread, the rest spread
const bigAgent = agents[1]
const bigCard = openCards.find(c => c.agent === agents[2]) ?? openCards[0]
await pool(N.bigSession + N.bigThread + N.chat, async k => {
  let c, msg
  if (k < N.bigSession) { c = k % 3 ? bigAgent : (k % 2 ? phone : humans[1]); msg = c === bigAgent ? {} : { agent_device_id: bigAgent.my_device_id } }
  else if (k < N.bigSession + N.bigThread) { c = k % 3 ? bigCard.agent : humans[1]; msg = { object_id: bigCard.id } }
  else if (k % 4 === 0) { c = human(); msg = { object_id: pick(openCards).id } }
  else if (k % 4 === 1) { c = human(); msg = { agent_device_id: pick(agents).my_device_id } }
  else { c = pick(agents); const own = openCards.find(x => x.agent === c); msg = own && rng() < 0.2 ? { object_id: own.id } : {} }
  if (k % N.pictureEvery === 0) msg.attachments = [pick(pictures)]
  await backpressure(c)
  await c.sendMessage({ ...msg, text: `${k}: ${text(rng, 3, 50)}`, ...(k % 25 === 0 ? { details: text(rng, 40, 200) } : {}) })
}, 256)
await settleAll([...agents, ...humans])
log(`${N.bigSession} in the huge session, ${N.bigThread} in the card thread, ${N.chat} more`)

// 5. notes (a third edited) and published pages
await pool(N.notes, async k => {
  const h = humans[k % 3]
  await backpressure(h)
  const id = await h.saveNote({ text: `${text(rng, 2, 6)}\n${text(rng, 10, 60)}` })
  if (k % 3 === 0) await h.saveNote({ object_id: id, text: `${text(rng, 2, 6)}\n${text(rng, 10, 60)}` })
}, 16)
await pool(N.pages, async k => {
  const a = agents[k % agents.length]
  await backpressure(a)
  await a.publish({ title: `Seite ${k}: ${text(rng, 2, 5)}`, note: text(rng, 4, 20), attachments: [pick(pictures)] })
}, 32)
await settleAll([...agents, ...humans])
log(`${N.notes} notes, ${N.pages} pages`)

// 6. the Scribble Board: N.bigBoard strokes on the main desk, more on the other desks and session boards
await pool(N.bigBoard + N.strokes, async k => {
  let c, timeline_id
  if (k < N.bigBoard) { c = humans[k % 3]; timeline_id = deskCanvas('main') }
  else if (k % 2) { c = human(); timeline_id = `desk/${pick(desks)}` }
  else { const a = pick(agents); c = rng() < 0.5 ? a : human(); timeline_id = `session/${a.session_id}` }
  await backpressure(c)
  const cx = (k % 40) * 220 + rng() * 100, cy = Math.floor(k / 40) % 500 * 90
  await c.sendStrokes({ timeline_id, strokes: [inkEntry(12 + Math.floor(rng() * 50), cx, cy)] })
}, 256)
await settleAll([...agents, ...humans])
log(`${N.bigBoard + N.strokes} strokes`)

await phone.catchUp()
const total = phone.model.room.last_envelope_number
for (const c of [...agents, ...humans.slice(1)]) await c.stop()
await phone.stop()
await phone.storage?.flush?.()
const info = {
  hub_url: hubUrl, room_id: phone.model.room.room_id, envelopes: total, seconds: Math.round((performance.now() - t0) / 1000), counts: N,
  phone_dir: path.join(dir, 'phone'), human_dirs: ['phone', 'laptop', 'tablet', 'old-phone', 'office', 'kitchen-ipad'].slice(0, N.humans).map(n => path.join(dir, n)),
  big_session: bigAgent.session_id ?? bigAgent.my_device_id, big_agent: bigAgent.my_device_id, big_card: bigCard.id, big_desk: deskCanvas('main').slice(5), desks,
  hub_pid: local?.pid ?? null, hub_data: local ? path.join(OUT, 'hub') : null,
}
writeJson(path.join(OUT, 'huge.json'), info)
writeJson(path.join(OUT, 'crazy.json'), info)     // app-perf.mjs reads crazy.json
log(`done: ${total} envelopes in ${info.seconds} s`)
if (local && !flag('keep-hub')) await local.stop()
process.exit(0)
