// The pictures of the site, made with headless Chromium (the web app's dev/cdp.mjs: `chromium` on the PATH, or the
// program CHROMIUM names; it cannot run inside a command sandbox).
//
//   node dev/shots.mjs app  [--app http://127.0.0.1:8900] [--card /card/10] [--only NAME]
//       the screenshots the pages show (public/img/*.webp): the web app in its demo room (?mock=1), light and dark,
//       the demo's own note taken out. The web app's dev server must run (npm run serve in the repository's root),
//       and the demo room (demo/data/fixture.json) must hold agents and cards: an empty room makes no pictures, and
//       the ones in public/img stay as they are.
//   node dev/shots.mjs site [--site http://127.0.0.1:8910] [--out DIR]
//       the site itself for review: every page on a desktop (1440×900) and on a phone (390×844), light and dark,
//       the window and the whole page (PNG, into .shots/ unless --out names a folder). dev/serve.mjs must run.
// Exit 1: nothing to picture (no server, an empty demo room). Exit 3: a page logged an error.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchChromium } from '../../web/dev/cdp.mjs'

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
    for (let i = 0; i < 100; i++) {
      const r = await page.send('Runtime.evaluate', { expression: ready, returnByValue: true }).catch(() => null)
      if (r?.result?.value) break
      await sleep(100)
    }
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
if (what === 'app') {
  const app = flag('--app', 'http://127.0.0.1:8900')
  const card = flag('--card', '/card/10')
  const dir = path.join(here, '..', 'public', 'img')
  // The pictures show a Desk with questions and one open card: a room without them has nothing to show.
  const fixture = path.join(here, '..', '..', '..', 'demo', 'data', 'fixture.json')
  const room = fs.existsSync(fixture) ? JSON.parse(fs.readFileSync(fixture, 'utf8')) : null
  if (!room) stop(`No demo room: ${fixture} is not there. The pictures in public/img stay as they are.`)
  if (!room.sessions?.length || !room.cards?.length) stop(`The demo room (${path.relative(process.cwd(), fixture)}) is empty: ${room.sessions?.length ?? 0} agents, ${room.cards?.length ?? 0} cards. The site's pictures need a room with agents and cards; the ones in public/img stay as they are.`)
  if (!await answers(app)) stop(`No web app at ${app}. Start it with "npm run serve" in the repository's root, or name it with --app.`)
  const ready = 'document.documentElement.hasAttribute("data-ready")'
  // The demo's own note ("Demo · All screens · leave": a band on a phone, a slip in the sidebar) is not part of the app a person sees.
  const before = 'const s = new CSSStyleSheet(); s.replaceSync(".demo-band, .side-demo { display: none !important }"); document.adoptedStyleSheets = [...document.adoptedStyleSheets, s]'
  for (const job of [
    { url: `${app}/?mock=1`, width: 1280, height: 800, scale: 2, out: path.join(dir, 'desk-desktop.webp') },
    { url: `${app}${card}?mock=1`, width: 1280, height: 800, scale: 2, out: path.join(dir, 'card-desktop.webp') },
    { url: `${app}/?mock=1`, width: 390, height: 844, scale: 2, out: path.join(dir, 'desk-phone.webp') },
    { url: `${app}${card}?mock=1`, width: 390, height: 844, scale: 2, out: path.join(dir, 'card-phone.webp') },
  ]) {
    // --only NAME: just that picture (and its dark twin), e.g. --only desk-phone
    if (flag('--only') && path.basename(job.out, '.webp') !== flag('--only')) continue
    bad += await shot({ ...job, ready, before, wait: 1500 })
    // the same in the app's dark theme, for a reader whose system is dark (<picture> in index.html)
    bad += await shot({ ...job, ready, before, wait: 1500, dark: true, out: job.out.replace('.webp', '-dark.webp') })
  }
} else if (what === 'site') {
  const site = flag('--site', 'http://127.0.0.1:8910')
  const dir = flag('--out', path.join(here, '..', '.shots'))
  if (!await answers(site)) stop(`No site at ${site}. Start it with "node dev/serve.mjs", or name it with --site.`)
  for (const [name, width, height] of [['desktop', 1440, 900], ['phone', 390, 844]]) {
    for (const dark of [false, true]) {
      for (const [page, url] of [['home', '/'], ['pricing', '/pricing'], ['privacy', '/privacy'], ['imprint', '/imprint'], ['404', '/nothing-here']]) {
        const out = path.join(dir, `${page}-${name}-${dark ? 'dark' : 'light'}`)
        bad += await shot({ url: `${site}${url}`, width, height, dark, out: `${out}.png`, missing: page === '404' })
        bad += await shot({ url: `${site}${url}`, width, height, dark, full: true, out: `${out}-full.png`, missing: page === '404' })
      }
    }
  }
} else {
  console.error('usage: node dev/shots.mjs app|site (see the head of this file)')
  process.exit(2)
}
process.exit(bad ? 3 : 0)
