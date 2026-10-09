// Opens the app in headless Chromium, waits until it painted (html[data-ready]), runs an optional script, prints
// console errors and exceptions and the script's result, saves a screenshot.
//   node dev/look.mjs URL WIDTH,HEIGHT [OUT.png] [--dark] [--js 'async code returning a value'] [--wait ms] [--resolve 'MAP host ip']
import { launchChromium } from './cdp.mjs'
import fs from 'node:fs'

const args = process.argv.slice(2)
const flag = name => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v }
const dark = args.includes('--dark'); if (dark) args.splice(args.indexOf('--dark'), 1)
const js = flag('--js'), wait = Number(flag('--wait') ?? 300), resolve = flag('--resolve')
const [url, size = '1440,900', out] = args
const [width, height] = size.split(',').map(Number)
const browser = await launchChromium({ width, height, args: resolve ? [`--host-resolver-rules=${resolve}`] : [] })
const sleep = ms => new Promise(r => setTimeout(r, ms))
let code = 0
try {
  const page = await browser.page()
  const errors = []
  page.on('Runtime.exceptionThrown', e => errors.push(`exception: ${e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text}`))
  page.on('Runtime.consoleAPICalled', e => { if (['error', 'warning'].includes(e.type)) errors.push(`${e.type}: ${e.args.map(a => a.value ?? a.description ?? '').join(' ')}`) })
  page.on('Log.entryAdded', e => { if (e.entry.level === 'error') errors.push(`log: ${e.entry.text} ${e.entry.url ?? ''}`) })
  await page.send('Runtime.enable'); await page.send('Log.enable'); await page.send('Page.enable')
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
  if (dark) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: "try{localStorage.setItem('trommi-theme','dark')}catch(e){}" })
  await page.send('Page.navigate', { url })
  for (let i = 0; i < 100; i++) {
    const r = await page.send('Runtime.evaluate', { expression: "document.documentElement.hasAttribute('data-ready') || !!document.getElementById('room-screen')", returnByValue: true }).catch(() => null)
    if (r?.result?.value) break
    await sleep(100)
  }
  await sleep(wait)
  if (js) {
    const r = await page.send('Runtime.evaluate', { expression: `(async () => { ${js} })()`, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) { errors.push(`script: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`); code = 1 }
    else console.log(JSON.stringify(r.result.value, null, 1))
  }
  if (out) { const shot = await page.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out, Buffer.from(shot.data, 'base64')) }
  if (errors.length) { console.log(errors.join('\n')); code ||= 3 }
} finally { await browser.close() }
process.exit(code)
