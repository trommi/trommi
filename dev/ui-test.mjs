#!/usr/bin/env node
// Browser regression test for the web UI.
//   node dev/ui-test.mjs            run everything, exit 1 if anything failed
//   UI_TEST_SHOTS=dir               where the screenshots go (default: <tmp>/trommi-ui-test)
//   UI_TEST_ONLY=inbox,phone        run only the steps whose name contains one of these words
//
// It starts its own board on a free port with a throwaway data folder, three scripted
// agents (dev/fake-agent.mjs) and one small session that posts a message with pictures,
// then drives one headless Chromium over the DevTools protocol: first at desktop size
// with real mouse and key events, then at phone size with touch events. Everything it
// started is stopped and removed again, also when a step fails or the run is interrupted.
// Needs the command sandbox disabled, like dev/cdp.mjs.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchChromium } from './cdp.mjs'

// ---- every selector the test knows about ----------------------------------------
// Behaviour is checked through these; nothing else in the file names a class or an id.
const SEL = {
  loaded: 'html[data-loaded]',
  online: '#conn[data-state="online"]',
  themeToggle: '#theme-toggle',
  sidebarEntry: '#agents .agent-entry',          // Posteingang, one per session, and on phones "Agenten"
  sidebarName: 'strong',
  rosterNav: '#nav-roster, #roster-open',   // whichever of the two the layout shows
  focusOpen: '#focus-open',
  paneTitle: '#pane-who',
  modeButton: view => `.modes button[data-view="${view}"], .tabbar button[data-view="${view}"]`,
  modeCount: '#mode-count',
  toast: '#toast',

  inbox: '#inbox',
  sessionCards: '#session-cards',
  group: '.inbox-group',
  groupName: '.inbox-sender > span:not(.inbox-avatar)',
  groupCount: '.inbox-sender > b',
  row: '.inbox-row',
  rowTitle: '.inbox-question',
  rowTile: '.inbox-actions button',
  rowThumb: '.inbox-thumb img',
  rowVip: '.inbox-vip',
  undoBar: '#toast',                    // the passing notice that offers to take an answer back

  focus: '.focus',
  focusCard: '.focus-card[data-shown]',
  focusTitle: '.focus-title',
  focusOption: '.focus-opt',
  focusImage: '.focus-figure img',

  log: '#log',
  message: '#log-inner .msg',
  userMessage: '#log-inner .msg-user',
  agentMessage: '#log-inner .msg-agent',
  messageImage: '#log-inner .shot img',
  ask: '#log-inner .ask-open',
  askTitle: '.ask-title',
  askOption: '.ask-option',
  draft: '#draft',
  send: '#send',
  scribbleCard: '#log-inner .scribble-card',
  scribbleCanvas: '#scribble canvas',
  scribbleSend: '#scribble .scr-send',

  roster: '#roster',
  rosterCard: '.roster-card',
  rosterName: '.roster-name strong',
  rosterFact: '.roster-facts > div',
  rosterChange: '.roster-change',
  rosterStar: '.roster-star',
  rosterMark: '.roster-edit',
  editor: 'dialog.session-editor',
  editorName: 'dialog.session-editor input[type="text"]',
  editorMark: 'dialog.session-editor [role="radio"]',
  editorSave: 'dialog.session-editor button[type="submit"]',

  // These scroll sideways on purpose; everything else must fit the width of a phone.
  sidewaysOk: '#agents, pre, .hist-tabs, .focus-thumbs',
}

// Words of the interface the test relies on.
const TEXT = { inbox: 'Posteingang', later: 'Später', back: 'Zurückholen', more: 'Mehr', undo: 'Rückgängig', model: 'Modell', machine: 'Rechner', unknown: 'unbekannt' }

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 400, height: 860 }
const HELPER = 'Bildbote'   // the fourth session; it only posts one message with two pictures
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---- what runs in the page -------------------------------------------------------
// Small helpers under window.__t so that the checks below stay short. They only read.
const PAGE_LIB = `(() => {
  const SEL = ${JSON.stringify({ ...SEL, modeButton: undefined })}
  const vis = n => {
    if (!n || !n.isConnected || n.closest('[hidden]')) return false
    const r = n.getBoundingClientRect()
    const s = getComputedStyle(n)
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
  }
  const all = (sel, root = document) => [...root.querySelectorAll(sel)].filter(vis)
  const one = (sel, root = document) => all(sel, root)[0] ?? null
  const text = n => (n?.textContent ?? '').replace(/\\s+/g, ' ').trim()
  const label = n => n ? (n.getAttribute('aria-label') || text(n)) : ''
  const box = n => { const r = n.getBoundingClientRect(); const f = v => Math.round(v * 10) / 10; return { left: f(r.left), top: f(r.top), right: f(r.right), bottom: f(r.bottom), width: f(r.width), height: f(r.height) } }
  const describe = n => !n ? 'nothing' : '<' + n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (typeof n.className === 'string' && n.className ? '.' + n.className.trim().split(/\\s+/).join('.') : '') + '> "' + text(n).slice(0, 40) + '"'
  const rowInfo = n => {
    const tiles = all(SEL.rowTile, n)
    return { id: n.dataset.id, title: text(n.querySelector(SEL.rowTitle)), box: box(n), vip: !!one(SEL.rowVip, n), tiles: tiles.map(t => ({ name: label(t), box: box(t), disabled: t.disabled })) }
  }
  window.__t = {
    SEL, vis, all, one, text, label, box, describe,
    byText: (sel, wanted, root = document) => all(sel, root).find(n => text(n).includes(wanted)) ?? null,
    /** Where to click or tap an element: its middle, scrolled into view if needed, and not covered by anything. */
    point(n) {
      if (!n) return { error: 'it is not on the page' }
      if (!vis(n)) return { error: 'it is not visible: ' + describe(n) }
      if (n.disabled) return { error: 'it is disabled: ' + describe(n) }
      let r = n.getBoundingClientRect()
      if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) {
        n.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
        r = n.getBoundingClientRect()
      }
      const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2)
      const hit = document.elementFromPoint(x, y)
      if (!hit || !(n === hit || n.contains(hit))) return { error: describe(n) + ' is covered by ' + describe(hit) + ' at ' + x + ',' + y }
      return { x, y, box: box(n) }
    },
    /** True when nothing on the page is still sliding or fading (endless spinners do not count). */
    still: () => document.getAnimations().every(a => a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity),
    sidebar: name => all(SEL.sidebarEntry).find(n => text(n.querySelector(SEL.sidebarName)).replace(/^★ /, '') === name) ?? null,
    sidebarNames: () => all(SEL.sidebarEntry).map(n => text(n.querySelector(SEL.sidebarName))),
    row: (id, root = SEL.inbox) => all(SEL.row, document.querySelector(root)).find(n => n.dataset.id === id) ?? null,
    tile: (id, which, root = SEL.inbox) => { const r = __t.row(id, root); const tiles = r ? all(SEL.rowTile, r) : []; return (which === 'right' ? tiles.at(-1) : tiles[0]) ?? null },
    rows: (root = SEL.inbox) => all(SEL.row, document.querySelector(root)).map(rowInfo),
    groups: (root = SEL.inbox) => all(SEL.group, document.querySelector(root)).map(g => ({ name: text(g.querySelector(SEL.groupName)), count: text(g.querySelector(SEL.groupCount)), ids: all(SEL.row, g).map(n => n.dataset.id) })),
    /** Which answer tile lies under a point of the screen. */
    tileAt(x, y) {
      const hit = document.elementFromPoint(x, y)
      const tile = hit?.closest(SEL.rowTile)
      const row = tile?.closest(SEL.row)
      if (!tile || !row) return { hit: describe(hit) }
      return { hit: describe(hit), row: row.dataset.id, name: label(tile), right: all(SEL.rowTile, row).at(-1) === tile, box: box(tile) }
    },
    focusOpen: () => { const f = document.querySelector(SEL.focus); return !!f && !f.hidden && !f.hasAttribute('data-closing') },
    focusState() {
      const f = document.querySelector(SEL.focus)
      if (!f || f.hidden) return null
      const card = one(SEL.focusCard, f)
      return { id: card?.dataset.id ?? null, title: text(card?.querySelector(SEL.focusTitle)), options: card ? all(SEL.focusOption, card).map(label) : [] }
    },
    /** How many questions the page says are open: the number in its title. */
    openCount: () => Number(/^\\((\\d+)\\)/.exec(document.title)?.[1] ?? 0),
    /** What of the page behind the full-page view can still be reached. Empty when the page is inert. */
    reachableBehind() {
      const f = document.querySelector(SEL.focus)
      const out = [...document.body.children].filter(n => n !== f && vis(n) && !n.inert).map(describe)
      const toggle = document.querySelector(SEL.themeToggle)
      const before = document.activeElement
      toggle.focus()
      if (document.activeElement === toggle) out.push('the theme toggle takes the keyboard focus')
      before?.focus?.({ preventScroll: true })
      return out
    },
    asks: () => all(SEL.ask).map(n => ({ title: text(n.querySelector(SEL.askTitle)), options: all(SEL.askOption, n).map(label) })),
    ask: title => all(SEL.ask).find(n => text(n.querySelector(SEL.askTitle)) === title) ?? null,
    roster: () => all(SEL.rosterCard).map(c => ({
      name: text(c.querySelector(SEL.rosterName)),
      facts: Object.fromEntries(all(SEL.rosterFact, c).map(d => [text(d.querySelector('dt')), text(d.querySelector('dd'))])),
      starred: c.querySelector(SEL.rosterStar)?.getAttribute('aria-pressed') === 'true',
      mark: [...(c.querySelector(SEL.rosterMark)?.querySelectorAll('path') ?? [])].map(p => p.getAttribute('d')).join(' '),
    })),
    rosterCard: name => all(SEL.rosterCard).find(c => text(c.querySelector(SEL.rosterName)) === name) ?? null,
    /** Scroll every picture into view, give it time to load, and report its real size. */
    async pictures(sel) {
      const out = []
      for (const img of all(sel)) {
        img.scrollIntoView({ block: 'center', behavior: 'instant' })
        for (let i = 0; i < 80 && !img.complete; i++) await new Promise(r => setTimeout(r, 50))
        out.push({ src: img.getAttribute('src'), width: img.naturalWidth, complete: img.complete, in: describe(img.closest(SEL.row + ', ' + SEL.message + ', ' + SEL.focusCard) ?? img.parentElement) })
      }
      return out
    },
    /** Everything that makes the page wider than the screen. Empty when nothing overflows. */
    overflow() {
      const vw = document.documentElement.clientWidth
      const out = []
      for (const n of [document.documentElement, document.body]) if (n.scrollWidth > vw + 1) out.push(describe(n) + ' is ' + n.scrollWidth + 'px wide on a ' + vw + 'px screen')
      window.scrollTo(40, 0)
      if (window.scrollX) out.push('the page itself scrolls sideways')
      window.scrollTo(0, 0)
      for (const n of document.body.querySelectorAll('*')) {
        if (!vis(n) || n.closest(SEL.sidewaysOk)) continue
        const s = getComputedStyle(n)
        if (/auto|scroll/.test(s.overflowX) && n.scrollWidth > n.clientWidth + 1) out.push(describe(n) + ' scrolls sideways: ' + n.scrollWidth + 'px of content in ' + n.clientWidth + 'px')
        const r = n.getBoundingClientRect()
        if (r.right <= vw + 1 && r.left >= -1) continue
        let clipped = s.position === 'fixed' && (r.left >= vw || r.right <= 0)
        for (let p = n.parentElement; p && p !== document.body && !clipped; p = p.parentElement) clipped = getComputedStyle(p).overflowX !== 'visible'
        if (!clipped) out.push(describe(n) + ' reaches from ' + Math.round(r.left) + ' to ' + Math.round(r.right) + ' on a ' + vw + 'px screen')
      }
      return out.slice(0, 8)
    },
  }
})()`

// ---- the run: results, processes, cleanup ---------------------------------------

class Failed extends Error {}
const results = []        // { name, failures: [text], ms }
let current = null        // the step that is running
const only = (process.env.UI_TEST_ONLY || '').split(',').map(s => s.trim()).filter(Boolean)

/** A check that does not stop the step: the rest of the step still says something. */
function check(ok, message) {
  if (!ok) current.failures.push(message)
  return Boolean(ok)
}
/** A condition the rest of the step depends on. */
function need(ok, message) {
  if (!ok) throw new Failed(message)
}
const same = (a, b, tolerance = 1) => Math.abs(a - b) <= tolerance

const children = []       // every process started here: { proc, name, log }
let dataDir = null
let browser = null
let watcher = null
let cleaned = false

const alive = proc => proc.exitCode == null && proc.signalCode == null
function signalAll(sig) {
  // Each child leads its own process group, so its server.mjs goes with it.
  for (const { proc } of children) if (proc.pid && alive(proc)) { try { process.kill(-proc.pid, sig) } catch {} }
}
async function cleanup() {
  if (cleaned) return
  cleaned = true
  watcher?.stop()
  try { await browser?.close() } catch {}
  signalAll('SIGTERM')
  for (let i = 0; i < 30 && children.some(c => alive(c.proc)); i++) await sleep(100)
  signalAll('SIGKILL')
  if (dataDir) for (let i = 0; i < 5; i++) { try { fs.rmSync(dataDir, { recursive: true, force: true }); break } catch { await sleep(200) } }
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, async () => { await cleanup(); process.exit(130) })
// Last resort, e.g. an exception outside of any step: nothing may be left running.
process.on('exit', () => {
  if (cleaned) return
  signalAll('SIGKILL')
  if (browser?.pid) { try { process.kill(-browser.pid, 'SIGKILL') } catch {} }
  for (const dir of [dataDir, browser?.profile]) if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }
})

function start(name, args, env) {
  const proc = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
  const child = { proc, name, log: '' }
  proc.stderr.on('data', chunk => { child.log += chunk })
  proc.on('error', err => { child.log += `\n${err.message}` })
  children.push(child)
  return child
}

async function freePort() {
  for (;;) {
    const port = await new Promise((resolve, reject) => {
      const probe = net.createServer()
      probe.once('error', reject)
      probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)) })
    })
    // Never the ports of a real board, of server/test.mjs or of the demo.
    if (![8790, 8791, 8795].includes(port)) return port
  }
}

/** Follow the board's state as the server sends it, the same stream the page reads. */
async function watchState(base, cookie) {
  const stopper = new AbortController()
  const res = await fetch(`${base}/events`, { headers: { cookie }, signal: stopper.signal })
  if (!res.ok) throw new Error(`the board refused the test's own login: ${res.status}`)
  const watch = { state: null, stop: () => stopper.abort() }
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

/** A session without a script: the server's own MCP, spoken by hand. It posts one message with pictures. */
async function startHelper(env) {
  const child = start(HELPER, [path.join(ROOT, 'server', 'server.mjs')], { ...env, BOARD_AGENT: HELPER })
  const waiting = new Map()
  let seq = 0
  let buffer = ''
  child.proc.stdout.on('data', chunk => {
    buffer += chunk
    for (let at; (at = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, at).trim()
      buffer = buffer.slice(at + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.id != null && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id) }
    }
  })
  const write = msg => child.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq
    const timer = setTimeout(() => reject(new Error(`${HELPER}: no answer to ${method}`)), 10000)
    waiting.set(id, msg => { clearTimeout(timer); resolve(msg) })
    write({ id, method, params })
  })
  await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ui-test', version: '0' } })
  write({ method: 'notifications/initialized' })
  const tool = async (name, args) => {
    // Right after the start the session may not be linked to the hub yet.
    let last = ''
    for (let i = 0; i < 40; i++) {
      const out = await request('tools/call', { name, arguments: args })
      if (out.result && !out.result.isError) return
      last = out.error?.message ?? out.result?.content?.[0]?.text ?? ''
      await sleep(250)
    }
    throw new Error(`${HELPER}: ${name} failed: ${last}`)
  }
  await tool('introduce', { model: 'kein Modell', task: 'Bilder für den UI-Test zeigen' })
  await tool('reply', { text: 'Zwei Bilder für den Test.', attachments: ['thema-hell.png', 'thema-dunkel.png'].map(f => path.join(ROOT, 'demo', f)) })
}

// ---- the board under test --------------------------------------------------------

const PERSONAS = ['web', 'api', 'infra']
let base = ''
let token = ''
let port = 0

async function startBoard() {
  port = await freePort()
  token = crypto.randomBytes(12).toString('hex')
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trommi-ui-test-data-'))
  base = `http://127.0.0.1:${port}`
  const env = { ...process.env, BOARD_PORT: String(port), BOARD_HOST: '127.0.0.1', BOARD_DATA: dataDir, BOARD_TOKEN: token }
  // No speech: its buttons need a key and a service outside of this machine.
  delete env.TINFOIL_API_KEY
  delete env.BOARD_AGENT
  const cookie = `board_${port}=${token}`
  const until = async (what, fn, ms = 30000) => {
    const end = Date.now() + ms
    for (;;) {
      const value = await fn()
      if (value) return value
      const dead = children.find(c => !alive(c.proc))
      if (dead) throw new Error(`${dead.name} stopped while the board was starting:\n${dead.log}`)
      if (Date.now() > end) throw new Error(`the board did not come up: ${what}\n${children.map(c => `--- ${c.name}\n${c.log}`).join('\n')}`)
      await sleep(100)
    }
  }
  // One after the other, as dev/trio.sh does: the first becomes the hub, and the order of the sessions is fixed.
  for (const [i, who] of PERSONAS.entries()) {
    const child = start(who, [path.join(ROOT, 'dev', 'fake-agent.mjs'), who], env)
    if (i === 0) {
      await until('nothing answers on the port', () => fetch(`${base}/`).then(r => r.status === 401, () => false))
      watcher = await watchState(base, cookie)
    }
    await until(`session ${i + 1} is not listed`, () => watcher.state?.agents.length === i + 1)
    child.listed = true
  }
  await until('the scripted agents did not finish their start', () => children.every(c => c.log.includes('is up')), 45000)
  await startHelper(env)
  await until('the helper session posted nothing', () => watcher.state.messages.some(m => m.attachments?.length === 2))
}

const state = () => watcher.state
const nameOf = agent => agent.label || agent.name
const agentNamed = name => state().agents.find(a => a.name === name || a.label === name)
const cardOf = id => state().cards.find(c => c.id === id)
const openCards = agentId => state().queue.map(cardOf).filter(c => c && c.status === 'open' && (!agentId || c.agent === agentId))
const yesNo = card => card.kind === 'decision' && card.options.length === 2
const pictures = card => (card.attachments ?? []).filter(a => a.kind === 'image' || a.image)
const plain = text => String(text ?? '').replace(/[*`]/g, '')
const scripted = () => state().agents.filter(a => a.name !== HELPER)
const putOff = new Set()   // cards the test put off with "Später"

async function waitState(what, fn, ms = 8000) {
  const end = Date.now() + ms
  for (;;) {
    const value = fn(state())
    if (value) return value
    if (Date.now() > end) throw new Failed(`the server never reported: ${what}`)
    await sleep(40)
  }
}
/** The scripted agents close a card about five seconds after its answer; wait until none is on its way. */
const agentsIdle = () => waitState('the agents finished what they were doing', s => s.cards.every(c => c.status !== 'decided' || c.kind !== 'decision'), 12000)

// ---- the browser -----------------------------------------------------------------

let page = null
let touch = false
let size = 'desktop'
let shotDir = ''
let shotCount = 0
const problems = []            // uncaught errors and failed requests of the whole run
let tolerate = null            // while the refusal is tested: which failures are meant
const urlOf = new Map()        // request id -> url
const seen = []                // urls of every response, to wait for a request
let lastDocument = null        // status of the last page that was loaded
let redirects = []

const ours = url => String(url ?? '').startsWith(base)
function problem(kind, text, entry = {}) {
  if (tolerate?.(entry)) return
  problems.push(`${kind} (${size}, ${current?.name ?? 'between steps'}): ${text}`)
}

async function openBrowser() {
  // Headless Chromium reports no pointer at all; a desktop has a mouse that can hover. The page
  // depends on it (Enter sends only with a fine pointer). Touch emulation overrides it at phone size.
  browser = await launchChromium({ ...DESKTOP, args: ['--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2'] })
  page = await browser.page()
  page.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => problem('uncaught error', `${d.exception?.description ?? d.text} at ${d.url ?? ''}:${d.lineNumber ?? ''}`))
  page.on('Runtime.consoleAPICalled', p => {
    if (p.type === 'error' || p.type === 'assert') problem('console.error', p.args.map(a => a.value ?? a.description ?? '').join(' '))
  })
  page.on('Log.entryAdded', ({ entry }) => {
    // The fonts come from another host, which the test blocks; that is not the board's failure.
    if (entry.level !== 'error' || (entry.url && !ours(entry.url))) return
    problem('browser error', `${entry.text} ${entry.url ?? ''}`, { status: Number(/status of (\d+)/.exec(entry.text)?.[1]) || 0, url: entry.url })
  })
  page.on('Network.requestWillBeSent', p => {
    urlOf.set(p.requestId, p.request.url)
    if (p.redirectResponse) redirects.push({ status: p.redirectResponse.status, from: p.redirectResponse.url, to: p.request.url })
  })
  page.on('Network.responseReceived', p => {
    const { status, url } = p.response
    seen.push(url)
    if (p.type === 'Document') lastDocument = { status, url }
    if (ours(url) && (status < 200 || status > 299)) problem('failed request', `${status} ${url}`, { status, url })
  })
  page.on('Network.loadingFailed', p => {
    const url = urlOf.get(p.requestId)
    // Cancelled: the page was reloaded while its event stream was open. Blocked: the fonts.
    if (p.canceled || p.blockedReason || !ours(url)) return
    problem('failed request', `${p.errorText} ${url}`, { url })
  })
  for (const domain of ['Page', 'Runtime', 'Network', 'Log']) await page.send(`${domain}.enable`)
  // The test must not depend on the internet; the page then uses its fallback fonts.
  await page.send('Network.setBlockedURLs', { urls: ['*fonts.googleapis.com*', '*fonts.gstatic.com*'] })
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_LIB })
  await setSize('desktop')
}

async function setSize(which) {
  size = which
  touch = which === 'phone'
  const { width, height } = touch ? PHONE : DESKTOP
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: touch ? 2 : 1, mobile: touch })
  await page.send('Emulation.setTouchEmulationEnabled', touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false })
}

/** Run an expression in the page and return its value. */
async function ev(expression) {
  const res = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (res.exceptionDetails) throw new Error(`in the page: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}\n  ${expression}`)
  return res.result.value
}
/** js`__t.row(${id})`: an expression for the page with the values safely written in. */
const js = (parts, ...values) => parts.reduce((out, part, i) => out + JSON.stringify(values[i - 1]) + part)

async function waitFor(what, expression, ms = 8000) {
  const end = Date.now() + ms
  for (;;) {
    const value = await ev(expression)
    if (value) return value
    if (Date.now() > end) throw new Failed(`waited ${ms / 1000} s in vain: ${what}`)
    await sleep(40)
  }
}
/** Wait until nothing slides or fades any more, so that positions mean something. */
async function settle() {
  for (let i = 0; i < 60; i++) {
    if (await ev('__t.still()')) break
    await sleep(40)
  }
  await ev('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))')
}

let lastTouch = 0
async function pressAt(x, y, { move = true } = {}) {
  if (touch) {
    // A finger: it stays down for a moment, and two touches never follow each other within
    // the time in which Chromium would read them as one double tap and swallow the click.
    await sleep(Math.max(0, lastTouch + 350 - Date.now()))
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    await sleep(50)
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    lastTouch = Date.now()
    return
  }
  if (move) await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}
/** Click (or tap, at phone size) the element an expression names, the way a hand would: at a point of the screen. */
async function press(what, expression) {
  await settle()
  const at = await ev(`__t.point(${expression})`)
  if (at.error) throw new Failed(`cannot press ${what}: ${at.error}`)
  await pressAt(at.x, at.y)
  return at
}
async function key(name, code, extra = {}) {
  const event = { key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, ...extra }
  await page.send('Input.dispatchKeyEvent', { type: extra.text ? 'keyDown' : 'rawKeyDown', ...event })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
}
const type = text => page.send('Input.insertText', { text })
/** Replace whatever the focused field holds. */
async function retype(text) {
  await key('a', 65, { modifiers: 2, commands: ['selectAll'] })
  await type(text)
}

/** Draw one line with the mouse or a finger through points of the screen. */
async function draw(points) {
  const [first, ...rest] = points
  if (touch) {
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first] })
    for (const p of rest) { await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] }); await sleep(16) }
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    lastTouch = Date.now()
    return
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...first })
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...first, button: 'left', buttons: 1, clickCount: 1 })
  for (const p of rest) { await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p, button: 'left', buttons: 1 }); await sleep(16) }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rest.at(-1), button: 'left', clickCount: 1 })
}

async function shot(name) {
  const file = path.join(shotDir, `${String(++shotCount).padStart(2, '0')}-${size}-${name}.png`)
  try {
    const out = await page.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(file, Buffer.from(out.data, 'base64'))
  } catch (err) {
    console.log(`      (no screenshot ${name}: ${err.message})`)
  }
}

/** Load a URL, or the current page again, and wait for the browser to finish. Returns the page's HTTP status. */
async function load(url) {
  lastDocument = null
  redirects = []
  const loaded = new Promise(resolve => { const off = page.on('Page.loadEventFired', () => { off(); resolve() }) })
  if (url) await page.send('Page.navigate', { url })
  else await page.send('Page.reload')
  await Promise.race([loaded, sleep(15000)])
  return lastDocument?.status ?? 0
}
const appReady = () => waitFor('the page shows the state of the board', js`!!document.querySelector(${SEL.loaded}) && !!document.querySelector(${SEL.online})`, 15000)
async function reload() {
  await load()
  await appReady()
}

// ---- moving around ---------------------------------------------------------------

async function goInbox() {
  if (await ev('__t.focusOpen()')) { await key('Escape', 27); await waitFor('the full-page view closes', '!__t.focusOpen()') }
  await press('the inbox in the sidebar', js`__t.sidebar(${TEXT.inbox})`)
  await waitFor('the inbox shows its rows', js`__t.vis(document.querySelector(${SEL.inbox})) && __t.rows().length > 0`)
  await settle()
}
async function goSession(agent) {
  await press(`the session "${nameOf(agent)}" in the sidebar`, js`__t.sidebar(${nameOf(agent)})`)
  await waitFor(`the conversation of "${nameOf(agent)}" opens`, js`__t.vis(document.querySelector(${SEL.log})) && __t.all(${SEL.message}).length > 0`)
  await settle()
}
async function goRoster() {
  await press('the agents page', js`__t.one(${SEL.rosterNav})`)
  await waitFor('the agents page lists the sessions', js`__t.vis(document.querySelector(${SEL.roster})) && __t.roster().length > 0`)
  await settle()
}
async function mode(view) {
  // On a phone the tab bar steps aside while the keyboard is up; a tap on the conversation puts it away.
  if (touch && !(await ev(js`!!__t.one(${SEL.modeButton(view)})`))) {
    const box = await ev(js`__t.box(document.querySelector(${SEL.log}))`)
    await pressAt(Math.round(box.left + box.width / 2), Math.round(box.top + 30))
    await waitFor('the tab bar returns once the keyboard is away', js`!!__t.one(${SEL.modeButton(view)})`, 3000)
  }
  await press(`the "${view}" mode of the session`, js`__t.one(${SEL.modeButton(view)})`)
  await waitFor(`the session shows its "${view}" mode`, js`document.body.dataset.view === ${view}`)
  await settle()
}
async function noOverflow(where) {
  const out = await ev('__t.overflow()')
  check(out.length === 0, `${where}: the page is wider than the phone: ${out.join('; ')}`)
}

/** The rows of a list: same height, and two answer tiles at the right edge of each. */
async function checkRows(root, where, { sameHeight = true } = {}) {
  const rows = await ev(js`__t.rows(${root})`)
  need(rows.length > 0, `${where}: there are no rows`)
  if (sameHeight) {
    const heights = [...new Set(rows.map(r => Math.round(r.box.height)))]
    check(heights.length === 1, `${where}: the rows differ in height: ${rows.map(r => `"${r.title.slice(0, 24)}" ${r.box.height}px`).join(', ')}`)
  }
  for (const row of rows) {
    const card = cardOf(row.id)
    const short = `${where}, "${row.title.slice(0, 40)}"`
    if (!check(row.tiles.length === 2, `${short}: expected two answer tiles, found ${row.tiles.length} (${row.tiles.map(t => t.name).join(', ')})`)) continue
    const [left, right] = row.tiles
    check(left.box.right <= right.box.left + 1 && same(left.box.top, right.box.top), `${short}: the two tiles do not stand side by side`)
    check(right.box.right <= row.box.right + 1 && row.box.right - right.box.right <= 24, `${short}: the right tile ends ${Math.round(row.box.right - right.box.right)}px before the right edge of the row`)
    check(same(right.box.left, rows[0].tiles.at(-1).box.left) && same(right.box.right, rows[0].tiles.at(-1).box.right), `${short}: its right tile is not in line with the one of the first row`)
    if (!card) { check(false, `${short}: the server knows no card ${row.id}`); continue }
    check(row.title === card.title, `${short}: the row shows another title than its card "${card.title}"`)
    const names = [left.name, right.name]
    // The option the agent leads with is the yes, and it stands on the right.
    const expected = yesNo(card) ? [card.options[1].label, card.options[0].label] : [putOff.has(card.id) ? TEXT.back : TEXT.later, TEXT.more]
    check(names[0] === expected[0] && names[1] === expected[1], `${short}: tiles read "${names.join('" | "')}", expected "${expected.join('" | "')}"`)
  }
  return rows
}

// ---- the steps -------------------------------------------------------------------

async function stepLogin() {
  // Without the cookie nothing is served, to a program as little as to a browser.
  for (const url of ['/', '/events', '/js/app.js', '/?t=wrong']) {
    const res = await fetch(base + url, { redirect: 'manual' })
    check(res.status === 401, `GET ${url} without the cookie answered ${res.status}, expected 401`)
  }
  tolerate = entry => entry.status === 401
  const refused = await load(`${base}/`)
  check(refused === 401, `the browser got ${refused} for the page without a login, expected 401`)
  check(!(await ev('!!document.querySelector("#agents")')), 'the page was served without a login')
  await shot('refused')
  const cookiesBefore = (await page.send('Network.getCookies', { urls: [base] })).cookies
  check(cookiesBefore.length === 0, `a cookie was set without the token: ${cookiesBefore.map(c => c.name).join(', ')}`)
  tolerate = null

  const status = await load(`${base}/?t=${token}`)
  check(status === 200, `the login link ended in status ${status}`)
  check(redirects.some(r => r.status === 302), 'the login link did not redirect')
  check(await ev('location.pathname + location.search') === '/', `after the login the address still carries the token: ${await ev('location.href')}`)
  const { cookies } = await page.send('Network.getCookies', { urls: [base] })
  const cookie = cookies.find(c => c.value === token)
  if (check(cookie, 'the login link set no cookie with the token')) {
    check(cookie.httpOnly, 'the login cookie can be read by scripts (not HttpOnly)')
    check(cookie.name === `board_${port}`, `the cookie is called ${cookie.name}, expected board_${port}`)
  }
  await appReady()
  // The cookie alone is enough from now on.
  check(await load(`${base}/`) === 200, 'the page is refused although the cookie is set')
  await appReady()
  check((await ev('__t.sidebarNames()')).length >= scripted().length + 1, 'the sidebar does not list the sessions')
  await shot('logged-in')
}

async function stepInbox() {
  await goInbox()
  // Groups per sender, each with exactly the open questions of that session.
  const groups = await ev('__t.groups()')
  const expected = state().agents.map(a => ({ name: nameOf(a), ids: openCards(a.id).map(c => c.id) })).filter(g => g.ids.length)
  check(groups.length === expected.length, `the inbox has ${groups.length} groups, but ${expected.length} sessions have open questions`)
  for (const want of expected) {
    const got = groups.find(g => g.name.replace(/^★ /, '') === want.name)
    if (!check(got, `no group for the sender "${want.name}"`)) continue
    check([...got.ids].sort().join() === [...want.ids].sort().join(), `the group "${want.name}" shows ${got.ids.length} rows, the session has ${want.ids.length} open questions`)
    check(parseInt(got.count, 10) === want.ids.length, `the group "${want.name}" counts "${got.count}", expected ${want.ids.length}`)
  }
  const rows = await checkRows(SEL.inbox, 'inbox')
  await shot('inbox')

  // One click answers. Two yes/no rows that follow each other, so that the second can be answered without moving the mouse.
  const groupOf = id => groups.find(g => g.ids.includes(id))
  const quick = i => rows[i] && yesNo(cardOf(rows[i].id))
  const follows = i => rows[i + 1] && groupOf(rows[i + 1].id) === groupOf(rows[i].id)
  let at = rows.findIndex((_, i) => quick(i) && follows(i) && quick(i + 1) && follows(i + 1))
  const twice = at >= 0
  if (!twice) at = rows.findIndex((_, i) => quick(i) && follows(i))
  need(at >= 0, 'no yes/no row is followed by another row of the same sender; the fixture changed')
  const first = cardOf(rows[at].id)
  const point = await press(`"${first.options[0].label}" on "${first.title}"`, js`__t.tile(${first.id}, 'right')`)
  await waitState(`"${first.title}" is decided`, () => cardOf(first.id).status !== 'open')
  check(cardOf(first.id).choice === first.options[0].key, `one click on "${first.options[0].label}" chose "${cardOf(first.id).choice}"`)
  await waitFor(`the answered row "${first.title}" leaves the inbox`, js`!__t.row(${first.id})`)
  await settle()
  await shot('inbox-answered')

  // The hard requirement: without moving the mouse, the next right-hand tile is where the last one was.
  const under = async (answered, nth) => {
    const now = await ev(js`__t.tileAt(${point.x}, ${point.y})`)
    const where = `after the ${nth} answer, at the unmoved mouse (${point.x},${point.y})`
    if (!check(now.row, `${where} there is no answer tile but ${now.hit}`)) return null
    check(now.row !== answered, `${where} the answered row is still there`)
    check(now.right, `${where} lies the left tile "${now.name}", not the right one`)
    check(same(now.box.left, point.box.left) && same(now.box.top, point.box.top) && same(now.box.width, point.box.width) && same(now.box.height, point.box.height),
      `${where} the next right-hand tile is not where the last one was: it moved by ${Math.round(now.box.left - point.box.left)}px across and ${Math.round(now.box.top - point.box.top)}px down`)
    return now
  }
  let next = await under(first.id, 'first')
  let last = first
  if (twice && next?.right) {
    const second = cardOf(next.row)
    await pressAt(point.x, point.y, { move: false })
    await waitState(`"${second.title}" is decided by a second click on the same spot`, () => cardOf(second.id).status !== 'open')
    await waitFor(`the second answered row "${second.title}" leaves the inbox`, js`!__t.row(${second.id})`)
    await settle()
    await under(second.id, 'second')
    last = second
  }

  // The undo bar names the answer and takes it back.
  const bar = await ev(js`(n => n && { text: __t.text(n) })(__t.one(${SEL.undoBar}))`)
  if (check(bar, 'no undo bar after an answer')) {
    check(bar.text.includes(last.options[0].label), `the undo bar reads "${bar.text}", expected the answer "${last.options[0].label}"`)
    // The scripted agent closes the card a few seconds after the answer; wait for that, so the undo is not raced by it.
    await waitState(`the agent finished "${last.title}"`, () => cardOf(last.id).status === 'done', 9000)
    await shot('inbox-undo-bar')
    await press('undo in the undo bar', js`__t.byText('button', ${TEXT.undo}, __t.one(${SEL.undoBar}))`)
    await waitState(`"${last.title}" is open again`, () => cardOf(last.id).status === 'open')
    await waitFor(`undo brings the row "${last.title}" back`, js`!!__t.row(${last.id})`)
    check(cardOf(last.id).choice == null, 'the reopened card still carries its old answer')
    await waitFor('the undo bar goes away after undo', js`!__t.one(${SEL.undoBar})`, 3000).catch(e => check(false, e.message))
  }
  await settle()

  // "Später": the row leaves its sender and sinks to the very end of the list; a reload keeps it there.
  const now = await ev('__t.rows()')
  const laterRow = now.find((r, i) => !yesNo(cardOf(r.id)) && i < now.length - 1)
  need(laterRow, 'no row with "Später" has another row after it; the fixture changed')
  const sender = nameOf(state().agents.find(a => a.id === cardOf(laterRow.id).agent))
  const inGroup = name => js`!!__t.groups().find(g => g.name.replace(/^★ /, '') === ${name})?.ids.includes(${laterRow.id})`
  await press(`"${TEXT.later}" on "${laterRow.title}"`, js`__t.tile(${laterRow.id}, 'left')`)
  putOff.add(laterRow.id)
  await waitFor(`"${TEXT.later}" moves "${laterRow.title}" to the end of the list`, js`__t.rows().at(-1).id === ${laterRow.id}`, 3000)
  check(!(await ev(inGroup(sender))), `the row put off still stands among the questions of "${sender}"`)
  check(cardOf(laterRow.id).status === 'open', `"${TEXT.later}" answered the card`)
  await settle()
  await checkRows(SEL.inbox, `inbox after "${TEXT.later}"`)
  await shot('inbox-later')
  await reload()
  await goInbox()
  check(await ev(js`__t.rows().at(-1).id === ${laterRow.id}`), `after a reload the row put off with "${TEXT.later}" is no longer at the end of the list`)
  // The same tile fetches it back.
  await press(`"${TEXT.back}" on "${laterRow.title}"`, js`__t.tile(${laterRow.id}, 'left')`)
  putOff.delete(laterRow.id)
  await waitFor(`"${TEXT.back}" returns the row to the questions of "${sender}"`, inGroup(sender), 3000)
  await settle()
  await checkRows(SEL.inbox, `inbox after "${TEXT.back}"`)

  // "Mehr": the full-page view opens on that card.
  const moreRow = (await ev('__t.rows()')).find(r => !yesNo(cardOf(r.id)) && r.id !== laterRow.id)
  await press(`"${TEXT.more}" on "${moreRow.title}"`, js`__t.tile(${moreRow.id}, 'right')`)
  await waitFor('the full-page view opens', '__t.focusOpen() && !!__t.focusState().id')
  const shown = await ev('__t.focusState()')
  check(shown.id === moreRow.id, `"${TEXT.more}" on "${moreRow.title}" opened the card "${shown.title}"`)
  await shot('inbox-more')
  await key('Escape', 27)
  await waitFor('Escape closes the full-page view', '!__t.focusOpen()')
}

async function stepFocus() {
  await goInbox()
  await press('the button that opens the full-page view', js`__t.one(${SEL.focusOpen})`)
  await waitFor('the full-page view opens', '__t.focusOpen() && !!__t.focusState().id')
  await settle()
  const first = await ev('__t.focusState()')
  const open = openCards().length
  const countBefore = await ev('__t.openCount()')
  check(countBefore === open, `the page counts ${countBefore} open questions, ${open} are open`)
  check(first.id === state().queue[0], `the view starts at "${first.title}", not at the most urgent card "${cardOf(state().queue[0])?.title}"`)
  const behind = await ev('__t.reachableBehind()')
  check(behind.length === 0, `the page behind the full-page view is not inert: ${behind.join('; ')}`)
  await shot('focus-open')

  // Walk to a card the later steps do not need: no picture, and not of the session step 4 opens.
  const keep = scripted()[0].id
  const spare = c => c && !pictures(c).length && c.agent !== keep && !yesNo(c)
  let before = first
  for (let i = 1; i < open && !spare(cardOf(before.id)); i++) {
    await key('ArrowRight', 39)
    before = await waitFor('the arrow key shows the next card', js`(s => s.id !== ${before.id} && s)(__t.focusState())`, 3000)
    await settle()
  }
  const card = cardOf(before.id)
  need(spare(card), 'no open card with several options and no picture is left; the fixture changed')
  check(before.title === card.title, `the view shows "${before.title}" for the card "${card.title}"`)
  check(before.options.length === card.options.length, `the card shows ${before.options.length} options, it has ${card.options.length}`)

  // One click decides and the next card comes up.
  const option = card.options[0]
  await press(`the option "${option.label}"`, js`__t.all(${SEL.focusOption}, __t.one(${SEL.focusCard})).find(n => __t.label(n).startsWith(${option.label}))`)
  await waitState(`"${card.title}" is decided`, () => cardOf(card.id).status !== 'open')
  check(cardOf(card.id).choice === option.key, `one click on "${option.label}" chose "${cardOf(card.id).choice}"`)
  await waitFor('the view advances to another card', js`(s => s && s.id && s.id !== ${card.id})(__t.focusState())`)
  await settle()
  const after = await ev('__t.focusState()')
  const countAfter = await waitFor('the count of open questions goes down', js`__t.openCount() === ${countBefore - 1} && __t.openCount()`, 3000).catch(() => ev('__t.openCount()'))
  check(countAfter === countBefore - 1, `the count of open questions went from ${countBefore} to ${countAfter}, expected ${countBefore - 1}`)
  check(cardOf(after.id)?.status === 'open', `the view advanced to "${after.title}", which is not open`)
  await shot('focus-advanced')

  await key('Escape', 27)
  await waitFor('Escape closes the full-page view', '!__t.focusOpen()')
  await waitFor('the page behind works again', js`![...document.body.children].some(n => n.inert && __t.vis(n))`, 2000)
  await waitFor('the decided card left the inbox', js`!__t.row(${card.id})`)
}

async function stepSession() {
  await agentsIdle()
  const agent = scripted()[0]
  const others = scripted().slice(1)
  await goSession(agent)
  // Its conversation, and only its own.
  const intro = s => plain(state().messages.find(m => m.agent === s.id && m.from === 'agent')?.text).slice(0, 30)
  const log = await ev(js`__t.text(document.querySelector(${SEL.log}))`)
  check((await ev(js`__t.text(document.querySelector(${SEL.paneTitle}))`)).includes(nameOf(agent)) || touch, `the pane is not titled "${nameOf(agent)}"`)
  check(log.includes(intro(agent)), `the conversation of "${nameOf(agent)}" lacks its first message "${intro(agent)}"`)
  for (const other of others) check(!log.includes(intro(other)), `the conversation of "${nameOf(agent)}" shows a message of "${nameOf(other)}"`)

  // A message goes out and the scripted agent answers it.
  const said = `Regressionstest ${size} ${crypto.randomBytes(3).toString('hex')}`
  await press('the message field', js`document.querySelector(${SEL.draft})`)
  await retype(said)
  await waitFor('typing enables send', js`!document.querySelector(${SEL.send}).disabled`, 2000)
  if (touch) await press('send', js`document.querySelector(${SEL.send})`)
  else await key('Enter', 13, { text: '\r' })
  await waitFor('the sent message appears in the conversation', js`!!__t.byText(${SEL.userMessage}, ${said})`)
  check(await ev(js`document.querySelector(${SEL.draft}).value`) === '', 'the message field was not emptied after sending')
  await waitFor('the scripted reply appears', js`!!__t.byText(${SEL.agentMessage}, ${`Verstanden: „${said}“`})`, 10000)
  await shot('session-chat')
  if (touch) await noOverflow('conversation')

  // Open questions stand in the conversation and are answered there.
  const mine = openCards(agent.id)
  const asks = await ev('__t.asks()')
  check(asks.length === mine.length, `the conversation shows ${asks.length} open questions, the session has ${mine.length}`)
  for (const c of mine) check(asks.some(a => a.title === c.title), `the open question "${c.title}" is missing in the conversation`)
  if (!touch) check(parseInt(await ev(js`__t.text(document.querySelector(${SEL.modeCount}))`), 10) === mine.length, 'the count next to "Fragen" differs from the open questions')
  const card = mine.find(c => !pictures(c).length && !yesNo(c)) ?? mine.find(c => !pictures(c).length)
  need(card, `"${nameOf(agent)}" has no open question without pictures left; the fixture changed`)
  const option = card.options.at(-1)
  await press(`"${option.label}" on the question "${card.title}" in the conversation`, js`__t.byText(${SEL.askOption}, ${option.label}, __t.ask(${card.title}))`)
  await waitState(`"${card.title}" is decided`, () => cardOf(card.id).status !== 'open')
  check(cardOf(card.id).choice === option.key, `one click on "${option.label}" chose "${cardOf(card.id).choice}"`)
  await waitFor('the answered question is no longer offered in the conversation', js`!__t.ask(${card.title})`)
  await waitFor('the scripted agent confirms the answer', js`!!__t.byText(${SEL.agentMessage}, ${`ich setze ${option.key} um`})`, 10000)
  await shot('session-answered-inline')

  // Fragen: the session's open cards, in the same rows as the inbox.
  await mode('decisions')
  const left = openCards(agent.id)
  await waitFor('the questions of the session are listed', js`__t.rows(${SEL.sessionCards}).length === ${left.length}`)
  const rows = await checkRows(SEL.sessionCards, 'Fragen', { sameHeight: !touch })
  check(rows.map(r => r.id).sort().join() === left.map(c => c.id).sort().join(), 'Fragen does not list exactly the open cards of the session')
  const thumbs = await ev(js`__t.pictures(${`${SEL.sessionCards} ${SEL.rowThumb}`})`)
  check(thumbs.length >= left.filter(c => pictures(c).length).length, 'a card with pictures shows none of them in Fragen')
  for (const t of thumbs) check(t.width > 0, `a picture in Fragen did not load: ${t.src} in ${t.in}`)
  await shot('session-questions')
  if (touch) await noOverflow('Fragen')

  // Scribble: draw, send, and find the picture in the conversation.
  const loadsBefore = seen.filter(u => u.includes('/canvas?')).length
  const sent = () => state().messages.filter(m => m.agent === agent.id && m.attachments?.some(a => a.kind === 'scribble')).length
  const cardsBefore = sent()
  await mode('scribble')
  await waitFor('the canvas appears', js`(n => !!n && n.getBoundingClientRect().width > 200)(__t.one(${SEL.scribbleCanvas})) && !!document.querySelector(${SEL.scribbleSend})`)
  // The stored canvas arrives a moment later and would replace a stroke drawn before it.
  const end = Date.now() + 5000
  while (seen.filter(u => u.includes('/canvas?')).length === loadsBefore && Date.now() < end) await sleep(40)
  await sleep(150)
  if (!cardsBefore) check(await ev(js`document.querySelector(${SEL.scribbleSend}).disabled`), 'send is enabled on an empty canvas')
  const box = await ev(js`__t.box(__t.one(${SEL.scribbleCanvas}))`)
  const stroke = Array.from({ length: 12 }, (_, i) => ({
    x: Math.round(box.left + box.width * (0.3 + i * 0.035)),
    y: Math.round(box.top + box.height * (0.62 + (i % 2 ? 0.05 : -0.05))),
  }))
  check(await ev(js`document.elementFromPoint(${stroke[0].x}, ${stroke[0].y}) === __t.one(${SEL.scribbleCanvas})`), 'the canvas is covered where the stroke starts')
  await ev(js`(window.__ev = [], ['touchstart','touchend','touchcancel','pointerdown','pointerup','pointercancel','click','lostpointercapture'].forEach(t => document.addEventListener(t, e => window.__ev.push(Math.round(performance.now()) + ' ' + t + ':' + e.target.tagName + (e.pointerId ?? '')), true)))`)
  await draw(stroke)
  for (const ms of [0, 200, 600]) { await sleep(ms); console.log('DEBUG draw+' + ms, await ev('JSON.stringify(window.__ev)')) }
  await waitFor('a stroke enables send', js`!document.querySelector(${SEL.scribbleSend}).disabled`, 3000)
  await shot('session-scribble')
  if (touch) await noOverflow('Scribble')
  await press('send on the canvas', js`document.querySelector(${SEL.scribbleSend})`)
  await sleep(800); console.log('DEBUG send', await ev(js`JSON.stringify([window.__ev, document.querySelector(${SEL.scribbleSend}).dataset.state, document.body.dataset.view])`))
  await waitState('the scribble reached the server', () => sent() === cardsBefore + 1, 10000)
  await waitFor('sending returns to the conversation', js`document.body.dataset.view === 'chat' && __t.vis(document.querySelector(${SEL.log}))`, 10000)
  await waitFor('the scribble appears in the conversation', js`__t.all(${SEL.scribbleCard}).length === ${cardsBefore + 1}`)
  const drawn = await ev(js`__t.pictures(${`${SEL.scribbleCard} img`})`)
  for (const d of drawn) check(d.width > 0, `the scribble in the conversation did not load: ${d.src}`)
  await waitFor('the scripted agent confirms the scribble', js`__t.all(${SEL.agentMessage}).filter(n => __t.text(n).includes('Scribble erhalten')).length === ${cardsBefore + 1}`, 10000)
  await shot('session-scribble-sent')
}

async function stepAgents() {
  await agentsIdle()
  await goRoster()
  const cards = await ev('__t.roster()')
  check(cards.length === state().agents.length, `the agents page lists ${cards.length} sessions, the board has ${state().agents.length}`)
  for (const agent of state().agents) {
    const card = cards.find(c => c.name === nameOf(agent))
    if (!check(card, `the agents page lacks the session "${nameOf(agent)}"`)) continue
    check(card.facts[TEXT.model] === agent.model, `"${nameOf(agent)}" shows the model "${card.facts[TEXT.model]}", it introduced itself as "${agent.model}"`)
    const machine = card.facts[TEXT.machine] ?? ''
    check(machine && machine !== TEXT.unknown && machine.includes(agent.host), `"${nameOf(agent)}" shows the machine "${machine}", it runs on "${agent.host}"`)
  }
  await shot('agents')

  // Rename a session and give it another mark.
  const target = scripted()[1]
  const oldName = nameOf(target)
  const newName = 'Schnittstelle'
  const oldMark = cards.find(c => c.name === oldName).mark
  await press(`"Ändern" on "${oldName}"`, js`__t.rosterCard(${oldName}).querySelector(${SEL.rosterChange})`)
  await waitFor('the editor opens', js`!!__t.one(${SEL.editor})`)
  await press('the name field', js`__t.one(${SEL.editorName})`)
  await retype(newName)
  await press('another mark', js`__t.all(${SEL.editorMark}).find(n => n.getAttribute('aria-checked') !== 'true')`)
  await shot('agents-editor')
  await press('save', js`__t.one(${SEL.editorSave})`)
  await waitFor('the editor closes', js`!__t.one(${SEL.editor})`)
  await waitFor(`the session is listed as "${newName}"`, js`!!__t.rosterCard(${newName})`)
  const renamed = (await ev('__t.roster()')).find(c => c.name === newName)
  check(renamed.mark && renamed.mark !== oldMark, 'the session kept its old mark')
  check(await ev(js`!!__t.sidebar(${newName}) && !__t.sidebar(${oldName})`), `the sidebar does not show the new name "${newName}"`)

  // Star a session whose questions are not on top.
  const groups = await (async () => { await goInbox(); return ev('__t.groups()') })()
  const vip = scripted().findLast(a => nameOf(a) !== groups[0].name.replace(/^★ /, '') && openCards(a.id).length)
  need(vip, 'no session with open questions below the first group; the fixture changed')
  await goRoster()
  await press(`the star of "${nameOf(vip)}"`, js`__t.rosterCard(${nameOf(vip)}).querySelector(${SEL.rosterStar})`)
  await waitState(`"${nameOf(vip)}" is starred`, s => s.agents.find(a => a.id === vip.id).starred)
  await waitFor('the star shows as set', js`__t.roster().find(c => c.name === ${nameOf(vip)}).starred`)

  await reload()
  await goRoster()
  const again = await ev('__t.roster()')
  const kept = again.find(c => c.name === newName)
  if (check(kept, `after a reload the session is no longer called "${newName}": ${again.map(c => c.name).join(', ')}`)) check(kept.mark === renamed.mark, 'after a reload the session has another mark than the chosen one')
  check(again.find(c => c.name === nameOf(vip))?.starred, 'after a reload the star is gone')
  await shot('agents-renamed-starred')

  await goInbox()
  const top = (await ev('__t.groups()'))[0]
  check(top.name.replace(/^★ /, '') === nameOf(vip), `the starred session "${nameOf(vip)}" is not the first group of the inbox, "${top.name}" is`)
  check(top.name.startsWith('★'), 'the group of the starred session carries no star')
  check((await ev('__t.rows()')).filter(r => top.ids.includes(r.id)).every(r => r.vip), 'the rows of the starred session are not marked VIP')
  await shot('inbox-starred')
}

async function stepTheme() {
  await goInbox()
  const theme = () => ev('document.documentElement.dataset.theme ?? "light"')
  const paper = () => ev('getComputedStyle(document.body).backgroundColor')
  const start = await theme()
  const startPaper = await paper()
  const other = start === 'dark' ? 'light' : 'dark'
  await press('the theme toggle', js`document.querySelector(${SEL.themeToggle})`)
  await waitFor(`the toggle switches to ${other}`, js`(document.documentElement.dataset.theme ?? 'light') === ${other}`, 2000)
  await settle()
  check(await paper() !== startPaper, 'the page looks the same in both themes')
  check(await ev(js`document.querySelector(${SEL.themeToggle}).getAttribute('aria-pressed')`) === String(other === 'dark'), 'the toggle does not say which theme is on')
  await reload()
  check(await theme() === other, `after a reload the theme is ${await theme()} again`)
  await shot(`theme-${other}`)
  await press('the theme toggle', js`document.querySelector(${SEL.themeToggle})`)
  await waitFor(`the toggle switches back to ${start}`, js`(document.documentElement.dataset.theme ?? 'light') === ${start}`, 2000)
  await reload()
  check(await theme() === start, `after switching back and a reload the theme is ${await theme()}`)
}

async function stepImages() {
  await goInbox()
  // In the rows of the inbox.
  const withPictures = openCards().filter(c => pictures(c).length)
  need(withPictures.length, 'no open card with pictures is left; the fixture changed')
  const thumbs = await ev(js`__t.pictures(${`${SEL.inbox} ${SEL.rowThumb}`})`)
  for (const card of withPictures) check(await ev(js`__t.all(${SEL.rowThumb}, __t.row(${card.id})).length > 0`), `the row "${card.title}" shows none of its ${pictures(card).length} pictures`)
  for (const t of thumbs) check(t.width > 0, `a picture in the inbox did not load: ${t.src} in ${t.in}`)
  await shot('images-inbox')

  // On the card as a full page.
  const card = withPictures[0]
  await press(`"${TEXT.more}" on "${card.title}"`, js`__t.tile(${card.id}, 'right')`)
  await waitFor('the full-page view opens on the card with pictures', js`__t.focusOpen() && __t.focusState().id === ${card.id}`)
  await settle()
  const large = await ev(js`__t.pictures(${`${SEL.focusCard} img`})`)
  check(large.length > 0, 'the card shows no picture as a full page')
  for (const t of large) check(t.width > 0, `a picture of the card did not load: ${t.src}`)
  await shot('images-card')
  await key('Escape', 27)
  await waitFor('Escape closes the full-page view', '!__t.focusOpen()')

  // In a conversation: the pictures an agent attached to a message.
  const helper = agentNamed(HELPER)
  await goSession(helper)
  const attached = state().messages.find(m => m.agent === helper.id && m.attachments?.length).attachments
  await waitFor('the message shows its pictures', js`__t.all(${SEL.messageImage}).length === ${attached.length}`, 4000)
  const shown = await ev(js`__t.pictures(${SEL.messageImage})`)
  for (const t of shown) check(t.width > 0, `a picture attached to a message did not load: ${t.src}`)
  await shot('images-conversation')
  // And every picture of the conversation that step 4 left behind, the scribble among them.
  await goSession(scripted()[0])
  const rest = await ev(js`__t.pictures(${`${SEL.log} img`})`)
  for (const t of rest) check(t.width > 0, `a picture in the conversation did not load: ${t.src} in ${t.in}`)
}

async function stepPhone() {
  await setSize('phone')
  await reload()
  check(await ev('matchMedia("(max-width: 860px)").matches && innerWidth') === PHONE.width, `the page is ${await ev('innerWidth')}px wide, expected ${PHONE.width}`)
  await goInbox()
  await checkRows(SEL.inbox, 'inbox on the phone', { sameHeight: false })
  await noOverflow('inbox')
  await shot('inbox')

  // Answer in the inbox with one tap.
  const card = openCards().find(yesNo)
  need(card, 'no yes/no question is left for the phone; the fixture changed')
  await press(`"${card.options[0].label}" on "${card.title}"`, js`__t.tile(${card.id}, 'right')`)
  await waitState(`"${card.title}" is decided by a tap`, () => cardOf(card.id).status !== 'open')
  check(cardOf(card.id).choice === card.options[0].key, `one tap on "${card.options[0].label}" chose "${cardOf(card.id).choice}"`)
  await waitFor('the answered row leaves the inbox', js`!__t.row(${card.id})`)
  check(await ev(js`!!__t.one(${SEL.undoBar})`), 'no undo bar after an answer on the phone')
  await settle()
  await noOverflow('inbox after an answer')
  await shot('inbox-answered')

  // "Mehr" opens the card as a full page, which must fit as well.
  const more = openCards().find(c => !yesNo(c))
  if (more) {
    await press(`"${TEXT.more}" on "${more.title}"`, js`__t.tile(${more.id}, 'right')`)
    await waitFor('the full-page view opens on the phone', js`__t.focusOpen() && __t.focusState().id === ${more.id}`)
    await settle()
    await noOverflow('full-page view')
    await shot('focus')
    await key('Escape', 27)
    await waitFor('the full-page view closes', '!__t.focusOpen()')
  }

  // A session: conversation, message, the three modes.
  await stepSession()
  await mode('chat')
  await noOverflow('conversation after the modes')

  await goRoster()
  check((await ev('__t.roster()')).length === state().agents.length, 'the agents page does not list every session on the phone')
  await noOverflow('agents page')
  await shot('agents')
}

function stepErrors() {
  for (const p of problems) check(false, p)
}

// ---- main ------------------------------------------------------------------------

async function step(name, fn) {
  if (only.length && !only.some(word => name.toLowerCase().includes(word.toLowerCase())) && !/login/.test(name)) return
  current = { name, failures: [], ms: 0 }
  const began = Date.now()
  try {
    await fn()
  } catch (err) {
    current.failures.push(err instanceof Failed ? err.message : `the test itself broke: ${err.stack ?? err}`)
  }
  if (current.failures.length && page) await shot(`FAILED-${name.replace(/\W+/g, '-').toLowerCase()}`)
  current.ms = Date.now() - began
  results.push(current)
  console.log(`${current.failures.length ? 'FAIL' : 'ok  '}  ${name}  (${(current.ms / 1000).toFixed(1)} s)`)
  for (const f of current.failures) console.log(`        - ${f}`)
  current = null
}

async function main() {
  shotDir = path.resolve(process.env.UI_TEST_SHOTS || path.join(os.tmpdir(), 'trommi-ui-test'))
  fs.rmSync(shotDir, { recursive: true, force: true })
  fs.mkdirSync(shotDir, { recursive: true })
  const began = Date.now()
  try {
    await startBoard()
    await openBrowser()
    console.log(`board on ${base} with ${state().agents.length} sessions and ${openCards().length} open questions, up after ${((Date.now() - began) / 1000).toFixed(1)} s\n`)
    await step('1 login: the link sets the cookie, without it the page is refused', stepLogin)
    await step('2 inbox: groups, equal rows, one-click answers, undo, Später, Mehr', stepInbox)
    await step('3 focus view: one click decides and advances, Escape closes, page behind is inert', stepFocus)
    await step('4 session: conversation, message and reply, inline answer, Fragen, Scribble', stepSession)
    await step('5 agents page: model and machine, rename and mark persist, star leads the inbox', stepAgents)
    await step('6 theme: the toggle switches and persists', stepTheme)
    await step('7 images load: inbox rows, full card, conversation', stepImages)
    await step('9 phone: answer, session, message, modes with touch; nothing overflows', stepPhone)
    await step('8 no uncaught errors and no failed requests during the whole run', stepErrors)
  } catch (err) {
    results.push({ name: 'setup', failures: [String(err.stack ?? err)] })
    console.log(`FAIL  setup\n        - ${err.stack ?? err}`)
  } finally {
    await cleanup()
  }
  const failed = results.filter(r => r.failures.length)
  const checks = failed.reduce((n, r) => n + r.failures.length, 0)
  console.log(`\n${failed.length ? `${failed.length} of ${results.length} steps failed (${checks} findings)` : `all ${results.length} steps passed`} in ${((Date.now() - began) / 1000).toFixed(0)} s`)
  console.log(`screenshots: ${shotDir}`)
  process.exit(failed.length ? 1 : 0)
}

await main()
