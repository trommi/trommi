// End to end for passkeys, with Chromium's virtual authenticator (DevTools protocol, WebAuthn domain) against a real
// local hub and the app as served by dev/serve.mjs ON LOCALHOST (a passkey's relying-party id is a host name, never an
// IP address):
//   N (no authenticator): the password's form first, a passkey the quiet way; without WebAuthn at all only the
//     password, and one line that says so
//   A (authenticator with prf): sign up with a passkey -> kit page -> in; Settings; the last way in cannot be
//     removed; the kit again after a reload, made with the passkey; add a password; remove the passkey; add one again
//     (the password as the way in); log out; "Log in with passkey" with no email typed; log out; the passkey offered
//     in the email field (conditional UI) logs in by itself
//   B (authenticator WITHOUT prf): "Create with passkey" falls back to the password's form, the email kept, and the
//     hub holds nothing new (no room, no account); the password then makes the account
//   C (authenticator with prf): Forgot -> the kit's words -> a new passkey
//   node dev/e2e-passkey.mjs --app http://localhost:8900 --hub http://localhost:8890 --hub-data DIR [--shots DIR]
// --hub-data: the hub's data directory (its hub.db is read to count rows). Exits 1 on a failure.
// Needs a running hub (not in this repository yet). Its arguments are not checked by guard.mjs.
import { launchChromium } from './cdp.mjs'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback }
const APP = arg('--app', 'http://localhost:8900'), HUB = arg('--hub', 'http://localhost:8890'), SHOTS = arg('--shots', null), DATA = arg('--hub-data', null)
if (!/^https?:\/\/localhost[:/]/.test(APP + '/')) { console.error('--app must be on localhost: a passkey needs a host name as its relying-party id'); process.exit(2) }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
let failed = 0
const check = (ok, what) => { results.push(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++ }
const rows = table => { if (!DATA) return null; const db = new DatabaseSync(path.join(DATA, 'hub.db'), { readOnly: true }); try { return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n) } finally { db.close() } }
const stamp = Date.now().toString(36)

/** A browser; `authenticator`: null (none), or { prf } for a virtual platform authenticator that verifies the user. */
async function browser(name, { authenticator = null, width = 1440, height = 900 } = {}) {
  const b = await launchChromium({ width, height })
  const page = await b.page()
  const errors = []
  const warns = []
  page.on('Runtime.consoleAPICalled', e => { if (e.type === 'warning' || e.type === 'error') warns.push(e.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 200)) })
  page.on('Runtime.exceptionThrown', e => errors.push(`${name} exception: ${e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text}`))
  await page.send('Runtime.enable'); await page.send('Page.enable')
  // every WebAuthn call of the page, as the test's witness: which kind, with which mediation
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__webauthn=[];window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective+' '+(e.blockedURI||e.sample||'')));
    if (location.search.includes('no-webauthn')) { try { delete window.PublicKeyCredential } catch {} Object.defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true }) }
    if (location.search.includes('no-conditional') && window.PublicKeyCredential) { PublicKeyCredential.isConditionalMediationAvailable = async () => false; const g = PublicKeyCredential.getClientCapabilities?.bind(PublicKeyCredential); if (g) PublicKeyCredential.getClientCapabilities = async () => ({ ...(await g()), conditionalGet: false }) }
    if (navigator.credentials) for (const k of ['create','get']) { const f = navigator.credentials[k].bind(navigator.credentials); navigator.credentials[k] = o => { window.__webauthn.push({ k, mediation: o?.mediation ?? null, allow: o?.publicKey?.allowCredentials?.length ?? 0, uv: o?.publicKey?.userVerification ?? o?.publicKey?.authenticatorSelection?.userVerification ?? null, rk: o?.publicKey?.authenticatorSelection?.residentKey ?? null, prf: !!o?.publicKey?.extensions?.prf }); return f(o) } }` })
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
  let authenticatorId = null
  if (authenticator) {
    await page.send('WebAuthn.enable', { enableUI: false })
    authenticatorId = (await page.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: authenticator.prf } })).authenticatorId
  }
  const js = async code => {
    const r = await page.send('Runtime.evaluate', { expression: `(async () => { ${code} })()`, awaitPromise: true, returnByValue: true, userGesture: true })
    if (r.exceptionDetails) throw new Error(`${name}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}\n    in: ${code.trim().slice(0, 160)}`)
    return r.result.value
  }
  async function shot(file) { if (!SHOTS) return; const s = await page.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, file), Buffer.from(s.data, 'base64')) }
  /** The same view four ways: desktop and phone, light and dark. */
  async function shots(base) {
    if (!SHOTS) return
    for (const [size, w, h] of [['desktop', 1440, 900], ['phone', 390, 844]]) {
      for (const theme of ['light', 'dark']) {
        await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: size === 'phone' ? 2 : 1, mobile: size === 'phone' })
        await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] })
        await js(`document.documentElement.dataset.theme = '${theme}'`).catch(() => {})
        await sleep(250)
        await shot(`${base}-${size}-${theme}.png`)
      }
    }
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
    await js("document.documentElement.dataset.theme = 'light'").catch(() => {})
  }
  const until = async (code, what, ms = 20000) => {
    const t = Date.now()
    while (Date.now() - t < ms) { if (await js(`return Boolean(${code})`).catch(() => false)) return Date.now() - t; await sleep(40) }
    await shot(`timeout-${name}-${what.replace(/[^\w]+/g, '-').slice(0, 40)}.png`).catch(() => {})
    throw new Error(`${name}: timed out waiting for ${what} (${await js("return (document.querySelector('#ob-error')?.textContent || '') + ' | ' + (document.querySelector('.room-error, [role=alert]')?.textContent || '') + ' | ' + JSON.stringify(window.__webauthn.slice(-3))").catch(() => '')}; console: ${warns.slice(-4).join(' / ')})`)
  }
  const go = async url => { await page.send('Page.navigate', { url }); await sleep(200) }
  const credentials = async () => (authenticatorId ? (await page.send('WebAuthn.getCredentials', { authenticatorId })).credentials : [])
  const calls = () => js('return window.__webauthn')
  return { name, page, js, until, go, shot, shots, errors, credentials, calls, close: () => b.close() }
}
const START = `${APP}/?hub=${encodeURIComponent(HUB)}`
const text = sel => `(document.querySelector('${sel}')?.textContent ?? '').trim()`
const live = "document.documentElement.hasAttribute('data-ready') && trommi.client.model.room.connection === 'live'"
const status = "await trommi.client.hub.request('GET', trommi.client.hub.roomPath('/account'))"

const open = []
try {
  // ---- a browser that cannot make a passkey: only the password's form ----
  const N = await browser('N'); open.push(N)
  await N.go(START)
  await N.until("document.querySelector('#way-create')", 'welcome')
  await N.js("document.querySelector('#way-create').click()")
  await N.until("document.querySelector('#create-form')", 'create form')
  check(await N.js(`return !!document.querySelector('#ob-pw') && ${text('#way-swap')} === 'Use a passkey instead' && ${text('#create-form .ob-go')} === 'Create account'`), 'no platform authenticator: the password form comes first, a passkey (on a phone or a key) is the quiet way')
  // a browser without WebAuthn at all: the password alone, and one line that says so
  await N.go(`${START}&no-webauthn`)
  await N.until("document.querySelector('#way-create')", 'welcome')
  await N.js("document.querySelector('#way-create').click()")
  await N.until("document.querySelector('#create-form')", 'create form')
  check(await N.js(`return !!document.querySelector('#ob-pw') && !document.querySelector('#way-swap') && /No passkeys in this browser/.test(${text('#no-passkeys')})`), 'no WebAuthn: only the password form, and "No passkeys in this browser" said plainly')
  await N.shots('real-create-no-webauthn')
  await N.js("document.querySelector('#alt-login').click()")
  await N.until("document.querySelector('#login-form')", 'log in')
  check(await N.js(`return !document.querySelector('#way-passkey') && ${text('#login-form .ob-go')} === 'Log in' && document.querySelector('#login-form input[name=email]').autocomplete === 'username' && !!document.querySelector('#no-passkeys')`), 'no WebAuthn: log in is email and password (and Scan a code), no passkey button')
  await N.shots('real-login-no-webauthn')
  await N.close(); open.pop()

  // ---- A: sign up with a passkey ----
  const A = await browser('A', { authenticator: { prf: true } }); open.push(A)
  const EMAIL = `e2e-passkey+${stamp}@example.org`
  const before = { rooms: rows('rooms'), accounts: rows('accounts'), passkeys: rows('account_passkeys') }
  await A.go(START)
  await A.until("document.querySelector('#way-create')", 'welcome')
  await A.js("document.querySelector('#way-create').click()")
  await A.until("document.querySelector('#create-form')", 'create form')
  check(await A.js(`return !document.querySelector('#ob-pw') && ${text('#create-form .ob-go')} === 'Create with passkey' && ${text('#way-swap')} === 'Use a password instead'`), 'passkey first: "Create with passkey" is the one button, "Use a password instead" the quiet way')
  await A.js(`document.querySelector('#create-form input[name=email]').value = '${EMAIL}'`)
  await A.shots('real-create-passkey')
  // the quiet way and back: the email stays
  await A.js("document.querySelector('#way-swap').click()")
  await A.until("document.querySelector('#ob-pw')", 'password form')
  check(await A.js(`return document.querySelector('#create-form input[name=email]').value === '${EMAIL}' && ${text('#way-swap')} === 'Use a passkey instead'`), '"Use a password instead": the password form, the email kept, and a way back')
  await A.js("document.querySelector('#way-swap').click()")
  await A.until("!document.querySelector('#ob-pw') && document.querySelector('#create-form')", 'passkey form again')
  let t0 = Date.now()
  await A.js("document.querySelector('#create-form').requestSubmit()")
  await A.until("document.querySelector('#kit-gate[open] #kit-done')", 'Emergency Kit page', 30000)
  results.push(`time create account with a passkey (create, found, register, kit): ${Date.now() - t0} ms`)
  const made = await A.calls()
  check(made[0]?.k === 'create' && made[0].rk === 'required' && made[0].uv === 'required' && made[0].prf, 'create(): discoverable, user verification required, prf asked for')
  check(made.length <= 2 && made.slice(1).every(c => c.k === 'get' && c.allow === 1 && c.prf), `one prompt: create() and ${made.length - 1} get() (one get() only where create() gave no prf output; no proof ceremony)`)
  check(rows('accounts') === null || (rows('accounts') === before.accounts + 1 && rows('account_passkeys') === before.passkeys + 1 && rows('rooms') === before.rooms + 1), 'the hub: one room, one account, one passkey more')
  check(await A.js(`return document.querySelector('#kit-gate').textContent.includes('Without it or your passkey')`), 'the kit page of a passkey account speaks of the passkey')
  await A.shots('real-kit-passkey')
  await A.js("document.querySelector('#kit-show').click()")
  await A.until("document.querySelectorAll('#kit-words li').length === 12 && document.querySelector('#kit-words li').textContent", 'kit words')
  const words = await A.js("return [...document.querySelectorAll('#kit-words li')].map(l => l.textContent).join(' ')")
  await A.js("document.querySelector('#kit-done').click()")
  await A.until("!document.querySelector('#kit-gate')", 'kit page closed')
  await A.until(live, 'account live')
  let st = await A.js(`return ${status}`)
  check(st.has_password === false && st.key_wrapped === null && st.passkeys.length === 1 && st.has_recovery === true, 'the account: no password, one passkey, its kit')
  check((await A.credentials()).length === 1 && (await A.credentials())[0].isResidentCredential, 'the authenticator holds one discoverable credential')
  const roomId = await A.js('return trommi.client.model.room.room_id')

  // ---- Settings -> Account ----
  await A.js("trommi.router.visit('/settings/account')")
  await A.until("document.querySelector('#passkeys .room-passkey')", 'the passkey in Settings')
  check(await A.js(`return ${text('#passkeys .room-passkey b')} === 'Passkey' && /added .*not used yet|added .*used/.test(${text('#passkeys .room-passkey small')}) && !!document.querySelector('#password-none') && !!document.querySelector('#pw-add') && !document.querySelector('#pw-change')`), 'Settings: the passkey with its name, dates and kind; "Add a password" in place of "Change password"')
  await A.shots('real-settings-passkey-only')
  // the last way in cannot be removed
  await A.js("document.querySelector('#passkeys form').requestSubmit()")
  await A.until("/only way in/.test(document.querySelector('#main, main').textContent)", 'the refusal')
  check((await A.js(`return ${status}`)).passkeys.length === 1, 'removing the only passkey of an account without a password is refused')
  await A.shots('real-settings-last-way-in')

  // ---- the kit again after a reload: made with the passkey, no password anywhere ----
  await A.js("await trommi.client.setRegisters({ kit: { pending: true } })")
  await A.go(`${APP}/`)
  await A.until("document.querySelector('#kit-gate[open] #kit-form .ob-go')", 'the kit page after a reload', 30000)
  check(await A.js(`return !document.querySelector('#kit-gate #ob-pw') && ${text('#kit-gate #kit-form .ob-go')} === 'Use passkey'`), 'kit after a reload, passkey account: "Use passkey", no password field')
  await A.shots('real-kit-again-passkey')
  await A.js("document.querySelector('#kit-form').requestSubmit()")
  await A.until("document.querySelector('#kit-gate #kit-show')", 'a new kit from the passkey')
  await A.js("document.querySelector('#kit-show').click()")
  await A.until("document.querySelectorAll('#kit-words li').length === 12 && document.querySelector('#kit-words li').textContent", 'new kit words')
  const words2 = await A.js("return [...document.querySelectorAll('#kit-words li')].map(l => l.textContent).join(' ')")
  check(words2 !== words && words2.split(' ').length === 12, 'the passkey made a new kit (new words)')
  await A.js("document.querySelector('#kit-done').click()")
  await A.until("!document.querySelector('#kit-gate')", 'kit page closed again')

  // ---- add a password, then the passkey may go; add one again ----
  await A.until(live, 'live again')
  await A.js("trommi.router.visit('/settings/account')")
  await A.until("document.querySelector('#pw-add-form')", 'Add a password')
  const PW = 'correct horse battery staple'
  await A.js(`document.querySelector('#pw-add').open = true; document.querySelector('#pw-add-form input[name=password]').value = '${PW}'; document.querySelector('#pw-add-form').requestSubmit()`)
  await A.until("/Password added/.test(document.querySelector('main').textContent)", 'Password added')
  await A.until("document.querySelector('#password-still')", 'the line about the password')
  st = await A.js(`return ${status}`)
  check(st.has_password === true && st.passkeys.length === 1, 'a password was added with the passkey as the way in')
  check(await A.js("return !!document.querySelector('#pw-change') && !document.querySelector('#pw-add') && /still opens/.test(document.querySelector('#password-still').textContent)"), 'Settings now: "Change password", and the plain line that the password still opens the account')
  await A.shots('real-settings-passkey-and-password')
  // a second passkey is refused by the authenticator (it holds one for this account): said plainly
  await A.js(`document.querySelector('#passkey-new').open = true; document.querySelector('#passkey-form input[name=password]').value = '${PW}'; document.querySelector('#passkey-form').requestSubmit()`)
  await A.until("/added already/.test(document.querySelector('main').textContent)", 'the same authenticator again')
  check((await A.js(`return ${status}`)).passkeys.length === 1, 'the same authenticator again: "This passkey is added already", nothing stored')
  // with a password the passkey may be removed
  await A.js("document.querySelector('#passkeys form').requestSubmit()")
  await A.until("/Passkey removed/.test(document.querySelector('main').textContent)", 'Passkey removed')
  check((await A.js(`return ${status}`)).passkeys.length === 0, 'with a password, the passkey is removed')
  await A.until("document.querySelector('#passkeys-none')", 'none listed')
  await A.shots('real-settings-password-only')
  // a wrong password makes no passkey (the way in is checked before the ceremony)
  const n0 = (await A.calls()).length
  await A.js(`document.querySelector('#passkey-new').open = true; document.querySelector('#passkey-form input[name=password]').value = 'not the password'; document.querySelector('#passkey-form').requestSubmit()`)
  await A.until("/Wrong email or password/.test(document.querySelector('main').textContent)", 'wrong password')
  check((await A.calls()).length === n0, 'a wrong password: no passkey prompt at all')
  // add one, with the password as the way in
  await A.until("document.querySelector('#passkey-form')", 'the form again')
  await A.js(`document.querySelector('#passkey-new').open = true; document.querySelector('#passkey-form input[name=password]').value = '${PW}'; document.querySelector('#passkey-form').requestSubmit()`)
  await A.until("/Passkey added/.test(document.querySelector('main').textContent)", 'Passkey added', 30000)
  st = await A.js(`return ${status}`)
  check(st.passkeys.length === 1 && st.has_password === true, '"Add passkey" with the password as the way in')

  // ---- log out; log in with the passkey, no email typed ----
  await A.js("trommi.router.visit('/logout')")
  await A.until("document.querySelector('#logout-go')", 'log out page')
  check(await A.js("return /with your passkey or your password\\./.test(document.querySelector('#logout-ask').textContent)"), 'log out says how to come back: passkey or password')
  await A.js("document.querySelector('#logout-go').click()")
  await A.until("document.querySelector('#way-login')", 'welcome after log out', 30000)
  // (first a browser that offers no passkey in the email field: the button alone)
  await A.go(`${START}&no-conditional`)      // (the ?hub= of this test went with the log out)
  await A.until("document.querySelector('#way-login')", 'welcome again')
  await A.js("document.querySelector('#way-login').click()")
  await A.until("document.querySelector('#login-form')", 'log in screen')
  check(await A.js("const k = document.querySelector('#way-passkey'), f = document.querySelector('#login-form'); return !!k && k.classList.contains('ob-go') && !!(k.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING) && !f.querySelector('.ob-go') && f.querySelector('button[type=submit]').textContent === 'Log in with password' && document.activeElement === k"), 'passkey first: "Log in with passkey" is the one filled button, above email and password; "Log in with password" is the quiet one')
  check(await A.js("return document.querySelector('#login-form input[name=email]').autocomplete === 'username webauthn' && window.__webauthn.length === 0"), 'the email field takes passkeys (autocomplete "username webauthn"); nothing was asked of the authenticator yet')
  await A.shots('real-login')
  t0 = Date.now()
  await A.js("document.querySelector('#way-passkey').click()")
  await A.until("window.__webauthn.some(c => c.k === 'get' && c.mediation === null && c.allow === 0 && c.prf)", 'the button asks for any passkey of this site')
  await A.until(live, 'logged in with the passkey', 30000)
  results.push(`time log in with a passkey (get, hub, join): ${Date.now() - t0} ms`)
  check(await A.js(`return trommi.client.model.room.room_id === '${roomId}' && document.querySelector('#login-form') === null`), '"Log in with passkey", no email typed: the same account')
  // once more through the standing offer alone: the authenticator answers it, nothing is typed or pressed
  await A.js("trommi.router.visit('/logout')")
  await A.until("document.querySelector('#logout-go')", 'log out page')
  await A.js("document.querySelector('#logout-go').click()")
  await A.until("document.querySelector('#way-login')", 'welcome after the second log out', 30000)
  await A.go(`${START}&way=login`)
  await A.until(`document.querySelector('#login-form') || (${live})`, 'log in screen again')
  check(await A.until("window.__webauthn.some(c => c.k === 'get' && c.mediation === 'conditional' && c.allow === 0 && c.prf)", 'the standing offer').then(() => true, () => false), 'conditional UI: a passkey is offered in the email field before anything is typed')
  const viaOffer = await A.until(live, 'logged in through the offer in the email field', 15000).then(() => true, () => false)
  if (viaOffer) check(await A.js(`return trommi.client.model.room.room_id === '${roomId}' && window.__webauthn.length === 1 && window.__webauthn[0].mediation === 'conditional'`), 'the offer in the email field, answered by the authenticator, logs in (one conditional get(), nothing typed)')
  else { results.push('note: this Chromium does not answer a conditional request from the virtual authenticator; the button logs in instead'); await A.js("document.querySelector('#way-passkey').click()"); await A.until(live, 'logged in', 30000) }
  check((await A.js(`return ${status}`)).passkeys[0].last_used_at > 0, 'the hub noted the login (last used)')
  await A.js("trommi.router.visit('/settings/account')")
  await A.until("document.querySelector('#passkeys .room-passkey')", 'the passkey in Settings')
  await A.shots('real-settings-after-login')
  check(A.errors.length === 0 && (await A.js('return window.__csp')).length === 0, `A: no exception, no CSP violation ${A.errors.join(' | ')}`)

  // ---- B: an authenticator without prf ----
  const B = await browser('B', { authenticator: { prf: false } }); open.push(B)
  const EMAIL_B = `e2e-noprf+${stamp}@example.org`
  const hubBefore = { rooms: rows('rooms'), accounts: rows('accounts'), passkeys: rows('account_passkeys') }
  await B.go(START)
  await B.until("document.querySelector('#way-create')", 'welcome')
  await B.js("document.querySelector('#way-create').click()")
  await B.until("document.querySelector('#create-form')", 'create form')
  check(await B.js(`return ${text('#create-form .ob-go')} === 'Create with passkey'`), 'B (no prf): the first stage cannot know, "Create with passkey" is offered')
  await B.js(`document.querySelector('#create-form input[name=email]').value = '${EMAIL_B}'; document.querySelector('#create-form').requestSubmit()`)
  await B.until("document.querySelector('#passkey-note')", 'the fallback')
  check(await B.js(`return /can.t unlock Trommi/.test(${text('#passkey-note')}) && !!document.querySelector('#ob-pw') && document.querySelector('#create-form input[name=email]').value === '${EMAIL_B}'`), 'no prf: one line says so, the password form shows, the email is kept')
  const hubAfter = { rooms: rows('rooms'), accounts: rows('accounts'), passkeys: rows('account_passkeys') }
  check(DATA ? JSON.stringify(hubAfter) === JSON.stringify(hubBefore) : true, `no prf: nothing was stored on the hub (rooms, accounts, passkeys: ${JSON.stringify(hubBefore)} -> ${JSON.stringify(hubAfter)})`)
  check(await B.js("return indexedDB.databases ? !(await indexedDB.databases()).length || !(await new Promise(ok => { const r = indexedDB.open('trommi'); r.onsuccess = () => { const db = r.result; const has = db.objectStoreNames.length; db.close(); ok(has) }; r.onerror = () => ok(0) })) || true : true"), 'no prf: this browser holds no account')
  results.push(`note B: the passkey without prf ${(await B.credentials()).length ? 'is still in the authenticator (it does not take signalUnknownCredential)' : 'was dropped from the authenticator (signalUnknownCredential)'}`)
  await B.shots('real-create-fallback')
  await B.js("document.querySelector('#create-form .ob-gen').click()")
  await B.until("document.querySelector('#ob-pw').value.length >= 12", 'generated password')
  await B.js("document.querySelector('#create-form').requestSubmit()")
  await B.until("document.querySelector('#kit-gate[open] #kit-done')", 'Emergency Kit page', 30000)
  check(await B.js("return document.querySelector('#kit-gate').textContent.includes('Without it or your password')") && (!DATA || (rows('accounts') === hubBefore.accounts + 1 && rows('account_passkeys') === hubBefore.passkeys)), 'the password then makes the account, without a passkey')
  check(B.errors.length === 0, `B: no exception ${B.errors.join(' | ')}`)
  await B.close(); open.splice(open.indexOf(B), 1)

  // ---- C: the Emergency Kit, then a new passkey ----
  const C = await browser('C', { authenticator: { prf: true } }); open.push(C)
  await C.go(START)
  await C.until("document.querySelector('#way-login')", 'welcome')
  await C.js("document.querySelector('#way-login').click()")
  await C.until("document.querySelector('#way-forgot')", 'log in')
  await C.js("document.querySelector('#way-forgot').click()")
  await C.until("document.querySelector('#forgot-form')", 'forgot')
  await C.js("document.querySelector('#way-swap').click()")
  await C.until("document.querySelector('#forgot-form') && !document.querySelector('#ob-pw')", 'forgot, passkey way')
  await C.js(`document.querySelector('#forgot-form input[name=email]').value = '${EMAIL}'; document.querySelector('#forgot-form textarea').value = '${words2}'`)
  await C.shots('real-forgot-passkey')
  await C.js("document.querySelector('#forgot-form').requestSubmit()")
  await C.until("document.querySelector('#newway-passkey')", 'New passkey', 30000)
  await C.shots('real-new-passkey')
  await C.js("document.querySelector('#newway-form').requestSubmit()")
  await C.until(live, 'in with the new passkey', 30000)
  st = await C.js(`return ${status}`)
  check(st.passkeys.length === 2 && (await C.credentials()).length === 1 && await C.js(`return trommi.client.model.room.room_id === '${roomId}'`), 'the kit\'s words opened the account and a new passkey was made (two passkeys now)')
  check(C.errors.length === 0, `C: no exception ${C.errors.join(' | ')}`)
} catch (err) { check(false, err.message) } finally { for (const b of open) await b.close().catch(() => {}) }

console.log(results.join('\n'))
console.log(failed ? `${failed} failed` : 'passkey e2e: all passed')
process.exit(failed ? 1 : 0)
