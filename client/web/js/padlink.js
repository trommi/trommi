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
import { avatar, hueOf } from './agents.js'
import { isKnock, knocksText } from './ui.js'
import { PAD_WORD } from '/pad/name.js'
import { flySheet } from '/pad/fly.js'

const PATH = '/pad'
// The Desk is the pad: under the Desk's list the page goes on as paper (the second half of this file). Off
// (?deskpad=0), the pad is a layer over the page, as it was. Read once, when the page loads.
const DESK = (new URLSearchParams(location.search).get('deskpad') ?? '1') === '1'
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
button.addEventListener('click', () => (DESK ? openPad() : togglePad()))
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
  frame.allow = 'clipboard-read; clipboard-write'
  overlay.append(frame)
  body.append(overlay)
}

function sessionsOf(path) {
  // "/s/web" or "/s/web+api": the sessions of that place.
  const parts = String(path ?? '').split('?')[0].split('/').filter(Boolean)
  if (parts[0] !== 's' || !parts[1]) return []
  return parts[1].split('+').map(s => { try { return decodeURIComponent(s) } catch { return s } })
}

// A session's scribble as the sidebar draws it, for the pad's chooser (the pad is a page of its own).
const marks = new Map()
function markOf(agent) {
  const key = `${agent.id}|${agent.mark}`
  if (!marks.has(key)) marks.set(key, avatar(agent, { vip: false }).querySelector('svg')?.outerHTML ?? '')
  return marks.get(key)
}

// ---- the swoosh: an area cut out on the pad flies into its session ----
// The pad covers the sidebar, so the flight needs somewhere visible to end. The board draws it,
// above the frame: a slim strip of the sessions' marks comes in at the left edge, where the sidebar
// is, the piece flies to its session's mark and is swallowed, the strip leaves. Drawn here and not
// in the pad because the marks are the board's (same component, same colours as the sidebar), and
// because this is where a flight into the real sidebar or dock can end once the layout allows it.
async function fly({ png, rect, session }) {
  const agents = getState().all?.agents ?? []
  const layer = document.createElement('div')
  layer.className = 'padlink-fly'
  const strip = document.createElement('div')
  strip.className = 'padlink-strip'
  let target = null
  for (const a of agents) {
    const mark = avatar(a, { vip: false })
    if (a.id === session) { target = mark; mark.classList.add('is-target') }
    strip.append(mark)
  }
  layer.append(strip)
  body.append(layer)
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches
  try {
    if (!calm) strip.animate([{ translate: '-110% 0' }, { translate: '0 0' }], { duration: 180, easing: 'cubic-bezier(.16, 1, .3, 1)' })
    // The piece starts exactly where the pad shows it: the frame fills the window, so its coordinates are the window's.
    await flySheet(layer, { png, rect, target: target ?? strip })
    await new Promise(r => setTimeout(r, 240))
    if (!calm) await strip.animate([{ translate: '0 0' }, { translate: '-110% 0' }], { duration: 200, easing: 'ease-in', fill: 'forwards' }).finished.catch(() => {})
  } finally {
    layer.remove()
  }
}

/** Tell the pad what it needs from the board. Sent again only when something changed. */
function tellPad(force = false) {
  if (!ready || !frame?.contentWindow) return
  const state = getState()
  const known = isLoaded() && state.all
  const msg = {
    trommi: 'pad', type: 'context', open, prefer: open ? prefer : [],
    theme: root.dataset.theme === 'dark' ? 'dark' : 'light',
    ...(known ? { sessions: state.all.agents.map(a => ({ id: a.id, name: a.name, online: Boolean(a.online), hue: hueOf(a.id), mark: markOf(a) })) } : {}),
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

export const isPadOpen = () => (DESK ? front : open)

/** Lay the pad over whatever is shown. */
export function openPad() {
  if (DESK) return setDraw(true)
  if (here()) return show()
  const from = location.pathname + location.search + location.hash
  history.pushState({ pad: true, from }, '', PATH + location.hash)
  show()
}
/** Back to exactly where the human was. */
export function closePad() {
  if (DESK) return setDraw(false)
  if (!here()) return hide()
  // Opened from a place on this page: leave the entry that was made for the pad.
  if (history.state?.pad && history.state.from) return history.back()
  // Arrived on the pad's address directly: there is no place behind it, so it becomes the inbox.
  history.replaceState(null, '', '/' + location.hash)
  window.dispatchEvent(new PopStateEvent('popstate'))
}
export function togglePad() {
  if (isPadOpen()) closePad()
  else openPad()
}
export default togglePad

// Back, Forward, and the address someone arrived with.
if (!DESK) window.addEventListener('popstate', () => (here() ? show() : hide()))

window.addEventListener('message', e => {
  if (e.origin !== location.origin || !frame || e.source !== frame.contentWindow || e.data?.trommi !== 'pad') return
  const msg = e.data
  if (msg.type === 'ready') {
    ready = true
    tellPad(true)
    if (DESK) {
      watchPinch(frame.contentDocument, true)
      if (zoom !== 1) { frame.contentWindow.padZoom?.(zoom, 0); placeLayer(); grow() }
      follow()
      if (arrivedForPen) { arrivedForPen = false; setDraw(true) }
    }
  }
  else if (DESK) {
    if (msg.type === 'extent') { extent = Math.max(0, Number(msg.bottom) || 0); paperW = Math.max(0, Number(msg.width) || 0); grow() }
    else if (msg.type === 'scroll') box.scrollBy({ top: Number(msg.by) || 0, behavior: 'instant' })
    else if (msg.type === 'close') { frame.blur(); window.focus() }   // Escape with nothing to let go of: the keys are the board's again
    else if (msg.type === 'front') {
      front = Boolean(msg.front)
      paintSwitch()
      if (!front && document.activeElement === frame) { frame.blur(); window.focus() }   // back to the pointer: the board's keys work again
    }
    else if (msg.type === 'pan') { panX = Number(msg.x) || 0; placeLayer() }
  }
  else if (msg.type === 'close') closePad()
  else if (msg.type === 'fly' && open && typeof msg.png === 'string' && msg.png.startsWith('data:image/png') && msg.rect) fly(msg)
  else if (msg.type === 'theme') {
    // The pad's own switch was used: the board follows, through its own switch so it paints itself.
    if ((root.dataset.theme === 'dark') !== (msg.theme === 'dark')) document.getElementById('theme-toggle')?.click()
  }
})
// The keyboard is the pad's while it is up. Should the focus still be out here, Escape closes.
window.addEventListener('keydown', e => {
  if (DESK || !open || e.key !== 'Escape' || e.defaultPrevented) return
  e.preventDefault()
  e.stopPropagation()
  closePad()
}, true)
new MutationObserver(() => tellPad()).observe(root, { attributes: true, attributeFilter: ['data-theme'] })
subscribe(() => tellPad())

// ---- the Desk is the pad ----
// The whole Desk is paper. The pad's page (/pad/?desk, in a frame as high as the window) sticks to the top of the
// Desk's scroller (#inbox) and lies UNDER what js/inbox.js puts there: heading, rows and stacks are objects on the
// paper. The Desk's scrolling says which part of the paper the frame paints, so the canvas is never larger than the
// window and the paper is as long as he writes: the lower of list and drawing, plus one and a half windows.
// Who gets the pointer: with the pointer tool the cards work as always and the paper takes what falls between
// them. With a tool in hand (or something on the paper selected, a note open) the paper is "in front": the cards
// go faint and let everything through, so a stroke across a card is a stroke. Escape or the pointer tool ends it.
// Drawings belong to the paper, not to the cards: when the list above grows, a drawing beside a card stays, the card moves.
let paper = null, box = null, room = null, layer = null, over = null, penSwitch = null, eyeSwitch = null
let extent = 0        // how far down the paper is used (the pad says)
let front = false     // the paper has the pointer (the pad says)
let lastTop = 0, lastRoom = null
let gliding = false
const HIDE_KEY = 'trommi-desk-cards-hidden'
let cardsHidden = false
try { cardsHidden = localStorage.getItem(HIDE_KEY) === '1' } catch {}
const glide = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth')
const deskShown = () => Boolean(room?.getClientRects().length)
/** Where the list ends, in the paper's own pixels (from the top of the Desk). */
const roomTop = () => room.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop
const padWindow = () => (ready ? frame?.contentWindow : null)

/** One and a half windows of free paper under the lower of the list and the lowest thing drawn. */
function grow() {
  const vh = box.clientHeight
  if (!vh || !deskShown()) return
  const pb = parseFloat(getComputedStyle(box).paddingBottom) || 0
  // On a phone half a window of free paper is enough (his decision); on a wide screen one and a half.
  room.style.height = `${Math.max(0, Math.round(Math.max(0, extent * zoom - roomTop()) + (phone.matches ? 0.5 : 1.5) * vh - pb))}px`
}
function measure() {
  const cs = getComputedStyle(box)
  for (const node of [paper, over]) {
    node.style.setProperty('--deskpad-pt', cs.paddingTop)
    node.style.setProperty('--deskpad-pl', cs.paddingLeft)
    node.style.setProperty('--deskpad-view', `${box.clientHeight}px`)
    node.style.setProperty('--deskpad-w', `${box.clientWidth}px`)
  }
  follow()
}
/** The Desk scrolled, or the list changed its height. */
function follow() {
  const shown = deskShown()
  if (shown && frame && !frame.getAttribute('src')) frame.src = '/pad/?embed=1&desk=1'
  if (shown !== open) { open = shown; tellPad() }
  if (!shown) { lastRoom = null; return }
  const at = roomTop()
  // The list changed its height and the page was scrolled along with it (js/inbox.js keeps the row he looks at in
  // place). While the paper is in front, what is under the pen stays instead: the scrolling is taken back.
  if (front && !gliding && lastRoom != null && Math.abs(at - lastRoom) >= 1 && Math.abs(box.scrollTop - lastTop) >= 1) box.scrollTop = lastTop
  if (Math.abs(box.scrollTop - lastTop) >= 1) { lastTop = box.scrollTop; moved() }
  if (lastRoom == null || Math.abs(at - lastRoom) >= 1) { lastRoom = at; grow() }
  padWindow()?.padDesk?.(Math.round(lastTop), Math.round(at), isLoaded())
}
// On a phone the switches never lie on a card: while the Desk scrolls, and at rest wherever something of the list
// would be under them, they are tucked away to a small tab at the left edge. A tap on the tab brings them out (until
// the next scroll). With the pen in hand or the cards hidden nothing is under them, and they are out.
const phone = matchMedia('(max-width: 860px)')
let moving = 0, pulled = false
function moved() {
  pulled = false
  clearTimeout(moving)
  moving = setTimeout(() => { moving = 0; tuck() }, 260)
  tuck()
}
function covers() {
  const r = over.firstElementChild.getBoundingClientRect()   // the pill's place (the pill itself slides)
  if (!r.width) return false
  for (const x of [r.left + 6, r.left + r.width / 2, r.right - 6]) for (const y of [r.top + 4, r.top + r.height / 2, r.bottom - 4]) {
    // Boxes that only hold cards let the pointer through, so they are not found here: only real content is.
    if (document.elementsFromPoint(x, y).some(n => box.contains(n) && !over.contains(n) && n.closest('.inbox-head, .inbox-groups'))) return true
  }
  return false
}
function tuck() {
  if (!over) return
  over.toggleAttribute('data-tuck', phone.matches && deskShown() && !pulled && !front && !cardsHidden && (Boolean(moving) || covers()))
}
function glideTo(where, how = glide()) {
  if (!box || !deskShown()) return
  box.scrollTo({ top: where(), behavior: how })
  const mine = gliding = {}
  const arrive = () => { if (gliding === mine) { gliding = false; follow() } }
  box.addEventListener('scrollend', arrive, { once: true })
  setTimeout(arrive, 1500)
}

/** The pen in hand on the Desk (true), or back to the pointer (false). */
function setDraw(on) {
  if (on && !deskShown()) document.getElementById('nav-inbox')?.click()
  const pad = padWindow()?.pad
  if (!pad) return
  if (on) { pad.tool('pen'); frame.focus() } else { pad.rest(); frame.blur(); window.focus() }
}
/** Hide the Desk's cards and stacks so that only the paper is left, or bring them back. Kept in this browser. */
export function toggleCards(hide = !cardsHidden) {
  cardsHidden = Boolean(hide)
  try { localStorage.setItem(HIDE_KEY, cardsHidden ? '1' : '0') } catch {}
  paintSwitch()
}
/** A point of the window in the paper's own pixels: x from the Desk's left edge, y from the top of the Desk's page.
 *  The same pixels place a child of paperLayer() with left and top. Null while the Desk is not shown. */
export function paperPoint(clientX, clientY) {
  if (!deskShown()) return null
  const r = box.getBoundingClientRect()
  return { x: Math.round((clientX - r.left - box.clientLeft) / zoom + panX), y: Math.round((clientY - r.top - box.clientTop + box.scrollTop) / zoom) }
}

// ---- zoom: a pinch on a touch screen ----
// The paper is as wide as it was written (on the desktop, usually); on a phone it is panned sideways, and a pinch
// with two fingers zooms it between "the whole written width fits" and 200 %. Only the paper scales (the pad's
// canvas, and the layer of things lying on it: one CSS scale); the Desk's cards stay at their size and in their
// column, so under zoom a drawing does not sit beside the card it was drawn beside. Kept in this browser.
const ZOOM_KEY = 'trommi-deskpad-zoom'
let zoom = 1, paperW = 0, pinch = null, pinchFrame = 0
const minZoom = () => (paperW && box.clientWidth ? Math.min(1, Math.max(0.15, box.clientWidth / paperW)) : 1)
function placeLayer() {
  layer.style.scale = String(zoom)
  layer.style.translate = `${-panX * zoom}px 0`
}
/** Zoom the paper to z, keeping the paper under the point (x, y) of the Desk's window where it is. */
function setZoom(z, x = 0, y = 0) {
  z = Math.min(2, Math.max(minZoom(), z))
  if (Math.abs(z - 1) < 0.03) z = 1
  if (z === zoom || !deskShown()) return
  const py = (box.scrollTop + y) / zoom
  zoom = z
  grow()   // room to scroll to, before the place is taken
  box.scrollTop = py * z - y
  padWindow()?.padZoom?.(z, x)
  placeLayer()
  lastTop = box.scrollTop; lastRoom = null   // this move was the zoom's, not the list's
  follow()
}
/** Two fingers: both on the Desk's cards (this page) or both on the paper between them (the pad's page). */
function watchPinch(target, inFrame) {
  const spread = e => Math.hypot(e.touches[0].screenX - e.touches[1].screenX, e.touches[0].screenY - e.touches[1].screenY) || 1
  target.addEventListener('touchstart', e => {
    // With a tool in hand two fingers scroll (the pad does that); the pinch is for the bare pointer.
    pinch = e.touches.length === 2 && padWindow()?.document.getElementById('pad')?.dataset.touch !== 'draw' ? { d: spread(e), z: zoom, r: inFrame ? { left: 0, top: 0 } : box.getBoundingClientRect() } : null
  }, { passive: true })
  target.addEventListener('touchmove', e => {
    if (!pinch || e.touches.length !== 2) return
    pinch.to = pinch.z * spread(e) / pinch.d
    pinch.x = (e.touches[0].clientX + e.touches[1].clientX) / 2 - pinch.r.left
    pinch.y = (e.touches[0].clientY + e.touches[1].clientY) / 2 - pinch.r.top
    pinchFrame ||= requestAnimationFrame(() => { pinchFrame = 0; if (pinch?.to) setZoom(pinch.to, pinch.x, pinch.y) })
  }, { passive: true })
  const end = e => {
    if (!pinch || e.touches.length > 1) return
    pinch = null
    try { localStorage.setItem(ZOOM_KEY, String(zoom)) } catch {}
  }
  target.addEventListener('touchend', end, { passive: true })
  target.addEventListener('touchcancel', end, { passive: true })
}
/** A layer on the paper for things that lie on it and scroll with it (above the drawing, below the cards): position
 *  children absolutely, in paperPoint()'s pixels. Null before the Desk has its paper. */
export const paperLayer = () => layer
let panX = 0

const SWITCH_ICONS = {
  pen: ['M4 20l1.200-4.400L16.600 4.200a2 2 0 012.900 0l.300.300a2 2 0 010 2.900L8.400 18.800z', 'M14.500 6.500l3 3'],
  eye: ['M2.600 12.300c2.400-4 5.600-6.100 9.500-6.100 3.800 0 7 2 9.400 5.900-2.500 3.900-5.600 5.800-9.500 5.800-3.800 0-7-1.900-9.400-5.600', 'M12 9.300a2.800 2.800 0 1 0 .100 0'],
  slash: ['M4.600 19.700C9.300 14.600 14.300 9.500 19.600 4.400'],
}
function switchButton(icons, label) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'deskpad-switch-btn'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  for (const name of icons) for (const d of SWITCH_ICONS[name]) {
    const path = document.createElementNS(NS, 'path')
    path.setAttribute('d', d)
    if (name === 'slash') path.setAttribute('class', 'deskpad-slash')
    svg.append(path)
  }
  b.append(svg, Object.assign(document.createElement('span'), { className: 'deskpad-switch-note' }))
  b.setAttribute('aria-label', label)
  b.title = label
  return b
}
function paintSwitch() {
  if (!box) return
  box.toggleAttribute('data-cards-hidden', cardsHidden)
  box.toggleAttribute('data-paper-front', front)
  penSwitch.setAttribute('aria-pressed', String(front))
  eyeSwitch.setAttribute('aria-pressed', String(cardsHidden))
  // Hidden never hides a knock: the switch says how many knock, and one press brings the cards back.
  const state = getState(), all = state.all
  const knocks = cardsHidden && all ? all.cards.filter(c => c.status === 'open' && isKnock(c) && all.queue.includes(c.id) && !(state.later ?? []).includes(c.id)).length : 0
  const note = eyeSwitch.querySelector('.deskpad-switch-note')
  note.textContent = knocks ? knocksText(knocks) : ''
  eyeSwitch.toggleAttribute('data-knocks', knocks > 0)
  const label = cardsHidden ? (knocks ? `${knocksText(knocks)}: show the cards again` : 'Show the cards again') : 'Hide the cards: only the paper'
  eyeSwitch.setAttribute('aria-label', label)
  eyeSwitch.title = label
  tuck()
}
function mountDesk(arrived) {
  box = document.getElementById('inbox')
  if (!box) return
  box.classList.add('has-deskpad')
  paper = document.createElement('section')
  paper.className = 'deskpad'
  paper.id = 'deskpad'
  paper.setAttribute('aria-label', `${PAD_WORD}: the Desk is paper`)
  frame = document.createElement('iframe')
  frame.title = PAD_WORD
  // The pad's page is a second app (its script, its strokes, a stream of its own): it is fetched when the Desk is
  // first in view (follow(), below), not on a session's page or an Agents page that never shows the paper.
  frame.tabIndex = -1   // not a stop for Tab: the paper is taken up with P or the pen switch, and left with Escape
  frame.setAttribute('aria-label', `${PAD_WORD}: the paper the Desk lies on`)
  frame.allow = 'clipboard-read; clipboard-write'
  paper.append(frame)
  layer = document.createElement('div')
  layer.className = 'deskpad-layer'
  layer.id = 'deskpad-layer'
  // The two switches, over everything: the pen (draw anywhere), the eye (hide the cards).
  over = document.createElement('div')
  over.className = 'deskpad-over'
  const pill = document.createElement('div')
  pill.className = 'deskpad-switch'
  pill.setAttribute('role', 'toolbar')
  pill.setAttribute('aria-label', PAD_WORD)
  penSwitch = switchButton(['pen'], 'Draw on the Desk, anywhere (P); Escape ends it')
  penSwitch.id = 'deskpad-pen'
  penSwitch.setAttribute('aria-keyshortcuts', 'P')
  eyeSwitch = switchButton(['eye', 'slash'], 'Hide the cards: only the paper')
  eyeSwitch.id = 'deskpad-eye'
  // In front without the pen (a note open, something selected): the switch still picks the pen up.
  penSwitch.addEventListener('click', () => setDraw(!(front && padWindow()?.pad?.state().tool !== 'select')))
  eyeSwitch.addEventListener('click', () => toggleCards())
  pill.append(penSwitch, eyeSwitch)
  // The pill's place stays put; the pill slides out of and into it (tuck()).
  const place = document.createElement('div')
  place.className = 'deskpad-switch-at'
  place.append(pill)
  over.append(place)
  // Tucked away, the pill is a tab: the first tap only brings it out.
  place.addEventListener('click', e => { if (over.hasAttribute('data-tuck')) { e.preventDefault(); e.stopPropagation(); pulled = true; tuck() } }, true)
  phone.addEventListener('change', () => { tuck(); grow() })
  const above = [...box.children]
  room = document.createElement('div')
  room.className = 'deskpad-room'
  box.prepend(paper, layer, over)
  box.append(room)
  box.addEventListener('scroll', follow, { passive: true })
  try { const z = Number(localStorage.getItem(ZOOM_KEY)); if (z >= 0.15 && z <= 2) zoom = z } catch {}
  watchPinch(box, false)
  new ResizeObserver(measure).observe(box)
  const watch = new ResizeObserver(() => { follow(); tuck() })
  for (const node of above) watch.observe(node)
  subscribe(() => { paintSwitch(); requestAnimationFrame(follow) })
  paintSwitch()
  measure()
  arrivedForPen = arrived
}
let arrivedForPen = false

if (DESK) {
  // /pad is the Desk with the pen in hand. The address becomes the Desk's, so that the page's own addresses go on working.
  const arrived = here()
  if (arrived) history.replaceState(history.state, '', '/' + location.search + location.hash)
  // No control in the bar: the paper is the Desk. The element stays, out of sight, for what goes there from elsewhere
  // by clicking it (the "Scratchpad" entry of the menu's jump list in js/bar.js); the key P calls togglePad.
  button.setAttribute('aria-label', `${PAD_WORD}: draw on the Desk`)
  button.hidden = true
  setTimeout(() => mountDesk(arrived), 0)   // after js/app.js has put the Desk's list into #inbox
}
else if (here()) show()
else {
  // Fetch the pad while nothing else is going on, so the first opening is quick too.
  const idle = window.requestIdleCallback ?? (fn => setTimeout(fn, 1200))
  idle(() => build(), { timeout: 4000 })
}
