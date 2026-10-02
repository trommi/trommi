// Single source of state for the page: one SSE connection, plain subscribers.
// The server sends the whole state on every change. Several agents can share
// the board; views see the state through the current scope: one agent, or all.

const URGENCY_RANK = { critical: 3, high: 2, normal: 1, low: 0 }
const EMPTY = { agents: [], messages: [], cards: [], queue: [], tasks: [], speech: false }

let raw = EMPTY          // everything the server sent, normalized
let view = { ...EMPTY, scope: null, later: [], all: EMPTY }
let scope = null         // an agent id, or null for the inbox across all agents
let online = false
let loaded = false
const listeners = new Set()

// Cards the human put off with "Später": [card id, urgency rank at that moment], oldest first.
// Kept in this browser, so a reload does not refill the list that was worked down. An entry
// goes when its card is no longer open, or when the agent has made it more urgent since.
const LATER_KEY = 'trommi-later'
const readLater = () => {
  try {
    const list = JSON.parse(localStorage.getItem(LATER_KEY))
    return Array.isArray(list) ? list.filter(e => Array.isArray(e) && typeof e[0] === 'string') : []
  } catch { return [] }
}
let later = readLater()
const saveLater = () => { try { localStorage.setItem(LATER_KEY, JSON.stringify(later)) } catch {} }

// Older servers send no agents, urgency or queue; fill those in so views can rely on them.
function normalize(data) {
  // The human may have renamed a session or picked another mark for it; views only ever see the result.
  const agents = (data.agents?.length ? data.agents : [{ id: 'main', name: 'Agent', online: true }])
    .map(a => ({ ...a, given: a.name, name: a.label || a.name, mark: a.icon || a.id }))
  const fallback = agents[0].id
  const nameOf = Object.fromEntries(agents.map(a => [a.id, a.name]))
  const several = agents.length > 1
  const cards = (data.cards ?? []).map((c, i) => ({
    number: i + 1,
    urgency: c.kind === 'permission' ? 'critical' : 'normal',
    urgency_reason: '',
    attachments: [],
    agent: fallback,
    ...c,
    // Who is asking, shown on cards only when there is more than one agent.
    agent_name: several ? nameOf[c.agent ?? fallback] ?? '' : '',
  }))
  const queue = data.queue ?? cards
    .filter(c => c.status === 'open')
    .sort((a, b) => URGENCY_RANK[b.urgency] - URGENCY_RANK[a.urgency] || a.created - b.created)
    .map(c => c.id)
  return {
    agents,
    messages: (data.messages ?? []).map(m => ({ agent: fallback, ...m })),
    cards,
    queue,
    tasks: (data.tasks ?? []).map(t => ({ agent: fallback, ...t, agent_name: several ? nameOf[t.agent ?? fallback] ?? '' : '' })),
    speech: Boolean(data.speech),
  }
}

function derive() {
  if (scope && !raw.agents.some(a => a.id === scope)) scope = null
  const active = scope
  const mine = x => !active || x.agent === active
  if (loaded) {
    const open = new Map(raw.cards.filter(c => c.status === 'open').map(c => [c.id, c]))
    const kept = later.filter(([id, rank]) => open.has(id) && (URGENCY_RANK[open.get(id).urgency] ?? 1) <= rank)
    if (kept.length !== later.length) { later = kept; saveLater() }
  }
  const cards = raw.cards.filter(mine)
  const ids = new Set(cards.map(c => c.id))
  view = {
    agents: raw.agents,
    messages: active ? raw.messages.filter(mine) : [],
    cards,
    queue: raw.queue.filter(id => ids.has(id)),
    tasks: raw.tasks.filter(mine),
    speech: raw.speech,
    scope: active,
    later: later.map(([id]) => id),
    all: raw,
  }
}

const emit = () => { derive(); for (const fn of listeners) fn(view, online) }

export function connect() {
  const events = new EventSource('/events')
  events.onopen = () => { online = true; emit() }
  events.onerror = () => { online = false; emit() }
  events.onmessage = e => { raw = normalize(JSON.parse(e.data)); loaded = true; emit() }
}

/** Call fn(state, online) now and on every change. Returns an unsubscribe function.
 *  state is what the current scope shows; state.all is everything, state.scope the agent id or null. */
export function subscribe(fn) {
  listeners.add(fn)
  fn(view, online)
  return () => listeners.delete(fn)
}

export const getState = () => view

/** Put a card off (it leaves its sender's group for "Später"), or fetch it back. state.later lists the ids. */
export function putOff(cardId, off = true) {
  const card = raw.cards.find(c => c.id === cardId)
  later = later.filter(([id]) => id !== cardId)
  if (off && card) later.push([cardId, URGENCY_RANK[card.urgency] ?? 1])
  saveLater()
  emit()
}
// Another tab of this browser changed the list.
window.addEventListener('storage', e => { if (e.key === LATER_KEY) { later = readLater(); emit() } })

/** False until the first real state has arrived; before that, state is an empty placeholder. */
export const isLoaded = () => loaded

/** Show one agent (its id) or all agents (null). */
export function setScope(id) {
  if (id === scope) return
  scope = id
  emit()
}

/** Test and preview hook: push a state without a server. */
export function setState(data) {
  raw = normalize(data)
  online = true
  loaded = true
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

function recipient() {
  if (!view.scope) throw new Error('Wähle zuerst einen Agenten aus.')
  return view.scope
}

/** Send a chat message to the agent in scope. Rejects with a readable Error. */
export const sendMessage = text => post('/message', { text, agent: recipient() })

/** Rename a session or give it another scribble. */
export const editSession = (agent, changes) => post('/session', { agent, ...changes })

/** Mark a session as one whose questions matter most; they lead the inbox. */
export const star = (agent, starred) => post('/star', { agent, starred })

/** Answer a card. key is one of card.options[].key. Rejects with a readable Error. */
export const decide = (cardId, key, note = '') => post('/decide', { card_id: cardId, key, note })

/** Take back the answer on a decided or done decision card; it returns to the stack. */
export const reopen = cardId => post('/reopen', { card_id: cardId })

/** Send a drawing: the editable doc, a PNG of the whole canvas and one of the section on screen (data URLs). */
export const sendScribble = ({ doc, png, view }) => post('/scribble', { doc, png, view, agent: recipient() })

/** The lasting canvas of the session in scope: null if nothing was drawn yet. */
export async function loadCanvas(agent) {
  const res = await fetch(`/canvas?agent=${encodeURIComponent(agent)}`)
  if (!res.ok) throw new Error('Canvas nicht geladen')
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
