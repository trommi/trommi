// sessions.test.mjs: which sessions the sidebar shows (app.mjs BoardState.agents, replaceInSlots) and what Delete
// takes along (agents.mjs deletionOf), on a model built by hand.
//   node --test tests/web/views/
//
// The case: an agent's connector, paired again in its folder, is a new agent device with a new main session; the
// older session of that folder must not stay as a second entry. Deleting one entry touches that session only, and
// a session whose agent is connected again shows, whatever hid it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyModel } from '../../../app/web/core/model-shape.ts'
import { sessionOf } from '../../../app/web/core/model.ts'
import { BoardState } from '../../../app/web/public/app.mjs'
import { deletionOf, register } from '../../../app/web/public/agents.mjs'

const D0 = 'd0'.repeat(16), D1 = 'd1'.repeat(16), D2 = 'd2'.repeat(16)
const S0 = '50'.repeat(16), S1 = '51'.repeat(16), S2 = '52'.repeat(16), H0 = '60'.repeat(16)
const idOf = s => s.slice(0, 12)

function member(m, device_id, { epoch, online = false, folder = '~/git/trommi-hub', host = 'desktop' } = {}) {
  m.members.set(device_id, { device_id, device_role: 'agent', fingerprint: '', device_name: 'trommi-hub', platform: 'claude-code', folder, host,
    is_active: true, added_entry_number: epoch, removed_entry_number: null, is_me: false, is_online: online, offline_since: online ? null : 1, link: null })
}
function session(m, session_id, device_id, { online = false, parent = null, open = 0, settings = null } = {}) {
  const s = sessionOf(m, session_id)
  Object.assign(s, { group_id: `g${session_id}`, agent_device_id: device_id, agent_device_ids: [device_id], is_online: online, offline_since: online ? null : 1,
    parent_session_id: parent, creator_device_id: parent ? device_id : null, profile: { is_main: !parent, ...(parent ? { parent_session: parent } : {}) }, open_card_ids: Array.from({ length: open }, (_, i) => `c${i}`) })
  if (settings) m.human.session_settings.set(session_id, settings)
  return s
}
/** The owner's room: the first pairing (gone), the second one of the same folder (connected). */
function pairedTwice({ open = 0, settings = null } = {}) {
  const m = emptyModel()
  m.room.my_device_id = 'ee'.repeat(16)
  member(m, D0, { epoch: 3 }); member(m, D1, { epoch: 5, online: true })
  session(m, S0, D0, { open, settings })
  session(m, S1, D1, { online: true })
  return m
}
const agentsOf = m => new BoardState({ model: m }).update().agents
const shown = m => agentsOf(m).filter(a => !a.archived).map(a => a.id)

test('a connector paired again in its folder shows as one entry: the connected session, the old one replaced', () => {
  const agents = agentsOf(pairedTwice())
  assert.deepEqual(agents.filter(a => !a.archived).map(a => a.id), [idOf(S1)])
  const old = agents.find(a => a.id === idOf(S0))
  assert.equal(old.replaced, true, 'the old one is in the archive as replaced')
})

test('with neither connected, the newest pairing of the folder is the one entry', () => {
  const m = pairedTwice()
  m.sessions.get(S1).is_online = false
  assert.deepEqual(shown(m), [idOf(S1)])
})

test('the old session stays while it holds an open question, or when he fetched it back', () => {
  assert.deepEqual(shown(pairedTwice({ open: 1 })).sort(), [idOf(S0), idOf(S1)].sort())
  assert.deepEqual(shown(pairedTwice({ settings: { archived: false } })).sort(), [idOf(S0), idOf(S1)].sort())
})

test('two folders, or two machines, are two entries', () => {
  const m = pairedTwice()
  m.members.get(D0).host = 'laptop'
  assert.deepEqual(shown(m).sort(), [idOf(S0), idOf(S1)].sort())
})

test('the old session\'s helpers go to the archive with it', () => {
  const m = pairedTwice()
  session(m, H0, D0, { parent: S0 })
  assert.deepEqual(shown(m), [idOf(S1)])
})

test('a main session that is archived but connected again shows', () => {
  const m = pairedTwice()
  m.human.session_settings.set(S1, { archived: true })
  assert.ok(shown(m).includes(idOf(S1)), 'the connected session is in the sidebar')
  m.sessions.get(S1).is_online = false
  assert.ok(!shown(m).includes(idOf(S1)), 'once it is away, the archive holds it again')
})

test('Delete of the old entry takes neither the connected session put under it nor a device another desk still uses', () => {
  const m = pairedTwice()
  m.members.get(D0).host = 'laptop'   // (two entries: no replacement in the way)
  m.human.session_settings.set(S1, { parent: idOf(S0) })   // he put the new one under the old one
  session(m, H0, D0, { parent: S0 })   // a helper of the old one
  const everyone = agentsOf(m)
  const a = everyone.find(x => x.id === idOf(S0))
  const { all, devices } = deletionOf({ everyone }, a)
  assert.deepEqual(all.map(x => x.id).sort(), [idOf(S0), idOf(H0)].sort(), 'it and its own helper, not the other agent\'s session')
  assert.deepEqual(devices, [D0])

  // the old agent device also carries a session on another desk: it stays in the room
  member(m, D2, { epoch: 6 })
  session(m, S2, D0, { open: 1, settings: { desk: 'other' } })
  const again = agentsOf(m)
  assert.deepEqual(deletionOf({ everyone: again }, again.find(x => x.id === idOf(S0))).devices, [])
})

// (regression: the route threw "ids is not defined" before c879cad5, and Delete did nothing but say so)
test('the Delete route shreds the session\'s open questions, archives it with its helper and removes its device', async () => {
  const m = pairedTwice()
  m.members.get(D0).host = 'laptop'
  session(m, H0, D0, { parent: S0 })
  const everyone = agentsOf(m), a = everyone.find(x => x.id === idOf(S0))
  const model = { everyone, byAgent: new Map(everyone.map(x => [x.id, x])), state: { cards: [
    { id: 'c1', agent: idOf(S0), status: 'open', kind: 'decision' },
    { id: 'c2', agent: idOf(S1), status: 'open', kind: 'decision' },
    { id: 'c3', agent: idOf(S0), status: 'open', kind: 'permission' },
  ] } }
  const did = [], routes = []
  const hub = {
    shred: async id => { did.push(`shred ${id}`) },
    editSession: async f => { did.push(`archive ${f.agent}`) },
    client: { model: { members: m.members, room: m.room }, removeDevices: async d => { did.push(`remove ${d.join(',')}`) } },
  }
  const stream = (kind, target) => `<${kind} ${target}>`
  const t = new Proxy({ BASE: '', hub, model: () => model, post: (re, fn) => routes.push([re, fn]), wantsStream: () => true, stream, toast: x => `<toast ${x.head}${x.role ? ` ${x.role}` : ''}>`, sendStream: (req, res, body) => { res.body = String(body) } }, { get: (o, k) => (k in o ? o[k] : () => {}) })
  register(t)
  const path = `/sessions/${encodeURIComponent(a.id)}/delete`
  const [re, fn] = routes.find(([r]) => r.test(path))
  const res = {}
  await fn({ req: {}, res, match: re.exec(path), form: new URLSearchParams() })
  assert.doesNotMatch(res.body, /Not deleted/, res.body)
  assert.match(res.body, /toast Deleted/)
  assert.deepEqual(did, ['shred c1', `archive ${idOf(S0)}`, `archive ${idOf(H0)}`, `remove ${D0}`])
})
