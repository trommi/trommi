// Performance of the app in the very big mock room (?mock=crazy: 32 sessions, 5,300 cards, 300 open, 50,000
// messages), desktop and 4x CPU-throttled phone. Prints p50/p95 per interaction, long tasks, heap.
//   node dev/perf.mjs [--app http://127.0.0.1:8900] [--runs 5] [--mock crazy]
import { launchChromium } from './cdp.mjs'

const arg = (n, f) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : f }
const APP = arg('--app', 'http://127.0.0.1:8900'), RUNS = Number(arg('--runs', 5)), MOCK = arg('--mock', 'crazy')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] }
const fmt = xs => `p50 ${pct(xs, 0.5).toFixed(1)} ms, p95 ${pct(xs, 0.95).toFixed(1)} ms (n=${xs.length})`

async function profile(name, { width, height, throttle }) {
  const b = await launchChromium({ width, height })
  const page = await b.page()
  await page.send('Runtime.enable'); await page.send('Page.enable')
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
  if (throttle) await page.send('Emulation.setCPUThrottlingRate', { rate: throttle })
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: "window.__long=[];try{new PerformanceObserver(l=>{for(const e of l.getEntries())window.__long.push(e.duration)}).observe({type:'longtask',buffered:true})}catch(e){}" })
  const js = async code => { const r = await page.send('Runtime.evaluate', { expression: `(async () => { ${code} })()`, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value }
  const out = {}
  const add = (k, v) => (out[k] ??= []).push(v)
  for (let run = 0; run < RUNS; run++) {
    await page.send('Page.navigate', { url: `${APP}/?mock=${MOCK}` })
    for (let i = 0; i < 200; i++) { if (await js("return document.documentElement.hasAttribute('data-ready')").catch(() => false)) break; await sleep(50) }
    add('first paint (boot -> Desk painted, incl. mock generation)', await js('return trommi.firstPaintMs'))
    add('  of it: render + paint after the room is in memory', await js('return trommi.firstPaintMs - (trommi.openMs ?? 0)'))
    await sleep(300)
    // Visit timings: from the call to the painted page (one frame after).
    const visit = path => js(`const t = performance.now(); await trommi.router.visit(${JSON.stringify(path)}); await new Promise(r => requestAnimationFrame(() => setTimeout(r))); return performance.now() - t`)
    add('open a session with a 2,000+ message thread', await visit('/s/agent-1'))
    await sleep(400)   // its timeline page arrives
    add('switch to another session', await visit('/s/agent-2'))
    add('back to the Desk (300 open cards)', await visit('/'))
    const nr = await js("return trommi.model().fresh.find(c => c.options.length === 2)?.number")
    add('open a card', await visit(`/q/${nr}`))
    add('Desk again', await visit('/'))
    // Answer a card with its row's tile: click -> model changed and the page patched (row leaving starts).
    add('answer a card (click -> patched)', await js(`const row = [...document.querySelectorAll('.inbox-row')].find(r => r.querySelector('button[name=key]')); const id = row.id; const t = performance.now(); row.querySelector('button[name=key]').click(); while (!(document.getElementById(id)?.inert || !document.getElementById(id))) await new Promise(r => setTimeout(r, 1)); return performance.now() - t`))
    // Type and send in a session: own message visible.
    await visit('/s/agent-3')
    add('send a message (submit -> own message visible)', await js(`const f = document.querySelector('form.composer'); const ta = f.querySelector('textarea'); ta.value = 'perf ' + Math.random(); const n = document.querySelectorAll('.log .msg').length; const t = performance.now(); f.requestSubmit(f.querySelector('button[type=submit]')); while (document.querySelectorAll('.log .msg').length <= n) await new Promise(r => setTimeout(r, 1)); return performance.now() - t`))
    add('patch after a change (board-state + live diff)', await js('return trommi.lastPatchMs ?? 0'))
  }
  const long = await js('return window.__long')
  const heap = await js('return performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null')
  const nodes = await js("await trommi.router.visit('/'); return document.getElementsByTagName('*').length")
  await b.close()
  console.log(`\n== ${name}`)
  for (const [k, v] of Object.entries(out)) console.log(`${k.padEnd(58)} ${fmt(v)}`)
  console.log(`long tasks (last run): ${long.length}, longest ${Math.max(0, ...long).toFixed(0)} ms · JS heap ${heap} MB · DOM elements on the Desk ${nodes}`)
}
await profile('desktop 1440x900', { width: 1440, height: 900 })
await profile('phone 390x844, CPU 4x slower', { width: 390, height: 844, throttle: 4 })
