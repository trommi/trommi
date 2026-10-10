// harness.mjs: what the end-to-end runs (standin.mjs, real.mjs) share: the built app on disk, a server for it, browser
// profiles driven as a person drives them, and the list of steps a run prints.
//
// THE APP is built the normal way (tests/web/build/built.mjs `writeBuilt`: app/web/dev/build.mjs `generate()`), into a
// folder under TMP. `standInWorker(dir)` then replaces the ONE worker file of that build with a bundle of the same
// entry (app/web/core/core-worker.ts) in which core-wasm.ts is standin-core.ts (the real binding plus the facts the
// fake hub needs): same address, so nothing else of the
// build changes (index.html, the page's chunks, the proof worker, the .wasm and the _headers are the build's own).
//
// THE SERVER (`serveApp`) answers on ONE origin (http://localhost:<port>): every address under /v2/ is passed on to the hub (the fake hub or
// the real hub's binary), byte for byte and unbuffered (the live stream is server-sent events), everything else is
// the built app from tests/web/build/static.mjs, which sends the headers of the build's own _headers. The app is
// pointed at that origin with its developer override `?hub=<origin>` (app.mjs hubUrl, kept for the tab). So the
// Content-Security-Policy is the app's, word for word: the hub is `connect-src 'self'`. When the hub is down, a /v2/
// request is cut without an answer, as a network that is away.
//
// A PROFILE (`openProfile`) is one headless Chromium with a profile folder of its own under TMP: its own IndexedDB,
// Web Locks and tabs. Its pages are driven over the DevTools protocol (app/web/dev/cdp.mjs): `click` moves the mouse
// to the element and presses it (and fails when something else lies over it), `type` focuses a field and inserts
// text as a keyboard does. Every page and every worker of it is watched: uncaught exceptions, console errors and
// warnings, Content-Security-Policy violations (`watch`).
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchChromium } from '../../../app/web/dev/cdp.mjs'
import { coreFiles, coreFromPkg } from '../../../app/web/dev/build.mjs'
import { writeBuilt } from '../build/built.mjs'
import { appPolicy, serveStatic } from '../build/static.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.join(HERE, '..', '..', '..')
/** Everything a run writes: builds, browser profiles, the real hub's data. */
export const TMP = process.env.TROMMI_E2E_TMP || path.join(os.tmpdir(), 'trommi-e2e')
/** Screenshots of key moments. */
export const SHOTS = process.env.TROMMI_E2E_SHOTS || path.join(os.tmpdir(), 'trommi-e2e-shots')
fs.mkdirSync(path.join(TMP, 'tmp'), { recursive: true })
// (cdp.mjs makes its throwaway profiles under the system's temporary folder: that is ours)
process.env.TMPDIR = path.join(TMP, 'tmp')

export const sleep = ms => new Promise(r => setTimeout(r, ms))
/** Waits until `check()` is truthy and returns it; throws `what` after `ms`. */
export async function until(check, what, ms = 15000) {
  const end = Date.now() + ms
  for (;;) {
    const got = await check()
    if (got) return got
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(40)
  }
}

// ---- what a run needs before it starts --------------------------------------------------------------------------

/** What is missing to run at all, as sentences; empty when all is there. */
export function missing({ hub = false } = {}) {
  const out = []
  const chromium = process.env.CHROMIUM || 'chromium'
  const found = chromium.includes('/') ? fs.existsSync(chromium) : (process.env.PATH ?? '').split(path.delimiter).some(d => fs.existsSync(path.join(d, chromium)))
  if (!found) out.push(`Chromium is missing: no "${chromium}" on the PATH (set CHROMIUM to the program)`)
  if (!fs.existsSync(path.join(REPO, 'core/wasm/pkg/trommi_core_wasm_bg.wasm'))) out.push('the Rust core\'s WASM package is missing: core/wasm/pkg/ (run core/wasm/build.sh)')
  if (!fs.existsSync(path.join(REPO, 'node_modules/esbuild'))) out.push('esbuild is missing (npm ci at the repository root)')
  if (hub) {
    const bin = process.env.TROMMI_HUB_BIN
    if (!bin) out.push('TROMMI_HUB_BIN is not set: the real hub\'s binary is needed')
    else if (!fs.existsSync(bin)) out.push(`TROMMI_HUB_BIN names no file: ${bin}`)
  }
  return out
}

// ---- the build ----------------------------------------------------------------------------------------------------

/** One normal build into a new folder `<TMP>/<name>`. */
export async function buildApp(name) {
  const dir = path.join(TMP, name)
  fs.rmSync(dir, { recursive: true, force: true })
  await writeBuilt(dir)
  return dir
}
const workerOf = dir => {
  const f = fs.readdirSync(path.join(dir, 'gen/app')).filter(n => /^core-worker-[^-]+\.mjs$/.test(n))
  if (f.length !== 1) throw new Error(`the build has not exactly one core worker in gen/app/ (${f.join(', ') || 'none'})`)
  return `gen/app/${f[0]}`
}
/** Replaces the built worker's file by the same worker with standin-core.ts for core-wasm.ts (see the header). Not minified: an
 *  error in it names its place. Returns the worker's address. */
export async function standInWorker(dir) {
  const esbuild = await import('esbuild')
  const core = coreFiles(REPO)
  const worker = workerOf(dir)
  if (!fs.readFileSync(path.join(dir, worker), 'utf8').includes(`/${core.wasm}`)) throw new Error('the built worker does not name the .wasm of this checkout: not this checkout\'s build')
  const standIn = { name: 'stand-in-core', setup(b) { b.onResolve({ filter: /(^|\/)core-wasm\.ts$/ }, () => ({ path: path.join(HERE, 'standin-core.ts') })) } }
  const made = await esbuild.build({
    entryPoints: [path.join(REPO, 'app/web/core/core-worker.ts')], bundle: true, format: 'esm', write: false, target: ['es2022'], logLevel: 'silent',
    plugins: [standIn, coreFromPkg(REPO)], define: core.define, external: ['node:*'],
  })
  if (made.outputFiles.length !== 1) throw new Error('the stand-in worker is not one file')
  const text = made.outputFiles[0].text
  if (!text.includes('standInCore')) throw new Error('the stand-in worker does not hold standin-core.ts')
  fs.writeFileSync(path.join(dir, worker), text)
  return `/${worker}`
}

// ---- the server ---------------------------------------------------------------------------------------------------

/** Serves the built app `dir` and, under /v2/, the hub `hub()` names (a URL, or null while it is away). */
export async function serveApp(dir, hub) {
  const files = await serveStatic(dir)
  const pass = (req, res, target, onDown) => {
    const to = new URL(target)
    const out = http.request({ host: to.hostname, port: to.port, method: req.method, path: req.url, headers: { ...req.headers, host: to.host } }, got => {
      res.writeHead(got.statusCode, got.headers)
      res.flushHeaders()
      got.pipe(res)
      // (an answer cut on the hub's side, as when it is killed in the middle of a stream, is cut for the browser too)
      got.on('error', () => res.destroy())
      got.on('close', () => { if (!res.writableEnded) res.destroy() })
    })
    out.on('error', onDown)
    res.on('close', () => out.destroy())
    req.pipe(out)
  }
  const server = http.createServer((req, res) => {
    const cut = () => res.destroy()
    if (!req.url.startsWith('/v2/')) return pass(req, res, files.origin, cut)
    const target = hub()
    if (!target) return cut()
    pass(req, res, target, cut)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  // The app is opened at `localhost`, not at the IP address: WebAuthn takes no IP address as a site, and the login
  // screen's passkey offer must be able to wait there as it does on a real domain. `numeric` is the same server by
  // its IP address, for the one check that wants a site where WebAuthn refuses at once.
  const origin = `http://localhost:${server.address().port}`
  return {
    origin, numeric: `http://127.0.0.1:${server.address().port}`, policy: appPolicy(dir),
    /** The app's address with the hub override: this origin. */
    start: (pathname = '/') => `${origin}${pathname}${pathname.includes('?') ? '&' : '?'}hub=${encodeURIComponent(origin)}`,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await files.close() },
  }
}

// ---- what went wrong in a browser, over a whole run ---------------------------------------------------------------

/** One list per kind, each entry `<profile>[ worker]: text`; `network` holds Chromium's own lines for failed requests,
 *  apart from the errors. With `requests`, every request of every page and worker is kept as a record too:
 *  { who, url, method, status, retry_after, failed, blocked, cors, at, first_data, ended } (times: Date.now()). */
export function watch({ requests = false } = {}) {
  return { exceptions: [], csp: [], errors: [], warnings: [], network: [], requests: requests ? [] : null }
}
const isCsp = text => /Content Security Policy|Content-Security-Policy/.test(text)
/** Chromium's own line for a request that failed or was answered with an error status. */
const isNetwork = text => /^Failed to load resource|net::ERR_|the server responded with a status of/.test(text)

function listen(seen, who, on) {
  on('Runtime.exceptionThrown', e => seen.exceptions.push(`${who}: ${e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text}`))
  on('Runtime.consoleAPICalled', e => {
    if (e.type !== 'warning' && e.type !== 'error') return
    const text = e.args.map(a => a.value ?? a.description ?? '').join(' ')
    ;(isCsp(text) ? seen.csp : e.type === 'error' ? seen.errors : seen.warnings).push(`${who}: ${text}`)
  })
  if (seen.requests) {
    const byId = new Map()
    on('Network.requestWillBeSent', e => { const r = { who, url: e.request.url, method: e.request.method, status: null, retry_after: null, failed: null, blocked: null, cors: null, at: Date.now(), first_data: null, ended: null }; byId.set(e.requestId, r); seen.requests.push(r) })
    on('Network.responseReceived', e => { const r = byId.get(e.requestId); if (!r) return; r.status = e.response.status; const h = Object.entries(e.response.headers ?? {}).find(([k]) => k.toLowerCase() === 'retry-after'); r.retry_after = h ? Number(h[1]) : null })
    on('Network.dataReceived', e => { const r = byId.get(e.requestId); if (r) r.first_data ??= Date.now() })
    on('Network.loadingFinished', e => { const r = byId.get(e.requestId); if (r) r.ended = Date.now() })
    on('Network.loadingFailed', e => { const r = byId.get(e.requestId); if (!r) return; r.ended = Date.now(); r.failed = e.errorText || 'failed'; r.blocked = e.blockedReason ?? null; r.cors = e.corsErrorStatus?.corsError ?? null })
  }
  on('Log.entryAdded', ({ entry }) => {
    if (isCsp(entry.text)) seen.csp.push(`${who}: ${entry.text}`)
    else if (entry.source === 'network' || isNetwork(entry.text)) seen.network.push(`${who}: ${entry.text} ${entry.url ?? ''}`)
    else if (entry.level === 'error') seen.errors.push(`${who}: ${entry.text}`)
    else if (entry.level === 'warning') seen.warnings.push(`${who}: ${entry.text}`)
  })
}

// ---- a profile and its pages --------------------------------------------------------------------------------------

/** A page of a profile, driven as a person would. */
async function driver(session, name, seen, { width, height }) {
  listen(seen, name, (event, fn) => session.on(event, fn))
  // Workers of the page (the core worker, the proof worker): each is attached to, so its exceptions, console and
  // policy violations are seen too. (Messages to a worker travel through the page's session.)
  const workers = new Map(), answers = new Map()
  let asked = 1_000_000
  session.on('Target.attachedToTarget', ({ sessionId, targetInfo }) => {
    if (targetInfo.type !== 'worker') return
    const handlers = new Map()
    workers.set(sessionId, handlers)
    listen(seen, `${name} worker`, (event, fn) => handlers.set(event, fn))
    let id = 0
    for (const method of ['Runtime.enable', 'Log.enable', ...(seen.requests ? ['Network.enable'] : [])]) session.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: ++id, method }) }).catch(() => {})
  })
  session.on('Target.receivedMessageFromTarget', ({ sessionId, message }) => {
    const m = JSON.parse(message)
    if (m.method) workers.get(sessionId)?.get(m.method)?.(m.params)
    else if (answers.has(m.id)) { answers.get(m.id)(m); answers.delete(m.id) }
  })
  session.on('Target.detachedFromTarget', ({ sessionId }) => workers.delete(sessionId))
  await session.send('Runtime.enable')
  await session.send('Log.enable')
  await session.send('Page.enable')
  if (seen.requests) await session.send('Network.enable')
  await session.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: false })
  await session.send('Page.addScriptToEvaluateOnNewDocument', { source: "window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective+' '+(e.blockedURI||e.sample||'')))" })
  await session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })

  const page = {
    name, session,
    /** Runs `code` (the body of an async function) in the page and returns its value. */
    async js(code) {
      const r = await session.send('Runtime.evaluate', { expression: `(async () => { ${code} })()`, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) throw new Error(`${name}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}\n    in: ${code.trim().slice(0, 200)}`)
      return r.result.value
    },
    /** Evaluates the expression `code` in every worker of the page; returns the values (by value) that are not
     *  undefined, one per worker that answered within two seconds. */
    async workers(code) {
      const out = await Promise.all([...workers.keys()].map(sessionId => new Promise(resolve => {
        const id = ++asked
        const timer = setTimeout(() => { answers.delete(id); resolve(undefined) }, 2000)
        answers.set(id, m => { clearTimeout(timer); resolve(m.result?.result?.value) })
        session.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: code, returnByValue: true } }) }).catch(() => { clearTimeout(timer); resolve(undefined) })
      })))
      return out.filter(v => v !== undefined)
    },
    /** Waits until the expression `code` is truthy in the page; returns the milliseconds it took. */
    async until(code, what, ms = 15000) {
      const t = Date.now()
      while (Date.now() - t < ms) { if (await page.js(`return Boolean(${code})`).catch(() => false)) return Date.now() - t; await sleep(40) }
      await page.shot(`timeout-${name}-${what.replace(/[^\w]+/g, '-').slice(0, 50)}`).catch(() => {})
      throw new Error(`${name}: timed out waiting for ${what}`)
    },
    async go(url) {
      const loaded = new Promise(resolve => { const off = session.on('Page.loadEventFired', () => { off(); resolve() }) })
      await session.send('Page.navigate', { url })
      await Promise.race([loaded, sleep(10000)])
    },
    async reload() {
      const loaded = new Promise(resolve => { const off = session.on('Page.loadEventFired', () => { off(); resolve() }) })
      await session.send('Page.reload')
      await Promise.race([loaded, sleep(10000)])
    },
    /** Where the middle of the element is, scrolled into view; fails when it is not there, has no box, or lies under
     *  something that is not its own (a person could not press it). */
    async point(selector) {
      const at = await page.js(`const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return { no: 'not in the page' }
        el.scrollIntoView({ block: 'center', inline: 'center' })
        await new Promise(r => requestAnimationFrame(() => r()))
        const r = el.getBoundingClientRect()
        if (!r.width || !r.height) return { no: 'it has no box (hidden)' }
        const x = r.left + r.width / 2, y = r.top + r.height / 2, hit = document.elementFromPoint(x, y)
        const own = hit && (el.contains(hit) || hit.contains(el) || (el.labels && [...el.labels].some(l => l.contains(hit))))
        return own ? { x, y } : { no: 'it lies under ' + (hit ? hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') + (hit.className && typeof hit.className === 'string' ? '.' + hit.className.split(' ').join('.') : '') : 'nothing') }`)
      if (at.no) throw new Error(`${name}: cannot press ${selector}: ${at.no}`)
      return at
    },
    async mouse(type, x, y, down = type !== 'mouseReleased' && type !== 'mouseMoved') {
      await session.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !down ? 'none' : 'left', buttons: down ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 })
    },
    /** A click with the mouse on the element's middle. */
    async click(selector) {
      const { x, y } = await page.point(selector)
      await page.mouse('mouseMoved', x, y, false)
      await page.mouse('mousePressed', x, y)
      await page.mouse('mouseReleased', x, y)
    },
    /** Clicks into the field, replaces what it holds, and types `text` as a keyboard inserts it. */
    async type(selector, text) {
      await page.click(selector)
      await page.js(`const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.select?.()`)
      if (await page.js(`return (document.activeElement?.value ?? '') !== ''`)) await page.key('Backspace', 8)
      await session.send('Input.insertText', { text })
    },
    async key(key, code, modifiers = 0) {
      for (const type of ['keyDown', 'keyUp']) await session.send('Input.dispatchKeyEvent', { type: type === 'keyDown' ? 'rawKeyDown' : 'keyUp', key, windowsVirtualKeyCode: code, modifiers })
      if (key === 'Enter') await session.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', key, windowsVirtualKeyCode: 13 })
    },
    /** Chooses files in a file field, as the file dialog would. */
    async attach(selector, files) {
      const { root } = await session.send('DOM.getDocument')
      const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector })
      if (!nodeId) throw new Error(`${name}: no file field ${selector}`)
      await session.send('DOM.setFileInputFiles', { nodeId, files })
    },
    /** What the clipboard holds (the permission to read it is granted for the page's origin first). */
    async clipboard() {
      await session.send('Browser.grantPermissions', { origin: await page.js('return location.origin'), permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] })
      return page.js('return navigator.clipboard.readText()')
    },
    /** A screenshot into SHOTS (or the run's own folder, `seen.shots`) as `<file>.png`; returns its path. */
    async shot(file) {
      const dir = seen.shots ?? SHOTS
      fs.mkdirSync(dir, { recursive: true })
      const s = await session.send('Page.captureScreenshot', { format: 'png' })
      const to = path.join(dir, `${file}.png`)
      fs.writeFileSync(to, Buffer.from(s.data, 'base64'))
      return to
    },
    /** Closes the tab, as its ✕ does. */
    close: () => session.send('Page.close').catch(() => {}),
    /** The policy violations the page's own event saw on the page as it stands (the run's list has the rest). */
    violations: () => page.js('return window.__csp ?? []').catch(() => []),
  }
  return page
}

/** A browser profile: `page` (its first tab), `tab()` for another tab of the same profile, `close()`. */
export async function openProfile(name, seen, { width = 1440, height = 900, args = [], keep = null } = {}) {
  const browser = await launchChromium({ width, height, args, keep })
  const page = await driver(await browser.page(), name, seen, { width, height })
  let tabs = 0
  return {
    name, page, browser,
    async tab(url = 'about:blank') {
      const t = await browser.tab('about:blank')
      const d = await driver(t.session, `${name} tab ${++tabs + 1}`, seen, { width, height })
      if (url !== 'about:blank') await d.go(url)
      return d
    },
    close: () => browser.close(),
  }
}

// ---- the steps of a run -------------------------------------------------------------------------------------------

/** A run: `step(name, fn)` runs one step and prints one line for it (ok / FAIL with the reasons / skip); a
 *  failed step does not stop the run. `check(ok, what, seen)` inside a step fails it without ending it. `finish()`
 *  prints the totals and returns the number of failures. */
export function run(title) {
  const lines = []
  let failed = 0, passed = 0, skipped = 0, n = 0, current = null
  const say = line => { lines.push(line); console.log(line) }
  return {
    /** `fn` may return a string: a note printed with the line. Throwing `skip(why)` marks the step skipped. */
    async step(name, fn) {
      const t = Date.now()
      current = { fails: [], notes: [] }
      const mine = current
      let how = 'ok  '
      try { const note = await fn(); if (typeof note === 'string') mine.notes.push(note) } catch (err) {
        if (err?.skip) { how = 'skip'; mine.notes.push(err.message) } else mine.fails.push(err?.message ?? String(err))
      }
      if (mine.fails.length) how = 'FAIL'
      if (how === 'FAIL') failed++; else if (how === 'ok  ') passed++; else skipped++
      say(`${how} ${String(++n).padStart(2)}. ${name} (${((Date.now() - t) / 1000).toFixed(1)} s)`)
      for (const f of mine.fails) say(`        FAIL: ${f.split('\n').join('\n              ')}`)
      for (const s of mine.notes) say(`        note: ${s}`)
      current = null
      return how === 'ok  '
    },
    check(ok, what, seenValue) { if (!ok) current?.fails.push(`${what}${seenValue === undefined ? '' : ` (seen: ${JSON.stringify(seenValue)})`}`); return Boolean(ok) },
    note(text) { current?.notes.push(text) },
    say,
    finish() {
      say(`${title}: ${passed} ok, ${failed} failed, ${skipped} skipped`)
      return failed
    },
  }
}
export const skip = why => Object.assign(new Error(why), { skip: true })

/** One whole run of a scenario module ({ setUp, steps, tearDown }): every step, then the totals. Returns the
 *  number of failed steps; 2 is thrown as `cannot` when something the run needs is missing. */
export async function runScenario(name, scenario, needs = {}) {
  const lacking = missing(needs)
  if (lacking.length) throw Object.assign(new Error(lacking.map(l => `${name}: cannot run: ${l}`).join('\n')), { cannot: true })
  const started = Date.now()
  const ctx = await scenario.setUp()
  try { for (const [step, fn] of scenario.steps) await ctx.run.step(step, () => fn(ctx)) } finally { await scenario.tearDown(ctx) }
  const failed = ctx.run.finish()
  ctx.run.say(`${name}: ${((Date.now() - started) / 1000).toFixed(0)} s with the build; screenshots in ${SHOTS}`)
  return failed
}
/** For a scenario file run as a command. */
export async function main(name, scenario, needs) {
  try { process.exit(await runScenario(name, scenario, needs) ? 1 : 0) } catch (err) {
    if (!err?.cannot) throw err
    console.error(err.message)
    process.exit(2)
  }
}
