// The test page's module: the round trip in the page itself, or in a module worker (as the app's core runs).
import { roundTrip } from '/test/round-trip.mjs'
const violations = []
addEventListener('securitypolicyviolation', e => violations.push(`${e.violatedDirective} ${e.blockedURI}`))
globalThis.run = async where => {
  const result = where === 'worker'
    ? await new Promise((resolve, reject) => {
        const worker = new Worker('/test/worker.mjs', { type: 'module' })
        worker.onmessage = e => { worker.terminate(); e.data.error ? reject(new Error(`${e.data.error} [worker violations: ${e.data.workerViolations.join('; ')}]`)) : resolve(e.data) }
        worker.onerror = e => { worker.terminate(); reject(new Error(e.message || 'the worker failed to start')) }
      })
    : await roundTrip()
  return { ...result, violations: [...violations, ...(result.workerViolations ?? [])] }
}
