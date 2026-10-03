// The keyboard, the Trommi menu, the sheets and the passing note of the server-rendered board (/), tried with
// real key, mouse and touch events in headless Chromium against a board of its own.
//   node dev/turbo-keys-test.mjs [PORT] [OUT_DIR]   default port 8886, screenshots into OUT_DIR (default $TMPDIR/turbo-keys-test)
// Starts a hub on PORT (never 8790 or 8795) with two sessions and a set of questions, drives the pages by
// keys, and checks the board's own state after every answer. The hub and the browser are stopped with the test,
// however it ends (dev/cdp.mjs, guard()). Needs the command sandbox disabled. Exit code 1 when a check fails.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchChromium, guard } from './cdp.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.argv[2] || 8886)
const out = process.argv[3] || path.join(os.tmpdir(), 'turbo-keys-test')
if (port === 8790 || port === 8795) throw new Error('that port belongs to a board in use')
fs.mkdirSync(out, { recursive: true })
const token = 'demo'
const base = `http://127.0.0.1:${port}`
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---- the board ---------------------------------------------------------------
await new Promise((resolve, reject) => {
  const probe = http.get(`${base}/`, res => { res.resume(); reject(new Error(`port ${port} is already in use (an earlier run still going?); pass another port`)) })
  probe.on('error', resolve)
  probe.setTimeout(1500, () => { probe.destroy(); resolve() })
})
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'turbo-keys-data-'))
const hub = spawn('node', [path.join(ROOT, 'server', 'server.mjs')], {
  env: { ...process.env, BOARD_PORT: String(port), BOARD_HOST: '127.0.0.1', BOARD_TOKEN: token, BOARD_DATA: dataDir, BOARD_HUB_ONLY: '1', BOARD_AGENT: '', BOARD_PASSKEYS: 'off', BOARD_PUBLIC_URL: '', BOARD_TURBO_BASE: '' },
  stdio: ['pipe', 'ignore', 'pipe'],
})
guard(hub, { dirs: [dataDir] })
let hubLog = ''
hub.stderr.on('data', d => { hubLog += d })
const links = []
let browser = null
async function stop(code) {
  for (const req of links) req.destroy()
  try { await browser?.close() } catch {}
  hub.kill()
  fs.rmSync(dataDir, { recursive: true, force: true })
  process.exit(code)
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => stop(130))

const slug = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const instanceOf = id => crypto.createHash('sha256').update(`${id}|${token}`).digest('hex').slice(0, 16)
/** A session held online the way dev/session.mjs does it. */
async function session(name) {
  const id = slug(name)
  const query = new URLSearchParams({ name, id, instance: instanceOf(id), cwd: ROOT, host: 'turbo-keys-test', platform: 'test' })
  await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: `/agent/link?${query}`, headers: { 'x-board-token': token } }, res => { res.resume(); resolve() })
    req.on('error', reject)
    links.push(req)
  })
  const call = async (tool, args) => {
    const res = await fetch(`${base}/agent/tool`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-board-token': token }, body: JSON.stringify({ id, instance: instanceOf(id), name: tool, args }) })
    const body = await res.json()
    if (!res.ok) throw new Error(`${name}: ${tool}: ${body.error ?? res.status}`)
    return body.text ?? ''
  }
  const ask = async card => {
    const made = (await call('create_decision', card)).match(/^card (\w+) /)?.[1]
    if (!made) throw new Error(`${name}: create_decision did not name its card`)
    return made
  }
  return { id, call, ask }
}
/** The board's state as the old page gets it, kept current. */
async function watchState() {
  const res = await fetch(`${base}/events`, { headers: { cookie: `board_${port}=${token}` } })
  if (!res.ok) throw new Error(`the board refused the test's login: ${res.status}`)
  const watch = { state: null }
  ;(async () => {
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true })
        for (let at; (at = buffer.indexOf('\n\n')) >= 0;) {
          const frame = buffer.slice(0, at)
          buffer = buffer.slice(at + 2)
          if (frame.startsWith('data: ')) watch.state = JSON.parse(frame.slice(6))
        }
      }
    } catch {}
  })()
  return watch
}

// ---- checks ------------------------------------------------------------------
let passed = 0
const failures = []
function check(ok, what) {
  if (ok) passed++
  else { failures.push(what); console.log(`  FAIL  ${what}`) }
  return ok
}
const section = name => console.log(`\n${name}`)
async function until(what, fn, ms = 4000) {
  const end = Date.now() + ms
  for (;;) {
    let value
    try { value = await fn() } catch { value = null }
    if (value) { passed++; return value }
    if (Date.now() > end) { failures.push(what); console.log(`  FAIL  ${what} (waited ${ms} ms)`); return null }
    await sleep(60)
  }
}

// ---- the page ----------------------------------------------------------------
let page = null
const pageErrors = []
const CODES = { Enter: 13, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, Backspace: 8, '?': 191, ',': 188, '.': 190 }
async function key(name, { ctrl = false, pause = 130 } = {}) {
  const code = CODES[name] ?? name.toUpperCase().charCodeAt(0)
  const text = ctrl ? undefined : name === 'Enter' ? '\r' : name.length === 1 ? name : undefined
  const event = { key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: ctrl ? 2 : 0 }
  await page.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...event, ...(text ? { text } : {}) })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
  await sleep(pause)
}
const keys = async (...names) => { for (const n of names) await key(n) }
const type = text => page.send('Input.insertText', { text })
async function ev(js) {
  const res = await page.send('Runtime.evaluate', { expression: `(() => { ${js} })()`, awaitPromise: true, returnByValue: true })
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text)
  return res.result?.value
}
async function mouse(x, y, { hold = 0 } = {}) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  if (hold) await sleep(hold)
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(150)
}
const pointOf = sel => ev(`const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }`)
async function click(sel, opts) { const at = await pointOf(sel); await mouse(at.x, at.y, opts) }
async function shot(name) {
  await sleep(400)
  const img = await page.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(img.data, 'base64'))
}
async function open(url, { width = 1440, height = 900 } = {}) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
  await page.send('Page.navigate', { url: `${base}${url}${url.includes('?') ? '&' : '?'}t=${token}` })
  await sleep(1500)
}
/** A page Turbo went to stands, and the stream's "refresh" for a page shown from its cache is through. */
const settled = async () => { for (let i = 0; i < 40 && await ev(`return document.documentElement.hasAttribute('data-turbo-preview')`); i++) await sleep(50); await sleep(900) }
const sheetUp = () => until('the sheet has come up', () => ev(`const d = document.querySelector('#row-sheet'); return d.open && d.getAnimations().every(a => a.playState === 'finished')`))
const where = () => ev('return location.pathname + location.search')
const cur = () => ev(`const n = document.querySelector('#desk-list .is-current'); return n ? { id: n.dataset.id, focus: document.activeElement === n, pile: n.classList.contains('inbox-done') } : null`)
const says = () => ev(`const n = document.querySelector('#says-host .says'); if (!n) return null; const r = n.getBoundingClientRect(); return { text: n.innerText.replace(/\\s+/g, ' '), x: r.left, y: r.top, back: Boolean(n.querySelector('form .says-back')) }`)
const rowIds = () => ev(`return [...document.querySelectorAll('#desk-list .inbox-row')].map(n => n.dataset.id)`)
/** Move the mark to a card with J (Home first). */
async function markRow(id) {
  await key('Home')
  for (let i = 0; i < 40; i++) {
    if ((await cur())?.id === id) return true
    await key('j', { pause: 50 })
  }
  return check(false, `J does not reach the row of card ${id}`)
}

// ---- the run -----------------------------------------------------------------
const YES_NO = [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }]
async function main() {
  for (let i = 0; i < 80; i++) { if (await fetch(`${base}/`).then(r => r.status === 401, () => false)) break; await sleep(100) }
  const watch = await watchState()
  const card = id => watch.state.cards.find(c => c.id === id)
  const alpha = await session('Alpha'), beta = await session('Beta')
  for (const s of [alpha, beta]) await s.call('introduce', { model: 'none', task: `Questions of ${s.id} for the keyboard test` })
  const c = {}
  c.a1 = await alpha.ask({ title: 'Keep the nightly job?', options: YES_NO })
  c.a2 = await alpha.ask({ title: 'Ship the small fix today?', options: YES_NO })
  c.a3 = await alpha.ask({ title: 'Which colour for the mark?', body: 'Three ways.', options: [{ key: 'ink', label: 'Ink' }, { key: 'green', label: 'Green', detail: 'as the brand' }, { key: 'gold', label: 'Gold' }], recommended: 'green' })
  c.a4 = await alpha.ask({ title: 'Which checks block a release?', multiple: true, options: [{ key: 'unit', label: 'Unit tests' }, { key: 'e2e', label: 'End to end' }, { key: 'lint', label: 'Lint' }] })
  c.b1 = await beta.ask({ title: 'Rotate the API keys now?', options: YES_NO })
  c.b2 = await beta.ask({ title: 'Send the weekly report?', options: YES_NO })
  c.b3 = await beta.ask({ title: 'Archive the old drafts?', options: YES_NO })
  c.b4 = await beta.ask({ title: 'Rename the branch?', options: YES_NO })
  c.b5 = await beta.ask({ title: 'Where should the export go?', options: [{ key: 's3', label: 'Bucket' }, { key: 'disk', label: 'Disk' }, { key: 'mail', label: 'Mail' }] })
  c.b6 = await beta.ask({ title: 'Hold this one for the phone?', options: YES_NO })
  c.b7 = await beta.ask({ title: 'And this one for the sheet?', options: YES_NO })
  await until('the hub knows the questions', () => watch.state?.cards.length === 11)
  const nr = id => card(id).number

  browser = await launchChromium({ width: 1440, height: 900 })
  page = await browser.page()
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  page.on('Runtime.exceptionThrown', p => pageErrors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text))
  await open('/')

  section('Moving the mark')
  check((await cur()) == null, 'no row is marked before a key is pressed')
  const order = await rowIds()
  await key('j')
  check((await cur())?.id === order[0], 'J marks the first row')
  check((await cur())?.focus, 'the marked row has the keyboard')
  await key('k')
  check((await cur())?.id === order[0], 'K at the top stays on the first row')
  await keys('j', 'ArrowDown')
  check((await cur())?.id === order[2], 'J and the arrow move down')
  await key('End')
  check((await cur())?.id === order.at(-1), 'End marks the last row')
  await key('Home')
  check((await cur())?.id === order[0], 'Home marks the first row')
  await key('j', { ctrl: true })
  check((await cur())?.id === order[0], 'Ctrl+J is not taken')
  check(await ev(`return getComputedStyle(document.querySelector('#desk-list .is-current')).outlineStyle === 'solid'`), 'the mark is drawn (css/keys.css is loaded)')

  section('The Trommi menu and jump')
  await key('k', { ctrl: true })
  check(await ev(`return !document.querySelector('#brand-doors').hidden && document.activeElement?.id === 'jump-field'`), 'Ctrl+K opens the menu with the keyboard in the jump field')
  check(await ev(`return ['#push-toggle', '#theme-toggle', '#menu-agents', '#keys-open', '#dev-open', '#dev-admin', '#desk-add', '.menu-desk[data-desk]'].every(s => document.querySelector('#brand-doors ' + s))`), 'the menu has desks, Agents, Keys, theme, push and the Dev items')
  await type('j')
  check((await cur())?.id === order[0], 'a key typed in a field moves nothing')
  await type('Bet')   // "jBet" finds nothing; clear and ask again
  await ev(`const f = document.querySelector('#jump-field'); f.value = 'Bet'; f.dispatchEvent(new Event('input', { bubbles: true }))`)
  await until('the hub renders the session into the jump frame', () => ev(`return [...document.querySelectorAll('#jump-results a')].some(a => a.getAttribute('href') === '/s/beta' && a.textContent.includes('Beta'))`))
  await ev(`const f = document.querySelector('#jump-field'); f.value = 'colour'; f.dispatchEvent(new Event('input', { bubbles: true }))`)
  await until('words of a title find the card', () => ev(`return document.querySelector('#jump-results a')?.getAttribute('href') === '/q/${nr(c.a3)}'`))
  await shot('menu-jump')
  await key('Escape')
  check(await ev(`return document.querySelector('#brand-doors').hidden`), 'Escape closes the menu')
  check((await cur())?.id === order[0], 'and leaves the mark where it was')
  await keys('g', 'j')
  check(await ev(`return !document.querySelector('#brand-doors').hidden && document.activeElement?.id === 'jump-field'`), 'G then J opens jump')
  await ev(`const f = document.querySelector('#jump-field'); f.value = '${nr(c.b5)}'; f.dispatchEvent(new Event('input', { bubbles: true }))`)
  await key('Enter')
  await until('Enter in the jump field goes to the card with that number', async () => (await where()) === `/q/${nr(c.b5)}`)
  await key('Escape')
  await until('Escape on a card page leads back to the Desk', async () => (await where()) === '/')
  await settled()
  await until('the mark is restored by the card id after the visit', async () => (await cur())?.id === order[0])

  section('Answering from the Desk')
  await markRow(c.a1)
  await key('y')
  await sleep(300)
  check(card(c.a1).status === 'open', 'Y answers nothing any more (card Nr. 200)')
  await click(`#row-${c.a1} .inbox-actions .inbox-answer.is-lead`)
  await until('the thumb up answers yes', () => card(c.a1).choice === 'yes')
  await until('the answered row leaves', async () => !(await rowIds()).includes(c.a1))
  await until('the mark is on the row that took its place', async () => (await cur())?.id === c.a2)
  const note = await until('the passing note says what happened', async () => { const s = await says(); return s?.text.includes('Answered') ? s : null })
  check(note && note.y < 120, `the note stands at the top (${Math.round(note?.x)}, ${Math.round(note?.y)})`)
  check(note?.back && note.text.includes('Keep the nightly job?'), 'it names the card and carries the way back')
  await shot('desk-mark-note')
  await key('u')
  await until('U takes the answer back', () => card(c.a1).status === 'open' && card(c.a1).choice == null)
  await until('the row is back', async () => (await rowIds()).includes(c.a1))
  check((await cur())?.id === c.a2, 'the mark stays on its card while the list changes')
  const memos = (watch.state.memos ?? []).length
  await key('n')
  await until('N opens a new note (memo)', () => (watch.state.memos ?? []).length === memos + 1)
  check(card(c.a2).status === 'open', 'and answers nothing')
  // (the note goes again, so that the rest of the run is not typed into it)
  for (const m of watch.state.memos ?? []) await fetch(`${base}/memos/${m.id}/bin`, { method: 'POST', headers: { cookie: `board_${port}=${token}`, Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'manual' })
  await until('the note is gone again', () => !(watch.state.memos ?? []).length)
  await open('/')
  await click(`#row-${c.a2} .inbox-actions button.inbox-answer:not(.is-lead)`)
  await until('the thumb down answers no', () => card(c.a2).choice === 'no')
  await settled()
  await markRow(c.b1)
  await key('l')
  await until('L snoozes the marked question', () => Boolean(card(c.b1).snoozed_until))
  await until('the note offers the way back from snooze', async () => (await says())?.text.includes('Snoozed'))
  await key('Backspace')
  await until('Backspace takes the snooze back', () => !card(c.b1).snoozed_until)
  await markRow(c.b2)
  await key('r')
  await until('R is Whatever: the agent decides', () => Boolean(card(c.b2).trusted))
  await markRow(c.b3)
  await key('b')
  await until('B hands the question back', () => card(c.b3).with_agent != null)
  await until('the note says so', async () => (await says())?.text.includes('Handed back'))
  await key('u')
  await until('U takes the hand-back back', () => card(c.b3).with_agent == null)
  await markRow(c.b4)
  await key('x')
  await until('X shreds the marked question', () => card(c.b4).status === 'shredded')

  section('The mark holds while the stream changes the page')
  await markRow(c.b3)
  const extra = await alpha.ask({ title: 'A question that arrives meanwhile?', options: YES_NO })
  await until('the new row arrives on the stream', async () => (await rowIds()).includes(extra))
  check((await cur())?.id === c.b3, 'the mark is still on its card')
  await alpha.call('revise_decision', { card_id: c.b3, title: 'Archive the old drafts, really?' }).catch(() => beta.call('revise_decision', { card_id: c.b3, title: 'Archive the old drafts, really?' })).catch(() => {})
  await sleep(500)
  check((await cur())?.id === c.b3, 'and after its own row was replaced')
  await key('Escape')
  check((await cur()) == null, 'Escape drops the mark')

  section('A card page')
  await markRow(c.a3)
  await key('Enter')
  await until('Enter opens the card on its own page', async () => (await where()) === `/q/${nr(c.a3)}`)
  await key('?')
  check(await ev(`const s = document.querySelector('#keys-sheet'); return s.open && s.textContent.includes('a new note') && s.textContent.includes('More keys later') && s.querySelectorAll('dl > div').length === 6`), '? shows the short list (arrows, Enter, Esc, N, L, ?)')
  check(await ev(`return getComputedStyle(document.querySelector('#keys-sheet'), '::backdrop').backgroundColor === 'rgba(0, 0, 0, 0)'`), 'the sheet has no veil')
  await key('2')
  check(card(c.a3).status === 'open', 'while the sheet is up, a key answers nothing')
  await shot('card-keys-sheet')
  await key('?')
  check(await ev(`return !document.querySelector('#keys-sheet').open`), '? closes the sheet')
  await key('2')
  await sleep(300)
  check(card(c.a3).status === 'open', '2 answers nothing any more (card Nr. 200)')
  await click('.tc-opt[data-key="green"]')
  await until('a click on the option answers', () => card(c.a3).choice === 'green')
  await until('and the Desk is there, with the note', async () => (await where()).startsWith('/') && (await says())?.text.includes('Answered'))
  await settled()
  await markRow(c.a4)
  await key('Enter')
  await until('the card with several answers opens', async () => (await where()) === `/q/${nr(c.a4)}`)
  await click('.tc-opt[data-key="unit"]')
  await click('.tc-opt[data-key="lint"]')
  check(await ev(`return [...document.querySelectorAll('.tc-opt input:checked')].map(i => i.value).join() === 'unit,lint'`), 'the two are ticked')
  await key('Enter')
  await until('Enter sends them', () => JSON.stringify(card(c.a4).choices) === '["unit","lint"]')
  await open(`/q/${nr(c.b5)}`)
  await key('a')
  check(await ev(`return document.activeElement?.classList.contains('tc-field')`), 'A puts the keyboard into the field')
  await type('3')
  check(card(c.b5).status === 'open' && card(c.b5).choice == null, 'a digit typed there answers nothing')
  await key('Escape')
  check(await ev(`return !document.activeElement?.classList.contains('tc-field')`) && (await where()) === `/q/${nr(c.b5)}`, 'Escape leaves the field first')
  await key('l')
  await until('L snoozes on the card page', () => Boolean(card(c.b5).snoozed_until))
  await open(`/q/${nr(c.b3)}`)
  await key('r')
  await until('R is Whatever on the card page', () => Boolean(card(c.b3).trusted))
  await open(`/q/${nr(c.b1)}`)
  await key('b')
  check(await ev(`return document.querySelector('.tc-revise')?.open && document.activeElement?.matches('textarea, input')`), 'B opens the line for what should change')
  await type('Bitte kürzer')
  await key('Enter')
  await until('Enter there hands it back from the card page', () => card(c.b1).with_agent != null)
  await open(`/q/${nr(c.b1)}`)
  await key('u')
  await until('U takes it back there', () => card(c.b1).with_agent == null)
  await keys('g', 'd')
  await until('G then D goes to the Desk', async () => (await where()) === '/')
  await settled()
  await key('Escape')   // (the mark came back with the Desk: drop it)

  section('Places, the sheet, the paper')
  await key('?')
  check(await ev(`const s = document.querySelector('#keys-sheet'); return s.open && s.textContent.includes('later (snooze)') && !s.textContent.includes('Whatever') && Boolean(s.querySelector('a[href="/help.html#keys"]'))`), '? on the Desk lists the Desk keys and leads to the whole table')
  await shot('desk-keys-sheet')
  await key('j')
  check((await cur()) == null, 'under the sheet J moves nothing')
  await key('Escape')
  check(await ev(`return !document.querySelector('#keys-sheet').open`), 'Escape closes the sheet')
  await ev(`window.__heard = []; for (const n of ['trommi:pen', 'trommi:cards']) document.addEventListener(n, () => window.__heard.push(n))`)
  await keys('w', 'w', 'p')
  check(await ev(`return window.__heard.join() === 'trommi:cards,trommi:cards,trommi:pen'`), 'W and P tell the paper (trommi:cards, trommi:pen)')
  await open('/')   // (the pen has the keyboard now: the page anew)
  await key('g')
  check(await ev(`const c = document.querySelector('.keys-pending'); return Boolean(c) && c.textContent.includes('Desk') && document.body.dataset.keys === 'g'`), 'after G a note says what may follow')
  await key('Escape')
  check(await ev(`return !document.querySelector('.keys-pending')`), 'Escape ends the sequence')
  await key('t')
  check(await ev(`return document.documentElement.dataset.theme === 'dark'`), 'T switches the theme')
  await key('t')
  await keys('d', '1')
  await until('D then 1 switches to the first desk', async () => ['/', '/?desk=main'].includes(await where()))
  await keys('g', 'a')
  await until('G then A goes to the Agents page', async () => (await where()).endsWith('/agents'))
  await open('/')
  await keys('g', '2')
  await until('G then 2 goes to the second session of the sidebar', async () => /\/s\/beta$/.test(await where()))
  await open('/')
  await key('.')
  await until('. goes to the next (first) session', async () => /\/s\/alpha$/.test(await where()))
  await open('/')
  await keys('g', 'f')
  await until('G then F starts the walk', async () => /^\/q\/\d+\?walk=1$/.test(await where()))

  section('The Agents page')
  await open('/agents')
  await key('ArrowDown')
  check(await ev(`return document.querySelector('#ledger-list .ledger-line.is-current')?.dataset.id === 'alpha'`), 'the arrow marks the first line')
  await key('j')
  check(await ev(`return document.querySelector('#ledger-list .ledger-line.is-current')?.dataset.id === 'beta'`), 'J moves to the next')
  await key('?')
  check(await ev(`const s = document.querySelector('#keys-sheet'); return s.open && s.querySelectorAll('dl > div').length === 6`), 'the Agents page has the same short list')
  await key('?')
  await key('r')
  check(await ev(`return Boolean(document.querySelector('#ledger-beta [data-ledger="rename"]')?.closest('details')?.open)`), 'R opens the rename of the marked line')
  await key('Escape')
  await key('c')
  await until('C crowns the marked session', () => Boolean(watch.state.agents.find(a => a.id === 'beta')?.starred))
  await keys('k', 'j')   // (Escape left the keyboard on the rename control, whose Enter is its own: back onto the line)
  await key('Enter')
  await until('Enter opens its conversation', async () => /\/s\/beta$/.test(await where()))

  section('The menu by hand')
  await open('/')
  await click('#brand-menu')
  check(await ev(`return !document.querySelector('#brand-doors').hidden`), 'a click on the pill opens the menu')
  check(await ev(`return document.querySelectorAll('dialog[open]').length === 0 && getComputedStyle(document.querySelector('#brand-doors')).position !== 'static'`), 'it is no dialog: nothing veils the page')
  check(await ev(`return !document.querySelector('#menu-dev').open && !document.querySelector('#dev-fake').checkVisibility()`), 'Dev is folded at first')
  await click('#dev-open')
  check(await ev(`return document.querySelector('#menu-dev').open && !document.querySelector('#brand-doors').hidden && document.querySelector('#dev-old[href="/old/"]').checkVisibility()`), 'a click on Dev unfolds it, and the menu stays')
  await shot('menu-open')
  const before = watch.state.cards.length
  await click('#dev-fake')
  await until('"Create 5 fake decisions" files five cards', () => watch.state.cards.length === before + 5)
  await until('and the menu closes', () => ev(`return document.querySelector('#brand-doors').hidden`))
  await settled()
  await click('#brand-menu')
  await until('the menu is open again', () => ev(`return !document.querySelector('#brand-doors').hidden`))
  await click('#keys-open')
  check(await ev(`return document.querySelector('#keys-sheet').open && document.querySelector('#brand-doors').hidden`), '"Keys" in the menu opens the sheet')
  await mouse(20, 880)
  check(await ev(`return !document.querySelector('#keys-sheet').open`), 'a click beside the sheet closes it')
  await click('#brand-menu')
  await until('the menu opens', () => ev(`return !document.querySelector('#brand-doors').hidden`))
  await click('#desk-add')
  check(await ev(`return document.activeElement?.classList.contains('menu-desk-field')`), '"+" opens a line for the new desk\'s name')
  await key('Escape')
  check(await ev(`return document.querySelector('#desk-new').hidden && !document.querySelector('#brand-doors').hidden`), 'Escape there drops the line and keeps the menu')
  await ev(`window.__dl = []; const d = document.querySelector('#brand-doors'); new MutationObserver(m => __dl.push('hidden->' + d.hidden + ' @' + new Error().stack.split('\\n').slice(2,5).join('|'))).observe(d, { attributes: true, attributeFilter: ['hidden'] }); for (const n of ['pointerdown','click','focusin','focusout','turbo:before-render','turbo:morph','turbo:before-stream-render']) document.addEventListener(n, e => __dl.push(n + ' ' + (e.target.id || e.target.className || e.target.tagName)), true); return 1`)
  await click('#desk-add')
  console.log('DBG-D', await ev(`return __dl.join('\\n')`))
  await type('Second <desk>')
  await key('Enter')
  await until('Enter makes the desk on the hub', () => watch.state.desks?.some(d => d.name === 'Second <desk>'))
  await until('and the board goes to it', async () => (await ev(`return document.querySelector('.menu-desk[aria-checked="true"] b')?.textContent`)) === 'Second <desk>')

  section('A phone: the long press')
  await open('/?desk=main', { width: 390, height: 844 })
  const at = await pointOf(`#row-${c.b6} .inbox-question`)
  await mouse(at.x, at.y, { hold: 700 })
  check(await ev(`const s = document.querySelector('#row-sheet'); return s.open && s.querySelector('h3').textContent === 'Hold this one for the phone?'`), 'a long press on a row brings up the sheet with its title')
  check((await where()) === '/', 'the press did not open the link')
  check(await ev(`return String(getSelection()) === ''`), 'and selected no text')
  check(await ev(`return getComputedStyle(document.querySelector('#row-sheet'), '::backdrop').backgroundColor === 'rgba(0, 0, 0, 0)'`), 'the sheet has no veil')
  check(await ev(`return [...document.querySelectorAll('#row-sheet button[data-way]:not([hidden])')].map(b => b.dataset.way).join() === 'snooze,revise,trust,what,shred' && document.querySelector('#row-sheet .rowmenu-open').getAttribute('href').endsWith('/q/${nr(c.b6)}')`), 'it offers Snooze, Revise, Whatever, What??, Shred and Open for that card')
  await shot('phone-sheet')
  await key('Escape')
  check(await ev(`return !document.querySelector('#row-sheet').open`), 'Escape closes it')
  await sleep(400)
  await mouse(at.x, at.y, { hold: 700 })
  check(await ev(`return document.querySelector('#row-sheet').open`), 'a second long press brings it up again')
  await mouse(195, 40)
  check(await ev(`return !document.querySelector('#row-sheet').open`) && (await where()) === '/', 'a tap beside it closes it, and nothing else happens')
  await sleep(400)
  await mouse(at.x, at.y, { hold: 700 })
  check(await ev(`return document.querySelector('#row-sheet').open`), 'and a third')
  await sheetUp()
  await click('#row-sheet button[data-way="snooze"]')
  await until('Snooze on the sheet snoozes that card', () => Boolean(card(c.b6).snoozed_until))
  check(await ev(`return !document.querySelector('#row-sheet').open`), 'and the sheet is gone')
  const at2 = await pointOf(`#row-${c.b7} .inbox-question`)
  await mouse(at2.x, at2.y, { hold: 700 })
  check(await ev(`return document.querySelector('#row-sheet').open && document.querySelector('#row-sheet h3').textContent === 'And this one for the sheet?'`), 'the sheet is pointed at the next row that is held')
  await sheetUp()
  await click('#row-sheet button[data-way="revise"]')
  await until('Revise on the sheet hands that card back', () => card(c.b7).with_agent != null)
  const at3 = await pointOf('#desk-list .inbox-row .inbox-question')
  await mouse(at3.x, at3.y)
  await until('a short tap on a title still opens the card', async () => /^\/q\/\d+$/.test(await where()))

  check(pageErrors.length === 0, `no script error on the pages: ${pageErrors.slice(0, 3).join(' | ')}`)
}

try {
  await main()
} catch (err) {
  failures.push(`the test broke off: ${err.stack ?? err}`)
  console.log(`  FAIL  the test broke off: ${err.stack ?? err}`)
  if (hubLog.trim()) console.log(`hub: ${hubLog.trim().split('\n').slice(-5).join('\n')}`)
}
console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `:\n- ${failures.join('\n- ')}` : ''}`)
await stop(failures.length ? 1 : 0)
