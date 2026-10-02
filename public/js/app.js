// The page around the card stack: views, theme, connection feedback, and the
// glue between conversation, history, and deck.

import { connect, subscribe, getState, setState, isLoaded, setScope, sendScribble, loadCanvas, saveCanvas } from './store.js'
import { mountAgents, mountRoster } from './agents.js'
import { mountInbox } from './inbox.js'
import { mountDictation } from './speech.js'
import { el } from './ui.js'
import { mountChat, icon } from './chat.js'
import { mountHistory } from './history.js'

const $ = id => document.getElementById(id)
const root = document.documentElement
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

// ---- views (phone): one pane at a time behind the tab bar ------------------

const tabs = { chat: $('tab-chat'), decisions: $('tab-decisions') }
const chatDot = $('chat-dot')
let chat = null

function paintView() {
  const view = document.body.dataset.view
  for (const [name, tab] of Object.entries(tabs)) {
    if (name === view) tab.setAttribute('aria-current', 'page')
    else tab.removeAttribute('aria-current')
  }
  chatDot.hidden = view === 'chat' || !chat?.unread()
}
function setView(view) {
  document.body.dataset.view = view
  store('agent-board-view', view)
  paintView()
}
for (const [name, tab] of Object.entries(tabs)) tab.addEventListener('click', () => setView(name))

// ---- conversation, history, deck -------------------------------------------

const deckRoot = $('deck')
// While the history sheet covers the deck, the deck is out of reach for keyboard and screen readers too.
const history = mountHistory($('history'), { flags, onToggle: open => { deckRoot.inert = open } })

function openCard(cardId) {
  const card = getState().cards.find(c => c.id === cardId)
  if (!card) return
  setPanel(true)
  setView('decisions')
  setPane('deck')
  if (card.status === 'open') {
    history.close()
    const row = deckRoot.querySelector(`[data-id="${CSS.escape(cardId)}"]`)
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    row?.animate([{ outline: '3px solid var(--accent)' }, { outline: '3px solid transparent' }], { duration: 1400 })
  } else {
    history.reveal(cardId)
  }
}

// ---- side panel: decisions or scribble, and its width ----------------------

const panel = $('decisions')
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
        showToast('ok', 'Gesendet. Schreib im Gespräch dazu, was du meinst.', 4000)
        // The explanation goes into the conversation, so take the human there.
        if (phone.matches) setView('chat')
        $('draft').focus()
      },
    })
  } catch (err) {
    console.error(err)
    $('scribble').replaceChildren(el('p', 'scribble-fallback', 'Scribble konnte nicht geladen werden.'))
  }
  return scribble
}

function setPane(name) {
  panel.dataset.pane = name
  if (name === 'scribble') syncCanvas()
}

// Put the canvas of the session in scope on the board. While it loads, changes are not saved.
let canvasAgent = null
async function syncCanvas() {
  const board = await mountScribblePane()
  const agent = getState().scope
  if (!board || !agent || agent === canvasAgent) return
  canvasAgent = null
  try {
    const doc = await loadCanvas(agent)
    if (getState().scope !== agent) return
    if (doc) board.load(doc)
    else board.clear()
    canvasAgent = agent
  } catch (err) {
    showToast('error', err.message, 4000)
  }
}
// Scribble opens from the composer and closes back to the questions.
$('scribble-open').addEventListener('click', () => { setPanel(true); setView('decisions'); setPane('scribble') })
$('scribble-close').addEventListener('click', () => setPane('deck'))

// A scribble in the conversation leads back to the session's canvas.
function openScribble() {
  setView('decisions')
  setPane('scribble')
}

// Width of the panel on desktop: drag the left edge, arrows when focused, double-click to reset.
const resizer = $('panel-resize')
const panelWidth = w => Math.round(Math.max(360, Math.min(w, innerWidth - 420, 1200)))
function setPanelWidth(w) {
  if (w == null) {
    document.body.style.removeProperty('--panel-w')
    try { localStorage.removeItem('agent-board-panel-w') } catch {}
    return
  }
  document.body.style.setProperty('--panel-w', `${panelWidth(w)}px`)
  store('agent-board-panel-w', String(panelWidth(w)))
}
try {
  const saved = Number(localStorage.getItem('agent-board-panel-w'))
  if (saved) document.body.style.setProperty('--panel-w', `${panelWidth(saved)}px`)
} catch {}
resizer.addEventListener('pointerdown', e => {
  e.preventDefault()
  resizer.setPointerCapture(e.pointerId)
  document.body.classList.add('resizing')
  const move = ev => setPanelWidth(innerWidth - ev.clientX)
  const stop = () => {
    document.body.classList.remove('resizing')
    resizer.removeEventListener('pointermove', move)
    resizer.removeEventListener('pointerup', stop)
    resizer.removeEventListener('pointercancel', stop)
  }
  resizer.addEventListener('pointermove', move)
  resizer.addEventListener('pointerup', stop)
  resizer.addEventListener('pointercancel', stop)
})
resizer.addEventListener('dblclick', () => setPanelWidth(null))
resizer.addEventListener('keydown', e => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  e.preventDefault()
  setPanelWidth(panel.getBoundingClientRect().width + (e.key === 'ArrowLeft' ? 24 : -24))
})

chat = mountChat({ onCard: openCard, onScribble: openScribble, onUnread: paintView, flags })
if (flags.has('scribble')) setPane('scribble')
// Picking an agent on a phone should land in its conversation.
const agents = mountAgents($('agents'), { onSelect: id => setView(id ? 'chat' : 'decisions') })
mountDictation($('mic'), $('draft'), { onError: text => showToast('error', text, 6000) })

// Fokus-Modus: all open decisions as one full page. Loaded on first use.
let lastScope
let focusMode = null
async function openFocus(cardId) {
  try {
    focusMode ??= (await import('./focus.js')).mountFocus()
    focusMode.open(cardId ?? undefined)
  } catch (err) {
    console.error(err)
    showToast('error', 'Der Fokus-Modus konnte nicht geladen werden.', 4000)
  }
}
$('focus-open').addEventListener('click', () => openFocus())
// A row in the inbox opens its card as a full page; from there one tap decides and the next comes up.
const inbox = mountInbox($('inbox'), { onOpen: openFocus })
const roster = mountRoster($('roster'))
// A session's own questions, written out in full beside its conversation.
const sessionCards = mountInbox(deckRoot, { onOpen: openFocus, session: true })

// The questions beside a conversation fold away; the choice is remembered.
function setPanel(shown) {
  if (shown) delete document.body.dataset.panel
  else document.body.dataset.panel = 'hidden'
  $('panel-toggle').setAttribute('aria-pressed', String(shown))
  store('trommi-panel', shown ? 'shown' : 'hidden')
}
try { if (localStorage.getItem('trommi-panel') === 'hidden') setPanel(false) } catch {}
$('panel-toggle').addEventListener('click', () => setPanel(document.body.dataset.panel === 'hidden'))

// The bar's own navigation: the inbox and the list of agents.
function showPage(page) {
  if (page) document.body.dataset.page = page
  else delete document.body.dataset.page
  $('nav-inbox').toggleAttribute('aria-current', !page && !getState().scope)
  $('nav-roster').toggleAttribute('aria-current', page === 'roster')
  agents.render(getState())
}
$('nav-inbox').addEventListener('click', () => { setScope(null); showPage(null) })
$('nav-roster').addEventListener('click', () => showPage('roster'))
paintView()

// ---- open count: tab badge and document title ------------------------------

const badge = $('open-badge')

function paintCount(state) {
  const open = state.queue.length
  badge.textContent = open > 99 ? '99+' : open
  badge.hidden = open === 0
  tabs.decisions.setAttribute('aria-label', open ? `Entscheidungen, ${open} offen` : 'Entscheidungen')
  document.title = open ? `(${open}) Trommi` : 'Trommi'
}

// ---- connection feedback ---------------------------------------------------

const conn = $('conn')
const connText = $('conn-text')
const toast = $('toast')
const CONN_TEXT = { connecting: 'Verbindet', online: 'Verbunden', offline: 'Getrennt' }
let wasOnline = false
let connCalls = 0
let lostTimer = 0
let toastTimer = 0

function showToast(kind, text, ms) {
  clearTimeout(toastTimer)
  toast.dataset.kind = kind
  toast.replaceChildren(el('i'), el('span', null, text))
  toast.hidden = false
  if (ms) toastTimer = setTimeout(() => { toast.hidden = true }, ms)
}
function paintConn(online) {
  // The very first call is the store's initial value; a later "not online" means the stream failed.
  const state = online ? 'online' : wasOnline || connCalls > 0 ? 'offline' : 'connecting'
  connCalls++
  if (conn.dataset.state !== state) {
    conn.dataset.state = state
    connText.textContent = CONN_TEXT[state]
  }
  if (online) {
    clearTimeout(lostTimer)
    lostTimer = 0
    if (toast.dataset.kind === 'lost' && !toast.hidden) showToast('back', 'Wieder verbunden', 2400)
    wasOnline = true
  } else if (wasOnline && !lostTimer && toast.dataset.kind !== 'lost') {
    // A short blip reconnects by itself; only speak up if it lasts.
    lostTimer = setTimeout(() => showToast('lost', 'Verbindung unterbrochen. Ich verbinde neu.'), 1500)
  }
  if (online && toast.dataset.kind === 'lost' && toast.hidden) toast.dataset.kind = ''
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
  $('panel-count').textContent = state.scope && state.queue.length ? String(state.queue.length) : ''
  agents.render(state)
  $('nav-inbox').toggleAttribute('aria-current', !document.body.dataset.page && !state.scope)
  $('nav-roster').toggleAttribute('aria-current', document.body.dataset.page === 'roster')
  inbox.render(state)
  roster.render(state)
  // The composer measures itself; it could not while its pane was hidden.
  if (lastScope !== state.scope) { lastScope = state.scope; requestAnimationFrame(() => $('draft').dispatchEvent(new Event('input'))) }
  // The inbox is only the stack; scribbling needs a session to send to.
  if (!state.scope && panel.dataset.pane !== 'deck') setPane('deck')
  if (panel.dataset.pane === 'scribble') syncCanvas()
  $('mic').hidden = !state.speech
  if (loaded) paintCount(state)
  paintView()
})

function openLine(n) {
  return n === 0 ? 'Gerade ist nichts offen.' : n === 1 ? '1 offene Entscheidung wartet.' : `${n} offene Entscheidungen warten.`
}

if (flags.has('skeleton')) {
  // screenshot state: nothing has arrived yet
} else if (flags.has('empty')) {
  setState({ messages: [], cards: [], queue: [] })
} else {
  connect()
}

if (flags.has('offline')) { wasOnline = true; conn.dataset.state = 'offline'; connText.textContent = CONN_TEXT.offline; showToast('lost', 'Verbindung unterbrochen. Ich verbinde neu.') }

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
  // Letters only: digits, arrows, and Enter belong to the deck's shortcuts.
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || !/^\p{L}$/u.test(e.key)) return
  const t = document.activeElement
  if (t && t !== document.body && t !== $('log')) return
  if (document.querySelector('dialog[open]')) return
  if (phone.matches && document.body.dataset.view !== 'chat') return
  draft.focus()
})
