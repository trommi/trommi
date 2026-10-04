// End to end, with real crypto against a real hub: browser A creates an account (email + generated password,
// Emergency Kit), invites an agent (a Node process on the
// same client core), the agent files cards and status lines, A answers in the page, hands back, asks What??; a
// second browser B joins with the invite link and the check code typed on A, and sees the same Desk; a third browser C
// logs in with email + password, a fourth D with the Emergency Kit (forgot password); C logs out (removed from the
// member list, IndexedDB and caches empty) and logs in again.
//   node dev/e2e.mjs [--app http://127.0.0.1:8900] [--hub http://127.0.0.1:8890] [--shots dir] [--resolve 'MAP …']
// Prints timings (send -> visible on the other device) and exits 1 on a failure.
import { launchChromium } from './cdp.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { joinRoom, memoryStorage } from '../../../core/index.mjs'
import { execSync } from 'node:child_process'

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
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
  const js = async (code) => {
    const r = await page.send('Runtime.evaluate', { expression: `(async () => { ${code} })()`, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(`${name}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
    return r.result.value
  }
  const until = async (code, what, ms = 15000) => {
    const t = Date.now()
    while (Date.now() - t < ms) { if (await js(`return Boolean(${code})`).catch(() => false)) return Date.now() - t; await sleep(40) }
    throw new Error(`${name}: timed out waiting for ${what}`)
  }
  const go = async url => { await page.send('Page.navigate', { url }); await sleep(200) }
  const shot = async file => { if (!SHOTS) return; const s = await page.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, file), Buffer.from(s.data, 'base64')) }
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
  await A.js("trommi.router.visit('/settings')")
  await A.until(`document.getElementById('account-email')?.textContent === '${EMAIL.toLowerCase()}'`, 'account in Settings').then(() => check(true, 'Settings shows the account email'), e => check(false, e.message))
  check(await A.js("return document.querySelector('#account').textContent.includes('Make a new kit')"), 'Settings: kit made')
  await A.shot('e2e-2b-settings.png')

  // ---- A invites an agent from the empty Desk ("Invite your first agent"); the agent joins (no check code) ----
  await A.js("trommi.router.visit('/devices')")
  await A.until("document.querySelector('#agent-invite')", 'devices page with Invite an agent')
  await A.js("trommi.router.visit('/')")
  await A.until("document.querySelector('#desk-invite-go')", 'Invite your first agent on the empty Desk')
  check(await A.js("return !!document.querySelector('#agents #sidebar-invite[aria-label=\"Invite an agent\"]')"), 'sidebar has the + to invite an agent')
  await A.shot('e2e-3a-desk-invite.png')
  await A.js("document.querySelector('#desk-invite-go').click()")
  await A.until("location.pathname.startsWith('/pair/') && document.querySelector('[data-state=open]')", 'agent invite page')
  await A.shot('e2e-3-invite-agent.png')
  const link = await A.js("return [...trommi.client.model.invites.values()].at(-1).link")
  check(await A.js("return [...document.querySelectorAll('.room-cmd input')].some(i => /^curl -fsSL \\S+\\/connect \\| sh -s '\\S+\\/join#v1\\./.test(i.value))"), 'agent invite shows the connect command (curl …/connect | sh -s <link>)')
  check(link.startsWith(`${APP}/join#v1.`) || link.includes('/join#v1.'), 'agent invite link with the secret after #')
  const j = joinRoom({ link, storage: memoryStorage(), device_name: 'night-agent', device_info: { device_name: 'night-agent', platform: 'node', folder: '~/git/test', host: 'e2e' }, poll_ms: 100 })
  agent = await j.client
  agent.on('error', e => results.push(`note agent error: ${e?.code} ${e?.message}`))
  // One lease per process (R4): start() takes it under this process instance; a second claim under another instance
  // was a takeover of the agent's own stream (lease-lost on the stream, the answer never arrived).
  await agent.start({ process_instance: 'e2e' })
  // v1.1: an agent holds no room key; the app's core grants it a session once it joined.
  if (agent.whenSession) await Promise.race([agent.whenSession(), sleep(15000)])
  await agent.claimSession?.({ process_instance: 'e2e', agent_name: 'night-agent' }).catch(e => results.push(`note claimSession: ${e.message}`))
  await A.until("document.querySelector('[data-state=joined]')", 'agent joined on the invite page')
  check(true, 'agent added without a check code')
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
  check(await A.js("return !!document.querySelector('#agents .agent-row')"), 'session in the sidebar')
  check(await A.js("return !document.querySelector('#desk-invite') && !!document.querySelector('#agents #sidebar-invite')"), 'Invite your first agent gone once a session is there; the + stays')

  // ---- the desk switcher: the desk drawing (lamp on) opens the Trommi menu at its desk list, on the desk in view ----
  check(await A.js("return document.querySelector('.desk-go .desk-name')?.textContent === 'Desk' && !!document.querySelector('#desk-switch .lamp-light')"), 'Desk box: the desk name, the drawing with its lamp on')
  await A.js("document.getElementById('desk-switch').click()")
  await A.until("!document.getElementById('brand-doors').hidden && document.activeElement?.matches('#brand-doors .menu-desk[aria-checked=\"true\"]')", 'switcher opens the desk list', 3000).then(() => check(true, 'clicking the desk drawing opens the switcher on the desk in view'), e => check(false, e.message))
  check(await A.js("return document.getElementById('desk-switch').getAttribute('aria-expanded') === 'true' && document.getElementById('brand-doors').dataset.from === 'desk'"), 'switcher: expanded, the menu under the drawing')
  await A.js("document.getElementById('desk-switch').click()")
  check(await A.js("return document.getElementById('brand-doors').hidden && document.getElementById('desk-switch').getAttribute('aria-expanded') === 'false'"), 'a second click on the drawing closes it')
  await A.shot('e2e-4-desk-card.png')

  // ---- a card with a picture: uploaded encrypted, decrypted in A's page only when shown ----
  const png = fs.readFileSync(new URL('../public/mock/files/' + fs.readdirSync(new URL('../public/mock/files/', import.meta.url)).find(f => f.endsWith('.png')), import.meta.url))
  const ref = await agent.uploadAttachment(png, { file_name: 'entwurf.png', media_type: 'image/png', width: 1440, height: 900 })
  t0 = Date.now()
  const picCard = await agent.sendCard({ title: 'Welcher Entwurf?', body: 'Bild anbei.', options: [{ key: 'x', label: 'So' }, { key: 'y', label: 'Anders' }, { key: 'z', label: 'Später' }], attachments: [ref] })
  await A.until(`document.getElementById('row-${picCard}')`, 'picture card row')
  await A.until(`[...document.querySelectorAll('#row-${picCard} img')].some(i => i.complete && i.naturalWidth > 0)`, 'decrypted picture shown', 15000).then(() => { check(true, 'encrypted picture decrypted and shown on the Desk'); timing('picture card sent -> picture visible', Date.now() - t0) }, e => check(false, e.message))

  // ---- a card with a video: uploaded encrypted like a picture; on the card a <video> plays the decrypted blob ----
  const webm = fs.readFileSync(new URL('../public/mock/files/clip.webm', import.meta.url))
  const vref = await agent.uploadAttachment(webm, { file_name: 'ablauf.webm', media_type: 'video/webm' })
  const vidCard = await agent.sendCard({ title: 'Dieser Ablauf?', body: 'Video anbei.', options: [{ key: 'x', label: 'So' }, { key: 'y', label: 'Anders' }], attachments: [vref] })
  await A.until(`document.getElementById('row-${vidCard}')`, 'video card row')
  const vnr = await A.js(`return trommi.model().byCard.get('${vidCard}').number`)
  await A.js(`trommi.router.visit('/q/${vnr}')`)
  await A.until("document.querySelector('#cardpage .tc-video video[controls][playsinline]')", 'video player on the card').then(() => check(true, 'a video card shows a <video controls playsinline>'), e => check(false, e.message))
  await A.until("(v => v && v.readyState >= 1 && v.duration > 2.5)(document.querySelector('#cardpage .tc-video video'))", 'video decrypted, its metadata read', 15000).then(() => check(true, 'encrypted video decrypted: metadata (3 s) loaded'), e => check(false, e.message))
  check(await A.js("const v = document.querySelector('#cardpage .tc-video video'); return v.paused && !v.autoplay"), 'the video does not play by itself')
  await A.shot('e2e-4b-video-card.png')
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
  const undo = await A.js("const b = document.querySelector('#says-host .says-back'); if (b) { b.click(); return true } return false")
  if (undo) {
    await A.until(`document.getElementById('row-${cardId}')`, 'row back after Undo')
    check(true, 'Undo (decide again) puts the card back')
    const tu = Date.now(); while (!commands.some(c => c.command === 'decide_again') && Date.now() - tu < 10000) await sleep(30)
    check(commands.some(c => c.command === 'decide_again'), 'agent received decide_again')
  } else check(false, 'toast with Undo after answering')

  // ---- the card page: hand back (Revise) and What?? ----
  const nr = await A.js(`return trommi.model().byCard.get('${cardId}').number`)
  await A.js(`trommi.router.visit('/q/${nr}')`)
  await A.until("document.querySelector('#cardpage')", 'card page')
  await A.shot('e2e-5-card.png')
  t0 = Date.now()
  await A.js("document.querySelector('#cardpage button[formaction$=\"/what\"]').click()")
  const tw = Date.now(); while (!commands.some(c => c.command === 'message' && c.content?.explain) && Date.now() - tw < 10000) await sleep(30)
  check(commands.some(c => c.command === 'message' && c.content?.explain), 'agent received What?? (explain)')
  timing('What?? -> command at the agent', Date.now() - t0)
  check(await A.until("location.pathname === '/'", 'back on the Desk after What??').then(() => true, () => false), 'What?? goes back to the Desk, like the board')
  await agent.sendMessage({ object_id: cardId, text: 'Erklärung: A ist schneller, B ist sicherer.' })
  await A.js(`trommi.router.visit('/q/${nr}')`)
  await A.until("location.pathname.startsWith('/q/') && document.querySelector('#cardpage') && document.body.textContent.includes('B ist sicherer')", 'explanation in the card thread', 15000).then(() => check(true, 'agent reply shows in the card thread'), e => check(false, e.message))

  // ---- a file from the session's composer reaches the agent whole (encrypted, uploaded, decrypted there) ----
  const sid = await A.js("return trommi.model().agents[0]?.id")
  await A.js(`trommi.router.visit('/s/${sid}')`)
  await A.until("document.querySelector('form.composer input[type=file]')", 'composer')
  await A.js(`const f = document.querySelector('form.composer'); const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(4096).fill(7)], 'notiz.bin', { type: 'application/octet-stream' })); f.querySelector('input[type=file]').files = dt.files; f.querySelector('textarea').value = 'Mit Datei'; f.requestSubmit(f.querySelector('button[type=submit]'))`)
  const tf = Date.now(); let fileCmd = null
  while (!fileCmd && Date.now() - tf < 15000) { fileCmd = commands.find(c => c.command === 'message' && c.content?.attachments?.length); await sleep(50) }
  const bytes = fileCmd ? await agent.fetchAttachment(fileCmd.content.attachments[0]).catch(() => null) : null
  check(bytes?.length === 4096 && bytes[0] === 7, `a composer file reaches the agent whole (${bytes?.length ?? 'none'} bytes)`)

  // ---- a note: it lies on the Notes stack, plain; sent from there it reaches the agent marked as a note and stands in
  //      the session's chat taped on, from the optimistic echo on, never as a bubble ----
  const noteText = 'Notiz e2e: Backup vor der Migration'
  await A.js(`const now = Date.now(); await trommi.client.saveMemo({ text: '${noteText}', x: 0, y: 0, place: 'stack', desk_id: trommi.board.desk ?? 'main', created_at: now, updated_at: now })`)
  await A.js("trommi.router.visit('/')")
  await A.until("document.querySelector('[data-stack=notes]:not(.is-empty) .stack-stamp-num')?.textContent === '1'", 'NOTES 1 on the Desk').then(() => check(true, 'a new note lies on the Notes stack'), e => check(false, e.message))
  check(await A.js("return !document.querySelector('#memo-open .memo-count:not(.memo-count-phone)')"), 'the memo button carries no count of its own')
  await A.js("document.querySelector('[data-stack=notes] .inbox-stack-head').click()")
  await A.until("document.querySelector('[data-stack=notes].is-open .note-send select')", 'Notes stack open')
  await A.js(`window.__bubbled = false; new MutationObserver(() => { if ([...document.querySelectorAll('.msg-user .bubble')].some(b => b.textContent.includes('${noteText}'))) window.__bubbled = true }).observe(document.documentElement, { childList: true, subtree: true }); const f = document.querySelector('[data-stack=notes] .note-send'); f.querySelector('select').value = '${sid}'; f.requestSubmit(f.querySelector('button'))`)
  await A.js(`trommi.router.visit('/s/${sid}')`)
  const tn = Date.now(); let noteCmd = null
  while (!noteCmd && Date.now() - tn < 15000) { noteCmd = commands.find(c => c.command === 'message' && c.content?.text === noteText); await sleep(50) }
  check(/^[0-9a-f]{32}$/.test(noteCmd?.content?.memo?.object_id ?? '') && Number.isSafeInteger(noteCmd?.content?.memo?.written_at), 'a sent note reaches the agent with memo { object_id, written_at }')
  await A.until(`[...document.querySelectorAll('.msg-note p')].some(p => p.textContent.includes('${noteText}'))`, 'taped note in the chat').then(() => check(true, 'the sent note stands taped in the session chat'), e => check(false, e.message))
  await sleep(1500)
  check(await A.js(`return !window.__bubbled && [...document.querySelectorAll('.msg-note p')].some(p => p.textContent.includes('${noteText}'))`), 'the taped note never turns into a bubble (echo -> hub copy)')
  check(await A.js("return !trommi.model().state.memos.some(m => m.text.startsWith('Notiz e2e'))"), 'the sent note left the Notes stack')
  await A.shot('e2e-note-taped.png')

  // ---- the pile "Off the desk": one pile for every card that left the open rows (snoozed, in the works, done, trash);
  //      folded it shows the newest five with their signs; unfolded: filter chips with counts, and every way back ----
  const pile = {}
  for (const [k, title] of [['snooze', 'Stapel: später'], ['shred', 'Stapel: weg'], ['revise', 'Stapel: erklären'], ['done', 'Stapel: erledigt'], ['acting', 'Stapel: beantwortet']]) pile[k] = await agent.sendCard({ title, options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] })
  await A.js("trommi.router.visit('/')")
  await A.until(Object.values(pile).map(id => `document.getElementById('row-${id}')`).join(' && '), 'four pile cards on the Desk')
  // snoozed from its row; the toast's Undo fetches it back; snoozed again
  await A.js(`const f = document.querySelector('#row-${pile.snooze} form[action$="/snooze"]'); f.requestSubmit()`)
  await A.until(`!document.getElementById('row-${pile.snooze}')`, 'snoozed row leaves')
  await A.until("document.querySelector('#says-host .says-back')", 'toast with Undo after Snooze')
  await A.js("document.querySelector('#says-host .says-back').click()")
  await A.until(`document.getElementById('row-${pile.snooze}')`, 'row back after Undo of Snooze').then(() => check(true, 'Undo of Snooze puts the card back'), e => check(false, e.message))
  await A.js(`const f = document.querySelector('#row-${pile.snooze} form[action$="/snooze"]'); f.requestSubmit()`)
  await A.until(`!document.getElementById('row-${pile.snooze}')`, 'snoozed row leaves again')
  // answered, then closed by its session: Done
  await A.js(`document.querySelector('#row-${pile.done} form[action$="/decide"] button[value="a"], #row-${pile.done} button[name=key][value=a]')?.click()`)
  await A.until(`!document.getElementById('row-${pile.done}')`, 'answered row leaves')
  const td = Date.now(); while (!commands.some(c => c.command === 'answer' && c.object_id === pile.done) && Date.now() - td < 10000) await sleep(30)
  await agent.close(pile.done, 'erledigt')
  // answered, its session still at it: Working
  await A.js(`document.querySelector('#row-${pile.acting} form[action$="/decide"] button[value="a"], #row-${pile.acting} button[name=key][value=a]')?.click()`)
  await A.until(`!document.getElementById('row-${pile.acting}')`, 'answered row leaves')
  // shredded and handed back from the card page
  for (const [k, way] of [['shred', 'shred'], ['revise', 'what']]) {
    const n = await A.js(`return trommi.model().byCard.get('${pile[k]}').number`)
    await A.js(`trommi.router.visit('/q/${n}')`)
    await A.until(`document.querySelector('#cardpage button[formaction$="/${way}"]')`, `card page with ${way}`)
    await A.js(`document.querySelector('#cardpage button[formaction$="/${way}"]').click()`)
    await A.until("location.pathname === '/'", `back on the Desk after ${way}`).catch(() => A.js("trommi.router.visit('/')"))
  }
  await A.until(`document.querySelector('#desk-stacks [data-pile=off]') && ['${pile.snooze}', '${pile.shred}', '${pile.revise}'].every(id => document.querySelector('#desk-stacks .off-line[data-id="' + id + '"]')) && document.querySelector('#desk-stacks .off-line[data-id="${pile.done}"][data-g=done]')`, 'all four in the pile', 20000)
    .then(() => check(true, 'snoozed, shredded, asked (What??) and done cards all lie in the one pile'), e => check(false, e.message))
  check(await A.js("return !document.querySelector('#desk-stacks [data-stack=later], #desk-stacks [data-stack=works], #desk-stacks [data-stack=done], #desk-stacks [data-stack=trash]')"), 'no separate Snooze / Working / Done / Trash stacks any more')
  check(await A.js("const s = [...document.querySelectorAll('.off-fan .off-sheet')]; return s.length >= 4 && s.length <= 5 && s.every(x => x.querySelector('.off-sign'))"), 'the folded pile shows the newest sheets, each with its sign')
  const g = await A.js(`return Object.fromEntries(['${pile.snooze}', '${pile.shred}', '${pile.revise}', '${pile.done}'].map(id => [id, document.querySelector('.off-line[data-id="' + id + '"]')?.dataset.g]))`)
  check(g[pile.snooze] === 'later' && g[pile.shred] === 'trash' && g[pile.revise] === 'works' && g[pile.done] === 'done', `each card in its place (${Object.values(g).join(', ')})`)
  await A.js("document.querySelector('.off-head').click()")
  await A.until("document.querySelector('.off-pile.is-open .off-chips')", 'pile unfolded')
  const counts = await A.js("return Object.fromEntries([...document.querySelectorAll('.off-chip')].map(c => [c.dataset.g, Number(c.querySelector('b').textContent)]))")
  check(counts.all === counts.later + counts.works + counts.done + counts.trash && counts.later >= 1 && counts.works >= 1 && counts.done >= 1 && counts.trash >= 1, `filter chips count every place (${JSON.stringify(counts)})`)
  await A.js("document.querySelector('.off-chip[data-g=trash] input').click()")
  check(await A.js("const shown = [...document.querySelectorAll('.off-list .off-line')].filter(l => l.getClientRects().length); return shown.length > 0 && shown.every(l => l.dataset.g === 'trash')"), 'the Trash chip shows only the trash')
  // every way back: restore from Trash, Wake up, Take back (asked), Take back (answered). (A card its session closed
  // lies on Done; its Take back is a decide-again the core does not count, as before the pile.)
  for (const [k, what] of [['shred', 'restored from Trash'], ['snooze', 'woken up'], ['revise', 'taken back from What?? (in the works)'], ['acting', 'taken back after answering (in the works)']]) {
    await A.until(`document.querySelector('.off-pile.is-open')`, 'pile still open').catch(() => A.js("document.querySelector('.off-head').click()"))
    await A.js(`const f = document.querySelector('.off-line[data-id="${pile[k]}"] form'); f.requestSubmit(f.querySelector('button'))`)
    await A.until(`document.getElementById('row-${pile[k]}') && !document.querySelector('.off-line[data-id="${pile[k]}"]')`, what, 15000).then(() => check(true, `pile: ${what}, back on the Desk`), e => check(false, e.message))
  }
  check(await A.js("return document.querySelector('.off-pile.is-open') && document.querySelector('.off-chip[data-g=trash] input').checked"), 'the pile stays open with its filter while cards move')
  await A.shot('e2e-pile.png')

  // ---- a second human device joins ----
  await A.js("trommi.router.visit('/devices')")
  await A.until("document.querySelector('form[action=\"/pair\"] input[value=human]')", 'devices')
  await A.js("document.querySelector('form[action=\"/pair\"] input[value=human]').form.requestSubmit()")
  await A.until("location.pathname.startsWith('/pair/') && document.querySelector('[data-state=open]')", 'human invite page')
  const humanLink = await A.js("return [...trommi.client.model.invites.values()].at(-1).link")
  B = await browser('B', 390, 844)
  await B.go(humanLink.replace(/^https?:\/\/[^/]+/, APP))
  await B.until("document.querySelector('#join-form')", 'join screen on B')
  await B.shot('e2e-6-join.png')
  await B.js("document.querySelector('#join-form input[name=device_name]').value = 'Phone'; document.querySelector('#join-form button').click()")
  await B.until("document.getElementById('check-code')", 'check code on B')
  const checkCode = (await B.js("return document.getElementById('check-code').textContent")).replace(/\D/g, '')
  check(/^\d{6}$/.test(checkCode), 'B shows a six-digit check code')
  await B.shot('e2e-7-check-code.png')
  await A.until("document.querySelector('[data-state=confirm_code] .room-choice')", 'A asks which code B shows')
  await A.shot('e2e-8-type-code.png')
  check(await A.js(`return document.querySelectorAll('[data-state=confirm_code] .room-choice').length === 4 && [...document.querySelectorAll('[data-state=confirm_code] input[name=code]')].filter(i => i.value === '${checkCode}').length === 1`), 'A offers four codes, one of them B\'s')
  await A.js(`[...document.querySelectorAll('[data-state=confirm_code] input[name=code]')].find(i => i.value === '${checkCode}').form.querySelector('button').click()`)
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
  await A.js(`trommi.router.visit('/q/${nr}')`); await A.js(`trommi.router.visit('/s/${sid}')`)
  await A.until(`location.pathname === '/s/${sid}' && document.querySelector('.ask a[href$="/q/${nr}"]')`, 'session page after the close')
  const said = await A.js(`const mine = [...document.querySelectorAll('.event')].filter(e => e.getAttribute('href')?.endsWith('/q/${nr}') && e.offsetParent); return { done: mine.filter(e => e.querySelector('.event-kind')?.textContent === 'Done').length, revised: mine.filter(e => e.classList.contains('event-revised')).length }`)
  check(said.done === 1 && said.revised === 0, `a closed question shows "Done" once and no "Question revised" (${said.done} done, ${said.revised} revised)`)
  await A.js(`trommi.router.visit('/q/${nr}')`)
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
  // An info is no question: it stands in the news strip above the Desk (#read-<id>), not as a row, and Next does not count it.
  await B.until(`document.getElementById('read-${card2}')`, 'info in the news strip on B')
  timing('info card sent -> visible on B', Date.now() - t0)
  check(await B.js(`return !document.getElementById('row-${card2}') && !trommi.model().fresh.some(c => c.id === '${card2}')`), 'an info is not a Desk row and not counted in Next')
  // A reads it on the laptop (its tick), B sees the line leave.
  t0 = Date.now()
  await A.js("trommi.router.visit('/')")
  await A.until(`document.getElementById('read-${card2}')`, 'info on A')
  await A.js(`document.querySelector('#read-${card2} form[action$="/close"]').requestSubmit()`)
  await B.until(`!document.getElementById('read-${card2}')`, 'info gone on B after A read it').then(() => timing('read on A -> gone on B', Date.now() - t0), e => check(false, e.message))
  // The news are bare lines: a box to tick and the title; no header, count, sender, time or "All read". Each box reads its info.
  const reads = [await agent.sendCard({ title: 'Info eins', card_type: 'info' }), await agent.sendCard({ title: 'Info zwei', card_type: 'info' })]
  await A.until(reads.map(id => `document.getElementById('read-${id}')`).join(' && '), 'two infos as lines on A')
  check(await A.js("return !document.querySelector('#desk-news :is(h3, .news-head, .news-all, .news-who, .news-ago, [data-ts])')"), 'the news lines carry no header, count, sender, time or All read')
  for (const id of reads) await A.js(`document.querySelector('#read-${id} form[action$="/close"]').requestSubmit()`)
  await B.until(`${reads.map(id => `!document.getElementById('read-${id}') && trommi.model().byCard.get('${id}')?.read`).join(' && ')}`, 'both ticked: lines gone on B, both read').then(() => check(true, 'ticking a line reads its info'), e => check(false, e.message))

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
  await A.js("trommi.router.visit('/devices')")
  await A.until("document.querySelectorAll('.room-device').length >= 5", 'five devices listed')
  check(true, 'devices page lists laptop, phone, desktop, phone (kit), agent')
  await A.shot('e2e-10-devices.png')

  // ---- C logs out (Trommi menu -> Log out, asked once): removed from the member list, everything local gone ----
  const oldC = await C.js("return trommi.client.model.room.my_device_id")
  await C.js("document.getElementById('brand-menu').click()")
  await C.until("!document.getElementById('brand-doors').hidden && document.getElementById('menu-logout')", 'menu with Log out')
  await C.js("document.getElementById('menu-logout').click()")
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
  for (const e of [...A.errors, ...(B?.errors ?? []), ...(C?.errors ?? []), ...(D?.errors ?? [])]) results.push(`err  ${e}`)
  agent?.stop?.()
  await A.close(); await B?.close(); await C?.close(); await D?.close()
}
console.log(results.join('\n'))
process.exit(failed ? 1 : 0)
