// The shell's build (README.md beside this file): node app/shell/build.mjs OUT_DIR
// Writes into OUT_DIR what the worker serves:
//   index.html, shell.css               the page (no inline script or style: the app's CSP stays as it is)
//   gen/app/shell-<hash>.mjs            the page's script
//   gen/app/proof-worker-<hash>.mjs     the app's own proof worker (app/web/core/proof-worker.ts), bundled with the
//                                       binding's scripts
//   gen/app/trommi-core-<hash>.wasm     the Rust core, fetched by the worker with its SHA-256
//   gen/build.txt                       the commit this was built from (the deploy reads it back from the live site)
//   sw.js                               removes an earlier app's service worker and caches
//   _headers, robots.txt, icons/, apple-app-site-association.json   the app's own files, unchanged
// Needs core/wasm/pkg/ (core/wasm/build.sh) and the repository's npm packages (esbuild).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..', '..')
const WEB = path.join(REPO, 'app', 'web')
const PKG = path.join(REPO, 'core', 'wasm', 'pkg')
const out = process.argv[2]
if (!out) { console.error('usage: node app/shell/build.mjs OUT_DIR'); process.exit(2) }
const short = data => crypto.createHash('sha256').update(data).digest('hex').slice(0, 12)
const put = (name, data) => { const file = path.join(out, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data) }

function commit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA
  try { return execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch { return 'dev' }
}

if (!fs.existsSync(path.join(PKG, 'trommi_core_wasm_bg.wasm'))) { console.error('shell: core/wasm/pkg/ is missing: run sh core/wasm/build.sh first'); process.exit(1) }
fs.rmSync(out, { recursive: true, force: true })

// the core's .wasm, named by its content
const wasm = fs.readFileSync(path.join(PKG, 'trommi_core_wasm_bg.wasm'))
const wasmPath = `gen/app/trommi-core-${short(wasm)}.wasm`
put(wasmPath, wasm)

// The app's sources import the binding by its source address (core/wasm/js/…); the built copies are in pkg/.
const fromPkg = { name: 'from-pkg', setup(b) { b.onResolve({ filter: /core\/wasm\/js\/[\w-]+\.js$/ }, a => ({ path: path.join(PKG, path.basename(a.path)) })) } }
const bundle = async (entry, define) => {
  const r = await esbuild.build({ entryPoints: [entry], bundle: true, format: 'esm', minify: true, write: false, target: ['es2022'], logLevel: 'warning', plugins: [fromPkg], define })
  return r.outputFiles[0].contents
}
const worker = await bundle(path.join(WEB, 'core', 'proof-worker.ts'), {
  __TROMMI_CORE_WASM__: JSON.stringify(`/${wasmPath}`),
  __TROMMI_CORE_WASM_SHA256__: JSON.stringify(crypto.createHash('sha256').update(wasm).digest('base64')),
})
const workerPath = `gen/app/proof-worker-${short(worker)}.mjs`
put(workerPath, worker)
const page = await bundle(path.join(HERE, 'shell.mjs'), { __SHELL_WORKER__: JSON.stringify(`/${workerPath}`) })
const pagePath = `gen/app/shell-${short(page)}.mjs`
put(pagePath, page)

const built = commit()
put('gen/build.txt', `commit: ${built.slice(0, 7)}\nfull: ${built}\nentry: shell\n`)
put('index.html', fs.readFileSync(path.join(HERE, 'index.html'), 'utf8').replace('__SHELL_SCRIPT__', `/${pagePath}`).replace('__BUILD__', built.slice(0, 7)))
put('shell.css', fs.readFileSync(path.join(HERE, 'shell.css')))
put('sw.js', fs.readFileSync(path.join(HERE, 'sw.js')))
for (const name of ['_headers', 'robots.txt', 'apple-app-site-association.json']) put(name, fs.readFileSync(path.join(WEB, 'public', name)))
fs.cpSync(path.join(WEB, 'public', 'icons'), path.join(out, 'icons'), { recursive: true })
console.log(`shell: built ${built.slice(0, 7)} into ${out}: ${pagePath}, ${workerPath}, ${wasmPath} (${wasm.length} bytes)`)
