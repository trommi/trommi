// The start of the server-rendered board's front end (docs/turbo.md): Hotwire, whole and without a build step.
// Turbo carries the pages (Drive, Frames, Streams); Stimulus attaches behaviour to the HTML the hub rendered.
// Both are single vendored files, named by the import map in the layout (server/views/layout.mjs).
//
// Controllers load LAZILY: an element with data-controller="name" makes this file fetch
// /t/controllers/<name>_controller.js once (a dash in the name is an underscore in the file name) and register
// its default export. Nothing is listed here per controller. The few controllers every page has are registered
// below at once, so they cost no request of their own.
//
// Nothing here draws a page: the pages come complete from the hub, and the live stream
// (<turbo-stream-source id="live">) changes them. This module runs once and holds across Turbo's page changes.
import '@hotwired/turbo'
import { Application, Controller } from '@hotwired/stimulus'

const application = Application.start()
window.Stimulus = application

const $ = (sel, root = document) => root.querySelector(sel)
const base = () => document.body.dataset.tBase ?? ''
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
// The toasts' place is kept across Turbo's page changes (data-turbo-permanent in the layout), so that a toast stays
// while its Undo still counts; a toast the new page brings (?said=…) joins them.
document.addEventListener('turbo:before-render', e => {
  const here = document.getElementById('says-host'), there = e.detail.newBody?.querySelector('#says-host')
  if (here && there && here !== there) here.prepend(...[...there.children].filter(n => !n.hasAttribute('data-born')))
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

// ---- lazy controllers, and islands (the older form: data-island="name" -> /t/islands/<name>.js, mount(element)) ----
const asked = new Set(), mounted = new WeakSet()
function controller(name) {
  if (!name || asked.has(name) || application.router.modulesByIdentifier.has(name)) return
  asked.add(name)
  import(`/t/controllers/${name.replace(/-/g, '_')}_controller.js`).then(m => application.register(name, m.default)).catch(err => console.error(`controller ${name}:`, err))
}
function island(node) {
  if (mounted.has(node) || node.hasAttribute('data-controller')) return   // (an element that has a controller needs no island)
  mounted.add(node)
  const name = node.dataset.island
  if (name === 'says') { node.dataset.action = 'pointerenter->says#pause pointerleave->says#run'; node.dataset.controller = 'says'; return }
  import(`/t/islands/${name}.js`).then(m => m.mount(node)).catch(err => console.error(`island ${name}:`, err))
}
function look(root) {
  if (!(root instanceof Element)) return
  for (const node of [root, ...root.querySelectorAll('[data-controller], [data-island]')]) {
    for (const name of (node.getAttribute('data-controller') ?? '').split(/\s+/)) controller(name)
    if (node.hasAttribute('data-island')) island(node)
  }
}
new MutationObserver(records => {
  for (const r of records) { if (r.type === 'attributes') look(r.target); else for (const node of r.addedNodes) look(node) }
}).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-controller', 'data-island'] })
look(document.documentElement)

// ---- links to pages the old client still has: the browser loads them whole ----
// (The hub says which paths it renders, in <meta name="t-pages">: a pattern over the path without the base.)
let ported = null
const isPorted = path => {
  const said = $('meta[name="t-pages"]')?.content
  if (said == null) return false
  if (!ported || ported.source !== said) { try { ported = new RegExp(said) } catch { return false } }
  return ported.test(path)
}
document.addEventListener('turbo:click', e => {
  const path = new URL(e.detail.url, location.href).pathname
  const rest = base() ? (path === base() || path.startsWith(`${base()}/`) ? path.slice(base().length) || '/' : null) : path
  if (rest == null || !isPorted(rest)) e.preventDefault()
})

// ---- times keep themselves current ----
function ago(ts) {
  const min = Math.round((Date.now() - ts) / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  if (min < 1440) return `${Math.round(min / 60)} h ago`
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}
setInterval(() => { for (const n of document.querySelectorAll('[data-ts]')) n.textContent = ago(Number(n.dataset.ts)) }, 30000)

// ---- a row that leaves goes with one calm motion; then the list closes up ----
document.addEventListener('turbo:before-stream-render', e => {
  const render = e.detail.render
  e.detail.render = async el => {
    const row = el.action === 'remove' ? document.getElementById(el.target) : null
    if (row?.matches('.inbox-row') && !calm()) {
      row.inert = true
      await row.animate([{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: '24px 0' }], { duration: 160, easing: 'ease-in' }).finished.catch(() => {})
    }
    await render(el)
    // (A row that is still there after its "remove", e.g. one taken back meanwhile, is live again: worker D)
    if (row?.isConnected && row.inert) row.inert = false
  }
})
// A tile that was tapped shows it until the hub has answered.
document.addEventListener('turbo:submit-start', e => { e.detail.formSubmission.submitter?.classList.add('is-picked') })
document.addEventListener('turbo:submit-end', e => { e.detail.formSubmission.submitter?.classList.remove('is-picked') })

// ---- the connection, said in the menu ----
document.addEventListener('turbo:load', () => {
  const source = $('#live')?.streamSource
  if (!source || source.watched) return
  source.watched = true
  const say = (state, words) => { const c = $('#conn'), t = $('#conn-text'); if (c) c.dataset.state = state; if (t) t.textContent = words }
  if (source.readyState === 1) say('online', 'Connected')
  source.addEventListener('open', () => say('online', 'Connected'))
  source.addEventListener('error', () => say('offline', 'No connection'))
})

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
