// stack-echoes.test.mjs: the stack projection (urgency, age, snooze, archived session, a desk's own stack), and the
// optimistic echoes of own sends: shown at once as pending, replaced in place when the hub's copy comes back, rolled
// back when it is refused. Hand-made core results (factory.mjs).
//   node --test tests/web/model/
import test from 'node:test'
import assert from 'node:assert/strict'
import { confirmEcho, echoAnswer, echoNote, echoRegisters, echoTimelineItem, rollbackEcho, stackOf } from '../../../app/web/core/model.ts'
import { World, device, hex, id16, bytes } from './factory.mjs'

const OPTIONS = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B', final: true }]

test('the stack: by urgency, then oldest first; snoozed cards and archived sessions are left out; one desk\'s stack', () => {
  const w = new World()
  const other = id16(0x52), otherGroup = { group: bytes(32, 0xbb, 2), session: { session_id: other, parent: null }, epoch: 1, leaves: [w.me, w.phone, device(11)] }
  w.groups([otherGroup], { agents: [w.agent, device(11)] })
  const [low, normal, high, critical, second] = [1, 2, 3, 4, 5].map(k => id16(0xc0, k))
  w.card(normal, { title: 'normal', object_version: 1 })
  w.card(low, { title: 'low', object_version: 1 }, { urgency: 'low' })
  w.card(critical, { title: 'critical', object_version: 1 }, { urgency: 'critical' })
  w.card(high, { title: 'high', object_version: 1 }, { urgency: 'high' })
  w.card(second, { title: 'normal, later, other session', object_version: 1 }, { sender: device(11), session: other, group: otherGroup.group })
  const ids = list => list.map(id => w.model.cards.get(id).title)
  assert.deepEqual(ids(w.model.stack), ['critical', 'high', 'normal', 'normal, later, other session', 'low'])
  // urgency raised by a new version
  w.card(low, { title: 'low', urgency_reason: 'the release waits', object_version: 2 }, { urgency: 'critical', previous: w.objects.get(low).current })
  assert.deepEqual(ids(w.model.stack).slice(0, 2), ['low', 'critical'], 'the same urgency: the older card first')
  // snoozed until a time; it comes back when the clock passes it
  w.register(`snooze/${critical}`, { until: w.clock + 30_000 })
  assert.deepEqual(ids(w.model.stack), ['low', 'high', 'normal', 'normal, later, other session']); assert.ok(w.last.stack)
  w.clock += 60_000; w.run(() => {})
  assert.deepEqual(ids(w.model.stack).slice(0, 2), ['low', 'critical']); assert.ok(w.last.stack)
  // desks: each session stands on one
  const [work, home] = [id16(0xd1), id16(0xd2)]
  w.register(`session/${w.session}`, { desk: work }); w.register(`session/${other}`, { desk: home })
  assert.deepEqual(ids(stackOf(w.model, { desk_id: hex(home) })), ['normal, later, other session']); assert.equal(stackOf(w.model, { desk_id: hex(work) }).length, 4); assert.equal(stackOf(w.model).length, 5)
  // an archived session's cards leave the stack; they stay open
  w.register(`session/${other}`, { desk: home, archived: true })
  assert.equal(w.model.stack.length, 4); assert.equal(w.model.cards.get(hex(second)).object_state, 'open'); assert.deepEqual(w.model.sessions.get(hex(other)).open_card_ids, [hex(second)])
  // answered: out of the stack and out of its session's open list
  w.answer(high, { answer_action: 'answer', choices: [] })
  assert.equal(w.model.stack.includes(hex(high)), false); assert.equal(w.model.sessions.get(hex(w.session)).open_card_ids.includes(hex(high)), false)
  assert.equal(w.model.sessions.get(hex(w.session)).card_ids.length, 4, 'every card of the session, by age')
})

test('a message: pending at once, then the hub\'s copy in its place under the same local id', () => {
  const w = new World(); w.groups()
  const key = `chat:session/${hex(w.session)}`
  const item = w.run(c => echoTimelineItem(w.model, { local_id: 'L1', timeline_key: key, content: { content_type: 'message', text: 'go on' }, recipient_device_id: hex(w.agent), now: w.clock }, c))
  const t = w.model.timelines.get(key)
  assert.deepEqual([item.pending, item.envelope_number, item.local_id, item.sender_device_id, item.item_state], [true, null, 'L1', hex(w.me), 'loaded'])
  assert.equal(t.items.get('L1'), item); assert.deepEqual(w.last.items.get(key), [item]); assert.equal(t.item_count, 0)
  const hash = w.hash()
  w.run(c => confirmEcho(w.model, 'L1', w.sealed(hash, 4), c))
  assert.equal(t.items.get('L1').sender_sequence, 4, 'sealed: its number in the sender\'s chain is known')
  const got = w.message({ text: 'go on' }, { sender: w.me, hash, seq: 4 })
  const real = t.items.get(got.change)
  assert.equal(t.items.has('L1'), false); assert.deepEqual([real.pending, real.local_id, real.envelope_hash], [false, 'L1', hex(hash)]); assert.equal(t.items.size, 1); assert.equal(t.item_count, 1)
  assert.deepEqual(w.last.items.get(key), [real])
})

test('a message the hub refuses is rolled back; so is one whose void record comes back', () => {
  const w = new World(); w.groups()
  const key = `chat:session/${hex(w.session)}`
  w.run(c => echoTimelineItem(w.model, { local_id: 'L1', timeline_key: key, content: { content_type: 'message', text: 'one' } }, c))
  w.run(c => rollbackEcho(w.model, 'L1', c))
  assert.equal(w.model.timelines.get(key).items.size, 0); assert.ok(w.last.timelines.has(key))
  w.run(c => echoTimelineItem(w.model, { local_id: 'L2', timeline_key: key, content: { content_type: 'message', text: 'two' } }, c))
  const hash = w.hash()
  w.run(c => confirmEcho(w.model, 'L2', w.sealed(hash, 1), c))
  w.message({}, { sender: w.me, hash, seq: 1, outcome: 'void', code: 'wrong-epoch' })
  assert.equal(w.model.timelines.get(key).items.size, 0); assert.equal(w.model.alerts.at(-1).code, 'wrong-epoch')
  w.run(c => rollbackEcho(w.model, 'L2', c))      // (the engine's own roll back after it: nothing left to do)
  assert.equal(w.model.timelines.get(key).items.size, 0)
})

test('an answer: the card is answered at once (pending), then as it counted; refused, it is open again', () => {
  const w = new World(); w.groups()
  const id = id16(0xc1), hid = hex(id)
  w.card(id, { title: 'Q', options: OPTIONS, object_version: 1 })
  const answer = { answer_action: 'answer', choices: ['a'], note: null, option_notes: {}, attachments: [], marks: [], trusted: false, bound_version_hash: w.model.cards.get(hid).version_hash, bound_object_version: 1,
    envelope_number: null, envelope_hash: null, by_device_id: hex(w.me), answered_at: w.clock, taken_back_at: null, taken_back_sent_at: null }
  assert.equal(w.run(c => echoAnswer(w.model, { local_id: 'A1', object_id: hid, answer, object_state: 'answered' }, c)), true)
  let card = w.model.cards.get(hid)
  assert.deepEqual([card.object_state, card.answer.pending, card.answer.choices[0], card.answers.length], ['answered', true, 'a', 0]); assert.deepEqual(w.model.stack, []); assert.ok(w.last.cards.has(hid))
  const hash = w.hash()
  w.run(c => confirmEcho(w.model, 'A1', w.sealed(hash, 1, { object_id: id }), c))
  w.answer(id, { answer_action: 'answer', choices: ['a'] }, { hash })
  card = w.model.cards.get(hid)
  assert.deepEqual([card.object_state, card.answer.pending, card.answers.length, card.answer.envelope_hash], ['answered', false, 1, hex(hash)]); assert.equal(card.answer.local_id, undefined)

  // a second card: the answer settles it (a final option), the hub refuses it
  const two = id16(0xc2), h2 = hex(two)
  w.card(two, { title: 'Q2', options: OPTIONS, object_version: 1 })
  w.run(c => echoAnswer(w.model, { local_id: 'A2', object_id: h2, answer: { ...answer, choices: ['b'] }, object_state: 'closed' }, c))
  assert.deepEqual([w.model.cards.get(h2).object_state, w.model.cards.get(h2).closed_how], ['closed', 'settled'])
  w.run(c => rollbackEcho(w.model, 'A2', c))
  card = w.model.cards.get(h2)
  assert.deepEqual([card.object_state, card.answer, card.closed_how], ['open', null, null]); assert.deepEqual(w.model.stack, [h2])
  // the agent revised the card while an answer was in flight: rolling back leaves the newer state alone
  w.run(c => echoAnswer(w.model, { local_id: 'A3', object_id: h2, answer: { ...answer, choices: ['a'] }, object_state: 'answered' }, c))
  w.card(two, { title: 'Q2, withdrawn', withdraw_reason: 'solved', object_version: 2 }, { state: 'closed', previous: w.objects.get(two).current })
  w.run(c => rollbackEcho(w.model, 'A3', c))
  assert.deepEqual([w.model.cards.get(h2).object_state, w.model.cards.get(h2).closed_how, w.model.cards.get(h2).answer], ['closed', 'withdrawn', null])
  assert.equal(w.run(c => echoAnswer(w.model, { local_id: 'A4', object_id: 'none', answer, object_state: 'answered' }, c)), false)
})

test('registers: the value at once; confirmed where it is current, the winner where it lost, as before where refused', () => {
  const w = new World(); w.groups()
  const card = id16(0xc1), hc = hex(card), key = `draft/${hc}`
  w.register(`draft/${card}`, { note: 'first' })
  w.run(c => echoRegisters(w.model, { local_id: 'R1', values: { [key]: { note: 'mine' }, crown: { session_id: hex(w.session) } } }, c))
  assert.equal(w.model.human.drafts.get(hc).note, 'mine'); assert.equal(w.model.human.raw.get(key).pending, true); assert.ok(w.last.registers.has(key) && w.last.registers.has('crown'))
  const [h1, h2] = [w.hash(), w.hash()]
  for (const [i, hash] of [h1, h2].entries()) w.run(c => confirmEcho(w.model, 'R1', w.sealed(hash, i + 2, { group: w.room_group }), c))
  // the phone's write arrives under the echo: the echo stays in front
  w.register(`draft/${card}`, { note: 'the phone\'s' }, { sender: w.phone, lamport: 9 })
  assert.equal(w.model.human.drafts.get(hc).note, 'mine')
  // the own draft comes back and lost to it; the crown comes back and is current
  w.register(`draft/${card}`, { note: 'mine' }, { hash: h1, current: false })
  assert.equal(w.model.human.drafts.get(hc).note, 'the phone\'s'); assert.equal(w.model.human.raw.get(key).pending, false); assert.equal(w.model.human.raw.get(key).by_device_id, hex(w.phone))
  w.register('crown', { session_id: w.session }, { hash: h2 })
  assert.deepEqual(w.model.human.crown, { session_id: hex(w.session) }); assert.equal(w.model.human.raw.get('crown').pending, false)
  // refused: as it was before, also a key that had no value
  w.run(c => echoRegisters(w.model, { local_id: 'R2', values: { [key]: null, [`snooze/${hc}`]: { until: 5 } } }, c))
  assert.equal(w.model.human.drafts.has(hc), false); assert.ok(w.model.human.snoozes.has(hc))
  w.run(c => rollbackEcho(w.model, 'R2', c))
  assert.equal(w.model.human.drafts.get(hc).note, 'the phone\'s'); assert.equal(w.model.human.snoozes.has(hc), false)
})

test('a note: pending under its local id, then under its object id, then the confirmed version; a failed one is gone', () => {
  const w = new World(); w.groups()
  const key = w.run(c => echoNote(w.model, { local_id: 'N1', fields: { text: 'call the plumber', place: 'desk' } }, c))
  assert.equal(key, 'N1'); assert.deepEqual([w.model.notes.get('N1').pending, w.model.notes.get('N1').text, w.model.notes.get('N1').by_device_id], [true, 'call the plumber', hex(w.me)])
  const id = id16(0xb1), hid = hex(id), hash = w.hash()
  w.run(c => confirmEcho(w.model, 'N1', w.sealed(hash, 1, { group: w.room_group, object_id: id }), c))
  assert.equal(w.model.notes.has('N1'), false); assert.equal(w.model.notes.get(hid).pending, true); assert.ok(w.last.notes.has('N1') && w.last.notes.has(hid))
  w.take({ kind: 'version', sender: w.me, session: null, hash, object: w.object(id, 'note'), payload: { schema_version: 2, text: 'call the plumber', place: 'desk', lamport: 1 }, object_after: { object_id: id, owner: w.me, object_state: 'open', current_version: hash } })
  let n = w.model.notes.get(hid)
  assert.deepEqual([n.pending, n.text, n.version_hash, n.object_version, n.local_id], [false, 'call the plumber', hex(hash), 1, undefined])
  // a quick edit on top, then deleted, both refused: the confirmed note stands
  w.run(c => echoNote(w.model, { local_id: 'N2', object_id: hid, fields: { text: 'call the plumber today' } }, c))
  assert.deepEqual([w.model.notes.get(hid).text, w.model.notes.get(hid).pending, w.model.notes.get(hid).place], ['call the plumber today', true, 'desk'])
  w.run(c => rollbackEcho(w.model, 'N2', c))
  assert.deepEqual([w.model.notes.get(hid).text, w.model.notes.get(hid).pending], ['call the plumber', false])
  w.run(c => echoNote(w.model, { local_id: 'N3', object_id: hid, fields: {}, closed: true }, c))
  assert.equal(w.model.notes.get(hid).object_state, 'closed')
  w.run(c => rollbackEcho(w.model, 'N3', c))
  assert.equal(w.model.notes.get(hid).object_state, 'open')
  // a new note that never left: gone
  w.run(c => echoNote(w.model, { local_id: 'N4', fields: { text: 'x' } }, c)); w.run(c => rollbackEcho(w.model, 'N4', c))
  assert.equal(w.model.notes.has('N4'), false); assert.equal(n.text, 'call the plumber')
})
