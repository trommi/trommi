// Single source of state for the page: one SSE connection, plain subscribers.
// The server sends the whole state on every change. Several sessions can share
// the board; views see the state through the current scope: nothing (the inbox),
// one session, or a group of sessions the human laid together.

const URGENCY_RANK = { critical: 3, high: 2, normal: 1, low: 0 }
const EMPTY = { agents: [], archived: [], groups: [], messages: [], cards: [], queue: [], tasks: [], assets: [], speech: false }

let source = null        // what the server sent last, untouched
let raw = EMPTY          // the same, normalized
let view = { ...EMPTY, scope: null, members: [], group: null, later: [], all: EMPTY }
let scope = null         // a session id, a group id, or null for the inbox across all sessions
let scopeMembers = []    // who was in scope last, to stay with them when a group dissolves
let online = false
let loaded = false
const listeners = new Set()

const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback } }
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)) } catch {} }

// Cards the human put off with "Later": [card id, urgency rank at that moment], oldest first.
// Kept in this browser, so a reload does not refill the list that was worked down. An entry
// goes when its card is no longer open, or when the agent has made it more urgent since.
const LATER_KEY = 'trommi-later'
const readLater = () => {
  const list = read(LATER_KEY, [])
  return Array.isArray(list) ? list.filter(e => Array.isArray(e) && typeof e[0] === 'string') : []
}
let later = readLater()

// Groups and the archive belong to the server (agent.group, agent.archived). A server that does
// not know them yet ignores the request, so this browser keeps its own copy and uses it until
// the server's records carry the fields.
const GROUPS_KEY = 'trommi-groups'       // { session id: group id }
const ARCHIVED_KEY = 'trommi-archived'   // [session id]
const plainObject = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
let localGroups = plainObject(read(GROUPS_KEY, {}))
let localArchived = new Set([].concat(read(ARCHIVED_KEY, [])).filter(id => typeof id === 'string'))

// Older servers send no agents, urgency or queue; fill those in so views can rely on them.
function normalize(data) {
  const sent = data.agents?.length ? data.agents : [{ id: 'main', name: 'Agent', online: true }]
  const knowsGroups = sent.some(a => a.group !== undefined)
  const knowsArchive = sent.some(a => a.archived !== undefined)
  // The human may have renamed a session or picked another mark for it; views only ever see the result.
  const everyone = sent.map(a => ({
    ...a, given: a.name, name: a.label || a.name, mark: a.icon || a.id,
    // A session that comes back is no longer archived.
    archived: knowsArchive ? Boolean(a.archived) : localArchived.has(a.id) && !a.online,
    group: (knowsGroups ? a.group : localGroups[a.id]) || null,
  }))
  const agents = everyone.filter(a => !a.archived)
  // A group is two or more sessions that are still here; one alone is just a session.
  const byGroup = new Map()
  for (const a of agents) if (a.group) byGroup.set(a.group, [...(byGroup.get(a.group) ?? []), a])
  for (const a of agents) if (a.group && byGroup.get(a.group).length < 2) a.group = null
  const groups = [...byGroup].filter(([, members]) => members.length > 1).map(([id, members]) => ({ id, members }))

  const fallback = everyone[0].id
  const nameOf = Object.fromEntries(everyone.map(a => [a.id, a.name]))
  const several = agents.length > 1
  const gone = new Set(everyone.filter(a => a.archived).map(a => a.id))
  const cards = (data.cards ?? []).map((c, i) => ({
    number: i + 1,
    urgency: c.kind === 'permission' ? 'critical' : 'normal',
    urgency_reason: '',
    attachments: [],
    agent: fallback,
    ...c,
    // Who is asking, shown on cards only when there is more than one session.
    agent_name: several ? nameOf[c.agent ?? fallback] ?? '' : '',
  }))
  const agentOf = new Map(cards.map(c => [c.id, c.agent]))
  const queue = (data.queue ?? cards
    .filter(c => c.status === 'open')
    .sort((a, b) => URGENCY_RANK[b.urgency] - URGENCY_RANK[a.urgency] || a.created - b.created)
    .map(c => c.id))
    // What an archived session asked waits with it, out of the way.
    .filter(id => !gone.has(agentOf.get(id)))
  return {
    agents,
    archived: everyone.filter(a => a.archived),
    groups,
    messages: (data.messages ?? []).map(m => ({ agent: fallback, ...m })),
    cards,
    queue,
    tasks: (data.tasks ?? []).map(t => ({ agent: fallback, ...t, agent_name: several ? nameOf[t.agent ?? fallback] ?? '' : '' })),
    // What sessions published under a link of its own; the link itself is on the message that announced it.
    assets: data.assets ?? [],
    speech: Boolean(data.speech),
  }
}

function derive() {
  // Resolve the scope: a group by its id, a session by its id (its group, if it is in one).
  let group = raw.groups.find(g => g.id === scope) ?? null
  if (!group && scope) {
    const agent = raw.agents.find(a => a.id === scope) ?? (loaded ? raw.agents.find(a => scopeMembers.includes(a.id)) : null)
    if (agent?.group) group = raw.groups.find(g => g.id === agent.group) ?? null
    if (loaded || agent) scope = group?.id ?? agent?.id ?? null
  }
  const members = group ? group.members.map(a => a.id) : scope ? [scope] : []
  if (loaded) scopeMembers = members
  const mine = x => !members.length || members.includes(x.agent)
  if (loaded) {
    const open = new Map(raw.cards.filter(c => c.status === 'open').map(c => [c.id, c]))
    const kept = later.filter(([id, rank]) => open.has(id) && (URGENCY_RANK[open.get(id).urgency] ?? 1) <= rank)
    if (kept.length !== later.length) { later = kept; write(LATER_KEY, later) }
  }
  const cards = raw.cards.filter(mine)
  const ids = new Set(cards.map(c => c.id))
  view = {
    agents: raw.agents,
    messages: members.length ? raw.messages.filter(mine) : [],
    cards,
    queue: raw.queue.filter(id => ids.has(id)),
    tasks: raw.tasks.filter(mine),
    speech: raw.speech,
    scope,
    members,
    group,
    later: later.map(([id]) => id),
    all: raw,
  }
}

const emit = () => { derive(); for (const fn of listeners) fn(view, online) }
const take = data => { source = data; raw = normalize(data); loaded = true }
const renormalize = () => { if (source) raw = normalize(source); emit() }

export function connect() {
  const events = new EventSource('/events')
  events.onopen = () => { online = true; emit() }
  events.onerror = () => { online = false; emit() }
  events.onmessage = e => { take(JSON.parse(e.data)); emit() }
}

/** Call fn(state, online) now and on every change. Returns an unsubscribe function.
 *  state is what the current scope shows: state.scope is a session id, a group id or null,
 *  state.members the session ids in scope, state.group the group or null. state.all is everything:
 *  all.agents are the sessions not archived, all.archived the others, all.groups [{ id, members }]. */
export function subscribe(fn) {
  listeners.add(fn)
  fn(view, online)
  return () => listeners.delete(fn)
}

export const getState = () => view

/** Put a card off (it leaves its sender's group for "Later"), or fetch it back. state.later lists the ids. */
export function putOff(cardId, off = true) {
  const card = raw.cards.find(c => c.id === cardId)
  later = later.filter(([id]) => id !== cardId)
  if (off && card) later.push([cardId, URGENCY_RANK[card.urgency] ?? 1])
  write(LATER_KEY, later)
  emit()
}
// Another tab of this browser changed one of the lists.
window.addEventListener('storage', e => {
  if (e.key === LATER_KEY) { later = readLater(); emit() }
  if (e.key === GROUPS_KEY) { localGroups = plainObject(read(GROUPS_KEY, {})); renormalize() }
  if (e.key === ARCHIVED_KEY) { localArchived = new Set([].concat(read(ARCHIVED_KEY, []))); renormalize() }
})

/** False until the first real state has arrived; before that, state is an empty placeholder. */
export const isLoaded = () => loaded

/** Show one session or one group (its id), or all sessions (null). A session that is part of a group shows the group. */
export function setScope(id) {
  if (id === scope) return
  scope = id
  scopeMembers = []
  emit()
}

/** Test and preview hook: push a state without a server. */
export function setState(data) {
  take(data)
  online = true
  emit()
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  let out = {}
  try { out = await res.json() } catch {}
  if (!res.ok) throw new Error(out.error || res.statusText)
  return out
}

/** Send a chat message to one session; with cardId it is a question back about that card. Rejects with a readable Error. */
export const sendMessage = (text, agent, cardId) => post('/message', cardId ? { text, agent, card_id: cardId } : { text, agent })

/** Rename a session or give it another scribble. */
export const editSession = (agent, changes) => post('/session', { agent, ...changes })

/** Mark a session as one whose questions matter most; they lead the inbox. */
export const star = (agent, starred) => post('/star', { agent, starred })

// Give sessions a group, or none: here at once, then on the server.
function assign(changes) {
  for (const [agent, group] of changes) {
    if (group) localGroups[agent] = group
    else delete localGroups[agent]
  }
  write(GROUPS_KEY, localGroups)
  renormalize()
  return Promise.all([...changes].map(([agent, group]) => post('/session', { agent, group })))
}

/** Lay one session together with another (or with the group the other is in). They show as one. */
export function pair(agentId, targetId) {
  const agent = raw.agents.find(a => a.id === agentId)
  const target = raw.agents.find(a => a.id === targetId)
  if (!agent || !target || agent === target || (agent.group && agent.group === target.group)) return Promise.resolve()
  const changes = new Map()
  // Whoever the session leaves behind alone is on its own again.
  const left = raw.groups.find(g => g.id === agent.group)?.members.filter(a => a !== agent) ?? []
  if (left.length === 1) changes.set(left[0].id, null)
  const id = target.group ?? `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  changes.set(target.id, id)
  changes.set(agent.id, id)
  return assign(changes)
}

/** Take a session out of its group. A group of two dissolves. */
export function unpair(agentId) {
  const group = raw.groups.find(g => g.members.some(a => a.id === agentId))
  if (!group) return Promise.resolve()
  const leaving = group.members.length <= 2 ? group.members.map(a => a.id) : [agentId]
  return assign(new Map(leaving.map(id => [id, null])))
}

/** Put a disconnected session away, or fetch it back. The server clears the flag when the session reconnects. */
export function archive(agentId, archived = true) {
  if (archived) localArchived.add(agentId)
  else localArchived.delete(agentId)
  write(ARCHIVED_KEY, [...localArchived])
  renormalize()
  return post('/session', { agent: agentId, archived })
}

/** Answer a card. key is one of card.options[].key, or a list of them where the card allows several.
 *  Rejects with a readable Error. */
export const decide = (cardId, key, note = '') =>
  post('/decide', Array.isArray(key) ? { card_id: cardId, keys: key, key: key[0], note } : { card_id: cardId, key, note })

/** Take back the answer on an answered or done card; it returns to the stack. */
export const reopen = cardId => post('/reopen', { card_id: cardId })

/** Send a drawing to one session: the editable doc, a PNG of the whole canvas and one of the section on screen (data URLs). */
export const sendScribble = ({ doc, png, view }, agent) => post('/scribble', { doc, png, view, agent })

/** The lasting canvas of a session: null if nothing was drawn yet. */
export async function loadCanvas(agent) {
  const res = await fetch(`/canvas?agent=${encodeURIComponent(agent)}`)
  if (!res.ok) throw new Error('Canvas did not load')
  return res.json()
}

/** Save the canvas of a session while the human draws. */
export const saveCanvas = (agent, doc) => post('/canvas', { agent, doc })

/** Recorded audio (a Blob) to text. */
export async function transcribe(blob) {
  const res = await fetch('/speech/transcribe', { method: 'POST', headers: { 'Content-Type': blob.type || 'audio/webm' }, body: blob })
  let out = {}
  try { out = await res.json() } catch {}
  if (!res.ok) throw new Error(out.error || res.statusText)
  return out.text ?? ''
}

/** Where the spoken version of a card lives. */
export const cardAudioUrl = cardId => `/speech/card/${encodeURIComponent(cardId)}`
