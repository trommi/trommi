// crazy.mjs: seed the "crazy case" room through shared/, as real members: 32 agent sessions with profiles and
// status lines, 5,000 answered cards (half of them revised), 300 open cards, 50,000 chat messages (one session
// chat of 2,500 and one card thread of 2,000 among them), 50,000 strokes (one desk canvas of 20,000).
//
//   node dev/load/crazy.mjs --hub=local|<url> --out=<dir> [--scale=1] [--keep-hub]
//
// Writes <out>/crazy.json: hub url, room id, the member dirs, the ids of the big timelines. With --hub=local the
// hub keeps running (pid in crazy.json) so dev/load/app-perf.mjs can open the room in the app.
import fs from 'node:fs'
import path from 'node:path'
import { rememberOwnCard, arg, flag, sleep, until, found, addAgent, addHuman, leanSender, trimWindows, startLocalHub, writeJson, text, rngOf, stroke, hex16 } from './lib.mjs'
import { guard } from '../guard.mjs'
guard({ usage: 'node dev/load/crazy.mjs --hub=local|URL --out=DIR [--scale=1] [--keep-hub]', values: ['hub', 'out', 'scale'], flags: ['keep-hub'], targets: ['hub'] })

const HUB = arg('hub', 'local')
const OUT = path.resolve(arg('out', `/tmp/trommi-crazy-${Date.now()}`))
const S = Number(arg('scale', 1))
const N = {
  sessions: 32, answered: Math.round(5000 * S), open: Math.round(300 * S), chat: Math.round(50_000 * S), strokes: Math.round(50_000 * S),
  bigSession: Math.round(2500 * S), bigThread: Math.round(2000 * S), bigCanvas: Math.round(20_000 * S),
}
fs.mkdirSync(OUT, { recursive: true })
const t0 = performance.now()
const log = (...a) => { const l = `[${((performance.now() - t0) / 1000).toFixed(0)} s] ${a.join(' ')}`; console.log(l); fs.appendFileSync(path.join(OUT, 'crazy.log'), l + '\n') }
const rng = rngOf(42)
const pick = a => a[Math.floor(rng() * a.length)]

let hubUrl = HUB, local = null
if (HUB === 'local') {
  local = await startLocalHub({ data: path.join(OUT, 'hub'), metrics: path.join(OUT, 'hub-metrics.jsonl'), detached: flag('keep-hub') })
  hubUrl = local.hub_url
}
const dir = path.join(OUT, 'members')
const { client: phone } = await found({ hub_url: hubUrl, dir })
log(`room ${phone.model.room.room_id.slice(0, 12)} on ${hubUrl}`)
const agents = []
for (let i = 0; i < N.sessions; i++) {
  const { client } = await addAgent(phone, { dir: path.join(dir, `agent-${i}`), name: `agent-${i}`, label: ['Krypto', 'App', 'Hub', 'Kanal', 'Prüfer', 'Last', 'Design', 'Docs'][i % 8] + (i >= 8 ? ` ${Math.floor(i / 8) + 1}` : '') })
  await client.start({ stream: false })
  leanSender(client)
  agents.push(client)
}
const { client: laptop } = await addHuman(phone, { dir: path.join(dir, 'laptop'), name: 'Seed laptop' })
await laptop.start({ stream: false })
log(`${agents.length} agents, 2 humans`)

/** Run fn(i) for i < n with at most `width` in flight per sender (the core's outbox posts one at a time per device). */
async function pool(n, fn, width = 64) {
  let i = 0
  const lanes = Array.from({ length: width }, async () => { while (i < n) { const k = i++; await fn(k) } })
  await Promise.all(lanes)
}
const backpressure = async c => { while (c.outbox.length > 16) await sleep(2) }
const settleAll = async cs => { for (const c of cs) await until(() => c.outbox.length === 0, 'outbox drained', 600_000) }

// 1. profiles and status lines: 30+ sessions with status lines
await pool(agents.length, async i => {
  const a = agents[i]
  await a.setStatus({ profile: { model: 'claude-opus-5-5', task: text(rng, 3, 8), icon: 'draw:flask', agent_name: `agent-${i}` } })
  for (let k = 0; k < 1 + (i % 3); k++) await a.setStatus({ [`status_line/s${k}`]: { label: text(rng, 1, 3), state: pick(['working', 'waiting', 'done']), detail: text(rng, 3, 9) } })
}, 32)
log('status lines')

// 2. cards: answered ones (half revised) and open ones
const cards = []   // { id, agent }
const makeCard = async k => {
  const a = agents[k % agents.length]
  await backpressure(a)
  const options = Array.from({ length: 2 + (k % 3) }, (_, j) => ({ key: String.fromCharCode(97 + j), label: text(rng, 2, 6), detail: rng() < 0.3 ? text(rng, 5, 20) : undefined }))
  const id = await a.sendCard({ title: `${k}: ${text(rng, 3, 9)}`, body: text(rng, 10, 80), options, recommended: 'a', urgency: pick(['low', 'normal', 'normal', 'high', 'critical']) })
  if (k % 2 === 0) await a.revise(id, { body: text(rng, 10, 80), change_note: text(rng, 2, 6) })
  rememberOwnCard(a, id)
  cards.push({ id, agent: a, k })
}
await pool(N.answered + N.open, makeCard, 128)
await settleAll(agents)
log(`${cards.length} cards`)

// 3. the humans answer N.answered of them (alternating devices), the rest stays open
await phone.catchUp(); await laptop.catchUp()
const toAnswer = cards.filter(c => c.k < N.answered)
await pool(toAnswer.length, async i => {
  const h = i % 2 ? laptop : phone
  await backpressure(h)
  const card = h.model.cards.get(toAnswer[i].id)
  await h.answer({ object_id: card.object_id, choices: [card.options[0].key], ...(i % 5 === 0 ? { note: text(rng, 3, 12) } : {}) })
}, 32)
await settleAll([phone, laptop])
trimWindows(phone); trimWindows(laptop)
log(`${toAnswer.length} answered`)

// 4. chat: one big session chat, one big card thread, the rest spread over sessions and cards (humans and agents)
const bigAgent = agents[1]
const bigCard = cards.find(c => c.agent === agents[2] && c.k >= N.answered)   // an open card of agent-2
const openCards = cards.filter(c => c.k >= N.answered)
await pool(N.chat, async k => {
  let c, msg
  if (k < N.bigSession) { c = k % 3 ? bigAgent : phone; msg = c === phone ? { agent_device_id: bigAgent.my_device_id } : {} }
  else if (k < N.bigSession + N.bigThread) { c = k % 3 ? bigCard.agent : laptop; msg = { object_id: bigCard.id } }
  else if (k % 4 === 0) { const oc = pick(openCards); c = pick([phone, laptop]); msg = { object_id: oc.id } }
  else if (k % 4 === 1) { c = pick([phone, laptop]); msg = { agent_device_id: pick(agents).my_device_id } }
  else { c = pick(agents); msg = rng() < 0.2 ? { object_id: (cards.find(x => x.agent === c && x.k >= N.answered) ?? {}).id } : {}; if (msg.object_id === undefined) delete msg.object_id }
  if (msg.object_id && c !== phone && c !== laptop && cards.find(x => x.id === msg.object_id)?.agent !== c) delete msg.object_id
  await backpressure(c)
  await c.sendMessage({ ...msg, text: `${k}: ${text(rng, 3, 50)}`, ...(k % 25 === 0 ? { details: text(rng, 40, 200) } : {}) })
}, 256)
await settleAll([...agents, phone, laptop])
log(`${N.chat} chat messages`)

// 5. strokes: one desk canvas of 20,000, the rest on other desks and session canvases
const bigDesk = hex16(), desks = [hex16(), hex16(), hex16()]
await pool(N.strokes, async k => {
  let c, timeline_id
  if (k < N.bigCanvas) { c = k % 2 ? laptop : phone; timeline_id = `desk/${bigDesk}` }
  else if (k % 2) { c = pick([phone, laptop]); timeline_id = `desk/${pick(desks)}` }
  else { const a = pick(agents); c = rng() < 0.5 ? a : pick([phone, laptop]); timeline_id = `session/${a.session_id}` }
  await backpressure(c)
  await c.sendStrokes({ timeline_id, strokes: [stroke(rng, 12 + Math.floor(rng() * 40))] })
}, 256)
await settleAll([...agents, phone, laptop])
await phone.setRegisters({ [`desk/${bigDesk}`]: { name: 'Großer Tisch' }, ...Object.fromEntries(desks.map((d, i) => [`desk/${d}`, { name: `Tisch ${i + 1}` }])) })
await settleAll([phone])
log(`${N.strokes} strokes`)

await phone.catchUp()
const total = phone.model.room.last_envelope_number
for (const c of [...agents, laptop]) await c.stop()
await phone.stop()
await phone.storage?.flush?.()
const info = { hub_url: hubUrl, room_id: phone.model.room.room_id, envelopes: total, seconds: Math.round((performance.now() - t0) / 1000), counts: N,
  phone_dir: path.join(dir, 'phone'), big_session: bigAgent.session_id ?? bigAgent.my_device_id, big_agent: bigAgent.my_device_id, big_card: bigCard.id, big_desk: bigDesk, hub_pid: local?.pid ?? null, hub_data: local ? path.join(OUT, 'hub') : null }
writeJson(path.join(OUT, 'crazy.json'), info)
log(`done: ${total} envelopes in ${info.seconds} s`)
if (local && !flag('keep-hub')) await local.stop()
process.exit(0)
