// httpfuzz.mjs: malformed input at the HTTP boundary. Whatever arrives (bad ids, bad JSON, wrong types, huge or
// binary bodies, hostile Range headers, odd methods and paths), the hub must answer 4xx with a JSON error, never 5xx,
// never hang, never leak a stack trace; and it must still answer /healthz afterwards.
import { makeRng } from './rng.mjs'
import { Finding } from './world.mjs'

const ROUTES = [
  ['POST', '/v1/rooms'], ['POST', '/v1/rooms/:room/challenge'], ['POST', '/v1/rooms/:room/access_tokens'], ['GET', '/v1/rooms/:room/members'], ['POST', '/v1/rooms/:room/members'],
  ['GET', '/v1/rooms/:room/devices'], ['GET', '/v1/rooms/:room/sealed_room_keys'], ['GET', '/v1/rooms/:room/key_back_links'], ['POST', '/v1/rooms/:room/invites'],
  ['GET', '/v1/rooms/:room/invites/:id'], ['POST', '/v1/rooms/:room/invites/:id/requests'], ['GET', '/v1/rooms/:room/invites/:id/requests'], ['POST', '/v1/rooms/:room/invites/:id/reveal'],
  ['GET', '/v1/rooms/:room/invites/:id/status'], ['POST', '/v1/rooms/:room/envelopes'], ['GET', '/v1/rooms/:room/envelopes'], ['GET', '/v1/rooms/:room/threads'],
  ['POST', '/v1/rooms/:room/agent_sessions'], ['PUT', '/v1/rooms/:room/attachments/:id'], ['GET', '/v1/rooms/:room/attachments/:id'], ['POST', '/v1/rooms/:room/push_subscriptions'],
  ['GET', '/v1/push_key'], ['GET', '/healthz'], ['GET', '/'], ['OPTIONS', '/v1/rooms'], ['DELETE', '/v1/rooms/:room'], ['GET', '/v1/rooms/:room/stream'],
]
const JUNK_IDS = n => ['', 'x', '0'.repeat(32), '0'.repeat(64), 'g'.repeat(64), 'A'.repeat(64), '..%2f..%2f', '%00', '../../etc/passwd', 'a'.repeat(5000), '💥', "' OR 1=1 --", '0'.repeat(63), '0'.repeat(65), '-1', '1e9']
const JUNK_QUERY = ['after_envelope_number=-1', 'after_envelope_number=abc', 'after_envelope_number=1e999', 'limit=0', 'limit=99999999', 'limit=-5', 'before_envelope_number=NaN', 'timeline_kind=chat&timeline_id=%00', 'timeline_kind=99&timeline_id=card/zz', 'after_entry_number=9999999999999999999', 'request_hash=zz', 'invite_id=../x', '__proto__=1', 'a[]=1&a[]=2']
const JUNK_RANGE = ['bytes=0-', 'bytes=-1', 'bytes=999999999-', 'bytes=5-1', 'bytes=a-b', 'bytes=0-0,5-9', 'items=0-1', 'bytes=-', 'bytes=0-99999999999999999999']

function junkBody(rng, kind) {
  const pick = rng.int(12)
  switch (pick) {
    case 0: return ''
    case 1: return '{'
    case 2: return 'null'
    case 3: return '[]'
    case 4: return '"str"'
    case 5: return JSON.stringify({ signed_entry: 5, sealed_room_keys: 'x' })
    case 6: return JSON.stringify({ envelope: 'A'.repeat(rng.range(1, 300)) })
    case 7: return JSON.stringify({ envelope: 'not base64 \u0000﻿' })
    case 8: return JSON.stringify({ __proto__: { x: 1 }, constructor: { prototype: 1 }, signed_challenge: ['a'] })
    case 9: return JSON.stringify({ signed_entry: 'A'.repeat(100000), sealed_room_keys: [] })
    case 10: return '﻿{"envelope":""}'
    default: return JSON.stringify(Object.fromEntries(Array.from({ length: rng.range(1, 40) }, (_, i) => [`k${i}`, rng.pick([null, 1, 'x', [], {}, true, 'A'.repeat(rng.range(0, 200))])])))
  }
}

/** One round of n malformed requests at the hub. `auth` is a valid bearer token (or null), `room` a real room id. */
export async function httpFuzz({ hubUrl, room, auth, seed, n = 60, fetchFn = fetch }) {
  const rng = makeRng(`${seed}/http`)
  const bad = []
  for (let i = 0; i < n; i++) {
    const [method, tpl] = rng.pick(ROUTES)
    const roomId = rng.chance(0.5) ? room : rng.pick(JUNK_IDS())
    let url = tpl.replace(':room', encodeURI(roomId)).replace(':id', encodeURI(rng.pick(JUNK_IDS())))
    if (rng.chance(0.6)) url += '?' + rng.pick(JUNK_QUERY)
    const headers = {}
    if (auth && rng.chance(0.6)) headers.authorization = rng.chance(0.85) ? `Bearer ${auth}` : rng.pick(['Bearer ', 'Basic abc', 'Bearer ' + 'x'.repeat(3000), 'bearer xyz'])
    if (rng.chance(0.3)) headers.range = rng.pick(JUNK_RANGE)
    if (rng.chance(0.2)) headers['content-type'] = rng.pick(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/json; charset=utf-16'])
    else if (method !== 'GET') headers['content-type'] = rng.chance(0.5) ? 'application/json' : 'application/octet-stream'
    if (rng.chance(0.1)) headers['x-lease-generation'] = rng.pick(['-1', 'abc', '99999999999'])
    let body
    if (method === 'POST' || method === 'PUT') body = method === 'PUT' && rng.chance(0.5) ? rng.bytes(rng.pick([0, 1, 21, 22, 1000, 70000])) : junkBody(rng)
    const t = performance.now()
    let res, text
    try {
      res = await fetchFn(`${hubUrl}${url}`, { method, headers, body, signal: AbortSignal.timeout(20000), redirect: 'manual' })
      if (!url.includes('/stream') || res.status !== 200) text = await res.text()
      else { try { res.body?.cancel() } catch {} text = '' }
    } catch (e) { if (e.cause?.code === 'UND_ERR_SOCKET' || e.cause?.code === 'ECONNRESET') continue /* hub closes the connection after refusing an oversize body: a reused keep-alive socket fails once; harmless */; bad.push(`${method} ${url.slice(0, 80)} [${Object.keys(headers).join(',')}]: ${e.name === 'TimeoutError' ? 'hung > 20 s' : e.message + ' ' + (e.cause?.code ?? e.cause?.message ?? '')}`); continue }
    const ms = performance.now() - t
    if (res.status >= 500) bad.push(`${method} ${url.slice(0, 90)} -> ${res.status} ${text.slice(0, 120)}`)
    else if (res.status >= 400 && !String(res.headers.get('content-type')).includes('json') && !['/', ''].includes(url) && res.status !== 404 && res.status !== 405) bad.push(`${method} ${url.slice(0, 80)} -> ${res.status} without a JSON error body`)
    else if (/at .*\.mjs:\d+|node_modules|\/home\/|Error:/.test(text)) bad.push(`${method} ${url.slice(0, 80)} leaks internals: ${text.slice(0, 120)}`)
    else if (ms > 8000) bad.push(`${method} ${url.slice(0, 80)} took ${ms.toFixed(0)} ms`)
  }
  let alive = false
  try { alive = (await fetchFn(`${hubUrl}/healthz`, { signal: AbortSignal.timeout(10000) })).ok } catch {}
  if (!alive) bad.push('hub does not answer /healthz after the round')
  return bad
}

export async function doHttpFuzz(R, a) {
  const w = R.w
  const d = R.dev(a.dev); if (!d) return 'skip'
  const token = d.client.hub.token
  const bad = await httpFuzz({ hubUrl: w.hubUrl, room: d.room.room_id, auth: token, seed: `${w.seed}/${a.r}`, n: w.remote ? 25 : a.n ?? 60 })
  if (bad.length) throw new Finding('http-boundary', [...new Set(bad)].slice(0, 6).join('\n'), { action: a })
  return 'ok'
}
