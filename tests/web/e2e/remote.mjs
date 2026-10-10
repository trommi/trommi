// remote.mjs: the real-hub run against an app and a hub that are ALREADY DEPLOYED, instead of the local build and the
// local hub binary.   node tests/web/e2e/run.mjs real --app <app URL> --hub <hub URL> [--shots <folder>]
// It builds nothing and starts nothing: it only drives headless Chromium against `--app`. What it does there, as a
// person would: sign up → the Emergency Kit → the empty Desk → reload (still signed in, connection live) → the MLS
// proof page → log out → log in again with the password → a SECOND browser profile logs in (which joins with the
// recovery code, spec 8.4) → Settings shows the devices.
//
// It makes a real account on the hub it is pointed at. So, built in and not to be switched off:
// - the address is `e2e-<16 random hex>@example.invalid` (a name that can never receive mail), nothing else;
// - the password is random (32 characters), held in this process only, never printed and never written anywhere;
//   the Emergency Kit's words likewise;
// - ONE account per run (the limit is two; nothing here makes a second);
// - when the hub says `rate-limited` (status 429) the run waits the `retry_after` it names, once, and tries that step
//   once more; a second refusal ends the run with that as its result. Nothing is ever asked in a loop;
// - `--app` and `--hub` must both be local (127.0.0.1, localhost) or both be remote: a mixed pair is refused.
// The app is told its hub with its developer override `?hub=` unless `--hub` is the one it is built for
// (https://hub.trommi.com); a hub the app's Content-Security-Policy does not name cannot be reached from the page,
// and the run will say so (a policy violation on the first request).
//
// Every step prints ok or FAIL with what the page showed (the screen's visible text, its error line), and at the
// end what would explain a failure that only production has: Content-Security-Policy violations (page and worker),
// requests that failed or were blocked (status, the browser's reason, a CORS error), whether the live stream
// (/v2/stream) opened and stayed open for 20 s and how soon its first bytes came (a buffering proxy holds them
// back), the service worker's state, storage errors. The tested build (`<app>/gen/build.txt`) is printed first.
import crypto from 'node:crypto'
import path from 'node:path'
import { openProfile, run, sleep, watch } from './harness.mjs'
import * as ui from './ui.mjs'

const BUILT_FOR = 'https://hub.trommi.com'
const isLocal = url => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)
const STREAM_OPEN_MS = 20_000
const RETRY_AFTER_MAX_S = 300

/** What the page shows: its visible text (shortened) and its error lines. Never a field's value. */
const screen = page => page.js(`const text = document.body.innerText.replace(/\\s*\\n\\s*/g, ' | ').slice(0, 260)
  const errors = [...document.querySelectorAll('.ob-error, .room-error, [role=alert]')].map(e => e.innerText.trim()).filter(Boolean)
  return { at: location.pathname, text, errors }`).catch(e => ({ at: '?', text: `(the page could not be read: ${e.message.split('\n')[0]})`, errors: [] }))

export async function runRemote({ app, hub, shots = null }) {
  for (const [name, url] of [['--app', app], ['--hub', hub]]) { try { if (!/^https?:$/.test(new URL(url).protocol)) throw 0 } catch { console.error(`remote: ${name} is no http(s) address`); return 2 } }
  app = new URL(app).origin; hub = new URL(hub).origin
  if (isLocal(app) !== isLocal(hub)) { console.error('remote: refused: --app and --hub must both be local (127.0.0.1, localhost) or both remote'); return 2 }

  const build = await fetch(`${app}/gen/build.txt`).then(async r => (r.ok ? (await r.text()).trim().replace(/\n/g, ' · ') : `no gen/build.txt (status ${r.status})`), e => `gen/build.txt could not be read (${e.cause?.code ?? e.message})`)
  console.log(`app: ${app}\nhub: ${hub}\nbuild: ${build}`)

  const seen = watch({ requests: true })
  if (shots) seen.shots = path.resolve(shots)
  const r = run('deployed app + deployed hub')
  const start = hub === BUILT_FOR ? `${app}/` : `${app}/?hub=${encodeURIComponent(hub)}`
  // the secrets of this run: in memory only
  const email = `e2e-${crypto.randomBytes(8).toString('hex')}@example.invalid`
  const password = crypto.randomBytes(24).toString('base64url')
  let words = null
  const profiles = {}
  const profile = async name => (profiles[name] ??= await openProfile(name, seen)).page
  let stopped = null, waited = false, n = 0
  const limited = from => seen.requests.slice(from).filter(q => q.status === 429)

  /** One step: its line, what the page showed, a screenshot; `rate-limited` is waited for once in the whole run. */
  async function step(name, who, fn) {
    if (stopped) return r.step(name, () => { throw Object.assign(new Error(stopped), { skip: true }) })
    const from = seen.requests.length
    const once = () => r.step(name, async () => {
      try { await fn() } finally {
        const page = profiles[who]?.page
        const hit = limited(from)
        if (hit.length) r.note(`the hub answered rate-limited (429) ${hit.length} time(s) in this step, ${(w => (w ? `Retry-After ${w} s` : 'no Retry-After header'))(Math.max(...hit.map(q => q.retry_after ?? 0)))}: ${[...new Set(hit.map(q => `${q.method} ${new URL(q.url).pathname.replace(/[A-Za-z0-9_-]{20,}/g, '…')}`))].join(', ')} (the app waits and asks again by itself; this run asks nothing of its own)`)
        if (page) { const s = await screen(page); r.note(`the page (${s.at}) shows: ${s.text}${s.errors.length ? ` · error line: ${s.errors.join(' / ')}` : ''}`); await page.shot(`remote-${String(++n).padStart(2, '0')}-${who}`).catch(() => {}) }
      }
    })
    if (await once()) return true
    const hit = limited(from)
    if (!hit.length) return false
    const wait = Math.max(...hit.map(q => q.retry_after ?? 0))
    if (waited || !(wait > 0) || wait > RETRY_AFTER_MAX_S) { stopped = `stopped: the hub said rate-limited (retry_after ${wait || 'not named'} s)${waited ? ' a second time' : ''}`; r.say(`        ${stopped}`); return false }
    waited = true
    r.say(`        the hub said rate-limited: waiting ${wait} s, once, then this step once more`)
    await sleep(wait * 1000 + 1000)
    const again = await once()
    if (!again && limited(from).length > hit.length) stopped = 'stopped: the hub said rate-limited again after the wait'
    return again
  }

  try {
    let kitStuck = false, proved = false
    const proof = () => step('the MLS proof page (Settings → MLS proof) says OK', 'A', async () => {
      proved = true
      const A = await profile('A')
      await ui.openSettingsPage(A, 'proof')
      const line = "document.querySelector('main')?.innerText.trim().split('\\n').find(l => /^(OK|FAIL)/.test(l))"
      await A.until(line, 'the proof\'s result', 90000)
      const first = await A.js(`return ${line}`)
      r.check(first.startsWith('OK'), 'its first line says OK', first)
    })
    const made = await step('sign up (e-mail + a random password) → the Emergency Kit with its twelve words → the room live', 'A', async () => {
      const A = await profile('A')
      await A.go(start)
      await A.until("document.querySelector('#way-create')", 'the welcome screen', 30000)
      await A.click('#way-create')
      await A.until("document.querySelector('#create-form')", 'the create account screen')
      await A.type('#create-form input[name=email]', email)
      await A.type('#create-form input[name=password]', password)
      await A.click('#create-form button[type=submit]')
      await A.until("document.querySelector('#kit-gate[open] #kit-done') || document.querySelector('#ob-error')?.textContent.trim()", 'the Emergency Kit screen, or a refusal', 90000)
      if (!await A.js("return !!document.querySelector('#kit-gate #kit-done')")) throw new Error('the account was not made (the error line is below)')
      words = await ui.readKit(A)
      r.check(words.split(' ').length === 12, 'twelve words were shown')
      // (the kit's words are on screen now: no screenshot of this step shows them, the kit is hidden again first)
      await A.click('#kit-show')
      await ui.live(A, 'the room live', 60000)
    })
    if (!made && !stopped) stopped = 'not run: no account was made'
    await step('"Open Trommi" closes the Emergency Kit screen: the empty Desk', 'A', async () => {
      const A = await profile('A')
      try { await ui.leaveKit(A) } catch (err) { kitStuck = true; throw err }
      r.check(await A.js("return !!document.querySelector('#inbox') && !document.querySelector('.inbox-row')"), 'the empty Desk')
    })
    await step('reload: still signed in (the device from IndexedDB), the connection live again', 'A', async () => {
      const A = await profile('A')
      const device = await A.js('return trommi.client.model.room.my_device_id')
      await A.reload()
      await ui.live(A, 'live after the reload', 60000)
      r.check(await A.js('return trommi.client.model.room.my_device_id') === device, 'the same device')
    })
    // (behind a kit screen that does not close nothing can be pressed: the proof page then comes after the log in)
    if (!kitStuck) await proof()
    await step(`log out (${kitStuck ? 'by the kit screen\'s own "Log out": it did not close' : 'Settings → Account → Log Out'}), then log in again with the password`, 'A', async () => {
      const A = await profile('A')
      if (kitStuck) await ui.logOutFromKit(A); else await ui.logOut(A)
      r.note(`after logging out the screen says: "${await A.js("return document.getElementById('logged-out')?.textContent ?? ''")}"`)
      await ui.logIn(A, start, email, password)
      await A.until(`(${ui.LIVE}) || document.querySelector('#ob-error')?.textContent.trim()`, 'the Desk, or a refusal', 90000)
      if (!await A.js(`return Boolean(${ui.LIVE})`)) throw new Error('the login was refused (the error line is below)')
      await sleep(1000)
      r.check(await A.js("return !document.querySelector('#kit-gate')"), 'no kit screen over the Desk after the log in')
    })
    if (!proved) await proof()
    await step('a second browser profile logs in with the password (joins with the recovery code, 8.4); Settings shows the devices', 'B', async () => {
      const A = await profile('A'), B = await profile('B')
      await ui.logIn(B, start, email, password)
      await B.until(`(${ui.LIVE}) || document.querySelector('#ob-error')?.textContent.trim()`, 'the Desk, or a refusal', 90000)
      if (!await B.js(`return Boolean(${ui.LIVE})`)) throw new Error('the login was refused (the error line is below)')
      for (const P of [A, B]) {
        await ui.openSettingsPage(P, 'devices')
        await P.until("document.querySelectorAll('.room-device').length >= 2", `at least two devices listed on ${P.name}`, 40000).catch(() => {})
        const listed = await P.js("return document.querySelectorAll('.room-device').length")
        // (logging out removes no device under protocol v2: the first profile's device of before the log out is still
        // listed, so three rows are expected here: that one, the first profile's new device, the second profile's)
        r.check(listed >= 2, `${P.name} lists the devices`, listed)
        r.note(`${P.name} lists ${listed} devices`)
      }
    })
    await step('the live stream (/v2/stream) opened and stays open for 20 s', 'B', async () => {
      const streams = () => seen.requests.filter(q => new URL(q.url).pathname === '/v2/stream' && q.status === 200 && q.ended === null && q.failed === null)
      if (!streams().length) throw new Error(`no open stream (requests to /v2/stream: ${seen.requests.filter(q => q.url.includes('/v2/stream')).map(q => `${q.status ?? 'no answer'}${q.failed ? ` ${q.failed}` : ''}${q.ended ? ' ended' : ''}`).join(', ') || 'none'})`)
      const watched = streams()
      const wait = Math.max(0, STREAM_OPEN_MS - (Date.now() - Math.max(...watched.map(q => q.at))))
      await sleep(wait)
      const still = watched.filter(q => q.ended === null && q.failed === null)
      r.check(still.length === watched.length, `every open stream stayed open for ${STREAM_OPEN_MS / 1000} s`, watched.map(q => ({ who: q.who, open_ms: (q.ended ?? Date.now()) - q.at, failed: q.failed })))
      for (const q of watched) r.note(`${q.who}: stream open ${Math.round(((q.ended ?? Date.now()) - q.at) / 1000)} s, first bytes ${q.first_data === null ? 'NOT received (a proxy that buffers holds them back)' : `after ${q.first_data - q.at} ms`}`)
    })
    await step('what a failure only production has would show', 'B', async () => {
      for (const name of Object.keys(profiles)) {
        const P = profiles[name].page
        const state = await P.js(`const reg = await navigator.serviceWorker?.getRegistration('/').catch(() => null)
          const est = await navigator.storage?.estimate?.().catch(() => null)
          return { controller: navigator.serviceWorker?.controller?.state ?? 'none', registered: reg ? (reg.active ? 'active' : reg.installing ? 'installing' : reg.waiting ? 'waiting' : 'registered') : 'none', storage: est ? Math.round(est.usage / 1024) + ' KiB of ' + Math.round(est.quota / 1048576) + ' MiB' : 'unknown', persisted: await navigator.storage?.persisted?.().catch(() => null), violations: window.__csp ?? [] }`).catch(e => ({ error: e.message.split('\n')[0] }))
        r.note(`${name}: service worker controller ${state.controller}, registration ${state.registered}; storage ${state.storage}, persisted ${state.persisted}`)
        r.check(!state.violations?.length, `${name}: no policy violation on its page`, state.violations)
      }
      r.check(!seen.csp.length, 'no Content-Security-Policy violation (page and worker)', seen.csp)
      r.check(!seen.exceptions.length, 'no uncaught error (page and worker)', seen.exceptions)
      const storage = [...seen.errors, ...seen.warnings].filter(l => /indexeddb|quota|storage|StoreConflict/i.test(l))
      r.check(!storage.length, 'no storage error', storage)
      const bad = seen.requests.filter(q => q.failed || q.status >= 400)
      const counted = new Map()
      for (const q of bad) { const u = new URL(q.url); const k = `${q.who}: ${q.method} ${u.origin === app ? '' : u.origin}${u.pathname.replace(/[A-Za-z0-9_-]{20,}/g, '…')} → ${q.failed ? `${q.failed}${q.blocked ? ` (blocked: ${q.blocked})` : ''}${q.cors ? ` (CORS: ${q.cors})` : ''}` : q.status}`; counted.set(k, (counted.get(k) ?? 0) + 1) }
      for (const [line, c] of counted) r.note(`request${c > 1 ? ` ×${c}` : ''}: ${line}`)
      r.check(!bad.some(q => q.cors || q.blocked), 'no request was blocked (CORS, the policy, mixed content)', bad.filter(q => q.cors || q.blocked).map(q => `${q.url.split('?')[0]} ${q.blocked ?? q.cors}`))
      for (const [kind, list] of [['console error', seen.errors], ['console warning', seen.warnings]]) {
        const lines = new Map()
        for (const line of list) { const k = line.split('\n')[0].slice(0, 220); lines.set(k, (lines.get(k) ?? 0) + 1) }
        for (const [line, c] of lines) r.note(`${kind}${c > 1 ? ` ×${c}` : ''}: ${line}`)
      }
    })
  } finally {
    for (const p of Object.values(profiles)) await p.close().catch(() => {})
  }
  r.say(`account made on ${hub}: 1 (e2e-…@example.invalid; it stays there: nothing in the app deletes an account)`)
  return r.finish() ? 1 : 0
}
