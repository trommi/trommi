// knowledge.browser.mjs: the team's knowledge in the web app (demo room, ?mock=1). The team's Desk has the tile that
// opens the page Knowledge (DeskView.tiles, key knowledge); the page lists what the core lists (KnowledgeView.rows, in its order), the search filters
// as one types and the field keeps the keyboard, the filter Pinned shows the pinned ones; an entry is added with the
// editor, pinned, edited in place and deleted, each through the core (Action::KnowledgeSave, KnowledgePin,
// KnowledgeDelete), and the page shows what the core then holds. As a 1440 px window and as a phone.
//   node tests/web/views/knowledge.browser.mjs      (needs Chromium; serves the app from its sources itself)
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { launchChromium } from '../../../app/web/dev/cdp.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, '..', '..', '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const SIZES = [{ name: '1440 wide', width: 1440, height: 900, mobile: false }, { name: 'phone', width: 390, height: 844, mobile: true }]

/** What the page shows beside what the core says (run in the page). */
const PROBE = `(() => {
  const k = trommi.vm().knowledge, rows = [...document.querySelectorAll('#kn-list > .kn-item')]
  return { vm: k ? { count: k.count, rows: k.rows.map(r => r.id), query: k.query, filter: k.filter } : null,
    shown: rows.map(li => li.id.replace(/^kn-/, '')), titles: rows.map(li => li.querySelector('.kn-title')?.textContent.trim()),
    pinned: rows.filter(li => li.classList.contains('is-pinned')).map(li => li.id.replace(/^kn-/, '')),
    total: document.querySelector('.kn-total')?.textContent.trim() ?? null, focus: document.activeElement?.name ?? null,
    value: document.querySelector('.kn-search input')?.value ?? null, page: document.scrollingElement.scrollWidth - innerWidth }
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
  const until = async (x, ms = 4000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await ev(x).catch(() => false)) return true; return false }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  for (const size of SIZES) {
    const bad = []
    await page.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: size.mobile })
    await page.send('Page.navigate', { url: 'about:blank' })
    await page.send('Page.navigate', { url: `${APP}/team/main?mock=1` })
    await until("document.readyState === 'complete' && document.documentElement.hasAttribute('data-ready') && Boolean(document.querySelector('#tile-knowledge'))", 10000)
    // the Desk's tile says how many entries and opens the page
    const chip = await ev(`(() => { const a = document.querySelector('#tile-knowledge'), t = trommi.vm().desk.tiles?.find(x => x.key === 'knowledge'); return a ? { n: a.querySelector('.dt-head i')?.textContent, line: a.querySelector('.dt-line')?.textContent, vm: trommi.vm().desk.knowledge?.count, tile: t?.count, says: t?.line?.en } : null })()`)
    if (!chip || String(chip.vm) !== chip.n || chip.tile !== chip.vm || chip.line !== chip.says || !(chip.vm > 0)) bad.push(`the Desk's tile: ${JSON.stringify(chip)}`)
    await ev("document.querySelector('#tile-knowledge').click()")
    if (!(await until("Boolean(document.querySelector('#knowledge .kn-list')) && location.pathname === '/knowledge'"))) bad.push('the tile does not open the page')
    let p = await ev(PROBE)
    if (!p.vm || !same(p.shown, p.vm.rows) || p.total !== `(${p.vm.count})`) bad.push(`the list is not the core's: ${JSON.stringify(p)}`)
    if (p.pinned.length < 1 || !same(p.shown.slice(0, p.pinned.length), p.pinned)) bad.push(`the pinned do not come first: ${JSON.stringify(p.pinned)}`)
    const all = p.vm.count
    // the search, as one types: the core's rows, and the field keeps the keyboard
    await ev("(() => { const q = document.querySelector('.kn-search input'); q.focus(); q.value = 'check'; q.dispatchEvent(new Event('input', { bubbles: true })) })()")
    await until("trommi.vm().knowledge?.query === 'check' && document.querySelectorAll('#kn-list > .kn-item').length === trommi.vm().knowledge.rows.length")
    p = await ev(PROBE)
    if (p.vm.query !== 'check' || !p.shown.length || p.shown.length >= all || !same(p.shown, p.vm.rows)) bad.push(`the search: ${JSON.stringify(p)}`)
    if (p.focus !== 'q' || p.value !== 'check') bad.push(`the field lost the keyboard or its words (${p.focus}, ${p.value})`)
    // the filter Pinned
    await ev("window.Turbo.visit('/knowledge?filter=pinned')")
    await until("trommi.vm().knowledge?.filter === 'pinned' && document.querySelectorAll('#kn-list > .kn-item').length === trommi.vm().knowledge.rows.length")
    p = await ev(PROBE)
    if (!p.shown.length || !same(p.shown, p.pinned)) bad.push(`Pinned shows others: ${JSON.stringify(p)}`)
    // added with the editor
    await ev("window.Turbo.visit('/knowledge')")
    await until("Boolean(document.querySelector('#kn-new'))")
    await ev(`(() => { document.querySelector('.kn-add').click(); const f = document.querySelector('#kn-new'); f.querySelector('[name=title]').value = 'Browser test ${size.mobile ? 'phone' : 'wide'}'; f.querySelector('[name=text]').value = 'kept by the person'; f.requestSubmit() })()`)
    if (!(await until(`trommi.vm().knowledge?.count === ${all + 1} && [...document.querySelectorAll('.kn-title')].some(t => t.textContent.includes('Browser test'))`))) bad.push('a new entry is not listed')
    const id = await ev("trommi.vm().knowledge.rows.find(r => r.title.startsWith('Browser test'))?.id")
    // pinned, edited in place, deleted
    await ev(`(() => { const li = document.getElementById('kn-${id}'); li.querySelector('details').open = true; li.querySelector('form[action$="/pin"]').requestSubmit() })()`)
    if (!(await until(`trommi.vm().knowledge.rows.find(r => r.id === '${id}')?.pinned === true && document.getElementById('kn-${id}')?.classList.contains('is-pinned')`))) bad.push('Pin does not pin')
    await ev(`(() => { const li = document.getElementById('kn-${id}'); li.querySelector('details').open = true; li.querySelector('[data-action="knowledge#edit"]').click(); const f = li.querySelector('form.kn-edit'); if (f.hidden) throw new Error('the editor stays shut'); f.querySelector('[name=text]').value = 'changed in place'; f.requestSubmit() })()`)
    if (!(await until(`trommi.vm().knowledge.rows.find(r => r.id === '${id}')?.text === 'changed in place' && document.getElementById('kn-${id}')?.querySelector('.kn-text')?.textContent === 'changed in place'`))) bad.push('Edit does not change it')
    await ev(`(() => { const li = document.getElementById('kn-${id}'); li.querySelector('details').open = true; li.querySelector('form[action$="/delete"]').requestSubmit() })()`)
    if (!(await until(`trommi.vm().knowledge.count === ${all} && !document.getElementById('kn-${id}')`))) bad.push('Delete does not take it away')
    p = await ev(PROBE)
    if (p.page > 0) bad.push(`the page scrolls ${p.page}px sideways`)
    console.log(`${bad.length ? 'FAIL' : 'ok  '} ${size.name}: ${all} entries, the search, Pinned, add, pin, edit, delete${bad.length ? `; ${bad.join('; ')}` : ''}`)
    if (bad.length) failed.push(size.name)
  }
} finally {
  await browser.close()
  server.kill()
}
process.exit(failed.length ? 1 : 0)
