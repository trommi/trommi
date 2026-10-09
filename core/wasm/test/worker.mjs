// The call into the core in a module worker, as the app's core runs. Its own CSP violations are collected here: the page
// does not see them.
import { roundTrip } from '/test/round-trip.mjs'
const violations = []
addEventListener('securitypolicyviolation', e => violations.push(`${e.violatedDirective} ${e.blockedURI}`))
roundTrip().then(r => postMessage({ ...r, workerViolations: violations }), e => postMessage({ error: `${e.name}: ${e.message}`, workerViolations: violations }))
