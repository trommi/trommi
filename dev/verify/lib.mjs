// Shared helpers of the parity verifier (dev/verify/): profiles, one browser page with small driving helpers,
// and loading a target adapter (dev/verify/targets/<name>.mjs).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { launchChromium, guard } from '../cdp.mjs'

/** Chromium on a profile folder that stays (a real E2E room lives in its IndexedDB); one at a time per folder. */
async function launchOnProfile({ width, height, args = [], profile }) {
  fs.mkdirSync(profile, { recursive: true })
  try { fs.rmSync(path.join(profile, 'DevToolsActivePort')) } catch {}
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) { try { fs.rmSync(path.join(profile, f)) } catch {} }
  const proc = spawn(process.env.CHROMIUM || 'chromium', ['--headless=new', '--disable-gpu', '--no-proxy-server', '--disable-extensions', '--hide-scrollbars', '--no-first-run',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', `--window-size=${width},${height}`, ...args, 'about:blank'], { stdio: 'ignore', detached: true })
  guard(proc, { group: true })
  let port = 0
  for (let i = 0; i < 100 && !port; i++) { await sleep(100); try { port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]) || 0 } catch {} }
  if (!port) throw new Error('Chromium did not start on the kept profile')
  const sessions = []
  return {
    pid: proc.pid, port, profile,
    async page() {
      let target
      for (let i = 0; i < 50 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page') } catch {} if (!target) await sleep(100) }
      const ws = new WebSocket(target.webSocketDebuggerUrl)
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
      let seq = 0; const pending = new Map(), listeners = new Map()
      ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id != null) { const c = pending.get(m.id); if (!c) return; pending.delete(m.id); m.error ? c.reject(new Error(`${c.method}: ${m.error.message}`)) : c.resolve(m.result); return } for (const fn of listeners.get(m.method) ?? []) fn(m.params) }
      const session = { send: (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject, method }); ws.send(JSON.stringify({ id, method, params })) }), on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn) }, close: () => ws.close() }
      sessions.push(session)
      await session.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
      return session
    },
    async close() { for (const s of sessions) { try { s.close() } catch {} } try { process.kill(-proc.pid, 'SIGTERM') } catch {} for (let i = 0; i < 30 && proc.exitCode == null; i++) await sleep(100); try { process.kill(-proc.pid, 'SIGKILL') } catch {} },
  }
}

export const HERE = path.dirname(fileURLToPath(import.meta.url))
export const sleep = ms => new Promise(r => setTimeout(r, ms))
export const arg = (name, fallback = null) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback }

/** The four looks every state is shot in. */
export const PROFILES = {
  'desktop-light': { width: 1440, height: 900, dark: false },
  'desktop-dark': { width: 1440, height: 900, dark: true },
  'phone-light': { width: 390, height: 844, dark: false, mobile: true },
  'phone-dark': { width: 390, height: 844, dark: true, mobile: true },
}

export async function loadTarget(name) {
  const file = fs.existsSync(name) ? path.resolve(name) : path.join(HERE, 'targets', `${name}.mjs`)
  return (await import(pathToFileURL(file).href)).default
}

/**
 * One headless Chromium page with the helpers a state's act() gets:
 *   h.go(path) h.ev(js) h.waitSel(sel, ms) h.click(sel) h.key(key, {ctrl, shift}) h.type(text) h.sleep(ms) h.shot(file)
 * hosts: --host-resolver-rules for public names (app.trommi.com behind a stale local DNS).
 */
export async function openPage({ profile, base, hostRules = '', init = [], errors = [], userDataDir = null }) {
  const p = PROFILES[profile] ?? profile
  const args = hostRules ? [`--host-resolver-rules=${hostRules}`] : []
  const browser = userDataDir ? await launchOnProfile({ width: p.width, height: p.height, args, profile: userDataDir }) : await launchChromium({ width: p.width, height: p.height, args })
  const page = await browser.page()
  await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('Network.enable')
  await page.send('Emulation.setDeviceMetricsOverride', { width: p.width, height: p.height, deviceScaleFactor: 1, mobile: Boolean(p.mobile) })
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: Boolean(p.mobile), maxTouchPoints: p.mobile ? 5 : 1 })
  for (const source of init) await page.send('Page.addScriptToEvaluateOnNewDocument', { source })
  page.on('Runtime.exceptionThrown', e => errors.push(`script error: ${(e.exceptionDetails.exception?.description ?? e.exceptionDetails.text).split('\n')[0]}`))
  page.on('Runtime.consoleAPICalled', e => { if (e.type === 'error') errors.push(`console error: ${e.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 200)}`) })
  const ev = async js => {
    const r = await page.send('Runtime.evaluate', { expression: `(async () => { ${js} })()`, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(`in the page: ${(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).split('\n')[0]}`)
    return r.result?.value
  }
  const q = s => JSON.stringify(s)
  const waitFor = async (js, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await ev(js).catch(() => null); if (v) return v; if (Date.now() > end) return null; await sleep(60) } }
  const waitSel = (sel, ms) => waitFor(`return !!document.querySelector(${q(sel)})`, ms)
  const box = sel => ev(`const e = [...document.querySelectorAll(${q(sel)})].find(x => { const r = x.getBoundingClientRect(); return r.width && r.height && getComputedStyle(x).visibility !== 'hidden' }); if (!e) return null; e.scrollIntoView({ block: 'center', inline: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }`)
  const h = {
    page, browser, base, profile: p, ev, waitFor, waitSel, sleep,
    async go(to, ready, ms = 10000) { await page.send('Page.navigate', { url: /^[a-z]+:/.test(to) ? to : base + to }); if (ready) return waitSel(ready, ms); await sleep(1500); return true },
    async click(sel) {
      const b = await box(sel); if (!b) throw new Error(`nothing to click: ${sel}`)
      await sleep(60)
      if (p.mobile) { await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [b] }); await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }) }
      else { await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...b }); await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...b, button: 'left', buttons: 1, clickCount: 1 }); await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...b, button: 'left', clickCount: 1 }) }
      await sleep(300)
    },
    async hover(sel) { const b = await box(sel); if (b) await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...b }); await sleep(200) },
    async key(key, { ctrl = false, shift = false, alt = false } = {}) {
      const codes = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Tab: 9, Backspace: 8 }
      const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (shift ? 8 : 0)
      const text = key.length === 1 && !ctrl && !alt ? key : key === 'Enter' && !ctrl ? '\r' : undefined
      const vk = codes[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0)
      const code = key.length === 1 ? (/[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : /\d/.test(key) ? `Digit${key}` : key) : key
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) })
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers })
      await sleep(250)
    },
    type: text => page.send('Input.insertText', { text }),
    async settle() { await waitFor(`return document.readyState === 'complete' && !document.documentElement.hasAttribute('aria-busy')`, 6000); await sleep(400) },
    async shot(file) { const s = await page.send('Page.captureScreenshot', { format: 'png' }); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(s.data, 'base64')); return file },
    close: () => browser.close(),
  }
  return h
}
