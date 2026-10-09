// groups.test.mjs: members and sessions from the device's groups (core-api.ts GroupSummary, RoomRoles): human and
// agent devices, a helper session under its main session, a stale and an archived session, a takeover, a removed
// device; presence and the link; what a Commit tells a human. Hand-made core results (factory.mjs).
//   node --test tests/web/model/
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyPresence, linkState, parentSessionOf, recipientOf } from '../../../app/web/core/model.ts'
import { World, device, hex, id16, bytes } from './factory.mjs'

const helperGroup = (w, { helper = device(20), leaves, ...rest } = {}) => ({ group: bytes(48, 0xcc), session: { session_id: id16(0x61), parent: w.session }, epoch: 1,
  leaves: leaves ?? [w.me, w.phone, w.agent, helper], disallowed: [], archived: false, pending: false, ...rest })

test('members: human and agent devices, this device, fingerprints; the room group\'s epoch', () => {
  const w = new World(); w.groups()
  const me = w.model.members.get(hex(w.me)), phone = w.model.members.get(hex(w.phone)), agent = w.model.members.get(hex(w.agent))
  assert.equal(w.model.members.size, 3)
  assert.deepEqual([me.device_role, me.is_me, me.is_active], ['human', true, true]); assert.deepEqual([phone.device_role, phone.is_me], ['human', false]); assert.equal(agent.device_role, 'agent')
  assert.equal(me.fingerprint, `${hex(w.me).slice(0, 4)} ${hex(w.me).slice(4, 8)} ${hex(w.me).slice(8, 12)} ${hex(w.me).slice(12, 16)}`)
  assert.equal(me.added_entry_number, 3); assert.equal(me.removed_entry_number, null)
  assert.equal(w.model.room.key_epoch, 3); assert.ok(w.last.members && w.last.room && w.last.stack)
})

test('sessions: a main session is its group; a helper session hangs under its main session', () => {
  const w = new World(); w.groups()
  const hs = hex(w.session)
  let s = w.model.sessions.get(hs)
  assert.equal(s.group_id, hex(w.session_group)); assert.equal(s.agent_device_id, hex(w.agent)); assert.deepEqual(s.agent_device_ids, [hex(w.agent)]); assert.equal(s.agent_session_id, hex(w.agent).slice(0, 16))
  assert.equal(s.is_active, true); assert.equal(s.stale, false); assert.equal(s.parent_session_id, null); assert.equal(s.session_key_epoch, 2); assert.equal(s.timeline_key, `chat:session/${hs}`)
  assert.deepEqual(s.profile, { is_main: true }); assert.equal(recipientOf(w.model, hs), hex(w.agent))

  const helper = device(20)
  w.groups([helperGroup(w, { helper })])
  const h = w.model.sessions.get(hex(id16(0x61)))
  assert.equal(h.parent_session_id, hs); assert.equal(h.profile.parent_session, hs, 'what the views read'); assert.equal(h.profile.is_main, false); assert.equal(h.created_by_agent, false)
  assert.equal(h.creator_device_id, hex(w.agent)); assert.equal(h.agent_device_id, hex(helper)); assert.deepEqual(h.agent_device_ids, [hex(w.agent), hex(helper)])
  assert.equal(h.group_id.length, 96, 'a group id of 48 bytes'); assert.equal(parentSessionOf(w.model, h), hs)
  assert.equal(recipientOf(w.model, h.session_id), hex(w.agent), 'a human addresses a helper session\'s opener')
  assert.equal(w.model.members.get(hex(helper)).device_role, 'agent', 'a helper device is shown as an agent')
  // its own profile register keeps the group's facts
  w.register('profile', { agent_name: 'Tests', parent_session: 'something else', is_main: true }, { sender: helper, session: id16(0x61), group: bytes(48, 0xcc) })
  assert.deepEqual(w.model.sessions.get(hex(id16(0x61))).profile, { agent_name: 'Tests', parent_session: hs, is_main: false })
  // a helper session the opener writes in itself
  w.groups([helperGroup(w, { leaves: [w.me, w.phone, w.agent] })])
  assert.equal(w.model.sessions.get(hex(id16(0x61))).agent_device_id, hex(w.agent))
})

test('stale, archived, gone: what the app shows of a session that takes nothing any more', () => {
  const w = new World(); w.groups()
  const helper = device(20), hh = hex(id16(0x61))
  w.groups([helperGroup(w, { helper, disallowed: [helper] })])
  assert.equal(w.model.sessions.get(hh).stale, true); assert.equal(w.model.sessions.get(hh).is_active, true)
  w.groups([helperGroup(w, { helper, archived: true })])
  assert.equal(w.model.sessions.get(hh).group_archived, true); assert.equal(w.model.sessions.get(hh).is_active, false)
  w.groups()        // the group is gone from this device
  assert.equal(w.model.sessions.get(hh).is_active, false); assert.equal(w.model.sessions.get(hh).agent_device_id, hex(helper), 'it keeps showing who spoke there')
  assert.equal(w.model.members.get(hex(helper)).is_active, false)
})

test('a takeover: a new agent device in the session; the removed one stays as a removed member', () => {
  const w = new World(); w.groups()
  const second = device(11), hs = hex(w.session)
  w.groups([], { agents: [second], epoch: 4 })
  const s = w.model.sessions.get(hs)
  assert.equal(s.agent_device_id, hex(second)); assert.deepEqual(s.agent_device_ids, [hex(second)]); assert.equal(s.is_active, true)
  const old = w.model.members.get(hex(w.agent)), now = w.model.members.get(hex(second))
  assert.deepEqual([old.is_active, old.removed_entry_number], [false, 4]); assert.deepEqual([now.is_active, now.added_entry_number, now.device_role], [true, 4, 'agent'])
  assert.equal(w.model.room.key_epoch, 4)
  // an empty seat (the agent device was removed and nobody took over): the session is not active, the name stays
  w.groups([], { agents: [], epoch: 5 })
  assert.equal(w.model.sessions.get(hs).is_active, false); assert.equal(w.model.sessions.get(hs).agent_device_id, hex(second))
})

test('a Commit: a removed human device at once; a device added with the recovery code and an own removal are told', () => {
  const w = new World(); w.groups()
  w.commit({ epoch: 3, removes: [w.phone] })
  assert.deepEqual([w.model.members.get(hex(w.phone)).is_active, w.model.members.get(hex(w.phone)).removed_entry_number], [false, 4]); assert.ok(w.last.members)
  assert.equal(w.model.alerts.length, 0)
  const stranger = device(30)
  w.commit({ epoch: 4, committer: stranger, adds: [stranger], external: true }, { by_recovery: true })
  assert.equal(w.model.alerts.at(-1).code, 'recovery-add'); assert.equal(w.model.alerts.at(-1).sender_device_id, hex(stranger)); assert.equal(w.model.alerts.at(-1).at, w.clock); assert.ok(w.last.alerts)
  w.commit({ epoch: 5, committer: stranger, removes: [w.me] }, { removed_me: true })
  assert.equal(w.model.alerts.at(-1).code, 'removed')
  // in a session group: the device leaves the session's list, the epoch moves
  w.commit({ group: w.session_group, epoch: 2, removes: [w.agent] })
  assert.deepEqual(w.model.sessions.get(hex(w.session)).agent_device_ids, []); assert.equal(w.model.sessions.get(hex(w.session)).session_key_epoch, 3)
})

test('presence and the link: online, on call, asleep, cut, gone; a helper session without a report shows its opener\'s', () => {
  const w = new World(); w.groups([helperGroup(w)])
  const hs = hex(w.session), ha = hex(w.agent)
  const report = (fields, now = w.clock) => w.run(c => applyPresence(w.model, [{ device_id: ha, ...fields }], c, now))
  report({ is_online: true, link: { hears: 'live', attached: true, working: true, last_call_at: w.clock, since: w.clock - 5 } })
  let s = w.model.sessions.get(hs)
  assert.equal(s.is_online, true); assert.equal(s.link.working, true); assert.equal(linkState(s, w.clock).state, 'live'); assert.ok(w.last.sessions.has(hs) && w.last.members)
  assert.equal(w.model.sessions.get(hex(id16(0x61))).is_online, true, 'the helper session has no stream of its own yet')
  report({ is_online: true, link: { hears: 'oncall', attached: true, working: false, last_call_at: w.clock - 60_000 } })
  assert.deepEqual([linkState(w.model.sessions.get(hs), w.clock).state, linkState(w.model.sessions.get(hs), w.clock).idle_ms], ['oncall', 60_000])
  assert.equal(linkState(w.model.sessions.get(hs), w.clock + 20 * 60_000).state, 'asleep')
  report({ is_online: true, link: { hears: 'live', attached: false, since: 5 } })
  assert.deepEqual([linkState(w.model.sessions.get(hs)).state, linkState(w.model.sessions.get(hs)).reason], ['cut', 'detached'])
  report({ is_online: false, offline_since: w.clock - 1, link: { hears: 'live', exit: { reason: 'sigterm', claude: 'alive' } } })
  s = w.model.sessions.get(hs)
  assert.equal(s.offline_since, w.clock - 1); assert.deepEqual(linkState(s), { state: 'cut', since: w.clock - 1, idle_ms: null, reason: 'sigterm' })
  report({ is_online: false, offline_since: w.clock })
  assert.equal(linkState(w.model.members.get(ha)).state, 'gone'); assert.equal(w.model.sessions.get(hs).link, null)
  // a report of a device the model does not know is nothing
  w.run(c => applyPresence(w.model, [{ device_id: hex(device(99)), is_online: true }], c))
  assert.equal(w.last.members, false)
})
