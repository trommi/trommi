// Founding a room, a second human device by link, an agent by link. Runs against the STAND-IN core (real MLS
// groups, plain JSON content and invites) and the FAKE hub.
import test from 'node:test'
import assert from 'node:assert/strict'
import { addHuman, modelsAgree, scene, storage, until } from './helpers.mjs'

test('a second human device joins by link: the same six numbers, history by handover, every live session', async t => {
  const { fake, R, a, agent } = await scene(t, { agent: true })
  const note = await a.saveNote({ text: 'written before anyone else was here' })
  await a.setDesk('11'.repeat(16), { name: 'Work', created_at: 1, order: 1 })
  const card = await agent.askCard({ title: 'Ship it?', options: [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }] })
  await agent.settle(); await a.settle()
  assert.deepEqual(a.model.stack, [card])

  const b = await addHuman(t, R, a)
  // the room's history opens with the keys the inviter handed over (7.1), not before
  await until(() => b.model.notes.get(note)?.text === 'written before anyone else was here', 'the note of before the join')
  await until(() => b.model.cards.get(card)?.title === 'Ship it?', 'the card of before the join')
  assert.equal(b.model.human.desks.get('11'.repeat(16)).name, 'Work')
  // every live session group holds the new device (5.2.7)
  const session = [...b.model.sessions.values()].find(s => s.session_id === agent.session_id)
  assert.ok(session?.group_id, 'the newcomer is in the agent\'s session')
  const hubGroup = [...fake.state.rooms.values()][0].groups.get(Buffer.from(session.group_id, 'hex').toString('base64url'))
  assert.equal(hubGroup.leaves.size, 3)
  assert.deepEqual(b.model.stack, [card])
  assert.equal(a.model.invites.size, 2)
  assert.ok([...a.model.invites.values()].every(i => i.invite_state === 'joined'))
  await a.settle(); await b.settle()
  modelsAgree(a.model, b.model)
  // the newcomer can write, and the first device reads it
  const second = await b.saveNote({ text: 'from the new device' })
  await b.settle(); await a.settle()
  assert.equal(a.model.notes.get(second).text, 'from the new device')
})

test('an agent joins by link and gets its main session; "they do not match" adds nobody', async t => {
  const { fake, R, a, agent } = await scene(t, { agent: true })
  const session = a.model.sessions.get(agent.session_id)
  assert.equal(session.agent_device_id, agent.device_id)
  assert.equal(session.is_active, true)
  assert.equal(a.model.members.get(agent.device_id).device_role, 'agent')
  assert.equal(agent.client.model.room.my_role, 'agent')

  const invite = await a.createInvite({ device_role: 'human', app_url: 'https://app.example/join' })
  const joining = R.joinRoom({ link: invite.link, storage: { name: 'refused-device' }, poll_ms: 20 })
  await joining.check_code
  await until(() => a.model.invites.get(invite.invite_id)?.invite_state === 'confirm_code', 'the Request')
  await assert.rejects(a.confirmInvite(invite.invite_id, false), { code: 'code-mismatch' })
  await assert.rejects(joining.client, { code: 'code-mismatch' })
  assert.equal(a.model.invites.get(invite.invite_id).invite_state, 'failed')
  assert.equal([...fake.state.rooms.values()][0].devices.size, 2)
  // nothing of the refused device is left: the same name founds or joins again
  assert.equal(await R.openRoom({ storage: { name: 'refused-device' } }), null)
})

test('an invite link past its deadline is refused here, before anything is asked of the hub', async t => {
  const { fake, R, a } = await scene(t)
  // an Offer opened twenty minutes ago (the inviter's clock): its link's deadline is long past
  const opened = await a.engine.device.inviteOpen('human', null, 'https://app.example', a.hub.hub_url, Date.now() - 20 * 60_000)
  await a.hub.postInvite(opened.offer, opened.signature, opened.mac)
  const since = fake.requests.length
  const joining = R.joinRoom({ link: opened.link, storage: storage('late'), poll_ms: 20 })
  await assert.rejects(joining.client, e => e.code === 'invite-expired')
  assert.equal(fake.requests.slice(since).filter(r => r.path.startsWith('/v1/invites')).length, 0, 'no request about the invite')
})

test('an Offer served without its MAC, or with another one, is not answered: bad-invite, nothing stored', async t => {
  const { fake, R, a } = await scene(t)
  for (const mac of [null, Buffer.alloc(32, 9).toString('base64url')]) {
    const invite = await a.createInvite({ device_role: 'human', app_url: 'https://app.example/join' })
    const held = [...fake.state.invites.values()].find(i => i.invite_id === Buffer.from(invite.invite_id, 'hex').toString('base64url'))
    held.mac = mac
    const since = fake.requests.length, name = storage('nomac')
    const joining = R.joinRoom({ link: invite.link, storage: name, poll_ms: 20 })
    await assert.rejects(joining.client, e => e.code === 'bad-invite', `MAC ${mac === null ? 'missing' : 'wrong'}`)
    assert.equal(fake.requests.slice(since).filter(r => r.method === 'POST' && r.path.endsWith('/request')).length, 0, 'no Request was posted')
  }
})
