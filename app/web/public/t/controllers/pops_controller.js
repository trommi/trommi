// Small things that open right at their control (docs/turbo.md): <details class="t-pick"> with its content
// lying over the page (rename, the drawings, a choice of desk or main agent, the phone's sheet of a line).
// The hub renders them; this only does what <details> does not do by itself:
//   - Escape or a click beside it closes; opening one closes the others; a "Cancel"/"Close" (data-pop-close) closes
//   - the keyboard goes into the field of the one that opened, its text selected
//   - while one is open, the live stream does not replace the element it stands in (he may be typing):
//     what came is held and applied when it closes
//   - "/" goes to the Agents page's find field
// Any element with data-controller="pops" loads this. The controls may stand anywhere in the page and are replaced
// by streams, so the listeners hang on the document: added when the first such element connects, removed with the last.
import { Controller } from '/js/app/stimulus.mjs'

const opened = () => [...document.querySelectorAll('details.t-pick[open]')]
const held = new Map()   // "action target" -> the stream element that waits

function flush() {
  if (!held.size || opened().length) return
  const waiting = [...held.values()]
  held.clear()
  for (const el of waiting) document.documentElement.append(el)
}
function close(pick, { focus = false } = {}) {
  if (!pick?.open) return
  pick.open = false
  if (focus) pick.querySelector(':scope > summary')?.focus({ preventScroll: true })
}

function onToggle(e) {
  const pick = e.target
  if (!(pick instanceof HTMLDetailsElement) || !pick.matches('details.t-pick')) return
  if (!pick.open) return flush()
  for (const other of opened()) if (other !== pick && !other.contains(pick)) other.open = false
  const field = pick.querySelector('input[type="text"]')
  if (field && field.getClientRects().length && !matchMedia('(max-width: 860px)').matches) { field.focus({ preventScroll: true }); field.select() }
}

function onClick(e) {
  const t = e.target instanceof Element ? e.target : null
  if (!t) return
  if (t.closest('[data-pop-close]')) return close(t.closest('details.t-pick'), { focus: true })
  for (const pick of opened()) if (!pick.contains(t)) pick.open = false
}

function onKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return
  if (e.key === 'Escape') {
    const last = opened().at(-1)
    if (last) { e.preventDefault(); e.stopPropagation(); close(last, { focus: true }) }
    return
  }
  const typing = e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
  if (e.key === '/' && !typing && !opened().length) {
    const find = document.querySelector('.ledger-find input')
    if (find) { e.preventDefault(); find.focus(); find.select() }
  }
}

// A form that was sent has done its work: its control closes, so the answer and the live stream can land.
function onSubmit(e) {
  for (let pick = e.target.closest?.('details.t-pick'); pick; pick = pick.parentElement?.closest('details.t-pick')) pick.open = false
}

function onStream(e) {
  const el = e.target, open = opened()
  if (!open.length || !el?.getAttribute) return
  const action = el.getAttribute('action'), target = el.getAttribute('target')
  const node = target ? document.getElementById(target) : null
  const hits = action === 'refresh' ? true : Boolean(node) && open.some(pick => node.contains(pick))
  if (!hits) return
  e.preventDefault()
  held.set(`${action} ${target ?? ''}`, el.cloneNode(true))
}

const LISTENERS = [['toggle', onToggle, true], ['click', onClick, false], ['keydown', onKey, true], ['turbo:submit-start', onSubmit, false], ['turbo:before-stream-render', onStream, false]]
let connected = 0

export default class extends Controller {
  connect() { if (connected++ === 0) for (const [name, fn, capture] of LISTENERS) document.addEventListener(name, fn, capture) }
  disconnect() { if (--connected === 0) for (const [name, fn, capture] of LISTENERS) document.removeEventListener(name, fn, capture) }
}
