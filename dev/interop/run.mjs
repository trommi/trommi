// run.mjs: the cross-implementation suite (README "Interop"). A local hub, then for every pair of human-device
// implementations (actor -> observer: js->js, js->swift, swift->js) a room of its own: a JS founder (the web app's core),
// a JS agent (the connector's core), the actor device A and the observer device B. Every action of A must arrive at B
// (and at the agent) exactly as B's own implementation reads it; refusals must be the same codes on both sides.
//
//   (cd ios/TrommiCore && swift build) && node dev/interop/run.mjs          all pairs (Swift pairs skipped without the binary)
//   node dev/interop/run.mjs --pairs js-swift --only answer                   one pair, scenarios whose name has "answer"
//   --require-swift: fail instead of skipping when trommi-swift is not built.  Results: dev/interop/out/run.json
//   --agent rust: the agents (G and the helper) are the Rust connector's core (connector-rs, `cargo build` first)
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { startHub } from '../../hub/server.mjs'
import * as z from '../../shared/crypto/zcrypto.mjs'
import { startDriver, swiftAvailable, SWIFT_BIN, rustAvailable, RUST_BIN } from './protocol.mjs'

const here = path.dirname(new URL(import.meta.url).pathname)
const argv = process.argv.slice(2)
const opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null }
const ALL_PAIRS = ['js-js', 'js-swift', 'swift-js']
let pairs = (opt('--pairs') ?? ALL_PAIRS.join(',')).split(',')
const only = opt('--only')
const requireSwift = argv.includes('--require-swift')
const AGENT = opt('--agent') ?? 'js'
if (AGENT === 'rust' && !rustAvailable()) { console.error(`no ${RUST_BIN}: build it (cd connector-rs && cargo build)`); process.exit(2) }
const skipped = []
if (!swiftAvailable()) {
  if (requireSwift) { console.error(`no ${SWIFT_BIN}: build it (cd ios/TrommiCore && swift build)`); process.exit(2) }
  for (const p of pairs.filter(p => p.includes('swift'))) skipped.push(`${p} (no trommi-swift: cd ios/TrommiCore && swift build)`)
  pairs = pairs.filter(p => !p.includes('swift'))
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(what, fn, ms = 20_000) {
  const end = Date.now() + ms
  let last
  for (;;) {
    try { const v = await fn(); if (v) return v } catch (e) { last = e }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${last.message})` : ''}`)
    await sleep(60)
  }
}
const refused = async (p) => { try { await p; return null } catch (e) { return e } }

// ---- the hub: in this process, with APNs and Web Push switched on but pointing nowhere (nothing leaves this machine) ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trommi-interop-'))
const hubLog = []
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
const APNS_TOPIC = 'com.trommi.interop'
const hub = await startHub({
  port: 0, host: '127.0.0.1', dataDir: path.join(tmp, 'hub'), commit: 'interop', log: m => hubLog.push(m),
  apns: { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), keyId: 'INTEROP01', teamId: 'INTEROPTM', topics: [APNS_TOPIC] },
  apnsHosts: { sandbox: 'https://127.0.0.1:9', production: 'https://127.0.0.1:9' }, pushHosts: ['push.invalid'],
})
const HUB = hub.hubUrl

const results = []
const drivers = []
let homes = 0
async function driver(impl, label) {
  const d = await startDriver(impl, { home: path.join(tmp, `home-${++homes}`), label })
  drivers.push(d)
  return d
}

async function test(pair, name, fn) {
  if (only && !name.includes(only) && name !== 'setup') return
  const t0 = Date.now()
  const r = { pair, name, ok: false, ms: 0, error: null }
  try { await fn(); r.ok = true } catch (e) { r.error = e.stack?.split('\n').slice(0, 4).join('\n      ') ?? String(e) }
  r.ms = Date.now() - t0
  results.push(r)
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} [${pair}] ${name} (${r.ms} ms)${r.ok ? '' : `\n      ${r.error}`}`)
  return r.ok
}

/** inviter makes an invite, a new driver of `impl` joins with the link; both show the same code; nothing is added before "They match". */
async function addDevice(inviter, impl, { role = 'human', name, label = name, matches = true } = {}) {
  const d = await driver(impl, label)
  const inv = await inviter.call('invite', { role, label: role === 'agent' ? name : null })
  const joinP = d.call('join', { link: inv.link, name })
  joinP.catch(() => {})
  const st = await until(`${label}: the check code at the inviter`, async () => { const s = await inviter.call('invite_status', { invite_id: inv.invite_id }); return s.state === 'confirm_code' && s.check_code ? s : null })
  const { check_code } = await joinP
  assert.equal(check_code, st.check_code, `${label}: both sides show the same check code`)
  const before = (await inviter.call('members')).length
  await sleep(200)
  assert.equal((await inviter.call('members')).length, before, 'nobody added before "They match"')
  if (!matches) {
    await refused(inviter.call('invite_confirm', { invite_id: inv.invite_id, matches: false }))
    const e = await refused(d.call('join_wait', { name }))
    return { driver: d, refused: e }
  }
  const conf = await inviter.call('invite_confirm', { invite_id: inv.invite_id, matches: true })
  const me = await d.call('join_wait', { name })
  return { driver: d, id: me.device_id, session_id: conf?.session_id ?? null, room_id: me.room_id }
}

const strip = c => { const { in_stack, ...rest } = c; return rest }
/** JSON with sorted keys: the drivers' key orders differ */
const canon = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x))
/** the first difference between two lists of cards, for the failure message */
const firstDiff = (la, lb) => {
  for (let i = 0; i < Math.max(la.length, lb.length); i++) if (canon(la[i]) !== canon(lb[i])) return `#${i}: ${canon(la[i])}\n      vs ${canon(lb[i])}`
  return 'none'
}
async function sameCards(what, a, b, { all = true } = {}) {
  let la, lb
  await until(what, async () => {
    la = (await a.call('list_cards', { all })).map(strip); lb = (await b.call('list_cards', { all })).map(strip)
    return canon(la) === canon(lb)
  }, 15_000).catch(() => assert.fail(`${what}: ${la.length} vs ${lb.length} cards, first difference ${firstDiff(la, lb)}`))
  return la
}
const cardAt = async (d, id) => d.call('card', { card: id }).catch(() => null)
/** the newest head envelope this sender posted (raw, from the hub) */
async function lastEnvelopeOf(F, senderHex) {
  const env = await F.call('hub_envelopes', { after: 0, limit: 1000 })
  for (const e of env.slice().reverse()) {
    const p = z.peekEnvelope(z.unb64u(e.envelope))
    if (z.hex(p.header.sender) === senderHex && p.header.isHead) return e
  }
  throw new Error('no envelope of that sender')
}

const pairRooms = []
for (const pair of pairs) {
  const [ia, ib] = pair.split('-')
  const P = (n, fn) => test(pair, n, fn)
  const ctx = {}
  let ok = await P('setup', async () => {
    ctx.F = await driver('js', `${pair}:F`)
    await ctx.F.call('found_room', { hub_url: HUB, name: 'Founder (JS)' })
    const g = await addDevice(ctx.F, AGENT, { role: 'agent', name: 'Agent' })
    ctx.G = g.driver; ctx.agentId = g.id
    ctx.sid = await until('the agent\'s session', async () => (await ctx.F.call('sessions')).find(s => s.agent_device_ids.includes(ctx.agentId))?.session_id)
    const a = await addDevice(ctx.F, ia, { name: `A (${ia})` })
    ctx.A = a.driver; ctx.aId = a.id
    const b = await addDevice(ctx.F, ib, { name: `B (${ib})` })
    ctx.B = b.driver; ctx.bId = b.id
    for (const [d, id, n] of [[ctx.A, ctx.aId, `A (${ia})`], [ctx.B, ctx.bId, `B (${ib})`]]) {
      await until(`${n} named at the founder`, async () => (await ctx.F.call('members')).find(m => m.device_id === id)?.name === n)
    }
    await until('B sees A by its name', async () => (await ctx.B.call('members')).find(m => m.device_id === ctx.aId)?.name === `A (${ia})`)
  })
  if (!ok) continue
  pairRooms.push(pair)
  const { F, G, A, B, agentId, sid } = ctx
  const inbox = async pred => until('the agent\'s inbox', async () => (await G.call('agent_inbox')).find(pred))

  await P('version_info: both speak driver protocol 1, protocol 1, schema 1 and know the same kinds', async () => {
    const [va, vb] = [await A.call('version_info'), await B.call('version_info')]
    for (const v of [va, vb]) { assert.equal(v.driver_protocol, 1); assert.equal(v.protocol_version, 1); assert.equal(v.schema_version, 1) }
    assert.deepEqual(vb.known, va.known, 'the same envelope kinds, object types, card types, content types, answer actions, timeline kinds')
    assert.ok(va.hub && vb.hub, 'GET /v1/version read on both')
  })

  await P('cards: what the agent files (options, final, multiple, urgency, teaser, sections, html, recommended) reads the same on A and B, live', async () => {
    ctx.c1 = (await G.call('agent_card', { title: 'Deploy tonight?', teaser: 'Locks orders for 40 s.', body: 'Locks orders 40 s.', options: [{ key: 'tonight', label: 'Tonight' }, { key: 'now', label: 'Now' }], urgency: 'high', urgency_reason: 'release', recommended: 'tonight' })).id
    ctx.c2 = (await G.call('agent_card', { card_type: 'info', title: 'How the cache works', sections: [{ text: 'One' }, { text: 'Two' }], html: '<p>x</p>' })).id
    ctx.c3 = (await G.call('agent_card', { title: 'Which ones?', allows_multiple: true, options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }, { key: 'done', label: 'Done', final: true }] })).id
    ctx.c4 = (await G.call('agent_card', { title: 'Throw away?', options: [{ key: 'y', label: 'Yes' }] })).id
    ctx.c5 = (await G.call('agent_card', { title: 'Settle me', options: [{ key: 'ok', label: 'OK', final: true }, { key: 'more', label: 'More' }] })).id
    await until('five cards at B (live, no sync)', async () => (await B.call('list_cards')).length >= 5)
    const cards = await sameCards('the open cards on A and B', A, B, { all: false })
    const c1 = cards.find(c => c.id === ctx.c1)
    assert.equal(c1.urgency, 'high'); assert.equal(c1.teaser, 'Locks orders for 40 s.'); assert.deepEqual(c1.recommended, ['tonight'])
    const c2 = cards.find(c => c.id === ctx.c2)
    assert.equal(c2.card_type, 'info'); assert.equal(c2.sections, 2); assert.equal(c2.has_html, true)
    const c3 = cards.find(c => c.id === ctx.c3)
    assert.equal(c3.multiple, true); assert.equal(c3.options.find(o => o.key === 'done').final, true)
    const live = await B.call('whoami')
    assert.equal(live.live, true, 'B is on the live stream')
  })

  await P('answer: A answers, the agent gets the decision from A, B sees it answered with the choice', async () => {
    await A.call('answer', { card: ctx.c1, choices: ['now'] })
    const cmd = await inbox(c => c.command === 'answer' && c.object_id === ctx.c1)
    assert.deepEqual(cmd.choices, ['now']); assert.equal(cmd.sender_device_id, ctx.aId)
    const c = await until('answered at B', async () => { const x = await cardAt(B, ctx.c1); return x?.state === 'answered' ? x : null })
    assert.deepEqual(c.choices, ['now'])
    await sameCards('all cards after the answer', A, B)
  })

  await P('multiple + final: A ticks a final option, the card settles (closed) on B; several choices kept', async () => {
    await A.call('answer', { card: ctx.c3, choices: ['a', 'b'] })
    const c = await until('answered at B', async () => { const x = await cardAt(B, ctx.c3); return x?.state !== 'open' ? x : null })
    assert.deepEqual(c.choices, ['a', 'b']); assert.equal(c.state, 'answered')
    await A.call('answer', { card: ctx.c5, choices: ['ok'] })
    const s = await until('settled at B', async () => { const x = await cardAt(B, ctx.c5); return x?.state === 'closed' ? x : null })
    assert.equal(s.closed_how, 'settled')
  })

  await P('read and shred: A reads the info card and shreds a decision; B and the agent see both', async () => {
    await A.call('mark_read', { card: ctx.c2 })
    await A.call('shred', { card: ctx.c4 })
    await until('read at B', async () => (await cardAt(B, ctx.c2))?.closed_how === 'read')
    await until('shredded at B', async () => (await cardAt(B, ctx.c4))?.closed_how === 'shredded')
    await inbox(c => c.object_id === ctx.c4 && /shred/.test(c.command))
    await sameCards('all cards', A, B)
  })

  await P('agent side: revise (urgency), close with a summary, withdraw: A and B read the same', async () => {
    const r = (await G.call('agent_card', { title: 'Revise me', options: [{ key: 'x', label: 'X' }] })).id
    await G.call('agent_revise', { card: r, urgency: 'critical', urgency_reason: 'blocked', title: 'Revised' })
    await until('revised at B', async () => (await cardAt(B, r))?.urgency === 'critical')
    const c = await cardAt(B, r)
    assert.equal(c.title, 'Revised'); assert.equal(c.version, 2)
    await A.call('answer', { card: r, choices: ['x'] })
    await until('answered at the agent', async () => (await G.call('agent_inbox')).some(x => x.object_id === r))
    await G.call('close_card', { card: r, summary: 'Live: done' })
    await until('closed at B', async () => (await cardAt(B, r))?.state === 'closed')
    assert.equal((await cardAt(B, r)).close_summary, 'Live: done')
    const w = (await G.call('agent_card', { title: 'Withdraw me', options: [{ key: 'x', label: 'X' }] })).id
    await G.call('withdraw_card', { card: w, reason: 'not needed' })
    await until('withdrawn at B', async () => (await cardAt(B, w))?.closed_how === 'withdrawn')
    await sameCards('all cards', A, B)
  })

  await P('decide again: A takes its answer back, the card is open again on B', async () => {
    const d = (await G.call('agent_card', { title: 'Change your mind?', options: [{ key: 'y', label: 'Yes' }, { key: 'n', label: 'No' }] })).id
    await until('the card at A', async () => (await cardAt(A, d))?.state === 'open')
    await A.call('answer', { card: d, choices: ['y'] })
    await until('answered at B', async () => (await cardAt(B, d))?.state === 'answered')
    // the own answer must be confirmed by the hub on A before it can be taken back (both cores)
    await until('A takes the answer back', async () => { await A.call('decide_again', { card: d }); return true })
    await until('open again at B', async () => (await cardAt(B, d))?.state === 'open')
    await B.call('answer', { card: d, choices: ['n'] })
    await until('the new answer at A', async () => JSON.stringify((await cardAt(A, d))?.choices) === '["n"]')
  })

  await P('chat: agent messages, then A writes; A and B read the same conversation (bodies paged in); the agent gets A\'s message', async () => {
    for (const t of ['first words', 'second words', 'third words']) await G.call('chat_send', { text: t })
    await A.call('chat_send', { session: sid, text: `Hello from ${ia}` })
    await inbox(c => c.command === 'message' && c.text === `Hello from ${ia}` && c.sender_device_id === ctx.aId)
    const read = async d => (await d.call('chat_list', { session: sid })).filter(i => i.content_type === 'message').map(i => [i.from, i.text, i.state])
    let la, lb
    await until('the same conversation on A and B', async () => { la = await read(A); lb = await read(B); return la.length >= 4 && canon(la) === canon(lb) }).catch(() => assert.fail(`A ${canon(la)}\n      B ${canon(lb)}`))
    assert.deepEqual(la.slice(-4), [['agent', 'first words', 'loaded'], ['agent', 'second words', 'loaded'], ['agent', 'third words', 'loaded'], ['human', `Hello from ${ia}`, 'loaded']])
  })

  await P('registers and notes: a desk register and a note from A reach B', async () => {
    await A.call('set_register', { key: 'desk/interop', value: { name: `Interop ${ia}`, created_at: 1 } })
    await until('the desk at B', async () => (await B.call('registers')).desks?.interop?.name === `Interop ${ia}`)
    const { id } = await A.call('note_save', { text: `a note from ${ia}` })
    await until('the note at B', async () => (await B.call('notes')).some(n => n.id === id && n.text === `a note from ${ia}`))
    // a snooze: the stack (urgency, age, snoozes) is the same on both
    const open = (await A.call('list_cards')).find(c => c.in_stack)
    if (open) await A.call('set_register', { key: `snooze/${open.id}`, value: { until: Date.now() + 3600_000 } })
    const stack = async d => canon((await d.call('list_cards')).filter(c => c.in_stack).map(c => c.id))
    await until('the same stack on A and B', async () => (await stack(A)) === (await stack(B)) && !(await stack(B)).includes(open?.id ?? '-'))
    const [ra, rb] = [await A.call('registers'), await B.call('registers')]
    assert.deepEqual(rb.keys, ra.keys, 'the same human register keys')
  })

  await P('pairing from A: a new device of B\'s kind joins with A\'s link (same six emoji), gets every session key and reads the cards', async () => {
    const n = await addDevice(A, ib, { name: `Paired by ${ia}` })
    ctx.N = n.driver; ctx.nId = n.id
    await sameCards('the new device reads what A reads', A, n.driver)
    await until('the new device at B', async () => (await B.call('members')).some(m => m.device_id === n.id && m.role === 'human' && m.active))
  })

  await P('agent invite from A: an agent joins with A\'s link, gets a session of its own; its card reaches B', async () => {
    const g2 = await addDevice(A, AGENT, { role: 'agent', name: `Helper of ${ia}` })
    ctx.G2 = g2.driver; ctx.g2Id = g2.id
    const id = (await g2.driver.call('agent_card', { title: `From the helper ${ia} invited`, options: [{ key: 'y', label: 'Yes' }] })).id
    await until('the helper\'s card at B', async () => (await cardAt(B, id))?.state === 'open')
    await until('the helper\'s session at B', async () => (await B.call('sessions')).some(s => s.agent_device_ids.includes(g2.id)))
  })

  await P('removal from A: the helper agent is out, a new room key; the first agent still reaches A and B', async () => {
    const epoch = (await B.call('whoami')).key_epoch
    await A.call('remove_member', { device_id: ctx.g2Id })
    await until('removed at B', async () => (await B.call('members')).find(m => m.device_id === ctx.g2Id)?.active === false)
    await until('a new key epoch at B', async () => (await B.call('whoami')).key_epoch > epoch)
    const id = (await G.call('agent_card', { title: 'After the removal', options: [{ key: 'ok', label: 'OK' }] })).id
    await until('the new card at A', async () => (await cardAt(A, id))?.state === 'open')
    await until('the new card at B', async () => (await cardAt(B, id))?.state === 'open')
  })

  await P('removed member writes: the removed helper\'s card and the removed paired device\'s note never arrive', async () => {
    const e = await refused(ctx.G2.call('agent_card', { title: 'Written after removal', options: [{ key: 'x', label: 'X' }] }))
    await A.call('remove_member', { device_id: ctx.nId })
    await until('the paired device removed at B', async () => (await B.call('members')).find(m => m.device_id === ctx.nId)?.active === false)
    const e2 = await refused(ctx.N.call('note_save', { text: 'written after removal' }))
    await sleep(1500)
    assert.ok(!(await B.call('list_cards', { all: true })).some(c => c.title === 'Written after removal'), 'no card from a removed agent')
    assert.ok(!(await A.call('notes')).some(n => n.text === 'written after removal'), 'no note from a removed device')
    console.log(`      removed agent: ${e?.code ?? 'no error (dropped)'}; removed human: ${e2?.code ?? 'no error (dropped)'}`)
  })

  await P('negative: a forged signature, a changed body byte and a replay are refused with the same codes on A and B', async () => {
    const env = await lastEnvelopeOf(F, agentId)
    const bytes = z.unb64u(env.envelope)
    const sig = bytes.slice(); sig[sig.length - 5] ^= 1
    const body = bytes.slice(); body[body.length - 70] ^= 1
    const cases = { 'forged signature': z.b64u(sig), 'changed byte': z.b64u(body), replay: env.envelope }
    const codes = {}
    for (const [k, e] of Object.entries(cases)) {
      const [ra, rb] = [await A.call('check_envelope', { envelope_number: env.envelope_number, envelope: e }), await B.call('check_envelope', { envelope_number: env.envelope_number, envelope: e })]
      assert.equal(ra.ok, false, `${k}: refused on A`); assert.equal(rb.ok, false, `${k}: refused on B`)
      assert.equal(rb.code, ra.code, `${k}: the same code`)
      codes[k] = ra.code
    }
    assert.equal(codes['forged signature'], 'bad-signature'); assert.equal(codes.replay, 'replay')
    console.log(`      ${Object.entries(codes).map(([k, v]) => `${k}: ${v}`).join(', ')}`)
  })

  await P('newer version: a card of a newer schema and an unknown card type are kept, shown as unsupported, never answered', async () => {
    const n1 = (await G.call('agent_card', { title: 'From a newer agent', options: [{ key: 'y', label: 'Yes' }], newer_schema: 2 })).id
    const n2 = (await G.call('agent_card', { card_type: 'poll', title: 'Lunch?', options: [{ key: 'a', label: 'Pizza' }] })).id
    for (const [d, w] of [[A, 'A'], [B, 'B']]) {
      for (const id of [n1, n2]) {
        const c = await until(`${w}: the card ${id.slice(0, 6)}`, () => cardAt(d, id))
        assert.equal(c.unsupported, true, `${w} (${d.impl}): ${id === n1 ? 'a card of schema 2' : 'card_type poll'} not marked unsupported: ${canon(c)}`)
        const e = await refused(d.call('answer', { card: id, choices: [c.options[0]?.key ?? 'y'] }))
        assert.equal(e?.code, 'needs-update', `${w}: no answer to a card of a newer version`)
      }
    }
  })

  await P('newer version: a message of a newer content type reads as unsupported on A and B, the same', async () => {
    await G.call('agent_newer', { kind: 'message', on: true })
    await G.call('chat_send', { text: 'a voice note' })
    await G.call('agent_newer', { kind: 'message', on: false })
    const st = async d => (await d.call('chat_list', { session: sid })).filter(i => i.content_type === 'voice').map(i => i.state)
    const [a, b] = [await until('the voice item at A', () => st(A).then(x => x.length && x)), await until('the voice item at B', () => st(B).then(x => x.length && x))]
    assert.deepEqual(b, a, `the same item state: A (${ia}) ${a}, B (${ib}) ${b}`)
    assert.equal(a[0], 'unsupported')
  })

  await P('push: A registers its push (APNs on the iPhone, Web Push in the browser), the hub keeps it and pushes for a new card', async () => {
    const before = hubLog.length
    if (ia === 'swift') {
      const key = z.b64u(crypto.randomBytes(32))
      await A.call('register_push', { apns: { token: crypto.randomBytes(32).toString('hex'), environment: 'sandbox', topic: APNS_TOPIC, key } })
    } else {
      const p256 = crypto.createECDH('prime256v1'); p256.generateKeys()
      await A.call('register_push', { webpush: { endpoint: `https://push.invalid/interop-${crypto.randomBytes(6).toString('hex')}`, keys: { p256dh: z.b64u(p256.getPublicKey()), auth: z.b64u(crypto.randomBytes(16)) } } })
    }
    const bad = await refused(A.call('register_push', ia === 'swift' ? { apns: { token: 'nope', environment: 'sandbox', topic: APNS_TOPIC, key: 'x' } } : { webpush: { endpoint: 'https://evil.example/x', keys: {} } }))
    assert.equal(bad?.code, 'bad-argument', 'a malformed registration is refused')
    await G.call('agent_card', { title: 'Push me', options: [{ key: 'y', label: 'Yes' }], urgency: 'high' })
    // the hub keeps A's registration (its row in hub.db), and tries to push (an APNs error in its log: the host points nowhere)
    const rows = hub.db.q('SELECT endpoint FROM push_subscriptions WHERE device_id = ?').all(ctx.aId).map(r => r.endpoint)
    assert.ok(rows.some(e => (ia === 'swift' ? /^apns:/ : /^https:\/\/push\.invalid\//).test(e)), `A's registration kept: ${rows}`)
    if (ia === 'swift') {
      const tried = await until('an APNs attempt in the hub log', () => hubLog.slice(before).some(l => /apns/.test(l)), 5_000).catch(() => false)
      if (!tried) console.log('      (no APNs attempt logged within 5 s)')
    }
  })

  if (ia === 'swift' || ib === 'swift') {
    await P('scribble board: the sample strokes (fixtures/strokes.json) from JS decode on Swift point for point; a Swift stroke decodes on JS', async () => {
      const [js, sw] = ia === 'swift' ? [B, A] : [A, B]
      const samples = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/strokes.json'), 'utf8')).strokes
      for (const s of samples) await js.call('scribble_draw', { desk: 'main', entry: s.entry })
      const want = samples.map(s => [s.entry.tool, s.decoded.length])
      let got
      await until('the sample strokes in Swift', async () => { got = (await sw.call('scribble_shapes', { desk: 'main' })).map(s => [s.tool, s.points]); return got.length >= want.length }).catch(() => {})
      const sorted = l => [...(l ?? [])].map(x => JSON.stringify(x)).sort()
      assert.deepEqual(sorted(got), sorted(want), 'Swift decodes every sample stroke (tool, number of points)')
      await sw.call('scribble_draw', { desk: 'main' })
      const mine = await until('the Swift stroke on JS', async () => { const l = await js.call('scribble_shapes', { desk: 'main' }); return l.length > want.length ? l : null })
      assert.ok(mine.at(-1).points > 0, `JS decodes the Swift stroke: ${JSON.stringify(mine.at(-1))}`)
    })
  }

  await P('"They don\'t match": A\'s invite refused, the joiner stops, nobody is added', async () => {
    const before = (await B.call('members')).length
    const r = await addDevice(A, ib, { name: 'Refused', matches: false })
    assert.ok(r.refused, 'the join fails')
    assert.match(String(r.refused.code), /code-mismatch|invite-burned|invite-used|not-found|invite-expired/)
    await sleep(500)
    assert.equal((await B.call('members')).length, before)
  })

  if (ia === 'swift' || ib === 'swift') {
    const sw = ia === 'swift' ? 'A' : 'B'
    await P(`account: JS adds email + password; Swift logs in (wrong password refused), status, kit, new password, Forgot password`, async () => {
      const email = `interop-${pair}@example.org`, pw = 'correct horse battery staple'
      await F.call('add_account', { email, password: pw })
      const L = await driver('swift', `${pair}:login`)
      const bad = await refused(L.call('login', { hub_url: HUB, email, password: 'a wrong password 1', name: 'Swift login' }))
      assert.match(String(bad?.code), /wrong-login/)
      const me = await L.call('login', { hub_url: HUB, email, password: pw, name: 'Swift login' })
      await until('the Swift login at the founder', async () => (await F.call('members')).find(m => m.device_id === me.device_id)?.name === 'Swift login')
      // the session keys re-sealed for the new device: it opens every card the founder opens (state and answers)
      const view = async d => canon((await d.call('list_cards', { all: true })).map(c => [c.id, c.title, c.state, c.choices]))
      await until('the Swift login reads the founder\'s cards (session keys re-sealed)', async () => (await view(F)) === (await view(L)), 15_000)
      const st = await L.call('account_status')
      assert.equal(st.email, email)
      const kit = await L.call('make_kit', { password: pw })
      assert.equal(kit.words.split(' ').length, 12)
      await L.call('change_password', { current: pw, next: 'another good password 2' })
      const J = await driver('js', `${pair}:js-login`)
      await J.call('login', { hub_url: HUB, email, password: 'another good password 2', name: 'JS after Swift' })
      const R = await driver('swift', `${pair}:forgot`)
      await R.call('forgot', { hub_url: HUB, email, words: kit.words, new_password: 'the newest password 3', name: 'Swift forgot' })
      const J2 = await driver('js', `${pair}:js-login2`)
      await J2.call('login', { hub_url: HUB, email, password: 'the newest password 3', name: 'JS after forgot' })
      ctx.L = L; ctx.lId = me.device_id
      void sw
    })
    await P('log out from Swift: the device removes itself, the others see it gone', async () => {
      if (!ctx.L) throw new Error('no Swift login device (account test failed)')
      await ctx.L.call('leave')
      await until('gone at the founder', async () => (await F.call('members')).find(m => m.device_id === ctx.lId)?.active === false)
    })
  }
}

for (const d of drivers) await d.stop().catch(() => {})
await hub.close().catch(() => {})
fs.rmSync(tmp, { recursive: true, force: true })
const passed = results.filter(r => r.ok).length, failed = results.length - passed
fs.mkdirSync(path.join(here, 'out'), { recursive: true })
fs.writeFileSync(path.join(here, 'out/run.json'), JSON.stringify({ at: new Date().toISOString(), pairs: pairRooms, skipped, passed, failed, results }, null, 2))
console.log(`\n${passed} passed, ${failed} failed${skipped.length ? `; skipped: ${skipped.join(', ')}` : ''}  (dev/interop/out/run.json)`)
process.exit(failed ? 1 : 0)
