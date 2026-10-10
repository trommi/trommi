// A module worker for the probe: answers `probe` with what the engine gives in a worker, and `hold`/`try` for the
// Web Lock questions that need two contexts.
import { probe } from './probe.mjs'

const violations = []
addEventListener('securitypolicyviolation', event => violations.push(`${event.violatedDirective} ${event.blockedURI}`))

const asks = {
  probe: () => probe(),
  violations: () => violations,
  /** Takes the lock and keeps it (until the worker is ended). */
  hold: ({ name }) => new Promise((resolve, reject) => {
    navigator.locks.request(name, { ifAvailable: true }, held => { if (!held) { resolve(false); return undefined } resolve(true); return new Promise(() => {}) }).catch(reject)
  }),
  try: ({ name }) => navigator.locks.request(name, { ifAvailable: true }, held => held !== null),
}
onmessage = async ({ data: { id, ask, ...rest } }) => {
  try { postMessage({ id, result: await asks[ask](rest) }) } catch (error) { postMessage({ id, error: `${error?.name}: ${error?.message}` }) }
}
postMessage({ id: 0, result: 'started' })
