// The page: navigation, a session's three modes, theme, connection feedback, and
// the glue between conversation, questions, history, and scribble.

import { connect, subscribe, getState, setState, isLoaded, setScope, reopen, sendScribble, loadCanvas, saveCanvas } from './store.js'
import { mountAgents, mountRoster, avatar } from './agents.js'
import { mountInbox } from './inbox.js'
import { mountDictation } from './speech.js'
import { el } from './ui.js'
import { mountChat } from './chat.js'
import { mountHistory } from './history.js'

const $ = id => document.getElementById(id)
const root = document.documentElement
const toast = $('toast')
const flags = new Set(location.hash.slice(1).split(',').filter(Boolean))
const store = (key, value) => { try { localStorage.setItem(key, value) } catch {} }
const phone = matchMedia('(max-width: 860px)')

// ---- theme: light unless the user chose dark -------------------------------

const themeToggle = $('theme-toggle')
function paintTheme() {
  const dark = root.dataset.theme === 'dark'
  themeToggle.setAttribute('aria-pressed', String(dark))
  themeToggle.setAttribute('aria-label', dark ? 'Helles Design einschalten' : 'Dunkles Design einschalten')
  themeToggle.title = dark ? 'Helles Design' : 'Dunkles Design'
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

// ---- modes: a session fills the page with its conversation, its questions, or its canvas ----

const VIEWS = ['chat', 'decisions', 'scribble']
const switches = VIEWS.map(view => [view, [$(`tab-${view}`), $(`mode-${view}`)]])
const chatDot = $('chat-dot')
let chat = null

function paintView() {
  const view = document.body.dataset.view
  for (const [name, buttons] of switches) {
    for (const button of buttons) {
      if (name === view) button.setAttribute('aria-current', 'page')
      else button.removeAttribute('aria-current')
    }
  }
  const unread = view !== 'chat' && Boolean(chat?.unread())
  chatDot.hidden = !unread
  $('mode-chat').toggleAttribute('data-unread', unread)
}
function setView(view) {
  document.body.dataset.view = view
  paintView()
  if (!toast.hidden) requestAnimationFrame(placeToast)
  if (view === 'scribble') syncCanvas()
}
for (const [name, buttons] of switches) for (const button of buttons) button.addEventListener('click', () => setView(name))

// ---- conversation, questions, history --------------------------------------

const cardsRoot = $('session-cards')
const history = mountHistory($('history'), { flags })

// A card named in the conversation: show it among the session's questions, or in the history below them.
function openCard(cardId) {
  const card = getState().cards.find(c => c.id === cardId)
  if (!card) return
  setView('decisions')
  if (card.status === 'open') {
    const row = cardsRoot.querySelector(`[data-id="${CSS.escape(cardId)}"]`)
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    row?.animate([{ outline: '3px solid var(--accent)' }, { outline: '3px solid transparent' }], { duration: 1400 })
  } else {
    history.reveal(cardId)
  }
}

// ---- scribble: the session's canvas ----------------------------------------

let scribble = null   // the mounted canvas, loaded on first use

async function mountScribblePane() {
  if (scribble) return scribble
  try {
    const { mountScribble } = await import('./scribble.js')
    scribble = mountScribble($('scribble'), {
      // The server keeps the canvas, one per session; no local draft needed.
      draftKey: null,
      onChange: doc => { if (canvasAgent) saveCanvas(canvasAgent, doc).catch(() => {}) },
      send: async payload => {
        await sendScribble(payload)
        // The explanation goes into the conversation, so take the human there: the scribble
        // stands in the log as sent, and the composer asks for the words to go with it.
        setView('chat')
        chat.focus('Was meinst du mit dem Scribble?')
      },
    })
  } catch (err) {
    console.error(err)
    $('scribble').replaceChildren(el('p', 'scribble-fallback', 'Scribble konnte nicht geladen werden.'))
  }
  return scribble
}

// Put the canvas of the session in scope on the board. A change to the previous session's
// canvas that is still waiting is saved first, under that session; then, until the new canvas
// has arrived (canvasAgent is null), nothing is saved, so a half-loaded board never overwrites one.
let canvasAgent = null
let canvasWanted = null
async function syncCanvas() {
  const agent = getState().scope
  if (!agent) return
  const board = await mountScribblePane()
  if (!board || getState().scope !== agent || agent === canvasAgent || agent === canvasWanted) return
  board.flush()
  canvasAgent = null
  canvasWanted = agent
  try {
    const doc = await loadCanvas(agent)
    if (getState().scope !== agent) return
    if (doc) board.load(doc)
    else board.clear()
    canvasAgent = agent
  } catch (err) {
    showToast('error', err.message, 4000)
  } finally {
    if (canvasWanted === agent) canvasWanted = null
  }
}
// The pen in the composer is a shortcut to the canvas; so is a scribble sent earlier.
$('scribble-open').addEventListener('click', () => setView('scribble'))

chat = mountChat({ onCard: openCard, onScribble: () => setView('scribble'), onUnread: paintView, flags })
// Picking a session lands in its conversation; a deep link may ask for another mode once.
let landing = flags.has('decisions') ? 'decisions' : flags.has('scribble') ? 'scribble' : 'chat'
const agents = mountAgents($('agents'), {
  onSelect: id => { showPage(null); if (id) { setView(landing); landing = 'chat' } },
})
mountDictation($('mic'), $('draft'), { onError: text => showToast('error', text, 6000) })

// Fokus-Modus: the open decisions as one full page each. Loaded on first use.
// Without a card it walks through all of them. With one ("Mehr" on a row) it is the window
// of that one card: it closes on the answer, and the list offers to take the answer back.
let lastScope
let focusMode = null
async function openFocus(cardId) {
  try {
    focusMode ??= (await import('./focus.js')).mountFocus({ onDecided: offerUndo })
    focusMode.open(cardId ?? undefined)
  } catch (err) {
    console.error(err)
    showToast('error', 'Der Fokus-Modus konnte nicht geladen werden.', 4000)
  }
}
$('focus-open').addEventListener('click', () => openFocus())
const inbox = mountInbox($('inbox'), { onOpen: openFocus, onDecided: offerUndo })
const roster = mountRoster($('roster'))
// A session's own questions, in the same rows.
const sessionCards = mountInbox(cardsRoot, { onOpen: openFocus, onDecided: offerUndo, session: true })

// The title of the pane: which session this is, by its mark and name. The sidebar
// already tells what it is working on, so here that is only a tooltip.
const paneTitle = $('pane-who')
let titleSig = ''
function paintTitle(state) {
  const agent = state.all.agents.find(a => a.id === state.scope)
  const sig = agent ? JSON.stringify([agent.id, agent.name, agent.mark, agent.online, agent.task, agent.starred]) : ''
  if (sig === titleSig) return
  titleSig = sig
  if (!agent) return paneTitle.replaceChildren()
  const name = el('h2', null, agent.starred ? `★ ${agent.name}` : agent.name)
  paneTitle.title = agent.online ? agent.task || '' : 'getrennt'
  paneTitle.replaceChildren(avatar(agent), name)
}

// The bar's own navigation: the inbox and the list of agents.
function showPage(page) {
  if (page) document.body.dataset.page = page
  else delete document.body.dataset.page
  paintNav(getState())
  agents.render(getState())
  requestAnimationFrame(() => $('agents').querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest', inline: 'center' }))
}
function paintNav(state) {
  const page = document.body.dataset.page
  $('nav-inbox').toggleAttribute('aria-current', !page && !state.scope)
  for (const id of ['nav-roster', 'roster-open']) $(id).toggleAttribute('aria-current', page === 'roster')
}
$('nav-inbox').addEventListener('click', () => { setScope(null); showPage(null) })
$('nav-roster').addEventListener('click', () => showPage('roster'))
// Phones have no bar with words; there one icon opens the overview and closes it again.
$('roster-open').addEventListener('click', () => showPage(document.body.dataset.page === 'roster' ? null : 'roster'))
paintView()

// ---- open count: tab badge and document title ------------------------------

const badge = $('open-badge')

function paintCount(state) {
  const open = state.queue.length
  const text = open > 99 ? '99+' : String(open)
  badge.textContent = text
  badge.hidden = open === 0
  $('mode-count').textContent = state.scope && open ? text : ''
  for (const id of ['tab-decisions', 'mode-decisions']) $(id).setAttribute('aria-label', open ? `Fragen, ${open} offen` : 'Fragen')
  document.title = open ? `(${open}) Trommi` : 'Trommi'
}

// ---- connection feedback ---------------------------------------------------

const conn = $('conn')
const connText = $('conn-text')
const CONN_TEXT = { connecting: 'Verbindet', online: 'Verbunden', offline: 'Getrennt, verbinde neu' }
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
// went wrong. On a wide screen it stands in the empty foot of the sidebar; on a phone just above
// whatever is fixed to the bottom: the tab bar or the composer. It never moves or covers the list.
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
// A decision answered in a list (or in the window of one card) can be taken back for a few seconds;
// later the history offers "Neu entscheiden".
function offerUndo(card, option) {
  const back = el('button', null, 'Rückgängig')
  back.type = 'button'
  back.addEventListener('click', async () => {
    back.disabled = true
    try {
      await reopen(card.id)
      toast.hidden = true
    } catch (err) {
      showToast('error', `Nicht zurückgenommen: ${err.message}`, 5000)
    }
  })
  const text = document.createDocumentFragment()
  text.append(`Nr. ${card.number}: `, el('strong', null, option.label))
  showToast('undo', text, 10000, back)
}

// ---- state -----------------------------------------------------------------

const boot = getState()   // the store's placeholder; anything else came from the server

subscribe((state, online) => {
  const loaded = isLoaded() || state !== boot
  root.toggleAttribute('data-loaded', loaded)
  paintConn(online)
  chat.render(state, loaded)
  history.render(state, loaded)
  sessionCards.render(state)
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
  if (document.body.dataset.view === 'scribble') syncCanvas()
  $('mic').hidden = !state.speech
  if (loaded) paintCount(state)
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
if (flags.has('toast')) showToast('error', 'Canvas nicht geladen')
if (flags.has('undo')) offerUndo({ id: 'x', number: 7 }, { label: 'Überspringen' })

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
const draft = $('draft')
const coarse = matchMedia('(pointer: coarse)')
draft.addEventListener('focus', () => { if (coarse.matches && phone.matches) root.dataset.typing = '' })
draft.addEventListener('blur', () => { delete root.dataset.typing })

// Start typing anywhere to write to the agent.
document.addEventListener('keydown', e => {
  // Letters only: digits, arrows, and Enter belong to the cards' shortcuts.
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || !/^\p{L}$/u.test(e.key)) return
  const t = document.activeElement
  if (t && t !== document.body && t !== $('log')) return
  if (document.querySelector('dialog[open]')) return
  // Only where the composer is on screen: a session's conversation.
  if (document.body.dataset.view !== 'chat' || document.body.dataset.scope === 'all' || document.body.dataset.page) return
  draft.focus()
})
