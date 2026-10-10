// cards.test.mjs: a card's life in the model, from hand-made core results (factory.mjs): asked, revised, answered,
// taken back, settled by a final option, closed, withdrawn, merged; an info card read and shredded; and what the user
// sees of an envelope that did not arrive whole (pruned, a newer version, not counted, void, refused, out of order).
//   node --test tests/web/model/
import test from 'node:test'
import assert from 'node:assert/strict'
import { holderOf, timelineOf } from '../../../app/web/core/model.ts'
import { World, device, hex, id16 } from './factory.mjs'

const OPTIONS = [{ key: 'sqlite', label: 'SQLite' }, { key: 'files', label: 'Plain files', final: true }]

test('a decision card: version 1, revised, answered, taken back, answered with a final option', () => {
  const w = new World(); w.groups()
  const id = id16(0xc1), hid = hex(id)
  const v1 = w.card(id, { card_type: 'decision', title: 'Where do the notes go?', teaser: 'SQLite or files', body: 'Both work.', options: OPTIONS, recommended: 'sqlite', object_version: 1 }, { urgency: 'high' })
  let card = w.model.cards.get(hid)
  assert.equal(card.object_state, 'open'); assert.equal(card.urgency, 'high'); assert.equal(card.title, 'Where do the notes go?')
  assert.equal(card.agent_device_id, hex(w.agent)); assert.equal(card.session_id, hex(w.session))
  assert.equal(card.version_hash, hex(v1.hash)); assert.equal(card.object_version, 1)
  assert.equal(card.envelope_number, 1); assert.equal(card.first_envelope_number, 1); assert.equal(card.timeline_key, `chat:card/${hid}`)
  assert.equal(card.content_state, 'ok'); assert.equal(card.closed_how, null)
  assert.deepEqual(w.model.stack, [hid]); assert.deepEqual(w.model.sessions.get(hex(w.session)).card_ids, [hid]); assert.deepEqual(w.model.sessions.get(hex(w.session)).open_card_ids, [hid])
  assert.ok(w.last.cards.has(hid) && w.last.sessions.has(hex(w.session)) && w.last.stack)

  const v2 = w.card(id, { card_type: 'decision', title: 'Where do the notes go? (with a third way)', options: [...OPTIONS, { key: 'both', label: 'Both' }], change_note: 'added both', object_version: 2 }, { previous: v1.hash })
  card = w.model.cards.get(hid)
  assert.equal(card.object_version, 2); assert.equal(card.versions.length, 2); assert.equal(card.change_note, 'added both'); assert.equal(card.teaser, null, 'a field the new version leaves out is gone')
  assert.equal(card.versions[1].previous_version_hash, hex(v1.hash)); assert.equal(card.versions[0].content.title, 'Where do the notes go?')
  assert.equal(card.first_envelope_number, 1); assert.equal(card.envelope_number, 2); assert.equal(card.created_at, v1.time); assert.equal(card.updated_at, v2.time)

  const a1 = w.answer(id, { answer_action: 'answer', choices: ['sqlite'], note: 'faster search' })
  card = w.model.cards.get(hid)
  assert.equal(card.object_state, 'answered'); assert.equal(card.closed_how, 'answered')
  assert.deepEqual(card.answer.choices, ['sqlite']); assert.equal(card.answer.note, 'faster search'); assert.equal(card.answer.bound_object_version, 2)
  assert.equal(card.answer.bound_version_hash, card.version_hash); assert.equal(card.answer.by_device_id, hex(w.me)); assert.equal(card.answer.envelope_hash, hex(a1.hash))
  assert.equal(card.answer.pending, false); assert.deepEqual(w.model.stack, []); assert.deepEqual(w.model.sessions.get(hex(w.session)).open_card_ids, [])

  const back = w.takeBack(id, a1.hash)
  card = w.model.cards.get(hid)
  assert.equal(card.object_state, 'open'); assert.equal(card.answer, null); assert.equal(card.closed_how, null)
  assert.equal(card.answers.length, 1); assert.equal(card.answers[0].taken_back_at, back.change); assert.equal(card.answers[0].taken_back_sent_at, back.time)
  assert.deepEqual(w.model.stack, [hid])

  w.answer(id, { answer_action: 'answer', choices: ['files'] }, { state: 'closed' })
  card = w.model.cards.get(hid)
  assert.equal(card.object_state, 'closed'); assert.equal(card.closed_how, 'settled', 'an answer that closes the card itself settles it')
  assert.equal(card.answers.length, 2); assert.equal(card.answer, card.answers[1])
})

test('the agent closes, withdraws and merges; a new open version after an answer asks again', () => {
  const w = new World(); w.groups()
  const [a, b, c, d] = [id16(1), id16(2), id16(3), id16(4)]
  const first = id => w.card(id, { title: 'Q', options: OPTIONS, object_version: 1 }).hash
  const [ha, hb, hc, hd] = [a, b, c, d].map(first)
  w.answer(a, { answer_action: 'answer', choices: ['sqlite'] })
  w.card(a, { title: 'Q', options: OPTIONS, close_summary: 'done: SQLite it is', object_version: 2 }, { state: 'closed', previous: ha })
  let card = w.model.cards.get(hex(a))
  assert.equal(card.object_state, 'closed'); assert.equal(card.closed_how, 'closed'); assert.equal(card.close_summary, 'done: SQLite it is'); assert.deepEqual(card.answer.choices, ['sqlite'], 'his answer stays on the closed card')

  w.card(b, { title: 'Q', withdraw_reason: 'no longer needed', object_version: 2 }, { state: 'closed', previous: hb })
  assert.equal(w.model.cards.get(hex(b)).closed_how, 'withdrawn')

  w.card(c, { title: 'Q', merged_into_object_id: d, object_version: 2 }, { state: 'closed', previous: hc })
  w.card(d, { title: 'Q and Q', options: OPTIONS, merged_from_object_ids: [c], object_version: 2 }, { previous: hd })
  assert.equal(w.model.cards.get(hex(c)).closed_how, 'merged'); assert.equal(w.model.cards.get(hex(c)).merged_into_object_id, hex(d), 'ids inside a body are the model\'s hex')
  assert.deepEqual(w.model.cards.get(hex(d)).merged_from_object_ids, [hex(c)])
  assert.deepEqual(w.model.stack, [hex(d)])

  w.answer(d, { answer_action: 'answer', choices: ['sqlite'] })
  w.card(d, { title: 'Asked again', options: OPTIONS, object_version: 3 }, { previous: w.objects.get(d).current })
  card = w.model.cards.get(hex(d))
  assert.equal(card.object_state, 'open'); assert.equal(card.answer, null, 'a new open version asks again'); assert.equal(card.answers.length, 1); assert.equal(card.closed_how, null)
})

test('an info card: read, and shredded with a word', () => {
  const w = new World(); w.groups()
  const [i1, i2] = [id16(0x11), id16(0x12)]
  w.card(i1, { card_type: 'info', title: 'Deployed', body: 'v1.4 is live', object_version: 1 }, { urgency: 'low' })
  w.card(i2, { card_type: 'info', title: 'Old news', object_version: 1 })
  w.answer(i1, { answer_action: 'read' }, { state: 'closed' })
  w.answer(i2, { answer_action: 'shred', note: 'not for me' }, { state: 'closed' })
  const read = w.model.cards.get(hex(i1)), shredded = w.model.cards.get(hex(i2))
  assert.equal(read.card_type, 'info'); assert.equal(read.object_state, 'closed'); assert.equal(read.closed_how, 'read'); assert.equal(read.answer.answer_action, 'read')
  assert.equal(shredded.closed_how, 'shredded'); assert.equal(shredded.answer.note, 'not for me')
  assert.deepEqual(w.model.stack, [])
})

test('pruned: the header still counts, the card shows as pruned; its conversation item is a placeholder', () => {
  const w = new World(); w.groups()
  const id = id16(0x21)
  const v1 = w.card(id, {}, { outcome: 'chained', code: 'pruned' })
  w.answer(id, {}, { outcome: 'chained', code: 'pruned', state: 'closed' })
  const card = w.model.cards.get(hex(id))
  assert.equal(card.content_state, 'pruned'); assert.equal(card.title, ''); assert.equal(card.object_state, 'closed'); assert.equal(card.closed_how, 'closed')
  assert.equal(card.versions.length, 1); assert.equal(card.versions[0].content, null); assert.equal(card.object_version, 1)
  assert.equal(card.answers.length, 1); assert.equal(card.answers[0].bound_version_hash, hex(v1.hash), 'the header names the version answered')
  assert.equal(w.model.alerts.length, 0, 'nobody is told of a pruned body')
  timelineOf(w.model, `chat:session/${hex(w.session)}`).window_open = true      // the conversation is open: it counts headers too
  const m = w.message({}, { outcome: 'chained', code: 'pruned' })
  const item = w.model.timelines.get(`chat:session/${hex(w.session)}`).items.get(m.change)
  assert.equal(item.item_state, 'pruned'); assert.equal(item.content, null)
})

test('a newer Trommi: a body of a newer version, a card type and an envelope kind this version does not know', () => {
  const w = new World(); w.groups()
  const [a, b] = [id16(0x31), id16(0x32)]
  w.card(a, {}, { outcome: 'chained', code: 'newer-version' })
  let card = w.model.cards.get(hex(a))
  assert.equal(card.unsupported, 'newer_schema'); assert.equal(card.content_state, 'newer_schema'); assert.equal(card.object_state, 'open', 'its header counts')
  assert.equal(w.model.newer.count, 1); assert.ok(w.last.room, 'the app is told once that something needs a newer Trommi')

  w.card(b, { card_type: 'poll', title: 'A poll', object_version: 1 })
  card = w.model.cards.get(hex(b))
  assert.equal(card.unsupported, 'card_type'); assert.equal(card.title, 'A poll'); assert.ok(w.model.newer.what.includes('card_type poll'))

  const before = w.model.cards.size
  const { result } = w.take({ kind: 'reserved', object: w.object(id16(0x33), 'card'), outcome: 'chained', code: 'newer-version' })
  assert.equal(result.refused, 'needs-update'); assert.equal(w.model.cards.size, before, 'a reserved kind is chained and applies nothing')
  assert.ok(w.model.newer.what.includes('envelope kind'))

  const m = w.message({}, { outcome: 'chained', code: 'newer-version' })
  assert.equal(w.model.timelines.get(`chat:session/${hex(w.session)}`).item_count, 1)
  assert.equal(w.model.timelines.get(`chat:session/${hex(w.session)}`).newest_envelope_number, m.change)
})

test('not counted: forbidden and wrong-epoch change nothing and raise an alert; void and refused too; a replay is quiet', () => {
  const w = new World(); w.groups()
  const id = id16(0x41)
  const v1 = w.card(id, { title: 'Q', options: OPTIONS, object_version: 1 })
  const snapshot = JSON.stringify(w.model.cards.get(hex(id)))
  const same = what => assert.equal(JSON.stringify(w.model.cards.get(hex(id))), snapshot, what)

  let got = w.answer(id, { answer_action: 'answer', choices: ['sqlite'] }, { sender: w.phone, outcome: 'chained', code: 'forbidden', object_after: null })
  same('a forbidden answer'); assert.equal(got.result.refused, 'forbidden'); assert.equal(w.model.alerts.at(-1).code, 'forbidden')
  assert.equal(w.model.alerts.at(-1).sender_device_id, hex(w.phone)); assert.equal(w.model.alerts.at(-1).envelope_number, got.change); assert.ok(w.last.alerts)

  got = w.card(id, { title: 'late', object_version: 2 }, { previous: v1.hash, outcome: 'chained', code: 'wrong-epoch', object_after: null })
  same('a version of an ended epoch'); assert.equal(w.model.alerts.at(-1).code, 'wrong-epoch')

  got = w.card(id, {}, { outcome: 'void', code: 'stale-session', object_after: null })
  same('a void record'); assert.equal(got.result.refused, 'stale-session'); assert.equal(w.model.alerts.at(-1).code, 'stale-session')

  got = w.card(id, { title: 'forged' }, { outcome: 'refused', code: 'bad-signature', object_after: null })
  same('a refused envelope'); assert.equal(w.model.alerts.at(-1).code, 'bad-signature')

  const alerts = w.model.alerts.length
  got = w.take({ ...v1.r, outcome: 'refused', code: 'replay', payload: null, objectAfter: null })
  same('met twice'); assert.equal(w.model.alerts.length, alerts, 'an envelope met twice is no finding for a human')

  got = w.message({ text: 'x' }, { card: id, sender: w.phone, outcome: 'chained', code: 'forbidden' })
  assert.equal(w.model.timelines.get(`chat:card/${hex(id)}`), undefined, 'a forbidden message stands nowhere')
  assert.equal(w.model.alerts.at(-1).code, 'forbidden')
})

test('out of order: the Desk shows a card before its chain arrives; the chain confirms it and never moves it back', () => {
  const w = new World(); w.groups()
  const id = id16(0x51), hid = hex(id)
  // What the chain will bring: version 1 (change 5), version 2 (change 9). The Desk hands over version 2 first.
  const h1 = w.hash(), h2 = w.hash()
  const fields2 = { title: 'Second wording', options: OPTIONS, object_version: 2, previous_version_hash: h1 }
  w.take({ kind: 'version', object: w.object(id, 'card', 'open', { urgency: 'critical', object_ref: h1 }), payload: { schema_version: 2, ...fields2 }, outcome: 'provisional', change: 9, seq: 2, hash: h2, time: 2000 })
  let card = w.model.cards.get(hid)
  assert.equal(card.title, 'Second wording'); assert.equal(card.object_state, 'open'); assert.equal(card.urgency, 'critical'); assert.deepEqual(w.model.stack, [hid])
  assert.equal(card.envelope_number, 9); assert.equal(card.object_version, 2)

  // the chain, in the hub's order: version 1 in pruned form, then version 2 itself
  w.take({ kind: 'version', object: w.object(id, 'card', 'open'), outcome: 'chained', code: 'pruned', change: 5, seq: 1, hash: h1, time: 1000 })
  card = w.model.cards.get(hid)
  assert.equal(card.title, 'Second wording', 'an older version does not take the card back'); assert.equal(card.envelope_number, 9); assert.equal(card.first_envelope_number, 5); assert.equal(card.created_at, 1000)
  assert.deepEqual(card.versions.map(v => v.envelope_number), [5, 9])
  w.take({ kind: 'version', object: w.object(id, 'card', 'open', { urgency: 'critical', object_ref: h1 }), payload: { schema_version: 2, ...fields2 }, change: 9, seq: 2, hash: h2, time: 2000 })
  card = w.model.cards.get(hid)
  assert.equal(card.versions.length, 2, 'the same hash is the same version'); assert.equal(card.title, 'Second wording'); assert.equal(card.object_state, 'open')

  // a body fetched later for a version the chain brought as a header only (GET /v1/cards/{object})
  w.take({ kind: 'version', object: w.object(id, 'card', 'open'), payload: { schema_version: 2, title: 'First wording', object_version: 1 }, outcome: 'provisional', change: 5, seq: 1, hash: h1, time: 1000 })
  card = w.model.cards.get(hid)
  assert.equal(card.versions[0].content.title, 'First wording'); assert.equal(card.title, 'Second wording')
})

test('the owner moves with the core\'s word (a takeover): the card names whom an answer is addressed to', () => {
  const w = new World(); w.groups()
  const id = id16(0x61)
  const v1 = w.card(id, { title: 'Q', object_version: 1 })
  const second = device(11)
  assert.equal(holderOf(w.model, w.model.cards.get(hex(id))), hex(w.agent))
  // the session's agent device was replaced; the old owner is no leaf any more
  w.groups([], { agents: [second] })
  assert.equal(w.model.sessions.get(hex(w.session)).agent_device_id, hex(second))
  assert.equal(holderOf(w.model, w.model.cards.get(hex(id))), hex(second), 'once the owner is no leaf, the session\'s agent device holds it')
  w.card(id, { title: 'Q, again', object_version: 2 }, { sender: second, previous: v1.hash, object_after: { object_id: id, owner: second, object_state: 'open', current_version: w.hash() } })
  assert.equal(w.model.cards.get(hex(id)).agent_device_id, hex(second))
})
