// Local static server for the app, as deployed: the SPA fallback Cloudflare gives (assets.not_found_handling), the
// headers of public/_headers, the worker's addresses (worker.js) and what dev/build.mjs generates, made in memory on
// every request (nothing to build, nothing stale). Its sw.js has VERSION "dev": the service worker caches nothing here.
//   node dev/serve.mjs [port=8900]        (--preview, for the preview behind tailscale serve, changes nothing now)
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generate } from './build.mjs'
import { assetPath } from '../worker.js'
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
const port = Number(process.argv.slice(2).find(a => /^\d+$/.test(a)) || 8900)
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain', '.sh': 'text/plain; charset=utf-8', '.sha256': 'text/plain', '.webm': 'video/webm', '.zip': 'application/zip' }
// Read on every request: a dev server left running must not serve an old CSP (it once blocked the Argon2 WASM).
const readHeaders = () => { const headers = {}
try { let cur = null; for (const line of fs.readFileSync(path.join(root, '_headers'), 'utf8').split('\n')) { if (!line.trim() || line.startsWith('#')) continue; if (!/^\s/.test(line)) { cur = line.trim(); headers[cur] = {} } else if (line.trim().startsWith('!')) headers[cur][line.trim().slice(1).trim()] = null; else { const [k, ...v] = line.trim().split(':'); headers[cur][k.trim()] = v.join(':').trim() } } } catch {}
  return headers }
// The build, made again when it is older than a moment (a page load asks for index.html, sw.js and the bundle at once).
let made = null
const built = () => { if (!made || Date.now() - made.at > 500) { const { out } = generate(); out['sw.js'] = out['sw.js'].replace(/^const VERSION = .*$/m, 'const VERSION = "dev"'); out['index.html'] = out['index.html'].replace(/data-build="\w+"/, 'data-build="dev"'); made = { at: Date.now(), out } } return made.out }
// A request never takes the server down: a file the build reads may be missing for a moment (a rebase under it).
// The answer is 500 with the message; the same message is logged once.
let lastError = ''
http.createServer((req, res) => {
  try { serve(req, res) } catch (err) {
    const what = String(err?.message ?? err)
    if (what !== lastError) { lastError = what; console.error(`serve: ${what}`) }
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(`dev server: ${what}\n`)
  }
}).listen(port, '127.0.0.1', () => console.log(`app on http://127.0.0.1:${port}`))
function serve(req, res) {
  const url = new URL(req.url, 'http://x')
  // The connect script (curl -fsSL <app>/connect | sh -s '<link>'), as worker.js serves it.
  if (url.pathname === '/connect' || url.pathname === '/connect/') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' }); return res.end(fs.readFileSync(path.join(root, 'connect.sh'))) }
  url.pathname = assetPath(url.pathname)
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  if (rel.split('/').includes('..')) { res.writeHead(403); return res.end() }
  const isFile = f => fs.existsSync(path.join(root, f)) && fs.statSync(path.join(root, f)).isFile()
  if (rel === '' || rel.endsWith('/')) rel += 'index.html'
  // Like Cloudflare's html_handling: /a/frame serves /a/frame.html.
  if (!isFile(rel) && isFile(`${rel}.html`)) rel += '.html'
  const gen = rel === 'index.html' || rel === 'sw.js' || rel.startsWith('gen/') ? built() : {}
  if (!(rel in gen) && !isFile(rel)) {
    // Like Cloudflare's single-page-application handling: navigations get the app, anything else a 404.
    if (req.headers['sec-fetch-mode'] !== 'navigate' && /\.\w+$/.test(rel)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found') }
    rel = 'index.html'
  }
  const h = { 'Content-Type': TYPES[path.extname(rel)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' }
  for (const [pat, hs] of Object.entries(readHeaders())) { const re = new RegExp(`^${pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`); if (re.test(`/${rel}`) || re.test(url.pathname)) for (const [k, v] of Object.entries(hs)) { if (v === null) delete h[k]; else h[k] = v } }
  // Local hubs for development (the deployed CSP names only https://hub.trommi.com).
  if (h['Content-Security-Policy'] && !h['Content-Security-Policy'].includes('sandbox')) h['Content-Security-Policy'] = h['Content-Security-Policy'].replace('connect-src ', 'connect-src http://127.0.0.1:* http://localhost:* ')
  h['Cache-Control'] = 'no-cache'
  res.writeHead(200, h)
  const out = rel === 'index.html' ? built()[rel] : gen[rel]
  if (out != null) return res.end(out)
  fs.createReadStream(path.join(root, rel)).on('error', () => res.destroy()).pipe(res)
}
