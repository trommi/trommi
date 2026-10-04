// The Desk's list (views/desk.mjs). "New questions must not move my window": a card that arrives out of
// sight is said quietly ("1 new ↓", a tap goes there), and a knock that is out of sight has one strip at the edge
// of the list it lies beyond ("↓ 1 knock"), which leads to the nearest one.
// Where each knock (and each new row) stands is told by an IntersectionObserver, so scrolling costs nothing and no
// row is measured while a page is being built (a Desk of hundreds of rows on a slow phone).
import { Controller } from '/js/app/stimulus.mjs'

const knocks = n => (n === 1 ? '1 knock' : `${n} knocks`)
const EDGE = 24   // a row closer than this to the window's edge counts as out of sight
export default class extends Controller {
  static targets = ['list', 'news', 'up', 'down']
  connect() {
    this.unseen = new Set()   // ids of rows that arrived out of sight
    this.where = new Map()    // row -> 'in' | 'up' | 'down' | 'none'
    this.io = new IntersectionObserver(entries => {
      for (const e of entries) {
        const r = e.boundingClientRect
        const at = !r.height ? 'none' : e.isIntersecting ? 'in' : r.bottom <= EDGE ? 'up' : 'down'
        this.where.set(e.target, at)
        if (at === 'in') this.unseen.delete(e.target.id)
      }
      this.look()
    }, { rootMargin: `-${EDGE}px 0px` })
    // (A target is looked up on every read; these elements stay for the page's life: kept once.)
    this.list = this.listTarget; this.news = this.newsTarget; this.up = this.upTarget; this.down = this.downTarget
    this.mo = new MutationObserver(records => {
      for (const r of records) {
        for (const node of r.addedNodes) if (node.nodeType === 1) { if (node.matches('.inbox-row[data-knock]')) this.observe(node); else if (node.firstElementChild) for (const row of node.querySelectorAll('.inbox-row[data-knock]')) this.observe(row) }
        if (r.removedNodes.length) this.pruneSoon()
      }
      for (const id of this.unseen) { const row = document.getElementById(id); if (row) this.observe(row) }
    })
    this.mo.observe(this.list, { childList: true, subtree: true })
    // Where the list stands across, for the strips: read when its box changes (layout is fresh then), never per frame.
    this.ro = new ResizeObserver(() => { this.across = this.list.getBoundingClientRect(); this.look() })
    this.ro.observe(this.list)
    for (const row of this.list.querySelectorAll('.inbox-row[data-knock]')) this.observe(row)
  }
  disconnect() { this.io.disconnect(); this.mo.disconnect(); this.ro.disconnect(); cancelAnimationFrame(this.frame); clearTimeout(this.pruning) }
  observe(row) { if (!this.where.has(row)) { this.where.set(row, 'none'); this.io.observe(row) } }
  // Rows that left the page are forgotten a moment later (once per burst of changes).
  pruneSoon() {
    this.pruning ||= setTimeout(() => {
      this.pruning = 0
      for (const row of this.where.keys()) if (!row.isConnected) { this.io.unobserve(row); this.where.delete(row) }
      for (const id of this.unseen) if (!document.getElementById(id)) this.unseen.delete(id)
      this.look()
    }, 100)
  }

  // A stream is about to put a row in: it is "new" until it has been in sight.
  changing(event) {
    const el = event.target
    if (el.action !== 'before' || el.target !== 'desk-stacks') return
    const id = el.templateContent?.querySelector('.inbox-row')?.id
    if (id) this.unseen.add(id)   // (the observer says at once if it stands in sight, and takes it off)
  }
  // Draw the news line and the two strips, once per frame at most.
  look() {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      const n = [...this.unseen].filter(id => { const row = document.getElementById(id); const at = row && this.where.get(row); return at === 'up' || at === 'down' }).length
      this.news.hidden = !n
      if (n) { this.news.textContent = `${n} new ↓`; this.news.setAttribute('aria-label', `${n} new below: go there`) }
      const across = this.across
      for (const [dir, button] of [['up', this.up], ['down', this.down]]) {
        const beyond = this.beyond(dir).length
        button.hidden = !beyond
        if (!beyond) continue
        button.querySelector('span').textContent = knocks(beyond)
        button.setAttribute('aria-label', `${knocks(beyond)} ${dir === 'up' ? 'above' : 'below'}: go there`)
        if (across) Object.assign(button.parentElement.style, { left: `${across.left}px`, width: `${across.width}px`, top: dir === 'up' ? '0px' : '', bottom: dir === 'down' ? '0px' : '' })
      }
    })
  }
  /** The knock rows beyond one edge, in the list's order. */
  beyond(dir) { return [...this.where].filter(([row, at]) => at === dir && row.isConnected && row.hasAttribute('data-knock')).map(([row]) => row).sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)) }
  go(row) {
    row.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
    row.animate([{ outline: '3px solid var(--urg-high)', outlineOffset: '3px' }, { outline: '3px solid transparent', outlineOffset: '3px' }], { duration: 1600 })
  }
  toNew() { const row = [...this.unseen].map(id => document.getElementById(id)).find(r => r && ['up', 'down'].includes(this.where.get(r))); if (row) this.go(row) }
  toKnock({ currentTarget }) { const list = this.beyond(currentTarget.dataset.dir); const row = currentTarget.dataset.dir === 'up' ? list.at(-1) : list[0]; if (row) this.go(row) }
}
