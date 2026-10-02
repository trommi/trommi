// The page: navigation, a session's three modes, theme, connection feedback, and
// the glue between conversation, questions, history, and scribble.

import { connect, subscribe, getState, setState, isLoaded, setScope, sendScribble, loadCanvas, saveCanvas } from './store.js'
import { mountAgents, mountRoster, avatar } from './agents.js'
import { mountInbox } from './inbox.js'
import { mountDictation } from './speech.js'
import { el } from './ui.js'
import { mountChat } from './chat.js'
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
  if (!$('toast').hidden) requestAnimationFrame(placeToast)
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
        showToast('ok', 'Gesendet. Schreib im Gespräch dazu, was du meinst.', 4000)
        // The explanation goes into the conversation, so take the human there.
        setView('chat')
        chat.focus()
      },
    })
  } catch (err) {
    console.error(err)
    $('scribble').replaceChildren(el('p', 'scribble-fallback', 'Scribble konnte nicht geladen werden.'))
  }
  return scribble
}

// Put the canvas of the session in scope on the board. While it loads, changes are not saved.
let canvasAgent = null
async function syncCanvas() {
  const agent = getState().scope
  if (!agent) return
  const board = await mountScribblePane()
  if (!board || getState().scope !== agent || agent === canvasAgent) return
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
// The pen in the composer is a shortcut to the canvas; so is a scribble sent earlier.
$('scribble-open').addEventListener('click', () => setView('scribble'))

chat = mountChat({ onCard: openCard, onScribble: () => setView('scribble'), onUnread: paintView, flags })
// Picking a session lands in its conversation; a deep link may ask for another mode once.
let landing = flags.has('decisions') ? 'decisions' : flags.has('scribble') ? 'scribble' : 'chat'
const agents = mountAgents($('agents'), {
  onSelect: id => { showPage(null); if (id) { setView(landing); landing = 'chat' } },
  onPage: page => showPage(page),
})
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
// A session's own questions, written out in full.
const sessionCards = mountInbox(cardsRoot, { onOpen: openFocus, session: true })

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
  $('nav-inbox').toggleAttribute('aria-current', !page && !getState().scope)
  $('nav-roster').toggleAttribute('aria-current', page === 'roster')
  agents.render(getState())
  requestAnimationFrame(() => $('agents').querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest', inline: 'center' }))
}
$('nav-inbox').addEventListener('click', () => { setScope(null); showPage(null) })
$('nav-roster').addEventListener('click', () => showPage('roster'))
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
const toast = $('toast')
const CONN_TEXT = { connecting: 'Verbindet', online: 'Verbunden', offline: 'Getrennt' }
let wasOnline = false
let connCalls = 0
let lostTimer = 0
let toastTimer = 0

// The toast sits just above whatever is fixed to the bottom of the page: the bar, the
// tab bar, or the composer of a conversation. So it never covers a title or a control.
function placeToast() {
  let top = window.innerHeight
  for (const node of document.querySelectorAll('.topbar, .tabbar, .dock')) {
    const box = node.getBoundingClientRect()
    if (box.height && box.top > window.innerHeight / 2) top = Math.min(top, box.top)
  }
  toast.style.setProperty('--toast-bottom', `${Math.round(window.innerHeight - top)}px`)
}
function showToast(kind, text, ms) {
  clearTimeout(toastTimer)
  placeToast()
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
  paintTitle(state)
  agents.render(state)
  $('nav-inbox').toggleAttribute('aria-current', !document.body.dataset.page && !state.scope)
  $('nav-roster').toggleAttribute('aria-current', document.body.dataset.page === 'roster')
  inbox.render(state)
  roster.render(state)
  // The composer measures itself; it could not while its pane was hidden.
  if (lastScope !== state.scope) {
    lastScope = state.scope
    requestAnimationFrame(() => {
      $('draft').dispatchEvent(new Event('input'))
      // On a phone the sessions are a strip that scrolls sideways; keep the chosen one in sight.
      $('agents').querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest', inline: 'center' })
    })
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
  // Letters only: digits, arrows, and Enter belong to the cards' shortcuts.
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || !/^\p{L}$/u.test(e.key)) return
  const t = document.activeElement
  if (t && t !== document.body && t !== $('log')) return
  if (document.querySelector('dialog[open]')) return
  // Only where the composer is on screen: a session's conversation.
  if (document.body.dataset.view !== 'chat' || document.body.dataset.scope === 'all' || document.body.dataset.page) return
  draft.focus()
})
