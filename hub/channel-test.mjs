// channel-test.mjs: node hub/channel-test.mjs
//
// Part 1 (always): the bridge between tools/events and client/core, against a recording stand-in for the
//   client: tool -> core call mapping, command -> channel event mapping, permission relay, files.
// Part 2 (when client/core/index.mjs and hub/server.mjs exist): the real thing. A hub on a free port
//   8891-8899, a scripted human from client/core, and hub/channel.mjs spawned as a real MCP stdio child:
//   join via agent invite, introduce, decision round trips, hand back, explain, decide again, shred, info read,
//   permission round trip, forged commands rejected, restart reuses the identity.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBridge } from './channel-bridge.mjs'
import { TOOLS, TOOL_EXAMPLES } from './channel-tools.mjs'

let passed = 0, failed = 0
const results = []
async function test(name, fn) {
  try { await fn(); passed++; results.push(`ok   ${name}`) } catch (err) { failed++; results.push(`FAIL ${name}\n     ${err.stack?.split('\n').slice(0, 4).join('\n     ')}`) }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trommi-channel-'))

// ---- part 1: the bridge against a recording client -------------------------------------------------------

function fakeClient() {
  const me = 'a'.repeat(64)
  const calls = []
  let n = 0
  const id = () => (++n).toString(16).padStart(32, '0')
  const model = {
    room: { my_device_id: me }, cards: new Map(), published: new Map(), stack: [],
    sessions: new Map([[me, { status_lines: [], profile: null, registers: new Map() }]]),
  }
  const card = (object_id, fields) => {
    const c = { object_id, agent_device_id: me, object_state: 'open', urgency: fields.urgency ?? 'normal', object_version: 1, first_envelope_number: n, answers: [], answer: null, in_revision: null, ...fields }
    model.cards.set(object_id, c); model.stack.push(object_id)
    return c
  }
  return {
    calls, model, me,
    async sendCard(f) { calls.push(['sendCard', f]); const i = id(); card(i, f); return i },
    async revise(i, f) { calls.push(['revise', i, f]); Object.assign(model.cards.get(i), f, { object_version: model.cards.get(i).object_version + 1, in_revision: null }) },
    async setUrgency(i, u, r) { calls.push(['setUrgency', i, u, r]); model.cards.get(i).urgency = u },
    async withdraw(i, r) { calls.push(['withdraw', i, r]); model.cards.get(i).object_state = 'closed' },
    async merge(ids, f) { calls.push(['merge', ids, f]); for (const i of ids) model.cards.get(i).object_state = 'closed'; const i = id(); card(i, f); return i },
    async close(i, s) { calls.push(['close', i, s]); (model.cards.get(i) ?? model.published.get(i)).object_state = 'closed' },
    async sendMessage(m) { calls.push(['sendMessage', m]) },
    async setStatus(v) {
      calls.push(['setStatus', v])
      const s = model.sessions.get(me)
      for (const [k, val] of Object.entries(v)) {
        if (k === 'profile') s.profile = val
        if (k.startsWith('status_line/')) {
          const sid = k.slice(12)
          s.status_lines = s.status_lines.filter(l => l.id !== sid)
          if (val) s.status_lines.push({ id: sid, ...val })
        }
      }
    },
    async requestPermission(p) { calls.push(['requestPermission', p]); return id() },
    async publish(p) { calls.push(['publish', p]); const i = id(); model.published.set(i, { object_id: i, agent_device_id: me, object_state: 'open', ...p }); return i },
    async uploadAttachment(bytes, meta) { calls.push(['upload', bytes.length, meta]); const i = id(); return { attachment_id: i, file_key: 'k', sha256: 's', total_size: bytes.length, ...meta } },
    async settle() {},
    async unpublish(i) { calls.push(['unpublish', i]); model.published.get(i).object_state = 'closed' },
    async shareAttachment(ref, o) { calls.push(['share', ref.attachment_id, o]); const share_id = id(); return { share_id, expires_at: o.expires_at, link: `https://app.trommi.com/a/${share_id}#s.k.h` } },
    async revokeShare(sid) { calls.push(['unshare', sid]) },
    async fetchAttachment(ref) { return new TextEncoder().encode(`bytes of ${ref.file_name}`) },
  }
}

function bridgeWith() {
  const client = fakeClient()
  const events = []
  const state = {}
  const bridge = createBridge({ client, notify: async (method, params) => events.push({ method, ...params }), cacheDir: path.join(tmp, 'files'), state })
  return { client, events, bridge, state }
}

await test('every tool has a schema and an example; the copied set is complete', async () => {
  const names = TOOLS.map(t => t.name)
  for (const n of ['reply', 'create_decision', 'create_info', 'revise_card', 'merge_cards', 'set_urgency', 'withdraw_card', 'close_card', 'set_status', 'clear_status', 'introduce', 'list_cards', 'publish_asset', 'list_assets', 'revoke_asset', 'share_asset', 'adopt_session', 'create_voiceover']) assert.ok(names.includes(n), n)
  for (const t of TOOLS) assert.ok(TOOL_EXAMPLES[t.name], `example for ${t.name}`)
})

await test('create_decision -> sendCard with README body names; recommended, urgency', async () => {
  const { client, bridge } = bridgeWith()
  const out = await bridge.callTool('create_decision', TOOL_EXAMPLES.create_decision)
  const [kind, f] = client.calls[0]
  assert.equal(kind, 'sendCard')
  assert.equal(f.card_type, 'decision')
  assert.equal(f.allows_multiple, false)
  assert.equal(f.recommended, 'tonight')
  assert.equal(f.urgency, 'high')
  assert.equal(f.options.length, 2)
  assert.match(out, /^card [0-9a-f]{32} created/)
})

await test('create_decision with a text block derives sections and options', async () => {
  const { client, bridge } = bridgeWith()
  await bridge.callTool('create_decision', { title: 'Which?', text: 'Intro.\n\n[a*] Alpha: first\n\n[b] Beta: second' })
  const f = client.calls[0][1]
  assert.deepEqual(f.options.map(o => o.key), ['a', 'b'])
  assert.equal(f.recommended, 'a')
  assert.equal(f.sections.length, 3)
})

await test('bad questions are refused before anything is sent', async () => {
  const { client, bridge } = bridgeWith()
  await assert.rejects(bridge.callTool('create_decision', { title: 'x', options: [{ key: 'a', label: 'A' }] }), /two entries/)
  await assert.rejects(bridge.callTool('create_info', { title: 'x', options: [] }), /an info has no options/)
  await assert.rejects(bridge.callTool('set_urgency', { card_id: 'ffff', urgency: 'high' }), /no card/)
  assert.equal(client.calls.length, 0)
})

await test('attachments by absolute path are uploaded and referenced, with marks and the page beside', async () => {
  const { client, bridge } = bridgeWith()
  const png = path.join(tmp, 'shot-a.png')
  const buf = Buffer.alloc(33); buf.set([0x89, 0x50, 0x4e, 0x47]); buf.writeUInt32BE(640, 16); buf.writeUInt32BE(480, 20)
  fs.writeFileSync(png, buf)
  fs.writeFileSync(path.join(tmp, 'shot-a.html'), '<p>page</p>')
  await bridge.callTool('create_info', { title: 'Look', body: 'see', attachments: [{ path: png, mark: { x: 0.1, y: 0.2, w: 0.3, h: 0.1, label: 'here' } }] })
  const uploads = client.calls.filter(c => c[0] === 'upload')
  assert.equal(uploads.length, 2)
  const f = client.calls.find(c => c[0] === 'sendCard')[1]
  assert.equal(f.attachments[0].file_name, 'shot-a.png')
  assert.equal(f.attachments[0].width, 640)
  assert.deepEqual(f.attachments[0].marks, [{ x: 0.1, y: 0.2, width: 0.3, height: 0.1, label: 'here' }])
  assert.match(f.attachments[0].page, /^attachment:/)
  assert.equal(f.attachments[1].role, 'page')
})

await test('reply: chat to the session, on a card, present rules after hand back and explain', async () => {
  const { client, bridge } = bridgeWith()
  const id = (await bridge.callTool('create_decision', TOOL_EXAMPLES.create_decision)).split(' ')[1]
  await bridge.callTool('reply', { text: 'hi' })
  assert.deepEqual(client.calls.at(-1), ['sendMessage', { text: 'hi', attachments: [] }])
  client.model.cards.get(id).in_revision = { by: 'hand_back' }
  const out = await bridge.callTool('reply', { text: 'on it', card_id: id.slice(0, 8) })
  assert.equal(client.calls.at(-1)[1].object_id, id)
  assert.equal(client.calls.at(-1)[1].present_card, undefined)
  assert.match(out, /stays with you/)
  await bridge.callTool('reply', { text: 'done', card_id: id, present: true })
  assert.equal(client.calls.at(-1)[1].present_card, true)
  client.model.cards.get(id).in_revision = { by: 'explain' }
  await bridge.callTool('reply', { text: 'it means', card_id: id })
  assert.equal(client.calls.at(-1)[1].present_card, true)
})

await test('revise, set_urgency, withdraw, merge, close map onto the core', async () => {
  const { client, bridge } = bridgeWith()
  const a = (await bridge.callTool('create_decision', TOOL_EXAMPLES.create_decision)).split(' ')[1]
  const b = (await bridge.callTool('create_decision', { title: 'B?', options: [{ key: 'y', label: 'Yes' }, { key: 'n', label: 'No' }] })).split(' ')[1]
  const c = (await bridge.callTool('create_decision', { title: 'C?', options: [{ key: 'y', label: 'Yes' }, { key: 'n', label: 'No' }] })).split(' ')[1]
  await bridge.callTool('revise_card', { card_id: a, title: 'Tonight?', note: 'shorter' })
  const rev = client.calls.find(x => x[0] === 'revise')
  assert.equal(rev[2].title, 'Tonight?'); assert.equal(rev[2].change_note, 'shorter'); assert.equal(rev[2].recommended, 'tonight')
  await bridge.callTool('set_urgency', { card_id: a, urgency: 'critical', reason: 'blocked' })
  assert.deepEqual(client.calls.at(-1), ['setUrgency', a, 'critical', 'blocked'])
  await bridge.callTool('withdraw_card', { card_id: c, reason: 'moot' })
  assert.deepEqual(client.calls.at(-1), ['withdraw', c, 'moot'])
  await assert.rejects(bridge.callTool('revise_card', { card_id: c, title: 'x' }), /already done/)
  const merged = await bridge.callTool('merge_cards', { card_ids: [a, b], title: 'Both?', multiple: true, options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] })
  assert.match(merged, /replacing/)
  assert.equal(client.calls.find(x => x[0] === 'merge')[2].urgency, 'critical')
  client.model.cards.get(a).object_state = 'answered'
  await bridge.callTool('close_card', { card_id: a, summary: 'ran' })
  assert.deepEqual(client.calls.at(-1), ['close', a, 'ran'])
})

await test('set_status, clear_status, introduce write the agent registers', async () => {
  const { client, bridge } = bridgeWith()
  await assert.rejects(bridge.callTool('set_status', { id: 't', state: 'working' }), /label is required/)
  await bridge.callTool('set_status', { id: 't', label: 'Tests', state: 'working', detail: 'running' })
  assert.deepEqual(client.calls.at(-1), ['setStatus', { 'status_line/t': { label: 'Tests', state: 'working', detail: 'running', object_id: null } }])
  await bridge.callTool('set_status', { id: 't', state: 'done' })
  assert.equal(client.calls.at(-1)[1]['status_line/t'].label, 'Tests')
  await bridge.callTool('clear_status', {})
  assert.deepEqual(client.calls.at(-1), ['setStatus', { 'status_line/t': null }])
  await bridge.callTool('introduce', TOOL_EXAMPLES.introduce)
  assert.deepEqual(client.calls.at(-1)[1].profile, { model: 'Claude Opus 5.5', task: 'Prepare migration and deploy', icon: 'database' })
})

await test('list_cards, publish_asset, list_assets, revoke_asset; the unported tools say so', async () => {
  const { client, bridge } = bridgeWith()
  await bridge.callTool('create_decision', TOOL_EXAMPLES.create_decision)
  const list = JSON.parse(await bridge.callTool('list_cards', {}))
  assert.equal(list.length, 1); assert.equal(list[0].status, 'open'); assert.equal(list[0].queue_position, 1)
  const out = await bridge.callTool('publish_asset', { content: '<h1>x</h1>', title: 'Report' })
  const id = out.match(/published as ([0-9a-f]{32})/)[1]
  assert.equal(client.calls.find(c => c[0] === 'publish')[1].attachments[0].media_type, 'text/html')
  const told = client.calls.find(c => c[0] === 'sendMessage')[1]
  assert.equal(told.text, '**Report**'); assert.equal(told.published_object_id, id); assert.equal(told.attachments[0].media_type, 'text/html')
  assert.equal(JSON.parse(await bridge.callTool('list_assets', {}))[0].id, id)
  const shared = await bridge.callTool('share_asset', { id, expires_hours: 2 })
  assert.match(shared, /Link for the recipient: https:\/\/app\.trommi\.com\/a\/[0-9a-f]{32}#/)
  const share = client.calls.find(c => c[0] === 'share')
  assert.ok(Math.abs(share[2].expires_at - Date.now() - 2 * 3600000) < 5000)
  assert.ok(JSON.parse(await bridge.callTool('list_assets', {}))[0].released_until)
  await assert.rejects(bridge.callTool('share_asset', { id, expires_hours: 24 * 31 }), /at most 30 days/)
  assert.match(await bridge.callTool('share_asset', { id, release: false }), /release taken back/)
  assert.equal(client.calls.filter(c => c[0] === 'unshare').length, 1)
  await bridge.callTool('share_asset', { id })
  await bridge.callTool('revoke_asset', { id })
  assert.deepEqual(client.calls.slice(-2).map(c => c[0]), ['unshare', 'unpublish'])
  assert.deepEqual(JSON.parse(await bridge.callTool('list_assets', {})), [], 'a revoked asset is gone from the list')
  await assert.rejects(bridge.callTool('create_voiceover', { text: 'x' }), /not available/)
  await assert.rejects(bridge.callTool('adopt_session', { id: 'x' }), /introduce with parent/)
})

await test('commands become the same channel events as today', async () => {
  const { client, bridge, events } = bridgeWith()
  const id = (await bridge.callTool('create_decision', { ...TOOL_EXAMPLES.create_decision, multiple: true, recommended: ['tonight'] })).split(' ')[1]
  await bridge.command({ command: 'message', envelope_number: 5, content: { text: 'hello' } })
  assert.deepEqual(events.at(-1), { method: 'notifications/claude/channel', content: 'hello', meta: { kind: 'chat' } })
  await bridge.command({ command: 'message', object_id: id, content: { text: 'rework', hand_back: true, attachments: [{ attachment_id: 'f'.repeat(32), file_name: 'x.png', media_type: 'image/png' }] } })
  const ev = events.at(-1)
  assert.equal(ev.meta.card_id, id); assert.equal(ev.meta.handback, '1')
  assert.ok(fs.readFileSync(ev.meta.image_path, 'utf8').includes('x.png'))
  assert.equal((fs.statSync(ev.meta.image_path).mode & 0o777).toString(8), '600')
  await bridge.command({ command: 'message', object_id: id, content: { text: 'why?', explain: true } })
  assert.equal(events.at(-1).meta.explain, '1')
  await bridge.command({ command: 'answer', object_id: id, choices: ['tonight', 'now'], content: { note: 'go', option_notes: { now: 'not now' } } })
  assert.deepEqual(events.at(-1).meta, { kind: 'decision', card_id: id, choice: 'tonight', choices: 'tonight,now', option_notes: 'now' })
  assert.match(events.at(-1).content, /Notes on options:\n- Now \[now\], chosen: not now/)
  client.model.cards.get(id).answers = [{ answer_action: 'answer', choices: ['tonight', 'now'], taken_back_at: 9 }]
  await bridge.command({ command: 'decide_again', object_id: id, content: {} })
  assert.deepEqual(events.at(-1).meta, { kind: 'decision_reopened', card_id: id, previous_choice: 'tonight', previous_choices: 'tonight,now' })
  await bridge.command({ command: 'shred', object_id: id, content: { note: 'meh' } })
  assert.equal(events.at(-1).meta.kind, 'shredded'); assert.match(events.at(-1).content, /Their note: meh/)
  await bridge.command({ command: 'read', object_id: id, content: {} })
  assert.deepEqual(events.at(-1).meta, { kind: 'info_read', card_id: id })
  await bridge.command({ command: 'trust', object_id: id, content: {} })
  assert.equal(events.at(-1).meta.trust, '1'); assert.equal(events.at(-1).meta.choice, 'tonight')
  await bridge.command({ command: 'selection_sent', envelope_number: 77, content: { text: 'ship it', stroke_ids: ['s1', 's2'] } })
  assert.deepEqual(events.at(-1).meta, { kind: 'pad', pad: 'global', message_id: '77', elements: 's1,s2' })
})

await test('history and late commands are marked; strokes are never chat', async () => {
  const { bridge, events } = bridgeWith()
  await bridge.command({ command: 'message', content: { content_type: 'message', text: 'old' }, history: true, late: true })
  assert.deepEqual(events.at(-1).meta, { kind: 'chat', late: '1', history: '1' })
  assert.match(events.at(-1).content, /^\(Earlier message, for context only; not a new request\.\)\nold$/)
  await bridge.command({ command: 'message', content: { content_type: 'strokes', strokes: [] } })
  assert.equal(events.length, 1)
})

await test('review 2 PoC: a human cannot write outside the cache through attachment_id or file_name', async () => {
  const { client, bridge, events } = bridgeWith()
  const outside = path.join(tmp, 'outside')
  fs.mkdirSync(outside, { recursive: true })
  let fetched = 0
  client.fetchAttachment = async () => { fetched++; return new TextEncoder().encode('pwned') }
  const up = '../'.repeat(12)
  await bridge.command({ command: 'message', content: { content_type: 'message', text: 'look', attachments: [
    { attachment_id: `${'a'.repeat(32)}?x=/${up}${outside.slice(1)}/evil`, file_name: 'rc' },
    { attachment_id: `${'b'.repeat(32)}/../../../evil`, file_name: 'rc' },
    { attachment_id: 'c'.repeat(32), file_name: `${up}${outside.slice(1)}/evil` },
    { attachment_id: 'd'.repeat(32), file_name: '..' },
  ] } })
  assert.equal(fs.readdirSync(outside).length, 0, 'a file was written outside the cache')
  assert.equal(fetched, 2, 'a malformed attachment id reached the hub')
  const files = events.at(-1).meta.files.split(',')
  for (const f of files) assert.equal(path.dirname(f), path.join(tmp, 'files'))
  assert.deepEqual(files.map(f => path.basename(f)), [`${'c'.repeat(32)}-evil`, `${'d'.repeat(32)}-file`])
})

await test('a halted chain stops every tool with a clear error, nothing is sent', async () => {
  const { client, bridge } = bridgeWith()
  client.settle = async () => { throw Object.assign(new Error('chain halted'), { code: 'chain-halted' }) }
  await assert.rejects(bridge.callTool('reply', { text: 'hi' }), /stopped sending/)
  assert.equal(client.calls.length, 0)
})

await test('parity: take back is handback_withdrawn; an info read and taken back stays quiet', async () => {
  const { client, bridge, events } = bridgeWith()
  const q = (await bridge.callTool('create_decision', TOOL_EXAMPLES.create_decision)).split(' ')[1]
  await bridge.command({ command: 'message', object_id: q, content: { content_type: 'message', text: 'took it back', present_card: true } })
  assert.deepEqual(events.at(-1).meta, { kind: 'handback_withdrawn', card_id: q })
  assert.match(events.at(-1).content, /no need to rework or explain it/)
  const i = (await bridge.callTool('create_info', { title: 'Read me', body: 'x' })).split(' ')[1]
  client.model.cards.get(i).answers = [{ answer_action: 'read', taken_back_at: 12 }]
  const n = events.length
  await bridge.command({ command: 'decide_again', object_id: i, content: {} })
  assert.equal(events.length, n)
})

await test('permission relay: request -> object, verdict -> notifications/claude/channel/permission', async () => {
  const { client, bridge, events, state } = bridgeWith()
  const params = { request_id: 'abcde', tool_name: 'Bash', description: 'Run shell command', input_preview: '{"command":"npm test"}' }
  const [id] = await Promise.all([bridge.permissionRequest(params), bridge.permissionRequest(params)])   // back to back, the second while the first is sealed
  await bridge.permissionRequest(params)
  assert.equal(client.calls.filter(c => c[0] === 'requestPermission').length, 1)
  assert.equal(state.permissions[id], 'abcde')
  await bridge.command({ command: 'verdict', object_id: id, allow: true, content: {} })
  assert.deepEqual(events.at(-1), { method: 'notifications/claude/channel/permission', request_id: 'abcde', behavior: 'allow' })
  await bridge.command({ command: 'verdict', object_id: id, allow: true, content: {} })
  assert.equal(events.length, 1)
})

await test('slot lock: a live claim keeps the slot busy, a dead one is cleared, unlock gives it back', async () => {
  const { lockSlot, unlockSlot } = await import('./channel-lock.mjs')
  const dir = path.join(tmp, 'lock-unit'), p = { dir, lock_file: path.join(dir, 's.lock') }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(`${p.lock_file}.${process.ppid}`, '')          // a live process (our parent) holds it
  assert.equal(lockSlot(p), false)
  assert.ok(!fs.existsSync(`${p.lock_file}.${process.pid}`), 'a losing claim stays behind')
  fs.rmSync(`${p.lock_file}.${process.ppid}`)
  fs.writeFileSync(`${p.lock_file}.999999`, '')                    // a crashed process
  assert.equal(lockSlot(p), true)
  assert.deepEqual(fs.readdirSync(dir).sort(), [`s.lock.${process.pid}`])
  unlockSlot(p)
  assert.deepEqual(fs.readdirSync(dir), [])
})

await test('slot lock: of processes starting together, exactly one gets the slot, also over a stale lock (review 2 PoC)', async () => {
  const { execFile } = await import('node:child_process')
  const lockMod = new URL('./channel-lock.mjs', import.meta.url).href
  const dir = path.join(tmp, 'locks')
  const child = at => `import { lockSlot } from ${JSON.stringify(lockMod)}; while (Date.now() < ${at}) {}; console.log(await lockSlot({ dir: ${JSON.stringify(dir)}, lock_file: ${JSON.stringify(path.join(dir, 's-1.lock'))} }) ? 'GOT' : 'busy'); setTimeout(() => {}, 1500)`   // the winner holds on: a lock left by an exited winner is rightly stale
  const bad = []
  for (let run = 0; run < 12; run++) {
    fs.mkdirSync(dir, { recursive: true })
    if (run % 2) fs.writeFileSync(path.join(dir, 's-1.lock.999999'), '')     // the claim of a crashed process
    const at = Date.now() + 700
    const got = await Promise.all([0, 1, 2, 3].map(() => new Promise(res => execFile(process.execPath, ['--input-type=module', '-e', child(at)], (e, out) => res(String(out).trim())))))
    if (got.filter(g => g === 'GOT').length !== 1) bad.push(`run ${run}: ${got.join(' ')}`)
    fs.rmSync(dir, { recursive: true, force: true })
  }
  assert.equal(bad.join('; '), '')
})

// ---- part 2: real hub, real core, the channel as an MCP child --------------------------------------------

const here = path.dirname(new URL(import.meta.url).pathname)
const haveCore = fs.existsSync(path.join(here, '../client/core/index.mjs')) && fs.existsSync(path.join(here, '../client/core/agent.mjs'))
const haveHub = fs.existsSync(path.join(here, 'server.mjs'))
if (haveCore && haveHub) {
  const { integration } = await import('./channel-test-e2e.mjs')
  await integration({ test, tmp })
} else {
  results.push(`skip part 2 (end to end): ${[!haveCore && 'client/core is not complete yet', !haveHub && 'hub/server.mjs does not exist yet'].filter(Boolean).join(', ')}`)
}

console.log(results.join('\n'))
console.log(`\n${passed} passed, ${failed} failed`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
