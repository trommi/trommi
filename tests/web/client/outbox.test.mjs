// The outbox: written first, sent in order, each entry once, never dropped. the REAL core (real envelopes) and the FAKE hub; what is
// asserted on is the fake hub's request log.
import test from 'node:test'
import assert from 'node:assert/strict'
import { failWrite, scene, sleep, until } from './helpers.mjs'
import { hubReaders } from '../stand-in/core.ts'

/** An envelope's header as the fake hub reads it (real bytes: tests/web/stand-in/core.ts). */
const header = envelope => hubReaders.envelope(Buffer.from(envelope, 'base64url'))

/** The posts of Notes (other envelopes go out beside them: this device's own registers). */
const isNote = envelope => header(envelope).object?.object_type === 'note'
/** A fault for the next Notes only (a request the fake hub refuses by a fault is logged without its body). */
const onNotes = { method: 'POST', path: '/v2/envelopes', when: rq => isNote(JSON.parse(rq.raw.toString()).envelope) }
const sentBy = rq => rq.body?.envelope ?? null
const posts = fake => fake.requests.filter(r => r.method === 'POST' && r.path === '/v2/envelopes' && (r.body === null || isNote(r.body.envelope)))
const seqOf = r => header(r.body.envelope).seq
const noteTexts = model => [...model.notes.values()].map(n => n.text).sort()

test('sent while offline: delivered after the reconnect, exactly once, in order', async t => {
  const { fake, a, b } = await scene(t, { second: true })
  const before = posts(fake).length
  await fake.stop()
  for (const text of ['one', 'two', 'three']) await a.saveNote({ text })
  assert.equal(a.model.outbox.length, 3)
  assert.ok(a.model.outbox.every(o => o.outbox_state === 'sending'))
  assert.deepEqual(noteTexts(a.model), ['one', 'three', 'two'], 'the echoes show at once')
  await sleep(150)
  await fake.start()
  await a.settle(); await b.settle()
  const sent = posts(fake).slice(before).filter(r => r.status === 200 && r.device === Buffer.from(a.my_device_id, 'hex').toString('base64url'))
  const seqs = sent.map(seqOf)
  assert.equal(new Set(seqs).size, seqs.length, 'no envelope was accepted twice')
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y), 'in the order they were sealed')
  assert.equal(a.model.outbox.length, 0)
  assert.ok([...a.model.notes.values()].every(n => !n.pending))
  assert.deepEqual(noteTexts(b.model), ['one', 'three', 'two'])
})

test('a transient 503 is the same bytes again; a void refusal rolls the echo back and what follows is still sent', async t => {
  const { fake, a } = await scene(t)
  const from = posts(fake).length
  const bodies = []
  fake.faults.add({ ...onNotes, when: rq => { const e = JSON.parse(rq.raw.toString()).envelope; if (!isNote(e)) return false; bodies.push(e); return true }, refuse: { error: 'overloaded' }, times: 2 })
  const kept = await a.saveNote({ text: 'through a busy hub' })
  await a.settle()
  const tries = posts(fake).slice(from)
  assert.deepEqual(tries.map(r => r.status), [503, 503, 200])
  assert.deepEqual([...new Set([...bodies, sentBy(tries[2])])].length, 1, 'the same bytes each time')
  assert.equal(a.model.notes.get(kept).pending, false)

  // the hub keeps a void record for the next envelope and refuses it for good (9.0.8)
  const states = []
  a.on('change', ch => { if (ch.outbox) states.push(a.model.outbox.map(o => o.outbox_state).join(',')) })
  fake.faults.add({ ...onNotes, void: 'forbidden' })
  const refused = a.saveNote({ text: 'the hub will not have this' })
  const later = a.saveNote({ text: 'this one goes through' })
  const [gone, stays] = await Promise.all([refused, later])
  await a.settle()
  assert.equal(a.model.notes.has(gone), false, 'the echo was taken back')
  assert.equal(a.model.notes.get(stays).text, 'this one goes through')
  assert.equal(a.model.notes.get(stays).pending, false)
  assert.ok(states.some(s => s.split(',').includes('failed')), 'the views saw the outbox item fail')
  assert.ok(a.model.alerts.some(x => x.code === 'forbidden'))
  assert.equal(a.model.outbox.length, 0)
  assert.equal(a.model.room.outbox_blocked, null)
})

test('an envelope refused without a void record halts the pump; the same bytes go through later', async t => {
  const { fake, a } = await scene(t)
  const from = posts(fake).length
  const held = []
  fake.faults.add({ ...onNotes, when: rq => { const e = JSON.parse(rq.raw.toString()).envelope; if (!isNote(e)) return false; held.push(e); return true }, refuse: { error: 'bad-format' }, times: 2 })
  const first = await a.saveNote({ text: 'held up' })
  const second = await a.saveNote({ text: 'waits behind it' })
  await until(() => a.model.room.outbox_blocked, 'the halt is shown')
  assert.equal(a.model.room.outbox_blocked.code, 'bad-format')
  assert.equal(a.model.outbox[0].outbox_state, 'blocked')
  assert.ok(a.model.alerts.some(x => x.code === 'chain-halted'))
  await assert.rejects(a.settle({ timeout_ms: 100 }), { code: 'chain-halted' })
  await until(() => a.model.room.outbox_blocked === null, 'the pump goes on')
  await a.settle()
  const tries = posts(fake).slice(from)
  assert.deepEqual(tries.map(r => r.status), [400, 400, 200, 200])
  assert.equal(new Set([...held, sentBy(tries[2])]).size, 1, 'nothing else was signed under that number')
  assert.deepEqual([a.model.notes.get(first).pending, a.model.notes.get(second).pending], [false, false])
})

test('the client dies between sealing and posting: after the restart the envelope is sent, exactly once', async t => {
  const { fake, R, a, b, name } = await scene(t, { second: true })
  const from = posts(fake).length
  await fake.stop()
  const note = await a.saveNote({ text: 'sealed, not yet sent' })
  // (the nearest a test gets to a kill: the client is dropped with its envelope in the stored outbox; `stop` only
  // frees the store's lock, as a process that ends would)
  await a.stop()
  assert.equal(posts(fake).slice(from).filter(r => r.status === 200).length, 0)
  await fake.start()
  const again = await R.openRoom({ storage: name })
  t.after(() => again.stop().catch(() => {}))
  assert.equal(again.my_device_id, a.my_device_id)
  await again.start()
  await again.settle(); await b.settle()
  const mine = posts(fake).slice(from).filter(r => r.status === 200 && r.device === Buffer.from(a.my_device_id, 'hex').toString('base64url'))
  assert.equal(mine.filter(r => header(r.body.envelope).object?.object_id === Buffer.from(note, 'hex').toString('base64url')).length, 1)
  assert.equal(again.model.notes.get(note).text, 'sealed, not yet sent')
  assert.equal(b.model.notes.get(note).text, 'sealed, not yet sent')
})

test('two devices commit in the same epoch: one loses it, processes the log and commits again', async t => {
  const { fake, a, b } = await scene(t, { second: true })
  const room = [...fake.state.rooms.values()][0], group = room.groups.get(room.room_id)
  const epoch = group.epoch, id = a.engine.groups.find(g => g.session === null).group
  const commits = () => fake.requests.filter(r => r.method === 'POST' && /^\/v2\/groups\/[^/]+\/commits$/.test(r.path))
  const from = commits().length
  await Promise.all([a.engine.land(d => d.update(id, true, Date.now())), b.engine.land(d => d.update(id, true, Date.now()))])
  await a.settle(); await b.settle()
  assert.equal(group.epoch, epoch + 2, 'both Commits landed, one after the other')
  assert.ok(commits().slice(from).some(r => r.status === 409), 'one of them met epoch-taken first')
  assert.equal(a.engine.groups.find(g => g.session === null).epoch, epoch + 2)
  assert.equal(b.engine.groups.find(g => g.session === null).epoch, epoch + 2)
  const note = await b.saveNote({ text: 'after the race' })
  await b.settle(); await a.settle()
  assert.equal(a.model.notes.get(note).text, 'after the race')
})

test('a store write fails in the middle of an action: the device is opened again, the action is there or it is not', async t => {
  const { fake, a, name } = await scene(t)
  const kept = await a.saveNote({ text: 'before the failure' })
  await a.settle()
  let reopened = 0
  a.engine.on('reopened', () => { reopened++ })
  // the store fails while an envelope is sealed
  failWrite(name.name)
  await assert.rejects(a.saveNote({ text: 'never written' }), { code: 'storage' })
  assert.equal(reopened, 1)
  assert.deepEqual(noteTexts(a.model), ['before the failure'], 'the echo is gone: the envelope was not sealed')
  assert.equal(a.model.outbox.length, 0)
  const id = a.engine.groups.find(g => g.session === null).group, epoch = a.engine.groups.find(g => g.session === null).epoch
  // the store fails while a Commit is made
  failWrite(name.name)
  await assert.rejects(a.engine.land(d => d.update(id, true, Date.now())), { code: 'storage' })
  assert.equal(reopened, 2)
  assert.equal(a.engine.groups.find(g => g.session === null).epoch, epoch)
  assert.equal((await a.engine.outbox()).length, 0, 'the Commit is not there: nothing of it is sent')
  // and it works on from what is stored
  const next = await a.saveNote({ object_id: kept, text: 'after the failure' })
  await a.engine.land(d => d.update(id, true, Date.now()))
  await a.settle()
  assert.equal(a.model.notes.get(next).text, 'after the failure')
  assert.equal(a.model.notes.get(next).pending, false)
  assert.equal(a.engine.groups.find(g => g.session === null).epoch, epoch + 1)
  assert.equal([...fake.state.rooms.values()][0].groups.values().next().value.epoch, epoch + 1)
})

test('a Commit the hub took while its answer was lost: the same bytes again, merged once when it comes back in the hub\'s order', async t => {
  const { fake, a, b } = await scene(t, { second: true })
  const room = [...fake.state.rooms.values()][0], group = room.groups.get(room.room_id), epoch = group.epoch
  const id = a.engine.groups.find(g => g.session === null).group
  fake.faults.add({ method: 'POST', path: /\/commits$/, drop: 'after' })
  await a.engine.land(d => d.update(id, true, Date.now()))
  const posts = fake.requests.filter(r => r.method === 'POST' && /\/commits$/.test(r.path)).slice(-2)
  assert.equal(posts[0].dropped, 'after')
  assert.equal(posts[1].status, 200)
  assert.equal(group.epoch, epoch + 1, 'the hub took it once')
  assert.equal(a.engine.groups.find(g => g.session === null).epoch, epoch + 1)
  assert.equal(a.engine.groups.find(g => g.session === null).pending, false)
  await b.settle()
  assert.equal(b.engine.groups.find(g => g.session === null).epoch, epoch + 1)
})

test('a restart between the hub\'s answer to a Commit and its coming back: the Commit is merged from the log after the restart', async t => {
  const { fake, R, a, name } = await scene(t)
  await a.settle()
  await a.stop()
  // a client without a stream whose catch-up does not get through: the Commit is accepted and stays pending
  const held = await R.openRoom({ storage: name })
  const id = held.engine.groups.find(g => g.session === null).group, epoch = held.engine.groups.find(g => g.session === null).epoch
  await held.start({ stream: false })
  fake.faults.add({ method: 'GET', path: '/v2/changes', refuse: { error: 'overloaded' }, times: 1000 })
  const landing = held.engine.land(d => d.update(id, true, Date.now()))
  landing.catch(() => {})
  await until(() => fake.requests.some(r => r.method === 'POST' && /\/commits$/.test(r.path) && r.status === 200 && r.device === Buffer.from(held.my_device_id, 'hex').toString('base64url')), 'the hub took the Commit')
  await until(async () => (await held.engine.outbox()).length === 0, 'the answer was reported')
  assert.equal(held.engine.groups.find(g => g.session === null).epoch, epoch, 'not merged by the answer')
  assert.equal(held.engine.groups.find(g => g.session === null).pending, true)
  await held.stop()
  await assert.rejects(landing, { code: 'stopped' })
  fake.faults.clear()
  const again = await R.openRoom({ storage: name })
  t.after(() => again.stop().catch(() => {}))
  assert.equal(again.engine.groups.find(g => g.session === null).pending, true)
  await again.start()
  await again.settle()
  assert.equal(again.engine.groups.find(g => g.session === null).epoch, epoch + 1)
  assert.equal(again.engine.groups.find(g => g.session === null).pending, false)
  const note = await again.saveNote({ text: 'after the merge' })
  await again.settle()
  assert.equal(again.model.notes.get(note).pending, false)
})
