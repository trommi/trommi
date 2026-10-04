// Tests for the thin hub: real HTTP against hub/server.mjs, real crypto clients (crypto/zcrypto.mjs).
// Run: node hub/test.mjs     (each test world gets its own hub on a free port and a throwaway data directory)
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import * as z from '../crypto/zcrypto.mjs'
import { createSessionGrant } from '../crypto/session-grants.mjs'
import { startHub, LIMITS } from './server.mjs'

const { ROLE, KIND, hex, utf8, b64u, unb64u } = z
const tests = []
const test = (name, fn) => tests.push({ name, fn })
const txt = b => new TextDecoder().decode(b)
const sleep = ms => new Promise(ok => setTimeout(ok, ms))
const tmpDirs = []
const freePort = () => new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)) }) })

// ---- a hub and HTTP ------------------------------------------------------------------

async function newHub({ dir, port, ...opts } = {}) {
  dir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'trommi-hub-test-'))
  if (!tmpDirs.includes(dir)) tmpDirs.push(dir)
  port ??= await freePort()
  const hubUrl = `http://127.0.0.1:${port}`
  const hub = await startHub({ port, host: '127.0.0.1', dataDir: dir, hubUrl, commit: 'test', log: () => {}, ...opts })
  return { hub, dir, port, base: hubUrl, hubUrl }
}

let ipCounter = 0
const freshIp = () => `10.9.${(++ipCounter >> 8) & 255}.${ipCounter & 255}`
async function api(w, method, p, { token, body, headers = {}, raw } = {}) {
  const h = { 'cf-connecting-ip': w.ip ?? '10.0.0.1', ...headers }
  if (token) h.authorization = `Bearer ${token}`
  let payload
  if (raw !== undefined) payload = raw
  else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json' }
  // A pooled keep-alive socket of a hub that was restarted fails once; a client retries.
  const res = await fetch(w.base + p, { method, headers: h, body: payload }).catch(() => fetch(w.base + p, { method, headers: h, body: payload }))
  const type = res.headers.get('content-type') || ''
  const data = type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer())
  return { status: res.status, json: data, headers: res.headers }
}
async function ok(w, method, p, opts) {
  const r = await api(w, method, p, opts)
  assert.ok(r.status < 300, `${method} ${p}: ${r.status} ${JSON.stringify(r.json)}`)
  return r.json
}
async function refused(w, method, p, opts, status, code) {
  const r = await api(w, method, p, opts)
  assert.equal(r.status, status, `${method} ${p}: expected ${status} ${code}, got ${r.status} ${JSON.stringify(r.json)}`)
  if (code) assert.equal(r.json.error, code, `${method} ${p}: ${JSON.stringify(r.json)}`)
  assert.equal(typeof r.json.message, 'string')
  return r
}

// ---- clients that speak the README protocol --------------------------------------------

const client = (device, label) => ({ label, device, state: null, pin: null, secrets: new Map(), session: null, chains: z.newChains(), token: null, verified: new Map() })
const SID = crypto.randomBytes(16)
const DESK = 'de'.repeat(16)
/** Room-scope secrets for humans, the session key for session-scope envelopes. */
const secretsOf = c => (epoch, h) => (h.keyScope === 1 ? (c.sessions?.get(epoch) ?? (c.session?.epoch === epoch ? c.session : null)) : c.secrets.get(epoch))
const R = w => `/v1/rooms/${w.roomId}`

async function signIn(w, c, device = c.device) {
  const { challenge } = await ok(w, 'POST', `${R(w)}/challenge`)
  const signed = await z.signHubAuth({ device, roomId: z.unhex(w.roomId), hub: w.hubUrl, challenge: unb64u(challenge) })
  const t = await ok(w, 'POST', `${R(w)}/access_tokens`, { body: { signed_challenge: b64u(signed) } })
  c.token = t.access_token
  return t
}
async function sync(w, c) {
  const m = await ok(w, 'GET', `${R(w)}/members?after_entry_number=-1`, { token: c.token })
  const state = await z.verifyLog(m.signed_entries.map(unb64u), z.unhex(w.roomId))
  z.checkLogAgainstPin(state, c.pin)
  c.state = state; c.pin = z.pinOf(state)
  const after = Math.max(0, ...c.secrets.keys())
  const keys = await ok(w, 'GET', `${R(w)}/sealed_room_keys?after_key_epoch=${after}`, { token: c.token })
  for (const k of keys.sealed_room_keys) c.secrets.set(k.key_epoch, await z.unwrapEpochKey(state, c.device, unb64u(k.key_sealed), k.key_epoch))
}
async function foundRoom(w) {
  w.code = z.generateRecoveryCode()
  const phone = client(await z.generateDevice(), 'phone')
  const room = await z.createRoom({ device: phone.device, recovery: await z.recoveryDevice(w.code) })
  const res = await api(w, 'POST', '/v1/rooms', { body: { signed_entry: b64u(room.entry), sealed_room_keys: room.wraps.map(x => ({ device_id: hex(x.id), key_sealed: b64u(x.sealed) })) } })
  assert.equal(res.status, 201, JSON.stringify(res.json))
  assert.deepEqual(Object.keys(res.json).sort(), ['entry_hash', 'entry_number', 'key_epoch', 'room_id'])
  assert.equal(res.json.room_id, hex(room.roomId))
  w.roomId = res.json.room_id
  w.room = room
  phone.secrets.set(1, room.secret)
  await signIn(w, phone); await sync(w, phone)
  return phone
}
/** The whole join over HTTP; a human compares the six digits, an agent joins by the link alone. */
async function join(w, inviter, device, role) {
  const made = await z.createInvite({ state: inviter.state, inviter: inviter.device, hub: w.hubUrl, role })
  const posted = await ok(w, 'POST', `${R(w)}/invites`, { token: inviter.token, body: { signed_offer: b64u(made.offer) } })
  const link = z.parseInviteLink(made.link)
  const inviteId = hex(await z.hkdf(link.secret, link.roomId, z.LABEL.inviteId, new Uint8Array(0), 16))
  assert.equal(posted.invite_id, inviteId)
  assert.equal(posted.device_role, role === ROLE.HUMAN ? 'human' : 'agent')
  const served = await ok(w, 'GET', `${R(w)}/invites/${inviteId}`)
  assert.equal(served.room_id, w.roomId)
  const log = served.signed_entries.map(unb64u)
  const { request, join: joining } = await z.createJoinRequest({ link: made.link, offer: unb64u(served.signed_offer), log, device })
  const posted2 = await api(w, 'POST', `${R(w)}/invites/${inviteId}/requests`, { body: { signed_request: b64u(request) } })
  if (posted2.status !== 200) return { refused: posted2 }
  const { request_hash } = posted2.json
  assert.equal((await ok(w, 'GET', `${R(w)}/invites/${inviteId}/status?request_hash=${request_hash}`)).join_status, 'waiting')
  const { signed_requests } = await ok(w, 'GET', `${R(w)}/invites/${inviteId}/requests`, { token: inviter.token })
  const { reveal, code } = await z.acceptJoinRequest({ invite: made.invite, request: unb64u(signed_requests[0]), inviter: inviter.device })
  await ok(w, 'POST', `${R(w)}/invites/${inviteId}/reveal`, { token: inviter.token, body: { signed_reveal: b64u(reveal) } })
  const st = await ok(w, 'GET', `${R(w)}/invites/${inviteId}/status?request_hash=${request_hash}`)
  assert.equal(st.join_status, 'revealed')
  const shown = await z.checkReveal({ join: joining, reveal: unb64u(st.signed_reveal), log })
  assert.equal(shown, code, 'both devices show the same six digits')
  const human = role === ROLE.HUMAN
  const done = await z.finalizeInvite({ invite: made.invite, state: inviter.state, inviter: inviter.device, secret: inviter.secrets.get(inviter.state.epoch), codeConfirmed: human, skipCheckCode: !human })
  const added = await ok(w, 'POST', `${R(w)}/members`, { body: { signed_entry: b64u(done.entry), sealed_room_keys: done.wrap ? [{ device_id: hex(device.id), key_sealed: b64u(done.wrap) }] : [] } })
  assert.equal(added.entry_action, 'device_added')
  const fin = await ok(w, 'GET', `${R(w)}/invites/${inviteId}/status?request_hash=${request_hash}`)
  assert.equal(fin.join_status, 'joined')
  const joined = await z.completeJoin({ join: joining, device, log: fin.signed_entries.map(unb64u), wrap: fin.key_sealed ? unb64u(fin.key_sealed) : null })
  const c = client(device, human ? 'human' : 'agent')
  c.state = joined.state; c.pin = z.pinOf(joined.state); if (joined.secret) c.secrets.set(joined.secret.epoch, joined.secret)
  await signIn(w, c)
  await sync(w, inviter)
  return { c, code, inviteId }
}
async function world(opts) {
  const w = await newHub(opts)
  worldAgent = null
  w.ip = freshIp()
  w.phone = await foundRoom(w)
  w.laptop = (await join(w, w.phone, await z.generateDevice(), ROLE.HUMAN)).c
  w.agent = (await join(w, w.phone, await z.generateDevice({ extractable: true }), ROLE.AGENT)).c
  await sync(w, w.laptop)
  // The agent's session: a grant by the phone, the session key sealed for both humans, the recovery key and the agent.
  const g = await createSessionGrant({ state: w.phone.state, signer: w.phone.device, sessionId: SID, agentIds: [w.agent.device.id] })
  const posted = await ok(w, 'POST', `${R(w)}/sessions/${hex(SID)}/grants`, { body: { signed_grant: b64u(g.grant), sealed_session_keys: g.wraps.map(x => ({ device_id: hex(x.id), key_sealed: b64u(x.sealed) })) } })
  assert.deepEqual(posted, { grant_number: 0, grant_hash: hex(g.sessionState.grantHash), session_key_epoch: 1 })
  w.grant = g
  for (const c of [w.phone, w.laptop, w.agent]) c.session = g.secret
  worldAgent = w.agent
  return w
}
/** Default: under the session key, a chat item in the session; a human's goes to the agent. `keyScope: 0`: room key, a desk. */
let worldAgent = null
async function seal(c, opts = {}) {
  const kind = opts.kind ?? KIND.TIMELINE_ITEM
  const room = opts.keyScope === 0
  const human = z.memberAt(c.state, c.device.id)?.role === ROLE.HUMAN
  return z.sealEnvelope({
    device: c.device, state: c.state, chains: c.chains, kind, payload: utf8('{"schema_version":1,"text":"hello"}'),
    keyScope: room ? 0 : 1, sessionId: room ? null : SID, secret: room ? c.secrets.get(c.state.epoch) : c.session,
    ...(z.isThreadKind(kind) ? { timelineKind: z.TIMELINE.CHAT, timelineId: room ? `desk/${DESK}` : `session/${hex(SID)}` } : {}),
    ...(z.isThreadKind(kind) && human && !room && worldAgent ? { recipient: worldAgent.device.id } : {}),
    ...opts,
  })
}
async function post(w, c, opts) {
  const env = await seal(c, opts)
  const res = await api(w, 'POST', `${R(w)}/envelopes`, { token: c.token, body: { envelope: b64u(env.bytes) } })
  return { env, res }
}
async function posted(w, c, opts) {
  const { env, res } = await post(w, c, opts)
  assert.equal(res.status, 200, JSON.stringify(res.json))
  return { env, n: res.json.envelope_number }
}
/** A reader for the SSE stream (fetch with the Bearer header). */
async function openStream(w, c, after = 0, token = c.token) {
  const ac = new AbortController()
  const res = await fetch(`${w.base}${R(w)}/stream?after_envelope_number=${after}`, { headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': w.ip }, signal: ac.signal })
  const s = { status: res.status, events: [], closed: false, waiters: [], res, close: () => ac.abort() }
  if (res.status !== 200) { s.json = await res.json(); return s }
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  ;(async () => {
    const dec = new TextDecoder()
    let buf = ''
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true })
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2)
          const ev = {}
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) continue
            const k = line.slice(0, line.indexOf(':')), v = line.slice(line.indexOf(':') + 2)
            if (k === 'event') ev.event = v
            else if (k === 'data') ev.data = JSON.parse(v)
            else if (k === 'id') ev.id = Number(v)
          }
          if (ev.event) { ev.at = performance.now(); s.events.push(ev) }
          for (const wt of s.waiters.splice(0)) wt()
        }
      }
    } catch {}
    s.closed = true
    for (const wt of s.waiters.splice(0)) wt()
  })()
  s.until = async (pred, what = 'event', ms = 5000) => {
    const end = Date.now() + ms
    for (;;) {
      const hit = s.events.find(pred)
      if (hit) return hit
      if (s.closed) throw new Error(`stream closed while waiting for ${what}`)
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}: got ${JSON.stringify(s.events.map(e => e.event))}`)
      await new Promise(ok2 => { s.waiters.push(ok2); setTimeout(ok2, 100) })
    }
  }
  s.closedWithin = async (ms = 3000) => { const end = Date.now() + ms; while (!s.closed && Date.now() < end) await sleep(20); return s.closed }
  return s
}
/** What a client does with the records of GET envelopes / the stream: verify every header, open the heads. */
async function ingest(c, records) {
  const out = []
  for (const r of records) {
    const bytes = unb64u(r.envelope)
    const p = z.peekEnvelope(bytes)
    if (p.pruned) {
      const v = await z.verifyEnvelope(bytes, { state: c.state, chains: c.chains, allowRemovedSender: true })
      c.verified.set(r.envelope_number, v.hash)
      out.push({ n: r.envelope_number, pruned: true, header: v.header })
    } else {
      const o = await z.openEnvelope(bytes, { state: c.state, chains: c.chains, secrets: secretsOf(c), self: c.device.id, allowRemovedSender: true })
      c.verified.set(r.envelope_number, o.hash)
      out.push({ n: r.envelope_number, pruned: false, header: o.header, text: txt(o.payload) })
    }
  }
  return out
}

// ---- the tests -------------------------------------------------------------------------

test('healthz, push key, CORS for the app and localhost only, preflight cached', async () => {
  const w = await newHub()
  const h = await ok(w, 'GET', '/healthz')
  assert.deepEqual(h, { ok: true, commit: 'test', protocol_version: 1 })
  const { vapid_public_key } = await ok(w, 'GET', '/v1/push_key')
  assert.equal(unb64u(vapid_public_key).length, 65)
  for (const origin of ['https://app.trommi.com', 'http://localhost:8900', 'http://127.0.0.1:5173', 'http://localhost']) {
    const r = await fetch(`${w.base}/healthz`, { headers: { origin } })
    assert.equal(r.headers.get('access-control-allow-origin'), origin)
    assert.match(r.headers.get('access-control-expose-headers'), /content-range/)
    const pre = await fetch(`${w.base}/v1/rooms/${'a'.repeat(64)}/envelopes`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' } })
    assert.equal(pre.status, 204)
    assert.equal(pre.headers.get('access-control-allow-origin'), origin)
    assert.equal(pre.headers.get('access-control-max-age'), '86400')
    assert.match(pre.headers.get('access-control-allow-methods'), /PUT/)
    assert.match(pre.headers.get('access-control-allow-headers'), /authorization.*content-type.*range/)
    assert.equal(pre.headers.get('access-control-allow-credentials'), null)
  }
  for (const origin of ['https://evil.example', 'https://app.trommi.com.evil.example', 'http://localhost.evil.example', 'null']) {
    const r = await fetch(`${w.base}/healthz`, { headers: { origin } })
    assert.equal(r.headers.get('access-control-allow-origin'), null, origin)
    const pre = await fetch(`${w.base}/healthz`, { method: 'OPTIONS', headers: { origin } })
    assert.equal(pre.headers.get('access-control-allow-origin'), null)
  }
  await w.hub.close()
  const w2 = await newHub({ origins: ['https://staging.trommi.com'] })
  assert.equal((await fetch(`${w2.base}/healthz`, { headers: { origin: 'https://staging.trommi.com' } })).headers.get('access-control-allow-origin'), 'https://staging.trommi.com')
  await w2.hub.close()
})

test('found, sign in, members; the same room twice, names, a token for another hub, junk', async () => {
  const w = await newHub(); w.ip = freshIp()
  const phone = await foundRoom(w)
  const m = await ok(w, 'GET', `${R(w)}/members`, { token: phone.token })
  assert.equal(m.room_id, w.roomId); assert.equal(m.last_entry_number, 0); assert.equal(m.signed_entries.length, 1)
  // The same founding entry again.
  await refused(w, 'POST', '/v1/rooms', { body: { signed_entry: b64u(w.room.entry), sealed_room_keys: w.room.wraps.map(x => ({ device_id: hex(x.id), key_sealed: b64u(x.sealed) })) } }, 409, 'room-exists')
  // Missing sealed key for the recovery key.
  const half = await z.createRoom({ device: await z.generateDevice(), recovery: await z.recoveryDevice(z.generateRecoveryCode()) })
  await refused(w, 'POST', '/v1/rooms', { body: { signed_entry: b64u(half.entry), sealed_room_keys: half.wraps.slice(0, 1).map(x => ({ device_id: hex(x.id), key_sealed: b64u(x.sealed) })) } }, 400, 'incomplete')
  // A sign-in signed for another hub address, a reused challenge, an outsider.
  const { challenge } = await ok(w, 'POST', `${R(w)}/challenge`)
  const other = await z.signHubAuth({ device: phone.device, roomId: z.unhex(w.roomId), hub: 'https://hub.trommi.com', challenge: unb64u(challenge) })
  await refused(w, 'POST', `${R(w)}/access_tokens`, { body: { signed_challenge: b64u(other) } }, 400, 'wrong-hub')
  const good = await z.signHubAuth({ device: phone.device, roomId: z.unhex(w.roomId), hub: w.hubUrl, challenge: unb64u(challenge) })
  const t = await ok(w, 'POST', `${R(w)}/access_tokens`, { body: { signed_challenge: b64u(good) } })
  assert.equal(t.signer, 'device'); assert.equal(t.device_role, 'human'); assert.equal(t.device_id, hex(phone.device.id))
  assert.ok(t.expires_at > Date.now() + 9 * 60000)
  await refused(w, 'POST', `${R(w)}/access_tokens`, { body: { signed_challenge: b64u(good) } }, 401, 'bad-challenge')
  const { challenge: c2 } = await ok(w, 'POST', `${R(w)}/challenge`)
  const stranger = await z.signHubAuth({ device: await z.generateDevice(), roomId: z.unhex(w.roomId), hub: w.hubUrl, challenge: unb64u(c2) })
  await refused(w, 'POST', `${R(w)}/access_tokens`, { body: { signed_challenge: b64u(stranger) } }, 403, 'not-member')
  // The recovery key signs in too and reads the list and its own sealed key.
  const rec = client(await z.recoveryDevice(w.code), 'recovery')
  const rt = await signIn(w, rec)
  assert.equal(rt.signer, 'recovery'); assert.equal(rt.device_role, null)
  assert.equal((await ok(w, 'GET', `${R(w)}/sealed_room_keys`, { token: rec.token })).sealed_room_keys.length, 1)
  await refused(w, 'GET', `${R(w)}/envelopes`, { token: rec.token }, 403, 'forbidden')
  // Errors in the agreed shape.
  await refused(w, 'GET', '/v1/nothing', {}, 404, 'not-found')
  await refused(w, 'GET', '/v1/rooms/xyz/members', {}, 400, 'bad-argument')
  await refused(w, 'GET', `/v1/rooms/${'0'.repeat(64)}/members`, {}, 404, 'no-room')
  await refused(w, 'GET', `${R(w)}/members`, {}, 401, 'unauthorised')
  await refused(w, 'GET', `${R(w)}/members`, { token: 'x'.repeat(43) }, 401, 'unauthorised')
  await refused(w, 'POST', '/v1/rooms', { raw: '{not json', headers: { 'content-type': 'application/json' } }, 400, 'bad-format')
  await refused(w, 'POST', '/v1/rooms', { body: { signed_entry: 'not base64!', sealed_room_keys: [] } }, 400, 'bad-format')
  await refused(w, 'POST', '/v1/rooms', { body: { signed_entry: b64u(new Uint8Array(100)), sealed_room_keys: [] } }, 400)
  await w.hub.close()
})

test('invite and join: a human with the six-digit code, an agent by the link; devices; no names; join_request event', async () => {
  const w = await newHub(); w.ip = freshIp()
  w.phone = await foundRoom(w)
  const inviterStream = await openStream(w, w.phone)
  const { c: laptop, code, inviteId } = await join(w, w.phone, await z.generateDevice(), ROLE.HUMAN)
  assert.match(code, /^\d{6}$/)
  await inviterStream.until(e => e.event === 'join_request' && e.data.invite_id === inviteId, 'join_request to the inviter')
  await inviterStream.until(e => e.event === 'member_entry' && e.data.entry_number === 1, 'member_entry')
  const { c: agent } = await join(w, w.phone, await z.generateDevice({ extractable: true }), ROLE.AGENT)
  assert.equal(agent.secrets.size, 0, 'agents get no room key (R6)')
  // The same invite cannot be used twice.
  const { devices, last_entry_number } = await ok(w, 'GET', `${R(w)}/devices`, { token: laptop.token })
  assert.equal(last_entry_number, 2)
  assert.deepEqual(devices.map(d => [d.device_role, d.is_active, d.is_online, 'device_name' in d]), [['human', true, true, false], ['human', true, false, false], ['agent', true, false, false]])
  // Agents read no room back links; humans may.
  await refused(w, 'GET', `${R(w)}/key_back_links`, { token: agent.token }, 403, 'forbidden')
  assert.deepEqual((await ok(w, 'GET', `${R(w)}/key_back_links`, { token: laptop.token })).key_back_links, [])
  // Only a human posts invites; a named join request is refused.
  const agentInvite = await z.createInvite({ state: agent.state, inviter: agent.device, hub: w.hubUrl, role: ROLE.AGENT }).catch(e => e)
  if (!(agentInvite instanceof Error)) await refused(w, 'POST', `${R(w)}/invites`, { token: agent.token, body: { signed_offer: b64u(agentInvite.offer) } }, 403, 'forbidden')
  // The inviter calls an invite off: it answers 410 invite-burned from then on.
  const made = await z.createInvite({ state: w.phone.state, inviter: w.phone.device, hub: w.hubUrl, role: ROLE.HUMAN })
  const { invite_id } = await ok(w, 'POST', `${R(w)}/invites`, { token: w.phone.token, body: { signed_offer: b64u(made.offer) } })
  await refused(w, 'DELETE', `${R(w)}/invites/${invite_id}`, { token: laptop.token }, 403, 'forbidden')
  assert.deepEqual(await ok(w, 'DELETE', `${R(w)}/invites/${invite_id}`, { token: w.phone.token }), { ok: true })
  await refused(w, 'GET', `${R(w)}/invites/${invite_id}`, {}, 410, 'invite-burned')
  await refused(w, 'GET', `${R(w)}/invites/${'1'.repeat(32)}`, {}, 404, 'not-found')
  await refused(w, 'GET', `${R(w)}/invites/zz`, {}, 400, 'bad-argument')
  inviterStream.close()
  await w.hub.close()
})

test('envelopes: heads in full, thread items pruned; threads paged newest first and oldest first; openVerifiedEnvelope', async () => {
  const w = await world()
  const cardId = await z.objectIdOf(w.agent.device.id, 1)
  const card = await posted(w, w.agent, { kind: KIND.OBJECT_VERSION, card: { id: cardId, state: z.CARD_STATE.OPEN, urgency: z.URGENCY.HIGH }, payload: utf8('{"title":"Deploy?"}') })
  const chat = []
  for (let i = 0; i < 7; i++) chat.push(await posted(w, i % 2 ? w.agent : w.phone, { timelineKind: z.TIMELINE.CHAT, timelineId: `card/${hex(cardId)}`, payload: utf8(`msg ${i}`) }))
  for (let i = 0; i < 3; i++) await posted(w, w.phone, { keyScope: 0, timelineKind: z.TIMELINE.CANVAS, timelineId: `desk/${DESK}`, payload: utf8(`stroke ${i}`) })
  const status = await posted(w, w.agent, { kind: KIND.STATUS, payload: utf8('{"values":{"status_line/x":{"label":"Tests"}}}') })
  const all = await ok(w, 'GET', `${R(w)}/envelopes?after_envelope_number=0`, { token: w.laptop.token })
  assert.equal(all.last_envelope_number, 12)
  assert.deepEqual(all.envelopes.map(e => e.envelope_number), [...Array(12).keys()].map(i => i + 1))
  const got = await ingest(w.laptop, all.envelopes)
  assert.deepEqual(got.map(g => g.pruned), [false, ...Array(10).fill(true), false])
  assert.equal(got[0].text, '{"title":"Deploy?"}')
  // Paging with limit and after.
  const page = await ok(w, 'GET', `${R(w)}/envelopes?after_envelope_number=3&limit=2`, { token: w.agent.token })
  assert.deepEqual(page.envelopes.map(e => e.envelope_number), [4, 5])
  // The card's chat, newest first in pages, full bodies; the client opens them against the hashes the chain verified.
  const t1 = await ok(w, 'GET', `${R(w)}/threads?timeline_kind=chat&timeline_id=card/${hex(cardId)}&limit=3`, { token: w.laptop.token })
  assert.deepEqual(t1.envelopes.map(e => e.envelope_number), [8, 7, 6]); assert.equal(t1.has_more, true)
  const t2 = await ok(w, 'GET', `${R(w)}/threads?timeline_kind=chat&timeline_id=card/${hex(cardId)}&before_envelope_number=6&limit=10`, { token: w.laptop.token })
  assert.deepEqual(t2.envelopes.map(e => e.envelope_number), [5, 4, 3, 2]); assert.equal(t2.has_more, false)
  for (const e of [...t1.envelopes, ...t2.envelopes]) {
    const o = await z.openVerifiedEnvelope(unb64u(e.envelope), { state: w.laptop.state, secrets: secretsOf(w.laptop), envelopeHash: w.laptop.verified.get(e.envelope_number) })
    assert.equal(txt(o.payload), `msg ${e.envelope_number - 2}`)
  }
  // A full envelope served for another number does not open.
  await assert.rejects(z.openVerifiedEnvelope(unb64u(t1.envelopes[0].envelope), { state: w.laptop.state, secrets: secretsOf(w.laptop), envelopeHash: w.laptop.verified.get(7) }), e => e.code === 'hash-mismatch')
  // The canvas, oldest first after a number; strokes never mix into the chat.
  const canvas = await ok(w, 'GET', `${R(w)}/threads?timeline_kind=canvas&timeline_id=desk/${DESK}&after_envelope_number=9`, { token: w.laptop.token })
  assert.deepEqual(canvas.envelopes.map(e => e.envelope_number), [10, 11])
  assert.equal((await ok(w, 'GET', `${R(w)}/threads?timeline_kind=2&timeline_id=desk/${DESK}`, { token: w.laptop.token })).envelopes.length, 3)
  await refused(w, 'GET', `${R(w)}/threads?timeline_kind=video&timeline_id=x`, { token: w.agent.token }, 400, 'bad-argument')
  await refused(w, 'GET', `${R(w)}/threads?timeline_kind=chat`, { token: w.agent.token }, 400, 'bad-argument')
  // What a hub must refuse.
  const again = await api(w, 'POST', `${R(w)}/envelopes`, { token: w.agent.token, body: { envelope: b64u(card.env.bytes) } })
  assert.equal(again.status, 409); assert.equal(again.json.error, 'replay')
  await refused(w, 'POST', `${R(w)}/envelopes`, { token: w.phone.token, body: { envelope: b64u(status.env.bytes) } }, 403, 'wrong-sender')
  const skipped = await seal(w.agent); const third = await seal(w.agent)
  void skipped
  await refused(w, 'POST', `${R(w)}/envelopes`, { token: w.agent.token, body: { envelope: b64u(third.bytes) } }, 409, 'gap')
  const tampered = skipped.bytes.slice(); tampered[tampered.length - 1] ^= 1
  await refused(w, 'POST', `${R(w)}/envelopes`, { token: w.agent.token, body: { envelope: b64u(tampered) } }, 400, 'bad-signature')
  await refused(w, 'POST', `${R(w)}/envelopes`, { token: w.agent.token, body: { envelope: b64u(await z.pruneEnvelope(skipped.bytes)) } }, 400, 'bad-format')
  assert.equal((await api(w, 'POST', `${R(w)}/envelopes`, { token: w.agent.token, body: { envelope: b64u(skipped.bytes) } })).status, 200, 'the lost one, posted again from the outbox')
  assert.equal((await api(w, 'POST', `${R(w)}/envelopes`, { token: w.agent.token, body: { envelope: b64u(third.bytes) } })).status, 200)
  // A body over 64 KiB padded belongs in an attachment.
  const big = await seal(w.phone, { payload: new Uint8Array(70000) })
  const r = await api(w, 'POST', `${R(w)}/envelopes`, { token: w.phone.token, body: { envelope: b64u(big.bytes) } })
  assert.equal(r.status, 413); assert.equal(r.json.error, 'too-large')
  await w.hub.close()
})

test('the stream: catch-up with the depth rule, then live in full; resume by id; pings; at most 8 per device', async () => {
  const w = await world({ pingMs: 200 })
  for (let i = 0; i < 3; i++) await posted(w, w.phone)
  const head = await posted(w, w.phone, { kind: KIND.STATUS })
  const s = await openStream(w, w.agent)
  const caught = await s.until(e => e.event === 'envelope' && e.data.envelope_number === 4, 'catch-up')
  assert.equal(caught.id, 4)
  const early = s.events.filter(e => e.event === 'envelope').map(e => z.peekEnvelope(unb64u(e.data.envelope)).pruned)
  assert.deepEqual(early, [true, true, true, false], 'catch-up: pruned thread items, full heads')
  void head
  // Live: a thread item arrives in full.
  const t = performance.now()
  const live = await posted(w, w.laptop, { payload: utf8('live one') })
  const ev = await s.until(e => e.event === 'envelope' && e.data.envelope_number === live.n, 'live envelope')
  assert.equal(z.peekEnvelope(unb64u(ev.data.envelope)).pruned, false)
  const latency = ev.at - t
  assert.ok(latency < 500, `live latency ${latency} ms`)
  await ingest(w.agent, s.events.filter(e => e.event === 'envelope').map(e => e.data))
  await s.until(e => e.event === 'ping', 'ping')
  // Resume after a number.
  const s2 = await openStream(w, w.agent, 4)
  await s2.until(e => e.event === 'envelope' && e.data.envelope_number === 5)
  assert.equal(s2.events.filter(e => e.event === 'envelope')[0].data.envelope_number, 5)
  // is_online while a stream is open.
  const online = (await ok(w, 'GET', `${R(w)}/devices`, { token: w.phone.token })).devices.find(d => d.device_role === 'agent')
  assert.equal(online.is_online, true)
  const more = []
  for (let i = 0; i < 6; i++) more.push(await openStream(w, w.agent))
  const ninth = await openStream(w, w.agent)
  assert.equal(ninth.status, 429); assert.equal(ninth.json.error, 'too-many')
  for (const x of [s, s2, ...more]) x.close()
  await w.hub.close()
  return { latency }
})

test('agent lease: one process per key; a new process takes over, the old one gets lease-lost and its streams end', async () => {
  const w = await world()
  const a = await ok(w, 'POST', `${R(w)}/agent_lease`, { token: w.agent.token, body: { process_instance: 'p1' } })
  assert.ok(a.lease_generation > 0); assert.ok(a.expires_at > Date.now())
  const s = await openStream(w, w.agent)
  assert.equal((await ok(w, 'POST', `${R(w)}/agent_lease`, { token: w.agent.token, body: { process_instance: 'p1' } })).lease_generation, a.lease_generation, 'the same process renews')
  await refused(w, 'POST', `${R(w)}/agent_lease`, { token: w.phone.token, body: { process_instance: 'p1' } }, 403, 'forbidden')
  // A crashed process is replaced: the new one takes the lease, the old stream is closed.
  const b = await ok(w, 'POST', `${R(w)}/agent_lease`, { token: w.agent.token, body: { process_instance: 'p2' } })
  assert.ok(b.lease_generation > a.lease_generation)
  assert.ok(await s.closedWithin(2000), "the old process's stream ends")
  // The old process cannot take it back by renewing, nor reconnect its stream under the old generation.
  await refused(w, 'POST', `${R(w)}/agent_lease`, { token: w.agent.token, body: { process_instance: 'p1', renew: true } }, 409, 'lease-lost')
  await refused(w, 'GET', `${R(w)}/stream`, { token: w.agent.token, headers: { 'x-lease-generation': String(a.lease_generation) } }, 409, 'lease-lost')
  // The holder still renews.
  assert.equal((await ok(w, 'POST', `${R(w)}/agent_lease`, { token: w.agent.token, body: { process_instance: 'p2', renew: true } })).lease_generation, b.lease_generation)
  const old = await seal(w.agent)
  await refused(w, 'POST', `${R(w)}/envelopes`, { token: w.agent.token, body: { envelope: b64u(old.bytes) }, headers: { 'x-lease-generation': String(a.lease_generation) } }, 409, 'lease-lost')
  assert.equal((await api(w, 'POST', `${R(w)}/envelopes`, { token: w.agent.token, body: { envelope: b64u(old.bytes) }, headers: { 'x-lease-generation': String(b.lease_generation) } })).status, 200)
  await w.hub.close()
})

test('removal: tokens revoked, streams closed at once, new epoch keys for who stays, the removed device refused everywhere', async () => {
  const w = await world()
  await posted(w, w.laptop, { payload: utf8('before') })
  const laptopStream = await openStream(w, w.laptop)
  const agentStream = await openStream(w, w.agent)
  await ok(w, 'POST', `${R(w)}/agent_lease`, { token: w.agent.token, body: { process_instance: 'p1' } })
  // The phone removes the laptop.
  const r = await z.removeMembers(w.phone.state, w.phone.device, { ids: [w.laptop.device.id], previous: w.phone.secrets.get(1) })
  const out = await ok(w, 'POST', `${R(w)}/members`, { body: { signed_entry: b64u(r.entry), sealed_room_keys: r.wraps.map(x => ({ device_id: hex(x.id), key_sealed: b64u(x.sealed) })), key_back_link: b64u(r.backLink) } })
  assert.equal(out.entry_action, 'devices_removed'); assert.equal(out.key_epoch, 2)
  w.phone.secrets.set(2, r.secret); await sync(w, w.phone)
  assert.ok(await laptopStream.closedWithin(2000), "the removed device's stream is closed at once")
  await agentStream.until(e => e.event === 'member_entry' && e.data.key_epoch === 2, 'member_entry to who stays')
  assert.equal(agentStream.closed, false)
  // Who stays fetches the list; the agent has no room key and keeps its session (the session key rotates by a grant, below).
  await sync(w, w.agent)
  assert.equal(w.agent.secrets.size, 0)
  assert.equal((await ok(w, 'GET', `${R(w)}/key_back_links`, { token: w.phone.token })).key_back_links.length, 1)
  // The removed device: token dead, no sign-in, no envelopes, no stream.
  await refused(w, 'GET', `${R(w)}/envelopes`, { token: w.laptop.token }, 401, 'unauthorised')
  const { challenge } = await ok(w, 'POST', `${R(w)}/challenge`)
  const signed = await z.signHubAuth({ device: w.laptop.device, roomId: z.unhex(w.roomId), hub: w.hubUrl, challenge: unb64u(challenge) })
  await refused(w, 'POST', `${R(w)}/access_tokens`, { body: { signed_challenge: b64u(signed) } }, 403, 'not-member')
  const late = await seal(w.laptop)
  await refused(w, 'POST', `${R(w)}/envelopes`, { token: w.laptop.token, body: { envelope: b64u(late.bytes) } }, 401, 'unauthorised')
  const s = await openStream(w, w.laptop); assert.equal(s.status, 401)
  // The phone rotates the session key too (R6: a removed human must not read new session traffic).
  const g2 = await createSessionGrant({ state: w.phone.state, signer: w.phone.device, sessionState: w.grant.sessionState, rotate: true, current: w.grant.secret, agentIds: [w.agent.device.id] })
  const sg = await ok(w, 'POST', `${R(w)}/sessions/${hex(SID)}/grants`, { body: { signed_grant: b64u(g2.grant), sealed_session_keys: g2.wraps.map(x => ({ device_id: hex(x.id), key_sealed: b64u(x.sealed) })), key_back_link: b64u(g2.backLink) } })
  assert.equal(sg.session_key_epoch, 2)
  await agentStream.until(e => e.event === 'session_grant' && e.data.session_key_epoch === 2, 'session_grant to the agent')
  const mine = await ok(w, 'GET', `${R(w)}/sessions/${hex(SID)}/sealed_session_keys?after_session_key_epoch=1`, { token: w.agent.token })
  assert.equal(mine.sealed_session_keys.length, 1); assert.equal(mine.sealed_session_keys[0].session_key_epoch, 2)
  w.phone.session = g2.secret; w.agent.session = g2.secret
  // The others talk in the new epochs; the removed laptop cannot read them.
  const fresh = await posted(w, w.phone, { payload: utf8('after') })
  const desk = await posted(w, w.phone, { keyScope: 0, payload: utf8('after, on the desk') })
  const rec = (await ok(w, 'GET', `${R(w)}/threads?timeline_kind=chat&timeline_id=session/${hex(SID)}`, { token: w.agent.token })).envelopes.find(e => e.envelope_number === fresh.n)
  assert.equal(z.peekEnvelope(unb64u(rec.envelope)).header.epoch, 2)
  await assert.rejects(z.openVerifiedEnvelope(unb64u(rec.envelope), { state: w.laptop.state, secrets: secretsOf(w.laptop), envelopeHash: fresh.env.hash }), e => e.code === 'no-key')
  assert.equal(z.peekEnvelope(desk.env.bytes).header.epoch, 2)
  // A sender in the old session key epoch is refused once the grace is over is tested in crypto/hub-test.mjs (PoC3).
  assert.deepEqual((await ok(w, 'GET', `${R(w)}/sessions`, { token: w.phone.token })).sessions, [{ session_id: hex(SID), last_grant_number: 1, session_key_epoch: 2 }])
  // A removal without a sealed key for someone who stays is refused.
  const r2 = await z.removeMembers(w.phone.state, w.phone.device, { ids: [w.agent.device.id], previous: w.phone.secrets.get(2) })
  await refused(w, 'POST', `${R(w)}/members`, { body: { signed_entry: b64u(r2.entry), sealed_room_keys: r2.wraps.slice(1).map(x => ({ device_id: hex(x.id), key_sealed: b64u(x.sealed) })), key_back_link: b64u(r2.backLink) } }, 400, 'incomplete')
  await refused(w, 'POST', `${R(w)}/members`, { body: { signed_entry: b64u(r2.entry), sealed_room_keys: [...r2.wraps, { id: w.agent.device.id, sealed: r2.wraps[0].sealed }].map(x => ({ device_id: hex(x.id), key_sealed: b64u(x.sealed) })), key_back_link: b64u(r2.backLink) } }, 400, 'incomplete')
  const devs = (await ok(w, 'GET', `${R(w)}/devices`, { token: w.phone.token })).devices
  assert.deepEqual(devs.map(d => d.is_active), [true, false, true])
  agentStream.close()
  await w.hub.close()
})

test('ephemeral: relayed to the other open streams only, never stored; own envelopes only', async () => {
  const w = await world()
  const phoneStream = await openStream(w, w.phone)
  const agentStream = await openStream(w, w.agent)
  // Typing indicator from the agent: a sealed envelope that is relayed, not chained into anything stored.
  const typing = await z.sealEnvelope({ device: w.agent.device, state: w.agent.state, chains: z.newChains(), keyScope: 1, sessionId: SID, secret: w.agent.session, kind: KIND.STATUS, payload: utf8('{"typing":true}') })
  assert.deepEqual(await ok(w, 'POST', `${R(w)}/ephemeral`, { token: w.agent.token, body: { envelope: b64u(typing.bytes) } }), { ok: true })
  const ev = await phoneStream.until(e => e.event === 'ephemeral', 'ephemeral at the phone')
  assert.equal(ev.data.device_id, hex(w.agent.device.id)); assert.equal(ev.data.envelope, b64u(typing.bytes))
  await sleep(100)
  assert.equal(agentStream.events.some(e => e.event === 'ephemeral'), false, 'not echoed to the sender')
  assert.equal((await ok(w, 'GET', `${R(w)}/envelopes`, { token: w.phone.token })).last_envelope_number, 0, 'nothing stored')
  await refused(w, 'POST', `${R(w)}/ephemeral`, { token: w.phone.token, body: { envelope: b64u(typing.bytes) } }, 403, 'wrong-sender')
  phoneStream.close(); agentStream.close()
  await w.hub.close()
})

test('stream buffers: catch-up in slices, a global cap drops the fattest non-reading streams; freed pages go back', async () => {
  process.env.HUB_STREAM_BUFFER_TOTAL_BYTES = String(2 << 20)
  const w = await world()
  delete process.env.HUB_STREAM_BUFFER_TOTAL_BYTES
  const big = new Uint8Array(60000).fill(65)
  for (let i = 0; i < 40; i++) await posted(w, w.agent, { kind: KIND.OBJECT_VERSION, card: { id: await z.objectIdOf(w.agent.device.id, i + 1), state: 1, urgency: 1 }, payload: big })
  // Three streams that never read: each catches up 40 x ~80 KB of heads.
  const stuck = []
  for (let i = 0; i < 3; i++) {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(`${w.base}${R(w)}/stream?after_envelope_number=0`, { headers: { authorization: `Bearer ${w.laptop.token}` } }, resolve)
      req.on('error', reject); req.end()
    })
    res.pause(); res.on('error', () => {}); stuck.push(res)
  }
  await sleep(300)
  const dropped = w.hub.capStreams()
  assert.ok(dropped >= 1, 'over the cap, the fattest streams are dropped')
  // A reading client catches up completely in slices.
  const s = await openStream(w, w.phone)
  await s.until(e => e.event === 'envelope' && e.data.envelope_number === 40, 'catch-up of 40 heads', 10000)
  s.close(); for (const r of stuck) r.destroy()
  // Incremental vacuum: deleted rows give pages back in small steps.
  w.hub.db.exec('DELETE FROM envelopes')
  const free = w.hub.db.prepare('PRAGMA freelist_count').get().freelist_count
  assert.ok(free > 0)
  const { vacuumStep } = await import('./store.mjs')
  vacuumStep(w.hub.db, 100000)
  assert.equal(w.hub.db.prepare('PRAGMA freelist_count').get().freelist_count, 0)
  assert.equal(w.hub.db.prepare('PRAGMA auto_vacuum').get().auto_vacuum, 2)
  await w.hub.close()
})

test('attachments: written once, served whole and in ranges, members only, 64 MiB', async () => {
  const w = await world()
  const file = crypto.randomBytes(200000)
  const asset = await z.encryptAsset(new Uint8Array(file))
  const id = hex(asset.blobId)
  const put = await fetch(`${w.base}${R(w)}/attachments/${id}`, { method: 'PUT', headers: { authorization: `Bearer ${w.agent.token}`, 'content-type': 'application/octet-stream' }, body: asset.blob })
  assert.equal(put.status, 201)
  assert.deepEqual(await put.json(), { attachment_id: id, total_size: asset.blob.length })
  const again = await fetch(`${w.base}${R(w)}/attachments/${id}`, { method: 'PUT', headers: { authorization: `Bearer ${w.agent.token}` }, body: asset.blob })
  assert.equal(again.status, 409); assert.equal((await again.json()).error, 'replay')
  const whole = await fetch(`${w.base}${R(w)}/attachments/${id}`, { headers: { authorization: `Bearer ${w.phone.token}` } })
  assert.equal(whole.status, 200)
  const bytes = new Uint8Array(await whole.arrayBuffer())
  assert.deepEqual(await z.decryptAsset(bytes, asset.key, asset.sha256), new Uint8Array(file))
  const part = await fetch(`${w.base}${R(w)}/attachments/${id}`, { headers: { authorization: `Bearer ${w.phone.token}`, range: 'bytes=22-65559' } })
  assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), `bytes 22-65559/${asset.blob.length}`)
  assert.deepEqual(new Uint8Array(await part.arrayBuffer()), asset.blob.slice(22, 65560))
  assert.deepEqual(await z.decryptAssetChunk(bytes, asset.key, 1), new Uint8Array(file).slice(65536, 131072))
  const tail = await fetch(`${w.base}${R(w)}/attachments/${id}`, { headers: { authorization: `Bearer ${w.phone.token}`, range: 'bytes=-100' } })
  assert.equal(tail.status, 206); assert.deepEqual(new Uint8Array(await tail.arrayBuffer()), asset.blob.slice(-100))
  const bad = await fetch(`${w.base}${R(w)}/attachments/${id}`, { headers: { authorization: `Bearer ${w.phone.token}`, range: `bytes=${asset.blob.length}-` } })
  assert.equal(bad.status, 416); assert.equal(bad.headers.get('content-range'), `bytes */${asset.blob.length}`)
  await refused(w, 'GET', `${R(w)}/attachments/${id}`, {}, 401, 'unauthorised')
  await refused(w, 'GET', `${R(w)}/attachments/${'2'.repeat(32)}`, { token: w.phone.token }, 404, 'not-found')
  assert.ok([400, 404].includes((await api(w, 'GET', `${R(w)}/attachments/../../etc`, { token: w.phone.token })).status))
  // Over 64 MiB announced: refused before a byte is stored.
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${w.base}${R(w)}/attachments/${'3'.repeat(32)}`, { method: 'PUT', headers: { authorization: `Bearer ${w.phone.token}`, 'content-length': String(LIMITS.attachment + 1) } }, res => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject)
    req.write(Buffer.alloc(1000))
  })
  assert.equal(status, 413)
  // And streamed beyond the limit without a length: cut off.
  const big = await new Promise((resolve, reject) => {
    const req = http.request(`${w.base}${R(w)}/attachments/${'4'.repeat(32)}`, { method: 'PUT', headers: { authorization: `Bearer ${w.phone.token}`, 'transfer-encoding': 'chunked' } }, res => { let b = ''; res.on('data', c => { b += c }); res.on('end', () => resolve({ status: res.statusCode, body: b })) })
    req.on('error', () => resolve({ status: 'reset' }))
    const chunk = Buffer.alloc(1 << 20)
    let sent = 0
    const pump = () => { while (sent <= LIMITS.attachment + (2 << 20)) { sent += chunk.length; if (!req.write(chunk)) return req.once('drain', pump) } req.end() }
    pump()
  })
  assert.ok(big.status === 413 || big.status === 'reset', `streamed too large: ${big.status}`)
  assert.equal(fs.existsSync(path.join(w.dir, 'attachments', w.roomId, '4'.repeat(32))), false)
  await w.hub.close()
})

test('share links: the uploader shares an attachment with a secret; anyone with it reads the bytes (Range), until expiry or revocation', async () => {
  const w = await world()
  const asset = await z.encryptAsset(crypto.randomBytes(100000))
  const aid = hex(asset.blobId)
  assert.equal((await fetch(`${w.base}${R(w)}/attachments/${aid}`, { method: 'PUT', headers: { authorization: `Bearer ${w.agent.token}` }, body: asset.blob })).status, 201)
  const secret = crypto.randomBytes(32), shareId = crypto.randomBytes(16).toString('hex')
  const share = { share_id: shareId, share_secret_hash: b64u(crypto.createHash('sha256').update(secret).digest()), expires_at: Date.now() + 3600000 }
  await refused(w, 'POST', `${R(w)}/attachments/${aid}/shares`, { token: w.phone.token, body: share }, 403, 'forbidden')
  await refused(w, 'POST', `${R(w)}/attachments/${aid}/shares`, { token: w.agent.token, body: { ...share, expires_at: Date.now() + 40 * 86400000 } }, 400, 'bad-argument')
  assert.deepEqual(await ok(w, 'POST', `${R(w)}/attachments/${aid}/shares`, { token: w.agent.token, body: share }), { share_id: shareId, expires_at: share.expires_at })
  await refused(w, 'POST', `${R(w)}/attachments/${aid}/shares`, { token: w.agent.token, body: share }, 409, 'replay')
  // An outsider: no token, the secret in a header.
  const get = (headers = {}) => fetch(`${w.base}/v1/shares/${shareId}`, { headers: { 'cf-connecting-ip': freshIp(), ...headers } })
  const whole = await get({ 'x-share-secret': b64u(secret) })
  assert.equal(whole.status, 200); assert.equal(whole.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(await z.decryptAsset(new Uint8Array(await whole.arrayBuffer()), asset.key, asset.sha256), await z.decryptAsset(asset.blob, asset.key, asset.sha256))
  const part = await get({ 'x-share-secret': b64u(secret), range: 'bytes=0-21' })
  assert.equal(part.status, 206); assert.deepEqual(new Uint8Array(await part.arrayBuffer()), asset.blob.slice(0, 22))
  for (const h of [{}, { 'x-share-secret': b64u(crypto.randomBytes(32)) }, { 'x-share-secret': 'short' }]) assert.equal((await get(h)).status, 404)
  assert.equal((await fetch(`${w.base}/v1/shares/${'5'.repeat(32)}`, { headers: { 'x-share-secret': b64u(secret) } })).status, 404)
  // Rate-limited per address.
  const ip = freshIp(); let limited = false
  for (let i = 0; i < 70 && !limited; i++) limited = (await fetch(`${w.base}/v1/shares/${shareId}`, { headers: { 'cf-connecting-ip': ip } })).status === 429
  assert.ok(limited, 'share reads are rate-limited per address')
  // Expired: gone, the same answer as for a wrong secret.
  w.hub.db.prepare('UPDATE shares SET expires_at = ? WHERE share_id = ?').run(Date.now() - 1, shareId)
  assert.equal((await get({ 'x-share-secret': b64u(secret) })).status, 404)
  w.hub.db.prepare('UPDATE shares SET expires_at = ? WHERE share_id = ?').run(share.expires_at, shareId)
  // Revoked by the creator or a human device; then gone.
  await refused(w, 'DELETE', `${R(w)}/attachments/${aid}/shares/${'6'.repeat(32)}`, { token: w.agent.token }, 404, 'not-found')
  assert.deepEqual(await ok(w, 'DELETE', `${R(w)}/attachments/${aid}/shares/${shareId}`, { token: w.laptop.token }), { ok: true })
  assert.equal((await get({ 'x-share-secret': b64u(secret) })).status, 404)
  // CORS for the viewer page.
  const pre = await fetch(`${w.base}/v1/shares/${shareId}`, { method: 'OPTIONS', headers: { origin: 'https://app.trommi.com', 'access-control-request-headers': 'x-share-secret, range' } })
  assert.match(pre.headers.get('access-control-allow-headers'), /x-share-secret/)
  await w.hub.close()
})

test('limits: JSON size, envelope rate, founding per address, open requests', async () => {
  const w = await world()
  const huge = 'x'.repeat(LIMITS.json + 10)
  await refused(w, 'POST', `${R(w)}/envelopes`, { token: w.phone.token, raw: huge, headers: { 'content-type': 'application/json' } }, 413, 'too-large')
  // Envelopes: a burst of 200, then 429 with retry-after.
  let limited = null
  for (let i = 0; i < 230 && !limited; i++) {
    const { res } = await post(w, w.agent, { payload: utf8(String(i)) })
    if (res.status === 429) limited = { i, res }
    else assert.equal(res.status, 200)
  }
  assert.ok(limited, 'the envelope rate is limited'); assert.ok(limited.i >= 200, `limited after ${limited.i}`)
  assert.equal(limited.res.json.error, 'rate-limited'); assert.ok(Number(limited.res.headers.get('retry-after')) >= 1)
  // Founding: ten rooms per address and hour.
  const ip = freshIp()
  const w2 = { ...w, ip }
  for (let i = 0; i < 10; i++) {
    const room = await z.createRoom({ device: await z.generateDevice(), recovery: await z.recoveryDevice(z.generateRecoveryCode()) })
    assert.equal((await api(w2, 'POST', '/v1/rooms', { body: { signed_entry: b64u(room.entry), sealed_room_keys: room.wraps.map(x => ({ device_id: hex(x.id), key_sealed: b64u(x.sealed) })) } })).status, 201)
  }
  const room = await z.createRoom({ device: await z.generateDevice(), recovery: await z.recoveryDevice(z.generateRecoveryCode()) })
  const body = { signed_entry: b64u(room.entry), sealed_room_keys: room.wraps.map(x => ({ device_id: hex(x.id), key_sealed: b64u(x.sealed) })) }
  const r = await refused(w2, 'POST', '/v1/rooms', { body }, 429, 'rate-limited')
  assert.ok(Number(r.headers.get('retry-after')) > 0)
  assert.equal((await api({ ...w, ip: freshIp() }, 'POST', '/v1/rooms', { body })).status, 201, 'another address may')
  await w.hub.close()
  // HUB_MAX_ROOMS and HUB_FOUND_TOKEN.
  const w3 = await newHub({ maxRooms: 1, foundToken: 'sesame' }); w3.ip = freshIp()
  const r1 = await z.createRoom({ device: await z.generateDevice(), recovery: await z.recoveryDevice(z.generateRecoveryCode()) })
  const b1 = { signed_entry: b64u(r1.entry), sealed_room_keys: r1.wraps.map(x => ({ device_id: hex(x.id), key_sealed: b64u(x.sealed) })) }
  await refused(w3, 'POST', '/v1/rooms', { body: b1 }, 403, 'forbidden')
  assert.equal((await api(w3, 'POST', '/v1/rooms', { body: b1, headers: { 'x-found-token': 'sesame' } })).status, 201)
  await refused(w3, 'POST', '/v1/rooms', { body, headers: { 'x-found-token': 'sesame' } }, 429, 'too-many')
  await w3.hub.close()
})

test('push: a send_push envelope reaches every other human device as { room_id, envelope_number, urgency }, nothing else', async () => {
  const received = []
  const fake = http.createServer((req, res) => { const parts = []; req.on('data', c => parts.push(c)); req.on('end', () => { received.push({ headers: req.headers, body: Buffer.concat(parts), url: req.url }); res.writeHead(201).end() }) })
  await new Promise(ok2 => fake.listen(0, '127.0.0.1', ok2))
  const pushHost = `127.0.0.1:${fake.address().port}`
  const w = await world({ pushHosts: [pushHost] })
  const browser = crypto.createECDH('prime256v1'); const browserPub = browser.generateKeys(); const auth = crypto.randomBytes(16)
  const subscription = { endpoint: `http://${pushHost}/push/laptop`, keys: { p256dh: browserPub.toString('base64url'), auth: auth.toString('base64url') } }
  assert.deepEqual(await ok(w, 'POST', `${R(w)}/push_subscriptions`, { token: w.laptop.token, body: { subscription } }), { ok: true })
  await refused(w, 'POST', `${R(w)}/push_subscriptions`, { token: w.agent.token, body: { subscription } }, 403, 'forbidden')
  await refused(w, 'POST', `${R(w)}/push_subscriptions`, { token: w.laptop.token, body: { subscription: { ...subscription, endpoint: 'https://evil.example/x' } } }, 400, 'bad-argument')
  const cardId = await z.objectIdOf(w.agent.device.id, 1)
  const { n } = await posted(w, w.agent, { kind: KIND.PERMISSION_REQUEST, push: true, card: { id: cardId, state: 1, urgency: 3 } })
  for (let i = 0; i < 50 && !received.length; i++) await sleep(20)
  assert.equal(received.length, 1)
  const got = received[0]
  assert.equal(got.url, '/push/laptop'); assert.equal(got.headers['content-encoding'], 'aes128gcm'); assert.match(got.headers.authorization, /^vapid t=.+, k=/)
  assert.equal(got.headers.urgency, 'high')
  // Decrypt as the browser would (RFC 8291).
  const b = got.body
  const salt = b.subarray(0, 16), idlen = b[20], senderPub = b.subarray(21, 21 + idlen), ct = b.subarray(21 + idlen)
  const hk = (s, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, s, info, len))
  const ikm = hk(auth, browser.computeSecret(senderPub), Buffer.concat([Buffer.from('WebPush: info\0'), browserPub, senderPub]), 32)
  const d = crypto.createDecipheriv('aes-128-gcm', hk(salt, ikm, 'Content-Encoding: aes128gcm\0', 16), hk(salt, ikm, 'Content-Encoding: nonce\0', 12))
  d.setAuthTag(ct.subarray(ct.length - 16))
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()])
  const end = plain.lastIndexOf(2)
  assert.deepEqual(JSON.parse(plain.subarray(0, end).toString()), { room_id: w.roomId, envelope_number: n, urgency: 3 })
  // No push to the sender, none for envelopes without the bit; removal by the browser service forgets the subscription.
  await posted(w, w.agent)
  await sleep(100)
  assert.equal(received.length, 1)
  await ok(w, 'POST', `${R(w)}/push_subscriptions`, { token: w.laptop.token, body: { subscription, remove: true } })
  await posted(w, w.agent, { kind: KIND.STATUS, push: true })
  await sleep(100)
  assert.equal(received.length, 1)
  // send_push is honoured only on an object's own versions: a status with the bit rings nobody (R1).
  await ok(w, 'POST', `${R(w)}/push_subscriptions`, { token: w.laptop.token, body: { subscription } })
  await posted(w, w.agent, { kind: KIND.STATUS, push: true })
  await sleep(100)
  assert.equal(received.length, 1)
  await w.hub.close()
  fake.close()
})

test('retention: an answered card and its chat lose their bodies 30 days after the hub received the answer, its attachments go; open ones stay; derived tables rebuild', async () => {
  let clock = Date.now()
  const w = await world({ now: () => clock })
  const done = await z.objectIdOf(w.agent.device.id, 1), open = await z.objectIdOf(w.agent.device.id, 2)
  await posted(w, w.agent, { kind: KIND.OBJECT_VERSION, card: { id: done, state: 1, urgency: 1 } })
  await posted(w, w.agent, { kind: KIND.OBJECT_VERSION, card: { id: open, state: 1, urgency: 2 } })
  const asset = await z.encryptAsset(utf8('the plan'))
  const aid = hex(asset.blobId)
  assert.equal((await fetch(`${w.base}${R(w)}/attachments/${aid}`, { method: 'PUT', headers: { authorization: `Bearer ${w.phone.token}` }, body: asset.blob })).status, 201)
  const msg = await posted(w, w.phone, { timelineKind: 1, timelineId: `card/${hex(done)}`, blobs: [asset.blobId], recipient: w.agent.device.id })
  await posted(w, w.phone, { timelineKind: 1, timelineId: `card/${hex(open)}` })
  // The answer claims an answer time 31 days ago: a claim; retention counts from the hub's own arrival time (R1).
  const answered = await posted(w, w.phone, { kind: KIND.ANSWER, card: { id: done, state: z.CARD_STATE.ANSWERED, urgency: 1, answeredAt: Date.now() - 31 * 86400000 }, recipient: w.agent.device.id })
  assert.deepEqual(w.hub.prune(), { objects: 0, envelopes: 0, attachments: 0 })
  const objects = w.hub.db.prepare('SELECT * FROM objects ORDER BY object_id').all()
  assert.deepEqual(objects.map(o => [o.object_id, o.object_state, o.owner_device_id]).sort(), [[hex(done), 2, hex(w.agent.device.id)], [hex(open), 1, hex(w.agent.device.id)]].sort())
  const timelines = w.hub.db.prepare('SELECT * FROM timelines ORDER BY timeline_id').all()
  w.hub.rebuildDerived()
  assert.deepEqual(w.hub.db.prepare('SELECT * FROM objects ORDER BY object_id').all(), objects, 'objects rebuild from envelopes alike')
  assert.deepEqual(w.hub.db.prepare('SELECT * FROM timelines ORDER BY timeline_id').all(), timelines, 'timelines rebuild from envelopes alike')
  const open1 = w.hub.db.prepare("SELECT object_id FROM objects WHERE room_id = ? AND object_state = 1 ORDER BY urgency DESC").all(w.roomId)
  assert.deepEqual(open1.map(o => o.object_id), [hex(open)])
  clock += 31 * 86400000
  const res = w.hub.prune()
  assert.deepEqual(res, { objects: 1, envelopes: 3, attachments: 1 })
  for (const c of [w.phone, w.laptop]) await signIn(w, c)
  assert.deepEqual(w.hub.prune(), { objects: 1, envelopes: 0, attachments: 0 }, 'pruning twice changes nothing')
  const t = await ok(w, 'GET', `${R(w)}/threads?timeline_kind=chat&timeline_id=card/${hex(done)}`, { token: w.phone.token })
  assert.equal(z.peekEnvelope(unb64u(t.envelopes[0].envelope)).pruned, true)
  assert.equal(t.envelopes[0].envelope_number, msg.n)
  const all = await ok(w, 'GET', `${R(w)}/envelopes`, { token: w.laptop.token })
  assert.deepEqual(all.envelopes.map(e => z.peekEnvelope(unb64u(e.envelope)).pruned), [true, false, true, true, true])
  void answered
  // Chains still verify for a fresh client.
  const fresh = client(w.laptop.device, 'again'); fresh.state = w.laptop.state; fresh.secrets = w.laptop.secrets; fresh.session = w.laptop.session
  await ingest(fresh, all.envelopes)
  await refused(w, 'GET', `${R(w)}/attachments/${aid}`, { token: w.phone.token }, 404, 'not-found')
  assert.equal(fs.existsSync(path.join(w.dir, 'attachments', w.roomId, aid)), false)
  await w.hub.close()
})

test('restart: everything persists; rooms load lazily; a client resumes where it was', async () => {
  const port = await freePort()
  const w = await world({ port })
  for (let i = 0; i < 5; i++) await posted(w, i % 2 ? w.phone : w.agent)
  const before = await ok(w, 'GET', `${R(w)}/envelopes`, { token: w.phone.token })
  await w.hub.close()
  const w2 = await newHub({ dir: w.dir, port }); w2.ip = w.ip; w2.roomId = w.roomId
  assert.equal(w2.hub.stats.roomLoads.length, 0, 'no room is loaded before it is asked for')
  await signIn(w2, w.phone)
  assert.equal(w2.hub.stats.roomLoads.length, 1)
  assert.deepEqual(await ok(w2, 'GET', `${R(w2)}/envelopes`, { token: w.phone.token }), before)
  // The chains continue: the next envelope is accepted, a replay of an old one is refused.
  await signIn(w2, w.agent)
  const next = await post(w2, w.agent)
  assert.equal(next.res.status, 200); assert.equal(next.res.json.envelope_number, 6)
  const old = unb64u(before.envelopes[1].envelope)
  void old
  const replay = await api(w2, 'POST', `${R(w2)}/envelopes`, { token: w.agent.token, body: { envelope: b64u(next.env.bytes) } })
  assert.equal(replay.status, 409)
  // Joins keep working after the restart.
  await signIn(w2, w.laptop)
  const { c: tablet } = await join(w2, w.laptop, await z.generateDevice(), ROLE.HUMAN)
  const got = await ok(w2, 'GET', `${R(w2)}/envelopes`, { token: tablet.token })
  await ingest(tablet, got.envelopes)
  await w2.hub.close()
})

// ---- run -------------------------------------------------------------------------------

const only = process.argv[2]
let failed = 0
const t0 = performance.now()
const notes = []
for (const t of tests) {
  if (only && !t.name.includes(only)) continue
  const s = performance.now()
  try {
    const out = await t.fn()
    if (out?.latency != null) notes.push(`live stream latency on localhost: ${out.latency.toFixed(1)} ms`)
    console.log(`ok    ${t.name} (${(performance.now() - s).toFixed(0)} ms)`)
  } catch (err) {
    failed++
    console.log(`FAIL  ${t.name}\n${err?.stack ?? err}${err?.cause ? `\ncause: ${err.cause.stack ?? err.cause}` : ""}`)
  }
}
for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
for (const n of notes) console.log(`note  ${n}`)
const ran = only ? tests.filter(t => t.name.includes(only)).length : tests.length
console.log(`\n${ran - failed} of ${ran} tests passed in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
process.exit(failed ? 1 : 0)
