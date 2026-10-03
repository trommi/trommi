// What the views show, worked out once per render from the hub's state. The rules are those the old
// client had in js/store.js, js/inbox.js and js/agents.js; here they run on the hub, so every browser
// gets the same answer and none has to compute it.
import { isKnock } from './text.mjs'
import { blockedOf } from '../blocked.mjs'
import { hueFor } from '../../client/web/js/pen.js'

/** state: the hub's state. agents: the sessions as the page may see them (pageAgents() in server.mjs). */
/** desk: the desk in view (its id). A desk is a world of its own sessions and their stack; of the other desks only
 *  what knocks shows here (the card, named with its desk). Without desks on the hub the board is one. */
export function boardModel(state, agents = state.agents, desk = null) {
  const desks = state.desks?.length ? state.desks : null
  const deskId = desks ? (desks.some(d => d.id === desk) ? desk : desks[0].id) : null
  const deskOf = a => (desks ? (desks.some(d => d.id === a?.desk) ? a.desk : desks[0].id) : null)
  const everyone = agents.map(a => ({ ...a, given: a.name, name: a.label || a.name, mark: a.icon || a.id, archived: Boolean(a.archived) }))
  for (const a of everyone) a.hue = hueFor(a)
  const onDesk = a => !desks || deskOf(a) === deskId
  // (A session of another desk is named with its desk wherever it shows here.)
  if (desks) for (const a of everyone) if (!onDesk(a)) a.name = `${a.name} · ${desks.find(d => d.id === deskOf(a))?.name ?? ''}`
  const here = everyone.filter(a => !a.archived && onDesk(a))
  const byAgent = new Map(everyone.map(a => [a.id, a]))
  const byCard = new Map(state.cards.map(c => [c.id, c]))
  const shelved = new Set(everyone.filter(a => a.archived).map(a => a.id))

  // The stack, in the hub's fixed order (oldest first). A card that is with its session (handed back, asked
  // to explain) is open but not waiting on the human: it lies on "Later" until it returns.
  const mine = c => onDesk(byAgent.get(c.agent))
  const allOpen = state.queue.map(id => byCard.get(id)).filter(Boolean)
  const allFresh = allOpen.filter(c => !c.with_agent)   // the whole board's stack, for the menu's count per desk
  const open = allOpen.filter(c => mine(c) || (!c.with_agent && isKnock(c)))
  const fresh = open.filter(c => !c.with_agent)
  const revising = open.filter(c => c.with_agent).sort((a, b) => b.with_agent - a.with_agent)
  const snoozed = state.cards.filter(c => c.status === 'open' && c.snoozed_until && !shelved.has(c.agent) && mine(c)).sort((a, b) => (b.snoozed_at ?? 0) - (a.snoozed_at ?? 0))
  const answered = state.cards.filter(c => c.status !== 'open' && ((c.kind === 'decision' && (c.choice != null || c.trusted)) || (c.kind === 'info' && c.read)) && mine(c))
  const shredded = state.cards.filter(c => c.status === 'shredded' && mine(c))
  const at = c => (c.status === 'shredded' ? c.shredded : c.decided) ?? 0
  const done = [...answered, ...shredded].sort((a, b) => at(b) - at(a))

  const now = Date.now()
  // Per session: what waits on the human, whether it works, whether one of its questions knocks.
  const summary = ids => {
    const mine = fresh.filter(c => ids.has(c.agent))
    const online = everyone.some(a => ids.has(a.id) && a.online)
    const running = everyone.some(a => ids.has(a.id) && a.online && state.tasks.some(t => t.agent === a.id && t.state === 'working'))
    // stuck: one of its questions knocks (urgent card). blocked: the session itself is stopped (../blocked.mjs), { why, text }.
    const blocked = everyone.filter(a => ids.has(a.id)).map(a => blockedOf(a, state, now)).find(Boolean) ?? null
    return { open: mine.length, online, running, stuck: mine.some(isKnock), blocked }
  }
  // One row per session; a session that names a main which stands here lies under it, one level deep.
  const units = here.map(a => ({ id: a.id, agent: a, ...summary(new Set([a.id])) }))
  const unitOf = new Map(units.map(u => [u.id, u]))
  for (const u of units) {
    const main = u.agent.parent ? unitOf.get(u.agent.parent) : null
    if (main && main !== u && !main.agent.parent) { u.parent = main; (main.subs ??= []).push(u) }
  }
  for (const u of units) if (u.subs) u.whole = summary(new Set([u.id, ...u.subs.map(s => s.id)]))

  return {
    state, agents: here, everyone, byAgent, byCard, open, fresh, allFresh, desk: deskId, desks: desks ?? [], revising, snoozed, done, units,
    knocking: fresh.filter(isKnock).length,
    blocked: units.filter(u => u.blocked).length,
    working: units.filter(u => u.online && u.running).length,
    deskName: desks?.find(d => d.id === deskId)?.name || 'Desk',
    cardByRef: ref => state.cards.find(c => String(c.number) === String(ref)) ?? byCard.get(String(ref)) ?? null,
  }
}
