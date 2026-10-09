// cache-mirror.test.mjs: two copies of a model built from hand-made core results (factory.mjs) stay equal to it:
// the app's local cache (model.ts cacheRecords -> JSON -> modelFromCache: what a warm start shows) and the page's
// copy of the worker's model (mirror.ts: a snapshot once, then one patch per change, each through structuredClone
// as postMessage clones).
//   node --test tests/web/model/
import test from 'node:test'
import assert from 'node:assert/strict'
import { packPoints } from '../../../app/web/core/ink.ts'
import { applyPatch, mirrorOf, patchOf, snapshotOf } from '../../../app/web/core/mirror.ts'
import { applyPresence, cacheAll, cacheItemKey, cacheRecords, compactCard, confirmEcho, echoAnswer, echoNote, echoRegisters, echoTimelineItem, emptyChange, expandCard, modelFromCache, project, rollbackEcho, timelineOf } from '../../../app/web/core/model.ts'
import { encodePiece } from '../../../app/web/core/codec.ts'
import { World, canon, device, hex, id16, bytes } from './factory.mjs'

const OPTIONS = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B', final: true }]
const firstDiff = (a, b) => { const x = canon(a), y = canon(b); if (x === y) return null; let i = 0; while (x[i] === y[i]) i++; return `${x.slice(Math.max(0, i - 140), i + 100)}\n   vs\n${y.slice(Math.max(0, i - 140), i + 100)}` }

/** A room with a bit of everything; `step` is called between the acts. */
function story(w, step = () => {}) {
  const helper = device(20), helperSession = id16(0x61), helperGroup = bytes(48, 0xcc)
  w.groups([{ group: helperGroup, session: { session_id: helperSession, parent: w.session }, epoch: 1, leaves: [w.me, w.phone, w.agent, helper] }])
  w.register(`device/${w.agent}`, { device_name: 'devbox', platform: 'linux', folder: '/srv/app', host: 'devbox' }, { sender: w.agent })
  w.register('profile', { model: 'opus', agent_name: 'Builder', icon: 'draw:brush' }, { sender: w.agent })
  w.register('status_line/tests', { label: 'Tests', state: 'working', detail: '1 of 3' }, { sender: w.agent })
  w.run(c => applyPresence(w.model, [{ device_id: hex(w.agent), is_online: true, link: { hears: 'oncall', attached: true, working: true, last_call_at: w.clock } }], c, w.clock))
  step('a room, its sessions and their agent')
  const [c1, c2, c3, c4] = [1, 2, 3, 4].map(k => id16(0xc0, k))
  const v1 = w.card(c1, { card_type: 'decision', title: 'One', body: 'b', options: OPTIONS, recommended: 'a', object_version: 1 }, { urgency: 'high' })
  w.card(c1, { card_type: 'decision', title: 'One, reworded', options: OPTIONS, change_note: 'clearer', object_version: 2 }, { urgency: 'high', previous: v1.hash })
  w.card(c2, { card_type: 'info', title: 'Two', object_version: 1 })
  w.card(c3, { title: 'Three', options: OPTIONS, object_version: 1 }, { sender: helper, session: helperSession, group: helperGroup })
  w.card(c4, {}, { outcome: 'chained', code: 'pruned' })
  const a = w.answer(c1, { answer_action: 'answer', choices: ['a'], note: 'yes', option_notes: { a: 'this' } })
  w.takeBack(c1, a.hash)
  w.answer(c2, { answer_action: 'read' }, { state: 'closed' })
  w.answer(c3, { answer_action: 'answer', choices: ['b'] }, { state: 'closed' })
  step('cards, answers, a take back')
  w.message({ text: 'working on it', terminal: 'answer' })
  w.message({ text: 'not like this', hand_back: true }, { card: c1, sender: w.me })
  w.trail(w.session, { turn: id16(0x77), number: 1, step: { text: 'Reading', tool: 'Read' } }, ++w.change)
  w.trail(w.session, { turn: id16(0x77), number: 2, step: { text: 'Thinking about it' } }, ++w.change)
  timelineOf(w.model, `chat:card/${hex(c2)}`).window_open = true
  w.message({}, { card: c2, outcome: 'chained', code: 'pruned' })
  step('conversations and a work trail')
  w.register(`draft/${c1}`, { keys: ['b'], note: 'hm' }); w.register(`snooze/${c4}`, { until: w.clock + 3_600_000 }); w.register(`duck/${c1}`, { at: 1 })
  w.register('crown', { session_id: w.session }); w.register(`desk/${id16(0xd1)}`, { name: 'Work', created_at: 1, order: 0 }); w.register(`session/${w.session}`, { name: 'Builder', desk: id16(0xd1) })
  w.register(`session/${helperSession}`, { archived: true }); w.register(`draft/${c2}`, { note: 'x' }); w.register(`draft/${c2}`, null)
  step('registers')
  const req = id16(0xa1), nid = id16(0xb1), art = id16(0xc7), nh = w.hash()
  w.take({ kind: 'request', object: w.object(req, 'request', 'open', { urgency: 'critical' }), payload: { schema_version: 2, tool_name: 'Bash', description: 'd', input_preview: 'ls' }, bind: { kind: 'request', request_id: req, expires_at: w.clock + 60_000 } })
  w.take({ kind: 'version', sender: w.me, session: null, hash: nh, object: w.object(nid, 'note'), payload: { schema_version: 2, text: 'milk', place: 'desk', lamport: 1 }, object_after: { object_id: nid, owner: w.me, object_state: 'open', current_version: nh } })
  w.take({ kind: 'version', object: w.object(art, 'artifact'), payload: { schema_version: 2, artifact_type: 'page', title: 'Report', object_version: 1, attachments: [{ file_id: id16(0xf1), file_key: bytes(32, 1), sha256: bytes(32, 2), file_name: 'r.html', media_type: 'text/html', total_size: 10 }] } })
  w.card(id16(0xc0, 9), { card_type: 'poll', title: 'From a newer Trommi', object_version: 1 })
  w.take({ kind: 'version', object: w.object(id16(0xc0, 8), 'card'), outcome: 'refused', code: 'bad-signature', object_after: null })
  step('a permission request, a note, an Artifact, an alert')
  const board = id16(0xde), timeline = { kind: 'board', scope: 'desk', ref: board }
  w.take({ kind: 'item', sender: w.phone, session: null, timeline, payload: { schema_version: 2, content_type: 'strokes', strokes: [{ tool: 'pen', color: 'ink', width: 64, points: packPoints({ pts: [1, 1, 2, 2], t: [0, 8], f: [0.3, 0.3] }) }] } })
  w.piece(board, encodePiece({ stroke: hex(id16(0x99)), number: 1, tool: 'pen', color: 'ink', width: 4, points: packPoints({ pts: [5, 5], t: [0], f: [0.3] }) }))
  w.register(`board_snapshot/${board}`, { attachment: { file_id: id16(0xf5), file_key: bytes(32, 1), sha256: bytes(32, 2), file_name: 'b.gz', media_type: 'application/gzip', total_size: 7 }, frontier: { [w.phone]: [1, bytes(32, 9)] }, change: 40 })
  step('a board, a stroke in progress, its snapshot')
  return { c1, c4, nid }
}

test('the cache: the records of every change, through JSON, give the model back', () => {
  const w = new World()
  const store = new Map()
  const write = entries => { for (const [key, value] of entries) { if (value === undefined) store.delete(key); else store.set(key, JSON.parse(JSON.stringify(value))) } }
  w.onChange = c => write(cacheRecords(w.model, c))
  const { c1 } = story(w)
  w.model.room.room_id = 'ab'.repeat(32); w.model.room.hub_url = 'https://hub.example'; w.model.room.last_envelope_number = w.change
  w.run(c => { c.room = true })
  // What a warm start reads: every record but the timeline items (their windows are read on demand).
  const warm = modelFromCache([...store].filter(([key]) => !key.startsWith('tl/')))
  project(warm, emptyChange(), w.clock)
  // What the cache does not hold: the windows, live strokes, the connection.
  const expected = structuredClone({ ...w.model, _builder: undefined })
  for (const t of expected.timelines.values()) { t.items = new Map(); t.loaded_down_to = Infinity; t.window_open = false }
  const d = firstDiff(warm, expected)
  assert.equal(d, null, `the model from the cache differs:\n${d}`)
  assert.deepEqual(warm.stack, w.model.stack); assert.ok(warm.stack.length > 0); assert.equal(warm.cards.get(hex(c1)).answers.length, 1)
  assert.equal(warm.sessions.get(hex(w.session)).settings, warm.human.session_settings.get(hex(w.session)), 'a session\'s settings are its register\'s value')
  // the items: one record each, in the hub's order within their timeline
  const key = `chat:session/${hex(w.session)}`
  const items = [...store].filter(([k]) => k.startsWith(`tl/${key}/`)).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v)
  assert.deepEqual(items.map(i => i.envelope_number), [...w.model.timelines.get(key).items.values()].map(i => i.envelope_number).sort((a, b) => a - b))
  assert.equal(store.has(cacheItemKey(key, items[0].envelope_number)), true); assert.ok([...store.keys()].every(k => !k.includes('live:')), 'a stroke in progress is not stored')
  // a rewrite of everything gives the same records
  const all = new Map(cacheAll(w.model).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]))
  for (const [k, v] of all) assert.deepEqual(store.get(k), v, k)
  // the model goes on from the cache as from the original
  const copy = new World(); copy.model = warm; copy.change = w.change; copy.seq = new Map(w.seq); copy.objects = structuredClone(w.objects); copy.clock = w.clock; copy.hashes = w.hashes
  for (const x of [w, copy]) x.answer(c1, { answer_action: 'answer', choices: ['b'] }, { state: 'closed' })
  assert.equal(warm.cards.get(hex(c1)).closed_how, 'settled'); assert.deepEqual(warm.stack, w.model.stack)
})

test('the cache: an own pending echo is not stored; a card at rest is stored once', () => {
  const w = new World(); w.groups()
  const id = id16(0xc1), hid = hex(id)
  w.card(id, { title: 'Q', body: 'a long text. '.repeat(40), options: OPTIONS, object_version: 1 })
  const card = w.model.cards.get(hid)
  const rest = compactCard(card)
  assert.ok(JSON.stringify(rest).length < JSON.stringify(card).length, 'the newest version\'s content is the card\'s own fields'); assert.deepEqual(expandCard(JSON.parse(JSON.stringify(rest))), JSON.parse(JSON.stringify(card)))
  w.run(c => echoAnswer(w.model, { local_id: 'A1', object_id: hid, answer: { answer_action: 'answer', choices: ['a'], note: null, option_notes: {}, attachments: [], marks: [], trusted: false, bound_version_hash: card.version_hash, bound_object_version: 1, envelope_number: null, envelope_hash: null, by_device_id: hex(w.me), answered_at: 1, taken_back_at: null, taken_back_sent_at: null }, object_state: 'answered' }, c))
  w.run(c => echoRegisters(w.model, { local_id: 'R1', values: { [`draft/${hid}`]: { note: 'pending' } } }, c))
  const noteKey = w.run(c => echoNote(w.model, { local_id: 'N1', fields: { text: 'pending' } }, c))
  const records = new Map(cacheRecords(w.model, { ...emptyChange(), cards: new Set([hid]), registers: new Set([`draft/${hid}`]), notes: new Set([noteKey]) }))
  assert.equal(records.get(`card/${hid}`).answer, null); assert.equal(records.has(`reg/draft/${hid}`), false); assert.equal(records.get(`note/${noteKey}`), undefined)
})

test('the page\'s copy: a snapshot, then a patch per change, is the model: records keep their identity, items are the copy\'s own', () => {
  const w = new World()
  const mirror = mirrorOf(structuredClone(snapshotOf(w.model)))
  let changes = 0
  const problems = []
  w.onChange = c => {
    const kept = [...c.cards].map(id => mirror.cards.get(id)).filter(Boolean)
    const change = applyPatch(mirror, structuredClone(patchOf(w.model, c)))
    changes++
    for (const card of kept) if (mirror.cards.get(card.object_id) !== card) problems.push(`card ${card.object_id} lost its identity`)
    for (const [key, list] of c.items) {
      const got = change.items.get(key) ?? []
      if (got.length !== list.filter(it => w.model.timelines.get(key).items.get(it.envelope_number ?? it.local_id) === it).length) problems.push(`items of ${key}: ${got.length} of ${list.length}`)
      if (got.some(it => mirror.timelines.get(key)?.items.get(it.envelope_number ?? it.local_id) !== it)) problems.push(`an item of ${key} is not the copy's own`)
    }
    for (const k of ['cards', 'sessions', 'permissions', 'notes', 'published', 'timelines', 'registers']) if (change[k].size !== c[k].size) problems.push(`change.${k}`)
    for (const k of ['members', 'alerts', 'stack', 'room']) if (change[k] !== c[k]) problems.push(`change.${k}`)
  }
  const same = what => { const d = firstDiff(mirror, { ...w.model, _builder: undefined }); assert.equal(d, null, `${what} (${changes} changes):\n${d}`) }
  const { c4, nid } = story(w, same)
  // echoes: shown, confirmed in place, rolled back
  const key = `chat:session/${hex(w.session)}`
  w.run(c => echoTimelineItem(w.model, { local_id: 'L1', timeline_key: key, content: { content_type: 'message', text: 'one' }, recipient_device_id: hex(w.agent), now: w.clock }, c))
  same('a pending message')
  const hash = w.hash()
  w.run(c => confirmEcho(w.model, 'L1', w.sealed(hash, 3), c)); w.message({ text: 'one' }, { sender: w.me, hash, seq: 3 })
  same('the message confirmed in its place')
  w.run(c => echoTimelineItem(w.model, { local_id: 'L2', timeline_key: key, content: { content_type: 'message', text: 'two' } }, c)); w.run(c => rollbackEcho(w.model, 'L2', c))
  same('a message rolled back')
  w.run(c => echoRegisters(w.model, { local_id: 'R1', values: { [`snooze/${hex(c4)}`]: null, crown: null } }, c)); same('registers echoed'); w.run(c => rollbackEcho(w.model, 'R1', c)); same('registers rolled back')
  w.run(c => echoNote(w.model, { local_id: 'N1', object_id: hex(nid), fields: { text: 'oat milk' } }, c)); same('a note echoed'); w.run(c => rollbackEcho(w.model, 'N1', c)); same('a note rolled back')
  w.clock += 3_600_000 * 2; w.run(() => {})
  same('the clock passed a snooze and a request\'s time')
  assert.deepEqual(problems, []); assert.ok(changes > 40)
})
