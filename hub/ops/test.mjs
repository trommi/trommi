// Tests for hub/ops: versions, test rooms, configurable limits, backpressure, metrics, quota, escrow.
// Real HTTP against hub/server.mjs on a free port with a throwaway data directory; the quota order and the
// stream buffer are also tested as units. Run: node hub/ops/test.mjs [name filter]
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import * as z from '../../crypto/zcrypto.mjs'
import { openDb } from '../store.mjs'
import { attachmentQuota } from './quota.mjs'
import { flowControl } from './flow.mjs'
import { compareVersions, parseClient } from './versions.mjs'
import { limitsFromEnv } from './env.mjs'
import { signTestRequest } from './test-rooms.mjs'
import { routeLabel } from './metrics.mjs'

const testKey = crypto.generateKeyPairSync('ed25519')
/** Headers of a signed test request (each signature works once). */
const signed = (method, p, at) => ({ 'x-test-signature': signTestRequest(testKey.privateKey, method, p, at) })
// Read when server.mjs is imported (LIMITS) and when a hub starts (ops): set before both.
Object.assign(process.env, { HUB_TEST_PUBLIC_KEY: testKey.publicKey.export({ format: 'jwk' }).x, HUB_LIMIT_OPEN_REQUESTS_PER_IP_MINUTE: '6', HUB_MIN_APP: '1.2.0', HUB_RECOMMENDED_APP: '1.4.0', METRICS_PORT: '0' })
const { startHub, LIMITS } = await import('../server.mjs')

const { hex, b64u, unb64u } = z
const tests = []
const test = (name, fn) => tests.push({ name, fn })
const tmpDirs = []
const sleep = ms => new Promise(ok => setTimeout(ok, ms))
let ipCounter = 0
const freshIp = () => `10.77.${(++ipCounter >> 8) & 255}.${ipCounter & 255}`

async function newHub(opts = {}, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trommi-ops-test-'))
  tmpDirs.push(dir)
  const saved = { ...process.env }
  Object.assign(process.env, env)
  try {
    const hub = await startHub({ port: 0, host: '127.0.0.1', dataDir: dir, commit: 'test', log: () => {}, trustCloudflare: true, ...opts })
    return { hub, dir, base: hub.hubUrl, hubUrl: hub.hubUrl, ip: freshIp() }
  } finally { process.env = saved }
}
async function api(w, method, p, { token, body, headers = {}, raw } = {}) {
  const h = { 'cf-connecting-ip': w.ip, ...headers }
  if (token) h.authorization = `Bearer ${token}`
  const payload = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined
  if (body !== undefined) h['content-type'] = 'application/json'
  const res = await fetch(w.base + p, { method, headers: h, body: payload })
  const type = res.headers.get('content-type') || ''
  return { status: res.status, json: type.includes('json') ? await res.json() : await res.text(), headers: res.headers }
}
async function expect(w, method, p, opts, status, error) {
  const r = await api(w, method, p, opts)
  assert.equal(r.status, status, `${method} ${p}: expected ${status}, got ${r.status} ${JSON.stringify(r.json)}`)
  if (error) assert.equal(r.json.error, error)
  return r
}
const R = w => `/v1/rooms/${w.roomId}`

async function foundRoom(w, { headers = {}, extra = {} } = {}) {
  const device = await z.generateDevice()
  const room = await z.createRoom({ device, name: '', recovery: await z.recoveryDevice(z.generateRecoveryCode()) })
  const body = { signed_entry: b64u(room.entry), sealed_room_keys: room.wraps.map(x => ({ device_id: hex(x.id), key_sealed: b64u(x.sealed) })), ...extra }
  const r = await api(w, 'POST', '/v1/rooms', { body, headers })
  if (r.status !== 201) return r
  w.roomId = r.json.room_id
  w.phone = { device, token: await signIn(w, device) }
  return r
}
async function signIn(w, device, headers = {}) {
  const { json } = await api(w, 'POST', `${R(w)}/challenge`, { headers })
  const signed = await z.signHubAuth({ device, roomId: z.unhex(w.roomId), hub: w.hubUrl, challenge: unb64u(json.challenge) })
  return (await api(w, 'POST', `${R(w)}/access_tokens`, { body: { signed_challenge: b64u(signed) }, headers })).json.access_token
}
/** A live stream; collects events until closed. */
async function openStream(w, token, headers = {}) {
  const ac = new AbortController()
  const res = await fetch(`${w.base}${R(w)}/stream?after_envelope_number=${Number.MAX_SAFE_INTEGER}`, { headers: { authorization: `Bearer ${token}`, ...headers }, signal: ac.signal })
  const s = { status: res.status, events: [], closed: false, close: () => ac.abort() }
  ;(async () => {
    let buf = ''
    try {
      for await (const chunk of res.body) {
        buf += Buffer.from(chunk).toString()
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2)
          const ev = Object.fromEntries(block.split('\n').filter(l => !l.startsWith(':')).map(l => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]))
          if (ev.event) s.events.push({ event: ev.event, data: JSON.parse(ev.data) })
        }
      }
    } catch {}
    s.closed = true
  })()
  s.until = async (pred, ms = 3000) => {
    const end = Date.now() + ms
    while (Date.now() < end) { const hit = s.events.find(pred); if (hit) return hit; await sleep(10) }
    throw new Error(`no such event; got ${JSON.stringify(s.events.map(e => e.event))}`)
  }
  return s
}
const fakeFiles = () => { const gone = []; return { gone, delete: (room, id) => gone.push(id) } }
/** A row in envelopes naming attachments, as if a client had posted it (the quota reads only these columns). */
let fakeNumber = 1000000
function fakeEnvelope(db, roomId, { kind, attachmentIds, objectId = null }) {
  const n = ++fakeNumber, b = new Uint8Array(1)
  db.prepare(`INSERT INTO envelopes (room_id, envelope_number, sender_device_id, sender_sequence, previous_envelope_hash, envelope_hash, key_epoch, object_id,
    envelope_kind, send_push, attachment_ids, padded_size, sent_at, received_at, envelope_header, envelope_nonce, encrypted_body_hash, envelope_signature)
    VALUES (?, ?, X'00', ?, X'00', X'00', 1, ?, ?, 0, ?, 0, 0, 0, ?, ?, ?, ?)`).run(roomId, n, n, objectId, kind, attachmentIds.join(','), b, b, b, b)
}
function fakeAttachment(db, roomId, id, size, storedAt, objectId = null) {
  db.prepare('INSERT INTO attachments (room_id, attachment_id, object_id, uploader_device_id, total_size, chunk_count, stored_at) VALUES (?, ?, ?, ?, ?, 1, ?)').run(roomId, id, objectId, 'x', size, storedAt)
}
const fakeObject = (db, roomId, objectId, state) => db.prepare(`INSERT INTO objects (room_id, object_id, object_state, urgency, answered_at, owner_device_id, first_envelope_number,
  latest_head_envelope_number) VALUES (?, ?, ?, 1, 0, 'x', 1, 1)`).run(roomId, objectId, state)
const aid = i => i.toString(16).padStart(32, '0')

// ---- versions ---------------------------------------------------------------------------

test('versions: semver, the public version answer, 426 for an old client on every route, missing header allowed, unknown protocol refused', async () => {
  assert.equal(compareVersions('1.2.0', '1.10.0'), -1)
  assert.equal(compareVersions('2.0.0-beta.1', '2.0.0'), 0)
  assert.deepEqual(parseClient('channel/0.3.1'), { kind: 'channel', version: '0.3.1' })
  assert.equal(parseClient('evil/1.0.0'), null)
  const w = await newHub({}, { HUB_UPGRADE_MESSAGE: 'Bitte neu laden.' })
  const v = (await expect(w, 'GET', '/v1/version', {}, 200)).json
  assert.deepEqual(v, { protocol_versions_supported: [1], minimum_client_versions: { app: '1.2.0' }, recommended_client_versions: { app: '1.4.0' }, message: 'Bitte neu laden.' })
  const old = { headers: { 'trommi-client': 'app/1.1.9', 'trommi-protocol': '1' } }
  for (const [m, p] of [['GET', '/healthz'], ['POST', '/v1/rooms'], ['GET', `/v1/rooms/${'a'.repeat(64)}/envelopes`], ['GET', '/v1/version']]) {
    const r = await expect(w, m, p, old, 426, 'client-too-old')
    assert.deepEqual(r.json, { error: 'client-too-old', message: 'Bitte neu laden.', minimum_version: '1.2.0' })
  }
  await expect(w, 'GET', '/healthz', { headers: { 'trommi-client': 'app/1.2.0' } }, 200)
  await expect(w, 'GET', '/healthz', { headers: { 'trommi-client': 'channel/0.0.1' } }, 200)    // no minimum for channel
  await expect(w, 'GET', '/healthz', {}, 200)
  const r = await expect(w, 'GET', '/healthz', { headers: { 'trommi-protocol': '2' } }, 400, 'bad-version')
  assert.match(r.json.message, /protocol 1/)
  await w.hub.close()
})

test('versions: an open stream of a client that is now too old gets upgrade_required and is closed; a current one stays', async () => {
  const w = await newHub()
  await foundRoom(w)
  const oldStream = await openStream(w, w.phone.token, { 'trommi-client': 'app/1.3.0' })
  const newStream = await openStream(w, w.phone.token, { 'trommi-client': 'app/2.0.0' })
  assert.equal(oldStream.status, 200)
  await sleep(50)
  w.hub.ops.updateVersions({ minimum: { app: '2.0.0' }, message: 'Neue Version da.' })
  const ev = await oldStream.until(e => e.event === 'upgrade_required')
  assert.deepEqual(ev.data, { minimum_version: '2.0.0', message: 'Neue Version da.' })
  for (let i = 0; i < 100 && !oldStream.closed; i++) await sleep(10)
  assert.ok(oldStream.closed)
  assert.ok(!newStream.closed)
  newStream.close()
  await w.hub.close()
})

// ---- test rooms and limits -------------------------------------------------------------------

test('limits from the environment; a signed test request lifts nothing on a real room; a test room\'s routes are unlimited', async () => {
  assert.deepEqual(limitsFromEnv({ envelopesPerSecond: 50, json: 10 }, { HUB_LIMIT_ENVELOPES_PER_SECOND: '5000', HUB_LIMIT_JSON: 'x' }), { envelopesPerSecond: 5000, json: 10 })
  assert.equal(LIMITS.openRequestsPerIpMinute, 6)
  const w = await newHub()
  await foundRoom(w)                       // 2 open requests (challenge, access_tokens)
  for (let i = 0; i < 4; i++) await expect(w, 'POST', `${R(w)}/challenge`, {}, 200)
  await expect(w, 'POST', `${R(w)}/challenge`, {}, 429, 'rate-limited')
  const other = crypto.generateKeyPairSync('ed25519').privateKey
  const p = `${R(w)}/challenge`
  await expect(w, 'POST', p, { headers: { 'x-test-signature': signTestRequest(other, 'POST', p) } }, 429, 'rate-limited')          // someone else's key
  await expect(w, 'POST', p, { headers: signed('POST', `${R(w)}/devices`) }, 429, 'rate-limited')                                 // another path
  await expect(w, 'POST', p, { headers: signed('POST', p, Date.now() - 61000) }, 429, 'rate-limited')                             // stale
  await expect(w, 'POST', p, { headers: signed('POST', p) }, 429, 'rate-limited')                                                 // a real room: never lifted
  // A test room (founded by a signed request) has no open-route limit.
  await foundRoom(w, { extra: { test_room: true }, headers: signed('POST', '/v1/rooms') })
  for (let i = 0; i < 12; i++) await expect(w, 'POST', `${R(w)}/challenge`, {}, 200)
  await w.hub.close()
  // Off: HUB_TEST_PUBLIC_KEY unset or "off" accepts no test signature at all.
  for (const key of ['off', '']) {
    const off = await newHub({}, { HUB_TEST_PUBLIC_KEY: key })
    assert.equal(off.hub.ops.testRooms.enabled, false)
    await expect(off, 'POST', '/v1/rooms', { body: { test_room: true }, headers: signed('POST', '/v1/rooms') }, 403, 'forbidden')
    await off.hub.close()
  }
})

test('test rooms: founding needs a signed request; DELETE removes rows and attachments; others cannot be deleted; expiry after 24 h', async () => {
  let clock = Date.now()
  const w = await newHub({ now: () => clock })
  const flagged = { extra: { test_room: true } }
  await expect(w, 'POST', '/v1/rooms', { body: { test_room: true } }, 403, 'forbidden')
  assert.equal((await foundRoom(w, { ...flagged, headers: signed('POST', '/v1/rooms') })).status, 201)
  const testRoom = w.roomId
  assert.ok(w.hub.ops.testRooms.isTestRoom(testRoom))
  await expect(w, 'PUT', `${R(w)}/attachments/${aid(1)}`, { token: w.phone.token, raw: new Uint8Array(100) }, 201)
  await expect(w, 'PUT', `${R(w)}/escrow`, { token: w.phone.token, body: { escrow_version: 1, key_escrow: b64u(new Uint8Array(32)) } }, 200)
  assert.ok(fs.existsSync(path.join(w.dir, 'attachments', testRoom)))
  await expect(w, 'DELETE', R(w), {}, 403, 'forbidden')
  await expect(w, 'DELETE', R(w), { headers: signed('DELETE', R(w)) }, 200)
  await expect(w, 'GET', `${R(w)}/devices`, { token: w.phone.token }, 404, 'no-room')
  assert.ok(!fs.existsSync(path.join(w.dir, 'attachments', testRoom)))
  for (const t of w.hub.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(x => x.name)) {
    if (w.hub.db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = \'room_id\'').get(t)) assert.equal(w.hub.db.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE room_id = ?`).get(testRoom).n, 0, t)
  }
  // An ordinary room is not deletable, not even with the token.
  await expect(w, 'POST', '/v1/rooms', { body: {}, headers: signed('POST', '/v1/rooms') }, 403, 'forbidden')   // signed: test rooms only
  await foundRoom(w)
  const normal = w.roomId
  await expect(w, 'DELETE', R(w), { headers: signed('DELETE', R(w)) }, 404, 'not-found')
  // Expiry.
  await foundRoom(w, { ...flagged, headers: signed('POST', '/v1/rooms') })
  const expiring = w.roomId
  clock += 23 * 3600000; await w.hub.ops.testRooms.expire()
  assert.ok(w.hub.ops.testRooms.isTestRoom(expiring))
  clock += 2 * 3600000; await w.hub.ops.testRooms.expire()
  assert.ok(!w.hub.ops.testRooms.isTestRoom(expiring))
  assert.equal(w.hub.db.prepare('SELECT COUNT(*) AS n FROM rooms WHERE room_id IN (?, ?)').get(expiring, normal).n, 1)
  await w.hub.close()
})

// ---- backpressure ----------------------------------------------------------------------

test('backpressure: a full write queue answers 503 with retry-after; a stream over its buffer is dropped', async () => {
  const w = await newHub({}, { HUB_WRITE_QUEUE: '2' })
  await foundRoom(w)
  // Two uploads that hang (body not finished) fill the queue.
  const hanging = [1, 2].map(i => {
    const req = http.request(`${w.base}${R(w)}/attachments/${aid(i)}`, { method: 'PUT', headers: { authorization: `Bearer ${w.phone.token}`, 'content-length': 1000 } })
    req.on('error', () => {})
    req.write(Buffer.alloc(10))
    return req
  })
  await sleep(100)
  assert.equal(w.hub.ops.flow.writeQueueDepth, 2)
  const r = await expect(w, 'PUT', `${R(w)}/attachments/${aid(3)}`, { token: w.phone.token, raw: new Uint8Array(10) }, 503, 'overloaded')
  assert.equal(r.headers.get('retry-after'), '1')
  await expect(w, 'GET', `${R(w)}/devices`, { token: w.phone.token }, 200)       // reads are not queued
  for (const h of hanging) h.destroy()
  await sleep(100)
  assert.equal(w.hub.ops.flow.writeQueueDepth, 0)
  await expect(w, 'PUT', `${R(w)}/attachments/${aid(3)}`, { token: w.phone.token, raw: new Uint8Array(10) }, 201)
  await w.hub.close()

  // The stream buffer as a unit: a reader that does not read is dropped once its buffer is over the limit.
  const flow = flowControl({ streamBufferBytes: 1000 })
  const fakeRes = () => { const r2 = { writableLength: 0, destroyed: false, once() {}, write(t) { r2.writableLength += t.length }, destroy() { r2.destroyed = true } }; return r2 }
  const live = { res: fakeRes(), catchingUp: false, pending: [] }
  const catching = { res: fakeRes(), catchingUp: true, pending: [] }
  flow.track(live, null); flow.track(catching, null)
  for (let i = 0; i < 5; i++) { flow.send(live, { text: 'x'.repeat(150) }); flow.send(catching, { text: 'x'.repeat(150) }) }
  assert.deepEqual(flow.outbound(), { total: 1500, max: 750, count: 2 })
  assert.ok(!live.res.destroyed && !catching.res.destroyed)
  for (let i = 0; i < 2; i++) { flow.send(live, { text: 'x'.repeat(150) }); flow.send(catching, { text: 'x'.repeat(150) }) }
  assert.ok(live.res.destroyed && catching.res.destroyed)
  assert.equal(flow.counters.droppedStreams, 2)
})

// ---- metrics ---------------------------------------------------------------------------

test('metrics: Prometheus text and the history only on the metrics port, never on the public one', async () => {
  assert.equal(routeLabel('POST', `/v1/rooms/${'a'.repeat(64)}/envelopes`), 'POST envelopes')
  assert.equal(routeLabel('GET', `/v1/rooms/${'a'.repeat(64)}/whatever`), 'GET other')
  assert.equal(routeLabel('POST', '/v1/rooms'), 'POST rooms')
  assert.equal(routeLabel('GET', '/etc/passwd'), 'GET other')
  const w = await newHub()
  await foundRoom(w)
  await expect(w, 'GET', '/metrics', {}, 404)
  const port = w.hub.ops.metricsPort()
  assert.ok(port && port !== new URL(w.base).port)
  w.hub.ops.metrics.sample()
  const text = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text()
  for (const name of ['trommi_requests_total{route="POST rooms",status="201"} 1', 'trommi_request_duration_ms_bucket{route="POST challenge",le="+Inf"} 1', 'trommi_envelopes_ingested_total',
    'trommi_write_queue_depth', 'trommi_open_streams', 'trommi_stream_outbound_bytes_max', 'trommi_sqlite_wal_bytes', 'trommi_sqlite_checkpoint_lag_frames',
    'process_resident_memory_bytes', 'nodejs_heap_bytes{kind="used"}', 'nodejs_eventloop_lag_ms{quantile="0.99"}', 'nodejs_gc_pauses_total', 'process_open_fds',
    'host_load{minutes="1"}', 'host_memory_bytes{kind="available"}', 'host_data_disk_bytes{kind="free"}']) assert.ok(text.includes(name), name)
  assert.ok(!/NaN|undefined/.test(text))
  const history = await (await fetch(`http://127.0.0.1:${port}/metrics/history`)).json()
  assert.equal(history.interval_ms, 10000)
  assert.equal(history.samples.length, 1)
  assert.ok(history.samples[0].rss_bytes > 0 && history.samples[0].disk_free_bytes > 0)
  const wal = w.hub.ops.wal.checkpoint()
  assert.ok(wal.log_frames >= wal.checkpointed_frames)
  await w.hub.close()
})

// ---- quota -------------------------------------------------------------------------------

test('quota: eviction order, oldest first, and what is never evicted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trommi-ops-quota-')); tmpDirs.push(dir)
  const db = openDb(dir)
  const room = 'b'.repeat(64)
  const files = fakeFiles(), announced = []
  const quota = attachmentQuota({ db, files, quotaBytes: 1000, announce: (r, e, d) => announced.push([e, d]) })
  const closed = aid(100), answered = aid(101), open = aid(102)
  fakeObject(db, room, closed, 3); fakeObject(db, room, answered, 2); fakeObject(db, room, open, 1)
  // id: what names it, stored_at
  fakeAttachment(db, room, aid(1), 100, 10, open); fakeEnvelope(db, room, { kind: 2, objectId: open, attachmentIds: [aid(1)] })          // open object: never
  fakeAttachment(db, room, aid(2), 100, 20); fakeEnvelope(db, room, { kind: 6, attachmentIds: [aid(2)] })                               // canvas snapshot pointer: never
  fakeAttachment(db, room, aid(3), 100, 30)                                                                                            // named by nothing yet: never
  fakeAttachment(db, room, aid(4), 100, 40); fakeEnvelope(db, room, { kind: 1, attachmentIds: [aid(4)] })                               // old thread item
  fakeAttachment(db, room, aid(5), 100, 50, closed); fakeEnvelope(db, room, { kind: 2, objectId: closed, attachmentIds: [aid(5)] })     // closed object
  fakeAttachment(db, room, aid(6), 100, 60, answered); fakeEnvelope(db, room, { kind: 1, attachmentIds: [aid(6)] })                     // chat of an answered card
  fakeAttachment(db, room, aid(7), 100, 70); fakeEnvelope(db, room, { kind: 1, attachmentIds: [aid(7)] }); fakeEnvelope(db, room, { kind: 6, attachmentIds: [aid(7)] }) // thread item and snapshot: never
  fakeAttachment(db, room, aid(8), 300, 5, closed); fakeEnvelope(db, room, { kind: 1, attachmentIds: [aid(8)] })                       // oldest, closed card chat
  assert.equal(quota.used(room), 1000)
  quota.check(room, 0)
  assert.deepEqual(files.gone, [])
  quota.make(room, 350)                       // needs 350: the 300 of #8, then 100 of #4
  assert.deepEqual(files.gone, [aid(8), aid(4)])
  assert.deepEqual(announced, [['attachment_evicted', { attachment_ids: [aid(8), aid(4)] }]])
  assert.equal(quota.used(room), 600)
  quota.make(room, 600)                       // 400 + 600 > 1000: #5, #6
  assert.deepEqual(files.gone.slice(2), [aid(5), aid(6)])
  assert.equal(quota.used(room), 400)
  // Only protected ones are left (#1, #2, #3, #7): no room for more than 600.
  assert.throws(() => quota.check(room, 601), err => err.reply.status === 413 && err.reply.body.error === 'quota-exceeded' && err.reply.body.used === 400 && err.reply.body.quota === 1000)
  assert.throws(() => quota.make(room, 601), err => err.reply.status === 413)
  assert.deepEqual(db.prepare('SELECT attachment_id FROM attachments ORDER BY attachment_id').all().map(r => r.attachment_id), [aid(1), aid(2), aid(3), aid(7)])
  db.close()
})

test('quota over HTTP: usage for members, eviction announced on the stream, 413 quota-exceeded', async () => {
  const w = await newHub({}, { ROOM_ATTACHMENT_QUOTA_BYTES: '1000' })
  await foundRoom(w)
  await expect(w, 'GET', `${R(w)}/usage`, {}, 401, 'unauthorised')
  assert.deepEqual((await expect(w, 'GET', `${R(w)}/usage`, { token: w.phone.token }, 200)).json, { attachment_bytes: 0, quota_bytes: 1000 })
  await expect(w, 'PUT', `${R(w)}/attachments/${aid(1)}`, { token: w.phone.token, raw: new Uint8Array(600) }, 201)
  fakeEnvelope(w.hub.db, w.roomId, { kind: 1, attachmentIds: [aid(1)] })      // a thread item names it
  const s = await openStream(w, w.phone.token)
  await sleep(50)
  await expect(w, 'PUT', `${R(w)}/attachments/${aid(2)}`, { token: w.phone.token, raw: new Uint8Array(600) }, 201)
  assert.deepEqual((await s.until(e => e.event === 'attachment_evicted')).data, { attachment_ids: [aid(1)] })
  await expect(w, 'GET', `${R(w)}/attachments/${aid(1)}`, { token: w.phone.token }, 404)
  assert.deepEqual((await expect(w, 'GET', `${R(w)}/usage`, { token: w.phone.token }, 200)).json, { attachment_bytes: 600, quota_bytes: 1000 })
  // #2 is named by nothing: protected. Known size: refused before the upload; chunked: after, and not stored.
  const r = await expect(w, 'PUT', `${R(w)}/attachments/${aid(3)}`, { token: w.phone.token, raw: new Uint8Array(500) }, 413, 'quota-exceeded')
  assert.deepEqual([r.json.used, r.json.quota], [600, 1000])
  const status = await new Promise((ok, bad) => {
    const req = http.request(`${w.base}${R(w)}/attachments/${aid(4)}`, { method: 'PUT', headers: { authorization: `Bearer ${w.phone.token}` } }, res => { res.resume(); ok(res.statusCode) })
    req.on('error', bad)
    req.end(Buffer.alloc(500))           // no content-length: chunked
  })
  assert.equal(status, 413)
  assert.ok(!fs.existsSync(path.join(w.dir, 'attachments', w.roomId, aid(4))))
  s.close()
  await w.hub.close()
})

// ---- escrow ------------------------------------------------------------------------------

test('escrow: put by a human, read by anyone with the room id (10 per hour per room and per address), 4 KiB, delete', async () => {
  const w = await newHub()
  await foundRoom(w)
  const blob = b64u(crypto.getRandomValues(new Uint8Array(200)))
  await expect(w, 'GET', `${R(w)}/escrow`, {}, 404, 'not-found')
  await expect(w, 'PUT', `${R(w)}/escrow`, { body: { escrow_version: 1, key_escrow: blob } }, 401, 'unauthorised')
  await expect(w, 'PUT', `${R(w)}/escrow`, { token: w.phone.token, body: { escrow_version: 0, key_escrow: blob } }, 400, 'bad-argument')
  await expect(w, 'PUT', `${R(w)}/escrow`, { token: w.phone.token, body: { escrow_version: 1, key_escrow: b64u(new Uint8Array(4097)) } }, 413, 'too-large')
  const put = (await expect(w, 'PUT', `${R(w)}/escrow`, { token: w.phone.token, body: { escrow_version: 1, key_escrow: blob } }, 200)).json
  assert.equal(put.escrow_version, 1)
  const got = (await expect(w, 'GET', `${R(w)}/escrow`, {}, 200)).json
  assert.deepEqual(got, { escrow_version: 1, key_escrow: blob, updated_at: put.updated_at })
  for (let i = 0; i < 8; i++) await expect(w, 'GET', `${R(w)}/escrow`, { headers: { 'cf-connecting-ip': freshIp() } }, 200)
  // 10 reads of this room in the hour (the first answered 404 and counts too): the room is closed for reads from anywhere.
  const r = await expect(w, 'GET', `${R(w)}/escrow`, { headers: { 'cf-connecting-ip': freshIp() } }, 429, 'rate-limited')
  assert.ok(Number(r.headers.get('retry-after')) > 3000)
  await expect(w, 'GET', `${R(w)}/escrow`, { headers: signed('GET', `${R(w)}/escrow`) }, 429, 'rate-limited')       // a test signature lifts nothing
  // "No room" and "no escrow" are one answer.
  await expect(w, 'GET', `/v1/rooms/${'c'.repeat(64)}/escrow`, { headers: { 'cf-connecting-ip': freshIp() } }, 404, 'not-found')
  await expect(w, 'DELETE', `${R(w)}/escrow`, { token: w.phone.token }, 200)
  await w.hub.close()
})

// ---- run ---------------------------------------------------------------------------------

const only = process.argv[2]
let failed = 0
const t0 = performance.now()
for (const t of tests) {
  if (only && !t.name.includes(only)) continue
  const s = performance.now()
  try { await t.fn(); console.log(`ok    ${t.name} (${(performance.now() - s).toFixed(0)} ms)`) } catch (err) { failed++; console.log(`FAIL  ${t.name}\n${err?.stack ?? err}`) }
}
for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
const ran = tests.filter(t => !only || t.name.includes(only)).length
console.log(`\n${ran - failed} of ${ran} ops tests passed in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
process.exit(failed ? 1 : 0)
