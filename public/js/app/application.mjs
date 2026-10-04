// Behaviour every page has: a port of trommi-hub client/web/t/application.js on the app's Stimulus stand-in
// (public/js/app/stimulus.mjs). Controllers load lazily from /t/controllers/<name>_controller.js; the few every page
// has are registered here. Turbo-specific parts are gone: the router renders the pages, the <turbo-stream> element
// animates a Desk row that leaves, boot.mjs says the connection.
import { Application, Controller } from './stimulus.mjs'
import { ago } from '../views/text.mjs'

const application = Application.start()
window.Stimulus = application

const $ = (sel, root = document) => root.querySelector(sel)
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback } }
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)) } catch {} }
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches

// ---- controllers every page has -----------------------------------------------------------------

// The toast at the top right (server/views/toast.mjs): it goes by itself; while the pointer rests on it, it stays.
// Several stack, the newest on top, three at most. Once its Undo is pressed it is gone (kept, hidden, until the form's
// answer is in: a form taken out of the page would lose its stream answer).
application.register('says', class extends Controller {
  static values = { ms: { type: Number, default: 5000 } }
  connect() {
    // (Moved along with its place to the next page, it goes on with the time it had left.)
    if (this.element.dataset.born) { this.left = Number(this.element.dataset.born) - Date.now(); if (this.left <= 0) return this.element.remove(); this.element.style.setProperty('--back-ms', `${this.left}ms`); return this.run() }
    this.element.dataset.born = Date.now() + this.msValue
    const host = this.element.parentElement
    if (host?.id === 'says-host') for (const old of [...host.children].filter(n => n.matches('.says:not([hidden])')).slice(3)) old.remove()
    // A toast that came with the page's address (?said=…) is not shown again by a refresh of that page.
    const url = new URL(location.href)
    if (url.searchParams.has('said')) { url.searchParams.delete('said'); history.replaceState(history.state, '', url) }
    this.left = this.msValue; this.element.style.setProperty('--back-ms', `${this.left}ms`); this.run()
  }
  disconnect() { clearTimeout(this.timer) }
  run() { if (this.element.hidden) return; this.since = Date.now(); this.element.dataset.born = this.since + this.left; delete this.element.dataset.paused; clearTimeout(this.timer); this.timer = setTimeout(() => this.element.remove(), Math.max(this.left, 800)) }
  pause() { clearTimeout(this.timer); this.left -= Date.now() - this.since; this.element.dataset.paused = '' }
  leave() { clearTimeout(this.timer); this.element.hidden = true }
  gone() { this.element.remove() }
})
// The sidebar: a main's subs fold away behind its crown. Which mains are open is this browser's own (localStorage);
// the hub renders them folded, and every row that arrives (also by a stream) is put the way this browser has it.
const FOLD_KEY = 'trommi-crowns-open'
// An unfolded main's subs are held together by a bracket drawn with the pen down their left side (card Nr. 160,
// "stack + bracket"); folded, the subs lie as card edges under the main and the bracket is gone.
const wob = (i, s) => (((Math.sin(i * 127.1 + 3.7) * 43758.5453) % 1 + 1) % 1 - .5) * 2 * s
function penLine(pts) {
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i], [nx, ny] = pts[i + 1]
    d += ` Q ${x.toFixed(1)} ${y.toFixed(1)} ${((x + nx) / 2).toFixed(1)} ${((y + ny) / 2).toFixed(1)}`
  }
  const last = pts.at(-1)
  return `${d} L ${last[0].toFixed(1)} ${last[1].toFixed(1)}`
}
application.register('folds', class extends Controller {
  static targets = ['row', 'bracket']
  connect() { this.draw = () => this.brackets(); addEventListener('resize', this.draw); requestAnimationFrame(this.draw) }
  disconnect() { removeEventListener('resize', this.draw) }
  rowTargetConnected(row) { this.apply(row); cancelAnimationFrame(this.frame); this.frame = requestAnimationFrame(() => this.brackets()) }
  brackets() {
    // Nothing unfolded: no bracket to draw, and no layout to force.
    if (!this.element.querySelector('.agent-row[data-fold="open"]')) { for (const svg of this.bracketTargets) svg.style.display = 'none'; return }
    const flat = getComputedStyle(this.element).flexDirection === 'row'   // a phone's strip runs sideways: the bracket runs under the subs
    this.bracketTargets.forEach((svg, gi) => {
      const main = svg.closest('.agent-row')
      const subs = this.rowTargets.filter(r => r.dataset.parent === main?.dataset.unit && !r.hidden)
      if (!main || main.dataset.fold !== 'open' || !subs.length) { svg.style.display = 'none'; return }
      svg.style.display = ''
      const G = main.getBoundingClientRect(), first = subs[0].getBoundingClientRect(), last = subs.at(-1).getBoundingClientRect()
      const w = i => wob(gi * 17 + i, 1.1)
      let pts
      if (flat) { const y = G.height + 3, x0 = first.left - G.left + 3, x1 = last.right - G.left - 3; pts = [[x0, y - 7], [x0 + w(1), y], [(x0 + x1) / 2, y - 1 + w(2)], [x1 + w(3), y], [x1, y - 7]] }
      else { const x = document.documentElement.dataset.rail === 'folded' ? 3 : 13, y0 = G.height - 10, y1 = last.bottom - G.top - 8; pts = [[x + 9, y0 - 6], [x, y0 + 4 + w(1)], [x + w(2), (y0 + y1) / 2], [x, y1 + w(3)], [x + 9, y1]] }
      for (const p of svg.querySelectorAll('path')) p.setAttribute('d', penLine(pts))
    })
  }
  toggle({ params: { id } }) {
    const open = new Set(read(FOLD_KEY, []))
    if (open.has(id)) open.delete(id); else open.add(id)
    write(FOLD_KEY, [...open])
    for (const row of this.rowTargets) this.apply(row)
    this.brackets()
  }
  apply(row) {
    const open = new Set(read(FOLD_KEY, []))
    if (row.dataset.parent) row.hidden = !open.has(row.dataset.parent)
    if (!row.hasAttribute('data-fold')) return
    const is = open.has(row.dataset.unit)
    row.dataset.fold = is ? 'open' : 'shut'
    row.querySelector('.crown-fold')?.setAttribute('aria-expanded', String(is))
    const edges = row.querySelector('.crown-edges')
    if (edges) edges.hidden = is
  }
})

// The stacks at the foot of the Desk: a click fans one out, a click gathers it. A stream may replace the stacks;
// the one that stood open stands open again.
let openPile
application.register('piles', class extends Controller {
  static targets = ['pile']
  connect() { if (openPile === undefined) openPile = this.pileTargets.find(p => p.classList.contains('is-open'))?.dataset.pile ?? null; this.apply() }
  toggle({ currentTarget }) {
    const pile = currentTarget.closest('[data-pile]')
    openPile = openPile === pile.dataset.pile ? null : pile.dataset.pile
    this.apply()
    if (openPile) pile.querySelector('.inbox-pile-sheets')?.scrollIntoView({ block: 'nearest', behavior: calm() ? 'instant' : 'smooth' })
  }
  // Escape inside the stacks (a tab or a line of the open list) closes the open one; the keyboard goes back to its tab.
  shut(event) {
    if (!openPile || event.defaultPrevented) return
    const head = this.pileTargets.find(p => p.dataset.pile === openPile)?.querySelector('.inbox-pile-head')
    openPile = null
    this.apply()
    event.preventDefault()
    event.stopPropagation()
    head?.focus({ preventScroll: true })
  }
  apply() {
    for (const pile of this.pileTargets) {
      const is = pile.dataset.pile === openPile
      pile.classList.toggle('is-open', is)
      pile.querySelector('.inbox-pile-head')?.setAttribute('aria-expanded', String(is))
    }
  }
})

// A row's title of two lines leaves room for one line of text below it (css: .inbox-row[data-tall]).
const fit = new ResizeObserver(entries => {
  for (const { target } of entries) {
    if (!target.clientHeight) continue
    target.closest('.inbox-row')?.toggleAttribute('data-tall', target.clientHeight > parseFloat(getComputedStyle(target).lineHeight) * 1.5)
  }
})
application.register('fit', class extends Controller {
  connect() { fit.observe(this.element) }
  disconnect() { fit.unobserve(this.element) }
})

// ---- lazy controllers ----
const asked = new Set()
application.missing = name => {
  if (!name || asked.has(name) || application.classes.has(name)) return
  asked.add(name)
  import(`/t/controllers/${name.replace(/-/g, '_')}_controller.js`).then(m => application.register(name, m.default)).catch(err => console.error(`controller ${name}:`, err))
}

// ---- times keep themselves current ----
setInterval(() => { for (const n of document.querySelectorAll('[data-ts]')) n.textContent = ago(Number(n.dataset.ts)) }, 30000)

// A tile that was tapped shows it until the hub has answered.
document.addEventListener('turbo:submit-start', e => { e.detail.formSubmission.submitter?.classList.add('is-picked') })
document.addEventListener('turbo:submit-end', e => { e.detail.formSubmission.submitter?.classList.remove('is-picked') })

// ---- the Trommi menu opens and closes; the theme (the menu's own behaviour is the island/controller "menu") ----
const shut = () => { const doors = $('#brand-doors'); if (doors && !doors.hidden) { doors.hidden = true; $('#brand-menu')?.setAttribute('aria-expanded', 'false') } }
document.addEventListener('click', e => {
  const t = e.target instanceof Element ? e.target : null
  if (!t) return
  const menu = t.closest('#brand-menu'), doors = $('#brand-doors')
  if (menu && doors) { doors.hidden = !doors.hidden; menu.setAttribute('aria-expanded', String(!doors.hidden)); return }
  if (doors && !doors.hidden && !t.closest('#brand-doors')) shut()
  if (t.closest('#theme-toggle')) {
    const dark = document.documentElement.dataset.theme !== 'dark'
    if (dark) document.documentElement.dataset.theme = 'dark'; else delete document.documentElement.dataset.theme
    try { localStorage.setItem('agent-board-theme', dark ? 'dark' : 'light') } catch {}
  }
})
document.addEventListener('keydown', e => { if (e.key === 'Escape') shut() })
