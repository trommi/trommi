// app/web/core/account.ts against the REAL hub's binary: the sign-up inside a room's founding, the login routes
// with their slow hash, the sealed copies as the hub stores and hands them out, a new password, a new kit, the
// revision, and passkeys under the hub's own WebAuthn checks (a passkey in software, authenticator.mjs).
//
//   TROMMI_HUB_BIN=/path/to/trommi-hub node --test tests/web/account/real-hub.test.mjs
// Without TROMMI_HUB_BIN, or without the core's binding built, everything here is SKIPPED, and says so.
//
// What is real: the hub, the app's hub client (hub.ts), account.ts, and the core for every key, copy and code. The
// room is founded by a real `Device` of the core's binding (room-fake.mjs foundReal), with one substitution that
// tests/web/hub/real-hub.test.mjs explains: the SealedKey of the founding is one of the right form, since the hub
// refuses what the binding built in this worktree writes there.
// What is NOT reached: joining the room with the code. The fake of room.ts refuses it with `core-missing`, as the
// binding in this worktree does; a login therefore runs up to that call and the test checks the code it was handed
// (the one the room was founded with). A recovery and the replacement of the code are not run here at all.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hub } from '../../../app/web/core/hub.ts'
import { account as A, core, no_core, stage, resetStage, b64u, bytes, refused, thrown, told } from './setup.mjs'
import { softPasskey } from './authenticator.mjs'

const BIN = process.env.TROMMI_HUB_BIN
const skip = !BIN ? 'TROMMI_HUB_BIN is not set' : no_core ?? false
if (skip) console.warn(`\nSKIPPED: the account against the real hub did not run: ${skip}.\n`)
const CLIENT = 'app/2.0.0', ORIGIN = 'https://app.trommi.test'
const PASSWORD = 'correct horse battery staple 42', OTHER = 'another-long-password-for-ada'

async function startRealHub() {
  const probe = createServer()
  await new Promise(r => probe.listen(0, '127.0.0.1', r))
  const { port } = probe.address()
  await new Promise(r => probe.close(r))
  const url = `http://127.0.0.1:${port}`
  const data = await mkdtemp(join(process.env.TROMMI_HUB_TMP ?? tmpdir(), 'trommi-account-test-'))
  const env = { HUB_HOST: '127.0.0.1', HUB_PORT: String(port), HUB_URL: url, HUB_DATA: data, HUB_QUIET: '1', HUB_LOGIN_THROTTLE: 'off', HUB_MIN_CLIENT: CLIENT, HUB_ORIGINS: ORIGIN, PATH: process.env.PATH ?? '' }
  const child = spawn(BIN, [], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', d => { stderr += d })
  const exited = new Promise(resolve => child.once('exit', resolve))
  for (let i = 0; ; i++) {
    if (await fetch(`${url}/healthz`).then(r => r.ok, () => false)) break
    if (child.exitCode !== null || i > 200) throw new Error(`the hub did not start: ${stderr.slice(0, 500)}`)
    await new Promise(r => setTimeout(r, 50))
  }
  return { url, async close() { child.kill('SIGTERM'); const killer = setTimeout(() => child.kill('SIGKILL'), 1000); await exited; clearTimeout(killer); await rm(data, { recursive: true, force: true }) } }
}

test('the account against the real hub', { skip }, async t => {
  const real = await startRealHub()
  t.after(() => real.close())
  const { binding } = await import('./core-node.mjs')
  const { MemoryStore } = await import('../../bindings/stores.mjs')
  resetStage({ real: { binding, MemoryStore } })
  t.after(async () => { for (const client of stage.stores.values()) await client.stop() })
  let n = 0
  const device = (name, more = {}) => ({ hub_url: real.url, storage: { name: `real-${name}` }, client: CLIENT, device_name: name, ...more })
  const outside = () => new Hub({ hub_url: real.url, client_name: CLIENT })
  const email = () => `ada-${Date.now()}-${++n}@example.com`
  const last = fn => stage.calls.findLast(c => c.fn === fn)
  /** A login runs up to the join, which this worktree's binding does not have: the code it was handed is the proof. */
  const reaches = async (login, code) => {
    const before = stage.calls.length
    await refused(login, 'core-missing')
    const call = stage.calls[before]
    assert.deepEqual([call.fn, call.code, call.recover], ['joinWithCode', code, false])
    assert.ok(call.held.code.every(x => x === 0))
  }

  await t.test('create account (password): room and account in one founding; the status; an e-mail twice is account-exists', async () => {
    const mail = email()
    const { client, kit } = await A.createAccount({ ...device('a1'), email: mail.toUpperCase(), password: PASSWORD })
    assert.deepEqual([kit.email, kit.form], [mail, 'email'])
    assert.match(kit.account, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'the id the hub minted, read once the device was in')
    const st = await A.accountStatus(client)
    assert.deepEqual([st.email, st.account, st.kit_form, st.revision, st.has_password, st.has_recovery, st.passkeys], [mail, kit.account, 'email', 1, true, true, []])
    const e = await refused(A.createAccount({ ...device('a2'), email: mail, password: OTHER }), 'account-exists')
    assert.equal(e.status, 409)
    assert.ok(!stage.stores.has('real-a2'))
    t.account = { client, kit, mail, code: stage.calls.find(c => c.fn === 'foundRoom').code }
  })
  const { client, mail, code } = t.account

  await t.test('log in with the password and with the kit\'s words: the hub hands out the copy, it opens to the room\'s code', async () => {
    await reaches(A.loginWithPassword({ ...device('b1'), account: mail, password: PASSWORD }), code)
    await reaches(A.recoverWithKit({ ...device('b2'), account: mail, words: t.account.kit.words }), code)
    await refused(A.loginWithPassword({ ...device('b3'), account: mail, password: 'not the right password' }), 'wrong-login')
    await refused(A.loginWithPassword({ ...device('b3'), account: email(), password: PASSWORD }), 'wrong-login')
    await refused(A.recoverWithKit({ ...device('b3'), account: mail, words: core.generateKitWords() }), 'wrong-recovery')
  })

  await t.test('the ways in given again on the signed-in device; a new password; a new kit', async () => {
    await A.checkUnlock(client, { password: PASSWORD })
    await A.checkUnlock(client, { words: t.account.kit.words })
    await refused(A.checkUnlock(client, { password: 'a wrong password, long enough' }), 'wrong-login')
    assert.deepEqual(await A.changePassword(client, { current: PASSWORD, next: OTHER }), { kit: null })
    await reaches(A.loginWithPassword({ ...device('c1'), account: mail, password: OTHER }), code)
    await refused(A.loginWithPassword({ ...device('c2'), account: mail, password: PASSWORD }), 'wrong-login')
    const kit = await A.makeEmergencyKit(client, { password: OTHER })
    await reaches(A.recoverWithKit({ ...device('c3'), account: mail, words: kit.words }), code)
    await refused(A.recoverWithKit({ ...device('c4'), account: mail, words: t.account.kit.words }), 'wrong-recovery')
    assert.equal((await A.accountStatus(client)).revision, 3)
    t.account.kit = kit
  })

  await t.test('account-changed: a write with the revision of before is refused and changes nothing', async () => {
    // this device's hub client is made to read the account as it was one revision ago
    const stale = async (input, init) => {
      const answer = await fetch(input, init)
      if (!String(input).endsWith('/v1/account') || (init?.method ?? 'GET') !== 'GET') return answer
      const json = await answer.json()
      return new Response(JSON.stringify({ ...json, revision: json.revision - 1 }), { status: answer.status, headers: { 'content-type': 'application/json' } })
    }
    const before = client.hub
    const behind = new Hub({ hub_url: real.url, client_name: CLIENT, fetch: stale })
    behind.useSigner(client.room_id, client.sign)
    client.hub = behind
    try {
      const e = await refused(A.changePassword(client, { current: OTHER, next: PASSWORD }), 'account-changed')
      assert.equal(e.status, 409)
      await refused(A.makeEmergencyKit(client, { password: OTHER }), 'account-changed')
    } finally { client.hub = before }
    await reaches(A.loginWithPassword({ ...device('d1'), account: mail, password: OTHER }), code)
    await reaches(A.recoverWithKit({ ...device('d2'), account: mail, words: t.account.kit.words }), code)
  })

  await t.test('passkeys under the hub\'s WebAuthn checks: add one, log in with it, last-way-in, remove', async () => {
    const st = await A.accountStatus(client)
    const key = softPasskey(ORIGIN)
    const added = await A.addPasskey(client, { unlock: { password: OTHER }, passkey: key.create(await A.passkeyChallengeFor(client)) })
    assert.deepEqual(added, { credential_id: b64u(key.credential_id), kit: null })
    const listed = await A.accountStatus(client)
    assert.deepEqual([listed.passkeys.map(p => p.credential_id), listed.passkeys[0].transports, listed.user_handle], [[b64u(key.credential_id)], ['internal', 'hybrid'], st.user_handle])
    await reaches(A.loginWithPasskey({ ...device('e1'), assertion: key.get(b64u((await outside().passkeyChallenge()).challenge)) }), code)
    // a challenge of another kind, a challenge used twice, a passkey the hub does not know, a wrong prf output
    const once = b64u((await outside().passkeyChallenge()).challenge)
    await reaches(A.loginWithPasskey({ ...device('e2'), assertion: key.get(once) }), code)
    await refused(A.loginWithPasskey({ ...device('e3'), assertion: key.get(once) }), 'wrong-login')
    await refused(A.loginWithPasskey({ ...device('e3'), assertion: softPasskey(ORIGIN).get(b64u((await outside().passkeyChallenge()).challenge)) }), 'wrong-login')
    await refused(A.loginWithPasskey({ ...device('e3'), assertion: { ...key.get(b64u((await outside().passkeyChallenge()).challenge)), prf: bytes(32) } }), 'wrong-login')
    await refused(A.addPasskey(client, { unlock: { password: OTHER }, passkey: softPasskey(ORIGIN).create(b64u((await outside().passkeyChallenge()).challenge)) }), 'bad-passkey')
    await refused(A.addPasskey(client, { unlock: { password: OTHER }, passkey: softPasskey('https://evil.example').create(await A.passkeyChallengeFor(client)) }), 'bad-passkey')
    // the passkey as the way in given again: a new kit with it
    t.account.kit = await A.makeEmergencyKit(client, key.unlock())
    await A.removePasskey(client, added.credential_id)
    await refused(A.loginWithPasskey({ ...device('e4'), assertion: key.get(b64u((await outside().passkeyChallenge()).challenge)) }), 'wrong-login')
    assert.deepEqual((await A.accountStatus(client)).passkeys, [])
  })

  await t.test('create account with a passkey: the registration travels in the founding; its only passkey is the last way in', async () => {
    const mail2 = email(), key = softPasskey(ORIGIN), named = await outside().passkeyChallenge(), user_handle = named.user_handle
    const made = await A.createAccountWithPasskey({ ...device('f1'), email: mail2, account: named.account, passkey: key.create(b64u(named.challenge)) })
    assert.deepEqual([made.kit.account, made.kit.form, made.kit.email], [named.account, 'email', mail2])
    const code2 = last('foundRoom').code
    const st = await A.accountStatus(made.client)
    assert.deepEqual([st.email, st.account, st.has_password, st.user_handle, st.passkeys.map(p => p.credential_id)], [mail2, named.account, false, b64u(user_handle), [b64u(key.credential_id)]], 'the account has the id its challenge named')
    await reaches(A.loginWithPasskey({ ...device('f2'), assertion: key.get(b64u((await outside().passkeyChallenge()).challenge), user_handle) }), code2)
    await refused(A.loginWithPasskey({ ...device('f3'), assertion: key.get(b64u((await outside().passkeyChallenge()).challenge), bytes(16)) }), 'wrong-login')
    await reaches(A.recoverWithKit({ ...device('f4'), account: mail2, words: made.kit.words }), code2)
    const e = await refused(A.removePasskey(made.client, b64u(key.credential_id)), 'last-way-in')
    assert.equal(e.status, 409)
    await refused(A.checkUnlock(made.client, { password: PASSWORD }), 'no-password')
    // "Add a password" with the passkey; then the passkey may go
    assert.deepEqual(await A.setPassword(made.client, { unlock: key.unlock(), next: PASSWORD }), { kit: null })
    await reaches(A.loginWithPassword({ ...device('f5'), account: mail2, password: PASSWORD }), code2)
    await A.removePasskey(made.client, b64u(key.credential_id))
    // a passkey whose registration was made for another kind of challenge makes no account, and no room
    const stray = softPasskey(ORIGIN)
    await refused(A.createAccountWithPasskey({ ...device('f6'), email: email(), account: named.account, passkey: stray.create(b64u(bytes(32))) }), 'bad-passkey')
    assert.ok(!stage.stores.has('real-f6'))
  })

  await t.test('no secret in what the errors of this run tell', () => {
    assert.ok(thrown.length >= 15)
    for (const error of thrown) for (const secret of [PASSWORD, OTHER, t.account.kit.words, code, b64u(Buffer.from(code, 'hex'))]) assert.ok(!told(error).includes(secret), error.code)
  })
})
