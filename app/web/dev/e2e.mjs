// End to end, with real crypto against a real hub: browser A creates an account (email + generated password,
// Emergency Kit), invites an agent (a Node process on the
// same client core), the agent files cards and status lines, A answers in the page, hands back, asks What??; a
// second browser B joins with the invite link and the check code (six emoji) compared on A, and sees the same Desk; a third browser C
// logs in with email + password, a fourth D with the Emergency Kit (forgot password); C logs out (removed from the
// member list, IndexedDB and caches empty) and logs in again.
//   node dev/e2e.mjs [--app http://127.0.0.1:8900] [--hub http://127.0.0.1:8890] [--shots dir] [--resolve 'MAP …']
// Prints timings (send -> visible on the other device) and exits 1 on a failure.
import { launchChromium } from '../../../dev/cdp.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { joinRoom, memoryStorage, checkEmoji } from '../../../shared/index.ts'
import { execSync } from 'node:child_process'
import { guard } from '../../../dev/guard.mjs'
guard({ usage: 'node dev/e2e.mjs [--app URL] [--hub URL] [--shots DIR] [--email E] [--resolve RULES] [--hub-down CMD --hub-up CMD]', values: ['app', 'hub', 'shots', 'email', 'resolve', 'hub-down', 'hub-up'], targets: ['app', 'hub'], resolve: 'resolve' })

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback }
// --hub-down 'cmd' / --hub-up 'cmd': stop and start the (local) hub around the first answer, to prove that an answer
// given while the hub is away reaches the agent once it is back (the outbox retries; nothing is lost).
const HUB_DOWN = arg('--hub-down', null), HUB_UP = arg('--hub-up', null)
const APP = arg('--app', 'http://127.0.0.1:8900'), HUB = arg('--hub', 'http://127.0.0.1:8890'), SHOTS = arg('--shots', null), RESOLVE = arg('--resolve', null)
const EMAIL = arg('--email', `e2e+${Date.now().toString(36)}@example.org`)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
let failed = 0
const check = (ok, what) => { results.push(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++ }
const timing = (what, ms) => results.push(`time ${what}: ${ms.toFixed(0)} ms`)

async function browser(name, width = 1440, height = 900) {
  const b = await launchChromium({ width, height, args: RESOLVE ? [`--host-resolver-rules=${RESOLVE}`] : [] })
  const page = await b.page()
  const errors = []
  page.on('Runtime.exceptionThrown', e => errors.push(`${name} exception: ${e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text}`))
  page.on('Runtime.consoleAPICalled', e => { if (e.type === 'warning' && process.env.E2E_WARN) console.log(name, 'warn:', e.args.map(a => a.value ?? a.description ?? '').join(' ')); if (e.type === 'error') errors.push(`${name} console: ${e.args.map(a => a.value ?? a.description ?? '').join(' ')}`) })
  await page.send('Runtime.enable'); await page.send('Page.enable')
  // CSP violations (an inline style or script the policy refuses), counted per page and checked at the end
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: "window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective+' '+(e.blockedURI||e.sample||'')))" })
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
  const js = async (code) => {
    const r = await page.send('Runtime.evaluate', { expression: `(async () => { ${code} })()`, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(`${name}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}\n    in: ${code.trim().slice(0, 160)}`)
    return r.result.value
  }
  const until = async (code, what, ms = 15000) => {
    const t = Date.now()
    while (Date.now() - t < ms) { if (await js(`return Boolean(${code})`).catch(() => false)) return Date.now() - t; await sleep(40) }
    await shot(`e2e-timeout-${name}-${what.replace(/[^\w]+/g, '-').slice(0, 40)}.png`).catch(() => {})
    throw new Error(`${name}: timed out waiting for ${what}`)
  }
  const go = async url => { await page.send('Page.navigate', { url }); await sleep(200) }
  async function shot(file) { if (!SHOTS) return; const s = await page.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, file), Buffer.from(s.data, 'base64')) }
  return { b, page, js, until, go, shot, errors, close: () => b.close() }
}

const A = await browser('A')
let B = null, C = null, D = null, agent = null, t0 = 0
try {
  // ---- A creates an account ----
  await A.go(`${APP}/?hub=${encodeURIComponent(HUB)}`)
  await A.until("document.querySelector('#way-create')", 'welcome screen')
  check(await A.js("return !/\\b(room|found)/i.test(document.querySelector('#room').textContent)"), 'welcome says account, not room')
  await A.shot('e2e-1-welcome.png')
  await A.js("document.querySelector('#way-create').click()")
  await A.until("document.querySelector('#create-form')", 'create account screen')
  await A.js(`document.querySelector('#create-form input[name=email]').value = '${EMAIL}'; document.querySelector('#create-form input[name=device_name]').value = 'Laptop'; document.querySelector('#create-form .room-gen').click()`)
  await A.until("/^[a-z]+(-[a-z]+){4}$/.test(document.querySelector('#create-form input[name=password]').value)", 'generated password')
  const password = await A.js("return document.querySelector('#create-form input[name=password]').value")
  check(true, 'Generate fills a five-word password')
  await A.shot('e2e-1b-create.png')
  t0 = Date.now()
  await A.js("document.querySelector('#create-form button[type=submit]').click()")
  await A.until("document.querySelector('#kit-make')", 'Emergency Kit offer', 30000)
  timing('create account (keys, Argon2id, found, register)', Date.now() - t0)
  check(await A.js("return document.body.textContent.includes('nobody (not even Trommi) can recover your data') && !!document.querySelector('#kit-later')"), 'kit offer with Later and the one sentence')
  await A.js("document.querySelector('#kit-make').click()")
  await A.until("document.querySelectorAll('#kit-words li').length === 12", 'kit words')
  const words = await A.js("return [...document.querySelectorAll('#kit-words li')].map(l => l.textContent).join(' ')")
  check(await A.js("return !!document.querySelector('#kit-download') && !!document.querySelector('#kit-print')"), 'Emergency Kit: 12 words, Download and Print')
  await A.shot('e2e-2-kit.png')
  await A.js("document.querySelector('#kit-done').click()")
  await A.until("document.documentElement.hasAttribute('data-ready') && trommi.client.model.room.connection === 'live'", 'account live')
  check(await A.js("return document.title === 'Desk · Trommi' && !!document.querySelector('#inbox')"), 'empty Desk after creating the account')
  // shared/core-worker.ts: the room runs in the core worker; the page holds a copy of its model (shared/remote.ts)
  // shared/account-remote.ts: creating the account ran in the core worker; the page never loaded the key derivation
  check(await A.js("return !performance.getEntriesByType('resource').some(e => /\\/account(-[A-Z0-9]+)?\\.mjs/.test(e.name))"), 'the account was made in the core worker (no key derivation in the page)')
  await A.until("trommi.client.worker instanceof Worker && trommi.client.model.room.connection === 'live'", 'the room live in the core worker').then(() => check(true, 'the core runs in a worker, the room is live'), () => check(false, 'the core runs in a worker, the room is live'))
  await A.js("trommi.router.visit('/settings/account')")
  await A.until(`document.getElementById('account-email')?.textContent === '${EMAIL.toLowerCase()}'`, 'account in Settings').then(() => check(true, 'Settings shows the account email'), e => check(false, e.message))
  check(await A.js("return document.querySelector('#account').textContent.includes('Make a new kit')"), 'Settings: kit made')
  await A.shot('e2e-2b-settings.png')

  // ---- A invites an agent from the empty Desk ("Invite your first agent"); the agent joins after the emoji are compared ----
  await A.js("trommi.router.visit('/settings/devices')")
  await A.until("document.querySelector('#agent-invite')", 'devices page with Invite an agent')
  await A.js("trommi.router.visit('/')")
  await A.until("document.querySelector('#desk-invite-go')", 'Invite your first agent on the empty Desk')
  check(await A.js("return document.querySelector('#agents #sidebar-invite[aria-label=\"Invite an agent\"]')?.textContent.trim() === 'New Agent…' && getComputedStyle(document.getElementById('agents')).display !== 'none'"), 'sidebar has the row + New agent')
  // (Settings, 8 October: one list, no tabs; the two invites at the top, then a row per page)
  await A.js("trommi.router.visit('/settings')")
  await A.until("document.querySelector('#settings-invite-agent') && document.querySelector('#settings-pair .set-qr-code')", 'Settings starts with Invite (agent, and the device code blurred)')
  check(true, 'Settings: Invite at the top, the device code blurred until asked for')
  check(await A.js("return ['sessions', 'devices', 'account', 'theme', 'keys'].every(k => document.getElementById('settings-' + k)?.getAttribute('href') === '/settings/' + k) && !document.querySelector('.room-tabs, [role=tablist]')"), 'Settings: one list of rows (Sessions, Devices, Account, Theme, Keyboard Shortcuts), no tabs')
  for (const [k, sel, what] of [['theme', '.set-choice input[value=system]', 'Theme: Light, Dark, System'], ['keys', '.set-keys kbd', 'Keyboard Shortcuts: the keys'], ['devices', '#push-level', 'Devices: the push level']]) {
    await A.js(`document.getElementById('settings-${k}').click()`)
    await A.until(`location.pathname === '/settings/${k}' && document.querySelector('${sel}') && document.querySelector('.set-back[href="/settings"]')`, what).then(() => check(true, `Settings · ${what}, with the way back`), e => check(false, e.message))
    await A.js("document.querySelector('.set-back').click()")
    await A.until("location.pathname === '/settings' && document.querySelector('#settings-pair')", 'back on the Settings list')
  }
  check(await A.js("return ![...trommi.client.model.invites.values()].some(i => i.invite_state === 'open' && i.device_role === 'human')"), 'Settings makes no device invite before "Show the code"')
  await A.shot('e2e-3a-desk-invite.png')
  await A.js("document.querySelector('#settings-invite-agent').click()")
  await A.until("location.pathname.startsWith('/pair/') && document.querySelector('[data-state=open]')", 'Settings Invite an agent opens the agent invite')
  check(true, 'Settings: Invite an agent opens the invite page')
  await A.js("trommi.router.visit('/')")
  await A.until("document.querySelector('#desk-invite-go')", 'back on the empty Desk')
  await A.js("document.querySelector('#desk-invite-go').click()")
  await A.until("location.pathname.startsWith('/pair/') && document.querySelector('[data-state=open]')", 'agent invite page')
  await A.shot('e2e-3-invite-agent.png')
  const link = await A.js("return [...trommi.client.model.invites.values()].at(-1).link")
  check(await A.js("return [...document.querySelectorAll('.clip-copy')].some(i => /^curl -fsSL \\S+\\/connect \\| sh -s '\\S+\\/join#v1\\./.test(i.dataset.inviteClipTextParam))"), 'agent invite shows the connect command (curl …/connect | sh -s <link>)')
  check(link.startsWith(`${APP}/join#v1.`) || link.includes('/join#v1.'), 'agent invite link with the secret after #')
  const j = joinRoom({ link, storage: memoryStorage(), device_name: 'night-agent', device_info: { device_name: 'night-agent', platform: 'node', folder: '~/git/test', host: 'e2e' }, poll_ms: 100 })
  // Every agent invite asks: the clipboard shows the six emoji the agent's terminal prints, and nothing is added before "They match".
  const agentEmoji = checkEmoji(await j.check_code).map(e => e.emoji).join(' ')
  await A.until("document.querySelector('[data-state=confirm_code] .clip-ask .check-emoji')", 'the clipboard shows the six emoji to compare')
  check(await A.js("return [...document.querySelectorAll('[data-state=confirm_code] .clip-ask .check-emoji-glyph')].map(e => e.textContent).join(' ')") === agentEmoji, 'the clipboard shows the same six emoji as the agent\'s terminal')
  check(await A.js("return [...trommi.client.model.members.values()].filter(m => m.device_role === 'agent').length === 0"), 'no agent added before "They match"')
  await A.js("document.querySelector('[data-state=confirm_code] .clip-ask .check-yes').click()")
  agent = await j.client
  agent.on('error', e => results.push(`note agent error: ${e?.code} ${e?.message}`))
  // One lease per process (R4): start() takes it under this process instance; a second claim under another instance
  // was a takeover of the agent's own stream (lease-lost on the stream, the answer never arrived).
  await agent.start({ process_instance: 'e2e' })
  // v1.1: an agent holds no room key; the app's core grants it a session once it joined.
  if (agent.whenSession) await Promise.race([agent.whenSession(), sleep(15000)])
  await agent.claimSession?.({ process_instance: 'e2e', agent_name: 'night-agent' }).catch(e => results.push(`note claimSession: ${e.message}`))
  await A.until("document.querySelector('[data-state=joined]')", 'agent joined on the invite page')
  check(true, 'agent added after "They match"')
  const commands = []
  agent.on('command', c => commands.push(c))
  await agent.setStatus({ 'status_line/tests': { label: 'Tests', state: 'working', detail: '12/40' }, profile: { model: 'claude-opus-5-5', task: 'E2E-Test', icon: 'draw:flask', agent_name: 'night-agent' } })

  // ---- a card: agent -> A, measured ----
  await A.js("trommi.router.visit('/')")
  await A.until("document.querySelector('#inbox')", 'desk')
  t0 = Date.now()
  const cardId = await agent.sendCard({ title: 'Welche Variante bauen?', body: 'Zwei Wege, beide getestet.', options: [{ key: 'a', label: 'Variante A' }, { key: 'b', label: 'Variante B' }], recommended: 'b' })
  await A.until(`document.getElementById('row-${cardId}')`, 'card row on the Desk')
  timing('card sent by agent -> row visible on A', Date.now() - t0)
  check(await A.js("return !!document.querySelector('#agents .agent-row[data-unit]')"), 'session in the sidebar')
  check(await A.js("return !document.querySelector('#desk-invite') && !!document.querySelector('#agents #sidebar-invite') && getComputedStyle(document.querySelector('#sidebar-invite')).backgroundColor === 'rgba(0, 0, 0, 0)'"), 'Invite your first agent gone once a session is in; the sidebar row is quiet again')

  // ---- the Desk row: the desk drawing (lamp lit while something waits) and the desk's own name; no switcher there ----
  check(await A.js("return document.querySelector('.desk-go .desk-name')?.textContent === 'Desk' && !!document.querySelector('#desk-lamp .lamp-light') && getComputedStyle(document.querySelector('.desk-go .desk-name')).display !== 'none' && !document.querySelector('.deskpill .desk-next, .deskpill .desk-blocked')"), 'Desk row: the name, the lamp lit (a question waits), no caret, no count or hand')
  await A.shot('e2e-4-desk-card.png')

  // ---- a card with a picture: uploaded encrypted, decrypted in A's page only when shown ----
  // (a tall one, 1440x2160: the picture's large view must scroll)
  const png = fs.readFileSync(new URL('../public/demo/files/tall-sheet.png', import.meta.url))
  const ref = await agent.uploadAttachment(png, { file_name: 'entwurf.png', media_type: 'image/png', width: 1440, height: 2160 })
  t0 = Date.now()
  const picCard = await agent.sendCard({ title: 'Welcher Entwurf?', body: 'Bild anbei.', options: [{ key: 'x', label: 'So' }, { key: 'y', label: 'Anders' }, { key: 'z', label: 'Später' }], attachments: [ref] })
  await A.until(`document.getElementById('row-${picCard}')`, 'picture card row')
  // (a Desk row is its title and its answers since 8 October: the picture shows on the card)
  await A.js(`trommi.router.visit('/card/' + trommi.model().byCard.get('${picCard}').number)`)
  await A.until(`[...document.querySelectorAll('#cardpage .tc-figure img')].some(i => i.complete && i.naturalWidth > 0)`, 'decrypted picture shown', 15000).then(() => { check(true, 'encrypted picture decrypted and shown on its card'); timing('picture card sent -> picture visible', Date.now() - t0) }, e => check(false, e.message))

  // ---- a card with a video: uploaded encrypted like a picture; on the card a <video> plays the decrypted blob ----
  const webm = fs.readFileSync(new URL('../public/demo/files/clip.webm', import.meta.url))
  const vref = await agent.uploadAttachment(webm, { file_name: 'ablauf.webm', media_type: 'video/webm' })
  const vidCard = await agent.sendCard({ title: 'Dieser Ablauf?', body: 'Video anbei.', options: [{ key: 'x', label: 'So' }, { key: 'y', label: 'Anders' }], attachments: [vref] })
  await A.until(`trommi.model().byCard.get('${vidCard}')`, 'video card in the room')
  const vnr = await A.js(`return trommi.model().byCard.get('${vidCard}').number`)
  await A.js(`trommi.router.visit('/card/${vnr}')`)
  await A.until("document.querySelector('#cardpage .tc-video video[controls][playsinline]')", 'video player on the card').then(() => check(true, 'a video card shows a <video controls playsinline>'), e => check(false, e.message))
  await A.until("(v => v && v.readyState >= 1 && v.duration > 2.5)(document.querySelector('#cardpage .tc-video video'))", 'video decrypted, its metadata read', 15000).then(() => check(true, 'encrypted video decrypted: metadata (3 s) loaded'), e => check(false, e.message))
  check(await A.js("const v = document.querySelector('#cardpage .tc-video video'); return v.paused && !v.autoplay"), 'the video does not play by itself')
  await A.shot('e2e-4b-video-card.png')
  await A.js("trommi.router.visit('/')")
  await A.until(`document.getElementById('row-${cardId}')`, 'back on the Desk')

  // ---- the pile "Artifacts N" at the Desk's foot (Media and Pages in one; the newest pictures and videos fanned); a
  //      click opens /artifacts: both kinds together, the newest first, the filter All · Media · Pages ----
  await A.until("document.querySelector('#desk-stacks > #desk-artifacts .df-card video') && document.querySelector('#desk-artifacts .df-card img')", 'artifacts pile with a picture and a video').then(() => check(true, 'Artifacts pile: in the Desk foot, thumbnails of a picture and a video'), e => check(false, e.message))
  check(await A.js("return !document.querySelector('#desk-media, #desk-pages') && /^All Artifacts\\s*2/.test(document.querySelector('#desk-artifacts .end-link').textContent.trim()) && document.querySelectorAll('#desk-artifacts .df-card').length === 2"), 'one pile, no Media or Pages pile; it says Artifacts 2')
  await A.until("[...document.querySelectorAll('#desk-artifacts img')].some(i => i.complete && i.naturalWidth > 0)", 'the fanned picture decrypted', 15000).then(() => check(true, 'the fanned picture is decrypted and shown'), e => check(false, e.message))
  await A.js("document.querySelector('#desk-artifacts .end-link').click()")
  await A.until("location.pathname === '/artifacts' && document.body.dataset.page === 'gallery' && document.querySelectorAll('#artifacts-list [data-kind=media] .art-shot').length === 2", 'artifacts with two tiles').then(() => check(true, 'clicking the pile opens /artifacts'), e => check(false, e.message))
  check(await A.js("return [...document.querySelectorAll('#artifacts-list .art-shot .asset-preview')].every(p => p.querySelector('img, video, svg.asset-glyph'))"), 'artifacts: no empty tile (each has its picture, video or drawn kind)')
  check(await A.js("return [...document.querySelectorAll('#gallery .art-kinds a')].map(a => a.textContent.trim()).join(' · ') === 'All · Media · Pages' && document.querySelector('#gallery .art-kinds a[aria-current]')?.textContent.trim() === 'All' && !!document.querySelector('#artifacts-list .gal-video video') && !!document.querySelector('#artifacts-list .gal-video .gal-play')"), 'artifacts: the filter All · Media · Pages; the video tile has its frame and a play mark')
  await A.js("[...document.querySelectorAll('#gallery .art-kinds a')].find(a => a.textContent.trim() === 'Pages').click()")
  await A.until("location.search.includes('kind=pages') && !document.querySelector('#artifacts-list [data-kind=media] .art-shot') && document.querySelector('#artifacts-list .gal-none')", 'Pages filter').then(() => check(true, 'filter Pages: no media tiles, says no pages yet'), e => check(false, e.message))
  await A.js("[...document.querySelectorAll('#gallery .art-kinds a')].find(a => a.textContent.trim() === 'Media').click()")
  await A.until("location.search.includes('kind=media') && document.querySelectorAll('#artifacts-list [data-kind=media] .art-shot').length === 2", 'Media filter').then(() => check(true, 'filter Media shows the picture and the video'), e => check(false, e.message))
  check(await A.js("return [...document.querySelectorAll('#brand-doors .menu-places a')].map(a => a.getAttribute('href')).join(' ') === '/scribble-board /artifacts' && !document.querySelector('#brand-doors a[href=\"/assets\"], #brand-doors a[href=\"/pages\"], #brand-doors a[href=\"/stacks/off\"]')"), 'the menu has Scribble and Artifacts (no Media, Pages, Off your mind)')
  await A.shot('e2e-4c-gallery.png')
  await A.js("document.querySelector('#artifacts-list [data-kind=media] .art-shot').click()")
  await A.until("document.querySelector('#cardpage .tc-video video')", 'the big view from the gallery').then(() => check(true, 'a gallery tile opens the big view'), e => check(false, e.message))
  await A.js("trommi.router.visit('/')")
  await A.until(`document.getElementById('row-${cardId}')`, 'back on the Desk')

  // ---- A answers with the row's tile; the agent gets the command ----
  if (HUB_DOWN) { execSync(HUB_DOWN, { stdio: 'ignore' }); await sleep(500) }
  t0 = Date.now()
  await A.js(`document.querySelector('#row-${cardId} form[action$="/decide"] button[value="b"], #row-${cardId} button[name=key][value=b]')?.click()`)
  await A.until(`!document.getElementById('row-${cardId}')`, 'row leaves after answering')
  timing('answer click -> row gone (local echo)', Date.now() - t0)
  if (HUB_UP) { await sleep(3000); execSync(HUB_UP, { stdio: 'ignore' }); t0 = Date.now(); results.push('note hub was down for the answer; timing below counts from the hub coming back') }
  const tc = Date.now()
  while (!commands.some(c => c.command === 'answer') && Date.now() - tc < 15000) await sleep(30)
  timing('answer click -> command at the agent', Date.now() - t0)
  check(commands.some(c => c.command === 'answer' && (c.choices ?? c.content?.choices ?? []).includes('b')), 'agent received the answer "b"')

  // ---- take it back from the toast's Undo ----
  const undoSel = `#says-host .says:not([hidden]) form[action$="/cards/${cardId}/reopen"] .says-back`
  const undo = await A.until(`document.querySelector('${undoSel}')`, 'the answer toast with Undo', 5000).then(async () => {
    check(await A.js(`const s = document.querySelector('${undoSel}').closest('.says'); return s.getAttribute('role') === 'status' && !!s.querySelector('.says-ring .ring-run') && s.querySelector('.says-label')?.textContent === 'Undo' && getComputedStyle(document.getElementById('says-host')).pointerEvents === 'none'`), 'the undo pill: a ring running down, the word Undo, a status for screen readers, nothing under it blocked')
    return A.js(`document.querySelector('${undoSel}').click(); return true`)
  }, () => false)
  if (undo) {
    // (Undo from a toast leads to that card's page, the answers in view; the row stands on the Desk again)
    await A.until(`document.querySelector('#cardpage') && location.pathname.startsWith('/card/')`, 'the card page after Undo')
    check(true, 'Undo (decide again) opens the card again on its page')
    await A.js("trommi.router.visit('/')")
    await A.until(`document.getElementById('row-${cardId}')`, 'row back after Undo').then(() => check(true, 'Undo (decide again) puts the row back on the Desk'), e => check(false, e.message))
    const tu = Date.now(); while (!commands.some(c => c.command === 'decide_again') && Date.now() - tu < 10000) await sleep(30)
    check(commands.some(c => c.command === 'decide_again'), 'agent received decide_again')
  } else check(false, 'toast with Undo after answering')

  // ---- the card page: What?? ----
  const nr = await A.js(`return trommi.model().byCard.get('${cardId}').number`)
  await A.js(`trommi.router.visit('/card/${nr}')`)
  await A.until("document.querySelector('#cardpage')", 'card page')
  await A.shot('e2e-5-card.png')
  t0 = Date.now()
  await A.js("document.querySelector('#cardpage button[formaction$=\"/what\"]').click()")
  const tw = Date.now(); while (!commands.some(c => c.command === 'message' && c.content?.explain) && Date.now() - tw < 10000) await sleep(30)
  check(commands.some(c => c.command === 'message' && c.content?.explain), 'agent received What?? (explain)')
  timing('What?? -> command at the agent', Date.now() - t0)
  check(await A.until("location.pathname === '/'", 'back on the Desk after What??').then(() => true, () => false), 'What?? goes back to the Desk, like the board')
  await agent.sendMessage({ object_id: cardId, text: 'Erklärung: A ist schneller, B ist sicherer.' })
  await A.js(`trommi.router.visit('/card/${nr}')`)
  await A.until("location.pathname.startsWith('/card/') && document.querySelector('#cardpage') && document.body.textContent.includes('B ist sicherer')", 'explanation in the card thread', 15000).then(() => check(true, 'agent reply shows in the card thread'), e => check(false, e.message))

  // ---- the picture, large: a tall one scrolls, and the card's answer stands beside it; a tap there decides ----
  const pn = await A.js(`return trommi.model().byCard.get('${picCard}').number`)
  await A.js(`trommi.router.visit('/card/${pn}/picture/1')`)
  await A.until("[...document.querySelectorAll('.tc-page.is-full .tc-stage img')].some(i => i.complete && i.naturalWidth > 0)", 'large picture shown', 15000).catch(e => check(false, e.message))
  const big = await A.js("const i = document.querySelector('.tc-page.is-full .tc-stage img'); return i ? Math.round(i.getBoundingClientRect().width) : 0")
  check(big > 400, `Full screen shows the picture large on the card itself (${big} px wide)`)
  const tiles = await A.js("return [...document.querySelectorAll('.tc-page.is-full .tc-right .tc-opt[name=key]')].filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.top >= 0 && r.bottom <= innerHeight && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('.tc-opt') === b }).length")
  check(tiles === 3, `the card's options stand in sight beside the large picture (${tiles} of 3)`)
  await A.shot('e2e-4b-picture.png')
  await A.js("document.querySelector('.tc-page.is-full .tc-right .tc-opt[value=y]').click()")
  const tp = Date.now(); while (!commands.some(c => c.command === 'answer' && (c.choices ?? c.content?.choices ?? []).includes('y')) && Date.now() - tp < 15000) await sleep(30)
  check(commands.some(c => c.command === 'answer' && (c.choices ?? c.content?.choices ?? []).includes('y')), 'an option tapped in the large picture view answers the card ("y" at the agent)')
  check(await A.until("location.pathname === '/'", 'back on the Desk after answering from the picture').then(() => true, () => false), 'answering from the picture goes back to the Desk')

  // ---- a file from the session's composer reaches the agent whole (encrypted, uploaded, decrypted there) ----
  const sid = await A.js("return trommi.model().agents[0]?.id")
  await A.js(`trommi.router.visit('/s/${sid}')`)
  await A.until("document.querySelector('form.composer input[type=file]')", 'composer')
  await A.js(`const f = document.querySelector('form.composer'); const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(4096).fill(7)], 'notiz.bin', { type: 'application/octet-stream' })); f.querySelector('input[type=file]').files = dt.files; f.querySelector('textarea').value = 'Mit Datei'; f.requestSubmit(f.querySelector('button[type=submit]'))`)
  const tf = Date.now(); let fileCmd = null
  while (!fileCmd && Date.now() - tf < 15000) { fileCmd = commands.find(c => c.command === 'message' && c.content?.attachments?.length); await sleep(50) }
  const bytes = fileCmd ? await agent.fetchAttachment(fileCmd.content.attachments[0]).catch(() => null) : null
  check(bytes?.length === 4096 && bytes[0] === 7, `a composer file reaches the agent whole (${bytes?.length ?? 'none'} bytes)`)

  // ---- the agent's words in its chat stand under the session's name and drawing, as in the heading (never "Agent") ----
  await agent.sendMessage({ text: 'Hallo aus der Session' })
  await A.until("[...document.querySelectorAll('#session .msg-agent')].some(m => m.textContent.includes('Hallo aus der Session'))", 'agent message in the session chat', 15000).catch(e => check(false, e.message))
  const who = await A.js("const m = [...document.querySelectorAll('#session .msg-agent')].findLast(m => m.textContent.includes('Hallo aus der Session')); return { name: m?.querySelector('.msg-head .msg-name')?.textContent ?? '', drawing: !!m?.querySelector('.msg-head .agent-avatar .doodle'), head: document.querySelector('#session .pane-name')?.textContent ?? '' }")
  check(who.name === 'night-agent' && who.name === who.head && who.drawing, `an agent message shows its session's name and drawing ("${who.name}", heading "${who.head}", drawing ${who.drawing})`)
  // ---- the corner note keeps the window's bottom-right corner in a conversation too, clear of the composer and the filter ----
  const corner = await A.js("const n = document.querySelector('#corner-note-box')?.getBoundingClientRect(), f = document.querySelector('#session .session-filter')?.getBoundingClientRect(), c = document.querySelector('#session form.composer')?.getBoundingClientRect(); return n && f && c ? { right: Math.round(innerWidth - n.right), bottom: Math.round(innerHeight - n.bottom), clear: n.left >= Math.max(f.right, c.right) } : null")
  check(corner?.right === 16 && corner?.bottom === 16 && corner?.clear, `the note sits at the window's bottom-right in a conversation, beside the composer and the filter (${JSON.stringify(corner)})`)

  // ---- the note: it waits at the window's bottom-right; sent from there (to the crown) it reaches the agent marked as a note and stands in
  //      the session's chat taped on, from the optimistic echo on, never as a bubble ----
  const noteText = 'Notiz e2e: Backup vor der Migration'
  // (a note goes to the session that wears the crown: given on the Agents page, by his hand)
  await A.js("trommi.router.visit('/settings/sessions')")
  await A.until("document.querySelector('#ledger-list details.set-desk .ledger-crown[aria-pressed=false]')", 'Sessions with the crown to give')
  check(await A.js("return [...document.querySelectorAll('#ledger-list details.set-desk')].every(d => !d.open) && !!document.querySelector('.ledger-find input')"), 'Settings · Sessions: the desks folded, the search on top')
  await A.js("document.querySelector('#ledger-list details.set-desk > summary').click()")
  await A.until("document.querySelector('#ledger-list details.set-desk[open] .ledger-crown[aria-pressed=false]')?.getClientRects().length", 'a desk unfolded')
  await A.js("document.querySelector('#ledger-list details.set-desk[open] .ledger-crown[aria-pressed=false]').click()")
  await A.until("trommi.model().agents.some(a => a.starred) && document.querySelector('.ledger-crown[aria-pressed=true]')", 'crown given').then(() => check(true, 'Agents page: the crown is given with one click'), e => check(false, e.message))
  await A.js(`const now = Date.now(); await trommi.client.saveNote({ text: '${noteText}', created_at: now, updated_at: now })`)
  await A.js("trommi.router.visit('/')")
  await A.until(`document.querySelector('#corner-note-box.has-words .corner-note-field')?.value.startsWith('Notiz e2e')`, 'the note at the bottom-right').then(() => check(true, 'the note waits at the bottom-right, the sticky shows it holds words'), e => check(false, e.message))
  check(await A.js("return !document.querySelector('#agents #corner-note-box')"), 'the note is not in the sidebar')
  await A.js("document.querySelector('#corner-note-box .corner-note-head').click()")
  await A.until("!document.querySelector('#corner-note-box .corner-note-body').hidden", 'the note unfolds')
  await A.js(`window.__bubbled = false; new MutationObserver(() => { if ([...document.querySelectorAll('.msg-user .bubble')].some(b => b.textContent.includes('${noteText}'))) window.__bubbled = true }).observe(document.documentElement, { childList: true, subtree: true }); document.querySelector('#corner-note-box .corner-note-send').click()`)
  const crownId = await A.js("return trommi.model().agents.find(a => a.starred)?.id")
  await A.js(`trommi.router.visit('/s/${crownId ?? sid}')`)
  const tn = Date.now(); let noteCmd = null
  while (!noteCmd && Date.now() - tn < 15000) { noteCmd = commands.find(c => c.command === 'message' && c.content?.text === noteText); await sleep(50) }
  check(/^[0-9a-f]{32}$/.test(noteCmd?.content?.note?.object_id ?? '') && Number.isSafeInteger(noteCmd?.content?.note?.written_at), 'a sent note reaches the agent with note { object_id, written_at }')
  await A.until(`[...document.querySelectorAll('.msg-note p')].some(p => p.textContent.includes('${noteText}'))`, 'taped note in the chat').then(() => check(true, 'the sent note stands taped in the session chat'), e => check(false, e.message))
  await sleep(1500)
  check(await A.js(`return !window.__bubbled && [...document.querySelectorAll('.msg-note p')].some(p => p.textContent.includes('${noteText}'))`), 'the taped note never turns into a bubble (echo -> hub copy)')
  check(await A.js("return !trommi.model().state.notes.some(m => m.text.startsWith('Notiz e2e'))"), 'the sent note left the note')
  await A.shot('e2e-note-taped.png')

  // ---- a card of a newer Trommi (a card_type this app does not know): a placeholder on its page, nothing to answer,
  //      and once a calm line with Reload (README "Versioning and compatibility") ----
  const newerCard = await agent.sendCard({ card_type: 'poll', title: 'Mittag?', options: [{ key: 'a', label: 'Pizza' }] })
  await A.until(`trommi.client.model.cards.has('${newerCard}')`, 'the newer card arrives')
  await A.js(`trommi.router.visit('/card/${newerCard}')`)
  await A.until(`document.querySelector('#card-answer-${newerCard}')?.textContent.includes('needs a newer version of Trommi')`, 'placeholder on the card').then(() => check(true, 'a card of a newer Trommi shows the update line, no options to answer'), e => check(false, e.message))
  check(await A.js(`return !document.querySelector('#card-answer-${newerCard} button[formaction]') && document.querySelector('#card-title-${newerCard}')?.textContent.includes('Mittag?')`), 'its title stands, no answer buttons')
  await A.until("document.querySelector('.room-notice[data-why=newer] .room-notice-go')", 'the newer notice').then(() => check(true, 'a calm notice offers Reload once something needs a newer Trommi'), e => check(false, e.message))
  await A.js("document.querySelector('.room-notice[data-why=newer]')?.remove()")

  // ---- the end list at the foot of the Desk's list (#desk-end): Off your mind, a plain feed: the work (a dot), what is
  //      put off (Later), what is closed (answered, done; shredded: struck); nothing to tick or archive; five rows,
  //      then "Show more", which opens the whole list with its search (/stacks/off); the way back is on the card ----
  const pile = {}
  for (const [k, title] of [['snooze', 'Stapel: später'], ['shred', 'Stapel: weg'], ['revise', 'Stapel: erklären'], ['done', 'Stapel: erledigt'], ['acting', 'Stapel: beantwortet']]) pile[k] = await agent.sendCard({ title, options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] })
  await A.js("trommi.router.visit('/')")
  await A.until(Object.values(pile).map(id => `document.getElementById('row-${id}')`).join(' && '), 'four pile cards on the Desk')
  // snoozed from its row; the toast's Undo fetches it back; snoozed again
  await A.js(`const f = document.querySelector('#row-${pile.snooze} form[action$="/snooze"]'); f.requestSubmit()`)
  await A.until(`!document.getElementById('row-${pile.snooze}')`, 'snoozed row leaves')
  const laterUndo = `#says-host .says:not([hidden]) form[action*="/cards/${pile.snooze}/"] .says-back`
  await A.until(`document.querySelector('${laterUndo}')`, 'toast with Undo after Later')
  await A.js(`document.querySelector('${laterUndo}').click()`)
  await A.until(`document.querySelector('#cardpage') && location.pathname.startsWith('/card/')`, 'the card page after Undo of Later').then(() => check(true, 'Undo of Later opens the card again on its page'), e => check(false, e.message))
  await A.js("trommi.router.visit('/')")
  await A.until(`document.getElementById('row-${pile.snooze}')`, 'row back after Undo of Later').then(() => check(true, 'Undo of Later puts the card back'), e => check(false, e.message))
  await A.js(`const f = document.querySelector('#row-${pile.snooze} form[action$="/snooze"]'); f.requestSubmit()`)
  await A.until(`!document.getElementById('row-${pile.snooze}')`, 'snoozed row leaves again')
  // answered, then closed by its session: Done
  await A.js(`document.querySelector('#row-${pile.done} form[action$="/decide"] button[value="a"], #row-${pile.done} button[name=key][value=a]')?.click()`)
  await A.until(`!document.getElementById('row-${pile.done}')`, 'answered row leaves')
  const td = Date.now(); while (!commands.some(c => c.command === 'answer' && c.object_id === pile.done) && Date.now() - td < 10000) await sleep(30)
  await agent.close(pile.done, 'erledigt')
  // closed by its session: it stands in the end list as a plain row: no box, no button, not struck, nothing to archive
  const endRow = (id, g) => `document.querySelector(':is(#desk-end, #off-end) .end-row[data-id="${id}"]${g ? `[data-g=${g}]` : ''}')`
  await A.until(`${endRow(pile.done, 'done')}`, 'the finished card in the end list').then(() => check(true, 'a card its session closed stands in the end list'), e => check(false, e.message))
  check(await A.js(`return !document.querySelector('#row-${pile.done}') && !document.querySelector('#desk-list .is-archive, #desk-list .is-done')`), 'no Done rows among the open questions')
  check(await A.js(`const r = ${endRow(pile.done)}; return !r.querySelector('button, form, .end-tick') && !getComputedStyle(r.querySelector('.end-title')).textDecorationLine.includes('line-through') && !document.querySelector('.end-row [formaction*=archive], .end-row form[action*=archive]')`), 'a finished row is plain: nothing to tick, no Archive, not struck through')
  // answered, its session still at it: Working
  await A.js(`document.querySelector('#row-${pile.acting} form[action$="/decide"] button[value="a"], #row-${pile.acting} button[name=key][value=a]')?.click()`)
  await A.until(`!document.getElementById('row-${pile.acting}')`, 'answered row leaves')
  // shredded and handed back from the card page
  for (const [k, way] of [['shred', 'shred'], ['revise', 'what']]) {
    const n = await A.js(`return trommi.model().byCard.get('${pile[k]}').number`)
    await A.js(`trommi.router.visit('/card/${n}')`)
    await A.until(`document.querySelector('#cardpage button[formaction$="/${way}"]')`, `card page with ${way}`)
    await A.js(`document.querySelector('#cardpage button[formaction$="/${way}"]').click()`)
    await A.until("location.pathname === '/'", `back on the Desk after ${way}`).catch(() => A.js("trommi.router.visit('/')"))
  }
  // (the Desk draws five rows, the work first: the whole list is on its page)
  await A.js("trommi.router.visit('/stacks/off')")
  await A.until(`${endRow(pile.snooze, 'later')} && ${endRow(pile.shred)} && ${endRow(pile.done, 'done')} && ${endRow(pile.revise, 'works')} && document.querySelector('#off-end .end-row[data-g=works] .work-dot') && !document.querySelector('#off-end .gear')`, 'one list: the asked one at the top, being worked on (a dot, no gear), five rows at most', 20000)
    .then(() => check(true, 'snoozed, shredded and done cards stand in the end list; the asked one (What??) stays on the Desk with the agents'), e => check(false, e.message))
  const g = await A.js(`return Object.fromEntries(['${pile.snooze}', '${pile.shred}', '${pile.done}'].map(id => [id, document.querySelector('#off-end .end-row[data-id="' + id + '"]')?.dataset.g]))`)
  check(g[pile.snooze] === 'later' && g[pile.shred] === 'trash' && g[pile.done] === 'done', `each card in its place (${Object.values(g).join(', ')})`)
  check(await A.js(`const o = [...document.querySelectorAll('#off-end .end-row')].map(r => r.dataset.g), rank = g => (g === 'works' ? 0 : g === 'later' ? 1 : 2); return o.every((x, i) => !i || rank(o[i - 1]) <= rank(x))`), 'the end list: the work first, then Later, then what is closed')
  check(await A.js(`return getComputedStyle(${endRow(pile.shred)}.querySelector('.end-title')).textDecorationLine.includes('line-through')`), 'a shredded row is struck through')
  await A.js("trommi.router.visit('/')")
  await A.until("document.querySelector('#desk-stacks')", 'the Desk again')
  check(await A.js("return !document.querySelector('#desk-stacks [data-pile=off], #desk-stacks [data-stack=off], .off-head') && !!document.querySelector('#desk-stacks #desk-artifacts')"), 'no pile Off the desk at the foot any more; Artifacts stays')
  // more than five: four more questions their session withdraws
  for (let i = 1; i <= 4; i++) await agent.close(await agent.sendCard({ title: `Ende ${i}`, options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] }), `zurückgezogen ${i}`)
  await A.until("document.querySelector('#desk-end .end-link')", 'more than five in the end list')
  const ends = await A.js("const r = [...document.querySelectorAll('#desk-end .end-row')]; return { all: r.length, shown: r.filter(x => !x.hidden && x.getClientRects().length).length, more: document.querySelector('#desk-end .end-link')?.textContent.trim() ?? null }")
  check(ends.all === 5 && ends.shown === 5 && ends.more === 'Show more', `five rows on the Desk (only those are drawn), then Show more (${JSON.stringify(ends)})`)
  await A.js("document.querySelector('#desk-end .end-link').click()")
  await A.until(`location.pathname === '/stacks/off' && document.querySelector('#off-end .end-row[data-id="${pile.snooze}"]')`, 'Show more opens the whole list').then(() => check(true, '"Show more" opens the whole list at /stacks/off'), e => check(false, e.message))
  check(await A.js("const l = [...document.querySelectorAll('#off-end .end-row')]; return l.length > 0 && l.every(x => x.querySelector('a.end-title')) && l.every(x => !x.hidden) && !!document.querySelector('.off-page .end-search input')"), 'the whole list: each row its title, all shown, with its search')
  // the way back is on the card: a row opens it, its Wake up brings it back to the Desk
  await A.js(`document.querySelector('#off-end .end-row[data-id="${pile.snooze}"] a.end-title').click()`)
  await A.until(`document.querySelector('#cardpage button[formaction$="/wake"]')`, 'the snoozed card with Wake up').then(() => check(true, 'a row opens its card, with its way back'), e => check(false, e.message))
  await A.js(`document.querySelector('#cardpage button[formaction$="/wake"]').click()`)
  // (Wake up answers with the card's page again, the card awake on it; then to the Desk)
  await A.until(`!trommi.model().byCard.get('${pile.snooze}').snoozed_until && document.querySelector('#cardpage') && !document.querySelector('#cardpage button[formaction$="/wake"]')`, 'the card page, awake').then(() => check(true, 'Wake up: the card stays open on its page, awake'), e => check(false, e.message))
  await A.js("trommi.router.visit('/')")
  await A.until(`document.getElementById('row-${pile.snooze}')`, 'woken up', 15000).then(() => check(true, 'woken up from its card, back on the Desk'), e => check(false, e.message))
  await A.shot('e2e-pile.png')
  // ---- a session that moves to another desk takes its cards along: nothing of it stays on the old desk (open rows,
  //      infos, with the agents, the end list, Artifacts, the menu's count), and all of it is back after the move back ----
  {
    const made = await A.js("const r = await fetch('/desk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Zweiter Desk' }) }); return (await r.json()).desk?.id")
    // (with two desks and none chosen, the browser shows All desks: the test looks at the first desk, where the session stands)
    await A.until("trommi.model().desks.length === 2", 'two desks')
    const home = await A.js("return trommi.model().desks.find(d => d.id !== '" + made + "').id")
    await A.js(`trommi.router.visit('/?desk=${home}')`)
    await A.until(`!trommi.model().all && trommi.model().desk === '${home}' && document.querySelector('#inbox')`, 'the first desk in view')
    // (the desk lists: All Desks is the parent row, bold, with its own drawing; the desks set in under it)
    check(await A.js("const rows = [...document.querySelectorAll('#menu-desk-rows .menu-desk')], pad = a => parseFloat(getComputedStyle(a).paddingLeft); return rows.length === 3 && rows[0].matches('.is-all') && !!rows[0].querySelector('.menu-all-mark') && Number(getComputedStyle(rows[0].querySelector('b')).fontWeight) >= 700 && rows.slice(1).every(a => pad(a) <= pad(rows[0]) + 1 && !a.querySelector('.menu-all-mark') && Number(getComputedStyle(a.querySelector('b')).fontWeight) < 700 || a.getAttribute('aria-checked') === 'true') && !!document.querySelector('#menu-desk-rows ~ .menu-desk-add.is-plus, .menu-desks .menu-desk-add.is-plus')"), 'menu: All Desks bold with its own drawing, the desks flat under it in regular weight, New Desk a + on its row')
    const count = `(() => { const m = trommi.model(), of = l => l.filter(c => c.agent === '${sid}' || m.byAgent.get(c.agent)?.parent === '${sid}').length; return of(m.fresh) + of(m.reads) + of(m.revising) + of(m.snoozed) + of(m.done) })()`
    const before = await A.js(`return ${count}`)
    const move = to => A.js(`await fetch('/sessions/${sid}/edit', { method: 'POST', headers: { Accept: 'text/vnd.turbo-stream.html' }, body: new URLSearchParams({ stay: '1', moved: '1', desk: '${'${to}'}' }) })`.replace('${to}', to))
    await move(made)
    await A.until(`${count} === 0 && !document.querySelector('#agents [data-unit="${sid}"]') && !document.querySelector('#desk-list .inbox-row[data-from="${sid}"]') && !document.querySelector('#desk-end .end-row')`, 'the moved session and its cards left this desk', 10000).then(() => check(before > 0, `a session moved to another desk takes its cards along (${before} cards)`), e => check(false, e.message))
    await move(home)
    await A.until(`${count} === ${before}`, 'the cards are back with the session', 10000).then(() => check(true, 'moved back: its cards are on this desk again'), e => check(false, e.message))
  }
  // ---- the Whiteboard: the Desk has no paper; the drawing is a place of its own, on the room's one
  //      board (ROOM_BOARD, the core's scribble.ts) ----
  await A.js("trommi.router.visit('/')")
  await A.until("document.querySelector('#inbox')", 'desk again')
  await sleep(800)
  check(await A.js("return !document.querySelector('#deskpad, #deskpad-pen, #deskpad-clear, #paper-island, .clear-btn')"), 'the Desk has no paper under it, no pen and no wipe button')
  check(await A.js("return !!document.querySelector('.curl-grab') && !document.querySelector('#whiteboard-row, #desk-pad')"), 'the Scribble Board is the back of the Desk: its corner')
  // A stroke on the desk's canvas, sealed through the Whiteboard's openCanvas before it opens (as another device would).
  await A.js(`const { openCanvas, strokeFromWorld, ROOM_BOARD } = await trommi.view('whiteboard')
    const tl = ROOM_BOARD
    const c = await openCanvas({ client: trommi.client, timeline_id: tl })
    const k = strokeFromWorld({ pts: [120, 140, 220, 190, 340, 160], t: [0, 16, 33], f: [0.2, 0.3, 0.25], sim: true }, { tool: 'pen', color: 'ink', width: 4 })
    c.push([{ id: 'e2e-old-paper', before: null, after: { id: 'e2e-old-paper', pad: tl, type: 'stroke', rotation: 0, z: 1, group: null, author: 'human', rev: 1, blob: null, sent: [], ...k } }])
    for (let i = 0; i < 150 && c.state().pending; i++) await new Promise(r => setTimeout(r, 100))
    return c.state()`).then(st => check(!st.error && !st.pending, `a stroke on the desk's canvas timeline is sealed (${JSON.stringify(st)})`))
  await A.js("const g = document.querySelector('.curl-grab'), r = g.getBoundingClientRect(); for (const t of ['pointerdown', 'pointerup']) g.dispatchEvent(new PointerEvent(t, { bubbles: true, pointerId: 1, clientX: r.right - 8, clientY: r.top + 8 }))")
  await A.until("location.pathname === '/scribble-board' && window.pad", 'whiteboard page with the pad')
  const pad = 'window.pad'
  await A.until(`${pad}.elements().length >= 1`, 'the canvas stroke on the Whiteboard').then(() => check(true, 'a stroke of the desk canvas shows on the Whiteboard'), e => check(false, e.message))
  await A.until(`${pad}.state().board.sessions.some(s => s.id === '${sid}')`, 'sessions in the pad').then(() => check(true, 'the Whiteboard Send to… knows the sessions'), e => check(false, e.message))
  // Draw one stroke with the mouse, as a person does: it is kept and comes back after a reload.
  const r = await A.js("const b = document.getElementById('canvas').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }")
  await A.js(`${pad}.tool('pen')`)
  const mouse = (type, x, y) => A.page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 })
  await mouse('mouseMoved', r.x, r.y); await mouse('mousePressed', r.x, r.y)
  for (let i = 1; i <= 12; i++) await mouse('mouseMoved', r.x + i * 12, r.y + Math.sin(i / 2) * 20)
  await mouse('mouseReleased', r.x + 144, r.y)
  await A.until(`${pad}.elements().length >= 2 && !${pad}.state().sync.pending`, 'drawn stroke sealed').then(() => check(true, 'a stroke drawn on the Whiteboard is sealed'), e => check(false, e.message))
  await A.shot('e2e-whiteboard.png')
  await A.go(`${APP}/scribble-board`)
  await A.until("document.documentElement.hasAttribute('data-ready') && window.pad", 'whiteboard after reload', 30000)
  await A.until(`${pad}.elements().length >= 2`, 'strokes after reload', 20000).then(() => check(true, 'the Whiteboard strokes come back after a reload'), e => check(false, e.message))
  await A.js("trommi.router.visit('/')")
  await A.until("document.querySelector('#inbox')", 'desk after the whiteboard')
  await A.js("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }))")
  await A.until("location.pathname === '/scribble-board'", 'P leads to the Whiteboard', 5000).then(() => check(true, 'P on the Desk opens the Whiteboard'), e => check(false, e.message))

  // ---- a second human device joins: Settings, Invite a Device, Show Code; the code and the emoji in place ----
  await A.js("trommi.router.visit('/settings')")
  await A.until("document.querySelector('#settings-pair')", 'Settings with Invite a Device')
  await A.js("document.querySelector('#settings-pair').click()")
  await A.until("location.pathname === '/settings' && /pair=/.test(location.search) && document.querySelector('#set-device[data-state=open] .set-qr.is-real svg')", 'the code in place on the Settings list')
  check(true, 'Settings: Show Code makes the invite and shows the code in place')
  const humanLink = await A.js("return [...trommi.client.model.invites.values()].at(-1).link")
  B = await browser('B', 390, 844)
  await B.go(humanLink.replace(/^https?:\/\/[^/]+/, APP))
  await B.until("document.querySelector('#join-form')", 'join screen on B')
  await B.shot('e2e-6-join.png')
  await B.js("document.querySelector('#join-form input[name=device_name]').value = 'Phone'; document.querySelector('#join-form button').click()")
  await B.until("document.getElementById('check-code')", 'check code on B')
  const checkCode = await B.js("return document.getElementById('check-code').dataset.code")
  const shownB = await B.js("return [...document.querySelectorAll('#check-code .check-emoji-glyph')].map(e => e.textContent).join(' ')")
  check(/^\d\d(-\d\d){5}$/.test(checkCode) && shownB.split(' ').length === 6, 'B shows a check code of six emoji')
  await B.shot('e2e-7-check-code.png')
  await A.until("document.querySelector('[data-state=confirm_code] .check-emoji')", 'A shows the emoji to compare')
  await A.shot('e2e-8-compare-code.png')
  const shownA = await A.js("return [...document.querySelectorAll('[data-state=confirm_code] .check-emoji-glyph')].map(e => e.textContent).join(' ')")
  check(shownA === shownB && await A.js("return document.querySelectorAll('[data-state=confirm_code] .check-yes, [data-state=confirm_code] .check-no').length === 2"), 'A shows the same six emoji as B, with "They match" and "They don\'t match"')
  await A.js("document.querySelector('[data-state=confirm_code] .check-yes').click()")
  await A.until("location.pathname === '/settings' && document.querySelector('#set-device[data-state=joined]')", 'A: the new device is in, in place').then(() => check(true, 'Settings: "They match" in place, then the new device is in'), e => check(false, e.message))
  await B.until("document.documentElement.hasAttribute('data-ready') && trommi.client.model.room.connection === 'live'", 'B in the room', 20000)
  check(true, 'B joined with the check code')
  await B.until(`document.getElementById('row-${cardId}')`, 'B sees the card', 15000).then(() => check(true, 'B sees the same open card'), e => check(false, e.message))
  await B.shot('e2e-9-phone-desk.png')

  // ---- C: a fresh browser logs in with email + password ----
  C = await browser('C', 1280, 800)
  await C.go(`${APP}/?hub=${encodeURIComponent(HUB)}`)
  await C.until("document.querySelector('#way-login')", 'welcome on C')
  await C.js("document.querySelector('#way-login').click()")
  await C.until("document.querySelector('#login-form')", 'login screen on C')
  check(await C.js("return !!document.querySelector('#way-pair') && !!document.querySelector('#way-forgot')"), 'login offers scan and Forgot password')
  await C.js(`const f = document.querySelector('#login-form'); f.querySelector('input[name=email]').value = 'wrong-${EMAIL}'; f.querySelector('input[name=password]').value = '${password}'; f.querySelector('button[type=submit]').click()`)
  await C.until("document.querySelector('.room-error')?.textContent.includes('Email or password is wrong')", 'wrong login refused', 20000).then(() => check(true, 'unknown email: "Email or password is wrong."'), e => check(false, e.message))
  t0 = Date.now()
  await C.js(`const f = document.querySelector('#login-form'); f.querySelector('input[name=email]').value = '${EMAIL}'; f.querySelector('input[name=password]').value = '${password}'; f.querySelector('input[name=device_name]').value = 'Desktop'; f.querySelector('button[type=submit]').click()`)
  await C.until("document.documentElement.hasAttribute('data-ready') && trommi.client.model.room.connection === 'live'", 'C logged in', 30000)
  timing('log in with email + password -> live', Date.now() - t0)
  await C.until(`document.getElementById('row-${cardId}')`, 'C sees the card', 15000).then(() => check(true, 'C (email + password) sees the same open card'), e => check(false, e.message))
  await C.shot('e2e-9b-password-login.png')

  // ---- the agent closes the question (close_card, twice): its conversation says "Done" once, never "Question revised" ----
  await agent.close(cardId, 'Erledigt mit B')
  await agent.close(cardId, 'Erledigt mit B')
  await A.until(`trommi.client.model.cards.get('${cardId}')?.versions.length >= 3`, 'both closing versions on A', 15000)
  await A.js(`trommi.router.visit('/card/${nr}')`); await A.js(`trommi.router.visit('/s/${sid}')`)
  await A.until(`location.pathname === '/s/${sid}' && document.querySelector('.ask a[href$="/card/${nr}"]')`, 'session page after the close')
  const said = await A.js(`const mine = [...document.querySelectorAll('.event')].filter(e => e.getAttribute('href')?.endsWith('/card/${nr}') && e.offsetParent); return { done: mine.filter(e => e.querySelector('.event-kind')?.textContent === 'Done').length, revised: mine.filter(e => e.classList.contains('event-revised')).length }`)
  check(said.done === 1 && said.revised === 0, `a closed question shows "Done" once and no "Question revised" (${said.done} done, ${said.revised} revised)`)
  await A.js(`trommi.router.visit('/card/${nr}')`)
  await A.until("document.querySelector('#cardpage')", 'card page after the close')
  check(await A.js("return !document.querySelector('#cardpage .tc-turn[data-version]:not([data-version=\"1\"])')"), 'a closing version is no "Version n" on the card page')

  // ---- D: forgot password, with the Emergency Kit ----
  D = await browser('D', 390, 844)
  await D.go(`${APP}/?hub=${encodeURIComponent(HUB)}`)
  await D.until("document.querySelector('#way-login')", 'welcome on D')
  await D.js("document.querySelector('#way-login').click()")
  await D.until("document.querySelector('#way-forgot')", 'login on D')
  await D.js("document.querySelector('#way-forgot').click()")
  await D.until("document.querySelector('#forgot-form')", 'forgot screen')
  await D.js(`const f = document.querySelector('#forgot-form'); f.querySelector('input[name=email]').value = '${EMAIL}'; f.querySelector('textarea[name=words]').value = '${words}'; f.querySelector('input[name=password]').value = 'a brand new password'; f.querySelector('button[type=submit]').click()`)
  await D.until("document.documentElement.hasAttribute('data-ready') && trommi.client.model.room.connection === 'live'", 'D in with the kit', 30000).then(() => check(true, 'Forgot password: kit words + new password log D in'), e => check(false, e.message))
  await D.shot('e2e-9c-forgot.png')

  // ---- live: a message from the agent to the session, seen on B ----
  t0 = Date.now()
  const card2 = await agent.sendCard({ title: 'Info: Build fertig', body: 'Alles grün.', card_type: 'info' })
  // An info is no question, but it stands in the stack among them (#row-<id>, the page sign, What?? and the tick); Next does not count it.
  await B.until(`document.getElementById('row-${card2}')`, 'info in the stack on B')
  timing('info card sent -> visible on B', Date.now() - t0)
  check(await B.js(`return !!document.querySelector('#row-${card2} .inbox-answer.is-what') && !trommi.model().fresh.some(c => c.id === '${card2}')`), 'an info stands in the stack with its sign and is not counted in Next')
  // A reads it on the laptop (its tick), B sees the line leave.
  t0 = Date.now()
  await A.js("trommi.router.visit('/')")
  await A.until(`document.getElementById('row-${card2}')`, 'info on A')
  await A.js(`document.querySelector('#row-${card2} form[action$="/close"]').requestSubmit()`)
  await B.until(`!document.getElementById('row-${card2}')`, 'info gone on B after A read it').then(() => timing('read on A -> gone on B', Date.now() - t0), e => check(false, e.message))
  // Each info row: its sign, What?? and the tick; the tick reads it.
  const reads = [await agent.sendCard({ title: 'Info eins', card_type: 'info' }), await agent.sendCard({ title: 'Info zwei', card_type: 'info' })]
  await A.until(reads.map(id => `document.getElementById('row-${id}')`).join(' && '), 'two infos as lines on A')
  check(await A.js(`return ${JSON.stringify(reads)}.every(id => document.querySelector('#row-' + id + ' .inbox-answer.is-ack') && document.querySelector('#row-' + id + ' button[formaction$="/what"]'))`), 'each info row has its sign and What??')
  for (const id of reads) await A.js(`document.querySelector('#row-${id} form[action$="/close"]').requestSubmit()`)
  await B.until(`${reads.map(id => `!document.getElementById('row-${id}') && trommi.model().byCard.get('${id}')?.read`).join(' && ')}`, 'both ticked: lines gone on B, both read').then(() => check(true, 'ticking a line reads its info'), e => check(false, e.message))

  // ---- warm reload: the Desk paints from IndexedDB before the hub answers ----
  for (let i = 0; i < 30; i++) await agent.sendCard({ title: `Frage ${i}`, options: [{ key: 'a', label: 'Ja' }, { key: 'b', label: 'Nein' }] })
  await A.js("trommi.router.visit('/')")
  await A.until("document.querySelectorAll('.inbox-row').length >= 30", '30 more rows on A')
  await sleep(600)   // the core persists in batches
  await A.go(`${APP}/`)
  await A.until("document.documentElement.hasAttribute('data-ready')", 'reloaded')
  const warm = await A.js("return { first: trommi.firstPaintMs, rows: document.querySelectorAll('.inbox-row').length, conn: trommi.client.model.room.connection }")
  timing(`warm reload -> Desk painted (${warm.rows} rows, connection then: ${warm.conn})`, warm.first)
  check(warm.rows >= 30, 'warm reload shows the cards from local storage')
  // the stream after the reload is really live: another device posts, it arrives within 2 s
  await A.until("trommi.client.model.room.connection === 'live'", 'live after the reload')
  t0 = Date.now()
  const afterReload = await agent.sendCard({ title: 'nach dem Neuladen', card_type: 'info' })
  await A.until(`trommi.client.model.cards.has('${afterReload}')`, 'card after the reload', 2000).then(() => { check(true, 'a card sent after the warm reload arrives live within 2 s'); timing('card after the warm reload -> on A', Date.now() - t0) }, e => check(false, e.message))

  // ---- devices: B removes nobody; A sees both humans and the agent ----
  await A.js("trommi.router.visit('/settings/devices')")
  await A.until("document.querySelectorAll('.room-device').length >= 5", 'five devices listed')
  check(true, 'devices page lists laptop, phone, desktop, phone (kit), agent')
  await A.shot('e2e-10-devices.png')

  // ---- C logs out (Trommi menu -> Settings -> Account -> Log Out, asked once): removed from the member list, everything local gone ----
  const oldC = await C.js("return trommi.client.model.room.my_device_id")
  await C.js("document.getElementById('brand-menu').click()")
  await C.until("!document.getElementById('brand-doors').hidden && document.getElementById('menu-settings') && document.getElementById('push-toggle') && document.getElementById('keys-open') && !document.getElementById('menu-logout')", 'the menu: Settings and the icon row, no Log Out')
  check(true, 'the menu: desks, Settings, Push, Theme, Shortcuts, Demo; Log Out lives in Settings')
  await C.js("document.getElementById('brand-menu').click(); trommi.router.visit('/settings/account')")
  await C.until("document.getElementById('settings-logout')", 'Account with Log Out')
  await C.js("document.getElementById('settings-logout').click()")
  await C.until("document.getElementById('logout-ask')", 'log out asks')
  check(await C.js("return document.getElementById('logout-ask').textContent.trim() === 'Log out of this device? You can log in again with email and password.'"), 'Log out asks once, with the agreed sentence')
  await C.shot('e2e-11-logout-ask.png')
  t0 = Date.now()
  await C.js("document.getElementById('logout-go').click()")
  await C.until("document.querySelector('#way-create') && document.querySelector('#way-login')", 'start page after log out', 30000)
  timing('log out -> start page', Date.now() - t0)
  check(await C.js("return document.getElementById('logged-out')?.textContent.startsWith('Logged out. Nothing')"), 'start page: logged out, device removed')
  await C.shot('e2e-12-logged-out.png')
  const left = await C.js(`const dbs = indexedDB.databases ? await indexedDB.databases() : []
    let keys = 0
    for (const d of dbs) { const db = await new Promise((ok, no) => { const r = indexedDB.open(d.name); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error) }); for (const n of db.objectStoreNames) keys += await new Promise(ok => { const r = db.transaction(n).objectStore(n).count(); r.onsuccess = () => ok(r.result) }); db.close() }
    return { dbs: dbs.length, keys, local: localStorage.length, caches: (await caches.keys()).filter(n => !n.startsWith('shell-')).length }`)   // the worker fills its shell cache again (app files only)
  check(left.keys === 0 && left.local === 0 && left.caches === 0, `nothing local left after log out but the app shell (${JSON.stringify(left)})`)
  // A hears of it live (member_entry on the stream); the signed list says so either way.
  t0 = Date.now()
  const heard = await A.until(`trommi.client.model.members.get('${oldC}')?.is_active === false`, 'A sees C removed', 15000).then(() => true, () => false)
  if (heard) timing('log out on C -> removed on A (live)', Date.now() - t0)
  else {
    const probe = await agent.sendCard({ title: 'stream probe', card_type: 'info' })
    const live = await A.until(`trommi.client.model.cards.has('${probe}')`, 'probe', 8000).then(() => true, () => false)   // A is on /devices: no Desk rows there
    check(false, `A's live stream after the warm reload: ${live ? 'envelopes arrive, but no member_entry' : 'silent (no member_entry, no envelope), though the connection says live'}`)
    await A.js('await trommi.client.serial(() => trommi.client._refreshMembers())')
  }
  check(await A.js(`return trommi.client.model.members.get('${oldC}')?.is_active === false`), 'the logged-out device is removed in the signed member list (seen on A)')
  // and in again with email + password (D set a new one with the kit)
  await C.go(`${APP}/?hub=${encodeURIComponent(HUB)}`)
  await C.until("document.querySelector('#way-login')", 'welcome on C again')
  await C.js("document.querySelector('#way-login').click()")
  await C.until("document.querySelector('#login-form')", 'login screen on C again')
  await C.js(`const f = document.querySelector('#login-form'); f.querySelector('input[name=email]').value = '${EMAIL}'; f.querySelector('input[name=password]').value = 'a brand new password'; f.querySelector('input[name=device_name]').value = 'Desktop again'; f.querySelector('button[type=submit]').click()`)
  await C.until("document.documentElement.hasAttribute('data-ready') && trommi.client.model.room.connection === 'live'", 'C logged in again', 30000).then(() => check(true, 'log in again with email + password after log out'), e => check(false, e.message))
  check(await C.js(`return trommi.client.model.room.my_device_id !== '${oldC}' && trommi.client.model.members.get('${oldC}')?.is_active === false`), 'a new device id; the old one is removed in the member list')
} catch (err) {
  check(false, err.message)
  await A.shot('e2e-fail-A.png').catch(() => {})
  await B?.shot('e2e-fail-B.png').catch(() => {})
} finally {
  if (failed) {
    const st = c => c && { connection: c.model.room.connection, outbox: c.model.outbox.map(o => [o.envelope_kind, o.outbox_state, o.error]), blocked: c.model.room.outbox_blocked, alerts: c.model.alerts.slice(-6).map(a => [a.code, a.message?.slice(0, 120)]) }
    results.push('diag agent: ' + JSON.stringify(st(agent)))
    results.push('diag A: ' + JSON.stringify(await A.js("const c = window.trommi?.client; if (!c) return 'no client yet (no account open)'; return { connection: c.model.room.connection, outbox: c.model.outbox.map(o => [o.envelope_kind, o.outbox_state, o.error]), blocked: c.model.room.outbox_blocked, alerts: c.model.alerts.slice(-6).map(a => [a.code, a.message?.slice(0, 120)]) }").catch(e => e.message)))
  }
  for (const [name, X] of [['A', A], ['B', B], ['C', C], ['D', D]]) if (X) { const v = await X.js('return window.__csp ?? []').catch(() => []); check(!v.length, `${name}: no CSP violation on its last page${v.length ? ` (${v.slice(0, 3).join('; ')})` : ''}`) }
  for (const e of [...A.errors, ...(B?.errors ?? []), ...(C?.errors ?? []), ...(D?.errors ?? [])]) results.push(`err  ${e}`)
  agent?.stop?.()
  await A.close(); await B?.close(); await C?.close(); await D?.close()
}
console.log(results.join('\n'))
process.exit(failed ? 1 : 0)
