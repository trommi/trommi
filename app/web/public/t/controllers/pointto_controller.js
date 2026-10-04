// Decided on card Nr. 208 (switch in views/gutter-hover.mjs, on by default): who asks is shown by a
// hand-drawn arrow from the session's row in the left sidebar to the Desk card under the pointer; and the other way
// round, a session row under the pointer draws arrows to its cards on the Desk. One SVG laid over the page (fixed),
// measured from both elements, redrawn on scroll and resize, gone when the pointer leaves. Wide screens with a mouse
// only (a phone has no sidebar beside the cards and no hover); under prefers-reduced-motion the arrow is not animated.
// Sits on a hidden element in the Desk's <main>: <div hidden data-controller="pointto" data-action="…">.
import { Controller } from '/js/app/stimulus.mjs'
import { arrowStrokes } from '/js/pen.js'

const NS = 'http://www.w3.org/2000/svg'
const wide = () => matchMedia('(min-width: 861px)').matches
const HOSTS = '#desk-list .inbox-row[data-from], #agents .agent-row[data-unit]'
const css = (id) => (window.CSS?.escape ? CSS.escape(id) : id)

export default class extends Controller {
  connect() {
    this.from = null; this.turn = 0
    this.onScroll = () => { if (this.from && !this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.redraw() }) }
    document.addEventListener('scroll', this.onScroll, { capture: true, passive: true })   // the Desk scrolls in its own box
  }
  disconnect() { document.removeEventListener('scroll', this.onScroll, { capture: true }); cancelAnimationFrame(this.frame); this.clear() }

  over(event) {
    if (!wide() || event.pointerType === 'touch') return
    this.at = [event.clientX, event.clientY]
    const host = event.target.closest?.(HOSTS)
    if (!host || host === this.from) return
    this.from = host
    this.turn++
    this.draw(true)
  }
  out(event) {
    if (!this.from || this.from.contains(event.relatedTarget)) return
    this.clear()
  }
  redraw() {
    if (!this.from) return
    if (!this.from.isConnected) this.from = (this.from.id && document.getElementById(this.from.id)) || this.under()   // a stream replaced it, or took it away
    if (this.from) this.draw(false); else this.remove()
  }
  /** The row now under the pointer where it last was (an answered row left, the next one moved up under it). */
  under() {
    if (!this.at) return null
    const host = document.elementFromPoint(...this.at)?.closest(HOSTS)
    if (host) this.turn++
    return host ?? null
  }
  /** A stream is about to change the page: draw again once it has. */
  later() { if (this.from) requestAnimationFrame(() => requestAnimationFrame(() => this.redraw())) }

  /** The pairs [sidebar row, card row] to join, for what is under the pointer. */
  pairs() {
    const host = this.from
    if (!host.isConnected) return []
    if (host.matches('.inbox-row')) {
      const row = this.sideRow(host.dataset.from)
      return row ? [[row, host]] : []
    }
    // A sidebar row: its own cards, and those of its subs when it stands for them (a folded main).
    const ids = [host.dataset.unit, ...[...document.querySelectorAll(`#agents .agent-row[data-parent="${css(host.dataset.unit)}"]`)].filter(r => r.hidden).map(r => r.dataset.unit)]
    return [...document.querySelectorAll('#desk-list .inbox-row[data-from]')].filter(r => ids.includes(r.dataset.from)).map(r => [host, r])
  }
  /** The session's row in the sidebar; a sub folded into its main is drawn from the main's row. */
  sideRow(id) {
    let row = document.getElementById(`agent-${id}`)
    while (row && row.hidden && row.dataset.parent) row = document.getElementById(`agent-${row.dataset.parent}`)
    return row && !row.hidden && row.getClientRects().length ? row : null
  }

  draw(fresh) {
    const pairs = this.pairs()
    if (!pairs.length) { this.remove(); return }
    const svg = this.svg ??= this.make()
    svg.replaceChildren()
    const still = !fresh || matchMedia('(prefers-reduced-motion: reduce)').matches
    const view = document.documentElement.clientHeight
    pairs.forEach(([side, card], i) => {
      const a = (side.querySelector('.agent-entry') ?? side).getBoundingClientRect(), b = card.getBoundingClientRect()
      if (b.bottom < 0 || b.top > view) return
      const start = [a.right + 4, a.top + a.height / 2]
      const gutter = card.querySelector(':scope > .inbox-gutter')?.getBoundingClientRect()
      const end = gutter?.width ? [gutter.left - 6, gutter.top + gutter.height / 2] : [b.left - 6, b.top + Math.min(32, b.height / 2)]
      const dx = end[0] - start[0], dy = end[1] - start[1]
      const bow = Math.min(90, Math.hypot(dx, dy) * .18)
      // a gentle arc: through two points lifted off the straight line, the pen's wobble added by arrowStrokes
      const at = t => [start[0] + dx * t, start[1] + dy * t - bow * Math.sin(Math.PI * t)]
      const points = [start, at(.3), at(.65), at(.9), end]
      const tone = getComputedStyle(card.querySelector(':scope > .inbox-gutter') ?? card).color
      const g = document.createElementNS(NS, 'g')
      g.setAttribute('stroke', tone)
      for (const d of arrowStrokes(points, `${card.id}:${this.turn}`)) {
        const path = document.createElementNS(NS, 'path')
        path.setAttribute('d', d)
        g.append(path)
      }
      svg.append(g)
      if (!still) {
        const [line, ...barbs] = g.children
        const len = line.getTotalLength()
        line.style.strokeDasharray = `${len}`
        line.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 260, delay: i * 40, easing: 'ease-out', fill: 'backwards' })
        for (const barb of barbs) barb.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 80, delay: 240 + i * 40, fill: 'backwards' })
      }
    })
  }
  make() {
    const svg = document.createElementNS(NS, 'svg')
    svg.classList.add('pointto-layer')
    svg.setAttribute('aria-hidden', 'true')
    document.body.append(svg)
    return svg
  }
  remove() { this.svg?.remove(); this.svg = null }
  clear() { this.from = null; this.remove() }
}
