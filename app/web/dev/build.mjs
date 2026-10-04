// The app's build: everything generated is made here, at deploy time, and never committed.
//   gen/vendor/            the client core, copied from the repository's core/ (plus two browser-safe connector files)
//   gen/bundle.<hash>.css  the stylesheets of index.html as one file (their <link>s become one)
//   gen/build.txt          which commit this build is (the Web app deploy workflow reads it)
//   index.html             the modulepreload list between <!-- preload --> and <!-- /preload -->, data-build=<version>
//   sw.js                  VERSION (a hash of every shell file) and SHELL (every file the app serves)
// In the repository index.html and sw.js are templates (empty preload block, VERSION "dev", SHELL []), so two
// branches never conflict there. (gen/connector.mjs and gen/plugins/ are connector/bundle.mjs's: they need the
// repository's npm packages, which this dependency-free build does not have; they stay committed and CI checks them.)
//
//   node dev/build.mjs            check only: generate in memory, print what it would write
//   node dev/build.mjs --write    write it into public/ (Cloudflare's build: WORKERS_CI=1 counts as --write).
//                                 Never commit what it writes into index.html and sw.js.
// dev/serve.mjs serves generate() from memory, so the dev server needs no build step and never shows stale files.
// A missing core fails the build (Cloudflare then keeps the last deployment) instead of shipping an app without it.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

export const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const sha = data => crypto.createHash('sha256').update(data).digest('hex').slice(0, 12)

// ---- the core ----
const NOT_VENDORED = /(^test|-test\.mjs$|^test-|^load\.mjs$|^storage-file\.mjs$|^hub\.mjs$)/   // tests, Node-only, the hub's side
function vendorFiles(repo) {
  const core = path.join(repo, 'core')
  if (!fs.existsSync(path.join(core, 'index.mjs'))) throw new Error(`build: the core is missing (${core}/index.mjs)`)
  const out = {}
  for (const f of fs.readdirSync(core).sort()) if (f.endsWith('.mjs') && !NOT_VENDORED.test(f)) out[f] = fs.readFileSync(path.join(core, f), 'utf8')
  // The agent tool and event reference for the help page, and the HTML cleaner the agent's side uses (browser-safe).
  for (const f of ['channel-tools.mjs', 'richhtml.mjs']) out[f] = fs.readFileSync(path.join(repo, 'connector', f), 'utf8')
  out['core-version.mjs'] = `// Written by app/web/dev/build.mjs from the repository's core/. Do not edit: edit core/.\nexport const CORE_COMMIT = ${JSON.stringify(commitOf(repo))}\n`
  return out
}
function commitOf(repo) {
  const env = process.env.WORKERS_CI_COMMIT_SHA || process.env.GITHUB_SHA
  if (env) return env.slice(0, 7)
  try { return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim().slice(0, 7) } catch { return 'dev' }
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
const NOT_SHELL = /^(gen\/|mock\/|sw\.js$|index\.html$|_headers$|connect\.sh$)|\.md$|(^|\/)\./
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

/** Everything the build makes: { 'path under public/': content }. Nothing is written. */
export function generate({ pub = PUBLIC, repo = REPO } = {}) {
  const out = {}
  for (const [f, c] of Object.entries(vendorFiles(repo))) out[`gen/vendor/${f}`] = c
  out['gen/build.txt'] = `source: trommi/trommi app/web\ncommit: ${commitOf(repo)}\n`

  let html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8')
  const links = [...html.matchAll(SHEET_LINK)]
  const css = links.map(([, href]) => { const text = fs.readFileSync(path.join(pub, href), 'utf8'); checkSheet(text, href); return `/* ${href} */\n${text}\n` }).join('')
  const bundle = `gen/bundle.${sha(css)}.css`
  out[bundle] = css
  let first = true
  html = html.replace(FONT_PRELOAD, '').replace(SHEET_LINK, () => (first ? ((first = false), `<link rel="stylesheet" href="/${bundle}">\n`) : ''))

  const files = [...walk(pub).filter(f => !NOT_SHELL.test(f)), ...Object.keys(out).filter(f => f !== 'gen/build.txt')].sort()
  const content = f => out[f] ?? fs.readFileSync(path.join(pub, f))
  const version = sha(Buffer.concat([...files.flatMap(f => [Buffer.from(f), Buffer.from(content(f))]), Buffer.from(html)]))
  const read = f => { const rel = f.replace(/^\//, ''); return rel in out ? out[rel] : fs.existsSync(path.join(pub, rel)) ? fs.readFileSync(path.join(pub, rel), 'utf8') : null }
  const block = [`<!-- preload ${version} -->`, ...preloads(read, ['/js/app/boot.mjs', '/gen/vendor/index.mjs']).map(f => `<link rel="modulepreload" href="${f}">`), '<!-- /preload -->'].join('\n')
  out['index.html'] = html.replace(/<!-- preload[^>]*-->[\s\S]*?<!-- \/preload -->/, block).replace('data-build="dev"', `data-build="${version}"`)
  if (!out['index.html'].includes(block)) throw new Error('index.html: the <!-- preload --> block is missing')

  const sw = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8')
  out['sw.js'] = sw.replace(/^const VERSION = .*$/m, `const VERSION = ${JSON.stringify(version)}`).replace(/^const SHELL = .*$/m, `const SHELL = ${JSON.stringify(['/', ...files.map(f => `/${f}`)])}`)
  if (!out['sw.js'].includes(version)) throw new Error('sw.js: the VERSION line is missing')
  return { out, version, sheets: links.length, files: files.length }
}

export function build({ write = false } = {}) {
  const { out, version, sheets, files } = generate()
  console.log(`build ${version}: ${Object.keys(out).filter(f => f.startsWith('gen/vendor/')).length} core files, ${sheets} sheets in one bundle, ${files} shell files${write ? '' : ' (check only, nothing written)'}`)
  if (!write) return
  fs.rmSync(path.join(PUBLIC, 'gen', 'vendor'), { recursive: true, force: true })
  for (const f of fs.readdirSync(path.join(PUBLIC, 'gen'))) if (/^bundle\..*\.css$/.test(f)) fs.rmSync(path.join(PUBLIC, 'gen', f))
  for (const [f, c] of Object.entries(out)) { fs.mkdirSync(path.dirname(path.join(PUBLIC, f)), { recursive: true }); fs.writeFileSync(path.join(PUBLIC, f), c) }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) build({ write: process.argv.includes('--write') || process.env.WORKERS_CI === '1' })
