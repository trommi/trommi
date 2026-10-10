// order.test.mjs: the sessions' order in the sidebar (app.mjs orderWrites, BoardState.agents): a session dragged to
// a new place writes the places it and the others take into their registers session/<id> { position }; the order
// every device reads back follows them; a session never placed keeps its default place; a target that is gone moves
// nothing.
//   node --test tests/web/views/
import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyModel } from '../../../app/web/core/model-shape.ts'
import { sessionOf } from '../../../app/web/core/model.ts'
import { BoardState, orderWrites } from '../../../app/web/public/app.mjs'

const A = { id: 'a', position: 0, placed: false }, B = { id: 'b', position: 1, placed: false }, C = { id: 'c', position: 2, placed: false }
const ids = writes => Object.fromEntries(writes)

test('a move to the top: the moved one and every main without a place of its own get one', () => {
  assert.deepEqual(ids(orderWrites([A, B, C], 'c', { before: 'a' })), { c: 0, a: 1, b: 2 })
})

test('placed sessions: only those whose place changes are written', () => {
  const list = [{ ...A, placed: true }, { ...B, placed: true }, { ...C, placed: true }, { id: 'd', position: 3, placed: true }]
  assert.deepEqual(ids(orderWrites(list, 'b', { after: 'c' })), { c: 1, b: 2 })
  assert.deepEqual(ids(orderWrites(list, 'a', { after: 'd' })), { b: 0, c: 1, d: 2, a: 3 })
})

test('helpers and archived sessions are not given a place they do not need', () => {
  const sub = { id: 's', position: 3, placed: false, parent: 'a' }, gone = { id: 'g', position: 4, placed: false, archived: true }
  assert.deepEqual(ids(orderWrites([A, B, C, sub, gone], 'b', { before: 'a' })), { b: 0, a: 1, c: 2 })
})

test('nothing moves: the same place, itself as target, or a target that is gone', () => {
  assert.deepEqual(orderWrites([A, B, C], 'b', { after: 'a' }), [])
  assert.deepEqual(orderWrites([A, B, C], 'b', { before: 'b' }), [])
  assert.deepEqual(orderWrites([A, B, C], 'b', { before: 'zz' }), [])
  assert.deepEqual(orderWrites([A, B, C], 'zz', { before: 'a' }), [])
})

// The whole way round: the places written are read back by BoardState, a new session keeps its default place (last).
const S = n => `5${n}`.repeat(16), D = n => `d${n}`.repeat(16)
function room(settings = {}) {
  const m = emptyModel()
  m.room.my_device_id = 'ee'.repeat(16)
  for (const n of [1, 2, 3]) {
    const s = sessionOf(m, S(n))
    Object.assign(s, { group_id: `g${n}`, agent_device_id: D(n), agent_device_ids: [D(n)], is_online: true, profile: { is_main: true, agent_name: `agent-${n}` } })
    if (settings[n]) m.human.session_settings.set(S(n), settings[n])
  }
  return m
}
const names = m => new BoardState({ model: m }).update().agents.map(a => a.name)

test('the order read back: places written win, a session never placed keeps its default place', () => {
  const m = room()
  assert.deepEqual(names(m), ['agent-1', 'agent-2', 'agent-3'])
  const agents = new BoardState({ model: m }).update().agents
  const writes = orderWrites(agents, agents[1].id, { before: agents[0].id })
  for (const [id, position] of writes) { const a = agents.find(x => x.id === id); m.human.session_settings.set(a.device_id, { ...(m.human.session_settings.get(a.device_id) ?? {}), position }) }
  assert.deepEqual(names(m), ['agent-2', 'agent-1', 'agent-3'])
  // a session that arrives later stands where it stood by default: after the ones he placed
  const s = sessionOf(m, S(4))
  Object.assign(s, { group_id: 'g4', agent_device_id: D(4), agent_device_ids: [D(4)], is_online: true, profile: { is_main: true, agent_name: 'agent-4' } })
  assert.deepEqual(names(m), ['agent-2', 'agent-1', 'agent-3', 'agent-4'])
})
