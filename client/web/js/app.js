// The page: navigation with real addresses, a session's two modes and the filters of its
// conversation, theme, connection feedback, and the glue between conversation and scribble.

import { connect, subscribe, getState, setState, isLoaded, setScope, reopen, sendScribble, loadCanvas, saveCanvas } from './store.js'
import { mountAgents, mountRoster, avatar, pairAvatar } from './agents.js'
import { mountInbox } from './inbox.js'
import { el } from './ui.js'
import { mountChat } from './chat.js'

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
//   ?q=<card id>           on any of them: that question open in its own window ("next": the walk through all)

function readAddress() {
  const parts = location.pathname.split('/').filter(Boolean)
  const q = new URLSearchParams(location.search).get('q')
  const decode = s => { try { return decodeURIComponent(s) } catch { return s } }
  if (parts[0] === 'agents') return { page: 'roster', ids: [], view: 'chat', filter: null, q }
  if (parts[0] === 's' && parts[1]) {
    const tail = parts[2]
    return { page: null, ids: parts[1].split('+').map(decode), view: tail === 'scribble' ? 'scribble' : 'chat', filter: tail === 'questions' || tail === 'files' ? tail : null, q }
  }
  return { page: null, ids: [], view: 'chat', filter: null, q }
}
let focusCard = null   // what ?q= says: a card id, "next", or null
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
  if (focusCard) params.set('q', focusCard)
  else params.delete('q')
  const query = params.toString()
  return path + (query ? `?${query}` : '') + location.hash
}
/** Write the place the page shows into the address bar: a new entry for a step the human took, else in place. */
function writeAddress(step = true) {
  const url = addressNow()
  if (url === location.pathname + location.search + location.hash) return
  history[step ? 'pushState' : 'replaceState']({ q: focusCard }, '', url)
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

async function mountScribblePane() {
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
async function openFocus(cardId, step = true) {
  try {
    focusMode ??= (await import('./focus.js')).mountFocus({ onDecided: offerUndo })
    focusMode.open(cardId ?? undefined)
    if (!focusMode.isOpen()) return
    focusCard = cardId ?? 'next'
    writeAddress(step)
  } catch (err) {
    console.error(err)
    showToast('error', 'The focus window could not be loaded.', 4000)
  }
}
// Closed by hand: leave the entry the window made, so "back" does not open it again.
document.addEventListener('focus:close', () => {
  if (!focusCard) return
  focusCard = null
  if (routing) return
  if (history.state?.q) history.back()
  else writeAddress(false)
})
$('focus-open').addEventListener('click', () => openFocus())

chat = mountChat($('chat'), {
  onOpen: id => openFocus(id), onDecided: offerUndo, onCard: openCard,
  onScribble: agent => { pickMember(agent); setView('scribble') },
  onUnread: paintView, onError: text => showToast('error', text, 6000), flags,
})
const agents = mountAgents($('agents'), { onSelect: id => { showPage(null); showView('chat'); writeAddress(); if (id == null) $('inbox').scrollTop = 0 } })
const inbox = mountInbox($('inbox'), { onOpen: id => openFocus(id), onDecided: offerUndo })
const roster = mountRoster($('roster'))

// The title of the pane: which session this is, by its mark and name. For sessions laid
// together, their joint mark and each name; a name picks that one for the canvas, and on a
// phone for the one column there is room for.
const paneTitle = $('pane-who')
let titleSig = ''
function paintTitle(state) {
  const members = state.members.map(id => state.all.agents.find(a => a.id === id)).filter(Boolean)
  const picked = memberNow(state)
  const sig = JSON.stringify([members.map(a => [a.id, a.name, a.mark, a.online, a.task, a.starred]), members.length > 1 && picked])
  if (sig === titleSig) return
  titleSig = sig
  body.toggleAttribute('data-pair', members.length > 1)
  if (!members.length) return paneTitle.replaceChildren()
  if (members.length === 1) {
    const [agent] = members
    paneTitle.title = agent.online ? agent.task || '' : 'disconnected'
    return paneTitle.replaceChildren(avatar(agent), el('h2', null, agent.name))
  }
  paneTitle.title = ''
  const names = el('h2', 'pane-members')
  members.forEach((a, i) => {
    if (i) names.append(el('span', null, '+'))
    const b = el('button', null, a.name)
    b.type = 'button'
    b.setAttribute('aria-pressed', String(a.id === picked))
    b.addEventListener('click', () => { pickMember(a.id); if (body.dataset.view === 'chat' && !phone.matches) chat.focus(null, a.id) })
    names.append(b)
  })
  paneTitle.replaceChildren(pairAvatar(members), names)
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
$('nav-inbox').addEventListener('click', () => { setScope(null); showPage(null); writeAddress() })
$('nav-roster').addEventListener('click', () => { showPage('roster'); writeAddress() })
// Phones have no bar with words; there one icon opens the overview and closes it again.
$('roster-open').addEventListener('click', () => { showPage(body.dataset.page === 'roster' ? null : 'roster'); writeAddress() })

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
  if (to.q && isLoaded()) openFocus(to.q === 'next' ? null : to.q, false)
  else if (!to.q && focusMode?.isOpen()) focusMode.close()
  routing = false
  return to
}
window.addEventListener('popstate', () => followAddress())

// ---- open count: what still needs the human, in the title and on the filter ----

function paintCount(state) {
  const fresh = ids => ids.filter(id => !state.later.includes(id)).length
  const everywhere = fresh(state.all.queue)
  const here = state.scope ? fresh(state.queue) : 0
  $('filter-count').textContent = here ? (here > 99 ? '99+' : String(here)) : ''
  $('filter-questions').setAttribute('aria-label', here ? `Questions only, ${here} open` : 'Questions only')
  document.title = everywhere ? `(${everywhere}) Trommi` : 'Trommi'
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
// A question answered in a list (or in the window of one card) can be taken back for a few seconds;
// later the list of answered questions offers "Answer again".
function offerUndo(card, option) {
  const back = el('button', null, 'Undo')
  back.type = 'button'
  back.addEventListener('click', async () => {
    back.disabled = true
    try {
      await reopen(card.id)
      toast.hidden = true
    } catch (err) {
      showToast('error', `Not taken back: ${err.message}`, 5000)
    }
  })
  const text = document.createDocumentFragment()
  text.append('Answered: ', el('strong', null, option.label))
  showToast('undo', text, 10000, back)
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
  roster.render(state)
  // On a phone the sessions are a strip that scrolls sideways; keep the chosen one in sight.
  if (lastScope !== state.scope) {
    lastScope = state.scope
    requestAnimationFrame(() => $('agents').querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest', inline: 'center' }))
  }
  if (body.dataset.view === 'scribble') syncCanvas()
  if (loaded) {
    paintCount(state)
    // The address named a question to open; now its card is known.
    if (!arrived) {
      arrived = true
      if (arrival.q) openFocus(arrival.q === 'next' ? null : arrival.q, false)
    }
    // The scope may have changed by itself: a session that is gone, a group that formed or dissolved.
    writeAddress(false)
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
if (flags.has('undo')) offerUndo({ id: 'x', number: 7 }, { label: 'Skip' })

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

// Start typing anywhere to write to the agent. Where a list of questions is up, U takes the last answer back.
document.addEventListener('keydown', e => {
  // Letters only: digits, arrows, and Enter belong to the cards' shortcuts.
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || !/^\p{L}$/u.test(e.key)) return
  const t = document.activeElement
  if (t && t !== body && !t.classList.contains('log') && !(t.tagName === 'BUTTON' && t.closest('.inbox-row, .inbox-head'))) return
  if (document.querySelector('dialog[open]')) return
  const undo = toast.dataset.kind === 'undo' && !toast.hidden && toast.querySelector('button')
  if (e.key.toLowerCase() === 'u' && undo && !body.dataset.page && (body.dataset.scope === 'all' || body.dataset.filter === 'questions')) return undo.click()
  // Only where a composer is on screen: a session's conversation.
  if (body.dataset.view !== 'chat' || body.dataset.scope === 'all' || body.dataset.page) return
  chat.focus()
})
