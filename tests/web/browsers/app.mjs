// app.mjs: the built app against a local hub's binary (TROMMI_HUB_BIN) with the real core, in an engine of
// Playwright. Nothing is substituted: the normal build, its own Content-Security-Policy, the hub reached through the
// app's origin (tests/web/e2e/harness.mjs serveApp).
//
// THE STEPS ARE THOSE OF tests/web/e2e/real.mjs, as they are (the Chromium run's own list, imported): sign-up, the
// Emergency Kit, reload, a note, a second profile that joins by link with the six emoji, history, edits both ways, a
// file, a Scribble Board stroke, a new desk, devices, two tabs, the MLS proof, an agent invite, logging in with the
// password, logging out, forgot password. A step that fails here and in Chromium alike is the app's; one that fails
// here alone is the engine's (or this driver's: the report says which).
// Before "forgot password" (which removes every other device) this file adds what the brief asks of an engine:
// passkeys, the live stream and the service worker, a screenshot of each main screen at a desktop's and a phone's
// width, and an account made in a private window.
import fs from 'node:fs'
import path from 'node:path'
import { buildApp, serveApp, TMP } from '../e2e/harness.mjs'
import { steps as realSteps } from '../e2e/real.mjs'
import * as ui from '../e2e/ui.mjs'
import { cannot, counted, openProfile, sleep, watch } from './pw.mjs'
import { spawnHub } from '../hub-process.mjs'

export const ownServer = true

export async function startHub(publicUrl) {
  const data = fs.mkdtempSync(path.join(TMP, 'tmp', 'hub-'))
  const env = { HUB_HOST: '127.0.0.1', HUB_URL: publicUrl, HUB_DATA: data, HUB_QUIET: '1', HUB_LOGIN_THROTTLE: 'off', HUB_ORIGINS: publicUrl, PATH: process.env.PATH ?? '' }
  const { child, url, stderr: errors, exited } = await spawnHub(process.env.TROMMI_HUB_BIN, env)
  for (let i = 0; ; i++) {
    if (await fetch(`${url}/healthz`).then(r => r.ok, () => false)) break
    if (child.exitCode !== null || i > 200) throw new Error(`the hub did not start: ${errors().slice(0, 500)}`)
    await sleep(50)
  }
  return {
    url, stderr: errors,
    async close() { child.kill('SIGTERM'); const killer = setTimeout(() => child.kill('SIGKILL'), 1000); await exited; clearTimeout(killer); fs.rmSync(data, { recursive: true, force: true }) },
  }
}

export async function setUp(ctx) {
  const bin = process.env.TROMMI_HUB_BIN
  if (!bin || !fs.existsSync(bin)) throw cannot(`TROMMI_HUB_BIN ${bin ? `names no file: ${bin}` : 'is not set: a hub binary is needed'}`)
  const dir = await buildApp(`app-${ctx.engine}`)
  let hubUrl = null
  const app = await serveApp(dir, () => hubUrl)
  const hub = await startHub(app.origin)
  hubUrl = hub.url
  // (the shape tests/web/e2e/real.mjs setUp gives its steps)
  Object.assign(ctx, {
    dir, app, hub, seen: Object.assign(watch({ requests: true }), { shots: ctx.out }), profiles: {},
    email: `e2e+${ctx.engine}-${Date.now().toString(36)}@example.org`,
    async profile(name, opts) { return (ctx.profiles[name] ??= await openProfile(ctx.engine, name, ctx.seen, opts)).page },
    async closeProfile(name) { await ctx.profiles[name]?.close().catch(() => {}); delete ctx.profiles[name] },
    async within(name, fn, opts) { try { return await fn(await ctx.profile(name, opts)) } finally { await ctx.closeProfile(name) } },
  })
}
export async function tearDown(ctx) {
  for (const name of Object.keys(ctx.profiles ?? {})) await ctx.closeProfile(name)
  await ctx.app?.close?.().catch(() => {})
  await ctx.hub?.close().catch(() => {})
}

const requestsOf = (ctx, who, test) => ctx.seen.requests.filter(r => r.who === who && test(new URL(r.url), r))

/** The login screen on `origin` in a fresh profile: what the engine offers for passkeys there, what the screen
 *  shows, and how many challenges the page asks the hub for while it just stands. */
async function passkeysOn(ctx, name, origin, stand = 12000) {
  return ctx.within(name, async P => {
    await P.go(`${origin}/?hub=${encodeURIComponent(origin)}`)
    await P.until("document.querySelector('#way-login')", 'the welcome screen')
    const offers = await P.js(`const has = typeof PublicKeyCredential === 'function'
      const ask = async f => { try { return await Promise.race([f(), new Promise(r => setTimeout(() => r('no answer in 3 s'), 3000))]) } catch (e) { return e.name + ': ' + e.message } }
      return { PublicKeyCredential: has, credentials: !!navigator.credentials?.get,
        conditional: has ? await ask(() => PublicKeyCredential.isConditionalMediationAvailable?.() ?? 'no such function') : null,
        platform: has ? await ask(() => PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()) : null,
        capabilities: has ? await ask(async () => PublicKeyCredential.getClientCapabilities ? Object.fromEntries(Object.entries(await PublicKeyCredential.getClientCapabilities()).filter(([k]) => /conditionalGet|userVerifyingPlatformAuthenticator|extension:prf|passkeyPlatformAuthenticator|hybridTransport/.test(k))) : 'no getClientCapabilities') : null }`)
    await P.js(`window.__webauthn = []
      if (navigator.credentials) for (const k of ['create', 'get']) { const f = navigator.credentials[k].bind(navigator.credentials); navigator.credentials[k] = o => { const at = performance.now(), rec = { k, mediation: o?.mediation ?? null, outcome: 'pending' }; window.__webauthn.push(rec); const p = f(o); p.then(() => { rec.outcome = 'resolved' }, e => { rec.outcome = e.name + ' after ' + Math.round(performance.now() - at) + ' ms: ' + e.message }); return p } }`)
    await P.click('#way-login')
    await P.until("document.querySelector('#login-form')", 'the login screen')
    await sleep(stand)
    const screen = await P.js("return { passkeyButton: !!document.querySelector('#way-passkey')?.getClientRects().length, buttonText: document.querySelector('#way-passkey')?.textContent.trim() ?? null, form: !!document.querySelector('#login-form'), error: document.querySelector('#ob-error')?.textContent.trim() || document.querySelector('#passkey-error')?.textContent.trim() || null, calls: window.__webauthn }")
    const challenges = requestsOf(ctx, name, u => u.pathname === '/v1/account/passkey/challenge').map(r => r.status ?? r.failed)
    await P.shot(`app-passkey-login-${name}`)
    return { origin, offers, screen, challenges }
  })
}

const SCREENS = [
  ['desk', async P => { await ui.openDesk(P) }],
  ['note', async P => { await P.click('#corner-note-box .corner-note-head'); await P.until("document.querySelector('#corner-note-box.is-open')", 'the note open'); await sleep(400) }, async P => { await P.key('Escape', 27) }],
  ['menu', async P => { await P.click(await P.js("return document.querySelector('.desk-switch-open')?.getClientRects().length ? '.desk-switch-open' : '#brand-menu'")); await P.until("document.getElementById('brand-doors')?.hidden === false", 'the menu open'); await sleep(300) }, async P => { await P.key('Escape', 27) }],
  ['settings', async P => { await ui.openSettings(P) }],
  ['settings-devices', async P => { await ui.openSettingsPage(P, 'devices'); await sleep(500) }],
  ['settings-account', async P => { await ui.openSettingsPage(P, 'account'); await sleep(500) }],
  ['settings-proof', async P => { await ui.openSettingsPage(P, 'proof'); await P.until("['ok', 'fail'].includes(document.querySelector('.proof')?.dataset.state)", 'the proof', 60000) }],
  ['scribble-board', async P => { await P.go(`${await P.js('return location.origin')}/scribble-board`); await P.until("document.documentElement.hasAttribute('data-ready') && window.pad && document.getElementById('canvas')", 'the board', 40000); await sleep(600) }],
]
/** What the layout obviously breaks on, as a page can measure it: the page scrolls sideways, or a button or field
 *  that is shown reaches out of the window. */
const overflow = P => P.js(`const w = document.documentElement.clientWidth
  // (an element inside a box that scrolls and clips it, itself within the window, is reached by scrolling that box)
  const clipped = e => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { const s = getComputedStyle(p); if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) { const b = p.getBoundingClientRect(); return b.left >= -1 && b.right <= w + 1 } } return false }
  const out = [...document.querySelectorAll('button, a, input, textarea, h1, h2')].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.height && getComputedStyle(e).visibility !== 'hidden' && (r.right > w + 1 || r.left < -1) && r.left < w && r.right > 0 && !clipped(e) }).slice(0, 5).map(e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + ' ' + Math.round(e.getBoundingClientRect().left) + '…' + Math.round(e.getBoundingClientRect().right))
  return { sideways: document.documentElement.scrollWidth > w + 1 ? document.documentElement.scrollWidth + ' > ' + w : null, out }`).catch(e => ({ error: e.message.split('\\n')[0] }))

const extra = [
  ['passkeys: what the engine offers under automation; the login screen\'s standing offer; how often the page asks the hub for a challenge while it stands 12 s', async ctx => {
    const { check, note } = ctx.run
    const found = { name: await passkeysOn(ctx, 'K-name', ctx.app.origin), ip: await passkeysOn(ctx, 'K-ip', ctx.app.numeric) }
    ctx.report.passkeys = found
    for (const [where, f] of Object.entries(found)) {
      note(`${where === 'name' ? 'at localhost' : 'at the IP address 127.0.0.1'}: the engine says ${JSON.stringify(f.offers)}`)
      note(`  the login screen: passkey button ${f.screen.passkeyButton ? `shown ("${f.screen.buttonText}")` : 'not shown'}; WebAuthn calls: ${JSON.stringify(f.screen.calls)}; error line: ${JSON.stringify(f.screen.error)}`)
      note(`  POST /v1/account/passkey/challenge in 12 s: ${f.challenges.length} (${counted(f.challenges.map(String)).join(', ') || 'none'})`)
      check(f.challenges.length <= 2, `the standing login screen asks for at most two challenges (${where})`, f.challenges.length)
      check(f.screen.form, `the login form still stands (${where})`)
    }
  }],

  ['the live stream and the service worker: one stream request per page that stays open; sw.js registered, in control after a reload, and the app live under it', async ctx => {
    const { check, note } = ctx.run
    await ctx.within('W', async W => {
      await ui.logIn(W, ctx.app.start(), ctx.email, ctx.password)
      await ui.live(W, 'logged in', 60000)
      await sleep(3000)
      const streams = requestsOf(ctx, 'W', u => u.pathname === '/v1/stream')
      note(`GET /v1/stream: ${streams.length} request(s): ${streams.map(r => `${r.status ?? r.failed ?? 'no answer yet'}${r.ended ? ` ended after ${r.ended - r.at} ms` : ' open'}`).join(', ')}`)
      check(streams.length === 1 && streams[0].status === 200, 'one stream request, answered 200', streams.map(r => r.status ?? r.failed))
      const sw = async () => W.js("if (!navigator.serviceWorker) return { has: false }; const reg = await Promise.race([navigator.serviceWorker.ready, new Promise(r => setTimeout(() => r(null), 10000))]); return { has: true, state: reg?.active?.state ?? null, script: reg?.active ? new URL(reg.active.scriptURL).pathname : null, controller: !!navigator.serviceWorker.controller, push: typeof PushManager === 'function' && !!reg?.pushManager, notification: typeof Notification === 'function' ? Notification.permission : 'no Notification' }")
      const first = await sw()
      await W.reload()
      await ui.live(W, 'live after a reload under the service worker', 40000)
      const second = await sw()
      ctx.report.serviceWorker = { first, second }
      note(`first load: ${JSON.stringify(first)}; after a reload: ${JSON.stringify(second)}`)
      check(second.has && second.script === '/sw.js' && second.state === 'activated', 'sw.js is registered and activated', second)
      check(second.controller === true, 'the reloaded page is controlled by it', second.controller)
      const pushRow = await (async () => { await ui.openSettings(W); return W.js("return [...document.querySelectorAll('main button, main [role=switch], main .set-row')].map(e => e.innerText.trim().replace(/\\s*\\n\\s*/g, ' | ')).filter(t => /notif|push/i.test(t)).slice(0, 3)") })().catch(e => [e.message.split('\n')[0]])
      note(`Settings rows about notifications: ${JSON.stringify(pushRow)}`)
    })
  }],

  ...[['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844, phone: true }]].map(([size, opts]) => [`a screenshot of each main screen at a ${size}'s width; nothing reaches out of the window`, async ctx => {
    const { check, note } = ctx.run
    const name = `S-${size}`
    await ctx.within(name, async P => {
      const broken = []
      const shot = async screen => { await P.shot(`app-${size}-${screen}`); const o = await overflow(P); if (o.sideways || o.out?.length || o.error) broken.push(`${screen}: ${JSON.stringify(o)}`) }
      await P.go(ctx.app.start())
      await P.until("document.querySelector('#way-create')", 'the welcome screen')
      await shot('welcome')
      await P.click('#way-create'); await P.until("document.querySelector('#create-form')", 'create account'); await shot('create-account')
      await P.go(ctx.app.start()); await P.until("document.querySelector('#way-login')", 'the welcome screen')
      await P.click('#way-login'); await P.until("document.querySelector('#login-form')", 'log in'); await shot('log-in')
      await P.click('#way-forgot'); await P.until("document.querySelector('#forgot-form')", 'forgot password'); await shot('forgot-password')
      await ui.logIn(P, ctx.app.start(), ctx.email, ctx.password)
      await ui.live(P, 'logged in', 60000)
      await sleep(1500)
      // (a phone's layout has no sidebar to press: there each screen is opened by its address, and the note and the
      // menu, which have none, are left out)
      const byAddress = { desk: '/', settings: '/settings', 'settings-devices': '/settings/devices', 'settings-account': '/settings/account', 'settings-proof': '/settings/proof' }
      const direct = (screen, open) => !opts.phone ? open : byAddress[screen] === undefined ? (screen === 'scribble-board' ? open : null) : async P => {
        await P.go(`${ctx.app.origin}${byAddress[screen]}`)
        await ui.live(P, `live at ${byAddress[screen]}`, 40000)
        if (screen === 'settings-proof') await P.until("['ok', 'fail'].includes(document.querySelector('.proof')?.dataset.state)", 'the proof', 60000)
        await sleep(600)
      }
      for (const [screen, pressed, leave] of SCREENS) {
        const open = direct(screen, pressed)
        if (!open) continue
        try { await open(P); await shot(screen); await leave?.(P) } catch (err) { broken.push(`${screen}: could not be opened: ${err.message.split('\n')[0]}`); await P.shot(`app-${size}-${screen}-FAILED`).catch(() => {}); await P.key('Escape', 27).catch(() => {}) }
      }
      ctx.report[`screens-${size}`] = broken
      check(!broken.length, 'every screen opens and nothing reaches out of the window', broken)
      note(`screenshots: app-${size}-*.png`)
    }, opts)
  }]),

  ['a private window: an account is made there, the Desk is live, a note is saved, and a reload finds the device again', async ctx => {
    const { check, note } = ctx.run
    await ctx.within('private', async P => {
      const email = `e2e+private-${ctx.engine}-${Date.now().toString(36)}@example.org`
      let reached = 'the welcome screen'
      try {
        await ui.signUp(P, ctx.app.start(), email)
        reached = 'the Emergency Kit'
        await ui.takeKit(P)
        await ui.live(P, 'live in a private window', 40000)
        reached = 'the Desk, live'
        const stored = await ui.storedCount(P)
        note(`stored in the private window: ${JSON.stringify(stored)}; storage persisted: ${await P.js('return navigator.storage?.persisted?.()').catch(() => '?')}`)
        await P.click('#corner-note-box .corner-note-head')
        await P.until("document.querySelector('#corner-note-box.is-open')", 'the note open')
        await P.type('#corner-note-box .corner-note-field', 'Written in a private window.')
        await P.key('Escape', 27)
        await P.until("[...trommi.client.model.notes.values()].some(n => n.object_state === 'open' && !n.pending) && trommi.client.model.outbox.length === 0", 'the note saved', 30000)
        reached = 'a note saved'
        const device = await P.js('return trommi.client.model.room.my_device_id')
        await sleep(1500)
        await P.reload()
        await ui.live(P, 'live after a reload in the private window', 40000)
        check(await P.js('return trommi.client.model.room.my_device_id') === device, 'the same device after the reload')
        await P.until("document.querySelector('#corner-note-box .corner-note-field')?.value === 'Written in a private window.'", 'the note after the reload', 30000)
        reached = 'the same device and its note after a reload'
      } catch (err) {
        const screen = await P.js("return document.body.innerText.replace(/\\s*\\n\\s*/g, ' | ').slice(0, 300)").catch(() => '?')
        await P.shot('app-private-FAILED').catch(() => {})
        check(false, `it went on past ${reached}`, `${err.message.split('\n')[0]}; the screen says: ${screen}; error lines: ${JSON.stringify(await ui.said(P))}`)
      }
      await P.shot('app-private-window').catch(() => {})
      note(`reached: ${reached}`)
      if (ctx.profiles.private?.isPrivate) check(ctx.profiles.private.isPrivate(), 'what the app stored lies in the profile\'s private storage only')
    }, { private: true })
  }],
]

const at = realSteps.findIndex(([name]) => name.startsWith('forgot password'))
export const steps = at < 0 ? [...realSteps.slice(0, -1), ...extra, realSteps.at(-1)] : [...realSteps.slice(0, at), ...extra, ...realSteps.slice(at)]
