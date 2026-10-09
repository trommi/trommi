// scribble.test.mjs: the Scribble Board's stroke format, its merge and its snapshot (ink.ts, scribble.ts, palette.ts,
// the board bodies of codec.ts) against the sample strokes every implementation is checked with (spec/strokes.json),
// and a board built through the model from hand-made core results (factory.mjs). The merge under test is the
// TypeScript one (reduceBoard); trommi-core's own is not loaded here.
//   node --test tests/web/model/
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { decodeBody, encodeBody, encodePiece } from '../../../app/web/core/codec.ts'
import { b64u } from '../../../app/web/core/ids.ts'
import { packPoints, unpackPoints, sampleStroke, anglesOfTilt, forceFromSpeed, thickness, Q, MAX_POINTS } from '../../../app/web/core/ink.ts'
import { PALETTE, PEN_COLORS, MARKER_COLORS, colorOf, isToken } from '../../../app/web/core/palette.ts'
import { CanvasState, entryOf, shapeOf, reduceBoard, packSnapshot, unpackSnapshot, deskBoard, MAIN_BOARD, ALL_BOARD, chunks } from '../../../app/web/core/scribble.ts'
import { World, device, hex, id16, bytes } from './factory.mjs'

const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`)
const fixture = JSON.parse(fs.readFileSync(new URL('../../../spec/strokes.json', import.meta.url), 'utf8'))
const pencil = fixture.strokes.find(s => s.name === 'pen-pencil').entry

// ---- packed points (spec 10.6) ----

test('points: round trip of x, y, t, force, azimuth, altitude within the quanta', () => {
  const ink = { pts: [], t: [], f: [], az: [], al: [], sim: false }
  for (let i = 0; i < 300; i++) { ink.pts.push(1e6 * Math.sin(i) * (i % 3 ? 1 : -1e-6), -3.3 * i); ink.t.push(i * 4.2); ink.f.push((i % 17) / 16); ink.az.push((i * 0.37) % 6.28); ink.al.push((i * 0.11) % 1.57) }
  const got = unpackPoints(packPoints(ink))
  assert.equal(got.t.length, 300)
  for (let i = 0; i < 300; i++) {
    near(got.pts[2 * i], ink.pts[2 * i], 0.5 / Q, 'x'); near(got.pts[2 * i + 1], ink.pts[2 * i + 1], 0.5 / Q, 'y')
    assert.equal(got.t[i], Math.round(ink.t[i]))
    near(got.f[i], ink.f[i], 0.5 / 255 + 1e-3, 'force')
    near(Math.cos(got.az[i]), Math.cos(ink.az[i]), 0.02, 'azimuth'); near(got.al[i], ink.al[i], 0.004, 'altitude')
  }
  assert.equal(got.sim, false)
  const plain = unpackPoints(packPoints({ pts: [1, 2, 3, 4], t: [0, 10], f: [0.2, 0.3], sim: true }))
  assert.equal(plain.az, null); assert.equal(plain.sim, true)
})

test('points: deterministic and compact (a 240 Hz pencil point is about 7 bytes with tilt)', () => {
  const ink = { pts: [], t: [], f: [], az: [], al: [] }
  for (let i = 0; i < 1000; i++) { ink.pts.push(100 + i * 1.5, 200 + Math.sin(i / 10) * 20); ink.t.push(i * 4); ink.f.push(0.3); ink.az.push(1); ink.al.push(1) }
  const a = packPoints(ink)
  assert.equal(a, packPoints(ink))
  assert.ok(a.length * 0.75 / 1000 < 8, `bytes per point ${a.length * 0.75 / 1000}`)
})

test('points: one packed form only: time never runs backwards, anything not canonical is refused as a whole', () => {
  assert.deepEqual(unpackPoints(packPoints({ pts: [0, 0, 1, 1, 2, 2], t: [5, 3, 9], f: [0, 0, 0] })).t, [5, 5, 9])
  const bad = {
    'not a string': undefined, 'empty': '', 'not base64url': 'not base64!', 'an unknown flag': b64u(Uint8Array.of(4, 0, 0, 0, 0)), 'a point cut off': b64u(Uint8Array.of(0, 2)),
    'tilt bytes missing': b64u(Uint8Array.of(1, 2, 2, 0, 9, 9)), 'a number above 32 bits': b64u(Uint8Array.of(0, 255, 255, 255, 255, 255, 255, 255, 255, 1)), 'no point': b64u(Uint8Array.of(0)),
    'a longer spelling of a number': b64u(Uint8Array.of(0, 0x82, 0x00, 2, 0, 9)), 'five groups above 2^32': b64u(Uint8Array.of(0, 0xff, 0xff, 0xff, 0xff, 0x1f, 2, 0, 9)),
  }
  for (const [what, text] of Object.entries(bad)) assert.equal(unpackPoints(text), null, what)
  assert.ok(unpackPoints(b64u(Uint8Array.of(0, 0xff, 0xff, 0xff, 0xff, 0x0f, 2, 0, 9))), 'the largest number, 2^32 - 1, is read')
  const many = { pts: new Array(2 * (MAX_POINTS + 1)).fill(1), t: [], f: [] }
  assert.equal(unpackPoints(packPoints(many)), null, 'more than 10 000 points'); assert.ok(unpackPoints(packPoints({ ...many, pts: many.pts.slice(2) })))
  // positions are whole numbers of 1/16 unit modulo 2^32
  const far = unpackPoints(packPoints({ pts: [2 ** 27, -(2 ** 27) - 1 / 16], t: [0], f: [0] }))
  assert.deepEqual(far.pts, [-(2 ** 27), 2 ** 27 - 1 / 16])
})

test('fixture: every sample decodes to its listed points and packs back to the same bytes', () => {
  for (const s of fixture.strokes) {
    const got = unpackPoints(s.entry.points)
    assert.equal(got.t.length, s.decoded.length, s.name)
    s.decoded.forEach((p, i) => {
      assert.equal(got.pts[2 * i], p.x); assert.equal(got.pts[2 * i + 1], p.y); assert.equal(got.t[i], p.t); assert.equal(got.f[i], p.force)
      if (p.azimuth != null) { near(got.az[i], p.azimuth, 1e-6, 'az'); near(got.al[i], p.altitude, 1e-6, 'al') } else assert.equal(got.az, null)
    })
    assert.equal(got.sim, s.simulated)
    assert.equal(packPoints(got), s.entry.points, `${s.name} packs back`)
    assert.ok(isToken(s.entry.color), s.name)
  }
  fixture.thickness.samples.forEach(({ force, factor }) => near(thickness(force), factor, 1e-6, 'thickness'))
})

// ---- item bodies (10.5): the model's entries and the wire's shapes ----

const picture = { attachment_id: 'a'.repeat(32), file_key: bytes(32, 1), sha256: bytes(32, 2), total_size: 900, file_name: 'p.png', media_type: 'image/png' }

test('entries: stroke, note and picture survive shape -> entry -> wire -> entry -> shape; the wire carries whole 1/16 units', () => {
  const stroke = { tool: 'marker', color: 'pink', width: 28, pts: [0, 0, 10, 5], t: [0, 16], f: [0.2, 0.4], az: null, al: null, sim: true, z: 3, group: 'g1' }
  const note = { tool: 'sticky', pts: [12.5, -4], text: 'hi', size: 17, color: 'ink', wrap: 240, z: 0, group: null }
  const pic = { tool: 'image', pts: [0, 0, 300, 200.5], attachment: picture, nw: 600, nh: 400, mime: 'image/png', name: 'p.png', z: 0, group: null }
  const payload = encodeBody('board_item', { content_type: 'strokes', strokes: [stroke, note, pic].map(entryOf) })
  const wire = JSON.parse(payload)
  assert.equal(wire.schema_version, 2)
  assert.deepEqual(wire.strokes[0], { tool: 'marker', color: 'pink', width: 448, points: entryOf(stroke).points, z: 3, group: 'g1' })
  assert.deepEqual(wire.strokes[1], { tool: 'sticky', at: [200, -64], text: 'hi', size: 272, color: 'ink', wrap: 3840 })
  assert.deepEqual(wire.strokes[2].rect, [0, 0, 4800, 3208]); assert.equal(wire.strokes[2].attachment.file_id, b64u(new Uint8Array(16).fill(0xaa)))
  assert.deepEqual([wire.strokes[2].attachment.width, wire.strokes[2].attachment.height], [600, 400])
  const back = decodeBody('board_item', payload)
  const [s, n, p] = back.strokes.map((e, i) => shapeOf(e, `x/1/${i}`, 'x'))
  assert.deepEqual({ ...s, id: undefined, by: undefined }, { ...stroke, id: undefined, by: undefined })
  assert.deepEqual([n.pts, n.text, n.size, n.wrap, n.color], [[12.5, -4], 'hi', 17, 240, 'ink'])
  assert.deepEqual([p.pts, p.nw, p.nh, p.mime, p.name, p.attachment.attachment_id], [[0, 0, 300, 200.5], 600, 400, 'image/png', 'p.png', 'a'.repeat(32)])
})

test('bodies: what trommi-core would refuse is not written and not read', () => {
  const points = packPoints({ pts: [0, 0], t: [0], f: [0] })
  for (const entry of [{ tool: 'eraser', points }, { tool: 'hl' }, { tool: 'pen', points: 'AA' }, { tool: 'image', rect: [0, 0, 1, 1] }, { tool: 'pen', points, color: '' }])
    assert.throws(() => encodeBody('board_item', { content_type: 'strokes', strokes: [entry] }), e => e.code === 'bad-format' || e.code === 'bad-argument', JSON.stringify(entry))
  assert.throws(() => encodeBody('board_item', { content_type: 'strokes', strokes: [] }), { code: 'bad-format' })
  assert.throws(() => encodeBody('board_item', { content_type: 'erase', stroke_ids: ['nobody/1/0'] }), { code: 'bad-format' })
  const sender = device(1), id = `${sender}/3/0`, ok = { tool: 'pen', color: 'ink', width: 64, points }
  const read = body => decodeBody('board_item', JSON.stringify(body))
  assert.deepEqual(read({ schema_version: 2, content_type: 'move', shape_ids: [id], offset: [16, -8] }), { content_type: 'move', stroke_ids: [`${hex(sender)}/3/0`], offset: [1, -0.5] })
  assert.deepEqual(read({ content_type: 'erase', shape_ids: [id] }), { content_type: 'erase', stroke_ids: [`${hex(sender)}/3/0`] }, 'no schema_version is version 2')
  assert.equal(read({ schema_version: 3, content_type: 'strokes', strokes: [ok] }), 'newer_schema')
  const refused = {
    'a number with a fraction': { content_type: 'move', shape_ids: [id], offset: [0.5, 0] }, 'an id twice': { content_type: 'erase', shape_ids: [id, id] }, 'no id': { content_type: 'erase', shape_ids: [] },
    'an id with number 0': { content_type: 'erase', shape_ids: [`${sender}/0/0`] }, 'an id with a leading zero': { content_type: 'erase', shape_ids: [`${sender}/03/0`] }, 'a hex sender on the wire': { content_type: 'erase', shape_ids: [`${hex(sender)}/3/0`] },
    'an unknown content type': { content_type: 'selection_sent', text: 'x' }, 'an unknown tool': { content_type: 'strokes', strokes: [{ ...ok, tool: 'brush' }] }, 'a shape that names an id': { content_type: 'strokes', strokes: [{ ...ok, id }] },
    'a field of another tool': { content_type: 'strokes', strokes: [{ ...ok, text: 'x' }] }, 'a field that is null': { content_type: 'strokes', strokes: [{ ...ok, group: null }] }, 'a width of 0': { content_type: 'strokes', strokes: [{ ...ok, width: 0 }] },
    'a width in board units': { content_type: 'strokes', strokes: [{ ...ok, width: 4.5 }] }, 'an offset on an erase': { content_type: 'erase', shape_ids: [id], offset: [1, 1] }, 'an older schema': { schema_version: 1, content_type: 'erase', shape_ids: [id] },
  }
  for (const [what, body] of Object.entries(refused)) assert.equal(read(body), 'bad', what)
})

// ---- the merge (10.7) ----

const A = device(1), B = device(2)
const item = (sender, seq, body) => ({ sender, seq, hash: bytes(32, 0xee, seq), payload: JSON.stringify({ schema_version: 2, ...body }) })
const wireStroke = (x = 0, y = 0) => ({ tool: 'pen', color: 'ink', width: 64, points: packPoints({ pts: [x, y, x + 10, y + 5], t: [0, 8], f: [0.3, 0.4] }) })
const firstPoint = s => unpackPoints(s.points).pts.slice(0, 2)

test('the merge: adding once, moves add up, erase wins for good, each item once', () => {
  let b = reduceBoard(null, [item(A, 1, { content_type: 'strokes', strokes: [wireStroke(100, 200), { tool: 'text', at: [160, 320], text: 'hi', size: 320, color: 'ink' }] })])
  assert.deepEqual(b.shapes.map(s => s.id), [`${A}/1/0`, `${A}/1/1`]); assert.deepEqual(b.frontier, { [A]: [1, bytes(32, 0xee, 1)] })
  b = reduceBoard(b, [item(A, 2, { content_type: 'move', shape_ids: [`${A}/1/0`, `${A}/1/1`], offset: [160, -80] }), item(B, 1, { content_type: 'move', shape_ids: [`${A}/1/0`], offset: [16, 16] })])
  assert.deepEqual(firstPoint(b.shapes[0]), [111, 196]); assert.deepEqual(b.shapes[1].at, [320, 240])
  const once = reduceBoard(b, [item(A, 2, { content_type: 'erase', shape_ids: [`${A}/1/0`] })])
  assert.deepEqual(once.shapes, b.shapes, 'a number the writer\'s frontier covers is skipped')
  b = reduceBoard(b, [item(B, 2, { content_type: 'send_away', shape_ids: [`${A}/1/1`] }), item(A, 3, { content_type: 'move', shape_ids: [`${A}/1/1`], offset: [16, 16] })])
  assert.deepEqual(b.shapes.map(s => s.id), [`${A}/1/0`]); assert.deepEqual(b.gone, [], 'what the frontier covers needs no memory')
  // a body trommi-core would refuse adds nothing and leaves the writer's number
  const bad = reduceBoard(b, [{ sender: B, seq: 3, hash: null, payload: '{"content_type":"strokes","strokes":[{"tool":"brush"}]}' }])
  assert.deepEqual(bad.frontier[B][0], 2); assert.equal(bad.shapes.length, 1)
  // the input is never changed, and an untouched shape is the same object
  const before = JSON.stringify(b)
  const next = reduceBoard(b, [item(B, 3, { content_type: 'strokes', strokes: [wireStroke()] })])
  assert.equal(JSON.stringify(b), before); assert.equal(next.shapes.find(s => s.id === `${A}/1/0`), b.shapes[0])
})

test('the merge commutes between writers: erase and move before the shape arrives, positions modulo 2^32', () => {
  const add = item(A, 2, { content_type: 'strokes', strokes: [wireStroke(1, 1), wireStroke(2, 2), { tool: 'image', rect: [0, 0, 160, 160], attachment: { file_id: id16(0xf1), file_key: bytes(32, 1), sha256: bytes(32, 2), file_name: 'p.png', media_type: 'image/png', total_size: 1 } }] })
  const erase = item(B, 1, { content_type: 'erase', shape_ids: [`${A}/2/0`] })
  const move = item(B, 2, { content_type: 'move', shape_ids: [`${A}/2/0`, `${A}/2/1`, `${A}/2/2`], offset: [2 ** 31 - 1, 32] })
  const again = item(B, 3, { content_type: 'move', shape_ids: [`${A}/2/2`], offset: [16, 0] })
  const early = reduceBoard(null, [erase, move, again])
  assert.deepEqual(early.gone, [`${A}/2/0`]); assert.deepEqual(early.moved, [[`${A}/2/1`, 2 ** 31 - 1, 32], [`${A}/2/2`, -(2 ** 31) + 15, 32]], 'sums wrap; a move on an erased shape is nothing')
  const one = reduceBoard(early, [add]), other = reduceBoard(null, [add, erase, move, again])
  assert.deepEqual(one.shapes, other.shapes); assert.deepEqual(one.shapes.map(s => s.id), [`${A}/2/1`, `${A}/2/2`])
  assert.deepEqual(one.shapes[1].rect, [-(2 ** 31) + 15, 32, -(2 ** 31) + 175, 192]); assert.deepEqual([one.gone, one.moved], [[], []])
  // ids are ordered by the sender's bytes, the number, the index: not by their text
  const mixed = reduceBoard(null, [item(B, 9, { content_type: 'strokes', strokes: [wireStroke()] }), item(A, 10, { content_type: 'strokes', strokes: [wireStroke()] }), item(A, 11, { content_type: 'strokes', strokes: [wireStroke()] })])
  assert.deepEqual(mixed.shapes.map(s => s.id), [`${A}/10/0`, `${A}/11/0`, `${B}/9/0`])
})

test('the snapshot file: { v: 3, shapes, frontier, gone, moved } gzip JSON, checked when it is read', async () => {
  const st = new CanvasState()
  const me = hex(A), her = hex(B)
  const model = (by, seq, content, n) => ({ sender_device_id: by, sender_sequence: seq, envelope_hash: hex(bytes(32, 0xee, seq)), envelope_number: n, item_state: 'loaded', content })
  assert.deepEqual([...st.apply(model(me, 1, { content_type: 'strokes', strokes: [pencil, fixture.strokes[1].entry] }, 10))], [`${me}/1/0`, `${me}/1/1`])
  st.apply(model(her, 4, { content_type: 'move', stroke_ids: [`${me}/1/0`, `${me}/7/0`], offset: [10, -5] }, 11))
  st.apply(model(her, 5, { content_type: 'erase', stroke_ids: [`${me}/8/2`] }, 12))
  assert.equal(st.apply(model(her, 5, { content_type: 'erase', stroke_ids: [`${me}/1/0`] }, 12)), null, 'an item is applied once')
  assert.equal(st.shapes.get(`${me}/1/0`).pts[0], unpackPoints(pencil.points).pts[0] + 10); assert.equal(st.covered(me, 1), true); assert.equal(st.covered(me, 2), false); assert.equal(st.applied, 3); assert.equal(st.last_envelope_number, 12)
  const snap = st.snapshot()
  assert.deepEqual(snap.frontier, { [me]: [1, hex(bytes(32, 0xee, 1))], [her]: [5, hex(bytes(32, 0xee, 5))] }, 'the frontier as the register names it: the model\'s ids')
  const file = await packSnapshot(snap)
  const json = JSON.parse(new TextDecoder().decode(await new Response(new Blob([file]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()))
  assert.deepEqual(Object.keys(json), ['v', 'shapes', 'frontier', 'gone', 'moved']); assert.equal(json.v, 3)
  assert.deepEqual(json.frontier, { [A]: [1, bytes(32, 0xee, 1)], [B]: [5, bytes(32, 0xee, 5)] }); assert.deepEqual(json.gone, [`${A}/8/2`]); assert.deepEqual(json.moved, [[`${A}/7/0`, 160, -80]])
  assert.deepEqual(json.shapes.map(s => s.id), [`${A}/1/0`, `${A}/1/1`])
  const got = await unpackSnapshot(file, snap.frontier)
  const again = new CanvasState(); again.load(got, { shapes: false }); again.addShapes(got.shapes.slice(0, 1)); again.addShapes(got.shapes.slice(1))
  assert.deepEqual([...again.shapes], [...st.shapes]); assert.equal(again.applied, 0)
  // what the snapshot kept for shapes still to come counts when they come
  again.apply(model(me, 7, { content_type: 'strokes', strokes: [pencil] }, 20)); again.apply(model(me, 8, { content_type: 'strokes', strokes: [pencil, pencil, pencil] }, 21))
  assert.equal(again.shapes.get(`${me}/7/0`).pts[0], unpackPoints(pencil.points).pts[0] + 10); assert.equal(again.shapes.has(`${me}/8/2`), false); assert.equal(again.shapes.size, 5)
  // refused files
  const repack = change => { const f = structuredClone(json); change(f); return new Response(new Blob([new TextEncoder().encode(JSON.stringify(f))]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer().then(b => new Uint8Array(b)) }
  await assert.rejects(async () => unpackSnapshot(await repack(f => { f.v = 4 })), { code: 'newer-version' })
  for (const [what, change] of Object.entries({
    'ids out of order': f => f.shapes.reverse(), 'a shape beyond the frontier': f => { f.shapes[1].id = `${A}/2/0` }, 'a gone id the frontier covers': f => { f.gone = [`${A}/1/5`] },
    'a move by nothing': f => { f.moved[0][1] = 0; f.moved[0][2] = 0 }, 'a shape that is not one': f => { f.shapes[0].tool = 'brush' }, 'no frontier': f => { delete f.frontier },
  })) await assert.rejects(async () => unpackSnapshot(await repack(change)), { code: 'bad-format' }, what)
  await assert.rejects(() => unpackSnapshot(file, { ...snap.frontier, [me]: [2, hex(bytes(32, 9))] }), { code: 'bad-format' }, 'a frontier that is not the register\'s')
  // a board that could not read an item writes no snapshot
  st.apply({ sender_device_id: her, sender_sequence: 6, envelope_hash: hex(bytes(32, 0xee, 6)), envelope_number: 30, item_state: 'newer_schema', content: null })
  assert.equal(st.unread, 'newer'); assert.throws(() => st.snapshot(), { code: 'newer-version' })
})

test('a board through the model: items in the model\'s form, a stroke in progress, its finished form in its place', () => {
  const w = new World(); w.groups()
  const board = id16(0xde), key = `scribble:desk/${hex(board)}`, timeline = { kind: 'board', scope: 'desk', ref: board }
  const st = new CanvasState()
  const take = () => { const changed = new Set(); for (const it of w.last.items.get(key) ?? []) for (const id of st.apply(it) ?? []) changed.add(id); return [...changed] }
  const add = w.take({ kind: 'item', sender: w.phone, session: null, timeline, payload: { schema_version: 2, content_type: 'strokes', strokes: [wireStroke(100, 200), { tool: 'sticky', at: [16, 32], text: 'todo', size: 320, color: 'yellow', wrap: 3200 }] } })
  const t = w.model.timelines.get(key)
  const it = t.items.get(add.change)
  assert.deepEqual([t.timeline_kind, t.timeline_id, t.item_count], ['scribble', `desk/${hex(board)}`, 1]); assert.equal(it.content_type, 'strokes'); assert.equal(it.sender_sequence, 1)
  assert.deepEqual(it.content.strokes[1], { tool: 'sticky', at: [1, 2], text: 'todo', size: 20, color: 'yellow', wrap: 200 }, 'the model holds board units')
  const ids = [`${hex(w.phone)}/1/0`, `${hex(w.phone)}/1/1`]
  assert.deepEqual(take(), ids); assert.deepEqual(st.shapes.get(ids[0]).pts.slice(0, 2), [100, 200]); assert.equal(st.shapes.get(ids[0]).width, 4)
  w.take({ kind: 'item', sender: w.me, session: null, timeline, payload: { schema_version: 2, content_type: 'move', shape_ids: [`${w.phone}/1/0`], offset: [-1600, 8] } })
  assert.deepEqual(take(), [ids[0]]); assert.deepEqual(st.shapes.get(ids[0]).pts.slice(0, 2), [0, 200.5])
  w.take({ kind: 'item', sender: w.me, session: null, timeline, payload: { schema_version: 2, content_type: 'erase', shape_ids: [`${w.phone}/1/1`] } })
  assert.deepEqual(take(), [ids[1]]); assert.equal(st.shapes.has(ids[1]), false)

  // the phone draws: pieces, relayed and never stored; then the finished stroke names them
  const stroke = id16(0x99), live = `live:${hex(w.phone)}/${hex(stroke)}`
  const piece = (number, ink) => w.piece(board, encodePiece({ stroke: hex(stroke), number, tool: 'pen', color: 'blue', width: 4, points: packPoints(ink) }))
  assert.equal(piece(1, { pts: [5, 5, 6, 6], t: [0, 8], f: [0.3, 0.3] }), true)
  assert.deepEqual(take(), [live]); assert.deepEqual([st.shapes.get(live).pts, st.shapes.get(live).live, st.shapes.get(live).color], [[5, 5, 6, 6], true, 'blue'])
  assert.equal(piece(2, { pts: [7, 7], t: [16], f: [0.3] }), true)
  assert.deepEqual(take(), [live]); assert.deepEqual(st.shapes.get(live).pts, [5, 5, 6, 6, 7, 7]); assert.equal(t.item_count, 3, 'pieces are not counted')
  assert.equal(t.items.get(live).content_type, 'stroke_piece'); assert.equal(t.items.get(live).envelope_number, null)
  assert.equal(w.piece(board, '{"stroke":"x"}'), false, 'a piece the core would refuse')
  w.take({ kind: 'item', sender: w.phone, session: null, timeline, payload: { schema_version: 2, content_type: 'strokes', strokes: [{ ...wireStroke(5, 5), color: 'blue', live: stroke }] } })
  const done = take()
  assert.deepEqual(done.sort(), [`${hex(w.phone)}/2/0`, live].sort()); assert.equal(st.shapes.has(live), false); assert.equal(t.items.has(live), false); assert.equal(st.shapes.size, 2)
  // an item this device could not read: the board says so and writes no snapshot
  const unread = w.take({ kind: 'item', sender: w.phone, session: null, timeline, outcome: 'chained', code: 'no-key' })
  assert.equal(t.items.get(unread.change).item_state, 'undecryptable')
  st.apply(t.items.get(unread.change)); assert.equal(st.unread, 'no_key')
})

// ---- the line, the boards, the input, the palette ----

test('shape: the clamped B-spline begins and ends at the first and last point; force sets the radius', () => {
  const pts = [0, 0, 10, 0, 20, 10, 30, 10]
  const s = sampleStroke(pts, [0, 0.25, 0.25, 1], { tool: 'pen', width: 4 })
  assert.deepEqual(s.slice(0, 2), [0, 0]); near(s.at(-3), 30, 1e-9, 'end x'); near(s.at(-2), 10, 1e-9, 'end y')
  near(s[2], 2 * 0.3, 1e-9, 'start radius'); near(s.at(-1), 2 * 1.7, 1e-9, 'end radius')
  assert.ok(sampleStroke(pts, null, { tool: 'marker', width: 18 }).every((v, i) => i % 3 !== 2 || Math.abs(v - 9) < 1e-9))
  assert.deepEqual(sampleStroke([5, 6], [0.25], { width: 4 }), [5, 6, 2])
})

test('shape: a stroke being drawn is sampled piece by piece: a piece never changes when points are added, and the pieces are the whole line', () => {
  const pts = [], f = []
  for (let i = 0; i < 60; i++) { pts.push(i * 7, 40 * Math.sin(i / 3) + (i % 2) * 5); f.push(0.1 + 0.3 * Math.abs(Math.cos(i / 5))) }
  const opt = { tool: 'pen', width: 4 }
  const whole = sampleStroke(pts, f, opt)
  const onWhole = (x, y) => { let d = Infinity; for (let i = 0; i + 3 < whole.length; i += 3) { const ax = whole[i], ay = whole[i + 1], dx = whole[i + 3] - ax, dy = whole[i + 4] - ay, l = dx * dx + dy * dy, t = l ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l)) : 0; d = Math.min(d, Math.hypot(x - ax - t * dx, y - ay - t * dy)) } return d }
  const pieces = []
  let done = 0
  for (let n = 2; n <= 60; n++) {
    const now = pts.slice(0, 2 * n), piece = sampleStroke(now, f, { ...opt, from: done, to: n - 2 })
    assert.deepEqual(piece, sampleStroke(pts, f, { ...opt, from: done, to: n - 2 }), `the piece of spans ${done}..${n - 2} is the same with every point after it`)
    pieces.push(piece)
    done = n - 1
  }
  pieces.push(sampleStroke(pts, f, { ...opt, from: done }))
  const all = pieces.flat()
  for (let i = 0; i < all.length; i += 3) assert.ok(onWhole(all[i], all[i + 1]) < 1e-6 + 0.02, `a piece's sample ${i / 3} lies on the whole line`)
  assert.deepEqual(all.slice(0, 3), whole.slice(0, 3)); assert.deepEqual(all.slice(-3), whole.slice(-3))
  for (let k = 1; k < pieces.length; k++) assert.ok(Math.hypot(pieces[k][0] - pieces[k - 1].at(-3), pieces[k][1] - pieces[k - 1].at(-2)) <= 0.5, `piece ${k} joins the one before`)
  assert.deepEqual(sampleStroke(pts, f, { ...opt, from: 0, to: Infinity }), whole)
})

test('boards: a desk\'s id is its board\'s; one board for All desks (spec 10.1), the same on every client', () => {
  assert.equal(deskBoard('0123456789abcdef0123456789abcdef'), 'desk/0123456789abcdef0123456789abcdef')
  assert.equal(ALL_BOARD, 'desk/616c6c2d6465736b7300000000000009'); assert.equal(deskBoard('all-desks'), ALL_BOARD)
  assert.equal(deskBoard('main'), MAIN_BOARD); assert.equal(deskBoard(null), MAIN_BOARD); assert.equal(deskBoard(''), MAIN_BOARD); assert.equal(MAIN_BOARD, 'desk/6d61696e000000000000000000000004')
  assert.notEqual(ALL_BOARD, deskBoard('all'))
  for (const id of [MAIN_BOARD, ALL_BOARD, deskBoard('ä desk with a long name, longer than sixteen bytes')]) assert.match(id, /^desk\/[0-9a-f]{32}$/)
  assert.deepEqual(chunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
})

test('input: tilt to azimuth and altitude, simulated force from speed', () => {
  assert.deepEqual(anglesOfTilt(0, 0), { az: 0, al: Math.PI / 2 })
  const r = anglesOfTilt(45, 0); near(r.az, 0, 1e-9, 'az'); near(r.al, Math.PI / 4, 1e-9, 'al')
  near(anglesOfTilt(0, 45).az, Math.PI / 2, 1e-9, 'az down'); near(anglesOfTilt(-45, 0).az, Math.PI, 1e-9, 'az left')
  let slow = null, fast = null
  for (let i = 0; i < 20; i++) { slow = forceFromSpeed(slow, 0.1); fast = forceFromSpeed(fast, 4) }
  assert.ok(slow > fast && slow <= 0.36 && fast >= 0.07, `${slow} ${fast}`)
})

test('palette: tokens for light and dark, unknown tokens fall back to the tool\'s first colour', () => {
  for (const t of [...PEN_COLORS, ...MARKER_COLORS]) assert.ok(isToken(t), t)
  for (const t of MARKER_COLORS) assert.ok(PALETTE[t].marker, t)
  assert.notEqual(colorOf('ink', 'pen', false), colorOf('ink', 'pen', true))
  assert.equal(colorOf('#ff0000', 'pen', true), colorOf('ink', 'pen', true))
  assert.equal(colorOf('nope', 'marker'), colorOf('yellow', 'marker'))
})
