// real.mjs: the web app end to end in headless Chromium, against the REAL hub's binary with the REAL core.
//   TROMMI_HUB_BIN=/path/to/trommi-hub node tests/web/e2e/real.mjs      (or: node tests/web/e2e/run.mjs real)
// Without TROMMI_HUB_BIN it does not run, and says so (exit 2).
//
// NOTHING IS SUBSTITUTED: the app is the normal build (index.html, the views, the worker with core-wasm.ts and the
// Rust core's .wasm, the _headers with the app's Content-Security-Policy), the hub is the binary. The hub is reached
// through the app's own origin (harness.mjs serveApp passes /v2/ on, and the hub is started with that origin as its
// public address), so the app's policy is untouched (`connect-src 'self'`).
//
// What the real core can do today decides what runs here: an account, signing in, a second device by the recovery
// code (spec 8.4, which is what "log in with the password" is), tabs, the MLS proof. Stored content (notes, cards,
// chats, the board) and invites are not in the binding yet (core-wasm.ts answers `core-missing`): for those this
// run asserts what the app SHOWS, not that they work. There is no agent here: nothing can join by an invite.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApp, main, openProfile, run, serveApp, skip, sleep, TMP, watch } from './harness.mjs'
import * as ui from './ui.mjs'

const CANNOT = 'This version cannot do that yet.'

async function startHub(publicUrl) {
  const probe = createServer()
  await new Promise(r => probe.listen(0, '127.0.0.1', r))
  const { port } = probe.address()
  await new Promise(r => probe.close(r))
  const url = `http://127.0.0.1:${port}`
  const data = fs.mkdtempSync(path.join(TMP, 'tmp', 'hub-'))
  const env = { HUB_HOST: '127.0.0.1', HUB_PORT: String(port), HUB_URL: publicUrl, HUB_DATA: data, HUB_QUIET: '1', HUB_LOGIN_THROTTLE: 'off', HUB_ORIGINS: publicUrl, PATH: process.env.PATH ?? '' }
  const child = spawn(process.env.TROMMI_HUB_BIN, [], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', d => { stderr += d })
  const exited = new Promise(resolve => child.once('exit', resolve))
  for (let i = 0; ; i++) {
    if (await fetch(`${url}/healthz`).then(r => r.ok, () => false)) break
    if (child.exitCode !== null || i > 200) throw new Error(`the hub did not start: ${stderr.slice(0, 500)}`)
    await sleep(50)
  }
  return {
    url, stderr: () => stderr,
    async close() { child.kill('SIGTERM'); const killer = setTimeout(() => child.kill('SIGKILL'), 1000); await exited; clearTimeout(killer); fs.rmSync(data, { recursive: true, force: true }) },
  }
}

export async function setUp() {
  const dir = await buildApp('real-dist')
  let hubUrl = null
  const app = await serveApp(dir, () => hubUrl)
  const hub = await startHub(app.origin)
  hubUrl = hub.url
  const ctx = {
    dir, app, hub, seen: watch(), run: run('real core + real hub'), profiles: {},
    email: `e2e+${Date.now().toString(36)}@example.org`,
    async profile(name, opts) { return (ctx.profiles[name] ??= await openProfile(name, ctx.seen, opts)).page },
    async closeProfile(name) { await ctx.profiles[name]?.close().catch(() => {}); delete ctx.profiles[name] },
    /** A profile for one step: opened, handed to `fn`, and closed whatever happens. */
    async within(name, fn) { try { return await fn(await ctx.profile(name)) } finally { await ctx.closeProfile(name) } },
  }
  return ctx
}
export async function tearDown(ctx) {
  for (const name of Object.keys(ctx.profiles)) await ctx.closeProfile(name)
  await ctx.app.close().catch(() => {})
  await ctx.hub.close().catch(() => {})
}

export const steps = [
  ['sign up in the UI → the Emergency Kit with its twelve words → the room live on the real hub', async ctx => {
    const { check } = ctx.run
    const A = await ctx.profile('A')
    ctx.password = await ui.signUp(A, ctx.app.start(), ctx.email)
    ctx.devices = 1
    await A.shot('real-01-kit')
    ctx.words = await ui.readKit(A)
    check(ctx.words.split(' ').length === 12, 'twelve words')
    await ui.live(A, 'the room live on the real hub', 40000)
    check(await A.js('return trommi.client.tabRole') === 'leader', 'this tab owns the device')
    check(await A.js("return !!document.querySelector('#desk-invite-go') && !document.querySelector('.inbox-row')"), 'the empty Desk is drawn (behind the kit screen)')
  }],

  // FAILS TODAY, kept failing: the kit screen closes on a human register (`kit`), which is stored content, and the
  // binding seals none yet (auth.mjs kitGate: `client.setRegisters({ kit: … })` → core-missing).
  ['"Open Trommi" closes the Emergency Kit screen: the empty Desk', async ctx => {
    const A = await ctx.profile('A')
    try { await ui.leaveKit(A) } catch (err) { ctx.kitStuck = true; await A.shot('real-02-kit-does-not-close'); throw err }
    ctx.run.check(await A.js("return document.title === 'Desk · Trommi' && !!document.querySelector('#desk-invite-go')"), 'the empty Desk')
    await A.shot('real-02-empty-desk')
  }],

  ['reload: still signed in, the connection live again', async ctx => {
    const A = await ctx.profile('A')
    const device = await A.js('return trommi.client.model.room.my_device_id')
    await A.reload()
    await ui.live(A, 'live after the reload', 40000)
    ctx.run.check(await A.js('return trommi.client.model.room.my_device_id') === device && await A.js("return !!document.querySelector('#inbox')"), 'the same device, the Desk drawn')
    await sleep(1000)
    const kit = await A.js("return document.querySelector('#kit-gate[open]')?.innerText.replace(/\\s*\\n\\s*/g, ' | ').slice(0, 120) ?? null")
    if (kit) ctx.run.note(`the kit screen is back over the Desk: "${kit}"`)
  }],

  ['(only while the kit screen does not close) the way out a person has: its own "Log out", then log in again → the Desk', async ctx => {
    if (!ctx.kitStuck) throw skip('not needed: the kit screen closed')
    const { check, note } = ctx.run
    const A = await ctx.profile('A')
    await ui.logOutFromKit(A)
    note(`the welcome screen says: "${await A.js("return document.getElementById('logged-out')?.textContent ?? ''")}"`)
    await ui.logIn(A, ctx.app.start(), ctx.email, ctx.password)
    ctx.devices += 1
    await ui.live(A, 'logged in again', 60000)
    await sleep(1000)
    check(await A.js("return !document.querySelector('#kit-gate') && document.title === 'Desk · Trommi' && !!document.querySelector('#desk-invite-go')"), 'the empty Desk, no kit screen (this browser\'s mark went with the log out, and the register was never written)')
    await A.shot('real-03-desk-after-login')
  }],

  ['a second profile logs in with the password (joins with the recovery code, spec 8.4) and lands on the Desk', async ctx => {
    const { check } = ctx.run
    const B = await ctx.profile('B')
    await ui.logIn(B, ctx.app.start(), ctx.email, `${ctx.password}-wrong`)
    await B.until("document.querySelector('#ob-error')?.textContent.trim()", 'the refusal of a wrong password', 30000)
    check(await B.js("return document.querySelector('#ob-error').textContent") === 'Wrong email or password.', 'a wrong password: "Wrong email or password."', await B.js("return document.querySelector('#ob-error').textContent"))
    await B.type('#login-form input[name=password]', ctx.password)
    await B.click('#login-form button[type=submit]')
    await ui.live(B, 'the second profile live', 60000)
    ctx.devices += 1
    check(await B.js("return document.title === 'Desk · Trommi' && !!document.querySelector('#inbox') && !document.querySelector('#kit-gate')"), 'the Desk on the second profile')
    await B.shot('real-04-second-device')
  }],

  ['Settings → Devices lists every device made so far, on both profiles', async ctx => {
    const { check, note } = ctx.run
    // (logging out removes no device under protocol v2: a device that logged out stays listed)
    note(`devices made so far: ${ctx.devices}`)
    for (const name of ['A', 'B']) {
      const P = await ctx.profile(name)
      await ui.openSettingsPage(P, 'devices')
      await P.until(`document.querySelectorAll('.room-device').length === ${ctx.devices}`, `${ctx.devices} devices listed on ${name}`, 30000).catch(() => {})
      const listed = await P.js("return [...document.querySelectorAll('.room-device')].map(d => d.innerText.replace(/\\n+/g, ' / '))")
      check(listed.length === ctx.devices, `${name} lists ${ctx.devices} devices`, listed)
    }
    await (await ctx.profile('A')).shot('real-05-devices')
  }],

  ['two tabs of profile A: the first owns the device, the second follows; the owner closed, the follower takes over, live', async ctx => {
    const { check } = ctx.run
    const A = await ctx.profile('A')
    const A2 = await ctx.profiles.A.tab(`${ctx.app.origin}/`)
    await ui.live(A2, 'the second tab live', 40000)
    const roles = [await A.js('return trommi.client.tabRole'), await A2.js('return trommi.client.tabRole')]
    check(roles.join() === 'leader,follower', 'owner and follower', roles)
    await ui.openSettingsPage(A2, 'devices')
    check(await A2.js("return document.querySelectorAll('.room-device').length") === ctx.devices, 'the follower shows the owner\'s model (the same devices)')
    await A.close()
    ctx.profiles.A.page = A2
    await A2.until("trommi.client.tabRole === 'leader' && trommi.client.model.room.connection === 'live'", 'the follower owns the device and is live', 40000)
  }],

  ['the MLS proof screen (Settings → MLS proof) runs the core\'s self test and says OK', async ctx => {
    const A = await ctx.profile('A')
    await ui.openSettingsPage(A, 'proof')
    await A.until("/^(OK|FAIL)/.test(document.querySelector('#proof, main')?.innerText.trim().split('\\n').find(l => /^(OK|FAIL)/.test(l)) ?? '')", 'the proof\'s result', 60000)
    const first = await A.js("return document.querySelector('#proof, main').innerText.trim().split('\\n').find(l => /^(OK|FAIL)/.test(l))")
    ctx.run.check(first.startsWith('OK'), 'the first line says OK', first)
    await A.shot('real-06-mls-proof')
  }],

  ['what the binding cannot do yet is said, not crashed on: a note, a device invite, an agent invite', async ctx => {
    const { check, note } = ctx.run
    const A = await ctx.profile('A')
    const exceptions = ctx.seen.exceptions.length
    // a device invite: Settings → Invite a Device → Show Code
    await ui.openSettings(A)
    await A.click('#settings-pair')
    await A.until("document.querySelector('#set-device .room-error, #set-device[data-state=open], [role=alert]')", 'an answer to Show Code', 20000)
    const device = await A.js("return { state: document.querySelector('#set-device')?.dataset.state ?? null, said: [...document.querySelectorAll('#set-device .room-error, .room-error, #says-host .says:not([hidden])')].map(e => e.innerText.trim()).filter(Boolean) }")
    check(device.state !== 'open' && device.said.some(t => t.includes(CANNOT)), `Show Code says "${CANNOT}"`, device)
    await A.shot('real-07-device-invite-refused')
    // an agent invite: the Desk's "Invite an agent"
    await ui.openDesk(A)
    await A.click('#desk-invite-go')
    await sleep(2500)
    const agent = await A.js("return { path: location.pathname, said: [...document.querySelectorAll('.room-error, #says-host .says:not([hidden]), [role=alert]')].map(e => e.innerText.trim()).filter(Boolean) }")
    check(agent.said.some(t => t.includes(CANNOT)), `Invite an agent says "${CANNOT}"`, agent)
    await A.shot('real-08-agent-invite-refused')
    // a note: typed into the corner note
    await ui.openDesk(A)
    await A.click('#corner-note-box .corner-note-head')
    await A.type('#corner-note-box .corner-note-field', 'A note the core cannot seal yet.')
    await A.key('Escape', 27)
    await sleep(2500)
    const written = await A.js("return { said: [...document.querySelectorAll('#says-host .says:not([hidden]), [role=alert]')].map(e => e.innerText.trim()).filter(Boolean), notes: trommi.client.model.notes.size, field: document.querySelector('#corner-note-box .corner-note-field').value }")
    check(written.said.some(t => t.includes(CANNOT)), `a note that cannot be saved says "${CANNOT}"`, written)
    note(`after the note: ${JSON.stringify(written)}`)
    await A.shot('real-09-note-refused')
    check(ctx.seen.exceptions.length === exceptions, 'no uncaught error in the page or the worker', ctx.seen.exceptions.slice(exceptions))
    await ui.live(A, 'still live')
  }],

  // FAILS TODAY, kept failing: the screen stays at "Setting…" for good, and by then the hub HAS the new password.
  ['forgot password with the Emergency Kit words on a fresh profile: a new password, the new kit, the Desk', async ctx => {
    const { check, note } = ctx.run
    const next = 'a brand new password 4711'
    let outcome = null
    await ctx.within('C', async C => {
      await C.go(ctx.app.start())
      await C.until("document.querySelector('#way-login')", 'the welcome screen')
      await C.click('#way-login')
      await C.until("document.querySelector('#way-forgot')", 'the login screen')
      await C.click('#way-forgot')
      await C.until("document.querySelector('#forgot-form')", 'the forgot password screen')
      await C.type('#forgot-form input[name=email]', ctx.email)
      await C.type('#forgot-form textarea[name=words]', ctx.words)
      await C.type('#forgot-form input[name=password]', next)
      await C.click('#forgot-form button[type=submit]')
      await C.until("document.querySelector('#kit-gate[open] #kit-done') || document.querySelector('#ob-error')?.textContent.trim()", 'the new kit, or a refusal', 30000).catch(() => {})
      outcome = await C.js("return document.querySelector('#kit-gate[open]') ? 'kit' : document.querySelector('#ob-error')?.textContent.trim() ? 'refused: ' + document.querySelector('#ob-error').textContent.trim() : 'no answer after 30 s; the button says \"' + (document.querySelector('#forgot-form button[type=submit]')?.textContent.trim() ?? '?') + '\"'")
      await C.shot('real-10-forgot-password')
      if (outcome === 'kit') {
        const words = await ui.readKit(C)
        check(words !== ctx.words, 'a new kit is shown')
        ctx.words = words
        await ui.live(C, 'the recovered profile live', 60000)
      }
    })
    // which password opens the account now, asked of the app on a fresh profile each
    const opens = {}
    for (const [name, password] of [['new', next], ['old', ctx.password]]) {
      await ctx.within(`D-${name}`, async D => {
        await ui.logIn(D, ctx.app.start(), ctx.email, password)
        await D.until(`(${ui.LIVE}) || document.querySelector('#ob-error')?.textContent.trim()`, 'the Desk, or a refusal', 60000)
        opens[name] = await D.js(`return Boolean(${ui.LIVE})`)
        if (opens[name]) ctx.devices += 1
      })
    }
    note(`the screen: ${outcome}; afterwards the new password ${opens.new ? 'opens' : 'does not open'} the account, the old one ${opens.old ? 'still opens it' : 'does not'}`)
    if (opens.new) ctx.password = next
    check(outcome === 'kit', 'the screen goes on to the new kit', outcome)
    check(opens.new === (outcome === 'kit') && opens.old !== opens.new, 'the password is replaced exactly if the screen finished', opens)
  }],

  ['log out (Settings → Account → Log Out): the welcome screen, nothing of the device left in the profile; log in again', async ctx => {
    const { check, note } = ctx.run
    const B = await ctx.profile('B')
    await ui.logOut(B)
    const said = await B.js("return document.getElementById('logged-out')?.textContent ?? null")
    check(typeof said === 'string' && said.startsWith('Logged out.'), 'the welcome screen says "Logged out."', said)
    note(`the screen says: "${said}"`)
    const stored = await ui.storedCount(B)
    check(stored.records <= 1 && stored.local === 0, 'nothing stored but the wrapping key', stored)
    await B.shot('real-11-logged-out')
    await ui.logIn(B, ctx.app.start(), ctx.email, ctx.password)
    await ui.live(B, 'logged in again with the password', 60000)
  }],

  ['over the whole run: no Content-Security-Policy violation, no uncaught error in a page or a worker', async ctx => {
    const { check, note } = ctx.run
    for (const name of Object.keys(ctx.profiles)) { const v = await ctx.profiles[name].page.violations(); check(!v.length, `${name}: no violation on its last page`, v) }
    check(!ctx.seen.csp.length, 'no policy violation was reported', ctx.seen.csp)
    check(!ctx.seen.exceptions.length, 'no uncaught error', ctx.seen.exceptions)
    check(ctx.app.policy.includes("connect-src 'self' https://hub.trommi.com;"), 'the policy served is the app\'s own', ctx.app.policy)
    for (const [kind, list] of [['console error', ctx.seen.errors], ['console warning', ctx.seen.warnings], ['failed request', ctx.seen.network]]) {
      const counted = new Map()
      for (const line of list) { const k = line.replace(/\d{4,}/g, 'N').split('\n')[0].slice(0, 220); counted.set(k, (counted.get(k) ?? 0) + 1) }
      for (const [line, n] of counted) note(`${kind}${n > 1 ? ` ×${n}` : ''}: ${line}`)
    }
    const stderr = ctx.hub.stderr().trim()
    if (stderr) note(`the hub wrote to stderr: ${stderr.split('\n').slice(-5).join(' | ').slice(0, 600)}`)
  }],
]

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main('real', { setUp, steps, tearDown }, { hub: true })
