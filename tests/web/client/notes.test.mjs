// Notes and the room's registers on two human devices. STAND-IN core (plain JSON content) and FAKE hub.
import test from 'node:test'
import assert from 'node:assert/strict'
import { modelsAgree, scene } from './helpers.mjs'

test('notes: created, edited on two devices at once, deleted', async t => {
  const { a, b } = await scene(t, { second: true })
  const saving = a.saveNote({ text: 'milk', place: 'desk' })
  const echo = [...a.model.notes.values()].at(-1)
  assert.equal(echo.pending, true)
  assert.equal(echo.text, 'milk')
  const note = await saving
  assert.equal(a.model.notes.get(note).pending, true, 'the echo moved to the note\'s object id')
  await a.settle(); await b.settle()
  assert.equal(b.model.notes.get(note).text, 'milk')
  assert.equal(b.model.notes.get(note).place, 'desk')
  assert.equal(a.model.notes.get(note).pending, false)

  // both edit before either saw the other: one version wins on both devices, the same one
  await Promise.all([a.saveNote({ object_id: note, text: 'milk and bread' }), b.saveNote({ object_id: note, text: 'milk and eggs' })])
  await a.settle(); await b.settle(); await a.settle()
  assert.equal(a.model.notes.get(note).text, b.model.notes.get(note).text)
  assert.equal(a.model.notes.get(note).pending, false)
  assert.equal(b.model.notes.get(note).pending, false)
  // quick edits chain on what this client sealed last
  await a.saveNote({ object_id: note, text: 'one' }); await a.saveNote({ object_id: note, text: 'two' }); await a.saveNote({ object_id: note, text: 'three' })
  await a.settle(); await b.settle()
  assert.equal(b.model.notes.get(note).text, 'three')

  await b.deleteNote(note)
  assert.equal(b.model.notes.get(note).object_state, 'closed')
  await b.settle(); await a.settle()
  assert.equal(a.model.notes.get(note).object_state, 'closed')
  await assert.rejects(a.deleteNote('00'.repeat(16)), { code: 'not-found' })
  modelsAgree(a.model, b.model)
})

test('registers: a draft, a snooze, a desk, a session\'s settings, the crown; the last write wins on both devices', async t => {
  const { a, b, agent } = await scene(t, { second: true, agent: true })
  const card = await agent.askCard({ title: 'Later?', options: [{ key: 'ok', label: 'OK' }] })
  await agent.settle(); await a.settle(); await b.settle()
  const desk = 'd0'.repeat(16)
  const setting = a.setDraft(card, { keys: ['ok'], note: 'thinking' })
  assert.deepEqual(a.model.human.drafts.get(card), { keys: ['ok'], note: 'thinking' })
  assert.equal(a.model.human.raw.get(`draft/${card}`).pending, true)
  await setting
  await a.setDesk(desk, { name: 'Home', created_at: 5, order: 2, goals: 'ship v2\nsleep' })
  await a.setRegisters({ [`session/${agent.session_id}`]: { name: 'Ada', desk, icon: 'pen' } })
  await a.snooze(card, Date.now() + 60_000)
  await a.setCrown({ session_id: agent.session_id })
  assert.deepEqual(a.model.stack, [], 'a snoozed card leaves the stack at once')
  await a.settle(); await b.settle()
  assert.deepEqual(b.model.human.drafts.get(card), { keys: ['ok'], note: 'thinking' })
  assert.equal(b.model.human.desks.get(desk).name, 'Home')
  assert.equal(b.model.sessions.get(agent.session_id).settings.desk, desk)
  assert.deepEqual(b.model.human.crown, { session_id: agent.session_id })
  assert.deepEqual(b.model.stack, [])
  assert.equal(a.model.human.raw.get(`draft/${card}`).pending, false)

  await b.snooze(card, null)
  await b.setDraft(card, null)
  await b.duck(card, { at: 1 })
  await b.settle(); await a.settle()
  assert.deepEqual(a.model.stack, [card])
  assert.equal(a.model.human.drafts.has(card), false)
  assert.deepEqual(a.model.human.ducks.get(card), { at: 1 })

  // concurrent writes of one name: both devices end on the same value
  await Promise.all([a.setDesk(desk, { name: 'A says', created_at: 5, order: 2 }), b.setDesk(desk, { name: 'B says', created_at: 5, order: 2 })])
  await a.settle(); await b.settle(); await a.settle()
  assert.equal(a.model.human.desks.get(desk).name, b.model.human.desks.get(desk).name)
  // the desk's goals reach the agent as its session's register `goals` (9.3.4)
  await a.setDesk(desk, { name: 'Home', created_at: 5, order: 2, goals: 'ship v2' })
  await a.settle()
  modelsAgree(a.model, b.model)
})
