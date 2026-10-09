// shoot.mjs: pictures of every screen of the web app's demo, to compare the app before and after a change of what
// lies under its views. The rule they serve: the GUI must not change.
//
//   node tests/web/shots/shoot.mjs --tree <checkout> --fixture <folder> --out <folder> [--only <text>] [--jobs <n>]
//   node tests/web/shots/shoot.mjs --diff <before folder> <after folder> [--tolerance <0-255>] [--show <folder>]
//
// --tree     a checkout of the repository (default: this one). Its own dev server (app/web/dev/serve.mjs) is started
//            and serves the app; nothing of it is changed.
// --fixture  a demo room as TEST DATA: fixture.json, files/ and screens.json in the form of demo/README.md. It never
//            enters the repository: a small server here stands in front of the dev server and answers the two
//            addresses the demo fetches (/demo/fixture.json, /demo/files/…) from this folder, everything else is the
//            dev server's answer untouched.
// --out      where the pictures go: <screen>-<width>-<theme>.png, and shots.json (every picture with its address
//            and what the page complained about).
// --only     only the screens whose id contains the text.   --jobs: how many browsers at once (default 4).
//
// The screens are the fixture's own list (screens.json: every screen and state of the demo, with the address and the
// click that leads there, as the app's /screens page walks them) and the help page. Each is shot at 1440×900 and at
// 390×844 (as a phone: touch, no hover), light and dark (prefers-color-scheme).
//
// What makes two runs the same picture: the clock stands still at one fixed moment (Date), time zone UTC, locale
// en-US, Math.random and crypto.getRandomValues give one fixed sequence (the demo holds no secret), storage is
// emptied before every screen, the page is given time until it is quiet (no request open, no change in the document,
// fonts and pictures in), running animations are put at their end and the caret is hidden. A screen that is still not
// the same twice in a row (--diff of two runs of the same tree) is one whose picture cannot be trusted: say so.
//
// --diff decodes the pictures itself (PNG as Chromium writes it: 8 bit, RGB or RGBA, not interlaced) and counts, per
// file, the pixels that differ by more than the tolerance in any channel, and says in which rectangle of the picture
// they lie. With --show it writes, for every picture that differs, one picture into that folder: before, after, and
// the after once more, dimmed, with every differing pixel in red. It ends with 1 when any file differs or is only on
// one side.
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { launchChromium } from '../../../app/web/dev/cdp.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const arg = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1] }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const fail = message => { console.error(`shoot: ${message}`); process.exit(2) }

// ---- comparing two folders of pictures ----

/** A PNG as { width, height, channels, pixels (bytes, row after row) }. */
function decodePng(file) {
  const data = fs.readFileSync(file)
  if (data.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file} is not a PNG`)
  let head = null
  const packed = []
  for (let at = 8; at < data.length;) {
    const length = data.readUInt32BE(at), type = data.toString('latin1', at + 4, at + 8), body = data.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') head = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colour: body[9], interlace: body[12] }
    if (type === 'IDAT') packed.push(body)
    at += 12 + length
  }
  if (!head || head.depth !== 8 || ![2, 6].includes(head.colour) || head.interlace) throw new Error(`${file}: a PNG this tool does not read (8 bit RGB or RGBA, not interlaced)`)
  const channels = head.colour === 6 ? 4 : 3, stride = head.width * channels
  const raw = zlib.inflateSync(Buffer.concat(packed)), pixels = Buffer.alloc(stride * head.height)
  for (let y = 0; y < head.height; y++) {
    const filter = raw[y * (stride + 1)], line = y * (stride + 1) + 1, out = y * stride
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[out + x - channels] : 0, up = y ? pixels[out + x - stride] : 0, upLeft = y && x >= channels ? pixels[out + x - stride - channels] : 0
      const paeth = () => { const p = left + up - upLeft, a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - upLeft); return a <= b && a <= c ? left : b <= c ? up : upLeft }
      pixels[out + x] = raw[line + x] + [0, left, up, (left + up) >> 1, paeth()][filter]
    }
  }
  return { width: head.width, height: head.height, channels, pixels }
}

/** RGB pixels as a PNG file (no filter, as zlib packs it). */
function encodePng(width, height, rgb) {
  const chunk = (type, body) => { const c = Buffer.alloc(12 + body.length); c.writeUInt32BE(body.length, 0); c.write(type, 4, 'latin1'); body.copy(c, 8); c.writeUInt32BE(zlib.crc32(c.subarray(4, 8 + body.length)), 8 + body.length); return c }
  const head = Buffer.alloc(13)
  head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = 2
  const rows = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) rgb.copy(rows, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

function diff(before, after, tolerance, show) {
  const list = dir => fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort()
  const [a, b] = [list(before), list(after)]
  const rows = []
  for (const f of [...new Set([...a, ...b])].sort()) {
    if (!a.includes(f) || !b.includes(f)) { rows.push({ file: f, only: a.includes(f) ? 'before' : 'after' }); continue }
    if (fs.readFileSync(path.join(before, f)).equals(fs.readFileSync(path.join(after, f)))) continue
    const [p, q] = [decodePng(path.join(before, f)), decodePng(path.join(after, f))]
    if (p.width !== q.width || p.height !== q.height) { rows.push({ file: f, size: `${p.width}×${p.height} before, ${q.width}×${q.height} after` }); continue }
    let different = 0
    // (before | after | the after dimmed, the differing pixels red)
    const side = show ? Buffer.alloc(p.width * 3 * 3 * p.height) : null
    const box = { left: p.width, top: p.height, right: -1, bottom: -1 }
    for (let i = 0; i < p.width * p.height; i++) {
      if (side) for (let c = 0; c < 3; c++) {
        const row = (i - i % p.width) * 9, x = (i % p.width) * 3 + c
        side[row + x] = p.pixels[i * p.channels + c]; side[row + p.width * 3 + x] = q.pixels[i * q.channels + c]; side[row + p.width * 6 + x] = 128 + (q.pixels[i * q.channels + c] >> 2)
      }
      for (let c = 0; c < 3; c++) if (Math.abs(p.pixels[i * p.channels + c] - q.pixels[i * q.channels + c]) > tolerance) {
        different++
        const x = i % p.width, y = (i - x) / p.width
        if (side) Buffer.from([255, 0, 0]).copy(side, y * p.width * 9 + p.width * 6 + x * 3)
        box.left = Math.min(box.left, x); box.right = Math.max(box.right, x); box.top = Math.min(box.top, y); box.bottom = Math.max(box.bottom, y)
        break
      }
    }
    if (different && side) fs.writeFileSync(path.join(show, f), encodePng(p.width * 3, p.height, side))
    if (different) rows.push({ file: f, different, of: p.width * p.height, where: `within ${box.right - box.left + 1}×${box.bottom - box.top + 1} at ${box.left},${box.top}` })
  }
  for (const r of rows.sort((x, y) => (y.different ?? Infinity) - (x.different ?? Infinity))) console.log(r.only ? `${r.file}: only ${r.only}` : r.size ? `${r.file}: ${r.size}` : `${r.file}: ${r.different} of ${r.of} pixels differ (${(100 * r.different / r.of).toFixed(3)} %), ${r.where}`)
  const same = new Set([...a, ...b]).size - rows.length
  console.log(`${rows.length ? 'DIFFERENT' : 'the same'}: ${same} pictures the same, ${rows.length} not${tolerance ? ` (tolerance ${tolerance})` : ''}`)
  return rows.length ? 1 : 0
}

if (args.includes('--diff')) {
  const [before, after] = args.slice(args.indexOf('--diff') + 1)
  if (!before || !after || !fs.existsSync(before) || !fs.existsSync(after)) fail('usage: --diff <before folder> <after folder> [--tolerance <0-255>] [--show <folder>]')
  const show = arg('--show') && path.resolve(arg('--show'))
  if (show) fs.mkdirSync(show, { recursive: true })
  process.exit(diff(before, after, Number(arg('--tolerance') ?? 0), show))
}

// ---- taking the pictures ----

const tree = path.resolve(arg('--tree') ?? path.join(HERE, '..', '..', '..'))
const fixture = arg('--fixture') && path.resolve(arg('--fixture')), out = arg('--out') && path.resolve(arg('--out'))
if (!fixture || !out) fail('usage: --tree <checkout> --fixture <folder> --out <folder>   (or --diff <before> <after>)')
for (const f of [path.join(tree, 'app/web/dev/serve.mjs'), path.join(fixture, 'fixture.json'), path.join(fixture, 'screens.json')]) if (!fs.existsSync(f)) fail(`${f} is missing`)

const SIZES = [{ width: 1440, height: 900, phone: false }, { width: 390, height: 844, phone: true }]
const THEMES = ['light', 'dark']
/** The clock every page sees: one moment, twenty seconds into a minute (a time shown to the minute never tips over). */
const NOW = Date.UTC(2026, 9, 9, 10, 0, 20)
/** Run before any script of the page: the standing clock and the fixed sequence of random numbers. */
const FIXED_WORLD = `(() => {
  const Real = Date
  globalThis.Date = class extends Real { constructor(...a) { if (a.length) super(...a); else super(${NOW}) } static now() { return ${NOW} } }
  let s = 0x2545f491
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s }
  Math.random = () => next() / 4294967296
  crypto.getRandomValues = a => { const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); for (let i = 0; i < b.length; i++) b[i] = next() & 255; return a }
})()`
/** Run in the page: resolves once the document did not change for a while, the fonts are in and the pictures in view
 *  are loaded; 'restless' when it never came to rest within the time given. */
const SETTLE = `(async () => {
  const until = performance.now() + 8000
  const quiet = ms => new Promise(resolve => {
    let timer = setTimeout(done, ms)
    const seen = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, performance.now() > until ? 0 : ms) })
    seen.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
    function done() { seen.disconnect(); resolve() }
  })
  await quiet(350)
  await document.fonts.ready
  await Promise.race([Promise.all([...document.images].filter(i => !i.complete && i.loading !== 'lazy').map(i => new Promise(r => { i.addEventListener('load', r); i.addEventListener('error', r) }))), new Promise(r => setTimeout(r, 4000))])
  await quiet(250)
  await document.fonts.ready
  return performance.now() > until ? 'restless' : 'quiet'
})()`
/** Run in the page just before the picture: animations at their end (an endless one at its start), no caret, every
 *  picture decoded, two frames drawn. */
const STILL = `(async () => {
  for (const a of document.getAnimations()) { try { a.finish() } catch { a.pause(); a.currentTime = 0 } }
  const sheet = new CSSStyleSheet()
  sheet.replaceSync('* { caret-color: transparent !important }')
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
  await Promise.all([...document.images].filter(i => i.complete && i.naturalWidth).map(i => i.decode().catch(() => {})))
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
})()`

const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })

/** The tree's own dev server, and in front of it the server that answers the demo's data from the fixture folder. */
async function serve() {
  const port = await freePort()
  // (the commit is named to the build, the same for every tree: a tree that is no git checkout does not ask git for
  // it on every request, and a place that shows the commit shows the same text before and after)
  const dev = spawn(process.execPath, [path.join(tree, 'app/web/dev/serve.mjs'), String(port)], { cwd: tree, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, GITHUB_SHA: '0000000' } })
  await new Promise((resolve, reject) => { dev.stdout.on('data', d => { if (String(d).includes(`:${port}`)) resolve() }); dev.on('exit', code => reject(new Error(`the dev server of ${tree} ended (${code})`))) })
  const TYPES = { '.png': 'image/png', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf', '.webm': 'video/webm' }
  const front = http.createServer((req, res) => {
    const address = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    const file = address === '/demo/fixture.json' ? path.join(fixture, 'fixture.json') : address.startsWith('/demo/files/') ? path.join(fixture, 'files', address.slice('/demo/files/'.length)) : null
    if (file) {
      if (!file.startsWith(fixture + path.sep) || !fs.existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not in the fixture\n'); return }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      res.end(fs.readFileSync(file))
      return
    }
    const ask = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, answer => { res.writeHead(answer.statusCode, answer.headers); answer.pipe(res) })
    ask.on('error', err => { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end(`${err.message}\n`) })
    req.pipe(ask)
  })
  await new Promise(resolve => front.listen(0, '127.0.0.1', resolve))
  return { origin: `http://127.0.0.1:${front.address().port}`, close: () => { dev.kill(); front.closeAllConnections(); front.close() } }
}

/** The screens: { id, address }, the fixture's list and the help page. */
function screens() {
  const list = JSON.parse(fs.readFileSync(path.join(fixture, 'screens.json'), 'utf8')).states.map(s => {
    const url = new URL(s.web.path, 'http://x')
    url.searchParams.set('mock', s.web.mock ?? '1')
    if (s.web.state) url.searchParams.set('state', s.web.state)
    return { id: s.id, address: url.pathname + url.search, state: s.web.state ?? null }
  })
  list.push({ id: 'help', address: '/help', state: null })
  const only = arg('--only')
  return only ? list.filter(s => s.id.includes(only)) : list
}

/** One browser for one size and theme: every screen in turn. Returns the list of what was shot. */
async function shootAll(origin, list, { width, height, phone }, theme) {
  // (pictures are drawn only once decoded, and a frame is shown only once every stage of it is done: without these
  // two the edges of turned thumbnails differ from run to run)
  const browser = await launchChromium({ width, height, args: ['--disable-checker-imaging', '--run-all-compositor-stages-before-draw', '--disable-threaded-animation', '--disable-threaded-scrolling'] })
  const done = []
  try {
    const page = await browser.page()
    for (const domain of ['Page', 'Runtime', 'Network']) await page.send(`${domain}.enable`)
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: phone })
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: phone })
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] })
    await page.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' })
    await page.send('Emulation.setLocaleOverride', { locale: 'en-US' })
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: FIXED_WORLD })
    let open = 0, lastTraffic = Date.now()
    const complaints = []
    const touch = change => { open = Math.max(0, open + change); lastTraffic = Date.now() }
    page.on('Network.requestWillBeSent', () => touch(1))
    page.on('Network.loadingFinished', () => touch(-1))
    page.on('Network.loadingFailed', e => { touch(-1); if (!e.canceled) complaints.push(`request failed: ${e.errorText}`) })
    page.on('Network.responseReceived', e => { if (e.response.status >= 400) complaints.push(`${e.response.status} ${new URL(e.response.url).pathname}`) })
    page.on('Runtime.exceptionThrown', e => complaints.push(`exception: ${e.exceptionDetails.exception?.description?.split('\n')[0] ?? e.exceptionDetails.text}`))
    page.on('Runtime.consoleAPICalled', e => { if (e.type === 'error') complaints.push(`console.error: ${e.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300)}`) })
    const idle = async () => { for (let i = 0; i < 100 && !(open === 0 && Date.now() - lastTraffic > 300); i++) await sleep(100) }
    const evaluate = async expression => { const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] ?? r.exceptionDetails.text); return r.result.value }
    for (const screen of list) {
      const file = `${screen.id}-${width}-${theme}.png`
      complaints.length = 0
      open = 0
      try {
        await page.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' })
        const loaded = new Promise(resolve => { const off = page.on('Page.loadEventFired', () => { off(); resolve() }) })
        await page.send('Page.navigate', { url: origin + screen.address })
        await Promise.race([loaded, sleep(20000).then(() => { throw new Error('the page did not load in 20 s') })])
        await idle()
        let rest = await evaluate(SETTLE)
        // (a state is a click the demo makes half a second after the page is in, some with steps of their own after it)
        if (screen.state) { await sleep(2500); await idle(); rest = await evaluate(SETTLE) }
        await evaluate(STILL)
        const shot = await page.send('Page.captureScreenshot', { format: 'png' })
        fs.writeFileSync(path.join(out, file), Buffer.from(shot.data, 'base64'))
        done.push({ file, id: screen.id, address: screen.address, width, height, theme, rest, complaints: [...new Set(complaints)] })
      } catch (err) {
        done.push({ file: null, id: screen.id, address: screen.address, width, height, theme, failed: err.message, complaints: [...new Set(complaints)] })
      }
    }
  } finally {
    await browser.close()
  }
  return done
}

fs.mkdirSync(out, { recursive: true })
for (const f of fs.readdirSync(out)) if (f.endsWith('.png') || f === 'shots.json') fs.rmSync(path.join(out, f))
const server = await serve()
let shots = []
try {
  const list = screens()
  if (!list.length) fail('no screen to shoot (screens.json is empty, or --only matches none)')
  const combos = SIZES.flatMap(size => THEMES.map(theme => [size, theme]))
  const jobs = Math.max(1, Number(arg('--jobs') ?? 4))
  for (let i = 0; i < combos.length; i += jobs) shots.push(...(await Promise.all(combos.slice(i, i + jobs).map(([size, theme]) => shootAll(server.origin, list, size, theme)))).flat())
} catch (err) {
  console.error(`shoot: ${err.message}${/Chromium/.test(err.message) ? ' (Chromium: `chromium` on the PATH, or CHROMIUM=<program>)' : ''}`)
  process.exitCode = 1
} finally {
  server.close()
}
shots.sort((a, b) => `${a.id}-${a.width}-${a.theme}`.localeCompare(`${b.id}-${b.width}-${b.theme}`))
fs.writeFileSync(path.join(out, 'shots.json'), `${JSON.stringify({ tree, fixture, now: new Date(NOW).toISOString(), shots }, null, 1)}\n`)
const failed = shots.filter(s => s.failed), restless = shots.filter(s => s.rest === 'restless'), complained = shots.filter(s => s.complaints.length)
for (const s of failed) console.error(`FAILED ${s.id} ${s.width} ${s.theme}: ${s.failed}`)
console.log(`shoot: ${shots.length - failed.length} pictures in ${out}; ${failed.length} failed, ${restless.length} never came to rest, ${complained.length} with complaints of the page (shots.json)`)
if (failed.length || !shots.length) process.exitCode = 1
