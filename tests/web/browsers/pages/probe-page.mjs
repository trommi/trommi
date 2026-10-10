// The probe's page: `probeAll()` asks the engine in the page and in a module worker, and across the two.
import { probe } from './probe.mjs'

const violations = []
addEventListener('securitypolicyviolation', event => violations.push(`${event.violatedDirective} ${event.blockedURI}`))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function worker() {
  const waiting = new Map()
  let next = 0, thread
  const started = new Promise((resolve, reject) => {
    waiting.set(0, { resolve, reject })
    try { thread = new Worker('/tests/web/browsers/pages/probe-worker.mjs', { type: 'module', name: 'probe' }) } catch (error) { reject(error); return }
    thread.onmessage = ({ data: { id, result, error } }) => { const w = waiting.get(id); waiting.delete(id); if (error) w.reject(new Error(error)); else w.resolve(result) }
    thread.onerror = event => { for (const w of waiting.values()) w.reject(new Error(event.message || 'the worker failed to start')) }
    setTimeout(() => reject(new Error('the module worker did not start within 10 s')), 10000)
  })
  return { started, ask: (ask, rest = {}) => new Promise((resolve, reject) => { waiting.set(++next, { resolve, reject }); thread.postMessage({ id: next, ask, ...rest }) }), stop: () => thread?.terminate() }
}
const attempt = async work => { try { return await work() } catch (error) { return { error: `${error?.name ?? 'Error'}: ${error?.message ?? error}` } } }

globalThis.probeAll = async () => {
  const out = { userAgent: navigator.userAgent, page: await probe() }
  out.worker = await attempt(async () => {
    const own = worker()
    try { await own.started; const found = await own.ask('probe'); violations.push(...await own.ask('violations')); return found } finally { own.stop() }
  })
  // Across contexts: a lock a worker holds is refused to the page, and is free again once that worker is ended
  // (a tab that is closed, a worker that is stopped: the next owner must not wait for ever).
  out.across = await attempt(async () => {
    if (!navigator.locks) return { has: false }
    const name = `probe-across-${Date.now()}`
    const own = worker()
    await own.started
    const held = await own.ask('hold', { name })
    const refused = await navigator.locks.request(name, { ifAvailable: true }, lock => lock === null)
    const start = performance.now()
    own.stop()
    let freedAfter = null
    for (let i = 0; i < 100 && freedAfter === null; i++) {
      if (await navigator.locks.request(name, { ifAvailable: true }, lock => lock !== null)) freedAfter = Math.round(performance.now() - start)
      else await sleep(50)
    }
    return { held, refused, freedAfterMs: freedAfter }
  })
  out.violations = [...violations]
  return out
}
