// The page: navigation with real addresses, a session's two modes and the filters of its
// conversation, theme, connection feedback, and the glue between conversation and scribble.

import { connect, subscribe, getState, setState, isLoaded, setScope, reopen, sendScribble, loadCanvas, saveCanvas } from './store.js'
import { mountAgents, avatar, pairAvatar, crownToggle, tellApart, openMarkPicker, openEditor, summary } from './agents.js'
import { mountInbox } from './inbox.js'
import { el, sketch, setAssetSource, isKnock, knocksText, WALK_WORD } from './ui.js'
import { mountChat } from './chat.js'
import { provide, openSheet } from './keys.js'
import { say, pageHost, backNow } from './back.js'
import { togglePad, toggleCards } from './padlink.js'
import { startDictation, stopDictation, isDictating, readAloud } from './speech.js'
import { linkTo, sessionPath } from './link.js'

// Links to published assets are named from what the board knows of them.
setAssetSource(() => getState().all)

// The side door to the administration carries a small scribbled key: it opens with a key of its own.
document.querySelector('.sidedoors a[href="/admin.html"]')?.prepend(sketch('key'))

const $ = id => document.getElementById(id)
const root = document.documentElement
const body = document.body
const toast = $('toast')
const flags = new Set(location.hash.slice(1).split(',').filter(Boolean))
const store = (key, value) => { try { localStorage.setItem(key, value) } catch {} }
const phone = matchMedia('(max-width: 860px)')

// ---- theme: light unless the user chose dark -------------------------------

const themeToggle = $('theme-toggle')
function paintTheme() {
  const dark = root.dataset.theme === 'dark'
  themeToggle.setAttribute('aria-pressed', String(dark))
  themeToggle.setAttribute('aria-label', dark ? 'Switch to the light theme' : 'Switch to the dark theme')
  themeToggle.title = dark ? 'Light theme' : 'Dark theme'
  const surface = getComputedStyle(root).getPropertyValue('--surface').trim()
  if (surface) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', surface)
}
themeToggle.addEventListener('click', () => {
  const dark = root.dataset.theme !== 'dark'
  root.classList.add('theme-switch')   // suppress per-element transitions for one frame
  if (dark) root.dataset.theme = 'dark'
  else delete root.dataset.theme
  store('agent-board-theme', dark ? 'dark' : 'light')
  paintTheme()
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switch')))
})
paintTheme()

// ---- addresses: every place has a real one, so a reload and a shared link land on it ----
//   /                      the inbox
//   /agents                the overview of all sessions
//   /s/<id>                a session's conversation; /s/<id>+<id> sessions laid together
//   /s/<id>/questions      the conversation filtered to its questions; /files likewise
//   /s/<id>/scribble       its canvas
//   …/q/<card number>      on any of them: that question open in its own window (/q/102, /s/<id>/q/102)
//   …/walk                 on any of them: the walk through all open questions
// Older links still work and are rewritten in place: ?q=102, ?q=<card id>, ?q=next, /q/<card id>.
// Where no server answers these paths (the page as plain files), the same routes stand behind "#":
// index.html#/s/<id>/q/102. A page opened that way keeps writing them that way.

const hashRoutes = location.protocol === 'file:' || location.hash.startsWith('#/')
// May the question be written as a path? Only once the server is known to serve /q/… as the page (a hub
// from before that keeps ?q=, so a reload never lands on nothing). Asked once per tab; see below.
let pathsOk = hashRoutes
try { pathsOk ||= sessionStorage.getItem('trommi-paths') === '1' } catch {}

function readAddress() {
  const route = location.hash.startsWith('#/') ? location.hash.slice(1).split('?')[0] : hashRoutes ? '/' : location.pathname
  const parts = route.split('/').filter(Boolean)
  const decode = s => { try { return decodeURIComponent(s) } catch { return s } }
  let q = new URLSearchParams(location.search).get('q')
  // The end of the path may name a question or the walk (in a session only after its id: /s/walk is a session).
  const least = parts[0] === 's' ? 2 : 0
  if (parts.length > least && parts.at(-1) === 'walk') { q = 'next'; parts.pop() }
  else if (parts.length - 2 >= least && parts.at(-2) === 'q') { q = decode(parts.at(-1)); parts.splice(-2) }
  if (parts[0] === 'agents') return { page: 'roster', ids: [], view: 'chat', filter: null, q }
  if (parts[0] === 's' && parts[1]) {
    const tail = parts[2]
    return { page: null, ids: parts[1].split('+').map(decode), view: tail === 'scribble' ? 'scribble' : 'chat', filter: tail === 'questions' || tail === 'files' ? tail : null, q }
  }
  return { page: null, ids: [], view: 'chat', filter: null, q }
}
let focusCard = null   // the question the address names: a card id, "next" (the walk), or null
// A question is named by its number or, as older links do, by its id.
const cardOf = q => (/^\d+$/.test(q) && getState().all.cards.find(c => c.number === Number(q))?.id) || q
function addressNow() {
  const state = getState()
  let path = '/'
  if (body.dataset.page === 'roster') path = '/agents'
  else if (state.members.length) {
    path = `/s/${state.members.map(encodeURIComponent).join('+')}`
    const tail = body.dataset.view === 'scribble' ? 'scribble' : body.dataset.filter
    if (tail) path += `/${tail}`
  }
  const params = new URLSearchParams(location.search)
  // The address names a question by its number, as the board does everywhere else (/q/102).
  const nr = focusCard && focusCard !== 'next' ? String(state.all.cards.find(c => c.id === focusCard)?.number ?? focusCard) : null
  params.delete('q')
  // (Not over the Agents page: the server serves no /agents/q/…, so there the question stays in the query.)
  if (focusCard && pathsOk && path !== '/agents') path = `${path === '/' ? '' : path}${nr ? `/q/${encodeURIComponent(nr)}` : '/walk'}`
  else if (focusCard) params.set('q', nr ?? 'next')
  const query = params.toString()
  if (hashRoutes) return `${location.pathname}${query ? `?${query}` : ''}#${path}`
  return path + (query ? `?${query}` : '') + location.hash
}
// ---- history: every entry is a page, and remembers how far it was scrolled ----
// Each entry carries a key (history.state.k), whoever writes it (this file, chat.js, ledger.js, bar.js,
// padlink.js: pushState and replaceState are wrapped here, once). Under that key the scroll positions of the
// lists in view are kept (per tab, sessionStorage): Back and Forward put them back, as with real pages.
const SCROLLERS = ['#inbox', '#ledger', '#chat .chat-pane .log', '#chat .pane-list']
const SCROLL_KEY = 'trommi-scroll'
let scrolls = {}
try { scrolls = JSON.parse(sessionStorage.getItem(SCROLL_KEY) ?? '{}') ?? {} } catch {}
let keySeq = 0
const newKey = () => `${Date.now().toString(36)}-${++keySeq}`
let entryKey = history.state?.k ?? newKey()
{
  const push = history.pushState.bind(history), replace = history.replaceState.bind(history)
  history.pushState = (state, title, url) => { entryKey = newKey(); push({ ...state, k: entryKey }, title, url) }
  history.replaceState = (state, title, url) => replace({ ...state, k: entryKey }, title, url)
  if (!history.state?.k) history.replaceState(history.state, '')
}
function saveScroll() {
  const at = {}
  for (const sel of SCROLLERS) {
    document.querySelectorAll(sel).forEach((node, i) => {
      if (!node.getClientRects().length) return
      // A list read at its end (a conversation) is kept at its end, whatever arrives in between.
      at[`${sel}|${i}`] = node.scrollHeight - node.scrollTop - node.clientHeight < 4 && node.scrollTop > 0 ? 'end' : Math.round(node.scrollTop)
    })
  }
  scrolls[entryKey] = at
  const keys = Object.keys(scrolls)
  for (const old of keys.slice(0, Math.max(0, keys.length - 60))) delete scrolls[old]
  try { sessionStorage.setItem(SCROLL_KEY, JSON.stringify(scrolls)) } catch {}
}
function restoreScroll() {
  const at = scrolls[entryKey]
  if (!at) return
  const put = () => {
    for (const [name, top] of Object.entries(at)) {
      const [sel, i] = name.split('|')
      const node = document.querySelectorAll(sel)[Number(i)]
      if (node?.getClientRects().length) node.scrollTop = top === 'end' ? node.scrollHeight : top
    }
  }
  // Now, and again once the view has laid itself out (a conversation settles a frame later).
  put()
  requestAnimationFrame(() => requestAnimationFrame(put))
  setTimeout(put, 180)
}
window.addEventListener('pagehide', saveScroll)
// Kept as one scrolls (a step in the page has changed the view before its entry is written, so that moment
// is too late): what a scroll changes belongs to the entry that stands when the frame is drawn.
let scrollSaving = 0
window.addEventListener('scroll', () => { scrollSaving ||= requestAnimationFrame(() => { scrollSaving = 0; if (!stepping) saveScroll() }) }, { capture: true, passive: true })

/** Write the place the page shows into the address bar: a new entry for a step the human took, else in place. */
function writeAddress(step = true) {
  paintDocTitle()
  if (location.pathname === '/pad') return   // the pad lies over the page and holds the address (padlink.js)
  if (/^\/s\/[^/+]+\/files\/\d+$/.test(location.pathname)) return   // a picture is open as a page and holds the address (chat.js)
  const url = addressNow()
  if (url === location.pathname + location.search + location.hash) return
  // state.q says "this entry was made by opening a card, so closing it goes back". An address rewritten in
  // place keeps what its entry was: one arrived on directly (/s/<id>/q/<n>) has nothing to go back to.
  history[step ? 'pushState' : 'replaceState']({ q: step || history.state?.q ? focusCard : null }, '', url)
}
// Does the server serve the page under /q/…? Then questions are written as paths from now on, and the
// address that stands is put right in place.
if (!pathsOk) {
  fetch('/q/0', { headers: { Accept: 'text/html' } }).then(res => {
    if (!res.ok || res.redirected || !/text\/html/.test(res.headers.get('content-type') ?? '')) return
    pathsOk = true
    try { sessionStorage.setItem('trommi-paths', '1') } catch {}
    if (isLoaded()) writeAddress(false)
  }).catch(() => {})
}

// ---- modes: a session fills the page with its conversation or its canvas ----
// The conversation has two filters that lay a list over it: its questions only, or its files.

const VIEWS = ['chat', 'scribble']
const FILTERS = ['questions', 'files']
const switches = VIEWS.map(view => [view, [$(`tab-${view}`), $(`mode-${view}`)]])
const chatDot = $('chat-dot')
let chat = null

function paintView() {
  const view = body.dataset.view
  const filter = body.dataset.filter
  for (const [name, buttons] of switches) {
    for (const button of buttons) {
      if (name === view) button.setAttribute('aria-current', 'page')
      else button.removeAttribute('aria-current')
    }
  }
  for (const name of FILTERS) $(`filter-${name}`).setAttribute('aria-pressed', String(view === 'chat' && filter === name))
  const unread = (view !== 'chat' || Boolean(filter)) && Boolean(chat?.unread())
  chatDot.hidden = !unread
  $('mode-chat').toggleAttribute('data-unread', unread)
  paintLinks()
}
// The switches and the filters are real links (js/link.js): each carries the address it leads to, for the
// session in view. A filter that is on leads back to the whole conversation, as its click does.
function paintLinks() {
  const ids = getState().members
  const base = ids.length ? sessionPath(ids) : '/'
  const on = body.dataset.view === 'chat' ? body.dataset.filter : null
  for (const [name, links] of switches) for (const a of links) linkTo(a, ids.length && name === 'scribble' ? `${base}/scribble` : base)
  for (const name of FILTERS) linkTo($(`filter-${name}`), ids.length && on !== name ? `${base}/${name}` : base)
}
function showView(view, filter = null) {
  body.dataset.view = view
  if (filter && view === 'chat') body.dataset.filter = filter
  else delete body.dataset.filter
  paintView()
  chat?.settle()
  if (!toast.hidden) requestAnimationFrame(placeToast)
  if (view === 'scribble') syncCanvas()
}
function setView(view, filter = null) {
  showView(view, filter)
  writeAddress()
}
for (const [name, buttons] of switches) for (const button of buttons) button.addEventListener('click', () => setView(name))
// A filter is a toggle: pressed again, the whole conversation is back where it was.
for (const name of FILTERS) {
  $(`filter-${name}`).addEventListener('click', () => setView('chat', body.dataset.view === 'chat' && body.dataset.filter === name ? null : name))
}

// A card named in the conversation that is no longer open: show it among the session's questions.
function openCard(cardId) {
  const card = getState().all.cards.find(c => c.id === cardId)
  if (!card) return
  setView('chat', 'questions')
  pickMember(card.agent)
  chat.reveal(cardId, card.agent)
}

// ---- scribble: the session's canvas ----------------------------------------

let scribble = null   // the mounted canvas, loaded on first use
let member = null     // in a group: the session a phone shows and the canvas belongs to

/** The one session the canvas (and on a phone the conversation) is about. */
function memberNow(state = getState()) {
  return state.members.includes(member) ? member : state.members[0] ?? null
}
function pickMember(id) {
  if (!getState().members.includes(id)) return
  member = id
  chat.setMember(id)
  titleSig = ''
  paintTitle(getState())
  if (body.dataset.view === 'scribble') syncCanvas()
}

let scribbleMounting = null   // the mount under way: asked twice before it is done, it is still one canvas
function mountScribblePane() { return (scribbleMounting ??= mountScribbleOnce()) }
async function mountScribbleOnce() {
  if (scribble) return scribble
  try {
    const { mountScribble } = await import('./scribble.js')
    scribble = mountScribble($('scribble'), {
      // The server keeps the canvas, one per session; no local draft needed.
      draftKey: null,
      onChange: doc => { if (canvasAgent) saveCanvas(canvasAgent, doc).catch(() => {}) },
      send: async payload => {
        const agent = canvasAgent
        if (!agent) throw new Error('Pick a session first.')
        await sendScribble(payload, agent)
        // The explanation goes into the conversation, so take the human there: the scribble
        // stands in the log as sent, and the composer asks for the words to go with it.
        setView('chat')
        chat.focus('What do you mean by the scribble?', agent)
      },
    })
  } catch (err) {
    console.error(err)
    $('scribble').replaceChildren(el('p', 'scribble-fallback', 'The scribble board could not be loaded.'))
  }
  return scribble
}

// Put the canvas of the session in view on the board. A change to the previous session's
// canvas that is still waiting is saved first, under that session; then, until the new canvas
// has arrived (canvasAgent is null), nothing is saved, so a half-loaded board never overwrites one.
let canvasAgent = null
let canvasWanted = null
async function syncCanvas() {
  const agent = memberNow()
  if (!agent) return
  const board = await mountScribblePane()
  if (!board || memberNow() !== agent || agent === canvasAgent || agent === canvasWanted) return
  board.flush()
  canvasAgent = null
  canvasWanted = agent
  try {
    const doc = await loadCanvas(agent)
    if (memberNow() !== agent) return
    if (doc) board.load(doc)
    else board.clear()
    canvasAgent = agent
  } catch (err) {
    showToast('error', err.message, 4000)
  } finally {
    if (canvasWanted === agent) canvasWanted = null
  }
}

// Focus: the open questions as one full page each. Loaded on first use.
// Without a card it walks through all of them. With one ("Choose" on a row) it is the window
// of that one card: it closes on the answer, and the list offers to take the answer back.
let focusMode = null
let routing = false   // the address is being followed, not written
let stepping = 0      // a step under way that writes its own entry when it is through (walkSession)
async function openFocus(cardId, step = true, { ask = false, revise = false, gallery = false } = {}) {
  try {
    focusMode ??= (await import('./focus.js')).mountFocus({ onDecided: offerUndo })
    // Opened for its pictures: only if the window can show them at once (focus.js gallery()); the caller
    // hears false otherwise and shows them its own way.
    if (gallery && !focusMode.gallery) return false
    // Revise, with a card named: it is handed back at once (a note with the way back), no window.
    if (revise && cardId) return focusMode.revise(cardId)
    focusMode.open(cardId ?? undefined)
    if (!focusMode.isOpen()) return false
    if (ask) focusMode.ask()   // opened to ask back: the line for it is ready
    if (revise) focusMode.revise?.()   // opened to revise: Discuss is open and asks what should change
    focusCard = cardId ?? 'next'
    writeAddress(step)
    return gallery ? focusMode.gallery() !== false : true
  } catch (err) {
    console.error(err)
    showToast('error', 'The focus window could not be loaded.', 4000)
  }
}
// Closed by hand: leave the entry the window made, so "back" does not open it again.
document.addEventListener('focus:close', () => {
  if (!focusCard) return
  focusCard = null
  paintDocTitle()
  if (routing) return
  if (history.state?.q) history.back()
  else {
    // Arrived on this address directly: no entry to go back to. The card's part is cut from the address
    // that stands (not rebuilt from the state, which may not hold the session yet), and it is followed.
    const path = location.pathname.replace(/\/(q\/[^/]+|walk)$/, '') || '/'
    const params = new URLSearchParams(location.search)
    params.delete('q')
    history.replaceState({}, '', path + (params.size ? `?${params}` : '') + location.hash)
    followAddress()
  }
})
$('focus-open').addEventListener('click', () => openFocus())

chat = mountChat($('chat'), {
  onOpen: (id, how) => openFocus(id, true, how), onDecided: offerUndo, onCard: openCard,
  onScribble: agent => { pickMember(agent); setView('scribble') },
  onUnread: paintView, onError: text => showToast('error', text, 6000), flags,
})
/** Go through the open questions of one session (of sessions laid together: of all of them), the most
 *  urgent first, in the question window. The walk follows the scope, so the session is picked first;
 *  the address then names both (/s/<id>?q=next). For the sidebar's state badges, and for whoever else
 *  shows a session's count (import { walkSession } from './app.js'). */
export async function walkSession(id) {
  // One step, one entry: the window writes it once it is open (/s/<id>/walk). Until then the address is not
  // rewritten in place for the session alone, which would write over the entry the human is leaving.
  stepping++
  let opened
  try {
    setScope(id)
    showPage(null)
    showView('chat')
    opened = await openFocus()
  } finally { stepping-- }
  if (!opened) writeAddress()   // nothing to walk through: the step is the session
  return opened
}
/** Going to another place leaves the card that is open (a Desk row unfolded, the window): it is not taken along
 *  into the new address, and Back finds it again under its own. */
function leaveCard() {
  if (!focusCard && !focusMode?.isOpen()) return
  routing = true
  try { focusMode?.close() } finally { routing = false }
  focusCard = null
}
const agents = mountAgents($('agents'), { onSelect: id => { leaveCard(); showPage(null); showView('chat'); writeAddress(); if (id == null) $('inbox').scrollTop = 0 }, onWalk: walkSession })
const inbox = mountInbox($('inbox'), { onOpen: (id, how) => openFocus(id, true, how), onGallery: id => openFocus(id, true, { gallery: true }), onDecided: offerUndo })

// The title of the pane: which session this is, by its mark and name. For sessions laid
// together, their joint mark and each name; a name picks that one for the canvas, and on a
// phone for the one column there is room for.
const paneTitle = $('pane-who')
let titleSig = ''
function paintTitle(state) {
  const members = state.members.map(id => state.all.agents.find(a => a.id === id)).filter(Boolean)
  const picked = memberNow(state)
  // Sessions of the same name carry what tells them apart, as in the sidebar.
  const apart = members.length > 1 ? tellApart(state.all.agents) : new Map()
  // Who of them is at work: their mark in the title redraws itself, as in the sidebar.
  const working = members.filter(a => summary(state.all, [a]).running).map(a => a.id)
  const sig = JSON.stringify([members.map(a => [a.id, a.name, a.mark, a.online, a.task, a.starred, apart.get(a.id)]), members.length > 1 && picked, working])
  if (sig === titleSig) return
  titleSig = sig
  paintLinks()
  body.toggleAttribute('data-pair', members.length > 1)
  if (!members.length) return paneTitle.replaceChildren()
  if (members.length === 1) {
    const [agent] = members
    paneTitle.title = agent.online ? agent.task || '' : 'disconnected'
    // The picture opens the choice of drawing right under it; the name is the way to rename.
    const mark = el('button', 'pane-mark')
    mark.type = 'button'
    mark.title = 'Choose a drawing'
    mark.setAttribute('aria-label', `${agent.name}: choose a drawing`)
    mark.setAttribute('aria-haspopup', 'dialog')
    mark.append(avatar(agent, { vip: false, working: working.includes(agent.id) }))
    mark.addEventListener('click', () => openMarkPicker(agent, mark))
    const name = el('button', null, agent.name)
    name.type = 'button'
    name.title = 'Rename'
    name.addEventListener('click', () => openEditor(agent))
    const heading = el('h2', 'pane-name')
    heading.append(name)
    // The crown on the mark's corner is a switch of its own (agents.js crownToggle): a click puts it on
    // or takes it off. Nothing stands next to the name.
    return paneTitle.replaceChildren(mark, crownToggle(agent), heading)
  }
  paneTitle.title = ''
  const names = el('h2', 'pane-members')
  members.forEach((a, i) => {
    if (i) names.append(el('span', null, '+'))
    const b = el('button', null, a.name)
    b.type = 'button'
    if (apart.get(a.id)) b.append(el('small', null, apart.get(a.id)))
    b.setAttribute('aria-pressed', String(a.id === picked))
    b.addEventListener('click', () => { pickMember(a.id); if (body.dataset.view === 'chat' && !phone.matches) chat.focus(null, a.id) })
    names.append(b)
  })
  paneTitle.replaceChildren(pairAvatar(members, working), names)
}

// The bar's own navigation: the inbox and the list of agents.
function showPage(page) {
  if (page) body.dataset.page = page
  else delete body.dataset.page
  paintNav(getState())
  agents.render(getState())
  requestAnimationFrame(() => $('agents').querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest', inline: 'center' }))
}
function paintNav(state) {
  const page = body.dataset.page
  $('nav-inbox').toggleAttribute('aria-current', !page && !state.scope)
  for (const id of ['nav-roster', 'roster-open']) $(id).toggleAttribute('aria-current', page === 'roster')
}
// (A place gone to anew starts at its top, like a page; Back and Forward bring the position back.)
$('nav-inbox').addEventListener('click', () => { const was = location.pathname; leaveCard(); setScope(null); showPage(null); writeAddress(); if (location.pathname !== was) $('inbox').scrollTop = 0 })
$('nav-roster').addEventListener('click', () => { leaveCard(); showPage('roster'); writeAddress() })
// Phones have no bar with words; there one icon opens the overview and closes it again.
$('roster-open').addEventListener('click', () => { leaveCard(); showPage(body.dataset.page === 'roster' ? null : 'roster'); writeAddress() })

// Follow the address: on arrival, and when the human goes back or forward.
function followAddress(first = false) {
  const to = readAddress()
  routing = true
  if (!to.q) focusCard = null
  setScope(to.ids[0] ?? null)
  showPage(to.page)
  // A deep link from before there were addresses may still ask for a mode by hash flag.
  if (first && !to.ids.length && !to.page) showView(flags.has('scribble') ? 'scribble' : 'chat', flags.has('decisions') ? 'questions' : flags.has('files') ? 'files' : null)
  else showView(to.view, to.filter)
  if (to.q && isLoaded()) {
    // Back or forward onto a card of the Desk on a wide screen: it unfolds in its row again, as it was.
    const id = to.q === 'next' ? null : cardOf(to.q)
    const text = !first && id && !to.ids.length && !to.page && !matchMedia('(max-width: 860px)').matches
      ? document.querySelector(`#inbox .inbox-group[data-sender] .inbox-row[data-id="${CSS.escape(id)}"] .inbox-text`) : null
    if (text) text.click()
    else openFocus(id, false)
  } else if (!to.q && focusMode?.isOpen()) focusMode.close()
  routing = false
  paintDocTitle()
  return to
}
window.addEventListener('popstate', () => {
  // Back or Forward (the entry in view changed): the entry left keeps its scroll positions, the one arrived
  // on gets its own back. A step taken in the page (pushState, then this event by hand) is no such move.
  const moved = (history.state?.k ?? null) !== entryKey
  if (moved) { saveScroll(); entryKey = history.state?.k ?? newKey(); if (!history.state?.k) history.replaceState(history.state, '') }
  followAddress()
  if (moved) restoreScroll()
})

// ---- open count: what still needs the human, in the title and on the filter ----

function paintCount(state) {
  const here = state.scope ? state.queue.filter(id => !state.later.includes(id)).length : 0
  $('filter-count').textContent = here ? (here > 99 ? '99+' : String(here)) : ''
  $('filter-questions').setAttribute('aria-label', here ? `Questions only, ${here} open` : 'Questions only')
  paintDocTitle(state)
}
// The tab's title: what waits, then the place, so tabs can be told apart:
// "(5 knocks) Desk · Trommi", "(3) web-frontend · Trommi", "Nr. 164 · <the question> · Trommi".
function paintDocTitle(state = getState()) {
  if (!isLoaded()) return
  const fresh = state.all.queue.filter(id => !state.later.includes(id)).length
  // Knocks (urgent and blocking questions) come first in the title, as everywhere.
  const knocking = state.all.cards.filter(c => c.status === 'open' && isKnock(c) && state.all.queue.includes(c.id) && !state.later.includes(c.id)).length
  const waits = knocking ? `(${knocksText(knocking)}) ` : fresh ? `(${fresh}) ` : ''
  const card = focusCard && focusCard !== 'next' ? state.all.cards.find(c => c.id === focusCard) : null
  const names = state.members.map(id => state.all.agents.find(a => a.id === id)?.name ?? id).join(' + ')
  const desk = state.all.desks?.length > 1 ? state.all.desks.find(d => d.id === state.all.desk)?.name : null
  const place = card ? `Nr. ${card.number} · ${card.title}`
    : focusCard === 'next' ? [WALK_WORD, names].filter(Boolean).join(' · ')
    : location.pathname === '/pad' ? 'Scratchpad'
    : body.dataset.page === 'roster' ? 'Agents'
    : names ? [names, body.dataset.view === 'scribble' ? 'Scribble' : body.dataset.filter === 'questions' ? 'Questions' : body.dataset.filter === 'files' ? 'Files' : ''].filter(Boolean).join(' · ')
    : desk && desk.trim().toLowerCase() !== 'desk' ? `Desk · ${desk}` : 'Desk'   // (the first desk is named "Desk": not said twice)
  const title = `${waits}${place} · Trommi`
  if (document.title !== title) document.title = title
}

// ---- connection feedback ---------------------------------------------------

const conn = $('conn')
const connText = $('conn-text')
const CONN_TEXT = { connecting: 'Connecting', online: 'Connected', offline: 'Disconnected, reconnecting' }
let wasOnline = false
let connCalls = 0
let toastTimer = 0

// The connection is told by the pill in the bar alone; it turns red while the stream is down.
function paintConn(online) {
  // The very first call is the store's initial value; a later "not online" means the stream failed.
  const state = online ? 'online' : wasOnline || connCalls > 0 ? 'offline' : 'connecting'
  connCalls++
  if (online) wasOnline = true
  if (conn.dataset.state === state) return
  conn.dataset.state = state
  connText.textContent = CONN_TEXT[state]
}

// The one passing notice of the page: an answer that can still be taken back, or something that
// went wrong. On a wide screen it stands in the empty foot of the sidebar, above the bar; on a
// phone just above whatever is fixed to the bottom: the tab bar or the composer. It never covers
// a title or the first rows.
function placeToast() {
  let top = window.innerHeight
  for (const node of document.querySelectorAll(phone.matches ? '.tabbar, .dock, .scr-dock' : '.topbar')) {
    const box = node.getBoundingClientRect()
    if (box.height && box.top > window.innerHeight / 2) top = Math.min(top, box.top)
  }
  toast.style.setProperty('--toast-bottom', `${Math.round(window.innerHeight - top)}px`)
}
function showToast(kind, text, ms, action) {
  clearTimeout(toastTimer)
  placeToast()
  toast.dataset.kind = kind
  const line = el('span')
  line.append(text)
  toast.replaceChildren(el('i'), line)
  if (action) toast.append(action)
  toast.hidden = false
  if (ms) toastTimer = setTimeout(() => { toast.hidden = true }, ms)
}
// A question answered in a list (or in the window of one card): the note at the top left says so and
// takes the answer back for a few seconds ("Back", see back.js). Later the list of answered questions does.
function offerUndo(card, option) {
  say(pageHost(), {
    head: `Answered: ${option.label}`, title: card.title,
    back: () => reopen(card.id),
    onFail: err => showToast('error', `Not taken back: ${err.message}`, 5000),
  })
}

// ---- state -----------------------------------------------------------------

const boot = getState()   // the store's placeholder; anything else came from the server
const arrival = followAddress(true)
let arrived = false
let lastScope

subscribe((state, online) => {
  const loaded = isLoaded() || state !== boot
  root.toggleAttribute('data-loaded', loaded)
  paintConn(online)
  chat.setMember(memberNow(state))
  chat.render(state, loaded)
  paintTitle(state)
  agents.render(state)
  paintNav(state)
  inbox.render(state)
  // On a phone the sessions are a strip that scrolls sideways; keep the chosen one in sight.
  if (lastScope !== state.scope) {
    lastScope = state.scope
    requestAnimationFrame(() => $('agents').querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest', inline: 'center' }))
  }
  if (body.dataset.view === 'scribble') syncCanvas()
  if (loaded) {
    paintCount(state)
    // The address named a question to open; now its card is known.
    // (Known for certain only once the board's state is here: the stream opening tells the listeners too,
    // before any card has arrived, and a number in the address could not be looked up then.)
    if (!arrived && isLoaded()) {
      arrived = true
      // A question the board does not hold (a wrong number, one long gone): the place without it.
      const known = arrival.q === 'next' || state.all.cards.some(c => c.id === cardOf(arrival.q))
      if (arrival.q && known) openFocus(arrival.q === 'next' ? null : cardOf(arrival.q), false)
      // (Not opened, it is not in the address either: the line below writes the place as it stands.)
      restoreScroll()   // a reload stands where it stood
    }
    // The scope may have changed by itself: a session that is gone, a group that formed or dissolved.
    // Not at once: the store tells its listeners in the middle of a step (a click in the sidebar, Back or
    // Forward being followed). Written now, the address would name a half-taken step, and the step's own
    // entry would find nothing left to add. Once the step is through, this finds the address already right.
    queueMicrotask(() => { if (!stepping) writeAddress(false) })
  }
  paintView()
  if (!toast.hidden) placeToast()
})

if (flags.has('skeleton')) {
  // screenshot state: nothing has arrived yet
} else if (flags.has('empty')) {
  setState({ messages: [], cards: [], queue: [] })
} else {
  connect()
}

if (flags.has('offline')) { wasOnline = true; conn.dataset.state = 'offline'; connText.textContent = CONN_TEXT.offline }
if (flags.has('toast')) showToast('error', 'Canvas did not load')
if (flags.has('undo')) offerUndo({ id: 'x', number: 7, title: 'A question' }, { label: 'Skip' })

// ---- keyboard and viewport -------------------------------------------------

// iOS keeps the layout viewport at full height when the keyboard opens and
// scrolls the page instead; follow the visual viewport so the composer stays
// above the keyboard and the page itself never scrolls.
const vv = window.visualViewport
if (vv) {
  const sync = () => {
    const covered = window.innerHeight - vv.height
    if (vv.scale < 1.01 && covered > 1) root.style.setProperty('--app-h', `${Math.round(vv.height)}px`)
    else root.style.removeProperty('--app-h')
    if (covered > 1 && (window.scrollY || vv.offsetTop)) window.scrollTo(0, 0)
  }
  vv.addEventListener('resize', sync)
  vv.addEventListener('scroll', sync)
  sync()
}

// While typing on a touch device the tab bar steps aside for the keyboard.
const coarse = matchMedia('(pointer: coarse)')
$('chat').addEventListener('focusin', e => { if (e.target.matches('.composer textarea') && coarse.matches && phone.matches) root.dataset.typing = '' })
$('chat').addEventListener('focusout', () => { delete root.dataset.typing })

// ---- keys: what the page itself can do; which key does it is written in keys.js ----

const typingIn = node => Boolean(node?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])'))
const inSession = () => !body.dataset.page && body.dataset.scope !== 'all'
// The sidebar as it stands: every session and pair, top to bottom. The Desk is the place before the first:
// its own entry in the sidebar if it has one, else the bar's.
const sessions = () => [...$('agents').querySelectorAll('.agent-row[data-unit] .agent-entry')]
const places = () => [$('agents').querySelector('.agent-row:not([data-unit]) .agent-entry') ?? $('nav-inbox'), ...sessions()]
// Going somewhere by key leaves the keys in charge: the caret does not land in the composer.
function goTo(entry) {
  if (!entry) return false
  entry.click()
  if (entry.getClientRects().length) entry.scrollIntoView({ block: 'nearest', inline: 'center' })
  if (typingIn(document.activeElement)) document.activeElement.blur()
}
const stepPlace = by => () => {
  const all = places()
  // Where we are: the session that is marked as current, else the Desk (place 0) when it is up, else nowhere.
  const on = all.findIndex((n, i) => i > 0 && n.getAttribute('aria-current') === 'true')
  const at = on >= 0 ? on : body.dataset.page ? -1 : 0
  return goTo(all[at < 0 ? (by > 0 ? 0 : all.length - 1) : (at + by + all.length) % all.length])
}
provide('app', {
  active: () => true,
  // (Hiding the cards is a thing of the Desk: elsewhere the key is not listed and does nothing.)
  has: id => id !== 'pad.cards' || (body.dataset.scope === 'all' && !body.dataset.page),
  actions: {
    'pad.cards': () => { if (body.dataset.scope !== 'all' || body.dataset.page) return false; toggleCards() },
    'go.inbox': () => { $('nav-inbox').click() },
    'go.agents': () => { $('nav-roster').click() },
    'go.focus': () => { openFocus() },
    'go.session': n => goTo(sessions()[n - 1]),
    'session.next': stepPlace(1),
    'session.prev': stepPlace(-1),
    theme: () => themeToggle.click(),
    pad: () => togglePad(),
    // The last answer, or whatever else the note at the top left offers to take back.
    back: () => backNow(),
    // Out of a field, to whatever holds it: the question's row, or the conversation.
    'field.leave': (_, e) => {
      const field = e.target
      const to = field.closest('.inbox-row') ?? field.closest('.chat-pane')?.querySelector('.log')
      field.blur()
      to?.focus({ preventScroll: true })
    },
  },
})
/** The key for dictation: a tap starts it, the next tap stops it; held for longer than a moment, letting go stops it. */
function voiceKey(field) {
  if (isDictating()) return void stopDictation()
  startDictation(field)
  return ms => { if (ms > 300) stopDictation() }
}
const pressShown = button => { if (!button.getClientRects().length) return false; button.click() }
provide('session', {
  active: inSession,
  actions: { 'session.scribble': () => setView(body.dataset.view === 'scribble' ? 'chat' : 'scribble') },
})
// The joined view's conversations folded to a strip (beside.js): a key that goes to them opens them first.
const unfoldTalk = () => { if (body.hasAttribute('data-talk-folded')) document.querySelector('.talk-strip')?.click() }
provide('conversation', {
  active: () => inSession() && body.dataset.view === 'chat',
  has: id => (id === 'chat.pane' ? getState().members.length > 1 : id === 'chat.voice' ? Boolean(getState().speech) : id === 'chat.questions' ? $('filter-questions').getClientRects().length > 0 : id === 'chat.files' ? $('filter-files').getClientRects().length > 0 : true),
  actions: {
    'chat.write': () => { unfoldTalk(); chat.focus() },
    'chat.voice': () => voiceKey($('chat').querySelector('.chat-pane.is-member .composer textarea') ?? $('chat').querySelector('.composer textarea')),
    // (Only where the filter is offered: a hidden button is not pressed by key either.)
    'chat.questions': () => pressShown($('filter-questions')),
    'chat.files': () => pressShown($('filter-files')),
    'chat.pane': () => {
      const { members } = getState()
      if (members.length < 2) return false
      unfoldTalk()
      pickMember(members[(members.indexOf(memberNow()) + 1) % members.length])
      // The keyboard goes along: its log scrolls, and "write" means this one.
      $('chat').querySelector('.chat-pane.is-member .log')?.focus({ preventScroll: true })
    },
  },
})
// Hear it: the open question of the Focus window, the marked row of a list, or the latest message of the
// conversation is read aloud; the same key again stops it (speech.js). Only where the board can speak.
const visible = sel => [...document.querySelectorAll(sel)].find(n => n.getClientRects().length && !n.closest('[inert]')) ?? null
const hear = find => () => { const node = getState().speech && find(); if (!node) return false; readAloud(node) }
const canHear = id => !/\.read$/.test(id) || Boolean(getState().speech)
provide('focus', { active: () => Boolean(focusMode?.isOpen()), has: canHear, actions: { 'focus.read': hear(() => visible('.focus .focus-card[data-shown]')) } })
provide('list', { active: () => Boolean(visible('.inbox-row.is-current')), has: canHear, actions: { 'list.read': hear(() => visible('.inbox-row.is-current')) } })
provide('conversation', { active: () => inSession() && body.dataset.view === 'chat', has: canHear, actions: { 'chat.read': hear(() => [...$('chat').querySelectorAll('.chat-pane.is-member .log .msg, .chat-pane .log .msg')].filter(n => n.getClientRects().length).at(-1)) } })
// The agents page hears its own keys (ledger.js); here they are only listed.
provide('ledger', { active: () => Boolean(visible('#ledger')) })
// Listed in the sheet only; the composer and the canvas hear these keys themselves.
provide('writing', { active: () => inSession() && body.dataset.view === 'chat' })
provide('scribble', { active: () => inSession() && body.dataset.view === 'scribble' })
$('keys-open').addEventListener('click', () => openSheet())
