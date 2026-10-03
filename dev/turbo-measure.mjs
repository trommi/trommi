// Measure a page of the old client against the same page rendered by the hub (docs/turbo.md, section 6).
//   node dev/turbo-measure.mjs http://127.0.0.1:<port> <cookie name>=<token> <card number>
// Each page is loaded in a fresh headless Chromium (cold cache), once at 1440x900 and once as a phone
// (400x860, CPU slowed 4x, 40 ms round trip). Prints one JSON line per run. Needs the command sandbox disabled.
import { launchChromium } from './cdp.mjs'

const [base, cookie, card] = process.argv.slice(2)
if (!base || !cookie || !card) { console.error('usage: node dev/turbo-measure.mjs BASE COOKIE=VALUE CARD_NUMBER'); process.exit(2) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const PAGES = [
  { name: 'desk old', path: '/', ready: '.inbox-row' },
  { name: 'desk turbo', path: '/t/', ready: '.inbox-row' },
  { name: 'card old', path: `/q/${card}`, ready: '.focus-card[data-shown] .focus-opt' },
  { name: 'card turbo', path: `/t/q/${card}`, ready: '.focus-card[data-shown] .focus-opt' },
]
const SIZES = [{ name: 'desktop', width: 1440, height: 900 }, { name: 'phone 4x cpu 40ms', width: 400, height: 860, slow: true }]

async function measure(p, size) {
  const browser = await launchChromium({ width: size.width, height: size.height })
  try {
    const page = await browser.page()
    await page.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: size.width < 600 })
    await page.send('Network.enable')
    await page.send('Page.enable')
    await page.send('Performance.enable')
    const [name, value] = cookie.split('=')
    await page.send('Network.setCookie', { name, value, url: base })
    if (size.slow) {
      await page.send('Emulation.setCPUThrottlingRate', { rate: 4 })
      await page.send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: -1, uploadThroughput: -1 })
    }
    // In the page, before anything runs: when the first row (or option) stands, and how long the main thread was blocked.
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__m = { ready: null, long: 0, longest: 0 }
      new PerformanceObserver(l => { for (const e of l.getEntries()) { __m.long += e.duration; __m.longest = Math.max(__m.longest, e.duration) } }).observe({ type: 'longtask', buffered: true })
      const look = () => { if (__m.ready == null && document.querySelector(${JSON.stringify(p.ready)})) { __m.ready = performance.now(); return true } }
      const mo = new MutationObserver(() => { if (look()) mo.disconnect() })
      mo.observe(document, { childList: true, subtree: true, attributes: true })` })
    let requests = 0, bytes = 0, js = 0, jsBytes = 0
    const kinds = new Map()
    page.on('Network.responseReceived', e => { kinds.set(e.requestId, e.type) })
    page.on('Network.requestWillBeSent', () => { requests++ })
    page.on('Network.loadingFinished', e => { bytes += e.encodedDataLength; if (kinds.get(e.requestId) === 'Script') { js++; jsBytes += e.encodedDataLength } })
    await page.send('Page.navigate', { url: base + p.path })
    await sleep(size.slow ? 9000 : 6000)
    const r = await page.send('Runtime.evaluate', { returnByValue: true, expression: `({ ...__m, fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null, dom: document.querySelectorAll('*').length, rows: document.querySelectorAll(${JSON.stringify(p.ready)}).length })` })
    const metrics = Object.fromEntries((await page.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]))
    const v = r.result.value
    return { page: p.name, size: size.name, requests, kB: Math.round(bytes / 1024), scripts: js, scriptKB: Math.round(jsBytes / 1024), firstPaintMs: v.fcp == null ? null : Math.round(v.fcp), rowsThereMs: v.ready == null ? null : Math.round(v.ready), longTasksMs: Math.round(v.long), longestTaskMs: Math.round(v.longest), scriptMs: Math.round(metrics.ScriptDuration * 1000), layoutStyleMs: Math.round((metrics.LayoutDuration + metrics.RecalcStyleDuration) * 1000), domNodes: v.dom, found: v.rows }
  } finally { await browser.close() }
}

for (const size of SIZES) for (const p of PAGES) console.log(JSON.stringify(await measure(p, size)))
process.exit(0)
