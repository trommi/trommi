// The app's layout rules (README "Rules"), checked by `npm test` (test:app):
//   1. a file in public/ outside the allowed set or folders fails;
//   2. a view imports only from app.mjs and ui.mjs (and the core only through app.mjs); ui.mjs imports nothing;
//   3. no crypto in the app: crypto.subtle, argon2 and zcrypto only in gen/vendor (the repository's core/crypto/, copied by the build);
//   4. the inline scripts and styles of index.html and help.html are allowed by their hash in _headers (CSP), and no
//      'unsafe-inline' for style elements (style attributes only: style-src-attr);
//   5. the demo room's data (the repository's demo/data/, demo/check.mjs): whole, every named file there, no copy of it
//      kept by a consumer (public/demo/fixture.json and public/demo/files/ are made by the build, never committed).
//   node dev/check.mjs
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readDemo } from '../../../demo/check.mjs'

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
const VIEWS = ['auth', 'desk', 'card', 'session', 'sidebar', 'notes', 'media', 'agents', 'whiteboard', 'proof']
const FILES = new Set(['index.html', 'help.html', 'frame.html', 'sw.js', 'manifest.webmanifest', '_headers', 'robots.txt', 'connect.sh', 'drawings.json', 'apple-app-site-association.json',
  ...['app', 'ui', ...VIEWS].flatMap(v => [`${v}.mjs`, `${v}.css`]).filter(f => f !== 'ui.css'), 'demo/demo.mjs', 'demo/fixture.json', 'demo/screens.css'])
const FOLDERS = ['gen/', 'fonts/', 'icons/', 'demo/files/']
const problems = []
const walk = dir => fs.readdirSync(path.join(pub, dir), { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(`${dir}${e.name}/`) : [`${dir}${e.name}`]))
const files = walk('')

// 1. the file set
for (const f of files) if (!FILES.has(f) && !FOLDERS.some(d => f.startsWith(d))) problems.push(`${f}: not a file of the app's layout (README "Layout")`)

const read = f => fs.readFileSync(path.join(pub, f), 'utf8')
const imports = src => [...src.matchAll(/(?:^\s*import\s+(?:[^'"]*?from\s+)?|import\(\s*)['"]([^'"]+)['"]/gm)].map(m => m[1])
// 2. who imports whom
for (const v of VIEWS) for (const spec of imports(read(`${v}.mjs`))) if (!['./app.mjs', './ui.mjs'].includes(spec)) problems.push(`${v}.mjs imports ${spec}: a view imports only ./app.mjs and ./ui.mjs`)
for (const spec of imports(read('ui.mjs'))) problems.push(`ui.mjs imports ${spec}: ui.mjs imports nothing`)
for (const spec of imports(read('app.mjs'))) if (!/^\.\/(\w+\.mjs|gen\/vendor\/[\w-]+\.mjs|demo\/demo\.mjs)$/.test(spec)) problems.push(`app.mjs imports ${spec}`)

// 3. no crypto outside the core
for (const f of files.filter(f => /\.(mjs|js|html)$/.test(f) && !f.startsWith('gen/'))) {
  const src = read(f)
  for (const [re, what] of [[/crypto\.subtle/, 'crypto.subtle'], [/argon2/i, 'argon2'], [/zcrypto/, 'zcrypto']]) if (re.test(src)) problems.push(`${f}: ${what} outside gen/vendor (crypto comes from the core, through app.mjs)`)
}

// 4. inline scripts and the CSP
const csp = read('_headers').match(/^\/\*\n\s+Content-Security-Policy: (.*)$/m)?.[1] ?? ''
for (const page of ['index.html', 'help.html']) {
  for (const [, body] of read(page).matchAll(/<script(?: type="module")?>([\s\S]*?)<\/script>/g)) {
    const hash = `'sha256-${crypto.createHash('sha256').update(body).digest('base64')}'`
    if (!csp.includes(hash)) problems.push(`${page}: an inline script whose hash ${hash} is not in the CSP of _headers`)
  }
}

// 4b. inline style elements: allowed by their hash in style-src (style attributes are style-src-attr's)
const styleSrc = csp.match(/style-src ([^;]*)/)?.[1] ?? ''
if (/'unsafe-inline'/.test(styleSrc)) problems.push("_headers: style-src allows 'unsafe-inline' (only style-src-attr may)")
for (const page of ['index.html', 'help.html']) {
  for (const [, body] of read(page).matchAll(/<style>([\s\S]*?)<\/style>/g)) {
    const hash = `'sha256-${crypto.createHash('sha256').update(body).digest('base64')}'`
    if (!styleSrc.includes(hash)) problems.push(`${page}: an inline style whose hash ${hash} is not in the style-src of _headers`)
  }
}

// 5. the demo data
const demo = readDemo()
problems.push(...demo.problems)

if (problems.length) { console.error(problems.join('\n')); process.exit(1) }
console.log(`app layout ok: ${files.filter(f => !f.startsWith('gen/')).length} files, ${VIEWS.length} views; demo data: ${demo.states.length} states, ${demo.files.length} files`)
