// screens.mjs: screen parity, the web's demo screens (/screens, demo.mjs SCREENS) beside the iPhone's (README "Interop").
//
//   node dev/interop/screens.mjs --fixture          regenerate fixtures/screens.json from demo.mjs SCREENS (the contract
//                                                   the iOS app's demo states follow)
//   node dev/interop/screens.mjs                    web screenshots (393x852, light and dark) + out/screens.html
//   node dev/interop/screens.mjs --iphone           also the iPhone: for every state the app is started on the phone
//                                                   with TROMMI_SCREEN=<id> TROMMI_THEME=<light|dark> (the demo-state
//                                                   hook of the app) and captured (pymobiledevice3, no root tunnel)
//   node dev/interop/screens.mjs --iphone-current   one picture of the app as it starts now (its real room), no states
//   --only <text>: states whose id has the text. Pictures go to dev/interop/out/screens/ (not in git).
//
// Web: app/web/dev/serve.mjs on a free port, headless Chromium (dev/cdp.mjs). iPhone: udid TROMMI_UDID (default the
// owner's phone), bundle TROMMI_BUNDLE, pymobiledevice3 from PYMOBILEDEVICE3 (default ~/pymobile3-venv/bin/pymobiledevice3).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn, execFile } from 'node:child_process'
import { launchChromium } from '../cdp.mjs'

const here = path.dirname(new URL(import.meta.url).pathname)
const root = path.join(here, '../..')
const argv = process.argv.slice(2)
const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }
const FIXTURE = path.join(here, 'fixtures/screens.json')
const OUT = path.join(here, 'out'), SHOTS = path.join(OUT, 'screens')
const W = 393, H = 852
const UDID = process.env.TROMMI_UDID ?? '00008150-00084C891138401C'
const BUNDLE = process.env.TROMMI_BUNDLE ?? 'XTL-70CB783D.com.trommi.ios'
const PMD = process.env.PYMOBILEDEVICE3 ?? path.join(os.homedir(), 'pymobile3-venv/bin/pymobiledevice3')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** demo.mjs SCREENS: [title, path, states: [label, path?, state?, mock?][], first state?] */
function demoScreens() {
  const src = fs.readFileSync(path.join(root, 'app/web/public/demo/demo.mjs'), 'utf8')
  return new Function(`return ${/const SCREENS = (\[[\s\S]*?\n\])\n/.exec(src)[1]}`)()
}
function makeFixture() {
  const states = []
  for (const [title, p, list, first = ''] of demoScreens()) {
    for (const [label, sp, st, mock] of [['', p, first], ...list]) {
      const id = `${slug(title)}${label ? `--${slug(label)}` : ''}`
      states.push({ id, screen: title, state: label || 'As it is', web: { path: sp || p, state: st || null, mock: mock || '1' }, ios: { env: { TROMMI_SCREEN: id }, url: `trommi://screens/${id}` } })
    }
  }
  return {
    about: 'Every state of the web demo (/screens, app/web/public/demo/demo.mjs SCREENS), the contract for the iOS app\'s demo states. Generated: node dev/interop/screens.mjs --fixture.',
    demo_data: {
      file: 'app/web/public/demo/fixture.json',
      what: 'the JS model of the demo room (shared/README.md "The model"): room, members, sessions, cards, permissions, notes, published, timelines, human registers; made by app/web/dev/make-fixture.mjs',
      time: 'every timestamp is relative to made_at: shift each by (now - made_at) when loading, as demo.mjs does',
      mocks: 'web.mock names the demo room: "1" the fixture as it is; "foot", "quiet", "side", "many", "link" are variants demo.mjs builds from it (loadFixture); the app builds the same or shows the fixture with a note',
      files: 'app/web/public/demo/files/ holds the pictures and videos the fixture\'s attachments name (attachment_id -> file)',
    },
    hook: {
      launch: 'TROMMI_SCREEN=<id> (process environment, set by `pymobiledevice3 developer dvt launch <bundle> --env TROMMI_SCREEN=<id> --env TROMMI_THEME=dark`): no room, no network; the demo data loaded, the screen and state opened, nothing stored',
      theme: 'TROMMI_THEME=light | dark overrides the system appearance',
      url: 'trommi://screens/<id> opens the same from a link (optional)',
      states: 'web.state is the click demo.mjs makes once the page is ready (demoState: select, duck, toast, bottom, menu, rail, switch, drawer, keys, note, inside, strip, with-agent, more, session-more, pair, invite, invite-emoji, invite-ended, share, board-help); the app shows the same moment (a sheet open, a menu open, scrolled)',
      size: `phone: ${W}x${H} points, light and dark`,
    },
    states,
  }
}

if (argv.includes('--fixture')) {
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true })
  fs.writeFileSync(FIXTURE, JSON.stringify(makeFixture(), null, 2) + '\n')
  console.log(`${FIXTURE}: ${makeFixture().states.length} states`)
  process.exit(0)
}

const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
const only = opt('--only')
const states = fixture.states.filter(s => !only || s.id.includes(only))
fs.mkdirSync(SHOTS, { recursive: true })

const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const pmd = (args, ms = 90_000) => new Promise(r => execFile(PMD, args, { timeout: ms }, (err, stdout, stderr) => r({ ok: !err, out: String(stdout), err: String(stderr || err?.message || '') })))

// ---- web --------------------------------------------------------------------------------------------------------
async function webShots() {
  const port = await freePort()
  const server = spawn(process.execPath, [path.join(root, 'app/web/dev/serve.mjs'), String(port)], { stdio: 'ignore' })
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base)).ok) break } catch {} await sleep(100) }
  const browser = await launchChromium({ width: W, height: H })
  const got = {}
  try {
    for (const dark of [false, true]) for (const s of states) {
      const page = await browser.page()
      await page.send('Page.enable'); await page.send('Runtime.enable')
      await page.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true })
      await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('agent-board-theme','${dark ? 'dark' : 'light'}')}catch(e){}` })
      const p = s.web.path
      await page.send('Page.navigate', { url: `${base}${p}${p.includes('?') ? '&' : '?'}mock=${s.web.mock}${s.web.state ? `&state=${s.web.state}` : ''}` })
      for (let i = 0; i < 60; i++) { const r = await page.send('Runtime.evaluate', { expression: "document.documentElement.hasAttribute('data-ready')", returnByValue: true }).catch(() => null); if (r?.result?.value) break; await sleep(100) }
      await sleep(s.web.state ? 900 : 500)
      const shot = await page.send('Page.captureScreenshot', { format: 'png' })
      const file = `web-${dark ? 'dark' : 'light'}-${s.id}.png`
      fs.writeFileSync(path.join(SHOTS, file), Buffer.from(shot.data, 'base64'))
      ;(got[s.id] ??= {})[dark ? 'dark' : 'light'] = file
      page.close()
      process.stdout.write('.')
    }
  } finally { await browser.close(); server.kill() }
  console.log(` ${states.length * 2} web pictures`)
  return got
}

// ---- iPhone -----------------------------------------------------------------------------------------------------------
async function iphoneShot(file, env = {}) {
  const launch = await pmd(['developer', 'dvt', 'launch', '--udid', UDID, ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]), BUNDLE])
  if (!launch.ok) return { error: `launch: ${launch.err.trim().split('\n').at(-1)}` }
  await sleep(3000)
  const r = await pmd(['developer', 'dvt', 'screenshot', '--udid', UDID, path.join(SHOTS, file)])
  return r.ok && fs.existsSync(path.join(SHOTS, file)) ? { file } : { error: `screenshot: ${r.err.trim().split('\n').at(-1)}` }
}
async function iphoneShots() {
  const got = {}
  for (const theme of ['light', 'dark']) for (const s of states) {
    const r = await iphoneShot(`iphone-${theme}-${s.id}.png`, { ...s.ios.env, TROMMI_THEME: theme })
    ;(got[s.id] ??= {})[theme] = r
    process.stdout.write(r.file ? '.' : 'x')
  }
  console.log(' iPhone pictures')
  return got
}

const web = await webShots()
const prev = (() => { try { return JSON.parse(fs.readFileSync(path.join(OUT, 'screens.json'), 'utf8')) } catch { return {} } })()
let iphone = prev.iphone ?? {}, current = prev.current ?? null
if (argv.includes('--iphone')) iphone = { ...iphone, ...(await iphoneShots()) }
if (argv.includes('--iphone-current')) {
  current = await iphoneShot('iphone-current.png')
  current.at = new Date().toISOString()
  console.log(current.file ? 'the app as it starts now: out/screens/iphone-current.png' : `no iPhone picture: ${current.error}`)
}
fs.writeFileSync(path.join(OUT, 'screens.json'), JSON.stringify({ at: new Date().toISOString(), web, iphone, current }, null, 2))

// ---- the page ---------------------------------------------------------------------------------------------------------
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const img = (f, alt) => (f ? `<img loading="lazy" src="screens/${esc(f)}" alt="${esc(alt)}">` : '<div class="none">not captured</div>')
const captured = states.filter(s => iphone[s.id]?.light?.file || iphone[s.id]?.dark?.file).length
const rows = states.map(s => {
  const i = iphone[s.id] ?? {}
  const note = i.light?.error ?? i.dark?.error ?? (i.light?.file ? '' : 'no demo state on the iPhone yet (TROMMI_SCREEN hook requested)')
  return `<section><h2>${esc(s.screen)} <span>${esc(s.state)}</span> <code>${esc(s.id)}</code></h2><div class="grid">
<figure>${img(web[s.id]?.light, 'web light')}<figcaption>web · light</figcaption></figure><figure>${img(i.light?.file, 'iPhone light')}<figcaption>iPhone · light</figcaption></figure>
<figure>${img(web[s.id]?.dark, 'web dark')}<figcaption>web · dark</figcaption></figure><figure>${img(i.dark?.file, 'iPhone dark')}<figcaption>iPhone · dark</figcaption></figure>
<p class="note">${esc(note)}<br><code>${esc(s.web.path)}${s.web.state ? ` · state=${esc(s.web.state)}` : ''}${s.web.mock !== '1' ? ` · mock=${esc(s.web.mock)}` : ''}</code></p></div></section>`
}).join('\n')
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Screen parity</title><style>
:root{--bg:#fbfaf7;--fg:#1d211f;--muted:#69706b;--line:#dcd9d2;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#141716;--fg:#e8ebe9;--muted:#9aa29d;--line:#323835;--card:#1b1f1d}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif}main{max-width:1400px;margin:0 auto;padding:24px 16px 64px}
h1{margin:0 0 4px}.muted{color:var(--muted)}section{border-top:1px solid var(--line);padding:14px 0}h2{font-size:1.05rem;margin:0 0 8px}h2 span{font-weight:500;color:var(--muted)}h2 code{font-size:.75rem;color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,200px)) minmax(0,1fr);gap:12px;align-items:start}figure{margin:0}figure img,.none{width:100%;aspect-ratio:393/852;object-fit:cover;object-position:top;border:1px solid var(--line);border-radius:14px;background:var(--card)}
.none{display:grid;place-items:center;color:var(--muted);font-size:.85rem}figcaption{font-size:.8rem;color:var(--muted);margin-top:4px}.note{margin:0;font-size:.85rem;color:var(--muted)}
.current{display:flex;gap:16px;align-items:start;margin:16px 0}.current img{width:200px;border:1px solid var(--line);border-radius:14px}
@media (max-width:900px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.note{grid-column:1/-1}}
</style></head><body><main><h1>Screen parity: web | iPhone</h1><p class="muted">${states.length} states of /screens at ${W}×${H}, light and dark · iPhone captured: ${captured} of ${states.length} · ${new Date().toISOString().slice(0, 16)}</p>
${current?.file ? `<div class="current"><img src="screens/${current.file}" alt="the app now"><p class="muted">The iPhone app as it starts now (${esc(current.at?.slice(0, 16))}): its real room, no demo state.<br>The states below need the app's demo hook (TROMMI_SCREEN, fixtures/screens.json).</p></div>` : ''}
${rows}</main></body></html>`
fs.writeFileSync(path.join(OUT, 'screens.html'), html)
console.log(`dev/interop/out/screens.html (${states.length} states, iPhone ${captured})`)
