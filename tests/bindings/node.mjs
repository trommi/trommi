// The scenario of tests/bindings/scenario.json through the browser binding, in Node: the same module and .wasm a
// browser loads, with a store in memory. Quick, and no browser needed; tests/bindings/browser.mjs runs the same in
// Chromium with IndexedDB and workers.
//   core/wasm/build.sh && node tests/bindings/node.mjs      (TROMMI_STAND_IN_RECOVERY=1 for the build, for now)
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as core from '../../core/wasm/pkg/trommi-core.js'
import { runScenario } from './scenario.mjs'
import { FailingStore, MemoryStore } from './stores.mjs'

const here = path => fileURLToPath(new URL(path, import.meta.url))
await core.init(fs.readFileSync(here('../../core/wasm/pkg/trommi_core_wasm_bg.wasm')))

const report = core.selfTest(Date.now())
for (const step of report.steps) if (!step.ok) throw new Error(`self-test: ${step.name}: ${step.detail}`)
console.log(`self-test: ${report.steps.length} steps in ${(report.micros / 1000).toFixed(1)} ms; ${JSON.stringify(report.versions)}`)

const world = {
  core,
  async device(name, how) {
    const store = new FailingStore(new MemoryStore(name))
    const device = await core.Device[how](store)
    return {
      call: (method, ...args) => device[method](...args),
      close: () => device.close(),
      failNextWrite: () => store.failNextWrite(),
    }
  },
}
const scenario = JSON.parse(fs.readFileSync(here('scenario.json'), 'utf8'))
const ran = await runScenario(scenario, world)
console.log(`scenario: ${ran} steps`)
