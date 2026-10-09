// The typed routes a human device reads and writes, against the fake hub: the Desk, pages of a Chat, a board, an
// object, a chain, a group's log and GroupInfo, Welcomes, KeyPackages, sealed keys, requests, invites, the account,
// a recovery, push. Each is checked for the request it makes and for what it hands on.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { b64u, hex } from '../../../app/web/core/ids.ts'
import { scene, client, received, envelope, id, utf8, txt } from './helpers.mjs'

const copy = () => { const c = new Uint8Array(randomBytes(61)); c[0] = 2; return c }
const KDF = { alg: 'argon2id', v: 1, m: 65536, t: 3, p: 1 }

test('the Desk: open objects with their current version, registers, groups, the room\'s change', async t => {
  const { hub, room_id, device } = await scene(t)
  const card = id(16), note = id(16), register_id = id(16)
  const object = (object_id, object_type, object_state, urgency) => ({ object_id, object_type, object_state, urgency, answered_at: 0 })
  await hub.postEnvelope(envelope(room_id, device, 1, { kind: 'version', object: object(card, 'card', 'open', 'high') }))
  await hub.postEnvelope(envelope(room_id, device, 2, { kind: 'version', object: object(note, 'note', 'open', 'normal') }))
  await hub.postEnvelope(envelope(room_id, device, 3, { kind: 'register', register_id }))
  await hub.postEnvelope(envelope(room_id, device, 4, { kind: 'version', object: object(note, 'note', 'closed', 'normal') }))
  const desk = await hub.desk()
  assert.deepEqual(desk.cards.map(c => [c.object_id, c.group, c.state, c.urgency, c.owner, c.first_change, c.head_change, c.version.change]), [[card, room_id, 1, 2, device, 1, 1, 1]])
  assert.deepEqual(desk.cards[0].version.envelope, envelope(room_id, device, 1, { kind: 'version', object: object(card, 'card', 'open', 'high') }))
  assert.deepEqual([desk.notes, desk.permission_requests, desk.artifacts], [[], [], []])
  assert.deepEqual(desk.registers.map(r => r.change), [3])
  assert.deepEqual(desk.groups.map(g => [g.group, g.kind, g.session_id, g.epoch, g.live, g.leaves]), [[room_id, 'room', null, 0, true, [device]]])
  assert.deepEqual([desk.truncated, desk.change], [false, 4])

  const all = await hub.objectEnvelopes('notes', note)
  assert.deepEqual([all.object_id, all.state, all.items.map(i => i.change), all.more], [note, 3, [2, 4], false])
  assert.deepEqual((await hub.objectEnvelopes('notes', note, { after: 2 })).items.map(i => i.change), [4])
  await assert.rejects(hub.objectEnvelopes('cards', note), e => e.code === 'not-found')
})

test('a Chat\'s pages come newest first, a board\'s items oldest first, a chain by its numbers', async t => {
  const { fake, hub, room_id, device } = await scene(t)
  const session = id(16), board = id(16)
  for (let seq = 1; seq <= 5; seq++) await hub.postEnvelope(envelope(room_id, device, seq, { timeline: { kind: 'chat', scope: 'session', ref: session } }))
  for (let seq = 6; seq <= 8; seq++) await hub.postEnvelope(envelope(room_id, device, seq, { timeline: { kind: 'board', scope: 'desk', ref: board } }))
  const newest = await hub.chatItems('session', session, { limit: 2 })
  assert.deepEqual([newest.items.map(i => i.change), newest.more], [[5, 4], true])
  const older = await hub.chatItems('session', session, { before: 4, limit: 10 })
  assert.deepEqual([older.items.map(i => i.change), older.more], [[3, 2, 1], false])
  assert.equal(received(fake, `/v2/chats/session/${hex(session)}/items`).length, 2, 'the timeline is named by 32 hex digits')
  assert.deepEqual((await hub.chatItems('card', session)).items, [])

  assert.deepEqual((await hub.boardItems(board)).items.map(i => i.change), [6, 7, 8])
  const one = await hub.boardItems(board, { after_change: 6, limit: 1 })
  assert.deepEqual([one.items.map(i => [i.change, i.void_code, i.cut]), one.more], [[[7, null, false]], true])
  assert.deepEqual(one.items[0].envelope, envelope(room_id, device, 7, { timeline: { kind: 'board', scope: 'desk', ref: board } }))

  const chain = await hub.chain(room_id, device, { after: 6 })
  assert.deepEqual(chain.items.map(i => [i.seq, i.change]), [[7, 7], [8, 8]])

  for (const [path, answer] of [
    [/\/chats\//, a => ({ ...a, items: [...a.items].reverse() })], [/\/boards\//, a => ({ ...a, items: [...a.items].reverse() })],
    [/\/chains\//, a => ({ ...a, items: [...a.items].reverse() })], [/\/chains\//, a => ({ ...a, items: a.items.map(i => ({ ...i, seq: 0 })) })],
    [/\/chats\//, a => ({ ...a, items: a.items.map(i => ({ ...i, change: 99 })) })],
  ]) {
    fake.faults.add({ path, answer })
    const call = String(path).includes('chats') ? hub.chatItems('session', session, { before: 6 }) : String(path).includes('boards') ? hub.boardItems(board) : hub.chain(room_id, device)
    await assert.rejects(call, e => e.code === 'bad-answer')
  }
})

test('a group\'s log in pages, Commits alone, its GroupInfo by epoch, the room\'s groups', async t => {
  const { fake, hub, room_id } = await scene(t)
  for (let epoch = 0; epoch < 3; epoch++) {
    await hub.postCommit(room_id, { epoch, commit: utf8(`c${epoch}`), group_info: utf8(`i${epoch + 1}`), sealed_key: utf8(`s${epoch}`) })
    await hub.postMessage(room_id, epoch + 1, utf8(`m${epoch}`), false)
  }
  const first = await hub.groupLog(room_id, { limit: 4 })
  assert.deepEqual([first.items.map(i => `${i.n}${i.kind[0]}`), first.more], [['1c', '2m', '3c', '4m'], true])
  const rest = await hub.groupLog(room_id, { after: 4 })
  assert.deepEqual([rest.items.map(i => i.n), rest.more], [[5, 6], false])
  assert.deepEqual((await hub.groupLog(room_id, { commits_only: true })).items.map(i => [i.n, i.epoch]), [[1, 0], [3, 1], [5, 2]])
  assert.deepEqual(received(fake, `/v2/groups/${txt(room_id)}/log`).map(r => r.query), [{ after: '0', limit: '4' }, { after: '4', limit: '200' }, { after: '0', limit: '200', kind: 'commit' }])
  fake.faults.add({ path: /\/log$/, answer: a => ({ ...a, items: [a.items[1], a.items[0]] }) })
  await assert.rejects(hub.groupLog(room_id), e => e.code === 'bad-answer')
  fake.faults.add({ path: /\/log$/, answer: a => ({ ...a, items: a.items.map(i => ({ ...i, group_id: txt(id(32)) })) }) })
  await assert.rejects(hub.groupLog(room_id), e => e.code === 'bad-answer', 'entries of another group')

  assert.deepEqual(await hub.groupInfo(room_id), { epoch: 3, group_info: utf8('i3') })
  assert.deepEqual(await hub.groupInfo(room_id, 2), { epoch: 2, group_info: utf8('i2') })
  await assert.rejects(hub.groupInfo(room_id, 9), e => e.code === 'not-found')
  fake.faults.add({ path: /\/info$/, answer: a => ({ ...a, epoch: 1 }) })
  await assert.rejects(hub.groupInfo(room_id, 2), e => e.code === 'bad-answer', 'another epoch than asked for')
  assert.deepEqual((await hub.roomGroups()).map(g => [g.group, g.epoch]), [[room_id, 3]])
  await hub.rejectCommit(room_id, 3)
  assert.deepEqual((await hub.requests()).map(r => [r.kind, r.group, r.n]), [['reject', room_id, 3]])
})

test('KeyPackages: uploaded, claimed one each, the last-resort one when none is left; Welcomes; sealed keys', async t => {
  const { fake, hub, room_id, device } = await scene(t)
  const other = id(32)
  fake.state.rooms.get(txt(room_id)).devices.set(txt(other), 'human')
  const second = client(fake, room_id, other)
  assert.deepEqual(await second.putKeyPackages({ single_use: [utf8('kp1')], last_resort: utf8('last') }), { unused: 1 })
  assert.deepEqual(await hub.claimKeyPackages([other]), [{ device: other, key_package: utf8('kp1') }])
  assert.deepEqual(await hub.claimKeyPackages([other]), [{ device: other, key_package: utf8('last') }])
  assert.deepEqual(await hub.claimKeyPackages([other]), [{ device: other, key_package: utf8('last') }])
  const none = await hub.claimKeyPackages([other, device]).catch(e => e)
  assert.deepEqual([none.code, none.status, none.details.device], ['not-found', 404, txt(device)])
  fake.faults.add({ path: /claim$/, answer: a => ({ key_packages: { [txt(id(32))]: Object.values(a.key_packages)[0] } }) })
  await assert.rejects(hub.claimKeyPackages([other]), e => e.code === 'bad-answer', 'a KeyPackage of a device nobody asked for')
  await assert.rejects(hub.claimKeyPackages([other, new Uint8Array(other)]), { code: 'bad-argument' })

  await hub.postCommit(room_id, { epoch: 0, commit: utf8({ added: [other] }), group_info: utf8('i'), sealed_key: utf8('s1'), welcome: utf8('welcome') })
  const welcomes = await second.welcomes()
  assert.deepEqual(welcomes.map(w => [w.group, w.welcome]), [[room_id, utf8('welcome')]])
  assert.deepEqual(await hub.welcomes(), [])

  await hub.putSealedKey(utf8('s2'))
  const keys = await hub.sealedKeys()
  assert.deepEqual([keys.rows.map(r => r.sealed_key), keys.links, keys.more, keys.change], [[utf8('s1'), utf8('s2')], [], false, keys.rows[1].change])
  const paged = await hub.sealedKeys(0, 1)
  assert.deepEqual([paged.rows.length, paged.more, paged.change], [1, true, keys.rows[0].change])
  assert.deepEqual((await hub.sealedKeys(paged.change)).rows.map(r => r.sealed_key), [utf8('s2')])
  fake.faults.add({ path: '/v2/sealed-keys', answer: a => ({ ...a, change: 0 }) })
  await assert.rejects(hub.sealedKeys(), e => e.code === 'bad-answer', 'a cursor behind what was served')
  for (const answer of [a => ({ ...a, change: 2 ** 53 - 1, more: true }), a => ({ rows: [], links: [], change: 0, more: true }), ({ change, ...a }) => a]) {
    fake.faults.add({ path: '/v2/sealed-keys', answer })
    await assert.rejects(hub.sealedKeys(), e => e.code === 'bad-answer', 'a cursor that runs ahead, stalls or is missing')
  }
  fake.faults.add({ path: '/v2/sealed-keys', answer: a => ({ ...a, rows: [...a.rows].reverse() }) })
  await assert.rejects(hub.sealedKeys(), e => e.code === 'bad-answer')
})

test('an invite: Offer, Request, Reveal relayed by invite id; the new device needs no token', async t => {
  const { fake, hub, room_id } = await scene(t)
  const invite_id = id(16), offer = utf8({ room_id, invite_id, expires_at: Date.now() + 600_000 }), signature = new Uint8Array(64)
  assert.deepEqual(await hub.postInvite(offer, signature), { invite_id })
  assert.deepEqual(await hub.postInvite(offer, signature), { invite_id })

  const joiner = client(fake, null)
  const seen = await joiner.getInvite(invite_id)
  assert.deepEqual([seen.offer, seen.signature, seen.requests], [offer, signature, null])
  await assert.rejects(joiner.getReveal(invite_id), e => e.code === 'not-found')
  const request = { request: utf8('request'), mac: new Uint8Array(32), signature: new Uint8Array(64).fill(1) }
  const { request_hash } = await joiner.postInviteRequest(invite_id, request)
  assert.deepEqual(await joiner.postInviteRequest(invite_id, request), { request_hash })
  assert.ok(received(fake, /^\/v2\/invites\//).filter(r => r.path.endsWith('/request')).every(r => r.device === null), 'the Request came without a token')

  assert.deepEqual((await hub.getInvite(invite_id)).requests, [request])
  await hub.deleteInvite(invite_id)
  await assert.rejects(joiner.getInvite(invite_id), e => e.code === 'invite-burned' && e.status === 410)
})

test('the Reveal reaches the new device as the inviter put it', async t => {
  const reveals = new Map()
  const { fake, hub, room_id } = await scene(t, { readers: { reveal: bytes => reveals.get(Buffer.from(bytes).toString('hex')) } })
  const invite_id = id(16)
  await hub.postInvite(utf8({ room_id, invite_id, expires_at: Date.now() + 600_000 }), new Uint8Array(64))
  const joiner = client(fake, null)
  const { request_hash } = await joiner.postInviteRequest(invite_id, { request: utf8('request'), mac: new Uint8Array(32), signature: new Uint8Array(64) })
  const reveal = new Uint8Array(randomBytes(80)), signature = new Uint8Array(randomBytes(64))
  reveals.set(Buffer.from(reveal).toString('hex'), { invite_id: txt(invite_id), request_hash: txt(request_hash) })
  await hub.putReveal(invite_id, reveal, signature)
  await hub.putReveal(invite_id, reveal, signature)
  assert.deepEqual(await joiner.getReveal(invite_id), { reveal, signature })
  await assert.rejects(joiner.postInviteRequest(invite_id, { request: utf8('late'), mac: new Uint8Array(32), signature: new Uint8Array(64) }), e => e.code === 'invite-used')
})

test('the account: sign-up with the founding, login, the Emergency Kit, the password, passkeys', async t => {
  const { fake } = await scene(t)
  const room_id = id(32), device = id(32), outside = client(fake, null)
  const kit = { auth_key: new Uint8Array(randomBytes(32)), sealed_copy: copy() }, password = { auth_key: new Uint8Array(randomBytes(32)), sealed_copy: copy(), kdf: KDF }
  await outside.foundRoom({ group_info: utf8({ group: room_id, epoch: 0, leaves: [device] }), sealed_key: utf8('s'), account: { email: 'Ada@Example.com', kit, password } })
  assert.deepEqual(Object.keys(received(fake, '/v2/rooms').at(-1).body.account).sort(), ['email', 'kit', 'password'])

  const wrong = await outside.login('ada@example.com', new Uint8Array(32)).catch(e => e)
  const nobody = await outside.login('nobody@example.com', password.auth_key).catch(e => e)
  assert.deepEqual([wrong.code, wrong.status, wrong.transient], ['wrong-login', 401, false])
  assert.deepEqual([nobody.code, nobody.hub_message], [wrong.code, wrong.hub_message])
  assert.equal(received(fake, /\/challenge$/).length, 0, 'a wrong login is no reason to sign in to a room')
  const login = await outside.login('ada@example.com', password.auth_key)
  assert.deepEqual([login.rooms.length, login.rooms[0].room_id, login.rooms[0].sealed_copy, login.kdf], [1, room_id, password.sealed_copy, KDF])
  assert.equal(login.rooms[0].challenge.length, 32)
  const recovered = await outside.recover('ada@example.com', kit.auth_key)
  assert.deepEqual(recovered.rooms[0].sealed_copy, kit.sealed_copy)
  await assert.rejects(outside.recover('ada@example.com', password.auth_key), e => e.code === 'wrong-recovery' && e.status === 401)

  const hub = client(fake, room_id, device)
  await hub.signIn(login.rooms[0].challenge)             // the login's challenge saves the round trip
  assert.equal(received(fake, /\/challenge$/).length, 0)
  const account = await hub.account()
  assert.deepEqual([account.email, account.revision, account.has_password, account.kdf, account.password_copy, account.kit_copy, account.passkeys, account.rooms], ['ada@example.com', 1, true, KDF, password.sealed_copy, kit.sealed_copy, [], [room_id]])
  await assert.rejects(hub.createAccount({ email: 'other@example.com', kit, password }), e => e.code === 'account-exists' && e.status === 409)

  const next = { auth_key: new Uint8Array(randomBytes(32)), sealed_copy: copy(), kdf: KDF }
  assert.deepEqual(await hub.putPassword({ ...next, revision: 1 }), { revision: 2 })
  const stale = await hub.putKit({ auth_key: kit.auth_key, sealed_copy: copy(), revision: 1 }).catch(e => e)
  assert.deepEqual([stale.code, stale.status], ['account-changed', 409])
  assert.deepEqual(await hub.putKit({ auth_key: kit.auth_key, sealed_copy: copy(), revision: 2 }), { revision: 3 })
  await outside.login('ada@example.com', next.auth_key)

  const challenge = await hub.accountPasskeyChallenge()
  const client_data_json = utf8({ type: 'webauthn.create', challenge: b64u(challenge), origin: 'https://app.trommi.com' })
  const added = await hub.addPasskey({ attestation_object: new Uint8Array(randomBytes(120)), client_data_json, sealed_copy: copy(), transports: ['internal'] })
  assert.deepEqual((await hub.account()).passkeys.map(p => [p.credential_id, p.transports]), [[added.credential_id, ['internal']]])
  const sign_in = await outside.passkeyChallenge()
  const assertion = { credential_id: added.credential_id, authenticator_data: new Uint8Array(37), signature: new Uint8Array(70), client_data_json: utf8({ type: 'webauthn.get', challenge: b64u(sign_in), origin: 'https://app.trommi.com' }) }
  assert.deepEqual((await outside.passkeyLogin(assertion)).rooms[0].room_id, room_id)
  await assert.rejects(outside.passkeyLogin(assertion), e => e.code === 'wrong-login', 'a passkey challenge is used once')
  await hub.removePasskey(added.credential_id)
  assert.deepEqual((await hub.account()).passkeys, [])

  for (const answer of [a => ({ ...a, kit_copy: 'AAAA' }), a => ({ ...a, revision: -1 }), a => ({ ...a, rooms: ['x'] }), a => ({ ...a, kdf: { alg: { nested: true } } })]) {
    fake.faults.add({ path: '/v2/account', method: 'GET', answer })
    await assert.rejects(hub.account(), e => e.code === 'bad-answer')
  }
  fake.faults.add({ path: '/v2/account/login', answer: a => ({ ...a, rooms: [{ ...a.rooms[0], challenge: 'AAAA' }] }) })
  await assert.rejects(outside.login('ada@example.com', next.auth_key), e => e.code === 'bad-answer')
})

test('a recovery (8.7): opened by the recovery key, parts kept, published all at once, the answer repeatable', async t => {
  const fake_scene = await scene(t)
  const { fake, room_id, device } = fake_scene
  const recovery_key = id(32), joiner = id(32)
  fake.state.rooms.get(txt(room_id)).recovery_keys.add(txt(recovery_key))
  const hub = client(fake, room_id, recovery_key)
  const { recovery_id, expires_at } = await hub.openRecovery()
  assert.equal(hub.role, 'recovery')
  assert.ok(expires_at > Date.now())
  const busy = await fake_scene.hub.postEnvelope(envelope(room_id, device, 1)).catch(e => e)
  assert.deepEqual([busy.code, busy.status, busy.transient, busy.retry_after], ['overloaded', 503, true, 30], 'the room takes nothing else meanwhile, and that is no refusal')
  const part = { epoch: 0, commit: utf8({ added: [joiner], removed: [device] }), group_info: utf8('i1'), sealed_key: utf8('s1'), recovery_auth: utf8('auth') }
  assert.deepEqual(await hub.recoveryCommit(recovery_id, room_id, part), { epoch: 1, kept: true })
  assert.deepEqual(await hub.recoveryCommit(recovery_id, room_id, part), { epoch: 1, kept: true })
  assert.deepEqual(received(fake, new RegExp(`/recovery/${txt(recovery_id)}/commits$`))[0].body, { group_id: txt(room_id), epoch: 0, commit: b64u(part.commit), group_info: b64u(part.group_info), sealed_key: b64u(part.sealed_key), recovery_auth: b64u(part.recovery_auth) })
  assert.equal(fake.state.rooms.get(txt(room_id)).groups.get(txt(room_id)).epoch, 0, 'nothing is published before the finish')
  const done = await hub.finishRecovery(recovery_id, utf8('link'), null)
  assert.deepEqual([done.published, done.device], [true, joiner])
  assert.ok(done.first_change <= done.change)
  assert.deepEqual(await hub.finishRecovery(recovery_id, utf8('link'), null), done)
  assert.equal(fake.state.rooms.get(txt(room_id)).groups.get(txt(room_id)).epoch, 1)
  await assert.rejects(fake_scene.hub.desk(), e => e.code === 'not-member', 'the removed device\'s token ended')

  const again = await hub.openRecovery()
  assert.deepEqual(await hub.dropRecovery(again.recovery_id), { dropped: true })
})

test('push: registered, listed, removed', async t => {
  const { hub } = await scene(t)
  const web_push = { endpoint: 'https://push.example/abc', keys: { p256dh: new Uint8Array(65), auth: new Uint8Array(16) } }
  await hub.pushRegister({ web_push, level: 'knocking' })
  const state = await hub.pushState()
  assert.deepEqual(state.subscriptions.map(s => [s.kind, s.endpoint, s.level]), [['web_push', web_push.endpoint, 'knocking']])
  assert.equal(state.vapid_public_key.length, 65)
  assert.deepEqual(await hub.pushRemove(web_push.endpoint), { deleted: 1 })
  assert.deepEqual(await hub.pushRemove(), { deleted: 0 })
})

test('archive: a session group is archived and then takes no envelope; the room group is not archived', async t => {
  const { hub, room_id, device } = await scene(t)
  const group = new Uint8Array([...room_id, ...randomBytes(16)])
  await hub.foundGroup({ group_info_0: utf8({ group, epoch: 0, leaves: [device], session: { session_id: id(16), parent: null } }), sealed_key_0: utf8('s0'), commit: utf8('c'), group_info: utf8('i'), sealed_key: utf8('s') })
  assert.deepEqual(await hub.postEnvelope(envelope(group, device, 1)), { change: 4 })
  await hub.archiveGroup(group)
  await hub.archiveGroup(group)
  const gone = await hub.postEnvelope(envelope(group, device, 2)).catch(e => e)
  assert.deepEqual([gone.code, gone.status, gone.voided], ['gone', 410, false])
  await assert.rejects(hub.archiveGroup(room_id), e => e.code === 'forbidden')
  assert.deepEqual((await hub.roomGroups()).map(g => [g.kind, g.live]), [['room', true], ['main', false]])
})

test('servedRoom: what a device with the code needs, in the core\'s shape, from the recovery key\'s token', async t => {
  const { fake, hub, room_id, device, room } = await scene(t)
  const session = (parent = null) => ({ session_id: id(16), parent })
  const found = async (s, name) => {
    const group = new Uint8Array([...room_id, ...s.session_id])
    await hub.foundGroup({ group_info_0: utf8({ group, epoch: 0, leaves: [device], session: s, name }), sealed_key_0: utf8(`${name}-s0`), commit: utf8(`${name}-c0`), group_info: utf8(`${name}-i1`), sealed_key: utf8(`${name}-s1`) })
    return group
  }
  const main = session()
  const helper_group = await found(session(main.session_id), 'helper')      // founded first: the order served is by kind
  const main_group = await found(main, 'main'), gone = await found(session(), 'archived')
  await hub.archiveGroup(gone)
  for (let epoch = 0; epoch < 3; epoch++) await hub.postCommit(room_id, { epoch, commit: utf8(`c${epoch}`), group_info: utf8(`i${epoch + 1}`), sealed_key: utf8(`s${epoch}`), ...(epoch === 1 ? { recovery_auth: utf8('auth') } : {}) })
  await hub.postMessage(room_id, 3, utf8('a message is no part of it'), false)
  await hub.postRecoveryCode(room_id, { epoch: 3, commit: utf8('c3'), group_info: utf8('i4'), sealed_key: utf8('s3') }, utf8('link'), null)

  const key = id(32)
  room.recovery_keys.add(txt(key))
  const reader = client(fake, room_id, key)
  let asked = null
  const served = await reader.servedRoom({ anchorOf: rows => { asked = rows; return { group: room_id, epoch: 2 } } })
  assert.equal(reader.role, 'recovery')
  assert.deepEqual(served.room, room_id)
  assert.deepEqual(served.group.founding, utf8('{}'))
  assert.deepEqual(served.group.current, utf8('i4'))
  assert.deepEqual(served.group.commits.map(c => [new TextDecoder().decode(c.commit), c.recoveryAuth && new TextDecoder().decode(c.recoveryAuth)]), [['c0', null], ['c1', 'auth'], ['c2', null], ['c3', null]])
  assert.ok(served.group.commits.every((c, i, all) => c.change > (all[i - 1]?.change ?? 0)))
  assert.deepEqual(served.anchor, utf8('i2'))
  assert.equal(asked, served.rows)
  assert.deepEqual(served.rows.map(r => new TextDecoder().decode(r)).sort(), ['archived-s0', 'archived-s1', 'helper-s0', 'helper-s1', 'main-s0', 'main-s1', 's0', 's1', 's2', 's3'])
  assert.deepEqual(served.links, [utf8('link')])
  assert.deepEqual(served.sessions.map(g => [JSON.parse(new TextDecoder().decode(g.founding)).name, g.commits.length, new TextDecoder().decode(g.current)]), [['main', 1, 'main-i1'], ['helper', 1, 'helper-i1']])
  assert.ok(received(fake, /\/log$/).filter(r => r.device === txt(key)).every(r => r.query.kind === 'commit'))
  assert.deepEqual(await reader.servedGroup(main_group), served.sessions[0])
  assert.equal(helper_group.length, 48)

  // pages: a log and sealed keys longer than one answer
  fake.faults.add({ path: /\/log$/, times: 9, answer: a => ({ items: a.items.slice(0, 1), more: a.items.length > 1 }) })
  assert.deepEqual((await reader.servedGroup(room_id)).commits, served.group.commits)
  assert.equal(received(fake, `/v2/groups/${txt(room_id)}/log`).slice(-4).map(r => r.query.after).join(), '0,1,2,3')

  fake.faults.clear()
  // a Commit accepted while the room is being read lies beyond the current GroupInfo and is left out
  fake.faults.add({ path: `/v2/groups/${txt(room_id)}/info`, answer: a => ({ ...a, epoch: 3, group_info: Buffer.from('i3').toString('base64url') }) })
  const racing = await reader.servedGroup(room_id)
  assert.deepEqual([racing.commits.length, racing.current], [3, utf8('i3')])

  for (const [what, path, answer] of [
    ['a Commit is missing', /\/log$/, a => ({ ...a, items: a.items.filter(i => i.epoch !== 1) })],
    ['the log ends early', /\/log$/, a => ({ items: a.items.slice(0, 2), more: false })],
    ['a message among the Commits', /\/log$/, a => ({ ...a, items: a.items.map(i => ({ ...i, kind: 'message' })) })],
    ['more, and nothing', /\/log$/, () => ({ items: [], more: true })],
  ]) {
    fake.faults.add({ path, answer })
    await assert.rejects(reader.servedGroup(room_id), e => e.code === 'bad-answer', what)
  }
  await assert.rejects(reader.servedRoom({ anchorOf: () => ({ group: main_group, epoch: 0 }) }), { code: 'bad-argument' })
  await assert.rejects(reader.servedRoom({ anchorOf: () => ({ group: room_id, epoch: 99 }) }), e => e.code === 'not-found')
})

