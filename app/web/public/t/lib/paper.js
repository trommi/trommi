// The Desk is paper (docs/turbo.md "Controllers": controllers/paper_controller.js fetches this module for
// #paper-island on the Desk's page and calls mount(); memos use paperPoint(), paperLayer(), onPaper()).
//
// The pad's own page (/pad/?embed=1&desk=1&canvas=desk/<desk_id>, public/pad/) stands in a frame as high as the window that sticks
// to the top of the Desk's scroller (#inbox) and lies UNDER the heading, rows and stacks the hub rendered: they
// are objects on the paper. The Desk's scrolling says which part of the paper the frame paints. This file is the
// second half of the old client's js/padlink.js, carried over: the same frame, the same messages, the same
// styles (css/deskpad.css); the pad itself is not touched. What is different here:
//   - nothing is fetched or built until the page has painted and is idle, or the human first touches it;
//   - the sessions for the pad's chooser come from the hub's markup (data-sessions), not from a state event;
//   - what is on the paper is the desk's canvas timeline (desk/<desk_id>), end-to-end encrypted: the pad's page reads
//     and writes it through the app's client (pad/canvas.js); another desk is another paper;
//   - the elements carry data-turbo-permanent, and what a stream changes is a row or the list: the paper, the
//     tool in hand and the zoom are not touched by it;
//   - leaving the Desk (turbo:before-cache, or the element gone) takes the paper down, coming back lays it again.
// The listeners at the foot of this file hang on the document and the window once and do nothing while no Desk
// is shown (they outlive a page on purpose: the module is loaded once, the Desk comes and goes).

// The two switches (pen, clear the table) and the wipe of the cards: t/lib/clear.js.
import { switches, wipe } from './clear.js'
const PAD_WORD = 'Scratchpad'
const HIDE_KEY = 'trommi-desk-cards-hidden'
const ZOOM_KEY = 'trommi-deskpad-zoom'
const root = document.documentElement
const phone = matchMedia('(max-width: 860px)')

let marker = null     // #paper-island: what the hub says (sessions)
let laidDesk = null   // the desk whose paper is laid
let penLater = false  // the pen was asked for (/pad, P) before the Desk had its paper
let box = null, paper = null, frame = null, layer = null, over = null, room = null, penSwitch = null, clearSwitch = null
let ready = false     // the pad's page has started and listens
let extent = 0        // how far down the paper is used (the pad says)
let front = false     // the paper has the pointer (the pad says)
let lastTop = 0, lastRoom = null, lastContext = null
let gliding = false
let cardsHidden = false
let zoom = 1, paperW = 0, panX = 0, pinch = null, pinchFrame = 0
let watchers = []     // what has to be undone when the paper is taken down
let waiting = null    // the paper is asked for, not laid yet: the way to stop waiting
// Hidden cards are never carried over a reload: a page that comes up shows its cards. (The old client kept the flag
// in localStorage; one stray W then hid the Desk on every later load. That stale flag is cleared here.)
try { localStorage.removeItem(HIDE_KEY) } catch {}

// The styles: css/deskpad.css, loaded with the island (its rules only apply once the paper is there).
if (!document.querySelector('link[href="/css/deskpad.css"]')) document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: '/css/deskpad.css' }))

/** The desk in view: its paper is its canvas timeline. Without desks the board is one ('main'). */
const deskNow = () => { try { return window.trommi?.model?.()?.desk || 'main' } catch { return 'main' } }
// Whether the Desk is on screen: kept by the ResizeObserver of #inbox (measure), never read from layout on a scroll.
let boxShown = false
const deskShown = () => Boolean(box?.isConnected && boxShown)
/** Where the list ends, in the paper's own pixels (from the top of the Desk). */
const roomTop = () => room.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop
const padWindow = () => (ready ? frame?.contentWindow : null)
const knocks = () => (box ? box.querySelectorAll('.inbox-row .inbox-row-head .inbox-tab').length : 0)
const knocksText = n => (n === 1 ? '1 knock' : `${n} knocks`)

/** Tell the pad what it needs from the board. Sent again only when something changed. */
function tellPad(force = false) {
  if (!ready || !frame?.contentWindow) return
  const raw = marker?.dataset.sessions ?? '[]', open = deskShown(), theme = root.dataset.theme === 'dark' ? 'dark' : 'light'
  if (!force && lastContext && lastContext.raw === raw && lastContext.open === open && lastContext.theme === theme) return
  lastContext = { raw, open, theme }
  let sessions = []
  try { sessions = JSON.parse(raw) } catch {}
  frame.contentWindow.postMessage({ trommi: 'pad', type: 'context', open, prefer: [], theme, sessions }, location.origin)
}

/** Free paper under the lower of the list and the lowest thing drawn: one and a half windows, on a phone half of one. */
function grow() {
  const vh = box.clientHeight
  if (!vh || !deskShown()) return
  const pb = parseFloat(getComputedStyle(box).paddingBottom) || 0
  const h = `${Math.max(0, Math.round(Math.max(0, extent * zoom - roomTop()) + (phone.matches ? 0.5 : 1.5) * vh - pb))}px`
  if (room.style.height !== h) room.style.height = h
}
function measure(entries) {
  if (!box) return
  boxShown = entries?.[0] ? entries[0].contentRect.height > 0 : box.clientHeight > 0
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
  if (!box) return
  tellPad()
  if (!deskShown()) { lastRoom = null; return }
  const at = roomTop()
  // The list changed its height and the page was scrolled along with it. While the paper is in front, what is
  // under the pen stays instead: the scrolling is taken back.
  if (front && !gliding && lastRoom != null && Math.abs(at - lastRoom) >= 1 && Math.abs(box.scrollTop - lastTop) >= 1) box.scrollTop = lastTop
  if (Math.abs(box.scrollTop - lastTop) >= 1) lastTop = box.scrollTop
  if (lastRoom == null || Math.abs(at - lastRoom) >= 1) { lastRoom = at; grow() }
  padWindow()?.padDesk?.(Math.round(lastTop), Math.round(at), true)
}
/** The Desk scrolled. The list did not change its height by scrolling, so where it ends (lastRoom) stands: no layout
 *  is read, the pad only hears the new scroll position. (While the paper is in front, follow() checks for a scroll
 *  adjustment made for a changed list.) */
function scrolled() {
  if (!box || lastRoom == null || front) return follow()
  lastTop = box.scrollTop
  padWindow()?.padDesk?.(Math.round(lastTop), Math.round(lastRoom), true)
}
/** The pen in hand on the Desk (true), or back to the pointer (false). */
export function setDraw(on) {
  if (!box) return
  if (!frame) { lay(); penWanted = on; return }
  const pad = padWindow()?.pad
  if (!pad) { penWanted = on; return }
  if (on) { pad.tool('pen'); frame.focus() } else { pad.rest(); frame.blur(); window.focus() }
}
let penWanted = false   // the pen was asked for before the pad's page stood
/** The pen switch and the key P: pick the pen up, or put the tool down. */
export function togglePen() { setDraw(!(front && padWindow()?.pad?.state().tool !== 'select')) }
/** Hide the Desk's cards and stacks so that only the paper is left, or bring them back. Kept while this tab stays
 *  on the board (across Turbo visits), never across a reload. */
export function toggleCards(hide = !cardsHidden) {
  cardsHidden = Boolean(hide)
  if (box && !frame) lay()
  if (box && clearSwitch) wipe(box, cardsHidden, paintSwitch); else paintSwitch()
}
/** A point of the window in the paper's own pixels: x from the Desk's left edge, y from the top of the Desk's page.
 *  The same pixels place a child of paperLayer() with left and top. Null while the Desk has no paper. */
export function paperPoint(clientX, clientY) {
  if (!layer || !deskShown()) return null
  const r = box.getBoundingClientRect()
  return { x: Math.round((clientX - r.left - box.clientLeft) / zoom + panX), y: Math.round((clientY - r.top - box.clientTop + box.scrollTop) / zoom) }
}
/** A layer on the paper for things that lie on it and scroll with it (above the drawing, below the cards): position
 *  children absolutely, in paperPoint()'s pixels. Null before the Desk has its paper. */
export const paperLayer = () => (layer?.isConnected ? layer : null)
/** Does the point lie on the Desk's bare paper, with nothing of the page over it? but: a node that is not in the way. */
export function onPaper(x, y, but = null) {
  if (!paperLayer() || !deskShown()) return false
  const was = but?.style.pointerEvents
  if (but) but.style.pointerEvents = 'none'
  const hit = document.elementFromPoint(x, y)
  if (but) but.style.pointerEvents = was
  return Boolean(hit?.closest('#deskpad, #deskpad-layer')) && !hit.closest('.memo')
}

// ---- zoom: a pinch on a touch screen ----
// Only the paper scales (the pad's canvas, and the layer of things lying on it: one CSS scale); the Desk's cards
// stay at their size and in their column. Between "the whole written width fits" and 200 %. Kept in this browser.
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
    pinch = box && e.touches.length === 2 && padWindow()?.document.getElementById('pad')?.dataset.touch !== 'draw' ? { d: spread(e), z: zoom, r: inFrame ? { left: 0, top: 0 } : box.getBoundingClientRect() } : null
  }, { passive: true })
  target.addEventListener('touchmove', e => {
    if (!pinch || e.touches.length !== 2) return
    pinch.to = pinch.z * spread(e) / pinch.d
    pinch.x = (e.touches[0].clientX + e.touches[1].clientX) / 2 - pinch.r.left
    pinch.y = (e.touches[0].clientY + e.touches[1].clientY) / 2 - pinch.r.top
    pinchFrame ||= requestAnimationFrame(() => { pinchFrame = 0; if (box && pinch?.to) setZoom(pinch.to, pinch.x, pinch.y) })
  }, { passive: true })
  const end = e => {
    if (!pinch || e.touches.length > 1) return
    pinch = null
    try { localStorage.setItem(ZOOM_KEY, String(zoom)) } catch {}
  }
  target.addEventListener('touchend', end, { passive: true })
  target.addEventListener('touchcancel', end, { passive: true })
}

// ---- the two switches beside the memo button: the pen (draw anywhere), clear the table (only the paper) ----
function paintSwitch() {
  if (!box) return
  box.toggleAttribute('data-cards-hidden', cardsHidden && Boolean(paper))
  box.toggleAttribute('data-paper-front', front)
  if (!penSwitch) return
  penSwitch.setAttribute('aria-pressed', String(front))
  clearSwitch.setAttribute('aria-pressed', String(cardsHidden))
  // Hidden never hides a knock: the switch says how many knock, and one press brings the cards back.
  const n = cardsHidden ? knocks() : 0
  const note = clearSwitch.querySelector('.clear-note')
  const text = n ? knocksText(n) : ''
  if (note.textContent !== text) note.textContent = text
  clearSwitch.toggleAttribute('data-knocks', n > 0)
  const label = cardsHidden ? (n ? `${knocksText(n)}: show the cards again` : 'Show the cards again') : 'Clear the table: only the paper (W)'
  if (clearSwitch.title !== label) { clearSwitch.setAttribute('aria-label', label); clearSwitch.title = label }
}

/** The Desk's own things come first after the paper's three boxes, and the free room is last. A morph may have put
 *  new nodes before them; those are moved, never the frame (a frame that is moved loads again). */
function order() {
  if (!box || !paper?.isConnected) return
  while (box.firstElementChild && ![paper, layer, over].includes(box.firstElementChild)) over.after(box.firstElementChild)
  if (layer.previousElementSibling !== paper) paper.after(layer)
  if (over.previousElementSibling !== layer) layer.after(over)
  if (box.lastElementChild !== room) box.append(room)
}

/** Lay the paper under the Desk: the frame, the layer, the switches, the free room. */
function lay() {
  waiting?.()
  // The Desk may have been painted anew since mount() (a first catch-up, a desk switch): lay under the one shown now.
  if (!paper && !box?.isConnected && marker?.isConnected) box = document.getElementById('inbox')
  if (!box?.isConnected || paper) return
  box.classList.add('has-deskpad')
  const permanent = (node, id) => { node.id = id; node.setAttribute('data-turbo-permanent', ''); return node }
  paper = permanent(document.createElement('section'), 'deskpad')
  paper.className = 'deskpad'
  paper.setAttribute('aria-label', `${PAD_WORD}: the Desk is paper`)
  frame = document.createElement('iframe')
  frame.title = PAD_WORD
  frame.tabIndex = -1   // not a stop for Tab: the paper is taken up with P or the pen switch, and left with Escape
  frame.setAttribute('aria-label', `${PAD_WORD}: the paper the Desk lies on`)
  frame.allow = 'clipboard-read; clipboard-write'
  laidDesk = deskNow()
  frame.style.visibility = 'hidden'   // until the pad's page has painted (no white page while it loads, in dark mode)
  frame.src = `/pad/?embed=1&desk=1&canvas=${encodeURIComponent(`desk/${laidDesk}`)}`
  paper.append(frame)
  layer = permanent(document.createElement('div'), 'deskpad-layer')
  layer.className = 'deskpad-layer'
  over = permanent(document.createElement('div'), 'deskpad-over')
  over.className = 'deskpad-over'
  const made = switches(PAD_WORD)
  penSwitch = made.pen
  clearSwitch = made.clear
  penSwitch.addEventListener('click', togglePen)
  clearSwitch.addEventListener('click', () => toggleCards())
  over.append(made.place)
  room = permanent(document.createElement('div'), 'deskpad-room')
  room.className = 'deskpad-room'
  box.prepend(paper, layer, over)
  box.append(room)
  try { const z = Number(localStorage.getItem(ZOOM_KEY)); if (z >= 0.15 && z <= 2) zoom = z } catch {}
  placeLayer()

  box.addEventListener('scroll', scrolled, { passive: true })
  watchPinch(box, false)
  const sized = new ResizeObserver(measure)
  sized.observe(box)
  const list = new ResizeObserver(follow)
  const watchList = () => { for (const node of box.querySelectorAll(':scope > .inbox-head, :scope > .inbox-groups')) list.observe(node) }
  watchList()
  // A stream replaced a row, the heading or the list: the paper follows; it is not laid again.
  let due = 0
  // Rows filled in while the Desk scrolls (desk-window) change only what lies inside the list: its height reaches
  // the paper through the ResizeObserver above, so nothing here reads layout for them. Only a change of the Desk's own
  // children (the list or heading replaced) is ordered and watched again; the knocks are counted while cards are hidden.
  const changed = new MutationObserver(records => {
    const top = records.some(r => r.target === box)
    if (!top && !cardsHidden) return
    due ||= requestAnimationFrame(() => { due = 0; if (!box) return; if (top) { order(); watchList(); tellPad() } paintSwitch() })
  })
  changed.observe(box, { childList: true, subtree: true })
  const onPhone = () => grow()
  phone.addEventListener('change', onPhone)
  watchers = [() => sized.disconnect(), () => list.disconnect(), () => changed.disconnect(), () => phone.removeEventListener('change', onPhone), () => cancelAnimationFrame(due)]
  paintSwitch()
  measure()
  document.dispatchEvent(new CustomEvent('paper:ready'))
}

/** Take the paper down (the Desk is left, or its page goes into Turbo's cache): the next Desk lays its own. */
function lift() {
  waiting?.()
  if (paper) document.dispatchEvent(new CustomEvent('paper:gone'))   // what lies on the layer goes home first (memo.js)
  for (const undo of watchers) undo()
  watchers = []
  for (const node of [paper, layer, over, room]) node?.remove()
  if (box) { box.classList.remove('has-deskpad'); box.removeAttribute('data-paper-front'); box.removeAttribute('data-cards-hidden'); box.removeEventListener('scroll', scrolled) }
  box = paper = frame = layer = over = room = penSwitch = clearSwitch = null
  boxShown = false
  ready = front = gliding = penWanted = false
  extent = panX = lastTop = 0
  lastRoom = pinch = null
  lastContext = null
}

/** The controller calls this for #paper-island: on every Desk page, and again when a stream replaced the element. */
export function mount(node) {
  marker = node
  const desk = document.getElementById('inbox')
  if (box && box === desk && box.isConnected && (!paper || laidDesk === deskNow())) return tellPad()   // the same Desk: only what the hub says is new
  lift()
  box = desk
  if (!box) return
  // /pad (the router sets window.trommi.pen: its event may come before this module is loaded)
  if (window.trommi?.pen) { window.trommi.pen = false; penLater = true }
  if (penLater) { penLater = false; penWanted = true; return lay() }   // /pad: the paper at once, the pen in hand
  if (cardsHidden) return lay()   // hidden in this tab before (a Turbo visit away and back): the switch says so
  // Nothing of the pad is fetched before the page has painted: when the browser is idle, or at the first touch.
  const go = () => lay()
  const first = ['pointerdown', 'keydown', 'touchstart', 'wheel']
  const idle = window.requestIdleCallback ? requestIdleCallback(go, { timeout: 2500 }) : setTimeout(go, 600)
  for (const type of first) window.addEventListener(type, go, { once: true, passive: true, capture: true })
  waiting = () => {
    waiting = null
    window.cancelIdleCallback ? cancelIdleCallback(idle) : clearTimeout(idle)
    for (const type of first) window.removeEventListener(type, go, { capture: true })
  }
}

/** The element left the page: with its Desk (the paper is taken down), or for a newer one (nothing to do). */
export function leave(node) { if (marker === node && !document.getElementById('paper-island')) lift() }

// ---- once, for every Desk this tab shows ----
// The app's router fires turbo:before-cache before every paint, also when the Desk is painted again in place (its
// parts kept): the paper stays then, and turbo:render below checks what is left. A page without the Desk takes it down.
// A refresh morphed the page in place: the paper stayed (data-turbo-permanent); its order and what the hub says are checked.
for (const type of ['turbo:render', 'turbo:morph']) document.addEventListener(type, () => {
  if (!box) return
  const island = document.getElementById('paper-island')
  if (!island) return lift()
  // The Desk was painted anew (a new #inbox): the paper is laid again under the new one.
  if (!box.isConnected) { lift(); mount(island); return }
  marker = document.getElementById('paper-island') ?? marker
  order(); paintSwitch(); follow(); tellPad()
})
new MutationObserver(() => tellPad()).observe(root, { attributes: true, attributeFilter: ['data-theme'] })

window.addEventListener('message', e => {
  if (e.origin !== location.origin || !frame || e.source !== frame.contentWindow || e.data?.trommi !== 'pad') return
  const msg = e.data
  if (msg.type === 'ready') {
    ready = true
    requestAnimationFrame(() => requestAnimationFrame(() => { if (frame) frame.style.visibility = '' }))
    tellPad(true)
    watchPinch(frame.contentDocument, true)
    if (zoom !== 1) { frame.contentWindow.padZoom?.(zoom, 0); placeLayer(); grow() }
    follow()
    if (penWanted) { penWanted = false; setDraw(true) }
  }
  else if (msg.type === 'extent') { extent = Math.max(0, Number(msg.bottom) || 0); paperW = Math.max(0, Number(msg.width) || 0); grow() }
  else if (msg.type === 'scroll') box?.scrollBy({ top: Number(msg.by) || 0, behavior: 'instant' })
  else if (msg.type === 'close') { frame.blur(); window.focus() }   // Escape with nothing to let go of: the keys are the board's again
  else if (msg.type === 'front') {
    front = Boolean(msg.front)
    paintSwitch()
    if (!front && document.activeElement === frame) { frame.blur(); window.focus() }   // back to the pointer: the board's keys work again
  }
  else if (msg.type === 'pan') { panX = Number(msg.x) || 0; placeLayer() }
  else if (msg.type === 'theme') {
    // The pad's own switch was used: the board follows, through its own switch so it paints itself.
    if ((root.dataset.theme === 'dark') !== (msg.theme === 'dark')) document.getElementById('theme-toggle')?.click()
  }
})

// The keys of the paper, on the Desk: P takes the pen up (and puts it down), W hides the cards and brings them back.
// The table of keys is the island "keys": it only says so on the document. (While the pad's frame has the
// keyboard, the keys are the pad's: P is its pen, Escape gives the keyboard back.)
document.addEventListener('trommi:pen', () => { if (box?.isConnected) togglePen(); else penLater = true })
document.addEventListener('trommi:cards', () => { if (box?.isConnected) toggleCards() })
