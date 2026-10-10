// registers.test.mjs: registers in the model (spec/v1.md 9.3): the room's human registers under the keys and in the
// maps the views read, a session's registers from its agent (profile, status lines, the receipt, alerts), each
// device's own name. Which value is the current one is the core's word (`register.current`). Hand-made core results.
//   node --test tests/web/model/
import test from 'node:test'
import assert from 'node:assert/strict'
import { World, device, hex, id16, bytes } from './factory.mjs'

test('human registers: drafts, snoozes, ducks, crown, desks, session settings, under the model\'s keys', () => {
  const w = new World(); w.groups()
  const card = id16(0xc1), desk = id16(0xde), hc = hex(card), hd = hex(desk), hs = hex(w.session)
  w.register(`draft/${card}`, { keys: ['a'], note: 'maybe' })
  assert.deepEqual(w.model.human.drafts.get(hc), { keys: ['a'], note: 'maybe' }); assert.ok(w.last.registers.has(`draft/${hc}`) && w.last.cards.has(hc))
  const raw = w.model.human.raw.get(`draft/${hc}`)
  assert.equal(raw.by_device_id, hex(w.me)); assert.equal(raw.pending, false); assert.equal(raw.envelope_number, 1); assert.equal(raw.causal.lamport, 1)
  w.register(`snooze/${card}`, { until: w.clock + 60_000 }); assert.equal(w.model.human.snoozes.get(hc).until, w.clock + 60_000 - 1000)
  w.register(`duck/${card}`, { at: 1 }); assert.deepEqual(w.model.human.ducks.get(hc), { at: 1 })
  w.register('crown', { session_id: w.session, agent_device_id: w.agent })
  assert.deepEqual(w.model.human.crown, { session_id: hs, agent_device_id: hex(w.agent) }, 'ids inside a value are the model\'s hex')
  w.register(`desk/${desk}`, { name: 'Work', created_at: 1, order: 0, goals: 'ship it', crown: { session_id: w.session } })
  assert.deepEqual(w.model.human.desks.get(hd), { name: 'Work', created_at: 1, order: 0, goals: 'ship it', crown: { session_id: hs } })
  w.register(`session/${w.session}`, { name: 'Builder', desk, archived: false, icon: 'draw:rocket' })
  assert.deepEqual(w.model.human.session_settings.get(hs), { name: 'Builder', desk: hd, archived: false, icon: 'draw:rocket' })
  assert.equal(w.model.sessions.get(hs).settings, w.model.human.session_settings.get(hs)); assert.ok(w.last.sessions.has(hs))
  w.register('kit', { pending: true }); assert.equal(w.model.human.raw.get('kit').value.pending, true, 'a key without a map of its own is kept raw')
  // a desk whose id is no 16 bytes (the app's 'main') keeps its name
  w.register('desk/main', { name: 'Desk' }); assert.ok(w.model.human.desks.has('main'))
  // deleted: gone from the map, a tombstone in raw
  w.register(`draft/${card}`, null)
  assert.equal(w.model.human.drafts.has(hc), false); assert.equal(w.model.human.raw.get(`draft/${hc}`).value, null)
})

test('a value that is not the current one of its name changes nothing', () => {
  const w = new World(); w.groups()
  const card = id16(0xc1)
  w.register(`draft/${card}`, { note: 'newer' }, { lamport: 5 })
  const stale = w.register(`draft/${card}`, { note: 'older, arrived later' }, { sender: w.phone, lamport: 2, current: false })
  assert.equal(stale.result.applied, false); assert.equal(w.model.human.drafts.get(hex(card)).note, 'newer'); assert.equal(w.last.registers.size, 0)
  const unread = w.register(`draft/${card}`, {}, { sender: w.phone, outcome: 'chained', code: 'newer-version' })
  assert.equal(unread.result.applied, false); assert.equal(w.model.human.drafts.get(hex(card)).note, 'newer'); assert.equal(w.model.newer.count, 1)
})

test('the board snapshot register: board_snapshot/<board> is scribble_snapshot/desk/<board> with the model\'s ids', () => {
  const w = new World(); w.groups()
  const board = id16(0xde), file = id16(0xf5), head = bytes(32, 0x99)
  w.register(`board_snapshot/${board}`, { attachment: { file_id: file, file_key: bytes(32, 1), sha256: bytes(32, 2), file_name: 'board.json.gz', media_type: 'application/gzip', total_size: 77 }, frontier: { [w.me]: [12, head] }, change: 480 })
  const key = `scribble_snapshot/desk/${hex(board)}`
  assert.ok(w.last.registers.has(key) && w.last.timelines.has(`scribble:desk/${hex(board)}`))
  const snap = w.model.human.scribble_snapshots.get(`desk/${hex(board)}`)
  assert.equal(snap.attachment.attachment_id, hex(file)); assert.deepEqual(snap.frontier, { [hex(w.me)]: [12, hex(head)] }); assert.equal(snap.last_envelope_number, 480, 'the hub\'s change number the writer had processed')
})

test('a session\'s registers from its agent: profile, status lines in order of appearance, the receipt, alerts', () => {
  const w = new World(); w.groups()
  const hs = hex(w.session), card = id16(0xc1)
  w.register('profile', { model: 'opus', task: 'build the board', icon: 'draw:brush', agent_name: 'Builder' }, { sender: w.agent })
  let s = w.model.sessions.get(hs)
  assert.deepEqual(s.profile, { model: 'opus', task: 'build the board', icon: 'draw:brush', agent_name: 'Builder', is_main: true })
  const a = w.register('status_line/tests', { label: 'Tests', state: 'working', detail: '3 of 9', object_id: card }, { sender: w.agent })
  w.register('status_line/docs', { label: 'Docs', state: 'done', detail: '' }, { sender: w.agent })
  const b = w.register('status_line/tests', { label: 'Tests', state: 'done', detail: '9 of 9' }, { sender: w.agent })
  s = w.model.sessions.get(hs)
  assert.deepEqual(s.status_lines.map(l => [l.id, l.state, l.detail, l.object_id]), [['tests', 'done', '9 of 9', null], ['docs', 'done', '', null]])
  assert.equal(s.status_lines[0].envelope_number, b.change); assert.equal(s.status_lines[0].updated_at, b.time); assert.notEqual(a.change, b.change)
  w.register('status_line/docs', null, { sender: w.agent })
  assert.deepEqual(w.model.sessions.get(hs).status_lines.map(l => l.id), ['tests'])
  w.register('heard', { up_to: 7, at: 123 }, { sender: w.agent }); w.register('heard', { up_to: 5, at: 456 }, { sender: w.agent })
  s = w.model.sessions.get(hs)
  assert.equal(s.heard_up_to, 7, 'the mark only rises'); assert.equal(s.heard_at, 123)
  const hash = bytes(32, 0x44)
  w.register(`alert/${hash}`, { code: 'answer-stale', message: 'the card had changed', sender_device_id: w.me, envelope_number: 3 }, { sender: w.agent })
  s = w.model.sessions.get(hs)
  assert.deepEqual(s.agent_alerts.map(x => [x.key, x.value.code, x.value.sender_device_id]), [[`alert/${hex(hash)}`, 'answer-stale', hex(w.me)]])
  const alert = w.model.alerts.at(-1)
  assert.equal(alert.code, 'answer-stale'); assert.equal(alert.source, 'agent'); assert.equal(alert.sender_device_id, hex(w.agent)); assert.ok(w.last.alerts)
  assert.ok(s.registers.has('profile') && s.registers.has('heard') && s.registers.has('status_line/tests'), 'every current register of the session, raw')
  // the human devices' register in a session group (the Desk's goals for the agent) is kept raw
  w.register('goals', { desk_id: id16(0xde), desk_name: 'Work', goals: 'ship it' }, { sender: w.me, session: w.session })
  assert.deepEqual(w.model.sessions.get(hs).registers.get('goals').value, { desk_id: hex(id16(0xde)), desk_name: 'Work', goals: 'ship it' })
})

test('device names: each device writes its own register, shown on its member and on its session', () => {
  const w = new World(); w.groups()
  w.register(`device/${w.me}`, { device_name: 'Laptop', platform: 'web' })
  w.register(`device/${w.agent}`, { device_name: 'devbox', platform: 'linux', folder: '/home/c/app', host: 'devbox' }, { sender: w.agent })
  const me = w.model.members.get(hex(w.me)), agent = w.model.members.get(hex(w.agent))
  assert.equal(me.device_name, 'Laptop'); assert.equal(me.platform, 'web'); assert.equal(agent.folder, '/home/c/app'); assert.equal(agent.host, 'devbox')
  assert.equal(w.model.sessions.get(hex(w.session)).device_name, 'devbox'); assert.ok(w.last.members && w.last.registers.has(`device/${hex(w.agent)}`))
  // a name that arrived before the member was known is there once the groups say who is in the room
  const late = device(12)
  w.register(`device/${late}`, { device_name: 'second box' }, { sender: late })
  w.groups([{ group: bytes(32, 0xbb, 2), session: { session_id: id16(0x52), parent: null }, epoch: 1, leaves: [w.me, w.phone, late] }], { agents: [w.agent, late] })
  assert.equal(w.model.members.get(hex(late)).device_name, 'second box'); assert.equal(w.model.sessions.get(hex(id16(0x52))).device_name, 'second box')
  // the chains' heads are the core's own
  const heads = w.register('heads', { [w.me]: [3, bytes(32, 5)] })
  assert.equal(heads.result.applied, false); assert.equal(w.model.human.raw.has('heads'), false)
})
