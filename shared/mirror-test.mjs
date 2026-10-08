// mirror-test.mjs: the page's copy of a model in a worker (mirror.ts) stays equal to the model, through what a human
// device sees and does: a room, an agent with cards, messages and status lines, answers and decide-again, registers
// (drafts, snoozes, desks), notes, timelines opened and paged, an echo rolled back. Every patch goes through
// structuredClone, as postMessage does. Against hub/server.mjs in-process.
//   node shared/mirror-test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startHub, LIMITS } from '../hub/server.mjs'
import { foundRoom, joinRoom, memoryStorage } from './index.mjs'
import { snapshotOf, patchOf, mirrorOf, applyPatch } from './mirror.ts'

LIMITS.foundPerIpHour = 10_000
LIMITS.openRequestsPerIpMinute = 100_000
LIMITS.envelopesPerSecond = 100_000; LIMITS.envelopeBurst = 100_000
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, what, ms = 10_000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${what}`); await sleep(15) } }
let failed = 0, passed = 0
const check = (ok, what) => { if (ok) passed++; else failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`) }

/** The model as comparable data: Maps as sorted entries, the core's own projection state left out. */
const canon = v => JSON.stringify(v, (k, x) => {
  if (k === '_proj' || k === '_register_log') return undefined
  if (x instanceof Map) return { $map: [...x].sort((a, b) => String(a[0]).localeCompare(String(b[0]))) }
  if (x instanceof Set) return { $set: [...x].sort() }
  if (x instanceof Uint8Array) return { $bytes: Buffer.from(x).toString('hex') }
  if (typeof x === 'number' && !Number.isFinite(x)) return { $num: String(x) }
  if (x && typeof x === 'object' && !Array.isArray(x)) return Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]]))   // (key order is no difference)
  return x
})
function firstDiff(a, b) { const x = canon(a), y = canon(b); if (x === y) return null; let i = 0; while (x[i] === y[i]) i++; return `${x.slice(Math.max(0, i - 120), i + 80)}\n   vs\n${y.slice(Math.max(0, i - 120), i + 80)}` }

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'trommi-mirror-test-'))
const hub = await startHub({ port: 0, host: '127.0.0.1', dataDir: path.join(scratch, 'hub'), log: () => {}, pingMs: 2000 })
const clients = []
try {
  const { client: A } = await foundRoom({ hub_url: hub.hubUrl, storage: memoryStorage(), device_name: 'Laptop' })
  clients.push(A)
  // the copy: the whole model once, then one patch per change (cloned, as postMessage clones), the change as the copy says it
  const mirror = mirrorOf(structuredClone(snapshotOf(A.model)))
  let changes = 0, itemsOk = true
  A.on('change', ch => {
    const patch = structuredClone(patchOf(A.model, ch))
    const c = applyPatch(mirror, patch)
    changes++
    for (const [key, list] of ch.items) { const got = c.items.get(key) ?? []; if (got.length !== list.length || got.some(it => mirror.timelines.get(key)?.items.get(it.envelope_number ?? it.local_id) !== it)) itemsOk = false }
    for (const k of ['cards', 'sessions', 'timelines', 'registers']) if (c[k].size !== ch[k].size) itemsOk = false
  })
  await A.start()
  const same = what => { const d = firstDiff(mirror, A.model); check(!d, `${what} (${changes} changes)${d ? `\n   ${d}` : ''}`) }
  same('a founded room')

  // an agent joins (invite, check code), gets its session
  const inv = await A.createInvite({ device_role: 'agent', label: 'Helper' })
  const j = joinRoom({ link: inv.link, storage: memoryStorage(), device_name: 'agent', poll_ms: 50 })
  const code = await j.check_code
  await until(() => A.model.invites.get(inv.invite_id)?.invite_state === 'confirm_code', 'the code')
  await A.confirmInvite(inv.invite_id, A.model.invites.get(inv.invite_id).check_code === code)
  const agent = await j.client
  clients.push(agent)
  await agent.start()
  await until(() => agent.session_id, 'a session for the agent')
  await until(() => A.model.sessions.size > 0, 'the session on A')
  same('an agent joined, invite done, session granted')

  // the agent works: profile, status lines, cards, messages
  await agent.setStatus({ 'status_line/tests': { label: 'Tests', state: 'working', detail: 'running' }, profile: { model: 'opus', task: 'mirror', agent_name: 'Helper' } })
  const c1 = await agent.sendCard({ card_type: 'decision', title: 'Which way?', body: 'Pick one', options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B', final: true }], recommended: 'a', urgency: 'high' })
  const c2 = await agent.sendCard({ card_type: 'info', title: 'FYI', body: 'Read me' })
  await agent.sendMessage({ text: 'hello from the agent' })
  await agent.sendMessage({ text: 'about the card', object_id: c1 })
  await until(() => A.model.cards.has(c1) && A.model.cards.has(c2) && A.model.timelines.get(`chat:card/${c1}`)?.item_count, 'cards and messages on A')
  await sleep(200)
  same('status lines, profile, two cards, two messages')

  // the human: answer, decide again, read an info, registers, a note, a message
  await A.answer({ object_id: c1, choices: ['a'], note: 'go' })
  await until(() => A.model.cards.get(c1).answer && !A.model.cards.get(c1).answer.pending, 'the answer confirmed')
  same('an answer (echo, then confirmed)')
  await A.decideAgain({ object_id: c1 })
  await until(() => A.model.cards.get(c1).object_state === 'open' && !A.model.outbox.length, 'decided again')
  await A.markRead({ object_id: c2 })
  await A.setDraft(c1, { keys: ['b'], note: 'maybe', notes: {} })
  await A.snooze(c1, Date.now() + 3600_000)
  await A.setDesk('d1', { name: 'Work', created_at: Date.now() })
  await A.setCrown({ session: agent.session_id })
  const note = await A.saveNote({ text: 'a note', place: 'corner' })
  await A.saveNote({ object_id: note, text: 'a note, edited' })
  await A.sendMessage({ ...{ session_id: agent.session_id }, text: 'hi agent' }).catch(() => A.sendMessage({ agent_device_id: agent.my_device_id, text: 'hi agent' }))
  await until(() => !A.model.outbox.length, 'all sent')
  await sleep(300)
  same('decide again, read, draft, snooze, desk, crown, a note in two versions, a message')

  // registers removed (tombstones), the snooze ended
  await A.setDraft(c1, null)
  await A.snooze(c1, null)
  await A.setDesk('d1', null)
  await until(() => !A.model.outbox.length, 'removals sent')
  await sleep(200)
  same('a draft, a snooze and a desk removed')

  // timelines: many messages, the window paged back
  for (let i = 0; i < 70; i++) await agent.sendMessage({ text: `line ${i}` })
  const sk = [...A.model.sessions.values()][0].timeline_key
  await until(() => (A.model.timelines.get(sk)?.item_count ?? 0) >= 71, 'the session chat on A')
  await sleep(200)
  same('70 live messages')
  // a fresh copy of the timeline window: drop it on A (as a restart would) and page it in
  await A.loadTimeline(sk, { limit: 20 })
  await A.loadTimeline(sk, { limit: 20 })
  same('the session chat paged back twice')

  // the agent revises and closes; withdraws the info
  await agent.revise(c1, { title: 'Which way, really?', change_note: 'clearer' })
  await until(() => A.model.cards.get(c1).object_version === 2, 'version 2 on A')
  await A.answer({ object_id: c1, choices: ['b'] })
  await until(() => A.model.cards.get(c1).object_state === 'closed' && !A.model.outbox.length, 'settled by a final option')
  await sleep(200)
  same('a revision, then an answer that settles the card')

  // an echo that the hub refuses is rolled back: an answer to a card the agent closed meanwhile
  const c3 = await agent.sendCard({ card_type: 'decision', title: 'Soon closed', options: [{ key: 'x', label: 'X' }] })
  await until(() => A.model.cards.has(c3), 'c3 on A')
  await agent.close(c3, 'never mind')
  await A.answer({ object_id: c3, choices: ['x'] }).catch(() => {})
  await until(() => A.model.cards.get(c3).object_state === 'closed' && !A.model.outbox.some(o => o.outbox_state === 'sending'), 'c3 closed on A', 15_000)
  await sleep(500)
  same('an answer racing a close')

  check(itemsOk, 'every change names the same records in the copy, its items the copy\'s own objects')
  check(changes > 20, `the copy followed ${changes} changes`)
} catch (e) {
  failed++
  console.log(`FAIL ${e.stack}`)
} finally {
  for (const c of clients) await c.stop().catch(() => {})
  await hub.close?.()
  fs.rmSync(scratch, { recursive: true, force: true })
}
console.log(`\n${passed} ok, ${failed} failed`)
process.exit(failed ? 1 : 0)
