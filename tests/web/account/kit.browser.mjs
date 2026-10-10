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
  // (and the hub is slow to answer what the page asks first after the reload, as production is: the page shows its
  //  cache meanwhile)
  for (const path of ['/v2/desk', '/v2/changes']) ctx.fake.faults.add({ method: 'GET', path, delay_ms: 1200, times: 3 })
  // (every moment counts: the page itself notes when the kit's dialog opens, however briefly)
  await P.session.send('Page.addScriptToEvaluateOnNewDocument', { source: "window.__kitOpened = []; new MutationObserver(() => { const d = document.querySelector('#kit-gate'); if (d?.open && !window.__kitOpened.length) window.__kitOpened.push(Math.round(performance.now())) }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] })" })
  await ui.leaveKit(P)
  // (the page goes before its cache caught up with the device: the cache is marked one step behind, so the reload
  //  draws from it and reads the rest back from the hub first, the slow path production took)
  await P.js(`const db = await new Promise((ok, no) => { const r = indexedDB.open('trommi:cache'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error) })
    const name = [...db.objectStoreNames][0], tx = db.transaction(name, 'readwrite'), store = tx.objectStore(name)
    const at = await new Promise(ok => { const g = store.get('client/at'); g.onsuccess = () => ok(g.result) })
    if (at && at.cursor > 0) store.put({ ...at, cursor: at.cursor - 1 }, 'client/at')
    await new Promise(ok => { tx.oncomplete = ok }); db.close(); return true`)
  await P.reload()
  if (process.env.KIT_TRACE) for (let i = 0; i < 40; i++) { console.log(await P.js("const m = window.trommi?.client?.model; const r = m?.human?.raw?.get('kit'); return JSON.stringify({ t: Math.round(performance.now()), gate: !!document.querySelector('#kit-gate[open]'), kit: r === undefined ? 'absent' : { v: r.value ?? null, p: r.pending ?? null, n: r.envelope_number ?? null }, conn: m?.room.connection })").catch(e => e.message)); await sleep(50) }
  await sleep(6000)
  const opened = await P.js('return window.__kitOpened')
  ctx.fake.faults.clear()
  ctx.run.check(!opened.length, 'no Emergency Kit screen at any moment of six seconds after the reload', opened.length ? `opened ${opened[0]} ms after the page began` : undefined)
  await ctx.closeProfile('kit-reload')
}])
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main('kit', { setUp: setUpKit, steps, tearDown }, {})
