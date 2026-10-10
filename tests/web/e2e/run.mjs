// run.mjs: the end-to-end runs of the web app, one line per step.
//   node tests/web/e2e/run.mjs [standin|real|all]        (default: all)
//     standin   standin.mjs: the built app with the STAND-IN core against the FAKE hub (no content cryptography)
//     real      real.mjs: the built app with the real core against the REAL hub's binary (TROMMI_HUB_BIN)
//     all       both; `real` is skipped, loudly, when TROMMI_HUB_BIN is not set
//   node tests/web/e2e/run.mjs real --app <app URL> --hub <hub URL> [--shots <folder>]
//     remote.mjs: the real run's core steps against an app and a hub that are already deployed. Nothing is built
//     or started; it makes ONE account `e2e-<random>@example.invalid` there. Read remote.mjs before pointing it
//     at a hub that is not yours.
// Exit 0: every step of every run passed · 1: a step failed · 2: a run could not start (Chromium, esbuild, the
// core's WASM package or the hub's binary is missing: the message says which).
// It needs Chromium (`chromium` on the PATH or CHROMIUM), which cannot run inside a command sandbox. Everything it
// writes goes under TROMMI_E2E_TMP (default: trommi-e2e in the system's temporary folder), screenshots under
// TROMMI_E2E_SHOTS (default: trommi-e2e-shots there).
import { runScenario } from './harness.mjs'

const RUNS = {
  standin: { file: './standin.mjs', needs: {} },
  real: { file: './real.mjs', needs: { hub: true } },
}
const which = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'all'
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1] ?? null }
if (arg('--app') || arg('--hub')) {
  if (which !== 'real' || !arg('--app') || !arg('--hub')) { console.error('usage: node tests/web/e2e/run.mjs real --app <app URL> --hub <hub URL> [--shots <folder>]'); process.exit(2) }
  const { runRemote } = await import('./remote.mjs')
  process.exit(await runRemote({ app: arg('--app'), hub: arg('--hub'), shots: arg('--shots') }))
}
if (which !== 'all' && !RUNS[which]) { console.error('usage: node tests/web/e2e/run.mjs [standin|real|all]'); process.exit(2) }

let failed = 0, cannot = false
for (const name of which === 'all' ? Object.keys(RUNS) : [which]) {
  if (which === 'all' && name === 'real' && !process.env.TROMMI_HUB_BIN) {
    console.log('SKIPPED: the run against the REAL hub (TROMMI_HUB_BIN is not set). Nothing above is evidence about the real hub.')
    continue
  }
  console.log(`---- ${name} ----`)
  try { failed += await runScenario(name, await import(RUNS[name].file), RUNS[name].needs) } catch (err) {
    if (!err?.cannot) throw err
    console.error(err.message)
    cannot = true
  }
}
process.exit(cannot ? 2 : failed ? 1 : 0)
