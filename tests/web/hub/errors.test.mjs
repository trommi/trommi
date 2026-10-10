// What a request can end in, against the fake hub: refused (the hub said so), not reached, not now. The engine
// voids an outbox entry only on the first, so the three must never be confused.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { Hub, HubError, hubAddress } from '../../../app/web/core/hub.ts'
import { scene, client, received, envelope, id, txt } from './helpers.mjs'

test('a refusal becomes a HubError with the hub\'s code, status, voided and the rest of its body', async t => {
  const { fake, hub, room_id, device } = await scene(t)
  const gap = await hub.postEnvelope(envelope(room_id, device, 3)).catch(e => e)
  assert.ok(gap instanceof HubError)
  assert.deepEqual([gap.code, gap.status, gap.voided, gap.retry_after, gap.transient], ['gap', 409, false, null, false])
  assert.deepEqual(gap.details, { seq: 0 })

  fake.faults.add({ path: '/v2/envelopes', refuse: { error: 'forbidden', voided: true } })
  const voided = await hub.postEnvelope(envelope(room_id, device, 1)).catch(e => e)
  assert.deepEqual([voided.code, voided.status, voided.voided, voided.transient], ['forbidden', 403, true, false])

  fake.faults.add({ path: '/v2/envelopes', refuse: { error: 'rate-limited', retry_after: 7 } })
  const limited = await hub.postEnvelope(envelope(room_id, device, 1)).catch(e => e)
  assert.deepEqual([limited.code, limited.status, limited.retry_after, limited.transient], ['rate-limited', 429, 7, true])

  // (the hub may name the wait in the refusal's body instead of the header)
  fake.faults.add({ path: '/v2/envelopes', raw: { status: 429, json: { error: 'rate-limited', message: 'slow down', retry_after: 9 } } })
  const inBody = await hub.postEnvelope(envelope(room_id, device, 1)).catch(e => e)
  assert.deepEqual([inBody.code, inBody.status, inBody.retry_after, inBody.transient], ['rate-limited', 429, 9, true])
})

test('a busy hub (503 overloaded) and an internal error are not refusals', async t => {
  const { fake, hub, room_id, device } = await scene(t)
  fake.faults.add({ path: '/v2/envelopes', refuse: { error: 'overloaded', retry_after: 1 } })
  const busy = await hub.postEnvelope(envelope(room_id, device, 1)).catch(e => e)
  assert.deepEqual([busy.code, busy.status, busy.retry_after, busy.transient], ['overloaded', 503, 1, true])
  fake.faults.add({ path: '/v2/envelopes', refuse: { error: 'internal' } })
  const internal = await hub.postEnvelope(envelope(room_id, device, 1)).catch(e => e)
  assert.deepEqual([internal.code, internal.status, internal.transient], ['internal', 500, true])
  assert.equal(fake.state.rooms.get(txt(room_id)).envelopes.length, 0)
  assert.deepEqual(await hub.postEnvelope(envelope(room_id, device, 1)), { change: 1 })
})

test('a hub that is not there is `offline` with status 0, never a refusal', async t => {
  const { fake, hub, room_id, device } = await scene(t)
  await hub.desk()
  await fake.stop()
  const e = await hub.postEnvelope(envelope(room_id, device, 1)).catch(x => x)
  assert.ok(e instanceof HubError)
  assert.deepEqual([e.code, e.status, e.voided, e.transient], ['offline', 0, false, true])
  await fake.start()
  assert.deepEqual(await hub.postEnvelope(envelope(room_id, device, 1)), { change: 1 })
})

test('a connection cut before, after or in the middle of the answer is `offline`', async t => {
  const { fake, hub } = await scene(t)
  await hub.desk()
  // no answer at all: tried once more at once (a dead kept-alive connection), then it is "not reached"; an answer
  // that broke off in its middle is "not reached" at once
  for (const [drop, times] of [['before', 2], ['after', 2], ['mid', 1]]) {
    fake.faults.add({ path: '/v2/desk', drop, times })
    await assert.rejects(hub.desk(), e => e instanceof HubError && e.code === 'offline' && e.status === 0, drop)
  }
  fake.faults.add({ path: '/v2/desk', drop: 'before' })
  await hub.desk()
  assert.deepEqual(received(fake, '/v2/desk').slice(-2).map(r => r.dropped), ['before', null])
})

test('a hub that restarted: the connections it left dead cost no request, read or write', async t => {
  const { fake, hub, room_id, device } = await scene(t)
  for (let round = 1; round <= 5; round++) {
    await Promise.all([hub.desk(), hub.welcomes(), hub.requests()])        // several connections kept alive
    fake.dropConnections()                                                 // cut under the client, which has not seen it yet
    assert.deepEqual(await hub.postEnvelope(envelope(room_id, device, round)), { change: round })
    fake.dropConnections()
    assert.equal((await hub.desk()).change, round)
  }
})

test('a hub that does not answer in time is `offline`', async t => {
  const { fake, hub } = await scene(t)
  await hub.desk()
  hub.timing.request = 60
  fake.faults.add({ path: '/v2/desk', delay_ms: 400 })
  await assert.rejects(hub.desk(), e => e.code === 'offline' && e.status === 0)
})

test('a GET that was not reached or met a 503 is tried again; a write is not', async t => {
  const { fake, hub, room_id, device } = await scene(t)
  hub.timing.get_retry = [5, 5]
  await hub.desk()
  fake.faults.add({ path: '/v2/desk', drop: 'before' })
  fake.faults.add({ path: '/v2/desk', refuse: { error: 'overloaded' } })
  await hub.desk()
  assert.deepEqual(received(fake, '/v2/desk').map(r => r.status), [200, null, 503, 200])
  fake.faults.add({ path: '/v2/envelopes', refuse: { error: 'overloaded' } })
  await assert.rejects(hub.postEnvelope(envelope(room_id, device, 1)), e => e.code === 'overloaded')
  assert.equal(received(fake, '/v2/envelopes').length, 1)
})

test('a 200 that carries a refusal body is neither an answer nor a refusal', async t => {
  const { fake, hub, room_id, device } = await scene(t)
  fake.faults.add({ path: '/v2/envelopes', raw: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"error":"forbidden","message":"no","voided":true}' } })
  const e = await hub.postEnvelope(envelope(room_id, device, 1)).catch(x => x)
  assert.deepEqual([e.code, e.voided, e.transient], ['bad-answer', false, true])
})

test('an error page that is not the hub\'s (a proxy) is `http-<status>`, not a refusal', async t => {
  const { fake, hub, room_id, device } = await scene(t)
  const pages = [[502, '<html>bad gateway</html>'], [403, '<html>blocked</html>'], [404, '{"error":42}'], [413, ''], [403, '{"error":"access-denied","message":"blocked"}'],
    [403, '{"error":"overloaded","message":"busy"}'], [403, '{"error":"forbidden"}'], [409, '{"error":"forbidden","message":"no","voided":true}']]
  for (const [status, body] of pages) {
    fake.faults.add({ path: '/v2/envelopes', raw: { status, headers: { 'content-type': 'text/html' }, body } })
    const e = await hub.postEnvelope(envelope(room_id, device, 1)).catch(x => x)
    assert.deepEqual([e.code, e.status, e.transient, e.voided], [`http-${status}`, status, true, false], body)
  }
})

test('a limit that may free up (too-many) is "not now"; what the hub wrote is kept apart from the error\'s text', async t => {
  const { fake, hub, room_id, device } = await scene(t)
  fake.faults.add({ path: '/v2/envelopes', refuse: { error: 'too-many', message: 'Bearer secret-token echoed' } })
  const e = await hub.postEnvelope(envelope(room_id, device, 1)).catch(x => x)
  assert.deepEqual([e.code, e.status, e.transient], ['too-many', 429, true])
  assert.equal(e.hub_message, 'Bearer secret-token echoed')
  assert.ok(!String(e.stack).includes('secret-token') && !JSON.stringify({ ...e }).includes('secret-token') && !Object.keys(e).includes('hub_message'))
})

test('a redirect is not followed: the token goes nowhere else', async t => {
  const { fake, hub } = await scene(t)
  let hits = 0
  const other = http.createServer((req, res) => { hits += 1; res.end('{}') })
  await new Promise(r => other.listen(0, '127.0.0.1', r))
  t.after(() => other.close())
  await hub.desk()
  for (const status of [301, 302, 307, 308]) {
    fake.faults.add({ path: '/v2/desk', raw: { status, headers: { location: `http://127.0.0.1:${other.address().port}/v2/desk` }, body: '' } })
    const e = await hub.desk().catch(x => x)
    assert.deepEqual([e.code, e.status, e.transient], ['bad-answer', status, true])
  }
  assert.equal(hits, 0)
})

test('answers that are too large or not JSON are refused', async t => {
  const { fake, hub } = await scene(t)
  await hub.welcomes()
  fake.faults.add({ path: '/v2/account', raw: { status: 200, body: Buffer.alloc((1 << 20) + 1, 0x20) } })
  await assert.rejects(hub.account(), e => e.code === 'bad-answer')
  fake.faults.add({ path: '/v2/welcomes', raw: { status: 200, body: 'not json' } })
  await assert.rejects(hub.welcomes(), e => e.code === 'bad-answer')
  fake.faults.add({ path: '/v2/welcomes', raw: { status: 200, body: Buffer.from([0x22, 0xff, 0x22]) } })
  await assert.rejects(hub.welcomes(), e => e.code === 'bad-answer')
})

test('client-too-old and an unknown route keep their codes', async t => {
  const { fake, hub } = await scene(t, { min_client: 'app/3.0.0' })
  const old = await hub.challenge(id(32)).catch(e => e)
  assert.deepEqual([old.code, old.status, old.transient], ['client-too-old', 426, true])
  const newer = new Hub({ hub_url: fake.url, client_name: 'app/3.1.0' })
  const missing = await newer.request('GET', '/v2/no-such-route', { auth: false }).catch(e => e)
  assert.deepEqual([missing.code, missing.status, missing.transient], ['not-found', 404, false])
})

test('nothing but a checked id reaches a path, and the hub address is canonical', async t => {
  const { fake, hub, room_id } = await scene(t)
  await hub.desk()
  const before = fake.requests.length
  const group = `${txt(room_id)}/../../v2/desk`
  for (const call of [
    () => hub.groupInfo(group), () => hub.groupInfo('../desk'), () => hub.groupInfo(room_id + '='), () => hub.groupInfo(id(31)), () => hub.getFile(id(32)),
    () => hub.getFile('AAAAAAAAAAAAAAAAAAAAAB'), () => hub.chatItems('session', id(32)), () => hub.chatItems('desk/..', id(16)), () => hub.objectEnvelopes('cards/x', id(16)),
    () => hub.request('GET', '/v2/desk?x=1'), () => hub.request('GET', '/v1/desk'), () => hub.request('GET', '/v2/../healthz'), () => hub.request('GET', '/v2/changes', { query: { after: '1&x=2' } }),
    () => hub.changes(-1), () => hub.changes(1.5), () => hub.claimKeyPackages([]),
  ]) await assert.rejects(Promise.resolve().then(call), e => e.code === 'bad-argument' && !(e instanceof HubError))
  assert.equal(fake.requests.length, before, 'none of them was sent')
  assert.equal(hubAddress('HTTPS://Hub.Trommi.com/'), 'https://hub.trommi.com')
  for (const bad of ['http://hub.trommi.com', 'https://hub.trommi.com/x', 'https://u:p@hub.trommi.com', 'https://hub.trommi.com?x=1', 'ftp://hub.trommi.com', 'hub']) assert.throws(() => hubAddress(bad), { code: 'bad-argument' })
  assert.equal(client(fake).hub_url, fake.url)
})
