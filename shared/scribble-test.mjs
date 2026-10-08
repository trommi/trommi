// The Scribble Board's stroke format and reducer (shared/ink.mjs, shared/scribble.mjs, shared/palette.ts) against
// the fixture the iOS app and dev/interop use (dev/interop/fixtures/strokes.json). node shared/scribble-test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { packPoints, unpackPoints, bake, sampleStroke, anglesOfTilt, forceFromSpeed, thickness, Q } from './ink.ts'
import { CanvasState, entryOf, shapeOf } from './scribble.ts'
import { PALETTE, PEN_COLORS, MARKER_COLORS, colorOf, isToken } from './palette.ts'
import { b64u } from './crypto/zcrypto.mjs'

let passed = 0, failed = 0
async function test(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`) } catch (e) { failed++; console.log(`FAIL ${name}\n${e.stack}`) }
}
const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`)
const fixture = JSON.parse(fs.readFileSync(new URL('../dev/interop/fixtures/strokes.json', import.meta.url), 'utf8'))

await test('points: round trip of x, y, t, force, azimuth, altitude within the quanta', () => {
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

await test('points: deterministic and compact (a 240 Hz pencil point is about 7 bytes with tilt)', () => {
  const ink = { pts: [], t: [], f: [], az: [], al: [] }
  for (let i = 0; i < 1000; i++) { ink.pts.push(100 + i * 1.5, 200 + Math.sin(i / 10) * 20); ink.t.push(i * 4); ink.f.push(0.3); ink.az.push(1); ink.al.push(1) }
  const a = packPoints(ink)
  assert.equal(a, packPoints(ink))
  assert.ok(a.length * 0.75 / 1000 < 8, `bytes per point ${a.length * 0.75 / 1000}`)
})

await test('points: time never runs backwards, malformed input is refused as a whole', () => {
  assert.deepEqual(unpackPoints(packPoints({ pts: [0, 0, 1, 1, 2, 2], t: [5, 3, 9], f: [0, 0, 0] })).t, [5, 5, 9])
  for (const bad of [undefined, '', 'not base64!', b64u(Uint8Array.of(4, 0, 0, 0, 0)), b64u(Uint8Array.of(0, 2)), b64u(Uint8Array.of(1, 2, 2, 0, 9, 9)), b64u(Uint8Array.of(0, 255, 255, 255, 255, 255, 255, 255, 255, 1))]) assert.equal(unpackPoints(bad), null, String(bad))
})

await test('fixture: every sample decodes to its listed points and packs back to the same bytes', () => {
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
  assert.deepEqual(fixture.item.body.strokes, fixture.strokes.map(s => s.entry))
  fixture.thickness.samples.forEach(({ force, factor }) => near(thickness(force), factor, 1e-6, 'thickness'))
})

await test('transform: baked into the points, the width scaled, the azimuth turned', () => {
  const e = fixture.strokes.find(s => s.name === 'pen-transformed').entry
  const s = shapeOf(e, 'a/1/0', 'a')
  assert.deepEqual(s.pts, [100, 50, 140, 50, 180, 70])
  assert.equal(s.width, 4)
  const turned = bake({ pts: [1, 0], az: [0], al: [1] }, [0, 1, -1, 0, 0, 0])
  near(turned.ink.pts[0], 0, 1e-9, 'x'); near(turned.ink.pts[1], 1, 1e-9, 'y'); near(turned.ink.az[0], Math.PI / 2, 1e-9, 'az'); assert.equal(turned.scale, 1)
})

await test('entries: stroke, note and picture survive entryOf -> shapeOf; unknown tools and the eraser are not shapes', () => {
  const stroke = { tool: 'marker', color: 'pink', width: 28, pts: [0, 0, 10, 5], t: [0, 16], f: [0.2, 0.4], az: null, al: null, sim: true, z: 3, group: 'g1' }
  const back = shapeOf(entryOf(stroke), 'x/1/0', 'x')
  assert.deepEqual({ ...back, id: undefined, by: undefined }, { ...stroke, id: undefined, by: undefined })
  const note = { tool: 'sticky', pts: [12.5, -4], text: 'hi', size: 17, color: 'ink', wrap: 240, z: 0, group: null }
  const n = shapeOf(entryOf(note), 'x/1/1', 'x')
  assert.deepEqual([n.pts, n.text, n.size, n.wrap], [[12.5, -4], 'hi', 17, 240])
  assert.deepEqual(entryOf(note).at, [12.5, -4])
  const pic = { tool: 'image', pts: [0, 0, 300, 200], attachment: { attachment_id: 'a'.repeat(32) }, nw: 600, nh: 400, mime: 'image/png', name: 'p.png' }
  assert.deepEqual(shapeOf(entryOf(pic), 'x/1/2', 'x').pts, [0, 0, 300, 200])
  for (const bad of [{ tool: 'eraser', points: packPoints({ pts: [0, 0], t: [0], f: [0] }) }, { tool: 'hl' }, { tool: 'pen', points: 'AA' }, { tool: 'text', at: [1] }, { tool: 'image', rect: [0, 0, 1, 1] }]) assert.equal(shapeOf(bad, 'i', 'b'), null, JSON.stringify(bad))
})

await test('reducer: pieces continue a stroke, moves add up, erase wins, agents touch only their own', () => {
  const st = new CanvasState()
  const pencil = fixture.strokes.find(s => s.name === 'pen-pencil').entry
  const item = (by, seq, content, role = 'human') => ({ sender_device_id: by, sender_sequence: seq, envelope_hash: `h${seq}`, envelope_number: seq, content, sender_role: role })
  assert.deepEqual([...st.apply(item('H', 1, { content_type: 'strokes', strokes: [pencil, fixture.strokes[1].entry] }))], ['H/1/0', 'H/1/1'])
  const n0 = st.shapes.get('H/1/0').t.length
  st.apply(item('H', 2, { content_type: 'strokes', strokes: [{ ...fixture.piece.entry, continues: 'H/1/0' }] }))
  const head = st.shapes.get('H/1/0')
  assert.equal(head.t.length, n0 + 2); assert.equal(head.az.length, n0 + 2); assert.equal(head.t.at(-1), 52)
  assert.equal(st.apply(item('A', 1, { content_type: 'strokes', strokes: [{ ...fixture.piece.entry, continues: 'H/1/0' }] }, 'agent')).size, 0, 'nobody continues another sender\'s stroke')
  const x0 = head.pts[0]
  st.apply(item('H', 3, { content_type: 'move', stroke_ids: ['H/1/0'], offset: [10, -5] }))
  st.apply(item('H', 4, { content_type: 'move', stroke_ids: ['H/1/0'], offset: [1, 1] }))
  assert.equal(st.shapes.get('H/1/0').pts[0], x0 + 11)
  assert.equal(st.apply(item('A', 2, { content_type: 'erase', stroke_ids: ['H/1/1'] }, 'agent')).size, 0)
  st.apply(item('H', 5, { content_type: 'send_away', stroke_ids: ['H/1/1'] }))
  assert.equal(st.shapes.has('H/1/1'), false)
  // erase before add (another order): the shape never appears
  st.apply(item('G', 1, { content_type: 'erase', stroke_ids: ['G/2/0'] }))
  st.apply(item('G', 2, { content_type: 'strokes', strokes: [pencil] }))
  assert.equal(st.shapes.has('G/2/0'), false)
  assert.equal(st.apply(item('H', 5, { content_type: 'erase', stroke_ids: ['H/1/0'] })), null, 'an item is applied once')
  // snapshot round trip
  const snap = JSON.parse(JSON.stringify(st.snapshot()))
  assert.equal(snap.v, 2)
  const again = new CanvasState(); again.load(snap)
  const a = again.shapes.get('H/1/0'), b = st.shapes.get('H/1/0')
  assert.equal(a.t.length, b.t.length); a.pts.forEach((v, i) => near(v, b.pts[i], 0.5 / Q, 'snapshot point'))
})

await test('shape: the clamped B-spline begins and ends at the first and last point; force sets the radius', () => {
  const pts = [0, 0, 10, 0, 20, 10, 30, 10]
  const s = sampleStroke(pts, [0, 0.25, 0.25, 1], { tool: 'pen', width: 4 })
  assert.deepEqual(s.slice(0, 2), [0, 0]); near(s.at(-3), 30, 1e-9, 'end x'); near(s.at(-2), 10, 1e-9, 'end y')
  near(s[2], 2 * 0.3, 1e-9, 'start radius'); near(s.at(-1), 2 * 1.7, 1e-9, 'end radius')
  assert.ok(sampleStroke(pts, null, { tool: 'marker', width: 18 }).every((v, i) => i % 3 !== 2 || Math.abs(v - 9) < 1e-9))
  assert.deepEqual(sampleStroke([5, 6], [0.25], { width: 4 }), [5, 6, 2])
})

await test('input: tilt to azimuth and altitude, simulated force from speed', () => {
  assert.deepEqual(anglesOfTilt(0, 0), { az: 0, al: Math.PI / 2 })
  const r = anglesOfTilt(45, 0); near(r.az, 0, 1e-9, 'az'); near(r.al, Math.PI / 4, 1e-9, 'al')
  near(anglesOfTilt(0, 45).az, Math.PI / 2, 1e-9, 'az down'); near(anglesOfTilt(-45, 0).az, Math.PI, 1e-9, 'az left')
  let slow = null, fast = null
  for (let i = 0; i < 20; i++) { slow = forceFromSpeed(slow, 0.1); fast = forceFromSpeed(fast, 4) }
  assert.ok(slow > fast && slow <= 0.36 && fast >= 0.07, `${slow} ${fast}`)
})

await test('palette: tokens for light and dark, unknown tokens fall back to the tool\'s first colour', () => {
  for (const t of [...PEN_COLORS, ...MARKER_COLORS]) assert.ok(isToken(t), t)
  for (const t of MARKER_COLORS) assert.ok(PALETTE[t].marker, t)
  assert.notEqual(colorOf('ink', 'pen', false), colorOf('ink', 'pen', true))
  assert.equal(colorOf('#ff0000', 'pen', true), colorOf('ink', 'pen', true))
  assert.equal(colorOf('nope', 'marker'), colorOf('yellow', 'marker'))
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
