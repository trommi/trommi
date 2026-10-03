// The keyboard, tried with real key events in headless Chromium against a board of its own.
//   node dev/keys-test.mjs [PORT] [OUT_DIR]      default port 8884, screenshots into OUT_DIR (default $TMPDIR/keys-test)
// Starts a hub on PORT (never 8790 or 8795) with three sessions and a set of questions, drives
// the page by keys only, and checks the board's own state after every answer.
// Needs the command sandbox disabled, like dev/cdp.mjs. Exit code 1 when a check fails.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchChromium, guard } from './cdp.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.argv[2] || 8884)
const out = process.argv[3] || path.join(os.tmpdir(), 'keys-test')
if (port === 8790 || port === 8795) throw new Error('that port belongs to a board in use')
fs.mkdirSync(out, { recursive: true })
const token = 'demo'
const base = `http://127.0.0.1:${port}`
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---- the board ---------------------------------------------------------------

// A hub left over from an earlier run on the same port would answer instead of ours, with its questions on top
// of these (the inbox then lists every row twice): refuse to start beside it.
await new Promise((resolve, reject) => {
  const probe = http.get(`${base}/`, res => { res.resume(); reject(new Error(`port ${port} is already in use (an earlier run still going?); pass another port`)) })
  probe.on('error', resolve)
  probe.setTimeout(1500, () => { probe.destroy(); resolve() })
})
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keys-test-data-'))
const hub = spawn('node', [path.join(ROOT, 'server', 'server.mjs')], {
  env: { ...process.env, BOARD_PORT: String(port), BOARD_HOST: '127.0.0.1', BOARD_TOKEN: token, BOARD_DATA: dataDir, BOARD_HUB_ONLY: '1', BOARD_AGENT: '' },
  stdio: ['pipe', 'ignore', 'pipe'],
})
guard(hub, { dirs: [dataDir] })   // (stopped with the test, however the test ends: dev/cdp.mjs)
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
/** A session held online the way dev/session.mjs does it. Returns { id, call(tool, args), ask(card) -> card id }. */
async function session(name) {
  const id = slug(name)
  const query = new URLSearchParams({ name, id, instance: instanceOf(id), cwd: ROOT, host: 'keys-test', platform: 'test' })
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

/** The board's state as the page gets it, kept current. */
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
const pendingNotes = []
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
const CODES = { Enter: 13, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, Tab: 9, ' ': 32, Backspace: 8, '?': 191, ',': 188, '.': 190 }
async function key(name, { shift = false, ctrl = false, pause = 110 } = {}) {
  const code = CODES[name] ?? name.toUpperCase().charCodeAt(0)
  const text = name === 'Enter' ? '\r' : name.length === 1 ? name : undefined
  const event = { key: name, code: name === ' ' ? 'Space' : name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: (shift ? 8 : 0) | (ctrl ? 2 : 0) }
  await page.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...event, ...(text ? { text } : {}) })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
  await sleep(pause)
}
const keys = async (...names) => { for (const n of names) await key(n) }
/** A real click at the middle of the element an expression names. */
let lastClick = null
async function click(expression) {
  if (!(await ev(`return Boolean(${expression})`))) { check(false, `nothing to click: ${expression.slice(0, 80)}`); return null }
  await ev(`const n = ${expression}; if (!__k.inSight(n)) n.scrollIntoView({ block: 'center' })`)
  await sleep(80)
  const at = await ev(`return __k.point(${expression})`)
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y })
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 })
  await sleep(120)
  lastClick = at
  return at
}
const type = text => page.send('Input.insertText', { text })
async function ev(js) {
  const res = await page.send('Runtime.evaluate', { expression: `(() => { ${js} })()`, awaitPromise: true, returnByValue: true })
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text)
  return res.result?.value
}
async function shot(name) {
  await sleep(450)
  const img = await page.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(img.data, 'base64'))
}
async function open(url, { width = 1440, height = 900, dark = false } = {}) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
  await page.send('Page.navigate', { url: `${base}${url}${url.includes('?') ? '&' : '?'}t=${token}${dark ? '#dark' : '#light'}` })
  await sleep(1800)
  await ev(HELPERS)
}
// What the checks ask the page, in one place.
const HELPERS = `
  window.__k = {
    box: n => { const r = n.getBoundingClientRect(); return { x: r.left, y: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height } },
    list: () => [...document.querySelectorAll('.inbox-groups')].find(n => n.getClientRects().length),
    rows: () => [...(__k.list()?.querySelectorAll('.inbox-row:not(.is-leaving)') ?? [])],
    reach: () => __k.rows().filter(n => !n.closest('.inbox-pile:not(.is-open)')),
    done: () => [...(__k.list()?.querySelectorAll(':is([data-pile="works"], [data-pile="done"]) .inbox-done[data-kind="answered"]') ?? [])].map(n => ({ id: n.dataset.id, text: n.innerText.replace(/\\s+/g, ' '), h: Math.round(n.getBoundingClientRect().height), current: n.classList.contains('is-current') })),
    row: id => __k.rows().find(n => n.dataset.id === id),
    cur: () => { const n = __k.list()?.querySelector('.inbox-row.is-current, .inbox-done.is-current'); return n ? { id: n.dataset.id, y: Math.round(n.getBoundingClientRect().top), later: 'later' in n.dataset, done: n.classList.contains('inbox-done'), open: n.classList.contains('is-open'), focus: document.activeElement === n } : null },
    inView: n => { const b = n.closest('main, .pane-list').getBoundingClientRect(), r = n.getBoundingClientRect(); return r.top >= b.top - 1 && r.bottom <= b.bottom + 1 },
    back: () => { const n = [...document.querySelectorAll('.says')].find(b => b.getClientRects().length); return n ? { text: n.innerText.replace(/\\s+/g, ' '), box: __k.box(n), host: n.parentElement.className, button: Boolean(n.querySelector('.says-back')) } : null },
    inSight: n => { const r = n.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight - 60 },
    among: (id, mates) => { const g = __k.row(id)?.closest('.inbox-group:not(.inbox-pile)'); return Boolean(g) && mates.some(m => g.contains(__k.row(m))) },
    point: n => { const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } },
    hits: (a, b) => a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b,
    active: () => { const a = document.activeElement; return a ? { tag: a.tagName, cls: String(a.className), text: (a.innerText ?? '').slice(0, 40), label: a.getAttribute('aria-label') } : null },
    front: () => document.querySelector('.focus:not([hidden]) .focus-card[data-shown]'),
    frontTitle: () => __k.front()?.querySelector('h2, .focus-title')?.textContent ?? null,
  }
`
const cur = () => ev('return __k.cur()')
const back = () => ev('return __k.back()')
/** Move the mark to a card with J (from wherever it is; Home first). */
async function markRow(id) {
  await key('Home')
  for (let i = 0; i < 60; i++) {
    if ((await cur())?.id === id) { await sleep(450); return true }   // let the list come to rest
    await key('j', { pause: 40 })
  }
  return check(false, `J does not reach the row of card ${id}`)
}

// ---- the run -----------------------------------------------------------------

const YES_NO = [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }]
async function main() {
  for (let i = 0; i < 80; i++) { if (await fetch(`${base}/`).then(r => r.status === 401, () => false)) break; await sleep(100) }
  const watch = await watchState()
  const card = id => watch.state.cards.find(c => c.id === id)
  const alpha = await session('Alpha'), beta = await session('Beta'), gamma = await session('Gamma')
  for (const s of [alpha, beta, gamma]) await s.call('introduce', { model: 'none', task: `Questions of ${s.id} for the keyboard test` })
  const c = {}
  c.a1 = await alpha.ask({ title: 'Keep the nightly job?', options: YES_NO, recommended: 'yes' })
  c.a2 = await alpha.ask({ title: 'Ship the small fix today?', options: [{ key: 'ship', label: 'Ship it' }, { key: 'hold', label: 'Hold back' }] })
  c.a3 = await alpha.ask({ title: 'Which colour for the mark?', body: 'Three ways.', options: [{ key: 'ink', label: 'Ink' }, { key: 'green', label: 'Green', detail: 'as the brand' }, { key: 'gold', label: 'Gold' }], recommended: 'green' })
  c.a4 = await alpha.ask({ title: 'Which checks block a release?', body: 'Pick every check that should block a release.', multiple: true, options: [{ key: 'unit', label: 'Unit tests' }, { key: 'e2e', label: 'End to end' }, { key: 'lint', label: 'Lint' }] })
  c.b1 = await beta.ask({ title: 'Rotate the API keys now?', options: YES_NO })
  c.b2 = await beta.ask({ title: 'Send the weekly report?', options: YES_NO })
  c.b3 = await beta.ask({ title: 'How should the export run?', body: 'Two ways to run it, or not at all.', options: [{ key: 'now', label: 'Now' }, { key: 'night', label: 'Tonight' }, { key: 'never', label: 'Not at all' }] })
  c.b4 = await beta.ask({ title: 'Raise the rate limit?', options: YES_NO })
  c.b5 = await beta.ask({ title: 'Which region hosts the mirror?', body: 'Seven places to choose from.', options: ['Frankfurt', 'Paris', 'Dublin', 'Milan', 'Warsaw', 'Madrid', 'Oslo'].map(label => ({ key: label.toLowerCase(), label })) })
  c.g1 = await gamma.ask({ title: 'Shut the staging server down at night?', options: YES_NO, urgency: 'high', urgency_reason: 'it costs money every night' })
  c.g2 = await gamma.ask({ title: 'Renew the certificate?', options: YES_NO })
  c.g3 = await gamma.ask({ title: 'Archive the old logs?', options: YES_NO })
  c.g4 = await gamma.ask({ title: 'Move the backups to cold storage?', options: YES_NO })
  // Six more, for the four ways out of a question that are no answer.
  for (const [k, title] of [['x1', 'Snooze me?'], ['x2', 'Revise me?'], ['x3', 'Whatever me?'], ['x4', 'Shred me?'], ['x5', 'Whatever me in the list?'], ['x6', 'Shred me in the list?']]) c[k] = await alpha.ask({ title, options: YES_NO, recommended: 'yes' })
  await sleep(300)

  browser = await launchChromium({ width: 1440, height: 900 })
  page = await browser.page()
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  page.on('Runtime.exceptionThrown', p => pageErrors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text))
  page.on('Runtime.consoleAPICalled', p => { if (p.type === 'error') pageErrors.push(p.args.map(a => a.value ?? a.description).join(' ')) })

  // ---------------------------------------------------------------------------
  section('Inbox: moving between questions')
  await open('/')
  const ids = await ev('return __k.rows().map(n => n.dataset.id)')
  check(ids.length === 19, `the inbox lists 19 rows, found ${ids.length}`)
  check(!(await cur()), 'no row is marked before a key is pressed')
  await key('y')
  check((await cur())?.id === ids[0], 'with no mark, Y marks the first row')
  check(card(ids[0]).status === 'open', 'with no mark, Y answers nothing')
  check((await cur())?.focus, 'the marked row holds the keyboard focus')
  await key('j')
  check((await cur())?.id === ids[1], 'J moves the mark down')
  await key('ArrowDown')
  check((await cur())?.id === ids[2], 'the down arrow moves the mark down')
  await key('k')
  await key('ArrowUp')
  check((await cur())?.id === ids[0], 'K and the up arrow move it up')
  await shot('01-marked')
  await ev('__k.first = __k.list().querySelector(".is-current").closest(".inbox-group")')
  const groupOf = 'return __k.list().querySelector(".is-current").closest(".inbox-group") === __k.first'
  const firstGroup = true
  let crossed = false
  for (let i = 0; i < 18; i++) {
    await key('j', { pause: 260 })
    check(await ev('return __k.inView(__k.list().querySelector(".is-current"))'), `row ${i + 2} is wholly in view when J reaches it`)
    if (await ev(groupOf) !== firstGroup) crossed = true
  }
  check(crossed, 'J crosses from one sender group into the next')
  check((await cur())?.id === ids.at(-1), 'J ends on the last row')
  await key('Home', { pause: 500 })
  check((await cur())?.id === ids[0] && await ev('return document.querySelector("#inbox").scrollTop') === 0, 'Home marks the first row and shows the top of the page')
  await key('End', { pause: 500 })
  check((await cur())?.id === ids.at(-1) && await ev('return __k.inView(__k.list().querySelector(".is-current"))'), 'End marks the last row, in view')
  await key('Escape')
  check(!(await cur()), 'Escape drops the mark')

  // ---------------------------------------------------------------------------
  section('Inbox: answer, the mark stays, Back')
  await markRow(c.b1)
  const below = (await ev('return __k.rows().map(n => n.dataset.id)'))
  const next = below[below.indexOf(c.b1) + 1]
  const before = await cur()
  const tilesBefore = await ev(`return __k.box(__k.row(${JSON.stringify(c.b1)}).querySelector('.inbox-actions'))`)
  await key('y')
  await until('Y answers yes on the board', () => card(c.b1).status !== 'open' && card(c.b1).choice === 'yes')
  await until('the answered row leaves', () => ev(`return !__k.row(${JSON.stringify(c.b1)})`))
  await sleep(450)
  const after = await cur()
  check(after?.id === next, 'the mark is on the row that moved up')
  check(Math.abs((after?.y ?? 0) - before.y) <= 1, `the marked row stands where the answered one stood (${before.y} -> ${after?.y})`)
  const tag = await back()
  if (check(Boolean(tag), 'a note says what happened')) {
    check(/Answered: Yes/.test(tag.text) && /Rotate the API keys now\?/.test(tag.text) && tag.button, `the note names the answer and the question, and carries Back ("${tag.text}")`)
    const main = await ev('return __k.box(document.querySelector("#inbox"))')
    const place = await ev(`return __k.box(__k.row(${JSON.stringify(next)}).querySelector('.inbox-actions'))`)
    check(tag.box.r <= place.x && place.x - tag.box.r < 40 && tag.box.y >= place.y - 8 && tag.box.b <= place.b + 8, `answered by key, the note stands directly left of the marked row's tiles (note ${Math.round(tag.box.x)}..${Math.round(tag.box.r)} x ${Math.round(tag.box.y)}..${Math.round(tag.box.b)}, tiles from ${Math.round(place.x)}, ${Math.round(place.y)}..${Math.round(place.b)})`)
    const tilesNow = await ev(`return __k.box(__k.row(${JSON.stringify(next)}).querySelector('.inbox-actions'))`)
    check(!(await ev(`return __k.rows().some(r => __k.hits(${JSON.stringify(tag.box)}, __k.box(r.querySelector('.inbox-actions'))))`)), 'the note covers no answer tiles')
    check(Math.abs(tilesNow.x - tilesBefore.x) < 1 && Math.abs(tilesNow.y - tilesBefore.y) < 1, 'the next row\'s tiles are where the answered row\'s tiles were')
  }
  await shot('02-back-in-list')
  await key('u')
  await until('U takes the answer back on the board', () => card(c.b1).status === 'open')
  await until('the question is marked again', async () => (await cur())?.id === c.b1)
  check(!(await back()), 'the note is gone after Back was used')
  // The tag leaves by itself; the key works a little longer.
  await key('n')
  await until('N answers no', () => card(c.b1).choice === 'no' && card(c.b1).status !== 'open')
  await until('the note is shown', back)
  await sleep(5300)
  check(!(await back()), 'the note leaves by itself after about five seconds')
  await key('Backspace')
  await until('Backspace still takes the answer back after the note has left', () => card(c.b1).status === 'open')
  await until('and the question is marked again', async () => (await cur())?.id === c.b1)
  check(await ev('return __k.inView(__k.list().querySelector(".is-current"))'), 'the question that came back is in view')

  await keys('ArrowRight', 'ArrowLeft')
  await sleep(300)
  check(card(c.b1).status === 'open' && (await cur())?.id === c.b1, 'the left and right arrows answer nothing on a yes/no row')
  // The same by hand: a real click on the thumb, a real click on Back.
  await click(`__k.row(${JSON.stringify(c.b1)}).querySelectorAll('.inbox-answer.is-thumb')[1]`)
  await until('a click on the thumb up answers yes', () => card(c.b1).status !== 'open' && card(c.b1).choice === 'yes')
  const pressed = await until('the note is shown', back)
    const tilesNow = await ev('return __k.rows().map(r => __k.box(r.querySelector(".inbox-actions")))')
    const hand = lastClick
    check(pressed && pressed.box.r <= Math.min(...tilesNow.map(t => t.x)) && Math.min(...tilesNow.map(t => t.x)) - pressed.box.r < 40 && pressed.box.y <= hand.y && pressed.box.b >= hand.y, `answered by click, the note stands left of the tiles at the height of the pointer (pointer ${Math.round(hand.x)},${Math.round(hand.y)}; note ..${Math.round(pressed?.box.r)} x ${Math.round(pressed?.box.y)}..${Math.round(pressed?.box.b)})`)
    await shot('02b-back-beside-click')
  await sleep(450)   // a new note lets taps through for a moment, so a fast second tap cannot hit Back
  await click('document.querySelector(".says-back")')
  await until('a click on Back takes the answer back', () => card(c.b1).status === 'open')
  await until('the question is back in its group, and marked', async () => (await cur())?.id === c.b1 && await ev(`return __k.among(${JSON.stringify(c.b1)}, ${JSON.stringify([c.b2, c.b3, c.b4, c.b5])})`))

  // ---------------------------------------------------------------------------
  section('Inbox: later, choices, several answers')
  await markRow(c.b2)
  const y0 = (await cur()).y
  await key('l')
  // (A snoozed card is no row any more: it is a slim line on the stack "Later" at the foot.)
  await until('L puts the row off', () => ev(`return !__k.row(${JSON.stringify(c.b2)}) && Boolean(__k.list().querySelector('[data-pile="later"]'))`))
  await sleep(450)
  const afterLater = await cur()
  check(Math.abs(afterLater.y - y0) <= 1 && afterLater.id !== c.b2, `after L the mark stays in place, on the row that moved up (${y0} -> ${afterLater.y}, ${afterLater.id === c.b2 ? 'same row' : 'next row'})`)
  check(/Snoozed/.test((await back())?.text ?? ''), 'a note says "Snoozed"')
  await shot('03-moved-to-later')
  // What was put off lies in a pile at the foot of the list. J goes on from the last row to the pile's line; Enter unfolds it.
  check(await ev(`return Boolean(__k.row(${JSON.stringify(c.b2)})) || Boolean(__k.list().querySelector('.inbox-group-later'))`), 'a "Later" pile stands at the foot of the list')
  await key('End', { pause: 500 })
  await key('j')
  check((await ev('return __k.active()')).cls.includes('inbox-pile-head') && !(await cur()), 'J past the last row goes to the line of the pile')
  await key('Enter', { pause: 600 })
  check(await ev('return Boolean(__k.list().querySelector(".inbox-group-later.is-open"))'), 'Enter unfolds the pile')
  await key('j', { pause: 400 })
  { const at = await cur(); check(at?.id === c.b2 && at.later, `J then marks the row that was put off (${at?.id === c.b2 ? 'it' : 'another row'}, later ${at?.later})`) }
  await key('k')
  await key('j')
  check((await cur())?.id === c.b2, 'K and J move between the rows above and the unfolded pile')
  await shot('03b-later-group')
  // On a snoozed line L does nothing; U wakes it, and it is a row among the open ones again.
  await key('l', { pause: 500 })
  check(Boolean(card(c.b2).snoozed_until) && !(await ev(`return Boolean(__k.row(${JSON.stringify(c.b2)}))`)), 'L does nothing on a snoozed line')
  await key('u')
  await until('U on a snoozed line wakes it', () => ev(`return Boolean(__k.row(${JSON.stringify(c.b2)}))`) .then(there => there && !card(c.b2).snoozed_until))

  // A row never unfolds in place: Enter and C open the card's own page, where the options stand.
  const closeCard = async () => { for (let i = 0; i < 3 && await ev('return Boolean(__k.front())'); i++) await key('Escape', { pause: 400 }) }
  await markRow(c.a3)
  await key('Enter', { pause: 700 })
  check(await ev('return __k.frontTitle()') === 'Which colour for the mark?', 'Enter opens the marked row\'s card on its own page')
  check(!(await ev('return Boolean(document.querySelector(".inbox-row.is-open, .inbox-more, .inbox-inline"))')), 'no row of the Desk unfolds in place')
  await shot('04-choices-open')
  await closeCard()
  check(!(await ev('return Boolean(__k.front())')), 'Escape goes back to the Desk')
  await markRow(c.a3)
  await key('c', { pause: 700 })
  await key('3')
  await until('a digit picks that option', () => card(c.a3).choice === 'gold')
  await until('the page closes on the answer', () => ev('return !__k.front()'))
  await key('u')
  await until('U takes it back', () => card(c.a3).status === 'open')

  await markRow(c.a4)
  await key('c', { pause: 700 })
  await key('1')
  await key('3')
  check(JSON.stringify(await ev('return [...__k.front().querySelectorAll(".focus-opts .focus-opt[aria-pressed]")].map(b => b.getAttribute("aria-pressed"))')) === '["true","false","true"]', 'digits tick the options (first and third)')
  await key('2')
  await key('2')
  check(card(c.a4).status === 'open', 'ticking answers nothing yet')
  await shot('05-several')
  await key('Enter')
  await until('Enter sends the picked options together', () => card(c.a4).status !== 'open' && card(c.a4).choices?.join() === 'unit,lint')
  await until('the page closes on the answer', () => ev('return !__k.front()'))
  await key('u')
  await until('U takes it back', () => card(c.a4).status === 'open')

  // ---------------------------------------------------------------------------
  section('Inbox: ask back and Explain by key, keys rest in a field')
  await markRow(c.b3)
  await key('a', { pause: 700 })
  const field = await ev('return __k.active()')
  check(field.tag === 'TEXTAREA' && Boolean(await ev('return Boolean(__k.front())')), 'A opens the card\'s page and puts the caret into its field')
  await type('yn l')
  await sleep(150)
  check(card(c.b3).status === 'open' && !card(c.b3).snoozed_until, 'letters typed in the field answer nothing and put nothing off')
  await closeCard()
  check(!(await ev('return Boolean(__k.front())')), 'Escape leaves the field, then the card')

  await markRow(c.a3)
  await key('e', { pause: 700 })
  check(await ev('return __k.frontTitle()') === 'Which colour for the mark?' && !watch.state.messages.some(m => m.card_id === c.a3 && m.from === 'user'), 'E on a row opens the card\'s page and asks nothing')
  await key('e', { pause: 600 })
  await until('E in the opened card asks the session to explain', () => watch.state.messages.some(m => m.card_id === c.a3 && m.from === 'user' && /^Explain this question/.test(m.text)))
  // A card asked to explain waits for the session, not for the human: it leaves the desk for the slim list
  // "With the agent" (inbox.js, .inbox-revising), not for the Snooze pile.
  await closeCard()
  await until('and the row goes to the list "With the agent"', () => ev(`return !__k.row(${JSON.stringify(c.a3)}) && Boolean(__k.list()?.querySelector('.inbox-revising-row[data-id=${JSON.stringify(c.a3)}]'))`))
  await shot('06-asked-to-explain')
  await alpha.call('reply', { text: 'Green is the brand colour; ink reads best; gold is for VIP only. I would take green.', card_id: c.a3, present: true })
  await until('the session\'s reply brings the row back to the desk', () => ev(`return Boolean(__k.row(${JSON.stringify(c.a3)})) && !('later' in __k.row(${JSON.stringify(c.a3)}).dataset)`), 6000)
  // A card too large for a row opens as a window; there Explain closes the window.
  await markRow(c.b5)
  await key('Enter', { pause: 700 })
  check(await ev('return __k.frontTitle()') === 'Which region hosts the mirror?', 'Enter opens a large question as a window')
  // In the opened card E asks the session to explain at once (what stands in the field would go along as the question).
  await key('e', { pause: 600 })
  await until('E in the opened card asks the session to explain, at once', () => watch.state.messages.some(m => m.card_id === c.b5 && m.from === 'user'))
  check(watch.state.messages.some(m => m.card_id === c.b5 && m.from === 'user' && m.explain), 'the message carries the explain flag')
  check(card(c.b5).status === 'open', 'and the question stays open')
  for (let i = 0; i < 3 && await ev('return Boolean(__k.front())'); i++) await key('Escape', { pause: 400 })
  check(!(await ev('return Boolean(__k.front())')), 'Escape closes the card')

  // ---------------------------------------------------------------------------
  section('Inbox: the Answered group')
  // An answered question lies on the stack "In the works" until its session closes it, then on "Done"; both offer
  // "Take back". While the Desk lists nothing answered (it was taken out
  // and is to come back), these checks wait: one line says so instead of failing.
  await markRow(c.g3)
  await key('y')
  await until('Y answers', () => card(c.g3).status !== 'open')
  await sleep(600)
  const pileThere = await ev('return Boolean(__k.list().querySelector(\'[data-pile="works"] [data-kind="answered"]\'))')
  await key('u')
  await until('U takes it back', () => card(c.g3).status === 'open')
  if (!pileThere) { pendingNotes.push('the Desk shows no "Answered" pile: its checks (unfold, Take back by key and by click) were skipped'); console.log('  ~ pending: no "Answered" pile on the Desk') } else {
    check(!(await ev('return Boolean(__k.list().querySelector(\'[data-kind="answered"]\'))')), 'with nothing answered no stack holds an answered line')
    await markRow(c.g2)
    await key('y')
    await until('Y answers', () => card(c.g2).status !== 'open')
    await until('the stack "In the works" stands below the open rows, folded', () => ev('const g = __k.list().querySelector(\'[data-pile="works"]\'); return Boolean(g) && !g.classList.contains("is-open") && Boolean(g.compareDocumentPosition(__k.reach().at(-1)) & Node.DOCUMENT_POSITION_PRECEDING) && /In the works/.test(g.textContent)'))
    await sleep(5300)   // the note has left: this is the wrong answer that is noticed later
    await click('__k.list().querySelector(".inbox-works-toggle")')
    const listed = await ev('return __k.done()')
    if (check(listed.length === 1 && listed[0].id === c.g2, 'a click unfolds it: one slim row for the answered question')) {
      check(/Renew the certificate\?/.test(listed[0].text) && /Yes/.test(listed[0].text) && /Gamma/.test(listed[0].text) && /Take back/.test(listed[0].text), `the row says what was asked, what was answered and who asked ("${listed[0].text}")`)
      check(listed[0].h < 100, `the row is slimmer than a question row (${listed[0].h}px)`)
    }
    await key('End', { pause: 500 })
    check((await cur())?.done && (await cur()).id === c.g2, 'End reaches the answered row')
    await shot('06b-answered-group')
    await keys('y', 'n', 'l', 'e', 'Enter', 'a')
    await sleep(300)
    check(card(c.g2).status !== 'open' && !(await ev('return Boolean(__k.front())')), 'the answer keys do nothing on an answered row')
    await key('u')
    await until('U on the marked answered row takes the answer back', () => card(c.g2).status === 'open')
    await until('the question stands in its group again, marked', async () => { const at = await cur(); return at?.id === c.g2 && !at.done && await ev(`return __k.among(${JSON.stringify(c.g2)}, ${JSON.stringify([c.g1, c.g3, c.g4])})`) })
    // The same by hand, on a card the agent has closed since.
    await key('n')
    await until('N answers', () => card(c.g2).status !== 'open')
    await gamma.call('close_card', { card_id: c.g2, summary: 'Left as it is.' })
    await until('the row says the agent has closed it', () => ev('return __k.done().some(d => /done by the agent/i.test(d.text))'))
    await sleep(700)   // the rows have come to rest
    // (Closed by its session, the card has moved from "In the works" to the stack "Done".)
    check(await ev(`return Boolean(__k.list().querySelector('[data-pile="done"] .inbox-done[data-id="${c.g2}"]')) && !__k.list().querySelector('[data-pile="works"] .inbox-done[data-id="${c.g2}"]')`), 'a card its session closed lies on the stack "Done", not on "In the works"')
    if (!(await ev('return Boolean(__k.list().querySelector(\'[data-pile="done"].is-open\'))'))) { await click('__k.list().querySelector(".inbox-done-toggle")'); await sleep(500) }
    await click('__k.list().querySelector(\'[data-pile="done"] .inbox-takeback\')')
    await until('a click on "Take back" reopens it all the same', () => card(c.g2).status === 'open')
    await until('and the question stands in its group again, marked', async () => (await cur())?.id === c.g2 && !(await cur()).done)
    await key('Escape')
  }

  // ---------------------------------------------------------------------------
  section('The sheet behind "?"')
  await key('?', { shift: true, pause: 300 })
  const sheet = await ev('const d = document.querySelector("dialog.keys-sheet"); return d?.open ? { groups: [...d.querySelectorAll("h3")].map(h => h.textContent), rows: d.querySelectorAll("dl > div").length, text: d.innerText } : null')
  if (check(Boolean(sheet), '"?" opens the sheet')) {
    check(sheet.groups.includes('Anywhere') && sheet.groups.includes('A list of questions') && !sheet.groups.includes('In a session'), `in the inbox it lists the keys of the inbox (${sheet.groups.join(', ')})`)
    check(/back/i.test(sheet.text) && !/undo/i.test(sheet.text), 'it says "back", not "undo"')
  }
  await shot('07-sheet-inbox')
  const answered = watch.state.cards.filter(x => x.status !== 'open').length
  await keys('y', 'j', 'l')
  check(watch.state.cards.filter(x => x.status !== 'open').length === answered, 'under the sheet the keys rest')
  await key('?', { shift: true, pause: 300 })
  check(!(await ev('return document.querySelector("dialog.keys-sheet").open')), '"?" closes it again')

  // ---------------------------------------------------------------------------
  section('Going places')
  await keys('g', 'a')
  await until('G then A opens the agents', () => ev('return location.pathname === "/agents"'))
  await key('g')
  check(await ev('return !document.querySelector(".keys-pending").hidden && document.body.dataset.keys === "g"'), 'after G a notice lists where to go')
  await shot('08-g-pending')
  await key('i')
  await until('G then I opens the inbox', () => ev('return location.pathname === "/"'))
  // [ folds the sidebar to a rail on a wide screen, and opens it again.
  await key('[', { pause: 300 })
  check(await ev('return document.documentElement.dataset.rail === "folded"'), '[ folds the sidebar to a rail')
  await key('[', { pause: 300 })
  check(await ev('return document.documentElement.dataset.rail !== "folded"'), '[ again opens the sidebar')
  await keys('g', '1')
  if (!(await until('G then 1 opens the first session', () => ev('return location.pathname === "/s/alpha"')))) console.log('     ', JSON.stringify(await ev('return { path: location.pathname, places: [...document.querySelectorAll("#agents .agent-entry")].map(n => n.innerText.replace(/\\s+/g, " ").slice(0, 20)), pending: document.body.dataset.keys ?? null, active: document.activeElement.tagName + "." + document.activeElement.className, dialogs: document.querySelectorAll("dialog[open]").length }')))
  await sleep(400)
  check((await ev('return __k.active()')).tag !== 'TEXTAREA', 'arriving by key leaves the keys in charge (the caret is not in the composer)')
  await key('.')
  await until('"." goes to the next session', () => ev('return location.pathname === "/s/beta"'))
  await key(',')
  await until('"," goes to the previous session', () => ev('return location.pathname === "/s/alpha"'))
  if (await ev('return document.querySelector("#filter-questions").getClientRects().length > 0')) {
  await key('q')
    await until('Q filters to the questions', () => ev('return location.pathname === "/s/alpha/questions"'))
    await key('j')
    check((await cur())?.id === c.a1, 'in "Questions only" J marks the session\'s first question')
    await shot('09-questions-only')
    await key('Escape')
    await key('q')
    await until('Q again shows the whole conversation', () => ev('return location.pathname === "/s/alpha"'))
  } else {
    await key('q')
    check(await ev('return location.pathname === "/s/alpha"'), 'Q does nothing where "Questions only" is not offered')
  }
  await key('f')
  await until('F shows the files', () => ev('return location.pathname === "/s/alpha/files"'))
  await key('f')
  await key('s', { pause: 900 })
  await until('S opens the scribble', () => ev('return location.pathname === "/s/alpha/scribble"'))
  await key('s')
  await until('S goes back to the conversation', () => ev('return location.pathname === "/s/alpha"'))
  await key('r')
  check((await ev('return __k.active()')).tag === 'TEXTAREA', 'R puts the caret into the composer')
  await type('gq.t hello from the keys')
  await sleep(100)
  check(await ev('return location.pathname === "/s/alpha" && document.documentElement.dataset.theme !== "dark"'), 'letters typed in the composer go nowhere else')
  // Plain Enter sends where the pointer is fine; headless Chromium reports none, so the test uses the chord that always sends.
  await key('Enter', { ctrl: true })
  await until('Ctrl+Enter sends the message', () => watch.state.messages.some(m => m.agent === 'alpha' && m.from === 'user' && m.text === 'gq.t hello from the keys'))
  await key('Escape')
  check((await ev('return __k.active()')).tag !== 'TEXTAREA', 'Escape leaves the composer')
  await key('t')
  check(await ev('return document.documentElement.dataset.theme === "dark"'), 'T switches to the dark theme')
  await key('t')
  check(await ev('return document.documentElement.dataset.theme !== "dark"'), 'T switches back')
  await key('?', { shift: true, pause: 300 })
  const inSession = await ev('const d = document.querySelector("dialog.keys-sheet"); return [...d.querySelectorAll("h3")].map(h => h.textContent)')
  check(inSession.includes('In a session') && inSession.includes('While writing'), `in a session the sheet lists the session's keys (${inSession.join(', ')})`)
  await shot('10-sheet-session')
  await key('Escape')

  // A pair: two sessions side by side.
  await ev(`return Promise.all(['alpha', 'beta'].map(agent => fetch('/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent, group: 'gkeys' }) })))`)
  await until('the two sessions are a pair', () => ev('return document.body.hasAttribute("data-pair")'), 5000)
  const member = () => ev('return document.querySelector(".chat-pane.is-member")?.dataset.agent')
  const first = await member()
  await key('Escape')
  await key('o')
  check(await member() !== first, 'O moves to the other session of the pair')
  await key('r')
  check(await ev('return document.activeElement.closest(".chat-pane")?.dataset.agent') === await member(), 'R then writes to that one')
  await key('Escape')
  await shot('11-pair')
  await key('o')
  check(await member() === first, 'O again moves back')
  await ev(`return Promise.all(['alpha', 'beta'].map(agent => fetch('/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent, group: null }) })))`)

  // The whole Desk is paper: P picks up the pen (the paper comes in front of the cards), Escape puts it down.
  await keys('g', 'i')
  await sleep(1000)
  const penUp = () => ev('return document.querySelector("#inbox").hasAttribute("data-paper-front")')
  await key('p')
  if (await until('P picks up the pen: the paper is in front of the cards', penUp)) {
    await key('Escape', { pause: 400 })
    await ev('window.focus(); document.activeElement?.blur?.()')
    if (await penUp()) await ev('document.querySelector("#deskpad-pen").click()')
    await until('the pen is put down again, the cards are back', async () => !(await penUp()))
  }
  // (While the paper has the keyboard the board's keys are off: it must not keep it.)
  await ev('window.focus(); document.activeElement?.blur?.()')

  // W hides the Desk's cards so that only the paper is left, W again brings them back; G then X does the same.
  const cardsHidden = () => ev('return document.querySelector("#inbox").hasAttribute("data-cards-hidden")')
  await key('w')
  await until('W hides the cards of the Desk', cardsHidden)
  await key('w')
  await until('W again brings the cards back', async () => !(await cardsHidden()))
  await keys('g', 'x')
  await until('G then X hides them too', cardsHidden)
  // A knock strip never leads to something invisible: a click on one brings the cards back first.
  if (await ev('const b = [...document.querySelectorAll(".inbox-edge-knock")].find(n => !n.hidden); b?.click(); return Boolean(b)')) await until('a knock strip brings the hidden cards back', async () => !(await cardsHidden()))
  if (await cardsHidden()) await keys('g', 'x')
  await until('the cards are back before the walk', async () => !(await cardsHidden()))

  // ---------------------------------------------------------------------------
  section('Focus: the walk through all questions')
  await keys('g', 'i')
  await sleep(300)
  await keys('g', 'f')
  await until('G then F opens the walk', () => ev('return Boolean(__k.front())'))
  const walkOrder = watch.state.queue.filter(id => card(id)?.status === 'open')
  const frontId = async () => { const title = await ev('return __k.frontTitle()'); return watch.state.cards.find(x => x.title === title && x.status === 'open')?.id ?? watch.state.cards.find(x => x.title === title)?.id }
  const one = await frontId()
  await key('j', { pause: 400 })
  const two = await frontId()
  check(two && two !== one, 'J shows the next question without answering')
  await key('k', { pause: 400 })
  check(await frontId() === one, 'K shows the previous one')
  check(card(one).status === 'open', 'moving answers nothing')
  // Find a yes/no card to answer by key.
  for (let i = 0; i < walkOrder.length && card(await frontId())?.options.length !== 2; i++) await key('j', { pause: 400 })
  const duo = await frontId()
  const tilesAt = () => ev('const t = __k.front().querySelector(".focus-opt"); return __k.box(t)')
  // The arrows page; they never answer.
  await key('ArrowRight', { pause: 450 })
  check(await frontId() !== duo && card(duo).status === 'open', 'the right arrow shows the next question and answers nothing')
  await key('ArrowLeft', { pause: 450 })
  check(await frontId() === duo && card(duo).status === 'open', 'the left arrow shows the previous one and answers nothing')
  await key('y', { pause: 700 })
  await until('Y answers the question in front', () => card(duo).status !== 'open' && card(duo).choice === card(duo).options[0].key)
  const nextFront = await frontId()
  check(nextFront && nextFront !== duo, 'the next question comes at once')
  // What happened to the question that left is said by a strip in its place or by the note beside the answers; either carries Back.
  const strip = () => ev('const n = [...document.querySelectorAll(".focus .focus-strip, .focus .says")].filter(s => s.getClientRects().length).at(-1); return n ? { text: n.innerText.replace(/\\s+/g, " "), box: __k.box(n), button: Boolean(n.querySelector(".focus-strip-back, .says-back")) } : null')
  const walkTag = await strip()
  if (check(Boolean(walkTag), 'a strip says what happened')) {
    check(walkTag.text.includes(`Answered: ${card(duo).options[0].label}`) && walkTag.text.includes(card(duo).title) && walkTag.button, `the strip names the answer and the question, and carries Back ("${walkTag.text}")`)
    const tiles = await ev('return [...__k.front().querySelectorAll(".focus-opt")].map(__k.box)')
    check(!(await ev(`return ${JSON.stringify(tiles)}.some(t => __k.hits(${JSON.stringify(walkTag.box)}, t))`)), 'the strip covers no answer tile')
    await shot('12-back-in-walk')
  }
  await key('u', { pause: 700 })
  await until('U takes the answer back on the board', () => card(duo).status === 'open')
  await until('and that question is in front again', async () => await frontId() === duo)
  // The same by hand: a real click on the thumb, a real click on Back.
  await click('[...__k.front().querySelectorAll(".focus-opt")].at(-1)')
  await until('a click on a tile answers', () => card(duo).status !== 'open')
  await until('the strip is shown again', strip)
  await shot('12b-strip-after-click')
  await sleep(450)
  await click('[...document.querySelectorAll(".focus .focus-strip-back, .focus .says-back")].filter(b => b.getClientRects().length).at(-1)')
  await until('a click on Back takes the answer back', () => card(duo).status === 'open')
  await until('and that question is in front again', async () => await frontId() === duo)
  await key('n', { pause: 700 })
  await until('N answers no', () => card(duo).status !== 'open' && card(duo).choice === card(duo).options[1].key)
  await key('Backspace', { pause: 700 })
  await until('Backspace takes it back', () => card(duo).status === 'open')
  await until('the question is in front again', async () => await frontId() === duo)
  // More options than a pair: C puts the keyboard on the first, up and down go through them, nothing is answered.
  for (let i = 0; i < walkOrder.length && !((card(await frontId())?.options.length ?? 0) > 2); i++) await key('j', { pause: 400 })
  const many = await frontId()
  await key('c')
  const optNow = () => ev('const a = document.activeElement; return a?.matches(".focus-opt") ? (a.dataset.key ?? a.getAttribute("aria-label") ?? a.innerText) : ""')
  const firstOpt = await optNow()
  await key('ArrowDown')
  const secondOpt = await optNow()
  check(firstOpt && secondOpt && firstOpt !== secondOpt && card(many).status === 'open' && await frontId() === many, `C then the down arrow walk the options without answering ("${firstOpt}" -> "${secondOpt}")`)
  await ev('document.activeElement.blur()')
  const beforeLater = await frontId()
  await key('l', { pause: 700 })
  check(await frontId() !== beforeLater && watch.state.cards.find(x => x.id === beforeLater).status === 'open', 'L puts the question off and the next one comes')
  check(/Snoozed/.test((await strip())?.text ?? ''), 'a strip says "Snoozed"')
  await key('u', { pause: 700 })
  await until('U fetches it back to the front', async () => await frontId() === beforeLater)
  await key('l', { pause: 700 })
  const beforeExplain = await frontId()
  if (card(beforeExplain)?.kind !== 'permission') {
    await key('e', { pause: 600 })
    await until('E asks the session to explain the question in front, at once', () => watch.state.messages.some(m => m.card_id === beforeExplain && m.from === 'user' && m.explain))
    if (['TEXTAREA', 'INPUT'].includes((await ev('return __k.active()')).tag)) await key('Escape', { pause: 300 })
    await shot('13-explain-in-walk')
  }
  await key('?', { shift: true, pause: 300 })
  const inWalk = await ev('const d = document.querySelector("dialog.keys-sheet"); return d.open ? [...d.querySelectorAll("h3")].map(h => h.textContent) : null')
  check(inWalk?.some(t => t.startsWith('An opened question')), `in the walk the sheet lists the walk's keys (${inWalk?.join(', ')})`)
  check(inWalk && !inWalk.includes('A list of questions'), 'and not those of the list behind it')
  await shot('14-sheet-walk')
  await key('Escape', { pause: 300 })
  check(await ev('return Boolean(__k.front())'), 'Escape closes the sheet, not the walk')
  await key('Escape', { pause: 400 })
  check(await ev('return !document.querySelector(".focus:not([hidden]) .focus-card[data-shown]") || document.querySelector(".focus").hasAttribute("data-closing") || document.querySelector(".focus").hidden'), 'Escape then closes the walk')
  await sleep(300)

  // ---------------------------------------------------------------------------
  section('The ways out that are no answer: Snooze, Revise, Whatever, Shred; and H')
  await open('/')
  await keys('g', 'f')
  await until('the walk opens', () => ev('return Boolean(__k.front())'))
  const titleNow = () => ev('return __k.frontTitle()')
  const strips = () => ev('return [...document.querySelectorAll(".focus .focus-strip, .focus .says")].filter(s => s.getClientRects().length).map(n => n.innerText.replace(/\\s+/g, " "))')
  const bring = async id => { for (let i = 0; i < 40 && await titleNow() !== card(id).title; i++) await key('j', { pause: 260 }); return check(await titleNow() === card(id).title, `J reaches "${card(id).title}" in the walk`) }
  if (await bring(c.x1)) {
    await key('h', { pause: 300 })
    check(await titleNow() === card(c.x1).title && card(c.x1).status === 'open', 'H (hear it) changes nothing on a board without speech')
    await key('s', { pause: 800 })
    check(card(c.x1).status === 'open' && (await strips()).some(t => t.includes(card(c.x1).title)), `S snoozes the question in front (strips: ${(await strips()).join(' | ')})`)
  }
  if (await bring(c.x2)) {
    await key('b', { pause: 300 })
    await until('B (Revise) hands the question back to the agent at once', async () => card(c.x2).status === 'open' && await titleNow() !== card(c.x2).title)
    check((await strips()).length > 0, `and says so, with Back (${(await strips()).join(' | ')})`)
  }
  // In the card: A puts the caret into its field, D switches the pen on and off.
  {
    await key('a', { pause: 400 })
    check(await ev('return Boolean(document.activeElement?.closest(".focus textarea, .focus input, .focus [contenteditable]"))'), 'A puts the caret into the card\'s field')
    await type('gyn')
    await key('Escape', { pause: 300 })
    check(await ev('return Boolean(__k.front())'), 'Escape leaves the field, the card stays')
    const pen = () => ev('return Boolean(document.querySelector(".focus .focus-card[data-shown] [data-pen]"))')
    const before = await pen()
    await key('d', { pause: 300 })
    check(await pen() !== before, 'D switches the pen on')
    await key('d', { pause: 300 })
    check(await pen() === before, 'D again switches it off')
  }
  if (await bring(c.x3)) {
    await key('r', { pause: 300 })
    await until('R (whatever) leaves the decision to the agent', () => card(c.x3).status !== 'open')
  }
  if (await bring(c.x4)) {
    await key('x', { pause: 300 })
    await until('X shreds the question in front', () => card(c.x4).status !== 'open')
    console.log(`     (x3 after R: ${JSON.stringify({ status: card(c.x3).status, choice: card(c.x3).choice, trust: card(c.x3).trust })}; x4 after X: ${JSON.stringify({ status: card(c.x4).status, choice: card(c.x4).choice, shredded: Boolean(card(c.x4).shredded) })})`)
  }
  await shot('16-ways-in-walk')
  await key('Escape', { pause: 500 })
  await open('/')
  if (await markRow(c.x5)) {
    await key('r')
    await until('in the list R (whatever) on the marked row leaves the decision to the agent', () => card(c.x5).status !== 'open')
  }
  if (await markRow(c.x6)) {
    await key('x')
    await until('in the list X shreds the marked row', () => card(c.x6).status !== 'open')
  }
  {
    const victim = (await ev('return __k.reach().map(n => n.dataset.id)')).find(id => card(id)?.status === 'open' && card(id).kind === 'decision')
    if (victim && await markRow(victim)) {
      await key('b', { pause: 300 })
      await until('in the list B (Revise) hands the marked question back: it leaves the open rows', () => ev(`return !__k.reach().some(n => n.dataset.id === ${JSON.stringify(victim)} && !('later' in n.dataset))`))
      check(card(victim).status === 'open', 'and it is not answered')
    }
    await key('Escape')
    for (const [how, press] of [['Ctrl+K', () => key('k', { ctrl: true, pause: 400 })], ['G then J', () => keys('g', 'j')]]) {
      await press()
      await sleep(300)
      check(await ev('return document.activeElement?.tagName === "INPUT"'), `${how} puts the caret into the jump field`)
      await key('Escape', { pause: 300 })
      await ev('document.activeElement?.blur?.()')
      await key('Escape', { pause: 200 })
    }
  }
  await key('?', { shift: true, pause: 300 })
  const words = await ev('return document.querySelector("dialog.keys-sheet").innerText')
  check(/Desk/.test(words) && /Next, please/.test(words) && /whatever/i.test(words) && /shred/i.test(words) && !/What\?\?/.test(words) && !/inbox/i.test(words), 'the sheet says Desk, Next please, whatever, shred; not inbox, not What??')
  await key('Escape')

  // ---------------------------------------------------------------------------
  section('Tab: a visible focus on everything that can be pressed')
  await open('/')
  const seen = []
  for (let i = 0; i < 45; i++) {
    await key('Tab', { pause: 30 })
    const at = await ev(`const a = document.activeElement; if (!a || a === document.body) return null; const s = getComputedStyle(a); const r = a.getBoundingClientRect();
      return { what: a.tagName + '.' + String(a.className).split(' ')[0] + ' "' + ((a.getAttribute('aria-label') ?? a.innerText ?? '').trim().slice(0, 30)) + '"', ring: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2, visible: r.width > 0 && r.height > 0, name: Boolean((a.getAttribute('aria-label') ?? a.innerText ?? a.title ?? '').trim()) }`)
    if (at) seen.push(at)
  }
  check(seen.length >= 30, `Tab reaches the controls of the page (${seen.length} stops)`)
  const noRing = [...new Set(seen.filter(s => !s.ring).map(s => s.what))]
  check(!noRing.length, `every stop shows a focus ring; without one: ${noRing.join(', ')}`)
  const noName = [...new Set(seen.filter(s => !s.name).map(s => s.what))]
  check(!noName.length, `every stop has a name; without one: ${noName.join(', ')}`)
  await shot('15-tab-focus')
  for (const where of ['/', '/agents', '/s/gamma', '/s/gamma/questions']) {
    await open(where)
    const nameless = await ev(`return [...document.querySelectorAll('button, a[href], [role="button"]')].filter(n => n.checkVisibility({ visibilityProperty: true }) && !(n.getAttribute('aria-label') ?? n.getAttribute('aria-labelledby') ?? n.innerText ?? '').trim() && !n.title).map(n => n.tagName + '.' + n.className)`)
    check(!nameless.length, `${where}: every control has a name; without one: ${[...new Set(nameless)].join(', ')}`)
  }

  // ---------------------------------------------------------------------------
  section('Pictures: phone width and dark')
  await open('/', { dark: true })
  await keys('j', 'j')
  await shot('20-dark-marked')
  await key('y', { pause: 600 })
  await shot('21-dark-back')
  await key('u', { pause: 600 })
  await key('?', { shift: true, pause: 300 })
  await shot('22-dark-sheet')
  await key('Escape')
  await keys('g', 'f')
  await sleep(700)
  await key('?', { shift: true, pause: 300 })
  await shot('23-dark-sheet-walk')
  await key('Escape')
  await key('Escape')
  await open('/', { width: 400, height: 860 })
  await keys('j', 'j')
  check(await ev('return __k.inView(__k.list().querySelector(".is-current"))'), 'phone width: the marked row is in view')
  await shot('30-phone-marked')
  await key('?', { shift: true, pause: 300 })
  await shot('31-phone-sheet')
  await key('Escape')
  await open('/', { width: 400, height: 860, dark: true })
  await keys('j', 'y')
  await sleep(500)
  await shot('32-phone-dark-back')
  await key('u', { pause: 500 })

  // Card Nr. 171: G then 1…9 switch desks while there are several; with one desk they stay the sessions'.
  section('Desks: D then 1…9')
  {
    await open('/')
    const deskNow = () => ev('return import("/js/store.js").then(m => m.getState().all.desk)')
    const scopeNow = () => ev('return document.body.dataset.scope')
    const chipUp = () => ev('const c = document.querySelector(".keys-pending"); return Boolean(c) && !c.hidden')
    const first = await deskNow()
    await key('d', { pause: 250 })
    check(!(await chipUp()), 'one desk: D starts no sequence')
    await key('Escape')
    const made = await ev('return fetch("/desk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Zweiter Desk" }) }).then(r => r.json()).then(o => o.desk && o.desk.id)')
    check(Boolean(made), 'a second desk is made')
    await until('the page knows two desks', () => ev('return import("/js/store.js").then(m => (m.getState().all.desks || []).length === 2)'))
    await ev(`return import("/js/store.js").then(m => { m.setDesk(${JSON.stringify(first)}); return true })`)
    await sleep(300)
    await keys('d', '2')
    await until('two desks: D then 2 switches to the second desk', async () => (await deskNow()) === made)
    check(await ev('return document.querySelector(".desk-name").textContent') === 'Zweiter Desk', 'the Desk box names the desk in view')
    await keys('d', '9')
    await sleep(200)
    check(await deskNow() === made && await scopeNow() === 'all', 'D then 9 (no such desk) changes nothing, and opens no session')
    await keys('d', '1')
    await until('D then 1 switches back to the first desk', async () => (await deskNow()) === first)
    check(await scopeNow() === 'all', 'D then 1 stays on the Desk (no session opened)')
    await key('d', { pause: 250 })
    const offered = await ev('return document.querySelector(".keys-pending").innerText.replace(/\\s+/g, " ")')
    check(/desk 1 to 9/i.test(offered) && !/session 1 to 9/i.test(offered), `after D the chip offers the desks only: ${offered}`)
    await key('Escape')
    await keys('g', '1')
    await until('two desks: G then 1 still goes to the first session', async () => { const s = await scopeNow(); return s && s !== 'all' })
    check(await deskNow() === first, 'and G then 1 switches no desk')
    await keys('g', 'a')
    await sleep(400)
    await key('d', { pause: 250 })
    check(!(await chipUp()), 'on the Ledger page D stays the Ledger\'s key: no sequence starts')
    await key('Escape')
    await keys('g', 'i')
    await sleep(300)
    await key('?', { shift: true, pause: 300 })
    const listed = await ev('return document.querySelector(".keys-sheet").innerText.replace(/\\s+/g, " ")')
    check(/D ?then ?1…9 ?switch to that desk/.test(listed) && !/Ctrl ?1…9/.test(listed), 'the key sheet lists D then 1…9 for the desks, and no Ctrl key for them')
    check(/G ?then ?1…9 ?go to that session of the sidebar/.test(listed), 'the key sheet lists G then 1…9 for the sessions beside it')
    await shot('40-desk-keys-sheet')
    await key('Escape')
    await ev(`return fetch("/desk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: ${JSON.stringify(made)}, remove: true }) }).then(r => r.ok)`)
    await sleep(300)
  }

  section('The page')
  check(!pageErrors.length, `no errors in the page: ${pageErrors.slice(0, 5).join(' | ')}`)
}

try {
  await main()
} catch (err) {
  failures.push(`the test broke off: ${err.stack ?? err}`)
  console.log(`\nBROKE OFF: ${err.stack ?? err}`)
  try { await shot('99-broke-off') } catch {}
  if (hubLog) console.log(hubLog.split('\n').slice(-6).join('\n'))
}
console.log(`\n${passed} passed, ${failures.length} failed, ${pendingNotes.length} pending. Screenshots in ${out}`)
await stop(failures.length ? 1 : 0)
