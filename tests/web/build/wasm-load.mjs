// wasm-load.mjs: the Rust core loads in the browser the way the build ships it, under the app's own
// Content-Security-Policy, and only that way.
//   node tests/web/build/wasm-load.mjs
// Builds the app into a temporary folder, serves it with the built _headers (static.mjs), and in headless Chromium
// starts a module worker that loads core-wasm.ts (probe-worker.mjs; the app's own worker does not load the core yet).
// It checks:
//   1. as built: the binding's own self test passes there (selfTest(Date.now()): every step ok), versions() answers,
//      a call the binding lacks throws `core-missing`, a refusal of the binding keeps its code, and neither the page
//      nor the worker saw a policy violation;
//   2. with 'wasm-unsafe-eval' taken out of the policy the same load is refused, as a compile error that names the
//      policy: the keyword is necessary, and (1) shows it is enough;
//   3. a .wasm that is not the build's is refused before anything is compiled (fetch's integrity). The tampered file
//      is the real one with an empty custom section appended: still a valid module, so only its hash can refuse it;
//   4. the dev server (app/web/dev/serve.mjs, unbundled) serves the binding's scripts and the .wasm, the .wasm as
//      application/wasm, and core-wasm.ts loads them there too and passes the self test.
// Chromium is `chromium` on the PATH or the program CHROMIUM names. Without it, or without the core's WASM output and
// the tools to make it, the test fails and says which.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { launchChromium } from '../../../app/web/dev/cdp.mjs'
import { REPO, tempDir, writeBuilt, writeProbe } from './built.mjs'
import { appPolicy, serveStatic } from './static.mjs'

const failures = []
let checks = 0
const check = (ok, what, seen) => { checks++; if (!ok) failures.push(`${what}${seen === undefined ? '' : `\n    seen: ${JSON.stringify(seen)}`}`) }

/** In a new browser process: open `address` (a document under the app's headers) and evaluate `script` there. */
async function inBrowser(origin, address, script) {
  let browser
  try { browser = await launchChromium({ width: 800, height: 600 }) } catch (err) { console.error(`wasm-load: ${err.message} (Chromium: \`chromium\` on the PATH, or CHROMIUM=<program>)`); process.exit(1) }
  try {
    const page = await browser.page()
    await page.send('Page.enable')
    const loaded = new Promise(resolve => { const off = page.on('Page.loadEventFired', () => { off(); resolve() }) })
    await page.send('Page.navigate', { url: origin + address })
    await loaded
    const res = await page.send('Runtime.evaluate', { expression: `(${script})()`, awaitPromise: true, returnByValue: true })
    if (res.exceptionDetails) return { error: res.exceptionDetails.exception?.description?.split('\n')[0] ?? res.exceptionDetails.text }
    return res.result.value
  } finally {
    await browser.close()
  }
}
/** Runs in the page: start the probe worker, give back its report (the message after `loaded`) and the page's own policy violations. */
const startProbe = `async () => {
  const pageViolations = []
  addEventListener('securitypolicyviolation', e => pageViolations.push(e.violatedDirective + ' ' + e.blockedURI))
  const worker = new Worker('/test/probe-worker.mjs', { type: 'module' })
  const said = await new Promise(resolve => { worker.onmessage = e => { if (!e.data.loaded) resolve(e.data) }; worker.onerror = e => resolve({ error: 'the worker did not start: ' + (e.message || 'no message'), violations: [] }) })
  return { ...said, pageViolations }
}`
const BLANK = { '/__probe': '<!doctype html><meta charset="utf-8"><title>probe</title>' }

const tmp = tempDir('wasm-load')
let dev = null
try {
  const dist = path.join(tmp, 'dist')
  try { await writeBuilt(dist); await writeProbe(dist) } catch (err) { console.error(`wasm-load: the build failed\n${err.message}`); process.exit(1) }
  const policy = appPolicy(dist)
  if (!/script-src [^;]*'wasm-unsafe-eval'/.test(policy)) { console.error(`wasm-load: the built policy has no 'wasm-unsafe-eval' in script-src:\n${policy}`); process.exit(1) }
  const pins = JSON.parse(fs.readFileSync(path.join(dist, 'gen/manifest.json'), 'utf8')).toolchain
  const run = async options => { const server = await serveStatic(dist, { pages: BLANK, ...options }); try { return await inBrowser(server.origin, '/__probe', startProbe) } finally { await server.close() } }

  // 1. as built
  const built = await run({})
  const steps = built.selfTest?.steps ?? []
  check(built.selfTest?.ok === true && steps.length > 0 && steps.every(step => step.ok), "the binding's self test passes in the worker", built.selfTest ?? built)
  check(typeof built.versions?.core === 'string' && built.versions.core.length > 0 && built.versions.binding?.includes(pins['wasm-bindgen']), 'versions() answers and names the pinned wasm-bindgen', built.versions)
  check(built.missing?.code === 'core-missing' && /hubAddress/.test(built.missing.message), 'a call the binding lacks throws core-missing and names itself', built.missing)
  check(typeof built.refusal === 'string' && built.refusal !== 'core-missing' && built.refusal !== 'internal', "a refusal of the binding keeps its code through errorCode()", built.refusal)
  check(built.violations?.length === 0 && built.pageViolations?.length === 0, 'no policy violation in the worker or the page', built)

  // 2. without 'wasm-unsafe-eval': refused by the policy
  const without = await run({ policy: csp => csp.replace(" 'wasm-unsafe-eval'", '') })
  check(!without.versions && /CompileError/.test(without.error ?? '') && /Content Security Policy/i.test(without.error ?? ''), "without 'wasm-unsafe-eval' WebAssembly is refused by the policy", without)

  // 3. a tampered .wasm: refused by its hash
  const EMPTY_SECTION = Buffer.from([0, 1, 0])   // a custom section with an empty name
  const real = fs.readFileSync(path.join(dist, fs.readdirSync(path.join(dist, 'gen/app')).map(f => `gen/app/${f}`).find(f => f.endsWith('.wasm'))))
  check(WebAssembly.validate(Buffer.concat([real, EMPTY_SECTION])), 'the tampered .wasm of this test is still a valid module')
  let handedOut = 0
  const tampered = await run({ body: (address, bytes) => (address.endsWith('.wasm') ? (handedOut++, Buffer.concat([bytes, EMPTY_SECTION])) : bytes) })
  check(handedOut > 0, 'the tampered .wasm was asked for')
  check(!tampered.versions && /^TypeError/.test(tampered.error ?? '') && tampered.violations?.length === 0, 'a tampered .wasm is refused by fetch (integrity), not compiled', tampered)

  // 4. the dev server
  const port = await new Promise(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })
  dev = spawn(process.execPath, [path.join(REPO, 'app/web/dev/serve.mjs'), String(port)], { cwd: REPO, stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise((resolve, reject) => { dev.stdout.on('data', d => { if (String(d).includes(`:${port}`)) resolve() }); dev.on('exit', code => reject(new Error(`the dev server ended (${code})`))) })
  const inDev = await inBrowser(`http://127.0.0.1:${port}`, '/robots.txt', `async () => {
    const violations = []
    addEventListener('securitypolicyviolation', e => violations.push(e.violatedDirective + ' ' + e.blockedURI))
    const wasm = await fetch('/gen/vendor/trommi_core_wasm_bg.wasm')
    const core = await (await import('/gen/vendor/core-wasm.mjs')).loadCore()
    return { versions: core.versions(), ok: core.selfTest(Date.now()).ok, type: wasm.headers.get('content-type'), violations }
  }`)
  check(inDev.ok === true && inDev.versions?.core === built.versions?.core && inDev.violations?.length === 0, 'the dev server: core-wasm.ts loads the core and its self test passes, no violation', inDev)
  check(inDev.type === 'application/wasm', 'the dev server sends the .wasm as application/wasm', inDev.type)

  if (failures.length) { console.error(`wasm-load: FAILED\n${failures.map(f => `  not true: ${f}`).join('\n')}`); process.exitCode = 1 }
  else console.log(`wasm-load: ok, ${checks} checks (self test: ${steps.length} steps in ${(built.selfTest.micros / 1000).toFixed(0)} ms; ${JSON.stringify(built.versions)})\n  refused without 'wasm-unsafe-eval': ${without.error}\n  refused when tampered: ${tampered.error}`)
} finally {
  dev?.kill()
  fs.rmSync(tmp, { recursive: true, force: true })
}
