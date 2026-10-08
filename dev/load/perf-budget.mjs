// perf-budget.mjs: the performance budgets, checked against a huge room (dev/load/huge-room.mjs) on a local hub.
// Fails (exit 1) when a budget is exceeded. Runs locally (minutes, no CI): README "Performance budgets".
//
//   node dev/load/perf-budget.mjs [--room=<dir with huge.json>] [--only=engine,web,ios] [--runs=3]
//        [--app=<url of app/web/dev/serve.mjs --prod>] [--cpu-prof=<prefix>] [--keep-browser]
//
// Without --room it uses ~/.cache/trommi-work/huge, seeding it first when missing (dev/load/huge-room.mjs, ~16 min).
// The hub is restarted behind the counting front (hub-local.mjs --count) when it is not already. Without --app the
// production-like app server (app/web/dev/serve.mjs --prod: the bundle, its service worker, brotli) is started here.
// Web: headless Chromium as a phone (390x844, CPU 4x slower, 150 ms RTT, 1.6 Mbit/s down); the browser joins the room
// once and keeps its profile in <room>/chromium-phone (a joined phone that is opened again). Needs the command sandbox
// off (Chromium). ios: the Swift core (trommi-swift; its budgets fail until the iOS engine works per change).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { launchChromium } from '../cdp.mjs'
import { arg, flag, sleep, until, pct, reopen, writeJson, countingHub, REPO } from './lib.mjs'
import { guard } from '../guard.mjs'
guard({ usage: 'node dev/load/perf-budget.mjs [--room=DIR] [--only=engine,web,ios] [--parts=start,interact,scroll,live,one] [--runs=3] [--app=URL] [--cpu-prof=PREFIX] [--keep-browser]', values: ['room', 'only', 'parts', 'runs', 'app', 'cpu-prof'], flags: ['keep-browser'], targets: ['app'] })

// ---- the budgets ----
// Phone = 390x844, CPU 4x slower, slow 4G. "warm": the app and the room on the device (service worker + IndexedDB);
// "cold": the app's files not cached (no service worker, no HTTP cache), the room still in IndexedDB.
export const BUDGETS = {
  'web: warm start to the Desk (phone)': { max: 1000, unit: 'ms' },
  'web: cold start to the Desk (phone)': { max: 2000, unit: 'ms' },
  'web: interaction p95 (phone)': { max: 100, unit: 'ms' },
  'web: long tasks > 50 ms while scrolling': { max: 0, unit: '' },
  'web: long tasks > 50 ms during live updates': { max: 0, unit: '' },
  'web: one new message: envelopes verified': { max: 1, unit: '' },
  'web: one new message: bodies decrypted': { max: 1, unit: '' },
  'web: one new message: hub requests besides the stream': { max: 0, unit: '' },
  'web: one new message: KiB from the hub': { max: 4, unit: 'KiB' },
  'web: one new message: visible in the open chat (phone)': { max: 100, unit: 'ms' },
  'engine js: one new message: envelopes verified': { max: 1, unit: '' },
  'engine js: one new message: bodies decrypted': { max: 1, unit: '' },
  'engine js: one new message: hub requests besides the stream': { max: 0, unit: '' },
  'engine js: warm start, one new: envelopes verified': { max: 1, unit: '' },
  'engine js: warm start, one new: conversations read': { max: 0, unit: '' },
  'engine js: reopen the huge session warm: KiB from the hub': { max: 4, unit: 'KiB' },
  'engine js: scroll back one page: bodies decrypted': { max: 50, unit: '' },
  'engine ios: one new message: cache bytes written': { max: 64, unit: 'KiB' },
  'engine ios: warm start, nothing new': { max: 300, unit: 'ms' },
}

const ONLY = arg('only', 'engine,web').split(',')
const PARTS = arg('parts', 'start,interact,scroll,live,one').split(',')   // the web's parts
const RUNS = Number(arg('runs', 3))
const ROOM = path.resolve(arg('room', path.join(os.homedir(), '.cache/trommi-work/huge')))
const PROF = arg('cpu-prof', null)
const results = { at: new Date().toISOString(), room: ROOM, measured: {}, notes: [] }
const got = (name, value, extra = null) => { results.measured[name] = { value: value == null ? null : +Number(value).toFixed(1), ...(extra ? { extra } : {}) }; console.log(`  ${name}: ${value == null ? '–' : (+Number(value).toFixed(1))}${extra ? `  ${JSON.stringify(extra)}` : ''}`) }

if (!fs.existsSync(path.join(ROOM, 'huge.json'))) {
  console.log(`no room in ${ROOM}: seeding it (dev/load/huge-room.mjs)`)
  const r = spawnSync(process.execPath, [path.join(REPO, 'dev/load/huge-room.mjs'), `--out=${ROOM}`, '--keep-hub'], { stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
const info = JSON.parse(fs.readFileSync(path.join(ROOM, 'huge.json'), 'utf8'))
const counters = await countingHub(info, ROOM)

// ---- the engines: dev/load/tempo.mjs, read back ----
function tempo(impl) {
  const out = path.join(ROOM, `budget-tempo-${impl}.json`)
  // the Swift core measured as the phone runs it: the release build when there is one (swift build -c release)
  const release = path.join(REPO, 'ios/TrommiCore/.build/release/trommi-swift')
  const env = { ...process.env, ...(!process.env.TROMMI_SWIFT_BIN && fs.existsSync(release) ? { TROMMI_SWIFT_BIN: release } : {}) }
  const r = spawnSync(process.execPath, [path.join(REPO, 'dev/load/tempo.mjs'), `--room=${ROOM}`, `--impl=${impl}`, '--pages=5', `--out=${out}`], { stdio: 'inherit', env })
  if (r.status !== 0) results.notes.push(`tempo ${impl} exited ${r.status}`)
  return JSON.parse(fs.readFileSync(out, 'utf8'))[impl] ?? {}
}
const threadsOf = x => x?.routes?.['GET /threads']?.requests ?? 0
const besidesStream = x => Object.entries(x?.routes ?? {}).filter(([k]) => k !== 'GET /stream').reduce((a, [, v]) => a + v.requests, 0)
if (ONLY.includes('engine')) {
  console.log('\n== engine (JS core, Node)')
  const j = tempo('js')
  got('engine js: one new message: envelopes verified', j.one_message_live?.verified)
  got('engine js: one new message: bodies decrypted', j.one_message_live?.decrypted)
  got('engine js: one new message: hub requests besides the stream', besidesStream(j.one_message_live), j.one_message_live?.routes)
  got('engine js: warm start, one new: envelopes verified', j.warm_one_new?.verified)
  got('engine js: warm start, one new: conversations read', threadsOf(j.warm_one_new))
  got('engine js: reopen the huge session warm: KiB from the hub', j.reopen_huge_session_warm?.kb_in)
  got('engine js: scroll back one page: bodies decrypted', j.scroll_back?.decrypted_per_page)
  results.engine_js = j
}
if (ONLY.includes('ios')) {
  console.log('\n== engine (Swift core, trommi-swift)')
  const s = tempo('swift')
  got('engine ios: one new message: cache bytes written', s.one_message_live?.cache_written_kb)
  got('engine ios: warm start, nothing new', s.warm_nothing_new?.ms)
  results.engine_ios = s
}

// ---- the web app on a throttled phone ----
async function freePort(want = 0) {
  const tryPort = p => new Promise(ok => { const s = net.createServer().once('error', () => ok(null)).listen(p, '127.0.0.1', () => { const got = s.address().port; s.close(() => ok(got)) }) })
  return (want && await tryPort(want)) || tryPort(0)
}
async function web() {
  let APP = arg('app', null), server = null
  if (!APP) {
    const port = await freePort(8946)   // a fixed port when free: the same origin, so the joined phone profile is used again
    server = spawn(process.execPath, [path.join(REPO, 'app/web/dev/serve.mjs'), String(port), '--prod'], { stdio: 'ignore' })
    APP = `http://127.0.0.1:${port}`
    await until(() => fetch(APP).then(r => r.ok).catch(() => false), 'app server', 60_000)
  }
  const { client: phone } = await reopen(info.phone_dir)
  await phone.start()
  const { client: agent } = await reopen(path.join(path.dirname(info.phone_dir), 'agent-1'))
  await agent.start({ stream: false })
  const others = []
  for (const n of [3, 4, 5, 6]) { const { client } = await reopen(path.join(path.dirname(info.phone_dir), `agent-${n}`)); await client.start({ stream: false }); others.push(client) }
  const keepDir = path.join(ROOM, 'chromium-phone')
  const b = await launchChromium({ width: 390, height: 844, keep: keepDir })
  try {
    const page = await b.page()
    const errors = []
    page.on('Runtime.exceptionThrown', e => errors.push(e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text))
    await page.send('Runtime.enable'); await page.send('Page.enable'); await page.send('Network.enable')
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: "window.__long=[];try{new PerformanceObserver(l=>{for(const e of l.getEntries())window.__long.push(Math.round(e.duration))}).observe({type:'longtask',buffered:true})}catch(e){}" })
    // what the page moves to and from the hub (the stream included)
    const hubOrigin = new URL(info.hub_url).origin
    const reqs = new Map(); let hub = { requests: 0, bytes: 0, stream: 0, list: [] }
    page.on('Network.requestWillBeSent', e => { if (e.request.url.startsWith(hubOrigin)) { const u = new URL(e.request.url); const stream = u.pathname.endsWith('/stream'); reqs.set(e.requestId, stream); if (!stream) { hub.requests++; hub.list.push(`${e.request.method} ${u.pathname.replace(/[0-9a-f]{32,}/g, ':id')}`) } } })
    page.on('Network.dataReceived', e => { if (reqs.has(e.requestId)) { hub.bytes += e.encodedDataLength || e.dataLength; if (reqs.get(e.requestId)) hub.stream += e.dataLength } })
    page.on('Network.loadingFinished', e => { if (reqs.has(e.requestId) && !reqs.get(e.requestId)) hub.bytes += 0 })
    const resetHub = () => { hub = { requests: 0, bytes: 0, stream: 0, list: [] } }
    const js = async (code, tries = 4) => {
      // (a page that reloads under us, e.g. the service worker taking a new version, is asked again a moment later)
      for (let i = 0; ; i++) {
        try {
          const r = await page.send('Runtime.evaluate', { expression: `(async () => { ${code} })()`, awaitPromise: true, returnByValue: true })
          if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
          return r.result.value
        } catch (e) {
          if (i + 1 >= tries || !/navigated|context was destroyed|Cannot find context/i.test(e.message)) throw e
          await sleep(500)
        }
      }
    }
    const waitFor = async (code, what, ms = 120_000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await js(`return Boolean(${code})`).catch(() => false)) return Date.now() - t; await sleep(25) } throw new Error(`timed out: ${what}`) }
    // (the time the page was ready, read again if the page reloaded meanwhile: a service worker taking over)
    const readyAt = async () => { for (let i = 0; i < 100; i++) { const v = await js('return window.trommi?.readyAt ?? null').catch(() => null); if (v > 0) return v; await sleep(100) } throw new Error('no ready time') }
    const longs = () => js('const l = window.__long; window.__long = []; return l')
    const throttle = async on => {
      await page.send('Emulation.setCPUThrottlingRate', { rate: on ? 4 : 1 })
      await page.send('Network.emulateNetworkConditions', on ? { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 0.75e6 / 8 } : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    }

    // the device: joined once (kept in the profile), else join now (unthrottled; reported, not budgeted)
    await page.send('Page.navigate', { url: `${APP}/` })
    await waitFor("document.documentElement.hasAttribute('data-ready') || document.querySelector('#join-form, .start, form')", 'a page', 60_000).catch(() => {})
    const joined = await js(`return window.trommi?.client?.model?.room?.room_id === ${JSON.stringify(info.room_id)}`).catch(() => false)
    if (!joined) {
      const inv = await phone.createInvite({ device_role: 'human', app_url: `${APP}/join` })
      await page.send('Page.navigate', { url: inv.link })
      await waitFor("document.querySelector('#join-form')", 'join form', 60_000)
      await js("document.querySelector('#join-form input[name=device_name]').value = 'budget phone'; document.querySelector('#join-form button').click()")
      await waitFor("document.getElementById('check-code')", 'check code', 60_000)
      const code = await js("return document.getElementById('check-code').dataset.code")
      await until(() => phone.model.invites.get(inv.invite_id)?.invite_state === 'confirm_code', 'phone waits for the code', 60_000)
      const t = Date.now()
      await phone.confirmInvite(inv.invite_id, phone.model.invites.get(inv.invite_id).check_code === code)
      await waitFor("window.trommi?.client?.model?.room?.connection === 'live'", 'joined and live', 1_800_000)
      results.web_join_ms = Date.now() - t
      console.log(`  (joined the room as a new phone: ${results.web_join_ms} ms to live, unthrottled; not a budget)`)
    }
    await waitFor("window.trommi?.client?.model?.room?.connection === 'live'", 'live', 300_000)
    await js('await window.trommi.client._revisions; await window.trommi.client.flush()').catch(() => {})
    await sleep(1500)

    console.log('\n== web (phone: CPU 4x, 150 ms RTT, 1.6 Mbit/s)')
    await throttle(true)
    if (PARTS.includes('start')) {
    // warm starts
    const warm = []
    for (let i = 0; i < RUNS; i++) {
      const profiling = PROF && i === RUNS - 1
      if (profiling) { await page.send('Profiler.enable'); await page.send('Profiler.start') }
      await page.send('Page.reload')
      await waitFor("document.documentElement.hasAttribute('data-ready')", 'ready after reload')
      warm.push(await readyAt())
      if (profiling) { const { profile } = await page.send('Profiler.stop'); fs.writeFileSync(`${PROF}-warm.cpuprofile`, JSON.stringify(profile)) }
      results.warm_parts = await js('return { open_ms: Math.round(window.trommi?.openMs ?? 0), first_paint_ms: Math.round(window.trommi?.firstPaintMs ?? 0) }').catch(() => null)
      await waitFor("window.trommi.client.model.room.connection === 'live'", 'live after reload')
      await sleep(800)
    }
    got('web: warm start to the Desk (phone)', pct(warm, [95]).p95, { runs: warm.map(Math.round) })
    // cold starts: the app's files not cached (service worker and caches gone), the room still in IndexedDB
    const cold = []
    const files = new Map()
    const onResp = e => { if (e.response.url.startsWith(APP)) files.set(e.requestId, { url: e.response.url.slice(APP.length), sw: e.response.fromServiceWorker }) }
    const onDone = e => { const f = files.get(e.requestId); if (f) f.kb = +(e.encodedDataLength / 1024).toFixed(1) }
    page.on('Network.responseReceived', onResp); page.on('Network.loadingFinished', onDone)
    for (let i = 0; i < Math.min(RUNS, 2); i++) {
      files.clear()
      await page.send('Storage.clearDataForOrigin', { origin: new URL(APP).origin, storageTypes: 'service_workers,cache_storage' })
      await page.send('Network.clearBrowserCache')
      await page.send('Page.reload', { ignoreCache: true })
      await waitFor("document.documentElement.hasAttribute('data-ready')", 'ready after cold reload')
      cold.push(await readyAt())
      await waitFor("window.trommi.client.model.room.connection === 'live'", 'live after cold reload')
      await sleep(2500)    // the service worker installs again
    }
    got('web: cold start to the Desk (phone)', pct(cold, [95]).p95, { runs: cold.map(Math.round) })
    results.cold_files = [...files.values()].filter(f => !f.sw)
    console.log(`    (cold start: ${results.cold_files.length} files, ${results.cold_files.reduce((a, f) => a + (f.kb ?? 0), 0).toFixed(0)} KiB over the network)`)
    }
    await page.send('Page.reload')
    await waitFor("document.documentElement.hasAttribute('data-ready') && window.trommi.client.model.room.connection === 'live'", 'ready')
    await sleep(800)
    await longs()

    // interactions
    const visit = p => js(`const t = performance.now(); await trommi.router.visit(${JSON.stringify(p)}); await new Promise(r => requestAnimationFrame(() => setTimeout(r))); return performance.now() - t`)
    const bigAgent = await js(`return trommi.board.devToAgent.get('${info.big_session}')`)
    const otherAgents = await js(`return [...trommi.board.devToAgent.values()].filter(a => a !== '${bigAgent}').slice(0, 6)`)
    const bigCardNr = await js(`return trommi.model().byCard?.get('${info.big_card}')?.number ?? null`)
    const inter = {}
    const add = (k, v) => { if (Number.isFinite(v)) (inter[k] ??= []).push(v) }
    if (PARTS.includes('interact')) {
    if (PROF) { await page.send('Profiler.enable'); await page.send('Profiler.start') }
    for (let run = 0; run < RUNS; run++) {
      add('Desk', await visit('/'))
      add('open the huge session', await visit(`/s/${bigAgent}`))
      await waitFor(`document.querySelectorAll('.log .msg').length >= 20`, 'chat shown', 30_000).catch(() => results.notes.push('huge session: fewer than 20 messages shown'))
      for (let i = 0; i < 2; i++) {
        if (!(await js("return !!document.querySelector('.log-earlier-link')"))) break
        add('Earlier page', await js(`const n = document.querySelectorAll('.log .msg').length; const t = performance.now(); document.querySelector('.log-earlier-link').click(); while (document.querySelectorAll('.log .msg').length <= n && performance.now() - t < 20000) await new Promise(r => setTimeout(r, 2)); return performance.now() - t`))
      }
      add('send (own message visible)', await js(`const f = document.querySelector('form.composer'); const ta = f.querySelector('textarea'); ta.value = 'budget ' + Math.random(); const n = document.querySelectorAll('.log .msg').length; const t = performance.now(); f.requestSubmit(f.querySelector('button[type=submit]')); while (document.querySelectorAll('.log .msg').length <= n && performance.now() - t < 10000) await new Promise(r => setTimeout(r, 1)); return performance.now() - t`))
      add('switch session', await visit(`/s/${otherAgents[run % otherAgents.length]}`))
      add('switch session', await visit(`/s/${otherAgents[(run + 1) % otherAgents.length]}`))
      if (bigCardNr) add('open a card', await visit(`/card/${bigCardNr}`))
      await visit('/')
      add('answer a card on the Desk', await js(`const row = [...document.querySelectorAll('.inbox-row')].find(r => r.querySelector('button[name=key]')); if (!row) return null; const id = row.id; const t = performance.now(); row.querySelector('button[name=key]').click(); while (!(document.getElementById(id)?.inert || !document.getElementById(id)) && performance.now() - t < 10000) await new Promise(r => setTimeout(r, 1)); return performance.now() - t`))
    }
    if (PROF) { const { profile } = await page.send('Profiler.stop'); fs.writeFileSync(`${PROF}-interactions.cpuprofile`, JSON.stringify(profile)) }
    const all = Object.values(inter).flat()
    got('web: interaction p95 (phone)', pct(all, [95]).p95, Object.fromEntries(Object.entries(inter).map(([k, v]) => [k, pct(v, [50, 95]).p95])))
    results.interactions = Object.fromEntries(Object.entries(inter).map(([k, v]) => [k, pct(v, [50, 95])]))
    }

    // scrolling: the Desk and the huge session (after paging back), a finger's speed for two seconds each
    const scroll = () => js(`const el = document.scrollingElement; const t = performance.now(); let y = el.scrollTop, dir = -1; while (performance.now() - t < 2000) { y += dir * 120; if (y <= 0) { y = 0; dir = 1 } if (y >= el.scrollHeight - innerHeight) { y = el.scrollHeight - innerHeight; dir = -1 } el.scrollTop = y; await new Promise(r => requestAnimationFrame(r)) } return true`)
    if (PARTS.includes('scroll')) {
    await visit('/'); await sleep(300); await longs()
    if (PROF) { await page.send('Profiler.enable'); await page.send('Profiler.start') }
    await scroll()
    await visit(`/s/${bigAgent}`); await sleep(500); await longs()
    for (let i = 0; i < 4; i++) await js("document.querySelector('.log-earlier-link')?.click(); await new Promise(r => setTimeout(r, 400))")
    await longs()
    await js('document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight')
    await scroll()
    const scrollLong = (await longs()).filter(x => x > 50)
    if (PROF) { const { profile } = await page.send('Profiler.stop'); fs.writeFileSync(`${PROF}-scroll.cpuprofile`, JSON.stringify(profile)) }
    got('web: long tasks > 50 ms while scrolling', scrollLong.length, scrollLong.length ? { ms: scrollLong } : null)
    results.dom_nodes_after_scroll = await js("return document.getElementsByTagName('*').length")
    }

    // live updates: messages and cards from five sessions for three seconds, on the Desk and in a session
    const burst = async () => {
      const ends = Date.now() + 3000
      let k = 0
      while (Date.now() < ends) {
        const a = [agent, ...others][k % 5]
        if (k % 7 === 6) await a.sendCard({ title: `budget ${k}`, body: 'live update', options: [{ key: 'a', label: 'Ja' }, { key: 'b', label: 'Nein' }], recommended: 'a' })
        else await a.sendMessage({ text: `budget live ${k}` })
        k++; await sleep(100)
      }
      await sleep(800)
    }
    if (PARTS.includes('live')) {
    await visit('/'); await sleep(300); await longs()
    if (PROF) { await page.send('Profiler.enable'); await page.send('Profiler.start') }
    await burst()
    await visit(`/s/${bigAgent}`); await sleep(300)
    await burst()
    if (PROF) { const { profile } = await page.send('Profiler.stop'); fs.writeFileSync(`${PROF}-live.cpuprofile`, JSON.stringify(profile)) }
    const liveLong = (await longs()).filter(x => x > 50)
    got('web: long tasks > 50 ms during live updates', liveLong.length, liveLong.length ? { ms: liveLong } : null)
    }

    // one new message while its session is open: what the page fetches, verifies and decrypts for it
    if (PARTS.includes('one')) {
    await visit(`/s/${bigAgent}`)
    await sleep(1500)
    const s0 = await js('return { ...trommi.client.stats }')
    const n0 = await js("return document.querySelectorAll('.log .msg').length")
    resetHub()
    const tSend = Date.now()
    await agent.sendMessage({ text: `budget one ${Date.now()}` })
    const shown = await waitFor(`document.querySelectorAll('.log .msg').length > ${n0}`, 'the message shown', 30_000)
    const sentAfter = Date.now() - tSend
    await sleep(1500)
    const s1 = await js('return { ...trommi.client.stats }')
    got('web: one new message: envelopes verified', s1.verified - s0.verified)
    got('web: one new message: bodies decrypted', s1.decrypted - s0.decrypted)
    got('web: one new message: hub requests besides the stream', hub.requests, hub.list.length ? { requests: hub.list } : null)
    got('web: one new message: KiB from the hub', hub.bytes / 1024)
    got('web: one new message: visible in the open chat (phone)', Math.min(shown, sentAfter), { since_send_ms: sentAfter })
    }
    results.web_end = await js("return { heap_mb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null, dom_nodes: document.getElementsByTagName('*').length }")
    results.web_errors = errors.slice(0, 10)
    await throttle(false)
  } finally {
    await b.close()
    server?.kill()
    for (const c of [agent, ...others, phone]) await c.stop().catch(() => {})
  }
}
if (ONLY.includes('web')) {
  try { await web() } catch (e) { console.error(e.stack); results.notes.push(`web: ${e.message}`) }
}

// ---- the verdict ----
let failed = 0
console.log('\n== budgets')
for (const [name, b] of Object.entries(BUDGETS)) {
  const m = results.measured[name]
  if (!m) continue
  const ok = m.value != null && m.value <= b.max
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}: ${m.value ?? '–'} ${b.unit} (budget ${b.max})`)
}
for (const n of results.notes) { console.log(`note: ${n}`); failed++ }
results.failed = failed
writeJson(path.join(ROOM, 'perf-budget.json'), results)
console.log(failed ? `\n${failed} over budget (${path.join(ROOM, 'perf-budget.json')})` : '\nall within budget')
process.exit(failed ? 1 : 0)
