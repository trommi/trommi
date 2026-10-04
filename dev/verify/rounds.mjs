#!/usr/bin/env node
// Every decision round trip agent <-> human, end to end and encrypted: the agent is hub/channel.mjs (the real MCP
// stdio channel, as Claude Code starts it), the human is the new app in headless Chromium, between them a real hub
// (hub/server.mjs, own port 8891-8899, throwaway data). The human acts only through the app's UI (clicks, forms,
// keys); every step waits for what the other side must see, and times it.
//   node dev/verify/rounds.mjs [--app http://127.0.0.1:8900] [--out DIR] [--only r1,r2] [--hosts "MAP …"]
//        [--hub URL]  use a running hub instead of starting one (e.g. https://hub.trommi.com: a test room is founded)
// Prints one line per check and per timing, writes DIR/rounds.json and a screenshot per round (DIR/rounds/*.png).
// Exit 1 when a check failed. Needs the command sandbox disabled (Chromium).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startHub, startChannel } from '../../hub/channel-test-e2e.mjs'
import { FIXTURES } from '../../server/fixtures.mjs'
import { arg, openPage, sleep } from './lib.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const APP = arg('app', 'http://127.0.0.1:8900')
const OUT = path.resolve(arg('out', fs.mkdtempSync(path.join(os.tmpdir(), 'verify-rounds-'))))
const only = (arg('only') ?? '').split(',').filter(Boolean)
fs.mkdirSync(path.join(OUT, 'rounds'), { recursive: true })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-rounds-tmp-'))

const results = []
let failed = 0
const say = line => { console.log(line); results.push(line) }
const check = (ok, what, extra = '') => { say(`${ok ? 'ok  ' : 'FAIL'} ${what}${extra ? ` (${extra})` : ''}`); if (!ok) failed++; return ok }
const times = {}
const timing = (what, ms) => { times[what] = Math.round(ms); say(`time ${what}: ${Math.round(ms)} ms`) }

const hub = arg('hub') ? { hub_url: arg('hub'), stop: () => {} } : await startHub(tmp)
const keys = path.join(tmp, 'keys'), project = path.join(tmp, 'project')
fs.mkdirSync(project, { recursive: true })
const errors = []
const h = await openPage({ profile: 'desktop-light', base: APP, hostRules: arg('hosts') ?? '', errors })
let ch = null
const ev = (kind, id) => e => e.method === 'notifications/claude/channel' && e.params.meta?.kind === kind && (!id || e.params.meta.card_id === id)
const anyFor = id => e => e.method === 'notifications/claude/channel' && e.params.meta?.card_id === id
const until = async (js, what, ms = 15000) => { const t = Date.now(); const v = await h.waitFor(`return Boolean(${js})`, ms); if (!v) throw new Error(`timed out (${ms} ms): ${what}`); return Date.now() - t }
const visit = async p => { await h.ev(`trommi.router.visit(${JSON.stringify(p)}); return 1`); await sleep(300) }
const nrOf = id => h.ev(`return trommi.model().byCard.get(${JSON.stringify(id)})?.number ?? null`)
const idOf = text => (/(?:card|info) ([0-9a-f]{32})/.exec(text) ?? [])[1]
async function nextEvent(pred, what, ms = 15000) {
  const t = Date.now()
  for (;;) {
    const e = ch.events.find(x => !x.seen && pred(x))
    if (e) { e.seen = true; return e }
    if (Date.now() - t > ms) throw new Error(`timed out (${ms} ms): agent event ${what}`)
    await sleep(25)
  }
}
async function openCard(id) { const nr = await nrOf(id); await visit(`/q/${nr}`); await until(`location.pathname === '/q/${nr}' && document.querySelector('.tc-card')`, `card page ${nr}`); return nr }
async function rowVisible(id, what) { const t = Date.now(); await visit('/'); await until(`document.getElementById('row-${id}')`, `${what}: row on the Desk`); return Date.now() - t }
async function timedCard(tool, args, what) {
  const t0 = Date.now()
  const id = idOf(await ch.call(tool, args))
  if (!id) throw new Error(`${tool} gave no id`)
  await until(`trommi.model().byCard.get('${id}')`, `${what}: card in the app's model`)
  timing(`${what}: ${tool} -> in the app`, Date.now() - t0)
  return id
}
const clickJs = async (sel, what) => { const ok = await h.ev(`const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true`); if (!ok) throw new Error(`nothing to press: ${what} (${sel})`) }
const shot = name => h.shot(path.join(OUT, 'rounds', `${name}.png`))

const ROUNDS = {
  async r01_answer_close() {
    const id = await timedCard('create_decision', { title: 'Migration heute Nacht?', body: 'Sperrt 40 s.', options: [{ key: 'tonight', label: 'Heute Nacht' }, { key: 'now', label: 'Jetzt' }], recommended: 'tonight' }, 'decision')
    await openCard(id)
    check(await h.ev(`return !!document.querySelector('.tc-opt.is-advised[data-key="tonight"]')`), 'recommended option is marked')
    await shot('r01-card')
    const t0 = Date.now()
    await clickJs('.tc-opt[data-key="now"]', 'option now')
    const e = await nextEvent(ev('decision', id), 'decision')
    timing('answer click -> decision event at the agent', Date.now() - t0)
    check(e.params.meta.choice === 'now', 'agent gets choice "now"', JSON.stringify(e.params.meta))
    await ch.call('close_card', { card_id: id, summary: 'Migration läuft jetzt' })
    const nr = await nrOf(id)
    await visit(`/q/${nr}`)
    await until(`document.body.textContent.includes('Migration läuft jetzt')`, 'summary of close_card on the card page').then(() => check(true, 'close_card summary shows on the card'), err => check(false, err.message))
    await shot('r01-closed')
  },
  async r02_decide_again() {
    const id = await timedCard('create_decision', { title: 'Port 8790 behalten?', options: [{ key: 'yes', label: 'Ja' }, { key: 'no', label: 'Nein' }] }, 'decide-again')
    await openCard(id)
    await clickJs('.tc-opt[data-key="yes"]', 'yes')
    await nextEvent(ev('decision', id), 'decision')
    const undo = await h.waitFor(`return !!document.querySelector('#says-host .says-back')`, 4000)
    check(undo, 'toast with Undo after answering')
    await shot('r02-toast')
    if (undo) {
      const t0 = Date.now()
      await clickJs('#says-host .says-back', 'Undo')
      const e = await nextEvent(ev('decision_reopened', id), 'decision_reopened')
      timing('Undo -> decision_reopened at the agent', Date.now() - t0)
      check(e.params.meta.previous_choice === 'yes', 'decision_reopened names the previous choice', JSON.stringify(e.params.meta))
    }
    // decide again from the answered card's own button (reopen)
    await clickJs('.tc-opt[data-key="no"]', 'no').catch(async () => { await openCard(id); await clickJs('.tc-opt[data-key="no"]', 'no') })
    await nextEvent(ev('decision', id), 'decision (2)')
    await openCard(id)
    const reopen = await h.ev(`const b = [...document.querySelectorAll('button.tc-way')].find(b => /reopen$/.test(b.getAttribute('formaction') ?? '')); if (!b) return false; b.click(); return true`)
    check(reopen, 'answered card has a "decide again" button')
    if (reopen) { const e = await nextEvent(ev('decision_reopened', id), 'decision_reopened (button)').catch(() => null); check(Boolean(e), 'decide again button -> decision_reopened') }
  },
  async r03_multiple() {
    const id = await timedCard('create_decision', { title: 'Was in den Wochenbericht?', multiple: true, options: [{ key: 'perf', label: 'Messwerte' }, { key: 'bugs', label: 'Fehler' }, { key: 'plan', label: 'Plan' }] }, 'multiple')
    await openCard(id)
    check(await h.ev(`return document.querySelectorAll('.tc-opt input[type=checkbox]').length === 3`), 'three ticks')
    await clickJs('.tc-opt[data-key="perf"] input', 'tick perf'); await clickJs('.tc-opt[data-key="plan"] input', 'tick plan')
    await shot('r03-ticked')
    const t0 = Date.now()
    await clickJs('.tc-send-many', 'send the answer')
    const e = await nextEvent(ev('decision', id), 'decision (multiple)')
    timing('multiple answer -> event', Date.now() - t0)
    const got = String(e.params.meta.choices ?? e.params.meta.choice ?? '')
    check(/perf/.test(got) && /plan/.test(got) && !/bugs/.test(got), 'agent gets both ticked keys', JSON.stringify(e.params.meta))
  },
  async r04_sections() {
    const f = FIXTURES.find(x => x.kind === 'sections')
    const args = { ...f.args }
    const id = await timedCard('create_decision', args, 'sections')
    await openCard(id)
    const n = await h.ev(`return document.querySelectorAll('.tc-opt').length`)
    check(n >= 3, 'sections shown as parts', `${n} parts`)
    await shot('r04-sections')
    const how = await h.ev(`const ticks = [...document.querySelectorAll('.tc-opt input[type=checkbox]')]; for (const i of ticks.slice(0, 2)) i.click(); return { ticks: ticks.length, send: !!document.querySelector('.tc-send-many'), opts: [...document.querySelectorAll('.tc-opt')].map(o => o.tagName + ':' + (o.dataset.key ?? '') + ':' + o.className).slice(0, 8) }`)
    say(`note sections controls: ${JSON.stringify(how)}`)
    await shot('r04-ticked')
    const t0 = Date.now()
    if (how.send) await clickJs('.tc-send-many', 'send sections'); else await clickJs('.tc-opt[data-key]', 'first part')
    const e = await nextEvent(ev('decision', id), 'decision (sections)')
    timing('sections answer -> event', Date.now() - t0)
    check(Boolean(e), 'agent gets the sections answer', JSON.stringify(e.params.meta).slice(0, 200))
  },
  async r05_pictures_marks() {
    const f = FIXTURES.find(x => x.kind === 'pictures')
    const id = await timedCard('create_decision', { ...f.args }, 'pictures')
    await openCard(id)
    const t0 = Date.now()
    await until(`[...document.querySelectorAll('.tc-card img')].some(i => i.complete && i.naturalWidth > 0)`, 'decrypted picture on the card page', 20000)
    timing('card page -> first picture decrypted and shown', Date.now() - t0)
    check(await h.ev(`return !!document.querySelector('.tc-opt.is-advised')`), 'recommended marked on a picture card')
    await shot('r05-pictures')
    const m = FIXTURES.find(x => x.kind === 'marks')
    const mid = await timedCard('create_decision', { ...m.args }, 'marks')
    await openCard(mid)
    await sleep(1500)
    check(await h.ev(`return !!document.querySelector('.tc-card .focus-circles path, .tc-card svg path[data-mark], .focus-mark, .tc-card .circles path')`), 'marks drawn on the picture')
    await shot('r05-marks')
  },
  async r06_handback_revise() {
    const id = await timedCard('create_decision', { title: 'Schriftgröße anheben?', options: [{ key: '16', label: '16 px' }, { key: '18', label: '18 px' }] }, 'hand back')
    await openCard(id)
    await clickJs('details.tc-revise > summary', 'Revise tile')
    await until(`document.querySelector('details.tc-revise[open] input[name=note]')`, 'revise field')
    await h.ev(`const i = document.querySelector('details.tc-revise input[name=note]'); i.focus(); return 1`)
    await h.type('Bitte mit Bild vom Handy')
    await shot('r06-revise-open')
    const t0 = Date.now()
    await clickJs('details.tc-revise .tc-revise-send', 'Hand back')
    const e = await nextEvent(ev('chat', id), 'chat handback')
    timing('hand back -> event at the agent', Date.now() - t0)
    check(e.params.meta.handback === '1' && /Handy/.test(e.params.content), 'agent gets the hand back with the note', JSON.stringify(e.params.meta))
    const t1 = Date.now()
    await ch.call('revise_card', { card_id: id, title: 'Schriftgröße auf dem Handy auf 18 px?', note: 'mit Bild' })
    await until(`trommi.model().byCard.get('${id}')?.title?.includes('18 px?')`, 'version 2 in the app')
    timing('revise_card -> version 2 in the app', Date.now() - t1)
    await rowVisible(id, 'revised card').then(() => check(true, 'revised card is presented again on the Desk'), err => check(false, err.message))
    await openCard(id)
    check(await h.ev(`return document.body.textContent.includes('18 px?')`), 'card page shows the new wording')
    await shot('r06-revised')
  },
  async r07_explain() {
    const id = await timedCard('create_decision', { title: 'Cache-Header setzen?', options: [{ key: 'a', label: 'Ja' }, { key: 'b', label: 'Nein' }] }, 'explain')
    await openCard(id)
    const t0 = Date.now()
    await clickJs('.tc-wtf, button[formaction$="/what"]', 'What??')
    const e = await nextEvent(ev('chat', id), 'chat explain')
    timing('What?? -> event at the agent', Date.now() - t0)
    check(e.params.meta.explain === '1', 'agent gets explain=1', JSON.stringify(e.params.meta))
    await shot('r07-after-what')
    const t1 = Date.now()
    await ch.call('reply', { card_id: id, text: 'Der Header spart 300 ms beim zweiten Laden.', present: true })
    await until(`!trommi.model().byCard.get('${id}')?.with_agent && !trommi.model().byCard.get('${id}')?.in_revision`, 'presented again', 15000).catch(() => {})
    await openCard(id)
    await until(`document.body.textContent.includes('300 ms')`, 'explanation in the card thread').then(() => { timing('reply -> explanation on the card', Date.now() - t1); check(true, 'explanation shows on the card') }, err => check(false, err.message))
    await rowVisible(id, 'explained card').then(() => check(true, 'explained card back on the Desk'), err => check(false, err.message))
  },
  async r08_whatever_trust() {
    const id = await timedCard('create_decision', { title: 'Farbe des Knopfs?', options: [{ key: 'g', label: 'Grün' }, { key: 'b', label: 'Blau' }], recommended: 'g' }, 'whatever')
    await openCard(id)
    const t0 = Date.now()
    await clickJs('.tc-whatever', 'I don’t give a duck')
    const e = await nextEvent(anyFor(id), 'any event for the trusted card')
    timing('duck -> event at the agent', Date.now() - t0)
    check(true, `duck reaches the agent as kind=${e.params.meta.kind}`, JSON.stringify(e.params.meta).slice(0, 200))
  },
  async r09_shred() {
    const id = await timedCard('create_decision', { title: 'Welche Schrift?', options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] }, 'shred')
    await openCard(id)
    await clickJs('.tc-more-open', 'More')
    await sleep(200)
    await shot('r09-more')
    const t0 = Date.now()
    await h.ev(`const b = document.querySelector('.tc-more-item.is-shred'); b.click(); return 1`)
    const e = await nextEvent(ev('shredded', id), 'shredded')
    timing('shred -> event at the agent', Date.now() - t0)
    check(Boolean(e), 'agent gets shredded')
  },
  async r10_snooze() {
    const id = await timedCard('create_decision', { title: 'Lade-Animation zeigen?', options: [{ key: 'a', label: 'Ja' }, { key: 'b', label: 'Nein' }] }, 'snooze')
    await openCard(id)
    await clickJs('.tc-more-open', 'More')
    await sleep(200)
    await h.ev(`const b = [...document.querySelectorAll('.tc-more-item')].find(b => /snooze$/.test(b.getAttribute('formaction') ?? '')); b.click(); return 1`)
    await sleep(800)
    await visit('/')
    await sleep(600)
    check(await h.ev(`return !document.querySelector('#desk-list #row-${id}')`), 'snoozed card leaves the Desk list')
    const e = ch.events.find(x => anyFor(id)(x))
    say(`note snooze event to the agent: ${e ? e.params.meta.kind : 'none (Turbo: silent)'}`)
  },
  async r11_info_read() {
    const id = await timedCard('create_info', { title: 'So läuft die Migration', body: 'Erst Backup, dann **Schema**, dann Daten.' }, 'info')
    await openCard(id)
    await shot('r11-info')
    const t0 = Date.now()
    await clickJs('.tc-tile.is-ack', 'Read (ack)')
    const e = await nextEvent(ev('info_read', id), 'info_read')
    timing('read -> info_read at the agent', Date.now() - t0)
    check(Boolean(e), 'agent gets info_read')
  },
  async r12_permission() {
    for (const [req, verdict] of [['vreq1', 'allow'], ['vreq2', 'deny']]) {
      const t0 = Date.now()
      await ch.client.notification({ method: 'notifications/claude/channel/permission_request', params: { request_id: req, tool_name: 'Bash', description: 'Run the test suite', input_preview: '{"command":"npm test"}' } })
      const pid = await h.waitFor(`return [...trommi.client.model.permissions.values()].find(p => p.request_id === '${req}' || (p.tool_name === 'Bash' && p.state !== 'answered' && !p.verdict))?.object_id ?? null`, 15000)
      if (!check(Boolean(pid), `approval ${req} reaches the app`)) continue
      timing(`permission_request -> in the app (${verdict})`, Date.now() - t0)
      await sleep(300)
      const nr = await nrOf(pid)
      check(nr != null, 'approval has a card number on the board')
      if (nr == null) continue
      await visit(`/q/${nr}`); await until(`document.querySelector('.tc-card')`, 'approval card page')
      await shot(`r12-${verdict}`)
      const t1 = Date.now()
      await clickJs(`.tc-opt[data-key="${verdict}"]`, verdict)
      const e = await nextEvent(x => x.method === 'notifications/claude/channel/permission' && x.params.request_id === req, `permission ${verdict}`)
      timing(`${verdict} click -> verdict at Claude Code`, Date.now() - t1)
      check(e.params.behavior === verdict, `Claude Code gets behavior=${verdict}`)
    }
  },
  async r13_withdraw_urgency_merge() {
    const a = await timedCard('create_decision', { title: 'Logo hell oder dunkel?', options: [{ key: 'h', label: 'Hell' }, { key: 'd', label: 'Dunkel' }] }, 'urgency')
    await rowVisible(a, 'urgency card')
    const t0 = Date.now()
    await ch.call('set_urgency', { card_id: a, urgency: 'high', reason: 'Release wartet' })
    await until(`document.querySelector('#row-${a}')?.textContent.match(/knock/i)`, 'knock badge on the row').then(() => { timing('set_urgency -> knock on the row', Date.now() - t0); check(true, 'set_urgency shows the knock') }, err => check(false, err.message))
    await shot('r13-knock')
    const t1 = Date.now()
    await ch.call('withdraw_card', { card_id: a, reason: 'erledigt sich' })
    await until(`!document.getElementById('row-${a}')`, 'withdrawn row leaves').then(() => { timing('withdraw_card -> row gone', Date.now() - t1); check(true, 'withdraw_card removes the row') }, err => check(false, err.message))
    const b = await timedCard('create_decision', { title: 'Test A?', options: [{ key: 'y', label: 'Ja' }, { key: 'n', label: 'Nein' }] }, 'merge 1')
    const c = await timedCard('create_decision', { title: 'Test B?', options: [{ key: 'y', label: 'Ja' }, { key: 'n', label: 'Nein' }] }, 'merge 2')
    const out = await ch.call('merge_cards', { card_ids: [b, c], title: 'Test A und B?', options: [{ key: 'y', label: 'Beide' }, { key: 'n', label: 'Keiner' }] }).catch(err => `ERR ${err.message}`)
    say(`note merge_cards: ${out.slice(0, 160)}`)
    await visit('/'); await sleep(1500)
    check(await h.ev(`return document.body.textContent.includes('Test A und B?')`), 'merged card on the Desk')
  },
  async r14_status_chat_files() {
    await ch.call('introduce', { model: 'Claude Opus 5.5', task: 'Paritätsprüfung', icon: 'flask' }).catch(() => {})
    const t0 = Date.now()
    const q = idOf(await ch.call('create_decision', { title: 'Deploy freigeben?', options: [{ key: 'y', label: 'Ja' }, { key: 'n', label: 'Nein' }] }))
    const linked = await ch.call('set_status', { id: 'deploy', label: 'Deploy', state: 'decision', detail: 'Wartet auf die Freigabe', card_id: q }).then(() => true, err => err.message)
    if (linked !== true) {
      check(false, 'set_status with the card_id of a card just filed works at once', linked)
      await sleep(1500)
      const again = await ch.call('set_status', { id: 'deploy', label: 'Deploy', state: 'decision', detail: 'Wartet auf die Freigabe', card_id: q }).then(() => true, err => err.message)
      check(again === true, 'set_status with that card_id 1.5 s later', again === true ? '' : again)
      if (again !== true) await ch.call('set_status', { id: 'deploy', label: 'Deploy', state: 'decision', detail: 'Wartet auf die Freigabe' })
    }
    await ch.call('set_status', { id: 'tests', label: 'Tests', state: 'working', detail: '42 von 48' })
    const sid = await h.ev(`return trommi.board.devToAgent?.get?.([...trommi.client.model.members.values()].find(m => m.device_role === 'agent')?.device_id) ?? null`)
    const agentPath = sid ?? (await h.ev(`return [...document.querySelectorAll('a[href^="/s/"]')].map(a => a.getAttribute('href'))[0] ?? null`))?.replace(/^\/s\//, '')
    await visit(`/s/${agentPath}`)
    await until(`document.body.textContent.includes('42 von 48') && document.body.textContent.includes('Wartet auf die Freigabe')`, 'status lines on the session page').then(() => { timing('set_status -> status lines on the session page', Date.now() - t0); check(true, 'status lines (working + decision) on the session page') }, err => check(false, err.message))
    await shot('r14-status')
    // human writes in the session composer
    const t1 = Date.now()
    const typed = await h.ev(`const f = document.querySelector('form [name=text], textarea[name=text], .composer textarea'); if (!f) return false; f.focus(); return true`)
    check(typed, 'session composer field')
    if (typed) {
      await h.type('Wie weit ist der Deploy?')
      await h.ev(`const f = document.activeElement.form; f.requestSubmit(); return 1`)
      const e = await nextEvent(x => ev('chat')(x) && /Deploy\?/.test(x.params.content), 'chat from the composer')
      timing('composer send -> chat at the agent', Date.now() - t1)
      check(Boolean(e), 'agent gets the chat message')
    }
    const t2 = Date.now()
    await ch.call('reply', { text: 'Deploy läuft, **3 von 5** Schritten.' })
    await until(`document.body.textContent.includes('3 von 5')`, 'agent reply in the session').then(() => { timing('reply -> visible in the session', Date.now() - t2); check(true, 'agent reply shows in the session') }, err => check(false, err.message))
    // a file from the human
    const file = path.join(tmp, 'messwerte.csv'); fs.writeFileSync(file, 'a,b\n1,2\n')
    const doc = await h.page.send('DOM.getDocument', { depth: -1, pierce: true })
    const { nodeId } = await h.page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' }).catch(() => ({ nodeId: 0 }))
    if (check(Boolean(nodeId), 'file input in the session page')) {
      await h.page.send('DOM.setFileInputFiles', { files: [file], nodeId })
      await sleep(600)
      await h.ev(`const f = document.querySelector('form [name=text], textarea[name=text]'); f.focus(); return 1`); await h.type('Datei anbei')
      await h.ev(`document.activeElement.form.requestSubmit(); return 1`)
      const e = await nextEvent(x => ev('chat')(x) && x.params.meta.files, 'chat with a file', 20000).catch(() => null)
      check(Boolean(e) && fs.existsSync(String(e?.params.meta.files).split(',')[0]), 'agent gets the file decrypted', e ? JSON.stringify(e.params.meta).slice(0, 160) : 'no event with files')
      await shot('r14-file-sent')
    }
  },
  async r15_publish() {
    const file = path.join(tmp, 'bericht.html'); fs.writeFileSync(file, '<!doctype html><h1>Bericht</h1><p>Alles grün.</p>')
    const out = await ch.call('publish_asset', { path: file, title: 'Nachtbericht' }).catch(err => `ERR ${err.message}`)
    say(`note publish_asset: ${out.slice(0, 200)}`)
    await sleep(1500)
    check(/https?:\/\//.test(out), 'publish_asset returns a share link (Turbo: <base>/a/<id>#<key> for people outside)', out.slice(0, 120))
    await h.ev(`trommi.router.visit(location.pathname); return 1`); await sleep(1200)
    check(await h.ev(`return document.body.textContent.includes('Nachtbericht')`), 'published asset announced in the session')
    await shot('r15-publish')
  },
}

try {
  // ---- found a room in the app, invite the channel ----
  await h.go(`/?hub=${encodeURIComponent(hub.hub_url)}`)
  await until(`document.querySelector('#found-form')`, 'welcome screen', 20000)
  await h.ev(`document.querySelector('#found-form input[name=device_name]').value = 'Superkind'; document.querySelector('#found-form button[type=submit]').click(); return 1`)
  await until(`document.getElementById('recovery-code')`, 'recovery code')
  await h.ev(`document.querySelector('#recovery-form input[name=kept]').click(); document.querySelector('#recovery-form button').click(); return 1`)
  await until(`document.documentElement.hasAttribute('data-ready') && trommi.client.model.room.connection === 'live'`, 'room live', 20000)
  check(true, 'room founded in the app')
  await visit('/devices')
  await until(`document.querySelector('form[action="/pair"] input[value=agent]')`, 'devices page')
  await h.ev(`document.querySelector('form[action="/pair"] input[value=agent]').form.requestSubmit(); return 1`)
  await until(`location.pathname.startsWith('/pair/') && document.querySelector('[data-state=open]')`, 'agent invite page')
  const link = await h.ev(`return [...trommi.client.model.invites.values()].at(-1).link`)
  const t0 = Date.now()
  ch = await startChannel({ env: { TROMMI_KEYS_DIR: keys, TROMMI_FOLDER: project, TROMMI_HUB: hub.hub_url, TROMMI_INVITE: link }, cwd: project })
  await ch.ready()
  await until(`document.querySelector('[data-state=joined]')`, 'agent joined on the invite page').catch(() => {})
  timing('channel start with invite -> in the room', Date.now() - t0)
  check(true, 'hub/channel.mjs joined by the app\'s agent invite')
  for (const [name, fn] of Object.entries(ROUNDS)) {
    if (only.length && !only.some(o => name.startsWith(o))) continue
    say(`---- ${name}`)
    try { await fn() } catch (err) { check(false, `${name}: ${err.message}`); await shot(`${name}-fail`).catch(() => {}) }
  }
} catch (err) {
  check(false, err.message)
  await shot('setup-fail').catch(() => {})
} finally {
  for (const e of errors.slice(0, 20)) say(`err  ${e}`)
  fs.writeFileSync(path.join(OUT, 'rounds.json'), JSON.stringify({ when: new Date().toISOString(), app: APP, hub: hub.hub_url, failed, results, times }, null, 1))
  try { await ch?.close() } catch {}
  await h.close()
  hub.stop()
  fs.rmSync(tmp, { recursive: true, force: true })
}
say(`${failed ? 'FAILED' : 'all green'}: ${results.filter(r => r.startsWith('ok')).length} ok, ${failed} failed; ${OUT}/rounds.json`)
process.exit(failed ? 1 : 0)
