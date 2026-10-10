// real.mjs: the web app end to end in headless Chromium, against the REAL hub's binary with the REAL core.
//   TROMMI_HUB_BIN=/path/to/trommi-hub node tests/web/e2e/real.mjs      (or: node tests/web/e2e/run.mjs real)
// Without TROMMI_HUB_BIN it does not run, and says so (exit 2).
//
// NOTHING IS SUBSTITUTED: the app is the normal build (index.html, the views, the worker with core-wasm.ts and the
// Rust core's .wasm, the _headers with the app's Content-Security-Policy), the hub is the binary. The hub is reached
// through the app's own origin (harness.mjs serveApp passes /v2/ on, and the hub is started with that origin as its
// public address), so the app's policy is untouched (`connect-src 'self'`).
//
// What runs here runs with real cryptography end to end: an account, a second device that JOINS BY LINK (six emoji
// on both, and the refusal), stored content (a note, its edits, a file on it, a Scribble Board stroke, a register:
// a new desk), history for the device that joined later, tabs, the MLS proof, signing in with the password (which
// joins with the recovery code, spec 8.4), "forgot password" (the recovery of 8.7), logging out.
// THERE IS NO AGENT HERE: the connector is not part of this run and nothing else is a real agent device, so cards,
// permission requests, chats with a session, the work trail, Artifacts and takeover are NOT covered against the
// real hub (an agent invite is made, nothing joins with it).
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { buildApp, main, openProfile, run, serveApp, skip, sleep, TMP, watch } from './harness.mjs'
import * as ui from './ui.mjs'

/** The hub's binary on a free port, its public address `publicUrl`; `env` adds to (or overrides) its settings. */
export async function startHub(publicUrl, env = {}) {
  const probe = createServer()
  await new Promise(r => probe.listen(0, '127.0.0.1', r))
  const { port } = probe.address()
  await new Promise(r => probe.close(r))
  const url = `http://127.0.0.1:${port}`
  const data = fs.mkdtempSync(path.join(TMP, 'tmp', 'hub-'))
  const settings = { HUB_HOST: '127.0.0.1', HUB_PORT: String(port), HUB_URL: publicUrl, HUB_DATA: data, HUB_QUIET: '1', HUB_LOGIN_THROTTLE: 'off', HUB_ORIGINS: publicUrl, PATH: process.env.PATH ?? '', ...env }
  const child = spawn(process.env.TROMMI_HUB_BIN, [], { env: settings, stdio: ['ignore', 'ignore', 'pipe'] })
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
    dir, app, hub, seen: watch({ requests: true }), run: run('real core + real hub'), profiles: {},
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

const q = s => JSON.stringify(s)
export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
export const NOTE = '#corner-note-box .corner-note-field'
export const noteIs = text => `document.querySelector(${q(NOTE)})?.value === ${q(text)}`
// (a note just folded is saved, and the box drawn anew from what was saved may stand in for it a moment later: a press
//  that meets the box between the two is pressed again)
export const openNote = async P => { for (let i = 0; i < 3 && !await P.js("return !!document.querySelector('#corner-note-box.is-open')"); i++) { await P.until("document.querySelector('#corner-note-box .corner-note-head')?.getClientRects().length", `the note's head drawn on ${P.name}`); try { await P.click('#corner-note-box .corner-note-head') } catch (err) { if (i === 2) throw err; await sleep(200) } } await P.until("document.querySelector('#corner-note-box.is-open')", `the note open on ${P.name}`) }
export const foldNote = async P => { await P.key('Escape', 27); await P.until("!document.querySelector('#corner-note-box.is-open')", `the note folded on ${P.name}`) }
export const appendNote = async (P, text) => { await P.click(NOTE); await P.key('End', 35, 2); await P.session.send('Input.insertText', { text }) }
/** What a page holds when something does not arrive: for a failure's line. */
export const held = P => P.js("const m = window.trommi?.client?.model; return m ? { connection: m.room.connection, taken_up_to: m.room.last_envelope_number, outbox: m.outbox.map(o => [o.envelope_kind, o.outbox_state, o.error]), blocked: m.room.outbox_blocked, alerts: m.alerts.map(a => a.code + ': ' + a.message.slice(0, 140)), notes: [...m.notes.values()].map(n => [n.text.slice(0, 40), n.object_state, n.content_state ?? null]) } : 'no room open'").catch(e => e.message.split('\n')[0])
/** Waits for `code` on `P`; a timeout's error carries what the page holds. */
export async function arrives(P, code, what, ms = 30000) {
  try { return await P.until(code, what, ms) } catch (err) { throw new Error(`${err.message} (${P.name} holds: ${JSON.stringify(await held(P))})`) }
}
/** A PNG of random pixels, stored without compression: width × height × 3 bytes and a little. */
export function picture(width, height) {
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(body.length + 8); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(zlib.crc32(body), out.length - 4); return out }
  const head = Buffer.alloc(13)
  head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = 2   // 8 bits, RGB
  const rows = crypto.randomBytes((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0   // (each row's filter byte: none)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(rows, { level: 0 })), chunk('IEND', Buffer.alloc(0))])
}
/** The first desk ("Personal", desk/main), chosen in the menu: where the room's first note lies once there are two desks. */
async function firstDesk(P) {
  if (await P.js("return document.getElementById('brand-doors')?.hidden !== false")) {
    await P.click(await P.js("return document.querySelector('.desk-switch-open')?.getClientRects().length ? '.desk-switch-open' : '#brand-menu'"))
    await P.until("document.getElementById('brand-doors')?.hidden === false", 'the menu open')
  }
  await P.click('#menu-desk-rows a.menu-desk[data-desk=main]')
  await P.until("trommi.model().desk === 'main' && !trommi.model().all && document.querySelector('#inbox')", 'the first desk')
  // a desk picked in the menu opens the menu again once the page is drawn (sidebar.mjs, trommi-menu-keep): waited
  // for, so that the next press on the menu does not meet it opening and shut it
  await P.until("document.getElementById('brand-doors')?.hidden === false", 'the menu open again after the desk was picked', 5000)
}

export const steps = [
  ['sign up in the UI → the Emergency Kit with its twelve words → the room live on the real hub', async ctx => {
    const { check } = ctx.run
    const A = await ctx.profile('A')
    ctx.password = await ui.signUp(A, ctx.app.start(), ctx.email)
    await A.shot('real-01-kit')
    ctx.words = await ui.readKit(A)
    check(ctx.words.split(' ').length === 12, 'twelve words')
    await ui.live(A, 'the room live on the real hub', 40000)
    check(await A.js('return trommi.client.tabRole') === 'leader', 'this tab owns the device')
  }],

  ['"Open Trommi" closes the Emergency Kit screen: the empty Desk; a reload: still signed in, live, no kit screen', async ctx => {
    const { check } = ctx.run
    const A = await ctx.profile('A')
    await ui.leaveKit(A)
    check(await A.js("return document.title === 'Personal · Trommi' && !!document.querySelector('#desk-invite-go')"), 'the empty Desk')
    await sleep(1500)   // (the kit's register is on its way: the reload below must not find it "still to be saved")
    const device = await A.js('return trommi.client.model.room.my_device_id')
    await A.reload()
    await ui.live(A, 'live after the reload', 40000)
    await sleep(1000)
    check(await A.js('return trommi.client.model.room.my_device_id') === device, 'the same device')
    check(await A.js("return !document.querySelector('#kit-gate')"), 'the kit screen stays away after the reload', await A.js("return document.querySelector('#kit-gate')?.innerText.slice(0, 120)"))
    await A.shot('real-02-empty-desk')
  }],

  ['a note written on the first profile is sealed, taken by the hub, and there again after a reload', async ctx => {
    const A = await ctx.profile('A')
    ctx.note = 'Written before the second device.'
    await openNote(A)
    await A.type(NOTE, ctx.note)
    await foldNote(A)
    await arrives(A, "document.querySelector('#corner-note-box.has-words') && [...trommi.client.model.notes.values()].some(n => n.object_state === 'open' && !n.pending) && trommi.client.model.outbox.length === 0", 'the note saved (nothing left to send)')
    ctx.run.check(!(await ui.said(A)).length, 'no error line or toast', await ui.said(A))
    await A.reload()
    await ui.live(A, 'live after the reload', 40000)
    await arrives(A, noteIs(ctx.note), 'the note after the reload')
    await A.shot('real-03-note')
  }],

  ['a second profile opens a device invite link; "They don\'t match": the invite is burned, nobody is added', async ctx => {
    const { check } = ctx.run
    const A = await ctx.profile('A'), B = await ctx.profile('B')
    const link = await ui.deviceInvite(A)
    check(/\/join#v2\./.test(link), 'Show Code gives a join link, its secret after the #', link.replace(/#.*/, '#…'))
    await B.go(link)
    await B.until("document.getElementById('check-code')", 'six emoji on the new device', 40000)
    check(await B.js("return !location.hash && location.pathname === '/join'"), 'the join secret left the address bar')
    await A.until("document.querySelector('#set-device[data-state=confirm_code] .check-emoji')", 'six emoji on the inviting device', 40000)
    const [a, b] = [await ui.emoji(A, '#set-device[data-state=confirm_code]'), await ui.emoji(B, '#check-code')]
    check(a === b && a.split(' ').length === 6, 'both show the same six emoji')
    await A.click('#set-device[data-state=confirm_code] .check-no')
    await A.until("document.querySelector('#set-device[data-state=failed] .room-error')", 'the inviting device says it failed')
    check(await A.js("return document.querySelector('#set-device .room-error').textContent") === 'They did not match. Nobody was added; the code is used up.', 'the sentence on the inviting device', await A.js("return document.querySelector('#set-device .room-error').textContent"))
    await B.until("document.querySelector('#scan-again') && document.querySelector('.ob-error.is-shown')", 'the new device says it is not logged in', 40000)
    check(await B.js("return document.querySelector('#ob-title').textContent") === 'Not logged in', 'the new device: "Not logged in"')
    await B.shot('real-04-no-match-newcomer')
    check((await ui.storedCount(B)).records <= 1, 'the refused device stored nothing but its wrapping key', await ui.storedCount(B))
    await ui.openSettingsPage(A, 'devices')
    check(await A.js("return document.querySelectorAll('.room-device').length") === 1, 'Devices lists this device alone')
  }],

  ['the second profile JOINS BY LINK: both show six equal emoji, "They match", it lands on the Desk, live', async ctx => {
    const { check, note } = ctx.run
    const A = await ctx.profile('A'), B = await ctx.profile('B')
    const link = await ui.deviceInvite(A)
    await B.go('about:blank')   // (an address that differs from the page's only after the # loads nothing again)
    await B.go(link)
    await B.until("document.getElementById('check-code')", 'six emoji on the new device', 40000)
    await A.until("document.querySelector('#set-device[data-state=confirm_code] .check-emoji')", 'six emoji on the inviting device', 40000)
    const [a, b] = [await ui.emoji(A, '#set-device[data-state=confirm_code]'), await ui.emoji(B, '#check-code')]
    check(a === b && a.split(' ').length === 6, 'both show the same six emoji')
    await A.shot('real-05-match-inviter')
    await B.shot('real-06-match-newcomer')
    const t = Date.now()
    await A.click('#set-device[data-state=confirm_code] .check-yes')
    await ui.live(B, 'the new device live', 90000)
    note(`the new device was live ${((Date.now() - t) / 1000).toFixed(1)} s after "They match"`)
    check(await B.js("return document.title === 'Personal · Trommi' && !!document.querySelector('#inbox') && !document.querySelector('#kit-gate')"), 'the Desk on the second profile', await B.js('return document.body.innerText.slice(0, 160)'))
    await arrives(A, "document.querySelector('#set-device[data-state=joined]')", 'the inviting device says the new device is in', 60000)
    await B.shot('real-07-second-device-desk')
    ctx.joined = true
  }],

  ['the device that joined by link AFTER the note existed reads it (history)', async ctx => {
    const B = await ctx.profile('B')
    if (!ctx.joined) throw skip('the second profile did not join')
    const took = await arrives(B, noteIs(ctx.note), 'the earlier note on the second profile', 90000)
    ctx.run.note(`the earlier note stood on the second profile after ${(took / 1000).toFixed(1)} s`)
    await B.shot('real-08-history-note')
  }],

  ['the second profile edits the note: it appears on the first, and survives a reload there', async ctx => {
    const A = await ctx.profile('A'), B = await ctx.profile('B')
    if (!ctx.joined) throw skip('the second profile did not join')
    await ui.openDesk(A)
    await openNote(B)
    await appendNote(B, ' Read on the second.')
    await foldNote(B)
    ctx.note += ' Read on the second.'
    await arrives(A, noteIs(ctx.note), 'the edit on the first profile')
    await A.reload()
    await ui.live(A, 'live after the reload', 40000)
    await arrives(A, noteIs(ctx.note), 'the edited note after the reload')
  }],

  ['a note edited three times quickly (each edit saved before the one before came back): all of it on the other profile and after a reload', async ctx => {
    const { check, note } = ctx.run
    const A = await ctx.profile('A'), B = await ctx.profile('B')
    await openNote(A)
    for (const more of [' One.', ' Two.', ' Three.']) {
      // (folding the note saves it; it is opened again at once and written on)
      await appendNote(A, more)
      await foldNote(A)
      ctx.note += more
      await openNote(A)
    }
    check(await A.js(`return ${noteIs(ctx.note)}`), 'the first profile shows all three edits at once', await A.js(`return document.querySelector(${q(NOTE)}).value`))
    await foldNote(A)
    const stuck = await A.until("trommi.client.model.outbox.length === 0 && ![...trommi.client.model.notes.values()].some(n => n.pending)", 'nothing left to send', 30000).then(() => null, () => held(A))
    check(stuck === null, 'nothing stays "sending"', stuck)
    if (ctx.joined) await arrives(B, noteIs(ctx.note), 'all three edits on the second profile')
    await A.reload()
    await ui.live(A, 'live after the reload', 40000)
    await arrives(A, noteIs(ctx.note), 'all three edits after the reload')
    note(`versions of the note in the model: ${await A.js("return [...trommi.client.model.notes.values()].map(n => n.versions?.length ?? n.object_version ?? '?').join()")}`)
  }],

  ['a file (a picture of about 3 MiB) attached to the note on the first profile is shown on the second, its bytes the same', async ctx => {
    const { check } = ctx.run
    const A = await ctx.profile('A'), B = await ctx.profile('B')
    const file = path.join(TMP, 'tmp', 'picture.png'), png = picture(1024, 1024)
    fs.writeFileSync(file, png)
    await openNote(A)
    await A.click('#corner-note-box .corner-note-clip')
    await A.until("document.querySelector('#corner-note-box input[type=file]')", 'the note\'s file field')
    await A.attach('#corner-note-box input[type=file]', [file])
    await arrives(A, "document.querySelector('#corner-note-box .corner-note-file img')?.naturalWidth === 1024", 'the picture on the note of the first profile', 40000)
    await foldNote(A)
    if (!ctx.joined) throw skip('uploaded and shown on the first profile; the second profile did not join')
    // KEPT FAILING until the view follows: the second profile's model has the attachment at once, its note does not
    // draw it before the page is loaded again (sidebar.mjs, the corner note's files)
    const shown = "!!document.querySelector('#corner-note-box .corner-note-file')"
    await arrives(B, "[...trommi.client.model.notes.values()].some(n => n.attachments?.length === 1)", 'the attachment in the second profile\'s model', 60000)
    await sleep(1500)
    check(await B.js(`return ${shown}`), 'the second profile\'s note shows the file as it arrives (without a reload)')
    await B.reload()
    await ui.live(B, 'live after the reload', 40000)
    await openNote(B)
    await arrives(B, "document.querySelector('#corner-note-box .corner-note-file img')?.naturalWidth === 1024", 'the picture on the note of the second profile, decoded (after a reload)', 60000)
    const seen = await B.js(`const i = document.querySelector('#corner-note-box .corner-note-file img')
      const b = new Uint8Array(await (await fetch(i.currentSrc)).arrayBuffer()), h = new Uint8Array(await crypto.subtle.digest('SHA-256', b))
      return { size: b.length, sha256: [...h].map(x => x.toString(16).padStart(2, '0')).join('') }`)
    check(seen.size === png.length && seen.sha256 === sha256(png), `the bytes the second profile shows are the ${png.length} bytes attached`, seen)
    await B.shot('real-09-note-with-picture')
    await foldNote(B)
  }],

  ['Scribble Board: a stroke drawn on the first profile appears on the second, and is there after a reload', async ctx => {
    const { check, note } = ctx.run
    const A = await ctx.profile('A'), B = await ctx.profile('B')
    for (const P of ctx.joined ? [A, B] : [A]) {
      await ui.openDesk(P)
      await P.key('p', 80)   // (the Desk's shortcut for its back, the Scribble Board)
      await P.until("location.pathname === '/scribble-board' && window.pad && document.getElementById('canvas')", `the board on ${P.name}`)
    }
    const box = await A.js("const b = document.getElementById('canvas').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }")
    const from = [box.x + box.w * 0.3, box.y + box.h * 0.4], to = [box.x + box.w * 0.55, box.y + box.h * 0.4]
    await A.click('.pad-tool[data-tool=pen]')
    await A.mouse('mouseMoved', ...from, false)
    await A.mouse('mousePressed', ...from)
    for (let i = 1; i <= 12; i++) { await A.mouse('mouseMoved', from[0] + (to[0] - from[0]) * i / 12, from[1], true); await sleep(25) }
    await sleep(700)
    const live = ctx.joined ? await B.js("return pad.elements().filter(e => e.type === 'stroke').length") : null
    await A.mouse('mouseReleased', ...to)
    const sync = await A.until('!pad.state().sync.pending && !pad.state().sync.error', 'the stroke sealed', 30000).then(() => null, async () => A.js('return pad.state().sync'))
    check(sync === null, 'the stroke is sealed (nothing pending, no error)', sync)
    const drawn = (await A.js("return pad.elements().filter(e => e.type === 'stroke').map(e => ({ x: Math.round(e.x), y: Math.round(e.y) }))"))[0]
    await A.shot('real-10-board')
    const same = `(e => e.length === 1 && Math.abs(e[0].x - ${drawn?.x}) < 3 && Math.abs(e[0].y - ${drawn?.y}) < 3)(pad.elements().filter(e => e.type === 'stroke'))`
    if (ctx.joined) {
      note(`while the pen was still down the second profile showed ${live} stroke(s) (live pieces, spec 7.2)`)
      await arrives(B, same, 'the stroke on the second profile')
      await B.reload()
      await B.until("document.documentElement.hasAttribute('data-ready') && window.pad", 'the board on the second profile after a reload', 40000)
      await arrives(B, same, 'the stroke on the second profile after the reload')
    }
    await A.reload()
    await A.until("document.documentElement.hasAttribute('data-ready') && window.pad", 'the board on the first profile after a reload', 40000)
    await arrives(A, same, 'the stroke on the first profile after the reload')
    for (const P of ctx.joined ? [A, B] : [A]) await ui.openDesk(P)
  }],

  ['a register: a new desk named on the first profile is in the second profile\'s menu, and still after a reload', async ctx => {
    const A = await ctx.profile('A'), B = await ctx.profile('B')
    const has = "[...document.querySelectorAll('#menu-desk-rows a.menu-desk b')].some(b => b.textContent === 'Workshop')"
    await A.click('.desk-switch-open')
    await A.until("document.getElementById('brand-doors')?.hidden === false", 'the menu open')
    await A.click('#desk-add')
    await A.until("document.activeElement?.matches('.menu-desk-field')", 'the field for the new desk\'s name')
    await A.session.send('Input.insertText', { text: 'Workshop' })
    await A.key('Enter', 13)
    await arrives(A, has, 'the new desk in the first profile\'s menu')
    await A.shot('real-11-new-desk')
    if (!ctx.joined) throw skip('made on the first profile; the second profile did not join')
    await arrives(B, has, 'the new desk in the second profile\'s menu')
    await sleep(2500)   // (the app writes what arrived into its cache a moment later: see the next step)
    await B.reload()
    await ui.live(B, 'live after the reload', 40000)
    await arrives(B, has, 'the new desk after the reload')
  }],

  // (regression: what arrived used to reach the app's cache 250 ms after the model, with the device's cursor
  // durably past it, so a page loaded again in between lost it for good, and the registers cached before with it)
  ['a register that arrives just before the page is loaded again is still there afterwards: 0, 50, 100, 200, 300 ms, three rounds', async ctx => {
    const { check, note } = ctx.run
    const A = await ctx.profile('A'), B = await ctx.profile('B')
    if (!ctx.joined) throw skip('the second profile did not join')
    const has = name => `[...document.querySelectorAll('#menu-desk-rows a.menu-desk b')].some(b => b.textContent === ${q(name)})`
    const made = ['Workshop'], lost = []
    for (let round = 1; round <= 3; round++) for (const wait of [0, 50, 100, 200, 300]) {
      const name = `R${round}-${wait}`
      // (a desk made in the menu goes to its own page with the menu shut: that page is waited for first)
      if (made.length > 1) await A.until(`new URLSearchParams(location.search).get('desk') && document.getElementById('brand-doors')?.hidden !== false`, 'the page of the desk made before', 5000).catch(() => {})
      if (await A.js("return document.getElementById('brand-doors')?.hidden !== false")) { await A.click('.desk-switch-open'); await A.until("document.getElementById('brand-doors')?.hidden === false", 'the menu open') }
      // (the menu's list already holds the desk made before: no redraw of it comes between the press and the line)
      await A.until(`document.querySelector('#desk-add')?.getClientRects().length && ${has(made.at(-1))}`, 'the menu\'s New Desk, with the desk made before listed')
      // (the menu scrolls to the desk in view as it opens: New Desk is pressed once it stands still, or a quick press
      //  lands on the row that scrolled under it)
      for (let i = 0, was = ''; i < 20; i++) { const at = await A.js("const r = document.querySelector('#desk-add').getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.y)}`"); if (at === was) break; was = at; await sleep(80) }
      await A.click('#desk-add')
      await A.until("document.activeElement?.matches('.menu-desk-field')", 'the field for the new desk\'s name')
      await A.session.send('Input.insertText', { text: name })
      await A.key('Enter', 13)
      await arrives(B, has(name), `the desk ${name} in the second profile's menu`)
      made.push(name)
      if (wait) await sleep(wait)
      await B.reload()
      await ui.live(B, 'live after the reload', 40000)
      await sleep(1200)
      const menu = await B.js("return [...document.querySelectorAll('#menu-desk-rows a.menu-desk b')].map(b => b.textContent)")
      const gone = made.filter(n => !menu.includes(n))
      if (gone.length) lost.push(`reload ${wait} ms after ${name} arrived: missing ${gone.join(', ')}`)
    }
    note(`${made.length - 1} desks made, the second profile loaded again after each`)
    check(!lost.length, 'every desk made so far is in the second profile\'s menu after every reload', lost)
    await A.key('Escape', 27)
  }],

  ['an idle device loaded again three times seals nothing: the room\'s change number stays where it was', async ctx => {
    const B = await ctx.profile('B')
    if (!ctx.joined) throw skip('the second profile did not join')
    const at = async () => { await ui.live(B, 'live', 40000); await sleep(2000); return B.js('return trommi.client.model.room.last_envelope_number') }
    const seen = [await at()]
    for (let i = 0; i < 3; i++) { await B.reload(); seen.push(await at()) }
    ctx.run.check(seen.every(n => n === seen[0]), 'last_envelope_number is the same after each of three reloads', seen)
  }],

  ['Settings → Devices lists two devices on both profiles', async ctx => {
    if (!ctx.joined) throw skip('the second profile did not join')
    for (const name of ['A', 'B']) {
      const P = await ctx.profile(name)
      await ui.openSettingsPage(P, 'devices')
      await P.until("document.querySelectorAll('.room-device').length === 2", `two devices listed on ${name}`, 30000).catch(() => {})
      const listed = await P.js("return [...document.querySelectorAll('.room-device')].map(d => d.innerText.replace(/\\n+/g, ' / '))")
      ctx.run.check(listed.length === 2, `${name} lists two devices`, listed)
    }
    await (await ctx.profile('A')).shot('real-12-devices')
  }],

  ['two tabs of the first profile: the first owns the device, the second follows; the owner closed, the follower takes over, live', async ctx => {
    const { check } = ctx.run
    const A = await ctx.profile('A')
    const A2 = await ctx.profiles.A.tab(`${ctx.app.origin}/`)
    await ui.live(A2, 'the second tab live', 40000)
    const roles = [await A.js('return trommi.client.tabRole'), await A2.js('return trommi.client.tabRole')]
    check(roles.join() === 'leader,follower', 'owner and follower', roles)
    await A.close()
    ctx.profiles.A.page = A2
    await A2.until("trommi.client.tabRole === 'leader' && trommi.client.model.room.connection === 'live'", 'the follower owns the device and is live', 40000)
    await firstDesk(A2)
    await arrives(A2, noteIs(ctx.note), 'the tab that took over shows the note')
  }],

  ['the MLS proof screen (Settings → MLS proof) runs the core\'s self test and says OK', async ctx => {
    const A = await ctx.profile('A')
    await ui.openSettingsPage(A, 'proof')
    const line = "document.querySelector('main')?.innerText.trim().split('\\n').find(l => /^(OK|FAIL)/.test(l))"
    await A.until(line, 'the proof\'s result', 60000)
    const first = await A.js(`return ${line}`)
    ctx.run.check(first.startsWith('OK'), 'the first line says OK', first)
    await A.shot('real-13-mls-proof')
  }],

  // (There is no agent in this run: the connector is not here, and nothing else is a real agent device. The invite
  // is made, and that is all that is shown.)
  ['an agent invite is made: its page shows the connect command with a join link (no agent joins: none is here)', async ctx => {
    const A = await ctx.profile('A')
    await ui.openSettings(A)
    await A.click('#settings-invite-agent')
    await arrives(A, "location.pathname.startsWith('/pair/') && document.querySelector('[data-state=open] .clip-copy[data-line=connect] code')", 'the agent invite page')
    const command = await A.js("return document.querySelector('[data-state=open] .clip-copy[data-line=connect] code').textContent")
    ctx.run.check(/'http\S+\/join#v2\.[^']+'/.test(command), 'the connect command carries a join link', command.replace(/#v2\.\S+/, '#v2.…'))
    await A.shot('real-14-agent-invite')
  }],

  ['log in with the password on fresh profiles (joins with the recovery code, 8.4), five times: each lands on the Desk, live, and reads the note', async ctx => {
    const { check, note } = ctx.run
    const TRIES = 5, stuck = []
    await ctx.within('C0', async C => {
      await ui.logIn(C, ctx.app.start(), ctx.email, `${ctx.password}-wrong`)
      await C.until("document.querySelector('#ob-error')?.textContent.trim()", 'the refusal of a wrong password', 30000)
      check(await C.js("return document.querySelector('#ob-error').textContent") === 'Wrong email or password.', 'a wrong password: "Wrong email or password."', await C.js("return document.querySelector('#ob-error').textContent"))
    })
    for (let i = 1; i <= TRIES; i++) {
      await ctx.within(`C${i}`, async C => {
        await ui.logIn(C, ctx.app.start(), ctx.email, ctx.password)
        const live = await C.until(ui.LIVE, 'live', 30000).then(() => true, () => false)
        if (!live) { stuck.push(`log-in ${i}: ${JSON.stringify(await held(C))}; the screen: ${await C.js("return document.body.innerText.replace(/\\s*\\n\\s*/g, ' | ').slice(0, 160)").catch(() => '?')}`); await C.shot(`real-15-login-stuck-${i}`); return }
        if (i > 1) return
        await firstDesk(C)
        await arrives(C, noteIs(ctx.note), 'the note on the device that logged in', 60000)
        await C.shot('real-15-password-login')
      })
    }
    note(`${stuck.length} of ${TRIES} log-ins were not live within 30 s`)
    check(!stuck.length, 'every log-in went live', stuck)
  }],

  ['log out (Settings → Account → Log Out) on the second profile: the welcome screen, nothing of the device left; log in again', async ctx => {
    const { check, note } = ctx.run
    const B = await ctx.profile('B')
    if (!ctx.joined) throw skip('the second profile did not join')
    await ui.logOut(B)
    const said = await B.js("return document.getElementById('logged-out')?.textContent ?? null")
    check(typeof said === 'string' && said.startsWith('Logged out.'), 'the welcome screen says "Logged out."', said)
    note(`the screen says: "${said}"`)
    const stored = await ui.storedCount(B)
    check(stored.records <= 1 && stored.local === 0, 'nothing stored but the wrapping key', stored)
    await ui.logIn(B, ctx.app.start(), ctx.email, ctx.password)
    await ui.live(B, 'logged in again with the password', 60000)
  }],

  ['forgot password with the Emergency Kit words on a fresh profile (8.7): a new password, the NEW kit, the Desk with the note; the other devices are removed', async ctx => {
    const { check, note } = ctx.run
    const next = 'a brand new password 4711'
    let outcome = null
    await ctx.within('E', async E => {
      await E.go(ctx.app.start())
      await E.until("document.querySelector('#way-login')", 'the welcome screen')
      await E.click('#way-login')
      await E.until("document.querySelector('#way-forgot')", 'the login screen')
      await E.click('#way-forgot')
      await E.until("document.querySelector('#forgot-form')", 'the forgot password screen')
      await E.type('#forgot-form input[name=account]', ctx.email)
      await E.type('#forgot-form textarea[name=words]', ctx.words)
      await E.type('#forgot-form input[name=password]', next)
      await E.click('#forgot-form button[type=submit]')
      await E.until("document.querySelector('#kit-gate[open] #kit-done') || document.querySelector('#ob-error')?.textContent.trim()", 'the new kit, or a refusal', 60000).catch(() => {})
      outcome = await E.js("return document.querySelector('#kit-gate #kit-done') ? 'kit' : document.querySelector('#ob-error')?.textContent.trim() ? 'refused: ' + document.querySelector('#ob-error').textContent.trim() : 'no answer after 60 s; the button says \"' + (document.querySelector('#forgot-form button[type=submit]')?.textContent.trim() ?? '?') + '\"'")
      await E.shot('real-16-forgot-password')
      check(outcome === 'kit', 'the screen goes on to the new kit', outcome)
      if (outcome !== 'kit') return
      const words = await ui.takeKit(E)
      check(words.split(' ').length === 12 && words !== ctx.words, 'a NEW kit of twelve words is shown')
      await ui.live(E, 'the recovered profile live', 60000)
      await firstDesk(E)
      const whole = await E.until(noteIs(ctx.note), 'the note on the recovered profile', 30000).then(() => true, () => false)
      check(whole, 'the recovered profile shows the note as it stood (its last version)', { shows: await E.js(`return document.querySelector(${q(NOTE)})?.value ?? null`), stood: ctx.note, holds: await held(E) })
      const refused = await E.js("return trommi.client.model.alerts.map(x => x.code + ': ' + x.message.slice(0, 100)).filter(x => !x.startsWith('recovery'))")
      check(!refused.some(x => x.startsWith('forbidden')), 'no "forbidden" alert on the recovered profile', refused)
      if (refused.length) note(`alerts on the recovered profile: ${refused.join(' · ')}`)
      await ui.openSettingsPage(E, 'devices')
      const listed = await E.js("return document.querySelectorAll('.room-device').length")
      check(listed === 1, 'Devices on the recovered profile lists this device alone', listed)
      await E.shot('real-17-after-recovery')
    })
    // the other human devices are out (8.7)
    for (const name of ['A', 'B']) {
      const P = ctx.profiles[name]?.page
      if (!P) continue
      const out = await P.until("trommi.client.model.room.connection === 'removed'", `${name} learns it was removed`, 30000).then(() => true, () => false)
      check(out === (outcome === 'kit'), `${name} is ${outcome === 'kit' ? 'removed' : 'not removed'}`, await held(P))
      note(`${name} (removed) shows: ${await P.js("return document.body.innerText.replace(/\\s*\\n\\s*/g, ' | ').slice(0, 200)")}`)
      await P.shot(`real-18-removed-${name}`)
      if (outcome === 'kit' && out) {
        // only after the device processed its removal: the notice, and nothing of the app left in this profile
        const screen = await P.until("document.querySelector('#removed-said')", `${name}'s removed screen`, 15000).then(() => true, () => false)
        const left = await ui.storedCount(P).catch(() => null)
        check(screen && left?.records === 0 && left?.local === 0, `${name} shows the removed screen and keeps nothing`, left)
      }
    }
    // which password opens the account now, asked of the app on a fresh profile each
    const opens = {}
    for (const [name, password] of [['new', next], ['old', ctx.password]]) {
      await ctx.within(`F-${name}`, async F => {
        await ui.logIn(F, ctx.app.start(), ctx.email, password)
        await F.until(`(${ui.LIVE}) || document.querySelector('#ob-error')?.textContent.trim()`, 'the Desk, or a refusal', 60000)
        opens[name] = await F.js(`return Boolean(${ui.LIVE})`)
      })
    }
    check(opens.new === (outcome === 'kit') && opens.old !== opens.new, 'the password is replaced exactly if the screen finished', opens)
  }],

  ['over the whole run: no Content-Security-Policy violation, no uncaught error in a page or a worker', async ctx => {
    const { check, note } = ctx.run
    for (const name of Object.keys(ctx.profiles)) { const v = await ctx.profiles[name].page.violations(); check(!v.length, `${name}: no violation on its last page`, v) }
    check(!ctx.seen.csp.length, 'no policy violation was reported', ctx.seen.csp)
    check(!ctx.seen.exceptions.length, 'no uncaught error', ctx.seen.exceptions)
    check(ctx.app.policy.includes("connect-src 'self' https://hub.trommi.com;"), 'the policy served is the app\'s own', ctx.app.policy)
    const old = ctx.seen.requests.filter(r => new URL(r.url).pathname.startsWith('/v1/'))
    check(ctx.seen.requests.some(r => new URL(r.url).pathname.startsWith('/v2/')) && !old.length, 'no request to a /v1/ address (pages and workers; /v2/ requests were seen)', [...new Set(old.map(r => `${r.method} ${new URL(r.url).pathname} → ${r.status ?? r.failed}`))])
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
