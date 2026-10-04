// The Desk's list (server/views/desk.mjs). "New questions must not move my window": a card that arrives out of
// sight is said quietly ("1 new ↓", a tap goes there), and a knock that is out of sight has one strip at the edge
// of the list it lies beyond ("↓ 1 knock"), which leads to the nearest one.
import { Controller } from '/js/app/stimulus.mjs'

const knocks = n => (n === 1 ? '1 knock' : `${n} knocks`)
export default class extends Controller {
  static targets = ['list', 'news', 'up', 'down']
  connect() { this.unseen = new Set(); this.look() }

  // A stream is about to put a row in: remember it if it will stand out of sight.
  changing(event) {
    const el = event.target
    if (el.action !== 'before' || el.target !== 'desk-stacks') return
    const id = el.templateContent?.querySelector('.inbox-row')?.id
    if (id) requestAnimationFrame(() => { const row = document.getElementById(id); if (row && !this.seen(row)) this.unseen.add(id); this.look() })
  }
  seen(row) { const r = row.getBoundingClientRect(); return r.height > 0 && r.top < innerHeight - 24 && r.bottom > 24 }
  look() {
    for (const id of this.unseen) { const row = document.getElementById(id); if (!row || this.seen(row)) this.unseen.delete(id) }
    const n = this.unseen.size
    this.newsTarget.hidden = !n
    if (n) { this.newsTarget.textContent = `${n} new ↓`; this.newsTarget.setAttribute('aria-label', `${n} new below: go there`) }
    const across = this.listTarget.getBoundingClientRect()
    for (const [dir, button] of [['up', this.upTarget], ['down', this.downTarget]]) {
      const beyond = this.beyond(dir).length
      button.hidden = !beyond
      if (!beyond) continue
      button.querySelector('span').textContent = knocks(beyond)
      button.setAttribute('aria-label', `${knocks(beyond)} ${dir === 'up' ? 'above' : 'below'}: go there`)
      Object.assign(button.parentElement.style, { left: `${across.left}px`, width: `${across.width}px`, top: dir === 'up' ? '0px' : '', bottom: dir === 'down' ? '0px' : '' })
    }
  }
  beyond(dir) {
    return [...this.listTarget.querySelectorAll('.inbox-row[data-knock]')].filter(row => { const r = row.getBoundingClientRect(); return r.height > 0 && (dir === 'up' ? r.bottom <= 24 : r.top >= innerHeight - 24) })
  }
  go(row) {
    row.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
    row.animate([{ outline: '3px solid var(--urg-high)', outlineOffset: '3px' }, { outline: '3px solid transparent', outlineOffset: '3px' }], { duration: 1600 })
  }
  toNew() { const row = [...this.unseen].map(id => document.getElementById(id)).find(Boolean); if (row) this.go(row) }
  toKnock({ currentTarget }) { const list = this.beyond(currentTarget.dataset.dir); const row = currentTarget.dataset.dir === 'up' ? list.at(-1) : list[0]; if (row) this.go(row) }
}
