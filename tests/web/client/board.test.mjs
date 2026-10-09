// The Scribble Board: items, live stroke pieces, a snapshot and a device that loads from it. STAND-IN core (plain
// JSON items; stroke pieces are a stand-in too, see core.ts) and FAKE hub. The merge is scribble.ts's.
import test from 'node:test'
import assert from 'node:assert/strict'
import { addHuman, scene, until } from './helpers.mjs'
import { CanvasState, packPoints, packSnapshot, unpackSnapshot } from '../../../app/web/core/scribble.ts'

const stroke = (x, y) => ({ tool: 'pen', color: 'ink', width: 4, points: packPoints({ pts: [x, y, x + 10, y + 5, x + 20, y] }) })
const board = 'b0'.repeat(16), timeline_id = `desk/${board}`, key = `scribble:${timeline_id}`
/** The board a device shows: its timeline's items through the same reducer the app uses. */
async function canvas(client, from = null) {
  const st = from ?? new CanvasState()
  const { items } = await client.loadTimelineAfter(key, st.last_envelope_number)
  for (const it of items) st.apply(it)
  return st
}
const picture = st => [...st.shapes].map(([id, s]) => [id, s.tool, s.pts?.slice(0, 2)]).sort()

test('strokes, a move, an erase and live pieces between two devices; a third loads from a snapshot and the tail', async t => {
  const { R, a, b } = await scene(t, { second: true })
  const drawing = a.sendStrokes({ timeline_id, content_type: 'strokes', strokes: [stroke(0, 0), stroke(100, 100)] })
  assert.equal([...a.model.timelines.get(key).items.values()].at(-1).pending, true)
  const first = await drawing
  await a.settle(); await b.settle()
  const [one, two] = [`${a.my_device_id}/${first.seq}/0`, `${a.my_device_id}/${first.seq}/1`]
  assert.deepEqual([...(await canvas(b)).shapes.keys()].sort(), [one, two].sort())
  await b.sendStrokes({ timeline_id, content_type: 'move', stroke_ids: [one], offset: [5, 7] })
  await b.sendStrokes({ timeline_id, content_type: 'erase', stroke_ids: [two] })
  await b.sendStrokes({ timeline_id, content_type: 'strokes', strokes: [stroke(300, 0)] })
  await b.settle(); await a.settle()
  const onA = await canvas(a), onB = await canvas(b)
  assert.deepEqual(picture(onA), picture(onB))
  assert.equal(onA.shapes.size, 2)
  assert.deepEqual(onA.shapes.get(one).pts.slice(0, 2), [5, 7])

  // a stroke still being drawn reaches the other device as pieces: shown, never stored
  const live = 'cd'.repeat(16)
  const seen = []
  b.on('change', ch => { for (const it of ch.items.get(key) ?? []) if (it.content_type === 'stroke_piece') seen.push(it.content.number) })
  await a.sendStrokePiece({ timeline_id, stroke: live, number: 1, tool: 'pen', color: 'ink', width: 4, points: packPoints({ pts: [0, 0, 4, 4] }) })
  await a.sendStrokePiece({ timeline_id, stroke: live, number: 2, tool: 'pen', color: 'ink', width: 4, points: packPoints({ pts: [8, 8] }) })
  await until(() => seen.length === 2, 'both pieces on the other device')
  assert.deepEqual(seen, [1, 2])
  assert.ok(b.model.timelines.get(key).items.has(`live:${a.my_device_id}/${live}`))
  // the finished stroke names the live one and takes its place
  await a.sendStrokes({ timeline_id, content_type: 'strokes', strokes: [{ ...stroke(0, 0), live }] })
  await a.settle(); await b.settle()
  assert.equal(b.model.timelines.get(key).items.has(`live:${a.my_device_id}/${live}`), false)

  // a snapshot: the board as a file, and the register that points at it (10.2)
  const st = await canvas(a)
  const snap = st.snapshot()
  const attachment = await a.uploadAttachment(await packSnapshot(snap), { file_name: 'canvas.json.gz', media_type: 'application/gzip' })
  await a.setRegisters({ [`scribble_snapshot/${timeline_id}`]: { attachment, frontier: snap.frontier, last_envelope_number: snap.last_envelope_number } })
  await a.sendStrokes({ timeline_id, content_type: 'strokes', strokes: [stroke(500, 500)] })
  await a.settle(); await b.settle()

  const c = await addHuman(t, R, a, 'c')
  const register = await until(() => c.model.human.scribble_snapshots.get(timeline_id), 'the snapshot register on the third device')
  assert.equal(register.last_envelope_number, snap.last_envelope_number)
  const loaded = new CanvasState()
  // (the file names no change number: where the tail begins is the register's word)
  loaded.load({ ...await unpackSnapshot(await c.fetchAttachment(register.attachment), register.frontier), last_envelope_number: register.last_envelope_number })
  assert.equal(loaded.shapes.size, 3, 'the snapshot holds the board as it was written')
  const tail = (await c.loadTimelineAfter(key, loaded.last_envelope_number)).items
  assert.equal(tail.length, 1, 'only the tail is read')
  for (const it of tail) loaded.apply(it)
  assert.deepEqual(picture(loaded), picture(await canvas(a)))
  assert.equal(loaded.shapes.size, 4)
})
