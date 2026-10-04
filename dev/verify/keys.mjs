#!/usr/bin/env node
// The short keys, checked the same way on a target (the Turbo board, the new app): load a state, press the keys
// with real key events, then ask the page whether the effect is there. Both targets share the markup, so one
// expectation serves both. Prints a table and writes --out JSON.
//   node dev/verify/keys.mjs --target turbo|app [--base URL] [--verify-dir DIR] [--out FILE]
// Only keys that leave the board as it is (no answers). Needs the command sandbox disabled.
import fs from 'node:fs'
import path from 'node:path'
import { arg, loadTarget, openPage, sleep } from './lib.mjs'

const target = await loadTarget(arg('target', 'turbo'))
const verifyDir = path.resolve(arg('verify-dir', process.env.VERIFY_DIR ?? '.'))
const ctx = await target.connect({ verifyDir, base: arg('base') ?? undefined })
const DESK = '/?desk=main', ROW = '#desk-list .inbox-row'
const view = v => `document.body.dataset.tView === '${v}'`
const CASES = [
  { id: 'help', at: DESK, ready: ROW, keys: ['?'], expect: `!!document.querySelector('#keys-sheet[open], dialog[open].keys-sheet, .keys-sheet:not([hidden])')` },
  { id: 'list.next', at: DESK, ready: ROW, keys: ['j'], expect: `!!document.querySelector('#desk-list .inbox-row.is-current, #desk-list .inbox-row[aria-current]')` },
  { id: 'list.prev', at: DESK, ready: ROW, keys: ['j', 'j', 'k'], expect: `document.querySelector('#desk-list .inbox-row.is-current, #desk-list .inbox-row[aria-current]') === document.querySelectorAll('#desk-list .inbox-row')[0]` },
  { id: 'list.open (Enter)', at: DESK, ready: ROW, keys: ['j', 'Enter'], expect: view('card') },
  { id: 'list.open (c)', at: DESK, ready: ROW, keys: ['j', 'c'], expect: view('card') },
  { id: 'list.leave (Esc)', at: DESK, ready: ROW, keys: ['j', 'Escape'], expect: `!document.querySelector('#desk-list .inbox-row.is-current')` },
  { id: 'go.agents (g a)', at: DESK, ready: ROW, keys: ['g', 'a'], expect: view('agents') },
  { id: 'go.walk (g f)', at: DESK, ready: ROW, keys: ['g', 'f'], expect: `/walk=1/.test(location.search) && document.body.dataset.tView === 'card'` },
  { id: 'go.jump (g j)', at: DESK, ready: ROW, keys: ['g', 'j'], expect: `!!document.querySelector('#brand-doors:not([hidden])') && document.activeElement?.id === 'jump-field'` },
  { id: 'go.jump (Ctrl+K)', at: DESK, ready: ROW, keys: [['k', { ctrl: true }]], expect: `document.activeElement?.id === 'jump-field'` },
  { id: 'go.desk (g i)', at: '/agents', ready: 'body[data-t-view="agents"]', keys: ['g', 'i'], expect: view('desk') },
  { id: 'go.session (g 1)', at: DESK, ready: ROW, keys: ['g', '1'], expect: view('session') },
  { id: 'session.next (.)', at: DESK, ready: ROW, keys: ['.'], expect: view('session') },
  { id: 'rail ([)', at: DESK, ready: ROW, keys: ['['], expect: `document.documentElement.dataset.rail === 'folded' || document.documentElement.classList.contains('rail')` },
  { id: 'theme (t)', at: DESK, ready: ROW, keys: ['t'], expect: `document.documentElement.dataset.theme === 'dark'` },
  { id: 'pen (p)', at: DESK, ready: ROW, keys: ['p'], expect: `!!document.querySelector('#deskpad-pen[aria-pressed="true"], [data-pen="on"], html[data-pen]')` },
  { id: 'pad.cards (w)', at: DESK, ready: ROW, keys: ['w'], expect: `!!document.querySelector('#inbox[data-cards-hidden], [data-cards-hidden]')` },
  { id: 'memo.new (n)', at: DESK, ready: ROW, keys: ['n'], expect: `!!document.activeElement?.closest?.('.memo')` },
  { id: 'card.revise (b)', at: c => `/q/${c.nr.yesno}`, ready: '.tc-card', keys: ['b'], expect: `!!document.querySelector('details.tc-revise[open]')` },
  { id: 'card.write (a)', at: c => `/q/${c.nr.yesno}`, ready: '.tc-card', keys: ['a'], expect: `!!document.activeElement && ['TEXTAREA', 'INPUT'].includes(document.activeElement.tagName)` },
  { id: 'card.next (j)', at: c => `/q/${c.nr.yesno}`, ready: '.tc-card', keys: ['j'], expect: `${view('card')} && !location.pathname.endsWith('/q/' + __start)`, start: c => c.nr.yesno },
  { id: 'card.pic.next (Shift+→)', at: c => `/q/${c.nr.pictures}`, ready: '.tc-card', keys: [['ArrowRight', { shift: true }]], expect: `/pic=2|2 \\/ 3/.test(location.search + document.body.textContent)` },
  { id: 'card.leave (Esc)', at: c => `/q/${c.nr.yesno}`, ready: '.tc-card', keys: ['Escape'], expect: `!(${view('card')})` },
  { id: 'pic.next (→)', at: c => `/q/${c.nr.pictures}/p/1`, ready: 'body[data-t-view="picture"]', keys: ['ArrowRight'], expect: `/\\/p\\/2$/.test(location.pathname)` },
  { id: 'pic.leave (Esc)', at: c => `/q/${c.nr.pictures}/p/1`, ready: 'body[data-t-view="picture"]', keys: ['Escape'], expect: view('card') },
  { id: 'ledger.next (j)', at: '/agents', ready: 'body[data-t-view="agents"]', keys: ['j'], expect: `!!document.querySelector('.ledger-line.is-current, .ledger-line[aria-current], .ledger-line.is-marked')` },
]
const out = []
const h = await openPage({ profile: 'desktop-light', base: ctx.base, hostRules: arg('hosts') ?? '', userDataDir: ctx.userDataDir ?? null })
try {
  await target.prepare(h, ctx, { dark: false })
  for (const c of CASES) {
    if (target.reset) await target.reset(h, ctx, { dark: false })
    const at = typeof c.at === 'function' ? c.at(ctx) : c.at
    let ok = false, note = ''
    try {
      if (!await h.go(at, c.ready)) throw new Error('state not reached')
      await h.settle(); await sleep(300)
      await h.ev(`window.__start = ${JSON.stringify(String(c.start ? c.start(ctx) : ''))}; document.activeElement?.blur?.(); return 1`)
      for (const k of c.keys) { if (Array.isArray(k)) await h.key(k[0], k[1]); else await h.key(k); await sleep(150) }
      ok = Boolean(await h.waitFor(`return Boolean(${c.expect})`, 3000))
    } catch (err) { note = err.message }
    out.push({ id: c.id, ok, note })
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.id}${note ? ` (${note})` : ''}`)
  }
} finally { await h.close() }
fs.writeFileSync(path.resolve(arg('out', `keys-${target.name}.json`)), JSON.stringify(out, null, 1))
console.log(`${out.filter(x => x.ok).length}/${out.length} keys work on ${target.name}`)
process.exit(0)
