// A page of a catch-up goes to the core in batches (`feed`, engine.ts `ingest`): the store writes a batch in one
// step. These tests hold the batch path against the item-by-item path: the same room in the end, whatever stands
// in the batch, and a batch that is stored whole or not at all. STAND-IN core (the real binding) and FAKE hub.
//
// TROMMI_TEST_HISTORY: how many changes the long history has (default 2000).
import test from 'node:test'
import assert from 'node:assert/strict'
import { addAgent, addHuman, failWrite, modelsAgree, scene, storage, storeSteps, until } from './helpers.mjs'

const HISTORY = Number(process.env.TROMMI_TEST_HISTORY ?? 2000)
const headOf = fake => [...fake.state.rooms.values()][0].change
/** Makes a device take everything item by item: its `feed` answers as a core that does not take the call. */
const itemByItem = client => { client.engine.device.feed = async () => { throw Object.assign(new Error('not taken'), { code: 'bad-format' }) } }
const noteTexts = model => [...model.notes.values()].map(n => n.text).sort()

test(`${HISTORY} changes taken in batches are the room they are taken item by item: with a refused item, a gap, a Welcome, a void record and own Commits among them`, async t => {
  const { fake, R, a, agent, recovery_code } = await scene(t, { agent: true })
  const b1 = await addHuman(t, R, a, 'b1'), b2 = await addHuman(t, R, a, 'b2')
  await b1.stop(); await b2.stop()

  const third = Math.floor(HISTORY / 3)
  const write = async (upTo, agents) => {
    for (let i = 0; headOf(fake) < upTo; i++) {
      await a.saveNote({ text: `note ${headOf(fake)}` })
      for (const g of agents) { await g.say({ text: `said ${i}` }); await a.sendMessage({ session_id: g.session_id, text: `asked ${i}` }) }
      await agents[i % agents.length].setRegister('status_line/run', { label: 'Run', state: 'working', detail: String(i) })
      if (i % 50 === 49) { await a.settle(30_000); for (const g of agents) await g.settle() }
    }
    await a.settle(30_000); for (const g of agents) await g.settle()
  }
  await write(third, [agent])
  // a void record: the hub keeps the envelope and refuses it (9.0.8)
  fake.faults.add({ method: 'POST', path: '/v2/envelopes', void: 'forbidden' })
  await a.saveNote({ text: 'the hub voids this one' })
  const garbled = await a.saveNote({ text: 'served as garbage in the hub\'s order' })
  await a.settle()
  const garbledAt = a.model.notes.get(garbled).envelope_number
  // a second session, founded while b1 and b2 are away: its Welcomes wait for them in the middle of the history
  const agent2 = await addAgent(t, a, {}, 'agent2')
  const card = await agent2.askCard({ title: 'Asked in the session they were welcomed to', options: [{ key: 'ok', label: 'OK' }] })
  await write(HISTORY, [agent, agent2])
  const head = headOf(fake)
  assert.ok(head >= HISTORY)
  // One envelope of the founder's chain is served as bytes that are no envelope, in every page that holds it: the
  // core refuses it in the middle of a batch, and the next envelope of that chain meets a gap, which is filled from
  // the chain's own route.
  fake.faults.add({ method: 'GET', path: '/v2/changes', times: 1e6, answer: json => ({ ...json, items: json.items.map(item => (item.change === garbledAt ? { ...item, envelope: Buffer.from('not an envelope at all').toString('base64url') } : item)) }) })

  /** Starts `client` and takes the whole history; returns how many durable steps its store wrote for that. */
  const take = async (client, name, single) => {
    t.after(() => client.stop().catch(() => {}))
    if (single) itemByItem(client)
    const before = storeSteps(name)
    await client.start({ stream: false })
    await client.settle(120_000)
    assert.ok(client.engine.position >= head)
    return storeSteps(name) - before
  }
  // two devices that were away (joined by link before the history)
  const again1 = await R.openRoom({ storage: b1.stored_as }), again2 = await R.openRoom({ storage: b2.stored_as })
  const batched = await take(again1, b1.stored_as.name, false), single = await take(again2, b2.stored_as.name, true)
  // two devices that sign in with the code after it: their own join Commits come back in the history they take
  const name1 = storage('c1'), name2 = storage('c2')
  const { client: c1 } = await R.joinWithCode({ storage: name1, hub_url: fake.url, room_id: a.model.room.room_id, code: recovery_code, device_name: 'c1' })
  const codeBatched = await take(c1, name1.name, false)
  const { client: c2 } = await R.joinWithCode({ storage: name2, hub_url: fake.url, room_id: a.model.room.room_id, code: recovery_code, device_name: 'c2' })
  const codeSingle = await take(c2, name2.name, true)
  fake.faults.clear()
  await a.settle()
  for (const c of [again1, again2, c1, c2]) await c.settle(60_000)

  modelsAgree(again1.model, again2.model, 'the device that took batches and the one that took single items')
  modelsAgree(a.model, again1.model, 'the founder and the device that took batches')
  for (const key of [`chat:session/${agent.session_id}`, `chat:session/${agent2.session_id}`]) assert.equal(again1.model.timelines.get(key)?.item_count, again2.model.timelines.get(key)?.item_count, `as many items in ${key}`)
  modelsAgree(c1.model, c2.model, 'the signed-in device that took batches and the one that took single items')
  for (const [what, c] of [['batches', again1], ['single items', again2]]) {
    assert.ok(c.model.sessions.get(agent2.session_id)?.group_id, `${what}: the session it was welcomed to in the middle`)
    assert.equal(c.model.cards.get(card)?.title, 'Asked in the session they were welcomed to', `${what}: and what was asked there`)
    assert.equal(noteTexts(c.model).includes('the hub voids this one'), false, `${what}: the voided note is not shown`)
    assert.equal(c.model.notes.get(garbled)?.text, 'served as garbage in the hub\'s order', `${what}: the garbled envelope came by its chain`)
    assert.ok(c.model.alerts.length >= 1, `${what}: the garbage was said`)
  }
  assert.equal(c1.is_human && c2.is_human, true)
  assert.ok([...a.model.members.values()].filter(m => m.device_role === 'human' && m.is_active).length >= 5, 'the founder sees every device')
  // what it is for: a batch is one durable step of the store, an item taken alone is one each
  t.diagnostic(`durable steps of the store for ${head} changes: the away device ${batched} in batches, ${single} item by item; the signed-in device ${codeBatched} and ${codeSingle}`)
  assert.ok(batched * 10 < single, `the away device: ${batched} durable steps in batches against ${single} item by item`)
  assert.ok(codeBatched * 5 < codeSingle, `the signed-in device: ${codeBatched} durable steps in batches against ${codeSingle} item by item`)
})

test('the store fails under a batch: nothing of the batch is taken, the device is opened again and takes it then', async t => {
  const { fake, R, a, agent, b } = await scene(t, { agent: true, second: true })
  await b.stop()
  for (let i = 0; i < 40; i++) { await a.saveNote({ text: `note ${i}` }); await agent.say({ text: `said ${i}` }); await a.sendMessage({ session_id: agent.session_id, text: `asked ${i}` }) }
  await a.settle(); await agent.settle()
  const head = headOf(fake)
  const again = await R.openRoom({ storage: b.stored_as })
  t.after(() => again.stop().catch(() => {}))
  const from = again.engine.position
  assert.ok(head - from >= 100, `${head - from} changes wait`)
  const at = []
  again.engine.on('reopened', () => at.push({ position: again.engine.position, cursor: again.engine.cursor }))
  // the write that follows the page's arrival is the first batch's: it fails, having written nothing
  fake.faults.add({ method: 'GET', path: '/v2/changes', answer: json => { failWrite(b.stored_as.name); return json } })
  await again.start({ stream: false })
  assert.deepEqual(at, [{ position: from, cursor: from }], 'opened again once, at the place of before the batch: none of it was taken')
  await again.settle()
  assert.ok(again.engine.position >= head, 'and then all of it')
  await a.settle()
  modelsAgree(a.model, again.model)
  // killed for good in the middle instead: what is stored is the device of before the batch, or of after it
  await again.stop()
  for (let i = 0; i < 40; i++) { await a.saveNote({ text: `later ${i}` }); await agent.say({ text: `later ${i}` }) }
  await a.settle(); await agent.settle()
  const dying = await R.openRoom({ storage: b.stored_as })
  const before = dying.engine.cursor
  fake.faults.add({ method: 'GET', path: '/v2/changes', answer: json => { failWrite(b.stored_as.name); return json } })
  dying.engine.on('reopened', () => { void dying.stop().catch(() => {}) })
  await dying.start({ stream: false }).catch(() => {})
  await until(async () => { try { return await R.openRoom({ storage: b.stored_as }) } catch { return null } }, 'the store free again').then(async last => {
    t.after(() => last.stop().catch(() => {}))
    assert.equal(last.engine.cursor, before, 'the stored device stands before the batch')
    await last.start({ stream: false })
    await last.settle()
    await a.settle()
    assert.ok(last.engine.position >= headOf(fake) - 1)
    modelsAgree(a.model, last.model)
  })
})
