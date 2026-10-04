// When a session is really stopped (card Nr. 202/203): the raised red hand. It is about a SESSION, not a card, and it
// can stand without any card. (A card that is urgent knocks; that is the knock, views/text.mjs isKnock.)
//
// A session is blocked when
//   - it is disconnected while a status line of its says "working" (for longer than a blip: OFFLINE_GRACE_MS),
//   - it reported an error (agent.error, set through /agent/profile; a later call of the session clears it),
//   - it waits for him: an open approval request, or an open card it marked as blocking (urgency critical),
// Being quiet is NOT a stop (decided "ruhig"): a connected session with a working line that said nothing for
// QUIET_MS only gets a grey hint, quietOf() ("quiet for 24 min"): no red hand, no push, not in the Desk's badge.
// For a child session (agent.parent) "it" is the agent process behind it: a helper whose main agent is online and
// still talking (agent.device_active) is not quiet.
// Shared by the views (model.mjs), the push (push.mjs) and the hub's tick that notices time passing (server.mjs).

/** Nothing from a working, connected session for this long: a quiet grey hint on the session, nothing more. */
export const QUIET_MS = 15 * 60000
/** A link that drops and comes back within this time (a restart of the session's bridge) is no stop. */
export const OFFLINE_GRACE_MS = 60000

// When this hub started: every session is away until it links again, and that is no stop either.
const STARTED = Date.now()
const minutes = ms => Math.max(1, Math.round(ms / 60000))
const two = n => String(n).padStart(2, '0')
/** 14:05 today, else "3 Oct 14:05". */
const clock = (t, now) => {
  const d = new Date(t), today = new Date(now).toDateString() === d.toDateString()
  return `${today ? '' : `${d.getDate()} ${d.toLocaleString('en', { month: 'short' })} `}${two(d.getHours())}:${two(d.getMinutes())}`
}

/** agent: a record of state.agents (online kept by the hub's commit). Returns null, or { why, text } where text is
 *  the plain words for a tooltip ("Connection lost since 14:05", "Error: …", "Waiting for permission"). */
export function blockedOf(agent, state, now = Date.now()) {
  if (!agent || agent.archived) return null
  const working = (state.tasks ?? []).filter(t => t.agent === agent.id && t.state === 'working')
  if (!agent.online) {
    // offline_since: when the hub saw its last stream close (hub /devices); older hubs only give the last activity.
    const since = agent.offline_since ?? null
    if (working.length && now - Math.max(since ?? agent.seen ?? 0, STARTED) >= OFFLINE_GRACE_MS) return { why: 'offline', text: since ? `Connection lost since ${clock(since, now)}` : 'Disconnected while working', since }
    return null
  }
  if (agent.error) return { why: 'error', text: `Error: ${String(agent.error).slice(0, 160)}` }
  const waiting = (state.cards ?? []).filter(c => c.agent === agent.id && c.status === 'open' && !c.with_agent)
  if (waiting.some(c => c.kind === 'permission')) return { why: 'permission', text: 'Waiting for permission' }
  if (waiting.some(c => c.urgency === 'critical')) return { why: 'blocking', text: 'Waiting for you: a blocking question' }
  return null
}

/** The quiet hint: { text: "quiet for 24 min", minutes } for a connected session whose working line has seen nothing
 *  for QUIET_MS, else null. Never a stop: blockedOf does not know it. */
export function quietOf(agent, state, now = Date.now()) {
  if (!agent || agent.archived || !agent.online) return null
  const working = (state.tasks ?? []).filter(t => t.agent === agent.id && t.state === 'working')
  if (!working.length) return null
  const last = Math.max(agent.active ?? 0, agent.connected ?? 0, agent.parent ? agent.device_active ?? 0 : 0, ...working.map(t => t.updated ?? 0))
  if (now - last < QUIET_MS) return null
  const n = minutes(now - last)
  return { text: `quiet for ${n} min`, minutes: n }
}
