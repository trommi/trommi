// measure.mjs: what the real build weighs and how long its start takes, now that the app's own worker loads the Rust
// core.   node tests/web/e2e/measure.mjs [--out <file.json>]
// It builds this checkout the normal way (nothing substituted) and gives:
//   sizes            per class (page, worker, css, wasm), raw, gzip and brotli: tests/web/build/measure.mjs's own
//                    numbers for that build (it is run on the built folder)
//   cold_start_ms    app_worker_ready: `new Worker` → the worker's `ready` (the same script's number)
//   app_start_ms     the app opened as a person opens it, a fresh browser profile each time, median of five:
//                    worker_ready   navigation start → the core worker's `ready`
//                    worker_opened  navigation start → its answer to `open` (IndexedDB read: nothing is stored)
//                    core_loaded    navigation start → the .wasm fetched (the worker loads the core when the first
//                                   screen that needs it asks; null if it was not fetched by then)
//                    first_screen   navigation start → the welcome screen is in the page
// These are times of this machine over loopback with nothing cached: no network, no phone. They compare builds.
// The worker's times are taken by a wrapper around `Worker` put into the page before any of its scripts run; it
// only listens.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { launchChromium } from '../../../app/web/dev/cdp.mjs'
import { buildApp, missing, REPO, serveApp, sleep } from './harness.mjs'

const RUNS = 5
const median = list => { const s = list.filter(v => v !== null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null }
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1] }

const lacking = missing()
if (lacking.length) { for (const l of lacking) console.error(`measure: cannot run: ${l}`); process.exit(2) }

const WATCH = `(() => {
  const seen = (window.__start = { worker_ready: null, worker_opened: null })
  const Real = window.Worker
  window.Worker = class extends Real {
    constructor(...a) {
      super(...a)
      this.addEventListener('message', e => {
        if (e.data?.t === 'ready') seen.worker_ready ??= performance.now()
        if (e.data?.t === 'opened') seen.worker_opened ??= performance.now()
      })
    }
  }
  new MutationObserver((_, o) => { if (document.querySelector('#way-create')) { seen.first_screen = performance.now(); o.disconnect() } }).observe(document, { childList: true, subtree: true })
})()`

async function start(url) {
  const browser = await launchChromium({ width: 1440, height: 900 })
  try {
    const page = await browser.page()
    await page.send('Page.enable')
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: WATCH })
    await page.send('Page.navigate', { url })
    for (let i = 0; i < 400; i++) {
      const r = await page.send('Runtime.evaluate', { returnByValue: true, expression: `(() => { const s = window.__start; if (!s || s.first_screen == null || s.worker_opened == null) return null; const wasm = performance.getEntriesByType('resource').find(e => e.name.endsWith('.wasm')); return { ...s, core_loaded: wasm ? wasm.responseEnd : null } })()` })
      if (r.result?.value) { await sleep(300); return r.result.value }
      await sleep(25)
    }
    throw new Error('the app did not show its first screen')
  } finally { await browser.close() }
}

const dir = await buildApp('measure-dist')
const sized = spawnSync(process.execPath, [path.join(REPO, 'tests/web/build/measure.mjs'), '--tree', dir], { encoding: 'utf8', env: process.env })
if (sized.status !== 0) { console.error(`measure: tests/web/build/measure.mjs failed\n${sized.stderr}`); process.exit(1) }
const report = JSON.parse(sized.stdout)
report.tree = 'this checkout, the normal build'
const app = await serveApp(dir, () => null)
try {
  const runs = []
  for (let i = 0; i < RUNS; i++) runs.push(await start(`${app.origin}/`))
  report.app_start_ms = Object.fromEntries(['worker_ready', 'worker_opened', 'core_loaded', 'first_screen'].map(k => [k, { median: median(runs.map(r => (r[k] == null ? null : Math.round(r[k] * 10) / 10))), runs: runs.map(r => (r[k] == null ? null : Math.round(r[k] * 10) / 10)) }]))
} finally { await app.close() }
const text = `${JSON.stringify(report, null, 2)}\n`
if (arg('--out')) fs.writeFileSync(arg('--out'), text)
process.stdout.write(text)
