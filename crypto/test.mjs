// Tests for zcrypto.mjs. Run: node crypto/test.mjs
//   --write-vectors   regenerate crypto/vectors.json instead of comparing with it
//   --no-bench        skip the micro-benchmark
import assert from 'node:assert/strict'
import fs from 'node:fs'
import nodeCrypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import * as z from './zcrypto.mjs'

const { ROLE, KIND, ENTRY, hex, unhex, utf8, concat, b64u } = z
const VECTORS = fileURLToPath(new URL('./vectors.json', import.meta.url))
const T0 = 1790000000000   // fixed clock for everything that is signed
const MIN = 60 * 1000

// ---- harness -------------------------------------------------------------------

const TL = { timelineKind: 1, timelineId: `desk/${'0d'.repeat(16)}` }
const tests = []
let section = ''
const group = name => { section = name }
const test = (name, fn) => tests.push({ name: `${section}: ${name}`, fn })

async function rejects(fn, code) {
  let err = null
  try { await fn() } catch (e) { err = e }
  assert.ok(err, `expected a rejection with ${code}, but it went through`)
  assert.ok(err instanceof z.ZError, `expected a ZError(${code}), got ${err?.stack ?? err}`)
  const codes = Array.isArray(code) ? code : [code]
  assert.ok(codes.includes(err.code), `expected ${codes.join(' or ')}, got ${err.code}: ${err.message}`)
  return err
}
const flip = (bytes, at, bit = 0) => { const out = bytes.slice(); out[at] ^= 1 << bit; return out }
const txt = b => new TextDecoder().decode(b)
const includesBytes = (hay, needle) => Buffer.from(hay).includes(Buffer.from(needle))

/** Deterministic test-only randomness: call c returns bytes (seed + 17c + j) mod 256 for j = 0..n-1. */
function fixedRng(seed) {
  let c = 0
  return n => { const out = new Uint8Array(n); for (let j = 0; j < n; j++) out[j] = (seed + 17 * c + j) & 0xff; c++; return out }
}
const fill = (n, v) => new Uint8Array(n).fill(v)

// ---- a small world: phone and laptop (human), one agent, and a hub that stores everything ----

// One agent session for the whole world: its key is shared by the humans and the agent (R6). The session
// grant chain that hands it out is crypto/session-grants.mjs; here the secret is simply given to everyone.
const SESSION_ID = fill(16, 0x5e)
const SESSION_SECRET = { epoch: 1, key: fill(32, 0x51), hist: fill(32, 0x52) }
const DESK = '0d'.repeat(16)
// Names left the member list (R8); tests keep their own labels per device id.
const LABELS = new Map()
const named = (device, name) => { LABELS.set(hex(device.id), name); return device }
const who = m => LABELS.get(hex(m.id)) ?? '?'
function client(device, name) {
  named(device, name)
  return { name, device, state: null, pin: null, chains: z.newChains(), secrets: new Map(), sessionSecrets: new Map([[1, SESSION_SECRET]]) }
}
const secretsOf = c => (epoch, h) => (h.keyScope === 1 ? c.sessionSecrets.get(epoch) : c.secrets.get(epoch))
/** What an honest client does when the hub hands it the log. */
async function sync(c, world, log = world.hub.log) {
  const state = await z.verifyLog(log, world.roomId)
  const res = z.checkLogAgainstPin(state, c.pin)
  c.state = state
  c.pin = z.pinOf(state)
  return res
}
async function fetchKey(c, world, epoch = c.state.epoch) {
  if (z.memberAt(c.state, c.device.id)?.role === ROLE.AGENT) return   // agents hold no room key (R6)
  const sealed = world.hub.wraps.get(`${epoch}:${b64u(c.device.id)}`)
  if (!sealed) throw new z.ZError('no-key', 'the hub has no wrap for this device')
  c.secrets.set(epoch, await z.unwrapEpochKey(c.state, c.device, sealed, epoch))
}
function storeWraps(world, epoch, wraps) {
  for (const w of wraps) world.hub.wraps.set(`${epoch}:${b64u(w.id)}`, w.sealed)
}
async function invite(world, inviter, device, role, name, { confirm = true } = {}) {
  const now = T0
  const { link, offer, invite } = await z.createInvite({ state: inviter.state, inviter: inviter.device, hub: world.hubUrl, role, now })
  const { request, join } = await z.createJoinRequest({ link, offer, log: world.hub.log, device, now })
  const { reveal, code } = await z.acceptJoinRequest({ invite, request, inviter: inviter.device, now })
  const shown = await z.checkReveal({ join, reveal, log: world.hub.log })
  assert.equal(shown, code)
  const done = await z.finalizeInvite({ invite, state: inviter.state, inviter: inviter.device, secret: inviter.secrets.get(inviter.state.epoch), codeConfirmed: confirm, skipCheckCode: !confirm, now })
  world.hub.log.push(done.entry)
  const c = client(device, name)
  const joined = await z.completeJoin({ join, device, log: world.hub.log, wrap: done.wrap })
  c.state = joined.state
  c.pin = z.pinOf(joined.state)
  if (joined.secret) {
    c.secrets.set(joined.secret.epoch, joined.secret)
    world.hub.wraps.set(`${joined.secret.epoch}:${b64u(device.id)}`, done.wrap)
  }
  return c
}
async function makeWorld() {
  const world = { hubUrl: 'https://hub.example', hub: { log: [], wraps: new Map(), backLinks: new Map(), envelopes: [] } }
  world.code = z.generateRecoveryCode()
  const rec = await z.recoveryDevice(world.code)
  const phone = client(await z.generateDevice(), 'Phone')
  const room = await z.createRoom({ device: phone.device, recovery: rec, time: T0 })
  world.roomId = room.roomId
  world.hub.log.push(room.entry)
  storeWraps(world, 1, room.wraps)
  await sync(phone, world)
  phone.secrets.set(1, room.secret)
  const laptop = await invite(world, phone, await z.generateDevice(), ROLE.HUMAN, 'Laptop')
  await sync(phone, world)
  const agent = await invite(world, phone, await z.generateDevice({ extractable: true }), ROLE.AGENT, 'Agent')
  await sync(phone, world)
  await sync(laptop, world)
  return { ...world, phone, laptop, agent }
}
/** Send from a client. Default: session scope, a chat item in the session's timeline. `keyScope: 0` for the room key (humans). */
async function send(world, from, opts = {}) {
  const kind = opts.kind ?? KIND.CHAT
  const room = opts.keyScope === 0
  const env = await z.sealEnvelope({
    device: from.device, state: from.state, chains: from.chains, kind, payload: utf8('hello'), time: T0,
    keyScope: room ? 0 : 1, sessionId: room ? null : SESSION_ID,
    secret: room ? from.secrets.get(from.state.epoch) : from.sessionSecrets.get(Math.max(...from.sessionSecrets.keys())),
    ...(z.isThreadKind(kind) ? { timelineKind: 1, timelineId: room ? `desk/${DESK}` : `session/${hex(SESSION_ID)}` } : {}),
    ...opts,
  })
  world.hub.envelopes.push(env.bytes)
  return env
}
const recv = (to, env, opts = {}) => z.openEnvelope(env.bytes ?? env, { state: to.state, chains: to.chains, secrets: secretsOf(to), self: to.device.id, ...opts })
/** Remove members: signer rotates, hub stores, the listed clients catch up. */
async function remove(world, signer, ids, others = [], cuts) {
  const prev = signer.secrets.get(signer.state.epoch)
  const r = await z.removeMembers(signer.state, signer.device, { ids, cuts, previous: prev, time: T0 })
  world.hub.log.push(r.entry)
  storeWraps(world, r.secret.epoch, r.wraps)
  world.hub.backLinks.set(r.secret.epoch, r.backLink)
  await sync(signer, world)
  signer.secrets.set(r.secret.epoch, r.secret)
  for (const c of others) { await sync(c, world); await fetchKey(c, world) }
  return r
}

// ---- encoding ------------------------------------------------------------------

group('encoding')
test('base64url round trip, RFC 4648 vectors, strict decoding', async () => {
  const cases = [['', ''], ['f', 'Zg'], ['fo', 'Zm8'], ['foo', 'Zm9v'], ['foob', 'Zm9vYg'], ['fooba', 'Zm9vYmE'], ['foobar', 'Zm9vYmFy']]
  for (const [plain, enc] of cases) { assert.equal(b64u(utf8(plain)), enc); assert.equal(txt(z.unb64u(enc)), plain) }
  assert.equal(b64u(Uint8Array.of(0xfb, 0xff)), '-_8')
  for (let n = 0; n < 70; n++) { const b = nodeCrypto.randomBytes(n); assert.deepEqual(Buffer.from(z.unb64u(b64u(b))), b); assert.equal(b64u(b), b.toString('base64url')) }
  for (const bad of ['Zg==', 'Z', 'Zh', 'Zm9=', 'Zm+v', 'Zm/v', 'Zm 9v', 'Zm9vY']) await rejects(() => z.unb64u(bad), 'bad-format')
})
test('recovery code: 52 Crockford characters in fours, canonical, forgiving on input', async () => {
  const code = z.generateRecoveryCode()
  assert.match(code, /^([0-9A-HJKMNP-TV-Z]{4}-){12}[0-9A-HJKMNP-TV-Z]{4}$/)
  const raw = z.parseRecoveryCode(code)
  assert.equal(z.formatRecoveryCode(raw), code)
  assert.deepEqual(z.parseRecoveryCode(code.toLowerCase().replace(/-/g, ' ')), raw)
  assert.deepEqual(z.parseRecoveryCode(z.formatRecoveryCode(fill(32, 0)).replace(/0/g, 'O')), fill(32, 0))
  assert.equal(z.formatRecoveryCode(fill(32, 0xff)).slice(-1), 'G')   // one data bit, four zero pad bits
  await rejects(() => z.parseRecoveryCode(code.slice(0, -1)), 'bad-recovery-code')
  await rejects(() => z.parseRecoveryCode(code.slice(0, -1) + 'U'), 'bad-recovery-code')
  await rejects(() => z.parseRecoveryCode(z.formatRecoveryCode(fill(32, 0xff)).slice(0, -1) + 'Z'), 'bad-recovery-code')
})
test('padding buckets', () => {
  assert.equal(z.paddedLength(1), 256); assert.equal(z.paddedLength(256), 256); assert.equal(z.paddedLength(257), 512)
  assert.equal(z.paddedLength(65536), 65536); assert.equal(z.paddedLength(65537), 131072); assert.equal(z.paddedLength(200000), 262144)
})
test('runtime probe finds every primitive', async () => {
  assert.deepEqual(await z.requireRuntime(), { ok: true, missing: [] })
})

// ---- identity, signatures, sealed box ------------------------------------------

group('identity')
test('generate, export public, sign, verify', async () => {
  const d = await z.generateDevice()
  assert.equal(d.signKey.extractable, false); assert.equal(d.kexKey.extractable, false)
  const pub = await z.decodeDevicePublic(z.encodeDevicePublic(d))
  assert.deepEqual(pub, z.publicDevice(d))
  const sig = await z.sign(d, 'test/label', utf8('message'))
  assert.equal(sig.length, 64)
  assert.equal(await z.verify(d.signPub, 'test/label', utf8('message'), sig), true)
  assert.equal(await z.verify(d.signPub, 'test/other', utf8('message'), sig), false, 'label is part of what is signed')
  assert.equal(await z.verify(d.signPub, 'test/label', utf8('messagf'), sig), false)
  assert.equal(await z.verify(d.signPub, 'test/label', utf8('message'), flip(sig, 5)), false)
  assert.equal(await z.verify((await z.generateDevice()).signPub, 'test/label', utf8('message'), sig), false)
  assert.equal(await z.verify(d.signPub, 'test/label', utf8('message'), sig.slice(1)), false)
  await rejects(() => z.exportDeviceSecret(d), 'not-extractable')
})
test('key file round trip for agents; seeds give the same device', async () => {
  const d = await z.generateDevice({ extractable: true })
  const file = await z.exportDeviceSecret(d)
  assert.equal(file.length, 66)
  const again = await z.importDeviceSecret(file)
  assert.deepEqual(z.publicDevice(again), z.publicDevice(d))
  assert.equal(await z.verify(d.signPub, 'l', utf8('m'), await z.sign(again, 'l', utf8('m'))), true)
  await rejects(() => z.importDeviceSecret(flip(file, 0, 1)), 'bad-version')
})
test('Ed25519 against RFC 8032 test 1 and node:crypto', async () => {
  const d = await z.deviceFromSeeds(unhex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'), fill(32, 1))
  assert.equal(hex(d.signPub), 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a')
  const sig = await z.sign(d, 'x', utf8('abc'))
  const key = nodeCrypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64u(d.signPub) }, format: 'jwk' })
  assert.equal(nodeCrypto.verify(null, concat(utf8('x'), Uint8Array.of(0), utf8('abc')), key, sig), true)
})

group('sealed box')
test('round trip, and an independent open with node:crypto', async () => {
  const bob = await z.deviceFromSeeds(fill(32, 3), fill(32, 4), { extractable: true })
  const sealed = await z.seal(bob.kexPub, utf8('secret'), utf8('where'))
  assert.equal(txt(await z.openSealed(bob, sealed, utf8('where'))), 'secret')
  assert.equal(sealed.length, 2 + 32 + 6 + 16)
  // The same steps with node:crypto, from FORMAT.md: X25519, HKDF(salt = eph || recipient), AES-256-GCM.
  const eph = sealed.slice(2, 34)
  const priv = nodeCrypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), fill(32, 4)]), format: 'der', type: 'pkcs8' })
  const shared = nodeCrypto.diffieHellman({ privateKey: priv, publicKey: nodeCrypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: b64u(eph) }, format: 'jwk' }) })
  const okm = Buffer.from(nodeCrypto.hkdfSync('sha256', shared, concat(eph, bob.kexPub), concat(utf8(z.LABEL.sealedBox), Uint8Array.of(0)), 44))
  const dec = nodeCrypto.createDecipheriv('aes-256-gcm', okm.subarray(0, 32), okm.subarray(32))
  dec.setAAD(utf8('where')); dec.setAuthTag(sealed.slice(-16))
  assert.equal(Buffer.concat([dec.update(sealed.slice(34, -16)), dec.final()]).toString(), 'secret')
})
test('tamper: every byte, wrong associated data, wrong recipient, low-order point', async () => {
  const bob = await z.generateDevice(), eve = await z.generateDevice()
  const sealed = await z.seal(bob.kexPub, utf8('secret'), utf8('aad'))
  for (let i = 0; i < sealed.length; i++) await rejects(() => z.openSealed(bob, flip(sealed, i), utf8('aad')), ['decrypt-failed', 'bad-version', 'bad-format', 'bad-key'])
  await rejects(() => z.openSealed(bob, sealed, utf8('aae')), 'decrypt-failed')
  await rejects(() => z.openSealed(bob, sealed), 'decrypt-failed')
  await rejects(() => z.openSealed(eve, sealed, utf8('aad')), 'decrypt-failed')
  await rejects(() => z.openSealed(bob, sealed.slice(0, 40), utf8('aad')), 'bad-format')
  await rejects(() => z.seal(new Uint8Array(32), utf8('x')), 'bad-key')
  const zeroPoint = concat(sealed.slice(0, 2), new Uint8Array(32), sealed.slice(34))
  await rejects(() => z.openSealed(bob, zeroPoint, utf8('aad')), 'bad-key')
  assert.notDeepEqual(await z.seal(bob.kexPub, utf8('secret'), utf8('aad')), sealed, 'fresh ephemeral key each time')
})

// ---- membership log ------------------------------------------------------------

group('membership log')
test('genesis: the room id is the hash of the genesis entry; the whole log verifies', async () => {
  const w = await makeWorld()
  assert.deepEqual(w.roomId, await z.hash(z.LABEL.logEntry, w.hub.log[0].slice(0, -64)))
  const state = await z.verifyLog(w.hub.log, w.roomId)
  assert.equal(state.head.seq, 2)
  assert.deepEqual(z.activeMembers(state).map(m => [who(m), m.role]), [['Phone', 1], ['Laptop', 1], ['Agent', 2]])
  assert.equal(state.epoch, 1)
  await rejects(() => z.verifyLog(w.hub.log, fill(32, 9)), 'wrong-room')
  await rejects(() => z.verifyLog([], w.roomId), 'bad-entry')
  await rejects(() => z.verifyLog(w.hub.log.slice(1), w.roomId), 'bad-entry')
})
test('forged entries: outsider, agent, removed device, recovery key outside a recovery', async () => {
  const w = await makeWorld()
  const mallory = await z.generateDevice()
  const victim = { role: ROLE.HUMAN, signPub: mallory.signPub, kexPub: mallory.kexPub }
  // The server signs with its own key but names the phone as signer.
  const forged = await z.addMember(w.phone.state, w.phone.device, { member: victim, time: T0 })
  const body = forged.entry.slice(0, -64)
  const resigned = concat(body, await z.sign(mallory, z.LABEL.logSig, body))
  await rejects(() => z.applyEntry(w.phone.state, resigned), 'bad-signature')
  // An outsider signs as itself, an agent signs as itself.
  await rejects(() => z.addMember(w.phone.state, mallory, { member: victim, time: T0 }), 'bad-entry')
  const e = await rejects(() => z.addMember(w.phone.state, w.agent.device, { member: victim, time: T0 }), 'bad-entry')
  assert.match(e.message, /agents may not/)
  await rejects(() => z.removeMembers(w.phone.state, w.agent.device, { ids: [w.laptop.device.id], previous: w.phone.secrets.get(1), time: T0 }), 'bad-entry')
  // A removed human device can no longer sign.
  await remove(w, w.phone, [w.laptop.device.id], [w.agent])
  await rejects(() => z.addMember(w.phone.state, w.laptop.device, { member: victim, time: T0 }), 'bad-entry')
  // and cannot come back under the same keys
  await rejects(() => z.addMember(w.phone.state, w.phone.device, { member: { role: ROLE.HUMAN, ...z.publicDevice(w.laptop.device) }, time: T0 }), 'bad-entry')
  // A valid entry does not fit at another position or in another room.
  await rejects(() => z.applyEntry(w.phone.state, w.hub.log[1]), 'bad-entry')
  const other = await makeWorld()
  await rejects(() => z.applyEntry(other.phone.state, forged.entry), 'bad-entry')
})
test('every flipped bit position in every entry is rejected', async () => {
  const w = await makeWorld()
  await remove(w, w.phone, [w.agent.device.id], [w.laptop])
  for (let n = 0; n < w.hub.log.length; n++) {
    const state = n ? await z.verifyLog(w.hub.log.slice(0, n)) : null
    const entry = w.hub.log[n]
    for (let i = 0; i < entry.length; i++) {
      if (n === 0) {
        // A changed genesis either fails on its own or yields another room id.
        let st = null
        try { st = await z.applyEntry(null, flip(entry, i)) } catch (e) { assert.ok(e instanceof z.ZError) }
        if (st) assert.notDeepEqual(st.roomId, w.roomId)
      } else {
        await rejects(() => z.applyEntry(state, flip(entry, i)), ['bad-signature', 'bad-entry', 'bad-format', 'bad-version'])
      }
    }
  }
})
test('rollback and fork against the pinned head', async () => {
  const w = await makeWorld()
  const pinned = w.laptop.pin
  assert.equal(z.checkLogAgainstPin(w.laptop.state, pinned).status, 'same')
  // Rolled back: the hub serves an older, perfectly valid prefix.
  const old = await z.verifyLog(w.hub.log.slice(0, 2), w.roomId)
  await rejects(() => z.checkLogAgainstPin(old, pinned), 'log-rollback')
  await rejects(() => sync(w.laptop, w, w.hub.log.slice(0, 1)), 'log-rollback')
  // Forked: two human devices each sign a different entry 3, the hub shows each device one of them.
  const a = await z.removeMembers(w.phone.state, w.phone.device, { ids: [w.agent.device.id], previous: w.phone.secrets.get(1), time: T0 })
  const b = await z.addMember(w.laptop.state, w.laptop.device, { member: { role: ROLE.AGENT, ...z.publicDevice(named(await z.generateDevice(), 'Other')) }, time: T0 })
  const logA = [...w.hub.log, a.entry], logB = [...w.hub.log, b.entry]
  assert.equal((await sync(w.phone, w, logA)).status, 'extended')
  const err = await rejects(() => sync(w.phone, w, logB), 'log-fork')
  assert.equal(err.forkSeq, 3)
  // The same with only { seq, hash } pinned.
  await rejects(async () => z.checkLogAgainstPin(await z.verifyLog(logB, w.roomId), { seq: 3, hash: a.state.head.hash }), 'log-fork')
  // A fork shows with the first message between the two devices.
  await sync(w.laptop, w, logB)
  w.phone.secrets.set(2, a.secret)
  const env = await send(w, w.laptop)
  await rejects(() => recv(w.phone, env), 'log-fork')
})
test('any human device changes members, there is no main device', async () => {
  const w = await makeWorld()
  // The laptop joined second. It adds a tablet, and the tablet removes the founding phone.
  const tablet = await invite(w, w.laptop, await z.generateDevice(), ROLE.HUMAN, 'Tablet')
  await sync(w.laptop, w)
  const r = await z.removeMembers(tablet.state, tablet.device, { ids: [w.phone.device.id], previous: tablet.secrets.get(1), time: T0 })
  assert.deepEqual(z.activeMembers(r.state).map(who), ['Laptop', 'Agent', 'Tablet'])
  assert.equal(r.state.epoch, 2)
  // The removed founder has no say left; the recovery key still stands above everyone.
  await rejects(() => z.removeMembers(r.state, w.phone.device, { ids: [tablet.device.id], previous: r.secret, time: T0 }), 'bad-entry')
  const rec = await z.recoverRoom({ state: r.state, code: w.code, newCode: z.generateRecoveryCode(), newDevice: await z.generateDevice(), recoveryWrap: r.wraps.at(-1).sealed, time: T0 })
  assert.deepEqual(z.activeMembers(rec.state).map(m => m.role), [ROLE.AGENT, ROLE.HUMAN])
})
test('the room key changes on removal only: there is no rotation entry', async () => {
  const w = await makeWorld()
  assert.equal(z.rotateEpoch, undefined)
  assert.deepEqual(Object.values(z.ENTRY).sort(), [1, 2, 3, 5])
  // The retired type 4 (a new epoch without a removal), correctly signed by a human device.
  const s = w.phone.state, next = z.newEpochSecret(2), c = await z.epochCommits(next)
  await rejects(async () => z.applyEntry(s, await handEntry(s, w.phone.device, 4, concat(be(2, 4), c.keyCommit, c.histCommit))), 'bad-format')
  // Adding a member does not change the key either.
  const added = await z.addMember(s, w.phone.device, { member: { role: ROLE.AGENT, ...z.publicDevice(named(await z.generateDevice(), 'Bot')) }, time: T0 })
  assert.equal(added.state.epoch, 1)
})
test('an invite id produces one member, once', async () => {
  const w = await makeWorld()
  const inviteId = w.phone.state.entries[1].inviteId
  await rejects(async () => z.addMember(w.phone.state, w.phone.device, { member: { role: ROLE.AGENT, ...z.publicDevice(named(await z.generateDevice(), 'Twin')) }, inviteId, time: T0 }), 'bad-entry')
})
test('a room cannot be founded without a recovery code', async () => {
  await rejects(async () => z.createRoom({ device: await z.generateDevice(), time: T0 }), 'recovery-required')
})
test('epoch bookkeeping: memberAt and epochAt follow the log', async () => {
  const w = await makeWorld()
  await remove(w, w.phone, [w.agent.device.id], [w.laptop])
  const s = w.phone.state
  assert.equal(z.epochAt(s, 2), 1); assert.equal(z.epochAt(s, 3), 2); assert.equal(s.epoch, 2)
  assert.ok(z.memberAt(s, w.agent.device.id, 2)); assert.equal(z.memberAt(s, w.agent.device.id, 3), null)
  assert.equal(z.memberAt(s, w.agent.device.id, 1), null, 'not yet added at entry 1')
})

// ---- invites -------------------------------------------------------------------

group('invite')
async function inviteSetup(role = ROLE.AGENT, now = T0) {
  const w = await makeWorld()
  const made = await z.createInvite({ state: w.phone.state, inviter: w.phone.device, hub: w.hubUrl, role, now })
  const device = await z.generateDevice()
  return { w, ...made, device }
}
test('link form and parsing', async () => {
  const { w, link, invite } = await inviteSetup()
  assert.match(link, /^https:\/\/app\.invalid\/join#v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/)
  const p = z.parseInviteLink(link)
  assert.equal(p.hub, w.hubUrl); assert.deepEqual(p.roomId, w.roomId); assert.deepEqual(p.secret, invite.secret)
  await rejects(() => z.parseInviteLink(link.replace('#v1.', '#v2.')), 'bad-version')
  await rejects(() => z.parseInviteLink(link.slice(0, -2)), ['bad-invite', 'bad-format'])
  await rejects(() => z.parseInviteLink('https://app.invalid/join'), 'bad-invite')
  assert.equal(invite.inviteId.length, 16)
  assert.ok(!link.includes(b64u(invite.inviteId)), 'the id the hub knows is derived from the secret, not in the link')
})
test('full flow: both sides show the same six digits; the new member opens the room key', async () => {
  const { w, link, offer, invite, device } = await inviteSetup(ROLE.HUMAN)
  const { request, join } = await z.createJoinRequest({ link, offer, log: w.hub.log, device, now: T0 })
  const { reveal, code, member } = await z.acceptJoinRequest({ invite, request, inviter: w.phone.device, now: T0 + MIN })
  assert.match(code, /^\d{6}$/)
  assert.equal(await z.checkReveal({ join, reveal, log: w.hub.log }), code)
  assert.deepEqual(member.id, device.id)
  const done = await z.finalizeInvite({ invite, state: w.phone.state, inviter: w.phone.device, secret: w.phone.secrets.get(1), codeConfirmed: true, now: T0 + 2 * MIN })
  const log = [...w.hub.log, done.entry]
  const joined = await z.completeJoin({ join, device, log, wrap: done.wrap })
  assert.deepEqual(joined.secret.key, w.phone.secrets.get(1).key)
  assert.ok(joined.secret.hist, 'a human device gets the history key')
  assert.deepEqual(joined.state.entries.at(-1).inviteId, invite.inviteId)
})
test('expired invite', async () => {
  const { w, link, offer, invite, device } = await inviteSetup()
  await rejects(() => z.createJoinRequest({ link, offer, log: w.hub.log, device, now: T0 + 11 * MIN }), 'invite-expired')
  const { request } = await z.createJoinRequest({ link, offer, log: w.hub.log, device, now: T0 })
  await rejects(() => z.acceptJoinRequest({ invite, request, inviter: w.phone.device, now: T0 + 10 * MIN + 1 }), 'invite-expired')
  assert.equal(invite.used, false)
  // In time for the request, but the human confirms too late.
  await z.acceptJoinRequest({ invite, request, inviter: w.phone.device, now: T0 + 10 * MIN })
  await rejects(() => z.finalizeInvite({ invite, state: w.phone.state, inviter: w.phone.device, secret: w.phone.secrets.get(1), codeConfirmed: true, now: T0 + 16 * MIN }), 'invite-expired')
})
test('reused invite: the second request and the second finalize are refused', async () => {
  const { w, link, offer, invite, device } = await inviteSetup()
  const first = await z.createJoinRequest({ link, offer, log: w.hub.log, device, now: T0 })
  await z.acceptJoinRequest({ invite, request: first.request, inviter: w.phone.device, now: T0 })
  const second = await z.createJoinRequest({ link, offer, log: w.hub.log, device: await z.generateDevice(), now: T0 })
  await rejects(() => z.acceptJoinRequest({ invite, request: second.request, inviter: w.phone.device, now: T0 }), 'invite-used')
  await rejects(() => z.acceptJoinRequest({ invite, request: first.request, inviter: w.phone.device, now: T0 }), 'invite-used')
  await z.finalizeInvite({ invite, state: w.phone.state, inviter: w.phone.device, secret: w.phone.secrets.get(1), codeConfirmed: true, now: T0 })
  await rejects(() => z.finalizeInvite({ invite, state: w.phone.state, inviter: w.phone.device, secret: w.phone.secrets.get(1), codeConfirmed: true, now: T0 }), 'invite-used')
})
test('check code: required for humans, can be skipped for agents only on request', async () => {
  for (const role of [ROLE.HUMAN, ROLE.AGENT]) {
    const { w, link, offer, invite, device } = await inviteSetup(role)
    const { request } = await z.createJoinRequest({ link, offer, log: w.hub.log, device, now: T0 })
    await z.acceptJoinRequest({ invite, request, inviter: w.phone.device, now: T0 })
    const args = { invite, state: w.phone.state, inviter: w.phone.device, secret: w.phone.secrets.get(1), now: T0 }
    await rejects(() => z.finalizeInvite(args), 'code-not-confirmed')
    if (role === ROLE.HUMAN) await rejects(() => z.finalizeInvite({ ...args, skipCheckCode: true }), 'code-not-confirmed')
    else await z.finalizeInvite({ ...args, skipCheckCode: true })
  }
})
test('a request cannot be finalized before it was accepted', async () => {
  const { w, invite } = await inviteSetup()
  await rejects(() => z.finalizeInvite({ invite, state: w.phone.state, inviter: w.phone.device, secret: w.phone.secrets.get(1), codeConfirmed: true, now: T0 }), 'bad-invite')
})
test('the code depends on every part of the exchange (commit, then reveal)', async () => {
  const { w, link, offer, invite, device } = await inviteSetup()
  const { request, join } = await z.createJoinRequest({ link, offer, log: w.hub.log, device, now: T0 })
  const { reveal, code } = await z.acceptJoinRequest({ invite, request, inviter: w.phone.device, now: T0 })
  // A reveal with another number does not match the commitment, even when the inviter itself signs it.
  const body = reveal.slice(0, -64)
  const other = body.slice(); other[2 + 16] ^= 1
  const resigned = concat(other, await z.sign(w.phone.device, z.LABEL.inviteRevealSig, other))
  await rejects(() => z.checkReveal({ join, reveal: resigned, log: w.hub.log }), 'bad-invite')
  for (let i = 0; i < reveal.length; i++) await rejects(() => z.checkReveal({ join, reveal: flip(reveal, i), log: w.hub.log }), ['bad-signature', 'bad-invite', 'bad-format', 'bad-version'])
  assert.equal(await z.checkReveal({ join, reveal, log: w.hub.log }), code)
})

// ---- room key epochs -----------------------------------------------------------

group('room key')
test('wrap per human device and the recovery key; agents get no room key at all (R6)', async () => {
  const w = await makeWorld()
  await fetchKey(w.laptop, w)
  assert.deepEqual(w.laptop.secrets.get(1).key, w.phone.secrets.get(1).key)
  assert.deepEqual(w.laptop.secrets.get(1).hist, w.phone.secrets.get(1).hist)
  assert.equal(w.agent.secrets.size, 0)
  assert.equal(w.hub.wraps.has(`1:${b64u(w.agent.device.id)}`), false)
  await rejects(() => z.wrapEpochKey(w.phone.state, w.phone.secrets.get(1), w.agent.device.id), 'bad-argument')
  assert.deepEqual((await z.wrapForAll(w.phone.state, w.phone.secrets.get(1))).map(x => b64u(x.id)).sort(), [w.phone.device.id, w.laptop.device.id, w.phone.state.recovery.id].map(b64u).sort())
  // An agent cannot send under the room key, and nobody accepts a room-scope envelope from an agent.
  await rejects(() => send(w, w.agent, { keyScope: 0, secret: w.phone.secrets.get(1) }), 'forbidden')
})
test('a wrap is bound to room, epoch and recipient; a substituted key fails the commitment', async () => {
  const w = await makeWorld()
  const mine = w.hub.wraps.get(`1:${b64u(w.laptop.device.id)}`)
  const phones = w.hub.wraps.get(`1:${b64u(w.phone.device.id)}`)
  await rejects(() => z.unwrapEpochKey(w.laptop.state, w.laptop.device, phones, 1), 'decrypt-failed')
  await rejects(() => z.unwrapEpochKey(w.laptop.state, w.laptop.device, mine, 2), 'decrypt-failed')
  const other = await makeWorld()
  await rejects(() => z.unwrapEpochKey(other.phone.state, w.laptop.device, mine, 1), 'decrypt-failed')
  // Anyone can seal. The hub seals its own key to the laptop, with the right associated data.
  const evil = z.newEpochSecret(1)
  const aad = concat(utf8(z.LABEL.epochWrap), Uint8Array.of(0), w.roomId, Uint8Array.of(0, 0, 0, 1), w.laptop.device.id)
  const planted = await z.seal(w.laptop.device.kexPub, concat(Uint8Array.of(2), evil.key, evil.hist), aad)
  await rejects(() => z.unwrapEpochKey(w.laptop.state, w.laptop.device, planted, 1), 'key-mismatch')
  // The right room key with a planted history key is refused as well.
  const half = await z.seal(w.laptop.device.kexPub, concat(Uint8Array.of(2), w.phone.secrets.get(1).key, evil.hist), aad)
  await rejects(() => z.unwrapEpochKey(w.laptop.state, w.laptop.device, half, 1), 'key-mismatch')
  await rejects(() => z.wrapEpochKey(w.phone.state, w.phone.secrets.get(1), fill(32, 7)), 'not-member')
})
test('rotation on removal: the removed member gets no wrap and cannot read the new epoch', async () => {
  const w = await makeWorld()
  const tablet = await invite(w, w.phone, await z.generateDevice(), ROLE.HUMAN, 'Tablet')
  await sync(w.phone, w); await sync(w.laptop, w)
  await fetchKey(w.laptop, w)
  const before = await send(w, w.phone, { keyScope: 0 })
  await recv(w.laptop, before)
  const r = await remove(w, w.phone, [w.laptop.device.id], [tablet])
  assert.equal(w.phone.state.epoch, 2)
  assert.deepEqual(r.wraps.map(x => b64u(x.id)).sort(), [w.phone.device.id, tablet.device.id, w.phone.state.recovery.id].map(b64u).sort())
  assert.notDeepEqual(r.secret.key, w.phone.secrets.get(1).key)
  const after = await send(w, w.phone, { keyScope: 0, payload: utf8('after the removal') })
  assert.equal(txt((await recv(tablet, before)).payload), 'hello')
  assert.equal(txt((await recv(tablet, after)).payload), 'after the removal')
  // The removed laptop: knows the new log, has no key for epoch 2.
  await sync(w.laptop, w)
  await rejects(() => fetchKey(w.laptop, w), 'no-key')
  await rejects(() => recv(w.laptop, after, { allowRemovedSender: true }), 'no-key')
  for (const x of r.wraps) await rejects(() => z.unwrapEpochKey(w.laptop.state, w.laptop.device, x.sealed, 2), ['decrypt-failed', 'not-member'])
  // Pretending its old key were the new one does not help.
  w.laptop.secrets.set(2, { ...w.laptop.secrets.get(1), epoch: 2 })
  await rejects(() => recv(w.laptop, after, { quarantine: false }), 'decrypt-failed')
  await rejects(() => z.openBackLink(w.laptop.state, w.laptop.secrets.get(1), r.backLink), ['wrong-epoch', 'decrypt-failed'])
  // It still reads what it had.
  assert.ok(w.laptop.chains.get(b64u(w.phone.device.id)).seq === 1)
  // And it can no longer send.
  await rejects(() => send(w, w.laptop, { keyScope: 0 }), 'not-member')
})
test('a new human reads old epochs through the back links; an agent holds no room key and cannot', async () => {
  const w = await makeWorld()
  const old = await send(w, w.phone, { keyScope: 0, payload: utf8('epoch one') })
  // Two removals, so two new room keys: epochs 2 and 3.
  await remove(w, w.phone, [w.agent.device.id])
  const temp = await invite(w, w.phone, await z.generateDevice(), ROLE.AGENT, 'Temp')
  await sync(w.phone, w)
  await remove(w, w.phone, [temp.device.id])
  assert.equal(w.phone.state.epoch, 3)

  const tablet = await invite(w, w.phone, await z.generateDevice(), ROLE.HUMAN, 'Tablet')
  await sync(w.phone, w)
  const bot = await invite(w, w.phone, await z.generateDevice(), ROLE.AGENT, 'Bot')
  assert.deepEqual([...tablet.secrets.keys()], [3])
  await rejects(() => recv(tablet, old), 'no-key')
  const s2 = await z.openBackLink(tablet.state, tablet.secrets.get(3), w.hub.backLinks.get(3))
  const s1 = await z.openBackLink(tablet.state, s2, w.hub.backLinks.get(2))
  tablet.secrets.set(2, s2); tablet.secrets.set(1, s1)
  assert.equal(txt((await recv(tablet, old)).payload), 'epoch one')
  // The agent holds no room key. The hub hands it every back link and every wrap: nothing opens.
  assert.equal(bot.secrets.size, 0)
  for (const sealed of w.hub.wraps.values()) for (const ep of [1, 2, 3]) await rejects(() => z.unwrapEpochKey(bot.state, { ...bot.device, id: tablet.device.id }, sealed, ep), ['decrypt-failed'])
  await rejects(() => recv(bot, old), 'no-key')
  // Back links are bound to their place.
  await rejects(() => z.openBackLink(tablet.state, tablet.secrets.get(3), w.hub.backLinks.get(2)), 'wrong-epoch')
  await rejects(() => z.openBackLink(tablet.state, tablet.secrets.get(3), flip(w.hub.backLinks.get(3), 20)), 'decrypt-failed')
})
test('per-sender keys differ by sender, epoch and room, and match plain HKDF', async () => {
  const s = { epoch: 4, key: fill(32, 1), hist: null }
  const a = await z.deriveSenderKey(fill(32, 2), s, fill(32, 3))
  assert.notDeepEqual(a, await z.deriveSenderKey(fill(32, 2), s, fill(32, 4)))
  assert.notDeepEqual(a, await z.deriveSenderKey(fill(32, 2), { ...s, epoch: 5 }, fill(32, 3)))
  assert.notDeepEqual(a, await z.deriveSenderKey(fill(32, 9), s, fill(32, 3)))
  const info = concat(utf8('trommi/v1/sender-key'), Uint8Array.of(0, 0, 0, 0, 0, 4), fill(32, 3))
  assert.deepEqual(Buffer.from(a), Buffer.from(nodeCrypto.hkdfSync('sha256', fill(32, 1), fill(32, 2), info, 32)))
  // Session scope: scope byte 1 and the session id are in the context; another session gives another key.
  const sk = await z.deriveSenderKey(fill(32, 2), s, fill(32, 3), { keyScope: 1, sessionId: fill(16, 6) })
  const sinfo = concat(utf8('trommi/v1/sender-key'), Uint8Array.of(0, 1), fill(16, 6), Uint8Array.of(0, 0, 0, 4), fill(32, 3))
  assert.deepEqual(Buffer.from(sk), Buffer.from(nodeCrypto.hkdfSync('sha256', fill(32, 1), fill(32, 2), sinfo, 32)))
  assert.notDeepEqual(sk, await z.deriveSenderKey(fill(32, 2), s, fill(32, 3), { keyScope: 1, sessionId: fill(16, 7) }))
  assert.notDeepEqual(sk, a)
})

// ---- envelope ------------------------------------------------------------------

group('envelope')
test('round trip, header fields, padding, an independent decrypt with node:crypto', async () => {
  const w = await makeWorld()
  const cardId = fill(16, 0xc1), blob = fill(16, 0xb1)
  const env = await send(w, w.phone, { kind: KIND.CARD, payload: utf8('{"title":"Deploy?"}'), recipient: null, card: { id: cardId, state: 1 }, blobs: [blob], push: true, time: T0 + 5 })
  const got = await recv(w.laptop, env)
  assert.equal(got.kind, KIND.CARD); assert.equal(txt(got.payload), '{"title":"Deploy?"}')
  assert.deepEqual(got.header.card, { id: cardId, state: 1, urgency: 1, answeredAt: 0 }); assert.deepEqual(got.header.blobs, [blob])
  assert.equal(got.header.push, true); assert.equal(got.header.seq, 1); assert.equal(got.header.time, T0 + 5)
  assert.equal(got.forMe, true); assert.equal(who(got.member), 'Phone'); assert.deepEqual(got.hash, env.hash)
  const p = z.peekEnvelope(env.bytes)
  assert.equal(p.ciphertext.length, 256 + 16, 'short messages are padded to 256 bytes')
  assert.ok(!includesBytes(env.bytes, utf8('Deploy')))
  // FORMAT.md by hand: sender key, AES-256-GCM with the header as associated data, hash, signature.
  const key = await z.deriveSenderKey(w.roomId, SESSION_SECRET, w.phone.device.id, { keyScope: 1, sessionId: SESSION_ID })
  const dec = nodeCrypto.createDecipheriv('aes-256-gcm', key, p.nonce)
  dec.setAAD(p.headerBytes); dec.setAuthTag(p.ciphertext.slice(-16))
  const plain = Buffer.concat([dec.update(p.ciphertext.slice(0, -16)), dec.final()])
  // v1.1 body: version, bind (empty), payload; the kind is in the header only.
  assert.equal(plain.subarray(0, 3).toString('hex'), '010000'); assert.equal(plain.readUInt32BE(3), 19)
  assert.equal(plain.subarray(7, 26).toString(), '{"title":"Deploy?"}'); assert.ok(plain.subarray(26).every(b => b === 0))
  assert.equal(p.header.keyScope, 1); assert.deepEqual(p.header.sessionId, SESSION_ID); assert.equal(p.header.kind, KIND.CARD)
  const h = nodeCrypto.createHash('sha256').update(concat(utf8('trommi/v1/envelope'), Uint8Array.of(0), p.headerBytes, p.nonce, nodeCrypto.createHash('sha256').update(p.ciphertext).digest())).digest()
  assert.deepEqual(Buffer.from(env.hash), h)
  assert.equal(await z.verify(w.phone.device.signPub, z.LABEL.envelopeSig, h, p.signature), true)
  // Large payloads and empty payloads.
  const big = nodeCrypto.randomBytes(100000)
  assert.deepEqual(Buffer.from((await recv(w.laptop, await send(w, w.phone, { payload: big }))).payload), big)
  assert.equal((await recv(w.laptop, await send(w, w.phone, { payload: new Uint8Array(0) }))).payload.length, 0)
})
test('a flipped bit anywhere (version, header, nonce, ciphertext, tag, signature) is rejected', async () => {
  const w = await makeWorld()
  const env = await send(w, w.phone, { kind: KIND.CARD, card: { id: fill(16, 1), state: 1 }, blobs: [fill(16, 2)] })
  const codes = new Set()
  for (let i = 0; i < env.bytes.length; i++) {
    const e = await rejects(() => recv(w.laptop, flip(env.bytes, i, i % 8)), ['bad-signature', 'bad-format', 'bad-version', 'wrong-room', 'log-behind', 'log-fork', 'not-member', 'wrong-epoch'])
    codes.add(e.code)
  }
  assert.ok(codes.has('bad-signature') && codes.has('wrong-room') && codes.has('bad-version'))
  await rejects(() => recv(w.laptop, env.bytes.slice(0, -1)), 'bad-format')
  await rejects(() => recv(w.laptop, concat(env.bytes, Uint8Array.of(0))), 'bad-format')
  assert.equal(w.laptop.chains.size, 0, 'nothing was accepted')
  await recv(w.laptop, env)
})
/** Header offsets (v1.1): room scope has no session id; session scope 16 bytes more after the scope byte. */
const LOGSEQ_AT = scope => 2 + 32 + 4 + 1 + (scope === 1 ? 16 : 0) + 32 + 8 + 32
/** Build an envelope by hand, as an attacker who holds the scope key would. Default: the world's session key. */
async function craft(w, signer, headerBytes, senderId, body, { room = false, epoch = 1, nonce = fill(12, 9) } = {}) {
  const key = room ? await z.deriveSenderKey(w.roomId, signer.secrets.get(epoch), senderId)
    : await z.deriveSenderKey(w.roomId, SESSION_SECRET, senderId, { keyScope: 1, sessionId: SESSION_ID })
  const c = nodeCrypto.createCipheriv('aes-256-gcm', key, nonce)
  c.setAAD(headerBytes)
  const ct = concat(c.update(body), c.final(), c.getAuthTag())
  const h = await z.hash(z.LABEL.envelope, headerBytes, nonce, await z.sha256(ct))
  const len = b => Uint8Array.of(b.length >>> 24, (b.length >>> 16) & 255, (b.length >>> 8) & 255, b.length & 255)
  return concat(Uint8Array.of(1, 2, headerBytes.length >> 8, headerBytes.length & 255), headerBytes, nonce, len(ct), ct, await z.sign(signer.device, z.LABEL.envelopeSig, h))
}
const bodyOf = text => { const b = new Uint8Array(256); b.set(concat(Uint8Array.of(1, 0, 0, 0, 0, 0, text.length), utf8(text))); return b }
test('wrong sender key: a member who holds the scope key cannot speak as another member', async () => {
  const w = await makeWorld()
  const real = await send(w, w.phone)
  const p = z.peekEnvelope(real.bytes)
  // The agent derives the phone's sender key (it can), encrypts a new body under the phone's header, signs with its own key.
  const forged = await craft(w, w.agent, p.headerBytes, w.phone.device.id, bodyOf('rm -rf'))
  await rejects(() => recv(w.laptop, forged), 'bad-signature')
  // The same construction signed by the phone goes through: the test builds valid envelopes.
  const honest = await craft(w, w.phone, p.headerBytes, w.phone.device.id, bodyOf('fine'))
  assert.equal(txt((await recv(w.laptop, honest)).payload), 'fine')
  // An outsider's signature on the real envelope.
  const mallory = await z.generateDevice()
  const swapped = concat(real.bytes.slice(0, -64), await z.sign(mallory, z.LABEL.envelopeSig, real.hash))
  await rejects(() => recv(w.agent, swapped), 'bad-signature')
})
test('associated data: ciphertext moved under another header fails even when the sender signs it', async () => {
  const w = await makeWorld()
  const a = await send(w, w.phone, { payload: utf8('to the agent'), recipient: w.agent.device.id })
  const b = await send(w, w.phone, { payload: utf8('second') })
  const pa = z.peekEnvelope(a.bytes), pb = z.peekEnvelope(b.bytes)
  // Header of b, ciphertext and nonce of a, freshly and validly signed by the phone itself.
  const h = await z.hash(z.LABEL.envelope, pb.headerBytes, pa.nonce, await z.sha256(pa.ciphertext))
  const mixed = concat(b.bytes.slice(0, 4 + pb.headerBytes.length), pa.nonce, a.bytes.slice(4 + pa.headerBytes.length + 12, -64), await z.sign(w.phone.device, z.LABEL.envelopeSig, h))
  await recv(w.laptop, a)
  await rejects(() => recv(w.laptop, mixed, { quarantine: false }), 'decrypt-failed')
  assert.equal(w.laptop.chains.get(b64u(w.phone.device.id)).seq, 1, 'a refused decryption does not advance the chain')
  // Wrong sender key under a valid signature: encrypted with the laptop's key, claimed and signed by the phone.
  const wrongKey = await craft(w, { device: w.phone.device, secrets: w.phone.secrets }, pb.headerBytes, w.laptop.device.id, bodyOf('x'))
  await rejects(() => recv(w.laptop, wrongKey, { quarantine: false }), 'decrypt-failed')
  await recv(w.laptop, b)
})
test('non-zero padding and unknown versions inside the ciphertext are refused', async () => {
  const w = await makeWorld()
  const p = z.peekEnvelope((await send(w, w.phone)).bytes)
  const q = { quarantine: false }
  const dirty = bodyOf('hi'); dirty[255] = 1
  await rejects(async () => recv(w.laptop, await craft(w, w.phone, p.headerBytes, w.phone.device.id, dirty), q), 'bad-format')
  const v2 = bodyOf('hi'); v2[0] = 2
  await rejects(async () => recv(w.laptop, await craft(w, w.phone, p.headerBytes, w.phone.device.id, v2), q), 'bad-version')
  // Strict decoding (C18): the padded length must be exactly the bucket of the body, and no BOM leads the payload.
  const long = new Uint8Array(512); long.set(bodyOf('hi').slice(0, 9))
  await rejects(async () => recv(w.laptop, await craft(w, w.phone, p.headerBytes, w.phone.device.id, long), q), 'bad-format')
  const bom = new Uint8Array(256); bom.set(concat(Uint8Array.of(1, 0, 0, 0, 0, 0, 5), Uint8Array.of(0xef, 0xbb, 0xbf), utf8('hi')))
  await rejects(async () => recv(w.laptop, await craft(w, w.phone, p.headerBytes, w.phone.device.id, bom), q), 'bad-format')
  await rejects(() => send(w, w.phone, { payload: concat(Uint8Array.of(0xef, 0xbb, 0xbf), utf8('{}')) }), 'bad-argument')
})
test('poison body (C17): a valid signature with a broken body advances the chain, is quarantined, and the sender keeps going', async () => {
  const w = await makeWorld()
  const a = await send(w, w.phone)
  const p = z.peekEnvelope(a.bytes)
  const dirty = bodyOf('hi'); dirty[255] = 1
  const poison = await craft(w, w.phone, p.headerBytes, w.phone.device.id, dirty)
  const got = await recv(w.laptop, poison)
  assert.equal(got.quarantined, 'bad-format'); assert.equal(got.payload, null)
  // (In real life the poison is the sender's own envelope 1; the test makes the phone's chain agree.)
  const own = w.phone.chains.get(b64u(w.phone.device.id)); own.hash = got.hash; own.hashes.set(1, got.hash)
  assert.equal(w.laptop.chains.get(b64u(w.phone.device.id)).seq, 1)
  await rejects(() => z.authoriseCommand(got, { state: w.laptop.state, agentId: w.laptop.device.id }), 'not-a-command')
  // The next real envelope of the phone is number 2 and opens: the room does not stall.
  const b = await send(w, w.phone, { payload: utf8('still here') })
  assert.equal(txt((await recv(w.laptop, b)).payload), 'still here')
})
test('replayed message', async () => {
  const w = await makeWorld()
  const a = await send(w, w.phone), b = await send(w, w.phone)
  await recv(w.laptop, a); await recv(w.laptop, b)
  await rejects(() => recv(w.laptop, a), 'replay')
  await rejects(() => recv(w.laptop, b), 'replay')
})
test('dropped message: the gap names what is missing', async () => {
  const w = await makeWorld()
  const [a, b, c] = [await send(w, w.phone), await send(w, w.phone), await send(w, w.phone)]
  await recv(w.laptop, a)
  const e = await rejects(() => recv(w.laptop, c), 'gap')
  assert.equal(e.have, 1); assert.equal(e.got, 3)
  await recv(w.laptop, b); await recv(w.laptop, c)
  // A device that never saw the sender refuses to start in the middle, unless told to.
  await rejects(() => recv(w.agent, b), 'gap')
})
test('reordered messages', async () => {
  const w = await makeWorld()
  const [a, b, c] = [await send(w, w.phone), await send(w, w.phone), await send(w, w.phone)]
  await rejects(() => recv(w.laptop, b), 'gap')
  await recv(w.laptop, a)
  await rejects(() => recv(w.laptop, c), 'gap')
  await recv(w.laptop, b); await recv(w.laptop, c)
  await rejects(() => recv(w.laptop, a), 'replay')
})
test('spliced chain: same number, other history', async () => {
  const w = await makeWorld()
  const a = await send(w, w.phone)
  // The phone's state is duplicated (two tabs, restored profile): two different envelopes 2, and a 3 on each.
  const twin = { ...w.phone, chains: new Map([...w.phone.chains].map(([k, c]) => [k, { ...c, hashes: new Map(c.hashes) }])) }
  const b1 = await send(w, w.phone, { payload: utf8('branch one') }), c1 = await send(w, w.phone)
  const b2 = await send(w, twin, { payload: utf8('branch two') }), c2 = await send(w, twin)
  await recv(w.laptop, a); await recv(w.laptop, b1)
  await rejects(() => recv(w.laptop, c2), 'chain-break')     // 3 of the other branch does not fit onto 2 of this one
  await rejects(() => recv(w.laptop, b2), 'equivocation')    // two envelopes with number 2
  await recv(w.laptop, c1)
  // Another device took the other branch. The first envelope that names what it saw exposes the split.
  await fetchKey(w.agent, w)
  await recv(w.agent, a); await recv(w.agent, b2); await recv(w.agent, c2)
  const fromAgent = await send(w, w.agent)
  await rejects(() => recv(w.laptop, fromAgent), 'equivocation')
})
test('splice across rooms, epochs and senders', async () => {
  const w = await makeWorld()
  const env = await send(w, w.phone)
  // Another room with the very same devices and the very same room key.
  const rec = await z.recoveryDevice(z.generateRecoveryCode())
  const room2 = await z.createRoom({ device: w.phone.device, recovery: rec, time: T0 })
  const chains2 = z.newChains()
  const sessionKey = () => SESSION_SECRET
  await rejects(() => z.openEnvelope(env.bytes, { state: room2.state, chains: chains2, secrets: sessionKey }), 'wrong-room')
  // Rewriting the room id in the header breaks the signature; re-signing as the phone breaks the key.
  const p = z.peekEnvelope(env.bytes)
  const at = LOGSEQ_AT(1)
  const moved = p.headerBytes.slice(); moved.set(room2.roomId, 2); moved.set(Uint8Array.of(0, 0, 0, 0), at); moved.set(room2.state.head.hash, at + 4)
  const h = await z.hash(z.LABEL.envelope, moved, p.nonce, await z.sha256(p.ciphertext))
  const resigned = concat(env.bytes.slice(0, 4), moved, env.bytes.slice(4 + moved.length, -64), await z.sign(w.phone.device, z.LABEL.envelopeSig, h))
  await rejects(() => z.openEnvelope(resigned, { state: room2.state, chains: chains2, secrets: sessionKey, quarantine: false }), 'decrypt-failed')
  // An old-epoch envelope cannot be passed off as one of the new epoch.
  await recv(w.laptop, env)
  await remove(w, w.phone, [w.agent.device.id], [w.laptop])
  const epochField = 2 + 32
  const relabelled = flip(env.bytes, 4 + epochField + 3, 1)   // epoch 1 -> 3
  await rejects(() => recv(w.laptop, relabelled), ['wrong-epoch', 'bad-signature'])
})
test('seen: a withheld tail shows as soon as anyone who saw it speaks', async () => {
  const w = await makeWorld()
  await fetchKey(w.agent, w)
  const a = await send(w, w.phone), b = await send(w, w.phone, { payload: utf8('held back from the laptop') })
  await recv(w.laptop, a)
  await recv(w.agent, a); await recv(w.agent, b)
  const fromAgent = await send(w, w.agent)
  const got = await recv(w.laptop, fromAgent)
  assert.equal(got.withheld.length, 1)
  assert.deepEqual(got.withheld[0], { sender: w.phone.device.id, have: 1, seen: 2 })
  assert.equal((await recv(w.phone, fromAgent)).withheld.length, 0)
})
test('pruned envelopes (ciphertext deleted after 30 days) still verify and keep the chain', async () => {
  const w = await makeWorld()
  const [a, b, c] = [await send(w, w.phone), await send(w, w.phone), await send(w, w.phone, { payload: utf8('still here') })]
  const pa = await z.pruneEnvelope(a.bytes), pb = await z.pruneEnvelope(b.bytes)
  assert.ok(pa.length < 340, `pruned size ${pa.length}`)
  await rejects(() => recv(w.laptop, pa), 'pruned')
  const v = await z.verifyEnvelope(pa, { state: w.laptop.state, chains: w.laptop.chains })
  assert.deepEqual(v.hash, a.hash); assert.equal(v.pruned, true)
  for (let i = 0; i < pb.length; i++) await rejects(() => z.verifyEnvelope(flip(pb, i), { state: w.laptop.state, chains: w.laptop.chains }), ['bad-signature', 'bad-format', 'bad-version', 'wrong-room', 'log-behind', 'log-fork', 'not-member', 'wrong-epoch', 'gap', 'replay'])
  await z.verifyEnvelope(pb, { state: w.laptop.state, chains: w.laptop.chains })
  assert.equal(txt((await recv(w.laptop, c)).payload), 'still here')
})
test('kind, key scope and timeline are in the signed header; the grammar is strict', async () => {
  const w = await makeWorld()
  const head = await send(w, w.phone, { kind: KIND.STATUS })
  const item = await send(w, w.phone)
  const ph = z.peekEnvelope(head.bytes).header, pi = z.peekEnvelope(item.bytes).header
  assert.equal(ph.isHead, true); assert.equal(pi.isHead, false)
  assert.equal(ph.kind, KIND.STATUS); assert.equal(pi.kind, KIND.TIMELINE_ITEM)
  assert.deepEqual([pi.timelineKind, pi.timelineId], [1, `session/${hex(SESSION_ID)}`])
  assert.equal(ph.timelineId, null)
  // The kind is under the signature.
  const kindAt = 4 + LOGSEQ_AT(1) + 4 + 32 + 32 + 8
  assert.equal(head.bytes[kindAt], KIND.STATUS)
  const otherKind = head.bytes.slice(); otherKind[kindAt] = KIND.VERDICT
  await rejects(() => recv(w.laptop, otherKind), ['bad-format', 'bad-signature'])
  const status2 = head.bytes.slice(); status2[kindAt] = 8
  await rejects(async () => z.peekEnvelope(status2), 'bad-format')
  // Grammar: a thread item needs a canonical timeline and no object block; heads have no timeline; objects need the block.
  await rejects(() => send(w, w.phone, { timelineKind: null, timelineId: null }), 'bad-argument')
  await rejects(() => send(w, w.phone, { kind: KIND.STATUS, timelineKind: 1, timelineId: `desk/${DESK}` }), 'bad-argument')
  await rejects(() => send(w, w.phone, { card: { id: fill(16, 1), state: 1 } }), 'bad-argument')
  await rejects(() => send(w, w.phone, { kind: KIND.ANSWER }), 'bad-argument')
  for (const bad of ['session/test', `session/${hex(SESSION_ID).toUpperCase()}`, `card/${'a'.repeat(31)}`, `room/${'a'.repeat(32)}`, ` card/${'a'.repeat(32)}`]) await rejects(() => send(w, w.phone, { timelineId: bad }), 'bad-argument')
  // A session's timeline under that session's key only; a desk under the room key only.
  await rejects(() => send(w, w.phone, { timelineId: `session/${'ab'.repeat(16)}` }), 'bad-argument')
  await rejects(() => send(w, w.phone, { timelineId: `desk/${DESK}` }), 'bad-argument')
  await fetchKey(w.laptop, w)
  const desk = await send(w, w.phone, { keyScope: 0 })
  assert.equal(z.peekEnvelope(desk.bytes).header.timelineId, `desk/${DESK}`)
  await rejects(() => send(w, w.phone, { keyScope: 0, timelineId: `session/${hex(SESSION_ID)}` }), 'bad-argument')
  // Unknown flag bits are refused.
  const flagAt = 4 + 1
  for (const bit of [2, 3, 4, 5, 6, 7]) await rejects(async () => z.peekEnvelope(flip(item.bytes, flagAt, bit)), 'bad-format')
  assert.equal(txt((await recv(w.laptop, head)).payload), 'hello')
  assert.equal(txt((await recv(w.laptop, item)).payload), 'hello')
  assert.equal(txt((await recv(w.laptop, desk)).payload), 'hello')
  // Only senders active at the named log state may appear in seen, at most 64 (R5).
  assert.ok(z.peekEnvelope((await send(w, w.laptop)).bytes).header.seen.length <= z.SEEN_MAX)
})
test('a thread item verified in its pruned form opens later only as exactly that envelope', async () => {
  const w = await makeWorld()
  const a = await send(w, w.phone, { payload: utf8('thread item') })
  const b = await send(w, w.phone, { payload: utf8('next') })
  // At sync time the laptop gets the pruned form of a: the chain verifies and advances.
  const v = await z.verifyEnvelope(await z.pruneEnvelope(a.bytes), { state: w.laptop.state, chains: w.laptop.chains })
  assert.deepEqual(v.ciphertextHash, await z.sha256(z.peekEnvelope(a.bytes).ciphertext))
  assert.equal(txt((await recv(w.laptop, b)).payload), 'next')
  // Later the thread is opened: the full a, checked against the hash the chain accepted.
  const opened = await z.openVerifiedEnvelope(a.bytes, { state: w.laptop.state, secrets: secretsOf(w.laptop), envelopeHash: v.hash, self: w.laptop.device.id })
  assert.equal(txt(opened.payload), 'thread item')
  assert.equal(opened.kind, KIND.CHAT)
  assert.equal(w.laptop.chains.get(b64u(w.phone.device.id)).seq, 2)
  // Another envelope of the same sender, any flipped bit, a pruned form: refused.
  await rejects(() => z.openVerifiedEnvelope(b.bytes, { state: w.laptop.state, secrets: secretsOf(w.laptop), envelopeHash: v.hash }), 'hash-mismatch')
  for (let i = 2; i < a.bytes.length; i += 7) await rejects(() => z.openVerifiedEnvelope(flip(a.bytes, i), { state: w.laptop.state, secrets: secretsOf(w.laptop), envelopeHash: v.hash }), ['hash-mismatch', 'bad-signature', 'bad-format', 'bad-version', 'wrong-room'])
  await rejects(async () => z.openVerifiedEnvelope(await z.pruneEnvelope(a.bytes), { state: w.laptop.state, secrets: secretsOf(w.laptop), envelopeHash: v.hash }), 'pruned')
  await rejects(() => z.openVerifiedEnvelope(a.bytes, { state: w.laptop.state, secrets: new Map(), envelopeHash: v.hash }), 'no-key')
  // The parts a hub keeps in columns give back the same bytes, full and pruned.
  const p = z.peekEnvelope(a.bytes)
  assert.deepEqual(z.joinEnvelope({ headerBytes: p.headerBytes, nonce: p.nonce, ciphertext: p.ciphertext, signature: p.signature }), a.bytes)
  assert.deepEqual(z.joinEnvelope({ headerBytes: p.headerBytes, nonce: p.nonce, ciphertextHash: v.ciphertextHash, signature: p.signature }), await z.pruneEnvelope(a.bytes))
})
test('membership at the named log state: not yet a member, removed since, log behind', async () => {
  const w = await makeWorld()
  await fetchKey(w.agent, w)
  // The agent claims a log state from before it was added.
  const p = z.peekEnvelope((await send(w, w.agent)).bytes)
  const early = p.headerBytes.slice()
  const logSeqAt = LOGSEQ_AT(1)
  early[logSeqAt + 3] = 1; early.set(w.phone.state.hashes[1], logSeqAt + 4)
  await rejects(async () => recv(w.laptop, await craft(w, w.agent, early, w.agent.device.id, bodyOf('x'))), 'not-member')
  // The phone removes the laptop; the agent has not heard of it yet.
  const stale = await send(w, w.laptop)
  await remove(w, w.phone, [w.laptop.device.id], [], { [hex(w.laptop.device.id)]: { seq: 1, hash: stale.hash } })
  const fresh = await send(w, w.phone)
  const e = await rejects(() => recv(w.agent, fresh), 'log-behind')
  assert.equal(e.logSeq, 3)
  await sync(w.agent, w); await fetchKey(w.agent, w)
  assert.equal(txt((await recv(w.agent, fresh)).payload), 'hello')
  // The removed laptop: what it sent before is refused by default and readable as history on request.
  await rejects(() => recv(w.agent, stale), 'removed-sender')
  const hist = await recv(w.agent, stale, { allowRemovedSender: true })
  assert.equal(hist.removedNow, true); assert.equal(hist.epochCurrent, null)
  // Still on its old log it keeps sending; everyone who knows better refuses, also as history: it is beyond the cut (R3).
  const beyond = await send(w, w.laptop)
  await rejects(() => recv(w.agent, beyond), 'removed-sender')
  await rejects(() => recv(w.agent, beyond, { allowRemovedSender: true }), 'removed-sender')
  await sync(w.laptop, w)
  await rejects(() => send(w, w.laptop), 'not-member')
})

test('urgency and card status are readable on the outside, signed, and nothing else is', async () => {
  const w = await makeWorld()
  const cardId = fill(16, 0xc7)
  const env = await send(w, w.phone, { kind: KIND.CARD, payload: utf8('{"title":"Wire the money?"}'), card: { id: cardId, state: z.CARD_STATE.OPEN, urgency: z.URGENCY.CRITICAL }, push: true })
  // What the hub does: no key, no verification, just the header.
  const seen = z.peekEnvelope(env.bytes).header
  assert.deepEqual(seen.card, { id: cardId, state: 1, urgency: 3, answeredAt: 0 })
  assert.ok(!includesBytes(env.bytes, utf8('Wire')))
  // The hub cannot lower or raise it: the header is under the signature and is the associated data.
  const at = 4 + z.peekEnvelope(env.bytes).headerBytes.length - 1 - 8 - 1   // urgency: before answeredAt and the blob count
  assert.equal(env.bytes[at], 3)
  const lowered = env.bytes.slice(); lowered[at] = 0
  await rejects(() => recv(w.laptop, lowered), 'bad-signature')
  const answered = await send(w, w.phone, { kind: KIND.ANSWER, card: { id: cardId, state: z.CARD_STATE.ANSWERED, urgency: z.URGENCY.CRITICAL, answeredAt: T0 + 9 } })
  assert.deepEqual(z.peekEnvelope(await z.pruneEnvelope(answered.bytes)).header.card, { id: cardId, state: 2, urgency: 3, answeredAt: T0 + 9 })
  await rejects(() => send(w, w.phone, { card: { id: cardId, state: 1, urgency: 4 } }), 'bad-argument')
  await rejects(() => send(w, w.phone, { card: { id: cardId, state: 0 } }), 'bad-argument')
  const unknown = env.bytes.slice(); unknown[at] = 9
  await rejects(() => z.peekEnvelope(unknown), 'bad-format')
})

// ---- signing in to the hub -----------------------------------------------------

group('hub sign-in')
test('a member signs the hub\'s challenge; removed devices, other rooms, other hubs and outsiders are refused', async () => {
  const w = await makeWorld()
  const challenge = fill(32, 0x5c)
  const sign = (device, over = {}) => z.signHubAuth({ device, roomId: w.roomId, hub: w.hubUrl, challenge, ...over })
  const state = w.phone.state
  const ok = await z.verifyHubAuth(await sign(w.agent.device), { state, hub: w.hubUrl })
  assert.equal(ok.kind, 'member'); assert.equal(who(ok.member), 'Agent'); assert.deepEqual(ok.challenge, challenge)
  const rec = await z.verifyHubAuth(await sign(await z.recoveryDevice(w.code)), { state, hub: w.hubUrl })
  assert.equal(rec.kind, 'recovery')
  await rejects(async () => z.verifyHubAuth(await sign(await z.generateDevice()), { state, hub: w.hubUrl }), 'not-member')
  await rejects(async () => z.verifyHubAuth(await sign(w.phone.device), { state, hub: 'https://other.example' }), 'wrong-hub')
  await rejects(async () => z.verifyHubAuth(await sign(w.phone.device, { roomId: fill(32, 1) }), { state, hub: w.hubUrl }), 'wrong-room')
  // One member's signature under another member's id.
  const mine = await sign(w.laptop.device)
  const forged = concat(mine.slice(0, -64 - 64), w.phone.device.id, mine.slice(-64 - 32))
  await rejects(() => z.verifyHubAuth(forged, { state, hub: w.hubUrl }), 'bad-signature')
  for (let i = 0; i < mine.length; i += 3) await rejects(() => z.verifyHubAuth(flip(mine, i), { state, hub: w.hubUrl }), ['bad-signature', 'bad-format', 'bad-version', 'wrong-room', 'wrong-hub', 'not-member'])
  await remove(w, w.phone, [w.agent.device.id])
  await rejects(async () => z.verifyHubAuth(await sign(w.agent.device), { state: w.phone.state, hub: w.hubUrl }), 'not-member')
})

// ---- commands ------------------------------------------------------------------

group('commands')
async function cardSetup() {
  const w = await makeWorld()
  await fetchKey(w.agent, w)
  const cardId = fill(16, 0xca)
  const cardEnv = await send(w, w.agent, { kind: KIND.CARD, bind: EMPTY, payload: utf8('{"options":["yes","no"]}'), card: { id: cardId, state: 1 } })
  await recv(w.phone, cardEnv); await recv(w.laptop, cardEnv)
  const card = { id: cardId, hash: cardEnv.hash, open: true, options: ['yes', 'no'] }
  const ctx = { state: w.agent.state, agentId: w.agent.device.id, now: T0, ownSeq: 1, card, sessionEpoch: 1 }
  const answer = (from, over = {}, opts = {}) => send(w, from, {
    kind: KIND.ANSWER, recipient: w.agent.device.id, card: { id: over.cardId ?? cardId, state: 2, answeredAt: T0 },
    bind: z.encodeAnswerBind({ cardId, cardHash: cardEnv.hash, choice: 'yes', ...over }), ...opts,
  })
  return { w, cardId, cardEnv, card, ctx, answer }
}
const EMPTY = new Uint8Array(0)
test('an answer bound to the card the human saw is accepted', async () => {
  const { w, ctx, answer } = await cardSetup()
  const got = await recv(w.agent, await answer(w.phone))
  const ok = z.authoriseCommand(got, ctx)
  assert.equal(ok.bind.choice, 'yes'); assert.equal(ok.late, false)
})
test('answer bound to a different card, a changed card, a closed card, an unknown option', async () => {
  const { w, ctx, card, answer } = await cardSetup()
  const other = { ...card, id: fill(16, 0xcb) }
  const a = await recv(w.agent, await answer(w.phone))
  await rejects(() => z.authoriseCommand(a, { ...ctx, card: other }), 'card-mismatch')
  await rejects(() => z.authoriseCommand(a, { ...ctx, card: null }), 'card-mismatch')
  // The agent changed the card after the human looked: the hash of the card envelope moved on.
  await rejects(() => z.authoriseCommand(a, { ...ctx, card: { ...card, hash: fill(32, 5) } }), 'card-changed')
  await rejects(() => z.authoriseCommand(a, { ...ctx, card: { ...card, open: false } }), 'card-closed')
  const b = await recv(w.agent, await answer(w.phone, { choice: 'maybe' }))
  await rejects(() => z.authoriseCommand(b, ctx), 'bad-choice')
  // Header says one card, the signed body another.
  const c = await recv(w.agent, await answer(w.phone, {}, { card: { id: fill(16, 0xcc), state: 2 } }))
  await rejects(() => z.authoriseCommand(c, ctx), 'card-mismatch')
})
test('who may command: not an agent, not a removed human, not for another agent', async () => {
  const { w, ctx, answer, cardId, cardEnv } = await cardSetup()
  const bot = await invite(w, w.phone, await z.generateDevice(), ROLE.AGENT, 'Bot')
  await sync(w.agent, w); await sync(w.laptop, w); await sync(w.phone, w)
  const ctx2 = { ...ctx, state: w.agent.state }
  const fromBot = await recv(w.agent, await send(w, bot, { kind: KIND.ANSWER, recipient: w.agent.device.id, card: { id: cardId, state: 2 }, bind: z.encodeAnswerBind({ cardId, cardHash: cardEnv.hash, choice: 'yes' }) }))
  await rejects(() => z.authoriseCommand(fromBot, ctx2), 'not-human')
  const toBot = await recv(w.agent, await answer(w.phone, {}, { recipient: bot.device.id }))
  assert.equal(toBot.forMe, false)
  await rejects(() => z.authoriseCommand(toBot, ctx2), 'not-for-me')
  const toAll = await recv(w.agent, await answer(w.phone, {}, { recipient: null }))
  await rejects(() => z.authoriseCommand(toAll, ctx2), 'not-for-me')
  const status = await recv(w.agent, await send(w, w.phone, { kind: KIND.STATUS, recipient: w.agent.device.id }))
  await rejects(() => z.authoriseCommand(status, ctx2), 'not-a-command')
  // The laptop answers, is removed, and the hub delivers the answer afterwards.
  const late = await answer(w.laptop)
  await remove(w, w.phone, [w.laptop.device.id], [w.agent], { [hex(w.laptop.device.id)]: { seq: late.seq, hash: late.hash } })
  await rejects(() => recv(w.agent, late), 'removed-sender')
  const forced = await recv(w.agent, late, { allowRemovedSender: true })
  await rejects(() => z.authoriseCommand(forced, { ...ctx, state: w.agent.state, epochChangedAt: T0 }), 'not-human')
})
test('stale verdict: expired, no longer pending, a different request, a changed request', async () => {
  const w = await makeWorld()
  await fetchKey(w.agent, w)
  const requestId = fill(16, 0x71), expiresAt = T0 + 5 * MIN
  const reqEnv = await send(w, w.agent, { kind: KIND.PERMISSION_REQUEST, card: { id: requestId, state: 1, urgency: 2 }, push: true, bind: z.encodeRequestBind({ requestId, expiresAt }), payload: utf8('{"tool":"Bash","input":"ls"}') })
  const seenReq = await recv(w.phone, reqEnv)
  assert.deepEqual(z.decodeBind(KIND.PERMISSION_REQUEST, seenReq.bind), { requestId, expiresAt })
  const request = { id: requestId, hash: reqEnv.hash, expiresAt, pending: true }
  const ctx = { state: w.agent.state, agentId: w.agent.device.id, now: T0 + MIN, ownSeq: 1, request, sessionEpoch: 1 }
  const verdict = await recv(w.agent, await send(w, w.phone, { kind: KIND.VERDICT, recipient: w.agent.device.id, card: { id: requestId, state: 3, urgency: 2 }, bind: z.encodeVerdictBind({ requestId, requestHash: reqEnv.hash, expiresAt, allow: true }) }))
  assert.equal(z.authoriseCommand(verdict, ctx).bind.allow, true)
  await rejects(() => z.authoriseCommand(verdict, { ...ctx, now: expiresAt + 1 }), 'request-expired')
  await rejects(() => z.authoriseCommand(verdict, { ...ctx, request: { ...request, pending: false } }), 'request-not-pending')
  await rejects(() => z.authoriseCommand(verdict, { ...ctx, request: { ...request, id: fill(16, 0x72) } }), 'request-mismatch')
  await rejects(() => z.authoriseCommand(verdict, { ...ctx, request: null }), 'request-mismatch')
  // Same id, other tool input: the agent's request envelope has another hash.
  await rejects(() => z.authoriseCommand(verdict, { ...ctx, request: { ...request, hash: fill(32, 3) } }), 'request-changed')
  await rejects(() => z.authoriseCommand(verdict, { ...ctx, request: { ...request, expiresAt: expiresAt + 1 } }), 'request-changed')
  await rejects(() => z.authoriseCommand(verdict, { ...ctx, maxAgeMs: 30000 }), 'stale')
  await rejects(() => z.decodeBind(KIND.VERDICT, flip(verdict.bind, verdict.bind.length - 1, 2)), 'bad-format')
  // R7: the request id is the object id in the verdict's header.
  const elsewhere = await recv(w.agent, await send(w, w.phone, { kind: KIND.VERDICT, recipient: w.agent.device.id, card: { id: fill(16, 0x73), state: 3 }, bind: z.encodeVerdictBind({ requestId, requestHash: reqEnv.hash, expiresAt, allow: true }) }))
  await rejects(() => z.authoriseCommand(elsewhere, ctx), 'request-mismatch')
})
test('freshness: commands of the previous key epoch count for two minutes, chat is marked late', async () => {
  const { w, ctx, answer } = await cardSetup()
  const old = await answer(w.phone)                         // sent in session key epoch 1
  const got = await recv(w.agent, old)
  assert.equal(got.epochCurrent, null)
  // The session key moved to epoch 2 (a grant rotated it) at T0.
  const at = { ...ctx, sessionEpoch: 2, epochChangedAt: T0 }
  assert.ok(z.authoriseCommand(got, { ...at, now: T0 + 2 * MIN }))
  await rejects(() => z.authoriseCommand(got, { ...at, now: T0 + 2 * MIN + 1 }), 'stale-epoch')
  await rejects(() => z.authoriseCommand(got, { ...ctx, sessionEpoch: 2, now: T0 }), 'stale-epoch')
  await rejects(() => z.authoriseCommand(got, { ...ctx, sessionEpoch: undefined }), 'stale-epoch')
  // Chat: the phone had seen the agent's envelope 1, the agent is further by now.
  const chat = await recv(w.agent, await send(w, w.phone, { recipient: w.agent.device.id }))
  // seen is bounded: the phone told the agent's 1 already with its answer, so this chat omits it; carried forward.
  assert.equal(z.authoriseCommand(chat, { ...ctx, ownSeq: 1, seenOfMe: 1 }).late, false)
  assert.equal(z.authoriseCommand(chat, { ...ctx, ownSeq: 3, seenOfMe: 1 }).late, true)
  // Strokes are timeline items too, but not chat: they never reach the agent as a message.
  const stroke = await recv(w.agent, await send(w, w.phone, { recipient: w.agent.device.id, timelineKind: z.TIMELINE.CANVAS }))
  await rejects(() => z.authoriseCommand(stroke, ctx), 'not-a-command')
})
test('live acceptance (R3): an old key epoch is refused two minutes after the change was learned', async () => {
  const w = await makeWorld()
  const env = await send(w, w.phone)
  const fresh = { now: T0 + 2 * MIN + 1, currentEpoch: 2, currentSince: T0 }
  await rejects(() => recv(w.laptop, env, { freshness: fresh }), 'wrong-epoch')
  assert.equal(w.laptop.chains.get(b64u(w.phone.device.id)), undefined)
  assert.equal(txt((await recv(w.laptop, env, { freshness: { ...fresh, now: T0 + 2 * MIN } })).payload), 'hello')
})
test('deciding again binds the answer taken back and the current version (R7)', async () => {
  const { w, ctx, answer, cardId, cardEnv } = await cardSetup()
  const first = await answer(w.phone)
  await recv(w.agent, first)
  const redo = await recv(w.agent, await send(w, w.phone, { kind: KIND.DECIDE_AGAIN, recipient: w.agent.device.id, card: { id: cardId, state: 1 }, bind: z.encodeDecideAgainBind({ objectId: cardId, previousHash: first.hash, versionHash: cardEnv.hash }) }))
  assert.deepEqual(z.authoriseCommand(redo, { ...ctx, decision: { hash: first.hash } }).bind.previousHash, first.hash)
  await rejects(() => z.authoriseCommand(redo, { ...ctx, decision: { hash: fill(32, 1) } }), 'decision-mismatch')
  await rejects(() => z.authoriseCommand(redo, ctx), 'decision-mismatch')
  // The card was revised since the human looked: the version hash no longer matches.
  await rejects(() => z.authoriseCommand(redo, { ...ctx, card: { ...ctx.card, hash: fill(32, 2) }, decision: { hash: first.hash } }), 'card-changed')
})
test('answers bind every choice (R7)', async () => {
  const { w, ctx, answer } = await cardSetup()
  const both = await recv(w.agent, await answer(w.phone, { choices: ['yes', 'no'], choice: undefined }))
  assert.deepEqual(z.authoriseCommand(both, ctx).bind.choices, ['yes', 'no'])
  const one = await recv(w.agent, await answer(w.phone, { choices: ['yes', 'maybe'], choice: undefined }))
  await rejects(() => z.authoriseCommand(one, ctx), 'bad-choice')
  const none = await recv(w.agent, await answer(w.phone, { choices: [], choice: undefined }))
  await rejects(() => z.authoriseCommand(none, ctx), 'bad-choice')
})
test('object ids belong to their creator (R1)', async () => {
  const a = await z.objectIdOf(fill(32, 1), 1)
  assert.equal(a.length, 16)
  assert.deepEqual(a, (await z.hash('trommi/v1/object-id', fill(32, 1), Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 1))).slice(0, 16))
  assert.notDeepEqual(a, await z.objectIdOf(fill(32, 2), 1))
  assert.notDeepEqual(a, await z.objectIdOf(fill(32, 1), 2))
})

// ---- assets --------------------------------------------------------------------

group('assets')
test('round trip at chunk boundaries, single chunks, hash binding', async () => {
  for (const n of [0, 1, 65535, 65536, 65537, 131072, 200000]) {
    const data = nodeCrypto.randomBytes(n)
    const a = await z.encryptAsset(data)
    const chunks = Math.max(1, Math.ceil(n / 65536))
    assert.equal(a.blob.length, 22 + n + 16 * chunks)
    assert.deepEqual(Buffer.from(await z.decryptAsset(a.blob, a.key, a.sha256)), data)
    if (n === 200000) assert.deepEqual(Buffer.from(await z.decryptAssetChunk(a.blob, a.key, 2)), data.subarray(131072, 196608))
  }
})
test('tamper: flipped bits, truncation, reordered and dropped chunks, wrong key, wrong blob', async () => {
  const data = nodeCrypto.randomBytes(3 * 65536 + 10)
  const a = await z.encryptAsset(data)
  const full = 65536 + 16
  for (const at of [0, 1, 5, 20, 22, 30, 22 + full - 1, 22 + full, a.blob.length - 1]) await rejects(() => z.decryptAsset(flip(a.blob, at), a.key), ['decrypt-failed', 'bad-format', 'bad-version'])
  await rejects(() => z.decryptAsset(a.blob.slice(0, 22 + 3 * full), a.key), 'decrypt-failed')       // last chunk cut off at a boundary
  await rejects(() => z.decryptAsset(a.blob.slice(0, 22 + 2 * full + 100), a.key), 'decrypt-failed') // cut in the middle
  await rejects(() => z.decryptAsset(a.blob.slice(0, 22 + 5), a.key), 'bad-format')
  const swapped = concat(a.blob.slice(0, 22), a.blob.slice(22 + full, 22 + 2 * full), a.blob.slice(22, 22 + full), a.blob.slice(22 + 2 * full))
  await rejects(() => z.decryptAsset(swapped, a.key), 'decrypt-failed')
  const dropped = concat(a.blob.slice(0, 22 + full), a.blob.slice(22 + 2 * full))
  await rejects(() => z.decryptAsset(dropped, a.key), 'decrypt-failed')
  await rejects(() => z.decryptAsset(a.blob, fill(32, 1)), 'decrypt-failed')
  const b = await z.encryptAsset(data)
  await rejects(() => z.decryptAsset(b.blob, b.key, a.sha256), 'decrypt-failed')
  // A chunk of another asset under the same key cannot happen (fresh key), under the same header it would fail on the blob id.
  const grafted = concat(b.blob.slice(0, 22), a.blob.slice(22))
  await rejects(() => z.decryptAsset(grafted, a.key), 'decrypt-failed')
})
test('asset key wrapped under the room key, and the link fragment form', async () => {
  const w = await makeWorld()
  const a = await z.encryptAsset(utf8('canvas'))
  const wrapped = await z.wrapAssetKey(w.roomId, w.phone.secrets.get(1), a.blobId, a.key)
  assert.equal(wrapped.length, 2 + 4 + 16 + 12 + 48)
  // A random nonce (C12): wrapping a different key under the same blob id never reuses one.
  const again = await z.wrapAssetKey(w.roomId, w.phone.secrets.get(1), a.blobId, a.key)
  assert.notDeepEqual(again.slice(22, 34), wrapped.slice(22, 34))
  await fetchKey(w.laptop, w)
  const un = await z.unwrapAssetKey(w.roomId, w.laptop.secrets, wrapped)
  assert.deepEqual(un.key, a.key); assert.deepEqual(un.blobId, a.blobId)
  for (let i = 0; i < wrapped.length; i++) await rejects(() => z.unwrapAssetKey(w.roomId, w.laptop.secrets, flip(wrapped, i)), ['decrypt-failed', 'bad-version', 'bad-format', 'no-key'])
  await rejects(() => z.unwrapAssetKey(fill(32, 1), w.laptop.secrets, wrapped), 'decrypt-failed')
  await rejects(() => z.unwrapAssetKey(w.roomId, new Map(), wrapped), 'no-key')
  const link = z.assetLink('https://hub.example/blob/abc', a.blobId, a.key)
  assert.match(link, /^https:\/\/hub\.example\/blob\/abc#a1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/)
  assert.deepEqual(z.parseAssetLink(link), { url: 'https://hub.example/blob/abc', blobId: a.blobId, key: a.key })
  await rejects(() => z.parseAssetLink(link.replace('#a1', '#a2')), 'bad-version')
})

// ---- recovery ------------------------------------------------------------------

group('recovery')
test('all devices lost: the code enrols a new device, removes the old ones, rotates, opens the history', async () => {
  const w = await makeWorld()
  const old = await send(w, w.phone, { keyScope: 0, payload: utf8('before the loss') })
  const tablet = client(await z.generateDevice(), 'Tablet')
  const newCode = z.generateRecoveryCode()
  const state = await z.verifyLog(w.hub.log, w.roomId)
  const recoveryWrap = w.hub.wraps.get(`1:${b64u(state.recovery.id)}`)
  await rejects(() => z.recoverRoom({ state, code: newCode, newCode: z.generateRecoveryCode(), newDevice: tablet.device, recoveryWrap, time: T0 }), 'bad-recovery-code')
  const r = await z.recoverRoom({ state, code: w.code, newCode, newDevice: tablet.device, recoveryWrap, time: T0, cuts: { [hex(w.phone.device.id)]: { seq: 1, hash: old.hash } } })
  w.hub.log.push(r.entry); storeWraps(w, 2, r.wraps); w.hub.backLinks.set(2, r.backLink)
  await sync(tablet, w)
  assert.deepEqual(z.activeMembers(tablet.state).map(who), ['Agent', 'Tablet'])
  await fetchKey(tablet, w)
  tablet.secrets.set(1, await z.openBackLink(tablet.state, tablet.secrets.get(2), r.backLink))
  assert.equal(txt((await recv(tablet, old, { allowRemovedSender: true })).payload), 'before the loss')
  // The old phone is out: no wrap for it, its entries are refused, the old code is spent.
  await sync(w.agent, w); await fetchKey(w.agent, w)
  await rejects(async () => z.addMember(tablet.state, w.phone.device, { member: { role: ROLE.HUMAN, ...z.publicDevice(await z.generateDevice()) }, time: T0 }), 'bad-entry')
  assert.equal(w.hub.wraps.has(`2:${b64u(w.phone.device.id)}`), false)
  await rejects(async () => z.recoverRoom({ state: tablet.state, code: w.code, newCode: z.generateRecoveryCode(), newDevice: await z.generateDevice(), recoveryWrap: w.hub.wraps.get(`2:${b64u(tablet.state.recovery.id)}`), time: T0 }), 'bad-recovery-code')
  // The new code works on the new state.
  const again = await z.recoverRoom({ state: tablet.state, code: newCode, newCode: z.generateRecoveryCode(), newDevice: await z.generateDevice(), recoveryWrap: w.hub.wraps.get(`2:${b64u(tablet.state.recovery.id)}`), time: T0 })
  assert.equal(again.state.epoch, 3)
  // The agent keeps working with the new human.
  const cmd = await recv(w.agent, await send(w, tablet, { recipient: w.agent.device.id }))
  assert.equal(z.authoriseCommand(cmd, { state: w.agent.state, agentId: w.agent.device.id, now: T0, sessionEpoch: 1 }).kind, KIND.CHAT)
})
test('recovery removes every human device and keeps the agents it is not told to remove', async () => {
  const w = await makeWorld()
  await fetchKey(w.agent, w)
  const bot = await invite(w, w.phone, await z.generateDevice(), ROLE.AGENT, 'Bot', { confirm: false })
  const state = await z.verifyLog(w.hub.log, w.roomId)
  const rec = await z.recoveryDevice(w.code)
  const tablet = await z.generateDevice()
  const r = await z.recoverRoom({ state, code: w.code, newCode: z.generateRecoveryCode(), newDevice: named(tablet, 'Tablet'), recoveryWrap: w.hub.wraps.get(`1:${b64u(state.recovery.id)}`), time: T0 })
  assert.deepEqual(z.activeMembers(r.state).map(who), ['Agent', 'Bot', 'Tablet'])
  assert.deepEqual(r.state.entries.at(-1).ids.map(b64u).sort(), [w.phone.device.id, w.laptop.device.id].map(b64u).sort())
  assert.equal(r.state.epoch, 2)
  // Agents hold no room key (R6): the new key goes to the new device and the new recovery key only.
  assert.deepEqual(r.wraps.map(x => b64u(x.id)).sort(), [tablet.id, r.state.recovery.id].map(b64u).sort())
  // A recovery may also remove agents (R6: those a thief added).
  const r2 = await z.recoverRoom({ state, code: w.code, newCode: z.generateRecoveryCode(), newDevice: await z.generateDevice(), removeAgents: [bot.device.id], recoveryWrap: w.hub.wraps.get(`1:${b64u(state.recovery.id)}`), time: T0 })
  assert.deepEqual(z.activeMembers(r2.state).filter(m => m.role === ROLE.AGENT).map(who), ['Agent'])
  // Hand-made recoveries that leave a human device in, signed by the real recovery key: refused.
  const e = r.state.entries.at(-1)
  const body = r.entry.slice(0, -64)
  const at = 80 + 1 + 64                                  // the removed list follows the member (no name since v1.1)
  assert.equal((body[at] << 8) | body[at + 1], 2)
  const item = id => concat(id, new Uint8Array(8), new Uint8Array(32))
  const withIds = list => {
    const sorted = [...list].sort((x, y) => Buffer.compare(x, y))
    return concat(body.slice(0, at), Uint8Array.of(0, sorted.length), ...sorted.map(item), body.slice(at + 2 + 2 * 72))
  }
  const signed = async b => concat(b, await z.sign(rec, z.LABEL.logSig, b))
  assert.ok(await z.applyEntry(state, await signed(withIds(e.ids))), 'the rebuilt entry is the same entry')
  for (const list of [[], [e.ids[0]], [e.ids[1], w.agent.device.id]]) {
    const err = await rejects(async () => z.applyEntry(state, await signed(withIds(list))), 'bad-entry')
    assert.match(err.message, /every human device|nothing to remove/)
  }
  assert.ok(await z.applyEntry(state, await signed(withIds([...e.ids, w.agent.device.id, bot.device.id]))), 'removing all agents too is a valid recovery')
})
test('a recovery entry overrides a device branch, is reported, and only a recovery key can make one', async () => {
  const w = await makeWorld()
  // A thief with the phone adds a device; the laptop has pinned that branch.
  const thief = await z.addMember(w.phone.state, w.phone.device, { member: { role: ROLE.HUMAN, ...z.publicDevice(named(await z.generateDevice(), 'Thief')) }, time: T0 })
  await sync(w.laptop, w, [...w.hub.log, thief.entry])
  // The owner recovers from the state before the theft.
  const state = await z.verifyLog(w.hub.log, w.roomId)
  const tablet = await z.generateDevice()
  const r = await z.recoverRoom({ state, code: w.code, newCode: z.generateRecoveryCode(), newDevice: tablet, recoveryWrap: w.hub.wraps.get(`1:${b64u(state.recovery.id)}`), time: T0 })
  const res = z.checkLogAgainstPin(r.state, w.laptop.pin)
  assert.deepEqual(res, { status: 'recovery-override', forkSeq: 3 })
  // Without the pinned hashes the fork cannot be judged and stays a fork.
  await rejects(() => z.checkLogAgainstPin(r.state, { seq: w.laptop.pin.seq, hash: w.laptop.pin.hash }), 'log-fork')
  // A device cannot sign a recovery, and a recovery signed with the wrong key is refused.
  const body = r.entry.slice(0, -64)
  await rejects(async () => z.applyEntry(state, concat(body, await z.sign(w.phone.device, z.LABEL.logSig, body))), 'bad-signature')
  // A second recovery branch does not override a pinned branch that already holds a recovery.
  const pin2 = z.pinOf(r.state)
  const r2 = await z.recoverRoom({ state, code: w.code, newCode: z.generateRecoveryCode(), newDevice: await z.generateDevice(), recoveryWrap: w.hub.wraps.get(`1:${b64u(state.recovery.id)}`), time: T0 + 1 })
  await rejects(() => z.checkLogAgainstPin(r2.state, pin2), 'log-fork')
})

// ---- the malicious hub ---------------------------------------------------------
// Two honest human devices (phone, laptop) and one honest agent. The hub holds every byte that
// crosses it and tries, in turn, everything the concept says it must not get away with.

group('malicious hub')
test('reads nothing: no plaintext, no room key, in anything it stores', async () => {
  const w = await makeWorld()
  await fetchKey(w.agent, w)
  const secret = utf8('the launch code is 0000')
  const env = await send(w, w.phone, { kind: KIND.CARD, payload: secret, card: { id: fill(16, 1), state: 1 } })
  const asset = await z.encryptAsset(concat(secret, secret))
  const stored = concat(...w.hub.log, ...w.hub.wraps.values(), ...w.hub.envelopes, asset.blob)
  assert.ok(!includesBytes(stored, secret))
  for (const k of [w.phone.secrets.get(1).key, w.phone.secrets.get(1).hist, asset.key]) assert.ok(!includesBytes(stored, k))
  // With a key of its own it decrypts nothing, and its own wrap attempt fails for lack of a private key.
  const hubDevice = await z.generateDevice()
  const guess = () => z.newEpochSecret(1)
  await rejects(() => z.openEnvelope(env.bytes, { state: w.phone.state, chains: z.newChains(), secrets: guess, quarantine: false }), 'decrypt-failed')
  for (const sealed of w.hub.wraps.values()) await rejects(() => z.openSealed(hubDevice, sealed, EMPTY), 'decrypt-failed')
  // What it does see, by design.
  const h = z.peekEnvelope(env.bytes).header
  assert.deepEqual(h.card.id, fill(16, 1)); assert.deepEqual(h.sender, w.phone.device.id)
})
test('forges no command: as itself, as the phone, by editing a real one, by redirecting one', async () => {
  const w = await makeWorld()
  await fetchKey(w.agent, w)
  const hub = client(await z.generateDevice(), 'Hub')
  hub.state = w.agent.state; hub.secrets = new Map([[1, z.newEpochSecret(1)]]); hub.sessionSecrets = new Map([[1, z.newEpochSecret(1)]])
  await rejects(() => send(w, hub, { recipient: w.agent.device.id }), ['not-member', 'key-mismatch'])
  const real = await send(w, w.phone, { payload: utf8('deploy to staging'), recipient: w.agent.device.id })
  const p = z.peekEnvelope(real.bytes)
  // As the phone, with the phone's real header and a body under a key of the hub's own.
  const fake = await craft(w, hub, p.headerBytes, w.phone.device.id, bodyOf('deploy to production'))
  await rejects(() => recv(w.agent, fake), 'bad-signature')
  // Keep the signature, change the recipient: every header byte is signed.
  const laptopAt = LOGSEQ_AT(1) + 4 + 32
  const redirected = real.bytes.slice(); redirected.set(w.laptop.device.id, 4 + laptopAt)
  await rejects(() => recv(w.agent, redirected), 'bad-signature')
  const got = await recv(w.agent, real)
  assert.equal(txt(got.payload), 'deploy to staging')
  assert.equal(z.authoriseCommand(got, { state: w.agent.state, agentId: w.agent.device.id, now: T0, sessionEpoch: 1 }).kind, KIND.CHAT)
})
test('adds no member: forged entry, re-signed entry, its own genesis', async () => {
  const w = await makeWorld()
  const hub = await z.generateDevice()
  const me = { role: ROLE.HUMAN, ...z.publicDevice(hub) }
  await rejects(() => z.addMember(w.laptop.state, hub, { member: me, time: T0 }), 'bad-entry')
  const signedByPhone = await z.addMember(w.phone.state, w.phone.device, { member: { role: ROLE.AGENT, ...z.publicDevice(named(await z.generateDevice(), 'Real')) }, time: T0 })
  // Swap the keys inside a real add entry for the hub's keys.
  const entry = signedByPhone.entry.slice()
  entry.set(hub.signPub, 2 + 1 + 4 + 32 + 8 + 1 + 32 + 1); entry.set(hub.kexPub, 2 + 1 + 4 + 32 + 8 + 1 + 32 + 1 + 32)
  await rejects(() => sync(w.laptop, w, [...w.hub.log, entry]), 'bad-signature')
  // A whole log of its own: verifies, but under another room id than the one the devices hold.
  const rec = await z.recoveryDevice(z.generateRecoveryCode())
  const own = await z.createRoom({ device: hub, recovery: rec, time: T0 })
  await rejects(() => sync(w.laptop, w, [own.entry]), 'wrong-room')
  // An envelope from a device of that fake room.
  const env = await z.sealEnvelope({ device: hub, state: own.state, secret: own.secret, chains: z.newChains(), kind: KIND.CHAT, ...TL, time: T0 })
  await rejects(() => recv(w.laptop, env), 'wrong-room')
})
test('drops, reorders, replays, splices: every case is noticed by both a human device and the agent', async () => {
  const w = await makeWorld()
  await fetchKey(w.agent, w)
  const m = []
  for (let i = 0; i < 5; i++) m.push(await send(w, w.phone, { payload: utf8(`message ${i + 1}`), recipient: w.agent.device.id }))
  const other = []
  for (let i = 0; i < 2; i++) other.push(await send(w, w.laptop, { payload: utf8(`laptop ${i + 1}`), seen: [] }))
  for (const to of [w.laptop, w.agent]) {
    await recv(to, m[0])
    await rejects(() => recv(to, m[2]), 'gap')                 // dropped 2
    await rejects(() => recv(to, m[0]), 'replay')              // replayed 1
    await recv(to, m[1])
    await rejects(() => recv(to, m[3]), 'gap')                 // reordered: 4 before 3
    await rejects(() => recv(to, m[1]), 'replay')
    await recv(to, m[2]); await recv(to, m[3])
    // Spliced: the laptop's envelope dressed up with the phone's chain position.
    if (to === w.agent) {
      const p4 = z.peekEnvelope(m[4].bytes), po = z.peekEnvelope(other[0].bytes)
      const spliced = concat(m[4].bytes.slice(0, 4 + p4.headerBytes.length), po.nonce, other[0].bytes.slice(4 + po.headerBytes.length + 12, -64), m[4].bytes.slice(-64))
      await rejects(() => recv(to, spliced), 'bad-signature')
      const spliced2 = concat(m[4].bytes.slice(0, -64), other[0].bytes.slice(-64))
      await rejects(() => recv(to, spliced2), 'bad-signature')
    }
    await recv(to, m[4])
    assert.equal(to.chains.get(b64u(w.phone.device.id)).seq, 5)
  }
  // Only what arrived in order reached the agent as a command.
  await recv(w.agent, other[0])
  await rejects(() => recv(w.agent, other[0]), 'replay')
})
test('rolls the log back, forks it, withholds its end', async () => {
  const w = await makeWorld()
  await fetchKey(w.agent, w)
  // The phone removes the agent. The hub keeps showing the laptop the old log.
  const before = [...w.hub.log]
  await remove(w, w.phone, [w.agent.device.id])
  assert.equal((await sync(w.laptop, w, before)).status, 'same')        // withholding the end cannot be seen in the log alone
  const env = await send(w, w.phone)
  const e = await rejects(() => recv(w.laptop, env), 'log-behind')      // but the first message names the newer head
  assert.equal(e.logSeq, 3)
  await sync(w.laptop, w); await fetchKey(w.laptop, w)
  await recv(w.laptop, env)
  await rejects(() => sync(w.laptop, w, before), 'log-rollback')        // and after that the old log is refused
  // The removed agent is served the old log forever: it learns nothing new, and its messages are refused.
  const fromAgent = await send(w, w.agent)
  await rejects(() => recv(w.laptop, fromAgent), 'removed-sender')
  await rejects(() => recv(w.agent, env), 'log-behind')
})
test('swaps keys: in wraps, in the invite request, in the offer', async () => {
  const w = await makeWorld()
  const hubDevice = await z.generateDevice()
  const { link, offer, invite } = await z.createInvite({ state: w.phone.state, inviter: w.phone.device, hub: w.hubUrl, role: ROLE.HUMAN, now: T0 })
  const newcomer = await z.generateDevice()
  const { request, join } = await z.createJoinRequest({ link, offer, log: w.hub.log, device: newcomer, now: T0 })
  // The hub replaces the keys in the request with its own. It does not know the secret behind the #.
  const swapped = request.slice()
  const keysAt = request.length - 96 - 32 - 64
  swapped.set(hubDevice.signPub, keysAt); swapped.set(hubDevice.kexPub, keysAt + 32)
  await rejects(() => z.acceptJoinRequest({ invite, request: swapped, inviter: w.phone.device, now: T0 }), 'bad-mac')
  // It re-signs the body with its own key: still no MAC.
  const body = swapped.slice(0, -96)
  const remade = concat(body, request.slice(-96, -64), await z.sign(hubDevice, z.LABEL.inviteRequestSig, concat(body, request.slice(-96, -64))))
  await rejects(() => z.acceptJoinRequest({ invite, request: remade, inviter: w.phone.device, now: T0 }), 'bad-mac')
  for (let i = 0; i < request.length; i++) await rejects(() => z.acceptJoinRequest({ invite, request: flip(request, i), inviter: w.phone.device, now: T0 }), ['bad-mac', 'bad-signature', 'bad-format', 'bad-version', 'bad-invite'])
  assert.equal(invite.used, false, 'junk does not burn the invite')
  // It turns the human offer into an agent offer.
  const roleAt = 2 + 32 + 16
  await rejects(() => z.createJoinRequest({ link, offer: flip(offer, roleAt, 0), log: w.hub.log, device: newcomer, now: T0 }), 'bad-signature')
  await rejects(() => z.createJoinRequest({ link, offer, log: w.hub.log.slice(0, 1).concat([w.hub.log[2]]), device: newcomer, now: T0 }), 'bad-entry')
  // It serves a log of its own behind the link.
  const rec = await z.recoveryDevice(z.generateRecoveryCode())
  const own = await z.createRoom({ device: hubDevice, recovery: rec, time: T0 })
  await rejects(() => z.createJoinRequest({ link, offer, log: [own.entry], device: newcomer, now: T0 }), 'wrong-room')
  // The honest flow still completes, and the hub then plants its own key in the wrap.
  const { reveal } = await z.acceptJoinRequest({ invite, request, inviter: w.phone.device, now: T0 })
  await z.checkReveal({ join, reveal, log: w.hub.log })
  const done = await z.finalizeInvite({ invite, state: w.phone.state, inviter: w.phone.device, secret: w.phone.secrets.get(1), codeConfirmed: true, now: T0 })
  const log = [...w.hub.log, done.entry]
  const evil = z.newEpochSecret(1)
  const aad = concat(utf8(z.LABEL.epochWrap), Uint8Array.of(0), w.roomId, Uint8Array.of(0, 0, 0, 1), newcomer.id)
  const planted = await z.seal(newcomer.kexPub, concat(Uint8Array.of(2), evil.key, evil.hist), aad)
  await rejects(() => z.completeJoin({ join, device: newcomer, log, wrap: planted }), 'key-mismatch')
  await rejects(() => z.completeJoin({ join, device: newcomer, log: w.hub.log, wrap: done.wrap }), 'not-member')
  assert.deepEqual((await z.completeJoin({ join, device: newcomer, log, wrap: done.wrap })).secret.key, w.phone.secrets.get(1).key)
})
test('with a stolen invite link: races the real invitee, and the check code tells', async () => {
  const w = await makeWorld()
  const { link, offer, invite } = await z.createInvite({ state: w.phone.state, inviter: w.phone.device, hub: w.hubUrl, role: ROLE.AGENT, now: T0 })
  const real = await z.generateDevice(), thief = await z.generateDevice()
  const honest = await z.createJoinRequest({ link, offer, log: w.hub.log, device: real, now: T0 })
  // The hub knows the link, holds the real request back and sends one of its own under the same name.
  const stolen = await z.createJoinRequest({ link, offer, log: w.hub.log, device: thief, now: T0 })
  const { reveal, code, member } = await z.acceptJoinRequest({ invite, request: stolen.request, inviter: w.phone.device, now: T0 })
  assert.deepEqual(member.id, thief.id)
  // The real invitee gets the reveal: it answers another request, so no code can be shown at all.
  await rejects(() => z.checkReveal({ join: honest.join, reveal, log: w.hub.log }), 'bad-invite')
  // The real request now finds the invite spent.
  await rejects(() => z.acceptJoinRequest({ invite, request: honest.request, inviter: w.phone.device, now: T0 }), 'invite-used')
  // The human does not see the code on the real device, does not confirm, and nothing is written.
  await rejects(() => z.finalizeInvite({ invite, state: w.phone.state, inviter: w.phone.device, secret: w.phone.secrets.get(1), now: T0 }), 'code-not-confirmed')
  // Had the check been switched off for this agent invite, the thief would be in, as an agent:
  const done = await z.finalizeInvite({ invite, state: w.phone.state, inviter: w.phone.device, secret: w.phone.secrets.get(1), skipCheckCode: true, now: T0 })
  const inside = await z.completeJoin({ join: stolen.join, device: thief, log: [...w.hub.log, done.entry], wrap: done.wrap })
  assert.equal(z.memberAt(inside.state, thief.id).role, ROLE.AGENT)
  assert.equal(inside.secret, null, 'no room key at all (R6), and no session key until a human grants one')
  await rejects(async () => z.addMember(inside.state, thief, { member: { role: ROLE.HUMAN, ...z.publicDevice(await z.generateDevice()) }, time: T0 }), 'bad-entry')
  assert.equal(code, await z.checkReveal({ join: stolen.join, reveal, log: w.hub.log }), 'the thief, not the invitee, shares the code with the inviter')
})
test('commands: redirects an answer to another card, replays an approval, delivers a verdict late', async () => {
  const { w, ctx, card, answer, cardId } = await cardSetup()
  // Two cards are open. The human answers card A; the hub wants it to count for card B.
  const cardB = fill(16, 0xcb)
  const envB = await send(w, w.agent, { kind: KIND.CARD, payload: utf8('{"options":["yes","no"]}'), card: { id: cardB, state: 1 } })
  await recv(w.phone, envB)
  const ans = await answer(w.phone)
  const got = await recv(w.agent, ans)
  await rejects(() => z.authoriseCommand(got, { ...ctx, card: { id: cardB, hash: envB.hash, open: true, options: ['yes', 'no'] } }), 'card-mismatch')
  // Rewriting the card id in the cleartext header breaks the signature.
  const p = z.peekEnvelope(ans.bytes)
  const cardAt = p.headerBytes.length - 1 - 26
  assert.deepEqual(p.headerBytes.slice(cardAt, cardAt + 16), cardId)
  const edited = ans.bytes.slice(); edited.set(cardB, 4 + cardAt)
  await rejects(() => recv(w.agent, edited), ['bad-signature', 'replay'])
  assert.ok(z.authoriseCommand(got, ctx))
  // The same answer again, after the card was reopened with other options: replay, and the hash moved on.
  await rejects(() => recv(w.agent, ans), 'replay')
  await rejects(() => z.authoriseCommand(got, { ...ctx, card: { ...card, hash: fill(32, 8) } }), 'card-changed')
  // A verdict held back until the request ran out.
  const requestId = fill(16, 0x33), expiresAt = T0 + MIN
  const req = await send(w, w.agent, { kind: KIND.PERMISSION_REQUEST, card: { id: requestId, state: 1 }, bind: z.encodeRequestBind({ requestId, expiresAt }), payload: utf8('{"tool":"Bash"}') })
  await recv(w.phone, req)
  const verdict = await send(w, w.phone, { kind: KIND.VERDICT, recipient: w.agent.device.id, card: { id: requestId, state: 3 }, bind: z.encodeVerdictBind({ requestId, requestHash: req.hash, expiresAt, allow: true }) })
  const late = await recv(w.agent, verdict)
  await rejects(() => z.authoriseCommand(late, { ...ctx, now: T0 + 10 * MIN, request: { id: requestId, hash: req.hash, expiresAt, pending: true } }), 'request-expired')
  // And an approval for request 1 presented for request 2 with the same tool.
  const req2 = await send(w, w.agent, { kind: KIND.PERMISSION_REQUEST, card: { id: fill(16, 0x34), state: 1 }, bind: z.encodeRequestBind({ requestId: fill(16, 0x34), expiresAt }), payload: utf8('{"tool":"Bash"}') })
  await rejects(() => z.authoriseCommand(late, { ...ctx, request: { id: fill(16, 0x34), hash: req2.hash, expiresAt, pending: true } }), 'request-mismatch')
})
test('colludes with a removed device: hands it every wrap and back link of the new epoch', async () => {
  const w = await makeWorld()
  const tablet = await invite(w, w.phone, await z.generateDevice(), ROLE.HUMAN, 'Tablet')
  await sync(w.phone, w); await sync(w.laptop, w); await fetchKey(w.laptop, w)
  const r = await remove(w, w.phone, [w.laptop.device.id], [tablet])
  const after = await send(w, w.phone, { keyScope: 0, payload: utf8('not for the removed laptop') })
  await sync(w.laptop, w)
  for (const [k, sealed] of w.hub.wraps) {
    const epoch = Number(k.split(':')[0])
    if (epoch !== 2) continue
    for (const id of [w.laptop.device.id, w.phone.device.id, tablet.device.id]) {
      await rejects(() => z.unwrapEpochKey(w.laptop.state, { ...w.laptop.device, id }, sealed, 2), 'decrypt-failed')
    }
  }
  await rejects(() => z.openBackLink(w.laptop.state, { ...w.laptop.secrets.get(1), epoch: 2 }, r.backLink), 'decrypt-failed')
  await rejects(() => recv(w.laptop, after), 'no-key')
  assert.equal(txt((await recv(tablet, after)).payload), 'not for the removed laptop')
})

// ---- vectors -------------------------------------------------------------------

const H = b => hex(b)
const be = (n, len) => { const b = new Uint8Array(len); let v = BigInt(n); for (let i = len - 1; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n } return b }
/** A log entry built by hand from FORMAT.md, section 6, and signed by `signer`: for entries the library refuses to build. */
async function handEntry(state, signer, type, payload) {
  const body = concat(Uint8Array.of(1, 1, type), be(state.head.seq + 1, 4), state.head.hash, be(T0, 8), Uint8Array.of(1), signer.id, payload)
  return concat(body, await z.sign(signer, z.LABEL.logSig, body))
}
async function buildVectors() {
  const v = { about: 'Deterministic test vectors for zcrypto.mjs format version 1. All byte strings are lower-case hex. Regenerate with: node crypto/test.mjs --write-vectors', rng: 'Test-only randomness: call number c (from 0) of a generator with seed s returns n bytes, byte j = (s + 17c + j) mod 256. Each section names its seed.' }
  const dev = async (a, b) => z.deviceFromSeeds(fill(32, a), fill(32, b), { extractable: true })
  const phone = await dev(0x11, 0x12), laptop = await dev(0x21, 0x22), agent = await dev(0x31, 0x32), tablet = await dev(0x41, 0x42), helper = await dev(0x51, 0x52)
  const pubs = d => ({ signPub: H(d.signPub), kexPub: H(d.kexPub), id: H(d.id) })

  v.encoding = { bytes: '00fbff10', base64url: b64u(unhex('00fbff10')), hash: { label: 'trommi/v1/log-entry', data: H(utf8('abc')), out: H(await z.hash(z.LABEL.logEntry, utf8('abc'))) },
    hkdf: { ikm: H(fill(32, 1)), salt: H(fill(32, 2)), label: 'trommi/v1/sender-key', context: '00000001', length: 32, out: H(await z.hkdf(fill(32, 1), fill(32, 2), z.LABEL.senderKey, unhex('00000001'), 32)) } }
  v.devices = {
    phone: { signSeed: H(fill(32, 0x11)), kexSeed: H(fill(32, 0x12)), ...pubs(phone), public: H(z.encodeDevicePublic(phone)), secretFile: H(await z.exportDeviceSecret(phone)) },
    laptop: { signSeed: H(fill(32, 0x21)), kexSeed: H(fill(32, 0x22)), ...pubs(laptop) },
    agent: { signSeed: H(fill(32, 0x31)), kexSeed: H(fill(32, 0x32)), ...pubs(agent), secretFile: H(await z.exportDeviceSecret(agent)) },
    tablet: { signSeed: H(fill(32, 0x41)), kexSeed: H(fill(32, 0x42)), ...pubs(tablet) },
    helper: { signSeed: H(fill(32, 0x51)), kexSeed: H(fill(32, 0x52)), ...pubs(helper) },
  }
  v.signature = { signer: 'phone', label: 'trommi/v1/log-sig', message: H(utf8('message')), signature: H(await z.sign(phone, z.LABEL.logSig, utf8('message'))) }

  const code = z.generateRecoveryCode({ _rng: fixedRng(0x40) })
  const rec = await z.recoveryDevice(code)
  v.recovery = { rngSeed: 0x40, raw: H(z.parseRecoveryCode(code)), code, ...pubs(rec) }

  const sealed = await z.seal(laptop.kexPub, utf8('sealed box'), utf8('associated'), { _rng: fixedRng(0x50) })
  v.sealedBox = { rngSeed: 0x50, recipient: 'laptop', plaintext: H(utf8('sealed box')), aad: H(utf8('associated')), ephemeralSeed: H(fixedRng(0x50)(32)), sealed: H(sealed) }

  // Room: genesis by the phone (entry 0), laptop by invite with the check code (1), agent by a link in its prompt,
  // no check code (2), a second agent invited by the laptop (3), that agent removed by the laptop: epoch 2 (4),
  // recovery: phone and laptop out, tablet in, the first agent stays: epoch 3 (5).
  const room = await z.createRoom({ device: phone, recovery: rec, time: T0, _rng: fixedRng(0x60) })
  const sec = s => ({ epoch: s.epoch, key: H(s.key), hist: s.hist ? H(s.hist) : null })
  const commits = async s => { const c = await z.epochCommits(s); return { keyCommit: H(c.keyCommit), histCommit: H(c.histCommit) } }
  const names = new Map([[H(rec.id), 'recovery key']])
  const who = id => names.get(H(id)) ?? H(id)
  const wraps = ws => ws.map(x => ({ recipient: who(x.id), recipientId: H(x.id), sealed: H(x.sealed) }))
  for (const [n, d] of [['phone', phone], ['laptop', laptop], ['agent', agent], ['helper', helper], ['tablet', tablet]]) names.set(H(d.id), n)
  v.room = { rngSeed: 0x60, rngCalls: 'room nonce (16), room key (32), history key (32), then one ephemeral X25519 key (32) per wrap', time: T0, name: 'Phone', genesis: H(room.entry), roomId: H(room.roomId), secret: sec(room.secret), ...await commits(room.secret), wraps: wraps(room.wraps) }

  const log = [room.entry]
  let state = room.state
  v.invites = []
  const members = { Phone: room.secret }
  for (const [name, device, role, seed, inviter, checked] of [['Laptop', laptop, ROLE.HUMAN, 0x70, phone, true], ['Agent', agent, ROLE.AGENT, 0x78, phone, false], ['Helper', helper, ROLE.AGENT, 0x88, laptop, false]]) {
    const before = state
    const made = await z.createInvite({ state, inviter, hub: 'https://hub.example', app: 'https://app.example/join', role, now: T0, _rng: fixedRng(seed) })
    const { request, join } = await z.createJoinRequest({ link: made.link, offer: made.offer, log, device, now: T0 })
    const { reveal, code: checkCode } = await z.acceptJoinRequest({ invite: made.invite, request, inviter, now: T0 })
    assert.equal(await z.checkReveal({ join, reveal, log }), checkCode)
    const done = await z.finalizeInvite({ invite: made.invite, state, inviter, secret: room.secret, codeConfirmed: checked, skipCheckCode: !checked, now: T0, _rng: fixedRng(seed + 1) })
    log.push(done.entry); state = done.state
    members[name] = (await z.completeJoin({ join, device, log, wrap: done.wrap })).secret
    v.invites.push({ rngSeed: seed, rngCalls: 'link secret (32), nonce (32)', wrapRngSeed: seed + 1, hub: 'https://hub.example', app: 'https://app.example/join', role, name, inviter: who(inviter.id), now: T0,
      logSeqBefore: before.head.seq, secret: H(made.invite.secret), nonce: H(made.invite.nonce), inviteId: H(made.invite.inviteId), expiresAt: made.invite.expiresAt, link: made.link,
      offer: H(made.offer), offerHash: H(await z.inviteOfferHash(made.offer)), request: H(request), requestHash: H(await z.inviteRequestHash(request)), reveal: H(reveal),
      checkCode, checkCodeCompared: checked, entry: H(done.entry), wrap: done.wrap ? H(done.wrap) : null, roomKeyOpened: members[name] ? sec(members[name]) : null })
  }
  const stateEpoch1 = state

  // Envelopes, all under the agent's session key (scope 1): phone 1 (chat), agent 1 (a card), phone 2 (the answer).
  // The session key is a fixed secret here; crypto/session-grants.mjs hands such keys out.
  const sessionId = fill(16, 0x5e), sessionSecret = { epoch: 1, key: fill(32, 0x61), hist: fill(32, 0x62) }
  const sess = { keyScope: 1, sessionId, secret: sessionSecret }
  const sessKeys = () => sessionSecret
  const chains = { phone: z.newChains(), agent: z.newChains() }
  const cardId = await z.objectIdOf(agent.id, 1), blobId = fill(16, 0xb1)
  const timeline = { timelineKind: z.TIMELINE.CHAT, timelineId: `session/${hex(sessionId)}` }
  const e1 = await z.sealEnvelope({ device: phone, state, chains: chains.phone, ...sess, kind: KIND.CHAT, ...timeline, payload: utf8('hello'), recipient: agent.id, time: T0 + 1, _rng: fixedRng(0x80) })
  await z.openEnvelope(e1.bytes, { state, chains: chains.agent, secrets: sessKeys })
  const e2 = await z.sealEnvelope({ device: agent, state, chains: chains.agent, ...sess, kind: KIND.CARD, payload: utf8('{"title":"Deploy?","options":["yes","no"]}'), card: { id: cardId, state: z.CARD_STATE.OPEN, urgency: z.URGENCY.HIGH }, blobs: [blobId], push: true, time: T0 + 2, _rng: fixedRng(0x81) })
  await z.openEnvelope(e2.bytes, { state, chains: chains.phone, secrets: sessKeys })
  const answerBind = z.encodeAnswerBind({ objectId: cardId, versionHash: e2.hash, choices: ['yes'] })
  const e3 = await z.sealEnvelope({ device: phone, state, chains: chains.phone, ...sess, kind: KIND.ANSWER, bind: answerBind, payload: utf8('{"note":"go"}'), recipient: agent.id, card: { id: cardId, state: z.CARD_STATE.ANSWERED, urgency: z.URGENCY.HIGH, answeredAt: T0 + 3 }, time: T0 + 3, _rng: fixedRng(0x82) })
  await z.openEnvelope(e3.bytes, { state, chains: chains.agent, secrets: sessKeys, self: agent.id })
  // One room-scope envelope (a desk stroke), from the phone under the room key.
  const deskId = fill(16, 0xd5)
  const e5 = await z.sealEnvelope({ device: phone, state, chains: chains.phone, secret: room.secret, kind: KIND.TIMELINE_ITEM, timelineKind: z.TIMELINE.CANVAS, timelineId: `desk/${hex(deskId)}`, payload: utf8('{"content_type":"strokes"}'), time: T0 + 4, _rng: fixedRng(0x83) })
  const env = (e, more) => {
    const p = z.peekEnvelope(e.bytes), h = p.header
    return { ...more, epoch: h.epoch, seq: h.seq, prev: H(h.prev), logSeq: h.logSeq, logHash: H(h.logHash), seen: h.seen.map(x => ({ sender: who(x.sender), seq: x.seq, hash: H(x.hash) })),
      hubSees: { push: h.push, isHead: h.isHead, kind: h.kind, timelineKind: h.timelineKind, timelineId: h.timelineId, card: h.card ? { id: H(h.card.id), state: h.card.state, urgency: h.card.urgency, answeredAt: h.card.answeredAt } : null, blobs: h.blobs.map(H) },
      header: H(p.headerBytes), nonce: H(p.nonce), ciphertext: H(p.ciphertext), ciphertextHash: H(nodeCrypto.createHash('sha256').update(p.ciphertext).digest()), signature: H(p.signature), hash: H(e.hash), bytes: H(e.bytes) }
  }
  v.envelopes = {
    session: { sessionId: H(sessionId), sessionKey: sec(sessionSecret) },
    senderKeys: {
      phoneRoom: H(await z.deriveSenderKey(room.roomId, room.secret, phone.id)),
      phoneSession: H(await z.deriveSenderKey(room.roomId, sessionSecret, phone.id, sess)), agentSession: H(await z.deriveSenderKey(room.roomId, sessionSecret, agent.id, sess)),
    },
    chat: env(e1, { rngSeed: 0x80, sender: 'phone', kind: KIND.CHAT, ...timeline, keyScope: 1, payload: H(utf8('hello')), recipient: 'agent', time: T0 + 1 }),
    desk: env(e5, { rngSeed: 0x83, sender: 'phone', kind: KIND.TIMELINE_ITEM, timelineKind: 2, timelineId: `desk/${hex(deskId)}`, keyScope: 0, payload: H(utf8('{"content_type":"strokes"}')), time: T0 + 4 }),
    objectIdOfCard: 'objectIdOf(agent, 1)',
    card: env(e2, { rngSeed: 0x81, sender: 'agent', kind: KIND.CARD, payload: H(utf8('{"title":"Deploy?","options":["yes","no"]}')), time: T0 + 2, cardId: H(cardId), blobId: H(blobId) }),
    answer: env(e3, { rngSeed: 0x82, sender: 'phone', kind: KIND.ANSWER, bind: H(answerBind), payload: H(utf8('{"note":"go"}')), recipient: 'agent', time: T0 + 3 }),
    pruned: H(await z.pruneEnvelope(e1.bytes)),
    prunedAnswer: H(await z.pruneEnvelope(e3.bytes)),
  }
  v.binds = {
    answer: H(answerBind),
    verdict: H(z.encodeVerdictBind({ requestId: fill(16, 0x71), requestHash: fill(32, 0x72), expiresAt: T0 + 300000, allow: true })),
    decideAgain: H(z.encodeDecideAgainBind({ objectId: cardId, previousHash: e3.hash, versionHash: e2.hash })),
    request: H(z.encodeRequestBind({ requestId: fill(16, 0x71), expiresAt: T0 + 300000 })),
  }
  const challenge = fill(32, 0x5c)
  v.hubAuth = { signer: 'agent', hub: 'https://hub.example', challenge: H(challenge), logSeq: state.head.seq, signed: H(await z.signHubAuth({ device: agent, roomId: room.roomId, hub: 'https://hub.example', challenge })) }

  // A member is removed: the room key changes. Then the recovery: it changes again, and the agent stays.
  const rem = await z.removeMembers(state, laptop, { ids: [helper.id], previous: members.Laptop, time: T0 + 10, _rng: fixedRng(0x90) })
  log.push(rem.entry); state = rem.state
  const newCode = z.generateRecoveryCode({ _rng: fixedRng(0xa0) })
  const recovered = await z.recoverRoom({ state, code, newCode, newDevice: named(tablet, 'Tablet'), recoveryWrap: rem.wraps.at(-1).sealed, time: T0 + 30, _rng: fixedRng(0xa8) })
  log.push(recovered.entry); state = recovered.state
  names.set(H(state.recovery.id), 'new recovery key')
  const rotation = async (r, more) => ({ ...more, rngCalls: 'room key (32), history key (32), then one ephemeral X25519 key (32) per wrap', entry: H(r.entry), entryHash: H(r.state.head.hash), removedIds: r.state.entries.at(-1).ids.map(H),
    secret: sec(r.secret), ...await commits(r.secret), wraps: wraps(r.wraps), backLink: H(r.backLink), membersAfter: z.activeMembers(r.state).map(m => who(m.id)) })
  const newRec = await z.recoveryDevice(newCode)
  v.epochChanges = {
    remove: await rotation(rem, { rngSeed: 0x90, signer: 'laptop', removed: ['helper'], time: T0 + 10 }),
    recover: await rotation(recovered, { rngSeed: 0xa8, signer: 'recovery key', removed: ['phone', 'laptop'], kept: ['agent'], recoveryWrapUsed: H(rem.wraps.at(-1).sealed),
      newCodeRngSeed: 0xa0, newCode, newRecovery: pubs(newRec), newDevice: 'tablet', name: 'Tablet', time: T0 + 30 }),
  }
  // After the recovery the agent, still a member, reads the new human device in its session.
  const tabletChains = z.newChains()
  const e4 = await z.sealEnvelope({ device: tablet, state, chains: tabletChains, ...sess, kind: KIND.CHAT, ...timeline, payload: utf8('back again'), recipient: agent.id, time: T0 + 40, _rng: fixedRng(0xb4) })
  await z.openEnvelope(e4.bytes, { state, chains: chains.agent, secrets: sessKeys, self: agent.id })
  v.envelopes.afterRecovery = env(e4, { rngSeed: 0xb4, sender: 'tablet', kind: KIND.CHAT, ...timeline, keyScope: 1, payload: H(utf8('back again')), recipient: 'agent', time: T0 + 40, senderKey: H(await z.deriveSenderKey(room.roomId, sessionSecret, tablet.id, sess)) })

  const typeName = Object.fromEntries(Object.entries(ENTRY).map(([k, n]) => [n, k.toLowerCase()]))
  v.log = {
    entries: log.map((bytes, i) => {
      const e = state.entries[i]
      return { seq: e.seq, type: e.type, typeName: typeName[e.type], signerKind: e.signerKind, signer: i === 5 ? 'recovery key' : who(e.signer), time: e.time, epochAfter: z.epochAt(state, i),
        body: H(e.body), signature: H(e.signature), hash: H(state.hashes[i]), bytes: H(bytes) }
    }),
    finalEpoch: state.epoch, activeMembers: z.activeMembers(state).map(m => who(m.id)),
    refused: {
      about: 'Entries a verifier must refuse when applied after entry 3 (bad-entry or bad-format).',
      retiredType4: H(await handEntry(stateEpoch1, phone, 4, concat(be(2, 4), fill(32, 1), fill(32, 2)))),
      signedByAgent: H(await handEntry(stateEpoch1, agent, ENTRY.REMOVE, concat(be(1, 2), helper.id, be(0, 8), new Uint8Array(32), be(2, 4), fill(32, 1), fill(32, 2)))),
      replayOfEntry3: H(log[3]),
    },
  }

  // Assets.
  const small = await z.encryptAsset(utf8('asset'), { _rng: fixedRng(0xb0) })
  const bigData = new Uint8Array(70000); for (let i = 0; i < bigData.length; i++) bigData[i] = (i * 7) & 0xff
  const big = await z.encryptAsset(bigData, { _rng: fixedRng(0xb8) })
  v.assets = {
    small: { rngSeed: 0xb0, plaintext: H(utf8('asset')), key: H(small.key), blobId: H(small.blobId), blob: H(small.blob), sha256: H(small.sha256) },
    twoChunks: { rngSeed: 0xb8, plaintext: '70000 bytes, byte i = 7i mod 256', key: H(big.key), blobId: H(big.blobId), blobLength: big.blob.length, sha256: H(big.sha256) },
    wrap: { epoch: 1, rngSeed: 0xbc, wrapped: H(await z.wrapAssetKey(room.roomId, room.secret, small.blobId, small.key, { _rng: fixedRng(0xbc) })) },
    link: z.assetLink('https://hub.example/blob/1', small.blobId, small.key),
  }
  return v
}

group('vectors')
let vectorsBuilt = null
test('vectors.json regenerates byte for byte', async () => {
  vectorsBuilt = await buildVectors()
  const again = await buildVectors()
  assert.deepEqual(again, vectorsBuilt, 'generation is deterministic')
  if (process.argv.includes('--write-vectors')) {
    fs.writeFileSync(VECTORS, JSON.stringify(vectorsBuilt, null, 2) + '\n')
    console.log(`  wrote ${VECTORS}`)
    return
  }
  assert.ok(fs.existsSync(VECTORS), 'crypto/vectors.json is missing: run with --write-vectors')
  assert.deepEqual(JSON.parse(fs.readFileSync(VECTORS, 'utf8')), JSON.parse(JSON.stringify(vectorsBuilt)))
})
test('the stored vectors open from their bytes alone (as a second implementation would)', async () => {
  const v = process.argv.includes('--write-vectors') ? JSON.parse(JSON.stringify(vectorsBuilt)) : JSON.parse(fs.readFileSync(VECTORS, 'utf8'))
  const dev = d => z.deviceFromSeeds(unhex(d.signSeed), unhex(d.kexSeed))
  const phone = await dev(v.devices.phone), laptop = await dev(v.devices.laptop), agent = await dev(v.devices.agent), tablet = await dev(v.devices.tablet)
  named(phone, 'Phone'); named(laptop, 'Laptop'); named(agent, 'Agent'); named(tablet, 'Tablet')
  for (const [d, name] of [[phone, 'phone'], [laptop, 'laptop'], [agent, 'agent'], [tablet, 'tablet']]) {
    assert.equal(hex(d.id), v.devices[name].id); assert.equal(hex(d.signPub), v.devices[name].signPub); assert.equal(hex(d.kexPub), v.devices[name].kexPub)
  }
  assert.equal(hex((await z.importDeviceSecret(unhex(v.devices.agent.secretFile))).id), v.devices.agent.id)
  assert.equal(await z.verify(phone.signPub, v.signature.label, unhex(v.signature.message), unhex(v.signature.signature)), true)
  assert.equal(txt(await z.openSealed(laptop, unhex(v.sealedBox.sealed), unhex(v.sealedBox.aad))), 'sealed box')
  const rec = await z.recoveryDevice(v.recovery.code)
  assert.equal(hex(rec.id), v.recovery.id)
  const roomId = unhex(v.room.roomId)
  const entries = v.log.entries.map(e => unhex(e.bytes))
  for (const e of v.log.entries) {
    assert.equal(e.bytes, e.body + e.signature)
    assert.equal(hex(await z.hash(z.LABEL.logEntry, unhex(e.body))), e.hash)
  }
  assert.equal(v.log.entries[0].hash, v.room.roomId)
  assert.deepEqual(v.log.entries.map(e => e.typeName), ['genesis', 'add', 'add', 'add', 'remove', 'recover'])
  const state3 = await z.verifyLog(entries.slice(0, 4), roomId)
  const full = await z.verifyLog(entries, roomId)
  assert.deepEqual(full.hashes.map(hex), v.log.entries.map(e => e.hash))
  assert.deepEqual(z.activeMembers(full).map(who), ['Agent', 'Tablet']); assert.deepEqual(v.log.activeMembers, ['agent', 'tablet'])
  assert.equal(full.epoch, 3); assert.deepEqual(v.log.entries.map(e => e.epochAfter), [1, 1, 1, 1, 2, 3])
  for (const k of ['retiredType4', 'signedByAgent', 'replayOfEntry3']) await rejects(() => z.applyEntry(state3, unhex(v.log.refused[k])), ['bad-entry', 'bad-format'])

  // Invites: the joining side recomputes everything from the link and the bytes that crossed the hub.
  const joiners = [laptop, agent, await dev(v.devices.helper)]
  for (const [i, inv] of v.invites.entries()) {
    const log = entries.slice(0, inv.logSeqBefore + 1)
    const { secret } = z.parseInviteLink(inv.link)
    assert.equal(hex(secret), inv.secret)
    assert.equal(hex(await z.hkdf(secret, roomId, z.LABEL.inviteId, new Uint8Array(0), 16)), inv.inviteId)
    const { request, join } = await z.createJoinRequest({ link: inv.link, offer: unhex(inv.offer), log, device: joiners[i], now: inv.now })
    assert.equal(hex(request), inv.request, 'the request holds no randomness')
    assert.equal(await z.checkReveal({ join, reveal: unhex(inv.reveal), log }), inv.checkCode)
    const joined = await z.completeJoin({ join, device: joiners[i], log: [...log, unhex(inv.entry)], wrap: inv.wrap ? unhex(inv.wrap) : null })
    if (inv.role === ROLE.HUMAN) assert.equal(hex(joined.secret.key), v.room.secret.key)
    else { assert.equal(joined.secret, null); assert.equal(inv.wrap, null) }
    assert.equal(inv.checkCodeCompared, inv.role === ROLE.HUMAN)
  }
  // Keys: the phone's wrap of epoch 1. Agents hold no room key.
  const s1 = await z.unwrapEpochKey(state3, phone, unhex(v.room.wraps.find(x => x.recipient === 'phone').sealed), 1)
  assert.equal(hex(s1.key), v.room.secret.key)
  // Removal: a new room key for the human devices who stay and the recovery key, none for the removed helper.
  const rm = v.epochChanges.remove, rc = v.epochChanges.recover
  assert.deepEqual(rm.wraps.map(x => x.recipient).sort(), ['laptop', 'phone', 'recovery key'])
  const state4 = await z.verifyLog(entries.slice(0, 5), roomId)
  assert.equal(hex((await z.unwrapEpochKey(state4, laptop, unhex(rm.wraps.find(x => x.recipient === 'laptop').sealed), 2)).key), rm.secret.key)
  assert.notEqual(rm.secret.key, v.room.secret.key)
  // Recovery: from the code alone. The agent stays a member; the old devices get no key.
  const viaCode = await z.unwrapEpochKey(state4, rec, unhex(rc.recoveryWrapUsed), 2)
  assert.equal(hex(viaCode.key), rm.secret.key)
  assert.deepEqual(rc.wraps.map(x => x.recipient).sort(), ['new recovery key', 'tablet'])
  assert.deepEqual(rc.removedIds.sort(), [v.devices.phone.id, v.devices.laptop.id].sort())
  assert.equal(hex((await z.recoveryDevice(rc.newCode)).id), rc.newRecovery.id)
  const s3 = await z.unwrapEpochKey(full, tablet, unhex(rc.wraps.find(x => x.recipient === 'tablet').sealed), 3)
  const s2 = await z.openBackLink(full, s3, unhex(rc.backLink))
  const s1b = await z.openBackLink(full, s2, unhex(rm.backLink))
  assert.equal(hex(s1b.key), v.room.secret.key)
  // Envelopes, in the agent's order; the hub reads urgency and status without any key.
  const chains = z.newChains()
  const sessionSecret = { epoch: 1, key: unhex(v.envelopes.session.sessionKey.key), hist: unhex(v.envelopes.session.sessionKey.hist) }
  const secrets = (epoch, h) => (h.keyScope === 1 ? sessionSecret : null)
  const chat = await z.openEnvelope(unhex(v.envelopes.chat.bytes), { state: state3, chains, secrets })
  assert.equal(txt(chat.payload), 'hello'); assert.equal(hex(chat.hash), v.envelopes.chat.hash)
  const phoneChains = z.newChains()
  const pruned = await z.verifyEnvelope(unhex(v.envelopes.pruned), { state: state3, chains: phoneChains })
  assert.equal(hex(pruned.hash), v.envelopes.chat.hash)
  const card = await z.openEnvelope(unhex(v.envelopes.card.bytes), { state: state3, chains: phoneChains, secrets })
  assert.equal(card.kind, KIND.CARD)
  assert.equal(v.envelopes.card.cardId, hex(await z.objectIdOf(agent.id, 1)))
  assert.deepEqual(z.peekEnvelope(unhex(v.envelopes.card.bytes)).header.card.urgency, z.URGENCY.HIGH)
  assert.deepEqual(v.envelopes.card.hubSees.card, { id: v.envelopes.card.cardId, state: 1, urgency: 2, answeredAt: 0 })
  assert.equal(z.peekEnvelope(unhex(v.envelopes.prunedAnswer)).header.card.answeredAt, T0 + 3)
  advanceOwn(chains, agent.id, card)
  const answer = await z.openEnvelope(unhex(v.envelopes.answer.bytes), { state: state3, chains, secrets, self: agent.id })
  assert.equal(answer.header.seq, 2); assert.equal(hex(answer.header.prev), v.envelopes.chat.hash, 'the hash chain of one sender')
  const ok = z.authoriseCommand(answer, { state: state3, agentId: agent.id, now: T0 + 3, ownSeq: 1, sessionEpoch: 1, card: { id: unhex(v.envelopes.card.cardId), hash: unhex(v.envelopes.card.hash), open: true, options: ['yes', 'no'] } })
  assert.deepEqual(ok.bind.choices, ['yes'])
  // The room-scope desk stroke opens with the phone's room key (s1), on the phone's chain after the chat and the answer.
  const desk = await z.openEnvelope(unhex(v.envelopes.desk.bytes), { state: state3, chains: z.newChains(), secrets: (e, h) => (h.keyScope === 0 ? s1 : sessionSecret), allowChainStart: true })
  assert.equal(txt(desk.payload), '{"content_type":"strokes"}')
  const back = await z.openEnvelope(unhex(v.envelopes.afterRecovery.bytes), { state: full, chains, secrets, self: agent.id })
  assert.equal(txt(back.payload), 'back again'); assert.equal(who(back.member), 'Tablet')
  assert.equal(z.authoriseCommand(back, { state: full, agentId: agent.id, now: T0 + 40, sessionEpoch: 1 }).kind, KIND.CHAT)
  // The removed phone is refused by everyone who has the newer log.
  await rejects(() => z.verifyEnvelope(unhex(v.envelopes.answer.bytes), { state: full, chains: z.newChains(), allowChainStart: true }), 'removed-sender')
  const auth = await z.verifyHubAuth(unhex(v.hubAuth.signed), { state: state3, hub: v.hubAuth.hub })
  assert.equal(who(auth.member), 'Agent'); assert.equal(hex(auth.challenge), v.hubAuth.challenge)
  // Assets.
  assert.equal(txt(await z.decryptAsset(unhex(v.assets.small.blob), unhex(v.assets.small.key), unhex(v.assets.small.sha256))), 'asset')
  assert.equal(hex((await z.unwrapAssetKey(unhex(v.room.roomId), new Map([[1, s1]]), unhex(v.assets.wrap.wrapped))).key), v.assets.small.key)
  assert.equal(hex(z.parseAssetLink(v.assets.link).key), v.assets.small.key)
  assert.equal(z.parseInviteLink(v.invites[0].link).hub, 'https://hub.example')
})
/** The agent's own envelope, as its chain state would hold it after sending. */
function advanceOwn(chains, id, opened) {
  chains.set(b64u(id), { seq: opened.header.seq, hash: opened.hash, hashes: new Map([[opened.header.seq, opened.hash]]) })
}

// ---- run -----------------------------------------------------------------------

async function bench() {
  const w = await makeWorld()
  await fetchKey(w.agent, w)
  const payload = nodeCrypto.randomBytes(1000)
  const time = async (label, n, fn) => {
    for (let i = 0; i < Math.min(50, n); i++) await fn(i)
    const t = performance.now()
    for (let i = 0; i < n; i++) await fn(i)
    const ms = (performance.now() - t) / n
    console.log(`  ${label.padEnd(46)} ${ms.toFixed(3)} ms`)
    return ms
  }
  console.log(`\nbenchmark (Node ${process.version}, ${process.arch}, mean per operation)`)
  const d = w.phone.device, msg = nodeCrypto.randomBytes(32)
  const sig = await z.sign(d, 'bench', msg)
  await time('sign (Ed25519, 32 bytes)', 2000, () => z.sign(d, 'bench', msg))
  await time('verify (Ed25519, 32 bytes)', 2000, () => z.verify(d.signPub, 'bench', msg, sig))
  const N = 1050
  const envs = []
  const t0 = performance.now()
  for (let i = 0; i < N; i++) envs.push(await z.sealEnvelope({ device: d, state: w.phone.state, secret: w.phone.secrets.get(1), chains: w.phone.chains, kind: KIND.CHAT, ...TL, payload, time: T0 }))
  console.log(`  ${'seal envelope (1 KiB: pad, encrypt, hash, sign)'.padEnd(46)} ${((performance.now() - t0) / N).toFixed(3)} ms`)
  const t1 = performance.now()
  for (const e of envs) await z.openEnvelope(e.bytes, { state: w.laptop.state, chains: w.laptop.chains, secrets: w.laptop.secrets })
  console.log(`  ${'open envelope (parse, verify, chain, decrypt)'.padEnd(46)} ${((performance.now() - t1) / N).toFixed(3)} ms`)
  const laptopChains = z.newChains()
  const t2 = performance.now()
  for (const e of envs) await z.verifyEnvelope(e.bytes, { state: w.laptop.state, chains: laptopChains })
  console.log(`  ${'verify envelope only (no decrypt)'.padEnd(46)} ${((performance.now() - t2) / N).toFixed(3)} ms`)
  const secret = w.phone.secrets.get(1)
  let sealed
  await time('wrap room key (sealed box to one member)', 500, async () => { sealed = await z.wrapEpochKey(w.phone.state, secret, w.laptop.device.id) })
  await time('unwrap room key (and check commitments)', 500, () => z.unwrapEpochKey(w.laptop.state, w.laptop.device, sealed, 1))
  await time('verify membership log (3 entries)', 200, () => z.verifyLog(w.hub.log, w.roomId))
  const mb = nodeCrypto.randomBytes(1 << 20)
  let asset
  await time('encrypt asset (1 MiB, 16 chunks)', 20, async () => { asset = await z.encryptAsset(mb) })
  await time('decrypt asset (1 MiB, 16 chunks)', 20, () => z.decryptAsset(asset.blob, asset.key))
}

const only = process.argv.find(a => a.startsWith('--only='))?.slice(7)
let failed = 0, ran = 0
const started = performance.now()
for (const t of tests) {
  if (only && !t.name.includes(only)) continue
  ran++
  try {
    await t.fn()
    console.log(`ok    ${t.name}`)
  } catch (e) {
    failed++
    console.log(`FAIL  ${t.name}\n${e.stack ?? e}`)
  }
}
console.log(`\n${ran - failed} of ${ran} tests passed in ${((performance.now() - started) / 1000).toFixed(1)} s`)
if (failed) process.exit(1)
if (!process.argv.includes('--no-bench')) await bench()
