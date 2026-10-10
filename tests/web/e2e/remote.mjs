// remote.mjs: the real-hub run against an app and a hub that are ALREADY DEPLOYED, instead of the local build and the
// local hub binary.   node tests/web/e2e/run.mjs real --app <app URL> --hub <hub URL> [--shots <folder>]
// It builds nothing and starts nothing: it only drives headless Chromium against `--app`. What it does there, as a
// person would: sign up → the Emergency Kit → the empty Desk → reload (still signed in, connection live) → the MLS
// proof page → log out → log in again with the password → a SECOND browser profile JOINS BY LINK (the six check
// emoji compared between the two, "They match") → a note written on the first is seen on the second, an edit on the
// second is seen on the first → a small file attached to the note on the first is opened on the second, its bytes the
// same → a desk made on the first (a register) is in the second's menu → a THIRD profile logs in with the password
// (which joins with the recovery code, spec 8.4) → Settings shows the devices → the live stream stays open → on a
// SECOND account of its own: forgot password (the one field "Email or account ID", the Emergency Kit's twelve words,
// a new password) → a new kit → log in with the new password, the old one refused.
// tests/web/e2e/stack.mjs is a local stand for it (the build and the hub's binary on one origin).
//
// It makes real accounts on the hub it is pointed at. So, built in and not to be switched off:
// - each address is `e2e-<16 random hex>@example.invalid` (a name that can never receive mail), nothing else;
// - the passwords are random (32 characters), held in this process only, never printed and never written anywhere;
//   the Emergency Kits' words likewise (no screenshot is taken while they are shown);
// - TWO accounts per run at most: the first for everything but "forgot password", the second for that alone (a
//   recovery removes every other device of its account, 8.7: done on the first it would end the run's other steps);
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
// back), the service worker's state, storage errors. The tested build (`<app>/gen/build.txt`) is printed first, the
// number of requests made to the hub last.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { openProfile, run, sleep, TMP, watch } from './harness.mjs'
import { appendNote, arrives, foldNote, NOTE, noteIs, openNote, picture, sha256 } from './real.mjs'
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
  // the secrets of this run: in memory only. The second account is for "forgot password" alone.
  const address = () => `e2e-${crypto.randomBytes(8).toString('hex')}@example.invalid`
  const secret = () => crypto.randomBytes(24).toString('base64url')
  const email = address(), password = secret()
  const second = { email: address(), password: secret(), next: secret(), words: null }
  let words = null, accounts = 0
  const profiles = {}
  const profile = async name => (profiles[name] ??= await openProfile(name, seen)).page
  const closeProfile = async name => { await profiles[name]?.close().catch(() => {}); delete profiles[name] }
  const hubPath = q => { const u = new URL(q.url); return (u.origin === hub || u.origin === app) && u.pathname.startsWith('/v2/') }
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
      accounts++
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
    let joined = false
    const ifJoined = () => { if (!joined) throw Object.assign(new Error('the second profile did not join'), { skip: true }) }
    await step('a second browser profile JOINS BY LINK (Settings → Invite a Device): both show the same six emoji, "They match", it lands on the Desk, live', 'B', async () => {
      const A = await profile('A'), B = await profile('B')
      const link = await ui.deviceInvite(A)
      r.check(/\/join#v2\./.test(link), 'Show Code gives a join link, its secret after the #', link.replace(/#.*/, '#…'))
      await B.go(link)
      await B.until("document.getElementById('check-code') || document.querySelector('.ob-error.is-shown')", 'six emoji on the new device, or an error line', 60000)
      await A.until("document.querySelector('#set-device[data-state=confirm_code] .check-emoji') || document.querySelector('#set-device .room-error')?.textContent.trim()", 'six emoji on the inviting device, or an error line', 60000)
      const [a, b] = [await ui.emoji(A, '#set-device[data-state=confirm_code]'), await ui.emoji(B, '#check-code')]
      r.check(a.split(' ').length === 6, 'the inviting profile shows six emoji', a.split(' ').length)
      r.check(a === b, 'both profiles show the same six emoji', a === b ? undefined : { inviting: a, joining: b })
      r.note(`the six emoji on both: ${a}`)
      await A.shot(`remote-${String(n + 1).padStart(2, '0')}-A-emoji`).catch(() => {})
      if (a !== b || a.split(' ').length !== 6) return
      await A.click('#set-device[data-state=confirm_code] .check-yes')
      await ui.live(B, 'the new device live', 90000)
      r.check(await B.js("return !!document.querySelector('#inbox') && !document.querySelector('#kit-gate')"), 'the Desk on the second profile')
      await arrives(A, "document.querySelector('#set-device[data-state=joined]')", 'the inviting profile says the new device is in', 60000)
      joined = true
    })
    let text = ''
    await step('a note written on the first profile is seen on the second', 'B', async () => {
      ifJoined()
      const A = await profile('A'), B = await profile('B')
      await ui.openDesk(A)
      text = `Written on the first profile ${crypto.randomBytes(3).toString('hex')}.`
      await openNote(A)
      await A.type(NOTE, text)
      await foldNote(A)
      await arrives(A, "[...trommi.client.model.notes.values()].some(n => n.object_state === 'open' && !n.pending) && trommi.client.model.outbox.length === 0", 'the note saved on the first profile (nothing left to send)')
      const took = await arrives(B, noteIs(text), 'the note on the second profile', 60000)
      r.note(`the note stood on the second profile ${(took / 1000).toFixed(1)} s after it was saved on the first`)
    })
    await step('the second profile edits the note: the edit is seen on the first', 'A', async () => {
      ifJoined()
      const A = await profile('A'), B = await profile('B')
      await openNote(B)
      await appendNote(B, ' Edited on the second.')
      await foldNote(B)
      text += ' Edited on the second.'
      await arrives(A, noteIs(text), 'the edit on the first profile', 60000)
    })
    await step('a small file (a picture) attached to the note on the first profile is opened on the second, its bytes the same', 'B', async () => {
      ifJoined()
      const A = await profile('A'), B = await profile('B')
      const file = path.join(TMP, 'tmp', `remote-${crypto.randomBytes(4).toString('hex')}.png`), png = picture(64, 64)
      fs.writeFileSync(file, png)
      try {
        await openNote(A)
        await A.click('#corner-note-box .corner-note-clip')
        await A.until("document.querySelector('#corner-note-box input[type=file]')", 'the note\'s file field')
        await A.attach('#corner-note-box input[type=file]', [file])
        await arrives(A, "document.querySelector('#corner-note-box .corner-note-file img')?.naturalWidth === 64", 'the picture on the note of the first profile', 60000)
        await foldNote(A)
      } finally { fs.rmSync(file, { force: true }) }
      await arrives(B, "[...trommi.client.model.notes.values()].some(n => n.attachments?.length === 1)", 'the attachment in the second profile\'s model', 60000)
      await openNote(B)
      const decoded = "document.querySelector('#corner-note-box .corner-note-file img')?.naturalWidth === 64"
      if (!await B.until(decoded, 'the picture on the second profile\'s note', 15000).then(() => true, () => false)) {
        // (the corner note of a page that was open when the file came may draw it only once loaded again: real.mjs
        // holds that as its own check; here the question is whether the file opens at all)
        r.note('the second profile\'s open note did not draw the file as it arrived: loaded again to open it')
        await B.reload()
        await ui.live(B, 'live after the reload', 60000)
        await openNote(B)
        await arrives(B, decoded, 'the picture on the second profile\'s note, after a reload', 60000)
      }
      const got = await B.js(`const i = document.querySelector('#corner-note-box .corner-note-file img')
        const b = new Uint8Array(await (await fetch(i.currentSrc)).arrayBuffer()), h = new Uint8Array(await crypto.subtle.digest('SHA-256', b))
        return { size: b.length, sha256: [...h].map(x => x.toString(16).padStart(2, '0')).join('') }`)
      r.check(got.size === png.length && got.sha256 === sha256(png), `the bytes the second profile opens are the ${png.length} bytes attached`, got)
    })
    await step('a desk made on the first profile (a register) is in the second profile\'s menu', 'B', async () => {
      ifJoined()
      const A = await profile('A'), B = await profile('B')
      for (const P of [A, B]) { await P.key('Escape', 27); await ui.openDesk(P) }
      const name = `Desk ${crypto.randomBytes(2).toString('hex')}`
      const has = `[...document.querySelectorAll('#menu-desk-rows a.menu-desk b')].some(b => b.textContent === ${JSON.stringify(name)})`
      await A.click('.desk-switch-open')
      await A.until("document.getElementById('brand-doors')?.hidden === false", 'the menu open')
      await A.click('#desk-add')
      await A.until("document.activeElement?.matches('.menu-desk-field')", 'the field for the new desk\'s name')
      await A.session.send('Input.insertText', { text: name })
      await A.key('Enter', 13)
      await arrives(A, has, 'the new desk in the first profile\'s menu')
      await A.key('Escape', 27)
      await B.click('.desk-switch-open')
      await B.until("document.getElementById('brand-doors')?.hidden === false", 'the menu open on the second profile')
      const took = await arrives(B, has, 'the new desk in the second profile\'s menu', 60000)
      r.note(`the desk "${name}" was in the second profile's menu after ${(took / 1000).toFixed(1)} s`)
    })
    await step('a third browser profile logs in with the password (joins with the recovery code, 8.4); Settings shows the devices', 'C', async () => {
      const A = await profile('A'), C = await profile('C')
      await ui.logIn(C, start, email, password)
      await C.until(`(${ui.LIVE}) || document.querySelector('#ob-error')?.textContent.trim()`, 'the Desk, or a refusal', 90000)
      if (!await C.js(`return Boolean(${ui.LIVE})`)) throw new Error('the login was refused (the error line is below)')
      for (const P of [A, C]) {
        await ui.openSettingsPage(P, 'devices')
        await P.until("document.querySelectorAll('.room-device').length >= 3", `at least three devices listed on ${P.name}`, 40000).catch(() => {})
        const listed = await P.js("return document.querySelectorAll('.room-device').length")
        // (logging out removes no device under protocol v2: the first profile's device of before the log out is still
        // listed, so four rows are expected when the second profile joined: that one, the first profile's new device,
        // the second profile's and the third's)
        r.check(listed >= 3, `${P.name} lists the devices`, listed)
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
    // "forgot password" on a SECOND account of its own: a recovery removes every other device of its account (8.7)
    const made2 = await step('a second, separate account (for "forgot password" only) is made on its own profile: its Emergency Kit, the Desk', 'R', async () => {
      const R = await profile('R')
      await R.go(start)
      await R.until("document.querySelector('#way-create')", 'the welcome screen', 30000)
      await R.click('#way-create')
      await R.until("document.querySelector('#create-form')", 'the create account screen')
      await R.type('#create-form input[name=email]', second.email)
      await R.type('#create-form input[name=password]', second.password)
      await R.click('#create-form button[type=submit]')
      await R.until("document.querySelector('#kit-gate[open] #kit-done') || document.querySelector('#ob-error')?.textContent.trim()", 'the Emergency Kit screen, or a refusal', 90000)
      if (!await R.js("return !!document.querySelector('#kit-gate #kit-done')")) throw new Error('the account was not made (the error line is below)')
      accounts++
      second.words = await ui.readKit(R)
      r.check(second.words.split(' ').length === 12, 'twelve words were shown')
      await R.click('#kit-show')
      await ui.live(R, 'the room live', 60000)
      if (await R.js("return !!document.querySelector('#kit-gate #kit-done')")) await ui.leaveKit(R)
    })
    await closeProfile('R')
    let recovered = false
    await step('forgot password on a fresh profile: the one field "Email or account ID", the twelve words, a new password → a NEW kit → the Desk, live', 'S', async () => {
      if (!second.words) throw Object.assign(new Error('the second account has no kit'), { skip: true })
      const S = await profile('S')
      await S.go(start)
      await S.until("document.querySelector('#way-login')", 'the welcome screen', 30000)
      await S.click('#way-login')
      await S.until("document.querySelector('#way-forgot')", 'the login screen')
      await S.click('#way-forgot')
      await S.until("document.querySelector('#forgot-form')", 'the forgot password screen')
      const fields = await S.js("return [...document.querySelectorAll('#forgot-form .ob-label')].map(l => l.textContent.trim())")
      r.check(fields[0] === 'Email or account ID', 'the first field is "Email or account ID"', fields)
      await S.type('#forgot-form input[name=account]', second.email)
      await S.type('#forgot-form textarea[name=words]', second.words)
      await S.type('#forgot-form input[name=password]', second.next)
      await S.click('#forgot-form button[type=submit]')
      await S.until("document.querySelector('#kit-gate[open] #kit-done') || document.querySelector('#ob-error')?.textContent.trim()", 'the new kit, or a refusal', 90000)
      if (!await S.js("return !!document.querySelector('#kit-gate #kit-done')")) throw new Error('the recovery was refused (the error line is below)')
      recovered = true
      const fresh = await ui.readKit(S)
      r.check(fresh.split(' ').length === 12 && fresh !== second.words, 'a NEW kit of twelve words is shown')
      await S.click('#kit-show')
      if (await S.js("return !!document.querySelector('#kit-gate #kit-done')")) await ui.leaveKit(S)
      else r.note('the kit screen had closed by itself before "Open Trommi" was pressed')
      await ui.live(S, 'the recovered profile live', 60000)
    })
    await closeProfile('S')
    await step('log in with the NEW password on a fresh profile: the Desk, live', 'T', async () => {
      if (!recovered) throw Object.assign(new Error('the password was not replaced'), { skip: true })
      const T = await profile('T')
      await ui.logIn(T, start, second.email, second.next)
      await T.until(`(${ui.LIVE}) || document.querySelector('#ob-error')?.textContent.trim()`, 'the Desk, or a refusal', 90000)
      if (!await T.js(`return Boolean(${ui.LIVE})`)) throw new Error('the login with the new password was refused (the error line is below)')
      r.check(await T.js("return !!document.querySelector('#inbox')"), 'the Desk')
    })
    await closeProfile('T')
    // (last of all: a refused log-in slows the next ones from this address down, by the hub's login throttle)
    await step('the OLD password is refused on a fresh profile: "Wrong email or password."', 'U', async () => {
      if (!recovered) throw Object.assign(new Error('the password was not replaced'), { skip: true })
      const U = await profile('U')
      await ui.logIn(U, start, second.email, second.password)
      await U.until(`document.querySelector('#ob-error')?.textContent.trim() || (${ui.LIVE})`, 'the refusal of the old password', 60000)
      const said = await U.js("return document.querySelector('#ob-error')?.textContent.trim() || 'not refused: the Desk'")
      r.check(said === 'Wrong email or password.', 'the old password: "Wrong email or password."', said)
    })
    await closeProfile('U')
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
  const asked = seen.requests.filter(hubPath), kinds = new Map()
  for (const q of asked) { const k = `${q.method} ${new URL(q.url).pathname.replace(/[A-Za-z0-9_-]{20,}/g, '…').replace(/\/\d+(?=\/|$)/g, '/N')}`; kinds.set(k, (kinds.get(k) ?? 0) + 1) }
  r.say(`requests to the hub (/v2/): ${asked.length}, ${asked.filter(q => q.status === 429).length} of them answered rate-limited · ${[...kinds].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, c]) => `${k} ×${c}`).join(', ')}`)
  r.say(`accounts made on ${hub}: ${accounts} (e2e-…@example.invalid; they stay there: nothing in the app deletes an account)`)
  return r.finish() ? 1 : 0
}
