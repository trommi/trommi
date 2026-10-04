#!/usr/bin/env node
// Performance of a target (the Turbo board, the new app) measured the same way, for the Turbo-vs-new table in
// docs/parity.md.
//   node dev/verify/perf.mjs --target turbo|app --out FILE.json [--verify-dir DIR] [--base URL] [--runs 3] [--hosts "MAP …"]
// Profiles: desktop (1440x900, no throttle), desktop-4x (CPU 4x slower), phone-4x (390x844, touch, CPU 4x).
// Scenarios, each the median of --runs:
//   cold      fresh browser, empty cache: Desk until its first row (plus first paint, requests, kB, long tasks)
//   warm      the same browser loads the Desk again (HTTP cache and whatever the app keeps)
//   nav       on the loaded Desk: click a session in the sidebar until its conversation stands, then a card in it
//             until the card stands (in-page time from the click to the element, no reload)
//   live      an agent's tool call (a reply in its session, a new card on the Desk) until it is visible on an open page
// Target hooks (targets/<name>.mjs, field perf): desk { path, ready }, nav [{ name, click, ready }], live(ctx) →
// [{ name, path, ready, send(nonce) → Promise, cleanup? }]. Needs the command sandbox disabled.
import fs from 'node:fs'
import path from 'node:path'
import { arg, loadTarget, openPage, sleep } from './lib.mjs'

const target = await loadTarget(arg('target', 'turbo'))
const runs = Number(arg('runs', 3))
const out = path.resolve(arg('out', `perf-${target.name}.json`))
const verifyDir = path.resolve(arg('verify-dir', process.env.VERIFY_DIR ?? path.dirname(out)))
const ctx = await target.connect({ verifyDir, base: arg('base') ?? undefined })
const P = target.perf
const PROFILES = {
  desktop: { width: 1440, height: 900, cpu: 1 },
  'desktop-4x': { width: 1440, height: 900, cpu: 4 },
  'phone-4x': { width: 390, height: 844, cpu: 4, mobile: true },
}
const only = (arg('profiles') ?? Object.keys(PROFILES).join(',')).split(',')
const median = xs => { const s = xs.filter(x => x != null).sort((a, b) => a - b); return s.length ? Math.round(s[Math.floor((s.length - 1) / 2)]) : null }

// In the page before anything runs: long tasks, and a watcher that notes (Date.now()) when a selector or a text first appears.
const WATCH = `
window.__v = { long: 0, longest: 0, hits: {} }
try { new PerformanceObserver(l => { for (const e of l.getEntries()) { __v.long += e.duration; __v.longest = Math.max(__v.longest, e.duration) } }).observe({ type: 'longtask', buffered: true }) } catch {}
window.__arm = (key, sel, text) => {
  delete __v.hits[key]
  const look = () => { const el = sel && document.querySelector(sel); if (el && (!text || (document.body?.textContent ?? '').includes(text))) { __v.hits[key] = { at: Date.now(), perf: performance.now() }; return true } return false }
  if (look()) return
  const mo = new MutationObserver(() => { if (look()) mo.disconnect() })
  mo.observe(document, { childList: true, subtree: true, attributes: true, characterData: true })
}
window.__armReady = sel => window.__arm('ready', sel)
`

async function fresh(profile) {
  const p = PROFILES[profile]
  const h = await openPage({ profile: { ...p }, base: ctx.base, hostRules: arg('hosts') ?? '', init: [WATCH] })
  await h.page.send('Performance.enable')
  if (p.cpu > 1) await h.page.send('Emulation.setCPUThrottlingRate', { rate: p.cpu })
  await target.prepare(h, ctx, { dark: false })
  let requests = 0, bytes = 0
  h.page.on('Network.requestWillBeSent', () => { requests++ })
  h.page.on('Network.loadingFinished', e => { bytes += e.encodedDataLength })
  h.net = () => ({ requests, kB: Math.round(bytes / 1024) })
  h.resetNet = () => { requests = 0; bytes = 0 }
  return h
}

/** Load a path and wait (in-page clock) until ready stands: ms after navigation start. */
async function load(h, p, ready, ms = 20000) {
  h.armed ??= new Set()
  if (!h.armed.has(ready)) { h.armed.add(ready); await h.page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(function a(){ if (window.__armReady) __armReady(${JSON.stringify(ready)}); else setTimeout(a, 5) })()` }) }
  h.resetNet()
  await h.page.send('Page.navigate', { url: ctx.base + p })
  const hit = await h.waitFor(`return window.__v?.hits?.ready?.perf ?? (document.querySelector(${JSON.stringify(ready)}) ? performance.now() : null)`, ms)
  await sleep(1500)   // let late requests and long tasks land
  const v = await h.ev(`return { fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null, long: __v.long, longest: __v.longest, dom: document.querySelectorAll('*').length }`)
  return { readyMs: hit == null ? null : Math.round(hit), fcpMs: v.fcp == null ? null : Math.round(v.fcp), longTasksMs: Math.round(v.long), longestTaskMs: Math.round(v.longest), domNodes: v.dom, ...h.net() }
}

/** Click something on the open page; ms (in-page clock) from the click until ready stands. */
async function clickTo(h, click, ready, ms = 15000) {
  await h.ev(`__arm('nav', ${JSON.stringify(ready)}); window.__navStart = Date.now(); return 1`)
  // the watcher fires at once if ready already stands (a selector shared by both pages): then it is armed after the click below
  const pre = await h.ev(`return !!__v.hits.nav`)
  await h.click(click)
  if (pre) await h.ev(`__arm('nav', ${JSON.stringify(ready)}); return 1`)
  const r = await h.waitFor(`return __v?.hits?.nav ? __v.hits.nav.at - window.__navStart : null`, ms)
  return r == null ? null : Math.round(r)
}

const results = { target: target.name, base: ctx.base, when: new Date().toISOString(), runs, profiles: {} }
for (const profile of only) {
  const r = { cold: [], warm: [], nav: {}, live: {} }
  for (let i = 0; i < runs; i++) {
    const h = await fresh(profile)
    try {
      r.cold.push(await load(h, P.desk.path, P.desk.ready))
      r.warm.push(await load(h, P.desk.path, P.desk.ready))
      for (const step of P.nav) { await h.settle(); await sleep(500); (r.nav[step.name] ??= []).push(await clickTo(h, step.click, step.ready).catch(() => null)) }
    } finally { await h.close() }
  }
  // live: one page open, N tool calls
  const lives = await P.live(ctx)
  for (const lv of lives) {
    const h = await fresh(profile)
    try {
      await load(h, lv.path, lv.ready)
      for (let i = 0; i < Math.max(runs, 5); i++) {
        const nonce = `pulse${Date.now().toString(36)}${i}`
        await h.ev(`__arm('live', 'body', ${JSON.stringify(nonce)}); return 1`)
        const t0 = Date.now()
        await lv.send(nonce)
        const at = await h.waitFor(`return __v?.hits?.live?.at ?? null`, 15000)
        ;(r.live[lv.name] ??= []).push(at == null ? null : at - t0)
        await sleep(400)
      }
    } finally { await h.close(); await lv.cleanup?.() }
  }
  const pick = (list, k) => median(list.map(x => x[k]))
  results.profiles[profile] = {
    cold: { readyMs: pick(r.cold, 'readyMs'), fcpMs: pick(r.cold, 'fcpMs'), requests: pick(r.cold, 'requests'), kB: pick(r.cold, 'kB'), longTasksMs: pick(r.cold, 'longTasksMs'), longestTaskMs: pick(r.cold, 'longestTaskMs'), domNodes: pick(r.cold, 'domNodes') },
    warm: { readyMs: pick(r.warm, 'readyMs'), fcpMs: pick(r.warm, 'fcpMs'), requests: pick(r.warm, 'requests'), kB: pick(r.warm, 'kB') },
    nav: Object.fromEntries(Object.entries(r.nav).map(([k, v]) => [k, median(v)])),
    live: Object.fromEntries(Object.entries(r.live).map(([k, v]) => [k, { p50: median(v), max: Math.max(...v.filter(x => x != null)), n: v.length, misses: v.filter(x => x == null).length }])),
    raw: r,
  }
  console.log(profile, JSON.stringify({ ...results.profiles[profile], raw: undefined }))
}
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, JSON.stringify(results, null, 1))
console.log(`written ${out}`)
process.exit(0)
