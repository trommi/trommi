// desk-tiles.browser.mjs: the Desk is calm (demo room, ?mock=1). Under the questions stand the core's tiles
// (DeskView.tiles: Working / Done, Artifacts, Scribble Board, Knowledge), in its order, each with its name, its line and
// its count as the core says, each a link to its page; the board tile shows the team's board small (ViewModel.thumbs,
// painted). The note is the corner's sticky again; the Desk has no turned corner, nothing fixed over the rows but the
// selection bar and the knock strips. On a wide window Undo is a row at the sidebar's foot, the words in sight. The page
// /stacks/off shows the core's groups (OffListView.groups) in order, each with its count and its rows.
// As a 1440 px window and as a phone.
//   node tests/web/views/desk-tiles.browser.mjs      (needs Chromium; serves the app from its sources itself)
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { launchChromium } from '../../../app/web/dev/cdp.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, '..', '..', '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const SIZES = [{ name: '1440 wide', width: 1440, height: 900, mobile: false }, { name: 'phone', width: 390, height: 844, mobile: true }]

/** What the Desk shows (run in the page). */
const DESK = `(() => {
  const seen = el => { if (!el) return false; const r = el.getBoundingClientRect(), c = getComputedStyle(el); return c.display !== 'none' && c.visibility !== 'hidden' && r.width > 0 && r.height > 0 }
  const vm = trommi.vm(), d = vm.desk, list = document.querySelector('#desk-list'), end = document.querySelector('#desk-end')
  const want = (d.tiles ?? []).map(t => ({ key: t.key, title: t.title.en, line: t.line.en, count: t.key === 'work' || t.count == null ? '' : String(t.count) }))
  const shown = [...document.querySelectorAll('#desk-end .desk-tile')].map(a => ({ key: a.dataset.tile, title: a.querySelector('.dt-head b')?.textContent ?? '', line: a.querySelector('.dt-line')?.textContent ?? '', count: a.querySelector('.dt-head i')?.textContent ?? '', href: new URL(a.href).pathname }))
  const fixed = [...document.querySelectorAll('#desk-layer *, #inbox *')].filter(el => seen(el) && ['fixed', 'sticky'].includes(getComputedStyle(el).position)).map(el => el.id || el.className)
  return { vw: innerWidth, want, shown: shown.map(({ href, ...t }) => t), hrefs: shown.map(t => t.href), last: list.lastElementChild === end,
    painted: document.querySelector('#tile-board canvas')?.dataset.painted ?? null, curl: seen(document.querySelector('.curl')), fixed,
    noteLine: Boolean(document.querySelector('#desk-note, #desk-know')), corner: seen(document.querySelector('.corner-note-head')), page: document.scrollingElement.scrollWidth - innerWidth }
})()`
/** Where Undo stands after an answer (run in the page). */
const UNDO = `(async () => {
  document.querySelector('#desk-list .inbox-row .inbox-answer.is-thumb.is-lead:not(.is-ack)')?.click()
  for (let i = 0; i < 30 && !document.querySelector('#says-host .says:not([hidden]) form'); i++) await new Promise(r => setTimeout(r, 100))
  const s = document.querySelector('#says-host .says:not([hidden])'), side = document.querySelector('#agents')?.getBoundingClientRect()
  if (!s) return null
  const r = s.getBoundingClientRect(), w = s.querySelector('.says-words span')?.getBoundingClientRect()
  return { left: r.left, right: r.right, sideRight: side?.right ?? 0, words: (w?.width ?? 0) > 20 }
})()`
/** What the page Off your mind shows against the core's groups (run in the page). */
const OFF = `(() => {
  const g = trommi.vm().off?.groups ?? []
  const shown = [...document.querySelectorAll('#off-end .off-group')].map(s => ({ head: s.querySelector('h3')?.textContent.trim(), ids: [...s.querySelectorAll('.off-row')].map(a => a.id.slice(4)) }))
  return { want: g.map(x => ({ head: \`\${x.says.en} \${x.count}\`, ids: x.ids })), shown, page: document.scrollingElement.scrollWidth - innerWidth }
})()`

async function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.unref(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })
}

const port = await freePort()
const server = spawn(process.execPath, [path.join(repo, 'app', 'web', 'dev', 'serve.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'] })
await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (String(d).includes('http://')) resolve() }); server.on('exit', c => reject(new Error(`the app server ended (${c})`))) })
const APP = `http://127.0.0.1:${port}`
const browser = await launchChromium({ width: 1440, height: 900 })
const failed = []
try {
  const page = await browser.page()
  await page.send('Runtime.enable'); await page.send('Page.enable')
  const ev = async x => { const r = await page.send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value }
  for (const size of SIZES) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: size.mobile })
    await page.send('Page.navigate', { url: 'about:blank' })
    await page.send('Page.navigate', { url: `${APP}/?mock=1` })
    for (let i = 0; i < 100; i++) { if (await ev("document.readyState === 'complete' && document.documentElement.hasAttribute('data-ready') && Boolean(document.querySelector('#desk-list'))").catch(() => false)) break; await sleep(100) }
    await sleep(700)
    const bad = []
    for (let i = 0; i < 40 && !(await ev("Boolean(document.querySelector('#tile-board canvas')?.dataset.painted)")); i++) await sleep(100)
    const p = await ev(DESK)
    if (p.want.length !== 4) bad.push(`the demo room's team should have four tiles, the core gives ${p.want.length}`)
    if (JSON.stringify(p.want) !== JSON.stringify(p.shown)) bad.push(`the tiles: the core says ${JSON.stringify(p.want)}, the Desk shows ${JSON.stringify(p.shown)}`)
    if (p.hrefs.join(' ') !== '/stacks/off /artifacts /scribble-board /knowledge') bad.push(`where the tiles lead: ${p.hrefs.join(' ')}`)
    if (!p.last) bad.push('the tiles are not the last thing under the questions')
    if (!p.painted?.startsWith('ready:')) bad.push(`the board tile's picture: ${p.painted}`)
    if (p.curl) bad.push('the Desk has a turned corner')
    if (p.noteLine) bad.push('the note line or the Knowledge chip is still there')
    if (p.fixed.length) bad.push(`fixed over the Desk: ${p.fixed.join(', ')}`)
    if (!size.mobile && !p.corner) bad.push('the corner note is not there')
    if (p.page > 0) bad.push(`the Desk scrolls ${p.page}px sideways`)
    if (!size.mobile) {
      const u = await ev(UNDO)
      if (!u || u.right > u.sideRight + 1 || !u.words) bad.push(`Undo is not a row in the sidebar with its words: ${JSON.stringify(u)}`)
    }
    await page.send('Page.navigate', { url: `${APP}/stacks/off?mock=1` })
    for (let i = 0; i < 100; i++) { if (await ev("document.documentElement.hasAttribute('data-ready') && Boolean(document.querySelector('#off-end .off-group'))").catch(() => false)) break; await sleep(100) }
    await sleep(400)
    const o = await ev(OFF)
    if (!o.want.length) bad.push('the core names no group')
    if (JSON.stringify(o.want) !== JSON.stringify(o.shown)) bad.push(`the groups: the core says ${JSON.stringify(o.want)}, the page shows ${JSON.stringify(o.shown)}`)
    if (o.page > 0) bad.push(`the page Off your mind scrolls ${o.page}px sideways`)
    console.log(`${bad.length ? 'FAIL' : 'ok  '} ${size.name}: ${p.shown.map(t => t.title).join(', ')} under the questions, ${o.shown.length} groups on the page${bad.length ? `; ${bad.join('; ')}` : ''}`)
    if (bad.length) failed.push(size.name)
  }
} finally {
  await browser.close()
  server.kill()
}
process.exit(failed.length ? 1 : 0)
