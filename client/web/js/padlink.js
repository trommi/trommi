// The pad, from anywhere: one control in the bar, and the pad laid over whatever the page
// shows. Closing it goes back to exactly that place.
//
//   import { openPad, closePad, togglePad, isPadOpen } from './padlink.js'
//
// How: the pad is the page /pad/ (client/web/pad/), mounted once in a frame of the same
// origin and kept there, so opening it a second time only shows it. A frame, not a module
// mounted into this page, because the pad is a page of its own: it has its own keys (P is
// the pen there), its own ids, dialogs and paste handling, and none of that may meet the
// board's. The two talk in a few messages: the board says who the sessions are, which one
// the human came from and which theme is on; the pad says "close".
//
// The address is /pad, a real one: a reload stays on the pad, Back leaves it. Opening
// pushes an entry that remembers where the human was; closing goes back to it.

import { subscribe, getState, isLoaded } from './store.js'
import { PAD_WORD } from '/pad/name.js'

const PATH = '/pad'
const root = document.documentElement
const body = document.body
const here = () => location.pathname === PATH

let overlay = null, frame = null
let ready = false          // the pad's page has started and listens
let open = false
let prefer = []            // the sessions the human was in when the pad was opened
let lastFocus = null
let lastContext = ''

// ---- the control: a scribbled sheet, in the bar that is always there ----

const NS = 'http://www.w3.org/2000/svg'
const SCRIBBLE = [
  // a sheet drawn by hand: the corners do not quite meet
  'M4.700 5.400c4.900-.700 9.900-.800 14.800-.200.400 4.500.500 9.100-.100 13.700-4.900.600-9.800.600-14.700-.100-.500-4.400-.500-8.900 0-13.400',
  // and what is on it
  'M7.400 14.800c1.100-2.900 2.300-5 3.200-4.700 1 .400-.900 4.200.200 4.600 1 .300 1.700-2.600 2.700-2.400.800.200.400 1.900 1.200 2.100.600.100 1.300-.600 1.900-1.400',
]
function scribbleIcon() {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', 'padlink-ico')
  svg.setAttribute('aria-hidden', 'true')
  for (const d of SCRIBBLE) {
    const path = document.createElementNS(NS, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}
const button = document.createElement('button')
button.type = 'button'
button.id = 'pad-open'
button.className = 'padlink-open'
button.setAttribute('aria-label', `${PAD_WORD}: notes, drawings and pictures, from anywhere`)
button.setAttribute('aria-pressed', 'false')
button.setAttribute('aria-keyshortcuts', 'P')
button.title = `${PAD_WORD} · P`
button.append(scribbleIcon(), Object.assign(document.createElement('span'), { textContent: PAD_WORD }))
button.addEventListener('click', () => togglePad())
{
  const bar = document.querySelector('.topbar')
  const before = bar?.querySelector('#focus-open')
  if (before) before.before(button)
  else (bar ?? body).append(button)
}

// ---- the overlay ----

function build() {
  if (overlay) return
  overlay = document.createElement('div')
  overlay.className = 'padlink'
  overlay.id = 'padlink'
  overlay.inert = true
  frame = document.createElement('iframe')
  frame.title = PAD_WORD
  frame.src = '/pad/?embed=1'
  frame.allow = 'microphone; clipboard-read; clipboard-write'
  overlay.append(frame)
  body.append(overlay)
}

function sessionsOf(path) {
  // "/s/web" or "/s/web+api": the sessions of that place.
  const parts = String(path ?? '').split('?')[0].split('/').filter(Boolean)
  if (parts[0] !== 's' || !parts[1]) return []
  return parts[1].split('+').map(s => { try { return decodeURIComponent(s) } catch { return s } })
}

/** Tell the pad what it needs from the board. Sent again only when something changed. */
function tellPad(force = false) {
  if (!ready || !frame?.contentWindow) return
  const state = getState()
  const known = isLoaded() && state.all
  const msg = {
    trommi: 'pad', type: 'context', open, prefer: open ? prefer : [],
    theme: root.dataset.theme === 'dark' ? 'dark' : 'light',
    ...(known ? { sessions: state.all.agents.map(a => ({ id: a.id, name: a.name, online: Boolean(a.online) })), speech: Boolean(state.speech) } : {}),
  }
  const sig = JSON.stringify(msg)
  if (!force && sig === lastContext) return
  lastContext = sig
  frame.contentWindow.postMessage(msg, location.origin)
}

function show() {
  build()
  if (open) return
  open = true
  // Where the human was: said by the entry this one was pushed from; on a first arrival, nowhere.
  prefer = sessionsOf(history.state?.from)
  lastFocus = document.activeElement
  overlay.inert = false
  overlay.dataset.open = ''
  body.dataset.pad = ''
  // The page underneath is out of reach while the pad covers it.
  for (const node of body.children) if (node !== overlay && !node.inert) { node.inert = true; node.dataset.padInert = '' }
  button.setAttribute('aria-pressed', 'true')
  tellPad()
  frame.focus()
  frame.contentWindow?.focus()
}
function hide() {
  if (!open) return
  open = false
  delete overlay.dataset.open
  overlay.inert = true
  delete body.dataset.pad
  for (const node of body.querySelectorAll(':scope > [data-pad-inert]')) { node.inert = false; delete node.dataset.padInert }
  button.setAttribute('aria-pressed', 'false')
  tellPad()
  if (lastFocus?.isConnected && lastFocus !== body) lastFocus.focus?.({ preventScroll: true })
  else window.focus()
  lastFocus = null
}

export const isPadOpen = () => open

/** Lay the pad over whatever is shown. */
export function openPad() {
  if (here()) return show()
  const from = location.pathname + location.search + location.hash
  history.pushState({ pad: true, from }, '', PATH + location.hash)
  show()
}
/** Back to exactly where the human was. */
export function closePad() {
  if (!here()) return hide()
  // Opened from a place on this page: leave the entry that was made for the pad.
  if (history.state?.pad && history.state.from) return history.back()
  // Arrived on the pad's address directly: there is no place behind it, so it becomes the inbox.
  history.replaceState(null, '', '/' + location.hash)
  window.dispatchEvent(new PopStateEvent('popstate'))
}
export function togglePad() {
  if (open) closePad()
  else openPad()
}
export default togglePad

// Back, Forward, and the address someone arrived with.
window.addEventListener('popstate', () => (here() ? show() : hide()))

window.addEventListener('message', e => {
  if (e.origin !== location.origin || !frame || e.source !== frame.contentWindow || e.data?.trommi !== 'pad') return
  const msg = e.data
  if (msg.type === 'ready') { ready = true; tellPad(true) }
  else if (msg.type === 'close') closePad()
  else if (msg.type === 'theme') {
    // The pad's own switch was used: the board follows, through its own switch so it paints itself.
    if ((root.dataset.theme === 'dark') !== (msg.theme === 'dark')) document.getElementById('theme-toggle')?.click()
  }
})
// The keyboard is the pad's while it is up. Should the focus still be out here, Escape closes.
window.addEventListener('keydown', e => {
  if (!open || e.key !== 'Escape' || e.defaultPrevented) return
  e.preventDefault()
  e.stopPropagation()
  closePad()
}, true)
new MutationObserver(() => tellPad()).observe(root, { attributes: true, attributeFilter: ['data-theme'] })
subscribe(() => tellPad())

if (here()) show()
else {
  // Fetch the pad while nothing else is going on, so the first opening is quick too.
  const idle = window.requestIdleCallback ?? (fn => setTimeout(fn, 1200))
  idle(() => build(), { timeout: 4000 })
}
