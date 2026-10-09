// probe-worker.mjs: a module worker that loads the Rust core through core-wasm.ts and reports what it got. It stands
// in for the app's worker in the tests of the build (wasm-load.mjs, measure.mjs) as long as that worker does not load
// the core itself; built.mjs bundles it as the build bundles the app's worker.
// It posts { loaded: true } once loadCore() resolved (the .wasm fetched, checked, compiled and instantiated), and
// then one report: { versions, selfTest, missing, refusal, violations }, or { error, violations } when
// anything threw. `selfTest` is the binding's own self test, run here; `missing` is what a call the binding lacks
// threw and `refusal` the code of a refusal of the binding itself, both as errorCode() reads them; `violations` are
// the Content-Security-Policy violations seen inside the worker (the page does not see them).
import { loadCore } from '../../../app/web/core/core-wasm.ts'

const violations = []
addEventListener('securitypolicyviolation', e => violations.push(`${e.violatedDirective} ${e.blockedURI}`))
try {
  const core = await loadCore()
  postMessage({ loaded: true })
  const selfTest = core.selfTest(Date.now())
  let missing = null
  try { core.hubAddress('https://hub.example') } catch (err) { missing = { code: core.errorCode(err), message: err.message } }
  postMessage({ versions: core.versions(), selfTest, missing, refusal: refusalOf(core), violations })
} catch (err) {
  postMessage({ error: `${err.name}: ${err.message}`, violations })
}

/** What the binding itself refuses, as errorCode() reads it: a real call with a wrong argument. */
function refusalOf(core) {
  try { core.parseRecoveryCode('not a code'); return null } catch (err) { return core.errorCode(err) }
}
