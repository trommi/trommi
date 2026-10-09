// demo-fixture.test.mjs: the mock room (app/web/public/demo/demo.mjs, `?mock=1`) builds its own model from
// demo/data/fixture.json and hands it to the views; it calls nothing of model.ts. This test takes the rich fixture
// of the old repository where the export has put it, builds the model the way demo.mjs's constructor does, and
// checks it against the shapes the builder makes (types.ts): no field the views would not know, the known list of
// fields the fixture lacks, items the views' trail fold and the board's merge still take.
// Without the fixture the test is skipped, and says so.
//   node --test tests/web/model/
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { applyPatch, mirrorOf, patchOf, snapshotOf } from '../../../app/web/core/mirror.ts'
import { emptyChange, emptyModel, sessionOf, timelineOf } from '../../../app/web/core/model.ts'
import { CanvasState } from '../../../app/web/core/scribble.ts'
import { b64u } from '../../../app/web/core/ids.ts'
import { foldWork, isWork } from '../../../app/web/core/work.ts'
import { World, canon, hex, id16 } from './factory.mjs'

const FIXTURE = '/home/christopher/.cache/trommi-work/v2/web-tmp/fixtures/demo/fixture.json'
const present = fs.existsSync(FIXTURE)
const skip = present ? false : `the demo fixture is not at ${FIXTURE} (another helper exports it there): nothing was checked`

/** The model as demo.mjs's MockClient constructor makes it from a fixture (kept in step with it by hand). */
function demoModel(f) {
  const toMap = obj => new Map(Object.entries(obj ?? {}))
  const sessions = new Map(f.sessions.map(s => [s.agent_device_id, { ...s, agent_alerts: [], registers: new Map(), card_ids: [], open_card_ids: [], timeline_key: `chat:session/${s.agent_device_id}`, last_activity_at: 0 }]))
  const model = {
    room: { ...f.room }, members: new Map(f.members.map(m => [m.device_id, { ...m }])), sessions, cards: new Map(f.cards.map(c => [c.object_id, c])),
    permissions: new Map((f.permissions ?? []).map(p => [p.object_id, p])), notes: new Map((f.notes ?? []).map(m => [m.object_id, m])), published: new Map((f.published ?? []).map(p => [p.object_id, p])), timelines: new Map(),
    human: { drafts: toMap(f.human.drafts), snoozes: toMap(f.human.snoozes), ducks: toMap(f.human.ducks), crown: f.human.crown ?? null, desks: toMap(f.human.desks), session_settings: toMap(f.human.session_settings), scribble_snapshots: new Map(), raw: new Map() },
    invites: new Map(), alerts: [], outbox: [], stack: [], open_permission_ids: [],
  }
  for (const m of model.members.values()) m.fingerprint ??= m.device_id.slice(0, 16).match(/.{4}/g).join(' ')
  for (const [key, items] of Object.entries(f.timelines ?? {})) {
    const id = key.slice(key.indexOf(':') + 1)
    model.timelines.set(key, { timeline_key: key, timeline_kind: key.slice(0, key.indexOf(':')), timeline_id: id, object_id: id.split('/')[1], item_count: items.length, newest_envelope_number: items.at(-1)?.envelope_number ?? 0, items: new Map(items.map(i => [i.envelope_number, i])), loaded_down_to: Infinity, has_more: items.length > 0 })
  }
  return model
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

test('the mock room\'s model: the fixture names no field the model does not have, and lacks only what is listed here', { skip }, () => {
  const f = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  const m = demoModel(f), b = builderShapes()
  const all = map => [...map.values()]
  const items = all(m.timelines).flatMap(t => all(t.items))
  // Fields of the fixture that are not the model's any more: demo.mjs may keep writing them, no view reads them.
  assert.deepEqual(beyond([m.room], b.room), ['last_entry_number'], 'room')
  assert.deepEqual(beyond(all(m.members), b.member), ['agent_session_id'], 'members')
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
  // Fields the model has and the mock room does not fill. The views read every one of them with a fallback (or not
  // at all); this is the list demo.mjs would add to be the model to the letter.
  assert.deepEqual(lacking([m.room], b.room), ['outbox_blocked'], 'room')
  assert.deepEqual(lacking(all(m.members), b.member), ['folder', 'host', 'link', 'offline_since', 'platform'], 'members')
  assert.deepEqual(lacking(all(m.sessions), b.session), ['agent_device_ids', 'created_by_agent', 'creator_device_id', 'group_archived', 'group_id', 'heard_at', 'heard_up_to', 'link', 'offline_since', 'parent_session_id', 'session_id', 'session_key_epoch', 'stale'], 'sessions')
  assert.deepEqual(lacking(all(m.cards), b.card), ['session_id', 'state_envelope_number', 'unsupported'], 'cards')
  assert.deepEqual(lacking(all(m.published), b.published), ['artifact_type', 'content_state', 'session_id'], 'published')
  assert.deepEqual(lacking(all(m.notes), b.note), ['causal', 'pending', 'unsupported', 'version_hashes'], 'notes')
  assert.deepEqual(lacking(items, b.item), ['sender_sequence'], 'timeline items (the board\'s items carry it, messages do not)')
  assert.deepEqual(lacking(all(m.timelines), b.timeline), ['window_open'], 'timelines')
  assert.deepEqual(Object.keys(b.model).filter(k => !(k in m)), ['newer'], 'the model')
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
  // A picture's reference in the mock room has an empty file_key and sha256 (its bytes come from `url`). A board
  // item is merged in the wire's form, where a picture names a file by a key and a hash of 32 bytes each: as the
  // fixture stands, an item that holds a picture is not taken, with every shape in it. demo.mjs has to give such a
  // reference a key and a hash of that form (any 32 bytes: nothing is decrypted in the mock room): `keyed` below.
  const NO_KEY = b64u(new Uint8Array(32))
  const keyed = it => (it.content.content_type !== 'strokes' ? it : { ...it, content: { ...it.content, strokes: it.content.strokes.map(e => (e.attachment ? { ...e, attachment: { ...e.attachment, file_key: e.attachment.file_key || NO_KEY, sha256: e.attachment.sha256 || NO_KEY } } : e)) } })
  let boards = 0, pictures = 0, refusedAsItIs = 0
  for (const [key, items] of Object.entries(f.timelines).filter(([k]) => k.startsWith('scribble:'))) {
    assert.match(key, /^scribble:desk\/[0-9a-f]{32}$/)
    const st = new CanvasState(), asItIs = new CanvasState()
    let entries = 0
    for (const it of [...items].sort((a, b) => a.envelope_number - b.envelope_number)) {       // as whiteboard.mjs take() hands them over
      const strokes = it.content.content_type === 'strokes' ? it.content.strokes : []
      const withPicture = strokes.some(e => e.attachment && !(e.attachment.file_key && e.attachment.sha256))
      if (asItIs.apply(it)?.size !== strokes.length) { refusedAsItIs++; assert.ok(withPicture, `${key} #${it.envelope_number} is not taken, and not for a picture's reference`) }
      const changed = st.apply(keyed(it))
      assert.ok(changed, `${key} #${it.envelope_number} was skipped`)
      entries += strokes.length
      assert.equal(changed.size, strokes.length, `${key} #${it.envelope_number}: every shape of the item is on the board`)
    }
    assert.equal(st.shapes.size, entries); boards++
    for (const s of st.shapes.values()) if (s.tool === 'image') { pictures++; assert.ok('url' in s.attachment, 'a picture keeps the reference the mock room gave it') }
  }
  assert.ok(pictures > 0, 'the fixture has pictures on a board')
  assert.equal(refusedAsItIs > 0, true, 'KNOWN, to fix in demo.mjs: as the fixture stands its board items with a picture are not drawn (see above)')
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
