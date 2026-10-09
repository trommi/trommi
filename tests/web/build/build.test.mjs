// build.test.mjs: the Rust core in the web app's build (app/web/dev/build.mjs "the Rust core").
//   node tests/web/build/build.test.mjs
// Builds the app twice, each in a process of its own, into two temporary folders, and checks:
//   - the .wasm is a file of its own under gen/app/, named by its content, byte for byte what core/wasm/build.sh
//     wrote; no script of the binding is served beside it (they are inside the worker);
//   - a worker bundled with the build's constants names the hashed .wasm and its SHA-256 and holds the binding's
//     scripts; so does the app's own worker once it loads the core (until then that one check is SKIPPED, and said so);
//   - the service worker's shell and the manifest hold the .wasm; the manifest names Rust and wasm-bindgen beside
//     Node and esbuild, and the core as it names itself;
//   - the two builds are identical, file for file.
// Not checked here: that two machines compile the same .wasm (both builds take the .wasm that lies in core/wasm/pkg/).
// Needs the binding's output or the tools to make it (the build says which is absent).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { REPO, tempDir, writeProbe } from './built.mjs'

const hash = (data, algo = 'sha256', enc = 'hex') => crypto.createHash(algo).update(data).digest(enc)
const walk = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name))])).sort()
const failures = []
let checks = 0
const check = (ok, what) => { checks++; if (!ok) failures.push(what) }

const tmp = tempDir('build-test')
try {
  const [a, b] = ['a', 'b'].map(n => path.join(tmp, n))
  for (const dir of [a, b]) {
    try { execFileSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'built.mjs'), dir], { cwd: REPO, stdio: ['ignore', 'inherit', 'pipe'], encoding: 'utf8' }) }
    catch (err) { console.error(`build.test: the build failed\n${err.stderr ?? err.message}`); process.exit(1) }
  }
  const read = f => fs.readFileSync(path.join(a, f))
  const app = fs.readdirSync(path.join(a, 'gen/app'))

  const wasms = app.filter(f => /^trommi-core-[0-9a-f]{12}\.wasm$/.test(f))
  check(wasms.length === 1 && app.filter(f => f.endsWith('.wasm')).length === 1, `gen/app/ holds one .wasm, with a hashed name (found: ${app.filter(f => f.endsWith('.wasm')).join(', ') || 'none'})`)
  if (wasms.length !== 1) throw new Error('nothing more can be checked without the .wasm')
  const wasm = `gen/app/${wasms[0]}`
  const pkg = f => fs.readFileSync(path.join(REPO, 'core/wasm/pkg', f))
  check(wasm.includes(hash(read(wasm)).slice(0, 12)), 'the .wasm is named by its content')
  check(read(wasm).equals(pkg('trommi_core_wasm_bg.wasm')), "the served .wasm equals the binding's output (core/wasm/pkg/trommi_core_wasm_bg.wasm)")
  check(hash(read(wasm)) === JSON.parse(pkg('build.json'))['trommi_core_wasm_bg.wasm'].sha256, "its SHA-256 is the one core/wasm/build.sh wrote down (pkg/build.json)")
  check(WebAssembly.validate(read(wasm)), 'the served .wasm is a valid module (written as bytes, not as text)')
  check(!walk(a).some(f => /trommi_core_wasm|idb-store|trommi-core\.m?js/.test(f)), "no script of the binding is served as a file of its own")

  const probe = fs.readFileSync(path.join(a, (await writeProbe(a)).slice(1)), 'utf8')
  const names = text => text.includes(`"/${wasm}"`) && text.includes(`sha256-`) && text.includes(hash(read(wasm), 'sha256', 'base64'))
  check(names(probe), "a worker bundled with the build's constants names the hashed .wasm and its SHA-256 for fetch's integrity")
  check(probe.includes('__wbg_') && !/\bfrom\s*["'][^"']*trommi/.test(probe), "the binding's scripts are inside it, none imported")
  const workers = app.filter(f => /^core-worker-[^-]+\.mjs$/.test(f))
  check(workers.length === 1, `gen/app/ holds one core worker (found: ${workers.join(', ') || 'none'})`)
  const worker = workers.length === 1 ? read(`gen/app/${workers[0]}`).toString() : ''
  let skipped = null
  if (worker.includes('core-missing')) check(names(worker) && worker.includes('__wbg_'), "the app's worker names the hashed .wasm and its SHA-256 and holds the binding's scripts")
  else skipped = "SKIPPED: the app's own worker names the hashed .wasm: app/web/core/core-worker.ts does not load core-wasm.ts yet"

  const manifest = JSON.parse(read('gen/manifest.json'))
  const pin = (file, re) => re.exec(fs.readFileSync(path.join(REPO, file), 'utf8'))?.[1]
  check(manifest.toolchain.rust === pin('rust-toolchain.toml', /^channel = "([^"]+)"$/m), `the manifest names the pinned Rust (it says ${manifest.toolchain.rust})`)
  check(manifest.toolchain['wasm-bindgen'] === pin('core/wasm/Cargo.toml', /^wasm-bindgen = "=([^"]+)"$/m), `the manifest names the pinned wasm-bindgen (it says ${manifest.toolchain['wasm-bindgen']})`)
  check(manifest.toolchain.node && manifest.toolchain.esbuild, 'the manifest still names Node and esbuild')
  check(manifest.files[wasm] === hash(read(wasm)), `the manifest lists ${wasm} with its SHA-256`)
  check(['core', 'openmls', 'provider', 'binding'].every(k => typeof manifest.core?.[k] === 'string' && manifest.core[k]), 'the manifest names the core as it names itself (versions())', manifest.core)
  const shell = JSON.parse(/^const SHELL = (.*)$/m.exec(read('sw.js').toString())[1])
  check(shell.includes(`/${wasm}`), `the service worker's shell holds /${wasm}`)

  const [fa, fb] = [walk(a).filter(f => !f.startsWith('test/')), walk(b)]
  check(fa.join('\n') === fb.join('\n'), 'two builds make the same files')
  const differ = fa.filter(f => fb.includes(f) && !fs.readFileSync(path.join(a, f)).equals(fs.readFileSync(path.join(b, f))))
  check(differ.length === 0, `two builds are byte-identical (differ: ${differ.join(', ')})`)

  if (skipped) console.log(skipped)
  if (failures.length) { console.error(`build.test: FAILED\n${failures.map(f => `  not true: ${f}`).join('\n')}`); process.exitCode = 1 }
  else console.log(`build.test: ok, ${checks} checks${skipped ? ', 1 skipped' : ''} (${fa.length} files per build; ${wasm}, ${read(wasm).length} bytes)`)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
