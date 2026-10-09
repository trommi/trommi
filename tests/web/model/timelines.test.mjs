// timelines.test.mjs: Chat items on a session and on a card in the model, "in revision" by hand_back and explain, a
// turn's work trail folded as the views fold it, and a page of a Chat fetched out of order. Hand-made core results
// (factory.mjs).
//   node --test tests/web/model/
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyPresence, cardHeard, timelineOf } from '../../../app/web/core/model.ts'
import { foldWork, isWork, workAnchor } from '../../../app/web/core/work.ts'
import { World, hex, id16, bytes } from './factory.mjs'

test('messages in a session\'s Chat: counted, shown in the window, ids and attachments in the model\'s form', () => {
  const w = new World(); w.groups()
  const key = `chat:session/${hex(w.session)}`
  const file = id16(0xf1), artifact = id16(0xc7), noteId = id16(0xb1)
  const a = w.message({ text: 'Done. The report is attached.', details: 'three pages', attachments: [{ file_id: file, file_key: bytes(32, 1), sha256: bytes(32, 2), file_name: 'r.pdf', media_type: 'application/pdf', total_size: 9 }], artifact_object_id: artifact, terminal: 'answer' })
  const b = w.message({ text: 'thanks', note: { object_id: noteId, written_at: 5 } }, { sender: w.me })
  const t = w.model.timelines.get(key)
  assert.equal(t.item_count, 2); assert.equal(t.newest_envelope_number, b.change); assert.equal(t.timeline_kind, 'chat'); assert.equal(t.timeline_id, `session/${hex(w.session)}`); assert.equal(t.object_id, hex(w.session))
  const first = t.items.get(a.change), second = t.items.get(b.change)
  assert.deepEqual({ ...first, content: null }, { envelope_number: a.change, local_id: null, pending: false, envelope_hash: hex(a.hash), sender_device_id: hex(w.agent), sender_sequence: 1,
    recipient_device_id: null, sent_at: a.time, item_state: 'loaded', content_type: 'message', content: null })
  assert.equal(first.content.attachments[0].attachment_id, hex(file)); assert.equal(first.content.published_object_id, hex(artifact), 'artifact_object_id on the wire'); assert.equal(first.content.terminal, 'answer')
  assert.equal(second.recipient_device_id, hex(w.agent)); assert.deepEqual(second.content.note, { object_id: hex(noteId), written_at: 5 })
  assert.deepEqual(w.last.items.get(key), [second]); assert.ok(w.last.timelines.has(key) && w.last.sessions.has(hex(w.session)))
  assert.equal(w.model.sessions.get(hex(w.session)).last_activity_at, b.time)
})

test('a card\'s Chat: hand_back and explain put the open card in revision; present_card or a new version takes it back', () => {
  const w = new World(); w.groups()
  const id = id16(0xc1), hid = hex(id)
  const v1 = w.card(id, { title: 'Q', options: [{ key: 'a', label: 'A' }], object_version: 1 })
  const back = w.message({ text: 'not like this', hand_back: true }, { card: id, sender: w.me })
  assert.deepEqual(w.model.cards.get(hid).in_revision, { by: 'hand_back', envelope_number: back.change }); assert.ok(w.last.cards.has(hid))
  assert.equal(w.model.timelines.get(`chat:card/${hid}`).item_count, 1)
  w.message({ text: 'here it is again', present_card: true }, { card: id })
  assert.equal(w.model.cards.get(hid).in_revision, null)
  const what = w.message({ text: 'What??', explain: true }, { card: id, sender: w.me })
  assert.deepEqual(w.model.cards.get(hid).in_revision, { by: 'explain', envelope_number: what.change })
  // the receipt: the agent's register `heard` says up to where it was handed his words
  assert.equal(cardHeard(w.model, w.model.cards.get(hid)), null, 'no mark yet')
  w.register('heard', { up_to: what.change - 1, at: 1 }, { sender: w.agent })
  assert.equal(cardHeard(w.model, w.model.cards.get(hid)), false)
  w.register('heard', { up_to: what.change, at: 2 }, { sender: w.agent })
  assert.equal(cardHeard(w.model, w.model.cards.get(hid)), true)
  w.card(id, { title: 'Q, explained', options: [{ key: 'a', label: 'A' }], object_version: 2 }, { previous: v1.hash })
  assert.equal(w.model.cards.get(hid).in_revision, null, 'a new version ends it')
  // an agent's message with hand_back is no hand-back; on an answered card a human's changes nothing
  w.message({ text: 'x', hand_back: true }, { card: id })
  assert.equal(w.model.cards.get(hid).in_revision, null)
  w.answer(id, { answer_action: 'answer', choices: ['a'] })
  w.message({ text: 'too late', hand_back: true }, { card: id, sender: w.me })
  assert.equal(w.model.cards.get(hid).in_revision, null)
})

test('a body that cannot be read here keeps its place: undecryptable, and a content type of a newer Trommi', () => {
  const w = new World(); w.groups()
  const key = `chat:session/${hex(w.session)}`
  timelineOf(w.model, key).window_open = true
  const a = w.message({}, { outcome: 'chained', code: 'no-key' })
  const b = w.message({ content_type: 'poll', question: '?' })
  const c = w.take({ kind: 'item', timeline: { kind: 'chat', scope: 'session', ref: w.session }, payload: { schema_version: 2, attachments: [{ file_id: 'no id' }] } })
  const t = w.model.timelines.get(key)
  assert.equal(t.items.get(a.change).item_state, 'undecryptable'); assert.equal(w.model.alerts.length, 0, 'a key this device never held is no finding')
  assert.equal(t.items.get(b.change).item_state, 'unsupported'); assert.ok(w.model.newer.what.includes('content_type poll'))
  assert.equal(t.items.get(c.change).item_state, 'undecryptable', 'a body that names no file under an attachment is not read')
  assert.equal(t.item_count, 3)
})

test('a page of a Chat fetched out of order fills the window and counts nothing', () => {
  const w = new World(); w.groups()
  const key = `chat:session/${hex(w.session)}`
  const live = w.message({ text: 'newest' }, { change: 50 })
  const old = w.message({ text: 'older' }, { outcome: 'provisional', change: 20, seq: 7 })
  const t = w.model.timelines.get(key)
  assert.equal(t.item_count, 1); assert.equal(t.newest_envelope_number, 50)
  assert.equal(t.items.get(20).content.text, 'older'); assert.equal(t.items.get(20).provisional, true); assert.deepEqual(w.last.items.get(key), [t.items.get(20)])
  // the page holds the live item too: what the chain confirmed is not replaced by its provisional copy
  w.take({ ...live.r, outcome: 'provisional' })
  assert.equal(t.items.get(50).provisional, undefined)
  assert.equal(old.result.applied, true)
})

test('a turn\'s work trail: its steps stand in the session\'s Chat and fold into one block, ended by the agent\'s answer', () => {
  const w = new World(); w.groups()
  const sid = hex(w.session), key = `chat:session/${sid}`, turn = id16(0x77)
  const step = (number, body, n) => w.trail(w.session, { turn, number, step: body }, n)
  const typed = w.message({ text: 'fix the test', terminal: 'input' }, { change: 100 })
  assert.equal(step(1, { text: 'Reading the test', tool: 'Read' }, 101), true)
  assert.equal(step(2, { text: 'I see the problem.' }, 102), true)
  assert.equal(step(3, { text: 'npm test', tool: 'Bash' }, 104), true)
  assert.ok(w.last.items.get(key)?.length === 1 && w.last.sessions.has(sid), 'each step is named in its change')
  assert.equal(step(4, { text: 'x', tool: null }, 105), false, 'a step the core would refuse is not shown')
  const t = w.model.timelines.get(key)
  assert.equal(t.item_count, 1, 'steps are no stored content: not counted')
  const items = () => [...t.items.values()].filter(i => isWork(i.content))
  assert.equal(items().length, 3); assert.ok(items().every(i => i.sender_device_id === hex(w.agent) && i.item_state === 'loaded' && i.content_type === 'message'))
  let block = foldWork(items().map(i => i.content.work))
  assert.equal(block.turn, hex(turn)); assert.equal(block.state, 'running'); assert.equal(block.seq, 3)
  assert.deepEqual(block.items.map(x => [x.id, x.kind, x.tool ?? null, x.title ?? x.text]), [['1', 'step', 'Read', 'Reading the test'], ['2', 'text', null, 'I see the problem.'], ['3', 'step', 'Bash', 'npm test']])
  assert.equal(block.started, items()[0].sent_at)
  assert.equal(workAnchor(items().map(i => i.envelope_number), [typed.change]), 101, 'the block stands at the turn\'s first step')

  const answer = w.message({ text: 'Fixed.', terminal: 'answer' }, { change: 106 })
  block = foldWork(items().map(i => i.content.work))
  assert.equal(block.state, 'done'); assert.equal(block.ended, answer.time)
  assert.ok(w.last.items.get(key).includes(t.items.get(104)), 'the change names the step that now says the turn ended')

  // another turn, cut off: the agent goes offline
  const next = id16(0x78)
  w.trail(w.session, { turn: next, number: 1, step: { text: 'again', tool: 'Read' } }, 110)
  assert.equal(t.items.get(110).content.work.state, 'running')
  w.run(c => applyPresence(w.model, [{ device_id: hex(w.agent), is_online: false, offline_since: w.clock }], c, w.clock))
  assert.equal(t.items.get(110).content.work.state, 'done')
})
