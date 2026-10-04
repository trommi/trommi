// The app's start: open the room from this device's storage (or the mock room with ?mock=1), paint the page in view
// from the local model at once, then start the core (sign in, catch up, live stream) and patch what changes.
// No room on this device: the room screens (found a room, join with a link). See README "Architecture".
import './turbo.mjs'
import './application.mjs'
import { BoardState } from './board-state.mjs'
import { hubFacade } from './hub-facade.mjs'
import { createBoard } from './board.mjs'
import { createRouter } from './router.mjs'
import { boardModel } from '../views/model.mjs'
import { roomPages, roomScreen, hubUrl } from './room.mjs'
import { attachTo } from './att.mjs'
import { startDeskWindow } from './desk-window.mjs'
import { CLIENT } from './version.mjs'
import { startPush } from './push.mjs'
import './pwa.mjs'

// The service worker: the app shell offline, attachments decrypted on demand, push (public/sw.js).
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(err => console.warn('service worker', err.message))

const T0 = performance.now()
const params = new URLSearchParams(location.search)
const read = (k, f = null) => { try { return localStorage.getItem(k) ?? f } catch { return f } }
const write = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v) } catch {} }

// Mock room: ?mock=1 (the fixture) or ?mock=crazy (a very big room); remembered for this tab; ?mock=0 ends it.
if (params.has('mock')) { if (params.get('mock') === '0') sessionStorage.removeItem('trommi-mock'); else sessionStorage.setItem('trommi-mock', params.get('mock') || '1') }
const mock = sessionStorage.getItem('trommi-mock')

async function openClient() {
  if (mock) return (await import('./mock-room.mjs')).openRoom({ mock })
  const core = await import('/vendor/index.mjs')
  return core.openRoom({ storage: core.idbStorage({ name: 'trommi', prefix: 'room/' }), client: CLIENT })
}

export async function start(client, { fresh = false } = {}) {
  attachTo(client)
  // The hub says this app is too old (426, or upgrade_required on the stream): a calm notice, reload takes the new build.
  client.on('error', err => { if (err?.code === 'client-too-old') notice('Please reload: this app needs a newer version.', err.message, true) })
  const board = new BoardState(client)
  board.update()
  let desk = read('trommi-desk')
  const hub = hubFacade(client, board)
  let cached = null
  const model = (d = desk) => {
    if (pending && !wasCatchingUp) { update(); frame ||= requestAnimationFrame(() => apply()) }
    if (cached?.version === board.version && cached.desk === d) return cached.m
    const m = boardModel(board.state, hub.agents(), d)
    board.desk = m.desk
    cached = { version: board.version, desk: d, m }
    return m
  }
  // The menu's "switch desk" (/?desk=<id>) and /desk/<id>: the desk is this browser's; the address is the Desk's again.
  const deskPages = t => {
    t.get(/^\/$/, ({ res, url }) => { const d = url.searchParams.get('desk'); if (d == null) return false; desk = d; write('trommi-desk', d); t.redirect(res, '/') })
    t.get(/^\/desk\/([\w-]+)$/, ({ res, match }) => { desk = match[1]; write('trommi-desk', desk); t.redirect(res, '/') })
    // The Scratchpad: the Desk with the pen in hand (t/lib/paper.js listens for trommi:pen).
    t.get(/^\/pad$/, ({ res }) => { document.addEventListener('turbo:load', () => { window.trommi.pen = true; document.dispatchEvent(new CustomEvent('trommi:pen')) }, { once: true }); t.redirect(res, '/') })
  }
  const b = createBoard({ hub, model, extraPages: [deskPages, roomPages(client)] })
  const router = createRouter({ board: b, flush: () => apply() })
  startDeskWindow(b)
  startPush(client)
  window.trommi = { client, board, router, model, mock: Boolean(mock) }

  // Changes come in batches; one frame patches the page for all that came meanwhile. A navigation or the end of a
  // form takes what is pending at once (flush), so a page never renders a state older than the action that led to it.
  let pending = null, frame = 0
  const merge = (a, c) => { for (const k of Object.keys(c)) { if (c[k] instanceof Set) for (const v of c[k]) a[k].add(v); else a[k] = a[k] || c[k] } return a }
  const conn = () => {
    const state = client.model.room.connection, el = document.getElementById('conn'), text = document.getElementById('conn-text')
    const words = { live: ['online', 'Connected'], catching_up: ['connecting', 'Catching up'], connecting: ['connecting', 'Connecting'], offline: ['offline', 'No connection'] }[state] ?? ['connecting', 'Connecting']
    if (el) el.dataset.state = words[0]
    if (text) text.textContent = words[1]
  }
  // update: the board state takes the pending change (at once, wherever the state is read: model() does it, so an
  // action's own answer never reads the state from before it). patch: the open page gets its streams; that waits for
  // the frame, so many changes cost one patch.
  let unpatched = false
  const update = () => {
    if (!pending) return
    const c = pending; pending = null
    const t = performance.now()
    board.update(c)
    unpatched = true
    window.trommi.lastUpdateMs = performance.now() - t
  }
  const apply = () => {
    cancelAnimationFrame(frame); frame = 0
    update()
    if (!unpatched) return
    unpatched = false
    const t = performance.now()
    router.changed()
    conn()
    window.trommi.lastPatchMs = performance.now() - t + (window.trommi.lastUpdateMs ?? 0)
  }
  // While the core catches up (a new device: thousands of envelopes in batches) the page is not patched per batch:
  // it is rendered whole every CATCH_UP_MS and once more when the room is live. Patching per batch made a big room's
  // first load quadratic (every batch re-diffed the Desk and re-measured its rows).
  const CATCH_UP_MS = 2500
  let catchUpTimer = 0, wasCatchingUp = false
  const catchingUp = () => client.model.room.connection === 'catching_up'
  const renderWhole = () => {
    catchUpTimer = 0
    cancelAnimationFrame(frame); frame = 0
    pending = null; unpatched = false
    board.update()
    router.refresh()
    conn()
  }
  client.on('change', change => {
    if (!pending) pending = merge({ cards: new Set(), sessions: new Set(), permissions: new Set(), memos: new Set(), published: new Set(), timelines: new Set(), registers: new Set(), invites: new Set() }, change)
    else merge(pending, change)
    if (catchingUp()) { if (!wasCatchingUp) { wasCatchingUp = true; conn() } catchUpTimer ||= setTimeout(renderWhole, CATCH_UP_MS); return }
    if (wasCatchingUp) { wasCatchingUp = false; clearTimeout(catchUpTimer); renderWhole(); return }
    frame ||= requestAnimationFrame(() => apply())
  })
  document.addEventListener('turbo:load', conn)
  // The timeline of the page in view is fetched when it is opened (newest page first; "Earlier" loads more).
  // The card page's thread is fetched when it is opened (newest page first; "Earlier comments" loads more). A session's
  // page loads its own (views/session.mjs, before its first render). The Desk's Working stack says each card's last
  // word: the newest few items of the cards with their session.
  const opened = new Set()
  const load = (key, limit) => { if (opened.has(key)) return; opened.add(key); client.loadTimeline(key, { limit }).catch(err => console.warn('timeline', err)) }
  document.addEventListener('turbo:load', () => {
    const path = location.pathname
    const q = /^\/(?:s\/[^/]+\/)?[qc]\/([\w-]+)/.exec(path)
    if (q) { const card = model().cardByRef(decodeURIComponent(q[1])); if (card) load(`chat:card/${card.id}`, 50) }
    if (path === '/') for (const c of model().revising ?? []) load(`chat:card/${c.id}`, 5)
  })

  await router.visit(location.pathname + location.search + location.hash, { action: 'replace' })
  window.trommi.firstPaintMs = performance.now() - T0
  window.trommi.openMs = typeof OPEN_MS === 'number' ? OPEN_MS : null
  window.trommi.readyAt = performance.now()   // since navigation start: cold or warm load to the painted page
  document.documentElement.dataset.ready = ''
  client.start().catch(err => {
    // One sealing client per device and room (a Web Lock): the room is open in another tab of this browser.
    if (err?.code === 'tab-conflict') notice('Trommi is open in another tab. Work there, or close it and reload here.', err.message, false)
    else console.error('start', err)
    conn()
  })
  if (fresh) router.refresh()
  return router
}

// A link for someone outside the room (/a/<share_id>#…): its own small page, no room needed.
const sharing = /^\/a\/[0-9a-f]{32}$/.test(location.pathname)
if (sharing) (await import('./share-view.mjs')).showShare()
const client = sharing ? null : await openClient().catch(err => { console.error('open', err); return null })
const OPEN_MS = performance.now() - T0   // the room from storage (or the mock's fixture) in memory
if (client) await start(client)
else if (!sharing) await roomScreen({ start, hub: hubUrl() })

/** A calm full-width line at the foot (styled by css/room.css), with "Reload". update: fetch the new build first. */
function notice(text, detail, update) {
  if (document.querySelector('.room-notice')) return
  const box = document.createElement('div')
  box.className = 'room-notice'
  box.setAttribute('role', 'status')
  const words = document.createElement('span')
  words.textContent = text
  if (detail) words.title = detail
  const go = document.createElement('button')
  go.type = 'button'
  go.className = 'room-notice-go'
  go.textContent = 'Reload'
  go.addEventListener('click', async () => {
    go.disabled = true
    if (update) { try { const reg = await navigator.serviceWorker?.getRegistration(); await reg?.update() } catch {} }
    location.reload()
  })
  box.append(words, go)
  document.body.append(box)
}
