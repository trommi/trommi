// Tests for hub.mjs. Run: node crypto/hub-test.mjs
// Real clients (zcrypto.mjs) talk to the hub module the way docs/pairing.md describes; then everything a hub must refuse.
import assert from 'node:assert/strict'
import * as z from './zcrypto.mjs'
import { createSessionGrant } from './session-grants.mjs'
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

const LABELS = new Map()
const client = (device, name) => { LABELS.set(hex(device.id), name); return { name, device, state: null, pin: null, secrets: new Map(), chains: z.newChains(), token: null, cursor: 0 } }
const label = idHex => LABELS.get(idHex) ?? '?'
const SID = new Uint8Array(16).fill(0x5e)
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
  await w.hub.postEntry({ entry: done.entry, wraps: done.wrap ? [{ id: device.id, sealed: done.wrap }] : [] })
  const fin = w.hub.joinStatus(inviteId, requestHash)
  assert.equal(fin.status, 'joined')
  const joined = await z.completeJoin({ join, device, log: fin.entries, wrap: fin.wrap })
  const c = client(device, name)
  c.state = joined.state; c.pin = z.pinOf(joined.state); if (joined.secret) c.secrets.set(joined.secret.epoch, joined.secret)
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
  const room = await z.createRoom({ device: phone.device, recovery: await z.recoveryDevice(w.code), time: clock })
  w.founded = await w.hub.found({ entry: room.entry, wraps: room.wraps })
  w.roomId = room.roomId
  phone.secrets.set(1, room.secret)
  await signIn(w, phone); await sync(w, phone)
  w.phone = phone
  w.laptop = await join(w, phone, await z.generateDevice(), ROLE.HUMAN, 'Laptop')
  w.agent = await join(w, phone, await z.generateDevice({ extractable: true }), ROLE.AGENT, 'Crypto')
  await sync(w, w.laptop)
  // The agent's session: a grant by the phone, the session key sealed for both humans, the recovery key and the agent.
  const g = await createSessionGrant({ state: phone.state, signer: phone.device, sessionId: SID, agentIds: [w.agent.device.id], time: clock })
  w.grant = await w.hub.postGrant({ sessionId: hex(SID), grant: g.grant, wraps: g.wraps })
  w.session = g
  for (const c of [phone, w.laptop, w.agent]) c.session = g.secret
  return w
}
/** Default: a chat item in the agent's session, under its session key; a human's goes to the agent. */
async function post(w, from, opts = {}) {
  const kind = opts.kind ?? KIND.CHAT
  const room = opts.keyScope === 0
  const human = z.memberAt(from.state, from.device.id)?.role === ROLE.HUMAN
  const env = await z.sealEnvelope({
    device: from.device, state: from.state, chains: from.chains, kind, payload: utf8('hello'), time: w.now(),
    keyScope: room ? 0 : 1, sessionId: room ? null : SID, secret: room ? from.secrets.get(from.state.epoch) : from.session,
    ...(z.isThreadKind(kind) ? { timelineKind: 1, timelineId: room ? `desk/${'0d'.repeat(16)}` : `session/${hex(SID)}` } : {}),
    ...(z.isThreadKind(kind) && human && !room ? { recipient: w.agent.device.id } : {}),
    ...opts,
  })
  // Agents post under their lease (R4); the test process holds it as instance 'test' unless a test says otherwise.
  return { env, res: await (opts.lease ? w.hub.postEnvelope(from.token, env.bytes, opts.lease) : postAs(w, from.token, env.bytes)) }
}
/** Post as whoever the token belongs to; an agent posts under its lease (R4), held by the test process as instance 'test'. */
function postAs(w, token, bytes) {
  let lease = {}
  try { lease = { leaseGeneration: w.hub.takeLease(token, { instance: 'test' }).generation } } catch {}
  return w.hub.postEnvelope(token, bytes, lease)
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
  assert.deepEqual(w.hub.members().map(m => [label(m.id), m.role, m.active]), [['Phone', 'human', true], ['Laptop', 'human', true], ['Crypto', 'agent', true]])
  assert.deepEqual(w.laptop.secrets.get(1).key, w.phone.secrets.get(1).key)
  assert.equal(w.agent.secrets.size, 0, 'agents hold no room key (R6)')
  assert.deepEqual(w.agent.session.key, w.phone.session.key)
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
  await post(w, w.phone, { kind: KIND.CARD, payload: utf8('the secret plan'), card: { id: await z.objectIdOf(w.phone.device.id, 1), state: 1, urgency: 3 } })
  const dump = Buffer.from(JSON.stringify(w.storage._data, (k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v instanceof Map ? [...v] : v)), 'utf8')
  const all = Buffer.concat([dump, ...w.storage.entries(), ...w.storage.envelopes(0, 1e9).map(e => e.bytes), ...[...w.storage._data.wraps.values()].map(x => x.sealed), ...[...w.storage._data.sessionWraps.values()].map(x => x.sealed)])
  for (const s of [...w.phone.secrets.values(), w.phone.session]) for (const k of [s.key, s.hist]) assert.equal(all.includes(Buffer.from(k)), false)
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
test('sealed keys: each device gets its own and nobody else\'s; agents get no room key and no room back links', async () => {
  const w = await makeWorld()
  const mine = w.hub.wraps(w.laptop.token)
  assert.equal(mine.length, 1)
  assert.equal(w.hub.wraps(w.agent.token).length, 0)
  await rejects(() => z.unwrapEpochKey(w.phone.state, w.phone.device, mine[0].sealed, 1), 'decrypt-failed')
  // The agent's session key: its own sealed copy, without the history key (no history granted).
  const sk = w.hub.sessionWraps(w.agent.token, hex(SID))
  assert.equal(sk.length, 1); assert.equal(sk[0].sealed.length, 2 + 32 + 33 + 16)
  assert.equal(w.hub.sessionWraps(w.laptop.token, hex(SID))[0].sealed.length, 2 + 32 + 65 + 16)
  await remove(w, w.phone, [w.laptop.device.id])
  assert.equal(w.hub.backLinks(w.phone.token).length, 1)
  await rejects(async () => w.hub.backLinks(w.agent.token), 'forbidden')
})

// ---- what a hub must refuse: the member list -------------------------------------

test('refuses an entry that no current member signed: outsider, agent, forged signature, edited entry', async () => {
  const w = await makeWorld()
  const newcomer = { role: ROLE.HUMAN, ...z.publicDevice(await z.generateDevice()) }
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
    Uint8Array.of(1), newcomer.signPub, newcomer.kexPub, new Uint8Array(16))
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
  const late = await z.sealEnvelope({ device: w.laptop.device, state: w.laptop.state, secret: w.laptop.session, keyScope: 1, sessionId: SID, chains: w.laptop.chains, kind: KIND.CHAT, timelineKind: 1, timelineId: `session/${hex(SID)}`, recipient: w.agent.device.id, payload: utf8('still here?'), time: w.now() })
  const { res } = await remove(w, w.phone, [w.laptop.device.id])
  assert.deepEqual(res.signedOut, [hex(w.laptop.device.id)])
  await rejects(async () => w.hub.wraps(stale), 'unauthorised')                       // the token died with the removal
  await rejects(() => postAs(w, stale, late.bytes), 'unauthorised')
  await rejects(() => signIn(w, w.laptop), 'not-member')
  // Even through another member's session its envelope is refused.
  await rejects(() => postAs(w, w.phone.token, late.bytes), 'wrong-sender')
  // It signs a member-list entry on the state it still has.
  const back = await z.addMember(w.laptop.state, w.laptop.device, { member: { role: ROLE.HUMAN, ...z.publicDevice(await z.generateDevice()) }, time: w.now() })
  await rejects(() => w.hub.postEntry({ entry: back.entry, wraps: [] }), 'bad-entry')
  assert.equal(w.hub.wraps(w.phone.token).length, 2)
  assert.equal(w.storage.wraps(hex(w.laptop.device.id)).length, 1, 'no key of the new epoch for the removed device')
})
test('a removal must bring the new room key for every human device who stays and the recovery key, and the back link', async () => {
  const w = await makeWorld()
  const r = await z.removeMembers(w.phone.state, w.phone.device, { ids: [w.laptop.device.id], previous: w.phone.secrets.get(1), time: w.now() })
  assert.deepEqual(r.wraps.map(x => hex(x.id)).sort(), [w.phone.device.id, w.phone.state.recovery.id].map(hex).sort())
  const noRecovery = r.wraps.filter(x => hex(x.id) !== hex(w.phone.state.recovery.id))
  await rejects(() => w.hub.postEntry({ entry: r.entry, wraps: noRecovery, backLink: r.backLink }), 'incomplete')
  await rejects(() => w.hub.postEntry({ entry: r.entry, wraps: r.wraps }), 'incomplete')
  // A copy for the removed laptop, or one for the agent, on top: refused.
  for (const who of [w.laptop, w.agent]) await rejects(() => w.hub.postEntry({ entry: r.entry, wraps: [...r.wraps, { id: who.device.id, sealed: r.wraps[0].sealed }], backLink: r.backLink }), 'incomplete')
  assert.equal(w.hub.log({ token: w.phone.token }).head, 2)
  const ok = await w.hub.postEntry({ entry: r.entry, wraps: r.wraps, backLink: r.backLink })
  assert.equal(ok.epoch, 2)
})
test('any human device removes, also the founder', async () => {
  const w = await makeWorld()
  const { res } = await remove(w, w.laptop, [w.phone.device.id])
  assert.equal(res.epoch, 2)
  assert.deepEqual(w.hub.members().filter(m => m.active).map(m => label(m.id)), ['Laptop', 'Crypto'])
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
  const { request } = await z.createJoinRequest({ link: made.link, offer: served.offer, log: served.entries, device, now: w.now() })
  await rejects(() => w.hub.postRequest(inviteId, flip(request, request.length - 1)), 'bad-signature')
  const other = await z.createInvite({ state: w.phone.state, inviter: w.phone.device, hub: HUB, role: ROLE.AGENT, now: w.now() })
  const stray = await z.createJoinRequest({ link: other.link, offer: other.offer, log: served.entries, device, now: w.now() })
  await rejects(() => w.hub.postRequest(inviteId, stray.request), 'bad-invite')
  const { requestHash } = await w.hub.postRequest(inviteId, request)
  assert.deepEqual(await w.hub.postRequest(inviteId, request), { requestHash, inviter: hex(w.phone.device.id), repeated: true }, 'the same request twice is one request')
  await rejects(async () => w.hub.requests(w.laptop.token, inviteId), 'forbidden')
  // A second device races with the same (stolen) link. The inviter answers the first.
  const thief = await z.generateDevice()
  const raced = await z.createJoinRequest({ link: made.link, offer: served.offer, log: served.entries, device: thief, now: w.now() })
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
  const forged = await z.addMember(w.phone.state, w.phone.device, { member: { role: ROLE.AGENT, ...z.publicDevice(thief) }, inviteId: made.invite.inviteId, time: w.now() })
  await rejects(async () => w.hub.postEntry({ entry: forged.entry, wraps: [] }), 'bad-invite')
  const done = await z.finalizeInvite({ invite: made.invite, state: w.phone.state, inviter: w.phone.device, secret: w.phone.secrets.get(1), skipCheckCode: true, now: w.now() })
  assert.equal(done.wrap, null, 'an agent gets no room key')
  await rejects(async () => w.hub.postEntry({ entry: done.entry, wraps: [{ id: device.id, sealed: (await z.wrapForAll(w.phone.state, w.phone.secrets.get(1)))[0].sealed }] }), 'incomplete')
  await w.hub.postEntry({ entry: done.entry, wraps: done.wrap ? [{ id: device.id, sealed: done.wrap }] : [] })
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
  // A used invite stops answering 15 minutes after its use (M7).
  assert.equal(w.hub.joinStatus(inviteId, requestHash).status, 'joined')
  w.tick(15 * 60 * 1000)
  await rejects(async () => w.hub.joinStatus(inviteId, requestHash), 'invite-expired')
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
  const { request } = await z.createJoinRequest({ link: made.link, offer: served.offer, log: served.entries, device: await z.generateDevice(), now: w.now() })
  const swapped = request.slice(); swapped.set(hubsOwn.signPub, request.length - 96 - 32 - 64)
  await rejects(() => z.acceptJoinRequest({ invite: made.invite, request: swapped, inviter: w.phone.device, now: w.now() }), 'bad-mac')
  assert.equal(made.invite.used, false)
})

// ---- envelopes -----------------------------------------------------------------

test('envelopes: the hub reads card id, status and urgency, nothing else; refuses replays, gaps, forks, foreign senders', async () => {
  const w = await makeWorld()
  const cardId = await z.objectIdOf(w.agent.device.id, 1)
  const { env, res } = await post(w, w.agent, { kind: KIND.CARD, payload: utf8('{"title":"Deploy?"}'), card: { id: cardId, state: z.CARD_STATE.OPEN, urgency: z.URGENCY.HIGH }, push: true })
  assert.deepEqual(res, { n: 1, push: true, card: { id: hex(cardId), state: 1, urgency: 2, answeredAt: 0 }, isHead: true, kind: KIND.CARD, recipient: null })
  await rejects(() => postAs(w, w.agent.token, env.bytes), 'replay')
  await rejects(() => postAs(w, w.phone.token, env.bytes), 'wrong-sender')
  await rejects(() => postAs(w, w.agent.token, flip(env.bytes, env.bytes.length - 1)), ['bad-signature', 'replay'])
  await rejects(async () => postAs(w, w.agent.token, await z.pruneEnvelope(env.bytes)), 'bad-format')
  // A second history under number 1 (the device lost its state), and a jump ahead.
  const sess = { keyScope: 1, sessionId: SID, secret: w.agent.session, kind: KIND.CHAT, timelineKind: 1, timelineId: `session/${hex(SID)}` }
  const twin = await z.sealEnvelope({ device: w.agent.device, state: w.agent.state, chains: z.newChains(), ...sess, payload: utf8('other'), time: w.now() })
  await rejects(() => postAs(w, w.agent.token, twin.bytes), 'equivocation')
  const skipped = await z.sealEnvelope({ device: w.agent.device, state: w.agent.state, chains: w.agent.chains, ...sess, time: w.now() })
  const third = await z.sealEnvelope({ device: w.agent.device, state: w.agent.state, chains: w.agent.chains, ...sess, time: w.now() })
  await rejects(() => postAs(w, w.agent.token, third.bytes), 'gap')
  await postAs(w, w.agent.token, skipped.bytes)
  await postAs(w, w.agent.token, third.bytes)
  // The phone fetches and opens; the recovery key and outsiders do not fetch.
  const got = w.hub.envelopes(w.phone.token)
  assert.equal(got.length, 3)
  const opened = await z.openEnvelope(got[0].bytes, { state: w.phone.state, chains: w.phone.chains, secrets: () => w.phone.session, self: w.phone.device.id })
  assert.equal(txt(opened.payload), '{"title":"Deploy?"}')
  const rec = await w.hub.signIn(await z.signHubAuth({ device: await z.recoveryDevice(w.code), roomId: w.roomId, hub: HUB, challenge: w.hub.challenge() }))
  assert.equal(rec.kind, 'recovery')
  await rejects(async () => w.hub.envelopes(rec.token), 'forbidden')
  assert.equal(w.hub.log({ token: rec.token }).head, 2)
})
test('answered cards lose their ciphertext 30 days after the answer; open cards and chat stay; chains still verify', async () => {
  const w = await makeWorld()
  const cardId = await z.objectIdOf(w.agent.device.id, 1), openId = await z.objectIdOf(w.agent.device.id, 2)
  const card = await post(w, w.agent, { kind: KIND.CARD, payload: utf8('{"title":"Deploy?"}'), card: { id: cardId, state: 1, urgency: 2 } })
  await post(w, w.agent, { kind: KIND.CARD, payload: utf8('{"title":"Still open"}'), card: { id: openId, state: 1 } })
  await post(w, w.phone, { payload: utf8('chat') })
  w.tick(DAY)
  await signIn(w, w.phone)                                  // tokens last ten minutes
  // The answer's answered_at is a claim; retention counts from when the hub received the answer.
  await post(w, w.phone, { kind: KIND.ANSWER, recipient: w.agent.device.id, bind: z.encodeAnswerBind({ cardId, cardHash: card.env.hash, choice: 'yes' }), card: { id: cardId, state: 2, urgency: 2, answeredAt: 1 } })
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
  const lease = { leaseGeneration: again.takeLease(t, { instance: 'after-restart' }).generation }
  await rejects(() => again.postEnvelope(t, card.env.bytes, lease), 'replay')
  const next = await z.sealEnvelope({ device: w.agent.device, state: w.agent.state, keyScope: 1, sessionId: SID, secret: w.agent.session, chains: w.agent.chains, kind: KIND.CHAT, timelineKind: 1, timelineId: `session/${hex(SID)}`, time: w.now() })
  assert.equal((await again.postEnvelope(t, next.bytes, lease)).n, 5)
})

// ---- recovery ------------------------------------------------------------------

test('recovery with the code: human devices out, the agent stays, gets the new room key, and obeys the new device', async () => {
  const w = await makeWorld()
  const before = await post(w, w.phone, { keyScope: 0, payload: utf8('before the loss') })
  // All devices are gone. A new tablet has the code and nothing else.
  const rec = await z.recoveryDevice(w.code)
  const recToken = (await w.hub.signIn(await z.signHubAuth({ device: rec, roomId: w.roomId, hub: HUB, challenge: w.hub.challenge() }))).token
  const state = await z.verifyLog(w.hub.log({ token: recToken }).entries, w.roomId)
  const recoveryWrap = w.hub.wraps(recToken).at(-1).sealed
  const tablet = client(await z.generateDevice(), 'Tablet')
  const newCode = z.generateRecoveryCode()
  const r = await z.recoverRoom({ state, code: w.code, newCode, newDevice: tablet.device, recoveryWrap, time: w.now(), cuts: { [hex(w.phone.device.id)]: { seq: 1, hash: before.env.hash } } })
  // A recovery that would leave the new device without a key is refused.
  await rejects(() => w.hub.postEntry({ entry: r.entry, wraps: r.wraps.filter(x => hex(x.id) !== hex(tablet.device.id)), backLink: r.backLink }), 'incomplete')
  const stale = w.phone.token
  const res = await w.hub.postEntry({ entry: r.entry, wraps: r.wraps, backLink: r.backLink })
  assert.equal(res.epoch, 2)
  assert.deepEqual(w.hub.members().filter(m => m.active).map(m => [label(m.id), m.role]), [['Crypto', 'agent'], ['Tablet', 'human']])
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
  // The tablet re-seals the agent's session key to itself and everyone (a grant), then talks to the agent.
  await signIn(w, w.agent); await sync(w, w.agent)
  const g2 = await createSessionGrant({ state: tablet.state, signer: tablet.device, sessionState: w.session.sessionState, rotate: true, current: w.session.secret, agentIds: [w.agent.device.id], time: w.now() })
  await w.hub.postGrant({ sessionId: hex(SID), grant: g2.grant, wraps: g2.wraps, backLink: g2.backLink })
  tablet.session = g2.secret; w.agent.session = g2.secret
  const { env } = await post(w, tablet, { recipient: w.agent.device.id, payload: utf8('carry on') })
  const cmd = await z.openEnvelope(env.bytes, { state: w.agent.state, chains: w.agent.chains, secrets: () => w.agent.session, self: w.agent.device.id })
  assert.equal(z.authoriseCommand(cmd, { state: w.agent.state, agentId: w.agent.device.id, now: w.now(), sessionEpoch: 2 }).kind, KIND.CHAT)
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

// ---- the review's proofs of concept, as regression tests (scratchpad/poc.mjs) -----------

test('PoC1: another agent cannot close, and so prune, an agent\'s open card', async () => {
  const w = await makeWorld()
  const victim = await z.objectIdOf(w.agent.device.id, 1)
  await post(w, w.agent, { kind: KIND.CARD, card: { id: victim, state: 1, urgency: 1 } })
  const bot = await join(w, w.phone, await z.generateDevice(), ROLE.AGENT, 'Bot')
  await sync(w, w.phone)
  const g = await createSessionGrant({ state: w.phone.state, signer: w.phone.device, sessionId: new Uint8Array(16).fill(0x77), agentIds: [bot.device.id], time: w.now() })
  await w.hub.postGrant({ sessionId: '77'.repeat(16), grant: g.grant, wraps: g.wraps })
  // Under its own session key, and under the victim's session key (it is not assigned there): both refused.
  const forged = z.sealEnvelope({ device: bot.device, state: bot.state, chains: bot.chains, keyScope: 1, sessionId: new Uint8Array(16).fill(0x77), secret: g.secret, kind: KIND.CARD, card: { id: victim, state: 3, urgency: 3, answeredAt: 1 }, push: true, time: w.now() })
  await rejects(async () => postAs(w, bot.token, (await forged).bytes), 'forbidden')
  bot.chains = z.newChains()
  await rejects(async () => postAs(w, bot.token, (await z.sealEnvelope({ device: bot.device, state: bot.state, chains: bot.chains, keyScope: 1, sessionId: SID, secret: w.agent.session, kind: KIND.CARD, card: { id: victim, state: 3, urgency: 3, answeredAt: 1 }, time: w.now() })).bytes), 'forbidden')
  w.tick(31 * DAY)
  assert.deepEqual(await w.hub.prune(), { pruned: 0 })
})
test('PoC2: a crashed agent comes back: a new process takes the lease over, the old one gets lease-lost', async () => {
  const w = await makeWorld()
  const a = w.hub.takeLease(w.agent.token, { instance: 'p1' })
  assert.equal(w.hub.takeLease(w.agent.token, { instance: 'p1' }).generation, a.generation, 'the same process renews')
  const b = w.hub.takeLease(w.agent.token, { instance: 'p2' })
  assert.ok(b.generation > a.generation); assert.equal(b.previousInstance, 'p1')
  // The old process's renewal does not take it back (no ping-pong): lease-lost; the holder still renews.
  await rejects(async () => w.hub.takeLease(w.agent.token, { instance: 'p1', renew: true }), 'lease-lost')
  assert.equal(w.hub.takeLease(w.agent.token, { instance: 'p2', renew: true }).generation, b.generation)
  await rejects(() => post(w, w.agent, { lease: { leaseGeneration: a.generation } }), 'lease-lost')
  w.agent.chains = z.newChains()                              // the refused envelope was never stored
  assert.equal((await post(w, w.agent, { lease: { leaseGeneration: b.generation } })).res.n, 1)
  await rejects(async () => w.hub.takeLease(w.phone.token, { instance: 'p3' }), 'forbidden')
  // Fencing is required, not optional (review 2 #8): a post without a generation is lease-lost too.
  await rejects(() => post(w, w.agent, { lease: {} }), 'lease-lost')
})
test('PoC3: a sender that never saw a removal is refused in the old epoch two minutes after it, by the hub too', async () => {
  const w = await makeWorld()
  // The laptop misses the removal of the phone's tablet; it keeps sending room-scope envelopes in epoch 1.
  const tablet = await join(w, w.phone, await z.generateDevice(), ROLE.HUMAN, 'Tablet')
  await sync(w, w.laptop)
  const staleState = w.laptop.state
  await remove(w, w.phone, [tablet.device.id])
  const sealOld = () => z.sealEnvelope({ device: w.laptop.device, state: staleState, secret: w.laptop.secrets.get(1), chains: w.laptop.chains, kind: KIND.TIMELINE_ITEM, timelineKind: 2, timelineId: `desk/${'0d'.repeat(16)}`, time: w.now() })
  assert.ok((await postAs(w, w.laptop.token, (await sealOld()).bytes)).n, 'within the grace it still goes through')
  w.tick(2 * 60 * 1000 + 1)
  await signIn(w, w.laptop)
  await rejects(async () => postAs(w, w.laptop.token, (await sealOld()).bytes), 'wrong-epoch')
})
test('PoC4: an object id belongs to its creator; nobody squats on another agent\'s card', async () => {
  const w = await makeWorld()
  const mine = await z.objectIdOf(w.agent.device.id, 1)
  await post(w, w.agent, { kind: KIND.CARD, card: { id: mine, state: 1, urgency: 1 } })
  // The phone posts a "version" of the agent's card, and a new object under an id that is not its own.
  await rejects(() => post(w, w.phone, { kind: KIND.CARD, card: { id: mine, state: 2, urgency: 3 } }), 'forbidden')
  w.phone.chains = z.newChains()
  await rejects(() => post(w, w.phone, { kind: KIND.CARD, card: { id: new Uint8Array(16).fill(9), state: 1, urgency: 3 } }), 'forbidden')
  assert.deepEqual(w.hub.cards().map(c => [c.id, c.state]), [[hex(mine), 1]])
})
test('who may write what: answers go to the creator, chat on a card from its creator or to it, verdicts answer requests', async () => {
  const w = await makeWorld()
  const card = await z.objectIdOf(w.agent.device.id, 1)
  await post(w, w.agent, { kind: KIND.CARD, card: { id: card, state: 1, urgency: 1 } })
  // An answer addressed to the laptop instead of the card's creator.
  await rejects(() => post(w, w.phone, { kind: KIND.ANSWER, card: { id: card, state: 2 }, recipient: w.laptop.device.id }), 'forbidden')
  w.phone.chains = z.newChains()
  await post(w, w.phone, { kind: KIND.ANSWER, card: { id: card, state: 2 }, recipient: w.agent.device.id })
  // An agent answers nothing; a verdict needs a permission request.
  await rejects(() => post(w, w.agent, { kind: KIND.ANSWER, card: { id: card, state: 2 }, recipient: w.agent.device.id }), 'forbidden')
  await rejects(() => post(w, w.laptop, { kind: KIND.VERDICT, card: { id: card, state: 3 }, recipient: w.agent.device.id }), 'forbidden')
  w.laptop.chains = z.newChains()
  // Chat on the card: the creator, or a human to the creator.
  await post(w, w.laptop, { timelineId: `card/${hex(card)}`, recipient: w.agent.device.id })
  await rejects(() => post(w, w.laptop, { timelineId: `card/${hex(card)}`, recipient: null }), 'forbidden')
  // A human's message in the session goes to its agent.
  w.laptop.chains = z.newChains(); w.laptop.chains.set(z.b64u(w.laptop.device.id), { seq: 1, hash: (await z.verifyEnvelope(w.storage.envelopes(0, 9).at(-1).bytes, { state: w.laptop.state, chains: z.newChains(), allowChainStart: true })).hash, hashes: new Map() })
  await rejects(() => post(w, w.laptop, { recipient: null }), 'forbidden')
  // Desks are for humans; agents cannot even seal under the room key.
  await rejects(() => post(w, w.agent, { keyScope: 0, secret: w.phone.secrets.get(1) }), 'forbidden')
})
test('session grants: the wrap set must match, removed signers and agents are refused, only assigned agents speak', async () => {
  const w = await makeWorld()
  const other = new Uint8Array(16).fill(0x42)
  const g = await createSessionGrant({ state: w.phone.state, signer: w.phone.device, sessionId: other, agentIds: [], time: w.now() })
  await rejects(() => w.hub.postGrant({ sessionId: hex(other), grant: g.grant, wraps: g.wraps.slice(1) }), 'incomplete')
  await rejects(() => w.hub.postGrant({ sessionId: hex(other), grant: g.grant, wraps: [...g.wraps.slice(1), { id: g.wraps[0].id, sealed: g.wraps[1].sealed }] }), 'bad-grant')
  await rejects(() => w.hub.postGrant({ sessionId: '43'.repeat(16), grant: g.grant, wraps: g.wraps }), 'bad-argument')
  await w.hub.postGrant({ sessionId: hex(other), grant: g.grant, wraps: g.wraps })
  // The agent is not assigned to this session: it cannot speak in it.
  const s2 = { keyScope: 1, sessionId: other, secret: g.secret, kind: KIND.CHAT, timelineKind: 1, timelineId: `session/${hex(other)}` }
  await rejects(async () => postAs(w, w.agent.token, (await z.sealEnvelope({ device: w.agent.device, state: w.agent.state, chains: z.newChains(), ...s2, time: w.now() })).bytes), 'forbidden')
  // Unassigning the agent from its session: a new session key epoch without it; it can no longer speak there.
  const un = await createSessionGrant({ state: w.phone.state, signer: w.phone.device, sessionState: w.session.sessionState, rotate: true, current: w.session.secret, agentIds: [], time: w.now() })
  await rejects(() => w.hub.postGrant({ sessionId: hex(SID), grant: un.grant, wraps: un.wraps }), 'incomplete')   // no back link
  await w.hub.postGrant({ sessionId: hex(SID), grant: un.grant, wraps: un.wraps, backLink: un.backLink })
  await rejects(() => post(w, w.agent), 'forbidden')
  assert.equal((await w.hub.sessionInfo(hex(SID))).epoch, 2)
  // Agents read session back links only where the grant gave history.
  await rejects(async () => w.hub.sessionBackLinks(w.agent.token, hex(SID)), 'forbidden')
  assert.equal((await w.hub.sessionBackLinks(w.laptop.token, hex(SID))).length, 1)
})
test('R5: a status body is at most 4 KiB padded', async () => {
  const w = await makeWorld()
  await rejects(() => post(w, w.agent, { kind: KIND.STATUS, payload: new Uint8Array(5000) }), 'too-large')
  w.agent.chains = z.newChains()
  assert.equal((await post(w, w.agent, { kind: KIND.STATUS, payload: new Uint8Array(3000) })).res.n, 1)
})
test('C16: a recovery code that was replaced cannot keep reading', async () => {
  const w = await makeWorld()
  const rec = await z.recoveryDevice(w.code)
  const t = (await w.hub.signIn(await z.signHubAuth({ device: rec, roomId: w.roomId, hub: HUB, challenge: w.hub.challenge() }))).token
  const state = await z.verifyLog(w.hub.log({ token: t }).entries, w.roomId)
  const r = await z.recoverRoom({ state, code: w.code, newCode: z.generateRecoveryCode(), newDevice: await z.generateDevice(), recoveryWrap: w.hub.wraps(t).at(-1).sealed, time: w.now() })
  await w.hub.postEntry({ entry: r.entry, wraps: r.wraps, backLink: r.backLink })
  await rejects(async () => w.hub.log({ token: t }), 'unauthorised')
  await rejects(async () => w.hub.signIn(await z.signHubAuth({ device: rec, roomId: w.roomId, hub: HUB, challenge: w.hub.challenge() })), 'not-member')
})
test('passphrase sign-in: the recovery key adds one human device without an invite', async () => {
  const w = await makeWorld()
  const rec = await z.recoveryDevice(w.code)
  const fresh = await z.generateDevice()
  const added = await z.addMember(w.phone.state, rec, { member: { role: ROLE.HUMAN, ...z.publicDevice(fresh) }, time: w.now() })
  await w.hub.postEntry({ entry: added.entry, wraps: [{ id: fresh.id, sealed: await z.wrapEpochKey(added.state, w.phone.secrets.get(1), fresh.id) }] })
  assert.equal(w.hub.members().filter(m => m.active && m.role === 'human').length, 3)
  // Not an agent, and not with an invite id.
  await rejects(async () => z.addMember(added.state, rec, { member: { role: ROLE.AGENT, ...z.publicDevice(await z.generateDevice()) }, time: w.now() }), 'bad-entry')
})

test('review 2 #1/#3: after a removal, session posts wait for the re-key; a removed human\'s grant is refused', async () => {
  const w = await makeWorld()
  const laptopView = w.laptop.state                       // the laptop's frozen view of the log
  await post(w, w.agent)                                  // fine before the removal
  await remove(w, w.phone, [w.laptop.device.id])
  w.tick(1000)
  // The session key is one the removed laptop holds: nobody sends under it until a human re-keys.
  const old = await z.sealEnvelope({ device: w.agent.device, state: w.agent.state, chains: w.agent.chains, kind: KIND.CHAT, payload: utf8('retry'), time: w.now(), keyScope: 1, sessionId: SID, secret: w.agent.session, timelineKind: 1, timelineId: `session/${hex(SID)}` })
  await rejects(() => w.hub.postEnvelope(w.agent.token, old.bytes), 'stale-session-key')
  // The removed laptop rotates on its old view (the B02 PoC): refused, even though it names a log entry from before its removal.
  const forged = await createSessionGrant({ state: laptopView, signer: w.laptop.device, sessionState: w.session.sessionState, agentIds: [w.agent.device.id], rotate: true, time: w.now() })
  await rejects(() => w.hub.postGrant({ sessionId: hex(SID), grant: forged.grant, wraps: forged.wraps, backLink: forged.backLink }), 'stale-grant')
  // A same-epoch re-seal by the phone after the removal is refused too: the key must change.
  await rejects(async () => createSessionGrant({ state: w.phone.state, signer: w.phone.device, sessionState: w.session.sessionState, current: w.session.secret, agentIds: [w.agent.device.id], time: w.now() }), 'bad-grant')
  // The phone re-keys; from then on the agent posts under the new key. The same retried bytes of the old epoch land within the grace.
  const g = await createSessionGrant({ state: w.phone.state, signer: w.phone.device, sessionState: w.session.sessionState, current: w.session.secret, agentIds: [w.agent.device.id], rotate: true, time: w.now() })
  await w.hub.postGrant({ sessionId: hex(SID), grant: g.grant, wraps: g.wraps, backLink: g.backLink })
  await w.hub.postEnvelope(w.agent.token, old.bytes)
  w.agent.session = g.secret
  await post(w, w.agent)
})

let failed = 0
const started = performance.now()
for (const t of tests) {
  try { await t.fn(); console.log(`ok    ${t.name}`) } catch (e) { failed++; console.log(`FAIL  ${t.name}\n${e.stack ?? e}`) }
}
console.log(`\n${tests.length - failed} of ${tests.length} tests passed in ${((performance.now() - started) / 1000).toFixed(1)} s`)
if (failed) process.exit(1)
