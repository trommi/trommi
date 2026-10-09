// measure.mjs: what a built app weighs and how long its core worker takes to start, as numbers to compare two builds by.
//   node tests/web/build/measure.mjs [--tree <built folder>] [--out <file.json>]
// --tree: a built app (public/ after `build.mjs --write`, or a folder of built.mjs). Without it this checkout is
// built into a temporary folder, with the probe worker beside it.
// Sizes: every generated script, stylesheet and .wasm, summed per class, raw, gzip (level 9) and brotli (quality 11):
//   page    gen/app/*.mjs the page loads (the entry, its chunks, core-start)
//   worker  gen/app/core-worker*.mjs (with the Rust core's scripts inside, once the worker loads the core)
//   css     gen/bundle.*.css
//   wasm    gen/app/*.wasm
// Cold start: the time from `new Worker(…)` to the worker's first sign, in a new browser process each time, the median
// of five. For the app's worker the sign is its `ready` message (nothing is opened: no room, no hub). For the probe
// worker (test/probe-worker.mjs, when the folder has one: core-wasm.ts alone) it is its `loaded` message: the
// binding's init() done, that is the .wasm fetched with integrity, compiled and instantiated. The probe's own size
// is given too: it is what the Rust core's scripts add to a worker.
// These are times of this machine over loopback with nothing cached: no network, no phone. They compare builds.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { launchChromium } from '../../../app/web/dev/cdp.mjs'
import { tempDir, writeBuilt, writeProbe } from './built.mjs'
import { serveStatic } from './static.mjs'

const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1] }
const RUNS = 5
const median = list => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)]

const weigh = bytes => ({ raw: bytes.length, gzip: zlib.gzipSync(bytes, { level: 9 }).length, brotli: zlib.brotliCompressSync(bytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } }).length })

function sizes(dir) {
  const classOf = f => (/^gen\/app\/.*\.wasm$/.test(f) ? 'wasm' : /^gen\/bundle\..*\.css$/.test(f) ? 'css' : /^gen\/app\/core-worker[^/]*\.mjs$/.test(f) ? 'worker' : /^gen\/app\/.*\.mjs$/.test(f) ? 'page' : null)
  const files = [...fs.readdirSync(path.join(dir, 'gen/app')).map(f => `gen/app/${f}`), ...fs.readdirSync(path.join(dir, 'gen')).filter(f => f.startsWith('bundle.')).map(f => `gen/${f}`)].sort()
  const out = { page: null, worker: null, css: null, wasm: null }
  for (const f of files) {
    const kind = classOf(f)
    if (!kind) continue
    const one = weigh(fs.readFileSync(path.join(dir, f)))
    out[kind] ??= { files: 0, raw: 0, gzip: 0, brotli: 0 }
    out[kind].files++
    for (const k of ['raw', 'gzip', 'brotli']) out[kind][k] += one[k]
  }
  return out
}

/** Milliseconds from new Worker to the message `sign` accepts, in a new browser process. */
async function coldStart(origin, worker, sign) {
  const browser = await launchChromium({ width: 800, height: 600 })
  try {
    const page = await browser.page()
    await page.send('Page.enable')
    const loaded = new Promise(resolve => { const off = page.on('Page.loadEventFired', () => { off(); resolve() }) })
    await page.send('Page.navigate', { url: `${origin}/__blank` })
    await loaded
    const res = await page.send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `new Promise((resolve, reject) => {
      const sign = ${sign}
      const t0 = performance.now()
      const worker = new Worker(${JSON.stringify(worker)}, { type: 'module', name: 'trommi-core' })
      worker.onmessage = e => { if (sign(e.data)) resolve(performance.now() - t0) }
      worker.onerror = e => reject(new Error('the worker did not start: ' + (e.message || 'no message')))
    })` })
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description?.split('\n')[0] ?? res.exceptionDetails.text)
    return res.result.value
  } finally {
    await browser.close()
  }
}

const tmp = arg('--tree') ? null : tempDir('measure')
try {
  const dir = path.resolve(arg('--tree') ?? path.join(tmp, 'dist'))
  if (tmp) { await writeBuilt(dir); await writeProbe(dir) }
  const report = { tree: arg('--tree') ? dir : 'this checkout', sizes: sizes(dir), cold_start_ms: {} }
  const server = await serveStatic(dir, { pages: { '/__blank': '<!doctype html><meta charset="utf-8"><title>measure</title>' } })
  try {
    const appWorker = fs.readdirSync(path.join(dir, 'gen/app')).find(f => /^core-worker-[^-]+\.mjs$/.test(f))
    const cases = [['app_worker_ready', `/gen/app/${appWorker}`, 'm => m && m.t === "ready"']]
    if (fs.existsSync(path.join(dir, 'test/probe-worker.mjs'))) {
      report.sizes.probe_worker = weigh(fs.readFileSync(path.join(dir, 'test/probe-worker.mjs')))
      cases.push(['probe_worker_core_loaded', '/test/probe-worker.mjs', 'm => m && (m.loaded === true || m.error !== undefined)'])
    }
    for (const [name, worker, sign] of cases) {
      const runs = []
      for (let i = 0; i < RUNS; i++) runs.push(Math.round(await coldStart(server.origin, worker, sign) * 10) / 10)
      report.cold_start_ms[name] = { median: median(runs), runs }
    }
  } finally {
    await server.close()
  }
  const text = `${JSON.stringify(report, null, 2)}\n`
  if (arg('--out')) fs.writeFileSync(arg('--out'), text)
  process.stdout.write(text)
} finally {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
}
