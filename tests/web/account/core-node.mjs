// core-node.mjs: stands where app/web/core/core-wasm.ts stands in the app, for the account's tests in Node. TEST ONLY.
// core-wasm.ts fetches the .wasm from the address the build wrote into it, which Node has none of; this module loads
// the SAME binding (core/wasm/pkg, built by core/wasm/build.sh) from the disk and hands it out as core-wasm.ts does:
// the functions without state as they are, and `errorCode`. Nothing of the core is replaced: every key, sealed copy,
// word, code and account id in these tests is the real core's. (A `Device` is not handed out here; room-fake.mjs
// makes its own where a test runs against the real hub.)
import { readFile } from 'node:fs/promises'
import * as binding from '../../../core/wasm/pkg/trommi-core.js'

const { init, Device: _Device, TrommiError, StoreConflict: _StoreConflict, ...stateless } = binding
let loading = null
export function loadCore() {
  loading ??= readFile(new URL('../../../core/wasm/pkg/trommi_core_wasm_bg.wasm', import.meta.url)).then(init).then(() => ({
    ...stateless,
    errorCode: error => (error instanceof TrommiError ? error.code : error?.code === 'core-missing' ? 'core-missing' : null),
  }))
  return loading
}
export { binding }
