// The live stream (`GET /v2/stream`) against the fake hub: events in the hub's order, resume without loss or
// duplicate, backoff, a new sign-in after a 401, and a hub that sends what it must not.
import test from 'node:test'
import assert from 'node:assert/strict'
import { HubError } from '../../../app/web/core/hub.ts'
import { scene, client, received, envelope, id, utf8, until, txt } from './helpers.mjs'

/** Opens a stream and records what it hands over. */
function listen(t, hub, after = () => 0) {
  const heard = { events: [], states: [], errors: [], changes: () => heard.events.filter(e => e.event === 'change').map(e => e.item.change) }
  const close = hub.stream(after, e => heard.events.push(e), s => heard.states.push([s, Date.now()]), e => heard.errors.push(e))
  t.after(close)
  return Object.assign(heard, { close })
}
const live = heard => heard.states.at(-1)?.[0] === 'live'

test('catch-up from the cursor, then live, in the hub\'s order; other events as they happen', async t => {
  const { fake, hub, room_id, device, room } = await scene(t)
  for (let seq = 1; seq <= 3; seq++) await hub.postEnvelope(envelope(room_id, device, seq))
  const heard = listen(t, hub, () => 1)
  await until(() => heard.changes().length === 2)
  assert.deepEqual(heard.states.map(s => s[0]), ['connecting', 'live'])
  await hub.postEnvelope(envelope(room_id, device, 4))
  const added = id(32)
  await hub.postCommit(room_id, { epoch: 0, commit: utf8({ added: [added] }), group_info: utf8('i'), sealed_key: utf8('s'), welcome: utf8('w') })
  await hub.postMessage(room_id, 1, utf8('stored'), false)
  await hub.postMessage(room_id, 1, utf8('own piece'), true)          // a relay does not come back to its sender
  const other = id(32)
  room.devices.set(txt(other), 'human')
  room.groups.get(txt(room_id)).leaves.add(txt(other))
  await client(fake, room_id, other).postMessage(room_id, 1, utf8('piece'), true)
  await hub.postRequest({ kind: 'session' })
  const file_id = id(16)
  await hub.putFile(file_id, utf8('bytes'))
  await hub.deleteFile(file_id)
  fake.push(txt(room_id), `event: presence\ndata: ${JSON.stringify({ device: txt(added), online: true, hears: true, working: false, last_call_at: 5 })}\n\n`)
  fake.push(txt(room_id), `event: presence\ndata: ${JSON.stringify({ device: txt(added), online: false, lost: true })}\n\n`)
  fake.push(txt(room_id), `event: presence\ndata: ${JSON.stringify({ group_id: txt(room_id), archived: true })}\n\n`)
  fake.push(txt(room_id), 'event: ping\ndata: {}\n\n: a comment\n\nevent: of_a_later_hub\ndata: {"x":1}\n\n')
  await until(() => heard.events.length === 12)
  assert.deepEqual(heard.changes(), [2, 3, 4, 5, 7], 'change 6 is the Commit\'s SealedKey')
  assert.deepEqual(heard.events.map(e => e.event), ['change', 'change', 'change', 'welcome', 'change', 'change', 'relay', 'request', 'file_evicted', 'presence', 'presence', 'archived'])
  const [, , , welcome, commit, message, relay, request, evicted, here, lost, archived] = heard.events
  assert.deepEqual(welcome, { event: 'welcome', group: room_id })
  assert.deepEqual([commit.item.kind, commit.item.group, commit.item.epoch, commit.item.n], ['commit', room_id, 0, 1])
  assert.deepEqual([message.item.kind, message.item.n], ['message', 2])
  assert.deepEqual(relay, { event: 'relay', group: room_id, epoch: 1, sender: other, message: utf8('piece') })
  assert.deepEqual([request.kind, request.device, request.group], ['session', device, null])
  assert.deepEqual(evicted, { event: 'file_evicted', file_id })
  assert.deepEqual(here, { event: 'presence', device: added, online: true, lost: false, hears: true, working: false, last_call_at: 5 })
  assert.deepEqual([lost.online, lost.lost, lost.hears], [false, true, null])
  assert.deepEqual(archived, { event: 'archived', group: room_id })
  assert.equal(heard.errors.length, 0)
})

test('a dropped connection: the stream resumes after the last change it handed over; nothing lost, nothing twice', async t => {
  const { fake, hub, room_id, device } = await scene(t)
  const writer = client(fake, room_id, device)
  const heard = listen(t, hub)                 // the caller's cursor stays 0: the stream itself knows what it handed over
  await until(() => live(heard))
  await writer.postEnvelope(envelope(room_id, device, 1))
  await writer.postEnvelope(envelope(room_id, device, 2))
  await until(() => heard.changes().length === 2)
  fake.faults.add({ path: '/v2/stream', drop: 'before', times: 2 })
  fake.dropStreams()
  await writer.postEnvelope(envelope(room_id, device, 3))        // while nobody listens
  await writer.postEnvelope(envelope(room_id, device, 4))
  await until(() => heard.changes().length === 4)
  await writer.postEnvelope(envelope(room_id, device, 5))
  await until(() => heard.changes().length === 5)
  assert.deepEqual(heard.changes(), [1, 2, 3, 4, 5])
  assert.deepEqual(received(fake, '/v2/stream').map(r => [r.query.after, r.dropped]), [['0', null], ['2', 'before'], ['2', 'before'], ['2', null]])
  assert.ok(heard.states.some(s => s[0] === 'offline'))
  assert.equal(heard.states.at(-1)[0], 'live')
})

test('what a catch-up beside the stream took is not handed over again, and the next connection starts after it', async t => {
  const { fake, hub, room_id, device } = await scene(t)
  for (let seq = 1; seq <= 4; seq++) await hub.postEnvelope(envelope(room_id, device, seq))
  let cursor = 0
  const heard = listen(t, hub, () => cursor)
  await until(() => heard.changes().length === 4)
  cursor = 6                                   // the engine caught up to change 6 by /v2/changes meanwhile
  await hub.postEnvelope(envelope(room_id, device, 5))
  await hub.postEnvelope(envelope(room_id, device, 6))
  await hub.postEnvelope(envelope(room_id, device, 7))
  await until(() => heard.changes().length === 5)
  assert.deepEqual(heard.changes(), [1, 2, 3, 4, 7])
  fake.dropStreams()
  await until(() => received(fake, '/v2/stream').length === 2)
  assert.equal(received(fake, '/v2/stream')[1].query.after, '7')
})

test('a receiver is awaited: one whose write fails gets the event again, and the next waits for it', async t => {
  const { fake, hub, room_id, device } = await scene(t)
  const got = []
  let fail = true, busy = 0, overlapped = false
  const close = hub.stream(() => 0, async e => {
    if (busy++) overlapped = true
    await new Promise(r => setTimeout(r, 15))
    busy -= 1
    if (e.item.change === 2 && fail) { fail = false; throw new Error('the durable write failed') }
    got.push(e.item.change)
  }, () => {})
  t.after(close)
  await until(() => fake.streams === 1)
  for (let seq = 1; seq <= 4; seq++) await hub.postEnvelope(envelope(room_id, device, seq))
  await until(() => got.length === 4)
  assert.deepEqual(got, [1, 2, 3, 4])
  assert.equal(overlapped, false)
  assert.deepEqual(received(fake, '/v2/stream').map(r => r.query.after), ['0', '1'])
})

test('events with CRLF line ends and data on several lines are read', async t => {
  const { fake, hub, room_id } = await scene(t)
  const heard = listen(t, hub)
  await until(() => live(heard))
  const data = JSON.stringify({ group_id: txt(room_id) })
  fake.push(txt(room_id), `event: welcome\r\ndata: ${data.slice(0, 1)}\r\ndata: ${data.slice(1)}\r\n\r`)
  fake.push(txt(room_id), `\nevent: welcome\rdata: ${data}\r\r`)
  fake.push(txt(room_id), 'event: ping\ndata: {}\n\n')
  await until(() => heard.events.length === 2)
  assert.deepEqual(heard.events, [{ event: 'welcome', group: room_id }, { event: 'welcome', group: room_id }])
})

test('close() from inside a callback ends the stream; callbacks that throw do not', async t => {
  const { fake, hub, room_id, device } = await scene(t)
  let close = () => {}, states = 0
  close = hub.stream(() => 0, () => {}, s => { states += 1; if (s === 'connecting' && states > 1) close(); if (s === 'live') throw new Error('the page\'s own bug') }, () => { throw new Error('and another') })
  t.after(() => close())
  await until(() => fake.streams === 1)
  await hub.postEnvelope(envelope(room_id, device, 1))
  fake.dropStreams()
  await new Promise(r => setTimeout(r, 300))
  assert.equal(received(fake, '/v2/stream').length, 1, 'closed while reconnecting: no second stream')
  assert.equal(fake.streams, 0)
})

test('a hub that opens streams and ends them at once cannot hurry the reconnects', async t => {
  const { fake, hub, room_id } = await scene(t)
  Object.assign(hub.timing, { backoff_first: 150, backoff_max: 2000 })
  const body = 'event: of_a_later_hub\ndata: {}\n\n' + `event: welcome\ndata: ${JSON.stringify({ group_id: txt(room_id) })}\n\n`
  fake.faults.add({ path: '/v2/stream', times: 99, raw: { status: 200, headers: { 'content-type': 'text/event-stream' }, body } })
  const heard = listen(t, hub)
  await new Promise(r => setTimeout(r, 1500))
  const tries = received(fake, '/v2/stream').length
  // waits of 150, 300, 600, 1200 ms, each at least half of it: five streams at most; one every 250 ms would be seven
  assert.ok(tries >= 3 && tries <= 5, `${tries} streams in 1.5 s`)
  assert.equal(heard.events.length, tries)
})

test('a hub that is not there: tries with growing waits, capped; back at once when it returns', async t => {
  const { fake, hub, room_id, device } = await scene(t)
  await hub.postEnvelope(envelope(room_id, device, 1))
  await fake.stop()
  Object.assign(hub.timing, { backoff_first: 40, backoff_max: 200 })
  const heard = listen(t, hub)
  await new Promise(r => setTimeout(r, 1500))
  const tries = heard.states.filter(s => s[0] === 'connecting').map(s => s[1])
  const gaps = tries.slice(1).map((at, i) => at - tries[i])
  // waits of 40, 80, 160, 200, 200 … ms, each between half and all of it (jitter)
  assert.ok(tries.length >= 7 && tries.length <= 14, `${tries.length} tries in 1.5 s`)
  assert.ok(gaps[0] >= 15 && gaps[0] <= 80, `first wait ${gaps[0]}`)
  assert.ok(gaps.slice(3).every(g => g >= 95 && g <= 260), `capped waits ${gaps}`)
  assert.ok(gaps[3] > gaps[0], 'the waits grow')
  assert.ok(heard.errors.every(e => e instanceof HubError && e.code === 'offline'))
  assert.ok(heard.states.every(s => s[0] !== 'live'))
  await fake.start()
  hub.wake()
  await until(() => heard.changes().length === 1)
  assert.equal(heard.states.at(-1)[0], 'live')
})

test('a hub that forgot the token: the stream signs in again and goes on', async t => {
  const { fake, hub, room_id, device } = await scene(t)
  const heard = listen(t, hub)
  await until(() => live(heard))
  await hub.postEnvelope(envelope(room_id, device, 1))
  await until(() => heard.changes().length === 1)
  await fake.restart()
  await until(() => received(fake, '/v2/stream').some(r => r.status === 401))
  await until(() => live(heard) && fake.streams === 1)
  const writer = client(fake, room_id, device)
  await writer.postEnvelope(envelope(room_id, device, 2))
  await until(() => heard.changes().length === 2)
  assert.deepEqual(heard.changes(), [1, 2])
  assert.equal(received(fake, `/v2/rooms/${txt(room_id)}/tokens`).filter(r => r.device === null && r.status === 200).length, 3, 'two sign-ins of the stream\'s client, one of the writer')
  assert.deepEqual(received(fake, '/v2/stream').filter(r => r.status).map(r => r.status).slice(-2), [401, 200])
})

test('a stream whose token ran out is ended by the hub and opened again with a new one', async t => {
  const { fake, hub, room_id, device } = await scene(t, { token_ms: 250 })
  hub.timing.renew_before = 60
  const heard = listen(t, hub)
  await until(() => live(heard))
  await hub.postEnvelope(envelope(room_id, device, 1))
  await until(() => received(fake, '/v2/stream').length >= 3)
  await hub.postEnvelope(envelope(room_id, device, 2))
  await until(() => heard.changes().length === 2)
  assert.deepEqual(heard.changes(), [1, 2])
  assert.ok(received(fake, '/v2/stream').every(r => r.status === 200))
  assert.ok(received(fake, '/v2/stream').slice(1).every(r => r.query.after === '1'))
})

const replayed = (change, seq, room_id, device) => `id: ${change}\nevent: envelope\ndata: ${JSON.stringify({ kind: 'envelope', change, received_at: 1, envelope: Buffer.from(envelope(room_id, device, seq)).toString('base64url') })}\n\n`
const violations = {
  'a change it sent before (a replay)': (r, d) => replayed(2, 2, r, d),
  'an older change (reordered)': (r, d) => replayed(1, 1, r, d),
  'an event id that is not the item\'s change': (r, d) => replayed(9, 9, r, d).replace('id: 9', 'id: 8'),
  'an envelope event without an id': (r, d) => replayed(9, 9, r, d).replace('id: 9\n', ''),
  'a log entry named an envelope': r => `id: 9\nevent: envelope\ndata: ${JSON.stringify({ change: 9, kind: 'commit', group_id: txt(r), n: 4, epoch: 0, at: 1, bytes: 'AAAA', sender: txt(r) })}\n\n`,
  'an event that is not JSON': () => 'id: 9\nevent: envelope\ndata: {not json\n\n',
  'an envelope that is not canonical base64url': (r, d) => replayed(9, 9, r, d).replace('"envelope":"', '"envelope":"='),
  'a relay with a sender that is no device id': r => `event: relay\ndata: ${JSON.stringify({ group_id: txt(r), epoch: 0, sender: '../x', message: 'AAAA' })}\n\n`,
  'a change number beyond 2^53': (r, d) => replayed(2 ** 53 + 2, 9, r, d),
}
for (const [what, text] of Object.entries(violations)) {
  test(`a hub that sends ${what}: not handed over, the connection is given up and resumed`, async t => {
    const { fake, hub, room_id, device } = await scene(t)
    const heard = listen(t, hub)
    await until(() => live(heard))
    await hub.postEnvelope(envelope(room_id, device, 1))
    await hub.postEnvelope(envelope(room_id, device, 2))
    await until(() => heard.changes().length === 2)
    fake.push(txt(room_id), text(room_id, device))
    await until(() => heard.errors.length === 1)
    assert.ok(heard.errors[0] instanceof HubError && heard.errors[0].code === 'bad-answer')
    await until(() => received(fake, '/v2/stream').length === 2 && live(heard))
    assert.equal(received(fake, '/v2/stream')[1].query.after, '2')
    await hub.postEnvelope(envelope(room_id, device, 3))
    await until(() => heard.changes().length === 3)
    assert.deepEqual(heard.changes(), [1, 2, 3])
    assert.equal(heard.events.length, 3)
  })
}

test('an event larger than any event ends the connection instead of filling memory', async t => {
  const { fake, hub, room_id } = await scene(t)
  const heard = listen(t, hub)
  await until(() => live(heard))
  fake.push(txt(room_id), 'event: envelope\ndata: ' + 'x'.repeat(5 << 20))
  await until(() => heard.errors.length === 1)
  assert.equal(heard.errors[0].code, 'bad-answer')
  assert.equal(heard.events.length, 0)
})

test('a refused stream reports why and keeps trying; close() ends it', async t => {
  const { fake, hub, room_id } = await scene(t)
  fake.faults.add({ path: '/v2/stream', times: 3, refuse: { error: 'not-member' } })
  const heard = listen(t, hub)
  await until(() => live(heard))
  assert.deepEqual(heard.errors.map(e => [e.code, e.status]), Array(3).fill(['not-member', 403]))
  heard.close()
  await until(() => fake.streams === 0)
  const n = fake.requests.length
  fake.dropStreams()
  await new Promise(r => setTimeout(r, 250))
  assert.equal(fake.requests.length, n, 'nothing is asked after close()')
  assert.equal(room_id, hub.room_id)
})

test('a redirected stream is not followed; an answer that is no event stream is not read', async t => {
  const { fake, hub } = await scene(t)
  fake.faults.add({ path: '/v2/stream', raw: { status: 302, headers: { location: 'http://127.0.0.1:1/v2/stream' }, body: '' } })
  fake.faults.add({ path: '/v2/stream', raw: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"error":"gone"}' } })
  const heard = listen(t, hub)
  await until(() => live(heard))
  assert.deepEqual(heard.errors.map(e => e.code), ['bad-answer', 'bad-answer'])
})
