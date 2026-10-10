// The invite's own corners: what the fake hub reads of the REAL Offer, Request and Reveal (tests/web/stand-in/core.ts
// `hubReaders`), an invite whose Commit lost its epoch, and one that is finished after the inviter restarted. The
// invite handshake and its Commits are the REAL core's; content is the stand-in's; the hub is the FAKE one.
import test from 'node:test'
import assert from 'node:assert/strict'
import { hubReaders } from '../stand-in/core.ts'
import { scene, storage, until } from './helpers.mjs'

const b64 = bytes => Buffer.from(bytes).toString('base64url')

test('the readers of the fake hub read the real structs as the core made them', async t => {
  const { a } = await scene(t)
  const d = a.engine.device, R = (await scene(t)).R
  const opened = await d.inviteOpen('human', null, 'https://app.example', a.hub.hub_url, Date.now())
  const offer = hubReaders.offer(opened.offer)
  assert.deepEqual(offer, { room_id: b64(a.room_id), invite_id: b64(opened.inviteId), expires_at: opened.expiresAt })
  await a.hub.postInvite(opened.offer, opened.signature, opened.mac)
  const joining = R.joinRoom({ link: opened.link, storage: storage('reader'), poll_ms: 20 })
  joining.client.catch(() => {})
  const request = await until(async () => (await a.hub.getInvite(opened.inviteId)).requests?.[0], 'the Request at the hub')
  const accepted = await d.inviteAccept(opened.inviteId, request, Date.now())
  assert.equal(hubReaders.requestHash(request.request, request.mac), b64(accepted.requestHash), 'the Request\'s hash as the core computes it')
  assert.deepEqual(hubReaders.reveal(accepted.reveal), { invite_id: b64(opened.inviteId), request_hash: b64(accepted.requestHash) })
  joining.cancel()
})

test('the Commit of a confirmed invite loses its epoch to another device: it is built again and the newcomer gets in', async t => {
  const { fake, R, a, b } = await scene(t, { second: true })
  const invite = await a.createInvite({ device_role: 'human', app_url: 'https://app.example/join' })
  const joining = R.joinRoom({ link: invite.link, storage: storage('c'), poll_ms: 20, device_name: 'c' })
  await joining.check_code
  await until(() => a.model.invites.get(invite.invite_id)?.invite_state === 'confirm_code', 'the Request')
  // the other device commits in the room group at the same moment, and the hub takes that one first
  const room = a.engine.groups.find(g => g.session === null).group
  fake.faults.add({ method: 'POST', path: /\/commits$/, when: rq => rq.headers.authorization && rq.path.includes(Buffer.from(room).toString('base64url')), delay_ms: 150 })
  const confirming = a.confirmInvite(invite.invite_id, true)
  await b.engine.land(d => d.update(room, true, Date.now()))
  await confirming
  const c = await joining.client
  t.after(() => c.stop().catch(() => {}))
  assert.equal(a.model.invites.get(invite.invite_id).invite_state, 'joined')
  assert.ok(fake.requests.some(r => r.method === 'POST' && /\/commits$/.test(r.path) && r.status === 409), 'the first Commit met epoch-taken')
  assert.equal(a.model.members.get(c.my_device_id)?.is_active, true)
})

test('the inviter restarts after the confirmation: the invite is finished by what the core still lists to do', async t => {
  const { fake, R, a, agent, name } = await scene(t, { agent: true })
  const invite = await a.createInvite({ device_role: 'human', app_url: 'https://app.example/join' })
  const joining = R.joinRoom({ link: invite.link, storage: storage('late'), poll_ms: 20, device_name: 'late' })
  await joining.check_code
  await until(() => a.model.invites.get(invite.invite_id)?.invite_state === 'confirm_code', 'the Request')
  // confirmed, and the inviter is gone before anything of it was posted
  await fake.stop()
  a.confirmInvite(invite.invite_id, true).catch(() => {})
  await until(() => a.model.invites.get(invite.invite_id)?.invite_state === 'adding', 'the confirmation is stored')
  await a.flush()
  await a.stop()
  await fake.start()
  const again = await R.openRoom({ storage: name })
  t.after(() => again.stop().catch(() => {}))
  assert.equal(again.model.invites.get(invite.invite_id).invite_state, 'adding')
  await again.start()
  const late = await joining.client
  t.after(() => late.stop().catch(() => {}))
  await late.start()
  await until(() => again.model.invites.get(invite.invite_id)?.invite_state === 'joined', 'the invite finished after the restart')
  await until(() => late.model.sessions.get(agent.session_id)?.group_id, 'the newcomer in the agent\'s session')
  assert.equal([...fake.state.rooms.values()][0].devices.size, 3)
})
