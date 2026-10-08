// End to end on a phone profile (390x844, touch, iPhone user agent): the login is kept. Regression test for "the phone
// says log in, and Log in says signed in already" (4 Oct 2026: WebKit reads a stored X25519 CryptoKey back as null, the
// device was lost at the next start; the core now stores the device keys wrapped, and the app never shows the start
// page for a stored account that does not open).
//   node dev/e2e-mobile.mjs [--app URL (default the local dev app)] [--hub URL] [--email E] [--i-mean-production]
// 1. Create account, close the tab, open a new one: the Desk at once, the device record wrapped (no plain CryptoKeys).
// 2. Device B logs in with email + password; reload, hard reload after a service worker update, localStorage and
//    sessionStorage cleared (IndexedDB is the only truth): always the Desk.
// 3. A device record this browser lost (what an iPhone with the old app has): not the start page but "did not open"
//    with Retry and Log out of this device; Log out leads to Log in.
// 4. /login on a logged-in device offers "Log out of this device first" (another account), never a dead end.
// Exits 1 on a failure. WebKit itself: see the commit (the same flow passed in WebKitGTK 2.52).
import { launchChromium } from '../../../dev/cdp.mjs'
import { guard } from '../../../dev/guard.mjs'
guard({ usage: 'node dev/e2e-mobile.mjs [--app URL] [--hub URL] [--email E]', values: ['app', 'hub', 'email'], targets: ['app', 'hub'] })

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback }
const APP = arg('--app', 'http://127.0.0.1:8900'), HUB = arg('--hub', null)
const EMAIL = arg('--email', `e2e+bug-${Date.now().toString(36)}@example.org`)
const Q = HUB ? `?hub=${encodeURIComponent(HUB)}` : ''
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
let failed = 0
const check = (ok, what) => { results.push(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++ }

async function phone(name) {
  const b = await launchChromium({ width: 390, height: 844 })
  const errors = []
  let page
  const attach = async () => {
    page = await b.page()
    page.on('Runtime.exceptionThrown', e => errors.push(`${name} exception: ${e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text}`))
    await page.send('Runtime.enable'); await page.send('Page.enable')
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await page.send('Emulation.setUserAgentOverride', { userAgent: UA })
  }
  await attach()
  const js = async code => {
    const r = await page.send('Runtime.evaluate', { expression: `(async () => { ${code} })()`, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(`${name}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
    return r.result.value
  }
  const until = async (code, what, ms = 30000) => {
    const t = Date.now()
    while (Date.now() - t < ms) { if (await js(`return Boolean(${code})`).catch(() => false)) return; await sleep(80) }
    throw new Error(`${name}: timed out waiting for ${what}`)
  }
  const go = async url => { await page.send('Page.navigate', { url }); await sleep(300) }
  // Close the tab and open a new one on the same browser profile (what "close the page, open it again" is on a phone).
  const reopen = async url => {
    const { targetId } = await page.send('Target.createTarget', { url: 'about:blank' })
    await page.send('Page.close').catch(() => {})
    await sleep(500)
    await attach()
    void targetId
    await go(url)
  }
  const desk = (ms = 20000) => until("document.documentElement.hasAttribute('data-ready') && document.querySelector('#inbox') && window.trommi?.client", 'the Desk', ms)
  const what = () => js("return document.documentElement.hasAttribute('data-ready') ? 'desk' : document.querySelector('#broken-why') ? 'broken' : document.querySelector('#way-create') ? 'start page' : document.querySelector('#login-form') ? 'login' : 'other'")
  const idbDevice = () => js(`return await new Promise(ok => { const r = indexedDB.open('trommi'); r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains('kv')) { db.close(); return ok(null) } const q = db.transaction('kv').objectStore('kv').get('room/device'); q.onsuccess = () => { db.close(); ok(q.result ? Object.keys(q.result).sort().join(',') : String(q.result)) } } })`)
  const login = async (password, device) => {
    await until("document.querySelector('#login-form')", 'login form')
    await js(`const f = document.querySelector('#login-form'); f.querySelector('input[name=email]').value = '${EMAIL}'; f.querySelector('input[name=password]').value = '${password}'; f.querySelector('input[name=device_name]').value = '${device}'; f.querySelector('button[type=submit]').click()`)
    await until("document.documentElement.hasAttribute('data-ready') && trommi.client.model.room.connection === 'live'", 'logged in', 60000)
  }
  return { b, js, until, go, reopen, desk, what, idbDevice, login, errors, close: () => b.close() }
}

const A = await phone('A')
let B = null
try {
  // ---- 1. create account, close the tab, open a new one ----
  await A.go(`${APP}/${Q}`)
  await A.until("document.querySelector('#way-create')", 'welcome')
  await A.js("document.querySelector('#way-create').click()")
  await A.until("document.querySelector('#create-form')", 'create form')
  await A.js(`document.querySelector('#create-form input[name=email]').value = '${EMAIL}'; document.querySelector('#create-form input[name=device_name]').value = 'iPhone'; document.querySelector('#create-form .room-gen').click()`)
  await A.until("document.querySelector('#create-form input[name=password]').value.length >= 12", 'generated password')
  const password = await A.js("return document.querySelector('#create-form input[name=password]').value")
  await A.js("document.querySelector('#create-form button[type=submit]').click()")
  await A.until("document.querySelector('#kit-later')", 'kit offer', 60000)
  await A.js("document.querySelector('#kit-later').click()")
  await A.until("document.documentElement.hasAttribute('data-ready') && trommi.client.model.room.connection === 'live'", 'account live')
  check(true, 'phone A: account created')
  const rec = await A.idbDevice()
  check(rec === 'id,kexPub,kexWrapped,signPub,signWrapped,wrapKey', `device stored wrapped, no plain CryptoKeys (${rec})`)
  await sleep(800)
  await A.reopen(`${APP}/`)
  await A.desk().then(() => check(true, 'tab closed and opened again: the Desk at once'), async e => check(false, `${e.message} (shows: ${await A.what()})`))
  for (let i = 0; i < 2; i++) {
    await A.go(`${APP}/`)
    await A.desk().then(() => check(true, `reload ${i + 1}: the Desk`), async e => check(false, `reload ${i + 1}: ${e.message} (shows: ${await A.what()})`))
  }

  // ---- 2. device B logs in; reload, service worker update + hard reload, local/session storage cleared ----
  B = await phone('B')
  await B.go(`${APP}/${Q}`)
  await B.until("document.querySelector('#way-login')", 'welcome on B')
  await B.js("document.querySelector('#way-login').click()")
  await B.login(password, 'Phone B')
  check(true, 'phone B: logged in with email + password')
  await sleep(800)
  await B.go(`${APP}/`)
  await B.desk().then(() => check(true, 'B reload: the Desk'), async e => check(false, `B reload: ${e.message} (shows: ${await B.what()})`))
  await B.js("const reg = await navigator.serviceWorker?.getRegistration(); await reg?.update().catch(() => {}); return 1")
  await B.js('location.reload(); return 1').catch(() => {})
  await sleep(500)
  await B.desk().then(() => check(true, 'B after a service worker update + reload: the Desk'), async e => check(false, `B after SW update: ${e.message} (shows: ${await B.what()})`))
  await B.js('localStorage.clear(); sessionStorage.clear(); return 1')
  await B.reopen(`${APP}/`)
  await B.desk().then(() => check(true, 'B with localStorage and sessionStorage cleared: the Desk (IndexedDB is the truth)'), async e => check(false, `B storage cleared: ${e.message} (shows: ${await B.what()})`))

  // ---- 4. /login on a logged-in device ----
  await B.js("trommi.router.visit('/login'); return 1")
  await B.until("document.getElementById('login-logout-first')", '/login offers log out first').then(() => check(true, '/login on a logged-in device: "Log out of this device first" and the Desk link'), e => check(false, e.message))

  // ---- 3. a device record lost by the browser (the iPhone with the old app) ----
  await B.js(`await new Promise(ok => { const r = indexedDB.open('trommi'); r.onsuccess = () => { const tx = r.result.transaction('kv', 'readwrite'); tx.objectStore('kv').delete('room/device'); tx.oncomplete = () => { r.result.close(); ok() } } }); return 1`)
  await B.reopen(`${APP}/`)
  await B.until("document.querySelector('#broken-why')", 'the did-not-open screen', 20000).then(() => check(true, 'lost device keys: "did not open", not the start page'), async e => check(false, `${e.message} (shows: ${await B.what()})`))
  check(await B.js("return !!document.querySelector('#broken-retry') && !!document.querySelector('#broken-logout') && !document.querySelector('#way-create')"), 'it offers Retry and Log out of this device')
  await B.js("document.querySelector('#broken-retry').click(); return 1").catch(() => {})
  await sleep(800)
  await B.until("document.querySelector('#broken-why')", 'still the did-not-open screen after Retry', 20000).then(() => check(true, 'Retry opens it again (and says the same)'), e => check(false, e.message))
  await B.js("document.querySelector('#broken-logout').click(); return 1").catch(() => {})
  await sleep(800)
  await B.until("document.querySelector('#login-form')", 'login after log out', 20000).then(() => check(true, 'Log out of this device leads straight to Log in'), async e => check(false, `${e.message} (shows: ${await B.what()})`))
} catch (err) {
  check(false, err.message)
} finally {
  for (const e of [...A.errors, ...(B?.errors ?? [])]) results.push(`err  ${e}`)
  await A.close(); await B?.close()
}
console.log(`${EMAIL}\n${results.join('\n')}`)
process.exit(failed ? 1 : 0)
