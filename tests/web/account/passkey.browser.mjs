// passkey.browser.mjs: the account screens with passkeys, end to end in headless Chromium with a VIRTUAL
// authenticator (DevTools protocol `WebAuthn.addVirtualAuthenticator`: a platform authenticator with resident keys,
// user verification and the prf extension), and the pictures of every screen this changed.
//   node tests/web/account/passkey.browser.mjs            (needs Chromium and the built core; one browser at a time)
//   TROMMI_E2E_SHOTS=<folder> for the pictures (default: the system's temporary folder), TROMMI_E2E_TMP for profiles.
//
// WHAT IS REAL: the built app with its Content-Security-Policy, the app's worker with account.ts, hub.ts, room.ts
// and the engine, the Rust core's binding for every key, sealed copy and account id, IndexedDB, and WebAuthn as the
// browser does it: navigator.credentials.create and get with a discoverable credential, the user handle the hub
// named, and the prf extension's output.
// WHAT IS NOT: the authenticator is Chromium's virtual one (no person, no platform prompt). The hub is the FAKE hub
// (tests/web/stand-in/hub.mjs): it checks no attestation, no assertion's signature and no MLS; it reads the
// credential id out of the attestation and the challenge out of clientDataJSON, and so that it learns who a Commit
// adds, the worker is bundled as tests/web/e2e does it (harness.mjs standInWorker: the real binding with a trailer
// of facts on its Commits). So this shows that the screens, the page's ceremonies and account.ts fit together and
// that the prf output opens what it sealed; it is no evidence that the real hub accepts these passkeys
// (tests/web/account/real-hub.test.mjs checks that with a passkey in software).
//
// The pictures: every changed screen at 1440×900 and 390×844, light and dark, as <name>-<width>-<theme>.png.
import fs from 'node:fs'
import { startFakeHub } from '../stand-in/hub.mjs'
import { hubReaders } from '../stand-in/core.ts'
import { buildApp, main, openProfile, run, serveApp, sleep, standInWorker, SHOTS, watch } from '../e2e/harness.mjs'
import * as ui from '../e2e/ui.mjs'
import { decodeQR } from '../../../app/web/core/qr-decode.mjs'

const q = s => JSON.stringify(s)
const SIZES = [[1440, 900], [390, 844]], THEMES = ['light', 'dark']
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export async function setUp() {
  const dir = await buildApp('passkey-dist')
  await standInWorker(dir)
  let hubUrl = null
  const app = await serveApp(dir, () => hubUrl)
  const hubAuth = bytes => { const a = hubReaders.hubAuth(bytes); return a.hub === app.origin ? { ...a, hub: hubUrl } : a }
  const fake = await startFakeHub({ readers: { ...hubReaders, hubAuth } })
  hubUrl = fake.url
  const seen = watch()
  const ctx = {
    app, fake, seen, run: run('passkeys: virtual authenticator + real core + fake hub'), open: [], shots: [],
    url: (path = '/') => `${app.origin}${path}${path.includes('?') ? '&' : '?'}hub=${encodeURIComponent(app.origin)}&passkeys=1`,
    email: `passkey+${Date.now().toString(36)}@example.org`,
    /** A browser profile with a virtual authenticator, for one step or several: closed by `close(name)`. */
    async profile(name, { prf = true } = {}) {
      const held = ctx.open.find(p => p.name === name)
      if (held) return held.page
      const p = await openProfile(name, seen)
      await p.page.session.send('WebAuthn.enable', { enableUI: false })
      const { authenticatorId } = await p.page.session.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: prf } })
      p.page.authenticator = authenticatorId
      ctx.open.push(p)
      return p.page
    },
    async close(name) { const i = ctx.open.findIndex(p => p.name === name); if (i >= 0) await ctx.open.splice(i, 1)[0].close().catch(() => {}) },
    account: email => [...fake.state.accounts.values()].find(a => a.email === email) ?? null,
    mark() { const from = fake.requests.length; return () => fake.requests.slice(from) },
  }
  return ctx
}
export async function tearDown(ctx) {
  for (const p of ctx.open.splice(0)) await p.close().catch(() => {})
  await ctx.app.close().catch(() => {})
  await ctx.fake.close().catch(() => {})
  if (ctx.shots.length) fs.writeFileSync(`${SHOTS}/onboarding-shots.json`, JSON.stringify(ctx.shots, null, 2))
}

/** The screen as it stands, in both sizes and both themes; the page is left at 1440×900, light. */
async function pictures(ctx, page, name) {
  for (const [width, height] of SIZES) for (const theme of THEMES) {
    await page.session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
    await page.session.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] })
    await sleep(250)
    ctx.shots.push(await page.shot(`${name}-${width}-${theme}`))
  }
  await page.session.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await page.session.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await sleep(150)
}
const text = (page, selector) => page.js(`return document.querySelector(${q(selector)})?.innerText.trim() ?? null`)
const credentials = async page => (await page.session.send('WebAuthn.getCredentials', { authenticatorId: page.authenticator })).credentials
/** What the kit's QR code holds: the code as drawn on the page is painted here, module by module, and read back
 *  by the app's own reader (app/web/core/qr-decode.mjs), in this process. */
async function readQr(page, scope) {
  const drawn = await page.js(`const svg = document.querySelector(${q(`${scope} .set-qr.is-real svg`)})
    if (!svg) return null
    return { size: Number(svg.getAttribute('viewBox').split(' ')[2]), dark: [...svg.querySelector('path').getAttribute('d').matchAll(/M(\\d+) (\\d+)h1v1h-1z/g)].map(m => [Number(m[1]), Number(m[2])]) }`)
  if (!drawn) return null
  const scale = 6, width = drawn.size * scale, data = new Uint8ClampedArray(width * width * 4).fill(255)
  for (const [x, y] of drawn.dark) for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) data.fill(0, ((y * scale + dy) * width + x * scale + dx) * 4, ((y * scale + dy) * width + x * scale + dx) * 4 + 3)
  return decodeQR({ data, width, height: width }) || null
}
/** Welcome → Create account, passkey way. */
async function toCreate(ctx, page) {
  await page.go(ctx.url())
  await page.until("document.querySelector('#way-create')", 'the welcome screen')
  await page.click('#way-create')
  await page.until("document.querySelector('#create-form')", 'the create account screen')
}
/** The kit screen with its words shown: { words, account, qr, warn }. */
async function kitShown(page) {
  const words = await ui.readKit(page)
  return { words, account: await text(page, '#kit-gate #kit-account'), qr: await readQr(page, '#kit-gate'), warn: await text(page, '#kit-gate #kit-warn'), mail: await text(page, '#kit-gate .kit-mail') }
}

export const steps = [
  ['the virtual authenticator has the prf extension (said here if it has not)', async ctx => {
    const page = await ctx.profile('probe')
    await page.go(ctx.url())
    const got = await page.js(`const c = await navigator.credentials.create({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rp: { id: location.hostname, name: 'probe' }, user: { id: new Uint8Array(16), name: 'probe', displayName: 'probe' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, extensions: { prf: { eval: { first: new TextEncoder().encode('probe') } } } } })
      const made = c.getClientExtensionResults().prf ?? null
      const a = await navigator.credentials.get({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname, userVerification: 'required', allowCredentials: [], extensions: { prf: { eval: { first: new TextEncoder().encode('probe') } } } } })
      const first = a.getClientExtensionResults().prf?.results?.first
      return { enabled: made?.enabled ?? null, at_create: Boolean(made?.results?.first), at_get: first ? new Uint8Array(first).length : 0, handle: a.response.userHandle?.byteLength ?? 0 }`)
    ctx.run.check(got.at_get === 32, 'a get() gives a prf output of 32 bytes', got)
    ctx.prf = got
    await ctx.close('probe')
    return `prf: enabled ${got.enabled}, output with create() ${got.at_create}, with get() ${got.at_get} bytes; usernameless get() returns a user handle of ${got.handle} bytes`
  }],

  ['Create account: the passkey is the first way, the e-mail is marked optional (pictures)', async ctx => {
    const page = await ctx.profile('mail')
    await toCreate(ctx, page)
    const seen = await page.js(`const f = document.querySelector('#create-form'); return { button: f.querySelector('button[type=submit]').textContent.trim(), fields: [...f.querySelectorAll('input:not([hidden])')].map(i => i.name), label: f.querySelector('.ob-label').innerText.replace(/\\s+/g, ' ').trim(), swap: document.querySelector('#way-swap')?.textContent.trim() }`)
    ctx.run.check(seen.button === 'Create with passkey' && seen.fields.join() === 'email' && /optional/.test(seen.label) && seen.swap === 'Use a password instead', 'one field, marked optional, and the passkey button', seen)
    await pictures(ctx, page, 'create-passkey')
    await page.click('#way-swap')
    await page.until("document.querySelector('#create-form #ob-pw')", 'the password way')
    ctx.run.check(!/optional/.test(await text(page, '#create-form .ob-label')), 'with a password the e-mail is not optional')
    await pictures(ctx, page, 'create-password')
    await page.click('#way-swap')
    await page.until("!document.querySelector('#create-form #ob-pw')", 'the passkey way again')
  }],

  ['Create with passkey + e-mail: the account is made, the kit shows the account ID and a QR code of its address', async ctx => {
    const page = await ctx.profile('mail'), since = ctx.mark()
    await page.type('#create-form input[name=email]', ctx.email)
    await page.click('#create-form button[type=submit]')
    await page.until("document.querySelector('#kit-gate[open] #kit-done') || document.querySelector('#create-form #ob-error')?.textContent.trim()", 'the Emergency Kit screen, or the form\'s error line', 60000)
    const error = await text(page, '#create-form #ob-error')
    if (error) throw new Error(`the form says "${error}"`)
    const account = ctx.account(ctx.email)
    ctx.run.check(account && ID.test(account.account) && account.kit_form === 'email' && account.passkeys.length === 1 && account.auth === null, 'the hub holds the account: an e-mail, one passkey, no password', account && { account: account.account, kit_form: account.kit_form, passkeys: account.passkeys.length })
    const posts = since().filter(r => r.method === 'POST' && (r.path === '/v1/account/passkey/challenge' || r.path === '/v1/rooms')).map(r => r.path)
    ctx.run.check(posts.join() === '/v1/account/passkey/challenge,/v1/rooms', 'one challenge, then the founding with the account in it', posts)
    const made = since().find(r => r.path === '/v1/rooms').body.account
    ctx.run.check(Object.keys(made).sort().join() === 'email,kit,passkey' && Object.keys(made.kit).sort().join() === 'auth_key,sealed_copy', 'the sign-up body: e-mail, kit, passkey; no user handle, no kit form', Object.keys(made))
    const held = await credentials(page)
    ctx.run.check(held.length === 1 && held[0].isResidentCredential && Buffer.from(held[0].userHandle, 'base64').toString('hex') === account.account.replaceAll('-', ''), 'the passkey is discoverable and carries the account\'s id as its user handle', held.map(c => c.userHandle))
    await pictures(ctx, page, 'kit-hidden')
    const kit = await kitShown(page)
    ctx.run.check(kit.account === account.account, 'the kit shows the account ID the hub gave', kit.account)
    const expected = `${ctx.app.origin}/#k1.${Buffer.from(ctx.app.origin).toString('base64url')}.${account.account.replaceAll('-', '')}`
    ctx.run.check(kit.qr === expected, 'the QR code holds the kit\'s address: hub and id in the fragment', kit.qr)
    ctx.run.check(kit.words.split(' ').every(w => !kit.qr?.includes(w)), 'no word of the kit is in the address')
    ctx.run.check(kit.mail === ctx.email && /passkey/.test(kit.warn) && !/reach you/.test(kit.warn), 'the sheet names the e-mail; the usual sentence under it', [kit.mail, kit.warn])
    await pictures(ctx, page, 'kit-shown')
    ctx.mail = { ...kit, account: account.account }
    await ui.leaveKit(page)
    await ui.live(page, 'the new account\'s room live')
  }],

  ['Settings → Account: the account ID under the e-mail (pictures)', async ctx => {
    const page = await ctx.profile('mail')
    await ui.openSettings(page)
    await page.until("/example\\.org/.test(document.querySelector('#settings-account')?.innerText ?? '')", 'the account row with the e-mail')
    await ui.openSettingsPage(page, 'account')
    await page.until("document.querySelector('#account-id')", 'the account page')
    ctx.run.check(await text(page, '#account-id') === ctx.mail.account && await text(page, '#account-email') === ctx.email, 'e-mail and account ID')
    ctx.run.check(await page.js("return !document.querySelector('#email-add') && !!document.querySelector('#pw-add')"), 'an account with an e-mail is offered a password, and no second e-mail')
    await pictures(ctx, page, 'settings-account-email')
  }],

  ['Log out ends the token at the hub (DELETE /v1/token)', async ctx => {
    const page = await ctx.profile('mail'), since = ctx.mark()
    await ui.logOut(page)
    const out = since().filter(r => r.path === '/v1/token')
    ctx.run.check(out.length === 1 && out[0].method === 'DELETE' && out[0].status === 200, 'one DELETE /v1/token, answered 200', out.map(r => [r.method, r.status]))
  }],

  ['Log in: the passkey first, then ONE field "Email or account ID" with the password (pictures)', async ctx => {
    const page = await ctx.profile('mail')
    // (the virtual authenticator answers by itself, also the offer in the field: it rests while the screen is looked at)
    await page.session.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId: page.authenticator, enabled: false })
    await page.go(ctx.url('/?way=login'))
    await page.until("document.querySelector('#login-form')", 'the login screen')
    const seen = await page.js(`const first = document.querySelector('#room .ob-go'); const f = document.querySelector('#login-form'); return { first: first?.id, fields: [...f.querySelectorAll('input')].map(i => i.name), label: f.querySelector('.ob-label').textContent.trim(), before: Boolean(first && (first.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING)) }`)
    ctx.run.check(seen.first === 'way-passkey' && seen.before && seen.fields.join() === 'account,password' && seen.label === 'Email or account ID', 'the passkey button stands first; one field for the account and the password', seen)
    await pictures(ctx, page, 'login')
    // an account ID with a password
    await page.type('#login-form input[name=account]', ctx.mail.account.toUpperCase())
    await page.type('#login-form input[name=password]', 'whatever password')
    const since = ctx.mark()
    await page.click('#login-form button[type=submit]')
    await page.until("document.querySelector('#login-form #ob-error')?.textContent.trim()", 'the form\'s line')
    ctx.run.check(await text(page, '#login-form #ob-error') === 'Enter your email to log in with a password.', 'the agreed sentence', await text(page, '#login-form #ob-error'))
    ctx.run.check(since().length === 0, 'nothing was sent')
    await pictures(ctx, page, 'login-id-with-password')
    await page.type('#login-form input[name=account]', 'neither one nor the other')
    await page.click('#login-form button[type=submit]')
    await page.until("/not an email address or an account ID/.test(document.querySelector('#login-form #ob-error')?.textContent ?? '')", 'the field\'s normal error')
  }],

  ['Log in usernameless: no field filled, the passkey names the account', async ctx => {
    const page = await ctx.profile('mail'), since = ctx.mark()
    await page.go(ctx.url('/?way=login'))
    await page.until("document.querySelector('#way-passkey')", 'the login screen')
    ctx.run.check(await page.js("return document.querySelector('#login-form input[name=account]').value === '' && document.querySelector('#login-form input[name=password]').value === ''"), 'no field is filled')
    await page.click('#way-passkey')
    await page.session.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId: page.authenticator, enabled: true })
    await ui.live(page, 'the room live after the passkey login', 60000)
    const login = since().find(r => r.path === '/v1/account/passkey/login')
    ctx.run.check(login?.status === 200 && login.body.user_handle && Buffer.from(login.body.user_handle, 'base64url').toString('hex') === ctx.mail.account.replaceAll('-', ''), 'the hub was asked with the credential and the passkey\'s own user handle, no name', login && Object.keys(login.body))
    ctx.run.check(!since().some(r => r.path === '/v1/account/login'), 'no login by name was made')
    await ui.logOut(page)
    await ctx.close('mail')
  }],

  ['Create with passkey and NO e-mail: one tap; the kit is made under the account ID and says so in one sentence', async ctx => {
    const page = await ctx.profile('bare'), since = ctx.mark()
    await toCreate(ctx, page)
    await page.click('#create-form button[type=submit]')
    await page.until("document.querySelector('#kit-gate[open] #kit-done') || document.querySelector('#create-form #ob-error')?.textContent.trim()", 'the Emergency Kit screen, or the form\'s error line', 60000)
    const error = await text(page, '#create-form #ob-error')
    if (error) { await pictures(ctx, page, 'create-no-email-refused'); throw new Error(`an account without e-mail stops here: the form says "${error}"`) }
    const made = since().find(r => r.path === '/v1/rooms').body.account
    ctx.run.check(Object.keys(made).sort().join() === 'kit,passkey', 'the sign-up body holds no e-mail', Object.keys(made))
    const account = [...ctx.fake.state.accounts.values()].find(a => a.email === null)
    ctx.run.check(account?.kit_form === 'id', 'the hub holds an account without e-mail, its kit under the id', account?.kit_form)
    const kit = await kitShown(page)
    ctx.run.check(kit.account === account.account && kit.mail === '' && kit.qr?.endsWith(`.${account.account.replaceAll('-', '')}`), 'the sheet shows the ID and its code, and no e-mail', [kit.account, kit.mail, kit.qr])
    ctx.run.check(kit.warn === 'If you lose your passkey and this kit, your account is lost. Nobody can recover it, not even Trommi.', 'the one plain sentence', kit.warn)
    await pictures(ctx, page, 'kit-no-email')
    ctx.bare = { ...kit, account: account.account }
    await ui.leaveKit(page)
    await ui.live(page, 'the room of the account without e-mail live')
  }],

  ['Settings of an account without e-mail: a neutral label, the ID, "Add an email" with the kit\'s words (pictures)', async ctx => {
    const page = await ctx.profile('bare')
    await ui.openSettings(page)
    await page.until("/Passkey/.test(document.querySelector('#settings-account')?.innerText ?? '')", 'the account row with its neutral label')
    await pictures(ctx, page, 'settings-list-no-email')
    await ui.openSettingsPage(page, 'account')
    await page.until("document.querySelector('#email-add')", 'the account page')
    ctx.run.check(await text(page, '#account-id') === ctx.bare.account && await text(page, '#account-email') === 'No email.' && await page.js("return !!document.querySelector('#pw-needs-email') && !document.querySelector('#pw-add')"), 'no e-mail is said; a password waits for one')
    await page.click('#email-add summary')
    await pictures(ctx, page, 'settings-account-no-email')
  }],

  ['The kit\'s code on a new device: the recovery screen opens with the ID filled in and the fragment gone; another hub is named', async ctx => {
    await ctx.close('bare')
    const page = await ctx.profile('new')
    // (the address as the QR holds it; `hub=` only tells this test's app where its own hub is, as every step does)
    const link = ctx.bare.qr.replace('/#', `/?hub=${encodeURIComponent(ctx.app.origin)}&passkeys=1#`)
    await page.go(link)
    await page.until("document.querySelector('#forgot-form')", 'the recovery screen')
    const seen = await page.js("return { hash: location.hash, href: location.href, account: document.querySelector('#forgot-form input[name=account]').value, hub: document.querySelector('#kit-hub')?.innerText ?? null, focus: document.activeElement?.name }")
    ctx.run.check(seen.hash === '' && !seen.href.includes('k1.') && seen.account === ctx.bare.account && seen.hub === null && seen.focus === 'words', 'the ID is filled in, the address bar holds no fragment, the words are next', seen)
    await pictures(ctx, page, 'forgot-from-kit-code')
    // the same code pointing at another hub: said before anything is typed
    const other = `http://127.0.0.1:${new URL(ctx.app.origin).port}`
    await page.go(`${ctx.app.origin}/?hub=${encodeURIComponent(ctx.app.origin)}&passkeys=1#k1.${Buffer.from(other).toString('base64url')}.${ctx.bare.account.replaceAll('-', '')}`)
    await page.until("document.querySelector('#kit-hub')", 'the line that names the other hub')
    ctx.run.check((await text(page, '#kit-hub')).includes(new URL(other).host) && await page.js("return location.hash === ''"), 'the other hub is named, the fragment is gone', await text(page, '#kit-hub'))
    await pictures(ctx, page, 'forgot-from-kit-code-other-hub')
    // a fragment that is no kit address is dropped without a word
    await page.go(`${ctx.app.origin}/?hub=${encodeURIComponent(ctx.app.origin)}&passkeys=1#k1.AAAA.${ctx.bare.account.replaceAll('-', '')}.extra`)
    await page.until("document.querySelector('#way-create')", 'the start page')
    ctx.run.check(await page.js("return location.hash === ''"), 'a wrong #k1 address leaves the bar too')
  }],

  ['The kit opens the account without e-mail: the words, then a new passkey, then a new kit under the same ID', async ctx => {
    const page = await ctx.profile('new'), since = ctx.mark()
    await page.go(ctx.bare.qr.replace('/#', `/?hub=${encodeURIComponent(ctx.app.origin)}&passkeys=1#`))
    await page.until("document.querySelector('#forgot-form textarea')", 'the recovery screen')
    await page.type('#forgot-form textarea', 'acorn '.repeat(12).trim())
    await page.click('#forgot-form button[type=submit]')
    await page.until("document.querySelector('#forgot-form #ob-error')?.textContent.trim()", 'the miss is said')
    ctx.run.check(/^Wrong account ID or words\./.test(await text(page, '#forgot-form #ob-error')), 'what a miss with an ID says', await text(page, '#forgot-form #ob-error'))
    await pictures(ctx, page, 'forgot-wrong')
    await page.type('#forgot-form textarea', ctx.bare.words)
    await page.click('#forgot-form button[type=submit]')
    await page.until("document.querySelector('#newway-form') || document.querySelector('#forgot-form #ob-error')?.textContent.trim()", 'the new way in, or the form\'s line', 60000)
    if (!await page.js("return !!document.querySelector('#newway-form')")) throw new Error(`the recovery stops here: the form says "${await text(page, '#forgot-form #ob-error')}"`)
    await pictures(ctx, page, 'new-passkey')
    await page.click('#newway-passkey')
    await page.until("document.querySelector('#kit-gate[open] #kit-done') || document.querySelector('#newway-form #ob-error')?.textContent.trim()", 'the new kit, or the form\'s line', 60000)
    const error = await text(page, '#newway-form #ob-error')
    if (error) throw new Error(`the new passkey stops here: the form says "${error}"`)
    const kit = await kitShown(page)
    ctx.run.check(kit.account === ctx.bare.account && kit.words !== ctx.bare.words && kit.mail === '', 'a new kit: new words, the same account ID, still no e-mail', [kit.account, kit.mail])
    ctx.run.check(since().some(r => /\/recovery-code$/.test(r.path) && r.status === 200), 'the code was replaced in one request (8.6)')
    const account = [...ctx.fake.state.accounts.values()].find(a => a.account === ctx.bare.account)
    ctx.run.check(account.passkeys.length === 1 && account.kit_form === 'id', 'one passkey, the new one; the kit under the id', account.passkeys.length)
    ctx.bare = { ...ctx.bare, words: kit.words }
    await ui.leaveKit(page)
    await ui.live(page, 'the recovered room live')
  }],

  ['Add an email later: the same twelve words, typed once more; the kit\'s sheet opens with the e-mail from then on', async ctx => {
    const page = await ctx.profile('new'), email = `later+${Date.now().toString(36)}@example.org`, since = ctx.mark()
    await ui.openSettings(page)
    await ui.openSettingsPage(page, 'account')
    await page.until("document.querySelector('#email-add')", 'the account page')
    await page.click('#email-add summary')
    await page.type('#email-form input[name=email]', email)
    await page.type('#email-form textarea[name=words]', ctx.bare.words)
    await page.click('#email-form button[type=submit]')
    await page.until("document.querySelector('.room-kit #kit-account') || document.querySelector('#room .room-error, #room [role=alert]')?.textContent.trim()", 'the kit\'s sheet again, or the page\'s error', 60000)
    const shown = await page.js("return { words: [...document.querySelectorAll('.room-kit #kit-words li')].map(l => l.textContent.trim()).join(' '), account: document.querySelector('.room-kit #kit-account')?.textContent.trim() ?? null, text: document.querySelector('.room-kit')?.innerText ?? document.querySelector('#room')?.innerText.slice(0, 300) }")
    ctx.run.check(shown.words === ctx.bare.words && shown.account === ctx.bare.account && shown.text.includes(email) && /your email and these 12 words/.test(shown.text), 'the same words, the ID, the e-mail; the sheet says it opens with the e-mail', shown)
    const put = since().find(r => r.path === '/v1/account/email')
    ctx.run.check(put?.status === 200 && Object.keys(put.body).sort().join() === 'email,kit,revision', 'one request: the e-mail with the kit made anew under it', put && [put.status, Object.keys(put.body)])
    const account = [...ctx.fake.state.accounts.values()].find(a => a.account === ctx.bare.account)
    ctx.run.check(account.email === email && account.kit_form === 'email', 'the hub holds the e-mail; the kit is under it', [account.email, account.kit_form])
    await pictures(ctx, page, 'settings-email-added')
    await ctx.close('new')
  }],

  // (a password manager's extension that answers create() and get() for the browser hands its bytes as ArrayBuffers
  //  made in its own realm: `instanceof ArrayBuffer` is false for them and they have no .buffer)
  ['a passkey answered by an extension, its bytes from another realm: the account is made, the kit shows', async ctx => {
    const page = await ctx.profile('realm')
    await page.session.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      const realm = () => { const f = document.createElement('iframe'); f.style.display = 'none'; (document.body ?? document.documentElement).append(f); return f.contentWindow }
      const foreign = b => { if (!(b instanceof ArrayBuffer)) return b; const w = realm(), out = new w.ArrayBuffer(b.byteLength); new w.Uint8Array(out).set(new Uint8Array(b)); return out }
      const wrap = cred => {
        const r = cred.response, ext = cred.getClientExtensionResults()
        const response = Object.create(r)
        for (const k of ['clientDataJSON', 'attestationObject', 'authenticatorData', 'signature', 'userHandle']) if (k in r) Object.defineProperty(response, k, { value: foreign(r[k]) })
        if (r.getTransports) response.getTransports = () => r.getTransports()
        const prf = ext.prf ? { ...ext.prf, ...(ext.prf.results ? { results: { first: foreign(ext.prf.results.first) } } : {}) } : undefined
        return { id: cred.id, type: cred.type, rawId: foreign(cred.rawId), response, getClientExtensionResults: () => ({ ...ext, ...(prf ? { prf } : {}) }) }
      }
      const create = navigator.credentials.create.bind(navigator.credentials), get = navigator.credentials.get.bind(navigator.credentials)
      navigator.credentials.create = async o => wrap(await create(o))
      navigator.credentials.get = async o => wrap(await get(o))
    })()` })
    await toCreate(ctx, page)
    await page.type('#create-form input[name=email]', `realm+${Date.now().toString(36)}@example.org`)
    await page.click('#create-form button[type=submit]')
    await page.until("document.querySelector('#kit-gate[open] #kit-done') || document.querySelector('#create-form #ob-error')?.textContent.trim()", 'the Emergency Kit screen, or the form\'s error line', 60000)
    const error = await text(page, '#create-form #ob-error')
    ctx.run.check(!error && await page.js("return !!document.querySelector('#kit-gate[open] #kit-done')"), 'the account is made: the kit screen, no error line', error)
    ctx.run.check(ctx.seen.exceptions.every(e => !/reading 'slice'/.test(e)), 'no "reading \'slice\'" in the page', ctx.seen.exceptions.slice(-3))
    await ctx.close('realm')
  }],

  // (1Password as the browser's passkey provider: the answer's fields come whole only through toJSON(), base64url;
  //  rawId, the response's getters and getClientExtensionResults() give nothing)
  ['a passkey answered as 1Password does, every field only in toJSON(): the account is made, the kit shows', async ctx => {
    const page = await ctx.profile('json')
    await page.session.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      const b64 = b => { const u = new Uint8Array(b); let s = ''; for (const x of u) s += String.fromCharCode(x); return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '') }
      const shape = cred => {
        const r = cred.response, ext = cred.getClientExtensionResults(), json = { id: cred.id, rawId: b64(cred.rawId), type: cred.type, response: {}, clientExtensionResults: {} }
        for (const k of ['clientDataJSON', 'attestationObject', 'authenticatorData', 'signature', 'userHandle']) if (r[k]) json.response[k] = b64(r[k])
        if (r.getTransports) json.response.transports = r.getTransports()
        if (ext.prf) json.clientExtensionResults.prf = { ...(ext.prf.enabled !== undefined ? { enabled: ext.prf.enabled } : {}), ...(ext.prf.results ? { results: { first: b64(ext.prf.results.first) } } : {}) }
        return { id: cred.id, type: cred.type, rawId: undefined, response: { getTransports: () => undefined }, getClientExtensionResults: () => ({}), toJSON: () => json }
      }
      const create = navigator.credentials.create.bind(navigator.credentials), get = navigator.credentials.get.bind(navigator.credentials)
      navigator.credentials.create = async o => shape(await create(o))
      navigator.credentials.get = async o => shape(await get(o))
    })()` })
    await toCreate(ctx, page)
    await page.type('#create-form input[name=email]', `json+${Date.now().toString(36)}@example.org`)
    await page.click('#create-form button[type=submit]')
    await page.until("document.querySelector('#kit-gate[open] #kit-done') || document.querySelector('#create-form #ob-error')?.textContent.trim() || document.querySelector('#passkey-note')", 'the Emergency Kit screen, or a word', 60000)
    const said = await page.js("return (document.querySelector('#create-form #ob-error')?.textContent.trim() || document.querySelector('#passkey-note')?.textContent.trim()) ?? ''")
    ctx.run.check(!said && await page.js("return !!document.querySelector('#kit-gate[open] #kit-done')"), 'the account is made: the kit screen, no error line', said)
    await ctx.close('json')
  }],

  // (a provider that gives the prf output only at get(): create() says `prf: { enabled: true }` without results; the
  //  page asks get() at once with the same input and that credential, and takes the key from there)
  ['a passkey whose create() gives prf only as enabled, the key at get(): the account is made with one more prompt', async ctx => {
    const page = await ctx.profile('later')
    await page.session.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      window.__gets = []
      const create = navigator.credentials.create.bind(navigator.credentials), get = navigator.credentials.get.bind(navigator.credentials)
      navigator.credentials.create = async o => { const c = await create(o); const ext = c.getClientExtensionResults(); c.getClientExtensionResults = () => ({ ...ext, prf: { enabled: true } }); c.toJSON = undefined; return c }
      navigator.credentials.get = async o => { window.__gets.push((o.publicKey.allowCredentials ?? []).length); return get(o) }
    })()` })
    await toCreate(ctx, page)
    await page.type('#create-form input[name=email]', `later+${Date.now().toString(36)}@example.org`)
    await page.click('#create-form button[type=submit]')
    await page.until("document.querySelector('#kit-gate[open] #kit-done') || document.querySelector('#create-form #ob-error')?.textContent.trim() || document.querySelector('#passkey-note')", 'the Emergency Kit screen, or a word', 60000)
    const said = await page.js("return (document.querySelector('#create-form #ob-error')?.textContent.trim() || document.querySelector('#passkey-note')?.textContent.trim()) ?? ''")
    ctx.run.check(!said && await page.js("return !!document.querySelector('#kit-gate[open] #kit-done')"), 'the account is made: the kit screen, no error line', said)
    ctx.run.check((await page.js('return window.__gets')).join() === '1', 'one get() right after create(), for that one credential', await page.js('return window.__gets'))
    await ctx.close('later')
  }],

  ['the get() for the key after create() fails: nothing was sent but the challenge, no account, the screen says what to do', async ctx => {
    const page = await ctx.profile('noget'), since = ctx.mark()
    await page.session.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      const create = navigator.credentials.create.bind(navigator.credentials)
      navigator.credentials.create = async o => { const c = await create(o); const ext = c.getClientExtensionResults(); c.getClientExtensionResults = () => ({ ...ext, prf: { enabled: true } }); c.toJSON = undefined; return c }
      navigator.credentials.get = async () => { throw new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError') }
    })()` })
    await toCreate(ctx, page)
    await page.type('#create-form input[name=email]', `noget+${Date.now().toString(36)}@example.org`)
    await page.click('#create-form button[type=submit]')
    await page.until("document.querySelector('#passkey-note') || document.querySelector('#kit-gate[open]') || document.querySelector('#create-form #ob-error')?.textContent.trim()", 'a word, or (wrongly) an account', 60000)
    ctx.run.check(await text(page, '#passkey-note') === 'The passkey was saved but cannot unlock Trommi. Delete it in your password manager and use a password.', 'the note says what to do', await text(page, '#passkey-note'))
    const sent = since().filter(r => r.method !== 'GET' && r.path.startsWith('/v1/')).map(r => r.path)
    ctx.run.check(sent.every(p => p === '/v1/account/passkey/challenge'), 'nothing reached the hub but the challenge: no room, no account', sent)
    await ctx.close('noget')
  }],

  ['a passkey without the prf extension: the screen says so and offers the password; no account is made', async ctx => {
    const page = await ctx.profile('noprf', { prf: false }), since = ctx.mark()
    await toCreate(ctx, page)
    await page.click('#create-form button[type=submit]')
    await page.until("document.querySelector('#passkey-note') || document.querySelector('#kit-gate[open]')", 'the note, or (wrongly) an account', 60000)
    ctx.run.check(await text(page, '#passkey-note') === 'The passkey was saved but cannot unlock Trommi. Delete it in your password manager and use a password.' && await page.js("return !!document.querySelector('#create-form #ob-pw')"), 'the password\'s form with the note', await text(page, '#passkey-note'))
    ctx.run.check(!since().some(r => r.path === '/v1/rooms'), 'nothing was founded')
    await ctx.close('noprf')
  }],

  ['nothing the pages complained about', async ctx => {
    const { exceptions, csp, errors } = ctx.seen
    ctx.run.check(exceptions.length === 0, 'no uncaught exception', exceptions.slice(0, 5))
    ctx.run.check(csp.length === 0, 'no policy violation', csp.slice(0, 5))
    // (the screens log what they refuse, by design: counted, shown, not failed on)
    return `${errors.length} console errors, ${ctx.seen.warnings.length} warnings (the screens log refusals); ${ctx.shots.length} pictures in ${SHOTS}`
  }],
]

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main('passkeys', { setUp, steps, tearDown }, {})
