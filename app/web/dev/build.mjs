// The app's build: everything generated is made here, at deploy time, and never committed.
//   gen/app/               the app as one minified bundle (esbuild, split): app-<hash>.mjs (app, ui, desk, sidebar,
//                          notes), one chunk per lazy view, the core (../core/) in chunks of its own, the proof
//                          worker (proof-worker-<hash>.mjs, for the "MLS proof" screen), all named by
//                          their content; and the Rust core's trommi-core-<hash>.wasm beside them ("the Rust core"
//                          below; its scripts are in the worker's bundle)
//   gen/vendor/            tools-reference.mjs: the connector's tools and events as data, for the help page (the dev
//                          server, bundle: false, also serves the core here, copied flat from core/,
//                          with the Rust core's scripts and its trommi_core_wasm_bg.wasm)
//   gen/bundle.<hash>.css  the stylesheets of index.html as one file (their <link>s become one)
//   gen/build.txt          which commit this build is, and the build hash (dev/verify.mjs reads it)
//   gen/manifest.json      every file this build serves with its SHA-256, and the toolchain that made it
//   demo/fixture.json, demo/files/   the demo room's data, from the repository's demo/data/ (demo/README.md): the room
//                          without its spaces, its files (if it has any) as they are; the states of /screens go into
//                          the bundle (gen/vendor/demo-screens.mjs). Checked first (demo/check.mjs): a broken demo
//                          fails the build
//   index.html             the script, the modulepreload list between <!-- preload --> and <!-- /preload -->, data-build=<version>
//   sw.js                  VERSION (a hash of every shell file) and SHELL (every file the app serves)
// In the repository index.html and sw.js are templates (empty preload block, VERSION "dev", SHELL []), so two
// branches never conflict there, and public/gen/, public/demo/fixture.json and public/demo/files/ are not in git at all.
//
// The bundle needs the repository's npm packages (esbuild). Cloudflare's build (WORKERS_CI=1) installs them first: npm
// ci in app/web/ (its package.json). The dev server without --bundle needs none. The connector (a binary) is not built here:
// it is a signed GitHub release of its own (install.sh at the repository root installs it). The build reads two of the
// connector's files, connector/tools.json and connector/prompt.md, for the help page's list of tools.
// The Rust core is not compiled here either, as long as its output is there and current: the build takes
// core/wasm/pkg/ (core/wasm/build.sh writes it, never committed) and runs that script only when the output is missing
// or older than the core's sources. Then it needs Rust (rust-toolchain.toml) and the pinned wasm-bindgen.
//
//   node dev/build.mjs            check only: generate in memory, print what it would write and the cold start's size
//   node dev/build.mjs --write    write it into public/ (Cloudflare's build: WORKERS_CI=1 counts as --write).
//                                 Never commit what it writes into index.html and sw.js.
// dev/serve.mjs serves generate() from memory, so the dev server needs no build step and never shows stale files.
// A missing core fails the build (Cloudflare then keeps the last deployment) instead of shipping an app without it.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { toJs, renameTs } from './ts.mjs'
import { readDemo, dataDir } from '../../../demo/check.mjs'

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
/** esbuild, from app/web/node_modules (npm ci in app/web): also for the tests outside app/web, where Node would not find it. */
export const loadEsbuild = () => import('esbuild').catch(() => { throw new Error('esbuild is missing (npm ci in app/web)') })
const sha = data => crypto.createHash('sha256').update(data).digest('hex').slice(0, 12)

// ---- the toolchain ----
// The build is reproducible (README "Verifying the build"): the same commit gives the same bytes, wherever it is built.
// That needs the same Node (type stripping) and the same esbuild: both pinned
// (.node-version, package.json engines and the exact esbuild of app/web/package-lock.json), and for the Rust core's .wasm the
// same Rust (rust-toolchain.toml) and the same wasm-bindgen (core/wasm/Cargo.toml; the command must be the crate's
// version). In Cloudflare's build a mismatch
// fails the build; anywhere else it is said, and the manifest names the toolchain, so verify.mjs can tell why it differs.
function toolchain(repo = REPO) {
  const node = fs.readFileSync(path.join(repo, '.node-version'), 'utf8').trim()
  const lock = JSON.parse(fs.readFileSync(path.join(repo, 'app/web/package-lock.json'), 'utf8'))
  const { rust, wasmBindgen } = corePins(repo)
  return { node, esbuild: lock.packages?.['node_modules/esbuild']?.version ?? null, rust, 'wasm-bindgen': wasmBindgen }
}
/** What made this build. Node and esbuild are the ones running. wasm-bindgen is read from the .wasm itself (it signs
 *  what it processed). Rust is the compiler this checkout selects (rustc in the repository: rustup follows
 *  rust-toolchain.toml), null when no rustc is installed and the .wasm was taken as it lay there: the .wasm does
 *  not name its compiler. */
async function checkToolchain(repo) {
  const want = toolchain(repo)
  const esbuild = await import('esbuild').then(m => m.version, () => null)
  const have = { node: process.versions.node, esbuild, rust: rustVersion(repo), 'wasm-bindgen': coreWasm(repo).madeBy }
  const off = Object.keys(want).filter(k => have[k] && want[k] && have[k] !== want[k])
  if (!off.length) return have
  const why = `build: not the pinned toolchain (${off.map(k => `${k} ${have[k]}, pinned ${want[k]}`).join('; ')}): its bytes will differ from the deployed build`
  if (process.env.WORKERS_CI === '1') throw new Error(why)
  if (!checkToolchain.said) { checkToolchain.said = true; console.warn(why) }
  return have
}

// ---- the Rust core (WASM) ----
// core/wasm/build.sh makes core/wasm/pkg/ (never committed): trommi_core_wasm_bg.wasm (the core),
// trommi_core_wasm.js (wasm-bindgen's glue), trommi-core.js (the binding's own layer over the glue: what an app
// imports) and idb-store.js (a device's store on IndexedDB). The app's core-wasm.ts is the only module that imports
// them (by their source address, core/wasm/js/…, where their types are; the build gives it pkg/'s copies).
//
// The three scripts are plain JavaScript and are treated like the app's own core: they go into gen/vendor/ beside it
// (trommi-core.mjs, trommi_core_wasm.mjs, idb-store.mjs) and so into the worker's bundle. ONLY the .wasm is a file of
// its own, served as bytes:
//   deployed (the bundle):  gen/app/trommi-core-<hash>.wasm, named by its content (immutable, like every file of
//                           gen/app/), in the service worker's shell and in the manifest
//   dev server:             gen/vendor/trommi_core_wasm_bg.wasm, under the name the glue itself would look for
// core-wasm.ts fetches it with `integrity` (the SHA-256 computed here) and hands the response to the binding's
// init(): its address and hash are the constants of coreFiles(), esbuild's `define` in the bundle and a line of
// constants on the dev server. Why the glue is bundled and not a second file beside the .wasm: a script a worker
// imports cannot be checked (no integrity for imports in a worker, and the page's import map does not reach there),
// a fetched .wasm can; so nothing of the core is loaded unchecked beyond the worker itself, and nothing finds its
// .wasm by import.meta.url (the glue's own default address is never used: init() always gets the response).
//
// The build does not compile Rust as long as pkg/ is there and not older than the core's sources (CORE_SOURCES);
// else it runs core/wasm/build.sh, with this process's environment (CARGO_TARGET_DIR).
const CORE_SOURCES = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'core/Cargo.toml', 'core/src', 'core/swift/Cargo.toml', 'core/swift/src', 'core/wasm/Cargo.toml', 'core/wasm/build.sh', 'core/wasm/src', 'core/wasm/js']
const CORE_WASM = 'trommi_core_wasm_bg.wasm'
const CORE_MODULES = ['trommi-core', 'trommi_core_wasm', 'idb-store']   // pkg/<name>.js, in gen/vendor/ as <name>.mjs
/** An import of the binding (…/core/wasm/js/<name>.js or …/pkg/<name>.js) as gen/vendor/ has it: './<name>.mjs'. */
const fromBinding = js => js.replace(/(['"])(?:\.\.\/)+core\/wasm\/(?:js|pkg)\/([\w-]+)\.js\1/g, '$1./$2.mjs$1')
/** The pinned versions: Rust (rust-toolchain.toml) and wasm-bindgen (core/wasm/Cargo.toml). */
function corePins(repo) {
  const pin = (file, re) => re.exec(fs.readFileSync(path.join(repo, file), 'utf8'))?.[1] ?? (() => { throw new Error(`build: ${file} does not name the version (${re})`) })()
  return { rust: pin('rust-toolchain.toml', /^channel = "([^"]+)"$/m), wasmBindgen: pin('core/wasm/Cargo.toml', /^wasm-bindgen = "=([^"]+)"$/m) }
}
/** The environment Rust's commands run in: rustup's folder is on the PATH even when the caller's shell left it out. */
function rustEnv() {
  const bin = path.join(process.env.CARGO_HOME ?? path.join(os.homedir(), '.cargo'), 'bin')
  return { ...process.env, PATH: [process.env.PATH, bin].filter(Boolean).join(path.delimiter) }
}
const said = (cmd, args, repo) => { try { return execFileSync(cmd, args, { cwd: repo, env: rustEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null } }
const rustVersion = repo => /^rustc (\S+)/.exec(said('rustc', ['--version'], repo) ?? '')?.[1] ?? null
function newest(file) {
  const stat = fs.statSync(file)
  return stat.isDirectory() ? Math.max(0, ...fs.readdirSync(file).map(f => newest(path.join(file, f)))) : stat.mtimeMs
}
/** Runs core/wasm/build.sh. Says plainly what is absent before cargo is started for nothing. */
function buildCoreWasm(repo, why) {
  const { rust, wasmBindgen } = corePins(repo)
  const install = `Install Rust ${rust} (rustup; rust-toolchain.toml selects it and its wasm32 target) and wasm-bindgen ${wasmBindgen} (cargo install wasm-bindgen-cli --version ${wasmBindgen} --locked), or run core/wasm/build.sh where they are.`
  if (!said('cargo', ['--version'], repo)) throw new Error(`build: the Rust core's WASM output is ${why}, and cargo is not installed. ${install}`)
  const have = said('wasm-bindgen', ['--version'], repo)?.replace(/^wasm-bindgen /, '') ?? null
  if (have !== wasmBindgen) throw new Error(`build: the Rust core's WASM output is ${why}, and wasm-bindgen is ${have ?? 'not installed'} (pinned: ${wasmBindgen}). ${install}`)
  console.warn(`build: the Rust core's WASM output is ${why}: running core/wasm/build.sh`)
  try { execFileSync('sh', [path.join(repo, 'core/wasm/build.sh')], { cwd: repo, env: rustEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  catch (err) { throw new Error(`build: core/wasm/build.sh failed\n${String(err.stderr ?? err.message).trim().split('\n').slice(-30).join('\n')}`) }
}
/** What the binding in pkg/ says of itself (versions(): core, openmls, provider, binding, recovery), asked in a
 *  process of its own: it also shows that the scripts and the .wasm fit together. */
function coreVersions(repo, pkg) {
  const script = `import fs from 'node:fs'; import * as core from ${JSON.stringify(pathToFileURL(path.join(pkg, 'trommi-core.js')).href)}; await core.init(fs.readFileSync(${JSON.stringify(path.join(pkg, CORE_WASM))})); process.stdout.write(JSON.stringify(core.versions()))`
  try { return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) }
  catch (err) { throw new Error(`build: the binding in core/wasm/pkg/ does not load (run core/wasm/build.sh)\n${String(err.stderr ?? err.message).trim().split('\n').slice(-10).join('\n')}`) }
}
let coreMade = null
/** The binding's output, made first when it is missing or stale: { modules: { '<name>.mjs': text }, wasm (bytes),
 *  madeBy (the wasm-bindgen version the .wasm names), versions (the binding's own) }.
 *  Read again only when the files changed. */
export function coreWasm(repo = REPO) {
  const pkg = path.join(repo, 'core/wasm/pkg')
  const files = [CORE_WASM, ...CORE_MODULES.map(m => `${m}.js`)].map(f => path.join(pkg, f))
  const age = () => (files.every(f => fs.existsSync(f)) ? Math.min(...files.map(f => fs.statSync(f).mtimeMs)) : null)
  const read = () => {
    const made = age()
    if (made == null) throw new Error(`build: core/wasm/build.sh ran and left no ${files.map(f => path.basename(f)).join(', ')} in core/wasm/pkg/`)
    if (coreMade?.key !== `${repo}:${made}`) {
      const wasm = fs.readFileSync(files[0])
      // (./x.js inside pkg/ is ./x.mjs in gen/vendor/)
      const modules = Object.fromEntries(CORE_MODULES.map(m => [`${m}.mjs`, fs.readFileSync(path.join(pkg, `${m}.js`), 'utf8').replace(/(\bfrom\s*['"]\.\/[\w-]+)\.js(['"])/g, '$1.mjs$2')]))
      // (the "producers" section of the .wasm: processed-by wasm-bindgen <version>, each a length byte and the text)
      const named = /processed-by[\s\S]{0,40}?wasm-bindgen([\x01-\x20])/.exec(wasm.toString('latin1'))
      const madeBy = named ? wasm.toString('latin1', named.index + named[0].length, named.index + named[0].length + named[1].charCodeAt(0)) : null
      coreMade = { key: `${repo}:${made}`, modules, wasm, madeBy, versions: coreVersions(repo, pkg) }
    }
    return coreMade
  }
  const made = age()
  if (made == null || made < Math.max(...CORE_SOURCES.map(f => newest(path.join(repo, f))))) buildCoreWasm(repo, made == null ? 'missing (core/wasm/pkg/)' : "older than the core's sources")
  return read()
}
/** The .wasm as the build serves it under `dir` ('gen/app' named by its content, 'gen/vendor' under the binding's
 *  name) and the constants core-wasm.ts is compiled with: { files: { path: bytes }, wasm (its path), define }.
 *  Exported, with coreFromPkg, for the tests that bundle a worker of their own with the real core (tests/web/build/). */
export function coreFiles(repo = REPO, { dir = 'gen/app', hashed = true } = {}) {
  const core = coreWasm(repo)
  const wasm = hashed ? `${dir}/trommi-core-${sha(core.wasm)}.wasm` : `${dir}/${CORE_WASM}`
  const define = { __TROMMI_CORE_WASM__: `/${wasm}`, __TROMMI_CORE_WASM_SHA256__: crypto.createHash('sha256').update(core.wasm).digest('base64') }
  return { files: { [wasm]: core.wasm }, wasm, define: Object.fromEntries(Object.entries(define).map(([k, v]) => [k, JSON.stringify(v)])) }
}
/** For esbuild bundling straight from the repository's files (not from gen/vendor/): the binding's scripts are
 *  pkg/'s, wherever an import names them (core/wasm/js/ holds no glue). */
export const coreFromPkg = (repo = REPO) => ({ name: 'core-from-pkg', setup(b) { b.onResolve({ filter: /(^|\/)core\/wasm\/js\/[\w-]+\.js$/ }, a => ({ path: path.join(repo, 'core/wasm/pkg', path.basename(a.path)) })) } })

// ---- the core ----
const NOT_VENDORED = /\.d\.m?ts$/   // declarations
function vendorFiles(repo, { sourcemap = false } = {}) {
  const core = path.join(repo, 'app', 'web', 'core')
  if (!['index.mjs', 'index.ts'].some(f => fs.existsSync(path.join(core, f)))) throw new Error(`build: the core is missing (${core}/index.mjs)`)
  const out = {}
  // A TypeScript module (x.ts) lands as x.mjs, its types erased (dev/ts.mjs), its imports of './y.ts' as './y.mjs'.
  for (const f of fs.readdirSync(core).sort()) {
    if (!/\.(mjs|ts)$/.test(f) || NOT_VENDORED.test(f)) continue
    const name = f.replace(/\.ts$/, '.mjs')
    if (out[name] != null) throw new Error(`build: ${name} twice (.mjs and .ts)`)
    let text = fs.readFileSync(path.join(core, f), 'utf8')
    if (f.endsWith('.ts')) text = toJs(text, path.relative(repo, path.join(core, f)), { sourcemap })
    out[name] = fromBinding(renameTs(text, '.mjs'))
  }
  for (const [name, text] of Object.entries(coreWasm(repo).modules)) {
    if (out[name] != null) throw new Error(`build: ${name} twice (core/ and the Rust core's binding)`)
    out[name] = text
  }
  out['tools-reference.mjs'] = toolsReference(repo)
  out['demo-screens.mjs'] = `// Written by app/web/dev/build.mjs from demo/data/screens.json. Do not edit: edit that file.\nexport const STATES = ${JSON.stringify(demoData(repo).states)}\n`
  out['core-version.mjs'] = `// Written by app/web/dev/build.mjs from app/web/core/. Do not edit: edit the core.\nexport const CORE_COMMIT = ${JSON.stringify(commitOf(repo))}\n`
  return out
}
function commitOf(repo) {
  const env = process.env.WORKERS_CI_COMMIT_SHA || process.env.GITHUB_SHA
  if (env) return env.slice(0, 7)
  try { return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim().slice(0, 7) } catch { return 'dev' }
}

// ---- the connector's tools, for the help page ----
// The schemas, examples and events of connector/tools.json, each tool with its description from connector/prompt.md
// (the "## <name>" sections, as the connector reads them). Made again only when the two files changed.
/** prompt.md as { '# Heading' | '## tool': text }: a section's lines and paragraphs read as one paragraph. */
function parsePrompt(md) {
  const out = {}
  let at = null
  for (const line of String(md).split(/\r?\n/)) {
    const h = /^(##?) +(.+?)\s*$/.exec(line)
    if (h) { at = `${h[1]} ${h[2]}`; out[at] = '' } else if (at) out[at] += ` ${line}`
  }
  for (const k of Object.keys(out)) out[k] = out[k].replace(/\s+/g, ' ').trim()
  return out
}
let reference = null
function toolsReference(repo) {
  const files = [path.join(repo, 'connector/tools.json'), path.join(repo, 'connector/prompt.md')]
  const key = files.map(f => fs.statSync(f).mtimeMs).join()
  if (reference?.key !== key) {
    const t = JSON.parse(fs.readFileSync(files[0], 'utf8'))
    const described = parsePrompt(fs.readFileSync(files[1], 'utf8'))
    const TOOLS = t.tools.map(tool => ({ name: tool.name, description: described[`## ${tool.name}`] ?? '', ...tool }))
    const json = JSON.stringify({ TOOLS, TOOL_EXAMPLES: t.examples, EVENTS: t.events, RETENTION_DAYS: t.retention_days, MAX_ASSET: t.max_asset })
    reference = { key, text: `// Written by app/web/dev/build.mjs from connector/tools.json and connector/prompt.md. Do not edit.\nexport const { TOOLS, TOOL_EXAMPLES, EVENTS, RETENTION_DAYS, MAX_ASSET } = ${json}\n` }
  }
  return reference.text
}

// ---- the demo room's data ----
// demo/data/ of the repository (demo/README.md), checked: a missing file or a broken list throws, so the build fails
// (Cloudflare then keeps the last deployment) instead of shipping an app without its demo.
function demoData(repo) {
  const demo = readDemo(repo)
  if (demo.problems.length) throw new Error(`build: the demo data is not in order (node demo/check.mjs)\n${demo.problems.join('\n')}`)
  return demo
}
/** What the app serves of it: { 'demo/fixture.json': text, 'demo/files/<name>': bytes }. */
function demoFiles(repo) {
  const { fixture, files } = demoData(repo)
  return { 'demo/fixture.json': JSON.stringify(fixture), ...Object.fromEntries(files.map(f => [`demo/files/${f}`, fs.readFileSync(path.join(dataDir(repo), 'files', f))])) }
}
const CI = process.env.WORKERS_CI === '1'
if (CI) execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: path.join(REPO, 'app/web'), stdio: 'inherit' })

// ---- the stylesheets ----
const SHEET_LINK = /^<link rel="stylesheet" href="(\/[^"]+\.css)"[^>]*>\n/gm
/** Throws unless the braces of a sheet balance (outside comments and strings): in the bundle a stray brace would
 *  spill into the next sheet. */
function checkSheet(css, file) {
  let depth = 0
  for (let i = 0; i < css.length; i++) {
    const c = css[i]
    if (c === '/' && css[i + 1] === '*') { const end = css.indexOf('*/', i + 2); if (end < 0) throw new Error(`${file}: comment not closed`); i = end + 1 }
    else if (c === '"' || c === "'") { let j = i + 1; while (j < css.length && css[j] !== c && css[j] !== '\n') j += css[j] === '\\' ? 2 : 1; if (css[j] !== c) throw new Error(`${file}: string not closed (offset ${i})`); i = j }
    else if (c === '{') depth++
    else if (c === '}' && --depth < 0) throw new Error(`${file}: "}" without "{" (offset ${i})`)
  }
  if (depth) throw new Error(`${file}: ${depth} "{" not closed`)
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')
  // The bundle lives in /gen/: a relative url() would point somewhere else there.
  if (/url\(\s*(?!['"]?(?:[a-z]+:|\/|%23|#))/i.test(bare)) throw new Error(`${file}: relative url()`)
  if (/@import\b|@charset\b/.test(bare)) throw new Error(`${file}: @import/@charset cannot go into the bundle`)
}

// ---- the shell: every file the app serves (the service worker keeps them) ----
const NOT_SHELL = /^(gen\/|demo\/|sw\.js$|index\.html$|_headers$|robots\.txt$|connect\.sh$)|\.md$|(^|\/)\./
function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? walk(p, base) : [path.relative(base, p).split(path.sep).join('/')]
  })
}
/** The modules a cold start needs, following static imports from the entry (so one round trip fetches them all). */
function preloads(read, entries) {
  const seen = new Set(), queue = [...entries]
  while (queue.length) {
    const f = queue.shift()
    const src = seen.has(f) ? null : read(f)
    if (src == null) continue
    seen.add(f)
    for (const m of src.matchAll(/^\s*(?:import|export)\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/gm)) queue.push(m[1].startsWith('/') ? m[1] : path.posix.join(path.posix.dirname(f), m[1]))
  }
  return [...seen]
}

/** Every module address in a script made versioned: './ui.mjs' becomes './ui.mjs?v=<version>', in static imports and
 *  exports, bare imports and import('…') of a literal. A new index.html thus loads only modules of its own build: no
 *  cache (the browser's, a proxy's, the service worker's) can hand it yesterday's ui.mjs beside today's stylesheet. */
const versioned = (src, version) => String(src)
  .replace(/^(\s*(?:import|export)\s+(?:[^'"]*?from\s+)?)(['"])((?:\.{1,2}\/|\/)[^'"?]+\.mjs)\2/gm, (_, head, q, spec) => `${head}${q}${spec}?v=${version}${q}`)
  .replace(/\bimport\((['"])((?:\.{1,2}\/|\/)[^'"?]+\.mjs)\1\)/g, (_, q, spec) => `import(${q}${spec}?v=${version}${q})`)

// ---- the modules ----
// The deployed app is one bundle (esbuild: minified, split): gen/app/app-<hash>.mjs with the views a cold start needs
// (app, ui, desk, sidebar, notes), and one chunk per lazy view and for the core (app.mjs imports them with import()),
// all named by their content. The core comes from the in-memory gen/vendor/ (the plugin below), never from disk.
// The dev server serves the sources as they are instead (bundle: false): unminified, one file per module.
const BUNDLED = /^(app|auth|agents|desk|card|session|sidebar|notes|media|whiteboard|proof)\.mjs$|^demo\/demo\.mjs$/   // in the bundle, not served alone
async function bundle(pub, vendor, core) {
  const esbuild = await loadEsbuild()
  const fromVendor = {
    name: 'vendor',
    setup(b) {
      // (named core/<file>, so the core's chunk is called core-<hash>.mjs, not after its index.mjs)
      const at = f => ({ path: f === 'index.mjs' ? 'core.mjs' : f, namespace: 'vendor' })
      b.onResolve({ filter: /(^|\/)gen\/vendor\/[\w.-]+\.mjs$/ }, a => at(a.path.split('/').pop()))
      b.onResolve({ filter: /^\.\/[\w.-]+\.mjs$/, namespace: 'vendor' }, a => at(a.path.slice(2)))
      b.onLoad({ filter: /.*/, namespace: 'vendor' }, a => { const f = a.path === 'core.mjs' ? 'index.mjs' : a.path; return f in vendor ? { contents: vendor[f], loader: 'js' } : { errors: [{ text: `gen/vendor/${f} is not in the core` }] } })
    },
  }
  const rel = o => path.relative(pub, path.resolve(REPO, o)).split(path.sep).join('/')   // (metafile paths are relative to absWorkingDir)
  // The Rust core's .wasm, a file of its own: whatever bundles core-wasm.ts (the worker; the page's copy of the core)
  // gets its address and its hash as constants ("the Rust core" above).
  const out = { ...core.files }
  // The core's worker (core/core-worker.ts): one file of its own, the whole core in it. The app learns its address
  // from __TROMMI_CORE_WORKER__ (without it, as on the dev server, it starts /gen/vendor/core-worker.mjs).
  // What only the account screens need (the key derivation, the word list, founding and joining) is a file of its own,
  // which the worker imports when one asks (core-worker-account-<hash>.mjs, with its own copy of the core it uses), so
  // the worker of a stored room is one file and one round trip.
  const acc = await esbuild.build({ absWorkingDir: REPO,   // (the same names and bytes from any directory: verify.mjs)
    entryPoints: [{ in: 'gen/vendor/account.mjs', out: 'core-worker-account' }], bundle: true, format: 'esm', minify: true, write: false,
    outdir: path.join(pub, 'gen', 'app'), entryNames: '[name]-[hash]', outExtension: { '.js': '.mjs' }, target: ['es2022'], logLevel: 'silent', plugins: [fromVendor], define: core.define,
  })
  const accountFile = rel(acc.outputFiles[0].path)
  out[accountFile] = acc.outputFiles[0].text
  const accountExternal = { name: 'account-external', setup(b) { b.onResolve({ filter: /^\.\/account\.mjs$/, namespace: 'vendor' }, a => (a.importer === 'core-worker.mjs' ? { path: `./${path.posix.basename(accountFile)}`, external: true } : undefined)) } }
  const w = await esbuild.build({ absWorkingDir: REPO,   // (the same names and bytes from any directory: verify.mjs)
    entryPoints: [{ in: 'gen/vendor/core-worker.mjs', out: 'core-worker' }], bundle: true, format: 'esm', minify: true, write: false, metafile: true,
    outdir: path.join(pub, 'gen', 'app'), entryNames: '[name]-[hash]', outExtension: { '.js': '.mjs' }, target: ['es2022'], logLevel: 'silent', plugins: [accountExternal, fromVendor], define: core.define,
  })
  if (w.outputFiles.length !== 1) throw new Error('build: the core worker is not one file')
  const worker = rel(w.outputFiles[0].path)
  out[worker] = w.outputFiles[0].text
  // (a worker that holds core-wasm.ts must name this build's .wasm, or it would start without its core)
  const workerLoadsCore = 'vendor:core-wasm.mjs' in w.metafile.inputs
  if (workerLoadsCore && !out[worker].includes(`/${core.wasm}`)) throw new Error('build: the core worker holds core-wasm.ts but does not name the .wasm of this build')
  // core-start (core/core-start.ts): the tiny module index.html runs before the entry, which starts that worker.
  const st = await esbuild.build({ absWorkingDir: REPO,   // (the same names and bytes from any directory: verify.mjs)
    entryPoints: [{ in: 'gen/vendor/core-start.mjs', out: 'core-start' }], bundle: true, format: 'esm', minify: true, write: false,
    outdir: path.join(pub, 'gen', 'app'), entryNames: '[name]-[hash]', outExtension: { '.js': '.mjs' }, target: ['es2022'], logLevel: 'silent', plugins: [fromVendor],
    define: { ...core.define, __TROMMI_CORE_WORKER__: JSON.stringify(`/${worker}`) },
  })
  const start = rel(st.outputFiles[0].path)
  out[start] = st.outputFiles[0].text
  // The proof worker (core/proof-worker.ts, for the "MLS proof" screen, public/proof.mjs): one file of its own with
  // core-wasm.ts and the binding's scripts in it, so the screen needs neither a room nor the core worker. The screen
  // learns its address from __TROMMI_PROOF_WORKER__ (without it, as on the dev server: /gen/vendor/proof-worker.mjs).
  const pw = await esbuild.build({ absWorkingDir: REPO,   // (the same names and bytes from any directory: verify.mjs)
    entryPoints: [{ in: 'gen/vendor/proof-worker.mjs', out: 'proof-worker' }], bundle: true, format: 'esm', minify: true, write: false,
    outdir: path.join(pub, 'gen', 'app'), entryNames: '[name]-[hash]', outExtension: { '.js': '.mjs' }, target: ['es2022'], logLevel: 'silent', plugins: [fromVendor], define: core.define,
  })
  if (pw.outputFiles.length !== 1) throw new Error('build: the proof worker is not one file')
  const proofWorker = rel(pw.outputFiles[0].path)
  out[proofWorker] = pw.outputFiles[0].text
  if (!out[proofWorker].includes(`/${core.wasm}`)) throw new Error('build: the proof worker does not name the .wasm of this build')
  const r = await esbuild.build({ absWorkingDir: REPO,   // (the same names and bytes from any directory: verify.mjs)
    entryPoints: [path.join(pub, 'app.mjs')], bundle: true, splitting: true, format: 'esm', minify: true, write: false, metafile: true,
    outdir: path.join(pub, 'gen', 'app'), entryNames: '[name]-[hash]', chunkNames: '[name]-[hash]', outExtension: { '.js': '.mjs' },
    target: ['es2022'], logLevel: 'silent', plugins: [fromVendor], define: { ...core.define, __TROMMI_CORE_WORKER__: JSON.stringify(`/${worker}`), __TROMMI_PROOF_WORKER__: JSON.stringify(`/${proofWorker}`) },
  })
  for (const f of r.outputFiles) out[rel(f.path)] = f.text
  const outputs = Object.entries(r.metafile.outputs)
  const entry = outputs.find(([, o]) => /(^|\/)app\.mjs$/.test(o.entryPoint ?? ''))?.[0]
  const coreOut = outputs.find(([, o]) => o.entryPoint === 'vendor:core.mjs')?.[0]
  const remoteOut = outputs.find(([, o]) => o.entryPoint === 'vendor:remote.mjs')?.[0]
  if (!entry || !coreOut || !remoteOut) throw new Error('build: the bundle has no app.mjs, no core or no remote.mjs')
  // What a cold start fetches: the entry, the page's side of the core worker (remote.mjs: boot opens the room through
  // it at once) and every chunk they import statically (one round trip with modulepreload). The core itself runs in
  // the worker; the page loads its chunk only when it needs it (the account screens, the demo, a page without workers).
  const first = new Set(), queue = [entry, remoteOut]
  while (queue.length) { const o = queue.shift(); if (first.has(o)) continue; first.add(o); for (const i of r.metafile.outputs[o].imports) if (i.kind === 'import-statement') queue.push(i.path) }
  return { out, entry: rel(entry), first: [...first].map(rel), worker, start, workerLoadsCore }
}

/** Everything the build makes: { 'path under public/': content (text; bytes for the .wasm and the demo's files) }. Nothing is
 *  written. bundle: false (the dev server) serves the sources as modules of their own, with versioned addresses. */
export async function generate({ pub = PUBLIC, repo = REPO, bundle: bundled = true } = {}) {
  const out = {}
  const vendor = vendorFiles(repo, { sourcemap: !bundled })
  if (bundled) out['gen/vendor/tools-reference.mjs'] = vendor['tools-reference.mjs']   // (the help page reads it)
  else for (const [f, c] of Object.entries(vendor)) out[`gen/vendor/${f}`] = c
  out['gen/build.txt'] = `source: trommi/trommi app/web\ncommit: ${commitOf(repo)}\n`
  // The Rust core's .wasm: beside the bundle under a name of its content, or (dev server) beside the sources under
  // the binding's name, core-wasm.mjs then starting with the constants the bundle gets from esbuild's define.
  const core = coreFiles(repo, bundled ? {} : { dir: 'gen/vendor', hashed: false })
  const js = bundled ? await bundle(pub, vendor, core) : null
  if (js) Object.assign(out, js.out)
  else {
    Object.assign(out, core.files)
    // (on the first line, in front of what is there: the source map's lines stay where they are)
    out['gen/vendor/core-wasm.mjs'] = `const ${Object.entries(core.define).map(([k, v]) => `${k} = ${v}`).join(', ')}; ${out['gen/vendor/core-wasm.mjs']}`
  }
  const demo = demoFiles(repo)

  let html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8')
  const links = [...html.matchAll(SHEET_LINK)]
  let css = links.map(([, href]) => { const text = fs.readFileSync(path.join(pub, href), 'utf8'); checkSheet(text, href); return `/* ${href} */\n${text}\n` }).join('')
  // The bundle's stylesheet minified (esbuild, no lowering): its comments and spaces are about half of the bytes a
  // cold start fetches before the first paint.
  if (bundled) css = (await (await import('esbuild')).transform(css, { loader: 'css', minify: true, logLevel: 'silent' })).code
  const sheet = `gen/bundle.${sha(css)}.css`
  out[sheet] = css
  let first = true
  html = html.replace(SHEET_LINK, () => (first ? ((first = false), `<link rel="stylesheet" href="/${sheet}">\n`) : ''))

  const files = [...walk(pub).filter(f => !NOT_SHELL.test(f) && !(bundled && BUNDLED.test(f))), ...Object.keys(out).filter(f => f !== 'gen/build.txt')].sort()
  const content = f => out[f] ?? fs.readFileSync(path.join(pub, f))
  // (a copy an earlier --write left in public/demo/ is not the demo: the list below takes the repository's)
  const stale = f => /^demo\/(fixture\.json$|files\/)/.test(f)
  const version = sha(Buffer.concat([...files.flatMap(f => [Buffer.from(f), Buffer.from(content(f))]), Buffer.from(html)]))
  let modules
  if (js) {
    html = html.replace(/<script type="module" src="\/app\.mjs"><\/script>/, `<script type="module" src="/${js.entry}"></script>`)
      .replace('<script type="module" async src="/gen/vendor/core-start.mjs"></script>', `<script type="module" async src="/${js.start}"></script>`)
    modules = js.first.map(f => `/${f}`)
  } else {
    const read = f => { const rel = f.replace(/^\//, ''); return rel in out ? out[rel] : fs.existsSync(path.join(pub, rel)) ? fs.readFileSync(path.join(pub, rel), 'utf8') : null }
    modules = preloads(read, ['/app.mjs', '/gen/vendor/index.mjs'])
  }
  const block = [`<!-- preload ${version} -->`, ...modules.map(f => `<link rel="modulepreload" href="${f}">`), '<!-- /preload -->'].join('\n')
  out['index.html'] = html.replace(/<!-- preload[^>]*-->[\s\S]*?<!-- \/preload -->/, block).replace('data-build="dev"', `data-build="${version}"`)
    // (?v=<build> on the addresses index.html names itself; the bundle's chunks are named by their content and imported
    // without it, so their preloads must not carry it either: the browser keys modules by the whole address)
    .replace(/(<link rel="modulepreload" href="[^"?]+\.mjs)"/g, (all, head) => (js && head !== `<link rel="modulepreload" href="/${js.entry}` ? all : `${head}?v=${version}"`))
    .replace(/(<script type="module"(?: async)? src="\/[^"?]+\.mjs)"/g, `$1?v=${version}"`)
  if (js && !out['index.html'].includes(`src="/${js.entry}?v=`)) throw new Error('index.html: the <script type="module" src="/app.mjs"> is missing')
  // (the sources as modules of their own, dev server only: with the same versioned addresses; the bundle's chunks are
  // named by their content)
  if (!js) for (const f of files) if (f.endsWith('.mjs')) out[f] = versioned(content(f), version)
  // (help.html stays as it is: its inline script is allowed by its hash in _headers; it imports /ui.mjs, which imports
  // nothing)
  if (!out['index.html'].includes(`<!-- preload ${version} -->`)) throw new Error('index.html: the <!-- preload --> block is missing')
  // Subresource integrity (the bundle): the entry, core-start and every preload carry their sha384; an import map names
  // the integrity of every module of the page, so a chunk imported later is checked too (browsers without import-map
  // integrity ignore it). The import map is an inline script: its hash goes into the CSP of the generated _headers.
  // (Workers take no integrity: the core worker and the proof worker come from this origin under the same CSP. The Rust core's scripts
  // are inside it; its .wasm is checked by core-wasm.ts, which fetches it with the SHA-256 this build gave it.)
  if (js) {
    const sri = f => `sha384-${crypto.createHash('sha384').update(out[f]).digest('base64')}`
    const pageModules = Object.keys(js.out).filter(f => f.endsWith('.mjs') && !/^gen\/app\/(?:core|proof)-worker/.test(f)).sort()
    const map = JSON.stringify({ integrity: Object.fromEntries(pageModules.map(f => [`/${f}`, sri(f)])) })
    const importmap = `<script type="importmap">${map}</script>`
    out['index.html'] = out['index.html']
      // (before core-start, the first module script: a page takes no import map after its first module script)
      .replace(`<script type="module" async src="/${js.start}`, `${importmap}\n<script type="module" async src="/${js.start}`)
      .replace(/<(link rel="modulepreload"|script type="module"(?: async)?) (href|src)="\/(gen\/app\/[^"?]+\.mjs)(\?v=\w+)?"/g, (all, tag, attr, f, q = '') => (f in out ? `<${tag} ${attr}="/${f}${q}" integrity="${sri(f)}"` : all))
    const mapHash = `'sha256-${crypto.createHash('sha256').update(map).digest('base64')}'`
    const headers = fs.readFileSync(path.join(pub, '_headers'), 'utf8')
    out['_headers'] = headers.replace(/^(\/\*\n\s+Content-Security-Policy: .*?script-src [^;]*)/m, `$1 ${mapHash}`)
    if (!out['_headers'].includes(mapHash)) throw new Error('_headers: no script-src in the CSP of /* for the import map')
  }

  const sw = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8')
  out['sw.js'] = sw.replace(/^const VERSION = .*$/m, `const VERSION = ${JSON.stringify(version)}`).replace(/^const SHELL = .*$/m, `const SHELL = ${JSON.stringify(['/', ...files.map(f => `/${f}`)])}`)
  if (!out['sw.js'].includes(version)) throw new Error('sw.js: the VERSION line is missing')
  // The build's manifest: every file this build serves with its SHA-256, and its own hash, the build hash, in
  // build.txt (README "Verifying the build": anyone can build the commit and compare).
  Object.assign(out, demo)   // (after the shell's list and the version: the demo is not in the shell, sw.js lets /demo/ through)
  const served = [...new Set([...walk(pub).filter(f => !f.startsWith('gen/') && !stale(f) && !(bundled && BUNDLED.test(f))), ...Object.keys(out)])].filter(f => f !== 'gen/build.txt' && f !== 'gen/manifest.json').sort()
  // (core: the Rust core as it names itself, versions())
  const manifest = { commit: commitOf(repo), toolchain: await checkToolchain(repo), core: coreWasm(repo).versions, files: Object.fromEntries(served.map(f => [f, crypto.createHash('sha256').update(content(f)).digest('hex')])) }
  out['gen/manifest.json'] = `${JSON.stringify(manifest, null, 1)}\n`
  out['gen/build.txt'] += `build: ${crypto.createHash('sha256').update(out['gen/manifest.json']).digest('hex')}\n`
  // (the core worker too: boot starts it at once; and the Rust core's .wasm once the worker loads it)
  const firstLoad = js ? [...js.first, js.worker, js.start, ...(js.workerLoadsCore ? [core.wasm] : [])].reduce((n, f) => n + Buffer.byteLength(out[f]), 0) : null
  return { out, version, sheets: links.length, files: files.length, firstLoad, chunks: js ? Object.keys(js.out).length : 0 }
}

async function build({ write = false } = {}) {
  const { out, version, sheets, files, firstLoad, chunks } = await generate()
  console.log(`build ${version}: ${chunks} modules in the bundle (${Math.round(firstLoad / 1024)} KB at a cold start), ${sheets} sheets in one bundle, ${files} shell files${write ? '' : ' (check only, nothing written)'}`)
  if (!write) return
  for (const made of ['gen', 'demo/files']) fs.rmSync(path.join(PUBLIC, made), { recursive: true, force: true })
  for (const [f, c] of Object.entries(out)) { fs.mkdirSync(path.dirname(path.join(PUBLIC, f)), { recursive: true }); fs.writeFileSync(path.join(PUBLIC, f), c) }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await build({ write: process.argv.includes('--write') || CI })
