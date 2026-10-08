// The app: its start (boot), the room in the page (the core's model as the views' board state, the actions as the
// views' "hub"), the board (pages, forms, live pieces: every view registers its own), the router, the frame around a
// page, the service worker's side (attachments, push, new versions). Importing it does nothing; index.html's import
// starts it (boot, at the end).
import * as desk from './desk.mjs'
import * as sidebar from './sidebar.mjs'
import * as notes from './notes.mjs'
import { DRAWER_VEIL, SIDE_FOOT, cornerNote, phoneBar, sidebarRows, topbar } from './sidebar.mjs'
import { Controller, WORDS, calm, controller, curlHTML, el, html, hueFor, isKnock, keySheet, startUi, toast } from './ui.mjs'
import { boardNotes, noteStore } from './notes.mjs'
import { rowSheet } from './desk.mjs'
// The views a cold start needs (the Desk, its frame, the notes) come with this module; every other view is loaded
// when an address of it is first asked for (LAZY: the addresses it answers), and all of them once the page is idle,
// so a later navigation finds them in memory.
const VIEWS = [desk, sidebar, notes]
const LAZY = {
  auth: { load: () => import('./auth.mjs'), paths: /^\/(?:settings\/(?:devices|account)|devices\/|pair|logout|join|login)(?:\/|$)/ },
  agents: { load: () => import('./agents.mjs'), paths: /^\/(?:settings\/agents$|sessions\/)/ },
  card: { load: () => import('./card.mjs'), paths: /^(?:\/s\/[^/]+)?\/card\/|^\/cards\/[0-9a-f]+\// },
  session: { load: () => import('./session.mjs'), paths: /^\/s\// },
  media: { load: () => import('./media.mjs'), paths: /^\/(?:assets|pages)(?:\/|$)/ },
  whiteboard: { load: () => import('./whiteboard.mjs'), paths: /^\/scribble-board$/ },
}
const loaded = {}   // name -> the view's module, once loaded
/** A lazy view's module (loaded once; registered on the board, when there is one, as it arrives). */
function view(name) {
  const v = LAZY[name]
  v.promise ??= v.load().then(m => { loaded[name] = m; v.onLoad?.(m); return m }, err => { v.promise = null; throw err })
  return v.promise
}

// ---- the app's version ----
// The app's version, sent to the hub on every request as Trommi-Client: app/<version> (with Trommi-Protocol: 1, by
// the core). Raise it with every release that changes what the app sends or understands.
const APP_VERSION = '0.2.0'
export const CLIENT = `app/${APP_VERSION}`

// The client core (gen/vendor, copied from the repository's core/ by dev/build.mjs): every view gets crypto, keys and
// the account through these, never on its own.
export const core = () => import('./gen/vendor/index.mjs')
// The check code as emoji (shared/check-emoji.mjs, the same function the connector prints with): loaded at once, beside
// the core (which imports it too, so a room's client never exists before it); a live binding, [] until it is there.
// Not a static import: app.mjs is also imported in Node (tests), where gen/ is not built.
export let checkEmoji = () => []
import('./gen/vendor/check-emoji.mjs').then(m => { checkEmoji = m.checkEmoji }, () => {})
export const account = () => import('./gen/vendor/account.mjs')
export const canvasWire = () => import('./gen/vendor/canvas.mjs')

// Where the hub is (a tab session may override it: ?hub=, for development).
export const ses = (k, v) => { try { if (v != null) sessionStorage.setItem(k, v); return sessionStorage.getItem(k) } catch { return v ?? null } }
/** The hub: fixed https://hub.trommi.com (local dev: http://127.0.0.1:8890). Hidden developer override, no UI: ?hub=<url> and ?found_code=<code>, read once and kept for the tab session. */
export function hubUrl() {
  const q = new URLSearchParams(location.search)
  const asked = q.get('hub')
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
  return (ses('trommi-hub', asked ? asked.replace(/\/+$/, '') : null)) || (local ? 'http://127.0.0.1:8890' : 'https://hub.trommi.com')
}

// ---- blocked ----
// When a session is really stopped (card Nr. 202/203): the raised red hand. It is about a SESSION, not a card, and it
// can stand without any card. (A card that is urgent knocks; that is the knock, ui.mjs isKnock.)
//
// A session is blocked when
//   - it is disconnected while a status line of its says "working" (for longer than a blip: OFFLINE_GRACE_MS),
//   - it is cut off (linkOf below): its Claude Code runs and its Trommi tools are gone, working line or not,
//   - it reported an error (agent.error, set through /agent/profile; a later call of the session clears it),
//   - it waits for him: an open approval request, or an open card it marked as blocking (urgency critical),
// Being quiet is NOT a stop (decided "ruhig"): a connected session with a working line that said nothing for
// QUIET_MS only gets a grey hint, quietOf() ("quiet for 24 min"): no red hand, no push, not in the Desk's badge.
// For a child session (agent.parent) "it" is the agent process behind it: a helper whose main agent is online and
// still talking (agent.device_active) is not quiet.
// Shared by the views and the board model below.

/** Nothing from a working, connected session for this long: a quiet grey hint on the session, nothing more. */
export const QUIET_MS = 15 * 60000
/** A link that drops and comes back within this time (a restart of the session's bridge) is no stop. */
const OFFLINE_GRACE_MS = 60000

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
  const link = linkOf(agent, now)
  if (link?.state === 'cut') return { why: 'cut', text: link.short, since: link.since }
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

// ---- link ----
// Whether a session can HEAR the human and SPEAK to him, which is more than "its connector has a stream" (agent.online).
// The session's connector reports it to the hub (agent.link, README "The link"), and writes a receipt when it really
// handed the human's words to the agent (card.heard). The five states are the core's (shared/model.mjs linkState, the
// same rules here: the views are rendered without the core at hand); here they get their words.
//   agent.link: { hears: 'live' | 'oncall', attached, last_call_at, since, cut_since, exit: { reason, claude } } or null
//   card.heard: true (the agent has his answer or hand-back), false (it waits in the connector), null (not known:
//               nothing to hear, or a connector that writes no receipts)
/** No tool call for this long, in a session that hears only on its next one: it is not listening. */
export const ASLEEP_MS = 10 * 60000
/** An answer the session has not picked up for this long is worth a word. */
export const UNHEARD_MS = 2 * 60000
const RECONNECT = '/mcp → trommi → Reconnect', LIVE_FLAG = 'claude --resume --dangerously-load-development-channels server:trommi'
/** The session's link: { state: 'live' | 'oncall' | 'asleep' | 'cut' | 'gone', sign, word, short, line, since, fix: { say, code } | null }; null for none. */
export function linkOf(agent, now = Date.now()) {
  if (!agent || agent.archived || agent.removed) return null
  const n = agent.name, l = agent.link ?? null
  if (!agent.online) {
    const since = agent.offline_since ?? null, at = since ? clock(since, now) : ''
    if (l?.exit?.claude === 'alive') return { state: 'cut', sign: 'ear-off', since, word: `cut off${at ? ` · ${at}` : ''}`, short: at ? `Cut off since ${at}` : 'Cut off', line: `${n} is cut off${at ? ` since ${at}` : ''}: its Claude Code runs, its Trommi tools are gone. It cannot hear you and cannot write to you.`, fix: { say: 'In its terminal:', code: RECONNECT } }
    const how = l?.exit ? 'its Claude Code session ended.' : 'it stopped without a word: its session ended, was killed, or its machine is off the network.'
    return { state: 'gone', sign: 'plug', since, word: `gone${at ? ` · ${at}` : ''}`, short: at ? `Gone since ${at}` : 'Gone', line: `${n} is gone${at ? ` since ${at}` : ''}: ${how}`, fix: { say: 'Start it again in its folder:', code: 'claude --continue' } }
  }
  if (l?.cut_since || (l && l.attached === false)) {
    const since = l.cut_since ?? l.since ?? null, at = since ? clock(since, now) : ''
    return { state: 'cut', sign: 'ear-off', since, word: `cut off${at ? ` · ${at}` : ''}`, short: at ? `Cut off since ${at}` : 'Cut off', line: `A Claude Code session in ${n}'s folder is cut off${at ? ` since ${at}` : ''}: it runs, its Trommi tools are gone. It cannot hear you and cannot write to you.`, fix: { say: 'In its terminal:', code: RECONNECT } }
  }
  if (!l || l.hears !== 'oncall') return { state: 'live', sign: 'ear', since: null, word: '', short: '', line: `${n} hears you at once.`, fix: null }
  const last = l.last_call_at ?? l.since ?? null, idle = last ? Math.max(0, now - last) : null, min = idle == null ? null : minutes(idle)
  const ago = min == null ? '' : `; its last one was ${min} min ago`
  if (idle != null && idle >= ASLEEP_MS) return { state: 'asleep', sign: 'ear-later', since: last, word: `not listening · ${min} min`, short: `Not listening for ${min} min`, line: `${n} is not listening: it hears you only on its next step, and its last one was ${min} min ago.`, fix: { say: 'Wake it: type anything in its terminal. To be heard at once, start it with', code: LIVE_FLAG } }
  return { state: 'oncall', sign: 'ear-later', since: last, word: 'on its next step', short: 'Hears you on its next step', line: `${n} hears you on its next step${ago}.`, fix: { say: 'To be heard at once, start it with', code: LIVE_FLAG } }
}
/** Whether the card's session has the human's last word on it (his answer, or the hand-back): null when there is
 *  nothing to hear; else { heard: true | false | null (no receipts), waiting: ms, late }. */
export function heardOf(card, now = Date.now()) {
  const at = card.status === 'open' ? card.with_agent : card.status === 'decided' && !card.settled ? card.decided : null
  if (!at || card.pending) return null
  const heard = card.heard ?? null
  return { heard, waiting: heard ? 0 : Math.max(0, now - at), late: heard === false && now - at >= UNHEARD_MS }
}

// Cards an agent finished before the Done rows came (7 October) count as archived: only what is finished from then on
// lands on the Desk. (The demo room's cards are older: there every finished card lands.)
const DONE_SINCE = Date.UTC(2026, 9, 7, 0, 0)

// ---- model ----
// What the views show, worked out once per render from the board's state (boardState below).

/** state: the board's state. agents: the sessions as the page may see them. */
/** desk: the desk in view (its id). A desk is a world of its own: the sessions that stand on it now, and every card of
 *  theirs (a card has no desk of its own: it is where its session is, so a session that moves takes all of them
 *  along: open, with the agents, put away, its pictures). Nothing of another desk shows here; the Trommi menu's desk
 *  list says what waits there. Without desks on the hub the board is one. */
// "All desks" (his word, 7 October: "one overall desk … the existing desks are its children"): the desk id ALL_DESKS
// stands for every desk at once; nothing is stored on the hub for it, it is this browser's choice like any desk.
export const ALL_DESKS = 'all'
/** The walk (Blitz, a card's before and next): the open questions, then the Done rows. */
export const walkOf = m => [...m.fresh, ...(m.landed ?? [])]
function boardModel(state, agents = state.agents, desk = null) {
  const desks = state.desks?.length ? state.desks : null
  const all = Boolean(desks && desks.length > 1 && desk === ALL_DESKS)
  const deskId = all ? ALL_DESKS : desks ? (desks.some(d => d.id === desk) ? desk : desks[0].id) : null
  const deskOf = a => (desks ? (desks.some(d => d.id === a?.desk) ? a.desk : desks[0].id) : null)
  const everyone = agents.map(a => ({ ...a, given: a.name, name: a.label || a.name, mark: a.icon || a.id, archived: Boolean(a.archived) }))
  // The crown: one per desk, never one for all (his word, 8 October). A desk's own crown (its register desk/<id>, crown)
  // decides on that desk; a desk without one keeps the room's old single crown, if that session stands on it.
  if (desks) for (const a of everyone) { const d = desks.find(x => x.id === deskOf(a)); if (d && 'crown' in d) a.starred = Boolean(d.crown && (d.crown.session_id ? d.crown.session_id === a.session_id : d.crown.agent_device_id === a.agent_device_id && !a.parent)) }
  for (const a of everyone) a.hue = hueFor(a)
  const onDesk = a => !desks || all || deskOf(a) === deskId
  // The desk the note and the Scribble Board belong to: the one in view; on All the desk last chosen (the first if none).
  const last = (() => { try { return localStorage.getItem('trommi-desk-last') } catch { return null } })()
  const homeDesk = !desks ? null : !all ? deskId : desks.some(d => d.id === last) ? last : desks[0].id
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
  // An info (a report, a note: nothing to decide) is no question: it is read in the news strip above the Desk
  // (desk.mjs newsStrip, card Nr. "info-c"), never counted in Next, on the Desk or on a session's badge.
  const isInfo = c => c.kind === 'info'
  const allFresh = allOpen.filter(c => !c.with_agent && !isInfo(c))   // the whole board's stack, for the menu's count per desk
  const open = allOpen.filter(mine)
  const reads = open.filter(c => !c.with_agent && isInfo(c) && mine(c)).sort((a, b) => Number(isKnock(b)) - Number(isKnock(a)) || (b.created ?? 0) - (a.created ?? 0))   // knocks first, then the newest
  const fresh = open.filter(c => !c.with_agent && !isInfo(c))
  const revising = open.filter(c => c.with_agent).sort((a, b) => b.with_agent - a.with_agent)
  const now = Date.now()
  // One pass over every card (a room holds thousands): Later, the Done rows, what is answered or shredded, and per
  // session how many of his answers it has not picked up.
  const snoozed = [], landed = [], done = [], unheardOf = new Map()
  for (const c of state.cards) {
    if (!mine(c)) continue
    if (c.status === 'open' && c.snoozed_until && !shelved.has(c.agent)) snoozed.push(c)
    // Done rows: what the agents finished and he has not archived yet, the newest first (below the open questions).
    if (c.landed && !shelved.has(c.agent)) landed.push(c)
    if (c.status === 'shredded' || (c.status !== 'open' && ((c.kind === 'decision' && (c.choice != null || c.trusted)) || (c.kind === 'info' && c.read)))) done.push(c)
    if ((c.status === 'open' || c.status === 'decided') && heardOf(c, now)?.late) unheardOf.set(c.agent, (unheardOf.get(c.agent) ?? 0) + 1)
  }
  snoozed.sort((a, b) => (b.snoozed_at ?? 0) - (a.snoozed_at ?? 0))
  landed.sort((a, b) => (b.finished ?? 0) - (a.finished ?? 0))
  const at = c => (c.status === 'shredded' ? c.shredded : c.decided) ?? 0
  done.sort((a, b) => at(b) - at(a))

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
  // Each row's link, and how many of his answers its session has not picked up. A folded main shows its own, unless
  // one of its subs is cut off: that one must not hide in the fold.
  for (const u of units) {
    // (a helper runs inside its main's process: it never listens on its own, its main's link says it for both)
    u.link = u.parent ? null : linkOf(u.agent, now)
    u.unheard = unheardOf.get(u.id) ?? 0
  }
  // (what a helper's agent has not picked up is told once, on its main: the helpers' rows stay calm)
  for (const u of units) if (u.subs) { u.unheard += u.subs.reduce((n, x) => n + x.unheard, 0); for (const x of u.subs) x.unheard = 0 }
  for (const u of units) if (u.subs) {
    const all = [u, ...u.subs]
    u.whole.link = u.link
    u.whole.unheard = u.unheard
  }
  // The sessions that are cut off, once per connector (a helper's session is cut off with its main: one line says it).
  const cut = units.filter(u => u.link?.state === 'cut' && !(u.parent?.link?.state === 'cut' && u.parent.agent.agent_device_id === u.agent.agent_device_id)).map(u => ({ agent: u.agent, link: u.link }))

  return {
    state, agents: here, everyone, byAgent, byCard, open, fresh, reads, allFresh, onDesk, desk: deskId, homeDesk, all, deskOf, desks: desks ?? [], revising, snoozed, done, landed, units,
    cut, unheard: units.reduce((n, u) => n + u.unheard, 0),
    knocking: fresh.filter(isKnock).length,
    blocked: units.filter(u => u.blocked).length,
    working: units.filter(u => u.online && u.running).length,
    deskName: all ? 'All desks' : desks?.find(d => d.id === deskId)?.name || 'Desk',
    cardByRef: ref => state.cards.find(c => String(c.number) === String(ref)) ?? byCard.get(String(ref)) ?? null,
  }
}

/** Who receives a note: the crowned session of the desk. One crown per desk: the starred session. */
export const crownOf = model => (model.homeDesk ? model.everyone.find(a => a.starred && !a.archived && model.deskOf(a) === model.homeDesk) : model.agents.find(a => a.starred)) ?? null

// ---- att ----
// Attachments are end-to-end encrypted: the views render them at /att/<attachment_id> and the bytes are fetched and
// decrypted only when the browser asks for them (a picture coming into view, a click on a file). The service worker
// (public/sw.js) forwards such a request here; before it controls the page (the very first load) a picture that fails
// to load is filled in from here directly.
const refs = new Map()       // attachment_id -> the README attachment reference (with file_key), from the model
const blobs = new Map()      // attachment_id -> Promise<Blob>, kept while the page lives
let client = null
export function rememberRef(ref) { if (ref?.attachment_id && !ref.url) refs.set(ref.attachment_id, ref) }
function attachTo(c) { client = c }
/** A file of the room by its attachment_id, as its reference (with file_key): remembered, or found in the model. */
function refOfFile(c, id) {
  if (refs.has(id)) return refs.get(id)
  const m = c.model
  for (const list of [...[...m.published.values()].map(p => p.attachments), ...[...m.cards.values()].map(x => x.attachments)]) for (const a of list ?? []) if (a.attachment_id === id) return a
  return null
}
/** A Blob (or File) as an encrypted attachment of the room; pictures carry their size. Returns the README reference. */
export async function uploadFile(c, blob, { file_name, media_type, object_id }) {
  const meta = { file_name, media_type, object_id }
  if (media_type.startsWith('image/')) { try { const b = await createImageBitmap(blob); meta.width = b.width; meta.height = b.height; b.close() } catch {} }
  return c.uploadAttachment(new Uint8Array(await blob.arrayBuffer()), meta)
}
const blobOf = id => {
  if (!blobs.has(id)) {
    const ref = refs.get(id)
    if (!ref || !client) return Promise.resolve(null)
    blobs.set(id, client.attachmentBlob(ref).catch(err => { blobs.delete(id); console.warn('attachment', id, err.message); return null }))
  }
  return blobs.get(id)
}
/** The page's side of attachments (boot, once): the service worker's questions, pictures that fail before it controls. */
function watchAttachments() {
navigator.serviceWorker?.addEventListener('message', async e => {
  if (e.data?.type !== 'trommi-att') return
  const ref = refs.get(e.data.id)
  const blob = await blobOf(e.data.id)
  e.ports[0]?.postMessage(blob ? { blob, type: ref?.media_type, name: ref?.file_name } : null)
})
// Without the service worker in control: fill a picture in when it fails.
document.addEventListener('error', async e => {
  const el = e.target
  if (!(el instanceof HTMLImageElement || el instanceof HTMLMediaElement)) return
  const m = /\/att\/([0-9a-f]{32})(#.*)?$/.exec(el.getAttribute('src') ?? '')
  // (once per attachment and element: the card's stage puts another /att/ address into the same <img> on hover)
  if (!m || el.dataset.attTried === m[1]) return
  el.dataset.attTried = m[1]
  const blob = await blobOf(m[1])
  if (blob) { el.removeAttribute('srcset'); el.src = URL.createObjectURL(blob) + (m[2] ?? ''); return }
  // Gone from the hub (after 30 days, or evicted for the room's quota): said in place of the picture.
  const gone = document.createElement('span')
  gone.className = 'att-gone'
  gone.textContent = 'Attachment no longer available'
  el.replaceWith(gone)
}, true)
document.addEventListener('click', async e => {
  const a = e.target instanceof Element ? e.target.closest('a[href^="/att/"]') : null
  if (!a || navigator.serviceWorker?.controller) return
  e.preventDefault()
  const id = a.getAttribute('href').slice(5)
  const blob = await blobOf(id)
  if (blob) window.open(URL.createObjectURL(blob), '_blank', 'noopener')
  else a.replaceWith(Object.assign(document.createElement('span'), { className: 'att-gone', textContent: 'Attachment no longer available' }))
}, true)
}

// ---- board state ----
// The seam between the client core's model (shared/README) and the views: boardState(client.model) returns the board's
// state in the shape the views are written for ({ cards, queue, agents, tasks, messages, desks, notes, assets }), so the app renders the same markup.
//
// Incremental: a card's board form is kept per object_id and made again only when a change names it (or a register
// that it shows: its draft, its snooze). The messages are built on first read (only a session's page and a card's
// thread read them), from the timeline windows that are in memory plus the events every client knows from the heads
// (asked, revised, answered, read, shredded, closed).


const SESSION_ID_LEN = 12
// A session's id on the board (its address /s/<id>): the start of the agent's device id, known from the first envelope
// on and never changing. (The hub's agent_session_id is random hex and arrives later, with GET devices: it would move
// the address. A readable one, as the mock room has, is kept.)
// A session's key in the core's model: its session_id (v1.1, R6), or the agent's device id (the mock room, v1).
const sessionKey = s => s.session_id ?? s.agent_device_id
// The sessions as the board shows them: one per key (a stored copy filed under an older key is not a second session).
const sessionsOf = m => [...m.sessions].filter(([k, s]) => k === sessionKey(s)).map(([, s]) => s)
// What belongs to a session (a card, a request, a published object) names it by session_id or by its agent.
const keyOf = o => o.session_id ?? o.agent_device_id
// The versions a human reads as the question: the first, and every later one that leaves it open. A version that
// closes the card (close_card, withdraw, merge; also a second close) ends it and is no revision: the card's "Done"
// line says what became of it, so it never shows as "Question revised" or as a new "Version n".
const revisionsOf = c => (c?.versions ?? []).filter(v => v.object_version === 1 || v.object_state === 'open')
/** How the core addresses a session for a send: { session_id } (v1.1) or { agent_device_id } (the mock, v1). */
export const addressOf = (model, key) => (model.sessions.get(key)?.session_id ? { session_id: key } : { agent_device_id: key })
// The parent a session names (profile.parent_session), as core model.parentSessionOf rules: a child session an agent
// opened itself counts only under a session that agent (or the agent a human handed the child to) is assigned to; any other claim as before (display only).
function parentClaim(m, s) {
  const want = s.profile?.parent_session
  if (!want || typeof want !== 'string') return null
  if (!s.created_by_agent) return want
  const parent = m.sessions.get(want)
  return parent && parent !== s && (parent.agent_device_ids ?? []).some(a => a === s.creator_device_id || (s.agent_device_ids ?? []).includes(a)) ? want : null
}
const agentIdOf = s => (s.agent_session_id && !/^[0-9a-f]{12,}$/.test(s.agent_session_id) ? s.agent_session_id : sessionKey(s).slice(0, SESSION_ID_LEN))

export class BoardState {
  constructor(client) {
    this.client = client
    this.cardCache = new Map()       // object_id -> board card
    this.eventCache = new Map()      // object_id -> [event messages]
    // The conversations, kept across changes: one session's or one card's is made again only when a change names its
    // timeline, its cards or the session (update below); a message elsewhere leaves them as they are.
    this.msgByAgent = new Map()      // board agent id -> [messages]
    this.msgByCard = new Map()       // object_id -> [messages]
    this.filesByAgent = new Map()    // board agent id -> [messages from the agent with attachments] (the Pages pile)
    this.allMsgs = null
    this.state = null
    this.version = 0
  }
  get model() { return this.client.model }

  /** After a change of the core (or with no change: everything). Returns the new state object. */
  update(change = null) {
    const m = this.model
    if (!change) { this.cardCache.clear(); this.eventCache.clear() }
    else {
      for (const id of change.cards) { this.cardCache.delete(id); this.eventCache.delete(id) }
      for (const id of change.permissions) this.cardCache.delete(id)
      for (const key of change.registers) {
        const at = key.indexOf('/'), kind = key.slice(0, at), id = key.slice(at + 1)
        if (kind === 'draft' || kind === 'snooze' || kind === 'duck' || kind === 'archived') this.cardCache.delete(id)
        if (kind === 'session' || key === 'crown') { this.cardCache.clear(); this.eventCache.clear() }   // agent ids and names change
      }
    }
    // Agents (sessions) and their ids on the board. A card's board form names its agent: only when that naming
    // changes (a session came, went or was renamed) are all cards made again; a status line changes nothing here.
    const devToAgent = new Map(), agentToDev = new Map()
    for (const s of sessionsOf(m)) { const id = agentIdOf(s), key = sessionKey(s); devToAgent.set(key, id); agentToDev.set(id, key) }
    const naming = [...devToAgent].join()
    if (naming !== this.naming) { this.naming = naming; this.cardCache.clear(); this.eventCache.clear() }
    this.devToAgent = devToAgent; this.agentToDev = agentToDev
    this.forgetMessages(change, m, !this.eventCache.size)
    // Card numbers: the order cards (and permission requests) were first filed in, from 1. Never reused, the same on
    // every device. Sorted again only when a card or request came that was not numbered yet.
    const fresh = !change || !this.numberOf || [...change.cards, ...change.permissions].some(id => !this.numberOf.has(id)) || m.cards.size + m.permissions.size !== this.numberOf.size
    if (fresh) {
      const numbered = [...[...m.cards.values()].map(c => [c.first_envelope_number, c.object_id, 0]), ...[...m.permissions.values()].map(p => [p.envelope_number, p.object_id, 1])].sort((a, b) => a[0] - b[0])
      this.numberOf = new Map(numbered.map(([, id], i) => [id, i + 1]))
      this.order = numbered.filter(x => !x[2]).map(x => x[1])
      this.permOrder = numbered.filter(x => x[2]).map(x => x[1])
    }
    const numberOf = this.numberOf
    const all = this.order.map(id => m.cards.get(id)).filter(Boolean)
    const perms = this.permOrder.map(id => m.permissions.get(id)).filter(Boolean)
    const cards = []
    for (const c of all) { let b = this.cardCache.get(c.object_id); if (!b || b.number !== numberOf.get(c.object_id)) { b = this.boardCard(c, numberOf.get(c.object_id)); this.cardCache.set(c.object_id, b) } cards.push(b) }
    for (const p of perms) { let b = this.cardCache.get(p.object_id); if (!b) { b = this.permissionCard(p, numberOf.get(p.object_id)); this.cardCache.set(p.object_id, b) } cards.push(b) }
    this.byId = new Map(cards.map(c => [c.id, c]))
    const agents = this.agents()
    const shelved = new Set(agents.filter(a => a.archived).map(a => a.id))
    const queue = cards.filter(c => c.status === 'open' && !shelved.has(c.agent) && !c.snoozed_until).sort((a, b) => a.created - b.created || a.number - b.number).map(c => c.id)
    const tasks = []
    for (const s of sessionsOf(m)) for (const t of s.status_lines ?? []) tasks.push({ agent: devToAgent.get(sessionKey(s)), id: t.id, label: t.label, state: t.state, detail: t.detail, card_id: t.object_id ?? null, updated: t.updated_at ?? 0 })
    // (the order he dragged them into in the menu: each desk's register holds its place, order; a desk made since then
    // comes last. Never dragged: the first desk, then by age)
    const desks = [...m.human.desks].filter(([, v]) => v).map(([id, v]) => ({ id, name: String(v.name ?? '').trim() || 'Desk', created: v.created_at ?? 0, order: Number.isFinite(v.order) ? v.order : null, ...('crown' in v ? { crown: v.crown ?? null } : {}) }))
    const ordered = desks.some(d => d.order != null)
    desks.sort((a, b) => (ordered ? (a.order ?? Infinity) - (b.order ?? Infinity) || a.created - b.created : a.id === 'main' ? -1 : b.id === 'main' ? 1 : a.created - b.created))
    const notes = boardNotes(m)
    // Published objects (an agent's publish): the first attachment is the thing itself; type by its media type.
    const assetType = t => (t === 'text/html' ? 'html' : t.startsWith('image/') ? 'image' : t.startsWith('video/') ? 'video' : t.startsWith('audio/') ? 'audio' : 'file')
    const assets = [...m.published.values()].filter(p => p.object_state !== 'closed').map(p => { const a = p.attachments?.[0]; return { id: p.object_id, agent: devToAgent.get(keyOf(p)), type: assetType(String(a?.media_type ?? '')), title: p.title, note: p.note ?? '', size: a?.total_size ?? 0, att: this.att(a), envelope_number: p.envelope_number, created: p.sent_at ?? 0 } })
    const self = this
    const state = {
      cards, queue, agents, tasks, desks, notes, assets, pending: [], hub: {}, speech: false,
      get messages() { return (self.allMsgs ??= self.messages(cards)) },
      messagesOf: agent => self.messagesOf(agent),
      messagesOfCard: id => self.messagesOfCard(id),
      filesOf: agent => self.filesOf(agent),
    }
    this.state = state
    this.version++
    return state
  }

  agents() {
    // A child session its agent closed (close_session: the helper is done) goes to the archive by itself, unless a
    // question of it is still open; the human's own archive setting wins either way.
    const closedChild = s => Boolean(s.profile?.closed_at && s.profile?.parent_session && !(s.open_card_ids?.length))
    const m = this.model, crown = m.human.crown?.session_id ?? m.human.crown?.agent_device_id ?? null
    const list = sessionsOf(m).filter(s => s.is_active !== false || s.card_ids?.length)
    // When the agent process behind a session last said anything, in any of its sessions (main or child).
    const lastOfDevice = new Map()
    for (const s of list) if (s.agent_device_id) lastOfDevice.set(s.agent_device_id, Math.max(lastOfDevice.get(s.agent_device_id) ?? 0, s.last_activity_at ?? 0))
    const out = list.map((s, i) => {
      const key = sessionKey(s), set = m.human.session_settings.get(key) ?? s.settings ?? {}
      const p = s.profile ?? {}
      const id = this.devToAgent.get(key)
      // The human's choice wins; else the session's own claim, a session id (child sessions, checked by the core) or a board id.
      const claimed = parentClaim(m, s)
      const wanted = 'parent' in set ? set.parent : claimed && this.devToAgent.has(claimed) ? this.devToAgent.get(claimed) : claimed
      const parent = wanted && this.agentToDev.has(wanted) ? wanted : null
      return {
        id, device_id: key, session_id: s.session_id ?? null, agent_device_id: s.agent_device_id, name: p.agent_name || s.device_name || id, label: set.name || '', icon: set.icon || p.icon || '', icon_by: set.icon ? 'human' : 'agent',
        online: Boolean(s.is_online), offline_since: s.offline_since ?? null, model: p.model ?? '', task: p.task ?? '', client: '', host: '', starred: crown === key || crown === s.agent_device_id, parent, main: Boolean(p.is_main),
        desk: set.desk ?? null, archived: 'archived' in set ? Boolean(set.archived) : closedChild(s), group: set.group ?? null, position: set.position ?? i, seen: s.last_activity_at ?? 0, connected: s.last_activity_at ?? 0, active: s.last_activity_at ?? 0, device_active: lastOfDevice.get(s.agent_device_id) ?? 0,
        removed: s.is_active === false,
        // (a session on a person's own device, not an agent's: it is never deleted from the board: session.mjs Delete)
        own: s.agent_device_id === m.room.my_device_id || m.members.get(s.agent_device_id)?.device_role === 'human',
        link: s.link ?? null, heard_up_to: s.heard_up_to ?? null,
      }
    })
    // A sub-session stands on its main's desk, always (it has no desk of its own: a main that moves takes its subs and
    // all their cards along); a session without a desk stands on the first one.
    const byId = new Map(out.map(a => [a.id, a]))
    for (const a of out) if (!a.parent || !byId.has(a.parent)) a.desk ??= 'main'
    for (const a of out) if (a.parent && byId.has(a.parent)) a.desk = byId.get(a.parent).desk
    return out.sort((a, b) => a.position - b.position)
  }

  att(a, list = []) {
    if (!a) return null
    rememberRef(a)
    const type = String(a.media_type ?? '')
    const kind = type.startsWith('image/') ? 'image' : type.startsWith('video/') ? 'video' : type.startsWith('audio/') ? 'audio' : 'file'
    // The page a picture was made from: another attachment of the same list ('attachment:<id>') or an address.
    const p = typeof a.page === 'string' ? a.page : a.page?.url ?? null
    const own = p?.startsWith('attachment:') ? p.slice(11) : null
    const named = text => { try { return decodeURIComponent(text) } catch { return text } }
    const page = p ? { url: own ? `/att/${own}` : p, kind: own ? 'file' : 'link', name: own ? list.find(x => x.attachment_id === own)?.file_name ?? 'page.html' : named(p.split(/[?#]/)[0].replace(/\/+$/, '').split('/').pop()) || 'page' } : null
    return { name: a.file_name ?? 'file', url: a.url ?? `/att/${a.attachment_id}`, image: kind === 'image', kind, type, size: a.total_size, width: a.width, height: a.height, caption: a.caption, title: a.caption ?? a.title, page, marks: a.marks, ref: a }
  }
  /** A list of attachment references as the views want them; a page that belongs to a picture is not a file of its own. */
  atts(list) {
    if (!list?.length) return []
    for (const a of list) rememberRef(a)
    const pages = new Set(list.map(a => (typeof a.page === 'string' && a.page.startsWith('attachment:') ? a.page.slice(11) : null)).filter(Boolean))
    return list.filter(a => !pages.has(a.attachment_id)).map(a => this.att(a, list)).filter(Boolean)
  }

  boardCard(c, number) {
    const m = this.model, a = c.answer, h = m.human
    const status = c.object_state === 'open' ? 'open'
      : c.closed_how === 'shredded' ? 'shredded'
        : c.closed_how === 'answered' && c.object_state === 'answered' ? 'decided' : 'done'
    const snooze = h.snoozes.get(c.object_id)
    const draft = h.drafts.get(c.object_id)
    const atts = list => this.atts(list)
    const turns = revisionsOf(c)
    const versions = turns.slice(0, -1).map(v => ({ n: v.object_version, at: v.sent_at, title: v.content?.title ?? '', body: v.content?.body ?? '', options: v.content?.options ?? [], ...(v.content?.sections ? { sections: v.content.sections } : {}), ...(v.content?.html ? { html: v.content.html } : {}), recommended: v.content?.recommended ?? null, multiple: Boolean(v.content?.allows_multiple), attachments: atts(v.content?.attachments), urgency: v.urgency, note: v.content?.change_note ?? '' }))
    const current = turns.at(-1)
    const card = {
      id: c.object_id, object_id: c.object_id, agent: this.devToAgent.get(keyOf(c)) ?? keyOf(c).slice(0, SESSION_ID_LEN), number,
      kind: c.card_type === 'info' ? 'info' : 'decision', status, urgency: c.urgency ?? 'normal', urgency_reason: c.urgency_reason ?? '',
      title: c.title ?? '', teaser: c.teaser ?? '', body: c.body ?? '', options: c.options ?? [], attachments: atts(c.attachments), version: c.object_version ?? 1,
      multiple: Boolean(c.allows_multiple), choice: a?.choices?.[0] ?? null, choices: a?.choices ?? [], note: a?.note ?? '', summary: c.close_summary || c.withdraw_reason || '',
      created: c.created_at ?? 0, decided: a?.answered_at ?? (status === 'done' ? c.updated_at : null), recommended: c.recommended ?? null,
      version_hash: c.version_hash, content_state: c.content_state,
    }
    if (c.sections) card.sections = c.sections
    if (c.html) card.html = c.html
    if (versions.length) { card.versions = versions; card.revised = current?.sent_at ?? c.updated_at; card.revisions = versions.length; card.revision_note = c.change_note ?? '' }
    if (a) {
      card.answered_version = a.bound_object_version
      if (a.option_notes && Object.keys(a.option_notes).length) card.option_notes = a.option_notes
      if (a.marks?.length) card.marks = a.marks
      if (a.attachments?.length) card.note_attachments = atts(a.attachments)
      if (a.trusted) card.trusted = true
      if (c.closed_how === 'settled') card.settled = true   // his answer closed it: every choice was an option the agent marked final
      if (a.answer_action === 'read') card.read = a.answered_at
      if (a.answer_action === 'shred') card.shredded = a.answered_at
      if (a.pending) card.pending = true
    }
    // The receipt: whether the session's agent was handed his answer, or the message that handed the card back.
    const said = a && !a.pending && status === 'decided' ? a.envelope_number : status === 'open' ? c.in_revision?.envelope_number : null
    const mark = m.sessions.get(keyOf(c))?.heard_up_to
    if (Number.isInteger(said) && mark != null) card.heard = said <= mark
    if (c.in_revision && status === 'open') card.with_agent = this.timeOf(c.timeline_key, c.in_revision.envelope_number) ?? c.updated_at ?? Date.now()
    if (draft && status === 'open') card.draft = { keys: draft.keys ?? [], note: draft.note ?? '', notes: draft.notes ?? {}, ...(draft.marks?.length ? { marks: draft.marks } : {}), ts: draft.ts ?? 0 }
    if (snooze?.until > Date.now() && status === 'open') { card.snoozed_until = snooze.until; card.snoozed_at = snooze.at ?? 0 }
    else if (snooze?.until && status === 'open') card.unsnoozed = snooze.until   // woken by hand or by the clock: "Back from snooze"
    // Done by its agent (his word, 7 October: "when something is finished, it should still lie on the Desk"): the agent
    // closed it after his answer (close_card, with its one-line summary). It lies on the Desk as a Done row until he
    // archives it: his register archived/<object_id> (encrypted in the room like snooze/ and draft/, the same on all his
    // devices); archived_before (Archive all) archives every card finished before that time. Not a card his own answer
    // settled (a final option), not one withdrawn, merged or shredded.
    if (status === 'done' && c.closed_how === 'closed' && a && !a.pending && a.answer_action !== 'read' && a.answer_action !== 'shred') {
      card.finished = c.updated_at ?? a.answered_at ?? 0
      const archived = h.raw.get(`archived/${c.object_id}`)?.value
      if (archived) card.archived = archived.at ?? true
      else if (card.finished > (Number(h.raw.get('archived_before')?.value) || (mock ? 0 : DONE_SINCE))) card.landed = true
    }
    if (c.merged_into_object_id) card.merged_into = c.merged_into_object_id
    if (c.merged_from_object_ids?.length) card.merged_from = c.merged_from_object_ids.map(id => ({ id, number: this.numberOf?.get(id), title: m.cards.get(id)?.title ?? '' }))
    return card
  }
  permissionCard(p, number) {
    const status = p.permission_state === 'pending' && !(p.expires_at && p.expires_at < Date.now()) ? 'open' : 'done'
    return {
      id: p.object_id, object_id: p.object_id, agent: this.devToAgent.get(keyOf(p)) ?? keyOf(p).slice(0, SESSION_ID_LEN), number, kind: 'permission', status, urgency: 'critical', urgency_reason: '',
      request_id: p.object_id, title: `Approval: ${p.tool_name}`, body: `${p.description ?? ''}\n\n${p.input_preview ?? ''}`,
      options: [{ key: 'allow', label: 'Allow', detail: '' }, { key: 'deny', label: 'Deny', detail: '' }], attachments: [], version: 1, multiple: false,
      choice: p.verdict ? (p.verdict.allow ? 'allow' : 'deny') : null, choices: p.verdict ? [p.verdict.allow ? 'allow' : 'deny'] : [], note: '',
      summary: p.permission_state === 'withdrawn' ? 'Answered in the terminal' : p.permission_state === 'expired' ? 'Expired' : '', created: p.sent_at ?? 0, decided: p.verdict ? p.sent_at : null, recommended: null,
    }
  }
  /** The conversations a change touches are made again (all of them: no change, other members, a published object). */
  forgetMessages(change, m, all) {
    if (all || !change || change.members || change.published?.size) { this.msgByAgent.clear(); this.msgByCard.clear(); this.filesByAgent.clear(); this.allMsgs = null; return }
    const agentOfSession = sid => this.devToAgent.get(sid)
    const agentOfCard = id => { const c = m.cards.get(id); return c ? this.devToAgent.get(keyOf(c)) : undefined }
    const drop = agent => { if (agent === undefined) return; this.filesByAgent.delete(agent); if (this.msgByAgent.delete(agent)) this.allMsgs = null }
    for (const id of change.cards) { drop(agentOfCard(id)); this.msgByCard.delete(id) }
    for (const sid of change.sessions ?? []) drop(agentOfSession(sid))
    for (const key of change.timelines) {
      if (key.startsWith('chat:session/')) drop(agentOfSession(key.slice(13)))
      else if (key.startsWith('chat:card/')) { const id = key.slice(10); drop(agentOfCard(id)); this.msgByCard.delete(id) }
    }
  }
  timeOf(key, n) {
    const t = this.model.timelines.get(key)
    return t?.items.get(n)?.sent_at ?? null
  }

  // ---- the conversation: timeline windows + what the heads say ----
  /** Every message of the board (global; prefer messagesOf, which builds one session's only). */
  messages(cards) {
    const out = []
    for (const a of this.state.agents) out.push(...this.messagesOf(a.id))
    return out.sort((x, y) => x.seq - y.seq || x.ts - y.ts)
  }
  /** One session's conversation: its cards' events, its chat and its cards' chats (the windows in memory), in
   *  hub order. Built once per state and session. */
  messagesOf(agent) {
    const st = this.state, cached = this.msgByAgent
    if (cached.has(agent)) return cached.get(agent)
    const m = this.model, dev = this.agentToDev.get(agent)
    const humans = this.humans ??= new Set()
    humans.clear(); for (const x of m.members.values()) if (x.device_role === 'human') humans.add(x.device_id)
    const out = []
    const cardIds = m.sessions.get(dev)?.card_ids ?? st.cards.filter(c => c.agent === agent).map(c => c.id)
    for (const id of cardIds) {
      const card = this.byId.get(id) ?? null
      if (!card || card.kind === 'permission') continue
      let ev = this.eventCache.get(id)
      if (!ev) { ev = this.eventsOf(m.cards.get(id), card); this.eventCache.set(id, ev) }
      out.push(...ev)
      this.itemsOf(m.timelines.get(`chat:card/${id}`), agent, id, out)
    }
    this.itemsOf(m.timelines.get(`chat:session/${dev}`), agent, null, out)
    out.sort((x, y) => x.seq - y.seq || x.ts - y.ts)
    cached.set(agent, out)
    return out
  }
  /** What one session sent with attachments (its chat and its cards' chats), without the cards' events: the Pages pile
   *  reads it for every session, so it never makes every card's events. */
  filesOf(agent) {
    if (this.filesByAgent.has(agent)) return this.filesByAgent.get(agent)
    const m = this.model, dev = this.agentToDev.get(agent), out = []
    if (!this.humans) { this.humans = new Set(); for (const x of m.members.values()) if (x.device_role === 'human') this.humans.add(x.device_id) }
    for (const id of m.sessions.get(dev)?.card_ids ?? []) this.itemsOf(m.timelines.get(`chat:card/${id}`), agent, id, out)
    this.itemsOf(m.timelines.get(`chat:session/${dev}`), agent, null, out)
    const sent = out.filter(x => x.from === 'agent' && x.attachments?.length)
    this.filesByAgent.set(agent, sent)
    return sent
  }
  /** One card's conversation: its events and its chat window, in hub order. Built once per state and card. */
  messagesOfCard(id) {
    const cached = this.msgByCard
    if (cached.has(id)) return cached.get(id)
    const card = this.byId.get(id), out = []
    if (card && card.kind !== 'permission') {
      if (!this.humans) { this.humans = new Set(); for (const x of this.model.members.values()) if (x.device_role === 'human') this.humans.add(x.device_id) }
      let ev = this.eventCache.get(id)
      if (!ev) { ev = this.eventsOf(this.model.cards.get(id), card); this.eventCache.set(id, ev) }
      out.push(...ev)
      this.itemsOf(this.model.timelines.get(`chat:card/${id}`), card.agent, id, out)
      out.sort((x, y) => x.seq - y.seq || x.ts - y.ts)
    }
    cached.set(id, out)
    return out
  }
  itemsOf(t, agent, cardId, out) {
    if (!t?.items.size) return
    const me = this.model.room.my_device_id
    for (const i of t.items.values()) {
      const kind = i.content_type ?? 'message'
      if (kind !== 'message' && kind !== 'selection_sent') continue
      const human = i.sender_device_id === me || this.humans.has(i.sender_device_id)
      const c = i.content ?? {}
      const msg = {
        id: i.envelope_number != null ? `e${i.envelope_number}` : i.local_id, seq: i.envelope_number ?? Number.MAX_SAFE_INTEGER, agent, from: human ? 'user' : 'agent',
        text: i.item_state === 'loaded' || !i.item_state ? (c.text ?? '') : i.item_state === 'pruned' ? '(removed after 30 days)' : i.item_state === 'newer_schema' ? '(needs a newer app)' : '',
        attachments: this.atts(c.attachments), ts: i.sent_at ?? 0,
      }
      // A selection of the Scribble Board sent to the session: shown as a scribble card.
      if (kind === 'selection_sent') msg.attachments = msg.attachments.map(x => ({ ...x, kind: 'scribble' }))
      if (cardId) msg.card_id = cardId
      if (c.details) msg.details = c.details
      if (c.html) msg.html = c.html
      if (c.published_object_id) { if (this.model.published.get(c.published_object_id)?.object_state === 'closed') continue; msg.published = c.published_object_id }   // a revoked asset leaves the conversation
      // (A note of his sent to the session (content.note): it stands in the conversation as the note, taped on.)
      if (c.note) msg.note = { written: c.note.written_at ?? null }
      if (c.hand_back) msg.handback = true
      if (c.explain) msg.explain = true
      if (c.present_card) msg.present = true
      if (c.marks?.length) msg.marks = c.marks
      if (c.copied_cards?.length) msg.cards = c.copied_cards.map(id => { const b = this.cardCache.get(id); return b ? { id, number: b.number, title: b.title, agent: b.agent, choice_label: null } : { id, number: null, title: id, agent } })
      if (i.pending) msg.pending = true
      out.push(msg)
    }
  }
  eventsOf(c, card) {
    if (!c) return []
    const ev = (n, kind, text, ts, extra = {}) => ({ id: `v${n}${kind[0]}`, seq: n, agent: card.agent, from: 'event', kind, card_id: card.id, text, ts, ...extra })
    const out = []
    for (const v of revisionsOf(c)) {
      if (v.object_version === 1) out.push(ev(v.envelope_number, card.kind === 'info' ? 'info' : 'asked', v.content?.title ?? card.title, v.sent_at))
      else out.push(ev(v.envelope_number, 'revised', v.content?.change_note || v.content?.title || card.title, v.sent_at, { version: v.object_version }))
    }
    const label = keys => keys.map(k => card.options.find(o => o.key === k)?.label ?? k).join(', ')
    // What the card's talk shows of an answer (card.mjs cardThread): each choice by the name it had in the version
    // answered, what was written along, and whether it was a final option's (the card is settled by it).
    const said = a => {
      const then = (c.versions ?? []).find(v => v.object_version === a.bound_object_version)?.content?.options ?? []
      const name = k => then.find(o => o.key === k)?.label ?? label([k])
      return { labels: (a.choices ?? []).map(name), note: a.note ?? '', notes: Object.entries(a.option_notes ?? {}).filter(([, note]) => note).map(([k, note]) => [name(k), note]), files: this.atts(a.attachments), version: a.bound_object_version ?? null, ...(a.trusted ? { trusted: true } : {}), ...(a === c.answer && c.closed_how === 'settled' ? { settled: true } : {}) }
    }
    for (const a of c.answers ?? []) {
      const what = a.answer_action === 'read' ? 'read' : a.answer_action === 'shred' ? 'shredded' : 'decided'
      if (what === 'read') out.push(ev(a.envelope_number, 'read', card.title, a.answered_at))
      else if (what === 'shredded') out.push(ev(a.envelope_number, 'shredded', [card.title, a.note].filter(Boolean).join(' · '), a.answered_at, { note: a.note ?? '', files: this.atts(a.attachments) }))
      else out.push(ev(a.envelope_number, 'decided', a.trusted ? `Duck: your call${a.choices?.length ? ` · ${label(a.choices)}` : ''}` : label(a.choices ?? []), a.answered_at, said(a)))
      // (taken back: the same thing again, with the time of the taking back; an answer from before that time was kept has its own)
      if (a.taken_back_at) out.push(ev(a.taken_back_at, 'reopened', card.title, a.taken_back_sent_at ?? a.answered_at + 1, { was: what, ...(what === 'decided' ? said(a) : {}) }))
    }
    if (c.object_state === 'closed' && (c.close_summary || c.withdraw_reason)) out.push(ev((c.envelope_number ?? 0) + 0.5, 'done', c.withdraw_reason ? `Withdrawn: ${c.withdraw_reason}` : c.close_summary, c.updated_at, c.withdraw_reason ? { withdrawn: c.withdraw_reason } : {}))
    return out
  }
}

// ---- hub facade ----
// What the views' form handlers call "the hub" (hub.decide, hub.message, hub.editSession, …), done with the client
// core's human actions (shared/README).
// Every action shows at once (the core's optimistic echo) and is sealed, signed and sent by the core.


const fail = (status, message) => Object.assign(new Error(message), { status })
const STALE = 'this question was revised while you were answering; read it again and answer the version that stands now'
const SNOOZE_HOUR = 7
function nextMorning(now = Date.now()) {
  const at = new Date(now)
  at.setHours(SNOOZE_HOUR, 0, 0, 0)
  if (at.getTime() <= now) at.setDate(at.getDate() + 1)
  return at.getTime()
}

function hubFacade(client, board) {
  const m = () => client.model
  const card = id => { const c = board.state.cards.find(x => x.id === id); if (!c) throw fail(404, 'unknown card'); return c }
  const dev = agentId => board.agentToDev.get(agentId) ?? sessionKey([...m().sessions.values()].find(s => agentIdOf(s) === agentId) ?? {})
  // Files from a form (File objects) become encrypted attachments; returns the README references.
  const upload = async (files = [], object_id) => Promise.all(files.map(f => uploadFile(client, f, { file_name: f.name || 'file', media_type: f.type || 'application/octet-stream', object_id })))
  // A timeline key ('chat:session/<dev>'), or a session's board id (its chat).
  const timelineOf = ref => (String(ref).includes(':') ? ref : `chat:session/${dev(ref)}`)
  const draftOff = id => client.setDraft(id, null).catch(() => {})

  const hub = {
    state: () => board.state,
    agents: () => board.state.agents.map(a => ({ ...a, main: Boolean(a.main || board.state.agents.some(b => b.parent === a.id)) })),
    client,
    /** The next older page of a timeline into the window ("Earlier"): { loaded, has_more }. */
    loadOlder: ref => client.loadTimeline(timelineOf(ref), { limit: 50 }),
    /** Are there older items of that timeline than the window holds? */
    hasMore: ref => Boolean(m().timelines.get(timelineOf(ref))?.has_more),

    // ---- links for people outside the room (the Links page, media.mjs) ----
    // A human device shares any file of the room: the secret is drawn here, the hub keeps its hash; the link (secret
    // and file key after the #) is kept in this device's storage so Copy works again later. days: 1 to 30.
    async shareFile(attachment_id, days = 7) {
      const ref = refOfFile(client, attachment_id)
      if (!ref) throw fail(404, 'this file is not known here')
      const d = Math.min(30, Math.max(1, Math.round(Number(days) || 7)))
      return client.shareAttachment(ref, { expires_at: Date.now() + d * 86400_000 - 60_000, app_url: location.origin, keep_link: true })
    },
    stopSharing: (share_id, attachment_id) => client.revokeShare(share_id, { attachment_id }),
    /** This device's open shares: [{ share_id, attachment_id, expires_at, link }]. */
    myShares: async () => (await client.myShares?.()) ?? [],

    async decide(cardId, answer, note = '', seen, notes, files = [], marks) {
      const c = card(cardId)
      if (c.status !== 'open') throw new Error('card already decided')
      if (c.kind === 'permission') return client.verdict({ object_id: cardId, allow: [answer].flat()[0] === 'allow' })
      if (c.revised && seen !== undefined && seen !== c.revised) throw fail(409, STALE)
      const keys = [answer].flat().map(String)
      if (keys.some(k => !c.options.some(o => o.key === k))) throw fail(409, STALE)
      const choices = c.options.filter(o => keys.includes(o.key)).map(o => o.key)
      const attachments = await upload(files, cardId)
      await client.answer({ object_id: cardId, choices, note: note ?? '', option_notes: notes ?? {}, attachments, marks: marks ?? [] })
      draftOff(cardId)
    },
    async trust(cardId, note = '', seen) {
      const c = card(cardId)
      if (c.kind !== 'decision') throw new Error('only a question can be left to the agent')
      if (c.status !== 'open') throw new Error('card already decided')
      if (c.revised && seen !== undefined && seen !== c.revised) throw fail(409, STALE)
      await client.trust({ object_id: cardId, note })
      draftOff(cardId)
    },
    async closeInfo(cardId) { const c = card(cardId); if (c.kind !== 'info') throw new Error('only an info is closed by reading it'); await client.markRead({ object_id: cardId }) },
    async shred(cardId, note = '', marks, files = []) {
      const c = card(cardId)
      if (c.kind === 'permission') throw new Error('an approval cannot be thrown away: answer it with Allow or Deny')
      await client.shred({ object_id: cardId, note, marks: marks ?? [], attachments: await upload(files, cardId) })
      draftOff(cardId)
    },
    // Archive a Done row: it goes down to Off the desk (undo: back on the Desk). Archive all: every finished card.
    archive(cardId, on = true) { return client.setRegisters({ [`archived/${cardId}`]: on ? { at: Date.now() } : null }) },
    archiveAll() { return client.setRegisters({ archived_before: Date.now() }) },
    async snooze(cardId, { clear = false } = {}) {
      const c = card(cardId)
      if (c.kind === 'permission') throw new Error('an approval cannot be put off')
      await client.snooze(cardId, clear ? Date.now() : nextMorning())   // woken: a past until, so the row says "Back from snooze"
    },
    async reopen(cardId) {
      const c = card(cardId)
      if (c.status === 'open' && c.snoozed_until) return client.snooze(cardId, Date.now())
      const was = { keys: c.choices ?? [], note: c.note ?? '', notes: c.option_notes ?? {} }
      await client.decideAgain({ object_id: cardId })
      // What was taken back becomes the draft again: ticks and notes are where they were (README "decide again").
      if (c.kind === 'decision' && (was.keys.length || was.note || Object.keys(was.notes).length)) client.setDraft(cardId, { ...was, ts: Date.now() }).catch(() => {})
    },
    async takeBack(cardId) {
      const c = card(cardId)
      if (c.status !== 'open' || c.with_agent == null) throw fail(409, 'this card is not with the agent')
      await client.sendMessage({ ...addressOf(m(), dev(c.agent)), object_id: cardId, text: 'The human took the card back; no need to rework or explain it.', present_card: true })
    },
    async message({ agent, text = '', card_id, handback, explain, attachments = [], marks, cards }) {
      const key = dev(agent)
      if (!key) throw fail(404, 'unknown session')
      const files = attachments.filter(f => f instanceof Blob)
      await client.sendMessage({
        ...addressOf(m(), key), object_id: card_id ?? undefined, text,
        ...(handback ? { hand_back: true } : {}), ...(explain ? { explain: true } : {}),
        ...(files.length ? { attachments: await upload(files, card_id) } : {}),
        ...(marks?.length ? { marks } : {}), ...(cards?.length ? { copied_cards: cards } : {}),
      })
    },
    setDraft(cardId, { keys = [], note = '', notes = {}, marks } = {}) {
      const c = card(cardId)
      if (c.kind !== 'decision' || c.status !== 'open') return
      const empty = !keys.length && !String(note).trim() && !Object.keys(notes).length && !(marks?.length)
      const same = d => JSON.stringify([d?.keys ?? [], d?.note ?? '', d?.notes ?? {}, d?.marks ?? []])
      if (same(empty ? null : { keys, note, notes, marks }) === same(c.draft)) return
      return client.setDraft(cardId, empty ? null : { keys, note, notes, ...(marks?.length ? { marks } : {}), ts: Date.now() })
    },
    // A session's settings (the human's register session/<agent_device_id>): name, icon, desk, archived, group, order.
    async editSession(body) {
      const agents = board.state.agents
      const a = agents.find(x => x.id === body.agent)
      if (!a) throw fail(404, 'unknown session')
      const setOf = x => ({ ...(m().human.session_settings.get(x.device_id) ?? {}) })
      const writes = {}
      const put = (x, fields) => { writes[`session/${x.device_id}`] = { ...(writes[`session/${x.device_id}`] ?? setOf(x)), ...fields } }
      if ('label' in body) put(a, { name: String(body.label ?? '').slice(0, 60) })
      if ('icon' in body) put(a, { icon: body.icon || null })
      if ('archived' in body) { if (body.archived && a.online && !body.deleting) throw fail(409, 'this session is connected; it can be archived once it is away'); put(a, { archived: Boolean(body.archived) }) }
      if ('group' in body) put(a, { group: body.group ? String(body.group).slice(0, 40) : null })
      if ('desk' in body) put(a, { desk: body.desk })
      if ('parent' in body) put(a, { parent: body.parent ?? null })
      if ('before' in body) {
        const order = agents.filter(x => x.id !== a.id)
        const at = body.before == null ? order.length : Math.max(0, order.findIndex(x => x.id === body.before))
        order.splice(at < 0 ? order.length : at, 0, a)
        order.forEach((x, i) => { if (x.position !== i) put(x, { position: i }) })
      }
      if (Object.keys(writes).length) await client.setRegisters(writes)
    },
    async starSession({ agent, starred }) {
      const a = board.state.agents.find(x => x.id === agent)
      if (!a) throw fail(404, 'unknown session')
      const crown = starred ? { session_id: a.session_id ?? undefined, agent_device_id: a.agent_device_id } : null
      // (one crown per desk: it lies in the register of the session's desk; without desks the room's single crown)
      const desks = board.state.desks ?? [], deskId = desks.some(d => d.id === a.desk) ? a.desk : desks[0]?.id
      if (!deskId) return client.setCrown(crown)
      await client.setDesk(deskId, { ...(m().human.desks.get(deskId) ?? { name: desks.find(d => d.id === deskId)?.name ?? 'Desk', created_at: Date.now() }), crown })
    },
    // Desks: the human register desk/<id>.
    async desk({ id, name, remove, order }) {
      if (remove) { await client.setDesk(id, null); return { ok: true } }
      // A new order (the menu's rows dragged): every desk's place, in one write, so his devices all see the same list.
      if (Array.isArray(order)) {
        const have = m().human.desks, ids = order.map(String).filter(x => have.get(x))
        if (!ids.length) throw fail(400, 'no such desks')
        await client.setRegisters(Object.fromEntries(ids.map((x, i) => [`desk/${x}`, { ...have.get(x), order: i }])))
        return { ok: true, order: ids }
      }
      if (id) { await client.setDesk(id, { ...(m().human.desks.get(id) ?? {}), name }); return { ok: true, desk: { id, name } } }
      const made = [...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, '0')).join('')
      if (!m().human.desks.size) await client.setDesk('main', { name: 'Desk', created_at: Date.now() - 1 })
      await client.setDesk(made, { name: String(name ?? '').trim().slice(0, 40) || 'Desk', created_at: Date.now() })
      return { ok: true, desk: { id: made, name } }
    },
    // Notes (objects of type note; POST /note): noteStore in notes.mjs. Returns { code, text }.
    note: noteStore(client, board),
  }
  return hub
}

// ---- turbo ----
// A small stand-in for the part of Hotwire Turbo the board's controllers and views rely on: the <turbo-stream>
// element (actions append, prepend, before, after, replace, update, remove, refresh, with the
// turbo:before-stream-render event and its detail.render hook), renderStreamMessage, and visit(). The pages are not
// fetched: the router (public/app.mjs) renders them in the page. window.Turbo is set for code that asks it.

let visitor = null
/** The router registers how a visit is made (path, { action }). */
function setVisitor(fn) { visitor = fn }
function visit(location, options = {}) { return visitor?.(String(location), options) }


/** The elements (boot, once). <turbo-frame> is a plain element with its id; navigation inside it is the router's. */
function defineTurbo() {
  customElements.define('turbo-stream', class extends HTMLElement {
  get action() { return this.getAttribute('action') }
  get target() { return this.getAttribute('target') }
  get templateElement() { return this.querySelector('template') }
  get templateContent() { return this.templateElement?.content.cloneNode(true) ?? document.createDocumentFragment() }
  get targetElements() { const t = this.target ? document.getElementById(this.target) : null; return t ? [t] : [] }
  async connectedCallback() {
    if (this.started) return
    this.started = true
    const render = el => perform(el)
    const event = new CustomEvent('turbo:before-stream-render', { bubbles: true, cancelable: true, detail: { newStream: this, render } })
    if (this.dispatchEvent(event)) { try { await event.detail.render(this) } catch (err) { console.error('turbo-stream', err) } }
    this.remove()
  }
  })
  customElements.define('turbo-frame', class extends HTMLElement {})
  window.Turbo = { visit, renderStreamMessage, session: { drive: true } }
}

async function perform(stream) {
  const action = stream.action, target = stream.targetElements[0]
  if (action === 'refresh') return refresher?.()
  if (action === 'visit') return visit(stream.getAttribute('target') || '/', { action: 'replace' })   // (a form's answer that leads on: the page it names)
  if (!target) return
  const content = () => stream.templateContent
  switch (action) {
    case 'remove': {
      // A Desk row that leaves goes in one continuous motion (his word, 4 October: "smooth, nicht springen"): it slides
      // and fades while its place closes, so the rows below glide up at the same time; several leave staggered.
      if (target.matches('.inbox-row')) { flipOut([target]); break }
      target.remove(); break
    }
    case 'replace': target.replaceWith(content()); break
    case 'update': target.replaceChildren(content()); break
    case 'append': { const c = content(); dedupe(target, c); target.append(c); break }
    case 'prepend': { const c = content(); dedupe(target, c); target.prepend(c); break }
    case 'before': target.before(content()); break
    case 'after': target.after(content()); break
  }
}
let leaving = 0
/** Desk rows leave without a jump and without work per frame (his word, 4 October: "ruckelt"): measured once, each row
 *  is taken out of the layout at once (its section with it when it was the last), a fixed copy slides and fades where
 *  it stood, and what stood below is moved back by the gap and glides up: only transform and opacity animate.
 *  ghost: false when the caller flies its own copies (the pull-down of Later). Reduced motion: gone at once. */
export function flipOut(rows, { ghost = true } = {}) {
  rows = rows.filter(r => r?.isConnected)
  if (!rows.length) return []
  const boxes = [...new Set(rows.map(boxOf))]
  // (where each stood, so a row whose answer failed can come back: putBack)
  const places = boxes.map(box => ({ box, parent: box.parentElement, next: box.nextSibling }))
  if (calm()) { for (const b of boxes) b.remove(); return places }
  const list = rows[0].closest('#desk-list') ?? rows[0].parentElement
  // What may move: the rows after a leaving row in its own section, then the list's own children after it, in order;
  // only what stands in sight (and a little below) is measured: a row far below has nothing to show, and measuring it
  // would make the browser lay out and render it (rows out of sight are content-visibility: auto).
  const moving = []
  const seen = new Set(boxes)
  for (const box of boxes) {
    const after = []
    if (box.matches('.inbox-row')) for (let n = box.nextElementSibling; n; n = n.nextElementSibling) after.push(n)
    const top = box.matches('.inbox-row') ? box.parentElement : box
    if (top?.parentElement === list) for (let n = top.nextElementSibling; n; n = n.nextElementSibling) after.push(n)
    for (const el of after) if (!seen.has(el)) { seen.add(el); moving.push(el) }
  }
  const limit = (document.documentElement.clientHeight || innerHeight) + 120
  // (one read pass, no second one: an element below moves up by the room of every leaving box above it, a box's
  //  height and the gap after it; reading positions again after the removal would lay the page out once more)
  const gapOf = el => parseFloat(getComputedStyle(el.parentElement ?? el).rowGap) || 0
  const room = boxes.map(b => ({ b, h: b.getBoundingClientRect().height + gapOf(b) }))
  const before = new Map()
  for (const el of moving) {
    const t = el.getBoundingClientRect().top
    if (t > limit) break
    const up = room.reduce((sum, { b, h }) => sum + (b.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING && !b.contains(el) ? h : 0), 0)
    before.set(el, up)
  }
  const n0 = leaving
  leaving += rows.length
  setTimeout(() => { leaving = Math.max(0, leaving - rows.length) }, 450)
  if (ghost) rows.forEach((row, i) => {
    const r = row.getBoundingClientRect(), copy = row.cloneNode(true)
    copy.removeAttribute('id'); copy.classList.add('is-ghost'); copy.inert = true
    Object.assign(copy.style, { position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, margin: 0, zIndex: 40, pointerEvents: 'none', contain: 'layout paint style' })
    document.body.append(copy)
    copy.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(28px)' }], { duration: 220, delay: (n0 + i) * 45, easing: 'cubic-bezier(.2, .7, .3, 1)', fill: 'forwards' }).finished.then(() => copy.remove(), () => copy.remove())
  })
  // (two frames: in this one the copy flies and the row is hidden; in the next the row leaves the layout and what stood
  //  below glides up, so the list's new layout is not paid for in the frame of the tap)
  for (const b of boxes) b.style.visibility = 'hidden'
  requestAnimationFrame(() => requestAnimationFrame(() => {
    for (const b of boxes) { b.remove(); b.style.visibility = '' }
    for (const [el, d] of before) {
      if (Math.abs(d) < 1 || !el.isConnected) continue
      el.style.willChange = 'transform'
      el.animate([{ transform: `translateY(${d}px)` }, { transform: 'none' }], { duration: 250, delay: n0 * 45, easing: 'cubic-bezier(.3, .6, .3, 1)' }).finished.finally(() => { el.style.willChange = '' })
    }
  }))
  return places
}
/** Rows whose answer did not go through stand where they stood again. */
function putBack(places) {
  for (const { box, parent, next } of places) if (!box.isConnected && parent?.isConnected) parent.insertBefore(box, next?.parentNode === parent ? next : null)
}
/** A row alone in its section takes the section with it. */
function boxOf(row) {
  const sec = row.parentElement
  return sec?.matches('.inbox-group') && ![...sec.children].some(c => c !== row && c.matches('.inbox-row')) ? sec : row
}
// As Turbo does: an appended element whose id stands in the target already replaces it.
function dedupe(target, fragment) {
  for (const el of fragment.children) if (el.id) target.querySelector(`#${CSS.escape(el.id)}`)?.remove()
}


let refresher = null
function setRefresher(fn) { refresher = fn }

/** Applies stream actions given as markup (<turbo-stream action target><template>…</template></turbo-stream>…). */
export function renderStreamMessage(text) {
  if (!text) return
  const t = document.createElement('template')
  t.innerHTML = String(text)
  const host = document.getElementById('stream-host') ?? document.body
  for (const el of [...t.content.querySelectorAll('turbo-stream')]) host.append(document.importNode(el, true))
}


// ---- board ----
// The board's pages, forms and live pieces, in the page.
// The view modules register themselves (register(t) with t.get, t.post, t.live), so the
// markup is the same; a "request" here is a navigation or a form of this page, answered from the local model.
//
//   const board = createBoard({ hub, model })   hub: hub-facade.mjs; model(): app.mjs boardModel of now
//   await board.request({ method, path, form, headers })  -> { kind: 'page' | 'stream' | 'redirect' | 'html' | 'none', … }
//   board.live(clients)                          after a change: the stream actions per open page (only what changed)

// The toast after a card's action (and the way back it offers).
export const SAID = {
  decide: { head: 'Answered', back: 'reopen' }, trust: { head: WORDS.trust, back: 'reopen' }, close: { head: 'Read', back: 'reopen' },
  shred: { head: 'Shredded', back: 'reopen' }, snooze: { head: WORDS.later, back: 'wake' }, revise: { head: 'Handed back', back: 'takeback' }, message: { head: 'Message sent' }, what: { head: `Asked: ${WORDS.what}`, back: 'takeback' },
  archive: { head: 'Archived', back: 'unarchive' }, unarchive: { head: 'Back on the Desk' },
}
export const BASE = ''
const STREAM = 'text/vnd.turbo-stream.html'
export const stream = (action, target, content = '') => html`<turbo-stream action="${action}"${target ? html` target="${target}"` : ''}>${action === 'remove' || action === 'refresh' || action === 'visit' ? '' : html`<template>${content}</template>`}</turbo-stream>`
const sig = text => String(text).replace(/(data-ts="\d+">)[^<]*</g, '$1<').replace(/asked [^"]*"/g, '"')

function createBoard({ hub, model, views }) {
  // ---- answers: a response object the router reads ----
  const response = () => ({
    kind: 'none', code: 200, body: '', opts: null, to: null,
    writeHead(code, headers = {}) { this.code = code; if (headers.Location) { this.kind = 'redirect'; this.to = headers.Location } },
    end(body = '') { if (this.kind === 'none' && body) { this.kind = 'html'; this.body = String(body) } },
  })
  const redirect = (res, to) => { res.kind = 'redirect'; res.to = to; res.code = 303 }
  const notFoundMain = what => html`<main id="inbox" aria-label="Not found"><header class="inbox-head"><div class="inbox-title"><h2>${what}</h2><p><a href="${BASE}/" data-nav>Back to the Desk</a></p></div></header></main>`

  function says(card, what) {
    const said = SAID[what]
    if (!card || !said) return ''
    const picked = card.choices?.length ? card.options.filter(o => card.choices.includes(o.key)).map(o => o.label).join(', ') : ''
    const line = what === 'decide' && picked ? `${card.title} → ${picked}` : card.title
    return toast({ head: what === 'decide' && card.settled ? 'Settled' : said.head, line, undo: said.back ? { action: `${BASE}/cards/${card.id}/${said.back}` } : null })
  }
  const saidOf = req => { const [id, what] = String(new URL(req.url, 'http://x').searchParams.get('said') ?? '').split(':'); return id && what ? says(model().byCard.get(id), what) : '' }

  // ---- the toolkit the page modules get ----
  const gets = [], posts = [], lives = new Map()
  const t = {
    BASE, hub, stream, says, redirect,
    toast: opts => stream('prepend', 'says-host', toast(opts)),
    model,
    get(pattern, handler) { gets.push({ pattern, handler }) },
    post(pattern, handler) { posts.push({ pattern, handler }) },
    live(view, { take, diff }) { lives.set(view, { take, diff, snap: null }) },
    page(req, res, opts, code = 200) { res.kind = 'page'; res.code = code; res.opts = { model: opts.model ?? model(), ...opts, says: opts.says ?? saidOf(req) } },
    sendStream: (req, res, body, code = 200) => { res.kind = 'stream'; res.code = code; res.body = String(body) },
    wantsStream: req => String(req.headers.accept ?? '').includes(STREAM),
    redirect, notFound: (req, res, what) => t.page(req, res, { title: 'Not found · Trommi', view: 'missing', stream: null, main: notFoundMain(what) }, 404),
    differs: (a, b) => sig(a) !== sig(b),
  }

  // Every view hooks itself in: its pages, forms and live pieces (and what it wires on the page once).
  for (const view of views) view.register?.(t)
  // A lazy view hooks itself in when it arrives (asked for by an address, or loaded while the page was idle).
  for (const [name, v] of Object.entries(LAZY)) { if (loaded[name]) loaded[name].register?.(t); v.onLoad = m => m.register?.(t) }

  /** One request of this page: a navigation (GET) or a form (POST). */
  async function request({ method = 'GET', path, form = null, headers = {} }) {
    const url = new URL(path, location.origin)
    const req = { method, url: url.pathname + url.search, headers, form }
    const res = response()
    const p = url.pathname
    for (const [name, v] of Object.entries(LAZY)) if (!loaded[name] && v.paths.test(p)) await view(name)
    const list = method === 'GET' ? gets : posts
    for (const { pattern, handler } of list) {
      const match = pattern.exec(p)
      if (!match) continue
      if ((await handler({ req, res, url, match, form })) !== false) return res
    }
    res.kind = 'missing'
    return res
  }

  /** The open page's live pieces: call with the page's client ({ view, params }) once after it was rendered
   *  (snapshot), then after every change (returns the stream actions to apply). */
  function live(client, { reset = false } = {}) {
    const m = model()
    const views = [client.view, '*', ...(client.params.get('bar') === '1' ? [''] : [])]
    let out = ''
    for (const view of views) {
      const l = lives.get(view)
      if (!l) continue
      try {
        const now = l.take(m, [client])
        if (!reset && l.snap) out += l.diff(l.snap, now, client, m)
        l.snap = now
      } catch (err) { console.error(`live (${view})`, err) }
    }
    for (const [view, l] of lives) if (!views.includes(view)) l.snap = null
    return out
  }
  return { request, live, says, t }
}

// ---- layout ----
// The frame around every view: the floating Desk with the Trommi menu, the sidebar, the place for toasts, the key
// sheet, the notes. A port of trommi-hub app.mjs: the same markup, without the hub's <head>, the
// import map and the live stream (the router keeps the head and patches the body).

// The pages whose sheet has the turned corner: the Desk and a session's page. padFrom: the one the board was turned from (its corner turns back there).
const FRONT = new Set(['desk', 'session'])
let padFrom = '/'
let padKept = false   // the Scribble Board stays mounted under the Desk (set when the corner is first touched, or coming from the board)
const padCanvas = html => /data-whiteboard-canvas-value="([^"]*)"/.exec(html)?.[1] ?? null
/** The body's parts for a page: [{ key, html }] in order (the router keeps a part whose markup did not change). */
function bodyParts({ view, model, base = '', main, sidebar = true, current = null, says = '', stream = '', title = '' }) {
  const parts = []
  if (sidebar) {
    if (model) parts.push({ key: 'phonebar', html: String(phoneBar(model, base, { view, current, title })) })
    parts.push({ key: 'topbar', html: String(topbar(model, base, view === 'desk')) })
    parts.push({ key: 'agents', html: String(html`<nav id="agents" aria-label="Sessions" data-controller="folds">${sidebarRows(model, base, current)}</nav>`) })
    parts.push({ key: 'foot', html: String(SIDE_FOOT) })
    parts.push({ key: 'veil', html: String(DRAWER_VEIL) })
    if (model) parts.push({ key: 'note', html: String(cornerNote(model, base)) })
  }
  // The Desk and the Scribble Board are two sides of one sheet (ui.mjs, controller "curl"): the board is a part of
  // its own ("pad"), which the Desk keeps under its sheet once its corner was touched (padKept), so turning the
  // page mounts nothing anew; the corner itself is the part "curl".
  if (view === 'whiteboard') parts.push({ key: 'pad', html: String(main) })
  else parts.push({ key: 'main', html: String(main) })
  if (FRONT.has(view) && padKept && model && loaded.whiteboard) parts.push({ key: 'pad', html: String(loaded.whiteboard.whiteboardMain(model)) })
  if (FRONT.has(view) || view === 'whiteboard') parts.push({ key: 'curl', html: String(curlHTML(FRONT.has(view) ? 'desk' : 'pad', FRONT.has(view) ? `${base}/scribble-board` : `${base}${padFrom}`)) })
  if (mock) parts.push({ key: 'demo', html: '<span class="demo-band">Demo · <a href="/screens?mock=1" target="_blank" rel="noopener" title="Every screen of the app in the demo, for review">All screens</a> · <a href="/?mock=0" data-turbo="false" title="Leave the demo: back to your desks">leave</a></span>' })
  parts.push({ key: 'says', html: `<div class="says-host says-page" id="says-host" data-turbo-permanent>${says}</div>` })
  parts.push({ key: 'sheets', html: String(html`${keySheet()}${view === 'desk' ? rowSheet(base) : ''}`) })
  return parts
}

// ---- router ----
// Navigation, forms, frames and live updates of the app (what Turbo Drive, Frames and the stream did for the hub's
// pages, done in the page):
//   - a link of the app (same origin) renders its page from the local model: no request leaves the device;
//   - the page's body is patched by parts (topbar, sidebar, main, …): a part whose markup did not change stays;
//   - a form is answered by the board's handlers (public/app.mjs): stream actions, a redirect, or a page;
//   - after every change of the core only the elements that changed are replaced (board.live → <turbo-stream>);
//   - fetch() calls of the controllers to the hub's old JSON routes (/note, /desk, a card's draft) are answered here.

const STREAM_ACCEPT = 'text/vnd.turbo-stream.html, text/html, application/xhtml+xml'
const fire = (target, name, detail = {}, cancelable = false) => { const e = new CustomEvent(name, { bubbles: true, cancelable, detail }); target.dispatchEvent(e); return e }
const isAppPath = p => !/\.(?:css|js|mjs|json|png|svg|jpe?g|webp|gif|woff2?|webmanifest|html|txt|csv|log|ico)$/i.test(p) && !p.startsWith('/demo/') && !p.startsWith('/gen/') && !p.startsWith('/att/')

function createRouter({ board, onPage = () => {}, beforeVisit = () => {}, flush = () => {} }) {
  let page = null          // { path, client: { view, params }, opts }
  const parts = new Map()  // key -> { html, nodes: [Node] }

  // ---- painting a page ----
  // Each part stands between two comments (<!--p:key--> … <!--/p:key-->), so what a stream put in its place
  // still belongs to it.
  const between = part => { const out = []; for (let n = part.start; n; n = n.nextSibling) { out.push(n); if (n === part.end) break } return out }
  function paintBody(list) {
    const body = document.body
    const keep = new Set(list.map(p => p.key))
    for (const [key, part] of parts) if (!keep.has(key)) { for (const n of between(part)) n.remove(); parts.delete(key) }
    let anchor = body.firstChild
    for (const { key, html } of list) {
      let part = parts.get(key)
      if (part && key === 'says') {
        // Toasts stay across pages (data-turbo-permanent); one the new page brings (?said=…) joins them on top.
        const t = document.createElement('template')
        t.innerHTML = html
        const fresh = t.content.firstElementChild, host = document.getElementById('says-host')
        if (fresh?.childNodes.length && host) host.prepend(...fresh.childNodes)
      }
      if (part && key === 'pad' && part.html !== html && padCanvas(part.html0) === padCanvas(html)) {
        // The same drawing: the mounted pad stays; only its list of sessions is brought up to date.
        const t = document.createElement('template')
        t.innerHTML = html
        const fresh = t.content.querySelector('#whiteboard-sessions')
        if (fresh) document.getElementById('whiteboard-sessions')?.replaceWith(fresh)
        part.html = html
      }
      if (part && (key === 'says' || part.html === html)) {
        // Kept (toasts always stay across pages, like data-turbo-permanent): moved into place if needed.
        if (part.start !== anchor) for (const n of between(part)) body.insertBefore(n, anchor)
        anchor = part.end.nextSibling
        continue
      }
      const t = document.createElement('template')
      t.innerHTML = html
      const start = document.createComment(`p:${key}`), end = document.createComment(`/p:${key}`)
      if (part) { anchor = part.end.nextSibling; for (const n of between(part)) n.remove() }
      if (anchor && !anchor.isConnected) anchor = null
      body.insertBefore(start, anchor)
      body.insertBefore(t.content, anchor)
      body.insertBefore(end, anchor)
      parts.set(key, { html, html0: html, start, end })
      anchor = end.nextSibling
    }
  }
  // A part a stream changed no longer holds the markup it was painted with.
  const forget = streams => {
    for (const [, id] of String(streams).matchAll(/<turbo-stream action="[a-z]+" target="([^"]+)"/g)) {
      const el = document.getElementById(id)
      if (!el) continue
      for (const part of parts.values()) if (part.html != null && between(part).some(n => n === el || n.contains?.(el))) part.html = null
    }
  }
  function paint(path, opts, { scroll = 'top' } = {}) {
    fire(document, 'turbo:before-cache')
    document.title = opts.title ?? 'Trommi'
    const body = document.body
    body.dataset.view = 'chat'
    body.dataset.scope = opts.scope ?? 'all'
    body.dataset.tView = opts.view
    body.dataset.tBase = ''
    for (const a of [...body.attributes]) if (a.name.startsWith('data-') && !['data-view', 'data-scope', 'data-t-view', 'data-t-base'].includes(a.name)) body.removeAttribute(a.name)
    for (const [, name, value] of String(opts.bodyAttrs ?? '').matchAll(/([\w-]+)="([^"]*)"/g)) body.setAttribute(name, value)
    if (FRONT.has(opts.view)) padFrom = path
    padKept = opts.view === 'whiteboard' || (FRONT.has(opts.view) && padKept)
    paintBody(bodyParts({ ...opts, base: '' }))
    const params = new URLSearchParams(`view=${opts.view}${opts.sidebar === false ? '' : '&bar=1'}${opts.stream ?? ''}`)
    page = { path, client: { view: opts.view, params }, opts }
    board.live(page.client, { reset: true })
    if (scroll === 'top') window.scrollTo(0, 0)
    else if (typeof scroll === 'number') requestAnimationFrame(() => window.scrollTo(0, scroll))
    // As Turbo does: the first [autofocus] element of the new page gets the keyboard.
    const auto = document.querySelector('main [autofocus], [autofocus]')
    if (auto && !auto.closest('[hidden], dialog:not([open])')) auto.focus({ preventScroll: true })
    fire(document, 'turbo:render')
    fire(document, 'turbo:load', { url: location.href })
    onPage(page)
  }

  // ---- visiting ----
  let visiting = 0
  async function visit(path, { action = 'advance', scroll } = {}) {
    const url = new URL(path, location.href)
    if (url.origin !== location.origin) { location.href = url.href; return }
    const to = url.pathname + url.search + url.hash
    if (action !== 'restore' && fire(document, 'turbo:before-visit', { url: url.href }, true).defaultPrevented) return
    const mine = ++visiting
    flush()   // what an action just changed is in the state before the page is rendered
    beforeVisit(url)
    const tq = performance.now()
    const res = await board.request({ method: 'GET', path: url.pathname + url.search, headers: { accept: 'text/html' } })
    const tr = performance.now()
    if (mine !== visiting) return
    if (res.kind === 'redirect') return visit(res.to, { action: action === 'restore' ? 'replace' : action === 'advance' ? 'replace-after' : action })
    if (action === 'advance') { saveScroll(); history.pushState({ trommi: true, scroll: 0 }, '', to) }
    else if (action === 'replace' || action === 'replace-after') { if (action === 'replace-after') saveScroll(); history[action === 'replace-after' ? 'pushState' : 'replaceState']({ trommi: true, scroll: 0 }, '', to) }
    if (res.kind === 'page') paint(to, res.opts, { scroll: scroll ?? (action === 'restore' ? history.state?.scroll ?? 0 : 'top') })
    else paint(to, { title: 'Not found · Trommi', view: 'missing', main: '<main id="inbox" aria-label="Not found"><header class="inbox-head"><div class="inbox-title"><h2>Not here.</h2><p><a href="/" data-nav>Back to the Desk</a></p></div></header></main>', model: board.t.model() })
    if (url.hash) document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView({ block: 'center' })
    if (window.trommi) window.trommi.lastVisit = { render: tr - tq, paint: performance.now() - tr }
  }
  const saveScroll = () => { try { history.replaceState({ ...(history.state ?? {}), trommi: true, scroll: window.scrollY }, '') } catch {} }
  /** The page in view, rendered again from the model (a stream's "refresh", or after the room changed under it). */
  async function refresh() {
    if (!page) return
    const res = await board.request({ method: 'GET', path: page.path, headers: { accept: 'text/html' } })
    if (res.kind === 'page') { const y = window.scrollY; paint(page.path, res.opts, { scroll: y }) }
    else if (res.kind === 'redirect') visit(res.to, { action: 'replace' })
  }
  setVisitor((path, opts) => visit(path, { action: opts.action === 'replace' ? 'replace' : 'advance' }))
  setRefresher(refresh)
  addEventListener('popstate', () => visit(location.pathname + location.search + location.hash, { action: 'restore' }))
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual'

  // ---- frames ----
  async function frameVisit(frame, path) {
    const res = await board.request({ method: 'GET', path, headers: { accept: 'text/html', 'turbo-frame': frame.id } })
    let markup = ''
    if (res.kind === 'html') markup = res.body
    else if (res.kind === 'page') markup = bodyParts({ ...res.opts, base: '' }).map(p => p.html).join('')
    else if (res.kind === 'redirect') return visit(res.to)
    const t = document.createElement('template')
    t.innerHTML = markup
    const fresh = t.content.querySelector(`turbo-frame#${globalThis.CSS.escape(frame.id)}`)
    if (!fresh) return visit(path)
    frame.replaceChildren(...fresh.childNodes)
    fire(frame, 'turbo:frame-load')
  }
  const frameOf = (el, url) => {
    const name = el.getAttribute('data-turbo-frame') ?? el.closest('form')?.getAttribute('data-turbo-frame')
    if (name === '_top') return null
    if (name) return document.getElementById(name)
    const frame = el.closest('turbo-frame')
    if (!frame || frame.getAttribute('target') === '_top') return null
    return frame
  }

  // ---- links ----
  document.addEventListener('click', e => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const a = e.target instanceof Element ? e.target.closest('a[href]') : null
    if (!a || a.target && a.target !== '_self' || a.hasAttribute('download') || a.getAttribute('data-turbo') === 'false' || a.closest('[data-turbo="false"]')) return
    const url = new URL(a.href, location.href)
    if (url.origin !== location.origin || !isAppPath(url.pathname)) return
    if (url.pathname === location.pathname && url.search === location.search && url.hash) return   // a jump within the page
    e.preventDefault()
    const frame = frameOf(a, url)
    if (frame) {
      // A frame link with data-turbo-action also moves the address (a picture switched in place: ?pic=n survives a reload).
      const promote = a.getAttribute('data-turbo-action')
      return frameVisit(frame, url.pathname + url.search).then(() => { if (promote) { saveScroll(); history[promote === 'advance' ? 'pushState' : 'replaceState']({ trommi: true, scroll: window.scrollY }, '', url.pathname + url.search); if (page) page.path = url.pathname + url.search } })
    }
    visit(url.pathname + url.search + url.hash, { action: a.getAttribute('data-turbo-action') === 'replace' ? 'replace' : 'advance' })
  })

  // ---- forms ----
  async function submitForm(form, submitter) {
    const method = (submitter?.getAttribute('formmethod') ?? form.getAttribute('method') ?? 'get').toLowerCase()
    const action = new URL(submitter?.getAttribute('formaction') ?? form.getAttribute('action') ?? location.pathname, location.href)
    const data = new FormData(form, submitter ?? undefined)
    if (method === 'get') {
      const q = new URLSearchParams()
      for (const [k, v] of data) if (typeof v === 'string') q.append(k, v)
      const path = `${action.pathname}?${q}`
      const frame = frameOf(form, action)
      return frame ? frameVisit(frame, path) : visit(path)
    }
    const formSubmission = { formElement: form, submitter, method, location: action }
    fire(form, 'turbo:submit-start', { formSubmission })
    // A Desk row that is answered (or put off, thrown away, asked about) moves at once: the motion starts in this frame,
    // the answer's work (core, re-render) comes when the motion is done (his word, 4 October: start on the tap). If it
    // does not go through, the row comes back with what went wrong.
    const row = form.closest?.('#desk-list .inbox-row[data-id]')
    const leaves = row && form.hasAttribute('data-turbo-frame') === false && /\/(decide|trust|close|what|shred|snooze|revise)$/.test(action.pathname)
    const chosenRows = form.id === 'sel-bar' && data.get('way') !== 'later' ? String(data.get('ids') ?? '').split(',').filter(Boolean).map(id => document.getElementById(`row-${id}`)).filter(Boolean) : []
    const gone = leaves ? flipOut([row]) : chosenRows.length ? flipOut(chosenRows) : null
    if (gone?.length) await new Promise(r => setTimeout(r, calm() ? 0 : 260 + (chosenRows.length > 1 ? (chosenRows.length - 1) * 45 : 0)))
    let res, error = null
    try { res = await board.request({ method: 'POST', path: action.pathname + action.search, form: data, headers: { accept: STREAM_ACCEPT, referer: location.href } }) }
    catch (err) { error = err; console.error('form', err) }
    const success = !error && res && res.code < 400
    flush()
    if (gone?.length && (!success || (res?.kind === 'stream' && [row, ...chosenRows].some(r => r?.id && res.body.includes(`action="replace" target="${r.id}"`))))) putBack(gone)
    if (res?.kind === 'stream') { forget(res.body); renderStreamMessage(res.body) }
    else if (res?.kind === 'redirect') await visit(res.to)
    else if (res?.kind === 'page') { history.replaceState({ trommi: true }, '', location.href); paint(location.pathname + location.search, res.opts, { scroll: window.scrollY }) }
    fire(form.isConnected ? form : document, 'turbo:submit-end', { formSubmission, success, fetchResponse: res ? { response: { status: res.code } } : null, error })
  }
  document.addEventListener('submit', e => {
    if (e.defaultPrevented) return
    const form = e.target
    if (!(form instanceof HTMLFormElement) || (form.method === 'dialog') || form.getAttribute('data-turbo') === 'false') return
    const action = new URL(form.getAttribute('action') ?? location.pathname, location.href)
    if (action.origin !== location.origin) return
    e.preventDefault()
    submitForm(form, e.submitter)
  })

  // ---- the controllers' fetch() to the hub's routes ----
  const realFetch = window.fetch.bind(window)
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href)
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    if (url.origin !== location.origin || method !== 'POST' || !isAppPath(url.pathname)) return realFetch(input, init)
    if (url.pathname === '/note' || url.pathname === '/desk') {
      const body = JSON.parse(String(init.body ?? '{}'))
      const out = url.pathname === '/note' ? await board.t.hub.note(body) : await board.t.hub.desk(body).then(d => ({ code: 200, text: JSON.stringify(d) }), err => ({ code: err.status ?? 400, text: JSON.stringify({ error: err.message }) }))
      return new Response(out.text, { status: out.code, headers: { 'Content-Type': 'application/json' } })
    }
    let form
    if (init.body instanceof FormData) form = init.body
    else { form = new FormData(); for (const [k, v] of new URLSearchParams(typeof init.body === 'string' || init.body instanceof URLSearchParams ? init.body : '')) form.append(k, v) }
    const res = await board.request({ method: 'POST', path: url.pathname + url.search, form, headers: { accept: String(new Headers(init.headers ?? {}).get('accept') ?? STREAM_ACCEPT) } })
    if (res.kind === 'missing') return new Response('not found', { status: 404 })
    return new Response(res.code === 204 ? null : res.body ?? '', { status: res.code, headers: { 'Content-Type': res.kind === 'stream' ? 'text/vnd.turbo-stream.html' : 'text/html' } })
  }

  /** After the core changed: the elements of this page that changed (nothing else is touched). */
  function changed() {
    if (!page) return
    const streams = board.live(page.client)
    if (streams) { forget(streams); renderStreamMessage(streams) }
  }
  /** The Scribble Board under the Desk's sheet, from now on (the corner was touched): mounted once, kept. */
  async function keepPad() {
    if (padKept || !FRONT.has(page?.opts.view)) return
    await view('whiteboard')
    if (padKept || !FRONT.has(page?.opts.view)) return
    padKept = true
    paintBody(bodyParts({ ...page.opts, base: '' }))
  }
  /** A page's main markup, rendered from the model without going there (the Desk under the Scribble Board's corner). */
  async function peek(path) {
    const res = await board.request({ method: 'GET', path, headers: { accept: 'text/html' } })
    return res.kind === 'page' ? String(res.opts.main) : ''
  }
  return { visit, refresh, changed, get page() { return page }, paint, keepPad, peek }
}

// ---- push ----
// "Push on this device": the menu's bell (#push-toggle). On: asks for the permission (only a click may), subscribes
// with the hub's VAPID key and hands the subscription to the hub through the core. The hub pushes only
// { room_id, envelope_number, urgency }; the service worker shows a short line (public/sw.js).
const bytes = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0))
const apple = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const installed = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches
const obstacle = () => {
  if (!window.isSecureContext) return 'Push needs the app at its https address.'
  if (apple() && !installed()) return 'On the iPhone, add the app to the Home Screen first and open it from there.'
  if (!('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window)) return 'This browser has no push.'
  if (Notification.permission === 'denied') return 'Notifications are blocked for the app (browser settings).'
  return ''
}
const subscription = async () => (await navigator.serviceWorker?.getRegistration('/'))?.pushManager.getSubscription() ?? null

function startPush(client) {
  const wire = async () => {
    const toggle = document.getElementById('push-toggle')
    if (!toggle || toggle.dataset.push) return
    toggle.dataset.push = '1'
    toggle.classList.add('push-row')
    if (!toggle.querySelector('.menu-word')) toggle.append(Object.assign(document.createElement('span'), { className: 'menu-word', textContent: 'Push on this device' }))
    const note = Object.assign(document.createElement('p'), { className: 'push-note', role: 'status' })
    toggle.after(note)
    const paint = sub => { toggle.setAttribute('aria-checked', String(Boolean(sub))); toggle.title = `Push on this device: ${sub ? 'on' : 'off'}` }
    paint(await subscription().catch(() => null))
    toggle.addEventListener('click', async e => {
      e.stopPropagation()
      if (toggle.getAttribute('aria-busy') === 'true') return
      toggle.setAttribute('aria-busy', 'true')
      note.textContent = ''
      try {
        const had = await subscription()
        if (had) {
          await client.pushSubscribe(had.toJSON(), true).catch(() => {})
          await had.unsubscribe()
          paint(null)
        } else {
          if (!client.hub?.pushKey) throw new Error('The demo has no push.')
          const why = obstacle()
          if (why) throw new Error(why)
          if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications were not allowed.')
          const reg = await navigator.serviceWorker.register('/sw.js')
          await navigator.serviceWorker.ready
          const { vapid_public_key } = await client.hub.pushKey()
          const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(vapid_public_key) })
          await client.pushSubscribe(sub.toJSON())
          paint(sub)
        }
      } catch (err) { note.textContent = err.message }
      toggle.removeAttribute('aria-busy')
    })
  }
  document.addEventListener('turbo:load', wire)
  document.addEventListener('turbo:render', wire)
  wire()
}

// ---- pwa ----
// The app installed on a phone (area "Phone layout"):
//   1. The status bar has the colour of the top bar, light or dark as the board's own theme switch says
//      (<meta name="theme-color"> follows html[data-theme]; the manifest can only name one colour).
//   2. A new version takes over at once: sw.js skips waiting and claims the page, which reloads (a field with unsent
//      words: a quiet line offers "Reload" instead). An installed app stays open for days, so it asks for a new sw.js
//      whenever it comes back to the front (at most every 30 minutes).
/** The phone's status bar and new versions (boot, once). */
function watchPwa() {
const meta = document.querySelector('meta[name="theme-color"]')
function paintBar() {
  if (!meta) return
  const bar = document.querySelector('.topbar') ?? document.body
  const colour = bar && getComputedStyle(bar).backgroundColor
  if (colour && colour !== 'rgba(0, 0, 0, 0)') meta.setAttribute('content', colour)
}
new MutationObserver(() => requestAnimationFrame(paintBar)).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-ready'] })
requestAnimationFrame(paintBar)

const sw = navigator.serviceWorker
if (sw) {
  const CHECK_MS = 30 * 60e3
  let checked = Date.now(), stale = false
  const hadController = Boolean(sw.controller)   // the first install also "takes over": that is no new version
  const unsent = () => [...document.querySelectorAll('textarea, input[type="text"], input:not([type])')].some(f => f.value.trim() && !f.closest('[hidden]'))
  function offer() {
    if (document.querySelector('.app-update')) return
    const box = document.createElement('div')
    box.className = 'app-update'
    box.setAttribute('role', 'status')
    const go = document.createElement('button')
    go.type = 'button'
    go.textContent = 'Reload'
    go.addEventListener('click', () => location.reload())
    box.append('A new version is ready.', go)
    document.body.append(box)
  }
  // A new version took over: the page reloads at once, unless a field holds unsent words (then a quiet line offers
  // it, and it reloads by itself once the app is in the background with nothing unsent).
  sw.addEventListener('controllerchange', () => { if (!hadController) return; stale = true; if (unsent()) offer(); else location.reload() })
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') { if (stale && !unsent()) location.reload(); return }
    if (Date.now() - checked < CHECK_MS) return
    checked = Date.now()
    try { await (await sw.getRegistration())?.update() } catch {}
  })
}
}

// ---- boot ----
// The app's start: open the room from this device's storage (or the mock room with ?mock=1), paint the page in view
// from the local model at once, then start the core (sign in, catch up, live stream) and patch what changes.
// No room on this device: the room screens (found a room, join with a link). See README "Architecture".

let T0 = 0, OPEN_MS = null, mock = null
const read = (k, f = null) => { try { return localStorage.getItem(k) ?? f } catch { return f } }
const write = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v) } catch {} }


async function openClient() {
  if (mock) return (await import('./demo/demo.mjs')).openRoom({ mock })
  const c = await core()
  const storage = c.idbStorage({ name: 'trommi', prefix: 'room/' })
  // Several tabs of this browser: one writes (a Web Lock), the others read on their own and hand it their actions
  // (core/tabs.mjs). Every tab stays usable; when the writing tab closes, the next one takes over.
  try { return await c.openRoomInTabs({ storage, makeStorage: () => c.idbStorage({ name: 'trommi', prefix: 'room/' }), client: CLIENT }) }
  catch (err) { await storage.close().catch(() => {}); throw err }   // a Log out from the error screen deletes the database
}

async function start(client, { fresh = false } = {}) {
  attachTo(client)
  // The hub says this app is too old (426, or upgrade_required on the stream): a calm notice, reload takes the new build.
  client.on('error', err => { if (err?.code === 'client-too-old') notice('Please reload: this app needs a newer version.', err.message, true) })
  const board = new BoardState(client)
  board.update()
  let desk = read('trommi-desk')
  const hub = hubFacade(client, board)
  let cached = null
  const model = (d = desk) => {
    if (pending && !wasCatchingUp) { update(); frame ||= requestAnimationFrame(() => apply()) }
    if (cached?.version === board.version && cached.desk === d) return cached.m
    const m = boardModel(board.state, hub.agents(), d ?? (board.state.desks?.length > 1 ? ALL_DESKS : null))
    board.desk = m.desk
    cached = { version: board.version, desk: d, m }
    return m
  }
  // The menu's "switch desk" (/?desk=<id>) and /desk/<id>: the desk is this browser's; the address is the Desk's again.
  const desks = { register: t => {
    t.get(/^\/$/, ({ res, url }) => { const d = url.searchParams.get('desk'); if (d == null) return false; desk = d; write('trommi-desk', d); if (d !== ALL_DESKS) write('trommi-desk-last', d); t.redirect(res, '/') })
    t.get(/^\/desk\/([\w-]+)$/, ({ res, match }) => { desk = match[1]; write('trommi-desk', desk); t.redirect(res, '/') })
  } }
  // (the demo only: the review page of all screens, and ?state= hooks: demo/demo.mjs)
  const demo = mock ? await import('./demo/demo.mjs') : null
  if (demo) { demo.screensController({ Controller, controller }); const state = new URLSearchParams(location.search).get('state'); if (state) document.addEventListener('turbo:load', () => demo.demoState(state), { once: true }) }
  const b = createBoard({ hub, model, views: [desks, ...(demo ? [demo.screensView] : []), ...VIEWS] })
  const router = createRouter({ board: b, flush: () => apply() })
  startPush(client)
  window.trommi = { client, board, router, model, mock: Boolean(mock), view }   // (view: a lazy view's module, for the dev tools)

  // Changes come in batches; one frame patches the page for all that came meanwhile. A navigation or the end of a
  // form takes what is pending at once (flush), so a page never renders a state older than the action that led to it.
  let pending = null, frame = 0
  const merge = (a, c) => { for (const k of Object.keys(c)) { if (c[k] instanceof Set) for (const v of c[k]) a[k].add(v); else a[k] = a[k] || c[k] } return a }
  const conn = () => {
    const state = client.model.room.connection, el = document.getElementById('conn'), text = document.getElementById('conn-text')
    const words = { live: ['online', 'Connected'], catching_up: ['connecting', 'Catching up'], connecting: ['connecting', 'Connecting'], offline: ['offline', 'No connection'] }[state] ?? ['connecting', 'Connecting']
    if (el) el.dataset.state = words[0]
    if (text) text.textContent = words[1]
    // The hub refused one of this device's envelopes without voiding it: sending stops until it goes through (the core
    // retries the same bytes every minute). Said once, calmly; gone when sending runs again.
    const blocked = client.model.room.outbox_blocked
    const said = document.querySelector('.room-notice[data-why="blocked"]')
    if (blocked && !said) notice('Sending is paused: the hub refused a message. Trommi tries again every minute.', `${blocked.code}: ${blocked.message}`, false, 'blocked')
    else if (!blocked && said) said.remove()
  }
  // update: the board state takes the pending change (at once, wherever the state is read: model() does it, so an
  // action's own answer never reads the state from before it). patch: the open page gets its streams; that waits for
  // the frame, so many changes cost one patch.
  let unpatched = false
  const update = () => {
    if (!pending) return
    const c = pending; pending = null
    const t = performance.now()
    board.update(c)
    unpatched = true
    window.trommi.lastUpdateMs = performance.now() - t
  }
  const apply = () => {
    cancelAnimationFrame(frame); frame = 0
    update()
    if (!unpatched) return
    unpatched = false
    const t = performance.now()
    router.changed()
    conn()
    window.trommi.lastPatchMs = performance.now() - t + (window.trommi.lastUpdateMs ?? 0)
  }
  // While the core catches up (a new device: thousands of envelopes in batches) the page is not patched per batch:
  // it is rendered whole every CATCH_UP_MS and once more when the room is live. Patching per batch made a big room's
  // first load quadratic (every batch re-diffed the Desk and re-measured its rows).
  const CATCH_UP_MS = 2500
  let catchUpTimer = 0, wasCatchingUp = false
  const catchingUp = () => client.model.room.connection === 'catching_up'
  const renderWhole = () => {
    catchUpTimer = 0
    cancelAnimationFrame(frame); frame = 0
    pending = null; unpatched = false
    board.update()
    router.refresh()
    conn()
  }
  // A device answered one of this device's invite links and waits for its check code (a new device, or a connector
  // that continues a session): said on whatever page he is on, with the way to the six emoji to compare. The confirm itself is on
  // the invite's page (auth.mjs); without this it showed only while that page stayed open.
  const codeAsked = new Set()
  const askCodes = ids => {
    for (const id of ids ?? []) {
      const inv = client.model.invites.get(id)
      // (a link whose time is up asks nothing any more: its note goes, and none comes)
      if (inv?.invite_state !== 'confirm_code' || inv.expires_at <= Date.now()) { if (inv && inv.invite_state !== 'open') document.getElementById(`code-ask-${id}`)?.remove(); continue }
      if (codeAsked.has(id)) continue
      codeAsked.add(id)
      if (location.pathname === `/pair/${id}`) continue
      const host = document.getElementById('says-host')
      if (!host) { codeAsked.delete(id); continue }
      const who = inv.takeover ? model().everyone?.find(a => a.device_id === inv.session_id) : null
      const head = inv.takeover ? `A connector wants to continue ${who?.label || who?.given || who?.name || 'a session'}` : inv.device_role === 'agent' ? 'An agent wants to join' : 'A device wants to join'
      host.insertAdjacentHTML('afterbegin', String(toast({ head, line: 'Compare the six emoji.', link: { href: `/pair/${id}`, label: 'Confirm' }, role: 'alert', ms: Math.min(5 * 60_000, Math.max(1000, inv.expires_at - Date.now())) })))
      host.firstElementChild.id = `code-ask-${id}`
    }
  }
  document.addEventListener('turbo:load', () => askCodes(client.model.invites.keys()), { once: true })
  client.on('change', change => {
    askCodes(change.invites)
    if (!pending) pending = merge({ cards: new Set(), sessions: new Set(), permissions: new Set(), notes: new Set(), published: new Set(), timelines: new Set(), registers: new Set(), invites: new Set() }, change)
    else merge(pending, change)
    if (catchingUp()) { if (!wasCatchingUp) { wasCatchingUp = true; conn() } catchUpTimer ||= setTimeout(renderWhole, CATCH_UP_MS); return }
    if (wasCatchingUp) { wasCatchingUp = false; clearTimeout(catchUpTimer); renderWhole(); return }
    frame ||= requestAnimationFrame(() => apply())
  })
  document.addEventListener('turbo:load', conn)
  // The timeline of the page in view is fetched when it is opened (newest page first; "Earlier" loads more).
  // The card page's thread is fetched when it is opened (newest page first; "Earlier comments" loads more). A session's
  // page loads its own (session.mjs, before its first render). The Desk's Working stack says each card's last
  // word: the newest few items of the cards with their session.
  const opened = new Set()
  const load = (key, limit) => { if (opened.has(key)) return; opened.add(key); client.loadTimeline(key, { limit }).catch(err => console.warn('timeline', err)) }
  const loadOpen = () => {
    const path = location.pathname
    const q = /^\/(?:s\/[^/]+\/)?card\/([\w-]+)/.exec(path)
    if (q) { const card = model().cardByRef(decodeURIComponent(q[1])); if (card) load(`chat:card/${card.id}`, 50) }
    if (path === '/') for (const c of model().revising ?? []) load(`chat:card/${c.id}`, 5)
  }
  document.addEventListener('turbo:load', loadOpen)

  await router.visit(location.pathname + location.search + location.hash, { action: 'replace' })
  window.trommi.firstPaintMs = performance.now() - T0
  window.trommi.openMs = OPEN_MS
  window.trommi.readyAt = performance.now()   // since navigation start: cold or warm load to the painted page
  document.documentElement.dataset.ready = ''
  // The other views, once the page is idle: the next navigation (a card, a session, the board) finds them in memory.
  const idle = globalThis.requestIdleCallback ?? (f => setTimeout(f, 300))
  idle(() => { for (const name of Object.keys(LAZY)) view(name).catch(err => console.warn('view', name, err)) }, { timeout: 3000 })
  // This tab became the writing tab (the one before it closed): the core is a new client from storage. Draw it whole
  // and fetch the open page's timeline again (the old client's windows went with it).
  client.on('reset', () => {
    pending = null; wasCatchingUp = false; clearTimeout(catchUpTimer)
    renderWhole()
    opened.clear(); loadOpen()
  })
  client.start().catch(err => { console.error('start', err); conn() })
  if (fresh) router.refresh()
  return router
}

/** The page starts here (index.html loads this module; importing it elsewhere, as the connector's tests do, does nothing). */
async function boot() {
  T0 = performance.now()
  // The service worker: the app shell offline, attachments decrypted on demand, push (public/sw.js). Not on the dev
  // server (dev/serve.mjs, the preview: html[data-build="dev"]): there a worker installed before is taken away.
  if (document.documentElement.dataset.build === 'dev') navigator.serviceWorker?.getRegistrations().then(list => list.forEach(r => r.unregister())).catch(() => {})
  else if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(err => console.warn('service worker', err.message))
  startUi()
  defineTurbo()
  watchAttachments()
  watchPwa()
  // The demo room: ?mock=1 (the fixture); remembered for this tab; ?mock=0 ends it.
  const params = new URLSearchParams(location.search)
  if (params.has('mock')) { if (params.get('mock') === '0') sessionStorage.removeItem('trommi-mock'); else sessionStorage.setItem('trommi-mock', params.get('mock') || '1') }
  mock = sessionStorage.getItem('trommi-mock')
  // (the switch is in the tab now: the address goes back to plain, so a reload or a saved link does not decide it again)
  if (params.has('mock')) { params.delete('mock'); history.replaceState(history.state, '', `${location.pathname}${params.size ? `?${params}` : ''}${location.hash}`) }
  document.documentElement.classList.toggle('is-demo', Boolean(mock))
  // A link for someone outside the room (/a/<share_id>#…): its own small page, no room needed.
  if (/^\/a\/[0-9a-f]{32}$/.test(location.pathname)) return (await view('media')).showShare()
  // A room that is stored but does not open is never shown as "not logged in": the start page would offer Log in, which
  // this storage refuses (it holds a room). The room screen says what failed and offers Retry and Log out of this device.
  let openError = null
  const client = await openClient().catch(err => { console.error('open', err); openError = err; return null })
  OPEN_MS = performance.now() - T0   // the room from storage (or the demo's fixture) in memory
  if (client) { keepStorage(); await start(client) }
  else await (await view('auth')).roomScreen({ start: async (c, o) => { keepStorage(); return start(await adopt(c), o) }, hub: hubUrl(), openError })
}
if (typeof window !== 'undefined') boot()

/** A room made in this tab (account created, device joined or logged in): this tab writes it; later tabs follow. */
async function adopt(c) {
  if (mock) return c
  const k = await core()
  return k.adoptInTabs(c, { makeStorage: () => k.idbStorage({ name: 'trommi', prefix: 'room/' }), client: CLIENT })
}

/** Ask the browser to keep this origin's storage (no eviction under storage pressure; Safari weighs it too). */
function keepStorage() { try { navigator.storage?.persist?.().catch(() => {}) } catch {} }

/** A calm full-width line at the foot (styled by auth.css), with "Reload". update: fetch the new build first. */
function notice(text, detail, update, why = '') {
  if (document.querySelector('.room-notice')) return
  const box = document.createElement('div')
  box.className = 'room-notice'
  if (why) box.dataset.why = why
  box.setAttribute('role', 'status')
  const words = document.createElement('span')
  words.textContent = text
  if (detail) words.title = detail
  const go = document.createElement('button')
  go.type = 'button'
  go.className = 'room-notice-go'
  go.textContent = 'Reload'
  go.addEventListener('click', async () => {
    go.disabled = true
    if (update) { try { const reg = await navigator.serviceWorker?.getRegistration(); await reg?.update() } catch {} }
    location.reload()
  })
  box.append(words, go)
  document.body.append(box)
}
