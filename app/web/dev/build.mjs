// The app's build step: one stylesheet instead of the shell's ~25 <link data-sheet> lines. The per-file sheets in
// public/css stay the edited originals; the bundle is made from them, never committed.
//   node dev/build.mjs            check only: every sheet parses into the bundle (prints its name), changes nothing
//   node dev/build.mjs --write    write public/css/bundle.<hash>.css and point public/index.html and public/sw.js at it
// Cloudflare's build runs it with --write on its own checkout (WORKERS_CI=1 counts as --write); dev/serve.mjs serves
// the same result from memory (build()), so local runs and the e2e see what is deployed. Running it again on a written
// tree does nothing. Without it the source shell works as it is (each sheet its own <link>).
//
// Views switch sheets on and off (js/app/sheets.mjs; the hub's CSS table, layout.mjs CSS): a disabled sheet's rules
// are gone. In the bundle every sheet keeps its place in the order of the <link>s, and a sheet a view may switch off is
// wrapped as  @supports (--sheet: name) { @media all { … } }  : setting that @media to "not all" removes exactly its
// rules, at the same place in the cascade — the same as link.disabled. The sheets that are on in every view
// (ALWAYS) are not wrapped: fonts.css holds @font-face rules, and richhtml.js reads tokens.css's :root rules.
//
// The client core (../../core) and the connector's tool reference are copied into public/vendor/ (vendor()): the one
// original lives in the repository's core/, nothing is committed under public/vendor. sw.js gets the vendor files in
// its shell list and their hash in its version. A missing source fails the build (Cloudflare then keeps the last
// deployment) instead of shipping an app without its core.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

export const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

// ---- the core into public/vendor ----------------------------------------------------------------------------------
const NOT_VENDORED = /(^test|-test\.mjs$|^test-|^load\.mjs$|^storage-file\.mjs$|^hub\.mjs$)/   // tests, Node-only, the hub's side
/** Where each file of public/vendor comes from: { name: absolute source path }. Throws when the core is missing. */
export function vendorSources(repo = REPO) {
  const core = path.join(repo, 'core')
  if (!fs.existsSync(path.join(core, 'index.mjs'))) throw new Error(`build: the core is missing (${core}/index.mjs)`)
  const map = {}
  for (const f of fs.readdirSync(core).sort()) if (f.endsWith('.mjs') && !NOT_VENDORED.test(f)) map[f] = path.join(core, f)
  // The agent tool and event reference for the help page, and the HTML cleaner the agent's side uses (browser-safe).
  for (const f of ['channel-tools.mjs', 'richhtml.mjs']) map[f] = path.join(repo, 'connector', f)
  for (const [f, src] of Object.entries(map)) if (!fs.existsSync(src)) throw new Error(`build: ${src} is missing`)
  return map
}
const commitOf = repo => {
  const env = process.env.WORKERS_CI_COMMIT_SHA || process.env.GITHUB_SHA
  if (env) return env.slice(0, 7)
  try { return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim().slice(0, 7) } catch { return 'dev' }
}
/** The files of public/vendor: { name: content }, core-version.mjs included. */
export function vendorFiles(repo = REPO) {
  const out = {}
  for (const [f, src] of Object.entries(vendorSources(repo))) out[f] = fs.readFileSync(src, 'utf8')
  const commit = commitOf(repo)
  out['core-version.mjs'] = `// Written by app/web/dev/build.mjs from the repository's core/. Do not edit: edit core/.\nexport const CORE_COMMIT = ${JSON.stringify(commit)}\n`
  return out
}
/** sw.js with the vendor files in its shell list and their hash in its version. */
export function withVendor(sw, files) {
  const names = Object.keys(files).sort().map(f => `/vendor/${f}`)
  const hash = crypto.createHash('sha256').update(Object.keys(files).sort().map(f => f + files[f]).join('')).digest('hex').slice(0, 8)
  if (sw.includes(`-v${hash}`)) return sw
  // A second run (another core) replaces the vendor part of the version instead of adding one.
  const out = sw.replace(/^const VERSION = "([^"]*)"$/m, (_, v) => `const VERSION = ${JSON.stringify(/-v[0-9a-f]{8}/.test(v) ? v.replace(/-v[0-9a-f]{8}/, `-v${hash}`) : `${v}-v${hash}`)}`)
    .replace(/^const SHELL = (\[.*\])$/m, (_, list) => `const SHELL = ${JSON.stringify([...JSON.parse(list).filter(f => !f.startsWith('/vendor/')), ...names])}`)
  if (!out.includes(`-v${hash}`)) throw new Error('sw.js: SHELL or VERSION line not found')
  return out
}
export function vendor({ write = false, pub = PUBLIC, repo = REPO } = {}) {
  const files = vendorFiles(repo)
  console.log(`build: ${Object.keys(files).length} core files -> public/vendor/${write ? '' : ' (check only, nothing written)'}`)
  if (!write) return files
  const dir = path.join(pub, 'vendor')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c)
  return files
}
const ALWAYS = new Set(['fonts', 'tokens', 'app', 'trommi', 'room'])
const SHEET_LINK = /^<link rel="stylesheet" href="(\/[^"]+\.css)" data-sheet="([\w-]+)">\n/gm
const FONT_PRELOAD = /^<link rel="preload" href="\/fonts\/fonts\.css" as="style">\n/m

/** Throws unless the braces of a sheet balance (outside comments and strings): in the bundle a stray brace would
 *  spill into the next sheet. */
function checkBalance(css, file) {
  let depth = 0
  for (let i = 0; i < css.length; i++) {
    const c = css[i]
    if (c === '/' && css[i + 1] === '*') { const end = css.indexOf('*/', i + 2); if (end < 0) throw new Error(`${file}: comment not closed`); i = end + 1 }
    else if (c === '"' || c === "'") { let j = i + 1; while (j < css.length && css[j] !== c && css[j] !== '\n') j += css[j] === '\\' ? 2 : 1; if (css[j] !== c) throw new Error(`${file}: string not closed (offset ${i})`); i = j }
    else if (c === '{') depth++
    else if (c === '}' && --depth < 0) throw new Error(`${file}: "}" without "{" (offset ${i})`)
  }
  if (depth) throw new Error(`${file}: ${depth} "{" not closed`)
}

/** The bundle for the shell in public/: { name, css, html, sw } or null when the shell has no sheet links (written). */
export function bundle(pub = PUBLIC, swText = null) {
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8')
  const links = [...html.matchAll(SHEET_LINK)]
  if (!links.length) return null
  const parts = links.map(([, href, name]) => {
    const css = fs.readFileSync(path.join(pub, href), 'utf8')
    checkBalance(css, href)
    // The bundle lives in /css/: a relative url() of a sheet elsewhere would point somewhere else.
    if (!href.startsWith('/css/') && /url\(\s*['"]?(?![a-z]+:|\/)/i.test(css.replace(/\/\*[\s\S]*?\*\//g, ''))) throw new Error(`${href}: relative url() outside /css/`)
    if (/@import\b|@charset\b/.test(css.replace(/\/\*[\s\S]*?\*\//g, ''))) throw new Error(`${href}: @import/@charset cannot go into the bundle`)
    return ALWAYS.has(name) ? `/* ${href} */\n${css}\n` : `/* ${href} */\n@supports (--sheet: ${name}) { @media all {\n${css}\n} }\n`
  })
  const css = parts.join('')
  const hash = crypto.createHash('sha256').update(css).digest('hex').slice(0, 12)
  const name = `/css/bundle.${hash}.css`
  // One <link> where the first sheet was; the font preload went with it (the fonts' @font-face are in the bundle).
  let first = true
  const out = html.replace(FONT_PRELOAD, '').replace(SHEET_LINK, () => { if (!first) return ''; first = false; return `<link rel="stylesheet" href="${name}" data-bundle>\n` })
  // The service worker keeps the bundle with the shell; its cache name changes with the bundle.
  let sw = swText ?? fs.readFileSync(path.join(pub, 'sw.js'), 'utf8')
  sw = sw.replace(/^const VERSION = "([^"]*)"$/m, (_, v) => `const VERSION = ${JSON.stringify(`${v}-${hash}`)}`)
    .replace(/^const SHELL = (\[.*\])$/m, (_, list) => `const SHELL = ${JSON.stringify([...JSON.parse(list), name])}`)
  if (!sw.includes(name)) throw new Error('sw.js: SHELL or VERSION line not found')
  return { name, css, html: out, sw, sheets: links.length }
}

export function build({ write = false, pub = PUBLIC } = {}) {
  const files = vendor({ write, pub })
  if (write) fs.writeFileSync(path.join(pub, 'sw.js'), withVendor(fs.readFileSync(path.join(pub, 'sw.js'), 'utf8'), files))
  const b = bundle(pub)
  if (!b) { console.log('build: the shell has its bundle already'); return }
  console.log(`build: ${b.sheets} sheets -> ${b.name} (${(b.css.length / 1024).toFixed(0)} KiB)${write ? '' : ' (check only, nothing written)'}`)
  if (!write) return
  fs.writeFileSync(path.join(pub, b.name), b.css)
  fs.writeFileSync(path.join(pub, 'index.html'), b.html)
  fs.writeFileSync(path.join(pub, 'sw.js'), b.sw)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv.includes('--vendor')) vendor({ write: true })     // dev/release.sh: public/vendor for the preload list
  else build({ write: process.argv.includes('--write') || process.env.WORKERS_CI === '1' })
}
