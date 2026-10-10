// kit.browser.mjs: the Emergency Kit screen after sign-up is shown, and stays until "Open Trommi", whatever this
// browser's storage does: localStorage that throws on every call (a private window may), localStorage that keeps
// nothing, and a page change while the kit is up (it closes every dialog). Headless Chromium, the real core, the
// FAKE hub (tests/web/stand-in/hub.mjs).
//   node tests/web/account/kit.browser.mjs        (needs Chromium and the built core; one browser at a time)
import { setUp, tearDown } from '../e2e/standin.mjs'
import { main, run, sleep } from '../e2e/harness.mjs'
import * as ui from '../e2e/ui.mjs'

// (localStorage alone: sessionStorage keeps the tab's hub address, ?hub=, as the app does)
const STORAGE = {
  throwing: "Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('The operation is insecure.', 'SecurityError') } })",
  forgetful: "Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: () => null, setItem() {}, removeItem() {}, clear() {}, key: () => null, length: 0 } })",
}
const shown = "!!document.querySelector('#kit-gate[open] #kit-show') && document.querySelector('#kit-gate #kit-show').getClientRects().length > 0"

export async function setUpKit() {
  const ctx = await setUp()
  ctx.run = run('the Emergency Kit after sign-up, whatever storage does')
  return ctx
}
export const steps = Object.entries(STORAGE).map(([how, script]) => [`localStorage ${how}: the kit is shown after sign-up, stays through a page change and 3 s, and "Open Trommi" closes it`, async ctx => {
  const P = await ctx.profile(`kit-${how}`)
  await P.session.send('Page.addScriptToEvaluateOnNewDocument', { source: script })
  await ui.signUp(P, ctx.app.start(), `kit-${how}-${Date.now().toString(36)}@example.org`)
  ctx.run.check(await P.js(`return ${shown}`), 'the kit screen with its Show button')
  // a page change of the board under it (ui.mjs closes every open dialog then)
  await P.js("document.dispatchEvent(new Event('turbo:before-cache')); return true")
  await sleep(3000)
  ctx.run.check(await P.js(`return ${shown}`), 'still shown after a page change and three seconds')
  await ui.takeKit(P)
  ctx.run.check(await P.js("return !document.querySelector('#kit-gate[open]')"), 'gone after Open Trommi')
  await ctx.closeProfile(`kit-${how}`)
}])

steps.push(['"Open Trommi", then a reload at once, before the hub took that write: the kit screen never shows again', async ctx => {
  const P = await ctx.profile('kit-reload')
  await ui.signUp(P, ctx.app.start(), `kit-reload-${Date.now().toString(36)}@example.org`)
  await ui.readKit(P)
  await ui.live(P)
  await sleep(1500)
  // (the write that clears the kit is slow to reach the hub, as on a real line: the page is loaded again before it)
  ctx.fake.faults.add({ method: 'POST', path: '/v2/envelopes', delay_ms: 3000, times: 5 })
  await ui.leaveKit(P)
  await P.reload()
  const seen = []
  for (let i = 0; i < 60; i++) { if (await P.js("return !!document.querySelector('#kit-gate[open]')").catch(() => false)) seen.push(i * 100); await sleep(100) }
  ctx.fake.faults.clear()
  ctx.run.check(!seen.length, 'no Emergency Kit screen at any moment of six seconds after the reload', seen.length ? `shown from ${seen[0]} ms to ${seen.at(-1)} ms` : undefined)
  await ctx.closeProfile('kit-reload')
}])
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main('kit', { setUp: setUpKit, steps, tearDown }, {})
