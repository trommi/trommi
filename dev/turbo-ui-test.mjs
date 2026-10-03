#!/usr/bin/env node
// Browser tests for the server-rendered board (Hotwire Turbo, docs/turbo.md), at its main addresses.
//   node dev/turbo-ui-test.mjs                    every group at desktop size (1440x900), then at phone size (390x844)
//   node dev/turbo-ui-test.mjs --only desk,card   some groups (see GROUPS)
//   node dev/turbo-ui-test.mjs --size phone       one size (desktop | phone)
//   node dev/turbo-ui-test.mjs --shots DIR        where the screenshots of failing groups go (default <tmp>/trommi-turbo-ui-test)
//
// It starts its own hub (BOARD_HUB_ONLY, a throwaway data folder, a free port), links two sessions to it over
// the agent API ("Courier" files the cards a group needs, "Second" is a plain other session) and one scripted
// demo agent (dev/fake-agent.mjs web) with pictures, then drives ONE headless Chromium over the DevTools
// protocol with real mouse, touch and key events. Everything it started stops with it (dev/cdp.mjs guard()).
// A check for a known open defect is listed in PENDING with the owner who fixes it: it is reported as pending
// and does not fail the run; when it starts to pass, the run says so, and the entry should go.
// Exit code: 0 nothing failed, 1 failures, 2 the suite could not run. Needs the command sandbox disabled.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchChromium, guard } from './cdp.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null }
const only = (arg('only') ?? '').split(',').filter(Boolean)
const sizes = arg('size') ? [arg('size')] : ['desktop', 'phone']
const shotDir = path.resolve(arg('shots') ?? path.join(os.tmpdir(), 'trommi-turbo-ui-test'))
const SIZES = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } }

// ---- known open defects (found in the visual review of 3 October 2026) -------------------------------------
// match: against "<group>: <check message>". owner: who fixes it. Remove an entry when its check passes.
const PENDING = [
]

// ---- results ---------------------------------------------------------------------------------------------
const results = []
let current = null
class Failed extends Error {}
function check(ok, message) {
  const known = PENDING.find(p => p.match.test(`${current.name}: ${message}`))
  if (known) { if (ok) current.fixed.push(message); else current.pending.push(`${message} [${known.owner}: ${known.reason}]`) }
  else if (ok) current.passed++
  else current.failures.push(message)
  return Boolean(ok)
}
function need(ok, message) { if (!check(ok, message)) throw new Failed(message) }

// ---- processes -------------------------------------------------------------------------------------------
const children = []
const tempDirs = []
const alive = p => p.exitCode == null && p.signalCode == null
function start(name, args, env) {
  const proc = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  guard(proc, { group: true })
  const child = { proc, name, log: '' }
  proc.stderr.on('data', c => { child.log += c })
  proc.stdout.on('data', c => { child.log += c })
  children.push(child)
  return child
}
const links = []
let browser = null
let cleaned = false
async function cleanup() {
  if (cleaned) return
  cleaned = true
  for (const l of links) l.destroy()
  try { await browser?.close() } catch {}
  for (const { proc } of children) if (alive(proc)) { try { process.kill(-proc.pid, 'SIGTERM') } catch {} }
  for (let i = 0; i < 30 && children.some(c => alive(c.proc)); i++) await sleep(100)
  for (const { proc } of children) if (alive(proc)) { try { process.kill(-proc.pid, 'SIGKILL') } catch {} }
  for (const d of tempDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, async () => { await cleanup(); process.exit(130) })

async function freePort() {
  for (;;) {
    const port = await new Promise((resolve, reject) => {
      const s = net.createServer(); s.once('error', reject)
      s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
    })
    if (![8790, 8791, 8793, 8795].includes(port)) return port
  }
}

// ---- the hub and its sessions ----------------------------------------------------------------------------
let port = 0, token = '', base = '', dataDir = ''
async function startHub() {
  port = await freePort()
  token = crypto.randomBytes(12).toString('hex')
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trommi-turbo-ui-data-'))
  tempDirs.push(dataDir)
  base = `http://127.0.0.1:${port}`
  const env = { ...process.env, BOARD_PORT: String(port), BOARD_HOST: '127.0.0.1', BOARD_DATA: dataDir, BOARD_TOKEN: token, BOARD_HUB_ONLY: '1', BOARD_PASSKEYS: 'off', BOARD_PUSH: '0', BOARD_SNOOZE_TICK_MS: '1000' }
  delete env.BOARD_AGENT; delete env.BOARD_TURBO_BASE; delete env.TINFOIL_API_KEY
  const hub = start('hub', [path.join(ROOT, 'server', 'server.mjs')], env)
  for (let i = 0; i < 100; i++) {
    if (!alive(hub.proc)) throw new Error(`the hub stopped:\n${hub.log}`)
    if (await fetch(`${base}/`).then(r => r.status > 0, () => false)) break
    await sleep(100)
  }
  // One scripted demo agent with pictures: a spoke of this hub.
  const demo = { ...env }; delete demo.BOARD_HUB_ONLY
  const web = start('demo web', [path.join(ROOT, 'dev', 'fake-agent.mjs'), 'web'], demo)
  for (let i = 0; i < 300 && !web.log.includes('is up'); i++) { if (!alive(web.proc)) break; await sleep(100) }
  if (!web.log.includes('is up')) console.log(`note: the demo agent did not come up; the suite goes on without it\n${web.log.slice(-400)}`)
}

/** A session linked over the agent API, as dev/session.mjs does it. */
function session(name) {
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const instance = crypto.createHash('sha256').update(`${id}|${token}`).digest('hex').slice(0, 16)
  const query = new URLSearchParams({ name, id, instance, cwd: ROOT, host: 'test', platform: 'test' })
  const req = http.get({ host: '127.0.0.1', port, path: `/agent/link?${query}`, headers: { 'x-board-token': token } }, res => res.resume())
  req.on('error', () => {})
  links.push(req)
  const tool = async (tool, args = {}) => {
    for (let i = 0; i < 40; i++) {
      const res = await fetch(`${base}/agent/tool`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-board-token': token }, body: JSON.stringify({ id, instance, name: tool, args }) })
      const out = await res.json()
      if (res.ok) return out.text ?? ''
      if (!/not linked/.test(out.error ?? '')) throw new Error(`${name}: ${tool}: ${out.error}`)
      await sleep(100)
    }
    throw new Error(`${name} never got linked`)
  }
  let n = 0
  return {
    id, tool,
    /** File a decision; returns { id, nr }. */
    async ask(title, extra = {}) {
      const opts = extra.options ?? [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }]
      const said = await tool('create_decision', { title: `${title} ${++n}`, body: extra.body ?? 'A card of the browser test.', options: opts, ...extra, ...{ options: opts } })
      const m = /card (\w+) created as Nr\. (\d+)/.exec(said)
      if (!m) throw new Error(`no card in: ${said}`)
      return { id: m[1], nr: m[2], title: `${title} ${n}` }
    },
    async info(title, body = 'Something to read.') {
      const said = await tool('create_info', { title: `${title} ${++n}`, body })
      const m = /info (\w+) put on the board as Nr\. (\d+)/.exec(said)
      if (!m) throw new Error(`no info in: ${said}`)
      return { id: m[1], nr: m[2], title: `${title} ${n}` }
    },
  }
}
const pics = ['thema-hell.png', 'thema-dunkel.png'].map(f => path.join(ROOT, 'demo', f)).filter(f => fs.existsSync(f))

// ---- the browser -----------------------------------------------------------------------------------------
let page = null, size = 'desktop', problems = []
async function openBrowser() {
  browser = await launchChromium(SIZES.desktop)
  page = await browser.page()
  await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('Log.enable'); await page.send('Network.enable')
  const ignore = /manifest\.webmanifest|favicon/
  page.on('Runtime.exceptionThrown', p => { const d = p.exceptionDetails, f = d.stackTrace?.callFrames?.[0]; problems.push(`script error: ${(d.exception?.description ?? d.text).split('\n')[0]} at ${(f?.url ?? d.url ?? '').replace(base, '')}:${(f?.lineNumber ?? d.lineNumber ?? 0) + 1}`) })
  page.on('Runtime.consoleAPICalled', p => { if (p.type === 'error') problems.push(`console error: ${p.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 200)}`) })
  page.on('Log.entryAdded', p => { if (p.entry.level === 'error' && !ignore.test(`${p.entry.text} ${p.entry.url ?? ''}`)) problems.push(`browser: ${p.entry.text} ${(p.entry.url ?? '').replace(/t=\w+/, 't=…')}`.slice(0, 240)) })
  page.on('Network.requestWillBeSent', p => { if (p.type === 'Document' && p.frameId === mainFrame) documents++ })
  const tree = await page.send('Page.getFrameTree'); mainFrame = tree.frameTree.frame.id
}
let mainFrame = '', documents = 0
async function setSize(which) {
  size = which
  const { width, height } = SIZES[which], phone = which === 'phone'
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: phone })
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: phone, maxTouchPoints: phone ? 5 : 1 })
}
async function ev(expr) {
  const r = await page.send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(`in the page: ${(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).split('\n')[0]}`)
  return r.result?.value
}
const q = s => JSON.stringify(s)
const has = sel => ev(`return !!document.querySelector(${q(sel)})`)
const text = sel => ev(`return document.querySelector(${q(sel)})?.textContent.replace(/\\s+/g, ' ').trim() ?? null`)
const where = () => ev(`return location.pathname + location.search`)
async function waitFor(what, expr, ms = 6000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await ev(expr).catch(() => null)
    if (v) return v
    if (Date.now() > end) return null
    await sleep(60)
  }
}
const waitSel = (sel, ms) => waitFor(sel, `return !!document.querySelector(${q(sel)})`, ms)
const waitGone = (sel, ms) => waitFor(sel, `return !document.querySelector(${q(sel)})`, ms)
async function load(p, ready = 'body[data-t-view]') {
  await page.send('Page.navigate', { url: base + p })
  await waitSel(ready, 8000)
  await settle()
}
/** Wait until Turbo is idle: no progress bar, no pending frame. */
async function settle() { await waitFor('idle', `return !document.documentElement.hasAttribute('aria-busy') && document.readyState === 'complete'`, 6000); await sleep(150) }
/** Marks the window; after Drive visits the mark is still there, after a full load it is gone. */
const mark = () => ev(`window.__turboTest = 1; return true`)
const kept = () => ev(`return window.__turboTest === 1`)
async function box(sel) {
  // the first match that is drawn (a selector may name several places of one thing)
  return ev(`const e = [...document.querySelectorAll(${q(sel)})].find(x => { const r = x.getBoundingClientRect(); return r.width && r.height && getComputedStyle(x).visibility !== 'hidden' }); if (!e) return null; e.scrollIntoView({ block: 'center', inline: 'nearest' }); const r = e.getBoundingClientRect(); return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null`)
}
async function tapAt(x, y) {
  if (size === 'phone') {
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  } else {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
}
async function press(sel, what = sel) {
  const b = await box(sel)
  need(b, `there is something to press: ${what}`)
  await sleep(80)
  const b2 = await box(sel)
  await tapAt(b2.x, b2.y)
  await sleep(250)
  await settle()
}
async function hover(sel) { const b = await box(sel); if (b) await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y }); await sleep(150) }
async function hold(sel, ms = 700) {
  need(await box(sel), `there is something to hold: ${sel}`)
  await sleep(500)   // the sheet ignores a finger that comes right after a scroll (it stops the list)
  const b = await box(sel)
  await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x, y: b.y }] })
  await sleep(ms)
  await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(300)
}
async function keys(key, { ctrl = false } = {}) {
  const code = { Enter: 13, Escape: 27 }[key]
  const modifiers = ctrl ? 2 : 0
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code, modifiers, ...(key === 'Enter' && !ctrl ? { text: '\r' } : {}) })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code, modifiers })
}
const type = t => page.send('Input.insertText', { text: t })
async function shot(name) {
  fs.mkdirSync(shotDir, { recursive: true })
  const out = await page.send('Page.captureScreenshot', { format: 'png' })
  const file = path.join(shotDir, `${size}-${name}.png`)
  fs.writeFileSync(file, Buffer.from(out.data, 'base64'))
  return file
}
/** No element pokes out of the page sideways, the page does not scroll sideways. */
async function noSideScroll(where) {
  const w = await ev(`return document.documentElement.scrollWidth - innerWidth`)
  check(w <= 1, `${where}: the page does not scroll sideways (${w}px too wide)`)
}
async function rowCount() { return ev(`return document.querySelectorAll('#desk-list .inbox-row').length`) }

// ---- the groups ------------------------------------------------------------------------------------------
let courier, second

async function groupDesk() {
  const a = await courier.ask('Desk tile', {}), b = await courier.ask('Desk snooze', {}), c = await courier.ask('Desk choose', { options: [{ key: 'x', label: 'Ex' }, { key: 'y', label: 'Why' }, { key: 'z', label: 'Zed' }] })
  const i = await courier.info('Desk info')
  await load('/')
  check(await ev(`return document.body.dataset.tView === 'desk'`), 'the Desk is the page at /')
  need(await has(`#row-${a.id}`), 'a filed card stands as a row')
  const n = await rowCount()
  check(await ev(`return (document.querySelector('#desk-head .inbox-next-n')?.textContent.trim() ?? '') === String(${n})`), `the heading counts the ${n} rows`)
  check(await ev(`const r = document.querySelector('#row-${a.id}'); return !!r.querySelector('a.inbox-text[href="/q/${a.nr}"]')`), 'a row\'s title is a link to /q/<number>')
  check(await ev(`return [...document.querySelectorAll('#desk-list .inbox-row img')].every(i => i.loading === 'lazy' && i.getAttribute('width') && i.getAttribute('height'))`), 'the pictures in rows are lazy and sized')
  check(await ev(`return !!document.querySelector('#row-${c.id} a.inbox-answer[href="/q/${c.nr}"]')`), 'a card of three options has one "Choose" tile that links to its page')
  // "Next" is one plain sentence (no index-card tabs since 3 October): the count and the arrow, a link to the walk
  check(await ev(`const h = document.querySelector('#desk-head .inbox-next'); return !!(h && !document.querySelector('#desk-head .inbox-index-tab') && h.querySelector('a.inbox-walk[href="/walk"]'))`), 'the heading is a plain "Next N" sentence that leads to the walk')
  if (size === 'phone') check(await ev(`return [...document.querySelectorAll('#roster-open, a[href="/agents"]')].some(e => { const r = e.getBoundingClientRect(); return r.width && r.top < 60 })`), 'the phone top bar has the Agents button')
  await noSideScroll('Desk')

  // answer from a tile
  await mark()
  await press(`#row-${a.id} .inbox-answer.is-lead`, 'the Yes tile')
  check(await waitGone(`#row-${a.id}`), 'the answered row leaves the Desk')
  check(/Answered/.test(await waitFor('note', `return document.querySelector('#says-host')?.textContent`) ?? ''), 'the passing note says "Answered"')
  check(await where() === '/', 'the address stays /')
  check(await kept(), 'answering keeps the page alive (no full load)')
  await press('#says-host .says-back', 'Back in the passing note')
  check(await waitSel(`#row-${a.id}`), 'Back puts the row back')

  // snooze and wake (the row's tab on a desktop, the long-press sheet on a phone)
  if (size === 'phone') {
    await hold(`#row-${b.id} .inbox-text`)
    check(await ev(`return document.querySelector('#row-sheet')?.open === true`), 'a long press on a row opens its sheet')
    await press('#row-sheet-form button[formaction$="/snooze"], #row-sheet button[value="snooze"], #row-sheet .rowmenu-snooze, #row-sheet button[data-way="snooze"]', 'Snooze in the sheet').catch(() => {})
  } else {
    await hover(`#row-${b.id}`)
    await press(`#row-${b.id} .inbox-later`, 'the Snooze tab')
  }
  check(await waitGone(`#row-${b.id}`), 'a snoozed row leaves the list')
  check(await waitSel(`[data-pile="later"] [data-id="${b.id}"]`), 'a snoozed card lies on the Later stack')
  if (await has(`[data-pile="later"] [data-id="${b.id}"]`)) {
    if (!(await ev(`return document.querySelector('[data-pile="later"]').classList.contains('is-open')`))) await press('[data-pile="later"] .inbox-stack-head', 'the Later stack')
    await press(`[data-pile="later"] [data-id="${b.id}"] .inbox-takeback`, 'Wake up')
    check(await waitSel(`#row-${b.id}`), 'Wake up brings the row back')
  }

  // an info is acknowledged from its tile
  await press(`#row-${i.id} .inbox-answer.is-lead`, 'Acknowledge')
  check(await waitGone(`#row-${i.id}`), 'an acknowledged info leaves the Desk')

  // the decided card lies "in the works" and is taken back from there
  await press(`#row-${a.id} .inbox-answer:not(.is-lead)`, 'the No tile')
  await waitGone(`#row-${a.id}`)
  check(await waitSel(`[data-pile="works"] [data-id="${a.id}"], [data-pile="done"] [data-id="${a.id}"]`), 'a decided card lies on In the works (or Done)')
  const pile = await ev(`return document.querySelector('[data-id="${a.id}"]')?.closest('[data-pile]')?.dataset.pile`)
  if (pile) {
    if (!(await ev(`return document.querySelector('[data-pile="${pile}"]').classList.contains('is-open')`))) await press(`[data-pile="${pile}"] .inbox-stack-head`, `the ${pile} stack`)
    await press(`[data-pile="${pile}"] [data-id="${a.id}"] .inbox-takeback`, 'Take back')
    check(await waitSel(`#row-${a.id}`), 'Take back puts the card back on the Desk')
  }
  check(await kept(), 'the whole round ran in one page (no full load)')
}

// ---- the Desk's cards stay after a reload (bug of 3 October 2026: rows flashed, then only the paper was left) ----
// The eye switch's "cards hidden" was kept in localStorage; a stale flag hid the rows a moment after every load.
async function groupReload() {
  const a = await courier.ask('Reload stays', {})
  await load('/')
  const stays = () => ev(`
    const seen = []; const t0 = performance.now()
    while (performance.now() - t0 < 3000) {
      const box = document.getElementById('inbox'), list = box?.querySelector(':scope > .inbox-groups'), row = document.getElementById('row-${a.id}')
      const cs = list && getComputedStyle(list)
      seen.push(!!(row && cs && cs.visibility === 'visible' && Number(cs.opacity) > .5 && !box.hasAttribute('data-cards-hidden') && row.getBoundingClientRect().height > 0))
      await new Promise(r => setTimeout(r, 100))
    }
    return { all: seen.every(Boolean), laid: document.getElementById('inbox')?.classList.contains('has-deskpad'), live: document.getElementById('live')?.streamSource?.readyState === 1 }`)
  let ok = true, laid = true, live = true
  for (let i = 0; i < 4; i++) {
    await ev(`localStorage.setItem('trommi-desk-cards-hidden', '1'); return true`)   // a stale flag of the old client or an old W
    await load('/')
    const r = await stays()
    ok &&= r.all; laid &&= r.laid; live &&= r.live
  }
  check(ok, 'the rows stay visible for 3 s after each reload, also with a stale hidden flag in localStorage')
  check(laid, 'the paper was laid under them meanwhile')
  check(live, 'the live stream was connected meanwhile')
  check(await ev(`return localStorage.getItem('trommi-desk-cards-hidden') === null`), 'the stale hidden flag is cleared')
  // The eye (and W) still hides the cards in this page, and says so in the signal colour; a reload brings them back.
  // (on a phone the switches may be tucked to a tab over a card: the first click only brings them out)
  if (size === 'phone') await ev(`const e = document.getElementById('deskpad-eye'); if (document.querySelector('.deskpad-over').hasAttribute('data-tuck')) e.click(); e.click(); return true`); else await press('#deskpad-eye', 'the eye switch')
  const eyeState = await ev(`return [document.getElementById('inbox').hasAttribute('data-cards-hidden'), document.getElementById('deskpad-eye').getAttribute('aria-pressed')].join()`)
  check(eyeState === 'true,true', `the eye hides the cards and stands pressed (hidden, pressed: ${eyeState})`)
  check(await ev(`const e = document.getElementById('deskpad-eye'); return getComputedStyle(e).backgroundColor !== getComputedStyle(e.parentElement).backgroundColor`), 'the pressed eye stands out from its pill')
  await load('/')
  check((await stays()).all, 'after a reload the hidden cards are back')
  check(await ev(`return document.getElementById('deskpad-eye')?.getAttribute('aria-pressed') !== 'true'`), 'after a reload the eye is not pressed')
}

async function groupStacks() {
  const i = await courier.info('Stack info')
  await load('/')
  await press(`#row-${i.id} .inbox-answer.is-lead`, 'Acknowledge')
  await waitGone(`#row-${i.id}`)
  await load('/?pile=done')
  const line = await ev(`return document.querySelector('[data-pile="done"] [data-id="${i.id}"]')?.textContent.replace(/\\s+/g, ' ') ?? null`)
  check(line, '?pile=done shows the Done stack with the acknowledged info')
  check(line && !/done by the agent/.test(line), 'an info he acknowledged is not labelled "done by the agent"')
  check(await ev(`return document.querySelector('[data-pile="done"]')?.classList.contains('is-open')`), '?pile=done stands fanned out')
  await noSideScroll('Desk with a fanned stack')
  // The four places are small stamped tabs (card Nr. 198: c): one line on a wide screen, at most two rows on a phone,
  // no big stacks of paper; a click opens one list below them, another click on another tab swaps it; Escape closes.
  await load('/')
  const tabs = await ev(`return [...document.querySelectorAll('#desk-stacks .inbox-stack-head')].map(h => { const r = h.getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width) } })`)
  check(tabs.length === 4, `four tabs at the foot (${tabs.length})`)
  check(new Set(tabs.map(t => t.top)).size <= (size === 'phone' ? 2 : 1) && tabs.every(t => t.h < 50), `the tabs are small and in ${size === 'phone' ? 'at most two rows' : 'one line'}: ${JSON.stringify(tabs)}`)
  check(!(await has('#desk-stacks .inbox-stack-sheets')), 'no big stacks of paper on the Desk')
  await press('[data-pile="done"] .inbox-stack-head', 'the Done tab')
  check(await ev(`return document.querySelectorAll('#desk-stacks .inbox-stack.is-open').length === 1 && document.querySelector('[data-pile="done"]').classList.contains('is-open')`), 'a click on a tab opens its list, only that one')
  const below = await ev(`return document.querySelector('[data-pile="done"] .inbox-pile-sheets').getBoundingClientRect().top >= Math.max(...[...document.querySelectorAll('#desk-stacks .inbox-stack-head')].map(h => h.getBoundingClientRect().bottom)) - 1`)
  check(below, 'the open list stands below all the tabs')
  await keys('Escape')
  await sleep(300)
  check(await ev(`return !document.querySelector('#desk-stacks .inbox-stack.is-open')`), 'Escape closes the open list')
}

async function groupCard() {
  const c = await courier.ask('Card page', { body: 'Three ways, with pictures.', options: [{ key: 'a', label: 'Way A', detail: 'the first' }, { key: 'b', label: 'Way B', detail: 'the second' }, { key: 'c', label: 'Way C' }], recommended: 'b', attachments: pics })
  await load('/')
  await mark()
  await press(`#row-${c.id} .inbox-answer`, 'Choose')
  check(await waitFor('card page', `return location.pathname === '/q/${c.nr}'`), 'Choose opens /q/<number>')
  check(await kept(), 'the card page came by Drive (no full load)')
  check((await text(`#card-lead-${c.id}`))?.includes('Card page'), 'the card page shows the title')
  const opts = await ev(`return [...document.querySelectorAll('button[name="key"]')].map(b => b.getAttribute('formaction'))`)
  check(opts.length === 3 && opts.every(f => f === `/cards/${c.id}/decide`), 'the three options are buttons that post to /cards/<id>/decide')
  check(await has('button[name="key"].is-advised'), 'the advised option is marked')
  check(await has(`button[formaction="/cards/${c.id}/trust"]`), 'Whatever stands under the options')
  check(await ev(`return document.querySelectorAll('#card-media-${c.id} .focus-thumb, #card-media-${c.id} .tc-thumb').length >= 2`), 'the two pictures stand as thumbs')
  check(await ev(`const lead = document.querySelector('#card-lead-${c.id}'), media = document.querySelector('#card-media-${c.id}'); if (!lead || !media) return false; const r = document.createRange(); const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode()) && !n.textContent.includes('Three ways, with pictures.')); if (!n) return false; r.selectNodeContents(n); const body = r.getBoundingClientRect().top; return lead.getBoundingClientRect().top < body && body < media.getBoundingClientRect().top`), 'order: title, then text, then gallery')
  await noSideScroll('card page')
  // the picture page and the way back
  await load(`/q/${c.nr}/p/1`)
  check(await ev(`return !!document.querySelector('main img, .t-picture img')`), '/q/<n>/p/1 shows the picture large')
  await ev(`history.back()`); await sleep(600)
  // the browser's Back from a Drive visit
  await load('/'); await mark()
  await press(`#row-${c.id} a.inbox-text`, 'the title')
  await waitFor('card', `return location.pathname === '/q/${c.nr}'`)
  await ev(`history.back()`)
  check(await waitFor('desk', `return location.pathname === '/' && !!document.querySelector('#row-${c.id}')`), 'Back returns to the Desk with the row')
  check(await kept(), 'Back is a Drive restore (no full load)')
  await ev(`history.forward()`)
  check(await waitFor('card', `return location.pathname === '/q/${c.nr}'`), 'Forward returns to the card page')
  await settle()
  // answer with an option
  await press('button[name="key"][formaction$="/decide"]', 'the first option')
  check(await waitFor('desk', `return location.pathname === '/'`), 'an answer leads back to the Desk')
  check(/Answered/.test((await waitFor('note', `return document.querySelector('#says-host')?.textContent`)) ?? ''), 'the passing note says what was answered')
  check(!(await has(`#row-${c.id}`)), 'the answered card is not on the Desk')
  // Whatever
  const w = await courier.ask('Card whatever')
  await load(`/q/${w.nr}`)
  await press(`button[formaction="/cards/${w.id}/trust"]`, 'Whatever')
  check(/give a duck|Whatever/.test((await waitFor('note', `return document.querySelector('#says-host')?.textContent`)) ?? ''), 'Whatever is answered with its own passing note')
  // an info card
  const i = await courier.info('Card info', 'Words to read.')
  await courier.tool('reply', { text: 'More about it below the card.', card_id: i.id })
  await load(`/q/${i.nr}`)
  check(await has(`button[formaction="/cards/${i.id}/close"]`), 'an info card offers Acknowledge')
  check(/message below|messages below/.test((await text('#card-lead-' + i.id)) ?? ''), 'an info card\'s meta line says how many messages stand below')
  if (size === 'phone') check(await ev(`const b = document.querySelector('button[formaction="/cards/${i.id}/close"]'); return b && b.getBoundingClientRect().bottom <= innerHeight`), 'on a phone an info card\'s Acknowledge stands in the first screen')
  await press(`button[formaction="/cards/${i.id}/close"]`, 'Acknowledge')
  check(await waitFor('left', `return location.pathname !== '/q/${i.nr}' || !document.querySelector('button[formaction="/cards/${i.id}/close"]')`), 'Acknowledge closes the info')
}

async function groupWalk() {
  const a = await second.ask('Walk first'), b = await second.ask('Walk second')
  await load('/walk')
  const at = await where()
  check(/^\/q\/\d+\?walk=1$/.test(at), `/walk opens the oldest open card with ?walk=1 (${at})`)
  // walk through every open card by answering or Whatever, until the Desk is reached
  let steps = 0
  for (; steps < 40 && /walk=1/.test(await where()); steps++) {
    const btn = (await has('button[name="key"][formaction$="/decide"]')) ? 'button[name="key"][formaction$="/decide"]' : (await has('button[formaction$="/close"]')) ? 'button[formaction$="/close"]' : 'button[formaction$="/trust"]'
    const before = await where()
    await press(btn, 'an answer in the walk')
    await waitFor('next', `return location.pathname + location.search !== ${q(before)}`)
  }
  check(await ev(`return location.pathname === '/'`), `answering card after card in the walk ends on the Desk (${steps} steps)`)
  check(!(await has(`#row-${a.id}`)) && !(await has(`#row-${b.id}`)), 'the walked cards are answered')
  await load('/walk')
  check(await where() === '/' || (await where()).startsWith('/?'), 'with nothing open /walk leads to the Desk')
}

async function groupSession() {
  await second.tool('reply', { text: 'Hello from **Second**.' })
  await load(`/s/${second.id}`)
  check(await ev(`return document.body.dataset.tView === 'session'`), `/s/<id> is the session page`)
  need(await has(`#composer-${second.id} textarea`), 'the session page has the composer')
  await mark()
  await press(`#composer-${second.id} textarea`, 'the field')
  await type(`A message from the browser test (${size})`)
  await keys('Enter', { ctrl: true })
  check(await waitFor('appended', `return [...document.querySelectorAll('#chat .msg')].some(m => m.textContent.includes(${q(`A message from the browser test (${size})`)}))`), 'Ctrl+Enter sends; the message stands in the conversation')
  check(await waitFor('cleared', `return document.querySelector('#composer-${second.id} textarea')?.value === ''`), 'the field is empty after sending')
  check(await kept(), 'sending keeps the page alive')
  check(await waitFor('working', `return /Agent is working/.test(document.querySelector('#session-status-${second.id}')?.textContent ?? '')`, 3000), 'after his message the session shows "Agent is working"')
  await press(`#composer-${second.id} textarea`, 'the field')
  await type(`Second line by button (${size})`)
  await press(`#composer-${second.id} .send`, 'Send')
  check(await waitFor('appended', `return [...document.querySelectorAll('#chat .msg')].filter(m => m.textContent.includes(${q(`Second line by button (${size})`)})).length === 1`), 'the Send button sends once')
  await second.tool('reply', { text: `A live answer from Second (${size}).` })
  check(await waitFor('live', `return [...document.querySelectorAll('#chat .msg')].some(m => m.textContent.includes(${q(`A live answer from Second (${size}).`)}))`), 'a reply of the agent appends live')
  // a question of the session stands inline and is answered there
  const c = await second.ask('Inline')
  check(await waitSel(`#row-${c.id}`), 'a new question of the session appears inline, live')
  await press(`#row-${c.id} .inbox-answer.is-lead`, 'Yes inline')
  check(await waitGone(`#row-${c.id} .inbox-answer`), 'the inline question is answered in place')
  // earlier messages
  for (let k = 0; k < 64; k += 8) await Promise.all(Array.from({ length: 8 }, (_, j) => courier.tool('reply', { text: `Filler ${k + j}` })))
  await load(`/s/${courier.id}`)
  const before = await ev(`return document.querySelectorAll('#chat [id^="msg-"]').length`)
  need(await has('turbo-frame.log-earlier a'), 'a long conversation offers "Earlier messages"')
  await press('turbo-frame.log-earlier a', 'Earlier messages')
  check(await waitFor('more', `return document.querySelectorAll('#chat [id^="msg-"]').length > ${before}`), 'Earlier messages loads the older ones into the page')
  check(await where() === `/s/${courier.id}`, 'loading earlier messages keeps the address')
  // files and a picture page
  await courier.tool('reply', { text: 'Two pictures.', attachments: pics })
  await load(`/s/${courier.id}`)
  await press('.session-filter > summary', 'the filter beside the composer')
  check(await ev(`return document.querySelector('.session-filter').open`), 'the filter icon opens its menu')
  if (size === 'phone') check(await ev(`const f = document.querySelector('#filter-files'); return !!f && getComputedStyle(f).display !== 'none' && /Files \\(\\d+\\)/.test(f.textContent)`), 'on a phone the filter menu has "Files (N)" (card Nr. 204)')
  else check(await ev(`const f = document.querySelector('#filter-files'); return !f || getComputedStyle(f).display === 'none'`), 'on a wide screen Files is no filter (card Nr. 204)')
  await ev(`document.querySelector('.session-filter').open = false`)
  // the files: "N files" beside the quiet line (a phone: "Files (N)" in the filter menu) opens the drawer, the conversation stays
  const openFiles = async () => { if (size === 'phone') { await press('.session-filter > summary', 'the filter'); await press('#filter-files', 'Files (N)') } else await press('.files-chip', 'N files') }
  need(await has('.files-chip'), 'the session shows "N files"')
  await openFiles()
  check(await waitFor('drawer', `return !document.querySelector('.files-drawer').hidden && document.querySelectorAll('.files-group').length > 0`), 'the chip opens the drawer and its list loads')
  check(await ev(`return location.pathname === '/s/${courier.id}' && !!document.querySelector('.log')`), 'the conversation stays, the address too')
  await press('.files-jump', 'Jump to')
  check(await waitFor('jumped', `return !!document.querySelector('#chat .is-jumped') || location.search.includes('before=')`), 'Jump to marks the message (or loads its window)')
  await load(`/s/${courier.id}`)
  await openFiles()
  await waitFor('drawer2', `return document.querySelectorAll('.files-group').length > 0`)
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  check(await waitFor('closed', `return document.querySelector('.files-drawer').hidden`), 'Escape closes the drawer')
  await openFiles()
  await press('a.files-thumb[data-nav]', 'a picture in the drawer')
  check(await waitFor('pic', `return /^\\/s\\/${courier.id}\\/files\\/\\d+$/.test(location.pathname)`), 'a picture opens at /s/<id>/files/<n>')
  await ev(`history.back()`)
  check(await waitFor('back', `return location.pathname === '/s/${courier.id}'`), 'Back returns to the conversation')
  await load(`/s/${courier.id}?only=questions`)
  check(await ev(`return document.querySelector('#filter-questions')?.getAttribute('aria-current') === 'true' && !!document.querySelector('.session-filter[data-on] .session-filter-dot')`), '?only=questions ticks its entry and puts the dot on the filter icon')
  await noSideScroll('session page')
  // the crown on the heading
  await crown(second.id, true)
  await load(`/s/${second.id}`)
  check(await ev(`return /crown/.test(document.querySelector('#session-who-${second.id}')?.innerHTML ?? '')`), 'the heading of a crowned session wears the crown')
}

/** Give or take the crown through the agents page's form (works without the page's scripts). */
async function crown(id, on) {
  return ev(`const f = document.querySelector('#ledger-${id} form[action$="/star"]') ; const fd = new URLSearchParams({ starred: ${on ? "'1'" : "'0'"} }); const r = await fetch('/sessions/${id}/star', { method: 'POST', body: fd }); return r.status`)
}

async function groupAgents() {
  await load('/agents')
  check(await ev(`return document.body.dataset.tView === 'agents'`), '/agents is the agents page')
  check(await has(`#ledger-${courier.id}`) && await has(`#ledger-${second.id}`), 'both linked sessions have a line')
  await noSideScroll('agents page')
  if (size === 'desktop') {
    await mark()
    await press(`#ledger-${second.id} summary.ledger-rename`, 'rename')
    await ev(`const i = document.querySelector('#session-name-${second.id}'); i.focus(); i.select(); return true`)
    await type('Second Renamed')
    await keys('Enter')
    check(await waitFor('renamed', `return document.querySelector('#ledger-${second.id} .ledger-name')?.textContent.includes('Second Renamed')`), 'rename changes the line')
    check(await waitFor('sidebar', `return [...document.querySelectorAll('#agents .agent-entry')].some(a => a.textContent.includes('Second Renamed'))`), 'the sidebar shows the new name live')
    check(await kept(), 'renaming keeps the page alive')
    const crowned = () => ev(`return document.querySelector('#ledger-${second.id} .ledger-crown')?.getAttribute('aria-pressed')`)
    const was = await crowned()
    await press(`#ledger-${second.id} .ledger-crown`, 'the crown')
    check(await waitFor('flipped', `return document.querySelector('#ledger-${second.id} .ledger-crown')?.getAttribute('aria-pressed') === ${q(was === 'true' ? 'false' : 'true')}`), 'the crown button gives or takes the crown')
    await press(`#ledger-${second.id} .ledger-crown`, 'the crown again')
    check(await waitFor('back', `return document.querySelector('#ledger-${second.id} .ledger-crown')?.getAttribute('aria-pressed') === ${q(was)}`), 'and a second press undoes it')
    await press(`#ledger-${courier.id} .ledger-crown`, 'the crown of the other session')
    check(await waitFor('one', `return document.querySelector('#ledger-${courier.id} .ledger-crown')?.getAttribute('aria-pressed') === 'true' && document.querySelectorAll('.ledger-crown[aria-pressed="true"]').length === 1`), 'one crown per desk: giving it to another takes it from the first')
  } else {
    check(await has(`#ledger-${second.id} summary.ledger-menu`), 'a phone line has its "…" menu')
  }
}

async function groupMenu() {
  await load('/')
  await press('#brand-menu', 'the Trommi pill')
  check(await ev(`return document.querySelector('#brand-menu').getAttribute('aria-expanded') === 'true'`), 'the pill opens the menu')
  check(await ev(`const d = document.querySelector('#brand-doors'); return !!d && !d.hidden && d.getBoundingClientRect().height > 100`), 'the drop-down stands open')
  // entries by their name: visible words, else aria-label, else title; entries without a name are not compared
  const names = await ev(`return [...document.querySelectorAll('#brand-doors a, #brand-doors button, #brand-doors summary')].filter(e => e.getBoundingClientRect().width).map(e => (e.textContent.replace(/\\s+/g, ' ').trim() || e.getAttribute('aria-label') || e.getAttribute('title') || '').trim()).filter(Boolean)`)
  check(new Set(names).size === names.length, `no entry stands twice in the menu (${names.filter((x, k) => names.indexOf(x) !== k).join(', ')})`)
  // Dev: folded by default, holds Admin and the old board, unfolds in place
  check(await ev(`const d = document.querySelector('#menu-dev'); return !!d && !d.open`), 'Dev is folded when the menu opens')
  check(await ev(`return [...document.querySelectorAll('#brand-doors a[href="/admin.html"]')].every(a => a.closest('#menu-dev'))`), 'Admin stands only under Dev')
  check(await ev(`return [...document.querySelectorAll('#brand-doors a[href^="/old"]')].every(a => a.closest('#menu-dev')) && !!document.querySelector('#menu-dev a[href^="/old"]')`), '"Old board" stands only under Dev')
  check(await ev(`const a = document.querySelector('#dev-admin'); return !!a && !a.checkVisibility()`), 'folded, Admin is not shown')
  await press('#dev-open', 'Dev')
  check(await ev(`return document.querySelector('#menu-dev').open && document.querySelector('#dev-admin').checkVisibility()`), 'Dev unfolds and shows Admin')
  check(await ev(`return document.querySelector('#brand-menu').getAttribute('aria-expanded') === 'true'`), 'unfolding Dev leaves the menu open')
  // the connection: no line in the menu; a dot on the pill, seen only while the stream is lost
  check(await ev(`return !document.querySelector('#brand-doors #conn') && !!document.querySelector('#brand-menu #conn')`), 'the connection sits on the pill, not in the menu')
  check(await waitFor('online', `return document.querySelector('#conn')?.dataset.state === 'online' && /Connected/.test(document.querySelector('#conn-text')?.textContent)`), 'the connection says "Connected" with the stream open')
  await ev(`document.querySelector('#live').streamSource.dispatchEvent(new Event('error')); return true`)
  check(await ev(`return document.querySelector('#conn').dataset.state === 'offline' && /No connection/.test(document.querySelector('#conn-text').textContent) && document.querySelector('#conn').checkVisibility()`), 'a broken stream shows the warning dot on the pill')
  await ev(`document.querySelector('#live').streamSource.dispatchEvent(new Event('open')); return true`)
  check(await ev(`return document.querySelector('#conn').dataset.state === 'online' && !document.querySelector('#conn').checkVisibility()`), 'and the dot goes when it opens again')
  // "+" makes a desk inline
  const deskName = `Test desk ${size}`
  await press('#desk-add', 'New desk')
  check(await ev(`const f = document.querySelector('#desk-new'); return !!f && !f.hidden && document.activeElement === document.querySelector('.menu-desk-field')`), '"+" opens a line for the new desk\'s name, with the cursor in it')
  await type(deskName)
  await keys('Enter')
  check(await waitFor('desk', `return new URLSearchParams(location.search).get('desk') && location.pathname === '/'`), `Enter makes the desk and goes to it (${await where()})`)
  await settle()
  await press('#brand-menu', 'the Trommi pill')
  check(await ev(`return [...document.querySelectorAll('#menu-desks .menu-desk')].some(a => a.textContent.includes(${q(deskName)}))`), 'the new desk is listed in the menu')
  await keys('Escape'); await sleep(200)
  // take the test desk away again, so the next groups see the default desk
  const id = new URL(await ev(`return location.href`)).searchParams.get('desk')
  if (id) await ev(`await fetch('/desk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ${q(id)}, remove: true }) }); return true`)
  await load('/?desk=main')
  // theme and Escape
  await press('#brand-menu', 'the Trommi pill')
  await press('#theme-toggle', 'Theme')
  check(await ev(`return document.documentElement.dataset.theme === 'dark'`), 'Theme switches to dark')
  await press('#theme-toggle', 'Theme')
  check(await ev(`return document.documentElement.dataset.theme !== 'dark'`), 'and back to light')
  await keys('Escape'); await sleep(200)
  check(await ev(`return document.querySelector('#brand-menu').getAttribute('aria-expanded') !== 'true'`), 'Escape closes the menu')
  await press('#brand-menu', 'the Trommi pill')
  await mark()
  await press('#menu-agents', 'Agents')
  check(await waitFor('agents', `return location.pathname === '/agents'`), 'Agents in the menu leads to /agents')
  check(await kept(), 'by Drive')
}

async function groupNav() {
  await load('/'); await mark()
  const docs0 = documents
  const sess = `#agents a.agent-entry[href="/s/${courier.id}"]`
  if (size === 'desktop' || await box(sess)) {
    await press(sess, 'a session in the sidebar')
    check(await waitFor('session', `return location.pathname === '/s/${courier.id}'`), 'the sidebar leads to /s/<id>')
  } else await load(`/s/${courier.id}`)
  await press('#desk-go, #agents a[href="/"], a[href="/"]', 'the way to the Desk')
  check(await waitFor('desk', `return location.pathname === '/'`), 'the Desk pill leads to /')
  check(documents === docs0 && await kept(), 'no full page load between Desk and session')
  await ev(`history.back()`)
  check(await waitFor('back', `return location.pathname === '/s/${courier.id}'`), 'Back returns to the session')
  // old prefix and the old client
  const r = await fetch(`${base}/t/agents`, { headers: { cookie: `board_${port}=${token}` }, redirect: 'manual' })
  check([301, 302, 303, 307, 308].includes(r.status) && /\/agents$/.test(r.headers.get('location') ?? ''), `/t/agents redirects to /agents (${r.status} ${r.headers.get('location')})`)
  const old = await fetch(`${base}/old/`, { headers: { cookie: `board_${port}=${token}` } })
  check(old.ok && /<script[^>]+app\.js/.test(await old.text()), '/old/ serves the old client')
  const missing = await fetch(`${base}/q/999999`, { headers: { cookie: `board_${port}=${token}` } })
  check(missing.status === 404, `an unknown card number is a 404 page (${missing.status})`)
}

async function groupLive() {
  await load('/')
  await mark()
  const n0 = await rowCount()
  const c = await courier.ask('Live arrival')
  check(await waitSel(`#row-${c.id}`), 'a new card appears on the open Desk without a reload')
  check(await waitFor('count', `return document.querySelector('#desk-head .inbox-next-n')?.textContent.trim() === String(${n0 + 1})`), 'the heading count follows')
  check(await waitFor('title', `return document.title.includes('(${n0 + 1})')`, 2500), `the tab title follows the count (${await ev('return document.title')})`)
  await courier.tool('withdraw_card', { card_id: c.id })
  check(await waitGone(`#row-${c.id}`), 'a withdrawn card leaves the open Desk')
  check(await kept(), 'the page stayed the same page')
  // a card answered elsewhere leaves: answer it with a plain post, as another device would
  const d = await courier.ask('Live answered elsewhere')
  await waitSel(`#row-${d.id}`)
  await fetch(`${base}/cards/${d.id}/decide`, { method: 'POST', headers: { cookie: `board_${port}=${token}`, origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'key=yes', redirect: 'manual' })
  check(await waitGone(`#row-${d.id}`), 'a card answered on another device leaves the open Desk')
  // the card page of a card that gets answered elsewhere
  const e = await courier.ask('Live card page')
  await load(`/q/${e.nr}`)
  await courier.tool('reply', { text: 'A word under the card.', card_id: e.id })
  check(await waitFor('feed', `return document.querySelector('#card-thread-${e.id}')?.textContent.includes('A word under the card.')`), 'a reply about the card appears in its feed live')
  await courier.tool('revise_card', { card_id: e.id, title: 'Live card page revised' }).catch(() => {})
  check(await waitFor('lead', `return document.querySelector('#card-lead-${e.id}')?.textContent.includes('revised')`), 'a revised title replaces the old one live')
}

async function groupForms() {
  // with the page's scripts off: a tile is a plain form, the answer a redirect to the Desk
  const c = await courier.ask('Plain post')
  // leave the live page first: a stream message that arrives while scripts are being switched off meets
  // half-upgraded elements (a test artefact, not a fault of the page)
  await page.send('Page.navigate', { url: 'about:blank' }); await sleep(200)
  await page.send('Emulation.setScriptExecutionDisabled', { value: true })
  try {
    await load('/', '#desk-list')
    await press(`#row-${c.id} .inbox-answer.is-lead`, 'Yes without scripts')
    check(await waitFor('reloaded', `return !document.querySelector('#row-${c.id}')`, 6000), 'without scripts the tile posts and the Desk comes back without the row')
    check(/^\/(\?said=|$)/.test(await where()), `without scripts the post redirects to the Desk (${await where()})`)
  } finally {
    // leave the page first: scripts switched on under a page that was loaded without them run half (a test artefact)
    await page.send('Page.navigate', { url: 'about:blank' }); await sleep(200)
    await page.send('Emulation.setScriptExecutionDisabled', { value: false })
  }
  const cookie = `board_${port}=${token}`
  const post = (p, body, accept) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { cookie, origin: base, 'Content-Type': 'application/x-www-form-urlencoded', ...(accept ? { Accept: accept } : {}) }, body })
  const d = await courier.ask('Plain redirect')
  let r = await post(`/cards/${d.id}/decide`, 'key=nope')
  check(r.status === 422, `an unknown option is refused with 422 (${r.status})`)
  r = await post(`/cards/${d.id}/decide`, 'key=yes')
  check(r.status === 303 && /^\/\?said=/.test(r.headers.get('location') ?? ''), `a plain post answers 303 to the Desk with the note (${r.status} ${r.headers.get('location')})`)
  const e = await courier.ask('Stream answer')
  r = await post(`/cards/${e.id}/decide`, 'key=no&stay=1', 'text/vnd.turbo-stream.html, text/html')
  check(r.ok && /<turbo-stream/.test(await r.text()), 'with stay=1 and Turbo\'s Accept the answer is a turbo stream')
  r = await fetch(`${base}/cards/${e.id}/reopen`, { method: 'POST', redirect: 'manual', headers: { cookie, origin: 'http://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' })
  check(r.status === 403, `a post from another origin is refused (${r.status})`)
  const m = new FormData(); m.set('text', 'Plain message')
  r = await fetch(`${base}/s/${second.id}/message`, { method: 'POST', redirect: 'manual', headers: { cookie, origin: base }, body: m })
  check(r.status === 303, `the composer as a plain multipart post answers 303 (${r.status})`)
}

// ---- the sidebar folded to a rail (card Nr. 150): the "|<" at its foot or [, remembered across reloads; wide only ----
async function groupRail() {
  await ev(`localStorage.removeItem('trommi-rail'); return true`)
  await load('/')
  const folded = () => ev(`return document.documentElement.dataset.rail === 'folded'`)
  if (size === 'phone') {
    await ev(`localStorage.setItem('trommi-rail', 'folded'); return true`)
    await load('/')
    check(!(await box('.rail-fold')), 'on a phone there is no rail button')
    await keys('[')
    await sleep(200)
    check(await ev(`return localStorage.getItem('trommi-rail') === 'folded'`), 'on a phone [ changes nothing')
    await ev(`localStorage.removeItem('trommi-rail'); return true`)
    return
  }
  const wide = await ev(`return document.getElementById('agents').getBoundingClientRect().width`)
  await press('.rail-fold', 'the rail button')
  check(await folded(), 'the button folds the sidebar to a rail')
  const narrow = await ev(`return document.getElementById('agents').getBoundingClientRect().width`)
  check(narrow < 90 && wide > 200, `the sidebar is a narrow rail (${wide} -> ${narrow} px)`)
  check(await ev(`return [...document.querySelectorAll('#agents .agent-text')].every(t => !t.getClientRects().length)`), 'the rail shows no names')
  await hover('#agents .agent-row:not([hidden]) .agent-entry')
  const name = await ev(`return document.querySelector('#agents .agent-row:not([hidden]) .agent-text strong')?.textContent.trim()`)
  check(name && (await text('.rail-tip')) === name, `a row under the pointer says its name beside it (${name})`)
  await load('/')
  check(await folded(), 'the rail stays folded after a reload')
  check(await ev(`return document.querySelector('.rail-fold').getAttribute('aria-pressed') === 'true'`), 'the button says it is pressed')
  await keys('[')
  await sleep(200)
  check(!(await folded()) && (await ev(`return localStorage.getItem('trommi-rail') === null`)), '[ opens the sidebar again and forgets the fold')
  await load('/')
  check(!(await folded()), 'opened, it stays open after a reload')
}

async function groupMemo() {
  // A note belongs where it was written: the Desk's notes on the Desk (to the crown), a session's on its page (to it).
  await load('/')
  const make = fields => ev(`const r = await fetch('/memos', { method: 'POST', headers: { Accept: 'text/vnd.turbo-stream.html' }, body: new URLSearchParams(${JSON.stringify(fields)}) }); return /id="memo-([\\w-]+)"/.exec(await r.text())?.[1] ?? null`)
  const desk = await make({ place: 'float', text: 'Desk-Notiz' })
  const own = await make({ place: 'float', text: 'Notiz an Second', session: second.id })
  need(desk && own, 'two notes are made, one on the Desk and one for a session')
  const corner = () => ev(`const r = document.getElementById('memo-open').getBoundingClientRect(); return { right: Math.round(innerWidth - r.right), bottom: Math.round(innerHeight - r.bottom) }`)
  await load('/')
  check(await waitSel(`#memo-${desk}`), 'the Desk shows its note')
  check(!(await has(`#memo-${own}`)), 'the Desk does not show a session\'s note')
  const c1 = await corner()
  check(c1.right < 40 && c1.bottom < 60, `the memo button stands bottom right on the Desk (${JSON.stringify(c1)})`)
  await load(`/s/${second.id}`)
  check(await has(`#memo-${own}`) || size === 'phone', 'the session\'s page shows its note')
  check(!(await has(`#memo-${desk}`)), 'the session\'s page does not show the Desk\'s note')
  check(await ev(`const b = document.querySelector('#memo-${own} .memo-send'); return b?.dataset.seal === 'session' && b.value === ${JSON.stringify(second.id)}`), 'its envelope is sealed with the session\'s drawing and goes to it')
  const c2 = await corner()
  check(c2.right < 40, `the memo button stands at the right on a session's page (${JSON.stringify(c2)})`)
  check(await ev(`const a = document.getElementById('memo-open').getBoundingClientRect(), f = document.querySelector('form.composer')?.getBoundingClientRect(); return !f || a.bottom <= f.top || a.top >= f.bottom || a.right <= f.left || a.left >= f.right`), 'the memo button does not cover the message field')
  for (const id of [desk, own]) await ev(`await fetch('/memos/${id}/bin', { method: 'POST', headers: { Accept: 'text/vnd.turbo-stream.html' } }); return true`)
}

const GROUPS = [
  ['desk', groupDesk], ['stacks', groupStacks], ['card', groupCard], ['walk', groupWalk], ['session', groupSession],
  ['agents', groupAgents], ['menu', groupMenu], ['nav', groupNav], ['live', groupLive], ['forms', groupForms],
  ['reload', groupReload], ['rail', groupRail], ['memo', groupMemo],
]

// ---- main ------------------------------------------------------------------------------------------------
async function group(name, fn) {
  current = { name, size, passed: 0, failures: [], pending: [], fixed: [] }
  problems = []
  const began = Date.now()
  try { await fn() } catch (err) { current.failures.push(err instanceof Failed ? `stopped: ${err.message}` : `the test itself broke: ${err.stack ?? err}`) }
  await sleep(100)
  const complaints = [...new Set(problems)]
  if (complaints.length) current.failures.push(...complaints.slice(0, 5).map(p => `the browser complained: ${p}`)); else current.passed++
  if (current.failures.length) current.shot = await shot(`${name}-FAILED`).catch(() => '')
  results.push(current)
  const word = current.failures.length ? 'FAIL   ' : current.pending.length ? 'pending' : 'ok     '
  console.log(`${word} ${size.padEnd(7)} ${name.padEnd(8)} ${String(current.passed).padStart(3)} passing${current.failures.length ? `, ${current.failures.length} failing` : ''}${current.pending.length ? `, ${current.pending.length} pending` : ''}  (${((Date.now() - began) / 1000).toFixed(1)} s)`)
  for (const f of current.failures) console.log(`          - ${f}`)
  for (const p of current.pending) console.log(`          ~ pending: ${p}`)
  for (const f of current.fixed) console.log(`          + now passes, take it off PENDING: ${f}`)
  current = null
}

async function main() {
  const unknown = only.filter(w => !GROUPS.some(([n]) => n === w))
  if (unknown.length) { console.error(`no such group: ${unknown.join(', ')}. Groups: ${GROUPS.map(g => g[0]).join(', ')}`); process.exit(2) }
  fs.rmSync(shotDir, { recursive: true, force: true })
  const began = Date.now()
  let broke = false
  try {
    await startHub()
    courier = session('Courier'); second = session('Second')
    await courier.tool('introduce', { model: 'no model', task: 'Files what the browser test needs' })
    await second.tool('introduce', { model: 'no model', task: 'A plain other session' })
    await openBrowser()
    await page.send('Page.navigate', { url: `${base}/?t=${token}` })
    await waitSel('body[data-t-view]', 10000)
    console.log(`hub on ${base}, up after ${((Date.now() - began) / 1000).toFixed(1)} s\n`)
    for (const which of sizes) {
      await setSize(which)
      for (const [name, fn] of GROUPS) if (!only.length || only.includes(name)) await group(name, fn)
    }
  } catch (err) { broke = true; console.log(`\nthe suite could not run: ${err.stack ?? err}`) }
  const sum = k => results.reduce((n, r) => n + (typeof r[k] === 'number' ? r[k] : r[k].length), 0)
  console.log(`\n${sum('passed')} checks passing, ${sum('failures')} failing, ${sum('pending')} pending in ${((Date.now() - began) / 1000).toFixed(0)} s`)
  if (sum('failures')) console.log(`screenshots of failing groups: ${shotDir}`)
  await cleanup()
  process.exit(broke ? 2 : sum('failures') ? 1 : 0)
}

await main()
