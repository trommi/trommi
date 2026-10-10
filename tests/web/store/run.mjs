// run.mjs: the tests of the web app's storage (app/web/core/store-idb.ts over the binding's IdbStore) and of one owner
// per browser profile (app/web/core/tabs.ts). They need IndexedDB, Web Locks, BroadcastChannel and WebCrypto, so they
// run in headless Chromium: this file bundles the test page (page.ts) with esbuild, serves it and the core's WASM
// build from 127.0.0.1, drives Chromium over the DevTools protocol (app/web/dev/cdp.mjs) and prints one line per test.
//
//   node tests/web/store/run.mjs      exit 0: all ran and passed · 1: a test failed · 2: it could not run
//
// It needs:
// - Chromium: `chromium` on the PATH or the program CHROMIUM names (as app/web/dev/e2e.mjs finds it).
// - esbuild: the web app's devDependency (`npm ci` in app/web).
// - The core's WASM build: core/wasm/pkg/, or the folder TROMMI_CORE_PKG names. `core/wasm/build.sh` makes it.
// The bundle and the browser's profile are written under TROMMI_TEST_TMP (default: `trommi-store-test` in the
// system's temporary folder) and removed at the end.
//
// What is real and what is not: the browser's storage, locks, channel and cryptography, the binding's IdbStore and,
// in the tests named "core:" and "tabs (real core):", the Rust core's Device. The CLIENT in the tabs is a fake
// (fake-client.ts): no engine, no hub.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEsbuild } from '../../../app/web/dev/build.mjs'
import { launchChromium } from '../../../app/web/dev/cdp.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, '../../..')
const tmp = process.env.TROMMI_TEST_TMP || path.join(os.tmpdir(), 'trommi-store-test')
const pkg = process.env.TROMMI_CORE_PKG || path.join(repo, 'core/wasm/pkg')
const out = path.join(tmp, 'page'), profile = path.join(tmp, 'profile')
const sleep = ms => new Promise(r => setTimeout(r, ms))

function cannotRun(why) { console.error(`store tests did NOT run: ${why}`); process.exit(2) }

const chromium = process.env.CHROMIUM || 'chromium'
if (spawnSync(chromium, ['--version'], { stdio: 'ignore' }).error) cannotRun(`Chromium is missing ('${chromium}' does not start; install it or name it in CHROMIUM)`)
let esbuild
try { esbuild = await loadEsbuild() } catch { cannotRun('esbuild is missing (npm ci in app/web)') }
const PKG_FILES = { 'trommi-core.js': 'text/javascript', 'idb-store.js': 'text/javascript', 'trommi_core_wasm.js': 'text/javascript', 'trommi_core_wasm_bg.wasm': 'application/wasm' }
for (const file of Object.keys(PKG_FILES)) if (!fs.existsSync(path.join(pkg, file))) cannotRun(`the core's WASM build is missing or old (${path.join(pkg, file)}): run core/wasm/build.sh, or name a built folder in TROMMI_CORE_PKG`)

// ---- the page: one bundle and one html from the temp folder, the binding's files as they are -------------------------
fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })
await esbuild.build({ entryPoints: [path.join(here, 'page.ts')], bundle: true, format: 'esm', target: 'es2022', outfile: path.join(out, 'page.js'), sourcemap: 'inline', logLevel: 'warning' })
fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><title>store tests</title><script type="module" src="/page.js"></script>\n')
const serve = (req, res) => {
  const name = new URL(req.url, 'http://x').pathname
  const fromPkg = name.startsWith('/pkg/') ? name.slice(5) : null
  if (fromPkg !== null && !(fromPkg in PKG_FILES)) { res.writeHead(404); res.end(); return }
  const file = fromPkg !== null ? path.join(pkg, fromPkg) : path.join(out, name === '/page.js' ? 'page.js' : 'index.html')
  res.writeHead(200, { 'Content-Type': fromPkg !== null ? PKG_FILES[fromPkg] : name === '/page.js' ? 'text/javascript' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(fs.readFileSync(file))
}
/** The page under an origin of its own. */
async function origin() {
  const server = http.createServer(serve)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${server.address().port}` }
}
const main = await origin()
// A second origin for the quota test alone: Chromium remembers an origin's free space for a while, so the small
// quota must be set before the origin's first write, and must not be what the other tests then write under.
const small = await origin()

// ---- the browser ------------------------------------------------------------------------------------------------------
// (background tabs must keep their timers: a follower's retry and a takeover happen in tabs nobody looks at)
const browser = await launchChromium({ keep: profile, args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] })
  .catch(e => cannotRun(e.message))

const problems = []
/** A tab on the test page: step(name, ...args) runs T[name] of page.ts in it and gives the value back. */
async function openTab(label, at = main.url) {
  const t = await browser.tab(at + '/')
  const s = t.session
  s.on('Runtime.exceptionThrown', e => problems.push(`${label}: ${e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text}`))
  await s.send('Runtime.enable')
  const js = async (code, ms = 60_000) => {
    // (a step that never answers must not hang the run: every test in the page has its own, shorter deadline)
    let timer
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: no answer after ${ms / 1000} s to: ${code.slice(0, 80)}`)), ms) })
    const r = await Promise.race([s.send('Runtime.evaluate', { expression: `(async () => { ${code} })()`, awaitPromise: true, returnByValue: true }), late]).finally(() => clearTimeout(timer))
    if (r.exceptionDetails) throw new Error(`${label}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
    return r.result.value
  }
  for (let i = 0, why = ''; ; i++) {
    if (await js('return typeof globalThis.T === "object"').catch(e => { why = e.message; return false })) break
    if (i > 800) throw new Error(`${label}: the test page did not load ${[why, ...problems].filter(Boolean).join(' · ')}`)
    await sleep(25)
  }
  const step = (name, ...args) => js(`return globalThis.T.${name}(...${JSON.stringify(args)})`, name === 'single' ? 900_000 : 60_000)
  return { session: s, step, close: t.close }
}
async function until(cond, what, ms = 15000) {
  const t = Date.now()
  for (;;) {
    const got = await cond()
    if (got) return got
    if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`)
    await sleep(40)
  }
}
const same = (got, want, what) => { const g = JSON.stringify(got), w = JSON.stringify(want); if (g !== w) throw new Error(`${what}: got ${g}, expected ${w}`) }

let failed = 0, passed = 0
function report(ok, name, detail = '') {
  if (ok) passed++; else failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `\n       ${detail}` : ''}`)
}
/** A test driven from here; a `note` it returns is printed beside its name. */
async function test(name, run) {
  try { const note = await run(); report(true, name + (note ? ` (${note})` : '')) } catch (e) { report(false, name, String(e?.message ?? e)) }
}
const stamp = Date.now().toString(36)

try {
  // ---- everything one page can show ----
  const page = await openTab('page')
  const versions = await page.step('versions')
  for (const r of await page.step('single')) report(r.ok, r.name, r.detail)

  await test('store: a write over the origin\'s quota (a real QuotaExceededError) is refused whole; a new store gives the last good state and goes on', async () => {
    const name = `q-${stamp}`
    const tab = await openTab('quota page', small.url)
    await tab.session.send('Storage.overrideQuotaForOrigin', { origin: small.url, quotaSize: 3 * 1024 * 1024 })
    await tab.step('quotaBefore', name)
    const r = await tab.step('quotaWrite', 24)
    if (r.name !== 'QuotaExceededError') throw new Error(`the write failed, but not for the quota: ${r.name}: ${r.message}`)
    same(await tab.step('quotaAfter', name), { revision: 1, entries: '01=the last good state', then: [2, '01=the last good state 04=on again'] }, 'after reopening')
    await tab.close()
    return r.name
  })

  await test('store: the page reloads in the middle of a write: after reopening the write is there whole or not at all', async () => {
    const entries = 120, size = 65536, whole = [], none = []
    // below zero: the page asks to leave from inside the transaction, when that many of its entries were put (the
    // browser may still commit it: whole is as right as nothing)
    for (const at of [-1, -2, -60, -120, -121, 0, 5, 14, 28, 50, 85, 150, 300, 500, 900, 1600]) {
      const name = `m-${stamp}-${at}`
      await page.step('midWriteSetup', name)
      const before = await page.step('born')
      await page.step('midWrite', name, at, entries, size).catch(() => {})   // (the page may be gone before it answers)
      await until(() => page.step('born').then(born => born !== before, () => false), 'the reloaded page')
      const r = await page.step('midWriteCheck', name, entries, size)
      const isWhole = r.revision === 2 && r.count === entries && r.base === 'replaced' && r.sizesOk
      const isNone = r.revision === 1 && r.count === 0 && r.base === 'base'
      if (!isWhole && !isNone) throw new Error(`a torn state after a reload at ${at}: ${JSON.stringify(r)}`)
      ;(isWhole ? whole : none).push(at)
      await page.step('drop', name)
    }
    if (!whole.length) throw new Error('no write was whole before its reload: the latest reload came too early to show a completed write surviving')
    return `nothing of it: reloads at ${none.join(', ')}; whole: at ${whole.join(', ')} ms`
  })
  await page.close()

  // ---- real tabs of one profile ----
  await test('tabs: two tabs: one owner; it closes: the follower takes over and loads the stored state; a call the old owner ran but never answered is refused as outcome-unknown and NOT run again', async () => {
    const name = `tabs-${stamp}`
    const a = await openTab('tab a'), b = await openTab('tab b')
    same([await a.step('tabOpen', name, 'fake', true), await b.step('tabOpen', name, 'fake', true)], ['leader', 'follower'], 'roles')
    same(await b.step('tabCall', 'seal', ['one']), 'ONE', 'a forwarded call')
    await a.step('tabCall', 'poke', ['only in memory'])
    await until(async () => (await b.step('tabState')).stack.length === 2, 'the patch at the follower')
    same((await b.step('tabState')).stack, ['one', 'only in memory'], 'the follower\'s copy')
    await b.step('callStart', 'hang', 'sealAndHang', ['two'])
    await until(async () => (await a.step('tabState')).revision === 2, 'the owner\'s durable write')
    same((await b.step('callState', 'hang')).done, false, 'the call is still waiting')
    await a.close()
    await until(async () => (await b.step('tabState')).role === 'leader', 'the takeover')
    const call = await until(async () => { const c = await b.step('callState', 'hang'); return c.done && c }, 'the waiting call\'s answer')
    same(call, { done: true, error: 'outcome-unknown' }, 'the call in flight')
    const s = await b.step('tabState')
    same([s.stack, s.revision, s.resets, s.ran], [['one', 'two'], 2, 1, {}], 'the new owner: the stored state, nothing run again')
    await b.close()
  })

  await test('tabs: the limit without receipts, shown: the same call runs a second time after the owner changed', async () => {
    const name = `twice-${stamp}`
    const a = await openTab('tab a'), b = await openTab('tab b')
    same([await a.step('tabOpen', name, 'fake', false), await b.step('tabOpen', name, 'fake', false)], ['leader', 'follower'], 'roles')
    await b.step('callStart', 'hang', 'sealAndHang', ['dup'])
    await until(async () => (await a.step('tabState')).revision === 1, 'the owner\'s durable write')
    await a.close()
    const s = await until(async () => { const x = await b.step('tabState'); return x.role === 'leader' && x.revision === 2 && x }, 'the second run')
    same([s.stack, s.ran], [['dup', 'dup'], { sealAndHang: 1 }], 'sealed twice')
    await b.close()
  })

  await test('tabs: three tabs: exactly one owner whenever a takeover has settled, also after two owners in a row closed', async () => {
    const name = `three-${stamp}`
    const tabs = [await openTab('tab 1'), await openTab('tab 2'), await openTab('tab 3')]
    const roles = await Promise.all(tabs.map(t => t.step('tabOpen', name, 'fake', true)))
    same(roles.filter(r => r === 'leader').length, 1, `roles ${roles}`)
    await tabs[roles.indexOf('follower')].step('tabCall', 'seal', ['kept'])
    let left = tabs.map((t, i) => ({ t, role: roles[i] }))
    for (let round = 0; round < 2; round++) {
      const owner = left.find(x => x.role === 'leader')
      await owner.t.close()
      left = left.filter(x => x !== owner)
      await until(async () => {
        for (const x of left) x.role = (await x.t.step('tabState')).role
        return left.filter(x => x.role === 'leader').length === 1
      }, `one new owner in round ${round + 1}`)
      await sleep(300)
      for (const x of left) x.role = (await x.t.step('tabState')).role
      same(left.filter(x => x.role === 'leader').length, 1, 'owners after the takeover settled')
      for (const x of left) same((await until(async () => { const s = await x.t.step('tabState'); return s.stack.length === 1 && s }, 'the model after the takeover')).stack, ['kept'], 'the stored state in every tab')
    }
    await left[0].t.close()
  })

  await test('tabs (real core): the owner creates a Device and founds a room, the follower mirrors it; the owner closes: the follower opens the SAME device and room from what is stored', async () => {
    const name = `real-${stamp}`
    const a = await openTab('tab a'), b = await openTab('tab b')
    same([await a.step('tabOpen', name, 'real', false), await b.step('tabOpen', name, 'real', false)], ['leader', 'follower'], 'roles')
    const room = await b.step('tabCall', 'foundRoom', [])   // (forwarded: it runs in the owner's Device)
    const owner = await a.step('tabState')
    if (!/^[0-9a-f]{64}$/.test(room) || owner.room !== room || !owner.stack.length) throw new Error(`the owner after founding: ${JSON.stringify(owner)}`)
    const copy = await until(async () => { const s = await b.step('tabState'); return s.room === room && s }, 'the follower\'s copy')
    same([copy.device, copy.stack], [owner.device, owner.stack], 'the follower\'s copy of device and outbox')
    await a.close()
    const next = await until(async () => { const s = await b.step('tabState'); return s.role === 'leader' && s }, 'the takeover')
    same([next.device, next.room, next.stack, next.errors], [owner.device, room, owner.stack, []], 'the device the new owner opened')
    await b.close()
    return `core ${versions.core}, binding ${versions.binding}`
  })
} catch (e) {
  report(false, 'the run itself', String(e?.stack ?? e))
} finally {
  await browser.close()
  main.server.close(); small.server.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}
for (const p of problems) { failed++; console.log(`FAIL an exception in a page: ${p}`) }
console.log(`${passed} passed, ${failed} failed (the client in the tabs is the fake of tests/web/store/fake-client.ts: no engine, no hub)`)
process.exit(failed ? 1 : 0)
