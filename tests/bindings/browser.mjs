// The browser binding in headless Chromium, served with the web app's own Content-Security-Policy
// (app/web/public/_headers), in the page and in module workers.
//   core/wasm/build.sh && node tests/bindings/browser.mjs
// What it checks:
// - the self-test passes in the page and in a worker under the app's policy as it is, with no violation;
// - the scenario of scenario.json passes with every device in a worker of its own and IndexedDB as the store;
// - a worker killed between a write and its sending leaves the request in the outbox, and a second worker cannot
//   open a state the first holds;
// - the IndexedDB store: closed and opened again at once, a wait for the lock given up, a load that fails with the
//   lock in hand, another owner told apart from other failures, a lock taken away;
// - without 'wasm-unsafe-eval' WebAssembly is refused (in the page by the page's policy; in a worker by the policy
//   of the worker script's own response).
// - catching up through `feed` leaves the same device as one envelope at a time, with one transaction per call;
// It prints a report with the sizes of the build (core/wasm/pkg/build.json) and the times of this machine.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchChromium } from '../../app/web/dev/cdp.mjs'

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
const headers = fs.readFileSync(path.join(repo, 'app/web/public/_headers'), 'utf8')
const appCsp = headers.split('\n').find(line => line.trim().startsWith('Content-Security-Policy:')).trim().slice('Content-Security-Policy:'.length).trim()
if (!appCsp.includes("script-src 'self' 'wasm-unsafe-eval'")) throw new Error("the app's policy with 'wasm-unsafe-eval' was not found in _headers")
const without = appCsp.replace(" 'wasm-unsafe-eval'", '')

const TYPES = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' }
const SERVED = /^\/(core\/wasm\/pkg|tests\/bindings|spec\/vectors)\//
// The policy of the page (the document and everything but the worker's script) and of the worker script's response.
const policy = { page: appCsp, worker: appCsp }
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://x').pathname
  const head = { 'Content-Security-Policy': url === '/tests/bindings/web/worker.mjs' ? policy.worker : policy.page, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }
  if (url === '/') {
    response.writeHead(200, { ...head, 'Content-Type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><meta charset="utf-8"><title>trommi-core</title><script type="module" src="/tests/bindings/web/page.mjs"></script>')
    return
  }
  const file = path.join(repo, url)
  if (!SERVED.test(url) || !file.startsWith(repo + path.sep) || !fs.existsSync(file)) { response.writeHead(404, head); response.end(); return }
  response.writeHead(200, { ...head, 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
  response.end(fs.readFileSync(file))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const report = { chromium: null, csp: appCsp, sizes: JSON.parse(fs.readFileSync(path.join(repo, 'core/wasm/pkg/build.json'), 'utf8')), cases: {}, refused: [] }
let failed = false
const fail = (what, detail) => { failed = true; console.error(`FAILED: ${what}: ${JSON.stringify(detail)}`) }

/** One new browser process: loads the page and runs one case there. Returns what the page returned, or why it threw. */
async function inBrowser(what, argument = null) {
  const browser = await launchChromium({ width: 800, height: 600 })
  try {
    const page = await browser.page()
    report.chromium ??= (await page.send('Browser.getVersion')).product
    await page.send('Page.enable')
    await page.send('Runtime.enable')
    const consoleErrors = []
    page.on('Runtime.exceptionThrown', event => consoleErrors.push(event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text))
    page.on('Runtime.consoleAPICalled', event => { if (event.type === 'error' || event.type === 'warning') consoleErrors.push(event.args.map(arg => arg.value ?? arg.description).join(' ')) })
    const loaded = new Promise(resolve => { const off = page.on('Page.loadEventFired', () => { off(); resolve() }) })
    await page.send('Page.navigate', { url: origin + '/' })
    await loaded
    const answer = await page.send('Runtime.evaluate', { expression: `run(${JSON.stringify(what)}, ${JSON.stringify(argument)})`, awaitPromise: true, returnByValue: true })
    if (answer.exceptionDetails) return { ok: false, error: answer.exceptionDetails.exception?.description?.split('\n')[0] ?? answer.exceptionDetails.text, console: consoleErrors }
    return { ...answer.result.value, console: consoleErrors }
  } finally {
    await browser.close()
  }
}

try {
  // TROMMI_CATCHUP=10000 measures a longer catch-up than the 300 envelopes every run checks.
  const catchUp = Number(process.env.TROMMI_CATCHUP ?? 300)
  for (const what of ['page', 'worker', 'scenario', 'kill', 'store', 'catchup', 'times']) {
    const result = await inBrowser(what, what === 'catchup' ? catchUp : null)
    if (!result.ok || result.violations.length || result.console.length || result.contentType !== 'application/wasm') fail(what, result)
    if (result.steps) {
      result.steps = result.steps.map(step => step.ok ? `${(step.micros / 1000).toFixed(1)} ms  ${step.name}` : `FAILED  ${step.name}: ${step.detail}`)
    }
    report.cases[what] = result
  }
  // Without 'wasm-unsafe-eval': must be refused, as a compile error that names the policy.
  const cases = [
    ['page', 'the page without it', { page: without, worker: without }],
    ['worker', "the worker's script without it, the page with it", { page: appCsp, worker: without }],
  ]
  for (const [what, name, policies] of cases) {
    Object.assign(policy, policies)
    const result = await inBrowser(what)
    const refused = !result.ok && /CompileError/.test(result.error ?? '') && /Content Security Policy/i.test(result.error ?? '')
    report.refused.push({ what: name, refused, error: result.error ?? null })
    if (!refused) fail(`WebAssembly was not refused by the policy (${name})`, result)
  }
} finally {
  server.close()
}
console.log(JSON.stringify(report, null, 2))
process.exit(failed ? 1 : 0)
