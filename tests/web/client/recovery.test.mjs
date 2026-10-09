// The recovery code. The recovery itself is the REAL core's (the binding: section 8); the hub is the FAKE one, which
// checks nothing of it, and stored content is the stand-in's.
import test from 'node:test'
import assert from 'node:assert/strict'
import { scene, storage, until } from './helpers.mjs'

test('a new device signs in with the recovery code: it is a human device, in every session, and reads the history', async t => {
  const { fake, R, a, agent, recovery_code } = await scene(t, { agent: true })
  const note = await a.saveNote({ text: 'written before the sign-in' })
  const card = await agent.askCard({ title: 'Asked before the sign-in', options: [{ key: 'ok', label: 'OK' }] })
  await a.settle(); await agent.settle()
  const { client: c } = await R.joinWithCode({ storage: storage('c'), hub_url: fake.url, room_id: a.model.room.room_id, code: recovery_code, device_name: 'c' })
  t.after(() => c.stop().catch(() => {}))
  assert.equal(c.is_human, true)
  await c.start()
  await c.settle(); await a.settle()
  assert.equal(a.model.members.get(c.my_device_id)?.device_role, 'human')
  assert.ok(a.model.alerts.some(x => x.code === 'recovery-add'), 'every human device is told that a device came in with the code')
  assert.ok(c.model.sessions.get(agent.session_id)?.group_id, 'it joined the session with the code too')
  await until(() => c.model.notes.get(note)?.text === 'written before the sign-in', 'the room\'s history')
  await until(() => c.model.cards.get(card)?.title === 'Asked before the sign-in', 'the session\'s history')
  await c.answer({ object_id: card, choices: ['ok'] })
  await c.settle(); await agent.settle(); await a.settle()
  assert.equal(a.model.cards.get(card).object_state, 'answered')
  assert.equal(agent.commands.filter(x => x.kind === 'answer').length, 1)
  // the code in force is known for what it is, and another is not
  await a.checkRecoveryCode(recovery_code)
  await assert.rejects(a.checkRecoveryCode(new Uint8Array(32).fill(3)), { code: 'wrong-recovery' })
  await assert.rejects(R.joinWithCode({ storage: storage('d'), hub_url: fake.url, room_id: a.model.room.room_id, code: new Uint8Array(32).fill(3) }))
})

test('the recovery of 8.7 with every device lost', { skip: 'not run: the fake hub does not replace the recovery key at a recovery\'s finish and checks none of its parts, and room.ts refuses (core-missing) to cut the chain of a removed device that wrote content, which every real room has: the core cannot verify stored content yet' }, () => {})
