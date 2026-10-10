// A reload at the worst moment: the core has taken an item (its store is durable, its cursor past the item) and the
// app's cache has not been written yet. The cache is not authoritative: nothing may be lost. The REAL core (real
// envelopes) and the FAKE hub.
import test from 'node:test'
import assert from 'node:assert/strict'
import { scene, until } from './helpers.mjs'

test('killed between "the core took it" and "the cache was written": a register, a note version, a card version and a chat item are there after the reopen', async t => {
  const { R, a, b, agent } = await scene(t, { agent: true, second: true })
  const desk0 = 'd0'.repeat(16), desk1 = 'd1'.repeat(16)
  const note = await a.saveNote({ text: 'first version' })
  await a.setDesk(desk0, { name: 'Cached before', created_at: 1, order: 1 })
  const card = await agent.askCard({ title: 'First title', options: [{ key: 'ok', label: 'OK' }] })
  await a.settle(); await agent.settle(); await b.settle()
  await b.loadTimeline(`chat:session/${agent.session_id}`)
  await b.flush()
  assert.equal(b.model.human.desks.get(desk0).name, 'Cached before')

  // from here on nothing of B reaches its cache: as if the page went away before the write
  b.cache.setMany = async () => {}
  await a.setDesk(desk1, { name: 'Arrived just before the reload', created_at: 2, order: 2 })
  await a.saveNote({ object_id: note, text: 'second version' })
  await agent.reviseCard(card, { title: 'Second title' })
  await agent.say({ text: 'said just before the reload' })
  await a.settle(); await agent.settle()
  await until(() => b.model.human.desks.get(desk1) && b.model.notes.get(note)?.text === 'second version' && b.model.cards.get(card)?.title === 'Second title', 'B shows all of it')
  await b.settle()
  await b.stop()                 // (nothing of it reaches the cache any more: the store is closed as a dead page leaves it)

  const again = await R.openRoom({ storage: b.stored_as })
  t.after(() => again.stop().catch(() => {}))
  await again.start()
  await again.settle()
  await until(() => again.model.human.desks.get(desk1)?.name === 'Arrived just before the reload', 'the register that arrived just before')
  assert.equal(again.model.human.desks.get(desk0)?.name, 'Cached before', 'what was cached earlier is still there')
  await until(() => again.model.notes.get(note)?.text === 'second version', 'the note\'s newest version')
  await until(() => again.model.cards.get(card)?.title === 'Second title', 'the card\'s newest version')
  assert.deepEqual(again.model.stack, [card])
  await again.loadTimeline(`chat:session/${agent.session_id}`)
  assert.ok([...again.model.timelines.get(`chat:session/${agent.session_id}`).items.values()].some(i => i.content?.text === 'said just before the reload'))
  assert.equal(again.model.sessions.get(agent.session_id)?.agent_device_id, agent.device_id)
  // and a second reopen, now from a cache that was written, shows the same at once
  await again.stop()
  const warm = await R.openRoom({ storage: b.stored_as })
  t.after(() => warm.stop().catch(() => {}))
  assert.equal(warm.model.human.desks.get(desk1)?.name, 'Arrived just before the reload')
  assert.equal(warm.model.human.desks.get(desk0)?.name, 'Cached before')
  assert.equal(warm.model.notes.get(note)?.text, 'second version')
  assert.equal(warm.model.cards.get(card)?.title, 'Second title')
})

test('fifty kills at random moments within 300 ms of an arrival: nothing is ever lost, whatever the cache had got', async t => {
  const { R, a, b, agent } = await scene(t, { agent: true, second: true })
  const key = `chat:session/${agent.session_id}`
  const note = await a.saveNote({ text: 'v0' })
  const card = await agent.askCard({ title: 't0', options: [{ key: 'ok', label: 'OK' }] })
  await a.settle(); await agent.settle(); await b.settle()
  let device = b
  for (let i = 1; i <= 50; i++) {
    const desk = (0x1000 + i).toString(16).padStart(32, '0')
    const kind = i % 4
    if (kind === 0) await a.setDesk(desk, { name: `desk ${i}`, created_at: i, order: i })
    else if (kind === 1) await a.saveNote({ object_id: note, text: `v${i}` })
    else if (kind === 2) await agent.reviseCard(card, { title: `t${i}` })
    else await agent.say({ text: `said ${i}` })
    await a.settle(); await agent.settle()
    const there = m => (kind === 0 ? m.human.desks.get(desk)?.name === `desk ${i}` : kind === 1 ? m.notes.get(note)?.text === `v${i}` : kind === 2 ? m.cards.get(card)?.title === `t${i}`
      : [...(m.timelines.get(key)?.items.values() ?? [])].some(x => x.content?.text === `said ${i}`) || m.timelines.get(key)?.newest_envelope_number >= 0)
    await until(() => (kind === 3 ? device.engine.position >= a.engine.position - 1 : there(device.model)), `arrival ${i}`)
    await new Promise(r => setTimeout(r, Math.floor(Math.random() * 300)))
    // the kill: no further write reaches the cache, the device's store is closed where it stands
    device.cache.setMany = async () => {}
    await device.stop()
    device = await R.openRoom({ storage: b.stored_as })
    await device.start()
    await device.settle()
    if (kind === 3) { await device.loadTimeline(key); assert.ok([...device.model.timelines.get(key).items.values()].some(x => x.content?.text === `said ${i}`), `the message of round ${i}`) }
    else await until(() => there(device.model), `round ${i} after the reopen`)
  }
  t.after(() => device.stop().catch(() => {}))
  // at the end everything of every round is there
  for (let i = 4; i <= 50; i += 4) assert.equal(device.model.human.desks.get((0x1000 + i).toString(16).padStart(32, '0'))?.name, `desk ${i}`)
  assert.equal(device.model.notes.get(note).text, 'v49')
  assert.equal(device.model.cards.get(card).title, 't50')
})
