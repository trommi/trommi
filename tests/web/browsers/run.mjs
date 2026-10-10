// run.mjs: the web app's ground in other engines than Chromium, one line per step.
//   node tests/web/browsers/run.mjs --browser firefox|webkit|chromium [engine|bindings|private|remote|app|all]
//     engine     engine.mjs: what the engine gives the core (WebAssembly under the policy, strict durability, Web
//                Locks, a fetch stream), in the page and in a module worker
//     bindings   bindings.mjs: the binding's own test page (tests/bindings/web/page.mjs) with the real core
//     private    private.mjs: the same in a private window
//     remote     remote.mjs: a deployed app loaded and its self-test page read, nothing written
//                (--app <URL>, default https://app.trommi.com)
//     app        app.mjs: the built app against a local hub's binary (TROMMI_HUB_BIN)
//     --no-sw    the app's service worker blocked in every profile (to tell its effects apart; not the real mode)
//     all        (default) engine, bindings, private, and app when TROMMI_HUB_BIN is set; not remote
// Exit 0: every step passed · 1: a step failed · 2: it could not start (the message says what is missing).
// Needs Playwright in a folder of its own (pw.mjs says how; TROMMI_PLAYWRIGHT, PLAYWRIGHT_BROWSERS_PATH) and the
// core's WASM package (core/wasm/build.sh). It writes under TROMMI_BROWSERS_TMP, and its screenshots and a
// report-<mode>.json per engine under TROMMI_BROWSERS_OUT/<engine>/. One browser at a time.
import fs from 'node:fs'
import path from 'node:path'
import { ENGINES, OUT, TMP, counted, loadPlaywright, openProfile, watch } from './pw.mjs'

const args = process.argv.slice(2)
const arg = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1] ?? null }
const engine = arg('--browser')
const flags = new Set(['--browser', '--app'])
if (args.includes('--no-sw')) process.env.TROMMI_BROWSERS_NO_SW = '1'
const mode = args.find((a, i) => !a.startsWith('--') && !flags.has(args[i - 1])) ?? 'all'
const MODES = { engine: './engine.mjs', bindings: './bindings.mjs', private: './private.mjs', remote: './remote.mjs', app: './app.mjs' }
if (!ENGINES.includes(engine) || (mode !== 'all' && !MODES[mode])) {
  console.error(`usage: node tests/web/browsers/run.mjs --browser ${ENGINES.join('|')} [${Object.keys(MODES).join('|')}|all] [--app <URL>]`)
  process.exit(2)
}
// (tests/web/e2e/harness.mjs, whose step list and app server are used, writes under its own folder: ours)
process.env.TROMMI_E2E_TMP ??= path.join(TMP, 'e2e')
process.env.TROMMI_E2E_SHOTS ??= path.join(OUT, engine + (args.includes('--no-sw') ? '-no-sw' : ''))
const { run } = await import('../e2e/harness.mjs')
const { serveEngine, REPO } = await import('./serve.mjs')

const out = path.join(OUT, engine + (process.env.TROMMI_BROWSERS_NO_SW === '1' ? '-no-sw' : ''))
fs.mkdirSync(out, { recursive: true })
let failed = 0, could = true
try {
  loadPlaywright()
  if (!fs.existsSync(path.join(REPO, 'core/wasm/pkg/trommi_core_wasm_bg.wasm'))) throw Object.assign(new Error('the Rust core\'s WASM package is missing: core/wasm/pkg/ (run core/wasm/build.sh)'), { cannot: true })
  const modes = mode === 'all' ? ['engine', 'bindings', 'private', ...(process.env.TROMMI_HUB_BIN ? ['app'] : [])] : [mode]
  if (mode === 'all' && !process.env.TROMMI_HUB_BIN) console.log('SKIPPED: app (TROMMI_HUB_BIN is not set). Nothing below is evidence about the app\'s screens.')
  for (const name of modes) {
    console.log(`---- ${engine}: ${name} ----`)
    const scenario = await import(MODES[name])
    const server = scenario.ownServer ? null : await serveEngine()
    const ctx = {
      engine, server, out, run: run(`${engine} ${name}`), report: { engine, mode: name }, appUrl: arg('--app'),
      /** A profile for one piece of work: opened, handed to `fn` with what was seen in it, closed whatever happens. */
      async within(label, opts, fn) {
        const seen = Object.assign(watch(opts), { shots: out })
        const profile = await openProfile(engine, label, seen, opts)
        ctx.report.version ??= profile.version
        try { return await fn(profile, seen) } finally { await profile.close() }
      },
    }
    try {
      if (scenario.setUp) await scenario.setUp(ctx)
      for (const [step, fn] of scenario.steps) await ctx.run.step(step, () => fn(ctx))
    } finally {
      await scenario.tearDown?.(ctx).catch(() => {})
      await server?.close()
    }
    failed += ctx.run.finish()
    fs.writeFileSync(path.join(out, `report-${name}.json`), JSON.stringify(ctx.report, null, 2))
  }
} catch (err) {
  if (!err?.cannot) throw err
  console.error(`${engine}: cannot run: ${err.message}`)
  could = false
}
console.log(`${engine}: reports and screenshots in ${out}`)
process.exit(!could ? 2 : failed ? 1 : 0)
export { counted }
