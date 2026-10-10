// codec.test.mjs: the bodies of spec/v1.md 9.1 between the wire and the model, both directions (codec.ts): the
// fields of each kind, ids (base64url on the wire, hex in the model), attachment references, register names and
// values, and what is refused.
//   node --test tests/web/model/
import test from 'node:test'
import assert from 'node:assert/strict'
import { attachmentFromWire, attachmentRef, attachmentToWire, decodeBody, encodeBody, encodeBodyBytes, encodeRegister, fileIdsOf, fileRefOf, registerKeyOf, registerNameOf, shapeIdFromWire, shapeIdToWire, SCHEMA_VERSION } from '../../../app/web/core/codec.ts'
import { device, hex, id16, bytes, raw } from './factory.mjs'

const text = b => (b === null ? null : new TextDecoder().decode(b))
/** A register write with its value as text, to compare. */
const written = (key, value) => { const w = encodeRegister(key, value); return { name: w.name, value: text(w.value) } }

const file = id16(0xf1), poster = id16(0xf2)
const wireRef = { file_id: file, file_key: bytes(32, 1), sha256: bytes(32, 2), file_name: 'clip.mp4', media_type: 'video/mp4', total_size: 5000, width: 640, height: 360, caption: 'the demo', poster_file_id: poster, marks: [{ x: 1 }] }
const modelRef = { attachment_id: hex(file), file_key: wireRef.file_key, sha256: wireRef.sha256, file_name: 'clip.mp4', media_type: 'video/mp4', total_size: 5000, width: 640, height: 360, caption: 'the demo', poster_attachment_id: hex(poster), marks: [{ x: 1 }] }

test('an attachment reference: file_id on the wire, attachment_id in the model, both ways', () => {
  assert.deepEqual(attachmentFromWire(wireRef), modelRef)
  assert.deepEqual(attachmentToWire(modelRef), wireRef)
  // the page a picture was made from names another attachment of the list by its id
  assert.equal(attachmentFromWire({ ...wireRef, page: `attachment:${poster}` }).page, `attachment:${hex(poster)}`)
  assert.equal(attachmentToWire({ ...modelRef, page: `attachment:${hex(poster)}` }).page, `attachment:${poster}`)
  assert.equal(attachmentToWire({ ...modelRef, page: 'https://example.org/p' }).page, 'https://example.org/p')
  // a field a newer client added is kept when read; a writer writes what it knows, with a name and a type always
  assert.equal(attachmentFromWire({ ...wireRef, duration_ms: 900 }).duration_ms, 900)
  assert.deepEqual(attachmentToWire({ attachment_id: hex(file), file_key: 'a2V5', sha256: 'c2hh', total_size: 3, url: 'blob:x' }), { file_id: file, file_name: 'file', media_type: 'application/octet-stream', total_size: 3, file_key: 'a2V5', sha256: 'c2hh' })
  for (const bad of [null, {}, { ...wireRef, file_id: hex(file) }, { ...wireRef, file_id: device(1) }, { ...wireRef, file_key: 'not/base64url' }, { ...wireRef, poster_file_id: 'x' }]) assert.throws(() => attachmentFromWire(bad), { code: 'bad-format' })
  assert.throws(() => attachmentToWire({ ...modelRef, attachment_id: file }), { code: 'bad-argument' })
  // from a file the core encrypted, and back to what the core opens it with
  const ref = attachmentRef({ fileId: raw(file), fileKey: raw(wireRef.file_key), sha256: raw(wireRef.sha256) }, { total_size: 12, file_name: 'a.txt', media_type: 'text/plain' })
  assert.deepEqual(ref, { attachment_id: hex(file), file_key: wireRef.file_key, sha256: wireRef.sha256, total_size: 12, file_name: 'a.txt', media_type: 'text/plain' })
  assert.deepEqual(fileRefOf(ref), { fileId: raw(file), fileKey: raw(wireRef.file_key), sha256: raw(wireRef.sha256) })
})

test('a Chat message: written with schema_version 2 and the wire\'s names, read back as the model\'s', () => {
  const card = id16(0xc1), artifact = id16(0xc7), note = id16(0xb1)
  const fields = { text: 'see the page', details: 'more', html: '<b>x</b>', attachments: [modelRef], hand_back: true, copied_cards: [hex(card)], marks: [1], note: { object_id: hex(note), written_at: 7 }, published_object_id: hex(artifact) }
  const wire = JSON.parse(encodeBody('message', { ...fields, local_only: 'dropped', undefined_field: undefined }))
  assert.deepEqual(wire, { schema_version: SCHEMA_VERSION, content_type: 'message', text: 'see the page', details: 'more', html: '<b>x</b>', attachments: [wireRef], hand_back: true, copied_cards: [card], marks: [1], note: { object_id: note, written_at: 7 }, artifact_object_id: artifact })
  assert.deepEqual(decodeBody('message', JSON.stringify(wire)), { schema_version: 2, content_type: 'message', ...fields })
  assert.deepEqual(decodeBody('message', '{"text":"plain"}'), { text: 'plain', content_type: 'message' }, 'no schema_version is version 2; a message without a content type is a message')
  assert.equal(decodeBody('message', '{"schema_version":3,"text":"x"}'), 'newer_schema')
  assert.deepEqual(decodeBody('message', encodeBodyBytes('message', { text: 'grüß dich' })), { schema_version: 2, content_type: 'message', text: 'grüß dich' }, 'a payload as the bytes the core hands over')
  assert.equal(decodeBody('message', Uint8Array.of(0x7b, 0x22, 0xff, 0x22, 0x7d)), 'bad', 'bytes that are no UTF-8')
  for (const bad of ['', 'null', '[]', '"x"', '{', '{"schema_version":"2"}', '{"attachments":[{"file_id":"x"}]}']) assert.equal(decodeBody('message', bad), 'bad', bad)
  assert.equal(decodeBody('message', JSON.stringify({ text: 'x', note: { object_id: 'not an id' }, from_the_future: 1 })).note, undefined, 'a bad note mark: the message stays, plain')
  assert.equal(decodeBody('message', '{"text":"x","from_the_future":1}').from_the_future, 1, 'unknown fields are kept')
  assert.throws(() => encodeBody('message', { text: 'x', note: { object_id: 'short' } }), { code: 'bad-argument' })
  assert.throws(() => encodeBody('message', { content_type: 'selection_sent', text: 'x' }), { code: 'bad-argument' }, 'a board\'s selection sent to a session is a message')
  assert.throws(() => encodeBody('message', { terminal: 'work', work: {} }), { code: 'bad-argument' }, 'a work trail is no stored message')
})

test('a card, an answer, a request, an Artifact, a Note', () => {
  const prev = bytes(32, 0xee, 1), into = id16(0xc2)
  const card = { object_version: 2, previous_version_hash: hex(prev), card_type: 'decision', title: 'Q', teaser: 'short', body: 'long', options: [{ key: 'a', label: 'A', final: true }, { key: 'b', label: 'B', final: false }],
    sections: null, allows_multiple: false, recommended: 'a', urgency_reason: 'soon', attachments: [modelRef], change_note: 'reworded', merged_into_object_id: hex(into), merged_from_object_ids: [hex(into)] }
  const wire = JSON.parse(encodeBody('card', card))
  assert.equal(wire.previous_version_hash, prev); assert.equal(wire.merged_into_object_id, into); assert.deepEqual(wire.merged_from_object_ids, [into]); assert.deepEqual(wire.attachments, [wireRef])
  assert.deepEqual(wire.options, [{ key: 'a', label: 'A', final: true }, { key: 'b', label: 'B' }], '`final` only where it is true')
  assert.deepEqual(decodeBody('card', JSON.stringify(wire)), { schema_version: 2, ...card, options: wire.options })
  assert.throws(() => encodeBody('card', { title: 'Q', teaser: 'two\nlines' }), { code: 'bad-argument' })
  assert.equal(decodeBody('card', JSON.stringify({ title: 'Q', teaser: ' padded ' })).teaser, undefined, 'a bad teaser is dropped: the Desk falls back to the body')
  assert.equal(decodeBody('card', JSON.stringify({ title: 'Q', previous_version_hash: 'nonsense' })), 'bad')

  const answer = { answer_action: 'answer', choices: ['a'], note: 'because', option_notes: { a: 'yes' }, attachments: [modelRef], marks: [], trusted: false }
  assert.deepEqual(decodeBody('answer', encodeBody('answer', { ...answer, pending: true, envelope_number: 5 })), { schema_version: 2, ...answer }, 'the model\'s own fields of an answer are not written')
  assert.equal(encodeBody('take_back', { anything: 1 }), '{"schema_version":2}'); assert.equal(encodeBody('verdict', {}), '{"schema_version":2}')
  assert.deepEqual(decodeBody('request', encodeBody('request', { tool_name: 'Bash', description: 'd', input_preview: 'ls', expires_at: 5 })), { schema_version: 2, tool_name: 'Bash', description: 'd', input_preview: 'ls' })

  const artifact = { object_version: 1, artifact_type: 'page', title: 'Report', note: null, attachments: [modelRef], released_until: 99 }
  const aw = JSON.parse(encodeBody('artifact', artifact))
  assert.equal(aw.shared_until, 99); assert.equal('released_until' in aw, false)
  assert.deepEqual(decodeBody('artifact', JSON.stringify(aw)), { schema_version: 2, ...artifact })

  // a Note's fields are the app's: everything is written
  const note = { text: 'call', place: 'desk', to: 'abc', held: { until: 5 }, attachments: [modelRef], lamport: 4 }
  const nw = JSON.parse(encodeBody('note', { ...note, gone: undefined }))
  assert.deepEqual(nw, { schema_version: 2, text: 'call', place: 'desk', to: 'abc', held: { until: 5 }, attachments: [wireRef], lamport: 4 })
  assert.deepEqual(decodeBody('note', JSON.stringify(nw)), { schema_version: 2, ...note })
})

test('registers: the model\'s keys and the wire\'s names, the ids inside a value', () => {
  const obj = id16(0xc1), board = id16(0xde), dev = device(3), hash = bytes(32, 0x44)
  const pairs = [
    [`draft/${obj}`, `draft/${hex(obj)}`], [`snooze/${obj}`, `snooze/${hex(obj)}`], [`duck/${obj}`, `duck/${hex(obj)}`], [`desk/${board}`, `desk/${hex(board)}`], [`session/${obj}`, `session/${hex(obj)}`],
    [`board_snapshot/${board}`, `scribble_snapshot/desk/${hex(board)}`], [`device/${dev}`, `device/${hex(dev)}`], [`alert/${hash}`, `alert/${hex(hash)}`], [`read/card/${obj}`, `read/card/${hex(obj)}`],
    ['crown', 'crown'], ['kit', 'kit'], ['heads', 'heads'], ['profile', 'profile'], ['heard', 'heard'], ['goals', 'goals'], ['status_line/tests', 'status_line/tests'], ['desk/main', 'desk/main'],
  ]
  for (const [name, key] of pairs) { assert.equal(registerKeyOf(name), key, name); assert.equal(registerNameOf(key), name, key) }
  assert.deepEqual(decodeBody('register', JSON.stringify({ name: `session/${obj}`, value: { name: 'S', desk: board }, lamport: 6 })), { name: `session/${obj}`, key: `session/${hex(obj)}`, value: { name: 'S', desk: hex(board) }, lamport: 6 })
  assert.deepEqual(decodeBody('register', JSON.stringify({ name: 'crown', value: null, lamport: 1 })), { name: 'crown', key: 'crown', value: null, lamport: 1 })
  assert.equal(decodeBody('register', '{"value":1}'), 'bad')
  // what a draft's register write hands the core: the wire's name and the value as JSON bytes (null deletes)
  assert.ok(encodeRegister('crown', { a: 1 }).value instanceof Uint8Array)
  assert.deepEqual(written(`session/${hex(obj)}`, { name: 'S', desk: hex(board), archived: true }), { name: `session/${obj}`, value: JSON.stringify({ name: 'S', desk: board, archived: true }) })
  assert.deepEqual(written('crown', { session_id: hex(obj), agent_device_id: hex(dev) }), { name: 'crown', value: JSON.stringify({ session_id: obj, agent_device_id: dev }) })
  assert.deepEqual(written(`draft/${hex(obj)}`, null), { name: `draft/${obj}`, value: null })
  assert.deepEqual(written('status_line/tests', { label: 'Tests', object_id: hex(obj) }), { name: 'status_line/tests', value: JSON.stringify({ label: 'Tests', object_id: obj }) })
  // the board snapshot as the whiteboard writes it and as spec 10.2 has it
  const snap = written(`scribble_snapshot/desk/${hex(board)}`, { attachment: modelRef, frontier: { [hex(dev)]: [4, hex(hash)] }, last_envelope_number: 300, shapes: 12 })
  assert.equal(snap.name, `board_snapshot/${board}`); assert.deepEqual(JSON.parse(snap.value), { attachment: wireRef, frontier: { [dev]: [4, hash] }, change: 300 })
  assert.throws(() => encodeBody('register', {}), { code: 'bad-argument' })
})

test('the files a body names, for the envelope\'s header; shape ids', () => {
  assert.deepEqual(fileIdsOf('message', { attachments: [modelRef, modelRef] }), [raw(file), raw(poster)])
  assert.deepEqual(fileIdsOf('board_item', { content_type: 'strokes', strokes: [{ tool: 'pen' }, { tool: 'image', attachment: modelRef }] }), [raw(file), raw(poster)])
  assert.deepEqual(fileIdsOf('register', { value: { attachment: { attachment_id: hex(file) } } }), [raw(file)]); assert.deepEqual(fileIdsOf('card', { title: 'Q' }), [])
  const dev = device(4)
  assert.equal(shapeIdFromWire(`${dev}/17/3`), `${hex(dev)}/17/3`); assert.equal(shapeIdToWire(`${hex(dev)}/17/3`), `${dev}/17/3`)
  for (const bad of [`${dev}/0/0`, `${dev}/1`, `${dev}/1/01`, `${hex(dev)}/1/0`, `x/1/0`, `${dev}/1/0/2`, null]) assert.equal(shapeIdFromWire(bad), null, String(bad))
  assert.equal(shapeIdToWire(`${dev}/1/0`), null)
})
