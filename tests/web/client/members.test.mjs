// Removing a human device, and the takeover of an agent's session by a new agent device. The groups, Commits and
// keys are the REAL core's; content is the stand-in's plain JSON; the hub is the FAKE one (it takes who a Commit
// adds and removes from the stand-in's word, not from the Commit).
import test from 'node:test'
import assert from 'node:assert/strict'
import { addAgent, addHuman, scene, until } from './helpers.mjs'

const b64 = hexId => Buffer.from(hexId, 'hex').toString('base64url')

test('a removed human device reads nothing new, and every session is cleaned of it', async t => {
  // (the second device pulls instead of holding a stream: the fake hub writes into the stream of a device it just
  // removed, which ends the test process)
  const { fake, R, a, agent } = await scene(t, { agent: true })
  const b = await addHuman(t, R, a, 'b', { stream: false })
  const before = await a.saveNote({ text: 'both read this' })
  await b.catchUp()
  await a.settle(); await b.catchUp()
  assert.equal(b.model.notes.get(before).text, 'both read this')
  const room = [...fake.state.rooms.values()][0]
  const session = room.groups.get(b64(a.model.sessions.get(agent.session_id).group_id))
  assert.equal(session.leaves.has(b64(b.my_device_id)), true)

  const { key_epoch } = await a.removeDevices([b.my_device_id])
  assert.ok(key_epoch > 0)
  await a.settle()
  assert.equal(a.model.members.get(b.my_device_id).is_active, false)
  assert.equal(room.devices.has(b64(b.my_device_id)), false, 'the hub ended its access')
  assert.equal(session.leaves.has(b64(b.my_device_id)), false, 'the session group was cleaned (5.2.8)')
  assert.equal(a.model.sessions.get(agent.session_id).stale, false)
  await b.catchUp().catch(() => {})
  await until(() => b.model.room.connection === 'removed', 'the removed device learns it')

  const after = await a.saveNote({ text: 'only for those who stayed' })
  const card = await agent.askCard({ title: 'After the removal', options: [{ key: 'ok', label: 'OK' }] })
  await a.settle(); await agent.settle()
  assert.equal(a.model.cards.get(card).title, 'After the removal', 'the session works on')
  await assert.rejects(b.catchUp())
  assert.equal(b.model.notes.has(after), false)
  assert.equal(b.model.cards.has(card), false)
  // the removed device kept the keys it had; it holds none of the epochs after its removal
  const group = a.engine.groups.find(g => g.session === null)
  assert.equal(await b.engine.device.holdsKey(group.group, group.epoch).catch(() => false), false)
})

test('a new agent device takes a session over: the old one is out, the new one reads the history', async t => {
  const { fake, a, agent: old } = await scene(t, { agent: true })
  const session_id = old.session_id
  const card = await old.askCard({ title: 'Asked by the first machine', options: [{ key: 'go', label: 'Go' }] })
  await a.sendMessage({ session_id, text: 'said before the takeover' })
  await a.settle(); await old.settle()

  const next = await addAgent(t, a, { takeover: true, session_id }, 'agent-2')
  await a.settle()
  const session = a.model.sessions.get(session_id)
  assert.equal(next.session_id, session_id, 'the same session, not a new one')
  assert.equal(session.agent_device_id, next.device_id)
  assert.deepEqual(session.agent_device_ids, [next.device_id])
  assert.equal(session.stale, false)
  const room = [...fake.state.rooms.values()][0]
  assert.equal(room.devices.has(b64(old.device_id)), false, 'the first machine\'s device is no agent device any more')
  assert.equal(room.groups.get(b64(session.group_id)).leaves.has(b64(old.device_id)), false)
  assert.equal(a.model.members.get(old.device_id).is_active, false)

  // the history: the keys of the session's earlier epochs were handed over (5.3.2)
  await until(() => next.client.model.cards.get(card)?.title === 'Asked by the first machine', 'the card of before the takeover')
  await next.client.loadTimeline(`chat:session/${session_id}`)
  assert.ok([...next.client.model.timelines.get(`chat:session/${session_id}`).items.values()].some(i => i.content?.text === 'said before the takeover'))
  // the session goes on with the new device: it asks, the human answers, it hears
  const fresh = await next.askCard({ title: 'Asked by the second machine', options: [{ key: 'go', label: 'Go' }] })
  await next.settle(); await a.settle()
  await a.answer({ object_id: fresh, choices: ['go'] })
  await a.settle(); await next.settle()
  assert.deepEqual(next.commands.filter(c => c.kind === 'answer').map(c => c.object_id), [fresh])
  // a message to the session now goes to the new device
  const sent = await a.sendMessage({ session_id, text: 'welcome' })
  await a.settle()
  assert.equal([...a.model.timelines.get(`chat:session/${session_id}`).items.values()].find(i => i.local_id === sent.local_id).recipient_device_id, next.device_id)
  // the first machine can write nothing more
  await old.say({ text: 'still here?' }).catch(() => {})
  await old.client.settle({ timeout_ms: 1500 }).catch(() => {})
  await a.settle()
  assert.equal([...a.model.timelines.get(`chat:session/${session_id}`).items.values()].some(i => i.content?.text === 'still here?'), false)
})
