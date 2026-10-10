// demo-fixture.test.mjs: the mock room (app/web/public/demo/demo.mjs, `?mock=1`) builds its own model from
// demo/data/fixture.json and hands it to the views; it calls nothing of model.ts. This test takes the rich fixture
// of the old repository where the export has put it, lets demo.mjs's own client build the model from it, and
// checks it against the records the builder makes (model.ts): no field the builder's records do not have, none of
// theirs missing, items the views' trail fold and the board's merge take. (tests/web/views/demo.test.mjs holds the
// same model against types.ts, for the skeleton room and every variant too.)
// Without the fixture the test is skipped, and says so.
//   node --test tests/web/model/
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { applyPatch, mirrorOf, patchOf, snapshotOf } from '../../../app/web/core/mirror.ts'
import { emptyChange, emptyModel, sessionOf, timelineOf } from '../../../app/web/core/model.ts'
import { CanvasState } from '../../../app/web/core/scribble.ts'
import { foldWork, isWork } from '../../../app/web/core/work.ts'
import { World, canon, hex, id16 } from './factory.mjs'
import { demo, RICH as FIXTURE } from '../views/demo-room.mjs'

const present = Boolean(FIXTURE) && fs.existsSync(FIXTURE)
const skip = present ? false : 'TROMMI_DEMO_FIXTURE names no rich demo room: nothing was checked'

/** The model as demo.mjs's own client makes it from a fixture (the real module: ../views/demo-room.mjs), with every
 *  stored item in its timeline's window. */
function demoModel(f) {
  const client = new demo.MockClient(f, { simulate: false })
  for (const [key, items] of client.store) { const t = client.timeline(key); for (const i of items) t.items.set(i.envelope_number, i) }
  return client.model
}
/** One record of each kind as the builder makes it: the fields types.ts names. */
function builderShapes() {
  const w = new World(); w.groups()
  const id = id16(0xc1), nid = id16(0xb1), art = id16(0xc7), nh = w.hash()
  w.card(id, { title: 'Q', options: [{ key: 'a', label: 'A' }], object_version: 1 })
  w.answer(id, { answer_action: 'answer', choices: ['a'] })
  w.message({ text: 'x' })
  w.take({ kind: 'version', sender: w.me, session: null, hash: nh, object: w.object(nid, 'note'), payload: { text: 'n', lamport: 1 }, object_after: { object_id: nid, owner: w.me, object_state: 'open', current_version: nh } })
  w.take({ kind: 'version', object: w.object(art, 'artifact'), payload: { title: 'A', attachments: [], object_version: 1 } })
  w.take({ kind: 'request', object: w.object(id16(0xa1), 'request'), payload: { tool_name: 'Bash' }, bind: { kind: 'request', request_id: id16(0xa1), expires_at: 5 } })
  const m = w.model, first = map => [...map.values()][0]
  return { room: m.room, member: first(m.members), session: first(m.sessions), card: first(m.cards), version: first(m.cards).versions[0], answer: first(m.cards).answer, note: first(m.notes), published: first(m.published),
    permission: first(m.permissions), timeline: timelineOf(m, `chat:session/${hex(w.session)}`), item: first(timelineOf(m, `chat:session/${hex(w.session)}`).items), model: emptyModel(), session_of: sessionOf }
}
const keysOf = list => [...new Set(list.flatMap(x => Object.keys(x)))].sort()
const beyond = (records, shape) => keysOf(records).filter(k => !(k in shape))
const lacking = (records, shape) => Object.keys(shape).filter(k => records.length && !records.every(r => k in r)).sort()

test('the mock room\'s model: it has every field the builder\'s records have, and no other', { skip }, () => {
  const f = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  const m = demoModel(f), b = builderShapes()
  const all = map => [...map.values()]
  const items = all(m.timelines).flatMap(t => all(t.items))
  // No field beyond the builder's (demo.mjs leaves out what the fixture still writes of protocol v1's model).
  assert.deepEqual(beyond([m.room], b.room), [], 'room')
  assert.deepEqual(beyond(all(m.members), b.member), [], 'members')
  assert.deepEqual(beyond(all(m.sessions), b.session), [], 'sessions')
  assert.deepEqual(beyond(all(m.cards), b.card), [], 'cards')
  assert.deepEqual(beyond(all(m.cards).flatMap(c => c.versions), b.version), [], 'card versions')
  assert.deepEqual(beyond(all(m.cards).flatMap(c => c.answers), b.answer), [], 'answers')
  assert.deepEqual(beyond(all(m.published), b.published), [], 'published')
  assert.deepEqual(beyond(all(m.permissions), b.permission), [], 'permission requests')
  assert.deepEqual(beyond(items, b.item), [], 'timeline items')
  assert.deepEqual(beyond(all(m.timelines), b.timeline), [], 'timelines')
  assert.deepEqual(beyond(all(m.notes), { ...b.note, created_at: 0, updated_at: 0, attachments: [], held: null }), [], 'notes (with the app\'s own fields)')
  assert.deepEqual(Object.keys(m).filter(k => !(k in b.model)), [], 'the model')
  // And none of the builder's missing: demo.mjs gives what the fixture does not write the value of a room where
  // nothing of that kind happened.
  assert.deepEqual(lacking([m.room], b.room), [], 'room')
  assert.deepEqual(lacking(all(m.members), b.member), [], 'members')
  assert.deepEqual(lacking(all(m.sessions), b.session), [], 'sessions')
  assert.deepEqual(lacking(all(m.cards), b.card), [], 'cards')
  assert.deepEqual(lacking(all(m.published), b.published), [], 'published')
  assert.deepEqual(lacking(all(m.notes), b.note), [], 'notes')
  assert.deepEqual(lacking(items, b.item), [], 'timeline items')
  assert.deepEqual(lacking(all(m.timelines), b.timeline), [], 'timelines')
  assert.deepEqual(Object.keys(b.model).filter(k => !(k in m) && k !== '_builder'), [], 'the model')
  // ids as the model has them
  for (const c of all(m.cards)) { assert.match(c.object_id, /^[0-9a-f]{32}$/); assert.match(c.agent_device_id, /^[0-9a-f]{64}$/); assert.equal(c.timeline_key, `chat:card/${c.object_id}`) }
  const refs = []; JSON.stringify(f, (k, v) => { if (v && typeof v === 'object' && 'attachment_id' in v) refs.push(v); return v })
  assert.ok(refs.length > 0); for (const a of refs) assert.match(a.attachment_id, /^[0-9a-f]{32}$/)
})

test('the mock room\'s conversations and boards: the trail folds, the board\'s merge takes every item', { skip }, () => {
  const f = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  const m = demoModel(f)
  const steps = [...m.timelines.values()].flatMap(t => [...t.items.values()]).filter(i => isWork(i.content))
  assert.ok(steps.length > 0, 'the fixture shows a turn\'s trail')
  const turns = Map.groupBy(steps, i => i.content.work.turn)
  for (const [turn, list] of turns) { const block = foldWork(list.map(i => i.content.work)); assert.equal(block.turn, turn); assert.ok(block.items.length > 0) }
  // A picture's reference in the fixture has an empty file_key and sha256 (its bytes come from `url`). A board item
  // is merged in the wire's form, where a picture names a file by a key and a hash of 32 bytes each: demo.mjs gives
  // every such reference one when it loads the fixture, so the items the room stores are the ones the merge takes.
  const client = new demo.MockClient(f, { simulate: false })
  let boards = 0, pictures = 0
  for (const [key, items] of [...client.store].filter(([k]) => k.startsWith('scribble:'))) {
    assert.match(key, /^scribble:desk\/[0-9a-f]{32}$/)
    const st = new CanvasState()
    let entries = 0
    for (const it of [...items].sort((a, b) => a.envelope_number - b.envelope_number)) {       // as whiteboard.mjs take() hands them over
      const strokes = it.content.content_type === 'strokes' ? it.content.strokes : []
      const changed = st.apply(it)
      assert.ok(changed, `${key} #${it.envelope_number} was skipped`)
      entries += strokes.length
      assert.equal(changed.size, strokes.length, `${key} #${it.envelope_number}: every shape of the item is on the board`)
    }
    assert.equal(st.shapes.size, entries); boards++
    for (const s of st.shapes.values()) if (s.tool === 'image') { pictures++; assert.ok('url' in s.attachment, 'a picture keeps the reference the mock room gave it') }
  }
  assert.ok(pictures > 0, 'the fixture has pictures on a board')
  assert.ok(boards > 0)
})

test('the mock room\'s model travels to the page as any model does', { skip }, () => {
  const m = demoModel(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')))
  const mirror = mirrorOf(structuredClone(snapshotOf(m)))
  assert.equal(canon(mirror), canon({ ...emptyModel(), ...m }))
  const c = emptyChange()
  const card = [...m.cards.values()][0]; card.title += ' (edited)'; c.cards.add(card.object_id)
  applyPatch(mirror, structuredClone(patchOf(m, c)))
  assert.equal(mirror.cards.get(card.object_id).title, card.title)
})
