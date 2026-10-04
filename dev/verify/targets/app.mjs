// Target adapter: the new app (trommi/trommi, app.trommi.com; dev server http://127.0.0.1:8900).
// The app renders the board's own view modules in the page, so addresses and selectors are the Turbo board's; this
// adapter reuses the Turbo states and only finds its own card numbers, desks and sessions.
//   --base http://127.0.0.1:8900 (default) or https://app.trommi.com (with --hosts "MAP app.trommi.com <ip>")
//   VERIFY_APP_MODE=mock (default: the mock room ?mock=1, fixture of the same test cards) | room (a real E2E room:
//   the browser profile must already hold it; see dev/verify/README section "real room")
import { FIXTURES } from '../../../server/fixtures.mjs'
import turbo from './turbo.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { openPage } from '../lib.mjs'

const MODE = process.env.VERIFY_APP_MODE || 'mock'
const states = Object.fromEntries(Object.entries(turbo.states).map(([k, v]) => [k, { ...v }]))
// Content of the mock room: sessions trommi (crowned main), trommi-ui (the approval), test-alpha, test-beta.
states.session.path = c => `/s/${c.sessions.main}`
states['session-permission'].path = c => `/s/${c.sessions.permission}`
states['session-questions'].path = c => `/s/${c.sessions.alpha}?only=questions`
states['session-files'].path = c => `/s/${c.sessions.beta}/files`
states['session-thread'].path = c => `/s/${c.sessions.beta}`

export default {
  name: 'app',
  async connect({ base = 'http://127.0.0.1:8900', verifyDir }) {
    // room mode: the kept browser profile of dev/verify/app-room.mjs holds the room (IndexedDB, device keys)
    const room = MODE === 'room' ? JSON.parse(fs.readFileSync(path.join(verifyDir, 'app-room.json'), 'utf8')) : null
    const userDataDir = room?.userDataDir ?? null
    if (room) base = room.base
    const h = await openPage({ profile: { width: 1440, height: 900 }, base, hostRules: process.env.VERIFY_HOSTS ?? '', userDataDir })
    try {
      await h.go(MODE === 'mock' ? '/?mock=1' : '/', 'body[data-t-view]', 20000)
      await h.waitFor('return window.trommi?.board?.state?.cards?.length > 0', 20000)
      const found = await h.ev(`const s = trommi.board.state; return { cards: s.cards.map(c => ({ number: c.number, kind: c.kind, agent: c.agent, title: c.title })), desks: (s.desks ?? []).map(d => ({ id: d.id, name: d.name })) }`)
      const nr = {}
      for (const f of FIXTURES.filter(f => f.tool !== 'reply')) {
        const sid = f.who === 'alpha' ? 'test-alpha' : 'test-beta'
        nr[f.kind] = found.cards.find(c => c.title === f.args.title && c.agent === sid)?.number ?? found.cards.find(c => c.title === f.args.title)?.number ?? null
      }
      const perm = found.cards.find(c => c.kind === 'permission')
      nr.permission = perm?.number ?? null
      const testDesk = found.desks.find(d => /test/i.test(d.name))?.id ?? 'test'
      const alpha = found.cards.find(c => c.title === FIXTURES[0].args.title)?.agent
      const beta = found.cards.find(c => c.title === FIXTURES.find(f => f.kind === 'info').args.title)?.agent
      const sessions = room ? { main: alpha ?? 'test-alpha', permission: perm?.agent ?? 'courier' } : { main: found.cards.find(c => c.agent && !/^test-/.test(c.agent) && c.kind !== 'permission')?.agent ?? 'trommi', permission: perm?.agent ?? 'trommi-ui' }
      sessions.alpha = alpha ?? 'test-alpha'; sessions.beta = beta ?? 'test-beta'
      return { base, nr, testDesk, sessions, mode: MODE, userDataDir }
    } finally { await h.close() }
  },
  async prepare(h, ctx, { dark }) {
    await h.page.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('agent-board-theme', ${JSON.stringify(dark ? 'dark' : 'light')}); ${ctx.mode === 'mock' ? "sessionStorage.setItem('trommi-mock', '1')" : ''} } catch {}` })
  },
  async reset(h, ctx) {
    await h.page.send('Storage.clearDataForOrigin', { origin: new URL(ctx.base).origin, storageTypes: 'local_storage' }).catch(() => {})
  },
  // The mock room starts from its fixture on every full load, so a state that changes it needs no fresh board.
  states,
  perf: {
    desk: turbo.perf.desk,
    nav: [
      { name: 'desk→session', click: '#agents a[href^="/s/"], .agent-row a[href^="/s/"], a[href^="/s/"]', ready: 'body[data-t-view="session"] main' },
      { name: 'session→card', click: 'main a[href*="/q/"]', ready: 'body[data-t-view="card"] .tc-card' },
      { name: 'card→back', click: '.tc-back', ready: 'body:not([data-t-view="card"]) main' },
    ],
    async live() { return [] },   // live latency in the app is measured against a real room (dev/verify/rounds.mjs)
  },
}
