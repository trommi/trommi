// What just happened, and the way back. Whenever a question leaves the view (answered, put
// off, asked about), one small note at the top left says so in plain words ("Answered: Yes",
// "Snoozed") and carries "Back", which undoes it. The note stays a few seconds; a
// scribbled line under it runs out, and waits while the pointer rests on the note or the
// keyboard is in it. The key for "back" works a little longer than the note is shown.
// One wording and one place, on the page and in the Focus window.

import { el } from './ui.js'
import { cap } from './keys.js'

const SVG_NS = 'http://www.w3.org/2000/svg'
const svg = (cls, box, ...paths) => {
  const node = document.createElementNS(SVG_NS, 'svg')
  node.setAttribute('class', cls)
  node.setAttribute('viewBox', box)
  node.setAttribute('aria-hidden', 'true')
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    path.setAttribute('pathLength', '100')
    node.append(path)
  }
  return node
}

/** How long the note is shown, and how long the key still works after the answer. */
export const BACK_MS = 4000
export const BACK_KEY_MS = 10000

const notes = new WeakMap()   // host -> the note standing in it
let last = null               // { back, until }: what the key takes back once the note has gone
let usedAt = 0                // when "Back" was last used
/** When "Back" was last used: a list brings the question that returns just after into view. */
export const backUsedAt = () => usedAt

/** The place for notes about the page itself. On a wide screen the top left corner of whatever main view
 *  is up, where no control stands. A phone has no such corner: there the view gives up a strip at its lower
 *  edge for as long as the note is there (css, body[data-says]), so the note covers nothing and nothing moves. */
const phone = matchMedia('(max-width: 860px)')
let pageNode = null
export function pageHost() {
  if (!pageNode) {
    pageNode = el('div', 'says-host says-page')
    document.body.append(pageNode)
  }
  document.body.dataset.says = ''
  const main = [...document.querySelectorAll('main')].find(n => n.getClientRects().length)
  const box = main?.getBoundingClientRect()
  pageNode.style.left = `${Math.round((box?.left ?? 0) + (phone.matches ? 8 : 14))}px`
  pageNode.style.top = phone.matches ? `${Math.round((box?.bottom ?? window.innerHeight - 64) + 6)}px` : `${Math.round((box?.top ?? 0) + 14)}px`
  return pageNode
}

/** Put a note into host (an element that css places at the top left of its view).
 *    head: what happened, a few words ("Answered: Yes"). title: the question it happened to.
 *    back(): async, undoes it; a rejection goes to onFail(err). Without back the note only tells.
 *  A note replaces the one before it. Returns { node, stop() }. */
export function say(host, { head, title = '', back = null, onFail, ms = BACK_MS }) {
  notes.get(host)?.stop()
  const node = el('div', 'says')
  node.setAttribute('role', 'status')
  node.style.setProperty('--back-ms', `${ms}ms`)
  const words = el('p', 'says-words')
  words.append(el('b', null, head))
  if (title) words.append(el('span', null, title))
  node.append(words)

  let left = ms, since = 0, timer = 0, over = false, within = false, done = false
  const stop = () => {
    done = true
    clearTimeout(timer)
    node.remove()
    if (notes.get(host)?.node !== node) return
    notes.delete(host)
    if (host === pageNode) delete document.body.dataset.says
  }
  // The clock stops while the pointer rests on the note or the keyboard is in it.
  const tick = () => {
    clearTimeout(timer)
    const paused = over || within
    node.toggleAttribute('data-paused', paused)
    if (done) return
    if (paused) { if (since) { left -= performance.now() - since; since = 0 } return }
    since = performance.now()
    timer = setTimeout(stop, Math.max(0, left))
  }
  node.addEventListener('pointerenter', () => { over = true; tick() })
  node.addEventListener('pointerleave', () => { over = false; tick() })
  node.addEventListener('focusin', e => { within = e.target.matches(':focus-visible'); tick() })
  node.addEventListener('focusout', () => { within = false; tick() })

  if (back) {
    const button = el('button', 'says-back')
    button.type = 'button'
    button.append(svg('back-arrow', '0 0 24 24', 'M9.500 6.500C7.400 8.300 5.900 9.700 4.400 11.800c1.700 1.300 3.500 2.900 5.300 4.900', 'M4.800 11.700c5.200-.6 9.700-.5 12.300 1.300 2.400 1.700 2.600 4.300 1.600 6.300'), el('span', null, 'Back'), el('kbd', null, cap('back')))
    button.setAttribute('aria-label', `Back: take back "${head}"${title ? `, ${title}` : ''}`)
    const run = async () => {
      if (last?.back === run) last = null
      usedAt = Date.now()
      button.disabled = true
      clearTimeout(timer)
      try { await back() } catch (err) { onFail?.(err) }
      stop()
    }
    button.addEventListener('click', run)
    last = { back: run, until: Date.now() + BACK_KEY_MS }
    node.append(button)
  }
  // The time left: a line drawn by hand that runs out from its end.
  const line = svg('back-line', '0 0 200 8', 'M2 4.600C14 2 24 6.800 38 4.200S62 2.600 76 4.800s26 1.200 40-.6 28 2.600 42 .8 26-1.400 40 .2')
  line.setAttribute('preserveAspectRatio', 'none')
  node.append(line)

  host.replaceChildren(node)
  if (host === pageNode) document.body.dataset.says = ''
  // A second tap meant for the next answer must not land on "Back": for a moment the note lets taps through.
  node.dataset.fresh = ''
  setTimeout(() => delete node.dataset.fresh, 400)
  notes.set(host, { node, stop })
  tick()
  return { node, stop }
}

/** The key for "back": the note that is up, or what it offered until a moment ago. False when there is nothing to take back. */
export function backNow() {
  const button = [...document.querySelectorAll('.says-back:not(:disabled)')].find(n => n.getClientRects().length && !n.closest('[inert]'))
  if (button) { button.click(); return true }
  if (!last || Date.now() > last.until) return false
  last.back()
  return true
}
/** Nothing is left to take back (the view that offered it is gone). */
export function forgetBack() { last = null }
