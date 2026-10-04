// Tests for hub.mjs. Run: node crypto/hub-test.mjs
// Real clients (zcrypto.mjs) talk to the hub module the way docs/pairing.md describes; then everything a hub must refuse.
import assert from 'node:assert/strict'
import * as z from './zcrypto.mjs'
import { createHub, memoryStorage, SESSION_TTL_MS, CHALLENGE_TTL_MS, MAX_REQUESTS_PER_INVITE } from './hub.mjs'

const { ROLE, KIND, hex, utf8, concat } = z
const HUB = 'https://hub.example'
const DAY = 86400000
const TL = { timelineKind: 1, timelineId: 'session/test' }
const tests = []
const test = (name, fn) => tests.push({ name, fn })
async function rejects(fn, code) {
  let err = null
  try { await fn() } catch (e) { err = e }
  assert.ok(err, `expected ${code}, but it went through`)
  assert.ok(err instanceof z.ZError, `expected ZError(${code}), got ${err?.stack ?? err}`)
  assert.ok([].concat(code).includes(err.code), `expected ${code}, got ${err.code}: ${err.message}`)
  return err
}
const flip = (bytes, at) => { const out = bytes.slice(); out[at] ^= 1; return out }
const txt = b => new TextDecoder().decode(b)

// ---- clients, as docs/pairing.md has them speak --------------------------------

const client = (device, name) => ({ name, device, state: null, pin: null, secrets: new Map(), chains: z.newChains(), token: null, cursor: 0 })
async function signIn(w, c) {
  const res = await w.hub.signIn(await z.signHubAuth({ device: c.device, roomId: w.roomId, hub: HUB, challenge: w.hub.challenge() }))
  c.token = res.token
  return res
}
async function sync(w, c) {
  const { entries } = w.hub.log({ token: c.token })
  const state = await z.verifyLog(entries, w.roomId)
  z.checkLogAgainstPin(state, c.pin)
  c.state = state; c.pin = z.pinOf(state)
  for (const wr of w.hub.wraps(c.token, { afterEpoch: Math.max(0, ...c.secrets.keys()) })) c.secrets.set(wr.epoch, await z.unwrapEpochKey(state, c.device, wr.sealed, wr.epoch))
}
/** The whole join, over the hub. `human` joins compare the check code; an agent joins by the link alone. */
async function join(w, inviter, device, role, name, { tamper } = {}) {
  const made = await z.createInvite({ state: inviter.state, inviter: inviter.device, hub: HUB, role, now: w.now() })
  await w.hub.postInvite(inviter.token, made.offer)
  // The new device has only the link.
  const link = z.parseInviteLink(made.link)
  const inviteId = await z.hkdf(link.secret, link.roomId, z.LABEL.inviteId, new Uint8Array(0), 16)
  const served = w.hub.invite(inviteId)
  const { request, join } = await z.createJoinRequest({ link: made.link, offer: served.offer, log: served.entries, device, name, now: w.now() })
  const { requestHash } = await w.hub.postRequest(inviteId, tamper?.request ? tamper.request(request) : request)
  assert.equal(w.hub.joinStatus(inviteId, requestHash).status, 'waiting')
  // The inviter takes the first request with a valid MAC and reveals.
  const [first] = w.hub.requests(inviter.token, inviteId)
  const { reveal, code } = await z.acceptJoinRequest({ invite: made.invite, request: first, inviter: inviter.device, now: w.now() })
  await w.hub.postReveal(inviter.token, inviteId, reveal)
  const st = w.hub.joinStatus(inviteId, requestHash)
  assert.equal(st.status, 'revealed')
  const shown = await z.checkReveal({ join, reveal: st.reveal, log: served.entries })
  assert.equal(shown, code)
  const human = role === ROLE.HUMAN
  const done = await z.finalizeInvite({ invite: made.invite, state: inviter.state, inviter: inviter.device, secret: inviter.secrets.get(inviter.state.epoch), codeConfirmed: human, skipCheckCode: !human, now: w.now() })
  await w.hub.postEntry({ entry: done.entry, wraps: [{ id: device.id, sealed: done.wrap }] })
  const fin = w.hub.joinStatus(inviteId, requestHash)
  assert.equal(fin.status, 'joined')
  const joined = await z.completeJoin({ join, device, log: fin.entries, wrap: fin.wrap })
  const c = client(device, name)
  c.state = joined.state; c.pin = z.pinOf(joined.state); c.secrets.set(joined.secret.epoch, joined.secret)
  await signIn(w, c)
  await sync(w, inviter)
  return c
}
async function makeWorld({ storage = memoryStorage() } = {}) {
  let clock = 1790000000000
  const w = { storage, now: () => clock, tick: ms => { clock += ms } }
  w.hub = await createHub({ hubUrl: HUB, storage, now: w.now })
  w.code = z.generateRecoveryCode()
  const phone = client(await z.generateDevice(), 'Phone')
  const room = await z.createRoom({ device: phone.device, name: 'Phone', recovery: await z.recoveryDevice(w.code), time: clock })
  w.founded = await w.hub.found({ entry: room.entry, wraps: room.wraps })
  w.roomId = room.roomId
  phone.secrets.set(1, room.secret)
  await signIn(w, phone); await sync(w, phone)
  w.phone = phone
  w.laptop = await join(w, phone, await z.generateDevice(), ROLE.HUMAN, 'Laptop')
  w.agent = await join(w, phone, await z.generateDevice({ extractable: true }), ROLE.AGENT, 'Crypto')
  await sync(w, w.laptop)
  return w
}
async function post(w, from, opts = {}) {
  const env = await z.sealEnvelope({ device: from.device, state: from.state, secret: from.secrets.get(from.state.epoch), chains: from.chains, kind: KIND.CHAT, payload: utf8('hello'), time: w.now(), ...opts, ...(z.isThreadKind(opts.kind ?? KIND.CHAT) && !('timelineKind' in opts) ? TL : {}) })
  return { env, res: await w.hub.postEnvelope(from.token, env.bytes) }
}
async function remove(w, signer, ids) {
  const r = await z.removeMembers(signer.state, signer.device, { ids, previous: signer.secrets.get(signer.state.epoch), time: w.now() })
  const res = await w.hub.postEntry({ entry: r.entry, wraps: r.wraps, backLink: r.backLink })
  signer.secrets.set(r.secret.epoch, r.secret)
  await sync(w, signer)
  return { r, res }
}

// ---- the flows -----------------------------------------------------------------

test('first device founds the room; a second device and an agent join; everyone gets the same room key', async () => {
  const w = await makeWorld()
  assert.equal(w.hub.roomId, hex(w.roomId))
  assert.deepEqual(w.hub.members().map(m => [m.name, m.role, m.active]), [['Phone', 'human', true], ['Laptop', 'human', true], ['Crypto', 'agent', true]])
  assert.deepEqual(w.laptop.secrets.get(1).key, w.phone.secrets.get(1).key)
  assert.deepEqual(w.agent.secrets.get(1).key, w.phone.secrets.get(1).key)
  assert.equal(w.agent.secrets.get(1).hist, null)
  // A second founding is refused, also with a fresh genesis.
  const other = await z.createRoom({ device: await z.generateDevice(), recovery: await z.recoveryDevice(z.generateRecoveryCode()) })
  await rejects(() => w.hub.found({ entry: other.entry, wraps: other.wraps }), 'room-exists')
  await rejects(() => w.hub.postEntry({ entry: other.entry, wraps: other.wraps }), 'bad-entry')
})
test('an empty hub does nothing before a room is founded, and a room needs its sealed keys', async () => {
  const hub = await createHub({ hubUrl: HUB })
  await rejects(async () => hub.log({ token: 'x' }), 'unauthorised')
  const phone = await z.generateDevice()
  const room = await z.createRoom({ device: phone, recovery: await z.recoveryDevice(z.generateRecoveryCode()) })
  await rejects(() => hub.postEntry({ entry: room.entry, wraps: room.wraps }), 'no-room')
  await rejects(() => hub.found({ entry: room.entry, wraps: room.wraps.slice(0, 1) }), 'incomplete')   // no copy for the recovery key
  await rejects(() => hub.found({ entry: flip(room.entry, 90), wraps: room.wraps }), ['bad-signature', 'bad-entry', 'bad-format'])
  assert.equal(hub.roomId, null)
  await hub.found({ entry: room.entry, wraps: room.wraps })
  assert.equal(hub.roomId, hex(room.roomId))
})
test('what the hub holds opens nothing: no room key, no plaintext, in anything it stores', async () => {
  const w = await makeWorld()
  await post(w, w.phone, { kind: KIND.CARD, payload: utf8('the secret plan'), card: { id: new Uint8Array(16).fill(7), state: 1, urgency: 3 } })
  const dump = Buffer.from(JSON.stringify(w.storage._data, (k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v instanceof Map ? [...v] : v)), 'utf8')
  const all = Buffer.concat([dump, ...w.storage.entries(), ...w.storage.envelopes(0, 1e9).map(e => e.bytes), ...[...w.storage._data.wraps.values()].map(x => x.sealed)])
  for (const s of [...w.phone.secrets.values()]) for (const k of [s.key, s.hist]) assert.equal(all.includes(Buffer.from(k)), false)
  assert.equal(all.includes(Buffer.from('the secret plan')), false)
})

// ---- signing in ----------------------------------------------------------------

test('sign-in: a challenge works once and for two minutes; a token for ten; outsiders get nothing', async () => {
  const w = await makeWorld()
  const c = w.hub.challenge()
  const signed = await z.signHubAuth({ device: w.laptop.device, roomId: w.roomId, hub: HUB, challenge: c })
  const { token, role } = await w.hub.signIn(signed)
  assert.equal(role, 'human')
  await rejects(() => w.hub.signIn(signed), 'bad-challenge')                       // replayed sign-in
  const made = await z.signHubAuth({ device: w.laptop.device, roomId: w.roomId, hub: HUB, challenge: new Uint8Array(32).fill(1) })
  await rejects(() => w.hub.signIn(made), 'bad-challenge')                         // a challenge the hub never issued
  const late = w.hub.challenge()
  w.tick(CHALLENGE_TTL_MS + 1)
  await rejects(async () => w.hub.signIn(await z.signHubAuth({ device: w.laptop.device, roomId: w.roomId, hub: HUB, challenge: late })), 'bad-challenge')
  const stranger = await z.generateDevice()
  await rejects(async () => w.hub.signIn(await z.signHubAuth({ device: stranger, roomId: w.roomId, hub: HUB, challenge: w.hub.challenge() })), 'not-member')
  await rejects(async () => w.hub.signIn(await z.signHubAuth({ device: w.laptop.device, roomId: w.roomId, hub: 'https://evil.example', challenge: w.hub.challenge() })), 'wrong-hub')
  assert.equal(w.hub.wraps(token).length, 1)
  w.tick(SESSION_TTL_MS + 1)
  await rejects(async () => w.hub.wraps(token), 'unauthorised')
  await rejects(async () => w.hub.wraps('no-such-token'), 'unauthorised')
  await rejects(async () => w.hub.log({}), 'unauthorised')
})
test('sealed keys: each device gets its own and nobody else\'s; agents get no back links', async () => {
  const w = await makeWorld()
  const mine = w.hub.wraps(w.agent.token)
  assert.equal(mine.length, 1)
  await rejects(() => z.unwrapEpochKey(w.laptop.state, w.laptop.device, mine[0].sealed, 1), 'decrypt-failed')
  await remove(w, w.phone, [w.laptop.device.id])
  assert.equal(w.hub.backLinks(w.phone.token).length, 1)
  await rejects(async () => w.hub.backLinks(w.agent.token), 'forbidden')
  await sync(w, w.agent)
  assert.deepEqual(w.agent.secrets.get(2).key, w.phone.secrets.get(2).key)
})

// ---- what a hub must refuse: the member list -------------------------------------

test('refuses an entry that no current member signed: outsider, agent, forged signature, edited entry', async () => {
  const w = await makeWorld()
  const newcomer = { role: ROLE.HUMAN, name: 'Mallory', ...z.publicDevice(await z.generateDevice()) }
  const wrapFor = async (state, secret, id) => [{ id, sealed: await z.wrapEpochKey(state, secret, id) }]
  // A valid entry by the phone, re-signed by someone else.
  const good = await z.addMember(w.phone.state, w.phone.device, { member: newcomer, time: w.now() })
  const wraps = await wrapFor(good.state, w.phone.secrets.get(1), (await z.deviceId(newcomer.signPub, newcomer.kexPub)))
  const mallory = await z.generateDevice()
  const body = good.entry.slice(0, -64)
  await rejects(async () => w.hub.postEntry({ entry: concat(body, await z.sign(mallory, z.LABEL.logSig, body)), wraps }), 'bad-signature')
  for (const at of [3, 40, 90, 130, good.entry.length - 1]) await rejects(() => w.hub.postEntry({ entry: flip(good.entry, at), wraps }), ['bad-signature', 'bad-entry', 'bad-format'])
  // The agent is a member, but agents change nothing. It builds the entry by hand, correctly signed by itself.
  const be = (n, len) => { const b = new Uint8Array(len); new DataView(b.buffer).setUint32(len - 4, n); return b }
  const s = w.agent.state
  const agentBody = concat(Uint8Array.of(1, 1, 2), be(s.head.seq + 1, 4), s.head.hash, be(0, 8), Uint8Array.of(1), w.agent.device.id,
    Uint8Array.of(1), newcomer.signPub, newcomer.kexPub, Uint8Array.of(0, 0), new Uint8Array(16))
  const e = await rejects(async () => w.hub.postEntry({ entry: concat(agentBody, await z.sign(w.agent.device, z.LABEL.logSig, agentBody)), wraps }), 'bad-entry')
  assert.match(e.message, /agents may not/)
  assert.equal(w.hub.log({ token: w.phone.token }).head, 2, 'nothing was stored')
  // The honest entry goes through, once.
  await w.hub.postEntry({ entry: good.entry, wraps })
  await rejects(() => w.hub.postEntry({ entry: good.entry, wraps }), 'replay')
})
test('refuses a replayed entry and an entry built on an old head', async () => {
  const w = await makeWorld()
  const log = w.hub.log({ token: w.phone.token }).entries
  for (const entry of log) await rejects(() => w.hub.postEntry({ entry, wraps: [] }), 'replay')
  // Phone and laptop both build entry 3. The first wins, the second names a head that is gone.
  const a = await z.removeMembers(w.phone.state, w.phone.device, { ids: [w.agent.device.id], previous: w.phone.secrets.get(1), time: w.now() })
  const b = await z.removeMembers(w.laptop.state, w.laptop.device, { ids: [w.agent.device.id], previous: w.laptop.secrets.get(1), time: w.now() + 1 })
  await w.hub.postEntry({ entry: a.entry, wraps: a.wraps, backLink: a.backLink })
  await rejects(() => w.hub.postEntry({ entry: b.entry, wraps: b.wraps, backLink: b.backLink }), 'bad-entry')
})
test('refuses a removed member: its entries, its sign-in, its token, its envelopes', async () => {
  const w = await makeWorld()
  await post(w, w.laptop)
  const stale = w.laptop.token
  const late = await z.sealEnvelope({ device: w.laptop.device, state: w.laptop.state, secret: w.laptop.secrets.get(1), chains: w.laptop.chains, kind: KIND.CHAT, ...TL, payload: utf8('still here?'), time: w.now() })
  const { res } = await remove(w, w.phone, [w.laptop.device.id])
  assert.deepEqual(res.signedOut, [hex(w.laptop.device.id)])
  await rejects(async () => w.hub.wraps(stale), 'unauthorised')                       // the token died with the removal
  await rejects(() => w.hub.postEnvelope(stale, late.bytes), 'unauthorised')
  await rejects(() => signIn(w, w.laptop), 'not-member')
  // Even through another member's session its envelope is refused.
  await rejects(() => w.hub.postEnvelope(w.phone.token, late.bytes), 'wrong-sender')
  // It signs a member-list entry on the state it still has.
  const back = await z.addMember(w.laptop.state, w.laptop.device, { member: { role: ROLE.HUMAN, name: 'Back', ...z.publicDevice(await z.generateDevice()) }, time: w.now() })
  await rejects(() => w.hub.postEntry({ entry: back.entry, wraps: [] }), 'bad-entry')
  assert.equal(w.hub.wraps(w.phone.token).length, 2)
  assert.equal(w.storage.wraps(hex(w.laptop.device.id)).length, 1, 'no key of the new epoch for the removed device')
})
test('a removal must bring the new room key for everyone who stays, agents included, and the back link', async () => {
  const w = await makeWorld()
  const r = await z.removeMembers(w.phone.state, w.phone.device, { ids: [w.laptop.device.id], previous: w.phone.secrets.get(1), time: w.now() })
  const noAgent = r.wraps.filter(x => hex(x.id) !== hex(w.agent.device.id))
  await rejects(() => w.hub.postEntry({ entry: r.entry, wraps: noAgent, backLink: r.backLink }), 'incomplete')
  await rejects(() => w.hub.postEntry({ entry: r.entry, wraps: r.wraps }), 'incomplete')
  // A copy for the removed laptop on top, or a human-sized copy (with the history key) for the agent.
  const extra = [...r.wraps, { id: w.laptop.device.id, sealed: r.wraps[0].sealed }]
  await rejects(() => w.hub.postEntry({ entry: r.entry, wraps: extra, backLink: r.backLink }), 'incomplete')
  const fat = r.wraps.map(x => (hex(x.id) === hex(w.agent.device.id) ? { id: x.id, sealed: r.wraps[0].sealed } : x))
  await rejects(() => w.hub.postEntry({ entry: r.entry, wraps: fat, backLink: r.backLink }), 'bad-format')
  assert.equal(w.hub.log({ token: w.phone.token }).head, 2)
  const ok = await w.hub.postEntry({ entry: r.entry, wraps: r.wraps, backLink: r.backLink })
  assert.equal(ok.epoch, 2)
})
test('any human device removes, also the founder', async () => {
  const w = await makeWorld()
  const { res } = await remove(w, w.laptop, [w.phone.device.id])
  assert.equal(res.epoch, 2)
  assert.deepEqual(w.hub.members().filter(m => m.active).map(m => m.name), ['Laptop', 'Crypto'])
})

// ---- invites -------------------------------------------------------------------

test('invites: only a human member posts its own offer; expiry; one answer; junk does not get through', async () => {
  const w = await makeWorld()
  const made = await z.createInvite({ state: w.phone.state, inviter: w.phone.device, hub: HUB, role: ROLE.AGENT, now: w.now() })
  await rejects(() => w.hub.postInvite(w.agent.token, made.offer), 'forbidden')
  await rejects(() => w.hub.postInvite(w.laptop.token, made.offer), 'forbidden')        // another human's offer
  await rejects(() => w.hub.postInvite(w.phone.token, flip(made.offer, 60)), ['bad-signature', 'bad-invite', 'bad-format'])
  const { inviteId } = await w.hub.postInvite(w.phone.token, made.offer)
  await rejects(() => w.hub.postInvite(w.phone.token, made.offer), 'replay')
  await rejects(async () => w.hub.invite('00'.repeat(16)), 'not-found')
  const served = w.hub.invite(inviteId)
  // Requests: a wrong role, a broken signature, a member's own key, too many.
  const device = await z.generateDevice()
  const { request } = await z.createJoinRequest({ link: made.link, offer: served.offer, log: served.entries, device, name: 'Builder', now: w.now() })
  await rejects(() => w.hub.postRequest(inviteId, flip(request, request.length - 1)), 'bad-signature')
  const other = await z.createInvite({ state: w.phone.state, inviter: w.phone.device, hub: HUB, role: ROLE.AGENT, now: w.now() })
  const stray = await z.createJoinRequest({ link: other.link, offer: other.offer, log: served.entries, device, now: w.now() })
  await rejects(() => w.hub.postRequest(inviteId, stray.request), 'bad-invite')
  const { requestHash } = await w.hub.postRequest(inviteId, request)
  assert.deepEqual(await w.hub.postRequest(inviteId, request), { requestHash, inviter: hex(w.phone.device.id), repeated: true }, 'the same request twice is one request')
  await rejects(async () => w.hub.requests(w.laptop.token, inviteId), 'forbidden')
  // A second device races with the same (stolen) link. The inviter answers the first.
  const thief = await z.generateDevice()
  const raced = await z.createJoinRequest({ link: made.link, offer: served.offer, log: served.entries, device: thief, name: 'Builder', now: w.now() })
  const second = await w.hub.postRequest(inviteId, raced.request)
  const [first] = w.hub.requests(w.phone.token, inviteId)
  const { reveal } = await z.acceptJoinRequest({ invite: made.invite, request: first, inviter: w.phone.device, now: w.now() })
  await rejects(() => w.hub.postReveal(w.laptop.token, inviteId, reveal), 'forbidden')
  await w.hub.postReveal(w.phone.token, inviteId, reveal)
  await rejects(() => w.hub.postReveal(w.phone.token, inviteId, reveal), 'invite-used')
  assert.equal(w.hub.joinStatus(inviteId, second.requestHash).status, 'taken')
  assert.equal(w.hub.joinStatus(inviteId, requestHash).status, 'revealed')
  await rejects(async () => w.hub.postRequest(inviteId, (await z.createJoinRequest({ link: made.link, offer: served.offer, log: served.entries, device: await z.generateDevice(), now: w.now() })).request), 'invite-used')
  // The add entry must be the outcome of the invite: not the thief's key under the invite's id.
  const forged = await z.addMember(w.phone.state, w.phone.device, { member: { role: ROLE.AGENT, name: 'Builder', ...z.publicDevice(thief) }, inviteId: made.invite.inviteId, time: w.now() })
  await rejects(async () => w.hub.postEntry({ entry: forged.entry, wraps: [{ id: thief.id, sealed: await z.wrapEpochKey(forged.state, w.phone.secrets.get(1), thief.id) }] }), 'bad-invite')
  const done = await z.finalizeInvite({ invite: made.invite, state: w.phone.state, inviter: w.phone.device, secret: w.phone.secrets.get(1), skipCheckCode: true, now: w.now() })
  await rejects(() => w.hub.postEntry({ entry: done.entry, wraps: [] }), 'incomplete')
  await w.hub.postEntry({ entry: done.entry, wraps: [{ id: device.id, sealed: done.wrap }] })
  assert.equal(w.hub.joinStatus(inviteId, requestHash).status, 'joined')
  await rejects(async () => w.hub.invite(inviteId), 'invite-used')
  // Expiry and the cap on requests.
  const short = await z.createInvite({ state: (await z.verifyLog(w.hub.log({ token: w.phone.token }).entries, w.roomId)), inviter: w.phone.device, hub: HUB, role: ROLE.AGENT, now: w.now() })
  const sid = (await w.hub.postInvite(w.phone.token, short.offer)).inviteId
  const log = w.hub.invite(sid).entries
  for (let i = 0; i < MAX_REQUESTS_PER_INVITE; i++) await w.hub.postRequest(sid, (await z.createJoinRequest({ link: short.link, offer: short.offer, log, device: await z.generateDevice(), now: w.now() })).request)
  const more = (await z.createJoinRequest({ link: short.link, offer: short.offer, log, device: await z.generateDevice(), now: w.now() })).request
  await rejects(() => w.hub.postRequest(sid, more), 'too-many')
  w.tick(z.INVITE_TTL_MS + 1)
  await rejects(async () => w.hub.invite(sid), 'invite-expired')
  await rejects(() => w.hub.postRequest(sid, more), 'invite-expired')
  await signIn(w, w.phone)
  await rejects(() => w.hub.postInvite(w.phone.token, short.offer), ['invite-expired', 'replay'])
})
test('a hub that swaps the keys in a request gets nowhere: the inviter refuses it, the hub cannot add anyone itself', async () => {
  const w = await makeWorld()
  const made = await z.createInvite({ state: w.phone.state, inviter: w.phone.device, hub: HUB, role: ROLE.HUMAN, now: w.now() })
  const { inviteId } = await w.hub.postInvite(w.phone.token, made.offer)
  const served = w.hub.invite(inviteId)
  const hubsOwn = await z.generateDevice()
  // Without the secret behind the #, a request of the hub's own carries no valid MAC.
  const fake = z.inviteLink('https://app.example/join', HUB, w.roomId, new Uint8Array(32).fill(9))
  await rejects(() => z.createJoinRequest({ link: fake, offer: served.offer, log: served.entries, device: hubsOwn, now: w.now() }), 'bad-invite')
  const { request } = await z.createJoinRequest({ link: made.link, offer: served.offer, log: served.entries, device: await z.generateDevice(), name: 'Tablet', now: w.now() })
  const swapped = request.slice(); swapped.set(hubsOwn.signPub, request.length - 96 - 32 - 64)
  await rejects(() => z.acceptJoinRequest({ invite: made.invite, request: swapped, inviter: w.phone.device, now: w.now() }), 'bad-mac')
  assert.equal(made.invite.used, false)
})

// ---- envelopes -----------------------------------------------------------------

test('envelopes: the hub reads card id, status and urgency, nothing else; refuses replays, gaps, forks, foreign senders', async () => {
  const w = await makeWorld()
  const cardId = new Uint8Array(16).fill(0xc1)
  const { env, res } = await post(w, w.agent, { kind: KIND.CARD, payload: utf8('{"title":"Deploy?"}'), card: { id: cardId, state: z.CARD_STATE.OPEN, urgency: z.URGENCY.HIGH }, push: true })
  assert.deepEqual(res, { n: 1, push: true, card: { id: hex(cardId), state: 1, urgency: 2, answeredAt: 0 }, isHead: true, kind: KIND.CARD, recipient: null })
  await rejects(() => w.hub.postEnvelope(w.agent.token, env.bytes), 'replay')
  await rejects(() => w.hub.postEnvelope(w.phone.token, env.bytes), 'wrong-sender')
  await rejects(() => w.hub.postEnvelope(w.agent.token, flip(env.bytes, env.bytes.length - 1)), ['bad-signature', 'replay'])
  await rejects(async () => w.hub.postEnvelope(w.agent.token, await z.pruneEnvelope(env.bytes)), 'bad-format')
  // A second history under number 1 (the device lost its state), and a jump ahead.
  const twin = await z.sealEnvelope({ device: w.agent.device, state: w.agent.state, secret: w.agent.secrets.get(1), chains: z.newChains(), kind: KIND.CHAT, ...TL, payload: utf8('other'), time: w.now() })
  await rejects(() => w.hub.postEnvelope(w.agent.token, twin.bytes), 'equivocation')
  const skipped = await z.sealEnvelope({ device: w.agent.device, state: w.agent.state, secret: w.agent.secrets.get(1), chains: w.agent.chains, kind: KIND.CHAT, ...TL, time: w.now() })
  const third = await z.sealEnvelope({ device: w.agent.device, state: w.agent.state, secret: w.agent.secrets.get(1), chains: w.agent.chains, kind: KIND.CHAT, ...TL, time: w.now() })
  await rejects(() => w.hub.postEnvelope(w.agent.token, third.bytes), 'gap')
  await w.hub.postEnvelope(w.agent.token, skipped.bytes)
  await w.hub.postEnvelope(w.agent.token, third.bytes)
  // The phone fetches and opens; the recovery key and outsiders do not fetch.
  const got = w.hub.envelopes(w.phone.token)
  assert.equal(got.length, 3)
  const opened = await z.openEnvelope(got[0].bytes, { state: w.phone.state, chains: w.phone.chains, secrets: w.phone.secrets, self: w.phone.device.id })
  assert.equal(txt(opened.payload), '{"title":"Deploy?"}')
  const rec = await w.hub.signIn(await z.signHubAuth({ device: await z.recoveryDevice(w.code), roomId: w.roomId, hub: HUB, challenge: w.hub.challenge() }))
  assert.equal(rec.kind, 'recovery')
  await rejects(async () => w.hub.envelopes(rec.token), 'forbidden')
  assert.equal(w.hub.log({ token: rec.token }).head, 2)
})
test('answered cards lose their ciphertext 30 days after the answer; open cards and chat stay; chains still verify', async () => {
  const w = await makeWorld()
  const cardId = new Uint8Array(16).fill(0xc1), openId = new Uint8Array(16).fill(0xc2)
  const card = await post(w, w.agent, { kind: KIND.CARD, payload: utf8('{"title":"Deploy?"}'), card: { id: cardId, state: 1, urgency: 2 } })
  await post(w, w.agent, { kind: KIND.CARD, payload: utf8('{"title":"Still open"}'), card: { id: openId, state: 1 } })
  await post(w, w.phone, { payload: utf8('chat') })
  w.tick(DAY)
  await signIn(w, w.phone)                                  // tokens last ten minutes
  await post(w, w.phone, { kind: KIND.ANSWER, recipient: w.agent.device.id, bind: z.encodeAnswerBind({ cardId, cardHash: card.env.hash, choice: 'yes' }), card: { id: cardId, state: 2, urgency: 2, answeredAt: w.now() } })
  w.tick(29 * DAY)
  assert.deepEqual(await w.hub.prune(), { pruned: 0 })
  w.tick(DAY + 1)
  assert.deepEqual(await w.hub.prune(), { pruned: 2 })
  assert.deepEqual(await w.hub.prune(), { pruned: 0 })
  await signIn(w, w.laptop)
  const all = w.hub.envelopes(w.laptop.token)
  assert.deepEqual(all.map(e => e.pruned), [true, false, false, true])
  assert.ok(all[0].bytes.length < 400, 'header, nonce, hash and signature remain')
  // A device that comes late still verifies every chain, and reads what was not deleted.
  const chains = z.newChains()
  for (const e of all) await z.verifyEnvelope(e.bytes, { state: w.laptop.state, chains })
  assert.deepEqual(w.hub.cards().map(c => [c.id, c.state]), [[hex(cardId), 2], [hex(openId), 1]])
  // The hub restarts from its storage and keeps refusing replays.
  const again = await createHub({ hubUrl: HUB, storage: w.storage, now: w.now })
  assert.equal(again.roomId, hex(w.roomId))
  const t = (await again.signIn(await z.signHubAuth({ device: w.agent.device, roomId: w.roomId, hub: HUB, challenge: again.challenge() }))).token
  await rejects(() => again.postEnvelope(t, card.env.bytes), 'replay')
  const next = await z.sealEnvelope({ device: w.agent.device, state: w.agent.state, secret: w.agent.secrets.get(1), chains: w.agent.chains, kind: KIND.CHAT, ...TL, time: w.now() })
  assert.equal((await again.postEnvelope(t, next.bytes)).n, 5)
})

// ---- recovery ------------------------------------------------------------------

test('recovery with the code: human devices out, the agent stays, gets the new room key, and obeys the new device', async () => {
  const w = await makeWorld()
  await post(w, w.phone, { payload: utf8('before the loss') })
  // All devices are gone. A new tablet has the code and nothing else.
  const rec = await z.recoveryDevice(w.code)
  const recToken = (await w.hub.signIn(await z.signHubAuth({ device: rec, roomId: w.roomId, hub: HUB, challenge: w.hub.challenge() }))).token
  const state = await z.verifyLog(w.hub.log({ token: recToken }).entries, w.roomId)
  const recoveryWrap = w.hub.wraps(recToken).at(-1).sealed
  const tablet = client(await z.generateDevice(), 'Tablet')
  const newCode = z.generateRecoveryCode()
  const r = await z.recoverRoom({ state, code: w.code, newCode, newDevice: tablet.device, name: 'Tablet', recoveryWrap, time: w.now() })
  // A recovery that would leave the agent without a key is refused.
  await rejects(() => w.hub.postEntry({ entry: r.entry, wraps: r.wraps.filter(x => hex(x.id) !== hex(w.agent.device.id)), backLink: r.backLink }), 'incomplete')
  const stale = w.phone.token
  const res = await w.hub.postEntry({ entry: r.entry, wraps: r.wraps, backLink: r.backLink })
  assert.equal(res.epoch, 2)
  assert.deepEqual(w.hub.members().filter(m => m.active).map(m => [m.name, m.role]), [['Crypto', 'agent'], ['Tablet', 'human']])
  // Old devices and the old code are out.
  await rejects(async () => w.hub.wraps(stale), 'unauthorised')
  await rejects(async () => w.hub.log({ token: recToken }), 'unauthorised')
  await rejects(() => signIn(w, w.phone), 'not-member')
  await rejects(async () => w.hub.signIn(await z.signHubAuth({ device: rec, roomId: w.roomId, hub: HUB, challenge: w.hub.challenge() })), 'not-member')
  await rejects(() => w.hub.postEntry({ entry: r.entry, wraps: r.wraps, backLink: r.backLink }), 'replay')
  // The tablet reads history, the agent takes the new key from its wrap and accepts the tablet's command.
  await signIn(w, tablet); await sync(w, tablet)
  tablet.secrets.set(1, await z.openBackLink(tablet.state, tablet.secrets.get(2), w.hub.backLinks(tablet.token)[0].bytes))
  const old = w.hub.envelopes(tablet.token)[0]
  assert.equal(txt((await z.openEnvelope(old.bytes, { state: tablet.state, chains: tablet.chains, secrets: tablet.secrets, allowRemovedSender: true })).payload), 'before the loss')
  await signIn(w, w.agent); await sync(w, w.agent)
  assert.deepEqual(w.agent.secrets.get(2).key, r.secret.key)
  const { env } = await post(w, tablet, { recipient: w.agent.device.id, payload: utf8('carry on') })
  const cmd = await z.openEnvelope(env.bytes, { state: w.agent.state, chains: w.agent.chains, secrets: w.agent.secrets, self: w.agent.device.id })
  assert.equal(z.authoriseCommand(cmd, { state: w.agent.state, agentId: w.agent.device.id, now: w.now() }).kind, KIND.CHAT)
  // A device cannot make a recovery, and the wrong code cannot either.
  await rejects(async () => z.recoverRoom({ state: tablet.state, code: w.code, newCode: z.generateRecoveryCode(), newDevice: await z.generateDevice(), recoveryWrap, time: w.now() }), 'bad-recovery-code')
})

// ---- stable agent ids ----------------------------------------------------------

test('an agent\'s board id belongs to its key: same id after a restart, a second process with the same key is refused', async () => {
  const w = await makeWorld()
  assert.deepEqual(w.hub.claimSession(w.agent.token, { name: 'Crypto', instance: 'p1' }), { sessionId: 'crypto', device: hex(w.agent.device.id) })
  assert.equal(w.hub.claimSession(w.agent.token, { name: 'Crypto', instance: 'p1' }).sessionId, 'crypto')
  await rejects(async () => w.hub.claimSession(w.agent.token, { name: 'Crypto', instance: 'p2' }), 'instance-conflict')
  // The process ends; a new process with the same key file gets the same id, whatever name it gives.
  w.hub.releaseSession('crypto', 'p1')
  await signIn(w, w.agent)
  assert.equal(w.hub.claimSession(w.agent.token, { name: 'Renamed', instance: 'p2' }).sessionId, 'crypto')
  // Another agent with the same name gets the next id; humans have none.
  const twin = await join(w, w.phone, await z.generateDevice(), ROLE.AGENT, 'Crypto')
  assert.equal(w.hub.claimSession(twin.token, { name: 'Crypto', instance: 'p3' }).sessionId, 'crypto-2')
  await rejects(async () => w.hub.claimSession(w.phone.token, { name: 'Phone', instance: 'p4' }), 'forbidden')
  // Removed: the id is not handed to anyone else, and the key no longer signs in.
  await remove(w, w.phone, [w.agent.device.id])
  await rejects(() => signIn(w, w.agent), 'not-member')
  const third = await join(w, w.phone, await z.generateDevice(), ROLE.AGENT, 'Crypto')
  assert.equal(w.hub.claimSession(third.token, { name: 'Crypto', instance: 'p5' }).sessionId, 'crypto-3')
})

let failed = 0
const started = performance.now()
for (const t of tests) {
  try { await t.fn(); console.log(`ok    ${t.name}`) } catch (e) { failed++; console.log(`FAIL  ${t.name}\n${e.stack ?? e}`) }
}
console.log(`\n${tests.length - failed} of ${tests.length} tests passed in ${((performance.now() - started) / 1000).toFixed(1)} s`)
if (failed) process.exit(1)
