// The one-time Scribble Board migration (scribble-first-format.js) against a local hub (hub/server.mjs, throwaway
// data): old boards in the first stroke format on two desk timelines and the old "All" one, some of them kept under
// the old cache key, onto the room board. Run by hand: node dev/migrate/test.mjs   (not part of npm test or CI)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { startHub, LIMITS } from '../../hub/server.mjs'
import { foundRoom, memoryStorage } from '../../shared/index.ts'
import { CanvasState, MAIN_BOARD as ROOM_BOARD } from '../../shared/scribble.ts'
await import('./scribble-first-format.js')
const { core, lib } = globalThis.trommiMigrateScribble
assert.equal(globalThis.trommiMigrateScribble.ROOM_BOARD, ROOM_BOARD)
assert.equal(lib.deskCanvas('main'), ROOM_BOARD)

LIMITS.foundPerIpHour = 10_000; LIMITS.openRequestsPerIpMinute = 100_000; LIMITS.envelopesPerSecond = 100_000; LIMITS.envelopeBurst = 100_000
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trommi-migrate-test-'))
const hub = await startHub({ port: 0, host: '127.0.0.1', dataDir: dir, log: () => {}, pingMs: 2000 })
let failed = 0
try {
  const storage = memoryStorage({ extractable_keys: false })
  const { client } = await foundRoom({ hub_url: hub.hubUrl, storage, device_name: 'Phone' })
  await client.start()
  const me = client.model.room.my_device_id

  // entries made by the old encoder (shared/scribble.mjs at 0e50a99; shared/scribble-test history)
  const PEN = { points: 'AAAAUAAAAFABQAGQAUD_YA', pressure: 'TYCZ', style: { tool: 'pen', color: '#e03131', size: 4 }, z: 1 }          // 10,10 50,60 90,40
  const PLAIN = { points: 'AAAGQAAABkAApABR', style: { tool: 'pen', color: 'ink', size: 7 }, z: 2 }                                   // 200,200 220.5,210.125
  const HL = { points: '__9jwAAACWAAUAAo', style: { tool: 'hl', color: '#ffd43b', size: 18 }, z: 3 }                                  // -5000,300 -4990,305
  const TEXT = { points: 'AAADIAAAA8A', style: { tool: 'text', color: 'ink', size: 20 }, z: 4, text: 'hallo' }                        // 100,120
  const STICKY = { points: 'AAAJYAAAAUA', style: { tool: 'sticky', color: 'ink', size: 20 }, z: 5, text: 'merken', wrap: 180 }        // 300,40
  const A = 'desk/' + 'a'.repeat(32), ALL = lib.deskCanvas('all')
  const send = async (timeline_id, content) => (await client.sendStrokes({ timeline_id, ...content })).seq
  // desk A: a pen with a piece, a text, a marker that is erased again, a sticky that is moved
  const a1 = await send(A, { strokes: [PEN, PLAIN, TEXT] })
  await send(A, { strokes: [{ continues: `${me}/${a1}/1`, points: 'AAAHgAAABzAAoACg' }] })                                            // 240,230 260,250
  const a2 = await send(A, { strokes: [HL, STICKY] })
  await send(A, { content_type: 'erase', stroke_ids: [`${me}/${a2}/0`] })
  await send(A, { content_type: 'move', stroke_ids: [`${me}/${a2}/1`], offset: [10, 20] })
  // the old All board: one pen
  await send(ALL, { strokes: [PEN] })
  // the room board (it was the 'main' desk's): a first-format text and a current-format stroke
  const cur = { tool: 'pen', color: 'blue', width: 4, points: lib.packPoints({ pts: [1000, 0, 1040, 30], t: [0, 8], f: [0.3, 0.3], sim: true }) }
  await send(ROOM_BOARD, { strokes: [TEXT] })
  await send(ROOM_BOARD, { strokes: [cur] })
  await client.settle(); await client.catchUp(); await client.flush()

  // desk A's records as a browser that verified them before 0e50a99 keeps them: under tl/canvas:
  const kept = await storage.range(`tl/scribble:${A}/`)
  assert.equal(kept.length, 5)
  await storage.setMany(kept.flatMap(([k, v]) => [[k, undefined], [k.replace('tl/scribble:', 'tl/canvas:'), v]]))

  const sent = []
  const env = {
    async timelines() { return [{ timeline_id: A, label: 'desk A' }, { timeline_id: ROOM_BOARD, label: 'desk main' }, { timeline_id: ALL, label: 'old "All" board' }, { timeline_id: 'desk/' + 'b'.repeat(32), label: 'desk empty' }] },
    async items(tid) {
      const byN = new Map()
      for (const [, r] of await storage.range(`tl/canvas:${tid}/`)) if (r?.c) byN.set(r.n, { envelope_number: r.n, sender_device_id: r.s, sender_sequence: r.q, content: r.c })
      for (const it of (await client.loadTimelineAfter(`scribble:${tid}`, 0)).items) if (it.content) byN.set(it.envelope_number, it)
      return [...byN.values()]
    },
    async headersOnly() { return 0 },
    async prepare() {},
    async send(tid, strokes) { sent.push(tid); await client.sendStrokes({ timeline_id: tid, strokes }) },
    settle: () => client.settle(),
    async snapshot(tid) { return { shapes: (await board()).shapes.size, tid } },
  }
  async function board() {
    const st = new CanvasState()
    for (const it of (await client.loadTimelineAfter(`scribble:${ROOM_BOARD}`, 0)).items.sort((x, y) => x.envelope_number - y.envelope_number)) st.apply(it)
    return st
  }

  // ---- the dry run: counts, nothing written ----
  const before = (await client.hub.envelopes({ after_envelope_number: 0, limit: 1000 })).last_envelope_number
  const dry = await core(env, { dryRun: true, log: () => {} })
  console.table(dry)
  assert.equal((await client.hub.envelopes({ after_envelope_number: 0, limit: 1000 })).last_envelope_number, before, 'a dry run sends nothing')
  assert.equal(sent.length, 0)
  const row = name => dry.find(r => r.board === name)
  assert.deepEqual(dry.map(r => r.board), ['room board', 'desk A', 'old "All" board'], 'the room board first; an empty board is left out')
  assert.equal(row('room board').to_write, 1); assert.equal(row('room board').first_format_shapes, 1); assert.equal(row('room board').shapes_left, 2); assert.equal(row('room board').shift_x, 0)
  assert.equal(row('desk A').items, 5); assert.equal(row('desk A').first_format_items, 3); assert.equal(row('desk A').shapes_left, 4); assert.equal(row('desk A').to_write, 4)
  assert.equal(row('desk A').erased, 1); assert.equal(row('desk A').moved, 1); assert.equal(row('desk A').pieces, 1); assert.equal(row('desk A').failures, 0)
  assert.equal(row('old "All" board').to_write, 1)
  // side by side: the room board ends at x 1040, desk A starts 400 right of it, the All board 400 right of desk A
  assert.equal(row('desk A').shift_x, 1040 + 400 - 10)
  assert.equal(row('old "All" board').shift_x, (310 + row('desk A').shift_x) + 400 - 10)

  // ---- the real run ----
  const real = await core(env, { dryRun: false, log: () => {} })
  assert.ok(sent.length >= 3 && sent.every(t => t === ROOM_BOARD), 'everything goes onto the room board')
  const st = await board()
  assert.equal(st.shapes.size, 1 + 1 + 4 + 1, 'the current stroke, the room board\'s text, desk A\'s four, the All board\'s pen')
  const by = g => [...st.shapes.values()].filter(s => s.group?.startsWith('ff:') && g(s))
  const dxA = row('desk A').shift_x
  const pens = by(s => s.tool === 'pen' && s.color === 'red').sort((x, y) => x.pts[0] - y.pts[0])
  assert.deepEqual(pens[0].pts, [10 + dxA, 10, 50 + dxA, 60, 90 + dxA, 40]); assert.equal(pens[0].width, 4)
  assert.ok(Math.abs((0.3 + 1.4 * Math.sqrt(pens[0].f[1])) - (0.35 + 1.3 * 0.5)) < 0.02, 'the pressure draws the old width')
  assert.equal(pens[1].pts[0], 10 + row('old "All" board').shift_x)
  const plain = by(s => s.tool === 'pen' && s.color === 'ink')[0]
  assert.deepEqual(plain.pts, [200 + dxA, 200, 220.5 + dxA, 210.125, 240 + dxA, 230, 260 + dxA, 250], 'the piece went along')
  assert.equal(by(s => s.tool === 'marker').length, 0, 'what was erased stays erased')
  assert.deepEqual(by(s => s.tool === 'sticky')[0].pts, [300 + 10 + dxA, 40 + 20], 'the move is in')
  assert.deepEqual(by(s => s.tool === 'text').map(s => s.pts[0]).sort((x, y) => x - y), [100, 100 + dxA])
  // no old envelope changed: desk A's timeline on the hub is as long as before
  assert.equal((await client.hub.threads({ timeline_kind: 'scribble', timeline_id: A, after_envelope_number: 0, limit: 500 })).envelopes.length, 5)

  // ---- again: nothing more ----
  sent.length = 0
  const again = await core(env, { dryRun: false, log: () => {} })
  assert.equal(sent.length, 0, 'a second run writes nothing')
  assert.equal(again.reduce((n, r) => n + r.already_migrated, 0), 6)
  assert.equal((await board()).shapes.size, 7)
  console.log(`ok   migration: ${real.reduce((n, r) => n + r.to_write, 0)} shapes onto the room board, side by side; dry run and second run write nothing`)
  await client.stop?.()
} catch (e) { failed++; console.log(`FAIL ${e.stack}`) }
await hub.close?.()
fs.rmSync(dir, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
