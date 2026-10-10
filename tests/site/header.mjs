// The head of every page of the site, in headless Chromium against the local server: the theme button in its three
// states on a light and on a dark system, at rest and scrolled, the keyboard, a narrow phone, no script; and no console or Content-Security-Policy error on any page.
//
//   node tests/site/header.mjs [--site http://127.0.0.1:PORT] [--out DIR]
// Without --site it starts site/dev/serve.mjs on a free port and stops it at the end. With --out it also keeps
// pictures of what it checked (header-*.png). Exit 3 when a check fails.
// Needs Chromium (`chromium` on the PATH, or the program CHROMIUM names); it cannot run inside a command sandbox.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { launchChromium } from '../../site/dev/cdp.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1] }
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** The site's own dev server on a free port: { url, stop() }. */
async function serve() {
  const port = await new Promise((resolve, reject) => { const s = net.createServer().on('error', reject).listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
  const child = spawn(process.execPath, [path.join(here, '..', '..', 'site', 'dev', 'serve.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('exit', code => reject(new Error(`the site's server stopped (${code})`))) })
  return { url: `http://127.0.0.1:${port}`, stop: () => child.kill() }
}

/** The head of the site: checks (returns how many failed), and pictures header-*.png in dir if one is named. One browser for all. */
async function header(site, dir) {
  const KEY = 'trommi-site-theme'
  const PAGES = [['home', '/'], ['imprint', '/imprint'], ['privacy', '/privacy'], ['404', '/nothing-here']]
  const browser = await launchChromium({ width: 1440, height: 900 })
  let failed = 0
  const check = (ok, what, got) => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${got === undefined ? '' : `: ${typeof got === 'string' ? got : JSON.stringify(got)}`}`) }
  try {
    const page = await browser.page()
    const errors = [], requests = []
    page.on('Runtime.exceptionThrown', e => errors.push(`exception: ${e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text}`))
    page.on('Log.entryAdded', e => { if (/status of 404/.test(e.entry.text) && /nothing-here|404-for-storage/.test(e.entry.url ?? '')) return; if (e.entry.level === 'error' || /Content Security Policy/i.test(e.entry.text)) errors.push(`log: ${e.entry.text} ${e.entry.url ?? ''}`) })
    page.on('Runtime.consoleAPICalled', e => { if (e.type === 'error' || e.type === 'warning') errors.push(`console.${e.type}: ${e.args.map(a => a.value ?? a.description).join(' ')}`) })
    page.on('Network.requestWillBeSent', e => requests.push(new URL(e.request.url).pathname))
    for (const d of ['Runtime', 'Log', 'Page', 'Network']) await page.send(`${d}.enable`)
    await page.send('Network.setCacheDisabled', { cacheDisabled: true })
    // Before any script of the page: note when data-theme appears (is there a <body> yet? then nothing was painted),
    // and what stands at the first frame.
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__t = { at: null, body: null, frame: null }
      new MutationObserver(() => { const el = document.documentElement; if (el && window.__t.at == null && el.hasAttribute('data-theme')) window.__t = { ...window.__t, at: el.getAttribute('data-theme'), body: !!document.body } })
        .observe(document, { attributes: true, childList: true, subtree: true })
      requestAnimationFrame(() => { window.__t.frame = [document.documentElement.getAttribute('data-theme'), getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()] })` })
    const js = async expression => (await page.send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true })).result?.value
    const view = (width, height) => page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
    const system = dark => page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] })
    const go = async url => {
      requests.length = 0
      await page.send('Page.navigate', { url: `${site}${url}` })
      let loaded = false
      for (let i = 0; i < 100 && !loaded; i++) { loaded = await js('return document.readyState === "complete"').catch(() => false); if (!loaded) await sleep(100) }
      if (!loaded) check(false, `${url} loads within ten seconds`)
      await js('await document.fonts.ready; await Promise.all([...document.images].filter(i => i.loading !== "lazy").map(i => i.decode().catch(() => 0)))')
      await sleep(250)
    }
    const pick = async theme => { await go('/404-for-storage'); await js(`${theme === 'system' ? `localStorage.removeItem('${KEY}')` : `localStorage.setItem('${KEY}', '${theme}')`}`) }
    const snap = async name => {
      if (!dir) return
      const got = await page.send('Page.captureScreenshot', { format: 'png' })
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `header-${name}.png`), Buffer.from(got.data, 'base64'))
    }
    const key = async (key, code, keyCode, modifiers = 0) => {
      for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode, modifiers, ...(key === 'Enter' && type === 'keyDown' ? { text: '\r' } : {}) })
      await sleep(120)
    }
    const BG = { light: '#f5f6f2', dark: '#0e1311' }

    for (const [size, width, height] of [['desktop', 1440, 900], ['phone', 390, 844]]) {
      await view(width, height)
      for (const dark of [false, true]) {
        await system(dark)
        for (const theme of ['system', 'light', 'dark']) {
          await pick(theme)
          const shown = theme === 'system' ? (dark ? 'dark' : 'light') : theme
          const tag = `${size}, system ${dark ? 'dark' : 'light'}, picked ${theme}`
          for (const [name, url] of PAGES) {
            errors.length = 0
            await go(url)
            const t = await js('return window.__t')
            check(t.at === theme && t.body === false, `${tag}, ${name}: data-theme set before <body> exists`, t)
            check(t.frame?.[0] === theme && t.frame?.[1] === BG[shown], `${tag}, ${name}: first frame has the theme's paper`, t.frame)
            const m = await js(`const h = document.querySelector('.head'), r = h.getBoundingClientRect(), kids = [...document.querySelector('.head-in').children].filter(e => getComputedStyle(e).display !== 'none').map(e => e.getBoundingClientRect())
              return { top: r.top, h: r.height, sticky: getComputedStyle(h).position, overflow: document.documentElement.scrollWidth - innerWidth, oneRow: kids.every(k => k.top >= r.top && k.bottom <= r.bottom && k.width > 0), inside: kids.every(k => k.left >= 0 && k.right <= innerWidth),
                shadow: getComputedStyle(h).boxShadow + ' / ' + getComputedStyle(document.querySelector('.head-in')).boxShadow, heights: [...new Set([...document.querySelectorAll('.head nav a, .theme-btn, .head .btn')].filter(e => e.offsetWidth).map(e => e.offsetHeight))], checked: document.querySelector('.theme-btn').dataset.tip.replace('Theme: ', '').toLowerCase(), bg: getComputedStyle(document.body).backgroundColor, cta: getComputedStyle(document.querySelector('.to-app')).backgroundColor }`)
            check(m.sticky === 'sticky' && m.top === 0 && m.overflow <= 0 && m.oneRow && m.inside && m.checked === theme && m.heights.length === 1, `${tag}, ${name}: head in one row, one height, nothing cut, the button shows ${theme}`, m)
            if (name === 'home' || theme !== 'light') await snap(`${name}-${size}-sys${dark ? 'dark' : 'light'}-${theme}`)
            // scrolled: still at the top, now with its line and shadow
            await js('scrollTo(0, 400); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
            await sleep(150)
            const sc = await js(`const h = document.querySelector('.head'); return { y: scrollY, top: h.getBoundingClientRect().top, shadow: getComputedStyle(h).boxShadow + ' / ' + getComputedStyle(document.querySelector('.head-in')).boxShadow }`)
            if (name === 'home' || name === 'privacy') check(sc.y > 40, `${tag}, ${name}: the page scrolls`, sc)
            if (sc.y > 40) check(sc.top === 0 && sc.shadow !== m.shadow, `${tag}, ${name}: scrolled, the head stays and its shadow has grown`, sc)
            if (sc.y > 40 && name === 'home' && theme !== 'light') await snap(`${name}-${size}-sys${dark ? 'dark' : 'light'}-${theme}-scrolled`)
            check(errors.length === 0, `${tag}, ${name}: no console or CSP error`, errors.length ? errors.slice() : undefined)
          }
        }
      }

      // the rest once per size, on a light system with nothing picked
      await system(false); await pick('system'); errors.length = 0
      await go('/#connect')
      await sleep(900)
      const a = await js(`return { head: document.querySelector('.head').getBoundingClientRect().bottom, title: document.querySelector('#connect h2').getBoundingClientRect().top, y: scrollY }`)
      check(a.y > 0 && a.title >= a.head, `${size}: an anchored section starts under the head`, a)
      // the keyboard: Tab walks the head in its order, Enter on the theme button goes on to the next theme, the choice survives a reload
      await go('/')
      const order = []
      for (let i = 0; i < 6; i++) { await key('Tab', 'Tab', 9); order.push(await js(`const e = document.activeElement; return e.matches('.theme-btn') ? 'theme' : (e.getAttribute('aria-label') || e.textContent.replace(/\\s+/g, ' ').trim())`)) }
      const want = size === 'phone' ? ['Skip to the content', 'Trommi, home', 'theme', 'Open Trommi', 'Start with your agents now', 'View on GitHub'] : ['Skip to the content', 'Trommi, home', 'GitHub', 'theme', 'Open Trommi', 'Start with your agents now']
      check(JSON.stringify(order) === JSON.stringify(want), `${size}: Tab order of the head`, order)
      await js(`document.querySelector('.brand').focus()`)
      for (let i = 0; i < 4; i++) { await key('Tab', 'Tab', 9); if (await js(`return document.activeElement.matches('.theme-btn')`)) break }
      const ring = await js(`const s = getComputedStyle(document.querySelector('.theme-btn')); return s.outlineStyle + ' ' + s.outlineWidth + ' ' + getComputedStyle(document.querySelector('.theme-btn'), '::after').content`)
      check(ring === 'solid 2px "Theme: System"', `${size}: the focused theme button has its ring and says what is set`, ring)
      await key('Enter', 'Enter', 13)
      await key('Enter', 'Enter', 13)
      await sleep(250)
      const k1 = await js(`return [document.documentElement.dataset.theme, localStorage.getItem('${KEY}'), document.activeElement.dataset.tip, getComputedStyle(document.body).backgroundColor]`)
      check(k1[0] === 'dark' && k1[1] === 'dark' && k1[2] === 'Theme: Dark' && k1[3] === 'rgb(14, 19, 17)', `${size}: Enter twice goes System, Light, Dark; kept and painted`, k1)
      await snap(`keyboard-${size}-dark-focus`)
      await go('/')
      const k2 = await js(`return [window.__t.at, window.__t.body, document.querySelector('.theme-btn').dataset.tip]`)
      check(k2[0] === 'dark' && k2[1] === false && k2[2] === 'Theme: Dark', `${size}: after a reload it is still Dark, set before <body>`, k2)
      await js(`document.querySelector('.theme-btn').click()`)
      await sleep(250)
      const k3 = await js(`return [document.documentElement.dataset.theme, localStorage.getItem('${KEY}'), getComputedStyle(document.body).backgroundColor]`)
      check(k3[0] === 'system' && k3[1] === null && k3[2] === 'rgb(245, 246, 242)', `${size}: one more press goes back to System, the entry is removed`, k3)
      check(errors.length === 0, `${size}: no console or CSP error in these steps`, errors.length ? errors.slice() : undefined)
    }
    // a narrow phone, and no script at all
    await view(360, 740); await system(false); await pick('system'); await go('/')
    const n = await js(`const kids = [...document.querySelector('.head-in').children].filter(e => getComputedStyle(e).display !== 'none').map(e => e.getBoundingClientRect()); return { overflow: document.documentElement.scrollWidth - innerWidth, inside: kids.every(k => k.left >= 0 && k.right <= innerWidth) }`)
    check(n.overflow <= 0 && n.inside, 'phone 360: the head still fits', n)
    await snap('home-phone360-syslight-system')
    await view(1440, 900); await system(true)
    await page.send('Emulation.setScriptExecutionDisabled', { value: true })
    await page.send('Page.navigate', { url: `${site}/` }); await sleep(1500)
    await snap('home-desktop-sysdark-noscript')
    await page.send('Emulation.setScriptExecutionDisabled', { value: false })
    const ns = await js(`return { theme: document.documentElement.getAttribute('data-theme'), sw: getComputedStyle(document.querySelector('.theme-btn')).display, bg: getComputedStyle(document.body).backgroundColor }`)
    check(ns.theme === null && ns.sw === 'none' && ns.bg === 'rgb(14, 19, 17)', 'without script: follows the system, no theme button shown', ns)
  } finally { await browser.close() }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
  return failed
}

const own = flag('--site') ? null : await serve()
let failed = 1
try { failed = await header(flag('--site', own?.url), flag('--out', null)) } finally { own?.stop() }
process.exit(failed ? 3 : 0)
