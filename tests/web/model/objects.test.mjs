// objects.test.mjs: permission requests, Notes and Artifacts in the model, from hand-made core results (factory.mjs).
//   node --test tests/web/model/
import test from 'node:test'
import assert from 'node:assert/strict'
import { World, hex, id16, bytes } from './factory.mjs'

const request = (w, id, expires_at, extra = {}) => w.take({ kind: 'request', object: w.object(id, 'request', 'open', { urgency: 'critical' }), push: true,
  payload: { schema_version: 2, tool_name: 'Bash', description: 'Remove the build folder', input_preview: 'rm -rf build' }, bind: { kind: 'request', request_id: id, expires_at }, ...extra })
const verdict = (w, id, allow, req, extra = {}) => w.take({ kind: 'verdict', sender: w.me, recipient: w.agent, object: w.object(id, 'request', 'closed', { object_ref: req.hash }), payload: { schema_version: 2 },
  bind: { kind: 'verdict', request_id: id, request_hash: req.hash, expires_at: 0, allow }, ...extra })

test('a permission request: pending, then allowed or denied by a verdict', () => {
  const w = new World(); w.groups()
  const [a, b] = [id16(0xa1), id16(0xa2)]
  const ra = request(w, a, w.clock + 60_000), rb = request(w, b, w.clock + 60_000)
  let p = w.model.permissions.get(hex(a))
  assert.equal(p.permission_state, 'pending'); assert.equal(p.tool_name, 'Bash'); assert.equal(p.input_preview, 'rm -rf build'); assert.equal(p.agent_device_id, hex(w.agent)); assert.equal(p.session_id, hex(w.session))
  assert.equal(p.version_hash, hex(ra.hash)); assert.equal(p.verdict, null)
  assert.deepEqual(w.model.open_permission_ids, [hex(a), hex(b)], 'pending requests, oldest first'); assert.deepEqual(w.model.stack, [], 'requests are not in the stack')

  const va = verdict(w, a, true, ra)
  p = w.model.permissions.get(hex(a))
  assert.equal(p.permission_state, 'allowed'); assert.deepEqual(p.verdict, { allow: true, by_device_id: hex(w.me), envelope_number: va.change })
  verdict(w, b, false, rb)
  assert.equal(w.model.permissions.get(hex(b)).permission_state, 'denied'); assert.equal(w.model.permissions.get(hex(b)).verdict.allow, false)
  assert.deepEqual(w.model.open_permission_ids, []); assert.ok(w.last.stack && w.last.permissions.has(hex(b)))
})

test('a permission request expires by the clock; a verdict the core did not count changes nothing', () => {
  const w = new World(); w.groups()
  const id = id16(0xa3)
  const req = request(w, id, w.clock + 5_000)
  assert.deepEqual(w.model.open_permission_ids, [hex(id)])
  const late = verdict(w, id, true, req, { sender: w.phone, outcome: 'chained', code: 'forbidden', object_after: null })
  assert.equal(late.result.refused, 'forbidden'); assert.equal(w.model.permissions.get(hex(id)).permission_state, 'pending')
  w.clock += 10_000
  w.run(() => {})      // the clock alone: project() after any change, or the app's timer
  assert.equal(w.model.permissions.get(hex(id)).permission_state, 'expired'); assert.deepEqual(w.model.open_permission_ids, [])
  assert.ok(w.last.permissions.has(hex(id)) && w.last.stack, 'the change names the request that ran out')
})

test('a permission request has no later version in protocol v1: nothing withdraws it, a pruned verdict leaves it closed', () => {
  const w = new World(); w.groups()
  const id = id16(0xa4)
  const req = request(w, id, 0, { outcome: 'chained', code: 'pruned' })
  let p = w.model.permissions.get(hex(id))
  assert.equal(p.permission_state, 'pending'); assert.equal(p.tool_name, '', 'a pruned request: its header only')
  // a second "request" envelope for the same object is forbidden by the core's replay (9.2.1) and counts for nothing
  const again = request(w, id, 0, { object_after: null, outcome: 'chained', code: 'forbidden' })
  assert.equal(again.result.refused, 'forbidden'); assert.equal(w.model.permissions.get(hex(id)).permission_state, 'pending')
  verdict(w, id, true, req, { outcome: 'chained', code: 'pruned' })
  p = w.model.permissions.get(hex(id))
  assert.equal(p.permission_state, 'denied', 'allow or deny stood in the pruned body: what is left is "closed", never shown as allowed'); assert.equal(p.verdict, null)
})

const note = (w, id, fields, { sender = w.me, state = 'open', previous = null, current, ...rest } = {}) => {
  const hash = w.hash()
  const known = w.objects.get(id)
  const object_after = { object_id: id, owner: known?.owner ?? sender, object_state: current === false ? known.state : state, current_version: current === false ? known.current : hash }
  if (current !== false) w.objects.set(id, { owner: object_after.owner, current: hash, state })
  return w.take({ kind: 'version', sender, session: null, hash, object: w.object(id, 'note', state, { object_ref: previous }), payload: { schema_version: 2, lamport: 1, ...fields }, object_after, ...rest })
}

test('notes: any human device writes a version; of two concurrent ones the core says which is current', () => {
  const w = new World(); w.groups()
  const id = id16(0xb1), hid = hex(id)
  const n1 = note(w, id, { text: 'buy milk', place: 'desk', created_at: 5 })
  let n = w.model.notes.get(hid)
  assert.equal(n.text, 'buy milk'); assert.equal(n.place, 'desk', 'the app\'s fields ride along'); assert.equal(n.object_version, 1); assert.equal(n.by_device_id, hex(w.me)); assert.equal(n.pending, false)
  assert.equal(n.version_hash, hex(n1.hash)); assert.equal(n.envelope_number, n1.change); assert.ok(w.last.notes.has(hid))
  // the phone and this device both write on version 1; the core takes the phone's (the higher stamp), whatever the hub's order
  const mine = note(w, id, { text: 'buy milk and bread', lamport: 2 }, { previous: n1.hash })
  assert.equal(w.model.notes.get(hid).text, 'buy milk and bread')
  const theirs = note(w, id, { text: 'buy oat milk', lamport: 3 }, { sender: w.phone, previous: n1.hash })
  n = w.model.notes.get(hid)
  assert.equal(n.text, 'buy oat milk'); assert.equal(n.by_device_id, hex(w.phone)); assert.equal(n.object_version, 3)
  // a third, late one that loses: kept as a version, not shown
  const late = note(w, id, { text: 'buy nothing', lamport: 1 }, { sender: w.phone, previous: n1.hash, current: false })
  n = w.model.notes.get(hid)
  assert.equal(late.result.applied, false); assert.equal(n.text, 'buy oat milk'); assert.equal(n.version_hash, hex(theirs.hash))
  assert.deepEqual(n.version_hashes, [n1, mine, theirs, late].map(x => hex(x.hash)))
  assert.deepEqual(n.causal, { sender_device_id: hex(w.phone), sender_sequence: 1, sent_at: theirs.time, lamport: 3 })
  // deleted: a closed version
  note(w, id, { text: 'buy oat milk' }, { state: 'closed', previous: theirs.hash })
  assert.equal(w.model.notes.get(hid).object_state, 'closed')
})

test('a note of a newer Trommi keeps what was shown and says so', () => {
  const w = new World(); w.groups()
  const id = id16(0xb2)
  const n1 = note(w, id, { text: 'as written', attachments: [{ file_id: id16(0xf1), file_key: 'a2V5', sha256: 'c2hh', file_name: 'p.png', media_type: 'image/png', total_size: 3 }] })
  assert.equal(w.model.notes.get(hex(id)).attachments[0].attachment_id, hex(id16(0xf1)), 'an attachment is the model\'s reference')
  note(w, id, {}, { previous: n1.hash, outcome: 'chained', code: 'newer-version' })
  const n = w.model.notes.get(hex(id))
  assert.equal(n.unsupported, true); assert.equal(n.text, 'as written'); assert.equal(n.object_version, 2); assert.ok(w.model.newer.count >= 1)
})

const artifact = (w, id, fields, { state = 'open', previous = null, file_ids = [], ...rest } = {}) =>
  w.take({ kind: 'version', object: w.object(id, 'artifact', state, { object_ref: previous }), payload: { schema_version: 2, ...fields, ...(previous ? { previous_version_hash: previous } : {}) }, file_ids, ...rest })

test('an Artifact: published, changed, closed', () => {
  const w = new World(); w.groups()
  const id = id16(0xc7), file = id16(0xf2)
  const attachment = { file_id: file, file_key: bytes(32, 7), sha256: bytes(32, 8), file_name: 'report.html', media_type: 'text/html', total_size: 1200 }
  const v1 = artifact(w, id, { artifact_type: 'page', title: 'Report', attachments: [attachment], object_version: 1 }, { file_ids: [file] })
  let p = w.model.published.get(hex(id))
  assert.equal(p.title, 'Report'); assert.equal(p.object_state, 'open'); assert.equal(p.agent_device_id, hex(w.agent)); assert.equal(p.session_id, hex(w.session)); assert.equal(p.artifact_type, 'page')
  assert.deepEqual(p.attachments, [{ attachment_id: hex(file), file_key: attachment.file_key, sha256: attachment.sha256, file_name: 'report.html', media_type: 'text/html', total_size: 1200 }])
  assert.equal(p.sent_at, v1.time); assert.equal(p.released_until, null); assert.ok(w.last.published.has(hex(id)))

  const v2 = artifact(w, id, { artifact_type: 'page', title: 'Report (final)', note: 'with the numbers', attachments: [attachment], shared_until: 1_800_000_000_000, object_version: 2 }, { previous: v1.hash })
  p = w.model.published.get(hex(id))
  assert.equal(p.title, 'Report (final)'); assert.equal(p.note, 'with the numbers'); assert.equal(p.released_until, 1_800_000_000_000, 'shared_until on the wire'); assert.equal(p.object_version, 2)
  assert.equal(p.sent_at, v1.time, 'when it was published'); assert.equal(p.envelope_number, v2.change)

  artifact(w, id, { artifact_type: 'page', title: 'Report (final)', attachments: [attachment], object_version: 3 }, { state: 'closed', previous: v2.hash })
  assert.equal(w.model.published.get(hex(id)).object_state, 'closed', 'a closed version revokes it')
})
