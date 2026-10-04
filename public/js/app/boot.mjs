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
  return core.openRoom({ storage: core.idbStorage({ name: 'trommi', prefix: 'room/' }) })
}

export async function start(client, { fresh = false } = {}) {
  attachTo(client)
  const board = new BoardState(client)
  board.update()
  let desk = read('trommi-desk')
  const hub = hubFacade(client, board)
  let cached = null
  const model = (d = desk) => {
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
  }
  const b = createBoard({ hub, model, extraPages: [deskPages, roomPages(client)] })
  const router = createRouter({ board: b })
  window.trommi = { client, board, router, model, mock: Boolean(mock) }

  // Changes come in batches; one frame patches the page for all that came meanwhile.
  let pending = null
  const merge = (a, c) => { for (const k of Object.keys(c)) { if (c[k] instanceof Set) for (const v of c[k]) a[k].add(v); else a[k] = a[k] || c[k] } return a }
  const conn = () => {
    const state = client.model.room.connection, el = document.getElementById('conn'), text = document.getElementById('conn-text')
    const words = { live: ['online', 'Connected'], catching_up: ['connecting', 'Catching up'], connecting: ['connecting', 'Connecting'], offline: ['offline', 'No connection'] }[state] ?? ['connecting', 'Connecting']
    if (el) el.dataset.state = words[0]
    if (text) text.textContent = words[1]
  }
  client.on('change', change => {
    if (!pending) {
      pending = merge({ cards: new Set(), sessions: new Set(), permissions: new Set(), memos: new Set(), published: new Set(), timelines: new Set(), registers: new Set(), invites: new Set() }, change)
      requestAnimationFrame(() => {
        const c = pending; pending = null
        const t = performance.now()
        board.update(c)
        router.changed()
        conn()
        window.trommi.lastPatchMs = performance.now() - t
      })
    } else merge(pending, change)
  })
  document.addEventListener('turbo:load', conn)
  // The timeline of the page in view is fetched when it is opened (newest page first; "Earlier" loads more).
  const opened = new Set()
  document.addEventListener('turbo:load', () => {
    const path = location.pathname
    let key = null
    const s = /^\/s\/([^/+]+)/.exec(path), q = /^\/(?:s\/[^/]+\/)?[qc]\/([\w-]+)/.exec(path)
    if (q) { const card = model().cardByRef(decodeURIComponent(q[1])); if (card) key = `chat:card/${card.id}` }
    else if (s) { const dev = board.agentToDev.get(decodeURIComponent(s[1])); if (dev) key = `chat:session/${dev}` }
    const before = new URLSearchParams(location.search).get('before')
    if (key && (!opened.has(key) || before)) { opened.add(key); client.loadTimeline(key, { limit: 50 }).catch(err => console.warn('timeline', err)) }
    // A session's page shows what was said about its questions too: the newest page of its recent cards' threads.
    if (s && !q) {
      const dev = board.agentToDev.get(decodeURIComponent(s[1])), sess = dev && client.model.sessions.get(dev)
      for (const id of (sess?.card_ids ?? []).slice(-20)) {
        const k = `chat:card/${id}`, t = client.model.timelines.get(k)
        if (!opened.has(k) && t?.item_count) { opened.add(k); client.loadTimeline(k, { limit: 50 }).catch(() => {}) }
      }
    }
  })
  await router.visit(location.pathname + location.search + location.hash, { action: 'replace' })
  window.trommi.firstPaintMs = performance.now() - T0
  document.documentElement.dataset.ready = ''
  client.start().catch(err => { console.error('start', err); conn() })
  if (fresh) router.refresh()
  return router
}

const client = await openClient().catch(err => { console.error('open', err); return null })
if (client) await start(client)
else await roomScreen({ start, hub: hubUrl() })
