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

test('the recovery of 8.7: a new device with the code removes every other human device, replaces the code and reads the history', async t => {
  const { fake, R, a, agent, recovery_code } = await scene(t, { agent: true })
  const note = await a.saveNote({ text: 'written by the device that is lost' })
  const card = await agent.askCard({ title: 'Asked before the recovery', options: [{ key: 'ok', label: 'OK' }] })
  await a.settle(); await agent.settle()
  const lost = a.my_device_id, room_id = a.model.room.room_id
  await a.stop()
  let new_code = null, asked = 0, posted_before = null
  const { client: c } = await R.joinWithCode({ storage: storage('c'), hub_url: fake.url, room_id, code: recovery_code, recover: true, device_name: 'c',
    account: code => { asked++; new_code = code.slice(); posted_before = fake.requests.filter(r => /\/recovery/.test(r.path)).length; return null } })
  t.after(() => c.stop().catch(() => {}))
  assert.equal(asked, 1, 'the new code is told once')
  assert.equal(posted_before, 0, 'and before the recovery is opened at the hub')
  assert.equal(new_code.length, 32)
  assert.notDeepEqual([...new_code], [...recovery_code])
  const room = [...fake.state.rooms.values()][0]
  assert.equal(room.devices.has(Buffer.from(lost, 'hex').toString('base64url')), false, 'the lost device is out')
  await c.start()
  await c.settle()
  assert.ok(!c.model.members.get(lost)?.is_active)
  await until(() => c.model.notes.get(note)?.text === 'written by the device that is lost', 'the room\'s history')
  await until(() => c.model.cards.get(card)?.title === 'Asked before the recovery', 'the session\'s history')
  // the new code is the one in force, the old one is not; the session works on
  await c.checkRecoveryCode(new_code)
  await assert.rejects(c.checkRecoveryCode(recovery_code), { code: 'wrong-recovery' })
  await c.answer({ object_id: card, choices: ['ok'] })
  await c.settle(); await agent.settle()
  assert.equal(agent.commands.filter(x => x.kind === 'answer').length, 1)
})

test('a client that was never started replaces the recovery code: the request is posted and merged, nothing waits on a pump', async t => {
  const { fake, R, a, recovery_code, name } = await scene(t)
  await a.settle()
  await a.stop()
  const idle = await R.openRoom({ storage: name })
  t.after(() => idle.stop().catch(() => {}))
  let new_code = null
  await idle.replaceRecoveryCode({ code: recovery_code, account: code => { new_code = code.slice(); return null } })
  assert.ok(fake.requests.some(r => /recovery-code$/.test(r.path) && r.status === 200))
  await idle.checkRecoveryCode(new_code)
  await assert.rejects(idle.replaceRecoveryCode({ code: recovery_code, account: () => null }), { code: 'wrong-recovery' })
})
