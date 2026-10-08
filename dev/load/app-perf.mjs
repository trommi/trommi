// app-perf.mjs: the app (trommi/trommi) in headless Chromium against the crazy room that dev/load/crazy.mjs seeded on
// a real hub. A seeded human device (Node) invites the browser; the browser joins with the check code (emoji),
// like a new laptop or phone, catches up the whole room, and then we measure what a person does, desktop and
// phone (390x844, CPU 4x slower): first load (join -> Desk live), warm reload, Desk render, the huge session chat,
// scrolling back, type + send (own message visible), answer a card, the huge card thread, a stroke through the
// core, switching sessions. p50/p95 over --runs, long tasks, JS heap, IndexedDB size.
//
//   node dev/load/app-perf.mjs --crazy=<dir with crazy.json> --app=http://127.0.0.1:8900 [--runs=5] [--profiles=desktop,phone]
//        [--test-key=<file>] [--resolve='MAP hub.trommi.com <ip>,MAP app.trommi.com <ip>'] [--out=<file.json>]
// Needs the command sandbox off (Chromium), like dev/shot.sh.
import fs from 'node:fs'
import path from 'node:path'
import { launchChromium } from '../cdp.mjs'
import { arg, sleep, until, pct, reopen, useTestKey, writeJson } from './lib.mjs'

const CRAZY = path.resolve(arg('crazy', '.'))
const APP = arg('app', 'http://127.0.0.1:8900').replace(/\/$/, '')
const RUNS = Number(arg('runs', 5))
const PROFILES = arg('profiles', 'desktop,phone').split(',')
const RESOLVE = arg('resolve', null)
const OUT = arg('out', path.join(CRAZY, 'app-perf.json'))
await useTestKey(arg('test-key', null))
const info = JSON.parse(fs.readFileSync(path.join(CRAZY, 'crazy.json'), 'utf8'))
const { client: phone } = await reopen(info.phone_dir)
await phone.start({ stream: false })
const results = { app: APP, hub: info.hub_url, room_envelopes: info.envelopes, counts: info.counts, at: new Date().toISOString(), profiles: {} }

async function profile(name, { width, height, throttle }) {
  const b = await launchChromium({ width, height, args: RESOLVE ? [`--host-resolver-rules=${RESOLVE}`] : [] })
  const page = await b.page()
  const errors = []
  page.on('Runtime.exceptionThrown', e => errors.push(e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text))
  await page.send('Runtime.enable'); await page.send('Page.enable')
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: "window.__long=[];try{new PerformanceObserver(l=>{for(const e of l.getEntries())window.__long.push(Math.round(e.duration))}).observe({type:'longtask',buffered:true})}catch(e){}" })
  const js = async code => {
    const r = await page.send('Runtime.evaluate', { expression: `(async () => { ${code} })()`, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(`${name}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
    return r.result.value
  }
  const waitFor = async (code, what, ms = 600_000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await js(`return Boolean(${code})`).catch(() => false)) return Date.now() - t; await sleep(25) } throw new Error(`${name}: timed out: ${what}`) }
  const out = { timings: {}, notes: [] }
  const add = (k, v) => { if (v != null && Number.isFinite(v)) (out.timings[k] ??= []).push(+v.toFixed(1)) }
  const longs = async () => { const l = await js('const l = window.__long; window.__long = []; return l'); return l }

  // ---- join: invite from the seeded phone, check code compared on the phone side ----
  if (throttle) await page.send('Emulation.setCPUThrottlingRate', { rate: throttle })
  await phone.catchUp()
  if (phone.writeSnapshot && !process.argv.includes('--no-snapshot')) { const ts = performance.now(); await phone.writeSnapshot(); await phone.settle({ timeout_ms: 60_000 }).catch(() => {}); out.snapshot_write_ms = Math.round(performance.now() - ts) }
  const inv = await phone.createInvite({ device_role: 'human', app_url: `${APP}/join` })
  await page.send('Page.navigate', { url: inv.link })
  await waitFor("document.querySelector('#join-form')", 'join form', 60_000)
  await js(`document.querySelector('#join-form input[name=device_name]').value = '${name}'; document.querySelector('#join-form button').click()`)
  await waitFor("document.getElementById('check-code')", 'check code', 60_000)
  const code = await js("return document.getElementById('check-code').dataset.code")
  await until(() => phone.model.invites.get(inv.invite_id)?.invite_state === 'confirm_code', 'phone waits for the code', 60_000)
  const tJoin = Date.now()
  await phone.confirmInvite(inv.invite_id, phone.model.invites.get(inv.invite_id).check_code === code)
  await waitFor("document.documentElement.hasAttribute('data-ready')", 'app ready after join')
  out.first_ready_ms = Date.now() - tJoin
  await waitFor("trommi.client.model.room.connection === 'live' && trommi.client.model.room.last_envelope_number >= " + (info.envelopes - 50), 'caught up', 1_800_000)
  out.first_load_ms = Date.now() - tJoin
  out.first_load_long_tasks = await longs()
  out.after_first_load = await js("const e = await navigator.storage.estimate(); return { heap_mb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null, idb_mb: Math.round((e.usageDetails?.indexedDB ?? e.usage) / 1e6), snapshot: trommi.client.stats?.snapshot ?? null, cards: trommi.client.model.cards.size, stack: trommi.client.model.stack.length, sessions: trommi.client.model.sessions.size, cursor: trommi.client.model.room.last_envelope_number }")
  console.log(`${name}: first load (join -> live, ${out.after_first_load.cursor} envelopes) ${out.first_load_ms} ms, ready ${out.first_ready_ms} ms, ${out.first_load_long_tasks.length} long tasks (max ${Math.max(0, ...out.first_load_long_tasks)} ms)`)
  await sleep(2500)    // the debounced IndexedDB writes

  const visit = p => js(`const t = performance.now(); await trommi.router.visit(${JSON.stringify(p)}); await new Promise(r => requestAnimationFrame(() => setTimeout(r))); return performance.now() - t`)
  const bigAgent = await js(`return trommi.board.devToAgent.get('${info.big_session}')`)
  const otherAgents = await js(`return [...trommi.board.devToAgent.values()].filter(a => a !== '${bigAgent}').slice(0, 6)`)
  const bigCardNr = await js(`return trommi.model().byCard?.get('${info.big_card}')?.number ?? null`)
  if (!bigCardNr) out.notes.push('big card has no number in the board model (byCard)')

  for (let run = 0; run < RUNS; run++) {
    // warm reload: from IndexedDB, then the delta
    await longs()
    const t = Date.now()
    await page.send('Page.reload')
    await waitFor("document.documentElement.hasAttribute('data-ready')", 'ready after reload', 120_000)
    add('warm reload: navigation -> Desk painted', Date.now() - t)
    add('warm reload: boot -> Desk painted (firstPaintMs)', await js('return trommi.firstPaintMs'))
    await waitFor("trommi.client.model.room.connection === 'live'", 'live after reload', 120_000)
    add('warm reload: navigation -> live', Date.now() - t)
    out.reload_long_tasks = await longs()
    await sleep(500)
    add('Desk render (visit /)', await visit('/'))
    add('open the huge session chat', await visit(`/s/${bigAgent}`))
    const tl = Date.now()
    await waitFor(`document.querySelectorAll('.log .msg').length >= 20`, 'chat page loaded', 30_000).catch(() => out.notes.push('session chat did not show 20 messages'))
    add('huge session chat: open -> 20+ messages shown', Date.now() - tl)
    // scroll back: "Earlier messages" (a Turbo Frame) twice
    for (let i = 0; i < 2; i++) {
      const has = await js("return !!document.querySelector('.log-earlier-link')")
      if (!has) break
      add('scroll back: Earlier -> older page shown', await js(`const n = document.querySelectorAll('.log .msg').length; const t = performance.now(); document.querySelector('.log-earlier-link').click(); while (document.querySelectorAll('.log .msg').length <= n && performance.now() - t < 20000) await new Promise(r => setTimeout(r, 2)); return performance.now() - t`))
    }
    add('scroll the chat to the top and back (frame time)', await js(`const el = document.scrollingElement; const t = performance.now(); el.scrollTop = 0; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); el.scrollTop = el.scrollHeight; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return performance.now() - t`))
    // type + send: own message visible
    add('type + send (submit -> own message visible)', await js(`const f = document.querySelector('form.composer'); const ta = f.querySelector('textarea'); ta.value = 'perf ' + Math.random(); const n = document.querySelectorAll('.log .msg').length; const t = performance.now(); f.requestSubmit(f.querySelector('button[type=submit]')); while (document.querySelectorAll('.log .msg').length <= n && performance.now() - t < 10000) await new Promise(r => setTimeout(r, 1)); return performance.now() - t`))
    add('switch session', await visit(`/s/${otherAgents[run % otherAgents.length]}`))
    add('switch session (2)', await visit(`/s/${otherAgents[(run + 1) % otherAgents.length]}`))
    if (bigCardNr) {
      add('open the huge card thread', await visit(`/card/${bigCardNr}`))
      const tc = Date.now()
      await waitFor(`document.querySelectorAll('#cardpage .msg, #cardpage .tc-msg, #cardpage li').length >= 10`, 'card thread loaded', 30_000).catch(() => out.notes.push('card thread did not show 10 items'))
      add('huge card thread: open -> 10+ items shown', Date.now() - tc)
    }
    await visit('/')
    add('answer a card on the Desk (click -> row leaves)', await js(`const row = [...document.querySelectorAll('.inbox-row')].find(r => r.querySelector('button[name=key]')); if (!row) return null; const id = row.id; const t = performance.now(); row.querySelector('button[name=key]').click(); while (!(document.getElementById(id)?.inert || !document.getElementById(id)) && performance.now() - t < 10000) await new Promise(r => setTimeout(r, 1)); return performance.now() - t`))
    add('a stroke through the core (sendStrokes -> echo in the model)', await js(`const c = trommi.client; const k = 'canvas:desk/${info.big_desk}'; const t = performance.now(); const p = c.sendStrokes({ timeline_id: 'desk/${info.big_desk}', strokes: [{ stroke_id: 'p' + Math.random(), points: 'AAgACAAIAAg', style: { tool: 'pen', color: '#222', size: 2 } }] }); const echo = performance.now() - t; await p; return echo`))
    if (run === 0) {
      const tc = Date.now()
      const n = await js(`const r = await trommi.client.loadTimelineAfter('canvas:desk/${info.big_desk}', 0).catch(e => ({ error: e.message })); return r.error ?? r.loaded`)
      out.canvas_tail = { what: 'loadTimelineAfter(canvas 20k, 0): first page of the canvas tail', ms: Date.now() - tc, result: n }
    }
    out.interaction_long_tasks = [...(out.interaction_long_tasks ?? []), ...(await longs())]
  }
  out.end = await js("const e = await navigator.storage.estimate(); return { heap_mb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null, idb_mb: Math.round((e.usageDetails?.indexedDB ?? e.usage) / 1e6), dom_nodes: document.getElementsByTagName('*').length }")
  out.errors = errors.slice(0, 20)
  const summary = {}
  for (const [k, v] of Object.entries(out.timings)) summary[k] = pct(v, [50, 95])
  out.summary = summary
  out.long_tasks_over_200 = [...(out.interaction_long_tasks ?? []), ...(out.reload_long_tasks ?? [])].filter(x => x > 200)
  await b.close()
  console.log(`\n== ${name}`)
  for (const [k, v] of Object.entries(summary)) console.log(`${k.padEnd(62)} p50 ${v.p50} ms  p95 ${v.p95} ms  (n=${v.n})`)
  console.log(`long tasks: first load ${out.first_load_long_tasks.length}, interactions ${out.interaction_long_tasks?.length ?? 0} (>200 ms: ${out.long_tasks_over_200.length}) · heap ${out.end.heap_mb} MB · IndexedDB ${out.end.idb_mb} MB · errors ${errors.length}`)
  return out
}

try {
  if (PROFILES.includes('desktop')) { results.profiles.desktop = await profile('desktop', { width: 1440, height: 900 }); writeJson(OUT, results) }
  if (PROFILES.includes('phone')) { results.profiles.phone = await profile('phone', { width: 390, height: 844, throttle: 4 }); writeJson(OUT, results) }
} catch (e) {
  console.error(e.stack)
  results.error = e.stack
} finally {
  writeJson(OUT, results)
  await phone.stop()
  process.exit(results.error ? 1 : 0)
}
