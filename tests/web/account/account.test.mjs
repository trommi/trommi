// app/web/core/account.ts, every flow of the account screens, with:
// - the REAL core's binding for every key, sealed copy, word and code (core/wasm/pkg, loaded by core-node.mjs),
// - the app's own hub client (hub.ts) against the FAKE hub (tests/web/stand-in/hub.mjs: the account's routes with
//   their codes and the revision, no slow hash, no WebAuthn check, no cryptography),
// - a FAKE of room.ts's contract (room-fake.mjs): founding a room, joining with the code, a recovery and replacing
//   the code are JSON stand-ins there, with no MLS and no engine.
// So this shows that account.ts orders its steps right, builds the bodies the hub takes, seals and opens the right
// copies with the right keys, and tells no secret. It does not show that a device really joins a room with a code:
// that is room.ts's and the core's.
//
//   node --test tests/web/account/account.test.mjs        (the binding built: core/wasm/build.sh)
import test from 'node:test'
import assert from 'node:assert/strict'
import { startFakeHub } from '../stand-in/hub.mjs'
import { Hub } from '../../../app/web/core/hub.ts'
import { account as A, core, no_core, stage, resetStage, b64u, hex, unb64u, unhex, bytes, passkeyFor, assertionOf, unlockWith, refused, thrown, told } from './setup.mjs'

const skip = no_core ?? false
const CLIENT = 'app/2.0.0'
/** Every secret a test knew of: none may appear in what an error tells. Texts, and bytes in each spelling. */
const secrets = { texts: new Set(), bytes: [] }
const secretText = text => { secrets.texts.add(text); return text }
const secretBytes = b => { secrets.bytes.push(b.slice()); return b }

let n = 0
/** A fake hub and a fresh stage; `device(name)`: the options of a device with a store of its own. */
async function scene(t) {
  const fake = await startFakeHub()
  t.after(() => fake.close())
  resetStage({ fake })
  const tag = ++n
  return {
    fake, tag,
    email: `ada${tag}@example.org`,
    device: (name = 'first') => ({ hub_url: fake.url, storage: { name: `store-${tag}-${name}` }, client: CLIENT, device_name: name }),
    outside: () => new Hub({ hub_url: fake.url, client_name: CLIENT }),
    posts: (path, method = 'POST') => fake.requests.filter(r => r.path === path && r.method === method),
    last: fn => stage.calls.findLast(c => c.fn === fn),
  }
}
/** The account of a scene as the fake hub keeps it. */
const accountAt = s => [...s.fake.state.accounts.values()].find(a => a.email === s.email)
const PASSWORD = secretText('correct horse battery staple 42')
const OTHER = secretText('another-long-password-for-ada')
/** An account with a password, made as the screen makes it: { client, kit, code (hex), room (bytes) }. */
async function withPassword(s, password = PASSWORD) {
  const made = await A.createAccount({ ...s.device(), email: s.email, password })
  secretText(made.kit.words)
  const call = s.last('foundRoom')
  secretBytes(unhex(call.code))
  return { ...made, code: call.code, room: unhex(call.room_id) }
}
/** A tokenless passkey challenge as the page gets it (passkey.ts): the challenge as text, and the id it names. */
const challenge = async s => { const c = await s.outside().passkeyChallenge(); return { challenge: b64u(c.challenge), account: c.account, user_handle: c.user_handle } }
/** An account whose way in is a passkey (with an e-mail: its kit is made under the e-mail). */
async function withPasskey(s) {
  const named = await challenge(s)
  const passkey = passkeyFor(named.challenge)
  secretBytes(passkey.prf)
  const made = await A.createAccountWithPasskey({ ...s.device(), email: s.email, account: named.account, passkey: { ...passkey, prf: passkey.prf.slice() } })
  secretText(made.kit.words)
  const call = s.last('foundRoom')
  secretBytes(unhex(call.code))
  return { ...made, passkey, code: call.code, room: unhex(call.room_id) }
}
/** A passkey added to a signed-in device's account, the way Settings does it. */
async function addPasskey(client, unlock) {
  const passkey = passkeyFor(await A.passkeyChallengeFor(client))
  secretBytes(passkey.prf)
  const added = await A.addPasskey(client, { unlock, passkey: { ...passkey, prf: passkey.prf.slice() } })
  return { passkey, added }
}
/** What a way in opens at the hub now: the code (hex) its copy holds, through the hub's own login routes. */
async function opensWith(s, way) {
  const hub = s.outside()
  if (way.password !== undefined) {
    const keys = core.passwordKeys(s.email, way.password), room = (await hub.login(s.email, keys.authKey)).rooms[0]
    return hex(core.openRecoveryCode(keys.wrapKey, room.room_id, 'password', null, room.sealed_copy))
  }
  if (way.words !== undefined) {
    const keys = core.kitKeys(s.email, way.words), room = (await hub.recover(s.email, keys.authKey)).rooms[0]
    return hex(core.openRecoveryCode(keys.wrapKey, room.room_id, 'kit', null, room.sealed_copy))
  }
  const a = assertionOf(way.passkey, b64u((await hub.passkeyChallenge()).challenge)), room = (await hub.passkeyLogin(a)).rooms[0]
  return hex(core.openRecoveryCode(core.passkeyWrapKey(a.prf, room.room_id, a.credential_id), room.room_id, 'passkey', a.credential_id, room.sealed_copy))
}
const zeroed = b => b.every(x => x === 0)

// ---------------------------------------------------------------------------------------------------------------------
// Create account

test('create account (password): one founding with the account in it; the kit and the password open the code', { skip }, async t => {
  const s = await scene(t)
  const { client, kit, code, room } = await withPassword(s)
  assert.deepEqual(Object.keys(kit).sort(), ['account', 'email', 'form', 'words'])
  assert.deepEqual([kit.email, kit.form, kit.account], [s.email, 'email', accountAt(s).account], 'the kit names the account\'s id, which the hub minted')
  assert.equal(kit.words.split(' ').length, 12)
  assert.equal(core.parseKitWords(kit.words), kit.words)
  assert.ok(client.hub && client.core && client.room_id)

  // the hub got ONE write: the founding, with the sign-up body made for the room id the founding names (and then
  // the device, signed in, read the id the hub gave the account)
  assert.deepEqual(s.fake.requests.filter(r => !/\/(challenge|tokens)$/.test(r.path)).map(r => `${r.method} ${r.path}`), ['POST /v1/rooms', 'GET /v1/account'])
  const body = s.posts('/v1/rooms')[0].body.account
  assert.deepEqual(Object.keys(body).sort(), ['email', 'kit', 'password'])
  assert.equal(body.email, s.email)
  assert.deepEqual(Object.keys(body.kit).sort(), ['auth_key', 'sealed_copy'], 'a kit\'s form is not sent')
  assert.deepEqual(Object.keys(body.password).sort(), ['auth_key', 'kdf', 'sealed_copy'])
  assert.deepEqual(body.password.kdf, { alg: 'argon2id', v: 1, m: 65536, t: 3, p: 1 })

  const pw = core.passwordKeys(s.email, PASSWORD), kk = core.kitKeys(s.email, kit.words)
  secretBytes(pw.authKey); secretBytes(pw.wrapKey); secretBytes(kk.authKey); secretBytes(kk.wrapKey)
  assert.equal(body.password.auth_key, b64u(pw.authKey))
  assert.equal(body.kit.auth_key, b64u(kk.authKey))
  assert.equal(hex(core.openRecoveryCode(pw.wrapKey, room, 'password', null, unb64u(body.password.sealed_copy))), code)
  assert.equal(hex(core.openRecoveryCode(kk.wrapKey, room, 'kit', null, unb64u(body.kit.sealed_copy))), code)
  // neither wrap key, the code, the password nor the words went to the hub
  const sent = JSON.stringify(s.fake.requests.map(r => r.body))
  for (const secret of [b64u(pw.wrapKey), b64u(kk.wrapKey), b64u(unhex(code)), code, PASSWORD, kit.words]) assert.ok(!sent.includes(secret))
  // and the code account.ts made is zeroed in its hands once the room is founded
  assert.ok(zeroed(s.last('foundRoom').held.code))
  assert.equal(await opensWith(s, { password: PASSWORD }), code)
  assert.equal(await opensWith(s, { words: kit.words }), code)
})

test('create account: a mixed-case e-mail is kept in its one form; found_token is handed on', { skip }, async t => {
  const s = await scene(t)
  const { kit } = await A.createAccount({ ...s.device(), email: `  Ada${s.tag}@Example.ORG `, password: PASSWORD, found_token: 'the-word' })
  secretText(kit.words)
  assert.equal(kit.email, s.email)
  assert.equal(s.last('foundRoom').found_token, 'the-word')
})

test('create account: a weak password and a bad e-mail are refused before anything is founded or sent', { skip }, async t => {
  const s = await scene(t)
  await refused(A.createAccount({ ...s.device(), email: s.email, password: secretText('too short') }), 'weak-password')
  await refused(A.createAccount({ ...s.device(), email: 'ada at example', password: PASSWORD }), 'bad-email')
  await refused(A.createAccount({ ...s.device(), email: 'ädä@example.org', password: PASSWORD }), 'bad-email')
  assert.deepEqual(s.fake.requests, [])
  assert.deepEqual(stage.calls, [])
})

test('create account: an e-mail that has an account is account-exists, and nothing is stored on this device', { skip }, async t => {
  const s = await scene(t)
  await withPassword(s)
  const e = await refused(A.createAccount({ ...s.device('second'), email: s.email, password: OTHER }), 'account-exists')
  assert.equal(e.status, 409)
  assert.ok(!stage.stores.has(s.device('second').storage.name))
  assert.equal(s.fake.state.rooms.size, 1, 'the founding with the refused account left no room')
  // and the device that has a room does not found a second one
  await refused(A.createAccount({ ...s.device(), email: `new-${s.email}`, password: OTHER }), 'room-exists')
})

test('create account (passkey, with an e-mail): the registration and the kit; the id is the one the challenge named', { skip }, async t => {
  const s = await scene(t)
  const { kit, passkey, code, room } = await withPasskey(s)
  const body = s.posts('/v1/rooms')[0].body.account
  assert.deepEqual(Object.keys(body).sort(), ['email', 'kit', 'passkey'], 'no user handle is sent: the hub names the id')
  assert.deepEqual(Object.keys(body.passkey).sort(), ['attestation_object', 'client_data_json', 'sealed_copy', 'transports'])
  assert.deepEqual(body.passkey.transports, ['internal', 'hybrid'])
  assert.deepEqual([kit.email, kit.form, accountAt(s).kit_form, kit.account], [s.email, 'email', 'email', accountAt(s).account])
  assert.equal(s.posts('/v1/account', 'GET').length, 0, 'the id was in hand before the account existed')
  const wrap = core.passkeyWrapKey(passkey.prf, room, passkey.credential_id)
  assert.equal(hex(core.openRecoveryCode(wrap, room, 'passkey', passkey.credential_id, unb64u(body.passkey.sealed_copy))), code)
  assert.equal(hex(core.openRecoveryCode(core.kitKeys(s.email, kit.words).wrapKey, room, 'kit', null, unb64u(body.kit.sealed_copy))), code)
  // the prf output never went to the hub
  assert.ok(!JSON.stringify(s.fake.requests.map(r => r.body)).includes(b64u(passkey.prf)))
  assert.equal(await opensWith(s, { passkey }), code)
})

test('create account (passkey): no prf output is no-prf, an id that is not the challenge\'s form is refused, and nothing is founded', { skip }, async t => {
  const s = await scene(t)
  const named = await challenge(s), passkey = passkeyFor(named.challenge)
  const make = more => A.createAccountWithPasskey({ ...s.device(), email: s.email, account: named.account, passkey: { ...passkey, prf: passkey.prf.slice() }, ...more })
  await refused(make({ passkey: { ...passkey, prf: new Uint8Array(0) } }), 'no-prf')
  for (const account of [named.account.toUpperCase(), named.account.replaceAll('-', ''), s.email, '', undefined]) await refused(make({ account }), account ? 'bad-argument' : 'bad-account')
  await refused(make({ email: 'ada at example' }), 'bad-email')
  assert.deepEqual(stage.calls, [])
  assert.equal(s.posts('/v1/rooms').length, 0)
  const handed = passkey.prf.slice()
  await make({ passkey: { ...passkey, prf: handed } }).then(r => secretText(r.kit.words))
  assert.ok(zeroed(handed), 'the prf bytes handed in are zeroed')
})

test('create account (passkey): transports the hub would refuse are left out', { skip }, async t => {
  const s = await scene(t)
  const named = await challenge(s), passkey = passkeyFor(named.challenge)
  const { kit } = await A.createAccountWithPasskey({ ...s.device(), email: s.email, account: named.account, passkey: { ...passkey, transports: ['usb', 'NFC', 'smart-card', 'x'.repeat(17), 'ble2', ...Array(10).fill('hybrid')] } })
  secretText(kit.words)
  assert.deepEqual(s.posts('/v1/rooms')[0].body.account.passkey.transports, ['usb', 'smart-card', 'hybrid', 'hybrid', 'hybrid', 'hybrid', 'hybrid', 'hybrid'])
})

// ---------------------------------------------------------------------------------------------------------------------
// Log in on a new device

test('log in with the password on a new device: the copy opens, the device joins that room with the code', { skip }, async t => {
  const s = await scene(t)
  const { code, room } = await withPassword(s)
  const { client } = await A.loginWithPassword({ ...s.device('phone'), account: s.email.toUpperCase(), password: PASSWORD })
  const call = s.last('joinWithCode')
  assert.deepEqual([call.room_id, call.code, call.recover, call.new_code, call.account], [hex(room), code, false, null, undefined])
  assert.ok(zeroed(call.held.code), 'the code is zeroed once the device has joined')
  assert.deepEqual(client.room_id, room)
  assert.equal((await A.accountStatus(client)).email, s.email)
  assert.equal(s.fake.state.rooms.get(b64u(room)).devices.size, 2)
})

test('log in: a wrong password and an unknown e-mail are the same wrong-login, and nothing is joined', { skip }, async t => {
  const s = await scene(t)
  await withPassword(s)
  const wrong = await refused(A.loginWithPassword({ ...s.device('phone'), account: s.email, password: secretText('not the right password') }), 'wrong-login')
  const unknown = await refused(A.loginWithPassword({ ...s.device('phone'), account: `nobody-${s.email}`, password: PASSWORD }), 'wrong-login')
  // the screen's shape: a code, a status, a message of this app's own (auth.mjs accountError reads the code)
  assert.deepEqual([wrong.name, wrong.code, wrong.status, wrong.message], [unknown.name, unknown.code, unknown.status, unknown.message])
  assert.equal(wrong.status, 401)
  assert.equal(s.last('joinWithCode'), undefined)
  // the one field: a text that is neither an e-mail nor an id; an e-mail that is none; an id, which no password signs in under
  const before = s.fake.requests.length
  await refused(A.loginWithPassword({ ...s.device('phone'), account: 'no address', password: PASSWORD }), 'bad-account')
  await refused(A.loginWithPassword({ ...s.device('phone'), account: 'no address@x', password: PASSWORD }), 'bad-email')
  await refused(A.loginWithPassword({ ...s.device('phone'), account: accountAt(s).account, password: PASSWORD }), 'needs-email')
  assert.equal(s.fake.requests.length, before, 'none of them reached the hub')
})

test('log in with a passkey: no e-mail, the prf output opens the copy of that passkey', { skip }, async t => {
  const s = await scene(t)
  const { passkey, code, room } = await withPasskey(s)
  const assertion = assertionOf(passkey, b64u((await s.outside().passkeyChallenge()).challenge))
  const { client } = await A.loginWithPasskey({ ...s.device('phone'), assertion })
  assert.deepEqual([s.last('joinWithCode').room_id, s.last('joinWithCode').code], [hex(room), code])
  assert.ok(zeroed(assertion.prf), 'the prf bytes handed in are zeroed')
  assert.deepEqual(client.room_id, room)
  assert.ok(!JSON.stringify(s.fake.requests.map(r => r.body)).includes(b64u(passkey.prf)))
})

test('log in with a passkey: one the hub does not know is wrong-login; one without a prf output sends nothing', { skip }, async t => {
  const s = await scene(t)
  const { passkey } = await withPasskey(s)
  const stranger = passkeyFor('unused')
  await refused(A.loginWithPasskey({ ...s.device('phone'), assertion: assertionOf(stranger, b64u((await s.outside().passkeyChallenge()).challenge)) }), 'wrong-login')
  const before = s.fake.requests.length
  await refused(A.loginWithPasskey({ ...s.device('phone'), assertion: { ...assertionOf(passkey, 'none'), prf: new Uint8Array(0) } }), 'no-prf')
  assert.equal(s.fake.requests.length, before)
  // the right passkey with another prf output (another authenticator state): the copy does not open
  await refused(A.loginWithPasskey({ ...s.device('phone'), assertion: { ...assertionOf(passkey, b64u((await s.outside().passkeyChallenge()).challenge)), prf: secretBytes(bytes(32)) } }), 'wrong-login')
  assert.equal(s.last('joinWithCode'), undefined)
})

test('a hostile hub at login: a swapped copy, another room id, a cheaper key derivation', { skip }, async t => {
  const s = await scene(t)
  const mine = await withPassword(s)
  // another account's room and copy, on the same hub
  const other = await scene(t)
  resetStage({ fake: other.fake })
  const theirs = await withPassword(other)
  const their = (await other.outside().login(other.email, core.passwordKeys(other.email, PASSWORD).authKey)).rooms[0]
  resetStage({ fake: s.fake })
  const login = (answer => s.fake.faults.add({ method: 'POST', path: '/v1/account/login', answer }))

  // the kit's copy of the same code in the place of the password's
  const kit_copy = accountAt(s).kit_copy
  login(json => ({ ...json, rooms: json.rooms.map(r => ({ ...r, sealed_copy: kit_copy })) }))
  await refused(A.loginWithPassword({ ...s.device('a'), account: s.email, password: PASSWORD }), 'wrong-login')
  // a login answer for another account
  login(json => ({ ...json, rooms: [{ ...json.rooms[0], room_id: b64u(their.room_id), sealed_copy: b64u(their.sealed_copy) }] }))
  await refused(A.loginWithPassword({ ...s.device('b'), account: s.email, password: PASSWORD }), 'wrong-login')
  // the right copy under a wrong room id
  login(json => ({ ...json, rooms: [{ ...json.rooms[0], room_id: b64u(theirs.room) }] }))
  await refused(A.loginWithPassword({ ...s.device('c'), account: s.email, password: PASSWORD }), 'wrong-login')
  // no room at all
  login(json => ({ ...json, rooms: [] }))
  await refused(A.loginWithPassword({ ...s.device('d'), account: s.email, password: PASSWORD }), 'no-room')
  // a copy of another format
  login(json => ({ ...json, rooms: [{ ...json.rooms[0], sealed_copy: b64u(Uint8Array.of(1, ...unb64u(json.rooms[0].sealed_copy).subarray(1))) }] }))
  await refused(A.loginWithPassword({ ...s.device('e'), account: s.email, password: PASSWORD }), 'bad-format')
  assert.equal(s.last('joinWithCode'), undefined, 'nothing was joined with any of them')

  // a record that names a cheaper derivation changes nothing: the keys were derived with the pinned one before the
  // hub was asked, and the login key the hub got is that derivation's
  login(json => ({ ...json, kdf: { alg: 'argon2id', v: 1, m: 8, t: 1, p: 1 } }))
  await A.loginWithPassword({ ...s.device('f'), account: s.email, password: PASSWORD })
  assert.equal(s.last('joinWithCode').code, mine.code)
  assert.equal(s.posts('/v1/account/login').at(-1).body.auth_key, b64u(core.passwordKeys(s.email, PASSWORD).authKey))
})

test('a room.ts that cannot join with the code yet (the binding of today): core-missing, in the errors\' usual shape', { skip }, async t => {
  const s = await scene(t)
  const { code, kit } = await withPassword(s)
  stage.core_missing = true
  const e = await refused(A.loginWithPassword({ ...s.device('phone'), account: s.email, password: PASSWORD }), 'core-missing')
  assert.match(e.message, /^core-missing: /)
  assert.equal(s.last('joinWithCode').code, code, 'everything before the join ran: the copy opened to the room\'s code')
  assert.ok(zeroed(s.last('joinWithCode').held.code))
  await refused(A.recoverWithKit({ ...s.device('phone'), account: s.email, words: kit.words }), 'core-missing')
})

// ---------------------------------------------------------------------------------------------------------------------
// Forgot password, recovery

test('forgot password (kit words + new password): the ONE request of 8.7 with a new kit and the password set anew; the old ways and devices removed', { skip }, async t => {
  const s = await scene(t)
  const { client: first, kit: old_kit, code, room } = await withPassword(s)
  const { passkey } = await addPasskey(first, { password: PASSWORD })
  const { client, kit } = await A.resetPassword({ ...s.device('new'), account: s.email, words: old_kit.words.toUpperCase(), new_password: OTHER })
  secretText(kit.words)
  const join = s.last('joinWithCode')
  secretBytes(unhex(join.new_code))
  assert.deepEqual([join.room_id, join.code, join.recover], [hex(room), code, true])
  assert.ok(zeroed(join.held.code))
  assert.notEqual(join.new_code, code)
  assert.equal(s.last('replaceRecoveryCode'), undefined, 'no second step: the recovery replaces the code itself')
  // at the hub: nothing of the account is written but in the recovery's finish, with a new kit and the password anew
  const writes = s.fake.requests.filter(r => r.method !== 'GET' && /account\/password|recovery-code|recovery\/[^/]+\/finish/.test(r.path)).map(r => r.path.replace(/rooms\/[^/]+/, 'rooms/x').replace(/recovery\/[^/]+\//, 'recovery/y/'))
  assert.deepEqual(writes, ['/v1/rooms/x/recovery/y/finish'])
  const sent = s.fake.requests.find(r => /\/finish$/.test(r.path)).body.account
  assert.deepEqual([Object.keys(sent).sort(), Object.keys(sent.kit).sort(), Object.keys(sent.password).sort()], [['kit', 'password'], ['auth_key', 'sealed_copy'], ['auth_key', 'kdf', 'sealed_copy']])
  assert.notEqual(kit.words, old_kit.words)
  assert.equal(kit.email, s.email)

  // after it: the new password and the new kit open the NEW code; the old password, the old kit and the passkey nothing
  assert.equal(await opensWith(s, { password: OTHER }), join.new_code)
  assert.equal(await opensWith(s, { words: kit.words }), join.new_code)
  await refused(opensWith(s, { password: PASSWORD }), 'wrong-login')
  await refused(opensWith(s, { words: old_kit.words }), 'wrong-recovery')
  await refused(opensWith(s, { passkey }), 'wrong-login')
  const st = await A.accountStatus(client)
  assert.deepEqual([st.has_password, st.passkeys], [true, []])
  // the old code is no longer the room's
  await refused(A.recoverWithCode({ ...s.device('thief'), room_id: hex(room), code: core.formatRecoveryCode(unhex(code)), on_recovery_code: () => {} }), 'wrong-recovery')
  // it is the recovery of 8.7: every other human device is out of the room
  assert.equal(s.fake.state.rooms.get(b64u(room)).devices.size, 1)
})

test('forgot password: a recovery that fails before its finish leaves the account as it was; then it goes through', { skip }, async t => {
  const s = await scene(t)
  const { kit, code } = await withPassword(s)
  s.fake.faults.add({ method: 'POST', path: /\/finish$/, refuse: { error: 'overloaded', retry_after: 1 }, times: 20 })
  await assert.rejects(A.resetPassword({ ...s.device('one'), account: s.email, words: kit.words, new_password: OTHER }))
  s.fake.faults.clear()
  // nothing changed: the old password and the kit in hand open the old code
  assert.equal(await opensWith(s, { password: PASSWORD }), code)
  assert.equal(await opensWith(s, { words: kit.words }), code)
  await refused(opensWith(s, { password: OTHER }), 'wrong-login')
  // and once more, it goes through
  const done = await A.resetPassword({ ...s.device('three'), account: s.email, words: kit.words, new_password: OTHER })
  secretText(done.kit.words)
  const new_code = s.last('joinWithCode').new_code
  secretBytes(unhex(new_code))
  assert.equal(await opensWith(s, { password: OTHER }), new_code)
  assert.equal(await opensWith(s, { words: done.kit.words }), new_code)
})

test('forgot password: wrong words, words of no kit, a weak new password', { skip }, async t => {
  const s = await scene(t)
  const { kit } = await withPassword(s)
  const other = secretText(core.generateKitWords())
  await refused(A.resetPassword({ ...s.device('new'), account: s.email, words: other, new_password: OTHER }), 'wrong-recovery')
  await refused(A.resetPassword({ ...s.device('new'), account: `nobody-${s.email}`, words: kit.words, new_password: OTHER }), 'wrong-recovery')
  const before = s.fake.requests.length
  await refused(A.resetPassword({ ...s.device('new'), account: s.email, words: secretText(kit.words.replace(/^\w+/, 'acorm')), new_password: OTHER }), 'bad-recovery-words')
  await refused(A.resetPassword({ ...s.device('new'), account: s.email, words: kit.words, new_password: secretText('short') }), 'weak-password')
  assert.equal(s.fake.requests.length, before, 'neither reached the hub')
  assert.equal(s.last('joinWithCode'), undefined)
  // the hub hands out the password's copy for the kit's key: it does not open as the kit's
  s.fake.faults.add({ method: 'POST', path: '/v1/account/recover', answer: json => ({ ...json, rooms: json.rooms.map(r => ({ ...r, sealed_copy: accountAt(s).password_copy })) }) })
  await refused(A.resetPassword({ ...s.device('new'), account: s.email, words: kit.words, new_password: OTHER }), 'wrong-recovery')
})

test('forgot password on an account without a password (a lost passkey): the recovery sets the password; the passkey is gone', { skip }, async t => {
  const s = await scene(t)
  const { kit: old_kit, passkey, code, room } = await withPasskey(s)
  const { client, kit } = await A.resetPassword({ ...s.device('new'), account: s.email, words: old_kit.words, new_password: OTHER })
  secretText(kit.words)
  const join = s.last('joinWithCode')
  secretBytes(unhex(join.new_code))
  assert.deepEqual([join.room_id, join.code, join.recover], [hex(room), code, true])
  assert.deepEqual(Object.keys(join.account).sort(), ['kit', 'password'])
  assert.ok(zeroed(join.held.code))
  assert.equal(await opensWith(s, { password: OTHER }), join.new_code)
  assert.equal(await opensWith(s, { words: kit.words }), join.new_code)
  await refused(opensWith(s, { words: old_kit.words }), 'wrong-recovery')
  await refused(opensWith(s, { passkey }), 'wrong-login')
  assert.deepEqual((await A.accountStatus(client)).passkeys, [])
})

test('the kit, then a new passkey: the device signs in, the passkey is added, the code is replaced; a new kit comes back', { skip }, async t => {
  const s = await scene(t)
  const { kit: old_kit, code, room } = await withPassword(s)
  const { client } = await A.recoverWithKit({ ...s.device('new'), account: s.email, words: old_kit.words })
  assert.deepEqual([s.last('joinWithCode').code, s.last('joinWithCode').recover], [code, false])
  // (auth.mjs newWayFlow: the account as it is, a passkey over the account's challenge, then addPasskey with the words)
  const { passkey, added } = await addPasskey(client, { words: old_kit.words })
  secretText(added.kit.words)
  const replaced = s.last('replaceRecoveryCode')
  secretBytes(unhex(replaced.new_code))
  assert.equal(added.credential_id, b64u(passkey.credential_id))
  assert.deepEqual(Object.keys(replaced.account).sort(), ['kit', 'passkey'])
  assert.deepEqual(replaced.account.passkey.credential_id, passkey.credential_id)
  assert.equal(await opensWith(s, { passkey }), replaced.new_code)
  assert.equal(await opensWith(s, { words: added.kit.words }), replaced.new_code)
  await refused(opensWith(s, { password: PASSWORD }), 'wrong-login')
  await refused(opensWith(s, { words: old_kit.words }), 'wrong-recovery')
  const st = await A.accountStatus(client)
  assert.deepEqual([st.has_password, st.passkeys.map(p => p.credential_id)], [false, [b64u(passkey.credential_id)]])
  assert.deepEqual(client.room_id, room)
})

test('the kit, then a new passkey, and the code cannot be replaced: the passkey is taken back, the kit\'s words still open the account', { skip }, async t => {
  const s = await scene(t)
  const { kit, code } = await withPassword(s)
  const { client } = await A.recoverWithKit({ ...s.device('new'), account: s.email, words: kit.words })
  stage.core_missing = true
  const passkey = passkeyFor(await A.passkeyChallengeFor(client))
  const undone = await refused(A.addPasskey(client, { unlock: { words: kit.words }, passkey: { ...passkey, prf: passkey.prf.slice() } }), 'core-missing')
  assert.equal(undone.passkey_kept, undefined)
  assert.deepEqual((await A.accountStatus(client)).passkeys, [])
  assert.equal(await opensWith(s, { words: kit.words }), code)
  assert.equal(await opensWith(s, { password: PASSWORD }), code)
  // the passkey could not be taken back (the hub is not reached): the error says that it may be a way in
  s.fake.faults.add({ method: 'DELETE', path: /^\/v1\/account\/passkeys\//, drop: 'before', times: 5 })
  const again = passkeyFor(await A.passkeyChallengeFor(client))
  const kept = await refused(A.addPasskey(client, { unlock: { words: kit.words }, passkey: { ...again, prf: again.prf.slice() } }), 'core-missing')
  assert.equal(kept.passkey_kept, true)
  assert.equal((await A.accountStatus(client)).passkeys.length, 1)
  s.fake.faults.clear()
  // a password set the same way stays set when the replacement fails: it is a way in that works, and the kit is as it was
  await refused(A.setPassword(client, { unlock: { words: kit.words }, next: OTHER }), 'core-missing')
  assert.equal(await opensWith(s, { password: OTHER }), code)
  assert.equal(await opensWith(s, { words: kit.words }), code)
})

test('the kit, then a new password instead (setPassword with the words): the same, under the password', { skip }, async t => {
  const s = await scene(t)
  const { client: first, kit: old_kit } = await withPassword(s)
  const { passkey } = await addPasskey(first, { password: PASSWORD })
  const { client } = await A.recoverWithKit({ ...s.device('new'), account: s.email, words: old_kit.words })
  const { kit } = await A.setPassword(client, { unlock: { words: old_kit.words }, next: OTHER })
  secretText(kit.words)
  const new_code = s.last('replaceRecoveryCode').new_code
  secretBytes(unhex(new_code))
  assert.equal(await opensWith(s, { password: OTHER }), new_code)
  assert.equal(await opensWith(s, { words: kit.words }), new_code)
  await refused(opensWith(s, { password: PASSWORD }), 'wrong-login')
  await refused(opensWith(s, { passkey }), 'wrong-login')
  await refused(opensWith(s, { words: old_kit.words }), 'wrong-recovery')
})

test('the bare code, a room without an account: the new code is told before the recovery is posted, and comes back', { skip }, async t => {
  const s = await scene(t)
  // a room founded without an account (room.ts foundRoom alone), whose code the person holds
  const { foundRoom } = await import('./room-fake.mjs')
  const founded = await foundRoom({ ...s.device() })
  const code = s.last('foundRoom').code, room_id = hex(founded.client.room_id)
  secretBytes(unhex(code))
  const typed = secretText(core.formatRecoveryCode(unhex(code)))
  const posted = () => s.fake.requests.filter(x => /\/recovery\/[^/]+\/(commits|finish)$/.test(x.path)).length
  const seen = []
  const r = await A.recoverWithCode({ ...s.device('new'), room_id, code: typed.toLowerCase(), on_recovery_code: async shown => { await new Promise(done => setTimeout(done, 20)); seen.push([shown, posted()]) } })
  secretText(r.recovery_code)
  const call = s.last('joinWithCode')
  assert.deepEqual(seen, [[r.recovery_code, 0]], 'shown, and waited for, before a part of the recovery was posted')
  assert.deepEqual([call.room_id, call.code, call.recover, call.account, call.posted_before_copies], [room_id, code, true, null, 0])
  assert.equal(hex(core.parseRecoveryCode(r.recovery_code)), call.new_code)
  assert.deepEqual(Object.keys(r).sort(), ['client', 'recovery_code'])
  assert.equal(s.fake.requests.find(x => /\/finish$/.test(x.path)).body.account, null)
  assert.equal(await A.accountStatus(r.client), null)
  // 8.7: the device that founded the room is out
  assert.deepEqual([...s.fake.state.rooms.get(b64u(founded.client.room_id)).devices.keys()], [b64u(r.client.device)])
  // the old code opens nothing now; the new one does
  await refused(A.recoverWithCode({ ...s.device('again'), room_id, code: typed, on_recovery_code: () => {} }), 'wrong-recovery')
  await A.recoverWithCode({ ...s.device('third'), room_id, code: r.recovery_code, on_recovery_code: () => {} }).then(x => secretText(x.recovery_code))
})

test('the bare code: the new code that cannot be shown is not made the way back; a text that is no code; another room\'s code', { skip }, async t => {
  const s = await scene(t)
  const { foundRoom } = await import('./room-fake.mjs')
  const founded = await foundRoom({ ...s.device() })
  const code = s.last('foundRoom').code, room_id = hex(founded.client.room_id), typed = secretText(core.formatRecoveryCode(unhex(code)))
  secretBytes(unhex(code))
  const before = s.fake.requests.length
  await refused(A.recoverWithCode({ ...s.device('new'), room_id, code: 'TRMI-4K7Q-9XWD', on_recovery_code: () => {} }), 'bad-recovery-code')
  await refused(A.recoverWithCode({ ...s.device('new'), room_id: room_id.slice(2), code: typed, on_recovery_code: () => {} }), 'bad-argument')
  await refused(A.recoverWithCode({ ...s.device('new'), room_id, code: typed }), 'bad-argument')
  assert.equal(s.fake.requests.length, before)
  await refused(A.recoverWithCode({ ...s.device('new'), room_id, code: secretText(core.formatRecoveryCode(core.generateRecoveryCode())), on_recovery_code: () => {} }), 'wrong-recovery')
  // the screen could not show it: no part of the recovery is posted, and the old code is still the room's
  await refused(A.recoverWithCode({ ...s.device('new'), room_id, code: typed, on_recovery_code: () => { throw Object.assign(new Error('the page is gone'), { code: 'worker-failed' }) } }), 'worker-failed')
  assert.equal(s.fake.requests.filter(x => /\/recovery\/[^/]+\/(commits|finish)$/.test(x.path)).length, 0)
  await founded.client.checkRecoveryCode(unhex(code))
})

test('the bare code for a room that has an account is refused by the hub: such a room is recovered with its kit', { skip }, async t => {
  const s = await scene(t)
  const { code, room, kit } = await withPassword(s)
  const shown = []
  await refused(A.recoverWithCode({ ...s.device('new'), room_id: hex(room), code: core.formatRecoveryCode(unhex(code)), on_recovery_code: c => { shown.push(secretText(c)) } }), 'incomplete')
  assert.equal(shown.length, 1)
  assert.equal(await opensWith(s, { password: PASSWORD }), code)
  assert.equal(await opensWith(s, { words: kit.words }), code)
})

// ---------------------------------------------------------------------------------------------------------------------
// Settings: a signed-in device

test('the account as the screens see it: no sealed copy, no key, ids as base64url', { skip }, async t => {
  const s = await scene(t)
  const { client } = await withPassword(s)
  const { passkey } = await addPasskey(client, { password: PASSWORD })
  const st = await A.accountStatus(client)
  assert.deepEqual(Object.keys(st).sort(), ['account', 'email', 'has_password', 'has_recovery', 'kit_form', 'passkeys', 'revision', 'user_handle'])
  assert.deepEqual([st.account, st.kit_form], [accountAt(s).account, 'email'])
  assert.deepEqual([st.email, st.has_password, st.has_recovery, st.revision], [s.email, true, true, 2])
  assert.equal(hex(unb64u(st.user_handle)), st.account.replaceAll('-', ''), 'the user handle of its passkeys is the id')
  assert.deepEqual(Object.keys(st.passkeys[0]).sort(), ['created_at', 'credential_id', 'last_used_at', 'transports'])
  assert.equal(st.passkeys[0].credential_id, b64u(passkey.credential_id))
  // it crosses to the page's thread as it is
  assert.deepEqual(structuredClone(st), st)
  assert.ok(!/sealed|copy|auth_key|kdf/.test(JSON.stringify(st)))
})

test('change password: the old one stops working, the new one opens the same code; a wrong current one changes nothing', { skip }, async t => {
  const s = await scene(t)
  const { client, kit, code } = await withPassword(s)
  await refused(A.changePassword(client, { current: secretText('not my password at all'), next: OTHER }), 'wrong-login')
  await refused(A.changePassword(client, { current: PASSWORD, next: secretText('short') }), 'weak-password')
  assert.equal(s.posts('/v1/account/password', 'PUT').length, 0)
  assert.deepEqual(await A.changePassword(client, { current: PASSWORD, next: OTHER }), { kit: null })
  const put = s.posts('/v1/account/password', 'PUT')[0].body
  assert.deepEqual([Object.keys(put).sort(), put.revision], [['auth_key', 'kdf', 'revision', 'sealed_copy'], 1])
  assert.equal(await opensWith(s, { password: OTHER }), code)
  await refused(opensWith(s, { password: PASSWORD }), 'wrong-login')
  assert.equal(await opensWith(s, { words: kit.words }), code, 'the kit is untouched')
  assert.equal(s.last('replaceRecoveryCode'), undefined, 'and so is the code')
  assert.equal((await A.accountStatus(client)).revision, 2)
})

test('add a passkey (password given again), log in with it, remove it', { skip }, async t => {
  const s = await scene(t)
  const { client, code } = await withPassword(s)
  await refused(A.checkUnlock(client, { password: secretText('a wrong password, long enough') }), 'wrong-login')
  await A.checkUnlock(client, { password: PASSWORD })
  const { passkey, added } = await addPasskey(client, { password: PASSWORD })
  assert.deepEqual(added, { credential_id: b64u(passkey.credential_id), kit: null })
  assert.equal(await opensWith(s, { passkey }), code)
  // the passkey itself is a way in given again: for a second one, and for a password
  const second = await addPasskey(client, unlockWith(passkey))
  assert.equal(await opensWith(s, { passkey: second.passkey }), code)
  assert.equal((await A.accountStatus(client)).passkeys.length, 2)
  await A.removePasskey(client, added.credential_id)
  await refused(opensWith(s, { passkey }), 'wrong-login')
  assert.deepEqual((await A.accountStatus(client)).passkeys.map(p => p.credential_id), [b64u(second.passkey.credential_id)])
  await refused(A.removePasskey(client, added.credential_id), 'not-found')
})

test('add a passkey: a wrong way in adds none; a passkey that is not the account\'s; one without a prf output', { skip }, async t => {
  const s = await scene(t)
  const { client } = await withPassword(s)
  const posts = () => s.posts('/v1/account/passkeys').length
  const fresh = async () => passkeyFor(await A.passkeyChallengeFor(client))
  await refused(A.addPasskey(client, { unlock: { password: secretText('wrong wrong wrong wrong') }, passkey: await fresh() }), 'wrong-login')
  await refused(A.addPasskey(client, { unlock: unlockWith(passkeyFor('x')), passkey: await fresh() }), 'wrong-login')
  await refused(A.addPasskey(client, { unlock: { password: PASSWORD }, passkey: { ...await fresh(), prf: new Uint8Array(5) } }), 'no-prf')
  assert.equal(posts(), 0)
  // a registration whose id is not the one its copy was sealed for is taken back
  const odd = await fresh()
  await refused(A.addPasskey(client, { unlock: { password: PASSWORD }, passkey: { ...odd, credential_id: bytes(16) } }), 'bad-passkey')
  assert.deepEqual((await A.accountStatus(client)).passkeys, [])
  // a challenge used twice
  const once = await fresh()
  await A.addPasskey(client, { unlock: { password: PASSWORD }, passkey: { ...once, prf: once.prf.slice() } })
  await refused(A.addPasskey(client, { unlock: { password: PASSWORD }, passkey: { ...once, prf: once.prf.slice() } }), 'bad-passkey')
})

test('last-way-in: the only passkey of an account without a password stays; with a password or a second passkey it goes', { skip }, async t => {
  const s = await scene(t)
  const { client, passkey } = await withPasskey(s)
  const id = b64u(passkey.credential_id)
  const e = await refused(A.removePasskey(client, id), 'last-way-in')
  assert.equal(e.status, 409)
  assert.equal((await A.accountStatus(client)).passkeys.length, 1)
  // "Add a password" with the passkey, then the passkey may go
  await refused(A.checkUnlock(client, { password: PASSWORD }), 'no-password')
  assert.deepEqual(await A.setPassword(client, { unlock: unlockWith(passkey), next: PASSWORD }), { kit: null })
  assert.equal((await A.accountStatus(client)).has_password, true)
  await A.removePasskey(client, id)
  assert.equal(await opensWith(s, { password: PASSWORD }), s.last('foundRoom').code)
})

test('last-way-in is the hub\'s to decide: two removals at once leave one passkey', { skip }, async t => {
  const s = await scene(t)
  const { client, passkey } = await withPasskey(s)
  const second = await addPasskey(client, unlockWith(passkey))
  const done = await Promise.allSettled([A.removePasskey(client, b64u(passkey.credential_id)), A.removePasskey(client, b64u(second.passkey.credential_id))])
  assert.deepEqual(done.map(d => d.status).sort(), ['fulfilled', 'rejected'])
  const lost = done.find(d => d.status === 'rejected').reason
  thrown.push(lost)
  assert.equal(lost.code, 'last-way-in')
  assert.equal((await A.accountStatus(client)).passkeys.length, 1)
})

test('a new Emergency Kit: new words for the same code; the old words open nothing', { skip }, async t => {
  const s = await scene(t)
  const { client, kit: old_kit, code } = await withPassword(s)
  await refused(A.makeEmergencyKit(client, { password: secretText('surely not the password') }), 'wrong-login')
  const kit = await A.makeEmergencyKit(client, { password: PASSWORD })
  secretText(kit.words)
  assert.deepEqual([Object.keys(kit).sort(), kit.email, kit.account, kit.form], [['account', 'email', 'form', 'words'], s.email, accountAt(s).account, 'email'])
  assert.notEqual(kit.words, old_kit.words)
  assert.equal(await opensWith(s, { words: kit.words }), code)
  await refused(opensWith(s, { words: old_kit.words }), 'wrong-recovery')
  assert.equal(await opensWith(s, { password: PASSWORD }), code)
  // the kit's words are a way in given again too (the kit's own copy, read with the account)
  await A.checkUnlock(client, { words: kit.words })
  await refused(A.checkUnlock(client, { words: old_kit.words }), 'wrong-recovery')
})

test('account-changed: a change from another device between reading the account and writing it', { skip }, async t => {
  const s = await scene(t)
  const { client, kit, code } = await withPassword(s)
  const other = (await A.loginWithPassword({ ...s.device('phone'), account: s.email, password: PASSWORD })).client
  // both devices, signed in, read revision 1 at once; the first write wins, the second is told
  await A.accountStatus(other)
  const done = await Promise.allSettled([A.makeEmergencyKit(client, { password: PASSWORD }), A.changePassword(other, { current: PASSWORD, next: OTHER })])
  assert.deepEqual(done.map(d => d.status).sort(), ['fulfilled', 'rejected'])
  const lost = done.find(d => d.status === 'rejected').reason
  thrown.push(lost)
  assert.deepEqual([lost.code, lost.status], ['account-changed', 409])
  if (done[0].status === 'fulfilled') secretText(done[0].value.words)
  // nothing is half written: whichever lost changed nothing, and tried again it goes through
  const password = done[1].status === 'fulfilled' ? OTHER : PASSWORD
  assert.equal(await opensWith(s, { password }), code)
  if (done[0].status === 'rejected') assert.equal(await opensWith(s, { words: kit.words }), code)
  secretText((await A.makeEmergencyKit(client, { password })).words)
  // a hub that hands out an old revision: the write is refused, not applied
  s.fake.faults.add({ method: 'GET', path: '/v1/account', answer: json => ({ ...json, revision: json.revision - 1 }) })
  await refused(A.changePassword(client, { current: password, next: secretText('yet another long password') }), 'account-changed')
  assert.equal(await opensWith(s, { password }), code)
})

test('a hostile hub in Settings: a cheaper key derivation is bad-kdf and nothing is derived; a swapped copy does not open', { skip }, async t => {
  const s = await scene(t)
  const { client } = await withPassword(s)
  const view = answer => s.fake.faults.add({ method: 'GET', path: '/v1/account', answer })
  view(json => ({ ...json, kdf: { alg: 'argon2id', v: 1, m: 8, t: 1, p: 1 } }))
  const started = performance.now()
  await refused(A.checkUnlock(client, { password: PASSWORD }), 'bad-kdf')
  assert.ok(performance.now() - started < 100, 'refused before the slow step')
  view(json => ({ ...json, password_copy: json.kit_copy }))
  await refused(A.checkUnlock(client, { password: PASSWORD }), 'wrong-login')
  view(json => ({ ...json, kit_copy: json.password_copy }))
  await refused(A.makeEmergencyKit(client, { words: [...secrets.texts].findLast(x => x.split(' ').length === 12) }), 'wrong-recovery')
  assert.equal(s.posts('/v1/account/kit', 'PUT').length, 0)
})

test('a hub that hands out an OLD sealed copy: the code it opens is not the room\'s now, and nothing is sealed anew with it', { skip }, async t => {
  const s = await scene(t)
  const { client, kit: old_kit, code } = await withPassword(s)
  const old = structuredClone(accountAt(s))
  const kit = await A.replaceRecoveryCode(client, { password: PASSWORD })
  secretText(kit.words)
  const new_code = s.last('replaceRecoveryCode').new_code
  secretBytes(unhex(new_code))
  // the account as it is now, but with the copies of before the replacement: authentic, and obsolete
  const stale = () => s.fake.faults.add({ method: 'GET', path: '/v1/account', answer: json => ({ ...json, password_copy: old.password_copy, kit_copy: old.kit_copy }) })
  const writes = () => s.fake.requests.filter(r => r.method !== 'GET' && /^\/v1\/account/.test(r.path) && !/challenge$/.test(r.path)).length
  const before = writes()
  stale(); await refused(A.changePassword(client, { current: PASSWORD, next: OTHER }), 'wrong-recovery')
  stale(); await refused(A.makeEmergencyKit(client, { password: PASSWORD }), 'wrong-recovery')
  stale(); await refused(A.setPassword(client, { unlock: { words: old_kit.words }, next: OTHER }), 'wrong-recovery')
  const fresh = passkeyFor(await A.passkeyChallengeFor(client))
  stale(); await refused(A.addPasskey(client, { unlock: { password: PASSWORD }, passkey: fresh }), 'wrong-recovery')
  stale(); await refused(A.checkUnlock(client, { password: PASSWORD }), 'wrong-recovery')
  assert.equal(writes(), before, 'no write of the account followed')
  assert.equal(await opensWith(s, { password: PASSWORD }), new_code)
  assert.notEqual(new_code, code)
})

test('the code is not replaced over an account that changed meanwhile (a password changed on another device)', { skip }, async t => {
  const s = await scene(t)
  const { client, kit, code } = await withPassword(s)
  const other = (await A.loginWithPassword({ ...s.device('phone'), account: s.email, password: PASSWORD })).client
  // this device reads the account and opens the code; before it replaces the code, the other one changes the
  // password. (Staged: the change is made first, and this device's first read is answered as it was before it.)
  const was = structuredClone(accountAt(s))
  await A.changePassword(other, { current: PASSWORD, next: OTHER })
  s.fake.faults.add({ method: 'GET', path: '/v1/account', answer: json => ({ ...json, revision: was.revision, password_copy: was.password_copy }) })
  const replacing = A.replaceRecoveryCode(client, { password: PASSWORD })
  const e = await refused(replacing, 'account-changed')
  assert.equal(e.name, 'AccountError')
  assert.equal(s.last('replaceRecoveryCode'), undefined, 'the replacement was never asked for')
  // the account is whole: the other device's new password and the kit open the code
  assert.equal(await opensWith(s, { password: OTHER }), code)
  assert.equal(await opensWith(s, { words: kit.words }), code)
})

test('a room without an account: the status is null, the ways in are no-account, and a login is added with the code', { skip }, async t => {
  const s = await scene(t)
  const { foundRoom } = await import('./room-fake.mjs')
  const { client } = await foundRoom({ ...s.device() })
  const code = s.last('foundRoom').code
  secretBytes(unhex(code))
  assert.equal(await A.accountStatus(client), null)
  await refused(A.checkUnlock(client, { password: PASSWORD }), 'no-account')
  await refused(A.makeEmergencyKit(client, { password: PASSWORD }), 'no-account')
  await refused(A.addAccount(client, { email: s.email, password: PASSWORD, recovery_code: 'not a code' }), 'bad-recovery-code')
  // a well-formed code that is not this room's would make an account whose copies open nothing here
  await refused(A.addAccount(client, { email: s.email, password: PASSWORD, recovery_code: secretText(core.formatRecoveryCode(core.generateRecoveryCode())) }), 'bad-recovery-code')
  assert.equal(s.posts('/v1/account').length, 0)
  await refused(A.addAccount(client, { email: s.email, password: secretText('short'), recovery_code: core.formatRecoveryCode(unhex(code)) }), 'weak-password')
  const { kit } = await A.addAccount(client, { email: ` ${s.email.toUpperCase()} `, password: PASSWORD, recovery_code: secretText(core.formatRecoveryCode(unhex(code))).toLowerCase() })
  secretText(kit.words)
  assert.equal(kit.email, s.email)
  assert.equal(await opensWith(s, { password: PASSWORD }), code)
  assert.equal(await opensWith(s, { words: kit.words }), code)
  await refused(A.addAccount(client, { email: `b-${s.email}`, password: PASSWORD, recovery_code: core.formatRecoveryCode(unhex(code)) }), 'account-exists')
})

test('replace the recovery code from Settings (8.6): the way in given again keeps its copy, a new kit, the rest removed', { skip }, async t => {
  const s = await scene(t)
  const { client, kit: old_kit, code } = await withPassword(s)
  const { passkey } = await addPasskey(client, { password: PASSWORD })
  await refused(A.replaceRecoveryCode(client, { words: old_kit.words }), 'bad-argument')
  await refused(A.replaceRecoveryCode(client, { password: secretText('this is not the password') }), 'wrong-login')
  assert.equal(s.last('replaceRecoveryCode'), undefined)
  const kit = await A.replaceRecoveryCode(client, { password: PASSWORD })
  secretText(kit.words)
  const new_code = s.last('replaceRecoveryCode').new_code
  secretBytes(unhex(new_code))
  assert.notEqual(new_code, code)
  assert.equal(await opensWith(s, { password: PASSWORD }), new_code)
  assert.equal(await opensWith(s, { words: kit.words }), new_code)
  await refused(opensWith(s, { words: old_kit.words }), 'wrong-recovery')
  await refused(opensWith(s, { passkey }), 'wrong-login')
  // with a passkey as the way in: the password goes
  const again = await addPasskey(client, { password: PASSWORD })
  const next = await A.replaceRecoveryCode(client, unlockWith(again.passkey))
  secretText(next.words)
  secretBytes(unhex(s.last('replaceRecoveryCode').new_code))
  assert.equal(await opensWith(s, { passkey: again.passkey }), s.last('replaceRecoveryCode').new_code)
  assert.equal((await A.accountStatus(client)).has_password, false)
})

// ---------------------------------------------------------------------------------------------------------------------
// An account without an e-mail. Its kit is made under the account's id (the core's `kitKeysFor`).

/** An account made with a passkey and no e-mail: { client, kit, passkey, named, code, room }. */
async function withoutEmail(s) {
  const named = await challenge(s), passkey = passkeyFor(named.challenge)
  secretBytes(passkey.prf)
  const made = await A.createAccountWithPasskey({ ...s.device(), account: named.account, passkey: { ...passkey, prf: passkey.prf.slice() } })
  secretText(made.kit.words)
  const call = s.last('foundRoom')
  secretBytes(unhex(call.code))
  return { ...made, passkey, named, code: call.code, room: unhex(call.room_id) }
}
/** The code the kit's copy holds for an account named by its id, through the hub's recover route. */
async function opensById(s, account, words) {
  const keys = core.kitKeysFor({ id: core.accountIdParse(account) }, words), room = (await s.outside().recover(account, keys.authKey)).rooms[0]
  return hex(core.openRecoveryCode(keys.wrapKey, room.room_id, 'kit', null, room.sealed_copy))
}

test('create account with a passkey and NO e-mail: no e-mail is sent, the kit is made under the id the challenge named', { skip }, async t => {
  const s = await scene(t)
  const { client, kit, passkey, named, code } = await withoutEmail(s)
  const body = s.posts('/v1/rooms')[0].body.account
  assert.deepEqual([Object.keys(body).sort(), Object.keys(body.kit).sort()], [['kit', 'passkey'], ['auth_key', 'sealed_copy']])
  assert.deepEqual(kit, { words: kit.words, email: null, account: named.account, form: 'id' })
  const st = await A.accountStatus(client)
  assert.deepEqual([st.email, st.account, st.kit_form, st.has_password, st.user_handle, st.passkeys.length], [null, named.account, 'id', false, b64u(named.user_handle), 1])
  assert.equal(await opensWith(s, { passkey }), code)
  assert.equal(await opensById(s, named.account, kit.words), code)
  // an empty or blank e-mail is no e-mail
  for (const email of ['', '   ', null]) {
    const again = await scene(t)
    const n = await challenge(again), p = passkeyFor(n.challenge)
    const made = await A.createAccountWithPasskey({ ...again.device(), email, account: n.account, passkey: p })
    secretText(made.kit.words)
    assert.deepEqual([made.kit.email, made.kit.form, Object.keys(again.posts('/v1/rooms')[0].body.account).sort()], [null, 'id', ['kit', 'passkey']])
  }
})

test('the kit of an account without e-mail: the id as typed opens it, the device signs in, a new passkey and a new kit follow', { skip }, async t => {
  const s = await scene(t)
  const { kit, named, code, room, passkey: lost } = await withoutEmail(s)
  // a new password is no way for it, said before the device joins
  await refused(A.resetPassword({ ...s.device('new'), account: named.account, words: kit.words, new_password: OTHER }), 'needs-email')
  assert.equal(s.last('joinWithCode'), undefined)
  await refused(A.recoverWithKit({ ...s.device('new'), account: named.account, words: secretText(core.generateKitWords()) }), 'wrong-recovery')
  await refused(A.recoverWithKit({ ...s.device('new'), account: 'not an id', words: kit.words }), 'bad-account')
  const typed = ` ${named.account.toUpperCase().replaceAll('-', ' ')} `
  const { client } = await A.recoverWithKit({ ...s.device('new'), account: typed, words: kit.words })
  assert.deepEqual([s.last('joinWithCode').room_id, s.last('joinWithCode').code], [hex(room), code])
  assert.equal(s.posts('/v1/account/recover').at(-1).body.account, named.account, 'the hub is asked with the id in its one form')
  await refused(A.setPassword(client, { unlock: { words: kit.words }, next: OTHER }), 'needs-email')
  const { passkey, added } = await addPasskey(client, { words: kit.words })
  secretText(added.kit.words)
  const new_code = s.last('replaceRecoveryCode').new_code
  secretBytes(unhex(new_code))
  assert.deepEqual([added.kit.form, added.kit.email, added.kit.account, [...s.fake.state.accounts.values()].find(a => a.account === named.account).kit_form], ['id', null, named.account, 'id'])
  assert.equal(await opensWith(s, { passkey }), new_code)
  assert.equal(await opensById(s, named.account, added.kit.words), new_code)
  await refused(opensById(s, named.account, kit.words), 'wrong-recovery')
  await refused(opensWith(s, { passkey: lost }), 'wrong-login')
})

test('an e-mail added later: once, with the SAME words sealed anew under the e-mail in one request; then a password is possible', { skip }, async t => {
  const s = await scene(t)
  const { client, kit, passkey, named, code } = await withoutEmail(s)
  await refused(A.setPassword(client, { unlock: unlockWith(passkey), next: PASSWORD }), 'needs-email')
  await refused(A.setEmail(client, { email: 'no address', words: kit.words }), 'bad-email')
  await refused(A.setEmail(client, { email: s.email, words: secretText(core.generateKitWords()) }), 'wrong-recovery')
  assert.equal(s.posts('/v1/account/email', 'PUT').length, 0, 'words that are not the kit\'s set nothing')
  const again = await A.setEmail(client, { email: ` ${s.email.toUpperCase()} `, words: kit.words.toUpperCase().replaceAll(' ', '\n') })
  assert.deepEqual(again, { words: kit.words, email: s.email, account: named.account, form: 'email' }, 'the same words; the sheet opens with the e-mail from now on')
  const put = s.posts('/v1/account/email', 'PUT').at(-1).body
  assert.deepEqual([Object.keys(put).sort(), put.email, put.revision, Object.keys(put.kit).sort()], [['email', 'kit', 'revision'], s.email, 1, ['auth_key', 'sealed_copy']])
  const st = await A.accountStatus(client)
  assert.deepEqual([st.email, st.kit_form, st.account], [s.email, 'email', named.account])
  // the same words now open under the e-mail, on the device and from outside; under the id they open nothing
  await A.checkUnlock(client, { words: kit.words })
  assert.equal(await opensWith(s, { words: kit.words }), code)
  await refused(opensById(s, named.account, kit.words), 'wrong-recovery')
  await A.recoverWithKit({ ...s.device('x'), account: s.email, words: kit.words })
  const e = await refused(A.setEmail(client, { email: `other-${s.email}`, words: kit.words }), 'email-set')
  assert.equal(s.posts('/v1/account/email', 'PUT').length, 1)
  void e
  assert.deepEqual(await A.setPassword(client, { unlock: unlockWith(passkey), next: PASSWORD }), { kit: null })
  assert.equal(await opensWith(s, { password: PASSWORD }), code)
  // a second account cannot take that address
  const second = await withoutEmail({ ...s, device: () => s.device('second') })
  await refused(A.setEmail(second.client, { email: s.email, words: second.kit.words }), 'account-exists')
  assert.equal((await A.accountStatus(second.client)).email, null)
})

test('an e-mail account\'s kit opens with its e-mail, not with its id (the sheet says which): the id typed is wrong-recovery', { skip }, async t => {
  const s = await scene(t)
  const { kit } = await withPassword(s)
  await refused(A.recoverWithKit({ ...s.device('new'), account: kit.account, words: kit.words }), 'wrong-recovery')
  assert.equal(s.last('joinWithCode'), undefined)
  await A.recoverWithKit({ ...s.device('new'), account: s.email, words: kit.words })
})

test('a hostile hub and the account\'s id: an answer for another account, a challenge that names another account', { skip }, async t => {
  const s = await scene(t)
  const { client, kit, passkey, named } = await withoutEmail(s)
  const other = '0f8fad5b-d9cb-469f-a165-70867728950e'
  // the kit's way back, answered as another account
  s.fake.faults.add({ method: 'POST', path: '/v1/account/recover', answer: json => ({ ...json, account: other }) })
  await refused(A.recoverWithKit({ ...s.device('a'), account: named.account, words: kit.words }), 'wrong-recovery')
  // a usernameless login: the passkey's own user handle is the account's id; an answer for another account is none
  const assertion = () => challenge(s).then(c => ({ ...assertionOf(passkey, c.challenge), user_handle: named.user_handle.slice() }))
  s.fake.faults.add({ method: 'POST', path: '/v1/account/passkey/login', answer: json => ({ ...json, account: other }) })
  await refused(A.loginWithPasskey({ ...s.device('b'), assertion: await assertion() }), 'wrong-login')
  assert.equal(s.last('joinWithCode'), undefined, 'nothing was joined')
  await A.loginWithPasskey({ ...s.device('c'), assertion: await assertion() })
  // a challenge for a new passkey that names another account than this room's
  const consistent = { account: other, user_handle: b64u(unhex(other.replaceAll('-', ''))) }
  s.fake.faults.add({ method: 'POST', path: '/v1/account/passkeys/challenge', answer: json => ({ ...json, ...consistent }) })
  await refused(A.passkeyChallengeFor(client), 'bad-passkey')
  s.fake.faults.add({ method: 'POST', path: '/v1/account/passkeys/challenge', answer: json => ({ ...json, account: other }) })
  await refused(A.passkeyChallengeFor(client), 'bad-answer')
  // an e-mail account: the kit's way back answered with another address
  const mail = await scene(t)
  resetStage({ fake: mail.fake })
  const made = await withPassword(mail)
  mail.fake.faults.add({ method: 'POST', path: '/v1/account/recover', answer: json => ({ ...json, email: `x-${json.email}` }) })
  await refused(A.recoverWithKit({ ...mail.device('a'), account: mail.email, words: made.kit.words }), 'wrong-recovery')
})

// ---------------------------------------------------------------------------------------------------------------------

test('no secret in anything an error tells: not in a message, a field or a stack', { skip }, () => {
  assert.ok(thrown.length >= 60, `${thrown.length} errors were kept`)
  const spellings = [...secrets.texts].filter(text => text.length >= 5)
  for (const b of secrets.bytes) {
    spellings.push(hex(b), b64u(b), Buffer.from(b).toString('base64'))
    if (b.length === 32) spellings.push(core.formatRecoveryCode(b))
  }
  // any three words in a row of a kit count as the kit
  for (const text of secrets.texts) {
    const words = text.split(' ')
    if (words.length === 12) for (let i = 0; i + 3 <= 12; i++) spellings.push(words.slice(i, i + 3).join(' '))
  }
  assert.ok(spellings.length > 200)
  for (const error of thrown) {
    const said = told(error)
    for (const secret of spellings) assert.ok(!said.includes(secret), `${error.code}: an error tells a secret`)
  }
})
