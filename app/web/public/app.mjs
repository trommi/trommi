// The app: its start (boot), the room in the page (the core's model as the views' board state, the actions as the
// views' "hub"), the board (pages, forms, live pieces: every view registers its own), the router, the frame around a
// page, the service worker's side (attachments, push, new versions). Importing it does nothing; index.html's import
// starts it (boot, at the end).
import * as desk from './desk.mjs'
import * as sidebar from './sidebar.mjs'
import * as notes from './notes.mjs'
import { DRAWER_VEIL, SIDE_FOOT, cornerNote, markCurrent, phoneBar, sidebarRows, tabBar, topbar } from './sidebar.mjs'
import { Controller, WORDS, calm, readAttachmentsWith, controller, copyLater, curlHTML, html, hueFor, isKnock, keySheet, raw, showToast, sk, startUi, toast, sayError } from './ui.mjs'
import { boardNotes, noteStore } from './notes.mjs'
import { movedPath } from './paths.mjs'
import { rowSheet } from './desk.mjs'
// The views a cold start needs (the Desk, its frame, the notes) come with this module; every other view is loaded
// when an address of it is first asked for (LAZY: the addresses it answers), and all of them once the page is idle,
// so a later navigation finds them in memory.
const VIEWS = [desk, sidebar, notes]
/** "MLS proof" (proof.mjs): a page of Settings, and a screen of its own on a device without a room (boot). */
const PROOF_PATH = /^\/settings\/proof$/
const LAZY = {
  auth: { load: () => import('./auth.mjs'), paths: /^\/(?:settings(?:\/(?:devices|account|theme|keys|kit|password))?|devices\/|pair|logout|join|login)(?:\/|$)/ },
  agents: { load: () => import('./agents.mjs'), paths: /^\/(?:settings\/(?:sessions|agents)$|sessions\/)/ },
  card: { load: () => import('./card.mjs'), paths: /^(?:\/chat\/[^/]+)?\/card\/|^\/cards\/[0-9a-f]+\// },
  session: { load: () => import('./session.mjs'), paths: /^\/chat\// },
  media: { load: () => import('./media.mjs'), paths: /^\/artifacts(?:\/|$)/ },
  whiteboard: { load: () => import('./whiteboard.mjs'), paths: /^\/scribble-board$/ },
  proof: { load: () => import('./proof.mjs'), paths: PROOF_PATH },
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
/** What stands where something of a newer Trommi version would be (codec UPDATE_MESSAGE, in the app's words). */
export const NEEDS_NEWER = 'This needs a newer version of Trommi. Reload to update.'
export const CLIENT = `app/${APP_VERSION}`

// The client core (gen/vendor, built from app/web/core by dev/build.mjs): every view gets crypto, keys and
// the account through these, never on its own.
// (joining with a link runs in the core worker: account-remote.mjs)
export const core = () => Promise.all([import('./gen/vendor/index.mjs'), import('./gen/vendor/account-remote.mjs')]).then(([m, r]) => ({ ...m, joinRoom: r.joinRoom }))
// The check code as emoji (core/check-emoji.ts, the same function the connector prints with): loaded at once, beside
// the core (which imports it too, so a room's client never exists before it); a live binding, [] until it is there.
// Not a static import: app.mjs is also imported in Node (tests), where gen/ is not built.
export let checkEmoji = () => []
import('./gen/vendor/check-emoji.mjs').then(m => { checkEmoji = m.checkEmoji }, () => {})
// A turn's trail folded into one block (core/work.ts): a small pure part of the core, needed while a conversation
// is drawn. Loaded the same way; boot() waits for it, so no conversation is drawn before it is there. Without it (Node)
// a trail's envelopes are left out.
let work = null
const workLoaded = import('./gen/vendor/work.mjs').then(m => { work = m }, () => {})
// The account screens' slow parts (the key derivation, founding and joining) run in the core worker (core/account-remote.ts).
export const account = () => import('./gen/vendor/account-remote.mjs')
export const scribbleWire = () => import('./gen/vendor/scribble.mjs')
// A QR reader for browsers without their own (core/qr-decode.mjs): loaded by the account screens' "Scan a code" only.
export const qrReader = () => import('./gen/vendor/qr-decode.mjs')

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
// When a session is really stopped: the raised red hand. It is about a SESSION, not a card, and it
// can stand without any card. (A card that is urgent knocks; that is the knock, ui.mjs isKnock.)
//
// A session is blocked when
//   - it is disconnected while a status line of its says "working" (for longer than a blip: OFFLINE_GRACE_MS),
//   - it is cut off (linkOf below): its Claude Code runs and its Trommi tools are gone, working line or not,
//   - it reported an error (agent.error, set through /agent/profile; a later call of the session clears it),
//   - it waits for him: an open approval request, or an open card it marked as blocking (urgency critical),
// Being quiet is NOT a stop: a connected session with a working line that said nothing for
// QUIET_MS only gets a grey hint, quietOf() ("quiet for 24 min"): no red hand, no push, not in the Desk's badge.
// For a child session (agent.parent) "it" is the agent process behind it: a helper whose main agent is online and
// still talking (agent.device_active) is not quiet.
// Shared by the views and the board model below.

/** Nothing from a working, connected session for this long: a quiet grey hint on the session, nothing more. */
const QUIET_MS = 15 * 60000
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
// handed the human's words to the agent (card.heard). The five states are the core's (core/model.ts linkState, the
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

// ---- model ----
// What the views show, worked out once per render from the board's state (boardState below).

/** state: the board's state. agents: the sessions as the page may see them. */
/** desk: the desk in view (its id). A desk is a world of its own: the sessions that stand on it now, and every card of
 *  theirs (a card has no desk of its own: it is where its session is, so a session that moves takes all of them
 *  along: open, with the agents, put away, its pictures). Nothing of another desk shows here; the Trommi menu's desk
 *  list says what waits there. Without desks on the hub the board is one. */
// "All desks": the desk id ALL_DESKS stands for every desk at once (the single desks are its children); nothing is
// stored on the hub for it, it is this browser's choice like any desk.
const ALL_DESKS = 'all'
/** The walk (Blitz, a card's before and next): every open card that waits for him, the questions first, then what
 *  is only to read, card by card. Not what is with an agent. */
export const walkOf = m => (m.walk ??= [...m.fresh, ...(m.reads ?? [])])
function boardModel(state, agents = state.agents, desk = null) {
  const desks = state.desks?.length ? state.desks : null
  const all = Boolean(desks && desks.length > 1 && desk === ALL_DESKS)
  const deskId = all ? ALL_DESKS : desks ? (desks.some(d => d.id === desk) ? desk : desks[0].id) : null
  const deskOf = a => (desks ? (desks.some(d => d.id === a?.desk) ? a.desk : desks[0].id) : null)
  const everyone = agents.map(a => ({ ...a, given: a.name, name: a.label || a.name, mark: a.icon || a.id, archived: Boolean(a.archived) }))
  // The crown: one per desk, never one for all. A desk's own crown (its register desk/<id>, crown)
  // decides on that desk; a desk without one keeps the room's single crown, if that session stands on it.
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
  // (the board state's own map, kept up to date per card; by number only when a card is looked up by it)
  const byCard = state.byId ?? cardsMemo(state.cards, 'byCard', () => new Map(state.cards.map(c => [c.id, c])))
  const byNumber = () => cardsMemo(state.cards, 'byNumber', () => new Map(state.cards.map(c => [String(c.number), c])))
  const shelved = new Set(everyone.filter(a => a.archived).map(a => a.id))

  // The stack, in the hub's fixed order (oldest first). A card that is with its session (handed back, asked
  // to explain) is open but not waiting on the human: it lies on "Later" until it returns.
  const mine = c => onDesk(byAgent.get(c.agent))
  const allOpen = state.queue.map(id => byCard.get(id)).filter(Boolean)
  // An info (a report, a note: nothing to decide) is no question: it is read in the news strip above the Desk
  // (desk.mjs newsStrip), never counted in Next, on the Desk or on a session's badge.
  const isInfo = c => c.kind === 'info'
  const allFresh = allOpen.filter(c => !c.with_agent && !isInfo(c))   // the whole board's stack, for the menu's count per desk
  const open = allOpen.filter(mine)
  const reads = open.filter(c => !c.with_agent && isInfo(c) && mine(c)).sort((a, b) => Number(isKnock(b)) - Number(isKnock(a)) || (b.created ?? 0) - (a.created ?? 0))   // knocks first, then the newest
  const fresh = open.filter(c => !c.with_agent && !isInfo(c))
  const revising = open.filter(c => c.with_agent).sort((a, b) => b.with_agent - a.with_agent)
  const now = Date.now()
  // One pass over every card (a room holds thousands): Later, the Done rows, what is answered or shredded, and per
  // session how many of his answers it has not picked up.
  // (kept while no card changed and the sessions stand where they stood: cardsMemo; only "not picked up", which
  //  depends on the clock, is counted again, over the few cards whose session has not heard of his answer)
  const where = `${deskId} ${[...shelved]} ${everyone.map(a => `${a.id}:${deskOf(a)}`)}`
  const { snoozed, unheard } = cardsMemo(state.cards, `board ${where}`, () => {
    const snoozed = [], unheard = []
    for (const c of state.cards) {
      if (c.status === 'open' && c.snoozed_until && !shelved.has(c.agent) && mine(c)) snoozed.push(c)
      if ((c.status === 'open' || c.status === 'decided') && c.heard === false && mine(c)) unheard.push(c)
    }
    snoozed.sort((a, b) => (b.snoozed_at ?? 0) - (a.snoozed_at ?? 0))
    return { snoozed, unheard }
  })
  const { done } = closedMemo(state, `board ${where}`, () => {
    const done = []
    for (const c of state.cards) {
      if (c.status === 'open' || !mine(c)) continue
      if (c.status === 'shredded' || ((c.kind === 'decision' && (c.choice != null || c.trusted)) || (c.kind === 'info' && c.read))) done.push(c)
    }
    const at = c => (c.status === 'shredded' ? c.shredded : c.decided) ?? 0
    done.sort((a, b) => at(b) - at(a))
    return { done }
  })
  const unheardOf = new Map()
  for (const c of unheard) if (heardOf(c, now)?.late) unheardOf.set(c.agent, (unheardOf.get(c.agent) ?? 0) + 1)

  // Per session: what waits on the human, whether it works, whether one of its questions knocks.
  // (once: the open questions and the working status lines by session; a unit then reads only its own)
  const freshBy = new Map(), workingBy = new Set()
  for (const c of fresh) { const l = freshBy.get(c.agent); if (l) l.push(c); else freshBy.set(c.agent, [c]) }
  for (const t of state.tasks) if (t.state === 'working') workingBy.add(t.agent)
  const summary = ids => {
    const mine = [...ids].flatMap(id => freshBy.get(id) ?? [])
    const of = everyone.filter(a => ids.has(a.id))
    const online = of.some(a => a.online)
    const running = of.some(a => a.online && workingBy.has(a.id))
    // stuck: one of its questions knocks (urgent card). blocked: the session itself is stopped (blockedOf above), { why, text }.
    const blocked = of.map(a => blockedOf(a, state, now)).find(Boolean) ?? null
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
    u.whole.link = u.link
    u.whole.unheard = u.unheard
  }
  // The sessions that are cut off, once per connector (a helper's session is cut off with its main: one line says it).
  const cut = units.filter(u => u.link?.state === 'cut' && !(u.parent?.link?.state === 'cut' && u.parent.agent.agent_device_id === u.agent.agent_device_id)).map(u => ({ agent: u.agent, link: u.link }))

  return {
    state, agents: here, everyone, byAgent, byCard, open, fresh, reads, allFresh, onDesk, desk: deskId, homeDesk, all, deskOf, desks: desks ?? [], revising, snoozed, done, units,
    cut, unheard: units.reduce((n, u) => n + u.unheard, 0),
    knocking: fresh.filter(isKnock).length,
    blocked: units.filter(u => u.blocked).length,
    working: units.filter(u => u.online && u.running).length,
    deskName: all ? 'All desks' : desks?.find(d => d.id === deskId)?.name || 'Personal',
    // (the desk's goals, desk.mjs deskGoals: none on All desks)
    goals: all ? '' : desks?.find(d => d.id === deskId)?.goals ?? '',
    cardByRef: ref => byNumber().get(String(ref)) ?? byCard.get(String(ref)) ?? null,
  }
}

/** A desk's goals as they are kept: at most GOALS_LINES lines of at most GOALS_LINE_MAX characters, no blank lines at
 *  either end, no trailing spaces. The Desk shows the first GOALS_SHOWN and folds the rest (desk.mjs deskGoals). */
export const GOALS_LINES = 20, GOALS_LINE_MAX = 200, GOALS_SHOWN = 5
export const cleanGoals = text => String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/\s+$/, '').slice(0, GOALS_LINE_MAX)).join('\n').replace(/^\n+|\n+$/g, '').split('\n').slice(0, GOALS_LINES).join('\n')

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
/** An attachment's text, decrypted here (the sandboxed page viewer reads an attached page with it). */
const attachmentText = async id => { const b = await blobOf(id); if (!b) throw new Error('gone'); return b.text() }
/** An attachment's bytes by its /att/ address or id, decrypted here (the Scribble Board lays a parked note's pictures down with it). */
export const attachmentBlob = async at => { const b = await blobOf(/([0-9a-f]{32})(?:#.*)?$/.exec(String(at))?.[1]); if (!b) throw new Error('gone'); return b }
const whyNot = new Map()   // attachment id -> why it could not be fetched or opened, the last time
const blobOf = id => {
  if (!blobs.has(id)) {
    const ref = refs.get(id)
    if (!ref || !client) return Promise.resolve(null)
    blobs.set(id, client.attachmentBlob(ref).then(b => { whyNot.delete(id); return b }, err => { blobs.delete(id); whyNot.set(id, err); console.warn('attachment', id, err.message); return null }))
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
  // Gone from the hub (after 30 days, or evicted for the room's quota), or not fetched (offline, the hub's error): said
  // in place of the picture, with the reason.
  const why = whyNot.get(m[1]), gone = document.createElement('span')
  gone.className = 'att-gone'
  gone.setAttribute('role', 'status')
  gone.textContent = !why || why.code === 'not-found' || why.status === 404 ? 'Attachment no longer available' : `This file could not be loaded: ${why.message || why.code || 'no answer from the hub'}`
  el.closest('.tc-figure')?.classList.remove('is-wait')
  el.replaceWith(gone)
}, true)
// (the card's picture says "Opening the picture…" until it is there: card.mjs cardMedia)
document.addEventListener('load', e => { if (e.target instanceof HTMLImageElement) e.target.closest('.tc-figure.is-wait')?.classList.remove('is-wait') }, true)
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
// The seam between the client core's model (core/README) and the views: boardState(client.model) returns the board's
// state in the shape the views are written for ({ cards, queue, agents, tasks, messages, desks, notes, assets }).
//
// Incremental: a card's board form is kept per object_id and made again only when a change names it (or a register
// that it shows: its draft, its snooze). The messages are built on first read (only a session's page and a card's
// thread read them), from the timeline windows that are in memory plus the events every client knows from the heads
// (asked, revised, answered, read, shredded, closed).


const SESSION_ID_LEN = 12
// A session's id on the board (its address /chat/<id>): the start of the agent's device id, known from the first envelope
// on and never changing. (The hub's agent_session_id is random hex and arrives later, with GET devices: it would move
// the address. A readable one, as the mock room has, is kept.)
// A session's key in the core's model: its session_id (in the demo room that is its agent's device id).
const sessionKey = s => s.session_id ?? s.agent_device_id
// The sessions as the board shows them: one per key (a stored copy filed under an older key is not a second session).
const sessionsOf = m => [...m.sessions].filter(([k, s]) => k === sessionKey(s)).map(([, s]) => s)
// What belongs to a session (a card, a request, a published object) names it by session_id or by its agent.
const keyOf = o => o.session_id ?? o.agent_device_id
// The versions a human reads as the question: the first, and every later one that leaves it open. A version that
// closes the card (close_card, withdraw, merge; also a second close) ends it and is no revision: the card's "Done"
// line says what became of it, so it never shows as "Question revised" or as a new "Version n".
const revisionsOf = c => (c?.versions ?? []).filter(v => v.object_version === 1 || v.object_state === 'open')
/** The name of the picture a selection of the Scribble Board is sent under (whiteboard.mjs): a Chat message of a
 *  person whose one picture has it stands in the conversation as a scribble card. */
export const SCRIBBLE_FILE = 'selection.png'
/** How the core addresses a session for a send: { session_id }; { agent_device_id } for a record without one. */
export const addressOf = (model, key) => (model.sessions.get(key)?.session_id ? { session_id: key } : { agent_device_id: key })
// The parent a session names (profile.parent_session), as core model.parentSessionOf rules: a child session an agent
// opened itself counts only under a session that agent (or the agent a human handed the child to) is assigned to; any other claim counts as it stands (display only).
function parentClaim(m, s) {
  const want = s.profile?.parent_session
  if (!want || typeof want !== 'string') return null
  if (!s.created_by_agent) return want
  const parent = m.sessions.get(want)
  return parent && parent !== s && (parent.agent_device_ids ?? []).some(a => a === s.creator_device_id || (s.agent_device_ids ?? []).includes(a)) ? want : null
}
const agentIdOf = s => (s.agent_session_id && !/^[0-9a-f]{12,}$/.test(s.agent_session_id) ? s.agent_session_id : sessionKey(s).slice(0, SESSION_ID_LEN))

/**
 * A value worked out from the board's card list alone, kept while that list is the same object (BoardState.update
 * hands the previous list on when no card changed). key: the other inputs, as a string; fn: the work.
 */
const memos = new WeakMap()
export function cardsMemo(cards, key, fn) {
  let m = memos.get(cards)
  if (!m) memos.set(cards, m = new Map())
  if (!m.has(key)) m.set(key, fn())
  return m.get(key)
}

/** The same for what depends only on the closed cards (answered, done, shredded): kept while no closed card changed,
 *  so a new open card or an answer to one does not sort the thousands of closed ones again (state.closedGen). */
let closedKept = { gen: -1, m: new Map() }
export function closedMemo(state, key, fn) {
  if (closedKept.gen !== state.closedGen) closedKept = { gen: state.closedGen, m: new Map() }
  if (!closedKept.m.has(key)) closedKept.m.set(key, fn())
  return closedKept.m.get(key)
}

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
    this.closedGen = 0             // counts up whenever a closed card (or one that was closed) changes: closedMemo
  }
  get model() { return this.client.model }

  /** After a change of the core (or with no change: everything). Returns the new state object. */
  update(change = null) {
    const m = this.model
    // (touched: some card's board form must be made again; without, the card list of the last state is handed on)
    let touched = !change || change.cards.size > 0 || change.permissions.size > 0
    let wiped = !change                // every card's board form is made again (names changed, or no change given)
    const dropped = new Set()
    const wasClosed = id => { const b = this.cardCache.get(id); if (b && b.status !== 'open') this.closedGen++ }
    const drop = id => { wasClosed(id); if (this.cardCache.delete(id)) { touched = true; dropped.add(id) } }
    if (!change) { this.cardCache.clear(); this.eventCache.clear(); this.closedGen++ }
    else {
      for (const id of change.cards) { wasClosed(id); this.cardCache.delete(id); this.eventCache.delete(id) }
      for (const id of change.permissions) { wasClosed(id); this.cardCache.delete(id) }
      for (const key of change.registers) {
        const at = key.indexOf('/'), kind = key.slice(0, at), id = key.slice(at + 1)
        if (kind === 'draft' || kind === 'snooze' || kind === 'duck') drop(id)
        if (kind === 'session' || key === 'crown') { this.cardCache.clear(); this.eventCache.clear(); touched = true; wiped = true; this.closedGen++ }   // agent ids and names change
      }
    }
    // Agents (sessions) and their ids on the board. A card's board form names its agent: only when that naming
    // changes (a session came, went or was renamed) are all cards made again; a status line changes nothing here.
    const devToAgent = new Map(), agentToDev = new Map()
    for (const s of sessionsOf(m)) { const id = agentIdOf(s), key = sessionKey(s); devToAgent.set(key, id); agentToDev.set(id, key) }
    const naming = [...devToAgent].join()
    if (naming !== this.naming) { this.naming = naming; this.cardCache.clear(); this.eventCache.clear(); touched = true; wiped = true; this.closedGen++ }
    this.devToAgent = devToAgent; this.agentToDev = agentToDev
    this.forgetMessages(change, m, !this.eventCache.size)
    // Card numbers: the order cards (and permission requests) were first filed in, from 1. Never reused, the same on
    // every device. Sorted again only when a card or request came that was not numbered yet.
    const fresh = !change || !this.numberOf || [...change.cards, ...change.permissions].some(id => !this.numberOf.has(id)) || m.cards.size + m.permissions.size !== this.numberOf.size
    // (the common case, a card filed after all the others: it takes the next number, nothing is sorted again)
    const newIds = fresh && change && this.numberOf ? [...change.cards, ...change.permissions].filter(id => !this.numberOf.has(id)) : null
    const firstOf = id => m.cards.get(id)?.first_envelope_number ?? m.permissions.get(id)?.envelope_number
    const appended = newIds && newIds.length && m.cards.size + m.permissions.size === this.numberOf.size + newIds.length &&
      newIds.every(id => Number.isFinite(firstOf(id)) && firstOf(id) > this.lastNumbered)
    if (appended) {
      for (const id of newIds.sort((a, b) => firstOf(a) - firstOf(b))) {
        this.numberOf.set(id, this.numberOf.size + 1)
        ;(m.cards.has(id) ? this.order : this.permOrder).push(id)
        this.lastNumbered = firstOf(id)
      }
    } else if (fresh) {
      const numbered = [...[...m.cards.values()].map(c => [c.first_envelope_number, c.object_id, 0]), ...[...m.permissions.values()].map(p => [p.envelope_number, p.object_id, 1])].sort((a, b) => a[0] - b[0])
      this.numberOf = new Map(numbered.map(([, id], i) => [id, i + 1]))
      this.order = numbered.filter(x => !x[2]).map(x => x[1])
      this.permOrder = numbered.filter(x => x[2]).map(x => x[1])
      this.lastNumbered = numbered.length ? numbered.at(-1)[0] : -Infinity
    }
    const numberOf = this.numberOf
    const prev = this.state?.cards
    // No card named by the change and none to number: the list stands as it was (a chat message, a status line, presence
    // cost nothing per card here).
    const keep = !touched && !fresh && prev && change?.registers
    const make = (id, n) => { const c = m.cards.get(id); if (c) { const b = this.boardCard(c, n); if (b.status !== 'open') this.closedGen++; return b } const p = m.permissions.get(id); if (!p) return null; const b = this.permissionCard(p, n); if (b.status !== 'open') this.closedGen++; return b }
    let cards
    if (keep) cards = prev
    else if (prev && this.cardList && !wiped && (!fresh || appended)) {
      // Only what the change names is made again, in its place; a newly filed card goes at the end of its list. (A
      // whole pass over thousands of cards per card that changed would be most of a live update's time.)
      const ids = new Set([...change.cards, ...change.permissions, ...dropped])
      let whole = false
      for (const id of ids) {
        const at = this.listIdx.get(id)
        if (at === undefined) continue
        if (!m.cards.has(id) && !m.permissions.has(id)) { whole = true; break }          // gone: the list is made again below
        let b = this.cardCache.get(id)
        if (!b || b.number !== numberOf.get(id)) { if (b) wasClosed(id); b = make(id, numberOf.get(id)); this.cardCache.set(id, b) }
        ;(at.perm ? this.permList : this.cardList)[at.i] = b
        this.byId.set(id, b)
      }
      if (!whole) for (const id of appended ? newIds : []) {
        const b = this.cardCache.get(id) ?? make(id, numberOf.get(id))
        if (!b) { whole = true; break }
        this.cardCache.set(id, b)
        const perm = !m.cards.has(id), list = perm ? this.permList : this.cardList
        this.listIdx.set(id, { perm, i: list.length }); list.push(b); this.byId.set(id, b)
      }
      cards = whole ? null : this.cardList.concat(this.permList)
    }
    if (!cards) {
      const all = this.order.map(id => m.cards.get(id)).filter(Boolean)
      const perms = this.permOrder.map(id => m.permissions.get(id)).filter(Boolean)
      const cardList = [], permList = []
      for (const c of all) { let b = this.cardCache.get(c.object_id); if (!b || b.number !== numberOf.get(c.object_id)) { if (b) wasClosed(c.object_id); b = make(c.object_id, numberOf.get(c.object_id)); this.cardCache.set(c.object_id, b) } cardList.push(b) }
      for (const p of perms) { let b = this.cardCache.get(p.object_id); if (!b) { b = make(p.object_id, numberOf.get(p.object_id)); this.cardCache.set(p.object_id, b) } permList.push(b) }
      this.cardList = cardList; this.permList = permList
      this.listIdx = new Map([...cardList.map((b, i) => [b.id, { perm: false, i }]), ...permList.map((b, i) => [b.id, { perm: true, i }])])
      cards = cardList.concat(permList)
      // No card changed after all: the same list object, so everything derived from the cards alone (cardsMemo: the
      // Desk's places, the end list) is reused instead of worked out over thousands again.
      if (prev && prev.length === cards.length && cards.every((b, i) => prev[i] === b)) cards = prev
      else this.byId = new Map(cards.map(c => [c.id, c]))
    }
    const agents = this.agents()
    const shelved = new Set(agents.filter(a => a.archived).map(a => a.id))
    const queue = cardsMemo(cards, `queue ${[...shelved]}`, () => cards.filter(c => c.status === 'open' && !shelved.has(c.agent) && !c.snoozed_until).sort((a, b) => a.created - b.created || a.number - b.number).map(c => c.id))
    const tasks = []
    for (const s of sessionsOf(m)) for (const t of s.status_lines ?? []) tasks.push({ agent: devToAgent.get(sessionKey(s)), id: t.id, label: t.label, state: t.state, detail: t.detail, card_id: t.object_id ?? null, updated: t.updated_at ?? 0 })
    // (the order he dragged them into in the menu: each desk's register holds its place, order; a desk made since then
    // comes last. Never dragged: the first desk, then by age)
    const desks = [...m.human.desks].filter(([, v]) => v).map(([id, v]) => ({ id, name: String(v.name ?? '').trim() || 'Personal', created: v.created_at ?? 0, order: Number.isFinite(v.order) ? v.order : null, goals: typeof v.goals === 'string' ? cleanGoals(v.goals) : '', ...('crown' in v ? { crown: v.crown ?? null } : {}) }))
    const ordered = desks.some(d => d.order != null)
    desks.sort((a, b) => (ordered ? (a.order ?? Infinity) - (b.order ?? Infinity) || a.created - b.created : a.id === 'main' ? -1 : b.id === 'main' ? 1 : a.created - b.created))
    const notes = boardNotes(m)
    // Published objects (an agent's publish): the first attachment is the thing itself; type by its media type.
    const assetType = t => (t === 'text/html' ? 'html' : t.startsWith('image/') ? 'image' : t.startsWith('video/') ? 'video' : t.startsWith('audio/') ? 'audio' : 'file')
    // (the same list while no published object changed and the sessions are named as they were: views keep what they
    //  made of it, ui.mjs galleryItems)
    const assets = change && !change.published?.size && !change.members && this.state?.assets && this.assetsNaming === naming ? this.state.assets : [...m.published.values()].filter(p => p.object_state !== 'closed').map(p => { const a = p.attachments?.[0]; return { id: p.object_id, agent: devToAgent.get(keyOf(p)), type: assetType(String(a?.media_type ?? '')), title: p.title, note: p.note ?? '', size: a?.total_size ?? 0, att: this.att(a), envelope_number: p.envelope_number, created: p.sent_at ?? 0 } })
    this.assetsNaming = naming
    const self = this
    const state = {
      cards, byId: this.byId, queue, closedGen: this.closedGen, agents, tasks, desks, notes, assets,
      get messages() { return (self.allMsgs ??= self.messages()) },
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
    // (a page given as a path of the agent's machine never reached the room: there is nothing to open)
    const local = !own && p && /^(?:\/(?:home|Users|tmp|var|private|root|mnt)\/|file:|[A-Za-z]:\\)/.test(p)
    const pageAtt = own ? list.find(x => x.attachment_id === own) : null
    const page = p && !local ? { url: own ? pageAtt?.url ?? `/att/${own}` : p, kind: own ? 'file' : 'link', name: own ? pageAtt?.file_name ?? 'page.html' : named(p.split(/[?#]/)[0].replace(/\/+$/, '').split('/').pop()) || 'page' } : null
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
    // A card of a newer Trommi (card type or schema): its title where readable, the update line, nothing to answer.
    if (c.unsupported) Object.assign(card, { kind: 'info', unsupported: true, title: card.title || 'A card from a newer Trommi', body: c.unsupported === 'card_type' && card.body ? card.body : '', teaser: NEEDS_NEWER, options: [] })
    else if (c.sections) card.sections = c.sections
    if (c.html && !c.unsupported) card.html = c.html
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
    // (its agent closed it after his answer, close_card: What?? asks about what it did)
    if (status === 'done' && c.closed_how === 'closed' && a && !a.pending && a.answer_action !== 'read' && a.answer_action !== 'shred') card.finished = true
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
    // (what a session sent with attachments comes from its conversations' items only: a card or session change
    //  leaves that list as it was, only a timeline of the session's makes it again)
    const drop = (agent, files = false) => { if (agent === undefined) return; if (files) this.filesByAgent.delete(agent); if (this.msgByAgent.delete(agent)) this.allMsgs = null }
    for (const id of change.cards) { drop(agentOfCard(id)); this.msgByCard.delete(id) }
    for (const sid of change.sessions ?? []) drop(agentOfSession(sid))
    for (const key of change.timelines) {
      if (key.startsWith('chat:session/')) drop(agentOfSession(key.slice(13)), true)
      else if (key.startsWith('chat:card/')) { const id = key.slice(10); drop(agentOfCard(id), true); this.msgByCard.delete(id) }
    }
  }
  timeOf(key, n) {
    const t = this.model.timelines.get(key)
    return t?.items.get(n)?.sent_at ?? null
  }

  // ---- the conversation: timeline windows + what the heads say ----
  /** Every message of the board (global; prefer messagesOf, which builds one session's only). */
  messages() {
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
    const trails = new Map()   // a turn's id -> { msg, envelopes, at: where each envelope stands }
    const typed = []           // where the messages he typed into the terminal stand
    for (const i of t.items.values()) {
      const kind = i.content_type ?? 'message'
      // Written by a newer Trommi (a content type or schema this version does not know): a placeholder in its place.
      const newer = i.item_state === 'unsupported' || i.item_state === 'newer_schema'
      if (kind !== 'message' && !newer) continue
      const human = i.sender_device_id === me || this.humans.has(i.sender_device_id)
      const c = i.content ?? {}
      const msg = {
        id: i.envelope_number != null ? `e${i.envelope_number}` : i.local_id, seq: i.envelope_number ?? Number.MAX_SAFE_INTEGER, agent, from: human ? 'user' : 'agent',
        text: newer ? NEEDS_NEWER : i.item_state === 'loaded' || !i.item_state ? (c.text ?? '') : i.item_state === 'pruned' ? '(removed after 30 days)' : '',
        attachments: this.atts(c.attachments), ts: i.sent_at ?? 0,
      }
      if (newer) { msg.attachments = []; msg.unsupported = true; out.push(msg); continue }
      // A selection of the Scribble Board sent to the session: shown as a scribble card.
      if (human && c.attachments?.length === 1 && c.attachments[0].file_name === SCRIBBLE_FILE) msg.attachments = msg.attachments.map(x => ({ ...x, kind: 'scribble' }))
      if (cardId) msg.card_id = cardId
      if (c.details) msg.details = c.details
      if (c.html) msg.html = c.html
      if (c.published_object_id) { if (this.model.published.get(c.published_object_id)?.object_state === 'closed') continue; msg.published = c.published_object_id }   // a revoked asset leaves the conversation
      // (A note of his sent to the session (content.note): it stands in the conversation as the note, taped on.)
      if (c.note) msg.note = { written: c.note.written_at ?? null }
      // The terminal mirror (README): what he typed into the session's terminal stands as his message, sent for him
      // by the agent's connector (no human device signed it: the bubble says where it came from); the agent's final
      // text there is the agent's message. Counts only from an agent.
      if (!human && (c.terminal === 'input' || c.terminal === 'answer')) { msg.terminal = c.terminal; if (c.terminal === 'input') { msg.from = 'user'; typed.push(msg.seq) } }
      // A turn's trail (README "The trail"): its envelopes are one message, the block of what the agent did, where
      // the first of them stands, or behind what he typed into the terminal while the turn ran (work.ts workAnchor).
      // Counts only from an agent; an envelope that is not a trail's is left out.
      if (c.terminal === 'work') {
        const w = c.work
        if (human || !work?.isWork(c)) continue
        const had = trails.get(w.turn)
        const place = { id: msg.id, seq: msg.seq, ts: msg.ts }
        if (had) { had.envelopes.push(w); had.at.push(place); continue }
        Object.assign(msg, { from: 'work', text: '', attachments: [] })
        trails.set(w.turn, { msg, envelopes: [w], at: [place] })
        out.push(msg)
        continue
      }
      if (c.hand_back) msg.handback = true
      if (c.explain) msg.explain = true
      if (c.present_card) msg.present = true
      if (c.marks?.length) msg.marks = c.marks
      if (c.copied_cards?.length) msg.cards = c.copied_cards.map(id => { const b = this.cardCache.get(id); return b ? { id, number: b.number, title: b.title, agent: b.agent, choice_label: null } : { id, number: null, title: id, agent } })
      if (i.pending) msg.pending = true
      out.push(msg)
    }
    for (const { msg, envelopes, at } of trails.values()) {
      msg.work = work.foldWork(envelopes)
      const seq = work.workAnchor(at.map(p => p.seq), typed)
      Object.assign(msg, at.find(p => p.seq === seq))
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
// core's human actions (core/README).
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

// ---- "Copy link" on an artifact (media.mjs tiles, session.mjs asset card and viewer) ----
// Copying the link IS the consent: the first press makes a link for people outside the room
// that holds 30 days and copies it; while it holds, a press copies the same link (it is not renewed: a new one is made
// only after it ran out or was stopped). No dialog, no choices. While a link holds the button is filled in the accent,
// and Stop sharing stands beside it. The links this device made are kept in its storage (client.myShares); one made on
// another device, or by an agent (share_asset), is not known here.
const SHARE_DAYS = 30
let sharing = null   // the hub facade (set when the board starts)
let shares = []      // this device's open shares, newest first
let sharesAsked = null
const loadShares = async () => { try { shares = await sharing.myShares() } catch (err) { console.warn('shares', err); shares = [] } }
/** The shares are read once when the board starts; a page that shows Copy link waits for that. */
export const sharesLoaded = () => (sharesAsked ??= sharing ? loadShares() : Promise.resolve())
const shareOf = att => (att ? shares.find(x => x.attachment_id === att && x.link && x.expires_at > Date.now()) ?? null : null)
const sharedWord = sh => { const n = Math.max(1, Math.ceil((sh.expires_at - Date.now()) / 86400_000)); return `Shared · ${n} ${n === 1 ? 'day' : 'days'}` }
const COPY_TIP = `Copy link: anyone with the link can open it, for ${SHARE_DAYS} days`
const tipOf = sh => (sh ? `${sharedWord(sh)} left. Copies the same link again` : COPY_TIP)
/** The button (and Stop sharing) for the file `att` (its attachment id); tile: the round icons on an Artifacts tile. */
export function shareControl(att, title, { tile = false, cls = '' } = {}) {
  if (!att) return ''
  const sh = shareOf(att), on = sh ? ' is-on' : '', off = sh ? '' : raw(' hidden')
  const head = html`data-controller="sharelink" data-sharelink-att-value="${att}" data-sharelink-title-value="${title}"`
  if (tile) return html`<span class="shr is-tile${on}" ${head}><button type="button" class="art-act shr-copy" data-action="sharelink#copy" title="${tipOf(sh)}" aria-label="Copy link to ${title}" aria-pressed="${sh ? 'true' : 'false'}">${sk('link')}</button><details class="art-share t-pick" data-controller="pops"${off}><summary class="art-act" title="More" aria-label="More for ${title}">${sk('more')}</summary><div class="art-share-body"><span class="shr-word">${sh ? `${sharedWord(sh)} left` : ''}</span><button type="button" class="shr-stop" data-action="sharelink#stop">Stop sharing</button></div></details></span>`
  return html`<span class="shr${on}${cls ? ` ${cls}` : ''}" ${head}><button type="button" class="asset-copy shr-copy" data-action="sharelink#copy" title="${tipOf(sh)}" aria-pressed="${sh ? 'true' : 'false'}"><span class="shr-word">${sh ? sharedWord(sh) : 'Copy link'}</span></button><button type="button" class="shr-stop" data-action="sharelink#stop"${off}>Stop sharing</button></span>`
}
// (every control of that file on the page: a tile, the card in the talk)
function paintShare(att, flash = '') {
  const sh = shareOf(att)
  for (const el of document.querySelectorAll(`.shr[data-sharelink-att-value="${att}"]`)) {
    const tile = el.classList.contains('is-tile'), copy = el.querySelector('.shr-copy'), word = el.querySelector('.shr-word')
    el.classList.toggle('is-on', Boolean(sh))
    copy.title = tipOf(sh)
    copy.setAttribute('aria-pressed', sh ? 'true' : 'false')
    word.textContent = tile ? (sh ? `${sharedWord(sh)} left` : '') : flash || (sh ? sharedWord(sh) : 'Copy link')
    const more = el.querySelector(tile ? 'details' : '.shr-stop')
    more.hidden = !sh
    if (!sh && tile) more.open = false
  }
}
controller('sharelink', class extends Controller {
  static values = { att: String, title: String }
  disconnect() { clearTimeout(this.timer) }
  async copy() {
    if (this.busy) return
    this.busy = true
    const att = this.attValue, had = shareOf(att)
    // (the clipboard is asked at once, inside the press, and given the link when it is made: Safari wants it so)
    let made = null
    const link = had ? Promise.resolve(had.link) : sharing.shareFile(att).then(async r => { made = r; await loadShares(); return r.link })
    let ok = false
    try { ok = await copyLater(link) } catch (err) { this.busy = false; return showToast({ head: 'Not shared', line: sayError(err), role: 'alert' }) }
    this.busy = false
    paintShare(att, ok ? 'Link copied' : '')
    clearTimeout(this.timer)
    this.timer = setTimeout(() => paintShare(att), 1800)
    const sh = shareOf(att) ?? made
    if (!ok) return showToast({ head: 'Not copied', line: 'It is shared, but the browser kept the clipboard closed. Press again', role: 'alert' })
    showToast({ head: 'Link copied', line: sh ? `Valid for ${sharedWord(sh).replace('Shared · ', '')}` : '' })
  }
  async stop() {
    const att = this.attValue
    try { for (const sh of shares.filter(x => x.attachment_id === att)) await sharing.stopSharing(sh.share_id, att) } catch (err) { return showToast({ head: 'Not stopped', line: sayError(err), role: 'alert' }) } finally { await loadShares(); paintShare(att) }
    showToast({ head: 'Sharing stopped', line: `The link to “${this.titleValue}” opens nothing any more` })
  }
})

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

    // ---- links for people outside the room ("Copy link" on an artifact: shareControl above) ----
    // A human device shares any file of the room: the secret is drawn here, the hub keeps its hash; the link (secret
    // and file key after the #) is kept in this device's storage so Copy works again later. Always 30 days.
    async shareFile(attachment_id) {
      const ref = refOfFile(client, attachment_id)
      if (!ref) throw fail(404, 'this file is not known here')
      return client.shareAttachment(ref, { expires_at: Date.now() + SHARE_DAYS * 86400_000 - 60_000, app_url: location.origin, keep_link: true })
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
      await client.setDesk(deskId, { ...(m().human.desks.get(deskId) ?? { name: desks.find(d => d.id === deskId)?.name ?? 'Personal', created_at: Date.now() }), crown })
    },
    // Desks: the human register desk/<id>.
    async desk({ id, name, remove, order, goals }) {
      // (the last desk stays: every account has one, client.ts removeDesk)
      if (remove) { try { await client.setDesk(id, null) } catch (err) { if (err?.code === 'last-desk') throw fail(409, 'the last desk stays'); throw err } return { ok: true } }
      // A new order (the menu's rows dragged): every desk's place, in one write, so his devices all see the same list.
      if (Array.isArray(order)) {
        const have = m().human.desks, ids = order.map(String).filter(x => have.get(x))
        if (!ids.length) throw fail(400, 'no such desks')
        await client.setRegisters(Object.fromEntries(ids.map((x, i) => [`desk/${x}`, { ...have.get(x), order: i }])))
        return { ok: true, order: ids }
      }
      // A desk's goals (desk.mjs deskGoals): a field of its register like the name. With no desk yet, the first one
      // ("main") is made for them.
      if (goals !== undefined) {
        const have = m().human.desks, did = have.get(id) ? id : !have.size ? 'main' : null
        if (!did) throw fail(404, 'no such desk')
        const text = cleanGoals(goals), { goals: _, ...rest } = have.get(did) ?? { name: 'Personal', created_at: Date.now() - 1 }
        await client.setDesk(did, text ? { ...rest, goals: text } : rest)
        return { ok: true, desk: { id: did, goals: text } }
      }
      if (id) { await client.setDesk(id, { ...(m().human.desks.get(id) ?? {}), name }); return { ok: true, desk: { id, name } } }
      const made = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('')
      if (!m().human.desks.size) await client.setDesk('main', { name: 'Personal', created_at: Date.now() - 1 })
      await client.setDesk(made, { name: String(name ?? '').trim().slice(0, 40) || 'Personal', created_at: Date.now() })
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
// fetched: the router (below) renders them in the page. window.Turbo is set for code that asks it.

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
  window.Turbo = { visit, renderStreamMessage }
}

/** The Trommi menu (#brand-doors) stays as it stood when a live update or the page drawn again replaces it: a person
 *  who just opened it does not see it shut under the pointer. Returns a function that puts it back. */
export function keepMenu() {
  const doors = document.getElementById('brand-doors')
  if (!doors || doors.hidden) return () => {}
  const from = doors.dataset.from ?? null
  // (and the line for a new desk's name, open, with what is typed in it and the focus in it)
  const form = document.getElementById('desk-new'), field = form?.querySelector('.menu-desk-field')
  const typing = form && !form.hidden ? { value: field?.value ?? '', focused: document.activeElement === field, at: field?.selectionStart ?? null } : null
  return () => {
    const now = document.getElementById('brand-doors')
    // (only a menu that was replaced: one still in the page was shut on purpose)
    if (!now || now === doors || !now.hidden) return
    now.hidden = false
    if (from) now.dataset.from = from
    for (const b of document.querySelectorAll('#brand-menu, .desk-switch-open, .rail-tag')) b.setAttribute('aria-expanded', 'true')
    const again = document.getElementById('desk-new'), line = again?.querySelector('.menu-desk-field')
    if (typing && again && line) {
      again.hidden = false
      line.value = typing.value
      if (typing.focused) { line.focus({ preventScroll: true }); if (typing.at !== null) line.setSelectionRange(typing.at, typing.at) }
    }
  }
}
async function perform(stream) {
  const back = keepMenu()
  try { return await performNow(stream) } finally { back() }
}
async function performNow(stream) {
  const action = stream.action, target = stream.targetElements[0]
  if (action === 'refresh') return refresher?.()
  if (action === 'visit') return visit(stream.getAttribute('target') || '/', { action: 'replace' })   // (a form's answer that leads on: the page it names)
  if (!target) return
  const content = () => stream.templateContent
  switch (action) {
    case 'remove': {
      // A Desk row that leaves goes in one continuous motion, without a jump: it slides
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
/** Desk rows leave without a jump and without work per frame: measured once, each row
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
// The view modules register themselves (register(t) with t.get, t.post, t.live); a "request" here is a navigation
// or a form of this page, answered from the local model.
//
//   const board = createBoard({ hub, model })   hub: hubFacade above; model(): boardModel of now
//   await board.request({ method, path, form, headers })  -> { kind: 'page' | 'stream' | 'redirect' | 'html' | 'none', … }
//   board.live(clients)                          after a change: the stream actions per open page (only what changed)

// The toast after a card's action (and the way back it offers).
export const SAID = {
  decide: { head: 'Answered', back: 'reopen' }, trust: { head: WORDS.trust, back: 'reopen' }, close: { head: 'Read', back: 'reopen' },
  shred: { head: 'Shredded', back: 'reopen' }, snooze: { head: WORDS.later, back: 'wake' }, revise: { head: 'Handed back', back: 'takeback' }, message: { head: 'Message sent' }, what: { head: `Asked: ${WORDS.what}`, back: 'takeback' },
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
// sheet, the notes. Only the body is made here: the router keeps the head and patches the body.

// The pages whose sheet has the turned corner: the Desk, a session's page and a card's own page. padFrom: the one the board was turned from (its corner turns back there).
const FRONT = new Set(['desk', 'session', 'card'])
let padFrom = '/'
let padKept = false   // the Scribble Board stays mounted under the Desk (set when the corner is first touched, or coming from the board)
const padCanvas = html => /data-whiteboard-canvas-value="([^"]*)"/.exec(html)?.[1] ?? null
/** The body's parts for a page: [{ key, html }] in order (the router keeps a part whose markup did not change). */
function bodyParts({ view, model, base = '', main, sidebar = true, current = null, says = '', title = '' }) {
  const parts = []
  if (sidebar) {
    if (model) parts.push({ key: 'phonebar', html: String(phoneBar(model, base, { view, current, title })) })
    parts.push({ key: 'topbar', html: String(topbar(model, base, view === 'desk', view === 'session' ? current : null)) })
    // (the same rows on every page: the session in view is marked after the paint, sidebar.mjs markCurrent)
    parts.push({ key: 'agents', html: String(html`<nav id="agents" aria-label="Sessions" data-controller="folds">${sidebarRows(model, base)}</nav>`) })
    parts.push({ key: 'foot', html: String(SIDE_FOOT) })
    parts.push({ key: 'veil', html: String(DRAWER_VEIL) })
    if (model) parts.push({ key: 'note', html: String(cornerNote(model, base)) })
    if (model) parts.push({ key: 'tabbar', html: String(tabBar(model, base, view)) })
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
// Navigation, forms, frames and live updates of the app (what Turbo Drive, Frames and Streams do for server-rendered
// pages, done in the page):
//   - a link of the app (same origin) renders its page from the local model: no request leaves the device;
//   - the page's body is patched by parts (topbar, sidebar, main, …): a part whose markup did not change stays;
//   - a form is answered by the board's handlers (createBoard above): stream actions, a redirect, or a page;
//   - after every change of the core only the elements that changed are replaced (board.live → <turbo-stream>);
//   - fetch() calls of the controllers to the app's own JSON routes (/note, /desk, a card's draft) are answered here.

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
    // (every new part is parsed off the page first, in one go, each with its two marks: the page is then changed in
    //  one stretch of insertions and removals, nothing read in between)
    const made = new Map()
    for (const { key, html } of list) {
      const part = parts.get(key)
      if (part && (key === 'says' || part.html === html || (key === 'pad' && part.html !== html && padCanvas(part.html0) === padCanvas(html)))) continue
      const t = document.createElement('template')
      t.innerHTML = html
      const start = document.createComment(`p:${key}`), end = document.createComment(`/p:${key}`)
      t.content.prepend(start); t.content.append(end)
      made.set(key, { frag: t.content, start, end })
    }
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
        // The same drawing: the mounted pad stays; only its list of sessions and the boards beside it are brought up to date.
        const t = document.createElement('template')
        t.innerHTML = html
        for (const id of ['whiteboard-sessions', 'whiteboard-desks']) { const fresh = t.content.getElementById(id); if (fresh) document.getElementById(id)?.replaceWith(fresh) }
        part.html = html
      }
      if (part && (key === 'says' || part.html === html)) {
        // Kept (toasts always stay across pages, like data-turbo-permanent): moved into place if needed.
        if (part.start !== anchor) for (const n of between(part)) body.insertBefore(n, anchor)
        anchor = part.end.nextSibling
        continue
      }
      const { frag, start, end } = made.get(key)
      // A part painted before whose markup changed a little (the session in view marked in the sidebar, a count): the
      // nodes it painted then stay, and only what differs is changed in them (morph). A row keeps its node, its
      // controller and its layout; the browser styles and lays out only what changed.
      const pristine = MORPHED.has(key) ? frag.cloneNode(true) : null
      if (part?.pristine && part.html != null && MORPHED.has(key) && morphPart(part, frag)) {
        part.html = html; part.html0 = html; part.pristine = pristine
        anchor = part.end.nextSibling
        continue
      }
      if (part) { anchor = part.end.nextSibling; for (const n of between(part)) n.remove() }
      if (anchor && !anchor.isConnected) anchor = null
      body.insertBefore(frag, anchor)
      parts.set(key, { html, html0: html, start, end, pristine })
      anchor = end.nextSibling
    }
  }
  // ---- morphing a part: keep the painted nodes, change what the new markup changes ----
  // The frame's parts that stay from page to page (the sidebar, the bars); a page's <main> is painted anew (its
  // controllers start from the top, its scroll too).
  const MORPHED = new Set(['agents', 'topbar', 'phonebar', 'tabbar', 'sheets'])
  // old: the live nodes between the part's marks; was: the markup they were painted from (parsed, untouched since);
  // now: the new markup, parsed. Where now equals was, the live node stays as it is (whatever controllers did to it).
  // Where only attributes differ, those attributes change and the children are compared the same way. Anything else
  // (another element, a node that controllers added or took away) is replaced by the new node. false: not morphed
  // (the part is painted anew).
  function morphNode(live, was, now) {
    if (now.isEqualNode(was)) return true
    if (live.nodeType !== now.nodeType || was.nodeType !== now.nodeType) return false
    if (now.nodeType === Node.TEXT_NODE || now.nodeType === Node.COMMENT_NODE) { if (live.data === was.data) live.data = now.data; else live.replaceWith(now); return true }
    if (now.nodeType !== Node.ELEMENT_NODE || live.tagName !== now.tagName || was.tagName !== now.tagName) return false
    // (a template's content, a form field's value, a frame: replaced whole)
    if (now.tagName === 'TEMPLATE' || now.tagName === 'TEXTAREA' || now.tagName === 'INPUT' || now.tagName === 'SELECT' || now.tagName.includes('-')) { live.replaceWith(now); return true }
    const lk = live.childNodes, wk = was.childNodes, nk = now.childNodes
    if (lk.length !== wk.length || wk.length !== nk.length) { live.replaceWith(now); return true }
    for (const a of new Set([...was.getAttributeNames(), ...now.getAttributeNames()])) {
      const w = was.getAttribute(a), n = now.getAttribute(a)
      if (w === n) continue
      if (n == null) live.removeAttribute(a); else live.setAttribute(a, n)
    }
    const kids = [...lk], was2 = [...wk], now2 = [...nk]
    for (let i = 0; i < now2.length; i++) if (!morphNode(kids[i], was2[i], now2[i])) kids[i].replaceWith(now2[i])
    return true
  }
  function morphPart(part, frag) {
    const live = between(part).slice(1, -1), was = [...part.pristine.childNodes].slice(1, -1), now = [...frag.childNodes].slice(1, -1)
    if (live.length !== was.length || was.length !== now.length) return false
    for (let i = 0; i < now.length; i++) if (!morphNode(live[i], was[i], now[i])) live[i].replaceWith(now[i])
    return true
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
    if (opts.sidebar !== false) markCurrent(opts.current ?? null)
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
    url.pathname = movedPath(url.pathname) ?? url.pathname   // (an address of before: paths.mjs)
    const to = url.pathname + url.search + url.hash
    if (action !== 'restore' && fire(document, 'turbo:before-visit', { url: url.href }, true).defaultPrevented) return
    const mine = ++visiting
    flush()   // what an action just changed is in the state before the page is rendered
    beforeVisit(url)
    const res = await board.request({ method: 'GET', path: url.pathname + url.search, headers: { accept: 'text/html' } })
    if (mine !== visiting) return
    if (res.kind === 'redirect') return visit(res.to, { action: action === 'restore' ? 'replace' : action === 'advance' ? 'replace-after' : action })
    if (action === 'advance') { saveScroll(); history.pushState({ trommi: true, scroll: 0 }, '', to) }
    else if (action === 'replace' || action === 'replace-after') { if (action === 'replace-after') saveScroll(); history[action === 'replace-after' ? 'pushState' : 'replaceState']({ trommi: true, scroll: 0 }, '', to) }
    if (res.kind === 'page') paint(to, res.opts, { scroll: scroll ?? (action === 'restore' ? history.state?.scroll ?? 0 : 'top') })
    else paint(to, { title: 'Not found · Trommi', view: 'missing', main: '<main id="inbox" aria-label="Not found"><header class="inbox-head"><div class="inbox-title"><h2>Not here.</h2><p><a href="/" data-nav>Back to the Desk</a></p></div></header></main>', model: board.t.model() })
    if (url.hash) document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView({ block: 'center' })
  }
  const saveScroll = () => { try { history.replaceState({ ...(history.state ?? {}), trommi: true, scroll: window.scrollY }, '') } catch {} }
  /** The page in view, rendered again from the model (a stream's "refresh", or after the room changed under it). */
  async function refresh() {
    if (!page) return
    const res = await board.request({ method: 'GET', path: page.path, headers: { accept: 'text/html' } })
    if (res.kind === 'page') { const y = window.scrollY, back = keepMenu(); paint(page.path, res.opts, { scroll: y }); back() }
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
  const frameOf = el => {
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
    const frame = frameOf(a)
    if (frame) {
      // A frame link with data-turbo-action also moves the address (a picture switched in place: ?pic=n survives a reload).
      const promote = a.getAttribute('data-turbo-action')
      return frameVisit(frame, url.pathname + url.search).then(() => { if (promote) { saveScroll(); history[promote === 'advance' ? 'pushState' : 'replaceState']({ trommi: true, scroll: window.scrollY }, '', url.pathname + url.search); if (page) page.path = url.pathname + url.search } })
    }
    visit(url.pathname + url.search + url.hash, { action: a.getAttribute('data-turbo-action') === 'replace' ? 'replace' : 'advance' })
  })

  // ---- tips ----
  // One tip for the whole app, in its own look (app.css ".tip"), never the browser's: what an element says in
  // data-tip, and what it says in title (taken over when the pointer first comes: the words move to data-tip, and to
  // aria-label where the element had no name). It comes after a short rest under the element, near the pointer on a
  // wide one, and goes with the pointer, a press, a key or a scroll. A mouse or a pen only; the keyboard's focus shows
  // it too. Not where a view draws its own from data-tip in CSS (the Scribble Board, the corner note).
  {
    const OWN = '.pad, .corner-note-head'
    let tip = null, of = null, timer = 0, px = 0
    const hide = () => { clearTimeout(timer); timer = 0; of = null; tip?.classList.remove('is-on') }
    const take = el => {
      const words = el.getAttribute('title')
      if (!words) return
      el.removeAttribute('title'); el.setAttribute('data-tip', words)
      if (!el.hasAttribute('aria-label') && !el.textContent.trim()) el.setAttribute('aria-label', words)
    }
    const show = () => {
      timer = 0
      const words = of?.isConnected ? of.getAttribute('data-tip') : ''
      if (!words) return hide()
      tip ??= document.body.appendChild(Object.assign(document.createElement('div'), { className: 'tip' }))
      tip.setAttribute('aria-hidden', 'true'); tip.textContent = words
      const r = of.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight, vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight
      const cx = r.width > 220 && px ? px : r.left + r.width / 2
      const below = r.bottom + 6 + h <= vh - 4 || r.top - 6 - h < 4
      tip.style.left = `${Math.round(Math.max(6, Math.min(vw - w - 6, cx - w / 2)))}px`
      tip.style.top = `${Math.round(below ? r.bottom + 6 : r.top - 6 - h)}px`
      tip.classList.add('is-on')
    }
    const aim = (el, wait) => {
      if (el === of) return
      hide()
      if (!el || el.closest(OWN)) return
      take(el)
      if (!el.getAttribute('data-tip')) return
      of = el; timer = setTimeout(show, wait)
    }
    const holder = t => t instanceof Element ? t.closest('[data-tip], [title]') : null
    document.addEventListener('pointerover', e => { if (e.pointerType === 'touch') return; px = e.clientX; aim(holder(e.target), 450) })
    document.addEventListener('pointermove', e => { px = e.clientX }, { passive: true })
    document.addEventListener('pointerdown', hide, true)
    document.documentElement.addEventListener('pointerleave', hide)
    document.addEventListener('keydown', hide, true)
    document.addEventListener('scroll', hide, { capture: true, passive: true })
    document.addEventListener('focusin', e => { const el = holder(e.target); if (el && e.target.matches?.(':focus-visible')) aim(el, 250) })
    document.addEventListener('focusout', hide)
    addEventListener('blur', hide)
  }

  // ---- forms ----
  async function submitForm(form, submitter) {
    const method = (submitter?.getAttribute('formmethod') ?? form.getAttribute('method') ?? 'get').toLowerCase()
    const action = new URL(submitter?.getAttribute('formaction') ?? form.getAttribute('action') ?? location.pathname, location.href)
    const data = new FormData(form, submitter ?? undefined)
    if (method === 'get') {
      const q = new URLSearchParams()
      for (const [k, v] of data) if (typeof v === 'string') q.append(k, v)
      const path = `${action.pathname}?${q}`
      const frame = frameOf(form)
      return frame ? frameVisit(frame, path) : visit(path)
    }
    const formSubmission = { formElement: form, submitter, method, location: action }
    fire(form, 'turbo:submit-start', { formSubmission })
    // A Desk row that is answered (or put off, thrown away, asked about) moves at once: the motion starts in this frame,
    // the answer's work (core, re-render) comes when the motion is done. If it
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

  // ---- the controllers' fetch() to the app's own routes ----
  const realFetch = window.fetch.bind(window)
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href)
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    if (url.origin !== location.origin || method !== 'POST' || !isAppPath(url.pathname)) return realFetch(input, init)
    if (url.pathname === '/note' || url.pathname === '/desk') {
      const body = JSON.parse(String(init.body ?? '{}'))
      const out = url.pathname === '/note' ? await board.t.hub.note(body) : await board.t.hub.desk(body).then(d => ({ code: 200, text: JSON.stringify(d) }), err => ({ code: err.status ?? 400, text: JSON.stringify({ error: sayError(err) }) }))
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
  // (forget: every part is painted anew on the next page, as on a first load; the demo's /screens switches a frame's state so)
  const forgetAll = () => { for (const part of parts.values()) for (const n of between(part)) n.remove(); parts.clear() }
  return { visit, refresh, changed, get page() { return page }, paint, keepPad, peek, forget: forgetAll }
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
  // One level for this device (the hub's push level, README "Push level"): off (no registration), all, knocking.
  // The menu's bell cycles Off → All → Only knocking; Settings · Push has the three as a switch.
  const LEVEL_KEY = 'trommi-push-level'
  const levelNow = () => { try { return localStorage.getItem(LEVEL_KEY) === 'all' ? 'all' : 'knocking' } catch { return 'knocking' } }   // (a fresh device: Only knocking)
  const words = { all: 'Yes', knocking: 'Only knocking', off: 'No' }
  const shown = async () => ((await subscription().catch(() => null)) ? levelNow() : 'off')
  const paintAll = v => {
    const bell = document.getElementById('push-toggle')
    if (bell) { bell.dataset.level = v; bell.setAttribute('aria-checked', String(v !== 'off')); const say = `Push on this device: ${words[v]}`; bell.title = `${say} (click: ${words[v === 'off' ? 'knocking' : v === 'knocking' ? 'all' : 'off']})`; bell.setAttribute('aria-label', say) }
    for (const r of document.querySelectorAll('#push-level input')) r.checked = r.value === v
  }
  const say = text => { const n = document.getElementById('push-level-note'); if (n) n.textContent = text; const m = document.getElementById('menu-push-note'); if (m) { m.textContent = text; m.hidden = !text } }
  async function applyLevel(v) {
    say('')
    try {
      const had = await subscription()
      if (v === 'off') {
        if (had) { await client.pushSubscribe(had.toJSON(), true).catch(() => {}); await had.unsubscribe() }
      } else {
        let sub = had
        if (!sub) {
          if (!client.hub?.pushKey) throw new Error('The demo has no push.')
          const why = obstacle()
          if (why) throw new Error(why)
          if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications were not allowed.')
          const reg = await navigator.serviceWorker.register('/sw.js')
          await navigator.serviceWorker.ready
          const { vapid_public_key } = await client.hub.pushKey()
          sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(vapid_public_key) })
        }
        await client.pushSubscribe(sub.toJSON(), false, v)
        try { localStorage.setItem(LEVEL_KEY, v) } catch {}
      }
    } catch (err) { say(sayError(err)) }
    paintAll(await shown())
    others()
  }
  const wire = async () => {
    const bell = document.getElementById('push-toggle')
    if (bell && !bell.dataset.push) {
      bell.dataset.push = '1'
      bell.addEventListener('click', async e => {
        e.stopPropagation()
        if (bell.getAttribute('aria-busy') === 'true') return
        bell.setAttribute('aria-busy', 'true')
        const v = bell.dataset.level || 'off'
        await applyLevel(v === 'off' ? 'knocking' : v === 'knocking' ? 'all' : 'off')   // Off → Only knocking → All
        bell.removeAttribute('aria-busy')
      })
    }
    const box = document.getElementById('push-level')
    if (box && !box.dataset.push) {
      box.dataset.push = '1'
      box.addEventListener('change', async e => { box.disabled = true; await applyLevel(e.target.value); box.disabled = false })
      others()
    }
    paintAll(await shown())
  }
  const others = async () => {
    const list = document.getElementById('push-others')
    if (!list) return
    let devices = {}
    try { devices = (await client.pushStates()).devices ?? {} } catch {}
    const me = client.model?.room?.my_device_id
    const humans = [...(client.model?.members?.values() ?? [])].filter(d => d.is_active && d.device_role === 'human' && d.device_id !== me)
    list.replaceChildren(...humans.map(d => {
      const st = devices[d.device_id], v = st ? st.level : 'off'
      const li = document.createElement('li')
      li.append(Object.assign(document.createElement('b'), { textContent: d.device_name || 'A device' }), Object.assign(document.createElement('span'), { textContent: `Push: ${words[v] ?? v}${st?.apns ? ' · iPhone app' : ''}` }))
      return li
    }))
  }
  document.addEventListener('turbo:load', wire)
  document.addEventListener('turbo:render', wire)
  wire()
}

// ---- pwa ----
// The app installed on a phone:
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


// The core runs in a Web Worker (core/core-worker.ts) and nowhere else: the room is verified, decrypted, reduced and
// stored there, and the page holds an exact copy of the model (core/remote.ts).
/* global __TROMMI_CORE_WORKER__ */
const CORE_WORKER = typeof __TROMMI_CORE_WORKER__ === 'string' ? __TROMMI_CORE_WORKER__ : '/gen/vendor/core-worker.mjs'
/** A share page: `/artifact/<share id>` (22 characters of base64url; 32 hex in the links of before). */
const SHARE_PAGE = /^\/artifact\/(?:[0-9a-f]{32}|[A-Za-z0-9_-]{22})$/
/** The stored room in the core worker: a RemoteClient, or null (no room stored). A browser without workers, or a
 *  worker that does not come up, fails with `worker-failed` / `worker-timeout`: the account screens word it. */
export async function openInWorker() {
  if (typeof Worker !== 'function') throw Object.assign(new Error('this browser runs no workers'), { code: 'worker-failed' })
  // (core-start.mjs, loaded before this module by index.html, started the worker already: taken over once)
  const started = globalThis.__trommiCore ?? null
  globalThis.__trommiCore = null
  return (await import('./gen/vendor/remote.mjs')).openRemote({ url: CORE_WORKER, storage: { name: 'trommi' }, client: CLIENT, early: started })
}

/** The core worker, started at the top of boot (not for the demo or a share page). */
let early = null
function startEarly() {
  let demo = false
  try { const q = new URLSearchParams(location.search); demo = q.has('mock') ? q.get('mock') !== '0' : Boolean(sessionStorage.getItem('trommi-mock')) } catch {}
  if (demo || SHARE_PAGE.test(location.pathname)) return null
  const p = openInWorker()
  p.catch(() => {})   // (awaited in openClient)
  return p
}

async function openClient() {
  if (mock) return (await import('./demo/demo.mjs')).openRoom({ mock })
  const remote = await (early ?? openInWorker())
  early = null
  return remote
}

async function start(client, { fresh = false } = {}) {
  attachTo(client)
  readAttachmentsWith(attachmentText)
  // The hub says this app is too old (426, or upgrade_required on the stream): a calm notice, reload takes the new build.
  client.on('error', err => { if (err?.code === 'client-too-old') notice('Please reload: this app needs a newer version.', err.message, true) })
  // README "Versioning and compatibility": something on the board was written by a newer Trommi (model.newer): it shows
  // as a placeholder in its place, and once per page a calm line offers the reload that brings the new build.
  let newerSaid = false
  const newerNotice = () => {
    if (newerSaid || !client.model?.newer?.count) return
    newerSaid = true
    notice('Some things here need a newer version of Trommi.', `${client.model.newer.what.join(', ')}: reload to update`, true, 'newer')
  }
  const board = new BoardState(client)
  board.update()
  let desk = read('trommi-desk')
  const hub = hubFacade(client, board)
  sharing = hub
  sharesLoaded()
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
    // (the Scribble Board's own switch, whiteboard.mjs: a desk's card on All desks, and the way back; the board stays open)
    t.get(/^\/scribble-board$/, ({ res, url }) => { const d = url.searchParams.get('desk'); if (d == null) return false; desk = d; write('trommi-desk', d); if (d !== ALL_DESKS) write('trommi-desk-last', d); t.redirect(res, '/scribble-board') })
  } }
  // (the demo only: the review page of all screens, and ?state= hooks: demo/demo.mjs)
  const demo = mock ? await import('./demo/demo.mjs') : null
  if (demo) { demo.screensController({ Controller, controller }); const state = new URLSearchParams(location.search).get('state'); if (state) document.addEventListener('turbo:load', () => demo.demoState(state), { once: true }) }
  const b = createBoard({ hub, model, views: [desks, ...(demo ? [demo.screensView] : []), ...VIEWS] })
  const router = createRouter({ board: b, flush: () => apply() })
  startPush(client)
  window.trommi = { client, board, router, model, mock: Boolean(mock), view, ...(demo ? { demoState: demo.demoState } : {}) }   // (view: a lazy view's module, for the dev tools)
  // The Emergency Kit's page comes first while the account's kit was never saved (auth.mjs kitGate: the register `kit`,
  // or this browser's mark from the moment the account was asked for): at the start, and when the register arrives.
  // (the register is looked at only once the client has started: before that the model is the cache's, which may
  //  not yet show a kit saved just before the page was loaded again; the client lays its own unsent writes over it
  //  as it starts, client.ts restoreRegisters. This browser's mark needs no wait.)
  const started = () => client.model.room.connection !== 'offline'
  const kitWatch = () => { if (!mock && client.model.room.my_role === 'human' && (read('trommi-kit-pending') === '1' || (started() && client.model.human?.raw?.get('kit')?.value?.pending === true))) view('auth').then(v => v.kitGate(client)).catch(err => console.warn('kit', err)) }
  client.on('change', change => { if (change.registers?.has?.('kit') || change.room) kitWatch() })
  kitWatch()

  // Changes come in batches; one frame patches the page for all that came meanwhile. A navigation or the end of a
  // form takes what is pending at once (flush), so a page never renders a state older than the action that led to it.
  let pending = null, frame = 0
  const merge = (a, c) => { for (const k of Object.keys(c)) { if (c[k] instanceof Set) for (const v of c[k]) a[k].add(v); else a[k] = a[k] || c[k] } return a }
  const conn = () => {
    const state = client.model.room.connection, el = document.getElementById('conn'), text = document.getElementById('conn-text')
    const words = { live: ['online', 'Connected'], catching_up: ['connecting', 'Catching up'], connecting: ['connecting', 'Connecting'], offline: ['offline', 'No connection'], unreachable: ['offline', 'Can\'t reach your room'], removed: ['offline', 'Removed'] }[state] ?? ['connecting', 'Connecting']
    if (el) el.dataset.state = words[0]
    if (text) text.textContent = words[1]
    // This device processed the Commit that took it out of the room: the notice, and every local trace goes
    // (auth.mjs removedScreen). The hub's word alone is `unreachable`: said neutrally, everything kept.
    if (state === 'removed' && !mock) view('auth').then(v => v.removedScreen(client)).catch(err => console.warn('removed', err))
    if (state === 'unreachable') notice('Can\'t reach your room right now. Everything on this device is kept.', 'The hub no longer answers this device for this room, and nothing it showed says why.', false, 'unreachable')
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
  // it is rendered whole every CATCH_UP_MS and once more when the room is live. Patching per batch would make a big room's
  // first load quadratic (every batch diffs the Desk and measures its rows again).
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
  // the invite's page (auth.mjs); without this it would show only while that page stays open.
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
    if (change.room) newerNotice()
    if (!pending) pending = merge({ cards: new Set(), sessions: new Set(), permissions: new Set(), notes: new Set(), published: new Set(), timelines: new Set(), registers: new Set(), invites: new Set() }, change)
    else merge(pending, change)
    if (catchingUp()) { if (!wasCatchingUp) { wasCatchingUp = true; conn() } catchUpTimer ||= setTimeout(renderWhole, CATCH_UP_MS); return }
    if (wasCatchingUp) { wasCatchingUp = false; clearTimeout(catchUpTimer); renderWhole(); return }
    frame ||= requestAnimationFrame(() => apply())
  })
  document.addEventListener('turbo:load', conn)
  document.addEventListener('turbo:load', newerNotice, { once: true })
  // The card page's thread is fetched when it is opened (newest page first; "Earlier comments" loads more). A session's
  // page loads its own (session.mjs, before its first render). The Desk's Working stack says each card's last
  // word: the newest few items of the cards with their session.
  const opened = new Set()
  const load = (key, limit) => { if (opened.has(key)) return; opened.add(key); client.loadTimeline(key, { limit }).catch(err => console.warn('timeline', err)) }
  const loadOpen = () => {
    const path = location.pathname
    const q = /^\/(?:chat\/[^/]+\/)?card\/([\w-]+)/.exec(path)
    if (q) { const card = model().cardByRef(decodeURIComponent(q[1])); if (card) load(`chat:card/${card.id}`, 50) }
    if (path === '/') for (const c of model().revising ?? []) load(`chat:card/${c.id}`, 5)
  }
  document.addEventListener('turbo:load', loadOpen)

  await router.visit(location.pathname + location.search + location.hash, { action: 'replace' })
  window.trommi.firstPaintMs = performance.now() - T0
  window.trommi.openMs = OPEN_MS
  window.trommi.readyAt = performance.now()   // since navigation start: cold or warm load to the painted page
  document.documentElement.dataset.ready = ''
  fontsAfterPaint()
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

// ---- fonts ----
// The web fonts come after the first paint (a cold start on a slow line spends its bandwidth on the app first): the page
// paints in the metric-matched fallbacks of fonts/fallback.css, then fonts/fonts.css is added (its fonts swap in,
// font-display: swap; the service worker keeps them for later starts). At the latest FONTS_MS after boot.
const FONTS_MS = 3000
let fontsLoaded = false
function loadFonts() {
  if (fontsLoaded) return
  fontsLoaded = true
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = '/fonts/fonts.css'
  document.head.append(link)
}
const fontsAfterPaint = () => requestAnimationFrame(() => setTimeout(loadFonts, 0))

/** The page starts here (index.html loads this module; importing it elsewhere, as tests in Node do, does nothing). */
async function boot() {
  T0 = performance.now()
  // An address of before (/s/…, /a/…; paths.mjs): the address bar shows its new form from the start.
  const moved = movedPath(location.pathname)
  if (moved) history.replaceState(history.state, '', `${moved}${location.search}${location.hash}`)
  setTimeout(loadFonts, FONTS_MS)
  // The core worker starts first, beside everything below: the room is being read while the page sets itself up.
  early = startEarly()
  await workLoaded
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
  // A link for someone outside the room (/artifact/<share_id>#…): its own small page, no room needed.
  if (SHARE_PAGE.test(location.pathname)) return (await view('media')).showShare()
  // A room that is stored but does not open is never shown as "not logged in": the start page would offer Log in, which
  // this storage refuses (it holds a room). The room screen says what failed and offers Retry and Log out of this device.
  // (the demo's account screens, /screens: ?mock=1&onboard=<state> draws one of them; no account, nothing sent)
  const onboard = mock && params.get('onboard')
  if (onboard) { fontsAfterPaint(); return (await view('auth')).roomScreen({ start: async () => {}, hub: 'mock:', demo: onboard }) }
  let openError = null
  const client = await openClient().catch(err => { console.error('open', err); openError = err; return null })
  OPEN_MS = performance.now() - T0   // the room from storage (or the demo's fixture) in memory
  if (client) { keepStorage(); await start(client) }
  // (the core's self test needs no room: by its address it opens on a device that is not logged in too)
  else if (PROOF_PATH.test(location.pathname)) { fontsAfterPaint(); (await view('proof')).proofScreen() }
  else { fontsAfterPaint(); await (await view('auth')).roomScreen({ start: async (c, o) => { keepStorage(); return start(c, o) }, hub: hubUrl(), openError }) }
}
if (typeof window !== 'undefined') boot()

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
