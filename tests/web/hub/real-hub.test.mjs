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
import { createHash, randomBytes } from 'node:crypto'
import { Hub, HubError, logEntry } from '../../../app/web/core/hub.ts'
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
    const challenge = await hub.passkeyChallenge()
    assert.equal(challenge.length, 32)
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
// REAL hub with REAL cryptography: a device founds a room through its outbox, signs in by challenge, and uses the
// routes a human device has. Skipped, and says so, when the hub's binary or the binding's build is missing.
// The binding as built today has no stored content, invites or recovery (core-api.ts part 2), so envelopes, the
// Desk's objects, invites and a recovery are not reached here either.
//
// ONE THING HERE IS NOT THE CORE'S: the SealedKey. The binding can only be built with its recovery stand-in
// (TROMMI_STAND_IN_RECOVERY=1), and what that writes as a SealedKey is not the struct of spec/v2.md 8.2: the real hub
// refuses it (`incomplete`, "cut short"), so with today's binding no room can be founded on a real hub at all. To get
// behind the sign-in anyway, this test puts a SealedKey of the right FORM in its place (the right group, epoch,
// GroupInfo hash, recovery key and writer; random bytes where the sealed key and the tag would be, which a hub
// cannot check). Everything else is the core's: the MLS GroupInfo and Commits the hub verifies, the sign-in
// signature, the KeyPackages, the file's sealing, the account's keys and copies.

const here = path => new URL(path, import.meta.url)
const PKG = here('../../../core/wasm/pkg/trommi-core.js')
const no_core = !existsSync(PKG) ? 'the core\'s WASM binding is not built (core/wasm/build.sh, for now with TROMMI_STAND_IN_RECOVERY=1)' : null
if (!missing && no_core) console.warn(`\nSKIPPED: nothing ran behind the real hub's sign-in: ${no_core}.\n`)
const KDF_PASSWORD = 'correct horse battery staple 42'
/** A SealedKey in the wire form of hub/src/wire.rs, sealing nothing: see above. */
function formalSealedKey({ group, epoch, group_info, room_epoch, recovery_hpke_key, writer }) {
  // a vector's length prefix as MLS writes it (RFC 9420 2.1.2): one, two or four bytes
  const vec = bytes => bytes.length < 64 ? [bytes.length, ...bytes] : bytes.length < 16384 ? [0x40 | bytes.length >> 8, bytes.length & 255, ...bytes] : [0x80 | bytes.length >>> 24, bytes.length >> 16 & 255, bytes.length >> 8 & 255, bytes.length & 255, ...bytes]
  const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b }
  // RefHash("Trommi Group Info", GroupInfo) (hub delivery.rs group_info_hash)
  const info_hash = createHash('sha256').update(Buffer.from([...vec(Buffer.from('Trommi Group Info')), ...vec(group_info)])).digest()
  return new Uint8Array([...vec(group), ...u64(epoch), ...info_hash, ...u64(room_epoch), ...vec(recovery_hpke_key), ...vec(randomBytes(32)), ...vec(randomBytes(48)), ...writer, ...vec(randomBytes(32))])
}

test('real hub, real core: a room founded through the outbox, sign-in, the routes of a human device', { skip: missing ?? no_core ?? false }, async t => {
  const core = await import(PKG)
  const { MemoryStore } = await import(here('../../bindings/stores.mjs'))
  const { readFile } = await import('node:fs/promises')
  await core.init(await readFile(here('../../../core/wasm/pkg/trommi_core_wasm_bg.wasm')))
  const real = await startRealHub()
  t.after(() => real.close())
  const device = await core.Device.create(new MemoryStore(`hub-test-${Date.now()}`))
  t.after(() => device.close())
  const hub = new Hub({ hub_url: real.url, client_name: MIN_CLIENT })
  const post = async (kind, opts) => {
    const entry = (await device.outbox()).find(e => e.kind === kind)
    assert.ok(entry, `an outbox entry ${kind}`)
    // the stand-in's SealedKey gives way to one of the right form (see the comment above this test)
    const at = { roomFounding: [1, 0, 0], commit: [3, 1, 2] }[kind]
    if (at) {
      const roles = await device.roomRoles(), new_epoch = entry.epoch + (kind === 'commit' ? 1 : 0)
      entry.parts[at[0]] = formalSealedKey({ group: entry.group, epoch: new_epoch, group_info: entry.parts[at[1]], room_epoch: entry.epoch, recovery_hpke_key: roles.recoveryHpkeKey, writer: await device.id() })
    }
    const answer = await hub.postOutbox(entry, opts).catch(e => { throw new Error(`${kind}: ${e.code} ${e.hub_message ?? e.message}`) })
    assert.deepEqual(await hub.postOutbox(entry, opts), answer, `${kind}: the same bytes again get the first answer`)
    await device.outboxAccepted(entry.id, answer.change)
    return answer
  }

  await t.test('roomFounding → POST /v2/rooms; a repeated post gets the same room', async () => {
    const code = core.generateRecoveryCode()
    const room = await device.foundRoom(code, Date.now())
    const answer = await post('roomFounding')
    assert.deepEqual(answer, { change: null, room_id: room })
    t.room = room
    t.code = code
  })
  const room = t.room, group = core.roomGroupId(room), me = await device.id()

  await t.test('sign-in by challenge with the device\'s key; the hub calls it human', async () => {
    hub.useSigner(room, (address, challenge) => device.hubSignIn(room, address, challenge))
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
    await assert.rejects(hub.account(), refused('not-found', 404))
    assert.deepEqual((await hub.chatItems('session', id(16))), { items: [], more: false })
    assert.deepEqual((await hub.boardItems(id(16))), { items: [], more: false })
    await assert.rejects(hub.objectEnvelopes('cards', id(16)), refused('not-found', 404))
    assert.deepEqual(await hub.chain(group, me), { items: [], more: false })
    await assert.rejects(hub.postEnvelope(new Uint8Array([1, 2])), refused('bad-format', 400))
    await assert.rejects(hub.postEnvelope(new Uint8Array([1, 9, 9])), refused('newer-version', 400))
    await assert.rejects(hub.getFile(id(16)), refused('not-found', 404))
  })
  await t.test('keyPackages → PUT /v2/key-packages', async () => {
    const made = await device.keyPackagesToUpload(0, Date.now())
    assert.notEqual(made, null, 'the device has KeyPackages to publish')
    const answer = await post('keyPackages')
    assert.equal(answer.change, null)
    assert.ok(answer.unused > 0 && answer.unused <= 100, `${answer.unused} unused`)
  })
  await t.test('commit → POST /v2/groups/{group}/commits; the stream brings it as a log event the core takes as its own', async () => {
    const heard = [], states = []
    const close = hub.stream(() => 0, e => { heard.push(e) }, s => states.push(s), e => states.push(e.code ?? String(e)))
    t.after(close)
    for (let i = 0; states.at(-1) !== 'live'; i++) { assert.ok(i < 300, `the stream came live: ${states}`); await new Promise(r => setTimeout(r, 10)) }
    assert.equal(await device.update(group, true, Date.now()) !== null, true)
    const answer = await post('commit')
    assert.equal(answer.epoch, 1)
    for (let i = 0; !heard.some(e => e.event === 'change'); i++) { assert.ok(i < 300, `a log event came: ${states}`); await new Promise(r => setTimeout(r, 10)) }
    const { item } = heard.find(e => e.event === 'change')
    assert.deepEqual([item.kind, item.change, item.group, item.n, item.epoch, item.sender, item.recovery_auth], ['commit', answer.change, group, 1, 0, me, null])
    const processed = await device.processLogEntry(logEntry(item))
    assert.equal(processed.kind, 'ownCommit')
    assert.equal(await device.cursor(), answer.change)
    close()
    const page = await hub.changes(0)
    assert.deepEqual(page.items, [item], 'catch-up serves the same item')
    assert.deepEqual((await hub.groupLog(group)).items, [item])
    assert.deepEqual((await hub.groupLog(group, { commits_only: true })).items, [item])
    assert.equal((await hub.groupInfo(group)).epoch, 1)
    assert.equal((await hub.sealedKeys()).rows.length, 2)
    assert.deepEqual((await hub.sealedKeys(0, 1)).more, true)
    const stale = (await device.outbox()).length
    assert.equal(stale, 0, 'the outbox is empty')
  })
  await t.test('relayMessage → POST /v2/groups/{group}/messages { relay: true }', async () => {
    await device.sendStrokePiece(id(16), utf8('{"piece":1}'))
    assert.deepEqual(await post('relayMessage'), { change: null, n: null })
  })
  await t.test('a file sealed by the core: PUT in pieces with its length, GET whole and by Range, DELETE', async () => {
    const plain = new Uint8Array(randomBytes(3 << 20))
    const sealer = new core.FileEncryptor()
    const head = sealer.update(plain), end = sealer.finish()
    const stored = new Uint8Array([...head, ...end.stored])
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
  await t.test('the account: sign-up by the device, login with the password and with the kit, the copies open, a new password', async () => {
    const email = `ada-${Date.now()}@example.com`, kdf = JSON.parse(core.kdfRecord())
    const password = core.passwordKeys(email, KDF_PASSWORD), words = core.generateKitWords(), kit = core.kitKeys(email, words)
    const seal = (keys, way) => core.sealRecoveryCode(keys.wrapKey, room, way, null, t.code)
    const view = await hub.createAccount({ email, kit: { auth_key: kit.authKey, sealed_copy: seal(kit, 'kit') }, password: { auth_key: password.authKey, sealed_copy: seal(password, 'password'), kdf } })
    assert.deepEqual([view.email, view.revision, view.has_password, view.kdf, view.passkeys, view.rooms], [email, 1, true, kdf, [], [room]])
    assert.deepEqual(await hub.account(), view)
    await assert.rejects(hub.createAccount({ email, kit: { auth_key: kit.authKey, sealed_copy: seal(kit, 'kit') }, password: { auth_key: password.authKey, sealed_copy: seal(password, 'password'), kdf } }), refused('account-exists', 409))

    const outside = new Hub({ hub_url: real.url, client_name: MIN_CLIENT })
    await assert.rejects(outside.login(email, kit.authKey), refused('wrong-login', 401))
    const login = await outside.login(email, password.authKey)
    assert.deepEqual([login.rooms.length, login.rooms[0].room_id, login.kdf], [1, room, kdf])
    assert.deepEqual(core.openRecoveryCode(password.wrapKey, room, 'password', null, login.rooms[0].sealed_copy), t.code)
    const recovered = await outside.recover(email, kit.authKey)
    assert.deepEqual(core.openRecoveryCode(kit.wrapKey, room, 'kit', null, recovered.rooms[0].sealed_copy), t.code)

    const next = core.passwordKeys(email, KDF_PASSWORD + '!')
    assert.deepEqual(await hub.putPassword({ auth_key: next.authKey, sealed_copy: seal(next, 'password'), kdf, revision: 1 }), { revision: 2 })
    await assert.rejects(hub.putKit({ auth_key: kit.authKey, sealed_copy: seal(kit, 'kit'), revision: 1 }), refused('account-changed', 409))
    await assert.rejects(outside.login(email, password.authKey), refused('wrong-login', 401))
    assert.equal((await outside.login(email, next.authKey)).rooms.length, 1)
    assert.equal((await hub.accountPasskeyChallenge()).length, 32)
  })
  await t.test('a token the hub forgot (it restarted) is taken again, by the device\'s key', async () => {
    const before = await hub.desk()
    hub.timing.renew_before = 0
    Object.assign(hub, { renew_at: 0 })           // as if the token had run out here
    assert.deepEqual((await hub.desk()).change, before.change)
  })
})
