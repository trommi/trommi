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
const check = (holds, what) => { if (!holds) throw new Error(what) }
/** The code a call is refused with, or null when it is not. */
const refusal = async work => { try { await work() } catch (error) { return error instanceof core.TrommiError ? error.code : `not a TrommiError: ${error}` } return null }

check(await refusal(() => core.versions()) === 'internal', 'a call before init() was not refused')
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

// ---- what holds at this binding's own edge -----------------------------------------------------------------------

// Arguments of another type or range than a call takes are refused, and nothing is rounded.
check(await refusal(() => core.fileLayout(1.5)) === 'bad-format', 'a fraction was taken as a count')
check(await refusal(() => core.fileLayout(2 ** 53)) === 'bad-format', 'a number above 2^53 - 1 was taken')
check(await refusal(() => core.fileLayout(-1)) === 'bad-format', 'a negative number was taken')
check(await refusal(() => core.fileLayout('21')) === 'bad-format', 'text was taken as a number')
check(await refusal(() => core.base64urlEncode([1, 2, 3])) === 'bad-format', 'an array was taken as bytes')
check(await refusal(() => core.keyPackageInfo(new Uint8Array(5))) === 'bad-key-package', 'five bytes were taken as a KeyPackage')
check(core.errorCodeFromText('no-such-code') === null && core.errorCodeFromText('gap') === 'gap', 'the codes are not read as they are spelled')
check(Object.getPrototypeOf(core.versions()) === null, 'a record has a prototype')

// A device's calls run in the order they were made, and none resolves before its write is stored.
{
  let stored = 0
  const slow = new MemoryStore('order')
  const store = { load: () => slow.load(), close: () => slow.close(), apply: async write => { await new Promise(resolve => setTimeout(resolve, 5)); await slow.apply(write); stored++ } }
  const device = await core.Device.create(store)
  check(stored === 1, 'create() resolved before the new key was stored')
  const order = []
  const calls = [
    device.keyPackage(Date.now()).then(() => order.push(['keyPackage', stored])),
    device.id().then(() => order.push(['id', stored])),
    device.keyPackage(Date.now()).then(() => order.push(['keyPackage', stored])),
  ]
  await Promise.all(calls)
  check(JSON.stringify(order) === JSON.stringify([['keyPackage', 2], ['id', 2], ['keyPackage', 3]]), `the calls did not run in order, each after its write: ${JSON.stringify(order)}`)
  check(await refusal(() => device.outboxRefused(1, 'no-such-code')) === 'bad-format', 'an unknown code was taken as a refusal')
  check(await refusal(() => device.outboxAccepted(1n)) === 'bad-format', 'a bigint was taken as a number')
  check(await refusal(() => new core.Device()) !== null, 'a device was constructed without a store')
  await device.close()
  check(await refusal(() => device.id()) === 'internal', 'a closed device answered')
}

// A write that fails closes the device, withholds the result, and releases the store; the stored state opens again.
{
  const store = new FailingStore(new MemoryStore('failing'))
  const device = await core.Device.create(store)
  store.failNextWrite()
  check(await refusal(() => device.keyPackage(Date.now())) === 'storage', 'a result came back though its write failed')
  check(await refusal(() => device.id()) === 'storage', 'the device went on after a failed write')
  const again = await core.Device.open(new MemoryStore('failing'))
  check((await again.outbox()).length === 0, 'the failed write left something behind')
  check(await refusal(() => core.Device.open(new MemoryStore('failing'))) === 'storage', 'a second owner opened the state')
  await again.close()
  check(await refusal(() => core.Device.create(new MemoryStore('failing'))) === 'storage', 'a device was created over a stored one')
}
console.log('edge: passed')
