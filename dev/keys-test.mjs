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
import { launchChromium } from './cdp.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.argv[2] || 8884)
const out = process.argv[3] || path.join(os.tmpdir(), 'keys-test')
if (port === 8790 || port === 8795) throw new Error('that port belongs to a board in use')
fs.mkdirSync(out, { recursive: true })
const token = 'demo'
const base = `http://127.0.0.1:${port}`
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---- the board ---------------------------------------------------------------

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keys-test-data-'))
const hub = spawn('node', [path.join(ROOT, 'server', 'server.mjs')], {
  env: { ...process.env, BOARD_PORT: String(port), BOARD_HOST: '127.0.0.1', BOARD_TOKEN: token, BOARD_DATA: dataDir, BOARD_HUB_ONLY: '1', BOARD_AGENT: '' },
  stdio: ['pipe', 'ignore', 'pipe'],
})
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
process.on('SIGINT', () => stop(130))

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
    done: () => [...(__k.list()?.querySelectorAll('.inbox-done') ?? [])].map(n => ({ id: n.dataset.id, text: n.innerText.replace(/\\s+/g, ' '), h: Math.round(n.getBoundingClientRect().height), current: n.classList.contains('is-current') })),
    row: id => __k.rows().find(n => n.dataset.id === id),
    cur: () => { const n = __k.list()?.querySelector('.inbox-row.is-current, .inbox-done.is-current'); return n ? { id: n.dataset.id, y: Math.round(n.getBoundingClientRect().top), later: 'later' in n.dataset, done: n.classList.contains('inbox-done'), open: n.classList.contains('is-open'), focus: document.activeElement === n } : null },
    inView: n => { const b = n.closest('main, .pane-list').getBoundingClientRect(), r = n.getBoundingClientRect(); return r.top >= b.top - 1 && r.bottom <= b.bottom + 1 },
    back: () => { const n = [...document.querySelectorAll('.says')].find(b => b.getClientRects().length); return n ? { text: n.innerText.replace(/\\s+/g, ' '), box: __k.box(n), host: n.parentElement.className, button: Boolean(n.querySelector('.says-back')) } : null },
    inSight: n => { const r = n.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight - 60 },
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
  check(ids.length === 13, `the inbox lists 13 rows, found ${ids.length}`)
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
  const groupOf = 'return __k.list().querySelector(".is-current").closest(".inbox-group").querySelector(".inbox-sender span:not(.inbox-avatar)").textContent'
  const firstGroup = await ev(groupOf)
  let crossed = false
  for (let i = 0; i < 12; i++) {
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
  await until('the question is back in its group, and marked', async () => (await cur())?.id === c.b1 && await ev(`return __k.row(${JSON.stringify(c.b1)}).closest('.inbox-group').querySelector('.inbox-sender').textContent.includes('Beta')`))

  // ---------------------------------------------------------------------------
  section('Inbox: later, choices, several answers')
  await markRow(c.b2)
  const y0 = (await cur()).y
  await key('l')
  await until('L puts the row off', () => ev(`return 'later' in (__k.row(${JSON.stringify(c.b2)})?.dataset ?? {})`))
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
  await key('l')
  await until('L on a row that was put off fetches it back', () => ev(`return !('later' in __k.row(${JSON.stringify(c.b2)}).dataset)`))

  await markRow(c.a3)
  await key('Enter', { pause: 450 })
  check((await cur())?.open, 'Enter unfolds the choices of the marked row')
  check((await ev('return __k.active()')).text.includes('Green'), 'the option the agent recommends has the focus')
  await key('ArrowRight')
  check((await ev('return __k.active()')).text.includes('Gold'), 'the right arrow moves to the next option')
  await key('ArrowLeft')
  await key('ArrowLeft')
  check((await ev('return __k.active()')).text.includes('Ink'), 'the left arrow moves back')
  await shot('04-choices-open')
  await key('Escape')
  check(!(await cur())?.open && (await cur())?.id === c.a3, 'Escape folds the choices and keeps the mark')
  await key('c', { pause: 450 })
  await key('3')
  await until('a digit picks that option', () => card(c.a3).choice === 'gold')
  await key('u')
  await until('U takes it back', () => card(c.a3).status === 'open')

  await markRow(c.a4)
  await key('c', { pause: 450 })
  await key(' ')
  await key('ArrowRight')
  await key('ArrowRight')
  await key(' ')
  check(JSON.stringify(await ev('return [...__k.list().querySelectorAll(".is-current .inbox-option[aria-pressed]")].map(b => b.getAttribute("aria-pressed"))')) === '["true","false","true"]', 'Space toggles the option in focus (first and third)')
  await key('2')
  await key('2')
  check(card(c.a4).status === 'open', 'toggling answers nothing yet')
  await shot('05-several')
  await key('Enter')
  await until('Enter sends the picked options together', () => card(c.a4).status !== 'open' && card(c.a4).choices?.join() === 'unit,lint')
  await key('u')
  await until('U takes it back', () => card(c.a4).status === 'open')

  // ---------------------------------------------------------------------------
  section('Inbox: ask back and Explain by key, keys rest in a field')
  await markRow(c.b3)
  await key('a', { pause: 450 })
  const field = await ev('return __k.active()')
  check(field.tag === 'INPUT' && /Ask the agent/.test(field.label ?? ''), 'A opens the row and puts the caret into the ask-back line')
  await type('yn l')
  await sleep(150)
  check(card(c.b3).status === 'open' && !(await ev(`return 'later' in __k.row(${JSON.stringify(c.b3)}).dataset`)), 'letters typed in the field answer nothing and put nothing off')
  await key('Escape')
  check((await ev('return __k.active()')).cls.includes('inbox-row'), 'Escape leaves the field for the row')
  await key('a', { pause: 300 })
  await key('Enter')
  await until('Enter sends the question back with the card', () => watch.state.messages.some(m => m.card_id === c.b3 && m.from === 'user' && m.text === 'yn l'))
  await sleep(500)
  check(await ev(`return !('later' in __k.row(${JSON.stringify(c.b3)}).dataset)`) && card(c.b3).status === 'open', 'a typed question back leaves the row where it is, open')
  await key('Escape')
  await key('Escape')

  await markRow(c.a3)
  await key('e', { pause: 450 })
  check((await cur())?.open && !watch.state.messages.some(m => m.card_id === c.a3 && m.from === 'user'), 'E first unfolds the row and asks nothing')
  await key('e')
  await until('E again asks the session to explain', () => watch.state.messages.some(m => m.card_id === c.a3 && m.from === 'user' && /^Explain this question/.test(m.text)))
  await until('and the row goes to "Later"', () => ev(`return 'later' in (__k.row(${JSON.stringify(c.a3)})?.dataset ?? {})`))
  check(/Asked to explain/.test((await back())?.text ?? ''), 'a note says "Asked to explain", with Back')
  await shot('06-asked-to-explain')
  await alpha.call('reply', { text: 'Green is the brand colour; ink reads best; gold is for VIP only. I would take green.', card_id: c.a3 })
  await until('the session\'s reply brings the row back from "Later"', () => ev(`return !('later' in (__k.row(${JSON.stringify(c.a3)})?.dataset ?? { later: 1 }))`), 6000)
  // A card too large for a row opens as a window; there Explain closes the window.
  await markRow(c.b5)
  await key('Enter', { pause: 700 })
  check(await ev('return __k.frontTitle()') === 'Which region hosts the mirror?', 'Enter opens a large question as a window')
  await key('e', { pause: 900 })
  await until('E in that window asks the session to explain', () => watch.state.messages.some(m => m.card_id === c.b5 && m.from === 'user' && /^Explain this question/.test(m.text)))
  await until('the window closes', () => ev('return !__k.front()'))
  await until('the row is under "Later"', () => ev(`return 'later' in (__k.row(${JSON.stringify(c.b5)})?.dataset ?? {})`))
  check(/Asked/.test((await back())?.text ?? ''), 'and the page says so')
  await key('u')
  await until('U fetches it back', () => ev(`return !('later' in (__k.row(${JSON.stringify(c.b5)})?.dataset ?? { later: 1 }))`))

  // ---------------------------------------------------------------------------
  section('Inbox: the Answered group')
  check(!(await ev('return Boolean(__k.list().querySelector(".inbox-group-answered"))')), 'with nothing answered there is no "Answered" group')
  await markRow(c.g2)
  await key('y')
  await until('Y answers', () => card(c.g2).status !== 'open')
  await until('an "Answered" group stands at the end, folded', () => ev('const g = __k.list().querySelector(".inbox-group-answered"); return g && g === __k.list().lastElementChild && !g.querySelector(".inbox-done") && /Answered/.test(g.innerText) && /1 today/i.test(g.innerText)'))
  await sleep(5300)   // the note has left: this is the wrong answer that is noticed later
  await click('__k.list().querySelector(".inbox-answered-toggle")')
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
  await until('the question stands in its group again, marked', async () => { const at = await cur(); return at?.id === c.g2 && !at.done && await ev(`return __k.row(${JSON.stringify(c.g2)}).closest('.inbox-group').querySelector('.inbox-sender').textContent.includes('Gamma')`) })
  // The same by hand, on a card the agent has closed since.
  await key('n')
  await until('N answers', () => card(c.g2).status !== 'open')
  await gamma.call('close_card', { card_id: c.g2, summary: 'Left as it is.' })
  await until('the row says the agent has closed it', () => ev('return __k.done().some(d => /done by the agent/i.test(d.text))'))
  await sleep(700)   // the rows have come to rest
  await click('__k.list().querySelector(".inbox-takeback")')
  await until('a click on "Take back" reopens it all the same', () => card(c.g2).status === 'open')
  await until('and the question stands in its group again, marked', async () => (await cur())?.id === c.g2 && !(await cur()).done)
  await key('Escape')

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
  await keys('g', '1')
  await until('G then 1 opens the first session', () => ev('return location.pathname === "/s/alpha"'))
  await sleep(400)
  check((await ev('return __k.active()')).tag !== 'TEXTAREA', 'arriving by key leaves the keys in charge (the caret is not in the composer)')
  await key('.')
  await until('"." goes to the next session', () => ev('return location.pathname === "/s/beta"'))
  await key(',')
  await until('"," goes to the previous session', () => ev('return location.pathname === "/s/alpha"'))
  await key('q')
  await until('Q filters to the questions', () => ev('return location.pathname === "/s/alpha/questions"'))
  await key('j')
  check((await cur())?.id === c.a1, 'in "Questions only" J marks the session\'s first question')
  await shot('09-questions-only')
  await key('Escape')
  await key('q')
  await until('Q again shows the whole conversation', () => ev('return location.pathname === "/s/alpha"'))
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
  check(inSession.includes('In a session') && inSession.includes('While writing') && !inSession.includes('A list of questions'), `in a session the sheet lists the session's keys (${inSession.join(', ')})`)
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

  // The pad lies over the board; while it is up the board's keys rest.
  await keys('g', 'i')
  await sleep(300)
  await key('p', { pause: 900 })
  if (check(await ev('return document.body.hasAttribute("data-pad") && location.pathname === "/pad"'), 'P opens the pad')) {
    await ev('window.focus(); document.activeElement?.blur?.()')
    await keys('g', 'a', 't')
    check(await ev('return location.pathname === "/pad" && document.documentElement.dataset.theme !== "dark"'), 'under the pad the board\'s keys rest')
    await ev('history.back()')
    await until('leaving the pad returns to the place before', () => ev('return !document.body.hasAttribute("data-pad") && location.pathname === "/"'))
  }

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
  const walkTag = await back()
  if (check(Boolean(walkTag), 'a note says what happened')) {
    check(walkTag.text.includes(`Answered: ${card(duo).options[0].label}`) && walkTag.text.includes(card(duo).title) && walkTag.button, `the note names the answer and the question, and carries Back ("${walkTag.text}")`)
    const win = await ev('return __k.box(document.querySelector(".focus-sheet"))')
    const column = await ev('return __k.box(__k.front().querySelector(".focus-opts"))')
    check(walkTag.box.r <= column.x && column.x - walkTag.box.r < 60 && walkTag.box.y >= win.y && walkTag.box.y < column.y + 80, `answered by key, the note stands beside the top of the option column (note ..${Math.round(walkTag.box.r)} x ${Math.round(walkTag.box.y)}, column from ${Math.round(column.x)}, ${Math.round(column.y)})`)
    const tiles = await ev('return [...__k.front().querySelectorAll(".focus-opt")].map(__k.box)')
    check(!(await ev(`return ${JSON.stringify(tiles)}.some(t => __k.hits(${JSON.stringify(walkTag.box)}, t))`)), 'the note covers no answer tile')
    const withTag = await tilesAt()
    await shot('12-back-in-walk')
    await sleep(5300)
    check(!(await back()), 'the note leaves by itself')
    const without = await tilesAt()
    check(Math.abs(withTag.y - without.y) < 1 && Math.abs(withTag.x - without.x) < 1, 'the tiles do not move when the note comes or goes')
  }
  await key('u', { pause: 700 })
  await until('U takes the answer back on the board, after the note has left', () => card(duo).status === 'open')
  await until('and that question is in front again', async () => await frontId() === duo)
  // The same by hand: a real click on the thumb, a real click on Back.
  await click('[...__k.front().querySelectorAll(".focus-opt")].at(-1)')
  await until('a click on a tile answers', () => card(duo).status !== 'open')
  const walkPressed = await until('the note is shown again', back)
  { const tiles = await ev('return [...__k.front().querySelectorAll(".focus-opt")].map(__k.box)')
    check(walkPressed && walkPressed.box.r <= Math.min(...tiles.map(t => t.x)) && walkPressed.box.y <= lastClick.y && walkPressed.box.b >= lastClick.y && Math.min(...tiles.map(t => t.x)) - walkPressed.box.r < 60, `answered by click, the note stands left of the options at the height of the pointer (pointer ${Math.round(lastClick.x)},${Math.round(lastClick.y)}; note ..${Math.round(walkPressed?.box.r)} x ${Math.round(walkPressed?.box.y)}..${Math.round(walkPressed?.box.b)})`)
    const field = await ev('const f = __k.front().querySelector(".focus-ask"); return f ? __k.box(f) : null')
    check(!field || !(await ev(`return __k.hits(${JSON.stringify(walkPressed?.box)}, ${JSON.stringify(field)})`)), 'and does not cover the composer')
    await shot('12b-back-beside-click-walk') }
  await sleep(450)
  await click('document.querySelector(".focus-says .says-back")')
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
  const firstOpt = (await ev('return __k.active()')).text
  await key('ArrowDown')
  const secondOpt = (await ev('return __k.active()')).text
  check(firstOpt && secondOpt && firstOpt !== secondOpt && card(many).status === 'open' && await frontId() === many, `C then the down arrow walk the options without answering ("${firstOpt}" -> "${secondOpt}")`)
  await ev('document.activeElement.blur()')
  const beforeLater = await frontId()
  await key('l', { pause: 700 })
  check(await frontId() !== beforeLater && watch.state.cards.find(x => x.id === beforeLater).status === 'open', 'L puts the question off and the next one comes')
  check(/Snoozed/.test((await back())?.text ?? ''), 'a note says "Snoozed"')
  await key('u', { pause: 700 })
  await until('U fetches it back to the front', async () => await frontId() === beforeLater)
  await key('l', { pause: 700 })
  const beforeExplain = await frontId()
  if (card(beforeExplain)?.kind !== 'permission') {
    await key('e', { pause: 900 })
    await until('E asks the session to explain the question in front', () => watch.state.messages.some(m => m.card_id === beforeExplain && m.from === 'user' && /^Explain this question/.test(m.text)))
    check(await frontId() !== beforeExplain, 'and the walk moves on')
    check(/Asked/.test((await back())?.text ?? ''), 'a note says that the session was asked')
    await shot('13-explain-in-walk')
  }
  await key('?', { shift: true, pause: 300 })
  const inWalk = await ev('const d = document.querySelector("dialog.keys-sheet"); return d.open ? [...d.querySelectorAll("h3")].map(h => h.textContent) : null')
  check(inWalk?.[0]?.startsWith('Focus') || inWalk?.some(t => t.startsWith('Focus')), `in the walk the sheet lists the walk's keys (${inWalk?.join(', ')})`)
  check(inWalk && !inWalk.includes('A list of questions'), 'and not those of the list behind it')
  await shot('14-sheet-walk')
  await key('Escape', { pause: 300 })
  check(await ev('return Boolean(__k.front())'), 'Escape closes the sheet, not the walk')
  await key('Escape', { pause: 400 })
  check(await ev('return !document.querySelector(".focus:not([hidden]) .focus-card[data-shown]") || document.querySelector(".focus").hasAttribute("data-closing") || document.querySelector(".focus").hidden'), 'Escape then closes the walk')
  await sleep(300)

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
console.log(`\n${passed} passed, ${failures.length} failed. Screenshots in ${out}`)
await stop(failures.length ? 1 : 0)
