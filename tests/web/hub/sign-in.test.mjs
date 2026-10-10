// Signing in to the hub (spec/v1.md 12.3) against the fake hub: the token is taken once, shared, renewed, and taken
// again once after the hub forgot it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { HubError } from '../../../app/web/core/hub.ts'
import { unb64u } from '../../../app/web/core/ids.ts'
import { scene, client, received, id, txt, utf8 } from './helpers.mjs'

test('the first request signs in by challenge and token; later ones reuse the token', async t => {
  const { fake, hub, room_id, signs } = await scene(t)
  await hub.desk()
  await hub.desk()
  await hub.welcomes()
  assert.deepEqual(fake.requests.map(r => `${r.method} ${r.path}`), [
    `GET /v1/rooms/${txt(room_id)}/challenge`, `POST /v1/rooms/${txt(room_id)}/tokens`, 'GET /v1/desk', 'GET /v1/desk', 'GET /v1/welcomes',
  ])
  assert.equal(signs.n, 1)
  assert.equal(hub.role, 'human')
  const posted = received(fake, `/v1/rooms/${txt(room_id)}/tokens`)[0].body
  assert.deepEqual(Object.keys(posted).sort(), ['auth', 'signature'])
  assert.equal(JSON.parse(new TextDecoder().decode(unb64u(posted.auth))).hub, fake.url, 'the device signs the hub address it talks to')
})

test('concurrent requests share one sign-in', async t => {
  const { fake, hub, room_id, signs } = await scene(t)
  await Promise.all([hub.desk(), hub.desk(), hub.welcomes(), hub.requests(), hub.changes(0)])
  assert.equal(received(fake, `/v1/rooms/${txt(room_id)}/tokens`).length, 1)
  assert.equal(signs.n, 1)
})

test('the token is renewed shortly before it runs out, without a refusal in between', async t => {
  const { fake, hub, room_id } = await scene(t, { token_ms: 400 })
  hub.timing.renew_before = 150
  await hub.desk()
  await new Promise(r => setTimeout(r, 280))
  await hub.desk()
  assert.equal(received(fake, `/v1/rooms/${txt(room_id)}/tokens`).length, 2)
  assert.ok(fake.requests.every(r => r.status === 200), 'no request met a 401')
})

test('a hub that forgot the token (a restart): one new sign-in, the request goes through', async t => {
  const { fake, hub, room_id } = await scene(t)
  await hub.desk()
  await fake.restart()
  const before = fake.requests.length
  hub.timing.get_retry = [10]          // the connection kept from before the restart is dead: that try is "not reached"
  await hub.desk()
  assert.deepEqual(fake.requests.slice(before).map(r => `${r.method} ${r.path} ${r.status}`), [
    'GET /v1/desk 401', `GET /v1/rooms/${txt(room_id)}/challenge 200`, `POST /v1/rooms/${txt(room_id)}/tokens 200`, 'GET /v1/desk 200',
  ])
})

test('a token the hub keeps refusing is tried again once, not for ever', async t => {
  const { fake, hub } = await scene(t)
  fake.faults.add({ path: '/v1/desk', times: 5, refuse: { error: 'unauthorised' } })
  await assert.rejects(hub.desk(), e => e instanceof HubError && e.code === 'unauthorised' && e.status === 401 && e.transient)
  assert.equal(received(fake, '/v1/desk').length, 2)
})

test('a challenge from a login is used; a stale one is replaced by a fresh one, once', async t => {
  const { fake, hub, room_id } = await scene(t)
  await hub.signIn(await hub.challenge(room_id))
  assert.equal(received(fake, `/v1/rooms/${txt(room_id)}/challenge`).length, 1)
  assert.equal(received(fake, `/v1/rooms/${txt(room_id)}/tokens`).length, 1)

  const other = client(fake, room_id, hub.room_id && fake.state.rooms.get(txt(room_id)).devices.keys().next().value)
  await other.signIn(new Uint8Array(32))           // a challenge the hub never issued
  assert.deepEqual(received(fake, `/v1/rooms/${txt(room_id)}/tokens`).map(r => r.status), [200, 401, 200])
})

test('a challenge the hub lost is replaced once; bad-challenge is never a refusal of what was to be sent', async t => {
  const { fake, hub, room_id, device } = await scene(t)
  fake.faults.add({ path: /\/tokens$/, refuse: { error: 'bad-challenge' } })
  await hub.desk()
  assert.deepEqual(received(fake, `/v1/rooms/${txt(room_id)}/tokens`).map(r => r.status), [401, 200])
  const other = client(fake, room_id, device)
  fake.faults.add({ path: /\/tokens$/, times: 5, refuse: { error: 'bad-challenge' } })
  const e = await other.desk().catch(x => x)
  assert.deepEqual([e.code, e.status, e.transient], ['bad-challenge', 401, true])
  assert.equal(received(fake, `/v1/rooms/${txt(room_id)}/tokens`).length, 4)
})

test('a signer replaced while its sign-in runs: neither its token nor its failure is the new one\'s; another room needs another Hub', async t => {
  const { fake, hub, room_id, device } = await scene(t)
  fake.faults.add({ path: /\/tokens$/, delay_ms: 80, refuse: { error: 'overloaded' } })
  const old = hub.desk().catch(e => e)
  await new Promise(r => setTimeout(r, 20))
  hub.useSigner(room_id, async (address, challenge) => ({ auth: utf8({ room_id, hub: address, device, challenge }), signature: new Uint8Array(64) }))
  await hub.desk()
  assert.equal((await old).code, 'overloaded')
  assert.throws(() => hub.useSigner(id(32), async () => ({ auth: new Uint8Array(1), signature: new Uint8Array(1) })), { code: 'bad-argument' })
})

test('a request that was aborted, or ran out of time, does not wait for a sign-in', async t => {
  const { fake, hub } = await scene(t)
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(hub.getFile(id(16), { signal: aborted.signal }), e => e.name === 'AbortError')
  assert.equal(fake.requests.length, 0)
  fake.faults.add({ path: /\/challenge$/, delay_ms: 300 })
  hub.timing.request = 50
  await assert.rejects(hub.request('GET', '/v1/desk'), e => e.code === 'offline')
})

test('a key without standing is refused as not-member, and that is no reason to try again', async t => {
  const { fake, room_id } = await scene(t)
  const stranger = client(fake, room_id, id(32))
  await assert.rejects(stranger.desk(), e => e instanceof HubError && e.code === 'not-member' && e.status === 403 && !e.transient)
  assert.equal(received(fake, `/v1/rooms/${txt(room_id)}/tokens`).length, 1)
  assert.equal(received(fake, '/v1/desk').length, 0, 'nothing was asked without a token')
})

test('a hostile token answer is refused: wrong types, a token that is no token', async t => {
  const { fake, hub } = await scene(t)
  for (const answer of [() => ({ token: 7, expires_at: 1, role: 'human' }), a => ({ ...a, token: 'short' }), a => ({ ...a, token: 'x'.repeat(40) + '\r\nx-evil: 1' }), a => ({ ...a, expires_at: '1' }), a => ({ ...a, role: 'owner' })]) {
    fake.faults.add({ path: /\/tokens$/, answer })
    await assert.rejects(hub.desk(), e => e instanceof HubError && e.code === 'bad-answer')
  }
  assert.equal(received(fake, '/v1/desk').length, 0)
  fake.faults.add({ path: /\/challenge$/, answer: () => ({ challenge: 'AAAA' }) })
  await assert.rejects(hub.desk(), e => e.code === 'bad-answer')
})

test('routes of the no-token block carry no authorization header; every request names the client', async t => {
  const { fake, hub, room_id } = await scene(t)
  const seen = []
  fake.faults.add({ times: 99, when: rq => { seen.push([rq.path, 'authorization' in rq.headers, rq.headers['trommi-client']]); return false } })
  await hub.challenge(room_id)
  await hub.passkeyChallenge()
  await assert.rejects(hub.login('a@example.com', new Uint8Array(32)), e => e.code === 'wrong-login')
  await hub.desk()
  assert.deepEqual(seen.filter(([p]) => p !== '/v1/desk').map(([, auth]) => auth), [false, false, false, false, false])
  assert.equal(seen.at(-1)[1], true)
  assert.ok(seen.every(([, , name]) => name === 'app/2.0.0'))
})
