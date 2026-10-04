// The Desk's list (views/desk.mjs). "New questions must not move my window": a card that arrives out of
// sight is said quietly ("1 new ↓", a tap goes there), and a knock that is out of sight has one strip at the edge
// of the list it lies beyond ("↓ 1 knock"), which leads to the nearest one.
// Which rows stand in sight is told by an IntersectionObserver; a row out of sight is above or below by its place in
// the list (rows are in order), so scrolling costs nothing and no row is measured while a page is being built.
import { Controller } from '/js/app/stimulus.mjs'

const knocks = n => (n === 1 ? '1 knock' : `${n} knocks`)
const EDGE = 24   // a row closer than this to the window's edge counts as out of sight
const before = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
export default class extends Controller {
  static targets = ['list', 'news', 'up', 'down']
  connect() {
    // (A target is looked up on every read; these elements stay for the page's life: kept once.)
    this.list = this.listTarget; this.news = this.newsTarget; this.up = this.upTarget; this.down = this.downTarget
    this.unseen = new Set()      // ids of rows that arrived out of sight
    this.shown = new Set()       // rows in sight now
    this.listAt = 'in'           // the list as a whole: 'in' sight, 'up' (scrolled past) or 'down' (not reached)
    this.io = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (e.target === this.list) { const r = e.boundingClientRect; this.listAt = e.isIntersecting ? 'in' : r.bottom <= EDGE ? 'up' : 'down'; continue }
        if (e.isIntersecting && e.boundingClientRect.height) { this.shown.add(e.target); this.unseen.delete(e.target.id) } else this.shown.delete(e.target)
      }
      this.look()
    }, { rootMargin: `-${EDGE}px 0px` })
    this.io.observe(this.list)
    for (const row of this.list.querySelectorAll('.inbox-row')) this.io.observe(row)
    this.mo = new MutationObserver(records => {
      for (const r of records) {
        for (const node of r.addedNodes) if (node.nodeType === 1) { if (node.matches('.inbox-row')) this.io.observe(node); else if (node.firstElementChild) for (const row of node.querySelectorAll('.inbox-row')) this.io.observe(row) }
        for (const node of r.removedNodes) if (node.nodeType === 1) this.forget(node)
      }
      this.look()
    })
    this.mo.observe(this.list, { childList: true, subtree: true })
    // Where the list stands across, for the strips: read when its box changes (layout is fresh then), never per frame.
    this.ro = new ResizeObserver(() => { this.across = this.list.getBoundingClientRect(); this.look() })
    this.ro.observe(this.list)
  }
  disconnect() { this.io.disconnect(); this.mo.disconnect(); this.ro.disconnect(); cancelAnimationFrame(this.frame) }
  forget(node) { for (const row of this.shown) if (row === node || node.contains(row)) this.shown.delete(row) }

  // A stream is about to put a row in: it is "new" until it has been in sight.
  changing(event) {
    const el = event.target
    if (el.action !== 'before' || el.target !== 'desk-stacks') return
    const id = el.templateContent?.querySelector('.inbox-row')?.id
    if (id) this.unseen.add(id)   // (the observer says at once if it stands in sight, and takes it off)
  }
  /** Where a row out of sight lies: 'up' or 'down' (by its place against the rows in sight, or the list's own). */
  side(row) {
    if (this.shown.has(row)) return 'in'
    if (!this.shown.size) return this.listAt === 'down' ? 'down' : 'up'   // (no row in sight but the list: its foot, the stacks)
    for (const seen of this.shown) return before(row, seen) ? 'up' : 'down'
  }
  // Draw the news line and the two strips, once per frame at most.
  look() {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      for (const row of this.shown) if (!row.isConnected) this.shown.delete(row)
      const fresh = [...this.unseen].map(id => document.getElementById(id)).filter(row => row && !this.shown.has(row))
      this.news.hidden = !fresh.length
      if (fresh.length) { this.news.textContent = `${fresh.length} new ↓`; this.news.setAttribute('aria-label', `${fresh.length} new below: go there`) }
      const beyond = { up: [], down: [] }
      for (const row of this.list.querySelectorAll('.inbox-row[data-knock]')) { const at = this.side(row); if (at !== 'in') beyond[at].push(row) }
      this.beyond = beyond
      for (const [dir, button] of [['up', this.up], ['down', this.down]]) {
        const n = beyond[dir].length
        button.hidden = !n
        if (!n) continue
        button.querySelector('span').textContent = knocks(n)
        button.setAttribute('aria-label', `${knocks(n)} ${dir === 'up' ? 'above' : 'below'}: go there`)
        if (this.across) Object.assign(button.parentElement.style, { left: `${this.across.left}px`, width: `${this.across.width}px`, top: dir === 'up' ? '0px' : '', bottom: dir === 'down' ? '0px' : '' })
      }
    })
  }
  go(row) {
    row.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
    row.animate([{ outline: '3px solid var(--urg-high)', outlineOffset: '3px' }, { outline: '3px solid transparent', outlineOffset: '3px' }], { duration: 1600 })
  }
  toNew() { const row = [...this.unseen].map(id => document.getElementById(id)).find(r => r && !this.shown.has(r)); if (row) this.go(row) }
  toKnock({ currentTarget }) { const list = this.beyond?.[currentTarget.dataset.dir] ?? []; const row = currentTarget.dataset.dir === 'up' ? list.at(-1) : list[0]; if (row) this.go(row) }
}
