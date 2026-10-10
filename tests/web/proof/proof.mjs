// proof.mjs: the "MLS proof" screen (app/web/public/proof.mjs, /settings/proof) in a real browser, as the build ships it.
//   node tests/web/proof/proof.mjs            (PROOF_SHOTS=<folder>: also writes screenshots there)
// Builds the app into a temporary folder, serves it with the built _headers (tests/web/build/static.mjs: the app's
// own Content-Security-Policy, word for word) and drives headless Chromium over the DevTools protocol. It checks:
//   1. by its address in the demo room (?mock=1): while the worker has not answered the page waits (the worker is
//      held at its start to see that); then the first line starts with "OK", every step shows OK and a time, the
//      versions, the app and the browser are named;
//   2. from Settings: "MLS proof" is the last row there and leads to the same screen;
//   3. "Run again" starts a new worker, and that run asks the server for nothing but the worker's file and the .wasm;
//   4. "Copy result" puts the same lines on the clipboard (read back with the clipboard permission granted);
//   5. the .wasm blocked (Network.setBlockedURLs): the screen says FAIL with the error's message and its code;
//   6. a step that fails: the first line names it and its row says FAIL. No real core fails a step on request, so for
//      this ONE check the server hands out a stand-in worker (FAILING_WORKER below) that posts a report with a failed
//      step; everything else here runs the real Rust core;
//   7. without a room (no demo, nothing stored) the address opens the screen as a page of its own and the test passes;
//   8. over all of it: no Content-Security-Policy violation (page and workers), and no request to another origin or
//      to a /v1/ address. Requests are collected from the page AND from every worker (each worker is attached to
//      before it runs); that the collection sees a worker's requests is itself checked (the .wasm must be in it).
// One thing the test server bends: sw.js is served with VERSION "dev" (as the dev server does), so no service worker
// answers from a cache between the page and the checks above.
// Chromium is `chromium` on the PATH or the program CHROMIUM names; it cannot run inside a command sandbox. Without
// it, or without the core's WASM output and the tools to make it, the test fails and says which.
import fs from 'node:fs'
import path from 'node:path'
import { launchChromium } from '../../../app/web/dev/cdp.mjs'
import { tempDir, writeBuilt } from '../build/built.mjs'
import { appPolicy, serveStatic } from '../build/static.mjs'

const SHOTS = process.env.PROOF_SHOTS ? path.resolve(process.env.PROOF_SHOTS) : null
const sleep = ms => new Promise(r => setTimeout(r, ms))
const failures = []
let checks = 0
const check = (ok, what, seen) => { checks++; if (!ok) failures.push(`${what}${seen === undefined ? '' : `\n    seen: ${JSON.stringify(seen)}`}`) }

/** The stand-in worker of check 6: what proof-worker.ts posts when the core's second step fails. */
const FAILING = { name: 'the first founds a room', detail: 'a detail the core gave for the failed step' }
const FAILING_VERSIONS = { core: 'stand-in', openmls: 'stand-in', provider: 'stand-in', binding: 'stand-in' }
const FAILING_WORKER = `postMessage(${JSON.stringify({ report: { ok: false, micros: 4600, versions: FAILING_VERSIONS, steps: [{ name: 'three devices make their keys', ok: true, micros: 1200, detail: '' }, { ...FAILING, ok: false, micros: 3400 }] }, versions: FAILING_VERSIONS })}); close()`

const tmp = tempDir('proof')
let browser = null, server = null
try {
  const dist = path.join(tmp, 'dist')
  try { await writeBuilt(dist) } catch (err) { console.error(`proof: the build failed\n${err.message}`); process.exit(1) }
  const built = fs.readdirSync(path.join(dist, 'gen/app'))
  const wasmFile = built.find(f => f.endsWith('.wasm')), workerFile = built.find(f => /^proof-worker-\w+\.mjs$/.test(f))
  if (!wasmFile || !workerFile) { console.error(`proof: the build has no .wasm or no proof worker in gen/app/ (${built.join(', ')})`); process.exit(1) }
  const shell = fs.readFileSync(path.join(dist, 'sw.js'), 'utf8')
  check(shell.includes(`"/gen/app/${workerFile}"`) && shell.includes(`"/gen/app/${wasmFile}"`), "the service worker's shell holds the proof worker and the .wasm")
  check(Object.keys(JSON.parse(fs.readFileSync(path.join(dist, 'gen/manifest.json'), 'utf8')).files).includes(`gen/app/${workerFile}`), "the build's manifest names the proof worker")

  // ---- the server: every address it is asked for, and the two things it bends ----
  const asked = []
  let failingWorker = false
  server = await serveStatic(dist, { body: (address, bytes) => {
    asked.push(address)
    if (address === '/sw.js') return String(bytes).replace(/^const VERSION = .*$/m, 'const VERSION = "dev"')
    return failingWorker && address === `/gen/app/${workerFile}` ? FAILING_WORKER : bytes
  } })
  const policy = appPolicy(dist)

  try { browser = await launchChromium({ width: 1440, height: 900 }) } catch (err) { console.error(`proof: ${err.message} (Chromium: \`chromium\` on the PATH, or CHROMIUM=<program>)`); process.exit(1) }
  const page = await browser.page()

  // ---- what the browser asks for and complains about: the page's session, and every worker's ----
  const requests = []      // { url, from: 'page' | 'worker' }
  const violations = []    // policy violations the browser logged (page and workers)
  const workers = []       // the address of every worker started
  let blocked = []         // addresses no request may reach (check 5)
  let hold = null          // a promise a new worker waits for before it runs (to see the page while it waits)
  const onEvent = from => (method, params) => {
    if (method === 'Network.requestWillBeSent') requests.push({ url: params.request.url, from })
    if (method === 'Network.webSocketCreated') requests.push({ url: params.url, from })
    if (method === 'Log.entryAdded' && /Content Security Policy/i.test(params.entry.text)) violations.push(`${from}: ${params.entry.text}`)
  }
  for (const method of ['Network.requestWillBeSent', 'Network.webSocketCreated', 'Log.entryAdded']) page.on(method, params => onEvent('page')(method, params))
  // A worker is a target of its own: attached before its first line runs, told to report its requests, then let go.
  let childSeq = 0
  const toChild = (sessionId, method, params = {}) => page.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: ++childSeq, method, params }) })
  page.on('Target.receivedMessageFromTarget', ({ message }) => { const m = JSON.parse(message); if (m.method) onEvent('worker')(m.method, m.params) })
  page.on('Target.attachedToTarget', async ({ sessionId, targetInfo, waitingForDebugger }) => {
    if (targetInfo.type === 'worker') workers.push(targetInfo.url)
    try {
      await toChild(sessionId, 'Network.enable')
      await toChild(sessionId, 'Log.enable')
      if (blocked.length) await toChild(sessionId, 'Network.setBlockedURLs', { urls: blocked })
      if (hold) await hold
      if (waitingForDebugger) await toChild(sessionId, 'Runtime.runIfWaitingForDebugger')
    } catch (err) { failures.push(`a worker could not be attached to: ${err.message}`) }
  })
  await page.send('Page.enable')
  await page.send('Network.enable')
  await page.send('Log.enable')
  await page.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: false })
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: "window.__violations = []; addEventListener('securitypolicyviolation', e => window.__violations.push(e.violatedDirective + ' ' + e.blockedURI))" })
  await page.send('Browser.grantPermissions', { origin: server.origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] })

  const evaluate = async expression => {
    const res = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description?.split('\n')[0] ?? res.exceptionDetails.text)
    return res.result.value
  }
  const until = async (expression, what, ms = 30000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) { if (await evaluate(expression).catch(() => false)) return true }
    failures.push(`timed out waiting for: ${what}`)
    return false
  }
  const pageViolations = []
  const open = async address => {
    pageViolations.push(...(await evaluate('window.__violations ?? []').catch(() => [])))
    const loaded = new Promise(resolve => { const off = page.on('Page.loadEventFired', () => { off(); resolve() }) })
    await page.send('Page.navigate', { url: server.origin + address })
    await loaded
  }
  const state = () => evaluate("document.querySelector('[data-controller=proof]')?.dataset.state ?? null")
  const settled = (what = 'the proof screen has a result') => until("['ok', 'fail'].includes(document.querySelector('[data-controller=proof]')?.dataset.state)", what)
  /** What the screen shows. */
  const read = () => evaluate(`(() => {
    const text = el => el?.textContent.trim().replace(/\\s+/g, ' ') ?? null
    const facts = Object.fromEntries([...document.querySelectorAll('.proof-facts > div')].map(d => [text(d.querySelector('dt')), text(d.querySelector('dd'))]))
    return {
      path: location.pathname, title: text(document.querySelector('.set-head h2')), line: text(document.querySelector('#proof-line')), error: text(document.querySelector('#proof-error')),
      steps: [...document.querySelectorAll('#proof-steps > li')].map(li => ({ name: li.querySelector('.proof-name').firstChild.textContent, detail: text(li.querySelector('small')), time: text(li.querySelector('.proof-time')) })),
      facts, again: document.querySelector('#proof-again')?.disabled, copy: document.querySelector('#proof-copy')?.disabled,
      frame: Boolean(document.querySelector('#sidebar, nav.sidebar, [data-t-view]')), back: text(document.querySelector('.set-back')),
    }
  })()`)
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const shot = async name => {
    if (!SHOTS) return
    fs.mkdirSync(SHOTS, { recursive: true })
    await sleep(700)   // (fonts in, the page's own transitions at their end)
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  }
  const toEnd = () => evaluate("(() => { for (const el of [document.scrollingElement, document.querySelector('main'), document.querySelector('#room-screen')]) if (el) el.scrollTop = el.scrollHeight })()")

  // ---- 1. by its address, in the demo room ----
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  let release
  hold = new Promise(resolve => { release = resolve })
  await open('/settings/proof?mock=1')
  await until("document.querySelector('[data-controller=proof]')?.dataset.state === 'running'", 'the proof screen is there and waits')
  await until('true', 'a moment')   // (one more turn: the worker is attached and held by now)
  const waiting = await read()
  check(waiting.line === 'The Rust core is testing itself…' && waiting.steps.length === 0 && waiting.again === true && waiting.copy === true, 'while the worker has not answered, the screen waits: its line says so, no result, both buttons off', waiting)
  await shot('proof-running-1440-light')
  hold = null; release()
  await settled()
  const first = await read()
  const okLine = /^OK: the Rust core ran (\d+) steps in \d+ ms$/.exec(first.line ?? '')
  check(first.title === 'MLS proof' && first.back === 'Settings', 'the screen is a page of Settings: its title, the way back', first)
  check(Boolean(okLine), 'the first line starts with OK and says how many steps ran in how many ms', first.line)
  check(first.steps.length > 0 && Number(okLine?.[1]) === first.steps.length, 'every step the line counts has a row', first.steps.length)
  check(first.steps.every(s => s.name && /^OK \d+(\.\d)? ms$/.test(s.time)), 'every step row shows OK and its time in ms', first.steps)
  check(Object.keys(first.facts).join() === 'Core,OpenMLS,Provider,Binding,App,Browser,Cores,Ran in' && Object.values(first.facts).every(Boolean), "the core's four versions, the app and the browser are named, and nothing else", first.facts)
  check(/^Trommi app\/\d+\.\d+\.\d+, build \w+, commit \w+$/.test(first.facts.App ?? ''), "the app's line names its version, build and commit", first.facts.App)
  check(/a worker/.test(first.facts['Ran in'] ?? '') && first.facts.Browser === (await evaluate('navigator.userAgent')), 'it says it ran in a worker, in this browser', first.facts)
  check(first.again === false && first.copy === false, 'with a result both buttons are on', first)
  check(workers.length === 1 && workers[0].endsWith(`/gen/app/${workerFile}`), "exactly one worker ran: the build's proof worker", workers)
  check(requests.some(r => r.from === 'worker' && r.url.endsWith(`/gen/app/${wasmFile}`)), "the worker's own requests are seen by this test (the .wasm is among them)", requests.filter(r => r.from === 'worker'))

  // ---- 4. Copy result (before anything else changes the result) ----
  await click('#proof-copy')
  await until("document.querySelector('#proof-copy').textContent !== 'Copy result'", 'the Copy button answers')
  check((await evaluate("document.querySelector('#proof-copy').textContent")) === 'Copied', 'the button says Copied')
  const copied = await evaluate('navigator.clipboard.readText()').catch(err => `clipboard not readable: ${err.message}`)
  const lines = copied.split('\n')
  check(lines[0] === first.line, 'the copied text starts with the first line', lines[0])
  check(first.steps.every(s => lines.includes(`OK: ${s.name}, ${s.time.replace(/^OK /, '')}`)), 'the copied text holds every step line', copied)
  check(Object.entries(first.facts).every(([k, v]) => lines.includes(`${k}: ${v}`)), 'the copied text holds every version and browser line', copied)

  // ---- 2. from Settings ----
  await open('/settings')
  await until("document.querySelector('#settings-proof')", 'Settings shows the row')
  const row = await evaluate("(() => { const rows = [...document.querySelectorAll('main .set-row')]; const a = document.querySelector('#settings-proof'); return { last: rows.at(-1) === a, word: a.querySelector('b').textContent, detail: a.querySelector('.set-detail').textContent } })()")
  check(row.last && row.word === 'MLS proof' && row.detail === 'self test', 'MLS proof is the last row of Settings', row)
  if (SHOTS) for (const [width, height] of [[1440, 900], [390, 844]]) for (const theme of ['light', 'dark']) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] })
    await open('/settings'); await until("document.querySelector('#settings-proof')", 'Settings shows the row'); await toEnd()
    await shot(`settings-end-${width}-${theme}`)
  }
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  const before = workers.length
  await click('#settings-proof')
  await until("location.pathname === '/settings/proof'", 'the row leads to /settings/proof')
  await settled('the screen opened from Settings has a result')
  const fromRow = await read()
  check(fromRow.line?.startsWith('OK: ') && fromRow.steps.length === first.steps.length && workers.length === before + 1, 'opened from the Settings row it runs and passes', fromRow.line)

  // ---- 3. Run again: a new worker, and nothing asked for but its file and the .wasm ----
  const [askedBefore, seenBefore] = [asked.length, requests.length]
  hold = new Promise(resolve => { release = resolve })
  await click('#proof-again')
  check((await state()) === 'running' && (await read()).steps.length === 0, '"Run again" puts the screen back to waiting')
  hold = null; release()
  await settled('the second run has a result')
  const again = await read()
  check(again.line?.startsWith('OK: ') && workers.length === before + 2, '"Run again" ran a new worker and passed', [again.line, workers.length])
  const own = [`/gen/app/${workerFile}`, `/gen/app/${wasmFile}`]
  check(asked.slice(askedBefore).sort().join() === [...own].sort().join(), 'that run asked the server for the worker and the .wasm, nothing else', asked.slice(askedBefore))
  check(requests.slice(seenBefore).every(r => own.includes(new URL(r.url).pathname)), 'and the browser saw no other request in it', requests.slice(seenBefore))

  // ---- screenshots of the result ----
  if (SHOTS) for (const [width, height] of [[1440, 900], [390, 844]]) for (const theme of ['light', 'dark']) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] })
    await open('/settings/proof'); await settled()
    await shot(`proof-${width}-${theme}`)
    await toEnd(); await shot(`proof-${width}-${theme}-end`)
  }
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await open('/settings/proof'); await settled()

  // ---- 5. the .wasm cannot be loaded ----
  blocked = [`*${wasmFile}`]
  await page.send('Network.setBlockedURLs', { urls: blocked })
  await click('#proof-again')
  await settled('the run without the .wasm has a result')
  const noCore = await read()
  check(noCore.line === 'FAIL: the Rust core did not load', 'without the .wasm the first line says the core did not load', noCore.line)
  check(/\(core-load\)$/.test(noCore.error ?? '') && noCore.error.length > '(core-load)'.length + 5, "the error's message and its code are shown", noCore.error)
  check(noCore.steps.length === 0 && noCore.facts.Browser && noCore.facts.App && noCore.again === false, 'the screen is not blank: the app, the browser and "Run again" are there', noCore)
  await shot('proof-no-core-1440-light')
  if (SHOTS) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await shot('proof-no-core-390-light')
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  }
  blocked = []
  await page.send('Network.setBlockedURLs', { urls: [] })
  await click('#proof-again')
  await settled('the run after the block has a result')
  check((await read()).line?.startsWith('OK: '), 'with the .wasm back, "Run again" passes again')

  // ---- 6. a step fails (the stand-in worker) ----
  failingWorker = true
  await click('#proof-again')
  await settled('the run of the stand-in worker has a result')
  failingWorker = false
  const stepFail = await read()
  check(stepFail.line === `FAIL: at "${FAILING.name}"`, 'a failed step: the first line names it', stepFail.line)
  check(stepFail.steps.length === 2 && stepFail.steps[0].time === 'OK 1.2 ms' && stepFail.steps[1].time === 'FAIL 3.4 ms' && stepFail.steps[1].detail === FAILING.detail, 'its row says FAIL with its time and its detail, the others stay OK', stepFail.steps)
  await click('#proof-copy')
  await until("document.querySelector('#proof-copy').textContent === 'Copied'", 'the failed result is copied')
  const copiedFail = await evaluate('navigator.clipboard.readText()').catch(err => `clipboard not readable: ${err.message}`)
  check(copiedFail.split('\n').slice(0, 4).join('\n') === `FAIL: at "${FAILING.name}"\nOK: three devices make their keys, 1.2 ms\nFAIL: ${FAILING.name}, 3.4 ms\n  ${FAILING.detail}`, 'and the copied text says the same', copiedFail)
  await shot('proof-step-fail-1440-light')

  // ---- 7. without a room: a page of its own ----
  await open('/settings/proof?mock=0')
  await settled('the screen without a room has a result')
  const alone = await read()
  check(alone.line?.startsWith('OK: ') && alone.steps.length === first.steps.length && alone.back === null, 'without a room the address opens the screen on its own, and it passes', alone)
  check((await evaluate("Boolean(document.querySelector('#room-screen > main.set-page')) && document.querySelector('.room-meta a')?.getAttribute('href')")) === '/', 'it stands alone and offers the way into the app')
  await shot('proof-alone-1440-light')
  if (SHOTS) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await shot('proof-alone-390-light')
  }

  // ---- 8. over all of it ----
  pageViolations.push(...(await evaluate('window.__violations ?? []')))
  check(pageViolations.length === 0 && violations.length === 0, 'no Content-Security-Policy violation, in the page or a worker', { pageViolations, violations })
  const web = requests.filter(r => /^(https?|wss?):/.test(r.url))
  check(web.length > 0 && web.every(r => new URL(r.url).host === new URL(server.origin).host), "no request to an origin other than the app's own", [...new Set(web.map(r => new URL(r.url).origin))])
  check(!web.some(r => new URL(r.url).pathname.startsWith('/v1/')) && !asked.some(a => a.startsWith('/v1/')), 'no request to a /v1/ address', web.map(r => r.url).filter(u => u.includes('/v1/')))

  if (failures.length) { console.error(`proof: FAILED (${failures.length} of ${checks})\n${failures.map(f => `  not true: ${f}`).join('\n')}`); process.exitCode = 1 }
  else console.log(`proof: ok, ${checks} checks\n  ${first.line}\n  ${first.steps.length} step rows, ${workers.length} workers started, ${web.length} requests seen (${web.filter(r => r.from === 'worker').length} from workers), all to ${server.origin}\n  without the .wasm: ${noCore.error}\n  policy: ${policy.slice(0, 96)}…${SHOTS ? `\n  screenshots in ${SHOTS}` : ''}`)
} finally {
  await browser?.close()
  await server?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}
