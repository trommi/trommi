// The app's build: everything generated is made here, at deploy time, and never committed.
//   gen/app/               the app as one minified bundle (esbuild, split): app-<hash>.mjs (app, ui, desk, sidebar,
//                          notes), one chunk per lazy view, the core (from the repository's shared/) in chunks of its
//                          own, all named by their content
//   gen/vendor/            tools-reference.mjs: the connector's tools and events as data, for the help page (the dev
//                          server, bundle: false, also serves the core here, copied flat from shared/ and shared/crypto/)
//   gen/bundle.<hash>.css  the stylesheets of index.html as one file (their <link>s become one)
//   gen/build.txt          which commit this build is (the Web app deploy workflow reads it)
//   index.html             the script, the modulepreload list between <!-- preload --> and <!-- /preload -->, data-build=<version>
//   sw.js                  VERSION (a hash of every shell file) and SHELL (every file the app serves)
//   gen/connector.mjs, gen/connector.mjs.sha256, gen/plugins/
//                          the single-file connector, its checksum and the Claude Code plugin (connector/build.mjs)
// In the repository index.html and sw.js are templates (empty preload block, VERSION "dev", SHELL []), so two
// branches never conflict there, and public/gen/ is not in git at all.
//
// The bundle and the connector need the repository's npm packages (esbuild, the MCP SDK, zod). Cloudflare's build
// (WORKERS_CI=1) installs them first: npm ci at the repository root. The dev server without --bundle needs none
// (without them it goes on without the connector files); a build that writes fails without them.
//
//   node dev/build.mjs            check only: generate in memory, print what it would write and the cold start's size
//   node dev/build.mjs --write    write it into public/ (Cloudflare's build: WORKERS_CI=1 counts as --write).
//                                 Never commit what it writes into index.html and sw.js.
// dev/serve.mjs serves generate() from memory, so the dev server needs no build step and never shows stale files.
// A missing core fails the build (Cloudflare then keeps the last deployment) instead of shipping an app without it.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { toJs, renameTs } from '../../../dev/ts.mjs'

export const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const sha = data => crypto.createHash('sha256').update(data).digest('hex').slice(0, 12)

// ---- the core ----
const NOT_VENDORED = /(^test|-test\.(mjs|ts)$|^test-|^storage-file\.(mjs|ts)$|^hub\.(mjs|ts)$|\.d\.m?ts$)/   // tests, Node-only, the hub's side, declarations
function vendorFiles(repo, { sourcemap = false } = {}) {
  const core = path.join(repo, 'shared')
  if (!['index.mjs', 'index.ts'].some(f => fs.existsSync(path.join(core, f)))) throw new Error(`build: the core is missing (${core}/index.mjs)`)
  const out = {}
  // gen/vendor/ is flat: shared/crypto/ lands beside the rest, so an import of './crypto/x.mjs' becomes './x.mjs'.
  // A TypeScript module (x.ts) lands as x.mjs, its types erased (dev/ts.mjs), its imports of './y.ts' as './y.mjs'.
  for (const dir of [core, path.join(core, 'crypto')]) for (const f of fs.readdirSync(dir).sort()) {
    if (!/\.(mjs|ts)$/.test(f) || NOT_VENDORED.test(f)) continue
    const name = f.replace(/\.ts$/, '.mjs')
    if (out[name] != null) throw new Error(`build: ${name} twice (shared/ and shared/crypto/, or .mjs and .ts)`)
    let text = fs.readFileSync(path.join(dir, f), 'utf8')
    if (f.endsWith('.ts')) text = toJs(text, path.relative(repo, path.join(dir, f)), { sourcemap })
    out[name] = renameTs(text, '.mjs').replace(/(['"])\.\/crypto\//g, '$1./')
  }
  out['tools-reference.mjs'] = toolsReference(repo)
  out['core-version.mjs'] = `// Written by app/web/dev/build.mjs from the repository's shared/. Do not edit: edit shared/.\nexport const CORE_COMMIT = ${JSON.stringify(commitOf(repo))}\n`
  return out
}
function commitOf(repo) {
  const env = process.env.WORKERS_CI_COMMIT_SHA || process.env.GITHUB_SHA
  if (env) return env.slice(0, 7)
  try { return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim().slice(0, 7) } catch { return 'dev' }
}

// ---- the connector ----
// The tools and events for the help page. connector/tools.mjs is Node code (it reads prompt.md and files), so its
// tables are read in a Node process and written out as data. Made again only when the two files changed.
let reference = null
function toolsReference(repo) {
  const files = ['tools.mjs', 'prompt.md'].map(f => path.join(repo, 'connector', f))
  const key = files.map(f => fs.statSync(f).mtimeMs).join()
  if (reference?.key !== key) {
    const read = `const t = await import(${JSON.stringify(pathToFileURL(files[0]).href)}); process.stdout.write(JSON.stringify({ TOOLS: t.TOOLS, TOOL_EXAMPLES: t.TOOL_EXAMPLES, EVENTS: t.EVENTS, RETENTION_DAYS: t.RETENTION_DAYS, MAX_ASSET: t.MAX_ASSET }))`
    const json = execFileSync(process.execPath, ['--input-type=module', '-e', read], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    reference = { key, text: `// Written by app/web/dev/build.mjs from connector/tools.mjs and connector/prompt.md. Do not edit.\nexport const { TOOLS, TOOL_EXAMPLES, EVENTS, RETENTION_DAYS, MAX_ASSET } = ${json}\n` }
  }
  return reference.text
}

// The single-file connector, its checksum and the plugin: connector/build.mjs, which needs the npm packages.
const CI = process.env.WORKERS_CI === '1'
if (CI) execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: REPO, stdio: 'inherit' })
const connector = await import(pathToFileURL(path.join(REPO, 'connector/build.mjs')).href).catch(err => {
  if (err.code === 'ERR_MODULE_NOT_FOUND' && /Cannot find package/.test(err.message)) return null
  throw err
})
// Made again only when a source changed (the dev server asks on every page load; a bundle takes a moment).
let bundled = null
function connectorFiles() {
  if (!connector) return null
  const key = ['connector', 'shared', 'shared/crypto'].flatMap(d => fs.readdirSync(path.join(REPO, d)).map(f => `${f}:${fs.statSync(path.join(REPO, d, f)).mtimeMs}`)).join()
  if (bundled?.key !== key) bundled = { key, files: connector.connectorFiles() }
  return bundled.files
}

// ---- the stylesheets ----
const SHEET_LINK = /^<link rel="stylesheet" href="(\/[^"]+\.css)"[^>]*>\n/gm
const FONT_PRELOAD = /^<link rel="preload" href="\/fonts\/fonts\.css" as="style">\n/m
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
const NOT_SHELL = /^(gen\/|demo\/|sw\.js$|index\.html$|_headers$|connect\.sh$)|\.md$|(^|\/)\./
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
const BUNDLED = /^(app|auth|agents|desk|card|session|sidebar|notes|media|whiteboard)\.mjs$|^demo\/demo\.mjs$/   // in the bundle, not served alone
async function bundle(pub, vendor) {
  const esbuild = await import('esbuild').catch(() => { throw new Error('build: esbuild is missing (npm ci at the repository root)') })
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
  const rel = o => path.relative(pub, path.resolve(o)).split(path.sep).join('/')
  const out = {}
  // The core's worker (shared/core-worker.ts): one file of its own, the whole core in it. The app learns its address
  // from __TROMMI_CORE_WORKER__ (without it, as on the dev server, it starts /gen/vendor/core-worker.mjs).
  const w = await esbuild.build({
    entryPoints: [{ in: 'gen/vendor/core-worker.mjs', out: 'core-worker' }], bundle: true, format: 'esm', minify: true, write: false, metafile: true,
    outdir: path.join(pub, 'gen', 'app'), entryNames: '[name]-[hash]', outExtension: { '.js': '.mjs' }, target: ['es2022'], logLevel: 'silent', plugins: [fromVendor],
  })
  if (w.outputFiles.length !== 1) throw new Error('build: the core worker is not one file')
  const worker = rel(w.outputFiles[0].path)
  out[worker] = w.outputFiles[0].text
  const r = await esbuild.build({
    entryPoints: [path.join(pub, 'app.mjs')], bundle: true, splitting: true, format: 'esm', minify: true, write: false, metafile: true,
    outdir: path.join(pub, 'gen', 'app'), entryNames: '[name]-[hash]', chunkNames: '[name]-[hash]', outExtension: { '.js': '.mjs' },
    target: ['es2022'], logLevel: 'silent', plugins: [fromVendor], define: { __TROMMI_CORE_WORKER__: JSON.stringify(`/${worker}`) },
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
  return { out, entry: rel(entry), first: [...first].map(rel), worker }
}

/** Everything the build makes: { 'path under public/': content (text, or bytes for the plugin's zip) }. Nothing is
 *  written. bundle: false (the dev server) serves the sources as modules of their own, with versioned addresses. */
export async function generate({ pub = PUBLIC, repo = REPO, bundle: bundled = true } = {}) {
  const out = {}
  const vendor = vendorFiles(repo, { sourcemap: !bundled })
  if (bundled) out['gen/vendor/tools-reference.mjs'] = vendor['tools-reference.mjs']   // (the help page reads it)
  else for (const [f, c] of Object.entries(vendor)) out[`gen/vendor/${f}`] = c
  out['gen/build.txt'] = `source: trommi/trommi app/web\ncommit: ${commitOf(repo)}\n`
  const js = bundled ? await bundle(pub, vendor) : null
  if (js) Object.assign(out, js.out)

  let html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8')
  const links = [...html.matchAll(SHEET_LINK)]
  let css = links.map(([, href]) => { const text = fs.readFileSync(path.join(pub, href), 'utf8'); checkSheet(text, href); return `/* ${href} */\n${text}\n` }).join('')
  // The bundle's stylesheet minified (esbuild, no lowering): its comments and spaces were half of a cold start's bytes
  // before the first paint (550 -> ~280 KB, brotli 93 -> ~55 KB).
  if (bundled) css = (await (await import('esbuild')).transform(css, { loader: 'css', minify: true, logLevel: 'silent' })).code
  const sheet = `gen/bundle.${sha(css)}.css`
  out[sheet] = css
  let first = true
  html = html.replace(FONT_PRELOAD, '').replace(SHEET_LINK, () => (first ? ((first = false), `<link rel="stylesheet" href="/${sheet}">\n`) : ''))

  const files = [...walk(pub).filter(f => !NOT_SHELL.test(f) && !(bundled && BUNDLED.test(f))), ...Object.keys(out).filter(f => f !== 'gen/build.txt')].sort()
  const content = f => out[f] ?? fs.readFileSync(path.join(pub, f))
  const version = sha(Buffer.concat([...files.flatMap(f => [Buffer.from(f), Buffer.from(content(f))]), Buffer.from(html)]))
  let modules
  if (js) {
    html = html.replace(/<script type="module" src="\/app\.mjs"><\/script>/, `<script type="module" src="/${js.entry}"></script>`)
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
    .replace(/(<script type="module" src="\/[^"?]+\.mjs)"/g, `$1?v=${version}"`)
  if (js && !out['index.html'].includes(`src="/${js.entry}?v=`)) throw new Error('index.html: the <script type="module" src="/app.mjs"> is missing')
  // (the sources as modules of their own, dev server only: with the same versioned addresses; the bundle's chunks are
  // named by their content)
  if (!js) for (const f of files) if (f.endsWith('.mjs') && !f.startsWith('gen/connector') && !f.startsWith('gen/plugins/')) out[f] = versioned(content(f), version)
  // (help.html stays as it is: its inline script is allowed by its hash in _headers; it imports /ui.mjs, which imports
  // nothing)
  if (!out['index.html'].includes(`<!-- preload ${version} -->`)) throw new Error('index.html: the <!-- preload --> block is missing')

  const sw = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8')
  out['sw.js'] = sw.replace(/^const VERSION = .*$/m, `const VERSION = ${JSON.stringify(version)}`).replace(/^const SHELL = .*$/m, `const SHELL = ${JSON.stringify(['/', ...files.map(f => `/${f}`)])}`)
  if (!out['sw.js'].includes(version)) throw new Error('sw.js: the VERSION line is missing')
  // Not part of the shell: the app itself never loads them (Claude Code and the connect script do).
  const made = connectorFiles()
  for (const [f, c] of Object.entries(made ?? {})) out[`gen/${f}`] = c
  const firstLoad = js ? [...js.first, js.worker].reduce((n, f) => n + Buffer.byteLength(out[f]), 0) : null   // (the core worker too: boot starts it at once)
  return { out, version, sheets: links.length, files: files.length, connector: made ? made['connector.mjs.sha256'].slice(0, 12) : null, firstLoad, chunks: js ? Object.keys(js.out).length : 0 }
}

export async function build({ write = false } = {}) {
  const { out, version, sheets, files, connector, firstLoad, chunks } = await generate()
  console.log(`build ${version}: ${chunks} modules in the bundle (${Math.round(firstLoad / 1024)} KB at a cold start), ${sheets} sheets in one bundle, ${files} shell files, ${connector ? `connector ${connector} with its plugin` : 'no connector (its npm packages are missing: npm ci)'}${write ? '' : ' (check only, nothing written)'}`)
  if (!write) return
  if (!connector) throw new Error('build: the connector cannot be built (esbuild, @modelcontextprotocol/sdk or zod is missing: npm ci at the repository root)')
  fs.rmSync(path.join(PUBLIC, 'gen'), { recursive: true, force: true })
  for (const [f, c] of Object.entries(out)) { fs.mkdirSync(path.dirname(path.join(PUBLIC, f)), { recursive: true }); fs.writeFileSync(path.join(PUBLIC, f), c) }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await build({ write: process.argv.includes('--write') || CI })
