// Single source of state for the page: one SSE connection, plain subscribers.
// The server sends the whole state on every change. Several sessions can share
// the board; views see the state through the current scope: nothing (the inbox),
// one session, or a group of sessions the human laid together.
import { foldHtml } from './richhtml.js'

const URGENCY_RANK = { critical: 3, high: 2, normal: 1, low: 0 }
const EMPTY = { agents: [], archived: [], groups: [], messages: [], cards: [], queue: [], tasks: [], assets: [], speech: false }

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
// Snooze lives on the hub (POST /snooze; card.snoozed_until), the same on every device. What this page
// has asked for and the hub's state does not show yet: card id -> true (put off) | false (called back).
const snoozing = new Map()
const isSnoozed = c => c.status === 'open' && (snoozing.has(c.id) ? snoozing.get(c.id) : Boolean(c.snoozed_until))
const snooze = (id, off) => {
  snoozing.set(id, off)
  post('/snooze', off ? { card_id: id } : { card_id: id, clear: true }).catch(() => { snoozing.delete(id); emit() })
}
let waitedBefore = null, snoozedBefore = 0   // to see the moment the rest is done

// Groups and the archive belong to the server (agent.group, agent.archived): every browser sees the
// same pairs and the same shelf. What an older version of this page kept for itself is cleared away.
try { localStorage.removeItem('trommi-groups'); localStorage.removeItem('trommi-archived') } catch {}

// ---- the order of the sessions in the sidebar ----
// It belongs to the server: POST /session { agent, before } puts a session (with its whole group)
// directly before another one, or at the end (before: null); the server then sends the agents in
// that order, each with its `position`, to every browser.
// FALLBACK, PER BROWSER, for a hub that does not know this yet (it sends no `position`): the order
// is kept in localStorage and laid over the server's list. As soon as the server sends positions its
// order wins and what was kept here is dropped. Delete this block once every hub has been restarted.
const ORDER_KEY = 'trommi-order'
let localOrder = (() => { const list = read(ORDER_KEY, []); return Array.isArray(list) ? list.filter(id => typeof id === 'string') : [] })()
let serverOrders = false
function inOrder(agents) {
  serverOrders = agents.some(a => Number.isFinite(a.position))
  if (serverOrders) { if (localOrder.length) { localOrder = []; try { localStorage.removeItem(ORDER_KEY) } catch {} } return agents }
  if (!localOrder.length) return agents
  const place = new Map(localOrder.map((id, at) => [id, at]))
  return agents.map((a, at) => [a, place.get(a.id) ?? localOrder.length + at]).sort((a, b) => a[1] - b[1]).map(([a]) => a)
}

// Older servers send no agents, urgency or queue; fill those in so views can rely on them.
function normalize(data) {
  const sent = inOrder(data.agents?.length ? data.agents : [{ id: 'main', name: 'Agent', online: true }])
  // The human may have renamed a session or picked another mark for it; views only ever see the result.
  const everyone = sent.map(a => ({
    ...a, given: a.name, name: a.label || a.name, mark: a.icon || a.id,
    archived: Boolean(a.archived), group: a.group || null,
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
    // A card put off by asking back returns to its sender's group once the session has answered about it.
    // (also once the session has revised it: the question is presented again)
    const answered = (id, since) => since && ((open.get(id)?.revised ?? 0) > since || raw.messages.some(m => m.card_id === id && m.from !== 'user' && m.from !== 'event' && m.ts > since))
    const kept = later.filter(([id, rank, asked]) => open.has(id) && (URGENCY_RANK[open.get(id).urgency] ?? 1) <= rank && !answered(id, asked))
    if (kept.length !== later.length) { later = kept; write(LATER_KEY, later) }
    // What an older version of this page put off in this browser alone goes to the hub, once.
    const local = later.filter(([, , asked]) => !asked)
    if (local.length) {
      later = later.filter(([, , asked]) => asked)
      write(LATER_KEY, later)
      for (const [id] of local) if (open.get(id)?.kind !== 'permission' && !open.get(id)?.snoozed_until) snooze(id, true)
    }
    // The hub has caught up with what was asked for here.
    for (const [id, off] of snoozing) { const c = open.get(id); if (!c || Boolean(c.snoozed_until) === off) snoozing.delete(id) }
    // "When the rest is done": the last waiting card was answered and snoozed ones remain, so they come
    // back. (Not when the desk was emptied by snoozing its last card: that one stays put off.)
    const put = raw.cards.filter(isSnoozed)
    const waiting = raw.queue.filter(id => open.has(id) && !open.get(id).with_agent && !isSnoozed(open.get(id)) && !later.some(([l]) => l === id)).length
    if (!waiting && put.length && (waitedBefore == null || (waitedBefore > 0 && put.length <= snoozedBefore))) for (const c of put) snooze(c.id, false)
    waitedBefore = waiting
    snoozedBefore = raw.cards.filter(isSnoozed).length
  }
  // A snoozed card is out of the hub's queue; the views list it with the open ones, at the end, and
  // tell it apart by state.later. So it is put back into the line they are given.
  const put = raw.cards.filter(isSnoozed).sort((a, b) => (a.snoozed_at ?? Infinity) - (b.snoozed_at ?? Infinity)).map(c => c.id)
  const called = raw.cards.filter(c => c.status === 'open' && snoozing.get(c.id) === false).map(c => c.id)
  const all = { ...raw, queue: [...raw.queue, ...[...put, ...called].filter(id => !raw.queue.includes(id))] }
  const cards = raw.cards.filter(mine)
  const ids = new Set(cards.map(c => c.id))
  // Which cards are with their session is the hub's knowledge (card.with_agent), the same on every device; what this
  // browser put off by itself comes on top. Both stand at the end of the line.
  const withAgent = raw.cards.filter(c => c.status === 'open' && c.with_agent && !later.some(([id]) => id === c.id)).map(c => c.id)
  view = {
    agents: raw.agents,
    messages: members.length ? raw.messages.filter(mine) : [],
    cards,
    queue: all.queue.filter(id => ids.has(id)),
    tasks: raw.tasks.filter(mine),
    speech: raw.speech,
    scope,
    members,
    group,
    later: [...put, ...later.map(([id]) => id).filter(id => !put.includes(id)), ...withAgent.filter(id => !put.includes(id))],
    // Of those, the ones handed to their session (asked back, Explain, "Back to agent"): they return by themselves with its reply.
    handed: [...later.filter(([, , asked]) => asked).map(([id]) => id), ...withAgent],
    all,
  }
}

const emit = () => { derive(); for (const fn of listeners) fn(view, online) }
let lastData = null   // what the server sent last, to lay a changed local order over it again
const take = data => { lastData = data; raw = normalize(foldHtml(data)); answerHere(raw); loaded = true }

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

/** Put a card off (it leaves its sender's group for "Later"), or fetch it back. state.later lists the ids.
 *  asked: it was put off by asking back, and comes back by itself when the session answers. */
export function putOff(cardId, off = true, asked = false) {
  const card = raw.cards.find(c => c.id === cardId)
  later = later.filter(([id]) => id !== cardId)
  // Asked back: this page remembers since when, to see the session's answer. Snoozed: the hub keeps it.
  if (off && card && asked) later.push([cardId, URGENCY_RANK[card.urgency] ?? 1, Date.now()])
  write(LATER_KEY, later)
  if (card && !asked && off) snooze(cardId, true)
  else if (card && !off && isSnoozed(card)) snooze(cardId, false)
  emit()
}
/** Take a card back that is with its session (handed back to revise, asked to explain) before it was reworked. */
export const takeBack = cardId => post('/handback', { card_id: cardId, clear: true }).then(() => putOff(cardId, false))
// Another tab of this browser put a card off or fetched one back.
window.addEventListener('storage', e => { if (e.key === LATER_KEY) { later = readLater(); emit() } })

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
export const sendMessage = (text, agent, cardId, attachments, flags = {}, cards) =>
  post('/message', { text, agent, ...(cardId ? { card_id: cardId } : {}), ...(attachments?.length ? { attachments } : {}), ...(flags.handback ? { handback: true } : {}), ...(flags.explain ? { explain: true } : {}), ...(cards?.length ? { cards } : {}) })

/** Rename a session or give it another scribble. */
export const editSession = (agent, changes) => post('/session', { agent, ...changes })

/** Mark a session as one whose questions matter most; they lead the inbox. */
export const star = (agent, starred) => post('/star', { agent, starred })

/** Move a session to another place in the sidebar: directly before the session beforeId, or to the
 *  end (null). A session in a group takes its group along, and it lands before a group, never inside
 *  one; only a move before a member of its own group reorders within the group. */
export function moveSession(agentId, beforeId = null) {
  if (!serverOrders && lastData) {
    // The fallback (see ORDER_KEY above): the same rule as the server's moveSession, kept in this browser.
    const list = [...raw.agents, ...raw.archived]
    const agent = list.find(a => a.id === agentId), target = beforeId == null ? null : list.find(a => a.id === beforeId)
    if (agent && target !== agent && (beforeId == null || target)) {
      const within = Boolean(target && agent.group && target.group === agent.group)
      const moved = within || !agent.group ? [agent] : list.filter(a => a.group === agent.group)
      const rest = list.filter(a => !moved.includes(a))
      const anchor = !target ? null : within || !target.group ? target : rest.find(a => a.group === target.group)
      const at = anchor ? rest.indexOf(anchor) : rest.length
      localOrder = [...rest.slice(0, at), ...moved, ...rest.slice(at)].map(a => a.id)
      write(ORDER_KEY, localOrder)
      raw = normalize(lastData)
      answerHere(raw)
      emit()
    }
  }
  return post('/session', { agent: agentId, before: beforeId })
}

// Give sessions a group, or none. The server's next state shows it, here and in every other browser.
const assign = changes => Promise.all([...changes].map(([agent, group]) => post('/session', { agent, group })))

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

/** Put a disconnected session away, or fetch it back. The server refuses it for a session that is
 *  online, and clears the flag by itself when the session reconnects. */
export const archive = (agentId, archived = true) => post('/session', { agent: agentId, archived })

/** Answer a card. key is one of card.options[].key, or a list of them where the card allows several.
 *  Rejects with a readable Error. */
export async function decide(cardId, key, note = '') {
  const keys = [key].flat()
  const revised = revisedOf(cardId)
  // The row leaves at once; the request travels behind it. A state that arrives in between
  // (other sessions keep posting) still shows the card as answered, until the server has said so itself.
  answering.set(cardId, keys)
  answerHere(raw)
  emit()
  try {
    return await post('/decide', { ...(Array.isArray(key) ? { card_id: cardId, keys: key, key: key[0], note } : { card_id: cardId, key, note }), revised })
  } catch (err) {
    // Not taken: the card is open again, as the server has it.
    answering.delete(cardId)
    const card = raw.cards.find(c => c.id === cardId)
    if (card?.answeredHere) Object.assign(card, { status: 'open', choice: null, choices: [], decided: null, answeredHere: false })
    if (card && !raw.queue.includes(cardId)) raw.queue = [...raw.queue, cardId]
    emit()
    throw err
  }
}

// Answers on their way to the server, by card id.
const answering = new Map()
function answerHere(data) {
  for (const [id, keys] of answering) {
    const card = data.cards.find(c => c.id === id)
    if (!card || card.status !== 'open') { answering.delete(id); continue }
    Object.assign(card, { status: 'decided', choice: keys[0], choices: keys, decided: Date.now(), answeredHere: true })
    data.queue = data.queue.filter(q => q !== id)
  }
}

// Which wording of a card this page holds: the server refuses an answer given to an earlier one.
const revisedOf = cardId => raw.cards.find(c => c.id === cardId)?.revised ?? null

/** Take back the answer on an answered or done card; it returns to the stack. */
export const reopen = cardId => post('/reopen', { card_id: cardId })

/** Leave a decision to the agent: it takes what it advised, or chooses itself. Taken back with reopen(). */
export const trust = cardId => post('/decide', { card_id: cardId, trust: true, revised: revisedOf(cardId) })

/** Throw a card away unanswered (a question or an info, never an approval). Taken back with reopen(). */
export const shred = cardId => post('/shred', { card_id: cardId })

/** Close an info card: it was read. (The server refuses it for a question, and for one that is closed already.) */
export const closeInfo = cardId => post('/close', { card_id: cardId })

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
