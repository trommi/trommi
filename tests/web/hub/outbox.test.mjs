// postOutbox against the fake hub: every kind of core/src/store.rs `OutboxKind` goes to its route with its parts in
// their places, and a post that is sent again gets the first answer and is kept once.
import test from 'node:test'
import assert from 'node:assert/strict'
import { HubError, accountCopiesBytes } from '../../../app/web/core/hub.ts'
import { b64u } from '../../../app/web/core/ids.ts'
import { randomBytes } from 'node:crypto'
import { scene, client, received, envelope, id, utf8, txt } from './helpers.mjs'

const part = name => utf8(name)
const sent = name => b64u(utf8(name))
const entry = (kind, group, epoch, parts) => ({ id: 1, kind, group, epoch, parts })
const last = (fake, path) => received(fake, path).at(-1)
const copy = () => { const c = new Uint8Array(61); c[0] = 2; return c }

test('room_founding: POST /v2/rooms { group_info, sealed_key }, without a token', async t => {
  const { fake } = await scene(t)
  const room_id = id(32), device = id(32)
  const hub = client(fake, null)
  const group_info = utf8({ group: room_id, epoch: 0, leaves: [device] })
  const answer = await hub.postOutbox(entry('roomFounding', room_id, 0, [group_info, part('sealed-0')]))
  assert.deepEqual(answer, { change: null, room_id })
  assert.deepEqual(last(fake, '/v2/rooms').body, { group_info: b64u(group_info), sealed_key: sent('sealed-0') })
  assert.deepEqual(await hub.postOutbox(entry('roomFounding', room_id, 0, [group_info, part('sealed-0')])), answer, 'the same bytes: the first answer')
  await assert.rejects(hub.postOutbox(entry('roomFounding', room_id, 0, [utf8({ group: room_id, epoch: 0, leaves: [id(32)] }), part('sealed-0')])), e => e.code === 'room-exists' && e.status === 409)
  fake.faults.add({ path: '/v2/rooms', answer: () => ({ room_id: txt(id(32)) }) })
  await assert.rejects(hub.postOutbox(entry('roomFounding', room_id, 0, [group_info, part('sealed-0')])), e => e.code === 'bad-answer', 'another room than the one founded')
  assert.equal(fake.state.rooms.get(txt(room_id)).devices.get(txt(device)), 'human')
})

test('group_founding: POST /v2/groups with the six parts; an empty Welcome is left out', async t => {
  const { fake, hub, room_id, device } = await scene(t)
  const group = new Uint8Array([...room_id, ...randomBytes(16)]), session = { session_id: id(16), parent: null }
  const info = utf8({ group, epoch: 0, leaves: [device], session })
  const parts = [info, part('sealed-0'), part('commit-1'), part('info-1'), part('welcome-1'), part('sealed-1')]
  assert.deepEqual(await hub.postOutbox(entry('groupFounding', group, 0, parts)), { change: null, group_id: group })
  assert.deepEqual(last(fake, '/v2/groups').body, { group_info_0: b64u(info), sealed_key_0: sent('sealed-0'), commit: sent('commit-1'), group_info: sent('info-1'), sealed_key: sent('sealed-1'), welcome: sent('welcome-1') })
  await hub.postOutbox(entry('groupFounding', group, 0, parts))
  assert.equal(fake.state.rooms.get(txt(room_id)).groups.get(txt(group)).log.length, 1, 'founded once')

  const other = new Uint8Array([...room_id, ...randomBytes(16)])
  const bare = [utf8({ group: other, epoch: 0, leaves: [device], session }), part('s0'), part('c1'), part('i1'), new Uint8Array(0), part('s1')]
  await hub.postOutbox(entry('groupFounding', other, 0, bare))
  assert.equal('welcome' in last(fake, '/v2/groups').body, false)
})

test('commit and external_commit: POST /v2/groups/{group}/commits with the epoch they build on', async t => {
  const { fake, hub, room_id } = await scene(t)
  const path = `/v2/groups/${txt(room_id)}/commits`
  const first = await hub.postOutbox(entry('commit', room_id, 0, [part('commit-1'), part('info-1'), part('welcome-1'), part('sealed-1')]))
  assert.equal(first.epoch, 1)
  assert.ok(first.change > 0)
  assert.deepEqual(last(fake, path).body, { epoch: 0, commit: sent('commit-1'), group_info: sent('info-1'), sealed_key: sent('sealed-1'), welcome: sent('welcome-1') })

  const second = await hub.postOutbox(entry('commit', room_id, 1, [part('commit-2'), part('info-2'), new Uint8Array(0), part('sealed-2')]))
  assert.equal(second.epoch, 2)
  assert.deepEqual(Object.keys(last(fake, path).body).sort(), ['commit', 'epoch', 'group_info', 'sealed_key'])

  const joined = await hub.postOutbox(entry('externalCommit', room_id, 2, [part('join-3'), part('info-3'), part('sealed-3'), part('auth-3')]))
  assert.equal(joined.epoch, 3)
  assert.deepEqual(last(fake, path).body, { epoch: 2, commit: sent('join-3'), group_info: sent('info-3'), sealed_key: sent('sealed-3'), recovery_auth: sent('auth-3') })

  const taken = await hub.postOutbox(entry('commit', room_id, 1, [part('late'), part('info'), new Uint8Array(0), part('sealed')])).catch(e => e)
  assert.deepEqual([taken.code, taken.status, taken.details.epoch, taken.transient], ['epoch-taken', 409, 3, false])
  assert.deepEqual(await hub.postOutbox(entry('commit', room_id, 0, [part('commit-1'), part('info-1'), part('welcome-1'), part('sealed-1')])), first, 'a repeated Commit: its first answer')
})

test('message and relay_message: POST /v2/groups/{group}/messages', async t => {
  const { fake, hub, room_id } = await scene(t)
  const path = `/v2/groups/${txt(room_id)}/messages`
  assert.deepEqual(await hub.postOutbox(entry('message', room_id, 0, [part('m1')])), { change: null, n: 1 })
  assert.deepEqual(last(fake, path).body, { epoch: 0, message: sent('m1') })
  assert.deepEqual(await hub.postOutbox(entry('relayMessage', room_id, 0, [part('stroke')])), { change: null, n: null })
  assert.deepEqual(await hub.postOutbox(entry('relayMessage', room_id, 0, [part('stroke')])), { change: null, n: null }, 'a relay is passed on each time: no first answer to repeat')
  assert.deepEqual(last(fake, path).body, { epoch: 0, message: sent('stroke'), relay: true })
  assert.equal(fake.state.rooms.get(txt(room_id)).groups.get(txt(room_id)).log.length, 1, 'a relayed message is not stored')
})

test('envelope: POST /v2/envelopes { envelope }; sent twice it is stored once', async t => {
  const { fake, hub, room_id, device } = await scene(t)
  const bytes = envelope(room_id, device, 1)
  const answer = await hub.postOutbox(entry('envelope', room_id, 0, [bytes]))
  assert.deepEqual(answer, { change: 1 })
  assert.deepEqual(last(fake, '/v2/envelopes').body, { envelope: b64u(bytes) })
  assert.deepEqual(await hub.postOutbox(entry('envelope', room_id, 0, [bytes])), answer)
  assert.equal(fake.state.rooms.get(txt(room_id)).envelopes.length, 1)
  await assert.rejects(hub.postOutbox(entry('envelope', room_id, 0, [envelope(room_id, device, 1, { other: true })])), e => e.code === 'equivocation' && !e.transient)
})

test('an answer that was lost: the post goes once more at once; lost again it is "not reached", and the retry gets the first answer; nothing is doubled', async t => {
  const { fake, hub, room_id, device } = await scene(t)
  await hub.desk()
  fake.faults.add({ path: '/v2/envelopes', drop: 'after' })
  assert.deepEqual(await hub.postOutbox(entry('envelope', room_id, 0, [envelope(room_id, device, 1)])), { change: 1 }, 'the second arrival got the first answer')
  assert.deepEqual(received(fake, '/v2/envelopes').map(r => [r.dropped, r.status]), [['after', 200], [null, 200]])
  assert.equal(fake.state.rooms.get(txt(room_id)).envelopes.length, 1)

  const bytes = envelope(room_id, device, 2)
  fake.faults.add({ path: '/v2/envelopes', drop: 'after', times: 2 })
  await assert.rejects(hub.postOutbox(entry('envelope', room_id, 0, [bytes])), e => e instanceof HubError && e.code === 'offline')
  assert.equal(fake.state.rooms.get(txt(room_id)).envelopes.length, 2, 'the hub had stored it')
  assert.deepEqual(await hub.postOutbox(entry('envelope', room_id, 0, [bytes])), { change: 2 })
  assert.equal(fake.state.rooms.get(txt(room_id)).envelopes.length, 2)

  fake.faults.add({ path: /\/commits$/, drop: 'after', times: 2 })
  const commit = entry('commit', room_id, 0, [part('c'), part('i'), new Uint8Array(0), part('s')])
  await assert.rejects(hub.postOutbox(commit), e => e.code === 'offline')
  const answer = await hub.postOutbox(commit)
  assert.equal(answer.epoch, 1)
  assert.equal(fake.state.rooms.get(txt(room_id)).groups.get(txt(room_id)).log.length, 1)
})

test('an envelope the hub voids: the refusal says so, also when it is sent again', async t => {
  const { fake, hub, room_id, device } = await scene(t)
  const bytes = envelope(room_id, device, 1)
  fake.faults.add({ path: '/v2/envelopes', void: 'forbidden' })
  for (let i = 0; i < 2; i++) {
    const e = await hub.postOutbox(entry('envelope', room_id, 0, [bytes])).catch(x => x)
    assert.deepEqual([e.code, e.status, e.voided], ['forbidden', 403, true])
  }
  assert.equal(fake.state.rooms.get(txt(room_id)).change, 1, 'the void record took one number')
})

test('key_packages: PUT /v2/key-packages, the last-resort part first', async t => {
  const { fake, hub, room_id } = await scene(t)
  assert.deepEqual(await hub.postOutbox(entry('keyPackages', null, 0, [part('last'), part('kp1'), part('kp2')])), { change: null, unused: 2 })
  assert.deepEqual(last(fake, '/v2/key-packages').body, { single_use: [sent('kp1'), sent('kp2')], last_resort: sent('last') })
  assert.deepEqual(await hub.postOutbox(entry('keyPackages', null, 0, [new Uint8Array(0), part('kp3')])), { change: null, unused: 3 })
  assert.deepEqual(last(fake, '/v2/key-packages').body, { single_use: [sent('kp3')] })
  assert.equal(room_id, hub.room_id)
})

test('sealed_key: PUT /v2/sealed-keys { sealed_key }', async t => {
  const { fake, hub, room_id } = await scene(t)
  assert.deepEqual(await hub.postOutbox(entry('sealedKey', room_id, 3, [part('sealed')])), { change: null })
  assert.deepEqual(last(fake, '/v2/sealed-keys').body, { sealed_key: sent('sealed') })
  await hub.postOutbox(entry('sealedKey', room_id, 3, [part('sealed')]))
  assert.equal(fake.state.rooms.get(txt(room_id)).sealed_keys.length, 1)
})

test('recoveryCode: POST /v2/rooms/{room}/recovery-code; the account\'s new copies travel in the entry', async t => {
  const { fake, hub, room_id } = await scene(t)
  const none = accountCopiesBytes(null)
  assert.equal(none.length, 0)
  const parts = [part('commit'), part('info'), part('sealed'), part('link'), none]
  const answer = await hub.postOutbox(entry('recoveryCode', room_id, 0, parts))
  assert.equal(answer.epoch, 1)
  assert.deepEqual(last(fake, `/v2/rooms/${txt(room_id)}/recovery-code`).body, { commit: { epoch: 0, commit: sent('commit'), group_info: sent('info'), sealed_key: sent('sealed') }, recovery_link: sent('link'), account: null }, 'the Commit goes nested under `commit`')
  assert.deepEqual(await hub.postOutbox(entry('recoveryCode', room_id, 0, parts)), answer)
  assert.equal(fake.state.rooms.get(txt(room_id)).links.length, 1)

  const kit = { auth_key: new Uint8Array(randomBytes(32)), sealed_copy: copy() }
  await hub.createAccount({ email: 'a@example.com', kit, password: { auth_key: kit.auth_key, sealed_copy: kit.sealed_copy, kdf: { alg: 'argon2id', v: 1, m: 65536, t: 3, p: 1 } } })
  const copies = { kit, password: { sealed_copy: copy() } }
  await hub.postOutbox(entry('recoveryCode', room_id, 1, [part('commit-2'), part('info-2'), part('sealed-2'), part('link-2'), accountCopiesBytes(copies)]))
  assert.deepEqual(last(fake, `/v2/rooms/${txt(room_id)}/recovery-code`).body.account, { kit: { auth_key: b64u(kit.auth_key), sealed_copy: b64u(kit.sealed_copy)}, password: { sealed_copy: b64u(copies.password.sealed_copy) } })
  const passkey = { kit, passkey: { credential_id: new Uint8Array(20), sealed_copy: copy() } }
  const refused = await hub.postOutbox(entry('recoveryCode', room_id, 2, [part('c3x'), part('i3'), part('s3'), part('l3'), accountCopiesBytes(passkey)])).catch(e => e)
  assert.equal(refused.code, 'incomplete', 'the hub read the passkey copy and has no such passkey')
  assert.deepEqual(Object.keys(last(fake, `/v2/rooms/${txt(room_id)}/recovery-code`).body.account.passkey).sort(), ['credential_id', 'sealed_copy'])

  // a way in set anew: a password with its login key and derivation record; a passkey registered on a tokenless challenge
  const anew = { kit, password: { auth_key: new Uint8Array(randomBytes(32)), sealed_copy: copy(), kdf: { alg: 'argon2id', v: 1, m: 65536, t: 3, p: 1 } } }
  await hub.postOutbox(entry('recoveryCode', room_id, 2, [part('c3'), part('i3'), part('s3'), part('l3'), accountCopiesBytes(anew)]))
  assert.deepEqual(last(fake, `/v2/rooms/${txt(room_id)}/recovery-code`).body.account.password, { auth_key: b64u(anew.password.auth_key), sealed_copy: b64u(anew.password.sealed_copy), kdf: anew.password.kdf })
  const outside = client(fake, null)
  assert.equal((await outside.login('a@example.com', anew.password.auth_key)).rooms.length, 1, 'the new password is the way in')
  await assert.rejects(outside.login('a@example.com', kit.auth_key), e => e.code === 'wrong-login')
  const registration = { attestation_object: new Uint8Array(randomBytes(90)), client_data_json: utf8({ type: 'webauthn.create', challenge: b64u((await hub.accountPasskeyChallenge()).challenge), origin: 'https://app.trommi.com' }), sealed_copy: copy(), transports: ['internal', 'hybrid'] }
  await hub.postOutbox(entry('recoveryCode', room_id, 3, [part('c4'), part('i4'), part('s4'), part('l4'), accountCopiesBytes({ kit, passkey: registration })]))
  assert.deepEqual(Object.keys(last(fake, `/v2/rooms/${txt(room_id)}/recovery-code`).body.account.passkey).sort(), ['attestation_object', 'client_data_json', 'sealed_copy', 'transports'])
  const view = await hub.account()
  assert.deepEqual([view.has_password, view.passkeys.length, view.passkeys[0].sealed_copy], [false, 1, registration.sealed_copy], 'the passkey is the one way in')
  await assert.rejects(outside.login('a@example.com', anew.password.auth_key), e => e.code === 'wrong-login')

  // the flat form of the body is not read: the hub will drop it
  const flat = await hub.request('POST', `/v2/rooms/${txt(room_id)}/recovery-code`, { body: { epoch: 4, commit: sent('c'), group_info: sent('i'), sealed_key: sent('s'), recovery_link: sent('l'), account: null } }).catch(e => e)
  assert.deepEqual([flat.code, flat.status], ['bad-format', 400])

  // bytes that are not what accountCopiesBytes writes never become a request
  const before = fake.requests.length
  const k = { auth_key: b64u(kit.auth_key), sealed_copy: b64u(kit.sealed_copy)}, c61 = b64u(copy())
  const strict = [
    { kit: k, password: { sealed_copy: c61 }, passkey: { credential_id: 'AAAA', sealed_copy: c61 } },                       // two ways in
    { kit: k, password: { auth_key: k.auth_key, sealed_copy: c61 } },                                                         // a new password without its kdf
    { kit: k, password: { auth_key: k.auth_key, sealed_copy: c61, kdf: { alg: 'argon2id', v: 1, m: 65536, t: 3, p: 1, x: 1 } } },
    { kit: k, password: { auth_key: 'AAAA', sealed_copy: c61, kdf: { alg: 'argon2id', v: 1, m: 65536, t: 3, p: 1 } } },
    { kit: k, passkey: { attestation_object: 'AAAA', client_data_json: 'AAAA', sealed_copy: c61, transports: ['<script>'] } },
    { kit: k, passkey: { attestation_object: 'AAAA', sealed_copy: c61 } },
    { kit: k, passkey: { attestation_object: 'AAAA', client_data_json: 'AAAA', sealed_copy: c61, credential_id: 'AAAA' } },
  ].map(utf8)
  for (const account of [...strict, utf8('{"kit":{"auth_key":"AAAA","sealed_copy":"AAAA"}}'), utf8('[]'), utf8('not json'), utf8({ kit: k, email: 'x@example.com' }), utf8({ kit: { ...k, form: 'email' }, password: { sealed_copy: c61 } }), new Uint8Array([0xff])]) {
    await assert.rejects(hub.postOutbox(entry('recoveryCode', room_id, 4, [part('c'), part('i'), part('s'), part('l'), account])), { code: 'bad-argument' })
  }
  assert.equal(fake.requests.length, before)
})

test('recoveryCommit and recoveryFinish: the recovery\'s routes, under the recovery key\'s token and its recovery id', async t => {
  const { fake, room_id, device, room } = await scene(t)
  const key = id(32), joiner = id(32)
  room.recovery_keys.add(txt(key))
  const hub = client(fake, room_id, key)
  const { recovery_id } = await hub.openRecovery()
  const parts = [utf8({ added: [joiner], removed: [device] }), part('info-1'), new Uint8Array(0), part('sealed-1'), part('auth-1')]
  await assert.rejects(hub.postOutbox(entry('recoveryCommit', room_id, 0, parts)), { code: 'bad-argument' })
  assert.deepEqual(await hub.postOutbox(entry('recoveryCommit', room_id, 0, parts), { recovery_id }), { change: null, epoch: 1, kept: true })
  assert.deepEqual(last(fake, `/v2/rooms/${txt(room_id)}/recovery/${txt(recovery_id)}/commits`).body, { group_id: txt(room_id), epoch: 0, commit: b64u(parts[0]), group_info: sent('info-1'), sealed_key: sent('sealed-1'), recovery_auth: sent('auth-1') })
  assert.deepEqual(await hub.postOutbox(entry('recoveryCommit', room_id, 0, parts), { recovery_id }), { change: null, epoch: 1, kept: true })

  const finish = entry('recoveryFinish', room_id, 0, [part('link'), accountCopiesBytes(null)])
  await assert.rejects(hub.postOutbox(finish), { code: 'bad-argument' })
  const done = await hub.postOutbox(finish, { recovery_id })
  assert.deepEqual(last(fake, `/v2/rooms/${txt(room_id)}/recovery/${txt(recovery_id)}/finish`).body, { recovery_link: sent('link'), account: null })
  assert.deepEqual([done.published, done.device, done.change >= done.first_change], [true, joiner, true])
  assert.deepEqual(await hub.postOutbox(finish, { recovery_id }), done, 'the finish again: the same answer')
  assert.equal(room.groups.get(txt(room_id)).log.length, 1)
})

test('what the hub would do twice is never sent twice: a relayed message, a claim, a request, sign-up, a new password', async t => {
  const { fake, hub, room_id, device } = await scene(t)
  await hub.desk()
  const kit = { auth_key: new Uint8Array(randomBytes(32)), sealed_copy: copy() }, kdf = { alg: 'argon2id', v: 1, m: 65536, t: 3, p: 1 }
  const once = [
    ['POST', `/v2/groups/${txt(room_id)}/messages`, () => hub.postOutbox(entry('relayMessage', room_id, 0, [part('piece')]))],
    ['POST', '/v2/key-packages/claim', () => hub.claimKeyPackages([device])],
    ['POST', '/v2/requests', () => hub.postRequest({ kind: 'session' })],
    ['POST', `/v2/groups/${txt(room_id)}/reject`, () => hub.rejectCommit(room_id, 1)],
    ['POST', `/v2/rooms/${txt(room_id)}/recovery`, () => hub.openRecovery()],
    ['POST', '/v2/account', () => hub.createAccount({ email: 'a@example.com', kit, password: { auth_key: kit.auth_key, sealed_copy: kit.sealed_copy, kdf } })],
    ['PUT', '/v2/account/password', () => hub.putPassword({ auth_key: kit.auth_key, sealed_copy: kit.sealed_copy, kdf, revision: 1 })],
    ['PUT', '/v2/account/kit', () => hub.putKit({ ...kit, revision: 1 })],
    ['POST', '/v2/account/passkey/login', () => hub.passkeyLogin({ credential_id: new Uint8Array(16), authenticator_data: new Uint8Array(37), client_data_json: part('{}'), signature: new Uint8Array(64) })],
    ['DELETE', `/v2/files/${txt(id(16))}`, null],
    ['POST', '/v2/push', () => hub.pushRegister({ web_push: { endpoint: 'https://push.example/x', keys: { p256dh: new Uint8Array(65), auth: new Uint8Array(16) } }, level: 'all' })],
  ]
  for (const [method, path, call] of once) {
    fake.faults.add({ method, path, drop: 'after' })
    await assert.rejects(call ? call() : hub.request(method, path), e => e.code === 'offline', `${method} ${path}`)
    assert.equal(received(fake, path, method).length, 1, `${method} ${path} was sent once`)
  }
})

test('an entry with the wrong parts, group or kind is not sent', async t => {
  const { fake, hub, room_id } = await scene(t)
  await hub.desk()
  const before = fake.requests.length
  for (const bad of [
    entry('envelope', room_id, 0, []), entry('envelope', room_id, 0, [new Uint8Array(0)]), entry('commit', room_id, 0, [part('c'), part('i'), part('s')]),
    entry('commit', new Uint8Array(31), 0, [part('c'), part('i'), part('w'), part('s')]), entry('commit', null, 0, [part('c'), part('i'), part('w'), part('s')]),
    entry('commit', room_id, -1, [part('c'), part('i'), part('w'), part('s')]), entry('keyPackages', null, 0, []), entry('grant', room_id, 0, [part('x')]),
  ]) await assert.rejects(hub.postOutbox(bad), e => e.code === 'bad-argument')
  assert.equal(fake.requests.length, before)
})

test('a hostile answer to a post is not taken for an acceptance', async t => {
  const { fake, hub, room_id, device } = await scene(t)
  for (const answer of [() => ({}), () => ({ change: '5' }), () => ({ change: -1 }), () => ({ change: 0 }), () => ({ change: 2 ** 53 }), () => ({ change: 1.5 }), () => [], () => null]) {
    fake.faults.add({ path: '/v2/envelopes', answer })
    await assert.rejects(hub.postOutbox(entry('envelope', room_id, 0, [envelope(room_id, device, 1)])), e => e.code === 'bad-answer' && e.transient)
  }
  for (const answer of [a => ({ ...a, epoch: 5 }), a => ({ ...a, change: null }), () => ({ epoch: 1 })]) {
    fake.faults.add({ path: /\/commits$/, answer })
    await assert.rejects(hub.postOutbox(entry('commit', room_id, 0, [part('c'), part('i'), part('w'), part('s')])), e => e.code === 'bad-answer')
  }
})
