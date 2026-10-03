// The one script of the server-rendered board (docs/turbo.md). It starts Turbo and carries the small
// behaviour that every page has; everything heavier is an island, loaded only where an element asks for it
// (data-island="name" -> /t/islands/<name>.js, export function mount(element)). Nothing here draws a page:
// the pages come complete from the hub, and the live stream (<turbo-stream-source id="live">) changes them.
// All listeners hang on the document, so they hold across Turbo's page changes; this module runs once.
import '/vendor/turbo.es2017-esm.js'

const $ = (sel, root = document) => root.querySelector(sel)
const base = () => document.body.dataset.tBase ?? ''
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback } }
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)) } catch {} }

// ---- links to pages the old client still has: the browser loads them whole ----
// (The hub says which paths it renders, in <meta name="t-pages">: a pattern over the path without the base.)
let ported = null
const isPorted = path => {
  const said = $('meta[name="t-pages"]')?.content
  if (said == null) return /^\/($|q\/[\w-]+(\/p\/\d+)?$|s\/[^/]+\/q\/[\w-]+$|walk$)/.test(path)
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

// ---- the sidebar: a main's subs fold away behind its crown; which are open is this browser's ----
const FOLD_KEY = 'trommi-crowns-open'
function applyFolds() {
  const open = new Set(read(FOLD_KEY, []))
  for (const main of document.querySelectorAll('.agent-row[data-fold]')) {
    const is = open.has(main.dataset.unit)
    main.dataset.fold = is ? 'open' : 'shut'
    main.querySelector('.crown-fold')?.setAttribute('aria-expanded', String(is))
    const edges = main.querySelector('.crown-edges')
    if (edges) edges.hidden = is
    for (const sub of document.querySelectorAll(`.agent-row[data-parent="${CSS.escape(main.dataset.unit)}"]`)) sub.hidden = !is
  }
}

// ---- the stacks at the foot of the Desk: a click fans one out, a click gathers it ----
let openPile = null
function applyPile() {
  for (const pile of document.querySelectorAll('.inbox-stacks .inbox-pile')) {
    const is = pile.dataset.pile === openPile || (openPile == null && pile.classList.contains('is-open') && pile.hasAttribute('data-wide'))
    pile.classList.toggle('is-open', is)
    pile.querySelector('.inbox-pile-head')?.setAttribute('aria-expanded', String(is))
  }
}

// ---- a title of two lines leaves room for one line of text below it (css: .inbox-row[data-tall]) ----
const fit = new ResizeObserver(entries => {
  for (const { target } of entries) {
    if (!target.clientHeight) continue
    target.closest('.inbox-row')?.toggleAttribute('data-tall', target.clientHeight > parseFloat(getComputedStyle(target).lineHeight) * 1.5)
  }
})

// ---- islands ----
const mounted = new WeakSet()
const BUILT_IN = {
  // The passing note at the top left: it goes by itself; while the pointer rests on it, it stays.
  says(node) {
    let left = 6000, since = Date.now(), timer = setTimeout(() => node.remove(), left)
    node.style.setProperty('--back-ms', `${left}ms`)
    node.addEventListener('pointerenter', () => { clearTimeout(timer); left -= Date.now() - since; node.dataset.paused = '' })
    node.addEventListener('pointerleave', () => { since = Date.now(); delete node.dataset.paused; timer = setTimeout(() => node.remove(), Math.max(left, 800)) })
  },
}
function mountAll(root = document) {
  for (const node of root.querySelectorAll('[data-island]')) {
    if (mounted.has(node)) continue
    mounted.add(node)
    const name = node.dataset.island
    if (BUILT_IN[name]) BUILT_IN[name](node)
    else import(`/t/islands/${name}.js`).then(m => m.mount(node)).catch(err => console.error(`island ${name}:`, err))
  }
  for (const title of root.querySelectorAll('.inbox-row .inbox-question')) fit.observe(title)
}

// ---- after the page stands, and after the stream changed it ----
function settle() { applyFolds(); applyPile(); mountAll(); grow() }
document.addEventListener('turbo:load', () => { openPile = $('.inbox-stacks .inbox-pile.is-open')?.dataset.pile ?? null; settle(); watchLive() })
document.addEventListener('turbo:before-stream-render', e => {
  const render = e.detail.render
  e.detail.render = async el => {
    // A row that leaves goes with one calm motion; then the list closes up.
    const row = el.action === 'remove' ? document.getElementById(el.target) : null
    if (row?.matches('.inbox-row') && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      row.inert = true
      await row.animate([{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: '24px 0' }], { duration: 160, easing: 'ease-in' }).finished.catch(() => {})
    }
    await render(el)
    settle()
  }
})

// ---- the connection, said in the menu ----
function watchLive() {
  const source = $('#live')?.streamSource, conn = $('#conn'), text = $('#conn-text')
  if (!source || !conn || source.watched) return
  source.watched = true
  const say = (state, words) => { const c = $('#conn'), t = $('#conn-text'); if (c) c.dataset.state = state; if (t) t.textContent = words }
  if (source.readyState === 1) say('online', 'Connected')
  source.addEventListener('open', () => say('online', 'Connected'))
  source.addEventListener('error', () => say('offline', 'No connection'))
  void conn; void text
}

// ---- clicks ----
document.addEventListener('click', e => {
  const t = e.target instanceof Element ? e.target : null
  if (!t) return
  const menu = t.closest('#brand-menu'), doors = $('#brand-doors')
  if (menu && doors) { doors.hidden = !doors.hidden; menu.setAttribute('aria-expanded', String(!doors.hidden)); return }
  if (doors && !doors.hidden && !t.closest('#brand-doors')) { doors.hidden = true; $('#brand-menu')?.setAttribute('aria-expanded', 'false') }
  if (t.closest('#theme-toggle')) {
    const dark = document.documentElement.dataset.theme !== 'dark'
    if (dark) document.documentElement.dataset.theme = 'dark'; else delete document.documentElement.dataset.theme
    try { localStorage.setItem('agent-board-theme', dark ? 'dark' : 'light') } catch {}
    return
  }
  const fold = t.closest('[data-fold-toggle]')
  if (fold) {
    const open = new Set(read(FOLD_KEY, [])), id = fold.dataset.foldToggle
    if (open.has(id)) open.delete(id); else open.add(id)
    write(FOLD_KEY, [...open])
    return applyFolds()
  }
  const head = t.closest('.inbox-stacks .inbox-pile-head')
  if (head) {
    const kind = head.closest('.inbox-pile').dataset.pile
    for (const p of document.querySelectorAll('.inbox-pile[data-wide]')) p.removeAttribute('data-wide')
    openPile = openPile === kind ? null : kind
    applyPile()
    if (openPile) head.closest('.inbox-pile').querySelector('.inbox-pile-sheets')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }
})
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { const doors = $('#brand-doors'); if (doors && !doors.hidden) { doors.hidden = true; $('#brand-menu')?.setAttribute('aria-expanded', 'false') } }
  // In the field under a card: Enter sends, Shift+Enter is a new line.
  const field = e.target instanceof Element && e.target.closest('.focus-ask-field')
  if (field && e.key === 'Enter' && !e.shiftKey && !e.isComposing && field.value.trim()) { e.preventDefault(); field.form.requestSubmit(field.form.querySelector('.focus-ask-send')) }
})
// The field grows with what is written in it.
function grow(field = $('.focus-ask-field')) { if (field) { field.style.height = 'auto'; field.style.height = `${Math.min(field.scrollHeight, 220)}px` } }
document.addEventListener('input', e => { if (e.target instanceof Element && e.target.matches('.focus-ask-field')) grow(e.target) })

// A tile that was tapped shows it until the hub has answered.
document.addEventListener('turbo:submit-start', e => { e.detail.formSubmission.submitter?.classList.add('is-picked') })
document.addEventListener('turbo:submit-end', e => { e.detail.formSubmission.submitter?.classList.remove('is-picked') })
