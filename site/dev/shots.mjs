// Pictures of the site for review, made with headless Chromium (dev/cdp.mjs: `chromium` on the PATH, or the program
// CHROMIUM names; it cannot run inside a command sandbox).
//
//   node site/dev/shots.mjs site [--site http://127.0.0.1:8910] [--out DIR]
//       the site itself for review: every page on a desktop (1440×900) and on a phone (390×844), light and dark,
//       the window and the whole page (PNG, into .shots/ unless --out names a folder). dev/serve.mjs must run.
// Exit 1: no server. Exit 3: a page logged an error.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchChromium } from './cdp.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1] }
const what = args[0]
const sleep = ms => new Promise(r => setTimeout(r, ms))
const stop = message => { console.error(message); process.exit(1) }
/** Is there a server at this address? */
const answers = url => fetch(url, { redirect: 'manual' }).then(() => true, () => false)

/** One picture: { url, width, height, scale, dark, full, out, ready (an expression that is true once painted), before (script),
    wait (ms), missing (the address answers 404 on purpose) }. Returns how many errors the page logged. */
async function shot(job) {
  const { url, width, height, scale = 1, dark = false, full = false, out, ready = 'document.readyState === "complete"', before } = job
  const browser = await launchChromium({ width, height })
  try {
    const page = await browser.page()
    const errors = []
    page.on('Runtime.exceptionThrown', e => errors.push(`exception: ${e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text}`))
    page.on('Log.entryAdded', e => { if (job.missing && /status of 404/.test(e.entry.text)) return; if (e.entry.level === 'error' || /Content Security Policy/i.test(e.entry.text)) errors.push(`log: ${e.entry.text} ${e.entry.url ?? ''}`) })
    await page.send('Runtime.enable'); await page.send('Log.enable'); await page.send('Page.enable')
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: width < 600 })
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] })
    await page.send('Page.navigate', { url })
    let painted = false
    for (let i = 0; i < 100 && !painted; i++) {
      const r = await page.send('Runtime.evaluate', { expression: ready, returnByValue: true }).catch(() => null)
      painted = !!r?.result?.value
      if (!painted) await sleep(100)
    }
    // a page that never got ready is no picture: the file that is there stays
    if (!painted) { console.log(`${out} not written: ${url} did not get ready`); return 1 }
    await page.send('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => 1)', awaitPromise: true })
    await sleep(job.wait ?? 600)
    if (before) { await page.send('Runtime.evaluate', { expression: `(async () => { ${before} })()`, awaitPromise: true }); await sleep(300) }
    const params = { format: out.endsWith('.webp') ? 'webp' : 'png', ...(out.endsWith('.webp') ? { quality: 82 } : {}) }
    if (full) {
      // pictures further down load only when they come near: all of them now
      await page.send('Runtime.evaluate', { expression: 'Promise.all([...document.images].map(i => { i.loading = "eager"; return i.decode().catch(() => 0) }))', awaitPromise: true })
      const m = await page.send('Runtime.evaluate', { expression: 'Math.ceil(document.documentElement.scrollHeight)', returnByValue: true })
      Object.assign(params, { captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: m.result.value, scale: 1 } })
    }
    const got = await page.send('Page.captureScreenshot', params)
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, Buffer.from(got.data, 'base64'))
    console.log(`${out} ${(fs.statSync(out).size / 1024).toFixed(0)} KB${errors.length ? `\n  ${errors.join('\n  ')}` : ''}`)
    return errors.length
  } finally { await browser.close() }
}

let bad = 0
if (what === 'site') {
  const site = flag('--site', 'http://127.0.0.1:8910')
  const dir = flag('--out', path.join(here, '..', '.shots'))
  if (!await answers(site)) stop(`No site at ${site}. Start it with "node site/dev/serve.mjs", or name it with --site.`)
  for (const [name, width, height] of [['desktop', 1440, 900], ['phone', 390, 844]]) {
    for (const dark of [false, true]) {
      for (const [page, url] of [['home', '/'], ['privacy', '/privacy'], ['imprint', '/imprint'], ['404', '/nothing-here']]) {
        const out = path.join(dir, `${page}-${name}-${dark ? 'dark' : 'light'}`)
        bad += await shot({ url: `${site}${url}`, width, height, dark, out: `${out}.png`, missing: page === '404' })
        bad += await shot({ url: `${site}${url}`, width, height, dark, full: true, out: `${out}-full.png`, missing: page === '404' })
      }
    }
  }
} else {
  console.error('usage: node site/dev/shots.mjs site (see the head of this file)')
  process.exit(2)
}
process.exit(bad ? 3 : 0)
