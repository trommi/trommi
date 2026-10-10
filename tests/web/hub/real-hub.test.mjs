// The hub client against the REAL v2 hub's binary (hub/src/main.rs), as far as it goes without valid cryptography:
// the challenge, the refusals for bad input and for a missing token, the account's no-token routes, invites and
// shares that do not exist, `client-too-old`, unknown routes. A room cannot be founded from here (that takes a real
// MLS GroupInfo, which only the core makes), so nothing behind a sign-in is reached: that part runs against the fake
// hub only. Every check below is run against BOTH hubs with the same expectations, so the fake hub cannot drift from
// the real one in what they share.
//
//   TROMMI_HUB_BIN=/path/to/trommi-hub node --test tests/web/hub/real-hub.test.mjs
// Without TROMMI_HUB_BIN the real hub's half is SKIPPED, and says so. TROMMI_HUB_TMP names where its data goes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Hub, HubError, accountCopiesBytes, logEntry } from '../../../app/web/core/hub.ts'
import { b64u } from '../../../app/web/core/ids.ts'
import { startFakeHub } from '../stand-in/hub.mjs'
import { id, utf8, txt } from './helpers.mjs'

const BIN = process.env.TROMMI_HUB_BIN
const MIN_CLIENT = 'app/2.0.0'

async function freePort() {
  const probe = createServer()
  await new Promise(r => probe.listen(0, '127.0.0.1', r))
  const { port } = probe.address()
  await new Promise(r => probe.close(r))
  return port
}
async function startRealHub() {
  const port = await freePort(), url = `http://127.0.0.1:${port}`
  const data = await mkdtemp(join(process.env.TROMMI_HUB_TMP ?? tmpdir(), 'trommi-hub-test-'))
  const env = { HUB_HOST: '127.0.0.1', HUB_PORT: String(port), HUB_URL: url, HUB_DATA: data, HUB_QUIET: '1', HUB_LOGIN_THROTTLE: 'off', HUB_MIN_CLIENT: MIN_CLIENT, PATH: process.env.PATH ?? '' }
  const child = spawn(BIN, [], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', d => { stderr += d })
  const exited = new Promise(resolve => child.once('exit', resolve))
  for (let i = 0; ; i++) {
    const ok = await fetch(`${url}/healthz`).then(r => r.ok, () => false)
    if (ok) break
    if (child.exitCode !== null || i > 200) throw new Error(`the hub did not start: ${stderr.slice(0, 500)}`)
    await new Promise(r => setTimeout(r, 50))
  }
  return {
    url,
    async close() {
      // the hub waits for its open connections on SIGTERM; this test keeps some alive, so it is not given long
      child.kill('SIGTERM')
      const killer = setTimeout(() => child.kill('SIGKILL'), 1000)
      await exited
      clearTimeout(killer)
      await rm(data, { recursive: true, force: true })
    },
  }
}

/** What differs between the two hubs here: how HubAuth is written, and which check refuses first where the real hub
 *  verifies cryptography that the fake hub does not have. */
const REAL = {
  /** HubAuth in the real wire form (hub/src/wire.rs): room_id[32] ‖ hub<V> ‖ device[32] ‖ challenge[32]. */
  hubAuth(room_id, hub, device, challenge) {
    const address = utf8(hub)
    assert.ok(address.length < 64)
    return new Uint8Array(Buffer.concat([room_id, Buffer.from([address.length]), address, device, challenge]))
  },
  stranger: ['bad-signature', 400],          // the signature is checked before the key's standing
  founding: ['bad-commit', 400],             // "GroupInfo signature"
  request: ['bad-format', 400],              // the Request is parsed before its invite is looked up
  malformed_passkey: [['wrong-login', 401], ['bad-format', 400]],
}
const FAKE = {
  hubAuth: (room_id, hub, device, challenge) => utf8({ room_id, hub, device, challenge }),
  stranger: ['not-member', 403],
  founding: ['bad-format', 400],
  request: ['not-found', 404],
  malformed_passkey: [['wrong-login', 401]],
}
const refused = (code, status) => e => {
  assert.ok(e instanceof HubError, `a HubError, not ${e}`)
  assert.deepEqual([e.code, e.status, e.voided], [code, status, false])
  assert.equal(typeof e.hub_message, 'string')
  return true
}

function checks(name, start, skip, kind) {
  const hubs = {}
  const opts = skip ? { skip } : {}
  test(`${name}: start`, opts, async () => { hubs.hub = await start() })
  test.after(() => hubs.hub?.close())
  const on = (what, run) => test(`${name}: ${what}`, opts, () => run(new Hub({ hub_url: hubs.hub.url, client_name: MIN_CLIENT }), hubs.hub.url))

  on('a challenge is 32 fresh bytes for any room id, without a token', async hub => {
    const room = id(32)
    const [a, b] = [await hub.challenge(room), await hub.challenge(room)]
    assert.equal(a.length, 32)
    assert.notDeepEqual(a, b)
  })
  on('a sign-in that is no HubAuth is bad-format, and is not tried again', async hub => {
    let signs = 0
    hub.useSigner(id(32), async () => { signs += 1; return { auth: utf8('not a HubAuth'), signature: new Uint8Array(64) } })
    await assert.rejects(hub.desk(), refused('bad-format', 400))
    assert.equal(signs, 1)
  })
  on('a sign-in for a room that is not there is refused, a used challenge is bad-challenge', async (hub, url) => {
    const room = id(32), device = id(32)
    let reuse = null
    hub.useSigner(room, async (address, challenge) => ({ auth: kind.hubAuth(room, address, device, reuse ?? (reuse = challenge)), signature: new Uint8Array(64) }))
    await assert.rejects(hub.desk(), refused(...kind.stranger))
    await assert.rejects(hub.signIn(), refused('bad-challenge', 401))
    assert.equal(url, hub.hub_url)
  })
  on('a sign-in signed for another hub address is refused', async hub => {
    const room = id(32)
    hub.useSigner(room, async (_, challenge) => ({ auth: kind.hubAuth(room, 'https://other.example', id(32), challenge), signature: new Uint8Array(64) }))
    await assert.rejects(hub.signIn(), refused('bad-format', 400))
  })
  on('routes behind the token answer 401 unauthorised without one: JSON, files, the stream', async hub => {
    for (const [method, path] of [['GET', '/v2/desk'], ['GET', '/v2/changes'], ['GET', '/v2/welcomes'], ['GET', '/v2/account'], ['GET', `/v2/files/${txt(id(16))}`], ['DELETE', `/v2/files/${txt(id(16))}`], ['GET', '/v2/stream'], ['POST', '/v2/envelopes'], ['GET', '/v2/push']]) {
      await assert.rejects(hub.request(method, path, { auth: false, ...(method === 'POST' ? { body: { envelope: 'AAAA' } } : {}) }), refused('unauthorised', 401), `${method} ${path}`)
    }
    await assert.rejects(hub.request('PUT', `/v2/files/${txt(id(16))}`, { auth: false, body: new Uint8Array(1000) }), refused('unauthorised', 401))
    await assert.rejects(hub.request('GET', '/v2/desk', { auth: false, headers: { authorization: 'Bearer ' + b64u(randomBytes(32)) } }), refused('unauthorised', 401))
  })
  on('a login with an unknown e-mail or a wrong key is wrong-login; with the kit, wrong-recovery', async hub => {
    await assert.rejects(hub.login('nobody@example.com', new Uint8Array(32)), refused('wrong-login', 401))
    await assert.rejects(hub.login('not an e-mail', new Uint8Array(32)), refused('wrong-login', 401))
    await assert.rejects(hub.recover('nobody@example.com', new Uint8Array(32)), refused('wrong-recovery', 401))
    await assert.rejects(hub.login('nobody@example.com', new Uint8Array(5)), refused('bad-format', 400))
  })
  on('a passkey challenge is 32 bytes; a passkey nobody registered is wrong-login', async hub => {
    const { challenge, account, user_handle } = await hub.passkeyChallenge()
    assert.deepEqual([challenge.length, user_handle.length], [32, 16])
    assert.equal(account.replaceAll('-', ''), Buffer.from(user_handle).toString('hex'), 'the id an account made on this challenge will have')
    const client_data_json = utf8({ type: 'webauthn.get', challenge: b64u(challenge), origin: 'https://app.trommi.com' })
    await assert.rejects(hub.passkeyLogin({ credential_id: new Uint8Array(16), authenticator_data: new Uint8Array(37), client_data_json, signature: new Uint8Array(70) }), refused('wrong-login', 401))
  })
  on('a founding that is no GroupInfo is refused with a 400', async hub => {
    const e = await hub.foundRoom({ group_info: utf8('not a GroupInfo'), sealed_key: utf8('not a SealedKey') }).catch(x => x)
    assert.ok(refused(...kind.founding)(e))
    assert.equal(e.transient, false)
  })
  on('an invite that is not there: not-found for the Offer, the Reveal and a Request', async hub => {
    await assert.rejects(hub.getInvite(id(16)), refused('not-found', 404))
    await assert.rejects(hub.getReveal(id(16)), refused('not-found', 404))
    await assert.rejects(hub.postInviteRequest(id(16), { request: new Uint8Array(200), mac: new Uint8Array(32), signature: new Uint8Array(64) }), refused(...kind.request))
  })
  on('a share that is not there, or a wrong secret: the same not-found', async hub => {
    const a = await hub.getShared(id(16), new Uint8Array(32)).catch(x => x)
    const b = await hub.getShared(id(16), new Uint8Array(randomBytes(32)), { range: { start: 0, end: 9 } }).catch(x => x)
    assert.ok(refused('not-found', 404)(a) && refused('not-found', 404)(b))
    assert.equal(a.hub_message, b.hub_message)
  })
  on('an unknown route, and a body that is no JSON object', async hub => {
    await assert.rejects(hub.request('GET', '/v2/no-such-route', { auth: false }), refused('not-found', 404))
    await assert.rejects(hub.request('POST', '/v2/account/login', { auth: false, body: [1, 2] }), refused('bad-format', 400))
    await assert.rejects(hub.request('GET', `/v2/rooms/${txt(id(16))}/challenge`, { auth: false }), refused('bad-format', 400))
    await assert.rejects(hub.request('DELETE', '/v2/desk', { auth: false }), refused('not-found', 404))
    // hub-api.md "Decided" 36 (newer than the hub commit c64bf6f, which still says bad-format): one answer for every failure
    const malformed = await hub.request('POST', '/v2/account/passkey/login', { auth: false, body: {} }).catch(e => e)
    assert.ok(kind.malformed_passkey.some(([code, status]) => malformed.code === code && malformed.status === status), `${malformed.code} ${malformed.status}`)
  })
  on('a client older than the hub asks for is client-too-old (426) on every route; one that names nothing too', async (hub, url) => {
    const old = new Hub({ hub_url: url, client_name: 'app/1.9.9' }), nameless = new Hub({ hub_url: url })
    for (const h of [old, nameless]) {
      const e = await h.challenge(id(32)).catch(x => x)
      assert.deepEqual([e.code, e.status, e.transient], ['client-too-old', 426, true])
      await assert.rejects(h.login('nobody@example.com', new Uint8Array(32)), refused('client-too-old', 426))
    }
    assert.equal((await new Hub({ hub_url: url, client_name: 'connector/2.0.1' }).challenge(id(32))).length, 32)
    assert.equal(hub.client_name, MIN_CLIENT)
  })
}

const missing = !BIN ? 'TROMMI_HUB_BIN is not set' : !existsSync(BIN) ? `TROMMI_HUB_BIN names no file: ${BIN}` : null
if (missing) console.warn(`\nSKIPPED: the hub client was NOT run against the real hub (${missing}).\nBuild it: cargo build --locked -p trommi-hub --release, then TROMMI_HUB_BIN=<target>/release/trommi-hub.\n`)
checks('real hub', startRealHub, missing ? `${missing}: nothing ran against the real hub` : false, REAL)
checks('fake hub', () => startFakeHub({ min_client: MIN_CLIENT }), false, FAKE)

// ---------------------------------------------------------------------------------------------------------------------
// With the real core (the WASM binding, core/wasm/build.sh → core/wasm/pkg/) the client goes behind the sign-in of the
// REAL hub with REAL cryptography, nothing put in its place: a device founds a room with its account through its
// outbox and uses the routes a human device has; a second device signs in with the recovery code and joins; the code
// is replaced; a third device recovers the room. Skipped, and says so, when the hub's binary or the binding's build
// is missing. The binding has no stored content and no invite handshake yet (core-api.ts part 2), so accepted
// envelopes, the Desk's objects and invites are not reached here.

const here = path => new URL(path, import.meta.url)
const PKG = here('../../../core/wasm/pkg/trommi-core.js')
const no_core = !existsSync(PKG) ? 'the core\'s WASM binding is not built (core/wasm/build.sh)' : null
if (!missing && no_core) console.warn(`\nSKIPPED: nothing ran behind the real hub's sign-in: ${no_core}.\n`)
const PASSWORD = 'correct horse battery staple 42'
test('real hub, real core: a room with its account, a second device by the code, a new code, a recovery', { skip: missing ?? no_core ?? false }, async t => {
  const core = await import(PKG)
  const { MemoryStore } = await import(here('../../bindings/stores.mjs'))
  const { readFile } = await import('node:fs/promises')
  await core.init(await readFile(here('../../../core/wasm/pkg/trommi_core_wasm_bg.wasm')))
  const real = await startRealHub()
  t.after(() => real.close())
  const newDevice = async name => { const d = await core.Device.create(new MemoryStore(`hub-test-${name}-${Date.now()}`)); t.after(() => d.close()); return d }
  const newHub = () => new Hub({ hub_url: real.url, client_name: MIN_CLIENT })
  /** Posts the device's outbox entries of a kind (all of them when none is named), each twice: the second post
   *  must get the first answer. */
  const post = async (device, hub, kind, opts) => {
    const entries = (await device.outbox()).filter(e => !kind || e.kind === kind)
    assert.ok(entries.length > 0, `an outbox entry ${kind ?? ''}`)
    const answers = []
    for (const [i, entry] of entries.entries()) {
      const where = `${entry.kind} (entry ${i + 1} of ${entries.length}, ${entry.group?.length === 32 ? 'room' : 'session'} group, epoch ${entry.epoch})`
      const answer = await hub.postOutbox(entry, opts).catch(e => { throw new Error(`${where}: ${e.code} ${e.status} ${e.hub_message ?? e.message}`) })
      if (entry.kind !== 'relayMessage') assert.deepEqual(await hub.postOutbox(entry, opts), answer, `${entry.kind}: the same bytes again get the first answer`)
      await device.outboxAccepted(entry.id, answer.change)
      answers.push({ kind: entry.kind, ...answer })
    }
    return kind ? answers[0] : answers
  }
  /** Feeds a device what the hub's one order holds after its cursor. */
  const catchUp = async (device, hub) => {
    const done = []
    for (let more = true; more;) {
      const page = await hub.changes(await device.cursor())
      for (const item of page.items) if (item.kind !== 'envelope') done.push((await device.processLogEntry(logEntry(item))).kind)
      more = page.more
    }
    return done
  }
  const email = `ada-${Date.now()}@example.com`, kdf = JSON.parse(core.kdfRecord())
  const password = core.passwordKeys(email, PASSWORD)
  const copiesOf = (room, code) => {
    const kit = core.kitKeys(email, core.generateKitWords())
    return { kit, copies: { kit: { auth_key: kit.authKey, sealed_copy: core.sealRecoveryCode(kit.wrapKey, room, 'kit', null, code), form: 'email' }, password: { sealed_copy: core.sealRecoveryCode(password.wrapKey, room, 'password', null, code) } } }
  }
  const byCode = (room, code) => async (address, challenge) => core.recoverySignIn(code, room, address, challenge)

  const first = await newDevice('first'), hub = newHub(), outside = newHub()
  let code = core.generateRecoveryCode()
  const room = await first.foundRoom(code, Date.now()), group = core.roomGroupId(room), me = await first.id()
  let kit = null

  await t.test('roomFounding → POST /v2/rooms with the account in the same request; the entry again gets the same room', async () => {
    const made = copiesOf(room, code)
    kit = made.kit
    const [entry] = await first.outbox()
    assert.deepEqual([entry.kind, entry.parts.length], ['roomFounding', 2])
    const account = { email, kit: made.copies.kit, password: { auth_key: password.authKey, sealed_copy: made.copies.password.sealed_copy, kdf } }
    assert.deepEqual(await hub.foundRoom({ group_info: entry.parts[0], sealed_key: entry.parts[1], account }), { room_id: room })
    assert.deepEqual(await post(first, hub, 'roomFounding'), { kind: 'roomFounding', change: null, room_id: room })
  })
  await t.test('sign-in by challenge with the device\'s key; the hub calls it human', async () => {
    hub.useSigner(room, (address, challenge) => first.hubSignIn(room, address, challenge))
    await hub.signIn()
    assert.equal(hub.role, 'human')
  })
  await t.test('the Desk, the room\'s groups, GroupInfo, the log, catch-up, sealed keys, welcomes, requests, push', async () => {
    const desk = await hub.desk()
    assert.deepEqual([desk.cards, desk.notes, desk.permission_requests, desk.artifacts, desk.registers, desk.truncated], [[], [], [], [], [], false])
    assert.deepEqual(desk.groups.map(g => [g.group, g.kind, g.session_id, g.epoch, g.live, g.stale, g.leaves]), [[group, 'room', null, 0, true, false, [me]]])
    assert.deepEqual(await hub.roomGroups(), desk.groups)
    const info = await hub.groupInfo(group)
    assert.equal(info.epoch, 0)
    assert.deepEqual(await hub.groupInfo(group, 0), info)
    await assert.rejects(hub.groupInfo(group, 5), refused('not-found', 404))
    assert.deepEqual(await hub.groupLog(group), { items: [], more: false })
    const caught = await hub.changes(0)
    assert.deepEqual([caught.items, caught.more], [[], false])
    assert.equal(caught.change, desk.change)
    const keys = await hub.sealedKeys()
    assert.deepEqual([keys.rows.length, keys.links, keys.more, keys.change], [1, [], false, keys.rows[0].change], 'the founding\'s SealedKey')
    assert.deepEqual(await hub.welcomes(), [])
    assert.deepEqual(await hub.requests(), [])
    const push = await hub.pushState()
    assert.deepEqual([push.subscriptions, push.vapid_public_key.length], [[], 65])
    assert.deepEqual((await hub.chatItems('session', id(16))), { items: [], more: false })
    assert.deepEqual((await hub.boardItems(id(16))), { items: [], more: false })
    await assert.rejects(hub.objectEnvelopes('cards', id(16)), refused('not-found', 404))
    assert.deepEqual(await hub.chain(group, me), { items: [], more: false })
    await assert.rejects(hub.postEnvelope(new Uint8Array([1, 2])), refused('bad-format', 400))
    await assert.rejects(hub.postEnvelope(new Uint8Array([1, 9, 9])), refused('newer-version', 400))
    await assert.rejects(hub.getFile(id(16)), refused('not-found', 404))
  })
  await t.test('keyPackages → PUT /v2/key-packages', async () => {
    assert.notEqual(await first.keyPackagesToUpload(0, Date.now()), null, 'the device has KeyPackages to publish')
    const answer = await post(first, hub, 'keyPackages')
    assert.equal(answer.change, null)
    assert.ok(answer.unused > 0 && answer.unused <= 100, `${answer.unused} unused`)
  })
  await t.test('commit → POST /v2/groups/{group}/commits; the stream brings it as a log event the core takes as its own', async () => {
    const heard = [], states = []
    const close = hub.stream(() => 0, e => { heard.push(e) }, s => states.push(s), e => states.push(e.code ?? String(e)))
    t.after(close)
    for (let i = 0; states.at(-1) !== 'live'; i++) { assert.ok(i < 300, `the stream came live: ${states}`); await new Promise(r => setTimeout(r, 10)) }
    assert.notEqual(await first.update(group, true, Date.now()), null)
    const answer = await post(first, hub, 'commit')
    assert.equal(answer.epoch, 1)
    for (let i = 0; !heard.some(e => e.event === 'change'); i++) { assert.ok(i < 300, `a log event came: ${states}`); await new Promise(r => setTimeout(r, 10)) }
    const { item } = heard.find(e => e.event === 'change')
    assert.deepEqual([item.kind, item.change, item.group, item.n, item.epoch, item.sender, item.recovery_auth], ['commit', answer.change, group, 1, 0, me, null])
    assert.equal((await first.processLogEntry(logEntry(item))).kind, 'ownCommit')
    assert.equal(await first.cursor(), answer.change)
    close()
    assert.deepEqual((await hub.changes(0)).items, [item], 'catch-up serves the same item')
    assert.deepEqual((await hub.groupLog(group)).items, [item])
    assert.deepEqual((await hub.groupLog(group, { commits_only: true })).items, [item])
    assert.equal((await hub.groupInfo(group)).epoch, 1)
    assert.equal((await hub.sealedKeys()).rows.length, 2)
    assert.deepEqual((await hub.sealedKeys(0, 1)).more, true)
    assert.equal((await first.outbox()).length, 0, 'the outbox is empty')
  })
  await t.test('relayMessage → POST /v2/groups/{group}/messages { relay: true }', async () => {
    await first.sendStrokePiece(id(16), utf8('{"piece":1}'))
    assert.deepEqual(await post(first, hub, 'relayMessage'), { kind: 'relayMessage', change: null, n: null })
  })
  await t.test('a file sealed by the core: PUT in pieces with its length, GET whole and by Range, DELETE', async () => {
    const plain = new Uint8Array(randomBytes(3 << 20))
    const sealer = new core.FileEncryptor()
    const begun = sealer.update(plain), end = sealer.finish()
    const stored = new Uint8Array([...begun, ...end.stored])
    assert.equal(stored.length, end.storedLen)
    const progress = []
    const put = await hub.putFile(end.file.fileId, stored, { onProgress: done => progress.push(done) })
    assert.deepEqual([put.file_id, put.size], [end.file.fileId, stored.length])
    assert.ok(progress.length > 10 && progress.at(-1) === stored.length)
    assert.deepEqual(await hub.putFile(end.file.fileId, stored), put, 'the same bytes again: the first answer')
    await assert.rejects(hub.putFile(end.file.fileId, stored.slice(1)), refused('replay', 409))
    const got = await hub.getFile(end.file.fileId)
    assert.equal(got.size, stored.length)
    assert.ok(Buffer.from(got.bytes).equals(Buffer.from(stored)))
    const opener = new core.FileDecryptor(end.file)
    const opened = new Uint8Array([...opener.update(got.bytes), ...opener.finish()])
    assert.ok(Buffer.from(opened).equals(Buffer.from(plain)), 'the core opens what the hub served')
    const part = await hub.getFile(end.file.fileId, { range: { start: 1000, end: 70_999 } })
    assert.deepEqual([part.size, part.bytes.length], [stored.length, 70_000])
    assert.ok(Buffer.from(part.bytes).equals(Buffer.from(stored.subarray(1000, 71_000))))
    await assert.rejects(hub.getFile(end.file.fileId, { range: { start: stored.length } }), refused('range', 416))
    await assert.rejects(hub.postShare({ share_id: id(16), secret_hash: new Uint8Array(32), file_id: end.file.fileId, expires_at: Date.now() + 86_400_000 }), refused('forbidden', 403))
    await hub.deleteFile(end.file.fileId)
    await assert.rejects(hub.getFile(end.file.fileId), refused('not-found', 404))
    await assert.rejects(hub.putFile(end.file.fileId, stored), refused('gone', 410))
  })
  await t.test('the account made with the room: read by the device, login with the password and with the kit, the copies open', async () => {
    const view = await hub.account()
    assert.deepEqual([view.email, view.revision, view.has_password, view.kdf, view.passkeys, view.rooms], [email, 1, true, kdf, [], [room]])
    await assert.rejects(hub.createAccount({ email: `other-${email}`, kit: { auth_key: kit.authKey, sealed_copy: view.kit_copy, form: 'email' }, password: { auth_key: password.authKey, sealed_copy: view.kit_copy, kdf } }), refused('account-exists', 409))
    await assert.rejects(outside.login(email, kit.authKey), refused('wrong-login', 401))
    const login = await outside.login(email, password.authKey)
    assert.deepEqual([login.rooms.length, login.rooms[0].room_id, login.kdf], [1, room, kdf])
    assert.deepEqual(core.openRecoveryCode(password.wrapKey, room, 'password', null, login.rooms[0].sealed_copy), code)
    const recovered = await outside.recover(email, kit.authKey)
    assert.deepEqual(core.openRecoveryCode(kit.wrapKey, room, 'kit', null, recovered.rooms[0].sealed_copy), code)
    await assert.rejects(hub.putKit({ auth_key: kit.authKey, sealed_copy: view.kit_copy, form: 'email', revision: 0 }), refused('account-changed', 409))
    assert.deepEqual([(await hub.accountPasskeyChallenge()).account, view.kit_form, login.account, login.email], [view.account, 'email', view.account, email])
  })

  const second = await newDevice('second'), second_hub = newHub()
  await t.test('a second device signs in with the code: login, the recovery key\'s token, servedRoom, joinRoomWithCode, its join posted; then it is a human device', async () => {
    const login = await outside.login(email, password.authKey)
    const opened = core.openRecoveryCode(password.wrapKey, room, 'password', null, login.rooms[0].sealed_copy)
    second_hub.useSigner(room, byCode(room, opened))
    await second_hub.signIn(login.rooms[0].challenge)
    assert.equal(second_hub.role, 'recovery')
    await assert.rejects(second_hub.desk(), refused('forbidden', 403))
    const { served, session_groups } = await second_hub.servedRoom({ anchorOf: rows => core.recoveryAnchor(opened, room, rows) })
    assert.deepEqual(session_groups, [])
    assert.deepEqual([served.group.commits.length, served.rows.length, served.links, served.sessions], [1, 2, [], []])
    const joined = await second.joinRoomWithCode(opened, served, Date.now())
    assert.deepEqual([joined.outbox.length, joined.missingLink, joined.unverified], [1, null, []])
    const answers = await post(second, second_hub)
    assert.deepEqual(answers.map(a => [a.kind, a.epoch]), [['externalCommit', 2]])

    second_hub.useSigner(room, (address, challenge) => second.hubSignIn(room, address, challenge))
    await second_hub.signIn()
    assert.equal(second_hub.role, 'human')
    const log = await second_hub.groupLog(group, { commits_only: true })
    assert.deepEqual(log.items.map(i => [i.epoch, i.recovery_auth !== null]), [[0, false], [1, true]])
    assert.deepEqual(log.items[1].sender, await second.id())
    assert.deepEqual((await second_hub.roomGroups())[0].leaves.length, 2)
    assert.deepEqual((await second_hub.desk()).groups[0].epoch, 2)
    const taken = await catchUp(first, hub)
    assert.deepEqual(taken, ['commit'], 'the first device takes the join')
    assert.deepEqual((await first.group(group)).leaves.length, 2)
    assert.deepEqual((await second.group(group)).epoch, 2)
  })

  let replaced = false
  await t.test('the code is replaced: newRecoveryCode, replaceCode with the account\'s copies → recoveryCode → POST …/recovery-code', async () => {
    const newer = await first.newRecoveryCode(code)
    const made = copiesOf(room, newer)
    assert.notEqual(await first.replaceCode(code, accountCopiesBytes(made.copies), Date.now()), null)
    const [entry] = await first.outbox()
    assert.deepEqual([entry.kind, entry.parts.length], ['recoveryCode', 5])
    const answer = await post(first, hub, 'recoveryCode')
    assert.equal(answer.epoch, 3)
    await catchUp(first, hub)
    const keys = await hub.sealedKeys()
    assert.equal(keys.links.length, 1)
    const login = await outside.login(email, password.authKey)
    assert.deepEqual(core.openRecoveryCode(password.wrapKey, room, 'password', null, login.rooms[0].sealed_copy), newer, 'the account opens the new code')
    assert.deepEqual(core.openRecoveryCode(made.kit.wrapKey, room, 'kit', null, (await outside.recover(email, made.kit.authKey)).rooms[0].sealed_copy), newer)
    await assert.rejects(outside.recover(email, kit.authKey), refused('wrong-recovery', 401))
    const old = newHub()
    old.useSigner(room, byCode(room, code))
    await assert.rejects(old.signIn(), refused('not-member', 403))
    kit = made.kit
    code = newer
    replaced = true
  })

  await t.test('a recovery (8.7): a third device with the code prepares it, recovers, posts recoveryCommit … recoveryFinish; the others are out', async () => {
    const third = await newDevice('third'), third_hub = newHub()
    third_hub.useSigner(room, byCode(room, code))
    const { served } = await third_hub.servedRoom({ anchorOf: rows => core.recoveryAnchor(code, room, rows) })
    assert.deepEqual([served.group.commits.length, served.links.length], replaced ? [3, 1] : [2, 0])
    const plan = await third.prepareRecovery(code, served)
    assert.equal(plan.newCode.length, 32)
    const cuts = plan.removals.flatMap(r => r.devices.map(device => ({ group: r.group, cut: { device, seq: 0, hash: new Uint8Array(32) } })))
    assert.equal(cuts.length, 2, 'both devices of the room go')
    // the person came back with the bare code and sets a password anew: its login key, its copy, its derivation record
    const fresh = core.passwordKeys(email, PASSWORD + ' anew'), made = copiesOf(room, plan.newCode)
    const copies = { kit: made.copies.kit, password: { auth_key: fresh.authKey, sealed_copy: core.sealRecoveryCode(fresh.wrapKey, room, 'password', null, plan.newCode), kdf } }
    const built = await third.recover(code, served, cuts, accountCopiesBytes(copies), Date.now())
    const kinds = (await third.outbox()).map(e => e.kind)
    assert.deepEqual([kinds.at(-1), kinds.slice(0, -1).every(k => k === 'recoveryCommit'), built.outbox.length], ['recoveryFinish', true, kinds.length])

    const { recovery_id, expires_at } = await third_hub.openRecovery()
    assert.ok(expires_at > Date.now())
    const locked = await hub.rejectCommit(group, 1).catch(e => e)
    assert.deepEqual([locked.code, locked.status, locked.transient], ['overloaded', 503, true], 'the room takes nothing else meanwhile, and that is no refusal')
    const answers = await post(third, third_hub, null, { recovery_id })
    const done = answers.at(-1)
    assert.deepEqual([done.kind, done.published, done.device], ['recoveryFinish', true, await third.id()])
    assert.ok(answers.slice(0, -1).every(a => a.kind === 'recoveryCommit' && a.kept === true))

    third_hub.useSigner(room, (address, challenge) => third.hubSignIn(room, address, challenge))
    await third_hub.signIn()
    assert.equal(third_hub.role, 'human')
    assert.deepEqual((await third_hub.roomGroups())[0].leaves, [await third.id()])
    await assert.rejects(hub.desk(), refused('not-member', 403))
    await assert.rejects(second_hub.desk(), refused('not-member', 403))
    await assert.rejects(outside.login(email, password.authKey), refused('wrong-login', 401))
    const login = await outside.login(email, fresh.authKey)
    assert.deepEqual(core.openRecoveryCode(fresh.wrapKey, room, 'password', null, login.rooms[0].sealed_copy), plan.newCode, 'the password set anew opens the code the recovery made')
    assert.deepEqual(core.openRecoveryCode(made.kit.wrapKey, room, 'kit', null, (await outside.recover(email, made.kit.authKey)).rooms[0].sealed_copy), plan.newCode)
    // what a human device alone may do, and what it may read (hub-api.md "Decided" 39; files 11.3)
    await third_hub.putSealedKey(served.rows[0]).catch(e => assert.ok(e instanceof HubError && e.code !== 'forbidden', `a human device may post a SealedKey: ${e.code}`))
    const again = newHub()
    again.useSigner(room, byCode(room, plan.newCode))
    await assert.rejects(again.putSealedKey(served.rows[0]), refused('forbidden', 403))
  })
})
