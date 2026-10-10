// streams.mjs: the live stream across reloads, with the app's service worker active and the hub on the app's origin
// (as a local stack has it). Signs up, then loads the page again ten times, and counts the /v2/stream requests the
// hub's side holds open after each (a counting pass-through in front of the hub binary). One stays open: the page's
// own; a second may be closing. Firefox kept every earlier page's stream open until the six connections to the host
// were taken (and the hub at app.trommi.com answers 429 from the eighth on).
//   node tests/web/browsers/run.mjs --browser firefox streams
import http from 'node:http'
import { buildApp, serveApp } from '../e2e/harness.mjs'
import * as ui from '../e2e/ui.mjs'
import { startHub } from './app.mjs'
import { openProfile, sleep, watch } from './pw.mjs'

export const ownServer = true
const RELOADS = 10

/** A pass-through to `target()` that keeps the /v2/stream requests it holds open. */
async function counting(target) {
  const open = new Set(), started = []
  const server = http.createServer((req, res) => {
    const to = new URL(target())
    const out = http.request({ host: to.hostname, port: to.port, method: req.method, path: req.url, headers: { ...req.headers, host: to.host } }, got => {
      res.writeHead(got.statusCode, got.headers); res.flushHeaders(); got.pipe(res)
      got.on('error', () => res.destroy()); got.on('close', () => { if (!res.writableEnded) res.destroy() })
    })
    const rec = { path: req.url, at: Date.now() }
    if (req.url.startsWith('/v2/stream')) { started.push(rec); open.add(rec); res.on('close', () => { rec.closed = Date.now() }); res.on('close', () => open.delete(rec)) }
    out.on('error', () => res.destroy())
    res.on('close', () => out.destroy())
    req.pipe(out)
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}`, open, started, close: () => { server.closeAllConnections(); return new Promise(r => server.close(r)) } }
}

export async function setUp(ctx) {
  const dir = await buildApp(`streams-${ctx.engine}`)
  let hubUrl = null
  const pass = await counting(() => hubUrl)
  const app = await serveApp(dir, () => pass.url)
  const hub = await startHub(app.origin)
  hubUrl = hub.url
  Object.assign(ctx, { app, hub, pass, seen: Object.assign(watch({ requests: true }), { shots: ctx.out }) })
}
export async function tearDown(ctx) {
  await ctx.profile?.close().catch(() => {})
  await ctx.app?.close().catch(() => {})
  await ctx.pass?.close().catch(() => {})
  await ctx.hub?.close().catch(() => {})
}

export const steps = [
  [`signed in with the service worker in control, ${RELOADS} reloads: the hub holds one stream open (two at most while one closes)`, async ctx => {
    const { check, note } = ctx.run
    ctx.profile = await openProfile(ctx.engine, 'R', ctx.seen)
    const P = ctx.profile.page
    await ui.signUp(P, ctx.app.start(), `e2e+streams-${ctx.engine}-${Date.now().toString(36)}@example.org`)
    await ui.takeKit(P)
    await ui.live(P, 'live', 40000)
    const controlled = await P.js('return !!navigator.serviceWorker?.controller')
    note(`the service worker controls the page: ${controlled}`)
    const counts = []
    for (let i = 1; i <= RELOADS; i++) {
      await P.reload()
      const live = await ui.live(P, `live after reload ${i}`, 20000).then(() => true, () => false)
      await sleep(1500)
      counts.push(ctx.pass.open.size)
      note(`reload ${i}: ${live ? 'live' : 'NOT live'}; streams open at the hub: ${ctx.pass.open.size} (started so far: ${ctx.pass.started.length})`)
      if (!live) break
    }
    ctx.report.streams = { controlled, counts }
    check(controlled, 'the service worker is in control (else this proves nothing)')
    check(counts.length === RELOADS && counts.every(n => n <= 2), 'never more than two streams open', counts)
    check(counts.at(-1) <= 1 || (await sleep(3000), ctx.pass.open.size <= 1), 'one stream open at the end', ctx.pass.open.size)
  }],
]
