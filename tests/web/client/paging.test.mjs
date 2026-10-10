// The two lists the hub pages (hub-api.md point 43 and point 22): the room's groups in pages from the answer's
// `after`, and the Welcomes asked again after the last one's id until an answer is empty. STAND-IN core, FAKE hub,
// set to answer one group and one Welcome per page.
import test from 'node:test'
import assert from 'node:assert/strict'
import { addAgent, addHuman, scene } from './helpers.mjs'

test('groups one per page and Welcomes one per answer: a second device still joins every session', async t => {
  const { fake, R, a } = await scene(t, { hubOpts: { groups_page: 1, welcomes_page: 1 } })
  const one = await addAgent(t, a, {}, 'agent1'), two = await addAgent(t, a, {}, 'agent2')
  await a.settle()
  const since = fake.requests.length
  const b = await addHuman(t, R, a, 'b')
  await a.settle(); await b.settle()
  for (const g of [one, two]) assert.ok(b.model.sessions.get(g.session_id)?.group_id, `b is in ${g.session_id}`)
  const asked = fake.requests.slice(since)
  const groupPages = asked.filter(r => /\/groups$/.test(r.path) && r.query?.limit)
  const welcomePages = asked.filter(r => r.path === '/v2/welcomes')
  assert.ok(welcomePages.some(r => r.query?.after), 'the Welcomes were asked again after the last id')
  t.diagnostic(`group pages ${groupPages.length}, Welcome answers ${welcomePages.length}`)
  const rows = await b.hub.roomGroups()
  assert.equal(rows.length, [...[...fake.state.rooms.values()][0].groups.values()].length, 'every group, page by page')
})

test('a hub that answers the bare forms is still read: the whole list at once, Welcomes without ids', async t => {
  const { R, a } = await scene(t, { hubOpts: { bare_lists: true } })
  const one = await addAgent(t, a, {}, 'agent1')
  await a.settle()
  const b = await addHuman(t, R, a, 'b')
  await a.settle(); await b.settle()
  assert.ok(b.model.sessions.get(one.session_id)?.group_id, 'b is in the session')
  assert.ok((await b.hub.roomGroups()).length >= 2)
})
