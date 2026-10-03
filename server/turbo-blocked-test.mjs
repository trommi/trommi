// A session that is really stopped (the raised red hand) apart from a card that knocks (cards Nr. 202/203):
// server/blocked.mjs and where the views show it. Pure: no hub of its own. Run by server/turbo-test.mjs.
import assert from 'node:assert/strict'
import { blockedOf, blockedKey, SILENT_MS, OFFLINE_GRACE_MS } from './blocked.mjs'
import { boardModel } from './views/model.mjs'
import { badge, deskState, sidebarRows } from './views/sidebar.mjs'
import { agentsMain } from './views/agents.mjs'
import { sessionOf, sessionWho } from './views/session.mjs'

export async function blockedTests() {
  const now = Date.now() + 3 * OFFLINE_GRACE_MS   // (later than the module's start, so a session away counts)
  const agent = (id, more = {}) => ({ id, name: id, label: '', icon: 'spiral', online: true, connected: now, active: now, desk: 'main', ...more })
  const card = (id, agentId, more = {}) => ({ id, number: id.length, agent: agentId, kind: 'decision', status: 'open', urgency: 'normal', title: `Card ${id}`, body: '', options: [], created: now, ...more })
  const working = (agentId, updated = now) => ({ agent: agentId, id: 'w', label: 'Build', state: 'working', detail: '', updated })

  // ---- the causes ----
  const base = { cards: [], tasks: [], agents: [] }
  assert.equal(blockedOf(agent('a'), base, now), null)
  // away while working, after the grace; a blip is no stop; away without work is no stop
  assert.equal(blockedOf(agent('a', { online: false, seen: now - 1000 }), { ...base, tasks: [working('a')] }, now), null)
  assert.deepEqual(blockedOf(agent('a', { online: false, seen: now - OFFLINE_GRACE_MS }), { ...base, tasks: [working('a')] }, now), { why: 'offline', text: 'Disconnected while working' })
  assert.equal(blockedOf(agent('a', { online: false, seen: 0 }), base, now), null)
  assert.equal(blockedOf(agent('a', { online: false, seen: 0, archived: true }), { ...base, tasks: [working('a')] }, now), null)
  // an error it reported
  assert.deepEqual(blockedOf(agent('a', { error: 'API overloaded' }), base, now), { why: 'error', text: 'Error: API overloaded' })
  // waiting for him: an approval, or a card it marked as blocking; a merely urgent card knocks and is no stop
  assert.equal(blockedOf(agent('a'), { ...base, cards: [card('p', 'a', { kind: 'permission', urgency: 'critical' })] }, now).text, 'Waiting for permission')
  assert.equal(blockedOf(agent('a'), { ...base, cards: [card('c', 'a', { urgency: 'critical' })] }, now).why, 'blocking')
  assert.equal(blockedOf(agent('a'), { ...base, cards: [card('h', 'a', { urgency: 'high' })] }, now), null)
  assert.equal(blockedOf(agent('a'), { ...base, cards: [card('c', 'a', { urgency: 'critical', with_agent: now })] }, now), null)
  // silent while working: any sign of life (a call, a status line, the link) resets it
  const quiet = now - SILENT_MS - 14 * 60000
  assert.deepEqual(blockedOf(agent('a', { active: quiet, connected: quiet }), { ...base, tasks: [working('a', quiet)] }, now), { why: 'silent', text: `Silent for ${Math.round((SILENT_MS + 14 * 60000) / 60000)} min` })
  assert.equal(blockedOf(agent('a', { active: now - 1000, connected: quiet }), { ...base, tasks: [working('a', quiet)] }, now), null)
  assert.equal(blockedOf(agent('a', { active: quiet, connected: quiet }), base, now), null)
  assert.equal(blockedKey({ ...base, agents: [agent('a', { error: 'x' }), agent('b')] }, now), 'a:error')

  // ---- the views: the hand for the stop, the ring (no hand) for a knock ----
  const state = {
    agents: [agent('knocker'), agent('gone', { error: 'Lost the API' }), agent('calm')],
    cards: [card('k1', 'knocker', { urgency: 'high', title: 'Urgent <b>' })],
    tasks: [],
    queue: ['k1'], messages: [], memos: [], desks: [],
  }
  state.cards[0].number = 7
  const m = boardModel(state, state.agents)
  const u = id => m.units.find(x => x.id === id)
  assert.equal(u('knocker').stuck, true)
  assert.equal(u('knocker').blocked, null)
  assert.equal(u('gone').blocked?.why, 'error')
  assert.equal(m.blocked, 1)
  const knockBadge = String(badge(u('knocker'), u('knocker'), '/t'))
  assert.match(knockBadge, /data-state="open"/)
  assert.doesNotMatch(knockBadge, /hand-mark/)
  const stopBadge = String(badge(u('gone'), u('gone'), '/t'))
  assert.match(stopBadge, /data-state="blocked" data-why="error" title="gone: Stopped: Error: Lost the API"/)
  assert.match(stopBadge, /class="hand-mark"/)
  assert.equal(String(badge(u('calm'), u('calm'), '/t')), '')
  // a stop without any card still has its badge, and its row says so
  assert.match(String(sidebarRows(m, '/t')), /id="agent-gone"[^>]*>[\s\S]*?data-state="blocked"/)
  // the Desk box: the small red hand (to the stopped session) before the count with the knock's ring
  const desk = String(deskState(m, '/t'))
  assert.match(desk, /<a class="desk-blocked" data-nav href="\/t\/s\/gone" title="Stopped: gone \(Error: Lost the API\)"/)
  assert.match(desk, /class="desk-next is-knock"/)
  assert.ok(desk.indexOf('desk-blocked') < desk.indexOf('desk-next'))
  // nothing waits and nobody is stopped: nothing; only a stop: the hand alone
  const calmOnes = state.agents.map(a => ({ ...a, error: undefined }))
  assert.equal(String(deskState(boardModel({ ...state, agents: calmOnes, cards: [], queue: [] }, calmOnes), '/t')), '')
  assert.match(String(deskState(boardModel({ ...state, cards: [], queue: [] }, state.agents), '/t')), /^<a class="desk-blocked"/)
  // two stopped: the hand leads to Agents
  const two = boardModel({ ...state, agents: [...state.agents, agent('err', { error: 'boom <x>' })] }, [...state.agents, agent('err', { error: 'boom <x>' })])
  assert.match(String(deskState(two, '/t')), /href="\/t\/agents" title="Stopped: gone \(Error: Lost the API\), err \(Error: boom &lt;x&gt;\)"/)
  // the Agents page: the word "stopped" and the cause; the knocking session is not stopped
  const page = String(agentsMain(two, '/t'))
  assert.match(page, /id="ledger-err"[^>]*data-state="stopped"[\s\S]*?<span class="ledger-why">Error: boom &lt;x&gt;<\/span>/)
  assert.doesNotMatch(page, /id="ledger-knocker"[^>]*data-state="stopped"/)
  // a session's heading
  assert.match(String(sessionWho(sessionOf(two, 'err'), '/t')), /<span class="t-blocked" data-why="error" role="status" title="Stopped: Error: boom &lt;x&gt;">[\s\S]*<span>Stopped: Error: boom &lt;x&gt;<\/span>/)
  assert.doesNotMatch(String(sessionWho(sessionOf(two, 'knocker'), '/t')), /t-blocked/)
}
