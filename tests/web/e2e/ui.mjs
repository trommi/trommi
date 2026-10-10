// ui.mjs: what a person does on the app's screens, as both end-to-end runs (standin.mjs, real.mjs) do it: sign up,
// open Settings, read the six emoji, log in, log out. Every function takes a page of harness.mjs and presses, types
// and reads what is on screen. Waiting for "the room is live" also reads the page's copy of the model
// (`trommi.client.model.room.connection`), because the Desk shows no sign for it on a wide window.
import { sleep } from './harness.mjs'

/** The app has drawn and its connection to the hub is live. */
export const LIVE = "document.documentElement.hasAttribute('data-ready') && window.trommi?.client?.model.room.connection === 'live'"
const q = s => JSON.stringify(s)

export async function live(page, what = 'the room live', ms = 30000) {
  try { await page.until(LIVE, what, ms) } catch (err) {
    // what the app holds instead, for the failure's line: its connection, its alerts, the screen's error line
    const held = await page.js("const m = window.trommi?.client?.model; return JSON.stringify({ connection: m?.room.connection ?? 'no room open', taken_up_to: m?.room.last_envelope_number ?? null, alerts: (m?.alerts ?? []).map(a => a.code), error_line: document.querySelector('#ob-error')?.textContent.trim() || null })").catch(() => 'the page could not be read')
    throw new Error(`${err.message} (the app holds: ${held})`)
  }
}

/** Welcome → Create account → e-mail, a generated password → the Emergency Kit screen. Returns the password and
 *  leaves the kit screen open, its words still hidden. */
export async function signUp(page, url, email) {
  await page.go(url)
  await page.until("document.querySelector('#way-create')", 'the welcome screen')
  await page.click('#way-create')
  await page.until("document.querySelector('#create-form')", 'the create account screen')
  await page.type('#create-form input[name=email]', email)
  await page.click('#create-form .ob-gen')
  await page.until("/^[a-z]+(-[a-z]+){4}$/.test(document.querySelector('#create-form input[name=password]').value)", 'a generated password')
  const password = await page.js("return document.querySelector('#create-form input[name=password]').value")
  await page.click('#create-form button[type=submit]')
  await page.until("document.querySelector('#kit-gate[open] #kit-done')", 'the Emergency Kit screen', 60000)
  return password
}
/** On the Emergency Kit screen: Show, and read the twelve words. */
export async function readKit(page) {
  await page.click('#kit-show')
  await page.until("document.querySelectorAll('#kit-words li').length === 12 && [...document.querySelectorAll('#kit-words li')].every(l => l.textContent.trim())", 'the twelve words shown')
  return page.js("return [...document.querySelectorAll('#kit-words li')].map(l => l.textContent.trim()).join(' ')")
}
/** "Open Trommi" on the kit screen: resolves once the screen is gone; throws with the screen's error line when it stays. */
export async function leaveKit(page, ms = 15000) {
  await page.click('#kit-done')
  try { await page.until("!document.querySelector('#kit-gate') || document.querySelector('#kit-gate #ob-error')?.textContent.trim()", 'the kit screen closed, or its error line', ms) } catch (err) {
    const held = await page.js("const m = window.trommi?.client?.model; return JSON.stringify({ button: document.querySelector('#kit-done')?.textContent.trim() ?? null, disabled: document.querySelector('#kit-done')?.disabled ?? null, connection: m?.room.connection ?? null, taken_up_to: m?.room.last_envelope_number ?? null, outbox: (m?.outbox ?? []).map(o => [o.envelope_kind, o.outbox_state, o.error]), blocked: m?.room.outbox_blocked ?? null, alerts: (m?.alerts ?? []).map(a => a.code + ': ' + a.message.slice(0, 120)), kit_register: m?.human?.raw?.get('kit') ?? null })").catch(() => 'the page could not be read')
    throw new Error(`${err.message} (the app holds: ${held})`)
  }
  const error = await page.js("return document.querySelector('#kit-gate #ob-error')?.textContent.trim() ?? ''")
  if (error) throw new Error(`"Open Trommi" does not close the Emergency Kit screen; it says "${error}"`)
}
/** Show, read the twelve words, Open Trommi. Returns the words. */
export async function takeKit(page) {
  const words = await readKit(page)
  await leaveKit(page)
  return words
}

/** The menu at the Desk's name → Settings. */
export async function openSettings(page) {
  if (await page.js("return location.pathname === '/settings' && !location.search && !!document.querySelector('#settings-pair, #set-device')")) return
  if (await page.js("return document.getElementById('brand-doors')?.hidden !== false")) {
    await page.click(await page.js("return document.querySelector('.desk-switch-open')?.getClientRects().length ? '.desk-switch-open' : '#brand-menu'"))
    await page.until("document.getElementById('brand-doors')?.hidden === false && document.querySelector('#menu-settings')?.getClientRects().length", 'the menu open')
  }
  await page.click('#menu-settings')
  await page.until("location.pathname === '/settings' && document.querySelector('#settings-devices')", 'Settings')
}
/** Settings → one of its rows (sessions, devices, account, theme, keys, proof). */
export async function openSettingsPage(page, row) {
  await openSettings(page)
  await page.click(`#settings-${row}`)
  await page.until(`location.pathname === '/settings/${row}'`, `Settings · ${row}`)
}
/** The Desk, by the Desk's name in the sidebar. */
export async function openDesk(page) {
  // (a large picture or the note may lie over the sidebar: Escape puts it away, as a person would)
  for (let i = 0; i < 3 && !await page.js("const b = document.getElementById('desk-go')?.getBoundingClientRect(); return !!b && b.width > 0 && !!document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest('#desk-go')"); i++) { await page.key('Escape', 27); await sleep(300) }
  await page.click('#desk-go')
  await page.until("location.pathname === '/' && document.querySelector('#inbox')", 'the Desk')
}

/** Settings → Invite a Device → Show Code → "No scanner? Send the link": the link as the screen shows it. */
export async function deviceInvite(page) {
  await openSettings(page)
  await page.until("document.querySelector('#settings-pair')", 'Invite a Device')
  await page.click('#settings-pair')
  await page.until("document.querySelector('#set-device[data-state=open] .set-qr.is-real svg') || document.querySelector('#set-device .room-error')?.textContent.trim()", 'the code to scan, or an error line', 30000)
  const error = await page.js("return document.querySelector('#set-device[data-state=open]') ? '' : document.querySelector('#set-device .room-error')?.textContent.trim() ?? ''")
  if (error) throw new Error(`Show Code made no invite; the screen says "${error}"`)
  await page.click('#set-device details.room-more summary')
  await page.until("document.querySelector('#set-device .room-link input')?.getClientRects().length", 'the invite link')
  return page.js("return document.querySelector('#set-device .room-link input').value")
}
/** The six emoji inside `scope`, as one string. */
export const emoji = (page, scope) => page.js(`return [...document.querySelectorAll(${q(`${scope} .check-emoji-glyph`)})].map(e => e.textContent).join(' ')`)

/** Welcome → Log in → e-mail and password → submit. Does not wait for what follows. */
export async function logIn(page, url, email, password) {
  await page.go(url)
  await page.until("document.querySelector('#way-login')", 'the welcome screen')
  await page.click('#way-login')
  await page.until("document.querySelector('#login-form')", 'the login screen')
  await page.type('#login-form input[name=account]', email)
  await page.type('#login-form input[name=password]', password)
  await page.click('#login-form button[type=submit]')
}

/** The kit screen's own "Log out" (for an account whose kit screen does not close). */
export async function logOutFromKit(page) {
  await page.click('#kit-logout')
  await page.until("document.getElementById('logout-go') || document.querySelector('#way-create')", 'the question before logging out, or the welcome screen', 30000)
  if (await page.js("return !!document.getElementById('logout-go')")) await page.click('#logout-go')
  await page.until("document.querySelector('#way-create') && document.querySelector('#way-login')", 'the welcome screen after logging out', 60000)
}
/** Settings → Account → Log Out → asked once → the welcome screen. */
export async function logOut(page) {
  await openSettingsPage(page, 'account')
  await page.until("document.getElementById('settings-logout')", 'Log Out on the account page')
  await page.click('#settings-logout')
  await page.until("document.getElementById('logout-go')", 'the question before logging out')
  await page.click('#logout-go')
  await page.until("document.querySelector('#way-create') && document.querySelector('#way-login')", 'the welcome screen after logging out', 30000)
}

/** What is stored in the page's origin: IndexedDB records and localStorage keys. */
export const storedCount = page => page.js(`const dbs = indexedDB.databases ? await indexedDB.databases() : []
  let records = 0
  for (const d of dbs) {
    const db = await new Promise((ok, no) => { const r = indexedDB.open(d.name); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error) })
    for (const n of db.objectStoreNames) records += await new Promise(ok => { const r = db.transaction(n).objectStore(n).count(); r.onsuccess = () => ok(r.result) })
    db.close()
  }
  return { databases: dbs.map(d => d.name).sort(), records, local: localStorage.length }`)

/** The app's toasts and error lines as they stand, for a failure's message. */
export const said = page => page.js("return [...document.querySelectorAll('#says-host .says:not([hidden]), .ob-error, [role=alert]')].map(e => e.innerText.trim()).filter(Boolean)").catch(() => [])
export { sleep }
