// One call into the core in a browser, from a plain ES module, in the page or in a worker. Returns what was
// measured; throws when the module does not load or answers something else.
import init, { coreVersion } from '/pkg/trommi_core_wasm.js'

/** Fetch, compile and instantiate apart, so that each is timed and the response's type is seen. */
async function load() {
  const url = '/pkg/trommi_core_wasm_bg.wasm'
  const t0 = performance.now()
  const response = await fetch(url)
  const type = response.headers.get('content-type')
  const bytes = await response.arrayBuffer()
  const t1 = performance.now()
  const module = await WebAssembly.compile(bytes)
  const t2 = performance.now()
  await init({ module_or_path: module })
  const t3 = performance.now()
  return { type, fetch: t1 - t0, compile: t2 - t1, instance: t3 - t2 }
}

export async function roundTrip() {
  const loaded = await load()
  const version = coreVersion()
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`the core answered ${JSON.stringify(version)}`)
  const r = x => Math.round(x * 10) / 10
  return { ok: true, version, contentType: loaded.type, fetch: r(loaded.fetch), compile: r(loaded.compile), instance: r(loaded.instance) }
}
