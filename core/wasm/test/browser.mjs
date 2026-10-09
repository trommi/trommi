// The browser proof: serve core/wasm/pkg and the test page with the web app's own Content-Security-Policy
// (app/web/public/_headers), and run the round trip in headless Chromium, in the page and in a module worker.
//   core/wasm/build.sh && node core/wasm/test/browser.mjs
// What it shows:
// - the round trip passes under the app's policy as it is, with no violation, in both places;
// - without 'wasm-unsafe-eval' WebAssembly is refused (in the page by the page's policy; in the worker by the policy
//   of the worker script's own response, whatever the page's says);
// - sizes and times. Times are from this machine over loopback: no network, no deployed cache. "first" is the first
//   run in a new browser process, "best" the fastest of three. DevTools' CPU throttling slows the page's thread only:
//   a worker is never slowed, so there is no slowed case for it.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { launchChromium } from '../../../app/web/dev/cdp.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const headers = fs.readFileSync(path.join(root, '../../app/web/public/_headers'), 'utf8')
const appCsp = headers.split('\n').find(l => l.trim().startsWith('Content-Security-Policy:')).trim().slice('Content-Security-Policy:'.length).trim()
if (!appCsp.includes("script-src 'self' 'wasm-unsafe-eval'")) throw new Error("the app CSP with 'wasm-unsafe-eval' was not found in _headers")
const without = appCsp.replace(" 'wasm-unsafe-eval'", '')

const TYPES = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html; charset=utf-8' }
// The policy of the page (the document and everything but the worker's script) and of the worker script's response.
const policy = { page: appCsp, worker: appCsp }
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x').pathname
  const head = { 'Content-Security-Policy': url === '/test/worker.mjs' ? policy.worker : policy.page, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }
  if (url === '/') { res.writeHead(200, { ...head, 'Content-Type': TYPES['.html'] }); res.end('<!doctype html><meta charset="utf-8"><title>trommi-core</title><script type="module" src="/test/page.mjs"></script>'); return }
  const file = path.join(root, url)
  if (!file.startsWith(root + path.sep) || !/^\/(pkg|test)\//.test(url) || !fs.existsSync(file)) { res.writeHead(404, head); res.end(); return }
  res.writeHead(200, { ...head, 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
  res.end(fs.readFileSync(file))
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const wasm = fs.readFileSync(path.join(root, 'pkg/trommi_core_wasm_bg.wasm'))
const glue = fs.readFileSync(path.join(root, 'pkg/trommi_core_wasm.js'))
const sizes = b => ({ raw: b.length, gzip: zlib.gzipSync(b, { level: 9 }).length, brotli: zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length })
const report = { chromium: null, csp: appCsp, wasm: sizes(wasm), glue: sizes(glue), runs: [], refused: [] }
let failed = false

/** One browser process for one case: fn(run), run(where, throttle) → what the page returned or why it threw. */
async function withBrowser(fn) {
  const browser = await launchChromium({ width: 800, height: 600 })
  try {
    const page = await browser.page()
    report.chromium ??= (await page.send('Browser.getVersion')).product
    await page.send('Page.enable')
    await page.send('Runtime.enable')
    const consoleErrors = []
    page.on('Runtime.exceptionThrown', e => consoleErrors.push(e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text))
    page.on('Runtime.consoleAPICalled', e => { if (e.type === 'error' || e.type === 'warning') consoleErrors.push(e.args.map(a => a.value ?? a.description).join(' ')) })
    return await fn(async (where, throttle) => {
      consoleErrors.length = 0
      await page.send('Emulation.setCPUThrottlingRate', { rate: throttle })
      const loaded = new Promise(r => { const off = page.on('Page.loadEventFired', () => { off(); r() }) })
      await page.send('Page.navigate', { url: origin + '/' })
      await loaded
      const res = await page.send('Runtime.evaluate', { expression: `run(${JSON.stringify(where)})`, awaitPromise: true, returnByValue: true })
      await page.send('Emulation.setCPUThrottlingRate', { rate: 1 })
      if (res.exceptionDetails) return { where, throttle, ok: false, error: res.exceptionDetails.exception?.description?.split('\n')[0] ?? res.exceptionDetails.text, console: [...consoleErrors] }
      return { where, throttle, ...res.result.value, console: [...consoleErrors] }
    })
  } finally {
    await browser.close()
  }
}

try {
  const TIMES = ['fetch', 'compile', 'instance', 'instantiate', 'identities', 'foundAddJoinExport', 'sealOpen', 'removeProcess', 'megabyteSeal', 'megabyteOpen', 'sixteen', 'sixteenRemove', 'indexedDb']
  for (const [where, throttle] of [['page', 1], ['page', 4], ['worker', 1]]) {
    const tries = await withBrowser(async run => { const all = []; for (let i = 0; i < 3; i++) all.push(await run(where, throttle)); return all })
    for (const t of tries) if (!t.ok || t.violations.length || t.console.length || t.contentType !== 'application/wasm') { failed = true; console.error('FAILED', JSON.stringify(t)) }
    const pick = (t, keys) => Object.fromEntries(keys.map(k => [k, t[k]]))
    report.runs.push({ where, throttle, ok: tries.every(t => t.ok), first: pick(tries[0], TIMES),
      best: Object.fromEntries(TIMES.map(k => [k, Math.min(...tries.map(t => t[k]))])),
      storedEntries: tries[0].storedEntries, storedBytes: tries[0].storedBytes, sixteenStoredBytes: tries[0].sixteenStoredBytes, indexedDbEntries: tries[0].indexedDbEntries, violations: tries[0].violations })
  }
  // Without 'wasm-unsafe-eval': must be refused, as a compile error that names the policy.
  const cases = [
    ['page', 'the page without it', { page: without, worker: without }],
    ['worker', "the worker's script without it, the page with it", { page: appCsp, worker: without }],
  ]
  for (const [where, what, policies] of cases) {
    Object.assign(policy, policies)
    const r = await withBrowser(run => run(where, 1))
    const refused = !r.ok && /CompileError/.test(r.error ?? '') && /Content Security Policy/i.test(r.error ?? '')
    report.refused.push({ where, what, refused, error: r.error ?? null })
    if (!refused) { failed = true; console.error(`FAILED: WebAssembly was not refused by the policy (${what}): ${JSON.stringify(r)}`) }
  }
  // And the other way round: the page's policy without it does not stop a worker whose own response allows it.
  Object.assign(policy, { page: without, worker: appCsp })
  const own = await withBrowser(run => run('worker', 1))
  report.workerUnderItsOwnPolicy = { ok: own.ok === true, error: own.error ?? null }
  if (!own.ok) { failed = true; console.error(`FAILED: the worker under its own policy: ${JSON.stringify(own)}`) }
} finally {
  server.close()
}
console.log(JSON.stringify(report, null, 2))
process.exit(failed ? 1 : 0)
