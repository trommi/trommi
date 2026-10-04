// Target adapter: today's Turbo board (server/server.mjs + server/turbo.mjs), started by dev/verify/turbo-board.mjs.
// connect() reads <verify dir>/turbo-board.json (base, login cookie) and finds the card numbers of the fixtures.
// Each state: path(ctx) to load, ready (a selector that says the content is there), optional act(h, ctx) after load.
// A state that changes the board (answers a card) has mutates: true and runs last.
import fs from 'node:fs'
import path from 'node:path'
import { FIXTURES } from '../../../server/fixtures.mjs'
import { linkSession, startTurboBoard } from '../turbo-board.mjs'

const CARD = '.tc-card'
const DESK = '#desk-list .inbox-row'
const card = (kind, extra = {}) => ({ path: c => `/q/${c.nr[kind]}`, ready: CARD, ...extra })

export default {
  name: 'turbo',
  /** start: run the board in this process (port 8912, VERIFY_SHOOT_PORT) instead of reading a running one; refresh() then gives a fresh board. */
  async connect({ verifyDir, base: given, start = false }) {
    let info, board = null
    if (start) {
      board = await startTurboBoard({ port: Number(process.env.VERIFY_SHOOT_PORT || 8912), data: path.join(verifyDir, 'turbo-data-shoot') })
      info = { base: board.base, cookie: `board=${board.token}`, cards: board.cards }
    } else info = JSON.parse(fs.readFileSync(path.join(verifyDir, 'turbo-board.json'), 'utf8'))
    const base = given ?? info.base
    const [name, value] = info.cookie.split('=')
    const kinds = FIXTURES.filter(f => f.tool !== 'reply').map(f => f.kind)
    const nr = Object.fromEntries(kinds.map((k, i) => [k, info.cards[i]]))
    const get = async p => (await fetch(base + p, { headers: { Cookie: info.cookie } })).text()
    nr.permission = Number(/href="\/q\/(\d+)"/.exec(await get('/jump?q=Approval'))?.[1]) || null
    const desk = await get('/')
    const testDesk = [...desk.matchAll(/<a[^>]*href="\/\?desk=([\w-]+)"[^>]*>([\s\S]*?)<\/a>/g)].find(m => /Test/.test(m[2].replace(/<[^>]+>/g, '')))?.[1] ?? null
    return { base, token: value, nr, testDesk, cookies: [{ name, value, url: base }], board, verifyDir, start }
  },
  /** A fresh board for a state that changes it (only when this process started the board). Returns the new ctx. */
  async refresh(ctx) {
    if (!ctx.board) return ctx
    await ctx.board.stop()
    return this.connect({ verifyDir: ctx.verifyDir, start: true })
  },
  async close(ctx) { await ctx.board?.stop() },
  /** Before the first page: login cookie; the theme as the board keeps it (localStorage agent-board-theme). */
  async prepare(h, ctx, { dark }) {
    for (const c of ctx.cookies) await h.page.send('Network.setCookie', c)
    await h.page.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('agent-board-theme', ${JSON.stringify(dark ? 'dark' : 'light')}) } catch {}` })
  },
  /** Before each state: forget what the page kept in localStorage (folded rail, drafts of the look); the cookie stays. */
  async reset(h, ctx) {
    await h.page.send('Storage.clearDataForOrigin', { origin: new URL(ctx.base).origin, storageTypes: 'local_storage,session_storage' }).catch(() => {})
  },
  perf: {
    desk: { path: '/?desk=main', ready: DESK },
    nav: [
      { name: 'desk→session', click: '.sidebar a[href="/s/web-frontend"], a[href="/s/web-frontend"]', ready: 'body[data-t-view="session"] .msg' },
      { name: 'session→card', click: 'a[href="/s/web-frontend/q/2"]', ready: 'body[data-t-view="card"] .tc-card' },
      { name: 'card→back', click: '.tc-back', ready: 'body:not([data-t-view="card"]) main' },
    ],
    /** A session of its own ("Pulse") that writes into its conversation and puts cards on the Desk. */
    async live(ctx) {
      const pulse = linkSession({ base: ctx.base, token: ctx.token, name: 'Pulse' })
      await pulse.tool('reply', { text: 'Pulse misst die Live-Latenz.' })
      const made = []
      return [
        { name: 'reply→session page', path: '/s/pulse', ready: 'body[data-t-view="session"] .msg', send: nonce => pulse.tool('reply', { text: `Messpunkt ${nonce}` }) },
        { name: 'decision→desk', path: '/?desk=main', ready: DESK, send: async nonce => { const said = await pulse.tool('create_decision', { title: `Karte ${nonce}`, body: 'Latenzmessung', options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] }); const id = /card (\w+) created/.exec(said)?.[1]; if (id) made.push(id) },
          cleanup: async () => { for (const id of made) await pulse.tool('withdraw_card', { id, reason: 'Messung vorbei' }).catch(() => {}); pulse.close() } },
      ]
    },
  },
  states: {
    'desk': { path: () => '/?desk=main', ready: DESK },
    'desk-test': { path: c => `/?desk=${c.testDesk}`, ready: DESK },
    // ?desk= redirects to / and drops other parameters: pick the desk first (a cookie), then open the pile.
    'desk-pile-later': { path: c => `/?desk=${c.testDesk}`, ready: DESK, act: async h => { await h.go('/?pile=later', '[data-pile="later"].is-open'); await h.settle(); await h.ev(`document.querySelector('[data-pile="later"].is-open')?.scrollIntoView({ block: 'start' }); return 1`); await h.sleep(500) } },
    'desk-pile-done': { path: c => `/?desk=${c.testDesk}`, ready: DESK, act: async h => { await h.go('/?pile=done', '[data-pile="done"].is-open'); await h.settle(); await h.ev(`document.querySelector('[data-pile="done"].is-open')?.scrollIntoView({ block: 'start' }); return 1`); await h.sleep(500) } },
    'desk-scrolled-knocks': { path: () => '/?desk=main', ready: DESK, act: async h => { await h.ev(`(document.querySelector('#desk-stacks') ?? document.body.lastElementChild).scrollIntoView({ block: 'end' }); return 1`); await h.sleep(600) } },
    'menu': { path: () => '/?desk=main', ready: DESK, act: async h => { await h.click('#brand-menu'); await h.waitSel('#brand-doors:not([hidden])', 3000) } },
    'keys-sheet': { path: () => '/?desk=main', ready: DESK, act: async h => { await h.key('?'); await h.sleep(500) } },
    'jump': { path: () => '/?desk=main', ready: DESK, act: async h => { await h.click('#brand-menu'); await h.click('#jump-field'); await h.type('Migration'); await h.sleep(1200) } },
    'pad': { path: () => '/?desk=main', ready: DESK, act: async h => { await h.key('p'); await h.sleep(1200) } },
    'pad-cards-hidden': { path: () => '/?desk=main', ready: DESK, act: async h => { await h.key('w'); await h.sleep(1000) } },
    'memo-new': { mutates: true, path: () => '/?desk=main', ready: DESK, act: async h => { await h.click('#memo-open'); await h.sleep(600); if (await h.ev(`return !!document.querySelector('#memo-away:not([hidden]) .memo-away-new')`)) await h.click('#memo-away .memo-away-new'); await h.sleep(1200) } },
    'rail': { path: () => '/?desk=main', ready: DESK, act: async h => { await h.key('['); await h.sleep(700) } },
    'session': { path: () => '/s/web-frontend', ready: 'body[data-t-view="session"]' },
    'session-permission': { path: () => '/s/courier', ready: 'body[data-t-view="session"]' },
    'session-questions': { path: () => '/s/test-alpha?only=questions', ready: 'body[data-t-view="session"]' },
    'session-files': { path: () => '/s/test-beta/files', ready: 'body[data-t-view]' },
    'session-thread': { path: () => '/s/test-beta', ready: 'body[data-t-view="session"]' },
    'card-pictures': card('pictures'),
    'card-yesno': card('yesno'),
    'card-long': card('long'),
    'card-multiple': card('multiple'),
    'card-sections': card('sections'),
    'card-urgent': card('urgent'),
    'card-high': card('high'),
    'card-revised': card('revised'),
    'card-marks': card('marks'),
    'card-snoozed': card('snoozed'),
    'card-answered': card('answered'),
    'card-info': card('info'),
    'card-code': card('code'),
    'card-thread': card('thread'),
    'card-handback': card('handback'),
    'card-artifact': card('artifact'),
    'card-files': card('files'),
    'card-permission': { path: c => `/q/${c.nr.permission}`, ready: CARD },
    'card-more-menu': card('yesno', { act: async h => { await h.click('.tc-more-open').catch(() => {}); await h.sleep(500) } }),
    'picture': { path: c => `/q/${c.nr.pictures}/p/1`, ready: 'body[data-t-view="picture"]' },
    'walk': { path: () => '/walk', ready: 'body[data-t-view]' },
    'agents': { path: () => '/agents', ready: 'body[data-t-view="agents"]' },
    'help': { path: () => '/help.html', ready: 'body' },
    'card-what-sent': card('multiple', { mutates: true, act: async h => { await h.click('.tc-wtf').catch(() => {}); await h.sleep(1200) } }),
    'toast-after-answer': card('yesno', { mutates: true, act: async h => { await h.click('.tc-opt.is-advised, .tc-opt'); await h.sleep(1000) } }),
  },
}
