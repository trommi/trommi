// The test page: the binding in the page itself and in module workers, under the web app's Content-Security-Policy.
// tests/bindings/browser.mjs loads it in headless Chromium and calls run(what).
import * as core from '/core/wasm/pkg/trommi-core.js'
import { IdbStore } from '/core/wasm/pkg/idb-store.js'
import { runScenario } from '/tests/bindings/scenario.mjs'

const violations = []
addEventListener('securitypolicyviolation', event => violations.push(`${event.violatedDirective} ${event.blockedURI}`))

/** A worker and a way to ask it. */
function worker() {
  const thread = new Worker('/tests/bindings/web/worker.mjs', { type: 'module' })
  const waiting = new Map()
  let next = 0
  thread.onmessage = ({ data: { id, result, error } }) => {
    const { resolve, reject } = waiting.get(id)
    waiting.delete(id)
    if (error) reject(Object.assign(new Error(error.message), { code: error.code }))
    else resolve(result)
  }
  thread.onerror = event => { for (const { reject } of waiting.values()) reject(new Error(event.message || 'the worker failed to start')) }
  return {
    ask: (ask, rest = {}) => new Promise((resolve, reject) => { waiting.set(++next, { resolve, reject }); thread.postMessage({ id: next, ask, ...rest }) }),
    stop: () => thread.terminate(),
  }
}

/** A device in a worker of its own, stored in IndexedDB under a name of this run. */
async function deviceInWorker(run, name, how, wait = false) {
  const own = worker()
  try {
    await own.ask('start', { name: `${run}-${name}`, how, wait })
  } catch (error) {
    own.stop()
    throw error
  }
  return {
    call: (method, ...args) => own.ask('call', { method, args }),
    close: async () => { await own.ask('close'); violations.push(...await own.ask('violations')); own.stop() },
    failNextWrite: () => own.ask('failNextWrite'),
    kill: () => own.stop(),
  }
}

const cases = {
  /** The self-test in the page. */
  async page() {
    const report = core.selfTest(Date.now())
    return { ok: report.ok, steps: report.steps, versions: report.versions }
  },

  /** The self-test in a module worker. */
  async worker() {
    const own = worker()
    try {
      const report = await own.ask('selfTest')
      violations.push(...await own.ask('violations'))
      return { ok: report.ok, steps: report.steps, versions: report.versions }
    } finally {
      own.stop()
    }
  },

  /** The scenario, every device in a worker of its own, with IndexedDB as the store. */
  async scenario() {
    const run = `scenario-${Date.now()}`
    const scenario = await (await fetch('/tests/bindings/scenario.json')).json()
    const ran = await runScenario(scenario, { core, device: (name, how) => deviceInWorker(run, name, how) })
    return { ok: ran === scenario.steps.length, ran }
  },

  /** A worker is killed between a write and its sending: the next one finds the same request in the outbox. And a
   *  second worker cannot open a state the first holds. */
  async kill() {
    const run = `kill-${Date.now()}`
    const first = await deviceInWorker(run, 'A', 'create')
    await first.call('foundRoom', core.generateRecoveryCode(), Date.now())
    const before = await first.call('outbox')
    let second = null
    try { await deviceInWorker(run, 'A', 'open') } catch (error) { second = error.code }
    first.kill()
    // The lock of a worker that was stopped is released by the browser; the next owner waits for it.
    const again = await deviceInWorker(run, 'A', 'open', true)
    const after = await again.call('outbox')
    await again.close()
    const sameBytes = (a, b) => a.length === b.length && a.every((byte, at) => byte === b[at])
    const same = before.length === 1 && after.length === 1 && after[0].id === before[0].id
      && after[0].parts.every((part, at) => sameBytes(part, before[0].parts[at]))
    return { ok: same && second === 'storage', same, second }
  },

  /** Times of the heavy calls, for the size and speed report. */
  async times() {
    const time = work => { const start = performance.now(); work(); return Math.round((performance.now() - start) * 10) / 10 }
    const megabyte = new Uint8Array(1 << 20)
    let end, stored
    const encrypt = time(() => { const encryptor = new core.FileEncryptor(); stored = [encryptor.update(megabyte)]; end = encryptor.finish(); stored.push(end.stored) })
    const decrypt = time(() => { const decryptor = new core.FileDecryptor(end.file); for (const piece of stored) decryptor.update(piece); decryptor.finish() })
    return { ok: true, encryptMiB: encrypt, decryptMiB: decrypt }
  },
}

globalThis.run = async what => {
  // The .wasm is fetched here so that its type and the time to load it are seen.
  const start = performance.now()
  const response = await fetch('/core/wasm/pkg/trommi_core_wasm_bg.wasm')
  const contentType = response.headers.get('content-type')
  await core.init(response)
  const load = Math.round((performance.now() - start) * 10) / 10
  const result = await cases[what]()
  return { ...result, contentType, load, violations: [...violations] }
}
// So that a test can clean up what it stored.
globalThis.destroy = name => IdbStore.destroy(name)
