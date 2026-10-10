// standin.mjs: the web app end to end in headless Chromium, against the FAKE hub.
//   node tests/web/e2e/standin.mjs          (or: node tests/web/e2e/run.mjs standin)
//
// WHAT IS REAL: the built app (app/web/dev/build.mjs `generate()`: index.html, the views, the page's chunks, the
// proof worker, the .wasm, the _headers with the app's Content-Security-Policy), the app's worker entry
// (app/web/core/core-worker.ts with tabs.ts, engine.ts, client.ts, room.ts, account.ts, hub.ts, store-idb.ts),
// IndexedDB, Web Locks, BroadcastChannel, several browser profiles and tabs; and the WHOLE core: the Rust core's
// binding does everything, stored content and invites included (real envelopes, encrypted and signed).
// WHAT IS NOT: the hub is tests/web/stand-in/hub.mjs: it checks NO cryptography and cannot read MLS. So that it
// learns who a Commit adds or removes, the ONE worker file is bundled with standin-core.ts in the place of
// core-wasm.ts (harness.mjs standInWorker): the real binding with a trailer of facts appended to its Commits and
// founding GroupInfos (tests/web/stand-in/core.ts), nothing else. The agent is tests/web/stand-in/agent.ts on the
// real binding in this Node process, not the connector. Nothing here is evidence about what the real hub accepts:
// real.mjs runs against the real hub, without an agent.
//
// The hub is reached through the app's own origin (harness.mjs serveApp passes /v1/ on): the app's policy is
// untouched (`connect-src 'self'`). The fake hub compares the address a device signed its sign-in for with its own:
// its HubAuth reader is told that the app's origin is this hub (HUB_AUTH below), nothing else is bent.
//
// The steps follow a person: every action is a click or typed text on the real screens, and what is asserted is
// what is on screen and what the fake hub's request log holds. A step that fails does not stop the run.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { startFakeHub } from '../stand-in/hub.mjs'
import { hubReaders } from '../stand-in/core.ts'
import { AgentStandIn } from '../stand-in/agent.ts'
import { rooms, storage } from '../client/helpers.mjs'
import { buildApp, main, openProfile, run, serveApp, sleep, standInWorker, TMP, until, watch } from './harness.mjs'
import * as ui from './ui.mjs'

const q = s => JSON.stringify(s)

export async function setUp() {
  const dir = await buildApp('standin-dist')
  const worker = await standInWorker(dir)
  let hubUrl = null
  const app = await serveApp(dir, () => hubUrl)
  // HUB_AUTH: the device signs for the address it reaches the hub at, which is the app's origin
  const hubAuth = bytes => { const a = hubReaders.hubAuth(bytes); return a.hub === app.origin ? { ...a, hub: hubUrl } : a }
  const fake = await startFakeHub({ readers: { ...hubReaders, hubAuth } })
  hubUrl = fake.url
  const ctx = {
    dir, worker, app, fake, seen: watch(), run: run('real core + fake hub'), profiles: {}, commands: [],
    email: `e2e+${Date.now().toString(36)}@example.org`,
    /** A browser profile by name, opened on first use. */
    async profile(name, opts) { return (ctx.profiles[name] ??= await openProfile(name, ctx.seen, opts)).page },
    async closeProfile(name) { await ctx.profiles[name]?.close().catch(() => {}); delete ctx.profiles[name] },
    /** A profile for one step: opened, handed to `fn`, and closed whatever happens (a device left running after a
     *  failed step would go on acting in the room). */
    async within(name, fn) { try { return await fn(await ctx.profile(name)) } finally { await ctx.closeProfile(name) } },
    /** The hub's log from a mark on: `const since = ctx.mark()` … `since()`. */
    mark() { const from = fake.requests.length; return () => fake.requests.slice(from) },
  }
  return ctx
}
export async function tearDown(ctx) {
  for (const name of Object.keys(ctx.profiles)) await ctx.closeProfile(name)
  await ctx.agent?.stop().catch(() => {})
  await ctx.app.close().catch(() => {})
  await ctx.fake.close().catch(() => {})
}

/** An agent stand-in joins by the invite link `link`; `confirm(code)` is the human's part (compare, press). */
async function joinAgent(ctx, link, confirm, label = 'agent') {
  const R = await rooms({ agent: true })
  const joining = R.joinRoom({ link, storage: storage(label), poll_ms: 50, device_name: label })
  await confirm(await joining.check_code)
  const client = await joining.client
  const agent = new AgentStandIn(client)
  await client.start()
  await client.settle()
  return agent
}
/** The posts of the log that carry a write of a device (no reads, no sign-in). */
/** The stand-in's envelopes among the posts of a log (they are plain JSON: tests/web/stand-in/core.ts). */
const envelopes = log => log.filter(r => r.method === 'POST' && r.path === '/v1/envelopes' && r.body?.envelope).map(r => ({ ...hubReaders.envelope(new Uint8Array(Buffer.from(r.body.envelope, 'base64url'))), status: r.status, dropped: r.dropped }))
const idOf = hex => Buffer.from(hex, 'hex').toString('base64url')
/** The envelopes of `kind` bound to the object `object_id` (hex). */
const about = (log, kind, object_id) => envelopes(log).filter(e => e.kind === kind && e.object?.object_id === idOf(object_id))
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
/** Opens the session's page from the sidebar. */
async function openSession(page) {
  await page.click('#agents a.agent-entry')
  await page.until("document.querySelector('#session form.composer textarea')", 'the session page')
}
/** Types a message into the session's composer and sends it with the send button. */
async function sendChat(page, text) {
  await page.type('#session form.composer textarea', text)
  await page.click('#session form.composer button.send')
}
const writes = log => log.filter(r => r.method !== 'GET' && !/\/(tokens|challenge)$/.test(r.path))

export const steps = [
  ['sign up: e-mail + generated password → the Emergency Kit (words shown once) → the empty Desk', async ctx => {
    const { check } = ctx.run
    const A = await ctx.profile('A')
    const since = ctx.mark()
    ctx.password = await ui.signUp(A, ctx.app.start(), ctx.email)
    check(await A.js("return document.querySelector('#kit-done').disabled && [...document.querySelectorAll('#kit-words li')].every(l => !l.textContent.trim())"), 'the kit is hidden and Open Trommi waits until it was shown')
    check(await A.js("return document.querySelector('#kit-gate').textContent.includes('your account is lost. Nobody can recover it')"), 'the kit screen says what it is for')
    await A.shot('standin-01-kit-hidden')
    ctx.words = await ui.takeKit(A)
    check(ctx.words.split(' ').length === 12, 'twelve words', ctx.words.split(' ').length)
    await ui.live(A)
    check(await A.js("return document.title === 'Personal · Trommi' && !!document.querySelector('#desk-invite-go') && !document.querySelector('.inbox-row')"), 'the empty Desk with "Invite your first agent"')
    const desks = await A.until("[...trommi.client.model.human.desks].filter(([, v]) => v).length === 1", 'the account\'s first desk', 15000).then(() => A.js("return JSON.stringify([...trommi.client.model.human.desks].filter(([, v]) => v).map(([id, v]) => [id, v.name]))"), () => 'none')
    check(desks === '[["main","Personal"]]', 'a new account has one desk, "Personal"', desks)
    check(await A.js("return !document.body.innerText.includes(" + q(ctx.words.split(' ')[0] + ' ' + ctx.words.split(' ')[1]) + ")"), 'the kit words are not on screen any more')
    await A.shot('standin-02-empty-desk')
    const log = since()
    const founding = log.filter(r => r.method === 'POST' && r.path === '/v1/rooms')
    check(founding.length === 1 && founding[0].status === 200, 'the hub saw one founding', founding.map(r => r.status))
    check(founding[0]?.body?.account?.email === ctx.email || JSON.stringify(founding[0]?.body ?? {}).includes(ctx.email), 'the founding carries the account')
    check(log.some(r => r.path === '/v1/stream' && r.status === 200), 'the live stream is open')
    check(await A.js('return trommi.client.tabRole') === 'leader', 'this tab owns the device')
  }],

  ['an agent stand-in joins through an agent invite made in the UI; its first question is on the Desk', async ctx => {
    const { check } = ctx.run
    const A = await ctx.profile('A')
    await A.click('#desk-invite-go')
    await A.until("location.pathname.startsWith('/pair/') && document.querySelector('[data-state=open] .clip-copy')", 'the agent invite page')
    const command = await A.js("return document.querySelector('[data-state=open] .clip-copy[data-line=connect] code').textContent")
    const link = /'(http\S+\/join#v1\.[^']+)'/.exec(command)?.[1]
    check(Boolean(link), 'the page shows the connect command with the invite link', command.slice(0, 60))
    ctx.firstLink = link; ctx.firstInvite = await A.js("return location.pathname.split('/').pop()")
    // Exactly two lines to copy, in this order: install (once per machine; it sets up Claude Code and Codex), then the
    // slash command with the link, pasted into claude in the project folder; what a press copies is what the line shows.
    const lines = await A.js("return [...document.querySelectorAll('[data-state=open] .clip-copy')].map(b => ({ line: b.dataset.line, shown: b.querySelector('code').textContent, copied: b.dataset.inviteClipTextParam }))")
    check(JSON.stringify(lines.map(l => [l.line, l.shown])) === JSON.stringify([
      ['install', 'curl -fsSL https://raw.githubusercontent.com/trommi/trommi/main/install.sh | sh'],
      ['connect', `/trommi:connect '${link}'`],
    ]), 'the invite page shows the two lines: install, /trommi:connect with the link', lines.map(l => l.line))
    check(lines.every(l => l.copied === l.shown), 'each line copies what it shows')
    const steps = await A.js("return [...document.querySelectorAll('[data-state=open] .clip-step > .clip-step-body > b')].map(b => b.textContent)")
    check(JSON.stringify(steps) === JSON.stringify(['First time on this computer? Install:', 'In your project folder, start claude (or codex) and paste:', 'Compare the six emoji Claude shows with the ones here']), 'the invite page has the three steps', steps)
    check(await A.js("return !document.body.innerText.includes('trommi-connector setup')"), 'no separate setup line any more')
    await A.shot('standin-03-agent-invite')
    const since = ctx.mark()
    ctx.agent = await joinAgent(ctx, link, async code => {
      await A.until("document.querySelector('[data-state=confirm_code] .clip-ask .check-emoji')", 'the six emoji of the agent on the invite page')
      const shown = await ui.emoji(A, '[data-state=confirm_code] .clip-ask')
      const { checkEmoji } = await import('../../../app/web/core/check-emoji.ts')
      check(shown === checkEmoji(code).map(e => e.emoji).join(' '), 'the page shows the six emoji the agent was given', shown)
      check(!writes(since()).some(r => /\/commits$/.test(r.path)), 'nobody is added before "They match"')
      await A.shot('standin-04-agent-emoji')
      await A.click('[data-state=confirm_code] .clip-ask .check-yes')
    })
    ctx.agent.onCommand = c => ctx.commands.push(c)
    await A.until("document.querySelector('[data-state=joined]')", 'the invite page says the agent is in', 20000)
    await ctx.agent.setRegister('profile', { model: 'claude-opus-5-5', task: 'End to end', agent_name: 'night-agent' })
    await ui.openDesk(A)
    await A.until("[...document.querySelectorAll('#agents a.agent-entry')].some(a => a.textContent.includes('night-agent'))", 'the session in the sidebar under its name')
    ctx.first = await ctx.agent.askCard({ title: 'Which database?', body: 'Asked before the second device joined.', options: [{ key: 'pg', label: 'Postgres' }, { key: 'lite', label: 'SQLite' }] })
    await A.until(`document.getElementById('row-${ctx.first}')`, 'the first question on the Desk')
    check(await A.js("return !document.querySelector('#desk-invite-go')"), '"Invite your first agent" is gone')
  }],

  ['"New Agent…" after the agent joined: a fresh link, its own part in view, the used one never shown as open again', async ctx => {
    const { check } = ctx.run
    const A = await ctx.profile('A')
    await ui.openDesk(A)
    await A.click('#sidebar-invite')
    await A.until(`location.pathname.startsWith('/pair/') && !location.pathname.endsWith('/${ctx.firstInvite}') && document.querySelector('[data-state=open] .clip-copy[data-line=connect] code')`, 'a new agent invite page')
    const command = await A.js("return document.querySelector('[data-state=open] .clip-copy[data-line=connect] code').textContent")
    const link = /'(http\S+\/join#v\d+\.[^']+)'/.exec(command)?.[1]
    check(Boolean(link) && link !== ctx.firstLink, 'a different link than the one the agent joined with', command.slice(-30))
    const own = await A.js("const e = document.querySelector('[data-state=open] .clip-link-own'); const r = e?.getBoundingClientRect(), box = e?.closest('code').getBoundingClientRect(); return e ? { text: e.textContent, seen: r.width > 0 && r.bottom <= box.bottom + 1 } : null")
    check(own && link.endsWith(own.text.replace(/'$/, '')) && own.seen, "the link's own part (secret, deadline) is in view", own)
    const shared = await A.js("const e = document.querySelector('[data-state=open] .clip-link-same'); return e ? e.getBoundingClientRect().width : -1")
    check(shared >= 0 && shared < 40, 'what every link of the account shares is folded into an ellipsis', shared)
    check(await A.js("return /The link works once · (\\d+ more min\\.|less than a minute\\.)/.test(document.querySelector('.clip-note').textContent)"), 'the page says how long the link still works')
    await A.shot('standin-04b-fresh-invite')
    const was = await A.js(`return trommi.client.model.invites.get('${ctx.firstInvite}')?.invite_state ?? 'gone'`)
    check(was === 'joined' || was === 'gone', 'the used invite is not open any more', was)
    await ui.openDesk(A)
  }],

  ['renamed, then hidden while it was away: the connected session is one row under its new name, and stays', async ctx => {
    const { check } = ctx.run
    const A = await ctx.profile('A')
    await ui.openDesk(A)
    const rows = () => A.js("return [...document.querySelectorAll('#agents .agent-row[data-unit]')].map(r => r.querySelector('strong')?.textContent)")
    const sid = await A.js("return [...trommi.client.model.sessions.values()].find(s => s.group_id && !s.parent_session_id).session_id")
    const id = await A.js("return document.querySelector('#agents .agent-row[data-unit]').dataset.unit")
    const edit = fields => A.js(`const r = await fetch('/sessions/${id}/edit', { method: 'POST', headers: { accept: 'text/vnd.turbo-stream.html' }, body: new URLSearchParams(${JSON.stringify({ stay: '1', ...fields })}) }); return r.status`)
    // the app's Rename (the session's More menu): the human register session/<id> { name }
    check(await edit({ label: 'Trommi' }) === 200, 'the rename is taken')
    await A.until("[...document.querySelectorAll('#agents .agent-row[data-unit] strong')].some(s => s.textContent === 'Trommi')", 'the new name in the sidebar')
    check(JSON.stringify(await rows()) === '["Trommi"]', 'one row, under the new name', await rows())
    // its agent is connected (the fake hub tells no presence by itself: the event the real hub sends)
    const room = ctx.fake.state.rooms.values().next().value
    const device = Buffer.from(await A.js(`return trommi.client.model.sessions.get('${sid}').agent_device_id`), 'hex').toString('base64url')
    ctx.fake.push(room.room_id, `event: presence\ndata: ${JSON.stringify({ device, online: true, hears: true })}\n\n`)
    await A.until(`trommi.client.model.sessions.get('${sid}').is_online`, 'the session connected')
    // the archived mark that Archive or Delete leaves while the agent is away; its agent is connected now. As on the
    // owner's room, the hub did not archive the group (it stays live): only the human register hides it.
    ctx.fake.faults.add({ method: 'POST', path: /\/archive$/, refuse: { error: 'forbidden', status: 403 }, times: 5 })
    await A.js(`await trommi.client.setRegisters({ ['session/${sid}']: { ...(trommi.client.model.human.session_settings.get('${sid}') ?? {}), archived: true } })`)
    await A.until(`trommi.client.model.human.session_settings.get('${sid}')?.archived === true`, 'the archived mark in the model')
    await sleep(500)
    check(JSON.stringify(await rows()) === '["Trommi"]', 'the connected session stays in the sidebar, one row', { rows: await rows(), session: await A.js(`const s = trommi.client.model.sessions.get('${sid}'); return { online: s.is_online, active: s.is_active, parent: s.parent_session_id, group_archived: s.group_archived, settings: s.settings }`) })
    ctx.fake.faults.clear()
    await A.js(`await trommi.client.setRegisters({ ['session/${sid}']: { ...trommi.client.model.human.session_settings.get('${sid}'), archived: false, name: '' } })`)
    await A.until("[...document.querySelectorAll('#agents .agent-row[data-unit] strong')].some(s => s.textContent === 'night-agent')", 'its own name again')
  }],

  // (regression: before 4933dc3 the engine took the binding's `not-found` for a hub's refusal whenever the stream
  // showed the device its own Commit before the post's answer was handled, and stalled 30 s on it)
  ['the engine is not halted after the Commits so far (no "chain-halted" alert, nothing blocked)', async ctx => {
    const A = await ctx.profile('A')
    const state = await A.js("return { blocked: trommi.client.model.room.outbox_blocked, alerts: trommi.client.model.alerts.map(a => a.code + ': ' + a.message) }")
    ctx.run.check(state.blocked === null && !state.alerts.length, 'profile A: no alert, nothing blocked', state)
  }],

  ['a second profile opens a device invite link, "They don\'t match": the invite is burned, nobody is added', async ctx => {
    const { check } = ctx.run
    const A = await ctx.profile('A'), B = await ctx.profile('B')
    const link = await deviceInvite(A)
    const since = ctx.mark()
    await B.go(link)
    await B.until("document.getElementById('check-code')", 'six emoji on the new device')
    check(await B.js("return !location.hash && location.pathname === '/join'"), 'the join secret left the address bar', await B.js('return location.href'))
    await A.until("document.querySelector('#set-device[data-state=confirm_code] .check-emoji')", 'six emoji on the inviting device')
    const [a, b] = [await ui.emoji(A, '#set-device[data-state=confirm_code]'), await ui.emoji(B, '#check-code')]
    check(a === b && a.split(' ').length === 6, 'both show the same six emoji', { a, b })
    await A.click('#set-device[data-state=confirm_code] .check-no')
    await A.until("document.querySelector('#set-device[data-state=failed] .room-error')", 'the inviting device says it failed')
    check(await A.js("return document.querySelector('#set-device .room-error').textContent") === 'They did not match. Nobody was added; the code is used up.', 'the sentence on the inviting device')
    await B.until("document.querySelector('#scan-again') && document.querySelector('.ob-error.is-shown')", 'the new device says it is not logged in')
    check(await B.js("return document.querySelector('#ob-title').textContent") === 'Not logged in', 'the new device: "Not logged in"')
    await A.shot('standin-05-no-match-inviter')
    await B.shot('standin-06-no-match-newcomer')
    const log = since()
    check(!writes(log).some(r => /\/commits$/.test(r.path)), 'no Commit reached the hub: nobody was added', writes(log).map(r => `${r.method} ${r.path}`))
    check(log.some(r => r.method === 'DELETE' && /^\/v1\/invites\//.test(r.path) && r.status === 200), 'the invite was deleted at the hub')
    const stored = await ui.storedCount(B)
    // (the key that wraps a device's entries at rest is made before the first device and is never deleted: store-idb.ts)
    check(stored.records <= 1, 'the refused device stored nothing but its wrapping key', stored)
    await ui.openSettingsPage(A, 'devices')
    check(await A.js("return document.querySelectorAll('.room-device').length") === 2, 'Devices lists this device and the agent, no third', await A.js("return [...document.querySelectorAll('.room-device')].map(d => d.innerText.split('\\n')[0])"))
  }],

  ['the second profile joins by a new link: both show six equal emoji, "They match", it lands on the Desk with history', async ctx => {
    const { check } = ctx.run
    const A = await ctx.profile('A'), B = await ctx.profile('B')
    const link = await deviceInvite(A)
    // (opened as a new address: B stands on /join from the refused try, and an address that differs from the
    // page's only after the # does not load the page again; see the report, "a second link on the /join page")
    await B.go('about:blank')
    await B.go(link)
    await B.until("document.getElementById('check-code')", 'six emoji on the new device')
    await A.until("document.querySelector('#set-device[data-state=confirm_code] .check-emoji')", 'six emoji on the inviting device')
    const [a, b] = [await ui.emoji(A, '#set-device[data-state=confirm_code]'), await ui.emoji(B, '#check-code')]
    check(a === b && a.split(' ').length === 6, 'both show the same six emoji', { a, b })
    await A.shot('standin-07-match-inviter')
    await B.shot('standin-08-match-newcomer')
    await A.click('#set-device[data-state=confirm_code] .check-yes')
    await A.until("document.querySelector('#set-device[data-state=joined]')", 'the inviting device says the new device is in', 20000)
    await ui.live(B, 'the new device live')
    // (the inviter adds the newcomer to each session once its KeyPackages are at the hub; when it asks before they
    // are, it asks again 15 s later: engine.ts `heal_delay * 5`)
    const took = await B.until(`document.getElementById('row-${ctx.first}')`, 'the question asked before it joined, on its Desk', 60000)
    ctx.run.note(`the newcomer saw the session's history ${(took / 1000).toFixed(1)} s after it was live`)
    check(await B.js(`return document.querySelector('#row-${ctx.first} .inbox-question').textContent.includes('Which database?') && document.querySelector('#row-${ctx.first} .inbox-body-text').textContent.includes('before the second device joined')`), 'it reads the question\'s words (history)')
    await B.until("[...document.querySelectorAll('#agents a.agent-entry')].some(a => a.textContent.includes('night-agent'))", 'the session in its sidebar')
    await B.shot('standin-09-second-device-desk')
    await ui.openSettingsPage(A, 'devices')
    await A.until("document.querySelectorAll('.room-device').length === 3", 'three devices listed on A')
    await ui.openDesk(A)
  }],

  ['a decision card with options, urgency high: on both Desks; A opens it and answers; the agent hears it once; it leaves both', async ctx => {
    const { check } = ctx.run
    const A = await ctx.profile('A'), B = await ctx.profile('B')
    await ui.openDesk(A)
    await ui.openDesk(B)
    const card = await ctx.agent.askCard({ title: 'Ship tonight?', body: 'All tests are green.', options: [{ key: 'yes', label: 'Ship it' }, { key: 'no', label: 'Wait' }], recommended: 'yes' }, { urgency: 'high' })
    for (const P of [A, B]) await P.until(`document.getElementById('row-${card}')`, `the question on ${P.name}'s Desk`)
    check(await A.js(`const r = document.getElementById('row-${card}'); return r.dataset.urgency === 'high' && !!r.querySelector('.row-urg.is-knock') && [...r.querySelectorAll('button[name=key]')].map(b => b.value).join() === 'no,yes' || [...r.querySelectorAll('button[name=key]')].map(b => b.value).sort().join() === 'no,yes'`), 'the row knocks (urgency high) and offers both options')
    await A.shot('standin-10-desk-with-question')
    const since = ctx.mark(), before = ctx.commands.length
    await A.click(`#row-${card} a.inbox-text`)
    await A.until("document.querySelector('#cardpage .tc-opt[name=key][value=yes]')", 'the card page with its options')
    check(await A.js("return document.querySelector('#cardpage').innerText.includes('Ship tonight?') && document.querySelector('#cardpage').innerText.includes('All tests are green.')"), 'the card page shows title and body')
    await A.shot('standin-11-card-page')
    await A.click('#cardpage .tc-opt[name=key][value=yes]')
    await until(() => ctx.commands.slice(before).some(c => c.kind === 'answer' && c.object_id === card), 'the answer at the agent')
    for (const P of [A, B]) await P.until(`!document.getElementById('row-${card}')`, `the question gone from ${P.name}'s Desk`)
    await sleep(1200)
    const heard = ctx.commands.slice(before).filter(c => c.object_id === card)
    check(heard.length === 1 && heard[0].kind === 'answer' && heard[0].choices.join() === 'yes', 'the agent\'s command callback fired exactly once, with "yes"', heard.map(c => [c.kind, c.choices]))
    const posted = about(since(), 'answer', card)
    check(posted.length === 1 && posted[0].status === 200, 'the hub took exactly one answer envelope', posted.map(e => e.status))
    await ctx.agent.closeCard(card, { close_summary: 'Shipped.' })
    ctx.answered = card
  }],

  ['an info card is read on A and leaves B; a permission request gets its verdict from B', async ctx => {
    const { check } = ctx.run
    const A = await ctx.profile('A'), B = await ctx.profile('B')
    await ui.openDesk(A)
    const info = await ctx.agent.askCard({ card_type: 'info', title: 'Build finished', body: 'Everything is green.' })
    const request = await ctx.agent.askPermission({ tool_name: 'Bash', description: 'Run the migration', input_preview: 'npm run migrate' })
    for (const P of [A, B]) await P.until(`document.getElementById('row-${info}') && document.getElementById('row-${request}')`, `the info and the request on ${P.name}'s Desk`)
    check(await A.js(`return document.getElementById('row-${info}').dataset.kind === 'info' && !!document.querySelector('#row-${info} .inbox-answer.is-ack')`), 'the info row has its tick')
    check(await B.js(`const r = document.getElementById('row-${request}'); return r.dataset.urgency === 'critical' && r.textContent.includes('Approval: Bash') && r.textContent.includes('npm run migrate')`), 'the request row names the tool and what it would run')
    await B.shot('standin-12-info-and-request')
    const since = ctx.mark(), before = ctx.commands.length
    await A.click(`#row-${info} .inbox-answer.is-ack`)
    for (const P of [A, B]) await P.until(`!document.getElementById('row-${info}')`, `the info gone from ${P.name}'s Desk`)
    await B.click(`#row-${request} button[name=key][value=allow]`)
    await until(() => ctx.commands.slice(before).some(c => c.kind === 'verdict' && c.object_id === request), 'the verdict at the agent')
    for (const P of [A, B]) await P.until(`!document.getElementById('row-${request}')`, `the request gone from ${P.name}'s Desk`)
    await sleep(800)
    const verdicts = ctx.commands.slice(before).filter(c => c.object_id === request)
    check(verdicts.length === 1 && verdicts[0].allow === true, 'the agent got one verdict: allow', verdicts.map(c => [c.kind, c.allow]))
    check(about(since(), 'verdict', request).length === 1, 'the hub took exactly one verdict envelope')
  }],

  ['chat in the session, both directions, on both profiles; a work trail whose steps appear and whose turn ends', async ctx => {
    const { check } = ctx.run
    const A = await ctx.profile('A'), B = await ctx.profile('B')
    await openSession(A)
    await openSession(B)
    const before = ctx.commands.length
    await sendChat(A, 'Please start with the schema.')
    await A.until("[...document.querySelectorAll('#session .msg-user')].some(m => m.innerText.includes('Please start with the schema.'))", 'the message in A\'s chat')
    await until(() => ctx.commands.slice(before).some(c => c.kind === 'message' && c.body?.text === 'Please start with the schema.'), 'the message at the agent')
    await B.until("[...document.querySelectorAll('#session .msg-user')].some(m => m.innerText.includes('Please start with the schema.'))", 'the message in B\'s chat')
    const turn = crypto.randomBytes(16).toString('hex')
    await ctx.agent.workStep(turn, 1, { text: 'reading the schema', tool: 'Read' })
    await ctx.agent.workStep(turn, 2, { text: 'I will write the migration next.' })
    await ctx.agent.workStep(turn, 3, { text: 'writing the migration', tool: 'Edit' })
    for (const P of [A, B]) await P.until("document.querySelector('#session .msg-work.is-running') && document.querySelectorAll('#session .msg-work .work-list > li').length === 3", `three steps of the running turn on ${P.name}`)
    check(await A.js("return [...document.querySelectorAll('#session .msg-work .work-list > li')].map(l => l.className.split(' ')[0]).join()") === 'work-step,work-say,work-step', 'two tool steps and what the agent said between them, in order')
    await A.click('#session .msg-work summary.work-head')
    await A.shot('standin-13-work-trail-running')
    // (a turn ends with its agent's answer: a Chat message marked `terminal: 'answer'`, model.ts)
    await ctx.agent.say({ text: 'The migration is written.', terminal: 'answer' })
    for (const P of [A, B]) {
      await P.until("[...document.querySelectorAll('#session .msg-agent')].some(m => m.innerText.includes('The migration is written.'))", `the agent's answer on ${P.name}`)
      await P.until("document.querySelector('#session .msg-work.is-done') && !document.querySelector('#session .msg-work.is-running')", `the turn ended on ${P.name}`)
    }
    check(await A.js("return [...document.querySelectorAll('#session .msg-agent .msg-name')].at(-1)?.textContent") === 'night-agent', 'the agent\'s words stand under the session\'s name')
    await sendChat(B, 'Thanks, from the second device.')
    await until(() => ctx.commands.slice(before).some(c => c.kind === 'message' && c.body?.text === 'Thanks, from the second device.'), 'B\'s message at the agent')
    await A.until("[...document.querySelectorAll('#session .msg-user')].some(m => m.innerText.includes('Thanks, from the second device.'))", 'B\'s message in A\'s chat')
    await sleep(600)
    const heard = ctx.commands.slice(before).filter(c => c.kind === 'message')
    check(heard.length === 2, 'the agent heard each message once', heard.map(c => c.body?.text))
    await A.shot('standin-14-session-chat')
  }],

  ['chat on a card, both directions', async ctx => {
    const { check } = ctx.run
    const A = await ctx.profile('A'), B = await ctx.profile('B')
    await ui.openDesk(A)
    await A.click(`#row-${ctx.first} a.inbox-text`)
    await A.until("document.querySelector('#cardpage form.tc-chat textarea.tc-field')", 'the card page with its chat field')
    const before = ctx.commands.length
    await A.type('#cardpage form.tc-chat textarea.tc-field', 'How big is the data?')
    await A.click('#cardpage form.tc-chat button.tc-send')
    await until(() => ctx.commands.slice(before).some(c => c.kind === 'message' && c.object_id === ctx.first && c.body?.text === 'How big is the data?'), 'the card message at the agent, bound to the card')
    await ctx.agent.say({ text: 'About two gigabytes.' }, ctx.first)
    if (!await A.js("return location.pathname.startsWith('/card/')")) { await ui.openDesk(A); await A.click(`#row-${ctx.first} a.inbox-text`) }
    await A.until("document.querySelector('#cardpage')?.innerText.includes('About two gigabytes.') && document.querySelector('#cardpage').innerText.includes('How big is the data?')", 'both messages in the card\'s chat on A')
    await A.shot('standin-15-card-chat')
    await ui.openDesk(B)
    await B.click(`#row-${ctx.first} a.inbox-text`)
    await B.until("document.querySelector('#cardpage')?.innerText.includes('About two gigabytes.') && document.querySelector('#cardpage').innerText.includes('How big is the data?')", 'both messages in the card\'s chat on B')
    check(ctx.commands.slice(before).filter(c => c.kind === 'message').length === 1, 'the agent heard the card message once')
  }],

  ['files: A attaches a picture of about 3 MiB to a message; B sees it and opens it large, its bytes are the same', async ctx => {
    const { check } = ctx.run
    const A = await ctx.profile('A'), B = await ctx.profile('B')
    const file = path.join(TMP, 'tmp', 'picture.png'), png = picture(1024, 1024)
    fs.writeFileSync(file, png)
    await ui.openDesk(A); await openSession(A)
    await ui.openDesk(B); await openSession(B)
    const before = ctx.commands.length, since = ctx.mark()
    await A.attach('#session form.composer input[type=file]', [file])
    await A.until("document.querySelector('#session form.composer .composer-files')?.children.length === 1", 'the picture as a chip in the composer')
    await sendChat(A, 'A picture for you.')
    await B.until("[...document.querySelectorAll('#session .msg-user')].some(m => m.innerText.includes('A picture for you.') && [...m.querySelectorAll('img')].some(i => i.complete && i.naturalWidth === 1024))", 'the message with its picture, decoded, on B', 40000)
    await B.shot('standin-16-picture-in-chat')
    await B.click('#session .msg-user a.shot')
    await B.until("[...document.querySelectorAll('img')].some(i => i.naturalWidth === 1024 && i.getBoundingClientRect().width > 400)", 'the picture large on B')
    const seenBytes = await B.js(`const i = [...document.querySelectorAll('img')].find(i => i.naturalWidth === 1024 && i.getBoundingClientRect().width > 400)
      const b = new Uint8Array(await (await fetch(i.currentSrc)).arrayBuffer()), h = new Uint8Array(await crypto.subtle.digest('SHA-256', b))
      return { size: b.length, sha256: [...h].map(x => x.toString(16).padStart(2, '0')).join('') }`)
    check(seenBytes.size === png.length && seenBytes.sha256 === sha256(png), `the bytes B shows are the ${png.length} bytes A attached`, seenBytes)
    await B.shot('standin-17-picture-large')
    const heard = await until(() => ctx.commands.slice(before).find(c => c.kind === 'message' && c.body?.attachments?.length === 1), 'the message with its attachment at the agent')
    // (the command carries the attachment as it travels; the stand-in's fetch takes the model's form)
    const sent = heard.body.attachments[0]
    check(sha256(await ctx.agent.fetch({ ...sent, attachment_id: Buffer.from(sent.file_id, 'base64url').toString('hex') })) === sha256(png), 'the agent fetches the same bytes')
    const uploads = since().filter(r => r.method === 'PUT' && /^\/v1\/files\//.test(r.path))
    check(uploads.length === 1 && uploads[0].status === 200, 'one upload reached the hub', uploads.map(r => r.status))
    await ui.openDesk(B)
  }],

  ['an Artifact from the agent is on the artifacts page; its share link opens in a signed-out profile and stops after "Stop sharing"', async ctx => {
    const { check } = ctx.run
    const A = await ctx.profile('A')
    const html = '<!doctype html><title>Report</title><h1>Quarterly report</h1><p>All green, says the agent.</p>'
    const ref = await ctx.agent.upload(new TextEncoder().encode(html), { file_name: 'report.html', media_type: 'text/html' })
    await ctx.agent.publish({ title: 'Quarterly report', attachments: [ref] })
    await ui.openDesk(A)
    await A.until("document.querySelector('#desk-artifacts .end-head')", 'the Artifacts pile at the Desk\'s foot')
    await A.click('#desk-artifacts .end-head')
    await A.until("location.pathname === '/artifacts' && [...document.querySelectorAll('#artifacts-list .art-item .art-t')].some(t => t.textContent === 'Quarterly report')", 'the Artifact on the artifacts page')
    await A.shot('standin-18-artifacts')
    const copy = '#artifacts-list .art-item .shr-copy'
    const at = await A.js(`const b = document.querySelector(${q(copy)}).getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]`)
    await A.mouse('mouseMoved', at[0], at[1], false)
    await A.session.send('Browser.grantPermissions', { origin: ctx.app.origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] })
    await A.click(copy)
    await A.until("document.querySelector('#artifacts-list .shr.is-on')", 'the tile says it is shared')
    check((await ui.said(A)).some(t => t.startsWith('Link copied')), 'the toast says "Link copied"', await ui.said(A))
    const link = await A.clipboard()
    check(/\/artifact\/[A-Za-z0-9_-]{22}#/.test(link), 'the clipboard holds a share link, its secret after the #', link.replace(/#.*/, '#…'))
    // a third, signed-out profile; the hub override travels in the query (in production the hub is fixed)
    await ctx.within('C', async C => {
    await C.go(link.replace('#', `?hub=${encodeURIComponent(ctx.app.origin)}#`))
    await C.until("document.querySelector('#share iframe, #share img, #share a[download]')", 'the shared page in the signed-out profile', 20000)
    check(await C.js('return document.title') === 'Shared · Trommi' && (await ui.storedCount(C)).records === 0, 'a share page of its own: no room, nothing stored')
    await C.shot('standin-19-share-page')
    await A.click('#artifacts-list .art-item details.art-share summary')
    await A.click('#artifacts-list .art-item .shr-stop')
    await A.until("!document.querySelector('#artifacts-list .shr.is-on')", 'the tile is not shared any more')
    await C.reload()
    await C.until("document.querySelector('#share .room-error')", 'the share page refuses after the revoke', 20000)
    check(await C.js("return document.querySelector('#share .room-error').textContent") === 'This link has expired or was withdrawn.', 'the sentence of a withdrawn link', await C.js("return document.querySelector('#share')?.innerText"))
    })
  }],

  ['Scribble Board: A draws, erases and moves strokes; B sees them live and again after a reload', async ctx => {
    const { check } = ctx.run
    const A = await ctx.profile('A'), B = await ctx.profile('B')
    for (const P of [A, B]) {
      await ui.openDesk(P)
      await P.key('p', 80)   // (the Desk's shortcut for its back, the Scribble Board)
      await P.until("location.pathname === '/scribble-board' && window.pad && document.getElementById('canvas')", `the board on ${P.name}`)
    }
    const box = await A.js("const b = document.getElementById('canvas').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }")
    const at = (fx, fy) => [box.x + box.w * fx, box.y + box.h * fy]
    /** A drag from one point of the canvas to another; `held` runs while the button is still down. */
    const drag = async (from, to, held = async () => {}) => {
      await A.mouse('mouseMoved', ...from, false)
      await A.mouse('mousePressed', ...from)
      for (let i = 1; i <= 12; i++) { await A.mouse('mouseMoved', from[0] + (to[0] - from[0]) * i / 12, from[1] + (to[1] - from[1]) * i / 12, true); await sleep(25) }
      await held()
      await A.mouse('mouseReleased', ...to)
    }
    const strokes = P => P.js("return pad.elements().filter(e => e.type === 'stroke').map(e => ({ id: e.id, x: Math.round(e.x), y: Math.round(e.y) }))")
    const sealed = () => A.until('!pad.state().sync.pending && !pad.state().sync.error', 'A\'s strokes sealed')
    const since = ctx.mark()
    await A.click('.pad-tool[data-tool=pen]')
    // the first stroke: B shows it while A still holds the pen down (stroke pieces, spec 7.2)
    let liveOnB = null
    await drag(at(0.3, 0.3), at(0.5, 0.3), async () => { await sleep(700); liveOnB = await B.js('return pad.elements().length') })
    await sealed()
    const pieces = since().filter(r => r.method === 'POST' && /^\/v1\/groups\/[^/]+\/messages$/.test(r.path) && r.body?.relay === true)
    check(pieces.length > 0 && pieces.every(r => r.status === 200), 'stroke pieces were relayed through the hub while drawing', pieces.length)
    check(liveOnB >= 1, 'B showed the stroke before A lifted the pen', liveOnB)
    await drag(at(0.3, 0.6), at(0.5, 0.6))
    await sealed()
    await B.until("pad.elements().filter(e => e.type === 'stroke').length === 2", 'two strokes on B')
    await B.shot('standin-20-board-two-strokes')
    // erase the first: the eraser dragged across it
    await A.click('.pad-tool[data-tool=eraser]')
    await drag(at(0.4, 0.22), at(0.4, 0.38))
    await sealed()
    await B.until("pad.elements().filter(e => e.type === 'stroke').length === 1", 'the erased stroke gone on B')
    // move the second: selected and dragged
    const before = (await strokes(A))[0]
    await A.click('.pad-tool[data-tool=select]')
    await drag(at(0.4, 0.6), at(0.6, 0.75))
    await sealed()
    const after = (await strokes(A))[0]
    check(after && before && after.id === before.id && after.x - before.x > 100 && after.y - before.y > 50, 'A moved the stroke', { before, after })
    await B.until(`(e => e.length === 1 && Math.abs(e[0].x - ${after?.x}) < 3 && Math.abs(e[0].y - ${after?.y}) < 3)(pad.elements().filter(e => e.type === 'stroke'))`, 'the stroke at its new place on B')
    await A.shot('standin-21-board-after')
    await B.reload()
    await B.until("document.documentElement.hasAttribute('data-ready') && window.pad", 'the board on B after a reload', 30000)
    await B.until(`(e => e.length === 1 && Math.abs(e[0].x - ${after?.x}) < 3 && Math.abs(e[0].y - ${after?.y}) < 3)(pad.elements().filter(e => e.type === 'stroke'))`, 'B after the reload: one stroke, where A put it', 20000)
    const reloaded = (await strokes(B))[0]
    if (reloaded.id !== after.id) ctx.run.note(`the stroke's id on the board is "${after.id}" where it was drawn and "${reloaded.id.replace(/^[0-9a-f]{56}/, '…')}" after a reload (read from the hub): the same stroke under two ids`)
    const loads = since().filter(r => r.method === 'GET' && /^\/v1\/boards\//.test(r.path))
    check(loads.length > 0, 'the board was read from the hub (snapshot and tail)', loads.length)
    for (const P of [A, B]) await ui.openDesk(P)
  }],

  ['notes: A writes one, B reads and edits it, A edits it again, A throws it away; gone on both', async ctx => {
    const { check } = ctx.run
    const A = await ctx.profile('A'), B = await ctx.profile('B')
    const field = '#corner-note-box .corner-note-field'
    const value = P => P.js(`return document.querySelector(${q(field)}).value`)
    const open = async P => { await P.click('#corner-note-box .corner-note-head'); await P.until("document.querySelector('#corner-note-box.is-open')", `the note open on ${P.name}`) }
    const fold = async P => { await P.key('Escape', 27); await P.until("!document.querySelector('#corner-note-box.is-open')", `the note folded on ${P.name}`) }
    const append = async (P, text) => { await P.click(field); await P.key('End', 35, 2); await P.session.send('Input.insertText', { text }) }
    const since = ctx.mark()
    await open(A)
    await A.type(field, 'Remember the backup.')
    await fold(A)
    await B.until(`document.querySelector('#corner-note-box.has-words') && document.querySelector(${q(field)}).value === 'Remember the backup.'`, 'the note on B')
    await open(B)
    await append(B, ' And the keys.')
    await fold(B)
    await A.until(`document.querySelector(${q(field)}).value === 'Remember the backup. And the keys.'`, 'B\'s edit on A')
    await open(A)
    await append(A, ' Done by Friday.')
    await A.shot('standin-22-note')
    await fold(A)
    await B.until(`document.querySelector(${q(field)}).value === 'Remember the backup. And the keys. Done by Friday.'`, 'A\'s second edit on B')
    await open(A)
    await A.click('#corner-note-box .corner-note-bin')
    for (const P of [A, B]) await P.until(`!document.querySelector('#corner-note-box.has-words') && document.querySelector(${q(field)}).value === ''`, `the note gone on ${P.name}`)
    const kinds = envelopes(since()).filter(e => e.object?.object_type === 'note').map(e => `${e.kind}:${e.object.object_state}`)
    check(kinds.length >= 4 && kinds.at(-1).endsWith(':closed'), 'the hub took the note\'s versions and its closing', kinds)
    check((await value(A)) === '' && (await value(B)) === '', 'both note fields are empty')
  }],

  // (regression: a note with pictures and no words, folded once and opened again, was not sent: folding it kept the
  // empty words and forgot the note's id, so Ctrl+Enter and the envelope did nothing; the envelope's "to <name>" label
  // was black on black: its colour was an undefined variable)
  ['notes: a note with only a pasted picture is sent to the crowned session with Ctrl+Enter; the envelope names it', async ctx => {
    const { check } = ctx.run
    const A = await ctx.profile('A')
    await ui.openDesk(A)
    const id = await A.js("return document.querySelector('#agents .agent-row[data-unit]').dataset.unit")
    check(await A.js(`const r = await fetch('/sessions/${id}/star', { method: 'POST', headers: { accept: 'text/vnd.turbo-stream.html' }, body: new URLSearchParams({ stay: '1', starred: '1' }) }); return r.status`) === 200, 'the session is given the crown')
    await A.until("document.querySelector('#corner-note-box .corner-note-send')", 'the note has an envelope (a crowned session)')
    await A.click('#corner-note-box .corner-note-head')
    await A.until("document.querySelector('#corner-note-box.is-open')", 'the note open')
    const png = picture(48, 48).toString('base64')
    await A.js(`const bytes = Uint8Array.from(atob(${q(png)}), c => c.charCodeAt(0)), dt = new DataTransfer()
      dt.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }))
      document.querySelector('#corner-note-box .corner-note-field').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))`)
    await A.until("document.querySelectorAll('#corner-note-box .corner-note-file.is-pic:not(.is-uploading)').length === 1", 'the pasted picture on the note')
    // folded and opened again, as a person does who looks elsewhere first
    await A.key('Escape', 27)
    await A.until("!document.querySelector('#corner-note-box.is-open')", 'the note folded')
    await sleep(800)
    await A.click('#corner-note-box .corner-note-head')
    await A.until("document.querySelector('#corner-note-box.is-open')", 'the note open again')
    const label = await A.js(`const b = document.querySelector('#corner-note-box .corner-note-send'), s = getComputedStyle(b, '::after'); return { content: s.content, color: s.color, background: s.backgroundColor, name: b.dataset.name }`)
    check(/^"to \S/.test(label.content) && label.color !== label.background, 'the envelope\'s label says to whom, readable (not ink on ink)', label)
    const before = ctx.commands.length
    await A.click('#corner-note-box .corner-note-field')
    await A.key('Enter', 13, 2)
    const heard = await until(() => ctx.commands.slice(before).find(c => c.kind === 'message' && c.body?.attachments?.length === 1), 'the picture-only note at the agent', 20000).catch(() => null)
    check(heard && !String(heard.body.text ?? '').trim(), 'the agent got the note: one picture, no words', heard?.body)
    await A.until("!document.querySelector('#corner-note-box.has-words') && !document.querySelector('#corner-note-box .corner-note-file')", 'the note empty again after the send', 10000).catch(() => {})
    check(await A.js("return !document.querySelector('#corner-note-box .corner-note-file')"), 'the note is empty again')
  }],

  ['sidebar order: a second agent joins; its row is dragged above the first, kept after a reload; Alt+↓ puts it back', async ctx => {
    const { check } = ctx.run
    const A = await ctx.profile('A')
    await ui.openDesk(A)
    await A.click('#sidebar-invite')
    await A.until("location.pathname.startsWith('/pair/') && document.querySelector('[data-state=open] .clip-copy[data-line=connect] code')", 'the agent invite page')
    const command = await A.js("return document.querySelector('[data-state=open] .clip-copy[data-line=connect] code').textContent")
    const link = /'(http\S+\/join#v1\.[^']+)'/.exec(command)?.[1]
    ctx.second = await joinAgent(ctx, link, async () => {
      await A.until("document.querySelector('[data-state=confirm_code] .clip-ask .check-yes')", 'the second agent\'s emoji')
      await A.click('[data-state=confirm_code] .clip-ask .check-yes')
    }, 'second')
    await A.until("document.querySelector('[data-state=joined]')", 'the second agent is in', 20000)
    await ctx.second.setRegister('profile', { model: 'claude-opus-5-5', task: 'Order', agent_name: 'second-agent' })
    await ui.openDesk(A)
    const order = () => A.js("return [...document.querySelectorAll('#agents > .agent-row[data-order]')].map(r => r.querySelector('strong').textContent)")
    // both in one part (connected or not): the fake hub tells no presence by itself
    const room = ctx.fake.state.rooms.values().next().value
    const devices = await A.js("return [...trommi.client.model.sessions.values()].filter(s => s.group_id && !s.parent_session_id).map(s => s.agent_device_id)")
    for (const d of devices) ctx.fake.push(room.room_id, `event: presence\ndata: ${JSON.stringify({ device: Buffer.from(d, 'hex').toString('base64url'), online: true, hears: true })}\n\n`)
    await A.until("(() => { const r = [...document.querySelectorAll('#agents > .agent-row[data-order]')]; return r.length === 2 && r[0].dataset.order === r[1].dataset.order && r.some(x => x.textContent.includes('second-agent')) })()", 'two connected sessions in the sidebar', 20000)
    const was = await order()
    check(was[1] === 'second-agent', 'the new session stands last (its default place)', was)
    await A.shot('standin-30-order-before')
    // a drag with the mouse: pressed on the second row, carried above the first, let go
    const from = await A.point('#agents > .agent-row[data-order] ~ .agent-row[data-order] > .agent-entry')
    const to = await A.js("const r = document.querySelector('#agents > .agent-row[data-order]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 4 }")
    await A.mouse('mouseMoved', from.x, from.y, false)
    await A.mouse('mousePressed', from.x, from.y)
    for (let i = 1; i <= 8; i++) { await A.mouse('mouseMoved', from.x, from.y + (to.y - from.y) * i / 8, true); await sleep(30) }
    check(await A.js("return !!document.querySelector('#agents .order-ghost') && !!document.querySelector('#agents .agent-row.is-carried')"), 'while carried: a ghost follows the pointer, its place stays open')
    await A.shot('standin-31-order-dragging')
    await A.mouse('mouseReleased', to.x, to.y)
    check(await A.js("return !document.querySelector('#agents .order-ghost, #agents .is-carried')"), 'let go: no ghost, no open place')
    check(await A.js("return location.pathname === '/'"), 'the drag did not open the session')
    await A.until("(() => { const r = [...document.querySelectorAll('#agents > .agent-row[data-order] strong')]; return r[0]?.textContent === 'second-agent' })()", 'the second agent on top')
    await A.until("[...trommi.client.model.human.session_settings.values()].filter(v => Number.isFinite(v?.position)).length >= 2 && ![...trommi.client.model.human.raw.values()].some(r => r.pending)", 'the places written and taken by the hub', 15000)
    await A.reload()
    await ui.live(A)
    await A.until("document.querySelectorAll('#agents > .agent-row[data-order]').length === 2", 'the sidebar after the reload')
    check(JSON.stringify(await order()) === JSON.stringify([was[1], was[0]]), 'after a reload the order is kept', await order())
    await A.shot('standin-32-order-after')
    // the keyboard: Alt+↓ on the focused row puts it back
    await A.js("document.querySelector('#agents > .agent-row[data-order] .agent-entry').focus()")
    await A.key('ArrowDown', 40, 1)
    await A.until("(() => { const r = [...document.querySelectorAll('#agents > .agent-row[data-order] strong')]; return r[1]?.textContent === 'second-agent' })()", 'Alt+↓ moved it down')
    await A.until("![...trommi.client.model.human.raw.values()].some(r => r.pending)", 'the places taken by the hub', 15000)
    check(JSON.stringify(await order()) === JSON.stringify(was), 'the order as before', await order())
    // (the second agent leaves: the steps after this one press the first session's row)
    const second = await A.js("return [...trommi.client.model.sessions.values()].find(s => s.group_id && !s.parent_session_id && s.profile?.agent_name === 'second-agent')?.agent_device_id")
    if (second) ctx.fake.push(room.room_id, `event: presence\ndata: ${JSON.stringify({ device: Buffer.from(second, 'hex').toString('base64url'), online: false })}\n\n`)
    await ctx.second.stop().catch(() => {})
    await A.until("document.querySelector('#agents > .agent-row[data-order] strong')?.textContent !== 'second-agent'", 'the first session first again')
  }],

  ['a new profile logs in with e-mail and password and lands on the Desk with history; a wrong password is refused', async ctx => {
    const { check } = ctx.run
    await ctx.within('D', async D => {
    await ui.logIn(D, ctx.app.start(), ctx.email, `${ctx.password}-wrong`)
    await D.until("document.querySelector('#ob-error')?.textContent.trim()", 'the refusal of a wrong password', 30000)
    check(await D.js("return document.querySelector('#ob-error').textContent") === 'Wrong email or password.', 'the sentence for a wrong password', await D.js("return document.querySelector('#ob-error').textContent"))
    await D.type('#login-form input[name=password]', ctx.password)
    await D.click('#login-form button[type=submit]')
    await ui.live(D, 'the new profile live', 60000)
    await D.until(`document.getElementById('row-${ctx.first}')`, 'the open question on its Desk', 60000)
    check(await D.js(`return document.querySelector('#row-${ctx.first} .inbox-question').textContent.includes('Which database?')`), 'it reads the question (history)')
    await D.shot('standin-23-password-login')
    })
  }],

  ['takeover: the session\'s "Copy Invite Link" → a new agent stand-in joins with it → the old one is out, the new one reads the history and answers', async ctx => {
    const { check } = ctx.run
    const A = await ctx.profile('A')
    await ui.openDesk(A); await openSession(A)
    await A.click('#session summary.t-head-more')
    await A.click('#session .desk-move form[action$="/pair"] button')
    await A.until("location.pathname.startsWith('/pair/') && document.querySelector('[data-state=open] .clip-copy[data-line=connect] code')", 'the invite page of the session')
    check(await A.js("return document.querySelector('.room-invite h2').textContent") === 'Continue night-agent', 'the page says which session is continued', await A.js("return document.querySelector('.room-invite h2')?.textContent"))
    const link = /'(http\S+\/join#v1\.[^']+)'/.exec(await A.js("return document.querySelector('[data-state=open] .clip-copy[data-line=connect] code').textContent"))?.[1]
    const old = ctx.agent, session = old.session_id
    const commands = []
    const next = await joinAgent(ctx, link, async () => {
      await A.until("document.querySelector('[data-state=confirm_code] .clip-ask .check-yes')", 'the six emoji of the new connector')
      await A.shot('standin-26-takeover-confirm')
      await A.click('[data-state=confirm_code] .clip-ask .check-yes')
    }, 'agent-moved')
    next.onCommand = c => commands.push(c)
    await A.until("document.querySelector('[data-state=joined]')", 'the page says the session goes on with the new connector', 30000)
    check(next.session_id === session, 'the new device holds the same session', { session, now: next.session_id })
    // history: the new device reads the session's Chat from before it joined
    const key = `chat:session/${session}`
    const texts = await until(async () => {
      await next.client.loadTimeline(key).catch(() => {})
      const t = [...(next.client.model.timelines.get(key)?.items.values() ?? [])].map(i => i.content?.text).filter(Boolean)
      return t.includes('Please start with the schema.') ? t : null
    }, 'the new agent reads a message of before it joined', 30000)
    check(texts.includes('The migration is written.'), 'it reads what the old agent said, too', texts)
    await ui.openDesk(A); await openSession(A)
    await next.say({ text: 'I go on from the other machine.' })
    await A.until("[...document.querySelectorAll('#session .msg-agent')].some(m => m.innerText.includes('I go on from the other machine.'))", 'the new agent\'s words in the session\'s chat')
    await sendChat(A, 'Welcome back.')
    await until(() => commands.some(c => c.kind === 'message' && c.body?.text === 'Welcome back.'), 'A\'s message at the new agent')
    // the old device is out: what it sends reaches nobody
    const since = ctx.mark()
    await old.say({ text: 'A ghost speaks.' }).catch(() => {})
    await sleep(2500)
    check(!await A.js("return document.querySelector('#session').innerText.includes('A ghost speaks.')"), 'what the old device says does not reach the chat')
    const ghost = envelopes(since()).filter(e => e.sender === idOf(old.device_id))
    check(ghost.every(e => e.status !== 200), 'the hub refuses the old device\'s envelope', ghost.map(e => e.status))
    check(!ctx.commands.some(c => c.body?.text === 'Welcome back.'), 'the old device was not handed the new message')
    await old.stop().catch(() => {})
    ctx.agent = next
    ctx.commands = commands
    await A.shot('standin-27-after-takeover')
  }],

  ['two tabs of profile A: one owns the device, the other follows; an answer given in the follower is sent once', async ctx => {
    const { check } = ctx.run
    const A = await ctx.profile('A')
    await ui.openDesk(A)
    const A2 = await ctx.profiles.A.tab(`${ctx.app.origin}/`)
    await ui.live(A2, 'the second tab live')
    const roles = [await A.js('return trommi.client.tabRole'), await A2.js('return trommi.client.tabRole')]
    check(roles.join() === 'leader,follower', 'the first tab owns the device, the second follows', roles)
    const card = await ctx.agent.askCard({ title: 'Two tabs?', options: [{ key: 'a', label: 'Yes' }, { key: 'b', label: 'No' }] })
    for (const P of [A, A2]) await P.until(`document.getElementById('row-${card}')`, `the question in ${P.name}`)
    const since = ctx.mark(), before = ctx.commands.length
    await A2.click(`#row-${card} button[name=key][value=a]`)
    for (const P of [A, A2]) await P.until(`!document.getElementById('row-${card}')`, `the question gone in ${P.name}`)
    await until(() => ctx.commands.slice(before).some(c => c.kind === 'answer' && c.object_id === card), 'the answer at the agent')
    await sleep(1200)
    check(ctx.commands.slice(before).filter(c => c.object_id === card).length === 1, 'the agent heard it once')
    check(about(since(), 'answer', card).length === 1, 'the hub was posted one answer envelope', about(since(), 'answer', card).length)
    await A2.shot('standin-28-follower-tab')
    ctx.follower = A2
  }],

  ['the owner tab is closed: the follower takes over and a second action works', async ctx => {
    const { check } = ctx.run
    const A = await ctx.profile('A'), A2 = ctx.follower
    if (!A2) throw new Error('no follower tab (the step before failed)')
    const card = await ctx.agent.askCard({ title: 'After the owner left?', options: [{ key: 'a', label: 'Yes' }, { key: 'b', label: 'No' }] })
    await A2.until(`document.getElementById('row-${card}')`, 'the question in the follower')
    await A.close()
    ctx.profiles.A.page = A2
    const took = await A2.until("trommi.client.tabRole === 'leader' && trommi.client.model.room.connection === 'live'", 'the follower owns the device and is live', 30000)
    ctx.run.note(`the follower took over ${(took / 1000).toFixed(1)} s after the owner's tab closed`)
    const since = ctx.mark(), before = ctx.commands.length
    await A2.click(`#row-${card} button[name=key][value=b]`)
    await A2.until(`!document.getElementById('row-${card}')`, 'the question gone')
    await until(() => ctx.commands.slice(before).some(c => c.kind === 'answer' && c.object_id === card && c.choices.join() === 'b'), 'the answer at the agent')
    await sleep(1000)
    check(ctx.commands.slice(before).filter(c => c.object_id === card).length === 1 && about(since(), 'answer', card).length === 1, 'sent once, heard once')
    const live = await ctx.agent.askCard({ card_type: 'info', title: 'Still live?' })
    await A2.until(`document.getElementById('row-${live}')`, 'a new card arrives live in the tab that took over')
    await A2.click(`#row-${live} .inbox-answer.is-ack`)
  }],

  ['reload in the middle of a write, four timings: after the reload the answer is there once, or not at all with the card still open', async ctx => {
    const { check, note } = ctx.run
    const A = await ctx.profile('A')
    const ENVELOPES = { method: 'POST', path: '/v1/envelopes' }
    const timings = [
      ['at once', null, 0],
      ['while the post waits at the hub', { ...ENVELOPES, delay_ms: 1500 }, 400],
      ['after the hub took the post and cut the answer', { ...ENVELOPES, drop: 'after' }, 400],
      ['after the hub cut the post unhandled', { ...ENVELOPES, drop: 'before' }, 400],
    ]
    for (const [name, fault, wait] of timings) {
      await ui.openDesk(A)
      const card = await ctx.agent.askCard({ title: `Reload ${name}?`, options: [{ key: 'a', label: 'Yes' }, { key: 'b', label: 'No' }] })
      await A.until(`document.getElementById('row-${card}')`, `the question (${name})`)
      const since = ctx.mark(), before = ctx.commands.length
      if (fault) ctx.fake.faults.add(fault)
      await A.click(`#row-${card} button[name=key][value=a]`)
      if (wait) await sleep(wait)
      await A.reload()
      await ui.live(A, `live after the reload (${name})`, 40000)
      // it settles: nothing in the outbox, and the card either answered everywhere or open and untouched
      await A.until('trommi.client.model.outbox.length === 0 && !trommi.client.model.room.outbox_blocked', `nothing left to send (${name})`, 40000)
      await sleep(1500)
      ctx.fake.faults.clear()
      const posted = about(since(), 'answer', card), accepted = new Set(posted.filter(e => e.status === 200).map(e => `${e.sender}:${e.seq}`))
      const heard = ctx.commands.slice(before).filter(c => c.object_id === card)
      const open = await A.js(`return !!document.getElementById('row-${card}')`)
      const state = await A.js(`const c = trommi.client.model.cards.get('${card}'); return { state: c.object_state, pending: Boolean(c.pending || c.answer?.pending) }`)
      note(`${name}: ${posted.length} post(s) of the answer (${posted.map(e => e.dropped ? `cut ${e.dropped}` : e.status).join(', ') || 'none'}), the agent heard ${heard.length}, the card is ${open ? 'open' : 'answered'}`)
      check(accepted.size <= 1 && heard.length <= 1, `${name}: never twice`, { accepted: accepted.size, heard: heard.length })
      check(accepted.size === heard.length, `${name}: the agent heard exactly what the hub took`, { accepted: accepted.size, heard: heard.length })
      check(open === (accepted.size === 0), `${name}: the card is open exactly if no answer was taken`, { open, accepted: accepted.size })
      check(!state.pending && state.state === (accepted.size ? 'answered' : 'open'), `${name}: no stuck "sending"`, state)
      if (open) { await A.click(`#row-${card} button[name=key][value=a]`); await until(() => ctx.commands.slice(before).some(c => c.object_id === card), `the answer given again after the reload (${name})`) }
    }
  }],

  ['offline: the hub goes away, A answers and writes (shown at once); the hub comes back: delivered once, in order', async ctx => {
    const { check } = ctx.run
    const A = await ctx.profile('A')
    await ui.openDesk(A)
    const card = await ctx.agent.askCard({ title: 'While offline?', options: [{ key: 'a', label: 'Yes' }, { key: 'b', label: 'No' }] })
    await A.until(`document.getElementById('row-${card}')`, 'the question')
    const before = ctx.commands.length
    let away = true
    await ctx.fake.stop()
    try {
      const since = ctx.mark()
      await A.until("trommi.client.model.room.connection !== 'live'", 'the app notices the hub is away', 20000)
      await A.click(`#row-${card} button[name=key][value=b]`)
      await A.until(`!document.getElementById('row-${card}')`, 'the answered question leaves the Desk at once')
      // (the Desk hands a tile's answer to the core a moment after the click; called directly, `client.answer` seals
      // within milliseconds. A person is slower than that moment, this script is not: it waits for it)
      const held = await A.until("trommi.client.model.outbox.some(o => o.envelope_kind === 'answer')", 'the answer in the outbox', 10000)
      ctx.run.note(`the answer was in the outbox ${held} ms after the row left the Desk`)
      await openSession(A)
      await sendChat(A, 'Written while the hub was away.')
      await A.until("[...document.querySelectorAll('#session .msg-user')].some(m => m.innerText.includes('Written while the hub was away.'))", 'the message shown at once')
      await A.until("['answer', 'sessionChat'].every(k => trommi.client.model.outbox.some(o => o.envelope_kind === k))", 'the answer and the message wait in the outbox', 10000)
      await A.shot('standin-29-offline')
      await sleep(1500)
      check(since().length === 0 && ctx.commands.length === before, 'nothing reached the hub or the agent meanwhile')
      await ctx.fake.start()
      away = false
      await until(() => ctx.commands.slice(before).length >= 2, 'both at the agent after the hub is back', 60000)
      await A.until('trommi.client.model.outbox.length === 0', 'the outbox empty', 30000)
      await sleep(1500)
      const heard = ctx.commands.slice(before)
      check(heard.length === 2 && heard[0].kind === 'answer' && heard[0].object_id === card && heard[1].kind === 'message' && heard[1].body?.text === 'Written while the hub was away.', 'the agent heard the answer, then the message, each once', heard.map(c => c.kind))
      const me = idOf(await A.js('return trommi.client.model.room.my_device_id'))
      const mine = envelopes(since()).filter(e => e.status === 200 && e.sender === me && (e.kind === 'answer' || (e.kind === 'item' && e.timeline?.kind === 'chat')))
      check(new Set(mine.map(e => e.seq)).size === 2 && mine[0]?.kind === 'answer' && mine.every((e, i) => !i || e.seq >= mine[i - 1].seq), 'the hub took them in the order they were made', mine.map(e => [e.kind, e.seq]))
      check(await A.js("return [...document.querySelectorAll('#session .msg-user')].filter(m => m.innerText.includes('Written while the hub was away.')).length") === 1, 'the message stands in the chat once')
      await ui.live(A, 'live again')
    } finally { if (away) await ctx.fake.start() }
  }],

  ['a hostile hub replays a change on the stream and sends a catch-up page in the wrong order: nothing twice, nothing lost, no crash', async ctx => {
    const { check, note } = ctx.run
    const A = await ctx.profile('A'), B = await ctx.profile('B')
    const room = ctx.fake.state.rooms.values().next().value
    const exceptions = ctx.seen.exceptions.length
    await ui.openDesk(A); await openSession(A)
    // 1. a replay: an envelope the room took, written into the stream again, under its own number and under a new one
    await ctx.agent.say({ text: 'Said once, replayed by the hub.' })
    await A.until("[...document.querySelectorAll('#session .msg-agent')].some(m => m.innerText.includes('Said once, replayed by the hub.'))", 'the message in the chat', 40000)
    const taken = room.changes.findLast(i => i.kind === 'envelope')
    const event = change => `id: ${change}\nevent: envelope\ndata: ${JSON.stringify({ kind: 'envelope', change, received_at: taken.received_at, envelope: taken.envelope })}\n\n`
    ctx.fake.push(room.room_id, event(taken.change))
    ctx.fake.push(room.room_id, event(room.change + 1))
    await sleep(2500)
    check(await A.js("return [...document.querySelectorAll('#session .msg-agent')].filter(m => m.innerText.includes('Said once, replayed by the hub.')).length") === 1, 'the replayed message stands in the chat once')
    const shown = await A.js("return { alerts: trommi.client.model.alerts.map(a => a.code), notices: [...document.querySelectorAll('.room-notice')].map(n => n.innerText.trim()).filter(Boolean), connection: trommi.client.model.room.connection }")
    note(`after the replay the app shows: ${JSON.stringify(shown)}`)
    const after = await ctx.agent.askCard({ card_type: 'info', title: 'After the replay' })
    await ui.openDesk(A)
    await A.until(`document.getElementById('row-${after}')`, 'the app still takes what really follows', 60000)
    await A.click(`#row-${after} .inbox-answer.is-ack`)
    // 2. a page of the catch-up in the wrong order, for a device that was away
    await B.go('about:blank')
    await sleep(500)
    for (const text of ['Away one.', 'Away two.', 'Away three.']) await ctx.agent.say({ text })
    let bent = 0
    ctx.fake.faults.add({ method: 'GET', path: '/v1/changes', times: 4, answer: json => { if (json.items.length > 1) bent += 1; return { ...json, items: [...json.items].reverse() } } })
    await B.go(`${ctx.app.origin}/`)
    await B.until("document.documentElement.hasAttribute('data-ready')", 'B opens again', 30000)
    await openSession(B)
    const order = () => B.js("return [...document.querySelectorAll('#session .msg-agent')].map(m => m.innerText).filter(t => /Away (one|two|three)\\./.test(t)).map(t => /Away (\\w+)\\./.exec(t)[1])")
    await until(async () => (await order()).length >= 3, 'the three messages on B', 60000).catch(() => {})
    const got = await order()
    check(bent > 0, 'B was served a page in the wrong order', bent)
    check(got.join() === 'one,two,three', 'B shows the three messages once each, in their order', got)
    const shownB = await B.js("return { alerts: trommi.client.model.alerts.map(a => a.code), connection: trommi.client.model.room.connection, blocked: trommi.client.model.room.outbox_blocked }")
    note(`after the reordered page B shows: ${JSON.stringify(shownB)}`)
    ctx.fake.faults.clear()
    check(ctx.seen.exceptions.length === exceptions, 'no uncaught error in any page or worker', ctx.seen.exceptions.slice(exceptions))
    await B.shot('standin-30-after-hostile-hub')
  }],

  // (last of the steps that need the room's devices: the recovery removes every other human device)
  ['forgot password (the recovery of 8.7): a fresh profile gives the Emergency Kit words and a new password, is shown the NEW kit, lands on the Desk with history; the other devices are removed', async ctx => {
    const { check } = ctx.run
    const newPassword = 'a brand new password 4711'
    let words = null
    await ctx.within('E', async E => {
    await E.go(ctx.app.start())
    await E.until("document.querySelector('#way-login')", 'the welcome screen')
    await E.click('#way-login')
    await E.until("document.querySelector('#way-forgot')", 'the login screen')
    await E.click('#way-forgot')
    await E.until("document.querySelector('#forgot-form')", 'the forgot password screen')
    await E.type('#forgot-form input[name=account]', ctx.email)
    await E.type('#forgot-form textarea[name=words]', ctx.words)
    await E.type('#forgot-form input[name=password]', newPassword)
    await E.shot('standin-24-forgot')
    const since = ctx.mark()
    await E.click('#forgot-form button[type=submit]')
    await E.until("document.querySelector('#kit-gate[open] #kit-done') || document.querySelector('#ob-error')?.textContent.trim()", 'the new kit, or a refusal', 25000)
    const refused = await E.js("return document.querySelector('#kit-gate[open]') ? '' : document.querySelector('#ob-error').textContent")
    if (refused) throw new Error(`the app refused: "${refused}" (hub log: ${since().filter(r => r.status >= 400).map(r => `${r.method} ${r.path.replace(/[A-Za-z0-9_-]{30,}/g, '…')} ${r.status}`).join(', ') || 'no refusal'})`)
    words = await ui.takeKit(E)
    check(words.split(' ').length === 12 && words !== ctx.words, 'a NEW kit of twelve words is shown')
    await E.shot('standin-25-after-new-kit')
    await ui.live(E, 'the recovered profile live', 60000)
    await E.until(`document.getElementById('row-${ctx.first}')`, 'the open question on its Desk', 60000)
    const posts = since().filter(r => r.method === 'POST' && /\/recovery(\/|$)/.test(r.path)).map(r => `${r.path.replace(/^.*\/recovery/, 'recovery').replace(/[A-Za-z0-9_-]{20,}/g, '…')} ${r.status}`)
    check(posts.at(-1) === 'recovery/…/finish 200' && posts.every(x => x.endsWith(' 200')), 'the hub took the recovery (8.7): begun, its Commits, finished', posts)
    })
    // the other human devices are out
    for (const name of ['A', 'B']) {
      const P = ctx.profiles[name]?.page
      if (!P) continue
      const out = await P.until("trommi.client.model.room.connection === 'removed'", `${name} learns it was removed`, 30000).then(() => true, () => false)
      check(out, `${name} is removed`, await P.js('return trommi.client.model.room.connection').catch(() => '?'))
      if (true && out) {
        // only after the device processed its removal: the notice, and nothing of the app left in this profile
        const screen = await P.until("document.querySelector('#removed-said')", `${name}'s removed screen`, 15000).then(() => true, () => false)
        const left = await ui.storedCount(P).catch(() => null)
        ctx.run.check(screen && left?.records === 0 && left?.local === 0, `${name} shows the removed screen and keeps nothing`, left)
      }
      ctx.run.note(`${name} (removed) shows: ${await P.js("return document.body.innerText.replace(/\\s*\\n\\s*/g, ' | ').slice(0, 160)").catch(() => '?')}; notices: ${JSON.stringify(await P.js("return [...document.querySelectorAll('.room-notice, [role=alert]')].map(n => n.innerText.trim()).filter(Boolean)").catch(() => []))}`)
    }
    // (Not asked here: logging in with the new password afterwards. The fake hub does not replace the room's
    // recovery key when a recovery finishes, so the device that would join with the new code is no member for it.
    // real.mjs asserts it against the real hub.)
    ctx.password = newPassword
    ctx.words = words
  }],

  // KEPT FAILING until the product is fixed (auth.mjs, the login screen's standing passkey offer): when
  // `navigator.credentials.get` with `mediation: 'conditional'` rejects at once, the screen is drawn again, which
  // starts the offer again, with a new challenge asked of the hub each time. A site named by an IP address is one
  // where WebAuthn rejects at once ("This is an invalid domain"); every other step here uses http://localhost.
  ['the login screen does not ask the hub in a loop where the browser refuses the passkey offer at once', async ctx => {
    await ctx.within('G', async G => {
      const since = ctx.mark()
      await G.go(`${ctx.app.numeric}/?hub=${encodeURIComponent(ctx.app.numeric)}&passkeys=1`)
      await G.until("document.querySelector('#way-login')", 'the welcome screen')
      await G.click('#way-login')
      await sleep(2000)
      const asked = since().filter(r => r.path === '/v1/account/passkey/challenge').length
      const usable = await G.js("const f = document.querySelector('#login-form input[name=account]'); return !!f && f.getClientRects().length > 0")
      await G.go('about:blank')
      ctx.run.check(asked <= 2, 'at most two passkey challenges were asked of the hub in two seconds', asked)
      ctx.run.check(usable, 'the login form stands still, to type into')
    })
  }],

  ['over the whole run: no Content-Security-Policy violation, no uncaught error in a page or a worker', async ctx => {
    const { check, note } = ctx.run
    for (const name of Object.keys(ctx.profiles)) { const v = await ctx.profiles[name].page.violations(); check(!v.length, `${name}: no violation on its last page`, v) }
    check(!ctx.seen.csp.length, 'no policy violation was reported', ctx.seen.csp)
    check(!ctx.seen.exceptions.length, 'no uncaught error', ctx.seen.exceptions)
    check(ctx.app.policy.includes("connect-src 'self' https://hub.trommi.com;"), 'the policy served is the app\'s own', ctx.app.policy)
    const expected = e => EXPECTED_ERRORS.some(([re]) => re.test(e))
    check(!ctx.seen.errors.some(e => !expected(e)), 'no console error but the expected ones', ctx.seen.errors.filter(e => !expected(e)))
    for (const [kind, list] of [['console error (expected)', ctx.seen.errors.filter(expected)], ['console warning', ctx.seen.warnings], ['failed request', ctx.seen.network]]) {
      const counted = new Map()
      for (const line of list) { const k = line.replace(/\d{4,}/g, 'N').split('\n')[0].slice(0, 220); counted.set(k, (counted.get(k) ?? 0) + 1) }
      for (const [line, n] of counted) note(`${kind}${n > 1 ? ` ×${n}` : ''}: ${line}`)
    }
  }],
]

/** Console errors the run itself provokes, with why. */
const EXPECTED_ERRORS = [
  [/the other device said the codes do not match/, 'the refused join: the join screen logs the refusal it shows'],
]

/** A PNG of random pixels, stored without compression: width × height × 3 bytes and a little. */
function picture(width, height) {
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(body.length + 8); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(zlib.crc32(body), out.length - 4); return out }
  const head = Buffer.alloc(13)
  head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = 2   // 8 bits, RGB
  const rows = crypto.randomBytes((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0   // (each row's filter byte: none)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(rows, { level: 0 })), chunk('IEND', Buffer.alloc(0))])
}

/** Settings → Invite a Device → Show Code → "No scanner? Send the link": the link as the screen shows it. */
async function deviceInvite(page) {
  await ui.openSettings(page)
  await page.until("document.querySelector('#settings-pair')", 'Invite a Device')
  await page.click('#settings-pair')
  await page.until("document.querySelector('#set-device[data-state=open] .set-qr.is-real svg')", 'the code to scan')
  await page.click('#set-device details.room-more summary')
  await page.until("document.querySelector('#set-device .room-link input')?.getClientRects().length", 'the invite link')
  return page.js("return document.querySelector('#set-device .room-link input').value")
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main('standin', { setUp, steps, tearDown }, {})
