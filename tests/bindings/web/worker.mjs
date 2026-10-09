// One device in a module worker, as the web app's core runs: the page asks, the worker calls the binding. The store
// is IndexedDB (idb-store.js) behind the switch that makes a write fail. Also answers `selfTest`, and reports the
// violations of the Content-Security-Policy seen here: the page does not see a worker's.
import * as core from '/core/wasm/pkg/trommi-core.js'
import { IdbStore } from '/core/wasm/pkg/idb-store.js'
import { FailingStore } from '/tests/bindings/stores.mjs'

const violations = []
addEventListener('securitypolicyviolation', event => violations.push(`${event.violatedDirective} ${event.blockedURI}`))

let device = null
let store = null
const asks = {
  async start({ name, how, wait }) {
    await core.init()
    store = new FailingStore(new IdbStore(name, { wait }))
    device = await core.Device[how](store)
  },
  call: ({ method, args }) => device[method](...args),
  close: () => device.close(),
  failNextWrite: () => store.failNextWrite(),
  async selfTest() {
    await core.init()
    return core.selfTest(Date.now())
  },
  violations: () => violations,
}

onmessage = async ({ data: { id, ask, ...rest } }) => {
  try {
    postMessage({ id, result: await asks[ask](rest) })
  } catch (error) {
    postMessage({ id, error: { code: error.code ?? null, message: `${error.name}: ${error.message}` } })
  }
}
