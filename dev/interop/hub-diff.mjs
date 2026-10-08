// hub-diff.mjs: two hub implementations side by side, the same requests to both, the answers compared. Both get the
// same room (the same signed founding entry, so the same room id), a signed-in phone each, then a seeded stream of
// malformed and half-right requests (the fuzz's junk ids, queries, bodies, ranges, plus every route with and without
// a token). Compared per request: the status, the JSON `error` code, and the set of JSON keys of the answer.
//
//   node dev/interop/hub-diff.mjs --a='node hub/server.mjs' --b=hub-rs/target/release/trommi-hub [--n=3000] [--seed=x]
// Exit 1 on any difference; the first ones are printed.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as z from '../../shared/crypto/zcrypto.mjs'

const argv = process.argv.slice(2)
const opt = (k, d) => { const a = argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d }
const N = Number(opt('n', 3000)), SEED = opt('seed', 'diff1')
Object.assign(process.env, { HUB_LIMIT_OPEN_REQUESTS_PER_IP_MINUTE: '1000000000', HUB_LIMIT_FOUND_PER_IP_HOUR: '1000000', HUB_LIMIT_ENVELOPES_PER_SECOND: '1000000', HUB_LIMIT_ENVELOPE_BURST: '1000000' })
const { startHub } = await import('../../hub/external.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-diff-'))
async function start(cmd, name) {
  process.env.HUB_CMD = cmd
  const hub = await startHub({ port: 0, host: '127.0.0.1', dataDir: path.join(tmp, name), log: () => {}, commit: 'diff' })
  return { name, cmd, hub, base: hub.hubUrl }
}
const A = await start(opt('a', 'node hub/server.mjs'), 'a')
const B = await start(opt('b', 'hub-rs/target/release/trommi-hub'), 'b')

// one room on both
const phone = await z.generateDevice()
const room = await z.createRoom({ device: phone, recovery: await z.recoveryDevice(z.generateRecoveryCode()) })
const roomId = z.hex(room.roomId)
const found = { signed_entry: z.b64u(room.entry), sealed_room_keys: room.wraps.map(x => ({ device_id: z.hex(x.id), key_sealed: z.b64u(x.sealed) })) }
for (const h of [A, B]) {
  const r = await fetch(`${h.base}/v1/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(found) })
  if (r.status !== 201) throw new Error(`${h.name}: found ${r.status}`)
  const { challenge } = await (await fetch(`${h.base}/v1/rooms/${roomId}/challenge`, { method: 'POST' })).json()
  const signed = await z.signHubAuth({ device: phone, roomId: room.roomId, hub: h.hub.hubUrl, challenge: z.unb64u(challenge) })
  h.token = (await (await fetch(`${h.base}/v1/rooms/${roomId}/access_tokens`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signed_challenge: z.b64u(signed) }) })).json()).access_token
}

// a seeded generator (xorshift)
let s = [...SEED].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 2166136261) || 1
const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 2 ** 32 }
const pick = a => a[Math.floor(rnd() * a.length)]
const chance = p => rnd() < p
const ROUTES = [
  ['POST', '/v1/rooms'], ['POST', '/v1/rooms/:room/challenge'], ['POST', '/v1/rooms/:room/access_tokens'], ['GET', '/v1/rooms/:room/members'], ['POST', '/v1/rooms/:room/members'],
  ['GET', '/v1/rooms/:room/devices'], ['GET', '/v1/rooms/:room/sealed_room_keys'], ['GET', '/v1/rooms/:room/key_back_links'], ['POST', '/v1/rooms/:room/invites'],
  ['GET', '/v1/rooms/:room/invites/:id'], ['DELETE', '/v1/rooms/:room/invites/:id'], ['POST', '/v1/rooms/:room/invites/:id/requests'], ['GET', '/v1/rooms/:room/invites/:id/requests'],
  ['POST', '/v1/rooms/:room/invites/:id/reveal'], ['GET', '/v1/rooms/:room/invites/:id/status'], ['POST', '/v1/rooms/:room/envelopes'], ['GET', '/v1/rooms/:room/envelopes'],
  ['GET', '/v1/rooms/:room/threads'], ['PUT', '/v1/rooms/:room/attachments/:id'], ['GET', '/v1/rooms/:room/attachments/:id'], ['HEAD', '/v1/rooms/:room/attachments/:id'],
  ['POST', '/v1/rooms/:room/attachments/:id/shares'], ['DELETE', '/v1/rooms/:room/attachments/:id/shares/:id'], ['GET', '/v1/shares/:id'],
  ['POST', '/v1/rooms/:room/push_subscriptions'], ['GET', '/v1/rooms/:room/push_subscriptions'], ['GET', '/v1/rooms/:room/sessions'], ['GET', '/v1/rooms/:room/session_grants'],
  ['POST', '/v1/rooms/:room/session_grants'], ['POST', '/v1/rooms/:room/sessions/:id/grants'], ['GET', '/v1/rooms/:room/sessions/:id/grants'],
  ['GET', '/v1/rooms/:room/sessions/:id/sealed_session_keys'], ['GET', '/v1/rooms/:room/sessions/:id/key_back_links'], ['POST', '/v1/rooms/:room/agent_lease'],
  ['POST', '/v1/rooms/:room/agent_link'], ['POST', '/v1/rooms/:room/agent_watch'], ['GET', '/v1/rooms/:room/usage'], ['GET', '/v1/rooms/:room/account'],
  ['POST', '/v1/rooms/:room/account'], ['PUT', '/v1/rooms/:room/account/password'], ['POST', '/v1/rooms/:room/account/verify'], ['POST', '/v1/accounts/login'], ['POST', '/v1/accounts/recover'],
  ['GET', '/v1/push_key'], ['GET', '/v1/version'], ['GET', '/healthz'], ['GET', '/'], ['GET', '/nothing'], ['OPTIONS', '/v1/rooms'], ['DELETE', '/v1/rooms/:room'], ['GET', '/v1/rooms/:room/stream'],
  ['PATCH', '/v1/rooms/:room/envelopes'], ['GET', '/v1/rooms/:room'], ['GET', '/v1/rooms/:room/nothing'],
]
const IDS = () => ['', 'x', '0'.repeat(32), 'ab'.repeat(16), '0'.repeat(64), 'g'.repeat(64), 'A'.repeat(64), '%00', '0'.repeat(63), '0'.repeat(65), '-1', '1e9', '💥']
const QUERY = ['after_envelope_number=-1', 'after_envelope_number=abc', 'after_envelope_number=1e999', 'after_envelope_number=5', 'limit=0', 'limit=99999999', 'limit=-5', 'limit=3', 'newest=1',
  'before_envelope_number=NaN', 'timeline_kind=chat&timeline_id=%00', 'timeline_kind=chat&timeline_id=card/' + '0'.repeat(32), 'timeline_kind=99&timeline_id=card/zz', 'timeline_kind=0&timeline_id=x',
  'after_entry_number=9999999999999999999', 'after_entry_number=-2', 'after_entry_number=0', 'request_hash=zz', 'request_hash=' + '0'.repeat(64), 'invite_id=../x', 'invite_id=' + '0'.repeat(32),
  'session_ids=' + '0'.repeat(32), 'session_ids=x', 'after_key_epoch=1.5', 'after_grant_number=-1', '__proto__=1', 'a[]=1&a[]=2']
const RANGE = ['bytes=0-', 'bytes=-1', 'bytes=999999999-', 'bytes=5-1', 'bytes=a-b', 'bytes=0-0,5-9', 'items=0-1', 'bytes=-', 'bytes=0-99999999999999999999']
const BODIES = () => ['', '{', 'null', '[]', '"str"', '{}', JSON.stringify({ signed_entry: 5, sealed_room_keys: 'x' }), JSON.stringify({ envelope: 'A'.repeat(1 + Math.floor(rnd() * 300)) }),
  JSON.stringify({ envelope: 'not base64' }), JSON.stringify({ signed_challenge: ['a'] }), JSON.stringify({ signed_challenge: 'AAAA' }), '﻿{"envelope":""}',
  JSON.stringify({ process_instance: 'p', renew: true }), JSON.stringify({ hears: 'live', working: 'yes' }), JSON.stringify({ hears: 'oncall', exit: { reason: 'x', claude: 'gone' } }), JSON.stringify({ working: true }),
  JSON.stringify({ subscription: { endpoint: 'https://evil.example/x', keys: {} } }), JSON.stringify({ level: 'loud' }), JSON.stringify({ email: 'a@b.cd', auth_key: 'A'.repeat(43) }),
  JSON.stringify({ email: 'nope', auth_key: 'x' }), JSON.stringify({ grants: [] }), JSON.stringify({ grants: [{ session_id: 'x' }] }), JSON.stringify({ share_id: '0'.repeat(32), share_secret_hash: 'A'.repeat(43), expires_at: 1 }),
  JSON.stringify({ signed_offer: 'AAAA' }), JSON.stringify({ signed_request: 'AAAA' }), JSON.stringify({ signed_reveal: 'AAAA' }), JSON.stringify({ code: '123456' }),
  JSON.stringify({ signed_grant: 'AAAA', sealed_session_keys: [] }), JSON.stringify({ signed_entry: z.b64u(room.entry), sealed_room_keys: [] })]

const mismatches = []
const texts = new Map()       // differing human texts (`message`) of the same answer: reported, not failed
const seen = new Map()        // "<status> <error>" of hub A -> count: what the run covered
const shape = v => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().join(',') : typeof v)
for (let i = 0; i < N; i++) {
  const [method, tpl] = pick(ROUTES)
  const room = chance(0.8) ? roomId : pick(IDS())
  let url = tpl.replace(':room', encodeURI(room)).replace(/:id/g, () => encodeURI(pick(IDS())))
  if (chance(0.5)) url += `?${pick(QUERY)}`
  const tokenKind = chance(0.7) ? 'good' : chance(0.5) ? 'none' : 'junk'
  const range = chance(0.2) ? pick(RANGE) : null
  const body = ['POST', 'PUT', 'PATCH'].includes(method) ? pick(BODIES()) : undefined
  const ctype = chance(0.8) ? 'application/json' : 'text/plain'
  const accept = chance(0.1) ? 'text/html' : null
  const junk = pick(['Bearer ', 'Basic abc', `Bearer ${'x'.repeat(43)}`, 'bearer xyz'])
  const out = []
  for (const h of [A, B]) {
    const headers = { 'content-type': ctype }
    if (tokenKind === 'good') headers.authorization = `Bearer ${h.token}`
    if (tokenKind === 'junk') headers.authorization = junk
    if (range) headers.range = range
    if (accept) headers.accept = accept
    let res, text = ''
    try {
      res = await fetch(h.base + url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(10000) })
      if (url.includes('/stream') && res.status === 200) { await res.body?.cancel(); text = '' } else text = await res.text()
    } catch (e) { out.push({ status: 'error', code: e.cause?.code ?? e.message }); continue }
    let json = null
    try { json = JSON.parse(text) } catch {}
    out.push({ status: res.status, code: json?.error ?? null, shape: res.status < 300 ? shape(json) : json ? shape(json) : 'text', message: json?.message })
  }
  const [a, b] = out
  const k = `${a.status} ${a.code ?? ''}`.trim(); seen.set(k, (seen.get(k) ?? 0) + 1)
  if (a.message !== b.message && a.status === b.status) { const k = `${a.message} | ${b.message}`; if (!texts.has(k)) texts.set(k, `${method} ${url.slice(0, 80)}`) }
  delete a.message; delete b.message
  if (a.status !== b.status || a.code !== b.code || a.shape !== b.shape) mismatches.push({ method, url: url.slice(0, 120), auth: tokenKind, range, body: body?.slice(0, 80), a, b })
}
const groups = new Map()
for (const m of mismatches) { const k = `${m.method} ${m.url.replace(/[0-9a-f]{32,}/g, '<id>').split('?')[0]} ${JSON.stringify(m.a)} vs ${JSON.stringify(m.b)}`; if (!groups.has(k)) groups.set(k, m) }
console.log(`${N} requests, ${mismatches.length} differ (${groups.size} kinds) between ${A.cmd} and ${B.cmd}`)
console.log(`answers of ${A.cmd}: ${JSON.stringify(Object.fromEntries([...seen].sort((x, y) => y[1] - x[1])))}`)
for (const m of [...groups.values()].slice(0, 40)) console.log(JSON.stringify(m))
if (texts.size) console.log(`${texts.size} message texts differ (same status and code):\n${[...texts].slice(0, 30).map(([k, v]) => `  ${k}   (${v})`).join('\n')}`)
await A.hub.close(); await B.hub.close()
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(mismatches.length ? 1 : 0)
