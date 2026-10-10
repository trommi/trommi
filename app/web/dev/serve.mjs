// Local static server for the app, as deployed: the SPA fallback Cloudflare gives (assets.not_found_handling), the
// headers of public/_headers, the worker's addresses (worker.js) and what dev/build.mjs generates, made in memory on
// every request (nothing to build, nothing stale). Its sw.js has VERSION "dev": the service worker caches nothing here.
//   node dev/serve.mjs [port=8900] [--bundle] [--prod]   (--bundle: the deployed bundle instead of the sources;
//   --prod: as app.trommi.com serves it: the bundle, its real service worker version (cache-first shell) and brotli,
//   for measuring)
import http from 'node:http'
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generate } from './build.mjs'
import { SITE_ASSOCIATION, isFilePath, FAVICON } from '../worker.js'
import { movedPath } from '../public/paths.mjs'
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
const port = Number(process.argv.slice(2).find(a => /^\d+$/.test(a)) || 8900)
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain', '.sh': 'text/plain; charset=utf-8', '.webm': 'video/webm', '.wasm': 'application/wasm' }
// Read on every request: a dev server left running must not serve an old CSP.
// (the build's _headers when it made one: the bundle's CSP names its import map)
const readHeaders = () => { const headers = {}
try { let cur = null; for (const line of (made?.out?.['_headers'] ?? fs.readFileSync(path.join(root, '_headers'), 'utf8')).split('\n')) { if (!line.trim() || line.startsWith('#')) continue; if (!/^\s/.test(line)) { cur = line.trim(); headers[cur] = {} } else if (line.trim().startsWith('!')) headers[cur][line.trim().slice(1).trim()] = null; else { const [k, ...v] = line.trim().split(':'); headers[cur][k.trim()] = v.join(':').trim() } } } catch {}
  return headers }
// The build, made again when it is older than a moment (a page load asks for index.html, sw.js and the bundle at once).
// By default the sources are served as they are (one module per file, unminified); --bundle serves the deployed
// bundle (minified, split by view), as app.trommi.com does.
const PROD = process.argv.includes('--prod')
const BUNDLE = PROD || process.argv.includes('--bundle')
let made = null, making = null
const built = async () => {
  if (made && Date.now() - made.at <= 500) return made.out
  if (PROD && made) return made.out      // one build: its version is the service worker's cache name
  making ??= generate({ bundle: BUNDLE }).then(({ out }) => {
    if (!PROD) { out['sw.js'] = out['sw.js'].replace(/^const VERSION = .*$/m, 'const VERSION = "dev"'); out['index.html'] = out['index.html'].replace(/data-build="\w+"/, 'data-build="dev"') }
    made = { at: Date.now(), out }
    return out
  }).finally(() => { making = null })
  return making
}
// A request never takes the server down: a file the build reads may be missing for a moment (a rebase under it).
// The answer is 500 with the message; the same message is logged once.
const compressed = new Map()   // --prod: brotli once per file and build
let lastError = ''
http.createServer((req, res) => {
  serve(req, res).catch(err => {
    const what = String(err?.message ?? err)
    if (what !== lastError) { lastError = what; console.error(`serve: ${what}`) }
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(`dev server: ${what}\n`)
  })
}).listen(port, '127.0.0.1', () => console.log(`app on http://127.0.0.1:${port}`))
async function serve(req, res) {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === SITE_ASSOCIATION.address) { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }); return res.end(fs.readFileSync(path.join(root, SITE_ASSOCIATION.file))) }
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  if (rel.split('/').includes('..')) { res.writeHead(403); return res.end() }
  const isFile = f => fs.existsSync(path.join(root, f)) && fs.statSync(path.join(root, f)).isFile()
  if (rel === '' || rel.endsWith('/')) rel += 'index.html'
  // Like Cloudflare's html_handling: /frame serves /frame.html.
  if (!isFile(rel) && isFile(`${rel}.html`)) rel += '.html'
  // (the modules too: the build gives their module addresses the build's version, ?v=…)
  const gen = rel === 'index.html' || rel === 'sw.js' || rel.endsWith('.mjs') || rel.startsWith('gen/') || rel.startsWith('demo/') ? await built() : {}
  if (!(rel in gen) && !isFile(rel)) {
    // As worker.js: the icon for /favicon.ico; a file that does not exist is a 404, every other address is the app.
    if (url.pathname === '/favicon.ico') { res.writeHead(301, { Location: FAVICON }); return res.end() }
    const moved = movedPath(url.pathname)
    if (moved) { res.writeHead(301, { Location: `${moved}${url.search}` }); return res.end() }
    if (isFilePath(url.pathname) || (req.headers['sec-fetch-mode'] !== 'navigate' && /\.\w+$/.test(rel))) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': 'noindex' }); return res.end('not found\n') }
    rel = 'index.html'
  }
  const h = { 'Content-Type': TYPES[path.extname(rel)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' }
  for (const [pat, hs] of Object.entries(readHeaders())) { const re = new RegExp(`^${pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`); if (re.test(`/${rel}`) || re.test(url.pathname)) for (const [k, v] of Object.entries(hs)) { if (v === null) delete h[k]; else h[k] = v } }
  // Local hubs for development (the deployed CSP names only https://hub.trommi.com).
  if (h['Content-Security-Policy'] && !h['Content-Security-Policy'].includes('sandbox')) h['Content-Security-Policy'] = h['Content-Security-Policy'].replace('connect-src ', 'connect-src http://127.0.0.1:* http://localhost:* ')
  h['Cache-Control'] = 'no-cache'
  const out = rel === 'index.html' ? (await built())[rel] : gen[rel]
  if (PROD && /\bbr\b/.test(req.headers['accept-encoding'] ?? '') && /^(text|application\/(json|manifest|wasm))/.test(h['Content-Type'])) {
    const body = out ?? fs.readFileSync(path.join(root, rel))
    let z = compressed.get(rel)
    if (!z || z.src !== body) { z = { src: body, br: zlib.brotliCompressSync(body) }; compressed.set(rel, z) }
    res.writeHead(200, { ...h, 'Content-Encoding': 'br', Vary: 'Accept-Encoding' })
    return res.end(z.br)
  }
  res.writeHead(200, h)
  if (out != null) return res.end(out)
  fs.createReadStream(path.join(root, rel)).on('error', () => res.destroy()).pipe(res)
}
