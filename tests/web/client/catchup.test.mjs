// Catch-up and the live stream: the hub's order, pages, a hub that breaks it, a stream that drops; and the local
// cache. STAND-IN core and FAKE hub. What a hub can do to a client beyond this (withhold, forge) is not shown here:
// the fake hub checks no cryptography and neither does the stand-in.
import test from 'node:test'
import assert from 'node:assert/strict'
import { memoryCache, modelsAgree, scene, shared, sleep, until } from './helpers.mjs'

test('520 changes across groups, taken in pages, strictly in the hub\'s order', async t => {
  const { fake, R, a, b, agent } = await scene(t, { agent: true, second: true })
  await b.stop()
  for (let i = 0; i < 130; i++) {
    await a.setDesk('aa'.repeat(16), { name: `Desk ${i}`, created_at: 1, order: 1 })
    await agent.say({ text: `agent ${i}` })
    await a.sendMessage({ session_id: agent.session_id, text: `human ${i}` })
    await agent.setRegister('status_line/run', { label: 'Run', state: 'working', detail: String(i) })
  }
  await a.settle(20_000); await agent.settle()
  const head = [...fake.state.rooms.values()][0].change
  const again = await R.openRoom({ storage: b.stored_as })
  t.after(() => again.stop().catch(() => {}))
  const from = again.engine.position, taken = []
  again.engine.on('envelope', ({ received, how }) => { if (how === 'ordered') taken.push(received.header.change) })
  again.engine.on('log', ({ item }) => taken.push(item.change))
  const requests = fake.requests.length
  await again.start({ stream: false })
  await again.settle()
  const pages = fake.requests.slice(requests).filter(r => r.method === 'GET' && r.path === '/v2/changes' && Number(r.query.after) >= from && Number(r.query.after) < head)
  assert.ok(pages.length >= 2, 'more than one page')
  assert.ok(taken.length >= 520, `${taken.length} items taken`)
  assert.deepEqual(taken, [...new Set(taken)].sort((x, y) => x - y), 'each change once, ascending')
  assert.ok(again.engine.position >= head)
  assert.equal(again.model.human.desks.get('aa'.repeat(16)).name, 'Desk 129')
  const key = `chat:session/${agent.session_id}`
  assert.equal(again.model.timelines.get(key).item_count, a.model.timelines.get(key).item_count)
  assert.equal(again.model.sessions.get(agent.session_id).status_lines[0].detail, '129')
  modelsAgree(a.model, again.model)
})

test('a hub that serves a page out of order, or an old envelope again: nothing of it is taken', async t => {
  const { fake, a, b } = await scene(t, { second: true })
  const first = await a.saveNote({ text: 'the first' })
  await a.settle(); await b.settle()
  await b.stop()
  await a.saveNote({ text: 'the second' }); await a.saveNote({ text: 'the third' })
  await a.settle()
  const again = await (await import('./helpers.mjs')).rooms().then(R => R.openRoom({ storage: b.stored_as }))
  t.after(() => again.stop().catch(() => {}))
  const before = shared(again.model), position = again.engine.position
  // (1) the page reversed: the hub client refuses it whole
  fake.faults.add({ method: 'GET', path: '/v2/changes', answer: json => ({ ...json, items: [...json.items].reverse() }), times: 3 })
  await assert.rejects(again.catchUp(), { code: 'bad-answer' })
  assert.equal(again.engine.position, position, 'the position did not move')
  assert.deepEqual(shared(again.model), before, 'the model did not change')
  assert.ok(again.model.alerts.some(x => x.code === 'bad-answer'), 'and the human is told')
  fake.faults.clear()
  // (2) an old envelope under a new change number: the core knows it by its chain and refuses it
  const old = [...fake.state.rooms.values()][0].changes.find(c => c.kind === 'envelope' && JSON.parse(Buffer.from(c.envelope, 'base64url').toString()).object?.object_id === Buffer.from(first, 'hex').toString('base64url'))
  fake.faults.add({ method: 'GET', path: '/v2/changes', answer: json => ({ ...json, change: json.change + 1, items: [...json.items, { kind: 'envelope', change: json.change + 1, envelope: old.envelope, received_at: 1 }] }) })
  const outcomes = []
  again.engine.on('envelope', ({ received }) => outcomes.push([received.outcome, received.code]))
  await again.catchUp()
  assert.deepEqual(outcomes.at(-1), ['refused', 'replay'])
  assert.deepEqual([...again.model.notes.values()].map(n => n.text).sort(), ['the first', 'the second', 'the third'])
  assert.equal(again.model.notes.get(first).version_hashes.length, 1, 'the replayed version counted for nothing')
})

test('the stream drops and resumes: nothing is lost and nothing comes twice; an old event is not taken again', async t => {
  const { fake, a, b } = await scene(t, { second: true })
  const seen = []
  a.engine.on('envelope', ({ received }) => seen.push(received.header.change))
  const room = [...fake.state.rooms.values()][0]
  for (let i = 0; i < 6; i++) {
    await b.saveNote({ text: `note ${i}` })
    if (i === 1 || i === 3) fake.dropStreams()
    if (i === 4) {
      // a hub that sends an old change again: the hub client ends that connection and resumes after the last good one
      const old = room.changes.find(c => c.kind === 'envelope')
      fake.push(room.room_id, `id: ${old.change}\nevent: envelope\ndata: ${JSON.stringify({ kind: 'envelope', change: old.change, envelope: old.envelope, received_at: old.received_at })}\n\n`)
    }
    await sleep(20)
  }
  await b.settle()
  await until(() => [...a.model.notes.values()].filter(n => /^note \d$/.test(n.text)).length === 6, 'every note on the other device')
  await a.settle()
  assert.equal(new Set(seen).size, seen.length, 'no change was taken twice')
  assert.deepEqual(seen, [...seen].sort((x, y) => x - y))
  assert.equal(a.model.room.connection, 'live')
  modelsAgree(a.model, b.model)
})

test('the cache: a warm start shows the Desk before the hub answers; a cache at another cursor is dropped and built again', async t => {
  const { fake, R, a, agent, name } = await scene(t, { agent: true })
  const card = await agent.askCard({ title: 'Still here after a restart?', options: [{ key: 'yes', label: 'Yes' }] })
  const note = await a.saveNote({ text: 'kept in the cache' })
  await agent.settle(); await a.settle()
  await a.loadTimeline(`chat:session/${agent.session_id}`)
  const before = shared(a.model)
  await a.stop()

  // offline: the hub is gone, the model is there at once, and the client starts without a failure
  await fake.stop()
  const warm = await R.openRoom({ storage: name })
  assert.deepEqual(shared(warm.model), before)
  assert.deepEqual(warm.model.stack, [card])
  assert.equal(warm.model.room.connection, 'offline')
  await warm.start()
  assert.notEqual(warm.model.room.connection, 'live')
  const offline = await warm.saveNote({ text: 'written offline' })
  assert.equal(warm.model.notes.get(offline).pending, true)
  await fake.start()
  await warm.settle()
  assert.equal(warm.model.notes.get(offline).pending, false)
  await warm.stop()

  // a cache that was written at another cursor than the device holds is not shown: it is built again
  const cache = memoryCache(name.name)
  const at = await cache.get('client/at')
  await cache.set('client/at', { ...at, cursor: at.cursor - 3 })
  await cache.set(`note/${note}`, { ...(await cache.get(`note/${note}`)), text: 'a stale cache says this' })
  const cold = await R.openRoom({ storage: name })
  t.after(() => cold.stop().catch(() => {}))
  assert.equal(cold.model.notes.size, 0, 'nothing of the stale cache is shown')
  assert.equal(cold.model.sessions.size, 1, 'the sessions come from the device itself')
  await cold.start()
  await cold.settle()
  await until(() => cold.model.notes.get(note)?.text === 'kept in the cache', 'the model built again from the Desk and a rescan')
  assert.deepEqual(cold.model.stack, [card])
  assert.equal(cold.model.cards.get(card).title, 'Still here after a restart?')
  assert.equal(cold.model.notes.get(offline).text, 'written offline')
})
