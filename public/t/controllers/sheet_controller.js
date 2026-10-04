// A phone: the ways out of a Desk row behind a long press (css/phone-desk.css). The row shows who asks, the
// title and the answers; Snooze, Revise, Whatever, What??, Shred and Open come up as a sheet after a long press
// on the row, or a right click. The sheet is the hub's (views/menu.mjs, rowSheet): one form whose buttons
// are pointed at the row that was held. No veil; Escape, a tap beside it or focus leaving it closes. The finger
// that held does not open the link under it, and selects no text (the stylesheet takes selection and the callout
// off the row).
// The dialog is opened with show(), not showModal(): a modal dialog makes the whole page inert, and on a phone
// with a full Desk that costs a style recalculation of every element when it opens and again when it closes
// (60-90 ms each at 4x CPU, measured). What modal gave us is done here: a tap beside the sheet only closes it.
import { Controller } from '/js/app/stimulus.mjs'

const PHONE = matchMedia('(max-width: 860px)')
const HOLD_MS = 450
const HOLD_SLOP = 10   // px a finger may wander and still be holding
// Which ways a row has: the ones the hub put on it as buttons (a permission has neither Revise nor Shred).
const HAS = { snooze: '.inbox-later', revise: '.inbox-revise', trust: '.inbox-trust', what: '.inbox-revise', shred: '.inbox-shred' }
const rowOf = e => (e.target instanceof Element && !e.target.closest('.inbox-actions') ? e.target.closest('#desk-list .inbox-row') : null)

export default class extends Controller {
  static values = { cards: String }

  connect() {
    this.stop = new AbortController()
    this.held = false    // a long press opened the sheet: the click that follows the lift is no tap
    this.armed = false   // nothing on the sheet acts before the finger that held is gone
    this.scrolled = { at: 0, node: null }   // the last scroll anywhere: a finger that scrolls, or stops a scroll, is not holding
    const s = this.element
    const on = (target, name, fn, opts = {}) => target.addEventListener(name, fn, { signal: this.stop.signal, ...opts })
    const beside = e => s.open && !s.contains(e.target)
    on(window, 'scroll', e => { this.scrolled = { at: performance.now(), node: e.target } }, { capture: true, passive: true })
    on(document, 'pointerdown', e => this.down(e))
    on(document, 'pointermove', e => { if (this.timer && Math.hypot(e.clientX - this.x0, e.clientY - this.y0) > HOLD_SLOP) this.drop() })
    for (const name of ['pointerup', 'pointercancel']) on(document, name, () => this.drop())
    // The sheet comes up under the finger that is still down. Its lift is no tap: the sheet is armed a moment after it, or by the next finger.
    for (const name of ['pointerup', 'pointercancel', 'pointerdown']) on(window, name, e => { if (!s.open) return; if (e.type === 'pointerdown') this.armed = true; else setTimeout(() => { this.armed = true }, 300) }, { capture: true })
    on(document, 'contextmenu', e => {
      const row = rowOf(e)
      if (!row || !PHONE.matches) return
      e.preventDefault()
      if (!this.held && !s.open) { this.node = row; this.open(row); this.armed = true }
    })
    // A click beside the open sheet closes it and reaches nothing else; the lift of the finger that held is no tap on the title under it.
    on(document, 'click', e => {
      if (beside(e)) { e.preventDefault(); e.stopPropagation(); if (this.armed) this.close() }
      else if (this.held && !s.contains(e.target)) { this.held = false; e.preventDefault(); e.stopPropagation() }
    }, { capture: true })
    on(document, 'keydown', e => { if (!s.open) return; this.armed = true; if (e.key === 'Escape') { e.preventDefault(); this.close() } }, { capture: true })
    // Focus that leaves the sheet by the keyboard closes it; a finger's focus beside it is left to the click above.
    on(document, 'pointerdown', () => { this.pointed = performance.now() }, { capture: true })
    on(document, 'focusin', e => { if (beside(e) && performance.now() - (this.pointed ?? -1e9) > 1000) this.close() })
    on(s, 'close', () => { this.held = false; for (const f of this.frames ?? []) f.style.pointerEvents = ''; this.frames = [] })
  }
  disconnect() { this.drop(); this.stop.abort(); if (this.element.open) this.element.close() }

  scrolledSince(t) { return this.scrolled.at >= t && (this.scrolled.node === document || this.scrolled.node?.contains?.(this.node)) }
  drop() { clearTimeout(this.timer); this.timer = 0; this.node?.classList.remove('is-held') }
  down(e) {
    this.held = false
    this.drop()
    if (this.element.open) return   // a finger beside the open sheet: the click that follows closes it
    this.node = rowOf(e)
    if (!this.node || !PHONE.matches || !e.isPrimary || e.button > 0) return
    const at = performance.now(), row = this.node
    if (this.scrolledSince(at - 250)) return   // the list was moving: this finger stops it
    this.x0 = e.clientX; this.y0 = e.clientY
    row.classList.add('is-held')
    this.timer = setTimeout(() => { if (this.scrolledSince(at)) this.drop(); else this.open(row) }, HOLD_MS)
  }
  open(row) {
    this.drop()
    const s = this.element
    if (s.open || !row.isConnected) return
    this.held = true
    this.armed = false
    s.style.setProperty('--hue', row.style.getPropertyValue('--hue') || '162')
    s.querySelector('h3').textContent = row.querySelector('.inbox-question')?.textContent ?? ''
    for (const b of s.querySelectorAll('button[data-way]')) {
      b.hidden = !row.querySelector(HAS[b.dataset.way])
      b.setAttribute('formaction', `${this.cardsValue}/${row.dataset.id}/${b.dataset.way}`)
    }
    const link = row.querySelector('a.inbox-text')
    if (link) s.querySelector('.rowmenu-open').href = link.href
    this.back = document.activeElement
    // a frame on the page (the Desk paper) would take a tap beside the sheet for itself: frames take none while it is open
    this.frames = [...document.querySelectorAll('iframe')].filter(f => f.style.pointerEvents !== 'none')
    for (const f of this.frames) f.style.pointerEvents = 'none'
    s.show()
    s.querySelector('button:not([hidden]), a')?.focus({ preventScroll: true })
  }
  close() {
    const s = this.element
    if (!s.open) return
    this.held = false
    s.close()
    if (this.back?.isConnected && s.contains(document.activeElement)) this.back.focus({ preventScroll: true })
  }

  // A click on the sheet (data-action): not before it is armed; on "Open" it closes.
  tapped(event) {
    if (!this.armed) { event.preventDefault(); event.stopPropagation(); return }
    if (event.target.closest('.rowmenu-open')) this.close()
  }
  // A way was chosen: the sheet goes, the hub's answer takes the row away and says what happened.
  sent() { this.close() }
}
