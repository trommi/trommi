// Files and Share links against the fake hub: one PUT with the bytes (the hub has no chunk protocol: it reads the
// body as a stream), GET with Range, progress, abort, a body that breaks off, and answers a hub must not give.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { HubError } from '../../../app/web/core/hub.ts'
import { scene, client, received, envelope, id, txt } from './helpers.mjs'

const FIVE_MIB = 5 << 20
const sha256 = bytes => new Uint8Array(createHash('sha256').update(bytes).digest())

test('a 5 MiB file goes up in pieces and comes down whole, with progress both ways', async t => {
  const { fake, hub, room_id } = await scene(t)
  const file_id = id(16), bytes = new Uint8Array(randomBytes(FIVE_MIB))
  const up = []
  let transfer = null
  fake.faults.add({ method: 'PUT', when: rq => { transfer = [rq.headers['content-length'], rq.headers['transfer-encoding'], rq.headers['content-type']]; return false } })
  const stored = await hub.putFile(file_id, bytes, { onProgress: (done, total) => up.push([done, total]) })
  assert.deepEqual([stored.file_id, stored.size], [file_id, FIVE_MIB])
  assert.deepEqual(stored.sha256, sha256(bytes))
  assert.deepEqual(transfer, [String(FIVE_MIB), undefined, 'application/octet-stream'], 'the length is announced: the hub reserves exactly that')
  assert.ok(up.length >= 80, `${up.length} progress calls for 80 pieces of 64 KiB`)
  assert.ok(up.every(([done, total], i) => total === FIVE_MIB && done > 0 && (i === 0 || done >= up[i - 1][0])))
  assert.deepEqual(up.at(-1), [FIVE_MIB, FIVE_MIB])
  assert.ok(Buffer.from(bytes).equals(fake.state.rooms.get(txt(room_id)).files.get(txt(file_id)).bytes))

  const down = []
  const got = await hub.getFile(file_id, { onProgress: (done, total) => down.push([done, total]) })
  assert.equal(got.size, FIVE_MIB)
  assert.ok(Buffer.from(got.bytes).equals(Buffer.from(bytes)))
  assert.ok(down.length > 1 && down.every(([, total]) => total === FIVE_MIB))
  assert.deepEqual(down.at(-1), [FIVE_MIB, FIVE_MIB])
})

test('without a progress callback, and as a Blob, the bytes go in one piece', async t => {
  const { fake, hub } = await scene(t)
  const bytes = new Uint8Array(randomBytes(200_000))
  const [a, b] = [id(16), id(16)]
  await hub.putFile(a, bytes)
  const stored = await hub.putFile(b, new Blob([bytes]))
  assert.deepEqual(stored.sha256, sha256(bytes))
  assert.deepEqual(received(fake, /^\/v2\/files\//, 'PUT').map(r => r.body.bytes), [200_000, 200_000])
  assert.deepEqual((await hub.getFile(b)).bytes, bytes)
})

test('Range: a part of a file, its end, and a range the file does not have', async t => {
  const { hub } = await scene(t)
  const file_id = id(16), bytes = new Uint8Array(randomBytes(100_000))
  await hub.putFile(file_id, bytes)
  const middle = await hub.getFile(file_id, { range: { start: 1000, end: 1999 } })
  assert.deepEqual([middle.size, middle.bytes.length], [100_000, 1000])
  assert.deepEqual(middle.bytes, bytes.subarray(1000, 2000))
  const tail = await hub.getFile(file_id, { range: { start: 99_990 } })
  assert.deepEqual(tail.bytes, bytes.subarray(99_990))
  const over = await hub.getFile(file_id, { range: { start: 99_000, end: 500_000 } })
  assert.deepEqual(over.bytes, bytes.subarray(99_000))
  const beyond = await hub.getFile(file_id, { range: { start: 100_000 } }).catch(e => e)
  assert.deepEqual([beyond.code, beyond.status, beyond.transient], ['range', 416, false])
  await assert.rejects(hub.getFile(file_id, { range: { start: 5, end: 4 } }), { code: 'bad-argument' })
})

test('a download that breaks off is taken up by Range from where it broke', async t => {
  const { fake, hub } = await scene(t)
  const file_id = id(16), bytes = new Uint8Array(randomBytes(FIVE_MIB))
  await hub.putFile(file_id, bytes)
  fake.faults.add({ method: 'GET', path: `/v2/files/${txt(file_id)}`, drop: 'mid' })
  const got = await hub.getFile(file_id)
  assert.ok(Buffer.from(got.bytes).equals(Buffer.from(bytes)))
  const gets = received(fake, `/v2/files/${txt(file_id)}`, 'GET')
  assert.deepEqual(gets.map(r => r.status), [200, 206])
  fake.faults.add({ method: 'GET', path: `/v2/files/${txt(file_id)}`, drop: 'mid', times: 5 })
  await assert.rejects(hub.getFile(file_id), e => e instanceof HubError && e.code === 'offline')
  assert.equal(received(fake, `/v2/files/${txt(file_id)}`, 'GET').length, 5, 'three tries, then it is the caller\'s turn')
})

test('abort: an upload and a download stop with the caller\'s reason, not as "offline"', async t => {
  const { fake, hub, room_id } = await scene(t)
  const file_id = id(16), bytes = new Uint8Array(randomBytes(FIVE_MIB))
  const up = new AbortController()
  await assert.rejects(hub.putFile(file_id, bytes, { signal: up.signal, onProgress: done => { if (done > 1 << 20) up.abort() } }), e => e.name === 'AbortError' && !(e instanceof HubError))
  assert.equal(fake.state.rooms.get(txt(room_id)).files.has(txt(file_id)), false)
  await hub.putFile(file_id, bytes)
  const down = new AbortController()
  await assert.rejects(hub.getFile(file_id, { signal: down.signal, onProgress: () => down.abort(new Error('the person left')) }), { message: 'the person left' })
  const before = new AbortController()
  before.abort()
  await assert.rejects(hub.getFile(file_id, { signal: before.signal }), e => e.name === 'AbortError')
})

test('the same bytes again get the first answer; other bytes under the id are refused; a deleted id is gone', async t => {
  const { fake, hub, room_id } = await scene(t)
  const file_id = id(16), bytes = new Uint8Array(randomBytes(5000))
  const first = await hub.putFile(file_id, bytes)
  fake.faults.add({ method: 'PUT', path: `/v2/files/${txt(file_id)}`, drop: 'after' })
  assert.deepEqual(await hub.putFile(file_id, bytes), first, 'an answer lost once: sent again at once')
  fake.faults.add({ method: 'PUT', path: `/v2/files/${txt(file_id)}`, drop: 'after', times: 2 })
  await assert.rejects(hub.putFile(file_id, bytes), e => e.code === 'offline')
  assert.deepEqual(await hub.putFile(file_id, bytes), first)
  assert.equal(fake.state.rooms.get(txt(room_id)).files.size, 1)
  const other = await hub.putFile(file_id, new Uint8Array(randomBytes(5000))).catch(e => e)
  assert.deepEqual([other.code, other.status], ['replay', 409])
  await hub.deleteFile(file_id)
  const gone = await hub.putFile(file_id, bytes).catch(e => e)
  assert.deepEqual([gone.code, gone.status], ['gone', 410])
  await assert.rejects(hub.getFile(file_id), e => e.code === 'not-found' && e.status === 404)
})

test('a file read needs a token, and a file nobody may read does not exist', async t => {
  const { fake, hub, room_id } = await scene(t)
  const file_id = id(16)
  await hub.putFile(file_id, new Uint8Array(10))
  const seen = []
  fake.faults.add({ times: 9, method: 'GET', when: rq => { seen.push('authorization' in rq.headers); return false } })
  await hub.getFile(file_id)
  assert.deepEqual(seen, [true])
  const other = id(32)
  fake.state.rooms.get(txt(room_id)).devices.set(txt(other), 'helper')
  await assert.rejects(client(fake, room_id, other).getFile(file_id), e => e.code === 'not-found')
})

test('a hub that answers a file request with something else is refused', async t => {
  const { fake, hub } = await scene(t)
  const file_id = id(16), bytes = new Uint8Array(randomBytes(4000)), path = `/v2/files/${txt(file_id)}`
  await hub.putFile(file_id, bytes)
  const whole = { 'content-type': 'application/octet-stream' }
  const cases = [
    [{ start: 100, end: 199 }, { status: 200, headers: whole, body: Buffer.from(bytes) }, 'the whole file for a range'],
    [{ start: 100, end: 199 }, { status: 206, headers: { ...whole, 'content-range': 'bytes 0-99/4000' }, body: Buffer.alloc(100) }, 'another range'],
    [{ start: 100, end: 199 }, { status: 206, headers: { ...whole, 'content-range': 'bytes 100-199/99999999999' }, body: Buffer.alloc(100) }, 'a file larger than any file'],
    [{ start: 100, end: 199 }, { status: 206, headers: whole, body: Buffer.alloc(100) }, 'no content-range'],
    [{ start: 100 }, { status: 206, headers: { ...whole, 'content-range': 'bytes 100-99/100' }, body: '' }, 'a range that is none'],
    [undefined, { status: 206, headers: { ...whole, 'content-range': 'bytes 0-99/4000' }, body: Buffer.alloc(100) }, 'a range nobody asked for'],
    [undefined, { status: 204, headers: {}, body: '' }, 'no content'],
  ]
  for (const [range, raw, what] of cases) {
    fake.faults.add({ method: 'GET', path, raw })
    await assert.rejects(hub.getFile(file_id, range ? { range } : {}), e => e.code === 'bad-answer', what)
  }
  for (const answer of [a => ({ ...a, size: 1 }), a => ({ ...a, file_id: id(16) }), a => ({ ...a, sha256: 'AAAA' }), () => ({})]) {
    fake.faults.add({ method: 'PUT', answer })
    await assert.rejects(hub.putFile(id(16), bytes), e => e.code === 'bad-answer')
  }
})

test('a Share link: registered, read by its secret without a token, the secret in a header only, revoked', async t => {
  const { fake, hub, room_id, device } = await scene(t)
  const file_id = id(16), share_id = id(16), bytes = new Uint8Array(randomBytes(30_000)), secret = new Uint8Array(randomBytes(32))
  await hub.putFile(file_id, bytes)
  await assert.rejects(hub.postShare({ share_id, secret_hash: sha256(secret), file_id, expires_at: Date.now() + 86_400_000 }), e => e.code === 'forbidden', 'a file no open Artifact names')
  await hub.postEnvelope(envelope(room_id, device, 1, { kind: 'version', object: { object_id: id(16), object_type: 'artifact', object_state: 'open', urgency: 'normal', answered_at: 0 }, file_ids: [file_id] }))
  const share = { share_id, secret_hash: sha256(secret), file_id, expires_at: Date.now() + 86_400_000 }
  assert.deepEqual(await hub.postShare(share), { share_id, expires_at: share.expires_at })
  assert.deepEqual(await hub.postShare(share), { share_id, expires_at: share.expires_at }, 'registered again: the first answer')

  const outsider = client(fake, null)
  const seen = []
  fake.faults.add({ times: 9, path: `/v2/shares/${txt(share_id)}`, when: rq => { seen.push(['authorization' in rq.headers, rq.headers['x-share-secret']]); return false } })
  const got = await outsider.getShared(share_id, secret)
  assert.deepEqual(got.bytes, bytes)
  assert.deepEqual((await outsider.getShared(share_id, secret, { range: { start: 10, end: 19 } })).bytes, bytes.subarray(10, 20))
  assert.deepEqual(seen[0], [false, Buffer.from(secret).toString('base64url')])
  assert.ok(received(fake, `/v2/shares/${txt(share_id)}`).every(r => Object.keys(r.query).length === 0), 'the secret is never in the address')
  const wrong = await outsider.getShared(share_id, new Uint8Array(32)).catch(e => e)
  const unknown = await outsider.getShared(id(16), secret).catch(e => e)
  assert.deepEqual([wrong.code, wrong.status, wrong.hub_message], [unknown.code, unknown.status, unknown.hub_message], 'every refusal is the same')
  assert.equal(wrong.code, 'not-found')
  await hub.deleteShare(share_id)
  await assert.rejects(outsider.getShared(share_id, secret), e => e.code === 'not-found')
})
