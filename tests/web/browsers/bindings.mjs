// bindings.mjs: the browser binding's own test page (tests/bindings/web/page.mjs, unchanged) in an engine of
// Playwright: what tests/bindings/browser.mjs does in headless Chromium, case by case, each in a browser process and
// a profile folder of its own:
//   page, worker   the core's self-test in the page and in a module worker under the app's policy
//   scenario       tests/bindings/scenario.json, every device in a worker of its own, IndexedDB as the store
//   kill           a worker killed between a write and its sending; a second worker cannot open a held state
//   store          the IndexedDB store's edges: reopen at once, a wait given up, another owner, a stolen lock, a
//                  failed load that frees the lock
//   times          a MiB encrypted and decrypted
// A case passes as it passes in browser.mjs: ok, no policy violation, nothing on the console, the .wasm served as
// application/wasm.
import { counted } from './pw.mjs'

export const CASES = ['page', 'worker', 'scenario', 'kill', 'store', 'times']

/** One case in one new profile: what the page's `run(what)` returned, or `{ ok: false, error }`. */
export async function runCase(ctx, what, opts = {}) {
  return ctx.within(`bindings-${what}`, opts, async (profile, seen) => {
    await profile.page.go(`${ctx.server.numeric}/`)
    await profile.page.until("typeof run === 'function'", 'the bindings page', 20000)
    let result
    try { result = await Promise.race([profile.page.js(`return run(${JSON.stringify(what)})`), new Promise((_, no) => setTimeout(() => no(new Error(`no answer within 180 s`)), 180000))]) } catch (err) { result = { ok: false, error: err.message.split('\n')[0], violations: [] } }
    return { ...result, console: counted([...seen.exceptions, ...seen.errors, ...seen.warnings, ...seen.csp]) }
  })
}

export const steps = CASES.map(what => [`the binding's test page: ${what}`, async ctx => {
  const { check, note } = ctx.run
  const result = await runCase(ctx, what)
  ;(ctx.report.bindings ??= {})[what] = result
  check(result.ok === true, 'the case passes', Object.fromEntries(Object.entries(result).filter(([k]) => !['steps', 'versions', 'console'].includes(k))))
  check((result.violations ?? []).length === 0, 'no violation of the policy', result.violations)
  check(result.console.length === 0, 'nothing on the console', result.console)
  if (result.contentType !== undefined) check(result.contentType === 'application/wasm', 'the .wasm is served as application/wasm', result.contentType)
  if (result.load != null) note(`the .wasm fetched and compiled in ${result.load} ms`)
  if (result.steps) {
    const total = result.steps.reduce((sum, step) => sum + (step.micros ?? 0), 0)
    note(`self-test: ${result.steps.length} steps, ${(total / 1000).toFixed(0)} ms${result.steps.filter(s => !s.ok).map(s => `; FAILED ${s.name}: ${s.detail}`).join('')}`)
  }
  if (what === 'times') note(`1 MiB encrypted in ${result.encryptMiB} ms, decrypted in ${result.decryptMiB} ms`)
  if (what === 'store' || what === 'kill' || what === 'scenario') note(JSON.stringify(Object.fromEntries(Object.entries(result).filter(([k]) => !['console', 'violations', 'contentType', 'load'].includes(k)))))
}])
