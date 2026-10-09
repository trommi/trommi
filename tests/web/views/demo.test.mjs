// demo.test.mjs: the demo room (`?mock=1`, app/web/public/demo/demo.mjs) hands the views a model it builds itself,
// without the core. This test takes that model from the real module (demo-room.mjs) and holds it against the
// model's types (app/web/core/types.ts, read as text: sources.mjs interfacesOf): every record has every field its
// interface requires and none the interface does not name, for the repository's skeleton room, for the rich room
// (test data outside the repository; skipped, and said so, where it is not there) and for every variant the demo
// builds from it. It also draws the rich room's Scribble Boards through the board's own merge: every shape of
// every item is on the board, the pictures too.
//   node --test tests/web/views/
// Not checked: the types of the values (a field that is there with a value of the wrong kind), and what a body
// (a card version's content, a message's content) holds.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { CORE, interfacesOf } from './sources.mjs'
import { RICH, SKELETON, demo, readFixture } from './demo-room.mjs'
import { CanvasState } from '../../../app/web/core/scribble.ts'
import { emptyModel } from '../../../app/web/core/model-shape.ts'
import { mirrorOf, snapshotOf } from '../../../app/web/core/mirror.ts'

const TYPES = interfacesOf(path.join(CORE, 'types.ts'))
const richSkip = fs.existsSync(RICH) ? false : `the rich demo room is not at ${RICH}: only the skeleton was checked`
const VARIANTS = ['1', 'quiet', 'fresh', 'first', 'many', 'foot', 'reads', 'side', 'link']

/** What the demo keeps on a record beside the interface's fields, where the interface is open for the app's own. */
const OWN = {
  Note: ['created_at', 'updated_at', 'attachments', 'held', 'removed'],
  Invite: ['session_id', 'takeover'],
  AttachmentRef: ['url'],
}
/** Every way a record misses its interface: [problem]. */
function against(type, record, where) {
  const t = TYPES.get(type), out = []
  assert.ok(t, `types.ts has no interface ${type}`)
  for (const k of t.required) if (!(k in record) || record[k] === undefined) out.push(`${where}: ${type}.${k} is missing`)
  if (!t.open) for (const k of Object.keys(record)) if (!t.fields.includes(k) && !OWN[type]?.includes(k)) out.push(`${where}: ${k} is no field of ${type}`)
  return out
}
function problems(model) {
  const out = [], all = (map, type, more = () => {}) => { for (const [key, r] of map) { out.push(...against(type, r, `${type} ${String(key).slice(0, 12)}`)); more(r, key) } }
  out.push(...against('Model', model, 'the model'), ...against('Room', model.room, 'room'), ...against('HumanRegisters', model.human, 'human'), ...against('Newer', model.newer ?? {}, 'newer'))
  for (const k of Object.keys(emptyModel())) if (k !== '_builder' && model[k]?.constructor !== emptyModel()[k]?.constructor) out.push(`model.${k} is not what the model's ${k} is`)
  all(model.members, 'Member', (m, key) => { if (m.device_id !== key) out.push(`member ${key}: filed under another id`) })
  all(model.sessions, 'Session', (s, key) => {
    if (s.session_id !== key) out.push(`session ${key}: filed under another id than its session_id`)
    if (!(s.registers instanceof Map)) out.push(`session ${key}: registers is no Map`)
    for (const line of s.status_lines) out.push(...against('StatusLine', { envelope_number: 0, ...line }, `a status line of ${key.slice(0, 12)}`))
    if (s.link) out.push(...against('Link', s.link, `the link of ${key.slice(0, 12)}`))
  })
  all(model.cards, 'Card', (c, key) => {
    if (!model.sessions.has(c.session_id)) out.push(`card ${key}: its session_id names no session`)
    for (const v of c.versions) out.push(...against('CardVersion', v, `a version of card ${key.slice(0, 12)}`))
    for (const a of c.answers) out.push(...against('Answer', a, `an answer of card ${key.slice(0, 12)}`))
    for (const a of c.attachments) out.push(...against('AttachmentRef', a, `an attachment of card ${key.slice(0, 12)}`))
  })
  all(model.permissions, 'PermissionRequest')
  all(model.notes, 'Note')
  all(model.published, 'Published', (p, key) => { for (const a of p.attachments) out.push(...against('AttachmentRef', a, `an attachment of artifact ${key.slice(0, 12)}`)) })
  all(model.timelines, 'Timeline', (t, key) => { for (const i of t.items.values()) out.push(...against('TimelineItem', i, `an item of ${key.slice(0, 30)}`)) })
  all(model.invites, 'Invite')
  return [...new Set(out)]
}
const roomOf = (file, kind = '1') => new demo.MockClient(demo.variantOf(readFixture(file), kind), { simulate: false })
/** Every stored item of the room in its timelines' windows, as the views get them page by page. */
async function withEverything(client) {
  for (const key of client.store.keys()) for (let more = true; more;) more = (await client.loadTimeline(key, { limit: 500 })).has_more
  return client
}

test('the skeleton room is the model, field for field', async () => {
  const client = await withEverything(roomOf(SKELETON))
  assert.deepEqual(problems(client.model), [])
})

test('the rich room and every variant the demo builds from it are the model, field for field', { skip: richSkip }, async () => {
  for (const kind of VARIANTS) {
    const client = await withEverything(roomOf(RICH, kind))
    assert.deepEqual(problems(client.model), [], `?mock=${kind}`)
    if (kind === '1') { assert.ok(client.model.sessions.size > 3 && client.model.cards.size > 5 && client.model.published.size > 0 && client.model.notes.size > 0, 'the rich room has sessions, cards, artifacts and a note'); assert.ok([...client.model.timelines.values()].some(t => t.items.size > 3)) }
  }
})

test('what the demo\'s own actions make is the model too', { skip: richSkip }, async () => {
  const client = roomOf(RICH), m = client.model
  const session = [...m.sessions.keys()][0], open = m.stack[0]
  await client.sendMessage({ session_id: session, text: 'by its session id' })
  await client.sendMessage({ agent_device_id: session, text: 'by its agent' })
  assert.equal(m.timelines.get(`chat:session/${session}`).items.size, 2, 'a message reaches the session by either name')
  const note = await client.saveNote({ text: 'a note' })
  await client.saveNote({ object_id: note, text: 'a note, again' })
  assert.equal(m.notes.get(note).version_hashes.length, 2)
  await client.deleteNote(note)
  assert.equal(m.notes.get(note).object_state, 'closed')
  await client.answer({ object_id: open, choices: [m.cards.get(open).options[0]?.key].filter(Boolean) })
  await client.removeDevices([[...m.members.values()].find(d => d.device_role === 'agent').device_id])
  assert.ok(!('last_entry_number' in m.room), 'the room carries no count of member changes')
  assert.deepEqual(problems(m), [])
})

test('the rich room\'s Scribble Boards: the merge takes every shape of every item, the pictures with them', { skip: richSkip }, () => {
  const client = roomOf(RICH)
  let boards = 0, pictures = 0
  for (const [key, items] of client.store) {
    if (!key.startsWith('scribble:')) continue
    assert.match(key, /^scribble:desk\/[0-9a-f]{32}$/)
    const st = new CanvasState()
    let shapes = 0
    for (const it of [...items].sort((a, b) => a.envelope_number - b.envelope_number)) {   // as whiteboard.mjs take() hands them over
      const strokes = it.content.content_type === 'strokes' ? it.content.strokes : []
      assert.equal(st.apply(it)?.size, strokes.length, `${key} #${it.envelope_number}: every shape of the item is on the board`)
      shapes += strokes.length
    }
    assert.equal(st.shapes.size, shapes)
    assert.equal(st.unread, null)
    for (const s of st.shapes.values()) if (s.tool === 'image') { pictures++; assert.ok(s.attachment.url, 'a picture keeps the address its bytes come from') }
    boards++
  }
  assert.ok(boards >= 3 && pictures > 0, 'the rich room has a board per desk and one for All desks, with pictures')
})

test('the demo\'s model travels to a page as any model does', { skip: richSkip }, () => {
  const m = roomOf(RICH).model
  const mirror = mirrorOf(structuredClone(snapshotOf(m)))
  assert.deepEqual([...mirror.cards.keys()], [...m.cards.keys()])
  assert.deepEqual(mirror.newer, m.newer)
  assert.deepEqual([...mirror.sessions.values()].map(s => s.session_id), [...m.sessions.keys()])
})
