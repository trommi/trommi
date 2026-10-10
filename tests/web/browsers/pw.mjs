// pw.mjs: one browser engine of Playwright (firefox, webkit or chromium), driven with the same page interface as
// tests/web/e2e/harness.mjs gives for Chromium over the DevTools protocol, so tests/web/e2e/ui.mjs works on it as it is.
//
// PLAYWRIGHT is not a package of this repository. It is found in the folder TROMMI_PLAYWRIGHT names (a folder with
// node_modules/playwright in it), or where Node finds `playwright` by itself; its browsers where
// PLAYWRIGHT_BROWSERS_PATH says (Playwright's own variable).
//     mkdir pw && cd pw && npm init -y && npm i playwright
//     PLAYWRIGHT_BROWSERS_PATH=$PWD/browsers npx playwright install firefox webkit chromium
//
// A PROFILE (`openProfile`) is one browser process with a profile folder of its own (launchPersistentContext): its
// own IndexedDB, Web Locks and tabs, kept on disk as a person's browser keeps them. `private: true` opens what the
// engine has for a private window instead:
//     firefox    a real private window, opened and driven by bidi.mjs (Playwright's Firefox has none; see there)
//     webkit     a context that is not persistent: an ephemeral session, which is what a private window is there
//     chromium   a context that is not persistent: an off-the-record profile, which is what incognito is there
//
// WHAT IS SEEN of a page (`watch`): uncaught errors, console errors and warnings (the page's and its workers'),
// Content-Security-Policy violations (the page's own event, and console lines that name the policy), failed
// requests, and with `requests` every request. Playwright reports no uncaught error INSIDE a worker for Firefox and
// WebKit: a worker that dies there is seen only by what the page does next.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

export const ENGINES = ['firefox', 'webkit', 'chromium']
/** Everything a run writes: profile folders, builds, the local hub's data. */
export const TMP = process.env.TROMMI_BROWSERS_TMP || path.join(os.homedir(), '.cache/trommi-work/v2/browsers-tmp')
/** Screenshots and reports. */
export const OUT = process.env.TROMMI_BROWSERS_OUT || path.join(os.homedir(), '.cache/trommi-work/v2/browsers-out')

export const sleep = ms => new Promise(r => setTimeout(r, ms))
export const cannot = message => Object.assign(new Error(message), { cannot: true })

let playwright = null
/** The Playwright package; throws `cannot` with what to do when it is not there. */
export function loadPlaywright() {
  if (playwright) return playwright
  const from = process.env.TROMMI_PLAYWRIGHT ? path.join(path.resolve(process.env.TROMMI_PLAYWRIGHT), 'package.json') : import.meta.url
  try { playwright = createRequire(from)('playwright') } catch (err) {
    throw cannot(`Playwright is missing (${err.code ?? err.message}): set TROMMI_PLAYWRIGHT to a folder with node_modules/playwright (see tests/web/browsers/pw.mjs)`)
  }
  return playwright
}

export function watch({ requests = false } = {}) {
  return { exceptions: [], csp: [], errors: [], warnings: [], network: [], requests: requests ? [] : null, shots: null }
}
const isCsp = text => /Content[ -]Security[ -]Policy/i.test(text)
const INIT = "window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective+' '+(e.blockedURI||e.sample||'')))"

function listen(seen, who, page) {
  const line = (type, text, by) => {
    if (type !== 'warning' && type !== 'error') return
    ;(isCsp(text) ? seen.csp : type === 'error' ? seen.errors : seen.warnings).push(`${by}: ${text}`)
  }
  page.on('pageerror', err => seen.exceptions.push(`${who}: ${err?.stack?.split('\n')[0] ?? err?.message ?? String(err)}`))
  page.on('console', m => line(m.type(), m.text(), who))
  page.on('worker', w => { try { w.on('console', m => line(m.type(), m.text(), `${who} worker`)) } catch {} })
  page.on('requestfailed', r => seen.network.push(`${who}: ${r.method()} ${r.url()} ${r.failure()?.errorText ?? 'failed'}`))
  if (seen.requests) {
    const byRequest = new Map()
    page.on('request', r => { const rec = { who, url: r.url(), method: r.method(), status: null, failed: null, at: Date.now(), ended: null }; byRequest.set(r, rec); seen.requests.push(rec) })
    page.on('response', r => { const rec = byRequest.get(r.request()); if (rec) rec.status = r.status() })
    page.on('requestfinished', r => { const rec = byRequest.get(r); if (rec) rec.ended = Date.now() })
    page.on('requestfailed', r => { const rec = byRequest.get(r); if (rec) { rec.ended = Date.now(); rec.failed = r.failure()?.errorText ?? 'failed' } })
  }
}

/** A page of a profile, driven as a person would (the interface of harness.mjs `driver`). */
function driver(pw, name, seen, engine) {
  listen(seen, name, pw)
  const page = {
    name, pw,
    /** Runs `code` (the body of an async function) in the page and returns its value. */
    async js(code) {
      // (a page whose process is wedged never answers, not even a screenshot: after 60 s that is said, instead of
      // the step waiting until the run's own timeout)
      let timer
      const wedged = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the page did not answer within 60 s (its process is wedged)')), 60000) })
      try { return await Promise.race([pw.evaluate(`(async () => { ${code} })()`), wedged]) } catch (err) {
        throw new Error(`${name}: ${String(err.message).split('\n')[0]}\n    in: ${code.trim().slice(0, 200)}`)
      } finally { clearTimeout(timer) }
    },
    /** Waits until the expression `code` is truthy in the page; returns the milliseconds it took. */
    async until(code, what, ms = 15000) {
      const t = Date.now()
      while (Date.now() - t < ms) { if (await page.js(`return Boolean(${code})`).catch(() => false)) return Date.now() - t; await sleep(40) }
      await page.shot(`timeout-${name}-${what.replace(/[^\w]+/g, '-').slice(0, 50)}`).catch(() => {})
      throw new Error(`${name}: timed out waiting for ${what}`)
    },
    async go(url) { await pw.goto(url, { waitUntil: 'load', timeout: 30000 }).catch(err => { if (!/Timeout/.test(err.message)) throw err }) },
    async reload() { await pw.reload({ waitUntil: 'load', timeout: 30000 }).catch(err => { if (!/Timeout/.test(err.message)) throw err }) },
    /** Where the middle of the element is, scrolled into view; fails when it is not there, has no box, or lies under
     *  something that is not its own (a person could not press it). */
    async point(selector, waitedFor = 0) {
      const at = await page.js(`const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return { no: 'not in the page' }
        el.scrollIntoView({ block: 'center', inline: 'center' })
        await new Promise(r => requestAnimationFrame(() => r()))
        const r = el.getBoundingClientRect()
        if (!r.width || !r.height) return { no: 'it has no box (hidden)' }
        const x = r.left + r.width / 2, y = r.top + r.height / 2, hit = document.elementFromPoint(x, y)
        const own = hit && (el.contains(hit) || hit.contains(el) || (el.labels && [...el.labels].some(l => l.contains(hit))))
        return own ? { x, y } : { no: 'it lies under ' + (hit ? hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') + (hit.className && typeof hit.className === 'string' ? '.' + hit.className.split(' ').join('.') : '') : 'nothing') }`)
      if (!at.no) return at
      // An element that is in the page but not laid out or still covered: a person waits a moment for it, and so
      // does this (up to 3 s, counted in `seen.waited`); the Chromium harness presses at once and is never early.
      if (waitedFor < 3000) {
        await sleep(100)
        const got = await page.point(selector, waitedFor + 100)
        if (!waitedFor) (seen.waited ??= []).push(`${name}: ${selector} (${at.no})`)
        return got
      }
      throw new Error(`${name}: cannot press ${selector}: ${at.no}`)
    },
    /** A click with the mouse on the element's middle. */
    async click(selector) {
      const { x, y } = await page.point(selector)
      await pw.mouse.move(x, y)
      await pw.mouse.down()
      await pw.mouse.up()
    },
    /** Clicks into the field, replaces what it holds, and types `text` as a keyboard inserts it. */
    async type(selector, text) {
      await page.click(selector)
      await page.js(`const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.select?.()`)
      if (await page.js(`return (document.activeElement?.value ?? '') !== ''`)) await pw.keyboard.press('Backspace')
      await pw.keyboard.insertText(text)
    },
    /** (`code` is the DevTools protocol's and not needed here; of its `modifiers`, 2 is Control) */
    async key(key, _code, modifiers = 0) { await pw.keyboard.press(`${modifiers & 2 ? 'Control+' : ''}${modifiers & 8 ? 'Shift+' : ''}${key}`) },
    /** The mouse by the DevTools protocol's names, as tests/web/e2e/real.mjs draws a stroke with it. */
    async mouse(type, x, y) {
      if (type === 'mouseMoved') await pw.mouse.move(x, y)
      else if (type === 'mousePressed') { await pw.mouse.move(x, y); await pw.mouse.down() }
      else if (type === 'mouseReleased') { await pw.mouse.move(x, y); await pw.mouse.up() }
    },
    /** The one DevTools call the shared steps make themselves: text inserted as a keyboard inserts it. */
    session: { async send(method, params) { if (method !== 'Input.insertText') throw new Error(`pw.mjs has no ${method}`); await pw.keyboard.insertText(params.text) } },
    async attach(selector, files) { await pw.setInputFiles(selector, files) },
    /** A screenshot into `seen.shots` (or OUT) as `<file>.png`; returns its path. */
    async shot(file, { full = false } = {}) {
      const dir = seen.shots ?? OUT
      fs.mkdirSync(dir, { recursive: true })
      const to = path.join(dir, `${file}.png`)
      // Playwright's screenshot puts a <style> of its own into the page; WebKit holds that one against the page's
      // policy (style-src) and reports a violation the app never made. Those, and only those, are taken out again.
      const before = { page: await page.js('return (window.__csp ?? []).length').catch(() => 0), seen: seen.csp.length }
      await pw.screenshot({ path: to, fullPage: full, timeout: 20000 })
      if (engine === 'webkit') {
        await sleep(150)
        await page.js(`if (window.__csp) window.__csp = window.__csp.filter((v, i) => i < ${before.page} || !/^style-src(-elem)? inline/.test(v))`).catch(() => {})
        seen.csp = seen.csp.filter((v, i) => i < before.seen || !/Refused to apply a stylesheet/.test(v))
      }
      return to
    },
    close: () => pw.close().catch(() => {}),
    /** The policy violations the page's own event saw on the page as it stands. */
    violations: () => page.js('return window.__csp ?? []').catch(() => []),
  }
  return page
}

/** A browser profile: `page` (its first tab), `tab()` for another tab of the same profile, `close()`. */
export async function openProfile(engine, name, seen, { width = 1440, height = 900, private: priv = false, phone = false } = {}) {
  const type = loadPlaywright()[engine]
  if (!type) throw cannot(`no such engine: ${engine} (one of ${ENGINES.join(', ')})`)
  if (priv && engine === 'firefox') return (await import('./bidi.mjs')).openFirefoxPrivate(name, seen, { width, height })
  fs.mkdirSync(path.join(TMP, 'profiles'), { recursive: true })
  const dir = fs.mkdtempSync(path.join(TMP, 'profiles', `${engine}-${name.replace(/[^\w]+/g, '-')}-`))
  // (a phone's width: the layout's own breakpoints decide; `hasTouch` and `isMobile` are not all engines')
  // (TROMMI_BROWSERS_NO_SW=1, run.mjs --no-sw: the app's service worker is blocked, to tell its effects apart)
  const view = { viewport: { width, height }, ...(process.env.TROMMI_BROWSERS_NO_SW === '1' ? { serviceWorkers: 'block' } : {}), ...(phone && engine !== 'firefox' ? { hasTouch: true } : {}) }
  let browser = null, context
  try {
    if (priv) { browser = await type.launch(); context = await browser.newContext(view) }
    else context = await type.launchPersistentContext(dir, view)
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw cannot(`${engine} did not start: ${String(err.message).split('\n').filter(l => l.trim()).slice(0, 12).join(' | ').slice(0, 900)}`)
  }
  await context.addInitScript(INIT)
  const first = context.pages()[0] ?? await context.newPage()
  const page = driver(first, name, seen, engine)
  let tabs = 0
  return {
    name, page, context, engine,
    version: (browser ?? context.browser())?.version() ?? null,
    async tab(url = 'about:blank') {
      const d = driver(await context.newPage(), `${name} tab ${++tabs + 1}`, seen, engine)
      if (url !== 'about:blank') await d.go(url)
      return d
    },
    async close() {
      await context.close().catch(() => {})
      await browser?.close().catch(() => {})
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** What a list of lines holds, each kind once with its count. */
export function counted(list, width = 260) {
  const n = new Map()
  for (const line of list) { const k = line.replace(/\d{4,}/g, 'N').split('\n')[0].slice(0, width); n.set(k, (n.get(k) ?? 0) + 1) }
  return [...n].map(([line, count]) => count > 1 ? `×${count}: ${line}` : line)
}
