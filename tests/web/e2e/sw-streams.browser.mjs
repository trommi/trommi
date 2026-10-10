// sw-streams.browser.mjs: ten reloads of a signed-in app whose hub answers on the app's own origin (as a local
// stack does), with the app's service worker active, and the live streams the hub holds open counted after each.
// Every reload ends the page's stream; one stream stays open, the page's own. (Firefox kept a stream the service
// worker had passed on open after each reload, until the six connections to the host were taken and the board stayed
// "loading": sw.js now leaves /v2/ alone. This runs in Chromium, which did not show the leak: it guards the
// count, tests/web/worker/sw.test.mjs guards the handler itself.)
//   node tests/web/e2e/sw-streams.browser.mjs        (needs Chromium and the built core; one browser at a time)
// REAL: the built app with its service worker (VERSION written by the build), the real binding in the worker.
// NOT REAL: the hub is the FAKE hub (tests/web/stand-in/hub.mjs).
import { startFakeHub } from '../stand-in/hub.mjs'
import { hubReaders } from '../stand-in/core.ts'
import { buildApp, main, openProfile, run, serveApp, sleep, standInWorker, watch } from './harness.mjs'
import * as ui from './ui.mjs'

const RELOADS = 10

export async function setUp() {
  const dir = await buildApp('sw-streams-dist')
  await standInWorker(dir)
  let hubUrl = null
  const app = await serveApp(dir, () => hubUrl)
  const hubAuth = bytes => { const a = hubReaders.hubAuth(bytes); return a.hub === app.origin ? { ...a, hub: hubUrl } : a }
  const fake = await startFakeHub({ readers: { ...hubReaders, hubAuth } })
  hubUrl = fake.url
  return { app, fake, seen: watch(), run: run('service worker: ten reloads, the hub on the app\'s origin'), profile: null }
}
export async function tearDown(ctx) {
  await ctx.profile?.close().catch(() => {})
  await ctx.app.close().catch(() => {})
  await ctx.fake.close().catch(() => {})
}

export const steps = [
  ['an account, its room live, the service worker in control of the page', async ctx => {
    ctx.profile = await openProfile('sw', ctx.seen)
    const page = ctx.profile.page
    await ui.signUp(page, ctx.app.start('/'), `sw+${Date.now().toString(36)}@example.org`)
    await ui.takeKit(page)
    await ui.live(page)
    // (the worker installs on the first load; the next load is the first it controls)
    await page.go(ctx.app.start('/'))
    await ui.live(page)
    await page.until('!!navigator.serviceWorker.controller', 'a page under the service worker', 30000)
  }],
  [`${RELOADS} reloads: the hub holds one stream open at the end, never more than two at once`, async ctx => {
    const page = ctx.profile.page, counts = []
    for (let i = 0; i < RELOADS; i++) {
      await page.reload()
      await ui.live(page, `live after reload ${i + 1}`)
      await page.until('!!navigator.serviceWorker.controller', 'still under the service worker', 10000)
      counts.push(ctx.fake.streams)
    }
    // a stream the browser ended reaches the hub's side within a moment
    for (let i = 0; i < 30 && ctx.fake.streams > 1; i++) await sleep(100)
    ctx.run.check(ctx.fake.streams === 1, 'one stream open after the reloads', { now: ctx.fake.streams, after_each: counts })
    ctx.run.check(Math.max(...counts) <= 2, 'never more than the old and the new page\'s at once', counts)
    return `streams after each reload: ${counts.join(' ')}; at the end ${ctx.fake.streams}`
  }],
  ['nothing the page complained about', async ctx => {
    const { exceptions, csp } = ctx.seen
    ctx.run.check(exceptions.length === 0, 'no uncaught exception', exceptions.slice(0, 5))
    ctx.run.check(csp.length === 0, 'no policy violation', csp.slice(0, 5))
  }],
]

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main('sw-streams', { setUp, steps, tearDown }, {})
