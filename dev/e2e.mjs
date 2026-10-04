// End to end, with real crypto against a real hub: browser A founds a room, invites an agent (a Node process on the
// same client core), the agent files cards and status lines, A answers in the page, hands back, asks What??; a
// second browser B joins with the invite link and the check code typed on A, and sees the same Desk.
//   node dev/e2e.mjs [--app http://127.0.0.1:8900] [--hub http://127.0.0.1:8890] [--shots dir] [--resolve 'MAP …']
// Prints timings (send -> visible on the other device) and exits 1 on a failure.
import { launchChromium } from './cdp.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { joinRoom, memoryStorage } from '../public/vendor/index.mjs'

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback }
const APP = arg('--app', 'http://127.0.0.1:8900'), HUB = arg('--hub', 'http://127.0.0.1:8890'), SHOTS = arg('--shots', null), RESOLVE = arg('--resolve', null)
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
  page.on('Runtime.consoleAPICalled', e => { if (e.type === 'error') errors.push(`${name} console: ${e.args.map(a => a.value ?? a.description ?? '').join(' ')}`) })
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
let B = null, agent = null
try {
  // ---- A founds the room ----
  await A.go(`${APP}/?hub=${encodeURIComponent(HUB)}`)
  await A.until("document.querySelector('#found-form')", 'welcome screen')
  await A.shot('e2e-1-welcome.png')
  await A.js("document.querySelector('#found-form input[name=device_name]').value = 'Laptop'; document.querySelector('#found-form button[type=submit]').click()")
  await A.until("document.getElementById('recovery-code')", 'recovery code')
  const code = await A.js("return document.getElementById('recovery-code').textContent")
  check(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){12}$/.test(code), 'recovery code shown once, in its format')
  await A.shot('e2e-2-recovery.png')
  await A.js("document.querySelector('#recovery-form input[name=kept]').click(); document.querySelector('#recovery-form button').click()")
  await A.until("document.documentElement.hasAttribute('data-ready') && trommi.client.model.room.connection === 'live'", 'room live')
  check(await A.js("return document.title === 'Desk · Trommi' && !!document.querySelector('#inbox')"), 'empty Desk after founding')

  // ---- A invites an agent; the agent joins (no check code) ----
  await A.js("trommi.router.visit('/devices')")
  await A.until("document.querySelector('form[action=\"/pair\"] input[value=agent]')", 'devices page')
  await A.js("document.querySelector('form[action=\"/pair\"] input[value=agent]').form.requestSubmit()")
  await A.until("location.pathname.startsWith('/pair/') && document.querySelector('[data-state=open]')", 'agent invite page')
  await A.shot('e2e-3-invite-agent.png')
  const link = await A.js("return [...trommi.client.model.invites.values()].at(-1).link")
  check(link.startsWith(`${APP}/join#v1.`) || link.includes('/join#v1.'), 'agent invite link with the secret after #')
  const j = joinRoom({ link, storage: memoryStorage(), device_name: 'night-agent', device_info: { device_name: 'night-agent', platform: 'node', folder: '~/git/test', host: 'e2e' }, poll_ms: 100 })
  agent = await j.client
  await agent.start()
  await agent.claimSession?.({ process_instance: 'e2e', agent_name: 'night-agent' }).catch(e => results.push(`note claimSession: ${e.message}`))
  await A.until("document.querySelector('[data-state=joined]')", 'agent joined on the invite page')
  check(true, 'agent added without a check code')
  const commands = []
  agent.on('command', c => commands.push(c))
  await agent.setStatus({ 'status_line/tests': { label: 'Tests', state: 'working', detail: '12/40' }, profile: { model: 'claude-opus-5-5', task: 'E2E-Test', icon: 'draw:flask', agent_name: 'night-agent' } })

  // ---- a card: agent -> A, measured ----
  await A.js("trommi.router.visit('/')")
  await A.until("document.querySelector('#inbox')", 'desk')
  let t0 = Date.now()
  const cardId = await agent.sendCard({ title: 'Welche Variante bauen?', body: 'Zwei Wege, beide getestet.', options: [{ key: 'a', label: 'Variante A' }, { key: 'b', label: 'Variante B' }], recommended: 'b' })
  await A.until(`document.getElementById('row-${cardId}')`, 'card row on the Desk')
  timing('card sent by agent -> row visible on A', Date.now() - t0)
  check(await A.js("return !!document.querySelector('#agents .agent-row')"), 'session in the sidebar')
  await A.shot('e2e-4-desk-card.png')

  // ---- a card with a picture: uploaded encrypted, decrypted in A's page only when shown ----
  const png = fs.readFileSync(new URL('../public/mock/files/' + fs.readdirSync(new URL('../public/mock/files/', import.meta.url)).find(f => f.endsWith('.png')), import.meta.url))
  const ref = await agent.uploadAttachment(png, { file_name: 'entwurf.png', media_type: 'image/png', width: 1440, height: 900 })
  t0 = Date.now()
  const picCard = await agent.sendCard({ title: 'Welcher Entwurf?', body: 'Bild anbei.', options: [{ key: 'x', label: 'So' }, { key: 'y', label: 'Anders' }, { key: 'z', label: 'Später' }], attachments: [ref] })
  await A.until(`document.getElementById('row-${picCard}')`, 'picture card row')
  await A.until(`[...document.querySelectorAll('#row-${picCard} img')].some(i => i.complete && i.naturalWidth > 0)`, 'decrypted picture shown', 15000).then(() => { check(true, 'encrypted picture decrypted and shown on the Desk'); timing('picture card sent -> picture visible', Date.now() - t0) }, e => check(false, e.message))

  // ---- A answers with the row's tile; the agent gets the command ----
  t0 = Date.now()
  await A.js(`document.querySelector('#row-${cardId} form[action$="/decide"] button[value="b"], #row-${cardId} button[name=key][value=b]')?.click()`)
  await A.until(`!document.getElementById('row-${cardId}')`, 'row leaves after answering')
  timing('answer click -> row gone (local echo)', Date.now() - t0)
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
  await A.until("document.querySelector('[data-state=confirm_code] input[name=code]')", 'A asks for the code')
  await A.shot('e2e-8-type-code.png')
  await A.js(`const i = document.querySelector('[data-state=confirm_code] input[name=code]'); i.value = '${checkCode}'; i.form.requestSubmit()`)
  await B.until("document.documentElement.hasAttribute('data-ready') && trommi.client.model.room.connection === 'live'", 'B in the room', 20000)
  check(true, 'B joined with the check code')
  await B.until(`document.getElementById('row-${cardId}')`, 'B sees the card', 15000).then(() => check(true, 'B sees the same open card'), e => check(false, e.message))
  await B.shot('e2e-9-phone-desk.png')

  // ---- live: a message from the agent to the session, seen on B ----
  t0 = Date.now()
  const card2 = await agent.sendCard({ title: 'Info: Build fertig', body: 'Alles grün.', card_type: 'info' })
  await B.until(`document.getElementById('row-${card2}')`, 'info card on B')
  timing('info card sent -> visible on B', Date.now() - t0)
  // A answers on the laptop, B sees the row leave.
  t0 = Date.now()
  await A.js("trommi.router.visit('/')")
  await A.until(`document.getElementById('row-${card2}')`, 'info on A')
  await A.js(`const f = document.querySelector('#row-${card2} form[action$="/close"]'); f ? f.requestSubmit() : document.querySelector('#row-${card2} button[formaction$="/close"]')?.click()`)
  await B.until(`!document.getElementById('row-${card2}')`, 'info gone on B after A read it').then(() => timing('read on A -> gone on B', Date.now() - t0), e => check(false, e.message))

  // ---- devices: B removes nobody; A sees both humans and the agent ----
  await A.js("trommi.router.visit('/devices')")
  await A.until("document.querySelectorAll('.room-device').length >= 3", 'three devices listed')
  check(true, 'devices page lists laptop, phone, agent')
  await A.shot('e2e-10-devices.png')
} catch (err) {
  check(false, err.message)
  await A.shot('e2e-fail-A.png').catch(() => {})
  await B?.shot('e2e-fail-B.png').catch(() => {})
} finally {
  for (const e of [...A.errors, ...(B?.errors ?? [])]) results.push(`err  ${e}`)
  agent?.stop?.()
  await A.close(); await B?.close()
}
console.log(results.join('\n'))
process.exit(failed ? 1 : 0)
