// When a session is really stopped (card Nr. 202/203): the raised red hand. It is about a SESSION, not a card, and it
// can stand without any card. (A card that is urgent knocks; that is the knock, views/text.mjs isKnock.)
//
// A session is blocked when
//   - it is disconnected while a status line of its says "working" (for longer than a blip: OFFLINE_GRACE_MS),
//   - it reported an error (agent.error, set through /agent/profile; a later call of the session clears it),
//   - it waits for him: an open approval request, or an open card it marked as blocking (urgency critical),
//   - it is connected, a line says "working", and nothing came from it for SILENT_MS.
// Shared by the views (model.mjs), the push (push.mjs) and the hub's tick that notices time passing (server.mjs).

/** Nothing from a working session for this long: it is taken as stuck. Agents often work quietly for a while
 *  (a build, a subagent), so this is generous. */
export const SILENT_MS = Number(process.env.BOARD_SILENT_MS || 15 * 60000)
/** A link that drops and comes back within this time (a restart of the session's bridge) is no stop. */
export const OFFLINE_GRACE_MS = Number(process.env.BOARD_OFFLINE_GRACE_MS || 60000)

// When this hub started: every session is away until it links again, and that is no stop either.
const STARTED = Date.now()
const minutes = ms => Math.max(1, Math.round(ms / 60000))

/** agent: a record of state.agents (online kept by the hub's commit). Returns null, or { why, text } where text is
 *  the plain words for a tooltip ("Disconnected while working", "Error: …", "Waiting for permission", "Silent for 14 min"). */
export function blockedOf(agent, state, now = Date.now()) {
  if (!agent || agent.archived) return null
  const working = (state.tasks ?? []).filter(t => t.agent === agent.id && t.state === 'working')
  if (!agent.online) {
    if (working.length && now - Math.max(agent.seen ?? 0, STARTED) >= OFFLINE_GRACE_MS) return { why: 'offline', text: 'Disconnected while working' }
    return null
  }
  if (agent.error) return { why: 'error', text: `Error: ${String(agent.error).slice(0, 160)}` }
  const waiting = (state.cards ?? []).filter(c => c.agent === agent.id && c.status === 'open' && !c.with_agent)
  if (waiting.some(c => c.kind === 'permission')) return { why: 'permission', text: 'Waiting for permission' }
  if (waiting.some(c => c.urgency === 'critical')) return { why: 'blocking', text: 'Waiting for you: a blocking question' }
  if (working.length) {
    const last = Math.max(agent.active ?? 0, agent.connected ?? 0, ...working.map(t => t.updated ?? 0))
    if (now - last >= SILENT_MS) return { why: 'silent', text: `Silent for ${minutes(now - last)} min` }
  }
  return null
}

/** Every blocked session of the board: Map id -> { why, text }. */
export function blockedAll(state, now = Date.now()) {
  const out = new Map()
  for (const a of state.agents ?? []) { const b = blockedOf(a, state, now); if (b) out.set(a.id, b) }
  return out
}

/** Which sessions are blocked, and why (without the minutes): a change of this is what the hub's tick passes on. */
export const blockedKey = (state, now = Date.now()) => [...blockedAll(state, now)].map(([id, b]) => `${id}:${b.why}`).join(' ')
