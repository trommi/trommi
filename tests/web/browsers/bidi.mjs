// bidi.mjs: a real PRIVATE WINDOW of Firefox, driven over WebDriver BiDi, with the page interface of pw.mjs.
//
// Why not Playwright here: its Firefox opens no private window. Neither the preference
// browser.privatebrowsing.autostart nor `-private` changes that under its own protocol (what a page stores still
// lands in the profile's storage/default/), and its separate contexts are containers, not private browsing. Started
// by hand with `-private-window`, the same Firefox binary opens one, and its own remote protocol drives it: what
// the page stores then lies under storage/private/ (`isPrivate()` checks exactly that), and `script.evaluate` runs
// in the page's own realm.
//
// What is not here: files chosen in a file field, the clipboard.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { OUT, TMP, cannot, loadPlaywright, sleep } from './pw.mjs'

const isCsp = text => /Content[ -]Security[ -]Policy/i.test(text)
const INIT = "() => { window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective+' '+(e.blockedURI||e.sample||''))) }"
/** WebDriver's names for the keys the tests press. */
const KEYS = { Enter: '', Escape: '', Backspace: '', Tab: '' }

async function freePort() {
  const probe = createServer()
  await new Promise(r => probe.listen(0, '127.0.0.1', r))
  const { port } = probe.address()
  await new Promise(r => probe.close(r))
  return port
}

/** A BiDi value as a plain one (what the tests return from a page: JSON-like data). */
function plain(v) {
  switch (v?.type) {
    case 'undefined': return undefined
    case 'null': return null
    case 'string': case 'boolean': return v.value
    case 'number': return typeof v.value === 'number' ? v.value : Number(v.value)
    case 'array': return (v.value ?? []).map(plain)
    case 'object': return Object.fromEntries((v.value ?? []).map(([k, x]) => [typeof k === 'string' ? k : plain(k), plain(x)]))
    default: return v?.value ?? null
  }
}

/** A private window of Firefox with a profile folder of its own: { page, tab(), close(), isPrivate() }. */
export async function openFirefoxPrivate(name, seen, { width = 1440, height = 900 } = {}) {
  const exe = loadPlaywright().firefox.executablePath()
  fs.mkdirSync(path.join(TMP, 'profiles'), { recursive: true })
  const dir = fs.mkdtempSync(path.join(TMP, 'profiles', `firefox-private-${name.replace(/[^\w]+/g, '-')}-`))
  const port = await freePort()
  fs.writeFileSync(path.join(dir, 'user.js'), ['browser.shell.checkDefaultBrowser', 'datareporting.policy.dataSubmissionEnabled', 'app.update.enabled', 'browser.aboutwelcome.enabled'].map(p => `user_pref(${JSON.stringify(p)}, false);\n`).join(''))
  const child = spawn(exe, [`--remote-debugging-port=${port}`, '--headless', `--width=${width}`, `--height=${height}`, '-private-window', 'about:blank', '-no-remote', '-profile', dir], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000) })
  const exited = new Promise(resolve => child.once('exit', resolve))
  const end = async () => { child.kill('SIGTERM'); const killer = setTimeout(() => child.kill('SIGKILL'), 3000); await exited; clearTimeout(killer); fs.rmSync(dir, { recursive: true, force: true }) }
  let ws = null
  for (let i = 0; i < 150 && !ws && child.exitCode === null; i++) {
    try { ws = await new Promise((ok, no) => { const w = new WebSocket(`ws://127.0.0.1:${port}/session`); w.onopen = () => ok(w); w.onerror = () => no(new Error('not yet')) }) } catch { await sleep(200) }
  }
  if (!ws) { await end(); throw cannot(`Firefox's private window did not start: ${stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 600)}`) }

  const waiting = new Map(), handlers = []
  let id = 0
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (!m.id) { for (const h of handlers) h(m); return }
    const w = waiting.get(m.id)
    waiting.delete(m.id)
    if (m.type === 'error') w.no(new Error(`${m.error}: ${m.message}`)); else w.ok(m.result)
  }
  ws.onclose = () => { for (const w of waiting.values()) w.no(new Error('the browser is gone')) }
  const send = (method, params = {}) => new Promise((ok, no) => { waiting.set(++id, { ok, no }); ws.send(JSON.stringify({ id, method, params })) })
  await send('session.new', { capabilities: {} })
  await send('session.subscribe', { events: ['log.entryAdded', 'browsingContext.load', ...(seen.requests ? ['network.beforeRequestSent', 'network.responseCompleted', 'network.fetchError'] : ['network.fetchError'])] })
  await send('script.addPreloadScript', { functionDeclaration: INIT })
  const names = new Map()   // context → the page's name
  const byRequest = new Map()
  handlers.push(m => {
    const p = m.params, who = names.get(p?.source?.context ?? p?.context) ?? name
    if (m.method === 'log.entryAdded') {
      if (p.type === 'javascript' && p.level === 'error') { (isCsp(p.text) ? seen.csp : seen.exceptions).push(`${who}: ${p.text}`); return }
      const level = p.level === 'warn' ? 'warning' : p.level
      if (level !== 'warning' && level !== 'error') return
      ;(isCsp(p.text) ? seen.csp : level === 'error' ? seen.errors : seen.warnings).push(`${who}: ${p.text}`)
    } else if (m.method === 'network.beforeRequestSent' && seen.requests) {
      const rec = { who, url: p.request.url, method: p.request.method, status: null, failed: null, at: Date.now(), ended: null }
      byRequest.set(p.request.request, rec)
      seen.requests.push(rec)
    } else if (m.method === 'network.responseCompleted') {
      const rec = byRequest.get(p.request.request)
      if (rec) { rec.status = p.response.status; rec.ended = Date.now() }
    } else if (m.method === 'network.fetchError') {
      const rec = byRequest.get(p.request.request)
      if (rec) { rec.failed = p.errorText ?? 'failed'; rec.ended = Date.now() }
      seen.network.push(`${who}: ${p.request.method} ${p.request.url} ${p.errorText ?? 'failed'}`)
    }
  })

  function driver(context, pageName) {
    names.set(context, pageName)
    const page = {
      name: pageName, context,
      async js(code) {
        const r = await send('script.evaluate', { expression: `(async () => { ${code} })()`, target: { context }, awaitPromise: true, resultOwnership: 'none', serializationOptions: { maxObjectDepth: 12 } })
        if (r.type !== 'success') throw new Error(`${pageName}: ${r.exceptionDetails?.text ?? 'the script threw'}\n    in: ${code.trim().slice(0, 200)}`)
        return plain(r.result)
      },
      async until(code, what, ms = 15000) {
        const t = Date.now()
        while (Date.now() - t < ms) { if (await page.js(`return Boolean(${code})`).catch(() => false)) return Date.now() - t; await sleep(40) }
        await page.shot(`timeout-${pageName}-${what.replace(/[^\w]+/g, '-').slice(0, 50)}`).catch(() => {})
        throw new Error(`${pageName}: timed out waiting for ${what}`)
      },
      async go(url) { await Promise.race([send('browsingContext.navigate', { context, url, wait: 'complete' }), sleep(30000)]) },
      async reload() { await Promise.race([send('browsingContext.reload', { context, wait: 'complete' }), sleep(30000)]) },
      async point(selector) {
        const at = await page.js(`const el = document.querySelector(${JSON.stringify(selector)})
          if (!el) return { no: 'not in the page' }
          el.scrollIntoView({ block: 'center', inline: 'center' })
          await new Promise(r => requestAnimationFrame(() => r()))
          const r = el.getBoundingClientRect()
          if (!r.width || !r.height) return { no: 'it has no box (hidden)' }
          const x = r.left + r.width / 2, y = r.top + r.height / 2, hit = document.elementFromPoint(x, y)
          const own = hit && (el.contains(hit) || hit.contains(el) || (el.labels && [...el.labels].some(l => l.contains(hit))))
          return own ? { x, y } : { no: 'it lies under ' + (hit ? hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') : 'nothing') }`)
        if (at.no) throw new Error(`${pageName}: cannot press ${selector}: ${at.no}`)
        return at
      },
      async click(selector) {
        const { x, y } = await page.point(selector)
        await send('input.performActions', { context, actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', x: Math.round(x), y: Math.round(y) }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] }] })
      },
      async keys(text) {
        const actions = []
        for (const ch of text) actions.push({ type: 'keyDown', value: ch }, { type: 'keyUp', value: ch })
        await send('input.performActions', { context, actions: [{ type: 'key', id: 'keyboard', actions }] })
      },
      async type(selector, text) {
        await page.click(selector)
        await page.js(`const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.select?.()`)
        if (await page.js(`return (document.activeElement?.value ?? '') !== ''`)) await page.keys(KEYS.Backspace)
        await page.keys(text)
      },
      async key(key) { await page.keys(KEYS[key] ?? key) },
      async attach() { throw new Error('bidi.mjs chooses no files') },
      async shot(file) {
        const to = path.join(seen.shots ?? OUT, `${file}.png`)
        fs.mkdirSync(path.dirname(to), { recursive: true })
        const { data } = await send('browsingContext.captureScreenshot', { context })
        fs.writeFileSync(to, Buffer.from(data, 'base64'))
        return to
      },
      close: () => send('browsingContext.close', { context }).catch(() => {}),
      violations: () => page.js('return window.__csp ?? []').catch(() => []),
    }
    return page
  }

  const first = (await send('browsingContext.getTree')).contexts.at(-1).context
  await send('browsingContext.setViewport', { context: first, viewport: { width, height } }).catch(() => {})
  const version = await send('script.evaluate', { expression: 'navigator.userAgent', target: { context: first }, awaitPromise: false }).then(r => /Firefox\/(\S+)/.exec(r.result?.value ?? '')?.[1] ?? null, () => null)
  let tabs = 0
  return {
    name, engine: 'firefox', version, page: driver(first, name),
    async tab(url = 'about:blank') {
      const { context } = await send('browsingContext.create', { type: 'tab', referenceContext: first })
      await send('browsingContext.setViewport', { context, viewport: { width, height } }).catch(() => {})
      const d = driver(context, `${name} tab ${++tabs + 1}`)
      if (url !== 'about:blank') await d.go(url)
      return d
    },
    /** What a page stored lies in the profile's private storage and nowhere else: the window IS private. */
    isPrivate() {
      const list = d => { try { return fs.readdirSync(path.join(dir, 'storage', d)) } catch { return [] } }
      return list('private').length > 0 && list('default').filter(n => /^https?\+/.test(n)).length === 0
    },
    async close() { try { ws.close() } catch {} await end() },
  }
}
