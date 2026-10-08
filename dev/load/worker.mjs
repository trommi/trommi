// worker.mjs: one load process hosting several members (forked by load.mjs). Each member is a shared/ client
// opened from its storage dir; it sends a realistic mix through the core's own API (sealed, chained, posted by the
// core's outbox). Commands arrive over IPC; counters go back once a second.
//
// IPC in:  { type: 'run', rate, depth, mix? }   rate = envelopes/s per member (0 = as fast as depth allows)
//          { type: 'pause' } | { type: 'stop' }
// IPC out: { type: 'ready' } | { type: 'tick', sent, acked, failed, by_action, outbox, rss_mb, errors } | { type: 'stopped' }
import { NET, pct, useTestKey, rememberOwnCard, reopen, leanSender, trimWindows, sleep, text, rngOf, stroke, hex16 } from './lib.mjs'


// undici (fetch over HTTP/2 to Cloudflare) can emit an unhandled 'error' on an idle stream (UND_ERR_INFO "socket
// idle timeout"); the core's transport reconnects by itself, so note it and go on. Anything else ends the process.
process.on('uncaughtException', e => {
  if (String(e?.code ?? '').startsWith('UND_ERR')) { console.error(`[e2e] ignored ${e.code}: ${e.message}`); return }
  console.error(e); process.exit(1)
})

const spec = JSON.parse(process.argv[2])     // { members: [{ dir, role, name }], desk_id, seed, test_key }
await useTestKey(spec.test_key)
const rng = rngOf(spec.seed ?? 1)
const pick = arr => arr[Math.floor(rng() * arr.length)]
const counters = { sent: 0, acked: 0, failed: 0, by_action: {}, errors: {} }
let mode = { type: 'pause' }

// The mix per role (weights). Agents: chat, cards and their revisions, card chat, status lines, attachments, strokes.
// Humans: answers, chat to a session or a card, strokes on the desk and on session canvases, read markers, drafts.
const MIX = {
  agent: { chat: 40, card: 6, revise: 4, card_chat: 10, status: 14, attachment: 1, strokes: 5 },
  human: { answer: 6, chat: 14, card_chat: 6, strokes: 60, draft: 6 },
}
function choose(weights) {
  let total = 0
  for (const w of Object.values(weights)) total += w
  let r = rng() * total
  for (const [k, w] of Object.entries(weights)) { if ((r -= w) < 0) return k }
  return Object.keys(weights)[0]
}

const members = []
for (const m of spec.members) {
  const { client } = await reopen(m.dir)
  leanSender(client)
  client.onAcked = () => { counters.acked++ }
  await client.start({ stream: false })
  members.push({ ...m, client, cards: [], agents: [], lastSync: 0 })
}
// v1.1: humans address sessions (session_id -> its agent); an agent's own canvas is session/<its session_id>
const humanView = members.find(m => m.role === 'human')?.client
const sessions = humanView ? [...humanView.sessionKeys.values()].map(k => ({ session_id: k.state.sessionId, agent: k.state.agentIds[0] })).filter(x => x.agent) : []
for (const m of members) m.sessions = sessions
process.send({ type: 'ready' })

async function act(m) {
  const c = m.client
  const weights = mode.mix?.[m.role] ?? MIX[m.role]
  const action = choose(weights)
  if (m.role === 'agent') {
    const recent = m.cards.filter(x => Date.now() - x.at < 8000 && x.v < 3)
    switch (action) {
      case 'chat': return [action, c.sendMessage({ text: text(rng), ...(rng() < 0.15 ? { details: text(rng, 40, 200) } : {}) })]
      case 'card': {
        const options = Array.from({ length: 2 + Math.floor(rng() * 3) }, (_, i) => ({ key: String.fromCharCode(97 + i), label: text(rng, 2, 6) }))
        const p = c.sendCard({ title: text(rng, 3, 9), body: text(rng, 10, 80), options, recommended: 'a', urgency: pick(['low', 'normal', 'normal', 'high']) })
        p.then(id => { rememberOwnCard(c, id); m.cards.push({ id, at: Date.now(), v: 1 }); if (m.cards.length > 200) m.cards.shift() }, () => {})
        return [action, p]
      }
      case 'revise': if (recent.length) { const x = pick(recent); x.v++; return [action, c.revise(x.id, { body: text(rng, 10, 80), change_note: text(rng, 2, 6) })] } return [action, null]
      case 'card_chat': if (m.cards.length) return [action, c.sendMessage({ object_id: pick(m.cards).id, text: text(rng) })]; return [action, null]
      case 'status': return [action, c.setStatus({ [`status_line/s${Math.floor(rng() * 4)}`]: { label: text(rng, 1, 3), state: pick(['working', 'waiting', 'done']), detail: text(rng, 3, 10) } })]
      case 'attachment': {
        const bytes = crypto.getRandomValues(new Uint8Array(4000 + Math.floor(rng() * 28000)))
        const p = c.uploadAttachment(bytes, { file_name: 'shot.png', media_type: 'image/png', width: 640, height: 400 }).then(ref => c.sendMessage({ text: 'Bild', attachments: [ref] }))
        return [action, p]
      }
      case 'strokes': return [action, c.sendStrokes({ timeline_id: `session/${c.session_id}`, strokes: [stroke(rng)] })]
    }
  } else {
    if (Date.now() - m.lastSync > 3000) { m.lastSync = Date.now(); await c.catchUp().catch(() => {}); trimWindows(c) }
    const open = c.model.stack.filter(id => { const k = c.model.cards.get(id); return k && !k.answer && Date.now() - k.created_at > 9000 })
    switch (action) {
      case 'answer': if (open.length) { const id = pick(open); const card = c.model.cards.get(id); return [action, c.answer({ object_id: id, choices: [card.options?.[0]?.key ?? 'a'], ...(rng() < 0.3 ? { note: text(rng, 3, 15) } : {}) })] } return ['answer_none', null]
      case 'chat': return [action, c.sendMessage({ agent_device_id: pick(m.sessions).agent, text: text(rng) })]
      case 'card_chat': if (c.model.stack.length) return [action, c.sendMessage({ object_id: pick(c.model.stack), text: text(rng) })]; return [action, null]
      case 'strokes': {
        const onDesk = rng() < 0.6
        return [action, c.sendStrokes({ timeline_id: onDesk ? `desk/${spec.desk_id}` : `session/${pick(m.sessions).session_id}`, strokes: [stroke(rng)] })]
      }
      case 'draft': if (open.length) return [action, c.setDraft(pick(open), { keys: ['a'], note: text(rng, 2, 8) })]; return [action, null]
    }
  }
  return [action, null]
}

async function memberLoop(m) {
  let next = performance.now()
  while (mode.type !== 'stop') {
    if (mode.type !== 'run') { await sleep(50); next = performance.now(); continue }
    if (m.client.outbox.length >= (mode.depth ?? 4)) { await sleep(2); continue }
    if (mode.rate > 0) {
      const now = performance.now()
      if (now < next) { await sleep(Math.min(50, next - now)); continue }
      next = Math.max(next + 1000 / mode.rate, now - 1000)
    }
    let action, p
    try { [action, p] = await act(m) } catch (e) { const k = `act:${e.code ?? e.message}`; counters.errors[k] = (counters.errors[k] ?? 0) + 1; await sleep(20); continue }
    if (!p) { await sleep(1); continue }
    counters.sent++
    counters.by_action[action] = (counters.by_action[action] ?? 0) + 1
    p.catch(e => { counters.failed++; const k = `${action}:${e.code ?? e.message}`; counters.errors[k] = (counters.errors[k] ?? 0) + 1 })
    if (action === 'attachment' || action === 'card') await p.catch(() => {})
    else await sleep(0)
  }
}

process.on('message', msg => { mode = msg })
process.on('disconnect', () => process.exit(0))   // the orchestrator is gone
const loops = members.map(memberLoop)
const tick = setInterval(() => {
  const outbox = members.reduce((n, m) => n + m.client.outbox.length, 0)
  const post = NET.postMs.length ? pct(NET.postMs.splice(0)) : null
  process.send({ type: 'tick', ...counters, outbox, post, rss_mb: Math.round(process.memoryUsage().rss / 1048576) })
  for (const m of members) if (m.role === 'agent') trimWindows(m.client)
}, 1000)
await Promise.all(loops)
for (const m of members) { try { await m.client.settle({ timeout_ms: 60_000 }).catch(() => {}); await m.client.stop() } catch {} }
clearInterval(tick)
process.send({ type: 'tick', ...counters, outbox: 0, rss_mb: Math.round(process.memoryUsage().rss / 1048576) })
process.send({ type: 'stopped' })
process.exit(0)
